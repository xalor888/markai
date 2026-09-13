/**
 * 撤销执行器：把撤销点里的操作**逆序**还原。
 *
 * 这里刻意用裸的 `chrome.bookmarks.*`（不走 mutations.ts 的记录包装）——
 * 撤销自身不应该被记进操作日志，否则「撤销的撤销」会变成一个绕不开的循环。
 *
 * 逆序执行是正确性的关键：撤销第 k 步时，书签库的状态等于第 k 步刚执行完的状态，
 * 于是「移回原父目录的原子下标」才是准确的（Chromium 的 index 语义见 bookmark-dnd.ts）。
 */
import { reverseOps, undoReadiness } from './journal';
import { readUndoPoints, takeUndoPoint } from './recorder';
import type { UndoApplyResult, UndoOp } from './types';

/** 执行一条逆操作。节点已不存在视为「已还原」（用户可能已经手动删掉了）。 */
async function applyOne(op: UndoOp): Promise<void> {
  switch (op.kind) {
    case 'create': {
      const nodes = await chrome.bookmarks.get(op.id).catch(() => []);
      if (nodes.length === 0) return;
      if (op.isFolder) await chrome.bookmarks.removeTree(op.id);
      else await chrome.bookmarks.remove(op.id);
      return;
    }
    case 'move': {
      const nodes = await chrome.bookmarks.get(op.id).catch(() => []);
      const node = nodes[0];
      if (!node) return;
      // 还原到「移除源之后」的第 fromIndex 位。Chromium 的 index 却是「移除源之前」的坐标，
      // 因此同父目录还原时必须换算：节点当前在同父列表中的下标为 c、目标位为 p 时，
      //   p <  c → 传 p（浏览器内部插到 p）
      //   p >= c → 传 p+1（浏览器内部减 1 后插到 p）
      // 直接回放 fromIndex 会在 p >= c 时命中 index == oldIndex + 1 的空操作，
      // 表现为「排序撤销后顺序还原错位」——这是实测抓到的 bug，勿简化。
      let index = op.fromIndex;
      if (node.parentId === op.fromParentId) {
        const siblings = await chrome.bookmarks.getChildren(op.fromParentId).catch(() => []);
        const currentIndex = siblings.findIndex((s) => s.id === op.id);
        if (currentIndex >= 0 && op.fromIndex >= currentIndex) index = op.fromIndex + 1;
      }
      await chrome.bookmarks.move(op.id, { parentId: op.fromParentId, index });
      return;
    }
    case 'update': {
      const nodes = await chrome.bookmarks.get(op.id).catch(() => []);
      if (nodes.length === 0) return;
      await chrome.bookmarks.update(op.id, op.before);
      return;
    }
    case 'delete':
      // undoReadiness 已拦下含删除的轮次；真走到这里说明日志被改坏了，如实报错
      throw new Error('删除操作没有快照，无法撤销');
  }
}

/**
 * 撤销指定（默认最新）的撤销点，并消费掉它。
 * 即使部分失败也会消费——避免"半撤销"状态在下次点击时被反复套用。
 */
export async function applyUndo(id?: string): Promise<UndoApplyResult> {
  const points = await readUndoPoints();
  const target = id ? points.find((p) => p.id === id) : points[0];
  const ready = undoReadiness(target);
  if (!target || !ready.undoable) {
    return { ok: false, ...(ready.reason ? { reason: ready.reason } : {}), restored: 0, failures: [] };
  }

  const failures: UndoApplyResult['failures'] = [];
  let restored = 0;
  for (const op of reverseOps(target.ops)) {
    if (op.kind === 'delete') continue;
    try {
      await applyOne(op);
      restored++;
    } catch (e) {
      failures.push({ op: op.kind, title: op.title, error: e instanceof Error ? e.message : String(e) });
    }
  }
  await takeUndoPoint(target.id);
  return { ok: failures.length === 0, restored, failures };
}
