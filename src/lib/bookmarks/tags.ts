/**
 * ── 轻量标签（存在 storage，不动 Chrome 书签结构） ──
 *
 * 为什么不用书签文件夹当标签：文件夹只能有一个父级，一个书签属于「技术」也属于
 * 「待读」时就会被迫二选一。标签是纯本地的多对多映射：
 *
 *   bookmarkId -> [tag, tag, ...]
 *
 * 约束：
 *  - 每个书签最多 5 个标签，单个标签最多 24 字符；
 *  - 大小写不敏感去重（保留用户输入的写法）；
 *  - 书签删除后由 pruneTagMap 清掉孤儿 id，storage 不会无限增长。
 */

export const TAGS_KEY = 'markai.tags';
export const MAX_TAGS_PER_BOOKMARK = 5;
export const MAX_TAG_LENGTH = 24;

export type TagMap = Record<string, string[]>;

/** 归一化单个标签：去 #、折叠空白、截断；空串返回 '' */
export function normalizeTag(raw: string): string {
  const tag = (raw || '')
    .trim()
    .replace(/^#+/, '')
    .replace(/\s+/g, ' ')
    .slice(0, MAX_TAG_LENGTH)
    .trim();
  return tag;
}

/** 去重（大小写不敏感）、保序、限 5 个 */
export function normalizeTagList(tags: readonly string[], limit = MAX_TAGS_PER_BOOKMARK): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = normalizeTag(raw);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= limit) break;
  }
  return out;
}

/** 合并已有标签与新增标签（新增在后，去重） */
export function addTags(existing: readonly string[], additions: readonly string[]): string[] {
  return normalizeTagList([...existing, ...additions]);
}

/** 全部标签及出现次数，按次数降序、同次数按名称排序 */
export function collectTagCounts(map: TagMap): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const tags of Object.values(map)) {
    for (const tag of tags) {
      const key = tag.toLowerCase();
      const current = counts.get(key);
      counts.set(key, (current ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ tag: key, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh'));
}

/** 某个标签下的书签 id 集合 */
export function idsForTag(map: TagMap, tag: string): Set<string> {
  const key = normalizeTag(tag).toLowerCase();
  const ids = new Set<string>();
  if (!key) return ids;
  for (const [id, tags] of Object.entries(map)) {
    if (tags.some((t) => t.toLowerCase() === key)) ids.add(id);
  }
  return ids;
}

/** 删除不在当前树里的 id；返回新 map 与被移除的数量 */
export function pruneTagMap(map: TagMap, validIds: ReadonlySet<string>): { next: TagMap; removed: number } {
  const next: TagMap = {};
  let removed = 0;
  for (const [id, tags] of Object.entries(map)) {
    if (validIds.has(id) && tags.length > 0) next[id] = tags;
    else removed += tags.length > 0 ? 1 : 0;
  }
  return { next, removed };
}

/** 读取；坏数据返回空对象 */
export async function readTagMap(): Promise<TagMap> {
  try {
    const raw = await chrome.storage.local.get(TAGS_KEY);
    const map = raw[TAGS_KEY];
    if (!map || typeof map !== 'object') return {};
    const out: TagMap = {};
    for (const [id, tags] of Object.entries(map as Record<string, unknown>)) {
      if (!Array.isArray(tags)) continue;
      const normalized = normalizeTagList(tags.filter((t): t is string => typeof t === 'string'));
      if (normalized.length > 0) out[id] = normalized;
    }
    return out;
  } catch {
    return {};
  }
}

/** 写回；失败抛给调用方决定是否提示 */
export async function saveTagMap(map: TagMap): Promise<void> {
  await chrome.storage.local.set({ [TAGS_KEY]: map });
}

/** 给一个书签设置标签（空数组 = 清除） */
export async function setBookmarkTags(bookmarkId: string, tags: readonly string[]): Promise<TagMap> {
  const map = await readTagMap();
  const normalized = normalizeTagList(tags);
  if (normalized.length === 0) delete map[bookmarkId];
  else map[bookmarkId] = normalized;
  await saveTagMap(map);
  return map;
}

/** 批量添加标签（保留每条原有标签，最多 5 个） */
export async function addTagsToBookmarks(bookmarkIds: readonly string[], tags: readonly string[]): Promise<TagMap> {
  const map = await readTagMap();
  for (const id of bookmarkIds) {
    map[id] = addTags(map[id] ?? [], tags);
    if (map[id]!.length === 0) delete map[id];
  }
  await saveTagMap(map);
  return map;
}


/**
 * 重命名一个标签；如果目标已存在，等价于**合并**（旧标签并入新名字）。
 * 每条书签仍遵守 5 个上限与大小写不敏感去重。
 */
export function renameTag(map: TagMap, from: string, to: string): TagMap {
  const fromKey = normalizeTag(from).toLowerCase();
  const target = normalizeTag(to);
  if (!fromKey || !target) return map;
  const next: TagMap = {};
  for (const [id, tags] of Object.entries(map)) {
    next[id] = normalizeTagList(tags.map((t) => (t.toLowerCase() === fromKey ? target : t)));
  }
  return next;
}

/** 删除一个标签（从所有书签移除；清空的书签条目一并删除） */
export function deleteTag(map: TagMap, tag: string): TagMap {
  const key = normalizeTag(tag).toLowerCase();
  if (!key) return map;
  const next: TagMap = {};
  for (const [id, tags] of Object.entries(map)) {
    const kept = normalizeTagList(tags.filter((t) => t.toLowerCase() !== key));
    if (kept.length > 0) next[id] = kept;
  }
  return next;
}


/** 批量移除标签（保留每条的其他标签；移除后为空的条目删掉） */
export async function removeTagsFromBookmarks(
  bookmarkIds: readonly string[],
  tags: readonly string[],
): Promise<TagMap> {
  const map = await readTagMap();
  const keys = new Set(normalizeTagList(tags).map((t) => t.toLowerCase()));
  if (keys.size === 0) return map;
  for (const id of bookmarkIds) {
    const kept = (map[id] ?? []).filter((t) => !keys.has(t.toLowerCase()));
    if (kept.length > 0) map[id] = normalizeTagList(kept);
    else delete map[id];
  }
  await saveTagMap(map);
  return map;
}
