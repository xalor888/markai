import { memo, useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type DragEvent, type KeyboardEvent, type ReactNode, type SetStateAction } from 'react';
import {
  AppWindow,
  BookMarked,
  BookmarkPlus,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  ExternalLink,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  LayoutGrid,
  Link2,
  Loader2,
  LocateFixed,
  Route,
  Pencil,
  ScanSearch,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useBookmarkStore, copyNodeDeep, resolveTitlePath, type TreeContextMenu } from '@/stores/bookmarkStore';
import { useUIStore } from '@/stores/uiStore';
import { useAIStore } from '@/stores/aiStore';
import { copyText } from '@/lib/clipboard';
import { pushToast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { Favicon } from '@/components/common/favicon';
import { Separator } from '@/components/ui/separator';

type BNode = chrome.bookmarks.BookmarkTreeNode;

/** 扁平化可见节点（含深度），键盘导航用 */
interface VisibleNode {
  node: BNode;
  depth: number;
}

/**
 * 书签树（左栏）：展开/折叠、选中、右键菜单。
 * 原生交互：↑↓ 移动、←→ 折叠/展开、Enter 打开/选中，整树键盘可达。
 */
export function BookmarkTree({ className }: { className?: string }) {
  const roots = useBookmarkStore((s) => s.roots);
  const expandedIds = useBookmarkStore((s) => s.expandedIds);
  const selectedFolderId = useBookmarkStore((s) => s.selectedFolderId);
  const revealId = useBookmarkStore((s) => s.revealId);
  const loading = useBookmarkStore((s) => s.loading);
  const loadError = useBookmarkStore((s) => s.loadError);
  const [activeId, setActiveId] = useState<string | null>(null);
  // 稳定引用：TreeRow 已 memo，回调必须保持引用不变（否则 memo 失效）
  const handleActivate = useCallback((id: string) => setActiveId(id), []);
  const [dropTarget, setDropTarget] = useState<{ nodeId: string; position: 'above' | 'below' } | null>(null);
  const [filter, setFilter] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  // 「在树中显示」：滚动到目标节点、同步键盘高亮并聚焦容器，随后清空标记
  useEffect(() => {
    if (!revealId) return;
    // 过滤词可能隐藏目标节点，定位时先清除过滤
    if (filter) setFilter('');
    listRef.current?.querySelector<HTMLElement>(`[data-node-id="${revealId}"]`)?.scrollIntoView({ block: 'nearest' });
    setActiveId(revealId);
    listRef.current?.focus({ preventScroll: true });
    useBookmarkStore.setState({ revealId: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealId]);

  // 可见节点展平；过滤模式下：匹配节点（含祖先链）自动展开，非匹配分支剪枝
  const visible = useMemo<VisibleNode[]>(() => {
    const q = filter.trim().toLowerCase();
    const out: VisibleNode[] = [];
    const walk = (nodes: BNode[], depth: number, chainMatched: boolean) => {
      for (const n of nodes) {
        const selfMatch = !!q && (n.title || '').toLowerCase().includes(q);
        const keep = chainMatched || selfMatch;
        if (q && !keep) continue;
        out.push({ node: n, depth });
        if (!n.url && (q ? keep : expandedIds.includes(n.id))) {
          walk(n.children ?? [], depth + 1, keep);
        }
      }
    };
    walk(roots, 0, false);
    return out;
  }, [roots, expandedIds, filter]);

  // 高亮项滚动到可视区
  useEffect(() => {
    if (activeId) {
      listRef.current?.querySelector<HTMLElement>(`[data-node-id="${activeId}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeId]);

  // 活动节点被删除/折叠隐藏时清空，避免高亮悬空
  useEffect(() => {
    if (activeId && !visible.some((v) => v.node.id === activeId)) setActiveId(null);
  }, [visible, activeId]);

  // 拖拽取消（Esc/拖出窗口）时兜底清理指示线：目标行收不到 dragend
  useEffect(() => {
    const clear = () => setDropTarget(null);
    window.addEventListener('dragend', clear);
    return () => window.removeEventListener('dragend', clear);
  }, []);

  const indexOf = (id: string) => visible.findIndex((v) => v.node.id === id);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // 「/」聚焦中栏搜索框（与列表键盘一致）
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      document.getElementById('markai-search')?.focus();
      return;
    }
    if (visible.length === 0) return;
    const idx = activeId ? indexOf(activeId) : -1;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveId(visible[Math.min(idx + 1, visible.length - 1)]?.node.id ?? null);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveId(visible[Math.max(idx - 1, 0)]?.node.id ?? null);
        break;
      case 'Home':
        e.preventDefault();
        setActiveId(visible[0]?.node.id ?? null);
        break;
      case 'End':
        e.preventDefault();
        setActiveId(visible[visible.length - 1]?.node.id ?? null);
        break;
      case 'PageDown':
        e.preventDefault();
        setActiveId(visible[Math.min(idx + 10, visible.length - 1)]?.node.id ?? null);
        break;
      case 'PageUp':
        e.preventDefault();
        setActiveId(visible[Math.max(idx - 10, 0)]?.node.id ?? null);
        break;
      case 'ArrowRight': {
        e.preventDefault();
        const v = visible[idx];
        if (!v) break;
        if (!v.node.url && !expandedIds.includes(v.node.id)) {
          useBookmarkStore.getState().toggleExpand(v.node.id);
          useBookmarkStore.getState().selectFolder(v.node.id);
        } else if (visible[idx + 1]) {
          // 已展开 → 移向第一个子节点（原生树行为）
          setActiveId(visible[idx + 1]!.node.id);
        }
        break;
      }
      case 'ArrowLeft': {
        e.preventDefault();
        const v = visible[idx];
        if (!v) break;
        if (!v.node.url && expandedIds.includes(v.node.id)) {
          useBookmarkStore.getState().toggleExpand(v.node.id);
        } else if (v.node.parentId) {
          // 折叠态 → 回到父节点
          setActiveId(v.node.parentId);
        }
        break;
      }
      case 'Enter': {
        e.preventDefault();
        const v = visible[idx];
        if (!v) break;
        if (v.node.url) {
          // Shift+Enter：后台打开（不打断当前浏览）
          void chrome.tabs.create({ url: v.node.url, active: !e.shiftKey }).catch(() => {});
        } else {
          useBookmarkStore.getState().toggleExpand(v.node.id);
          useBookmarkStore.getState().selectFolder(v.node.id);
        }
        break;
      }
      case 'Delete': {
        e.preventDefault();
        const v = visible[idx];
        if (!v) break;
        // 根文件夹（书签栏/其他书签/移动设备）不可删除：与右键菜单一致，
        // 直接拦截避免删除对话框弹出又立即关闭的困惑体验
        if (roots.some((r) => r.id === v.node.id)) {
          pushToast('根文件夹不可删除', { variant: 'destructive' });
          break;
        }
        useUIStore.getState().openDialog({ kind: 'delete', bookmarkId: v.node.id });
        break;
      }
      case 'F2': {
        e.preventDefault();
        const v = visible[idx];
        if (v) useUIStore.getState().openDialog({ kind: 'rename', bookmarkId: v.node.id });
        break;
      }
      case 'c': {
        // Ctrl+C：复制高亮书签的网址
        if ((e.ctrlKey || e.metaKey) && idx >= 0) {
          const v = visible[idx];
          if (v?.node.url) {
            e.preventDefault();
            void copyText(v.node.url, '已复制网址');
          }
        }
        break;
      }
    }
  };

  return (
    <div className={cn('flex h-full min-h-0 flex-col bg-card', className)}>
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-2.5">
        <BookMarked className="h-3.5 w-3.5 text-indigo-500/80" />
        <span className="text-[11px] font-medium text-muted-foreground">书签</span>
        {/* 过滤模式下展开/折叠无可见反馈，隐藏避免困惑 */}
        {!filter && (
          <>
            <button
              type="button"
              onClick={() => useBookmarkStore.getState().expandAll()}
              className="ml-auto rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="全部展开"
              aria-label="全部展开"
            >
              <ChevronsUpDown className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => useBookmarkStore.getState().collapseAll()}
              className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="全部折叠"
              aria-label="全部折叠"
            >
              <ChevronsDownUp className="h-3 w-3" />
            </button>
          </>
        )}
      </div>
      {/* 树内过滤输入 */}
      <div className="relative px-2.5 pb-1.5 pt-1.5">
        <Search className="absolute top-1/2 left-[19px] h-3 w-3 -translate-y-1/2 text-muted-foreground" />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && filter) {
              e.preventDefault();
              setFilter('');
            }
          }}
          aria-label="过滤书签树"
          placeholder="过滤树…"
          className="h-7 w-full rounded-sm border border-input bg-card pr-1.5 pl-6 text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>
      {/* 树内过滤（匹配节点自动展开祖先链） */}
      {filter && (
        <div className="flex items-center gap-1 px-2 pb-1">
          <span className="truncate text-[11px] text-accent">
            匹配 {visible.length} 项
          </span>
          <button
            type="button"
            onClick={() => setFilter('')}
            className="ml-auto rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="清除过滤"
            aria-label="清除过滤"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      <div
        ref={listRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onMouseDown={() => listRef.current?.focus({ preventScroll: true })}
        onDragOver={(e) => {
          // 拖放边缘自动滚动：靠近容器顶部/底部时滚动（长树拖拽可达）
          const el = listRef.current;
          if (!el) return;
          const rect = el.getBoundingClientRect();
          const margin = 28;
          if (e.clientY < rect.top + margin) el.scrollTop -= 40;
          else if (e.clientY > rect.bottom - margin) el.scrollTop += 40;
        }}
        role="tree"
        aria-label="书签树"
        className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 outline-none"
      >
        {visible.map(({ node, depth }) => (
          <TreeRow
            key={node.id}
            node={node}
            depth={depth}
            active={node.id === activeId}
            selected={node.id === selectedFolderId}
            dropTarget={dropTarget}
            setDropTarget={setDropTarget}
            filter={filter}
            onActivate={handleActivate}
          />
        ))}
        {visible.length === 0 && (
          <div className="px-2 py-3 text-center">
            {loading ? (
              <p className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                正在加载书签…
              </p>
            ) : loadError ? (
              <>
                <p className="text-[11px] text-destructive">书签加载失败</p>
                <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground/70">{loadError}</p>
                <button
                  type="button"
                  onClick={() => void useBookmarkStore.getState().loadTree()}
                  className="mt-1.5 rounded-sm border border-border bg-card px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-muted"
                >
                  重试
                </button>
              </>
            ) : (
              <p className="text-[11px] text-muted-foreground">{filter ? '没有匹配的书签' : '书签栏为空'}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 单行树节点（文件夹行=拖放进入目标；书签行=行间排序锚点；memo：树刷新时跳过未变化行） */
const TreeRow = memo(function TreeRow({
  node,
  depth,
  active,
  selected,
  dropTarget,
  setDropTarget,
  filter,
  onActivate,
}: {
  node: BNode;
  depth: number;
  active: boolean;
  selected: boolean;
  dropTarget: { nodeId: string; position: 'above' | 'below' } | null;
  setDropTarget: Dispatch<SetStateAction<{ nodeId: string; position: 'above' | 'below' } | null>>;
  /** 树过滤词（匹配部分高亮） */
  filter: string;
  onActivate: (id: string) => void;
}) {
  const isFolder = !node.url;
  const expanded = useBookmarkStore((s) => s.expandedIds.includes(node.id));
  const toggleExpand = useBookmarkStore((s) => s.toggleExpand);
  const selectFolder = useBookmarkStore((s) => s.selectFolder);
  const setContextMenu = useBookmarkStore((s) => s.setContextMenu);
  const [dragOver, setDragOver] = useState(false);
  // 计数器防抖：子元素间移动时 dragleave 会误触发，用进出深度判断真正离开
  const dragDepth = useRef(0);
  // 双击防抖：单击已打开书签，350ms 内的第二次点击忽略，避免双击开两个标签页
  const lastClickAt = useRef(0);
  const isDropTarget = dropTarget?.nodeId === node.id;

  // 拖拽取消（Esc/拖出窗口）时清理本行高亮与深度计数
  useEffect(() => {
    const clear = () => {
      dragDepth.current = 0;
      setDragOver(false);
    };
    window.addEventListener('dragend', clear);
    return () => window.removeEventListener('dragend', clear);
  }, []);

  const handleClick = () => {
    const now = Date.now();
    if (now - lastClickAt.current < 350) return;
    lastClickAt.current = now;
    if (isFolder) {
      toggleExpand(node.id);
      selectFolder(node.id);
    } else if (node.url) {
      void chrome.tabs.create({ url: node.url }).catch(() => {});
    }
  };

  /** 计算相对行的放置方向（上半/下半） */
  const positionOf = (e: DragEvent): 'above' | 'below' => {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientY < rect.top + rect.height / 2 ? 'above' : 'below';
  };

  /** 拖放：文件夹 → 移入；书签 → 行间排序（真实 index 定位）；按住 Ctrl = 复制；多选拖拽批量处理 */
  const handleDrop = (e: DragEvent) => {
    dragDepth.current = 0;
    setDragOver(false);
    setDropTarget(null);
    e.preventDefault();
    e.stopPropagation();
    const raw = e.dataTransfer.getData('text/plain');
    if (!raw) return;
    const dragIds = raw.split(',').filter(Boolean);
    if (dragIds.length === 0) return;
    const isCopy = e.ctrlKey || e.dataTransfer.dropEffect === 'copy';
    // 多选拖放只支持「移入文件夹」；拖到书签行间（排序）时明确提示，避免静默只处理一项
    if (dragIds.length > 1 && !isFolder) {
      pushToast('多选拖放仅支持拖入文件夹', { variant: 'default' });
      return;
    }
    const dragNode = findNode(useBookmarkStore.getState().roots, dragIds[0]!);
    if (!dragNode) return;

    // 复制模式：把源复制到目标（文件夹=复制进其内部；书签行=复制到同层位置）
    if (isCopy) {
      // 防护：不能把文件夹复制到自身或子文件夹内部（会形成怪异嵌套）
      if (dragNode && !dragNode.url && findNode(dragNode.children ?? [], node.id)) {
        pushToast('不能复制到自身或子文件夹', { variant: 'destructive' });
        return;
      }
      const targetParent = isFolder ? node.id : getSiblingPosition(useBookmarkStore.getState().roots, node.id)?.parentId;
      if (!targetParent) return;
      const targetIndex = isFolder
        ? undefined
        : (() => {
            const pos = getSiblingPosition(useBookmarkStore.getState().roots, node.id);
            if (!pos) return undefined;
            return positionOf(e) === 'above' ? pos.index : pos.index + 1;
          })();
      // 多选复制：逐个深拷贝进目标文件夹（复制时多选仅支持移入文件夹，此处 dragIds 恒为单元素或 folder 目标）
      const copyAll = async () => {
        for (const id of dragIds) {
          const n = findNode(useBookmarkStore.getState().roots, id);
          if (n) await copyNodeDeep(n, targetParent, targetIndex);
        }
      };
      void copyAll()
        .then(() => {
          pushToast(`已复制到「${node.title || '(未命名)'}」`, { variant: 'success' });
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

    if (isFolder) {
      // 防护：拖拽源是文件夹时，不能移入自身或子文件夹（chrome API 只会报英文错误）
      for (const id of dragIds) {
        const n = findNode(useBookmarkStore.getState().roots, id);
        if (n && !n.url && findNode(n.children ?? [], node.id)) {
          pushToast('不能移动到自身或子文件夹', { variant: 'destructive' });
          return;
        }
      }
      // 文件夹：移入其中（若折叠则自动展开，便于查看结果）
      if (!expanded) toggleExpand(node.id);
      const moveAll = async () => {
        for (const id of dragIds) {
          if (id === node.id) continue;
          await chrome.bookmarks.move(id, { parentId: node.id });
        }
      };
      void moveAll()
        .then(() => {
          const suffix = dragIds.length > 1 ? `（${dragIds.length} 项）` : '';
          pushToast(`已移动到「${node.title || '(未命名)'}」${suffix}`, { variant: 'success' });
          void useBookmarkStore.getState().loadTree();
        })
        .catch((err: unknown) => {
          pushToast('移动失败', {
            description: err instanceof Error ? err.message : String(err),
            variant: 'destructive',
          });
        });
      return;
    }

    // 书签：行间排序（在目标书签的父目录内定位；单元素路径）
    const pos = getSiblingPosition(useBookmarkStore.getState().roots, node.id);
    if (!pos) return;
    const targetIndex = positionOf(e) === 'above' ? pos.index : pos.index + 1;
    void chrome.bookmarks
      .move(dragIds[0]!, { parentId: pos.parentId, index: targetIndex })
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

  return (
    <div
      data-node-id={node.id}
      role="treeitem"
      aria-expanded={isFolder ? expanded : undefined}
      aria-selected={selected}
      title={node.url ? `${node.title || node.url}\n${node.url}` : node.title}
      draggable={depth > 0} // 根文件夹（书签栏/其他书签/移动端书签）不可拖拽
      onDragStart={(e) => {
        // 多选时拖拽任一所选项 → 拖动全部选中项（逗号分隔，drop 端批量处理）
        const multi = useBookmarkStore.getState().selectedBookmarkIds;
        const ids = multi.includes(node.id) ? multi : [node.id];
        e.dataTransfer.setData('text/plain', ids.join(','));
        e.dataTransfer.effectAllowed = 'copyMove'; // Ctrl+拖拽 = 复制（原生习惯）
      }}
      onDragEnter={(e) => {
        if (isFolder) {
          e.preventDefault();
          dragDepth.current++;
          setDragOver(true);
        } else {
          e.preventDefault();
          dragDepth.current++;
        }
      }}
      onDragOver={(e) => {
        if (isFolder) {
          e.preventDefault();
          e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
        } else {
          // 书签行：实时更新行间定位指示
          e.preventDefault();
          e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
          const position = positionOf(e);
          setDropTarget((prev) =>
            prev && prev.nodeId === node.id && prev.position === position ? prev : { nodeId: node.id, position },
          );
        }
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) {
          setDragOver(false);
          setDropTarget(null);
        }
      }}
      onDragEnd={() => {
        dragDepth.current = 0;
        setDragOver(false);
        setDropTarget(null);
      }}
      onDrop={handleDrop}
      onClick={handleClick}
      onAuxClick={(e) => {
        // 中键：书签在新标签页打开（阻止 Windows 自动滚动）
        if (e.button === 1) {
          e.preventDefault();
          if (node.url) void chrome.tabs.create({ url: node.url }).catch(() => {});
        }
      }}
      onMouseEnter={() => onActivate(node.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        const menu: TreeContextMenu = { x: e.clientX, y: e.clientY, bookmarkId: node.id };
        setContextMenu(menu);
      }}
      className={cn(
        'relative flex h-7 cursor-pointer items-center gap-1.5 rounded-sm pr-2 text-xs transition-colors',
        selected ? 'bg-accent-muted text-accent' : 'text-foreground hover:bg-muted/60',
        active && 'ring-1 ring-inset ring-ring/40',
        dragOver && 'bg-accent-muted/50 ring-1 ring-inset ring-accent/50',
      )}
      style={{ paddingLeft: depth * 12 + 6 }}
    >
      {/* 书签行间拖放定位条（与选中指示条区分：半透明） */}
      {!isFolder && isDropTarget && dropTarget!.position === 'above' && (
        <span className="pointer-events-none absolute -top-0.5 right-1 left-1 h-0.5 rounded-full bg-accent/60" />
      )}
      {!isFolder && isDropTarget && dropTarget!.position === 'below' && (
        <span className="pointer-events-none absolute -bottom-0.5 right-1 left-1 h-0.5 rounded-full bg-accent/60" />
      )}
      {isFolder ? (
        <ChevronRight
          className={cn('h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-100', expanded && 'rotate-90')}
        />
      ) : (
        <span className="w-3 shrink-0" />
      )}
      {isFolder ? (
        <Folder className="h-3.5 w-3.5 shrink-0 text-indigo-500/80" />
      ) : (
        <Favicon url={node.url} size={14} />
      )}
      <span
        className="truncate"
        title="双击重命名"
        onDoubleClick={() => useUIStore.getState().openDialog({ kind: 'rename', bookmarkId: node.id })}
      >
        {highlightTitle(node.title || '(未命名)', filter)}
      </span>
    </div>
  );
});

/** 树过滤高亮：匹配词以 accent 标记（全部匹配，忽略大小写） */
function highlightTitle(text: string, filter: string): ReactNode {
  const q = filter.trim().toLowerCase();
  if (!q) return text;
  const lower = text.toLowerCase();
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

/** 右键菜单项结构（'sep' 为分隔线） */
type MenuItem = {
  icon: typeof Sparkles;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
};
type MenuRow = MenuItem | 'sep';

/** 统一右键菜单（书签树与书签列表共用，按节点类型渲染原生风格菜单项） */
export function ContextMenuOverlay() {
  const menu = useBookmarkStore((s) => s.contextMenu);
  const setContextMenu = useBookmarkStore((s) => s.setContextMenu);
  const roots = useBookmarkStore((s) => s.roots);
  const send = useAIStore((s) => s.send);
  const openDialog = useUIStore((s) => s.openDialog);
  const selectedIds = useBookmarkStore((s) => s.selectedBookmarkIds);
  // 键盘导航：高亮项索引 + 首项聚焦标记
  const [focusIdx, setFocusIdx] = useState(0);
  const menuFocused = useRef(false);

  // Esc 关闭菜单（原生行为）；hooks 必须在提前 return 之前
  useEffect(() => {
    if (!menu) return;
    setFocusIdx(0);
    menuFocused.current = false;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu, setContextMenu]);

  if (!menu) return null;

  const node = findNode(roots, menu.bookmarkId);
  const isFolder = node ? !node.url : false;
  // 根文件夹（书签栏/其他书签/移动设备）不可移动或删除
  const isRootNode = node ? roots.some((r) => r.id === node.id) : false;
  const close = () => setContextMenu(null);
  // 多选状态下右键命中选中行时，删除作用于全部选中（原生多选行为）
  const multiSelected = !!node && selectedIds.includes(node.id) && selectedIds.length > 1;
  const deleteAction = () => {
    close();
    if (multiSelected) openDialog({ kind: 'delete-many', bookmarkIds: [...selectedIds] });
    else openDialog({ kind: 'delete', bookmarkId: node?.id ?? '' });
  };
  /** 打开：多选时批量打开全部选中（去重，最多 25 个） */
  const openAction = () => {
    close();
    if (multiSelected) {
      const urls: string[] = [];
      const seen = new Set<string>();
      for (const id of selectedIds) {
        const n = findNode(roots, id);
        if (n?.url && !seen.has(n.url)) {
          seen.add(n.url);
          urls.push(n.url);
        }
      }
      if (urls.length === 0) {
        pushToast('所选内容没有可打开的网址');
        return;
      }
      const list = urls.slice(0, 25);
      if (urls.length > 25) pushToast(`书签过多，仅打开前 25 个（共 ${urls.length} 个）`);
      for (const u of list) void chrome.tabs.create({ url: u }).catch(() => {});
      if (list.length > 0) pushToast(`已打开 ${list.length} 个标签页`, { variant: 'success' });
      return;
    }
    if (node?.url) void chrome.tabs.create({ url: node.url }).catch(() => {});
  };
  /** 后台打开：多选时批量（去重，最多 25 个） */
  const openBackgroundAction = () => {
    close();
    if (multiSelected) {
      const urls: string[] = [];
      const seen = new Set<string>();
      for (const id of selectedIds) {
        const n = findNode(roots, id);
        if (n?.url && !seen.has(n.url)) {
          seen.add(n.url);
          urls.push(n.url);
        }
      }
      const list = urls.slice(0, 25);
      if (urls.length === 0) {
        pushToast('所选内容没有可打开的网址');
        return;
      }
      if (urls.length > 25) pushToast(`书签过多，仅打开前 25 个（共 ${urls.length} 个）`);
      for (const u of list) void chrome.tabs.create({ url: u, active: false }).catch(() => {});
      if (list.length > 0) pushToast(`已打开 ${list.length} 个标签页`, { variant: 'success' });
      return;
    }
    if (node?.url) void chrome.tabs.create({ url: node.url, active: false }).catch(() => {});
  };
  /** 新窗口打开：多选时批量（去重，最多 25 个） */
  const openWindowAction = async () => {
    close();
    if (multiSelected) {
      const urls: string[] = [];
      const seen = new Set<string>();
      for (const id of selectedIds) {
        const n = findNode(roots, id);
        if (n?.url && !seen.has(n.url)) {
          seen.add(n.url);
          urls.push(n.url);
        }
      }
      const list = urls.slice(0, 25);
      if (list.length === 0) {
        pushToast('所选内容没有可打开的网址');
        return;
      }
      if (urls.length > 25) pushToast(`书签过多，仅打开前 25 个（共 ${urls.length} 个）`);
      try {
        const win = await chrome.windows.create({ url: list[0], focused: true });
        if (win?.id !== undefined) {
          for (const u of list.slice(1)) void chrome.tabs.create({ windowId: win.id, url: u }).catch(() => {});
        }
      } catch {
        pushToast('打开失败', { variant: 'destructive' });
      }
      return;
    }
    if (node?.url) void chrome.windows.create({ url: node.url, focused: true }).catch(() => {});
  };
  /** 标签页组打开：多选时批量（去重，最多 25 个）；单行为文件夹时递归收集子项 */
  const openGroupAction = async () => {
    close();
    const urls: string[] = [];
    const seen = new Set<string>();
    const collect = (n: BNode) => {
      if (n.url && !seen.has(n.url)) {
        seen.add(n.url);
        urls.push(n.url);
      }
      for (const c of n.children ?? []) collect(c);
    };
    if (multiSelected) {
      for (const id of selectedIds) {
        const n = findNode(roots, id);
        if (n) collect(n);
      }
    } else if (node) {
      collect(node);
    }
    const list = urls.slice(0, 25);
    if (list.length === 0) {
      pushToast('所选内容没有可打开的网址');
      return;
    }
    if (urls.length > 25) pushToast(`书签过多，仅打开前 25 个（共 ${urls.length} 个）`);
    try {
      const tabs = await Promise.all(list.map((url) => chrome.tabs.create({ url, active: false })));
      const tabIds = tabs.map((t) => t.id).filter((id): id is number => id !== undefined);
      if (tabIds.length > 0) {
        const groupId = (await chrome.tabs.group({ tabIds: tabIds as [number, ...number[]] })) as unknown as number;
        await chrome.tabGroups.update(groupId, { title: multiSelected ? `所选 ${tabIds.length} 个页面` : node?.title || '(未命名)' }).catch(() => {});
        await chrome.tabGroups.update(groupId, { collapsed: true }).catch(() => {});
      }
      pushToast(`已在标签页组中打开 ${tabIds.length} 个页面`, { variant: 'success' });
    } catch {
      pushToast('打开失败', { variant: 'destructive' });
    }
  };
  /** 复制网址：多选时批量复制全部选中 */
  const copyUrlsAction = () => {
    close();
    if (multiSelected) {
      const urls = selectedIds
        .map((id) => findNode(roots, id))
        .filter((n): n is BNode & { url: string } => !!n?.url)
        .map((n) => n.url);
      if (urls.length === 0) {
        pushToast('所选内容没有可复制的网址');
        return;
      }
      void copyText(urls.join('\n'), `已复制 ${urls.length} 个网址`);
      return;
    }
    void copyText(node?.url ?? '');
  };
  /** 复制为 Markdown：多选时批量生成列表 */
  const copyMarkdownAction = () => {
    close();
    if (multiSelected) {
      const lines = selectedIds
        .map((id) => findNode(roots, id))
        .filter((n): n is BNode & { url: string } => !!n?.url)
        .map((n) => `- [${(n.title || n.url).replace(/[[\]]/g, '')}](${n.url})`);
      if (lines.length === 0) {
        pushToast('所选内容没有可复制的网址');
        return;
      }
      void copyText(lines.join('\n'), `已复制 ${lines.length} 条 Markdown`);
      return;
    }
    if (node?.url) void copyText(`[${node.title || node.url}](${node.url})`, '已复制 Markdown 链接');
  };
  /** 分析/整理：多选时批量交给 Agent */
  const analyzeAction = () => {
    close();
    if (multiSelected) {
      const shown = selectedIds
        .map((id) => findNode(roots, id))
        .filter((n): n is BNode => !!n)
        .slice(0, 30);
      const list = shown
        .map((n, i) => `${i + 1}. ${n.title || n.url}${n.url ? ` (${n.url})` : ''} [id: ${n.id}]`)
        .join('\n');
      void send(`请整理我选中的 ${selectedIds.length} 个书签（以下列出前 ${shown.length} 个）：\n${list}\n创建合适的分类并归类移动，完成后简要汇报。`);
      return;
    }
    sendChat(`请分析书签「${node?.title || '(未命名)'}」${node?.url ? `（${node.url}）` : ''}：检查链接是否有效、内容是否过时，给出整理或清理建议。`);
  };

  const sendChat = (text: string, folderId?: string) => {
    close();
    void send(text, folderId ? { folderId } : undefined);
  };

  /** 打开文件夹内全部书签（新标签页，最多 25 个防刷屏；重复 URL 去重） */
  const openAll = () => {
    close();
    if (!node) return;
    const urls: string[] = [];
    const seen = new Set<string>();
    const collect = (n: BNode) => {
      if (n.url && !seen.has(n.url)) {
        seen.add(n.url);
        urls.push(n.url);
      }
      for (const c of n.children ?? []) collect(c);
    };
    collect(node);
    if (urls.length === 0) {
      pushToast('此文件夹没有书签');
      return;
    }
    const openCount = Math.min(urls.length, 25);
    if (urls.length > 25) pushToast(`书签过多，仅打开前 25 个（共 ${urls.length} 个）`);
    for (const url of urls.slice(0, openCount)) void chrome.tabs.create({ url }).catch(() => {});
    pushToast(`已打开 ${openCount} 个标签页`, { variant: 'success' });
  };

  /** 打开文件夹内全部书签（新窗口，最多 25 个防刷屏；重复 URL 去重） */
  const openAllInWindow = async () => {
    close();
    if (!node) return;
    const urls: string[] = [];
    const seen = new Set<string>();
    const collect = (n: BNode) => {
      if (n.url && !seen.has(n.url)) {
        seen.add(n.url);
        urls.push(n.url);
      }
      for (const c of n.children ?? []) collect(c);
    };
    collect(node);
    if (urls.length === 0) {
      pushToast('此文件夹没有书签');
      return;
    }
    const list = urls.slice(0, 25);
    if (urls.length > 25) pushToast(`书签过多，仅打开前 25 个（共 ${urls.length} 个）`);
    try {
      const win = await chrome.windows.create({ url: list[0], focused: true });
      if (win?.id !== undefined) {
        for (const url of list.slice(1)) void chrome.tabs.create({ windowId: win.id, url }).catch(() => {});
      }
    } catch {
      pushToast('打开失败', { variant: 'destructive' });
    }
  };

  /** 打开文件夹内全部书签（标签页组，最多 25 个防刷屏；重复 URL 去重） */
  const openAllInGroup = async () => {
    close();
    if (!node) return;
    const urls: string[] = [];
    const seen = new Set<string>();
    const collect = (n: BNode) => {
      if (n.url && !seen.has(n.url)) {
        seen.add(n.url);
        urls.push(n.url);
      }
      for (const c of n.children ?? []) collect(c);
    };
    collect(node);
    if (urls.length === 0) {
      pushToast('此文件夹没有书签');
      return;
    }
    const list = urls.slice(0, 25);
    if (urls.length > 25) pushToast(`书签过多，仅打开前 25 个（共 ${urls.length} 个）`);
    try {
      // 并行创建标签页后统一分组
      const tabs = await Promise.all(list.map((url) => chrome.tabs.create({ url, active: false })));
      const tabIds = tabs.map((t) => t.id).filter((id): id is number => id !== undefined);
      if (tabIds.length > 0) {
        // @types/chrome 中 group 返回类型为 Promise<number> & void，此处断言取 id
        const groupId = (await chrome.tabs.group({ tabIds: tabIds as [number, ...number[]] })) as unknown as number;
        await chrome.tabGroups.update(groupId, { title: node.title || '(未命名)' }).catch(() => {});
        // 组折叠，避免刷屏（用户可展开）
        await chrome.tabGroups.update(groupId, { collapsed: true }).catch(() => {});
      }
      pushToast(`已在标签页组中打开 ${tabIds.length} 个页面`, { variant: 'success' });
    } catch {
      pushToast('打开失败', { variant: 'destructive' });
    }
  };

  /** 节点当前所在的根文件夹（书签栏/其他书签/移动设备） */
  const nodeRootId = (): string | undefined => {
    let cur: BNode | null = node;
    let depth = 0;
    while (cur && depth++ < 32) {
      if (roots.some((r) => r.id === cur!.id)) return cur!.id;
      cur = cur.parentId ? findNode(roots, cur.parentId) : null;
    }
    return undefined;
  };

  /** 移动到其他根文件夹（书签栏/其他书签/移动设备）；根文件夹自身不可移动；多选时批量 */
  const moveTargets = isRootNode ? [] : roots.filter((r) => r.id !== nodeRootId());
  const moveTo = (targetId: string, title: string) => {
    close();
    const ids = multiSelected ? [...selectedIds] : node ? [node.id] : [];
    if (ids.length === 0) return;
    void Promise.allSettled(ids.map((id) => chrome.bookmarks.move(id, { parentId: targetId })))
      .then((results) => {
        const ok = results.filter((r) => r.status === 'fulfilled').length;
        const fail = results.length - ok;
        pushToast(
          ok > 0 ? `已移动 ${ok} 项至「${title}」` : '移动失败',
          fail > 0 && ok > 0
            ? { description: `${fail} 项移动失败`, variant: 'destructive' }
            : { variant: ok > 0 ? 'success' : 'destructive' },
        );
        if (multiSelected) useBookmarkStore.getState().clearSelection();
        void useBookmarkStore.getState().loadTree();
      })
      .catch((err: unknown) => {
        pushToast('移动失败', {
          description: err instanceof Error ? err.message : String(err),
          variant: 'destructive',
        });
      });
  };

  const moveRows: MenuRow[] =
    moveTargets.length > 0
      ? [
          'sep',
          ...moveTargets.map((r) => ({
            icon: FolderInput,
            label: `移至「${r.title || '(未命名)'}」`,
            onClick: () => moveTo(r.id, r.title || '(未命名)'),
          })),
        ]
      : [];

  /** 文件夹整体复制为嵌套 Markdown 列表（文档场景） */
  const copyFolderMarkdown = () => {
    close();
    if (!node) return;
    const lines: string[] = [];
    const walk = (n: BNode, depth: number) => {
      const pad = '  '.repeat(depth);
      if (n.url) {
        const title = (n.title || n.url).replace(/[[\]]/g, '');
        lines.push(`${pad}- [${title}](${n.url})`);
      } else {
        lines.push(`${pad}- **${n.title || '(未命名)'}**`);
        for (const c of n.children ?? []) walk(c, depth + 1);
      }
    };
    walk(node, 0);
    if (lines.length === 0) {
      pushToast('此文件夹没有内容');
      return;
    }
    void copyText(lines.join('\n'), `已复制 ${lines.length} 行 Markdown`);
  };

  const rows: MenuRow[] = isFolder
    ? [
        { icon: FolderOpen, label: '在新标签页中打开全部', onClick: openAll },
        { icon: AppWindow, label: '在新窗口中打开全部', onClick: () => void openAllInWindow() },
        { icon: LayoutGrid, label: multiSelected ? `在标签页组中打开（${selectedIds.length}）` : '在标签页组中打开', onClick: () => void openGroupAction() },
        { icon: Copy, label: '复制为 Markdown 列表', onClick: copyFolderMarkdown },
        { icon: Link2, label: '复制路径', onClick: () => { close(); if (node) void copyText(resolveTitlePath(roots, node.id), '已复制文件夹路径'); } },
        { icon: FolderPlus, label: '新建子文件夹', onClick: () => { close(); openDialog({ kind: 'create-folder', parentId: node?.id ?? '' }); } },
        { icon: BookmarkPlus, label: '新建书签', onClick: () => { close(); openDialog({ kind: 'create-bookmark', parentId: node?.id ?? '' }); } },
        'sep',
        { icon: LocateFixed, label: '在树中显示', disabled: isRootNode || multiSelected, onClick: () => { close(); useBookmarkStore.getState().revealInTree(node?.id ?? ''); } },
        { icon: ChevronsUpDown, label: '展开此分支', onClick: () => { close(); useBookmarkStore.getState().expandBranch(node?.id ?? ''); } },
        { icon: ChevronsDownUp, label: '折叠其他', onClick: () => { close(); useBookmarkStore.getState().collapseOthers(node?.id ?? ''); } },
        ...moveRows,
        'sep',
        { icon: Sparkles, label: '让 MarkAI 整理', onClick: () => sendChat(`请整理书签文件夹「${node?.title || '(未命名)'}」：浏览其全部书签，创建合适的子分类并归类移动。`, node?.id) },
        { icon: ScanSearch, label: '让 MarkAI 分析', onClick: () => sendChat(`请分析书签文件夹「${node?.title || '(未命名)'}」：检查内容是否过时，给出整理或清理建议。`) },
        { icon: Pencil, label: '重命名', disabled: isRootNode, onClick: () => { close(); openDialog({ kind: 'rename', bookmarkId: node?.id ?? '' }); } },
        { icon: Trash2, label: multiSelected ? `删除所选（${selectedIds.length}）` : '删除', danger: true, disabled: isRootNode, onClick: deleteAction },
      ]
    : [
        { icon: ExternalLink, label: '打开', onClick: openAction },
        { icon: FolderPlus, label: multiSelected ? `在新标签页中打开（${selectedIds.length}）` : '在新标签页中打开', onClick: openBackgroundAction },
        { icon: AppWindow, label: multiSelected ? `在新窗口中打开（${selectedIds.length}）` : '在新窗口中打开', onClick: () => void openWindowAction() },
        { icon: Copy, label: multiSelected ? `复制网址（${selectedIds.length}）` : '复制网址', onClick: copyUrlsAction },
        { icon: Link2, label: multiSelected ? `复制为 Markdown（${selectedIds.length}）` : '复制为 Markdown', onClick: copyMarkdownAction },
        { icon: Route, label: '复制所在路径', onClick: () => { close(); if (node?.parentId) void copyText(resolveTitlePath(roots, node.parentId), '已复制所在文件夹路径'); } },
        { icon: Pencil, label: '编辑网址', onClick: () => { close(); openDialog({ kind: 'edit-url', bookmarkId: node?.id ?? '' }); } },
        'sep',
        { icon: LocateFixed, label: '在树中显示', disabled: isRootNode || multiSelected, onClick: () => { close(); useBookmarkStore.getState().revealInTree(node?.id ?? ''); } },
        ...moveRows,
        'sep',
        { icon: ScanSearch, label: multiSelected ? `让 MarkAI 整理所选（${selectedIds.length}）` : '让 MarkAI 分析', onClick: analyzeAction },
        { icon: Pencil, label: '重命名', onClick: () => { close(); openDialog({ kind: 'rename', bookmarkId: node?.id ?? '' }); } },
        { icon: Trash2, label: multiSelected ? `删除所选（${selectedIds.length}）` : '删除', danger: true, onClick: deleteAction },
      ];

  // 边缘钳制（含超窄窗口下限），避免菜单溢出屏幕
  // 行高约 28px（py-1.5 + text-xs），分隔线额外约 8px（my-1）
  const rowCount = rows.filter((r) => r !== 'sep').length;
  const sepCount = rows.filter((r) => r === 'sep').length;
  const left = Math.max(8, Math.min(menu.x, window.innerWidth - 196));
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - rowCount * 28 - sepCount * 8 - 16));

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
      <div
        role="menu"
        tabIndex={-1}
        onKeyDown={(e) => {
          // 键盘导航：↑↓ 移动（跳过分隔），Enter 激活，Esc 关闭
          const items = rows
            .map((r, i) => (r === 'sep' ? null : { row: r, i }))
            .filter((x): x is { row: MenuItem; i: number } => !!x);
          if (items.length === 0) return;
          const cur = items.findIndex((x) => x.i === focusIdx);
          const step = (delta: number) => {
            e.preventDefault();
            // 跳过禁用项（如根文件夹的删除/重命名）
            let idx = Math.max(0, Math.min(cur + delta, items.length - 1));
            while (items[idx]?.row.disabled && idx > 0 && idx < items.length - 1) idx += delta;
            const next = items[idx];
            if (next) setFocusIdx(next.i);
          };
          if (e.key === 'ArrowDown') step(1);
          else if (e.key === 'ArrowUp') step(-1);
          else if (e.key === 'Home') {
            e.preventDefault();
            setFocusIdx(items[0]!.i);
          } else if (e.key === 'End') {
            e.preventDefault();
            setFocusIdx(items[items.length - 1]!.i);
          } else if (e.key === 'Enter' && cur >= 0) {
            e.preventDefault();
            const item = items[cur]!.row;
            if (!item.disabled) item.onClick();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            close();
          } else if (e.key === 'Tab') {
            // 原生菜单：Tab 关闭
            e.preventDefault();
            close();
          }
        }}
        className="animate-fade-in fixed z-50 max-h-[calc(100vh-16px)] w-48 overflow-y-auto rounded-sm border border-border bg-card py-1 outline-none"
        style={{ left, top }}
      >
        {rows.map((row, i) =>
          row === 'sep' ? (
            <Separator key={`sep-${i}`} className="my-1" />
          ) : (
            <button
              key={row.label}
              ref={(el) => {
                if (el && i === focusIdx) {
                  // 高亮项滚动可见 + 聚焦（键盘导航）
                  el.scrollIntoView({ block: 'nearest' });
                  if (!menuFocused.current) {
                    menuFocused.current = true;
                    el.focus();
                  }
                }
              }}
              type="button"
              disabled={row.disabled}
              onClick={row.onClick}
              onMouseEnter={() => setFocusIdx(i)}
              className={cn(
                'flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs transition-colors disabled:pointer-events-none disabled:opacity-40',
                i === focusIdx ? 'bg-muted/60' : '',
                row.danger ? 'text-destructive hover:bg-destructive/10' : 'text-foreground hover:bg-muted/60',
              )}
            >
              <row.icon className="h-3.5 w-3.5" />
              {row.label}
            </button>
          ),
        )}
      </div>
    </>
  );
}

/** 在树中查找节点 */
function findNode(nodes: BNode[], id: string): BNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children) {
      const found = findNode(n.children, id);
      if (found) return found;
    }
  }
  return null;
}

/** 查找节点在其父目录中的真实位置（行间排序用） */
function getSiblingPosition(nodes: BNode[], id: string): { parentId: string; index: number } | null {
  for (const n of nodes) {
    if (n.id === id) return null; // 根文件夹不可作为排序目标
    if (n.children) {
      const idx = n.children.findIndex((c) => c.id === id);
      if (idx >= 0) return { parentId: n.id, index: idx };
      const found = getSiblingPosition(n.children, id);
      if (found) return found;
    }
  }
  return null;
}
