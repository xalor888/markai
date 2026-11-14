/**
 * ── 命令面板的分组（纯函数） ──
 *
 * 空查询与有查询是两种完全不同的界面：
 *  - 空查询：**最近使用 → 常用动作 → 文件夹**，像一张"开箱即用"的桌面；
 *  - 有查询：走 `searchCommands` 的打分，再按 动作/文件夹/书签 分组。
 *
 * 抽出来的理由：排序与"最近项去重"是产品契约（同一个文件夹不该既在最近里、
 * 又在文件夹组里出现两次），埋在 JSX 里只能靠肉眼复查。
 */

import { groupCommands, searchCommands, type CommandItem, type CommandKind } from './search';
import type { RecentEntry } from './recent';

export type PaletteGroupKind = 'recent' | CommandKind;

export interface PaletteGroup {
  kind: PaletteGroupKind;
  label: string;
  items: CommandItem[];
}

const EMPTY_LABELS: Record<'recent' | 'action' | 'folder', string> = {
  recent: '最近使用',
  action: '常用动作',
  folder: '文件夹',
};

/**
 * 组装面板分组。
 *
 * @param recent 最近使用记录（只接受仍存在于当前数据里的条目——删掉的书签不再出现）
 */
export function buildPaletteGroups(
  all: CommandItem[],
  query: string,
  recent: readonly RecentEntry[] = [],
  limit = 40,
): PaletteGroup[] {
  const q = query.trim();
  if (q) {
    return groupCommands(searchCommands(all, q, limit)).map((g) => ({
      kind: g.kind,
      label: g.label,
      items: g.items,
    }));
  }

  const byId = new Map(all.map((item) => [item.id, item] as const));
  const recentItems = recent
    .map((entry) => byId.get(entry.id))
    .filter((item): item is CommandItem => !!item && (item.kind === 'bookmark' || item.kind === 'folder'));
  const recentIds = new Set(recentItems.map((item) => item.id));

  // 首屏只放 6 个动作：再多的动作会把"文件夹"挤出可视区。
  // 其余动作仍可通过输入检索（有查询时走 searchCommands，不受这个截断影响）。
  const actions = all.filter((item) => item.kind === 'action').slice(0, 6);
  const folders = all
    .filter((item) => item.kind === 'folder' && !recentIds.has(item.id))
    .slice(0, 6);

  const groups: PaletteGroup[] = [
    { kind: 'recent', label: EMPTY_LABELS.recent, items: recentItems },
    { kind: 'action', label: EMPTY_LABELS.action, items: actions },
    { kind: 'folder', label: EMPTY_LABELS.folder, items: folders },
  ];
  return groups.filter((g) => g.items.length > 0);
}
