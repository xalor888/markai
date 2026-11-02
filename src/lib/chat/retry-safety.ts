import { MUTATING_TOOLS } from '@/lib/ai/tools';
import type { ChatBlock } from '@/lib/ai/types';

/**
 * 「重新生成」到底安不安全。
 *
 * ── 为什么需要这个判断 ──
 *
 * `retryLast()` 的做法是：**删掉最后一条用户消息之后的所有消息，再把同一句话重发一遍**。
 * 它假设那一轮"什么都没发生"。但只要 Agent 已经调用过写类工具，这个假设就是错的：
 *
 *   用户：帮我把这几个书签归到「开发」
 *   Agent：（调用了 move_bookmarks ×5）
 *   Agent：（最后一轮没有返回任何文字）
 *
 * 界面上这时显示「Agent 未返回内容，可点击 ↻ 重新生成」——
 * 而 5 个书签**已经被移走了**。点下去会重发同一句指令，模型大概率再调一次同样的工具：
 * 移动类操作幂等（看不出问题），但 `create_bookmark` / `copy_bookmark` 会**造出重复书签**。
 *
 * 更糟的是：那条带工具记录的消息会被删掉，用户彻底看不到"其实已经执行过了"。
 *
 * 所以写类操作成功过之后，不再提供"重新生成"，改为如实说明。
 */

export interface RetrySafety {
  /** 这一轮成功执行过的**写类**操作数量 */
  mutations: number;
  /** 是否可以安全地"重新生成"（重发同一句指令） */
  safeToRegenerate: boolean;
}

export function retrySafety(blocks: ChatBlock[]): RetrySafety {
  let mutations = 0;
  for (const b of blocks) {
    if (b.kind !== 'tool') continue;
    if (b.record.status !== 'done') continue;
    if (MUTATING_TOOLS.has(b.record.name)) mutations++;
  }
  return { mutations, safeToRegenerate: mutations === 0 };
}

/**
 * 已经改过东西、但模型没给文字时，该说什么。
 *
 * 不再提"重新生成"——它会导致重复执行。给一句可执行的下一步即可。
 */
export function mutatedEmptyReplyNote(mutations: number): string {
  return `（Agent 没有写回复，但这一轮已经执行了 ${mutations} 个改动。需要继续请直接说下一句；要退回可点「撤销」。）`;
}
