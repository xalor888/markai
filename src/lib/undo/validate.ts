import type { UndoOp } from '@/lib/undo/types';

/**
 * ── 撤销点的结构校验（唯一来源） ──
 *
 * 为什么单独抽出来：
 * 「这条撤销点还能不能用」有两处在问——健康检查（报告）和修复器（决定删不删）。
 * 之前两边各写了一份实现，而且**两份的 kind 白名单都是错的**：
 * 只认 `move/update/create/remove/sort`，漏了真实的 `moveBatch` 与 `delete`
 * （`remove`/`sort` 反而不存在）。
 *
 * 后果不是"少报一次"这么轻：`dropCorruptUndo` 会按这份判断**直接删点**——
 * 任何含批量移动或删除的撤销点都会被当成"损坏"清掉，用户的撤销历史就这么没了。
 *
 * 所以这里只有一份实现，并且用编译期守卫把白名单钉死在 `UndoOp` 的类型上：
 * 以后给 UndoOp 加一个 kind 而忘了加到这里，**tsc 直接报错**，不会等到线上删数据。
 */

/** 全部合法的撤销操作 kind（顺序无关，仅为可读性排列） */
export const KNOWN_OP_KINDS = ['move', 'moveBatch', 'update', 'create', 'delete'] as const;

export type KnownOpKind = (typeof KNOWN_OP_KINDS)[number];

/**
 * 编译期守卫：白名单必须与 `UndoOp['kind']` **完全一致**。
 *
 * 多一个（写了不存在的 kind）或少一个（漏了新增的 kind）都会让
 * `AssertSame<...>` 变成 `never`，于是 "true 不能赋给 never" → 编译失败。
 */
type AssertSame<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _kindListMatchesType: AssertSame<UndoOp['kind'], KnownOpKind> = true;
// 仅为让上面的常量不被判为未使用；真正的价值在它的**类型**
void _kindListMatchesType;

const KNOWN_SET: ReadonlySet<string> = new Set(KNOWN_OP_KINDS);

/** 单个 op 是否是已知 kind */
export function isKnownOpKind(kind: unknown): kind is KnownOpKind {
  return typeof kind === 'string' && KNOWN_SET.has(kind);
}

/**
 * 一条撤销点是否结构完整、可以用。
 *
 * 刻意只校验「还原所需的最小信息」是否存在：
 *  - id / runId 是字符串；
 *  - ops 是数组，且每个 op 的 kind 都认识。
 *
 * 不去校验每个 op 的内部字段（fromIndex 之类）：那是各 op 自己的事，
 * 这里若写死，加字段时又要改两处——正是这次要消除的问题。
 */
export function isUsableUndoPoint(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  if (typeof p.id !== 'string' || p.id.length === 0) return false;
  if (typeof p.runId !== 'string') return false;
  if (!Array.isArray(p.ops)) return false;
  return p.ops.every((op) => {
    if (!op || typeof op !== 'object') return false;
    return isKnownOpKind((op as Record<string, unknown>).kind);
  });
}
