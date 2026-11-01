import {
  BookmarkPlus,
  Clock,
  Keyboard,
  LayoutPanelLeft,
  Maximize,
  MessageSquare,
  PanelLeftOpen,
  Settings,
  Trash2,
  Wand2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAIStore } from '@/stores/aiStore';
import { resolveTitlePath, useBookmarkStore } from '@/stores/bookmarkStore';
import { pushToast } from '@/lib/toast';
import { openUrl } from '@/lib/open-url';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { BrandMark, ThemeToggle } from '@/components/theme/theme-provider';
import { ChatPanel } from '@/components/chat/chat-panel';
import { BookmarkTree, ContextMenuOverlay } from '@/components/sidebar/bookmark-tree';
import { BookmarkList } from '@/components/bookmark-list/bookmark-list';
import { TimelinePanel } from '@/components/bookmark-list/timeline-panel';
import { BookmarkDialogs } from '@/components/bookmark-list/bookmark-dialogs';
import { DeletionsDialog } from '@/components/deletions/deletions-dialog';
import { OrganizeLogDialog } from '@/components/organize/organize-log-dialog';
import { ConfirmHost } from '@/components/common/confirm-host';
import { OnboardingTip } from '@/components/common/onboarding-tip';
import { ShortcutsDialog } from '@/components/common/shortcuts-dialog';
import { ErrorBoundary } from '@/components/common/error-boundary';
import { useUIStore } from '@/stores/uiStore';
import { CHAT_WIDTH_MAX, CHAT_WIDTH_MAX_COMPACT, clampChatWidth } from '@/lib/chat-width';

/**
 * 工作区根组件（侧边栏 / 完整页共用）：
 * - compact：树 + 列表双栏，Agent 面板为右侧抽屉（Arc 风格）
 * - full：经典三分栏 IDE（树 | 列表 | Agent 面板固定右栏）
 * initialDeletionsOpen：挂载时直接打开待删清单（popup「去处理」入口直达）
 */
export function Workspace({
  mode,
  initialDeletionsOpen = false,
  initialOrganizeOpen = false,
}: {
  mode: 'compact' | 'full';
  initialDeletionsOpen?: boolean;
  initialOrganizeOpen?: boolean;
}) {
  // 侧边栏空间有限，Agent 抽屉默认收起（点击展开）；完整页默认展开
  const [chatOpen, setChatOpen] = useState(mode === 'full');
  const [deletionsOpen, setDeletionsOpen] = useState(initialDeletionsOpen);
  // 整理记录：自动整理是后台行为，用户需要一个随时能翻账的地方
  const [organizeLogOpen, setOrganizeLogOpen] = useState(initialOrganizeOpen);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  /** 有「需要留意」的整理失败，入口上挂一个小红点（打开记录后清除） */
  const [organizeAlert, setOrganizeAlert] = useState(false);
  // 聊天面板宽度（用户可拖拽调整，持久化到 storage）
  const [chatWidth, setChatWidth] = useState(mode === 'full' ? 360 : 320);
  /**
   * 宽度上限按形态区分：侧边栏本身只有四百来像素，放 640 的抽屉会盖住整屏。
   * 三处曾各写一套值（加载 200–640、完整页拖 200–640、侧边栏拖 200–560），
   * 于是"在完整页调到 640 再打开侧边栏"会得到一个内部 640 / 视觉 560 的面板，
   * 拖拽起点还会跳一下。现在只有这一份口径。
   */
  const chatWidthMax = mode === 'full' ? CHAT_WIDTH_MAX : CHAT_WIDTH_MAX_COMPACT;
  /** 权威宽度：拖拽中只改 state/ref，**松手才落盘**（原先每个 pointermove 写一次 storage） */
  const chatWidthRef = useRef(chatWidth);
  const applyChatWidth = (w: number) => {
    const next = clampChatWidth(w, chatWidthMax);
    chatWidthRef.current = next;
    setChatWidth(next);
  };
  useEffect(() => {
    void chrome.storage.local
      .get('markai.ui.chatWidth')
      .then((d) => {
        const w = d['markai.ui.chatWidth'] as number | undefined;
        // 读到的值可能来自另一种形态（640 在侧边栏里放不下）：按当前形态重新钳制
        if (typeof w === 'number' && Number.isFinite(w)) applyChatWidth(w);
      })
      .catch(() => {});
    // applyChatWidth 只依赖 chatWidthMax，闭包每次渲染重建是刻意的（要拿到最新上限）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatWidthMax]);
  /** 松手时落盘（拖拽过程中零写入） */
  const commitChatWidth = () => {
    void chrome.storage.local.set({ 'markai.ui.chatWidth': chatWidthRef.current }).catch(() => {});
  };
  /** 左缘拖拽手柄：向左拖变宽（完整页右栏 / 侧边栏抽屉共用） */
  const [dragging, setDragging] = useState(false);
  // 拖拽起点宽度：ChatResizeHandle 回传的是「相对起点的累计位移」，必须基于拖拽开始时的宽度计算，
  // 不能用不断更新的 chatWidth + 累计位移（会把中间已累加的位移重复计入，越拖越宽）
  const chatWidthBase = useRef(chatWidth);
  // 紧凑模式：树可收起成图标条（侧边栏只有四百来像素，树占 176 后中栏标题全被截断）
  const treeCollapsed = useUIStore((s) => s.treeCollapsed);
  const setTreeCollapsed = useUIStore((s) => s.setTreeCollapsed);
  useEffect(() => {
    void chrome.storage.local
      .get('markai.ui.treeCollapsed')
      .then((d) => {
        const saved = d['markai.ui.treeCollapsed'];
        if (typeof saved === 'boolean') useUIStore.setState({ treeCollapsed: saved });
      })
      .catch(() => {});
  }, []);
  const mainView = useUIStore((s) => s.mainView);
  const setMainView = useUIStore((s) => s.setMainView);
  // 树里选了文件夹（**包括点的就是当前已选中的那个**）= 想看这个文件夹的内容：
  // 时间线自动让位回列表，避免「点了没反应」。
  // 用计数而不是比较 selectedFolderId：同一文件夹再次点击时值不变，
  // 只比值的写法会正好漏掉用户最常走的那条路径（T77 回归）。
  const folderSelectTick = useBookmarkStore((s) => s.folderSelectTick);
  useEffect(() => {
    if (folderSelectTick === 0) return; // 首次挂载 / 恢复上次选中不算用户操作
    if (useUIStore.getState().mainView === 'timeline') setMainView('list');
  }, [folderSelectTick, setMainView]);
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

  // 新书签自动整理的结果：后台完成后主动告知（成功/失败都可见，静默跳过的不打扰）
  useEffect(() => {
    const onMessage = (msg: {
      type?: string;
      ok?: boolean;
      detail?: string;
      burst?: boolean;
      kind?: string;
    }) => {
      if (msg?.type !== 'markai:auto-organized') return;
      const ok = msg.ok === true;
      // AI 连续失败进入冷却：不是「整理失败」，是「暂时不问模型」，用普通提示说清
      if (msg.kind === 'ai-cooldown') {
        pushToast('AI 分类暂时停用', { description: msg.detail, variant: 'default' });
        return;
      }
      // 免打扰造成的跳过不是失败：给一次轻提示解释「为什么这次没整理」，不挂红点
      if (msg.kind === 'optout') {
        pushToast('这个站点已停用自动整理', {
          description: msg.detail,
          variant: 'default',
        });
        return;
      }
      // 失败不只是弹一次 toast：入口上留一个红点，用户回头还能看到
      if (!ok && !msg.burst) setOrganizeAlert(true);
      pushToast(ok ? '已自动整理新书签' : msg.burst ? '本次未自动整理' : '自动整理未完成', {
        description: msg.detail,
        variant: ok ? 'success' : msg.burst ? 'default' : 'destructive',
      });
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, []);

  // 「?」打开快捷键速查：界面上不看文档也能发现这些键
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== '?') return;
      // 事件靶点不一定是元素（可能是 window / document）；直接调 closest 会抛错，
      // 那样「按 ? 没反应」会变成静默失败，很难查。
      const el = e.target as HTMLElement | null;
      if (el && typeof el.closest === 'function' && el.closest('input, textarea, select, [contenteditable="true"]')) {
        // 输入框里打问号是正常输入，不劫持
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      setShortcutsOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openFullPage = () => {
    void openUrl(chrome.runtime.getURL('page.html'));
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
      {/*
       * 窄屏（320px = 侧边栏最小宽度）策略：**左侧可滚动、右侧固定**。
       * 整条顶栏一起滚动时，「整理 / AI 设置」会被推出去、必须横向滑动才够得到；
       * 而这两个是最常用的入口。所以把右侧按钮组拆出来 shrink-0，让它永远在视口内。
       */}
      <header className="relative flex h-11 min-w-0 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
        {/* 顶栏底部：品牌色淡出分隔线 */}
        <span className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-accent/40 via-border to-transparent" />
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
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
          className={cn('h-8 gap-1.5 px-2', pendingCount > 0 ? 'text-destructive' : 'text-muted-foreground')}
          onClick={() => setDeletionsOpen(true)}
          title="待删除清单"
        >
          <Trash2 className="h-4 w-4" />
          <span className="max-[560px]:hidden">待删</span>
          {pendingCount > 0 && (
            <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive/10 px-1.5 text-2xs font-semibold text-destructive">
              {pendingCount}
            </span>
          )}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className={cn('relative h-8 gap-1.5 px-2', organizeLogOpen ? 'bg-accent-muted text-accent' : 'text-muted-foreground')}
          onClick={() => {
            setOrganizeLogOpen(true);
            setOrganizeAlert(false);
          }}
          title="整理记录：自动整理做了哪些事、能否重试"
        >
          <Wand2 className="h-4 w-4" />
          {mode === 'full' && <span className="max-[560px]:hidden">整理</span>}
          {organizeAlert && (
            <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-destructive ring-2 ring-card" aria-hidden="true" />
          )}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className={cn('h-8 gap-1.5 px-2', mainView === 'timeline' ? 'bg-accent-muted text-accent' : 'text-muted-foreground')}
          onClick={() => setMainView(mainView === 'timeline' ? 'list' : 'timeline')}
          title={mainView === 'timeline' ? '返回文件夹列表' : '时间线：按收藏时间浏览全部书签（不含文件夹）'}
          aria-pressed={mainView === 'timeline'}
        >
          <Clock className="h-4 w-4" />
          {mode === 'full' && <span className="max-[560px]:hidden">时间线</span>}
        </Button>

        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1">
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
              <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 text-2xs font-medium text-accent-foreground ring-2 ring-card">
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </Button>
          {mode === 'full' && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setShortcutsOpen(true)}
              title="快捷键与操作（?）"
              /* 极窄屏让位：顶栏放不下，先收次要入口 */
              aria-label="快捷键与操作"
            >
              <Keyboard className="h-3.5 w-3.5" />
            </Button>
          )}
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
        {mode === 'full' ? (
          <BookmarkTree className="w-56 shrink-0 border-r border-border" />
        ) : treeCollapsed ? (
          /* 收起态：只留一条 36px 的操作条，中栏拿回宽度 */
          <div className="animate-fade-in flex w-9 shrink-0 flex-col items-center border-r border-border bg-card pt-2">
            <button
              type="button"
              onClick={() => setTreeCollapsed(false)}
              className="rounded-sm p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="展开书签树"
              aria-label="展开书签树"
            >
              <PanelLeftOpen className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          // 极窄屏（320px 是侧边栏最小宽度）把树压窄：176px 的树 + 中栏在这个宽度下会撑出横向滚动条
          // overflow-hidden：窄到放不下时宁可裁掉树头部的次要图标，也不要让它盖住中栏
          <BookmarkTree
            collapsible
            className="w-44 max-[359px]:w-32 shrink-0 overflow-hidden border-r border-border"
          />
        )}
        {/* 一个面板渲染出错不该让整个工作区白屏：中栏与 Agent 面板各包一层边界 */}
        <ErrorBoundary area="书签列表" className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/*
           * 这一层 div 不是多余的：ErrorBoundary 正常时渲染 display:contents（为了零布局影响），
           * 它的子元素会被「穿透」成根 flex-row 的直接子节点——提示条一旦落在那一层就会被挤成竖条。
           * 显式给一个 flex-col 容器，提示条才真的在列表下方。
           */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {mainView === 'timeline' ? (
              <TimelinePanel className="min-w-0 flex-1" />
            ) : (
              <BookmarkList compact={mode === 'compact'} className="min-w-0 flex-1" />
            )}
            {/* 首次打开的三步提示：底部一条可跳过的横幅，不做遮罩导览——
                顶栏图标不显眼，但把界面压暗、还要点三下才能用，对「只想赶紧整理一下」的人是净负担。 */}
            <OnboardingTip onGoOrganize={() => setOrganizeLogOpen(true)} />
          </div>
        </ErrorBoundary>

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
                onDragStart={() => {
                  chatWidthBase.current = chatWidth;
                  setDragging(true);
                }}
                onDragEnd={() => {
                  setDragging(false);
                  commitChatWidth();
                }}
                onResize={(dx) => applyChatWidth(chatWidthBase.current + dx)}
              />
            )}
            <ErrorBoundary area="Agent 面板" className="h-full">
              <ChatPanel className={cn('h-full w-full border-l border-border', !chatOpen && 'border-l-0')} focusOnMount={chatOpen} />
            </ErrorBoundary>
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
                  onDragStart={() => {
                    chatWidthBase.current = chatWidth;
                    setDragging(true);
                  }}
                  onDragEnd={() => {
                    setDragging(false);
                    commitChatWidth();
                  }}
                  onResize={(dx) => applyChatWidth(chatWidthBase.current + dx)}
                />
              )}
              <ErrorBoundary area="Agent 面板" className="h-full">
                <ChatPanel
                  className="h-full border-l border-border"
                  style={{ width: chatWidth, maxWidth: `min(100%, ${CHAT_WIDTH_MAX_COMPACT}px)` }}
                  focusOnMount={chatOpen}
                />
              </ErrorBoundary>
            </div>
          </div>
        )}
      </div>

      {/* 浮层：右键菜单、书签管理对话框、全局待删清单 */}
      <ContextMenuOverlay />
      <BookmarkDialogs />
      <DeletionsDialog open={deletionsOpen} onOpenChange={setDeletionsOpen} />
      <OrganizeLogDialog open={organizeLogOpen} onOpenChange={setOrganizeLogOpen} />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <ConfirmHost />
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
