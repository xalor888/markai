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

/** 中栏主视图：文件夹列表 / 时间线（纯时间排序，只有书签个体） */
export type MainView = 'list' | 'timeline';

interface UIState {
  dialog: BookmarkDialog | null;
  openDialog: (d: BookmarkDialog) => void;
  closeDialog: () => void;
  mainView: MainView;
  setMainView: (view: MainView) => void;
  /**
   * 紧凑工作区（侧边栏）里把书签树收起成图标条。
   * 侧边栏通常只有 400~500px：树占 176px 后中栏只剩两百多，标题都被截断。
   * 收起后中栏拿回全部宽度，用户随时可以再展开（状态持久化）。
   */
  treeCollapsed: boolean;
  setTreeCollapsed: (collapsed: boolean) => void;
  /**
   * 待删清单里用户取消勾选的 id。
   *
   * 为什么放在 store 而不是对话框的 useState：那是「我不想删这几条」的明确意图，
   * 关掉面板再打开时如果被重置成全选，用户下一次点「删除」就会连它们一起删掉。
   * 放在这里跨打开保留；对应提议消失时由对话框清理。
   */
  deletionUnchecked: Set<string>;
  setDeletionUnchecked: (next: Set<string>) => void;
  /**
   * 站内确认框（替代 `window.confirm`）。
   *
   * 为什么不用原生 confirm：它在深色主题下是一块刺眼的白框、不能改文案样式、
   * 也无法在 e2e 里断言（原生 dialog 会打断 CDP 流程）。
   */
  confirmRequest: ConfirmRequest | null;
  /**
   * 排队中的确认请求（先进先出）。
   *
   * 为什么需要队列而不是直接覆盖：`requestConfirm` 原先无条件替换当前请求，
   * 于是「清空记录」弹着确认框时若另一处又发来一个请求，前一个请求的 `onConfirm`
   * 就被静默丢弃——用户点「确定」，执行的是**屏幕上没写的那件事**。
   * 这比「不弹」危险得多，所以后来的请求排队，前一个处理完再露出来。
   */
  confirmQueue: ConfirmRequest[];
  requestConfirm: (req: ConfirmRequest) => void;
  resolveConfirm: () => void;
  cancelConfirm: () => void;
}

export interface ConfirmRequest {
  title: string;
  body?: string;
  confirmText?: string;
  danger?: boolean;
  onConfirm: () => void;
}

export const useUIStore = create<UIState>((set, get) => ({
  dialog: null,
  openDialog: (d) => set({ dialog: d }),
  closeDialog: () => set({ dialog: null }),
  mainView: 'list',
  setMainView: (view) => set({ mainView: view }),
  confirmRequest: null,
  confirmQueue: [],
  requestConfirm: (req) => {
    if (get().confirmRequest) set({ confirmQueue: [...get().confirmQueue, req] });
    else set({ confirmRequest: req });
  },
  resolveConfirm: () => {
    const head = get().confirmRequest;
    // 先让出位置再执行回调：回调里若又发起新的确认（例如二次确认），它会正常排队
    const [next, ...rest] = get().confirmQueue;
    set({ confirmRequest: next ?? null, confirmQueue: rest });
    head?.onConfirm();
  },
  cancelConfirm: () => {
    const [next, ...rest] = get().confirmQueue;
    set({ confirmRequest: next ?? null, confirmQueue: rest });
  },
  deletionUnchecked: new Set<string>(),
  setDeletionUnchecked: (next) => set({ deletionUnchecked: next }),
  treeCollapsed: false,
  setTreeCollapsed: (collapsed) => {
    set({ treeCollapsed: collapsed });
    // 持久化：下次打开侧边栏保持用户的布局选择（失败不影响本次收起）
    void chrome.storage.local.set({ 'markai.ui.treeCollapsed': collapsed }).catch(() => {});
  },
}));
