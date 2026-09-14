/**
 * 操作日志的纯逻辑：摘要、可撤销性判定、逆序执行计划。
 *
 * 这里刻意不碰 `chrome.*`——它必须能在 node 测试里被直接证伪，
 * 而 chrome 依赖的部分放在 mutations.ts（也有替身测试覆盖）。
 */
import type { BookmarkSnapshot, UndoOp, UndoPoint } from './types';

const KIND_LABEL: Record<UndoOp['kind'], string> = {
  move: '移动',
  moveBatch: '移动',
  update: '修改',
  create: '新建',
  delete: '删除',
};

/**
 * 一条操作实际影响的书签条数。
 * 批次（moveBatch）算它包含的条数；删除算**子树节点数**（撤销会把这些节点都重建回来）——
 * 否则「清理掉 800 条」会在按钮上显示成「1 项」。
 */
export function opWeight(op: UndoOp): number {
  if (op.kind === 'moveBatch') return op.ids.length;
  if (op.kind === 'delete') return op.snapshot ? countSnapshotNodes(op.snapshot) : 1;
  return 1;
}

/** 快照里的节点总数（含自身） */
export function countSnapshotNodes(snap: BookmarkSnapshot): number {
  return 1 + (snap.children ?? []).reduce((acc, c) => acc + countSnapshotNodes(c), 0);
}

/** 按类型统计的中文摘要，如「移动 3 项、新建 2 项」（按影响条数计，不按操作条数） */
export function summarizeOps(ops: UndoOp[]): string {
  const order: UndoOp['kind'][] = ['move', 'moveBatch', 'update', 'create', 'delete'];
  const counts = new Map<UndoOp['kind'], number>();
  for (const op of ops) counts.set(op.kind, (counts.get(op.kind) ?? 0) + opWeight(op));
  const parts = order.filter((k) => counts.has(k)).map((k) => `${KIND_LABEL[k]} ${counts.get(k)} 项`);
  return parts.length > 0 ? parts.join('、') : '无写操作';
}

/** 撤销时执行顺序：严格逆序（先做的后撤） */
export function reverseOps(ops: UndoOp[]): UndoOp[] {
  return [...ops].reverse();
}

/** 真正可还原的操作：删除必须带快照（v0.2.3 及更早写下的历史日志点没有） */
export function undoableOps(ops: UndoOp[]): UndoOp[] {
  return ops.filter((op) => op.kind !== 'delete' || !!op.snapshot);
}

/** 不可还原的操作（历史日志点里的无快照删除） */
export function unrestorableOps(ops: UndoOp[]): UndoOp[] {
  return ops.filter((op) => op.kind === 'delete' && !op.snapshot);
}

export interface UndoReadiness {
  undoable: boolean;
  /** 不可撤销的原因（面向用户展示） */
  reason?: string;
  /** 将被还原的操作数 */
  count: number;
}

/**
 * 判定一个撤销点能不能撤。
 * - **历史日志点**（v0.2.3 及更早写下的、没有删除快照的 delete）：明确拒绝整轮，
 *   而不是"撤一半"再假装成功。新写入的删除都带快照，因此含删除的轮次现在**可以**撤销。
 * - 没有写操作：无事可做
 * - 已消费：不可重复撤销
 */
export function undoReadiness(point: UndoPoint | null | undefined): UndoReadiness {
  if (!point) return { undoable: false, reason: '没有可撤销的操作', count: 0 };
  if (point.appliedAt) return { undoable: false, reason: '该操作已撤销过', count: 0 };
  if (point.ops.length === 0) return { undoable: false, reason: '该操作没有可撤销的改动', count: 0 };
  // count 是**将还原的书签条数**（批次按条数、删除按子树节点数），不是操作条数——
  // 它直接显示在按钮角标上，用户看到的是"会动多少条书签"。
  const count = undoableOps(point.ops).reduce((acc, op) => acc + opWeight(op), 0);
  const legacy = unrestorableOps(point.ops);
  if (legacy.length > 0) {
    return {
      undoable: false,
      reason: `本次操作有 ${legacy.length} 条删除发生在旧版本（没有快照），无法还原，因此整轮不撤销`,
      count,
    };
  }
  return { undoable: true, count };
}

export interface UndoHistoryRow {
  id: string;
  /** 摘要，如「移动 3 项、新建 1 项」 */
  summary: string;
  /** 会被还原的书签条数（批次/删除按条数计） */
  count: number;
  createdAt: number;
  /** 不可撤销（如旧版本写下的无快照删除）时为 false，并给出原因 */
  undoable: boolean;
  reason?: string;
}

/**
 * 把撤销点渲染成「撤销历史」列表用的行（纯逻辑，可直接单测）。
 * 传入顺序即展示顺序（新在前）。
 */
export function describeUndoHistory(points: UndoPoint[]): UndoHistoryRow[] {
  return points.map((p) => {
    const ready = undoReadiness(p);
    return {
      id: p.id,
      summary: summarizeOps(p.ops),
      count: ready.count,
      createdAt: p.createdAt,
      undoable: ready.undoable,
      ...(ready.reason ? { reason: ready.reason } : {}),
    };
  });
}

/** 撤销点的展示标题：优先给摘要，空轮次给占位 */
export function describeUndoPoint(point: UndoPoint): string {
  return summarizeOps(point.ops);
}

/**
 * 撤销点占用的字节数。
 * 与 chrome.storage 的计量方式一致：对值做 JSON 序列化后的长度
 * （extensions/common/api/storage.json：local 的 QUOTA_BYTES = 10485760，
 * 「as measured by the JSON stringification of every value plus every key's length」）。
 */
export function pointBytes(point: UndoPoint): number {
  return JSON.stringify(point).length;
}

/**
 * 撤销点存储的总预算。
 *
 * 依据：`chrome.storage.local.QUOTA_BYTES = 10485760`（10 MiB，来自 Chromium 的
 * extensions/common/api/storage.json；只有申请 `unlimitedStorage` 才被忽略，
 * 而本扩展没申请）。`markai.undo` 与聊天记录（`markai.ai`）、配置共用这 10 MiB，
 * 所以给撤销点划 4 MiB，余下留给聊天与配置。
 */
export const UNDO_BUDGET_BYTES = 4 * 1024 * 1024;

export interface UndoTrimResult {
  kept: UndoPoint[];
  /** 单点就超过预算、根本放不下（硬留会让整块存储写失败） */
  droppedTooLarge: UndoPoint[];
  /** 预算被更新的点占满而挤出的（新的在前） */
  droppedNoRoom: UndoPoint[];
}

/**
 * 按字节预算裁剪撤销点（**新的在前**）。
 *
 * 规则刻意区分两种丢弃：
 * - 单点超过预算：**跳过它**，但不牵连其他点（否则一次超大操作会把所有撤销能力一起清空）；
 * - 预算不足：丢最旧的。
 * 调用方必须把丢弃如实告知用户——静默丢弃等于让「没有可撤销的操作」变成假话。
 */
export function trimPointsToBudget(
  points: UndoPoint[],
  budgetBytes: number = UNDO_BUDGET_BYTES,
): UndoTrimResult {
  const kept: UndoPoint[] = [];
  const droppedTooLarge: UndoPoint[] = [];
  const droppedNoRoom: UndoPoint[] = [];
  let total = 0;
  for (const p of points) {
    const size = pointBytes(p);
    if (size > budgetBytes) {
      droppedTooLarge.push(p);
      continue;
    }
    if (total + size <= budgetBytes) {
      kept.push(p);
      total += size;
    } else {
      droppedNoRoom.push(p);
    }
  }
  return { kept, droppedTooLarge, droppedNoRoom };
}

/** 把裁剪结果写成给用户看的一句话（无可说时返回 undefined） */
export function describeUndoTrim(result: UndoTrimResult): string | undefined {
  const parts: string[] = [];
  if (result.droppedTooLarge.length > 0) {
    const biggest = Math.max(...result.droppedTooLarge.map(pointBytes));
    parts.push(
      `有 ${result.droppedTooLarge.length} 次操作过大（约 ${(biggest / (1024 * 1024)).toFixed(1)} MB），未保留撤销记录`,
    );
  }
  if (result.droppedNoRoom.length > 0) {
    parts.push(`撤销记录空间已满，丢弃了 ${result.droppedNoRoom.length} 个更早的撤销点`);
  }
  return parts.length > 0 ? parts.join('；') : undefined;
}
