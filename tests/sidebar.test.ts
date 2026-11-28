/**
 * ── 侧边栏（书签树）优化 的测试 ──
 *
 * 这一层最容易出的问题不是"不好看"，而是**排序把结构弄错**：
 *  · 排序把书签排到文件夹前面 → 用户找不到文件夹；
 *  · 排序改了节点对象 → memo 全部失效，大库每帧重渲染；
 *  · 根识别按数组下标猜 → 平台不同就标错根（书签栏被当成移动设备）；
 *  · storage 里半截对象 → 整棵树打不开。
 *
 * 运行：npx tsx tests/sidebar.test.ts
 */
import assert from 'node:assert/strict';
import {
  SIDEBAR_DEFAULT_PREFS,
  countBookmarks,
  latestAdded,
  normalizeSidebarPrefs,
  sortNodes,
  sortTree,
} from '../src/lib/sidebar/prefs';
import { ROOT_LABELS, rootKindOf } from '../src/lib/sidebar/roots';

type BNode = chrome.bookmarks.BookmarkTreeNode;

let passed = 0;
function ok(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✔ ${name}`);
  } catch (e) {
    console.error(`  ✘ ${name}`);
    throw e;
  }
}

const bm = (id: string, title: string, dateAdded = 0): BNode => ({
  id,
  title,
  url: `https://x/${id}`,
  dateAdded,
  syncing: false,
});
const folder = (id: string, title: string, children: BNode[] = []): BNode => ({ id, title, children, syncing: false });

console.log('\n[S1] 偏好归一化');

ok('空/非法输入回落默认', () => {
  assert.deepEqual(normalizeSidebarPrefs(undefined), SIDEBAR_DEFAULT_PREFS);
  assert.deepEqual(normalizeSidebarPrefs('nope'), SIDEBAR_DEFAULT_PREFS);
  assert.deepEqual(normalizeSidebarPrefs({ sort: 'bogus', density: 'huge' }), SIDEBAR_DEFAULT_PREFS);
});

ok('合法字段被保留，缺字段补默认', () => {
  const p = normalizeSidebarPrefs({ sort: 'count', density: 'compact' });
  assert.equal(p.sort, 'count');
  assert.equal(p.density, 'compact');
  assert.equal(p.showCounts, SIDEBAR_DEFAULT_PREFS.showCounts);
});

console.log('\n[S2] 计数与最近时间');

ok('countBookmarks 只数书签，递归进子文件夹', () => {
  const tree = [bm('a', 'A'), folder('f', 'F', [bm('b', 'B'), folder('g', 'G', [bm('c', 'C')])])];
  assert.equal(countBookmarks(tree), 3);
  assert.equal(countBookmarks(undefined), 0);
});

ok('latestAdded 取子树最大 dateAdded，缺失为 0', () => {
  const tree = [bm('a', 'A', 100), folder('f', 'F', [bm('b', 'B', 900)])];
  assert.equal(latestAdded(tree), 900);
  assert.equal(latestAdded([bm('x', 'X', 0)]), 0);
});

console.log('\n[S3] 排序规则');

ok('manual 原样返回（同一引用）', () => {
  const tree = [bm('a', 'A'), folder('f', 'F')];
  assert.equal(sortNodes(tree, 'manual'), tree);
});

ok('name 排序：文件夹在前，再按名称', () => {
  const tree = [bm('z', 'Zebra'), folder('m', 'Mid'), bm('a', 'Apple'), folder('b', 'Beta')];
  const out = sortNodes(tree, 'name');
  assert.deepEqual(
    out.map((n) => n.id),
    ['b', 'm', 'a', 'z'],
  );
});

ok('count 排序：按子树书签数降序，文件夹仍在前', () => {
  const tree = [
    folder('small', 'Small', [bm('1', '1')]),
    bm('single', 'Single'),
    folder('big', 'Big', [bm('2', '2'), bm('3', '3'), bm('4', '4')]),
  ];
  const out = sortNodes(tree, 'count');
  assert.deepEqual(
    out.map((n) => n.id),
    ['big', 'small', 'single'],
  );
});

ok('recent 排序：按日期降序', () => {
  const tree = [bm('old', 'Old', 100), bm('new', 'New', 900), bm('mid', 'Mid', 500)];
  assert.deepEqual(
    sortNodes(tree, 'recent').map((n) => n.id),
    ['new', 'mid', 'old'],
  );
});

ok('排序稳定：同键按标题兜底，两次结果一致', () => {
  const tree = [bm('x', 'Same', 5), bm('y', 'Same', 5), bm('z', 'Same', 5)];
  const a = sortNodes(tree, 'recent').map((n) => n.id);
  const b = sortNodes([...tree].reverse(), 'recent').map((n) => n.id);
  assert.deepEqual(a, b);
});

console.log('\n[S4] 整树排序不改原对象');

ok('sortTree 递归排序子层，且不修改输入', () => {
  const original = [folder('f', 'F', [bm('z', 'Z', 1), bm('a', 'A', 2)])];
  const snapshot = JSON.stringify(original);
  const out = sortTree(original, 'name');
  assert.equal(JSON.stringify(original), snapshot, '原树必须保持不变');
  assert.deepEqual(
    out[0]!.children!.map((n) => n.id),
    ['a', 'z'],
  );
  assert.notEqual(out, original);
});

ok('manual 下 sortTree 复用原引用（不触发整树重渲染）', () => {
  const original = [folder('f', 'F', [bm('z', 'Z')])];
  assert.equal(sortTree(original, 'manual'), original);
});

console.log('\n[S5] 根识别不按下标猜');

ok('按 id 识别三个根', () => {
  assert.equal(rootKindOf(folder('1', '随便叫什么')), 'bookmarks-bar');
  assert.equal(rootKindOf(folder('2', '随便叫什么')), 'other');
  assert.equal(rootKindOf(folder('3', '随便叫什么')), 'mobile');
});

ok('id 不认识时按中英文标题兜底', () => {
  assert.equal(rootKindOf(folder('900', '书签栏')), 'bookmarks-bar');
  assert.equal(rootKindOf(folder('901', 'Other Bookmarks')), 'other');
  assert.equal(rootKindOf(folder('902', 'Mobile Bookmarks')), 'mobile');
  assert.equal(rootKindOf(folder('903', '移动设备书签')), 'mobile');
});

ok('书签与未知文件夹不会被误标成根', () => {
  assert.equal(rootKindOf(bm('10', '书签栏')), 'unknown');
  assert.equal(rootKindOf(folder('11', '我的收藏')), 'unknown');
});

ok('每种根都有中文标签（不出现 undefined）', () => {
  for (const kind of ['bookmarks-bar', 'other', 'mobile', 'unknown'] as const) {
    assert.equal(typeof ROOT_LABELS[kind], 'string');
    assert.ok(ROOT_LABELS[kind].length > 0);
  }
});

console.log(`\n✓ sidebar：${passed} 项全部通过`);
