/**
 * ── 角色本体：「墨点」 ──
 *
 * 造型：一块深色圆角方块 + 两颗大白眼睛 + 一件极淡的高光/rim + 会说人话的眉毛。
 * 这是"黑体 + 大眼睛"这一路造型的通用语言（透明、可缩放、任意底色上都读得清），
 * 几何是本项目自己画的（见 lib/pet/geometry.ts），没有引用任何第三方素材。
 *
 * ── 动画分三层，互不打架 ──
 *
 * | 层 | 谁在动 | 实现 | 帧代价 |
 * | --- | --- | --- | --- |
 * | 生命层 | 呼吸、摇摆、跳一下、眨眼、视线游移 | 纯 CSS keyframes | 合成器，主线程 0 帧 |
 * | 反应层 | 压扁/拉伸、倾斜、眼皮、瞳孔、眉毛、点击回弹 | 弹簧 + 单 rAF | 被打断才跑，判稳即停 |
 * | 表情层 | 换心情时的一次性姿态 | 反应层目标值的重设 | 每次换心情一次 |
 *
 * 关键的实现细节：
 *  · **眼皮用"盖子 + 裁切"而不是缩放整个眼睛**。缩放会把瞳孔一起压扁，
 *    看起来像瘪了的气球；盖子才是眼皮压下来的样子（半闭眼全靠这一条）。
 *  · **瞳孔的位移与"游移"分开**：外层 JS 管跟随指针，内层 CSS 管自己看东看西。
 *    两者叠在同一节点上会互相覆盖（CSS transform 会盖掉 inline transform）。
 *  · **视线游移/摇摆放在 CSS**，所以安静待机时一帧 JS 都不跑，但看上去仍在动。
 */
import { useEffect, useRef } from 'react';
import { Spring, createTicker, prefersReducedMotion, stepAll } from '@/lib/pet/motion';
import { expressionOf, type PetFx, type PetState } from '@/lib/pet/mood';
import { cn } from '@/lib/utils';
import {
  PET_BLUSH,
  PET_BODY_PATH,
  PET_BROWS,
  PET_EYES,
  PET_FX,
  PET_LASH,
  PET_MOUTHS,
  PET_PIVOT_BOTTOM,
  PET_SHADOW,
  PET_SHEEN,
  PET_VIEWBOX,
  closedEyeArc,
} from '@/lib/pet/geometry';

/** 每个实例一个 id 前缀：同一页上放两只（设置页预览 + 页面常驻）时 clipPath 不能撞 */
let uidSeed = 0;

const EYE_L = PET_EYES.left;
const EYE_R = PET_EYES.right;

/** 嘴形里这两个是实心的 */
const FILLED_MOUTHS = new Set(['grin', 'oh']);

function Fx({ fx }: { fx: PetFx }) {
  if (fx === 'none') return null;
  switch (fx) {
    case 'sparkle':
      return (
        <g className="pet-fx-layer">
          {PET_FX.sparkles.map(({ x, y }, i) => (
            <path
              key={`${x}-${y}`}
              className="pet-fx sparkle"
              style={{ animationDelay: `${i * 220}ms` }}
              d={`M ${x} ${y - 4} Q ${x} ${y} ${x + 4} ${y} Q ${x} ${y} ${x} ${y + 4} Q ${x} ${y} ${x - 4} ${y} Q ${x} ${y} ${x} ${y - 4} Z`}
            />
          ))}
        </g>
      );
    case 'sweat':
      return <path className="pet-fx sweat" d={PET_FX.sweat} />;
    case 'zzz':
      return (
        <g className="pet-fx-layer">
          {PET_FX.zzz.map(({ x, y, s }, i) => (
            <path
              key={`${x}-${y}`}
              className="pet-fx zz"
              style={{ animationDelay: `${i * 420}ms` }}
              d={`M ${x} ${y} H ${x + s} L ${x} ${y + s} H ${x + s}`}
            />
          ))}
        </g>
      );
    case 'question':
      return (
        <g className="pet-fx question">
          <path d={PET_FX.question.path} />
          <circle cx={PET_FX.question.dot.cx} cy={PET_FX.question.dot.cy} r={PET_FX.question.dot.r} />
        </g>
      );
    case 'ring':
      return <circle className="pet-fx ring" cx={PET_FX.ring.cx} cy={PET_FX.ring.cy} r={PET_FX.ring.r} />;
    case 'bang':
      return (
        <g className="pet-fx bang">
          <rect
            x={PET_FX.bang.rect.x}
            y={PET_FX.bang.rect.y}
            width={PET_FX.bang.rect.w}
            height={PET_FX.bang.rect.h}
            rx={PET_FX.bang.rect.rx}
          />
          <circle cx={PET_FX.bang.dot.cx} cy={PET_FX.bang.dot.cy} r={PET_FX.bang.dot.r} />
        </g>
      );
    case 'dots':
      return (
        <g className="pet-fx-layer">
          {PET_FX.dots.map(({ x, y }, i) => (
            <circle key={x} className="pet-fx dot" cx={x} cy={y} r={2.4} style={{ animationDelay: `${i * 220}ms` }} />
          ))}
        </g>
      );
    default:
      return null;
  }
}

export interface PetAvatarProps {
  state: PetState;
  size: number;
  follow: boolean;
  /** 纯装饰（外层已有可访问名称与交互）：此时 SVG 不再自称 img */
  decorative?: boolean;
  className?: string;
}

export function PetAvatar({ state, size, follow, decorative, className }: PetAvatarProps) {
  const expr = expressionOf(state);
  const uid = useRef(`p${++uidSeed}`).current;

  const rootRef = useRef<SVGGElement>(null);
  const bodyRef = useRef<SVGGElement>(null);
  const shadowRef = useRef<SVGEllipseElement>(null);
  const pupilRefs = useRef<Array<SVGGElement | null>>([]);
  const lidRefs = useRef<Array<SVGRectElement | null>>([]);
  const arcRefs = useRef<Array<SVGPathElement | null>>([]);
  const browRefs = useRef<Array<SVGPathElement | null>>([]);
  const blushRefs = useRef<Array<SVGEllipseElement | null>>([]);
  const boxRef = useRef<{ left: number; top: number; w: number; h: number } | null>(null);

  const springs = useRef({
    squash: new Spring(1, { stiffness: 240, dampingRatio: 0.5 }, 0.002),
    stretch: new Spring(1, { stiffness: 240, dampingRatio: 0.5 }, 0.002),
    tilt: new Spring(0, { stiffness: 170, dampingRatio: 0.45 }, 0.06),
    lid: new Spring(1, { stiffness: 280, dampingRatio: 0.9 }, 0.004),
    eyeW: new Spring(1, { stiffness: 230, dampingRatio: 0.85 }, 0.004),
    gazeX: new Spring(0, { stiffness: 80, dampingRatio: 1 }, 0.02),
    gazeY: new Spring(0, { stiffness: 80, dampingRatio: 1 }, 0.02),
    browT: new Spring(0, { stiffness: 260, dampingRatio: 0.6 }, 0.08),
    browY: new Spring(0, { stiffness: 220, dampingRatio: 0.7 }, 0.02),
    blush: new Spring(0, { stiffness: 60, dampingRatio: 1 }, 0.01),
    pop: new Spring(1, { stiffness: 420, dampingRatio: 0.34 }, 0.002),
  }).current;

  const draw = useRef(() => {
    const s = springs;
    const lid = Math.max(0, Math.min(1, s.lid.value));
    rootRef.current?.setAttribute(
      'transform',
      `translate(50 51) rotate(${s.tilt.value.toFixed(3)}) scale(${s.pop.value.toFixed(4)}) translate(-50 -51)`,
    );
    bodyRef.current?.setAttribute(
      'transform',
      `translate(50 ${PET_PIVOT_BOTTOM}) scale(${s.stretch.value.toFixed(4)} ${s.squash.value.toFixed(
        4,
      )}) translate(-50 -${PET_PIVOT_BOTTOM})`,
    );
    // 地面阴影跟着压扁一起变扁（不然会像"脚离地了"）
    if (shadowRef.current) {
      shadowRef.current.setAttribute(
        'transform',
        `translate(50 ${PET_SHADOW.cy}) scale(${(1 / s.squash.value).toFixed(3)} ${s.squash.value.toFixed(3)}) translate(-50 -${PET_SHADOW.cy})`,
      );
    }
    const gx = s.gazeX.value.toFixed(3);
    const gy = s.gazeY.value.toFixed(3);
    for (const p of pupilRefs.current) p?.setAttribute('transform', `translate(${gx} ${gy})`);
    // 眼皮：盖子从上方压下来（半闭眼 = 盖子变高）
    const cover = 2 * PET_EYES.ry * (1 - lid);
    for (const el of lidRefs.current) {
      el?.setAttribute('height', Math.max(0, cover).toFixed(2));
    }
    // 完全合上时用闭眼弧线替掉眼球（弧线在盖子之上，所以盖子到 0 才显形）
    const arcOpacity = Math.max(0, Math.min(1, (0.22 - lid) / 0.22)).toFixed(3);
    for (const el of arcRefs.current) el?.setAttribute('opacity', arcOpacity);
    const browTilt = s.browT.value;
    const browRaise = s.browY.value;
    // 绕**内端**旋转：正值 = 眉头下压（生气/专注），负值 = 眉头抬起（担心/好奇）
    browRefs.current[0]?.setAttribute(
      'transform',
      `translate(0 ${(-browRaise).toFixed(2)}) rotate(${(-browTilt).toFixed(2)} ${PET_BROWS.left.x + PET_BROWS.halfWidth} ${PET_BROWS.left.y})`,
    );
    browRefs.current[1]?.setAttribute(
      'transform',
      `translate(0 ${(-browRaise).toFixed(2)}) rotate(${browTilt.toFixed(2)} ${PET_BROWS.right.x - PET_BROWS.halfWidth} ${PET_BROWS.right.y})`,
    );
    const blush = s.blush.value.toFixed(3);
    for (const el of blushRefs.current) el?.setAttribute('opacity', blush);
  }).current;

  const ticker = useRef(
    createTicker((dt) => {
      const moving = stepAll(Object.values(springs), dt);
      draw();
      return moving;
    }),
  ).current;

  // ── 心情 → 目标姿态（每次换心情重设一次，然后弹簧自己走过去） ──
  useEffect(() => {
    const s = springs;
    s.squash.to(expr.squash);
    s.stretch.to(expr.stretch);
    s.tilt.to(expr.tilt);
    s.lid.to(Math.min(1.02, expr.lidOpen));
    s.eyeW.to(expr.eyeWidth);
    s.browT.to(expr.browTilt);
    s.browY.to(expr.browRaise);
    s.blush.to(expr.blush);
    if (prefersReducedMotion()) {
      for (const spring of Object.values(s)) spring.snap(spring.target);
      draw();
      return;
    }
    ticker.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expr.squash, expr.stretch, expr.tilt, expr.lidOpen, expr.eyeWidth, expr.browTilt, expr.browRaise, expr.blush, draw, ticker]);

  // ── 基准视线（心情自带的朝向）+ 指针跟随 ──
  useEffect(() => {
    const base = { x: expr.gazeX, y: expr.gazeY };
    springs.gazeX.to(base.x);
    springs.gazeY.to(base.y);
    if (prefersReducedMotion()) {
      springs.gazeX.snap(base.x);
      springs.gazeY.snap(base.y);
      draw();
    } else {
      ticker.start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expr.gazeX, expr.gazeY, draw, ticker]);

  useEffect(() => {
    if (!follow) return;
    const el = rootRef.current;
    if (!el) return;
    const reduce = prefersReducedMotion();
    let pending: { x: number; y: number } | null = null;
    let frame = 0;
    let lastMeasure = 0;

    const measure = () => {
      const host = el.ownerSVGElement ?? el;
      const r = host.getBoundingClientRect();
      boxRef.current = { left: r.left, top: r.top, w: r.width, h: r.height };
    };
    const applyGaze = (dx: number, dy: number) => {
      springs.gazeX.to(expr.gazeX + dx);
      springs.gazeY.to(expr.gazeY + dy);
      if (reduce) {
        springs.gazeX.snap(springs.gazeX.target);
        springs.gazeY.snap(springs.gazeY.target);
        draw();
      } else {
        ticker.start();
      }
    };
    const onMove = (e: PointerEvent) => {
      const now = performance.now();
      pending = { x: e.clientX, y: e.clientY };
      if (!boxRef.current || now - lastMeasure > 1000) {
        measure();
        lastMeasure = now;
      }
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const box = boxRef.current;
        const p = pending;
        if (!box || !p || box.w === 0) return;
        const nx = Math.max(-1, Math.min(1, ((p.x - box.left) / box.w) * 2 - 1));
        const ny = Math.max(-1, Math.min(1, ((p.y - box.top) / box.h) * 2 - 1));
        applyGaze(nx * 3.4, ny * 2.6);
      });
    };
    const onLeave = () => {
      pending = null;
      applyGaze(0, 0);
    };
    const invalidate = () => {
      boxRef.current = null;
    };
    measure();
    window.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerleave', onLeave);
    window.addEventListener('resize', invalidate, { passive: true });
    window.addEventListener('scroll', invalidate, { passive: true, capture: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('resize', invalidate);
      window.removeEventListener('scroll', invalidate, { capture: true });
      if (frame) cancelAnimationFrame(frame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow, expr.gazeX, expr.gazeY, draw, ticker]);

  // ── 卸载：停表（这一层最容易出 rAF 泄漏） ──
  useEffect(
    () => () => {
      ticker.stop();
      for (const s of Object.values(springs)) s.velocity = 0;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ticker],
  );

  /** 按下反馈：只给弹簧冲量（语义交给外层按钮） */
  const bounce = () => {
    springs.pop.velocity += 2.4;
    springs.squash.velocity -= 1.2;
    if (prefersReducedMotion()) {
      springs.pop.snap(1);
      draw();
    } else {
      ticker.start();
    }
  };

  const gradientId = `petBody-${uid}`;
  const clipL = `petEyeL-${uid}`;
  const clipR = `petEyeR-${uid}`;
  const bodyGradient = `url(#${gradientId})`;
  const mouthFilled = FILLED_MOUTHS.has(expr.mouth);

  return (
    <svg
      className={cn('pet-svg', className)}
      viewBox={`0 0 ${PET_VIEWBOX} ${PET_VIEWBOX}`}
      width={size}
      height={size}
      role={decorative ? 'presentation' : 'img'}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : `书签精灵：${expr.aria}`}
      data-pet-state={state}
      data-testid="pet-avatar"
      onPointerDown={bounce}
    >
      <defs>
        <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1="30" y1="8" x2="62" y2="88">
          <stop offset="0" className="pet-body-top" />
          <stop offset="1" className="pet-body-bottom" />
        </linearGradient>
        <clipPath id={clipL}>
          <ellipse cx={EYE_L.x} cy={EYE_L.y} rx={PET_EYES.rx} ry={PET_EYES.ry} />
        </clipPath>
        <clipPath id={clipR}>
          <ellipse cx={EYE_R.x} cy={EYE_R.y} rx={PET_EYES.rx} ry={PET_EYES.ry} />
        </clipPath>
      </defs>

      <ellipse ref={shadowRef} className="pet-shadow" cx={PET_SHADOW.cx} cy={PET_SHADOW.cy} rx={PET_SHADOW.rx} ry={PET_SHADOW.ry} />

      <g ref={rootRef}>
        {/* 生命层：呼吸 / 摇摆 / 跳 —— 只走 CSS（合成器），JS 不碰这一层 */}
        <g className={`pet-breath pet-breath-${expr.breath} pet-life pet-life-${state}`}>
          <g ref={bodyRef}>
            <path className="pet-body" d={PET_BODY_PATH} fill={bodyGradient} />
            <path className="pet-rim" d={PET_BODY_PATH} />
            {/* 左上掠射高光：不是一块贴上去的白斑，而是随身体一起压扁的椭圆 */}
            <ellipse
              className="pet-sheen"
              cx={PET_SHEEN.cx}
              cy={PET_SHEEN.cy}
              rx={PET_SHEEN.rx}
              ry={PET_SHEEN.ry}
              transform={`rotate(${PET_SHEEN.rotate} ${PET_SHEEN.cx} ${PET_SHEEN.cy})`}
            />

            {/* 眼 + 眼皮 + 瞳孔 */}
            {[
              { key: 'L', c: EYE_L, clip: clipL, ref: 0 },
              { key: 'R', c: EYE_R, clip: clipR, ref: 1 },
            ].map(({ key, c, clip, ref }) => (
              <g key={key}>
                <g
                  clipPath={`url(#${clip})`}
                  // 眼睛横向张度（眯/瞪）在外层，瞳孔位移在内层，眨眼在 CSS 里 —— 三层各管一段
                  transform={`translate(${c.x} ${c.y}) scale(${expr.eyeWidth.toFixed(3)} 1) translate(${-c.x} ${-c.y})`}
                >
                  {/*
                   * 眨眼：CSS 把 **白眼 + 瞳孔** 一起竖向压扁（0.06）。
                   * 只压瞳孔不压白眼会变成"瞳孔消失了、眼白还在"的惊悚画面。
                   */}
                  <g className={expr.blink ? 'pet-blink-on' : undefined} style={{ ['--pet-blink' as string]: expr.blinkPeriod }}>
                    <ellipse className="pet-eye" cx={c.x} cy={c.y} rx={PET_EYES.rx} ry={PET_EYES.ry} />
                    {/* 睫毛阴影：极淡的一条暗带，白眼球才有"球面"感 */}
                    <rect
                      className="pet-lash"
                      x={c.x - PET_EYES.rx}
                      y={c.y - PET_EYES.ry}
                      width={PET_EYES.rx * 2}
                      height={PET_LASH.height}
                      opacity={PET_LASH.opacity}
                    />
                    <g
                      ref={(el) => {
                        pupilRefs.current[ref] = el;
                      }}
                    >
                      {/* 视线游移（CSS）叠在 JS 的跟随位移之上 */}
                      <g className={`pet-gaze pet-gaze-${state}`}>
                        <circle
                          className="pet-pupil"
                          cx={c.x}
                          cy={c.y}
                          r={PET_EYES.pupil * expr.pupil}
                        />
                        <circle
                          className="pet-catch"
                          cx={c.x + PET_EYES.catchOffset.x}
                          cy={c.y + PET_EYES.catchOffset.y}
                          r={PET_EYES.catch}
                        />
                      </g>
                    </g>
                  </g>
                  {/* 眼皮盖子：高度由 JS 弹簧控制（0 = 全开，2*ry = 完全合上） */}
                  <rect
                    ref={(el) => {
                      lidRefs.current[ref] = el;
                    }}
                    className="pet-lid"
                    x={c.x - PET_EYES.rx}
                    y={c.y - PET_EYES.ry}
                    width={PET_EYES.rx * 2}
                    height={0}
                    fill={bodyGradient}
                  />
                </g>
                {/* 闭眼弧：合上之后才显形，颜色跟嘴/眉一致 */}
                <path
                  ref={(el) => {
                    arcRefs.current[ref] = el;
                  }}
                  className="pet-closed-line"
                  d={closedEyeArc(c.x, c.y)}
                  opacity={0}
                />
              </g>
            ))}

            {/* 眉毛：平时近乎透明，情绪需要时才显形 */}
            {[PET_BROWS.left, PET_BROWS.right].map((b, i) => (
              <path
                key={`brow-${i}`}
                ref={(el) => {
                  browRefs.current[i] = el;
                }}
                className="pet-brow"
                data-brow={i === 0 ? 'left' : 'right'}
                opacity={expr.browAlpha}
                d={`M ${b.x - PET_BROWS.halfWidth} ${b.y} Q ${b.x} ${b.y - PET_BROWS.arch * 2} ${
                  b.x + PET_BROWS.halfWidth
                } ${b.y}`}
              />
            ))}

            {/* 腮红 */}
            {PET_BLUSH.map((b, i) => (
              <ellipse
                key={`blush-${i}`}
                ref={(el) => {
                  blushRefs.current[i] = el;
                }}
                className="pet-blush"
                cx={b.cx}
                cy={b.cy}
                rx={b.rx}
                ry={b.ry}
                opacity={0}
              />
            ))}

            <path
              key={expr.mouth}
              className={`pet-mouth pet-mouth-${expr.mouth}`}
              d={PET_MOUTHS[expr.mouth]}
              fill={mouthFilled ? 'currentColor' : 'none'}
            />
          </g>
          <Fx fx={expr.fx} />
        </g>
      </g>
    </svg>
  );
}
