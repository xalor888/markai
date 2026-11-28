/**
 * ── 侧边栏偏好（纯函数 + 一个极小的持久层） ──
 *
 * 为什么单独放一层：
 *  · 排序/密度是"用户习惯"，必须跨会话保留，但又不值得进全局 store 再触发整树重渲染；
 *  · 排序规则要能单测（给定一棵树，输出顺序必须确定），所以做成纯函数。
 *
 * 默认值刻意选"文件夹在前、按名称"：这是绝大多数人整理后的样子，
 * 也让新用户第一眼看到的是结构而不是一堆零散书签。
 */

export type SidebarSort = 'manual' | 'name' | 'count' | 'recent';
export type SidebarDensity = 'comfortable' | 'compact';

export interface SidebarPrefs {
  sort: SidebarSort;
  density: SidebarDensity;
  /** 是否在根文件夹行显示书签总数 */
  showCounts: boolean;
}

export const SIDEBAR_PREFS_KEY = 'markai.sidebar.prefs';

export const SIDEBAR_DEFAULT_PREFS: SidebarPrefs = {
  sort: 'manual',
  density: 'comfortable',
  showCounts: true,
};

export const SIDEBAR_SORT_OPTIONS: { value: SidebarSort; label: string }[] = [
  { value: 'manual', label: '手动顺序' },
  { value: 'name', label: '按名称' },
  { value: 'count', label: '按条目数' },
  { value: 'recent', label: '按最近添加' },
];

type BNode = chrome.bookmarks.BookmarkTreeNode;

/**
 * 把 storage 里的任意值洗成合法偏好。
 *
 * storage 可能是旧版本写的、被手工改坏的、或半截对象；任何一项非法就回落默认，
 * 而不是抛错——侧边栏偏好坏掉不该让整个工作区打不开。
 */
export function normalizeSidebarPrefs(raw: unknown): SidebarPrefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const sort = SIDEBAR_SORT_OPTIONS.some((opt) => opt.value === o.sort)
    ? (o.sort as SidebarSort)
    : SIDEBAR_DEFAULT_PREFS.sort;
  const density: SidebarDensity = o.density === 'compact' ? 'compact' : 'comfortable';
  return {
    sort,
    density,
    showCounts: typeof o.showCounts === 'boolean' ? o.showCounts : SIDEBAR_DEFAULT_PREFS.showCounts,
  };
}

/** 递归统计一棵子树的全部书签（不是文件夹）数 */
export function countBookmarks(nodes: BNode[] | undefined): number {
  let n = 0;
  const walk = (list: BNode[]) => {
    for (const node of list) {
      if (node.url) n++;
      else if (node.children) walk(node.children);
    }
  };
  if (nodes) walk(nodes);
  return n;
}

/** 子树里最近一次收藏时间（毫秒）；没有任何带日期的书签时为 0 */
export function latestAdded(nodes: BNode[] | undefined): number {
  let latest = 0;
  const walk = (list: BNode[]) => {
    for (const node of list) {
      if (node.url && node.dateAdded && node.dateAdded > latest) latest = node.dateAdded;
      if (node.children) walk(node.children);
    }
  };
  if (nodes) walk(nodes);
  return latest;
}

/**
 * 对同一层节点排序（不递归改 children 本身，返回新数组）。
 *
 * 规则：
 *  · 文件夹永远在书签前（除了 manual，用户怎么摆就怎么显示）；
 *  · name/count/recent 三档同层内按各自键排序；键相同时先比标题，标题也相同则比 id。
 *    最后这层 id 兜底不是洁癖：只比标题时，两个同名条目谁在前取决于**输入数组顺序**，
 *    而输入顺序会随展开/折叠、增量刷新而变——同一批数据两次渲染顺序不同，
 *    用户看到的是"列表自己在跳"。
 */
export function sortNodes(nodes: BNode[], sort: SidebarSort): BNode[] {
  if (sort === 'manual') return nodes;
  const byTitle = (a: BNode, b: BNode) => (a.title || '').localeCompare(b.title || '', 'zh-Hans-CN');
  /** 完全等键时的确定性兜底：按 id 升序，保证结果与输入顺序无关 */
  const byId = (a: BNode, b: BNode) => a.id.localeCompare(b.id, 'en');
  const tie = (a: BNode, b: BNode) => byTitle(a, b) || byId(a, b);
  const key = (node: BNode): number => {
    if (sort === 'count') return countBookmarks(node.children);
    if (sort === 'recent') return node.dateAdded ?? latestAdded(node.children);
    return 0;
  };
  return [...nodes].sort((a, b) => {
    const aFolder = !a.url;
    const bFolder = !b.url;
    if (aFolder !== bFolder) return aFolder ? -1 : 1;
    if (sort === 'name') return tie(a, b);
    const diff = key(b) - key(a);
    return diff !== 0 ? diff : tie(a, b);
  });
}

/**
 * 递归排序整棵树（返回新树，不改原对象）。
 *
 * 只重建 children 数组，节点对象本身复用——`TreeRow` 是 memo 的，
 * 换一个对象引用会让所有行重渲染，而排序只改"谁在前"。
 */
export function sortTree(nodes: BNode[], sort: SidebarSort): BNode[] {
  if (sort === 'manual') return nodes;
  return sortNodes(nodes, sort).map((node) =>
    node.children && node.children.length > 0 ? { ...node, children: sortTree(node.children, sort) } : node,
  );
}

/** 读取偏好；storage 不可用时静默回落默认（例如非扩展环境下的单测） */
export async function readSidebarPrefs(): Promise<SidebarPrefs> {
  try {
    const data = await chrome.storage.local.get(SIDEBAR_PREFS_KEY);
    return normalizeSidebarPrefs(data[SIDEBAR_PREFS_KEY]);
  } catch {
    return SIDEBAR_DEFAULT_PREFS;
  }
}

export async function writeSidebarPrefs(prefs: SidebarPrefs): Promise<void> {
  try {
    await chrome.storage.local.set({ [SIDEBAR_PREFS_KEY]: normalizeSidebarPrefs(prefs) });
  } catch {
    // 写失败只影响"下次打开还记不记得"，不值得打断当前操作
  }
}
