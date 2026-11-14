/**
 * ── 标签编辑对话框（单个 / 批量） ──
 *
 * 单个书签：显示已有标签，保存时**替换**（可以清空）。
 * 批量：以"添加"为语义，保留每条原有标签；不静默覆盖用户已有的分类。
 */
import { useEffect, useMemo, useState } from 'react';
import { Plus, Tag, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { pushToast } from '@/lib/toast';
import { findNode, useBookmarkStore } from '@/stores/bookmarkStore';
import {
  addTags,
  addTagsToBookmarks,
  collectTagCounts,
  MAX_TAGS_PER_BOOKMARK,
  readTagMap,
  setBookmarkTags,
  type TagMap,
} from '@/lib/bookmarks/tags';

export function TagsDialog({
  bookmarkIds,
  onClose,
}: {
  bookmarkIds: string[];
  onClose: () => void;
}) {
  const roots = useBookmarkStore((s) => s.roots);
  const single = bookmarkIds.length === 1 ? findNode(roots, bookmarkIds[0]!) : null;
  const [map, setMap] = useState<TagMap>({});
  const [chips, setChips] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    void readTagMap().then((m) => {
      if (!alive) return;
      setMap(m);
      if (bookmarkIds.length === 1) setChips(m[bookmarkIds[0]!] ?? []);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [bookmarkIds]);

  const suggestions = useMemo(() => {
    const all = collectTagCounts(map).map((t) => t.tag);
    const selected = new Set(chips.map((t) => t.toLowerCase()));
    return all.filter((t) => !selected.has(t.toLowerCase())).slice(0, 8);
  }, [map, chips]);

  const add = (raw: string) => {
    const next = addTags(chips, [raw]);
    if (next.length === chips.length) {
      setError(chips.length > 0 ? '已经有这个标签了' : '标签不能为空');
      return;
    }
    if (next.length > MAX_TAGS_PER_BOOKMARK) {
      setError(`每个书签最多 ${MAX_TAGS_PER_BOOKMARK} 个标签`);
      return;
    }
    setChips(next);
    setInput('');
    setError('');
  };

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (bookmarkIds.length === 1) {
        await setBookmarkTags(bookmarkIds[0]!, chips);
      } else {
        if (chips.length === 0) {
          setError('批量模式至少添加一个标签');
          setBusy(false);
          return;
        }
        await addTagsToBookmarks(bookmarkIds, chips);
      }
      document.dispatchEvent(new CustomEvent('markai:tags-changed'));
      pushToast(bookmarkIds.length === 1 ? '标签已更新' : `已给 ${bookmarkIds.length} 条添加标签`, {
        variant: 'success',
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={bookmarkIds.length === 1 ? '编辑标签' : `给 ${bookmarkIds.length} 条书签加标签`}
      description={
        bookmarkIds.length === 1
          ? (single?.title ?? '这个书签')
          : '保留每条原有标签，只追加你输入的标签。'
      }
      testId="tags-dialog"
      width="w-[460px]"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={loading || busy}>
            {busy ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {loading ? (
          <p className="text-2xs text-muted-foreground">读取标签…</p>
        ) : (
          <>
            <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-border bg-background p-2">
              {chips.length === 0 ? (
                <span className="px-1 text-2xs text-muted-foreground/60">还没有标签</span>
              ) : (
                chips.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 rounded-md bg-accent-muted px-1.5 py-0.5 text-2xs text-accent"
                  >
                    <Tag className="h-3 w-3" />
                    {tag}
                    <button
                      type="button"
                      onClick={() => setChips((prev) => prev.filter((t) => t !== tag))}
                      className="rounded-xs p-0.5 transition-colors hover:bg-card hover:text-foreground"
                      aria-label={`移除标签 ${tag}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))
              )}
            </div>

            <div className="flex gap-2">
              <Input
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  setError('');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    if (input.trim()) add(input);
                  }
                }}
                placeholder="输入标签后回车，例如：待读"
                aria-label="标签输入"
                maxLength={24}
                className="h-9"
              />
              <Button size="sm" variant="outline" onClick={() => input.trim() && add(input)} disabled={!input.trim()}>
                <Plus className="h-3 w-3" />
                添加
              </Button>
            </div>
            {error && <p className="text-2xs text-destructive">{error}</p>}

            {suggestions.length > 0 && (
              <div>
                <p className="mb-1 text-2xs text-muted-foreground/70">已有标签（点击添加）</p>
                <div className="flex flex-wrap gap-1">
                  {suggestions.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => add(tag)}
                      className="rounded-md border border-border bg-card px-1.5 py-0.5 text-2xs text-muted-foreground transition-colors hover:border-accent/40 hover:text-accent"
                    >
                      #{tag}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
