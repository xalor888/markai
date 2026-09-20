/**
 * 重复书签的判定与「保留哪一条」的规则（纯逻辑，不碰 chrome.*）。
 *
 * 抽出来的理由：清理重复原先要靠模型把每组的 id 逐个抄进 propose_deletions，
 * 几百组时既费 token 又极易抄错。这里把「分组」与「保留谁」变成可单测的确定性逻辑，
 * 工具只负责按既有安全闸门执行。
 */

/** 去重所需的最小节点形状（与 chrome.bookmarks.BookmarkTreeNode 兼容） */
export interface DupeNode {
  id: string;
  title: string;
  url?: string;
  parentId?: string;
  /** 收藏时间（越小越早） */
  dateAdded?: number;
  /** 最近使用时间（可能缺省，0 表示未知） */
  dateLastUsed?: number;
  children?: DupeNode[];
}

export interface DupeGroup {
  /** 归一化后的 URL（分组键） */
  key: string;
  items: DupeNode[];
}

/**
 * URL 归一化：去片段、去查询参数、去 www、去尾斜杠。
 *
 * 注意**协议差异按设计保留**（http 与 https 视为不同）：
 * 自动改写协议或据此判重都可能在用户不知情时改变收藏的语义。
 */
export function normalizeUrl(u?: string): string {
  if (!u) return '';
  try {
    const parsed = new URL(u.trim());
    parsed.hash = '';
    parsed.search = '';
    if (parsed.hostname.startsWith('www.')) parsed.hostname = parsed.hostname.slice(4);
    return parsed.toString().replace(/\/$/, '');
  } catch {
    // 非标准 URL（如缺失协议）：尽力剥离常见噪声
    return u
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/[?#].*$/, '')
      .replace(/\/+$/, '');
  }
}

/** 按归一化 URL 分组，只返回有重复的组（组内多的在前） */
export function buildDuplicateGroups(nodes?: DupeNode[]): DupeGroup[] {
  if (!nodes || nodes.length === 0) return [];
  const byUrl = new Map<string, DupeNode[]>();
  const walk = (list: DupeNode[]) => {
    for (const n of list) {
      if (n.url) {
        const key = normalizeUrl(n.url);
        const arr = byUrl.get(key) ?? [];
        arr.push(n);
        byUrl.set(key, arr);
      }
      if (n.children?.length) walk(n.children);
    }
  };
  walk(nodes);
  return [...byUrl.entries()]
    .filter(([, arr]) => arr.length > 1)
    .map(([key, items]) => ({ key, items }))
    .sort((a, b) => b.items.length - a.items.length);
}

export interface KeeperChoice {
  /** 保留哪一条 */
  keep: DupeNode;
  /** 建议删除的其余条目 */
  remove: DupeNode[];
  /** 为什么留它（面向用户的人话，会出现在提议与预览里） */
  reason: string;
}

/** 标题是不是"就是网址本身"（用户没有改过名） */
function hasCustomTitle(n: DupeNode): boolean {
  const t = (n.title || '').trim();
  if (!t) return false;
  return t !== (n.url ?? '').trim();
}

/**
 * 决定一组重复里保留哪一条。规则**确定且可解释**（依次比较，第一项不同即分胜负）：
 *
 *  1. 有自定义标题的优先——用户改过名，说明在意这条；
 *  2. 最近使用时间更大的优先（dateLastUsed 已知时）；
 *  3. 收藏更早的优先（dateAdded 更小）——"用得最久的那条"；
 *  4. 仍相同则按 id 字符串排序取最小，保证结果可复现（不做随机选择）。
 *
 * 之所以要固定规则：让"一键去重"的结果可预期、可复现，也让预览里能讲清理由。
 */
export function pickDuplicateKeeper(items: DupeNode[]): KeeperChoice {
  if (items.length === 0) throw new Error('pickDuplicateKeeper：组内没有条目');
  const sorted = [...items].sort((a, b) => {
    const custom = Number(hasCustomTitle(b)) - Number(hasCustomTitle(a));
    if (custom !== 0) return custom;
    const used = (b.dateLastUsed ?? 0) - (a.dateLastUsed ?? 0);
    if (used !== 0) return used;
    const added = (a.dateAdded ?? Number.MAX_SAFE_INTEGER) - (b.dateAdded ?? Number.MAX_SAFE_INTEGER);
    if (added !== 0) return added;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const keep = sorted[0]!;
  const remove = sorted.slice(1);

  let reason: string;
  if (hasCustomTitle(keep)) reason = '它有自定义标题（改过名的通常是你在意的那条）';
  else if ((keep.dateLastUsed ?? 0) > 0) reason = '它最近被使用过';
  else if (keep.dateAdded !== undefined) reason = '它收藏得最早';
  else reason = '按 id 稳定排序取第一条（其余条件相同）';

  return { keep, remove, reason };
}
