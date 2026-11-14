/**
 * ── 书签概览：打开应用先看见"我的书签库现在怎么样" ──
 *
 * 不是又一张统计表，而是管家每天该说的三句话：
 *  1. 你好，你的库有多大、今天发生了什么（问候 + 一句总结）；
 *  2. 现在最值得处理的一件事是什么（重复 / 空文件夹 / 今天新增）；
 *  3. 它最近替我做了什么（整理记录摘要），以及下一步能点什么。
 *
 * 所有动作都汇成"给 Agent 的一句具体指令"，由 Agent 走计划/确认/撤销；
 * 概览自己**不写任何书签**。这样"一键整理"不会变成绕过安全机制的快捷方式。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  BookMarked,
  BookmarkPlus,
  FolderTree,
  Merge,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react';
import { useBookmarkStore } from '@/stores/bookmarkStore';
import { useConfigStore } from '@/stores/configStore';
import { useAIStore } from '@/stores/aiStore';
import { analyzeLibrary, type LibraryInsights } from '@/lib/bookmarks/insights';
import { readOrganizeLog, type OrganizeLogEntry } from '@/lib/ai/organize-log';
import { formatRelativeTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { LibraryInsightsDialog } from './library-insights-dialog';
import {
  buildWeeklyReview,
  markWeeklySeen,
  readWeeklySnapshot,
  saveWeeklySnapshot,
  weekKeyOf,
  weeklySeen,
  type WeeklyReview,
} from '@/lib/bookmarks/weekly-review';

/** 按时间段给问候；称呼只在用户填了的时候拼接，不编一个"主人" */
function greetingOf(now = new Date()): string {
  const h = now.getHours();
  if (h < 5) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 13) return '中午好';
  if (h < 18) return '下午好';
  if (h < 23) return '晚上好';
  return '夜深了';
}

const ACTION_LABEL: Record<OrganizeLogEntry['action'], string> = {
  moved: '已归类',
  created: '新建了文件夹',
  skipped: '跳过',
  failed: '失败',
};

function StatTile({
  label,
  value,
  hint,
  tone,
  onClick,
}: {
  label: string;
  value: number;
  hint?: string;
  tone?: 'accent' | 'danger';
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        'group flex flex-col items-start rounded-xl border border-border bg-background px-3 py-2.5 text-left transition-colors',
        onClick ? 'hover:border-accent/40 hover:bg-muted/40' : 'cursor-default',
      )}
    >
      <span className="text-2xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          'mt-0.5 text-lg leading-6 font-semibold tabular-nums',
          tone === 'danger' && value > 0 ? 'text-destructive' : 'text-foreground',
        )}
      >
        {value}
      </span>
      {hint && <span className="mt-0.5 text-2xs text-muted-foreground/70">{hint}</span>}
    </button>
  );
}

/** 动作文案：有新增就说"整理新增"，没有就直说"今天还没有新增" */
function organizeLabel(count: number, label: string): string {
  return count > 0 ? `整理${label}` : '今天还没有新增';
}

export function OverviewPanel({
  onShowList,
  onShowToday,
}: {
  onShowList: () => void;
  onShowToday: () => void;
}) {
  const roots = useBookmarkStore((s) => s.roots);
  const addressName = useConfigStore((s) => s.config.addressName?.trim() ?? '');
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [log, setLog] = useState<OrganizeLogEntry[] | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  /** 本周回顾：每周第一次打开概览时出现一次 */
  const [weeklyReview, setWeeklyReview] = useState<WeeklyReview | null>(null);
  const [weeklyDismissed, setWeeklyDismissed] = useState(false);

  const insights: LibraryInsights = useMemo(() => analyzeLibrary(roots), [roots]);
  const greeting = greetingOf();
  const headline = addressName ? `${greeting}，${addressName}` : greeting;
  const today = useMemo(
    () =>
      new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(
        new Date(),
      ),
    [],
  );

  const reloadLog = () => {
    setLogError(null);
    void readOrganizeLog()
      .then((entries) => setLog(entries))
      .catch((e: unknown) => {
        setLog(null);
        setLogError(e instanceof Error ? e.message : String(e));
      });
  };

  useEffect(() => {
    reloadLog();
    // roots 变化意味着书签刚被整理过，记录也应该跟着刷新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roots]);

  // 本周回顾：读到日志后计算；本周已展示过就跳过（不重复打扰）
  useEffect(() => {
    if (!log) return;
    // 日志可能比书签树先到：树还没加载完时 insights 全是 0，此时算出来的"本周回顾"是假数据。
    if (insights.total === 0) return;
    const key = weekKeyOf();
    if (weeklySeen(key)) return;
    const previous = readWeeklySnapshot();
    const review = buildWeeklyReview(insights, log, previous, Date.now());
    setWeeklyReview(review);
    markWeeklySeen(key);
    saveWeeklySnapshot({
      weekKey: key,
      total: insights.total,
      duplicates: insights.duplicateGroups,
      emptyFolders: insights.emptyFolders,
      at: Date.now(),
    });
  }, [log, insights]);

  // 命令面板的「书签体检」先切到概览，再发这个事件把对话框打开
  useEffect(() => {
    const onOpen = () => setInsightsOpen(true);
    document.addEventListener('markai:open-insights', onOpen);
    return () => document.removeEventListener('markai:open-insights', onOpen);
  }, []);

  const askAgent = (prompt: string) => {
    if (!prompt) return;
    void useAIStore.getState().send(prompt);
  };

  const weeklyPrompt = weeklyReview
    ? `本周回顾：新增 ${weeklyReview.added} 条，自动整理 ${weeklyReview.organized} 条，失败 ${weeklyReview.failed} 条；当前重复 ${insights.duplicateGroups} 组、空文件夹 ${insights.emptyFolders} 个。请给一份本周收尾计划：先处理失败项与重复链接，再清理空文件夹，逐条确认后执行。`
    : '';
  const recentCount = insights.addedToday > 0 ? insights.addedToday : insights.added7d;
  const recentLabel = insights.addedToday > 0 ? '今天新增' : '最近 7 天新增';
  const organizePrompt =
    recentCount > 0
      ? `请按收藏时间列出${recentLabel}的 ${recentCount} 条书签，先给归类计划再执行；认不出归属就问我，不要新建按域名的文件夹。`
      : '';

  const summary =
    insights.total === 0
      ? '书签库还是空的。收藏任意页面后，我会把它接进来。'
      : `书签库有 ${insights.total} 条，${recentCount > 0 ? `${recentLabel} ${recentCount} 条` : '最近没有新增'}；${
          insights.duplicateGroups > 0
            ? `${insights.duplicateGroups} 组重复链接可以合并`
            : insights.emptyFolders > 0
              ? `${insights.emptyFolders} 个空文件夹可以清理`
              : '暂时没有需要处理的问题'
        }。`;

  const suggestions: Array<{
    icon: typeof Merge;
    title: string;
    body: string;
    action: string;
    run: () => void;
  }> = [];
  if (insights.duplicateGroups > 0) {
    suggestions.push({
      icon: Merge,
      title: `合并 ${insights.duplicateGroups} 组重复链接`,
      body: `同一条 URL 有 ${insights.duplicateExtra} 条多余副本，合并后列表会更干净。`,
      action: '查看清单',
      run: () => setInsightsOpen(true),
    });
  }
  if (insights.emptyFolders > 0) {
    suggestions.push({
      icon: Trash2,
      title: `清理 ${insights.emptyFolders} 个空文件夹`,
      body: '只删空文件夹，不动任何书签；执行前会逐条确认。',
      action: '查看清单',
      run: () => setInsightsOpen(true),
    });
  }
  if (recentCount > 0) {
    suggestions.push({
      icon: Wand2,
      title: `${recentLabel} ${recentCount} 条还没归类`,
      body: '趁热整理比攒到几百条再动手容易得多。',
      action: '交给我',
      run: () => askAgent(organizePrompt),
    });
  }
  if (suggestions.length === 0) {
    suggestions.push({
      icon: ShieldCheck,
      title: '书签库很干净',
      body: '没有重复链接与空文件夹；可以定期体检一次。',
      action: '打开体检',
      run: () => setInsightsOpen(true),
    });
  }

  return (
    <div data-testid="overview-panel" className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl space-y-4 p-4 sm:p-5">
        <section className="rounded-2xl border border-border bg-card p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-2xs text-muted-foreground">{today} · 你的书签库</p>
              <h1 className="mt-1 text-xl font-semibold tracking-tight text-foreground">{headline}</h1>
              <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{summary}</p>
            </div>
            <span
              aria-hidden="true"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-muted text-accent"
            >
              <BookMarked className="h-5 w-5" strokeWidth={2.1} />
            </span>
          </div>

          {weeklyReview && !weeklyDismissed && (
            <div
              data-testid="weekly-review"
              className="mt-3 rounded-xl border border-accent/25 bg-accent-muted/40 p-3"
            >
              <div className="flex items-center gap-2">
                <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent" />
                <span className="text-xs font-semibold text-accent">本周回顾</span>
                <span className="text-2xs text-muted-foreground/70">从周一开始</span>
                <button
                  type="button"
                  onClick={() => setWeeklyDismissed(true)}
                  className="ml-auto rounded-md px-1.5 py-0.5 text-2xs text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
                >
                  稍后
                </button>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2">
                <div>
                  <p className="text-2xs text-muted-foreground">新增</p>
                  <p className="text-sm font-semibold tabular-nums text-foreground">{weeklyReview.added}</p>
                </div>
                <div>
                  <p className="text-2xs text-muted-foreground">自动整理</p>
                  <p className="text-sm font-semibold tabular-nums text-foreground">{weeklyReview.organized}</p>
                </div>
                <div>
                  <p className="text-2xs text-muted-foreground">失败</p>
                  <p
                    className={cn(
                      'text-sm font-semibold tabular-nums',
                      weeklyReview.failed > 0 ? 'text-destructive' : 'text-foreground',
                    )}
                  >
                    {weeklyReview.failed}
                  </p>
                </div>
              </div>
              <p className="mt-1.5 text-2xs text-muted-foreground">
                重复{' '}
                {weeklyReview.duplicateDelta === null
                  ? '首次记录'
                  : weeklyReview.duplicateDelta === 0
                    ? '持平'
                    : `${weeklyReview.duplicateDelta > 0 ? '+' : ''}${weeklyReview.duplicateDelta}`}
                {' · '}空文件夹{' '}
                {weeklyReview.emptyDelta === null
                  ? '首次记录'
                  : weeklyReview.emptyDelta === 0
                    ? '持平'
                    : `${weeklyReview.emptyDelta > 0 ? '+' : ''}${weeklyReview.emptyDelta}`}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    setWeeklyDismissed(true);
                    if (weeklyReview.hasIssues) askAgent(weeklyPrompt);
                    else onShowToday();
                  }}
                >
                  {weeklyReview.hasIssues ? '交给 Agent 收尾' : '看看本周新增'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setWeeklyDismissed(true)}>
                  知道了
                </Button>
              </div>
            </div>
          )}

          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <StatTile
              label="全部书签"
              value={insights.total}
              hint={`${insights.folders} 个文件夹`}
              onClick={onShowList}
            />
            <StatTile
              label="今天新增"
              value={insights.addedToday}
              hint={`7 天 ${insights.added7d} 条`}
              onClick={onShowToday}
            />
            <StatTile
              label="重复链接"
              value={insights.duplicateGroups}
              hint={insights.duplicateGroups > 0 ? `${insights.duplicateExtra} 条多余` : '没有重复'}
              tone="danger"
              onClick={() => setInsightsOpen(true)}
            />
            <StatTile
              label="空文件夹"
              value={insights.emptyFolders}
              hint={insights.emptyFolders > 0 ? '可以清理' : '没有空的'}
              tone="danger"
              onClick={() => setInsightsOpen(true)}
            />
          </div>

          {/* 7 日迷你趋势：一根柱子回答"最近一周到底存了多少" */}
          <div className="mt-3 rounded-xl border border-border bg-card/70 px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-2xs font-medium text-muted-foreground">最近 7 天新增</span>
              <span className="text-2xs tabular-nums text-muted-foreground/60">
                共 {insights.added7d} 条
              </span>
            </div>
            <div className="mt-2 flex items-end gap-2" data-testid="daily-trend">
              {(() => {
                const max = Math.max(1, ...insights.dailyAdded.map((d) => d.count));
                const todayKey = insights.dailyAdded[6]?.date;
                const yesterdayKey = insights.dailyAdded[5]?.date;
                return insights.dailyAdded.map((day) => {
                  const isToday = day.date === todayKey;
                  const label = isToday
                    ? '今天'
                    : day.date === yesterdayKey
                      ? '昨天'
                      : `周${'日一二三四五六'[new Date(`${day.date}T00:00:00`).getDay()]}`;
                  return (
                    <div
                      key={day.date}
                      className="flex min-w-0 flex-1 flex-col items-center gap-1"
                      title={`${day.date} · ${day.count} 条`}
                    >
                      <div className="flex h-9 w-full items-end justify-center" aria-hidden="true">
                        <div
                          style={{
                            height: day.count ? `${Math.max(12, (day.count / max) * 100)}%` : '3px',
                            width: day.count ? '100%' : '6px',
                          }}
                          className={cn(
                            'transition-[height]',
                            day.count > 0 ? 'rounded-t-md bg-accent/80' : 'rounded-full bg-border',
                          )}
                        />
                      </div>
                      <span
                        className={cn(
                          'truncate text-2xs',
                          isToday ? 'font-medium text-accent' : 'text-muted-foreground/60',
                        )}
                      >
                        {label}
                      </span>
                    </div>
                  );
                });
              })()}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => (organizePrompt ? askAgent(organizePrompt) : onShowToday())}
              disabled={recentCount === 0}
            >
              <Sparkles className="h-3 w-3" />
              {organizeLabel(recentCount, recentLabel)}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setInsightsOpen(true)}>
              <ShieldCheck className="h-3 w-3" />
              书签体检
            </Button>
            {insights.duplicateGroups > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setInsightsOpen(true)}>
                <Merge className="h-3 w-3" />
                合并重复
              </Button>
            )}
            {insights.emptyFolders > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setInsightsOpen(true)}>
                <Trash2 className="h-3 w-3" />
                清理空文件夹
              </Button>
            )}
          </div>
        </section>

        <div className="grid gap-4 md:grid-cols-[1.15fr_1fr]">
          <section className="self-start rounded-2xl border border-border bg-card p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <Wand2 className="h-3.5 w-3.5 text-accent" />
                最近整理
                {log && log.length > 0 && <Badge variant="outline">{log.length} 条</Badge>}
              </h3>
              <button
                type="button"
                onClick={reloadLog}
                aria-label="刷新整理记录"
                title="刷新整理记录"
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <RefreshCw className="h-3 w-3" />
              </button>
            </div>
            {logError ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-2xs text-muted-foreground">
                读取整理记录失败：{logError}
              </p>
            ) : !log ? (
              <p className="px-1 py-3 text-2xs text-muted-foreground">读取中…</p>
            ) : log.length === 0 ? (
              <div className="flex flex-col items-center gap-1 rounded-lg border border-dashed border-border px-3 py-6 text-center">
                <BookmarkPlus className="h-4 w-4 text-muted-foreground/60" />
                <p className="text-xs text-muted-foreground">还没有整理记录</p>
                <p className="text-2xs text-muted-foreground/70">
                  收藏新页面后，我会在这里记下每一条去了哪。
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-border/60">
                {log.slice(0, 5).map((entry) => (
                  <li key={entry.id} className="flex items-center gap-2 py-1.5">
                    <span
                      className={cn(
                        'flex h-5 w-5 shrink-0 items-center justify-center rounded-md',
                        entry.action === 'failed'
                          ? 'bg-destructive/10 text-destructive'
                          : entry.action === 'skipped'
                            ? 'bg-muted text-muted-foreground'
                            : 'bg-accent-muted text-accent',
                      )}
                    >
                      {entry.action === 'failed' ? (
                        <Trash2 className="h-3 w-3" />
                      ) : entry.action === 'skipped' ? (
                        <ArrowRight className="h-3 w-3" />
                      ) : (
                        <FolderTree className="h-3 w-3" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-foreground">{entry.title || entry.domain}</p>
                      <p className="truncate text-2xs text-muted-foreground">
                        {entry.target ? `→ ${entry.target}` : ACTION_LABEL[entry.action]}
                        {entry.action === 'failed' && entry.detail ? ` · ${entry.detail}` : ''}
                      </p>
                    </div>
                    <span className="shrink-0 text-2xs tabular-nums text-muted-foreground/60">
                      {formatRelativeTime(entry.at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="self-start rounded-2xl border border-border bg-card p-4">
            <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <Sparkles className="h-3.5 w-3.5 text-accent" />
              管家建议
            </h3>
            <ul className="space-y-2">
              {suggestions.slice(0, 3).map((s) => (
                <li key={s.title} className="rounded-xl border border-border bg-background p-3">
                  <div className="flex items-start gap-2">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent-muted text-accent">
                      <s.icon className="h-3 w-3" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-foreground">{s.title}</p>
                      <p className="mt-0.5 text-2xs leading-4 text-muted-foreground">{s.body}</p>
                      <button
                        type="button"
                        onClick={s.run}
                        className="mt-1.5 text-2xs font-medium text-accent transition-colors hover:underline"
                      >
                        {s.action} →
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>

      <LibraryInsightsDialog
        open={insightsOpen}
        onOpenChange={setInsightsOpen}
        insights={insights}
        onAskAgent={askAgent}
      />
    </div>
  );
}
