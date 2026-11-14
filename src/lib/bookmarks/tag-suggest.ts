/**
 * ── 标签建议（纯函数，只建议不写入） ──
 *
 * 三个信号，按可靠性：
 *  1. 同一域名的其他书签用过哪些标签（用户自己的分类最可信）；
 *  2. 同一文件夹里的其他书签用过哪些标签；
 *  3. 标签名直接出现在标题里（弱信号，只做补充）。
 *
 * 已在该书签上的标签不重复建议；最多 3 个。
 */
import { getHost } from '@/lib/format';
import type { TagMap } from './tags';

export interface SuggestBookmark {
  id: string;
  title: string;
  url: string;
  parentId?: string;
}

export interface TagSuggestion {
  tag: string;
  reason: string;
  score: number;
}

export function suggestTags(
  bookmarks: readonly SuggestBookmark[],
  map: TagMap,
  target: SuggestBookmark,
  limit = 3,
): TagSuggestion[] {
  const host = getHost(target.url);
  const existing = new Set((map[target.id] ?? []).map((t) => t.toLowerCase()));
  const scores = new Map<string, { label: string; score: number; reasons: Set<string> }>();

  const add = (tag: string, weight: number, reason: string) => {
    const key = tag.toLowerCase();
    if (existing.has(key)) return;
    const current = scores.get(key) ?? { label: tag, score: 0, reasons: new Set<string>() };
    current.score += weight;
    current.reasons.add(reason);
    scores.set(key, current);
  };

  for (const bm of bookmarks) {
    if (bm.id === target.id) continue;
    for (const tag of map[bm.id] ?? []) {
      if (host && getHost(bm.url) === host) add(tag, 3, '同域名常用');
      if (target.parentId && bm.parentId === target.parentId) add(tag, 2, '同文件夹常用');
    }
  }

  // 标题命中：标签名（≥2 字符）出现在标题里，弱信号
  for (const tags of Object.values(map)) {
    for (const tag of tags) {
      if (tag.length < 2) continue;
      if (target.title.toLowerCase().includes(tag.toLowerCase())) add(tag, 1, '标题包含');
    }
  }

  return [...scores.values()]
    .map(({ label, score, reasons }) => ({
      tag: label,
      score,
      reason: [...reasons].join(' · '),
    }))
    .sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag, 'zh'))
    .slice(0, Math.max(0, limit));
}
