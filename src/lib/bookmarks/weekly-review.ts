/**
 * ── 每周回顾（纯计算 + 本地快照） ──
 *
 * 回答四个问题：本周新增多少、自动整理多少、失败多少、重复/空文件夹比上次记录变了多少。
 * 快照只存**计数**，不存书签内容；每周第一次打开概览时出现一次，之后不再打扰。
 *
 * "本周"从本地周一 0 点开始。上周快照缺失时，变化量返回 null（显示"首次记录"），
 * 不假装从 0 变成 3。
 */
import type { LibraryInsights } from './insights';
import type { OrganizeLogEntry } from '@/lib/ai/organize-log';

export const WEEKLY_SNAPSHOT_KEY = 'markai.weekly.snapshot';
export const WEEKLY_SEEN_KEY = 'markai.weekly.seen';

export interface WeeklySnapshot {
  /** 周一 0 点的本地日期 key（YYYY-MM-DD），也作为这一周的 id */
  weekKey: string;
  total: number;
  duplicates: number;
  emptyFolders: number;
  at: number;
}

export interface WeeklyReview {
  weekKey: string;
  weekStart: number;
  added: number;
  organized: number;
  failed: number;
  duplicateDelta: number | null;
  emptyDelta: number | null;
  hasIssues: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** 本地周一 0 点（周日算上一周的周一） */
export function weekStartOf(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=周日
  const offset = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - offset);
  return d.getTime();
}

export function weekKeyOf(now = Date.now()): string {
  return dayKey(weekStartOf(now));
}

/** 组装本周回顾（不读 storage） */
export function buildWeeklyReview(
  insights: LibraryInsights,
  log: readonly OrganizeLogEntry[],
  previous: WeeklySnapshot | null,
  now = Date.now(),
): WeeklyReview {
  const start = weekStartOf(now);
  const key = dayKey(start);
  const added = insights.dailyAdded
    .filter((d) => d.date >= key)
    .reduce((n, d) => n + d.count, 0);
  const inWeek = log.filter((e) => e.at >= start);
  const organized = inWeek.filter((e) => e.action === 'moved' || e.action === 'created').length;
  const failed = inWeek.filter((e) => e.action === 'failed').length;
  return {
    weekKey: key,
    weekStart: start,
    added,
    organized,
    failed,
    duplicateDelta: previous ? insights.duplicateGroups - previous.duplicates : null,
    emptyDelta: previous ? insights.emptyFolders - previous.emptyFolders : null,
    hasIssues: insights.duplicateGroups > 0 || insights.emptyFolders > 0 || failed > 0,
  };
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** 上周（或上次展示时）的快照；坏数据当没有 */
export function readWeeklySnapshot(): WeeklySnapshot | null {
  const snap = readJson<WeeklySnapshot>(WEEKLY_SNAPSHOT_KEY);
  if (!snap || typeof snap.weekKey !== 'string') return null;
  if (typeof snap.total !== 'number' || typeof snap.duplicates !== 'number') return null;
  return snap;
}

export function saveWeeklySnapshot(snapshot: WeeklySnapshot): void {
  try {
    localStorage.setItem(WEEKLY_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    /* 忽略 */
  }
}

/** 这一周是否已经展示过 */
export function weeklySeen(weekKey: string): boolean {
  try {
    return localStorage.getItem(WEEKLY_SEEN_KEY) === weekKey;
  } catch {
    return true; // 存不了就当已看过，避免反复打扰
  }
}

export function markWeeklySeen(weekKey: string): void {
  try {
    localStorage.setItem(WEEKLY_SEEN_KEY, weekKey);
  } catch {
    /* 忽略 */
  }
}
