/**
 * ── "现在有什么值得说"的事实源（纯函数） ──
 *
 * 碎碎念的文案不是重点，**事实准不准**才是：说错一次（"你有 12 个重复"实际只有 3 组）
 * 之后用户就不信它了。所以这一层只做统计，不做措辞润色。
 *
 * 阈值全部写成常量并导出：这些数字是产品决定（几条重复才值得提），
 * 埋在函数里就永远没法被测试钉住。
 */

import type { ChatterFact } from './chatter';

/** 触发出声的最低门槛 */
export const FACT_THRESHOLDS = {
  /** 重复 URL 组数 ≥ 此值才提（1 组就提太琐碎） */
  duplicateGroups: 2,
  /** 空文件夹数 ≥ 此值才提 */
  emptyFolders: 3,
  /** 单域名条数 ≥ 此值才提 */
  domainCluster: 6,
  /** 总量 ≥ 此值才提"该整理了" */
  totalSize: 1500,
} as const;

export interface PetFlatBookmark {
  id: string;
  title: string;
  url: string;
  /** 一级文件夹名（用于"某个文件夹里有 N 条"这类观察，可选） */
  folderTitle?: string;
}

export interface PetFolderSummary {
  id: string;
  title: string;
  /** 直接子项数（0 = 空文件夹） */
  childCount: number;
}

export interface PetFactInput {
  bookmarks: PetFlatBookmark[];
  folders: PetFolderSummary[];
}

/** 从 url 取可注册域名（与项目里 domain 工具同一口径：去掉协议与路径） */
function hostOf(url: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url.trim());
  if (!m?.[1]) return null;
  // 去掉端口与 www.，保留其余（这里只做"同类聚集"的粗聚类，不做精确可注册域解析）
  return m[1].replace(/:\d+$/, '').replace(/^www\./, '').toLowerCase();
}

/**
 * 统计出可说的观察。
 *
 * 返回的 id 必须**稳定**（同一种观察跨多次调用共用冷却），所以 id 只用"类别 + 关键值"，
 * 不带数字：数字会变（9 个重复 → 10 个重复仍是同一条建议，不该重置冷却）。
 */
export function petFacts(input: PetFactInput): ChatterFact[] {
  const facts: ChatterFact[] = [];
  const { bookmarks, folders } = input;

  // 1) 重复 URL：同一条链接存了多次
  const byUrl = new Map<string, number>();
  for (const b of bookmarks) {
    const u = b.url?.trim();
    if (!u) continue;
    byUrl.set(u, (byUrl.get(u) ?? 0) + 1);
  }
  let dupGroups = 0;
  for (const n of byUrl.values()) if (n > 1) dupGroups++;
  if (dupGroups >= FACT_THRESHOLDS.duplicateGroups) {
    facts.push({ id: 'dup-urls', text: `有 ${dupGroups} 组重复链接，要我合并一下吗？`, weight: 8 });
  }

  // 2) 空文件夹：收藏了却什么都没放
  const empty = folders.filter((f) => f.childCount === 0).length;
  if (empty >= FACT_THRESHOLDS.emptyFolders) {
    facts.push({ id: 'empty-folders', text: `${empty} 个空文件夹，可以清掉。`, weight: 4 });
  }

  // 3) 单域名聚集：同一个站点存太多条
  const byHost = new Map<string, number>();
  for (const b of bookmarks) {
    const h = hostOf(b.url ?? '');
    if (!h) continue;
    byHost.set(h, (byHost.get(h) ?? 0) + 1);
  }
  let worstHost: { host: string; n: number } | null = null;
  for (const [host, n] of byHost) {
    if (!worstHost || n > worstHost.n) worstHost = { host, n };
  }
  if (worstHost && worstHost.n >= FACT_THRESHOLDS.domainCluster) {
    facts.push({
      id: 'domain-cluster',
      text: `${worstHost.host} 存了 ${worstHost.n} 条，要不要归到一个文件夹？`,
      weight: 6,
    });
  }

  // 4) 总量：收藏夹本身开始变重
  if (bookmarks.length >= FACT_THRESHOLDS.totalSize) {
    facts.push({ id: 'total-size', text: `收藏夹已经 ${bookmarks.length} 条了，可以整理一轮。`, weight: 3 });
  }

  return facts;
}

/** 树节点最小形状（只声明这条统计用得到的字段） */
export interface PetTreeNode {
  id: string;
  title: string;
  url?: string;
  children?: PetTreeNode[];
}

/**
 * 从树的形状里扁平化出统计输入：书签取全部层级，文件夹只取**一级**子项数。
 *
 * 只到一级是刻意的：深层递归统计在这个面板里是 O(n) 全树遍历，
 * 而"空文件夹"这类观察在一级就已经够准（深层的空夹很少是用户关心的）。
 */
export function flattenForFacts(roots: PetTreeNode[]): PetFactInput {
  const bookmarks: PetFlatBookmark[] = [];
  const folders: PetFolderSummary[] = [];
  const walk = (nodes: PetTreeNode[], folderTitle: string | undefined, depth: number): void => {
    for (const n of nodes) {
      if (n.url) {
        bookmarks.push({ id: n.id, title: n.title, url: n.url, folderTitle });
        continue;
      }
      if (depth <= 1) folders.push({ id: n.id, title: n.title, childCount: (n.children ?? []).length });
      if (n.children) walk(n.children, n.title, depth + 1);
    }
  };
  for (const root of roots) walk(root.children ?? [], root.title, 1);
  return { bookmarks, folders };
}
