/**
 * 对话历史的容量护栏（纯逻辑，不碰 chrome.*）。
 *
 * 为什么需要：单个会话的消息条数有上限（MAX_MESSAGES），但**会话数量没有上限**，
 * 于是聊天记录可以无限增长，直到撞上 `chrome.storage.local` 的 10 MiB 配额——
 * 那时写盘失败，而界面照常显示历史，用户会以为一切正常。这里把"降级"变成
 * 确定性的、可解释的裁剪，并由调用方把丢弃的事实如实告诉用户。
 */
import type { ChatMessage } from './types';

export interface ConversationLike {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export interface TrimResult<T extends ConversationLike> {
  kept: T[];
  /** 被丢弃的消息条数 */
  droppedMessages: number;
  /** 被整个丢弃的会话数 */
  droppedConversations: number;
}

/** 一段数据的近似字节数（chrome.storage 的配额按 JSON 序列化长度计量） */
export function approximateBytes(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

/** 单条消息的体量（用于决定从哪个会话开始丢） */
function messagesBytes(msgs: ChatMessage[]): number {
  return approximateBytes(msgs);
}

/**
 * 把会话列表裁剪到预算内。规则**确定且可解释**：
 *
 *  1. 预算内：原样返回（不做任何"顺手优化"）；
 *  2. 超预算：从**最旧的会话**开始，逐条丢弃它最旧的消息；该会话消息被丢空后再整个丢弃它；
 *  3. 始终保留最新的会话与它们最新的消息——用户最可能在意的是刚发生的对话。
 *
 * 注意：不按 `updatedAt` 重排，保留调用方传入的顺序语义（调用方按 updatedAt 排序后传入）。
 */
export function trimConversationsToBudget<T extends ConversationLike>(
  conversations: T[],
  budgetBytes: number,
): TrimResult<T> {
  const safeBudget = Number.isFinite(budgetBytes) ? Math.max(0, budgetBytes) : 0;
  if (approximateBytes(conversations) <= safeBudget) {
    return { kept: conversations, droppedMessages: 0, droppedConversations: 0 };
  }

  // 从最旧到最新处理（新会话在数组尾部时也正确：这里显式按 updatedAt 升序决定丢弃顺序）
  const byAge = [...conversations].sort((a, b) => (a.updatedAt ?? a.createdAt) - (b.updatedAt ?? b.createdAt));
  const dropMessages = new Map<string, number>();
  const dropWhole = new Set<string>();

  const currentBytes = () => {
    const projected = conversations
      .filter((c) => !dropWhole.has(c.id))
      .map((c) => ({ ...c, messages: c.messages.slice(dropMessages.get(c.id) ?? 0) }));
    return approximateBytes(projected);
  };

  const MAX_DROP_STEPS = 100_000; // 防御：异常输入不至于死循环
  let steps = 0;
  while (currentBytes() > safeBudget && steps++ < MAX_DROP_STEPS) {
    const oldest = byAge.find((c) => !dropWhole.has(c.id) && c.messages.length - (dropMessages.get(c.id) ?? 0) > 0);
    if (!oldest) {
      // 所有会话的消息都丢空了还不达标 → 整个丢弃最旧的会话
      const oldestConv = byAge.find((c) => !dropWhole.has(c.id));
      if (!oldestConv) break;
      dropWhole.add(oldestConv.id);
      continue;
    }
    dropMessages.set(oldest.id, (dropMessages.get(oldest.id) ?? 0) + 1);
  }

  let droppedMessages = 0;
  const kept: T[] = [];
  for (const c of conversations) {
    if (dropWhole.has(c.id)) {
      droppedMessages += c.messages.length;
      continue;
    }
    const cut = dropMessages.get(c.id) ?? 0;
    droppedMessages += cut;
    kept.push(cut > 0 ? { ...c, messages: c.messages.slice(cut) } : c);
  }
  return { kept, droppedMessages, droppedConversations: dropWhole.size };
}

/** 人话说明被丢弃了什么（没有丢弃时返回 undefined） */
export function describeChatTrim(result: TrimResult<ConversationLike>): string | undefined {
  const parts: string[] = [];
  if (result.droppedMessages > 0) parts.push(`更早的 ${result.droppedMessages} 条消息`);
  if (result.droppedConversations > 0) parts.push(`${result.droppedConversations} 个更早的会话`);
  return parts.length > 0 ? parts.join('、') : undefined;
}
