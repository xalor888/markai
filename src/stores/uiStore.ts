/** ── 全局 UI 对话框状态（书签右键菜单触发的重命名/新建/删除） ── */

import { create } from 'zustand';

export type BookmarkDialog =
  | { kind: 'create-folder'; parentId: string }
  | { kind: 'create-bookmark'; parentId: string }
  | { kind: 'rename'; bookmarkId: string }
  | { kind: 'edit-url'; bookmarkId: string }
  | { kind: 'delete'; bookmarkId: string }
  | { kind: 'delete-many'; bookmarkIds: string[] }
  | { kind: 'move'; bookmarkIds: string[] };

interface UIState {
  dialog: BookmarkDialog | null;
  openDialog: (d: BookmarkDialog) => void;
  closeDialog: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  dialog: null,
  openDialog: (d) => set({ dialog: d }),
  closeDialog: () => set({ dialog: null }),
}));
