/** ── Agent 主循环：流式对话 + 工具调用循环 ── */

import { chatCompletion, ChatError, type ApiMessage, type ApiToolCall } from './client';
import { SYSTEM_PROMPT, TOOL_DEFINITIONS } from './prompts';
import { executeTool, type ToolOutput } from './tools';
import type { AIConfig, ChatMessage, ChatOutbound, ToolCallRecord } from './types';

/** 单轮对话中工具调用轮数无上限（由死循环检测与连续失败保护兜底，不限制正常任务） */
/** 连续多轮调用完全相同（同一工具 + 相同参数组合）达到此数 → 判定死循环中止 */
const MAX_REPEAT_CALLS = 3;
/** 单条消息文本送入模型的最大长度 */
const MAX_MESSAGE_CHARS = 6000;
/** 工具结果回填模型的长度上限：默认上下文已放宽到 1024K，
 *  120K 字符 ≈ 1000+ 条书签清单，配合 limit=2000 让模型一次拿到足够数据；
 *  仍超长时用 offset/maxItems 分页让模型分批消化 */
const MAX_TOOL_RESULT_CHARS = 120_000;
/** 每条消息的固定开销（角色标记、元数据等） */
const PER_MESSAGE_OVERHEAD = 40;

/** 只读工具：可并行执行（无副作用，互不依赖） */
const READ_TOOLS = new Set([
  'list_bookmarks',
  'search_bookmarks',
  'get_recent_bookmarks',
  'get_folder_path',
  'list_all_folders',
  'list_empty_folders',
  'get_folder_content',
  'export_bookmarks',
  'check_urls',
  'check_urls_bulk',
  'classify_urls',
  'stats',
  'find_duplicates',
  'open_bookmark',
]);

export interface AgentTurnParams {
  config: AIConfig;
  messageId: string;
  history: ChatMessage[];
  text: string;
  signal: AbortSignal;
  onEvent: (event: ChatOutbound) => void;
}

/** 提取消息纯文本 */
function extractText(m: ChatMessage): string {
  return m.blocks
    .filter((b): b is { kind: 'text'; text: string } => b.kind === 'text')
    .map((b) => b.text)
    .join('');
}

/**
 * 估算文本 token 数（中英混合近似）：
 * 中文/全角约 0.75 token/字（主流 tokenizer 实测区间），假名/谚文约 1 token，其他约 1/4 token。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let cjkExt = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk++;
    else if (/[\u3040-\u30ff\uac00-\ud7af]/.test(ch)) cjkExt++; // 日文假名 / 韩文谚文
    else other++;
  }
  return Math.ceil(cjk * 0.75 + cjkExt + other / 4);
}

/** 固定开销估算：系统提示词 + 工具定义 schema（不在历史预算内，需从窗口预算中扣除） */
function fixedOverheadTokens(): number {
  return estimateTokens(SYSTEM_PROMPT) + estimateTokens(JSON.stringify(TOOL_DEFINITIONS)) + 100;
}

/**
 * 按 token 预算选择历史消息（从最新往回累积）：
 * - 单条消息截断到 MAX_MESSAGE_CHARS 字符
 * - 预算用尽后停止；至少保留最近 1 条
 * - autoCompress 开启时，超预算的早期消息合并为摘要（占用固定小预算）
 */
function selectHistory(
  history: ChatMessage[],
  budget: number,
  autoCompress: boolean,
): ChatMessage[] {
  if (history.length === 0) return [];
  const selected: ChatMessage[] = [];
  let used = 0;
  for (const m of [...history].reverse()) {
    let text = extractText(m).slice(0, MAX_MESSAGE_CHARS);
    let cost = estimateTokens(text) + PER_MESSAGE_OVERHEAD;
    // 单条消息自身超预算（极小窗口）：截断到预算的一半，保证能纳入最近一条
    if (selected.length === 0 && cost > budget) {
      const maxChars = Math.max(100, Math.floor((budget / 2) / 0.75));
      text = text.slice(0, maxChars);
      cost = estimateTokens(text) + PER_MESSAGE_OVERHEAD;
    }
    if (selected.length > 0 && used + cost > budget) break;
    selected.unshift(text === extractText(m) ? m : { ...m, blocks: [{ kind: 'text', text }] });
    used += cost;
  }

  // 未全部纳入且开启压缩：早期消息截断合并为摘要
  if (autoCompress && selected.length < history.length) {
    const selectedIds = new Set(selected.map((m) => m.id));
    const early = history.filter((m) => !selectedIds.has(m.id));
    // 摘要预算：总预算的 1/16，上限 4000 token 估算
    const summaryBudget = Math.min(Math.max(Math.floor(budget / 16), 500), 4000);
    const lines: string[] = [];
    let sum = 0;
    for (const m of early) {
      const t = extractText(m).slice(0, 200);
      const cost = estimateTokens(t) + 20;
      if (sum + cost > summaryBudget) break;
      lines.push(`${m.role === 'user' ? '用户' : 'Agent'}：${t}`);
      sum += cost;
    }
    if (lines.length > 0) {
      selected.unshift({
        id: 'compress-summary',
        role: 'user',
        blocks: [
          {
            kind: 'text',
            text: `【早期对话摘要】\n${lines.join('\n')}\n（以上为压缩后的早期对话，请基于此继续当前对话）`,
          },
        ],
        createdAt: early[0]?.createdAt ?? 0,
      });
    }
  }
  return selected;
}

/**
 * 运行一轮 Agent 对话：
 * 流式输出 → 解析工具调用 → 执行并回填 → 继续，直到模型给出最终回答。
 */
export async function runAgentTurn(params: AgentTurnParams): Promise<void> {
  const { config, messageId, history, text, signal, onEvent } = params;

  // 上下文预算 = 用户填写的模型上下文长度 × 压缩阈值，再扣除系统提示与工具定义的固定开销
  // （否则固定约 3k+ token 会把小窗口模型直接撑爆，且工具循环回填会持续膨胀）
  const window = Math.min(Math.max(config.contextWindow ?? 128000, 2000), 2_000_000);
  const threshold = Math.min(Math.max(config.compressThreshold ?? 0.8, 0.5), 0.95);
  const budget = Math.max(Math.round(window * threshold) - fixedOverheadTokens(), 300);
  const apiHistory = selectHistory(history, budget, config.autoCompress ?? false);

  // 组装 API 消息：系统提示词 + 历史（预算内）+ 本次用户输入
  const apiMessages: ApiMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  for (const m of apiHistory) {
    const content = extractText(m).slice(0, MAX_MESSAGE_CHARS);
    apiMessages.push({ role: m.role, content: content || null });
  }
  apiMessages.push({ role: 'user', content: text.slice(0, 8000) });

  /** 估算当前全部消息的 token 用量（含工具定义） */
  const usedTokens = () =>
    fixedOverheadTokens() +
    apiMessages.reduce((acc, m) => {
      let n = estimateTokens(m.content ?? '') + PER_MESSAGE_OVERHEAD;
      if (m.tool_calls) n += estimateTokens(JSON.stringify(m.tool_calls));
      return acc + n;
    }, 0);

  /**
   * 上下文护栏：工具回填导致超预算时，把最老的中间消息压缩为一条摘要。
   * 必须落在完整轮次边界：从最后一个带 tool_calls 的 assistant 起整体保留
   * （tool 消息不能脱离其 assistant 孤立存在，否则 API 400）。
   * 返回 true = 压缩后仍超预算（极小窗口）或未开启自动压缩，调用方应中止工具循环。
   */
  const guardContext = (): boolean => {
    if (usedTokens() <= budget) return false;
    // 未开启自动压缩：尊重用户配置，不悄悄压缩早期消息（宁可停止工具循环）
    if (!config.autoCompress) return true;
    // 找最后一个带 tool_calls 的 assistant：从它开始保留（含其全部 tool 结果）
    let cut = apiMessages.length;
    for (let i = apiMessages.length - 1; i > 0; i--) {
      if (apiMessages[i]!.tool_calls && apiMessages[i]!.tool_calls!.length > 0) {
        cut = i;
        break;
      }
    }
    const body = apiMessages.slice(1, cut);
    if (body.length > 0) {
      const summaryText = `【早期对话摘要】\n${body
        .map((m) => (m.content ?? '').slice(0, 200))
        .join('\n')
        .slice(0, 2500)}`;
      apiMessages.splice(1, body.length, { role: 'user', content: summaryText });
    }
    return usedTokens() > budget;
  };

  let consecutiveToolErrors = 0;
  let lastCallSignature: string | null = null;
  let repeatRounds = 0;
  // 工具调用轮数无上限：只有「最终回答 / 死循环检测 / 连续失败保护」三个出口
  for (;;) {
    let turn: { content: string; toolCalls: ApiToolCall[] };
    try {
      turn = await chatCompletion(config, apiMessages, TOOL_DEFINITIONS, signal, {
        onText: (t) => safePost(onEvent, { type: 'chat:delta', messageId, text: t }),
        onToolCall: (tc) =>
          safePost(onEvent, {
            type: 'chat:tool_start',
            messageId,
            record: { id: tc.id, name: tc.function.name, args: tc.function.arguments, status: 'running' },
          }),
        // 自动重连进度：在回复中追加提示（重试成功后会继续输出，用户可感知恢复过程）
        onRetry: (attempt) =>
          safePost(onEvent, { type: 'chat:delta', messageId, text: `\n（请求失败，正在自动重试 ${attempt}/5…）` }),
      });
    } catch (e) {
      if (signal.aborted) {
        safePost(onEvent, { type: 'chat:cancelled', messageId });
        return;
      }
      throw e instanceof ChatError ? e : new ChatError(e instanceof Error ? `AI 请求失败：${e.message}` : 'AI 请求失败，请检查网络与配置。');
    }

    // 记录 assistant 轮次（含 tool_calls，供 tool 结果配对）；无工具调用时省略空字段
    apiMessages.push(
      turn.toolCalls.length > 0
        ? { role: 'assistant', content: turn.content || null, tool_calls: turn.toolCalls }
        : { role: 'assistant', content: turn.content || null },
    );

    // 无工具调用 → 最终回答，结束
    if (turn.toolCalls.length === 0) {
      safePost(onEvent, { type: 'chat:done', messageId });
      return;
    }

    // 死循环检测：连续多轮调用完全相同的工具+参数组合（模型空转的典型模式），
    // 判定后中止并告知，而不是让安全阀（MAX_TOOL_LOOPS）白烧请求
    const sig = turn.toolCalls
      .map((tc) => `${tc.function.name}|${tc.function.arguments}`)
      .join(';;');
    if (sig === lastCallSignature) repeatRounds++;
    else {
      repeatRounds = 0;
      lastCallSignature = sig;
    }
    if (repeatRounds >= MAX_REPEAT_CALLS) {
      safePost(onEvent, {
        type: 'chat:delta',
        messageId,
        text: '\n（检测到重复的工具调用，已停止以避免空转；如确实需要继续，请换种说法重试）',
      });
      safePost(onEvent, { type: 'chat:done', messageId });
      return;
    }

    // 执行工具：读类工具并行（互不依赖，显著提速），写类工具串行（避免竞争），按原顺序回填
    const ordered = turn.toolCalls.map((tc, i) => ({ tc, i }));
    const results = new Map<number, { out?: ToolOutput; error?: string }>();
    for (const { tc } of ordered) {
      safePost(onEvent, {
        type: 'chat:tool_start',
        messageId,
        record: { id: tc.id, name: tc.function.name, args: tc.function.arguments, status: 'running' },
      });
    }
    const runOne = async (
      tc: ApiToolCall,
    ): Promise<{ out?: ToolOutput; error?: string }> => {
      try {
        return {
          out: await executeTool(tc.function.name, tc.function.arguments, (text) => {
            // 长任务进度：转发为 tool_progress 事件（工具块实时显示，同时构成 SW 活跃信号）
            safePost(onEvent, { type: 'chat:tool_progress', messageId, recordId: tc.id, text });
          }),
        };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    };
    // 读类工具并行
    await Promise.all(
      ordered
        .filter(({ tc }) => READ_TOOLS.has(tc.function.name))
        .map(async ({ tc, i }) => {
          results.set(i, await runOne(tc));
        }),
    );
    // 写类工具串行（保持执行顺序，避免移动/创建竞争）
    for (const { tc, i } of ordered) {
      if (READ_TOOLS.has(tc.function.name)) continue;
      results.set(i, await runOne(tc));
    }
    // 按原顺序发送结果事件并回填模型
    let roundErrors = 0;
    for (const { tc, i } of ordered) {
      const r = results.get(i);
      if (r?.out) {
        const truncated = r.out.result.length > MAX_TOOL_RESULT_CHARS;
        const content =
          r.out.result.slice(0, MAX_TOOL_RESULT_CHARS) +
          (truncated ? '\n（结果过长已截断：请用 offset/maxItems 分页获取剩余部分）' : '');
        const record: ToolCallRecord = {
          id: tc.id,
          name: tc.function.name,
          args: tc.function.arguments,
          status: 'done',
          result: content,
          deletions: r.out.deletions,
        };
        safePost(onEvent, { type: 'chat:tool_done', messageId, record });
        apiMessages.push({ role: 'tool', tool_call_id: tc.id, content });
      } else {
        roundErrors++;
        const msg = r?.error ?? '执行失败';
        const record: ToolCallRecord = {
          id: tc.id,
          name: tc.function.name,
          args: tc.function.arguments,
          status: 'error',
          error: msg,
        };
        safePost(onEvent, { type: 'chat:tool_error', messageId, record });
        apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: `执行失败：${msg}` });
      }
    }

    // 收敛保护：整轮工具全部失败且连续 2 轮 → 停止，避免模型反复重试同一错误白烧请求
    if (roundErrors === ordered.length) {
      consecutiveToolErrors++;
      if (consecutiveToolErrors >= 2) {
        safePost(onEvent, { type: 'chat:delta', messageId, text: '\n（工具执行连续失败，已停止，请换个说法重试）' });
        safePost(onEvent, { type: 'chat:done', messageId });
        return;
      }
    } else {
      consecutiveToolErrors = 0;
    }

    // 上下文护栏：本轮回填后超预算 → 压缩早期消息（压缩到完整轮次边界）
    if (guardContext()) {
      // 压缩后仍超预算（极小上下文窗口）：继续压缩只会让模型失去有效上下文，提前结束
      safePost(onEvent, {
        type: 'chat:delta',
        messageId,
        text: '\n（上下文空间不足，已停止工具调用；可在设置页调大模型上下文长度后重试）',
      });
      safePost(onEvent, { type: 'chat:done', messageId });
      return;
    }
  }
}

/** Port 断开后 postMessage 会抛错，这里静默吞掉 */
function safePost(onEvent: (e: ChatOutbound) => void, event: ChatOutbound): void {
  try {
    onEvent(event);
  } catch {
    // UI 侧已断开，忽略
  }
}
