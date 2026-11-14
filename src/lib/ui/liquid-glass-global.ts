/**
 * 全局玻璃高光安装器。
 *
 * ── 为什么不是 SVG 折射 ──
 * `backdrop-filter: url(#filter)` 在普通网页里能用（Chrome 156 实测可折射），
 * 但在 chrome-extension:// 页面上，Chromium 会把 url 滤镜的 backdrop 结果丢成空白：
 * CSS.supports 返回 true、computed style 也显示 url(#f)，实际背景却完全不采样
 * （同页 `filter: url(#f)` 正常，只有 backdrop 版本失效）。这是扩展页面的渲染限制，
 * 不是滤镜写错。所以这里改用「光学玻璃」：真实模糊 + 厚边高光 + 色散边 + 指针反光，
 * 不依赖 backdrop 滤镜引用，所有浮层、所有 Chromium 版本都能看到厚度。
 *
 * 指针反光只写两个 CSS 变量，不跑 rAF、不开观察器。
 */
let installed = false;

function onPointerMove(event: PointerEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const el = target.closest<HTMLElement>('.markai-glass-liquid');
  if (!el) return;
  const box = el.getBoundingClientRect();
  if (!box.width || !box.height) return;
  el.style.setProperty('--liquid-mx', `${((event.clientX - box.left) / box.width) * 100}%`);
  el.style.setProperty('--liquid-my', `${((event.clientY - box.top) / box.height) * 100}%`);
}

/** 启动一次即可；返回清理函数（测试用）。 */
export function installLiquidGlass(): () => void {
  if (installed) return () => {};
  installed = true;
  document.addEventListener('pointermove', onPointerMove, { passive: true });
  return () => {
    document.removeEventListener('pointermove', onPointerMove);
    installed = false;
  };
}
