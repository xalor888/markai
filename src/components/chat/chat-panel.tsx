import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  BookMarked,
  Bot,
  Brain,
  ChevronRight,
  Download,
  Folder,
  FolderTree,
  History,
  MessagesSquare,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  Search,
  Send,
  Sparkles,
  Square,
  Trash2,
  TrendingUp,
  Undo2,
  Wand2,
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
import { flattenForFacts, petFacts } from '@/lib/pet/facts';
import { buildSuggestion, type Suggestion } from '@/lib/pet/suggest';
import {
  addDecline,
  alreadyKnown,
  extractHabits,
  HABIT_DECLINE_STORAGE_KEY,
  isDeclined,
  pruneDeclines,
  type HabitCandidate,
  type HabitDecline,
} from '@/lib/pet/habits';
import { addMemoryItem } from '@/lib/ai/memory';
import { readOrganizeLog } from '@/lib/ai/organize-log';
import { Switch } from '@/components/ui/switch';
import { filterSlashCommands } from '@/lib/chat/slash';
import { ActivityStatus, StallBanner } from './activity-status';
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
  const activity = useAIStore((s) => s.activity);

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

  /*
   * 宠物要说的话：取当前**权重最高**的一条事实直接展示。
   * 频率模型（pickChatter：90s 间隔 / 30min 冷却 / 被打断静默）留给后台定时器那一层——
   * 面板里每渲染一次就"说话"的话，克制规则等于没有。
   */
  // 事实只算一次：一句话与建议共用（两处各算一遍会得出不一致的数字）
  const petFactsList = useMemo(() => petFacts(flattenForFacts(roots)), [roots]);
  const petLine = useMemo(
    () => [...petFactsList].sort((a, b) => b.weight - a.weight)[0]?.text ?? null,
    [petFactsList],
  );

  /*
   * 管家日报：今天自动整理了几条、失败几条。
   * 只在今天**真的发生过整理**时显示——没有整理的日子里，这一行会变成噪音。
   * 撤销步数在渲染时由 undoHistory 直接给（它是另一份 store，不在这里重复读）。
   */
  const [digest, setDigest] = useState<{ organized: number; failed: number } | null>(null);
  useEffect(() => {
    let alive = true;
    void readOrganizeLog()
      .then((entries) => {
        if (!alive) return;
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const today = entries.filter((e) => e.at >= start.getTime());
        if (today.length === 0) {
          setDigest(null);
          return;
        }
        setDigest({
          organized: today.filter((e) => e.action === 'moved' || e.action === 'created').length,
          failed: today.filter((e) => e.action === 'failed').length,
        });
      })
      .catch(() => setDigest(null));
    return () => {
      alive = false;
    };
  }, [roots]);

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

  /*
   * 习惯候选：从**用户自己说过的话**里提取，排除已有记忆与"已被拒绝"的。
   * 只显示一条：一次问一件事，问多了就变成审问。
   */
  const [declines, setDeclines] = useState<HabitDecline[]>([]);
  useEffect(() => {
    void chrome.storage.local
      .get(HABIT_DECLINE_STORAGE_KEY)
      .then((d) => {
        const raw = d[HABIT_DECLINE_STORAGE_KEY];
        setDeclines(Array.isArray(raw) ? pruneDeclines(raw as HabitDecline[], Date.now()) : []);
      })
      .catch(() => {
        // 读不到拒绝列表不影响主流程：最多是多问一次
      });
  }, []);

  const habitCandidate = useMemo(() => {
    const userTexts = messages
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.blocks.flatMap((b) => (b.kind === 'text' ? [b.text] : [])));
    const now = Date.now();
    return (
      extractHabits(userTexts.slice(-20)).find(
        (c) => !alreadyKnown(c.text, memories) && !isDeclined(declines, c.text, now),
      ) ?? null
    );
  }, [messages, memories, declines]);

  // 主动建议：观察 + 你确认过的习惯 → 一条可执行的提议（不会自动执行）
  const petSuggestion = useMemo(() => buildSuggestion(petFactsList, memories), [petFactsList, memories]);

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

  /** 斜杠命令：只填入 prompt，不自动发送 */
  const slashMatches = useMemo(() => filterSlashCommands(input), [input]);
  const [slashIndex, setSlashIndex] = useState(0);
  useEffect(() => {
    setSlashIndex(0);
  }, [input]);

  const chooseSlash = (command: (typeof slashMatches)[number]) => {
    setInput(command.prompt);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      autoGrow(el);
    });
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
    // 斜杠菜单打开时：↑↓ 选择、Enter 填入；不抢发送
    if (slashMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % slashMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        chooseSlash(slashMatches[slashIndex] ?? slashMatches[0]!);
        return;
      }
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
      className={cn('relative flex h-full min-h-0 flex-col bg-background', className)}
      style={style}
    >
      {/*
         * 头部只回答两件事：这一栏是谁（头像 + 名称 + 状态），以及能对它做什么（右侧动作）。
         * 当前文件夹与模型挪到输入区底部——它们描述的是"这一轮对话的上下文"，
         * 放在头部只会和六个动作按钮抢宽度（侧边栏最窄时标题被截成「书签…」）。
         */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
        <span
          data-testid="agent-avatar"
          aria-hidden="true"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground"
        >
          <BookMarked className="h-3.5 w-3.5" strokeWidth={2.2} />
        </span>
        <span className="shrink-0 text-xs font-semibold text-foreground">Agent</span>
        <span
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            streaming || activity ? 'animate-pulse bg-accent' : 'bg-success',
          )}
          title={activity ? '正在处理' : streaming ? '正在生成回复…' : '就绪'}
        />
        {/* 操作区：设置入口不在这里重复（工作区顶栏已有），只留本面板自己的动作 */}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            title={undoUnknown ? '撤销历史（读取失败，可点开重试）' : `撤销历史（最近 ${undoHistory.length} 步）`}
            aria-label="撤销历史"
            /*
             * 状态未知时也要能打开：读取失败时 undoHistory 恰好是 0 条，
             * 按"0 条就禁用"会把唯一能说明"读取失败、不是没有操作"的面板锁死。
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

      {/*
       * 阶段条：头部那点宽度放不下「连接模型 · 31s · 仍在等待」，
       * 一截就只剩「连接模型…」，等于没说。这里单独占一行，宽度够、而且一直可见。
       */}
      {(activity || streaming) && (
        <div
          className="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-accent-muted/50 px-3 text-2xs text-muted-foreground"
          data-testid="agent-activity-strip"
        >
          <ActivityStatus activity={activity} streaming={streaming} />
          <button
            type="button"
            onClick={cancel}
            className="ml-auto shrink-0 rounded border border-border bg-background/60 px-1.5 py-0.5 font-medium text-foreground hover:bg-muted"
          >
            停止
          </button>
        </div>
      )}

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

        <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto px-3 py-3.5">
          {messages.length === 0 ? (
            <EmptyState
              chips={chips}
              onChip={(p) => void send(p)}
              configured={chatConfigured}
              autoOrganize={config.autoOrganizeNew ?? true}
              petLine={petLine}
              digest={digest ? { ...digest, undoable: undoHistory.length } : null}
              habit={habitCandidate}
              suggestion={petSuggestion}
              onAcceptHabit={async (text) => {
                await addMemoryItem(text, 'habit');
                await loadMemories();
              }}
              onDeclineHabit={async (text) => {
                const next = pruneDeclines(addDecline(declines, text, Date.now()), Date.now());
                setDeclines(next);
                await chrome.storage.local.set({ [HABIT_DECLINE_STORAGE_KEY]: next });
              }}
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
          <div className="mx-3 mb-2 shrink-0 rounded-xl border border-accent/25 bg-accent-muted/40 px-3 py-2.5">
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

      {/* 输入区：一个"卡片式"输入框，上下文与模型贴在框内底部（不再和顶栏抢宽度） */}
      <div className="relative shrink-0 border-t border-border bg-card px-3 pt-2 pb-3">
        {/* 快捷指令（对话中也可一键触发；流式时隐藏） */}
        {!streaming && messages.length > 0 && (
          <div className="mb-1.5 flex flex-wrap items-center gap-1">
            {chips.map((chip) => (
              <button
                key={chip.label}
                type="button"
                disabled={chip.disabled}
                title={chip.title}
                onClick={() => void send(chip.prompt)}
                className="rounded-md px-1.5 py-0.5 text-2xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              >
                {chip.label}
              </button>
            ))}
          </div>
        )}
        {slashMatches.length > 0 && !streaming && (
          <div
            data-testid="slash-menu"
            className="markai-glass markai-glass-liquid animate-slide-up absolute right-3 bottom-full left-3 z-10 mb-1 overflow-hidden rounded-xl p-1"
          >
            <p className="px-2 py-1 text-2xs font-medium text-muted-foreground/70">斜杠命令</p>
            {slashMatches.map((command, i) => (
              <button
                key={command.cmd}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => chooseSlash(command)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors',
                  i === slashIndex ? 'bg-accent-muted' : 'hover:bg-muted',
                )}
              >
                <span className="w-12 shrink-0 font-mono text-2xs text-accent">{command.cmd}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-foreground">{command.label}</span>
                  <span className="block truncate text-2xs text-muted-foreground">{command.description}</span>
                </span>
                {i === slashIndex && <span className="shrink-0 text-2xs text-muted-foreground">↵</span>}
              </button>
            ))}
          </div>
        )}
        <StallBanner activity={activity} onCancel={cancel} />
        <div className="rounded-xl border border-border bg-background p-1.5 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/15">
          <Textarea
            data-testid="chat-input"
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onInput={(e) => autoGrow(e.currentTarget)}
            onKeyDown={onKeyDown}
            placeholder={streaming ? 'Agent 正在处理，可点右侧停止…' : '问点什么，或让我整理书签…'}
            rows={1}
            className="max-h-24 min-h-9 w-full resize-none border-0 bg-transparent px-2 py-1.5 text-md focus-visible:border-0 focus-visible:ring-0"
          />
          <div className="flex items-center gap-1 px-1 pt-0.5 pb-0.5">
            {selectedFolderId && folderTitle && (
              <button
                type="button"
                onClick={() => useBookmarkStore.getState().revealInTree(selectedFolderId)}
                className="flex min-w-0 max-w-[45%] items-center gap-1 rounded-md bg-muted px-1.5 py-1 text-2xs text-muted-foreground transition-colors hover:text-foreground"
                title={`当前上下文：${folderTitle}（点击在树中定位）`}
              >
                <Folder className="h-3 w-3 shrink-0" />
                <span className="truncate">{folderTitle}</span>
              </button>
            )}
            {config.model && (
              <button
                type="button"
                onClick={() => void chrome.runtime.openOptionsPage()}
                className="max-w-[40%] shrink truncate rounded-md px-1.5 py-1 text-2xs text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
                title={`当前模型：${config.model}（点击修改配置）`}
              >
                {config.model}
              </button>
            )}
            <span className="ml-auto hidden shrink-0 text-2xs text-muted-foreground/50 sm:inline">
              {streaming ? '' : 'Enter 发送'}
            </span>
            {!streaming && input && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => {
                  setInput('');
                  if (inputRef.current) inputRef.current.style.height = 'auto';
                }}
                title="清空输入"
                aria-label="清空输入"
              >
                <X className="h-3 w-3" />
              </Button>
            )}
            {streaming ? (
              <Button
                variant="secondary"
                size="icon"
                onClick={cancel}
                title="停止生成"
                aria-label="停止生成"
                className="h-7 w-7 rounded-lg"
              >
                <Square className="h-3.5 w-3.5" />
              </Button>
            ) : (
              <Button
                size="icon"
                disabled={!input.trim()}
                onClick={submit}
                title="发送"
                aria-label="发送"
                className="h-7 w-7 rounded-lg"
              >
                <Send className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
        <p className="mt-1.5 text-2xs leading-4 text-muted-foreground">
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

      {/* 会话与记忆是"整块视图"：覆盖整个面板（包括输入区），避免出现"上面翻记录、下面还能打字"的分裂感 */}
        {memoriesOpen && (
          <div className="absolute inset-0 z-20 flex flex-col bg-card">
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setMemoriesOpen(false)}
                title="返回聊天"
                aria-label="返回聊天"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm font-semibold text-foreground">长期记忆</span>
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-2xs tabular-nums text-muted-foreground">
                {activeMemCount} 条生效
              </span>
              <button
                type="button"
                onClick={() => void chrome.runtime.openOptionsPage()}
                className="ml-auto text-2xs text-accent transition-colors hover:underline"
              >
                管理全部 →
              </button>
            </div>
            <p className="shrink-0 border-b border-border px-3 py-2 text-2xs leading-4 text-muted-foreground">
              整理书签时我会遵守这些约定；停用只是不参与决策，内容仍保留。对话里说「记住：…」也会写进来。
            </p>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {memories.length === 0 ? (
                <div className="flex flex-col items-center gap-1.5 px-3 py-10 text-center">
                  <Brain className="h-5 w-5 text-muted-foreground/40" />
                  <p className="text-xs text-muted-foreground">还没有长期记忆</p>
                  <p className="max-w-[240px] text-2xs leading-4 text-muted-foreground/70">
                    在对话里说「记住：技术类书签按语言分类」，或到设置页添加一条。
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-1"
                    onClick={() => void chrome.runtime.openOptionsPage()}
                  >
                    去设置添加
                  </Button>
                </div>
              ) : (
                <ul className="space-y-1.5">
                  {memories.map((m) => (
                    <li
                      key={m.id}
                      className={cn(
                        'group flex items-start gap-2.5 rounded-lg border border-border p-2.5 transition-colors',
                        m.enabled ? 'bg-card' : 'bg-muted/30',
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <p
                          className={cn(
                            'text-xs leading-5 break-words',
                            m.enabled ? 'text-foreground' : 'text-muted-foreground line-through',
                          )}
                        >
                          {m.content}
                        </p>
                        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground/70">
                          <span className="rounded-sm bg-muted px-1.5 py-px text-muted-foreground">
                            {CATEGORY_LABELS[m.category]}
                          </span>
                          <span>{formatRelativeTime(m.updatedAt)}</span>
                          <span>· 来源：对话 / 手动</span>
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Switch
                          checked={m.enabled}
                          onCheckedChange={() => void toggleMemory(m.id)}
                          aria-label={m.enabled ? '停用这条记忆' : '启用这条记忆'}
                        />
                        <button
                          type="button"
                          title="删除这条记忆"
                          aria-label="删除这条记忆"
                          onClick={() => void removeMemory(m.id)}
                          className="rounded-md p-1 text-muted-foreground/50 opacity-0 transition-all group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {sessionsOpen && (
          <div className="absolute inset-0 z-20 flex flex-col bg-card">
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
              <Button variant="ghost" size="icon" onClick={() => setSessionsOpen(false)} title="返回聊天" aria-label="返回聊天">
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm font-semibold text-foreground">会话</span>
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-2xs tabular-nums text-muted-foreground">
                {conversations.length}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="ml-auto"
                onClick={() => {
                  createConversation();
                  setSessionsOpen(false);
                }}
                title="新建会话"
                aria-label="新建会话"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            {/* 会话搜索（会话多时快速定位） */}
            <div className="relative border-b border-border px-3 py-2">
              <Search className="pointer-events-none absolute top-1/2 left-5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={sessionQuery}
                onChange={(e) => setSessionQuery(e.target.value)}
                placeholder="搜索会话…"
                aria-label="搜索会话"
                className="h-9 w-full rounded-lg border border-border bg-background pr-2 pl-8 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
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
                      'group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors',
                      c.id === activeId ? 'bg-accent-muted' : 'hover:bg-muted',
                    )}
                  >
                    {/* 当前会话指示条 */}
                    {c.id === activeId && (
                      <span className="pointer-events-none absolute top-2 bottom-2 left-0 w-0.5 rounded-full bg-accent" />
                    )}
                    <span
                      className={cn(
                        'flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
                        c.id === activeId ? 'bg-card text-accent' : 'bg-muted text-muted-foreground',
                      )}
                      aria-hidden="true"
                    >
                      <MessagesSquare className="h-3.5 w-3.5" />
                    </span>
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
                        aria-label="会话标题"
                        className="h-7 min-w-0 flex-1 rounded-md border border-ring bg-card px-2 text-xs outline-none"
                      />
                    ) : (
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
                        className="min-w-0 flex-1 text-left"
                        title={`${c.title}
${c.messages.length} 条消息 · 双击重命名`}
                      >
                        <span
                          className={cn(
                            'block truncate text-xs font-medium',
                            c.id === activeId ? 'text-accent' : 'text-foreground',
                          )}
                        >
                          {c.title || '新会话'}
                        </span>
                        <span className="mt-0.5 block text-2xs text-muted-foreground/70">
                          {c.messages.length} 条消息 · {formatRelativeTime(c.updatedAt)}
                        </span>
                      </button>
                    )}
                    <div className="flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingSession(c.id);
                          setEditTitle(c.title);
                        }}
                        className="rounded-md p-1 text-muted-foreground/60 opacity-0 transition-opacity hover:bg-card hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                        title="重命名会话"
                        aria-label="重命名会话"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      {confirmDeleteSession === c.id ? (
                        <button
                          type="button"
                          onClick={() => {
                            deleteConversation(c.id);
                            setConfirmDeleteSession(null);
                          }}
                          className="shrink-0 rounded-md px-1.5 py-0.5 text-2xs font-medium text-destructive transition-colors hover:bg-destructive/10"
                          title="再次点击确认删除该会话"
                        >
                          确认删除？
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setConfirmDeleteSession(c.id);
                            window.setTimeout(() => {
                              setConfirmDeleteSession((cur) => (cur === c.id ? null : cur));
                            }, 5000);
                          }}
                          className="rounded-md p-1 text-muted-foreground/60 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
                          title="删除会话"
                          aria-label="删除会话"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              {conversations.length === 0 && (
                <div className="flex flex-col items-center gap-1.5 px-3 py-10 text-center">
                  <MessagesSquare className="h-5 w-5 text-muted-foreground/40" />
                  <p className="text-xs text-muted-foreground">还没有会话</p>
                  <p className="text-2xs text-muted-foreground/60">新建一个，或者直接在输入框说你要什么。</p>
                </div>
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
        {undoHistoryOpen && (
          <div className="absolute inset-0 z-20 flex flex-col bg-card">
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setUndoHistoryOpen(false)}
                title="返回聊天"
                aria-label="返回聊天"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm font-semibold text-foreground">撤销中心</span>
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-2xs tabular-nums text-muted-foreground">
                {undoHistory.length} 步
              </span>
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
                <div className="flex flex-col items-center gap-1.5 px-3 py-10 text-center">
                  <Undo2 className="h-5 w-5 text-muted-foreground/40" />
                  <p className="text-xs text-muted-foreground">还没有可撤销的操作</p>
                  <p className="max-w-[240px] text-2xs leading-4 text-muted-foreground/70">
                    Agent 每次整理、以及你手工确认的删除，都会在这里留下一步；删除类操作不支持回退，会标出原因。
                  </p>
                </div>
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
                      'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left transition-colors',
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
                  className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-lg border border-border px-2 py-2 text-2xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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


    </div>
  );
}

/** 空状态：介绍 + 建议 + 可执行入口（不做"吉祥物"，用清晰的动作卡片说话） */
function EmptyState({
  chips,
  onChip,
  configured,
  autoOrganize,
  petLine,
  digest,
  habit,
  suggestion,
  onAcceptHabit,
  onDeclineHabit,
}: {
  chips: QuickChip[];
  onChip: (prompt: string) => void;
  configured: boolean;
  /** 自动整理是否开启：关掉时不该在这里承诺「我会自动归类」 */
  autoOrganize: boolean;
  /** 一条事实驱动的小提示（没有可说的就是 null，不要编） */
  petLine: string | null;
  /** 今天的自动整理摘要（今天没整理时是 null） */
  digest: { organized: number; failed: number; undoable: number } | null;
  /** 待确认的习惯候选（一次只问一条） */
  habit: HabitCandidate | null;
  suggestion: Suggestion | null;
  onAcceptHabit: (text: string) => Promise<void>;
  onDeclineHabit: (text: string) => Promise<void>;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center overflow-y-auto px-5 py-8">
      <div className="w-full max-w-[300px] space-y-4">
        <div className="flex flex-col items-center gap-2.5 text-center">
          <span
            aria-hidden="true"
            className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent-muted text-accent"
          >
            <BookMarked className="h-5 w-5" strokeWidth={2.1} />
          </span>
          <div>
            <p className="text-sm font-semibold text-foreground">我是你的书签管家</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              让我整理、扫描、清理收藏夹。直接说你要什么，或从下面挑一个开始。
            </p>
          </div>
          {!configured && (
            <button
              type="button"
              onClick={() => void chrome.runtime.openOptionsPage()}
              className="rounded-lg border border-accent/30 bg-accent-muted px-3 py-1.5 text-2xs font-medium text-accent transition-colors hover:bg-accent/15"
            >
              尚未配置 AI 服务，点击前往设置 →
            </button>
          )}
        </div>

        {digest && (
          <button
            type="button"
            data-testid="agent-digest"
            onClick={() => document.dispatchEvent(new CustomEvent('markai:open-organize-log'))}
            className="group flex w-full items-center gap-2.5 rounded-xl border border-border bg-muted/30 p-2.5 text-left transition-colors hover:border-accent/30 hover:bg-muted/50"
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent-muted text-accent">
              <Wand2 className="h-3 w-3" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-2xs font-medium text-foreground">今天自动整理 {digest.organized} 条</span>
              <span className="mt-0.5 block truncate text-2xs text-muted-foreground">
                {digest.failed > 0 ? `${digest.failed} 条失败 · ` : ''}
                {digest.undoable > 0 ? `可撤销 ${digest.undoable} 步` : '暂无可撤销的步骤'}
              </span>
            </span>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-foreground" />
          </button>
        )}

        {suggestion && (
          /*
           * 主动建议：一句具体可做的事，带「开始」。
           * 绝不自动执行——点「开始」只是把它当成一句话发给 Agent，
           * 真正改书签仍然走既有的逐次确认。
           */
          <div
            data-testid="pet-suggestion"
            className="rounded-xl border border-accent/25 bg-accent-muted/60 p-3 text-left"
          >
            <p className="flex items-center gap-1.5 text-2xs font-medium text-accent">
              <Sparkles className="h-3 w-3" />
              我注意到一件事
            </p>
            <p className="mt-1 text-xs leading-5 text-foreground">{suggestion.text}</p>
            <div className="mt-2 flex items-center gap-1.5">
              <Button size="sm" variant="secondary" onClick={() => onChip(suggestion.prompt)}>
                开始
              </Button>
              <span className="text-2xs text-muted-foreground">会先征求你确认</span>
            </div>
          </div>
        )}

        {habit && (
          /*
           * 习惯候选：一次只问一条，且必须能拒绝。
           * 拒绝要真的生效（30 天内不再问），否则"可以拒绝"只是摆设。
           */
          <div data-testid="habit-candidate" className="rounded-xl border border-border bg-card p-3 text-left">
            <p className="text-2xs leading-4 text-muted-foreground">要我记住这句话吗？</p>
            <p className="mt-1 text-xs leading-5 text-foreground">「{habit.text}」</p>
            <div className="mt-2 flex items-center gap-1.5">
              <Button size="sm" variant="secondary" onClick={() => void onAcceptHabit(habit.text)}>
                记住
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void onDeclineHabit(habit.text)}>
                不用
              </Button>
            </div>
          </div>
        )}

        {!suggestion && petLine && (
          <p
            data-testid="pet-line"
            className="flex items-start justify-center gap-1.5 text-center text-2xs leading-4 text-muted-foreground"
          >
            <Sparkles className="mt-px h-3 w-3 shrink-0 text-accent/70" aria-hidden="true" />
            <span>{petLine}</span>
          </p>
        )}

        <div className="space-y-1.5">
          {chips.map((chip) => (
            <button
              key={chip.label}
              type="button"
              disabled={chip.disabled}
              title={chip.title}
              onClick={() => onChip(chip.prompt)}
              className="group flex w-full items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-accent/40 hover:bg-muted/40 disabled:pointer-events-none disabled:opacity-40"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-muted text-accent">
                <chip.icon className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 flex-1 text-xs font-medium text-foreground">{chip.label}</span>
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-foreground" />
            </button>
          ))}
        </div>

        {/* 能力告知：自动整理发生在后台，新人不会自己发现它，更不会去翻 README */}
        {autoOrganize && (
          <p className="flex items-start gap-1.5 text-left text-2xs leading-4 text-muted-foreground/70">
            <Wand2 className="mt-px h-3 w-3 shrink-0 text-accent/70" aria-hidden="true" />
            <span>
              收藏任意网页后我会自动归类。想知道动了哪些、或撤销某一步，点顶栏
              <span className="text-muted-foreground">「整理」</span>。
            </span>
          </p>
        )}
      </div>
    </div>
  );
}
