/**
 * ── 时间线数据层（纯函数，可单测） ──
 *
 * 只产出「书签个体」：文件夹只作为路径元信息，**不会**生成可点击的文件夹行。
 * 这是「按时间翻找」视图的核心约束——列表里出现文件夹就失去了按时间排序的意义。
 */

type BNode = chrome.bookmarks.BookmarkTreeNode;

export interface TimelineItem {
  id: string;
  title: string;
  url: string;
  /** 收藏时间（毫秒）；0 / 缺失表示未知 */
  dateAdded: number;
  /** 最近使用时间（毫秒）；0 / 缺失表示未知 */
  dateLastUsed?: number;
  /** 所在文件夹的完整路径（含根，如「书签栏 / 技术」） */
  path: string;
  parentId?: string;
}

/** 节点在路径中的显示名（根节点 title 为空时给出固定名称，避免路径出现空段） */
function labelOf(node: BNode, isRoot: boolean): string {
  const title = (node.title || '').trim();
  if (title) return title;
  if (isRoot) {
    // Chrome 根节点 id 固定：'1' 书签栏 / '2' 其他书签 / '3' 移动设备
    if (node.id === '1') return '书签栏';
    if (node.id === '2') return '其他书签';
    if (node.id === '3') return '移动设备';
    return '根目录';
  }
  return '(未命名)';
}

/**
 * 递归展平整棵树，只收集 URL 节点。
 * 文件夹不进入结果；路径按「根 / 子 / 孙」拼接，供行内展示位置。
 */
export function flattenBookmarks(roots: BNode[]): TimelineItem[] {
  const out: TimelineItem[] = [];
  const walk = (node: BNode, parents: string[], isRoot: boolean) => {
    const name = labelOf(node, isRoot);
    if (node.url) {
      out.push({
        id: node.id,
        title: node.title || node.url,
        url: node.url,
        dateAdded: typeof node.dateAdded === 'number' ? node.dateAdded : 0,
        ...(typeof node.dateLastUsed === 'number' && node.dateLastUsed > 0
          ? { dateLastUsed: node.dateLastUsed }
          : {}),
        path: parents.join(' / '),
        parentId: node.parentId,
      });
      return;
    }
    const nextParents = [...parents, name];
    for (const child of node.children ?? []) walk(child, nextParents, false);
  };
  for (const root of roots) walk(root, [], true);
  return out;
}

export type TimelineOrder = 'newest' | 'oldest';

/**
 * 纯按收藏时间排序。
 * 同毫秒时用 id 作稳定的次级键（Chrome 的 id 单调递增，等价于创建顺序），
 * 保证多次渲染顺序完全一致，不会出现「每刷新一次行序都变」。
 */
export function sortTimeline(items: TimelineItem[], order: TimelineOrder = 'newest'): TimelineItem[] {
  const dir = order === 'newest' ? -1 : 1;
  return [...items].sort((a, b) => {
    const ta = a.dateAdded || 0;
    const tb = b.dateAdded || 0;
    // 未知时间永远排在最后，不因排序方向跑到最前面
    if (ta === 0 && tb !== 0) return 1;
    if (tb === 0 && ta !== 0) return -1;
    if (ta !== tb) return (ta - tb) * dir;
    return String(a.id).localeCompare(String(b.id), 'en', { numeric: true });
  });
}

export interface TimelineDayGroup {
  /** 分组键：YYYY-MM-DD，未知时间为 'unknown' */
  key: string;
  label: string;
  items: TimelineItem[];
  /**
   * 该组（那一天）的**真实**条数。
   * 分页渲染时 `items` 只是本页切片，条数必须从这里读——
   * 否则「今天」有 100 条、首屏只渲染 80 条时，组头会显示成「今天 80 条」。
   */
  total: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** 某天的人类可读标题：今天 / 昨天 / M月D日（跨年补年份） */
export function dayLabel(ms: number, now = Date.now()): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return '未知时间';
  const d = new Date(ms);
  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayKey(ms) === dayKey(today.getTime())) return '今天';
  if (dayKey(ms) === dayKey(yesterday.getTime())) return '昨天';
  const sameYear = d.getFullYear() === today.getFullYear();
  return sameYear ? `${d.getMonth() + 1}月${d.getDate()}日` : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 按时段分组（输入需已排序；同一天的相邻项归入一组） */
export function groupByDay(items: TimelineItem[], now = Date.now()): TimelineDayGroup[] {
  const groups: TimelineDayGroup[] = [];
  for (const item of items) {
    const key = item.dateAdded ? dayKey(item.dateAdded) : 'unknown';
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.items.push(item);
      last.total += 1;
    } else groups.push({ key, label: dayLabel(item.dateAdded, now), items: [item], total: 1 });
  }
  return groups;
}

/** 时间线的过滤：标题 / URL / 路径 均参与匹配（忽略大小写） */
export function filterTimeline(items: TimelineItem[], query: string): TimelineItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (it) =>
      it.title.toLowerCase().includes(q) ||
      it.url.toLowerCase().includes(q) ||
      it.path.toLowerCase().includes(q),
  );
}

/**
 * 把「按天分组的完整结果」切成第一页：
 * 组内条目按 `limit` 截断，但 `total` 保留当天真实条数。
 *
 * 为什么要按组切而不是先切数组再分组：先切再分只能看到本页的条目，
 * 组头条数会被写成页大小（100 条的今天显示成 80 条）。
 */
export function pageGroups(groups: TimelineDayGroup[], limit: number): TimelineDayGroup[] {
  const out: TimelineDayGroup[] = [];
  let remain = Math.max(0, limit);
  for (const group of groups) {
    if (remain <= 0) break;
    const items = group.items.slice(0, remain);
    out.push({ ...group, items });
    remain -= items.length;
  }
  return out;
}
