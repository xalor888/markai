/** ── Agent 聊天 store（多会话、流式状态、待删清单，持久化到 chrome.storage.local） ── */

import { create } from 'zustand';
import { retrySafety, cancelNote } from '@/lib/chat/retry-safety';
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
import type { UndoPoint } from '@/lib/undo/types';
import { undoReadiness } from '@/lib/undo/journal';
import { UNDO_STORAGE_KEY } from '@/lib/undo/recorder';
import { describeChatTrim, trimConversationsToBudget } from '@/lib/ai/chat-budget';
import { mergeDraft, readDraft } from '@/lib/ai/stream-draft';
import { useBookmarkStore } from './bookmarkStore';

/** storage key（popup 通过该 key 只读展示待删数） */
export const AI_STORAGE_KEY = 'markai.ai';

/**
 * 对话历史的字节预算（chrome.storage.local 总配额 10 MiB）。
 * 留出 4 MiB 给撤销记录（它同样有护栏），避免两类数据互相踩踏。
 */
export const CHAT_BUDGET_BYTES = 6 * 1024 * 1024;

/** 当前生效的预算（测试可调，用来确定性地验证"真实占用超标"这条路径） */
let chatBudgetBytes = CHAT_BUDGET_BYTES;

/** 仅测试用：替换对话预算 */
export function setChatBudgetBytes(bytes: number): void {
  chatBudgetBytes = bytes;
}

/** 消息条数上限（持久化时裁剪） */
const MAX_MESSAGES = 60;
/**
 * 待删提议的保留上限。
 *
 * 一键清理一次可提交上千条，所以不能用很小的数；但也不能无上限（每条都带标题/理由）。
 * 超出时**丢最旧的并明确告知**（见 deletionsCapWarned），不静默截断。
 */
const PENDING_DELETIONS_LIMIT = 2000;
/** 上限提示只在「真的丢了待处理提议」时弹一次：连发多批不该刷屏，但下次真丢要能再提示 */
let deletionsCapWarned = false;
/** 仅测试用：把上面的提示标记复位（否则跨用例残留，用例会互相串味） */
export function resetDeletionsCapWarnedForTest(): void {
  deletionsCapWarned = false;
}
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
  /** 最新在前的撤销点（操作日志：一轮 Agent = 一个撤销点） */
  undoPoints: UndoPoint[];
  /** 撤销记录的如实提示（裁剪/写入失败）；noticeAt 变化时 UI 提示一次 */
  undoNotice: string | null;
  /** 最近一次对话落盘失败的如实说明（null = 没有失败）；at 稳定，界面只提示一次 */
  persistError: { message: string; at: number } | null;
  /** 撤销记录读取失败（状态未知）：界面不得把它显示成「没有可撤销的操作」 */
  undoUnknown: boolean;
  /** 因为超预算而丢弃了更早的对话时的如实说明 */
  persistNotice: string | null;
  undoNoticeAt: number | null;
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
  /** 操作日志：拉取最近的撤销点（每轮 Agent 结束后刷新） */
  refreshUndo: () => Promise<void>;
  /** 计划模式：当前等待用户确认的写操作计划（null = 没有待确认计划） */
  pendingPlan: { messageId: string; steps: { name: string; label: string; count: number; countDeclared: boolean; summary: string; preview: boolean }[] } | null;
  /** 确认执行本轮计划中的写操作 */
  approvePlan: () => void;
  /** 取消本轮计划（零写入） */
  cancelPlan: () => void;
  /** 内部：发送计划决定 */
  _decidePlan: (approved: boolean) => void;
  /** 操作日志：撤销最近（或指定）的写操作轮次，并把书签树刷新回 UI */
  /** 撤销一步；返回是否真的撤销成功（批量回退据此决定要不要继续） */
  undoLast: (id?: string, opts?: { silent?: boolean }) => Promise<boolean>;
  /** 持久化；force=true 时跳过远端合并（清空等用户明确意图的操作） */
  _persist: (force?: boolean) => Promise<void>;
}

/**
 * 流式 delta 批处理：把逐 token 的 store 更新合并为 16ms 批量，
 * 显著降低高频渲染；工具事件/结束事件到达时立即 flush 保证时序。
 */
let pendingText: { messageId: string; text: string } | null = null;
/** 思考增量（与正文分开合并：两块不能互相打断顺序） */
let pendingReasoning: { messageId: string; text: string } | null = null;
let reasoningTimer: ReturnType<typeof setTimeout> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 流式过程中的节流落盘。
 *
 * 缺陷（用户实测）：生成到一半关掉侧边栏/切走页面，回来只看到
 * 「模型未返回任何内容」——因为增量只更新了内存里的 store，
 * `_persist()` 只在「发送时」和「结束时」各调一次。中途退出等于整段回复消失。
 *
 * 现在每 800ms 把当前内容落一次盘：退出时最多丢最近 800ms 的字，
 * 而不是整段。`pagehide` 里再强制落一次，把窗口压到最小。
 */
let persistTimer: ReturnType<typeof setTimeout> | null = null;
const STREAM_PERSIST_MS = 800;
function scheduleStreamPersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void useAIStore.getState()._persist();
  }, STREAM_PERSIST_MS);
}

/** 立即落盘（页面要卸载时用）：清掉待触发的定时器，直接写一次 */
export function flushStreamPersist(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  void useAIStore.getState()._persist(true);
}

/** 跨窗口同步标记：本窗口写入 storage 时置位，onChanged 据此跳过自身 */
const crossWindowWrite = { current: false };
let crossSyncTimer: ReturnType<typeof setTimeout> | null = null;
/** 保活心跳计时器（每 20s 向 background 发 ping，防止长任务期间 SW 被回收） */
const keepaliveTimer: { current: ReturnType<typeof setInterval> | null } = { current: null };
/**
 * 哪些会话已经提示过「超长截断」。
 *
 * 原来是个全局 boolean，只有 `clearMessages()` 会复位——`createConversation()`
 * 不复位，于是新建会话聊到上限时**一声不响**地丢掉早期消息，
 * 用户完全不知道之前的对话已经没了。
 * 按会话 id 记，每个会话各提示一次，语义才对。
 */
const truncateWarned = new Set<string>();

/**
 * 跨窗口同步：sidepanel 与完整页同时打开时，聊天与待删清单实时一致。
 * 监听 chrome.storage 变化（防抖合并），流式中或本窗口写入时跳过。
 *
 * 也监听**操作日志**（`markai.undo`）：撤销点是 background 侧写的，
 * 任一窗口撤销或任一轮结束后，其他窗口必须立刻收起过期按钮——
 * 否则会留下一个「点了会撤错对象」的陈旧入口。
 */
export function initCrossWindowSync(): () => void {

  const onChanged = (
    changes: { [key: string]: chrome.storage.StorageChange },
    area: chrome.storage.AreaName,
  ) => {
    if (area !== 'local') return;
    if (changes[UNDO_STORAGE_KEY]) {
      // 撤销点的写入者总是 background，不存在"本窗口自己写"的情况，无需跳过
      void useAIStore.getState().refreshUndo();
      return;
    }
    if (!changes[AI_STORAGE_KEY] || crossWindowWrite.current) return;
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

/**
 * 追加思考到指定消息的最后一个 reasoning 块。
 *
 * 与 appendDelta 一样「同类型连续追加、换类型新建块」——这样文本与思考交错时
 * 顺序天然正确（模型先想后答 → [reasoning][text]），而不是拼成一坨。
 */
export function appendReasoningDelta(messages: ChatMessage[], messageId: string, text: string): ChatMessage[] {
  return messages.map((m) => {
    if (m.id !== messageId) return m;
    const blocks = [...m.blocks];
    const last = blocks[blocks.length - 1];
    if (last && last.kind === 'reasoning') {
      return { ...m, blocks: [...blocks.slice(0, -1), { kind: 'reasoning', text: last.text + text }] };
    }
    return { ...m, blocks: [...blocks, { kind: 'reasoning', text }] };
  });
}

/** 立即落盘未合并的增量（非 delta 事件前调用，保证消息顺序） */
function flushDeltaNow(set: (fn: (s: AIState) => Partial<AIState>) => void): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (reasoningTimer) {
    clearTimeout(reasoningTimer);
    reasoningTimer = null;
  }
  const r = pendingReasoning;
  pendingReasoning = null;
  if (r) updateActiveMessages(set, (msgs) => appendReasoningDelta(msgs, r.messageId, r.text));
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
  undoPoints: [],
  undoNotice: null,
  persistError: null,
  undoUnknown: false,
      pendingPlan: null,
  persistNotice: null,
  undoNoticeAt: null,
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
      /*
       * 恢复时清理「僵尸生成中」。
       *
       * 落盘里还挂着 streaming 的消息，说明上次是被强杀的（关侧边栏 / 进程回收），
       * 不会再有 chat:done 到达。把它标成 interrupted 而不是保持 streaming：
       *  - 保持 streaming 会让界面永远转圈、输入框一直锁着；
       *  - 直接当"空回复"又会让人以为模型没说话（正是用户报的那个问题）。
       * 真实含义是"生成被打断了"，已收到的部分原样保留。
       */
      /*
       * 先用后台写下的草稿补全，再判定「被打断」——顺序不能反。
       *
       * 切标签页时 port 会断，UI 收到的最后一段可能没赶上落盘；后台侧的草稿
       * 是权威的"到此为止收到多少"。只往更完整的方向合（mergeDraft 里保证），
       * 绝不会因为一次晚到的读把用户眼前的字变少。
       */
      const draft = await readDraft();
      const withDraft = (msgs: ChatMessage[]): ChatMessage[] =>
        msgs.map((m) => {
          if (!draft || m.id !== draft.messageId || m.role !== 'assistant') return m;
          // 只处理"纯文本"回复：含工具卡片的消息结构复杂，不在这里重排
          if (!m.blocks.every((b) => b.kind === 'text')) return m;
          const existing = m.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join('');
          const merged = mergeDraft(existing, draft, m.id);
          if (merged === existing) return m;
          return { ...m, blocks: [{ kind: 'text' as const, text: merged }] };
        });

      const revive = (msgs: ChatMessage[]): ChatMessage[] =>
        withDraft(msgs).map((m) => (m.streaming ? { ...m, streaming: false, interrupted: true } : m));
      const revivedConversations = conversations.map((c) => ({ ...c, messages: revive(c.messages ?? []) }));
      const active = revivedConversations.find((c) => c.id === activeId) ?? revivedConversations[0]!;
      set({
        conversations: revivedConversations,
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
    // 新开的窗口也要看到已有撤销点（撤销点存在 background 侧，不在会话存储里）
    void get().refreshUndo();
  },

  async send(text, opts) {
    if (get().streaming) {
      pushToast('Agent 正在处理中，请稍候', {
        description: '等它完成或者点击「停止」按钮来取消当前任务',
      });
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
    // streaming 标记会随落盘一起写下去：进程被杀后重开时，
    // 它让我们能区分「还在生成」和「模型真的什么都没返回」
    const assistantMsg: ChatMessage = {
      id: uid(),
      role: 'assistant',
      blocks: [],
      createdAt: Date.now(),
      streaming: true,
    };
    // 重试（replaceLastUser）时历史需排除被重试的那条 user 消息——它作为 text 单独发送，
    // 否则模型会收到连续两条相同的 user 消息（retryLast 已把它 slice 成 messages 的最后一条）。
    const source = get().messages;
    const history = (opts?.replaceLastUser ? source.slice(0, -1) : source).slice(-HISTORY_LIMIT);

    // 超长会话截断提示：每个会话各提示一次（换会话后要能再提醒）
    const before = get().messages.length;
    const convId = get().activeId;
    if (before > MAX_MESSAGES - 2 && convId && !truncateWarned.has(convId)) {
      truncateWarned.add(convId);
      pushToast(`对话较长，仅保留最近 ${MAX_MESSAGES} 条消息`, { variant: 'default' });
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

  approvePlan() {
    get()._decidePlan(true);
  },

  cancelPlan() {
    get()._decidePlan(false);
  },

  /**
   * 发送计划决定。必须带上 pendingPlan 自己的 messageId——后台按它结算对应的那一轮，
   * 迟到的决定不会批准别的轮次。发完立刻清空本地 pendingPlan（界面不再显示"待确认"）。
   */
  _decidePlan(approved: boolean) {
    const plan = get().pendingPlan;
    if (!plan) return;
    set({ pendingPlan: null });
    try {
      get().port?.postMessage({
        type: 'chat:plan_decision',
        messageId: plan.messageId,
        approved,
      } satisfies ChatInbound);
    } catch {
      // 端口已失效：后台那一轮会因断开按"未批准"结算，本地无需再做别的
    }
  },

  retryLast() {
    const s = get();
    if (s.streaming) return;
    /*
     * 保险（UI 那层已经不提供入口，这里防绕过）：
     * 上一轮如果已经成功执行过写类工具，"重新生成"会删掉那条带工具记录的消息、
     * 并把同一句指令重发一遍 —— 工具会**再跑一次**。
     * 移动类幂等看不出来，但 create_bookmark / copy_bookmark 会造出重复书签。
     */
    const lastAssistant = [...s.messages].reverse().find((m) => m.role === 'assistant');
    if (lastAssistant && !retrySafety(lastAssistant.blocks).safeToRegenerate) return;
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
    // 清空当前会话后重置它的提示标记：下次再聊满还能提醒一次
    const cid = get().activeId;
    if (cid) truncateWarned.delete(cid);
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
      pushToast('Agent 正在处理中，请稍候', {
        description: '等它完成或者点击「停止」按钮来取消当前任务',
      });
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
            // 落盘：退出/切走时已生成的内容不能蒸发
            scheduleStreamPersist();
          }, 16);
        }
        break;

      case 'chat:restart': {
        // 后台要重发这一轮：上一次尝试已经吐出的文本作废。
        // 不清理的话，重试成功的回复会接在残文后面——用户看到的是两段拼起来的怪回复，
        // 而这正是"断流"最容易被误读成"模型发疯"的地方。
        if (evt.messageId !== get().streamingMessageId) break;
        // 丢弃还在 16ms 批次里没落盘的那截
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        pendingText = null;
        if (reasoningTimer) {
          clearTimeout(reasoningTimer);
          reasoningTimer = null;
        }
        pendingReasoning = null;
        set((s) => ({
          messages: s.messages.map((m) => (m.id === evt.messageId ? { ...m, blocks: [] } : m)),
        }));
        break;
      }

      case 'chat:plan': {
        // 计划模式：一轮的写操作清单到了，等用户点确认；期间后台在 await 这个决定
        set({
          pendingPlan: { messageId: evt.messageId, steps: evt.steps },
        });
        break;
      }

      case 'chat:reasoning': {
        // 思考增量：与正文同一条状态机守卫（旧流的残片不得写进当前会话）
        if (evt.messageId !== get().streamingMessageId) break;
        pendingReasoning ??= { messageId: evt.messageId, text: '' };
        pendingReasoning.text += evt.text;
        if (!reasoningTimer) {
          reasoningTimer = setTimeout(() => {
            reasoningTimer = null;
            const p = pendingReasoning;
            pendingReasoning = null;
            if (!p) return;
            updateActiveMessages(set, (msgs) => appendReasoningDelta(msgs, p.messageId, p.text));
            scheduleStreamPersist();
          }, 16);
        }
        break;
      }

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
        /*
         * 上限 2000：一键清理（cleanup_sweep）一次可提交上千条提议，200 条会截断。
         *
         * 但 `propose_deletions` 单次上限 1000、cleanup_sweep 还能分页多次调用——
         * **3 批就是 3000 条**，第 3 批到达时最早的 1000 条会被无声丢掉。
         * 用户看到列表里 2000 条以为就是全部，审批完就以为清理干净了；
         * 剩下那 1000 条**看起来像"没问题"**，实际是提议被丢了。
         * 所以丢了多少必须说出来。
         */
        set((s) => {
          const merged = dedupeProposals([...s.pendingDeletions, ...(evt.record.deletions ?? [])]);
          const kept = merged.slice(-PENDING_DELETIONS_LIMIT);
          /*
           * 只统计**待处理**提议的丢失。
           *
           * 数组里混着三种状态：pending（用户还没看到）、executed/declined（早已处理完）。
           * 超限时 slice(-N) 挤掉的是**最旧**的那批——大多数情况下是死记录，属于正常清理，
           * 不该弹警报：用户去找「未列出的 100 条」永远找不到，因为那些本来就已经处理过了。
           *
           * 但若挤掉的里面有 pending，那是用户**真的少看到了提议**，必须说。
           * 同时把提示复位：这样下一次真的丢 pending 时还会再提醒（此前是一次性 flag，
           * 被假警报消耗掉之后，真丢时反而不提示了）。
           */
          const keptIds = new Set(kept.map((p) => p.id));
          const droppedPending = merged.filter((p) => !keptIds.has(p.id) && p.status === 'pending').length;
          if (droppedPending > 0 && !deletionsCapWarned) {
            deletionsCapWarned = true;
            pushToast(`待删列表已达上限，${droppedPending} 条提议未列出`, {
              description: `单次最多保留 ${PENDING_DELETIONS_LIMIT} 条待确认项。处理完当前这批后，再让 Agent 整理一次即可看到剩下的。`,
              variant: 'destructive',
            });
          } else if (droppedPending === 0) {
            // 这次没有真的丢提议（只清掉了已处理记录）→ 复位，下次真丢时还能提示
            deletionsCapWarned = false;
          }
          return { pendingDeletions: kept };
        });
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
        // 生成结束：清掉 streaming 标记（否则下次打开会被误判成"被打断"）
        updateActiveMessages(set, (msgs) =>
          msgs.map((m) => (m.id === evt.messageId ? { ...m, streaming: false } : m)),
        );
        if (evt.type === 'chat:cancelled') {
          /*
           * 取消后的提示要**说清这一轮动没动书签**。
           *
           * 原来只说「已停止生成」：用户不知道是被取消的纯读任务（什么都没改，重来即可），
           * 还是批量移动跑到一半（已经移走了一部分，撤销点里也有）。
           * 后者不去撤销就会以为"停了就等于没动"。
           */
          updateActiveMessages(set, (msgs) =>
            msgs.map((m) =>
              m.id === evt.messageId && m.blocks.length > 0
                ? { ...m, blocks: [...m.blocks, { kind: 'text', text: cancelNote(m.blocks) }] }
                : m,
            ),
          );
        }
        // 一轮结束：清掉可能还挂着的计划卡片（后台已按"未批准"结算，卡片不该继续等）
        set({ streaming: false, streamingMessageId: null, pendingPlan: null });
        void get()._persist();
        // 一轮结束 = 一个撤销点已落盘，刷新「撤销本次操作」按钮的可用状态
        void get().refreshUndo();
        break;
      }

      case 'chat:error': {
        flushDeltaNow(set);
        updateActiveMessages(set, (msgs) =>
          msgs.map((m) => (m.id === evt.messageId ? { ...m, streaming: false } : m)),
        );
        // 同样校验 messageId：旧请求的错误不打断当前流
        if (evt.messageId !== get().streamingMessageId) break;
        updateActiveMessages(set, (msgs) =>
          msgs.map((m) =>
            m.id === evt.messageId
              ? {
                  ...m,
                  // failed 是**状态**，文本块只是**显示**：两者都要，别只留一个
                  failed: evt.message,
                  blocks: [...m.blocks, { kind: 'text', text: `⚠ ${evt.message}` }],
                }
              : m,
          ),
        );
        set({ streaming: false, streamingMessageId: null, pendingPlan: null });
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
    if (items.length === 0) {
      // 没有可执行的项（已被其他窗口处理 / 状态已变化）：必须给出可见反馈。
      // 原先这里静默 return，界面表现为「点了删除什么都没发生」。
      pushToast('没有可执行的删除项', {
        description: '这些提议已被处理或状态已变化，请刷新后查看最新清单。',
        variant: 'default',
      });
      return;
    }

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
        /*
         * 无有效响应（扩展重载/超时等）。
         *
         * 风险：标记为 confirmed 之后 background 可能已经删了。如果此时用户看到
         * "未返回结果 → 重试"，会再发一次删除请求，导致**重复删除**——虽然 executor
         * 对缺失书签的处理是安全的（count++），但提示本身就是假的：明明可能已经
         * 成功，却说"失败请重试"，误导用户以为东西还在或者操作有误。
         */
        // 保持 confirmed 状态（已标记），提示刷新即可；不触发额外的删除请求
        get().resolveDeletions(items.map((it) => [it.proposalId, 'confirmed']));
        pushToast('删除执行未返回结果，可能需要刷新以查看最新清单', { variant: 'default' });
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

  async refreshUndo() {
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'undo:list' })) as OneShotOutbound | undefined;
      if (res?.type !== 'undo:list:result') {
        // 拿不到结果 ≠ 没有撤销点。必须标出"状态未知"，否则界面会把不确定说成确定。
        set({ undoPoints: [], undoNotice: null, undoNoticeAt: null, undoUnknown: true });
        return;
      }
      const prevAt = get().undoNoticeAt;
      set({
        undoPoints: res.points,
        undoNotice: res.notice ?? null,
        undoNoticeAt: res.noticeAt ?? null,
        undoUnknown: false,
      });
      // noticeAt 变了才提示：同一条提示不重复打扰
      if (res.notice && res.noticeAt && res.noticeAt !== prevAt) {
        pushToast('撤销记录有变更', { description: res.notice, variant: 'destructive' });
      }
    } catch {
      // SW 已回收、消息通道失败等：状态未知。列表可以是空的，但必须带 unknown 标记，
      // 让面板说"读取失败"而不是"没有可撤销的操作"。
      set({ undoPoints: [], undoNotice: null, undoNoticeAt: null, undoUnknown: true });
    }
  },

  async undoLast(id?: string, opts: { silent?: boolean } = {}): Promise<boolean> {
    // 明确针对「界面上正在展示的那个撤销点」：不传 id 时取 store 里的第一个，
    // 并把它显式发给 background。绝不能只发「撤销最新的那个」——别的窗口中途完成
    // 一轮后，latest 已经变成另一个操作，用户点的和实际撤的就会不是一回事。
    const shown = id ?? get().undoPoints[0]?.id;
    if (!shown) {
      if (!opts.silent) pushToast('没有可撤销的操作');
      return false;
    }
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'undo:apply',
        id: shown,
      })) as OneShotOutbound | undefined;
      if (res?.type !== 'undo:apply:result') {
        if (!opts.silent) pushToast('撤销未返回结果，请重试', { variant: 'destructive' });
        return false;
      }
      const r = res.result;
      // 顺序很重要：**先判 !ok**。消费写失败返回的是
      // `{ok:false, restored:>0, failures:[]}`——它既不是"零还原的拒绝"，也没有 failures，
      // 若按 failures 分支判断就会掉进成功提示，把"记录没更新、别再点"说成"已撤销"。
      if (!r.ok) {
        if (r.failures.length > 0) {
          // 两个数的单位不同，必须写清楚：restored 是**书签条数**（与按钮角标同单位），
          // failures.length 是**操作条数**。混着说"已还原 4 项，1 项失败"会让人以为总数对不上。
          if (!opts.silent) pushToast(`已还原 ${r.restored} 项书签，${r.failures.length} 个操作失败`, {
            description: r.failures.map((f) => `${f.title}：${f.error}`).join('；'),
            variant: 'destructive',
          });
        } else if (r.restored === 0) {
          // 零还原的明确拒绝（含删除的轮次、已撤销过、非最新点、文件夹冲突等）
          if (!opts.silent) pushToast('无法撤销', { description: r.reason ?? '没有可撤销的操作', variant: 'destructive' });
        } else {
          // 已还原一部分、但记录没能更新（消费写失败）：必须说清现状并警告不要重复点击
          if (!opts.silent) {
            pushToast('撤销未完成', {
              description: `已还原 ${r.restored} 项书签，但${r.reason ?? '本地记录未更新'}`,
              variant: 'destructive',
            });
          }
        }
      } else if (r.failures.length > 0) {
        // ok 但仍有条目失败：如实上报明细
        if (!opts.silent) {
          pushToast(`已还原 ${r.restored} 项书签，${r.failures.length} 个操作失败`, {
            description: r.failures.map((f) => `${f.title}：${f.error}`).join('；'),
            variant: 'destructive',
          });
        }
      } else {
        if (!opts.silent) pushToast(`已撤销本次操作（还原 ${r.restored} 项）`, { variant: 'success' });
      }
      await get().refreshUndo();
      void useBookmarkStore.getState().loadTree();
      // 只有「确实还原了东西 + 记录消费成功」才算成功，批量循环据此继续
      return r.ok && r.restored > 0;
    } catch (e) {
      if (!opts.silent) {
        pushToast('撤销失败', {
          description: e instanceof Error ? e.message : String(e),
          variant: 'destructive',
        });
      }
      return false;
    }
  },

  async _persist(force = false) {
    const s = get();
    let conversations = s.conversations;
    let mergedDeletions = s.pendingDeletions;
    let savedDeletedIds: string[] = [];
    let latestClearedIds: string[] = [];
    /**
     * 写盘前的读取是否全部成功。
     *
     * 只要有一次没读到，我们就**不知道磁盘上有什么**，此时拿内存里的会话去整对象覆盖，
     * 等于把没读到的部分直接删掉——实测：读失败时磁盘从 `[旧会话]` 变成 `[新会话]`，
     * 整份聊天历史消失。所以读失败就不写，宁可这次不保存。
     */
    let readsOk = true;
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
        for (const m of [...lc.messages, ...rc.messages]) {
          // 同 id 消息取内容量更大（更新）的一方：流式期间 storage 里可能还是发送时刻的空消息，
          // 若按「远端覆盖本地」会把本窗口已完成的回复回退成空内容
          const prev = byId.get(m.id);
          if (!prev || messageWeight(m) >= messageWeight(prev)) byId.set(m.id, m);
        }
        const mergedMsgs = [...byId.values()]
          .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
          .slice(-MAX_MESSAGES);
        // 按「id + 内容量」比较：id 相同但内容不同（远端更新）也要写回；
        // 不含删除提议状态，因此提议状态变化仍走本地（不被远端旧快照回退）
        const sig = (msgs: ChatMessage[]) => msgs.map((m) => `${m.id}:${messageWeight(m)}`).join('|');
        const sameSet =
          mergedMsgs.length === lc.messages.length &&
          sig(mergedMsgs) === sig(lc.messages);
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
      // 读不到就不能盲写：见 readsOk 的说明
      readsOk = false;
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
        // 重读失败同样不能盲写
        readsOk = false;
      }
      // 写盘 activeId 校验：墓碑过滤后指向不存在的会话时回退（load 虽能自愈，存储不留不一致）
      const writeActiveId = conversations.some((c) => c.id === s.activeId)
        ? s.activeId
        : (conversations[0]?.id ?? null);
      if (!readsOk) {
        /*
         * 读失败 → 不写。
         * 这条路径存的是**整份会话列表**，整对象覆盖，写下去就是不可逆的删除。
         * 用户的聊天历史比"这次没保存成功"重要得多。
         */
        set({
          persistError: {
            message: '读取本地存储失败，本次**没有保存**对话（避免用不完整的数据覆盖历史）。下次保存成功后会补上。',
            at: Date.now(),
          },
        });
        return;
      }
      try {
        await chrome.storage.local.set({
          [AI_STORAGE_KEY]: {
            conversations: (() => {
              const capped = conversations.map((c) => ({ ...c, messages: (c.messages ?? []).slice(-MAX_MESSAGES) }));
              // 容量护栏：会话数量没有上限，超预算时丢最旧的（先把消息丢空，再丢整个会话），
              // 并把丢弃的事实如实记下来——不静默降级。
              const trim = trimConversationsToBudget(capped, chatBudgetBytes);
              if (trim.droppedMessages > 0 || trim.droppedConversations > 0) {
                const what = describeChatTrim(trim) ?? '';
                set({ persistNotice: `对话记录已超出本地存储预算，为了保存最近的对话，已丢弃${what}。` });
              }
              return trim.kept;
            })(),
            activeId: writeActiveId,
            pendingDeletions: mergedDeletions,
            // 墓碑合并必须包含写前重读的值：否则并发窗口刚写入的墓碑会被本窗口整体覆盖丢失
            deletedIds: [...new Set([...s.deletedIds, ...(savedDeletedIds ?? []), ...latestDeleted])],
            clearedIds: [...new Set([...s.clearedIds, ...(latestClearedIds ?? []), ...latestCleared])],
          },
        });
        // 写入成功：清掉上一次的失败状态（提示是一次性的，不该长期挂着）
        if (get().persistError) set({ persistError: null });
        // 成功也要用**真实占用**核对一次估算：我们的预算是按 JSON 长度估的，
        // 若浏览器报告的占用仍然超过预算（估算偏低、或墓碑等零碎字段撑大了体积），
        // 就如实告知——"写成功了"不等于"占用合理"。
        try {
          const actual = await chrome.storage.local.getBytesInUse(AI_STORAGE_KEY);
          if (actual > chatBudgetBytes) {
            set({
              persistNotice: `本地存储的真实占用（约 ${(actual / 1024 / 1024).toFixed(1)} MiB）超过了对话预算（约 ${(chatBudgetBytes / 1024 / 1024).toFixed(1)} MiB）：估算与浏览器计量存在差距。建议清空更早的对话。`,
            });
          }
        } catch {
          // 拿不到占用就不做这项核对（不影响这次写入本身）
        }
      } catch (e) {
        // 原先这里是空 catch，注释说"下次写入会重试"——但超配额时之后**每次**都会失败，
        // 而界面照常显示历史，等于把"没保存成功"呈现成"好好的"。现在如实上报，
        // 并附上 getBytesInUse 读到的真实占用，让提示有事实依据。
        const msg = e instanceof Error ? e.message : String(e);
        let used = '';
        try {
          const bytes = await chrome.storage.local.getBytesInUse(AI_STORAGE_KEY);
          used = `（当前该键占用约 ${(bytes / 1024 / 1024).toFixed(1)} MiB）`;
        } catch {
          // 拿不到占用不影响"失败"这件事本身
        }
        const message = `这段对话**没有保存成功**${used}：${msg}。建议清空更早的对话后重试。`;
        // 同一次故障只算一个"事件"：流式期间 persist 会被频繁调用，若每次都刷新时间戳、
        // 每次都弹提示，就会变成骚扰。消息内容一致时沿用原时间戳；成功落盘会清空它，
        // 因此"恢复后再次失败"仍会作为新事件提示。
        const prev = get().persistError;
        const at = prev && prev.message === message ? prev.at : Date.now();
        set({ persistError: { message, at } });
        if (!prev || prev.message !== message) {
          pushToast('对话未能保存', { variant: 'destructive', description: `本地存储写入失败：${msg}` });
        }
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

/**
 * 消息「内容量」估算：文本长度 + 工具结果/错误长度（+ 每个工具块计 1）。
 * 跨窗口合并同 id 消息时，内容量更大的一方视为更新（流式内容只增不减），
 * 避免「另一窗口在发送时刻落盘的空 assistant 消息」覆盖掉本窗口已完成的完整回复。
 * 注意：不把删除提议状态纳入权重——状态变化应保留本地（见 _persist 的 sameSet 判断）。
 */
function messageWeight(m: ChatMessage): number {
  let w = 0;
  for (const b of m.blocks) {
    if (b.kind === 'text') w += b.text.length;
    else if (b.kind === 'reasoning') w += b.text.length;
    else w += (b.record.result?.length ?? 0) + (b.record.error?.length ?? 0) + 1;
  }
  return w;
}

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
