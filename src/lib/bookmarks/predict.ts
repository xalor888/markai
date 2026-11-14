/**
 * ── 收藏时「放哪里」预测（纯函数） ──
 *
 * 只做建议，不自动执行。两个信号，按可靠性排序：
 *  1. **同一域名已经在哪个文件夹里**：最可靠，用户自己的分类就是答案；
 *  2. **整理日志里这个域名曾被归到哪**：次可靠，模型/规则过去的选择。
 *
 * 都不满足时返回 null——popup 不显示建议，而不是硬塞一个"书签栏"。
 * 默认存书签栏仍是主按钮，预测只是多一个更快的选项。
 */

import { getHost } from '@/lib/format';

type BNode = chrome.bookmarks.BookmarkTreeNode;

export interface PredictLogEntry {
  domain?: string;
  target?: string;
  action?: string;
}

export interface FolderSuggestion {
  folderId: string;
  /** 不含根的相对路径，如「技术 / 前端」 */
  path: string;
  reason: string;
  /** 命中信号数（同域名条数 + 历史整理次数），仅用于调试与测试 */
  score: number;
}

interface FolderInfo {
  id: string;
  relPath: string;
  path: string;
  hostCounts: Map<string, number>;
}

function rootLabel(node: BNode): string {
  const title = (node.title || '').trim();
  if (title) return title;
  if (node.id === '1') return '书签栏';
  if (node.id === '2') return '其他书签';
  if (node.id === '3') return '移动设备';
  return '根目录';
}

function normalizePath(path: string): string {
  return path
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' / ');
}

/**
 * @param log 整理日志（只需要 domain/target/action 三个字段）
 */
export function predictFolder(
  roots: BNode[],
  url: string,
  log: readonly PredictLogEntry[] = [],
): FolderSuggestion | null {
  const host = getHost(url);
  if (!host) return null;

  const folders: FolderInfo[] = [];
  const byId = new Map<string, FolderInfo>();

  const walk = (node: BNode, root: string, parents: string[], currentFolderId?: string) => {
    if (node.url) {
      const folder = currentFolderId ? byId.get(currentFolderId) : undefined;
      const h = getHost(node.url);
      if (folder && h) folder.hostCounts.set(h, (folder.hostCounts.get(h) ?? 0) + 1);
      return;
    }
    const title = (node.title || '').trim() || '(未命名)';
    const relPath = [...parents, title].join(' / ');
    const folder: FolderInfo = {
      id: node.id,
      relPath,
      path: normalizePath(`${root} / ${relPath}`),
      hostCounts: new Map(),
    };
    folders.push(folder);
    byId.set(node.id, folder);
    for (const child of node.children ?? []) walk(child, root, [...parents, title], node.id);
  };

  for (const root of roots) {
    const label = rootLabel(root);
    for (const child of root.children ?? []) walk(child, label, []);
  }

  const logMatches = new Map<string, number>();
  for (const entry of log) {
    if (!entry.target) continue;
    if (entry.action === 'failed') continue;
    const entryDomain = (entry.domain || '').trim().toLowerCase();
    if (entryDomain && entryDomain !== host) continue;
    const target = normalizePath(entry.target);
    const match = folders.find(
      (f) => f.relPath === target || normalizePath(f.path) === target || normalizePath(f.path).endsWith(` / ${target}`),
    );
    if (match) logMatches.set(match.id, (logMatches.get(match.id) ?? 0) + 1);
  }

  let best: FolderSuggestion | null = null;
  for (const folder of folders) {
    const hostCount = folder.hostCounts.get(host) ?? 0;
    const history = logMatches.get(folder.id) ?? 0;
    const score = hostCount * 2 + history * 3;
    if (score <= 0) continue;
    const candidate: FolderSuggestion = {
      folderId: folder.id,
      path: folder.relPath,
      score,
      reason:
        hostCount > 0
          ? `同一域名已有 ${hostCount} 条在「${folder.relPath}」`
          : `你之前把 ${host} 归到「${folder.relPath}」`,
    };
    if (
      !best ||
      candidate.score > best.score ||
      (candidate.score === best.score && candidate.path.localeCompare(best.path, 'zh') < 0)
    ) {
      best = candidate;
    }
  }
  return best;
}
