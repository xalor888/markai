import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  Loader2,
  MinusCircle,
  RefreshCw,
  Search,
  Trash2,
  Undo2,
  Wand2,
  X,
} from 'lucide-react';
import {
  buildOrganizeLogMarkdown,
  filterOrganizeLog,
  groupByTarget,
  ORGANIZE_LOG_KEY,
  pickRetryableEntries,
  type OrganizeLogEntry,
  type OrganizeStats,
} from '@/lib/ai/organize-log';
import { ORGANIZE_OPTOUT_KEY, type OptOutEntry } from '@/lib/ai/organize-optout';
import { formatIsoDate, formatRelativeTime, getHost } from '@/lib/format';
import { cn } from '@/lib/utils';
import { pushToast } from '@/lib/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Favicon } from '@/components/common/favicon';

/**
 * 「整理记录」对话框：自动整理到底动了什么、去哪了、哪条失败了要不要重试。
 *
 * 为什么值得一个独立面板：自动整理默认开启且发生在后台。只靠一条会消失的 toast，
 * 用户对它的感知等于「书签有时会自己换位置」。这个面板把后台行为摊开：
 * 统计 + 逐条去向 + 失败重试 + 对已有书签补整理。
 */
export function OrganizeLogDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [entries, setEntries] = useState<OrganizeLogEntry[]>([]);
  const [stats, setStats] = useState<OrganizeStats | null>(null);
  const [loading, setLoading] = useState(false);
  /** 后台不可达时的如实说明（Service Worker 被回收时消息会失败） */
  const [notice, setNotice] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);
  const [retryingAll, setRetryingAll] = useState(false);
  /** 清空是破坏性的且不可恢复：先问一次，而不是点一下就没 */
  const [confirmClear, setConfirmClear] = useState(false);
  /** 只看失败：记录一多，找那条红的就是在列表里翻 */
  const [onlyFailed, setOnlyFailed] = useState(false);
  /** 记录检索：滚 200 条去找「那天 github 那条」不现实 */
  const [query, setQuery] = useState('');
  /** 被用户「叫停」的站点：撤销过一次自动整理就会进来 */
  const [optouts, setOptouts] = useState<OptOutEntry[]>([]);
  const refresh = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setLoading(true);
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'organize:list' })) as
        | { type?: string; entries?: OrganizeLogEntry[]; stats?: OrganizeStats }
        | undefined;
      if (res?.type === 'organize:list:result') {
        setEntries(res.entries ?? []);
        setStats(res.stats ?? null);
        setNotice(null);
        const opt = (await chrome.runtime.sendMessage({ type: 'organize:optout:list' }).catch(() => null)) as
          | { type?: string; domains?: OptOutEntry[] }
          | null;
        setOptouts(opt?.type === 'organize:optout:list:result' ? (opt.domains ?? []) : []);
      } else {
        setNotice('后台没有返回整理记录（可能刚被浏览器回收），请再试一次。');
      }
    } catch {
      setNotice('无法联系后台进程，请再试一次。');
    } finally {
      if (!opts.silent) setLoading(false);
    }
  }, []);

  /**
   * 跨窗口同步：侧边栏与完整页可能同时开着整理记录。
   * 任一侧撤销/重试/补整理都会改 storage，另一侧若不自知，用户会对着过期列表操作
   * （比如点一条已经在别处撤销过的记录）。这里跟随 storage 变化静默刷新，300ms 去抖。
   */
  useEffect(() => {
    if (!open) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onChanged = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: chrome.storage.AreaName,
    ) => {
      if (area !== 'local') return;
      if (!changes[ORGANIZE_LOG_KEY] && !changes[ORGANIZE_OPTOUT_KEY]) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void refresh({ silent: true });
      }, 300);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      chrome.storage.onChanged.removeListener(onChanged);
      if (timer) clearTimeout(timer);
    };
  }, [open, refresh]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);


  const retryOne = async (entry: OrganizeLogEntry) => {
    setRetrying(entry.id);
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'organize:retry', id: entry.id })) as
        | { type?: string; ok?: boolean; detail?: string }
        | undefined;
      if (res?.type === 'organize:retry:result') {
        pushToast(res.ok ? '重试成功' : '重试未成功', {
          description: res.detail,
          variant: res.ok ? 'success' : 'destructive',
        });
      } else {
        pushToast('重试没有执行', { description: '后台未响应。', variant: 'destructive' });
      }
      void refresh();
    } catch {
      pushToast('重试没有执行', { description: '无法联系后台进程。', variant: 'destructive' });
    } finally {
      setRetrying(null);
    }
  };

  /** 不满意就撤回来：一步操作，不用去撤销历史里翻英文 id */
  const undoOne = async (entry: OrganizeLogEntry) => {
    setUndoing(entry.id);
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'organize:undo', id: entry.id })) as
        | { type?: string; ok?: boolean; detail?: string }
        | undefined;
      if (res?.type === 'organize:undo:result') {
        pushToast(res.ok ? '已撤销这次整理' : '撤销未完成', {
          description: res.detail,
          variant: res.ok ? 'success' : 'destructive',
        });
      } else {
        pushToast('撤销没有执行', { description: '后台未响应。', variant: 'destructive' });
      }
      void refresh();
    } catch {
      pushToast('撤销没有执行', { description: '无法联系后台进程。', variant: 'destructive' });
    } finally {
      setUndoing(null);
    }
  };

  const restoreOneDomain = async (domain: string) => {
    try {
      await chrome.runtime.sendMessage({ type: 'organize:optout:remove', domain });
      setOptouts((prev) => prev.filter((o) => o.domain !== domain));
      pushToast(`已恢复「${domain}」的自动整理`);
    } catch {
      pushToast('恢复失败', { description: '无法联系后台进程。', variant: 'destructive' });
    }
  };

  const retryAll = async () => {
    setRetryingAll(true);
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'organize:retry:all' })) as
        | { type?: string; attempted?: number; succeeded?: number; failed?: number; detail?: string }
        | undefined;
      if (res?.type === 'organize:retry:all:result') {
        pushToast(res.detail ?? '重试完成', {
          description:
            (res.attempted ?? 0) === 0
              ? undefined
              : `共 ${res.attempted} 条：成功 ${res.succeeded ?? 0}${(res.failed ?? 0) > 0 ? `，仍失败 ${res.failed}` : ''}`,
          variant: (res.failed ?? 0) > 0 ? 'default' : 'success',
        });
      } else {
        pushToast('批量重试没有执行', { description: '后台未响应。', variant: 'destructive' });
      }
      void refresh();
    } catch {
      pushToast('批量重试没有执行', { description: '无法联系后台进程。', variant: 'destructive' });
    } finally {
      setRetryingAll(false);
    }
  };

  /** 导出为 Markdown：用户问「它到底动过什么」时，文件比截图有用 */
  const exportLog = () => {
    if (entries.length === 0) return;
    const md = buildOrganizeLogMarkdown(entries, {
      now: Date.now(),
      optOuts: optouts.map((o) => o.domain),
    });
    // 带 BOM：Windows 上直接双击打开时中文不乱码
    const blob = new Blob(['\ufeff' + md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `MarkAI-整理记录-${formatIsoDate(Date.now()) || 'export'}.md`;
    a.click();
    // 延迟释放，避免下载被中断
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const restoreOptOuts = async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'organize:optout:clear' });
      setOptouts([]);
      pushToast('已恢复自动整理', { description: '这些站点的新书签会重新自动归类。' });
    } catch {
      pushToast('恢复失败', { description: '无法联系后台进程。', variant: 'destructive' });
    }
  };

  const clearAll = async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'organize:clear' });
      setEntries([]);
      setStats(null);
      setConfirmClear(false);
      pushToast('整理记录已清空');
    } catch {
      pushToast('清空失败', { description: '无法联系后台进程。', variant: 'destructive' });
    }
  };

  /** 可批量重试的条数：一次网络抖动常留下十几条，逐条点太累 */
  const retryableCount = pickRetryableEntries(entries).length;
  // 「都塞哪儿了」：只展示前几个，避免长尾把这一行撑成两排
  const visibleEntries = filterOrganizeLog(entries, { query, onlyFailed });

  // 聚合跟随当前视图：切到「只看失败」时，「归到」自然为空——
  // 失败记录没有去向，继续显示全量聚合会让人以为列表里那些成功记录还在
  const targetGroups = groupByTarget(visibleEntries);
  const topTargets = targetGroups.slice(0, 3);
  const restTargets = targetGroups.length - topTargets.length;
  const restCount = targetGroups.slice(3).reduce((n, g) => n + g.count, 0);
  // 刚发生的那一条做淡高亮：用户打开面板十有八九是来看「刚才那条」的
  const justHappenedId =
    entries.length > 0 && Date.now() - entries[0]!.at < 5 * 60_000 ? entries[0]!.id : null;

  return (
    <Dialog
      testId="organize-log"
      open={open}
      onOpenChange={onOpenChange}
      title="整理记录"
      description="MarkAI 把新书签归到哪个文件夹、为什么，都在这里。失败可以重试，不满意能一步撤销。"
      width="w-[520px]"
      footer={
        <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
          关闭
        </Button>
      }
    >
      {/* 统计条：一眼看到「今天帮我整理了几条」 */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <Badge variant="outline">今天 {stats?.today ?? 0} 条</Badge>
        <Badge variant="outline">累计 {(stats?.moved ?? 0) + (stats?.created ?? 0)} 条</Badge>
        {(stats?.failed ?? 0) > 0 && (
          <button
            type="button"
            onClick={() => setOnlyFailed((v) => !v)}
            className={cn(
              'rounded-sm border px-1.5 py-0.5 text-2xs transition-colors',
              onlyFailed
                ? 'border-destructive/40 bg-destructive/10 text-destructive'
                : 'border-border text-destructive/90 hover:bg-destructive/5',
            )}
            title={onlyFailed ? '显示全部记录' : '只看失败的（可逐条重试）'}
            aria-pressed={onlyFailed}
          >
            失败 {stats?.failed ?? 0} 条{onlyFailed ? ' · 显示全部' : ''}
          </button>
        )}
        {retryableCount > 1 && (
          <button
            type="button"
            onClick={() => void retryAll()}
            disabled={retryingAll}
            className="rounded-sm border border-border px-1.5 py-0.5 text-2xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            title="把所有可重试的失败记录重新试一遍（逐条串行）"
          >
            {retryingAll ? '重试中…' : `重试全部 ${retryableCount}`}
          </button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-6 gap-1 px-1.5 text-2xs text-muted-foreground"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          刷新
        </Button>
      </div>

      {/* 判断来源：用户能看出「AI 到底用了多频繁」——本地规则命中越多，说明越快也越省钱。
          只看失败时隐藏：失败记录没有「来源」这个概念，继续显示全量分布会和列表口径打架
          （用户会看到「兜底 1」却在列表里找不到兜底记录）。 */}
      {!onlyFailed && (() => {
        const byVia = stats?.byVia;
        if (!byVia) return null;
        const total = byVia.local + byVia.model + byVia.fallback;
        if (total === 0) return null;
        return (
          <p
            className="mb-2.5 flex flex-wrap items-center gap-x-1.5 text-2xs text-muted-foreground"
            title="本地规则命中时不会请求模型；兜底是指模型没给出可用结论，按本地规则或域名归类"
          >
            <span>判断来源：</span>
            <span className="text-foreground/80">本地规则 {byVia.local}</span>
            <span aria-hidden="true">·</span>
            <span className="text-foreground/80">模型 {byVia.model}</span>
            <span aria-hidden="true">·</span>
            <span className="text-foreground/80">兜底 {byVia.fallback}</span>
          </p>
        );
      })()}

      {/* 检索：只在记录足够多时出现，避免一两条时多一个空框 */}
      {entries.length > 3 && (
        <div className="relative mb-2.5">
          <Search className="absolute top-1/2 left-2 h-3 w-3 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标题 / 域名 / 去向…"
            aria-label="搜索整理记录"
            className="h-7 pr-6 pl-6 text-xs"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
              aria-label="清除搜索"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      {/* 去向聚合：一眼看出「它把书签都归到哪了」 */}
      {topTargets.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1">
          <span className="text-2xs text-muted-foreground/70">归到</span>
          {topTargets.map((g) => (
            <span
              key={g.target}
              className="max-w-[180px] truncate rounded-xs bg-muted px-1.5 py-0.5 text-2xs text-foreground/80"
              title={`${g.target} · ${g.count} 条`}
            >
              {g.target}
              <span className="ml-1 text-muted-foreground/70">{g.count}</span>
            </span>
          ))}
          {restTargets > 0 && (
            <span className="rounded-xs bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground" title={`另有 ${restTargets} 个文件夹`}>
              其他 {restCount}
            </span>
          )}
        </div>
      )}

      {notice && (
        <p className="mb-2 flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-2xs leading-4 text-destructive">
          <AlertCircle className="mt-px h-3 w-3 shrink-0" />
          {notice}
        </p>
      )}

      {entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-1.5 rounded-md border border-border py-8 text-center">
          <Wand2 className="h-5 w-5 text-muted-foreground/40" aria-hidden="true" />
          <p className="text-xs text-muted-foreground">还没有整理记录</p>
          <p className="max-w-[300px] text-2xs leading-4 text-muted-foreground/70">
            收藏一个网页后，MarkAI 会自动把它归到合适的文件夹，记录会出现在这里。
          </p>
        </div>
      ) : visibleEntries.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-1.5 rounded-md border border-border py-8 text-center">
          <Search className="h-5 w-5 text-muted-foreground/40" aria-hidden="true" />
          <p className="text-xs text-muted-foreground">
            {query.trim() ? `没有匹配「${query.trim()}」的记录` : '没有失败的记录'}
          </p>
          <button
            type="button"
            onClick={() => {
              if (query.trim()) setQuery('');
              else setOnlyFailed(false);
            }}
            className="text-2xs text-accent hover:underline"
          >
            {query.trim() ? '清除搜索' : '显示全部'}
          </button>
        </div>
      ) : (
        <div
          className="max-h-80 overflow-y-auto rounded-md border border-border"
          role="list"
          aria-label={onlyFailed ? '失败的整理记录' : '整理记录'}
        >
          {visibleEntries.map((e) => {
            const failed = e.action === 'failed';
            const skipped = e.action === 'skipped';
            return (
              <div
                key={e.id}
                role="listitem"
                className={cn(
                  'flex items-start gap-2.5 border-b border-border/60 px-3 py-2.5 last:border-b-0',
                  e.id === justHappenedId && 'bg-accent-muted/40',
                )}
              >
                {/* 状态图标是装饰：语义由行内文案（失败/已归入）承载，避免读屏重复一遍 */}
                <span className="mt-0.5 shrink-0" aria-hidden="true">
                  {failed ? (
                    <AlertCircle className="h-3.5 w-3.5 text-destructive" />
                  ) : skipped ? (
                    <MinusCircle className="h-3.5 w-3.5 text-muted-foreground/60" />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                  )}
                </span>
                {e.url ? <Favicon url={e.url} size={14} /> : null}
                <div className="min-w-0 flex-1">
                  {/* 标题占满整行：窄屏（侧边栏 400px 左右）里把「→ 目标」放标题后面
                      会把标题挤成「GitHub · deep…」，用户反而看不出是哪一条。 */}
                  <p className="truncate text-xs text-foreground">{e.title}</p>
                  <p className="mt-0.5 text-2xs leading-4 break-words text-muted-foreground">
                    {e.domain || (e.url ? getHost(e.url) : '')}
                    {e.target && (
                      <>
                        {' · '}
                        <span className="rounded-xs bg-accent-muted px-1 py-px text-accent">→ {e.target}</span>
                      </>
                    )}
                    {e.detail ? ` · ${e.detail}` : ''}
                  </p>
                </div>
                <span className="shrink-0 text-2xs text-muted-foreground/70">
                  {e.undoneAt ? '已撤销' : formatRelativeTime(e.at)}
                </span>
                {!failed && !skipped && e.runId && !e.undoneAt && (
                  <button
                    type="button"
                    onClick={() => void undoOne(e)}
                    disabled={undoing === e.id}
                    className="mt-0.5 shrink-0 rounded-sm p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                    title="撤销这次整理（书签回到原处）"
                    aria-label={`撤销整理 ${e.title}`}
                  >
                    {undoing === e.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />}
                  </button>
                )}
                {failed && e.retryable && (
                  <button
                    type="button"
                    onClick={() => void retryOne(e)}
                    disabled={retrying === e.id}
                    className="mt-0.5 shrink-0 rounded-sm p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                    title="重试这一条"
                    aria-label={`重试整理 ${e.title}`}
                  >
                    {retrying === e.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3 w-3" />
                    )}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {optouts.length > 0 && (
        <p className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-2xs leading-4 text-muted-foreground">
          <span>已停用自动整理：</span>
          {/* 每个站点单独可恢复：只想放开一个站点时，不该被迫「全部恢复」 */}
          {optouts.slice(0, 3).map((o) => (
            <button
              key={o.domain}
              type="button"
              onClick={() => void restoreOneDomain(o.domain)}
              className="rounded-xs bg-muted px-1 py-px text-foreground/80 transition-colors hover:bg-accent-muted hover:text-accent"
              title={`恢复「${o.domain}」的自动整理`}
            >
              {o.domain}
              <span aria-hidden="true"> ×</span>
            </button>
          ))}
          {optouts.length > 3 && <span>等 {optouts.length} 个站点</span>}
          <button type="button" onClick={() => void restoreOptOuts()} className="text-accent hover:underline">
            全部恢复
          </button>
        </p>
      )}

      {entries.length > 0 && (
        <div className="mt-2.5 flex items-center gap-2">
          {confirmClear ? (
            <>
              <span className="text-2xs text-destructive">清空全部记录？这份历史不可恢复。</span>
              <Button
                variant="destructive"
                size="sm"
                className="ml-auto h-6 px-2 text-2xs"
                onClick={() => void clearAll()}
              >
                确认清空
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-2xs"
                onClick={() => setConfirmClear(false)}
              >
                取消
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-1.5 text-2xs text-muted-foreground hover:text-destructive"
                onClick={() => setConfirmClear(true)}
              >
                <Trash2 className="h-3 w-3" />
                清空记录
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-1.5 text-2xs text-muted-foreground"
                onClick={exportLog}
                title="导出为 Markdown（便于排查或存档）"
              >
                <Download className="h-3 w-3" />
                导出
              </Button>
              <span className="ml-auto text-2xs text-muted-foreground/60">保留最近 200 条</span>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}
