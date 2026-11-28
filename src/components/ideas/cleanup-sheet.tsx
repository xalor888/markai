/**
 * 简单清理面板：勾选 → 「生成清理方案」→ 交给 Agent 走暂存/确认链路。
 *
 * 关键约束：这里**没有删除按钮**。用户勾完只会得到一段指令，
 * 真正的删除仍然要经过 Agent 的提议 → 界面确认。这不是"少做一步"，
 * 而是整个产品唯一允许的删除路径。
 */
import { useMemo, useState } from 'react';
import { CheckCircle2, Link2Off, Loader2, ScanLine, Sparkles } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useBookmarkStore } from '@/stores/bookmarkStore';
import {
  buildCleanupPrompt,
  CLEANUP_DEFAULT_SELECTION,
  computeCleanupCategories,
  impactCount,
  pendingProbeKinds,
  type CleanupKind,
  type CleanupSelection,
} from '@/lib/ideas/cleanup';
import { pushToast } from '@/lib/toast';
import { cn } from '@/lib/utils';

export function CleanupSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const roots = useBookmarkStore((s) => s.roots);
  const [selection, setSelection] = useState<CleanupSelection>(CLEANUP_DEFAULT_SELECTION);
  const [probing, setProbing] = useState(false);
  const [probed, setProbed] = useState<{ count: number; sampleIds: string[] } | undefined>(undefined);

  const categories = useMemo(() => computeCleanupCategories(roots, Date.now(), probed), [roots, probed]);
  const total = impactCount(categories, selection);
  const pending = pendingProbeKinds(categories, selection);
  const prompt = buildCleanupPrompt(categories, selection);

  const toggle = (kind: CleanupKind) => {
    setSelection((prev) => ({ ...prev, [kind]: !prev[kind] }));
  };

  /*
   * 断链检测：真实跑一遍 HTTP 探测会很慢，且这里没有扩展上下文（面板是纯 UI）。
   * 所以这里只负责"让用户知道要先检测"，并把指令交给 Agent——
   * Agent 有 check_urls_bulk 工具，能带进度、能取消。
   */
  const probe = () => {
    setProbing(true);
    document.dispatchEvent(
      new CustomEvent('markai:agent-prompt', {
        detail: '帮我检测书签库里的断链（死链），用 check_urls_bulk 跑一遍，把打不开的列出来，先不要删除。',
      }),
    );
    // 立刻关面板：检测在 Agent 面板里进行，留在这里只会挡住进度
    window.setTimeout(() => {
      setProbing(false);
      onOpenChange(false);
    }, 300);
  };

  const submit = () => {
    if (!prompt) {
      pushToast('先勾选要清理的类别', { variant: 'destructive' });
      return;
    }
    if (pending.length > 0) {
      pushToast('断链还没检测', { description: '先点「检测链接」，检测完再生成方案。', variant: 'destructive' });
      return;
    }
    document.dispatchEvent(new CustomEvent('markai:agent-prompt', { detail: prompt }));
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="简单清理"
      description="勾选要处理的类别，生成方案交给 Agent。删除仍需要你确认。"
      width="w-[440px]"
      testId="cleanup-sheet"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <span className="text-2xs text-muted-foreground" data-testid="cleanup-impact">
            将影响 <span className="font-medium text-foreground tabular-nums">{total}</span> 条
            {pending.length > 0 && <span className="text-muted-foreground/70">（另有待检测项未计入）</span>}
          </span>
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)} data-testid="cleanup-cancel" aria-label="取消清理">
              取消
            </Button>
            <Button size="sm" onClick={submit} data-testid="cleanup-generate" aria-label="生成清理方案">
              <Sparkles className="h-3 w-3" />
              生成清理方案
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-2">
        {categories.map((cat) => {
          const checked = selection[cat.kind];
          const unknown = cat.count === null;
          return (
            <div
              key={cat.kind}
              className={cn(
                'rounded-md border p-2.5 transition-colors',
                checked ? 'border-accent/40 bg-accent/[0.04]' : 'border-border',
              )}
            >
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(cat.kind)}
                  data-testid={`cleanup-check-${cat.kind}`}
                  aria-label={`选择 ${cat.label}`}
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--accent)]"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium">{cat.label}</span>
                    {unknown ? (
                      <span className="rounded-sm bg-muted px-1 py-px text-2xs text-muted-foreground">待检测</span>
                    ) : (
                      <span className="rounded-sm bg-muted px-1 py-px text-2xs text-muted-foreground tabular-nums">
                        {cat.count} 条
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-2xs text-muted-foreground">{cat.description}</p>
                  {cat.kind === 'broken' && checked && unknown && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-1.5"
                      onClick={probe}
                      disabled={probing}
                      data-testid="cleanup-probe"
                      aria-label="检测链接"
                    >
                      {probing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Link2Off className="h-3 w-3" />}
                      检测链接
                    </Button>
                  )}
                </div>
              </label>
            </div>
          );
        })}
        {total > 0 && pending.length === 0 && (
          <p className="flex items-center gap-1 text-2xs text-muted-foreground">
            <CheckCircle2 className="h-3 w-3 text-accent" />
            已勾选 {categories.filter((c) => selection[c.kind]).length} 类，生成后先列出来给你确认。
          </p>
        )}
        {pending.length > 0 && (
          <p className="flex items-center gap-1 text-2xs text-muted-foreground">
            <ScanLine className="h-3 w-3" />
            断链需要先检测才知道数量，未计入「将影响」。
          </p>
        )}
      </div>
    </Dialog>
  );
}
