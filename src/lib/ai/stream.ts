/**
 * ── SSE 流解析（纯逻辑，不碰网络，可单测） ──
 *
 * 为什么要从 client.ts 里抽出来：
 * 解析规则（分片累加、脏数据跳过、[DONE] 与 finish_reason 判定）是"断流"类 bug 的高发区，
 * 而它原本埋在 fetch 读循环里，只能靠 mock 整条流来测——于是"流被中途截断"这类真实场景
 * 从来没被构造过（替身总是吐完整的流）。抽成纯函数后可以直接喂字节，逐条断言。
 */

/** 累积出的工具调用（流式增量合并后的结果） */
export interface StreamToolCall {
  id: string;
  name: string;
  /** 参数 JSON 字符串（可能是半截——流被截断时） */
  args: string;
}

/** 一次流解析的结果 */
export interface SseResult {
  content: string;
  toolCalls: StreamToolCall[];
  /**
   * 流是否正常结束：收到过 `[DONE]` 或任意 `finish_reason`。
   * **false 不代表一定有内容丢失**——不少兼容端点不发 [DONE] 也不带 finish_reason。
   * 它只在配合 `argsComplete === false` 时才是"被截断"的判据。
   */
  completed: boolean;
  /** 最后一个非空 finish_reason（stop / length / tool_calls / content_filter …） */
  finishReason: string | null;
  /** 工具调用参数是否**全部**是完整可解析的 JSON */
  argsComplete: boolean;
  /**
   * 末尾残留了一个解析不出来的 `data:` 行：说明最后一个事件被拦腰截断
   * （连一行都没发完就断了），而不只是"少发了个 [DONE]"。
   */
  pendingTail: boolean;
  /** 因无法解析而被跳过的 data 行数（脏数据，已告警，不静默） */
  skippedLines: number;
}

export interface SseAccumulatorOptions {
  /** 每收到一段文本增量就回调（UI 流式渲染） */
  onText?: (text: string) => void;
}

export interface SseAccumulator {
  /** 喂入一个分片（字节或字符串）；按行切分，跨分片的行会留到下一片 */
  push(chunk: string | Uint8Array): void;
  /** 流结束（无论是否正常关闭）：冲刷残留并给出结果 */
  end(): SseResult;
}

/** SSE 数据行中的工具调用增量 */
interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface ChunkShape {
  choices?: {
    delta?: { content?: string | null; tool_calls?: ToolCallDelta[] };
    finish_reason?: string | null;
  }[];
}

/**
 * 判断一个工具调用的 arguments 是否完整。
 * 空串视为完整（模型用默认参数调用时可能一个字符都不发）。
 */
export function isCompleteJsonObject(s: string): boolean {
  const text = s.trim();
  if (!text) return true; // 空 = 无参数，执行器会按 {} 处理
  try {
    const v = JSON.parse(text) as unknown;
    return typeof v === 'object' && v !== null;
  } catch {
    return false;
  }
}

export function createSseAccumulator(opts: SseAccumulatorOptions = {}): SseAccumulator {
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let sawDone = false;
  let finishReason: string | null = null;
  let skippedLines = 0;
  let strippedBom = false;
  /** 上一行解析失败的 data：与下一行拼接后再试（非标准实现会把一个 JSON 拆到多行） */
  let pendingData: string | null = null;
  const toolAcc = new Map<number, StreamToolCall>();

  const feedLine = (rawLine: string): void => {
    let raw = rawLine.trim();
    // 首个数据行可能带 UTF-8 BOM
    if (!strippedBom) {
      strippedBom = true;
      raw = raw.replace(/^﻿/, '');
    }
    if (!raw.startsWith('data:')) return;
    const data = raw.slice(5).trim();
    if (!data) return; // SSE 心跳空行
    if (data === '[DONE]') {
      sawDone = true;
      return;
    }

    /**
     * 解析顺序很关键：**先试当前行本身**，失败才去和上一行拼。
     *
     * 反过来的写法（直接拼 pending+current）会让一行脏数据"吃掉"紧随其后的有效行：
     * 上一行留下的垃圾 + 这一行的合法 JSON 拼在一起必然解析失败，于是有效行也被丢掉。
     * 先试单行就没有这个问题——合法行直接生效，残留的垃圾单独告警丢弃。
     */
    let json: unknown;
    try {
      json = JSON.parse(data);
      if (pendingData) {
        // 上一行确实是垃圾（不是被拆开的半个 JSON），丢掉
        skippedLines++;
        console.warn('[MarkAI] SSE 上一行无法解析，已丢弃:', pendingData);
        pendingData = null;
      }
    } catch {
      if (!pendingData) {
        // 可能是被拆开的半个 JSON：留着和下一行拼
        pendingData = data;
        return;
      }
      try {
        json = JSON.parse(`${pendingData}${data}`);
        pendingData = null;
      } catch {
        // 拼接仍失败：两行都是脏数据
        skippedLines++;
        console.warn('[MarkAI] SSE 数据行无法解析，已跳过:', data);
        pendingData = null;
        return;
      }
    }

    const parsed = json as ChunkShape;
    const choice = parsed.choices?.[0];
    if (typeof choice?.finish_reason === 'string' && choice.finish_reason) {
      finishReason = choice.finish_reason;
    }
    const delta = choice?.delta;
    if (!delta) return;

    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      opts.onText?.(delta.content);
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const i = tc.index ?? 0;
        const cur = toolAcc.get(i) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) {
          // 标准实现按字符分片累加；个别网关会重复发送完整 name，避免粘连
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

  const pushText = (text: string): void => {
    buffer += text;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      feedLine(line);
    }
  };

  return {
    push(chunk) {
      pushText(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
    },
    end() {
      // 兜底：流结束但未以换行结尾的残留数据（以及最后一个未配对的 pendingData）
      const tail = buffer.trim();
      buffer = '';
      if (tail) feedLine(tail);
      const pendingTail = pendingData !== null;
      if (pendingData) {
        // 到流末尾仍没拼成功：要么是脏数据，要么是最后一个事件被拦腰截断
        skippedLines++;
        console.warn('[MarkAI] SSE 末尾残留无法解析的数据，已跳过:', pendingData);
        pendingData = null;
      }
      const toolCalls = [...toolAcc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => ({ ...v }));
      return {
        content,
        toolCalls,
        completed: sawDone || finishReason !== null,
        finishReason,
        argsComplete: toolCalls.every((tc) => isCompleteJsonObject(tc.args)),
        pendingTail,
        skippedLines,
      };
    },
  };
}

/**
 * 把累积结果里的工具调用补全成可发送的形态。
 * **不在这里剔除无 name 的调用**：交给执行器返回「未知工具」错误，模型收到后可自行重试——
 * 静默丢弃只会让模型以为调用成功了，然后凭空编造结果。
 */
export function finalizeToolCalls(calls: StreamToolCall[]): {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}[] {
  return calls.map((c) => ({
    id: c.id || crypto.randomUUID(),
    type: 'function' as const,
    function: { name: c.name, arguments: c.args || '{}' },
  }));
}
