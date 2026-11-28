/**
 * ── 对外接口的运行时（在 background Service Worker 里跑） ──
 *
 * 为什么是"长轮询"而不是"扩展里开服务器"：MV3 的 Service Worker 没有 TCP 监听，
 * `chrome.sockets` 只属于 Chrome App。所以端口由本机桥（`tools/markai-bridge.mjs`）持有，
 * 扩展向桥要活干：
 *
 *   extension ──GET /next（挂起 25s）──▶ bridge ◀──POST /v1/call── MCP / CLI
 *   extension ──POST /v1/result────────▶ bridge ──HTTP 响应──▶ MCP / CLI
 *
 * 选长轮询而不是 WebSocket 的原因：没有依赖、断线自动重连就是"再发一次请求"，
 * 而且**在途 fetch 会延长 Service Worker 寿命**——WebSocket 也能，但要自己实现
 * RFC6455 握手与帧解析，为一个本机桥不值得。
 *
 * 安全边界全部在扩展这一侧（`protocol.ts` 的 `authorize`）：桥只是搬运工，
 * 即使桥被别的本机进程冒充，它也拿不到 token，更无法让扩展执行白名单外的工具。
 */
import { executeTool } from '@/lib/ai/tools';
import { AI_STORAGE_KEY } from '@/stores/aiStore';
import type { DeletionProposal } from '@/lib/ai/types';
import {
  EXTERNAL_STORAGE_KEY,
  type ExternalApiConfig,
  type ExternalAuditEntry,
} from '@/lib/features/external';
import {
  authorize,
  normalizeRequest,
  type ExternalRequest,
  type ExternalResponse,
} from './protocol';

export const EXTERNAL_AUDIT_KEY = 'markai.external.audit';
/** 审计日志上限：再多就不是"可查"而是"翻不动"，用户要的是最近发生了什么 */
export const AUDIT_LIMIT = 200;
/** 单次长轮询的挂起时长：小于 SW 的空闲回收阈值，又足够减少空转 */
const POLL_HOLD_MS = 25_000;
/** 桥不可达时的退避上限 */
const RETRY_MAX_MS = 15_000;
/** 单次工具执行上限：与 Agent 的工具有相同量级的耐心，但不能无限挂住 */
const EXEC_TIMEOUT_MS = 120_000;

interface RuntimeState {
  running: boolean;
  /** 桥是否可达（最近一次请求的结果） */
  bridgeOnline: boolean;
  lastError: string | null;
  lastPollAt: number;
  /** 已处理过的请求 id：桥重试/网络重发不会执行两次 */
  handled: Set<string>;
  stop: (() => void) | null;
}

const state: RuntimeState = {
  running: false,
  bridgeOnline: false,
  lastError: null,
  lastPollAt: 0,
  handled: new Set(),
  stop: null,
};

/** 处理过的 id 只保留最近这么多：够覆盖重试窗口，又不会无限涨 */
const HANDLED_LIMIT = 500;

export function externalRuntimeStatus(): {
  running: boolean;
  bridgeOnline: boolean;
  lastError: string | null;
  lastPollAt: number;
} {
  return {
    running: state.running,
    bridgeOnline: state.bridgeOnline,
    lastError: state.lastError,
    lastPollAt: state.lastPollAt,
  };
}

export async function readExternalConfig(): Promise<ExternalApiConfig | null> {
  try {
    const data = await chrome.storage.local.get(EXTERNAL_STORAGE_KEY);
    const raw = data[EXTERNAL_STORAGE_KEY] as Partial<ExternalApiConfig> | undefined;
    if (!raw) return null;
    return {
      enabled: raw.enabled === true,
      port: typeof raw.port === 'number' && raw.port > 0 && raw.port < 65536 ? raw.port : 8787,
      token: typeof raw.token === 'string' ? raw.token : '',
      allowWrites: raw.allowWrites === true,
    };
  } catch {
    return null;
  }
}

export async function writeExternalConfig(config: ExternalApiConfig): Promise<void> {
  await chrome.storage.local.set({ [EXTERNAL_STORAGE_KEY]: config });
}

export async function readAudit(): Promise<ExternalAuditEntry[]> {
  try {
    const data = await chrome.storage.local.get(EXTERNAL_AUDIT_KEY);
    const list = data[EXTERNAL_AUDIT_KEY];
    return Array.isArray(list) ? (list as ExternalAuditEntry[]) : [];
  } catch {
    return [];
  }
}

export async function appendAudit(entry: ExternalAuditEntry): Promise<void> {
  const list = await readAudit();
  const next = [entry, ...list].slice(0, AUDIT_LIMIT);
  try {
    await chrome.storage.local.set({ [EXTERNAL_AUDIT_KEY]: next });
  } catch {
    // 日志写不进去不能影响调用本身：审计是"可查"，不是"准入条件"
  }
}

export async function clearAudit(): Promise<void> {
  await chrome.storage.local.remove(EXTERNAL_AUDIT_KEY);
}

/**
 * 外部删除提议落进**与聊天同一条队列**。
 *
 * 不调用 aiStore：background 里没有 UI store 的完整生命周期（跨窗口合并、
 * 墓碑、预算裁剪都在 `_persist` 里）。这里只做最小、可并发安全的合并写：
 * 读 → 按 bookmarkId 去重（终态不被 pending 覆盖）→ 写。
 */
export async function enqueueExternalDeletions(proposals: DeletionProposal[]): Promise<number> {
  if (proposals.length === 0) return 0;
  try {
    const data = await chrome.storage.local.get(AI_STORAGE_KEY);
    const saved = (data[AI_STORAGE_KEY] ?? {}) as Record<string, unknown>;
    const existing = Array.isArray(saved.pendingDeletions)
      ? (saved.pendingDeletions as DeletionProposal[])
      : [];
    const byBookmark = new Map(existing.map((p) => [p.bookmarkId, p]));
    let added = 0;
    for (const p of proposals) {
      const prev = byBookmark.get(p.bookmarkId);
      // 已经执行/放弃的项不因外部再次提议而复活
      if (prev && (prev.status === 'executed' || prev.status === 'declined')) continue;
      if (!prev) added++;
      byBookmark.set(p.bookmarkId, p);
    }
    await chrome.storage.local.set({
      [AI_STORAGE_KEY]: { ...saved, pendingDeletions: [...byBookmark.values()] },
    });
    return added;
  } catch {
    return 0;
  }
}

/** 把一次工具结果收尾成对外响应（错误只回一句话，不泄露内部堆栈） */
function failure(id: string, message: string, code: ExternalResponse['code'] = 'failed'): ExternalResponse {
  return { id, ok: false, error: message, code };
}

async function runOne(config: ExternalApiConfig, req: ExternalRequest): Promise<ExternalResponse> {
  const verdict = authorize(config, config.token, req);
  if (!verdict.ok) return failure(req.id, verdict.error ?? '拒绝', verdict.code);

  const startedAt = Date.now();
  try {
    const out = await withTimeout(
      // 第四个参数是 ctx：external 标记让删除类工具强制走"只提议"，
      // 不受用户给聊天 Agent 开的「无需确认」影响。
      executeTool(req.tool, JSON.stringify(req.args), undefined, undefined, { external: true }),
      EXEC_TIMEOUT_MS,
      `工具「${req.tool}」执行超时`,
    );
    let proposed = 0;
    if (out.deletions && out.deletions.length > 0) {
      // 无论 allowWrites 与否，删除都只进提议队列——这是安全模型里最硬的一条
      proposed = await enqueueExternalDeletions(out.deletions);
    }
    const summary = summarize(req.tool, out.result, proposed);
    await appendAudit({
      at: startedAt,
      client: req.client || 'unknown',
      tool: req.tool,
      ok: true,
      summary,
    });
    return { id: req.id, ok: true, result: out.result, proposedDeletions: proposed || undefined };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await appendAudit({
      at: startedAt,
      client: req.client || 'unknown',
      tool: req.tool,
      ok: false,
      summary: message.slice(0, 160),
    });
    return failure(req.id, message);
  }
}

/** 审计摘要：只记"做了什么、影响多少"，不记书签全文（日志会被反复读写） */
function summarize(tool: string, result: string | undefined, proposed: number): string {
  if (proposed > 0) return `提交 ${proposed} 条删除提议（待用户确认）`;
  if (!result) return '完成';
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    for (const key of ['count', 'total', 'items', 'folders', 'submitted', 'matched']) {
      const v = parsed[key];
      if (typeof v === 'number') return `${tool}：${v}`;
      if (Array.isArray(v)) return `${tool}：${v.length} 条`;
    }
  } catch {
    // 不是 JSON 就只记工具名，别把整段结果塞进日志
  }
  return `${tool}：完成`;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function remember(id: string): boolean {
  if (state.handled.has(id)) return false;
  state.handled.add(id);
  if (state.handled.size > HANDLED_LIMIT) {
    const first = state.handled.values().next();
    if (!first.done) state.handled.delete(first.value);
  }
  return true;
}

/**
 * 启动轮询循环。
 *
 * 幂等：重复调用只会换掉旧的停止函数，不会出现两条循环同时抢活
 * （两条循环会让桥上的同一个请求被领两次——虽然有 id 去重，但会白跑工具）。
 */
export function startExternalRuntime(config: ExternalApiConfig): void {
  stopExternalRuntime();
  if (!config.enabled || !config.token) return;
  state.running = true;
  let stopped = false;
  state.stop = () => {
    stopped = true;
    state.running = false;
  };

  const base = `http://127.0.0.1:${config.port}`;
  let backoff = 800;

  const loop = async () => {
    while (!stopped) {
      try {
        const ctrl = new AbortController();
        const hold = setTimeout(() => ctrl.abort(), POLL_HOLD_MS + 5_000);
        const res = await fetch(`${base}/next`, {
          headers: { Authorization: `Bearer ${config.token}` },
          signal: ctrl.signal,
          cache: 'no-store',
        });
        clearTimeout(hold);
        if (res.status === 204) {
          // 没有活干：正常的长轮询超时
          state.bridgeOnline = true;
          state.lastError = null;
          state.lastPollAt = Date.now();
          backoff = 800;
          continue;
        }
        if (res.status === 401 || res.status === 403) {
          // token 不匹配：不停循环（用户可能正在设置页改 token），但要如实说明
          state.bridgeOnline = true;
          state.lastError = '桥拒绝了 token：请确认设置页与桥使用同一个 token';
          await sleep(5_000);
          continue;
        }
        if (!res.ok) throw new Error(`桥返回 HTTP ${res.status}`);
        const payload = (await res.json()) as unknown;
        state.bridgeOnline = true;
        state.lastError = null;
        state.lastPollAt = Date.now();
        backoff = 800;

        const req = normalizeRequest(payload);
        if (!req) continue;
        // 先回"已收到"再执行：桥那边超时也不会导致重复派发
        if (!remember(req.id)) {
          await postResult(base, config.token, failure(req.id, '重复请求（已执行过）', 'bad_request'));
          continue;
        }
        const response = await runOne(config, req);
        await postResult(base, config.token, response);
      } catch (e) {
        state.bridgeOnline = false;
        const message = e instanceof Error ? e.message : String(e);
        state.lastError = /abort/i.test(message) ? '桥没有响应（可能未启动）' : message;
        await sleep(backoff);
        backoff = Math.min(backoff * 2, RETRY_MAX_MS);
      }
    }
  };

  void loop();
}

async function postResult(base: string, token: string, response: ExternalResponse): Promise<void> {
  try {
    await fetch(`${base}/v1/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(response),
    });
  } catch {
    // 结果送不回桥：调用方会超时。审计里已有记录，不在这里重试——
    // 重试可能让同一份结果被应用两次（尤其是写操作）。
  }
}

export function stopExternalRuntime(): void {
  state.stop?.();
  state.stop = null;
  state.running = false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 仅供测试：清空去重表与状态 */
export function resetExternalRuntimeForTest(): void {
  stopExternalRuntime();
  state.handled.clear();
  state.bridgeOnline = false;
  state.lastError = null;
  state.lastPollAt = 0;
}
