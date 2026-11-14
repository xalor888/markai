/**
 * ── 管理标签：重命名 / 合并 / 删除 ──
 *
 * 重命名到已存在的名字就是合并（同一套 normalize 去重），不会产生两个只差大小写的标签。
 * 删除是明确的两步确认：它会从**所有**书签上移除该标签，不可撤销。
 */
import { useEffect, useRef, useState } from 'react';
import { Check, Download, Pencil, Tag, Trash2, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { pushToast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  colorForTag,
  colorVarOf,
  readTagColors,
  setTagColor,
  TAG_COLORS,
  type TagColorMap,
  saveTagColors,
  type TagColorId,
} from '@/lib/bookmarks/tag-colors';
import { buildTagBackup, mergeTagBackup, parseTagBackup } from '@/lib/bookmarks/tag-backup';
import { flattenBookmarks } from '@/lib/bookmarks/timeline';
import { useBookmarkStore } from '@/stores/bookmarkStore';
import {
  collectTagCounts,
  deleteTag,
  renameTag,
  saveTagMap,
  type TagMap,
} from '@/lib/bookmarks/tags';

export function TagsManagerDialog({
  open,
  onClose,
  map,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  map: TagMap;
  onChange: (next: TagMap) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [colors, setColors] = useState<TagColorMap>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const tags = collectTagCounts(map);

  useEffect(() => {
    let alive = true;
    void readTagColors().then((c) => {
      if (alive) setColors(c);
    });
    return () => {
      alive = false;
    };
  }, []);

  const exportBackup = () => {
    const backup = buildTagBackup(map, colors);
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `markai-tags-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    pushToast('标签备份已导出', { variant: 'success' });
  };

  const importBackup = async (file: File) => {
    try {
      const raw: unknown = JSON.parse(await file.text());
      const backup = parseTagBackup(raw);
      if (!backup) {
        pushToast('不是有效的标签备份', { variant: 'destructive' });
        return;
      }
      const valid = new Set(flattenBookmarks(useBookmarkStore.getState().roots).map((i) => i.id));
      const merged = mergeTagBackup(map, colors, valid, backup);
      await saveTagMap(merged.tags);
      await saveTagColors(merged.colors);
      setColors(merged.colors);
      onChange(merged.tags);
      document.dispatchEvent(new CustomEvent('markai:tags-changed'));
      pushToast(`已导入 ${merged.imported} 条书签的标签`, {
        description: merged.skipped > 0 ? `${merged.skipped} 个 id 在当前书签库中不存在，已跳过。` : undefined,
        variant: 'success',
      });
    } catch (e) {
      pushToast('导入失败', {
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    }
  };

  const changeColor = async (tag: string, color: TagColorId) => {
    try {
      const next = await setTagColor(tag, color);
      setColors(next);
      document.dispatchEvent(new CustomEvent('markai:tags-changed'));
    } catch {
      pushToast('颜色保存失败', { variant: 'destructive' });
    }
  };

  const persist = async (next: TagMap, success: string) => {
    setBusy(true);
    try {
      await saveTagMap(next);
      onChange(next);
      document.dispatchEvent(new CustomEvent('markai:tags-changed'));
      pushToast(success, { variant: 'success' });
    } catch (e) {
      pushToast('标签保存失败', {
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  };

  const commitRename = (from: string) => {
    const to = draft.trim();
    if (!to) return;
    const exists = tags.some((t) => t.tag === to.toLowerCase() && t.tag !== from.toLowerCase());
    const next = renameTag(map, from, to);
    void persist(next, exists ? `已把「${from}」并入「${to}」` : `已重命名为「${to}」`).then(() => {
      setRenaming(null);
      setDraft('');
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title="管理标签"
      description="重命名到已有名字会合并；删除会从所有书签上移除，且不可撤销。"
      testId="tags-manager"
      width="w-[460px]"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={exportBackup}>
            <Download className="h-3 w-3" />
            导出
          </Button>
          <Button variant="ghost" size="sm" onClick={() => fileRef.current?.click()}>
            <Upload className="h-3 w-3" />
            导入
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            关闭
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            aria-label="导入标签备份文件"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void importBackup(file);
            }}
          />
        </>
      }
    >
      {tags.length === 0 ? (
        <p className="py-6 text-center text-2xs text-muted-foreground">还没有标签。</p>
      ) : (
        <ul className="max-h-80 space-y-1 overflow-y-auto pr-0.5">
          {tags.map(({ tag, count }) => (
            <li
              key={tag}
              className="flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-2"
            >
              <Tag className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              {renaming === tag ? (
                <>
                  <Input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) commitRename(tag);
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                    aria-label={`标签 ${tag} 的新名字`}
                    className="h-7 min-w-0 flex-1 text-xs"
                    maxLength={24}
                  />
                  <button
                    type="button"
                    onClick={() => commitRename(tag)}
                    className="rounded-md p-1 text-accent hover:bg-muted"
                    aria-label="保存标签名"
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setRenaming(null)}
                    className="rounded-md p-1 text-muted-foreground hover:bg-muted"
                    aria-label="取消重命名"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground">#{tag}</span>
                  <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">{count} 条</span>
                  <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label={`标签 ${tag} 的颜色`}>
                    {TAG_COLORS.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => void changeColor(tag, c.id)}
                        aria-label={`把 ${tag} 设为${c.label}`}
                        title={c.label}
                        className={cn(
                          'h-3 w-3 rounded-full border transition-transform hover:scale-110',
                          colorForTag(colors, tag) === c.id
                            ? 'border-foreground'
                            : 'border-transparent',
                        )}
                        style={{ backgroundColor: colorVarOf(c.id) }}
                      />
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setRenaming(tag);
                      setDraft(tag);
                      setConfirmDelete(null);
                    }}
                    className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    aria-label={`重命名标签 ${tag}`}
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  {confirmDelete === tag ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setConfirmDelete(null);
                        void persist(deleteTag(map, tag), `已删除标签「${tag}」`);
                      }}
                      className="shrink-0 rounded-md px-1.5 py-0.5 text-2xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                    >
                      确认删除？
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmDelete(tag);
                        window.setTimeout(() => {
                          setConfirmDelete((cur) => (cur === tag ? null : cur));
                        }, 5000);
                      }}
                      className={cn(
                        'rounded-md p-1 text-muted-foreground/60 transition-colors hover:bg-destructive/10 hover:text-destructive',
                      )}
                      aria-label={`删除标签 ${tag}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
