/** ── Toast 系统（右上角原生风格通知） ── */

import { create } from 'zustand';
import { uid } from './format';

export type ToastVariant = 'default' | 'destructive' | 'success';

export interface ToastItem {
  id: string;
  title: string;
  description?: string;
  variant: ToastVariant;
  createdAt: number;
}

interface ToastState {
  toasts: ToastItem[];
  push: (t: Omit<ToastItem, 'id' | 'createdAt'>) => string;
  remove: (id: string) => void;
}

const TOAST_TTL = 3800;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (t) => {
    // 内容去重：相同标题+描述+颜色的 toast 直接忽略（TTL 从首次开始），避免连续错误堆叠
    // 注：不复用 id 置顶——复用会被已注册的旧 timer 提前移除
    const dup = get().toasts.find(
      (x) => x.title === t.title && x.description === t.description && x.variant === t.variant,
    );
    if (dup) return dup.id;
    const id = uid();
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id, createdAt: Date.now() }] }));
    setTimeout(() => get().remove(id), TOAST_TTL);
    return id;
  },
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

/** 便捷推送 */
export function pushToast(
  title: string,
  opts: { description?: string; variant?: ToastVariant } = {},
): string {
  return useToastStore.getState().push({ title, description: opts.description, variant: opts.variant ?? 'default' });
}
