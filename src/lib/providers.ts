/** ── AI Provider 预设（OpenAI 兼容协议） ── */

import type { AIConfig } from './ai/types';

/** Provider 预设描述 */
export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  defaultModel: string;
  /** 是否需要 API Key */
  needsKey: boolean;
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
    id: 'custom',
    name: '自定义（OpenAI 兼容）',
    baseUrl: '',
    models: [],
    defaultModel: '',
    // 自定义端点（中转站/代理）通常也需要 Key；无需 Key 的本地服务请选 Ollama
    needsKey: true,
  },
];

export function getPreset(id: string): ProviderPreset | undefined {
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

/** 获取模型上下文窗口（token）；未知模型回退默认 128K */
export function getModelContextWindow(model: string): number {
  if (!model) return 128_000;
  // 精确匹配优先；再尝试段级前缀匹配（qwen3 → qwen3:32b，避免短名命中无关条目如 llama3 → llama3.3:70b）
  if (MODEL_CONTEXT_WINDOWS[model]) return MODEL_CONTEXT_WINDOWS[model]!;
  const family = model.split(':')[0]!;
  for (const [key, win] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (key.split(':')[0] === family && model.length >= family.length) return win;
  }
  return 128_000;
}

/** 去除 Base URL 末尾斜杠；无协议时自动补：localhost 等本机地址用 http，其余 https */
export function normalizeBaseUrl(baseUrl: string): string {
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

/** 模型上下文长度默认值（用户未填写时使用）：1024K（1M tokens），覆盖绝大多数大模型 */
export const DEFAULT_CONTEXT_WINDOW = 1_048_576;
/** 工具默认返回条数：固定 2000+（列表类工具未显式传 limit 时） */
export const DEFAULT_TOOL_LIMIT = 2000;

/**
 * 合并已保存配置与 Provider 预设，得到实际请求配置。
 * background 与 options 页共用，保证「未填即用预设默认值」的语义一致。
 */
export function resolveConfig(saved?: Partial<AIConfig> | null): AIConfig {
  // providerId 非法（旧版本遗留/手改）时回退默认 DeepSeek，与 configStore 默认一致
  const providerId = saved?.providerId && getPreset(saved.providerId) ? saved.providerId : 'deepseek';
  const preset = getPreset(providerId);
  const model = saved?.model || preset?.defaultModel || '';
  // 模型上下文长度：优先用户显式填写，否则默认 1024K（不依赖模型名猜测，用户无需手动配置）
  const contextWindow = clamp(saved?.contextWindow ?? DEFAULT_CONTEXT_WINDOW, 2000, 2_000_000, DEFAULT_CONTEXT_WINDOW);
  const compressThreshold = clamp(saved?.compressThreshold, 0.5, 0.95, 0.8);
  return {
    providerId,
    baseUrl: normalizeBaseUrl(saved?.baseUrl || preset?.baseUrl || ''),
    apiKey: saved?.apiKey ?? '',
    model,
    deleteMode: saved?.deleteMode ?? 'confirm',
    contextWindow,
    compressThreshold,
    autoCompress: saved?.autoCompress ?? false,
  };
}
