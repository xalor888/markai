/**
 * ── 思考强度：值域、净化，以及「实际会发出去什么」 ──
 *
 * 为什么单独抽一个模块：
 *
 * 1. **自定义是产品需求**。目录（models.dev）只描述"上游声称支持哪些档位"，
 *    而网关、中转站、自建推理服务经常支持目录里没有的值（例如 `ultra`、`3`、
 *    或厂商新加的 `nano`）。只允许目录里的档位，等于把用户的端点当成"目录的附庸"。
 * 2. 但**不能把任意字符串塞进请求体**。思考强度最终会变成 `reasoning_effort`
 *    或 `reasoning.effort` 的字符串值，控制字符/换行/超长串既可能是脏配置，
 *    也可能是注入。所以"自定义"必须经过一道明确的净化规则，而不是原样透传。
 * 3. 净化规则只在这里定义一次：`providers.normalizeReasoningEffort`（读配置时）、
 *    `models/request.reasoningPayload`（写请求时）、设置页输入校验（写配置时）都用它，
 *    三处不会漂移成三套标准。
 *
 * 这段是纯函数，不碰 chrome / 不碰网络，可以被单测钉住。
 */

/** 自定义档位允许的最大长度：够长容纳 `high-reasoning-2048`，又不至于塞进一整段话 */
export const MAX_EFFORT_LENGTH = 24;

/**
 * 合法 token：字母/数字开头，后续只允许字母、数字与 `- _ . :`。
 *
 * 刻意**不**允许空格与换行：`reasoning_effort` 是一个枚举式字符串，
 * 带空格的值在任何一家上游都不会被当成档位——它只会变成一条难查的 400。
 */
const EFFORT_TOKEN_RE = /^[a-z0-9][a-z0-9._:-]*$/;

/**
 * 净化思考强度：去空白、转小写、校验 token 形状。
 *
 * @returns 合法 token；空串表示"没有可用值"（调用方应回落到 `auto`）。
 */
export function sanitizeEffort(value?: string | null): string {
  if (typeof value !== 'string') return '';
  const v = value.trim().toLowerCase();
  if (!v || v.length > MAX_EFFORT_LENGTH) return '';
  return EFFORT_TOKEN_RE.test(v) ? v : '';
}

/**
 * 输入框的就地校验：给用户一句能改的话，而不是拒绝保存。
 *
 * @returns null = 可以保存；非空 = 具体的错误说明
 */
export function effortInputIssue(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null; // 留空由调用方解释成"不发送"，不是错误
  const v = raw.toLowerCase();
  if (v.length > MAX_EFFORT_LENGTH) {
    return `自定义档位最长 ${MAX_EFFORT_LENGTH} 个字符（当前 ${v.length} 个）。`;
  }
  if (!EFFORT_TOKEN_RE.test(v)) {
    return '只能用小写字母、数字和 - _ . :（空格与换行不会被上游当成档位）。';
  }
  return null;
}

/**
 * 请求体里**实际**会出现的那一行（给设置页做诚实预览）。
 *
 * 这段文案的价值：用户点了一个档位，就该看见它到底以什么字段名发出去；
 * 而不是等 400 之后才回来猜「是不是我选的那个没生效」。
 */
export function describeEffortRequest(providerId: string, effort?: string | null): string {
  const v = sanitizeEffort(effort);
  if (!v || v === 'auto') return '不添加思考字段（按服务商与模型的默认行为）';
  if (providerId === 'openai') return `"reasoning": { "effort": "${v}" }`;
  return `"reasoning_effort": "${v}"`;
}
