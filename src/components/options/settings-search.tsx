/**
 * ── 设置页搜索：查询 → 可见性 ──
 *
 * 设置页有 8 个分区、30 多个字段。现代设置页的默认动作是"⌘K → 输两个字 → 只剩
 * 你要改的那项"，而不是让用户在一屏一屏的卡片里找。搜索在这里不是装饰：
 * 每个字段的 `keywords` 里同时写了中文叫法与英文/术语别名（`reasoning effort`、
 * `base url`、`api key`），所以两种语言都能命中。
 *
 * 可见性的两个层级：
 *  - 分区标题/说明命中 → 整个分区都留着（搜"AI 服务"不该只剩一行输入框）；
 *  - 否则只留命中的字段行；一行都不剩的分区整体隐藏。
 *
 * 为什么分区要靠 DOM 探测子行（`data-setting-row`）而不是再维护一份索引：
 * 设置项是 JSX 里手写的异构控件（下拉、滑块、记忆列表、体检面板），
 * 另建一份"设置项清单"必然和真实界面漂移。这里用一次 `useLayoutEffect`
 * 读取**本次渲染**里还剩几行，既不需要重复数据，也不会在下一帧才闪一下
 * （layout effect 在浏览器绘制前完成）。
 */

import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';

export interface SettingsSearchApi {
  /** 已归一化的查询串（小写、去首尾空白） */
  query: string;
  /** 查询切词：所有词都命中才算命中（"api key" 与 "key api" 等价） */
  tokens: string[];
  /** 多字段命中判断；查询为空时恒为 true */
  match: (...parts: Array<string | undefined | null>) => boolean;
  /** 分区可见性上报（供侧栏计数与"无结果"空状态使用） */
  reportSection: (id: string, visible: boolean) => void;
  visibleSections: Record<string, boolean>;
}

const EMPTY: SettingsSearchApi = {
  query: '',
  tokens: [],
  match: () => true,
  reportSection: () => {},
  visibleSections: {},
};

const SearchContext = createContext<SettingsSearchApi>(EMPTY);
/** 分区标题/说明已命中：分区内所有行都必须显示（由 SettingsSection 提供） */
export const SectionMatchContext = createContext(true);

/** 挂在设置页外壳上：持有查询串，向下提供命中判断；可见性由外壳统一定义 */
export function SettingsSearchProvider({
  query,
  visibleSections,
  reportSection,
  children,
}: {
  query: string;
  visibleSections: Record<string, boolean>;
  reportSection: (id: string, visible: boolean) => void;
  children: ReactNode;
}) {
  const normalized = query.trim().toLowerCase();
  const tokens = useMemo(() => normalized.split(/\s+/).filter(Boolean), [normalized]);

  const match = useCallback(
    (...parts: Array<string | undefined | null>) => {
      if (tokens.length === 0) return true;
      const hay = parts.filter(Boolean).join(' ').toLowerCase();
      return tokens.every((t) => hay.includes(t));
    },
    [tokens],
  );

  const api = useMemo(
    () => ({ query: normalized, tokens, match, reportSection, visibleSections }),
    [normalized, tokens, match, reportSection, visibleSections],
  );

  return <SearchContext.Provider value={api}>{children}</SearchContext.Provider>;
}

export function useSettingsSearch(): SettingsSearchApi {
  return useContext(SearchContext);
}

/** 分区标题已命中：分区内所有行都显示（不再逐行过滤） */
export function useSectionMatched(): boolean {
  return useContext(SectionMatchContext);
}
