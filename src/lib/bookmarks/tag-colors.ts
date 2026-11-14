/**
 * ── 标签颜色（纯本地偏好） ──
 *
 * 只影响标签条、标签对话框与标签管理器的视觉，不写 Chrome 书签结构，
 * 也不改变任何搜索/整理逻辑。颜色是"我一眼认出这个标签"的辅助，不是数据。
 *
 * 调色板只用 5 个有语义的名字 + 默认色；具体色值放在 main.css 的 token 里，
 * 浅色/深色各一套，避免在组件里散落十六进制。
 */

export const TAG_COLOR_KEY = 'markai.tag.colors';

export const TAG_COLORS = [
  { id: 'default', label: '默认', cssVar: 'var(--color-accent)' },
  { id: 'blue', label: '蓝', cssVar: 'var(--tag-blue)' },
  { id: 'green', label: '绿', cssVar: 'var(--tag-green)' },
  { id: 'amber', label: '琥珀', cssVar: 'var(--tag-amber)' },
  { id: 'rose', label: '玫红', cssVar: 'var(--tag-rose)' },
  { id: 'violet', label: '紫', cssVar: 'var(--tag-violet)' },
] as const;

export type TagColorId = (typeof TAG_COLORS)[number]['id'];
export type TagColorMap = Record<string, TagColorId>;

export function normalizeColorId(value: unknown): TagColorId {
  return TAG_COLORS.some((c) => c.id === value) ? (value as TagColorId) : 'default';
}

/** 取标签颜色；大小写不敏感，未设置返回 default */
export function colorForTag(map: TagColorMap, tag: string): TagColorId {
  return map[tag.trim().replace(/^#+/, '').toLowerCase()] ?? 'default';
}

/** CSS 变量（给 style 用） */
export function colorVarOf(id: TagColorId): string {
  return TAG_COLORS.find((c) => c.id === id)?.cssVar ?? 'var(--color-accent)';
}

export async function readTagColors(): Promise<TagColorMap> {
  try {
    const raw = await chrome.storage.local.get(TAG_COLOR_KEY);
    const stored = raw[TAG_COLOR_KEY];
    if (!stored || typeof stored !== 'object') return {};
    const out: TagColorMap = {};
    for (const [tag, color] of Object.entries(stored as Record<string, unknown>)) {
      const id = normalizeColorId(color);
      if (id !== 'default') out[tag.toLowerCase()] = id;
    }
    return out;
  } catch {
    return {};
  }
}

export async function setTagColor(tag: string, color: TagColorId): Promise<TagColorMap> {
  const map = await readTagColors();
  const key = tag.trim().toLowerCase();
  if (!key) return map;
  if (color === 'default') delete map[key];
  else map[key] = color;
  await chrome.storage.local.set({ [TAG_COLOR_KEY]: map });
  return map;
}


/** 整体写入颜色表（导入备份时用） */
export async function saveTagColors(map: TagColorMap): Promise<void> {
  await chrome.storage.local.set({ [TAG_COLOR_KEY]: map });
}
