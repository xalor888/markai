/**
 * 工具栏（badge + 悬停说明）作为**不依赖 storage 的可见通路**。
 *
 * 为什么单独抽出来：storage 写不进去时（配额满、权限问题），任何"记一条提示再让 UI 读"
 * 的方案都同样会失败。工具栏是唯一还available的通道，因此在两处用到：
 * - 右键指令 seed 写失败（见 context-menu.ts）；
 * - 全局快捷键打开侧边栏失败（用户按了 Ctrl+Shift+M 却什么都没发生）。
 *
 * 抽成模块是为了能被单测直接验证，而不是埋在一个只注册监听器的 background 里。
 */

/** 显示一个错误标记：红底 + 感叹号 + 悬停说明 */
export async function toolbarError(title: string): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' }).catch(() => {});
  await chrome.action.setBadgeText({ text: '!' }).catch(() => {});
  await chrome.action.setTitle({ title }).catch(() => {});
}

/** 清除错误标记，恢复常规标题 */
export async function toolbarClear(title = 'MarkAI'): Promise<void> {
  await chrome.action.setTitle({ title }).catch(() => {});
  await chrome.action.setBadgeText({ text: '' }).catch(() => {});
}
