/**
 * ── 命令面板的检索与打分（纯函数，不碰 React / chrome，可单测） ──
 *
 * 为什么需要它：重做前"找某条书签"要走三步——切视图 → 找到搜索框 → 输入。
 * 而大多数动作（进文件夹、整理当前目录、开关主题）根本没有搜索入口，只能满屏找按钮。
 * 命令面板把这些收敛成一个输入框。
 *
 * 打分刻意做成**可解释**的：分数只由"匹配方式"决定，不掺任何随机或权重魔法，
 * 这样排序结果可以被断言钉住，也不会出现"输入同样的词、两次结果不一样"。
 */

export type CommandKind = 'bookmark' | 'folder' | 'action';

export interface CommandItem {
  id: string;
  kind: CommandKind;
  title: string;
  /** 副标题：书签放域名，文件夹放路径 */
  subtitle?: string;
  /** 书签才有 */
  url?: string;
  /** 动作才有 */
  run?: () => void;
}

/** 各匹配方式的得分：越"贴近"越高 */
export const SCORE = {
  /** 标题与查询完全相同 */
  exact: 1000,
  /** 标题以查询开头 */
  prefix: 600,
  /** 标题里包含查询 */
  contains: 300,
  /** 副标题里包含查询（域名 / 路径） */
  subtitle: 150,
  /** 标题里能按顺序找到这些字符（模糊匹配） */
  fuzzy: 80,
  /** 完全不匹配 */
  none: 0,
} as const;

/** 子序列匹配：查询的字符按顺序出现在标题里（例如 "gh" 命中 "GitHub"） */
function isSubsequence(needle: string, haystack: string): boolean {
  if (!needle) return true;
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i >= needle.length) return true;
  }
  return false;
}

/**
 * 给一条结果打分。
 *
 * 大小写不敏感；空查询视为"全部匹配"（返回 1，让调用方按原顺序展示）。
 */
export function scoreItem(item: CommandItem, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;

  const title = item.title.toLowerCase();
  if (title === q) return SCORE.exact;
  if (title.startsWith(q)) return SCORE.prefix;
  if (title.includes(q)) return SCORE.contains;

  const sub = (item.subtitle ?? '').toLowerCase();
  if (sub && sub.includes(q)) return SCORE.subtitle;

  // 模糊匹配只在查询够短时才放开：查询越长，子序列越容易变成噪音
  if (q.length <= 4 && isSubsequence(q, title)) return SCORE.fuzzy;
  return SCORE.none;
}

/**
 * 检索并排序。
 *
 * 规则：
 * 1. 分数降序；
 * 2. 同分时**保持输入顺序**（调用方按"动作 → 文件夹 → 书签"排好，
 *    于是"输入同样的词"永远得到同样的前几条，不会因为排序不稳定而跳动）；
 * 3. 空查询时按 kind 分组返回，最多 `limit` 条——避免一打开就甩出 400 条书签。
 */
export function searchCommands(items: CommandItem[], query: string, limit = 30): CommandItem[] {
  const q = query.trim();
  const scored = items
    .map((item, index) => ({ item, index, score: scoreItem(item, q) }))
    .filter((x) => x.score > 0);

  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  return scored.slice(0, limit).map((x) => x.item);
}

/** 把结果按 kind 分组（渲染用），组内保持已排好的顺序 */
export function groupCommands(items: CommandItem[]): { kind: CommandKind; label: string; items: CommandItem[] }[] {
  const labels: Record<CommandKind, string> = {
    action: '动作',
    folder: '文件夹',
    bookmark: '书签',
  };
  const order: CommandKind[] = ['action', 'folder', 'bookmark'];
  return order
    .map((kind) => ({ kind, label: labels[kind], items: items.filter((i) => i.kind === kind) }))
    .filter((g) => g.items.length > 0);
}
