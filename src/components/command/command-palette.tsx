import {
  Bookmark as BookmarkIcon,
  BookmarkPlus,
  Clock,
  CornerDownLeft,
  Folder,
  LayoutDashboard,
  LayoutList,
  Search,
  ShieldCheck,
  Sparkles,
  Sun,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useBookmarkStore } from '@/stores/bookmarkStore';
import { useUIStore } from '@/stores/uiStore';
import { useThemeStore } from '@/stores/themeStore';
import { flattenBookmarks } from '@/lib/bookmarks/timeline';
import { searchCommands, type CommandItem } from '@/lib/command/search';
import { buildPaletteGroups, type PaletteGroup } from '@/lib/command/palette';
import { readRecent, recordRecent, type RecentEntry } from '@/lib/command/recent';
import { keywordHits, searchBookmarks, type SemanticHit } from '@/lib/features/semantic';
import { reasonLabel } from '@/lib/search/semantic/search';
import { openUrl } from '@/lib/open-url';
import { cn } from '@/lib/utils';

type BNode = chrome.bookmarks.BookmarkTreeNode;

/** 动作图标的轻量映射：CommandItem 是纯数据，不把 React 组件塞进 lib */
const ACTION_ICONS: Record<string, typeof Sparkles> = {
  overview: LayoutDashboard,
  list: LayoutList,
  timeline: Clock,
  insights: ShieldCheck,
  save: BookmarkPlus,
  theme: Sun,
};

function iconFor(item: CommandItem) {
  if (item.kind === 'folder') return Folder;
  if (item.kind === 'bookmark') return BookmarkIcon;
  return ACTION_ICONS[item.iconKey ?? ''] ?? Sparkles;
}

/**
 * ⌘K 的书签结果走异步混合检索。
 *
 * 先同步塞入关键词结果，再在 100ms 抖动后换成 `searchBookmarks` 的结果——
 * 索引尚未建好或远端很慢时，面板不会先闪一下空白。`asOf` 用来判断
 * "这批结果是不是当前查询的"，避免旧结果盖在新输入上。
 */
function useSemanticBookmarks(
  open: boolean,
  roots: BNode[],
  query: string,
): { hits: SemanticHit[]; asOf: string } {
  const [state, setState] = useState<{ hits: SemanticHit[]; asOf: string }>({ hits: [], asOf: '' });
  useEffect(() => {
    const q = query.trim();
    if (!open || !q) {
      setState({ hits: [], asOf: '' });
      return;
    }
    let cancelled = false;
    setState({ hits: keywordHits(roots, q, { limit: 20 }), asOf: q });
    const timer = setTimeout(() => {
      void searchBookmarks(roots, q, { limit: 20 })
        .then((result) => {
          if (!cancelled) setState({ hits: result.hits, asOf: q });
        })
        .catch(() => {});
    }, 100);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, roots, query]);
  return state;
}

/** 书签组由混合检索结果替换；其余分组（动作/文件夹）保持同步关键词排序 */
function useSemanticPaletteGroups(
  all: CommandItem[],
  query: string,
  recent: readonly RecentEntry[],
  hits: SemanticHit[],
  asOf: string,
): PaletteGroup[] {
  return useMemo(() => {
    const q = query.trim();
    const syncGroups = buildPaletteGroups(all, q, recent, 40);
    if (!q || asOf !== q || hits.length === 0) return syncGroups;

    const bookmarkGroup: PaletteGroup = {
      kind: 'bookmark',
      label: '书签',
      items: hits.map((hit) => ({
        id: `bm:${hit.id}`,
        kind: 'bookmark' as const,
        title: hit.title,
        subtitle: `${reasonLabel(hit.reason)} · ${hit.path}`,
        url: hit.url,
      })),
    };
    const others = syncGroups.filter((group) => group.kind !== 'bookmark');
    // 精确/前缀命中要显眼：放到动作与文件夹之前
    const pinned = hits.some((hit) => hit.reason === 'exact' || hit.reason === 'prefix');
    return pinned ? [bookmarkGroup, ...others] : [...others, bookmarkGroup];
  }, [all, query, recent, hits, asOf]);
}

/**
 * 命令面板（⌘K / Ctrl+K）。
 *
 * 一个输入框做三件事：搜书签、跳文件夹、执行动作。
 * v2 的两点变化：
 *  1. 空查询不再按输入顺序甩出前 40 条，而是「最近使用 → 常用动作 → 文件夹」；
 *  2. 视图/体检/收藏当前页也进了动作列表——键盘用户不必去顶栏找按钮。
 *
 * 键盘：↑↓ / Home / End 选择，Enter 执行，Esc 关闭；鼠标同样可用。
 */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const roots = useBookmarkStore((s) => s.roots);
  const selectFolder = useBookmarkStore((s) => s.selectFolder);
  const revealInTree = useBookmarkStore((s) => s.revealInTree);
  const setSearchQuery = useBookmarkStore((s) => s.setSearchQuery);
  const setTreeCollapsed = useUIStore((s) => s.setTreeCollapsed);

  // 打开时清空输入、高亮与"最近"快照
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    setRecent(readRecent());
    // 等浮层挂载后再聚焦，否则拿不到元素
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  /** 数据源：动作 + 文件夹 + 全部书签（顺序决定同分时的先后） */
  const all = useMemo<CommandItem[]>(() => {
    const view = (mode: 'overview' | 'list' | 'timeline') =>
      document.dispatchEvent(new CustomEvent('markai:view', { detail: mode }));

    const actions: CommandItem[] = [
      {
        id: 'action:view-overview',
        kind: 'action',
        title: '书签概览',
        subtitle: '库的状态、管家建议与最近整理',
        iconKey: 'overview',
        run: () => view('overview'),
      },
      {
        id: 'action:view-list',
        kind: 'action',
        title: '列表视图',
        subtitle: '按文件夹查看书签',
        iconKey: 'list',
        run: () => view('list'),
      },
      {
        id: 'action:view-timeline',
        kind: 'action',
        title: '时间线',
        subtitle: '按收藏时间看全部书签',
        iconKey: 'timeline',
        run: () => view('timeline'),
      },
      {
        id: 'action:insights',
        kind: 'action',
        title: '书签体检',
        subtitle: '重复链接、空文件夹与库的规模',
        iconKey: 'insights',
        run: () => {
          view('overview');
          // 概览面板挂载后再打开体检；同一帧里发事件会收不到
          setTimeout(() => document.dispatchEvent(new CustomEvent('markai:open-insights')), 80);
        },
      },
      {
        id: 'action:save-current-tab',
        kind: 'action',
        title: '收藏当前页面',
        subtitle: '存到书签栏',
        iconKey: 'save',
        run: () => document.dispatchEvent(new CustomEvent('markai:save-current-tab')),
      },
      {
        id: 'action:organize-log',
        kind: 'action',
        title: '打开整理记录',
        subtitle: '自动整理做了哪些事、失败可重试',
        run: () => document.dispatchEvent(new CustomEvent('markai:open-organize-log')),
      },
      {
        id: 'action:deletions',
        kind: 'action',
        title: '打开待删除清单',
        subtitle: '确认或放弃 Agent 提交的删除提议',
        run: () => document.dispatchEvent(new CustomEvent('markai:open-deletions')),
      },
      {
        id: 'action:theme',
        kind: 'action',
        title: '切换浅色 / 深色主题',
        subtitle: '与设置页共用同一份主题存储',
        iconKey: 'theme',
        run: () => {
          const s = useThemeStore.getState();
          const dark =
            s.theme === 'dark' ||
            (s.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
          void s.setTheme(dark ? 'light' : 'dark');
        },
      },
      {
        id: 'action:settings',
        kind: 'action',
        title: '打开设置',
        subtitle: 'AI 服务、上下文、主题、数据',
        run: () => void chrome.runtime.openOptionsPage(),
      },
      {
        id: 'action:shortcuts',
        kind: 'action',
        title: '快捷键与操作',
        subtitle: '全部键盘操作速查',
        run: () => document.dispatchEvent(new CustomEvent('markai:open-shortcuts')),
      },
      {
        id: 'action:clear-search',
        kind: 'action',
        title: '清除搜索',
        subtitle: '回到完整列表',
        run: () => setSearchQuery(''),
      },
      {
        id: 'action:toggle-tree',
        kind: 'action',
        title: '展开 / 收起书签树',
        subtitle: '给中栏让出宽度',
        run: () => setTreeCollapsed(!useUIStore.getState().treeCollapsed),
      },
    ];

    const folders: CommandItem[] = [];
    const bookmarks: CommandItem[] = [];
    for (const item of flattenBookmarks(roots)) {
      bookmarks.push({
        id: `bm:${item.id}`,
        kind: 'bookmark',
        title: item.title,
        subtitle: item.path,
        url: item.url,
      });
    }
    const walk = (nodes: typeof roots) => {
      for (const n of nodes) {
        if (!n.url) {
          folders.push({ id: `fd:${n.id}`, kind: 'folder', title: n.title || '(未命名)', subtitle: '文件夹' });
          if (n.children) walk(n.children);
        }
      }
    };
    walk(roots);

    return [...actions, ...folders, ...bookmarks];
  }, [roots, setSearchQuery, setTreeCollapsed]);

  const semanticBookmarks = useSemanticBookmarks(open, roots, query);
  const paletteGroups = useSemanticPaletteGroups(all, query, recent, semanticBookmarks.hits, semanticBookmarks.asOf);
  const flat = useMemo(() => paletteGroups.flatMap((g) => g.items), [paletteGroups]);
  /** 命中原因只用于副标题与小标记；排序已经由 searchBookmarks 决定 */
  const reasonById = useMemo(
    () =>
      new Map<string, SemanticHit['reason']>(
        semanticBookmarks.hits.map((hit) => [`bm:${hit.id}`, hit.reason]),
      ),
    [semanticBookmarks.hits],
  );

  // 查询/数据变化后高亮回到第一条
  useEffect(() => {
    setActive(0);
  }, [query, paletteGroups.length]);

  // 高亮项滚动进视野
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const runItem = (item: CommandItem) => {
    onOpenChange(false);
    if (item.kind === 'bookmark') {
      recordRecent({
        id: item.id,
        kind: 'bookmark',
        title: item.title,
        ...(item.subtitle ? { subtitle: item.subtitle } : {}),
        ...(item.url ? { url: item.url } : {}),
      });
      if (item.url) void openUrl(item.url);
      return;
    }
    if (item.kind === 'folder') {
      const id = item.id.replace(/^fd:/, '');
      recordRecent({ id: item.id, kind: 'folder', title: item.title, subtitle: item.subtitle });
      selectFolder(id);
      revealInTree(id);
      return;
    }
    item.run?.();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-foreground/25 px-4 pt-[12vh] backdrop-blur-[2px]"
      onClick={() => onOpenChange(false)}
    >
      <div
        role="dialog"
        data-testid="command-palette"
        aria-modal="true"
        aria-label="命令面板"
        className="markai-glass markai-glass-liquid relative animate-fade-in w-full max-w-xl overflow-hidden rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, flat.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Home') {
                e.preventDefault();
                setActive(0);
              } else if (e.key === 'End') {
                e.preventDefault();
                setActive(Math.max(0, flat.length - 1));
              } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                const item = flat[active];
                if (item) runItem(item);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onOpenChange(false);
              }
            }}
            placeholder="搜书签、文件夹，或执行动作…"
            aria-label="命令面板输入"
            spellCheck={false}
            className="h-12 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/70"
          />
          <kbd className="hidden shrink-0 rounded-md border border-border bg-card/60 px-1.5 py-0.5 text-2xs text-muted-foreground sm:block">
            Esc
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[56vh] overflow-y-auto p-1.5">
          {flat.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-xs text-muted-foreground">没有匹配「{query.trim()}」的书签、文件夹或动作</p>
              <p className="mt-1 text-2xs text-muted-foreground/70">
                试试只输入网站名，或按 Esc 回到完整列表
              </p>
            </div>
          ) : (
            paletteGroups.map((group) => (
              <div key={group.kind} className="mb-1">
                <p className="flex items-center gap-2 px-2.5 pt-2 pb-1 text-2xs font-medium text-muted-foreground/80">
                  {group.label}
                  <span className="tabular-nums text-muted-foreground/50">{group.items.length}</span>
                </p>
                {group.items.map((item) => {
                  const idx = flat.indexOf(item);
                  const Icon = iconFor(item);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      data-testid="command-item"
                      data-kind={item.kind}
                      data-idx={idx}
                      data-reason={reasonById.get(item.id)}
                      onMouseEnter={() => setActive(idx)}
                      onClick={() => runItem(item)}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                        idx === active ? 'bg-accent-muted' : 'hover:bg-muted',
                      )}
                    >
                      <span
                        className={cn(
                          'flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
                          idx === active ? 'bg-card text-accent' : 'bg-muted text-muted-foreground',
                        )}
                      >
                        <Icon className="h-3.5 w-3.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="block min-w-0 truncate text-xs font-medium text-foreground">{item.title}</span>
                          {reasonById.get(item.id) === 'semantic' && (
                            <span
                              className="flex shrink-0 items-center gap-0.5 rounded-xs bg-accent-muted px-1 py-0.5 text-2xs leading-none text-accent"
                              aria-label="语义命中"
                              data-testid="semantic-badge"
                            >
                              <Sparkles className="h-3 w-3" />
                              语义
                            </span>
                          )}
                        </span>
                        {item.subtitle && (
                          <span className="block truncate text-2xs text-muted-foreground">{item.subtitle}</span>
                        )}
                      </span>
                      {idx === active && (
                        <CornerDownLeft className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2 text-2xs text-muted-foreground/70">
          <span className="flex items-center gap-2">
            <span>↑↓ 选择</span>
            <span>↵ 打开</span>
            <span>Esc 关闭</span>
          </span>
          <span className="tabular-nums">{flat.length} 项</span>
        </div>
      </div>
    </div>
  );
}
