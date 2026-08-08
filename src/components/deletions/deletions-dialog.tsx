import { useEffect, useRef, useState } from 'react';
import { LocateFixed } from 'lucide-react';
import { useAIStore } from '@/stores/aiStore';
import { useBookmarkStore } from '@/stores/bookmarkStore';
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
  const [checked, setChecked] = useState<Set<string>>(new Set());
  // 已见过的提议 id：仅对新增项默认勾选，不覆盖用户手动取消的选择
  const seenIds = useRef(new Set<string>());
  // 执行清理的进行中状态（防止重复点击）
  const [executing, setExecuting] = useState(false);
  // 本次打开是否已做初始全选（防止 pending 引用变化时把用户手动取消的项重新勾上）
  const initialSelectDone = useRef(false);

  const pending = pendingDeletions.filter((p) => p.status === 'pending');

  // 打开时全选当前项；打开期间新提议到达时只勾选新增项
  useEffect(() => {
    if (!open) return;
    if (!initialSelectDone.current) {
      // 本次打开的首次运行：清理残留勾选 + 全选当前项
      initialSelectDone.current = true;
      const ids = new Set(pending.map((p) => p.id));
      for (const p of pending) seenIds.current.add(p.id);
      setChecked(ids);
      return;
    }
    // 后续（新提议到达 / 跨窗口合并）：清理失效勾选，只勾选新增项，不覆盖用户手动取消
    const validIds = new Set(pending.map((p) => p.id));
    setChecked((prev) => {
      const next = new Set([...prev].filter((id) => validIds.has(id)));
      const fresh = pending.filter((p) => !seenIds.current.has(p.id));
      for (const p of pending) seenIds.current.add(p.id);
      for (const p of fresh) next.add(p.id);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pending]);

  // 关闭时重置初始标记（下次打开重新全选）
  useEffect(() => {
    if (!open) initialSelectDone.current = false;
  }, [open]);

  const allChecked = pending.length > 0 && checked.size === pending.length;

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

  return (
    <Dialog
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
              disabled={checked.size === 0 || executing}
              onClick={() => {
                setExecuting(true);
                void confirmDeletions([...checked]).finally(() => {
                  setExecuting(false);
                  onOpenChange(false);
                });
              }}
            >
              {executing ? '执行中…' : `执行清理（${checked.size}）`}
            </Button>
          </>
        ) : undefined
      }
    >
      {pending.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">
          当前没有待确认的删除提议。让 Agent 扫描清理后，提议会出现在这里。
        </p>
      ) : (
        <>
          <div className="max-h-72 overflow-y-auto rounded-sm border border-border">
            {pending.map((p) => (
              <div key={p.id} className="flex items-start gap-2 border-b border-border/60 px-2.5 py-2 last:border-b-0">
                <div className="mt-0.5">
                  <Checkbox checked={checked.has(p.id)} disabled={executing} onCheckedChange={() => toggle(p.id)} aria-label={`选择删除 ${p.title}`} />
                </div>
                <Favicon url={p.url} size={14} />
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
                  <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                    {truncate(p.reason, 90)}
                    {p.url && ` · ${getHost(p.url)}`}
                  </p>
                </div>
                <span className="shrink-0 text-[11px] text-muted-foreground">{formatRelativeTime(p.createdAt)}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2">
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
