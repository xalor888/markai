/**
 * ── 语义搜索自己的设置 ──
 *
 * 为什么独立于 `markai.config`：AI 配置的每个字段都要在 `resolveConfig` 白名单里
 * 再写一遍，漏一个就会出现"设置存了、后台读出来是默认值"。语义搜索的设置只有
 * 一个开关，放在自己的 key 里，读写都在这一个文件，不会牵连模型配置。
 */

export const SEMANTIC_SETTINGS_KEY = 'markai.semantic.settings';

export interface SemanticSettings {
  /** 是否允许把书签标题/路径发给已配置的 OpenAI 兼容 /embeddings 端点 */
  remoteEmbed: boolean;
}

export const SEMANTIC_DEFAULT_SETTINGS: SemanticSettings = {
  remoteEmbed: false,
};

export async function readSemanticSettings(): Promise<SemanticSettings> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return { ...SEMANTIC_DEFAULT_SETTINGS };
  try {
    const data = await chrome.storage.local.get(SEMANTIC_SETTINGS_KEY);
    const saved = data[SEMANTIC_SETTINGS_KEY] as Partial<SemanticSettings> | undefined;
    return {
      remoteEmbed: saved?.remoteEmbed === true,
    };
  } catch {
    // 存储读失败就按默认（本地向量）走，搜索本身不受影响
    return { ...SEMANTIC_DEFAULT_SETTINGS };
  }
}

export async function writeSemanticSettings(patch: Partial<SemanticSettings>): Promise<SemanticSettings> {
  const current = await readSemanticSettings();
  const next: SemanticSettings = { ...current, ...patch };
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    await chrome.storage.local.set({ [SEMANTIC_SETTINGS_KEY]: next });
  }
  return next;
}
