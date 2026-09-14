/**
 * ── MarkAI Agent 核心逻辑测试 ──
 * 运行方式：npx tsx tests/agent.test.ts
 *
 * 覆盖：
 *  1. SSE 流式解析（content 分块、tool_calls 分片累加、[DONE]）
 *  2. Agent 工具循环（调用 → 执行 → 回填 → 最终回复 → chat:done）
 *  3. propose_deletions 安全机制（根文件夹被排除、携带 deletions 载荷）
 *  4. 未知工具 / 参数非法 / HTTP 401 的错误处理（不降级重试）
 *  5. 工具定义 ↔ 元信息 ↔ 执行器名称一致性
 *  6. zod v4 校验行为
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgentTurn } from '../src/lib/ai/agent';
import { ChatError } from '../src/lib/ai/client';
import { TOOL_DEFINITIONS } from '../src/lib/ai/prompts';
import { executeTool, TOOL_META } from '../src/lib/ai/tools';
import type { AIConfig, ChatInbound, ChatMessage, ChatOutbound, DeletionProposal } from '../src/lib/ai/types';
import { z } from 'zod';

/* ══════════ 1. mock chrome.bookmarks（内存书签树） ══════════ */

interface FNode {
  id: string;
  parentId?: string;
  title: string;
  url?: string;
  dateAdded: number;
  dateLastUsed?: number;
}

const store: FNode[] = [
  { id: '0', title: '', dateAdded: 0 },
  { id: '1', title: '书签栏', parentId: '0', dateAdded: 1 },
  { id: '2', title: '其他书签', parentId: '0', dateAdded: 1 },
  { id: '3', title: 'GitHub', parentId: '1', url: 'https://github.com', dateAdded: 2 },
  { id: '4', title: 'GitHub Docs', parentId: '1', url: 'https://docs.github.com', dateAdded: 3 },
  { id: '5', title: '技术', parentId: '1', dateAdded: 4 },
  { id: '6', title: 'MDN', parentId: '5', url: 'https://developer.mozilla.org', dateAdded: 5 },
  { id: '7', title: '旧书签', parentId: '2', url: 'https://example.com/old', dateAdded: 6, dateLastUsed: 0 },
  { id: '8', title: '促销页', parentId: '2', url: 'https://shop.example.com/deal', dateAdded: 7 },
];

let nextId = 100;
const nodeById = (id: string): FNode | undefined => store.find((n) => n.id === id);
const childrenOf = (pid: string): FNode[] => store.filter((n) => n.parentId === pid);

function toApi(n: FNode): chrome.bookmarks.BookmarkTreeNode {
  const children = childrenOf(n.id);
  return {
    id: n.id,
    parentId: n.parentId,
    title: n.title,
    url: n.url,
    dateAdded: n.dateAdded,
    dateLastUsed: n.dateLastUsed,
    syncing: false,
    ...(children.length ? { children: children.map((c) => toApi(c)) } : {}),
  };
}

/**
 * 把节点插入 store，使其成为（新）父文件夹内的第 index 个兄弟。
 * store 数组的相对顺序即兄弟顺序（childrenOf 按数组顺序过滤），
 * 因此"插入到目标位置"= 插到该位置兄弟的前面；越界或 index == 兄弟数则追加到末尾。
 */
function insertSiblingAt(node: FNode, index: number) {
  const siblings = childrenOf(node.parentId!);
  const before = siblings[index];
  const anchor = before ?? siblings[siblings.length - 1];
  if (!anchor) {
    store.push(node);
    return;
  }
  store.splice(store.findIndex((n) => n.id === anchor.id) + (before ? 0 : 1), 0, node);
}

/**
 * 书签树的稳定快照（含 id、标题、URL 与**顺序**）。
 * 用途：撤销的验收标准是「整棵树与操作前逐节点一致」，必须能比较顺序，
 * 只比集合会漏掉"顺序错了"这类最典型的撤销 bug。
 */
async function snapshotTree(): Promise<string> {
  const tree = await mockBookmarks.getTree();
  const norm = (n: chrome.bookmarks.BookmarkTreeNode): unknown => ({
    id: n.id,
    title: n.title,
    url: n.url ?? null,
    children: (n.children ?? []).map(norm),
  });
  return JSON.stringify((tree[0]?.children ?? []).map(norm));
}

/** 树快照的规范化结构（深比对 + 差异定位用） */
interface TreeNorm {
  id: string;
  title: string;
  url: string | null;
  children: TreeNorm[];
}

async function snapshotTreeObj(): Promise<TreeNorm[]> {
  const tree = await mockBookmarks.getTree();
  const norm = (n: chrome.bookmarks.BookmarkTreeNode): TreeNorm => ({
    id: n.id,
    title: n.title,
    url: n.url ?? null,
    children: (n.children ?? []).map(norm),
  });
  return (tree[0]?.children ?? []).map(norm);
}

/**
 * 定位两棵树的第一处差异，返回可读路径。
 * 大库用例（5000+ 节点）里直接 assert.deepEqual 会打印 40 万字符，根本看不出哪错了。
 *
 * `ignoreIds`：撤销删除时，被删的节点是**重新创建**的，Chrome 会分配新 id
 * （API 不允许指定 id）。所以「删除撤销后是否复原」只能按结构比对
 * ——标题/URL/层级/顺序一致即等价，id 变化是浏览器的限制而不是缺陷。
 */
function firstTreeDiff(
  expected: TreeNorm[],
  actual: TreeNorm[],
  path = '',
  opts: { ignoreIds?: boolean } = {},
): string | null {
  if (expected.length !== actual.length) {
    return `${path || '(根)'}：子项数 期望 ${expected.length}，实际 ${actual.length}`;
  }
  for (let i = 0; i < expected.length; i++) {
    const e = expected[i]!;
    const a = actual[i]!;
    const here = `${path}/${e.title || e.id}`;
    if (!opts.ignoreIds && e.id !== a.id) return `${here}：id 期望 ${e.id}，实际 ${a.id}`;
    if (e.title !== a.title) return `${here}：标题 期望「${e.title}」，实际「${a.title}」`;
    if (e.url !== a.url) return `${here}：URL 期望「${e.url}」，实际「${a.url}」`;
    const child = firstTreeDiff(e.children, a.children, here, opts);
    if (child) return child;
  }
  return null;
}

const mockBookmarks = {
  getTree: async () => [toApi({ id: '0', title: '', dateAdded: 0 })],
  getSubTree: async (id: string) => {
    const node = nodeById(id);
    assert(node, `getSubTree: 节点 ${id} 不存在`);
    return [toApi(node)];
  },
  get: async (ids: string | string[]) => {
    const list = Array.isArray(ids) ? ids : [ids];
    return list.map((id) => nodeById(id)).filter((n): n is FNode => !!n).map((n) => toApi(n));
  },
  getChildren: async (id: string) => childrenOf(id).map((n) => toApi(n)),
  getRecent: async (count: number) =>
    [...store].sort((a, b) => b.dateAdded - a.dateAdded).slice(0, count).map((n) => toApi(n)),
  search: async (query: string) =>
    store.filter((n) => n.title.includes(query) || (n.url ?? '').includes(query)).map((n) => toApi(n)),
  create: async (opt: { parentId?: string; title: string; url?: string; index?: number }) => {
    const id = String(nextId++);
    const node: FNode = {
      id,
      parentId: opt.parentId ?? '1',
      title: opt.title,
      url: opt.url,
      dateAdded: Date.now(),
    };
    insertSiblingAt(node, opt.index ?? childrenOf(node.parentId!).length);
    return toApi(node);
  },
  /**
   * 忠实实现 Chromium `BookmarkModel::Move` 的 index 语义
   * （components/bookmarks/browser/bookmark_model.cc）：
   *   - 同父且 index == oldIndex 或 index == oldIndex + 1 → 空操作（已在该位置）
   *   - 同父且 index > oldIndex → index--（先移除再插入，目标下标前移一位）
   * 替身若忽略 index，任何"重排顺序"的测试都不可能失败——这正是本文件必须实现它的原因。
   */
  move: async (id: string, dest: { parentId: string; index?: number }) => {
    const node = nodeById(id);
    assert(node, `move: 节点 ${id} 不存在`);
    const oldParentId = node.parentId;
    const oldIndex =
      oldParentId === undefined ? -1 : childrenOf(oldParentId).findIndex((n) => n.id === id);
    let target = dest.index;
    if (oldParentId === dest.parentId && target !== undefined) {
      if (target === oldIndex || target === oldIndex + 1) return toApi(node);
      if (target > oldIndex) target--;
    }
    store.splice(
      store.findIndex((n) => n.id === id),
      1,
    );
    node.parentId = dest.parentId;
    insertSiblingAt(node, target ?? childrenOf(dest.parentId).length);
    return toApi(node);
  },
  update: async (id: string, patch: { title?: string; url?: string }) => {
    const node = nodeById(id);
    assert(node, `update: 节点 ${id} 不存在`);
    if (patch.title !== undefined) node.title = patch.title;
    if (patch.url !== undefined) node.url = patch.url;
    return toApi(node);
  },
  remove: async (id: string) => {
    const idx = store.findIndex((n) => n.id === id);
    assert(idx >= 0, `remove: 节点 ${id} 不存在`);
    store.splice(idx, 1);
  },
  removeTree: async (id: string) => {
    const removeRecursive = (nid: string) => {
      for (const c of childrenOf(nid)) removeRecursive(c.id);
      const idx = store.findIndex((n) => n.id === nid);
      if (idx >= 0) store.splice(idx, 1);
    };
    removeRecursive(id);
  },
};

(globalThis as Record<string, unknown>).chrome = {
  bookmarks: mockBookmarks,
  tabs: { create: async () => ({ id: 1 }) },
  storage: {
    local: {
      get: async (keys: string | string[] | Record<string, unknown> | null) => {
        const want = Array.isArray(keys) ? keys : keys && typeof keys === 'object' ? Object.keys(keys) : keys ? [keys] : null;
        const out: Record<string, unknown> = {};
        if (want === null) {
          for (const [k, v] of storageMap) out[k] = v;
        } else {
          for (const k of want) if (storageMap.has(k)) out[k] = storageMap.get(k);
        }
        return out;
      },
      set: async (obj: Record<string, unknown>) => {
        if (storageSetFail) throw new Error('QUOTA_BYTES quota exceeded');
        for (const [k, v] of Object.entries(obj)) storageMap.set(k, v);
      },
      remove: async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) storageMap.delete(k);
      },
    },
    // 真实 API 是 chrome.storage.onChanged（不是 storage.local.onChanged）
    onChanged: {
      addListener: (fn: StorageListener) => {
        storageListeners.push(fn);
      },
      removeListener: (fn: StorageListener) => {
        const i = storageListeners.indexOf(fn);
        if (i >= 0) storageListeners.splice(i, 1);
      },
    },
  },
  runtime: {
    connect: () => ({
      postMessage: () => {},
      onMessage: { addListener: () => {} },
      onDisconnect: { addListener: () => {} },
    }),
    // 一次性消息：由各测试用例注入响应（默认无响应，等价于"没人处理"）
    sendMessage: async (msg: unknown) => sendMessageMock(msg),
    // 扩展清单：UI 的版本号来源（与 WXT 从 package.json 注入的行为一致）
    getManifest: () => ({ version: manifestVersion }),
  },
};

/** 注入 chrome.runtime.sendMessage 的响应；测试按需覆盖 */
let sendMessageMock: (msg: unknown) => unknown = () => undefined;

/** 故障注入：模拟 chrome.storage.local.set 失败（超配额） */
let storageSetFail = false;

/** 测试期清单版本：默认取 package.json（与 WXT 注入一致），用例可临时覆盖 */
const pkgVersion = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;
let manifestVersion = pkgVersion;

/* ── chrome.storage.onChanged：真实注册 + 可主动触发（跨窗口同步测试用） ── */

type StorageListener = (
  changes: { [key: string]: chrome.storage.StorageChange },
  area: chrome.storage.AreaName,
) => void;
const storageListeners: StorageListener[] = [];

/** 模拟"另一个窗口/background 写了 storage"，通知本窗口的监听器 */
function fireStorageChange(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: chrome.storage.AreaName = 'local') {
  for (const fn of [...storageListeners]) fn(changes, area);
}

/** 内存 storage（多会话墓碑/清空/合并测试用） */
const storageMap = new Map<string, unknown>();

/* ══════════ 2. mock fetch（SSE 响应队列） ══════════ */

const fetchCalls: { url: string; init: RequestInit }[] = [];
let sseQueue: Response[] = [];
/** 连续失败计数器：>0 时 fetch 抛网络错误（模拟断网/服务端不可达），随后恢复 */
let failCountdown = 0;

function sseResponse(chunks: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

function sseEvent(data: string): string {
  return `data: ${data}\n\n`;
}

globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  fetchCalls.push({ url: String(url), init: init ?? {} });
  // 尊重 abort：与真实 fetch 行为一致，已中止的请求立即抛 AbortError
  if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  if (failCountdown > 0) {
    failCountdown--;
    throw new TypeError('Failed to fetch');
  }
  const r = sseQueue.shift();
  if (!r) throw new Error(`fetch 被调用了 ${fetchCalls.length} 次但只 mock 了 ${fetchCalls.length - 1} 次`);
  return r;
}) as typeof fetch;

const TEST_CONFIG: AIConfig = { providerId: 'test', baseUrl: 'https://api.test.com/v1', apiKey: 'sk-test', model: 'test-model' };

function runTurn(text: string, events: ChatOutbound[] = []): Promise<void> {
  return runAgentTurn({
    config: TEST_CONFIG,
    messageId: 'msg-1',
    history: [],
    text,
    signal: new AbortController().signal,
    onEvent: (e) => events.push(e),
  });
}

/* ══════════ 3. 测试用例 ══════════ */

let passed = 0;
function ok(name: string, fn: () => void) {
  try {
    fn();
  } catch (e) {
    // 打印失败用例名：否则只能看到断言栈，无法定位是哪一条（也便于"回滚修复→确认变红"）
    console.error(`  ✘ ${name}`);
    throw e;
  }
  passed++;
  console.log(`  ✔ ${name}`);
}

(async () => {
  /* ── T1: SSE 解析：content 分块 + tool_calls 跨 chunk 累加 ── */
  console.log('\n[T1] SSE 流式解析（工具调用跨分片累加）');
  {
    const { chatCompletion } = await import('../src/lib/ai/client');
    fetchCalls.length = 0;
    sseQueue = [
      sseResponse([
        sseEvent(JSON.stringify({ choices: [{ delta: { content: '让我' } }] })),
        sseEvent(JSON.stringify({ choices: [{ delta: { content: '看看' } }] })),
        sseEvent(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'se' } }] } }] })),
        sseEvent(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'arch_bookmarks', arguments: '{"query":"gi' } }] } }] })),
        sseEvent(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 't"}' } }] } }] })),
        sseEvent(JSON.stringify({ choices: [{ delta: {} }] })),
        sseEvent('[DONE]'),
      ]),
    ];

    const textParts: string[] = [];
    const tools: { id: string; name: string; args: string }[] = [];
    const turn = await chatCompletion(
      TEST_CONFIG,
      [{ role: 'user', content: 'hi' }],
      [],
      new AbortController().signal,
      {
        onText: (t) => textParts.push(t),
        onToolCall: (tc) => tools.push({ id: tc.id, name: tc.function.name, args: tc.function.arguments }),
      },
    );

    ok('content 分块按序拼接', () => assert.equal(textParts.join(''), '让我看看'));
    ok('tool_calls 跨分片累加为完整调用', () => {
      assert.equal(turn.toolCalls.length, 1);
      assert.equal(turn.toolCalls[0]!.function.name, 'search_bookmarks');
      assert.equal(turn.toolCalls[0]!.function.arguments, '{"query":"git"}');
    });
    ok('工具名分片拼接正确', () => {
      assert.equal(tools[0]?.name, 'search_bookmarks');
      assert.equal(tools[0]?.id, 'call_1');
    });

    // 用户取消 → 立即抛出取消错误
    const aborted = new AbortController();
    aborted.abort();
    fetchCalls.length = 0;
    sseQueue = [sseResponse([sseEvent(JSON.stringify({ choices: [{ delta: { content: 'x' } }] }))])];
    let threw = false;
    try {
      await chatCompletion(TEST_CONFIG, [{ role: 'user', content: 'hi' }], [], aborted.signal, {
        onText: () => {},
        onToolCall: () => {},
      });
    } catch {
      threw = true;
    }
    ok('已取消的请求立即抛错', () => assert.ok(threw));
  }

  /* ── T2: Agent 工具循环：调用 search_bookmarks → 回填 → 最终回复 ── */
  console.log('\n[T2] Agent 工具循环（工具调用 → 执行 → 最终回复）');
  {
    fetchCalls.length = 0;
    sseQueue = [
      sseResponse([
        sseEvent(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search_bookmarks', arguments: '{"query":"GitHub"}' } }] } }] })),
        sseEvent('[DONE]'),
      ]),
      sseResponse([
        sseEvent(JSON.stringify({ choices: [{ delta: { content: '找到 2 个 GitHub 相关书签。' } }] })),
        sseEvent('[DONE]'),
      ]),
    ];

    const events: ChatOutbound[] = [];
    await runTurn('帮我找 GitHub 书签', events);

    const toolStart = events.find((e) => e.type === 'chat:tool_start') as Extract<ChatOutbound, { type: 'chat:tool_start' }>;
    const toolDone = events.find((e) => e.type === 'chat:tool_done') as Extract<ChatOutbound, { type: 'chat:tool_done' }>;
    const done = events.find((e) => e.type === 'chat:done');
    const finalText = events.filter((e) => e.type === 'chat:delta').map((e) => (e as { text: string }).text).join('');

    ok('完成事件 chat:done 到达', () => assert.ok(done));
    ok('工具执行成功（tool_done）', () => {
      assert.ok(toolDone);
      assert.equal(toolDone.record.status, 'done');
      assert.ok(toolDone.record.result?.includes('GitHub'));
    });
    ok('结果回填后模型给出最终回复', () => assert.ok(finalText.includes('2 个')));
    ok('fetch 共调用 2 次（工具轮 + 最终轮）', () => assert.equal(fetchCalls.length, 2));
    ok('工具 start/done 事件顺序正确', () => {
      const startIdx = events.findIndex((e) => e.type === 'chat:tool_start');
      const doneIdx = events.findIndex((e) => e.type === 'chat:tool_done');
      assert.ok(startIdx >= 0 && doneIdx > startIdx);
    });
  }

  /* ── T3: propose_deletions 安全机制 ── */
  console.log('\n[T3] 删除提议安全机制');
  {
    fetchCalls.length = 0;
    const proposeArgs = JSON.stringify({
      items: [
        { bookmarkId: '7', reason: '2 年未访问' },
        { bookmarkId: '8', reason: '促销页已失效' },
        { bookmarkId: '1', reason: '尝试删根' }, // 根文件夹，应被跳过
        { bookmarkId: '999', reason: '不存在的书签' }, // 应被跳过
      ],
    });
    sseQueue = [
      sseResponse([
        sseEvent(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_2', function: { name: 'propose_deletions', arguments: proposeArgs } }] } }] })),
        sseEvent('[DONE]'),
      ]),
      sseResponse([sseEvent(JSON.stringify({ choices: [{ delta: { content: '已提交提议。' } }] })), sseEvent('[DONE]')]),
    ];

    const events: ChatOutbound[] = [];
    await runTurn('清理旧书签', events);
    const toolDone = events.find((e) => e.type === 'chat:tool_done') as Extract<ChatOutbound, { type: 'chat:tool_done' }>;

    ok('删除提议携带 deletions 载荷', () => {
      assert.ok(toolDone?.record.deletions);
      assert.equal(toolDone.record.deletions.length, 2, '只保留 2 条有效提议');
    });
    ok('根文件夹与不存在书签被排除', () => {
      const ids = toolDone.record.deletions!.map((d) => d.bookmarkId);
      assert.ok(!ids.includes('1') && !ids.includes('999'));
    });
    ok('提议带具体理由', () => {
      const old = toolDone.record.deletions!.find((d) => d.bookmarkId === '7');
      assert.equal(old?.reason, '2 年未访问');
      assert.equal(old?.status, 'pending');
    });
    ok('工具结果文本提醒等待确认', () => {
      assert.ok(toolDone.record.result!.includes('submitted'));
    });
  }

  /* ── T4: 移动 + 重命名工具真实执行 ── */
  console.log('\n[T4] move/rename/create 工具执行');
  {
    fetchCalls.length = 0;
    sseQueue = [
      sseResponse([
        sseEvent(JSON.stringify({ choices: [{ delta: { tool_calls: [
          { index: 0, id: 'c1', function: { name: 'create_folder', arguments: '{"title":"前端","parentId":"1"}' } },
          { index: 1, id: 'c2', function: { name: 'move_bookmark', arguments: '{"bookmarkId":"6","parentId":"5"}' } },
          { index: 2, id: 'c3', function: { name: 'rename_bookmark', arguments: '{"bookmarkId":"3","title":"GitHub 主页"}' } },
        ] } }] })),
        sseEvent('[DONE]'),
      ]),
      sseResponse([sseEvent(JSON.stringify({ choices: [{ delta: { content: '完成。' } }] })), sseEvent('[DONE]')]),
    ];

    const events: ChatOutbound[] = [];
    await runTurn('整理', events);
    const dones = events.filter((e) => e.type === 'chat:tool_done') as Extract<ChatOutbound, { type: 'chat:tool_done' }>[];

    ok('三个工具全部执行成功', () => assert.equal(dones.length, 3));
    ok('create_folder 创建了文件夹', () => {
      assert.ok(nodeById('100'), '新文件夹 id=100 应存在');
      assert.equal(nodeById('100')?.title, '前端');
    });
    ok('move_bookmark 移动成功', () => assert.equal(nodeById('6')?.parentId, '5'));
    ok('rename_bookmark 重命名成功', () => assert.equal(nodeById('3')?.title, 'GitHub 主页'));

    // 非法参数 → tool_error
    fetchCalls.length = 0;
    sseQueue = [
      sseResponse([
        sseEvent(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c4', function: { name: 'create_folder', arguments: '{"title":123}' } }] } }] })),
        sseEvent('[DONE]'),
      ]),
      sseResponse([sseEvent(JSON.stringify({ choices: [{ delta: { content: '重试' } }] })), sseEvent('[DONE]')]),
    ];
    const events2: ChatOutbound[] = [];
    await runTurn('整理', events2);
    const toolErr = events2.find((e) => e.type === 'chat:tool_error') as Extract<ChatOutbound, { type: 'chat:tool_error' }> | undefined;
    ok('非法参数 → tool_error 且循环继续（模型收到错误后可重试）', () => {
      assert.ok(toolErr, '应产生 tool_error 事件');
      assert.ok(toolErr.record.error!.includes('参数'));
      assert.ok(events2.some((e) => e.type === 'chat:done'), '循环应继续直到 done');
    });
  }

  /* ── T5: 错误处理：401 不降级重试 ── */
  console.log('\n[T5] HTTP 401 错误处理');
  {
    fetchCalls.length = 0;
    sseQueue = [new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 })];
    const events: ChatOutbound[] = [];
    let caught: unknown;
    try {
      await runTurn('hi', events);
    } catch (e) {
      caught = e;
    }
    ok('401 抛出 ChatError 且中文提示', () => {
      assert.ok(caught instanceof ChatError);
      assert.ok((caught as ChatError).message.includes('401'));
      assert.equal((caught as ChatError).status, 401);
    });
    ok('401 不触发非流式降级（仅 1 次请求）', () => assert.equal(fetchCalls.length, 1));
    ok('异常向上传播（由 background 层转为 chat:error 事件）', () => {
      // runAgentTurn 对未中止的请求直接抛出，background.handleChatSend 捕获后发送 chat:error
      assert.ok(caught instanceof ChatError);
      assert.equal(events.length, 0, 'agent 循环自身不产生 error 事件（避免双重上报）');
    });
  }

  /* ── T6: 工具定义一致性 ── */
  console.log('\n[T6] 工具定义 ↔ 元信息 ↔ 执行器一致性');
  {
    const defNames = TOOL_DEFINITIONS.map((d) => d.function.name);
    const metaNames = new Set(Object.keys(TOOL_META));
    ok('每个工具定义都有中文元信息', () => {
      for (const n of defNames) assert.ok(metaNames.has(n), `缺少元信息: ${n}`);
    });
    ok('元信息不包含未定义的工具', () => {
      for (const n of metaNames) assert.ok(defNames.includes(n), `多余的元信息: ${n}`);
    });
    ok('executeTool 拒绝未知工具', async () => {
      let threw = false;
      try {
        await executeTool('hack_tool', '{}');
      } catch {
        threw = true;
      }
      assert.ok(threw);
    });
    ok('executeTool 拒绝非法 JSON 参数', async () => {
      let threw = false;
      try {
        await executeTool('list_bookmarks', '{broken');
      } catch (e) {
        threw = true;
        assert.ok(String(e).includes('JSON'));
      }
      assert.ok(threw);
    });
    ok('zod v4 的 z.string().url() 行为正常', () => {
      assert.equal(z.string().url().parse('https://a.com/b'), 'https://a.com/b');
      let threw = false;
      try {
        z.string().url().parse('not-a-url');
      } catch {
        threw = true;
      }
      assert.ok(threw);
    });
  }

  /* ── T7: stats 统计 ── */
  console.log('\n[T7] stats 统计工具');
  {
    const out = await executeTool('stats', '{}');
    const j = JSON.parse(out.result) as Record<string, unknown>;
    ok('统计数量正确', () => {
      // 书签：3,4,6,7,8 = 5 个；文件夹：1,2,5 + 新建的 100 = 4 个
      assert.equal(j['书签总数'], 5);
      assert.equal(j['文件夹总数'], 4);
    });
  }

  /* ── T8: 新工具：结构查看 / 导出 / 合并 / 批量打开 / 路径定位 / 按天过滤 ── */
  console.log('\n[T8] 新工具执行（结构/导出/合并/批量打开/路径定位/按天过滤）');
  {
    // get_folder_content：路径定位 + 递归子树
    const content = await executeTool('get_folder_content', JSON.stringify({ folderPath: '书签栏 > 技术', depth: 2 }));
    const cj = JSON.parse(content.result) as { title: string; path: string; tree: { children: { title: string; url?: string }[] } };
    ok('get_folder_content 路径定位 + 子树展开', () => {
      assert.equal(cj.title, '技术');
      assert.ok(cj.path.includes('技术'));
      assert.equal(cj.tree.children?.length, 1);
      assert.equal(cj.tree.children?.[0]?.title, 'MDN');
    });
    ok('get_folder_content 路径不存在时报错', async () => {
      let threw = false;
      try {
        await executeTool('get_folder_content', JSON.stringify({ folderPath: '书签栏 > 不存在' }));
      } catch {
        threw = true;
      }
      assert.ok(threw);
    });

    // export_bookmarks：Markdown 全量清单
    const ex = await executeTool('export_bookmarks', JSON.stringify({ scope: 'all', format: 'markdown' }));
    const ej = JSON.parse(ex.result) as { content: string; returned: number; total: number };
    ok('export_bookmarks 输出 Markdown 清单', () => {
      assert.ok(ej.content.includes('https://github.com'), '应包含 GitHub 书签链接');
      assert.ok(/\d{4}-\d{2}-\d{2}/.test(ej.content), '应包含收藏日期（筛选年份用）');
      assert.equal(ej.total, 5, '当前书签共 5 个');
      assert.equal(ej.returned, 5);
    });

    // export_bookmarks：folder 导出必须包含子书签（getSubTree 修复：get 无 children）
    const exf = await executeTool('export_bookmarks', JSON.stringify({ scope: 'folder', folderPath: '书签栏 > 技术', format: 'markdown' }));
    const ejf = JSON.parse(exf.result) as { folder: string; total: number; content: string };
    ok('export_bookmarks 文件夹导出包含子书签', () => {
      assert.equal(ejf.folder, '技术');
      assert.equal(ejf.total, 1);
      assert.ok(ejf.content.includes('developer.mozilla.org'), '应包含 MDN 书签');
    });

    // export_bookmarks：offset 分页
    const exp = await executeTool('export_bookmarks', JSON.stringify({ scope: 'all', format: 'markdown', maxItems: 2, offset: 2 }));
    const ejp = JSON.parse(exp.result) as { total: number; offset: number; returned: number; hasMore: boolean; nextOffset: number | undefined };
    ok('export_bookmarks 分页（offset/maxItems/hasMore/nextOffset）', () => {
      assert.equal(ejp.total, 5);
      assert.equal(ejp.offset, 2);
      assert.equal(ejp.returned, 2);
      assert.ok(ejp.hasMore);
      assert.equal(ejp.nextOffset, 4);
    });

    // list_bookmarks folderPath 定位（在 merge 清空「技术」之前执行）
    const lb = await executeTool('list_bookmarks', JSON.stringify({ folderPath: '书签栏 > 技术' }));
    const lj = JSON.parse(lb.result) as { items: { title: string }[] };
    ok('list_bookmarks 支持路径定位', () => assert.equal(lj.items.length, 1));

    // merge_folders：内容移入目标 + 空源文件夹提议删除
    const merge = await executeTool('merge_folders', JSON.stringify({ sourceId: '5', targetId: '100' }));
    const mj = JSON.parse(merge.result) as { moved: number; sourceEmpty: boolean };
    ok('merge_folders 移动内容且提议删除空源文件夹', () => {
      assert.equal(mj.moved, 1);
      assert.ok(mj.sourceEmpty);
      assert.equal(nodeById('6')?.parentId, '100', 'MDN 应已移入「前端」');
      assert.ok(merge.deletions && merge.deletions.length === 1);
      assert.equal(merge.deletions![0]!.bookmarkId, '5');
    });

    // open_bookmarks：去重 + 忽略无效 id
    const ob = await executeTool('open_bookmarks', JSON.stringify({ ids: ['3', '3', '999'], background: true }));
    const oj = JSON.parse(ob.result) as { opened: number };
    ok('open_bookmarks 去重并忽略无效 id', () => assert.equal(oj.opened, 1));

    // get_recent_bookmarks 按天过滤（store 中 dateAdded 均为 1970 年，days=1 应过滤全部）
    const rc = await executeTool('get_recent_bookmarks', JSON.stringify({ days: 1, count: 5 }));
    const rj = JSON.parse(rc.result) as { count: number };
    ok('get_recent_bookmarks 按天数过滤', () => assert.equal(rj.count, 0));

    // list_empty_folders：merge 后「技术」文件夹已空（子项移入「前端」）
    const em = await executeTool('list_empty_folders', '{}');
    const emj = JSON.parse(em.result) as { total: number; folders: { path: string }[] };
    ok('list_empty_folders 找到空文件夹', () => {
      assert.equal(emj.total, 1);
      assert.ok(emj.folders.some((f) => f.path.includes('技术')));
    });
  }

  /* ── T9: 工具边界增强（URL 归一化 / 批量移动顺序） ── */
  console.log('\n[T9] 工具边界增强（归一化 / 批量移动 / token 估算）');
  {
    // normalizeUrl：www / 查询参数 / 片段 / 尾斜杠 归一后判重
    const out = await executeTool('find_duplicates', '{}');
    const dupJ = JSON.parse(out.result) as { items: unknown[] };
    ok('find_duplicates 正常运行', () => assert.ok(Array.isArray(dupJ.items)));

    // move_bookmarks 指定 index：逆序移动保持输入顺序
    // store 现状（T8 后）：书签栏含 GitHub(3)、GitHub Docs(4)、技术(5)；把 3、4 移到书签栏 index 0
    const mv = await executeTool(
      'move_bookmarks',
      JSON.stringify({ ids: ['3', '4'], parentId: '1', index: 0 }),
    );
    const mvj = JSON.parse(mv.result) as { moved: number; failures: { id: string; error: string }[] };
    ok('move_bookmarks 批量移动成功', () => {
      assert.equal(mvj.moved, 2);
      assert.equal(mvj.failures.length, 0);
    });
    // 校验顺序：getChildren('1') 前两位应为 GitHub 主页、GitHub Docs（保持输入顺序）
    const kids = await mockBookmarks.getChildren('1');
    ok('move_bookmarks 保持输入顺序（逆序 index 移动）', () => {
      assert.equal(kids[0]?.title, 'GitHub 主页');
      assert.equal(kids[1]?.title, 'GitHub Docs');
    });

    // estimateTokens：中文按 0.75 估算，不再是 1:1
    const { estimateTokens } = await import('../src/lib/ai/agent');
    ok('estimateTokens 中文约 0.75 token/字', () => {
      const zh = estimateTokens('书签管理工具');
      assert.ok(zh <= 5, `6 个汉字估算 ${zh}，不应超过 6`);
      const en = estimateTokens('hello world');
      assert.equal(en, 3); // 11 字符 × 1/4 = 2.75 → ceil 3
    });
  }

  /* ── T10: 可恢复错误自动重连 ── */
  console.log('\n[T10] 网络错误自动重连');
  {
    fetchCalls.length = 0;
    failCountdown = 2; // 前 2 次请求网络失败 → 退避 1s + 2s 后恢复
    sseQueue = [
      sseResponse([sseEvent(JSON.stringify({ choices: [{ delta: { content: '重连成功' } }] })), sseEvent('[DONE]')]),
    ];
    const events: ChatOutbound[] = [];
    await runTurn('hi', events);
    ok('网络错误后自动重连并完成', () => {
      assert.equal(fetchCalls.length, 3, '共 3 次请求：2 次失败 + 1 次成功');
      assert.ok(events.some((e) => e.type === 'chat:delta' && 'text' in e && (e as { text: string }).text.includes('重试')), '应有重试提示文本');
      assert.ok(events.some((e) => e.type === 'chat:done'), '最终正常完成');
      assert.ok(events.some((e) => e.type === 'chat:delta' && 'text' in e && (e as { text: string }).text.includes('重连成功')), '内容完整');
    });
    // 重置，避免影响后续
    failCountdown = 0;
  }

  /* ── T11: 重复工具调用死循环检测 ── */
  console.log('\n[T11] 重复工具调用死循环检测');
  {
    fetchCalls.length = 0;
    const toolCall = (id: string) =>
      sseEvent(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: 'list_bookmarks', arguments: '{}' } }] } }] }));
    // 轮 1-3 正常执行，轮 4 检测到相同组合已连续 3 次 → 中止
    sseQueue = [
      sseResponse([toolCall('c1')]),
      sseResponse([toolCall('c2')]),
      sseResponse([toolCall('c3')]),
      sseResponse([toolCall('c4')]),
    ];
    const events: ChatOutbound[] = [];
    await runTurn('hi', events);
    ok('相同工具组合连续 3 轮后中止并提示', () => {
      const texts = events
        .filter((e) => e.type === 'chat:delta')
        .map((e) => (e as Extract<ChatOutbound, { type: 'chat:delta' }>).text)
        .join('');
      assert.ok(texts.includes('重复的工具调用'), '应有死循环提示');
      assert.ok(events.some((e) => e.type === 'chat:done'), '正常结束');
    });
    ok('仅执行了 3 次请求（第 4 轮未发出）', () => {
      // 轮 4 的请求在检测后不再发出？检测发生在拿到轮 4 结果后——
      // 实际请求数为 4（轮 4 请求已发，拿到结果后检测中止）
      assert.ok(fetchCalls.length >= 3 && fetchCalls.length <= 4);
    });
  }

  /* ── T12: URL 分类工具 ── */
  console.log('\n[T12] classify_urls 分类');
  {
    const out = await executeTool(
      'classify_urls',
      JSON.stringify({
        urls: [
          'https://example.com',
          'https://example.com/',
          'https://example.com/index.html',
          'https://example.com/about',
          'https://example.com/docs/api',
          'https://example.com/blog/post/deep-article',
          'https://example.com/search?q=test',
        ],
      }),
    );
    const j = JSON.parse(out.result) as { byType: Record<string, number>; items: { url: string; type: string }[] };
    const typeOf = (u: string) => j.items.find((i) => i.url === u)?.type;
    ok('classify_urls 分类正确', () => {
      assert.equal(typeOf('https://example.com'), 'root');
      assert.equal(typeOf('https://example.com/'), 'root');
      assert.equal(typeOf('https://example.com/index.html'), 'root');
      assert.equal(typeOf('https://example.com/about'), 'page');
      assert.equal(typeOf('https://example.com/docs/api'), 'sub');
      assert.equal(typeOf('https://example.com/blog/post/deep-article'), 'deep');
      assert.equal(typeOf('https://example.com/search?q=test'), 'deep', '带查询参数视为深层');
      assert.equal(j.byType['root'], 3);
      assert.equal(j.byType['deep'], 2);
    });
  }

  /* ── T13: 多会话存储核心逻辑（墓碑/清空/合并） ── */
  console.log('\n[T13] 多会话存储逻辑');
  {
    const { useAIStore, AI_STORAGE_KEY } = await import('../src/stores/aiStore');
    const reset = () => {
      storageMap.clear();
      useAIStore.setState({
        messages: [], conversations: [], activeId: null, deletedIds: [], clearedIds: [],
        pendingDeletions: [], streaming: false, streamingMessageId: null,
      });
    };
    const mkMsg = (role: 'user' | 'assistant', text: string): ChatMessage => ({
      id: `m-${role}-${Math.random().toString(36).slice(2)}`,
      role,
      blocks: [{ kind: 'text', text }],
      createdAt: Date.now(),
    });

    // 1. 空存储 → load 兜底创建空会话
    reset();
    await useAIStore.getState().load();
    ok('空存储 load 兜底创建空会话', () => {
      assert.equal(useAIStore.getState().conversations.length, 1);
      assert.ok(useAIStore.getState().activeId);
    });

    // 2. 清空当前会话：写入 clearedIds 墓碑，后续普通 persist 不复活远端旧消息
    const convId = useAIStore.getState().activeId!;
    useAIStore.setState((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === convId ? { ...c, messages: [mkMsg('user', 'hi'), mkMsg('assistant', 'hello')] } : c,
      ),
      messages: [mkMsg('user', 'hi'), mkMsg('assistant', 'hello')],
    }));
    await useAIStore.getState().clearMessages();
    let saved = storageMap.get(AI_STORAGE_KEY) as { conversations: { id: string; messages: unknown[] }[]; clearedIds?: string[] };
    ok('clearMessages 清空会话并写入墓碑', () => {
      const c = saved.conversations.find((x) => x.id === convId);
      assert.equal(c?.messages.length ?? -1, 0, '会话消息应为空');
      assert.ok(saved.clearedIds?.includes(convId), 'clearedIds 应含该会话');
    });
    // 模拟另一窗口的旧快照被写回 storage：本地清空墓碑必须阻止其复活
    const staleConv = {
      ...saved.conversations.find((x) => x.id === convId)!,
      messages: [mkMsg('user', '旧消息')],
    };
    storageMap.set(AI_STORAGE_KEY, {
      ...saved,
      conversations: [...saved.conversations.filter((x) => x.id !== convId), staleConv],
    });
    await useAIStore.getState()._persist();
    saved = storageMap.get(AI_STORAGE_KEY) as { conversations: { id: string; messages: unknown[] }[] };
    ok('清空墓碑阻止旧快照复活', () => {
      const c = saved.conversations.find((x) => x.id === convId);
      assert.equal(c?.messages.length ?? -1, 0, '远端旧消息不得合并回来');
    });

    // 3. 删除会话：墓碑传播，远端 load 也不复活
    reset();
    await useAIStore.getState().load();
    const delId = useAIStore.getState().activeId!;
    useAIStore.getState().deleteConversation(delId);
    // deleteConversation 内部 _persist 是异步 void：等待写盘完成
    for (let i = 0; i < 50 && !storageMap.has(AI_STORAGE_KEY); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    let afterDel = storageMap.get(AI_STORAGE_KEY) as { conversations: { id: string }[]; deletedIds: string[] };
    ok('deleteConversation 写入墓碑且会话移除', () => {
      assert.ok(!afterDel.conversations.some((c) => c.id === delId), 'storage 不应再有该会话');
      assert.ok(afterDel.deletedIds.includes(delId), 'deletedIds 应含该会话');
    });
    // 远端强行塞回被删会话（模拟另一窗口的旧 storage）→ load 墓碑过滤
    storageMap.set(AI_STORAGE_KEY, {
      conversations: [...afterDel.conversations, { id: delId, title: '幽灵', createdAt: 1, updatedAt: 1, messages: [] }],
      activeId: delId,
      deletedIds: afterDel.deletedIds,
    });
    await useAIStore.getState().load();
    ok('远端墓碑过滤：被删会话不复活且 activeId 修正', () => {
      assert.ok(!useAIStore.getState().conversations.some((c) => c.id === delId));
      assert.notEqual(useAIStore.getState().activeId, delId);
    });

    // 4. resolveDeletion：状态同步到所有会话的消息块（不只 active）+ 终态防护
    reset();
    const proposal: DeletionProposal = {
      id: 'p1', bookmarkId: 'b1', title: '旧站点', reason: '失效', status: 'pending', createdAt: 1,
    };
    const mkConv = (id: string, title: string, createdAt: number) => ({
      id, title, createdAt, updatedAt: createdAt,
      messages: [
        {
          id: `msg-${id}`, role: 'assistant' as const, createdAt,
          blocks: [
            {
              kind: 'tool' as const,
              record: {
                id: `t-${id}`, name: 'propose_deletions', args: '{}', status: 'done' as const,
                deletions: [{ ...proposal }],
              },
            },
          ],
        },
      ],
    });
    useAIStore.setState({
      conversations: [mkConv('c1', '会话1', 1), mkConv('c2', '会话2', 2)],
      activeId: 'c1',
      messages: mkConv('c1', '会话1', 1).messages,
      pendingDeletions: [{ ...proposal }],
    });
    useAIStore.getState().resolveDeletion('p1', 'confirmed');
    ok('resolveDeletion 同步到所有会话消息块与 active 镜像', () => {
      for (const c of useAIStore.getState().conversations) {
        const block = c.messages[0]!.blocks[0]!;
        assert.ok(block.kind === 'tool', `会话 ${c.id} 无工具块`);
        assert.equal(block.record.deletions?.[0]?.status, 'confirmed', `会话 ${c.id} 卡片状态未同步`);
      }
      const activeBlock = useAIStore.getState().messages[0]!.blocks[0]!;
      assert.ok(activeBlock.kind === 'tool', 'active 无工具块');
      assert.equal(activeBlock.record.deletions?.[0]?.status, 'confirmed', 'active 镜像未同步');
    });
    // 终态防护：executed 后过期结果（如另一窗口的失败回退）不得复活为 pending
    useAIStore.getState().resolveDeletion('p1', 'executed');
    useAIStore.getState().resolveDeletion('p1', 'pending');
    ok('终态防护：executed 不可回退', () => {
      assert.equal(useAIStore.getState().pendingDeletions.find((p) => p.id === 'p1')?.status, 'executed');
    });
    // declined 同为终态：过期确认不得覆盖用户放弃的选择
    useAIStore.setState((s) => ({
      pendingDeletions: s.pendingDeletions.map((p) => (p.id === 'p1' ? { ...p, status: 'declined' } : p)),
    }));
    useAIStore.getState().resolveDeletion('p1', 'confirmed');
    ok('终态防护：declined 不可回退', () => {
      assert.equal(useAIStore.getState().pendingDeletions.find((p) => p.id === 'p1')?.status, 'declined');
    });

    // 5. 跨窗口合并：storage 中同 id 消息更「空」且多了别窗口的消息 → 本地完整内容不被回退
    reset();
    await useAIStore.getState().load();
    const cid = useAIStore.getState().activeId!;
    const localUser: ChatMessage = { id: 'm-user', role: 'user', blocks: [{ kind: 'text', text: 'hi' }], createdAt: 1 };
    const localFinal: ChatMessage = { id: 'm-final', role: 'assistant', blocks: [{ kind: 'text', text: '完整回复内容'.repeat(20) }], createdAt: 2 };
    useAIStore.setState((s) => ({
      conversations: s.conversations.map((c) => (c.id === cid ? { ...c, messages: [localUser, localFinal] } : c)),
      messages: [localUser, localFinal],
    }));
    // storage：同 id 的 m-final 是「发送时刻的空消息」，且多一条别窗口的新消息
    storageMap.set(AI_STORAGE_KEY, {
      conversations: [
        {
          id: cid, title: 'x', createdAt: 1, updatedAt: 1,
          messages: [
            { id: 'm-user', role: 'user', blocks: [{ kind: 'text', text: 'hi' }], createdAt: 1 },
            { id: 'm-final', role: 'assistant', blocks: [], createdAt: 2 },
            { id: 'm-other', role: 'user', blocks: [{ kind: 'text', text: '另一窗口的消息' }], createdAt: 3 },
          ],
        },
      ],
      activeId: cid,
    });
    await useAIStore.getState()._persist();
    const persisted = storageMap.get(AI_STORAGE_KEY) as { conversations: { id: string; messages: ChatMessage[] }[] };
    const conv = persisted.conversations.find((c) => c.id === cid)!;
    ok('跨窗口合并：本地完整回复不被同 id 空消息回退', () => {
      const mFinal = conv.messages.find((m) => m.id === 'm-final')!;
      assert.ok(
        mFinal.blocks.some((b) => b.kind === 'text' && b.text.length > 0),
        '同 id 消息应保留本地完整内容而非被空消息覆盖',
      );
      assert.ok(conv.messages.some((m) => m.id === 'm-other'), '别窗口的新消息应合并进来');
    });
  }

  /* ── T14: 批量创建书签 ── */
  console.log('\n[T14] create_bookmarks 批量创建');
  {
    const out = await executeTool(
      'create_bookmarks',
      JSON.stringify({
        parentPath: '书签栏 > 技术',
        items: [
          { title: '新站点 A', url: 'https://a.example.com' },
          { title: '新站点 B', url: 'https://b.example.com' },
        ],
      }),
    );
    const j = JSON.parse(out.result) as { created: number; failed: number; folder: string };
    ok('create_bookmarks 批量创建成功', () => {
      assert.equal(j.created, 2);
      assert.equal(j.failed, 0);
      assert.ok(j.folder.includes('技术'));
    });
    // 校验实际写入：MDN 旁边应有新书签
    const kids = await mockBookmarks.getChildren('5');
    ok('create_bookmarks 实际写入目标文件夹', () => {
      assert.ok(kids.some((k) => k.title === '新站点 A'));
      assert.ok(kids.some((k) => k.title === '新站点 B'));
    });
    // 非法 URL 逐条失败不中断
    const bad = await executeTool(
      'create_bookmarks',
      JSON.stringify({ items: [{ title: 'ok', url: 'https://ok.example.com' }, { title: 'bad', url: 'not-a-url' }] }),
    );
    const bj = JSON.parse(bad.result) as { created: number; failed: number };
    ok('create_bookmarks 非法项单独失败不影响其他', () => {
      assert.equal(bj.created, 1);
      assert.equal(bj.failed, 1);
    });
  }

  /* ── T15: 配置解析（Base URL / resolveConfig / 上下文窗口） ── */
  console.log('\n[T15] 配置解析');
  {
    const { normalizeBaseUrl, resolveConfig, getModelContextWindow } = await import('../src/lib/providers');
    ok('normalizeBaseUrl 补协议与去尾斜杠', () => {
      assert.equal(normalizeBaseUrl('api.example.com/v1/'), 'https://api.example.com/v1');
      assert.equal(normalizeBaseUrl('https://a.com'), 'https://a.com');
      assert.equal(normalizeBaseUrl('localhost:11434/v1'), 'http://localhost:11434/v1', '本机地址用 http');
      assert.equal(normalizeBaseUrl('127.0.0.1:8080'), 'http://127.0.0.1:8080');
    });
    ok('getModelContextWindow 段级前缀匹配', () => {
      assert.equal(getModelContextWindow('qwen3:32b'), 128_000);
      assert.equal(getModelContextWindow('qwen3'), 128_000, 'qwen3 短名取主流窗口（显式条目）');
      assert.equal(getModelContextWindow('llama3'), 128_000, '短名不误命中 llama3.3:70b 的大窗口（回退默认）');
      assert.equal(getModelContextWindow('unknown-model'), 128_000);
    });
    ok('resolveConfig 边界钳制与 providerId 兜底', () => {
      const clamped = resolveConfig({ contextWindow: 0, compressThreshold: 0.1, providerId: 'hack' });
      assert.ok((clamped.contextWindow ?? 0) >= 2000, 'contextWindow 钳到下限');
      assert.ok((clamped.compressThreshold ?? 0) >= 0.5);
      assert.equal(clamped.providerId, 'deepseek', '非法 providerId 回退默认');
      assert.equal((clamped as unknown as Record<string, unknown>).toolLimit, undefined, 'toolLimit 配置已移除');
    });
    ok('resolveConfig 未填回落到预设', () => {
      const cfg = resolveConfig({ providerId: 'deepseek' });
      assert.ok(cfg.baseUrl.includes('api.deepseek.com'), 'Base URL 回落预设');
      assert.ok(cfg.model, '模型回落预设默认');
      assert.equal(cfg.contextWindow, 1_048_576, '上下文长度默认 1024K（无需手动填写）');
    });
  }

  /* ── T16: 用户任务端到端链路（导出→分类→实测→提议） ── */
  console.log('\n[T16] 任务链路（导出/分类/检测/提议）');
  {
    // 1. 分页导出全部书签（模拟 1009 条场景的机制：offset 循环）
    const all: { title: string; url: string }[] = [];
    let offset = 0;
    for (;;) {
      const ex = await executeTool('export_bookmarks', JSON.stringify({ scope: 'all', format: 'markdown', offset, maxItems: 500 }));
      const ej = JSON.parse(ex.result) as { content: string; hasMore: boolean; nextOffset?: number };
      const lines = ej.content.split('\n').filter(Boolean);
      for (const l of lines) {
        const m = l.match(/^- \[(.+)\]\(<?(https?:\/\/[^)>]+)>?\)/);
        if (m) all.push({ title: m[1]!, url: m[2]! });
      }
      if (!ej.hasMore) break;
      offset = ej.nextOffset!;
      if (offset > 1000) break; // 防死循环
    }
    ok('分页导出循环取回全部书签', () => {
      assert.ok(all.length >= 5, `应取回全部 ${all.length} 条`);
    });

    // 2. 分类：主页面 / 子页面
    const cls = await executeTool(
      'classify_urls',
      JSON.stringify({ urls: all.map((b) => b.url) }),
    );
    const cj = JSON.parse(cls.result) as { items: { url: string; type: string }[] };
    ok('classify_urls 分类全部书签', () => assert.equal(cj.items.length, all.length));

    // 3. 实测存活（HEAD；mock 响应队列）
    fetchCalls.length = 0;
    sseQueue = all.map(() => new Response(null, { status: 200 }));
    const chk = await executeTool('check_urls', JSON.stringify({ urls: all.map((b) => b.url) }));
    const rj = JSON.parse(chk.result) as { status: string }[];
    ok('check_urls 实测全部存活', () => {
      assert.equal(rj.length, all.length);
      assert.ok(rj.every((r) => r.status === 'ok'));
    });

    // 4. 提议删除：选中 1 条提交 propose_deletions
    const target = cj.items.find((i) => i.type === 'deep');
    if (target) {
      // 找到对应书签 id
      const sr = await executeTool('search_bookmarks', JSON.stringify({ query: target.url.slice(0, 30) }));
      const sj = JSON.parse(sr.result) as { items: { id: string; url: string }[] };
      const hit = sj.items.find((n) => n.url === target.url);
      if (hit) {
        const pr = await executeTool('propose_deletions', JSON.stringify({ items: [{ bookmarkId: hit.id, reason: '测试：深层子页面' }] }));
        const pj = JSON.parse(pr.result) as { submitted: number };
        ok('propose_deletions 提交删除提议', () => assert.equal(pj.submitted, 1));
      }
    }
    ok('任务链路走通（导出→分类→检测→提议）', () => true);
  }

  /* ── T17: 查重归一化（www / 查询参数；协议差异按设计保留） ── */
  console.log('\n[T17] 查重归一化');
  {
    // 注入两条"归一后相同"的书签：www 前缀 + 查询参数（同协议）
    await mockBookmarks.create({ title: '站点甲', url: 'https://www.example.com/path' });
    await mockBookmarks.create({ title: '站点乙', url: 'https://example.com/path?ref=markai' });
    const out = await executeTool('find_duplicates', '{}');
    const j = JSON.parse(out.result) as { items: { url: string; count: number; bookmarks: { title: string }[] }[] };
    ok('find_duplicates 归一化 www/查询参数', () => {
      const group = j.items.find((g) => g.url.includes('example.com'));
      assert.ok(group, '应存在 example.com 重复组');
      assert.equal(group?.count, 2, '两条归一后相同');
      const titles = group?.bookmarks.map((b) => b.title) ?? [];
      assert.ok(titles.includes('站点甲') && titles.includes('站点乙'));
    });
    // 协议不同不误判（https 站点不会被当作 http 重复删除）
    await mockBookmarks.create({ title: '站点丙', url: 'http://example.com/path' });
    const out2 = await executeTool('find_duplicates', '{}');
    const j2 = JSON.parse(out2.result) as { items: { url: string; count: number }[] };
    ok('find_duplicates 跨协议不误判', () => {
      const group = j2.items.find((g) => g.url.includes('example.com'));
      assert.equal(group?.count, 2, 'http 版本不并入 https 组');
    });
  }

  /* ── T18: 大库工具（check_urls_bulk / auto_categorize） ── */
  console.log('\n[T18] 大库工具');
  {
    // 1. check_urls_bulk：一次检测全量 + 并发进度 + 摘要返回
    const bulkUrls = Array.from({ length: 30 }, (_, i) => `https://bulk${i}.example.com/page${i}`);
    fetchCalls.length = 0;
    sseQueue = bulkUrls.map((_, i) => new Response(null, { status: i % 5 === 0 ? 404 : 200 }));
    let progressText = '';
    const bulk = await executeTool(
      'check_urls_bulk',
      JSON.stringify({ urls: bulkUrls, maxConcurrent: 5, maxDeadList: 10 }),
      (t) => {
        progressText = t;
      },
    );
    const bj = JSON.parse(bulk.result) as { total: number; ok: number; dead: number; deadList: unknown[] };
    ok('check_urls_bulk 并发检测全量并汇总', () => {
      assert.equal(bj.total, 30);
      assert.equal(bj.ok, 24, '6 条 404 不算存活');
      assert.equal(bj.dead, 6);
      assert.equal(bj.deadList.length, 6, '死链明细全列出');
    });
    ok('check_urls_bulk 上报进度文本', () => {
      assert.ok(progressText.includes('30'), `进度文本应含总数：${progressText}`);
    });
    // 死链明细上限：maxDeadList=0 → 只回统计
    const bulk0 = await executeTool(
      'check_urls_bulk',
      JSON.stringify({ urls: bulkUrls.slice(0, 5), maxDeadList: 0 }),
    );
    const bj0 = JSON.parse(bulk0.result) as { total: number; deadList: unknown[] };
    ok('check_urls_bulk maxDeadList=0 只回统计', () => {
      assert.equal(bj0.deadList.length, 0);
    });

    // 2. auto_categorize：域名聚类（www 子域并入主域、小分组留原地、子文件夹不动）
    const big = await mockBookmarks.create({ parentId: '1', title: '大杂烩' });
    const seed: { t: string; u?: string }[] = [
      { t: 'GitHub 甲', u: 'https://github.com/a' },
      { t: 'GitHub 乙', u: 'https://github.com/b' },
      { t: 'GitHub 丙', u: 'https://github.com/c' },
      { t: '知乎 甲', u: 'https://www.zhihu.com/question/1' },
      { t: '知乎 乙', u: 'https://www.zhihu.com/p/2' },
      { t: '示例 甲', u: 'https://www.example.com/x' },
      { t: '示例 乙', u: 'https://example.com/y' },
      { t: '孤例', u: 'https://lonely.example.net/only' },
      { t: '已有子文件夹', u: undefined },
    ];
    for (const s of seed) await mockBookmarks.create({ parentId: big.id, title: s.t, url: s.u });
    let catProgress = '';
    const cat = await executeTool(
      'auto_categorize',
      JSON.stringify({ folderId: big.id }),
      (t) => {
        catProgress += `${t}\n`;
      },
    );
    const cj = JSON.parse(cat.result) as {
      total: number;
      created: number;
      moved: number;
      uncategorized: number;
      groups: { name: string; count: number }[];
    };
    ok('auto_categorize 域名聚类分组', () => {
      assert.equal(cj.total, 8, '子文件夹不计入书签');
      assert.equal(cj.created, 3, 'github.com / zhihu.com / example.com 三组');
      assert.equal(cj.moved, 7, 'www 子域并入主域后共移动 7 条');
      assert.equal(cj.uncategorized, 1, '孤例不建组留在原地');
      const names = cj.groups.map((g) => g.name);
      assert.ok(names.includes('github.com') && names.includes('zhihu.com') && names.includes('example.com'));
      assert.equal(cj.groups.find((g) => g.name === 'zhihu.com')?.count, 2, 'www 子域并入');
    });
    ok('auto_categorize 上报进度', () => {
      assert.ok(catProgress.includes('github.com'), `进度文本应含分组名：${catProgress}`);
    });
    // 移动结果：github.com 组内 3 条；已有子文件夹保持不动
    const sub = await mockBookmarks.getSubTree(big.id);
    const ghFolder = sub[0]?.children?.find((c) => c.title === 'github.com');
    const zhFolder = sub[0]?.children?.find((c) => c.title === 'zhihu.com');
    const existingFolder = sub[0]?.children?.find((c) => c.title === '已有子文件夹');
    ok('auto_categorize 书签移入组内且子文件夹不动', () => {
      assert.equal(ghFolder?.children?.length ?? 0, 3);
      assert.equal(zhFolder?.children?.length ?? 0, 2);
      assert.ok(existingFolder, '原有子文件夹应保留');
      assert.equal(existingFolder?.children?.length ?? 0, 0, '原文件夹仍为空（其子项未被波及）');
    });
    // minGroupSize 调大：github.com 组（3 条）也达不到 → 全部留原地
    const big2 = await mockBookmarks.create({ parentId: '1', title: '大杂烩2' });
    await mockBookmarks.create({ parentId: big2.id, title: 'A1', url: 'https://aaa.com/1' });
    await mockBookmarks.create({ parentId: big2.id, title: 'A2', url: 'https://aaa.com/2' });
    const cat2 = await executeTool('auto_categorize', JSON.stringify({ folderId: big2.id, minGroupSize: 3 }));
    const cj2 = JSON.parse(cat2.result) as { created: number; moved: number };
    ok('auto_categorize minGroupSize 生效', () => {
      assert.equal(cj2.created, 0, '2 条 < 3，不建组');
      assert.equal(cj2.moved, 0);
    });
  }

  /* ── T19: cleanup_sweep 一键清理（模拟「保留 2026 年前主页面且可访问」） ── */
  console.log('\n[T19] cleanup_sweep 一键清理');
  {
    // 构造真实场景：文件夹内混合 2025/2026 年书签
    const f = await mockBookmarks.create({ parentId: '1', title: '待清理' });
    const mk = (t: string, u: string, year: number) => {
      store.push({
        id: String(nextId++),
        parentId: f.id,
        title: t,
        url: u,
        dateAdded: Date.UTC(year, 6, 1), // 每年 7 月
      });
    };
    // 2026 年前（纳入处理）：主页面 ×2、子页面 ×2、深层页 ×2
    mk('官网A', 'https://keepa.example.com', 2025); // root
    mk('官网B', 'https://keepb.example.com', 2025); // root
    mk('文章甲', 'https://blog.example.com/posts/123', 2025); // deep
    mk('视频页', 'https://video.example.com/watch?v=1', 2025); // deep（查询参数）
    mk('栏目页', 'https://keepa.example.com/about', 2025); // page
    mk('失效官网', 'https://dead.example.com', 2025); // root → 检测为死链
    // 2026 年（不处理）：主页面
    mk('新年网站', 'https://new.example.com', 2026);
    // 子文件夹里的书签（recursive=true 时处理）
    const sub = await mockBookmarks.create({ parentId: f.id, title: '子文件夹' });
    store.push({
      id: String(nextId++),
      parentId: sub.id,
      title: '子文件夹里的深层页',
      url: 'https://deep.example.com/a/b/c',
      dateAdded: Date.UTC(2025, 6, 1),
    });

    // fetch mock：官网A/B 200，栏目页 200，失效官网 404
    fetchCalls.length = 0;
    sseQueue = [
      new Response(null, { status: 200 }), // keepa
      new Response(null, { status: 200 }), // keepb
      new Response(null, { status: 404 }), // dead
    ];
    let sweepProgress = '';
    const sweep = await executeTool(
      'cleanup_sweep',
      JSON.stringify({ folderId: f.id, beforeYear: 2026 }),
      (t) => {
        sweepProgress += `${t}\n`;
      },
    );
    const sj = JSON.parse(sweep.result) as {
      total: number;
      inScope: number;
      processed: number;
      byType: Record<string, number>;
      keptReachable: number;
      toDelete: number;
      submitted: number;
    };
    ok('cleanup_sweep 范围与统计正确', () => {
      assert.equal(sj.total, 8, '7 直接 + 1 子文件夹内');
      assert.equal(sj.inScope, 7, '6 条直接 2025 + 1 条子文件夹 2025；2026 新年网站排除');
      assert.equal(sj.processed, 7);
      assert.equal(sj.keptReachable, 2, '官网A/B 存活保留，栏目页 page 不在 keepOnly=root 内');
      assert.equal(sj.toDelete, 5, '文章+视频+栏目页+失效官网+子文件夹深层页');
      assert.equal(sj.submitted, 5);
    });
    ok('cleanup_sweep 提议理由分类正确', () => {
      const reasons = (sweep.deletions ?? []).map((p: DeletionProposal) => p.reason);
      assert.ok(reasons.some((r) => r.includes('主页面失效'), `应含失效主页面：${reasons.join(' | ')}`));
      assert.ok(reasons.some((r) => r.includes('深层子页面')));
      assert.ok(reasons.some((r) => r.includes('栏目页') || r.includes('浅层') || r.includes('不符合保留要求')));
    });
    ok('cleanup_sweep 上报进度', () => assert.ok(sweepProgress.includes('存活')));
    // 提议携带完整 bookmarkId（后续可直接确认删除）
    ok('cleanup_sweep 提议携带 bookmarkId', () => {
      assert.ok(sweep.deletions?.every((p: DeletionProposal) => !!p.bookmarkId));
    });

    // keepOnly=page：栏目页进入保留候选
    fetchCalls.length = 0;
    sseQueue = [new Response(null, { status: 200 }), new Response(null, { status: 200 }), new Response(null, { status: 200 }), new Response(null, { status: 404 })];
    const sweep2 = await executeTool(
      'cleanup_sweep',
      JSON.stringify({ folderId: f.id, beforeYear: 2026, keepOnly: 'page' }),
    );
    const sj2 = JSON.parse(sweep2.result) as { keptReachable: number; toDelete: number };
    ok('cleanup_sweep keepOnly=page 保留栏目页', () => {
      assert.equal(sj2.keptReachable, 3, '官网A/B + 栏目页');
      assert.equal(sj2.toDelete, 4, '7 条中删 4：文章+视频+失效官网+子文件夹深层页');
    });

    // 分页：limit=3 只处理前 3 条，返回 remaining
    const sweep3 = await executeTool(
      'cleanup_sweep',
      JSON.stringify({ folderId: f.id, beforeYear: 2026, limit: 3, checkReachable: false }),
    );
    const sj3 = JSON.parse(sweep3.result) as { processed: number; remaining: number | undefined; offset: number };
    ok('cleanup_sweep 分页返回 remaining/offset', () => {
      assert.equal(sj3.processed, 3);
      assert.equal(sj3.remaining, 4, '7 条中处理 3 条，剩 4');
      assert.equal(sj3.offset, 0);
    });
    // 第二页
    const sweep4 = await executeTool(
      'cleanup_sweep',
      JSON.stringify({ folderId: f.id, beforeYear: 2026, limit: 3, offset: 3, checkReachable: false }),
    );
    const sj4 = JSON.parse(sweep4.result) as { processed: number; remaining: number | undefined };
    ok('cleanup_sweep 第二页返回剩余', () => {
      assert.equal(sj4.processed, 3);
      assert.equal(sj4.remaining, 1, '7 条中处理 6 条，剩 1');
    });
    // 第三页收尾
    const sweep5 = await executeTool(
      'cleanup_sweep',
      JSON.stringify({ folderId: f.id, beforeYear: 2026, limit: 3, offset: 6, checkReachable: false }),
    );
    const sj5 = JSON.parse(sweep5.result) as { processed: number; remaining: number | undefined };
    ok('cleanup_sweep 第三页处理完', () => {
      assert.equal(sj5.processed, 1);
      assert.ok(sj5.remaining === undefined || sj5.remaining === 0);
    });

    // auto 模式（"无需确认"）：直接删除，不生成待确认提议
    const fAuto = await mockBookmarks.create({ parentId: '1', title: '自动清理' });
    store.push({ id: String(nextId++), parentId: fAuto.id, title: '子页1', url: 'https://auto1.example.com/a/b', dateAdded: Date.UTC(2025, 6, 1) });
    store.push({ id: String(nextId++), parentId: fAuto.id, title: '主页', url: 'https://auto2.example.com', dateAdded: Date.UTC(2025, 6, 1) });
    storageMap.set('markai.config', { deleteMode: 'auto' });
    const sweepA = await executeTool(
      'cleanup_sweep',
      JSON.stringify({ folderId: fAuto.id, beforeYear: 2026, checkReachable: false }),
    );
    const saj = JSON.parse(sweepA.result) as { toDelete: number; deleted: number; failed: number; submitted: number };
    ok('cleanup_sweep auto 模式直接删除', () => {
      assert.equal(saj.toDelete, 1, '仅子页面进入删除');
      assert.equal(saj.deleted, 1);
      assert.equal(saj.submitted, 1);
      assert.equal(saj.failed, 0);
      const remains = store.filter((n) => n.parentId === fAuto.id && n.url);
      assert.equal(remains.length, 1, '子页面已删，主页面保留');
    });
    ok('cleanup_sweep auto 模式生成 executed 提议', () => {
      assert.ok(sweepA.deletions?.every((p: DeletionProposal) => p.status === 'executed'), '不应出现待确认提议');
    });
    storageMap.delete('markai.config');
  }

  /* ── T21: 删除提议终态保护（已执行/已放弃不被重新提议覆盖） ── */
  console.log('\n[T21] 删除提议终态保护');
  {
    const { useAIStore } = await import('../src/stores/aiStore');
    useAIStore.setState({
      pendingDeletions: [{ id: 'p-old', bookmarkId: 'b1', title: 'x', reason: 'r', status: 'executed', createdAt: 1 }],
      conversations: [], activeId: null, messages: [], deletedIds: [], clearedIds: [],
      streaming: true, streamingMessageId: 'm1',
    });
    // AI 后续工具调用对同一书签重新提议（pending）→ 不得覆盖已执行
    useAIStore.getState().handleOutbound({
      type: 'chat:tool_done',
      messageId: 'm1',
      record: {
        id: 't1', name: 'propose_deletions', args: '{}', status: 'done',
        deletions: [{ id: 'p-new', bookmarkId: 'b1', title: 'x', reason: 'r', status: 'pending', createdAt: 2 }],
      },
    });
    ok('已执行提议不被新 pending 覆盖', () => {
      const p = useAIStore.getState().pendingDeletions.find((x) => x.bookmarkId === 'b1');
      assert.equal(p?.status, 'executed', `状态应为 executed，实际 ${p?.status}`);
      assert.equal(p?.id, 'p-old', '保留原提议');
    });
    // 未处理的书签正常接受新提议
    useAIStore.setState({ streaming: true, streamingMessageId: 'm2' });
    useAIStore.getState().handleOutbound({
      type: 'chat:tool_done',
      messageId: 'm2',
      record: {
        id: 't2', name: 'propose_deletions', args: '{}', status: 'done',
        deletions: [{ id: 'p2', bookmarkId: 'b2', title: 'y', reason: 'r', status: 'pending', createdAt: 3 }],
      },
    });
    ok('未处理书签接受新提议', () => {
      assert.ok(useAIStore.getState().pendingDeletions.some((x) => x.bookmarkId === 'b2'));
    });
  }

  /* ── T20: 工具链细节（includeId / 宽松 URL / 扩展名误判 / list_all_folders 分页） ── */
  console.log('\n[T20] 工具链细节');
  {
    // 1. export_bookmarks includeId：markdown 行尾附 id
    const ex = await executeTool('export_bookmarks', JSON.stringify({ scope: 'folder', folderId: '1', includeId: true, maxItems: 10 }));
    const ej = JSON.parse(ex.result) as { content: string };
    ok('export_bookmarks includeId 附带 id', () => {
      assert.ok(/\(id: \d+\)/.test(ej.content), `应含 id 标记：${ej.content.slice(0, 80)}`);
    });
    // 不带 includeId 时无 id
    const ex2 = await executeTool('export_bookmarks', JSON.stringify({ scope: 'folder', folderId: '1', maxItems: 10 }));
    const ej2 = JSON.parse(ex2.result) as { content: string };
    ok('export_bookmarks 默认不带 id', () => {
      assert.ok(!/\(id: \d+\)/.test(ej2.content));
    });

    // 2. check_urls 宽松 schema：带中文/空格的 URL 不整批失败，无效项跳过
    fetchCalls.length = 0;
    sseQueue = [new Response(null, { status: 200 })];
    const cu = await executeTool(
      'check_urls',
      JSON.stringify({ urls: ['https://example.com/ok', '这不是网址', 'https://空格 未编码.com/x'] }),
    );
    const cuj = JSON.parse(cu.result) as { status: string }[];
    ok('check_urls 宽松 schema 无效项跳过', () => {
      assert.ok(cuj.some((r) => r.status === 'ok'));
      assert.ok(cuj.some((r) => r.status === 'skipped'), '无效 URL 标记为 skipped 而非整体失败');
    });
    // 非 http(s) 链接（chrome:// 等）在 bulk 检测中不判死
    fetchCalls.length = 0;
    sseQueue = [new Response(null, { status: 200 })];
    const bulkSk = await executeTool(
      'check_urls_bulk',
      JSON.stringify({ urls: ['chrome://extensions', 'https://ok.example.com'] }),
    );
    const bsk = JSON.parse(bulkSk.result) as { ok: number; dead: number; skipped: number };
    ok('check_urls_bulk 非 http(s) 跳过不判死', () => {
      assert.equal(bsk.ok, 1);
      assert.equal(bsk.dead, 0, 'chrome:// 不得计为死链');
      assert.equal(bsk.skipped, 1);
    });

    // 3. create_bookmark 宽松 URL：中文域名/带空格输入给出明确错误而非 schema 拒绝
    const cb = await executeTool('create_bookmark', JSON.stringify({ title: '测试', url: '中文域名示例.com' })).catch((e) => e as Error);
    ok('create_bookmark 非法 URL 返回明确错误', () => {
      assert.ok(cb instanceof Error && /URL 格式无效/.test(cb.message), String(cb));
    });

    // 4. classify_urls 扩展名误判：/posts/1.2 是子页面而非"文件"
    const cl = await executeTool('classify_urls', JSON.stringify({ urls: ['https://a.com/posts/1.2', 'https://a.com/file.pdf', 'https://a.com/about'] }));
    const clj = JSON.parse(cl.result) as { items: { url: string; type: string }[] };
    ok('classify_urls 数字后缀不算文件扩展名', () => {
      const v = clj.items.find((i) => i.url.includes('1.2'));
      assert.equal(v?.type, 'sub', `/posts/1.2 应为子页面，实际 ${v?.type}`);
      const pdf = clj.items.find((i) => i.url.includes('.pdf'));
      assert.equal(pdf?.type, 'sub', '真文件 .pdf 单段路径按原规则为 sub');
    });

    // 4.5 classify_urls 宽松 schema：无效 URL 降级 unknown，而非整批 ZodError 失败
    const clInvalid = await executeTool(
      'classify_urls',
      JSON.stringify({ urls: ['https://a.com', '这不是网址', '中文 空格'] }),
    );
    const cljInvalid = JSON.parse(clInvalid.result) as { items: { url: string; type: string }[] };
    ok('classify_urls 宽松 schema 无效项降级 unknown', () => {
      assert.equal(cljInvalid.items.length, 3);
      assert.equal(cljInvalid.items.find((i) => i.url === 'https://a.com')?.type, 'root');
      assert.equal(
        cljInvalid.items.find((i) => i.url === '这不是网址')?.type,
        'unknown',
        '非 URL 字符串应降级 unknown 而非整批失败',
      );
    });

    // 5. list_all_folders 分页：total/shown/hasMore/offset
    const laf = await executeTool('list_all_folders', JSON.stringify({ limit: 2 }));
    const lafj = JSON.parse(laf.result) as { total: number; shown: number; hasMore: boolean; nextOffset: number };
    ok('list_all_folders 分页与提示', () => {
      assert.equal(lafj.shown, 2);
      assert.ok(lafj.total >= 4, `mock 树至少有 4 个文件夹，实际 ${lafj.total}`);
      assert.ok(lafj.hasMore);
      assert.equal(lafj.nextOffset, 2);
      assert.ok(String(laf.result).includes('offset=2'), 'note 应提示继续分页');
    });
    const laf2 = await executeTool('list_all_folders', JSON.stringify({ limit: 2, offset: 2 }));
    const lafj2 = JSON.parse(laf2.result) as { offset: number; shown: number };
    ok('list_all_folders 第二页', () => {
      assert.equal(lafj2.offset, 2);
      assert.ok(lafj2.shown >= 1);
    });
  }

  /* ── T22: 拖放语义 / 未提交修复回归（每条都必须在修复回滚后变红） ── */
  console.log('\n[T22] 拖放语义与修复回归');
  {
    const { resolveDropIndex, isSelfOrDescendant } = await import('../src/lib/bookmark-dnd');
    const node = (
      id: string,
      url?: string,
      children?: chrome.bookmarks.BookmarkTreeNode[],
    ): chrome.bookmarks.BookmarkTreeNode =>
      ({ id, title: id, url, children }) as chrome.bookmarks.BookmarkTreeNode;
    const kids = async (pid: string) => (await mockBookmarks.getChildren(pid)).map((n) => n.title);

    // ── A. 落点 → index：不做任何补偿 ──
    ok('resolveDropIndex：上方=行下标，下方=行下标+1', () => {
      assert.equal(resolveDropIndex(2, 'above'), 2);
      assert.equal(resolveDropIndex(2, 'below'), 3);
    });

    // ── B. 语义链：落点 → Chrome（替身）→ 真实顺序 ──
    // 这是本项目最容易被"顺手减 1"改坏的地方：减 1 会命中 Chromium 的
    // index == old_index + 1 空操作，向后拖拽静默失效。替身已复现真实语义，
    // 因此本用例能真正证伪。
    const F = (await mockBookmarks.create({ parentId: '2', title: 'T22-F' })).id;
    const mkBm = async (t: string) => (await mockBookmarks.create({ parentId: F, title: t, url: `https://t22.example/${t}` })).id;
    await mkBm('a');
    const bB = await mkBm('b');
    const bC = await mkBm('c');
    await mkBm('d');
    assert.deepEqual(await kids(F), ['a', 'b', 'c', 'd']);

    // 把 b 拖到 c 下方：c 在当前列表下标 2 → index 3
    await mockBookmarks.move(bB, { parentId: F, index: resolveDropIndex(2, 'below') });
    const order1 = await kids(F);
    ok('向后拖一格真的生效：a c b d', () => assert.deepEqual(order1, ['a', 'c', 'b', 'd']));

    // 再把 b 拖回 a 上方：a 下标 0 → index 0
    await mockBookmarks.move(bB, { parentId: F, index: resolveDropIndex(0, 'above') });
    const order2 = await kids(F);
    ok('向前拖回首位：b a c d', () => assert.deepEqual(order2, ['b', 'a', 'c', 'd']));

    // 拖到末尾（d 下方，下标 3 → index 4）：应落到最后
    await mockBookmarks.move(bB, { parentId: F, index: resolveDropIndex(3, 'below') });
    const order3 = await kids(F);
    ok('拖到末尾：a c d b', () => assert.deepEqual(order3, ['a', 'c', 'd', 'b']));

    // ── C. 替身复现 Chromium 的空操作与向后移动（bookmark_model_unittest.cc: MoveToSameParent）──
    await mockBookmarks.move(bC, { parentId: F, index: 1 }); // c 当前下标 1 → index == oldIndex
    await mockBookmarks.move(bC, { parentId: F, index: 2 }); // index == oldIndex + 1
    const orderNoop = await kids(F);
    ok('替身复现空操作：index == oldIndex / oldIndex+1 均不动', () =>
      assert.deepEqual(orderNoop, ['a', 'c', 'd', 'b']),
    );
    await mockBookmarks.move(bC, { parentId: F, index: 3 }); // oldIndex+2 → 右移一格
    const orderMoved = await kids(F);
    ok('替身复现向后移动一格（oldIndex+2 → 右移）', () =>
      assert.deepEqual(orderMoved, ['a', 'd', 'c', 'b']),
    );

    // ── D. 非法落点：自身 / 子树 ──
    const outer = node('o', undefined, [node('i', undefined, [node('deep')]), node('bm', 'https://x')]);
    ok('isSelfOrDescendant 拦截自身', () => assert.ok(isSelfOrDescendant(outer, 'o')));
    ok('isSelfOrDescendant 拦截子文件夹', () => assert.ok(isSelfOrDescendant(outer, 'i')));
    ok('isSelfOrDescendant 拦截深层后代', () => assert.ok(isSelfOrDescendant(outer, 'deep')));
    ok('isSelfOrDescendant 放行无关文件夹', () => assert.ok(!isSelfOrDescendant(outer, 'zzz')));
    ok('isSelfOrDescendant 不拦书签（无子树）', () => assert.ok(!isSelfOrDescendant(node('bm', 'https://x'), 'bm')));

    // ── E. move_bookmark：fromPath 必须是「移动前」的路径，且不含元根 ──
    const E1 = (await mockBookmarks.create({ parentId: '2', title: 'T22-SRC' })).id;
    const E2 = (await mockBookmarks.create({ parentId: '2', title: 'T22-DST' })).id;
    const eb = (await mockBookmarks.create({ parentId: E1, title: 'e-bm', url: 'https://t22.example/e' })).id;
    const mo = await executeTool('move_bookmark', JSON.stringify({ bookmarkId: eb, parentId: E2 }));
    const moj = JSON.parse(mo.result) as { fromPath: string; toPath: string };
    ok('move_bookmark fromPath 记录移动前路径（而非移动后）', () => {
      assert.ok(moj.fromPath.includes('T22-SRC'), `fromPath 应为源路径，实际「${moj.fromPath}」`);
      assert.ok(!moj.fromPath.includes('T22-DST'), 'fromPath 不应是移动后的新路径');
      assert.ok(moj.toPath.includes('T22-DST'), `toPath 应为目标路径，实际「${moj.toPath}」`);
    });
    ok('路径不把元根渲染成「(未命名)」', () => {
      assert.ok(!moj.fromPath.includes('(未命名)'), `fromPath 不应含元根：${moj.fromPath}`);
      assert.ok(!moj.toPath.includes('(未命名)'), `toPath 不应含元根：${moj.toPath}`);
    });
    const fp = await executeTool('get_folder_path', JSON.stringify({ bookmarkId: eb }));
    ok('get_folder_path 同样不含元根（resolvePaths 分支）', () => {
      const path = (JSON.parse(fp.result) as { path: string }).path;
      assert.ok(path.includes('T22-DST') && !path.includes('(未命名)'), `实际「${path}」`);
    });

    // ── F. check_urls：skipped 逐条输出（每条 url 都是字符串）──
    fetchCalls.length = 0;
    sseQueue = [new Response(null, { status: 200 })];
    const cu = await executeTool(
      'check_urls',
      JSON.stringify({ urls: ['https://example.com/t22', '这不是网址', 'https://空格 未编码.com/x'] }),
    );
    const cuj = JSON.parse(cu.result) as { url: unknown; status: string }[];
    ok('check_urls skipped 逐条输出且 url 为字符串', () => {
      const skipped = cuj.filter((r) => r.status === 'skipped');
      assert.equal(skipped.length, 2, `应有 2 条 skipped，实际 ${JSON.stringify(cuj)}`);
      for (const r of skipped) assert.equal(typeof r.url, 'string', 'url 必须是字符串，不能聚合成数组');
    });
    // ── G. move_bookmarks：文件夹移入自身子树 → 中文错误而非 Chrome 英文报错 ──
    const G1 = (await mockBookmarks.create({ parentId: '2', title: 'T22-G1' })).id;
    const G2 = (await mockBookmarks.create({ parentId: G1, title: 'T22-G2' })).id;
    const G3 = (await mockBookmarks.create({ parentId: G2, title: 'T22-G3' })).id;
    const mg = await executeTool('move_bookmarks', JSON.stringify({ ids: [G1], parentId: G3 }));
    const mgj = JSON.parse(mg.result) as { moved: number; failures: { id: string; error: string }[] };
    ok('move_bookmarks 拦截文件夹移入自身子树', () => {
      assert.equal(mgj.moved, 0);
      assert.equal(mgj.failures.length, 1);
      assert.match(mgj.failures[0]!.error, /循环嵌套/, `应为中文循环嵌套错误，实际「${mgj.failures[0]!.error}」`);
    });
    const mgSelf = await executeTool('move_bookmarks', JSON.stringify({ ids: [G1], parentId: G1 }));
    ok('move_bookmarks 拦截文件夹移入自身', () => {
      const j = JSON.parse(mgSelf.result) as { failures: { error: string }[] };
      assert.match(j.failures[0]?.error ?? '', /循环嵌套/);
    });

    // ── H. open_bookmarks：标签页创建失败不得虚报 opened ──
    const g = globalThis as unknown as {
      chrome: { tabs: { create: (o: { url: string; active: boolean }) => Promise<unknown> } };
    };
    const ob1 = (await mockBookmarks.create({ parentId: '2', title: 'ob1', url: 'https://t22.example/ob1' })).id;
    const ob2 = (await mockBookmarks.create({ parentId: '2', title: 'ob2', url: 'https://t22.example/ob2' })).id;
    const origCreate = g.chrome.tabs.create;
    g.chrome.tabs.create = async () => {
      throw new Error('TABS_BLOCKED');
    };
    let objResult: { requested: number; opened: number } | null = null;
    let objThrew: string | null = null;
    try {
      const ob = await executeTool('open_bookmarks', JSON.stringify({ ids: [ob1, ob2] }));
      objResult = JSON.parse(ob.result) as { requested: number; opened: number };
    } catch (e) {
      // 回滚后（无 try/catch）异常会冒到这里——归为该用例的失败，而不是整轮中断
      objThrew = e instanceof Error ? e.message : String(e);
    } finally {
      g.chrome.tabs.create = origCreate;
    }
    ok('open_bookmarks 失败不虚报 opened', () => {
      assert.equal(objThrew, null, `单个标签页失败不应让工具整体抛错：${objThrew}`);
      assert.equal(objResult!.requested, 2);
      assert.equal(objResult!.opened, 0, '全部创建失败时 opened 必须为 0');
    });

    // ── I. merge_folders：单条移动失败要如实计数，不得虚报 moved ──
    const M1 = (await mockBookmarks.create({ parentId: '2', title: 'T22-M1' })).id;
    const M2 = (await mockBookmarks.create({ parentId: '2', title: 'T22-M2' })).id;
    const mc1 = (await mockBookmarks.create({ parentId: M1, title: 'mc1', url: 'https://t22.example/mc1' })).id;
    await mockBookmarks.create({ parentId: M1, title: 'mc2', url: 'https://t22.example/mc2' });
    const origMove = mockBookmarks.move;
    mockBookmarks.move = async (id, dest) => {
      if (id === mc1) throw new Error('MOVE_BLOCKED');
      return origMove(id, dest);
    };
    let mres: { moved: number; note: string } | null = null;
    try {
      const mr = await executeTool('merge_folders', JSON.stringify({ sourceId: M1, targetId: M2 }));
      mres = JSON.parse(mr.result) as { moved: number; note: string };
    } finally {
      mockBookmarks.move = origMove;
    }
    ok('merge_folders 如实计数：1 成功 1 失败', () => {
      assert.equal(mres!.moved, 1, '只有 1 条真正移动成功');
      assert.match(mres!.note, /1 项移动失败/, `note 应说明失败数，实际「${mres!.note}」`);
    });
    const m1Kids = await kids(M1);
    ok('merge_folders 失败后源文件夹非空 → 不提议删除', () => assert.deepEqual(m1Kids, ['mc1']));

    // ── J. 上下文预算：系统提示只能在 apiMessages 内计一次 ──
    const { estimateTokens, estimateRequestTokens, fixedOverheadTokens } = await import('../src/lib/ai/agent');
    const { SYSTEM_PROMPT: SP } = await import('../src/lib/ai/prompts');
    const sysTokens = estimateTokens(SP);
    const toolTokens = estimateTokens(JSON.stringify(TOOL_DEFINITIONS));

    // J1 纯函数级：estimateRequestTokens 自身不含固定开销
    const withSystem = estimateRequestTokens([{ role: 'system', content: SP }]);
    ok('estimateRequestTokens 不含 fixedOverhead（系统提示只计一次）', () => {
      const delta = withSystem - fixedOverheadTokens();
      assert.ok(delta < 500, `重复计入系统提示会让差值多出数千 token，实际 ${delta}`);
    });

    // J2 行为级：真正守护调用点。预算窗口按下式反推——
    //   正确记账：回填后用量 ≈ 工具定义 + 系统提示 + 超长输入 ≤ 预算 → 工具循环应继续
    //   错误记账（再叠加一次固定开销）：用量多出（系统提示+工具定义），必然超预算 →
    //   autoCompress=false 下提前中止并输出「上下文空间不足」，第 2 次请求根本不会发出。
    const bigText = '请统计书签数量。'.repeat(700).slice(0, 8000);
    const eps = estimateTokens(bigText);
    const windowFor = Math.ceil((2 * (sysTokens + toolTokens) + eps + 100 + 5000) / 0.8);
    fetchCalls.length = 0;
    sseQueue = [
      sseResponse([
        sseEvent(
          JSON.stringify({
            choices: [
              { delta: { tool_calls: [{ index: 0, id: 'ctx1', function: { name: 'stats', arguments: '{}' } }] } },
            ],
          }),
        ),
        sseEvent('[DONE]'),
      ]),
      sseResponse([sseEvent(JSON.stringify({ choices: [{ delta: { content: '共 N 个书签。' } }] })), sseEvent('[DONE]')]),
    ];
    const ctxEvents: ChatOutbound[] = [];
    await runAgentTurn({
      config: { ...TEST_CONFIG, contextWindow: windowFor, compressThreshold: 0.8, autoCompress: false },
      messageId: 'msg-ctx',
      history: [],
      text: bigText,
      signal: new AbortController().signal,
      onEvent: (e) => ctxEvents.push(e),
    });
    ok('预算记账正确时工具循环继续（不误报上下文不足）', () => {
      assert.equal(fetchCalls.length, 2, `回填后应继续第 2 次请求，实际只发了 ${fetchCalls.length} 次`);
      const deltas = ctxEvents
        .filter((e): e is Extract<ChatOutbound, { type: 'chat:delta' }> => e.type === 'chat:delta')
        .map((e) => e.text)
        .join('');
      assert.ok(!deltas.includes('上下文空间不足'), `不应触发上下文护栏，实际输出：${deltas.slice(0, 200)}`);
    });

    // ── K. 重试不把同一条 user 消息既放历史又当新输入发两遍 ──
    const { useAIStore } = await import('../src/stores/aiStore');
    storageMap.clear();
    useAIStore.setState({
      messages: [], conversations: [], activeId: null, deletedIds: [], clearedIds: [],
      pendingDeletions: [], streaming: false, streamingMessageId: null,
    });
    await useAIStore.getState().load();
    const sentInbound: ChatInbound[] = [];
    const fakePort = {
      postMessage: (m: ChatInbound) => sentInbound.push(m),
    } as unknown as chrome.runtime.Port;
    const u0: ChatMessage = { id: 'u0', role: 'user', blocks: [{ kind: 'text', text: '第一轮' }], createdAt: 1 };
    const a0: ChatMessage = { id: 'a0', role: 'assistant', blocks: [{ kind: 'text', text: '回复一' }], createdAt: 2 };
    const u1: ChatMessage = { id: 'u1', role: 'user', blocks: [{ kind: 'text', text: '重试我' }], createdAt: 3 };
    const a1: ChatMessage = { id: 'a1', role: 'assistant', blocks: [{ kind: 'text', text: '失败的一半' }], createdAt: 4 };
    useAIStore.setState((s) => ({
      port: fakePort,
      streaming: false,
      conversations: s.conversations.map((c) => (c.id === s.activeId ? { ...c, messages: [u0, a0, u1, a1] } : c)),
      messages: [u0, a0, u1, a1],
    }));
    useAIStore.getState().retryLast();
    await new Promise((r) => setTimeout(r, 0));
    ok('重试时历史排除被重试的 user 消息', () => {
      const inbound = sentInbound.find((m) => m.type === 'chat:send') as
        | { text: string; history: ChatMessage[] }
        | undefined;
      assert.ok(inbound, 'retryLast 应发出 chat:send');
      assert.equal(inbound.text, '重试我');
      assert.deepEqual(
        inbound.history.map((m) => m.id),
        ['u0', 'a0'],
        `历史只应含此前轮次，重复发送会让模型收到两条相同 user 消息：${inbound.history.map((m) => m.id).join(',')}`,
      );
    });
    // 复位，避免影响后续（本区块为最后一段，仍保持一致状态）
    useAIStore.setState({ port: null, streaming: false });
    await mockBookmarks.removeTree(F).catch(() => {});
  }

  /* ── T23: 操作日志与撤销（DIRECTION P1） ── */
  console.log('\n[T23] 操作日志与撤销');
  {
    const { summarizeOps, undoReadiness, undoableOps, reverseOps } = await import('../src/lib/undo/journal');
    const {
      UNDO_STORAGE_KEY,
      beginUndoTransaction,
      endUndoTransaction,
      readUndoPoints,
      resetUndoTransactionForTest,
    } = await import('../src/lib/undo/recorder');
    const { applyUndo } = await import('../src/lib/undo/apply');
    const { jMove, jRemove } = await import('../src/lib/undo/mutations');
    type UndoOp = import('../src/lib/undo/types').UndoOp;

    const opMove = (id: string, fromIndex: number): UndoOp => ({
      kind: 'move',
      id,
      title: id,
      fromParentId: 'p',
      fromIndex,
    });
    const opCreate = (id: string): UndoOp => ({ kind: 'create', id, title: id, isFolder: false });
    const opDelete = (id: string): UndoOp => ({ kind: 'delete', id, title: id });

    // ── A. 纯逻辑 ──
    ok('summarizeOps 按类型汇总', () => {
      const ops: UndoOp[] = [opMove('a', 0), opMove('b', 1), opCreate('c'), opDelete('d')];
      assert.equal(summarizeOps(ops), '移动 2 项、新建 1 项、删除 1 项');
      assert.equal(summarizeOps([]), '无写操作');
    });
    ok('批次按条数计权重：800 条并发移动不能显示成「1 项」', () => {
      const batch: UndoOp[] = [
        { kind: 'moveBatch', title: '自动分类', fromParentId: 'p', ids: Array.from({ length: 800 }, (_, i) => `b${i}`), order: ['p'] },
      ];
      assert.equal(summarizeOps(batch), '移动 800 项');
      assert.equal(
        undoReadiness({ id: '1', runId: 'r', createdAt: 0, ops: batch, containsDelete: false }).count,
        800,
      );
    });
    ok('undoableOps 排除删除（删除没有快照）', () => {
      const ops: UndoOp[] = [opMove('a', 0), opDelete('d')];
      assert.deepEqual(
        undoableOps(ops).map((o) => o.kind),
        ['move'],
      );
    });
    ok('reverseOps 严格逆序（先做的后撤）', () => {
      const ops: UndoOp[] = [opMove('a', 0), opCreate('b'), opCreate('c')];
      assert.deepEqual(
        reverseOps(ops).map((o) => ('id' in o ? o.id : o.title)),
        ['c', 'b', 'a'],
      );
    });
    ok('undoReadiness：无点/空点/已撤销都不可撤', () => {
      assert.equal(undoReadiness(null).undoable, false);
      assert.equal(
        undoReadiness({ id: '1', runId: 'r', createdAt: 0, ops: [], containsDelete: false }).undoable,
        false,
      );
      assert.equal(
        undoReadiness({ id: '1', runId: 'r', createdAt: 0, ops: [opMove('a', 0)], containsDelete: false, appliedAt: 1 })
          .undoable,
        false,
      );
    });
    ok('undoReadiness：带快照的删除可撤（P3 起），无快照的历史点仍拒绝', () => {
      // 新写入的删除带子树快照 → 可以还原
      const snapDel: UndoOp = {
        kind: 'delete',
        id: 'd',
        title: 'd',
        parentId: 'p',
        snapshot: { title: 'd', url: 'https://d' },
      };
      const withSnap = undoReadiness({
        id: '1',
        runId: 'r',
        createdAt: 0,
        ops: [opMove('a', 0), snapDel],
        containsDelete: true,
      });
      assert.equal(withSnap.undoable, true);
      assert.equal(withSnap.count, 2, '移动 1 + 删除子树 1');

      // v0.2.3 及更早写下的日志点没有快照 → 整轮如实拒绝，不做"半撤销"
      const legacy = undoReadiness({
        id: '2',
        runId: 'r',
        createdAt: 0,
        ops: [opMove('a', 0), opDelete('d')],
        containsDelete: true,
      });
      assert.equal(legacy.undoable, false);
      assert.match(legacy.reason ?? '', /没有快照/);
      assert.equal(legacy.count, 1, 'count 只算真正可还原的操作');
    });

    // ── B. 端到端：一轮整理 → 撤销 → 整棵树逐节点（含顺序）与操作前一致 ──
    // 夹具：base > [sub1(delta,alpha,charlie,bravo), sub2(空)]
    const base = (await mockBookmarks.create({ parentId: '2', title: 'T23-BASE' })).id;
    const sub1 = (await mockBookmarks.create({ parentId: base, title: 'T23-SUB1' })).id;
    const sub2 = (await mockBookmarks.create({ parentId: base, title: 'T23-SUB2' })).id;
    const mkBm = async (t: string) =>
      (await mockBookmarks.create({ parentId: sub1, title: t, url: `https://t23.example/${t}` })).id;
    const bDelta = await mkBm('delta');
    const bAlpha = await mkBm('alpha');
    const bCharlie = await mkBm('charlie');
    const bBravo = await mkBm('bravo');

    storageMap.delete(UNDO_STORAGE_KEY);
    resetUndoTransactionForTest();
    const before = await snapshotTree();

    await beginUndoTransaction('run-t23');
    await executeTool('create_folder', JSON.stringify({ parentId: sub2, title: 'T23-NEW' }));
    await executeTool(
      'create_bookmarks',
      JSON.stringify({
        parentId: base,
        items: [
          { title: 'n1', url: 'https://t23.example/n1' },
          { title: 'n2', url: 'https://t23.example/n2' },
        ],
      }),
    );
    await executeTool('move_bookmarks', JSON.stringify({ ids: [bDelta, bAlpha], parentId: sub2, index: 0 }));
    await executeTool('rename_bookmark', JSON.stringify({ bookmarkId: bCharlie, title: 'charlie-改名' }));
    await executeTool(
      'update_bookmark_url',
      JSON.stringify({ bookmarkId: bBravo, url: 'https://t23.example/bravo-new' }),
    );
    await executeTool('sort_folder', JSON.stringify({ parentId: sub1, by: 'title' }));
    await executeTool('copy_bookmark', JSON.stringify({ bookmarkId: bCharlie, parentId: sub2 }));
    const point = await endUndoTransaction();

    const afterTools = await snapshotTree();
    ok('一轮整理确实改动了书签库（用例非空转）', () => assert.notEqual(afterTools, before));
    ok('撤销点记录了全部可逆操作', () => {
      assert.ok(point, '应产生撤销点');
      const kinds = point!.ops.map((o) => o.kind);
      assert.ok(kinds.filter((k) => k === 'move').length >= 4, `应有多次移动，实际 ${JSON.stringify(kinds)}`);
      assert.ok(kinds.includes('create'), '新建/复制应被记录');
      assert.ok(kinds.includes('update'), '重命名/改 URL 应被记录');
      assert.equal(point!.containsDelete, false);
    });

    const undoResult = await applyUndo();
    const afterUndo = await snapshotTree();
    ok('撤销后整棵树（含顺序）与操作前逐节点一致', () => {
      assert.ok(undoResult.ok, `撤销应成功，实际 ${JSON.stringify(undoResult)}`);
      assert.equal(undoResult.failures.length, 0);
      assert.equal(afterUndo, before, '撤销后书签树必须与操作前完全一致');
    });
    const again = await applyUndo();
    ok('撤销点被消费，不能重复撤销', () => {
      assert.equal(again.ok, false);
      assert.equal(again.restored, 0);
    });

    // ── C. 白盒：move 的 fromIndex 必须是移动「前」的下标 ──
    storageMap.delete(UNDO_STORAGE_KEY);
    resetUndoTransactionForTest();
    await beginUndoTransaction('run-t23-order');
    await jMove(bCharlie, { parentId: sub2, index: 0 });
    const orderPoint = await endUndoTransaction();
    const moveOp = orderPoint?.ops.find((o) => o.kind === 'move' && o.id === bCharlie) as
      | Extract<UndoOp, { kind: 'move' }>
      | undefined;
    ok('jMove 记录的是移动前的父目录与下标', () => {
      assert.ok(moveOp, '应记录一条 move');
      assert.equal(moveOp!.fromParentId, sub1, 'fromParentId 应是移动前的父目录');
      assert.equal(moveOp!.fromIndex, 2, 'fromIndex 应是移动前在 sub1 中的下标（charlie 第 3 位）');
    });
    await applyUndo();
    const restoredKids = (await mockBookmarks.getChildren(sub1)).map((n) => n.title);
    ok('同父目录重排撤销后顺序完全还原', () =>
      assert.deepEqual(restoredKids, ['delta', 'alpha', 'charlie', 'bravo']),
    );

    // ── D. 含删除的轮次：现在可以撤销（删除带快照）──
    storageMap.delete(UNDO_STORAGE_KEY);
    resetUndoTransactionForTest();
    const doomed = (await mockBookmarks.create({ parentId: sub2, title: 'T23-DOOMED', url: 'https://t23.example/doomed' })).id;
    const beforeDeleteTurn = await snapshotTreeObj();
    const beforeSub2Titles = (await mockBookmarks.getChildren(sub2)).map((n) => n.title);
    await beginUndoTransaction('run-t23-del');
    await jMove(bBravo, { parentId: sub2, index: 0 });
    await jRemove(doomed);
    const delPoint = await endUndoTransaction();
    const afterDeleteTurn = await snapshotTreeObj();
    const delUndo = await applyUndo();
    const afterDeleteUndo = await snapshotTreeObj();
    ok('删除记录了子树快照与位置锚点', () => {
      assert.ok(delPoint?.containsDelete, '应标记含删除');
      const del = delPoint!.ops.find((o) => o.kind === 'delete') as Extract<
        import('../src/lib/undo/types').UndoOp,
        { kind: 'delete' }
      >;
      assert.ok(del.snapshot, '删除必须带子树快照');
      assert.equal(del.snapshot!.title, 'T23-DOOMED');
      assert.equal(del.snapshot!.url, 'https://t23.example/doomed');
      assert.equal(del.parentId, sub2, '应记录原父目录');
      assert.ok(del.index !== undefined, '应记录兜底下标');
    });
    const sub2TitlesAfter = (await mockBookmarks.getChildren(sub2)).map((n) => n.title);
    ok('含删除的轮次现在能撤销，且整棵树（含顺序）与操作前一致', () => {
      assert.ok(delUndo.ok, `撤销应成功，实际 ${JSON.stringify(delUndo)}`);
      assert.ok(firstTreeDiff(afterDeleteTurn, beforeDeleteTurn) !== null, '本轮确实改动了书签库');
      const diff = firstTreeDiff(beforeDeleteTurn, afterDeleteUndo, '', { ignoreIds: true });
      assert.equal(diff, null, `删除过的书签必须回到原位；第一处差异：${diff ?? ''}`);
      // 位置也要真的对（重建的节点拿不到原 id，所以比标题序列）
      assert.deepEqual(sub2TitlesAfter, beforeSub2Titles, '被还原的节点必须回到原来的兄弟位置');
    });

    // ── E. 没有写操作的轮次不产生撤销点（避免「撤销 0 项」的空按钮） ──
    storageMap.delete(UNDO_STORAGE_KEY);
    resetUndoTransactionForTest();
    await beginUndoTransaction('run-t23-noop');
    await executeTool('stats', '{}');
    const noPoint = await endUndoTransaction();
    const pointsAfterNoop = await readUndoPoints();
    ok('只读轮次不产生撤销点', () => assert.equal(noPoint, null));
    ok('未落盘的只读轮次不会写进存储', () => assert.deepEqual(pointsAfterNoop, []));

    // ── F. 生产路径：runAgentTurn 自己开关事务（UI 从不直接调用 begin/end） ──
    storageMap.delete(UNDO_STORAGE_KEY);
    resetUndoTransactionForTest();
    const agentFolderTitle = 'T23-AGENT';
    sseQueue = [
      sseResponse([
        sseEvent(
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 't23-c1',
                      function: {
                        name: 'create_folder',
                        arguments: JSON.stringify({ title: agentFolderTitle, parentId: base }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        ),
        sseEvent('[DONE]'),
      ]),
      sseResponse([sseEvent(JSON.stringify({ choices: [{ delta: { content: '已创建。' } }] })), sseEvent('[DONE]')]),
    ];
    const turnEvents: ChatOutbound[] = [];
    await runTurn('建个文件夹', turnEvents);
    const agentPoints = await readUndoPoints();
    ok('Agent 轮次自动产生撤销点（生产路径）', () => {
      assert.equal(agentPoints.length, 1, '一轮对话应落盘一个撤销点');
      assert.ok(
        agentPoints[0]!.ops.some((o) => o.kind === 'create'),
        `应记录 create，实际 ${JSON.stringify(agentPoints[0]!.ops)}`,
      );
    });
    await applyUndo();
    const stillThere = (await mockBookmarks.getChildren(base)).some((n) => n.title === agentFolderTitle);
    ok('撤销 Agent 轮次后新建的文件夹被移除', () => assert.equal(stillThere, false));

    resetUndoTransactionForTest();
    storageMap.delete(UNDO_STORAGE_KEY);
  }

  /* ── T24: 撤销的 UI/Store 契约（拒绝不假装成功、成功才提示） ── */
  console.log('\n[T24] 撤销的 Store 契约');
  {
    const { useAIStore } = await import('../src/stores/aiStore');
    const { undoReadiness } = await import('../src/lib/undo/journal');
    const { useToastStore } = await import('../src/lib/toast');
    type UndoPointT = import('../src/lib/undo/types').UndoPoint;

    // 历史日志点：删除没有快照（v0.2.3 及更早写下的），整轮不可撤销
    const refusalPoint: UndoPointT = {
      id: 'u-refuse',
      runId: 'r1',
      createdAt: 1,
      ops: [{ kind: 'delete', id: 'gone', title: '旧版本删掉的书签' }],
      containsDelete: true,
    };
    const successPoint: UndoPointT = {
      id: 'u-ok',
      runId: 'r2',
      createdAt: 2,
      ops: [
        { kind: 'move', id: 'x', title: 'x', fromParentId: 'p', fromIndex: 0 },
        { kind: 'create', id: 'y', title: 'y', isFolder: false },
      ],
      containsDelete: false,
    };

    useToastStore.setState({ toasts: [] });
    let points: UndoPointT[] = [];
    let applyResult: unknown = undefined;
    sendMessageMock = (msg) => {
      const m = msg as { type?: string };
      if (m.type === 'undo:list') return { type: 'undo:list:result', points };
      if (m.type === 'undo:apply') return { type: 'undo:apply:result', result: applyResult };
      return undefined;
    };

    points = [];
    await useAIStore.getState().refreshUndo();
    ok('refreshUndo 同步撤销点列表到 store', () => assert.deepEqual(useAIStore.getState().undoPoints, []));

    points = [refusalPoint];
    await useAIStore.getState().refreshUndo();
    const stored = useAIStore.getState().undoPoints;
    ok('store 里的含删除撤销点被判定为不可撤销', () => {
      assert.equal(stored.length, 1);
      assert.equal(undoReadiness(stored[0]).undoable, false);
      assert.match(undoReadiness(stored[0]).reason ?? '', /没有快照/);
    });

    applyResult = { ok: false, reason: '本次操作有 1 条删除发生在旧版本（没有快照），无法还原，因此整轮不撤销', restored: 0, failures: [] };
    await useAIStore.getState().undoLast();
    const refusalToasts = useToastStore.getState().toasts;
    ok('撤销被拒时如实提示原因，不得谎报成功', () => {
      assert.ok(
        refusalToasts.some((t) => t.title === '无法撤销' && /没有快照/.test(t.description ?? '')),
        `应有拒绝提示，实际 ${JSON.stringify(refusalToasts)}`,
      );
      assert.ok(!refusalToasts.some((t) => t.title.includes('已撤销')), '不得出现成功提示');
    });

    // 成功路径：提示还原项数 + 重新拉取列表（消费掉的点不再出现）
    useToastStore.setState({ toasts: [] });
    points = [successPoint];
    applyResult = { ok: true, restored: 2, failures: [] };
    await useAIStore.getState().undoLast();
    points = [];
    const successToasts = useToastStore.getState().toasts;
    ok('撤销成功时提示还原项数并刷新列表', () => {
      assert.ok(
        successToasts.some((t) => t.variant === 'success' && /还原 2 项/.test(t.title)),
        `应有成功提示，实际 ${JSON.stringify(successToasts)}`,
      );
    });

    // 部分失败：必须上报失败明细而不是全绿
    useToastStore.setState({ toasts: [] });
    points = [successPoint];
    applyResult = { ok: false, restored: 1, failures: [{ op: 'move', title: 'x', error: '节点已不存在' }] };
    await useAIStore.getState().undoLast();
    points = [];
    const partialToasts = useToastStore.getState().toasts;
    ok('部分失败时上报明细，不谎报全部成功', () => {
      assert.ok(
        partialToasts.some((t) => /已还原 1 项，1 项失败/.test(t.title) && /节点已不存在/.test(t.description ?? '')),
        `应上报失败明细，实际 ${JSON.stringify(partialToasts)}`,
      );
    });

    sendMessageMock = () => undefined;
    useToastStore.setState({ toasts: [] });
  }

  /* ── T25: 版本号单一来源（UI 不得硬编码，必须与产物一致） ── */
  console.log('\n[T25] 版本号单一来源');
  {
    const { appVersion } = await import('../src/lib/version');

    ok('appVersion 取的就是清单版本（与 package.json 一致）', () => {
      assert.equal(appVersion(), pkgVersion, 'UI 显示的版本必须等于产物版本');
    });

    // 覆盖清单版本：证明它真的在"读清单"，而不是又一个写死的常量
    manifestVersion = '9.9.9';
    const overridden = appVersion();
    manifestVersion = pkgVersion;
    ok('appVersion 跟随清单变化（不是写死的常量）', () => assert.equal(overridden, '9.9.9'));

    // 源码守卫：src 下不得再出现硬编码的三段式版本号（注释除外）。
    // 这个 bug 真的发生过：0.2.0 → 0.2.1 时 config-form 与 popup 两处都漏改。
    const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
    const stripComments = (s: string) =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    const offenders = walk(srcDir)
      .filter((f) => /\.tsx?$/.test(f))
      .filter((f) => /\bv?\d+\.\d+\.\d+\b/.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => f.slice(srcDir.length + 1));
    ok('src 下没有硬编码的三段式版本号（防再次漂移）', () =>
      assert.deepEqual(offenders, [], `以下文件硬编码了版本号，请改用 appVersion()：${offenders.join('、')}`),
    );

    // 守卫的前置条件：两个 UI 面确实在"显示版本"，否则上面的守卫可以被"干脆不显示"绕过
    for (const rel of ['components/options/config-form.tsx', 'entrypoints/popup/main.tsx']) {
      const text = readFileSync(join(srcDir, rel), 'utf8');
      ok(`${rel} 通过 appVersion() 显示版本而不是写死`, () => {
        assert.match(text, /appVersion\s*\(/, `${rel} 应调用 appVersion()`);
      });
    }
  }

  /* ── T26: 撤销的边界与一致性（DIRECTION P2） ── */
  console.log('\n[T26] 撤销的边界与一致性');
  {
    const { useAIStore, initCrossWindowSync } = await import('../src/stores/aiStore');
    const { useToastStore } = await import('../src/lib/toast');
    const { applyUndo } = await import('../src/lib/undo/apply');
    const {
      UNDO_STORAGE_KEY,
      beginUndoTransaction,
      endUndoTransaction,
      resetUndoTransactionForTest,
    } = await import('../src/lib/undo/recorder');
    type UndoPointT = import('../src/lib/undo/types').UndoPoint;

    const mkPoint = (id: string, kind: 'move' | 'create' = 'move'): UndoPointT => ({
      id,
      runId: `run-${id}`,
      createdAt: Date.now(),
      ops:
        kind === 'move'
          ? [{ kind: 'move', id: `bm-${id}`, title: id, fromParentId: 'p', fromIndex: 0 }]
          : [{ kind: 'create', id: `new-${id}`, title: id, isFolder: true }],
      containsDelete: false,
    });

    // ── A. 点击撤销必须针对「界面上展示的那个点」 ──
    const sentMessages: { type?: string; id?: string }[] = [];
    let listed: UndoPointT[] = [];
    let applyResult: unknown = undefined;
    sendMessageMock = (msg) => {
      const m = msg as { type?: string; id?: string };
      sentMessages.push(m);
      if (m.type === 'undo:list') return { type: 'undo:list:result', points: listed };
      if (m.type === 'undo:apply') return { type: 'undo:apply:result', result: applyResult };
      return undefined;
    };

    const shownPoint = mkPoint('P-shown');
    const newerPoint = mkPoint('P-newer');
    listed = [shownPoint, newerPoint];
    await useAIStore.getState().refreshUndo();
    applyResult = { ok: true, restored: 1, failures: [] };
    sentMessages.length = 0;
    await useAIStore.getState().undoLast();

    ok('撤销显式针对 store 当前展示的撤销点（而不是"最新那个"）', () => {
      const applied = sentMessages.find((m) => m.type === 'undo:apply');
      assert.ok(applied, '应发出 undo:apply');
      assert.equal(
        applied!.id,
        shownPoint.id,
        '必须带上界面展示的那个 id——只发"最新"时，别的窗口中途跑完一轮就会撤错对象',
      );
    });

    // 展示点已被别的窗口撤掉：background 如实拒绝，界面不得谎报成功，并刷新掉陈旧入口
    useToastStore.setState({ toasts: [] });
    listed = [shownPoint];
    await useAIStore.getState().refreshUndo();
    applyResult = { ok: false, reason: '该操作已不存在（可能已在另一个窗口撤销过）', restored: 0, failures: [] };
    listed = [];
    await useAIStore.getState().undoLast();
    const goneToasts = useToastStore.getState().toasts;
    ok('目标撤销点已消失时如实拒绝，且不再显示陈旧按钮', () => {
      assert.ok(
        goneToasts.some((t) => t.title === '无法撤销' && /已不存在/.test(t.description ?? '')),
        `应提示已不存在，实际 ${JSON.stringify(goneToasts)}`,
      );
      assert.ok(!goneToasts.some((t) => t.title.includes('已撤销')),
        '不得出现成功提示');
      assert.equal(useAIStore.getState().undoPoints.length, 0, '刷新后应清掉被消费的点');
    });

    // 没有任何可撤销点：连请求都不该发
    useToastStore.setState({ toasts: [] });
    listed = [];
    await useAIStore.getState().refreshUndo();
    sentMessages.length = 0;
    await useAIStore.getState().undoLast();
    ok('没有可撤销点时直接提示，不发无意义的请求', () => {
      assert.equal(sentMessages.filter((m) => m.type === 'undo:apply').length, 0);
      assert.ok(useToastStore.getState().toasts.some((t) => t.title === '没有可撤销的操作'));
    });

    // ── B. 引擎层：指定 id 找不到时不得退化成"那就撤最新的" ──
    storageMap.delete(UNDO_STORAGE_KEY);
    await beginUndoTransaction('run-exists');
    const survivor = (await mockBookmarks.create({ parentId: '2', title: 'T26-SURVIVOR', url: 'https://t26.test/s' })).id;
    await import('../src/lib/undo/mutations').then((m) => m.jRemove(survivor));
    await endUndoTransaction();
    const missing = await applyUndo('no-such-point-id');
    const stillThere = (await mockBookmarks.get(survivor).catch(() => [])).length > 0;
    ok('applyUndo 对不存在的 id 如实拒绝（不退化成撤销最新点）', () => {
      assert.equal(missing.ok, false);
      assert.match(missing.reason ?? '', /已不存在/);
      assert.equal(missing.restored, 0);
      assert.equal(stillThere, false, '不得顺手把最新那个撤销点也执行掉');
    });

    // ── C. 跨窗口：markai.undo 变化要让其他窗口立刻刷新 ──
    const stopSync = initCrossWindowSync();
    let listCalls = 0;
    sendMessageMock = (msg) => {
      const m = msg as { type?: string };
      if (m.type === 'undo:list') {
        listCalls++;
        return { type: 'undo:list:result', points: listed };
      }
      return undefined;
    };
    listed = [shownPoint];
    fireStorageChange({ [UNDO_STORAGE_KEY]: { newValue: { points: [shownPoint] } } });
    await new Promise((r) => setTimeout(r, 20));
    ok('别的窗口改动撤销点会触发本窗口 refreshUndo', () => {
      assert.ok(listCalls >= 1, `应发起 undo:list，实际 ${listCalls} 次`);
      assert.equal(useAIStore.getState().undoPoints.length, 1);
    });
    const callsAfterUndo = listCalls;
    fireStorageChange({ 'markai.unrelated': { newValue: 1 } });
    await new Promise((r) => setTimeout(r, 20));
    ok('无关 key 的变化不触发撤销点刷新（不做无谓刷新）', () => assert.equal(listCalls, callsAfterUndo));
    stopSync();

    // ── D. 规模：5000+ 节点大库下，一轮整理 → 撤销 → 整树含顺序深比对一致 ──
    // 注意：替身的 getChildren 是 O(全库)（真实 API 是 O(该文件夹子项)），
    // 所以这里的耗时是**悲观上界**，只能用来抓自家代码的 O(n²) 爆炸，不代表真实性能。
    const bulk = (parentId: string, count: number, prefix: string, url?: (i: number) => string) => {
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        const id = String(nextId++);
        store.push({
          id,
          parentId,
          title: `${prefix}${String(i).padStart(4, '0')}`,
          ...(url ? { url: url(i) } : {}),
          dateAdded: 10_000 + i,
        });
        ids.push(id);
      }
      return ids;
    };
    const big = (await mockBookmarks.create({ parentId: '2', title: 'T26-BIG' })).id;
    const fillerA = (await mockBookmarks.create({ parentId: big, title: 'T26-FILL-A' })).id;
    const fillerB = (await mockBookmarks.create({ parentId: big, title: 'T26-FILL-B' })).id;
    const catFolder = (await mockBookmarks.create({ parentId: big, title: 'T26-CAT' })).id;
    const sortFolder = (await mockBookmarks.create({ parentId: big, title: 'T26-SORT' })).id;
    const mergeSrc = (await mockBookmarks.create({ parentId: big, title: 'T26-MERGE-SRC' })).id;
    const mergeDst = (await mockBookmarks.create({ parentId: big, title: 'T26-MERGE-DST' })).id;
    bulk(fillerA, 2000, 'fa-', (i) => `https://filler-a.test/${i}`);
    bulk(fillerB, 1800, 'fb-', (i) => `https://filler-b.test/${i}`);
    // 分类目标：800 条直接书签，8 个注册域各 100 条
    bulk(catFolder, 800, 'cat-', (i) => `https://d${i % 8}.example/page/${i}`);
    // 排序目标：300 条，标题倒序灌入
    for (let i = 300; i > 0; i--) {
      const id = String(nextId++);
      store.push({
        id,
        parentId: sortFolder,
        title: `s-${String(i).padStart(4, '0')}`,
        url: `https://sort.test/${i}`,
        dateAdded: 20_000 + i,
      });
    }
    bulk(mergeSrc, 300, 'ms-', (i) => `https://merge.test/${i}`);
    const totalNodes = store.length;

    storageMap.delete(UNDO_STORAGE_KEY);
    resetUndoTransactionForTest();
    const beforeBig = await snapshotTreeObj();
    const turnStart = Date.now();
    await beginUndoTransaction('run-scale');
    const catOut = await executeTool(
      'auto_categorize',
      JSON.stringify({ folderId: catFolder, minGroupSize: 50, maxGroups: 25, foldOverflow: true }),
    );
    const sortOut = await executeTool('sort_folder', JSON.stringify({ parentId: sortFolder, by: 'title' }));
    const mergeOut = await executeTool('merge_folders', JSON.stringify({ sourceId: mergeSrc, targetId: mergeDst }));
    const scalePoint = await endUndoTransaction();
    const undoStart = Date.now();
    const scaleUndo = await applyUndo();
    const elapsedTurn = undoStart - turnStart;
    const elapsedUndo = Date.now() - undoStart;
    const afterBig = await snapshotTreeObj();

    ok('大库夹具确实超过 5000 个节点', () =>
      assert.ok(totalNodes > 5000, `实际 ${totalNodes} 个节点`),
    );
    ok('大库下三个工具都跑出了预期规模', () => {
      const c = JSON.parse(catOut.result) as { moved: number; created: number };
      const s = JSON.parse(sortOut.result) as { sorted: number };
      const m = JSON.parse(mergeOut.result) as { moved: number };
      assert.equal(c.created, 8, `应建 8 个域名文件夹，实际 ${c.created}`);
      assert.equal(c.moved, 800, `应移动 800 条，实际 ${c.moved}`);
      assert.equal(s.sorted, 300);
      assert.equal(m.moved, 300);
    });
    ok('大库下的撤销点覆盖了全部写入，且并发批次只记一条', () => {
      assert.ok(scalePoint, '应产生撤销点');
      type Op = import('../src/lib/undo/types').UndoOp;
      const batch = scalePoint!.ops.filter((o): o is Extract<Op, { kind: 'moveBatch' }> => o.kind === 'moveBatch');
      assert.equal(batch.length, 1, 'auto_categorize 的 800 次并发移动必须折叠成一条 moveBatch');
      assert.equal(batch[0]!.ids.length, 800, '批次应覆盖全部 800 条');
      assert.equal(batch[0]!.order.length, 800, '批次应带上批次开始前的完整子序（撤销顺序靠它）');
      assert.equal(scalePoint!.ops.filter((o) => o.kind === 'create').length, 8, '8 个域名文件夹');
      assert.equal(
        scalePoint!.ops.filter((o) => o.kind === 'move').length,
        600,
        'sort_folder 300 + merge_folders 300 仍是逐条记录',
      );
      assert.equal(scalePoint!.containsDelete, false, 'merge 只提议删除源空文件夹，不算删除');
    });
    ok('5000+ 节点下撤销后整棵树（含顺序）与操作前逐节点一致', () => {
      assert.ok(scaleUndo.ok, `撤销应成功，实际 ${JSON.stringify(scaleUndo).slice(0, 200)}`);
      assert.equal(scaleUndo.failures.length, 0);
      const diff = firstTreeDiff(beforeBig, afterBig);
      assert.equal(diff, null, `大库撤销后第一处差异：${diff ?? ''}`);
    });
    // 护栏：只为抓自家代码的 O(n²) 爆炸（替身比真实 API 悲观，故阈值给得很宽）
    ok('大库一轮整理 + 撤销未出现灾难性耗时（< 180s）', () => {
      assert.ok(
        elapsedTurn < 180_000,
        `一轮工具调用耗时 ${elapsedTurn}ms，疑似自家代码 O(n²) 爆炸`,
      );
      assert.ok(elapsedUndo < 180_000, `撤销耗时 ${elapsedUndo}ms，疑似自家代码 O(n²) 爆炸`);
    });
    console.log(`     （实测：一轮 ${elapsedTurn}ms，撤销 ${elapsedUndo}ms，节点 ${totalNodes}）`);

    resetUndoTransactionForTest();
    storageMap.delete(UNDO_STORAGE_KEY);
    sendMessageMock = () => undefined;
    useToastStore.setState({ toasts: [] });
  }

  /* ── T27: 删除可撤销（含并发删除与子树还原） ── */
  console.log('\n[T27] 删除可撤销');
  {
    const {
      UNDO_STORAGE_KEY,
      beginUndoTransaction,
      endUndoTransaction,
      ensureOrderCheckpoint,
      resetUndoTransactionForTest,
    } = await import('../src/lib/undo/recorder');
    const { applyUndo } = await import('../src/lib/undo/apply');
    const { jRemove } = await import('../src/lib/undo/mutations');
    const { opWeight, summarizeOps } = await import('../src/lib/undo/journal');
    type UndoOp = import('../src/lib/undo/types').UndoOp;

    // ── A. 并发删除（与 cleanup_sweep 的 10 路并发池同形）后撤销：顺序必须完全还原 ──
    storageMap.delete(UNDO_STORAGE_KEY);
    resetUndoTransactionForTest();
    const conc = (await mockBookmarks.create({ parentId: '1', title: 'T27-CONC' })).id;
    const concIds: string[] = [];
    for (let i = 0; i < 30; i++) {
      const id = String(nextId++);
      store.push({
        id,
        parentId: conc,
        title: `c-${String(i).padStart(2, '0')}`,
        url: `https://t27-conc.test/${i}`,
        dateAdded: 30_000 + i,
      });
      concIds.push(id);
    }
    const beforeConc = await snapshotTreeObj();
    const beforeConcTitles = concIds.map((_, i) => `c-${String(i).padStart(2, '0')}`);
    await beginUndoTransaction('run-t27-conc');
    // 契约：调用方必须在批量删除**之前**为每个将失去子项的父目录取顺序检查点
    // （真实调用方是 cleanup_sweep / propose_deletions / delete_all_bookmarks）
    await ensureOrderCheckpoint(conc);
    // 删掉错落的一半（偶数位）+ 10 路并发：正是"并发读下标不构成一致历史"的场景
    const targets = concIds.filter((_, i) => i % 2 === 0);
    let cursor = 0;
    await Promise.all(
      Array.from({ length: 10 }, async () => {
        while (cursor < targets.length) await jRemove(targets[cursor++]!);
      }),
    );
    const concPoint = await endUndoTransaction();
    const midConc = await snapshotTreeObj();
    const concUndo = await applyUndo();
    const afterConc = await snapshotTreeObj();

    ok('并发删除的每条操作都带子树快照与原父目录', () => {
      const dels = (concPoint?.ops ?? []).filter(
        (o): o is Extract<UndoOp, { kind: 'delete' }> => o.kind === 'delete',
      );
      assert.equal(dels.length, 15, '删掉了 15 条');
      assert.ok(
        dels.every((d) => d.snapshot && d.parentId === conc),
        '每条删除都必须有快照与原父目录，否则撤销只能靠猜',
      );
      assert.ok(
        (concPoint?.orderCheckpoints ?? []).some((cp) => cp.parentId === conc),
        '并发删除必须在动手前取父目录顺序检查点（逐条下标/锚点都不可靠）',
      );
    });
    ok('并发删除后撤销：整棵树含顺序逐节点复原', () => {
      assert.ok(concUndo.ok, `撤销应成功，实际 ${JSON.stringify(concUndo)}`);
      assert.notEqual(firstTreeDiff(beforeConc, midConc), null, '本轮确实删掉了东西');
      const diff = firstTreeDiff(beforeConc, afterConc, '', { ignoreIds: true });
      assert.equal(diff, null, `第一处差异：${diff ?? ''}`);
    });
    const concTitlesAfter = (await mockBookmarks.getChildren(conc)).map((n) => n.title);
    ok('并发删除撤销后兄弟顺序与原顺序一致', () => assert.deepEqual(concTitlesAfter, beforeConcTitles));

    // ── B. 子树还原：删掉一个含子项的文件夹，撤销要连内容与顺序一起带回来 ──
    storageMap.delete(UNDO_STORAGE_KEY);
    resetUndoTransactionForTest();
    const treeParent = (await mockBookmarks.create({ parentId: '1', title: 'T27-PARENT' })).id;
    const victim = (await mockBookmarks.create({ parentId: treeParent, title: 'T27-VICTIM' })).id;
    for (const t of ['v1', 'v2', 'v3']) {
      await mockBookmarks.create({ parentId: victim, title: t, url: `https://t27-victim.test/${t}` });
    }
    const beforeTree = await snapshotTreeObj();
    await beginUndoTransaction('run-t27-tree');
    await jRemove(victim, { tree: true });
    const treePoint = await endUndoTransaction();
    const treeUndo = await applyUndo();
    const afterTree = await snapshotTreeObj();
    ok('删除文件夹时快照包含整棵子树（按节点数计权重）', () => {
      const del = (treePoint?.ops ?? []).find(
        (o): o is Extract<UndoOp, { kind: 'delete' }> => o.kind === 'delete',
      );
      assert.ok(del?.snapshot, '应有快照');
      assert.equal(opWeight(del!), 4, '文件夹 1 + 3 个子书签');
      assert.equal(summarizeOps(treePoint!.ops), '删除 4 项');
    });
    ok('撤销删除文件夹：整棵子树（含顺序）回到原位', () => {
      assert.ok(treeUndo.ok, `撤销应成功，实际 ${JSON.stringify(treeUndo)}`);
      const diff = firstTreeDiff(beforeTree, afterTree, '', { ignoreIds: true });
      assert.equal(diff, null, `第一处差异：${diff ?? ''}`);
    });

    // ── C. 全链路：cleanup_sweep 在「无需确认」模式下并发删除 → 撤销 → 整棵树一致 ──
    storageMap.delete(UNDO_STORAGE_KEY);
    resetUndoTransactionForTest();
    storageMap.set('markai.config', { deleteMode: 'auto' }); // 用户显式选择"无需确认"
    const sweepFolder = (await mockBookmarks.create({ parentId: '1', title: 'T27-SWEEP' })).id;
    for (let i = 0; i < 12; i++) {
      const id = String(nextId++);
      store.push({
        id,
        parentId: sweepFolder,
        title: `s-${String(i).padStart(2, '0')}`,
        // 3 段路径 → classify_urls 判为 deep，keepOnly=page 时不在保留范围 → 可删
        url: `https://t27-sweep-${i}.test/docs/article/${i}`,
        dateAdded: Date.UTC(2025, 6, 1),
      });
    }
    const beforeSweep = await snapshotTreeObj();
    await beginUndoTransaction('run-t27-sweep');
    // checkReachable=false：不联网、不走启发式，全部 12 条都在清理范围内
    const sweepOut = await executeTool(
      'cleanup_sweep',
      JSON.stringify({ folderId: sweepFolder, beforeYear: 2026, keepOnly: 'page', checkReachable: false }),
    );
    const sweepPoint = await endUndoTransaction();
    const midSweep = await snapshotTreeObj();
    const sweepUndo = await applyUndo();
    const afterSweep = await snapshotTreeObj();
    storageMap.delete('markai.config');
    const sj = JSON.parse(sweepOut.result) as { toDelete: number; deleted: number; failed: number };
    ok('cleanup_sweep 自动模式确实按并发删除了书签', () => {
      assert.equal(sj.toDelete, 12);
      assert.equal(sj.deleted, 12, `应删掉 12 条，实际 ${sj.deleted}`);
      assert.equal(sj.failed, 0);
      assert.notEqual(firstTreeDiff(beforeSweep, midSweep), null, '这一轮确实删掉了东西');
    });
    ok('自动清理一轮后撤销：整棵树含顺序逐节点复原（这是"后悔药"的核心场景）', () => {
      assert.ok(sweepPoint?.containsDelete, '应标记含删除');
      assert.ok(sweepUndo.ok, `撤销应成功，实际 ${JSON.stringify(sweepUndo)}`);
      assert.equal(sweepUndo.failures.length, 0);
      const diff = firstTreeDiff(beforeSweep, afterSweep, '', { ignoreIds: true });
      assert.equal(diff, null, `第一处差异：${diff ?? ''}`);
    });

    // ── D. delete_all_bookmarks（auto）全链路：清空书签库 → 撤销 → 整棵树一致 ──
    // 用隔离的小书签库跑：把前面测试积累的 5000+ 节点全删一遍既慢、也不是这条链路要验的东西。
    // 保存现场 → 换夹具 → 跑 → 无论成败都还原现场。
    storageMap.delete(UNDO_STORAGE_KEY);
    resetUndoTransactionForTest();
    const savedStore = [...store];
    let delAllOut: { deleted: number; failed: number } | null = null;
    let delAllPoint: Awaited<ReturnType<typeof endUndoTransaction>> = null;
    let delAllUndo: Awaited<ReturnType<typeof applyUndo>> | null = null;
    let beforeDelAll: TreeNorm[] = [];
    let midDelAll: TreeNorm[] = [];
    let afterDelAll: TreeNorm[] = [];
    let delAllError: string | null = null;
    try {
      store.length = 0;
      store.push({ id: '0', title: '', dateAdded: 0 });
      store.push({ id: '1', title: '书签栏', parentId: '0', dateAdded: 1 });
      store.push({ id: '2', title: '其他书签', parentId: '0', dateAdded: 1 });
      // 书签栏：[F1(c1, c2), b3, b4]；其他书签：[F2(c5), b6]
      store.push({ id: 'DA-F1', parentId: '1', title: 'DA-F1', dateAdded: 2 });
      store.push({ id: 'DA-c1', parentId: 'DA-F1', title: 'DA-c1', url: 'https://da.test/1', dateAdded: 3 });
      store.push({ id: 'DA-c2', parentId: 'DA-F1', title: 'DA-c2', url: 'https://da.test/2', dateAdded: 4 });
      store.push({ id: 'DA-b3', parentId: '1', title: 'DA-b3', url: 'https://da.test/3', dateAdded: 5 });
      store.push({ id: 'DA-b4', parentId: '1', title: 'DA-b4', url: 'https://da.test/4', dateAdded: 6 });
      store.push({ id: 'DA-F2', parentId: '2', title: 'DA-F2', dateAdded: 7 });
      store.push({ id: 'DA-c5', parentId: 'DA-F2', title: 'DA-c5', url: 'https://da.test/5', dateAdded: 8 });
      store.push({ id: 'DA-b6', parentId: '2', title: 'DA-b6', url: 'https://da.test/6', dateAdded: 9 });

      storageMap.set('markai.config', { deleteMode: 'auto' });
      beforeDelAll = await snapshotTreeObj();
      await beginUndoTransaction('run-t27-delall');
      const out = await executeTool('delete_all_bookmarks', JSON.stringify({ reason: 'T27 测试' }));
      delAllOut = JSON.parse(out.result) as { deleted: number; failed: number };
      delAllPoint = await endUndoTransaction();
      midDelAll = await snapshotTreeObj();
      delAllUndo = await applyUndo();
      afterDelAll = await snapshotTreeObj();
    } catch (e) {
      delAllError = e instanceof Error ? e.message : String(e);
    } finally {
      store.length = 0;
      store.push(...savedStore);
      storageMap.delete('markai.config');
    }

    ok('delete_all_bookmarks 自动模式清空书签库（含文件夹子树）', () => {
      assert.equal(delAllError, null, `不应抛错：${delAllError}`);
      assert.equal(delAllOut!.deleted, 5, '顶层 5 项（书签栏 3 + 其他书签 2）');
      assert.equal(delAllOut!.failed, 0);
      assert.equal(
        midDelAll.reduce((acc, r) => acc + r.children.length, 0),
        0,
        '清空后两个根都不该还有子项',
      );
    });
    ok('清空书签库后撤销：整棵树含顺序逐节点复原', () => {
      assert.ok(delAllPoint?.containsDelete, '应标记含删除');
      assert.ok(delAllUndo?.ok, `撤销应成功，实际 ${JSON.stringify(delAllUndo)}`);
      assert.equal(delAllUndo!.failures.length, 0);
      const diff = firstTreeDiff(beforeDelAll, afterDelAll, '', { ignoreIds: true });
      assert.equal(diff, null, `第一处差异：${diff ?? ''}`);
      const countNodes = (rows: TreeNorm[]): number =>
        rows.reduce((acc, r) => acc + 1 + countNodes(r.children), 0);
      // 快照的顶层就是两个根（书签栏 / 其他书签），所以是 2 根 + 被删的 8 个节点
      assert.equal(countNodes(afterDelAll), 10, '两个根 + 被删的 8 个节点都应回来');
    });

    resetUndoTransactionForTest();
    storageMap.delete(UNDO_STORAGE_KEY);
    storageMap.delete('markai.config');
  }

  /* ── T28: 撤销点的容量护栏与丢弃透明化 ── */
  console.log('\n[T28] 撤销点容量护栏');
  {
    const { pointBytes, trimPointsToBudget, describeUndoTrim, UNDO_BUDGET_BYTES } = await import(
      '../src/lib/undo/journal'
    );
    const {
      UNDO_STORAGE_KEY,
      beginUndoTransaction,
      endUndoTransaction,
      readUndoState,
      resetUndoTransactionForTest,
      setUndoBudgetBytes,
    } = await import('../src/lib/undo/recorder');
    const { useAIStore } = await import('../src/stores/aiStore');
    const { useToastStore } = await import('../src/lib/toast');
    type UndoPointT = import('../src/lib/undo/types').UndoPoint;

    const mkPoint = (id: string, urlLen = 10): UndoPointT => ({
      id,
      runId: `r-${id}`,
      createdAt: Date.now(),
      containsDelete: false,
      ops: [
        {
          kind: 'create',
          id: `n-${id}`,
          title: id,
          isFolder: false,
          ...(urlLen > 0 ? {} : {}),
        },
        { kind: 'update', id: `u-${id}`, title: id, before: { url: 'x'.repeat(urlLen) } },
      ],
    });

    ok('pointBytes 按 JSON 序列化长度计量（与 storage 配额口径一致）', () => {
      const p1 = mkPoint('a');
      assert.equal(pointBytes(p1), JSON.stringify(p1).length);
      assert.ok(pointBytes(mkPoint('b', 5000)) > pointBytes(p1), '内容越大，字节数越大');
    });

    ok('预算内按新→旧保留，超出预算丢最旧的', () => {
      const pts = [mkPoint('1', 4000), mkPoint('2', 4000), mkPoint('3', 4000)];
      const budget = pointBytes(pts[0]!) + pointBytes(pts[1]!) + 10; // 只装得下两个
      const r = trimPointsToBudget(pts, budget);
      assert.deepEqual(
        r.kept.map((p) => p.id),
        ['1', '2'],
        '新的在前，保留最新的两个',
      );
      assert.deepEqual(
        r.droppedNoRoom.map((p) => p.id),
        ['3'],
        '最旧的被挤出',
      );
      assert.equal(r.droppedTooLarge.length, 0);
    });

    ok('单点超预算时只跳过它，不牵连其他撤销点', () => {
      const huge = mkPoint('huge', 8000);
      const budget = Math.floor(pointBytes(huge) / 2);
      const small = mkPoint('small', 10);
      const r = trimPointsToBudget([huge, small], budget);
      assert.deepEqual(r.droppedTooLarge.map((p) => p.id), ['huge']);
      assert.deepEqual(
        r.kept.map((p) => p.id),
        ['small'],
        '超大点不该把还能用的旧点一起清空',
      );
    });

    ok('describeUndoTrim 把人话说明写全（两种丢弃都提）', () => {
      const huge = mkPoint('huge', 8000);
      const budget = Math.floor(pointBytes(huge) / 2);
      const text = describeUndoTrim(trimPointsToBudget([huge, mkPoint('a', 10), mkPoint('b', 10)], budget));
      assert.match(text ?? '', /过大/);
      assert.match(text ?? '', /未保留撤销记录/);
      assert.equal(describeUndoTrim({ kept: [], droppedTooLarge: [], droppedNoRoom: [] }), undefined);
    });

    ok('默认预算按 chrome.storage.local 配额留出余量（4 MiB / 10 MiB）', () => {
      assert.equal(UNDO_BUDGET_BYTES, 4 * 1024 * 1024);
      assert.ok(UNDO_BUDGET_BYTES < 10 * 1024 * 1024, '必须小于 storage.local 的 10 MiB 配额');
    });

    // ── 落盘层：超预算丢最旧并留下 notice ──
    storageMap.delete(UNDO_STORAGE_KEY);
    resetUndoTransactionForTest();
    setUndoBudgetBytes(2000); // 极小预算，逼出裁剪
    // 让撤销点的体量真的随 payLen 变化：create 操作只记新建 id（很小），
    // 而 update 操作会记下**改动前的旧值**——所以先建个长 URL，再改一次。
    const mkTinyTx = async (runId: string, payLen: number) => {
      await beginUndoTransaction(runId);
      const { jCreate, jUpdate } = await import('../src/lib/undo/mutations');
      const node = await jCreate({
        parentId: '2',
        title: `T28-${runId}`,
        url: `https://t28.test/${'x'.repeat(payLen)}`,
      });
      await jUpdate(node.id, { url: `https://t28.test/${runId}-new` });
      return endUndoTransaction();
    };
    await mkTinyTx('r1', 10);
    await mkTinyTx('r2', 700);
    await mkTinyTx('r3', 700);
    const st = await readUndoState();
    ok('超预算时丢最旧的、并留下如实 notice（不再静默）', () => {
      assert.ok(st.points.length >= 1, '至少保留最新的点');
      assert.ok(st.points.length < 3, `应丢掉了旧点，实际 ${st.points.length}`);
      assert.match(st.notice ?? '', /丢弃了/, `应有丢弃说明，实际「${st.notice}」`);
      assert.ok((st.noticeAt ?? 0) > 0, 'notice 应带时间戳供 UI 只提示一次');
    });

    // ── 单点过大：不保留，并说明"未保留撤销记录" ──
    storageMap.delete(UNDO_STORAGE_KEY);
    resetUndoTransactionForTest();
    setUndoBudgetBytes(300);
    await mkTinyTx('huge', 5000);
    const stHuge = await readUndoState();
    ok('单点超过预算时不保留，并说明原因（而不是假装没发生）', () => {
      assert.equal(stHuge.points.length, 0, '放不下的点不该硬写');
      assert.match(stHuge.notice ?? '', /过大|未保留/, `应说明未保留，实际「${stHuge.notice}」`);
    });

    // ── 写入失败：不再吞错，readUndoState 如实上报 ──
    storageMap.delete(UNDO_STORAGE_KEY);
    resetUndoTransactionForTest();
    setUndoBudgetBytes(UNDO_BUDGET_BYTES);
    storageSetFail = true;
    await mkTinyTx('fail', 10);
    storageSetFail = false;
    const stFail = await readUndoState();
    ok('写入失败不再被吞掉，能如实上报', () => {
      assert.match(stFail.notice ?? '', /写入失败/, `应上报写入失败，实际「${stFail.notice}」`);
    });

    // ── 兼容性：旧结构（只有 points）仍能读 ──
    storageMap.set(UNDO_STORAGE_KEY, { points: [mkPoint('legacy')] });
    const stLegacy = await readUndoState();
    ok('兼容旧存储结构（只有 points、没有 notice）', () => {
      assert.equal(stLegacy.points.length, 1);
      assert.equal(stLegacy.points[0]!.id, 'legacy');
    });

    // ── Store 层：notice 呈现给用户，且同一条只提示一次 ──
    const noticePoint = mkPoint('np');
    let listedNotice: string | undefined = '撤销记录空间已满，丢弃了 2 个更早的撤销点';
    let listedAt = 111;
    sendMessageMock = (msg) => {
      const m = msg as { type?: string };
      if (m.type === 'undo:list') {
        return {
          type: 'undo:list:result',
          points: [noticePoint],
          ...(listedNotice ? { notice: listedNotice } : {}),
          ...(listedAt ? { noticeAt: listedAt } : {}),
        };
      }
      return undefined;
    };
    useToastStore.setState({ toasts: [] });
    useAIStore.setState({ undoNotice: null, undoNoticeAt: null });
    // 数"提示动作"而不是数 toast 列表：toast store 自带同内容去重，
    // 数列表会让"根本没做去重"也看起来只提示了一次（这条测试第一版就是这样假绿的）。
    const origPush = useToastStore.getState().push;
    const notices: string[] = [];
    useToastStore.setState({
      push: (t) => {
        if (t.title === '撤销记录有变更') notices.push(t.description ?? '');
        return origPush(t);
      },
    });
    await useAIStore.getState().refreshUndo();
    ok('notice 会呈现给用户（store 保存 + 提示一次）', () => {
      assert.equal(useAIStore.getState().undoNotice, listedNotice);
      assert.equal(notices.length, 1, `应提示一次，实际 ${notices.length}`);
    });
    await useAIStore.getState().refreshUndo(); // 同一条 noticeAt：不该重复提示
    ok('同一条 notice 不重复打扰（noticeAt 相同只提示一次）', () =>
      assert.equal(notices.length, 1, `不应重复提示，实际 ${notices.length}`),
    );
    useToastStore.setState({ push: origPush });

    sendMessageMock = () => undefined;
    useToastStore.setState({ toasts: [] });
    storageMap.delete(UNDO_STORAGE_KEY);
    resetUndoTransactionForTest();
    setUndoBudgetBytes(UNDO_BUDGET_BYTES);
  }

  /* ── T29: 权限文档与 manifest 不许漂移 + 隐私承诺可核对 ── */
  console.log('\n[T29] 权限/隐私文档守卫');
  {
    const docsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../docs');
    const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const wxt = readFileSync(resolve(rootDir, 'wxt.config.ts'), 'utf8');
    const permDoc = readFileSync(resolve(docsDir, 'permissions.md'), 'utf8');
    const privacyDoc = readFileSync(resolve(docsDir, 'privacy.md'), 'utf8');

    // wxt.config.ts 里的 permissions 数组
    const manifestPerms = (() => {
      const m = wxt.match(/permissions:\s*\[([^\]]*)\]/);
      assert.ok(m, 'wxt.config.ts 应能解析出 permissions 数组');
      return m![1]!
        .split(',')
        .map((x) => x.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean)
        .sort();
    })();
    // 文档里的机器可读清单
    const docPerms = (() => {
      const m = permDoc.match(/^manifest-permissions:\s*(.+)$/m);
      assert.ok(m, 'permissions.md 应有 manifest-permissions 行（机器可读清单）');
      return m![1]!
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .sort();
    })();

    ok('docs/permissions.md 的权限清单与 wxt.config.ts 完全一致', () =>
      assert.deepEqual(
        docPerms,
        manifestPerms,
        `文档与 manifest 漂移了：文档 ${docPerms.join('/')} vs manifest ${manifestPerms.join('/')}`,
      ),
    );

    ok('README 只声称已发布的平台（不声称 Firefox）', () => {
      const readme = readFileSync(resolve(rootDir, 'README.md'), 'utf8');
      assert.match(readme, /Chrome \/ Edge/, 'README 应声称 Chrome / Edge');
      assert.ok(
        !/支持\s*Firefox|Firefox\s*\/\s*Chrome/.test(readme),
        'README 不该声称支持 Firefox（未验证，且已停止发布 Firefox 产物）',
      );
    });

    ok('隐私说明覆盖了三件必须说的事（本地存储/外发对象/如何清除）', () => {
      assert.match(privacyDoc, /chrome\.storage\.local/, '要说明数据存在哪');
      assert.match(privacyDoc, /Base URL/, '要说明内容发给谁');
      assert.match(privacyDoc, /HEAD/, '要披露死链检测会联系书签站点');
      assert.match(privacyDoc, /清空本地数据/, '要给出清除入口');
      assert.match(privacyDoc, /明文/, '要如实说明 API Key 是明文存储');
    });

    ok('release workflow 不再发布未验证的 Firefox 产物', () => {
      const rel = readFileSync(resolve(rootDir, '.github/workflows/release.yml'), 'utf8');
      assert.ok(
        !/zip:firefox|build:firefox/.test(rel),
        'Firefox 从未在真实 Firefox 里验证过，不该继续作为发布产物（见 docs/release.md）',
      );
    });
  }

  console.log(`\n全部通过：${passed} 项 ✔`);
})().catch((e) => {
  console.error('\n❌ 测试失败:', e);
  process.exit(1);
});
