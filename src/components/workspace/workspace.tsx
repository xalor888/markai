import { Clock, PanelLeftOpen, Search, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAIStore } from '@/stores/aiStore';
import { resolveTitlePath, useBookmarkStore } from '@/stores/bookmarkStore';
import { pushToast } from '@/lib/toast';
import { flushStreamPersist } from '@/stores/aiStore';
import { openUrl } from '@/lib/open-url';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { BrandMark } from '@/components/theme/theme-provider';
import { MoreMenu } from '@/components/workspace/more-menu';
import { CommandPalette } from '@/components/command/command-palette';
import { ChatPanel } from '@/components/chat/chat-panel';
import { BookmarkTree, ContextMenuOverlay } from '@/components/sidebar/bookmark-tree';
import { BookmarkList } from '@/components/bookmark-list/bookmark-list';
import { BookmarkDialogs } from '@/components/bookmark-list/bookmark-dialogs';
import { DeletionsDialog } from '@/components/deletions/deletions-dialog';
import { OrganizeLogDialog } from '@/components/organize/organize-log-dialog';
import { ConfirmHost } from '@/components/common/confirm-host';
import { OnboardingTip } from '@/components/common/onboarding-tip';
import { ShortcutsDialog } from '@/components/common/shortcuts-dialog';
import { ErrorBoundary } from '@/components/common/error-boundary';
import { useUIStore } from '@/stores/uiStore';
import { CHAT_WIDTH_MAX, CHAT_WIDTH_MAX_COMPACT, clampChatWidth } from '@/lib/chat-width';
import {
  clearSearchHistory,
  readSearchHistory,
} from '@/lib/search/history';

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
  /** ⌘K 命令面板：一个入口做三件事（搜书签 / 跳文件夹 / 执行动作） */
  const [commandOpen, setCommandOpen] = useState(false);
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
        // full 模式是宽屏三分栏，树应当常驻；compact 才需要"默认收起、用时展开"
        if (mode === 'full') useUIStore.setState({ treeCollapsed: false });
        else if (typeof saved === 'boolean') useUIStore.setState({ treeCollapsed: saved });
      })
      .catch(() => {});
  }, []);
  const pendingCount = useAIStore((s) => s.pendingDeletions.filter((p) => p.status === 'pending').length);
  // 顶栏唯一搜索框：树与列表都读它
  const searchQuery = useBookmarkStore((s) => s.searchQuery);
  const setSearchQuery = useBookmarkStore((s) => s.setSearchQuery);
  /** 搜索框聚焦态 + 最近搜索（仅本地，展示 5 条） */
  const [searchFocused, setSearchFocused] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);

  // 查询被清空而输入框仍聚焦时，也要刷新最近搜索（只靠 onFocus 会漏掉"清空后继续看"）
  useEffect(() => {
    if (!searchFocused || searchQuery.trim()) return;
    setRecentSearches(readSearchHistory());
  }, [searchFocused, searchQuery]);
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

  /*
   * 页面要离开时，把正在流式生成的内容强制落一次盘。
   *
   * 侧边栏一关、页面一切走，这个文档就销毁了；节流落盘最多有个 800ms 的窗口，
   * 这里补一次「临走前的最后一笔」，把丢失量压到最小。
   * `pagehide` 比 `beforeunload` 可靠：它在 bfcache / 移动端也会触发。
   */
  useEffect(() => {
    const flush = () => flushStreamPersist();
    window.addEventListener('pagehide', flush);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  /*
   * ⌘K / Ctrl+K：命令面板。
   * 这是「找东西」的主路径——重做前要找一条书签得先想"它在哪个文件夹"，再一层层点开。
   */
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandOpen((v) => !v);
        return;
      }
      // ?：快捷键速查（输入框内不劫持，因为问号本身是合法输入）
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const el = e.target as HTMLElement | null;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
        e.preventDefault();
        setShortcutsOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /*
   * 命令面板里点「打开整理记录 / 待删除清单 / 快捷键」时，用自定义事件转交过来。
   * 为什么不直接把 setState 传进去：面板的数据源只依赖 roots，
   * 传一堆回调会让它每次渲染都重建整个结果集（400 条书签的扁平化）。
   */
  useEffect(() => {
    const onOrganize = () => {
      setOrganizeLogOpen(true);
      setOrganizeAlert(false);
    };
    const onDeletions = () => setDeletionsOpen(true);
    const onShortcuts = () => setShortcutsOpen(true);
    document.addEventListener('markai:open-organize-log', onOrganize);
    document.addEventListener('markai:open-deletions', onDeletions);
    document.addEventListener('markai:open-shortcuts', onShortcuts);
    return () => {
      document.removeEventListener('markai:open-organize-log', onOrganize);
      document.removeEventListener('markai:open-deletions', onDeletions);
      document.removeEventListener('markai:open-shortcuts', onShortcuts);
    };
  }, []);

  /*
   * Ctrl/Cmd+D：把当前页面收藏进来（原生浏览器习惯，也是空态提示里承诺的）。
   *
   * 提示文案从 0.2.x 起就写着「或按 Ctrl+D 把当前页面收藏进来」，
   * 但**代码里从来没有这个处理器**——用户照着提示按下去，什么都没发生。
   * 这是文案承诺了却不存在的行为，属于产品缺陷而不是测试缺口。
   *
   * 预填不用自己写：create-bookmark 对话框打开时会自己读活动标签页
   * （见 bookmark-dialogs.tsx 的 prefillFromTab）。
   */
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'd' && e.key !== 'D') return;
      if (!e.ctrlKey && !e.metaKey) return;
      const el = e.target as HTMLElement | null;
      if (el && typeof el.closest === 'function' && el.closest('input, textarea, select, [contenteditable="true"]')) {
        return; // 输入框里的 Ctrl+D 是浏览器/编辑器自己的行为，不劫持
      }
      e.preventDefault();
      useUIStore.getState().openDialog({
        kind: 'create-bookmark',
        parentId: useBookmarkStore.getState().selectedFolderId ?? '',
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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

  // 命令面板的「收藏当前页面」：用事件转交，避免把 async 动作塞进面板数据层
  useEffect(() => {
    const onSave = () => void saveCurrentTab();
    document.addEventListener('markai:save-current-tab', onSave);
    return () => document.removeEventListener('markai:save-current-tab', onSave);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏 */}
      {/*
       * 窄屏（320px = 侧边栏最小宽度）策略：**左侧可滚动、右侧固定**。
       * 整条顶栏一起滚动时，「整理 / AI 设置」会被推出去、必须横向滑动才够得到；
       * 而这两个是最常用的入口。所以把右侧按钮组拆出来 shrink-0，让它永远在视口内。
       */}
      <header
        data-testid="topbar"
        className="flex h-14 min-w-0 shrink-0 items-center gap-3 border-b border-border bg-card px-4"
      >
        <BrandMark />
        {/*
         * 唯一的搜索框：同时过滤书签树与列表。
         * 重做前这里有两个（树的「过滤树…」与列表的「搜索书签…」），用户不知道该用哪个，
         * 而且两个框各管一半，搜出来的结果永远不完整。
         */}
        <div className="relative mx-auto w-full max-w-[520px] min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            id="markai-search"
            data-testid="search"
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setSearchQuery('');
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder="搜索书签与文件夹…"
            aria-label="搜索书签与文件夹"
            spellCheck={false}
            onFocus={() => {
              setSearchFocused(true);
              setRecentSearches(readSearchHistory());
            }}
            onBlur={() => {
              // 给"点最近搜索"留出 mousedown→click 的时间；直接失焦会先卸载面板
              window.setTimeout(() => setSearchFocused(false), 120);
            }}
            className="h-9 w-full rounded-lg border border-border bg-background pr-16 pl-9 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 hover:border-input focus:border-ring focus:bg-card focus-visible:ring-2 focus-visible:ring-ring/20 [&::-webkit-search-cancel-button]:hidden"
          />
          {!searchQuery && (
            <kbd className="pointer-events-none absolute top-1/2 right-2.5 hidden -translate-y-1/2 items-center gap-0.5 rounded-xs border border-border bg-muted/60 px-1.5 py-0.5 font-sans text-2xs text-muted-foreground/70 sm:flex">
              ⌘K
            </kbd>
          )}
          {/* 最近搜索：只在聚焦且输入为空时出现；点一条即填回搜索框 */}
          {searchFocused && !searchQuery && recentSearches.length > 0 && (
            <div
              data-testid="search-recent"
              className="markai-glass markai-glass-liquid animate-fade-in absolute top-full right-0 left-0 z-30 mt-1 rounded-lg p-1"
            >
              <div className="flex items-center justify-between px-2 py-1">
                <span className="flex items-center gap-1 text-2xs text-muted-foreground">
                  <Clock className="h-3 w-3" />
                  最近搜索
                </span>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    clearSearchHistory();
                    setRecentSearches([]);
                  }}
                  className="rounded-xs px-1 py-0.5 text-2xs text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
                >
                  清除
                </button>
              </div>
              {recentSearches.map((q) => (
                <button
                  key={q}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setSearchQuery(q);
                    setSearchFocused(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-muted"
                >
                  <Search className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="truncate">{q}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {/*
            待处理数量放在顶栏：抽屉与「更多」菜单里都藏着它，
            用户只有主动去找才知道"有 3 条等你确认"。
          */}
          {pendingCount > 0 && (
            <button
              type="button"
              onClick={() => setDeletionsOpen(true)}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-2xs font-medium text-destructive transition-colors hover:bg-destructive/15"
              title="查看待删除清单"
            >
              <Trash2 className="h-3 w-3" />
              <span className="hidden sm:inline">待处理</span>
              {pendingCount}
            </button>
          )}
          {/* 其余入口全收进「更多」：有待删/整理异常时触发按钮上带红点，收起来不等于藏起来 */}
          <MoreMenu
            pendingCount={pendingCount}
            organizeAlert={organizeAlert}
            chatOpen={chatOpen}
            mode={mode}
            onToggleChat={() => setChatOpen((v) => !v)}
            onDeletions={() => setDeletionsOpen(true)}
            onOrganize={() => {
              setOrganizeLogOpen(true);
              setOrganizeAlert(false);
            }}
            onSettings={() => void chrome.runtime.openOptionsPage()}
            onShortcuts={() => setShortcutsOpen(true)}
            onHealth={() =>
              void chrome.tabs.create({ url: chrome.runtime.getURL('options.html#health') }).catch(() => {
                void chrome.runtime.openOptionsPage();
              })
            }
            onSwitchContainer={() => {
              if (mode === 'full') void openSidePanel();
              else openFullPage();
            }}
            onSaveCurrentTab={() => void saveCurrentTab()}
          />
        </div>
      </header>

      {/*
        主体三栏。

        `overflow-hidden` 不是装饰：compact 模式下 Agent 面板是右侧抽屉，收起时
        `translate-x-full` 把它整体平移到容器右外侧。它虽然 pointer-events-none，
        却仍然撑出 320px 的文档横向滚动——用户能把整个应用横向拖进一片空白
        （实测 document.scrollWidth - clientWidth = 320）。
        打开态锚在 right-0 向内生长，永远在容器内，所以剪不到它。
      */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {mode === 'full' ? (
          /*
           * 宽度必须挂在**真实的盒子**上，不能挂在 ErrorBoundary 上。
           *
           * ErrorBoundary 正常渲染时是 `display: contents`（为了错误态之外零布局影响），
           * 这层盒子根本不存在——写在它身上的 `w-56 shrink-0` 会被整条丢弃。
           * 树于是退回「按内容撑宽」：书签库里有哪怕一条超长标题，
           * 树的 max-content 就会顶到视口宽度，把中栏挤成 0、把 Agent 面板顶出
           * `overflow-hidden` 的可视区——整页看起来就是「只剩一棵撑满全屏的树」，
           * 而且没有任何东西能把它缩回去（实测 5128px 树 / 0px 列表）。
           */
          <div className="flex w-56 min-w-0 shrink-0 flex-col overflow-hidden">
            <ErrorBoundary area="书签树">
              <BookmarkTree className="h-full min-w-0 border-r border-border" />
            </ErrorBoundary>
          </div>
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
          /*
           * 展开态 = **浮层盖在列表上**，而不是挤压列表宽度。
           *
           * 重做前树常驻 176–200px：410px 宽的侧边栏里，中栏只剩两百多像素，标题全被截断，
           * 用户看到的一屏就是"三行文件夹 + 一大片空白"。现在列表永远占满宽度，
           * 需要导航时才把树浮出来，点空白处（或选中文件夹）就收起。
           */
          <>
            <div
              className="absolute inset-0 z-20 bg-foreground/5"
              onClick={() => setTreeCollapsed(true)}
              aria-hidden="true"
            />
            {/*
             * 树也要有自己的边界。
             * 它的渲染直接消费 chrome.bookmarks 的返回形状——一次丢字段就足够让它抛错；
             * 而它没有被边界包住时，抛错的后果是**整个工作区被卸载**（白屏），
             * 连带列表和 Agent 面板一起消失。现在最坏情况只是"树这块坏了，其余照常"。
             */}
            <div className="absolute inset-y-0 left-0 z-30 w-52 min-w-0">
              <ErrorBoundary area="书签树">
                <BookmarkTree
                  collapsible
                  className="animate-fade-in h-full border-r border-border bg-card shadow-lg"
                />
              </ErrorBoundary>
            </div>
          </>
        )}
        {/* 一个面板渲染出错不该让整个工作区白屏：中栏与 Agent 面板各包一层边界 */}
        <ErrorBoundary area="书签列表" className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/*
           * 这一层 div 不是多余的：ErrorBoundary 正常时渲染 display:contents（为了零布局影响），
           * 它的子元素会被「穿透」成根 flex-row 的直接子节点——提示条一旦落在那一层就会被挤成竖条。
           * 显式给一个 flex-col 容器，提示条才真的在列表下方。
           */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <BookmarkList compact={mode === 'compact'} className="min-w-0 flex-1" />
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
          /*
            侧边栏：Agent 面板为右侧抽屉，位移动画（移出视口时不可交互）。

            `w-full` 不是多余的：里面 ChatPanel 用 `maxWidth: min(100%, 560px)` 想把自己
            钳在侧栏宽度内，但抽屉与内层容器原本都没有定宽（靠内容收缩适应），
            百分比在收缩适应下解析为 auto，钳制**完全失效**。
            实测：侧栏拖到 300px 时抽屉仍是 320px，左边 20px 被 overflow-hidden 切掉；
            260px 时切掉 60px——输入框左侧和左对齐控件直接看不见又点不到。
            给定宽后 `100%` 有了解析基准；`translate-x-full` 移动的是自身全宽，收起态不变。
          */
          <div
            className={cn(
              'absolute inset-y-0 right-0 z-20 w-full transition-transform duration-150',
              chatOpen ? 'translate-x-0' : 'pointer-events-none translate-x-full',
            )}
          >
            <div className="relative h-full w-full">
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
      <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
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
