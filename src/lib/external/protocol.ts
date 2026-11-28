/**
 * ── 对外接口的协议层（纯函数） ──
 *
 * 架构（为什么不是"扩展里起个 HTTP 服务"）：
 *  · MV3 的 Service Worker **没有 TCP 监听能力**，`chrome.sockets` 只在 Chrome App 里有；
 *  · 所以真正监听端口的是本机桥 `tools/markai-bridge.mjs`（Node，回环地址），
 *    扩展用 fetch 轮询桥上的待办队列，在自己的上下文里执行书签操作；
 *  · 好处：外部 Agent 不需要知道扩展怎么工作，桥崩了扩展不受影响，权限仍由扩展裁决。
 *
 * 这个文件只做**裁决**，不做 IO：
 *  1. token 校验（常量时间比较，避免计时侧信道）；
 *  2. 工具白名单 + 写权限闸门；
 *  3. 删除一律降级成"提议"，不执行；
 *  4. 参数必须是对象、大小有上限（防止外部 Agent 把整棵树塞进一次调用）。
 *
 * 纯函数才能被 Node 测试直接钉住——安全边界不该只靠"跑起来看看"。
 */
import {
  EXTERNAL_READ_TOOLS,
  EXTERNAL_TOOLS,
  type ExternalApiConfig,
  type ExternalTool,
} from '@/lib/features/external';

export interface ExternalRequest {
  /** 调用方生成的唯一 id：桥用它做幂等（重试不会执行两次） */
  id: string;
  tool: string;
  args: Record<string, unknown>;
  /** 调用来源，写进审计日志 */
  client?: string;
}

export interface ExternalResponse {
  id: string;
  ok: boolean;
  /** 工具返回的原始文本（通常是一段 JSON） */
  result?: string;
  error?: string;
  /** 错误分类：鉴权 / 权限 / 参数 / 执行 */
  code?: 'unauthorized' | 'forbidden' | 'bad_request' | 'failed';
  /** 本次是否产生了待确认的删除提议（外部调用永远不会直接删） */
  proposedDeletions?: number;
}

/** 单次调用参数上限：256 KiB。超过说明调用方在做"批量灌数据"，应当拆分。 */
export const MAX_ARGS_BYTES = 256 * 1024;

export function isExternalTool(name: string): name is ExternalTool {
  return (EXTERNAL_TOOLS as readonly string[]).includes(name);
}

export function isReadTool(name: string): boolean {
  return (EXTERNAL_READ_TOOLS as readonly string[]).includes(name);
}

/**
 * 常量时间字符串比较。
 *
 * 普通 `===` 会在第一个不同字节处返回，攻击者能靠计时逐字节猜 token。
 * 本机回环上这个风险很低，但校验函数是"安全边界"的一部分，写法要经得起看。
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** token 至少 24 字符：太短的 token 在回环上可以被穷举 */
export const MIN_TOKEN_LENGTH = 24;

export interface Verdict {
  ok: boolean;
  code?: ExternalResponse['code'];
  error?: string;
}

/**
 * 裁决一次调用。
 *
 * 顺序刻意是「开关 → token → 工具名 → 写权限 → 参数」：
 * 未启用时连"这个工具存不存在"都不透露。
 */
export function authorize(
  config: ExternalApiConfig,
  token: string | null | undefined,
  req: ExternalRequest,
): Verdict {
  if (!config.enabled) return { ok: false, code: 'forbidden', error: '对外接口未启用' };
  if (!config.token || config.token.length < MIN_TOKEN_LENGTH) {
    return { ok: false, code: 'forbidden', error: 'token 未生成或过短' };
  }
  if (!token || !safeEqual(token, config.token)) {
    return { ok: false, code: 'unauthorized', error: 'token 不正确' };
  }
  if (!isExternalTool(req.tool)) {
    return { ok: false, code: 'bad_request', error: `未知工具：${req.tool}` };
  }
  if (!config.allowWrites && !isReadTool(req.tool)) {
    return { ok: false, code: 'forbidden', error: `「${req.tool}」是写操作，当前未允许` };
  }
  if (!req.args || typeof req.args !== 'object' || Array.isArray(req.args)) {
    return { ok: false, code: 'bad_request', error: 'args 必须是对象' };
  }
  const size = byteLength(JSON.stringify(req.args));
  if (size > MAX_ARGS_BYTES) {
    return { ok: false, code: 'bad_request', error: `args 过大（${size} 字节，上限 ${MAX_ARGS_BYTES}）` };
  }
  return { ok: true };
}

/** 不依赖 TextEncoder 的字节估算（Node 与浏览器一致；JSON 里中文占 3 字节） */
export function byteLength(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++; // 代理对算一个 4 字节字符
    } else n += 3;
  }
  return n;
}

/** 校验请求外壳：id 必填且短（它会被写进审计日志与幂等表） */
export function normalizeRequest(raw: unknown): ExternalRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;
  const id = typeof src.id === 'string' ? src.id.trim().slice(0, 80) : '';
  const tool = typeof src.tool === 'string' ? src.tool.trim() : '';
  if (!id || !tool) return null;
  const args = src.args && typeof src.args === 'object' && !Array.isArray(src.args)
    ? (src.args as Record<string, unknown>)
    : {};
  const client = typeof src.client === 'string' ? src.client.trim().slice(0, 40) : undefined;
  return { id, tool, args, client };
}

/**
 * 生成一个本机 token。
 *
 * 优先用 `crypto.getRandomValues`（扩展与 Node 18+ 都有）；两者都没有时**拒绝生成**，
 * 而不是退化成 Math.random——一个可预测的 token 比"没有 token"更危险，
 * 因为它会让用户以为接口是受保护的。
 */
export function generateToken(): string {
  const bytes = new Uint8Array(24);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.getRandomValues) throw new Error('当前环境没有安全随机源，无法生成 token');
  c.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** 给外部 Agent 看的工具清单（设置页与 MCP 的 tools/list 共用一份） */
export function toolManifest(): Array<{ name: ExternalTool; readOnly: boolean }> {
  return EXTERNAL_TOOLS.map((name) => ({ name, readOnly: isReadTool(name) }));
}
