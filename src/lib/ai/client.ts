/** ── OpenAI 兼容 Chat Completions 客户端（流式 + 工具调用） ── */

import { normalizeBaseUrl } from '../providers';
import { createSseAccumulator, finalizeToolCalls, type StreamToolCall } from './stream';
import type { AIConfig } from './types';

/** AI 请求错误（携带用户可读的中文信息） */
export class ChatError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ChatError';
    this.status = status;
  }
}

/** 发送给 API 的消息（OpenAI 协议） */
export interface ApiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ApiToolCall[];
  tool_call_id?: string;
}

/** API 工具调用对象 */
export interface ApiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** 单轮完成的 assistant 结果 */
export interface AssistantTurn {
  content: string;
  toolCalls: ApiToolCall[];
}

/** 流式回调（由 Agent 循环转发给 UI） */
export interface StreamHandlers {
  onText: (text: string) => void;
  onToolCall: (toolCall: ApiToolCall) => void;
  /** 请求失败自动重试提示（attempt 从 1 开始） */
  onRetry?: (attempt: number) => void;
  /**
   * 重试会重发整轮、且上一轮已经吐出过内容时调用：
   * UI 必须把那段半截文本作废，否则两段回复会首尾相接（重复/看不懂的拼接）。
   */
  onRestart?: () => void;
}

/** 首字节超时：从发出请求到收到**第一个字节**（含推理模型的长思考） */
const FIRST_CHUNK_TIMEOUT = 120_000;
/** 空闲超时：两次数据之间的最大间隔（网关挂起、连接被掐断都落在这里） */
const IDLE_TIMEOUT = 60_000;
/** 失败自动重试次数（不含首次请求） */
const MAX_RETRIES = 5;
/** 指数退避基数：1s → 2s → 4s → 8s → 16s */
const RETRY_BASE_MS = 1000;

/** 可重试的错误：网络层（无 status）、限流 429、服务端 5xx。认证/参数/取消类不重试 */
export function isRetriableError(e: unknown): boolean {
  if (!(e instanceof ChatError)) return false;
  const status = e.status;
  if (status === undefined) return true; // 网络层错误 / 超时 / 传输中断
  if (status === 429) return true; // 限流：退避后重试
  return status >= 500;
}

/** 可中止的等待（用户取消时立即中断退避；signal 已中止则直接拒绝） */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ChatError('请求已取消', 499));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new ChatError('请求已取消', 499));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 活动式看门狗。
 *
 * 为什么不用「一个总超时盖全程」：那会把"生成得慢但一直在出字"和"连接已经死了"
 * 当成同一件事——长回复（大库整理、推理模型）会被硬生生掐断，而真正挂死的连接
 * 又要等满总时长才被发现。这里改成按活动计时：收到数据就重置，首字节与后续间隔分开配。
 */
class ActivityWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 是否由本看门狗触发的中断（区别于用户取消） */
  timedOut = false;
  /** 是否已收到过任何数据（用于区分"首字节超时"与"中途空闲超时"） */
  private received = false;

  constructor(
    private readonly ctrl: AbortController,
    private readonly firstMs: number,
    private readonly idleMs: number,
  ) {}

  private reset(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.ctrl.abort();
    }, ms);
  }

  /** 开始计时（首字节窗口） */
  arm(): void {
    this.reset(this.firstMs);
  }

  /** 收到数据：切到空闲窗口重新计时 */
  kick(): void {
    this.received = true;
    this.reset(this.idleMs);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** 超时文案：区分"一直没响应"与"回复中途断了" */
  timeoutMessage(): string {
    return this.received
      ? `AI 回复在传输过程中中断（超过 ${Math.round(this.idleMs / 1000)} 秒没有新数据）。`
      : `AI 服务在 ${Math.round(this.firstMs / 1000)} 秒内没有任何响应，请稍后重试。`;
  }
}

/**
 * 发送一轮 chat completion（优先流式，失败自动降级非流式重试一次；
 * 可恢复错误（网络/5xx/429/超时/传输中断）自动重连最多 MAX_RETRIES 次，指数退避）。
 * 所有网络请求都经由 background Service Worker 发出，无 CORS 限制。
 */
export async function chatCompletion(
  config: AIConfig,
  messages: ApiMessage[],
  tools: unknown[],
  signal: AbortSignal,
  handlers: StreamHandlers,
): Promise<AssistantTurn> {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!baseUrl) throw new ChatError('Base URL 未配置，请先在设置页填写。');
  if (!config.model) throw new ChatError('模型未配置，请先在设置页选择模型。');

  const url = `${baseUrl}/chat/completions`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  // 追踪"已投递给 UI 的内容"：重试前必须让 UI 作废它，否则两段回复会拼在一起
  let hasOutput = false;
  const wrappedHandlers: StreamHandlers = {
    onText: (t) => {
      hasOutput = true;
      handlers.onText(t);
    },
    onToolCall: (tc) => {
      hasOutput = true;
      handlers.onToolCall(tc);
    },
  };

  let retried = 0;
  for (;;) {
    try {
      return await requestStream(url, headers, config, messages, tools, signal, wrappedHandlers);
    } catch (e) {
      // 流式被拒绝（部分代理/旧端点不支持 stream:true）时，仅在尚无任何输出时降级为非流式重试一次；
      // 仅对「端点类」状态码降级（400/404/405），内容性错误（422+）重试只会浪费一次请求
      if (
        !hasOutput &&
        e instanceof ChatError &&
        e.status !== undefined &&
        [400, 404, 405].includes(e.status)
      ) {
        try {
          return await requestNonStream(url, headers, config, messages, tools, signal, wrappedHandlers);
        } catch (e2) {
          // 降级也失败：继续走外层重试判断
          if (!(e2 instanceof ChatError)) throw e2;
          e = e2;
        }
      }
      // 可恢复错误自动重连（用户取消的 499 不在重试范围）
      if (retried >= MAX_RETRIES || !isRetriableError(e)) throw e;
      retried++;
      // 已经吐出过半截内容：先让 UI 作废它，再重发整轮。
      // 不做这件事正是"回复中途断流后既没重试、又留着一段残文"的由来。
      if (hasOutput) {
        handlers.onRestart?.();
        hasOutput = false; // UI 已清空，后续可重新投递
      }
      handlers.onRetry?.(retried);
      await sleep(Math.min(RETRY_BASE_MS * 2 ** (retried - 1), 16_000), signal);
    }
  }
}

/** 流式请求 */
async function requestStream(
  url: string,
  headers: Record<string, string>,
  config: AIConfig,
  messages: ApiMessage[],
  tools: unknown[],
  signal: AbortSignal,
  handlers: StreamHandlers,
): Promise<AssistantTurn> {
  // 已中止的 signal 不会触发 addEventListener 回调，必须显式检查
  if (signal.aborted) throw new ChatError('请求已取消', 499);

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal.addEventListener('abort', onAbort);
  const watchdog = new ActivityWatchdog(ctrl, FIRST_CHUNK_TIMEOUT, IDLE_TIMEOUT);
  watchdog.arm();

  let accumulator: ReturnType<typeof createSseAccumulator> | null = null;

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.model,
          messages,
          tools,
          stream: true,
          temperature: 0.4,
        }),
        signal: ctrl.signal,
      });
    } catch (e) {
      if (watchdog.timedOut) throw new ChatError(watchdog.timeoutMessage());
      throw toNetworkError(e);
    }
    if (watchdog.timedOut) throw new ChatError(watchdog.timeoutMessage());
    if (!response.ok) throw await toHttpError(response);

    const reader = response.body?.getReader();
    if (!reader) throw new ChatError('AI 服务返回了空响应。');

    accumulator = createSseAccumulator({ onText: handlers.onText });

    for (;;) {
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch (e) {
        if (watchdog.timedOut) throw new ChatError(watchdog.timeoutMessage());
        throw e;
      }
      if (done) break;
      watchdog.kick(); // 收到数据 → 切到空闲窗口重新计时
      if (value) accumulator.push(value);
    }
  } catch (e) {
    if (signal.aborted) throw new ChatError('请求已取消', 499);
    if (e instanceof ChatError) throw e;
    if (watchdog.timedOut) throw new ChatError(watchdog.timeoutMessage());
    throw toNetworkError(e);
  } finally {
    watchdog.stop();
    signal.removeEventListener('abort', onAbort);
  }

  const result = accumulator!.end();

  /**
   * 流被中途掐断的判据：**没收到 [DONE]/finish_reason** 且 **工具调用参数是半截 JSON**。
   *
   * 两个条件缺一不可：
   * - 只按"没收到 [DONE]"判——不少兼容端点不发 [DONE] 也不带 finish_reason，会把正常回复误杀；
   * - 只按"参数不是合法 JSON"判——那是模型自己的输出问题，照常交给执行器报错即可，
   *   重试 5 次只会白烧请求。
   * 两者同时成立才是"传输断了"，且此时必须当**失败**处理：半截参数发出去会变成
   * 一个假的"未知工具/执行失败"，用户看到的就是agent莫名报错。
   */
  if (!result.completed && (!result.argsComplete || result.pendingTail)) {
    throw new ChatError('AI 回复在传输中被截断，工具调用参数不完整。');
  }
  // finish_reason=length：输出被 max_tokens 截断。不抛错（内容本身有效），但如实告警，
  // 免得把一段没说完的话当成完整回答。
  if (result.finishReason === 'length') {
    console.warn('[MarkAI] 模型输出被长度限制截断（finish_reason=length），回复可能不完整。');
  }

  const toolCalls = finalizeToolCalls(result.toolCalls as StreamToolCall[]);
  toolCalls.forEach((tc) => handlers.onToolCall(tc));
  return { content: result.content, toolCalls };
}

/** 非流式请求（降级路径） */
async function requestNonStream(
  url: string,
  headers: Record<string, string>,
  config: AIConfig,
  messages: ApiMessage[],
  tools: unknown[],
  signal: AbortSignal,
  handlers: StreamHandlers,
): Promise<AssistantTurn> {
  // 已中止的 signal 不会触发 addEventListener 回调，必须显式检查
  if (signal.aborted) throw new ChatError('请求已取消', 499);

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal.addEventListener('abort', onAbort);
  // 非流式没有"流"可言，一个请求超时足够
  const timeout = setTimeout(() => ctrl.abort(), FIRST_CHUNK_TIMEOUT);

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: config.model, messages, tools, stream: false, temperature: 0.4 }),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw toNetworkError(e);
    }
    if (!response.ok) throw await toHttpError(response);

    let json: {
      choices?: { message?: { content?: string | null; tool_calls?: ApiToolCall[] } }[];
    };
    try {
      json = (await response.json()) as typeof json;
    } catch {
      throw new ChatError('AI 服务返回了无法解析的响应。');
    }

    const message = json.choices?.[0]?.message;
    if (!message) throw new ChatError('AI 服务返回了空响应。');

    const content = message.content ?? '';
    const toolCalls = (message.tool_calls ?? [])
      .filter((tc) => tc.function?.name)
      .map((tc) => ({ ...tc, function: { ...tc.function, arguments: tc.function.arguments ?? '{}' } }));
    if (content) handlers.onText(content);
    toolCalls.forEach((tc) => handlers.onToolCall(tc));
    return { content, toolCalls };
  } catch (e) {
    if (signal.aborted) throw new ChatError('请求已取消', 499);
    if (e instanceof ChatError) throw e;
    throw toNetworkError(e);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', onAbort);
  }
}

/** 连接测试：发送极短请求验证配置（非流式） */
export async function testConnection(config: AIConfig): Promise<{ ok: boolean; message: string; model?: string }> {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!baseUrl) return { ok: false, message: '请先填写 Base URL。' };
  if (!config.model) return { ok: false, message: '请先填写模型名称。' };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 4,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    if (!response.ok) throw await toHttpError(response);
    return { ok: true, message: '连接成功，模型可用。', model: config.model };
  } catch (e) {
    const msg = e instanceof ChatError ? e.message : toNetworkError(e).message;
    return { ok: false, message: msg };
  } finally {
    clearTimeout(timeout);
  }
}

/** ── 错误工具函数 ── */

function toNetworkError(e: unknown): ChatError {
  if (e instanceof Error && e.name === 'AbortError') return new ChatError('请求超时，请检查网络或稍后重试。');
  return new ChatError('网络请求失败，请检查网络连接。');
}

async function toHttpError(response: Response): Promise<ChatError> {
  let detail = '';
  try {
    const j = (await response.json()) as { error?: { message?: string } };
    detail = j?.error?.message ?? '';
  } catch {
    // 忽略解析失败
  }
  const map: Record<number, string> = {
    401: 'API Key 无效或未授权（401）。',
    403: 'API Key 无权访问该模型（403）。',
    404: '接口路径不存在（404），请检查 Base URL。',
    429: '请求过于频繁，请稍后重试（429）。',
  };
  const base = map[response.status] ?? `AI 服务返回错误（HTTP ${response.status}）。`;
  return new ChatError(detail ? `${base} ${detail}` : base, response.status);
}
