/**
 * ── 宠物脸：把眼型画成 SVG（rAF 驱动，无第三方动效库） ──
 *
 * 三个约束决定了这个实现：
 *  1. **零依赖**：不引 motion / framer-motion（包体现状 1.07 MB，动效库一个就 60 KB 起）
 *  2. **尊重 reduced-motion**：系统要求减少动效时直接静态，不跑 rAF（不是"动画变快"）
 *  3. **装饰性**：`aria-hidden`——状态本身已有文字表达，宠物不该成为读屏噪音
 *
 * 眼睛用多边形（不是图片）：形状在 normal/happy/squint/tired 之间连续插值，
 * 于是"眯眼思考"是过渡而不是换图。
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
import { breathScale, lookOf, type PetState } from '@/lib/pet/state';

/** 单个眼睛在脸内的缩放与位置（归一化坐标，脸半径 = 1） */
const EYE_SCALE = 0.32;
const EYE_LX = -0.4;
const EYE_RX = 0.4;
const EYE_Y = 0.02;
/** 视线偏移到 SVG 单位的换算（像素 → 归一化） */
const GAZE_DIVISOR = 120;

function polyPoints(poly: Point[], cx: number, gx: number, gy: number): string {
  return poly
    .map(([x, y]) => `${(x * EYE_SCALE + cx + gx).toFixed(3)},${(y * EYE_SCALE + EYE_Y + gy).toFixed(3)}`)
    .join(' ');
}

export function PetFace({ state = 'idle', size = 72 }: { state?: PetState; size?: number }) {
  const look = lookOf(state);
  const [view, setView] = useState({ lid: look.lidBase, gx: 0, gy: 0, breath: 1 });
  const queue = useRef<BlinkEvent[]>([]);
  const nextBlink = useRef(Number.POSITIVE_INFINITY);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const host = useRef<SVGSVGElement | null>(null);

  // 指针跟随：只在组件可见时监听（鼠标离开窗口后 gaze 归零由 loop 里的 null 判断处理）
  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      pointer.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, []);

  useEffect(() => {
    // 系统减少动效：直接静态（连 rAF 都不跑，侧边栏常驻时这也省电）
    const reduced =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    if (reduced) {
      setView({ lid: look.lidBase, gx: 0, gy: 0, breath: 1 });
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    nextBlink.current = t0 + look.blinkEveryMs * (0.6 + Math.random() * 0.8);

    const loop = (now: number): void => {
      const t = now - t0;
      if (now >= nextBlink.current) {
        queueBlink(queue.current, now);
        // ±25% 抖动：固定节拍看起来像机器在打拍子
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
      setView({ lid, gx, gy, breath: breathScale(t, look.breathPeriodMs, look.breathAmp) });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [look.blinkEveryMs, look.lidBase, look.breathPeriodMs, look.breathAmp, look.gazeRange]);

  const eye = applyLid(shapeOf(look.eye), view.lid);
  const left = polyPoints(eye, EYE_LX, view.gx, view.gy);
  const right = polyPoints(eye, EYE_RX, view.gx, view.gy);

  return (
    <svg
      ref={host}
      data-testid="pet-face"
      data-pet-state={state}
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="-1.15 -1.15 2.3 2.3"
      className="select-none"
    >
      {/* 脸：呼吸时轻微纵向缩放（横轴不动，否则左右会"抖动"） */}
      <g transform={`scale(1 ${view.breath.toFixed(4)})`}>
        <circle r="0.98" fill="var(--color-muted)" stroke="var(--color-border)" strokeWidth="0.022" />
        <circle cx="-0.42" cy="-0.5" r="0.16" fill="var(--color-card)" opacity="0.5" />
        <polygon points={left} fill="var(--color-foreground)" />
        <polygon points={right} fill="var(--color-foreground)" />
        {/* 眼神光：固定在上缘内侧，随视线微移（没有它眼睛像玻璃珠） */}
        <circle cx={-0.3 + view.gx} cy={-0.12 + view.gy} r="0.045" fill="var(--color-card)" opacity="0.9" />
        <circle cx={0.5 + view.gx} cy={-0.12 + view.gy} r="0.045" fill="var(--color-card)" opacity="0.9" />
      </g>
    </svg>
  );
}
