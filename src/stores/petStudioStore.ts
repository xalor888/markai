/**
 * 宠物工作室的开关状态。
 *
 * 为什么单独一个 store：入口在顶栏（`topbar-extras`），面板挂在同一棵树里，
 * 但两者隔了好几层组件。用 props 传会让每个中间层都多一个"我用不到"的参数；
 * 用 CustomEvent 又会在面板还没挂载时丢掉打开请求。一个两字段的 store 最省事。
 */
import { create } from 'zustand';

interface PetStudioStore {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const usePetStudioStore = create<PetStudioStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export function openPetStudio(): void {
  usePetStudioStore.getState().setOpen(true);
}
