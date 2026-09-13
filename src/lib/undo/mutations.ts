/**
 * 带记录的写操作包装：替换 tools.ts 里对 `chrome.bookmarks.*` 的直接调用。
 *
 * 每个包装都遵循同一套顺序：**先取还原所需的状态 → 再动手 → 再记日志**。
 * 顺序反了就会记到错的值（例如移动后再读下标，读到的是新位置），
 * 这类错误在测试里表现为「撤销后顺序不对」，必须能被证伪。
 */
import { markDelete, recordOp } from './recorder';

/** 新建（文件夹或书签）：撤销 = 删掉新建出来的节点 */
export async function jCreate(opt: {
  parentId?: string;
  title: string;
  url?: string;
  index?: number;
}): Promise<chrome.bookmarks.BookmarkTreeNode> {
  const node = await chrome.bookmarks.create(opt);
  recordOp({ kind: 'create', id: node.id, title: node.title || '(未命名)', isFolder: !node.url });
  return node;
}

/** 移动：撤销 = 移回原父目录的原子下标 */
export async function jMove(
  id: string,
  dest: { parentId: string; index?: number },
): Promise<chrome.bookmarks.BookmarkTreeNode> {
  // 旧父目录与下标必须在移动**之前**读取
  const nodes = await chrome.bookmarks.get(id).catch(() => []);
  const node = nodes[0];
  let fromParentId: string | undefined;
  let fromIndex = -1;
  if (node?.parentId) {
    fromParentId = node.parentId;
    const siblings = await chrome.bookmarks.getChildren(node.parentId).catch(() => []);
    fromIndex = siblings.findIndex((s) => s.id === id);
  }
  const moved = await chrome.bookmarks.move(id, dest);
  if (node && fromParentId !== undefined && fromIndex >= 0) {
    recordOp({
      kind: 'move',
      id,
      title: node.title || '(未命名)',
      fromParentId,
      fromIndex,
    });
  }
  return moved;
}

/** 改标题 / 改 URL：撤销 = 写回旧值（只记真正被改动的字段） */
export async function jUpdate(
  id: string,
  changes: { title?: string; url?: string },
): Promise<chrome.bookmarks.BookmarkTreeNode> {
  const nodes = await chrome.bookmarks.get(id).catch(() => []);
  const prev = nodes[0];
  const before: { title?: string; url?: string } = {};
  if (changes.title !== undefined) before.title = prev?.title ?? '';
  if (changes.url !== undefined) before.url = prev?.url ?? '';
  const updated = await chrome.bookmarks.update(id, changes);
  if (Object.keys(before).length > 0) {
    recordOp({ kind: 'update', id, title: prev?.title || '(未命名)', before });
  }
  return updated;
}

/**
 * 删除：**不可逆**（没有子树快照）。把本轮标记为「含删除」，撤销时会明确拒绝整轮，
 * 而不是只撤一半再假装成功。
 *
 * 顺序上刻意「先删成功、再记日志」：删除失败时不该在摘要里出现一条并不存在的删除，
 * 也不该把一整轮误判成不可撤销（调用方可能带重试）。
 */
export async function jRemove(id: string, opts: { tree?: boolean } = {}): Promise<void> {
  const nodes = await chrome.bookmarks.get(id).catch(() => []);
  const title = nodes[0]?.title || '(未命名)';
  if (opts.tree) await chrome.bookmarks.removeTree(id);
  else await chrome.bookmarks.remove(id);
  markDelete();
  recordOp({ kind: 'delete', id, title });
}
