/** ── Agent 主循环：流式对话 + 工具调用循环 ── */

import { chatCompletion, ChatError, type ApiMessage, type ApiToolCall } from './client';
import { formatMemoriesForPrompt, getMemories, type MemoryItem } from './memory';
import { personalInstruction } from '@/lib/pet/personal';
import { buildTimeContext, PLAN_MODE_INSTRUCTION, SYSTEM_PROMPT, TOOL_DEFINITIONS } from './prompts';
import { executeTool, TOOL_META, type ToolOutput } from './tools';
import { applyPlan, buildPlan, classifyTool, stepCountOf, type PlannedStep } from './turn-plan';
// 只读/写/声明/闸门的分类**只有 turn-plan 一份**：历史上同一份名单抄成两份，
// 结果一份加了新工具、另一份没加——并行集合与确认集合开始互相矛盾，谁也说不清哪份是真的。
import { MAX_CONTEXT_WINDOW, MIN_CONTEXT_WINDOW } from '@/lib/providers';
import { beginUndoTransaction, endUndoTransaction, setRecordingOwner, takeDroppedOpCount } from '@/lib/undo/recorder';
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
/** 支持 offset 翻页的工具：截断提示只能对这些说"用 offset 继续" */
/**
 * 支持 offset 分页的**写类/列表**工具。截断提示据它分流：
 * 在集合里说「请用 offset 分页」，不在就说「请收窄查询」。
 *
 * 这份名单必须与各工具 schema 里的 `offset` 参数**严格一致**：
 * zod 对未知键是**静默剥离**，模型传了不收的 offset 不会报错，
 * 而是拿到和第一次一模一样的页——它以为自己翻页了，实际在原地打转。
 * （`get_folder_content` 就因为被误列在这里踩过：它只有 limit/depth，没有 offset。）
 */
const PAGINATED_TOOLS: ReadonlySet<string> = new Set([
  'list_bookmarks',
  'list_all_folders',
  'cleanup_sweep',
  'export_bookmarks',
]);
/** 每条消息的固定开销（角色标记、元数据等） */
const PER_MESSAGE_OVERHEAD = 40;

/** 只读工具：可并行执行（无副作用，互不依赖） */


export interface AgentTurnParams {
  config: AIConfig;
  messageId: string;
  history: ChatMessage[];
  text: string;
  signal: AbortSignal;
  onEvent: (event: ChatOutbound) => void;
  /**
   * 计划模式下请求用户确认；返回是否批准。
   * **未注入时视为"未批准"**——安全默认是"不执行"，而不是"悄悄全做了"。
   * 生产实现由 background 注入（UI 侧是第三片）。
   */
  requestPlanApproval?: (plan: PlannedStep[], messageId: string) => Promise<boolean>;
  /** 长期记忆项（可选，未传时自动从存储中读取） */
  memories?: MemoryItem[];
}

/**
 * 从本回次的工具调用里读出模型声明的整轮计划（`submit_plan` 的参数）。
 * 解析失败就当作"没有声明"——退回逐回次确认，绝不因为解析问题而放行。
 */
function parseDeclaredPlan(
  ordered: { tc: ApiToolCall }[],
): { tool: string; summary?: string; count?: number }[] {
  for (const { tc } of ordered) {
    if (tc.function.name !== 'submit_plan') continue;
    try {
      const raw = JSON.parse(tc.function.arguments || '{}') as {
        steps?: { tool?: unknown; summary?: unknown; count?: unknown }[];
      };
      if (!Array.isArray(raw.steps)) return [];
      const out: { tool: string; summary?: string; count?: number }[] = [];
      for (const st of raw.steps) {
        if (typeof st?.tool !== 'string' || !st.tool) continue;
        // 只接受真正的写类工具名：声明读类/闸门类没有意义，也不该换来豁免
        if (classifyTool(st.tool) !== 'write') continue;
        out.push({
          tool: st.tool,
          ...(typeof st.summary === 'string' && st.summary ? { summary: st.summary } : {}),
          ...(typeof st.count === 'number' ? { count: st.count } : {}),
        });
      }
      return out;
    } catch {
      return [];
    }
  }
  return [];
}

/** 提取消息纯文本 */
function extractText(m: ChatMessage): string {
  return m.blocks
    .filter((b): b is { kind: 'text'; text: string } => b.kind === 'text')
    .map((b) => b.text)
    .join('');
}

/** 历史里每条工具结果的转写上限（保留结论，丢掉逐条 JSON） */
const TOOL_RECORD_CHARS = 160;

/**
 * 取出「可发送给模型的历史文本」：正文 + **工具结果的摘要**（不含思考）。
 *
 * 为什么不能只发正文：实测 200 轮对话里工具结果占可发送内容的 **66.1%**，
 * 它们全部被丢掉 —— 模型只看到三分之一的对话，于是用户问「刚才那些重复的」
 * 它答不上来，只能重查一遍（多一次往返）。这就是"不记事"的根因。
 *
 * 为什么不能直接把 tool 块发出去：历史里的 tool 消息没有配对的 `tool_call_id`，
 * OpenAI 协议会直接 400。所以转写成一条**普通文本**，保留"查了什么、得到多少、结论是什么"，
 * 丢掉逐条 JSON（那才是 token 大头）。
 */
export function extractHistoryText(m: ChatMessage): string {
  const text = extractText(m);
  const records = m.blocks.flatMap((b) => (b.kind === 'tool' ? [b.record] : []));
  if (records.length === 0) return text;
  const lines = records.map((r) => {
    const status = r.status === 'done' ? '' : `（${r.status}）`;
    const payload = (r.result ?? r.error ?? '').replace(/\s+/g, ' ').trim().slice(0, TOOL_RECORD_CHARS);
    return `[工具 ${r.name}${status}] ${payload}${payload.length === TOOL_RECORD_CHARS ? '…' : ''}`;
  });
  return [text, ...lines].filter(Boolean).join('\n');
}

/**
 * 估算文本 token 数（中英混合近似）：
 * 中文/全角约 0.75 token/字（主流 tokenizer 实测区间），假名/谚文约 1 token，其他约 1/4 token。
 */
export function estimateTokens(text?: string): number {
  if (!text) return 0;
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

/** 固定开销估算：系统提示词 + 工具定义 schema + 长期记忆（不在历史预算内，需从窗口预算中扣除） */
export function fixedOverheadTokens(memories?: MemoryItem[]): number {
  const memStr = memories ? formatMemoriesForPrompt(memories) : '';
  return (
    estimateTokens(SYSTEM_PROMPT) +
    estimateTokens(PLAN_MODE_INSTRUCTION) +
    estimateTokens(memStr) +
    estimateTokens(JSON.stringify(TOOL_DEFINITIONS)) +
    100
  );
}

/**
 * 估算一组 API 消息实际发送给模型的 token 用量（含工具定义）。
 *
 * 系统提示词本身就在 `apiMessages[0]` 里，所以这里**不能**再叠加 `fixedOverheadTokens()`：
 * 那会把系统提示词重复计入（曾把预算高估数千 token，导致工具循环过早触发上下文护栏）。
 * 工具定义不在 messages 内，因此单独计入。
 */
export function estimateRequestTokens(apiMessages: ApiMessage[]): number {
  return (
    estimateTokens(JSON.stringify(TOOL_DEFINITIONS)) +
    apiMessages.reduce((acc, m) => {
      let n = estimateTokens(m.content ?? '') + PER_MESSAGE_OVERHEAD;
      if (m.tool_calls) n += estimateTokens(JSON.stringify(m.tool_calls));
      return acc + n;
    }, 0)
  );
}

/**
 * 按 token 预算选择历史消息（从最新往回累积）：
 * - 单条消息截断到 MAX_MESSAGE_CHARS 字符
 * - 预算用尽后停止；至少保留最近 1 条
 * - autoCompress 开启时，超预算的早期消息合并为摘要（占用固定小预算）
 */
export function selectHistory(
  history: ChatMessage[],
  budget: number,
  autoCompress: boolean,
): ChatMessage[] {
  if (history.length === 0) return [];
  const selected: ChatMessage[] = [];
  let used = 0;
  for (const m of [...history].reverse()) {
    const full = extractHistoryText(m);
    let text = full.slice(0, MAX_MESSAGE_CHARS);
    let cut = full.length > text.length;
    let cost = estimateTokens(text) + PER_MESSAGE_OVERHEAD;
    // 单条消息自身超预算（极小窗口）：截断到预算的一半，保证能纳入最近一条
    if (selected.length === 0 && cost > budget) {
      const maxChars = Math.max(100, Math.floor((budget / 2) / 0.75));
      if (maxChars < text.length) {
        text = text.slice(0, maxChars);
        cut = true;
      }
      cost = estimateTokens(text) + PER_MESSAGE_OVERHEAD;
    }
    if (selected.length > 0 && used + cost > budget) break;
    /*
     * 单条消息被截断时**必须留下痕迹**。
     *
     * 原来直接换成一个截断文本的新消息对象，没有任何标记——模型看到一条
     * 半句话戛然而止的消息，却不知道它被切过。
     * 最常见的场景：用户粘一份几百条的书签清单（远超 6000 字符），
     * 模型只读到前 6000 字符，然后自信地说「我已看过你列的 500 条」。
     * 用户完全有理由相信它看全了——那是他刚发出去的消息。
     */
    if (cut) {
      text = `${text}\n[…该消息原有 ${full.length} 字符，此处因上下文限制只发送了前 ${text.length} 字符，内容被截断]`;
    }
    selected.unshift(text === full ? m : { ...m, blocks: [{ kind: 'text', text }] });
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
  } else if (selected.length < history.length) {
    /*
     * 没开 autoCompress（**默认就是关的**）时，超预算的早期消息被直接丢掉。
     *
     * 原来这里静默返回：模型只看到最近几条，**它自己不知道还有更早的**。
     * 用户那边的症状是「我前面说过别动那个文件夹，你怎么还搬」——
     * 而模型并不是不听，是那条消息根本没进它的上下文。
     * 不说清楚，模型只会基于不完整信息自信地行动，用户以为它忘了自己的话。
     *
     * 所以塞一条系统说明进去：让模型知道有缺失，被问到早期内容时如实说"我看不到"，
     * 而不是猜或者硬答。
     */
    const dropped = history.length - selected.length;
    selected.unshift({
      id: 'context-truncated',
      role: 'user',
      blocks: [
        {
          kind: 'text',
          text:
            `【系统提示】本次请求因上下文窗口限制，只包含了最近 ${selected.length} 条消息，` +
            `更早的 ${dropped} 条消息未包含在内。` +
            `如果用户引用了更早的对话内容（例如"我之前说过…"），请如实说明你看不到那段对话，` +
            `不要猜测其内容，也不要假装记得。`,
        },
      ],
      createdAt: 0,
    });
  }
  return selected;
}

/**
 * 运行一轮 Agent 对话：
 * 流式输出 → 解析工具调用 → 执行并回填 → 继续，直到模型给出最终回答。
 *
 * 一轮 = 一个撤销点：期间所有写操作都被记进操作日志（src/lib/undo），
 * 结束后落盘；正常返回、抛错、被取消都走同一个 finally，不会漏记。
 */
export async function runAgentTurn(params: AgentTurnParams): Promise<void> {
  await beginUndoTransaction(params.messageId);
  try {
    await runAgentTurnInner(params);
  } finally {
    /*
     * 只收尾**自己**这一轮的事务：被抢占后迟到苏醒时不得把新轮次的事务一起关掉。
     *
     * 同时标出这一轮是不是被取消结束的——撤销历史里要能区分
     * 「完整做完的一步」和「取消掉的半步」，否则用户取消后回头看历史，
     * 看到两条「移动 4 项」无从确认哪条是刚才那半步。
     */
    await endUndoTransaction(params.messageId, { interrupted: params.signal.aborted });
  }
}

async function runAgentTurnInner(params: AgentTurnParams): Promise<void> {
  const { config, messageId, history, text, signal, onEvent } = params;

  // 读取长期记忆并注入系统提示词（跨会话持久规则与偏好）
  let activeMemories: MemoryItem[] = [];
  try {
    activeMemories = params.memories ?? (await getMemories());
  } catch {
    activeMemories = [];
  }
  const memoryPrompt = formatMemoriesForPrompt(activeMemories);

  // 上下文预算 = 用户填写的模型上下文长度 × 压缩阈值，再扣除系统提示与工具定义的固定开销
  // （否则固定约 3k+ token 会把小窗口模型直接撑爆，且工具循环回填会持续膨胀）
  const window = Math.min(Math.max(config.contextWindow ?? 128000, MIN_CONTEXT_WINDOW), MAX_CONTEXT_WINDOW);
  const threshold = Math.min(Math.max(config.compressThreshold ?? 0.8, 0.5), 0.95);
  const budget = Math.max(Math.round(window * threshold) - fixedOverheadTokens(activeMemories), 300);
  const apiHistory = selectHistory(history, budget, config.autoCompress ?? false);

  // 组装 API 消息：系统提示词 + 长期记忆 + 历史（预算内）+ 本次用户输入
  // 计划模式：把"先声明整轮计划"的流程要求写进系统提示（工具说明只讲工具是什么，
  // 流程要求必须在系统提示里说；声明没做也不影响安全，只是确认次数会变多）
  const baseSystem =
    config.planMode === true ? SYSTEM_PROMPT + PLAN_MODE_INSTRUCTION : SYSTEM_PROMPT;
  /*
   * 时间上下文每次请求都重新生成（不是模块级常量）：
   * 侧边栏可能开着一整天，跨过午夜后"今天"必须跟着变。
   */
  const systemContent = baseSystem + buildTimeContext() + memoryPrompt + personalInstruction(config);
  const apiMessages: ApiMessage[] = [{ role: 'system', content: systemContent }];
  for (const m of apiHistory) {
    /*
     * 这里**不能再 slice**。
     *
     * `selectHistory` 已经把每条消息收窄到 MAX_MESSAGE_CHARS 以内，所以这行切片
     * 对普通消息是空操作——它唯一的实际作用是把 `selectHistory` 追加的
     * 「内容被截断」标记切掉（标记接在 6000 字符之后），让模型重新看不到"被切过"。
     * 0.2.125 修的就是这个：加了标记却被下一行悄悄抹掉。
     */
    const content = extractHistoryText(m);
    apiMessages.push({ role: m.role, content: content || null });
  }
  /*
   * 当前这条用户消息也有长度上限，但**不能静默切**。
   *
   * 用户当场粘一份长清单是最常见的场景，而聊天界面显示的是**完整**消息
   * （存在 store 里、原样渲染）——于是"用户看到的"和"模型看到的"静默不一致：
   * 用户指着自己刚发的那段话提问，模型却只读过前 8000 字符。
   * 不标记的话，模型只会基于半边信息自信作答（0.2.125 同一条思路）。
   */
  const MAX_TEXT_CHARS = 8000;
  const userText =
    text.length > MAX_TEXT_CHARS
      ? `${text.slice(0, MAX_TEXT_CHARS)}\n[…你发送的这条消息原有 ${text.length} 字符，此处因长度限制只发送了前 ${MAX_TEXT_CHARS} 字符，内容被截断。如你的问题依赖被截掉的部分，请把相关内容缩短后重新发送。]`
      : text;
  apiMessages.push({ role: 'user', content: userText });

  /** 估算当前全部发送给模型的 token 用量（系统提示已含在 apiMessages 内，不重复计入固定开销） */
  const usedTokens = () => estimateRequestTokens(apiMessages);

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
  /**
   * 整轮预授权（planMode）：模型可用 `submit_plan` 先把整轮打算做的写操作说清，
   * 用户确认一次即覆盖整轮，不必每个回次都问。
   *
   * **它不是安全边界**：只有"已声明且被批准"的**工具名**才免于再次确认；
   * 未声明的写操作照样走逐回次确认（见下面的写循环）。取消则整轮零写入。
   */
  let turnGrant: { approved: boolean; tools: Map<string, number | null> } | null = null;

  /**
   * 这一步是否落在"已批准范围"内。
   *
   * 为什么不能只看工具名：用户批准的依据是计划卡片上的**规模**（"移动 3 条"）。
   * 如果只按工具名豁免，模型声明 3 条却实际移动 200 条也会被静默放行——
   * 那是把"超出授权范围"说成了"已批准"。
   * - 未声明的工具 → 不豁免；
   * - 声明了工具但**没声明条数** → 按工具名豁免（上限无从谈起），卡片会如实写"条数未声明"；
   * - 声明了条数 → 实际规模**超过**上限即不豁免，退回逐回次确认。
   */
  const withinGrant = (name: string, argsJson: string): boolean => {
    if (!turnGrant?.approved) return false;
    const declared = turnGrant.tools.get(name);
    if (declared === undefined) return false;
    if (declared === null) return true;
    return stepCountOf(argsJson) <= declared;
  };

  for (;;) {
    let turn: { content: string; toolCalls: ApiToolCall[] };
    try {
      turn = await chatCompletion(config, apiMessages, TOOL_DEFINITIONS, signal, {
        onText: (t) => safePost(onEvent, { type: 'chat:delta', messageId, text: t }),
        // 思考内容单独投递：UI 要把它放进可折叠的思考区，不能与正文混在一起
        onReasoning: (t) => safePost(onEvent, { type: 'chat:reasoning', messageId, text: t }),
        onToolCall: (tc) =>
          safePost(onEvent, {
            type: 'chat:tool_start',
            messageId,
            record: {
            id: tc.id,
            name: tc.function.name,
            args: tc.function.arguments,
            status: 'running',
            startedAt: Date.now(),
          },
          }),
        // 重发前先让 UI 作废上一轮的半截文本：否则重试成功后的回复会接在残文后面
        onRestart: () => safePost(onEvent, { type: 'chat:restart', messageId }),
        /*
         * 重试不再往正文里塞一行字。
         * 那一行会进入消息正文、被复制、被当成模型说的话；现在只发状态事件，
         * UI 在头部显示「重试 2/5 · 4s」，正文保持干净。
         */
        onRetry: () => {},
        onStatus: (status) =>
          safePost(onEvent, {
            type: 'chat:status',
            messageId,
            phase: status.phase,
            ...(status.detail ? { detail: status.detail } : {}),
            ...(status.attempt !== undefined ? { attempt: status.attempt } : {}),
            startedAt: status.startedAt ?? Date.now(),
          }),
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
    const toolStartedAt = new Map<string, number>();
    for (const tc of turn.toolCalls) toolStartedAt.set(tc.id, Date.now());
    const runOne = async (
      tc: ApiToolCall,
    ): Promise<{ out?: ToolOutput; error?: string }> => {
      try {
        /*
         * 取消必须能停住工具。
         *
         * 原来 abort 信号只传给了 LLM 请求，`executeTool` 完全拿不到。用户在
         * cleanup_sweep 扫几千条链接时点「停止」，这一次工具会**跑到底**——
         * 书签照搬、删除提议照提交，而用户已经看到「已取消」。
         *
         * 两道闸：
         *   ① 开跑前查一次：把越界压到"最多一个工具"以内；
         *   ② 进度回调里查：批量任务（cleanup_sweep / check_urls_bulk /
         *      auto_categorize）每处理一批都会调 onProgress，在这里抛出让它们中途真停。
         */
        if (signal.aborted) return { error: '已取消，这一步没有执行' };
        /*
         * 声明"这一轮正在记账"：两个窗口同时跑时，被抢占的那一轮后续操作不能
         * 落进新轮次的事务（否则在另一个窗口点撤销会撤错对象）。
         */
        setRecordingOwner(messageId);
        try {
        return {
          out: await executeTool(tc.function.name, tc.function.arguments, (text) => {
            // 长任务进度：转发为 tool_progress 事件（工具块实时显示，同时构成 SW 活跃信号）
            safePost(onEvent, { type: 'chat:tool_progress', messageId, recordId: tc.id, text });
            if (signal.aborted) throw new Error('已取消，任务中断');
          }, signal),
        };
        } finally {
          setRecordingOwner(null);
        }
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    };
    /*
     * 工具心跳：没有进度回调的工具（move_bookmarks / merge_folders 等）也要让 UI 知道
     * "还在跑"。每 4 秒发一次当前工具名与开始时间；UI 用 startedAt 自己算秒数。
     */
    const toolStartedAt0 = Date.now();
    let toolDetail = ordered.map(({ tc }) => TOOL_META[tc.function.name]?.label ?? tc.function.name).join('、');
    safePost(onEvent, {
      type: 'chat:status',
      messageId,
      phase: 'tool',
      detail: toolDetail,
      startedAt: toolStartedAt0,
    });
    let roundErrors = 0;
    const toolHeartbeat = setInterval(() => {
      safePost(onEvent, {
        type: 'chat:status',
        messageId,
        phase: 'tool',
        detail: toolDetail,
        startedAt: toolStartedAt0,
      });
    }, 4000);
    try {
    // 读类工具并行
    await Promise.all(
      ordered
        .filter(({ tc }) => classifyTool(tc.function.name) === 'read')
        .map(async ({ tc, i }) => {
          results.set(i, await runOne(tc));
        }),
    );
    const planEnabled = params.config.planMode === true;

    // 声明类工具（submit_plan）只记录、零副作用，先执行它们
    for (const { tc, i } of ordered) {
      if (classifyTool(tc.function.name) === 'declare') {
        results.set(i, await runOne(tc));
      }
    }

    // 本轮（或更早回次）声明了计划，且整轮还没有决定 → 申请一次整轮授权
    if (planEnabled && turnGrant === null) {
      const declared = parseDeclaredPlan(ordered);
      if (declared.length > 0) {
        const steps = buildPlan(
          declared.map((d) => ({ name: d.tool, args: JSON.stringify({ ...(d.count !== undefined ? { count: d.count } : {}) }) })),
        ).map((p, idx) => ({ ...p, summary: declared[idx]?.summary ?? p.summary }));
        safePost(onEvent, { type: 'chat:plan', messageId, steps });
        toolDetail = '等待你确认计划';
        safePost(onEvent, { type: 'chat:status', messageId, phase: 'tool', detail: toolDetail, startedAt: toolStartedAt0 });
        let approved = false;
        if (params.requestPlanApproval) {
          try {
            approved = await params.requestPlanApproval(steps, messageId);
          } catch {
            approved = false;
          }
        }
        // 记录每个工具**已批准的规模上限**（模型没声明条数时记 null = 无上限，卡片会说明）
        turnGrant = {
          approved,
          tools: new Map(declared.map((d) => [d.tool, typeof d.count === 'number' ? d.count : null])),
        };
      }
    }

    // 已授权则按"工具名是否在声明里"豁免逐回次确认；未声明的一律仍需确认。
    // 为什么保留逐回次确认：模型可能临时调用计划外的工具——把安全边界交给模型自觉是不行的。
    const plannedWrites = planEnabled
      ? ordered.filter(
          ({ tc }) =>
            classifyTool(tc.function.name) === 'write' &&
            !withinGrant(tc.function.name, tc.function.arguments),
        )
      : [];
    /**
     * 本回次里"声明过、但实际规模超出上限"的写操作：它们要走逐回次确认，
     * 并在卡片上**说明为什么要再问一次**（否则用户会以为程序在无故重复打断）。
     */
    const overLimitNames = new Set(
      plannedWrites
        .filter(({ tc }) => turnGrant?.approved && turnGrant.tools.has(tc.function.name))
        .map(({ tc }) => tc.function.name),
    );

    /**
     * 执行本回次的计划：**确认前零执行**；未获批准时零执行并把"未执行"如实回填给模型
     * （否则模型会以为已经做完，继续往下编）。
     */
    const runPlannedWrites = async (): Promise<void> => {
      const steps = buildPlan(
        plannedWrites.map(({ tc }) => ({ name: tc.function.name, args: tc.function.arguments })),
      ).map((st) =>
        overLimitNames.has(st.name)
          ? { ...st, summary: `超出已批准范围，需再确认：${st.summary}` }
          : st,
      );
      if (steps.length === 0) return;
      safePost(onEvent, { type: 'chat:plan', messageId, steps });
      let approved = false;
      if (params.requestPlanApproval) {
        try {
          approved = await params.requestPlanApproval(steps, messageId);
        } catch {
          approved = false;
        }
      }
      if (!approved) {
        for (const { i } of plannedWrites) {
          results.set(i, { error: '用户取消了本次计划，这一步没有执行（请勿假设它已生效）' });
        }
        return;
      }
      await applyPlan(
        steps,
        async (step) => {
          const target = plannedWrites[steps.indexOf(step)];
          if (!target) return;
          const r = await runOne(target.tc);
          results.set(target.i, r);
          if (r.error) throw new Error(r.error);
        },
        { confirmed: true },
      );
    };

    // 写类工具串行（保持执行顺序，避免移动/创建竞争）
    let planDone = false;
    for (const { tc, i } of ordered) {
      if (classifyTool(tc.function.name) === 'read') continue;
      if (classifyTool(tc.function.name) === 'declare') continue; // 已在上面执行过
      const cls = classifyTool(tc.function.name);
      if (planEnabled && cls === 'write') {
        // 整轮计划被取消 → 本轮**所有**写操作都被阻断（不只是第一回次），并如实回填
        if (turnGrant && !turnGrant.approved) {
          results.set(i, { error: '用户取消了本轮计划，这一步没有执行（请勿假设它已生效）' });
          continue;
        }
        // 已声明的写操作：授权已覆盖，直接执行（不再逐个确认）
        if (withinGrant(tc.function.name, tc.function.arguments)) {
          results.set(i, await runOne(tc));
          continue;
        }
        // 未声明的写操作：仍在第一个待执行写操作的位置整体走逐回次确认
        if (!planDone) {
          planDone = true;
          await runPlannedWrites();
        }
        continue;
      }
      results.set(i, await runOne(tc));
    }
    // 按原顺序发送结果事件并回填模型
    roundErrors = 0;
    for (const { tc, i } of ordered) {
      const r = results.get(i);
      if (r?.out) {
        const truncated = r.out.result.length > MAX_TOOL_RESULT_CHARS;
        /*
         * 截断提示要**按工具给可行的补救**。
         *
         * 原来一律写「请用 offset/maxItems 分页获取剩余部分」——但不是每个工具都有
         * offset（search_bookmarks 就没有）。模型照做会撞上参数校验错误，白跑一轮。
         * 对不能翻页的工具，唯一可行的是把条件收窄。
         */
        const paginated = PAGINATED_TOOLS.has(tc.function.name);
        const hint = truncated
          ? paginated
            ? `\n（结果过长已截断：请用 offset 分页获取剩余部分${tc.function.name === 'list_bookmarks' ? '（并可调大 limit）' : ''}）`
            : `\n（结果过长已截断：该工具不支持分页，请把查询条件收窄（更具体的关键词/更小的文件夹）后再查一次）`
          : '';
        const content = r.out.result.slice(0, MAX_TOOL_RESULT_CHARS) + hint;
        const record: ToolCallRecord = {
          id: tc.id,
          name: tc.function.name,
          args: tc.function.arguments,
          status: 'done',
          result: content,
          deletions: r.out.deletions,
          startedAt: toolStartedAt.get(tc.id),
          durationMs: Date.now() - (toolStartedAt.get(tc.id) ?? Date.now()),
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
          status: signal.aborted ? 'canceled' : 'error',
          error: msg,
          startedAt: toolStartedAt.get(tc.id),
          durationMs: Date.now() - (toolStartedAt.get(tc.id) ?? Date.now()),
        };
        safePost(onEvent, { type: 'chat:tool_error', messageId, record });
        apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: `执行失败：${msg}` });
      }
    }

    } finally {
      clearInterval(toolHeartbeat);
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
      // 压缩后仍超预算：继续压缩只会让模型失去有效上下文，提前结束。
      // 提示必须给对方向——旧文案让用户"调大上下文长度"，而窗口本来就是按模型真实能力
      // 取的（128K 的模型拿到过 1M 预算正是这个护栏失效的成因），再调大只会更糟。
      const hint = config.autoCompress
        ? '；可在设置页把「自动压缩阈值」调低一些'
        : '；可在设置页开启「自动压缩上下文」';
      safePost(onEvent, {
        type: 'chat:delta',
        messageId,
        text: `\n（上下文空间不足，已停止工具调用：当前窗口约 ${Math.round(window / 1000)}K tokens${hint}；或改用上下文更大的模型后重试）`,
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
