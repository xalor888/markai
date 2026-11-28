/**
 * ── 点子模型增强（可选） ──
 *
 * 规则层能发现"数得出来"的问题；模型能发现"感觉不对"的问题
 * （"你的设计书签和前端书签混在一起了"）。但模型也会编数字，所以：
 *
 *  · 只发**聚合统计 + 最多 30 条样本标题**，不发完整 URL 列表——
 *    既不把用户全库喂出去，也让模型没法逐条复述来假装"精确"；
 *  · 输出必须是严格 JSON，解析失败**整轮丢弃**，不猜、不修补；
 *  · 解析成功后还要再过滤：kind 必须在枚举内、count 不能超过真实书签数、
 *    prompt 不能承诺删除以外的写操作（防止模型说"我帮你删了"）；
 *  · 任何失败都只返回空数组，不弹错误——点子面板会继续显示规则点子。
 */
import type { AIConfig } from '@/lib/ai/types';
import type { Idea, IdeaInput, IdeaKind } from '@/lib/features/ideas';
import { chatCompletion } from '@/lib/ai/client';
import { generateRuleIdeas } from './rules';

/** 发给模型的样本标题上限：再多就是变相把库发出去 */
export const MODEL_SAMPLE_LIMIT = 30;
/** 模型点子一次最多返回几条：面板是"提几个能做的事"，不是报表 */
export const MODEL_IDEA_LIMIT = 3;

const ALLOWED_KINDS: readonly IdeaKind[] = [
  'stale',
  'duplicate',
  'empty-folder',
  'cluster',
  'broken',
  'unfiled',
  'insight',
];

/** 模型输出里允许出现的写操作；删除必须由用户确认，模型不得声称已执行 */
const FORBIDDEN_PROMPT_PATTERNS = [
  /已经?(帮你|为你)?(删除|清理掉|移除)了/,
  /已删除/,
  /删除完成/,
  /我(已经|已)(删|清空)/,
];

interface ModelIdeaRaw {
  kind?: unknown;
  title?: unknown;
  body?: unknown;
  prompt?: unknown;
  count?: unknown;
}

/**
 * 校验并清洗模型返回的一条点子。
 *
 * 返回 `null` 表示这条不可用——**静默丢弃**，不要把坏数据修成"差不多能用"，
 * 那会让用户看到一条依据是编的、但看起来很像真的建议。
 */
export function sanitizeModelIdea(
  raw: unknown,
  index: number,
  opts: { totalBookmarks: number; now: number },
): Idea | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as ModelIdeaRaw;
  const kind = typeof item.kind === 'string' ? (item.kind as IdeaKind) : null;
  if (!kind || !ALLOWED_KINDS.includes(kind)) return null;
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  const body = typeof item.body === 'string' ? item.body.trim() : '';
  const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : '';
  if (!title || !body || !prompt) return null;
  if (FORBIDDEN_PROMPT_PATTERNS.some((p) => p.test(prompt) || p.test(body))) return null;

  let count: number | undefined;
  if (typeof item.count === 'number' && Number.isFinite(item.count) && item.count > 0) {
    // 模型最爱把数字说大：超过真实书签数一律视为编造，丢弃整条
    if (item.count > opts.totalBookmarks) return null;
    count = Math.floor(item.count);
  }

  return {
    // 加 model- 前缀 + 序号：与规则点子 id 不冲突，冷却表也不会互相覆盖
    id: `model-${kind}-${index}`,
    kind,
    title: title.slice(0, 80),
    body: body.slice(0, 400),
    prompt: prompt.slice(0, 600),
    ...(count !== undefined ? { count } : {}),
    affectsWrites: true,
    effort: 'medium',
    evidence: [{ text: '基于书签库的整体观察（模型生成，建议先核对）' }],
    createdAt: opts.now,
    source: 'model',
  };
}

/** 把模型返回的文本解析成点子数组；任何异常都返回空数组 */
export function parseModelIdeas(
  text: string,
  opts: { totalBookmarks: number; now: number },
): Idea[] {
  let parsed: unknown;
  try {
    // 容忍 ```json 围栏：很多模型即使被要求"只输出 JSON"也会加围栏
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { ideas?: unknown }).ideas)
      ? (parsed as { ideas: unknown[] }).ideas
      : [];
  const out: Idea[] = [];
  for (const [i, raw] of list.entries()) {
    if (out.length >= MODEL_IDEA_LIMIT) break;
    const idea = sanitizeModelIdea(raw, i, opts);
    if (idea) out.push(idea);
  }
  return out;
}

/** 从树里取"最值得看"的样本标题：优先根级与深层，最多 MODEL_SAMPLE_LIMIT 条 */
export function sampleTitles(roots: chrome.bookmarks.BookmarkTreeNode[], limit = MODEL_SAMPLE_LIMIT): string[] {
  const titles: string[] = [];
  const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[]) => {
    for (const node of nodes) {
      if (titles.length >= limit) return;
      if (node.url) titles.push(node.title || node.url);
      else if (node.children) walk(node.children);
    }
  };
  walk(roots);
  return titles.slice(0, limit);
}

function countAll(roots: chrome.bookmarks.BookmarkTreeNode[]): number {
  let n = 0;
  const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[]) => {
    for (const node of nodes) {
      if (node.url) n++;
      else if (node.children) walk(node.children);
    }
  };
  walk(roots);
  return n;
}

/**
 * 生成"模型增强"的点子。没有配置 / 请求失败 / 解析失败都返回空数组。
 *
 * 调用方拿到空数组就当"这一轮没有模型点子"，继续用规则点子，不提示错误。
 */
export async function generateModelIdeas(
  input: IdeaInput,
  config: AIConfig | null,
  signal: AbortSignal,
  now: number = Date.now(),
): Promise<Idea[]> {
  if (!config?.apiKey || !config.baseUrl || !config.model) return [];
  const total = countAll(input.roots);
  if (total === 0) return [];

  const ruleIdeas = generateRuleIdeas(input, now);
  const ruleSummary = ruleIdeas.map((i) => `- ${i.title}`).join('\n') || '（规则层没有发现问题）';
  const titles = sampleTitles(input.roots);
  const habits = input.habits.slice(0, 5).join('\n') || '（无）';

  const prompt = [
    '你是书签库的整理助手。根据下面的聚合信息，提出最多 3 条**具体可执行**的整理建议。',
    '',
    `书签总数：${total}`,
    `规则层已发现：\n${ruleSummary}`,
    `用户习惯：\n${habits}`,
    `样本标题（最多 ${MODEL_SAMPLE_LIMIT} 条）：\n${titles.map((t) => `- ${t}`).join('\n')}`,
    '',
    '只输出 JSON 数组，每项字段：kind（stale/duplicate/empty-folder/cluster/broken/unfiled/insight）、',
    'title、body、prompt、count（可选，必须是真实可核对的数字）。不要输出解释文字。',
  ].join('\n');

  try {
    const turn = await chatCompletion(
      config,
      [{ role: 'user', content: prompt }],
      [],
      signal,
      { onText: () => {}, onToolCall: () => {} },
    );
    return parseModelIdeas(turn.content, { totalBookmarks: total, now });
  } catch {
    return [];
  }
}
