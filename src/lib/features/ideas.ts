/**
 * ── 「点子」接缝 ──
 *
 * 产品意图：点子不是"随机建议"，而是一个会观察书签库、能自己往下做事的个人 Agent。
 * 这一层只定义**数据形状与注册表**，具体生成逻辑在 `lib/ideas/*`。
 *
 * 三条约束（与现有 pet/suggest 一致，不能放宽）：
 *  1. 点子只提议，不执行；执行必须回到既有的暂存/确认/撤销链路。
 *  2. 每条点子必须能说清"依据"（来自哪些书签、哪条规则），不允许模型凭空编。
 *  3. 没有 AI 也要有点子：规则生成的条目永远在，AI 只做增强。
 */

export type IdeaKind =
  /** 老旧/长期未使用的书签 */
  | 'stale'
  /** 重复链接 */
  | 'duplicate'
  /** 空文件夹 */
  | 'empty-folder'
  /** 单域名过度聚集 */
  | 'cluster'
  /** 断链/死链 */
  | 'broken'
  /** 未分类（根级散落） */
  | 'unfiled'
  /** 模型基于全库观察提出的一条 */
  | 'insight';

export type IdeaEffort = 'quick' | 'medium' | 'deep';

export interface IdeaEvidence {
  /** 依据的一句话（"37 条超过 2 年未打开"） */
  text: string;
  /** 可点开核对的样本书签 id（最多 5 个，避免卡片变成列表） */
  sampleIds?: string[];
}

export interface Idea {
  id: string;
  kind: IdeaKind;
  /** 标题：一句话说清"发现了什么" */
  title: string;
  /** 正文：为什么值得做、做了会怎样 */
  body: string;
  /** 点「开始」时发给 Agent 的指令（用户可见、可改） */
  prompt: string;
  /** 预计影响的书签数（未知则不填，UI 显示"待统计"） */
  count?: number;
  /** 会不会改书签 */
  affectsWrites: boolean;
  /** 预计耗时档位，UI 据此排序（quick 先做） */
  effort: IdeaEffort;
  evidence: IdeaEvidence[];
  /** 生成时间 */
  createdAt: number;
  /** 来源：规则 / 模型 */
  source: 'rule' | 'model';
}

export type IdeaGenerator = (input: IdeaInput) => Promise<Idea[]> | Idea[];

export interface IdeaInput {
  roots: chrome.bookmarks.BookmarkTreeNode[];
  /** 用户已确认的长期记忆（习惯/规则），用于让点子贴合本人 */
  habits: string[];
  /** 已有的点子 id：生成器要避开重复 */
  seenIds: string[];
  /** 用户主动要"更多点子"时递增，生成器可据此换角度 */
  round: number;
}

let generator: IdeaGenerator | null = null;

export function registerIdeaGenerator(fn: IdeaGenerator | null): void {
  generator = fn;
}

export function hasIdeaGenerator(): boolean {
  return generator !== null;
}

/**
 * 生成点子：注册了生成器就用它，否则返回空数组。
 *
 * **空数组不是失败**：调用方（UI）会再跑一遍规则建议（pet/suggest），
 * 所以"没有生成器"时界面仍有内容，只是少了模型那部分。
 */
export async function generateIdeas(input: IdeaInput): Promise<{ ideas: Idea[]; note?: string }> {
  if (!generator) return { ideas: [] };
  try {
    return { ideas: await generator(input) };
  } catch (e) {
    return { ideas: [], note: `点子生成失败：${e instanceof Error ? e.message : String(e)}` };
  }
}
