/**
 * 快捷键说明 vs 真实处理器 的契约守卫。
 *
 * 为什么需要：快捷键速查表的注释写着「只列代码里真实绑定过的键，不写"应该支持"的键，
 * 避免帮助本身在撒谎」——但**没有任何东西守着这句话**。
 *
 * 而这类缺口是真实发生过的：空态提示从 0.2.x 起就写着「或按 Ctrl+D 把当前页面收藏进来」，
 * 全库却找不到任何 `key === 'd'` 的分支，用户照着提示按下去什么都没发生（0.2.98 才补上）。
 *
 * 所以这里把「说明里列了什么」和「处理器里接了什么」对起来：
 * 说明里有的键，必须能在处理器源码里找到对应的 case / key 判断。
 *
 * 判据取自**源码**而不是运行时：这些处理器就是源码里的 switch/case，
 * 运行时要真按一遍成本高得多（e2e 已覆盖主要几项）。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 说明里的一个条目 */
export interface DeclaredShortcut {
  keys: string[];
  desc: string;
}

/** 源码里实际接了的键（大小写不敏感比较） */
export interface HandledKeys {
  /** `case 'x':` 形式 */
  cases: Set<string>;
  /** `e.key === 'x'` / `e.key !== 'x'` 形式 */
  comparisons: Set<string>;
}

/**
 * 从处理器源码里抽出真正接住的键。
 *
 * 只认两种形态，且**跳过注释行**——注释里出现的键不算接住
 * （例如 `// Ctrl+C：复制选中项网址` 这种说明文字）。
 */
export function extractHandledKeys(source: string): HandledKeys {
  const cases = new Set<string>();
  const comparisons = new Set<string>();
  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
    const caseM = /^case\s+'([^']+)'\s*:/.exec(line);
    if (caseM) cases.add(caseM[1]!.toLowerCase());
    // 两种形态：`e.key === 'k'` 和 `e.key.toLowerCase() === 'k'`（后者在 workspace 的 ⌘K 上）
    const cmpM = /\.key(?:\.toLowerCase\(\))?\s*(===|!==)\s*'([^']+)'/.exec(line);
    if (cmpM) comparisons.add(cmpM[2]!.toLowerCase());
  }
  return { cases, comparisons };
}

/**
 * 说明条目里，哪些键是**本组件自己**该接的。
 *
 * 有些条目不对应键盘事件，不能拿去找 case：
 *   - 'Ctrl'+'单击' 是鼠标组合
 *   - '右键' 是 contextmenu
 *   - 'Ctrl'+'Shift'+'M' 走 Chrome commands API（manifest 层，不在组件里）
 *   - 'Shift'+'↑↓' 是 Shift + 上下（拆成 ↑↓ 两项已在别处覆盖）
 *   - 'Esc' 由 Dialog 组件统一处理
 */
const NON_KEYBOARD = new Set([
  'ctrl+单击',
  '右键',
  'ctrl+shift+m',
  'shift+↑↓',
  'esc',
]);

function entryKey(keys: string[]): string {
  return keys.join('+').toLowerCase();
}

/** 把说明里的键名换成源码里的 key 值（'↑' → 'arrowup' 等） */
const ALIAS: Record<string, string> = {
  '↑': 'arrowup',
  '↓': 'arrowdown',
  '←': 'arrowleft',
  '→': 'arrowright',
  '空格': ' ',
  // 说明里写 PgUp/PgDn，而 KeyboardEvent.key 的标准值是 PageUp/PageDown
  pgup: 'pageup',
  pgdn: 'pagedown',
};

function sourceKey(key: string): string {
  const lower = key.toLowerCase();
  return ALIAS[lower] ?? ALIAS[key] ?? lower;
}

export interface ShortcutGap {
  keys: string[];
  desc: string;
}

/**
 * 找出「说明里列了、但处理器里找不到」的条目。
 *
 * `handlers` 是若干处理器源码；只要**任意一个**接了这个键就算数
 * （比如 '/' 在树和列表里都接）。
 */
export function findShortcutGaps(
  declared: DeclaredShortcut[],
  handlers: HandledKeys[],
): ShortcutGap[] {
  const gaps: ShortcutGap[] = [];
  for (const item of declared) {
    const key = entryKey(item.keys);
    if (NON_KEYBOARD.has(key)) continue;
    // 只取最后一个非修饰键作为要查的键（'Ctrl'+'A' → 'a'，'Home' → 'home'）
    const last = item.keys[item.keys.length - 1]!;
    const want = sourceKey(last);
    const handled = handlers.some((h) => h.cases.has(want) || h.comparisons.has(want));
    if (!handled) gaps.push({ keys: item.keys, desc: item.desc });
  }
  return gaps;
}

/** 读源码并抽键（测试用） */
export function handledKeysFromFile(root: string, rel: string): HandledKeys {
  return extractHandledKeys(readFileSync(join(root, rel), 'utf8'));
}
