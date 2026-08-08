import { useMemo, useState } from 'react';
import { FolderInput, Search } from 'lucide-react';
import { useBookmarkStore, findNode, type BNode } from '@/stores/bookmarkStore';
import { pushToast } from '@/lib/toast';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

/**
 * 批量移动目标选择器：收集全部文件夹（含路径标题），支持搜索过滤。
 * 选择目标后对选中书签逐个 move（文件夹 move 自动携带子树）。
 */
export function MovePicker({
  bookmarkIds,
  onClose,
}: {
  bookmarkIds: string[];
  onClose: () => void;
}) {
  const roots = useBookmarkStore((s) => s.roots);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  // 收集全部文件夹：id + 缩进标题路径
  const folders = useMemo(() => {
    const out: { id: string; path: string; title: string }[] = [];
    const walk = (nodes: BNode[], chain: string[]) => {
      for (const n of nodes) {
        if (!n.children) continue;
        const title = n.title || '(未命名)';
        out.push({ id: n.id, path: [...chain, title].join(' / '), title });
        walk(n.children, [...chain, title]);
      }
    };
    walk(roots, []);
    return out;
  }, [roots]);

  const q = query.trim().toLowerCase();
  const filtered = q ? folders.filter((f) => f.path.toLowerCase().includes(q)) : folders;

  // 禁用目标：被移动的文件夹自身或其子树（chrome API 会拒绝）
  const forbidden = useMemo(() => {
    const ids = new Set<string>();
    const collect = (n: BNode) => {
      ids.add(n.id);
      for (const c of n.children ?? []) collect(c);
    };
    for (const id of bookmarkIds) {
      const found = findNode(roots, id);
      if (found && !found.url) collect(found);
    }
    return ids;
  }, [roots, bookmarkIds]);

  /** 批量移动到目标文件夹（部分失败时仍报告成功数） */
  const moveTo = (targetId: string, targetTitle: string) => {
    if (busy) return;
    setBusy(true);
    void Promise.allSettled(
      bookmarkIds.map((id) => chrome.bookmarks.move(id, { parentId: targetId })),
    )
      .then((results) => {
        const ok = results.filter((r) => r.status === 'fulfilled').length;
        const fail = results.length - ok;
        pushToast(
          ok > 0 ? `已移动 ${ok} 项至「${targetTitle}」` : '移动失败',
          fail > 0 && ok > 0 ? { description: `${fail} 项移动失败`, variant: 'destructive' } : undefined,
        );
        if (ok === 0) {
          setBusy(false);
          return;
        }
        useBookmarkStore.getState().clearSelection();
        // 展开祖先链并定位目标文件夹，用户立即看到结果
        useBookmarkStore.getState().revealInTree(targetId);
        void useBookmarkStore.getState().loadTree();
        onClose();
      })
      .catch(() => {
        pushToast('移动失败', { variant: 'destructive' });
      })
      .finally(() => setBusy(false));
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      title={`移动到…（${bookmarkIds.length} 项）`}
      description="选择目标文件夹，选中书签将整体移入。"
      width="w-[420px]"
      footer={
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          取消
        </Button>
      }
    >
      <div className="relative mb-2">
        <Search className="absolute top-1/2 left-2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Enter：选择第一个匹配文件夹（原生选择器习惯）
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              const first = filtered.find((f) => !forbidden.has(f.id));
              if (first) moveTo(first.id, first.title);
            }
          }}
          placeholder="搜索文件夹…"
          className="h-7 pl-6 pr-2 text-xs"
          autoFocus
        />
      </div>
      <div className="max-h-64 overflow-y-auto rounded-sm border border-border">
        {filtered.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">没有匹配的文件夹</p>
        ) : (
          filtered.map((f) => {
            const banned = forbidden.has(f.id);
            return (
              <button
                key={f.id}
                type="button"
                disabled={busy || banned}
                onClick={() => moveTo(f.id, f.title)}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-muted/70 disabled:pointer-events-none disabled:opacity-40"
                title={banned ? '不能移动到自身或其子文件夹' : f.path}
              >
                <FolderInput className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{f.path}</span>
              </button>
            );
          })
        )}
      </div>
    </Dialog>
  );
}
