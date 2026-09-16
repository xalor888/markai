/**
 * ── 「待删清单」删除执行器（UI 手工确认后的删除入口） ──
 *
 * 这些删除**同样可撤销**：删除前对每个将失去子项的父目录取一次完整子序检查点，
 * 再用带子树快照的 jRemove 逐条删除，因此用户在待删清单里确认的清理也能一键还原。
 *
 * 与 Agent 轮次的关系：如果此刻已有轮次的事务在记录（`isRecording()`），这里**并入**那一轮
 * ——既不开新事务也不结束它，否则会把一个轮次的日志切成两段。
 */
import { ensureRoots } from './tools';
import { jRemove } from '@/lib/undo/mutations';
import {
  beginUndoTransaction,
  endUndoTransaction,
  ensureOrderCheckpoint,
  isRecording,
} from '@/lib/undo/recorder';

export interface DeletionItem {
  proposalId: string;
  bookmarkId: string;
  all?: boolean;
}

export interface DeletionOutcome {
  count: number;
  failed: { proposalId: string; error: string }[];
}

/** 「删除全部」的特殊标记（真正的授权由 all 标志给出，见下） */
export const DELETE_ALL_MARKER = 'markai:all';

/** 并发池大小：Chrome bookmarks API 对高频调用有限流，20 并发易触发批量失败 */
const POOL = 10;

export async function executeDeletions(items: DeletionItem[]): Promise<DeletionOutcome> {
  await ensureRoots();
  // 自己开一个撤销点（若 Agent 轮次正在记录则并入，见文件头说明）
  const ownsTransaction = !isRecording();
  if (ownsTransaction) await beginUndoTransaction('deletions:manual');
  try {
    return await runDeletions(items);
  } finally {
    // 必须收尾：只结束自己开启的 deletions:manual 事务，防关闭并发轮次
    if (ownsTransaction) await endUndoTransaction('deletions:manual');
  }
}

/** 以 10 路并发跑完 list 中的每一项 */
async function runPool<T>(list: T[], runOne: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(POOL, Math.max(1, list.length)) }, async () => {
    while (cursor < list.length) {
      await runOne(list[cursor++]!);
    }
  });
  await Promise.all(workers);
}

async function runDeletions(items: DeletionItem[]): Promise<DeletionOutcome> {
  let count = 0;
  const failed: { proposalId: string; error: string }[] = [];

  const normal = items.filter((it) => it.bookmarkId !== DELETE_ALL_MARKER);

  // ── 预扫描（只读，可并发）──
  // 必须在任何删除**之前**拿到各自的父目录并拍下检查点：删除一并发起来，
  // 逐条读到的"父目录现状"就不再是操作前状态了（并发下顺序会错乱，实测栽过）。
  const resolved: { it: DeletionItem; id: string; parentId: string }[] = [];
  await runPool(normal, async (it) => {
    try {
      if (it.all) throw new Error('非"删除全部"提议携带了多余标志');
      // **读取失败 ≠ 书签不存在**：前者是"不确定"，后者才是"目标已达成"。
      // 原先 `.catch(() => [])` 把两者混为一谈，于是一次瞬时的读取失败会被计入**删除成功**，
      // 用户以为删掉了、其实书签还在。不确定必须如实上报成失败，让人/模型决定是否重试。
      let node: chrome.bookmarks.BookmarkTreeNode | undefined;
      try {
        const nodes = await chrome.bookmarks.get(it.bookmarkId);
        node = nodes[0];
      } catch (e) {
        throw new Error(
          `无法确认该书签的状态（读取失败）：${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (!node) {
        // 确实不存在（如其他窗口已删）：视为目标已达成，避免 UI 卡在可重试的 pending 死循环
        count++;
        return;
      }
      // 双保险：根文件夹（parentId '0'）与元根永远不可删
      if (node.parentId === undefined || node.parentId === '0') throw new Error('根文件夹不可删除');
      resolved.push({ it, id: it.bookmarkId, parentId: node.parentId });
    } catch (e) {
      failed.push({ proposalId: it.proposalId, error: e instanceof Error ? e.message : String(e) });
    }
  });
  for (const p of new Set(resolved.map((r) => r.parentId))) {
    await ensureOrderCheckpoint(p);
  }

  // ── 删除（并发池；jRemove 会先抓子树快照再删，因此可撤销）──
  await runPool(resolved, async ({ it, id }) => {
    try {
      try {
        await jRemove(id, { tree: true });
      } catch {
        // 瞬时失败（限流/竞态）重试一次
        await jRemove(id, { tree: true });
      }
      count++;
    } catch (e) {
      failed.push({ proposalId: it.proposalId, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ── "删除全部"特殊提议：清空各根目录的子项（根文件夹保留）──
  const allItem = items.find((it) => it.bookmarkId === DELETE_ALL_MARKER);
  if (allItem) {
    try {
      // 纵深防御：'markai:all' 特殊值必须携带 all 标志（防止 storage 脏数据/旧版本误触发清空）
      if (!allItem.all) throw new Error('缺少删除全部授权标志');
      const tree = await chrome.bookmarks.getTree();
      const roots = tree[0]?.children ?? [];
      const targets: { id: string; title: string }[] = [];
      for (const root of roots) {
        for (const child of root.children ?? []) {
          targets.push({ id: child.id, title: child.title || child.id });
        }
      }
      // 每个根都要拍检查点，撤销才能把子项顺序原样还回去
      for (const root of roots) await ensureOrderCheckpoint(root.id);
      await runPool(targets, async (t) => {
        try {
          try {
            await jRemove(t.id, { tree: true });
          } catch {
            await jRemove(t.id, { tree: true }); // 瞬时失败重试一次
          }
          count++;
        } catch (e) {
          // 单项失败上报（同一 proposalId），UI 侧据此提示部分未删除
          failed.push({
            proposalId: allItem.proposalId,
            error: `删除 ${t.title} 失败：${e instanceof Error ? e.message : String(e)}`,
          });
        }
      });
    } catch (e) {
      failed.push({ proposalId: allItem.proposalId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return { count, failed };
}
