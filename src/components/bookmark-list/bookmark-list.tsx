import { ArrowDownUp, BookmarkPlus, Copy, ExternalLink, Folder, FolderInput, FolderOpen, FolderPlus, Link2, Search, Sparkles, Trash2, X } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { useAIStore } from '@/stores/aiStore';
import { useBookmarkStore, copyNodeDeep, findNode, resolveTitlePath, type TreeContextMenu } from '@/stores/bookmarkStore';
import { useUIStore } from '@/stores/uiStore';
import { copyText } from '@/lib/clipboard';
import { formatRelativeTime, getHost } from '@/lib/format';
import { pushToast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Favicon } from '@/components/common/favicon';
import { Input } from '@/components/ui/input';

type BNode = chrome.bookmarks.BookmarkTreeNode;

/** 排序方式（原生书签管理器风格） */
type SortKey = 'manual' | 'title' | 'url' | 'dateAdded' | 'dateLastUsed';

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'manual', label: '原始顺序' },
  { value: 'title', label: '按名称' },
  { value: 'url', label: '按地址' },
  { value: 'dateAdded', label: '按添加时间' },
  { value: 'dateLastUsed', label: '按最近使用' },
];

/**
 * 书签列表（中栏）：当前文件夹内容 / 搜索结果。
 * 原生交互：完整右键菜单、排序、键盘导航（↑↓ Enter Delete Ctrl+A）、多选交给 Agent。
 * compact：侧边栏窄布局下隐藏排序控件，避免工具栏溢出。
 */
export function BookmarkList({ className, compact = false }: { className?: string; compact?: boolean }) {
  const roots = useBookmarkStore((s) => s.roots);
  const selectedFolderId = useBookmarkStore((s) => s.selectedFolderId);
  const selectedIds = useBookmarkStore((s) => s.selectedBookmarkIds);
  const toggleSelect = useBookmarkStore((s) => s.toggleSelect);
  const selectMany = useBookmarkStore((s) => s.selectMany);
  const clearSelection = useBookmarkStore((s) => s.clearSelection);
  const setContextMenu = useBookmarkStore((s) => s.setContextMenu);
  const send = useAIStore((s) => s.send);
  const openDialog = useUIStore((s) => s.openDialog);

  const [children, setChildren] = useState<BNode[] | null>(null);
  const [searchResults, setSearchResults] = useState<BNode[] | null>(null);
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('manual');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 加载当前文件夹子项（roots 变化 = 书签结构变更 → 重新拉取；切回浏览模式时也重拉）
  useEffect(() => {
    if (!selectedFolderId || query.trim()) {
      setChildren(null);
      return;
    }
    let cancelled = false;
    void chrome.bookmarks
      .getChildren(selectedFolderId)
      .then((c) => {
        if (!cancelled) setChildren(c);
      })
      .catch(() => {}); // 删除/移动竞态下 getChildren 可能拒绝，静默忽略
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

  // 「在树中显示」会清空 store.searchQuery → 同步清空本地搜索词（回到浏览模式）
  const storeSearchQuery = useBookmarkStore((s) => s.searchQuery);
  useEffect(() => {
    if (storeSearchQuery === '' && query) setQuery('');
  }, [storeSearchQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  // 搜索（防抖）
  useEffect(() => {
    if (!query.trim()) {
      setSearchResults(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void chrome.bookmarks
        .search(query.trim())
        .then((r) => {
          if (!cancelled) setSearchResults(r.slice(0, 100));
        })
        .catch(() => {});
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const browsing = !query.trim();
  const rawItems = browsing ? children : searchResults;

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
      // 文件夹优先
      const folderDiff = (b.url ? 1 : 0) - (a.url ? 1 : 0);
      if (folderDiff !== 0) return folderDiff;
      if (sortBy === 'dateAdded') return (b.dateAdded ?? 0) - (a.dateAdded ?? 0);
      if (sortBy === 'dateLastUsed') return (b.dateLastUsed ?? 0) - (a.dateLastUsed ?? 0);
      // 自然数字排序：v2.0 排在 v10.0 前（版本号书签友好）
      return keyOf(a).localeCompare(keyOf(b), 'zh', { numeric: true });
    });
    return list;
  }, [rawItems, sortBy, browsing]);

  // 未选中文件夹时不显示加载态（展示引导文案），避免无限「加载中…」
  const loading = browsing ? children === null && !!selectedFolderId : searchResults === null;

  const selectedNodes = useMemo(
    () => selectedIds.map((id) => findNode(roots, id)).filter((n): n is BNode => !!n),
    [selectedIds, roots],
  );

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

  // 键盘导航时把高亮行滚入可视区（长列表 ↑↓ 不丢视线）
  useEffect(() => {
    if (activeIndex < 0) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

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
          if (anchorIndex === null) setAnchorIndex(activeIndex >= 0 ? activeIndex : 0);
          toggleRange(next, true);
        }
        setActiveIndex(next);
        break;
      }
      case 'Home':
        e.preventDefault();
        if (e.shiftKey) {
          if (anchorIndex === null) setAnchorIndex(activeIndex >= 0 ? activeIndex : 0);
          toggleRange(0, true);
        }
        setActiveIndex(0);
        break;
      case 'End':
        e.preventDefault();
        if (e.shiftKey) {
          if (anchorIndex === null) setAnchorIndex(activeIndex >= 0 ? activeIndex : 0);
          toggleRange(count - 1, true);
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
          void chrome.tabs.create({ url: n.url, active: !e.shiftKey }).catch(() => {});
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
          selectMany(items.filter((n) => n.url).map((n) => n.id));
        }
        break;
      case 'c':
        // Ctrl+C：复制选中项网址（无多选时复制高亮行）
        if (e.ctrlKey || e.metaKey) {
          const targets =
            selectedIds.length > 0
              ? items.filter((n) => selectedIds.includes(n.id) && n.url)
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
    for (const url of urls.slice(0, openCount)) void chrome.tabs.create({ url }).catch(() => {});
    pushToast(`已打开 ${openCount} 个标签页`, { variant: 'success' });
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

  const organizeSelected = () => {
    if (selectedNodes.length === 0) return;
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
    for (const url of urls.slice(0, openCount)) void chrome.tabs.create({ url }).catch(() => {});
    pushToast(`已打开 ${openCount} 个标签页`, { variant: 'success' });
    clearSelection();
  };

  /** 批量复制选中项的网址（每行一个） */
  const copySelectedUrls = () => {
    const urls = selectedNodes.map((n) => n.url).filter((u): u is string => !!u);
    if (urls.length === 0) return;
    void copyText(urls.join('\n'), `已复制 ${urls.length} 个网址`);
  };

  /** 选择/取消（支持 Shift 范围多选：从锚点到当前行的区间；锚点保持最初位置，反向移动可收缩） */
  const toggleRange = useCallback(
    (index: number, shiftKey: boolean) => {
      if (!items) return;
      const node = items[index];
      if (!node) return;
      if (shiftKey) {
        const anchor = anchorIndex ?? 0;
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
  const handleOpenRow = useCallback(
    (i: number, shiftKey: boolean) => {
      const n = items?.[i];
      if (!n) return;
      if (shiftKey) {
        toggleRange(i, true);
        return;
      }
      if (n.url) void chrome.tabs.create({ url: n.url }).catch(() => {});
      else useBookmarkStore.getState().selectFolder(n.id);
    },
    [items, toggleRange],
  );

  /** 批量复制选中项为 Markdown 列表（文档场景常用） */
  const copySelectedMarkdown = () => {
    const lines = selectedNodes
      .filter((n): n is BNode & { url: string } => !!n.url)
      .map((n) => `- [${(n.title || n.url).replace(/[[\]]/g, '')}](${n.url})`);
    if (lines.length === 0) return;
    void copyText(lines.join('\n'), `已复制 ${lines.length} 条 Markdown`);
  };

  /** 搜索词变化：同步到 store（「在树中显示」依赖该镜像清空搜索） */
  const onQueryChange = (value: string) => {
    setQuery(value);
    setActiveIndex(-1); // 搜索/清空切换数据集，残留高亮会指向错误行
    useBookmarkStore.getState().setSearchQuery(value.trim());
    if (!value.trim()) setAnchorIndex(null);
  };

  /** 打开统一右键菜单（书签树与列表共用同一状态，天然互斥） */
  const openContextMenu = (e: MouseEvent, bookmarkId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const menu: TreeContextMenu = { x: e.clientX, y: e.clientY, bookmarkId };
    setContextMenu(menu);
  };

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
    // 空白处 drop：按鼠标纵向位置就近计算插入点（同文件夹微调排序时避免"跳到末尾"）
    let dropIndex: number | undefined;
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
    const run = async () => {
      let ok = 0;
      let idx = dropIndex;
      for (const id of dragIds) {
        const dragNode = findNode(useBookmarkStore.getState().roots, id);
        if (!dragNode) continue;
        // 防护：文件夹不能移入/复制到自身或子文件夹
        if (!dragNode.url && findNode(dragNode.children ?? [], selectedFolderId)) continue;
        if (isCopy) {
          await copyNodeDeep(dragNode, selectedFolderId, idx);
          ok++;
        } else {
          await chrome.bookmarks.move(id, { parentId: selectedFolderId, ...(idx !== undefined ? { index: idx } : {}) });
          ok++;
        }
        if (idx !== undefined) idx++; // 批量插入保持输入顺序
      }
      return ok;
    };
    void run()
      .then((ok) => {
        pushToast(ok > 0 ? `已${isCopy ? '复制' : '移动'} ${ok} 项到当前文件夹` : '没有可移动的书签', {
          variant: ok > 0 ? 'success' : 'default',
        });
        void useBookmarkStore.getState().loadTree();
      })
      .catch((err: unknown) => {
        pushToast(`${isCopy ? '复制' : '移动'}失败`, {
          description: err instanceof Error ? err.message : String(err),
          variant: 'destructive',
        });
      });
  };

  /** 行间拖放排序（仅浏览模式 + 原始顺序时可用，index 才对应真实位置） */
  const canReorder = browsing && sortBy === 'manual' && !!selectedFolderId && !!items;
  const [dropTarget, setDropTarget] = useState<{ index: number; position: 'above' | 'below' } | null>(null);

  /** 拖放边缘自动滚动：靠近容器顶部/底部时滚动（行内 stopPropagation 不影响此处） */
  const autoScrollDrag = (clientY: number) => {
    const el = listRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 28;
    if (clientY < rect.top + margin) el.scrollTop -= 40;
    else if (clientY > rect.bottom - margin) el.scrollTop += 40;
  };

  const handleRowDragOver = (index: number, e: DragEvent<HTMLDivElement>) => {
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
  };

  const handleRowDragLeave = () => setDropTarget(null);

  // 拖拽取消（Esc/拖出窗口）时兜底清理指示线：目标行收不到 dragend
  useEffect(() => {
    const clear = () => setDropTarget(null);
    window.addEventListener('dragend', clear);
    return () => window.removeEventListener('dragend', clear);
  }, []);

  /** 行间放置：移动或 Ctrl+复制（真实 index 定位） */
  const handleRowDrop = (index: number, e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    if (!canReorder || !selectedFolderId || !items) return;
    const dragId = e.dataTransfer.getData('text/plain');
    if (!dragId) return;
    const isCopy = e.ctrlKey || e.dataTransfer.dropEffect === 'copy';
    const rect = e.currentTarget.getBoundingClientRect();
    const position: 'above' | 'below' = e.clientY < rect.top + rect.height / 2 ? 'above' : 'below';
    const targetIndex = position === 'above' ? index : index + 1;
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
  };

  // ── 行拖放回调的稳定包装（底层函数定义在此之后；BookmarkRow memo 需要稳定引用） ──
  const handleDragOverRowStable = useCallback(
    (i: number, e: DragEvent<HTMLDivElement>) => handleRowDragOver(i, e),
    [handleRowDragOver],
  );
  const handleDragLeaveRowStable = useCallback(handleRowDragLeave, [handleRowDragLeave]);
  const handleDropRowStable = useCallback(
    (i: number, e: DragEvent<HTMLDivElement>) => handleRowDrop(i, e),
    [handleRowDrop],
  );

  return (
    <div className={cn('flex h-full min-h-0 min-w-0 flex-col bg-background', className)}>
      {/* 工具栏：面包屑 + 排序 + 搜索 */}
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-2.5">
        {browsing ? (
          <div className="flex min-w-0 items-center gap-1">
            <button
              type="button"
              onClick={() => useBookmarkStore.getState().selectFolder(null)}
              className="shrink-0 rounded-sm px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              全部
            </button>
            {selectedFolderId && <BreadcrumbTrail roots={roots} folderId={selectedFolderId} />}
            {children && (
              <span className="shrink-0 text-[11px] text-muted-foreground/60">{children.length} 项</span>
            )}
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <Search className="h-3 w-3 shrink-0" />
            <span className="truncate">搜索「{query}」</span>
            {searchResults && (
              <span className="shrink-0 text-[11px] text-muted-foreground/70">
                · {searchResults.length}{searchResults.length >= 100 ? '+' : ''} 条
              </span>
            )}
          </div>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {/* 一键让 Agent 整理当前文件夹（完整页带文字，侧边栏窄布局用图标） */}
          {browsing && selectedFolderId && (
            <Button
              size={compact ? 'icon' : 'sm'}
              variant="secondary"
              onClick={organizeFolder}
              title="让 MarkAI 整理当前文件夹"
              className={compact ? 'h-7 w-7' : 'h-7'}
            >
              <Sparkles className="h-3 w-3" />
              {!compact && '整理'}
            </Button>
          )}
          {/* 搜索模式打开全部结果（去重，最多 25 个；侧边栏窄布局用图标） */}
          {!browsing && (searchResults?.length ?? 0) > 0 && (
            <Button
              size={compact ? 'icon' : 'sm'}
              variant="secondary"
              onClick={openSearchResults}
              title="打开全部搜索结果"
              className={compact ? 'h-7 w-7' : 'h-7'}
            >
              <ExternalLink className="h-3 w-3" />
              {!compact && '打开全部'}
            </Button>
          )}
          {/* 排序（仅浏览模式 + 非紧凑布局可用） */}
          {!compact && (
            <div className="relative" title="排序">
              <ArrowDownUp className="pointer-events-none absolute top-1/2 left-1.5 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
              <select
                value={sortBy}
                disabled={!browsing}
                onChange={(e) => {
                  setSortBy(e.target.value as SortKey);
                  setAnchorIndex(null);
                  setActiveIndex(-1); // 排序后行序变化，保留高亮会指向另一个书签（Enter/Delete 错对象）
                }}
                className="h-7 w-[104px] appearance-none rounded-sm border border-input bg-card pl-6 pr-4 text-xs text-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          {/* 搜索 */}
          <div className={cn('relative', compact ? 'w-32' : 'w-40')}>
            <Search className="absolute top-1/2 left-2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="markai-search"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              onKeyDown={(e) => {
                // Enter：直接打开第一条匹配（文件夹则进入）
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  const first = (searchResults ?? items ?? [])[0];
                  if (!first) return;
                  e.preventDefault();
                  if (first.url) void chrome.tabs.create({ url: first.url }).catch(() => {});
                  else useBookmarkStore.getState().selectFolder(first.id);
                }
              }}
              placeholder="搜索书签…"
              className="h-7 pl-6 pr-6 text-xs"
            />
            {query && (
              <button
                type="button"
                onClick={() => onQueryChange('')}
                className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                aria-label="清除搜索"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 多选操作条（compact 窄布局下用图标按钮，避免溢出） */}
      {selectedIds.length > 0 && (
        <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border bg-accent-muted/60 px-2.5">
          <span className="text-[11px] font-medium text-accent">
            {compact ? selectedIds.length : `已选 ${selectedIds.length} 项`}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            {compact ? (
              <>
                <Button size="icon" onClick={organizeSelected} title="让 MarkAI 整理选中项" className="h-6 w-6">
                  <Sparkles className="h-3 w-3" />
                </Button>
                <Button size="icon" variant="secondary" onClick={openSelected} title="打开所选" className="h-6 w-6">
                  <ExternalLink className="h-3 w-3" />
                </Button>
                <Button size="icon" variant="secondary" onClick={copySelectedUrls} title="复制网址" className="h-6 w-6">
                  <Copy className="h-3 w-3" />
                </Button>
                <Button
                  size="icon"
                  variant="secondary"
                  onClick={() => openDialog({ kind: 'move', bookmarkIds: selectedIds })}
                  title="移动到…"
                  className="h-6 w-6"
                >
                  <FolderInput className="h-3 w-3" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => openDialog({ kind: 'delete-many', bookmarkIds: selectedIds })}
                  title="删除所选"
                  className="h-6 w-6 text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" onClick={organizeSelected} className="h-6">
                  <Sparkles className="h-3 w-3" />
                  让 MarkAI 整理
                </Button>
                <Button size="sm" variant="secondary" onClick={openSelected} className="h-6">
                  <ExternalLink className="h-3 w-3" />
                  打开
                </Button>
                <Button size="sm" variant="secondary" onClick={copySelectedUrls} className="h-6">
                  <Copy className="h-3 w-3" />
                  复制
                </Button>
                <Button size="sm" variant="secondary" onClick={copySelectedMarkdown} className="h-6">
                  <Link2 className="h-3 w-3" />
                  Markdown
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => openDialog({ kind: 'move', bookmarkIds: selectedIds })}
                  className="h-6"
                >
                  <FolderInput className="h-3 w-3" />
                  移动
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => openDialog({ kind: 'delete-many', bookmarkIds: selectedIds })}
                  className="h-6 text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="h-3 w-3" />
                  删除
                </Button>
                <Button size="sm" variant="ghost" onClick={clearSelection} className="h-6">
                  <X className="h-3 w-3" />
                  清除
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {/* 列表（键盘可导航 + 接收树拖放） */}
      <div
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
        className="min-h-0 flex-1 overflow-y-auto p-1.5 outline-none"
      >
        {loading ? (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground">加载中…</p>
        ) : items && items.length > 0 ? (
          items.map((node, i) => (
            <BookmarkRow
              key={node.id}
              node={node}
              index={i}
              active={i === activeIndex}
              selected={selectedIds.includes(node.id)}
              dropTarget={dropTarget}
              query={query}
              searching={!browsing}
              onRename={handleRenameRow}
              onToggle={handleToggleRow}
              onToggleClick={handleToggleClickRow}
              onActivate={handleActivateRow}
              onOpen={handleOpenRow}
              onContextMenu={handleContextMenuRow}
              onDragOverRow={handleDragOverRowStable}
              onDragLeaveRow={handleDragLeaveRowStable}
              onDropRow={handleDropRowStable}
            />
          ))
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center">
            {browsing ? (
              <FolderOpen className="h-5 w-5 text-muted-foreground/40" />
            ) : (
              <Search className="h-5 w-5 text-muted-foreground/40" />
            )}
            <p className="text-xs text-muted-foreground">
              {!selectedFolderId ? '在左侧选择一个文件夹查看书签' : browsing ? '此文件夹为空' : '没有匹配的书签'}
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
            <p className="mt-2 text-[11px] text-muted-foreground/70">
              / 搜索 · Enter 打开 · Ctrl+C 复制 · Delete 删除 · F2 重命名 · Ctrl+A 全选
            </p>
            {browsing && selectedFolderId && (
              <>
                <p className="text-[11px] leading-4 text-muted-foreground/70">
                  右键文件夹可在树中新建子文件夹，或让 MarkAI 帮你整理。
                </p>
                <div className="mt-2 flex items-center gap-1.5">
                  <Button size="sm" variant="outline" onClick={() => openDialog({ kind: 'create-bookmark', parentId: selectedFolderId })}>
                    <BookmarkPlus className="h-3 w-3" />
                    新建书签
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => openDialog({ kind: 'create-folder', parentId: selectedFolderId })}>
                    <FolderPlus className="h-3 w-3" />
                    新建文件夹
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
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
  // 双击防抖：单击已打开书签，350ms 内的第二次点击忽略（重命名走标题双击）
  const lastClickAt = useRef(0);
  return (
    <div
      data-index={index}
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
        // 双击防抖：与树一致（350ms），避免双击标题时先开两个标签页再弹重命名框
        const now = Date.now();
        if (now - lastClickAt.current < 350) return;
        lastClickAt.current = now;
        onOpen(index, e.shiftKey);
      }}
      onAuxClick={(e) => {
        // 中键：在新标签页打开（阻止 Windows 自动滚动；复选框等控件内不触发）
        if (e.button === 1 && !(e.target as HTMLElement).closest('button')) {
          e.preventDefault();
          if (node.url) void chrome.tabs.create({ url: node.url }).catch(() => {});
        }
      }}
      onMouseEnter={() => onActivate(index)}
      onContextMenu={(e) => onContextMenu(e, node.id)}
      className={cn(
        'group relative flex h-9 cursor-pointer items-center gap-1.5 rounded-sm px-2 transition-colors hover:bg-muted/60',
        // 选中（多选/当前文件夹）与键盘高亮互斥：选中态用 accent 底，键盘高亮用描边
        selected ? 'bg-accent-muted/50' : active && 'bg-muted/80',
      )}
    >
      {/* 选中左指示条 */}
      {selected && <span className="pointer-events-none absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-accent" />}
      {/* 行间拖放定位条（与选中指示条区分：半透明） */}
      {isDropTarget && dropTarget!.position === 'above' && (
        <span className="pointer-events-none absolute -top-0.5 right-1 left-1 h-0.5 rounded-full bg-accent/60" />
      )}
      {isDropTarget && dropTarget!.position === 'below' && (
        <span className="pointer-events-none absolute -bottom-0.5 right-1 left-1 h-0.5 rounded-full bg-accent/60" />
      )}
      <Checkbox checked={selected} onCheckedChange={(_c, shift) => onToggle(index, !!shift)} aria-label={`选择 ${node.title}`} />
      {isFolder ? (
        <Folder className="h-3.5 w-3.5 shrink-0 text-indigo-500/80" />
      ) : (
        <Favicon url={node.url} size={14} />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-foreground" onDoubleClick={() => onRename(node.id)}>
          {highlightText(node.title || '(未命名)', query)}
        </p>
        {isFolder ? (
          <p className="text-[11px] text-muted-foreground">
            文件夹 · {node.children?.length ?? 0} 项
          </p>
        ) : (
          <p className="truncate text-[11px] text-muted-foreground">
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
      {!isFolder && node.url && (
        <span
          className="shrink-0 rounded-sm p-1 text-muted-foreground opacity-0 transition-all group-hover:opacity-100 group-hover:bg-muted"
          title="在新标签页打开"
        >
          <ExternalLink className="h-3 w-3" />
        </span>
      )}
    </div>
  );
});
