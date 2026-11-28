/**
 * 「检查更新」对话框。
 *
 * 数据来自 GitHub Releases（无 token）。这里只做"告知"：
 * 扩展不能自动下载/安装新版本，所以任何文案都不说"已更新"，只说
 * "发现新版本 / 已是最新版本"，并把发布页交给浏览器打开。
 *
 * 状态机：idle → checking → available / up-to-date / error。
 * 失败按网络、限流、解析分类：网络可重试，403 要等，解析失败重试也没用，
 * 三类都给同一个「重试」按钮，但文案说清为什么。
 *
 * 为什么从顶栏按钮改成对话框：顶栏只留「品牌 · 搜索 · 更多」三样，
 * 检查更新是低频操作，放进「更多」菜单；菜单里仍能带一个"有新版本"小圆点，
 * 所以收起来不等于藏起来。
 */
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  checkForUpdate,
  readCachedUpdate,
  type UpdateCheck,
  type UpdateError,
} from '@/lib/update/check';
import { appVersion } from '@/lib/version';
import { openUrl } from '@/lib/open-url';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';

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

/**
 * 顶栏/菜单用的"有新版本"标记。
 *
 * 只认**新鲜缓存**（30 分钟内）：过期结论可能早就被新版本推翻，
 * 用它点亮小圆点会让用户以为一直有新版本。
 */
export function useUpdateAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let alive = true;
    void readCachedUpdate().then((cached) => {
      if (alive) setAvailable(cached?.status === 'available');
    });
    return () => {
      alive = false;
    };
  }, []);
  return available;
}

export function UpdateCheckDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [state, setState] = useState<UpdateCheck | null>(null);

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

  // 打开时先读缓存（立刻给出上次结论），再走一次带 TTL 的检查。
  // 缓存命中时不会产生网络请求。
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void readCachedUpdate().then((cached) => {
      if (alive && cached) setState((prev) => prev ?? cached);
    });
    void run(false, true);
    return () => {
      alive = false;
    };
  }, [open, run]);

  const available = state?.status === 'available';
  const current = state?.status === 'error' ? appVersion() : (state?.current ?? appVersion());
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
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="检查更新"
      description="从 GitHub Releases 读取最新版本。扩展不会自动下载或安装更新。"
      width="w-[400px]"
      testId="update-panel"
      footer={
        <>
          {available && state?.status === 'available' && (
            <Button
              size="sm"
              data-testid="update-open-release"
              aria-label="打开发布页"
              onClick={() => void openUrl(state.release.url)}
            >
              打开发布页
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            data-testid="update-recheck"
            aria-label="重新检查更新"
            disabled={busy || checking}
            onClick={() => void run(true)}
          >
            <RefreshCw className={cn('h-3 w-3', busy && 'animate-spin')} />
            重新检查
          </Button>
        </>
      }
    >
      <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground">当前版本 v{current}</p>
          <p className="mt-0.5 text-2xs text-muted-foreground">
            {state?.status === 'up-to-date'
              ? `上次检查：${new Date(state.checkedAt).toLocaleTimeString('zh-CN')}`
              : 'MarkAI 书签助手'}
          </p>
        </div>
        <span
          data-testid="update-status"
          className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-2xs font-medium',
            available ? 'bg-accent/15 text-accent' : 'bg-muted text-muted-foreground',
          )}
        >
          {statusLabel}
        </span>
      </div>

      <div className="mt-3">
        {checking ? (
          <p className="text-2xs leading-4 text-muted-foreground">正在读取 GitHub Releases…</p>
        ) : state?.status === 'error' ? (
          <div className="space-y-1.5">
            <p className="text-2xs font-medium text-destructive">{errorTitle(state.error)}</p>
            <p className="text-2xs leading-4 break-words text-muted-foreground">{state.error.message}</p>
            <Button
              variant="secondary"
              size="sm"
              data-testid="update-retry"
              aria-label="重试检查更新"
              onClick={() => void run(true)}
            >
              重试
            </Button>
          </div>
        ) : state?.status === 'available' ? (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-foreground">
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
                className="max-h-56 overflow-y-auto text-2xs leading-4 whitespace-pre-line text-muted-foreground"
              >
                {state.release.notes}
              </p>
            ) : (
              <p className="text-2xs text-muted-foreground">该版本没有发布说明。</p>
            )}
          </div>
        ) : state?.status === 'up-to-date' ? (
          <p className="text-2xs leading-4 text-muted-foreground">已是最新版本，不需要更新。</p>
        ) : (
          <p className="text-2xs leading-4 text-muted-foreground">还没有检查过。点下方「重新检查」开始。</p>
        )}
      </div>
    </Dialog>
  );
}
