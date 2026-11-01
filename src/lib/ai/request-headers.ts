/**
 * ── 请求头装配（纯逻辑，不碰网络，可单测） ──
 *
 * 为什么需要这一层：有些 OpenAI 兼容网关在标准协议之外要求**自定义请求头**，
 * 缺了就直接 400。已知的实例是 OpenCode Go：
 *
 *   Request is missing x-opencode-session and cannot be routed efficiently.
 *
 * 它 2026-09-06 起强制要求每个请求带 `x-opencode-session`，用途是**每个会话一个稳定 ID**，
 * 服务端据此把同一会话的请求路由到同一节点，prompt caching 才有意义。
 * 值本身不校验内容，但**必须稳定**——每次请求换新值等于把路由打散，缓存全失效。
 *
 * 原先 client.ts 把请求头写死在两个地方（`chatCompletion` 与 `testConnection`），
 * 于是出现这类问题：聊天能通、点「测试连接」却报同样的 400，因为那条路径忘了带头。
 * 现在三处（流式 / 非流式 / 连接测试）都从 `buildRequestHeaders` 取，不可能再漂移。
 */

/** 用户不能覆盖的头：改它们会破坏 HTTP 语义或让凭据来源变得不可解释 */
const FORBIDDEN_OVERRIDE = new Set([
  'authorization', // 凭据统一走「API Key」字段，避免两处配置打架
  'host',
  'content-length',
  'content-type',
  'connection',
  'transfer-encoding',
  'upgrade',
]);

/** RFC 7230 的 token 规则：header 名只允许这些字符 */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export interface ParsedHeaders {
  /** 解析成功的头（名保持用户输入的大小写） */
  headers: Record<string, string>;
  /** 被拒绝的行：给人看的原因，不静默丢弃 */
  errors: string[];
}

/**
 * 解析多行「自定义请求头」文本。
 *
 * 格式：每行一条 `Name: Value`，空行与 `#` 开头的行忽略。
 *
 * **安全约束（都是实测过的坑，不是洁癖）**：
 * - 值里出现 CR/LF → 拒绝。否则一条 `X-A: a\r\nCookie: b` 就能往请求里塞任意头
 *   （HTTP 头注入），而这段文本来自用户配置、会被存进 storage 再原样发出；
 * - header 名必须符合 token 规则 → 拒绝。带空格/冒号的名字会让 fetch 直接抛
 *   `TypeError: Invalid header name`，而这个异常发生在请求发出之前，
 *   用户只会看到"网络请求失败"，完全猜不到是配置写错了；
 * - 禁止覆盖 Authorization / Content-Type 等（见 `FORBIDDEN_OVERRIDE`）→ 拒绝并说明。
 *
 * 解析失败的行**不阻断其他行**：全部合法头照常生效，非法的逐行报错给 UI 显示。
 */
export function parseCustomHeaders(raw?: string | null): ParsedHeaders {
  const headers: Record<string, string> = {};
  const errors: string[] = [];
  if (!raw || !raw.trim()) return { headers, errors };

  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith('#')) continue;

    const at = line.indexOf(':');
    if (at <= 0) {
      errors.push(`第 ${i + 1} 行：缺少「名称: 值」里的冒号`);
      continue;
    }
    const name = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();

    if (!name) {
      errors.push(`第 ${i + 1} 行：名称为空`);
      continue;
    }
    if (!HEADER_NAME_RE.test(name)) {
      errors.push(`第 ${i + 1} 行：「${name}」不是合法的请求头名称（只允许字母、数字与 -_. 等符号）`);
      continue;
    }
    // 值里的换行已经被 split 拆掉了，但行尾若带 `\r` 说明原文里是 CRLF 注入的结构
    if (/[\r\n]/.test(value)) {
      errors.push(`第 ${i + 1} 行：值里不能包含换行`);
      continue;
    }
    if (FORBIDDEN_OVERRIDE.has(name.toLowerCase())) {
      errors.push(
        name.toLowerCase() === 'authorization'
          ? `第 ${i + 1} 行：不要在这里覆盖 Authorization，请用上面的「API Key」字段`
          : `第 ${i + 1} 行：「${name}」由程序管理，不能自定义`,
      );
      continue;
    }
    headers[name] = value;
  }
  return { headers, errors };
}

/** 装配请求所需的配置（只声明本模块用到的字段，避免把整个 AIConfig 拖进来） */
export interface HeaderConfig {
  apiKey?: string;
  /** 用户自定义的请求头原文（多行 Name: Value） */
  customHeaders?: string;
  /**
   * 预设要求的会话头名（如 OpenCode Go 的 `x-opencode-session`）。
   * 由 provider 预设决定，用户不需要看见它。
   */
  sessionHeader?: string;
}

/**
 * 装配一次请求的完整请求头。
 *
 * 优先级：**内置头 < 预设要求的会话头 < 用户自定义头**（后面的覆盖前面的，
 * 但 Authorization / Content-Type 已经在解析阶段被禁止自定义）。
 *
 * @param sessionId 稳定会话 ID；`sessionHeader` 为空时不会用到它
 */
export function buildRequestHeaders(config: HeaderConfig, sessionId?: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  // 预设要求的头：值是稳定会话 ID。没有 ID 时**不加空头**——
  // 空值的头同样会让网关路由失败，而且比缺头更难排查（看起来"带了"）
  const sessionHeader = config.sessionHeader?.trim();
  if (sessionHeader && sessionId) headers[sessionHeader] = sessionId;

  const { headers: custom } = parseCustomHeaders(config.customHeaders);
  return { ...headers, ...custom };
}

/**
 * 生成/取回**稳定**会话 ID。
 *
 * 之所以不用 `crypto.randomUUID()` 每次现生成：那个头是给服务端做
 * 「同一会话 → 同一节点」的路由用的。每请求换新 ID 虽然能过校验，
 * 但等于每次都换一个节点，prompt cache 永远命中不了——用户看到的是"账单变贵了"，
 * 却没有任何报错可以帮助归因。
 *
 * 粒度取「安装级」而不是「对话级」：这一层拿不到 conversationId（协议里没有），
 * 且同一浏览器里的对话本来就共享缓存更划算。真要做对话级，需要先把
 * conversationId 一路透传到 client，属于后续优化，不是修这个 400 的前提。
 */
const SESSION_KEY = 'markai.session.id';

export async function getStableSessionId(): Promise<string> {
  try {
    const data = await chrome.storage.local.get(SESSION_KEY);
    const saved = data[SESSION_KEY];
    if (typeof saved === 'string' && saved.trim()) return saved;
    const id = `markai-${crypto.randomUUID()}`;
    await chrome.storage.local.set({ [SESSION_KEY]: id }).catch(() => {});
    return id;
  } catch {
    // storage 读不到（隐私模式/配额）：退化成进程内一次性 ID。
    // 路由稳定性会打折，但至少请求能通——比直接失败好，且不影响其他服务商。
    return `markai-${crypto.randomUUID()}`;
  }
}
