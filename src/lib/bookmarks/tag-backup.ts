/**
 * ── 标签备份（导出 / 导入 JSON） ──
 *
 * 只备份"本地标签"：书签 id -> 标签、标签颜色偏好。
 * 不包含书签本身（书签在浏览器里），换机时先恢复书签、再导入标签，id 对不上的会被跳过。
 */
import { addTags, normalizeTagList, type TagMap } from './tags';
import {
  normalizeColorId,
  TAG_COLORS,
  type TagColorMap,
} from './tag-colors';

export const TAG_BACKUP_VERSION = 1;

export interface TagBackup {
  version: typeof TAG_BACKUP_VERSION;
  exportedAt: string;
  tags: TagMap;
  colors: TagColorMap;
}

export function buildTagBackup(
  tags: TagMap,
  colors: TagColorMap,
  now = Date.now(),
): TagBackup {
  return {
    version: TAG_BACKUP_VERSION,
    exportedAt: new Date(now).toISOString(),
    tags,
    colors,
  };
}

/** 校验并归一化外部 JSON；不是合法备份返回 null */
export function parseTagBackup(raw: unknown): TagBackup | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== TAG_BACKUP_VERSION) return null;
  if (!obj.tags || typeof obj.tags !== 'object') return null;
  const tags: TagMap = {};
  for (const [id, value] of Object.entries(obj.tags as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const normalized = normalizeTagList(value.filter((t): t is string => typeof t === 'string'));
    if (normalized.length > 0) tags[id] = normalized;
  }
  const colors: TagColorMap = {};
  if (obj.colors && typeof obj.colors === 'object') {
    for (const [tag, color] of Object.entries(obj.colors as Record<string, unknown>)) {
      const id = normalizeColorId(color);
      if (id !== 'default') colors[tag.toLowerCase()] = id;
    }
  }
  return {
    version: TAG_BACKUP_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : '',
    tags,
    colors,
  };
}

/**
 * 把备份并入当前数据。
 *
 * - 只接受 validIds 里仍存在的书签；对不上的计入 skipped；
 * - 标签按 5 个上限合并（保留已有的，备份的追加）；
 * - 颜色只保留最终确实存在的标签。
 */
export function mergeTagBackup(
  currentTags: TagMap,
  currentColors: TagColorMap,
  validIds: ReadonlySet<string>,
  backup: TagBackup,
): { tags: TagMap; colors: TagColorMap; imported: number; skipped: number } {
  const tags: TagMap = { ...currentTags };
  let imported = 0;
  let skipped = 0;
  for (const [id, incoming] of Object.entries(backup.tags)) {
    if (!validIds.has(id)) {
      skipped += 1;
      continue;
    }
    tags[id] = addTags(tags[id] ?? [], incoming);
    imported += 1;
  }
  const usedTags = new Set<string>();
  for (const list of Object.values(tags)) {
    for (const tag of list) usedTags.add(tag.toLowerCase());
  }
  const colors: TagColorMap = { ...currentColors };
  for (const [tag, color] of Object.entries(backup.colors)) {
    const id = normalizeColorId(color);
    if (id !== 'default' && usedTags.has(tag.toLowerCase())) colors[tag.toLowerCase()] = id;
  }
  return { tags, colors, imported, skipped };
}

/** 给 UI 用的可选色数量（避免组件里再硬编码 5/6） */
export const TAG_COLOR_COUNT = TAG_COLORS.length;
