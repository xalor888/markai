import { ArrowDown, ArrowLeft, ArrowUp, Clock, ExternalLink, LocateFixed, Search, X } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useBookmarkStore } from '@/stores/bookmarkStore';
import { filterTimeline, flattenBookmarks, groupByDay, pageGroups, sortTimeline, type TimelineItem, type TimelineOrder } from '@/lib/bookmarks/timeline';
import { formatRelativeTime, getHost } from '@/lib/format';
import { openUrl } from '@/lib/open-url';
import { cn } from '@/lib/utils';
import { Favicon } from '@/components/common/favicon';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

/** 首屏渲染条数 / 每次加载增量：大库（数千条）下避免一次性挂满 DOM */
const PAGE_SIZE = 80;

function clockOf(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 时间线面板（独立视图）：
 * - **只列书签个体**，不含文件夹行；文件夹只作为路径元信息出现
 * - 纯按收藏时间排序（最新在前 / 最早在前），按天分组
 * - 自己的过滤框（标题 / 网址 / 路径），不劫持中栏列表的搜索状态
 * - 空状态分两种：整库没有书签 / 过滤无匹配，各自给出可执行的下一步
 */
export function TimelinePanel({ className }: { className?: string }) {
  const roots = useBookmarkStore((s) => s.roots);
  const setContextMenu = useBookmarkStore((s) => s.setContextMenu);
  // 与顶栏那个唯一的搜索框共用同一个词（重做前这里还有第二个输入框）
  const query = useBookmarkStore((s) => s.searchQuery);
  const [order, setOrder] = useState<TimelineOrder>('newest');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // 整棵树只在 roots 变化时重新展平（展开/折叠等 UI 状态不会触发重算）
  const all = useMemo(() => flattenBookmarks(roots), [roots]);
  const filtered = useMemo(() => filterTimeline(all, query), [all, query]);
  const sorted = useMemo(() => sortTimeline(filtered, order), [filtered, order]);

  // 过滤 / 排序变化后回到首屏，避免用户看到的是上一份结果的中段
  useEffect(() => {
    setLimit(PAGE_SIZE);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [query, order]);

  // 先按天分组（拿到每天的**真实**条数），再按 limit 切页：
  // 先切再分只能看到本页条目，组头会写成页大小（100 条的今天显示「今天 80 条」）。
  const dayGroups = useMemo(() => groupByDay(sorted), [sorted]);
  const groups = useMemo(() => pageGroups(dayGroups, limit), [dayGroups, limit]);
  /** 本页实际渲染的条数（组头显示的是 group.total，两者在分页时并不相等） */
  const shown = useMemo(() => groups.reduce((n, g) => n + g.items.length, 0), [groups]);
  const hasMore = sorted.length > shown;

  const loadMore = useCallback(() => {
    setLimit((n) => n + PAGE_SIZE);
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !hasMore) return;
    // 触底前 160px 预加载：滚动连续，不出现「卡一下才出下一批」
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) loadMore();
  }, [hasMore, loadMore]);

  // Esc：回到文件夹列表；「/」聚焦过滤框（与主列表一致的键盘习惯）
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el?.closest('input, textarea, select');
      if (e.key === 'Escape') {
        if (typing) {
          useBookmarkStore.getState().setSearchQuery('');
          (el as HTMLInputElement | null)?.blur();
        }
      } else if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // 搜索框已经搬到顶栏，这里聚焦的是那一个
        e.preventDefault();
        document.getElementById('markai-search')?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openRow = useCallback((item: TimelineItem) => {
    void openUrl(item.url);
  }, []);

  const contextRow = useCallback(
    (e: MouseEvent, id: string) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ x: e.clientX, y: e.clientY, bookmarkId: id });
    },
    [setContextMenu],
  );

  return (
    <div className={cn('animate-fade-in flex h-full min-h-0 min-w-0 flex-col bg-background', className)}>
      {/* 工具栏：入口说明 + 排序 + 过滤 */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2.5">
        <Clock className="h-3.5 w-3.5 shrink-0 text-accent/70" />
        <span className="shrink-0 text-xs font-medium text-foreground">时间线</span>
        <span className="shrink-0 text-2xs text-muted-foreground/70">{all.length} 条书签</span>

        <div className="ml-auto flex min-w-0 shrink items-center gap-1.5">
          <button
            type="button"
            onClick={() => setOrder((o) => (o === 'newest' ? 'oldest' : 'newest'))}
            className="flex shrink-0 items-center gap-1 rounded-sm border border-input bg-card px-1.5 py-1 text-2xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title={order === 'newest' ? '当前：最新收藏在前（点击切换）' : '当前：最早收藏在前（点击切换）'}
            aria-label="切换时间排序方向"
          >
            {order === 'newest' ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />}
            {order === 'newest' ? '最新' : '最早'}
          </button>
          <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
            共 {sorted.length} 条
          </span>
        </div>
      </div>

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto p-2">
        {all.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-5 text-center">
            <Clock className="h-5 w-5 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">还没有可看的书签</p>
            <p className="text-2xs leading-4 text-muted-foreground/70">
              收藏任意页面后，它会按收藏时间出现在这里。
            </p>
            <p className="text-2xs leading-4 text-muted-foreground/70">
              （在顶栏搜索框里输入可以过滤）
            </p>
          </div>
        ) : sorted.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-5 text-center">
            <Search className="h-5 w-5 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">没有匹配「{query.trim()}」的书签</p>
            <button type="button" onClick={() => useBookmarkStore.getState().setSearchQuery('')} className="text-2xs text-accent hover:underline">
              清除过滤
            </button>
          </div>
        ) : (
          <>
            {groups.map((group) => (
              <section key={group.key} className="mb-2">
                {/* 日期吸顶：长列表滚动时始终知道自己在哪一天 */}
                <h3 className="sticky top-0 z-10 -mx-2 flex items-center gap-2 bg-background/95 px-3 py-1.5 text-2xs font-medium text-muted-foreground backdrop-blur-sm">
                  <span>{group.label}</span>
                  {/* 分页时本组可能只渲染了一部分，条数必须读 total（当天真实条数） */}
                  <span className="text-muted-foreground/50">{group.total} 条</span>
                  <span className="h-px flex-1 bg-border" />
                </h3>
                {group.items.map((item) => (
                  <TimelineRow key={item.id} item={item} onOpen={openRow} onContextMenu={contextRow} />
                ))}
              </section>
            ))}
            {hasMore ? (
              <div className="flex justify-center py-2">
                <Button variant="ghost" size="sm" className="h-7 text-2xs" onClick={loadMore}>
                  加载更多（已显示 {shown} / {sorted.length}）
                </Button>
              </div>
            ) : (
              <p className="py-2 text-center text-2xs text-muted-foreground/60">
                已显示全部 {sorted.length} 条
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** 单行（memo：滚动加载更多时旧行不重渲染） */
const TimelineRow = memo(function TimelineRow({
  item,
  onOpen,
  onContextMenu,
}: {
  item: TimelineItem;
  onOpen: (item: TimelineItem) => void;
  onContextMenu: (e: MouseEvent, id: string) => void;
}) {
  const host = getHost(item.url);
  return (
    <div
      role="listitem"
      tabIndex={0}
      onClick={() => onOpen(item)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(item);
        }
      }}
      onContextMenu={(e) => onContextMenu(e, item.id)}
      className="group flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
      title={`${item.title}\n${item.url}\n${item.path}`}
    >
      <Favicon url={item.url} size={14} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-foreground">{item.title}</p>
        <p className="truncate text-2xs text-muted-foreground/70">
          {host || item.url}
          {item.path && <span className="text-muted-foreground/45"> · {item.path}</span>}
        </p>
      </div>
      <span
        className="shrink-0 text-2xs tabular-nums text-muted-foreground/60"
        title={item.dateAdded ? `收藏于 ${formatRelativeTime(item.dateAdded)}` : '收藏时间未知'}
      >
        {clockOf(item.dateAdded)}
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          // 时间线现在是列表的一种排序，不再有「切回列表」这回事：
          // 定位就是让书签树展开并高亮到那个节点
          useBookmarkStore.getState().revealInTree(item.id);
        }}
        className="shrink-0 rounded-sm p-1 text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-card hover:text-foreground focus-visible:opacity-100"
        title="在文件夹中定位"
        aria-label="在文件夹中定位"
      >
        <LocateFixed className="h-3 w-3" />
      </button>
      <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground/25" aria-hidden="true" />
    </div>
  );
});
