/**
 * ── 书签库洞察（纯函数，不碰 chrome / React） ──
 *
 * 概览页要回答的四个问题：
 *   1. 我一共有多少书签？（总数 / 文件夹数）
 *   2. 最近发生了什么？（今天 / 最近 7 天新增）
 *   3. 有什么值得现在处理？（重复链接 / 空文件夹）
 *   4. 这些数字从哪来？（同一棵树只走一遍，路径与分组都在这里算完）
 *
 * 为什么要单独一层：
 *  - 概览 / 体检 / 未来的每周回顾都要同一组数字，散在组件里就会出现
 *    "概览说 2 组重复、体检说 3 组"这种自相矛盾；
 *  - 大库（10k 条）上，一次 O(n) 遍历 + memo 足够；分组逻辑必须可单测。
 *
 * 重复的判定**不是**逐字相等：同一篇文章常带 utm_* / fbclid / 末尾斜杠 / #锚点，
 * 那些都指向同一个页面。这里做一层保守归一化（不改协议与路径大小写），
 * 只清掉明确无意义的追踪参数与锚点——宁可少报，也不要把不同页面误合并。
 */

type BNode = chrome.bookmarks.BookmarkTreeNode;

export interface LibraryItem {
  id: string;
  title: string;
  url: string;
  /** 完整路径（含根，如「书签栏 / 设计 / 动效」） */
  path: string;
  /** 收藏时间（毫秒）；0 = 未知 */
  dateAdded?: number;
  /** 最近使用时间（毫秒）；0/缺失 = 从未打开 */
  dateLastUsed?: number;
}

export interface EmptyFolder {
  id: string;
  title: string;
  path: string;
}

export interface DeepBookmark extends LibraryItem {
  /** 1 = 直接放在根下（书签栏 / 其他书签） */
  depth: number;
}

export interface DuplicateGroup {
  /** 归一化后的键（仅用于去重与调试，不展示给用户） */
  key: string;
  items: LibraryItem[];
}

export interface LibraryInsights {
  total: number;
  folders: number;
  emptyFolders: number;
  maxDepth: number;
  /** 本地自然日内新增的书签数 */
  addedToday: number;
  /** 含今天在内的最近 7 天新增 */
  added7d: number;
  duplicateGroups: number;
  /** 多余的副本数（= 每组条数 - 1 之和） */
  duplicateExtra: number;
  /** 最多 12 组，每组最多 4 条（够展示与交给 Agent，不至于把 storage 撑爆） */
  duplicates: DuplicateGroup[];
  /** 最多 20 个空文件夹 */
  emptyFolderList: EmptyFolder[];
  /** 位于第 4 层或更深（4 层以上才开始"翻半天才找到"） */
  deepBookmarks: number;
  /** 最多 8 条深层书签样本（够说明问题，不至于把清单变成第二棵树） */
  deepSamples: DeepBookmark[];
  /** 最近 7 天每天新增（含今天，0 的日期也会占位） */
  dailyAdded: { date: string; count: number }[];
}

/** 本地自然日 key（YYYY-MM-DD），用于日桶 */
function localDayKey(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 超过这个层级的书签算"深层嵌套"：1=根下，2/3 层是正常分类 */
export const DEEP_DEPTH_THRESHOLD = 4;

/** 明确无意义的追踪参数：移除它们不会改变"指向哪个页面" */
const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'gclsrc',
  'mc_cid',
  'mc_eid',
  'igshid',
  'ref_src',
  'ref_url',
  'spm',
  'yclid',
]);

/**
 * 归一化 URL 用于"是否同一个页面"的判断。
 *
 * 保守规则：
 *  - 去掉锚点（#section 是页内位置，不是另一个页面）；
 *  - 去掉 utm_* 与常见点击追踪参数；
 *  - 去掉末尾多余的 `/`；
 *  - 协议与域名小写（路径大小写保留，因为很多站点路径是区分大小写的）。
 *
 * 解析失败时退回 `trim().toLowerCase()`：宁可把两个脏 URL 当成不同页面，
 * 也不要因为抛错让整页洞察挂掉。
 */
export function normalizeUrlForDup(url: string): string {
  const raw = (url || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    u.hash = '';
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase();
    const kept: Array<[string, string]> = [];
    for (const [k, v] of u.searchParams.entries()) {
      const key = k.toLowerCase();
      if (TRACKING_PARAMS.has(key) || key.startsWith('utm_')) continue;
      kept.push([k, v]);
    }
    kept.sort(([a], [b]) => a.localeCompare(b));
    const qs = new URLSearchParams(kept).toString();
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}${path}${qs ? `?${qs}` : ''}`;
  } catch {
    return raw.toLowerCase();
  }
}

/** 根节点的显示名（Chrome 根 id 固定：1 书签栏 / 2 其他书签 / 3 移动设备） */
function rootLabel(node: BNode): string {
  const title = (node.title || '').trim();
  if (title) return title;
  if (node.id === '1') return '书签栏';
  if (node.id === '2') return '其他书签';
  if (node.id === '3') return '移动设备';
  return '根目录';
}

/**
 * 一次遍历同时产出：文件夹统计、空文件夹、书签条目（带路径）。
 *
 * 复杂度 O(n)，不递归到浏览器的 `children` 之外；10k 条在本地是毫秒级。
 */
export function analyzeLibrary(
  roots: BNode[],
  now: number = Date.now(),
  limits: { duplicateGroups?: number; itemsPerGroup?: number; emptyFolders?: number } = {},
): LibraryInsights {
  const dupLimit = limits.duplicateGroups ?? 12;
  const itemsPerGroup = limits.itemsPerGroup ?? 4;
  const emptyLimit = limits.emptyFolders ?? 20;

  const dayStartDate = new Date(now);
  dayStartDate.setHours(0, 0, 0, 0);
  const dayStart = dayStartDate.getTime();
  // "最近 7 天"含今天：今天 + 前 6 天
  const weekStart = dayStart - 6 * 24 * 60 * 60 * 1000;

  let total = 0;
  let folders = 0;
  let emptyFolders = 0;
  let maxDepth = 0;
  let addedToday = 0;
  let added7d = 0;
  const emptyFolderList: EmptyFolder[] = [];
  const deepSamples: DeepBookmark[] = [];
  let deepBookmarks = 0;
  const byKey = new Map<string, LibraryItem[]>();
  const perDay = new Map<string, number>();

  const walk = (node: BNode, parents: string[], depth: number) => {
    const label = rootLabel(node);
    if (node.url) {
      total++;
      const dateAdded = typeof node.dateAdded === 'number' ? node.dateAdded : 0;
      if (dateAdded >= dayStart) addedToday++;
      if (dateAdded >= weekStart) {
        added7d++;
        const key = localDayKey(dateAdded);
        perDay.set(key, (perDay.get(key) ?? 0) + 1);
      }
      const item: LibraryItem = {
        id: node.id,
        title: node.title || node.url,
        url: node.url,
        path: parents.join(' / '),
        dateAdded,
        ...(typeof node.dateLastUsed === 'number' && node.dateLastUsed > 0
          ? { dateLastUsed: node.dateLastUsed }
          : {}),
      };
      if (depth >= DEEP_DEPTH_THRESHOLD) {
        deepBookmarks++;
        if (deepSamples.length < 8) deepSamples.push({ ...item, depth });
      }
      const key = normalizeUrlForDup(node.url);
      if (key) {
        const list = byKey.get(key);
        if (list) list.push(item);
        else byKey.set(key, [item]);
      }
      return;
    }

    folders++;
    if (depth > maxDepth) maxDepth = depth;
    const kids = node.children ?? [];
    if (kids.length === 0) {
      emptyFolders++;
      if (emptyFolderList.length < emptyLimit) {
        emptyFolderList.push({ id: node.id, title: node.title || '(未命名)', path: parents.join(' / ') });
      }
    }
    const next = [...parents, label];
    for (const child of kids) walk(child, next, depth + 1);
  };

  // 根节点（书签栏 / 其他书签 / 移动设备）不作为"文件夹"计入统计：
  // 它们永远存在，算进"空文件夹"只会让数字虚高（与健康检查的同一口径）。
  for (const root of roots) {
    const label = rootLabel(root);
    for (const child of root.children ?? []) walk(child, [label], 1);
  }

  const duplicates: DuplicateGroup[] = [];
  let duplicateGroups = 0;
  let duplicateExtra = 0;
  for (const [key, items] of byKey) {
    if (items.length < 2) continue;
    duplicateGroups++;
    duplicateExtra += items.length - 1;
    if (duplicates.length < dupLimit) {
      duplicates.push({ key, items: items.slice(0, itemsPerGroup) });
    }
  }
  // 多余的副本越多越值得先处理
  duplicates.sort((a, b) => b.items.length - a.items.length);

  return {
    total,
    folders,
    emptyFolders,
    maxDepth,
    addedToday,
    added7d,
    duplicateGroups,
    duplicateExtra,
    duplicates,
    emptyFolderList,
    deepBookmarks,
    deepSamples,
    dailyAdded: Array.from({ length: 7 }, (_, i) => {
      const d = new Date(dayStart);
      d.setDate(d.getDate() - (6 - i));
      const key = localDayKey(d.getTime());
      return { date: key, count: perDay.get(key) ?? 0 };
    }),
  };
}

/** 把重复组摊平成可复制/可交给 Agent 的文本（最多 30 条，避免上下文被撑爆） */
export function describeDuplicates(insights: LibraryInsights, max = 30): string {
  const lines: string[] = [];
  for (const group of insights.duplicates) {
    for (const item of group.items) {
      if (lines.length >= max) break;
      lines.push(`- ${item.title}（${item.url}）[路径：${item.path || '根目录'}]`);
    }
    if (lines.length >= max) break;
  }
  return lines.join('\n');
}


/** 重复组保留策略：保留最早收藏 / 保留最近使用 */
export type DuplicateKeepStrategy = 'oldest' | 'recent';

/**
 * 从一组重复里挑建议保留的那一条（纯函数）。
 *
 * - `oldest`：dateAdded 最小（未知时间视为最晚，不抢"最早"）；
 * - `recent`：dateLastUsed 最大；都没有使用记录时退回收藏时间最新的一条。
 * 并列时用 id 稳定排序，保证每次打开体检得到同一个建议。
 */
export function pickDuplicateKeeper(
  items: readonly LibraryItem[],
  strategy: DuplicateKeepStrategy,
): LibraryItem | null {
  if (items.length === 0) return null;
  const sorted = [...items].sort((a, b) => {
    if (strategy === 'oldest') {
      const ta = a.dateAdded || Number.MAX_SAFE_INTEGER;
      const tb = b.dateAdded || Number.MAX_SAFE_INTEGER;
      if (ta !== tb) return ta - tb;
    } else {
      const ta = a.dateLastUsed || 0;
      const tb = b.dateLastUsed || 0;
      if (ta !== tb) return tb - ta;
      const da = a.dateAdded || 0;
      const db = b.dateAdded || 0;
      if (da !== db) return db - da;
    }
    return String(a.id).localeCompare(String(b.id), 'en', { numeric: true });
  });
  return sorted[0] ?? null;
}
