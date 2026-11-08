/**
 * ── 宠物的一句话（碎碎念的频率模型） ──
 *
 * 这是"管家感"最容易被做坏的地方：一个会说话的小东西，第一次很可爱，
 * 第十次就是在骚扰。所以**核心不是文案，是克制**——四条硬规则：
 *
 *  1. 全局最小间隔：两次之间至少 90 秒
 *  2. 同一事实冷却：同一条观察 30 分钟内不再说
 *  3. 被打断就闭嘴：用户正在说话/正在跑任务时，静默一段时间
 *  4. 有话说才说：没有候选就是不说，绝不为了"活跃"而编一句
 *
 * 这个模块只做"该不该说、说哪句"，不搬数据也不碰 UI：
 * 事实（facts）由调用方从书签统计里算出来，于是频率模型可以单独被测试钉住。
 */

/** 一条可说的观察（由调用方计算，例如"有 12 个重复书签"） */
export interface ChatterFact {
  /** 稳定 id：同一件事重复出现要共用冷却（不能用文案做 id，文案会改） */
  id: string;
  text: string;
  /** 权重：越大越想先说（0 = 基本不说） */
  weight: number;
}

export interface ChatterState {
  /** 上一次说任何话的时间（0 = 从没说过） */
  lastAnyAt: number;
  /** 每条事实各自的上次提及时间 */
  lastById: Record<string, number>;
  /** 静默到这个时间为止（被打断 / 用户正在忙） */
  mutedUntil: number;
}

export interface ChatterConfig {
  minGapMs: number;
  perFactCooldownMs: number;
  /** 候选太多时只看权重最高的这几条（避免老事实永远排在后面） */
  poolSize: number;
}

export const DEFAULT_CHATTER_CONFIG: ChatterConfig = {
  // 90 秒：短于此会打断用户阅读；长于此又容易"一整天不说一句"
  minGapMs: 90_000,
  // 30 分钟：同一件事反复说最招人烦——用户已经看到了，只是还没决定要不要处理
  perFactCooldownMs: 30 * 60_000,
  poolSize: 3,
};

/**
 * 选出这一轮要说的话；没有合适的就是 `null`（**这是正常情况，不是失败**）。
 *
 * @param random 注入以便测试（加权选择需要可复现）
 */
export function pickChatter(
  facts: ChatterFact[],
  state: ChatterState,
  now: number,
  config: Partial<ChatterConfig> = {},
  random: () => number = Math.random,
): ChatterFact | null {
  const cfg = { ...DEFAULT_CHATTER_CONFIG, ...config };

  if (now < state.mutedUntil) return null;
  if (state.lastAnyAt > 0 && now - state.lastAnyAt < cfg.minGapMs) return null;

  const fresh = facts
    .filter((f) => f.weight > 0)
    .filter((f) => {
      const last = state.lastById[f.id];
      return last === undefined || now - last >= cfg.perFactCooldownMs;
    });
  if (fresh.length === 0) return null;

  // 取权重最高的一小撮再随机选：直接取最高会让"重复书签"永远压住其他观察
  const pool = [...fresh].sort((a, b) => b.weight - a.weight).slice(0, Math.max(1, cfg.poolSize));
  const total = pool.reduce((acc, f) => acc + f.weight, 0);
  if (total <= 0) return null;
  let roll = random() * total;
  for (const f of pool) {
    roll -= f.weight;
    if (roll <= 0) return f;
  }
  return pool[pool.length - 1] ?? null;
}

/** 说完一句之后更新状态（调用方在真正展示时调用一次） */
export function markSaid(state: ChatterState, fact: ChatterFact, now: number): ChatterState {
  return {
    lastAnyAt: now,
    lastById: { ...state.lastById, [fact.id]: now },
    mutedUntil: state.mutedUntil,
  };
}

/**
 * 被打断时静默。
 *
 * 为什么是 10 分钟而不是永久：永久会把碎碎念彻底关掉（再也不会自己恢复）；
 * 10 分钟足够让"你正在说话"的那一刻安静下来，又不会让宠物从此哑掉。
 */
export const INTERRUPT_MUTE_MS = 10 * 60_000;

export function muteOnInterrupt(state: ChatterState, now: number): ChatterState {
  return { ...state, mutedUntil: now + INTERRUPT_MUTE_MS };
}
