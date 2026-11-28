/**
 * 点子生成器注册：把规则层 + 模型增强接到共享接缝上。
 *
 * 这里的顺序很重要：**先规则、后模型**。
 *  · 规则点子同步产出，用户点开面板立刻有东西看；
 *  · 模型点子异步追加，失败就静默丢弃——不能因为模型慢/挂，
 *    让用户对着一个转圈的面板等。
 *
 * 冷却（`markai.ideas.seen`）在这里落地：忽略一条点子 → 记时间 → 7 天内不再出现。
 */
import { registerIdeaGenerator, type Idea, type IdeaInput } from '@/lib/features/ideas';
import { useConfigStore } from '@/stores/configStore';
import { generateModelIdeas } from './model';
import { IDEAS_SEEN_KEY, activeSeenIds, generateRuleIdeas, pruneSeen, type SeenRecord } from './rules';

async function readSeen(now: number): Promise<SeenRecord[]> {
  try {
    const data = await chrome.storage.local.get(IDEAS_SEEN_KEY);
    return pruneSeen(data[IDEAS_SEEN_KEY], now);
  } catch {
    return [];
  }
}

/** 把一条点子记入冷却表（"忽略"与"开始"都会记：用户已经处理过的不用再提） */
export async function markIdeaSeen(id: string, now: number = Date.now()): Promise<void> {
  try {
    const existing = await readSeen(now);
    const next = pruneSeen([...existing.filter((r) => r.id !== id), { id, at: now }], now);
    await chrome.storage.local.set({ [IDEAS_SEEN_KEY]: next });
  } catch {
    // 写失败只影响"下次还提不提"，不值得打断当前操作
  }
}

/** 清空冷却表：用户点"刷新"想看全部点子时用 */
export async function clearSeenIdeas(): Promise<void> {
  try {
    await chrome.storage.local.remove(IDEAS_SEEN_KEY);
  } catch {
    // 同上
  }
}

/**
 * 生成点子：规则立刻返回，模型增强再追加。
 *
 * 返回的是**最终合并结果**（规则 + 通过过滤的模型点子），
 * 所以调用方不需要知道"哪条来自谁"——每条自带的 `source` 已经说明了。
 */
async function generate(input: IdeaInput): Promise<Idea[]> {
  const now = Date.now();
  const seen = await readSeen(now);
  const seenIds = new Set([...input.seenIds, ...activeSeenIds(seen)]);
  const enriched: IdeaInput = { ...input, seenIds: [...seenIds] };

  const rules = generateRuleIdeas(enriched, now);
  const config = useConfigStore.getState().config;
  const controller = new AbortController();
  // 模型增强最多等 12s：超过这个时间用户已经看完规则点子并开始操作了，
  // 再追加一批会让人以为面板在"自己变"
  const timer = setTimeout(() => controller.abort(), 12_000);
  let model: Idea[] = [];
  try {
    model = await generateModelIdeas(enriched, config, controller.signal, now);
  } finally {
    clearTimeout(timer);
  }
  // 模型点子也要避开冷却表（模型可能换个说法再提一遍同一件事）
  const filteredModel = model.filter((idea) => !seenIds.has(idea.id));
  return [...rules, ...filteredModel];
}

export function installIdeas(): void {
  registerIdeaGenerator(generate);
}
