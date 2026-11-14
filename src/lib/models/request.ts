/**
 * ── 思考强度怎么发进请求体（纯函数，不碰网络） ──
 *
 * 默认**不注入**（`auto`），这是刻意的：
 * 请求体一字不变 = 不可能因为"新增思考参数"把一个原本能用的端点打成 400。
 * 只有用户在设置页主动选了某个档位（含自定义值），才会多出这个字段。
 *
 * 两种形态（差别来自实测，不是猜的）：
 *  - OpenAI 官方 Chat Completions 用嵌套 `reasoning: { effort }`
 *  - DeepSeek / Kimi / GLM 这类 OpenAI 兼容端点普遍认扁平的 `reasoning_effort`
 *
 * 值必须过一次净化（`sanitizeEffort`）：这里已经是写入请求体的最后一道关口，
 * 不能再假设上游调用方一定校验过——控制字符与超长串不该有机会进 body。
 */

import type { ReasoningEffort } from '@/lib/ai/types';
import { sanitizeEffort } from './effort';

/** 需要注入的字段；null = 什么都不加（默认档 / 未设置 / 非法值） */
export function reasoningPayload(
  providerId: string,
  effort?: ReasoningEffort | null,
): Record<string, unknown> | null {
  const v = sanitizeEffort(effort);
  // `auto` 与空值都表示"不指定"，交给服务商自己的默认策略
  if (!v || v === 'auto') return null;
  if (providerId === 'openai') return { reasoning: { effort: v } };
  return { reasoning_effort: v };
}
