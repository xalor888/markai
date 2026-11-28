/**
 * ── 可选的远端向量（OpenAI 兼容 /embeddings）──
 *
 * 默认路径永远是本地哈希向量；只有用户在设置里显式打开、且已配置
 * API Key / Base URL 时才走这里。远端只是"更懂同义改写"的增强，
 * 一旦失败（401/超时/断网）必须立刻退回本地——搜索不能因为一个外部服务挂掉而不可用。
 *
 * 远端与本地向量不能混用（维度、语义空间都不同），所以模型标识写进 manifest，
 * 切换实现时由索引层整库重建。
 */

import type { BookmarkEmbedInput } from './local-embed';
import type { Embedder } from './index';

export const DEFAULT_REMOTE_EMBED_MODEL = 'text-embedding-3-small';

/** 远端每批上限：OpenAI 兼容端点普遍限制 64 条左右 */
export const REMOTE_BATCH_SIZE = 64;

export interface RemoteEmbedConfig {
  baseUrl: string;
  apiKey: string;
  model?: string;
}

export interface RemoteRequestOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** 401/403 时回调：调用方据此把设置里的开关关掉并提示 */
  onDisabled?: (reason: string) => void;
}

export class RemoteEmbedError extends Error {
  readonly disabled: boolean;
  readonly status?: number;

  constructor(message: string, options: { disabled?: boolean; status?: number } = {}) {
    super(message);
    this.name = 'RemoteEmbedError';
    this.disabled = options.disabled ?? false;
    this.status = options.status;
  }
}

interface EmbeddingResponse {
  data?: Array<{ embedding?: unknown; index?: number }>;
  error?: { message?: string };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function validVectors(raw: unknown, expected: number): number[][] | null {
  if (!Array.isArray(raw)) return null;
  const rows = raw as Array<{ embedding?: unknown; index?: number }>;
  const sorted = rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => (a.row.index ?? a.i) - (b.row.index ?? b.i))
    .map(({ row }) => row.embedding);
  if (sorted.length !== expected) return null;
  const out: number[][] = [];
  let dim = 0;
  for (const embedding of sorted) {
    if (!Array.isArray(embedding) || embedding.length === 0) return null;
    if (!embedding.every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
    if (dim === 0) dim = embedding.length;
    else if (embedding.length !== dim) return null;
    out.push(embedding as number[]);
  }
  return out;
}

/**
 * 请求一批向量。
 *
 * 返回而不是抛错的理由：调用方需要区分「可以重试」与「必须停用」。
 * 401/403 不重试（Key 无效，重试只会更慢）；429/5xx 与网络错误按指数退避。
 */
export async function requestEmbeddings(
  texts: string[],
  config: RemoteEmbedConfig,
  options: RemoteRequestOptions = {},
): Promise<{ ok: true; vectors: number[][] } | { ok: false; reason: string; disabled: boolean; status?: number }> {
  if (texts.length === 0) return { ok: true, vectors: [] };
  if (!config.baseUrl || !config.apiKey) {
    return { ok: false, reason: '未配置 Base URL 或 API Key', disabled: false };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxRetries = options.maxRetries ?? 2;
  const sleep = options.sleep ?? defaultSleep;
  const model = config.model || DEFAULT_REMOTE_EMBED_MODEL;
  const url = `${config.baseUrl.replace(/\/+$/, '')}/embeddings`;

  let lastReason = '远端向量请求失败';
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await sleep(400 * 2 ** (attempt - 1));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ model, input: texts }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          disabled: true,
          status: response.status,
          reason: `向量服务拒绝认证（${response.status}）：请检查 API Key，或关闭远端向量`,
        };
      }
      if (response.status === 429 || response.status >= 500) {
        lastReason = `向量服务暂时不可用（${response.status}）`;
        continue;
      }
      if (!response.ok) {
        return { ok: false, reason: `向量服务返回 ${response.status}`, disabled: false, status: response.status };
      }
      const json = (await response.json()) as EmbeddingResponse;
      const vectors = validVectors(json.data, texts.length);
      if (!vectors) {
        return { ok: false, reason: json.error?.message || '向量响应格式不符合预期', disabled: false };
      }
      return { ok: true, vectors };
    } catch (error) {
      clearTimeout(timer);
      const aborted = controller.signal.aborted;
      lastReason = aborted
        ? `向量请求超时（${timeoutMs}ms）`
        : `向量请求失败：${error instanceof Error ? error.message : String(error)}`;
      if (aborted) break; // 超时重试只会继续拖慢搜索
    }
  }
  return { ok: false, reason: lastReason, disabled: false };
}

/** 远端 Embedder：按批请求，任何失败都以 RemoteEmbedError 交给上层决定降级 */
export class RemoteEmbedder implements Embedder {
  readonly id: string;
  dim = 0;
  private readonly config: RemoteEmbedConfig;
  private readonly options: RemoteRequestOptions;
  private disabled = false;

  constructor(config: RemoteEmbedConfig, options: RemoteRequestOptions = {}) {
    this.config = config;
    this.options = options;
    this.id = `remote:${config.model || DEFAULT_REMOTE_EMBED_MODEL}`;
  }

  get isDisabled(): boolean {
    return this.disabled;
  }

  private async embed(texts: string[]): Promise<number[][]> {
    if (this.disabled) throw new RemoteEmbedError('远端向量已停用', { disabled: true });
    const result = await requestEmbeddings(texts, this.config, this.options);
    if (!result.ok) {
      if (result.disabled) {
        this.disabled = true;
        this.options.onDisabled?.(result.reason);
      }
      throw new RemoteEmbedError(result.reason, { disabled: result.disabled, status: result.status });
    }
    const first = result.vectors[0];
    if (!first) throw new RemoteEmbedError('向量响应为空');
    if (this.dim === 0) this.dim = first.length;
    for (const vector of result.vectors) {
      if (vector.length !== this.dim) {
        throw new RemoteEmbedError(`远端向量维度不一致：${this.dim} vs ${vector.length}`);
      }
    }
    return result.vectors;
  }

  async embedBookmarks(inputs: BookmarkEmbedInput[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < inputs.length; i += REMOTE_BATCH_SIZE) {
      const batch = inputs.slice(i, i + REMOTE_BATCH_SIZE);
      const texts = batch.map((input) =>
        [input.title, input.path ?? '', input.url ?? ''].filter(Boolean).join('\n'),
      );
      out.push(...(await this.embed(texts)));
    }
    return out;
  }

  async embedQuery(query: string): Promise<number[]> {
    const [vector] = await this.embed([query]);
    if (!vector) throw new RemoteEmbedError('查询向量为空');
    return vector;
  }
}
