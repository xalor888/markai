/**
 * 顶栏搜索的语义补充结果（跨组件共享）。
 *
 * 顶栏负责在输入停顿 250ms 后查一次混合检索；列表订阅同一份结果追加显示。
 * 如果两边各查一次，开启远端向量时每个停顿会发两次 /embeddings 请求——
 * 同一个问题问两遍，既慢又费额度。
 */

import { create } from 'zustand';
import type { SemanticHit } from '@/lib/features/semantic';

export interface SemanticOverlayState {
  /** 这批结果对应的查询词；与当前输入不一致时列表直接忽略（避免旧结果盖新输入） */
  query: string;
  extras: SemanticHit[];
}

interface SemanticOverlayStore {
  overlay: SemanticOverlayState;
  setOverlay: (overlay: SemanticOverlayState) => void;
  clear: () => void;
}

const EMPTY: SemanticOverlayState = { query: '', extras: [] };

export const useSemanticOverlay = create<SemanticOverlayStore>((set) => ({
  overlay: EMPTY,
  setOverlay: (overlay) => set({ overlay }),
  clear: () => set({ overlay: EMPTY }),
}));
