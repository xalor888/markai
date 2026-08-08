import { useEffect, useState } from 'react';
import { useBookmarkStore, findNode, resolveTitlePath } from '@/stores/bookmarkStore';
import { useUIStore } from '@/stores/uiStore';
import { pushToast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MovePicker } from '@/components/bookmark-list/move-picker';

/**
 * 书签管理对话框（新建文件夹 / 新建书签 / 重命名 / 删除），
 * 由树与列表的右键菜单、空状态按钮通过 uiStore 触发。
 */
export function BookmarkDialogs() {
  const dialog = useUIStore((s) => s.dialog);
  const closeDialog = useUIStore((s) => s.closeDialog);
  const loadTree = useBookmarkStore((s) => s.loadTree);
  const roots = useBookmarkStore((s) => s.roots);

  /** 新建成功后：展开父文件夹并选中，让结果立即可见 */
  const revealCreated = (parentId: string) => {
    useBookmarkStore.setState((s) => ({
      expandedIds: s.expandedIds.includes(parentId) ? s.expandedIds : [...s.expandedIds, parentId],
      selectedFolderId: parentId,
    }));
  };

  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const node =
    dialog &&
    dialog.kind !== 'create-folder' &&
    dialog.kind !== 'create-bookmark' &&
    dialog.kind !== 'move' &&
    dialog.kind !== 'delete-many'
      ? findNode(roots, dialog.bookmarkId)
      : null;

  // 打开对话框时预填默认值
  // 注意：只依赖 dialog（打开时的新对象引用），不依赖派生 node——
  // node 随 roots 刷新变化会导致 effect 重跑，把用户正在输入的内容重置回原值
  useEffect(() => {
    if (!dialog) return;
    const s = useBookmarkStore.getState();
    if (dialog.kind === 'rename') {
      const n = findNode(s.roots, dialog.bookmarkId);
      setTitle(n?.title || '');
    } else if (dialog.kind === 'edit-url') {
      const n = findNode(s.roots, dialog.bookmarkId);
      setUrl(n?.url || '');
    } else if (dialog.kind === 'create-folder') {
      setTitle('');
    } else if (dialog.kind === 'create-bookmark') {
      setTitle('');
      setUrl('');
      // 预填当前活动标签页（仅 http/https），像原生收藏一样减少手动输入
      void chrome.tabs
        .query({ active: true, currentWindow: true })
        .then(([tab]) => {
          const u = tab?.url;
          if (u && /^https?:\/\//i.test(u)) {
            // 回调竞态保护：用户已开始输入则不覆盖
            setTitle((prev) => prev || tab.title || u);
            setUrl((prev) => prev || u);
          }
        })
        .catch(() => {});
    }
  }, [dialog]);

  // 目标书签已被删除时自动关闭（例如 AI 刚清掉它；批量/移动对话框无单目标，跳过）
  useEffect(() => {
    if (
      dialog &&
      dialog.kind !== 'create-folder' &&
      dialog.kind !== 'create-bookmark' &&
      dialog.kind !== 'move' &&
      dialog.kind !== 'delete-many' &&
      !node
    ) {
      closeDialog();
    }
  }, [dialog, node, closeDialog]);

  if (!dialog) return null;

  /** 新建文件夹 */
  const handleCreate = async () => {
    const name = title.trim();
    if (!name) return;
    setBusy(true);
    const parentId = dialog.kind === 'create-folder' ? dialog.parentId : undefined;
    try {
      await chrome.bookmarks.create({ parentId, title: name });
      pushToast('文件夹已创建', { variant: 'success' });
      closeDialog();
      await loadTree();
      // 展开父文件夹并选中，让新建结果可见（父为折叠态时否则看不到）
      if (parentId) revealCreated(parentId);
    } catch (e) {
      pushToast('创建失败', { description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  /** 新建书签 */
  const handleCreateBookmark = async () => {
    if (dialog.kind !== 'create-bookmark') return;
    const name = title.trim();
    let finalUrl = url.trim();
    if (!name || !finalUrl) return;
    if (!/^https?:\/\//i.test(finalUrl)) finalUrl = `https://${finalUrl}`;
    try {
      new URL(finalUrl);
    } catch {
      pushToast('URL 格式无效', { variant: 'destructive' });
      return;
    }
    setBusy(true);
    const parentId = dialog.parentId;
    try {
      await chrome.bookmarks.create({ parentId, title: name, url: finalUrl });
      pushToast('书签已创建', { variant: 'success' });
      closeDialog();
      await loadTree();
      // 展开父文件夹并选中，让新建结果可见（父为折叠态时否则看不到）
      if (parentId) revealCreated(parentId);
    } catch (e) {
      pushToast('创建失败', { description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  /** 重命名（根文件夹拒绝） */
  const handleRename = async () => {
    if (dialog.kind !== 'rename' || !node) return;
    if (useBookmarkStore.getState().roots.some((r) => r.id === node.id)) {
      pushToast('根文件夹不可重命名', { variant: 'destructive' });
      closeDialog();
      return;
    }
    const name = title.trim();
    if (!name || name === node.title) {
      closeDialog();
      return;
    }
    setBusy(true);
    try {
      await chrome.bookmarks.update(node.id, { title: name });
      pushToast('已重命名', { variant: 'success' });
      closeDialog();
      await loadTree();
    } catch (e) {
      pushToast('重命名失败', { description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  /** 批量删除（多选条触发；逐项 remove/removeTree，根文件夹跳过） */
  const handleDeleteMany = async () => {
    if (dialog.kind !== 'delete-many') return;
    setBusy(true);
    const ids = dialog.bookmarkIds;
    let okCount = 0;
    let failCount = 0;
    if (ids.length === 0) {
      // 目标已全部消失（例如被另一窗口删除）
      closeDialog();
      return;
    }
    try {
      // 删除成功的项才收集（文件夹含子树），失败项保留在多选中
      const removed = new Set<string>();
      // 每个被删文件夹记录其父级：当前查看的文件夹落在哪个被删子树里，就回退到对应父级
      const parentOf: { folderId: string; parentId: string | null }[] = [];
      const collect = (n: chrome.bookmarks.BookmarkTreeNode) => {
        removed.add(n.id);
        for (const c of n.children ?? []) collect(c);
      };
      for (const id of ids) {
        const n = findNode(useBookmarkStore.getState().roots, id);
        if (!n) continue;
        if (useBookmarkStore.getState().roots.some((r) => r.id === id)) continue; // 根文件夹跳过
        try {
          if (n.url) await chrome.bookmarks.remove(id);
          else {
            await chrome.bookmarks.removeTree(id);
            parentOf.push({ folderId: id, parentId: n.parentId ?? null });
          }
          okCount++;
          collect(n);
        } catch {
          failCount++;
        }
      }
      useBookmarkStore.setState((s) => ({
        selectedBookmarkIds: s.selectedBookmarkIds.filter((id) => !removed.has(id)),
      }));
      if (okCount === 0) {
        // 目标全部失效（已被其他窗口删除 / 根文件夹）：不是成功，不能显示 success 误导
        pushToast(failCount > 0 ? `删除失败（${failCount} 项）` : '没有可删除的书签', {
          variant: failCount > 0 ? 'destructive' : 'default',
          description: failCount === 0 ? '目标可能已被删除，或为不可删除的根文件夹。' : undefined,
        });
      } else {
        pushToast(
          `已删除 ${okCount} 项${failCount > 0 ? `，${failCount} 项失败` : ''}`,
          failCount > 0 ? { variant: 'destructive' } : { variant: 'success' },
        );
      }
      closeDialog();
      await loadTree();
      // 当前查看的文件夹若被删（或其子树被删），回退到对应被删文件夹的父级
      const st = useBookmarkStore.getState();
      const viewingId = st.selectedFolderId;
      if (viewingId && !findNode(st.roots, viewingId)) {
        // 找到包含被删文件夹的最深一层（selectedFolderId 所在子树）
        const hit = [...parentOf].reverse().find((p) => {
          const f = findNode(st.roots, p.folderId);
          return f && (f.id === viewingId || findNode(f.children ?? [], viewingId));
        });
        const fallback = hit?.parentId ?? null;
        useBookmarkStore.setState({
          selectedFolderId:
            fallback && findNode(st.roots, fallback) ? fallback : st.roots[0]?.id ?? null,
        });
      }
    } catch (e) {
      pushToast('批量删除失败', { description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  /** 编辑网址（URL 校验 + 更新） */
  const handleEditUrl = async () => {
    if (dialog.kind !== 'edit-url' || !node) return;
    let finalUrl = url.trim();
    if (!finalUrl) {
      pushToast('请输入网址', { variant: 'destructive' });
      return;
    }
    if (!/^https?:\/\//i.test(finalUrl)) finalUrl = `https://${finalUrl}`;
    try {
      new URL(finalUrl);
    } catch {
      pushToast('URL 格式无效', { variant: 'destructive' });
      return;
    }
    if (finalUrl === node.url) {
      closeDialog();
      return;
    }
    setBusy(true);
    try {
      await chrome.bookmarks.update(node.id, { url: finalUrl });
      pushToast('网址已更新', { variant: 'success' });
      closeDialog();
      await loadTree();
    } catch (e) {
      pushToast('更新失败', { description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  /** 删除（书签 remove / 文件夹 removeTree；根文件夹拒绝） */
  const handleDelete = async () => {
    if (dialog.kind !== 'delete' || !node) return;
    // 双保险：根文件夹（书签栏等）不可删除
    if (useBookmarkStore.getState().roots.some((r) => r.id === node.id)) {
      pushToast('根文件夹不可删除', { variant: 'destructive' });
      closeDialog();
      return;
    }
    setBusy(true);
    try {
      if (node.url) await chrome.bookmarks.remove(node.id);
      else await chrome.bookmarks.removeTree(node.id);
      // 清理多选中可能残留的被删节点（含子树）
      const removed = new Set<string>();
      const collect = (n: chrome.bookmarks.BookmarkTreeNode) => {
        removed.add(n.id);
        for (const c of n.children ?? []) collect(c);
      };
      collect(node);
      useBookmarkStore.setState((s) => ({
        selectedBookmarkIds: s.selectedBookmarkIds.filter((id) => !removed.has(id)),
      }));
      pushToast('已删除', { variant: 'success' });
      closeDialog();
      await loadTree();
      // 若当前查看的文件夹正是被删节点（或其子树节点），回退到父文件夹，避免悬空
      const st = useBookmarkStore.getState();
      if (st.selectedFolderId && !findNode(st.roots, st.selectedFolderId)) {
        useBookmarkStore.setState({ selectedFolderId: node.parentId ?? st.roots[0]?.id ?? null });
      }
    } catch (e) {
      pushToast('删除失败', { description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  if (dialog.kind === 'delete') {
    // 文件夹：统计子树节点总数（含自身），让用户清楚删除范围
    let subCount = 1;
    if (node && !node.url) {
      const count = (n: chrome.bookmarks.BookmarkTreeNode): number =>
        1 + (n.children ?? []).reduce((acc, c) => acc + count(c), 0);
      subCount = count(node);
    }
    return (
      <Dialog
        open
        onOpenChange={(o) => !o && !busy && closeDialog()}
        title="确认删除"
        description={`将删除「${node?.title || '(未命名)'}」${node && !node.url ? `及其全部子项（共 ${subCount} 项）` : ''}，此操作不可撤销。`}
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={closeDialog} autoFocus>
              取消
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void handleDelete()}>
              {busy ? '删除中…' : '删除'}
            </Button>
          </>
        }
      />
    );
  }

  if (dialog.kind === 'delete-many') {
    return (
      <Dialog
        open
        onOpenChange={(o) => !o && !busy && closeDialog()}
        title="确认批量删除"
        description={`将删除选中的 ${dialog.bookmarkIds.length} 项（文件夹连同其全部内容），此操作不可撤销。`}
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={closeDialog} autoFocus>
              取消
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void handleDeleteMany()}>
              {busy ? '删除中…' : '删除'}
            </Button>
          </>
        }
      />
    );
  }

  if (dialog.kind === 'move') {
    return <MovePicker bookmarkIds={dialog.bookmarkIds} onClose={closeDialog} />;
  }

  if (dialog.kind === 'edit-url') {
    const canSubmitUrl = url.trim().length > 0;
    return (
      <Dialog
        open
        onOpenChange={(o) => !o && !busy && closeDialog()}
        title="编辑网址"
        description={`「${node?.title || '(未命名)'}」`}
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={closeDialog}>
              取消
            </Button>
            <Button
              disabled={busy || !canSubmitUrl}
              onClick={() => {
                void handleEditUrl();
              }}
            >
              {busy ? '处理中…' : '保存'}
            </Button>
          </>
        }
      >
        <div className="space-y-1.5">
          <Label htmlFor="bookmark-url-edit">地址</Label>
          <Input
            id="bookmark-url-edit"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void handleEditUrl();
            }}
            onFocus={(e) => url && e.target.select()}
            autoFocus
            placeholder="https://…（可省略协议）"
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      </Dialog>
    );
  }

  const isCreateBookmark = dialog.kind === 'create-bookmark';
  const dialogTitle = dialog.kind === 'create-folder' ? '新建文件夹' : isCreateBookmark ? '新建书签' : '重命名';
  // 新建类对话框：显示目标文件夹路径（undefined 目标 = 书签栏根）
  const createTargetPath =
    dialog.kind === 'create-folder' || dialog.kind === 'create-bookmark'
      ? dialog.parentId
        ? resolveTitlePath(roots, dialog.parentId)
        : '书签栏'
      : '';
  const canSubmit = title.trim().length > 0 && (!isCreateBookmark || url.trim().length > 0);

  const submit = () => {
    if (busy || !canSubmit) return;
    if (isCreateBookmark) void handleCreateBookmark();
    else if (dialog.kind === 'create-folder') void handleCreate();
    else void handleRename();
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && closeDialog()}
      title={dialogTitle}
      description={createTargetPath ? `将创建到「${createTargetPath}」` : undefined}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={closeDialog}>
            取消
          </Button>
          <Button disabled={busy || !canSubmit} onClick={submit}>
            {busy ? '处理中…' : '确定'}
          </Button>
        </>
      }
    >
      <div className="space-y-2.5">
        <div className="space-y-1.5">
          <Label htmlFor="bookmark-title">名称</Label>
          <Input
            id="bookmark-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit();
            }}
            onFocus={(e) => title && e.target.select()}
            autoFocus
            placeholder={isCreateBookmark ? '页面标题' : '输入名称…'}
          />
        </div>
        {isCreateBookmark && (
          <div className="space-y-1.5">
            <Label htmlFor="bookmark-url">地址</Label>
            <Input
              id="bookmark-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit();
              }}
              placeholder="https://…（可省略协议）"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        )}
      </div>
    </Dialog>
  );
}

