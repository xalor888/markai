/**
 * ── 语义搜索接缝 ──
 *
 * 这个文件是**稳定的调用面**：UI 与命令面板只依赖这里的类型与函数签名，
 * 具体实现（向量化、索引、重排）在 `lib/search/semantic/*` 里演进。
 *
 * 为什么先定签名再实现：搜索是全局入口（顶栏、⌘K、Agent 工具都会调），
 * 如果每个入口各自判断"向量模块在不在"，就会出现三种不同的降级行为。
 * 这里统一成：**永远有结果**——没有向量就用关键词，绝不让搜索框失效。
 */

import { flattenBookmarks, type TimelineItem } from '@/lib/bookmarks/timeline';
import { scoreItem } from '@/lib/command/search';

type BNode = chrome.bookmarks.BookmarkTreeNode;

export interface SemanticHit {
  id: string;
  title: string;
  url: string;
  path: string;
  /** 0–1；关键词命中时按匹配方式折算，向量命中时是余弦相似度 */
  score: number;
  /** 命中的原因，用于 UI 上那行小字（"标题包含" / "语义相近"） */
  reason: 'exact' | 'prefix' | 'contains' | 'subtitle' | 'fuzzy' | 'semantic';
}

export interface SemanticSearchOptions {
  limit?: number;
  /** 只搜某个文件夹子树（id 为根/文件夹 id） */
  folderId?: string;
}

/**
 * 关键词兜底检索（纯函数）。
 *
 * 与命令面板共用 `scoreItem`，保证"语义搜索关掉时"排序不突变——
 * 用户不该因为开关状态而看到两套完全不同的结果顺序。
 */
export function keywordHits(
  roots: BNode[],
  query: string,
  opts: SemanticSearchOptions = {},
): SemanticHit[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 40, 200));
  const q = query.trim();
  if (!q) return [];
  const scoped: TimelineItem[] = opts.folderId ? scopedItems(roots, opts.folderId) : flattenBookmarks(roots);
  const hits: SemanticHit[] = [];
  for (const item of scoped) {
    const score = scoreItem(
      { id: item.id, kind: 'bookmark', title: item.title, subtitle: item.path },
      q,
    );
    if (score <= 0) continue;
    hits.push({
      id: item.id,
      title: item.title,
      url: item.url,
      path: item.path,
      score: score / 1000,
      reason: reasonOf(score),
    });
  }
  hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'zh-CN'));
  return hits.slice(0, limit);
}

function reasonOf(score: number): SemanticHit['reason'] {
  if (score >= 1000) return 'exact';
  if (score >= 600) return 'prefix';
  if (score >= 300) return 'contains';
  if (score >= 150) return 'subtitle';
  return 'fuzzy';
}

/** 取某个文件夹子树（含自身）；找不到就返回空数组，而不是退回全库 */
function scopedItems(roots: BNode[], folderId: string): TimelineItem[] {
  const found = findNode(roots, folderId);
  return found ? flattenBookmarks([found]) : [];
}

function findNode(nodes: BNode[], id: string): BNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = n.children ? findNode(n.children, id) : null;
    if (hit) return hit;
  }
  return null;
}

/**
 * 语义检索入口。
 *
 * 默认实现 = 关键词兜底；实现模块加载后可用 `registerSemanticSearcher` 覆盖。
 * 用注册表而不是直接 import 实现，是为了让 `main` 在没有实现模块时也能构建
 * （实现模块由独立的 worktree 提供，合并前不能成为硬依赖）。
 */
export type SemanticSearcher = (
  roots: BNode[],
  query: string,
  opts: SemanticSearchOptions,
) => Promise<SemanticHit[]> | SemanticHit[];

let searcher: SemanticSearcher | null = null;

export function registerSemanticSearcher(fn: SemanticSearcher | null): void {
  searcher = fn;
}

export function hasSemanticSearcher(): boolean {
  return searcher !== null;
}

/**
 * 永远返回结果的搜索。
 *
 * 顺序：语义实现（若已注册且不抛错）→ 关键词兜底。
 * 语义实现抛错时不吞掉整个搜索：记一次 note，然后继续用关键词结果。
 */
export async function searchBookmarks(
  roots: BNode[],
  query: string,
  opts: SemanticSearchOptions = {},
): Promise<{ hits: SemanticHit[]; used: 'semantic' | 'keyword'; note?: string }> {
  if (!query.trim()) return { hits: [], used: 'keyword' };
  if (searcher) {
    try {
      const hits = await searcher(roots, query, opts);
      if (hits.length > 0) return { hits, used: 'semantic' };
      // 语义检索没命中不代表关键词也没有：继续兜底，避免"明明有这条却搜不到"
    } catch (e) {
      return {
        hits: keywordHits(roots, query, opts),
        used: 'keyword',
        note: `语义检索失败，已退回关键词：${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
  return { hits: keywordHits(roots, query, opts), used: 'keyword' };
}
