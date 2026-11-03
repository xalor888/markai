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
    if (!MUTATING_TOOLS.has(b.record.name)) continue;
    /*
     * `canceled` 必须和 `done` 一样算作"改过了"。
     *
     * 取消发生在工具执行**中途**时，前面的部分已经改到了书签上（批量移动 100 条
     * 移到第 40 条时点取消，那 40 条是真的移走了，撤销点里也有）。
     * 只认 `done` 的话 mutation 数会是 0 → 界面认为"这轮什么都没做、可以安全重来"，
     * 用户重发同一句就会**再移一遍**。
     *
     * 取舍：宁可多提示一次"已经改过、要退回请点撤销"，也不能让用户重复执行。
     * 这一点点误报（取消时其实一条都没动）远小于重复执行造成的数据错乱。
     */
    if (b.record.status !== 'done' && b.record.status !== 'canceled') continue;
    mutations++;
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

/**
 * 用户点了「停止」之后，消息末尾该追加什么。
 *
 * 只说「已停止生成」是不够的：用户不知道这一轮到底动了书签没有。
 *   - 纯读工具被取消 → 什么都没改，继续或重来都行（别让他去点撤销白折腾）
 *   - 写类工具被取消 → **已经有部分落地**（撤销点里也有），必须告诉他可以退回哪
 *
 * 这里复用 `retrySafety` 的 mutations 计数，而不是去解析每个工具结果里的
 * `moved`/`created` 字段——那些字段名各工具不同、还可能缺省，解析出来容易说错数字。
 * 报「执行了 N 个改动操作」是能确证的。
 */
export function cancelNote(blocks: ChatBlock[]): string {
  const { mutations } = retrySafety(blocks);
  if (mutations === 0) return '\n（已停止生成）';
  return `\n（已停止生成；这一轮已执行 ${mutations} 个改动，要退回请点「撤销」。）`;
}
