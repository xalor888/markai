/**
 * ── 宠物脸：眼型 SVG + 眨眼 + 视线 + 可拖拽的甩抛手感 ──
 *
 * 约束没变：**零依赖**（不引 motion）、尊重 reduced-motion、`aria-hidden`（装饰性）。
 *
 * 物理接在 rAF 循环里（不是 CSS transition）：甩抛需要"松开手之后按惯性滑行、撞到边界回弹、
 * 最后被弹簧拉回原位"这段连续行为，CSS 只能做"从 A 到 B 的过渡"。
 */

import { useEffect, useRef, useState } from 'react';
import {
  applyLid,
  consumeBlink,
  gazeOffset,
  queueBlink,
  shapeOf,
  type BlinkEvent,
  type Point,
} from '@/lib/pet/eyes';
import { bounceOff, isResting, springStep, squash, tiltDeg, type SpringState } from '@/lib/pet/physics';
import { breathScale, lookOf, type PetState } from '@/lib/pet/state';

/** 单个眼睛在脸内的缩放与位置（归一化坐标，脸半径 = 1） */
const EYE_SCALE = 0.32;
const EYE_LX = -0.4;
const EYE_RX = 0.4;
const EYE_Y = 0.02;
/** 视线偏移到 SVG 单位的换算（像素 → 归一化） */
const GAZE_DIVISOR = 120;
/** 甩抛能离开原位多远（像素）：不设上限会飞出面版 */
const DRAG_LIMIT = 48;

function polyPoints(poly: Point[], cx: number, gx: number, gy: number): string {
  return poly
    .map(([x, y]) => `${(x * EYE_SCALE + cx + gx).toFixed(3)},${(y * EYE_SCALE + EYE_Y + gy).toFixed(3)}`)
    .join(' ');
}

interface DragRef {
  active: boolean;
  sx: SpringState;
  sy: SpringState;
  lastX: number;
  lastY: number;
  lastT: number;
}

export function PetFace({
  state = 'idle',
  size = 72,
  interactive = false,
}: {
  state?: PetState;
  size?: number;
  /** 允许拖拽甩抛（空态的大宠物开，头部 26px 的小宠物不开——太难点中） */
  interactive?: boolean;
}) {
  const look = lookOf(state);
  const [view, setView] = useState({ lid: look.lidBase, gx: 0, gy: 0, breath: 1, dx: 0, dy: 0, tilt: 0, sq: 0 });
  const [flash, setFlash] = useState(false);
  const queue = useRef<BlinkEvent[]>([]);
  const nextBlink = useRef(Number.POSITIVE_INFINITY);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const host = useRef<SVGSVGElement | null>(null);
  const drag = useRef<DragRef>({
    active: false,
    sx: { pos: 0, vel: 0 },
    sy: { pos: 0, vel: 0 },
    lastX: 0,
    lastY: 0,
    lastT: 0,
  });

  // 指针跟随（视线）：与拖拽无关，拖拽时视线仍跟着指针
  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      pointer.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, []);

  useEffect(() => {
    const reduced =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    // 系统要求减少动效：完全静态（连 rAF 都不跑；拖动时用亮度脉冲作为替代反馈）
    if (reduced) {
      setView({ lid: look.lidBase, gx: 0, gy: 0, breath: 1, dx: 0, dy: 0, tilt: 0, sq: 0 });
      return;
    }
    let raf = 0;
    let prev = performance.now();
    const t0 = prev;
    nextBlink.current = t0 + look.blinkEveryMs * (0.6 + Math.random() * 0.8);

    const loop = (now: number): void => {
      const dt = now - prev;
      prev = now;
      const t = now - t0;
      if (now >= nextBlink.current) {
        queueBlink(queue.current, now);
        nextBlink.current = now + look.blinkEveryMs * (0.75 + Math.random() * 0.5);
      }
      const blinked = consumeBlink(queue.current, now);
      const lid = blinked === null ? look.lidBase : Math.max(blinked, 0);

      let gx = 0;
      let gy = 0;
      const el = host.current;
      if (pointer.current && look.gazeRange > 0 && el) {
        const rect = el.getBoundingClientRect();
        const center: Point = [rect.left + rect.width / 2, rect.top + rect.height / 2];
        const g = gazeOffset([pointer.current.x, pointer.current.y], center, look.gazeRange);
        gx = g.x / GAZE_DIVISOR;
        gy = g.y / GAZE_DIVISOR;
      }

      // 甩抛：松手后按惯性滑行 → 撞边界回弹 → 弹簧拉回原位
      const d = drag.current;
      if (!d.active) {
        const sx = bounceOff(springStep(d.sx, 0, dt).pos, d.sx.vel, -DRAG_LIMIT, DRAG_LIMIT);
        const sy = bounceOff(springStep(d.sy, 0, dt).pos, d.sy.vel, -DRAG_LIMIT, DRAG_LIMIT);
        d.sx = sx;
        d.sy = sy;
      }
      const dx = d.sx.pos;
      const dy = d.sy.pos;
      const tilt = tiltDeg(dx);
      // 按住时固定挤压；松手后挤压随速度回落
      const sq = d.active ? 0.55 : Math.min(0.4, Math.abs(d.sx.vel) / 900 + Math.abs(d.sy.vel) / 900);

      setView({ lid, gx, gy, breath: breathScale(t, look.breathPeriodMs, look.breathAmp), dx, dy, tilt, sq });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [look.blinkEveryMs, look.lidBase, look.breathPeriodMs, look.breathAmp, look.gazeRange]);

  const reducedMotion =
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

  /** 按下：抓取 + 起点记录（reduced-motion 走亮度脉冲替代） */
  const onDown = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (!interactive) return;
    if (reducedMotion) {
      setFlash(true);
      window.setTimeout(() => setFlash(false), 320);
      return;
    }
    const d = drag.current;
    d.active = true;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    d.lastT = performance.now();
    (e.currentTarget as SVGSVGElement).setPointerCapture?.(e.pointerId);
  };

  /** 拖动：位移跟随 + 用"最近两帧位移/时间"估速度（松手时交给物理） */
  const onMove = (e: React.PointerEvent<SVGSVGElement>): void => {
    const d = drag.current;
    if (!d.active) return;
    const now = performance.now();
    const dt = Math.max(1, now - d.lastT);
    const nx = d.sx.pos + (e.clientX - d.lastX);
    const ny = d.sy.pos + (e.clientY - d.lastY);
    d.sx = { pos: Math.max(-DRAG_LIMIT, Math.min(DRAG_LIMIT, nx)), vel: ((e.clientX - d.lastX) / dt) * 1000 };
    d.sy = { pos: Math.max(-DRAG_LIMIT, Math.min(DRAG_LIMIT, ny)), vel: ((e.clientY - d.lastY) / dt) * 1000 };
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    d.lastT = now;
  };

  /** 松手：保留速度，交给 loop 里的弹簧 + 反弹 */
  const onUp = (e: React.PointerEvent<SVGSVGElement>): void => {
    const d = drag.current;
    if (!d.active) return;
    d.active = false;
    // 松手那一刻不加速度（上一次 move 的速度就是甩出去的速度）
    (e.currentTarget as SVGSVGElement).releasePointerCapture?.(e.pointerId);
  };

  const eye = applyLid(shapeOf(look.eye), view.lid);
  const left = polyPoints(eye, EYE_LX, view.gx, view.gy);
  const right = polyPoints(eye, EYE_RX, view.gx, view.gy);
  const sx = 1 + view.sq * 0.16;
  const sy = 1 - view.sq * 0.16;

  return (
    <svg
      ref={host}
      data-testid="pet-face"
      data-pet-state={state}
      data-pet-interactive={interactive ? 'true' : 'false'}
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="-1.15 -1.15 2.3 2.3"
      className={interactive ? 'cursor-grab select-none active:cursor-grabbing' : 'select-none'}
      style={flash ? { filter: 'brightness(1.35)' } : undefined}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      {/* 位移/倾斜/挤压作用在整张脸上：视线（gx/gy）只动眼珠，两者分开 */}
      <g transform={`translate(${view.dx.toFixed(2)} ${view.dy.toFixed(2)}) rotate(${view.tilt.toFixed(2)})`}>
        <g transform={`scale(${sx.toFixed(3)} ${(sy * view.breath).toFixed(3)})`}>
          <circle r="0.98" fill="var(--color-muted)" stroke="var(--color-border)" strokeWidth="0.022" />
          <circle cx="-0.42" cy="-0.5" r="0.16" fill="var(--color-card)" opacity="0.5" />
          <polygon points={left} fill="var(--color-foreground)" />
          <polygon points={right} fill="var(--color-foreground)" />
          {/* 眼神光：固定在上缘内侧，随视线微移（没有它眼睛像玻璃珠） */}
          <circle cx={-0.3 + view.gx} cy={-0.12 + view.gy} r="0.045" fill="var(--color-card)" opacity="0.9" />
          <circle cx={0.5 + view.gx} cy={-0.12 + view.gy} r="0.045" fill="var(--color-card)" opacity="0.9" />
        </g>
      </g>
    </svg>
  );
}
