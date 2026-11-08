/** ── AI Provider 预设（OpenAI 兼容协议） ── */

import type { AIConfig, ReasoningEffort } from './ai/types';
import { lookupActiveModel } from './models/runtime';

/** Provider 预设描述 */
export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  defaultModel: string;
  /** 是否需要 API Key */
  needsKey: boolean;
  /**
   * 该服务强制要求的**会话头名**（值是稳定会话 ID，运行时注入）。
   *
   * 只放头名、不放值：值是每台安装一个的稳定 ID，见 `getStableSessionId()`。
   * 缺这个头会直接 400，且错误文案完全不像"配置问题"
   * （「missing x-opencode-session and cannot be routed efficiently」），
   * 所以选中预设时自动带上，而不是让用户自己去猜要配什么头。
   */
  sessionHeader?: string;
}

export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-5.1-mini', 'gpt-5.1', 'gpt-5.1-nano', 'gpt-5', 'gpt-5-mini', 'gpt-4.1'],
    defaultModel: 'gpt-5.1-mini',
    needsKey: true,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    // 官方推荐地址：https://api.deepseek.com（/v1 为兼容别名，两者皆可用）
    baseUrl: 'https://api.deepseek.com',
    // 2026 年当前主力模型；deepseek-chat / deepseek-reasoner 为稳定别名
    models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-v4-flash',
    needsKey: true,
  },
  {
    id: 'moonshot',
    name: 'Moonshot Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k3', 'kimi-k2-turbo', 'kimi-k2-thinking', 'kimi-k2', 'kimi-latest'],
    defaultModel: 'kimi-k3',
    needsKey: true,
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-5.2', 'glm-5.1', 'glm-5', 'glm-4.6'],
    defaultModel: 'glm-5.2',
    needsKey: true,
  },
  {
    id: 'ollama',
    name: 'Ollama（本地）',
    baseUrl: 'http://localhost:11434/v1',
    models: ['qwen3:32b', 'qwen3:14b', 'qwen3:8b', 'gemma3:27b', 'llama3.3:70b', 'deepseek-r1:8b'],
    defaultModel: 'qwen3:8b',
    needsKey: false,
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    /*
     * OpenCode Go 的 OpenAI 兼容端点。2026-09-06 起它**强制**要求
     * `x-opencode-session`（值：每会话稳定的 ID），缺失直接 400：
     *
     *   Request is missing x-opencode-session and cannot be routed efficiently.
     *
     * 这里的 models 留空是刻意的：Go 计划的可用模型随订阅与官方调整变化，
     * 与其写一份必然过期的清单，不如让用户点「获取模型列表」实时拉（GET /models）。
     */
    baseUrl: 'https://opencode.ai/zen/go/v1',
    models: [],
    defaultModel: '',
    needsKey: true,
    sessionHeader: 'x-opencode-session',
  },
  {
    id: 'custom',
    name: '自定义（OpenAI 兼容）',
    baseUrl: '',
    models: [],
    defaultModel: '',
    // 自定义端点（中转站/代理）通常也需要 Key；无需 Key 的本地服务请选 Ollama
    needsKey: true,
  },
];

/** 思考强度的合法档位（与 ai/types.ts 的 ReasoningEffort 同源） */
export const REASONING_EFFORTS = ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * 归一化思考强度：未知值 → auto。
 *
 * 为什么不「保留原值」：旧配置里可能躺着上游已删除的档位（或用户手改的乱码），
 * 原样发给服务商会得到 400 或静默忽略——两种结果都比「跟随模型」更糟。
 */
export function normalizeReasoningEffort(value?: string | null): ReasoningEffort {
  if (typeof value !== 'string') return 'auto';
  const v = value.trim().toLowerCase();
  return (REASONING_EFFORTS as readonly string[]).includes(v) ? (v as ReasoningEffort) : 'auto';
}

export function getPreset(id?: string): ProviderPreset | undefined {
  if (!id) return undefined;
  return PROVIDERS.find((p) => p.id === id);
}

/**
 * 常见模型的上下文窗口（token，预设兜底值）。
 * 实际配置以用户在设置页手动填写的"模型上下文长度"为准，
 * 拉取模型列表时若服务商返回 context_window 字段会自动带入。
 */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // OpenAI
  'gpt-5.1': 400_000,
  'gpt-5.1-mini': 400_000,
  'gpt-5.1-nano': 400_000,
  'gpt-5': 400_000,
  'gpt-5-mini': 400_000,
  'gpt-4.1': 1_047_000,
  'gpt-4.1-mini': 1_047_000,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  // DeepSeek V4 系列
  'deepseek-v4-flash': 128_000,
  'deepseek-v4-pro': 128_000,
  'deepseek-chat': 128_000,
  'deepseek-reasoner': 128_000,
  // Moonshot Kimi
  'kimi-k3': 256_000,
  'kimi-k2': 256_000,
  'kimi-k2-turbo': 256_000,
  'kimi-k2-thinking': 256_000,
  'kimi-latest': 128_000,
  'moonshot-v1-8k': 8_000,
  'moonshot-v1-32k': 32_000,
  'moonshot-v1-128k': 128_000,
  // 智谱 GLM
  'glm-5.2': 128_000,
  'glm-5.1': 128_000,
  'glm-5': 128_000,
  'glm-4.6': 128_000,
  // Ollama 常见模型（本地模型窗口）
  'qwen3': 128_000,
  'qwen3:0.6b': 32_000,
  'qwen3:4b': 32_000,
  'qwen3:8b': 128_000,
  'qwen3:14b': 128_000,
  'qwen3:32b': 128_000,
  'llama3.3:70b': 128_000,
  'gemma3:27b': 128_000,
  'deepseek-r1:8b': 64_000,
};

/**
 * 获取模型上下文窗口（token）；未知模型回退默认 128K。
 *
 * 这是**唯一**的模型窗口来源：不再有"统一 1M"的兜底。未知模型给 128K 是保守方向——
 * 给小了最多是提前压缩/停止，给大了会直接把请求撑爆（HTTP 400 或被截断）。
 */
export function getModelContextWindow(model: string): number {
  if (!model) return 128_000;
  // 目录优先：models.dev 给的是**真实窗口**。本地表只收录了几十个常见型号，必然过期——
  // 实测 gpt-5.6 在本地表里根本没有，于是 1,050,000 的模型只拿到 128,000 的预算，
  // 压缩阈值提前 8 倍触发。目录未预热（null）时仍回落本地表，不会变成"没有预算"。
  const catalogLimit = lookupActiveModel(model)?.contextLimit;
  if (catalogLimit && catalogLimit > 0) return catalogLimit;
  // 精确匹配优先；再尝试段级前缀匹配（qwen3 → qwen3:32b，避免短名命中无关条目如 llama3 → llama3.3:70b）
  if (MODEL_CONTEXT_WINDOWS[model]) return MODEL_CONTEXT_WINDOWS[model]!;
  const family = model.split(':')[0]!;
  for (const [key, win] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (key.split(':')[0] === family && model.length >= family.length) return win;
  }
  return 128_000;
}

/** 去除 Base URL 末尾斜杠；无协议时自动补：localhost 等本机地址用 http，其余 https */
export function normalizeBaseUrl(baseUrl?: string): string {
  if (!baseUrl) return '';
  let url = baseUrl.trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\//i.test(url)) {
    url = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(url) ? `http://${url}` : `https://${url}`;
  }
  return url;
}

/** 边界钳制：异常存储值（0/负数/超大）回落到安全范围，避免表单与上下文预算异常 */
function clamp(n: number | undefined, min: number, max: number, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

/**
 * 历史遗留的"统一上下文窗口"：1M。
 * v0.2.26 及更早把它当成默认值发给**所有**模型（128K 的模型也拿 1M，8 倍超配），
 * 现在只用来识别"这条配置是旧版本存下来的、其中的 1M 不是用户意图"，便于迁移。
 * 新代码请勿再用它当兜底——兜底一律走 `getModelContextWindow(model)`。
 */
export const LEGACY_CONTEXT_WINDOW = 1_048_576;
/**
 * 上下文窗口的收窄区间。
 *
 * 导出是为了让**所有写入点共用同一组边界**：以前只有 effectiveContextWindow
 * 里钳，而「拉取模型列表时自动填入」那条路径只校验了下限（>= 8000）。
 * 服务商报个 1000 万就被原样存进去，随后被静默钳回 200 万——
 * toast 告诉用户一个数、实际用的是另一个。
 */
export const MIN_CONTEXT_WINDOW = 2_000;
export const MAX_CONTEXT_WINDOW = 2_000_000;
/** 当前配置结构版本（`configVersion`）：写入即代表"contextWindow 语义已是跟随模型" */
export const CONFIG_VERSION = 1;
/** 工具默认返回条数：固定 2000+（列表类工具未显式传 limit 时） */
export const DEFAULT_TOOL_LIMIT = 2000;

/**
 * 求生效的上下文窗口：显式配置优先，否则跟随模型。
 *
 * 迁移规则：没有 `configVersion` 的配置是 v0.2.26 及更早存下来的，其 `contextWindow`
 * **一律视为非用户意图**（那时根本没别的值可写，恒为 1M），直接丢弃改用模型窗口。
 * 不用"是否等于 1M"来判断——那会误伤真的手动填了大窗口的用户。
 */
export function effectiveContextWindow(model: string, saved?: Partial<AIConfig> | null): number {
  const known = getModelContextWindow(model);
  const legacy = saved?.configVersion === undefined;
  const explicit = !legacy && typeof saved?.contextWindow === 'number' ? saved.contextWindow : undefined;
  return clamp(explicit ?? known, MIN_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW, known);
}

/**
 * 合并已保存配置与 Provider 预设，得到实际请求配置。
 * background 与 options 页共用，保证「未填即用预设默认值」的语义一致。
 */
export function resolveConfig(saved?: Partial<AIConfig> | null): AIConfig {
  // providerId 非法（旧版本遗留/手改）时回退默认 DeepSeek，与 configStore 默认一致
  const providerId = saved?.providerId && getPreset(saved.providerId) ? saved.providerId : 'deepseek';
  const preset = getPreset(providerId);
  const model = saved?.model || preset?.defaultModel || '';
  // 模型上下文长度：优先用户显式填写，否则**跟随模型**（此前恒为 1M，128K 的模型会拿到
  // 8 倍于真实窗口的预算，护栏因此永不触发、请求直接被撑爆）
  const contextWindow = effectiveContextWindow(model, saved);
  const compressThreshold = clamp(saved?.compressThreshold, 0.5, 0.95, 0.8);
  return {
    providerId,
    baseUrl: normalizeBaseUrl(saved?.baseUrl || preset?.baseUrl || ''),
    apiKey: saved?.apiKey ?? '',
    model,
    deleteMode: saved?.deleteMode ?? 'confirm',
    planMode: saved?.planMode ?? false,
    contextWindow,
    compressThreshold,
    autoCompress: saved?.autoCompress ?? false,
    autoOrganizeNew: saved?.autoOrganizeNew ?? true,
    // ⚠️ 这里是**白名单**：新增的配置字段必须同时加进来，否则 UI 存进去了、
    // 后台读出来却被丢掉——设置看起来生效了，实际仍是默认值（T81 就是踩了这个坑）。
    autoOrganizeAi: saved?.autoOrganizeAi ?? true,
    // 自定义请求头：原样透传（解析与校验在 request-headers.ts，读的时候不拦）
    customHeaders: saved?.customHeaders ?? '',
    // 思考强度：非法/缺省一律回落 auto（宁可跟随模型，也不发一个上游不认识的档位）
    reasoningEffort: normalizeReasoningEffort(saved?.reasoningEffort),
    /*
     * 会话头名**总是由预设决定**，不读用户存的值：
     * 它不是一个可配置项，而是"这个服务商要求什么"的事实。用户从 OpenCode Go 切到
     * DeepSeek 后，如果还带着 x-opencode-session，就会往一个不认它的端点发无意义的头。
     */
    ...(preset?.sessionHeader ? { sessionHeader: preset.sessionHeader } : {}),
    configVersion: CONFIG_VERSION,
  };
}
