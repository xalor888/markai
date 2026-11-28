/**
 * 语义搜索注册（占位实现）。
 *
 * 装上真实实现时：构建索引 → `registerSemanticSearcher(...)`。
 * 未注册时 `searchBookmarks` 自动走关键词兜底，搜索框永远可用。
 */
import { registerSemanticSearcher } from '@/lib/features/semantic';

export function installSemanticSearch(): void {
  registerSemanticSearcher(null);
}
