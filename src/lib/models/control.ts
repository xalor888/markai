/**
 * ── 思考强度控件该长什么样（纯决策，不含 JSX） ──
 *
 * 为什么单独抽出来：这段判断有五种结局，而且**三种都是"不给控件"**——
 *   unknown      目录里没这个模型 → 只能按默认发，不能假装知道
 *   unsupported  模型根本不思考 → 给控件等于骗人
 *   immutable    会思考但不可调（kimi-k2.7 那种）→ 给滑杆同样等于骗人
 *   toggle       只能开/关 → 两档按钮
 *   effort       有档位 → 分段控件
 * 五分支埋在 JSX 里就只能靠肉眼复查；抽成纯函数后每条都能被测试钉住。
 */

import type { ReasoningPolicy } from './types';

export type ReasoningControlMode = 'effort' | 'toggle' | 'unsupported' | 'immutable' | 'unknown';

export interface ReasoningOption {
  /** 写进 AIConfig.reasoningEffort 的值 */
  value: string;
  /** 按钮上的中文标签 */
  label: string;
}

export interface ReasoningControl {
  mode: ReasoningControlMode;
  /** 可选项；不可调时只有「默认」一项，且 UI 应禁用 */
  options: ReasoningOption[];
  /** 必须显示的一行解释（不给控件时尤其要说清为什么） */
  hint: string;
  /** 目录里该模型真实可用的档位（展示用） */
  efforts: string[];
  /** 是否该允许用户点击（false = 只展示当前值） */
  interactive: boolean;
}

/** 档位的中文标签（与 EFFORT_ORDER 同序） */
const EFFORT_LABELS: Record<string, string> = {
  none: '关闭',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
};

export function effortLabel(value: string): string {
  return EFFORT_LABELS[value] ?? value;
}

/**
 * 决策入口。
 *
 * @param policy 目录给出的思考能力；null = 目录里查不到这个模型
 * @param modelId 仅用于写进提示文案（让用户知道是哪个模型查不到）
 */
export function reasoningControl(policy: ReasoningPolicy | null, modelId: string): ReasoningControl {
  if (!policy) {
    return {
      mode: 'unknown',
      options: [{ value: 'auto', label: '默认' }],
      hint: `目录里没有「${modelId || '这个模型'}」的元数据，思考强度按默认发送（不指定档位）。`,
      efforts: [],
      interactive: false,
    };
  }
  if (!policy.supported) {
    return {
      mode: 'unsupported',
      options: [{ value: 'auto', label: '默认' }],
      hint: '该模型不支持思考，不会发送任何思考参数。',
      efforts: [],
      interactive: false,
    };
  }
  if (policy.kind === 'toggle') {
    return {
      mode: 'toggle',
      options: toggleOptions(),
      hint: '该模型只能开关思考，没有中间档。',
      efforts: [],
      interactive: true,
    };
  }
  if (policy.efforts.length === 0) {
    return {
      mode: 'immutable',
      options: [{ value: 'auto', label: '自动' }],
      hint: '该模型会自动思考，档位不可调（目录里没有可选项）。',
      efforts: [],
      interactive: false,
    };
  }
  return {
    mode: 'effort',
    options: [{ value: 'auto', label: '默认' }, ...policy.efforts.map((e) => ({ value: e, label: effortLabel(e) }))],
    hint: `该模型支持的档位：${policy.efforts.map(effortLabel).join(' · ')}。默认 = 按模型自己的推荐值。`,
    efforts: policy.efforts,
    interactive: true,
  };
}

/**
 * toggle 型模型的额外选项：目录只给 `{type:'toggle'}` 时没有 effort 档位，
 * 但用户仍然需要「关掉思考」这个能力（省 token、省延迟）。
 *
 * 与 `reasoningControl` 分开是因为语义不同：toggle 是"开/关"，effort 是"档位"。
 * 混在一起会让 UI 在 toggle 模型上画出"关闭/极低/低/…"这种根本不存在的档位。
 */
export function toggleOptions(): ReasoningOption[] {
  return [
    { value: 'auto', label: '默认（开）' },
    { value: 'none', label: '关闭' },
  ];
}
