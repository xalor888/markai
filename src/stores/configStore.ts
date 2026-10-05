/** ── AI 配置 store（chrome.storage.local 明文存储，background 直接读取同一 key） ── */

import { create } from 'zustand';
import type { AIConfig } from '@/lib/ai/types';
import { pushToast } from '@/lib/toast';
import { CONFIG_VERSION, getPreset, resolveConfig } from '@/lib/providers';

/** storage key（background 通过该 key 直接读取配置，请勿改动） */
export const CONFIG_STORAGE_KEY = 'markai.config';

export const DEFAULT_CONFIG: AIConfig = {
  providerId: 'deepseek',
  baseUrl: '',
  apiKey: '',
  model: '',
  // 删除默认始终需用户确认（安全）；"无需确认"模式需用户在设置页主动开启
  deleteMode: 'confirm',
  // 轮次级计划默认关闭：先保持既有操作节奏，开启与否是产品决策
  planMode: false,
  // 模型上下文长度：**不填 = 跟随所选模型**（填了就以填写值为准）+ 压缩阈值 80%
  // 曾恒为 1M，与模型无关——128K 的模型也拿 1M，护栏永不触发、请求直接被撑爆。见 providers.ts。
  contextWindow: undefined,
  compressThreshold: 0.8,
  autoCompress: false,
  configVersion: CONFIG_VERSION,
};

interface ConfigState {
  config: AIConfig;
  loaded: boolean;
  /** 从 chrome.storage.local 载入配置 */
  load: () => Promise<void>;
  /** 部分更新并持久化 */
  update: (patch: Partial<AIConfig>) => Promise<{ ok: boolean; error?: string }>;
  /** 应用 Provider 预设（自动填充 Base URL 与默认模型） */
  applyPreset: (providerId: string) => Promise<void>;
  /** 最近一次设置保存失败的如实说明（null = 正常）；at 稳定，界面只提示一次 */
  saveError: { message: string; at: number } | null;
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

  saveError: null,

  async update(patch) {
    // 每次保存都盖上当前结构版本：contextWindow 的语义是"跟随模型"，
    // 旧版本存下来的那条（恒为 1M）在 resolveConfig 里会被当作非用户意图丢弃。
    const next = { ...get().config, ...patch, configVersion: CONFIG_VERSION };
    // 先同步更新内存（UI 即时响应），再异步持久化：
    // 两个快速连续 update 都基于最新内存构造，互不覆盖（原实现后写覆盖先写的其他字段）
    set({ config: next });
    try {
      await chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: next });
      // 保存成功：清掉上一次的失败状态（提示是一次性的）
      if (get().saveError) set({ saveError: null });
      return { ok: true };
    } catch (e) {
      // 原先这里是空 catch，注释称"下次输入会再写"——但配额满时之后**每次**都会失败，
      // 而 UI 已经显示成保存好了。这条路径存的是 API Key、Base URL、模型与**删除模式**：
      // 删除模式保存失败会让"改为需要确认"变成假象，重载后 Agent 仍会不打招呼就删。
      const reason = e instanceof Error ? e.message : String(e);
      let used = '';
      try {
        const bytes = await chrome.storage.local.getBytesInUse(CONFIG_STORAGE_KEY);
        used = `（当前该键占用约 ${(bytes / 1024).toFixed(0)} KiB）`;
      } catch {
        // 拿不到占用不影响"失败"这件事本身
      }
      // 删除模式是安全相关字段：失败必须点名风险，而不是笼统说一句"保存失败"
      const risky = patch.deleteMode !== undefined;
      const message = risky
        ? `设置未能保存${used}：${reason}。**删除模式没有生效**——重启/重载后仍会是原来的模式，若你刚把它改成「需要确认」，请务必重试直到保存成功，否则 Agent 可能仍会直接删除。`
        : `设置未能保存${used}：${reason}。重启后会回到上一次成功保存的值。`;
      const prev = get().saveError;
      const at = prev && prev.message === message ? prev.at : Date.now();
      set({ saveError: { message, at } });
      if (!prev || prev.message !== message) {
        pushToast('设置未能保存', { variant: 'destructive', description: reason });
      }
      // 如实返回结果：调用方（例如"重试保存"按钮）据此给出真实反馈，
      // 而不是不管成败都显示同一句话。
      return { ok: false, error: reason };
    }
  },

  async applyPreset(providerId) {
    const preset = getPreset(providerId);
    if (!preset) {
      await get().update({ providerId, baseUrl: '', model: '', contextWindow: undefined });
      return;
    }
    // 用户已手动改过 Base URL 时保留，仅切换 providerId 与模型。
    // contextWindow 一并清空：换了服务商/模型，旧的显式窗口不该继续生效
    // （从 1M 的模型切到 128K 的模型却沿用旧值，正是"请求被撑爆"的成因）。
    await get().update({ providerId, model: preset.defaultModel, contextWindow: undefined });
  },

  effectiveConfig() {
    return resolveConfig(get().config);
  },
}));
