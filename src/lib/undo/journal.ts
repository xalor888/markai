/**
 * 操作日志的纯逻辑：摘要、可撤销性判定、逆序执行计划。
 *
 * 这里刻意不碰 `chrome.*`——它必须能在 node 测试里被直接证伪，
 * 而 chrome 依赖的部分放在 mutations.ts（也有替身测试覆盖）。
 */
import type { UndoOp, UndoPoint } from './types';

const KIND_LABEL: Record<UndoOp['kind'], string> = {
  move: '移动',
  update: '修改',
  create: '新建',
  delete: '删除',
};

/** 按类型统计的中文摘要，如「移动 3 项、新建 2 项」 */
export function summarizeOps(ops: UndoOp[]): string {
  const order: UndoOp['kind'][] = ['move', 'update', 'create', 'delete'];
  const counts = new Map<UndoOp['kind'], number>();
  for (const op of ops) counts.set(op.kind, (counts.get(op.kind) ?? 0) + 1);
  const parts = order.filter((k) => counts.has(k)).map((k) => `${KIND_LABEL[k]} ${counts.get(k)} 项`);
  return parts.length > 0 ? parts.join('、') : '无写操作';
}

/** 撤销时执行顺序：严格逆序（先做的后撤） */
export function reverseOps(ops: UndoOp[]): UndoOp[] {
  return [...ops].reverse();
}

/** 真正可还原的操作（排除删除——删除没有快照） */
export function undoableOps(ops: UndoOp[]): UndoOp[] {
  return ops.filter((op) => op.kind !== 'delete');
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
 * - 含删除：删除没有子树快照，**明确拒绝**而不是只撤一半假装成功（DIRECTION §4A）
 * - 没有写操作：无事可做
 * - 已消费：不可重复撤销
 */
export function undoReadiness(point: UndoPoint | null | undefined): UndoReadiness {
  if (!point) return { undoable: false, reason: '没有可撤销的操作', count: 0 };
  if (point.appliedAt) return { undoable: false, reason: '该操作已撤销过', count: 0 };
  if (point.ops.length === 0) return { undoable: false, reason: '该操作没有可撤销的改动', count: 0 };
  if (point.containsDelete) {
    return {
      undoable: false,
      reason: '本次操作包含删除，无法完整撤销（删除需走确认流程，且没有快照）',
      count: undoableOps(point.ops).length,
    };
  }
  return { undoable: true, count: point.ops.length };
}

/** 撤销点的展示标题：优先给摘要，空轮次给占位 */
export function describeUndoPoint(point: UndoPoint): string {
  return summarizeOps(point.ops);
}
