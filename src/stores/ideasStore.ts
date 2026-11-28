/**
 * 点子面板的开关状态。
 *
 * 单独一个 store 而不是塞进 uiStore：点子面板有两个触发点（顶栏入口、Agent 的
 * 主动建议），塞进 uiStore 会让所有订阅 uiStore 的组件跟着重渲染。
 */
import { create } from 'zustand';

interface IdeasState {
  open: boolean;
  setOpen: (open: boolean) => void;
  openPanel: () => void;
}

export const useIdeasStore = create<IdeasState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  openPanel: () => set({ open: true }),
}));
