import { useEffect, useId, useRef, type RefObject } from 'react';
import {
  applyLiquidFilter,
  resetLiquidFilter,
  supportsLiquidGlass,
  type LiquidGlassOptions,
} from './liquid-glass';

export type LiquidGlassHookOptions = LiquidGlassOptions & {
  /**
   * 浮层是否真的挂载了。Dialog / CommandPalette 关闭时直接 return null，
   * 元素在首次挂载时还不存在；effect 不会因为 ref 变化而重跑，
   * 所以必须把 open 传进来当依赖，否则永远建不出滤镜。
   */
  active?: boolean;
};

/**
 * 给浮层挂上液态玻璃：
 * 1. 元素尺寸稳定后生成一次位移图（隐藏元素会跳过）；
 * 2. ResizeObserver 只在尺寸变化时重建，滚动 / 指针移动都不触发滤镜重算；
 * 3. 指针位置只写两个 CSS 变量，不跑 rAF；
 * 4. 环境不支持时只标 data-liquid="off"，CSS 回退到普通磨砂。
 *
 * 用法：
 *   const panelRef = useLiquidGlass<HTMLDivElement>({ bezel: 7, scale: 6 });
 *   <div ref={panelRef} className="markai-glass markai-glass-liquid">…</div>
 */
export function useLiquidGlass<T extends HTMLElement>(options: LiquidGlassHookOptions = {}): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const rawId = useId();
  const filterId = `markai-lg-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const { active = true, bezel = 7, scale = 6, aberration = 0 } = options;

  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;

    if (!supportsLiquidGlass()) {
      el.dataset.liquid = 'off';
      return;
    }
    /* data-liquid 只在滤镜真的建好后才置 on：
       否则 var(--liquid-filter) 还没值，backdrop-filter 会整条失效，连磨砂都没了。 */

    let frame = 0;
    let settleTimer = 0;

    const build = () => {
      const applied = applyLiquidFilter(el, filterId, { bezel, scale, aberration });
      el.dataset.liquid = applied ? 'on' : 'off';
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(build);
    };

    // 首帧就建，避免开窗后前 200ms 只有磨砂没有折射；
    // 动画结束后再补一次，拿到 transform 结束后的真实盒子。
    build();
    settleTimer = window.setTimeout(build, 240);

    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(el);

    const onPointerMove = (event: PointerEvent) => {
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) return;
      el.style.setProperty('--liquid-mx', `${((event.clientX - box.left) / box.width) * 100}%`);
      el.style.setProperty('--liquid-my', `${((event.clientY - box.top) / box.height) * 100}%`);
    };
    el.addEventListener('pointermove', onPointerMove, { passive: true });

    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(settleTimer);
      resizeObserver.disconnect();
      el.removeEventListener('pointermove', onPointerMove);
      resetLiquidFilter(el, filterId);
      delete el.dataset.liquid;
      el.style.removeProperty('--liquid-mx');
      el.style.removeProperty('--liquid-my');
    };
  }, [active, filterId, bezel, scale, aberration]);

  return ref;
}
