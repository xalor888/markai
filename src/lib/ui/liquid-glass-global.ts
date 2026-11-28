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

/** v2 类与其旧别名（旧类名在其它分支仍被引用，必须继续响应指针） */
const GLASS_SELECTOR = '.markai-glass-liquid, .mk-glass-2';
/** 同时打开的玻璃浮层超过这个数就降级：多层 backdrop 叠加在中低端机上是可见卡顿 */
const GLASS_BUDGET = 3;

function onPointerMove(event: PointerEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const el = target.closest<HTMLElement>(GLASS_SELECTOR);
  if (!el) return;
  const box = el.getBoundingClientRect();
  if (!box.width || !box.height) return;
  const x = `${((event.clientX - box.left) / box.width) * 100}%`;
  const y = `${((event.clientY - box.top) / box.height) * 100}%`;
  el.style.setProperty('--mk-mx', x);
  el.style.setProperty('--mk-my', y);
  // 旧变量双写：v2 之前写下的样式与其它工作线读的仍是 --liquid-*
  el.style.setProperty('--liquid-mx', x);
  el.style.setProperty('--liquid-my', y);
}

/**
 * 玻璃预算：浮层数量 > 3 时给 `<html>` 打 `data-glass-budget="low"`，
 * 由 CSS 关掉 backdrop 并抬回实心底色。
 *
 * 用 MutationObserver 而不是 pointermove 里数节点：指针不一定会动，
 * 而浮层的增删是离散事件。这里是**防抖计数**，不跑 rAF、不写样式；
 * 指针反光那条路径仍然是纯变量写入。
 */
function installGlassBudget(): () => void {
  if (
    typeof document === 'undefined' ||
    typeof MutationObserver === 'undefined' ||
    !document.body
  ) {
    return () => {};
  }
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    const root = document.documentElement;
    const count = document.querySelectorAll(GLASS_SELECTOR).length;
    if (count > GLASS_BUDGET) root.dataset.glassBudget = 'low';
    else delete root.dataset.glassBudget;
  };
  const schedule = () => {
    if (timer !== null) return;
    timer = setTimeout(flush, 120);
  };

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  schedule();
  return () => {
    observer.disconnect();
    if (timer !== null) clearTimeout(timer);
    delete document.documentElement.dataset.glassBudget;
  };
}

/** 启动一次即可；返回清理函数（测试用）。 */
export function installLiquidGlass(): () => void {
  if (installed) return () => {};
  installed = true;
  document.addEventListener('pointermove', onPointerMove, { passive: true });
  const stopBudget = installGlassBudget();
  return () => {
    document.removeEventListener('pointermove', onPointerMove);
    stopBudget();
    installed = false;
  };
}
