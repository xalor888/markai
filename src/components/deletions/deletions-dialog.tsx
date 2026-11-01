import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, LocateFixed, Trash2 } from 'lucide-react';
import { useAIStore } from '@/stores/aiStore';
import { useUIStore } from '@/stores/uiStore';
import { useBookmarkStore } from '@/stores/bookmarkStore';
import { createBusyGuard } from '@/lib/chat/busy-guard';
import { formatRelativeTime, getHost, truncate } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog } from '@/components/ui/dialog';
import { Favicon } from '@/components/common/favicon';

/**
 * 全局「待删除清单」汇总对话框：
 * 汇聚本次会话所有 Agent 删除提议，默认全选，统一确认执行（removeTree）。
 */
export function DeletionsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const pendingDeletions = useAIStore((s) => s.pendingDeletions);
  const confirmDeletions = useAIStore((s) => s.confirmDeletions);
  const declineAllDeletions = useAIStore((s) => s.declineAllDeletions);
  /* 勾选状态由「全部候选 − 用户取消的」推导出来。
   * 取消的 id 存在 store 里：关掉面板再打开，用户的「这几条我不想删」必须还在，
   * 否则重开时被重置成全选，下一次点删除就会连它们一起删掉。 */
  const uncheckedIds = useUIStore((s) => s.deletionUnchecked);
  const setUncheckedIds = useUIStore((s) => s.setDeletionUnchecked);
  const checked = useMemo(() => {
    const set = new Set<string>();
    for (const p of pendingDeletions) {
      if (!uncheckedIds.has(p.id)) set.add(p.id);
    }
    return set;
  }, [pendingDeletions, uncheckedIds]);
  const setChecked = (next: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    const resolved =
      typeof next === 'function'
        ? next(new Set(pendingDeletions.filter((p) => !uncheckedIds.has(p.id)).map((p) => p.id)))
        : next;
    const keep = new Set(pendingDeletions.map((p) => p.id));
    const unchecked = new Set<string>();
    for (const id of keep) {
      if (!resolved.has(id)) unchecked.add(id);
    }
    setUncheckedIds(unchecked);
  };
  // 执行清理的进行中状态（防止重复点击）
  const [executing, setExecuting] = useState(false);
  // 逐条删除的进行中集合：只锁对应行，支持连续点多行。
  // T10：真正的守卫在 ref（同步可变，begin() 原子占用），state 只负责渲染；
  // 否则同一 tick 连点同一行会读到旧快照、重复提交。
  const busyGuard = useRef(createBusyGuard());
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());

  // useMemo 稳定引用：pending 若为每次渲染新建的数组，会被下面 useEffect 的依赖数组
  // 视为「每次都在变」，导致打开对话框时 effect 每渲染都重跑 + setChecked 每渲染都产生新 Set，
  // 形成无限重渲染（CPU 空转）
  const pending = useMemo(
    () => pendingDeletions.filter((p) => p.status === 'pending'),
    [pendingDeletions],
  );

  /* 默认全选由 `uncheckedIds` 推导（见上面的 checked useMemo），所以这里**不再需要**「打开时全选」。
   * 之前那套 initialSelectDone + setChecked(ids) 会把用户在上一轮取消的勾选覆盖掉。 */
  useEffect(() => {
    if (!open) return;
    // 只清理「已经不在候选里」的 id，避免 unchecked 集合无限增长
    const validIds = new Set(pending.map((p) => p.id));
    const next = new Set([...useUIStore.getState().deletionUnchecked].filter((id) => validIds.has(id)));
    if (next.size !== useUIStore.getState().deletionUnchecked.size) {
      useUIStore.getState().setDeletionUnchecked(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pending]);

  // 仅统计仍处于 pending 的勾选项：checked 可能残留已执行/已放弃的旧 id（状态切换后 pending 收缩）
  const checkedCount = pending.filter((p) => checked.has(p.id)).length;
  const allChecked = pending.length > 0 && checkedCount === pending.length;

  const toggleAll = () => {
    setChecked(allChecked ? new Set() : new Set(pending.map((p) => p.id)));
  };

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /**
   * 逐条删除：点一次就执行这一条，对话框保持打开，方便连续清理多条。
   * busy 与 executing 互斥，避免与「执行清理」并发提交同一批提议；
   * finally 解锁保证失败后按钮立刻可重试（不会出现「点一次之后再点没反应」）。
   */
  const removeOne = async (id: string) => {
    if (executing) return;
    if (!busyGuard.current.begin(id)) return;
    setBusyIds(busyGuard.current.snapshot());
    try {
      await confirmDeletions([id]);
    } catch {
      // 失败已由 store 如实 toast；finally 解锁后可直接重试
    } finally {
      busyGuard.current.end(id);
      setBusyIds(busyGuard.current.snapshot());
      // 已处理项从勾选集合移除，底部计数与按钮状态立即同步
      setChecked((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  return (
    <Dialog
      testId="deletions"
      open={open}
      onOpenChange={onOpenChange}
      title={`待删除清单（${pending.length} 项）`}
      description="由 Agent 提出的删除建议；勾选确认后才会真正删除书签。"
      width="w-[480px]"
      footer={
        pending.length > 0 ? (
          <>
            <Button variant="ghost" size="sm" onClick={() => void declineAllDeletions()} disabled={executing}>
              全部放弃
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={checkedCount === 0 || executing}
              onClick={() => {
                setExecuting(true);
                // 只提交仍为 pending 的勾选项，避免把已执行/已放弃的旧 id 误传给删除执行
                const ids = pending.filter((p) => checked.has(p.id)).map((p) => p.id);
                void confirmDeletions(ids).finally(() => {
                  setExecuting(false);
                  onOpenChange(false);
                });
              }}
            >
              {executing ? '执行中…' : `执行清理（${checkedCount}）`}
            </Button>
          </>
        ) : undefined
      }
    >
      {pending.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">
          当前没有待确认的删除提议。让 Agent 扫描清理后，提议会出现在这里。
        </p>
      ) : (
        <>
          <div className="max-h-72 overflow-y-auto rounded-md border border-border">
            {pending.map((p) => (
              <div key={p.id} className="flex items-start gap-2.5 border-b border-border/60 px-3 py-2.5 last:border-b-0">
                <div className="mt-px">
                  <Checkbox checked={checked.has(p.id)} disabled={executing} onCheckedChange={() => toggle(p.id)} aria-label={`选择删除 ${p.title}`} />
                </div>
                <Favicon url={p.url} size={16} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1">
                    <p className="truncate text-xs text-foreground">{p.title}</p>
                    {/* 删除前定位：在树中显示该书签，确认位置与上下文 */}
                    <button
                      type="button"
                      onClick={() => useBookmarkStore.getState().revealInTree(p.bookmarkId)}
                      className="shrink-0 rounded-sm p-0.5 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
                      title="在树中显示"
                      aria-label="在树中显示"
                    >
                      <LocateFixed className="h-3 w-3" />
                    </button>
                  </div>
                  <p className="mt-1 text-2xs leading-4 text-muted-foreground">
                    {truncate(p.reason, 90)}
                    {p.url && ` · ${getHost(p.url)}`}
                  </p>
                </div>
                <span className="shrink-0 text-2xs text-muted-foreground">{formatRelativeTime(p.createdAt)}</span>
                {/* 逐条删除：不必先勾选再点底部按钮（原先只有批量路径，单条清理要绕两步） */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    void removeOne(p.id);
                  }}
                  disabled={executing || busyIds.has(p.id)}
                  className="mt-0.5 shrink-0 rounded-sm p-1 text-destructive/80 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
                  title="立即删除这一项"
                  aria-label={`删除 ${p.title}`}
                >
                  {busyIds.has(p.id) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                </button>
              </div>
            ))}
          </div>
          <div className="mt-3.5 flex items-center gap-2">
            <Checkbox checked={allChecked} disabled={executing} onCheckedChange={toggleAll} aria-label="全选" />
            <span className="text-xs text-muted-foreground">全选</span>
            <Badge className="ml-auto" variant="outline">
              共 {pending.length} 项
            </Badge>
          </div>
        </>
      )}
    </Dialog>
  );
}
