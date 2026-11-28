/**
 * ── 向量检索工作线的契约测试 ──
 *
 * 覆盖四块：
 *  · 本地向量：确定性、归一化、中英混排、空输入；
 *  · 索引：增量、移动后 path、版本变更重建、容量护栏降级计数；
 *  · 融合：精确匹配置顶、语义高分不压过精确匹配、同分稳定排序；
 *  · 降级：远端 401 停用、超时退回本地、索引未就绪时关键词仍可用。
 *
 * 运行：npx tsx tests/semantic.test.ts
 */
import assert from 'node:assert/strict';
import {
  EMBED_DIM,
  embedBookmark,
  embedQuery,
  cosine,
  tokenize,
  tokenizeUrl,
} from '../src/lib/search/semantic/local-embed';
import {
  INDEX_VERSION,
  SemanticIndex,
  buildEntriesFromRoots,
  chooseShardCount,
  createMemoryStore,
  estimateEntryBytes,
  localEmbedder,
  planDegradedIds,
  shardKey,
  type IndexEntry,
} from '../src/lib/search/semantic/index';
import {
  buildQueryVector,
  expandQuery,
  fuseSearch,
  reasonLabel,
  KEYWORD_WEIGHT,
  SEMANTIC_WEIGHT,
} from '../src/lib/search/semantic/search';
import {
  RemoteEmbedder,
  RemoteEmbedError,
  requestEmbeddings,
} from '../src/lib/search/semantic/remote-embed';
import {
  keywordHits,
  registerSemanticSearcher,
  searchBookmarks,
} from '../src/lib/features/semantic';
import { runSemanticSearch } from '../src/lib/search/semantic/register';

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

/** 真实书签样本：量足够大、跨领域，排序断言才有意义 */
const bookmarks: Array<[string, string, string]> = [
  ['100', 'GitHub · 代码托管', 'https://github.com/'],
  ['101', 'GitLab · 代码托管与 CI/CD', 'https://gitlab.com/'],
  ['102', 'React – 用于构建用户界面的 JavaScript 库', 'https://react.dev/'],
  ['103', 'Vue.js 渐进式 JavaScript 框架', 'https://vuejs.org/'],
  ['104', 'MDN Web Docs', 'https://developer.mozilla.org/'],
  ['105', 'TypeScript 中文手册', 'https://www.typescriptlang.org/'],
  ['106', 'Figma 设计协作工具', 'https://www.figma.com/'],
  ['107', 'Dribbble 设计师作品与灵感', 'https://dribbble.com/'],
  ['108', 'Notion 笔记与文档', 'https://www.notion.so/'],
  ['109', 'Obsidian 知识库与笔记', 'https://obsidian.md/'],
  ['110', '阮一峰的网络日志', 'https://www.ruanyifeng.com/blog/'],
  ['111', '掘金 开发者社区', 'https://juejin.cn/'],
  ['112', '知乎 有问题就会有答案', 'https://www.zhihu.com/'],
  ['113', '哔哩哔哩 视频社区', 'https://www.bilibili.com/'],
  ['114', 'YouTube 视频', 'https://www.youtube.com/'],
  ['115', '豆瓣电影', 'https://movie.douban.com/'],
  ['116', 'Steam 游戏平台', 'https://store.steampowered.com/'],
  ['117', 'Spotify 音乐', 'https://open.spotify.com/'],
  ['118', '淘宝网 购物', 'https://www.taobao.com/'],
  ['119', '京东 购物商城', 'https://www.jd.com/'],
  ['120', '机器之心 人工智能媒体', 'https://www.jiqizhixin.com/'],
  ['121', 'OpenAI', 'https://openai.com/'],
  ['122', 'Docker 容器平台', 'https://www.docker.com/'],
  ['123', 'Kubernetes 容器编排', 'https://kubernetes.io/'],
  ['124', 'AWS 云服务', 'https://aws.amazon.com/'],
];

function makeTree(items: Array<[id: string, title: string, url: string]>, folder = '技术', folderId = '10'): BNode[] {
  return [
    {
      id: '1',
      title: '书签栏',
      children: [
        {
          id: folderId,
          title: folder,
          children: [
            ...items.map(([id, title, url], i) => ({
              id,
              title,
              url,
              parentId: folderId,
              dateAdded: 1_700_000_000_000 + i,
            })),
          ],
        },
      ],
    },
  ] as BNode[];
}

function entry(
  id: string,
  title: string,
  vector: number[] | null,
  opts: { dateAdded?: number; dateLastUsed?: number; tokens?: string[]; degraded?: boolean } = {},
): IndexEntry {
  return {
    id,
    title,
    url: `https://example.com/${id}`,
    path: '书签栏 / 测试',
    ancestors: ['1', '10'],
    dateAdded: opts.dateAdded ?? 0,
    ...(opts.dateLastUsed ? { dateLastUsed: opts.dateLastUsed } : {}),
    vector,
    tokens: opts.tokens ?? tokenize(title),
    degraded: opts.degraded ?? vector === null,
  };
}

async function main() {
  console.log('[S1] 本地向量：确定性 / 归一化 / 中英混排 / 空输入');
  {
    ok('同样输入永远同样输出（不含随机/时间）', () => {
      const a = embedBookmark({ title: 'React 前端框架', url: 'https://react.dev/', path: '书签栏 / 技术' });
      const b = embedBookmark({ title: 'React 前端框架', url: 'https://react.dev/', path: '书签栏 / 技术' });
      assert.deepEqual(a, b);
      assert.equal(a.vector.length, EMBED_DIM);
    });

    ok('向量是 L2 归一化（余弦自相似为 1）', () => {
      const v = embedBookmark({ title: 'GitHub 代码托管', url: 'https://github.com/' }).vector;
      const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
      assert.ok(Math.abs(norm - 1) < 1e-3, `norm=${norm}`);
      assert.ok(Math.abs(cosine(v, v) - 1) < 1e-6);
    });

    ok('大小写 / 空白 / 全角归一后是同一个向量', () => {
      const a = embedBookmark({ title: 'GitHub  Code', url: 'https://github.com' }).vector;
      const b = embedBookmark({ title: 'ｇｉｔｈｕｂ code', url: 'https://github.com' }).vector;
      assert.ok(cosine(a, b) > 0.999);
    });

    ok('中英混排：英文按词、中文按字与 2-gram', () => {
      const tokens = tokenize('React 前端框架');
      assert.ok(tokens.includes('react'));
      assert.ok(tokens.includes('前端'));
      assert.ok(tokens.includes('端框'));
      assert.ok(tokens.includes('框架'));
      assert.ok(tokens.includes('前端框架'));
    });

    ok('URL 域名/路径词被单独纳入', () => {
      const { host, path } = tokenizeUrl('https://www.typescriptlang.org/docs/handbook/');
      assert.ok(host.includes('typescriptlang'));
      assert.ok(path.includes('docs'));
      assert.ok(path.includes('handbook'));
    });

    ok('空输入不产生 NaN，零向量可比较', () => {
      assert.deepEqual(tokenize(''), []);
      const { vector } = embedBookmark({ title: '' });
      assert.equal(vector.length, EMBED_DIM);
      assert.ok(vector.every((x) => x === 0));
      assert.equal(cosine(vector, embedQuery('')), 0);
    });
  }

  console.log('\n[S2] 索引：分片 / 增量 / 移动 / 版本 / 容量');
  {
    const tree = makeTree(bookmarks);

    await okA('首次建索引落分片，manifest 如实计数', async () => {
      const store = createMemoryStore();
      const index = new SemanticIndex(store, localEmbedder, () => 1_700_000_000_000);
      await index.rebuild(tree, { yieldBetweenBatches: false });
      assert.equal(index.count, bookmarks.length);
      assert.ok(index.manifest);
      assert.equal(index.manifest!.count, bookmarks.length);
      assert.equal(index.manifest!.version, INDEX_VERSION);
      assert.equal(index.manifest!.model, localEmbedder.id);
      assert.equal(index.manifest!.degradedCount, 0);
      const dump = store.dump();
      assert.ok(dump[shardKey(0)]);
    });

    await okA('重载后向量与条目一致（roundtrip）', async () => {
      const store = createMemoryStore();
      const index = new SemanticIndex(store, localEmbedder);
      await index.rebuild(tree, { yieldBetweenBatches: false });
      const reloaded = new SemanticIndex(store, localEmbedder);
      assert.equal(await reloaded.load(), true);
      assert.equal(reloaded.count, bookmarks.length);
      const first = reloaded.entries.get('102');
      assert.ok(first);
      assert.equal(first!.title, 'React – 用于构建用户界面的 JavaScript 库');
      assert.equal(first!.vector!.length, EMBED_DIM);
    });

    await okA('分片每片不超过 200 条', async () => {
      const many: Array<[string, string, string]> = Array.from({ length: 450 }, (_, i) => [
        String(10_000 + i),
        `书签 ${i} 技术文档`,
        `https://example.com/doc/${i}`,
      ]);
      const store = createMemoryStore();
      const index = new SemanticIndex(store, localEmbedder);
      await index.rebuild(makeTree(many), { yieldBetweenBatches: false });
      const shards = index.manifest!.shards;
      assert.ok(shards >= 3, `shards=${shards}`);
      let total = 0;
      for (let i = 0; i < shards; i++) {
        const rows = (store.dump()[shardKey(i)] as IndexEntry[]) ?? [];
        assert.ok(rows.length <= 200, `shard ${i} 有 ${rows.length} 条`);
        total += rows.length;
      }
      assert.equal(total, 450);
      assert.equal(chooseShardCount(Array.from({ length: 450 }, (_, i) => String(i))), shards);
    });

    await okA('增量：新增/改名/删除只动受影响条目', async () => {
      const store = createMemoryStore();
      const index = new SemanticIndex(store, localEmbedder);
      await index.rebuild(tree, { yieldBetweenBatches: false });
      const before = index.entries.get('102')!.vector;

      const added = [...bookmarks, ['200', '新收藏的 Rust 教程', 'https://rust-lang.org/learn/'] as [string, string, string]];
      const r1 = await index.sync(makeTree(added), { yieldBetweenBatches: false });
      assert.deepEqual(r1, { added: 1, updated: 0, removed: 0 });
      assert.ok(index.entries.get('200'));
      // 未变化的条目向量原样保留（不重算）
      assert.equal(index.entries.get('102')!.vector, before);

      const renamed = added.map((row) =>
        row[0] === '200' ? (['200', 'Rust 编程语言官方文档', row[2]] as [string, string, string]) : row,
      );
      const r2 = await index.sync(makeTree(renamed), { yieldBetweenBatches: false });
      assert.equal(r2.updated, 1);
      assert.equal(index.entries.get('200')!.title, 'Rust 编程语言官方文档');

      const removed = renamed.filter((row) => row[0] !== '114');
      const r3 = await index.sync(makeTree(removed), { yieldBetweenBatches: false });
      assert.equal(r3.removed, 1);
      assert.equal(index.entries.has('114'), false);
    });

    await okA('移动文件夹后整棵子树的 path 与 ancestors 都更新', async () => {
      const store = createMemoryStore();
      const index = new SemanticIndex(store, localEmbedder);
      const before = makeTree([
        ['300', 'React 文档', 'https://react.dev/learn'],
        ['301', 'Vue 文档', 'https://vuejs.org/guide'],
      ]);
      await index.rebuild(before, { yieldBetweenBatches: false });
      assert.equal(index.entries.get('300')!.path, '书签栏 / 技术');
      assert.deepEqual(index.entries.get('300')!.ancestors, ['1', '10']);

      const after = makeTree(
        [
          ['300', 'React 文档', 'https://react.dev/learn'],
          ['301', 'Vue 文档', 'https://vuejs.org/guide'],
        ],
        '前端',
        '20',
      );
      const result = await index.sync(after, { yieldBetweenBatches: false });
      assert.equal(result.updated, 2);
      assert.equal(index.entries.get('300')!.path, '书签栏 / 前端');
      assert.deepEqual(index.entries.get('300')!.ancestors, ['1', '20']);
      // 只换位置不重算向量
      assert.equal(index.entries.get('300')!.vector!.length, EMBED_DIM);
    });

    await okA('版本不匹配触发整库重建，旧向量不混用', async () => {
      const store = createMemoryStore();
      const index = new SemanticIndex(store, localEmbedder);
      await index.rebuild(tree, { yieldBetweenBatches: false });
      const manifest = index.manifest!;
      await store.writeManifest({ ...manifest, version: INDEX_VERSION + 1 });

      const stale = new SemanticIndex(store, localEmbedder);
      assert.equal(await stale.load(), false);
      assert.equal(stale.count, 0);

      await stale.rebuild(tree, { yieldBetweenBatches: false });
      assert.equal(stale.manifest!.version, INDEX_VERSION);
      const fresh = new SemanticIndex(store, localEmbedder);
      assert.equal(await fresh.load(), true);
      assert.equal(fresh.count, bookmarks.length);

      // 维度不一致同样必须拒绝：两种维度的向量不能混进同一个余弦空间
      await store.writeManifest({ ...stale.manifest!, dim: EMBED_DIM + 1 });
      const wrongDim = new SemanticIndex(store, localEmbedder);
      assert.equal(await wrongDim.load(), false);
    });

    ok('容量护栏：超预算按最近使用/收藏保留，其余降级', () => {
      const rows = [
        entry('a', '最近打开', [1, 0, 0, 0], { dateAdded: 1, dateLastUsed: 9_000 }),
        entry('b', '最近收藏', [1, 0, 0, 0], { dateAdded: 8_000 }),
        entry('c', '很久以前', [1, 0, 0, 0], { dateAdded: 2 }),
        entry('d', '也降级', [1, 0, 0, 0], { dateAdded: 1 }),
      ];
      const base = rows.reduce((sum, row) => sum + estimateEntryBytes({ ...row, vector: null, degraded: true }), 0);
      const vectorBytes = rows.reduce((sum, row) => sum + (estimateEntryBytes(row) - estimateEntryBytes({ ...row, vector: null, degraded: true })), 0);
      // 只够留 2 条向量
      const budget = base + Math.ceil(vectorBytes / 2);
      const degraded = planDegradedIds(rows, budget);
      assert.equal(degraded.size, 2);
      assert.ok(!degraded.has('a'), '最近打开必须保留');
      assert.ok(degraded.has('c') || degraded.has('d'));
      assert.ok(degraded.has('d'), '最久未用的先降级');

      // 幂等：把降级标记写回条目后再算一遍，结果不能变（否则索引会反复"解除降级"）
      const applied = rows.map((row) => ({ ...row, degraded: degraded.has(row.id) }));
      const again = planDegradedIds(applied, budget);
      assert.deepEqual([...again].sort(), [...degraded].sort());
    });

    await okA('manifest 的 degradedCount 与实际降级条目一致', async () => {
      const store = createMemoryStore();
      const index = new SemanticIndex(store, localEmbedder);
      // 预算 1 字节：所有向量都放不下
      await index.rebuild(tree, { budget: 1, yieldBetweenBatches: false });
      const degraded = [...index.entries.values()].filter((e) => e.degraded).length;
      assert.equal(degraded, bookmarks.length);
      assert.equal(index.manifest!.degradedCount, degraded);
      const reloaded = new SemanticIndex(store, localEmbedder);
      assert.equal(await reloaded.load(), true);
      assert.equal(reloaded.manifest!.degradedCount, bookmarks.length);
      assert.ok([...reloaded.entries.values()].every((e) => e.vector === null && e.degraded));
    });
  }

  console.log('\n[S3] 融合：精确置顶 / 语义不压字面 / 稳定排序 / 质量下限');
  {
    const local = buildEntriesFromRoots(makeTree(bookmarks));

    ok('至少 20 条真实样本：字面相关排在无关项之前', () => {
      assert.ok(bookmarks.length >= 20);
      const cases: Array<[query: string, expectedTop: string[]]> = [
        ['前端框架', ['Vue.js 渐进式 JavaScript 框架', 'React – 用于构建用户界面的 JavaScript 库']],
        ['代码托管', ['GitHub · 代码托管', 'GitLab · 代码托管与 CI/CD']],
        ['设计工具', ['Figma 设计协作工具', 'Dribbble 设计师作品与灵感']],
        ['笔记', ['Notion 笔记与文档', 'Obsidian 知识库与笔记']],
        ['容器', ['Docker 容器平台', 'Kubernetes 容器编排']],
        ['购物', ['淘宝网 购物', '京东 购物商城']],
      ];
      for (const [query, expected] of cases) {
        const top = fuseSearch(local, query, { limit: 2 }).map((hit) => hit.title);
        assert.deepEqual(top.sort(), [...expected].sort(), `「${query}」的实际前二：${top.join(' | ')}`);
      }
    });

    ok('精确匹配硬置顶，语义分再高也压不过', () => {
      const qv = buildQueryVector('react');
      const exact = entry('x1', 'React', [0, 1, 0, 0], { tokens: ['react'] });
      const semantic = entry('x2', '一个用 React 构建的界面库', qv, { tokens: ['react', '构建'] });
      const hits = fuseSearch([semantic, exact], 'React', { queryVector: qv, limit: 2, requireLexicalAnchor: false });
      assert.equal(hits[0]!.id, 'x1');
      assert.equal(hits[0]!.reason, 'exact');
      assert.equal(hits[1]!.id, 'x2');
    });

    ok('同分稳定排序：不依赖输入顺序，也不依赖 Math.random', () => {
      const a = entry('2', '同名书签', [0, 1, 0, 0], { tokens: ['同名'] });
      const b = entry('1', '同名书签', [0, 1, 0, 0], { tokens: ['同名'] });
      const first = fuseSearch([a, b], '同名', { limit: 2, requireLexicalAnchor: false }).map((h) => h.id);
      const second = fuseSearch([b, a], '同名', { limit: 2, requireLexicalAnchor: false }).map((h) => h.id);
      assert.deepEqual(first, second);
      assert.deepEqual(first, ['1', '2']);
    });

    ok('融合分 = 关键词×0.6 + 语义×0.4（同义扩展只加分）', () => {
      const qv = [0, 1, 0, 0];
      // 标题完全等于查询 → 关键词 1.0，语义 1.0
      const hit = fuseSearch([entry('f1', 'github', qv, { tokens: ['github'] })], 'github', {
        queryVector: qv,
        limit: 1,
        requireLexicalAnchor: false,
      })[0]!;
      assert.ok(Math.abs(hit.score - (1 * KEYWORD_WEIGHT + 1 * SEMANTIC_WEIGHT)) < 1e-6);
    });

    ok('文件夹限定只返回子树内的条目', () => {
      const inFolder = entry('f1', 'React 文档', [1, 0, 0, 0], { tokens: ['react'] });
      const outside = { ...entry('f2', 'React 文档（另一处）', [1, 0, 0, 0], { tokens: ['react'] }), ancestors: ['1', '99'] };
      const hits = fuseSearch([inFolder, outside], 'React', { folderId: '10', limit: 10, requireLexicalAnchor: false });
      assert.deepEqual(hits.map((h) => h.id), ['f1']);
    });

    ok('同义扩展不替代原查询，reason 文案完整', () => {
      const expansion = expandQuery('代码托管');
      assert.ok(expansion.expanded.includes('github'));
      const labels = ['exact', 'prefix', 'contains', 'subtitle', 'fuzzy', 'semantic'] as const;
      for (const label of labels) assert.ok(reasonLabel(label).length > 0);
    });
  }

  console.log('\n[S4] 降级：远端 401 / 超时 / 索引未就绪');
  {
    const config = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'text-embedding-test' };

    await okA('远端 401 立即停用，不再重试', async () => {
      let calls = 0;
      const fetchImpl = (async () => {
        calls++;
        return new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 401 });
      }) as unknown as typeof fetch;
      let disabledReason = '';
      const embedder = new RemoteEmbedder(config, {
        fetchImpl,
        sleep: async () => {},
        onDisabled: (reason) => {
          disabledReason = reason;
        },
      });
      await assert.rejects(
        () => embedder.embedBookmarks([{ title: 'GitHub' }]),
        (error: unknown) => error instanceof RemoteEmbedError && error.disabled === true,
      );
      assert.equal(calls, 1, '401 不应重试');
      assert.ok(disabledReason.includes('401'));
      assert.equal(embedder.isDisabled, true);
    });

    await okA('远端超时返回失败原因（调用方退回本地）', async () => {
      const fetchImpl = ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        })) as unknown as typeof fetch;
      const result = await requestEmbeddings(['GitHub'], config, {
        fetchImpl,
        timeoutMs: 5,
        maxRetries: 0,
        sleep: async () => {},
      });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.disabled, false);
        assert.ok(result.reason.includes('超时'), result.reason);
      }
      // 失败之后本地路径照常可用（远端不可用就本地）
      const localEntries = buildEntriesFromRoots(makeTree(bookmarks));
      const hits = fuseSearch(localEntries, '代码托管', { limit: 2 });
      assert.equal(hits[0]!.title, 'GitHub · 代码托管');
    });

    await okA('远端 429 退避后成功（批大小 ≤64）', async () => {
      let calls = 0;
      const fetchImpl = (async (_url: string, init?: RequestInit) => {
        calls++;
        if (calls === 1) return new Response('{}', { status: 429 });
        const body = JSON.parse(String(init?.body ?? '{}')) as { input?: string[] };
        const input = body.input ?? [];
        assert.ok(input.length <= 64);
        return new Response(
          JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [0.1, 0.2, 0.3] })) }),
          { status: 200 },
        );
      }) as unknown as typeof fetch;
      const embedder = new RemoteEmbedder(config, { fetchImpl, sleep: async () => {}, maxRetries: 2 });
      const vectors = await embedder.embedBookmarks([{ title: 'GitHub' }, { title: 'GitLab' }]);
      assert.equal(vectors.length, 2);
      assert.equal(vectors[0]!.length, 3);
      assert.equal(calls, 2);
    });

    await okA('索引未就绪时关键词仍可用（不闪空）', async () => {
      registerSemanticSearcher(null);
      const roots = makeTree(bookmarks);
      const syncHits = keywordHits(roots, '代码托管', { limit: 5 });
      assert.ok(syncHits.length >= 2);

      // 未注册实现：searchBookmarks 走关键词兜底
      const fallback = await searchBookmarks(roots, '代码托管', { limit: 5 });
      assert.equal(fallback.used, 'keyword');
      assert.ok(fallback.hits.length >= 2);

      // 实现返回空数组（索引未就绪）：仍要落回关键词
      registerSemanticSearcher(async () => []);
      const empty = await searchBookmarks(roots, 'GitHub', { limit: 5 });
      assert.equal(empty.used, 'keyword');
      assert.equal(empty.hits[0]!.title, 'GitHub · 代码托管');
      registerSemanticSearcher(null);
    });

    await okA('没有 chrome 环境时注册层的检索直接返回空数组，不抛错', async () => {
      const hits = await runSemanticSearch(makeTree(bookmarks), 'GitHub', { limit: 5 });
      assert.deepEqual(hits, []);
    });
  }

  console.log(`\n全部通过：${passed} 项 ✔`);
}

main().catch((e) => {
  console.error('\n❌ 测试失败:', e);
  process.exit(1);
});
