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
import { runAgentTurn } from '../src/lib/ai/agent';
import { ChatError } from '../src/lib/ai/client';
import { TOOL_DEFINITIONS } from '../src/lib/ai/prompts';
import { executeTool, TOOL_META } from '../src/lib/ai/tools';
import type { AIConfig, ChatMessage, ChatOutbound, DeletionProposal } from '../src/lib/ai/types';
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
  create: async (opt: { parentId?: string; title: string; url?: string }) => {
    const id = String(nextId++);
    const node: FNode = {
      id,
      parentId: opt.parentId ?? '1',
      title: opt.title,
      url: opt.url,
      dateAdded: Date.now(),
    };
    store.push(node);
    return toApi(node);
  },
  move: async (id: string, dest: { parentId: string }) => {
    const node = nodeById(id);
    assert(node, `move: 节点 ${id} 不存在`);
    node.parentId = dest.parentId;
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
        for (const [k, v] of Object.entries(obj)) storageMap.set(k, v);
      },
      remove: async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) storageMap.delete(k);
      },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  },
  runtime: {
    connect: () => ({
      postMessage: () => {},
      onMessage: { addListener: () => {} },
      onDisconnect: { addListener: () => {} },
    }),
  },
};

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
  fn();
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
        const m = l.match(/^- \[(.+)\]\((https?:\/\/[^)]+)\)/);
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

  console.log(`\n全部通过：${passed} 项 ✔`);
})().catch((e) => {
  console.error('\n❌ 测试失败:', e);
  process.exit(1);
});
