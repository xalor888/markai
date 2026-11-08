/**
 * ── 主动建议：把"观察"和"你让我记住的规则"合成一次可执行的提议 ──
 *
 * 这是"管家"与"工具"的分界线：工具等你下指令，管家会主动说
 * 「有 12 组重复链接，按你惯用的『按语言分类』，我可以合并到技术/中文」。
 *
 * 三条不可让步的约束：
 *  1. **建议不是执行**：产出的是文案 + 一句可发送的 prompt，绝不自动动书签
 *  2. **写操作必须写明**（`affectsWrites`），让 UI 能提前提醒"这会改东西"
 *  3. **引用习惯时必须能溯源**：习惯来自用户确认过的记忆条目，不是模型编的
 *
 * 纯函数：不碰 IO、不碰 store。
 */

import type { ChatterFact } from './chatter';

export interface Suggestion {
  /** 稳定 id（同一条建议跨多次生成要能去重/冷却） */
  id: string;
  /** 给用户看的一句话 */
  text: string;
  /** 点「开始」时发给 Agent 的指令（用户可见、可改） */
  prompt: string;
  /** 这条建议会不会改动书签（UI 据此提示确认） */
  affectsWrites: boolean;
}

/** 习惯条目可以是记忆（content）也可以是候选（text），两者都认 */
export interface HabitLike {
  content?: string;
  text?: string;
}

function habitOf(habits: HabitLike[]): string | null {
  for (const h of habits) {
    const t = (h.content ?? h.text ?? '').trim();
    // 太短的习惯（"别动"两个字）放进建议里读不通，宁可不用
    if (t.length >= 4) return t;
  }
  return null;
}

/**
 * 从事实与习惯里合成**一条**建议（优先级：重复链接 > 单域名聚集 > 空文件夹）。
 *
 * 为什么只出一条：一次给三个建议等于什么都没说，用户只会点掉最上面那个，
 * 剩下两个变成视觉噪音。
 */
export function buildSuggestion(facts: ChatterFact[], habits: HabitLike[] = []): Suggestion | null {
  if (facts.length === 0) return null;
  const habit = habitOf(habits);
  const dup = facts.find((f) => f.id === 'dup-urls');
  const cluster = facts.find((f) => f.id === 'domain-cluster');
  const empty = facts.find((f) => f.id === 'empty-folders');

  if (dup) {
    return {
      id: 'suggest-merge-dups',
      text: habit
        ? `${dup.text.replace('，要我合并一下吗？', '')}。按你惯用的「${habit}」，我可以一次合并掉。`
        : `${dup.text.replace('，要我合并一下吗？', '')}，要我合并吗？`,
      prompt: habit
        ? `把我收藏夹里的重复链接合并掉（保留最早收藏的那条），遵循这条规则：${habit}`
        : '把我收藏夹里的重复链接合并掉，保留最早收藏的那条',
      affectsWrites: true,
    };
  }

  if (cluster) {
    return {
      id: 'suggest-cluster-domain',
      text: habit
        ? `${cluster.text.replace('，要不要归到一个文件夹？', '')}。按「${habit}」可以归到一起。`
        : cluster.text.replace('，要不要归到一个文件夹？', '') + '，要归到一起吗？',
      prompt: habit
        ? `把一个站点下积累过多的书签归并到一个文件夹，遵循这条规则：${habit}`
        : '把一个站点下积累过多的书签归并到一个文件夹',
      affectsWrites: true,
    };
  }

  if (empty) {
    return {
      id: 'suggest-clean-empty',
      text: `${empty.text}要我清掉吗？`,
      prompt: '清理所有空文件夹（不要动里面的书签）',
      affectsWrites: true,
    };
  }

  // 只剩"总量大"这类没有具体动作的事实：不给建议（说了也不知道做什么）
  return null;
}
