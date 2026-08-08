/** ── AI 配置 store（chrome.storage.local 明文存储，background 直接读取同一 key） ── */

import { create } from 'zustand';
import type { AIConfig } from '@/lib/ai/types';
import { getPreset, resolveConfig } from '@/lib/providers';

/** storage key（background 通过该 key 直接读取配置，请勿改动） */
export const CONFIG_STORAGE_KEY = 'markai.config';

const DEFAULT_CONFIG: AIConfig = {
  providerId: 'deepseek',
  baseUrl: '',
  apiKey: '',
  model: '',
  // 删除默认始终需用户确认（安全）；"无需确认"模式需用户在设置页主动开启
  deleteMode: 'confirm',
  // 模型上下文长度（默认 1024K）+ 压缩阈值 80%
  contextWindow: 1_048_576,
  compressThreshold: 0.8,
  autoCompress: false,
};

interface ConfigState {
  config: AIConfig;
  loaded: boolean;
  /** 从 chrome.storage.local 载入配置 */
  load: () => Promise<void>;
  /** 部分更新并持久化 */
  update: (patch: Partial<AIConfig>) => Promise<void>;
  /** 应用 Provider 预设（自动填充 Base URL 与默认模型） */
  applyPreset: (providerId: string) => Promise<void>;
  /** 计算实际请求配置（未填项回落到预设默认值） */
  effectiveConfig: () => AIConfig;
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  config: DEFAULT_CONFIG,
  loaded: false,

  async load() {
    try {
      const data = await chrome.storage.local.get(CONFIG_STORAGE_KEY);
      const saved = data[CONFIG_STORAGE_KEY] as AIConfig | undefined;
      set({ config: { ...DEFAULT_CONFIG, ...(saved ?? {}) } });
    } catch {
      // 存储异常时回退默认配置，避免页面卡在加载态
      set({ config: DEFAULT_CONFIG });
    } finally {
      set({ loaded: true });
    }
  },

  async update(patch) {
    const next = { ...get().config, ...patch };
    // 先同步更新内存（UI 即时响应），再异步持久化：
    // 两个快速连续 update 都基于最新内存构造，互不覆盖（原实现后写覆盖先写的其他字段）
    set({ config: next });
    try {
      await chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: next });
    } catch {
      // 自动保存失败静默（下次输入会再写），内存配置照常生效
    }
  },

  async applyPreset(providerId) {
    const preset = getPreset(providerId);
    if (!preset) {
      await get().update({ providerId, baseUrl: '', model: '' });
      return;
    }
    // 用户已手动改过 Base URL 时保留，仅切换 providerId 与模型
    await get().update({ providerId, model: preset.defaultModel });
  },

  effectiveConfig() {
    return resolveConfig(get().config);
  },
}));
