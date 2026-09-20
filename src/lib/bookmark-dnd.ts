/**
 * 书签拖放的两类判定（书签树与中栏列表共用，抽出来是为了能在 node 测试里直接证伪）：
 *  1. `resolveDropIndex` —— 拖拽落点 → `chrome.bookmarks.move` 的 index
 *  2. `isSelfOrDescendant` —— 文件夹不能移动/复制到自身或其子文件夹内
 */

type BNode = chrome.bookmarks.BookmarkTreeNode;

/**
 * 拖拽落点 → `chrome.bookmarks.move` 的 index。
 *
 * **直接返回落点，不做任何补偿。** 这一句是本文件存在的理由，改动前请先读完：
 *
 * Chromium 的 `index` 是「**移除源之前**」坐标系里的插入位置，浏览器自己会换算：
 *   components/bookmarks/browser/bookmark_model.cc, BookmarkModel::Move:
 *     if (old_parent == new_parent && (index == old_index || index == old_index + 1)) return; // 空操作
 *     if (old_parent == new_parent && index > old_index) index--;
 *   已核实 Chrome 120 / 126 / 138 / trunk 行为一致。
 *   chrome/browser/extensions/api/bookmarks/bookmarks_api.cc 把 index 原样透传给 Move。
 *
 * 换言之 index 就是「当前（未移除）列表里，我要插到第几个元素前面」。所以 UI 算出的
 * 落点必须原样传下去。**调用方若"顺手"减 1，向后拖一格会得到 index == old_index + 1，
 * 正好命中上面的空操作——拖拽静默失效**（本项目真实发生过，见 bookmark_model_unittest.cc
 * 的 MoveToSameParent：「Move to current_index + 1 is a no-op」）。
 *
 * @param rowIndex 目标行在当前列表中的下标
 * @param position 落在该行上方（插到它前面）还是下方（插到它后面）
 */
export function resolveDropIndex(rowIndex: number, position: 'above' | 'below'): number {
  const safe = Number.isFinite(rowIndex) ? Math.max(0, Math.floor(rowIndex)) : 0;
  return position === 'above' ? safe : safe + 1;
}

/** 目标 id 是否在 node 的子树内（不含 node 自身） */
export function subtreeContains(node: BNode, id: string, depth = 0): boolean {
  if (!id || depth > 64) return false;
  for (const child of node.children ?? []) {
    if (child.id === id || subtreeContains(child, id, depth + 1)) return true;
  }
  return false;
}

/**
 * 文件夹拖放的非法目标：拖拽源是文件夹，且目标就是它自身或其子文件夹。
 * 必须单独判「自身」——子树的递归只搜 children，查不到 dragNode 自己。
 * 书签（有 url）没有子树，永远不算非法目标。
 */
export function isSelfOrDescendant(
  dragNode: BNode | null | undefined,
  targetId: string | null | undefined,
): boolean {
  if (!dragNode || dragNode.url || !targetId) return false;
  return dragNode.id === targetId || subtreeContains(dragNode, targetId);
}
