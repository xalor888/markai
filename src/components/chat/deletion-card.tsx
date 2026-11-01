import { Loader2, LocateFixed, Trash2 } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { useAIStore } from '@/stores/aiStore';
import { useBookmarkStore } from '@/stores/bookmarkStore';
import type { DeletionProposal } from '@/lib/ai/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { createBusyGuard, runExclusive } from '@/lib/chat/busy-guard';

/**
 * 删除提议卡片（Agent 唯一删除入口）：
 * AI 只能提交提议，用户勾选并点「确认删除」后，才由 background 执行 removeTree。
 * memo 化：流式渲染时旧卡片跳过重渲染。
 */
export const DeletionCard = memo(function DeletionCard({ proposals }: { proposals: DeletionProposal[] }) {
  const confirmDeletions = useAIStore((s) => s.confirmDeletions);
  const resolveDeletions = useAIStore((s) => s.resolveDeletions);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  // 逐条删除的进行中状态：只锁住被点的那一行，其他行仍可继续操作。
  // 用 Set 而不是单个 id，才能支撑「连续点击多行删除」都不互相卡住。
  //
  // T10：守卫必须放 ref 里。registry 是**同步可变**的，begin() 先占用再返回，
  // 与 React 何时重渲染无关；下面这份 state 只用于渲染（快照）。
  // 原先直接 `if (busyIds.has(id)) return` 读的是本次渲染的旧快照 —— 同一 tick
  // 连点同一行 5 次会全部放行，发 5 次 confirmDeletions（靠 store 兜底才没删两次）。
  const busyGuard = useRef(createBusyGuard());
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  // 记录已见过的提议 id，仅对"新增"提议默认勾选，不覆盖用户手动取消的选择
  const seenIds = useRef(new Set<string>());

  const pending = proposals.filter((p) => p.status === 'pending');
  const executedCount = proposals.filter((p) => p.status === 'executed').length;

  useEffect(() => {
    const fresh = proposals.filter((p) => p.status === 'pending' && !seenIds.current.has(p.id));
    for (const p of proposals) seenIds.current.add(p.id);
    if (fresh.length > 0) {
      setChecked((prev) => {
        const next = new Set(prev);
        for (const p of fresh) next.add(p.id);
        return next;
      });
    }
  }, [proposals]);

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /**
   * 逐条删除：点击一行即确认删除这一条（用户显式点击 = 确认动作）。
   * 必须先落 busy、再 await，最后在 finally 里解锁——任何失败路径都不会让按钮永久卡死，
   * 所以同一行可以反复点、不同行可以连续点。
   */
  const removeOne = (id: string) => {
    // 失败提示由 store 统一 toast；这里只保证按钮一定解锁（不被 rejection 打断）
    runExclusive(busyGuard.current, id, () => confirmDeletions([id]), setBusyIds);
  };

  const pendingIds = pending.map((p) => p.id);
  const allChecked = pendingIds.length > 0 && pendingIds.every((id) => checked.has(id));
  // 仅统计待处理项中已勾选的数量（checked 可能混入已处理项的残留 id）
  const checkedPending = pendingIds.filter((id) => checked.has(id)).length;

  /** 全选 / 取消全选（仅作用于待处理项） */
  const toggleAll = () => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (allChecked) for (const id of pendingIds) next.delete(id);
      else for (const id of pendingIds) next.add(id);
      return next;
    });
  };

  return (
    <div className="mt-2 overflow-hidden rounded-md border border-destructive/30 bg-destructive/5">
      {/* 卡片头部：中性标题，危险色仅用于操作区 */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Trash2 className="h-3.5 w-3.5 text-destructive" />
        <span className="text-xs font-semibold text-foreground">删除提议 · {proposals.length} 项</span>
        {pending.length > 1 && (
          <button
            type="button"
            onClick={toggleAll}
            className="rounded-sm px-1 text-2xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title={allChecked ? '取消全选' : '全选'}
          >
            {allChecked ? '取消全选' : '全选'}
          </button>
        )}
        <span className="ml-auto text-2xs text-muted-foreground">确认后才执行</span>
      </div>

      {/* 提议列表 */}
      <div className="max-h-56 overflow-auto">
        {proposals.map((p) => (
          <div key={p.id} className="flex items-start gap-2.5 border-b border-border/50 px-3 py-2 last:border-b-0">
            <div className="mt-px">
              <Checkbox
                checked={checked.has(p.id) && p.status === 'pending'}
                disabled={p.status !== 'pending'}
                onCheckedChange={() => toggle(p.id)}
                aria-label={`选择删除 ${p.title}`}
              />
            </div>
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
              <p className="mt-0.5 text-2xs leading-4 text-muted-foreground">{p.reason}</p>
            </div>
            {p.status === 'pending' ? (
              <button
                type="button"
                onClick={(e) => {
                  // 阻止冒泡：卡片/消息层未来若加点击处理，也不会把这次点击吃掉
                  e.preventDefault();
                  e.stopPropagation();
                  removeOne(p.id);
                }}
                disabled={busyIds.has(p.id)}
                className="flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-2xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
                title="立即删除这一项（无需再勾选）"
                aria-label={`删除 ${p.title}`}
              >
                {busyIds.has(p.id) ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    删除中
                  </>
                ) : (
                  <>
                    <Trash2 className="h-3 w-3" />
                    删除
                  </>
                )}
              </button>
            ) : null}
            {p.status === 'executed' && <Badge variant="success">已删除</Badge>}
            {p.status === 'confirmed' && <Badge>执行中</Badge>}
            {p.status === 'declined' && <Badge variant="outline">已放弃</Badge>}
          </div>
        ))}
      </div>

      {/* 操作区 */}
      {pending.length > 0 ? (
        <div className="flex items-center gap-2 border-t border-border px-3 py-2.5">
          <Button
            size="sm"
            variant="destructive"
            disabled={checkedPending === 0}
            onClick={() => {
              // 只提交仍为 pending 的勾选项，避免把已执行/已放弃的旧 id 误传
              void confirmDeletions(pendingIds.filter((id) => checked.has(id)));
            }}
          >
            确认删除（{checkedPending}）
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              resolveDeletions(pending.map((p) => [p.id, 'declined']));
            }}
          >
            放弃
          </Button>
        </div>
      ) : (
        <div className="px-3 py-2 text-2xs text-muted-foreground">
          {executedCount > 0 ? `已删除 ${executedCount} 项。` : '本组提议已处理。'}
        </div>
      )}
    </div>
  );
});
