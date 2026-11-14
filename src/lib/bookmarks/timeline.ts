/**
 * ── 时间线数据层（纯函数，可单测） ──
 *
 * 只产出「书签个体」：文件夹只作为路径元信息，**不会**生成可点击的文件夹行。
 * 这是「按时间翻找」视图的核心约束——列表里出现文件夹就失去了按时间排序的意义。
 */

import { getHost } from '@/lib/format';

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

export type TimelineOrder = 'newest' | 'oldest' | 'recent';

/**
 * 排序：最新收藏 / 最早收藏 / 最近打开。
 *
 * 「最近打开」用 `dateLastUsed`（Chrome 只在书签被访问时更新它），与收藏时间正交：
 * 一条三年前收藏、今天刚打开的页面，应该排在最近打开的最前面。
 * 没有 dateLastUsed 的书签（从未打开或浏览器没记录）永远排在最后。
 *
 * 同毫秒时用 id 作稳定的次级键（Chrome 的 id 单调递增，等价于创建顺序），
 * 保证多次渲染顺序完全一致，不会出现「每刷新一次行序都变」。
 */
export function sortTimeline(items: TimelineItem[], order: TimelineOrder = 'newest'): TimelineItem[] {
  const dir = order === 'oldest' ? 1 : -1;
  const keyOf = (item: TimelineItem) =>
    order === 'recent' ? item.dateLastUsed || 0 : item.dateAdded || 0;
  return [...items].sort((a, b) => {
    const ta = keyOf(a);
    const tb = keyOf(b);
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
export function groupByDay(
  items: TimelineItem[],
  now = Date.now(),
  /** 用哪个时间分组：默认收藏时间；「最近打开」排序时传 dateLastUsed */
  timeOf: (item: TimelineItem) => number = (item) => item.dateAdded || 0,
): TimelineDayGroup[] {
  const groups: TimelineDayGroup[] = [];
  for (const item of items) {
    const time = timeOf(item);
    const key = time ? dayKey(time) : 'unknown';
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.items.push(item);
      last.total += 1;
    } else groups.push({ key, label: dayLabel(time, now), items: [item], total: 1 });
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


/** 时间线的时间范围：今天 / 最近 7 天 / 最近 30 天 / 全部 */
export type TimelineRange = 'today' | '7d' | '30d' | 'all';

/**
 * 按收藏时间过滤（纯函数）。
 *
 * 口径："今天"= 本地自然日 0 点起；"7 天"= 今天 + 前 6 天；"30 天"= 今天 + 前 29 天。
 * 未知时间（dateAdded 缺失）只在 "all" 里出现——否则一个没有时间戳的书签
 * 会因为"看起来像今天"而被误算进日更统计。
 */
export function filterTimelineByRange(
  items: readonly TimelineItem[],
  range: TimelineRange,
  now: number = Date.now(),
): TimelineItem[] {
  if (range === 'all') return [...items];
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const days = range === 'today' ? 1 : range === '7d' ? 7 : 30;
  const since = start.getTime() - (days - 1) * 24 * 60 * 60 * 1000;
  return items.filter((item) => item.dateAdded > 0 && item.dateAdded >= since);
}


/**
 * 按域名聚合（时间线的第二种分组方式）。
 *
 * 输入已经是按时间排序的：组内保持时间顺序，组间按"这个站点收藏了多少条"降序，
 * 同数量按域名排序。`www.` 已在 getHost 里剥掉，避免同一站点被拆成两组。
 * 组结构与按天分组一致，因此可以直接复用 `pageGroups` 的分页逻辑。
 */
export function groupByDomain(items: readonly TimelineItem[]): TimelineDayGroup[] {
  const byHost = new Map<string, TimelineDayGroup>();
  for (const item of items) {
    const host = getHost(item.url) || '其他站点';
    const existing = byHost.get(host);
    if (existing) {
      existing.items.push(item);
      existing.total += 1;
    } else {
      byHost.set(host, { key: `domain:${host}`, label: host, items: [item], total: 1 });
    }
  }
  return [...byHost.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
}


/** 去重后的 URL 列表（同一站点聚合里可能有同一页面的多个副本） */
export function uniqueUrls(items: readonly TimelineItem[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!item.url || seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item.url);
  }
  return out;
}
