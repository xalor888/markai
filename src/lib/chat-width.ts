/**
 * ── Agent 面板宽度的唯一口径 ──
 *
 * 抽出来的原因：这三组值曾在四个地方各写一套——加载时钳 200–640、完整页拖拽钳
 * 200–640、侧边栏拖拽钳 200–560、侧边栏渲染又用 `maxWidth: min(100%, 560px)`。
 * 后果是「在完整页把面板拖到 640，再打开侧边栏」会得到一个内部宽度 640、
 * 视觉宽度 560 的面板，而且一按下拖拽手柄就跳回去——三处钳制互相打架。
 *
 * 现在只留这里一份，UI 与测试都从这里取。纯函数，不碰 React/chrome。
 */

/** 下限：再窄就不像面板了（也是历史上一直用的值） */
export const CHAT_WIDTH_MIN = 200;

/** 完整页（三分栏 IDE）的上限 */
export const CHAT_WIDTH_MAX = 640;

/**
 * 侧边栏（紧凑抽屉）的上限。
 * 侧边栏本身常只有四百来像素宽，640 的抽屉会把中栏整个盖住。
 */
export const CHAT_WIDTH_MAX_COMPACT = 560;

/**
 * 把宽度钳进 `[CHAT_WIDTH_MIN, max]`。
 *
 * - 非有限数（`NaN` / `Infinity`，可能来自被手改过的 storage）一律回落到下限，
 *   而不是让 `Math.min/max` 把 `NaN` 传出去——那会让面板宽度变成 CSS 里的 `NaNpx`，
 *   表现为面板凭空消失；
 * - `max` 小于下限时以**下限**为准（宁可窄一点，也不要出现负数宽度）。
 */
export function clampChatWidth(width: number, max: number): number {
  const upper = Math.max(max, CHAT_WIDTH_MIN);
  if (typeof width !== 'number' || !Number.isFinite(width)) return CHAT_WIDTH_MIN;
  return Math.min(Math.max(Math.round(width), CHAT_WIDTH_MIN), upper);
}
