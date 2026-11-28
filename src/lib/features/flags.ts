/**
 * ── 功能开关（共享契约） ──
 *
 * 三块新能力（语义搜索 / 点子管家 / 对外接口）各自独立开发，但都必须能"缺席"：
 * 某个 worktree 的模块还没合进来时，`main` 仍然要能编译、能跑、能诚实地告诉用户
 * "这个能力还没装好"，而不是白屏或假装成功。
 *
 * 约定：
 *  · 开关只由模块是否可用决定（动态 import 成功与否），不由用户手动拨。
 *  · 缺席时 UI 走 fallback（本地检索 / 规则建议 / 只读说明），不隐藏入口——
 *    入口突然消失比"功能未就绪"更让人困惑。
 *  · 新增能力必须在这里登记，避免三处各写一份"有没有"的判断。
 */

export const FEATURE_KEYS = ['semanticSearch', 'ideas', 'externalApi'] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export interface FeatureState {
  /** 模块已加载，功能可用 */
  ready: boolean;
  /** 未就绪时给用户看的一句话（不喊"错误"，只说明现状与下一步） */
  note?: string;
}

export const FEATURE_NOTES: Record<FeatureKey, string> = {
  semanticSearch: '向量检索未启用：当前使用关键词匹配，结果仍可用。',
  ideas: '点子助手未启用：当前只显示规则生成的建议。',
  externalApi: '对外接口未启用：外部 Agent 暂时无法读取书签。',
};

/** 把一个"模块是否存在"的事实折成 UI 需要的状态 */
export function featureState(key: FeatureKey, ready: boolean): FeatureState {
  return ready ? { ready: true } : { ready: false, note: FEATURE_NOTES[key] };
}
