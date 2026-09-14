/**
 * 操作日志的事务生命周期与持久化。
 *
 * 粒度：一个 Agent 轮次（runId = assistant messageId）= 一个撤销点。
 * MV3 下 Service Worker 随时可能被回收，所以撤销点必须落盘（chrome.storage.local），
 * 否则「撤销刚才那一步」会在 SW 重启后变成一个空承诺。
 */
import type { UndoOp, UndoPoint } from './types';

export const UNDO_STORAGE_KEY = 'markai.undo';
/** 保留最近多少个撤销点（够用即可，避免无限增长） */
export const MAX_UNDO_POINTS = 10;

interface ActiveTransaction {
  runId: string;
  ops: UndoOp[];
  containsDelete: boolean;
  /** 父目录顺序检查点（parentId → 动手前的完整子序） */
  orderCheckpoints: Map<string, string[]>;
}

let active: ActiveTransaction | null = null;

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** 开始记录一个轮次。上一轮若没正常收尾（异常/被打断），先落盘再开新的。 */
export async function beginUndoTransaction(runId: string): Promise<void> {
  if (active) await endUndoTransaction();
  active = { runId, ops: [], containsDelete: false, orderCheckpoints: new Map() };
}

/**
 * 取一个父目录的"动手前完整子序"（每个父目录每轮只取一次）。
 *
 * **调用方必须在该父目录发生任何改动之前调用**，否则取到的就不是"操作前"状态了。
 * 这是并发批量删除能精确还原顺序的唯一依据：逐条下标在并发下不可靠，
 * 逐条的"位置锚点"也不可靠（抓取顺序 ≠ 记录顺序，实测栽过）。
 */
export async function ensureOrderCheckpoint(parentId: string): Promise<void> {
  if (!active || active.orderCheckpoints.has(parentId)) return;
  const children = await chrome.bookmarks.getChildren(parentId).catch(() => []);
  active.orderCheckpoints.set(
    parentId,
    children.map((c) => c.id),
  );
}

/** 当前事务已记录的检查点数（测试用） */
export function activeCheckpointCount(): number {
  return active?.orderCheckpoints.size ?? 0;
}

/** 当前是否有事务在记录（工具层据此决定是否埋点） */
export function isRecording(): boolean {
  return active !== null;
}

/** 记录一条可逆操作。没有活动事务时静默忽略（例如测试或非 Agent 触发的写入）。 */
export function recordOp(op: UndoOp): void {
  active?.ops.push(op);
}

/** 标记本轮包含删除（删除没有快照，撤销时必须拒绝而不是假装成功） */
export function markDelete(): void {
  if (active) active.containsDelete = true;
}

/** 当前事务里已记录的操作数（测试与诊断用） */
export function activeOpCount(): number {
  return active?.ops.length ?? 0;
}

/**
 * 结束当前事务并落盘。
 * 没有任何写操作的轮次不会产生撤销点（避免出现「撤销 0 项」的空按钮）。
 */
export async function endUndoTransaction(): Promise<UndoPoint | null> {
  const tx = active;
  active = null;
  if (!tx || tx.ops.length === 0) return null;
  const point: UndoPoint = {
    id: uid(),
    runId: tx.runId,
    createdAt: Date.now(),
    ops: tx.ops,
    ...(tx.orderCheckpoints.size > 0
      ? {
          orderCheckpoints: [...tx.orderCheckpoints.entries()].map(([parentId, order]) => ({
            parentId,
            order,
          })),
        }
      : {}),
    containsDelete: tx.containsDelete,
  };
  const points = await readUndoPoints();
  points.unshift(point);
  await writeUndoPoints(points.slice(0, MAX_UNDO_POINTS));
  return point;
}

/** 仅测试用：丢弃未落盘的活动事务 */
export function resetUndoTransactionForTest(): void {
  active = null;
}

export async function readUndoPoints(): Promise<UndoPoint[]> {
  try {
    const data = await chrome.storage.local.get(UNDO_STORAGE_KEY);
    const raw = data[UNDO_STORAGE_KEY] as { points?: UndoPoint[] } | undefined;
    return Array.isArray(raw?.points) ? raw.points : [];
  } catch {
    return [];
  }
}

export async function writeUndoPoints(points: UndoPoint[]): Promise<void> {
  try {
    await chrome.storage.local.set({ [UNDO_STORAGE_KEY]: { points } });
  } catch {
    // 写不进存储不应影响书签操作本身
  }
}

/** 取出并移除一个撤销点（不指定 id 时取最新的） */
export async function takeUndoPoint(id?: string): Promise<UndoPoint | null> {
  const points = await readUndoPoints();
  const idx = id ? points.findIndex((p) => p.id === id) : 0;
  if (idx < 0 || idx >= points.length) return null;
  const [point] = points.splice(idx, 1);
  await writeUndoPoints(points);
  return point ?? null;
}
