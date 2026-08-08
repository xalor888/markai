/** ── Agent 聊天 store（多会话、流式状态、待删清单，持久化到 chrome.storage.local） ── */

import { create } from 'zustand';
import { uid } from '@/lib/format';
import { pushToast } from '@/lib/toast';
import { MUTATING_TOOLS } from '@/lib/ai/tools';
import type {
  ChatInbound,
  ChatMessage,
  ChatOutbound,
  DeletionProposal,
  DeletionStatus,
  OneShotOutbound,
  ToolCallRecord,
} from '@/lib/ai/types';
import { useBookmarkStore } from './bookmarkStore';

/** storage key（popup 通过该 key 只读展示待删数） */
export const AI_STORAGE_KEY = 'markai.ai';

/** 消息条数上限（持久化时裁剪） */
const MAX_MESSAGES = 60;
/** 发送给模型的历史条数 */
const HISTORY_LIMIT = 20;

/** 会话：独立的消息列表，可新建/切换/重命名/删除 */
export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

/** storage 持久化结构（v2：多会话；load 时自动迁移 v1 单会话数据） */
interface StoredAI {
  conversations?: Conversation[];
  activeId?: string;
  pendingDeletions?: DeletionProposal[];
  /** 已删除会话 id 墓碑：持久化传播删除意图，任何窗口合并时都排除（防止被"复活"） */
  deletedIds?: string[];
  /** 已清空会话 id 墓碑：该会话被用户清空过，其他窗口的旧消息快照不得合并回来 */
  clearedIds?: string[];
  // v1 遗留字段（迁移用）
  messages?: ChatMessage[];
}

interface AIState {
  /** 当前会话的消息（与 conversations 中 active 会话保持同步） */
  messages: ChatMessage[];
  conversations: Conversation[];
  activeId: string | null;
  /** 本窗口删除过的会话 id（墓碑，随持久化传播） */
  deletedIds: string[];
  /** 本窗口清空过的会话 id（墓碑：防其他窗口旧快照复活） */
  clearedIds: string[];
  pendingDeletions: DeletionProposal[];
  streaming: boolean;
  streamingMessageId: string | null;
  port: chrome.runtime.Port | null;

  load: () => Promise<void>;
  /** 确保聊天 Port 已连接（懒连接 + 断线自动重连） */
  ensurePort: () => chrome.runtime.Port;
  /** 发送一条用户消息给 Agent（自动连接 Port） */
  send: (text: string, opts?: { folderId?: string; replaceLastUser?: boolean }) => Promise<void>;
  /** 取消当前流式回复 */
  cancel: () => void;
  /** 重试最后一条用户消息（移除其后所有消息并重新发送） */
  retryLast: () => void;
  clearMessages: () => Promise<void>;
  handleOutbound: (evt: ChatOutbound) => void;
  /** 新建会话并切换过去 */
  createConversation: () => void;
  /** 切换到指定会话（流式中禁止） */
  switchConversation: (id: string) => void;
  /** 重命名会话 */
  renameConversation: (id: string, title: string) => void;
  /** 删除会话（当前会话被删时切到最近一个） */
  deleteConversation: (id: string) => void;
  /** 更新单条删除提议状态（确认/放弃/执行结果回写） */
  resolveDeletion: (proposalId: string, status: DeletionStatus) => void;
  /** 批量更新提议状态（一次 set + 一次落盘；确认/回写阶段使用，避免逐项重复读写 storage） */
  resolveDeletions: (entries: [string, DeletionStatus][]) => void;
  /** 确认并执行删除（UI 权限闸门，background 才真正 removeTree） */
  confirmDeletions: (proposalIds: string[]) => Promise<void>;
  /** 全部放弃待删清单 */
  declineAllDeletions: () => Promise<void>;
  /** 持久化；force=true 时跳过远端合并（清空等用户明确意图的操作） */
  _persist: (force?: boolean) => Promise<void>;
}

/**
 * 流式 delta 批处理：把逐 token 的 store 更新合并为 16ms 批量，
 * 显著降低高频渲染；工具事件/结束事件到达时立即 flush 保证时序。
 */
let pendingText: { messageId: string; text: string } | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** 跨窗口同步标记：本窗口写入 storage 时置位，onChanged 据此跳过自身 */
const crossWindowWrite = { current: false };
let crossSyncTimer: ReturnType<typeof setTimeout> | null = null;
/** 保活心跳计时器（每 20s 向 background 发 ping，防止长任务期间 SW 被回收） */
const keepaliveTimer: { current: ReturnType<typeof setInterval> | null } = { current: null };
/** 超长会话截断提示已提醒过（避免每次发送重复提示） */
let truncateWarned = false;

/**
 * 跨窗口同步：sidepanel 与完整页同时打开时，聊天与待删清单实时一致。
 * 监听 chrome.storage 变化（防抖合并），流式中或本窗口写入时跳过。
 */
export function initCrossWindowSync(): () => void {
  const onChanged = (
    changes: { [key: string]: chrome.storage.StorageChange },
    area: chrome.storage.AreaName,
  ) => {
    if (area !== 'local' || !changes[AI_STORAGE_KEY] || crossWindowWrite.current) return;
    if (crossSyncTimer) clearTimeout(crossSyncTimer);
    crossSyncTimer = setTimeout(() => {
      crossSyncTimer = null;
      void useAIStore.getState().load();
    }, 300);
  };
  chrome.storage.onChanged.addListener(onChanged);
  return () => {
    chrome.storage.onChanged.removeListener(onChanged);
    if (crossSyncTimer) {
      clearTimeout(crossSyncTimer);
      crossSyncTimer = null;
    }
  };
}

/** 追加文本到指定消息的最后一个 text 块 */
function appendDelta(messages: ChatMessage[], messageId: string, text: string): ChatMessage[] {
  return messages.map((m) => {
    if (m.id !== messageId) return m;
    const blocks = [...m.blocks];
    const last = blocks[blocks.length - 1];
    if (last && last.kind === 'text') {
      return { ...m, blocks: [...blocks.slice(0, -1), { kind: 'text', text: last.text + text }] };
    }
    return { ...m, blocks: [...blocks, { kind: 'text', text }] };
  });
}

/** 立即落盘未合并的增量（非 delta 事件前调用，保证消息顺序） */
function flushDeltaNow(set: (fn: (s: AIState) => Partial<AIState>) => void): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!pendingText) return;
  const p = pendingText;
  pendingText = null;
  updateActiveMessages(set, (msgs) => appendDelta(msgs, p.messageId, p.text));
}

/**
 * 更新当前会话的消息：同步修改 conversations 数组与 messages 镜像。
 * 所有消息写入的唯二入口（另一个是 replaceActiveConversation），保证两处一致。
 */
function updateActiveMessages(
  set: (fn: (s: AIState) => Partial<AIState>) => void,
  fn: (msgs: ChatMessage[]) => ChatMessage[],
): void {
  set((s) => {
    const active = s.conversations.find((c) => c.id === s.activeId);
    // 当前会话已不存在（被其他窗口删除）：拒绝写入，避免消息写进无处持久化的孤儿镜像
    if (!active) return {};
    const next: Conversation = { ...active, messages: fn(active.messages), updatedAt: Date.now() };
    return {
      conversations: s.conversations.map((c) => (c.id === next.id ? next : c)),
      messages: next.messages,
    };
  });
}

/** 会话消息自动标题：取第一条用户消息前 20 字 */
function autoTitle(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length > 20 ? `${t.slice(0, 20)}…` : t || '新会话';
}

/** 提取第一条用户消息文本（v1 迁移时的会话标题用） */
function extractFirstUserText(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user');
  return first?.blocks
    .filter((b): b is { kind: 'text'; text: string } => b.kind === 'text')
    .map((b) => b.text)
    .join('') ?? '';
}

export const useAIStore = create<AIState>((set, get) => ({
  messages: [],
  conversations: [],
  activeId: null,
  deletedIds: [],
  clearedIds: [],
  pendingDeletions: [],
  streaming: false,
  streamingMessageId: null,
  port: null,

  async load() {
    // 流式中跳过：本地 delta 尚未落盘，加载会覆盖半段消息
    if (get().streaming) return;
    try {
      const data = await chrome.storage.local.get(AI_STORAGE_KEY);
      const saved = (data[AI_STORAGE_KEY] ?? {}) as StoredAI;
      // 墓碑：storage 中被标记删除的会话不再载入
      const tomb = new Set(saved.deletedIds ?? []);
      let conversations = (saved.conversations ?? []).filter((c) => !tomb.has(c.id));
      let activeId = saved.activeId && !tomb.has(saved.activeId) ? saved.activeId : null;
      // v1 迁移：旧结构只有 messages → 包装成单个会话
      if (conversations.length === 0 && Array.isArray(saved.messages) && saved.messages.length > 0) {
        conversations = [
          {
            id: uid(),
            title: autoTitle(extractFirstUserText(saved.messages)),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: saved.messages,
          },
        ];
        activeId = conversations[0]!.id;
        // 迁移后立即写回新结构
        void chrome.storage.local
          .set({
            [AI_STORAGE_KEY]: {
              conversations,
              activeId,
              pendingDeletions: saved.pendingDeletions ?? [],
              deletedIds: saved.deletedIds ?? [],
              clearedIds: saved.clearedIds ?? [],
            },
          })
          .catch(() => {});
      }
      // 无任何会话时兜底创建一个空会话（聊天面板始终可用）
      if (conversations.length === 0) {
        const conv: Conversation = { id: uid(), title: '新会话', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
        conversations = [conv];
        activeId = conv.id;
      }
      const active = conversations.find((c) => c.id === activeId) ?? conversations[0]!;
      set({
        conversations,
        activeId: active.id,
        messages: active.messages ?? [],
        // 墓碑并入内存：后续持久化保持一致（删除意图不丢失）
        deletedIds: [...new Set([...get().deletedIds, ...tomb])],
        clearedIds: [...new Set([...get().clearedIds, ...(saved.clearedIds ?? [])])],
        pendingDeletions: saved.pendingDeletions ?? [],
      });
    } catch {
      // 存储异常时回退空会话
      set({ messages: [], conversations: [], activeId: null, deletedIds: [], clearedIds: [], pendingDeletions: [] });
    }
  },

  async send(text, opts) {
    if (get().streaming) {
      pushToast('Agent 正在处理中，请稍候');
      return;
    }
    // 启动竞态保护：load 完成前 send 会把消息写进不存在的会话（静默丢失）
    if (get().conversations.length === 0 || !get().activeId) {
      await get().load();
      if (!get().activeId) return; // load 失败兜底仍无会话
    }
    const trimmed = text.trim();
    if (!trimmed) return;

    const userMsg: ChatMessage = {
      id: uid(),
      role: 'user',
      blocks: [{ kind: 'text', text: trimmed }],
      createdAt: Date.now(),
      // 记录上下文文件夹，消息内展示 Agent 视野
      ...(opts?.folderId ? { contextFolderId: opts.folderId } : {}),
    };
    const assistantMsg: ChatMessage = { id: uid(), role: 'assistant', blocks: [], createdAt: Date.now() };
    const history = get().messages.slice(-HISTORY_LIMIT);

    // 超长会话截断提示：仅在首次达到上限时提醒一次
    const before = get().messages.length;
    if (before > MAX_MESSAGES - 2 && !truncateWarned) {
      truncateWarned = true;
      pushToast('对话较长，仅保留最近 60 条消息', { variant: 'default' });
    }
    // 会话首条消息 → 自动标题（用户可随后重命名）
    const active = get().conversations.find((c) => c.id === get().activeId);
    const needsTitle = !!active && active.messages.length === 0;
    updateActiveMessages(set, (msgs) =>
      (opts?.replaceLastUser ? [...msgs, assistantMsg] : [...msgs, userMsg, assistantMsg]).slice(-MAX_MESSAGES),
    );
    if (needsTitle) get().renameConversation(get().activeId!, autoTitle(trimmed));
    set({ streaming: true, streamingMessageId: assistantMsg.id });
    void get()._persist();

    const inbound: ChatInbound = {
      type: 'chat:send',
      messageId: assistantMsg.id,
      text: trimmed,
      history,
      ...(opts?.folderId ? { contextFolderId: opts.folderId } : {}),
    };
    // 死端口保护：MV3 下 SW 可能已被回收（port 失效但 onDisconnect 未触发），
    // 捕获后重建连接重发一次，仍失败再复位状态并提示
    try {
      get().ensurePort().postMessage(inbound);
    } catch {
      set({ port: null });
      try {
        get().ensurePort().postMessage(inbound);
      } catch {
        set({ streaming: false, streamingMessageId: null, port: null });
        pushToast('与后台连接失败，请重试', { variant: 'destructive' });
      }
    }
  },

  cancel() {
    if (!get().streaming) return;
    try {
      get().port?.postMessage({ type: 'chat:cancel' } satisfies ChatInbound);
    } catch {
      // 端口已失效：本地直接复位流式状态（后台流随 SW 一起消失）
      set({ streaming: false, streamingMessageId: null, port: null });
    }
  },

  retryLast() {
    const s = get();
    if (s.streaming) return;
    const lastUser = [...s.messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;
    const lastUserIdx = s.messages.findIndex((m) => m.id === lastUser.id);
    const text = lastUser.blocks
      .filter((b): b is { kind: 'text'; text: string } => b.kind === 'text')
      .map((b) => b.text)
      .join('');
    if (!text.trim()) return;
    // 移除该 user 消息之后的所有消息（含失败的回复），replaceLastUser 复用原指令
    updateActiveMessages(set, (msgs) => msgs.slice(0, lastUserIdx + 1));
    void get()._persist();
    // 重试沿用原消息的上下文文件夹（而非当前选中的文件夹，保持 Agent 视野一致）
    const folderId = lastUser.contextFolderId ?? useBookmarkStore.getState().selectedFolderId ?? undefined;
    void get().send(text, { ...(folderId ? { folderId } : {}), replaceLastUser: true });
  },

  async clearMessages() {
    truncateWarned = false;
    // 双保险：流式中清空先停止后台流（UI 按钮已禁用，这里防直接调用）
    if (get().streaming) {
      get().cancel();
      // 立即复位流式状态：中止信号已发出，后台的收尾事件（cancelled/done）
      // 会被下方 streamingMessageId=null 的守卫丢弃——若不复位，streaming 会永久卡死
      set({ streaming: false });
    }
    flushDeltaNow(set); // 先落盘积压的流式增量，避免清空后定时器再写入
    const clearedId = get().activeId;
    // 清空当前会话的消息（会话本身保留）
    updateActiveMessages(set, () => []);
    set((s) => ({
      // 清空墓碑 + 屏蔽后续流式事件（delta/收尾按 messageId 守卫失效）
      clearedIds: [...s.clearedIds, ...(clearedId ? [clearedId] : [])],
      streamingMessageId: null,
    }));
    // force：清空是用户明确意图，绝不能把 storage 里的旧消息合并回来
    await get()._persist(true);
  },

  createConversation() {
    if (get().streaming) {
      pushToast('Agent 正在处理中，请稍候');
      return;
    }
    const conv: Conversation = { id: uid(), title: '新会话', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
    set((s) => ({ conversations: [...s.conversations, conv], activeId: conv.id, messages: [], streaming: false, streamingMessageId: null }));
    void get()._persist();
  },

  switchConversation(id) {
    if (get().streaming) return; // 流式中不切换，避免状态错乱
    const target = get().conversations.find((c) => c.id === id);
    if (!target) return;
    set({ activeId: id, messages: target.messages ?? [] });
    // 普通持久化（非 force）：合并远端对该会话的补充消息，不丢弃其他窗口的新内容
    void get()._persist();
  },

  renameConversation(id, title) {
    const t = title.trim().slice(0, 50);
    if (!t) return;
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === id ? { ...c, title: t, updatedAt: Date.now() } : c)),
    }));
    // 重命名必须持久化（否则重载/另一窗口恢复旧标题）
    void get()._persist();
  },

  deleteConversation(id) {
    if (get().streaming) return;
    const s = get();
    const rest = s.conversations.filter((c) => c.id !== id);
    // 墓碑：删除意图随持久化传播到所有窗口，任何合并都排除该 id（防止被复活）
    const tomb = [...new Set([...s.deletedIds, id])];
    if (rest.length === 0) {
      // 删掉最后一个会话 → 新建空会话兜底
      const conv: Conversation = { id: uid(), title: '新会话', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
      set({ conversations: [conv], activeId: conv.id, messages: [], deletedIds: tomb });
    } else if (s.activeId === id) {
      // 当前会话被删：切到最近更新的一个
      const next = [...rest].sort((a, b) => b.updatedAt - a.updatedAt)[0]!;
      set({ conversations: rest, activeId: next.id, messages: next.messages ?? [], deletedIds: tomb });
    } else {
      set({ conversations: rest, deletedIds: tomb });
    }
    pushToast('会话已删除', { variant: 'success' });
    // 普通持久化即可：墓碑在任何合并模式都生效，且不丢弃其他窗口对新 active 会话的补充
    void get()._persist();
  },

  handleOutbound(evt) {
    switch (evt.type) {
      case 'chat:start':
        break;

      case 'chat:delta':
        // 状态机守卫：旧流（已取消/已清空/已切换）的残片不得追加到当前会话
        if (evt.messageId !== get().streamingMessageId) break;
        // 合并连续增量，16ms 批量落一次 store（降低渲染频率）
        pendingText ??= { messageId: evt.messageId, text: '' };
        pendingText.text += evt.text;
        if (!flushTimer) {
          flushTimer = setTimeout(() => {
            flushTimer = null;
            const p = pendingText;
            pendingText = null;
            if (!p) return;
            updateActiveMessages(set, (msgs) => appendDelta(msgs, p.messageId, p.text));
          }, 16);
        }
        break;

      case 'chat:tool_start':
        if (evt.messageId !== get().streamingMessageId) break;
        flushDeltaNow(set);
        updateActiveMessages(set, (msgs) => upsertToolBlock(msgs, evt.messageId, evt.record));
        break;

      case 'chat:tool_progress': {
        // 长任务（大库检测/分类）进度：更新工具块的结果文本，保持 running 状态
        if (evt.messageId !== get().streamingMessageId) break;
        flushDeltaNow(set);
        updateActiveMessages(set, (msgs) =>
          msgs.map((m) => {
            if (m.id !== evt.messageId) return m;
            const idx = m.blocks.findIndex((b) => b.kind === 'tool' && b.record.id === evt.recordId);
            if (idx < 0) return m;
            const blocks = [...m.blocks];
            const prev = blocks[idx]!;
            if (prev.kind !== 'tool') return m;
            blocks[idx] = {
              kind: 'tool',
              record: { ...prev.record, status: 'running', result: evt.text },
            };
            return { ...m, blocks };
          }),
        );
        break;
      }

      case 'chat:tool_done': {
        // 旧流的工具结果不得并入（删除提议/树刷新同理跳过）
        if (evt.messageId !== get().streamingMessageId) break;
        flushDeltaNow(set);
        updateActiveMessages(set, (msgs) => upsertToolBlock(msgs, evt.messageId, evt.record));
        set((s) => ({
          // 上限 2000：一键清理（cleanup_sweep）一次可提交上千条提议，200 条会截断
          pendingDeletions: dedupeProposals([
            ...s.pendingDeletions,
            ...(evt.record.deletions ?? []),
          ]).slice(-2000),
        }));
        // 工具改了书签结构 → 刷新书签树
        if (MUTATING_TOOLS.has(evt.record.name)) void useBookmarkStore.getState().loadTree();
        break;
      }

      case 'chat:tool_error':
        if (evt.messageId !== get().streamingMessageId) break;
        flushDeltaNow(set);
        updateActiveMessages(set, (msgs) => upsertToolBlock(msgs, evt.messageId, evt.record));
        break;

      case 'chat:done':
      case 'chat:cancelled': {
        flushDeltaNow(set);
        // 状态机保护：旧请求的收尾事件不得复位当前请求的流式状态（快速连发时防错乱）
        if (evt.messageId !== get().streamingMessageId) break;
        if (evt.type === 'chat:cancelled') {
          // 明确提示已停止（若消息已有内容则追加小字标记）
          updateActiveMessages(set, (msgs) =>
            msgs.map((m) =>
              m.id === evt.messageId && m.blocks.length > 0
                ? { ...m, blocks: [...m.blocks, { kind: 'text', text: '\n（已停止生成）' }] }
                : m,
            ),
          );
        }
        set({ streaming: false, streamingMessageId: null });
        void get()._persist();
        break;
      }

      case 'chat:error': {
        flushDeltaNow(set);
        // 同样校验 messageId：旧请求的错误不打断当前流
        if (evt.messageId !== get().streamingMessageId) break;
        updateActiveMessages(set, (msgs) =>
          msgs.map((m) =>
            m.id === evt.messageId
              ? { ...m, blocks: [...m.blocks, { kind: 'text', text: `⚠ ${evt.message}` }] }
              : m,
          ),
        );
        set({ streaming: false, streamingMessageId: null });
        pushToast('Agent 请求失败', { description: evt.message, variant: 'destructive' });
        void get()._persist();
        break;
      }
    }
  },

  resolveDeletion(proposalId, status: DeletionStatus) {
    get().resolveDeletions([[proposalId, status]]);
  },

  resolveDeletions(entries: [string, DeletionStatus][]) {
    // 终态防护：已执行 / 已放弃 为单向终态，不可被任何后到结果回退
    // （防跨窗口过期响应把已删除项复活为待确认，或覆盖用户已放弃的选择）
    const curMap = new Map(get().pendingDeletions.map((p) => [p.id, p.status]));
    const allowed = entries.filter(
      ([id, _s]) => curMap.get(id) !== 'executed' && curMap.get(id) !== 'declined',
    );
    if (allowed.length === 0) return;
    const statusById = new Map(allowed);
    set((s) => ({
      pendingDeletions: s.pendingDeletions.map((p) =>
        statusById.has(p.id) ? { ...p, status: statusById.get(p.id)! } : p,
      ),
      // 状态转换必须同步到所有会话的消息块，而不只是 active 会话：
      // 卡片可能停留在非当前会话中，只更新 active 会造成界面状态不一致
      conversations: s.conversations.map((c) => ({
        ...c,
        messages: c.messages.map((m) => ({
          ...m,
          blocks: m.blocks.map((b) => {
            if (b.kind !== 'tool' || !b.record.deletions) return b;
            return {
              ...b,
              record: {
                ...b.record,
                deletions: b.record.deletions.map((p) =>
                  statusById.has(p.id) ? { ...p, status: statusById.get(p.id)! } : p,
                ),
              },
            };
          }),
        })),
      })),
    }));
    // 若更新涉及 active 会话，同步其内存镜像（与 load 保持一致）
    const active = get();
    if (active.activeId) {
      const conv = active.conversations.find((c) => c.id === active.activeId);
      if (conv && conv.messages !== active.messages) set({ messages: conv.messages });
    }
    // 批量合并为一次落盘：避免 N 个提议产生 2N 次并发读-改-写（storage 轮询竞态）
    void get()._persist();
  },

  async confirmDeletions(proposalIds) {
    const items = proposalIds
      .map((id) => get().pendingDeletions.find((p) => p.id === id))
      .filter((p): p is DeletionProposal => !!p && p.status === 'pending')
      .map((p) => ({
        proposalId: p.id,
        bookmarkId: p.bookmarkId,
        // "删除全部"提议携带 all 授权标志，background 据此校验（纵深防御）
        ...(p.all ? { all: true } : {}),
      }));
    if (items.length === 0) return;

    // 先标记为已确认（执行结果到达后再更新为 executed）；批量一次落盘
    get().resolveDeletions(items.map((it) => [it.proposalId, 'confirmed']));

    try {
      // 30s 超时护栏：background 执行删除通常 <1s；若 SW 卡死/无响应，
      // 不超时则按钮永远停在"执行中"。超时后回退 pending（可重试）
      const res = (await Promise.race([
        chrome.runtime.sendMessage({
          type: 'deletions:execute',
          items,
        }) as Promise<OneShotOutbound | undefined>,
        new Promise<OneShotOutbound | undefined>((resolve) =>
          setTimeout(() => resolve(undefined), 30_000),
        ),
      ])) as OneShotOutbound | undefined;
      if (res?.type === 'deletions:result') {
        const failedIds = new Set(res.failed.map((f) => f.proposalId));
        get().resolveDeletions(
          items.map((it) => [it.proposalId, failedIds.has(it.proposalId) ? 'pending' : 'executed']),
        );
        if (res.count > 0) pushToast(`已删除 ${res.count} 项书签`, { variant: 'success' });
        if (res.failed.length > 0) {
          pushToast('部分删除未执行', {
            description: res.failed.map((f) => f.error).join('；'),
            variant: 'destructive',
          });
        }
        void useBookmarkStore.getState().loadTree();
      } else {
        // 无有效响应（扩展重载/超时等）：回退为待确认，避免卡死在已确认状态
        get().resolveDeletions(items.map((it) => [it.proposalId, 'pending']));
        pushToast('删除执行未返回结果，请重试', { variant: 'destructive' });
      }
    } catch (e) {
      // 消息发送失败同样回退，保持可重试
      get().resolveDeletions(items.map((it) => [it.proposalId, 'pending']));
      pushToast('删除执行失败', {
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    }
  },

  async declineAllDeletions() {
    const pending = get().pendingDeletions.filter((p) => p.status === 'pending');
    get().resolveDeletions(pending.map((p) => [p.id, 'declined']));
  },

  async _persist(force = false) {
    const s = get();
    let conversations = s.conversations;
    let mergedDeletions = s.pendingDeletions;
    let savedDeletedIds: string[] = [];
    let latestClearedIds: string[] = [];
    try {
      const data = await chrome.storage.local.get(AI_STORAGE_KEY);
      const saved = (data[AI_STORAGE_KEY] ?? {}) as StoredAI;
      savedDeletedIds = saved.deletedIds ?? [];
      latestClearedIds = saved.clearedIds ?? [];
      // 墓碑合并：本窗口 + 远端的已删会话 id，合并会话时全部排除（删除不可被复活）
      const tomb = new Set([...s.deletedIds, ...(saved.deletedIds ?? [])]);
      // 清空墓碑：被用户清空过的会话，其他窗口的旧消息快照不得合并回来
      const cleared = new Set([...s.clearedIds, ...(saved.clearedIds ?? [])]);
      conversations = conversations.filter((c) => !tomb.has(c.id));
      const remote = (saved.conversations ?? []).filter((c) => !tomb.has(c.id));
      // 会话合并：远端有而本地没有的会话加入；双方都有 → 消息按 id 并集（按 createdAt 排序）
      const localById = new Map(conversations.map((c) => [c.id, c]));
      const merged: Conversation[] = [...conversations];
      for (const rc of remote) {
        const lc = localById.get(rc.id);
        if (!lc) {
          // 被清空过的会话：远端旧消息不得作为"新会话"复活
          if (!cleared.has(rc.id)) merged.push(rc);
          continue;
        }
        if (cleared.has(rc.id)) continue; // 清空墓碑生效：远端旧消息一律不合并
        if (force && lc.id === s.activeId) continue; // 清空中的会话：以本地（空）为准
        if (force && rc.messages.length === 0 && lc.messages.length > 0) continue;
        const byId = new Map<string, ChatMessage>();
        for (const m of [...lc.messages, ...rc.messages]) byId.set(m.id, m);
        const mergedMsgs = [...byId.values()]
          .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
          .slice(-MAX_MESSAGES);
        // 按 id 集合比较（长度相等但内容不同的情况也要写回）
        const sameSet =
          mergedMsgs.length === lc.messages.length &&
          mergedMsgs.every((m, i) => m.id === lc.messages[i]?.id);
        if (!sameSet) {
          merged.splice(
            merged.findIndex((c) => c.id === rc.id),
            1,
            { ...lc, messages: mergedMsgs, updatedAt: Math.max(lc.updatedAt, rc.updatedAt) },
          );
        }
      }
      conversations = merged;
      // 远端 pendingDeletions 优先：其他窗口的确认/执行结果比本窗口快照更新
      // （按 bookmarkId 合并；终态保护：本地 executed/declined 不被远端旧 pending 覆盖）
      const remotePending = saved.pendingDeletions;
      if (Array.isArray(remotePending) && remotePending.length > 0) {
        const mm = new Map<string, DeletionProposal>();
        for (const p of s.pendingDeletions) mm.set(p.bookmarkId, p);
        for (const rp of remotePending) {
          const local = mm.get(rp.bookmarkId);
          if (local && (local.status === 'executed' || local.status === 'declined')) continue;
          mm.set(rp.bookmarkId, rp);
        }
        mergedDeletions = [...mm.values()];
      }
      // 本地内存同步合并结果；active 会话被远端删除时重指到剩余会话（否则消息写入孤儿镜像丢失）
      let activeId = s.activeId;
      let activeMsgs = s.messages;
      if (!conversations.some((c) => c.id === activeId)) {
        if (conversations.length > 0) {
          activeId = conversations[0]!.id;
          activeMsgs = conversations[0]!.messages ?? [];
        } else {
          activeId = null;
          activeMsgs = [];
        }
      } else {
        activeMsgs = conversations.find((c) => c.id === activeId)?.messages ?? s.messages;
      }
      if (
        conversations !== s.conversations ||
        mergedDeletions !== s.pendingDeletions ||
        activeMsgs !== s.messages ||
        activeId !== s.activeId
      ) {
        set({ conversations, activeId, pendingDeletions: mergedDeletions, messages: activeMsgs });
      }
    } catch {
      // 读取失败时按本地数据落盘
    }
    // 标记本次写入来自本窗口：storage.onChanged 同步监听据此跳过，避免循环刷新
    crossWindowWrite.current = true;
    // 写前重读的墓碑（供写盘合并：防止并发写把其他窗口刚落盘的墓碑覆盖丢失）
    let latestDeleted: string[] = [];
    let latestCleared: string[] = [];
    try {
      // 写前重读一次并再次合并：两窗口并发写时把对方刚落盘的会话也并入，
      // 缩小"读-改-写"竞态窗口（storage 整对象覆盖导致的数据丢失）
      try {
        const latest = await chrome.storage.local.get(AI_STORAGE_KEY);
        const latestStored = (latest[AI_STORAGE_KEY] ?? {}) as StoredAI;
        latestDeleted = latestStored.deletedIds ?? [];
        latestCleared = latestStored.clearedIds ?? [];
        // 墓碑同样应用于重读合并（已删会话不因并发写回而复活）
        const tombAll = new Set([...s.deletedIds, ...latestDeleted]);
        const clearedAll = new Set([...s.clearedIds, ...latestCleared]);
        conversations = conversations.filter((c) => !tombAll.has(c.id));
        const remote = (latestStored.conversations ?? []).filter((c) => !tombAll.has(c.id) && !clearedAll.has(c.id));
        const have = new Set(conversations.map((c) => c.id));
        for (const rc of remote) {
          if (!have.has(rc.id)) conversations = [...conversations, rc];
        }
      } catch {
        // 重读失败不阻塞落盘
      }
      // 写盘 activeId 校验：墓碑过滤后指向不存在的会话时回退（load 虽能自愈，存储不留不一致）
      const writeActiveId = conversations.some((c) => c.id === s.activeId)
        ? s.activeId
        : (conversations[0]?.id ?? null);
      try {
        await chrome.storage.local.set({
          [AI_STORAGE_KEY]: {
            conversations: conversations.map((c) => ({ ...c, messages: (c.messages ?? []).slice(-MAX_MESSAGES) })),
            activeId: writeActiveId,
            pendingDeletions: mergedDeletions,
            // 墓碑合并必须包含写前重读的值：否则并发窗口刚写入的墓碑会被本窗口整体覆盖丢失
            deletedIds: [...new Set([...s.deletedIds, ...(savedDeletedIds ?? []), ...latestDeleted])],
            clearedIds: [...new Set([...s.clearedIds, ...(latestClearedIds ?? []), ...latestCleared])],
          },
        });
      } catch {
        // 落盘失败静默（配额/权限异常）：下次写入会重试，不产生未捕获 rejection
      }
    } finally {
      crossWindowWrite.current = false;
    }
  },

  ensurePort() {
    const existing = get().port;
    if (existing) return existing;

    const port = chrome.runtime.connect({ name: 'markai-chat' });
    port.onMessage.addListener((msg) => get().handleOutbound(msg as ChatOutbound));
    port.onDisconnect.addListener(() => {
      set({ port: null });
      // 保活心跳随连接一起停止
      if (keepaliveTimer.current) {
        clearInterval(keepaliveTimer.current);
        keepaliveTimer.current = null;
      }
      if (get().streaming) {
        // 先把积压的流式文本落盘，再结束流式状态，避免半段消息丢失
        flushDeltaNow(set);
        set({ streaming: false, streamingMessageId: null });
        // 落盘：断线时的积压增量只进了内存，不持久化会在重载/另一窗口丢失
        void get()._persist();
        pushToast('与后台的连接已断开', { description: '请重新发送消息。', variant: 'destructive' });
      }
    });
    set({ port });
    // 保活心跳：MV3 下 SW 约 30s 无事件即被回收，长任务（大库检测/分类、慢模型回复）
    // 期间 LLM 往返可能超过该窗口；每 20s 发一次 ping，消息到达即重置 SW 空闲计时。
    // 仅流式期间发送：空闲时让 SW 正常回收（也避免 Sidebar 常驻导致 SW 永不休眠）。
    keepaliveTimer.current = setInterval(() => {
      if (!get().streaming) return;
      try {
        get().port?.postMessage({ type: 'chat:ping' } satisfies ChatInbound);
      } catch {
        // 端口已失效：由 onDisconnect 统一处理
      }
    }, 20_000);
    return port;
  },
}));

/** 按记录 id 更新或插入工具块（保持时序） */
function upsertToolBlock(messages: ChatMessage[], messageId: string, record: ToolCallRecord): ChatMessage[] {
  return messages.map((m) => {
    if (m.id !== messageId) return m;
    const idx = m.blocks.findIndex((b) => b.kind === 'tool' && b.record.id === record.id);
    if (idx >= 0) {
      const blocks = [...m.blocks];
      blocks[idx] = { kind: 'tool', record };
      return { ...m, blocks };
    }
    return { ...m, blocks: [...m.blocks, { kind: 'tool', record }] };
  });
}

/**
 * 按 bookmarkId 去重（同一书签只保留一条提议：多次工具调用/分页提交不会产生重复卡片）。
 * 终态保护：executed/declined 是单向终态，后到的 pending/confirmed 提议不得覆盖
 * （否则已删除/已放弃的书签会被 AI 后续工具调用重新提交为待确认——"删了还在待删列表"）。
 */
function dedupeProposals(list: DeletionProposal[]): DeletionProposal[] {
  const map = new Map<string, DeletionProposal>();
  for (const p of list) {
    const prev = map.get(p.bookmarkId);
    if (prev && (prev.status === 'executed' || prev.status === 'declined')) continue;
    map.set(p.bookmarkId, p);
  }
  return [...map.values()];
}
