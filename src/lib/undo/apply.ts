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
import type { BookmarkSnapshot, UndoApplyResult, UndoOp, UndoPoint } from './types';

/**
 * 本 SW 会话内"已执行但未能消费掉"的撤销点 id。
 *
 * 为什么需要：消费写入失败时原点会留在存储里，UI 刷新后它还在列表里，
 * 用户再点一次就会**重复回放**（删除类逆操作重复重建子树）。这里在会话内堵住这条路；
 * 跨会话（SW 被回收后重启）这道内存保护会消失——这是仍存在的残留风险，已写进文档。
 */
const appliedThisSession = new Set<string>();

/**
 * 把某个父目录的子项顺序校正为 `order`：
 * 在 `order` 里出现过的节点按原序排前面，其余（本轮新建的）留在末尾。
 * 用于 moveBatch 与删除的顺序检查点——两者都不依赖逐条下标，因此抗并发。
 */
async function restoreParentOrder(parentId: string, order: string[]): Promise<void> {
  const current = await chrome.bookmarks.getChildren(parentId).catch(() => []);
  const orderSet = new Set(order);
  const present = new Set(current.map((n) => n.id));
  const target = [
    ...order.filter((id) => present.has(id)),
    ...current.filter((n) => !orderSet.has(n.id)).map((n) => n.id),
  ];
  const mirror = current.map((n) => n.id); // 本地镜像，避免每个位置都重新 getChildren
  for (let i = 0; i < target.length; i++) {
    const at = mirror.indexOf(target[i]!);
    if (at < 0 || at === i) continue;
    // Chromium 的 index 是「移除源之前」坐标：要落到第 i 位，移除源之后才是 i
    const index = i >= at ? i + 1 : i;
    await chrome.bookmarks.move(target[i]!, { parentId, index });
    mirror.splice(at, 1);
    mirror.splice(i, 0, target[i]!);
  }
}

/** 按快照递归重建子树，返回新建节点的 id */
async function restoreSubtree(snap: BookmarkSnapshot, parentId: string, index?: number): Promise<string> {
  const node = await chrome.bookmarks.create({
    parentId,
    title: snap.title,
    ...(snap.url ? { url: snap.url } : {}),
    ...(index !== undefined ? { index } : {}),
  });
  for (const child of snap.children ?? []) {
    await restoreSubtree(child, node.id);
  }
  return node.id;
}

/** 一个"撤销新建文件夹会顺带删掉后来内容"的冲突 */
interface FolderRemovalConflict {
  folderId: string;
  title: string;
  /** 不会被本点自己的逆操作移出、因而会被误删的子项 */
  survivingChildIds: string[];
}

/**
 * **只读预检**：找出那些"撤销后会把不该删的内容一起删掉"的文件夹 create 逆操作。
 *
 * 为什么需要：`create` 的文件夹逆操作是删除该文件夹。如果这个文件夹在**本轮之外**
 * （用户手工、另一个窗口、或未被记账的移动）被放进了内容，删除就会连带毁掉那些内容，
 * 而本轮的快照里根本没有它们——不可恢复。
 *
 * 判定：列出文件夹**当前**的子项，排除掉"本点自己的逆操作会先处理掉"的那些：
 *   - 由本点的 `create` 创建的节点：逆序回放会先把它删掉；
 *   - 由本点的 `move` / `moveBatch` 移出该文件夹的节点（`fromParentId !== 该文件夹`）：
 *     逆序回放会先把它移回原处。
 * 剩下的子项就是"来路不明、删了就没了"的内容 → 冲突，必须零副作用拒绝并**保留**撤销点。
 *
 * 注意：同一轮里"创建 F 再把 X 移入 F"是**正常**的，不构成冲突——X 会被本点自己的
 * move 逆操作先移出，所以这里必须按 op 语义排除，不能简单地把"文件夹非空"当冲突。
 *
 * 顺序安全性：这些"会被处理掉"的子项对应的 op 必然发生在 create F **之后**（否则 F 还不存在），
 * 因此逆序回放时它们一定排在"删除 F"**之前**——不会出现"删 F 时子项还在"的窗口。
 */
async function findFolderRemovalConflicts(point: UndoPoint): Promise<FolderRemovalConflict[]> {
  const conflicts: FolderRemovalConflict[] = [];
  for (const op of point.ops) {
    if (op.kind !== 'create' || !op.isFolder) continue;
    const folderId = op.id;
    const nodes = await chrome.bookmarks.get(folderId).catch(() => []);
    if (nodes.length === 0) continue; // 已经不存在：交给回放按幂等处理
    const children = await chrome.bookmarks.getChildren(folderId).catch(() => []);
    if (children.length === 0) continue;

    const willBeHandled = new Set<string>();
    for (const other of point.ops) {
      if (other.kind === 'create') {
        willBeHandled.add(other.id); // 回放会先把它删掉
      } else if (other.kind === 'move' && other.fromParentId !== folderId) {
        willBeHandled.add(other.id); // 回放会先把它移回 fromParentId
      } else if (other.kind === 'moveBatch' && other.fromParentId !== folderId) {
        for (const id of other.ids) willBeHandled.add(id);
      }
    }
    const surviving = children.map((c) => c.id).filter((id) => !willBeHandled.has(id));
    if (surviving.length > 0) conflicts.push({ folderId, title: op.title, survivingChildIds: surviving });
  }
  return conflicts;
}

/** 执行一条逆操作。节点已不存在视为「已还原」（用户可能已经手动删掉了）。 */
async function applyOne(op: UndoOp, idMap: Map<string, string>): Promise<void> {
  switch (op.kind) {
    case 'create': {
      const nodes = await chrome.bookmarks.get(op.id).catch(() => []);
      if (nodes.length === 0) return;
      // 一律用**非递归** remove：文件夹若还含子项，Chrome 会拒绝，于是它变成一条如实上报的
      // failure，而不是把用户后来放进去的内容一起递归删掉。真正的零副作用拦截在
      // findFolderRemovalConflicts（回放前的只读预检），这里是纵深防御。
      await chrome.bookmarks.remove(op.id);
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
    case 'delete': {
      // 历史日志点（v0.2.3 及更早写下的）没有快照：必须如实报错，不能假装还原成功。
      // undoReadiness 通常已经拦下这类点，这里是第二道闸。
      if (!op.snapshot) throw new Error('该删除操作没有快照（旧版本写下的日志），无法还原');
      if (!op.parentId) throw new Error(`找不到「${op.title}」的原文件夹，无法还原`);
      const parent = await chrome.bookmarks.get(op.parentId).catch(() => []);
      if (!parent[0]) throw new Error(`原文件夹已不存在，无法还原「${op.title}」`);
      // 位置：先按兜底下标放进去；整轮的顺序最后由 orderCheckpoints 统一校正。
      // 必须登记 old→new：删除的原节点 id 已经不存在，重建出来的是**新 id**，
      // 而顺序检查点里存的是**旧 id**——不映射的话检查点会对不上，顺序还原直接失效。
      const newId = await restoreSubtree(op.snapshot, op.parentId, op.index);
      idMap.set(op.id, newId);
      return;
    }
    case 'moveBatch': {
      // 1) 先把这批节点全部搬回源文件夹（此刻顺序无所谓，下一步统一校正）
      for (const id of op.ids) {
        const nodes = await chrome.bookmarks.get(id).catch(() => []);
        const node = nodes[0];
        if (!node) continue;
        if (node.parentId !== op.fromParentId) {
          await chrome.bookmarks.move(id, { parentId: op.fromParentId });
        }
      }
      // 2) 把源文件夹的子项顺序还原成批次开始前的样子
      //    （批次记录自带完整子序，所以不依赖逐条下标——这正是并发批量移动能安全撤销的原因）
      await restoreParentOrder(op.fromParentId, op.order);
      return;
    }
    case 'update': {
      const nodes = await chrome.bookmarks.get(op.id).catch(() => []);
      if (nodes.length === 0) return;
      await chrome.bookmarks.update(op.id, op.before);
      return;
    }
  }
}

/**
 * 撤销指定（默认最新）的撤销点，并消费掉它。
 *
 * 部分操作失败**仍会尝试消费**——避免"半撤销"状态在下次点击时被反复套用。
 * 但消费本身失败时**不能报成功**：原撤销点还在存储里，再点一次就会重复回放，
 * 而删除类逆操作会重复重建子树（造出重复书签）。
 */
export async function applyUndo(id?: string): Promise<UndoApplyResult> {
  const points = await readUndoPoints();
  const target = id ? points.find((p) => p.id === id) : points[0];
  // 指定了 id 却找不到：说明这个撤销点已经不在了（多半是另一个窗口刚撤过）。
  // 必须如实说明「你点的那个没了」，**不能**退化成「那就撤最新的那个」——
  // 那会撤销一个用户没点过的操作，比失败更糟。
  if (id && !target) {
    return {
      ok: false,
      reason: appliedThisSession.has(id)
        ? '这条撤销刚刚已经执行过，但本地记录没能更新；重复执行会造成重复改动，已拒绝。'
        : '该操作已不存在（可能已在另一个窗口撤销过，或已被更新的一轮挤出保留范围）',
      restored: 0,
      failures: [],
    };
  }
  const ready = undoReadiness(target);
  if (!target || !ready.undoable) {
    return { ok: false, ...(ready.reason ? { reason: ready.reason } : {}), restored: 0, failures: [] };
  }
  // 同一 SW 会话内已经执行过、但消费失败的点：再执行一次会重复改动，直接拒绝
  if (appliedThisSession.has(target.id)) {
    return {
      ok: false,
      reason: '这条撤销刚刚已经执行过，但本地记录没能更新；重复执行会造成重复改动，已拒绝。',
      restored: 0,
      failures: [],
    };
  }

  // ── 撤销栈只能从**最新点**往下撤（安全边界，不是 UI 便利）──
  //
  // 为什么必须在这里拦：把较早的点当成"历史状态跳转"是错的。本函数只逆转**该点自己的**操作，
  // 并不会回退更晚的点；而"撤销新建文件夹"用的是 removeTree（无条件递归删除），于是
  // 「A 新建 F → B 把已有书签 X 移入 F → 跳选撤 A」会连 X 一起删掉，而 A 的快照里没有 X。
  // 必须在任何 chrome.bookmarks.*、顺序还原与 takeUndoPoint 之前拒绝——零副作用。
  // 客户端禁用只是提示：手工调用、旧客户端、多窗口都能绕过 UI，所以安全边界必须在这里。
  if (id && target.id !== points[0]?.id) {
    return {
      ok: false,
      reason: '请先撤销较新的操作（撤销只能从最新一步开始，按时间从新到旧依次回退）',
      restored: 0,
      failures: [],
    };
  }

  // ── 只读预检：撤销新建文件夹会不会顺带删掉后来放进去的内容 ──
  //
  // 必须在**任何**书签写入、顺序还原与消费之前。冲突时零副作用拒绝并**保留**撤销点，
  // 让用户先把内容移走再重试——而不是递归删除，也不是把点消费掉让他失去重试机会。
  const conflicts = await findFolderRemovalConflicts(target);
  if (conflicts.length > 0) {
    const detail = conflicts
      .map((c) => `「${c.title}」里还有 ${c.survivingChildIds.length} 项内容`)
      .join('；');
    return {
      ok: false,
      reason: `${detail}。自动撤销不会连带删除这些内容，请先把它们移到别处再撤销。`,
      restored: 0,
      failures: [],
    };
  }

  const failures: UndoApplyResult['failures'] = [];
  const idMap = new Map<string, string>(); // 删除还原后的 old→new id 映射（供顺序检查点使用）
  let restored = 0;
  for (const op of reverseOps(target.ops)) {
    try {
      await applyOne(op, idMap);
      restored++;
    } catch (e) {
      failures.push({ op: op.kind, title: op.title, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // 最后按检查点校正父目录顺序：并发删除/移动期间逐条下标不可靠，
  // 而"动手前的完整子序"是可靠的。放在所有操作还原之后——
  // 此时本轮新建的节点已被各自的 create 逆操作删除，剩下的正好该按原序排列。
  for (const cp of target.orderCheckpoints ?? []) {
    try {
      // 检查点里是**删除前**的旧 id，先翻译成本轮重建出来的新 id
      await restoreParentOrder(
        cp.parentId,
        cp.order.map((id) => idMap.get(id) ?? id),
      );
    } catch (e) {
      failures.push({
        op: 'move',
        title: `还原「${cp.parentId}」内的顺序`,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  // 消费这个撤销点：**必须确认真的消费掉了**。写失败时原点还在存储里，
  // 再点一次就会重复回放（删除类逆操作会重复重建子树），所以要如实报失败并堵住本会话的重复调用。
  let consumed = await takeUndoPoint(target.id);
  if (!consumed.removed) {
    // 先重试一次：瞬时失败（限流/竞态）常常一次就好
    consumed = await takeUndoPoint(target.id);
  }
  if (!consumed.removed) {
    appliedThisSession.add(target.id);
    return {
      ok: false,
      reason:
        '撤销已执行，但本地记录没能更新（存储写入失败）：请不要重复点击这条撤销，重复执行会造成重复改动。刷新后该记录可能仍在，届时可再次尝试。',
      restored,
      failures,
    };
  }
  appliedThisSession.delete(target.id); // 正常消费：解除本会话的重复保护
  return { ok: failures.length === 0, restored, failures };
}