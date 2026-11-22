/**
 * ── 「整理方案等待确认」卡片 ──
 *
 * Agent 的整理默认先发生在书签栏下的「自动整理」暂存区里（见 lib/ai/organize-staging.ts），
 * 用户在这里做最后一步决定：
 *
 *   应用到「软件工具」　—— 分类搬进被整理的那个文件夹（默认）
 *   放到书签栏　　　　　—— 分类直接搬到书签栏根（就是想放根上时的捷径）
 *   其他文件夹　　　　　—— 用搜索挑任意目标（例如「其他书签 / 工作」）
 *   放弃　　　　　　　　—— 书签回原位，暂存区清空
 *
 * 为什么卡片只出现在「整理记录」里、而不是弹一个确认框：
 * 整理结果需要**对着树看一眼**才敢决定，确认框遮住界面、还催人点；
 * 而整理记录本来就是他"回头看看它干了什么"的地方，放这里正好。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, FolderInput, FolderSearch, Search, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { findNode, useBookmarkStore, type BNode } from '@/stores/bookmarkStore';
import {
  applyBatch,
  batchStats,
  bookmarkBarId,
  discardBatch,
  listBatches,
  STAGING_TITLE,
  type StagedBatch,
} from '@/lib/ai/organize-staging';
import { pushToast } from '@/lib/toast';
import { cn } from '@/lib/utils';

interface Row extends StagedBatch {
  folders: number;
  bookmarks: number;
  /** 原文件夹是否还在：被删后仍允许「放到书签栏 / 选择其他文件夹」，但不能假装能应用回原处 */
  targetAlive: boolean;
  /** 批次所在的暂存根（用于在选择器里排除整个暂存区） */
  stagingRootId?: string;
}

/** 选择器的目标：原文件夹 / 书签栏 / 任意文件夹 */
type Destination =
  | { kind: 'origin' }
  | { kind: 'bar' }
  | { kind: 'folder'; id: string; title: string };

/** 收集一个文件夹及其全部子孙 id（选择器里要禁用它们） */
function collectSubtree(node: BNode | null, into: Set<string>): void {
  if (!node) return;
  into.add(node.id);
  for (const child of node.children ?? []) collectSubtree(child, into);
}

export interface StagedBatchesCardProps {
  /** 外部（记录面板）每次刷新时递增，用来触发重读 */
  refreshToken?: number;
  /** 应用/放弃之后通知外层刷新树与记录 */
  onChanged?: () => void;
}

export function StagedBatchesCard({ refreshToken = 0, onChanged }: StagedBatchesCardProps) {
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  /** 放弃是破坏性的（书签会被搬回原位、分类结构丢弃）：先问一次 */
  const [confirmId, setConfirmId] = useState<string | null>(null);
  /** 正在展开「选择其他文件夹」的批次 */
  const [pickerId, setPickerId] = useState<string | null>(null);
  const [pickerQuery, setPickerQuery] = useState('');
  /** 目标文件夹来自当前树：不改书签，只用于展示与筛选 */
  const roots = useBookmarkStore((s) => s.roots);

  const load = useCallback(async () => {
    const batches = await listBatches().catch(() => [] as StagedBatch[]);
    const withStats = await Promise.all(
      batches.map(async (b) => {
        const s = await batchStats(b.batchId).catch(() => ({ folders: 0, bookmarks: 0 }));
        const target = await chrome.bookmarks.get(b.targetParentId).catch(() => []);
        const batchNode = await chrome.bookmarks.get(b.batchId).catch(() => []);
        const parentId = batchNode[0]?.parentId;
        // 只有父级真的是「自动整理」时才把它当作暂存根：用户把批次拖走后，
        // 不能把那个用户文件夹整个从落点候选里排除。
        const parent = parentId ? await chrome.bookmarks.get(parentId).catch(() => []) : [];
        const isStaging = (parent[0]?.title || '').trim() === STAGING_TITLE;
        return {
          ...b,
          ...s,
          targetAlive: !!(target[0] && !target[0].url),
          ...(isStaging && parentId ? { stagingRootId: parentId } : {}),
        };
      }),
    );
    // 空批次（开好但还没放东西）不显示：它在用户眼里什么都不是
    setRows(withStats.filter((r) => r.folders + r.bookmarks > 0));
    setPickerId((id) => (id && withStats.some((r) => r.batchId === id && r.folders + r.bookmarks > 0) ? id : null));
  }, []);

  /** 全部文件夹（含路径）：选择"放到哪个文件夹"时的候选 */
  const folderOptions = useMemo(() => {
    const out: { id: string; path: string; title: string }[] = [];
    const walk = (nodes: BNode[], chain: string[]) => {
      for (const n of nodes) {
        if (n.url) continue;
        const title = n.title || '(未命名)';
        out.push({ id: n.id, path: [...chain, title].join(' / '), title });
        walk(n.children ?? [], [...chain, title]);
      }
    };
    walk(roots, []);
    return out;
  }, [roots]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const apply = async (row: Row, dest: Destination) => {
    if (dest.kind === 'origin' && !row.targetAlive) {
      pushToast('原文件夹已不存在', {
        description: '请选择「放到书签栏」或「选择其他文件夹」。',
        variant: 'destructive',
      });
      return;
    }
    setBusy(row.batchId);
    try {
      const destId =
        dest.kind === 'origin'
          ? row.targetParentId
          : dest.kind === 'bar'
            ? await bookmarkBarId()
            : dest.id;
      const res = await applyBatch(row.batchId, destId);
      const label =
        dest.kind === 'origin'
          ? `已应用到「${row.targetTitle}」`
          : dest.kind === 'bar'
            ? '已放到书签栏'
            : `已放到「${dest.title}」`;
      pushToast(label, {
        description: `${res.folders} 个分类、${res.bookmarks} 条书签已落位`,
        variant: 'success',
      });
      setPickerId(null);
      await load();
      onChanged?.();
    } catch (e) {
      pushToast('应用失败', {
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    } finally {
      setBusy(null);
    }
  };

  const discard = async (row: Row) => {
    setBusy(row.batchId);
    try {
      const res = await discardBatch(row.batchId);
      pushToast('已放弃这次整理', {
        description: `${res.returned} 条书签已回到「${row.targetAlive ? row.targetTitle : '书签栏'}」`,
      });
      setConfirmId(null);
      await load();
      onChanged?.();
    } catch (e) {
      pushToast('放弃失败', {
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    } finally {
      setBusy(null);
    }
  };

  if (rows.length === 0) return null;

  return (
    <div className="mb-3 space-y-2" data-testid="staged-batches">
      {rows.map((row) => {
        const working = busy === row.batchId;
        const confirming = confirmId === row.batchId;
        const pickerOpen = pickerId === row.batchId;
        /*
         * 选择器里禁用暂存区内部与批次子树：
         * 把分类搬回暂存区等于没落位，搬进自己的子文件夹会形成循环。
         * 真正的兜底在 applyBatch，这里只是让用户根本点不到错的目标。
         */
        const blocked = new Set<string>();
        if (row.stagingRootId) collectSubtree(findNode(roots, row.stagingRootId), blocked);
        collectSubtree(findNode(roots, row.batchId), blocked);
        const q = pickerQuery.trim().toLowerCase();
        const choices = folderOptions
          .filter((f) => !blocked.has(f.id))
          .filter((f) => (q ? f.path.toLowerCase().includes(q) : true));
        return (
          <div
            key={row.batchId}
            className="rounded-xl border border-accent/30 bg-accent-muted p-3"
            data-testid="staged-batch"
          >
            <div className="flex items-start gap-2">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
                <FolderInput className="h-3 w-3" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-foreground">
                  整理方案等待你确认
                  <span className="ml-1.5 font-normal text-muted-foreground">
                    「{row.targetTitle}」{!row.targetAlive && '（原文件夹已删除）'}
                  </span>
                </p>
                <p className="mt-0.5 text-2xs leading-4 text-muted-foreground">
                  已放进「自动整理」暂存区：<Badge variant="outline" className="mx-1">{row.folders} 个分类</Badge>
                  <Badge variant="outline">{row.bookmarks} 条书签</Badge>
                  <span className="ml-1">确认后才会动你的文件夹。</span>
                </p>
              </div>
            </div>

            {confirming ? (
              <div className="mt-2 flex items-center gap-2">
                <p className="min-w-0 flex-1 text-2xs text-muted-foreground">
                  放弃后书签会回到「{row.targetAlive ? row.targetTitle : '书签栏'}」原来的位置，但新建的分类不会保留。
                </p>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={working}
                  onClick={() => void discard(row)}
                  data-testid="staged-discard-confirm"
                >
                  确认放弃
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmId(null)}>
                  取消
                </Button>
              </div>
            ) : (
              <div className="mt-2 space-y-2">
                {!row.targetAlive && (
                  <p className="rounded-md border border-dashed border-border px-2 py-1 text-2xs text-muted-foreground">
                    原文件夹已被删除：仍可「放到书签栏」或选择其他文件夹；「放弃」会把书签放回书签栏。
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="default"
                    disabled={working || !row.targetAlive}
                    onClick={() => void apply(row, { kind: 'origin' })}
                    data-testid="staged-apply-origin"
                    title={row.targetAlive ? undefined : '原文件夹已被删除，不能应用回原处'}
                  >
                    <Check className="h-3.5 w-3.5" />
                    {row.targetAlive ? `应用到「${row.targetTitle}」` : '原文件夹已删除'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={working}
                    onClick={() => void apply(row, { kind: 'bar' })}
                    data-testid="staged-apply-bar"
                    title="把分类直接搬到书签栏根目录"
                  >
                    放到书签栏
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={working}
                    onClick={() => {
                      const opening = !pickerOpen;
                      setPickerId(opening ? row.batchId : null);
                      setPickerQuery('');
                      // 打开选择器时强制读一次当前树：外部新建/移动的文件夹
                      // 可能还落在 bookmarkStore 的 300ms 防抖窗口里。
                      if (opening) void useBookmarkStore.getState().loadTree();
                    }}
                    data-testid="staged-apply-picker"
                    title="选择任意文件夹作为落点"
                  >
                    <FolderSearch className="h-3.5 w-3.5" />
                    其他文件夹
                  </Button>
                  <button
                    type="button"
                    disabled={working}
                    onClick={() => setConfirmId(row.batchId)}
                    data-testid="staged-discard"
                    className={cn(
                      'ml-auto flex items-center gap-1 rounded-sm px-1.5 py-1 text-2xs text-muted-foreground transition-colors',
                      'hover:bg-muted hover:text-destructive',
                      working && 'opacity-50',
                    )}
                  >
                    <Trash2 className="h-3 w-3" />
                    放弃
                  </button>
                </div>

                {pickerOpen && (
                  <div
                    className="rounded-lg border border-border bg-card p-2"
                    data-testid="staged-folder-picker"
                  >
                    <div className="relative mb-2">
                      <Search className="absolute top-1/2 left-2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={pickerQuery}
                        onChange={(e) => setPickerQuery(e.target.value)}
                        placeholder="搜索文件夹…"
                        className="h-7 pl-6 pr-2 text-xs"
                        autoFocus
                        data-testid="staged-folder-search"
                      />
                    </div>
                    <div className="max-h-44 overflow-y-auto rounded-md border border-border">
                      {choices.length === 0 ? (
                        <p className="px-3 py-4 text-center text-2xs text-muted-foreground">
                          没有可选的文件夹
                        </p>
                      ) : (
                        choices.map((f) => (
                          <button
                            key={f.id}
                            type="button"
                            disabled={working}
                            onClick={() =>
                              void apply(row, { kind: 'folder', id: f.id, title: f.title })
                            }
                            data-testid="staged-folder-option"
                            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-2xs text-foreground transition-colors hover:bg-muted/70 disabled:opacity-50"
                            title={f.path}
                          >
                            <FolderInput className="h-3 w-3 shrink-0 text-muted-foreground" />
                            <span className="truncate">{f.path}</span>
                          </button>
                        ))
                      )}
                    </div>
                    <div className="mt-1.5 flex justify-end">
                      <Button size="sm" variant="ghost" onClick={() => setPickerId(null)}>
                        取消
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
