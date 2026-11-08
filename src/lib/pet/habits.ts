/**
 * ── 习惯提取：从用户自己说过的话里找"稳定的偏好" ──
 *
 * 现状：记忆只能靠模型主动调 `remember` 工具，或用户在设置页手动加。
 * 两条路都要求"用户已经意识到自己有个习惯"。真正像管家的做法是：
 * 听见一句"工作那个文件夹别动"，就把它当成候选——**但不直接生效**。
 *
 * 所以这个模块只产出**候选**（带证据原句），确认与否是人的事：
 * 看不见、不能否认的记忆等于黑箱，比没有记忆更糟。
 *
 * 纯函数：不做 IO、不碰 store，于是"什么算习惯"这件事可以被测试钉住。
 */

import type { MemoryCategory } from '@/lib/ai/memory';

export interface HabitCandidate {
  /** 归一化后的陈述（直接可以写进记忆条目） */
  text: string;
  category: MemoryCategory;
  /** 触发它的原句：用户确认时能看到"你是因为这句话才这么建议的" */
  evidence: string;
  /** 关键词强度换算的置信度（0–1），仅用于排序，不作为自动生效依据 */
  confidence: number;
}

/** 强指令：明确的边界（"别动"、"不许"、"永远"）——最值得记住 */
const STRONG = /(别动|不要动|不许|不准|永远|一律|以后都|再也别|千万别|never|always)/i;
/** 偏好：分类/命名/组织方式的倾向 */
const PREFERENCE = /(喜欢|偏向|习惯|按.{1,8}分类|统一用|一律用|都放|都归|prefer|organize by)/i;
/** 条件规则：带前提的约束 */
const CONDITION = /(除非|如果.{1,12}(就|才)|只有.{1,12}才|if .{1,12}then)/i;

/** 陈述长度上限：超过这个长度基本是"描述一次任务"，不是"表达一个偏好" */
const MAX_HABIT_CHARS = 60;

/** 判断是否是"一次任务指令"而非"稳定偏好"：带具体数量/具体标题的多半是任务 */
const TASK_HINT = /(把这些|这个文件夹|刚才|上面|下面这|帮我整理一下这)/;

/**
 * 归一化：去首尾空白、压缩连续空白、去掉句末语气与标点。
 *
 * 不做同义词替换——那会引入"猜"，而猜错的记忆比没有记忆更危险。
 */
export function normalizeHabit(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[。！!？?；;，,、…]+$/g, '')
    // 前缀词可能叠着出现（"请帮我"、"麻烦你"），要循环吃干净
    .replace(/^(?:(?:请|麻烦|帮我|你)\s*)+/, '')
    .trim();
}

/** 单句 → 候选；不像习惯就返回 null */
export function habitFromSentence(sentence: string): HabitCandidate | null {
  const raw = sentence.trim();
  if (!raw || raw.length < 6) return null;
  // 一次任务指令不该变成长期习惯（"帮我整理一下这个文件夹"是任务，不是偏好）
  if (TASK_HINT.test(raw)) return null;

  let confidence = 0;
  if (STRONG.test(raw)) confidence = 0.8;
  else if (PREFERENCE.test(raw)) confidence = 0.6;
  else if (CONDITION.test(raw)) confidence = 0.5;
  if (confidence === 0) return null;

  const text = normalizeHabit(raw).slice(0, MAX_HABIT_CHARS);
  if (text.length < 4) return null;
  return {
    text,
    category: STRONG.test(raw) ? 'rule' : 'preference',
    evidence: raw.slice(0, 120),
    confidence,
  };
}

/**
 * 从一批用户原话里提取候选。
 *
 * 只接受**用户自己说的**（调用方传 user 消息）：把 Agent 的复述当证据，
 * 会让"我自己总结的偏好"凭空变成"用户的要求"。
 */
export function extractHabits(userTexts: string[]): HabitCandidate[] {
  const out: HabitCandidate[] = [];
  for (const t of userTexts) {
    // 长消息按句切开：一句话里只拎出表达偏好的那半句
    const sentences = t.split(/[。！？!?\n]+/);
    for (const s of sentences) {
      const c = habitFromSentence(s);
      if (c) out.push(c);
    }
  }
  return dedupeHabits(out);
}

/** 去重用的比较键：忽略大小写、标点与全部空白 */
function habitKey(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}]/gu, '');
}

/**
 * 合并相似候选：同一件事说两次说明它更重要，但**只留一条**。
 *
 * 合并时保留置信度更高的那条（并把它稍微抬高）：重复出现是证据，不是新条目。
 */
export function dedupeHabits(candidates: HabitCandidate[]): HabitCandidate[] {
  const byKey = new Map<string, HabitCandidate>();
  for (const c of candidates) {
    const k = habitKey(c.text);
    if (!k) continue;
    const prev = byKey.get(k);
    if (!prev) {
      byKey.set(k, c);
      continue;
    }
    const stronger = prev.confidence >= c.confidence ? prev : c;
    byKey.set(k, { ...stronger, confidence: Math.min(1, stronger.confidence + 0.05) });
  }
  return [...byKey.values()];
}

/** 候选是否已经存在于记忆里（避免重复建议"要记住吗"） */
export function alreadyKnown(text: string, existing: { text: string }[]): boolean {
  const k = habitKey(normalizeHabit(text));
  return existing.some((m) => habitKey(m.text) === k);
}
