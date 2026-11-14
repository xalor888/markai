/**
 * ── 批量移除标签 ──
 *
 * 与「添加标签」对称：选中多条书签，列出这些书签上出现过的标签（带出现条数），
 * 勾选后一次移除；每条的其他标签保持不动。
 */
import { useEffect, useState } from 'react';
import { Tag } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { pushToast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { readTagMap, removeTagsFromBookmarks, type TagMap } from '@/lib/bookmarks/tags';

export function RemoveTagsDialog({
  bookmarkIds,
  onClose,
}: {
  bookmarkIds: string[];
  onClose: () => void;
}) {
  const [map, setMap] = useState<TagMap>({});
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void readTagMap().then((m) => {
      if (!alive) return;
      setMap(m);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 这些书签上出现过的标签及条数（大小写不敏感合并）
  const counts = new Map<string, { label: string; count: number }>();
  for (const id of bookmarkIds) {
    for (const tag of map[id] ?? []) {
      const key = tag.toLowerCase();
      const current = counts.get(key);
      if (current) current.count += 1;
      else counts.set(key, { label: tag, count: 1 });
    }
  }
  const tags = [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh'));

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const save = async () => {
    if (selected.size === 0 || busy) return;
    setBusy(true);
    try {
      await removeTagsFromBookmarks(bookmarkIds, [...selected]);
      document.dispatchEvent(new CustomEvent('markai:tags-changed'));
      pushToast(`已从 ${bookmarkIds.length} 条移除 ${selected.size} 个标签`, { variant: 'success' });
      onClose();
    } catch (e) {
      pushToast('移除失败', {
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title="移除标签"
      description={`从所选的 ${bookmarkIds.length} 条书签上移除勾选的标签；其他标签保留。`}
      testId="remove-tags-dialog"
      width="w-[440px]"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button size="sm" disabled={selected.size === 0 || busy} onClick={() => void save()}>
            {busy ? '移除中…' : selected.size > 0 ? `移除 ${selected.size} 个标签` : '移除标签'}
          </Button>
        </>
      }
    >
      {loading ? (
        <p className="text-2xs text-muted-foreground">读取标签…</p>
      ) : tags.length === 0 ? (
        <p className="py-6 text-center text-2xs text-muted-foreground">所选书签还没有标签。</p>
      ) : (
        <ul className="max-h-72 space-y-1 overflow-y-auto pr-0.5">
          {tags.map(({ label, count }) => {
            const key = label.toLowerCase();
            const active = selected.has(key);
            return (
              <li key={key}>
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggle(key)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors',
                    active
                      ? 'border-accent/40 bg-accent-muted'
                      : 'border-border bg-card hover:bg-muted',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border',
                      active ? 'border-accent bg-accent text-accent-foreground' : 'border-input',
                    )}
                    aria-hidden="true"
                  >
                    {active && <span className="text-2xs">✓</span>}
                  </span>
                  <Tag className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground">#{label}</span>
                  <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
                    {count} 条
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
