/**
 * 操作日志的事务生命周期与持久化。
 *
 * 粒度：一个 Agent 轮次（runId = assistant messageId）= 一个撤销点。
 * MV3 下 Service Worker 随时可能被回收，所以撤销点必须落盘（chrome.storage.local），
 * 否则「撤销刚才那一步」会在 SW 重启后变成一个空承诺。
 */
import { UNDO_BUDGET_BYTES, describeUndoTrim, summarizeOps, trimPointsToBudget } from './journal';
import type { UndoOp, UndoPoint } from './types';

export const UNDO_STORAGE_KEY = 'markai.undo';
/**
 * 进行中事务的增量落盘键。
 *
 * 为什么需要它：`endUndoTransaction` 是唯一的落盘点，而 MV3 的 Service Worker 可能
 * 在轮次跑到一半时被回收（长任务，或用户关掉侧边栏导致保活心跳停止）。进程直接死掉时
 * `finally` 不会执行——已经改动的书签就会**没有任何撤销点**。抛异常是有覆盖的，
 * 丢的只有"进程被杀"这一种，而它恰好最难查。
 */
export const UNDO_PENDING_KEY = 'markai.undo.pending';
/**
 * 增量落盘的节奏：**按条数或时间取先到者**。
 *
 * 每条都写太贵：快照是整份数组，n 条删除会产生 O(n²) 的写入量
 * （750 条实测约 16MB、750 次 set）。但只按时间节流又会让"刚记下的那条"在
 * 被杀时丢掉——这正是第一版的问题。折中成"最多落后 5 条或 250ms"：
 * 750 条删除约 150 次写入（约 3MB），而落后窗口小到几乎无感。
 */
const PENDING_MAX_LAG_OPS = 5;
const PENDING_THROTTLE_MS = 250;
/** 保留最近多少个撤销点（够用即可，避免无限增长） */
export const MAX_UNDO_POINTS = 10;

/** 进行中事务的落盘快照 */
interface PendingTransaction {
  runId: string;
  ops: UndoOp[];
  containsDelete: boolean;
  orderCheckpoints: { parentId: string; order: string[] }[];
  updatedAt: number;
}

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
  cancelTrailingFlush();
  active = { runId, ops: [], containsDelete: false, orderCheckpoints: new Map() };
  pendingWrittenOps = 0;
  pendingWrittenAt = 0;
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
  await persistPending(true);
}

/** 当前事务已记录的检查点数（测试用） */
export function activeCheckpointCount(): number {
  return active?.orderCheckpoints.size ?? 0;
}

/** 当前是否有事务在记录（工具层据此决定是否埋点） */
export function isRecording(): boolean {
  return active !== null;
}

let pendingWrittenAt = 0;
/** 上次落盘时已记录的条数（用来判断"落后多少条"） */
let pendingWrittenOps = 0;
/** 被节流推迟的补写定时器 */
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 安排一次"尾随补写"。
 *
 * 为什么必须有它：节流只在**下一次记录**时才会重新评估，所以一轮操作停下来之后，
 * 最后几条会一直停在内存里。而 MV3 回收 SW 恰恰发生在**空闲**时（不再有事件），
 * 也就是说"停下来"正是最可能被杀的时刻——不加这个定时器，快照就恰好在那时是旧的。
 * 250ms 远小于 SW 的空闲回收阈值，所以补写有机会在被杀之前落地。
 */
function scheduleTrailingFlush(): void {
  if (pendingTimer) return;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    void persistPending(true);
  }, PENDING_THROTTLE_MS);
}

function cancelTrailingFlush(): void {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
}

/**
 * pending 写入的**串行链**。
 *
 * 为什么需要：写入是 fire-and-forget 的异步操作，并发发起时"完成顺序"可能与"发起顺序"不一致，
 * 旧快照可能覆盖新快照（慢的旧写入最后落地 = 快照回退）。串行化之后落盘顺序 = 发起顺序。
 */
let pendingIo: Promise<void> = Promise.resolve();

/**
 * 事务纪元：事务结束/被清理时递增。
 *
 * 用来识别"迟到写入"——某个写入在发起时属于旧纪元，落地时事务已经结束；
 * 此时必须**补偿性删掉**它写下的 pending，否则它会在下次启动复活成撤销点
 * （极端情况下那个 runId 的点已被用户撤销消费过，复活后会变成"再撤一次"）。
 */
let txEpoch = 0;

function enqueuePendingWrite<T>(task: () => Promise<T>): Promise<T> {
  const next = pendingIo.then(task, task);
  // 链上保留一个不会 reject 的版本，避免一次失败让后续写入全部短路
  pendingIo = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function removePendingKey(): Promise<void> {
  try {
    await chrome.storage.local.remove(UNDO_PENDING_KEY);
  } catch {
    // 删不掉只会多一次去重后的无害清理（恢复按 runId 去重）
  }
}

/** 把一个事务写成 pending 快照（快照副本，不依赖 storage 的克隆行为） */
async function savePendingFrom(tx: ActiveTransaction): Promise<boolean> {
  const snapshot: PendingTransaction = {
    runId: tx.runId,
    ops: structuredClone(tx.ops),
    containsDelete: tx.containsDelete,
    orderCheckpoints: [...tx.orderCheckpoints.entries()].map(([parentId, order]) => ({
      parentId,
      order: [...order],
    })),
    updatedAt: Date.now(),
  };
  return enqueuePendingWrite(async () => {
    try {
      await chrome.storage.local.set({ [UNDO_PENDING_KEY]: snapshot });
      return true;
    } catch {
      // 写不进 pending 不该影响书签操作本身（撤销点仍会在轮次结束时尝试落盘）
      return false;
    }
  });
}

/**
 * 把进行中的事务增量落盘（节流）。写的是**快照副本**——真实 storage 会结构化克隆，
 * 但这里不依赖那个行为，避免调用方后续改动数组影响到已写出的内容。
 *
 * 写入后会校验纪元：若期间事务已经结束/被清理，就补偿性删掉这次迟到写入。
 */
async function persistPending(force = false): Promise<void> {
  if (!active) return;
  const now = Date.now();
  const lagOps = active.ops.length - pendingWrittenOps;
  if (!force && lagOps < PENDING_MAX_LAG_OPS && now - pendingWrittenAt < PENDING_THROTTLE_MS) {
    // 本次跳过写入：安排尾随补写，保证"停下来"之后快照也能追上
    scheduleTrailingFlush();
    return;
  }
  cancelTrailingFlush();
  pendingWrittenAt = now;
  pendingWrittenOps = active.ops.length;
  const epoch = txEpoch;
  const snapshot: PendingTransaction = {
    runId: active.runId,
    ops: structuredClone(active.ops),
    containsDelete: active.containsDelete,
    orderCheckpoints: [...active.orderCheckpoints.entries()].map(([parentId, order]) => ({
      parentId,
      order: [...order],
    })),
    updatedAt: now,
  };
  await enqueuePendingWrite(async () => {
    let ok = false;
    try {
      await chrome.storage.local.set({ [UNDO_PENDING_KEY]: snapshot });
      ok = true;
    } catch {
      // 写不进 pending 不该影响书签操作本身
    }
    // 迟到写入：事务已经结束/被清理，删掉它刚写下的内容
    if (ok && epoch !== txEpoch) await removePendingKey();
  });
}

/** 记录一条可逆操作。没有活动事务时静默忽略（例如测试或非 Agent 触发的写入）。 */
export function recordOp(op: UndoOp): void {
  active?.ops.push(op);
  void persistPending();
}

/** 标记本轮包含删除（删除没有快照，撤销时必须拒绝而不是假装成功） */
export function markDelete(): void {
  if (active) {
    active.containsDelete = true;
    void persistPending(true);
  }
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
  cancelTrailingFlush();
  // 递增纪元：本事务**在途**的增量写入落地时会发现纪元已变，自行补偿删掉
  txEpoch += 1;
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
  const written = await writeUndoPoints(trim.kept, notice);
  if (!written.ok) {
    // 正式点没落盘：**保留（并补全）pending**，让下次启动仍能把它恢复出来。
    // 返回 null 而不是 point——写不进去就不算"已记录"，不能对调用方谎报成功。
    // 这是**刻意**的写入（savePendingFrom 不受纪元补偿约束），所以不会被误删。
    await savePendingFrom(tx);
    return null;
  }
  // 已正经收尾：清掉快照。此刻若还有**在途**写入，它落地时会发现纪元已变，自行补偿删除
  // （这条补偿是唯一的把关机制，因此它可以被反证单独证伪）
  await clearPending();
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
  // 递增纪元：在途的 pending 写入落地时会发现纪元已变，自行补偿删除
  // （否则它会在清空之后把快照复活，下次启动又变成撤销点）
  txEpoch += 1;
  await chrome.storage.local.remove(UNDO_STORAGE_KEY);
  // 进行中的快照也要清：否则下次启动会把它恢复成一个"用户以为已经清掉"的撤销点。
  // 如实说明边界：这里**不能**取消正在运行中的轮次——那一轮结束时仍会写下新的撤销点，
  // 这是刻意的语义（用户清的是"已有记录"，不是"正在进行的操作"）。
  await clearPending();
}

/** 取出并移除一个撤销点（不指定 id 时取最新的） */
export async function takeUndoPoint(id?: string): Promise<{ point: UndoPoint | null; removed: boolean }> {
  const state = await readUndoState();
  const points = state.points;
  const idx = id ? points.findIndex((p) => p.id === id) : 0;
  if (idx < 0 || idx >= points.length) return { point: null, removed: false };
  const point = points[idx] ?? null;
  // 不原地改读取到的数组：真实 storage 给的是副本，但"读到的值就地改"本身就是坏习惯
  const remaining = points.filter((_, i) => i !== idx);
  // 保留原有 notice：消费一个点不该抹掉"曾丢弃过更早点"的记录
  const written = await writeUndoPoints(remaining, state.notice);
  // 如实回报是否真的移除：消费失败时点仍在存储里，调用方据此阻止重复回放
  return { point, removed: written.ok };
}

/** 清除进行中事务的快照 */
async function clearPending(): Promise<void> {
  try {
    await chrome.storage.local.remove(UNDO_PENDING_KEY);
  } catch {
    // 清不掉最多是多一次无害的重复提升（提升逻辑会消费掉它）
  }
}

/** 仅测试用：丢弃内存中的活动事务（保留 pending 快照，用于模拟"进程被杀"） */
export function dropActiveForTest(): void {
  active = null;
}

/**
 * 把"被中断的轮次"提升为一个正常的撤销点（Service Worker 启动时调用）。
 *
 * 为什么放在启动时机：启动时能看到的 pending 必然来自**已经死掉的进程**——
 * 当前进程还没有开始任何轮次，因此不会误提升正在进行中的事务。这是这个方案
 * 不需要额外"心跳/存活标记"的原因。
 *
 * 没有 pending（或 pending 里没有任何写操作）时是空操作。
 */
export async function recoverInterruptedTransaction(): Promise<UndoPoint | null> {
  let pending: PendingTransaction | undefined;
  try {
    const data = await chrome.storage.local.get(UNDO_PENDING_KEY);
    pending = data[UNDO_PENDING_KEY] as PendingTransaction | undefined;
  } catch {
    return null;
  }
  if (!pending || !Array.isArray(pending.ops) || pending.ops.length === 0) {
    await clearPending();
    return null;
  }

  const state = await readUndoState();
  // 幂等：同一个事务（runId）已经提升过就不再造第二个点。
  // 覆盖"正式点写入成功、但 clearPending 失败"的情况——否则下次启动会把同一段改动
  // 再提升一次，出现两个都能被回放的点（删除类逆操作会重复重建子树）。
  const already = state.points.find((p) => p.runId === pending!.runId);
  if (already) {
    await clearPending();
    return null;
  }

  const point: UndoPoint = {
    id: uid(),
    runId: pending.runId,
    createdAt: pending.updatedAt || Date.now(),
    ops: pending.ops,
    ...(pending.orderCheckpoints?.length ? { orderCheckpoints: pending.orderCheckpoints } : {}),
    containsDelete: !!pending.containsDelete,
  };
  const trim = trimPointsToBudget([point, ...state.points].slice(0, MAX_UNDO_POINTS), budgetBytes);
  const written = await writeUndoPoints(
    trim.kept,
    `上一轮被中断，已把当时已完成的改动保留为可撤销记录（${summarizeOps(point.ops)}）`,
  );
  // 写失败时**保留 pending**，下次启动重试——绝不能在正式点落盘前就把它删掉
  if (!written.ok) return null;
  await clearPending();
  return point;
}
