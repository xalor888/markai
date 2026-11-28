/**
 * 「检查更新」入口（顶栏）。
 *
 * 数据来自 GitHub Releases（无 token）。这里只做"告知"：
 * 扩展不能自动下载/安装新版本，所以任何文案都不说"已更新"，只说
 * "发现新版本 / 已是最新版本"，并把发布页交给浏览器打开。
 *
 * 状态机：idle → checking → available / up-to-date / error。
 * 失败按网络、限流、解析分类：网络可重试，403 要等，解析失败重试也没用，
 * 三类都给同一个「重试」按钮，但文案说清为什么。
 */
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  checkForUpdate,
  readCachedUpdate,
  type UpdateCheck,
  type UpdateError,
} from '@/lib/update/check';
import { appVersion } from '@/lib/version';
import { openUrl } from '@/lib/open-url';
import { cn } from '@/lib/utils';
import { usePresence } from '@/lib/ui/use-presence';

function formatDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
}

function errorTitle(error: UpdateError): string {
  switch (error.kind) {
    case 'network':
      return '网络请求失败';
    case 'rate-limit':
      return 'GitHub 接口限流';
    case 'parse':
      return '发布信息解析失败';
    default:
      return '检查更新失败';
  }
}

export function UpdateCheckButton() {
  const [open, setOpen] = useState(false);
  const presence = usePresence(open);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [state, setState] = useState<UpdateCheck | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const run = useCallback(async (force: boolean, silent = false) => {
    setChecking(true);
    if (!silent) setBusy(true);
    try {
      const next = await checkForUpdate({ force });
      setState(next);
    } finally {
      setChecking(false);
      setBusy(false);
    }
  }, []);

  // 挂载时先读缓存（给顶栏的"有新版本"小圆点用），再走一次带 TTL 的检查。
  // 两者都不阻塞渲染；缓存命中时不会产生网络请求。
  useEffect(() => {
    let alive = true;
    void readCachedUpdate().then((cached) => {
      if (alive && cached) setState((prev) => prev ?? cached);
    });
    void run(false, true);
    return () => {
      alive = false;
    };
  }, [run]);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const available = state?.status === 'available';
  const current = state?.status === 'error' ? appVersion() : state?.current ?? appVersion();
  const statusLabel = checking
    ? '检查中'
    : available
      ? '有新版本'
      : state?.status === 'error'
        ? '检查失败'
        : state?.status === 'up-to-date'
          ? '已是最新'
          : '未检查';

  return (
    <div ref={rootRef} className="relative flex shrink-0 items-center">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="update-check"
        title="检查更新"
        aria-label="检查更新"
        aria-expanded={open}
        aria-haspopup="dialog"
        className="mk-press relative flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />
        {available && (
          <span
            data-testid="update-dot"
            aria-hidden="true"
            className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-accent ring-2 ring-card"
          />
        )}
      </button>

      {presence.mounted && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="检查更新"
          tabIndex={-1}
          data-testid="update-panel"
          data-state={presence.state}
          className={cn(
            'markai-glass markai-glass-liquid mk-glass-2 mk-panel absolute top-full right-0 z-50 mt-1.5 w-72',
            'overflow-hidden rounded-lg p-3 text-xs outline-none',
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-foreground">MarkAI 更新</p>
              <p className="mt-0.5 text-2xs text-muted-foreground">当前版本 v{current}</p>
            </div>
            <span
              data-testid="update-status"
              className={cn(
                'shrink-0 rounded-full px-1.5 py-0.5 text-2xs font-medium',
                available ? 'bg-accent/15 text-accent' : 'bg-muted text-muted-foreground',
              )}
            >
              {statusLabel}
            </span>
          </div>

          <div className="mt-2.5 border-t border-border/60 pt-2.5">
            {checking ? (
              <p className="text-2xs leading-4 text-muted-foreground">正在读取 GitHub Releases…</p>
            ) : state?.status === 'error' ? (
              <div className="space-y-1.5">
                <p className="text-2xs font-medium text-destructive">{errorTitle(state.error)}</p>
                <p className="text-2xs leading-4 break-words text-muted-foreground">{state.error.message}</p>
                <button
                  type="button"
                  data-testid="update-retry"
                  aria-label="重试检查更新"
                  onClick={() => void run(true)}
                  className="mk-press rounded-sm border border-border px-2 py-1 text-2xs font-medium text-foreground transition-colors hover:bg-muted"
                >
                  重试
                </button>
              </div>
            ) : state?.status === 'available' ? (
              <div className="space-y-1.5">
                <p className="text-2xs font-medium text-foreground">
                  发现新版本 v{state.release.version}
                  {state.release.prerelease && (
                    <span className="ml-1 rounded-xs bg-muted px-1 py-0.5 text-2xs text-muted-foreground">预发布</span>
                  )}
                </p>
                {formatDate(state.release.publishedAt) && (
                  <p className="text-2xs text-muted-foreground">发布于 {formatDate(state.release.publishedAt)}</p>
                )}
                {state.release.notes ? (
                  <p
                    data-testid="update-notes"
                    className="max-h-28 overflow-y-auto text-2xs leading-4 whitespace-pre-line text-muted-foreground"
                  >
                    {state.release.notes}
                  </p>
                ) : (
                  <p className="text-2xs text-muted-foreground">该版本没有发布说明。</p>
                )}
                <button
                  type="button"
                  data-testid="update-open-release"
                  aria-label="打开发布页"
                  onClick={() => void openUrl(state.release.url)}
                  className="mk-press w-full rounded-sm bg-accent px-2 py-1.5 text-2xs font-medium text-accent-foreground transition-colors hover:bg-accent/90"
                >
                  打开发布页
                </button>
              </div>
            ) : state?.status === 'up-to-date' ? (
              <p className="text-2xs leading-4 text-muted-foreground">
                已是最新版本。上次检查：{new Date(state.checkedAt).toLocaleTimeString('zh-CN')}
              </p>
            ) : (
              <p className="text-2xs leading-4 text-muted-foreground">还没有检查过。点下方按钮开始。</p>
            )}
          </div>

          <button
            type="button"
            data-testid="update-recheck"
            aria-label="重新检查更新"
            disabled={busy || checking}
            onClick={() => void run(true)}
            className="mk-press mt-2.5 w-full rounded-sm border border-border px-2 py-1 text-2xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            重新检查
          </button>
        </div>
      )}
    </div>
  );
}
