/**
 * ── 混合检索与融合排序 ──
 *
 * 两路分数：关键词（字面匹配）与语义（余弦相似度）。融合公式是刻意简单的
 * 线性加权，权重在这里导出、测试里断言——排序结果必须能被解释：
 * 「为什么这条在前」要么是字面更像，要么是向量更近。
 *
 * 硬规则：标题完全相等 / 前缀永远排在语义命中之前。用户搜一个确切的名字时，
 * 不该被一条"语义上很像"的东西挤下去。
 */

import { scoreItem, SCORE } from '@/lib/command/search';
import type { SemanticHit, SemanticSearchOptions } from '@/lib/features/semantic';
import { cosine, tokenize, tokenWeightsOfTokens, buildVector, tokenizeUrl } from './local-embed';
import type { IndexEntry } from './index';

/** 融合权重：关键词略高，保证字面命中不被同义扩展稀释 */
export const KEYWORD_WEIGHT = 0.6;
export const SEMANTIC_WEIGHT = 0.4;

/** 同义扩展的额外加分上限：只加分、不替代原查询 */
export const EXPANSION_BONUS = 0.12;

/** 纯语义命中的余弦下限：低于它视为噪音，不进入结果 */
export const MIN_SEMANTIC_SCORE = 0.08;

/**
 * 轻量同义表。
 *
 * 只覆盖"用户会换一种说法"的高频分类词；它不是知识图谱，
 * 也不该试图理解一切——扩展错了只会把无关项往上顶，宁可少而准。
 */
export const SYNONYMS: Record<string, string[]> = {
  代码: ['编程', '开发', 'code', 'coding', 'programming', 'github', 'gitlab', '仓库', 'repository'],
  编程: ['代码', '开发', 'code', 'coding', 'programming', 'developer'],
  开发: ['编程', '代码', 'developer', 'development', 'dev'],
  设计: ['ui', 'ux', 'design', '界面', '视觉', '交互'],
  ui: ['设计', '界面', 'design', '交互', 'ux'],
  界面: ['ui', 'ux', '设计', 'design'],
  文档: ['doc', 'docs', 'documentation', '手册', '教程', 'wiki'],
  教程: ['tutorial', '指南', 'guide', '文档', 'howto', '课程'],
  博客: ['blog', '文章', 'post', '专栏'],
  视频: ['video', 'youtube', 'bilibili', '影视'],
  工具: ['tool', 'tools', '软件', '应用', 'utility'],
  框架: ['framework', 'react', 'vue', 'svelte', 'angular', '前端'],
  前端: ['frontend', 'react', 'vue', 'css', 'html', 'javascript', 'typescript', '框架'],
  后端: ['backend', 'server', 'api', '数据库', 'database'],
  数据库: ['database', 'sql', 'mysql', 'postgres', 'redis', 'mongo'],
  人工智能: ['ai', 'llm', '模型', 'model', '机器学习', 'machine learning', 'gpt'],
  ai: ['人工智能', 'llm', '模型', 'machine learning', 'gpt', '大模型'],
  机器学习: ['ml', 'machine learning', 'ai', '模型', '深度学习'],
  新闻: ['news', '资讯', '报道', '日报'],
  购物: ['shop', 'shopping', '商城', '电商', '商品'],
  学习: ['learn', 'learning', '课程', 'course', '教程', 'study'],
  课程: ['course', '教程', 'tutorial', '学习', 'lesson'],
  组件: ['component', '组件库', 'ui', 'design system'],
  图标: ['icon', 'icons', 'svg', '图标库'],
  字体: ['font', 'fonts', 'typography', '字型'],
  图片: ['image', 'photo', '图片素材', '素材', 'picture'],
  素材: ['asset', '资源', 'resource', '素材库'],
  搜索: ['search', '检索', '查询', 'query'],
  笔记: ['note', 'notes', 'notion', 'obsidian', '记录'],
  效率: ['productivity', 'workflow', '效率工具'],
  阅读: ['read', 'reading', '文章', '书', 'book'],
  书签: ['bookmark', '收藏', '收藏夹'],
  管理: ['manage', 'management', '组织', 'organize'],
  整理: ['organize', '分类', '归类', 'cleanup', '整理工具'],
  音乐: ['music', 'audio', '歌', 'spotify'],
  电影: ['movie', 'film', '影视', '豆瓣'],
  游戏: ['game', 'gaming', 'steam', '游戏'],
  云: ['cloud', 'aws', 'azure', 'gcp', '阿里云'],
  部署: ['deploy', 'deployment', 'ci', 'cd', 'docker', '发布'],
  容器: ['docker', 'kubernetes', 'k8s', 'container'],
  安全: ['security', '漏洞', 'vulnerability', '安全工具'],
  测试: ['test', 'testing', 'qa', '单测'],
  性能: ['performance', '优化', 'optimize', 'benchmark'],
  优化: ['optimize', 'performance', '改进', '提升'],
};

/** 同义扩展结果：used 为空时调用方走原查询 */
export interface QueryExpansion {
  tokens: string[];
  /** 去重后的扩展词（不含原查询 token） */
  expanded: string[];
}

function normalizeTitle(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * 查询扩展。
 *
 * 同时按 token 与"整串包含"两种方式查表：中文分词会把「代码托管」切成
 * 代码/码托/托管，能命中"代码"；英文短语「machine learning」则要靠整串包含。
 */
export function expandQuery(query: string): QueryExpansion {
  const tokens = tokenize(query);
  const normalized = normalizeTitle(query);
  const padded = ` ${normalized} `;
  const out = new Set<string>();
  for (const token of tokens) {
    for (const synonym of SYNONYMS[token] ?? []) out.add(synonym.toLowerCase());
  }
  for (const [key, values] of Object.entries(SYNONYMS)) {
    /*
     * 中文按"整串包含"查表；纯 ASCII 的键必须按词边界匹配——
     * 否则 "build" 里的 "ui"、"mail" 里的 "ai" 都会触发无关扩展。
     */
    const ascii = /^[\x20-\x7e]+$/.test(key);
    if (ascii ? !padded.includes(` ${key} `) : !normalized.includes(key)) continue;
    for (const synonym of values) out.add(synonym.toLowerCase());
  }
  for (const token of tokens) out.delete(token);
  return { tokens, expanded: [...out].sort((a, b) => a.localeCompare(b, 'en')) };
}

/** 查询向量 = 原查询（权重 1）+ 扩展词（权重 0.5），再归一化 */
export function buildQueryVector(query: string): number[] {
  const { tokens, expanded } = expandQuery(query);
  const weights = tokenWeightsOfTokens(tokens, 1);
  for (const [token, weight] of tokenWeightsOfTokens(expanded, 0.5)) {
    weights.set(token, (weights.get(token) ?? 0) + weight);
  }
  return buildVector(weights);
}

function reasonOf(keywordScore: number): SemanticHit['reason'] {
  if (keywordScore >= SCORE.exact) return 'exact';
  if (keywordScore >= SCORE.prefix) return 'prefix';
  if (keywordScore >= SCORE.contains) return 'contains';
  if (keywordScore >= SCORE.subtitle) return 'subtitle';
  if (keywordScore > 0) return 'fuzzy';
  return 'semantic';
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export interface FuseOptions extends SemanticSearchOptions {
  /** 远端索引的查询向量（由调用方异步请求）；为空时按本地规则现算 */
  queryVector?: number[];
  /**
   * 纯语义命中是否必须至少有一个共同 token（含同义扩展）。
   *
   * 本地特征哈希在 384 维下偶发碰撞会给无关条目 0.2 左右的余弦，
   * 只靠阈值挡不住。要求一个词汇锚点后，"前端框架 → React"仍能命中
   * （扩展词 react），而"前端框架 → 哔哩哔哩"这种纯碰撞会被丢掉。
   * 远端向量没有碰撞问题，调用方传 false。
   */
  requireLexicalAnchor?: boolean;
}

/**
 * 融合排序（纯函数）。
 *
 * tier 决定"字面优先级"，final 决定同 tier 内的顺序：
 *  3 = 标题完全相等；2 = 标题前缀；1 = 有字面命中；0 = 纯语义命中。
 * 这样一条语义分再高的条目，也压不过一条标题精确相等的条目。
 */
export function fuseSearch(
  entries: Iterable<IndexEntry>,
  query: string,
  opts: FuseOptions = {},
): SemanticHit[] {
  const q = query.trim();
  if (!q) return [];
  const limit = Math.max(1, Math.min(opts.limit ?? 40, 200));
  const { tokens, expanded } = expandQuery(q);
  const queryVector = opts.queryVector ?? buildQueryVector(q);
  const qNorm = normalizeTitle(q);
  const expandedSet = new Set(expanded);
  // 单字 CJK token 太容易偶然重叠，不作为"词汇锚点"
  const anchorSet = new Set(
    [...tokens, ...expanded].filter((token) => token.length >= 2 || /^[a-z0-9]{2,}$/.test(token)),
  );

  interface Scored {
    entry: IndexEntry;
    final: number;
    tier: number;
    reason: SemanticHit['reason'];
  }
  const scored: Scored[] = [];

  for (const entry of entries) {
    if (opts.folderId && !entry.ancestors.includes(opts.folderId)) continue;

    const host = tokenizeUrl(entry.url).host.join(' ');
    const keywordRaw = scoreItem(
      { id: entry.id, kind: 'bookmark', title: entry.title, subtitle: `${entry.path} ${host}` },
      q,
    );
    let keyword = Math.min(1, keywordRaw / SCORE.exact);

    // 同义扩展：只统计索引条目里真实存在的扩展词，按覆盖率给一次小额加分
    if (expandedSet.size > 0) {
      let matched = 0;
      for (const token of entry.tokens) if (expandedSet.has(token)) matched++;
      keyword = Math.min(1, keyword + (matched / expandedSet.size) * EXPANSION_BONUS);
    }

    const titleNorm = normalizeTitle(entry.title);
    const exact = qNorm.length > 0 && titleNorm === qNorm;
    const prefix = !exact && qNorm.length > 0 && titleNorm.startsWith(qNorm);
    const semantic =
      !entry.degraded && entry.vector && entry.vector.length === queryVector.length
        ? clamp01(cosine(entry.vector, queryVector))
        : 0;

    const tier = exact ? 3 : prefix ? 2 : keywordRaw > 0 ? 1 : 0;
    if (tier === 0 && semantic < MIN_SEMANTIC_SCORE) continue;
    if (tier === 0 && opts.requireLexicalAnchor !== false) {
      let anchored = false;
      for (const token of entry.tokens) {
        if (anchorSet.has(token)) {
          anchored = true;
          break;
        }
      }
      if (!anchored) continue;
    }

    const final = keyword * KEYWORD_WEIGHT + semantic * SEMANTIC_WEIGHT;
    scored.push({
      entry,
      final: Math.round(final * 10000) / 10000,
      tier,
      reason: tier === 0 ? 'semantic' : reasonOf(keywordRaw),
    });
  }

  scored.sort((a, b) => {
    if (a.tier !== b.tier) return b.tier - a.tier;
    if (a.final !== b.final) return b.final - a.final;
    // 同分稳定：标题 → id，绝不依赖输入顺序或随机数
    const byTitle = a.entry.title.localeCompare(b.entry.title, 'zh-CN');
    if (byTitle !== 0) return byTitle;
    return a.entry.id.localeCompare(b.entry.id, 'en', { numeric: true });
  });

  return scored.slice(0, limit).map((item) => ({
    id: item.entry.id,
    title: item.entry.title,
    url: item.entry.url,
    path: item.entry.path,
    score: item.final,
    reason: item.reason,
  }));
}

/** 给 UI 的中文原因标签（命令面板副标题、顶栏语义补充共用） */
export function reasonLabel(reason: SemanticHit['reason']): string {
  switch (reason) {
    case 'exact':
      return '标题完全相同';
    case 'prefix':
      return '标题以它开头';
    case 'contains':
      return '标题包含';
    case 'subtitle':
      return '路径/域名包含';
    case 'fuzzy':
      return '模糊匹配';
    case 'semantic':
      return '语义相近';
  }
}
