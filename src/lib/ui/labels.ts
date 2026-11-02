/**
 * 界面动作文案的**唯一来源**。
 *
 * 为什么要有这个文件：同一个动作在多个入口出现（侧边栏右键、中栏工具栏、
 * 空状态提示、快捷键说明、扩展图标右键）。以前每处各写一遍字符串，
 * 于是出现了「整理**选中项**」和「整理**所选**（N）」并存——
 * 用户在两处看到同一个动作的两个名字，会以为是两个功能。
 *
 * 规则：**同一动作同一名字**。要改文案，改这里一处。
 */

/** 「让 MarkAI 整理」这一族动作的名字 */
export const ORGANIZE_LABEL = {
  /** 整理当前文件夹（侧边栏右键用，语境里已经知道是文件夹，不必重复） */
  folder: '让 MarkAI 整理',
  /** 整理选中项：带数量，让用户知道会动多少 */
  selection: (n: number) => `让 MarkAI 整理所选（${n}）`,
  /** 整理全部书签（扩展图标右键） */
  all: '让 MarkAI 整理全部书签',
  /** 分析而非整理（不移动，只给结论） */
  analyze: '让 MarkAI 分析',
} as const;

/**
 * 各处入口的说明文案里引用动作名时，用这个拼，避免写死后与按钮不一致。
 */
export function organizeHint(scope: 'folder' | 'selection' | 'all'): string {
  switch (scope) {
    case 'folder':
      return `右键文件夹可在树中新建子文件夹，或${ORGANIZE_LABEL.folder}。`;
    case 'selection':
      return `选中若干书签后可${ORGANIZE_LABEL.selection(0).replace('（0）', '')}。`;
    case 'all':
      return `在扩展图标上右键可以${ORGANIZE_LABEL.all}。`;
  }
}
