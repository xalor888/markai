/**
 * ── 模型目录的「内部形状」（来源：models.dev） ──
 *
 * 为什么不直接用 models.dev 的原始 JSON：
 *  - 它有 235 个 provider、5.7 MB，字段半数与「发一次 chat 请求」无关
 *    （open_weights / knowledge / structured_output / doc …）；
 *  - 一旦上游改字段名，全项目都会跟着炸。内部形状是**稳定契约**，
 *    归一化只在 catalog.ts 一处做，上游怎么变都只影响那一个函数。
 */

/** 思考能力的两种形态（models.dev 的 reasoning_options.type） */
export type ReasoningKind = 'toggle' | 'effort';

/**
 * 一个模型的思考能力。
 *
 * `kind` 为 null 的两种情况要分开理解：
 *  - `supported: false` → 模型根本没有思考能力（gpt-4.1 这类），UI 不该出现思考强度控件
 *  - `kind: null` 但 `supported: true` → 模型会思考但**不可调**（kimi-k2.7 的 `reasoning_options: []`），
 *    UI 只能显示"该模型自动思考"，不能给滑杆——给了就是骗人。
 */
export interface ReasoningPolicy {
  supported: boolean;
  kind: ReasoningKind | null;
  /** 可发的 effort 档位，由弱到强；`kind=toggle` 或不可调时为空数组 */
  efforts: string[];
  /**
   * 思考流在 SSE `delta` 里的字段名（models.dev 的 `interleaved.field`）。
   * 实测 DeepSeek / Kimi / GLM 都是 `reasoning_content`；OpenAI 系走 `reasoning` 分支、这里为空。
   */
  field: string | null;
}

/** 目录里的一个模型 */
export interface ModelInfo {
  id: string;
  /** 归一化后的 provider id（可能是 models.dev 的 id，与本地 preset 不同，见 PROVIDER_ALIASES） */
  providerId: string;
  name: string;
  description: string | null;
  /** 上下文窗口（token）。null = 上游没给，调用方回退本地表 */
  contextLimit: number | null;
  /** 单次输出上限（token） */
  outputLimit: number | null;
  reasoning: ReasoningPolicy;
  toolCall: boolean;
  attachment: boolean;
  /** 每百万 token 的价格（上游就是「每百万」口径，不再换算） */
  cost: { input: number | null; output: number | null } | null;
  updatedAt: string | null;
}

export interface CatalogProvider {
  id: string;
  name: string;
  models: ModelInfo[];
}

export interface ModelCatalog {
  /** 拉取时间戳；0 表示这份是内置快照（never fetched） */
  fetchedAt: number;
  source: 'remote' | 'fallback';
  providers: CatalogProvider[];
}

/** 归一化过程中被丢掉的条目（不静默：坏一行不代表整份目录作废，但要记下来） */
export interface CatalogIssue {
  providerId: string;
  modelId: string;
  reason: string;
}
