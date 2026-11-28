/**
 * 根文件夹识别。
 *
 * Chrome 的三个根 id 固定，但 `roots` 数组的顺序/数量在不同平台并不保证
 * （例如没有同步时可能只有两个）。所以不按下标猜，按 id 与标题双保险识别，
 * 识别不出来时退回通用「文件夹」样式——宁可少一个图标，不要标错根。
 *
 * 命名口径（见 RALPH.md）：根级直接散落的书签叫「根级书签」，
 * 不叫「游离」——后者暗示"不属于任何地方"，而它们确实属于某个根。
 */
type BNode = chrome.bookmarks.BookmarkTreeNode;

export type RootKind = 'bookmarks-bar' | 'other' | 'mobile' | 'unknown';

const ROOT_IDS: Record<string, RootKind> = {
  '1': 'bookmarks-bar',
  '2': 'other',
  '3': 'mobile',
};

/** 中文 / 英文界面下 Chrome 给的根标题 */
const ROOT_TITLES: { kind: RootKind; pattern: RegExp }[] = [
  { kind: 'bookmarks-bar', pattern: /^(书签栏|bookmarks?\s*bar)$/i },
  { kind: 'other', pattern: /^(其他书签|other\s*bookmarks?)$/i },
  { kind: 'mobile', pattern: /^(移动设备书签|mobile\s*bookmarks?|mobile)$/i },
];

export function rootKindOf(node: BNode): RootKind {
  if (node.url) return 'unknown';
  const byId = ROOT_IDS[node.id];
  if (byId) return byId;
  const title = (node.title || '').trim();
  for (const { kind, pattern } of ROOT_TITLES) {
    if (pattern.test(title)) return kind;
  }
  return 'unknown';
}

export const ROOT_LABELS: Record<RootKind, string> = {
  'bookmarks-bar': '书签栏',
  other: '其他书签',
  mobile: '移动设备',
  unknown: '书签',
};
