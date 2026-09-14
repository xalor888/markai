/**
 * 操作日志的事务生命周期与持久化。
 *
 * 粒度：一个 Agent 轮次（runId = assistant messageId）= 一个撤销点。
 * MV3 下 Service Worker 随时可能被回收，所以撤销点必须落盘（chrome.storage.local），
 * 否则「撤销刚才那一步」会在 SW 重启后变成一个空承诺。
 */
import { UNDO_BUDGET_BYTES, describeUndoTrim, trimPointsToBudget } from './journal';
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
  const state = await readUndoState();
  // 先按条数上限收敛，再按字节预算裁剪：超配额时**丢最旧的并如实告知**，
  // 而不是让整块写入失败、把「写不进去」显示成「没有可撤销的操作」。
  const candidates = [point, ...state.points].slice(0, MAX_UNDO_POINTS);
  const trim = trimPointsToBudget(candidates, budgetBytes);
  const notice = describeUndoTrim(trim) ?? state.notice;
  await writeUndoPoints(trim.kept, notice);
  return point;
}

/** 仅测试用：丢弃未落盘的活动事务 */
export function resetUndoTransactionForTest(): void {
  active = null;
}

/** 存储结构（v2 起带 notice/noticeAt；v1 只有 points，读取时兼容） */
interface StoredUndo {
  points?: UndoPoint[];
  /** 上一次落盘时的裁剪/失败说明（给用户看的实话） */
  notice?: string;
  noticeAt?: number;
}

export interface UndoState {
  points: UndoPoint[];
  /** 裁剪或写入异常的人话说明；没有异常时为 undefined */
  notice?: string;
  /** notice 产生的时间（UI 据此只提示一次） */
  noticeAt?: number;
}

/** 最近一次**写入失败**（原文 + 发生时间）。SW 内存态：重启即丢（那时也没人会看到旧提示） */
let lastWriteError: { message: string; at: number } | null = null;

/**
 * 撤销点预算。默认取 UNDO_BUDGET_BYTES（依据 chrome.storage.local 的 10 MiB 配额）。
 * 留成可变是为了测试能注入极小预算来验证裁剪逻辑，而不必造出几 MB 的假数据。
 */
let budgetBytes = UNDO_BUDGET_BYTES;
export function setUndoBudgetBytes(bytes: number): void {
  budgetBytes = bytes;
}

export async function readUndoPoints(): Promise<UndoPoint[]> {
  return (await readUndoState()).points;
}

/** 读撤销点 + 如实状态（notice 可能来自历史落盘，也可能来自本次写入失败） */
export async function readUndoState(): Promise<UndoState> {
  let raw: StoredUndo | undefined;
  try {
    const data = await chrome.storage.local.get(UNDO_STORAGE_KEY);
    raw = data[UNDO_STORAGE_KEY] as StoredUndo | undefined;
  } catch {
    // 读不出来：既没有点，也不能假装一切正常
    return lastWriteError
      ? { points: [], notice: lastWriteError.message, noticeAt: lastWriteError.at }
      : { points: [], notice: '读取撤销记录失败', noticeAt: 0 };
  }
  const points = Array.isArray(raw?.points) ? raw.points : [];
  if (lastWriteError) {
    // noticeAt 用错误发生的时间（而不是"现在"），否则每次刷新都算新提示、反复打扰
    return { points, notice: lastWriteError.message, noticeAt: lastWriteError.at };
  }
  return {
    points,
    ...(raw?.notice ? { notice: raw.notice } : {}),
    ...(raw?.noticeAt ? { noticeAt: raw.noticeAt } : {}),
  };
}

/**
 * 落盘。**不再吞掉错误**：写失败必须能被上层看见（否则超配额时表现为
 * 「没有可撤销的操作」，把失败说成了「本来就没有」）。
 * 仍然不向调用方抛错——写不进存储不该让书签操作本身失败。
 */
export async function writeUndoPoints(points: UndoPoint[], notice?: string): Promise<{ ok: boolean; error?: string }> {
  const payload: StoredUndo = {
    points,
    ...(notice ? { notice, noticeAt: Date.now() } : {}),
  };
  try {
    await chrome.storage.local.set({ [UNDO_STORAGE_KEY]: payload });
    lastWriteError = null;
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    lastWriteError = { message: `撤销记录写入失败（${msg}），本次操作将无法撤销`, at: Date.now() };
    return { ok: false, error: msg };
  }
}

/**
 * 清空全部撤销记录（设置页「清空本地数据」用）。
 *
 * 撤销记录里存着**被删书签的子树快照**，属于书签数据的一部分——用户必须有一个入口能删掉它，
 * 否则 docs/privacy.md 里"如何清除"就只能写"清不掉"。**不吞错**：清不掉要让调用方的
 * try/catch 如实提示，而不是显示"已清空"。
 */
export async function clearUndoPoints(): Promise<void> {
  lastWriteError = null;
  await chrome.storage.local.remove(UNDO_STORAGE_KEY);
}

/** 取出并移除一个撤销点（不指定 id 时取最新的） */
export async function takeUndoPoint(id?: string): Promise<UndoPoint | null> {
  const state = await readUndoState();
  const points = state.points;
  const idx = id ? points.findIndex((p) => p.id === id) : 0;
  if (idx < 0 || idx >= points.length) return null;
  const [point] = points.splice(idx, 1);
  // 保留原有 notice：消费一个点不该抹掉"曾丢弃过更早点"的记录
  await writeUndoPoints(points, state.notice);
  return point ?? null;
}
