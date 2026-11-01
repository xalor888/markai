/**
 * ── 单击「延迟打开」——让双击有机会反悔 ──
 *
 * 为什么需要这个模块：书签行是**单击即打开**，同时标题支持**双击重命名**。
 * 这两个手势天然打架：浏览器先派发一次 click，再派发 dblclick，所以"双击重命名"
 * 必然先执行一次打开动作。旧实现用一个 350ms 的 `lastClickAt` 去抖"忽略第二次 click"，
 * 那只把后果从**开两个标签页**降成**开一个标签页**——用户双击标题想改名，结果还是
 * 多开了一个页面（实测：每次改名都留下一个后台标签页）。
 *
 * 正确做法是把「打开」本身推迟到双击窗口之后：
 *  - 单击 → 排一次定时打开，窗口内没有第二次点击就执行；
 *  - 双击 → 取消那次待执行的打开，只弹重命名框；
 *  - 文件夹 → **不进这个流程**（展开/选中要即时响应，且双击文件夹没有第二语义）。
 *
 * 抽成纯函数（不碰 React、不碰 chrome）是为了能直接单测「双击必须一次都不打开」
 * ——这个性质靠肉眼点不出来，只能靠断言。
 */

/**
 * 双击判定窗口（毫秒）。取 250 而不是 350：它是"单击打开"的**可感知延迟**，
 * 也就压着用户点书签的手感；主流系统的双击阈值下限也在 250 附近。
 */
export const DOUBLE_CLICK_MS = 250;

export interface DelayedOpen {
  /** 排一次打开；重复调用只保留最后一次（连点不会排队开多个） */
  schedule(): void;
  /** 取消待执行的打开（双击时调用） */
  cancel(): void;
  /** 是否有待执行的打开（测试与诊断用） */
  pending(): boolean;
  /** 卸载时清理（不清理会在组件卸载后触发一次无主打开） */
  dispose(): void;
}

/**
 * 造一个延迟打开器。
 *
 * @param open 真正执行打开的回调（点击**之后**的上下文已捕获在闭包里，不依赖事件对象）
 * @param ms   双击窗口；测试可注入极小值以免真的等 250ms
 */
export function createDelayedOpen(open: () => void, ms = DOUBLE_CLICK_MS): DelayedOpen {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return {
    schedule() {
      // 连点两次「打开」不该开两个：后一次覆盖前一次（同一行只可能有一个意图）
      clear();
      timer = setTimeout(() => {
        timer = null;
        open();
      }, ms);
    },
    cancel: clear,
    pending: () => timer !== null,
    dispose: clear,
  };
}
