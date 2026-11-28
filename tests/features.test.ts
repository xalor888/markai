/**
 * ── 共享接缝的契约测试 ──
 *
 * 三条并行工作线（语义搜索 / 点子管家 / 对外接口）都依赖 `lib/features/*` 的
 * 注册表与兜底行为。这里把"缺席时必须怎样"钉死：
 *  · 没有实现模块时，搜索仍然返回关键词结果（不是空、不是抛错）；
 *  · 实现模块抛错时，搜索降级并给出原因；
 *  · 外观 store 对外部输入做净化（非法图片地址 / 越界数值）；
 *  · 功能装配失败只降级单个功能，不影响入口。
 *
 * 运行：npx tsx tests/features.test.ts
 */
import assert from 'node:assert/strict';
import {
  FEATURE_KEYS,
  FEATURE_NOTES,
  featureState,
} from '../src/lib/features/flags';
import {
  hasSemanticSearcher,
  keywordHits,
  registerSemanticSearcher,
  searchBookmarks,
  type SemanticHit,
} from '../src/lib/features/semantic';
import {
  generateIdeas,
  hasIdeaGenerator,
  registerIdeaGenerator,
} from '../src/lib/features/ideas';
import {
  APPEARANCE_DEFAULT,
  isSafeImageUrl,
  normalizeAppearance,
} from '../src/stores/appearanceStore';

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

async function okA(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ✔ ${name}`);
  } catch (e) {
    console.error(`  ✘ ${name}`);
    throw e;
  }
}

type BNode = chrome.bookmarks.BookmarkTreeNode;

const tree = [
  {
    id: '0',
    title: '',
    children: [
      {
        id: '1',
        title: '书签栏',
        parentId: '0',
        children: [
          {
            id: '10',
            title: '技术',
            parentId: '1',
            children: [
              { id: '100', title: 'GitHub · 代码托管', url: 'https://github.com/', parentId: '10' },
              { id: '101', title: 'MDN Web Docs', url: 'https://developer.mozilla.org/', parentId: '10' },
            ],
          },
          {
            id: '11',
            title: '设计',
            parentId: '1',
            children: [
              { id: '110', title: 'Figma', url: 'https://figma.com/', parentId: '11' },
            ],
          },
        ],
      },
      { id: '2', title: '其他书签', parentId: '0', children: [] },
    ],
  },
] as unknown as BNode[];

async function main() {
  console.log('\n[F1] 功能开关契约');
  {
    ok('三个功能都登记了"未就绪"说明', () => {
      for (const key of FEATURE_KEYS) {
        assert.ok(FEATURE_NOTES[key]?.length > 0, `${key} 缺少未就绪说明`);
      }
    });
    ok('未就绪状态带说明，就绪状态不带', () => {
      const off = featureState('ideas', false);
      assert.equal(off.ready, false);
      assert.ok(off.note && off.note.length > 0);
      assert.deepEqual(featureState('ideas', true), { ready: true });
    });
  }

  console.log('\n[F2] 语义搜索：缺席时关键词兜底');
  {
    ok('关键词命中标题 / 路径，且按分数降序', () => {
      const hits = keywordHits(tree, 'github');
      assert.equal(hits[0]?.id, '100');
      assert.equal(hits[0]?.reason, 'prefix');
    });

    ok('限定文件夹时只返回该子树', () => {
      const hits = keywordHits(tree, 'a', { folderId: '11' });
      assert.ok(hits.every((h) => h.id === '110'), JSON.stringify(hits));
    });

    ok('不存在的文件夹返回空，而不是退回全库', () => {
      assert.deepEqual(keywordHits(tree, 'github', { folderId: 'nope' }), []);
    });

    ok('空查询不返回结果（避免打开搜索框就刷 40 条）', () => {
      assert.deepEqual(keywordHits(tree, '   '), []);
    });

    await okA('没有注册实现时，searchBookmarks 仍返回关键词结果', async () => {
      registerSemanticSearcher(null);
      assert.equal(hasSemanticSearcher(), false);
      const r = await searchBookmarks(tree, 'figma');
      assert.equal(r.used, 'keyword');
      assert.equal(r.hits[0]?.id, '110');
      assert.equal(r.note, undefined);
    });

    await okA('实现抛错时降级为关键词，并给出原因', async () => {
      registerSemanticSearcher(() => {
        throw new Error('模型不可用');
      });
      const r = await searchBookmarks(tree, 'github');
      assert.equal(r.used, 'keyword');
      assert.ok(r.hits.length > 0, '降级后必须有结果');
      assert.match(r.note ?? '', /模型不可用/);
      registerSemanticSearcher(null);
    });

    await okA('实现返回结果时标记为 semantic', async () => {
      const fake: SemanticHit[] = [
        { id: '110', title: 'Figma', url: 'https://figma.com/', path: '书签栏 / 设计', score: 0.93, reason: 'semantic' },
      ];
      registerSemanticSearcher(() => fake);
      const r = await searchBookmarks(tree, '画图');
      assert.equal(r.used, 'semantic');
      assert.deepEqual(r.hits, fake);
      registerSemanticSearcher(null);
    });

    await okA('实现返回空结果时继续用关键词兜底', async () => {
      registerSemanticSearcher(() => []);
      const r = await searchBookmarks(tree, 'github');
      assert.equal(r.used, 'keyword');
      assert.equal(r.hits[0]?.id, '100');
      registerSemanticSearcher(null);
    });
  }

  console.log('\n[F3] 点子：缺席时是空数组而不是失败');
  {
    await okA('没有生成器时返回空数组且无错误说明', async () => {
      registerIdeaGenerator(null);
      assert.equal(hasIdeaGenerator(), false);
      const r = await generateIdeas({ roots: tree, habits: [], seenIds: [], round: 0 });
      assert.deepEqual(r.ideas, []);
      assert.equal(r.note, undefined);
    });

    await okA('生成器抛错时保留说明，调用方仍可显示规则建议', async () => {
      registerIdeaGenerator(() => {
        throw new Error('rate limited');
      });
      const r = await generateIdeas({ roots: tree, habits: [], seenIds: [], round: 1 });
      assert.deepEqual(r.ideas, []);
      assert.match(r.note ?? '', /rate limited/);
      registerIdeaGenerator(null);
    });
  }

  console.log('\n[F4] 外观：外部输入净化');
  {
    ok('非法图片地址被丢弃，背景回落极光', () => {
      const a = normalizeAppearance({ background: 'image', backgroundImage: 'javascript:alert(1)' });
      assert.equal(a.backgroundImage, '');
      assert.equal(a.background, 'aurora');
    });

    ok('只接受 data:image 与 http(s)', () => {
      assert.equal(isSafeImageUrl('https://example.com/a.png'), true);
      assert.equal(isSafeImageUrl('data:image/png;base64,iVBORw0KGgo='), true);
      assert.equal(isSafeImageUrl('file:///etc/passwd'), false);
      assert.equal(isSafeImageUrl('data:text/html;base64,PHNjcmlwdD4='), false);
    });

    ok('数值越界被钳到 0–100', () => {
      const a = normalizeAppearance({ glass: 999, backgroundDim: -20 });
      assert.equal(a.glass, 100);
      assert.equal(a.backgroundDim, 0);
    });

    ok('未知强调色回落默认，不产生无效 data 属性', () => {
      const a = normalizeAppearance({ accent: 'neon-pink' });
      assert.equal(a.accent, APPEARANCE_DEFAULT.accent);
    });

    ok('垃圾输入整体回落默认值', () => {
      assert.deepEqual(normalizeAppearance(null), APPEARANCE_DEFAULT);
      assert.deepEqual(normalizeAppearance('nope'), APPEARANCE_DEFAULT);
    });
  }

  console.log(`\n全部通过：${passed} 项 ✔`);
}

main().catch((e) => {
  console.error('\n❌ 测试失败:', e);
  process.exit(1);
});
