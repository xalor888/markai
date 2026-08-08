import { BookmarkPlus, LayoutPanelLeft, Maximize, MessageSquare, Settings, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAIStore } from '@/stores/aiStore';
import { resolveTitlePath, useBookmarkStore } from '@/stores/bookmarkStore';
import { pushToast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { BrandMark, ThemeToggle } from '@/components/theme/theme-provider';
import { ChatPanel } from '@/components/chat/chat-panel';
import { BookmarkTree, ContextMenuOverlay } from '@/components/sidebar/bookmark-tree';
import { BookmarkList } from '@/components/bookmark-list/bookmark-list';
import { BookmarkDialogs } from '@/components/bookmark-list/bookmark-dialogs';
import { DeletionsDialog } from '@/components/deletions/deletions-dialog';

/**
 * 工作区根组件（侧边栏 / 完整页共用）：
 * - compact：树 + 列表双栏，Agent 面板为右侧抽屉（Arc 风格）
 * - full：经典三分栏 IDE（树 | 列表 | Agent 面板固定右栏）
 * initialDeletionsOpen：挂载时直接打开待删清单（popup「去处理」入口直达）
 */
export function Workspace({ mode, initialDeletionsOpen = false }: { mode: 'compact' | 'full'; initialDeletionsOpen?: boolean }) {
  // 侧边栏空间有限，Agent 抽屉默认收起（点击展开）；完整页默认展开
  const [chatOpen, setChatOpen] = useState(mode === 'full');
  const [deletionsOpen, setDeletionsOpen] = useState(initialDeletionsOpen);
  // 聊天面板宽度（用户可拖拽调整，持久化到 storage）
  const [chatWidth, setChatWidth] = useState(mode === 'full' ? 360 : 320);
  useEffect(() => {
    void chrome.storage.local
      .get('markai.ui.chatWidth')
      .then((d) => {
        const w = d['markai.ui.chatWidth'] as number | undefined;
        if (typeof w === 'number' && w >= 200 && w <= 640) setChatWidth(w);
      })
      .catch(() => {});
  }, []);
  const persistChatWidth = (w: number) => {
    setChatWidth(w);
    void chrome.storage.local.set({ 'markai.ui.chatWidth': w }).catch(() => {});
  };
  /** 左缘拖拽手柄：向左拖变宽（完整页右栏 / 侧边栏抽屉共用） */
  const [dragging, setDragging] = useState(false);
  const pendingCount = useAIStore((s) => s.pendingDeletions.filter((p) => p.status === 'pending').length);
  const streaming = useAIStore((s) => s.streaming);
  const messages = useAIStore((s) => s.messages);
  const activeId = useAIStore((s) => s.activeId);
  // 抽屉收起期间的新消息未读数（打开时重置）
  // 首次挂载时消息尚未从 storage 载入（初始为 []），等历史加载完成后再初始化基数，
  // 避免把已有历史全部误计为「未读」
  const [lastSeenCount, setLastSeenCount] = useState(messages.length);
  const seenInitialized = useRef(false);
  useEffect(() => {
    if (!seenInitialized.current && messages.length > 0) {
      seenInitialized.current = true;
      setLastSeenCount(messages.length);
    }
  }, [messages]);
  useEffect(() => {
    if (chatOpen) setLastSeenCount(messages.length);
  }, [chatOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  // 切换会话时重设未读基数：新会话的历史不属于「未读」，
  // 否则换到消息更多的会话会出现幽灵徽标
  useEffect(() => {
    seenInitialized.current = true;
    setLastSeenCount(messages.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);
  const unread = chatOpen ? 0 : Math.max(0, messages.length - lastSeenCount);

  // 侧边栏模式：右键「让 MarkAI 整理/分析」等触发流式时，自动展开抽屉展示进度
  useEffect(() => {
    if (streaming && mode === 'compact' && !chatOpen) setChatOpen(true);
  }, [streaming, mode, chatOpen]);

  const openFullPage = () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('page.html') }).catch(() => {});
  };

  /** 打开浏览器侧边栏（完整页用户可切回紧凑工作区） */
  const openSidePanel = async () => {
    const win = await chrome.windows.getCurrent();
    if (win.id !== undefined) {
      await chrome.runtime.sendMessage({ type: 'sidepanel:open', windowId: win.id }).catch(() => {});
    }
  };

  /** 收藏当前活动标签页（带重复检测，存入当前选中文件夹或书签栏） */
  const saveCurrentTab = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url;
    if (!url || !/^https?:\/\//i.test(url)) {
      pushToast('当前页面无法收藏', { description: '仅支持 http/https 页面。', variant: 'destructive' });
      return;
    }
    try {
      const existing = await chrome.bookmarks.search(url);
      // search 是子串匹配，这里精确比对 URL 避免误报
      const exact = existing.find((n) => n.url === url);
      if (exact) {
        pushToast('该页面已在收藏夹中', { description: exact.title || url });
        return;
      }
      const folderId = useBookmarkStore.getState().selectedFolderId ?? undefined;
      await chrome.bookmarks.create({ parentId: folderId, title: tab.title || url, url });
      const folderTitle = folderId
        ? resolveTitlePath(useBookmarkStore.getState().roots, folderId)
        : '书签栏';
      pushToast('已收藏当前页面', { description: `存入「${folderTitle}」`, variant: 'success' });
      void useBookmarkStore.getState().loadTree();
    } catch (e) {
      pushToast('收藏失败', { description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏 */}
      <header className="relative flex h-10 shrink-0 items-center gap-1.5 border-b border-border bg-card px-2">
        {/* 顶栏底部：品牌色淡出分隔线 */}
        <span className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-indigo-500/40 via-border to-transparent" />
        <BrandMark />
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void saveCurrentTab()}
          title="收藏当前页面"
          aria-label="收藏当前页面"
        >
          <BookmarkPlus className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={cn('ml-1 h-7 gap-1', pendingCount > 0 ? 'text-destructive' : 'text-muted-foreground')}
          onClick={() => setDeletionsOpen(true)}
          title="待删除清单"
        >
          <Trash2 className="h-3.5 w-3.5" />
          待删
          {pendingCount > 0 && (
            <span className="flex h-4 min-w-4 items-center justify-center rounded-sm bg-destructive/10 px-1 text-[11px] font-medium text-destructive">
              {pendingCount}
            </span>
          )}
        </Button>

        <div className="ml-auto flex items-center gap-0.5">
          {mode === 'compact' && (
            <Button variant="ghost" size="icon" onClick={openFullPage} title="在完整页面打开" aria-label="在完整页面打开">
              <Maximize className="h-3.5 w-3.5" />
            </Button>
          )}
          {mode === 'full' && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void openSidePanel()}
              title="在侧边栏打开"
              aria-label="在侧边栏打开"
            >
              <LayoutPanelLeft className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setChatOpen((v) => !v)}
            title={chatOpen ? '收起 Agent 面板' : '展开 Agent 面板'}
            aria-label={chatOpen ? '收起 Agent 面板' : '展开 Agent 面板'}
            className={chatOpen ? 'bg-accent-muted text-accent' : 'relative'}
          >
            <MessageSquare className="h-3.5 w-3.5" />
            {/* 抽屉收起期间的新消息未读数 */}
            {unread > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 text-[9px] font-medium text-white">
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </Button>
          <ThemeToggle />
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void chrome.runtime.openOptionsPage()}
            title="AI 设置"
            aria-label="AI 设置"
          >
            <Settings className="h-3.5 w-3.5" />
          </Button>
        </div>
      </header>

      {/* 主体三栏 */}
      <div className="relative flex min-h-0 flex-1">
        <BookmarkTree className={mode === 'full' ? 'w-56 shrink-0 border-r border-border' : 'w-44 shrink-0 border-r border-border'} />
        <BookmarkList compact={mode === 'compact'} className="min-w-0 flex-1" />

        {mode === 'full' ? (
          /* 完整页：右栏宽度可拖拽调整，收起时平滑收窄 */
          <div
            className={cn(
              'relative shrink-0 overflow-hidden',
              chatOpen && !dragging && 'transition-[width] duration-150',
            )}
            style={{ width: chatOpen ? chatWidth : 0 }}
          >
            {chatOpen && (
              <ChatResizeHandle
                onDragStart={() => setDragging(true)}
                onDragEnd={() => setDragging(false)}
                onResize={(dx) => persistChatWidth(Math.min(Math.max(chatWidth + dx, 200), 640))}
              />
            )}
            <ChatPanel className={cn('h-full w-full border-l border-border', !chatOpen && 'border-l-0')} focusOnMount={chatOpen} />
          </div>
        ) : (
          /* 侧边栏：Agent 面板为右侧抽屉，位移动画（移出视口时不可交互） */
          <div
            className={cn(
              'absolute inset-y-0 right-0 z-20 transition-transform duration-150',
              chatOpen ? 'translate-x-0' : 'pointer-events-none translate-x-full',
            )}
          >
            <div className="relative h-full">
              {chatOpen && (
                <ChatResizeHandle
                  onDragStart={() => setDragging(true)}
                  onDragEnd={() => setDragging(false)}
                  onResize={(dx) => persistChatWidth(Math.min(Math.max(chatWidth + dx, 200), 560))}
                />
              )}
              <ChatPanel
                className="h-full border-l border-border"
                style={{ width: chatWidth, maxWidth: 'min(100%, 560px)' }}
                focusOnMount={chatOpen}
              />
            </div>
          </div>
        )}
      </div>

      {/* 浮层：右键菜单、书签管理对话框、全局待删清单 */}
      <ContextMenuOverlay />
      <BookmarkDialogs />
      <DeletionsDialog open={deletionsOpen} onOpenChange={setDeletionsOpen} />
    </div>
  );
}

/** 聊天面板左缘拖拽手柄（调整面板宽度；指针捕获保证拖出窗外也能正确收尾） */
function ChatResizeHandle({
  onResize,
  onDragStart,
  onDragEnd,
}: {
  onResize: (dx: number) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const startXRef = useRef(0);
  const activeRef = useRef(false);
  return (
    <div
      className="group absolute inset-y-0 left-0 z-30 w-1 cursor-col-resize"
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        // 指针捕获：鼠标拖出窗口后仍能收到 pointerup，避免 dragging 卡死
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        startXRef.current = e.clientX;
        activeRef.current = true;
        onDragStart();
      }}
      onPointerMove={(e) => {
        if (!activeRef.current) return;
        // 向左拖（x 减小）→ 面板变宽
        onResize(startXRef.current - e.clientX);
      }}
      onPointerUp={() => {
        activeRef.current = false;
        onDragEnd();
      }}
      onLostPointerCapture={() => {
        // 兜底：任何原因失去捕获都结束拖拽（不残留 dragging 状态）
        if (activeRef.current) {
          activeRef.current = false;
          onDragEnd();
        }
      }}
    >
      {/* 视觉基线 + hover 强调（细线不占宽度） */}
      <div className="absolute inset-y-0 left-0 w-px bg-border transition-colors group-hover:bg-accent/50" />
    </div>
  );
}
