/**
 * ── 命令面板的"最近使用"（轻量、可单测） ──
 *
 * 为什么需要：命令面板打开时是空的，用户要么记得名字、要么从头翻。
 * 最近点过的文件夹/书签是最可靠的"下一步意图"，把它排在最前面能把
 * "找东西"变成"确认一下"。
 *
 * 存储用 localStorage 而不是 chrome.storage：
 *  - 它只影响一个浏览器窗口的输入体验，不需要跨设备同步；
 *  - 命令面板在打开瞬间要同步读，异步 storage 会让首屏闪一下空列表。
 *
 * 只记录**书签与文件夹**：动作（打开设置/清空搜索）没有稳定身份，
 * 记下来也只会变成一排"上次点过的按钮"，没有意义。
 */

export type RecentKind = 'bookmark' | 'folder';

export interface RecentEntry {
  id: string;
  kind: RecentKind;
  title: string;
  subtitle?: string;
  url?: string;
  /** 最近一次使用的时间（只用于排序与调试） */
  at: number;
}

export const RECENT_STORAGE_KEY = 'markai.command.recent';
/** 面板一次只展示 6 条：再多就把"常用动作"挤出首屏 */
export const RECENT_LIMIT = 6;

function isEntry(value: unknown): value is RecentEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<RecentEntry>;
  return (
    typeof v.id === 'string' &&
    (v.kind === 'bookmark' || v.kind === 'folder') &&
    typeof v.title === 'string' &&
    typeof v.at === 'number'
  );
}

/**
 * 纯函数：把一条新的使用记录并入列表。
 *
 * 规则：同 id 只保留一条、最新在前、超过上限截断。
 * 抽成纯函数是为了能在单测里钉住"重复点同一个不会出现两条"。
 */
export function reduceRecent(
  list: readonly RecentEntry[],
  entry: RecentEntry,
  limit: number = RECENT_LIMIT,
): RecentEntry[] {
  const rest = list.filter((e) => e.id !== entry.id);
  return [entry, ...rest].slice(0, Math.max(0, limit));
}

/** 读取（坏数据/隐私模式失败时返回空数组，不抛错） */
export function readRecent(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry).sort((a, b) => b.at - a.at).slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

/** 记录一次使用；写失败不影响主流程 */
export function recordRecent(entry: Omit<RecentEntry, 'at'> & { at?: number }): void {
  try {
    const next = reduceRecent(readRecent(), { ...entry, at: entry.at ?? Date.now() });
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* localStorage 满/被禁用：下次打开少几条最近记录，不影响功能 */
  }
}

/** 清空（设置页/隐私清理时可调用） */
export function clearRecent(): void {
  try {
    localStorage.removeItem(RECENT_STORAGE_KEY);
  } catch {
    /* 忽略 */
  }
}
