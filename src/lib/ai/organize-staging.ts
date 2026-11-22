/**
 * ── 整理暂存区（先预演，再落位）──
 *
 * 为什么要有它：Agent 整理某个文件夹时，过去是**直接往用户的库里写**——
 * 建分类、搬书签，一步到位。做对了很好，做得不合口味就是"整理完比不整理还乱"，
 * 而用户只能整轮撤销（把可能已经做对的那些也一起撤掉）。
 *
 * 现在多一层：整理先发生在书签栏下的「自动整理」暂存区里，
 *
 *   自动整理 / 软件工具 / 开发工具 / <书签…>
 *
 * 用户看得到真实结构（不是一张示意图），确认后再把分类**搬进**目标文件夹——
 * 也可以选择直接搬到书签栏，或用「其他文件夹」挑任意落点。不满意就放弃，书签回原位。
 *
 * 三条设计约束：
 *  1. **暂存区在书签树里是真实存在的**：Chrome 书签没有虚拟文件夹，只有物理结构
 *     才能在树里拖、在列表里看。代价是放弃时要清理干净（见 discardBatch）。
 *  2. **批次以「被整理的文件夹名」命名**：同一个文件夹整理两次会并进同一批，
 *     而不是堆出「软件工具 (2)」这种只有程序能看懂的名字。
 *  3. **落位是用户显式确认后的动作**：如果它发生在 Agent 轮次事务里，移动会记入那一轮；
 *     平时的界面操作则按普通书签操作处理（不额外伪造一个撤销点）。
 */

import { jMove, jRemove, jCreate } from '@/lib/undo/mutations';

/** 暂存区标题（书签栏根下的那一个） */
export const STAGING_TITLE = '自动整理';
/** 待应用批次元信息的存储键（书签结构才是事实，这里只存"这批是从哪来的"） */
export const STAGED_KEY = 'markai.organize.staged';

export interface StagedBatch {
  /** 批次节点 id（`自动整理/<文件夹名>`） */
  batchId: string;
  /** 批次标题 = 被整理的文件夹名 */
  title: string;
  /** 这批是从哪个文件夹整理出来的（放弃时书签回到这里） */
  targetParentId: string;
  targetTitle: string;
  createdAt: number;
}

interface StoredShape {
  batches: StagedBatch[];
  /**
   * 我们真正创建的那个暂存根 id。
   *
   * 只靠标题「自动整理」找根是不够的：用户完全可能在书签栏里自己建一个同名文件夹。
   * 早期版本就是按标题认领，于是会往用户的文件夹里塞批次，甚至在它变空后删掉它。
   * 存 id 之后，"我们的"与"用户的"永远分得开。
   */
  rootId?: string;
}

const clip = (s: string, max = 120): string => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** 书签栏根 id（虚拟根的第一个子项） */
export async function bookmarkBarId(): Promise<string> {
  const tree = await chrome.bookmarks.getTree();
  const bar = tree[0]?.children?.find((c) => c.id === '1') ?? tree[0]?.children?.[0];
  if (!bar) throw new Error('无法定位书签栏');
  return bar.id;
}

/**
 * 找暂存根（不存在返回 null）。
 *
 * **先认 id，再认标题**：用户完全可能自己在书签栏里建一个叫「自动整理」的文件夹。
 * 早期版本按标题认领，会往用户的文件夹里塞批次，甚至在它变空后把它删掉。
 * 现在只认我们写入 `rootId` 的那个；标题兜底仅用于旧元信息（已有批次、且批次父级同名）
 * 的升级迁移，绝不会凭"看起来像"就接管用户的东西。
 */
export async function findStagingRoot(): Promise<string | null> {
  const stored = await readStored();
  if (stored.rootId) {
    const nodes = await chrome.bookmarks.get(stored.rootId).catch(() => []);
    const node = nodes[0];
    if (node && !node.url) return node.id;
    // 根被用户删了：清掉陈旧 id，下一次整理会重新建一个
    await writeStored({ ...stored, rootId: undefined });
  }
  if (stored.batches.length > 0) {
    const first = await chrome.bookmarks.get(stored.batches[0]!.batchId).catch(() => []);
    const node = first[0];
    if (node?.parentId) {
      const parent = await chrome.bookmarks.get(node.parentId).catch(() => []);
      const p = parent[0];
      if (p && !p.url && (p.title || '').trim() === STAGING_TITLE) {
        await writeStored({ ...stored, rootId: p.id });
        return p.id;
      }
    }
  }
  return null;
}

/**
 * 取得（必要时创建）暂存根。
 *
 * 只在我们**自己创建**的那个文件夹里工作；用户同名文件夹不会被混用。
 * 新建后立刻把 id 落盘：进程被杀也不会在下次误认一个同名文件夹。
 */
export async function ensureStagingRoot(): Promise<string> {
  const existing = await findStagingRoot();
  if (existing) return existing;
  const bar = await bookmarkBarId();
  const node = await jCreate({ parentId: bar, title: STAGING_TITLE });
  const stored = await readStored();
  await writeStored({ ...stored, rootId: node.id });
  return node.id;
}

async function readStored(): Promise<StoredShape> {
  try {
    const data = await chrome.storage.local.get(STAGED_KEY);
    const raw = data[STAGED_KEY] as StoredShape | undefined;
    if (raw && Array.isArray(raw.batches)) {
      return {
        batches: raw.batches.filter((b) => b && typeof b.batchId === 'string'),
        ...(typeof raw.rootId === 'string' && raw.rootId ? { rootId: raw.rootId } : {}),
      };
    }
  } catch {
    // 读不到就当没有：暂存元信息丢了也不该让整理流程报错
  }
  return { batches: [] };
}

async function writeStored(shape: StoredShape): Promise<void> {
  try {
    await chrome.storage.local.set({ [STAGED_KEY]: shape });
  } catch {
    // 写失败不影响书签结构；UI 会因"找不到元信息"而不显示这张卡片，不会误导
  }
}

/**
 * 列出**仍然有效**的待应用批次。
 *
 * 「有效」= 元信息存在 **且** 批次节点还在树上。用户在树里手动删掉暂存文件夹后，
 * 卡片必须自己消失——否则点「应用」会得到一个"文件不存在"的报错。
 */
export async function listBatches(): Promise<StagedBatch[]> {
  const stored = await readStored();
  const alive: StagedBatch[] = [];
  for (const b of stored.batches) {
    const nodes = await chrome.bookmarks.get(b.batchId).catch(() => []);
    if (nodes[0] && !nodes[0].url) alive.push(b);
  }
  if (alive.length !== stored.batches.length) await writeStored({ ...stored, batches: alive });
  return alive;
}

/**
 * 只返回**已经有内容**的待确认批次。
 *
 * 为什么不能直接数 listBatches()：Agent 刚开批次、还没往里放东西时，
 * 顶栏会显示"待确认整理 1"，点进去却因为空批次不展示而什么都没有。
 * 空批次在界面上什么都不是——除非它已经有分类或书签。
 */
export async function listPendingBatches(): Promise<StagedBatch[]> {
  const batches = await listBatches();
  const out: StagedBatch[] = [];
  for (const batch of batches) {
    const stats = await batchStats(batch.batchId).catch(() => ({ folders: 0, bookmarks: 0 }));
    if (stats.folders + stats.bookmarks > 0) out.push(batch);
  }
  return out;
}

/** 目标文件夹所属的根（书签栏 / 其他书签 / 移动设备），用于同名批次消歧 */
async function rootTitleOf(folderId: string): Promise<string> {
  let id: string | undefined = folderId;
  for (let depth = 0; depth < 64 && id; depth += 1) {
    const nodes: chrome.bookmarks.BookmarkTreeNode[] = await chrome.bookmarks.get(id).catch(() => []);
    const node: chrome.bookmarks.BookmarkTreeNode | undefined = nodes[0];
    if (!node) return '书签栏';
    if (!node.parentId || node.parentId === '0') return (node.title || '').trim() || '书签栏';
    id = node.parentId;
  }
  return '书签栏';
}

/**
 * 同名批次消歧。
 *
 * 只有**同一个目标文件夹**再次整理时才复用批次；两个不同文件夹恰好同名时
 * 必须分开——否则把它们并进同一批，应用时会把 A 的分类搬进 B。
 * 名字优先保持原样，真的撞了才补「书签栏/其他书签」或数字后缀。
 */
async function uniqueBatchTitle(
  siblings: chrome.bookmarks.BookmarkTreeNode[],
  base: string,
  targetParentId: string,
): Promise<string> {
  const taken = new Set(
    siblings.filter((c) => !c.url).map((c) => (c.title || '').trim()),
  );
  if (!taken.has(base)) return base;
  const qualifier = await rootTitleOf(targetParentId);
  let candidate = `${base}（${qualifier}）`;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${base}（${qualifier} ${n}）`;
    n += 1;
  }
  return clip(candidate);
}

/**
 * 为一次整理开一个批次。
 *
 * 返回 `batchId`：模型接下来所有 `create_folder` / `move_bookmarks` 都应当以它为父级。
 * **同一个目标文件夹**再次整理会复用已有批次；不同文件夹即使同名也各开一批（见 uniqueBatchTitle）。
 */
export async function stageBatch(targetParentId: string): Promise<StagedBatch> {
  const nodes = await chrome.bookmarks.get(targetParentId).catch(() => []);
  const target = nodes[0];
  if (!target) throw new Error(`目标文件夹不存在（id: ${targetParentId}）`);
  if (target.url) throw new Error(`目标 ${targetParentId} 不是文件夹`);

  const root = await ensureStagingRoot();
  const title = clip(target.title || '(未命名)');
  const siblings = await chrome.bookmarks.getChildren(root);
  const stored = await readStored();
  const { batches } = stored;

  // 这个目标文件夹已经有一个活着的批次：直接复用，不要建重复的
  const sameTarget = batches.find((b) => b.targetParentId === targetParentId);
  if (sameTarget) {
    const alive = await chrome.bookmarks.get(sameTarget.batchId).catch(() => []);
    if (alive[0] && !alive[0].url) return sameTarget;
  }

  const existing = siblings.find((c) => !c.url && (c.title || '').trim() === title);
  if (existing) {
    const found = batches.find((b) => b.batchId === existing.id);
    if (found && found.targetParentId === targetParentId) return found;
    // 节点存在但没元信息 / 元信息指向别的文件夹：不能直接认领（会把两批书签混在一起）
  }

  const batchTitle = await uniqueBatchTitle(siblings, title, targetParentId);
  const node = await jCreate({ parentId: root, title: batchTitle });
  const batch: StagedBatch = {
    batchId: node.id,
    title: batchTitle,
    targetParentId,
    targetTitle: title,
    createdAt: Date.now(),
  };
  await writeStored({ ...stored, batches: [...batches, batch] });
  return batch;
}

/**
 * 批次里现在有多少分类 / 多少书签（UI 显示用，也用于"空批次不显示"的判断）。
 *
 * **递归数**：书签是躺在分类文件夹**里面**的，只数直接子项会得到"2 个分类、0 条书签"，
 * 用户会以为这次整理什么书都没动——而这正是他要判断"值不值得应用"的数字。
 * 深度给 8 层上限：极端嵌套（用户手拖出来的）不该把面板拖死。
 */
export async function batchStats(batchId: string): Promise<{ folders: number; bookmarks: number }> {
  let folders = 0;
  let bookmarks = 0;
  const walk = async (id: string, depth: number): Promise<void> => {
    const children = await chrome.bookmarks.getChildren(id).catch(() => []);
    for (const c of children) {
      if (c.url) {
        bookmarks += 1;
        continue;
      }
      folders += 1;
      if (depth < 8) await walk(c.id, depth + 1);
    }
  };
  await walk(batchId, 0);
  return { folders, bookmarks };
}

/** dest 是否在 ancestor 内（含自身）——用于阻止"把分类搬进它自己/子文件夹"的循环 */
async function isWithin(destId: string, ancestorId: string): Promise<boolean> {
  let id: string | undefined = destId;
  for (let depth = 0; depth < 64 && id; depth += 1) {
    if (id === ancestorId) return true;
    const nodes: chrome.bookmarks.BookmarkTreeNode[] = await chrome.bookmarks.get(id).catch(() => []);
    id = nodes[0]?.parentId;
    if (id === '0') return false;
  }
  return false;
}

/**
 * 把批次内容搬到目标文件夹，然后清掉空的批次壳。
 *
 * 搬的是**批次下的直接子项**（分类文件夹 + 可能散落的书签），批次自身不留痕：
 * 用户要的是"这些分类出现在我的文件夹里"，不是"我的文件夹里有个叫自动整理的壳"。
 *
 * 目标可以是原文件夹，也可以是用户用「选择其他文件夹」挑的任意目录；
 * 但不能是暂存区内部（否则等于没落位，还会把批次搅在一起），也不能在批次自己的子树里。
 * 移动中途失败时**保留批次记录**，让用户可以重试，而不是留下一个没有元信息的孤儿文件夹。
 */
export async function applyBatch(
  batchId: string,
  destParentId: string,
): Promise<{ folders: number; bookmarks: number }> {
  const batchNodes = await chrome.bookmarks.get(batchId).catch(() => []);
  const batch = batchNodes[0];
  if (!batch || batch.url) throw new Error(`暂存批次不存在（id: ${batchId}）`);

  const dest = await chrome.bookmarks.get(destParentId).catch(() => []);
  if (!dest[0]) throw new Error(`目标文件夹不存在（id: ${destParentId}）`);
  if (dest[0].url) throw new Error(`目标 ${destParentId} 不是文件夹`);

  if (await isWithin(destParentId, batchId)) {
    throw new Error('目标文件夹在待落位的分类内部，会造成循环嵌套');
  }
  const stagingRoot = await findStagingRoot();
  if (stagingRoot && (await isWithin(destParentId, stagingRoot))) {
    throw new Error('不能把整理结果放回「自动整理」暂存区，请选择真正的目标文件夹');
  }

  // 统计在**搬之前**递归算：书签躺在分类里，只数直接子项会得到"0 条书签"，
  // 而 toast 上那句"N 条书签已落位"是用户判断"这次到底动没动东西"的唯一依据。
  const stats = await batchStats(batchId);
  const children = await chrome.bookmarks.getChildren(batchId);
  let moved = 0;
  for (const c of children) {
    try {
      await jMove(c.id, { parentId: destParentId });
      moved += 1;
    } catch (e) {
      throw new Error(
        `只搬了 ${moved}/${children.length} 项，剩下 ${children.length - moved} 项还在暂存区；` +
          `可重试（原因：${e instanceof Error ? e.message : String(e)}）`,
      );
    }
  }
  // 只有壳真的空了才删：中途失败时它还有内容，删掉就等于丢书签
  const left = await chrome.bookmarks.getChildren(batchId).catch(() => []);
  if (left.length === 0) {
    await jRemove(batchId).catch(() => {});
    await dropBatchRecord(batchId);
    await pruneEmptyStagingRoot();
  }
  return stats;
}

/**
 * 放弃：把批次里的书签**搬回原文件夹**，再清掉批次。
 *
 * 为什么不直接删批次：删会把书签一起删掉（bookmarks.removeTree 是树删）。
 * 放弃的语义必须是"回到整理前"，而不是"整理成果连书签一起消失"。
 * 代价是原来的子分类结构不会恢复——那是"放弃"应有的样子：
 * 你没接受这套分类，书签就该平铺回原处。
 */
export async function discardBatch(batchId: string): Promise<{ returned: number }> {
  const { batches } = await readStored();
  const record = batches.find((b) => b.batchId === batchId);
  const fallbackHome = record?.targetParentId ?? (await bookmarkBarId());

  // 原文件夹可能已经被用户删了：回落到书签栏，绝不把书签留在暂存区里当孤儿
  const homeNodes = await chrome.bookmarks.get(fallbackHome).catch(() => []);
  const home = homeNodes[0] && !homeNodes[0].url ? fallbackHome : await bookmarkBarId();

  let returned = 0;
  const walk = async (id: string): Promise<void> => {
    const children = await chrome.bookmarks.getChildren(id).catch(() => []);
    for (const c of children) {
      if (c.url) {
        await jMove(c.id, { parentId: home });
        returned += 1;
      } else {
        await walk(c.id);
      }
    }
  };
  await walk(batchId);
  // 书签都搬走了，剩下的空壳直接删（不再记撤销点：这一步只是清理）
  await chrome.bookmarks.removeTree(batchId).catch(() => {});
  // 删失败（极少见）时保留元信息，别让界面出现一个点不掉的幽灵方案
  const left = await chrome.bookmarks.get(batchId).catch(() => []);
  if (left.length === 0) {
    await dropBatchRecord(batchId);
    await pruneEmptyStagingRoot();
  }
  return { returned };
}

/** 从元信息里移除一条（不动书签） */
async function dropBatchRecord(batchId: string): Promise<void> {
  const stored = await readStored();
  await writeStored({ ...stored, batches: stored.batches.filter((b) => b.batchId !== batchId) });
}

/**
 * 暂存根空了就删掉它。
 *
 * 留着的话，用户的书签栏会永远挂着一个空文件夹——那正是"整理完留下垃圾"的观感。
 */
async function pruneEmptyStagingRoot(): Promise<void> {
  const root = await findStagingRoot();
  if (!root) return;
  const left = await chrome.bookmarks.getChildren(root).catch(() => []);
  if (left.length === 0) {
    await chrome.bookmarks.remove(root).catch(() => {});
    const stored = await readStored();
    await writeStored({ ...stored, rootId: undefined });
  }
}
