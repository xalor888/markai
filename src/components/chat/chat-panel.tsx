import {
  ArrowDown,
  Bot,
  Download,
  FolderTree,
  MessagesSquare,
  Pencil,
  Plus,
  RotateCcw,
  ScanSearch,
  Search,
  Send,
  Settings,
  Square,
  Trash2,
  TrendingUp,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useAIStore } from '@/stores/aiStore';
import { useBookmarkStore, findNode, resolveTitlePath } from '@/stores/bookmarkStore';
import { useConfigStore } from '@/stores/configStore';
import { formatRelativeTime } from '@/lib/format';
import { resolveConfig, PROVIDERS } from '@/lib/providers';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { BrandMark } from '@/components/theme/theme-provider';
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
  const send = useAIStore((s) => s.send);
  const cancel = useAIStore((s) => s.cancel);
  const clearMessages = useAIStore((s) => s.clearMessages);
  const retryLast = useAIStore((s) => s.retryLast);
  const conversations = useAIStore((s) => s.conversations);
  const activeId = useAIStore((s) => s.activeId);
  const createConversation = useAIStore((s) => s.createConversation);
  const switchConversation = useAIStore((s) => s.switchConversation);
  const renameConversation = useAIStore((s) => s.renameConversation);
  const deleteConversation = useAIStore((s) => s.deleteConversation);
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
  const [editingSession, setEditingSession] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [sessionQuery, setSessionQuery] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 稳定引用：MessageView 已 memo，重试回调需保持引用不变
  const handleRetry = useCallback(() => retryLast(), [retryLast]);

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
    a.download = `MarkAI-对话-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    // 延迟释放，避免下载被中断
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className={cn('flex h-full min-h-0 flex-col bg-card', className)} style={style}>
      {/* 头部：紧凑单行，文件夹/模型截断显示，不互相挤压 */}
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-2.5">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-accent text-white">
          <Bot className="h-3 w-3" strokeWidth={2.2} />
        </span>
        <span className="shrink-0 text-xs font-medium text-foreground">Agent</span>
        {streaming ? (
          <span
            className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent"
            title="正在生成回复…"
          />
        ) : (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success/70" title="就绪" />
        )}
        <span className="mx-0.5 h-3 w-px shrink-0 bg-border" />
        {/* 当前上下文文件夹（Agent 的操作范围提示，占剩余宽度，点击可在树中定位） */}
        {selectedFolderId && folderTitle && (
          <button
            type="button"
            onClick={() => useBookmarkStore.getState().revealInTree(selectedFolderId)}
            className="min-w-0 flex-1 truncate rounded-sm px-1 text-left text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title={`当前上下文：${folderTitle}（点击在树中定位）`}
          >
            {folderTitle}
          </button>
        )}
        {config.model && (
          <button
            type="button"
            onClick={() => void chrome.runtime.openOptionsPage()}
            className="max-w-[35%] shrink truncate rounded-sm px-1 text-[11px] text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
            title={`当前模型：${config.model}（点击修改配置）`}
          >
            {config.model}
          </button>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
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
          <Button
            variant="ghost"
            size="icon"
            title="AI 设置"
            aria-label="AI 设置"
            onClick={() => void chrome.runtime.openOptionsPage()}
          >
            <Settings className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* 消息区 */}
      <div className="relative min-h-0 flex-1">
        {/* 会话管理面板（覆盖消息区） */}
        {sessionsOpen && (
          <div className="absolute inset-0 z-20 flex flex-col bg-card">
            <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-2.5">
              <Button variant="ghost" size="icon" onClick={() => setSessionsOpen(false)} title="返回聊天" aria-label="返回聊天">
                <ArrowDown className="h-3.5 w-3.5 rotate-180" />
              </Button>
              <span className="text-xs font-medium text-foreground">会话</span>
              <span className="text-[11px] text-muted-foreground">{conversations.length} 个</span>
            </div>
            {/* 会话搜索（会话多时快速定位） */}
            <div className="relative border-b border-border px-2.5 py-1.5">
              <Search className="absolute top-1/2 left-[19px] h-3 w-3 -translate-y-1/2 text-muted-foreground" />
              <input
                value={sessionQuery}
                onChange={(e) => setSessionQuery(e.target.value)}
                placeholder="搜索会话…"
                className="h-7 w-full rounded-sm border border-input bg-card pr-1.5 pl-6 text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {/* 最近活跃的会话置顶（支持标题搜索过滤） */}
              {[...conversations]
                .sort((a, b) => b.updatedAt - a.updatedAt)
                .filter((c) => !sessionQuery.trim() || c.title.toLowerCase().includes(sessionQuery.trim().toLowerCase()))
                .map((c) => (
                <div
                  key={c.id}
                  className={cn(
                    'group relative flex items-center gap-1.5 rounded-sm px-2 py-1.5',
                    c.id === activeId ? 'bg-accent-muted' : 'hover:bg-muted/60',
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
                      <p className="text-[10px] text-muted-foreground/60">
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
                    className="shrink-0 rounded-sm p-1 text-muted-foreground/60 opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
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
                      className="shrink-0 rounded-sm px-1.5 py-0.5 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/10"
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
                      className="shrink-0 rounded-sm p-1 text-muted-foreground/60 opacity-0 transition-opacity hover:bg-muted hover:text-destructive group-hover:opacity-100"
                      title="删除会话"
                      aria-label="删除会话"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ))}
              {conversations.length === 0 && (
                <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">还没有会话</p>
              )}
            </div>
            <div className="border-t border-border p-1.5">
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
        <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto px-3 py-3">
          {messages.length === 0 ? (
            <EmptyState chips={chips} onChip={(p) => void send(p)} configured={chatConfigured} />
          ) : (
            <div className="space-y-3">
              {messages.map((m, i) => (
                <div key={m.id}>
                  {/* 与上一条消息间隔较长时显示时间分隔（长会话导航） */}
                  {i > 0 && m.createdAt - messages[i - 1]!.createdAt > 10 * 60_000 && (
                    <div className="mb-3 flex items-center gap-2">
                      <span className="h-px flex-1 bg-border" />
                      <span className="text-[10px] text-muted-foreground/60">{formatClock(m.createdAt)}</span>
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
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <Bot className="h-3 w-3 animate-pulse text-accent" />
                    Agent 正在思考…
                  </div>
                )}
            </div>
          )}
        </div>
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
      <div className="shrink-0 border-t border-border p-2.5">
        {/* 快捷指令（对话中也可一键触发；流式时隐藏） */}
        {!streaming && messages.length > 0 && (
          <div className="mb-1.5 flex flex-wrap items-center gap-x-0.5">
            <span className="mr-0.5 text-[11px] text-muted-foreground/60">快捷：</span>
            {chips.map((chip) => (
              <button
                key={chip.label}
                type="button"
                disabled={chip.disabled}
                title={chip.title}
                onClick={() => void send(chip.prompt)}
                className="rounded-sm px-1.5 py-0.5 text-[11px] text-accent transition-colors hover:bg-accent-muted disabled:pointer-events-none disabled:opacity-40"
              >
                {chip.label}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-1.5">
          <Textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onInput={(e) => autoGrow(e.currentTarget)}
            onKeyDown={onKeyDown}
            placeholder={streaming ? 'Agent 正在回复…' : '与 MarkAI 对话，例如「帮我把技术类书签整理一下」'}
            rows={1}
            className="max-h-24 min-h-8 flex-1"
          />
          {streaming ? (
            <Button variant="secondary" size="icon" onClick={cancel} title="停止生成" aria-label="停止生成">
              <Square className="h-3 w-3" />
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
                >
                  <X className="h-3 w-3" />
                </Button>
              )}
              <Button
                size="icon"
                disabled={!input.trim()}
                onClick={submit}
                title="发送"
                aria-label="发送"
                className="h-8 w-8"
              >
                <Send className="h-3 w-3" />
              </Button>
            </>
          )}
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
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
        description="将删除全部聊天记录（不影响书签与待删除清单）。"
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
}: {
  chips: QuickChip[];
  onChip: (prompt: string) => void;
  configured: boolean;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-4 text-center">
      <BrandMark size="md" />
      <p className="max-w-[240px] text-xs leading-5 text-muted-foreground">
        我是你的书签管家。可以聊天让我整理、扫描、清理书签，也可以从下方快捷指令开始。
      </p>
      {!configured && (
        <button
          type="button"
          onClick={() => void chrome.runtime.openOptionsPage()}
          className="rounded-sm px-2 py-1 text-[11px] text-accent transition-colors hover:bg-accent-muted"
        >
          尚未配置 AI 服务，点击前往设置 →
        </button>
      )}
      <div className="flex flex-col gap-1.5">
        {chips.map((chip) => (
          <Button
            key={chip.label}
            variant="outline"
            size="sm"
            disabled={chip.disabled}
            title={chip.title}
            onClick={() => onChip(chip.prompt)}
          >
            <chip.icon className="h-3 w-3" />
            {chip.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
