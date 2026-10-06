/** ── 长期记忆模块：用户偏好、习惯与自定义规则管理 ── */

import { uid } from '@/lib/format';

export const MEMORY_STORAGE_KEY = 'markai.memories';

export type MemoryCategory = 'preference' | 'rule' | 'habit' | 'custom';

export interface MemoryItem {
  id: string;
  content: string;
  category: MemoryCategory;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export const CATEGORY_LABELS: Record<MemoryCategory, string> = {
  preference: '偏好',
  rule: '规则',
  habit: '习惯',
  custom: '自定义',
};

// 内存兜底（非扩展环境/单测回退）
let memoryCache: MemoryItem[] = [];

/** 从存储读取所有记忆（按更新时间降序） */
export async function getMemories(): Promise<MemoryItem[]> {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const data = await chrome.storage.local.get(MEMORY_STORAGE_KEY);
      const list = (data[MEMORY_STORAGE_KEY] as MemoryItem[]) || [];
      memoryCache = Array.isArray(list) ? list : [];
    }
  } catch {
    // 降级使用 memoryCache
  }
  return [...memoryCache].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 保存记忆列表到持久化存储 */
export async function saveMemories(memories: MemoryItem[]): Promise<void> {
  memoryCache = [...memories];
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    await chrome.storage.local.set({ [MEMORY_STORAGE_KEY]: memoryCache });
  }
}

/** 添加一条新记忆 */
export async function addMemoryItem(
  content: string,
  category: MemoryCategory = 'preference',
): Promise<MemoryItem> {
  const trimmed = content.trim();
  if (!trimmed) throw new Error('记忆内容不能为空');

  const current = await getMemories();
  // 检查是否已有完全相同的记忆，有则激活并更新
  const existing = current.find((m) => m.content === trimmed);
  if (existing) {
    const updated: MemoryItem = {
      ...existing,
      enabled: true,
      category,
      updatedAt: Date.now(),
    };
    const next = current.map((m) => (m.id === existing.id ? updated : m));
    await saveMemories(next);
    return updated;
  }

  const now = Date.now();
  const newItem: MemoryItem = {
    id: `mem_${uid().slice(0, 8)}`,
    content: trimmed,
    category,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };

  await saveMemories([newItem, ...current]);
  return newItem;
}

/** 更新指定记忆 */
export async function updateMemoryItem(
  id: string,
  patch: Partial<Omit<MemoryItem, 'id' | 'createdAt'>>,
): Promise<MemoryItem | null> {
  const current = await getMemories();
  const target = current.find((m) => m.id === id);
  if (!target) return null;

  const updated: MemoryItem = {
    ...target,
    ...patch,
    updatedAt: Date.now(),
  };
  await saveMemories(current.map((m) => (m.id === id ? updated : m)));
  return updated;
}

/** 删除指定记忆 */
export async function deleteMemoryItem(id: string): Promise<boolean> {
  const current = await getMemories();
  const next = current.filter((m) => m.id !== id);
  if (next.length === current.length) return false;
  await saveMemories(next);
  return true;
}

/** 切换记忆启用状态 */
export async function toggleMemoryItem(id: string): Promise<MemoryItem | null> {
  const current = await getMemories();
  const target = current.find((m) => m.id === id);
  if (!target) return null;
  return updateMemoryItem(id, { enabled: !target.enabled });
}

/** 清空所有记忆 */
export async function clearAllMemories(): Promise<void> {
  await saveMemories([]);
}

/** 关键词搜索记忆 */
export function searchMemories(query: string, memories: MemoryItem[]): MemoryItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return memories;
  return memories.filter(
    (m) =>
      m.content.toLowerCase().includes(q) ||
      (CATEGORY_LABELS[m.category] && CATEGORY_LABELS[m.category].toLowerCase().includes(q)),
  );
}

/**
 * 格式化已启用的长期记忆供 Agent 系统提示使用。
 * 遵循条数上限，以精简清晰的格式注入。
 */
export function formatMemoriesForPrompt(memories: MemoryItem[], maxItems = 30): string {
  const active = memories.filter((m) => m.enabled).slice(0, maxItems);
  if (active.length === 0) return '';

  const lines = active.map((m, idx) => {
    const tag = CATEGORY_LABELS[m.category] || '偏好';
    return `${idx + 1}. [${tag}] ${m.content}`;
  });

  return [
    '',
    '【长期记忆 / 用户长期偏好与规则】',
    '以下是已记录的用户长期偏好与规则。在进行书签归类、整理、重命名、去重或清理时，请严格遵守以下偏好与规则，无需重复询问用户：',
    ...lines,
    '（如用户提出与上述记忆相违背的新指令，以本次用户的最新具体指令为准；若用户要求记住新偏好或删除旧偏好，请调用相应记忆工具）',
    '',
  ].join('\n');
}
