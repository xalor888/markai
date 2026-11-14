import { ArrowDown, ArrowLeft, ArrowUp, Clock, ExternalLink, LocateFixed, Search, X } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useBookmarkStore } from '@/stores/bookmarkStore';
import {
  filterTimeline,
  filterTimelineByRange,
  flattenBookmarks,
  groupByDay,
  groupByDomain,
  pageGroups,
  sortTimeline,
  uniqueUrls,
  type TimelineItem,
  type TimelineOrder,
  type TimelineRange,
} from '@/lib/bookmarks/timeline';
import { formatRelativeTime, getHost } from '@/lib/format';
import { openUrl } from '@/lib/open-url';
import { cn } from '@/lib/utils';
import { Favicon } from '@/components/common/favicon';
import { openUrls } from '@/lib/open-url';
import { pushToast } from '@/lib/toast';
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
  const [range, setRange] = useState<TimelineRange>('all');
  const [groupBy, setGroupBy] = useState<'day' | 'domain'>('day');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // 整棵树只在 roots 变化时重新展平（展开/折叠等 UI 状态不会触发重算）
  const all = useMemo(() => flattenBookmarks(roots), [roots]);
  const filtered = useMemo(() => filterTimeline(all, query), [all, query]);
  const sorted = useMemo(() => sortTimeline(filtered, order), [filtered, order]);
  const ranged = useMemo(() => filterTimelineByRange(sorted, range), [sorted, range]);

  // 过滤 / 排序 / 时间范围变化后回到首屏，避免用户看到的是上一份结果的中段
  useEffect(() => {
    setLimit(PAGE_SIZE);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [query, order, range, groupBy]);

  // 先按天分组（拿到每天的**真实**条数），再按 limit 切页：
  // 先切再分只能看到本页条目，组头会写成页大小（100 条的今天显示「今天 80 条」）。
  const grouped = useMemo(() => {
    if (groupBy === 'domain') return groupByDomain(ranged);
    return groupByDay(
      ranged,
      Date.now(),
      order === 'recent' ? (item) => item.dateLastUsed || 0 : (item) => item.dateAdded || 0,
    );
  }, [ranged, groupBy, order]);
  const groups = useMemo(() => pageGroups(grouped, limit), [grouped, limit]);
  /** 本页实际渲染的条数（组头显示的是 group.total，两者在分页时并不相等） */
  const shown = useMemo(() => groups.reduce((n, g) => n + g.items.length, 0), [groups]);
  const hasMore = ranged.length > shown;

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
    <div
      data-testid="timeline-panel"
      className={cn('animate-fade-in flex h-full min-h-0 min-w-0 flex-col bg-background', className)}
    >
      {/* 次级工具条：只留"多少条 + 时间方向"。视图名与入口已经在主工具栏里，不再重复 */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background px-4">
        <span className="shrink-0 text-2xs text-muted-foreground/70">共 {ranged.length} 条</span>
        {/* 时间范围：今天 / 7 天 / 30 天 / 全部；与排序方向是两条正交的维度 */}
        <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto" role="group" aria-label="时间范围">
          {(
            [
              ['today', '今天'],
              ['7d', '7 天'],
              ['30d', '30 天'],
              ['all', '全部'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={range === value}
              onClick={() => setRange(value)}
              className={cn(
                'shrink-0 rounded-md px-2 py-1 text-2xs transition-colors',
                range === value
                  ? 'bg-accent-muted font-medium text-accent'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex shrink-0 items-center rounded-md bg-muted p-0.5" role="group" aria-label="分组方式">
          {(
            [
              ['day', '按天'],
              ['domain', '按域名'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={groupBy === value}
              onClick={() => setGroupBy(value)}
              className={cn(
                'shrink-0 rounded-sm px-2 py-0.5 text-2xs transition-colors',
                groupBy === value
                  ? 'bg-card font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() =>
            setOrder((o) => (o === 'newest' ? 'oldest' : o === 'oldest' ? 'recent' : 'newest'))
          }
          className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-2xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title={
            order === 'newest'
              ? '当前：最新收藏在前（点击切到最早收藏）'
              : order === 'oldest'
                ? '当前：最早收藏在前（点击切到最近打开）'
                : '当前：最近打开在前（点击切回最新收藏）'
          }
          aria-label="切换时间排序"
        >
          {order === 'recent' ? (
            <Clock className="h-3 w-3" />
          ) : order === 'newest' ? (
            <ArrowDown className="h-3 w-3" />
          ) : (
            <ArrowUp className="h-3 w-3" />
          )}
          {order === 'recent' ? '最近打开' : order === 'newest' ? '最新' : '最早'}
        </button>
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
        ) : ranged.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-5 text-center">
            {query.trim() ? (
              <>
                <Search className="h-5 w-5 text-muted-foreground/40" />
                <p className="text-xs text-muted-foreground">没有匹配「{query.trim()}」的书签</p>
                <button
                  type="button"
                  onClick={() => useBookmarkStore.getState().setSearchQuery('')}
                  className="text-2xs text-accent hover:underline"
                >
                  清除过滤
                </button>
              </>
            ) : (
              <>
                <Clock className="h-5 w-5 text-muted-foreground/40" />
                <p className="text-xs text-muted-foreground">这个时间段还没有收藏</p>
                <button
                  type="button"
                  onClick={() => setRange('all')}
                  className="text-2xs text-accent hover:underline"
                >
                  查看全部时间
                </button>
              </>
            )}
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
                  {groupBy === 'domain' && (
                    <button
                      type="button"
                      onClick={() => {
                        const full = grouped.find((g) => g.key === group.key);
                        const urls = uniqueUrls(full?.items ?? group.items);
                        if (urls.length === 0) return;
                        if (urls.length > 25) {
                          pushToast('一次最多打开 25 个页面', {
                            description: `该域名下有 ${urls.length} 条，先打开前 25 条。`,
                          });
                        }
                        void openUrls(urls.slice(0, 25), { label: '页面' });
                      }}
                      title={`打开 ${group.label} 的全部页面`}
                      aria-label={`打开 ${group.label} 的全部页面`}
                      className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <ExternalLink className="h-3 w-3" />
                      <span className="hidden sm:inline">打开全部</span>
                    </button>
                  )}
                </h3>
                {group.items.map((item) => (
                  <TimelineRow key={item.id} item={item} onOpen={openRow} onContextMenu={contextRow} />
                ))}
              </section>
            ))}
            {hasMore ? (
              <div className="flex justify-center py-2">
                <Button variant="ghost" size="sm" className="h-7 text-2xs" onClick={loadMore}>
                  加载更多（已显示 {shown} / {ranged.length}）
                </Button>
              </div>
            ) : (
              <p className="py-2 text-center text-2xs text-muted-foreground/60">
                已显示全部 {ranged.length} 条
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
      className="group flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
      title={`${item.title}\n${item.url}\n${item.path}`}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted" aria-hidden="true">
        <Favicon url={item.url} size={15} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-md font-medium text-foreground">{item.title}</p>
        <p className="mt-0.5 truncate text-2xs text-muted-foreground/70">
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
