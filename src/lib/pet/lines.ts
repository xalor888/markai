/**
 * ── 被戳时它说什么 ──
 *
 * 与 `chatter.ts` 的碎碎念不同：那套是"观察到了什么就说什么"（有事实源、有冷却），
 * 这里是**用户主动戳它**时的回应——不能算骚扰，所以频率模型不适用，但也不能只准备一句。
 *
 * 三条规则：
 *  1. **看心情说话**：睡觉时被戳、干活时被戳、担心删除时被戳，回应必须不一样，
 *     否则它就是个随机文案机。
 *  2. **同心情多条**：连戳三下不该重复同一句；用外部计数器（seed）轮转，不做随机。
 *  3. **短**：气泡最大 190px，超过 18 个汉字的句子会自动换行成两行，读起来像在喘气。
 */

export type PokeState = 'sleeping' | 'idle' | 'curious' | 'listening' | 'thinking' | 'working' | 'talking' | 'happy' | 'proud' | 'worried' | 'error';

type Lines = Partial<Record<PokeState, string[]>>;

const LINES: Lines = {
  sleeping: ['……嗯？', '别戳，我再睡会儿', '呼……呼……'],
  idle: ['嘿，我在这儿', '要整理一下书签吗', '戳我干嘛，我脸上有书吗'],
  curious: ['你在想什么', '那个文件夹是干嘛的', '我盯着你呢'],
  listening: ['你说，我记着', '继续，我听着呢', '嗯嗯'],
  thinking: ['别急，我在想', '脑子转着呢', '再给我两秒'],
  working: ['手上正忙着', '别催别催', '马上好'],
  talking: ['我正说着呢', '你听我说完', '嗯？'],
  happy: ['嘿嘿', '今天心情不错', '再来一下'],
  proud: ['怎么样，不错吧', '我可是很能干的', '看我'],
  worried: ['这些要删吗', '你确认一下再删', '我有点慌'],
  error: ['摔了一下，没事', '等下，我缓缓', '这步出错了'],
};

/** 兜底：万一某个心情没写文案，也不能吐出空气泡 */
const FALLBACK_LINE = '我在这儿';
const FALLBACK = [FALLBACK_LINE];

/**
 * 选出这一句。
 *
 * @param seed 外部递增计数器（同一心情里轮转）。不用 Math.random：
 *   UI 文案的随机化在测试里没法断言"连戳两次不重复"。
 */
export function pickPokeLine(state: PokeState, seed: number): string {
  const pool = LINES[state] ?? FALLBACK;
  const i = ((seed % pool.length) + pool.length) % pool.length;
  return pool[i] ?? FALLBACK_LINE;
}

/** 观察类碎碎念在没有事实可讲时的兜底（只在用户主动戳时使用） */
export function pickIdleLine(seed: number): string {
  return pickPokeLine('idle', seed);
}
