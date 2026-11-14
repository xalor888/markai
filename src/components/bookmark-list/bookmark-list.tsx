import { AlertCircle, RefreshCw, Loader2, ChevronDown, Clock, ArrowDownUp, BookmarkPlus, Copy, ExternalLink, Folder, FolderInput, FolderOpen, FolderPlus, LayoutDashboard, LayoutList, Link2, LocateFixed, MoreHorizontal, Search, Settings2, Sparkles, Tag, Trash2, X } from 'lucide-react';
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { useAIStore } from '@/stores/aiStore';
import { useBookmarkStore, copyNodeDeep, findNode, buildFolderChildCounts, resolveTitlePath, type TreeContextMenu } from '@/stores/bookmarkStore';
import { useUIStore } from '@/stores/uiStore';
import { copyText } from '@/lib/clipboard';
import { formatRelativeTime, getHost } from '@/lib/format';
import { isSelfOrDescendant, resolveDropIndex } from '@/lib/bookmark-dnd';
import { createDelayedOpen } from '@/lib/bookmarks/delayed-open';
import { pushToast } from '@/lib/toast';
import { openUrl, openUrls } from '@/lib/open-url';
import { describeBulk } from '@/lib/bookmarks/bulk';
import { TimelinePanel } from '@/components/bookmark-list/timeline-panel';
import { OverviewPanel } from '@/components/bookmark-list/overview-panel';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Favicon } from '@/components/common/favicon';
import { Input } from '@/components/ui/input';
import { ORGANIZE_LABEL } from '@/lib/ui/labels';
import { recordSearch } from '@/lib/search/history';
import { flattenBookmarks } from '@/lib/bookmarks/timeline';
import { TagsManagerDialog } from './tags-manager-dialog';
import { colorForTag, colorVarOf, readTagColors, type TagColorMap } from '@/lib/bookmarks/tag-colors';
import {
  collectTagCounts,
  idsForTag,
  normalizeTag,
  pruneTagMap,
  readTagMap,
  saveTagMap,
  type TagMap,
} from '@/lib/bookmarks/tags';

type BNode = chrome.bookmarks.BookmarkTreeNode;

/** 排序方式（原生书签管理器风格） */
type SortKey = 'manual' | 'title' | 'url' | 'dateAdded' | 'dateLastUsed' | 'time';

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'manual', label: '原始顺序' },
  { value: 'title', label: '按名称' },
  { value: 'url', label: '按地址' },
  { value: 'dateAdded', label: '按添加时间' },
  { value: 'dateLastUsed', label: '按最近使用' },
  /*
   * 「按收藏时间」= 原来的时间线：**跨文件夹**列出全部书签、按天分组。
   * 它不再是顶栏的一个独立视图按钮——切视图会丢上下文，而且用户得先想起来去点它。
   * 现在只是排序里的一项，选中即生效。
   */
  { value: 'time', label: '收藏时间' },
];

/**
 * 书签列表（中栏）：当前文件夹内容 / 搜索结果。
 * 原生交互：完整右键菜单、排序、键盘导航（↑↓ Enter Delete Ctrl+A）、多选交给 Agent。
 * compact：侧边栏窄布局下隐藏排序控件，避免工具栏溢出。
 */
export function BookmarkList({ className, compact = false }: { className?: string; compact?: boolean }) {
  const roots = useBookmarkStore((s) => s.roots);
  /*
   * 加载失败也要在中栏说一声。
   *
   * 早先只有书签树里显示「书签加载失败 + 重试」，而**侧边栏的树默认是收起的**
   * （0.2.35 起的紧凑布局），于是加载失败时用户看到的是一个空列表，
   * 既不知道出了错，也没有重试入口——表现就是"书签全没了"。
   */
  const loadError = useBookmarkStore((s) => s.loadError);
  const treeLoading = useBookmarkStore((s) => s.loading);
  const selectedFolderId = useBookmarkStore((s) => s.selectedFolderId);
  const selectedIds = useBookmarkStore((s) => s.selectedBookmarkIds);
  /**
   * 选中集合的 O(1) 索引。
   *
   * 列表每渲染一行都要判断"这行选没选中"，直接 `selectedIds.includes(id)` 是 O(n×m)：
   * 1200 条全选时等于 144 万次比较，且铺在渲染热路径上。集合只随 selectedIds 变，
   * 用 useMemo 建一次即可。
   */
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const toggleSelect = useBookmarkStore((s) => s.toggleSelect);
  const selectMany = useBookmarkStore((s) => s.selectMany);
  const clearSelection = useBookmarkStore((s) => s.clearSelection);
  const setContextMenu = useBookmarkStore((s) => s.setContextMenu);
  const send = useAIStore((s) => s.send);
  const openDialog = useUIStore((s) => s.openDialog);

  const [children, setChildren] = useState<BNode[] | null>(null);
  /** 子项加载失败的原因（真失败，不是删除/移动竞态） */
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<BNode[] | null>(null);
  /**
   * 搜索失败的原因。
   *
   * 原先这里是 `.catch(() => {})`：失败后 `searchResults` 仍为 null，
   * 而 `loading = searchResults === null` —— **列表会永远停在「加载中…」**，
   * 既没有错误也没有重试。搜索框打字不响应，看起来像卡死。
   */
  const [searchErr, setSearchErr] = useState<string | null>(null);
  /** 搜索重试计数：变化时重新触发防抖 effect */
  const [searchTick, setSearchTick] = useState(0);
  /*
   * 搜索词只有一个来源：`bookmarkStore.searchQuery`（顶栏那个唯一的搜索框写入）。
   * 重做前列表自己维护一份 state、树再维护一份，两边各搜一半——用户永远搜不全。
   */
  const query = useBookmarkStore((s) => s.searchQuery);
  /** 输入 `#标签` 走本地标签表（搜索框优先于标签条） */
  const hashTag = query.trim().startsWith('#') ? normalizeTag(query.trim().slice(1)) : '';
  const setQuery = useBookmarkStore((s) => s.setSearchQuery);
  const [sortBy, setSortBy] = useState<SortKey>('manual');
  /** 概览：第三视图（书签库状态 + 管家建议），不写书签 */
  const [overview, setOverview] = useState(false);

  // 进入某个文件夹或搜索结果时自动回到列表：概览是"库级"视图，不该盖住具体上下文
  useEffect(() => {
    if (!overview) return;
    if (selectedFolderId || query) setOverview(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFolderId, query]);

  /** 概览 → 全部列表 */
  const showLibraryList = () => {
    setOverview(false);
    useBookmarkStore.getState().selectFolder(null);
  };
  /** 概览 → 按添加时间看整个库（"今天新增"点进来必须有东西） */
  const showToday = () => {
    setOverview(false);
    useBookmarkStore.getState().selectFolder(null);
    setSortBy('dateAdded');
  };

  /*
   * 命令面板的「视图」动作通过自定义事件切过来：面板与列表不在同一棵子树里，
   * 把 setState 传进去会让面板每次渲染重建整个结果集（400+ 条书签的扁平化）。
   */
  useEffect(() => {
    const onView = (e: Event) => {
      const mode = (e as CustomEvent<string>).detail;
      if (mode === 'overview') setOverview(true);
      else if (mode === 'list') {
        setOverview(false);
        setSortBy('manual');
      } else if (mode === 'timeline') {
        setOverview(false);
        setSortBy('time');
      }
    };
    document.addEventListener('markai:view', onView as EventListener);
    return () => document.removeEventListener('markai:view', onView as EventListener);
  }, []);

  /*
   * ⌘/Ctrl + 1/2/3 直接切视图（概览 / 列表 / 时间线）。
   * 只在非输入态生效：用户正在搜索框里敲字时，⌘1 不该把视图切走。
   * 与工具栏的三个分段是同一组语义，键盘用户不必去点按钮。
   */
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.closest('select'))) return;
      if (e.key !== '1' && e.key !== '2' && e.key !== '3') return;
      e.preventDefault();
      if (e.key === '1') setOverview(true);
      if (e.key === '2') {
        setOverview(false);
        setSortBy('manual');
      }
      if (e.key === '3') {
        setOverview(false);
        setSortBy('time');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null);
  /** 多选操作条的「更多」弹出菜单 */
  const [selectionMenuOpen, setSelectionMenuOpen] = useState(false);
  /** 标签：id -> tags；activeTag 为 null 表示不筛选 */
  const [tagMap, setTagMap] = useState<TagMap>({});
  const [tagColors, setTagColors] = useState<TagColorMap>({});
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [tagsManagerOpen, setTagsManagerOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // 加载当前文件夹子项（roots 变化 = 书签结构变更 → 重新拉取；切回浏览模式时也重拉）
  useEffect(() => {
    if (!selectedFolderId || query.trim()) {
      setChildren(null);
      setLoadErr(null);
      return;
    }
    let cancelled = false;
    setLoadErr(null);
    void chrome.bookmarks
      .getChildren(selectedFolderId)
      .then((c) => {
        if (!cancelled) setChildren(c);
      })
      .catch((e: unknown) => {
        /* 原先这里是 `catch(() => {})`：删除/移动竞态的拒绝确实该忽略，
         * 但**真失败**（文件夹已不存在、权限问题）也会被一起吞掉——
         * 那时 children 保持 null，界面永远停在「加载中…」，没有重试也没有错误提示。
         * 现在标记出来，至少让用户能看到发生了什么并能重试。 */
        if (!cancelled) {
          setChildren([]);
          setLoadErr(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedFolderId, roots, query]);

  // 切换文件夹时清空搜索词与排序（回到默认浏览状态）
  useEffect(() => {
    if (selectedFolderId) {
      setQuery('');
      setSortBy('manual');
      setActiveIndex(-1);
      setAnchorIndex(null);
    }
  }, [selectedFolderId]);

  // 切换文件夹/搜索词时滚动回顶部，避免新内容较短时残留空白
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [selectedFolderId, query]);

  // 搜索（防抖）
  useEffect(() => {
    if (!query.trim()) {
      setSearchResults(null);
      return;
    }
    // `#标签` 走本地标签表，不去 chrome.bookmarks.search 里搜一个带 # 的字符串
    if (hashTag) {
      setSearchResults(null);
      setSearchErr(null);
      return;
    }
    let cancelled = false;
    setSearchErr(null);
    const timer = setTimeout(() => {
      void chrome.bookmarks
        .search(query.trim())
        .then((r) => {
          if (cancelled) return;
          setSearchResults(r.slice(0, 100));
          setSearchErr(null);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          // 必须退出「加载中」：给空结果 + 明确的错误，而不是让它一直转
          setSearchResults([]);
          setSearchErr(e instanceof Error ? e.message : String(e));
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, searchTick, hashTag]);

  /*
   * 「按收藏时间」是**跨文件夹的全部书签**。此时用户点树里某个文件夹，
   * 意思显然是想看那个文件夹——继续停在时间线会让人觉得"点了没反应"。
   * 所以一旦切换文件夹，就自动退回普通排序。
   */
  /*
   * 用 `folderSelectTick`（每次点文件夹都 +1）而不是比较 id：
   * 用户点的往往就是**当前已选中**的那个文件夹（「书签栏」），id 不变，
   * 只比 id 的写法会正好漏掉最常走的那条路径 —— 表现就是"点了没反应"。
   */
  const folderSelectTick = useBookmarkStore((s) => s.folderSelectTick);
  useEffect(() => {
    if (folderSelectTick === 0) return; // 首次挂载 / 恢复上次选中不算用户操作
    setSortBy((cur) => (cur === 'time' ? 'manual' : cur));
    // 点文件夹 = 想看那个文件夹；标签筛选是全局视图，继续留着会让人以为"点了没反应"
    setActiveTag(null);
  }, [folderSelectTick]);

  const tagCounts = useMemo(() => collectTagCounts(tagMap), [tagMap]);

  useEffect(() => {
    if (!activeTag) return;
    if (!tagCounts.some((t) => t.tag === activeTag.toLowerCase())) setActiveTag(null);
  }, [activeTag, tagCounts]);
  const effectiveTag = hashTag || activeTag;
  const taggedNodes = useMemo(() => {
    if (!effectiveTag) return null;
    const ids = idsForTag(tagMap, effectiveTag);
    if (ids.size === 0) return [];
    const out: NonNullable<typeof children> = [];
    for (const item of flattenBookmarks(roots)) {
      if (!ids.has(item.id)) continue;
      const node = findNode(roots, item.id);
      if (node) out.push(node);
    }
    return out;
  }, [effectiveTag, tagMap, roots]);

  const browsing = !query.trim();
  const rawItems = effectiveTag ? taggedNodes : browsing ? children : searchResults;
  // 排序（搜索模式下保持原生相关度顺序；文件夹始终置顶）
  const items = useMemo(() => {
    if (!rawItems) return null;
    if (!browsing || sortBy === 'manual') return rawItems;
    const list = [...rawItems];
    const keyOf = (n: BNode): string => {
      switch (sortBy) {
        case 'title':
          return n.title || '';
        case 'url':
          // 剥离协议前缀，避免按 https/http 分组
          return (n.url || '').replace(/^https?:\/\//i, '');
        default:
          return '';
      }
    };
    list.sort((a, b) => {
      // 文件夹优先：`a.url ? 1 : 0` → 文件夹取 0、书签取 1，相减为负 → 文件夹在前。
      // 写成 `(b.url…) - (a.url…)` 会反过来把书签排在文件夹之前（与注释相反的静默反向）。
      const folderDiff = (a.url ? 1 : 0) - (b.url ? 1 : 0);
      if (folderDiff !== 0) return folderDiff;
      if (sortBy === 'dateAdded') return (b.dateAdded ?? 0) - (a.dateAdded ?? 0);
      if (sortBy === 'dateLastUsed') return (b.dateLastUsed ?? 0) - (a.dateLastUsed ?? 0);
      // 自然数字排序：v2.0 排在 v10.0 前（版本号书签友好）
      return keyOf(a).localeCompare(keyOf(b), 'zh', { numeric: true });
    });
    return list;
  }, [rawItems, sortBy, browsing]);

  /** 搜索结果分组：索引必须与应用排序后的 `items` 对齐，否则组头会插在错误的行前 */
  const folderResultCount = useMemo(
    () => (browsing ? 0 : (items ?? []).filter((n) => !n.url).length),
    [browsing, items],
  );
  const firstBookmarkResult = useMemo(
    () => (browsing ? -1 : (items ?? []).findIndex((n) => !!n.url)),
    [browsing, items],
  );

  // 未选中文件夹时不显示加载态（展示引导文案），避免无限「加载中…」
  const loading = browsing
    ? children === null && !!selectedFolderId
    : hashTag
      ? false
      : searchResults === null;

  // 文件夹子项数：中栏的行来自 getChildren()（浏览）或 search()（搜索），这两种返回的节点
  // **都不带 children**——只有 getTree()/getSubTree() 会填充（详见 buildFolderChildCounts）。
  // 直接读 node.children 会让每个文件夹恒显示「0 项」，所以子项数一律由整棵树推导。
  const folderCounts = useMemo(() => buildFolderChildCounts(roots), [roots]);

  const selectedNodes = useMemo(
    () => selectedIds.map((id) => findNode(roots, id)).filter((n): n is BNode => !!n),
    [selectedIds, roots],
  );

  useEffect(() => {
    if (selectedIds.length === 0) setSelectionMenuOpen(false);
  }, [selectedIds.length]);

  // 标签读取 + 变更刷新 + 删除书签后的孤儿清理
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void readTagMap().then((m) => {
        if (alive) setTagMap(m);
      });
      void readTagColors().then((c) => {
        if (alive) setTagColors(c);
      });
    };
    refresh();
    const onChanged = () => refresh();
    document.addEventListener('markai:tags-changed', onChanged);
    return () => {
      alive = false;
      document.removeEventListener('markai:tags-changed', onChanged);
    };
  }, []);

  useEffect(() => {
    void readTagMap().then((map) => {
      const valid = new Set(flattenBookmarks(roots).map((item) => item.id));
      const { next, removed } = pruneTagMap(map, valid);
      if (removed > 0) {
        void saveTagMap(next).then(() => setTagMap(next));
      } else setTagMap(map);
    });
  }, [roots]);

  // 输入搜索时退出标签筛选，避免"搜了却没反应"
  useEffect(() => {
    if (query.trim()) setActiveTag(null);
  }, [query]);

  // 键盘导航：高亮项滚动到可视区
  useEffect(() => {
    if (activeIndex >= 0 && listRef.current) {
      const el = listRef.current.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
      el?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  // 列表内容变化后夹紧高亮索引（如删除后）
  useEffect(() => {
    if (items && activeIndex >= items.length) setActiveIndex(-1);
  }, [items, activeIndex]);

  // 内容变化后清理失效的 Shift 范围锚点
  useEffect(() => {
    if (anchorIndex !== null && items && anchorIndex >= items.length) setAnchorIndex(null);
  }, [items, anchorIndex]);

  /** 点击列表任意非控件区域时聚焦容器，让 ↑↓/Enter/Delete 立即可用 */
  const focusList = (e: MouseEvent) => {
    if (!(e.target as HTMLElement).closest('button, input, select, a')) {
      listRef.current?.focus({ preventScroll: true });
    }
  };

  const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      // 优先清空多选（与原生书签管理器一致），其次清搜索/高亮
      if (selectedIds.length > 0) {
        clearSelection();
        return;
      }
      if (query) onQueryChange('');
      else setActiveIndex(-1);
      return;
    }
    // 「/」聚焦搜索框（原生应用习惯；输入框内由浏览器接管）
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      document.getElementById('markai-search')?.focus();
      return;
    }
    if (!items || items.length === 0) return;
    const count = items.length;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        const next = Math.min(Math.max(activeIndex + delta, 0), count - 1);
        if (e.shiftKey) {
          // Shift+方向键：范围选择（首按以当前高亮为锚点）
          const anchor = anchorIndex ?? (activeIndex >= 0 ? activeIndex : 0);
          if (anchorIndex === null) setAnchorIndex(anchor);
          toggleRange(next, true, anchor);
        }
        setActiveIndex(next);
        break;
      }
      case 'Home':
        e.preventDefault();
        if (e.shiftKey) {
          const anchor = anchorIndex ?? (activeIndex >= 0 ? activeIndex : 0);
          if (anchorIndex === null) setAnchorIndex(anchor);
          toggleRange(0, true, anchor);
        }
        setActiveIndex(0);
        break;
      case 'End':
        e.preventDefault();
        if (e.shiftKey) {
          const anchor = anchorIndex ?? (activeIndex >= 0 ? activeIndex : 0);
          if (anchorIndex === null) setAnchorIndex(anchor);
          toggleRange(count - 1, true, anchor);
        }
        setActiveIndex(count - 1);
        break;
      case 'PageDown':
        e.preventDefault();
        setActiveIndex(Math.min(activeIndex + 10, count - 1));
        break;
      case 'PageUp':
        e.preventDefault();
        setActiveIndex(Math.max(activeIndex - 10, 0));
        break;
      case 'Enter': {
        const n = items[activeIndex >= 0 ? activeIndex : 0];
        if (!n) break;
        if (n.url) {
          // Shift+Enter：后台打开
          void openUrl(n.url, { active: !e.shiftKey });
        } else useBookmarkStore.getState().selectFolder(n.id);
        break;
      }
      case ' ':
        // 空格：切换高亮行的选中状态
        e.preventDefault();
        {
          const n = items[activeIndex >= 0 ? activeIndex : 0];
          if (n) toggleSelect(n.id);
        }
        break;
      case 'Delete': {
        // 多选时删除全部选中（原生书签管理器行为）；否则删除高亮项
        if (selectedIds.length > 0) {
          e.preventDefault();
          openDialog({ kind: 'delete-many', bookmarkIds: [...selectedIds] });
          break;
        }
        const n = items[activeIndex >= 0 ? activeIndex : 0];
        if (n) openDialog({ kind: 'delete', bookmarkId: n.id });
        break;
      }
      case 'F2': {
        e.preventDefault();
        const n = items[activeIndex >= 0 ? activeIndex : 0];
        if (n) openDialog({ kind: 'rename', bookmarkId: n.id });
        break;
      }
      case 'a':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          const picked = items.filter((n) => n.url).map((n) => n.id);
          selectMany(picked);
          /*
           * 搜索模式下列表有 100 条上限（见 setSearchResults 的 slice）。
           * 不说明的话，用户搜出 250 条、按 Ctrl+A 看到"已选 100 项"，
           * 会以为自己把全部匹配都选了——随后只删/搬动了其中 100 条。
           * 与「打开过多」那条提示同一立场：做了多少、还剩多少，都要说出来。
           */
          if (!browsing && (searchResults?.length ?? 0) >= 100) {
            pushToast(`已选 ${picked.length} 项`, {
              description: '搜索结果显示上限为 100 条，可能还有更多匹配项未被选中。可缩小关键词或到文件夹里全选。',
            });
          }
        }
        break;
      case 'c':
        // Ctrl+C：复制选中项网址（无多选时复制高亮行）
        if (e.ctrlKey || e.metaKey) {
          const targets =
            selectedIds.length > 0
              ? items.filter((n) => selectedSet.has(n.id) && n.url)
              : (() => {
                  const n = items[activeIndex >= 0 ? activeIndex : 0];
                  return n?.url ? [n] : [];
                })();
          if (targets.length > 0) {
            e.preventDefault();
            void copyText(targets.map((n) => n.url).join('\n'), `已复制 ${targets.length} 个网址`);
          }
        }
        break;
    }
  };

  // 多选 → 组织为 Agent 指令（超过 30 个时提示省略，避免误导）
  /** 打开全部搜索结果（去重，最多 25 个防刷屏） */
  const openSearchResults = () => {
    if (!searchResults) return;
    const urls: string[] = [];
    const seen = new Set<string>();
    for (const n of searchResults) {
      if (n.url && !seen.has(n.url)) {
        seen.add(n.url);
        urls.push(n.url);
      }
    }
    if (urls.length === 0) {
      pushToast('搜索结果没有可打开的网址');
      return;
    }
    const openCount = Math.min(urls.length, 25);
    if (urls.length > 25) pushToast(`结果过多，仅打开前 25 个（共 ${urls.length} 个）`);
    void openUrls(urls.slice(0, openCount));
  };

  /** 一键整理当前文件夹（快捷指令，与聊天 chips 同语义） */
  const organizeFolder = () => {
    if (!selectedFolderId) return;
    if (!findNode(useBookmarkStore.getState().roots, selectedFolderId)) {
      pushToast('文件夹已被删除，请重新选择', { variant: 'destructive' });
      return;
    }
    const folderTitle = resolveTitlePath(useBookmarkStore.getState().roots, selectedFolderId);
    void send(
      `请整理书签文件夹「${folderTitle}」：浏览其全部书签，创建合适的子分类，并把书签归类移动到位。`,
      { folderId: selectedFolderId },
    );
  };

  const runOrganizeSelected = () => {
    const shown = selectedNodes.slice(0, 30);
    const omitted = selectedNodes.length - shown.length;
    const list = shown
      .map((n, i) => `${i + 1}. ${n.title || n.url}${n.url ? ` (${n.url})` : ''} [id: ${n.id}]`)
      .join('\n');
    void send(
      `请整理我选中的 ${selectedNodes.length} 个书签${
        omitted > 0 ? `（以下仅列出前 30 个，其余 ${omitted} 个请通过 search_bookmarks 补齐）` : ''
      }：\n${list}\n创建合适的分类并归类移动（若不需要新建文件夹可直接移动），完成后简要汇报。`,
    );
    clearSelection();
  };

  const organizeSelected = () => {
    if (selectedNodes.length === 0) return;
    // 与树里右键「让 MarkAI 整理」保持一致：一次塞几百条要跑很久，先说明代价。
    // 用站内确认框而不是 `window.confirm`：后者在深色下是刺眼白框，也没法在 e2e 里断言。
    if (selectedNodes.length > 100) {
      useUIStore.getState().requestConfirm({
        title: '选中的书签比较多',
        body: `选中了 ${selectedNodes.length} 个书签，整理会逐条浏览、耗时较长。`,
        confirmText: '继续整理',
        onConfirm: runOrganizeSelected,
      });
      return;
    }
    runOrganizeSelected();
  };

  const openSelected = () => {
    // 重复 URL 去重，避免刷屏
    const urls: string[] = [];
    const seen = new Set<string>();
    for (const n of selectedNodes) {
      if (n.url && !seen.has(n.url)) {
        seen.add(n.url);
        urls.push(n.url);
      }
    }
    if (urls.length === 0) {
      pushToast('所选内容没有可打开的网址');
      return;
    }
    const openCount = Math.min(urls.length, 25);
    if (urls.length > 25) pushToast(`书签过多，仅打开前 25 个（共 ${urls.length} 个）`);
    void openUrls(urls.slice(0, openCount));
    clearSelection();
  };

  /** 批量复制选中项的网址（每行一个） */
  const copySelectedUrls = () => {
    const urls = selectedNodes.map((n) => n.url).filter((u): u is string => !!u);
    if (urls.length === 0) return;
    void copyText(urls.join('\n'), `已复制 ${urls.length} 个网址`);
  };

  /** 选择/取消（支持 Shift 范围多选：从锚点到当前行的区间；锚点保持最初位置，反向移动可收缩）。
   *  anchorOverride：键盘首按 Shift 时，setAnchorIndex 尚未生效（闭包读到旧值），
   *  由调用方显式传入本次锚点，避免误锚到 0（列表首行）。 */
  const toggleRange = useCallback(
    (index: number, shiftKey: boolean, anchorOverride?: number) => {
      if (!items) return;
      const node = items[index];
      if (!node) return;
      if (shiftKey) {
        const anchor = anchorOverride ?? anchorIndex ?? 0;
        // 重置为「仅区间内」的选择：整体替换，保证反向移动可收缩
        const [from, to] = anchor < index ? [anchor, index] : [index, anchor];
        const rangeIds = items.slice(from, to + 1).filter((n) => n.url).map((n) => n.id);
        useBookmarkStore.getState().replaceSelection(rangeIds);
        // 锚点不随移动更新（原生行为：锚点固定为首次按 Shift 的位置）
        return;
      }
      toggleSelect(node.id);
      setAnchorIndex(index);
    },
    [items, anchorIndex, toggleSelect, setAnchorIndex],
  );

  // ── 稳定行回调：BookmarkRow 已 memo，内联箭头每次渲染新建引用会使 memo 失效，
  //    大书签库（上千行）下滚动/刷新会重渲染全部行 ──
  const handleRenameRow = useCallback(
    (id: string) => openDialog({ kind: 'rename', bookmarkId: id }),
    [openDialog],
  );
  const handleToggleRow = useCallback((i: number, shiftKey: boolean) => toggleRange(i, shiftKey), [toggleRange]);
  const handleToggleClickRow = useCallback((i: number) => toggleRange(i, false), [toggleRange]);
  const handleActivateRow = useCallback((i: number) => setActiveIndex(i), []);
  /** 行内标签点击：走与标签条同一条筛选路径（清搜索、清多选） */
  const handleTagFilter = useCallback((tag: string) => {
    useBookmarkStore.getState().clearSelection();
    useBookmarkStore.getState().setSearchQuery('');
    setActiveTag(tag);
  }, []);

  const handleOpenRow = useCallback(
    (i: number, shiftKey: boolean) => {
      const n = items?.[i];
      if (!n) return;
      if (shiftKey) {
        toggleRange(i, true);
        return;
      }
      // 从搜索结果里真正打开了一项：这次查询值得记住（概览/下次搜索都能复用）
      const q = useBookmarkStore.getState().searchQuery;
      if (q.trim()) recordSearch(q);
      if (n.url) void openUrl(n.url);
      else useBookmarkStore.getState().selectFolder(n.id);
    },
    [items, toggleRange],
  );

  /** 批量复制选中项为 Markdown 列表（文档场景常用） */
  const copySelectedMarkdown = () => {
    const lines = selectedNodes
      .filter((n): n is BNode & { url: string } => !!n.url)
      .map((n) => `- [${(n.title || n.url).replace(/[[\]]/g, '')}](<${n.url}>)`);
    if (lines.length === 0) return;
    void copyText(lines.join('\n'), `已复制 ${lines.length} 条 Markdown`);
  };

  /** 搜索词变化（现在只有顶栏那一个入口会调它） */
  const onQueryChange = (value: string) => {
    setQuery(value);
    setActiveIndex(-1); // 搜索/清空切换数据集，残留高亮会指向错误行
    if (!value.trim()) setAnchorIndex(null);
  };

  /** 打开统一右键菜单（书签树与列表共用同一状态，天然互斥） */
  const openContextMenu = useCallback((e: MouseEvent, bookmarkId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const menu: TreeContextMenu = { x: e.clientX, y: e.clientY, bookmarkId };
    setContextMenu(menu);
  }, [setContextMenu]);

  // 稳定包装：BookmarkRow memo 需要引用不变（openContextMenu 定义之后）
  const handleContextMenuRow = useCallback((e: MouseEvent, id: string) => openContextMenu(e, id), [openContextMenu]);

  /** 拖放：把树中拖来的书签移入当前文件夹（按住 Ctrl = 复制；多选拖拽批量处理；空白处就近插入） */
  const handleListDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!selectedFolderId) return;
    e.preventDefault();
    const raw = e.dataTransfer.getData('text/plain');
    if (!raw) return;
    const dragIds = raw.split(',').filter(Boolean);
    if (dragIds.length === 0) return;
    const isCopy = e.ctrlKey || e.dataTransfer.dropEffect === 'copy';
    // 空白处 drop：仅「原始顺序」下按鼠标纵向位置就近计算插入点（同文件夹微调排序时避免"跳到末尾"）。
    // 排序模式下 data-index 是排序后的序号，与 Chrome move 的 manual index 不一致，直接追加到末尾
    let dropIndex: number | undefined;
    if (sortBy === 'manual') {
      const listEl = listRef.current;
      if (listEl) {
        const rows = listEl.querySelectorAll<HTMLElement>('[data-index]');
        let lastAbove = -1;
        for (const row of rows) {
          const r = row.getBoundingClientRect();
          if (e.clientY > r.top + r.height / 2) {
            const idx = Number(row.dataset.index);
            if (Number.isFinite(idx) && idx > lastAbove) lastAbove = idx;
          }
        }
        if (lastAbove >= 0) dropIndex = lastAbove + 1;
      }
    }
    // 外部拖入：内容是一个 URL（从地址栏/网页链接拖进来）→ 直接收藏到当前文件夹（独立处理，不经过移动流程）
    if (dragIds.length === 1 && /^https?:\/\//i.test(dragIds[0]!)) {
      const url = dragIds[0]!;
      void chrome.bookmarks
        .create({ parentId: selectedFolderId, title: getHost(url) || url, url })
        .then(() => {
          pushToast('已收藏到当前文件夹', { variant: 'success' });
          void useBookmarkStore.getState().loadTree();
        })
        .catch((err: unknown) => {
          pushToast('收藏失败', {
            description: err instanceof Error ? err.message : String(err),
            variant: 'destructive',
          });
        });
      return;
    }
    // 逐项独立计数：中途某一项失败时，前面已经完成的那几项**不能丢**——
    // 原先顺序 await + 一句笼统的"移动失败"会把"已移动 2 项"说成整体失败。
    const action = isCopy ? '复制' : '移动';
    void (async () => {
      let ok = 0;
      let failed = 0;
      let firstError: string | undefined;
      let idx = dropIndex;
      for (const id of dragIds) {
        const dragNode = findNode(useBookmarkStore.getState().roots, id);
        if (!dragNode) continue;
        // 防护：文件夹不能移入/复制到自身或子文件夹（含「自身」，由 isSelfOrDescendant 判定）
        if (isSelfOrDescendant(dragNode, selectedFolderId)) continue;
        try {
          if (isCopy) {
            await copyNodeDeep(dragNode, selectedFolderId, idx);
          } else {
            await chrome.bookmarks.move(id, { parentId: selectedFolderId, ...(idx !== undefined ? { index: idx } : {}) });
          }
          ok++;
        } catch (e) {
          failed++;
          firstError ??= e instanceof Error ? e.message : String(e);
        }
        if (idx !== undefined) idx++; // 批量插入保持输入顺序
      }
      const { title, opts } = describeBulk(action, { ok, failed, ...(firstError ? { firstError } : {}) }, '当前文件夹');
      pushToast(title, opts);
      void useBookmarkStore.getState().loadTree();
    })();
  };

  /** 行间拖放排序（仅浏览模式 + 原始顺序时可用，index 才对应真实位置） */
  const canReorder = browsing && sortBy === 'manual' && !!selectedFolderId && !!items;
  const [dropTarget, setDropTarget] = useState<{ index: number; position: 'above' | 'below' } | null>(null);

  /** 拖放边缘自动滚动：靠近容器顶部/底部时滚动（行内 stopPropagation 不影响此处） */
  const autoScrollDrag = useCallback((clientY: number) => {
    const el = listRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 28;
    if (clientY < rect.top + margin) el.scrollTop -= 40;
    else if (clientY > rect.bottom - margin) el.scrollTop += 40;
  }, []);

  const handleRowDragOver = useCallback(
    (index: number, e: DragEvent<HTMLDivElement>) => {
      if (!canReorder) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
      autoScrollDrag(e.clientY);
      const rect = e.currentTarget.getBoundingClientRect();
      const position: 'above' | 'below' = e.clientY < rect.top + rect.height / 2 ? 'above' : 'below';
      setDropTarget((prev) =>
        prev && prev.index === index && prev.position === position ? prev : { index, position },
      );
    },
    [canReorder, autoScrollDrag],
  );

  const handleRowDragLeave = useCallback(() => setDropTarget(null), []);

  // 拖拽取消（Esc/拖出窗口）时兜底清理指示线：目标行收不到 dragend
  useEffect(() => {
    const clear = () => setDropTarget(null);
    window.addEventListener('dragend', clear);
    return () => window.removeEventListener('dragend', clear);
  }, []);

  /** 行间放置：移动或 Ctrl+复制（真实 index 定位） */
  const handleRowDrop = useCallback(
    (index: number, e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(null);
      if (!canReorder || !selectedFolderId || !items) return;
      const dragId = e.dataTransfer.getData('text/plain');
      if (!dragId) return;
      const isCopy = e.ctrlKey || e.dataTransfer.dropEffect === 'copy';
      const rect = e.currentTarget.getBoundingClientRect();
      const position: 'above' | 'below' = e.clientY < rect.top + rect.height / 2 ? 'above' : 'below';
      // 落点即 index：Chromium 的 index 是「移除源之前」的插入位置，浏览器内部会换算，
      // 调用方不得再自我补偿（详见 lib/bookmark-dnd.ts —— 减 1 会让向后拖拽静默失效）
      const targetIndex = resolveDropIndex(index, position);
      if (isCopy) {
        const dragNode = findNode(useBookmarkStore.getState().roots, dragId);
        if (!dragNode) return;
        void copyNodeDeep(dragNode, selectedFolderId, targetIndex)
          .then(() => {
            pushToast('已复制到此文件夹', { variant: 'success' });
            void useBookmarkStore.getState().loadTree();
          })
          .catch((err: unknown) => {
            pushToast('复制失败', {
              description: err instanceof Error ? err.message : String(err),
              variant: 'destructive',
            });
          });
        return;
      }
      // 同文件夹内重排：targetIndex 已是浏览器要的「移除源之前」坐标系，原样传递
      void chrome.bookmarks
        .move(dragId, { parentId: selectedFolderId, index: targetIndex })
        .then(() => {
          pushToast('已调整顺序', { variant: 'success' });
          void useBookmarkStore.getState().loadTree();
        })
        .catch((err: unknown) => {
          pushToast('调整顺序失败', {
            description: err instanceof Error ? err.message : String(err),
            variant: 'destructive',
          });
        });
    },
    [canReorder, selectedFolderId, items],
  );

  /*
   * 顶栏搜索框里按 Enter：直接打开第一条匹配（文件夹则进入）。
   * 搜索框搬到顶栏之后，这个便利行为要靠 document 级监听补回来——
   * 否则「输完按回车」会变成什么都不发生（README 里承诺过这条）。
   */
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      const el = document.activeElement as HTMLElement | null;
      if (el?.id !== 'markai-search') return;
      const first = (searchResults ?? items ?? [])[0];
      if (!first) return;
      e.preventDefault();
      recordSearch(useBookmarkStore.getState().searchQuery);
      if (first.url) void openUrl(first.url);
      else useBookmarkStore.getState().selectFolder(first.id);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [searchResults, items]);


  return (
    <div className={cn('animate-fade-in relative flex h-full min-h-0 min-w-0 flex-col bg-background', className)}>
      {/* 工具栏：左边"你在看什么"，右边"怎么排、怎么整理" */}
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-4">
        <div className="min-w-0 flex-1">
          {overview ? (
            <div className="flex min-w-0 items-center gap-1.5">
              <LayoutDashboard className="h-3.5 w-3.5 shrink-0 text-accent" />
              <span className="truncate text-sm font-semibold text-foreground">书签概览</span>
              {!compact && (
                <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                  整个书签库
                </span>
              )}
            </div>
          ) : effectiveTag ? (
            <div className="flex min-w-0 items-center gap-1.5">
              <Tag className="h-3.5 w-3.5 shrink-0 text-accent" />
              <span className="truncate text-sm font-semibold text-foreground">标签 #{effectiveTag}</span>
              <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-2xs tabular-nums text-muted-foreground">
                {items?.length ?? 0} 项
              </span>
            </div>
          ) : browsing ? (
            <div className="flex min-w-0 items-center gap-1.5">
              {!compact && (
                <button
                  type="button"
                  onClick={() => useBookmarkStore.getState().selectFolder(null)}
                  className="shrink-0 rounded-md px-1.5 py-0.5 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
                >
                  {selectedFolderId ? '全部' : '全部书签'}
                </button>
              )}
              {selectedFolderId ? (
                <BreadcrumbTrail roots={roots} folderId={selectedFolderId} />
              ) : compact ? (
                <span className="truncate text-sm font-semibold text-foreground">全部书签</span>
              ) : null}
              {children && (
                <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-2xs tabular-nums text-muted-foreground">
                  {children.length} 项
                </span>
              )}
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-1.5">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate text-sm font-semibold text-foreground">搜索「{query}」</span>
              {searchResults && !searchErr && (
                <span
                  className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-2xs tabular-nums text-muted-foreground"
                  data-testid="search-count"
                >
                  {searchResults.length}
                  {searchResults.length >= 100 ? '+' : ''} 条
                </span>
              )}
              {searchErr && (
                <span className="shrink-0 text-2xs text-destructive" data-testid="search-error">
                  搜索失败
                </span>
              )}
            </div>
          )}
          {!compact && !overview && (
            <p className="mt-0.5 truncate text-2xs text-muted-foreground">
              {effectiveTag
                ? '标签筛选 · 覆盖整个书签库'
                : browsing
                  ? selectedFolderId
                    ? '当前文件夹 · 支持多选、拖拽与右键'
                    : '书签栏与全部文件夹'
                  : '在全部书签中搜索'}
            </p>
          )}
          {!compact && overview && (
            <p className="mt-0.5 truncate text-2xs text-muted-foreground">
              你的书签库一眼看清 · 所有动作都走确认与撤销
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {/* 搜索模式打开全部结果（去重，最多 25 个；侧边栏窄布局用图标） */}
          {!browsing && (searchResults?.length ?? 0) > 0 && (
            <Button
              size={compact ? 'icon' : 'sm'}
              variant="secondary"
              onClick={openSearchResults}
              title="打开全部搜索结果"
              className={compact ? 'h-8 w-8' : 'h-8'}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {!compact && '打开全部'}
            </Button>
          )}

          {/*
           * 视图切换：概览 / 列表 / 时间线 三个状态一眼可见。
           * 「概览」是库级视图（问候 + 指标 + 建议），不写书签；点进具体文件夹会自动回到列表。
           */}
          <div className="flex items-center rounded-lg bg-muted p-0.5" role="group" aria-label="视图">
            <button
              type="button"
              data-testid="overview-toggle"
              aria-pressed={overview}
              aria-label="书签概览"
              onClick={() => setOverview(true)}
              title="书签概览：库的状态与管家建议"
              className={cn(
                'flex h-7 items-center gap-1 rounded-md px-2 text-2xs transition-colors',
                overview ? 'bg-card font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <LayoutDashboard className="h-3 w-3" />
              {!compact && '概览'}
            </button>
            <button
              type="button"
              aria-pressed={!overview && sortBy !== 'time'}
              aria-label="列表视图"
              onClick={() => {
                setOverview(false);
                setSortBy('manual');
              }}
              title="文件夹列表"
              className={cn(
                'flex h-7 items-center gap-1 rounded-md px-2 text-2xs transition-colors',
                !overview && sortBy !== 'time'
                  ? 'bg-card font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <LayoutList className="h-3 w-3" />
              {!compact && '列表'}
            </button>
            <button
              type="button"
              data-testid="timeline-toggle"
              aria-pressed={!overview && sortBy === 'time'}
              aria-label="时间线视图"
              onClick={() => {
                setOverview(false);
                setSortBy(sortBy === 'time' ? 'manual' : 'time');
              }}
              title="时间线：按收藏时间看全部书签"
              className={cn(
                'flex h-7 items-center gap-1 rounded-md px-2 text-2xs transition-colors',
                !overview && sortBy === 'time'
                  ? 'bg-card font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Clock className="h-3 w-3" />
              {!compact && '时间线'}
            </button>
          </div>

          {/*
           * 排序：宽度按"最长的选项"来定（12px 字号下 5 个汉字 = 60px，
           * 加上左侧图标与右侧箭头 112px 刚好放得下「按添加时间」而不被截断）。
           */}
          {!overview && (
            <div className={cn('relative shrink-0', compact ? 'w-28' : 'w-[124px]')} title="排序">
              <ArrowDownUp className="pointer-events-none absolute top-1/2 left-1.5 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
              <select
                data-testid="sort"
                value={sortBy}
                disabled={!browsing}
                onChange={(e) => {
                  setSortBy(e.target.value as SortKey);
                  setAnchorIndex(null);
                  setActiveIndex(-1); // 排序后行序变化，保留高亮会指向另一个书签（Enter/Delete 错对象）
                }}
                className="h-8 w-full appearance-none truncate rounded-lg border border-border bg-card pl-6 pr-6 text-2xs text-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 disabled:opacity-50"
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <ChevronDown
                className="pointer-events-none absolute top-1/2 right-1.5 h-3 w-3 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
            </div>
          )}

          {/* 一键让 Agent 整理当前文件夹（主操作，不再和排序按钮同色同权重） */}
          {!overview && !effectiveTag && browsing && selectedFolderId && (
            <Button
              size={compact ? 'icon' : 'sm'}
              variant="default"
              onClick={organizeFolder}
              aria-label={ORGANIZE_LABEL.folder}
              title="让 MarkAI 整理当前文件夹"
              className={compact ? 'h-8 w-8' : 'h-8'}
            >
              <Sparkles className="h-3 w-3" />
              {!compact && '整理'}
            </Button>
          )}
        </div>
      </div>

      {/* 标签筛选条：有标签时才出现，不占没有标签用户的像素 */}
      {!overview && tagCounts.length > 0 && (
        <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-background px-3">
          <span className="shrink-0 pr-1 text-2xs text-muted-foreground/70">标签</span>
          {tagCounts.slice(0, 12).map(({ tag, count }) => (
            <button
              key={tag}
              type="button"
              aria-pressed={effectiveTag?.toLowerCase() === tag.toLowerCase()}
              onClick={() => {
                useBookmarkStore.getState().clearSelection();
                setActiveTag((cur) => (cur?.toLowerCase() === tag.toLowerCase() ? null : tag));
              }}
              style={{ color: colorVarOf(colorForTag(tagColors, tag)) }}
              className={cn(
                'flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-2xs transition-colors',
                effectiveTag?.toLowerCase() === tag.toLowerCase()
                  ? 'bg-accent-muted font-medium'
                  : 'hover:bg-muted',
              )}
            >
              #{tag}
              <span className="tabular-nums text-muted-foreground/50">{count}</span>
            </button>
          ))}
          {activeTag && (
            <button
              type="button"
              onClick={() => {
                setActiveTag(null);
                if (hashTag) onQueryChange('');
              }}
              className="ml-auto shrink-0 rounded-md px-1.5 py-1 text-2xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              清除筛选
            </button>
          )}
          <button
            type="button"
            data-testid="tags-manager-open"
            onClick={() => setTagsManagerOpen(true)}
            aria-label="管理标签"
            title="管理标签（重命名 / 合并 / 删除）"
            className={cn(
              'flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-2xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
              !activeTag && 'ml-auto',
            )}
          >
            <Settings2 className="h-3 w-3" />
            <span className="hidden sm:inline">管理</span>
          </button>
        </div>
      )}

      {/*
       * 加载失败的横幅。
       *
       * 为什么放横幅、不只在空态里写：失败时 `roots` 保留上次的值，
       * 列表其实**还有旧数据**，走不到空态分支——于是错误被"有内容"盖住了。
       * 横幅能同时做到两件事：明确告诉你出错了，并且不把可能还有用的旧数据拿走。
       */}
      {loadError && (
        <div
          data-testid="list-load-error"
          className="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/5 px-3 py-1.5"
        >
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
          <p className="min-w-0 flex-1 truncate text-2xs text-destructive" title={loadError}>
            书签加载失败：{loadError}
          </p>
          <Button
            size="sm"
            variant="outline"
            className="h-6 shrink-0 gap-1 px-1.5 text-2xs"
            onClick={() => void useBookmarkStore.getState().loadTree()}
            data-testid="list-retry"
          >
            <RefreshCw className="h-3 w-3" />
            重试
          </Button>
        </div>
      )}
      {overview ? (
        <OverviewPanel onShowList={showLibraryList} onShowToday={showToday} />
      ) : sortBy === 'time' ? (
        <TimelinePanel className="min-w-0 flex-1" />
      ) : (
      /* 列表（键盘可导航 + 接收树拖放） */
      <div
        data-testid="list"
        ref={listRef}
        tabIndex={0}
        onKeyDown={onListKeyDown}
        onMouseDown={focusList}
        onDragOver={(e) => {
          if (!selectedFolderId) return;
          e.preventDefault();
          autoScrollDrag(e.clientY);
        }}
        onDrop={handleListDrop}
        className="min-h-0 flex-1 overflow-y-auto p-2 outline-none"
      >
        {loadErr ? (
          <div className="flex flex-col items-center gap-1 px-2 py-4 text-center">
            <p className="text-xs text-destructive">这个文件夹没能加载</p>
            <p className="line-clamp-2 text-2xs text-muted-foreground/70">{loadErr}</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-1"
              onClick={() => {
                // 触发一次重拉：先清空再写回同一个 id，让上面的 effect 重新执行
                const id = selectedFolderId;
                setLoadErr(null);
                setChildren(null);
                if (id) useBookmarkStore.getState().selectFolder(id);
              }}
            >
              重试
            </Button>
          </div>
        ) : searchErr ? (
          /* 搜索失败：说清原因 + 可重试，而不是让列表永远停在「加载中…」 */
          <div
            data-testid="search-error-banner"
            className="flex flex-col items-center gap-2 px-3 py-6 text-center"
          >
            <p className="text-xs text-destructive">搜索失败：{searchErr}</p>
            <p className="text-2xs text-muted-foreground">
              这不代表没有匹配的书签，只是这一次没搜到。
            </p>
            <button
              type="button"
              data-testid="search-retry"
              className="rounded-sm border border-border px-2 py-1 text-2xs transition-colors hover:bg-muted"
              onClick={() => setSearchTick((n) => n + 1)}
            >
              重试
            </button>
          </div>
        ) : loading ? (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground">加载中…</p>
        ) : items && items.length > 0 ? (
          items.map((node, i) => (
            <Fragment key={node.id}>
              {/* 搜索结果分组头：文件夹与书签不再混成一条流水账 */}
              {!browsing && i === 0 && folderResultCount > 0 && (
                <div className="px-3 pt-3 pb-1 text-2xs font-medium text-muted-foreground">
                  文件夹 <span className="tabular-nums text-muted-foreground/50">{folderResultCount}</span>
                </div>
              )}
              {!browsing && i === firstBookmarkResult && firstBookmarkResult >= 0 && (
                <div className="px-3 pt-3 pb-1 text-2xs font-medium text-muted-foreground">
                  书签{' '}
                  <span className="tabular-nums text-muted-foreground/50">
                    {items.length - folderResultCount}
                  </span>
                </div>
              )}
              <BookmarkRow
                node={node}
                index={i}
                active={i === activeIndex}
                selected={selectedSet.has(node.id)}
                dropTarget={dropTarget}
                query={query}
                searching={!browsing}
                folderCount={folderCounts[node.id]}
                {...(tagMap[node.id]?.length
                  ? {
                      tagCount: tagMap[node.id]!.length,
                      tagSummary: tagMap[node.id]!.join(' · '),
                      tagColor: colorVarOf(colorForTag(tagColors, tagMap[node.id]![0]!)),
                      tagFirst: tagMap[node.id]![0]!,
                      onTagClick: handleTagFilter,
                    }
                  : {})}
                onRename={handleRenameRow}
                onToggle={handleToggleRow}
                onToggleClick={handleToggleClickRow}
                onActivate={handleActivateRow}
                onOpen={handleOpenRow}
                onContextMenu={handleContextMenuRow}
                onDragOverRow={handleRowDragOver}
                onDragLeaveRow={handleRowDragLeave}
                onDropRow={handleRowDrop}
              />
            </Fragment>
          ))
        ) : (
          <div
            data-testid="empty-state"
            className="flex h-full flex-col items-center justify-center gap-2 px-5 text-center"
          >
            {loadError ? (
              /* 加载失败优先于"空文件夹"：把"出错"说成"没有内容"是最误导人的一种空态 */
              <>
                <AlertCircle className="h-5 w-5 text-destructive/60" />
                <p className="text-xs text-destructive">书签加载失败</p>
                <p className="max-w-[280px] line-clamp-3 text-2xs leading-4 text-muted-foreground/70">
                  {loadError}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-1"
                  onClick={() => void useBookmarkStore.getState().loadTree()}
                  data-testid="list-retry"
                >
                  <RefreshCw className="h-3 w-3" />
                  重试
                </Button>
              </>
            ) : treeLoading ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/40" />
                <p className="text-xs text-muted-foreground">正在加载书签…</p>
              </>
            ) : browsing ? (
              <FolderOpen className="h-5 w-5 text-muted-foreground/40" />
            ) : (
              <Search className="h-5 w-5 text-muted-foreground/40" />
            )}
            <p className="text-xs text-muted-foreground">
              {/* 三种空状态统一成「一句状态 + 一个动作」：之前第一句是祈使句（「在左侧选择…」），
                  另外两句是状态描述，读起来像两套东西。 */}
              {effectiveTag
                ? '这个标签下还没有书签'
                : !selectedFolderId
                  ? '还没有选择文件夹'
                  : browsing
                    ? '此文件夹为空'
                    : '没有匹配的书签'}
            </p>
            {!selectedFolderId && roots[0] && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => useBookmarkStore.getState().selectFolder(roots[0]!.id)}
                className="mt-1"
              >
                <Folder className="h-3 w-3" />
                查看书签栏
              </Button>
            )}
            {/* 搜索无结果：给一个出口。只写「没有匹配的书签」会让人以为是库坏了 */}
            {!browsing && query && (
              <div className="mt-1 flex flex-col items-center gap-1">
                <Button size="sm" variant="outline" onClick={() => onQueryChange('')}>
                  <X className="h-3 w-3" />
                  清空搜索
                </Button>
                <p className="text-2xs text-muted-foreground/70">只搜标题与网址；换个词或清空后再看</p>
              </div>
            )}
            <p className="mt-2 text-2xs text-muted-foreground/70">
              / 搜索 · Enter 打开 · Ctrl+C 复制 · Delete 删除 · F2 重命名 · Ctrl+A 全选
            </p>
            {/*
             * 空文件夹的动作区：**只留一处**。
             *
             * 早先这里有两段独立的 `browsing && selectedFolderId` 块，各自渲染了自己的按钮，
             * 于是空文件夹里出现两个「新建书签」（实测 DOM 里确实是 2 个），
             * 一个还带着「或按 Ctrl+D」的空行——看着像渲染出错。
             * 现在合成一处：两个按钮 + 一行提示。
             */}
            {!overview && !effectiveTag && browsing && selectedFolderId && (
              <>
                <div className="mt-2.5 flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => openDialog({ kind: 'create-bookmark', parentId: selectedFolderId })}>
                    <BookmarkPlus className="h-3 w-3" />
                    新建书签
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => openDialog({ kind: 'create-folder', parentId: selectedFolderId })}>
                    <FolderPlus className="h-3 w-3" />
                    新建文件夹
                  </Button>
                </div>
                <p className="mt-1 text-2xs leading-4 text-muted-foreground/70">
                  或按 Ctrl+D 把当前页面收藏进来；右键文件夹可在树中新建子文件夹，或让 MarkAI 帮你整理。
                </p>
              </>
            )}
          </div>
        )}
      </div>
      )}

      {/*
       * 多选操作条：浮在列表底部而不是占一行高度。
       * 三个高频动作（整理 / 移动 / 删除）一键可达，其余收进「更多」，
       * 窄屏也不会把按钮挤成一排图标猜谜。
       */}
      {selectedIds.length > 0 && !overview && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-3">
          <div className="markai-glass markai-glass-liquid relative pointer-events-auto animate-slide-up flex items-center gap-1 rounded-xl p-1">
            <span className="px-2 text-2xs font-medium text-foreground">
              已选 <span className="tabular-nums text-accent">{selectedIds.length}</span> 项
            </span>
            <span className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />
            <Button
              size="sm"
              onClick={organizeSelected}
              className="h-7 gap-1"
              aria-label={ORGANIZE_LABEL.selection(selectedIds.length)}
              title={ORGANIZE_LABEL.selection(selectedIds.length)}
            >
              <Sparkles className="h-3 w-3" />
              {!compact && '让 MarkAI 整理'}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => openDialog({ kind: 'move', bookmarkIds: selectedIds })}
              className="h-7 gap-1"
              title="移动到…"
            >
              <FolderInput className="h-3 w-3" />
              {!compact && '移动'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => openDialog({ kind: 'delete-many', bookmarkIds: selectedIds })}
              className="h-7 gap-1 text-destructive hover:bg-destructive/10"
              title="删除所选"
            >
              <Trash2 className="h-3 w-3" />
              {!compact && '删除'}
            </Button>
            <div className="relative">
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                title="更多操作"
                aria-label="更多操作"
                onClick={() => setSelectionMenuOpen((v) => !v)}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
              {selectionMenuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setSelectionMenuOpen(false)}
                    aria-hidden="true"
                  />
                  <div className="markai-glass markai-glass-liquid animate-slide-up absolute right-0 bottom-full z-20 mb-2 w-44 rounded-lg p-1">
                    {[
                      { icon: ExternalLink, label: '打开所选', run: openSelected },
                      { icon: Copy, label: '复制网址', run: copySelectedUrls },
                      { icon: Link2, label: '复制 Markdown', run: copySelectedMarkdown },
                      {
                        icon: Tag,
                        label: '添加标签…',
                        run: () => openDialog({ kind: 'tags', bookmarkIds: [...selectedIds] }),
                      },
                      {
                        icon: Tag,
                        label: '移除标签…',
                        run: () => openDialog({ kind: 'remove-tags', bookmarkIds: [...selectedIds] }),
                      },
                      {
                        icon: X,
                        label: '清除选择',
                        run: () => {
                          useBookmarkStore.getState().clearSelection();
                        },
                      },
                    ].map((action) => (
                      <button
                        key={action.label}
                        type="button"
                        onClick={() => {
                          setSelectionMenuOpen(false);
                          action.run();
                        }}
                        className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-foreground transition-colors hover:bg-muted"
                      >
                        <action.icon className="h-3.5 w-3.5 text-muted-foreground" />
                        {action.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
      <TagsManagerDialog
        open={tagsManagerOpen}
        onClose={() => setTagsManagerOpen(false)}
        map={tagMap}
        onChange={(next) => setTagMap(next)}
      />
    </div>
  );
}

/** 面包屑路径（当前文件夹 → 根） */
function BreadcrumbTrail({ roots, folderId }: { roots: BNode[]; folderId: string }) {
  const node = findNode(roots, folderId);
  if (!node) return null;
  const crumbs: { id: string; title: string }[] = [];
  let cur: BNode | null = node;
  let depth = 0;
  while (cur && depth++ < 32) {
    crumbs.unshift({ id: cur.id, title: cur.title || '(未命名)' });
    cur = cur.parentId ? findNode(roots, cur.parentId) : null;
  }
  return (
    <>
      {crumbs.map((c, i) => (
        <span key={c.id} className="flex min-w-0 items-center gap-1">
          {i > 0 && <span className="text-muted-foreground/50">/</span>}
          <button
            type="button"
            onClick={() => useBookmarkStore.getState().selectFolder(c.id)}
            className={cn(
              'truncate text-xs transition-colors',
              c.id === folderId ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {c.title}
          </button>
        </span>
      ))}
    </>
  );
}

/** 搜索高亮：匹配词以 accent 标记（全部匹配，忽略大小写） */
function highlightText(text: string, query: string): ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  if (!lower.includes(q)) return text;
  const parts: ReactNode[] = [];
  let cursor = 0;
  let idx = lower.indexOf(q, cursor);
  while (idx >= 0 && parts.length < 20) {
    if (idx > cursor) parts.push(text.slice(cursor, idx));
    parts.push(
      <span key={`hl-${idx}`} className="rounded-sm bg-accent/15 text-accent">
        {text.slice(idx, idx + q.length)}
      </span>,
    );
    cursor = idx + q.length;
    idx = lower.indexOf(q, cursor);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

/** 搜索模式下显示来源文件夹路径（文件夹已删则提示） */
function folderPath(parentId: string): string {
  const roots = useBookmarkStore.getState().roots;
  return findNode(roots, parentId) ? resolveTitlePath(roots, parentId) : '(已删除)';
}

/** 单行书签（memo 优化：书签树刷新/流式渲染时跳过未变化行） */
const BookmarkRow = memo(function BookmarkRow({
  node,
  index,
  active,
  selected,
  dropTarget,
  query,
  searching,
  folderCount,
  tagCount,
  tagSummary,
  tagColor,
  tagFirst,
  onTagClick,
  onToggle,
  onToggleClick,
  onActivate,
  onOpen,
  onRename,
  onContextMenu,
  onDragOverRow,
  onDragLeaveRow,
  onDropRow,
}: {
  node: BNode;
  index: number;
  active: boolean;
  selected: boolean;
  /** 搜索词（高亮匹配；非搜索模式为空） */
  query: string;
  /** 搜索模式（副文本显示来源文件夹路径） */
  searching: boolean;
  /** 该文件夹的真实子项数（由树 store 推导；未取到时不显示，绝不显示假的 0） */
  folderCount?: number;
  /** 标签数 / 标签名 / 首个标签颜色（只在 hover / 聚焦时展示，避免常态噪音） */
  tagCount?: number;
  tagSummary?: string;
  tagColor?: string;
  /** 首个标签（点击行内提示时按它筛选） */
  tagFirst?: string;
  onTagClick?: (tag: string) => void;
  /** 双击标题快速重命名 */
  onRename: (id: string) => void;
  /** 行间拖放指示（本行上方/下方显示定位条） */
  dropTarget: { index: number; position: 'above' | 'below' } | null;
  onToggle: (index: number, shiftKey: boolean) => void;
  /** Ctrl/Cmd+点击切换选择 */
  onToggleClick: (index: number) => void;
  onActivate: (index: number) => void;
  onOpen: (index: number, shiftKey: boolean) => void;
  onContextMenu: (e: MouseEvent, id: string) => void;
  onDragOverRow: (index: number, e: DragEvent<HTMLDivElement>) => void;
  onDragLeaveRow: () => void;
  onDropRow: (index: number, e: DragEvent<HTMLDivElement>) => void;
}) {
  const isFolder = !node.url;
  const isDropTarget = dropTarget?.index === index;
  // 计数器防抖：子元素间移动时 dragleave 误触发，用进出深度判断真正离开
  const dragDepth = useRef(0);
  /**
   * 单击打开 vs 双击重命名：书签走「延迟打开」，双击时把那次打开**取消掉**。
   *
   * 旧实现是「350ms 内忽略第二次 click」——第一次 click 已经执行了打开，
   * 所以双击标题改名时必然多留一个标签页（注释写的是"避免开两个"，实际只是从 2 降到 1）。
   * 文件夹不进这条路径：展开/选中必须即时。
   */
  const shiftOpen = useRef(false);
  const openLater = useMemo(
    () => createDelayedOpen(() => onOpen(index, shiftOpen.current)),
    [onOpen, index],
  );
  // 卸载时清掉待执行的打开，避免组件已消失还去开标签页
  useEffect(() => () => openLater.dispose(), [openLater]);
  return (
    <div
      data-testid="row"
      data-index={index}
      data-active={active ? 'true' : 'false'}
      role="listitem"
      aria-selected={selected}
      title={node.url ? `${node.title}\n${node.url}` : node.title}
      draggable
      onDragStart={(e) => {
        // 多选时拖拽任一所选项 → 拖动全部选中项（逗号分隔，drop 端批量处理）
        const multi = useBookmarkStore.getState().selectedBookmarkIds;
        const ids = multi.includes(node.id) ? multi : [node.id];
        e.dataTransfer.setData('text/plain', ids.join(','));
        e.dataTransfer.effectAllowed = 'copyMove'; // Ctrl+拖拽 = 复制
      }}
      onDragEnter={() => {
        dragDepth.current++;
      }}
      onDragOver={(e) => onDragOverRow(index, e)}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) onDragLeaveRow();
      }}
      onDrop={(e) => {
        dragDepth.current = 0;
        onDropRow(index, e);
      }}
      onClick={(e) => {
        // Ctrl/Cmd+点击：切换选择而不打开；Shift+点击：范围多选
        if (e.ctrlKey || e.metaKey) {
          onToggleClick(index);
          return;
        }
        // 文件夹：展开/选中即时响应（双击文件夹没有第二语义，不需要反悔窗口）
        if (isFolder) {
          onOpen(index, e.shiftKey);
          return;
        }
        // 书签：延迟打开。双击（标题重命名）会在冒泡阶段取消这里
        shiftOpen.current = e.shiftKey;
        openLater.schedule();
      }}
      // 兜底：双击落在行内空白（非标题）时，那次延迟打开也应当作废
      onDoubleClick={() => openLater.cancel()}
      onAuxClick={(e) => {
        // 中键：在新标签页打开（阻止 Windows 自动滚动；复选框等控件内不触发）
        if (e.button === 1 && !(e.target as HTMLElement).closest('button')) {
          e.preventDefault();
          if (node.url) void openUrl(node.url);
        }
      }}
      onMouseEnter={() => onActivate(index)}
      onContextMenu={(e) => onContextMenu(e, node.id)}
      className={cn(
        'group relative flex h-11 cursor-pointer items-center gap-2.5 rounded-lg px-3 transition-colors hover:bg-muted',
        // 选中（多选/当前文件夹）与键盘高亮互斥：选中态用 accent 底，键盘高亮用描边
        selected ? 'bg-accent-muted' : active && 'bg-muted',
      )}
    >
      {/* 选中左标记 */}
      {selected && <span className="pointer-events-none absolute top-2.5 bottom-2.5 left-0 w-[3px] rounded-full bg-accent" />}
      {/* 行间拖放定位条（与选中指示条区分：半透明） */}
      {isDropTarget && dropTarget!.position === 'above' && (
        <span className="pointer-events-none absolute -top-0.5 right-1 left-1 h-0.5 rounded-full bg-accent/60" />
      )}
      {isDropTarget && dropTarget!.position === 'below' && (
        <span className="pointer-events-none absolute -bottom-0.5 right-1 left-1 h-0.5 rounded-full bg-accent/60" />
      )}
      {/*
       * 复选框平时收起、hover/聚焦/选中时出现：
       * 一列始终显示的空方框会让列表看起来像"待办清单"，
       * 而多选仍然可发现（悬停即见），键盘用户 Tab 到它时也会显现。
       */}
      <span
        className={cn(
          'shrink-0 transition-opacity',
          selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
        )}
      >
        <Checkbox checked={selected} onCheckedChange={(_c, shift) => onToggle(index, !!shift)} aria-label={`选择 ${node.title}`} />
      </span>
      <span
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
          isFolder ? 'bg-accent-muted text-accent' : 'bg-muted',
        )}
        aria-hidden="true"
      >
        {isFolder ? <Folder className="h-4 w-4" /> : <Favicon url={node.url} size={15} />}
      </span>
      <div className="min-w-0 flex-1">
        {/* 行高 48px：标题 13px + 元信息 11px 两行排得下，又留出点击余量 */}
        <p className="truncate text-md font-medium text-foreground" onDoubleClick={() => onRename(node.id)}>
          {highlightText(node.title || '(未命名)', query)}
        </p>
        {isFolder ? (
          <p className="mt-0.5 text-2xs text-muted-foreground">
            {folderCount === undefined ? '文件夹' : `文件夹 · ${folderCount} 项`}
          </p>
        ) : (
          <p className="mt-0.5 truncate text-2xs text-muted-foreground">
            {searching ? (
              // 搜索模式：显示来源文件夹路径（可点击定位），浏览模式显示域名与时间
              node.parentId ? (
                <button
                  type="button"
                  onClick={() => useBookmarkStore.getState().revealInTree(node.parentId!)}
                  className="text-muted-foreground transition-colors hover:text-accent"
                  title="在树中显示该文件夹"
                >
                  {folderPath(node.parentId)}
                </button>
              ) : (
                '(根目录)'
              )
            ) : (
              <>
                {highlightText(getHost(node.url), query)}
                {' · '}
                {formatRelativeTime(node.dateLastUsed || node.dateAdded)}
              </>
            )}
          </p>
        )}
      </div>
      {/*
       * 行内快捷操作：hover / 键盘聚焦才出现，不打断"单击打开"的主路径。
       * 打开与定位都 stopPropagation：否则点图标会同时触发整行的打开动作。
       */}
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        {tagCount && tagFirst ? (
          <button
            type="button"
            data-testid="row-tags"
            title={`按「${tagFirst}」筛选 · ${tagSummary || `${tagCount} 个标签`}`}
            aria-label={`按标签 ${tagFirst} 筛选`}
            onClick={(e) => {
              e.stopPropagation();
              onTagClick?.(tagFirst);
            }}
            className="flex items-center gap-0.5 rounded-md bg-muted px-1 py-0.5 text-2xs tabular-nums transition-colors hover:bg-accent-muted"
            style={tagColor ? { color: tagColor } : undefined}
          >
            <Tag className="h-3 w-3" />
            {tagCount}
          </button>
        ) : null}
        {!isFolder && node.url && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (node.url) void openUrl(node.url);
            }}
            aria-label="在新标签页打开"
            title="在新标签页打开"
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            useBookmarkStore.getState().revealInTree(node.id);
          }}
          aria-label="在树中定位"
          title="在树中定位"
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
        >
          <LocateFixed className="h-3.5 w-3.5" />
        </button>
      </span>
    </div>
  );
});
