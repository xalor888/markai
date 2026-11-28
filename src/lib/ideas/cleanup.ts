/**
 * ── 简单清理：勾选 → 生成方案 → 交给 Agent 走暂存链路 ──
 *
 * 这个文件**只算数、不删东西**。它回答两个问题：
 *  1. 每类能清理多少条（"将影响 N 条"必须与勾选数一致）；
 *  2. 断链这类"要跑才知道"的项，在没检测前必须标"待检测"，不能猜一个数进 N。
 *
 * 真正删除永远走 `propose_deletions` 或暂存方案，由用户确认。
 */
import type { IdeaInput } from '@/lib/features/ideas';
import { analyzeLibrary } from '@/lib/bookmarks/insights';

type BNode = chrome.bookmarks.BookmarkTreeNode;

export type CleanupKind = 'duplicate' | 'empty-folder' | 'stale' | 'broken';

export interface CleanupCategory {
  kind: CleanupKind;
  label: string;
  description: string;
  /** 可清理条数；`null` 表示还没检测（断链在检测前就是这个状态） */
  count: number | null;
  /** 需要先点"检测链接"才知道数量 */
  needsProbe?: boolean;
  /** 样本 id，供生成方案时引用 */
  sampleIds: string[];
}

export interface CleanupSelection {
  duplicate: boolean;
  'empty-folder': boolean;
  stale: boolean;
  broken: boolean;
}

export const CLEANUP_DEFAULT_SELECTION: CleanupSelection = {
  duplicate: true,
  'empty-folder': true,
  stale: false,
  broken: false,
};

export const STALE_CLEANUP_MONTHS = 12;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/** 计算前三类（无需检测）的数量；断链始终为 null（待检测） */
export function computeCleanupCategories(
  roots: BNode[],
  now: number = Date.now(),
  probedBroken?: { count: number; sampleIds: string[] },
): CleanupCategory[] {
  const insights = analyzeLibrary(roots, now);
  const cutoff = now - STALE_CLEANUP_MONTHS * MONTH_MS;
  const staleIds: string[] = [];
  const walk = (node: BNode) => {
    if (node.url) {
      const reference =
        typeof node.dateLastUsed === 'number' && node.dateLastUsed > 0 ? node.dateLastUsed : node.dateAdded;
      if (typeof reference === 'number' && reference > 0 && reference < cutoff) staleIds.push(node.id);
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  for (const root of roots) for (const child of root.children ?? []) walk(child);

  const duplicateIds = insights.duplicates.flatMap((g) => g.items.slice(1).map((i) => i.id));

  return [
    {
      kind: 'duplicate',
      label: '重复链接',
      description: '同一页面被收藏多次，每组保留最早的一条',
      count: insights.duplicateExtra,
      sampleIds: duplicateIds,
    },
    {
      kind: 'empty-folder',
      label: '空文件夹',
      description: '没有任何子项的文件夹',
      count: insights.emptyFolders,
      sampleIds: insights.emptyFolderList.map((f) => f.id),
    },
    {
      kind: 'stale',
      label: `超过 ${STALE_CLEANUP_MONTHS} 个月未打开`,
      description: '没有使用记录时按收藏时间估算',
      count: staleIds.length,
      sampleIds: staleIds,
    },
    {
      kind: 'broken',
      label: '断链 / 死链',
      description: probedBroken ? '已检测' : '需要先检测链接',
      count: probedBroken ? probedBroken.count : null,
      needsProbe: !probedBroken,
      sampleIds: probedBroken?.sampleIds ?? [],
    },
  ];
}

/**
 * 勾选后"将影响 N 条"。
 *
 * 关键规则：**待检测项不计入 N**。用户看到的数字必须是"点了就真的会处理这么多"，
 * 把未知数算进去，等于用一个猜的数字给操作背书。
 */
export function impactCount(categories: CleanupCategory[], selection: CleanupSelection): number {
  let total = 0;
  for (const cat of categories) {
    if (!selection[cat.kind]) continue;
    if (cat.count === null) continue;
    total += cat.count;
  }
  return total;
}

/** 还没检测、但被勾选的类别（UI 用来提示"这几类要先生成检测"） */
export function pendingProbeKinds(categories: CleanupCategory[], selection: CleanupSelection): CleanupKind[] {
  return categories.filter((c) => selection[c.kind] && c.count === null).map((c) => c.kind);
}

/**
 * 生成交给 Agent 的清理指令。
 *
 * 只包含用户真正勾选、且数量已知的类别；断链若未检测，指令里明确要求"先检测"。
 * 不生成空指令——一条"帮我清理"没有任何信息量，Agent 只能反问。
 */
export function buildCleanupPrompt(categories: CleanupCategory[], selection: CleanupSelection): string {
  const lines: string[] = [];
  for (const cat of categories) {
    if (!selection[cat.kind]) continue;
    if (cat.kind === 'duplicate' && cat.count) {
      lines.push(`- 重复链接 ${cat.count} 条：每组保留最早收藏的一条`);
    } else if (cat.kind === 'empty-folder' && cat.count) {
      lines.push(`- 空文件夹 ${cat.count} 个：全部删除`);
    } else if (cat.kind === 'stale' && cat.count) {
      lines.push(`- 超过 ${STALE_CLEANUP_MONTHS} 个月未打开的 ${cat.count} 条：先列出来给我看`);
    } else if (cat.kind === 'broken') {
      lines.push('- 断链：先检测链接，把打不开的列出来，不要自动删');
    }
  }
  if (lines.length === 0) return '';
  return [
    '帮我做一次书签清理，范围如下：',
    ...lines,
    '',
    '要求：先把要删除的条目列出来给我确认，不要直接删除；确认后再走删除提议。',
  ].join('\n');
}

/** 把 IdeaInput 的 roots 转成清理需要的输入（保持签名一致，便于测试构造） */
export function categoriesForInput(input: IdeaInput, now: number = Date.now()): CleanupCategory[] {
  return computeCleanupCategories(input.roots, now);
}
