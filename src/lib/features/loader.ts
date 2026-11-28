/**
 * 功能装配入口。
 *
 * 每个入口（侧边栏 / 完整页 / 设置 / popup）挂载时调用一次：
 *  · 各功能模块自己决定"注册成功 / 缺席"，这里只负责调用与记录状态；
 *  · 任何一个模块抛错都不能影响入口启动——用 try/catch 隔离，
 *    失败只降级该功能，并把原因留到 `useFeatureStore` 里给设置页显示。
 */
import { create } from 'zustand';
import { FEATURE_KEYS, featureState, type FeatureKey, type FeatureState } from './flags';
import { installIdeas } from '@/lib/ideas/register';
import { installSemanticSearch } from '@/lib/search/semantic/register';
import { installExternalApi } from '@/lib/external/register';

interface FeatureStore {
  states: Record<FeatureKey, FeatureState>;
  setState: (key: FeatureKey, state: FeatureState) => void;
}

const initial = Object.fromEntries(
  FEATURE_KEYS.map((k) => [k, featureState(k, false)]),
) as Record<FeatureKey, FeatureState>;

export const useFeatureStore = create<FeatureStore>((set) => ({
  states: initial,
  setState: (key, state) => set((s) => ({ states: { ...s.states, [key]: state } })),
}));

let installed = false;

function attempt(key: FeatureKey, install: () => void): boolean {
  try {
    install();
    useFeatureStore.getState().setState(key, featureState(key, true));
    return true;
  } catch (e) {
    useFeatureStore.getState().setState(key, {
      ready: false,
      note: `加载失败：${e instanceof Error ? e.message : String(e)}`,
    });
    return false;
  }
}

/** 幂等：同一文档内多次调用只装配一次 */
export function installFeatures(): void {
  if (installed) return;
  installed = true;
  attempt('semanticSearch', installSemanticSearch);
  attempt('ideas', installIdeas);
  attempt('externalApi', installExternalApi);
}
