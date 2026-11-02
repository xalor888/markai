/**
 * 弹窗「待删除清单」卡片上那句话。
 *
 * 为什么值得单独一个函数：
 * 这张卡片的文字有**三种完全不同的语义**，混在一起写会变成四层嵌套三元
 * （原来就是这样），而且没人能给它写测试。
 *
 * 三种语义分别是：
 *  - 还在读 → 不知道，就不要说结论；
 *  - 读失败 → 不知道，而且要说清"为什么看不到"；
 *  - 读到了 → 才轮到"有没有待办"。
 *
 * 早先的写法是直接用 `pendingCount > 0` 判断，而 `pendingCount` 初值是 0，
 * 于是**第一次读取完成之前**界面就写着「当前没有待确认的删除提议。」
 * ——在还不知道的情况下给出确定结论。SW 睡着时这次读要几百毫秒，
 * 用户看到的就是一句假话；读失败时更糟，永远停在"没有提议"。
 */

export type PendingLoadState = 'loading' | 'ok' | 'error';

export interface PendingCopyInput {
  state: PendingLoadState;
  /** 待确认的删除提议数量（只在 state === 'ok' 时有意义） */
  pendingCount: number;
  /** 「无需确认」模式：Agent 的删除建议会自动执行 */
  autoDeleteMode: boolean;
}

export function pendingCardCopy({ state, pendingCount, autoDeleteMode }: PendingCopyInput): string {
  if (state === 'loading') return '正在读取待办…';
  if (state === 'error') return '读取失败：看不到待删清单，请重开弹窗或打开完整管理页。';

  if (pendingCount > 0) {
    return autoDeleteMode
      ? '当前为「无需确认」模式：Agent 的删除建议会自动执行。'
      : 'Agent 提出了删除建议，等待你确认。';
  }
  return autoDeleteMode
    ? '当前为「无需确认」模式：Agent 删除建议自动执行，无需手动确认。'
    : '当前没有待确认的删除提议。';
}
