/** ── OpenAI 兼容 Chat Completions 客户端（流式 + 工具调用） ── */

import { normalizeBaseUrl } from '../providers';
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
}

/** 请求超时（毫秒） */
const REQUEST_TIMEOUT = 120_000;
/** 失败自动重试次数（不含首次请求） */
const MAX_RETRIES = 5;
/** 指数退避基数：1s → 2s → 4s → 8s → 16s */
const RETRY_BASE_MS = 1000;

/** 可重试的错误：网络层（无 status）、限流 429、服务端 5xx。认证/参数/取消类不重试 */
function isRetriableError(e: unknown): boolean {
  if (!(e instanceof ChatError)) return false;
  const status = e.status;
  if (status === undefined) return true; // 网络层错误 / 超时
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
 * 发送一轮 chat completion（优先流式，失败自动降级非流式重试一次；
 * 可恢复错误（网络/5xx/429/超时）自动重连最多 MAX_RETRIES 次，指数退避）。
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

  // 追踪是否已产生任何输出：若失败前已有内容，禁止重试，避免 UI 文本重复
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
      if (hasOutput || retried >= MAX_RETRIES || !isRetriableError(e)) throw e;
      retried++;
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
  // 超时覆盖「请求 + 流式读取」全程，防止服务端挂起导致永久等待
  const timeout = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);

  const toolAcc = new Map<number, { id: string; name: string; args: string }>();
  let content = '';
  let buffer = '';

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
      throw toNetworkError(e);
    }
    if (!response.ok) throw await toHttpError(response);

    const reader = response.body?.getReader();
    if (!reader) throw new ChatError('AI 服务返回了空响应。');
    const decoder = new TextDecoder();
    let strippedBom = false;

    /** 解析单行 SSE 数据（BOM 剥离 + JSON 解析 + delta 累积） */
    let pendingData: string | null = null; // 上一行未解析成功的 data（尝试与下一行拼接）
    const processLine = (raw: string) => {
      // 首个数据行可能带 UTF-8 BOM，剥离后判断
      if (!strippedBom) {
        strippedBom = true;
        raw = raw.replace(/^\ufeff/, '');
      }
      if (!raw.startsWith('data:')) return;
      const data = raw.slice(5).trim();
      if (!data || data === '[DONE]') return;
      // 非标准实现会把单个 JSON 拆到多个 data 行：先尝试与上一行拼接再解析
      let json: unknown;
      const candidate = pendingData ? `${pendingData}${data}` : data;
      try {
        json = JSON.parse(candidate);
        pendingData = null;
      } catch {
        if (pendingData) {
          // 拼接仍失败：确认是脏数据，丢弃并告警（不再静默）
          console.warn('[MarkAI] SSE 数据行无法解析，已跳过:', data);
          pendingData = null;
        } else {
          pendingData = data;
        }
        return;
      }
      const parsed = json as {
        choices?: { delta?: { content?: string | null; tool_calls?: ToolCallDelta[] } }[];
      };
      const delta = parsed.choices?.[0]?.delta;
      if (!delta) return;
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content;
        handlers.onText(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const i = tc.index ?? 0;
          const cur = toolAcc.get(i) ?? { id: '', name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) {
            // 标准实现按字符分片累加；个别网关重复发送完整 name，避免粘连
            if (!cur.name) cur.name = tc.function.name;
            else if (!(tc.function.name.length > 3 && cur.name.endsWith(tc.function.name))) {
              cur.name += tc.function.name;
            }
          }
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          toolAcc.set(i, cur);
        }
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        processLine(line);
      }
    }
    // 兜底：流结束未以换行结尾的残留数据
    const tail = buffer.trim();
    if (tail) processLine(tail);
  } catch (e) {
    if (signal.aborted) throw new ChatError('请求已取消', 499);
    if (e instanceof ChatError) throw e;
    throw toNetworkError(e);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', onAbort);
  }

  const toolCalls: ApiToolCall[] = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({
      id: v.id || crypto.randomUUID(),
      type: 'function' as const,
      function: { name: v.name, arguments: v.args || '{}' },
    }));
  // 不再静默剔除无 name 的调用：交由执行器返回「未知工具」错误，模型收到后可重试

  toolCalls.forEach((tc) => handlers.onToolCall(tc));
  return { content, toolCalls };
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
  // 超时覆盖请求与解析全程
  const timeout = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);

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

/** SSE chunk 中的工具调用增量 */
interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}
