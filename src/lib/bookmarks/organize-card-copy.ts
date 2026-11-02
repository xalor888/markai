import type { OrganizeStats } from '@/lib/ai/organize-log';

/**
 * 弹窗「自动整理」卡片上的三块文字。
 *
 * 和「待删除清单」那张卡是同一个问题的第二次出现：
 *   `organizeStats` 初值是 null，读失败时也是 null，而渲染写成 `today ?? 0`
 *   → **读不到也显示「今天 0 条」**，还配一句「收藏新页面后会自动归类」。
 *
 * 也就是说：读失败时，界面同时告诉你"今天没整理过"和"你还没收藏过新页面"，
 * 而实际情况是**这次没读到**。这和 0.2.55 / 0.2.57 / 0.2.58 是同一类错误：
 * 把"不知道"渲染成了"没有"。
 */

export type OrganizeLoadState = 'loading' | 'ok' | 'error';

export interface OrganizeCardCopy {
  /** 右上角徽标 */
  badge: string;
  /** 正文那一行 */
  body: string;
  /** 是否显示"有 N 条整理失败" */
  failedCount: number;
}

export function organizeCardCopy(state: OrganizeLoadState, stats: OrganizeStats | null): OrganizeCardCopy {
  if (state === 'loading') {
    return { badge: '读取中', body: '正在读取整理记录…', failedCount: 0 };
  }
  if (state === 'error') {
    return {
      badge: '读取失败',
      body: '读不到整理记录，这不代表今天没整理过。点开可重试。',
      failedCount: 0,
    };
  }
  const latest = stats?.latest;
  return {
    badge: `今天 ${stats?.today ?? 0} 条`,
    body: latest
      ? `最近：${latest.title}${latest.target ? ` → ${latest.target}` : ''}`
      : '收藏新页面后会自动归类，记录会出现在这里。',
    failedCount: stats?.failed ?? 0,
  };
}
