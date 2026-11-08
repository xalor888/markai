import { CornerDownLeft, Folder, Search, Sparkles, Bookmark as BookmarkIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useBookmarkStore } from '@/stores/bookmarkStore';
import { useUIStore } from '@/stores/uiStore';
import { flattenBookmarks } from '@/lib/bookmarks/timeline';
import { groupCommands, searchCommands, type CommandItem } from '@/lib/command/search';
import { openUrl } from '@/lib/open-url';
import { cn } from '@/lib/utils';

/**
 * 命令面板（⌘K / Ctrl+K）。
 *
 * 一个输入框做三件事：搜书签、跳文件夹、执行动作。
 * 重做前这三件事分散在：中栏搜索框（只能搜书签）、左侧树（只能点着找）、
 * 顶栏一排图标（每个动作一个位置，找起来靠记忆）。命令面板把它们并成一条路径。
 *
 * 键盘：↑↓ 选择、Enter 执行、Esc 关闭。鼠标也能点（鼠标用户不该被排除）。
 */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const roots = useBookmarkStore((s) => s.roots);
  const selectFolder = useBookmarkStore((s) => s.selectFolder);
  const revealInTree = useBookmarkStore((s) => s.revealInTree);
  const setSearchQuery = useBookmarkStore((s) => s.setSearchQuery);
  const setTreeCollapsed = useUIStore((s) => s.setTreeCollapsed);

  // 打开时清空上一次的输入与高亮
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    // 等浮层挂载后再聚焦，否则拿不到元素
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  /** 数据源：动作 + 文件夹 + 全部书签（顺序决定同分时的先后） */
  const all = useMemo<CommandItem[]>(() => {
    const actions: CommandItem[] = [
      {
        id: 'action:organize-log',
        kind: 'action',
        title: '打开整理记录',
        subtitle: '自动整理做了哪些事、失败可重试',
        run: () => {
          // 由 workspace 通过 DOM 事件转交，避免把一堆 setState 塞进面板
          document.dispatchEvent(new CustomEvent('markai:open-organize-log'));
        },
      },
      {
        id: 'action:deletions',
        kind: 'action',
        title: '打开待删除清单',
        subtitle: '确认或放弃 Agent 提交的删除提议',
        run: () => document.dispatchEvent(new CustomEvent('markai:open-deletions')),
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
        run: () => setTreeCollapsed(!useUIStore.getState().treeCollapsed),
      },
    ];

    const folders: CommandItem[] = [];
    const bookmarks: CommandItem[] = [];
    for (const item of flattenBookmarks(roots)) {
      // flattenBookmarks 只产出**书签个体**（不含文件夹），文件夹由下面单独收
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

  const results = useMemo(() => searchCommands(all, query, 40), [all, query]);
  const groups = useMemo(() => groupCommands(results), [results]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  // 结果变化后高亮回到第一条
  useEffect(() => {
    setActive(0);
  }, [query]);

  // 高亮项滚动进视野
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const runItem = (item: CommandItem) => {
    onOpenChange(false);
    if (item.kind === 'bookmark' && item.url) {
      void openUrl(item.url);
      return;
    }
    if (item.kind === 'folder') {
      const id = item.id.replace(/^fd:/, '');
      selectFolder(id);
      revealInTree(id);
      return;
    }
    item.run?.();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-foreground/20 px-4 pt-[12vh]" onClick={() => onOpenChange(false)}>
      <div
        role="dialog"
        data-testid="command-palette"
        aria-modal="true"
        aria-label="命令面板"
        className="markai-glass animate-fade-in w-full max-w-lg overflow-hidden rounded-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
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
            className="h-11 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <kbd className="hidden shrink-0 rounded border border-border px-1 text-2xs text-muted-foreground sm:block">
            Esc
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[46vh] overflow-y-auto py-1">
          {flat.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              没有匹配「{query.trim()}」的书签、文件夹或动作
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.kind}>
                <p className="px-3 pt-2 pb-1 text-2xs font-medium text-muted-foreground">{group.label}</p>
                {group.items.map((item) => {
                  const idx = flat.indexOf(item);
                  const Icon = item.kind === 'action' ? Sparkles : item.kind === 'folder' ? Folder : BookmarkIcon;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      data-testid="command-item"
                      data-kind={item.kind}
                      data-idx={idx}
                      onMouseEnter={() => setActive(idx)}
                      onClick={() => runItem(item)}
                      className={cn(
                        'flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors',
                        idx === active ? 'bg-accent-muted' : 'hover:bg-muted',
                      )}
                    >
                      <Icon className={cn('h-3.5 w-3.5 shrink-0', idx === active ? 'text-accent' : 'text-muted-foreground')} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs text-foreground">{item.title}</span>
                        {item.subtitle && (
                          <span className="block truncate text-2xs text-muted-foreground">{item.subtitle}</span>
                        )}
                      </span>
                      {idx === active && <CornerDownLeft className="h-3 w-3 shrink-0 text-muted-foreground" />}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
