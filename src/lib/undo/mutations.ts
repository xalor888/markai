/**
 * 带记录的写操作包装：替换 tools.ts 里对 `chrome.bookmarks.*` 的直接调用。
 *
 * 每个包装都遵循同一套顺序：**先取还原所需的状态 → 再动手 → 再记日志**。
 * 顺序反了就会记到错的值（例如移动后再读下标，读到的是新位置），
 * 这类错误在测试里表现为「撤销后顺序不对」，必须能被证伪。
 */
import { markDelete, recordOp } from './recorder';
import type { BookmarkSnapshot } from './types';

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
 * 记录一条**并发批量移动**（整批一条，替代逐条 jMove 埋点）。
 *
 * 调用方必须在动手前拿到源文件夹的完整子序 `order`（工具本来就会先 getChildren）。
 * 逐条埋点在并发下记录的是互相矛盾的下标——每个 worker 读到的是别人正在修改的列表，
 * 那组下标不构成任何一致的串行历史，撤销后顺序必然错乱（5000 节点规模测试实测到过）。
 *
 * 调用方用裸 `chrome.bookmarks.move` 执行这批移动（不要再走 jMove，否则会重复记录）。
 */
export function recordMoveBatch(params: {
  fromParentId: string;
  ids: string[];
  order: string[];
  title?: string;
}): void {
  if (params.ids.length === 0) return;
  recordOp({
    kind: 'moveBatch',
    title: params.title ?? `${params.ids.length} 项`,
    fromParentId: params.fromParentId,
    ids: [...params.ids],
    order: [...params.order],
  });
}

/** 把一个节点（含全部后代）转成可持久化的快照 */
function toSnapshot(node: chrome.bookmarks.BookmarkTreeNode): BookmarkSnapshot {
  return {
    title: node.title,
    ...(node.url ? { url: node.url } : {}),
    ...(node.children?.length ? { children: node.children.map(toSnapshot) } : {}),
  };
}

/** 删除前要抓住的还原信息（必须在真正删除**之前**取） */
async function captureForDelete(id: string): Promise<{
  title: string;
  parentId?: string;
  index?: number;
  snapshot?: BookmarkSnapshot;
} | null> {
  const sub = await chrome.bookmarks.getSubTree(id).catch(() => []);
  const node = sub[0];
  if (!node) return null;
  let parentId: string | undefined;
  let index: number | undefined;
  if (node.parentId) {
    parentId = node.parentId;
    const siblings = await chrome.bookmarks.getChildren(node.parentId).catch(() => []);
    const at = siblings.findIndex((s) => s.id === id);
    if (at >= 0) index = at; // 仅作兜底；并发下不可靠，位置靠 orderCheckpoints
  }
  return { title: node.title || '(未命名)', parentId, index, snapshot: toSnapshot(node) };
}

/**
 * 删除：**可逆**（靠删除前的子树快照还原内容，靠调用方预先取的父目录顺序检查点还原位置）。
 *
 * 顺序上刻意「先抓快照 → 再删 → 成功后才记日志」：
 * 抓不到快照就不该声称可撤销；删除失败时也不该在摘要里出现一条并不存在的删除
 * （调用方 cleanup_sweep 带重试）。
 *
 * 调用方**必须**在批量删除前对每个将失去子项的父目录调用 `ensureOrderCheckpoint()`
 * ——并发删除的逐条下标与位置锚点都不可靠（后者实测栽过）。
 */
export async function jRemove(id: string, opts: { tree?: boolean } = {}): Promise<void> {
  const captured = await captureForDelete(id);
  if (opts.tree) await chrome.bookmarks.removeTree(id);
  else await chrome.bookmarks.remove(id);
  markDelete();
  recordOp({
    kind: 'delete',
    id,
    title: captured?.title ?? '(未命名)',
    ...(captured?.parentId ? { parentId: captured.parentId } : {}),
    ...(captured?.index !== undefined ? { index: captured.index } : {}),
    ...(captured?.snapshot ? { snapshot: captured.snapshot } : {}),
  });
}
