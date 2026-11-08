import { RefreshCw,
  ArrowDown,
  Bot,
  Brain,
  Download,
  FolderTree,
  AlertTriangle,
  History,
  MessagesSquare,
  Pencil,
  Plus,
  RotateCcw,
  ScanSearch,
  Search,
  Send,
  Wand2,
  Square,
  Trash2,
  TrendingUp,
  Undo2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useAIStore } from '@/stores/aiStore';
import { useBookmarkStore, findNode, resolveTitlePath } from '@/stores/bookmarkStore';
import { useConfigStore } from '@/stores/configStore';
import { useMemoryStore, initMemorySync } from '@/stores/memoryStore';
import { CATEGORY_LABELS } from '@/lib/ai/memory';
import { formatRelativeTime, formatIsoDate } from '@/lib/format';
import { describeUndoHistory, summarizeOps, undoReadiness } from '@/lib/undo/journal';
import { resolveConfig, PROVIDERS } from '@/lib/providers';
import { cn } from '@/lib/utils';
import { pushToast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { BrandMark } from '@/components/theme/theme-provider';
import { PetFace } from '@/components/pet/pet-face';
import { hasRunningTool, shouldCelebrate, stateFromAgent, type PetState } from '@/lib/pet/state';
import { MessageView } from './message-view';

/** 快捷指令 chip */
interface QuickChip {
  label: string;
  icon: typeof FolderTree;
  prompt: string;
  disabled?: boolean;
  title?: string;
}

/** 时间分隔线的时间格式：当天只显示时分，跨天显示月日+时分 */
function formatClock(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

/**
 * Agent 聊天面板：流式对话 + 工具调用可视化 + 删除确认卡片。
 * 侧边栏模式下由 Workspace 包在抽屉中，完整页模式下为固定右栏。
 * focusOnMount：打开抽屉/挂载时聚焦输入框（避免聚焦到不可见元素）。
 */
export function ChatPanel({
  className,
  style,
  focusOnMount = false,
}: {
  className?: string;
  style?: CSSProperties;
  focusOnMount?: boolean;
}) {
  const messages = useAIStore((s) => s.messages);
  const streaming = useAIStore((s) => s.streaming);

  /*
   * 宠物的常驻状态：工具在跑 → working，本轮在跑 → thinking，否则 idle。
   * 另外在一轮**正常结束**时给一次短暂的 happy（1.6s），失败/取消不给——
   * 失败后面露喜色比不做表情更伤信任。
   */
  const [celebrate, setCelebrate] = useState(false);
  const wasStreaming = useRef(false);
  useEffect(() => {
    // 从 store 直接取最新消息：把 messages 放进依赖会让每次流式增量都跑一遍 effect
    const lastFailed = Boolean(useAIStore.getState().messages.at(-1)?.failed);
    if (shouldCelebrate(wasStreaming.current, streaming, lastFailed)) {
      setCelebrate(true);
      wasStreaming.current = streaming;
      const t = setTimeout(() => setCelebrate(false), 1600);
      return () => clearTimeout(t);
    }
    wasStreaming.current = streaming;
    return undefined;
  }, [streaming]);
  // useMemo：messages 引用不变就不重复扫（每次 delta 都全量扫是没必要的开销）
  const toolRunning = useMemo(() => hasRunningTool(messages), [messages]);
  const petState: PetState = celebrate ? 'happy' : stateFromAgent(streaming, toolRunning);
  const send = useAIStore((s) => s.send);
  const cancel = useAIStore((s) => s.cancel);
  const pendingPlan = useAIStore((s) => s.pendingPlan);
  const approvePlan = useAIStore((s) => s.approvePlan);
  const cancelPlan = useAIStore((s) => s.cancelPlan);
  const clearMessages = useAIStore((s) => s.clearMessages);
  const retryLast = useAIStore((s) => s.retryLast);
  const conversations = useAIStore((s) => s.conversations);
  const activeId = useAIStore((s) => s.activeId);
  const createConversation = useAIStore((s) => s.createConversation);
  const switchConversation = useAIStore((s) => s.switchConversation);
  const renameConversation = useAIStore((s) => s.renameConversation);
  const deleteConversation = useAIStore((s) => s.deleteConversation);
  const undoPoints = useAIStore((s) => s.undoPoints);
  // 撤销记录读取失败时为 true：界面必须说「状态未知」，不能说「没有可撤销的操作」
  const undoUnknown = useAIStore((s) => s.undoUnknown);
  const undoNotice = useAIStore((s) => s.undoNotice);
  // 对话落盘失败/被裁剪时的如实提示：属于「你以为保存了、其实没有」，必须可见
  const persistError = useAIStore((s) => s.persistError);
  const persistNotice = useAIStore((s) => s.persistNotice);
  // 撤销历史（新在前）：让「撤销第几步」可控，而不是只能盲点最新那一个
  const undoHistory = describeUndoHistory(undoPoints);
  const undoLast = useAIStore((s) => s.undoLast);
  const refreshUndo = useAIStore((s) => s.refreshUndo);
  /** 撤销记录读取失败后的重试中标记 */
  const [retryingUndo, setRetryingUndo] = useState(false);
  // 撤销：最新一轮的写操作。含删除的轮次会返回不可撤销 + 原因（不假装成功）
  const undoPoint = undoPoints[0];
  const undoReady = undoReadiness(undoPoint);
  const baseUndoTitle = !undoPoint
    ? '暂无可撤销的操作'
    : undoReady.undoable
      ? `撤销本次操作（${summarizeOps(undoPoint.ops)}）`
      : undoUnknown
        ? '撤销记录读取失败，当前状态未知'
        : `无法撤销：${undoReady.reason}`;
  // 撤销记录被裁剪 / 写入失败时，把原因一并说清楚，别让"没有可撤销的操作"变成假话
  const undoTitle = undoNotice ? `${baseUndoTitle}\n${undoNotice}` : baseUndoTitle;
  const roots = useBookmarkStore((s) => s.roots);
  const selectedFolderId = useBookmarkStore((s) => s.selectedFolderId);
  const config = useConfigStore((s) => s.config);
  // 已配置判断与聊天实际一致：resolveConfig 回落预设（原始存储里 baseUrl 可能为空串），
  // 需要 Key 的服务商没填 Key 视为未配置
  const chatConfigured = useMemo(() => {
    const eff = resolveConfig(config);
    const preset = PROVIDERS.find((p) => p.id === eff.providerId);
    return !!eff.baseUrl && !!eff.model && !(preset?.needsKey === true && !eff.apiKey);
  }, [config]);

  const [input, setInput] = useState('');
  const [stickToBottom, setStickToBottom] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmDeleteSession, setConfirmDeleteSession] = useState<string | null>(null);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [undoHistoryOpen, setUndoHistoryOpen] = useState(false);
  const [memoriesOpen, setMemoriesOpen] = useState(false);
  const [editingSession, setEditingSession] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [sessionQuery, setSessionQuery] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 稳定引用：MessageView 已 memo，重试回调需保持引用不变
  const handleRetry = useCallback(() => retryLast(), [retryLast]);

  // 长期记忆（只读查看 + 快捷启停/删除；编辑入口在设置页）
  const memories = useMemoryStore((s) => s.memories);
  const loadMemories = useMemoryStore((s) => s.load);
  const toggleMemory = useMemoryStore((s) => s.toggle);
  const removeMemory = useMemoryStore((s) => s.remove);
  const activeMemCount = useMemo(() => memories.filter((m) => m.enabled).length, [memories]);

  useEffect(() => {
    void loadMemories();
    const stopSync = initMemorySync();
    return () => stopSync();
  }, [loadMemories]);

  // 新消息 / 流式增量时自动滚到底部（用户上翻后暂停跟随）
  useEffect(() => {
    if (stickToBottom) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [messages, streaming, stickToBottom]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setStickToBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  };

  /** 输入框自动增高（1~5 行），发送后复位 */
  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  };

  const submit = () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    // 自动附带当前查看的文件夹作为上下文，让「把这里的书签整理一下」这类自然指令可被 Agent 理解
    const folderId = useBookmarkStore.getState().selectedFolderId ?? undefined;
    void send(text, folderId ? { folderId } : undefined);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Esc：流式中停止生成；有输入则清空；否则失焦（原生习惯）
    if (e.key === 'Escape') {
      if (streaming) {
        cancel();
        return;
      }
      if (input) {
        setInput('');
        if (inputRef.current) inputRef.current.style.height = 'auto';
      } else {
        inputRef.current?.blur();
      }
      return;
    }
    // Enter 发送，Shift+Enter 换行，输入法组合期间不触发
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  // 打开抽屉/挂载时聚焦输入框（随 focusOnMount 变化触发）
  useEffect(() => {
    if (focusOnMount) inputRef.current?.focus();
  }, [focusOnMount]);

  // 文件夹已删时视为未选中（显示空标题，避免悬空「(未命名)」）
  const folderTitle = selectedFolderId
    ? findNode(roots, selectedFolderId)
      ? resolveTitlePath(roots, selectedFolderId)
      : ''
    : '';
  const chips: QuickChip[] = [
    {
      label: '整理此文件夹',
      icon: FolderTree,
      disabled: !selectedFolderId,
      title: selectedFolderId ? undefined : '先在左侧选择一个文件夹',
      prompt: `请整理书签文件夹「${folderTitle}」：浏览其全部书签，创建合适的子分类，并把书签归类移动到位。`,
    },
    {
      label: '智能扫描清理',
      icon: ScanSearch,
      prompt:
        '请全面扫描我的书签：找出死链、短期促销页、失效的文档或 API 页面，以及超过 2 年未访问的过时内容。用 check_urls 实测关键链接，并给出删除提议（每条附理由）。注意：你只能提交删除提议，不要声称已删除，等待我在界面确认。',
    },
    {
      label: '汇总统计',
      icon: TrendingUp,
      prompt: '请统计我的书签整体状况，并指出最值得我关注的问题。',
    },
  ];

  /** 导出全部对话为 Markdown 文件（备份/归档，含工具结果与待删清单） */
  const exportChat = () => {
    if (messages.length === 0 || streaming) return; // 流式中导出会缺尾部增量
    const lines: string[] = ['# MarkAI 对话记录', ''];
    for (const m of messages) {
      const text = m.blocks
        .filter((b): b is { kind: 'text'; text: string } => b.kind === 'text')
        .map((b) => b.text)
        .join('');
      const tools = m.blocks
        .filter((b) => b.kind === 'tool')
        .map((b) => b.record)
        .filter((r) => r.status === 'done' && r.result)
        .map((r) => {
          const body = (r.result ?? '').slice(0, 4000);
          return body + ((r.result?.length ?? 0) > 4000 ? '\n（结果过长，导出时截断）' : '');
        })
        .join('\n');
      lines.push(`## ${m.role === 'user' ? '用户' : 'Agent'} · ${formatClock(m.createdAt)}`);
      // 上下文文件夹（Agent 视野）随消息导出
      if (m.contextFolderId) {
        const roots = useBookmarkStore.getState().roots;
        if (findNode(roots, m.contextFolderId)) {
          lines.push(`> 上下文：${resolveTitlePath(roots, m.contextFolderId)}`);
        }
      }
      if (text) {
        // 引用块格式：避免消息中的 # / 列表等符号与文档结构混淆
        lines.push('', text.split('\n').map((l) => `> ${l}`).join('\n'));
      }
      if (tools) {
        lines.push('', `> 工具结果：\n${tools.split('\n').map((l) => `> ${l}`).join('\n')}`);
      }
      lines.push('');
    }
    // 附当前待删清单（待确认状态）
    const pending = useAIStore.getState().pendingDeletions.filter((p) => p.status === 'pending');
    if (pending.length > 0) {
      lines.push('## 待删除清单（未确认）', '');
      for (const p of pending) {
        lines.push(`- [ ] ${p.title}${p.url ? `（${p.url}）` : ''} — ${p.reason}`);
      }
      lines.push('');
    }
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `MarkAI-对话-${formatIsoDate(Date.now()) || 'export'}.md`;
    a.click();
    // 延迟释放，避免下载被中断
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div
      data-testid="chat-panel"
      className={cn('flex h-full min-h-0 flex-col bg-card', className)}
      style={style}
    >
      {/* 头部：紧凑单行，文件夹/模型截断显示，不互相挤压 */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        {/* 宠物常驻在 Agent 头部：它是这一栏的"人"，不是一个图标 */}
        <PetFace size={26} state={petState} />
        <span className="shrink-0 text-xs font-semibold text-foreground">Agent</span>
        {streaming ? (
          <span
            className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent"
            title="正在生成回复…"
          />
        ) : (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" title="就绪" />
        )}
        <span className="h-3.5 w-px shrink-0 bg-border" />
        {/* 当前上下文文件夹（Agent 的操作范围提示，占剩余宽度，点击可在树中定位） */}
        {selectedFolderId && folderTitle && (
          <button
            type="button"
            onClick={() => useBookmarkStore.getState().revealInTree(selectedFolderId)}
            className="min-w-0 flex-1 truncate rounded-sm px-1 text-left text-2xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title={`当前上下文：${folderTitle}（点击在树中定位）`}
          >
            {folderTitle}
          </button>
        )}
        {config.model && (
          <button
            type="button"
            onClick={() => void chrome.runtime.openOptionsPage()}
            className="max-w-[35%] shrink truncate rounded-sm px-1 text-2xs text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
            title={`当前模型：${config.model}（点击修改配置）`}
          >
            {config.model}
          </button>
        )}
        {/* 操作区：设置入口不在这里重复（工作区顶栏已有），只留本面板自己的动作 */}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            title={undoUnknown ? '撤销历史（读取失败，可点开重试）' : `撤销历史（最近 ${undoHistory.length} 步）`}
            aria-label="撤销历史"
            /*
             * 状态未知时也要能打开：读取失败时 undoHistory 恰好是 0 条，
             * 按"0 条就禁用"会把唯一能说明"读取失败、不是没有操作"的面板锁死——
             * 用户在按钮上只看到一行 title，永远看不到原因，也没法重试。
             */
            disabled={undoHistory.length === 0 && !undoUnknown}
            onClick={() => setUndoHistoryOpen(true)}
          >
            <History className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="relative"
            title={undoTitle}
            aria-label={undoTitle}
            disabled={!undoReady.undoable || streaming}
            onClick={() => void undoLast()}
          >
            <Undo2 className="h-3.5 w-3.5" />
            {undoReady.undoable && (
              /* ring-card：徽标压在按钮上时靠一圈面板色描边与图标分离（此前 bg-primary
                 是未定义 token，整枚徽标没有背景色，浅色模式下几乎看不见） */
              <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-2xs leading-none font-medium text-accent-foreground ring-2 ring-card">
                {undoReady.count}
              </span>
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="relative"
            title={`长期记忆（${activeMemCount} 条生效）`}
            aria-label="长期记忆"
            onClick={() => setMemoriesOpen((v) => !v)}
          >
            <Brain className="h-3.5 w-3.5" />
            {activeMemCount > 0 && (
              <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-2xs leading-none font-medium text-accent-foreground ring-2 ring-card">
                {activeMemCount}
              </span>
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title={streaming ? 'Agent 回复中，暂不可切换会话' : '会话管理'}
            aria-label="会话管理"
            disabled={streaming}
            onClick={() => setSessionsOpen(true)}
          >
            <MessagesSquare className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="清空对话"
            aria-label="清空对话"
            disabled={messages.length === 0 || streaming}
            onClick={() => setConfirmClear(true)}
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="导出对话为 Markdown"
            aria-label="导出对话"
            disabled={messages.length === 0 || streaming}
            onClick={exportChat}
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* 消息区 */}
      <div className="relative min-h-0 flex-1">
        {/* 会话管理面板（覆盖消息区） */}
        {(persistError || persistNotice) && (
          <div
            className={cn(
              'flex shrink-0 items-start gap-2 border-b px-3 py-2 text-2xs',
              persistError
                ? 'border-destructive/40 bg-destructive/10 text-destructive'
                : 'border-border bg-muted/40 text-muted-foreground',
            )}
          >
            <AlertTriangle className="mt-[1px] h-3 w-3 shrink-0" />
            <span className="min-w-0 flex-1">{persistError?.message ?? persistNotice}</span>
            {/*
             * "没保存成功"必须有重试。
             *
             * 原来只有「知道了」——按下去等于把唯一一条"这段对话不在磁盘上"的提示关掉，
             * 数据仍然没保存。用户看到过一句话，然后什么都没有了。
             */}
            {persistError && (
              <button
                type="button"
                data-testid="persist-retry"
                className="shrink-0 rounded-sm border border-destructive/40 px-1.5 py-0.5 text-2xs transition-colors hover:bg-destructive/10"
                onClick={() => {
                  void (async () => {
                    await useAIStore.getState()._persist(true);
                    const still = useAIStore.getState().persistError;
                    pushToast(still ? '仍未保存成功' : '已保存', {
                      variant: still ? 'destructive' : 'success',
                      ...(still ? { description: still.message } : {}),
                    });
                  })();
                }}
              >
                重试保存
              </button>
            )}
            <button
              type="button"
              className="shrink-0 text-2xs underline"
              onClick={() => useAIStore.setState({ persistError: null, persistNotice: null })}
            >
              知道了
            </button>
          </div>
        )}

        {undoHistoryOpen && (
          <div className="absolute inset-0 z-20 flex flex-col bg-card">
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setUndoHistoryOpen(false)}
                title="返回聊天"
                aria-label="返回聊天"
              >
                <ArrowDown className="h-3.5 w-3.5 rotate-180" />
              </Button>
              <span className="text-xs font-medium text-foreground">撤销历史</span>
              <span className="text-2xs text-muted-foreground">最近 {undoHistory.length} 步</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {undoUnknown ? (
                /*
                 * 读失败 ≠ 没有可撤销的操作（这句区别很重要），
                 * 但光说"请重新打开面板"等于把活推给用户——面板里就该有一个重试。
                 */
                <div className="flex flex-col items-center gap-2 px-2 py-3">
                  <p className="text-center text-2xs text-destructive">
                    撤销记录读取失败，当前状态未知（这不等于「没有可撤销的操作」）。
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 px-2 text-2xs"
                    disabled={retryingUndo}
                    onClick={() => {
                      setRetryingUndo(true);
                      void refreshUndo().finally(() => setRetryingUndo(false));
                    }}
                    data-testid="undo-retry"
                  >
                    <RefreshCw className={cn('h-3 w-3', retryingUndo && 'animate-spin')} />
                    重试
                  </Button>
                </div>
              ) : undoHistory.length === 0 ? (
                <p className="px-2 py-3 text-center text-2xs text-muted-foreground">
                  还没有可撤销的操作。Agent 每次整理（以及你手工确认的删除）都会在这里留下一步。
                </p>
              ) : (
                undoHistory.map((row, i) => (
                  <button
                    key={row.id}
                    type="button"
                    disabled={!row.undoable || streaming}
                    title={row.undoable ? '撤销最新的一步' : (row.reason ?? '无法撤销')}
                    onClick={() => {
                      setUndoHistoryOpen(false);
                      void undoLast(row.id);
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left transition-colors',
                      row.undoable && !streaming ? 'hover:bg-muted' : 'cursor-not-allowed opacity-55',
                    )}
                  >
                    <span className="w-6 shrink-0 text-2xs text-muted-foreground/70">
                      {i === 0 ? '最新' : `−${i}`}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-xs text-foreground">{row.summary}</span>
                        {row.source === 'auto' && (
                          <span className="shrink-0 rounded-xs bg-accent-muted px-1 py-px text-2xs text-accent">
                            自动整理
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-2xs text-muted-foreground">
                        {row.undoable ? `还原 ${row.count} 项` : (row.reason ?? '无法撤销')}
                        {' · '}
                        {formatRelativeTime(row.createdAt)}
                      </span>
                    </span>
                    <Undo2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
                  </button>
                ))
              )}
              {undoHistory.length > 1 && undoHistory[0]?.undoable && !streaming && (
                <button
                  type="button"
                  onClick={() => {
                    setUndoHistoryOpen(false);
                    void (async () => {
                      let steps = 0;
                      // 从最新往旧逐步退回：一次点击退完，避免用户连点 N 次
                      while (steps < 20 && (await undoLast(undefined, { silent: true }))) steps++;
                      const left = useAIStore.getState().undoPoints.length;
                      if (steps > 0) {
                        // 退不完时必须说清为什么 —— 否则「撤销全部」看起来像没生效
                        pushToast(`已撤销 ${steps} 步`, {
                          ...(left > 0
                            ? {
                                description: `还有 ${left} 步当前无法撤销（含删除的操作不支持回退），可单独查看原因。`,
                              }
                            : {}),
                          variant: left > 0 ? 'default' : 'success',
                        });
                      } else {
                        pushToast('没有可撤销的步骤');
                      }
                    })();
                  }}
                  className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-sm border border-border px-2 py-1.5 text-2xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  title="从最新一步开始连续回退，直到没有可撤销的步骤"
                >
                  <Undo2 className="h-3 w-3" />
                  撤销全部 {undoHistory.length} 步
                </button>
              )}
            </div>
            {undoNotice && (
              <p
                data-testid="undo-notice"
                className="shrink-0 border-t border-border px-2.5 py-1.5 text-2xs text-muted-foreground"
              >
                {undoNotice}
              </p>
            )}
          </div>
        )}

        {memoriesOpen && (
          <div className="absolute inset-0 z-20 flex flex-col bg-card">
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setMemoriesOpen(false)}
                title="返回聊天"
                aria-label="返回聊天"
              >
                <ArrowDown className="h-3.5 w-3.5 rotate-180" />
              </Button>
              <span className="text-xs font-medium text-foreground">长期记忆</span>
              <span className="text-2xs text-muted-foreground">{activeMemCount} 条生效</span>
              <button
                type="button"
                onClick={() => void chrome.runtime.openOptionsPage()}
                className="ml-auto text-2xs text-accent transition-colors hover:underline"
              >
                管理全部 →
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {memories.length === 0 ? (
                <div className="px-2 py-3 text-center">
                  <p className="text-2xs leading-4 text-muted-foreground">
                    还没有长期记忆。直接对我说「记住：技术类书签按语言分类」，我就会把它记下来——以后每次整理都自动遵守。
                  </p>
                </div>
              ) : (
                <ul className="space-y-1.5">
                  {memories.map((m) => (
                    <li
                      key={m.id}
                      className={cn(
                        'group flex items-start gap-2 rounded-sm border border-border px-2.5 py-2',
                        m.enabled ? 'bg-card' : 'bg-muted/40 opacity-70',
                      )}
                    >
                      <span
                        className={cn(
                          'mt-1 h-1.5 w-1.5 shrink-0 rounded-full',
                          m.enabled ? 'bg-accent' : 'bg-muted-foreground/40',
                        )}
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        <p className={cn('text-xs leading-4 break-words', m.enabled ? 'text-foreground' : 'text-muted-foreground line-through')}>
                          {m.content}
                        </p>
                        <p className="mt-0.5 text-2xs text-muted-foreground/70">
                          {CATEGORY_LABELS[m.category]} · {formatRelativeTime(m.updatedAt)}
                        </p>
                      </div>
                      <button
                        type="button"
                        title={m.enabled ? '停用' : '启用'}
                        aria-label={m.enabled ? '停用这条记忆' : '启用这条记忆'}
                        onClick={() => void toggleMemory(m.id)}
                        className="shrink-0 rounded-xs p-1 text-2xs text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
                      >
                        {m.enabled ? '停用' : '启用'}
                      </button>
                      <button
                        type="button"
                        title="删除"
                        aria-label="删除这条记忆"
                        onClick={() => void removeMemory(m.id)}
                        className="shrink-0 rounded-xs p-1 text-muted-foreground/50 transition-colors hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {sessionsOpen && (
          <div className="absolute inset-0 z-20 flex flex-col bg-card">
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
              <Button variant="ghost" size="icon" onClick={() => setSessionsOpen(false)} title="返回聊天" aria-label="返回聊天">
                <ArrowDown className="h-3.5 w-3.5 rotate-180" />
              </Button>
              <span className="text-xs font-medium text-foreground">会话</span>
              <span className="text-2xs text-muted-foreground">{conversations.length} 个</span>
            </div>
            {/* 会话搜索（会话多时快速定位） */}
            <div className="relative border-b border-border px-3 py-2">
              <Search className="absolute top-1/2 left-5 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
              <input
                value={sessionQuery}
                onChange={(e) => setSessionQuery(e.target.value)}
                placeholder="搜索会话…"
                className="h-7 w-full rounded-sm border border-input bg-card pr-1.5 pl-6 text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {/* 最近活跃的会话置顶（支持标题搜索过滤） */}
              {[...conversations]
                .sort((a, b) => b.updatedAt - a.updatedAt)
                .filter((c) => !sessionQuery.trim() || c.title.toLowerCase().includes(sessionQuery.trim().toLowerCase()))
                .map((c) => (
                <div
                  key={c.id}
                  className={cn(
                    'group relative flex items-center gap-2 rounded-sm px-2.5 py-2',
                    c.id === activeId ? 'bg-accent-muted' : 'hover:bg-muted',
                  )}
                >
                  {/* 当前会话指示条 */}
                  {c.id === activeId && (
                    <span className="pointer-events-none absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-accent" />
                  )}
                  {editingSession === c.id ? (
                    <input
                      autoFocus
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      onBlur={() => {
                        renameConversation(c.id, editTitle || c.title);
                        setEditingSession(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                          renameConversation(c.id, editTitle || c.title);
                          setEditingSession(null);
                        } else if (e.key === 'Escape') {
                          setEditingSession(null);
                        }
                      }}
                      className="h-6 min-w-0 flex-1 rounded-sm border border-ring bg-card px-1.5 text-xs outline-none"
                    />
                  ) : (
                    <div className="min-w-0 flex-1">
                      <button
                        type="button"
                        onClick={() => {
                          switchConversation(c.id);
                          setSessionsOpen(false);
                        }}
                        onDoubleClick={() => {
                          setEditingSession(c.id);
                          setEditTitle(c.title);
                        }}
                        className={cn(
                          'block w-full truncate text-left text-xs',
                          c.id === activeId ? 'font-medium text-accent' : 'text-foreground',
                        )}
                        title={`${c.title}\n${c.messages.length} 条消息 · 双击重命名`}
                      >
                        {c.title || '新会话'}
                      </button>
                      <p className="text-2xs text-muted-foreground/60">
                        {c.messages.length} 条消息 · {formatRelativeTime(c.updatedAt)}
                      </p>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setEditingSession(c.id);
                      setEditTitle(c.title);
                    }}
                    className="shrink-0 rounded-sm p-1 text-muted-foreground/60 opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                    title="重命名会话"
                    aria-label="重命名会话"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  {confirmDeleteSession === c.id ? (
                    // 二次点击确认：删除不可恢复（墓碑机制），防误点
                    <button
                      type="button"
                      onClick={() => {
                        deleteConversation(c.id);
                        setConfirmDeleteSession(null);
                      }}
                      className="shrink-0 rounded-sm px-1.5 py-0.5 text-2xs font-medium text-destructive transition-colors hover:bg-destructive/10"
                      title="再次点击确认删除该会话"
                    >
                      确认删除？
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmDeleteSession(c.id);
                        // 5s 未二次点击自动恢复，避免误触后一直悬着
                        window.setTimeout(() => {
                          setConfirmDeleteSession((cur) => (cur === c.id ? null : cur));
                        }, 5000);
                      }}
                      className="shrink-0 rounded-sm p-1 text-muted-foreground/60 opacity-0 transition-opacity hover:bg-muted hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
                      title="删除会话"
                      aria-label="删除会话"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ))}
              {conversations.length === 0 && (
                <p className="px-2 py-3 text-center text-2xs text-muted-foreground">还没有会话</p>
              )}
            </div>
            <div className="border-t border-border p-2">
              <Button
                size="sm"
                className="w-full"
                onClick={() => {
                  createConversation();
                  setSessionsOpen(false);
                }}
              >
                <Plus className="h-3 w-3" />
                新建会话
              </Button>
            </div>
          </div>
        )}
        <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto px-3 py-3.5">
          {messages.length === 0 ? (
            <EmptyState
              chips={chips}
              onChip={(p) => void send(p)}
              configured={chatConfigured}
              autoOrganize={config.autoOrganizeNew ?? true}
              petState={petState}
            />
          ) : (
            <div className="space-y-3.5">
              {messages.map((m, i) => (
                <div key={m.id}>
                  {/* 与上一条消息间隔较长时显示时间分隔（长会话导航） */}
                  {i > 0 && m.createdAt - messages[i - 1]!.createdAt > 10 * 60_000 && (
                    <div className="mb-3 flex items-center gap-2">
                      <span className="h-px flex-1 bg-border" />
                      <span className="text-2xs text-muted-foreground/60">{formatClock(m.createdAt)}</span>
                      <span className="h-px flex-1 bg-border" />
                    </div>
                  )}
                  <MessageView
                    message={m}
                    streaming={streaming && i === messages.length - 1 && m.role === 'assistant'}
                    isLast={i === messages.length - 1}
                    onRetry={handleRetry}
                  />
                </div>
              ))}
              {streaming && messages[messages.length - 1]?.role === 'assistant' &&
                messages[messages.length - 1]?.blocks.length === 0 && (
                  <div className="flex items-center gap-2 text-2xs text-muted-foreground">
                    <Bot className="h-3 w-3 animate-pulse text-accent" />
                    Agent 正在思考…
                  </div>
                )}
            </div>
          )}
        </div>
        {/* 计划模式：待确认的写操作清单。**确认前一步都不会执行**；取消则零写入。 */}
        {pendingPlan && (
          <div className="shrink-0 border-t border-border bg-muted/40 px-3 py-2.5">
            <div className="mb-1.5 flex items-center gap-1.5">
              <ScanSearch className="h-3.5 w-3.5 shrink-0 text-accent" />
              <span className="text-xs font-medium text-foreground">计划：等待你确认</span>
              <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">
                共 {pendingPlan.steps.length} 步，确认前不会改动任何书签
              </span>
            </div>
            <ul className="mb-2 space-y-1">
              {pendingPlan.steps.map((step, i) => (
                <li
                  key={`${step.name}-${i}`}
                  className="flex items-center gap-1.5 text-2xs text-foreground"
                >
                  <span className="shrink-0 text-muted-foreground/60">{i + 1}.</span>
                  <span className="min-w-0 flex-1 truncate" title={step.summary}>
                    {step.summary}
                  </span>
                  {/* 条数必须如实：没声明过就不能显示成"1 项"（那是把"不知道"说成"就一条"） */}
                  <span className="shrink-0 text-muted-foreground/60">
                    {step.countDeclared ? `${step.count} 项` : '条数未声明'}
                  </span>
                  {step.preview && (
                    <span className="shrink-0 text-muted-foreground/60">（仅预览）</span>
                  )}
                </li>
              ))}
            </ul>
            <div className="flex items-center gap-1.5">
              <Button size="sm" onClick={approvePlan}>
                确认执行
              </Button>
              <Button size="sm" variant="outline" onClick={cancelPlan}>
                取消
              </Button>
              <span className="text-2xs text-muted-foreground">取消则本轮没有执行任何写操作</span>
            </div>
          </div>
        )}
        {/* 上翻查看历史后：回到底部按钮 */}
        {!stickToBottom && messages.length > 0 && (
          <button
            type="button"
            onClick={() => {
              const el = scrollRef.current;
              if (el) {
                el.scrollTop = el.scrollHeight;
                setStickToBottom(true);
              }
            }}
            className="animate-fade-in absolute right-3 bottom-3 flex h-7 w-7 items-center justify-center rounded-full border border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="回到底部"
            aria-label="回到底部"
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* 输入区 */}
      <div className="shrink-0 border-t border-border p-3">
        {/* 快捷指令（对话中也可一键触发；流式时隐藏） */}
        {!streaming && messages.length > 0 && (
          <div className="mb-1.5 flex flex-wrap items-center gap-x-0.5">
            <span className="shrink-0 text-2xs text-muted-foreground/70">快捷</span>
            {chips.map((chip) => (
              <button
                key={chip.label}
                type="button"
                disabled={chip.disabled}
                title={chip.title}
                onClick={() => void send(chip.prompt)}
                className="rounded-full border border-border bg-card px-2 py-0.5 text-2xs text-muted-foreground transition-colors hover:border-accent/40 hover:text-accent disabled:pointer-events-none disabled:opacity-40"
              >
                {chip.label}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            data-testid="chat-input"
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onInput={(e) => autoGrow(e.currentTarget)}
            onKeyDown={onKeyDown}
            placeholder={streaming ? 'Agent 正在回复…' : '与 MarkAI 对话，例如「帮我把技术类书签整理一下」'}
            rows={1}
            className="max-h-24 min-h-8 flex-1 rounded-md"
          />
          {streaming ? (
            <Button variant="secondary" size="icon" onClick={cancel} title="停止生成" aria-label="停止生成" className="h-8 w-8 rounded-md">
              <Square className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <>
              {input && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    setInput('');
                    if (inputRef.current) inputRef.current.style.height = 'auto';
                  }}
                  title="清空输入"
                  aria-label="清空输入"
                  className="h-8 w-8 rounded-md"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
              <Button
                size="icon"
                disabled={!input.trim()}
                onClick={submit}
                title="发送"
                aria-label="发送"
                className="h-8 w-8 rounded-md"
              >
                <Send className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
        </div>
        <p className="mt-2 text-2xs leading-4 text-muted-foreground">
          {resolveConfig(config).deleteMode === 'auto'
            ? '当前为「无需确认」模式：删除建议会自动执行。'
            : '移动、新建、重命名会直接执行；删除必须经你确认。'}
        </p>
      </div>

      {/* 清空对话确认 */}
      <Dialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="清空对话"
        description="将删除全部聊天记录，此操作不可恢复（不影响书签与待删除清单）。"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirmClear(false)} autoFocus>
              取消
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setConfirmClear(false);
                void clearMessages();
              }}
            >
              清空
            </Button>
          </>
        }
      />
    </div>
  );
}

/** 空状态欢迎卡片 */
function EmptyState({
  chips,
  onChip,
  configured,
  autoOrganize,
  petState,
}: {
  chips: QuickChip[];
  onChip: (prompt: string) => void;
  configured: boolean;
  /** 自动整理是否开启：关掉时不该在这里承诺「我会自动归类」 */
  autoOrganize: boolean;
  /** 宠物状态：由 Agent 的真实运行状态驱动（不是写死的 idle） */
  petState: PetState;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-5 py-6 text-center">
      <PetFace size={72} state={petState} />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">我是你的书签管家</p>
        <p className="max-w-[248px] text-xs leading-5 text-muted-foreground">
          让我整理、扫描、清理收藏夹。直接说你要什么，或从下面挑一个开始。
        </p>
      </div>
      {!configured && (
        <button
          type="button"
          onClick={() => void chrome.runtime.openOptionsPage()}
          className="rounded-sm border border-accent/30 bg-accent-muted px-2.5 py-1 text-2xs text-accent transition-colors hover:bg-accent/15"
        >
          尚未配置 AI 服务，点击前往设置 →
        </button>
      )}
      <div className="flex w-full max-w-[248px] flex-col gap-2">
        {chips.map((chip) => (
          <Button
            key={chip.label}
            variant="outline"
            size="sm"
            disabled={chip.disabled}
            title={chip.title}
            onClick={() => onChip(chip.prompt)}
            className="h-8 justify-start gap-2 px-2.5"
          >
            <chip.icon className="h-3.5 w-3.5 text-accent" />
            {chip.label}
          </Button>
        ))}
      </div>
      {/* 能力告知：自动整理发生在后台，新人不会自己发现它，更不会去翻 README */}
      {autoOrganize && (
        <p className="flex max-w-[248px] items-start gap-1.5 text-left text-2xs leading-4 text-muted-foreground/70">
          <Wand2 className="mt-px h-3 w-3 shrink-0 text-accent/70" aria-hidden="true" />
          <span>
            收藏任意网页后我会自动归类。想知道动了哪些、或撤销某一步，点顶栏
            <span className="text-muted-foreground">「整理」</span>。
          </span>
        </p>
      )}
    </div>
  );
}
