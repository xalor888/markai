/**
 * ── 搜索历史（轻量、可单测、只存查询词） ──
 *
 * 主搜索是实时过滤：用户每敲一个字都换一次结果，没人会"提交"搜索。
 * 但"上次搜过什么"仍然是极有用的上下文——重新打开面板/页面后，
 * 从最近的查询接着找，比重新打一遍快得多。
 *
 * 只存查询字符串，不存结果、不存书签内容；最多 5 条，本地 localStorage。
 * 与命令面板的"最近使用"分开：那是具体条目，这是搜索词。
 */
export const SEARCH_HISTORY_KEY = 'markai.search.recent';
export const SEARCH_HISTORY_LIMIT = 5;

/** 归一化：去首尾空白、折叠内部连续空白；空串返回 '' */
export function normalizeSearchQuery(q: string): string {
  return (q || '').trim().replace(/\s+/g, ' ');
}

/**
 * 纯函数：并入一条搜索词。
 *
 * 规则：空词忽略；大小写不敏感去重（保留最新写法）；最新在前；上限截断。
 */
export function reduceSearchHistory(
  list: readonly string[],
  query: string,
  limit: number = SEARCH_HISTORY_LIMIT,
): string[] {
  const q = normalizeSearchQuery(query);
  if (!q) return [...list].slice(0, limit);
  const lower = q.toLowerCase();
  const rest = list.filter((item) => item.toLowerCase() !== lower);
  return [q, ...rest].slice(0, Math.max(0, limit));
}

/** 读取：坏数据/隐私模式失败时返回空数组 */
export function readSearchHistory(): string[] {
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is string => typeof v === 'string' && normalizeSearchQuery(v).length > 0)
      .slice(0, SEARCH_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

/** 记录一次查询；写失败不影响搜索本身 */
export function recordSearch(query: string): void {
  try {
    const next = reduceSearchHistory(readSearchHistory(), query);
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* 忽略 */
  }
}

/** 清空（隐私清理/界面上的「清除」按钮） */
export function clearSearchHistory(): void {
  try {
    localStorage.removeItem(SEARCH_HISTORY_KEY);
  } catch {
    /* 忽略 */
  }
}
