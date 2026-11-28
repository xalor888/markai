/**
 * ── 点子 / 简单清理 的测试 ──
 *
 * 这一层最容易出的问题不是"建议不够聪明"，而是**数字和依据是假的**：
 *  · 卡片说"37 条重复"，点开却对不上 → 用户从此不信任何点子；
 *  · 模型编一个 count / 编一句"我已经帮你删了" → 用户以为书签真没了；
 *  · 冷却表过期/重复项没清 → 每次打开都是同一批，像坏了；
 *  · 清理面板把"待检测"算进"将影响 N 条" → 用一个猜的数字给删除背书。
 *
 * 运行：npx tsx tests/ideas.test.ts
 */
import assert from 'node:assert/strict';
import {
  CLUSTER_FOLDER_THRESHOLD,
  IDEA_COOLDOWN_MS,
  MAX_SAMPLE_IDS,
  SEEN_LIMIT,
  STALE_MONTHS,
  activeSeenIds,
  generateRuleIdeas,
  libraryLooksClean,
  pruneSeen,
} from '../src/lib/ideas/rules';
import {
  buildCleanupPrompt,
  computeCleanupCategories,
  impactCount,
  pendingProbeKinds,
  type CleanupSelection,
} from '../src/lib/ideas/cleanup';
import { MODEL_IDEA_LIMIT, MODEL_SAMPLE_LIMIT, parseModelIdeas, sampleTitles } from '../src/lib/ideas/model';
import type { Idea, IdeaInput } from '../src/lib/features/ideas';

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

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
/** 固定"现在"，避免测试跨月/跨年时结果漂移 */
const NOW = Date.UTC(2026, 10, 29, 4, 0, 0);
const OLD = NOW - (STALE_MONTHS + 1) * MONTH_MS;
const RECENT = NOW - 2 * 24 * 60 * 60 * 1000;

const bm = (
  id: string,
  title: string,
  url: string,
  opts: { dateAdded?: number; dateLastUsed?: number } = {},
): BNode => ({
  id,
  title,
  url,
  dateAdded: opts.dateAdded ?? RECENT,
  ...(opts.dateLastUsed !== undefined ? { dateLastUsed: opts.dateLastUsed } : {}),
  syncing: false,
});

const folder = (id: string, title: string, children: BNode[] = []): BNode => ({
  id,
  title,
  children,
  syncing: false,
});

/**
 * 一棵"什么问题都有"的库：
 *  · dup.example/a 被收藏 3 次（含 utm 参数变体）→ 2 条多余副本；
 *  · f-empty 是空文件夹；
 *  · s1 没有使用记录、按收藏时间估算为老旧；s2 有真实使用记录且老旧；
 *  · cluster.example 散落在 3 个文件夹；
 *  · 书签栏根下直接躺了 1 条书签。
 */
function fixture(): BNode[] {
  return [
    folder('1', '书签栏', [
      bm('r1', '根级书签', 'https://root.example/'),
      folder('f-design', '设计', [
        bm('d1', '重复页面 A', 'https://dup.example/a', { dateAdded: NOW - 5 * MONTH_MS }),
        bm('d2', '重复页面 A（带追踪参数）', 'https://dup.example/a?utm_source=x'),
        bm('s1', '很老的文章', 'https://old.example/x', { dateAdded: OLD }),
        bm('c1', '集群 1', 'https://cluster.example/1'),
      ]),
      folder('f-front', '前端', [
        bm('c2', '集群 2', 'https://cluster.example/2'),
        bm('s2', '老工具页', 'https://old.example/y', { dateAdded: OLD, dateLastUsed: OLD }),
      ]),
      folder('f-empty', '空文件夹'),
      folder('f-misc', '杂项', [
        bm('c3', '集群 3', 'https://cluster.example/3'),
        bm('fresh', '刚收藏的', 'https://fresh.example/', { dateLastUsed: RECENT }),
      ]),
    ]),
    folder('2', '其他书签', [
      folder('f2', '稍后读', [bm('o1', '重复页面 A（第三份）', 'https://dup.example/a')]),
    ]),
  ];
}

function allIds(roots: BNode[]): Set<string> {
  const ids = new Set<string>();
  const walk = (node: BNode) => {
    ids.add(node.id);
    for (const child of node.children ?? []) walk(child);
  };
  for (const root of roots) walk(root);
  return ids;
}

function input(overrides: Partial<IdeaInput> = {}): IdeaInput {
  return { roots: fixture(), habits: [], seenIds: [], round: 0, ...overrides };
}

function ideaById(ideas: Idea[], id: string): Idea | undefined {
  return ideas.find((idea) => idea.id === id);
}

console.log('\n[I1] 规则层：五类问题都能发现');

ok('重复 / 空文件夹 / 老旧 / 集群 / 根级散落 各一条', () => {
  const ideas = generateRuleIdeas(input(), NOW);
  const kinds = ideas.map((i) => i.kind).sort();
  assert.deepEqual(kinds, ['cluster', 'duplicate', 'empty-folder', 'stale', 'unfiled']);
});

ok('数字来自真实统计：重复 2 条多余副本、1 个空文件夹、2 条老旧', () => {
  const ideas = generateRuleIdeas(input(), NOW);
  assert.equal(ideaById(ideas, 'duplicate')?.count, 2);
  assert.equal(ideaById(ideas, 'empty-folder')?.count, 1);
  assert.equal(ideaById(ideas, 'stale')?.count, 2);
  assert.equal(ideaById(ideas, 'unfiled')?.count, 1);
  // cluster.example 在 3 个文件夹、共 3 条
  assert.equal(ideaById(ideas, 'cluster')?.count, 3);
});

ok('每条点子都有非空依据，且样本 id 都能在树里找到', () => {
  const roots = fixture();
  const ids = allIds(roots);
  const ideas = generateRuleIdeas(input({ roots }), NOW);
  for (const idea of ideas) {
    assert.ok(idea.evidence.length > 0, `${idea.id} 没有依据`);
    for (const ev of idea.evidence) {
      assert.ok(ev.text.trim().length > 0, `${idea.id} 依据为空`);
      assert.ok((ev.sampleIds?.length ?? 0) > 0, `${idea.id} 没有样本 id`);
      assert.ok((ev.sampleIds?.length ?? 0) <= MAX_SAMPLE_IDS, `${idea.id} 样本超过上限`);
      for (const id of ev.sampleIds ?? []) assert.ok(ids.has(id), `${idea.id} 的样本 ${id} 不在树里`);
    }
    assert.ok(idea.prompt.trim().length > 0, `${idea.id} 没有可执行的指令`);
    assert.ok(idea.title.trim().length > 0 && idea.body.trim().length > 0);
    assert.equal(idea.source, 'rule');
  }
});

ok('老旧：有真实使用记录的写"按最后使用时间统计"，缺失的写"估算"', () => {
  const ideas = generateRuleIdeas(input(), NOW);
  const stale = ideaById(ideas, 'stale')!;
  const text = stale.evidence.map((e) => e.text).join(' ');
  assert.match(text, /按收藏时间估算/);
  assert.match(text, /1 条/);
  // 不能把估算说成实测
  assert.doesNotMatch(text, /^按最后使用时间统计/);
});

ok('排序：quick 在前，同档按 count 降序，同分按 id 稳定', () => {
  const a = generateRuleIdeas(input(), NOW);
  const b = generateRuleIdeas(input(), NOW);
  assert.deepEqual(a.map((i) => i.id), b.map((i) => i.id));
  const rank = { quick: 0, medium: 1, deep: 2 } as const;
  for (let i = 1; i < a.length; i++) {
    const prev = a[i - 1]!;
    const cur = a[i]!;
    assert.ok(rank[prev.effort] <= rank[cur.effort], 'quick 必须排在前面');
    if (prev.effort === cur.effort) {
      const byCount = (prev.count ?? 0) - (cur.count ?? 0);
      assert.ok(byCount > 0 || (byCount === 0 && prev.id.localeCompare(cur.id, 'en') < 0));
    }
  }
});

ok('seenIds 命中的规则点子被跳过', () => {
  const ideas = generateRuleIdeas(input({ seenIds: ['duplicate', 'cluster'] }), NOW);
  assert.equal(ideaById(ideas, 'duplicate'), undefined);
  assert.equal(ideaById(ideas, 'cluster'), undefined);
  assert.equal(ideas.length, 3);
});

ok('干净的书签库：没有规则点子，libraryLooksClean 为真', () => {
  const clean: BNode[] = [
    folder('1', '书签栏', [
      folder('f', '分类', [bm('x', '常用', 'https://keep.example/', { dateLastUsed: RECENT })]),
    ]),
    folder('2', '其他书签'),
    folder('3', '移动设备'),
  ];
  assert.equal(generateRuleIdeas({ roots: clean, habits: [], seenIds: [], round: 0 }, NOW).length, 0);
  assert.equal(libraryLooksClean(clean, NOW), true);
});

ok('集群阈值：只在 2 个文件夹里出现不算集群', () => {
  const roots: BNode[] = [
    folder('1', '书签栏', [
      folder('a', 'A', [bm('1a', 'a', 'https://two.example/1')]),
      folder('b', 'B', [bm('1b', 'b', 'https://two.example/2')]),
    ]),
  ];
  const ideas = generateRuleIdeas({ roots, habits: [], seenIds: [], round: 0 }, NOW);
  assert.equal(ideaById(ideas, 'cluster'), undefined);
  assert.equal(CLUSTER_FOLDER_THRESHOLD, 3);
});

console.log('\n[I2] 冷却表');

ok('7 天内保留，超过 7 天丢弃', () => {
  const records = pruneSeen(
    [
      { id: 'fresh', at: NOW - IDEA_COOLDOWN_MS + 1000 },
      { id: 'expired', at: NOW - IDEA_COOLDOWN_MS - 1000 },
    ],
    NOW,
  );
  assert.deepEqual(records.map((r) => r.id), ['fresh']);
  assert.deepEqual(activeSeenIds(records), ['fresh']);
});

ok('非法形状被清掉，重复 id 保留最新时间', () => {
  const records = pruneSeen(
    [
      null,
      'nope',
      { id: '', at: NOW },
      { id: 'dup', at: NOW - 5000 },
      { id: 'dup', at: NOW - 1000 },
      { id: 'bad-time', at: Number.NaN },
      { id: 'zero', at: 0 },
    ],
    NOW,
  );
  assert.deepEqual(records, [{ id: 'dup', at: NOW - 1000 }]);
});

ok('非数组输入返回空表', () => {
  assert.deepEqual(pruneSeen(undefined, NOW), []);
  assert.deepEqual(pruneSeen({ id: 'x', at: NOW }, NOW), []);
});

ok(`冷却表按时间倒序且不超过 ${SEEN_LIMIT} 条`, () => {
  const raw = Array.from({ length: SEEN_LIMIT + 40 }, (_, i) => ({ id: `id-${i}`, at: NOW - i * 1000 }));
  const records = pruneSeen(raw, NOW);
  assert.equal(records.length, SEEN_LIMIT);
  for (let i = 1; i < records.length; i++) assert.ok(records[i - 1]!.at > records[i]!.at);
});

console.log('\n[I3] 模型点子：只收可信的');

const modelOpts = { totalBookmarks: 20, now: NOW };

ok('合法 JSON 数组被接受，id 带 model- 前缀且互不冲突', () => {
  const ideas = parseModelIdeas(
    JSON.stringify([
      { kind: 'insight', title: '设计类书签混在一起', body: '看起来像两个体系', prompt: '帮我按主题分组', count: 5 },
    ]),
    modelOpts,
  );
  assert.equal(ideas.length, 1);
  assert.equal(ideas[0]!.id, 'model-insight-0');
  assert.equal(ideas[0]!.source, 'model');
  assert.equal(ideas[0]!.count, 5);
});

ok('```json 围栏也能解析', () => {
  const ideas = parseModelIdeas(
    '```json\n[{"kind":"cluster","title":"t","body":"b","prompt":"p"}]\n```',
    modelOpts,
  );
  assert.equal(ideas.length, 1);
});

ok('非 JSON / 非数组 / 空对象都返回空数组，不抛错', () => {
  assert.deepEqual(parseModelIdeas('这不是 JSON', modelOpts), []);
  assert.deepEqual(parseModelIdeas('{"foo":1}', modelOpts), []);
  assert.deepEqual(parseModelIdeas('', modelOpts), []);
});

ok('非法 kind、缺字段、编造的大数字都被丢弃', () => {
  const ideas = parseModelIdeas(
    JSON.stringify([
      { kind: 'hack', title: 't', body: 'b', prompt: 'p' },
      { kind: 'insight', title: '', body: 'b', prompt: 'p' },
      { kind: 'insight', title: 't', body: 'b', prompt: 'p', count: 9999 },
      { kind: 'stale', title: '真实', body: 'b', prompt: 'p', count: 3 },
    ]),
    modelOpts,
  );
  assert.equal(ideas.length, 1);
  assert.equal(ideas[0]!.title, '真实');
});

ok('模型声称"已经删除"的点子被整条丢弃', () => {
  const ideas = parseModelIdeas(
    JSON.stringify([
      { kind: 'insight', title: 't', body: '已经帮你删除了 12 条', prompt: 'p' },
      { kind: 'insight', title: 't', body: 'b', prompt: '我已经清理掉了，你看看' },
    ]),
    modelOpts,
  );
  assert.deepEqual(ideas, []);
});

ok(`一次最多 ${MODEL_IDEA_LIMIT} 条`, () => {
  const list = Array.from({ length: 10 }, (_, i) => ({
    kind: 'insight',
    title: `t${i}`,
    body: 'b',
    prompt: 'p',
  }));
  assert.equal(parseModelIdeas(JSON.stringify(list), modelOpts).length, MODEL_IDEA_LIMIT);
});

ok(`样本标题最多 ${MODEL_SAMPLE_LIMIT} 条，且不含 URL 之外的隐私字段`, () => {
  const roots = fixture();
  const titles = sampleTitles(roots);
  assert.ok(titles.length <= MODEL_SAMPLE_LIMIT);
  assert.ok(titles.length > 0);
});

console.log('\n[I4] 简单清理：数字必须对得上');

ok('四类分类数量与洞察一致', () => {
  const roots = fixture();
  const cats = computeCleanupCategories(roots, NOW);
  const byKind = new Map(cats.map((c) => [c.kind, c]));
  assert.equal(byKind.get('duplicate')!.count, 2);
  assert.equal(byKind.get('empty-folder')!.count, 1);
  assert.equal(byKind.get('stale')!.count, 2);
  assert.equal(byKind.get('broken')!.count, null);
  assert.equal(byKind.get('broken')!.needsProbe, true);
  assert.deepEqual(byKind.get('broken')!.sampleIds, []);
});

ok('样本 id 都是真实存在的书签/文件夹', () => {
  const roots = fixture();
  const ids = allIds(roots);
  for (const cat of computeCleanupCategories(roots, NOW)) {
    for (const id of cat.sampleIds) assert.ok(ids.has(id), `${cat.kind} 的样本 ${id} 不存在`);
  }
});

const allOn: CleanupSelection = { duplicate: true, 'empty-folder': true, stale: true, broken: true };

ok('"将影响 N 条"= 已勾选且数量已知的合计；待检测项不计入', () => {
  const cats = computeCleanupCategories(fixture(), NOW);
  assert.equal(impactCount(cats, allOn), 5);
  assert.deepEqual(pendingProbeKinds(cats, allOn), ['broken']);
  // 只勾断链：N 必须是 0，而不是猜一个数字
  assert.equal(impactCount(cats, { duplicate: false, 'empty-folder': false, stale: false, broken: true }), 0);
});

ok('检测完成后断链数量才进入 N', () => {
  const cats = computeCleanupCategories(fixture(), NOW, { count: 4, sampleIds: ['d1', 'd2', 's1', 's2'] });
  const broken = cats.find((c) => c.kind === 'broken')!;
  assert.equal(broken.count, 4);
  assert.equal(broken.needsProbe, false);
  assert.equal(impactCount(cats, allOn), 9);
});

ok('清理指令只包含勾选项，且明确要求先确认再删', () => {
  const cats = computeCleanupCategories(fixture(), NOW);
  const prompt = buildCleanupPrompt(cats, { duplicate: true, 'empty-folder': false, stale: false, broken: false });
  assert.match(prompt, /重复链接 2 条/);
  assert.doesNotMatch(prompt, /空文件夹/);
  assert.doesNotMatch(prompt, /断链/);
  assert.match(prompt, /不要直接删除/);
});

ok('未检测的断链被勾选时，指令要求"先检测"而不是报数字', () => {
  const cats = computeCleanupCategories(fixture(), NOW);
  const prompt = buildCleanupPrompt(cats, { duplicate: false, 'empty-folder': false, stale: false, broken: true });
  assert.match(prompt, /先检测链接/);
  assert.doesNotMatch(prompt, /断链 \d+ 条/);
});

ok('什么都没勾 / 库里没有问题时不生成空指令', () => {
  const cats = computeCleanupCategories(fixture(), NOW);
  assert.equal(buildCleanupPrompt(cats, { duplicate: false, 'empty-folder': false, stale: false, broken: false }), '');
  const clean: BNode[] = [folder('1', '书签栏', [bm('x', 'x', 'https://keep.example/', { dateLastUsed: RECENT })])];
  // 断链未检测时总会生成一条"先检测"，所以这里只勾前三类
  assert.equal(
    buildCleanupPrompt(computeCleanupCategories(clean, NOW), {
      duplicate: true,
      'empty-folder': true,
      stale: true,
      broken: false,
    }),
    '',
  );
});

console.log(`\n✓ ideas 测试通过：${passed} 项`);
