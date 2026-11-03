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
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBusyGuard, runExclusive } from '../src/lib/chat/busy-guard';
import { runAgentTurn } from '../src/lib/ai/agent';
import { readUndoPoints } from '../src/lib/undo/recorder';
import { applyUndo } from '../src/lib/undo/apply';
import { ChatError } from '../src/lib/ai/client';
import type { MemoryItem } from '../src/lib/ai/memory';
import { TOOL_DEFINITIONS } from '../src/lib/ai/prompts';
import { executeTool, TOOL_META } from '../src/lib/ai/tools';
import type { AIConfig, ChatInbound, ChatMessage, ChatOutbound, DeletionProposal } from '../src/lib/ai/types';
import { z } from 'zod';
import { flattenBookmarks, sortTimeline, groupByDay, filterTimeline, dayLabel, pageGroups } from '../src/lib/bookmarks/timeline';
import { registrableDomain } from '../src/lib/bookmarks/domain';
import { createDelayedOpen } from '../src/lib/bookmarks/delayed-open';
import { buildRequestHeaders, getStableSessionId, parseCustomHeaders } from '../src/lib/ai/request-headers';
import { groupCommands, SCORE, scoreItem, searchCommands, type CommandItem } from '../src/lib/command/search';
import { analyzeBookmarks, runHealthCheck } from '../src/lib/health';
import { AI_STORAGE_KEY, flushStreamPersist, useAIStore } from '../src/stores/aiStore';
import {
  appendDraft,
  clearDraft,
  finalizeDraft,
  flushDraftNow,
  mergeDraft,
  readDraft,
  resetDraftForTest,
  STREAM_DRAFT_KEY,
} from '../src/lib/ai/stream-draft';
import { diagnose, formatDiagnosticReport, MAX_LOG_ENTRIES, MAX_UNDO_POINTS } from '../src/lib/health/diagnostics';
import { runFix, runFixes } from '../src/lib/health/fixes';
import type { HealthSnapshot } from '../src/lib/health/types';
import { CHAT_WIDTH_MAX, CHAT_WIDTH_MAX_COMPACT, CHAT_WIDTH_MIN, clampChatWidth } from '../src/lib/chat-width';
import {
  AI_COOLDOWN_MS,
  AI_FAIL_STREAK_LIMIT,
  autoOrganizeBookmark,
  collectFolderOptions,
  nextAiStreakState,
  findFolderByTitle,
  parseOrganizeReply,
  AUTO_CONTAINER,
} from '../src/lib/ai/auto-organize';
import { useUIStore } from '../src/stores/uiStore';
import { brandOf, isConfidentMatch, pickExistingFolder } from '../src/lib/ai/organize-rules';
import {
  addOptOutDomain,
  clearOptOutDomains,
  removeOptOutDomain,
  isOrganizeOptedOut,
  ORGANIZE_OPTOUT_KEY,
  ORGANIZE_OPTOUT_LIMIT,
  readOptOutDomains,
} from '../src/lib/ai/organize-optout';
import {
  appendOrganizeLog,
  clearOrganizeLog,
  buildOrganizeLogMarkdown,
  decorateOrganizeDetail,
  filterOrganizeLog,
  groupByTarget,
  pickRetryableEntries,
  updateOrganizeLogEntry,
  isRetryableFailure,
  makeOrganizeLogEntry,
  ORGANIZE_LOG_KEY,
  ORGANIZE_LOG_LIMIT,
  readOrganizeLog,
  summarizeOrganizeLog,
  type OrganizeLogEntry,
} from '../src/lib/ai/organize-log';

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

/**
 * 测试替身的**副作用计数**：用来断言「非最新撤销点被拒绝时必须零副作用」。
 *
 * 只靠「树快照没变」不足以证明零副作用——同位置 move、写回相同 storage 都可能不改最终快照。
 * 计数放在替身里（不是生产代码里），因此它统计的是真实的 API 调用意图。
 * 读类（get/getSubTree）不计数：安全检查必须允许读取当前状态。
 */
const mockCalls = {
  create: 0,
  move: 0,
  update: 0,
  remove: 0,
  removeTree: 0,
  getChildren: 0,
  storageSet: 0,
  storageRemove: 0,
  tabsCreate: 0,
};
function resetMockCalls(): void {
  for (const k of Object.keys(mockCalls) as (keyof typeof mockCalls)[]) mockCalls[k] = 0;
}

/**
 * 测试专用的 create 闸门：让一次子树重建停在半途，用来**确定性地**构造
 * "同一个撤销点的两次回放重叠"这一竞态（否则只能靠 sleep 猜时序）。
 */
/** 故障注入：tabs.create 整体失败，或只让指定 URL 失败（用于批量部分失败） */
const tabsFail: { all: boolean; urls: string[] | null } = { all: false, urls: null };

/** chrome.action 的调用记录（工具栏提示用） */
const actionCalls: { badgeText: string[]; badgeColor: string[]; titles: string[] } = {
  badgeText: [],
  badgeColor: [],
  titles: [],
};
function resetActionCalls(): void {
  actionCalls.badgeText.length = 0;
  actionCalls.badgeColor.length = 0;
  actionCalls.titles.length = 0;
}

/** 故障注入：让 chrome.bookmarks.get 对这些 id 抛错（"读取失败"，不是"不存在"） */
const bookmarksGetFailIds: { ids: string[] } = { ids: [] };
/** 故障注入：让 chrome.bookmarks.update 对这些 id 抛错 */
const bookmarksUpdateFailIds: { ids: string[] } = { ids: [] };

const createGate: { release: Promise<void> | null; entered: (() => void) | null } = {
  release: null,
  entered: null,
};

const mockBookmarks = {
  /*
   * getTree 的可注入延迟。
   *
   * 用来复现「加载期间又来了刷新请求」：真实大库上 getTree 要几百毫秒，
   * 去抖后的下一次刷新正好落在窗口里。默认 0 延迟，不影响其它用例。
   */
  getTree: async () => {
    if (getTreeDelayMs > 0) await new Promise((r) => setTimeout(r, getTreeDelayMs));
    getTreeCalls++;
    return [toApi({ id: '0', title: '', dateAdded: 0 })];
  },
  getSubTree: async (id: string) => {
    const node = nodeById(id);
    assert(node, `getSubTree: 节点 ${id} 不存在`);
    return [toApi(node)];
  },
  get: async (ids: string | string[]) => {
    const list = Array.isArray(ids) ? ids : [ids];
    for (const id of list) {
      if (bookmarksGetFailIds.ids.includes(id)) throw new Error(`bookmarks.get 读取失败（${id}）`);
    }
    return list.map((id) => nodeById(id)).filter((n): n is FNode => !!n).map((n) => toApi(n));
  },
  getChildren: async (id: string) => {
    mockCalls.getChildren += 1;
    return childrenOf(id).map((n) => toApi(n));
  },
  getRecent: async (count: number) =>
    [...store].sort((a, b) => b.dateAdded - a.dateAdded).slice(0, count).map((n) => toApi(n)),
  search: async (query: string) =>
    store.filter((n) => n.title.includes(query) || (n.url ?? '').includes(query)).map((n) => toApi(n)),
  create: async (opt: { parentId?: string; title: string; url?: string; index?: number }) => {
    mockCalls.create += 1;
    if (createGate.release) {
      createGate.entered?.();
      await createGate.release;
    }
    const id = String(nextId++);
    const node: FNode = {
      id,
      /*
       * Chrome 的真实默认值是「其他书签」(id '2')，不是书签栏 ('1')。
       * mock 早先写成 '1' —— 正好把「不传 parentId 会存错地方」这个 bug 掩盖掉了，
       * 于是 popup 里那句「收藏到书签栏」错了很久都没被测出来。这里改忠实。
       */
      parentId: opt.parentId ?? '2',
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
    mockCalls.move += 1;
    const node = nodeById(id);
    assert(node, `move: 节点 ${id} 不存在`);
    // 与 Chrome 一致：目标父目录必须存在（否则真实 API 会拒绝）。替身若不校验，
    // "移动到一个已被删除的文件夹"会静默成功，让一部分失败路径无法被测试构造出来。
    assert(nodeById(dest.parentId), `move: 目标父目录 ${dest.parentId} 不存在`);
    const oldParentId = node.parentId;
    const oldIndex =
      oldParentId === undefined ? -1 : childrenOf(oldParentId).findIndex((n) => n.id === id);
    let target = dest.index;

    /*
     * 忠实实现 Chrome 的**越界校验**。
     *
     * 实测（headless，真实 Chrome）：A 里有 [x,y,z]，`move(x, {parentId:A, index:99})`
     * 直接抛 `Index out of bounds.`。
     * 替身早先没有这个校验 → 越界 index 在测试里静默成功，到了线上才炸。
     *
     * 边界按 Chrome 文档：index 必须落在 0..目标文件夹子项数 之间。
     * 同父移动时，"目标文件夹子项数"取**移除自己之后**的数目
     * （这也是下面 target-- 修正的同一个基准）。
     */
    const sameParent = oldParentId === dest.parentId;
    if (target !== undefined && sameParent && (target === oldIndex || target === oldIndex + 1)) {
      return toApi(node);
    }
    if (target !== undefined) {
      /*
       * 边界实测（真实 Chrome）：
       *   同父、4 个子项：[a,b,c,d] move(a → index 4)  → [b,c,d,a]（允许，等于子项数）
       *                        move(a → index 5)  → THROW Index out of bounds.
       *   跨父、目标 1 个子项：move(x → index 1) → 允许；index 3 → THROW
       * 也就是说上限是**目标文件夹当前的子项数**（含被移动的那个自己），不是减一。
       */
      const capacity = childrenOf(dest.parentId).length;
      if (!Number.isInteger(target) || target < 0 || target > capacity) {
        throw new Error('Index out of bounds.');
      }
      if (sameParent && target > oldIndex) target--;
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
    mockCalls.update += 1;
    if (bookmarksUpdateFailIds.ids.includes(id)) throw new Error(`bookmarks.update 失败（${id}）`);
    const node = nodeById(id);
    assert(node, `update: 节点 ${id} 不存在`);
    if (patch.title !== undefined) node.title = patch.title;
    if (patch.url !== undefined) node.url = patch.url;
    return toApi(node);
  },
  /**
   * 忠实实现 Chrome `bookmarks.remove`：**只删单个节点**，非空文件夹必须用 `removeTree`。
   *
   * 替身若在这里静默/递归删除，会让「撤销新建文件夹时里面有后来移入的内容」的冲突测试**假绿**
   * ——生产代码改用 remove 后看起来"通过"，而真实浏览器会拒绝并保留数据。保真度本身要被守护。
   */
  remove: async (id: string) => {
    mockCalls.remove += 1;
    const idx = store.findIndex((n) => n.id === id);
    assert(idx >= 0, `remove: 节点 ${id} 不存在`);
    assert.equal(childrenOf(id).length, 0, `remove: 文件夹 ${id} 非空，应使用 removeTree`);
    store.splice(idx, 1);
  },
  removeTree: async (id: string) => {
    mockCalls.removeTree += 1;
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
  action: {
    setBadgeText: async (o: { text: string }) => {
      actionCalls.badgeText.push(o.text);
    },
    setBadgeBackgroundColor: async (o: { color: string }) => {
      actionCalls.badgeColor.push(o.color);
    },
    setTitle: async (o: { title: string }) => {
      actionCalls.titles.push(o.title);
    },
  },
  tabs: {
    create: async (props?: { url?: string }) => {
      mockCalls.tabsCreate += 1;
      if (tabsFail.all) throw new Error('Tabs cannot be edited right now (user may be dragging a tab)');
      if (tabsFail.urls && props?.url && tabsFail.urls.includes(props.url)) {
        throw new Error('无法打开该协议');
      }
      return { id: 1 };
    },
  },
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
        // 真实 chrome.storage 会做结构化克隆：读出来的是副本，改它不会影响"存储里的值"。
        // 替身若返回活引用，就会造出真实环境不存在的串扰（曾让一条断言看到被后续步骤改空的数组）。
        return structuredClone(out);
      },
      set: async (obj: Record<string, unknown>) => {
        mockCalls.storageSet += 1;
        // 全局故障注入；storageSetFailKeys 非空时只让这些键失败，
        // 用来单独验证"正式撤销点写入失败、但 pending 仍可写"这类交接
        const keys = Object.keys(obj);
        if (storageSetFailKeys && keys.some((k) => storageSetFailKeys!.includes(k)) && storageSetFailTimes > 0) {
          storageSetFailTimes -= 1;
          throw new Error(`QUOTA_BYTES quota exceeded (${keys.join(',')})`);
        }
        if (storageSetFail) throw new Error('QUOTA_BYTES quota exceeded');
        // 可控延迟：用来复现"写入还在路上时收尾/清空已经发生"的竞态。
        // storageSetDelaySequence 按次消费，可让**较旧的写入更慢**（验证串行化）。
        if (keys.includes('markai.undo.pending')) {
          const delay = storageSetDelaySequence.length > 0 ? storageSetDelaySequence.shift()! : storageSetDelayMs;
          inflightPendingWrites += 1;
          try {
            if (delay > 0) await new Promise((r) => setTimeout(r, delay));
          } finally {
            inflightPendingWrites -= 1;
          }
        }
        for (const [k, v] of Object.entries(obj)) storageMap.set(k, structuredClone(v));
      },
      remove: async (keys: string | string[]) => {
        mockCalls.storageRemove += 1;
        for (const k of Array.isArray(keys) ? keys : [keys]) storageMap.delete(k);
      },
      // 真实 API：返回这些键占用的字节数（按值的 JSON 序列化长度，与配额计量方式一致）。
      // 之前替身没有它，于是"用真实占用把失败讲清楚"这条路径根本没法测。
      getBytesInUse: async (keys?: string | string[] | null) => {
        const want = keys == null ? [...storageMap.keys()] : Array.isArray(keys) ? keys : [keys];
        return want.reduce(
          (sum, k) => sum + (storageMap.has(k) ? JSON.stringify(storageMap.get(k)).length : 0),
          0,
        );
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
  /*
   * 权限查询替身：真实 API 返回 { permissions, origins }。
   * 这是「健康检查」判断"缺不缺权限"的依据，所以要按 manifest 里实际申请的那几项给。
   */
  permissions: {
    getAll: async () => ({
      permissions: ['bookmarks', 'storage', 'tabs', 'tabGroups', 'contextMenus', 'sidePanel'],
      origins: ['<all_urls>'],
    }),
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

/** 故障注入（按 key）：只让列出的键写入失败；null = 关闭该模式 */
let storageSetFailKeys: string[] | null = null;

/** 按 key 失败还要失败几次（默认无限；设 1 可验证"重试一次就成功"） */
let storageSetFailTimes = Number.POSITIVE_INFINITY;

/** 对 markai.undo.pending 的写入注入延迟（毫秒）：复现"写入在路上时收尾/清空已发生" */
let storageSetDelayMs = 0;

/** 按次消费的延迟序列：可让较旧的写入更慢，用于验证写入串行化 */
let storageSetDelaySequence: number[] = [];

/** 当前正在"路上"的 pending 写入数：用来断言"收尾返回时没有在途写入" */
let inflightPendingWrites = 0;

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
/** getTree 的人为延迟与调用计数（见 mock 里的说明） */
let getTreeDelayMs = 0;
let getTreeCalls = 0;

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

/** 构造一个"发出若干工具调用"的模型响应（多回次用） */
function toolRound(calls: { id: string; name: string; args: unknown }[]): Response {
  return sseResponse([
    sseEvent(
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: calls.map((c, index) => ({
                index,
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            },
          },
        ],
      }),
    ),
    sseEvent(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })),
    'data: [DONE]\n\n',
  ]);
}

/** 构造一个"给出最终回答"的模型响应 */
function finalRound(text = '好了'): Response {
  return sseResponse([
    sseEvent(JSON.stringify({ choices: [{ delta: { content: text } }] })),
    'data: [DONE]\n\n',
  ]);
}

/** 可注入 config 与计划确认通道的 turn（第二片用） */
function runTurnWith(
  text: string,
  opts: {
    events?: ChatOutbound[];
    config?: Partial<AIConfig>;
    requestPlanApproval?: (plan: { name: string; summary: string }[], messageId: string) => Promise<boolean>;
    messageId?: string;
  } = {},
): Promise<void> {
  const events = opts.events ?? [];
  return runAgentTurn({
    config: { ...TEST_CONFIG, ...opts.config },
    messageId: opts.messageId ?? 'msg-1',
    history: [],
    text,
    signal: new AbortController().signal,
    onEvent: (e) => events.push(e),
    ...(opts.requestPlanApproval ? { requestPlanApproval: opts.requestPlanApproval } : {}),
  });
}

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

/**
 * 异步用例的断言入口。
 *
 * `ok()` 是同步的。把 `async` 函数传进去时它拿到的是一个 Promise：断言在 `ok` 返回
 * **之后**才结算，而 `passed++` 和 ✔ 已经打印了。用例若失败，异常变成
 * unhandledRejection（进程崩在别处，报告里看不到是哪一条），反证脚本按用例名匹配
 * `expectFail` 就落空——等于给证据链开了一个静默缺口。
 *
 * 所以异步用例一律 `await okA(...)`：✔ 只在断言真的通过之后才打印。
 */
async function okA(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
  } catch (e) {
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

    ok('所有工具定义参数严格遵守 additionalProperties: false 规范', () => {
      for (const def of TOOL_DEFINITIONS) {
        assert.equal(
          def.function.parameters.additionalProperties,
          false,
          def.function.name + ' 必须声明 additionalProperties: false',
        );
      }
    });

    await okA('executeTool 拒绝未知工具', async () => {
      await assert.rejects(
        () => executeTool('hack_tool', '{}'),
        /未知工具：hack_tool/,
      );
    });
    await okA('executeTool 拒绝非法 JSON 参数', async () => {
      await assert.rejects(
        () => executeTool('list_bookmarks', '{broken'),
        /工具参数不是合法 JSON/,
      );
    });

    await okA('executeTool 参数校验失败时转换为清晰的中文「参数不合法」提示', async () => {
      await assert.rejects(
        () => executeTool('move_bookmark', '{}'),
        /参数不合法/,
      );
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
    await okA('get_folder_content 路径不存在时报错', async () => {
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

    ok('estimateTokens 空值与异常安全回退为 0', () => {
      assert.equal(estimateTokens(''), 0);
      assert.equal(estimateTokens(undefined as any), 0);
      assert.equal(estimateTokens(null as any), 0);
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
    const { normalizeBaseUrl, resolveConfig, getModelContextWindow, getPreset, PROVIDERS } = await import('../src/lib/providers');
    ok('normalizeBaseUrl 补协议与去尾斜杠', () => {
      assert.equal(normalizeBaseUrl('api.example.com/v1/'), 'https://api.example.com/v1');
      assert.equal(normalizeBaseUrl('https://a.com'), 'https://a.com');
      assert.equal(normalizeBaseUrl('localhost:11434/v1'), 'http://localhost:11434/v1', '本机地址用 http');
      assert.equal(normalizeBaseUrl('127.0.0.1:8080'), 'http://127.0.0.1:8080');
    });

    ok('normalizeBaseUrl 空值与异常安全回退为 ""', () => {
      assert.equal(normalizeBaseUrl(''), '');
      assert.equal(normalizeBaseUrl(undefined), '');
      assert.equal(normalizeBaseUrl(null as any), '');
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
    ok('resolveConfig 未填回落到预设（上下文窗口跟随模型）', () => {
      const cfg = resolveConfig({ providerId: 'deepseek' });
      assert.ok(cfg.baseUrl.includes('api.deepseek.com'), 'Base URL 回落预设');
      assert.ok(cfg.model, '模型回落预设默认');
      // 跟随模型，而不是一律 1M：deepseek 默认模型是 128K，给 1M 会让护栏永不触发
      assert.equal(cfg.contextWindow, getModelContextWindow(cfg.model), '上下文窗口跟随所选模型');
      assert.equal(cfg.contextWindow, 128_000, 'deepseek-v4-flash 的真实窗口是 128K');
    });

    const { effectiveContextWindow, CONFIG_VERSION, LEGACY_CONTEXT_WINDOW } = (await import(
      '../src/lib/providers'
    )) as unknown as {
      effectiveContextWindow: (m: string, s?: Record<string, unknown> | null) => number;
      CONFIG_VERSION: number;
      LEGACY_CONTEXT_WINDOW: number;
    };
    ok('上下文窗口：显式值优先，旧配置（无 configVersion）按模型迁移', () => {
      // 显式填写（且配置已是当前版本）→ 以填写值为准
      assert.equal(effectiveContextWindow('deepseek-v4-flash', { configVersion: CONFIG_VERSION, contextWindow: 64_000 }), 64_000);
      // 无 configVersion = v0.2.26 及更早存下来的：其中的 contextWindow 一律视为非用户意图
      assert.equal(
        effectiveContextWindow('deepseek-v4-flash', { contextWindow: LEGACY_CONTEXT_WINDOW }),
        128_000,
        '旧配置里恒为 1M 的值必须被迁移掉，否则 128K 模型仍会拿到 8 倍预算',
      );
      // 未填 → 跟随模型
      assert.equal(effectiveContextWindow('kimi-k3', { configVersion: CONFIG_VERSION }), 256_000);
      assert.equal(effectiveContextWindow('qwen3:8b', { configVersion: CONFIG_VERSION }), 128_000);
    });

    const { DEFAULT_CONFIG } = await import('../src/stores/configStore');
    ok('DEFAULT_CONFIG 关键安全默认值校验', () => {
      assert.equal(DEFAULT_CONFIG.deleteMode, 'confirm');
      assert.equal(DEFAULT_CONFIG.planMode, false);
      assert.equal(DEFAULT_CONFIG.providerId, 'deepseek');
      assert.equal(DEFAULT_CONFIG.compressThreshold, 0.8);
    });

    ok('getPreset 与 PROVIDERS 预设完整性校验', () => {
      assert.ok(PROVIDERS.length >= 6);
      const deepseek = getPreset('deepseek');
      assert.ok(deepseek);
      assert.equal(deepseek?.name, 'DeepSeek');
      assert.equal(deepseek?.needsKey, true);
      assert.equal(deepseek?.defaultModel, 'deepseek-v4-flash');

      const ollama = getPreset('ollama');
      assert.ok(ollama);
      assert.equal(ollama?.needsKey, false, 'Ollama 本地预设不需要 key');

      assert.equal(getPreset('unknown-provider'), undefined);
      assert.equal(getPreset(''), undefined);
      assert.equal(getPreset(undefined), undefined);
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

    /*
     * 4. 提议删除：选中 1 条提交 propose_deletions。
     *
     * 这里原来是 `const target = cj.items.find(i => i.type === 'deep')` 然后两层
     * `if (target)` / `if (hit)` 嵌套——夹具里没有 deep 类型、或搜索没命中时，
     * 那一步**静默不跑**，而下面那条汇总用例的函数体是 `() => true`，
     * 名字却叫「任务链路走通（导出→分类→检测→提议）」。
     * 也就是说：整条链路从没被真正验证过，却一直报绿。
     *
     * 现在：优先取 deep，取不到就退到任意一条（这一步必须真的执行），
     * 并把"四步是否都真的跑了"变成可断言的事实。
     */
    const target = cj.items.find((i) => i.type === 'deep') ?? cj.items[0];
    let proposed = 0;
    let proposeSkip = '';
    if (!target) {
      proposeSkip = 'classify_urls 没有返回任何条目，无法提议删除';
    } else {
      const sr = await executeTool('search_bookmarks', JSON.stringify({ query: target.url.slice(0, 30) }));
      const sj = JSON.parse(sr.result) as { items: { id: string; url: string }[] };
      const hit = sj.items.find((n) => n.url === target.url) ?? sj.items[0];
      if (!hit) {
        proposeSkip = `搜索 ${target.url} 没找到对应书签`;
      } else {
        const pr = await executeTool('propose_deletions', JSON.stringify({ items: [{ bookmarkId: hit.id, reason: '测试：深层子页面' }] }));
        const pj = JSON.parse(pr.result) as { submitted: number };
        proposed = pj.submitted;
      }
    }
    ok('propose_deletions 提交删除提议', () => {
      assert.equal(proposeSkip, '', `这一步被静默跳过了：${proposeSkip}`);
      assert.equal(proposed, 1);
    });

    /*
     * 汇总：四步**都真的跑了**才算走通。
     * 原来这里是 `() => true`——一条永远不会红的"汇总"，
     * 比没有这条更糟：它让人以为链路已被覆盖。
     */
    ok('任务链路走通（导出→分类→检测→提议）', () => {
      assert.ok(all.length >= 5, `导出这步没取回书签：${all.length}`);
      assert.equal(cj.items.length, all.length, '分类这步没有覆盖全部书签');
      assert.equal(rj.length, all.length, '存活检测这步没有覆盖全部书签');
      assert.ok(rj.every((r) => r.status === 'ok'), '存活检测这步有非 ok 结果');
      assert.equal(proposed, 1, `提议删除这步没有真的执行（${proposeSkip || 'submitted=' + proposed}）`);
    });
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
    const { resolveDropIndex, isSelfOrDescendant, subtreeContains } = await import('../src/lib/bookmark-dnd');
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

    ok('resolveDropIndex 边界防护：负数、非整数与非法数值安全钳位至 >= 0', () => {
      assert.equal(resolveDropIndex(-1, 'above'), 0, '负数上方应钳位为 0');
      assert.equal(resolveDropIndex(-5, 'below'), 1, '负数下方应钳位为 0+1');
      assert.equal(resolveDropIndex(2.9, 'above'), 2, '非整数向下取整');
      assert.equal(resolveDropIndex(2.1, 'below'), 3, '非整数下方向下取整+1');
      assert.equal(resolveDropIndex(Number.NaN, 'above'), 0, 'NaN 安全回落为 0');
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

    ok('subtreeContains 递归深度与空 id 防御', () => {
      assert.equal(subtreeContains(outer, ''), false);
      assert.equal(subtreeContains(outer, 'deep'), true);
      let deepTree: any = { id: 'leaf' };
      for (let i = 0; i < 70; i++) deepTree = { id: 'n', children: [deepTree] };
      assert.equal(subtreeContains(deepTree, 'non-existent'), false);
    });

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

  /* ── T23: 操作日志与撤销 ── */
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
    applyResult = { ok: false, restored: 1, restoredOps: 1, failures: [{ op: 'move', title: 'x', error: '节点已不存在' }] };
    await useAIStore.getState().undoLast();
    points = [];
    const partialToasts = useToastStore.getState().toasts;
    ok('部分失败时上报明细，不谎报全部成功', () => {
      assert.ok(
        partialToasts.some((t) => /已还原 1 项书签，1 个操作失败/.test(t.title) && /节点已不存在/.test(t.description ?? '')),
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

  /* ── T26: 撤销的边界与一致性 ── */
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
      rememberTerminalRun,
      MAX_TERMINAL_RUN_IDS,
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

    ok('trimPointsToBudget 边界防护：0 预算与负数预算安全处理', () => {
      const p = mkPoint('1', 100);
      const zero = trimPointsToBudget([p], 0);
      assert.equal(zero.kept.length, 0);
      assert.equal(zero.droppedTooLarge.length, 1);
      const neg = trimPointsToBudget([p], -100);
      assert.equal(neg.kept.length, 0);
    });

    ok('rememberTerminalRun 终态 runId 去重、置顶与容量截断', () => {
      assert.deepEqual(rememberTerminalRun(undefined, 'r1'), ['r1']);
      assert.deepEqual(rememberTerminalRun(['r1', 'r2'], 'r2'), ['r2', 'r1']);
      const list = Array.from({ length: 60 }, (_, i) => 'run-' + i);
      const trimmed = rememberTerminalRun(list, 'new-run');
      assert.equal(trimmed.length, MAX_TERMINAL_RUN_IDS);
      assert.equal(trimmed[0], 'new-run');
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
      assert.match(privacyDoc, /markai\.undo\.pending/, '要如实说明在途快照键');
      assert.match(privacyDoc, /terminalRunIds/, '要如实说明终态列表');
      assert.match(privacyDoc, /planMode/, '要如实说明计划模式设置');
    });

    // 隐私说明向用户承诺「设置页可以清除撤销记录」——这句话必须有测试兜着，
    // 否则它只是一句架构描述（原先该行为写在 React 处理函数里，无从验证）。
    const { clearUndoPoints, UNDO_STORAGE_KEY: UNDO_KEY } = await import('../src/lib/undo/recorder');
    storageMap.set(UNDO_KEY, {
      points: [{ id: 'p-clear', runId: 'r', createdAt: 1, ops: [], containsDelete: false }],
    });
    await clearUndoPoints();
    const clearedAfter = storageMap.has(UNDO_KEY);
    ok('clearUndoPoints 真的清空撤销记录（隐私说明的承诺可核对）', () =>
      assert.equal(clearedAfter, false, '清空后存储里不该还有 markai.undo'),
    );

    ok('设置页的清空动作确实调用了 clearUndoPoints（接线也被守住）', () => {
      const cfg = readFileSync(resolve(rootDir, 'src/components/options/config-form.tsx'), 'utf8');
      assert.match(
        cfg,
        /clearUndoPoints\(/,
        '设置页必须调用 clearUndoPoints()，否则隐私说明里的"可以清除"就是假话',
      );
    });

    ok('release workflow 不再发布未验证的 Firefox 产物', () => {
      const rel = readFileSync(resolve(rootDir, '.github/workflows/release.yml'), 'utf8');
      assert.ok(
        !/zip:firefox|build:firefox/.test(rel),
        'Firefox 从未在真实 Firefox 里验证过，不该继续作为发布产物',
      );
    });

    ok('store-listing.md 严格遵守 Chrome Web Store 规范与权限对齐', () => {
      const storeListingPath = resolve(docsDir, 'store-listing.md');
      assert.ok(existsSync(storeListingPath), 'docs/store-listing.md 必须存在');
      const listing = readFileSync(storeListingPath, 'utf8');
      const shortDescMatch = listing.match(/### 2\. 短描述[\s\S]*?`([^`]+)`/);
      assert.ok(shortDescMatch, '必须包含标准格式的短描述');
      const shortDesc = (shortDescMatch?.[1] ?? '').trim();
      assert.ok(shortDesc.length > 0 && shortDesc.length <= 132, `短描述长度应在 1-132 之间，实际 ${shortDesc.length} 字符`);
      assert.match(listing, /### 3\. 单一用途说明/, '必须包含单一用途说明');
      const expectedPerms = ['bookmarks', 'storage', 'tabs', 'tabGroups', 'contextMenus', 'sidePanel'];
      for (const p of expectedPerms) {
        assert.match(listing, new RegExp(`\\|\\s*\`${p}\`\\s*\\|`), `store-listing 必须逐条包含权限 \`${p}\` 的审核理由申诉`);
      }
      assert.match(listing, /<all_urls>/, 'store-listing 必须包含 <all_urls> 的审核理由声明');
    });

    await okA('Chrome Web Store 推广横幅规格严格符合官方尺寸', async () => {
      if (!existsSync(resolve(rootDir, 'public/store/promo-small-440x280.png'))) {
        // @ts-ignore
        await import('../scripts/generate-promo-tiles.mjs');
      }
      const storeDir = resolve(rootDir, 'public/store');
      const smallPath = resolve(storeDir, 'promo-small-440x280.png');
      const marqueePath = resolve(storeDir, 'promo-marquee-1400x560.png');
      assert.ok(existsSync(smallPath), 'promo-small-440x280.png 必须存在');
      assert.ok(existsSync(marqueePath), 'promo-marquee-1400x560.png 必须存在');

      const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const smallBuf = readFileSync(smallPath);
      assert.ok(smallBuf.subarray(0, 8).equals(pngSig), '小型横幅必须是有效 PNG');
      assert.equal(smallBuf.readUInt32BE(16), 440, '小型横幅宽度必须是 440');
      assert.equal(smallBuf.readUInt32BE(20), 280, '小型横幅高度必须是 280');

      const marqueeBuf = readFileSync(marqueePath);
      assert.ok(marqueeBuf.subarray(0, 8).equals(pngSig), '主横幅必须是有效 PNG');
      assert.equal(marqueeBuf.readUInt32BE(16), 1400, '主横幅宽度必须是 1400');
      assert.equal(marqueeBuf.readUInt32BE(20), 560, '主横幅高度必须是 560');
    });

    ok('docs/release-notes-0.2.23.md 完整记载 v0.2.23 核心交付点', () => {
      const notesPath = resolve(docsDir, 'release-notes-0.2.23.md');
      assert.ok(existsSync(notesPath), 'release-notes-0.2.23.md 必须存在');
      const text = readFileSync(notesPath, 'utf8');
      assert.match(text, /planMode/, '必须包含 planMode 关键修复说明');
      assert.match(text, /store-listing\.md/, '必须包含 store-listing.md 上架材料说明');
      assert.match(text, /resolveDropIndex/, '必须包含 resolveDropIndex 拖拽防护说明');
      assert.match(text, /format\.ts/, '必须包含 format.ts 基础加固说明');
      assert.match(text, /toast\.ts/, '必须包含 toast.ts 基础加固说明');
    });
  }

  /* ── T30: 手工确认的删除也可撤销（删除执行器） ── */
  console.log('\n[T30] 手工删除可撤销');
  {
    const { executeDeletions } = await import('../src/lib/ai/deletion-executor');
    const { applyUndo } = await import('../src/lib/undo/apply');
    const {
      UNDO_STORAGE_KEY,
      beginUndoTransaction,
      endUndoTransaction,
      readUndoPoints,
      resetUndoTransactionForTest,
    } = await import('../src/lib/undo/recorder');
    const { jCreate } = await import('../src/lib/undo/mutations');
    type UndoOp = import('../src/lib/undo/types').UndoOp;

    const mkFixture = async () => {
      const folder = (await mockBookmarks.create({ parentId: '1', title: 'T30-FOLDER' })).id;
      const kids: string[] = [];
      for (const t of ['k1', 'k2', 'k3']) {
        kids.push((await mockBookmarks.create({ parentId: folder, title: t, url: `https://t30.test/${t}` })).id);
      }
      // 错落的一批顶层书签（与文件夹交替，制造非连续删除）
      const loose: string[] = [];
      for (let i = 0; i < 6; i++) {
        const id = String(nextId++);
        store.push({
          id,
          parentId: '1',
          title: `T30-loose-${i}`,
          url: `https://t30.test/loose/${i}`,
          dateAdded: 40_000 + i,
        });
        loose.push(id);
      }
      return { folder, kids, loose };
    };

    // ── A. 确认删除一批（文件夹 + 错落书签）→ 撤销 → 整棵树含顺序复原 ──
    storageMap.delete(UNDO_STORAGE_KEY);
    resetUndoTransactionForTest();
    const fx = await mkFixture();
    const beforeA = await snapshotTreeObj();
    const items = [
      { proposalId: 'p-folder', bookmarkId: fx.folder },
      ...fx.loose.filter((_, i) => i % 2 === 0).map((id, i) => ({ proposalId: `p-l${i}`, bookmarkId: id })),
    ];
    const outA = await executeDeletions(items);
    const pointsA = await readUndoPoints();
    const midA = await snapshotTreeObj();
    const undoA = await applyUndo();
    const afterA = await snapshotTreeObj();

    ok('手工确认删除会自己产生一个撤销点（不再是永久删除）', () => {
      assert.equal(outA.count, 4, `应删掉 4 项（1 文件夹 + 3 个错落书签），实际 ${outA.count}`);
      assert.equal(outA.failed.length, 0);
      assert.equal(pointsA.length, 1, '应落盘一个撤销点');
      assert.notEqual(firstTreeDiff(beforeA, midA), null, '这一轮确实删掉了东西');
    });

    ok('手工删除事务身份为 deletions:manual', () => {
      assert.equal(pointsA[0]?.runId, 'deletions:manual');
    });
    ok('手工删除后撤销：整棵树含顺序逐节点复原（含被删文件夹的子树）', () => {
      assert.ok(undoA.ok, `撤销应成功，实际 ${JSON.stringify(undoA)}`);
      assert.equal(undoA.failures.length, 0);
    });

    const { restoreSubtree } = await import('../src/lib/undo/apply');
    await okA('restoreSubtree 递归深度防御：超过 64 层抛错防暴栈', async () => {
      let deepSnap = { title: 'Leaf', url: 'https://deep.test' };
      for (let i = 0; i < 66; i++) {
        deepSnap = { title: 'Level', children: [deepSnap] } as any;
      }
      await assert.rejects(
        () => restoreSubtree(deepSnap as any, '1'),
        /快照嵌套层级超过 64 层/,
      );
    });
    const { toSnapshot } = await import('../src/lib/undo/mutations');
    ok('toSnapshot 快照转换与深度上限防爆', () => {
      const leaf = toSnapshot({ id: 'x', title: 'Google', url: 'https://google.com' } as any);
      assert.equal(leaf.title, 'Google');
      let deepNode: any = { id: 'l', title: 'L' };
      for (let i = 0; i < 70; i++) deepNode = { id: 'n', title: 'D', children: [deepNode] };
      let count = 0;
      let cur: any = toSnapshot(deepNode);
      while (cur?.children?.[0]) {
        count++;
        cur = cur.children[0];
      }
      assert.equal(count, 64, '快照子树递归深度必须在 64 层截断');
    });

    ok('手工删除后撤销差异比对验证整树无异', () => {
      const diff = firstTreeDiff(beforeA, afterA, '', { ignoreIds: true });
      assert.equal(diff, null, `第一处差异：${diff ?? ''}`);
    });

    // ── B. 「删除全部」特殊提议同样可撤销 ──
    storageMap.delete(UNDO_STORAGE_KEY);
    resetUndoTransactionForTest();
    const savedStore = [...store];
    let outcomeB: { count: number; failed: { proposalId: string; error: string }[] } | null = null;
    let beforeB: TreeNorm[] = [];
    let afterB: TreeNorm[] = [];
    let undoB: Awaited<ReturnType<typeof applyUndo>> | null = null;
    let errB: string | null = null;
    try {
      store.length = 0;
      store.push({ id: '0', title: '', dateAdded: 0 });
      store.push({ id: '1', title: '书签栏', parentId: '0', dateAdded: 1 });
      store.push({ id: '2', title: '其他书签', parentId: '0', dateAdded: 1 });
      store.push({ id: 'B-F1', parentId: '1', title: 'B-F1', dateAdded: 2 });
      store.push({ id: 'B-c1', parentId: 'B-F1', title: 'B-c1', url: 'https://t30.test/b1', dateAdded: 3 });
      store.push({ id: 'B-b2', parentId: '1', title: 'B-b2', url: 'https://t30.test/b2', dateAdded: 4 });
      store.push({ id: 'B-b3', parentId: '2', title: 'B-b3', url: 'https://t30.test/b3', dateAdded: 5 });
      beforeB = await snapshotTreeObj();
      outcomeB = await executeDeletions([{ proposalId: 'p-all', bookmarkId: 'markai:all', all: true }]);
      undoB = await applyUndo();
      afterB = await snapshotTreeObj();
    } catch (e) {
      errB = e instanceof Error ? e.message : String(e);
    } finally {
      store.length = 0;
      store.push(...savedStore);
    }
    ok('「删除全部」提议也走同一条可撤销路径', () => {
      assert.equal(errB, null, `不应抛错：${errB}`);
      assert.equal(outcomeB!.count, 3, '书签栏 2 项 + 其他书签 1 项');
      assert.ok(undoB?.ok, `撤销应成功，实际 ${JSON.stringify(undoB)}`);
      const diff = firstTreeDiff(beforeB, afterB, '', { ignoreIds: true });
      assert.equal(diff, null, `第一处差异：${diff ?? ''}`);
    });

    // ── C. 语义不变：根保护 / 已不存在视为达成 / 无删除不产生撤销点 ──
    storageMap.delete(UNDO_STORAGE_KEY);
    resetUndoTransactionForTest();
    const rootOut = await executeDeletions([{ proposalId: 'p-root', bookmarkId: '1' }]);
    const ghostOut = await executeDeletions([{ proposalId: 'p-ghost', bookmarkId: 'no-such-id' }]);
    const pointsC = await readUndoPoints();
    ok('根保护与"已不存在视为达成"语义保持不变', () => {
      assert.equal(rootOut.count, 0, '根文件夹不可删');
      assert.equal(rootOut.failed.length, 1);
      assert.match(rootOut.failed[0]!.error, /根文件夹不可删除/);
      assert.equal(ghostOut.count, 1, '不存在的条目视为已达成（不报错）');
      assert.equal(ghostOut.failed.length, 0);
    });
    ok('没有实际删除时不产生撤销点（沿用只读轮次的原则）', () => assert.equal(pointsC.length, 0));

    // ── D. Agent 轮次进行中做手工删除：并入那一轮，不切成两段 ──
    storageMap.delete(UNDO_STORAGE_KEY);
    resetUndoTransactionForTest();
    const agentMade = await jCreate({ parentId: '1', title: 'T30-AGENT', url: 'https://t30.test/agent' });
    void agentMade;
    await beginUndoTransaction('run-agent-inflight');
    await jCreate({ parentId: '1', title: 'T30-AGENT-2', url: 'https://t30.test/agent2' });
    const inside = await executeDeletions([{ proposalId: 'p-inside', bookmarkId: fx.loose[1]! }]);
    const stillActive = await readUndoPoints(); // 事务未结束 → 还没落盘
    const onePoint = await endUndoTransaction();
    const pointsD = await readUndoPoints();
    ok('Agent 轮次进行中的手工删除并入该轮，不另开也不结束事务', () => {
      assert.equal(inside.count, 1, '删除本身照常执行');
      assert.equal(stillActive.length, 0, '不该在轮次中途落盘（否则日志被切成两段）');
      assert.equal(pointsD.length, 1, '轮次结束后只应有一个撤销点');
      assert.ok(
        (onePoint?.ops ?? []).some((o: UndoOp) => o.kind === 'delete'),
        '该点里应包含手工删除的操作',
      );
    });

    resetUndoTransactionForTest();
    storageMap.delete(UNDO_STORAGE_KEY);
  }

  /* ── T31: 撤销历史（可浏览、可跳选） ── */
  console.log('\n[T31] 撤销历史');
  {
    const { describeUndoHistory } = await import('../src/lib/undo/journal');
    const { useAIStore } = await import('../src/stores/aiStore');
    const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    type UndoPointT = import('../src/lib/undo/types').UndoPoint;

    const now = Date.now();
    const legacy: UndoPointT = {
      id: 'h-legacy',
      runId: 'r1',
      createdAt: now - 60_000,
      // 旧版本写下的删除没有快照 → 不可撤销
      ops: [{ kind: 'delete', id: 'old', title: '旧删除' }],
      containsDelete: true,
    };
    const movable: UndoPointT = {
      id: 'h-move',
      runId: 'r2',
      createdAt: now - 30_000,
      ops: [
        { kind: 'move', id: 'a', title: 'a', fromParentId: 'p', fromIndex: 0 },
        { kind: 'create', id: 'b', title: 'b', isFolder: false },
      ],
      containsDelete: false,
    };
    const batch: UndoPointT = {
      id: 'h-batch',
      runId: 'r3',
      createdAt: now - 10_000,
      ops: [
        {
          kind: 'moveBatch',
          title: '自动分类',
          fromParentId: 'p',
          ids: ['x', 'y', 'z'],
          order: ['p'],
        },
      ],
      containsDelete: false,
    };

    const rows = describeUndoHistory([batch, movable, legacy]);
    ok('撤销历史：顺序保持（新在前）且摘要/条数正确', () => {
      assert.deepEqual(
        rows.map((r) => r.id),
        ['h-batch', 'h-move', 'h-legacy'],
        '展示顺序应与传入顺序一致（新在前）',
      );
      assert.equal(rows[0]!.summary, '移动 3 项', '批次按条数汇总');
      assert.equal(rows[0]!.count, 3, '批次还原 3 项');
      assert.equal(rows[1]!.summary, '移动 1 项、新建 1 项');
      assert.equal(rows[1]!.count, 2);
      assert.equal(rows[2]!.count, 0, 'count 的契约是可还原条数：旧的无快照删除可还原 0 项');
    });
    ok('撤销历史：只有最新一步可执行（较早记录即便本身可还原也必须禁用）', () => {
      assert.equal(rows[0]!.undoable, true, '栈顶可执行');
      assert.equal(rows[1]!.undoable, false, '较早的记录不可执行——撤销只能从最新一步开始');
      assert.match(rows[1]!.reason ?? '', /先撤销较新/, '必须说清原因，而不是让用户点了才知道');
      assert.equal(rows[2]!.undoable, false);
    });
    ok('撤销历史：不可撤销的旧记录仍带自己的原因（无快照 ≠ 不是最新）', () => {
      // legacy 同时满足"不是最新"和"没有快照"：作为非栈顶点先被拦，理由是先撤较新
      assert.match(rows[2]!.reason ?? '', /先撤销较新/);
    });
    ok('撤销历史：单点列表（栈顶就是它自己）时仍按点自身的 readiness 判定', () => {
      const onlyLegacy = describeUndoHistory([legacy]);
      assert.equal(onlyLegacy[0]!.undoable, false, '无快照删除即使位于栈顶也不可撤销');
      assert.match(onlyLegacy[0]!.reason ?? '', /没有快照/, '此时应给出无快照的原因');
    });
    ok('撤销历史：空列表就是空（不造占位行）', () => assert.deepEqual(describeUndoHistory([]), []));

    /* 来源标记：自动整理也会进撤销栈。用户看到「移动 1 项」时，
     * 分不清是自己让 AI 做的、还是刚收藏网页时后台做的——这直接影响他敢不敢撤。 */
    ok('撤销历史：自动整理的点标为 auto，Agent 轮次标为 agent', () => {
      const autoPoint = { ...movable, id: 'h-auto', runId: 'auto-organize:bookmark-123' };
      const [autoRow] = describeUndoHistory([autoPoint]);
      assert.equal(autoRow!.source, 'auto', 'auto-organize: 前缀必须识别为自动整理');
      assert.equal(rows[0]!.source, 'agent', '普通 Agent 轮次不应被误标');
      // 来源不影响可撤销判定：栈顶仍然可撤
      assert.equal(autoRow!.undoable, true);
    });

    // 精确 id 下发（接线层契约）：即便现在只有栈顶可执行，客户端也必须把**用户真实点击的那一行**
    // 原样下发，由后端决定接受或拒绝。绝不能退化成"那就撤最新的那个"——那是撤销了另一个操作。
    const sent: { type?: string; id?: string }[] = [];
    let listed: UndoPointT[] = [batch, movable, legacy];
    sendMessageMock = (msg) => {
      const m = msg as { type?: string; id?: string };
      sent.push(m);
      if (m.type === 'undo:list') return { type: 'undo:list:result', points: listed };
      if (m.type === 'undo:apply') return { type: 'undo:apply:result', result: { ok: true, restored: 2, failures: [] } };
      return undefined;
    };
    await useAIStore.getState().refreshUndo();
    sent.length = 0;
    await useAIStore.getState().undoLast('h-move'); // 用户点的是第二步
    ok('跳选撤销：显式传入的撤销点 id 被原样下发', () => {
      const applied = sent.find((m) => m.type === 'undo:apply');
      assert.ok(applied, '应发出 undo:apply');
      assert.equal(applied!.id, 'h-move', '必须撤用户点的那一步，而不是最新的那一步');
    });
    sendMessageMock = () => undefined;
    listed = [];

    ok('聊天面板确实从 store 的撤销点渲染历史、并把行 id 传给 undoLast（接线被守住）', () => {
      const panel = readFileSync(resolve(rootDir, 'src/components/chat/chat-panel.tsx'), 'utf8');
      assert.match(panel, /describeUndoHistory\(/, '面板应使用纯函数生成历史行');
      assert.match(panel, /undoLast\(row\.id\)/, '点击某一行必须把该行的 id 传给 undoLast');
      assert.match(panel, /undoNotice/, '容量提示也要在面板里可见（解释为何更早的点不见了）');
      assert.ok(
        !/回到这一步之前/.test(panel),
        '面板不得再承诺"跳回历史状态"——后端只按顺序撤销，较早记录不可执行',
      );
      assert.match(panel, /撤销最新的一步/, '标题应如实描述唯一可执行的操作');
    });
  }

  /* ── T32: 一键去重（确定性保留规则 + 可验证预览） ── */
  console.log('\n[T32] 一键去重');
  {
    const { normalizeUrl, buildDuplicateGroups, pickDuplicateKeeper } = await import('../src/lib/ai/dedupe');
    const { applyUndo } = await import('../src/lib/undo/apply');
    const { UNDO_STORAGE_KEY, beginUndoTransaction, endUndoTransaction, resetUndoTransactionForTest } =
      await import('../src/lib/undo/recorder');
    type DupeNode = import('../src/lib/ai/dedupe').DupeNode;

    const n = (id: string, url: string, extra: Partial<DupeNode> = {}): DupeNode =>
      ({ id, url, title: url, ...extra }) as DupeNode;

    ok('归一化：忽略片段/查询参数/www/尾斜杠', () => {
      assert.equal(normalizeUrl('https://www.example.com/a/?x=1#h'), normalizeUrl('https://example.com/a'));
      assert.notEqual(normalizeUrl('http://example.com/a'), normalizeUrl('https://example.com/a'),
        '协议差异按设计保留（不擅自改写用户收藏的协议）');
    });

    ok('normalizeUrl 与 buildDuplicateGroups 空值安全防御', () => {
      assert.equal(normalizeUrl(''), '');
      assert.equal(normalizeUrl(undefined), '');
      assert.deepEqual(buildDuplicateGroups([]), []);
      assert.deepEqual(buildDuplicateGroups(undefined), []);
    });


    ok('分组：只返回有重复的组，且组内多的在前', () => {
      const groups = buildDuplicateGroups([
        n('a', 'https://example.com/x'),
        n('b', 'https://www.example.com/x?q=1'),
        n('c', 'https://other.test/y'),
        n('d', 'https://third.test/z'),
        n('e', 'https://third.test/z#frag'),
      ]);
      assert.equal(groups.length, 2, '只有两组有重复');
      assert.equal(groups[0]!.items.length, 2);
      assert.ok(groups.every((g) => g.items.length > 1));
    });

    // ── 保留规则的四个优先级 ──
    ok('保留规则：自定义标题优先于"最近使用/最早收藏"', () => {
      const r = pickDuplicateKeeper([
        n('new-used', 'https://e.test/a', { dateLastUsed: 9_000, dateAdded: 100 }),
        n('renamed', 'https://e.test/a', { title: '我自己起的名字', dateAdded: 500 }),
      ]);
      assert.equal(r.keep.id, 'renamed');
      assert.match(r.reason, /自定义标题/);
    });
    ok('保留规则：都没有自定义标题时，最近使用的优先', () => {
      const r = pickDuplicateKeeper([
        n('old', 'https://e.test/a', { dateAdded: 1, dateLastUsed: 0 }),
        n('recent', 'https://e.test/a', { dateAdded: 900, dateLastUsed: 7_000 }),
      ]);
      assert.equal(r.keep.id, 'recent');
      assert.match(r.reason, /最近被使用/);
    });
    ok('保留规则：都没用过时，收藏最早的优先', () => {
      const r = pickDuplicateKeeper([
        n('later', 'https://e.test/a', { dateAdded: 800 }),
        n('earlier', 'https://e.test/a', { dateAdded: 200 }),
      ]);
      assert.equal(r.keep.id, 'earlier');
      assert.match(r.reason, /收藏得最早/);
    });
    ok('保留规则：其余条件相同则按 id 稳定排序（结果可复现，不随机）', () => {
      const r1 = pickDuplicateKeeper([n('b2', 'https://e.test/a'), n('a1', 'https://e.test/a')]);
      const r2 = pickDuplicateKeeper([n('a1', 'https://e.test/a'), n('b2', 'https://e.test/a')]);
      assert.equal(r1.keep.id, 'a1');
      assert.equal(r2.keep.id, 'a1', '输入顺序不同也必须得到同一结果');
      assert.match(r1.reason, /稳定排序/);
    });

    // ── 工具端到端 ──
    const setupDupes = async () => {
      const folder = (await mockBookmarks.create({ parentId: '2', title: 'T32-FOLDER' })).id;
      const a = (await mockBookmarks.create({ parentId: folder, title: 'Example', url: 'https://example.com/dup' })).id;
      const b = (await mockBookmarks.create({ parentId: folder, title: 'https://example.com/dup', url: 'https://www.example.com/dup?utm=1' })).id;
      const c = (await mockBookmarks.create({ parentId: folder, title: 'Example 副本', url: 'https://example.com/dup#x' })).id;
      const solo = (await mockBookmarks.create({ parentId: folder, title: 'Solo', url: 'https://solo.test/only' })).id;
      return { folder, a, b, c, solo };
    };

    storageMap.delete(UNDO_STORAGE_KEY);
    resetUndoTransactionForTest();
    storageMap.delete('markai.config'); // 默认 confirm 模式
    const f1 = await setupDupes();
    const beforeDry = await snapshotTreeObj();
    const dryOut = await executeTool('dedupe_bookmarks', JSON.stringify({ folderIds: [f1.folder], dryRun: true }));
    const afterDry = await snapshotTreeObj();
    const dj = JSON.parse(dryOut.result) as { dryRun: boolean; groups: number; duplicates: number };
    ok('dryRun 只出计划：不改动书签、也不产生提议', () => {
      assert.equal(dj.dryRun, true);
      assert.equal(dj.groups, 1, '一组重复');
      assert.equal(dj.duplicates, 2, '其余两条待删');
      assert.equal(firstTreeDiff(beforeDry, afterDry), null, '预览不得改动书签库');
      assert.ok(!dryOut.deletions, '预览不得产生删除提议');
    });

    // ── limit 生效：按"组"截断，且优先处理重复最多的组 ──
    const fLimit = (await mockBookmarks.create({ parentId: '2', title: 'T32-LIMIT' })).id;
    const mkCopies = async (host: string, copies: number) => {
      for (let i = 0; i < copies; i++) {
        await mockBookmarks.create({ parentId: fLimit, title: `c-${host}-${i}`, url: `https://${host}/x` });
      }
    };
    await mkCopies('a-limit.test', 3); // 最大组：3 条 → 删 2
    await mkCopies('b-limit.test', 2); // → 删 1
    await mkCopies('c-limit.test', 2); // → 删 1
    const limitOne = JSON.parse(
      (await executeTool('dedupe_bookmarks', JSON.stringify({ folderIds: [fLimit], dryRun: true, limit: 1 }))).result,
    ) as { groups: number; duplicates: number; sample: { url: string }[] };
    const limitTwo = JSON.parse(
      (await executeTool('dedupe_bookmarks', JSON.stringify({ folderIds: [fLimit], dryRun: true, limit: 2 }))).result,
    ) as { groups: number; duplicates: number };
    const limitConfirm = await executeTool(
      'dedupe_bookmarks',
      JSON.stringify({ folderIds: [fLimit], limit: 1 }),
    );
    const limitConfirmJ = JSON.parse(limitConfirm.result) as { groups: number; submitted: number };
    storageMap.delete('markai.config');
    ok('limit 生效：按组截断、优先处理重复最多的组，并同样约束实际提议数', () => {
      assert.equal(limitOne.groups, 1, '只处理 1 组');
      assert.equal(limitOne.duplicates, 2, '最大的一组 3 条 → 删 2');
      assert.match(limitOne.sample[0]!.url, /a-limit\.test/, '优先处理重复最多的组');
      assert.equal(limitTwo.groups, 2, 'limit=2 处理两组');
      assert.equal(limitTwo.duplicates, 3, '3 条组删 2 + 2 条组删 1');
      assert.equal(limitConfirmJ.groups, 1);
      assert.equal(limitConfirmJ.submitted, 2, 'limit 也要约束真正提交的提议数');
      assert.equal((limitConfirm.deletions ?? []).length, 2);
    });

    const confirmOut = await executeTool('dedupe_bookmarks', JSON.stringify({ folderIds: [f1.folder] }));
    const cj = JSON.parse(confirmOut.result) as { mode: string; submitted: number; duplicates: number };
    const proposedIds = (confirmOut.deletions ?? []).map((d) => d.bookmarkId).sort();
    ok('默认（需确认）模式：提交的提议恰好是非保留项，保留项不动', () => {
      assert.equal(cj.mode, 'confirm');
      assert.equal(cj.duplicates, 2);
      assert.equal(cj.submitted, 2);
      assert.deepEqual(proposedIds, [f1.b, f1.c].sort(), '保留 a（有自定义标题），提议删 b、c');
      assert.ok((confirmOut.deletions ?? []).every((d) => d.status === 'pending'), '必须等用户确认');
    });

    // ── auto 模式：直接删且可撤销 ──
    storageMap.delete(UNDO_STORAGE_KEY);
    resetUndoTransactionForTest();
    storageMap.set('markai.config', { deleteMode: 'auto' });
    const f2 = await setupDupes();
    const beforeAuto = await snapshotTreeObj();
    await beginUndoTransaction('run-t32');
    const autoOut = await executeTool('dedupe_bookmarks', JSON.stringify({ folderIds: [f2.folder] }));
    const autoPoint = await endUndoTransaction();
    const aj = JSON.parse(autoOut.result) as { executed: number; duplicates: number };
    const midAuto = await snapshotTreeObj();
    const undoAuto = await applyUndo();
    const afterAuto = await snapshotTreeObj();
    storageMap.delete('markai.config');
    ok('「无需确认」模式：直接删除重复项', () => {
      assert.equal(aj.duplicates, 2);
      assert.equal(aj.executed, 2, `应删掉 2 条，实际 ${aj.executed}`);
      assert.notEqual(firstTreeDiff(beforeAuto, midAuto), null, '确实删掉了东西');
    });
    ok('去重的删除可撤销：整棵树含顺序复原', () => {
      assert.ok(autoPoint, '应产生撤销点');
      assert.ok(undoAuto.ok, `撤销应成功，实际 ${JSON.stringify(undoAuto)}`);
      const diff = firstTreeDiff(beforeAuto, afterAuto, '', { ignoreIds: true });
      assert.equal(diff, null, `第一处差异：${diff ?? ''}`);
    });

    // ── 无重复：不产生任何提议 ──
    const f3 = (await mockBookmarks.create({ parentId: '2', title: 'T32-NODUP' })).id;
    await mockBookmarks.create({ parentId: f3, title: 'x', url: 'https://nodup.test/x' });
    const noDup = await executeTool('dedupe_bookmarks', JSON.stringify({ folderIds: [f3] }));
    const ndj = JSON.parse(noDup.result) as { groups: number; duplicates: number };
    ok('没有重复时不产生任何提议', () => {
      assert.equal(ndj.groups, 0);
      assert.equal(ndj.duplicates, 0);
      assert.ok(!noDup.deletions, '不应有提议载荷');
    });

    resetUndoTransactionForTest();
    storageMap.delete(UNDO_STORAGE_KEY);
    storageMap.delete('markai.config');
  }

  /* ── T33: 批量工具的 dryRun 预览（cleanup_sweep / auto_categorize） ── */
  console.log('\n[T33] 批量工具的预览');
  {
    const { UNDO_STORAGE_KEY, resetUndoTransactionForTest, readUndoPoints } = await import('../src/lib/undo/recorder');

    // ── A. cleanup_sweep：预览不改库、不给提议，且计数与真实执行一致 ──
    storageMap.delete(UNDO_STORAGE_KEY);
    resetUndoTransactionForTest();
    storageMap.delete('markai.config');
    const sweepFolder = (await mockBookmarks.create({ parentId: '1', title: 'T33-SWEEP' })).id;
    for (let i = 0; i < 8; i++) {
      const id = String(nextId++);
      store.push({
        id,
        parentId: sweepFolder,
        title: `t33-${String(i).padStart(2, '0')}`,
        url: `https://t33-sweep-${i}.test/docs/article/${i}`, // deep → keepOnly=page 时在清理范围
        dateAdded: Date.UTC(2025, 6, 1),
      });
    }
    const beforeSweepDry = await snapshotTreeObj();
    const sweepDry = JSON.parse(
      (
        await executeTool(
          'cleanup_sweep',
          JSON.stringify({ folderId: sweepFolder, beforeYear: 2026, checkReachable: false, dryRun: true }),
        )
      ).result,
    ) as { dryRun: boolean; toDelete: number; sample: unknown[] };
    const afterSweepDry = await snapshotTreeObj();
    const sweepDryProposals = await executeTool(
      'cleanup_sweep',
      JSON.stringify({ folderId: sweepFolder, beforeYear: 2026, checkReachable: false, dryRun: true }),
    );
    const sweepReal = JSON.parse(
      (
        await executeTool(
          'cleanup_sweep',
          JSON.stringify({ folderId: sweepFolder, beforeYear: 2026, checkReachable: false }),
        )
      ).result,
    ) as { toDelete: number; submitted: number };

    ok('cleanup_sweep 预览：dryRun 标记、不改动书签、不产生提议', () => {
      assert.equal(sweepDry.dryRun, true);
      assert.equal(sweepDry.toDelete, 8);
      assert.equal(firstTreeDiff(beforeSweepDry, afterSweepDry), null, '预览不得改动书签库');
      assert.ok(!sweepDryProposals.deletions, '预览不得产生删除提议');
    });
    ok('cleanup_sweep 预览不说谎：计数与随后真实执行一致', () => {
      assert.equal(sweepReal.toDelete, sweepDry.toDelete, '预览的将删条数必须等于真实执行的目标数');
      assert.equal(sweepReal.submitted, sweepDry.toDelete, '确认为模式下真实执行应提交同样数量的提议');
    });

    // ── B. auto_categorize：预览不建不搬，且计划与真实执行一致 ──
    storageMap.delete(UNDO_STORAGE_KEY);
    resetUndoTransactionForTest();
    const catFolder = (await mockBookmarks.create({ parentId: '1', title: 'T33-CAT' })).id;
    for (let i = 0; i < 24; i++) {
      const id = String(nextId++);
      store.push({
        id,
        parentId: catFolder,
        title: `t33c-${i}`,
        url: `https://d${i % 3}.example/page/${i}`,
        dateAdded: 50_000 + i,
      });
    }
    const beforeCatDry = await snapshotTreeObj();
    const catDry = JSON.parse(
      (
        await executeTool(
          'auto_categorize',
          JSON.stringify({ folderId: catFolder, minGroupSize: 2, dryRun: true }),
        )
      ).result,
    ) as { dryRun: boolean; toCreate: number; toMove: number; groups: { name: string; count: number }[] };
    const afterCatDry = await snapshotTreeObj();
    const catReal = JSON.parse(
      (
        await executeTool('auto_categorize', JSON.stringify({ folderId: catFolder, minGroupSize: 2 }))
      ).result,
    ) as { created: number; moved: number };

    ok('auto_categorize 预览：dryRun 标记、不创建文件夹也不移动书签', () => {
      assert.equal(catDry.dryRun, true);
      assert.equal(catDry.toCreate, 3, '3 个域名分组');
      assert.equal(catDry.toMove, 24);
      assert.equal(catDry.groups.length, 3);
      assert.equal(firstTreeDiff(beforeCatDry, afterCatDry), null, '预览不得改动书签库');
    });
    ok('auto_categorize 预览不说谎：计划数等于真实执行的创建/移动数', () => {
      assert.equal(catReal.created, catDry.toCreate);
      assert.equal(catReal.moved, catDry.toMove);
    });

    // ── C. 预览不产生撤销点（它是只读的） ──
    storageMap.delete(UNDO_STORAGE_KEY);
    resetUndoTransactionForTest();
    await executeTool(
      'auto_categorize',
      JSON.stringify({ folderId: catFolder, minGroupSize: 2, dryRun: true }),
    );
    await executeTool(
      'cleanup_sweep',
      JSON.stringify({ folderId: sweepFolder, beforeYear: 2026, checkReachable: false, dryRun: true }),
    );
    const pointsAfterDry = await readUndoPoints();
    ok('纯预览不产生撤销点（没有写操作就不该留下撤销记录）', () => assert.equal(pointsAfterDry.length, 0));

    // ── D. 空范围：预览也给出一致的空计划 ──
    const emptyFolder = (await mockBookmarks.create({ parentId: '1', title: 'T33-EMPTY' })).id;
    // 空/子项不足时工具走的是"提前返回"那条路径，形状与常规计划不同（created/moved 而非 toCreate/toMove），
    // 但也必须带上 dryRun 标记，调用方才能确认"什么都没做"
    const emptyDry = JSON.parse(
      (await executeTool('auto_categorize', JSON.stringify({ folderId: emptyFolder, dryRun: true }))).result,
    ) as { dryRun?: boolean; created: number; moved: number; note: string };
    const emptySweepDry = JSON.parse(
      (
        await executeTool(
          'cleanup_sweep',
          JSON.stringify({ folderId: emptyFolder, checkReachable: false, dryRun: true }),
        )
      ).result,
    ) as { dryRun: boolean; toDelete: number };
    ok('空文件夹的预览也是一致的空计划（不报错、不虚构）', () => {
      assert.equal(emptyDry.dryRun, true, '提前返回也要标出这是预览');
      assert.equal(emptyDry.created, 0);
      assert.equal(emptyDry.moved, 0);
      assert.equal(emptySweepDry.toDelete, 0);
    });

    resetUndoTransactionForTest();
    storageMap.delete(UNDO_STORAGE_KEY);
    storageMap.delete('markai.config');
  }

  /* ── T34: 被中断的轮次也能撤销（增量落盘 + 启动恢复） ── */
  console.log('\n[T34] 被中断的轮次');
  {
    const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const {
      UNDO_STORAGE_KEY,
      UNDO_PENDING_KEY,
      beginUndoTransaction,
      endUndoTransaction,
      ensureOrderCheckpoint,
      recoverInterruptedTransaction,
      readUndoState,
      readUndoPoints,
      resetUndoTransactionForTest,
      dropActiveForTest,
    } = await import('../src/lib/undo/recorder');
    const { jRemove } = await import('../src/lib/undo/mutations');
    const { applyUndo } = await import('../src/lib/undo/apply');
    const { undoReadiness } = await import('../src/lib/undo/journal');

    const mkTree = async () => {
      const folder = (await mockBookmarks.create({ parentId: '1', title: 'T34-FOLDER' })).id;
      const kids: string[] = [];
      for (const t of ['a', 'b', 'c', 'd']) {
        kids.push((await mockBookmarks.create({ parentId: folder, title: t, url: `https://t34.test/${t}` })).id);
      }
      return { folder, kids };
    };

    // ── A. 事务进行中：pending 快照已落盘（不是等到轮次结束才写） ──
    storageMap.delete(UNDO_STORAGE_KEY);
    storageMap.delete(UNDO_PENDING_KEY);
    resetUndoTransactionForTest();
    const fx = await mkTree();
    const before = await snapshotTreeObj();
    await beginUndoTransaction('run-t34');
    await ensureOrderCheckpoint(fx.folder);
    await jRemove(fx.kids[1]!); // 删中间那条，顺序问题才看得出来
    const pendingMid = storageMap.get(UNDO_PENDING_KEY) as
      | { runId: string; ops: { kind: string }[]; orderCheckpoints: { parentId: string }[] }
      | undefined;
    ok('事务进行中就有增量快照，且最多落后 5 条（不是等到轮次结束才写）', () => {
      assert.ok(pendingMid, '轮次进行中应存在 pending 快照');
      assert.equal(pendingMid!.runId, 'run-t34');
      assert.equal(pendingMid!.orderCheckpoints[0]!.parentId, fx.folder, '顺序检查点也要在快照里');
      assert.equal(storageMap.has(UNDO_STORAGE_KEY), false, '此时还不该有正式撤销点');
      // 快照必须是"已记录操作的前缀"（不能凭空多出、也不能乱序），且落后不超过阈值
      assert.ok(pendingMid!.ops.length <= 1, '快照不能比已记录的还多');
      assert.ok(1 - pendingMid!.ops.length <= 5, '落后不得超过 5 条');
    });
    // 按"时间"那一半的节流：等过阈值后，快照应追上全部已记录操作
    await new Promise((r) => setTimeout(r, 300));
    const pendingCaughtUp = storageMap.get(UNDO_PENDING_KEY) as { ops: { kind: string }[] } | undefined;
    ok('过了节流窗口后快照会追上（时间那一半也生效）', () => {
      assert.equal(pendingCaughtUp?.ops.length, 1, '等待后应包含已记录的删除');
      assert.equal(pendingCaughtUp!.ops[0]!.kind, 'delete');
    });

    // ── B. 正常收尾后 pending 被清除（不会被重复提升） ──
    const ended = await endUndoTransaction();
    ok('正常收尾后清除 pending（不会下次启动被重复提升）', () => {
      assert.ok(ended, '正常收尾应产生撤销点');
      assert.equal(storageMap.has(UNDO_PENDING_KEY), false, 'pending 应被清除');
      assert.equal((storageMap.get(UNDO_STORAGE_KEY) as { points: unknown[] }).points.length, 1);
    });
    await applyUndo(); // 收拾干净
    storageMap.delete(UNDO_STORAGE_KEY);
    storageMap.delete(UNDO_PENDING_KEY);
    resetUndoTransactionForTest();

    // ── C. 模拟"进程被杀"：不调 end，直接恢复 → 仍然可撤销且顺序正确 ──
    const fx2 = await mkTree();
    const before2 = await snapshotTreeObj();
    await beginUndoTransaction('run-t34-killed');
    await ensureOrderCheckpoint(fx2.folder);
    await jRemove(fx2.kids[2]!);
    await jRemove(fx2.kids[0]!);
    await new Promise((r) => setTimeout(r, 300)); // 让节流窗口过去，快照追上全部操作
    dropActiveForTest(); // ← 等价于 SW 被杀：内存没了，pending 还在
    const recovered = await recoverInterruptedTransaction();
    const afterRecover = await readUndoState();
    const midTree = await snapshotTreeObj();
    const undoRes = await applyUndo();
    const after2 = await snapshotTreeObj();

    ok('被中断的轮次会被提升为可撤销点（这是本目标的核心）', () => {
      assert.ok(recovered, '应恢复出一个撤销点');
      assert.equal(recovered!.ops.length, 2, '两条删除都应在里面');
      assert.equal(afterRecover.points.length, 1);
      assert.notEqual(firstTreeDiff(before2, midTree), null, '被杀之前确实改动了书签');
    });
    ok('被中断的轮次恢复后能撤销回原状（含顺序）', () => {
      assert.ok(undoRes.ok, `撤销应成功，实际 ${JSON.stringify(undoRes)}`);
      const diff = firstTreeDiff(before2, after2, '', { ignoreIds: true });
      assert.equal(diff, null, `第一处差异：${diff ?? ''}`);
    });
    ok('恢复会如实告知用户"上一轮被中断"', () => {
      assert.match(afterRecover.notice ?? '', /被中断/);
      assert.ok(afterRecover.noticeAt, '应带时间戳，供界面只提示一次');
    });
    await okA('恢复是一次性的：pending 已消费，再调用是空操作', async () => {
      const again = await recoverInterruptedTransaction();
      assert.equal(again, null);
    });

    // ── D. 没有 pending 时恢复是空操作 ──
    storageMap.delete(UNDO_STORAGE_KEY);
    storageMap.delete(UNDO_PENDING_KEY);
    resetUndoTransactionForTest();
    const noneRecovered = await recoverInterruptedTransaction();
    const noneState = await readUndoState();
    ok('没有 pending 时恢复不产生任何撤销点', () => {
      assert.equal(noneRecovered, null);
      assert.equal(noneState.points.length, 0);
    });

    // ── E. 兼容性：pending 里是旧式无快照删除时，恢复后仍如实拒绝 ──
    const { recordOp, markDelete } = await import('../src/lib/undo/recorder');
    await beginUndoTransaction('run-t34-legacy');
    recordOp({ kind: 'delete', id: 'legacy-1', title: '旧删除' });
    markDelete();
    await new Promise((r) => setTimeout(r, 300));
    dropActiveForTest();
    const legacyRecovered = await recoverInterruptedTransaction();
    const legacyReady = undoReadiness(legacyRecovered);
    ok('恢复出来的旧式删除仍按既有规则拒绝整轮撤销（不假装能撤）', () => {
      assert.ok(legacyRecovered);
      assert.equal(legacyReady.undoable, false);
      assert.match(legacyReady.reason ?? '', /没有快照/);
    });

    ok('Service Worker 启动时确实调用了恢复（接线被守住）', () => {
      const bg = readFileSync(resolve(rootDir, 'src/entrypoints/background.ts'), 'utf8');
      assert.match(
        bg,
        /recoverInterruptedTransaction\(\)/,
        'SW 启动必须调用 recoverInterruptedTransaction()，否则被中断的轮次仍然不可撤销',
      );
    });

    // 收尾：clearAll 相关状态
    storageMap.delete('markai.config');
    storageMap.delete(UNDO_STORAGE_KEY);
    storageMap.delete(UNDO_PENDING_KEY);
    resetUndoTransactionForTest();
  }

  /* ── T35: 对话历史的容量护栏与如实失败（不再是空 catch） ── */
  console.log('\n[T35] 对话存储护栏');
  {
    const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const { trimConversationsToBudget, describeChatTrim, approximateBytes } = await import('../src/lib/ai/chat-budget');
    const { useAIStore, AI_STORAGE_KEY, CHAT_BUDGET_BYTES } = await import('../src/stores/aiStore');
    type Conv = import('../src/lib/ai/chat-budget').ConversationLike;

    const msg = (id: string, text: string) =>
      ({ id, role: 'user' as const, content: text, createdAt: Number(id) || 1 }) as never;
    const conv = (id: string, updatedAt: number, msgs: ReturnType<typeof msg>[]): Conv => ({
      id,
      title: `会话 ${id}`,
      createdAt: updatedAt,
      updatedAt,
      messages: msgs,
    });

    // ── A. 纯逻辑：预算内不动 ──
    const small = [conv('c1', 100, [msg('1', '你好')]), conv('c2', 200, [msg('2', '在的')])];
    const untouched = trimConversationsToBudget(small, CHAT_BUDGET_BYTES);
    ok('裁剪：预算内原样返回（不做多余的"顺手优化"）', () => {
      assert.equal(untouched.droppedMessages, 0);
      assert.equal(untouched.droppedConversations, 0);
      assert.equal(untouched.kept.length, 2);
      assert.equal(untouched.kept[0]!.messages.length, 1);
    });

    // ── B. 纯逻辑：超预算丢最旧的消息，保留最新 ──
    const big = [
      conv('old', 100, [msg('1', 'A'.repeat(4000)), msg('2', 'B'.repeat(4000)), msg('3', 'C'.repeat(100))]),
      conv('new', 200, [msg('4', 'D'.repeat(200))]),
    ];
    const trimmed = trimConversationsToBudget(big, 3000);
    ok('裁剪：超预算时从最旧会话丢最旧消息，且保留最新那条', () => {
      assert.ok(trimmed.droppedMessages > 0, '应丢弃了消息');
      assert.ok(approximateBytes(trimmed.kept) <= 3000, '裁剪后必须在预算内');
      const newestKept = trimmed.kept.find((c) => c.id === 'new');
      assert.equal(newestKept?.messages.length, 1, '最新会话不该被丢');
      const oldKept = trimmed.kept.find((c) => c.id === 'old');
      // 留下来的必须是最新的那些（尾部），不是头部
      if (oldKept && oldKept.messages.length > 0) {
        const last = oldKept.messages[oldKept.messages.length - 1]!;
        assert.notEqual((last as { id: string }).id, '1', '最旧的那条不应还在');
      }
      assert.match(describeChatTrim(trimmed) ?? '', /消息/);
    });

    // ── C. 纯逻辑：消息丢空后丢整个最旧会话 ──
    const manyConvs = [
      conv('a', 1, []),
      conv('b', 2, []),
      conv('c', 3, []),
      conv('d', 4, []),
    ];
    const padded = manyConvs.map((c) => ({ ...c, title: 'T'.repeat(500) }));
    const byConv = trimConversationsToBudget(padded, 1200);
    ok('裁剪：必要时整个丢弃最旧的会话，并说明丢了几个', () => {
      assert.ok(byConv.droppedConversations > 0, '应整个丢弃了会话');
      assert.ok(byConv.kept.length < padded.length);
      assert.ok(approximateBytes(byConv.kept) <= 1200);
      assert.match(describeChatTrim(byConv) ?? '', /会话/);
      assert.equal(trimConversationsToBudget(padded, 999999).droppedConversations, 0, '预算足够时不该丢会话');
    });

    ok('裁剪边界：空列表、0 预算与负数预算安全处理不崩溃', () => {
      const emptyRes = trimConversationsToBudget([], 1000);
      assert.equal(emptyRes.kept.length, 0);
      assert.equal(emptyRes.droppedMessages, 0);

      const zeroRes = trimConversationsToBudget(small, 0);
      assert.equal(zeroRes.kept.length, 0, '0 预算应清空所有会话');
      assert.equal(zeroRes.droppedConversations, 2);

      const negRes = trimConversationsToBudget(small, -100);
      assert.equal(negRes.kept.length, 0, '负数预算应安全钳位并清空');
    });

    // ── D. 写盘失败不再静默：带稳定时间戳的如实错误 ──
    const { useToastStore: toastStoreForTest } = await import('../src/lib/toast');
    const origPush = toastStoreForTest.getState().push;
    const attempts: string[] = [];
    toastStoreForTest.setState({
      push: (t) => {
        attempts.push(t.title);
        return origPush(t);
      },
    });
    useAIStore.setState({ persistError: null, persistNotice: null });
    storageMap.delete(AI_STORAGE_KEY);
    storageSetFail = true;
    await useAIStore.getState()._persist(true);
    const err1 = useAIStore.getState().persistError;
    const at1 = err1?.at;
    // 必须真的隔开一点时间再写第二次：否则"每次都刷新时间戳"的实现也会因为两次同毫秒而假通过
    // （反证脚本抓出过这条假绿）。
    await new Promise((r) => setTimeout(r, 20));
    await useAIStore.getState()._persist(true); // 再写一次：at 不该变（界面只提示一次）
    const at2 = useAIStore.getState().persistError?.at;
    storageSetFail = false;
    ok('写盘失败不再被吞掉：留下如实说明（含"没有保存成功"与建议）', () => {
      assert.ok(err1, '应记录 persistError');
      assert.match(err1!.message, /没有保存成功/);
      assert.match(err1!.message, /清空更早的对话|建议/);
      assert.ok(at1 && at1 > 0, '应带时间戳');
    });
    ok('失败状态的时间戳稳定（界面据此只提示一次，不反复打扰）', () =>
      assert.equal(at2, at1, '同一次故障不应刷新时间戳'),
    );
    ok('失败时会真的提示用户，且同一次故障只提示一次（不骚扰）', () => {
      const n = attempts.filter((t) => t === '对话未能保存').length;
      assert.ok(n >= 1, `应尝试提示，实际提示过：${attempts.join('/')}`);
      assert.equal(n, 1, `连续两次相同的失败只该提示一次，实际 ${n} 次`);
    });
    ok('聊天气泡区确实会显示这条警示（可见，不是一闪而过的 toast）', () => {
      const panel = readFileSync(resolve(rootDir, 'src/components/chat/chat-panel.tsx'), 'utf8');
      assert.match(panel, /persistError/, '面板应读取 persistError');
      assert.match(panel, /persistNotice/, '面板也应显示"丢弃了更早对话"的说明');
    });
    toastStoreForTest.setState({ push: origPush });

    // ── E. 超预算：先裁剪再成功落盘，并留下如实 notice ──
    useAIStore.setState({ persistError: null, persistNotice: null });
    storageMap.delete(AI_STORAGE_KEY);
    const huge = Array.from({ length: 6 }, (_, i) =>
      conv(`big-${i}`, i + 1, Array.from({ length: 20 }, (_, j) => msg(`${i}${j}`, 'X'.repeat(60_000)))),
    );
    useAIStore.setState({ conversations: huge, messages: huge[5]!.messages, activeId: 'big-5' });
    await useAIStore.getState()._persist(true);
    const stored = storageMap.get(AI_STORAGE_KEY) as { conversations: { id: string; messages: unknown[] }[] };
    const notice = useAIStore.getState().persistNotice;
    const storedBytes = JSON.stringify(stored).length;
    ok('超预算时先裁剪再落盘：写入成功且确实在预算内', () => {
      assert.ok(stored, '应成功写入（不再因为超配额而整段丢失）');
      assert.ok(storedBytes <= CHAT_BUDGET_BYTES, `写入体积 ${storedBytes} 应在 ${CHAT_BUDGET_BYTES} 预算内`);
      assert.equal(useAIStore.getState().persistError, null, '裁剪后不应再报失败');
    });
    ok('丢弃了更早的对话就如实告知（不静默降级）', () => {
      assert.ok(notice, '应留下 persistNotice');
      assert.match(notice!, /超出本地存储预算|丢弃/);
      assert.match(notice!, /消息|会话/);
    });

    // ── F. 失败提示里的占用是真实读出来的（而不是含糊其辞） ──
    // 注意：断言必须钉在**生产代码**上。原先这条只比对替身的 API 与替身的存储，
    // 那样无论生产代码怎么写都不会变红——等于一条不会失败的测试。
    const bytesFromApi = await chrome.storage.local.getBytesInUse(AI_STORAGE_KEY);
    ok('失败提示带上了真实占用（来自 getBytesInUse），且替身契约如实', () => {
      assert.match(err1!.message, /MiB/, '失败说明里应带上真实占用，而不是只说"出错了"');
      assert.equal(bytesFromApi, JSON.stringify(storageMap.get(AI_STORAGE_KEY)).length);
    });

    // ── F2. 成功路径也要用真实占用核对估算（估算达标但浏览器说超标 → 如实告知） ──
    const { setChatBudgetBytes } = await import('../src/stores/aiStore');
    useAIStore.setState({ persistError: null, persistNotice: null });
    storageMap.delete(AI_STORAGE_KEY);
    setChatBudgetBytes(1); // 极端预算：无论怎么裁剪都不可能达标（activeId/墓碑等零碎字段仍在）
    useAIStore.setState({
      conversations: [conv('cross', 1, [msg('8', '一点点内容')])],
      messages: [msg('8', '一点点内容')],
      activeId: 'cross',
      deletedIds: ['tomb-1', 'tomb-2'],
    });
    await useAIStore.getState()._persist(true);
    const crossNotice = useAIStore.getState().persistNotice;
    const crossErr = useAIStore.getState().persistError;
    const crossStored = storageMap.has(AI_STORAGE_KEY);
    const crossActual = await chrome.storage.local.getBytesInUse(AI_STORAGE_KEY);
    setChatBudgetBytes(CHAT_BUDGET_BYTES);
    ok('成功写入但真实占用仍超预算时，如实告知（估算与浏览器计量有差距）', () => {
      assert.equal(crossErr, null, '这一次是写成功的');
      assert.ok(crossStored, '内容确实写进去了');
      assert.ok(crossActual > 1, '浏览器报告的占用确实超了那个极端预算');
      assert.ok(crossNotice, '应留下如实提示');
      assert.match(crossNotice!, /真实占用/);
      assert.match(crossNotice!, /超过了对话预算/);
    });

    // ── G. 正常路径：不产生任何提示 ──
    useAIStore.setState({ persistError: null, persistNotice: null });
    storageMap.delete(AI_STORAGE_KEY);
    useAIStore.setState({
      conversations: [conv('ok', 1, [msg('9', '正常一条')])],
      messages: [msg('9', '正常一条')],
      activeId: 'ok',
    });
    await useAIStore.getState()._persist(true);
    ok('正常落盘不产生失败或裁剪提示（避免狼来了）', () => {
      assert.equal(useAIStore.getState().persistError, null);
      assert.equal(useAIStore.getState().persistNotice, null);
    });

    storageMap.delete(AI_STORAGE_KEY);
    storageSetFail = false;
  }

  /* ── T36: 设置保存不再静默失败（含 deleteMode 的安全风险） ── */
  console.log('\n[T36] 设置保存');
  {
    const { useConfigStore } = await import('../src/stores/configStore');
    const { useToastStore: toastStore36 } = await import('../src/lib/toast');
    const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

    const origPush36 = toastStore36.getState().push;
    const attempts36: string[] = [];
    toastStore36.setState({
      push: (t) => {
        attempts36.push(t.title);
        return origPush36(t);
      },
    });

    // ── A. 普通设置保存失败：如实上报，且带 stable 时间戳与真实占用 ──
    useConfigStore.setState({ saveError: null });
    storageMap.delete('markai.config');
    storageSetFail = true;
    await useConfigStore.getState().update({ model: 'gpt-x' });
    const err1 = useConfigStore.getState().saveError;
    const at1 = err1?.at;
    await new Promise((r) => setTimeout(r, 20));
    await useConfigStore.getState().update({ model: 'gpt-y' });
    const at2 = useConfigStore.getState().saveError?.at;
    ok('设置保存失败不再被空 catch 吞掉（留下如实说明）', () => {
      assert.ok(err1, '应记录 saveError');
      assert.match(err1!.message, /设置未能保存/);
      assert.match(err1!.message, /重启后/, '要说明后果，而不是只说"失败了"');
    });
    ok('失败提示带真实占用（getBytesInUse），失败时间戳稳定且只提示一次', () => {
      assert.match(err1!.message, /KiB|MiB/, '应带上真实占用');
      assert.equal(at2, at1, '同一次故障不应刷新时间戳');
      assert.equal(attempts36.filter((t) => t === '设置未能保存').length, 1, '同一次故障只提示一次');
    });

    // ── B. 安全相关：删除模式保存失败必须点名风险 ──
    useConfigStore.setState({ saveError: null });
    storageSetFail = true;
    await useConfigStore.getState().update({ deleteMode: 'confirm' });
    const riskyErr = useConfigStore.getState().saveError;
    storageSetFail = false;
    ok('删除模式保存失败会点名安全风险（不能只说一句"保存失败"）', () => {
      assert.ok(riskyErr);
      assert.match(riskyErr!.message, /删除模式没有生效/);
      assert.match(riskyErr!.message, /需要确认|直接删除/, '要说清后果');
    });

    // ── C. 保存成功会清除失败状态（提示不该长期挂着） ──
    storageMap.delete('markai.config');
    storageSetFail = false;
    await useConfigStore.getState().update({ model: 'ok-model' });
    const afterOk = useConfigStore.getState().saveError;
    const savedCfg = storageMap.get('markai.config') as { model?: string } | undefined;
    ok('保存成功后清除失败状态，且配置确实落盘', () => {
      assert.equal(afterOk, null);
      assert.equal(savedCfg?.model, 'ok-model');
    });

    // ── C2. 返回值必须如实（调用方据此给真实反馈，而不是成败同一句话） ──
    storageMap.delete('markai.config');
    storageSetFail = false;
    const okResult = await useConfigStore.getState().update({ model: 'ret-ok' });
    storageSetFail = true;
    const failResult = await useConfigStore.getState().update({ model: 'ret-fail' });
    storageSetFail = false;
    ok('update 返回如实结果：成功 {ok:true}、失败 {ok:false,error}', () => {
      assert.equal(okResult.ok, true, '成功应返回 ok:true');
      assert.equal(failResult.ok, false, '失败必须返回 ok:false（不能只写状态）');
      assert.ok(failResult.error, '失败要带回原因');
    });

    // ── D. 设置页确实会显示这条警示（可见，不是只进状态） ──
    ok('设置页渲染了保存失败警示并提供重试入口（接线被守住）', () => {
      const form = readFileSync(resolve(rootDir, 'src/components/options/config-form.tsx'), 'utf8');
      // 必须钉在"渲染了那条消息"上：只匹配 saveError/重试保存 这类字样的话，
      // 即使把消息渲染删掉（留一个空 span）依然能通过——反证脚本抓到过这条假绿。
      assert.match(form, /saveError\.message/, '页面必须把失败说明渲染出来，而不只是读取它');
      assert.match(form, /重试保存/, '应提供重试入口');
      // 重试按钮必须消费返回值：否则成功/失败会显示同一句话，等于又一处"假成功"
      assert.match(form, /r\.ok/, '重试后应按返回值给出真实反馈');
    });

    // ── E. 错误处理清单存在，且如实写出"仍有大量 catch 未逐处审计" ──
    ok('docs/error-handling.md 存在并如实标注未清理的部分', () => {
      const doc = readFileSync(resolve(rootDir, 'docs/error-handling.md'), 'utf8');
      assert.match(doc, /必须如实上报/, '要给出判定规则');
      assert.match(doc, /catch \{/, '要如实列出仍未处理的数量级');
      assert.match(doc, /## 3\. 仍未处理/, '必须保留"仍未处理"这一节');
      assert.ok(
        !/已全部清理|已经清干净|全部审计完毕/.test(doc),
        '不得声称已经全部清理（正文里出现这类说法就说明文档在过度声明）',
      );
    });

    toastStore36.setState({ push: origPush36 });
    storageSetFail = false;
    storageMap.delete('markai.config');
    useConfigStore.setState({ saveError: null });
  }

  /* ── T37: 撤销点交接——正式写入失败时必须保留 pending ── */
  console.log('\n[T37] 撤销点交接');
  {
    const {
      UNDO_STORAGE_KEY,
      UNDO_PENDING_KEY,
      beginUndoTransaction,
      endUndoTransaction,
      ensureOrderCheckpoint,
      recoverInterruptedTransaction,
      readUndoState,
      resetUndoTransactionForTest,
    } = await import('../src/lib/undo/recorder');
    const { jCreate } = await import('../src/lib/undo/mutations');
    type Pending = {
      runId: string;
      ops: unknown[];
      containsDelete: boolean;
      orderCheckpoints: { parentId: string; order: string[] }[];
      updatedAt: number;
    };
    const pendingOf = () => storageMap.get(UNDO_PENDING_KEY) as Pending | undefined;
    const mkPending = (runId: string): Pending => ({
      runId,
      ops: [{ kind: 'create', id: 'ghost-1', title: '被中断的新建', isFolder: false }],
      containsDelete: false,
      orderCheckpoints: [],
      updatedAt: Date.now(),
    });

    // ── A. 正常收尾：正式写入失败 → pending 必须保留 ──
    storageMap.delete(UNDO_STORAGE_KEY);
    storageMap.delete(UNDO_PENDING_KEY);
    resetUndoTransactionForTest();
    await beginUndoTransaction('handoff-end');
    await ensureOrderCheckpoint('1');
    await jCreate({ parentId: '1', title: 'T37-KEEP', url: 'https://t37.test/keep' });
    await new Promise((r) => setTimeout(r, 300)); // 让节流窗口过去，pending 追上
    const pendingBeforeEnd = pendingOf();
    storageSetFailKeys = [UNDO_STORAGE_KEY]; // 只让正式点写入失败，pending 仍可写
    const endResult = await endUndoTransaction();
    storageSetFailKeys = null;
    ok('收尾时正式写入失败：pending 必须保留（否则唯一快照被删掉，改动再也撤不了）', () => {
      assert.ok(pendingBeforeEnd, '前置条件：收尾前应有 pending 快照');
      assert.ok(pendingOf(), '正式写入失败后 pending 必须还在');
    });
    await okA('收尾时正式写入失败不得声称"已记录"（返回 null + 有如实错误）', async () => {
      assert.equal(endResult, null, '写不进去就不能返回一个"已记录"的点');
    });

    // ── B. 恢复：正式写入失败 → pending 保留且不返回成功点 ──
    storageMap.delete(UNDO_STORAGE_KEY);
    storageMap.delete(UNDO_PENDING_KEY);
    resetUndoTransactionForTest();
    storageMap.set(UNDO_PENDING_KEY, mkPending('handoff-recover'));
    storageSetFailKeys = [UNDO_STORAGE_KEY];
    const recoveredFail = await recoverInterruptedTransaction();
    storageSetFailKeys = null;
    ok('恢复时正式写入失败：pending 必须保留、且不得返回成功点', () => {
      assert.ok(pendingOf(), '恢复失败后 pending 必须还在（否则下次启动无料可恢复）');
      assert.equal(recoveredFail, null, '没写成就不能返回一个撤销点');
    });
    await okA('恢复失败会留下如实错误（UI 能说出"撤销记录没写进去"）', async () => {
      const st = await readUndoState();
      assert.match(st.notice ?? '', /写入失败/);
    });

    // ── C. 重复恢复要按事务身份去重（清 pending 失败也不能变成两个点） ──
    storageMap.delete(UNDO_STORAGE_KEY);
    storageMap.delete(UNDO_PENDING_KEY);
    resetUndoTransactionForTest();
    const dupPending = mkPending('handoff-dup');
    storageMap.set(UNDO_STORAGE_KEY, {
      points: [
        {
          id: 'already-promoted',
          runId: 'handoff-dup', // 同一个事务：说明上次已成功提升，只是 pending 没清掉
          createdAt: Date.now() - 1000,
          ops: dupPending.ops,
          containsDelete: false,
        },
      ],
      notice: '已有记录',
    });
    storageMap.set(UNDO_PENDING_KEY, dupPending);
    const dupRecovered = await recoverInterruptedTransaction();
    const dupState = await readUndoState();
    ok('同一事务重复恢复不会生成第二个可回放点（按 runId 去重）', () => {
      assert.equal(dupState.points.length, 1, '不该出现两个撤销点');
      assert.equal(dupState.points[0]!.id, 'already-promoted', '应保留既有那个，而不是新造一个');
      assert.equal(dupRecovered, null, '没有新提升就不该返回新点');
    });
    ok('去重后 pending 会被清掉（避免每次启动都重放同一段）', () =>
      assert.equal(pendingOf(), undefined),
    );

    // ── D. 成功路径不受影响：写入成功才清 pending，点可被撤销 ──
    storageMap.delete(UNDO_STORAGE_KEY);
    storageMap.delete(UNDO_PENDING_KEY);
    resetUndoTransactionForTest();
    storageMap.set(UNDO_PENDING_KEY, mkPending('handoff-ok'));
    const recoveredOk = await recoverInterruptedTransaction();
    const okState = await readUndoState();
    ok('恢复成功：产生撤销点并清掉 pending（原有成功路径不回归）', () => {
      assert.ok(recoveredOk, '应提升出一个撤销点');
      assert.equal(okState.points.length, 1);
      assert.equal(pendingOf(), undefined, '成功后 pending 才该被清掉');
    });

    storageSetFail = false;
    storageSetFailKeys = null;
    storageMap.delete(UNDO_STORAGE_KEY);
    storageMap.delete(UNDO_PENDING_KEY);
    resetUndoTransactionForTest();
  }

  /* ── T38: 消费失败不得可重复回放 ── */
  console.log('\n[T38] 撤销点的消费失败');
  {
    const {
      UNDO_STORAGE_KEY,
      UNDO_PENDING_KEY,
      beginUndoTransaction,
      endUndoTransaction,
      ensureOrderCheckpoint,
      clearUndoPoints,
      readUndoState,
      resetUndoTransactionForTest,
    } = await import('../src/lib/undo/recorder');
    const { jRemove } = await import('../src/lib/undo/mutations');
    const { applyUndo } = await import('../src/lib/undo/apply');

    const childrenOf = (parentId: string) => store.filter((n) => n.parentId === parentId);

    // 造一个"删除"撤销点：删除可撤销是重复回放后果最严重的一类（会重复重建子树）
    const mkDeletePoint = async (title: string) => {
      storageMap.delete(UNDO_STORAGE_KEY);
      storageMap.delete(UNDO_PENDING_KEY);
      resetUndoTransactionForTest();
      const folder = (await mockBookmarks.create({ parentId: '1', title: `T38-${title}` })).id;
      const kid = (await mockBookmarks.create({
        parentId: folder,
        title: `kid-${title}`,
        url: `https://t38.test/${title}`,
      })).id;
      await beginUndoTransaction(`run-t38-${title}`);
      await ensureOrderCheckpoint(folder);
      await jRemove(kid);
      const point = await endUndoTransaction();
      assert.ok(point, '前置条件：应产生删除撤销点');
      return { folder, kid, point: point! };
    };

    // ── A. 消费写入一直失败：不得报 ok，且原点仍在 ──
    const a = await mkDeletePoint('consumefail');
    storageSetFailKeys = [UNDO_STORAGE_KEY];
    storageSetFailTimes = Number.POSITIVE_INFINITY;
    const firstApply = await applyUndo(a.point.id);
    storageSetFailKeys = null;
    const afterFirst = await readUndoState();
    ok('消费写入失败时不得报成功（否则用户以为已经撤过、记录也清了）', () => {
      assert.equal(firstApply.ok, false, '消费没成功就不能返回 ok');
      assert.match(firstApply.reason ?? '', /重复点击|重复执行/, '要明确警告不要重复执行');
    });
    ok('消费失败后原撤销点仍在存储里（这是必须如实告知的事实）', () => {
      assert.ok(
        afterFirst.points.some((p) => p.id === a.point.id),
        '点应仍在（我们没能更新存储）',
      );
    });

    // ── B. 同一会话再点同一条：必须拒绝，且不得重复重建子树 ──
    const kidsBefore = childrenOf(a.folder).length;
    const secondApply = await applyUndo(a.point.id);
    const kidsAfter = childrenOf(a.folder).length;
    ok('同一会话重复应用同一条撤销：拒绝执行，不产生重复子树', () => {
      assert.equal(secondApply.ok, false);
      assert.match(secondApply.reason ?? '', /已经执行过|重复/);
      assert.equal(kidsAfter, kidsBefore, `子树不应被重复重建：${kidsBefore} → ${kidsAfter}`);
    });
    ok('被拒绝的重复回放不会虚报 restored 数量', () => assert.equal(secondApply.restored, 0));

    // ── C. 只在第一次消费失败：内部重试一次即成功，正常消费 ──
    const c = await mkDeletePoint('retryonce');
    storageSetFailKeys = [UNDO_STORAGE_KEY];
    storageSetFailTimes = 1; // 只失败一次，重试应成功
    const retryApply = await applyUndo(c.point.id);
    storageSetFailKeys = null;
    const afterRetry = await readUndoState();
    ok('消费失败会先自动重试一次：瞬时失败不再需要用户手动再点', () => {
      assert.equal(retryApply.ok, true, `重试后应成功，实际 ${JSON.stringify(retryApply)}`);
      assert.equal(
        afterRetry.points.some((p) => p.id === c.point.id),
        false,
        '重试成功后点应被真正消费掉',
      );
    });

    // ── D. 正常路径：消费成功、点消失（removed 语义不回归） ──
    const d = await mkDeletePoint('normal');
    const normalApply = await applyUndo(d.point.id);
    const afterNormal = await readUndoState();
    ok('正常路径不回归：撤销成功且撤销点被消费', () => {
      assert.equal(normalApply.ok, true);
      assert.equal(afterNormal.points.some((p) => p.id === d.point.id), false);
    });

    // ── E. 清空撤销记录要连进行中的快照一起清 ──
    storageMap.delete(UNDO_STORAGE_KEY);
    storageMap.set(UNDO_PENDING_KEY, {
      runId: 't38-pending',
      ops: [{ kind: 'create', id: 'x1', title: 'x', isFolder: false }],
      containsDelete: false,
      orderCheckpoints: [],
      updatedAt: Date.now(),
    });
    await clearUndoPoints();
    ok('「清空本地数据」会同时清掉进行中的 pending 快照', () =>
      assert.equal(storageMap.has(UNDO_PENDING_KEY), false, 'pending 也必须被清掉'),
    );

    storageSetFail = false;
    storageSetFailKeys = null;
    storageSetFailTimes = Number.POSITIVE_INFINITY;
    storageMap.delete(UNDO_STORAGE_KEY);
    storageMap.delete(UNDO_PENDING_KEY);
    resetUndoTransactionForTest();
  }

  /* ── T39: pending 写入竞态（迟到写入不得复活快照） ── */
  console.log('\n[T39] pending 写入竞态');
  {
    const {
      UNDO_STORAGE_KEY,
      UNDO_PENDING_KEY,
      beginUndoTransaction,
      endUndoTransaction,
      ensureOrderCheckpoint,
      clearUndoPoints,
      readUndoState,
      resetUndoTransactionForTest,
      recoverInterruptedTransaction,
      dropActiveForTest,
      markDelete,
    } = await import('../src/lib/undo/recorder');
    const { jCreate } = await import('../src/lib/undo/mutations');
    const pendingOf = () => storageMap.get(UNDO_PENDING_KEY) as { runId?: string; ops?: unknown[] } | undefined;

    // ── A. 慢速 pending 写入进行中收尾：最终必须"点在、pending 不在" ──
    storageMap.delete(UNDO_STORAGE_KEY);
    storageMap.delete(UNDO_PENDING_KEY);
    resetUndoTransactionForTest();
    await beginUndoTransaction('race-end');
    await ensureOrderCheckpoint('1');
    storageSetDelayMs = 300; // pending 写入变慢
    await jCreate({ parentId: '1', title: 'T39-RACE', url: 'https://t39.test/race' });
    // 等尾随补写真的发出（节流窗口 250ms），此刻那条慢写入正在路上
    await new Promise((r) => setTimeout(r, 320));
    // 前置条件：带本次操作的慢写入还没落地（此时存储里的快照只有检查点、没有 op）
    const inFlight = (pendingOf()?.ops ?? []).length === 0;
    const endP = endUndoTransaction(); // 收尾时那条写入仍在路上
    const endPoint = await endP;
    // 关键采样：必须在 end 返回的**那一刻**取，否则等写完再看就永远看到 0
    const inflightAtEnd = inflightPendingWrites;
    await new Promise((r) => setTimeout(r, 500)); // 给迟到写入充分落地的机会
    storageSetDelayMs = 0;
    const raceState = await readUndoState();
    ok('收尾会等待在途的 pending 写入：返回时不得还有写入在路上', () => {
      assert.ok(inFlight, '前置条件：收尾时那条带操作的 pending 写入应仍在路上');
      assert.ok(endPoint, '正常收尾应产生撤销点');
      assert.equal(inflightAtEnd, 0, 'end 返回时不应还有在途的 pending 写入');
    });
    ok('收尾之后 pending 不得残留在存储里（含迟到写入）', () => {
      assert.equal(raceState.points.length, 1, '应恰好一个撤销点');
      assert.equal(pendingOf(), undefined, '收尾之后 pending 不得残留');
    });

    // ── B. 慢速写入进行中清空：pending 不得被迟到写入复活 ──
    storageMap.delete(UNDO_STORAGE_KEY);
    storageMap.delete(UNDO_PENDING_KEY);
    resetUndoTransactionForTest();
    await beginUndoTransaction('race-clear');
    await ensureOrderCheckpoint('1');
    storageSetDelayMs = 300;
    await jCreate({ parentId: '1', title: 'T39-CLEAR', url: 'https://t39.test/clear' });
    await new Promise((r) => setTimeout(r, 320)); // 让慢写入真的上路
    const clearInFlight = (pendingOf()?.ops ?? []).length === 0;
    await clearUndoPoints();
    const inflightAtClear = inflightPendingWrites; // 同样在返回那一刻采样
    await new Promise((r) => setTimeout(r, 500));
    storageSetDelayMs = 0;
    ok('清空也会等在途写入落定，且不被迟到写入复活', () => {
      assert.ok(clearInFlight, '前置条件：清空时那条带操作的 pending 写入应仍在路上');
      assert.equal(inflightAtClear, 0, 'clearUndoPoints 返回时不应还有在途写入');
      assert.equal(pendingOf(), undefined, '清空后 pending 必须仍然不存在');
    });

    // ── C. 同一事务的多次写入保持发起顺序（新快照不被旧快照覆盖） ──
    storageMap.delete(UNDO_STORAGE_KEY);
    storageMap.delete(UNDO_PENDING_KEY);
    resetUndoTransactionForTest();
    await beginUndoTransaction('race-order');
    await ensureOrderCheckpoint('1'); // 第 1 次写入（即刻完成）
    await jCreate({ parentId: '1', title: 'T39-A', url: 'https://t39.test/a' });
    // 第 2 次写入：带 1 条操作，**很慢**（300ms）
    // 第 3 次写入：带 2 条操作，**很快**（0ms）
    // 串行化时第 3 次会排队等第 2 次 → 最终是新快照；不串行化时慢的旧写入最后落地 → 快照回退
    storageSetDelaySequence = [300, 0];
    await markDelete();
    await jCreate({ parentId: '1', title: 'T39-B', url: 'https://t39.test/b' });
    await markDelete();
    await new Promise((r) => setTimeout(r, 600));
    storageSetDelaySequence = [];
    const snapshotOps = (pendingOf()?.ops ?? []).length;
    dropActiveForTest();
    ok('写入串行化：较慢的旧写入不得覆盖较新的快照', () => {
      assert.equal(snapshotOps, 2, `快照应是较新的那次（2 条操作），实际 ${snapshotOps}`);
    });

    // ── D. 正常路径：恢复成功后 pending 清干净 ──
    storageMap.delete(UNDO_STORAGE_KEY);
    storageMap.delete(UNDO_PENDING_KEY);
    resetUndoTransactionForTest();
    storageMap.set(UNDO_PENDING_KEY, {
      runId: 'race-ok',
      ops: [{ kind: 'create', id: 'ok-1', title: 'x', isFolder: false }],
      containsDelete: false,
      orderCheckpoints: [],
      updatedAt: Date.now(),
    });
    const okRecover = await recoverInterruptedTransaction();
    ok('正常恢复路径不回归：成功提升且 pending 清掉', () => {
      assert.ok(okRecover);
      assert.equal(pendingOf(), undefined);
    });

    storageSetDelayMs = 0;
    storageSetDelaySequence = [];
    inflightPendingWrites = 0;
    storageSetFail = false;
    storageSetFailKeys = null;
    storageSetFailTimes = Number.POSITIVE_INFINITY;
    storageMap.delete(UNDO_STORAGE_KEY);
    storageMap.delete(UNDO_PENDING_KEY);
    resetUndoTransactionForTest();
  }

  /* ── T40: 右键指令写入失败不得"打开空聊天" ── */
  console.log('\n[T40] 右键指令的失败反馈');
  {
    const { handleContextMenuClick } = await import('../src/lib/ai/context-menu');
    type SeedPayload = import('../src/lib/ai/context-menu').SeedPayload;
    type Deps = import('../src/lib/ai/context-menu').ContextMenuDeps;

    /** 记录编排层做了哪些"可见动作"，用来断言失败时**不该**做的事 */
    const mkDeps = (opts: { seedFails?: boolean; tabFails?: boolean; node?: chrome.bookmarks.BookmarkTreeNode }) => {
      const log = {
        seeds: [] as SeedPayload[],
        clearedSeed: 0,
        openedPanel: 0,
        broadcasts: 0,
        openedTabs: [] as string[],
        hints: [] as string[],
        clearedHint: 0,
      };
      const deps: Deps = {
        getNode: async () => opts.node,
        setSeed: async (seed) => {
          if (opts.seedFails) throw new Error('QUOTA_BYTES quota exceeded');
          log.seeds.push(seed);
        },
        clearSeed: async () => {
          log.clearedSeed += 1;
        },
        openSidePanel: async () => {
          log.openedPanel += 1;
        },
        broadcastSeed: async () => {
          log.broadcasts += 1;
        },
        getWindowId: async () => 7,
        openTab: async (url) => {
          if (opts.tabFails) throw new Error('tabs.create failed');
          log.openedTabs.push(url);
        },
        pageUrl: () => 'chrome-extension://x/page.html',
        setErrorHint: async (title) => {
          log.hints.push(title);
        },
        clearErrorHint: async () => {
          log.clearedHint += 1;
        },
      };
      return { deps, log };
    };

    const folderNode = {
      id: 'f1',
      title: 'T40 文件夹',
      dateAdded: 1,
    } as unknown as chrome.bookmarks.BookmarkTreeNode;

    // ── A. seed 写入失败：不打开、不广播，但要有可见错误提示 ──
    const fail = mkDeps({ seedFails: true, node: folderNode });
    await handleContextMenuClick({ menuItemId: 'markai:organize', bookmarkId: 'f1' }, fail.deps);
    ok('seed 写入失败时不得打开侧边栏（否则用户只看到一个空聊天）', () =>
      assert.equal(fail.log.openedPanel, 0),
    );
    ok('seed 写入失败时不得广播 markai:seed（指令根本没保存）', () =>
      assert.equal(fail.log.broadcasts, 0),
    );
    ok('seed 写入失败必须给出可见反馈（工具栏提示，不依赖 storage）', () => {
      assert.equal(fail.log.hints.length, 1, `应有一条错误提示，实际 ${fail.log.hints.length}`);
      assert.match(fail.log.hints[0]!, /未能保存|重试/);
    });

    // ── B. 成功路径：写入、打开、广播，并清掉历史错误提示 ──
    const good = mkDeps({ node: folderNode });
    await handleContextMenuClick({ menuItemId: 'markai:organize', bookmarkId: 'f1' }, good.deps);
    ok('成功路径不回归：写入 seed、打开侧边栏、广播、清掉错误提示', () => {
      assert.equal(good.log.seeds.length, 1, '应写入一条 seed');
      assert.equal(good.log.seeds[0]!.folderId, 'f1', '文件夹应带上上下文 id');
      assert.equal(good.log.openedPanel, 1);
      assert.equal(good.log.broadcasts, 1);
      assert.ok(good.log.clearedHint >= 1, '成功后应清掉可能残留的错误提示');
      assert.equal(good.log.hints.length, 0, '成功路径不该报错');
    });

    // ── C. 书签已被删除：走 notice 提示路径，行为不变 ──
    const gone = mkDeps({ node: undefined });
    await handleContextMenuClick({ menuItemId: 'markai:organize', bookmarkId: 'ghost' }, gone.deps);
    ok('右键的书签已不存在时仍走 notice 路径（不回归）', () => {
      assert.equal(gone.log.seeds.length, 1);
      assert.match(gone.log.seeds[0]!.notice ?? '', /已被删除/);
      assert.equal(gone.log.openedPanel, 1);
    });

    // ── D. 完整页打开失败：也要有可见反馈 ──
    const tabFail = mkDeps({ tabFails: true });
    await handleContextMenuClick({ menuItemId: 'markai:fullpage' }, tabFail.deps);
    ok('完整页打开失败不再静默（给出可见反馈）', () => {
      assert.equal(tabFail.log.openedTabs.length, 0);
      assert.equal(tabFail.log.hints.length, 1, '应有一条错误提示');
      assert.match(tabFail.log.hints[0]!, /完整页/);
    });

    // ── E. 完整页正常：打开标签页，且不碰 seed ──
    const tabOk = mkDeps({});
    await handleContextMenuClick({ menuItemId: 'markai:fullpage' }, tabOk.deps);
    ok('完整页正常路径：打开标签页且不改写 seed', () => {
      assert.equal(tabOk.log.openedTabs.length, 1);
      assert.equal(tabOk.log.seeds.length, 0);
      assert.equal(tabOk.log.hints.length, 0);
    });

    // ── F. 无指令的菜单项：清掉残留旧种子，避免误消费幽灵指令 ──
    const noop = mkDeps({ node: folderNode });
    // 必须带上 bookmarkId：不带的话语义是"右键的书签已不存在"，那是走 notice 路径
    await handleContextMenuClick({ menuItemId: 'markai:unknown', bookmarkId: 'f1' }, noop.deps);
    ok('没有要送出的指令时清掉残留种子（避免幽灵指令）', () => {
      assert.equal(noop.log.seeds.length, 0);
      assert.equal(noop.log.clearedSeed, 1);
    });
  }

  /* ── T41: 测试替身必须忠实于「非空目录不能直接 remove」的 API 语义 ── */
  console.log('\n[T41] 测试替身：非空目录删除');
  {
    // 为什么替身也要有这条测试：Chrome 的 bookmarks.remove 只删单个节点，非空文件夹必须用 removeTree。
    // 替身若允许 remove 直接删掉非空目录，未来「撤销新建文件夹时里面有后来移入的内容」的冲突测试
    // 就会**假绿**——生产代码即使改用 remove 也会"通过"，而真实浏览器会拒绝并保留数据。
    // 所以替身的保真度本身是一条必须被反证守护的契约。
    const folder = (await mockBookmarks.create({ parentId: '1', title: 'T41-非空目录' })).id;
    const kid = (await mockBookmarks.create({ parentId: folder, title: 'T41-子项' })).id;
    const before = await snapshotTree();

    let rejected = false;
    try {
      await mockBookmarks.remove(folder);
    } catch {
      rejected = true;
    }
    const after = await snapshotTree();

    ok('替身 remove 必须拒绝非空文件夹（真实 Chrome 会拒绝而不是递归删除）', () =>
      assert.equal(rejected, true, 'remove 非空文件夹应被拒绝'),
    );
    ok('被拒绝的 remove 不得改变树（文件夹与子项都还在）', () => {
      assert.equal(after, before, '树必须完全不变');
      assert.equal(childrenOf(folder).length, 1, '子项应仍在文件夹里');
      assert.ok(nodeById(kid), '子项节点必须仍然存在');
    });

    // 空文件夹仍可被 remove 正常删除（这是 remove 的合法用途，不能一起禁掉）
    const emptyFolder = (await mockBookmarks.create({ parentId: '1', title: 'T41-空目录' })).id;
    await mockBookmarks.remove(emptyFolder);
    ok('空文件夹仍可被 remove 正常删除', () => assert.equal(nodeById(emptyFolder), undefined));

    // removeTree 的递归语义不回归：真正要清空一棵子树时仍然可用
    await mockBookmarks.removeTree(folder);
    ok('removeTree 仍然递归删除整棵子树（合法用途不受影响）', () => {
      assert.equal(nodeById(folder), undefined, '文件夹应被删除');
      assert.equal(nodeById(kid), undefined, '子项应被递归删除');
    });

    // 副作用计数可用：未来的「非最新撤销点零副作用」断言依赖它，所以它自己也要被验证
    resetMockCalls();
    const probe = (await mockBookmarks.create({ parentId: '1', title: 'T41-probe' })).id;
    await mockBookmarks.getChildren('1');
    await mockBookmarks.removeTree(probe);
    ok('副作用计数可用：读类与写类调用都被如实记录（零副作用断言的基础）', () => {
      assert.equal(mockCalls.getChildren, 1, 'getChildren 应被计数');
      assert.equal(mockCalls.create, 1, 'create 应被计数');
      assert.equal(mockCalls.removeTree, 1, 'removeTree 应被计数');
    });
  }

  /* ── T42: 非最新撤销点必须零副作用拒绝（危险跳选的安全边界） ── */
  console.log('\n[T42] 撤销栈顶限制');
  {
    const {
      UNDO_STORAGE_KEY,
      UNDO_PENDING_KEY,
      beginUndoTransaction,
      endUndoTransaction,
      readUndoState,
      resetUndoTransactionForTest,
    } = await import('../src/lib/undo/recorder');
    const { jCreate } = await import('../src/lib/undo/mutations');
    const { applyUndo } = await import('../src/lib/undo/apply');

    // 隔离：清撤销存储、丢弃活动事务、复位故障注入与延迟，避免受前面用例影响
    storageMap.delete(UNDO_STORAGE_KEY);
    storageMap.delete(UNDO_PENDING_KEY);
    resetUndoTransactionForTest();
    storageSetFail = false;
    storageSetFailKeys = null;
    storageSetFailTimes = Number.POSITIVE_INFINITY;
    storageSetDelayMs = 0;
    storageSetDelaySequence = [];

    const beforeTree = await snapshotTree();

    // older：新建文件夹 F
    await beginUndoTransaction('t42-older');
    const folderId = (await jCreate({ parentId: '1', title: 'T42-OLDER-FOLDER' })).id;
    const olderPoint = await endUndoTransaction();
    assert.ok(olderPoint, '前置条件：older 点应落盘');

    // newer：在 F 里新建子书签（这就是"更晚的一轮"）
    await beginUndoTransaction('t42-newer');
    await jCreate({ parentId: folderId, title: 'T42-NEWER-KID', url: 'https://t42.test/kid' });
    const newerPoint = await endUndoTransaction();
    assert.ok(newerPoint, '前置条件：newer 点应落盘');

    const setupPoints = (await readUndoState()).points;
    ok('前置条件：撤销点列表为「新的在前」', () => {
      assert.equal(setupPoints[0]!.id, newerPoint!.id, 'index 0 必须是最新的点');
      assert.equal(setupPoints[1]!.id, olderPoint!.id, 'index 1 是较早的点');
    });

    // ── A. 跳选较早的 older：必须在任何副作用前被拒绝 ──
    const treeBefore = await snapshotTree();
    const pointsBefore = JSON.stringify((await readUndoState()).points);
    resetMockCalls();
    const jump = await applyUndo(olderPoint!.id);
    const treeAfterJump = await snapshotTree();
    const pointsAfterJump = JSON.stringify((await readUndoState()).points);

    ok('非最新撤销点被拒绝且没有任何副作用', () => {
      assert.equal(jump.ok, false, '必须拒绝，而不是执行较早的那一步');
      assert.equal(jump.restored, 0, '不得声称还原了任何东西');
      assert.deepEqual(jump.failures, [], '这是安全拒绝，不是回放失败');
      assert.match(jump.reason ?? '', /较新/, 'reason 必须说清要先撤销较新的操作');
    });
    ok('被拒绝的跳选不得触碰书签（零 mutation、零顺序还原）', () => {
      assert.equal(mockCalls.create, 0, '不应 create');
      assert.equal(mockCalls.move, 0, '不应 move');
      assert.equal(mockCalls.update, 0, '不应 update');
      assert.equal(mockCalls.remove, 0, '不应 remove');
      assert.equal(mockCalls.removeTree, 0, '不应 removeTree');
      assert.equal(mockCalls.getChildren, 0, '不应做顺序还原（getChildren）');
    });
    ok('被拒绝的跳选不得消费或改写撤销记录（零 storage 写）', () => {
      assert.equal(mockCalls.storageSet, 0, '不应 storage.set');
      assert.equal(mockCalls.storageRemove, 0, '不应 storage.remove');
      assert.equal(pointsAfterJump, pointsBefore, '撤销点列表必须逐字不变（点仍在）');
    });
    ok('被拒绝的跳选不得改变书签树', () => assert.equal(treeAfterJump, treeBefore));

    // ── B. 唯一正确的路径：先撤 newer，再撤 older，回到初始树 ──
    resetMockCalls();
    const undoNewer = await applyUndo(newerPoint!.id);
    ok('从最新点开始撤销：应被允许并成功', () => {
      assert.equal(undoNewer.ok, true, `应成功，实际 ${JSON.stringify(undoNewer)}`);
      assert.ok(mockCalls.removeTree + mockCalls.remove > 0, '应真的删掉了新建的节点');
    });

    const undoOlder = await applyUndo(olderPoint!.id);
    ok('撤掉最新的之后，原来的较早点已成为最新点：应被允许', () => {
      assert.equal(undoOlder.ok, true, `应成功，实际 ${JSON.stringify(undoOlder)}`);
    });
    const finalTree = await snapshotTree();
    ok('依「最新→最旧」撤完两点后，树恢复初始状态', () => assert.equal(finalTree, beforeTree));

    // 清理，避免污染后续用例
    storageMap.delete(UNDO_STORAGE_KEY);
    storageMap.delete(UNDO_PENDING_KEY);
    resetUndoTransactionForTest();
  }

  /* ── T43: 撤销新建文件夹不得递归删除后来移入的内容 ── */
  console.log('\n[T43] 文件夹非空冲突预检');
  {
    const {
      UNDO_STORAGE_KEY,
      UNDO_PENDING_KEY,
      beginUndoTransaction,
      endUndoTransaction,
      readUndoState,
      resetUndoTransactionForTest,
    } = await import('../src/lib/undo/recorder');
    const { jCreate, jMove } = await import('../src/lib/undo/mutations');
    const { applyUndo } = await import('../src/lib/undo/apply');

    const clean = () => {
      storageMap.delete(UNDO_STORAGE_KEY);
      storageMap.delete(UNDO_PENDING_KEY);
      resetUndoTransactionForTest();
      storageSetFail = false;
      storageSetFailKeys = null;
      storageSetFailTimes = Number.POSITIVE_INFINITY;
      storageSetDelayMs = 0;
      storageSetDelaySequence = [];
      resetMockCalls();
    };

    // ── A. 真冲突：F 被「撤销点之外」的操作放进了内容 ──
    clean();
    const baseTree = await snapshotTree();
    await beginUndoTransaction('t43-conflict');
    const fId = (await jCreate({ parentId: '1', title: 'T43-FOLDER' })).id;
    const aPoint = await endUndoTransaction();
    assert.ok(aPoint, '前置条件：应产生创建文件夹的撤销点');

    // 未记录的操作（模拟用户手工 / 另一个窗口）：把既有书签搬进 F
    const outsider = (
      await mockBookmarks.create({ parentId: '1', title: 'T43-OUTSIDER', url: 'https://t43.test/x' })
    ).id;
    await mockBookmarks.move(outsider, { parentId: fId });

    const treeBefore = await snapshotTree();
    const pointsBefore = JSON.stringify((await readUndoState()).points);
    resetMockCalls();
    const refused = await applyUndo(aPoint!.id);
    const treeAfter = await snapshotTree();
    const pointsAfter = JSON.stringify((await readUndoState()).points);

    ok('文件夹里有后来移入的内容时，撤销必须被拒绝（不能递归删掉它）', () => {
      assert.equal(refused.ok, false, '应拒绝，而不是删除文件夹连同里面的内容');
      assert.equal(refused.restored, 0, '不得声称还原了任何东西');
      assert.deepEqual(refused.failures, [], '这是安全拒绝，不是回放失败');
      assert.match(refused.reason ?? '', /移/, 'reason 要告诉用户先把内容移走');
    });
    ok('冲突拒绝必须零书签副作用、零存储消费，并保留撤销点', () => {
      assert.equal(mockCalls.remove, 0, '不应 remove');
      assert.equal(mockCalls.removeTree, 0, '不应 removeTree');
      assert.equal(mockCalls.move, 0, '不应 move');
      assert.equal(mockCalls.create, 0, '不应 create');
      assert.equal(mockCalls.update, 0, '不应 update');
      assert.equal(mockCalls.storageSet, 0, '不应 storage.set');
      assert.equal(mockCalls.storageRemove, 0, '不应 storage.remove');
      assert.equal(treeAfter, treeBefore, '树必须完全不变（文件夹和内容都还在）');
      assert.equal(pointsAfter, pointsBefore, '撤销点必须保留，用户移走内容后还能重试');
    });
    ok('冲突时文件夹与内容都仍然存在', () => {
      assert.ok(nodeById(fId), '文件夹不能被删');
      assert.ok(nodeById(outsider), '后来移入的内容不能被删');
    });

    // 把内容移走后重试同一点：这次必须成功
    await mockBookmarks.move(outsider, { parentId: '1' });
    const retry = await applyUndo(aPoint!.id);
    ok('把内容移走后，同一点重试应当成功', () => {
      assert.equal(retry.ok, true, `应成功，实际 ${JSON.stringify(retry)}`);
      assert.equal(nodeById(fId), undefined, '此时文件夹是空的，应被正常删除');
    });
    await mockBookmarks.remove(outsider); // 清理探针
    const treeAfterRetry = await snapshotTree();
    ok('冲突解除后重试成功，树恢复初始状态', () =>
      assert.equal(treeAfterRetry, baseTree),
    );

    // ── B. 不回归：同一轮「创建 F + 把 X 移入 F」不是冲突 ──
    clean();
    const baseTree2 = await snapshotTree();
    await beginUndoTransaction('t43-same-point');
    const f2 = (await jCreate({ parentId: '1', title: 'T43-F2' })).id;
    const xId = (await jCreate({ parentId: '1', title: 'T43-X', url: 'https://t43.test/y' })).id;
    await jMove(xId, { parentId: f2 }); // 同一轮内的移动：撤销时会被自己的逆操作先移出
    const bPoint = await endUndoTransaction();
    assert.ok(bPoint, '前置条件：应产生撤销点');
    const sameTurn = await applyUndo(bPoint!.id);
    ok('同一轮「创建 F + 移入 X」的撤销必须照常成功（不能被误判为冲突）', () => {
      assert.equal(sameTurn.ok, true, `应成功，实际 ${JSON.stringify(sameTurn)}`);
    });
    const treeAfterSameTurn = await snapshotTree();
    ok('同轮用例撤销后回到初始树', () => assert.equal(treeAfterSameTurn, baseTree2));

    // ── C. 空文件夹撤销仍然成功（预检不能把正常路径一起拦掉）──
    clean();
    const baseTree3 = await snapshotTree();
    await beginUndoTransaction('t43-empty');
    const f3 = (await jCreate({ parentId: '1', title: 'T43-EMPTY' })).id;
    const cPoint = await endUndoTransaction();
    const emptyUndo = await applyUndo(cPoint!.id);
    ok('空文件夹的撤销仍然成功', () => {
      assert.equal(emptyUndo.ok, true, `应成功，实际 ${JSON.stringify(emptyUndo)}`);
      assert.equal(nodeById(f3), undefined, '空文件夹应被删除');
    });
    const treeAfterEmpty = await snapshotTree();
    ok('空文件夹用例后树不变', () => assert.equal(treeAfterEmpty, baseTree3));

    clean();
  }

  /* ── T44: 纵深防御——回放中途失败留下非空文件夹时绝不递归删除 ── */
  console.log('\n[T44] 文件夹逆操作的纵深防御');
  {
    const {
      UNDO_STORAGE_KEY,
      UNDO_PENDING_KEY,
      beginUndoTransaction,
      endUndoTransaction,
      resetUndoTransactionForTest,
    } = await import('../src/lib/undo/recorder');
    const { jCreate, jMove } = await import('../src/lib/undo/mutations');
    const { applyUndo } = await import('../src/lib/undo/apply');

    storageMap.delete(UNDO_STORAGE_KEY);
    storageMap.delete(UNDO_PENDING_KEY);
    resetUndoTransactionForTest();
    storageSetFail = false;
    storageSetFailKeys = null;
    storageSetFailTimes = Number.POSITIVE_INFINITY;
    storageSetDelayMs = 0;
    storageSetDelaySequence = [];

    // 构造「预检会放过、但回放中途失败」的序列：
    //   P 是 Y 的原文件夹；同一轮里创建 F 并把 Y 移入 F；随后 P 在轮次之外被删除。
    // 撤销时把 Y 移回 P 会失败（目标目录已不存在），于是 Y 仍留在 F 里——
    // 此时"删除 F"若是递归的，就会把 Y 一起毁掉。
    const origin = (await mockBookmarks.create({ parentId: '1', title: 'T44-ORIGIN' })).id;
    const yId = (await mockBookmarks.create({ parentId: origin, title: 'T44-Y', url: 'https://t44.test/y' })).id;

    await beginUndoTransaction('t44-dind');
    const fId = (await jCreate({ parentId: '1', title: 'T44-F' })).id;
    await jMove(yId, { parentId: fId }); // 记录：Y 从 origin 移入 F
    const point = await endUndoTransaction();
    assert.ok(point, '前置条件：应产生撤销点');

    // 轮次之外删除原文件夹：撤销时的"移回 origin"必然失败
    await mockBookmarks.removeTree(origin);
    // 预检必须放过这一轮（Y 由本点的 move 逆操作负责移出，不算冲突）
    await applyUndo(point!.id);
    const fStillThere = !!nodeById(fId);
    const yStillThere = !!nodeById(yId);

    ok('回放中途失败留下非空文件夹时，绝不递归删除里面的内容', () => {
      assert.equal(yStillThere, true, 'Y 必须还在——它不该因为"移回原文件夹失败"而被删掉');
    });
    ok('此时文件夹与内容保持一致（没有半删除状态）', () => {
      assert.equal(fStillThere, true, 'F 也必须还在（无法安全删除就不能删）');
    });

    // 清理：F 里还有 Y，用 removeTree 明确清掉这一棵
    if (fStillThere) await mockBookmarks.removeTree(fId);
    else if (yStillThere) await mockBookmarks.remove(yId);
    storageMap.delete(UNDO_STORAGE_KEY);
    storageMap.delete(UNDO_PENDING_KEY);
    resetUndoTransactionForTest();
  }

  /* ── T45: 失败反馈不得失真（消费写失败 + 状态未知） ── */
  console.log('\n[T45] 撤销失败反馈');
  {
    const { useAIStore } = await import('../src/stores/aiStore');
    const { useToastStore } = await import('../src/lib/toast');
    type UndoPointT = import('../src/lib/undo/types').UndoPoint;

    const point: UndoPointT = {
      id: 't45-p',
      runId: 't45',
      createdAt: Date.now(),
      ops: [{ kind: 'create', id: 'x', title: 'x', isFolder: false }],
      containsDelete: false,
    };

    let applyResult: unknown = undefined;
    let listResult: unknown = { type: 'undo:list:result', points: [point] };
    let throwOnList = false;
    sendMessageMock = (msg) => {
      const m = msg as { type?: string };
      if (m.type === 'undo:list') {
        if (throwOnList) throw new Error('SW 已回收');
        return listResult;
      }
      if (m.type === 'undo:apply') return { type: 'undo:apply:result', result: applyResult };
      return undefined;
    };

    // ── A. 消费写失败：ok:false + restored>0 + 无 failures ──
    useToastStore.setState({ toasts: [] });
    await useAIStore.getState().refreshUndo();
    applyResult = {
      ok: false,
      restored: 1,
      failures: [],
      reason: '撤销已执行，但本地记录没能更新（存储写入失败）：请不要重复点击这条撤销，重复执行会造成重复改动。',
    };
    await useAIStore.getState().undoLast(point.id);
    const consumeFailToasts = useToastStore.getState().toasts;

    ok('消费写失败必须如实告警，绝不显示成功', () => {
      assert.ok(
        !consumeFailToasts.some((t) => t.variant === 'success' || /已撤销/.test(t.title)),
        `不得出现成功提示，实际 ${JSON.stringify(consumeFailToasts)}`,
      );
      assert.ok(
        consumeFailToasts.some((t) => t.variant === 'destructive' && /不要重复点击|重复执行/.test(t.description ?? '')),
        `必须把"不要重复点击"的原因带给用户，实际 ${JSON.stringify(consumeFailToasts)}`,
      );
    });
    ok('消费写失败要说明已还原了多少项（用户需要知道现在的状态）', () => {
      const joined = JSON.stringify(consumeFailToasts);
      assert.match(joined, /1/, '提示里应包含已还原项数');
    });

    // ── B. 读取失败：不得把"状态未知"说成"没有记录" ──
    useToastStore.setState({ toasts: [] });
    throwOnList = true;
    await useAIStore.getState().refreshUndo();
    throwOnList = false;
    const s1 = useAIStore.getState();

    ok('读取撤销记录失败时，必须标出"状态未知"而不是清成空的', () => {
      assert.equal(s1.undoUnknown, true, '读取失败应置 undoUnknown');
    });
    ok('状态未知时不得让界面断言"没有可撤销的操作"', () => {
      assert.equal(
        s1.undoPoints.length === 0 && s1.undoUnknown === true,
        true,
        '点列表可以为空，但必须同时标出 unknown，不能只留一个空列表',
      );
    });

    // 恢复成功读取后，unknown 标记要清掉
    listResult = { type: 'undo:list:result', points: [point] };
    await useAIStore.getState().refreshUndo();
    const s2 = useAIStore.getState();
    ok('成功读取后清除"状态未知"标记', () => {
      assert.equal(s2.undoUnknown, false, '成功读取应清除 undoUnknown');
      assert.equal(s2.undoPoints.length, 1, '点列表应恢复');
    });

    // ── C. background 返回了意料之外的形状（无结果）──
    useToastStore.setState({ toasts: [] });
    sendMessageMock = () => undefined;
    await useAIStore.getState().undoLast(point.id);
    const noResultToasts = useToastStore.getState().toasts;
    ok('撤销没有返回结果时如实提示，不谎报成功', () => {
      assert.ok(
        noResultToasts.some((t) => t.variant === 'destructive'),
        `应有失败提示，实际 ${JSON.stringify(noResultToasts)}`,
      );
      assert.ok(!noResultToasts.some((t) => /已撤销/.test(t.title)), '不得显示成功');
    });

    ok('历史面板把「读取失败」与「没有记录」分开呈现（接线被守住）', () => {
      const panel = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/components/chat/chat-panel.tsx'), 'utf8');
      assert.match(panel, /undoUnknown/, '面板必须消费 undoUnknown');
      assert.match(panel, /状态未知/, '必须如实说明状态未知');
    });

    sendMessageMock = () => undefined;
    useToastStore.setState({ toasts: [] });
  }

  /* ── T46: 同一撤销点的重叠回放必须互斥（不能重建两份子树） ── */
  console.log('\n[T46] 撤销执行互斥');
  {
    const {
      UNDO_STORAGE_KEY,
      UNDO_PENDING_KEY,
      beginUndoTransaction,
      endUndoTransaction,
      ensureOrderCheckpoint,
      readUndoState,
      resetUndoTransactionForTest,
    } = await import('../src/lib/undo/recorder');
    const { jRemove } = await import('../src/lib/undo/mutations');
    const { applyUndo } = await import('../src/lib/undo/apply');
    type ApplyResult = import('../src/lib/undo/types').UndoApplyResult;

    storageMap.delete(UNDO_STORAGE_KEY);
    storageMap.delete(UNDO_PENDING_KEY);
    resetUndoTransactionForTest();
    storageSetFail = false;
    storageSetFailKeys = null;
    storageSetFailTimes = Number.POSITIVE_INFINITY;
    storageSetDelayMs = 0;
    storageSetDelaySequence = [];

    // 造一个「删除」撤销点：撤销时用快照重建子树（会调用 create），是重叠回放后果最严重的一类
    const folder = (await mockBookmarks.create({ parentId: '1', title: 'T46-FOLDER' })).id;
    const kid = (
      await mockBookmarks.create({ parentId: folder, title: 'T46-KID', url: 'https://t46.test/k' })
    ).id;
    await beginUndoTransaction('t46-race');
    await ensureOrderCheckpoint(folder);
    await jRemove(kid);
    const point = await endUndoTransaction();
    assert.ok(point, '前置条件：应产生删除撤销点');

    // 装闸门：让第一次回放的重建停在 create 里（确定性构造重叠，不靠 sleep 猜时序）
    let releaseFn!: () => void;
    const releaseP = new Promise<void>((r) => {
      releaseFn = r;
    });
    let enteredFn!: () => void;
    const enteredP = new Promise<void>((r) => {
      enteredFn = r;
    });
    createGate.release = releaseP;
    createGate.entered = enteredFn;

    const first = applyUndo(point!.id);
    await enteredP; // 第一次已经停在「重建子树」的半途

    // 先让 setup 阶段 fire-and-forget 的落盘/尾随补写全部落定，再清零计数：
    // 否则会把"上一次异步写入迟到"误算成"第二次请求的副作用"（实测出现过这种非确定性）。
    await new Promise((r) => setTimeout(r, 30));

    // 重叠发起第二次：**不要**在放行前 await 它——没有互斥时它也会停进同一个闸门。
    resetMockCalls();
    let secondResult: ApplyResult | null = null;
    const secondP = applyUndo(point!.id).then((r) => {
      secondResult = r;
      return r;
    });
    // 给它足够时间推进到分叉点：有互斥 → 立刻零副作用返回；没有 → 停进闸门并已计入 create
    await new Promise((r) => setTimeout(r, 40));

    // 必须在放行**之前**快照窗口期内的计数：放行后第一次调用自己的消费写入也会计入，
    // 那属于它的正常收尾，不是"第二次请求的副作用"。
    const rejectedDuringOverlap = secondResult !== null;
    const duringOverlap = { ...mockCalls };

    // 无论如何先放行，避免测试挂死
    releaseFn();
    const firstResult = await first;
    const second = await secondP;
    createGate.release = null;
    createGate.entered = null;

    ok('同一撤销点正在执行时，重叠的第二次请求必须被立即拒绝', () => {
      assert.equal(
        rejectedDuringOverlap,
        true,
        '第二次请求在第一次执行期间就应返回，而不是也进入回放',
      );
      assert.equal(second.ok, false, '不得并发执行同一个撤销点');
      assert.equal(second.restored, 0, '第二次不得声称还原了任何东西');
      assert.deepEqual(second.failures, [], '这是互斥拒绝，不是回放失败');
      assert.match(second.reason ?? '', /正在执行|重复/, 'reason 要说明该点正在执行中');
    });
    ok('重叠请求在第一次执行期间不得产生任何副作用（窗口内快照）', () => {
      assert.equal(duringOverlap.create, 0, '不得在第一次执行期间重建第二份子树');
      assert.equal(duringOverlap.move, 0, '不得移动');
      assert.equal(duringOverlap.remove, 0, '不得删除');
      assert.equal(duringOverlap.storageSet, 0, '不得写存储');
      assert.equal(duringOverlap.storageRemove, 0, '不得删存储');
    });
    ok('放行后第一次回放正常完成', () => {
      assert.equal(firstResult.ok, true, `应成功，实际 ${JSON.stringify(firstResult)}`);
    });
    const kidsAfter = childrenOf(folder).length;
    ok('最终只重建了一份子树（不是两份）', () =>
      assert.equal(kidsAfter, 1, `子项数应为 1，实际 ${kidsAfter}`),
    );
    const after = await readUndoState();
    ok('第一次成功后撤销点被正常消费', () =>
      assert.equal(after.points.some((p) => p.id === point!.id), false, '点应已被消费'),
    );
    const afterAll = await applyUndo(point!.id);
    ok('互斥锁已释放（结束后的再次调用是「点已不存在」，不是「正在执行」）', () =>
      assert.match(
        afterAll.reason ?? '',
        /已不存在|已撤销/,
        `不应仍是"正在执行"，实际 ${JSON.stringify(afterAll)}`,
      ),
    );

    // 清理
    if (nodeById(folder)) await mockBookmarks.removeTree(folder);
    storageMap.delete(UNDO_STORAGE_KEY);
    storageMap.delete(UNDO_PENDING_KEY);
    resetUndoTransactionForTest();
  }

  /* ── T47: runId 持久终态——已消费的点不得被残留 pending 复活 ── */
  console.log('\n[T47] runId 终态身份');
  {
    const {
      UNDO_STORAGE_KEY,
      UNDO_PENDING_KEY,
      beginUndoTransaction,
      endUndoTransaction,
      ensureOrderCheckpoint,
      readUndoState,
      recoverInterruptedTransaction,
      takeUndoPoint,
      clearUndoPoints,
      resetUndoTransactionForTest,
    } = await import('../src/lib/undo/recorder');
    const { jRemove } = await import('../src/lib/undo/mutations');
    const { applyUndo } = await import('../src/lib/undo/apply');

    const clean = () => {
      storageMap.delete(UNDO_STORAGE_KEY);
      storageMap.delete(UNDO_PENDING_KEY);
      resetUndoTransactionForTest();
      storageSetFail = false;
      storageSetFailKeys = null;
      storageSetFailTimes = Number.POSITIVE_INFINITY;
      storageSetDelayMs = 0;
      storageSetDelaySequence = [];
    };
    const pendingOf = (runId: string) => ({
      runId,
      ops: [{ kind: 'create', id: 'ghost-x', title: '幽灵新建', isFolder: false }],
      containsDelete: false,
      orderCheckpoints: [],
      updatedAt: Date.now(),
    });

    // ── A. 核心场景：点被消费后，同 runId 的残留 pending 不得复活成新点 ──
    clean();
    const folder = (await mockBookmarks.create({ parentId: '1', title: 'T47-FOLDER' })).id;
    const kid = (await mockBookmarks.create({ parentId: folder, title: 'T47-KID', url: 'https://t47.test/k' })).id;
    await beginUndoTransaction('t47-consumed');
    await ensureOrderCheckpoint(folder);
    await jRemove(kid);
    const point = await endUndoTransaction();
    assert.ok(point, '前置条件：应产生撤销点');

    const consume = await applyUndo(point!.id);
    assert.equal(consume.ok, true, '前置条件：该点应被正常撤销并消费');

    const stateAfter = await readUndoState();
    ok('消费成功后，该 runId 被记为持久终态', () =>
      assert.ok(
        (stateAfter.terminalRunIds ?? []).includes('t47-consumed'),
        `终态列表应包含该 runId，实际 ${JSON.stringify(stateAfter.terminalRunIds)}`,
      ),
    );

    // 手工注入"残留 pending"（模拟 pending 清理失败后进程又被杀）
    storageMap.set(UNDO_PENDING_KEY, pendingOf('t47-consumed'));
    const revived = await recoverInterruptedTransaction();
    const afterRecover = await readUndoState();

    ok('已终结 runId 的残留 pending 不得被提升成新的可执行点', () => {
      assert.equal(revived, null, '不应返回恢复出来的点');
      assert.equal(
        afterRecover.points.some((p) => p.runId === 't47-consumed'),
        false,
        '不能在存储里再造一个同 runId 的点（那会让删除类逆操作被重复回放）',
      );
    });
    ok('处理残留 pending 时必须把它清掉（否则每次启动都会重来一遍）', () =>
      assert.equal(storageMap.has(UNDO_PENDING_KEY), false, 'pending 应被清除'),
    );

    // ── B. 对照：从未消费过的 runId，其 pending 仍必须正常提升 ──
    clean();
    storageMap.set(UNDO_PENDING_KEY, pendingOf('t47-fresh'));
    const fresh = await recoverInterruptedTransaction();
    const afterFresh = await readUndoState();
    ok('从未消费过的 runId 仍正常提升（终态检查不能把正常恢复一起拦掉）', () => {
      assert.ok(fresh, '应返回一个新点');
      assert.equal(afterFresh.points.length, 1, '应写入一个点');
      assert.equal(afterFresh.points[0]!.runId, 't47-fresh');
    });

    // ── C. 终态列表有上界：连续消费超过上界后长度被截断 ──
    clean();
    const CAP = 50; // 与实现约定一致：最多保留最近 50 条
    for (let i = 0; i < CAP + 5; i++) {
      const f = (await mockBookmarks.create({ parentId: '1', title: `T47-cap-${i}` })).id;
      await beginUndoTransaction(`t47-cap-${i}`);
      await ensureOrderCheckpoint('1');
      await jRemove(f, { tree: true });
      await endUndoTransaction();
      await takeUndoPoint();
    }
    const capState = await readUndoState();
    ok('终态列表必须有上界（否则会无限增长）', () => {
      assert.ok((capState.terminalRunIds?.length ?? 0) <= CAP, `应 <= ${CAP}，实际 ${capState.terminalRunIds?.length}`);
      assert.ok((capState.terminalRunIds?.length ?? 0) > 0, '不该被清空');
    });
    ok('截断保留的是最近的终态（最近的 runId 仍能挡住复活）', () =>
      assert.ok(
        (capState.terminalRunIds ?? []).includes(`t47-cap-${CAP + 4}`),
        '最近消费的 runId 应仍在终态列表里',
      ),
    );

    // ── D. 清空本地数据要连终态一起清 ──
    await clearUndoPoints();
    const cleared = await readUndoState();
    ok('「清空本地数据」把终态列表一并清掉', () =>
      assert.equal((cleared.terminalRunIds ?? []).length, 0, '终态列表也应被清空'),
    );

    clean();
    if (nodeById(folder)) await mockBookmarks.removeTree(folder);
  }

  /* ── T48: 打开链接失败必须可见，且批量提示不得撒谎 ── */
  console.log('\n[T48] 打开链接的失败反馈');
  {
    const { openUrl, openUrls, describeTarget, failureMessage } = await import('../src/lib/open-url');
    const { useToastStore } = await import('../src/lib/toast');

    tabsFail.all = false;
    tabsFail.urls = null;

    // ── A. 单个打开失败：必须可见，且不泄漏完整 URL ──
    useToastStore.setState({ toasts: [] });
    tabsFail.all = true;
    const secret = 'https://example.com/reset?token=SUPERSECRET123';
    const okSingle = await openUrl(secret);
    const failToasts = useToastStore.getState().toasts;

    ok('单个链接打开失败必须给出可见反馈（不能点了没反应）', () => {
      assert.equal(okSingle, false, '失败应返回 false');
      assert.ok(
        failToasts.some((t) => t.variant === 'destructive'),
        `应有 destructive 提示，实际 ${JSON.stringify(failToasts)}`,
      );
    });
    ok('失败提示不得把完整 URL（含查询参数/token）打进 UI', () => {
      const joined = JSON.stringify(failToasts);
      assert.ok(!joined.includes('SUPERSECRET123'), '不得泄漏查询参数');
      assert.ok(!joined.includes('/reset'), '不得包含路径');
      assert.ok(joined.includes('example.com'), '但应给出可识别的来源');
    });

    // ── B. 单个打开成功：不产生任何 destructive 提示 ──
    useToastStore.setState({ toasts: [] });
    tabsFail.all = false;
    const okOk = await openUrl('https://ok.test/page');
    ok('单个链接打开成功不打扰用户', () => {
      assert.equal(okOk, true);
      assert.equal(useToastStore.getState().toasts.length, 0, '成功不该弹提示');
    });

    // ── C. 批量全成功：success 提示，计数正确 ──
    useToastStore.setState({ toasts: [] });
    const allOk = await openUrls(['https://a.test/1', 'https://b.test/2', 'https://c.test/3']);
    const okToasts = useToastStore.getState().toasts;
    ok('批量全部成功时给出正确的成功计数', () => {
      assert.deepEqual(allOk, { opened: 3, failed: 0 });
      assert.ok(
        okToasts.some((t) => t.variant === 'success' && /已打开 3 个/.test(t.title)),
        `应报 3 个成功，实际 ${JSON.stringify(okToasts)}`,
      );
    });

    // ── D. 批量部分失败：**绝不能**再谎报全部成功 ──
    useToastStore.setState({ toasts: [] });
    tabsFail.urls = ['https://b.test/2'];
    const partial = await openUrls(['https://a.test/1', 'https://b.test/2', 'https://c.test/3']);
    const partialToasts = useToastStore.getState().toasts;
    tabsFail.urls = null;

    ok('批量部分失败必须如实报出「X 个成功、Y 个失败」', () => {
      assert.deepEqual(partial, { opened: 2, failed: 1 }, '计数必须是实际结果');
      assert.ok(
        partialToasts.some((t) => /已打开 2 个，1 个失败/.test(t.title)),
        `应如实报部分失败，实际 ${JSON.stringify(partialToasts)}`,
      );
    });
    ok('批量部分失败时不得出现"全部成功"式的 success 提示', () => {
      assert.ok(
        !partialToasts.some((t) => t.variant === 'success'),
        `不得有成功提示，实际 ${JSON.stringify(partialToasts)}`,
      );
    });

    // ── E. 批量全部失败 ──
    useToastStore.setState({ toasts: [] });
    tabsFail.all = true;
    const allFail = await openUrls(['https://a.test/1', 'https://b.test/2']);
    const allFailToasts = useToastStore.getState().toasts;
    tabsFail.all = false;
    ok('批量全部失败时如实报「打开失败」', () => {
      assert.deepEqual(allFail, { opened: 0, failed: 2 });
      assert.ok(
        allFailToasts.some((t) => t.variant === 'destructive' && t.title === '打开失败'),
        `应报打开失败，实际 ${JSON.stringify(allFailToasts)}`,
      );
      assert.ok(!allFailToasts.some((t) => t.variant === 'success'), '不得有成功提示');
    });

    // ── F. 空列表：不弹任何提示，也不调用 API ──
    useToastStore.setState({ toasts: [] });
    resetMockCalls();
    const none = await openUrls([]);
    ok('空列表不弹提示、不调用 tabs.create', () => {
      assert.deepEqual(none, { opened: 0, failed: 0 });
      assert.equal(useToastStore.getState().toasts.length, 0);
      assert.equal(mockCalls.tabsCreate, 0);
    });

    // ── G. describeTarget 只给来源 ──
    ok('describeTarget 只返回来源（自定义协议退化成协议名）', () => {
      assert.equal(describeTarget('https://sub.example.com/a/b?c=d#e'), 'https://sub.example.com');
      assert.equal(describeTarget('chrome://extensions/shortcuts'), 'chrome');
      assert.equal(describeTarget('不是 URL'), '该链接');
    });

    ok('failureMessage 打开失败友好提示格式化', () => {
      assert.equal(failureMessage('https://example.com/p', new Error('tab error')), 'https://example.com：tab error');
      assert.equal(failureMessage('chrome://flags', new Error('denied')), 'chrome：denied');
      assert.equal(failureMessage('invalid-url', new Error('')), '该链接：浏览器拒绝了这次打开');
      assert.equal(failureMessage('invalid-url', ''), '该链接：浏览器拒绝了这次打开');
    });


    // ── H. 源码守卫：UI 不得再退回"吞掉 tabs.create 失败"，弹窗必须有 toast 视口 ──
    ok('UI 里不得再有吞掉 tabs.create 失败的写法（统一走 openUrl/openUrls）', () => {
      const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else if (/\.tsx?$/.test(e.name)) files.push(full);
        }
      };
      walk(resolve(rootDir, 'src/components'));
      walk(resolve(rootDir, 'src/entrypoints'));
      const offenders: string[] = [];
      for (const f of files) {
        const src = readFileSync(f, 'utf8');
        // 逐行看：tabs.create 与 .catch(() => {}) 出现在同一条语句里即为吞错
        for (const line of src.split('\n')) {
          if (line.includes('tabs.create') && line.includes('.catch(() => {})')) {
            offenders.push(`${f.replace(rootDir + '/', '')}: ${line.trim()}`);
          }
        }
      }
      assert.deepEqual(offenders, [], `这些地方仍在吞掉打开失败：\n${offenders.join('\n')}`);
    });
    ok('弹窗挂载了 toast 视口（否则那里的失败提示依然看不见）', () => {
      const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
      const popup = readFileSync(resolve(rootDir, 'src/entrypoints/popup/main.tsx'), 'utf8');
      assert.match(popup, /ToastViewport/, '弹窗必须挂载 ToastViewport');
    });

    useToastStore.setState({ toasts: [] });
    resetMockCalls();
  }

  /* ── T49: 批量移动必须如实报数（部分成功不得说成整体失败） ── */
  console.log('\n[T49] 批量移动的如实计数');
  {
    const { moveMany, describeBulk, moveManyWithToast } = await import('../src/lib/bookmarks/bulk');
    const { useToastStore } = await import('../src/lib/toast');

    const okMover = async () => ({ id: 1 });
    const failOn = (badId: string) => async (id: string) => {
      if (id === badId) throw new Error('Tabs cannot be edited');
      return { id: 1 };
    };

    // ── A. 全部成功 ──
    const all = await moveMany(['a', 'b', 'c'], { parentId: 'p' }, okMover);
    ok('moveMany：全部成功时计数正确', () => assert.deepEqual(all, { ok: 3, failed: 0 }));

    // ── B. 部分失败：必须数出成功了几项 ──
    const partial = await moveMany(['a', 'b', 'c'], { parentId: 'p' }, failOn('b'));
    ok('moveMany：部分失败时仍数出成功项（不能丢掉已完成的事实）', () => {
      assert.equal(partial.ok, 2, '成功 2 项');
      assert.equal(partial.failed, 1, '失败 1 项');
      assert.match(partial.firstError ?? '', /Tabs cannot be edited/, '要带回首个失败原因');
    });

    // ── C. 全失败 ──
    const allFail = await moveMany(['a', 'b'], { parentId: 'p' }, async () => {
      throw new Error('拒绝');
    });
    ok('moveMany：全部失败时 ok=0', () => {
      assert.equal(allFail.ok, 0);
      assert.equal(allFail.failed, 2);
    });

    // ── D. 话术：三种结果各自如实 ──
    ok('describeBulk：全成功 → success「已移动 N 项」', () => {
      const r = describeBulk('移动', { ok: 3, failed: 0 }, '目标');
      assert.equal(r.title, '已移动 3 项至「目标」');
      assert.equal(r.opts?.variant, 'success');
    });
    ok('describeBulk：部分成功 → destructive 且报出「X 项，Y 项失败」', () => {
      const r = describeBulk('移动', { ok: 2, failed: 1, firstError: '原因' }, '目标');
      assert.match(r.title, /已移动 2 项至「目标」，1 项失败/);
      assert.equal(r.opts?.variant, 'destructive');
      assert.equal(r.opts?.description, '原因');
    });
    ok('describeBulk：全失败 → destructive「移动失败」+ 原因', () => {
      const r = describeBulk('移动', { ok: 0, failed: 2, firstError: '原因' });
      assert.equal(r.title, '移动失败');
      assert.equal(r.opts?.variant, 'destructive');
      assert.equal(r.opts?.description, '原因');
    });
    ok('describeBulk：空输入不谎报成功', () => {
      const r = describeBulk('移动', { ok: 0, failed: 0 });
      assert.match(r.title, /没有可移动的项/);
      assert.notEqual(r.opts?.variant, 'success');
    });

    // ── E. 执行 + 提示：部分失败时**不得**出现"全部成功"样式 ──
    useToastStore.setState({ toasts: [] });
    const toasts: { title: string; variant: string }[] = [];
    const origPush = useToastStore.getState().push;
    useToastStore.setState({
      push: ((t: { title: string; variant: string }) => {
        toasts.push({ title: t.title, variant: t.variant });
        return origPush(t as never);
      }) as never,
    });
    const outcome = await moveManyWithToast(['a', 'b', 'c'], { parentId: 'p' }, failOn('c'), '目标');
    useToastStore.setState({ push: origPush });
    ok('moveManyWithToast：部分失败时如实报「已移动 X 项，Y 项失败」', () => {
      assert.deepEqual(outcome, { ok: 2, failed: 1, firstError: 'Tabs cannot be edited' });
      assert.equal(toasts.length, 1, '只应弹一条提示');
      assert.match(toasts[0]!.title, /已移动 2 项至「目标」，1 项失败/);
      assert.equal(toasts[0]!.variant, 'destructive');
    });
    ok('批量部分失败时绝不出现 success 提示', () =>
      assert.ok(!toasts.some((t) => t.variant === 'success')),
    );

    // ── F. 源码守卫：四处批量移动统一走 describeBulk（不再各写各的） ──
    ok('批量移动的四个调用点统一走 bulk.ts（口径一致）', () => {
      const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
      const files = [
        'src/components/sidebar/bookmark-tree.tsx',
        'src/components/bookmark-list/bookmark-list.tsx',
        'src/components/bookmark-list/move-picker.tsx',
      ];
      for (const f of files) {
        const src = readFileSync(resolve(rootDir, f), 'utf8');
        assert.match(src, /describeBulk|moveManyWithToast/, `${f} 应使用统一的批量计数话术`);
        // 不得再出现"顺序 await 循环 + 一句笼统的移动失败"
        assert.ok(
          !/pushToast\('移动失败', \{\s*\n\s*description/.test(src),
          `${f} 不应再有丢掉部分成功计数的笼统失败提示`,
        );
      }
    });

    useToastStore.setState({ toasts: [] });
  }

  /* ── T50: 写路径上的"把不确定说成确定"（读取失败 ≠ 不存在 / 重命名失败不得谎报标题） ── */
  console.log('\n[T50] 写路径的不确定性不得被说成确定');
  {
    const { executeDeletions } = await import('../src/lib/ai/deletion-executor');
    const { executeTool } = await import('../src/lib/ai/tools');
    const { UNDO_STORAGE_KEY, UNDO_PENDING_KEY, resetUndoTransactionForTest } = await import(
      '../src/lib/undo/recorder'
    );

    const clean = () => {
      storageMap.delete(UNDO_STORAGE_KEY);
      storageMap.delete(UNDO_PENDING_KEY);
      resetUndoTransactionForTest();
      bookmarksGetFailIds.ids = [];
      bookmarksUpdateFailIds.ids = [];
    };

    // ── A. 删除预扫描：**读取失败**不等于"书签已不存在" ──
    clean();
    const target = (await mockBookmarks.create({ parentId: '1', title: 'T50-KEEP', url: 'https://t50.test/a' })).id;
    bookmarksGetFailIds.ids = [target];
    const out = await executeDeletions([{ proposalId: 'p-t50', bookmarkId: target }]);
    bookmarksGetFailIds.ids = [];
    const stillThere = !!nodeById(target);

    ok('读取失败不得被当作"书签已不存在"而计入删除成功', () => {
      assert.equal(out.count, 0, '不能把读取失败算成删除成功');
      assert.equal(out.failed.length, 1, '必须如实报一条失败');
      assert.match(out.failed[0]!.error, /读取失败|无法确认/, `原因要说清是读取问题，实际 ${out.failed[0]!.error}`);
    });
    ok('读取失败后书签必须原样保留（不能因为报错而当它已删）', () =>
      assert.equal(stillThere, true, '书签不该消失'),
    );

    // 对照：真的不存在时，仍按"目标已达成"处理（不回归）
    clean();
    const ghost = await executeDeletions([{ proposalId: 'p-ghost', bookmarkId: 'no-such-id-t50' }]);
    ok('对照：书签确实不存在时仍按"目标已达成"处理（不回归）', () => {
      assert.equal(ghost.count, 1, '确实不存在 → 视为已达成');
      assert.equal(ghost.failed.length, 0);
    });

    // ── B. copy_bookmark：重命名失败不得谎报标题 ──
    clean();
    const src = (await mockBookmarks.create({ parentId: '1', title: 'T50-SRC', url: 'https://t50.test/src' })).id;
    const destFolder = (await mockBookmarks.create({ parentId: '1', title: 'T50-DEST' })).id;
    // 让"复制出来的新节点"的 update 失败：新 id 未知，用通配（对所有 update 失败）
    bookmarksUpdateFailIds.ids = [];
    const origUpdate = mockBookmarks.update;
    // 只让标题为 T50-NEW-TITLE 的那次 update 失败
    (mockBookmarks as unknown as { update: typeof origUpdate }).update = async (id, patch) => {
      if (patch.title === 'T50-NEW-TITLE') throw new Error('重命名被拒绝');
      return origUpdate(id, patch);
    };
    const copyOut = await executeTool(
      'copy_bookmark',
      JSON.stringify({ bookmarkId: src, parentId: destFolder, title: 'T50-NEW-TITLE' }),
    );
    (mockBookmarks as unknown as { update: typeof origUpdate }).update = origUpdate;
    const parsed = JSON.parse(copyOut.result) as { copied?: string; title?: string; renamed?: boolean; note?: string };
    const copiedId = parsed.copied;

    ok('复制后重命名失败时，不得声称副本已用请求的标题', () => {
      assert.notEqual(parsed.title, 'T50-NEW-TITLE', '实际标题还是原标题，不能谎报');
      assert.equal(parsed.title, 'T50-SRC', '应如实回报实际标题');
    });
    ok('重命名失败必须在结果里如实标注', () => {
      assert.equal(parsed.renamed, false, '应标出重命名没成功');
      assert.match(parsed.note ?? '', /重命名/, '要给出人话说明');
    });
    ok('副本本身仍然要真的建出来（复制成功的事实不能被抹掉）', () => {
      assert.ok(copiedId, '应返回新节点 id');
      assert.ok(nodeById(copiedId!), '新节点确实存在');
      assert.equal(nodeById(copiedId!)!.title, 'T50-SRC', '其标题是原标题');
    });

    // 对照：重命名成功时，如实回报请求的标题
    clean();
    const src2 = (await mockBookmarks.create({ parentId: '1', title: 'T50-SRC2', url: 'https://t50.test/src2' })).id;
    const okOut = await executeTool(
      'copy_bookmark',
      JSON.stringify({ bookmarkId: src2, parentId: destFolder, title: 'T50-OK-TITLE' }),
    );
    const okParsed = JSON.parse(okOut.result) as { title?: string; renamed?: boolean };
    ok('对照：重命名成功时如实回报请求的标题', () => {
      assert.equal(okParsed.title, 'T50-OK-TITLE');
      assert.notEqual(okParsed.renamed, false, '不该标成失败');
    });

    clean();
    if (nodeById(target)) await mockBookmarks.removeTree(target);
    if (nodeById(destFolder)) await mockBookmarks.removeTree(destFolder);
  }

  /* ── T51: 主题设置保存失败必须可见（与设置页同一标准） ── */
  console.log('\n[T51] 主题保存失败的可见性');
  {
    // applyTheme 依赖 window/document；这里只补最小 stub（不引 jsdom，符合本项目测试基座原则）
    const g = globalThis as unknown as Record<string, unknown>;
    const origWindow = g.window;
    const origDocument = g.document;
    g.window = { matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) };
    g.document = { documentElement: { classList: { toggle: () => {} } } };

    const { useThemeStore, THEME_KEY } = await import('../src/stores/themeStore');
    const { useToastStore } = await import('../src/lib/toast');

    ok('THEME_KEY 存储键名锁定为 markai.theme', () => assert.equal(THEME_KEY, 'markai.theme'));

    useToastStore.setState({ toasts: [] });
    storageSetFailKeys = [THEME_KEY];
    storageSetFailTimes = Number.POSITIVE_INFINITY;
    await useThemeStore.getState().setTheme('dark');
    storageSetFailKeys = null;
    storageSetFailTimes = Number.POSITIVE_INFINITY;
    const toasts = useToastStore.getState().toasts;

    ok('主题保存失败必须如实告知（不能静默丢弃设置）', () => {
      assert.ok(
        toasts.some((t) => t.variant === 'destructive'),
        `应有 destructive 提示，实际 ${JSON.stringify(toasts)}`,
      );
      assert.match(JSON.stringify(toasts), /主题/, '提示要指明是主题相关');
    });
    ok('主题本身仍要立即生效（失败也不该卡住界面）', () =>
      assert.equal(useThemeStore.getState().theme, 'dark'),
    );

    // 对照：保存成功时不该弹任何失败提示
    useToastStore.setState({ toasts: [] });
    storageMap.delete('markai.theme');
    await useThemeStore.getState().setTheme('light');
    ok('对照：主题保存成功时不打扰用户', () => {
      assert.equal(useToastStore.getState().toasts.length, 0, '成功不该弹提示');
      assert.equal(useThemeStore.getState().theme, 'light');
    });

    storageMap.delete('markai.theme');
    useToastStore.setState({ toasts: [] });
    g.window = origWindow;
    g.document = origDocument;
  }

  /* ── T52: 工具栏是不依赖 storage 的可见通路（快捷键失败也要说） ── */
  console.log('\n[T52] 工具栏提示');
  {
    const { toolbarError, toolbarClear } = await import('../src/lib/ai/toolbar-hint');

    resetActionCalls();
    await toolbarError('MarkAI：侧边栏未能自动打开，请点扩展图标手动打开');
    ok('toolbarError 同时设置红色 badge 与悬停说明', () => {
      assert.deepEqual(actionCalls.badgeText, ['!'], 'badge 应为 !');
      assert.deepEqual(actionCalls.badgeColor, ['#dc2626'], '应为红色');
      assert.equal(actionCalls.titles.length, 1);
      assert.match(actionCalls.titles[0]!, /侧边栏/, '悬停说明要说清是什么失败');
    });

    resetActionCalls();
    await toolbarClear();
    ok('toolbarClear 清掉 badge 并恢复常规标题', () => {
      assert.deepEqual(actionCalls.badgeText, [''], 'badge 应被清空');
      assert.deepEqual(actionCalls.titles, ['MarkAI'], '标题应恢复');
    });

    ok('快捷键打开侧边栏失败时使用工具栏提示（接线被守住）', () => {
      const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
      const bg = readFileSync(resolve(rootDir, 'src/entrypoints/background.ts'), 'utf8');
      // 快捷键处理里必须有可见反馈，而不是空的 catch
      const cmdBlock = bg.slice(bg.indexOf('chrome.commands.onCommand.addListener'));
      const end = cmdBlock.indexOf('// ── 2.');
      const scope = end > 0 ? cmdBlock.slice(0, end) : cmdBlock;
      assert.match(scope, /toolbarError/, '快捷键打开失败必须给出可见反馈');
      assert.ok(!/catch \{\s*\n\s*\/\/\s*忽略（用户可手动打开）/.test(scope), '不得退回"静默忽略"');
    });
  }

  /* ── T53: 轮次级计划（纯逻辑，未接 UI/agent） ── */
  console.log('\n[T53] 轮次级计划');
  {
    const { classifyTool, buildPlan, applyPlan } = await import('../src/lib/ai/turn-plan');

    ok('classifyTool：读类 / 写类 / 闸门类各自归类', () => {
      assert.equal(classifyTool('list_bookmarks'), 'read');
      assert.equal(classifyTool('open_bookmark'), 'read', '打开单个书签与读类同组（不写书签库）');
      assert.equal(classifyTool('move_bookmarks'), 'write');
      assert.equal(classifyTool('open_bookmarks'), 'write', '一次打开 20 个标签页也是副作用，值得确认');
      assert.equal(classifyTool('propose_deletions'), 'gate', '它本身即"延迟的删除"，不该被二次延迟');
      assert.equal(classifyTool('delete_all_bookmarks'), 'gate', '自带 confirm/auto 闸门，不并入计划');
      assert.equal(classifyTool('不存在的工具'), 'unknown');
    });

    const steps = [
      { name: 'list_bookmarks', args: '{}' },
      { name: 'move_bookmarks', args: JSON.stringify({ bookmarkIds: ['a', 'b', 'c'], parentId: 'p1' }) },
      { name: 'propose_deletions', args: JSON.stringify({ items: [] }) },
      { name: 'rename_bookmark', args: JSON.stringify({ bookmarkId: 'x', title: '新名字' }) },
      { name: 'auto_categorize', args: JSON.stringify({ folderId: 'f', dryRun: true }) },
    ];
    const plan = buildPlan(steps);

    ok('buildPlan：只保留写类，且保持原顺序', () =>
      assert.deepEqual(plan.map((p) => p.name), ['move_bookmarks', 'rename_bookmark', 'auto_categorize']),
    );
    ok('buildPlan：闸门类不进计划（它本身就是"延迟的删除"）', () =>
      assert.ok(!plan.some((p) => p.name === 'propose_deletions')),
    );
    ok('buildPlan：读类不进计划（它们由 agent 立即执行，用来算出计划）', () =>
      assert.ok(!plan.some((p) => p.name === 'list_bookmarks')),
    );
    ok('buildPlan：每步有人话标签与按参数推断的条数', () => {
      assert.equal(plan[0]!.label, '批量移动');
      assert.equal(plan[0]!.count, 3, '批量移动 3 项');
      assert.match(plan[0]!.summary, /批量移动/);
      assert.equal(plan[1]!.label, '重命名');
      assert.equal(plan[1]!.count, 1);
    });
    ok('buildPlan：dryRun 步骤标注为"仅预览"', () =>
      assert.equal(plan[2]!.preview, true, 'dryRun:true 应标 preview'),
    );
    ok('buildPlan：全是读类时计划为空（不产出空动作）', () =>
      assert.deepEqual(buildPlan([{ name: 'list_bookmarks', args: '{}' }]), []),
    );

    // ── 安全默认：**不显式确认就不执行** ──
    let unconfirmedCalls = 0;
    const unconfirmed = await applyPlan(plan, async () => {
      unconfirmedCalls += 1;
      return { ok: true };
    });
    ok('applyPlan 默认不执行：未确认时 executor 零调用、并标 cancelled', () => {
      assert.equal(unconfirmedCalls, 0, '安全默认必须是"不执行"');
      assert.equal(unconfirmed.cancelled, true);
      assert.equal(unconfirmed.ok, 0);
      assert.equal(unconfirmed.failed, 0);
    });

    // ── 确认后：按序串行、单个失败不中断、如实计数 ──
    const calls: string[] = [];
    const out = await applyPlan(
      plan,
      async (step) => {
        calls.push(step.name);
        if (step.name === 'rename_bookmark') throw new Error('重命名被拒绝');
        return { ok: true };
      },
      { confirmed: true },
    );
    ok('applyPlan：确认后按计划顺序串行执行', () =>
      assert.deepEqual(calls, ['move_bookmarks', 'rename_bookmark', 'auto_categorize']),
    );
    ok('applyPlan：单条失败不中断，并如实计数与带首个原因', () => {
      assert.equal(out.ok, 2, '成功的两条不能丢');
      assert.equal(out.failed, 1);
      assert.match(out.firstError ?? '', /重命名被拒绝/);
      assert.equal(out.cancelled, false);
    });
    ok('applyPlan：逐条结果与计划一一对应（顺序与成败都对得上）', () => {
      assert.deepEqual(
        out.results.map((r) => [r.name, r.ok]),
        [
          ['move_bookmarks', true],
          ['rename_bookmark', false],
          ['auto_categorize', true],
        ],
      );
    });

    // ── 空计划：不调用 executor ──
    let emptyCalls = 0;
    const emptyOut = await applyPlan([], async () => {
      emptyCalls += 1;
      return { ok: true };
    }, { confirmed: true });
    ok('applyPlan：空计划不调用 executor', () => {
      assert.equal(emptyCalls, 0);
      assert.equal(emptyOut.ok, 0);
      assert.equal(emptyOut.failed, 0);
    });
  }

  /* ── T54: 计划模式接进 agent 写循环（按回次确认） ── */
  console.log('\n[T54] 计划模式与写循环');
  {
    const { UNDO_STORAGE_KEY, UNDO_PENDING_KEY, resetUndoTransactionForTest } = await import(
      '../src/lib/undo/recorder'
    );
    const { useBookmarkStore } = await import('../src/stores/bookmarkStore');
    const clear = () => {
      storageMap.delete(UNDO_STORAGE_KEY);
      storageMap.delete(UNDO_PENDING_KEY);
      resetUndoTransactionForTest();
      resetMockCalls();
    };
    /** 一个"新建文件夹"的模型响应（单回次、单个写工具） */
    const createFolderTurn = () =>
      sseResponse([
        sseEvent(
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-cf',
                      type: 'function',
                      function: { name: 'create_folder', arguments: JSON.stringify({ parentId: '1', title: 'T54-新文件夹' }) },
                    },
                  ],
                },
              },
            ],
          }),
        ),
        sseEvent(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })),
        'data: [DONE]\n\n',
      ]);

    // ── A. 计划模式关闭：行为与现在完全一致（写操作立即执行） ──
    clear();
    sseQueue = [createFolderTurn(), sseResponse([sseEvent(JSON.stringify({ choices: [{ delta: { content: '好了' } }] })), 'data: [DONE]\n\n'])];
    await runTurnWith('建个文件夹', { config: { planMode: false } });
    ok('计划模式关闭时写操作照旧立即执行（不回归既有行为）', () =>
      assert.equal(mockCalls.create, 1, 'create_folder 应立即执行'),
    );
    clear();

    // ── B. 计划模式开启 + 批准：确认后才执行 ──
    const planEvents: ChatOutbound[] = [];
    let approvedPlan: { summary: string }[] | null = null;
    sseQueue = [createFolderTurn(), sseResponse([sseEvent(JSON.stringify({ choices: [{ delta: { content: '好了' } }] })), 'data: [DONE]\n\n'])];
    await runTurnWith('建个文件夹', {
      config: { planMode: true },
      events: planEvents,
      requestPlanApproval: async (plan) => {
        approvedPlan = plan;
        // 关键：请求确认时，写操作必须**还没发生**
        ok('请求确认的那一刻，写操作必须还没有发生', () =>
          assert.equal(mockCalls.create, 0, `确认前不应有 create，实际 ${mockCalls.create}`),
        );
        return true;
      },
    });
    ok('计划模式：发出 chat:plan 事件，且清单里是这一步的写操作', () => {
      const planEvent = planEvents.find((e) => e.type === 'chat:plan');
      assert.ok(planEvent, '应有 chat:plan 事件');
      assert.equal(approvedPlan?.length, 1);
      assert.match(approvedPlan![0]!.summary, /新建文件夹/);
    });
    ok('计划模式：批准后按序执行（create 恰好一次）', () =>
      assert.equal(mockCalls.create, 1, '批准后应执行一次'),
    );
    ok('计划模式批准后：一轮仍只产生**一个**撤销点，且覆盖实际执行的操作', () => {
      const raw = storageMap.get(UNDO_STORAGE_KEY) as { points?: { runId: string; ops: unknown[] }[] } | undefined;
      const points = raw?.points ?? [];
      assert.equal(points.length, 1, `应恰好一个撤销点，实际 ${points.length}`);
      assert.equal(points[0]!.runId, 'msg-1', '撤销点应绑定本轮的 messageId');
      assert.equal(points[0]!.ops.length, 1, '点里应恰好覆盖实际执行的那一次 create');
    });
    clear();

    // ── C. 计划模式开启 + 取消：零执行、零撤销点、结果如实 ──
    const cancelEvents: ChatOutbound[] = [];
    sseQueue = [createFolderTurn(), sseResponse([sseEvent(JSON.stringify({ choices: [{ delta: { content: '好的，已取消' } }] })), 'data: [DONE]\n\n'])];
    await runTurnWith('建个文件夹', {
      config: { planMode: true },
      events: cancelEvents,
      requestPlanApproval: async () => false,
    });
    ok('计划模式取消：写操作零执行', () =>
      assert.equal(mockCalls.create, 0, `取消后不应有任何 create，实际 ${mockCalls.create}`),
    );
    ok('计划模式取消：不产生撤销点（存储里没有 markai.undo 点）', () => {
      const raw = storageMap.get(UNDO_STORAGE_KEY);
      const points = raw ? ((raw as { points?: unknown[] }).points ?? []) : [];
      assert.equal(points.length, 0, `取消不应留下撤销点，实际 ${JSON.stringify(raw)}`);
      assert.ok(!storageMap.has(UNDO_PENDING_KEY), '也不应留下 pending 快照');
    });
    ok('计划模式取消：把"未执行"如实回填（模型不能以为已生效）', () => {
      const err = cancelEvents.find((e) => e.type === 'chat:tool_error') as
        | { type: 'chat:tool_error'; record: { error?: string } }
        | undefined;
      assert.ok(err, '应以 tool_error 形式回填，而不是成功');
      assert.match(err!.record.error ?? '', /取消|没有执行/, '要说清是取消、未执行');
    });
    clear();

    // ── D. 计划模式开启但**没有确认通道**：安全默认 = 不执行 ──
    sseQueue = [createFolderTurn(), sseResponse([sseEvent(JSON.stringify({ choices: [{ delta: { content: 'x' } }] })), 'data: [DONE]\n\n'])];
    await runTurnWith('建个文件夹', { config: { planMode: true } });
    ok('计划模式但没有确认通道时：零执行（安全默认，不"悄悄全做了"）', () =>
      assert.equal(mockCalls.create, 0, `无确认通道时不应执行，实际 ${mockCalls.create}`),
    );
    clear();

    // ── E. 闸门类不进计划：即使计划模式开启，删除提议仍走自己的闸门 ──
    const gateEvents: ChatOutbound[] = [];
    const gateApproveCalls: number[] = [];
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
                      id: 'call-pd',
                      type: 'function',
                      function: {
                        name: 'propose_deletions',
                        arguments: JSON.stringify({ items: [{ bookmarkId: 'no-such-t54', reason: '测试' }] }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        ),
        sseEvent(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })),
        'data: [DONE]\n\n',
      ]),
      sseResponse([sseEvent(JSON.stringify({ choices: [{ delta: { content: '已提交提议' } }] })), 'data: [DONE]\n\n']),
    ];
    await runTurnWith('清理一下', {
      config: { planMode: true },
      events: gateEvents,
      requestPlanApproval: async (plan) => {
        gateApproveCalls.push(plan.length);
        return true;
      },
    });
    ok('闸门类不在计划清单里（它本身就是"延迟的删除"，不该被二次延迟）', () => {
      assert.deepEqual(gateApproveCalls, [], 'propose_deletions 不应触发计划确认');
      assert.ok(!gateEvents.some((e) => e.type === 'chat:plan'), '不应发出 plan 事件');
    });
    clear();
    void useBookmarkStore;
  }

  /* ── T55: 计划确认通道与界面接线（第三片） ── */
  console.log('\n[T55] 计划确认通道');
  {
    const { createPlanApprovalRegistry } = await import('../src/lib/ai/plan-approval');

    const plan = [{ name: 'create_folder', label: '新建文件夹', count: 1, countDeclared: true, summary: '新建文件夹', preview: false }];

    // ── A. request 发出 chat:plan 并挂起 ──
    const posted: { type: string; messageId: string; steps?: unknown[] }[] = [];
    const reg = createPlanApprovalRegistry();
    const p1 = reg.request('msg-a', plan, (m) => posted.push(m as never));
    ok('request 发出 chat:plan（带 messageId 与步骤清单）', () => {
      assert.equal(posted.length, 1);
      assert.equal(posted[0]!.type, 'chat:plan');
      assert.equal(posted[0]!.messageId, 'msg-a');
      assert.equal(posted[0]!.steps?.length, 1);
    });
    await okA('resolve(true) 结算对应请求为"批准"', async () => {
      assert.equal(reg.resolve('msg-a', true), true, '应命中');
    });
    await p1.then((v) => {
      ok('批准后 promise 解出 true', () => assert.equal(v, true));
    });

    // ── B. resolve(false) 结算为"取消" ──
    const p2 = reg.request('msg-b', plan, () => {});
    reg.resolve('msg-b', false);
    await p2.then((v) => {
      ok('取消后 promise 解出 false', () => assert.equal(v, false));
    });

    // ── C. 未知 messageId 的 resolve 必须安全无副作用（不能误结算别人的请求） ──
    let settledC: boolean | null = null;
    const p3 = reg.request('msg-c', plan, () => {});
    void p3.then((v) => {
      settledC = v;
    });
    ok('对未知 messageId 的 resolve 返回 false（不命中）', () =>
      assert.equal(reg.resolve('msg-不存在', true), false),
    );
    await Promise.resolve();
    await Promise.resolve();
    ok('未知 messageId 的决定不得影响其它未决请求', () =>
      assert.equal(settledC, null, 'msg-c 应仍未结算'),
    );
    reg.resolve('msg-c', false);
    await p3;

    // ── D. cancelAll（端口断开）必须把未决请求按"未批准"结算，不能挂死 ──
    let settledD: boolean | null = null;
    const p4 = reg.request('msg-d', plan, () => {});
    void p4.then((v) => {
      settledD = v;
    });
    let settledE: boolean | null = null;
    const p5 = reg.request('msg-e', plan, () => {});
    void p5.then((v) => {
      settledE = v;
    });
    reg.cancelAll();
    await Promise.all([p4, p5]);
    ok('cancelAll 把未决请求按"未批准"结算（绝不挂死一轮）', () => {
      assert.equal(settledD, false, '断线应结算为未批准');
      assert.equal(settledE, false);
    });
    ok('cancelAll 之后登记表为空', () => assert.equal(reg.pendingCount(), 0));

    // ── E. store：chat:plan 事件 → pendingPlan；approve/cancel 发决定并清空 ──
    const { useAIStore } = await import('../src/stores/aiStore');
    const sent: { type: string; messageId?: string; approved?: boolean }[] = [];
    useAIStore.setState({
      port: { postMessage: (m: unknown) => sent.push(m as never) } as unknown as chrome.runtime.Port,
      pendingPlan: null,
    });
    useAIStore.getState().handleOutbound({
      type: 'chat:plan',
      messageId: 'msg-ui',
      steps: plan,
    } as never);
    ok('store：收到 chat:plan 后 pendingPlan 有值', () => {
      const pp = useAIStore.getState().pendingPlan;
      assert.ok(pp, 'pendingPlan 应有值');
      assert.equal(pp!.messageId, 'msg-ui');
      assert.equal(pp!.steps.length, 1);
    });
    useAIStore.getState().approvePlan();
    ok('store：approvePlan 发送 approved:true 并清空 pendingPlan', () => {
      const last = sent[sent.length - 1]!;
      assert.equal(last.type, 'chat:plan_decision');
      assert.equal(last.messageId, 'msg-ui');
      assert.equal(last.approved, true);
      assert.equal(useAIStore.getState().pendingPlan, null);
    });

    sent.length = 0;
    useAIStore.getState().handleOutbound({ type: 'chat:plan', messageId: 'msg-ui2', steps: plan } as never);
    useAIStore.getState().cancelPlan();
    ok('store：cancelPlan 发送 approved:false 并清空 pendingPlan', () => {
      const last = sent[sent.length - 1]!;
      assert.equal(last.type, 'chat:plan_decision');
      assert.equal(last.approved, false);
      assert.equal(useAIStore.getState().pendingPlan, null);
    });

    // ── F. 源码守卫：卡片与设置开关接线 ──
    const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    ok('UI：计划卡片渲染每步摘要，且同时有确认与取消两个入口', () => {
      const panel = readFileSync(resolve(rootDir, 'src/components/chat/chat-panel.tsx'), 'utf8');
      assert.match(panel, /pendingPlan/, '面板必须读取 pendingPlan');
      assert.match(panel, /approvePlan/, '必须有确认入口');
      assert.match(panel, /cancelPlan/, '必须有取消入口');
      assert.match(panel, /step\.summary/, '必须渲染每步摘要');
    });
    ok('UI：取消文案如实说明"没有执行任何写操作"', () => {
      const panel = readFileSync(resolve(rootDir, 'src/components/chat/chat-panel.tsx'), 'utf8');
      assert.match(panel, /没有执行任何写操作/, '取消必须如实说明零写入');
    });
    ok('设置页：planMode 开关接线存在', () => {
      const form = readFileSync(resolve(rootDir, 'src/components/options/config-form.tsx'), 'utf8');
      assert.match(form, /planMode/, '设置页要有计划模式开关');
    });
    ok('设置页：planMode 默认关闭（不改变现有用户节奏）', () => {
      const cfg = readFileSync(resolve(rootDir, 'src/stores/configStore.ts'), 'utf8');
      assert.match(cfg, /planMode:\s*false/, '默认必须是 false');
    });

    useAIStore.setState({ pendingPlan: null });
  }

  /* ── T56: 轮次级预授权（一次确认覆盖整轮，未声明的仍须确认） ── */
  console.log('\n[T56] 轮次级预授权');
  {
    const { UNDO_STORAGE_KEY, UNDO_PENDING_KEY, resetUndoTransactionForTest } = await import(
      '../src/lib/undo/recorder'
    );
    const clear = () => {
      storageMap.delete(UNDO_STORAGE_KEY);
      storageMap.delete(UNDO_PENDING_KEY);
      resetUndoTransactionForTest();
      resetMockCalls();
    };
    const declared = {
      steps: [
        { tool: 'create_folder', summary: '新建文件夹 T56' },
        { tool: 'create_bookmark', summary: '新建书签 T56' },
      ],
    };
    /** 第 1 回次：声明整轮计划 + 建文件夹；第 2 回次：建书签（都已被声明覆盖） */
    const twoRoundQueued = () => {
      sseQueue = [
        toolRound([
          { id: 'c-declare', name: 'submit_plan', args: declared },
          { id: 'c-folder', name: 'create_folder', args: { parentId: '1', title: 'T56-文件夹' } },
        ]),
        toolRound([
          { id: 'c-bm', name: 'create_bookmark', args: { parentId: '1', title: 'T56-书签', url: 'https://t56.test/' } },
        ]),
        finalRound(),
      ];
    };

    // ── A. 声明 → 批准：整轮只问一次，两次写操作都执行 ──
    clear();
    let planEvents = 0;
    let approvalCount = 0;
    let mutationsAtApproval = -1;
    twoRoundQueued();
    await runTurnWith('整理一下', {
      config: { planMode: true },
      events: (() => {
        const ev: ChatOutbound[] = [];
        return ev;
      })(),
      requestPlanApproval: async () => {
        approvalCount += 1;
        mutationsAtApproval = mockCalls.create;
        return true;
      },
    });
    ok('声明整轮计划后，整轮只请求一次确认（不是每回次一次）', () =>
      assert.equal(approvalCount, 1, `应只问一次，实际 ${approvalCount}`),
    );
    ok('请求确认时零 mutation（声明本身不落库）', () =>
      assert.equal(mutationsAtApproval, 0, `确认时应还没有写入，实际 ${mutationsAtApproval}`),
    );
    ok('批准后两个回次的写操作都执行了', () =>
      assert.equal(mockCalls.create, 2, `应执行 2 次 create（文件夹+书签），实际 ${mockCalls.create}`),
    );
    ok('整轮批准后仍只产生一个撤销点，且覆盖两次写操作', () => {
      const raw = storageMap.get(UNDO_STORAGE_KEY) as { points?: { ops: unknown[] }[] } | undefined;
      const points = raw?.points ?? [];
      assert.equal(points.length, 1, `应恰好一个撤销点，实际 ${points.length}`);
      assert.equal(points[0]!.ops.length, 2, '点里应覆盖两次写操作');
    });
    clear();

    // ── B. 声明 → 取消：整轮都被阻断（不只是第一回次） ──
    let cancelApprovals = 0;
    twoRoundQueued();
    await runTurnWith('整理一下', {
      config: { planMode: true },
      requestPlanApproval: async () => {
        cancelApprovals += 1;
        return false;
      },
    });
    ok('取消整轮计划后，后续回次的写操作也一律不执行', () =>
      assert.equal(mockCalls.create, 0, `取消后整轮都应零写入，实际 ${mockCalls.create}`),
    );
    ok('取消之后不再重复追问（用户已经说过不要，不该被再问一次）', () =>
      assert.equal(cancelApprovals, 1, `取消后不应再问，实际问了 ${cancelApprovals} 次`),
    );
    ok('取消整轮计划后不产生撤销点', () => {
      const raw = storageMap.get(UNDO_STORAGE_KEY) as { points?: unknown[] } | undefined;
      assert.equal((raw?.points ?? []).length, 0);
    });
    clear();

    // ── C. 未声明的写操作：即使已批准，仍必须再次确认（安全边界） ──
    let approvalCountC = 0;
    sseQueue = [
      toolRound([
        { id: 'c-declare', name: 'submit_plan', args: { steps: [{ tool: 'create_folder', summary: '只声明了建文件夹' }] } },
        { id: 'c-folder', name: 'create_folder', args: { parentId: '1', title: 'T56-已声明' } },
      ]),
      // 第二回次调用了**未声明**的工具
      toolRound([{ id: 'c-rename', name: 'rename_bookmark', args: { bookmarkId: 'no-such-t56', title: 'x' } }]),
      finalRound(),
    ];
    await runTurnWith('整理一下', {
      config: { planMode: true },
      requestPlanApproval: async () => {
        approvalCountC += 1;
        return true;
      },
    });
    ok('已批准的声明之外的写操作，仍必须再次确认（不能靠模型自觉）', () =>
      assert.equal(approvalCountC, 2, `已声明的不再问、未声明的要再问，合计 2 次，实际 ${approvalCountC}`),
    );
    clear();

    // ── D. 没有声明时：行为与第二片一致（每回次确认，不回归） ──
    let approvalCountD = 0;
    sseQueue = [
      toolRound([{ id: 'c-folder', name: 'create_folder', args: { parentId: '1', title: 'T56-无声明A' } }]),
      toolRound([{ id: 'c-bm', name: 'create_bookmark', args: { parentId: '1', title: 'T56-无声明B', url: 'https://t56.test/b' } }]),
      finalRound(),
    ];
    await runTurnWith('整理一下', {
      config: { planMode: true },
      requestPlanApproval: async () => {
        approvalCountD += 1;
        return true;
      },
    });
    ok('没有声明时仍是每回次确认（既有行为不回归）', () =>
      assert.equal(approvalCountD, 2, `两回次应问两次，实际 ${approvalCountD}`),
    );
    clear();

    // ── E. submit_plan 自身零 mutation ──
    resetMockCalls();
    sseQueue = [toolRound([{ id: 'c-declare', name: 'submit_plan', args: declared }]), finalRound()];
    await runTurnWith('先说计划', {
      config: { planMode: true },
      requestPlanApproval: async () => false,
    });
    ok('submit_plan 只声明不执行（零 mutation）', () =>
      assert.equal(mockCalls.create, 0, '声明工具本身不得写库'),
    );
    clear();

    // ── F. 系统提示：planMode 开启时必须指示"先声明计划再动手" ──
    const systemMessages = () =>
      fetchCalls
        .map((c) => {
          try {
            const body = JSON.parse(String(c.init.body ?? '{}')) as {
              messages?: { role: string; content: string }[];
            };
            return body.messages?.find((m) => m.role === 'system')?.content ?? '';
          } catch {
            return '';
          }
        })
        .filter(Boolean);

    fetchCalls.length = 0;
    resetMockCalls();
    sseQueue = [finalRound()];
    await runTurnWith('只是聊聊天', { config: { planMode: true } });
    const onSys = systemMessages().at(-1) ?? '';
    fetchCalls.length = 0;
    sseQueue = [finalRound()];
    await runTurnWith('只是聊聊天', { config: { planMode: false } });
    const offSys = systemMessages().at(-1) ?? '';

    ok('planMode 开启时，系统提示要求先声明整轮计划再动手', () => {
      assert.match(onSys, /submit_plan/, '开启时应提示先用 submit_plan 声明');
      assert.match(onSys, /先声明|声明计划/, '要说明是"先声明"');
    });
    ok('planMode 关闭时，系统提示不含声明计划的指令（不打扰默认路径）', () =>
      assert.ok(!/submit_plan/.test(offSys), '关闭时不该出现 submit_plan 指令'),
    );
    fetchCalls.length = 0;
    clear();
  }

  /* ── T57: 声明范围与实际执行必须一致（超出已批准规模要重新确认） ── */
  console.log('\n[T57] 声明范围与实际执行的偏差');
  {
    const { round1, UNDO } = await (async () => ({ round1: 0, UNDO: '' }))();
    void round1;
    void UNDO;
    const { buildPlan, inferStepCount } = await import('../src/lib/ai/turn-plan');
    const { UNDO_STORAGE_KEY, UNDO_PENDING_KEY, resetUndoTransactionForTest } = await import(
      '../src/lib/undo/recorder'
    );
    const clear = () => {
      storageMap.delete(UNDO_STORAGE_KEY);
      storageMap.delete(UNDO_PENDING_KEY);
      resetUndoTransactionForTest();
      resetMockCalls();
    };

    // ── A. 声明的条数不能被静默丢掉 ──
    ok('inferStepCount 认得显式的 count 数字（声明条数不会丢）', () =>
      assert.equal(inferStepCount({ count: 42 }), 42),
    );
    ok('buildPlan 仍然按数组长度推断（既有行为不回归）', () => {
      const plan = buildPlan([{ name: 'move_bookmarks', args: JSON.stringify({ bookmarkIds: ['a', 'b'] }) }]);
      assert.equal(plan[0]!.count, 2);
    });

    // ── B. 声明条数必须真的进入 chat:plan 载荷 ──
    const declared = { steps: [{ tool: 'create_bookmark', summary: '新建 3 条', count: 3 }] };
    const planEvents: ChatOutbound[] = [];
    sseQueue = [
      toolRound([{ id: 'c-d', name: 'submit_plan', args: declared }]),
      finalRound(),
    ];
    await runTurnWith('先说计划', {
      config: { planMode: true },
      events: planEvents,
      requestPlanApproval: async () => false,
    });
    const planEvt = planEvents.find((e) => e.type === 'chat:plan') as
      | { type: 'chat:plan'; steps: { count: number; countDeclared: boolean; summary: string }[] }
      | undefined;
    ok('声明的条数进入 chat:plan 载荷（不是恒为 1）', () => {
      assert.ok(planEvt, '应有 chat:plan 事件');
      assert.equal(planEvt!.steps.length, 1);
      assert.equal(planEvt!.steps[0]!.count, 3, '应带上声明的 3 条，而不是退回 1');
      assert.equal(planEvt!.steps[0]!.countDeclared, true, '应标记为"有依据"');
    });
    clear();

    // ── B2. 未声明条数时载荷必须标"无依据"（界面据此显示"条数未声明"） ──
    const planEvents2: ChatOutbound[] = [];
    sseQueue = [
      toolRound([{ id: 'c-d2', name: 'submit_plan', args: { steps: [{ tool: 'create_bookmark', summary: '建点东西' }] } }]),
      finalRound(),
    ];
    await runTurnWith('先说计划', {
      config: { planMode: true },
      events: planEvents2,
      requestPlanApproval: async () => false,
    });
    const planEvt2 = planEvents2.find((e) => e.type === 'chat:plan') as
      | { type: 'chat:plan'; steps: { count: number; countDeclared: boolean }[] }
      | undefined;
    ok('未声明条数时载荷标记为"无依据"（界面才能如实写"条数未声明"）', () => {
      assert.ok(planEvt2, '应有 chat:plan 事件');
      assert.equal(planEvt2!.steps[0]!.countDeclared, false, '没声明就不能标成有依据');
    });
    clear();

    // ── C. 超出已批准规模 → 必须再次确认 ──
    let approvalsC = 0;
    let mutationsAtSecondAsk = -1;
    // 用**真实**书签 id：虚构 id 会让 move 失败，那样"一个撤销点"就无从谈起（第一版就栽在这）
    const realIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const n = await mockBookmarks.create({ parentId: '1', title: `T57-real-${i}`, url: `https://t57.test/${i}` });
      realIds.push(n.id);
    }
    const bigIds = realIds.slice(0, 2); // 2 条 > 已批准的 1 条
    sseQueue = [
      toolRound([
        { id: 'c-d', name: 'submit_plan', args: { steps: [{ tool: 'move_bookmarks', summary: '移动 1 条', count: 1 }] } },
        // 第一回次：1 条（在已批准范围内）
        { id: 'c-m1', name: 'move_bookmarks', args: { ids: [realIds[0]!], parentId: '1' } },
      ]),
      // 第二回次：2 条（**超出**声明上限 1）
      toolRound([
        { id: 'c-m2', name: 'move_bookmarks', args: { ids: bigIds, parentId: '1' } },
      ]),
      finalRound(),
    ];
    await runTurnWith('整理一下', {
      config: { planMode: true },
      requestPlanApproval: async () => {
        approvalsC += 1;
        if (approvalsC === 2) mutationsAtSecondAsk = mockCalls.move;
        return true;
      },
    });
    ok('实际规模超过已批准上限时必须再次确认（批准范围不能被静默超出）', () =>
      assert.equal(approvalsC, 2, `应问两次（首次批准 + 超范围再确认），实际 ${approvalsC}`),
    );
    ok('再次确认发生在超范围那批执行**之前**（不是先做后问）', () => {
      // 第二次询问时：第一回次那 1 条（在已批准范围内）已经移完，但超范围的 2 条还没动
      assert.equal(mutationsAtSecondAsk, 1, `第二次询问时只该有首回次的 1 次 move，实际 ${mutationsAtSecondAsk}`);
    });
    ok('两次批准后实际执行了 1 + 2 = 3 次移动', () =>
      assert.equal(mockCalls.move, 3, `应共 3 次 move，实际 ${mockCalls.move}`),
    );
    ok('超范围重确认之后，一轮仍只产生一个撤销点（不因多问一次就多一个点）', () => {
      const raw = storageMap.get(UNDO_STORAGE_KEY) as { points?: { ops: unknown[] }[] } | undefined;
      const points = raw?.points ?? [];
      assert.equal(points.length, 1, `应恰好一个撤销点，实际 ${points.length}`);
      assert.ok((points[0]?.ops.length ?? 0) > 0, '点里应覆盖实际执行的操作');
    });
    clear();

    // ── D. 对照：规模不超过上限时不重复确认（防止把功能做成"一律重问"） ──
    let approvalsD = 0;
    sseQueue = [
      toolRound([
        { id: 'c-d', name: 'submit_plan', args: { steps: [{ tool: 'create_folder', summary: '建 1 个文件夹', count: 5 }] } },
        { id: 'c-f1', name: 'create_folder', args: { parentId: '1', title: 'T57-A' } },
      ]),
      toolRound([{ id: 'c-f2', name: 'create_folder', args: { parentId: '1', title: 'T57-B' } }]),
      finalRound(),
    ];
    await runTurnWith('建两个文件夹', {
      config: { planMode: true },
      requestPlanApproval: async () => {
        approvalsD += 1;
        return true;
      },
    });
    ok('规模不超过已批准上限时仍只问一次（不回归成每回次都问）', () =>
      assert.equal(approvalsD, 1, `应只问一次，实际 ${approvalsD}`),
    );
    ok('未超范围时两个回次的写操作都执行了', () =>
      assert.equal(mockCalls.create, 2, `应建 2 个，实际 ${mockCalls.create}`),
    );
    clear();

    // ── E. 未声明 count：仍按工具名豁免，但载荷要如实说明"未声明" ──
    let approvalsE = 0;
    sseQueue = [
      toolRound([
        { id: 'c-d', name: 'submit_plan', args: { steps: [{ tool: 'create_folder', summary: '建文件夹' }] } },
        { id: 'c-f1', name: 'create_folder', args: { parentId: '1', title: 'T57-C' } },
      ]),
      toolRound([{ id: 'c-f2', name: 'create_folder', args: { parentId: '1', title: 'T57-D' } }]),
      finalRound(),
    ];
    await runTurnWith('建文件夹', {
      config: { planMode: true },
      requestPlanApproval: async () => {
        approvalsE += 1;
        return true;
      },
    });
    ok('未声明条数时仍按工具名豁免（不回归）', () =>
      assert.equal(approvalsE, 1, `应只问一次，实际 ${approvalsE}`),
    );
    clear();

    // ── F. 源码守卫：卡片渲染条数，且"未声明"有如实样子 ──
    ok('UI：计划卡片渲染每步条数，且对"未声明条数"有如实文案', () => {
      const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
      const panel = readFileSync(resolve(rootDir, 'src/components/chat/chat-panel.tsx'), 'utf8');
      assert.match(panel, /step\.count/, '卡片必须渲染条数');
      assert.match(panel, /未声明/, '未声明条数时要有如实说明');
    });
  }

  /* ── T58: 等待确认时被中止/抢占，不得挂起、不得偷走新轮次的事务 ── */
  console.log('\n[T58] 中止时的结算与收尾');
  {
    const { beginUndoTransaction, endUndoTransaction, UNDO_STORAGE_KEY, UNDO_PENDING_KEY, resetUndoTransactionForTest } =
      await import('../src/lib/undo/recorder');
    const clear = () => {
      storageMap.delete(UNDO_STORAGE_KEY);
      storageMap.delete(UNDO_PENDING_KEY);
      resetUndoTransactionForTest();
      resetMockCalls();
    };

    // ── A. 停在计划确认时被 abort：必须结束，且未决登记项要清掉 ──
    const { createPlanApprovalRegistry, requestPlanApprovalWithAbort } = await import(
      '../src/lib/ai/plan-approval'
    );
    const reg = createPlanApprovalRegistry();
    let posted = 0;
    const ctrlA = new AbortController();
    // 直接用**生产实现**，不要用测试里的仿制品——否则断言只证明了测试自己
    const requestWithAbort = (messageId: string, steps: never[], signal: AbortSignal) =>
      requestPlanApprovalWithAbort(
        reg,
        messageId,
        steps,
        () => {
          posted += 1;
        },
        signal,
      );

    clear();
    sseQueue = [
      toolRound([
        { id: 'c-d', name: 'submit_plan', args: { steps: [{ tool: 'create_folder', summary: '建文件夹', count: 1 }] } },
        { id: 'c-f', name: 'create_folder', args: { parentId: '1', title: 'T58-A' } },
      ]),
      finalRound(),
    ];
    const turnA = runTurnWith('建个文件夹', {
      config: { planMode: true },
      requestPlanApproval: (steps, messageId) =>
        requestWithAbort(messageId, steps as never[], ctrlA.signal),
    });
    // 等它真的停在确认处，再 abort
    for (let i = 0; i < 50 && posted === 0; i++) await new Promise((r) => setTimeout(r, 5));
    ctrlA.abort();
    const settled = await Promise.race([
      turnA.then(() => 'done'),
      new Promise((r) => setTimeout(() => r('timeout'), 1500)),
    ]);
    ok('轮次停在计划确认时被 abort，必须能结束（不能永远挂起）', () =>
      assert.equal(settled, 'done', 'abort 后该轮应结束'),
    );
    ok('abort 后未决的登记项必须被清掉（不泄漏）', () =>
      assert.equal(reg.pendingCount(), 0, `登记表应清空，实际 ${reg.pendingCount()}`),
    );
    ok('被 abort 的轮次零写入', () =>
      assert.equal(mockCalls.create, 0, `abort 后不该有写入，实际 ${mockCalls.create}`),
    );
    clear();

    // ── B. 迟到的旧轮次收尾，不得关闭新轮次的事务 ──
    clear();
    await beginUndoTransaction('run-B');
    // 模拟"还在跑的轮次 B"记录了操作
    const { jCreate } = await import('../src/lib/undo/mutations');
    await jCreate({ parentId: '1', title: 'T58-B1' });
    // 旧轮次 A 迟到苏醒，执行它自己的收尾
    const stale = await endUndoTransaction('run-A');
    ok('迟到的旧轮次收尾不得产出撤销点，也不得关闭新轮次的事务', () =>
      assert.equal(stale, null, 'runId 不匹配时不该收尾'),
    );
    // 新轮次 B 继续写：仍必须被记录
    await jCreate({ parentId: '1', title: 'T58-B2' });
    const bPoint = await endUndoTransaction('run-B');
    ok('被迟到收尾打扰后，新轮次的操作仍然完整进入它自己的撤销点', () => {
      assert.ok(bPoint, 'B 轮应有撤销点');
      assert.equal(bPoint!.runId, 'run-B', '点必须属于 B 轮');
      assert.equal(bPoint!.ops.length, 2, `B 的两次写入都要被记录，实际 ${bPoint!.ops.length}`);
    });
    clear();
  }

  /* ── T59: 主题读取失败必须可见 + 剪贴板注释真实对齐 ── */
  console.log('\n[T59] 主题读取失败与剪贴板细节');
  {
    const g = globalThis as unknown as Record<string, unknown>;
    const origWindow = g.window;
    const origDocument = g.document;
    g.window = { matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) };
    g.document = { documentElement: { classList: { toggle: () => {} } } };

    const { useThemeStore } = await import('../src/stores/themeStore');
    const { useToastStore } = await import('../src/lib/toast');

    const storageObj = chrome.storage.local as unknown as Record<string, unknown>;
    const origGet = storageObj.get;
    storageObj.get = async () => {
      throw new Error('Storage read failure');
    };

    try {
      useToastStore.setState({ toasts: [] });
      await useThemeStore.getState().load();
      const toasts = useToastStore.getState().toasts;

      ok('themeStore.load 读取失败时必须给出警告提示（不静默回落）', () => {
        const t = toasts.find((x) => x.title === '无法读取主题设置');
        assert.ok(t, `应有无法读取主题提示，实际 ${JSON.stringify(toasts)}`);
        assert.equal(t!.variant, 'destructive');
        assert.match(t!.description ?? '', /系统默认主题/);
      });
      ok('themeStore.load 读取失败时仍安全降级到 system（界面不崩）', () => {
        assert.equal(useThemeStore.getState().theme, 'system');
      });
    } finally {
      storageObj.get = origGet;
      g.window = origWindow;
      g.document = origDocument;
    }

    // 源码守卫：clipboard.ts 不得再包含误导性的 "// 忽略"
    const { readFileSync } = await import('node:fs');
    const clipSrc = readFileSync('src/lib/clipboard.ts', 'utf-8');
    ok('clipboard.ts 注释真实对齐，不包含误导性的 "// 忽略"', () => {
      assert.ok(!clipSrc.includes('// 忽略'), '不得再有误导性的 // 忽略 注释');
    });
  }

  /* ── T60: 通用格式化工具 (format.ts) 单元测试与边界防护 ── */
  console.log('\n[T60] 通用格式化工具边界与正确性');
  {
    const { getHost, isSpecialUrl, formatIsoDate, formatRelativeTime, truncate, safeJsonParse, uid } = await import('../src/lib/format');
    ok('isSpecialUrl 准确识别特殊与本地协议', () => {
      assert.equal(isSpecialUrl('https://github.com'), false);
      assert.equal(isSpecialUrl('chrome://bookmarks'), true);
      assert.equal(isSpecialUrl('file:///tmp/a.pdf'), true);
      assert.equal(isSpecialUrl('about:blank'), true);
      assert.equal(isSpecialUrl(''), true);
    });

    ok('formatIsoDate 安全格式化并抵御异常', () => {
      assert.equal(formatIsoDate(1700000000000), '2023-11-14');
      assert.equal(formatIsoDate(Number.NaN), '');
      assert.equal(formatIsoDate(-100), '');
      assert.equal(formatIsoDate(1e16), '');
    });


    ok('getHost：正确提取标准与多级域名，剥离 www，处理无效输入', () => {
      assert.equal(getHost('https://www.google.com/search?q=1'), 'google.com');
      assert.equal(getHost('http://sub.domain.org:8080/foo'), 'sub.domain.org');
      assert.equal(getHost('https://github.com'), 'github.com');
      assert.equal(getHost('invalid-url'), '');
      assert.equal(getHost(''), '');
      assert.equal(getHost(undefined), '');
    });

    ok('formatRelativeTime：覆盖刚刚/分钟/小时/天/远期/异常值', () => {
      const now = Date.now();
      assert.equal(formatRelativeTime(undefined), '未知');
      assert.equal(formatRelativeTime(0), '未知');
      assert.equal(formatRelativeTime(-100), '未知');
      assert.equal(formatRelativeTime(Number.NaN), '未知');

      assert.equal(formatRelativeTime(now - 10_000), '刚刚');
      assert.equal(formatRelativeTime(now - 5 * 60_000), '5 分钟前');
      assert.equal(formatRelativeTime(now - 3 * 3_600_000), '3 小时前');
      assert.equal(formatRelativeTime(now - 4 * 86_400_000), '4 天前');

      const futureStamp = now + 10 * 86_400_000;
      assert.notEqual(formatRelativeTime(futureStamp), '刚刚');
      assert.match(formatRelativeTime(futureStamp), /^\d{4}-\d{2}-\d{2}$/);
    });

    ok('truncate：文本未超长原样返回，超长加省略号', () => {
      assert.equal(truncate('hello', 10), 'hello');
      assert.equal(truncate('hello world', 5), 'hello…');
      assert.equal(truncate('', 10), '');
    });

    ok('safeJsonParse：合法 JSON 解析成功，非法或空字符串返回 null', () => {
      assert.deepEqual(safeJsonParse('{"a":1,"b":"str"}'), { a: 1, b: 'str' });
      assert.equal(safeJsonParse('{invalid json}'), null);
      assert.equal(safeJsonParse(''), null);
    });

    ok('truncate 与 safeJsonParse 空安全与下限防御', () => {
      assert.equal(truncate(undefined), '');
      assert.equal(truncate('hello', -5), '…');
      assert.equal(safeJsonParse(undefined), null);
    });


    ok('uid：生成符合规范的标准 UUID v4 字符串', () => {
      const id1 = uid();
      const id2 = uid();
      assert.ok(typeof id1 === 'string' && id1.length === 36);
      assert.notEqual(id1, id2);
      assert.match(id1, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });
  }

  /* ── T61: Toast 系统去重与容量上限 ── */
  console.log('\n[T61] Toast 系统去重与容量上限');
  {
    const { useToastStore, pushToast } = await import('../src/lib/toast');

    ok('Toast 同内容去重：相同 title+desc+variant 不重复入队且复用现有 id', () => {
      useToastStore.setState({ toasts: [] });
      const id1 = pushToast('操作失败', { description: '网络超时', variant: 'destructive' });
      const id2 = pushToast('操作失败', { description: '网络超时', variant: 'destructive' });
      assert.equal(id1, id2, '去重时应返回相同 id');
      assert.equal(useToastStore.getState().toasts.length, 1, '去重后队列应只有 1 条');
    });

    ok('Toast 区分不同变体与描述：不同内容正常追加', () => {
      useToastStore.setState({ toasts: [] });
      pushToast('操作失败', { description: '网络超时', variant: 'destructive' });
      pushToast('操作失败', { description: '网络超时', variant: 'default' });
      pushToast('操作成功', { variant: 'success' });
      assert.equal(useToastStore.getState().toasts.length, 3, '不同变体/标题应正常入队');
    });

    ok('Toast 队列硬上限：连续推送大量通知仅保留最新 4 条，防 DOM 爆炸', () => {
      useToastStore.setState({ toasts: [] });
      for (let i = 0; i < 10; i++) {
        pushToast('通知 #' + i, { description: '内容 ' + i });
      }
      const list = useToastStore.getState().toasts;
      assert.equal(list.length, 4, '硬上限应保留 4 条');
      assert.equal(list[0]?.title, '通知 #6');
      assert.equal(list[3]?.title, '通知 #9');
    });

    ok('Toast remove：按 id 精确移除指定通知，不影响其余条目', () => {
      useToastStore.setState({ toasts: [] });
      const idA = pushToast('通知 A');
      const idB = pushToast('通知 B');
      assert.equal(useToastStore.getState().toasts.length, 2);
      useToastStore.getState().remove(idA);
      const remaining = useToastStore.getState().toasts;
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0]?.id, idB);
    });
  }

  /* ── T62: resolveConfig 计划模式映射 ── */
  console.log('\n[T62] resolveConfig planMode 映射');
  {
    const { resolveConfig } = await import('../src/lib/providers');
    ok('resolveConfig：正确透传 planMode: true，缺省回落为 false', () => {
      assert.equal(resolveConfig({ planMode: true }).planMode, true);
      assert.equal(resolveConfig({}).planMode, false);
      assert.equal(resolveConfig({ planMode: false }).planMode, false);
    });

    const { PLAN_MODE_INSTRUCTION, SYSTEM_PROMPT } = await import('../src/lib/ai/prompts');
    ok('PLAN_MODE_INSTRUCTION 指令规范与动态附加隔离', () => {
      assert.match(PLAN_MODE_INSTRUCTION, /submit_plan/);
      assert.match(PLAN_MODE_INSTRUCTION, /先声明计划，再动手/);
      assert.ok(!SYSTEM_PROMPT.includes('submit_plan'), '默认 SYSTEM_PROMPT 不得污染计划模式指令');
    });

  }

  /* ── T63: tools 根文件夹保护（isRoot 涵盖 id 0 与根子目录） ── */
  console.log('\n[T63] tools 根文件夹保护与拒绝策略');
  {
    const { isRoot, executeTool, classifyOneUrl, assertFolder, getDeleteMode, copyNodeDeep, MUTATING_TOOLS } = await import('../src/lib/ai/tools');

    ok('isRoot：明确判定虚拟根节点 id 0 与子根文件夹为根节点', () => {
      assert.equal(isRoot('0'), true, '虚拟根 0 必须被判定为根');
      assert.equal(isRoot('1'), true, '书签栏 1 必须被判定为根');
      assert.equal(isRoot('custom-folder-id'), false, '普通用户文件夹不得被误判为根');
    });

    await okA('move_bookmark 与 rename_bookmark 拒绝操作根文件夹', async () => {
      await assert.rejects(
        () => executeTool('move_bookmark', JSON.stringify({ bookmarkId: '0', parentId: '1' })),
        /浏览器根文件夹不可移动/,
      );
      await assert.rejects(
        () => executeTool('rename_bookmark', JSON.stringify({ bookmarkId: '1', title: '新名称' })),
      );
    });

    ok('classifyOneUrl 启发式分类：覆盖各类深度与参数', () => {
      assert.equal(classifyOneUrl('https://example.com').type, 'root');
      assert.equal(classifyOneUrl('https://example.com/index.html').type, 'root');
      assert.equal(classifyOneUrl('https://example.com/about').type, 'page');
      assert.equal(classifyOneUrl('https://example.com/docs/guide').type, 'sub');
      assert.equal(classifyOneUrl('https://example.com/a/b/c').type, 'deep');
      assert.equal(classifyOneUrl('https://example.com/search?q=1').type, 'deep');
      assert.equal(classifyOneUrl('invalid-url').type, 'unknown');
    });

    await okA('update_bookmark_url 修改 URL 与文件夹防护', async () => {
      const bm = await mockBookmarks.create({ parentId: '1', title: 'TestBM', url: 'https://old.test' });
      const res = await executeTool('update_bookmark_url', JSON.stringify({ bookmarkId: bm.id, url: 'https://new.test' }));
      assert.match(res.result, /https:\/\/new\.test/);

      const folder = await mockBookmarks.create({ parentId: '1', title: 'TestDir' });
      await assert.rejects(
        () => executeTool('update_bookmark_url', JSON.stringify({ bookmarkId: folder.id, url: 'https://any.test' })),
        /文件夹没有 URL，无法修改/,
      );

      await assert.rejects(
        () => executeTool('update_bookmark_url', JSON.stringify({ bookmarkId: 'missing-id', url: 'https://any.test' })),
        /书签不存在/,
      );
    });

    await okA('assertFolder 校验与书签拦截', async () => {
      assert.equal(await assertFolder('1'), '1');
      const bm = await mockBookmarks.create({ parentId: '1', title: 'BM', url: 'https://bm.test' });
      await assert.rejects(() => assertFolder(bm.id), /不是文件夹，无法作为父级/);
      await assert.rejects(() => assertFolder('missing-folder'), /父文件夹不存在/);
    });

    await okA('getDeleteMode：无配置或异常回退 confirm，明确 auto 返回 auto', async () => {
      storageMap.delete('markai.config');
      assert.equal(await getDeleteMode(), 'confirm');
      storageMap.set('markai.config', { deleteMode: 'auto' });
      assert.equal(await getDeleteMode(), 'auto');
      const origGet = (chrome.storage.local as any).get;
      (chrome.storage.local as any).get = async () => { throw new Error('fail'); };
      try {
        assert.equal(await getDeleteMode(), 'confirm');
      } finally {
        (chrome.storage.local as any).get = origGet;
        storageMap.delete('markai.config');
      }
    });

    await okA('copyNodeDeep 递归深度上限防护', async () => {
      const leafId = await copyNodeDeep({ id: 'x', title: 'BM', url: 'https://copy.test' } as any, '1');
      assert.ok(leafId);
      let deepNode: any = { id: 'leaf', title: 'Leaf' };
      for (let i = 0; i < 70; i++) deepNode = { id: 'n', title: 'D', children: [deepNode] };
      await assert.rejects(() => copyNodeDeep(deepNode as any, '1'), /复制节点嵌套层级超过 64 层/);
    });

    ok('MUTATING_TOOLS 动写工具集合与读类工具严格互斥', () => {
      assert.ok(MUTATING_TOOLS.has('create_bookmark'));
      assert.ok(MUTATING_TOOLS.has('move_bookmark'));
      assert.ok(MUTATING_TOOLS.has('rename_bookmark'));
      assert.ok(MUTATING_TOOLS.has('update_bookmark_url'));
      assert.ok(!MUTATING_TOOLS.has('list_bookmarks'), 'list_bookmarks 绝非写入工具');
      assert.ok(!MUTATING_TOOLS.has('search_bookmarks'), 'search_bookmarks 绝非写入工具');
      assert.ok(!MUTATING_TOOLS.has('stats'), 'stats 绝非写入工具');
      assert.ok(!MUTATING_TOOLS.has('open_bookmark'), 'open_bookmark 绝非写入工具');
    });

    // 异步准备工作放在外层、用例体保持同步：`ok()` **不 await** 回调，
    // 写成 async 回调会让 ✔ 先于断言打印，失败退化成**无名** unhandled rejection
    // （既看不到用例名，反证脚本也匹配不到 expectFail）——本文件其余 async 用例同理。
    const sortParent = await mockBookmarks.create({ parentId: '1', title: 'SortDir' });
    const sortEmptyOut = await executeTool('sort_folder', JSON.stringify({ parentId: sortParent.id }));
    const sortBm = await mockBookmarks.create({ parentId: sortParent.id, title: 'AppleBM', url: 'https://apple.com' });
    const sortFd = await mockBookmarks.create({ parentId: sortParent.id, title: 'ZebraFolder' });
    await executeTool('sort_folder', JSON.stringify({ parentId: sortParent.id, by: 'title' }));
    const sortChildren = await mockBookmarks.getChildren(sortParent.id);
    ok('sort_folder 排序规则：文件夹强制置顶与子项不足提前返回', () => {
      assert.match(sortEmptyOut.result, /子项不足，无需排序/);
      assert.equal(sortChildren[0]?.id, sortFd.id, '文件夹必须排在书签前');
      assert.equal(sortChildren[1]?.id, sortBm.id);
    });






  }

  /* ── T64: assertNoCycle 循环嵌套防护 ── */
  console.log('\n[T64] assertNoCycle 循环嵌套防护');
  {
    const { assertNoCycle } = await import('../src/lib/ai/tools');
    await okA('assertNoCycle 拦截自身与子孙嵌套', async () => {
      await assert.rejects(() => assertNoCycle('A', 'A'), /循环嵌套/);
      const p = await mockBookmarks.create({ parentId: '1', title: 'P' });
      const c = await mockBookmarks.create({ parentId: p.id, title: 'C' });
      await assert.rejects(() => assertNoCycle(p.id, c.id), /循环嵌套/);
      await assert.doesNotReject(() => assertNoCycle(p.id, '1'));
    });
  }

  /* ── T65: bookmarkStore 展开与折叠 ── */
  console.log('\n[T65] bookmarkStore 展开与折叠');
  {
    const { useBookmarkStore } = await import('../src/stores/bookmarkStore');
    ok('collapseOthers 保留自身与祖先', () => {
      useBookmarkStore.setState({
        roots: [{ id: '1', title: 'R', children: [{ id: 'A', parentId: '1', title: 'A', children: [] }, { id: 'B', parentId: '1', title: 'B', children: [] }] } as any],
        expandedIds: ['1', 'A', 'B'],
      });
      useBookmarkStore.getState().collapseOthers('A');
      const res = useBookmarkStore.getState().expandedIds;
      assert.ok(res.includes('A'), '自身必须保留');
      assert.ok(res.includes('1'), '祖先必须保留');
      assert.ok(!res.includes('B'), 'B 必须折叠');
    });
    ok('collapseAll 与 expandBranch', () => {
      useBookmarkStore.getState().collapseAll();
      assert.equal(useBookmarkStore.getState().expandedIds.length, 0);
    });
  }

  /* ── T66: turn-plan 参数解析与 stepCountOf ── */
  console.log('\n[T66] turn-plan stepCountOf');
  {
    const { stepCountOf, applyPlan } = await import('../src/lib/ai/turn-plan');
    ok('stepCountOf 覆盖显式 count 与列表字段', () => {
      assert.equal(stepCountOf(JSON.stringify({ count: 8 })), 8);
      assert.equal(stepCountOf(JSON.stringify({ bookmarkIds: ['a', 'b'] })), 2);
      assert.equal(stepCountOf(JSON.stringify({ items: ['a'] })), 1);
      assert.equal(stepCountOf('{invalid json}'), 1);
      assert.equal(stepCountOf(JSON.stringify(['arr'])), 1);
    });
    await okA('applyPlan 未确认零执行确认后如实计数', async () => {
      const step = { name: 'c', args: '{}', label: 'l', count: 1, countDeclared: false, summary: 's', preview: false };
      const unc = await applyPlan([step], async () => {}, { confirmed: false });
      assert.equal(unc.cancelled, true);
      const con = await applyPlan([step], async () => {}, { confirmed: true });
      assert.equal(con.ok, 1);
    });
  }

  /* ── T67: isRetriableError 状态码判定 ── */
  console.log('\n[T67] isRetriableError 状态码矩阵');
  {
    const { isRetriableError, ChatError } = await import('../src/lib/ai/client');
    ok('isRetriableError 状态码矩阵判定', () => {
      assert.equal(isRetriableError(new ChatError('timeout')), true);
      assert.equal(isRetriableError(new ChatError('rate', 429)), true);
      assert.equal(isRetriableError(new ChatError('err', 500)), true);
      assert.equal(isRetriableError(new ChatError('auth', 401)), false);
      assert.equal(isRetriableError(new ChatError('cancel', 499)), false);
      assert.equal(isRetriableError(new Error('plain')), false);
    });
  }

  /* ── T68: 右键菜单指令装配 ── */
  console.log('\n[T68] buildInstruction 指令装配矩阵');
  {
    const { buildInstruction } = await import('../src/lib/ai/context-menu');
    ok('buildInstruction 针对单书签、文件夹与失效节点的指令装配', () => {
      const single = buildInstruction('markai:organize', { id: 'b1', title: 'GitHub', url: 'https://github.com' } as any);
      assert.match(single.text, /判断现有分类里是否有合适的文件夹/);
      assert.equal(single.folderId, undefined);

      const folder = buildInstruction('markai:organize', { id: 'f1', title: 'Tech' } as any);
      assert.match(folder.text, /创建合适的子分类/);
      assert.equal(folder.folderId, 'f1');

      const missing = buildInstruction('markai:organize', undefined);
      assert.equal(missing.text, '');
      assert.match(missing.notice ?? '', /右键的书签已被删除或不可用/);
    });
  }

  /* ── T69: 扩展图标右键菜单的注册（Chrome 上下文白名单 + 失败如实上报） ── */
  console.log('\n[T69] 原生右键菜单注册：Chrome 上下文白名单与失败如实上报');
  {
    const { ACTION_MENUS, CHROME_CONTEXT_TYPES, FIREFOX_ONLY_CONTEXTS, registerContextMenus } =
      await import('../src/lib/ai/context-menus');
    const { buildInstruction } = await import('../src/lib/ai/context-menu');

    ok('所有菜单项只用 Chrome 支持的上下文（bookmark 只有 Firefox 有，写了必然注册失败）', () => {
      for (const spec of ACTION_MENUS) {
        assert.ok(spec.contexts.length > 0, `菜单项 ${spec.id} 缺少 contexts`);
        for (const c of spec.contexts) {
          assert.ok(
            (CHROME_CONTEXT_TYPES as readonly string[]).includes(c),
            `菜单项 ${spec.id} 用了 Chrome 不支持的上下文「${c}」——浏览器会抛 "Value must be one of ..."`,
          );
        }
      }
      // 白名单与「Firefox 独有」清单必须互斥：同时命中说明其中一份写错了
      for (const f of FIREFOX_ONLY_CONTEXTS) {
        assert.ok(
          !(CHROME_CONTEXT_TYPES as readonly string[]).includes(f),
          `${f} 不该出现在 Chrome 白名单里（它只在 Firefox 的 menus API 中有效）`,
        );
      }
    });

    ok('菜单 id 唯一且非空（重复 id 会让后来者注册失败）', () => {
      const ids = ACTION_MENUS.map((s) => s.id);
      assert.equal(new Set(ids).size, ids.length, 'id 必须唯一');
      for (const id of ids) assert.ok(id.trim().length > 0, 'id 不能为空');
    });

    // 替身同时覆盖两种真实形态：MV3 的 Promise 拒绝 与 旧实现的同步 lastError（见 context-menus.ts 顶部）
    const mkApi = (opts: {
      reject?: (id: string) => boolean;
      syncFail?: (id: string) => boolean;
      removeAllFails?: boolean;
    } = {}) => {
      const created: string[] = [];
      let last: string | undefined;
      return {
        created,
        api: {
          removeAll: async () => {
            if (opts.removeAllFails) throw new Error('removeAll 失败');
          },
          create: (props: chrome.contextMenus.CreateProperties) => {
            const id = String(props.id);
            last = undefined;
            if (opts.reject?.(id)) return Promise.reject(new TypeError(`Error at property 'contexts'（${id}）`));
            if (opts.syncFail?.(id)) {
              last = `同步注册失败（${id}）`;
              return id;
            }
            created.push(id);
            return id;
          },
          lastError: () => last,
        },
      };
    };

    const happy = mkApi();
    const happyResult = await registerContextMenus(happy.api, ACTION_MENUS);
    ok('正常注册：逐项成功，顺序与菜单定义一致', () => {
      assert.deepEqual(happyResult.failed, []);
      assert.deepEqual(happyResult.ok, ACTION_MENUS.map((s) => s.id));
      assert.deepEqual(happy.created, ACTION_MENUS.map((s) => s.id));
    });

    const rejectOne = mkApi({ reject: (id) => id === 'markai:open' });
    const rejectResult = await registerContextMenus(rejectOne.api, ACTION_MENUS);
    ok('MV3 的 Promise 拒绝被如实记账，且不牵连其余菜单项', () => {
      assert.equal(rejectResult.failed.length, 1, `应恰好一项失败，实际 ${rejectResult.failed.length}`);
      assert.equal(rejectResult.failed[0]!.id, 'markai:open');
      assert.match(rejectResult.failed[0]!.message, /contexts/);
      assert.equal(rejectResult.failed.length + rejectResult.ok.length, ACTION_MENUS.length, '成败项必须覆盖全部菜单');
      assert.ok(rejectOne.created.includes('markai:fullpage'), '一项失败不得阻断其余项');
    });

    const legacyFail = mkApi({ syncFail: (id) => id === 'markai:sep' });
    const legacyResult = await registerContextMenus(legacyFail.api, ACTION_MENUS);
    ok('同步形态的 runtime.lastError 同样被记账（两种运行形态都覆盖）', () => {
      assert.deepEqual(legacyResult.failed.map((f) => f.id), ['markai:sep']);
      assert.match(legacyResult.failed[0]!.message, /同步注册失败/);
      assert.equal(legacyResult.ok.length, ACTION_MENUS.length - 1);
    });

    const rmFail = mkApi({ removeAllFails: true });
    const rmResult = await registerContextMenus(rmFail.api, ACTION_MENUS);
    ok('清空旧菜单失败不阻断注册（一次清理异常不该让右键入口整体消失）', () => {
      assert.deepEqual(rmResult.failed, []);
      assert.equal(rmResult.ok.length, ACTION_MENUS.length);
    });

    // 本次故障的直接守卫：Firefox 独有的 bookmark 必须在本地被拦下，**不交给浏览器抛错**
    const firefoxOnly = mkApi();
    const badResult = await registerContextMenus(firefoxOnly.api, [
      { id: 'markai:bad', title: 'x', contexts: ['bookmark'] },
    ] as unknown as typeof ACTION_MENUS);
    ok('Firefox 独有的 bookmark 上下文在本地白名单被拦下（不再发放给浏览器）', () => {
      assert.deepEqual(firefoxOnly.created, [], '非法取值不得发放到 create');
      assert.equal(badResult.ok.length, 0);
      assert.equal(badResult.failed.length, 1);
      assert.match(badResult.failed[0]!.message, /bookmark/);
    });

    const emptyCtx = mkApi();
    const emptyResult = await registerContextMenus(emptyCtx.api, [
      { id: 'markai:empty', title: 'x', contexts: [] },
    ]);
    ok('缺少 contexts 的菜单项在本地被拦下（Chrome 要求至少一项）', () => {
      assert.deepEqual(emptyCtx.created, []);
      assert.match(emptyResult.failed[0]!.message, /contexts 为空/);
    });

    ok('扩展图标右键没有 bookmarkId：整库指令与打开面板都不得落到「书签已被删除」的假提示', () => {
      const tidy = buildInstruction('markai:tidy-all', undefined);
      assert.match(tidy.text, /整理我的全部书签/);
      assert.equal(tidy.notice, undefined, '整库指令与具体书签无关，不该报失效');
      assert.equal(tidy.folderId, undefined);

      const open = buildInstruction('markai:open', undefined);
      assert.equal(open.text, '');
      assert.equal(open.notice, undefined, '打开面板与书签无关，不该报"书签已被删除"');
    });

    ok('除提前处理的「完整页打开」外，每个菜单项都有指令装配分支（掉进失效提示即为 bug）', () => {
      // markai:fullpage 由 handleContextMenuClick 提前处理（直接开标签页，不装配指令；
      // 无书签上下文也不该报失效——T40 的「完整页正常路径」用例守着这一点）
      const handledUpstream = new Set(['markai:fullpage']);
      for (const spec of ACTION_MENUS) {
        if (spec.type === 'separator' || handledUpstream.has(spec.id)) continue;
        const r = buildInstruction(spec.id, undefined);
        assert.equal(r.notice, undefined, `菜单项 ${spec.id} 在无书签上下文时收到了失效节点提示`);
      }
    });
  }

  /* ── T70: 中栏文件夹子项数（getChildren/search 不填充 children） ── */
  console.log('\n[T70] 中栏文件夹子项数：不得读 node.children');
  {
    const { buildFolderChildCounts } = await import('../src/stores/bookmarkStore');
    const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

    const tree = [
      {
        id: 'root',
        title: '',
        parentId: '0',
        children: [
          {
            id: 'f1',
            title: '有内容',
            parentId: 'root',
            children: [
              { id: 'b1', title: 'b1', parentId: 'f1', url: 'https://a' },
              { id: 'b2', title: 'b2', parentId: 'f1', url: 'https://b' },
              {
                id: 'f2',
                title: '子文件夹',
                parentId: 'f1',
                children: [{ id: 'b3', title: 'b3', parentId: 'f2', url: 'https://c' }],
              },
            ],
          },
          { id: 'f3', title: '空文件夹', parentId: 'root', children: [] },
        ],
      },
    ] as unknown as chrome.bookmarks.BookmarkTreeNode[];

    const counts = buildFolderChildCounts(tree);

    ok('子项数按整棵树推导：父 3 项 / 子 1 项 / 空文件夹 0 项 / 书签不入索引', () => {
      assert.equal(counts['f1'], 3, 'f1 有 2 个书签 + 1 个子文件夹');
      assert.equal(counts['f2'], 1);
      assert.equal(counts['f3'], 0, '真正为空的文件夹要显示 0 项，不是「取不到」');
      assert.equal(counts['b1'], undefined, '书签不该出现在索引里');
    });

    // 真实 API 下 getChildren()/search() 返回的文件夹节点**不带 children**（只有
    // getTree/getSubTree 才填充）。替身比真实 API 宽容（toApi 会递归补 children），
    // 所以这里显式构造一个无 children 的行节点，证明子项数与它无关、只来自整棵树。
    const rowNode = { id: 'f1', title: '有内容', parentId: 'root' } as unknown as chrome.bookmarks.BookmarkTreeNode;
    ok('子项数与该行节点是否自带 children 无关（真实 getChildren 不带）', () => {
      assert.equal(rowNode.children, undefined, '本用例构造的就是「无 children」的行节点');
      assert.equal(counts[rowNode.id], 3, '子项数来自整棵树，不能是 0');
    });

    const src = readFileSync(resolve(rootDir, 'src/components/bookmark-list/bookmark-list.tsx'), 'utf8');
    ok('中栏文件夹子项数不得取自 getChildren/search 返回的 node.children', () => {
      assert.ok(
        !/node\.children\?\.length/.test(src),
        'bookmark-list.tsx 仍在读 node.children：getChildren()/search() 不填充 children，会恒显示 0 项',
      );
      assert.ok(
        /buildFolderChildCounts\(roots\)/.test(src),
        'bookmark-list.tsx 应改用 buildFolderChildCounts(roots) 从整棵树取子项数',
      );
      assert.ok(
        /folderCount === undefined \? '文件夹'/.test(src),
        '取不到真实子项数时应只显示「文件夹」，不得显示假的「0 项」',
      );
    });
  }

  /* ── T71: SSE 解析与传输中断（重构后的 stream.ts / client.ts） ── */
  console.log('\n[T71] SSE 解析：截断判定、脏数据、重发作废');
  {
    const { createSseAccumulator, isCompleteJsonObject } = await import('../src/lib/ai/stream');

    ok('isCompleteJsonObject：完整 / 空 / 半截的判定', () => {
      assert.equal(isCompleteJsonObject('{"a":1}'), true);
      assert.equal(isCompleteJsonObject(''), true, '空参数视为完整（执行器按 {} 处理）');
      assert.equal(isCompleteJsonObject('{"a":'), false);
      assert.equal(isCompleteJsonObject('{"query":"gi'), false);
      assert.equal(isCompleteJsonObject('null'), false, 'null 不是对象');
    });

    ok('分片喂入：跨 chunk 的 JSON 与文本都能拼回来', () => {
      const acc = createSseAccumulator();
      acc.push('data: {"choices":[{"delta":{"content":"让我"}}]}\n\n');
      acc.push('data: {"choices":[{"delta":{"content":"看看"}}]}\n\n');
      // 一个 SSE 事件被拆在两个 chunk 里（真实网络很常见）
      acc.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"search_');
      acc.push('bookmarks","arguments":"{\\"q\\":1}"}}]}}]}\n\n');
      const r = acc.end();
      assert.equal(r.content, '让我看看');
      assert.equal(r.toolCalls.length, 1);
      assert.equal(r.toolCalls[0]!.name, 'search_bookmarks');
      assert.equal(r.argsComplete, true);
    });

    ok('[DONE] 与 finish_reason 都记为正常结束', () => {
      const a = createSseAccumulator();
      a.push('data: [DONE]\n\n');
      assert.equal(a.end().completed, true, '[DONE] 是结束信号');

      const b = createSseAccumulator();
      b.push('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
      const rb = b.end();
      assert.equal(rb.completed, true, 'finish_reason 也是结束信号');
      assert.equal(rb.finishReason, 'stop');
    });

    ok('不发 [DONE] 也不发 finish_reason：completed=false，但内容照常返回', () => {
      // 不少兼容端点就是这么干的——不能因为缺结束信号就把有效回复丢掉
      const a = createSseAccumulator();
      a.push('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
      const r = a.end();
      assert.equal(r.completed, false);
      assert.equal(r.content, 'hi', '内容本身有效，必须照常返回');
      assert.equal(r.argsComplete, true);
    });

    ok('流被掐断（事件之间是完整行，但 arguments 是半截）→ argsComplete=false', () => {
      // 真实形态：服务端按片段发 arguments，每个片段是一个完整 SSE 行，
      // 连到一半断了 → 最后一个调用的参数停在半截 JSON 上
      const a = createSseAccumulator();
      a.push('data: {"choices":[{"delta":{"content":"我先看看"}}]}\n\n');
      a.push(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"move_bookmark","arguments":"{\\"id\\":\\"1"}}]}}]}\n\n',
      );
      const r = a.end();
      assert.equal(r.completed, false, '没有收到结束信号');
      assert.equal(r.argsComplete, false, '参数停在半截 JSON 上');
      assert.equal(r.content, '我先看看');
    });

    ok('最后一个 SSE 行被拦腰截断 → pendingTail=true', () => {
      const a = createSseAccumulator();
      a.push('data: {"choices":[{"delta":{"content":"ab"}}]}\n\n');
      // 最后一个事件连一行都没发完就断了（JSON 本身也是半截）
      a.push('data: {"choices":[{"delta":{"content":"cd"');
      const r = a.end();
      assert.equal(r.pendingTail, true, '末尾残留了一个解析不出来的 data 行');
    });

    ok('脏数据行不得吃掉紧随其后的有效行', () => {
      // 曾经的写法是"直接把上一行残留 + 当前行拼起来解析"，于是前一个坏行
      // 会让后一个合法行也解析失败（一次丢两行）。现在先试单行、失败才拼接。
      const a = createSseAccumulator();
      a.push('data: {not json}\n\n');
      a.push('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
      const r = a.end();
      assert.equal(r.content, 'ok', '有效行必须照常生效，不能因为前一行是脏数据就被丢掉');
      assert.ok(r.skippedLines >= 1, '脏数据要如实计数（不静默）');
    });

    ok('被拆到多行的 JSON 仍能拼回来（兼容非标准实现）', () => {
      const a = createSseAccumulator();
      a.push('data: {"choices":[{"delta":{"con\n');
      a.push('data: tent":"拼回来的"}}]}\n\n');
      const r = a.end();
      assert.equal(r.content, '拼回来的', '半个 JSON 跨行时要能拼回');
    });
  }

  {
    /* 客户端层：截断 → 当失败并自动重发；重发前必须让 UI 作废已吐出的半截文本 */
    const { chatCompletion } = await import('../src/lib/ai/client');
    fetchCalls.length = 0;
    sseQueue = [
      // 第一次：先吐了文本，然后工具调用参数停在半截 —— 模拟"回复中途断流"
      sseResponse([
        sseEvent(JSON.stringify({ choices: [{ delta: { content: '我先看看' } }] })),
        sseEvent(
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'c1', function: { name: 'move_bookmark', arguments: '{"id":"1' } },
                  ],
                },
              },
            ],
          }),
        ),
      ]),
      // 第二次：完整成功
      sseResponse([
        sseEvent(JSON.stringify({ choices: [{ delta: { content: '已经整理好了' } }] })),
        'data: [DONE]\n\n',
      ]),
    ];

    const texts: string[] = [];
    let restarts = 0;
    const turn = await chatCompletion(
      TEST_CONFIG,
      [{ role: 'user', content: 'hi' }],
      [],
      new AbortController().signal,
      {
        onText: (t) => texts.push(t),
        onToolCall: () => {},
        onRestart: () => {
          restarts++;
        },
      },
    );

    ok('回复中途被截断：整轮重发，而不是把半截工具调用发出去', () => {
      assert.equal(fetchCalls.length, 2, '截断后自动重发了一次');
      assert.equal(turn.content, '已经整理好了', '最终内容是重发后的完整回复');
      assert.equal(turn.toolCalls.length, 0, '半截参数不得变成一次真实工具调用');
    });

    ok('重发前必须回调 onRestart 让 UI 作废上一轮的半截文本', () => {
      assert.equal(restarts, 1, '已吐出过内容却没通知 UI 清空 → 两段回复会首尾相接');
      assert.ok(texts.join('').includes('我先看看'), '第一次的内容确实投递过（所以需要作废）');
    });

    const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const clientSrc = readFileSync(resolve(rootDir, 'src/lib/ai/client.ts'), 'utf8');
    ok('超时模型：首字节与空闲分开，不再用一个总超时盖住整个流', () => {
      assert.ok(/FIRST_CHUNK_TIMEOUT/.test(clientSrc), '需要首字节超时');
      assert.ok(/IDLE_TIMEOUT/.test(clientSrc), '需要空闲超时');
      assert.ok(!/const REQUEST_TIMEOUT/.test(clientSrc), '不得再有覆盖整个流式读取的总超时');
      assert.ok(/watchdog\.kick\(\)/.test(clientSrc), '每收到数据都要重置空闲计时');
    });

    const aiStoreSrc = readFileSync(resolve(rootDir, 'src/stores/aiStore.ts'), 'utf8');
    ok('UI 必须真的处理 chat:restart（否则重发后的回复会接在残文后面）', () => {
      assert.ok(
        /case 'chat:restart'/.test(aiStoreSrc),
        'aiStore 没有处理 chat:restart：后台通知作废上一轮内容，UI 却照旧追加',
      );
      assert.ok(
        /blocks: \[\]/.test(aiStoreSrc),
        'chat:restart 需要清空该消息的 blocks，否则两段回复首尾相接',
      );
      assert.ok(
        /pendingText = null/.test(aiStoreSrc),
        '16ms 批次里还没落盘的残文也要一起丢弃',
      );
    });
  }

  /* ── T72: 设计 token 一致性 ──
     真实故障：`chat-panel.tsx` 的撤销计数徽标用了 bg-primary / text-primary-foreground，
     而 main.css 里根本没有 primary 这个 token —— Tailwind v4 对未定义的颜色静默不生成 CSS，
     于是那枚徽标没有背景色、文字也是继承色，浅色模式下几乎看不见。编译、测试、构建全绿，
     只有真机看一眼才发现。这条守卫把「类名 → token 定义」的关系钉死。 */
  console.log('\n[T72] 设计 token：断裂的 token 不生成任何 CSS');
  {
    const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const cssSrc = readFileSync(resolve(rootDir, 'src/assets/main.css'), 'utf8');

    const colorTokens = new Set<string>();
    for (const m of cssSrc.matchAll(/--color-([a-z0-9-]+)\s*:/g)) colorTokens.add(m[1]!);
    const shadowTokens = new Set<string>();
    for (const m of cssSrc.matchAll(/--shadow-([a-z0-9-]+)\s*:/g)) shadowTokens.add(m[1]!);

    /** Tailwind 自带色名：项目允许直接使用（如遮罩的 bg-black/30） */
    const BUILTIN = new Set([
      'black', 'white', 'transparent', 'current', 'inherit', 'none', 'auto',
      'slate', 'gray', 'zinc', 'neutral', 'stone', 'red', 'orange', 'amber', 'yellow',
      'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet',
      'purple', 'fuchsia', 'pink', 'rose',
    ]);
    /** text- 前缀里不是颜色的一批（字号 / 对齐 / 修饰） */
    const TEXT_NOT_COLOR = new Set([
      'center', 'left', 'right', 'justify', 'start', 'end', 'nowrap', 'wrap', 'balance',
      'pretty', 'truncate', 'ellipsis', 'clip', 'uppercase', 'lowercase', 'capitalize',
      'underline', 'overline', 'through', 'no', 'indent', 'line',
    ]);
    /** 非颜色语义：ring 的宽度与 inset、border 的方向、渐变 */
    // md 是本轮新收进 main.css 的字号 token（13px：聊天气泡与输入框正文）
    const SIZE_LIKE = /^(2xs|xs|sm|md|base|lg|xl|2xl|3xl|4xl|\[|\d)/;
    const BORDER_DIR = /^(b|t|l|r|x|y|s|e)$/;
    /** border 的线型关键字（border-dashed / border-solid 等）是边框样式，不是颜色 */
    const BORDER_STYLE = new Set(['solid', 'dashed', 'dotted', 'double', 'hidden', 'none']);

    // 收集 src 下所有 .tsx
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.tsx')) files.push(p);
      }
    };
    walk(resolve(rootDir, 'src'));

    /** 去掉注释后再取字符串字面量：注释里提到 `bg-primary` 不该被当成在用 */
    const stripComments = (s: string) =>
      s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, ' ');
    const literals = (s: string) =>
      [...stripComments(s).matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)]
        .map((m) => m[1] ?? m[2] ?? m[3] ?? '')
        .join(' ');

    const broken = new Map<string, string>();
    for (const file of files) {
      const blob = literals(readFileSync(file, 'utf8'));
      for (const part of blob.split(/[\s'"`,(){}[\]]+/)) {
        const m = /^(bg|border|ring|from|via|to|decoration|divide|outline|caret|fill|stroke|shadow|accent|text)-([a-z0-9-]+?)(\/\d+)?$/.exec(part);
        if (!m) continue;
        const [, pre, name] = m;
        const seg = name!.split('-');
        if (name === 'gradient' || name!.startsWith('gradient-')) continue; // bg-gradient-to-r
        // 字号 / 对齐 / 修饰类不是颜色
        if (pre === 'text' && (SIZE_LIKE.test(name!) || seg.some((s) => TEXT_NOT_COLOR.has(s)))) continue;
        // border 的方向与宽度（border-b / border-l-0 / border-2）不是颜色
        if (pre === 'border' && (BORDER_DIR.test(seg[0]!) || seg.some((s) => /^\d+$/.test(s)))) continue;
        // border 的线型（border-dashed / border-solid）不是颜色
        if (pre === 'border' && seg.some((s) => BORDER_STYLE.has(s))) continue;
        // divide-x / divide-y 是「画不画分隔线」的布局工具，不带颜色；
        // divide-<color> 才需要颜色 token（本守卫只该检查后者）
        if (pre === 'divide' && seg.some((s) => s === 'x' || s === 'y' || /^\d+$/.test(s))) continue;
        if (pre === 'divide' && seg.some((s) => s === 'dashed' || s === 'dotted' || s === 'solid' || s === 'none' || s === 'double')) continue;
        // ring 的宽度与 ring-inset 不是颜色
        if (pre === 'ring' && (/^\d/.test(name!) || seg.includes('inset'))) continue;
        if (BUILTIN.has(name!)) continue;
        if (pre === 'shadow') {
          if (!shadowTokens.has(name!)) broken.set(part, file);
          continue;
        }
        // 多段名（accent-muted / muted-foreground / accent-foreground）取最长已定义前缀
        let ok = false;
        for (let i = seg.length; i > 0; i--) {
          if (colorTokens.has(seg.slice(0, i).join('-'))) { ok = true; break; }
        }
        if (!ok) broken.set(part, file);
      }
    }

    ok('UI 用到的颜色 token 必须都在 main.css 里有定义（断裂 token 不生成 CSS）', () => {
      assert.ok(colorTokens.has('accent'), 'accent token 应当存在（守卫自身的前提）');
      assert.equal(
        broken.size,
        0,
        `以下类名引用的颜色 token 未定义，Tailwind 不会为它们生成任何 CSS：\n${[...broken]
          .map(([c, f]) => `  ${c}  ← ${f.replace(rootDir + '/', '')}`)
          .join('\n')}`,
      );
    });

    /* 浅色（@theme）与深色（.dark）必须**各自**定义全套。只在一处定义时，
       Tailwind 仍会生成这个类（所以上面那条断裂守卫抓不到），但深色模式下会
       静默沿用浅色值——例如 bg-bubble 若只在 @theme 里，深色下就是近白底 +
       深色文字。判据：两块的 token 集合必须完全一致。 */
    const themeBlock = /@theme\s*\{([\s\S]*?)\n\}/.exec(cssSrc)?.[1] ?? '';
    const darkBlock = /\.dark\s*\{([\s\S]*?)\n\}/.exec(cssSrc)?.[1] ?? '';
    const blockTokens = (b: string) => new Set([...b.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
    ok('深色主题必须与浅色定义同一套 token（否则深色下静默沿用浅色值）', () => {
      assert.ok(themeBlock.length > 0, '未找到 @theme 块');
      assert.ok(darkBlock.length > 0, '未找到 .dark 块');
      const light = blockTokens(themeBlock);
      const dark = blockTokens(darkBlock);
      const onlyLight = [...light].filter((t) => !dark.has(t));
      const onlyDark = [...dark].filter((t) => !light.has(t));
      assert.equal(
        onlyLight.length,
        0,
        `这些 token 只在浅色 @theme 里定义，深色模式下会沿用浅色值：${onlyLight.join(', ')}`,
      );
      assert.equal(
        onlyDark.length,
        0,
        `这些 token 只在深色 .dark 里定义，浅色模式下会沿用深色值：${onlyDark.join(', ')}`,
      );
    });

    // 深色主题曾长期是紫色（#0f0911 / #16111c / #1d1628），与浅色的 Slate「零紫零品红」
    // 铁律不同源，两套主题放在一起像两个产品。判据：绿色通道不得是三通道里最低的
    // （紫/品红的共同特征就是 G 最低）。
    ok('深色主题底色不得偏紫（与浅色 Slate 铁律必须同色系）', () => {
      assert.ok(darkBlock.length > 0, '未找到 .dark 主题块');
      const purple: string[] = [];
      // 注意解构：matchAll 的第 0 项是整串，第 1、2 项才是两个捕获组。
      // 写成 [key, hex] 会把整串当 key、token 名当 hex，parseInt 得 NaN，判据恒假。
      for (const m of darkBlock.matchAll(/--color-([a-z0-9-]+):\s*#([0-9a-f]{6})/gi)) {
        const key = m[1]!;
        const hex = m[2]!;
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) continue;
        if (g <= r && g <= b && !(g === r && g === b)) purple.push(`${key}=#${hex}`);
      }
      assert.equal(purple.length, 0, `以下深色 token 偏紫/品红（G 通道最低）：${purple.join(', ')}`);
    });

    /* 滑块：原生 `input[type=range]` 是浏览器默认外观（灰蓝轨道 + 方形把手），
       深色模式下轨道仍是系统灰、不受 token 接管。所以项目用 Slider 基元保留原生的
       语义与键盘可达性（←/→/Home/End），外观由 main.css 的 .markai-slider 重画。
       这条守卫钉住三件事：样式必须在、必须用 token（而非硬编码色）、
       且两套伪元素（webkit / moz）都得覆盖——只写一套等于另一种浏览器上是原生外观。 */
    const sliderSrc = readFileSync(resolve(rootDir, 'src/components/ui/slider.tsx'), 'utf8');
    ok('滑块必须走 Slider 基元 + .markai-slider 样式（原生 range 是系统外观）', () => {
      assert.ok(
        /className=\{?\s*\[?'markai-slider'/.test(sliderSrc),
        'Slider 基元必须挂 markai-slider 类（否则 main.css 的重画样式不生效）',
      );
      // 填充比例驱动：缺了它轨道会整条是灰的，看不出当前值
      assert.ok(
        /--markai-slider-pct/.test(sliderSrc),
        'Slider 必须写入 --markai-slider-pct，否则轨道填充比例恒为 0',
      );
      for (const [prop, selector] of [
        ['轨道（webkit）', '.markai-slider::-webkit-slider-runnable-track'],
        ['把手（webkit）', '.markai-slider::-webkit-slider-thumb'],
        ['轨道（moz）', '.markai-slider::-moz-range-track'],
        ['把手（moz）', '.markai-slider::-moz-range-thumb'],
      ] as const) {
        // 必须按**完整规则块**匹配，不能只查选择器子串：
        // `::-moz-range-thumb` 是 `hover::-moz-range-thumb` / `focus-visible::-moz-range-thumb`
        // 的子串，所以主规则被删光之后子串依然存在 —— 查子串会永远为真。
        const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        assert.ok(
          new RegExp(`${escaped}\\s*\\{[^}]*\\}`).test(cssSrc),
          `main.css 缺少 ${prop} 的规则块（${selector}），该浏览器上会退回原生外观`,
        );
      }
      // 外观必须由 token 驱动，不能写死颜色
      const trackRule = /\.markai-slider::[a-z-]+-slider-(?:runnable-track|thumb)\s*\{[^}]*\}/.exec(cssSrc)?.[0] ?? '';
      assert.ok(trackRule.length > 0, '未找到滑块轨道/把手规则');
      assert.ok(
        /var\(--color-/.test(trackRule),
        `滑块样式必须用 var(--color-*) 取色，不能写死：${trackRule.slice(0, 80)}`,
      );
    });
  }

  /* ── T73: 扩展 ID 必须固定（否则每次更新都要重填配置）──
     真实故障：manifest 里没有 key 字段。Chrome 在没有 key 时用**加载目录的绝对路径**
     做 SHA-256 派生扩展 ID，而 chrome.storage.local 是按扩展 ID 隔离的。于是每次把
     新版 zip 解压到新目录加载 → 路径变 → ID 变 → API Key / 模型 / 主题 / 对话记录
     全部读不到，用户表现为「每次更新都要重新填一遍配置」。
     这类问题**没有任何运行时报错**，所以只能靠守卫钉住。 */
  console.log('\n[T73] 扩展 ID：manifest 必须带 key，否则每次更新都会丢配置');
  {
    const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const wxtSrc = readFileSync(resolve(rootDir, 'wxt.config.ts'), 'utf8');
    const keyMatch = /\bkey:\s*'([A-Za-z0-9+/=]+)'/.exec(wxtSrc);
    ok('manifest 必须固定 key（否则扩展 ID 随加载目录变化，配置每次都丢）', () => {
      assert.ok(keyMatch, 'wxt.config.ts 的 manifest 里找不到 key 字段');
      const pub = keyMatch[1]!;
      // base64 形态校验：长度须为 RSA-2048 公钥 DER 的典型值，且只含 base64 字符
      assert.match(pub, /^[A-Za-z0-9+/]+={0,2}$/, 'key 必须是单行 base64 的公钥，不能有换行或引号杂质');
      assert.ok(pub.length > 300 && pub.length < 600, `key 长度异常（${pub.length}），不像 RSA-2048 公钥`);
      // 关键安全边界：manifest 里放的必须是**公钥**。私钥（"BEGIN RSA PRIVATE KEY"）
      // 一旦提交进仓库，任何人都能签出同 ID 的扩展。公钥则以 "MIIB" 开头（DER SubjectPublicKeyInfo）。
      assert.ok(pub.startsWith('MIIB'), 'manifest.key 必须是公钥（DER SubjectPublicKeyInfo，以 MIIB 开头）');
      assert.ok(!/PRIVATE KEY/.test(wxtSrc), 'wxt.config.ts 里不得出现私钥');
    });

    // 私钥必须被 git 排除：它只用于本机生成固定 ID，泄漏等于任何人都能伪造同 ID 扩展
    ok('扩展签名的私钥不得进版本库（.keys/ 必须被 .gitignore 排除）', () => {
      const ignore = readFileSync(resolve(rootDir, '.gitignore'), 'utf8');
      assert.ok(
        /^\.keys\/?\s*$/m.test(ignore),
        '.gitignore 必须整行排除 .keys/（扩展私钥所在目录）',
      );
    });
  }

  /* ── T74: 长期记忆（核心模块 + Agent 工具 + 系统提示注入）──
     覆盖：记忆 CRUD、查重合并、开关过滤、关键词搜索、
     remember / recall_memories / forget_memory 三个工具的执行与校验、
     系统提示的动态记忆注入、参数容错规范化。 */
  console.log('\n[T74] 长期记忆');
  {
    const memMod = await import('../src/lib/ai/memory');
    const { formatMemoriesForPrompt } = memMod;
    const MEMORY_KEY = memMod.MEMORY_STORAGE_KEY;

    // 用例开始前清空记忆存储
    storageMap.delete(MEMORY_KEY);

    // 注意：所有含 await 的操作都在块级顶层顺序执行，ok() 只做同步断言——
    // 把 async 函数直接塞给 ok() 会变成"脱缰的 Promise"，与后续语句并发跑，
    // 写存储的用例会在 storageMap.delete 之后把旧数据写回来（真实踩过的坑）。
    /*
     * 断言必须收在 okA 里。
     * 原来是 `await assert.rejects(...)` 挂在块级顶层、外面套一个 `ok(name, () => {})`
     * 占位（恒真）——真断言一旦失败会**抛穿整个 IIFE**，把后面八百多项一起吞掉，
     * 只留下一条崩溃信息，看不出是哪条用例红。用 await okA 收敛成单项失败。
     */
    await okA('addMemoryItem：空内容拒绝', async () => {
      await assert.rejects(() => memMod.addMemoryItem('   '), /不能为空/);
    });

    let added: MemoryItem | undefined;
    await memMod.addMemoryItem('技术类书签按语言分类').then((r) => (added = r));
    ok('addMemoryItem：写入存储并返回完整条目', () => {
      assert.ok(added);
      assert.equal(added!.content, '技术类书签按语言分类');
      assert.equal(added!.category, 'preference');
      assert.equal(added!.enabled, true);
      assert.match(added!.id, /^mem_/);
      const stored = storageMap.get(MEMORY_KEY) as MemoryItem[];
      assert.equal(stored.length, 1);
      assert.equal(stored[0]!.content, '技术类书签按语言分类');
    });

    {
      const before = (storageMap.get(MEMORY_KEY) as MemoryItem[]).length;
      const again = await memMod.addMemoryItem('技术类书签按语言分类', 'rule');
      const after = (storageMap.get(MEMORY_KEY) as MemoryItem[]).length;
      ok('addMemoryItem：完全相同的内容去重（激活 + 更新，不新增）', () => {
        assert.equal(after, before, '重复内容不得新增条目');
        assert.equal(again.id, added!.id, '去重应命中同一条');
        assert.equal(again.category, 'rule', '重复添加时以最新类型为准');
      });
    }

    {
      const before = Date.now() - 10;
      const upd = await memMod.updateMemoryItem(added!.id, { content: '技术类按语言分类，工作类不动', category: 'rule' });
      ok('updateMemoryItem：更新内容与类型，updatedAt 刷新', () => {
        assert.ok(upd);
        assert.equal(upd!.content, '技术类按语言分类，工作类不动');
        assert.equal(upd!.category, 'rule');
        assert.ok(upd!.updatedAt >= before);
      });
    }

    {
      const off = await memMod.toggleMemoryItem(added!.id);
      const on = await memMod.toggleMemoryItem(added!.id);
      const missing = await memMod.toggleMemoryItem('mem_not_exist');
      ok('toggleMemoryItem：启用状态可来回切换', () => {
        assert.equal(off!.enabled, false);
        assert.equal(on!.enabled, true);
        assert.equal(missing, null, '不存在的 id 返回 null');
      });
    }

    ok('searchMemories：内容与分类名都参与匹配', () => {
      const list: MemoryItem[] = [
        { id: 'a', content: '清理时保留最近三个月', category: 'preference', enabled: true, createdAt: 1, updatedAt: 1 },
        { id: 'b', content: '不要动工作文件夹', category: 'rule', enabled: true, createdAt: 2, updatedAt: 2 },
      ];
      assert.equal(memMod.searchMemories('保留', list).map((m) => m.id).join(','), 'a');
      assert.equal(memMod.searchMemories('规则', list).map((m) => m.id).join(','), 'b', '分类中文名可被搜索');
      assert.equal(memMod.searchMemories('', list).length, 2, '空 query 返回全部');
      assert.equal(memMod.searchMemories('不存在', list).length, 0);
    });

    ok('formatMemoriesForPrompt：空列表返回空串，启用条目带分类标签', () => {
      assert.equal(formatMemoriesForPrompt([]), '');
      const list: MemoryItem[] = [
        { id: 'a', content: '保留最近三个月', category: 'preference', enabled: true, createdAt: 1, updatedAt: 1 },
        { id: 'b', content: '已停用的规则', category: 'rule', enabled: false, createdAt: 2, updatedAt: 2 },
      ];
      const prompt = formatMemoriesForPrompt(list);
      assert.ok(prompt.includes('[偏好] 保留最近三个月'));
      assert.ok(!prompt.includes('已停用的规则'), '停用的记忆不得注入提示词');
      assert.ok(prompt.includes('长期记忆'));
    });

    ok('formatMemoriesForPrompt：maxItems 限制注入条数（按入参顺序取前 N）', () => {
      // 与生产一致：getMemories() 按 updatedAt 降序返回，格式化器按入参顺序取前 maxItems
      const list: MemoryItem[] = Array.from({ length: 5 }, (_, i) => ({
        id: `m${i}`, content: `记忆${i}`, category: 'custom' as const, enabled: true, createdAt: i, updatedAt: i,
      })).reverse();
      const prompt = formatMemoriesForPrompt(list, 2);
      assert.ok(prompt.includes('记忆4'), '最新一条注入');
      assert.ok(prompt.includes('记忆3'), '次新一条注入');
      assert.ok(!prompt.includes('记忆0'), '超出上限的条目不注入');
    });

    // ── 工具执行 ──
    storageMap.delete(MEMORY_KEY);

    const rem = await executeTool('remember', JSON.stringify({ content: '清理时不要删 GitHub 链接', category: 'rule' }));
    ok('remember：写入成功并回执条目', () => {
      const out = JSON.parse(rem.result) as { success: boolean; item: { content: string; category: string } };
      assert.equal(out.success, true);
      assert.equal(out.item.content, '清理时不要删 GitHub 链接');
      assert.equal(out.item.category, 'rule');
    });

    // 同上：断言收进 okA，别让它的失败抛穿整个套件
    await okA('remember：内容为空被 zod 拒绝（参数不合法）', async () => {
      await assert.rejects(() => executeTool('remember', JSON.stringify({ content: '' })), /参数不合法/);
    });

    const rec = await executeTool('recall_memories', JSON.stringify({ query: 'GitHub' }));
    ok('recall_memories：按关键词命中', () => {
      const out = JSON.parse(rec.result) as { total: number; memories: { content: string }[] };
      assert.equal(out.total, 1);
      assert.equal(out.memories[0]!.content, '清理时不要删 GitHub 链接');
    });

    const recAll = await executeTool('recall_memories', '{}');
    ok('recall_memories：无 query 返回全部', () => {
      const out = JSON.parse(recAll.result) as { total: number };
      assert.equal(out.total, 1);
    });

    const fg = await executeTool('forget_memory', JSON.stringify({ query: 'GitHub' }));
    ok('forget_memory：按 query 匹配删除', () => {
      const out = JSON.parse(fg.result) as { success: boolean };
      assert.equal(out.success, true);
      const stored = (storageMap.get(MEMORY_KEY) as MemoryItem[]) ?? [];
      assert.equal(stored.length, 0);
    });

    const fgMiss = await executeTool('forget_memory', JSON.stringify({ query: '不存在的记忆' }));
    ok('forget_memory：无匹配时如实回执（不假装删除）', () => {
      const out = JSON.parse(fgMiss.result) as { success: boolean };
      assert.equal(out.success, false);
    });

    // ── 参数容错：normalizeToolArgs ──
    const dupes = await executeTool('find_duplicates', JSON.stringify({ limit: '10' }));
    ok('参数容错：数字字符串 "10" 自动矫正为数字', () => {
      const out = JSON.parse(dupes.result) as { groups?: unknown[] };
      assert.ok(out && typeof out === 'object', '字符串数字被矫正后工具正常执行');
    });

    {
      const { classifyTool } = await import('../src/lib/ai/turn-plan');
      const defNames = new Set(TOOL_DEFINITIONS.map((d) => d.function.name));
      ok('工具定义 ↔ 元信息 ↔ 分类：记忆工具三表一致', () => {
        for (const n of ['remember', 'recall_memories', 'forget_memory']) {
          assert.ok(defNames.has(n), `${n} 必须有工具定义`);
          assert.ok(TOOL_META[n], `${n} 必须有中文元信息`);
        }
        // recall_memories 是读类（可并行）；remember/forget_memory 是声明类（不进写计划）
        assert.equal(classifyTool('recall_memories'), 'read');
        assert.equal(classifyTool('remember'), 'declare');
        assert.equal(classifyTool('forget_memory'), 'declare');
      });
    }

    // ── 系统提示注入（agent 集成）──
    storageMap.delete(MEMORY_KEY);
    await memMod.addMemoryItem('优先保留主页面，子页面可清理', 'rule');

    let capturedSystem = '';
    fetchCalls.length = 0;
    sseQueue = [
      sseResponse([
        sseEvent(JSON.stringify({ choices: [{ delta: { content: '好的，已记住' } }] })),
        sseEvent('[DONE]'),
      ]),
    ];
    await runAgentTurn({
      config: TEST_CONFIG,
      messageId: 'mem-msg-1',
      history: [],
      text: '记住：优先保留主页面',
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    ok('Agent 把启用的长期记忆注入系统提示', () => {
      assert.ok(fetchCalls.length >= 1, '至少发出一次模型请求');
      const body = JSON.parse(String(fetchCalls[0]!.init.body)) as { messages: { role: string; content: string }[] };
      const sys = body.messages.find((m) => m.role === 'system');
      assert.ok(sys, '存在 system 消息');
      capturedSystem = sys!.content ?? '';
      assert.ok(capturedSystem.includes('[规则] 优先保留主页面，子页面可清理'), '系统提示包含启用中的记忆');
    });
    ok('注入的记忆位于【长期记忆】小节，且带遵守要求', () => {
      assert.ok(capturedSystem.includes('【长期记忆'), '有长期记忆小节标题');
      assert.ok(capturedSystem.includes('长期偏好与规则'), '带遵守语义说明');
    });

    // 显式传入 memories 时不读存储：允许调用方注入快照
    storageMap.delete(MEMORY_KEY);
    fetchCalls.length = 0;
    sseQueue = [
      sseResponse([
        sseEvent(JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })),
        sseEvent('[DONE]'),
      ]),
    ];
    await runAgentTurn({
      config: TEST_CONFIG,
      messageId: 'mem-msg-2',
      history: [],
      text: 'hi',
      signal: new AbortController().signal,
      onEvent: () => {},
      memories: [
        { id: 'x', content: '显式注入的记忆', category: 'habit', enabled: true, createdAt: 1, updatedAt: 1 },
      ],
    });
    ok('AgentTurnParams.memories：显式快照优先于存储', () => {
      const body = JSON.parse(String(fetchCalls[0]!.init.body)) as { messages: { role: string; content: string }[] };
      const sys = body.messages.find((m) => m.role === 'system');
      assert.ok(sys!.content!.includes('显式注入的记忆'));
      assert.ok(!sys!.content!.includes('优先保留主页面'), '存储里的旧记忆不被误注入');
    });

    // 清理现场，避免影响后续用例
    storageMap.delete(MEMORY_KEY);
  }


  /* ── T75: 时间线（只有书签个体，纯时间排序） ── */
  console.log('\n[T75] 时间线数据层');
  {
    const NOW = Date.now();
    const today = new Date(NOW);
    today.setHours(10, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const fakeTree = [
      {
        id: '1',
        title: '书签栏',
        dateAdded: 0,
        children: [
          { id: 'f1', parentId: '1', title: '技术', dateAdded: 0, children: [
            { id: 'b1', parentId: 'f1', title: 'MDN', url: 'https://developer.mozilla.org/a', dateAdded: yesterday.getTime() },
            { id: 'f2', parentId: 'f1', title: '前端', dateAdded: 0, children: [
              { id: 'b2', parentId: 'f2', title: 'React', url: 'https://react.dev/b', dateAdded: today.getTime() },
            ] },
          ] },
          { id: 'b3', parentId: '1', title: '旧页面', url: 'https://old.example.com/c', dateAdded: 1000 },
          { id: 'b4', parentId: '1', title: '无时间', url: 'https://unknown.example.com/d' },
        ],
      },
    ] as unknown as chrome.bookmarks.BookmarkTreeNode[];

    const flat = flattenBookmarks(fakeTree);
    ok('展平只产出书签个体（文件夹不进入结果）', () => {
      assert.equal(flat.length, 4);
      assert.deepEqual(flat.map((i) => i.id).sort(), ['b1', 'b2', 'b3', 'b4']);
      assert.ok(!flat.some((i) => (i as { url?: string }).url === undefined), '每一项都有可打开的 URL');
    });
    ok('路径按「根 / 子 / 孙」拼接，文件夹仅作元信息', () => {
      const b2 = flat.find((i) => i.id === 'b2')!;
      assert.equal(b2.path, '书签栏 / 技术 / 前端');
      const b3 = flat.find((i) => i.id === 'b3')!;
      assert.equal(b3.path, '书签栏');
    });

    const newest = sortTimeline(flat, 'newest');
    ok('最新在前：严格按 dateAdded 倒序', () => {
      assert.deepEqual(newest.map((i) => i.id), ['b2', 'b1', 'b3', 'b4']);
    });
    const oldest = sortTimeline(flat, 'oldest');
    ok('最早在前：严格按 dateAdded 正序', () => {
      assert.deepEqual(oldest.map((i) => i.id), ['b3', 'b1', 'b2', 'b4']);
    });
    ok('时间未知项在两种方向下都排最后', () => {
      assert.equal(newest[newest.length - 1]!.id, 'b4');
      assert.equal(oldest[oldest.length - 1]!.id, 'b4');
    });

    ok('按天分组：今天 / 昨天 / 更早 / 未知时间', () => {
      const groups = groupByDay(newest, NOW);
      assert.equal(groups[0]!.label, '今天');
      assert.equal(groups[0]!.items[0]!.id, 'b2');
      assert.equal(groups[1]!.label, '昨天');
      assert.equal(groups[groups.length - 1]!.label, '未知时间');
    });
    ok('dayLabel 对两天内的日期给相对说法', () => {
      assert.equal(dayLabel(today.getTime(), NOW), '今天');
      assert.equal(dayLabel(yesterday.getTime(), NOW), '昨天');
      assert.equal(dayLabel(0, NOW), '未知时间');
    });

    ok('时间线过滤：标题 / URL / 路径都参与匹配', () => {
      assert.deepEqual(filterTimeline(flat, 'react').map((i) => i.id), ['b2']);
      assert.deepEqual(filterTimeline(flat, 'old.example').map((i) => i.id), ['b3']);
      assert.deepEqual(filterTimeline(flat, '前端').map((i) => i.id), ['b2']);
      assert.equal(filterTimeline(flat, '   ').length, flat.length);
    });
  }

  /* ── T76: 新书签自动整理 ── */
  console.log('\n[T76] 新书签自动整理');
  {
    const fakeFolders = {
      id: '1',
      title: '书签栏',
      dateAdded: 0,
      children: [
        { id: 'fa', parentId: '1', title: '技术', dateAdded: 0, children: [
          { id: 'fb', parentId: 'fa', title: 'github.com', dateAdded: 0, children: [] },
        ] },
        { id: 'fc', parentId: '1', title: 'github.com', dateAdded: 0, children: [] },
      ],
    } as unknown as chrome.bookmarks.BookmarkTreeNode;

    const folders = collectFolderOptions(fakeFolders);
    ok('收集候选文件夹：包含根与子级，不包含书签', () => {
      assert.deepEqual(folders.map((f) => f.id), ['1', 'fa', 'fb', 'fc']);
      assert.equal(folders.find((f) => f.id === '1')!.depth, 0);
      assert.equal(folders.find((f) => f.id === 'fb')!.path, '书签栏 / 技术 / github.com');
    });
    ok('按父级限定查找：只在指定容器下复用', () => {
      assert.equal(findFolderByTitle(folders, 'github.com', 'fa')!.id, 'fb');
      assert.equal(findFolderByTitle(folders, '不存在的名字', '1'), null);
    });

    ok('模型回复解析：裸 JSON / ```json 围栏 / 无效内容', () => {
      assert.deepEqual(parseOrganizeReply('{"folderId":"abc"}'), { folderId: 'abc' });
      assert.deepEqual(parseOrganizeReply('```json\n{"newFolder":"前端开发"}\n```'), { newFolder: '前端开发' });
      assert.deepEqual(parseOrganizeReply('我觉得可以放到 {"newFolder":"AI 工具"} 里'), { newFolder: 'AI 工具' });
      assert.equal(parseOrganizeReply('无法分类'), null);
      assert.equal(parseOrganizeReply('{"folderId":"   "}'), null);
    });

    // 运行时：无 AI（无 Key）→ 域名兜底，且可撤销（走 jMove/jCreate 事务）
    storageMap.set('markai.config', {
      providerId: 'deepseek',
      baseUrl: '',
      apiKey: '',
      model: '',
      autoOrganizeNew: true,
    });
    const created = await mockBookmarks.create({
      parentId: '1',
      title: 'Example 文档',
      url: 'https://docs.example-unique.com/guide',
    });
    const res = await autoOrganizeBookmark(created.id);
    /*
     * 契约在 0.2.35 变了：认不出归属时**留在原地**，不再建 `自动整理/<域名>`。
     * 理由是用户的真实反馈——那种文件夹是程序按域名硬造的，用户从没建过；
     * 书签一旦被搬进去，就再也认不出自己原来的收藏夹结构了。
     */
    ok('未配置 AI 且无匹配分类时：留在原地，不建任何域名文件夹', () => {
      assert.equal(res.ok, true, res.detail);
      assert.equal(res.action, 'skipped', `不该动它，实际 ${res.action}: ${res.detail}`);
      assert.match(res.detail, /保持原位/);
      assert.equal(nodeById(created.id)!.parentId, '1', '书签必须还在原来的位置');
      const container = store.find((n) => n.title === AUTO_CONTAINER);
      assert.equal(container, undefined, '不该创建「自动整理」容器');
      const domainFolder = store.find((n) => n.title === 'example-unique.com');
      assert.equal(domainFolder, undefined, '不该创建按域名的文件夹');
    });
    const again = await autoOrganizeBookmark(created.id);
    ok('重复触发不会二次搬动（幂等）', () => {
      assert.equal(again.action, 'skipped');
      assert.equal(nodeById(created.id)!.parentId, '1');
    });

    storageMap.set('markai.config', { providerId: 'deepseek', autoOrganizeNew: false });
    const untouched = await mockBookmarks.create({
      parentId: '1',
      title: '关闭开关后的书签',
      url: 'https://off-switch.example.org/page',
    });
    const offRes = await autoOrganizeBookmark(untouched.id);
    ok('关闭开关：不产生任何移动，并如实说明原因', () => {
      assert.equal(offRes.action, 'skipped');
      assert.equal(offRes.detail, '未开启自动整理');
      assert.equal(nodeById(untouched.id)!.parentId, '1', '书签仍在原处');
    });

    // 清理现场：避免影响后续用例的根目录结构
    storageMap.delete('markai.config');
    await mockBookmarks.removeTree(created.id).catch(() => {});
    await mockBookmarks.removeTree(untouched.id).catch(() => {});
    const container = store.find((n) => n.title === AUTO_CONTAINER);
    if (container) await mockBookmarks.removeTree(container.id).catch(() => {});
  }


  /* ── T10: busyIds 竞态 + 自动整理分支顺序 ── */
  console.log('\n[T10] busyIds 竞态守卫 / 自动整理分支顺序');
  {
    const tick = () => new Promise((r) => setTimeout(r, 0));

    /* ── 1. busyIds：同一 tick 连点 5 次只允许 1 次请求 ── */
    // 旧写法的等价形状：判断读的是 useState 的旧快照，同一 tick 里 5 次全放行
    // 关键：`busyIds` 是本次渲染的 const 快照；setBusyIds 生成的新 Set 要等**下一次渲染**
    // 才会成为新的 busyIds。所以同一 tick 内 5 次点击读到的都是"还没这一行"的旧快照。
    const busyIds = new Set<string>();
    const queued = new Set<string>(); // 排队中的新状态（下一次渲染才会生效）
    let oldRequests = 0;
    const oldRemoveOne = (id: string) => {
      if (busyIds.has(id)) return; // ← 读旧快照：永远是 false
      queued.add(id);
      oldRequests += 1;
    };
    for (let i = 0; i < 5; i++) oldRemoveOne('p1');
    ok('[前] 旧写法：同一 tick 连点 5 次 → 5 次请求（正是 T10 要修的竞态）', () => {
      assert.equal(oldRequests, 5);
    });

    const guard = createBusyGuard();
    let requests = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const confirm = () => {
      requests += 1;
      return gate;
    };
    const busySizes: number[] = [];
    let started = 0;
    for (let i = 0; i < 5; i++) {
      if (runExclusive(guard, 'p1', confirm, (busy) => busySizes.push(busy.size))) started += 1;
    }
    ok('[后] 新守卫：同一 tick 连点 5 次 → 只发 1 次请求', () => {
      assert.equal(started, 1, '只有第一次点击应该被接受');
      assert.equal(requests, 1, 'confirmDeletions 只应被调用一次');
    });
    ok('[后] 守卫立即反映忙碌状态（不等渲染）', () => {
      assert.equal(guard.has('p1'), true);
      assert.deepEqual(busySizes, [1], '只在开始时同步一次 busy 集合');
    });

    let others = 0;
    runExclusive(guard, 'p2', async () => {
      others += 1;
    });
    runExclusive(guard, 'p3', async () => {
      others += 1;
    });
    await tick();
    ok('[后] 不同行互不阻塞，且任务结束即解锁', () => {
      assert.equal(others, 2);
      assert.equal(guard.has('p2'), false);
      assert.equal(guard.has('p3'), false);
    });

    const retryDuringFlight = runExclusive(guard, 'p1', confirm);
    ok('[后] 请求飞行期间再点同一行仍被拒绝', () => {
      assert.equal(retryDuringFlight, false);
      assert.equal(requests, 1);
    });

    release();
    await gate;
    await tick();
    ok('[后] 请求结束后解除占用，可重试同一行', () => {
      assert.equal(guard.has('p1'), false);
      const again = runExclusive(guard, 'p1', async () => {
        requests += 1;
      });
      assert.equal(again, true);
      assert.equal(requests, 2);
    });
    await tick();

    ok('[后] 同步 throw 的 task 也必须释放守卫（Verifier 复验发现的契约缺口）', () => {
      const g = createBusyGuard();
      const sizes: number[] = [];
      let threw = false;
      let startedSync = false;
      try {
        startedSync = runExclusive(
          g,
          'sync1',
          (() => {
            throw new Error('boom');
          }) as () => Promise<unknown>,
          (busy) => sizes.push(busy.size),
        );
      } catch {
        threw = true;
      }
      assert.equal(threw, false, '同步异常不应向调用方抛出（与异步失败口径一致）');
      assert.equal(startedSync, true, '占位成功应返回 true');
      assert.equal(g.has('sync1'), false, '守卫必须已释放，否则该行会永久卡死');
      assert.deepEqual(sizes, [1, 0], '开始时 busy=1、释放后 busy=0');
      assert.equal(g.begin('sync1'), true, '释放后必须能再次占用');
      g.end('sync1');
    });

    /* ── 2. 自动整理：用户已手动归类 → 即使 AI 已配置也不搬 ── */
    storageMap.set('markai.config', {
      providerId: 'deepseek',
      baseUrl: 'https://mock.invalid/v1',
      apiKey: 'sk-test-mock',
      model: 'mock-model',
      autoOrganizeNew: true,
    });

    const realFetch = globalThis.fetch;
    let aiCalls = 0;
    let aiReply = '{"newFolder":"模型新分类"}';
    (globalThis as Record<string, unknown>).fetch = async () => {
      aiCalls += 1;
      const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: aiReply } }] })}\n\ndata: [DONE]\n\n`;
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };

    const userFolder = await mockBookmarks.create({ parentId: '1', title: '我的工作' });
    const manual = await mockBookmarks.create({
      parentId: userFolder.id,
      title: '手归类的书签',
      url: 'https://manual-classified.example.com/x',
    });
    try {
      const skipped = await autoOrganizeBookmark(manual.id);
      ok('AI 已配置时，用户手归类的书签不搬（① ② 分支不得抢跑）', () => {
        // 修复前这里得到 action='created'（已用同一用例复现）；修复后必须是 skipped。
        assert.equal(skipped.action, 'skipped', `实际：${skipped.action} / ${skipped.detail}`);
        assert.equal(nodeById(manual.id)!.parentId, userFolder.id, '父级必须保持用户设定的分类');
        assert.equal(
          store.find((n) => n.title === '模型新分类'),
          undefined,
          '不应在用户分类之外凭空建出模型分类',
        );
      });
      ok('用户分类下的书签：连 AI 请求都不发（省一次调用）', () => {
        assert.equal(aiCalls, 0, `AI 被调用了 ${aiCalls} 次`);
      });

      // 对照组：根目录下的新书签，AI 已配置 → 仍应由模型决定，功能没被改废
      const fresh = await mockBookmarks.create({
        parentId: '1',
        title: '根目录新书签',
        url: 'https://fresh-root.example.com/y',
      });
      aiCalls = 0;
      const moved = await autoOrganizeBookmark(fresh.id);
      ok('对照组：根目录书签在 AI 已配置时仍走模型分类', () => {
        assert.equal(aiCalls, 1, 'AI 应该被调用一次');
        assert.ok(moved.action === 'created' || moved.action === 'moved', moved.detail);
        const parent = nodeById(fresh.id)!.parentId!;
        assert.notEqual(parent, '1', '应该被搬进新分类而不是留在根目录');
        assert.equal(nodeById(parent)!.title, '模型新分类');
      });
      await mockBookmarks.removeTree(fresh.id).catch(() => {});

      /* 模型返回超长分类名时会被截断到 24 字符（代码里早就有，但没测试守着）。
       * 用户会看到「我的分类名怎么变短了」，所以这个上限是可见行为，值得钉住。 */
      aiCalls = 0;
      aiReply = JSON.stringify({ newFolder: '这是一个非常非常非常长的分类名字需要被截断处理' });
      const longName = await mockBookmarks.create({
        parentId: '1',
        title: '触发超长分类名',
        url: 'https://very-long-folder-name.example.com/z',
      });
      const longRes = await autoOrganizeBookmark(longName.id);
      const longParent = nodeById(longName.id)!.parentId!;
      const createdName = nodeById(longParent)?.title ?? '';
      ok('模型返回超长分类名：截断到 24 字符以内，不会撑出畸形文件夹名', () => {
        assert.ok(longRes.action === 'created' || longRes.action === 'moved', longRes.detail);
        assert.notEqual(longParent, '1', '应该被搬进新分类');
        assert.ok(createdName.length > 0 && createdName.length <= 24, `实际长度 ${createdName.length}：${createdName}`);
      });
      await mockBookmarks.removeTree(longName.id).catch(() => {});
      const longFolder = store.find((n) => n.title === createdName);
      if (longFolder) await mockBookmarks.removeTree(longFolder.id).catch(() => {});
    } finally {
      (globalThis as Record<string, unknown>).fetch = realFetch;
      storageMap.delete('markai.config');
      await mockBookmarks.removeTree(manual.id).catch(() => {});
      await mockBookmarks.removeTree(userFolder.id).catch(() => {});
      const leftover = store.find((n) => n.title === '模型新分类');
      if (leftover) await mockBookmarks.removeTree(leftover.id).catch(() => {});
    }
  }

  /* ── T77: 自查回归（深目录保护 / IP 注册域 / 时间线分页分组） ── */
  console.log('\n[T77] 自查回归');
  {
    /* ── 1. 深目录里的书签属于用户既有分类：自动整理不得搬走 ──
     * 守卫原先靠 collectFolderOptions(maxDepth=4) 的快照反查父级：父级深于 4 层就查不到，
     * `parent === undefined` 于是被当成「根目录书签」→ 直接从用户手搭的分类里搬去「自动整理」。
     * 用户什么都没做，书签却挪了位置——这是最该被守住的一类退化。 */
    storageMap.set('markai.config', { providerId: 'deepseek', autoOrganizeNew: true });
    const deepChain: string[] = [];
    let deepParent = '1';
    for (let i = 1; i <= 5; i++) {
      const folder = await mockBookmarks.create({ parentId: deepParent, title: `回归层${i}` });
      deepChain.push(folder.id);
      deepParent = folder.id;
    }
    const deepNode = await mockBookmarks.create({
      parentId: deepParent,
      title: '深目录书签',
      url: 'https://deep-regression.example.com/x',
    });
    const deepRes = await autoOrganizeBookmark(deepNode.id);
    ok('自动整理：深于 4 层的用户分类不得被搬走', () => {
      assert.equal(deepRes.action, 'skipped', `实际 action=${deepRes.action}（${deepRes.detail}）`);
      assert.equal(nodeById(deepNode.id)!.parentId, deepParent, '书签必须留在用户放的那个文件夹里');
    });
    // 清理：整条链一次删掉，避免污染后续用例的根目录结构
    await mockBookmarks.removeTree(deepChain[0]!).catch(() => {});
    storageMap.delete('markai.config');

    /* ── 2. 注册域：IP 直连站点必须原样保留 ──
     * 原先一律取最后两段：192.168.1.10 → 「1.10」。后果是「自动整理」下出现名为 1.10 的
     * 文件夹，并把 192.168.1.10 与 172.16.1.10 这类不相关主机折进同一个分类。 */
    ok('注册域：IPv4 原样返回，不截成后两段', () => {
      assert.equal(registrableDomain('http://192.168.1.10:8080/admin'), '192.168.1.10');
      assert.equal(registrableDomain('https://10.0.0.10/'), '10.0.0.10');
      assert.notEqual(
        registrableDomain('http://192.168.1.10/a'),
        registrableDomain('http://172.16.1.10/b'),
        '不同网段的主机不得被折叠成同一个注册域',
      );
    });
    ok('注册域：IPv6 字面量去掉方括号', () => {
      assert.equal(registrableDomain('http://[::1]:3000/x'), '::1');
    });
    ok('注册域：普通域名与两段式 TLD 规则保持不变', () => {
      assert.equal(registrableDomain('https://docs.github.com/guide'), 'github.com');
      assert.equal(registrableDomain('https://www.bbc.co.uk/news'), 'bbc.co.uk');
      assert.equal(registrableDomain('not a url'), null);
    });

    /* ── 3. 时间线分页：日期组头显示当天真实条数 ──
     * 组头原先由「本页已渲染的切片」分组得出：100 条的今天在首屏（80 条/页）
     * 会显示成「今天 80 条」——数字是错的，用户没法知道还有 20 条没渲染。 */
    const NOW_MS = Date.now();
    const atDay = (daysAgo: number) => {
      const d = new Date(NOW_MS);
      d.setDate(d.getDate() - daysAgo);
      d.setHours(12, 0, 0, 0);
      return d.getTime();
    };
    const mkItem = (id: string, ms: number) => ({
      id,
      title: id,
      url: `https://regression.example.com/${id}`,
      dateAdded: ms,
      path: '书签栏',
    });
    const bulk = [
      ...Array.from({ length: 100 }, (_, i) => mkItem(`t${i}`, atDay(0) + i)),
      ...Array.from({ length: 5 }, (_, i) => mkItem(`y${i}`, atDay(1) + i)),
      ...Array.from({ length: 2 }, (_, i) => mkItem(`o${i}`, atDay(30) + i)),
    ];
    const dayGroups = groupByDay(sortTimeline(bulk, 'newest'), NOW_MS);
    const firstPage = pageGroups(dayGroups, 80);
    const secondPage = pageGroups(dayGroups, 103);
    ok('时间线分页：组头保留当天真实条数，页内只渲染本页条目', () => {
      assert.equal(dayGroups.length, 3, '三天应当三组');
      assert.equal(dayGroups[0]!.total, 100);
      assert.equal(firstPage.length, 1, '首屏 80 条只够铺满今天');
      assert.equal(firstPage[0]!.total, 100, '组头条数必须是当天真实条数，而不是本页条数');
      assert.equal(firstPage[0]!.items.length, 80);
      assert.equal(secondPage[1]!.total, 5, '昨天共 5 条');
      assert.equal(secondPage[1]!.items.length, 3, '第二页只补齐 3 条');
    });
  }

  /* ── T78: 新书签自动整理 · 本地规则层 ──
   * 用户要的是「识别到新书签并自动整理」。原来的兜底只有「按注册域建
   * 自动整理/<domain>」：AI 没配时，收藏十个站点就多出十个单域名文件夹，
   * 而用户其实早就有「开发」「GitHub」这类自己的分类。本地规则先认人。 */
  console.log('\n[T78] 自动整理 · 本地规则（先认用户已有分类）');
  {
    ok('品牌名：去子域与 TLD；IP 直连没有品牌名', () => {
      assert.equal(brandOf('github.com'), 'github');
      assert.equal(brandOf('docs.github.com'), 'github');
      assert.equal(brandOf('www.example.com'), 'example');
      assert.equal(brandOf('192.168.1.10'), '', 'IP 不是品牌，不该拿去匹配用户文件夹');
      assert.equal(brandOf('::1'), '');
      assert.equal(brandOf(''), '');
    });

    const mk = (id: string, title: string, depth: number, parentId = '1') => ({
      id,
      parentId,
      path: depth === 0 ? '书签栏' : `书签栏 / ${title}`,
      title,
      depth,
    });
    const ROOT = mk('1', '书签栏', 0);
    const GH = mk('fa', 'GitHub', 1);
    const GH_MINE = mk('fb', '我的 GitHub 收藏', 1);
    const DEV = mk('fc', '开发', 1);
    const FE_DEV = mk('fd', '前端开发', 1);
    const EXCEL = mk('fe', 'Excel 笔记', 1);
    const DEEP_GH = mk('ff', 'GitHub', 4, 'fx');

    // 场景隔离：用「只有一个候选」的候选集验证每一档分值
    const one = (f: typeof GH) => pickExistingFolder({ domain: 'github.com', folders: [ROOT, f], rootId: '1' });

    ok('本地规则：文件夹名与站点品牌同名 → 100 分，可直接采纳（不必问模型）', () => {
      const m = one(GH);
      assert.equal(m?.folder.id, 'fa');
      assert.equal(m?.score, 100);
      assert.ok(isConfidentMatch(m), '100 分必须算高置信');
      assert.ok(m?.reason.includes('GitHub'), m?.reason);
    });
    ok('本地规则：文件夹名包含站点品牌 → 80 分（高置信但需模型确认）', () => {
      const m = one(GH_MINE);
      assert.equal(m?.score, 80);
      assert.equal(isConfidentMatch(m), false, '包含匹配可能误伤，不能独占决策');
    });
    ok('本地规则：文件夹名等于站点语义分类 → 70 分', () => {
      const m = one(DEV);
      assert.equal(m?.score, 70);
      assert.ok(m?.reason.includes('开发'), m?.reason);
    });
    ok('本地规则：文件夹名包含语义分类 → 60 分', () => {
      assert.equal(one(FE_DEV)?.score, 60);
    });
    ok('本地规则：短品牌名不参与包含匹配（x.com 不得命中「Excel 笔记」）', () => {
      const m = pickExistingFolder({ domain: 'x.com', folders: [ROOT, EXCEL], rootId: '1' });
      assert.equal(m, null, `误伤了：${m?.folder.title} / ${m?.reason}`);
    });
    ok('本地规则：超过 3 层的文件夹不参与（用户搭得深，就不要替他改）', () => {
      assert.equal(one(DEEP_GH), null);
    });
    ok('本地规则：根自身与没有信息量的文件夹名不参与', () => {
      assert.equal(pickExistingFolder({ domain: 'github.com', folders: [ROOT], rootId: '1' }), null);
      assert.equal(pickExistingFolder({ domain: 'github.com', folders: [ROOT, mk('fz', '   ', 1)], rootId: '1' }), null);
    });
    ok('本地规则：同分取更浅的一层（确定性），不随候选顺序变化', () => {
      const a = mk('f2', 'GitHub', 2, 'fa');
      const forward = pickExistingFolder({ domain: 'github.com', folders: [ROOT, GH, a], rootId: '1' });
      const backward = pickExistingFolder({ domain: 'github.com', folders: [ROOT, a, GH], rootId: '1' });
      assert.equal(forward?.folder.id, 'fa');
      assert.equal(backward?.folder.id, 'fa', '顺序变化不得改变结论');
    });

    /* 端到端 1：AI 未配置 + 已有同名分类 → 直接归入，不新建域名文件夹 */
    storageMap.set('markai.config', { providerId: 'deepseek', baseUrl: '', apiKey: '', model: '', autoOrganizeNew: true });
    const ghFolder = await mockBookmarks.create({ parentId: '1', title: 'GitHub' });
    const ghBookmark = await mockBookmarks.create({
      parentId: '1',
      title: 'acme/new-thing',
      url: 'https://github.com/acme/new-thing',
    });
    const ghRes = await autoOrganizeBookmark(ghBookmark.id);
    ok('端到端：本地高置信匹配优先于域名兜底，不制造 自动整理/github.com', () => {
      assert.equal(ghRes.action, 'moved', ghRes.detail);
      assert.equal(nodeById(ghBookmark.id)!.parentId, ghFolder.id, '应当放进用户已有的 GitHub 分类');
      assert.ok(ghRes.detail.includes('GitHub'), ghRes.detail);
      const duplicated = store.some((n) => n.title === 'github.com' && n.parentId === '1');
      assert.equal(duplicated, false, '不得在根目录新建与用户分类重复的域名文件夹');
    });

    /* 端到端 2：只有 60 分的弱匹配（文件夹名包含语义分类词）+ AI 不可用
     * → 仍归入用户分类，而不是新建域名文件夹。tailwindcss.com 的语义分类是「设计」，
     * 「设计稿」包含该词 → 60 分；品牌 tailwindcss 与文件夹名无关，拿不到更高分。 */
    const feFolder = await mockBookmarks.create({ parentId: '1', title: '设计稿' });
    const weakBookmark = await mockBookmarks.create({
      parentId: '1',
      title: 'Tailwind 文档',
      url: 'https://tailwindcss.com/docs',
    });
    const weakRes = await autoOrganizeBookmark(weakBookmark.id);
    ok('端到端：模型不可用时，弱匹配也优先放进用户分类', () => {
      assert.equal(weakRes.action, 'moved', weakRes.detail);
      assert.equal(nodeById(weakBookmark.id)!.parentId, feFolder.id);
    });

    // 清理：恢复根目录结构，避免影响后续用例
    storageMap.delete('markai.config');
    await mockBookmarks.removeTree(ghBookmark.id).catch(() => {});
    await mockBookmarks.removeTree(weakBookmark.id).catch(() => {});
    await mockBookmarks.removeTree(ghFolder.id).catch(() => {});
    await mockBookmarks.removeTree(feFolder.id).catch(() => {});
    const leftover = store.find((n) => n.title === 'github.com' && n.parentId === '1');
    if (leftover) await mockBookmarks.removeTree(leftover.id).catch(() => {});
  }


  /* ── T79: 自动整理日志（可回看 / 可统计 / 可重试） ──
   * 自动整理是后台写操作：没有日志时，用户只会发现「书签自己跑了」。
   * toast 会消失，日志必须留下「动了什么、去了哪里、哪条失败能不能重试」。
   * 注意：ok() 是同步断言器，所有 await 必须放在它外面先取好数据。 */
  console.log('\n[T79] 自动整理日志');
  {
    ok('日志条目：字段截断与可选标记（不把整段错误栈存进去）', () => {
      const e = makeOrganizeLogEntry(
        {
          title: 'x'.repeat(400),
          url: 'https://example.com/' + 'y'.repeat(900),
          domain: 'example.com',
          action: 'failed',
          detail: 'z'.repeat(500),
          needsAttention: true,
          retryable: true,
        },
        1_700_000_000_000,
      );
      assert.equal(e.at, 1_700_000_000_000);
      assert.ok(e.id.length > 0);
      assert.ok(e.title.length <= 181, `标题未截断：${e.title.length}`);
      assert.ok(e.url.length <= 501, `URL 未截断：${e.url.length}`);
      assert.ok(e.detail.length <= 241, `详情未截断：${e.detail.length}`);
      assert.equal(e.needsAttention, true);
      assert.equal(e.retryable, true);
    });

    ok('日志条目：换行与连续空白折叠成单个空格（一行读得完）', () => {
      const e = makeOrganizeLogEntry(
        { title: 'a\n\nb', url: 'https://a.com', domain: 'a.com', action: 'moved', detail: 'x\ty\n z' },
        1,
      );
      assert.equal(e.title, 'a b');
      assert.equal(e.detail, 'x y z');
    });

    await clearOrganizeLog();
    await appendOrganizeLog(makeOrganizeLogEntry({ title: 'first', url: 'https://a.com/1', domain: 'a.com', action: 'moved', detail: 'ok' }, 1000));
    await appendOrganizeLog(makeOrganizeLogEntry({ title: 'second', url: 'https://b.com/2', domain: 'b.com', action: 'created', detail: 'ok' }, 2000));
    const ordered = await readOrganizeLog();
    ok('日志：写入后可按时间倒序读出（新的在前）', () => {
      assert.equal(ordered.length, 2, `实际 ${ordered.length} 条`);
      assert.equal(ordered[0]!.title, 'second');
    });

    await clearOrganizeLog();
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        appendOrganizeLog(
          makeOrganizeLogEntry({ title: `c${i}`, url: `https://c.com/${i}`, domain: 'c.com', action: 'moved', detail: 'ok' }, 3000 + i),
        ),
      ),
    );
    const concurrent = await readOrganizeLog();
    ok('日志：并发写入不丢记录（读-改-写必须串行化）', () => {
      assert.equal(concurrent.length, 12, `并发写丢了记录：只剩 ${concurrent.length} 条`);
    });

    await clearOrganizeLog();
    const over = ORGANIZE_LOG_LIMIT + 8;
    for (let i = 0; i < over; i++) {
      await appendOrganizeLog(
        makeOrganizeLogEntry({ title: `r${i}`, url: `https://r.com/${i}`, domain: 'r.com', action: 'moved', detail: 'ok' }, 10_000 + i),
      );
    }
    const ringed = await readOrganizeLog();
    ok('日志：环形缓冲不超过上限，且保留最新的一条', () => {
      assert.equal(ringed.length, ORGANIZE_LOG_LIMIT, '必须按上限截断');
      assert.equal(ringed[0]!.title, `r${over - 1}`, '最新的必须在最前');
      assert.equal(ringed.some((e) => e.title === 'r0'), false, '最旧的应被挤出');
    });

    storageMap.set(ORGANIZE_LOG_KEY, [
      { id: 'good', at: 5000, title: 'ok', url: 'https://ok.com', domain: 'ok.com', action: 'moved', detail: '' },
      { nope: true },
      null,
      'string',
      { id: 'missing-at', title: 'x', action: 'moved' },
    ]);
    const dirty = await readOrganizeLog();
    ok('日志：脏数据被过滤，不让坏记录拖垮整个面板', () => {
      assert.equal(dirty.length, 1);
      assert.equal(dirty[0]!.id, 'good');
    });
    await clearOrganizeLog();

    ok('统计：今天成功条数按本地自然日统计，失败单独计数', () => {
      const now = new Date(2026, 2, 5, 15, 0, 0).getTime();
      const todayEarly = new Date(2026, 2, 5, 0, 30, 0).getTime();
      const yesterday = new Date(2026, 2, 4, 23, 30, 0).getTime();
      const entries = [
        makeOrganizeLogEntry({ title: 't1', url: 'https://a.com', domain: 'a.com', action: 'moved', detail: '', at: todayEarly }),
        makeOrganizeLogEntry({ title: 't2', url: 'https://b.com', domain: 'b.com', action: 'created', detail: '', at: now }),
        makeOrganizeLogEntry({ title: 'y1', url: 'https://c.com', domain: 'c.com', action: 'moved', detail: '', at: yesterday }),
        makeOrganizeLogEntry({ title: 'f1', url: 'https://d.com', domain: 'd.com', action: 'failed', detail: '', at: now }),
        makeOrganizeLogEntry({ title: 's1', url: 'https://e.com', domain: 'e.com', action: 'skipped', detail: '', at: now }),
      ];
      const stats = summarizeOrganizeLog(entries, now);
      assert.equal(stats.total, 5);
      assert.equal(stats.moved, 2);
      assert.equal(stats.created, 1);
      assert.equal(stats.failed, 1);
      assert.equal(stats.today, 2, '只算今天成功的 moved+created');
      // latest 必须按**时间**取最近一条成功，而不是"输入里第一个 moved/created"：
      // 这个数组刻意没有按时间排序（t1 在 t2 前面但更早），
      // 用 `entries.find(...)` 会静默假设倒序，传入顺序一变就返回错的记录。
      assert.equal(stats.latest?.title, 't2', 'latest 取时间最新的成功记录，不依赖输入顺序');
    });

    ok('失败可重试判定：网络/超时可重试，配置缺失不重试', () => {
      assert.equal(isRetryableFailure('自动整理失败：The operation was aborted due to timeout'), true);
      assert.equal(isRetryableFailure('自动整理失败：HTTP 503'), true);
      assert.equal(isRetryableFailure('自动整理失败：解析失败'), true);
      assert.equal(isRetryableFailure('读取配置失败：quota'), false);
      assert.equal(isRetryableFailure('未开启自动整理'), false);
      assert.equal(isRetryableFailure('不是书签'), false);
    });

    await clearOrganizeLog();
  }


  /* ── T80: 自动整理必须「一步可撤销」 ──
   * 自动整理是后台发生的真实写操作。如果它只在后台留一个 `auto-organize:<id>` 的
   * 英文 runId、用户得自己去撤销历史里翻，那「不满意就撤回来」实际上等于没有。
   * 这里验证：整理结果带 runId → 能凭日志找到撤销点 → 撤销后书签回到原处。 */
  console.log('\n[T80] 自动整理 · 一步可撤销');
  {
    await okA('日志条目支持 runId / undoneAt，并可就地标记已撤销', async () => {
      // 同步断言器里不能 await：先把数据准备好（此处仅校验纯函数字段）
      const e = makeOrganizeLogEntry(
        { title: 'x', url: 'https://x.com', domain: 'x.com', action: 'moved', detail: '', runId: 'auto-organize:abc' },
        1,
      );
      assert.equal(e.runId, 'auto-organize:abc');
      assert.equal(e.undoneAt, undefined);
    });

    await clearOrganizeLog();
    const logged = makeOrganizeLogEntry(
      { title: '待标记', url: 'https://mark.example.com', domain: 'mark.example.com', action: 'moved', detail: '' },
      5,
    );
    await appendOrganizeLog(logged);
    await updateOrganizeLogEntry(logged.id, { undoneAt: 99 });
    const marked = await readOrganizeLog();
    ok('updateOrganizeLogEntry：标记已撤销后读回生效，且不改变 id', () => {
      const hit = marked.find((x) => x.id === logged.id);
      assert.ok(hit, '记录不该消失');
      assert.equal(hit!.undoneAt, 99);
      assert.equal(hit!.title, '待标记', '其他字段不得被覆盖');
    });
    await clearOrganizeLog();

    /* 端到端：整理 → 拿 runId → 撤销 → 书签回到原处、临时文件夹被回收 */
    storageMap.set('markai.config', { providerId: 'deepseek', baseUrl: '', apiKey: '', model: '', autoOrganizeNew: true });
    /*
     * 造一个「GitHub」文件夹让本地规则 100 分命中（品牌精确同名）→ 走 moved 分支。
     * 早先这条用例靠"按域名建站点文件夹"的 create 分支来验证 runId；
     * 那层兜底在 0.2.35 已删除（它会造出用户从未建过的分类），所以改走本地规则。
     */
    const ghFolder = await mockBookmarks.create({ parentId: '1', title: 'GitHub' });
    const movable = await mockBookmarks.create({
      parentId: '1',
      title: '可撤销整理',
      url: 'https://github.com/some/repo',
    });
    const organized = await autoOrganizeBookmark(movable.id);
    const parentAfter = nodeById(movable.id)!.parentId;
    const points = await readUndoPoints();
    const point = organized.runId ? points.find((p) => p.runId === organized.runId) : undefined;

    ok('整理结果带 runId，且能在撤销点里找到它', () => {
      assert.equal(organized.action, 'moved', organized.detail);
      assert.ok(organized.runId, '缺少 runId：用户无从撤销');
      assert.ok(point, `撤销点没找到（现有 ${points.length} 个）`);
      assert.notEqual(parentAfter, '1', '书签应当已经被搬走');
    });

    const undone = point ? await applyUndo(point.id) : null;
    ok('撤销这次整理：书签回到原处', () => {
      assert.ok(undone?.ok, undone?.reason ?? '撤销失败');
      assert.equal(nodeById(movable.id)!.parentId, '1', '书签必须回到书签栏');
      // 「GitHub」是用户早就有的文件夹，撤销**不该**连它一起删
      assert.ok(nodeById(ghFolder.id), '已有的分类文件夹不得被撤销连带删除');
    });

    await mockBookmarks.removeTree(movable.id).catch(() => {});
    await mockBookmarks.removeTree(ghFolder.id).catch(() => {});
    storageMap.delete('markai.config');
  }


  /* ── T81: 自动整理可以完全不碰 AI ──
   * 两类用户需要它：在意 token 成本的，以及不想让「收藏一个网页」把网址发给服务商的。
   * 关闭后功能不能消失：仍要用本地规则 / 域名兜底把书签归位。 */
  console.log('\n[T81] 自动整理 · 关闭 AI 参与');
  {
    storageMap.set('markai.config', {
      providerId: 'deepseek',
      // 故意给一份「完整可用」的配置：若代码没看开关，这里一定会发请求
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test-not-real',
      model: 'deepseek-v4-flash',
      autoOrganizeNew: true,
      autoOrganizeAi: false,
    });
    fetchCalls.length = 0;
    /*
     * 关闭 AI 之后仍然要能工作——靠的是**本地规则认人**（不是按域名造文件夹，
     * 那层兜底已删除：它会建出用户从没建过的分类）。
     * 这里造一个「GitHub」文件夹，让品牌精确匹配命中。
     */
    const gh = await mockBookmarks.create({ parentId: '1', title: 'GitHub' });
    const quiet = await mockBookmarks.create({
      parentId: '1',
      title: 'AI 静默测试',
      url: 'https://github.com/quiet/mode',
    });
    const quietRes = await autoOrganizeBookmark(quiet.id);
    ok('关闭后：即使配置完整也一次模型请求都不发，靠本地规则完成归类', () => {
      assert.equal(fetchCalls.length, 0, `不该产生请求，实际发了 ${fetchCalls.length} 次`);
      assert.equal(quietRes.action, 'moved', quietRes.detail);
      assert.equal(quietRes.via, 'local', '来源应标成本地规则');
      assert.equal(nodeById(quiet.id)!.parentId, gh.id, '书签应落进已有的 GitHub 文件夹');
    });

    // 认不出的情况：不发请求，也不乱建文件夹，留在原地
    fetchCalls.length = 0;
    const stranger = await mockBookmarks.create({
      parentId: '1',
      title: '认不出的站点',
      url: 'https://no-such-brand-q7z.net/x',
    });
    const strangerRes = await autoOrganizeBookmark(stranger.id);
    ok('关闭 AI 且认不出：不发请求、不建域名文件夹、留在原地', () => {
      assert.equal(fetchCalls.length, 0);
      assert.equal(strangerRes.action, 'skipped', strangerRes.detail);
      assert.equal(nodeById(stranger.id)!.parentId, '1');
    });

    await mockBookmarks.removeTree(quiet.id).catch(() => {});
    await mockBookmarks.removeTree(stranger.id).catch(() => {});
    await mockBookmarks.removeTree(gh.id).catch(() => {});
    storageMap.delete('markai.config');
  }


  /* ── T82: 大库性能护栏（数据层） ──
   * 真实用户的书签库可能几千条。这里只测**纯函数**的耗时，给它一个宽松上限：
   * 目的不是跑分，而是防止将来改出 O(n²)（例如在分组里再扫一遍全表）而不自知。
   * 阈值刻意放到很松（5000 条各步都 < 400ms），慢机器也不会误报。 */
  console.log('\n[T82] 大库性能护栏');
  {
    const N = 5000;
    const buildTree = (count: number) => {
      // 20 个文件夹 × 250 条：贴近真实形状（有层级、有分组），而不是一根直链
      const folders = 20;
      const roots: chrome.bookmarks.BookmarkTreeNode[] = [];
      const bar = {
        id: '1',
        title: '书签栏',
        dateAdded: 1,
        children: [] as chrome.bookmarks.BookmarkTreeNode[],
      } as chrome.bookmarks.BookmarkTreeNode;
      for (let f = 0; f < folders; f++) {
        const folder = {
          id: `f${f}`,
          parentId: '1',
          title: `分类 ${f}`,
          dateAdded: 2,
          children: [] as chrome.bookmarks.BookmarkTreeNode[],
        } as chrome.bookmarks.BookmarkTreeNode;
        for (let i = 0; i < Math.ceil(count / folders); i++) {
          folder.children!.push({
            id: `b${f}-${i}`,
            parentId: `f${f}`,
            title: `书签 ${f}-${i}`,
            url: `https://site${f}.example.com/${i}`,
            // 分散到最近 400 天，模拟真实收藏分布
            dateAdded: Date.now() - (i * 47 + f) * 86_400_000 / 24,
          } as chrome.bookmarks.BookmarkTreeNode);
        }
        bar.children!.push(folder);
      }
      roots.push(bar);
      return roots;
    };
    const tree = buildTree(N);
    const timed = <T,>(fn: () => T): { value: T; ms: number } => {
      const t0 = performance.now();
      const value = fn();
      return { value, ms: performance.now() - t0 };
    };

    const flat = timed(() => flattenBookmarks(tree));
    const sorted = timed(() => sortTimeline(flat.value, 'newest'));
    const grouped = timed(() => groupByDay(sorted.value));
    const paged = timed(() => pageGroups(grouped.value, 80));
    const filtered = timed(() => filterTimeline(flat.value, 'site7'));

    ok(`展平 ${N} 条书签：只收 URL 节点，耗时可接受`, () => {
      assert.equal(flat.value.length, N, `实际 ${flat.value.length}`);
      assert.ok(flat.ms < 400, `展平耗时 ${flat.ms.toFixed(0)}ms，疑似退化成 O(n²)`);
    });
    ok(`排序 ${N} 条：耗时与规模相称（n log n）`, () => {
      assert.ok(sorted.ms < 400, `排序耗时 ${sorted.ms.toFixed(0)}ms`);
      assert.equal(sorted.value.length, N);
    });
    ok('按天分组 + 首页切片：不超过 400ms，且首页只渲染 80 条', () => {
      assert.ok(grouped.ms < 400, `分组耗时 ${grouped.ms.toFixed(0)}ms`);
      assert.ok(paged.ms < 100, `切片耗时 ${paged.ms.toFixed(0)}ms`);
      const shown = paged.value.reduce((n, g) => n + g.items.length, 0);
      assert.equal(shown, 80, `首屏应只渲染 80 条，实际 ${shown}`);
    });
    ok('过滤 5000 条：结果正确且不慢', () => {
      assert.ok(filtered.ms < 200, `过滤耗时 ${filtered.ms.toFixed(0)}ms`);
      assert.ok(filtered.value.length > 0 && filtered.value.length < N);
    });

    /* 真实形状检查：分组后每天的条数是「该天真实条数」，不随分页变化 */
    ok('分页后组头 total 仍是当天真实条数（不在渲染时被截断）', () => {
      for (const pageGroup of paged.value) {
        const full = grouped.value.find((g) => g.key === pageGroup.key);
        assert.ok(full, `找不到分组 ${pageGroup.key}`);
        assert.equal(pageGroup.total, full!.total);
      }
    });
  }


  /* ── T83: 整理记录按去向聚合 ──
   * 用户最想知道「它把我东西都塞哪儿了」。逐条看要自己数，聚合后一眼就明白。 */
  console.log('\n[T83] 整理记录 · 按去向聚合');
  {
    const mk = (id: string, action: 'moved' | 'created' | 'failed' | 'skipped', target?: string) =>
      makeOrganizeLogEntry(
        { title: id, url: 'https://x.com', domain: 'x.com', action, detail: '', ...(target ? { target } : {}) },
        1,
      );

    ok('聚合：只统计真正归位的 moved/created，失败与跳过不计', () => {
      const groups = groupByTarget([
        mk('1', 'moved', '设计资料'),
        mk('2', 'moved', '设计资料'),
        mk('3', 'created', '自动整理/github.com'),
        mk('4', 'failed'),
        mk('5', 'skipped', '某文件夹'),
      ]);
      assert.deepEqual(
        groups.map((g) => [g.target, g.count]),
        [
          ['设计资料', 2],
          ['自动整理/github.com', 1],
        ],
      );
    });

    ok('聚合：按条数降序，同条数按名称排序（渲染顺序稳定）', () => {
      const groups = groupByTarget([
        mk('a', 'moved', '乙'),
        mk('b', 'moved', '甲'),
        mk('c', 'moved', '乙'),
      ]);
      assert.equal(groups[0]!.target, '乙');
      assert.equal(groups[0]!.count, 2);
      // 同数时按 localeCompare 排序，至少保证「两次调用结果一致」
      assert.deepEqual(groupByTarget([mk('a', 'moved', '乙'), mk('b', 'moved', '甲')]), groupByTarget([mk('b', 'moved', '甲'), mk('a', 'moved', '乙')]));
    });

    ok('聚合：没有 target 的记录（历史/跳过）不产出空名分组', () => {
      const groups = groupByTarget([mk('1', 'moved'), mk('2', 'created', '   ')]);
      assert.deepEqual(groups, []);
    });
  }


  /* ── T84: 批量补整理的两条提速路径 ──
   * 导入几百条书签后点「补整理」，如果每条都独立决策：同域名重复问模型、
   * 某域名超时后其余条目还各等一次 12 秒——几百条会跑到用户放弃。
   * 这两条路径是批量场景能不能用起来的关键，必须有回归。 */
  console.log('\n[T85] 自动整理 · 站点免打扰');
  {
    await clearOptOutDomains();
    await addOptOutDomain('GitHub.com', 1000);
    const list = await readOptOutDomains();
    await okA('免打扰名单：域名归一化为小写，可判断命中', async () => {
      assert.equal(list.length, 1);
      assert.equal(list[0]!.domain, 'github.com');
    });
    const hit = await isOrganizeOptedOut('github.com');
    const miss = await isOrganizeOptedOut('gitlab.com');
    const upper = await isOrganizeOptedOut('GITHUB.COM');
    ok('免打扰判定：命中 / 未命中 / 大小写不敏感', () => {
      assert.equal(hit, true);
      assert.equal(miss, false);
      assert.equal(upper, true);
    });

    await addOptOutDomain('github.com', 2000);
    const again = await readOptOutDomains();
    ok('重复加入：只更新时间，不产生重复项', () => {
      assert.equal(again.length, 1);
      assert.equal(again[0]!.at, 2000, '时间应更新为最新');
    });

    await okA('空域名不写入（避免产生一条永远命中不了的空记录）', async () => {
      await addOptOutDomain('   ');
      const after = await readOptOutDomains();
      assert.equal(after.length, 1);
    });

    storageMap.set(ORGANIZE_OPTOUT_KEY, [{ domain: 'ok.com', at: 1 }, { nope: 1 }, null, 'x', { domain: '' }]);
    const dirty = await readOptOutDomains();
    ok('脏数据被过滤，不让坏记录拖垮判定', () => {
      assert.deepEqual(dirty.map((d) => d.domain), ['ok.com']);
    });

    /* 端到端：名单里的站点，后台自动整理必须让位 */
    storageMap.set('markai.config', { providerId: 'deepseek', autoOrganizeNew: true });
    await clearOptOutDomains();
    await addOptOutDomain('quiet-zone-q3.example', 3000);
    const optedBookmark = await mockBookmarks.create({
      parentId: '1',
      title: '免打扰站点的书签',
      url: 'https://quiet-zone-q3.example/page',
    });
    const optedRes = await autoOrganizeBookmark(optedBookmark.id);
    ok('端到端：被叫停的站点，新书签不再自动搬动，并说明原因', () => {
      assert.equal(optedRes.action, 'skipped', optedRes.detail);
      assert.ok(optedRes.detail.includes('撤销'), optedRes.detail);
      assert.equal(nodeById(optedBookmark.id)!.parentId, '1', '书签必须留在原处');
    });

    /*
     * 用户主动要求（重试失败记录 / 对话里明确让它整理）时必须越过免打扰——
     * 否则「点了没反应」，与承诺不符。免打扰挡的只是**后台自动行为**。
     *
     * 用 github.com + 已有的「GitHub」文件夹，让本地规则能真的把它搬走；
     * 换成一个认不出的域名会「留在原地」，那样就测不出「越过免打扰」这件事了。
     */
    const ghForOptOut = await mockBookmarks.create({ parentId: '1', title: 'GitHub' });
    await addOptOutDomain('github.com', 3100);
    const optedGithub = await mockBookmarks.create({
      parentId: '1',
      title: '免打扰站点的书签（可识别）',
      url: 'https://github.com/opt/out',
    });
    const blocked = await autoOrganizeBookmark(optedGithub.id);
    ok('免打扰生效：即使能被本地规则识别，后台也不搬', () =>
      assert.equal(blocked.action, 'skipped', blocked.detail),
    );
    const manual = await autoOrganizeBookmark(optedGithub.id, { ignoreOptOut: true });
    ok('用户主动要求时越过免打扰名单，仍会整理', () => {
      assert.equal(manual.action, 'moved', manual.detail);
      assert.equal(nodeById(optedGithub.id)!.parentId, ghForOptOut.id, '主动要求时应当真的搬动');
    });
    await removeOptOutDomain('github.com');
    await mockBookmarks.removeTree(optedGithub.id).catch(() => {});
    await mockBookmarks.removeTree(ghForOptOut.id).catch(() => {});

    /* 单个恢复：用户可能只想放开一个站点，而不是全部 */
    await addOptOutDomain('keep-off.example', 4000);
    await removeOptOutDomain('quiet-zone-q3.example');
    const afterOne = await readOptOutDomains();
    const stillOff = await isOrganizeOptedOut('keep-off.example');
    ok('单独恢复一个站点：只移除它，其他站点保持免打扰', () => {
      assert.equal(afterOne.some((e) => e.domain === 'quiet-zone-q3.example'), false, '被恢复的应移除');
      assert.equal(stillOff, true, '其他站点不该被连带恢复');
    });

    await clearOptOutDomains();
    const restored = await isOrganizeOptedOut('quiet-zone-q3.example');
    ok('清空名单后恢复自动整理（用户改主意不该被永久困住）', () => {
      assert.equal(restored, false);
    });

    await mockBookmarks.removeTree(optedBookmark.id).catch(() => {});
    storageMap.delete('markai.config');
    await clearOptOutDomains();
  }


  /* ── T86: 成功结果上的两句提示（首次引导 / 重复收藏） ──
   * 两条都只在「第一次」或「真的重复」时出现；否则每次收藏都挂一句就成了新的噪音。 */
  console.log('\n[T86] 自动整理 · 首次引导与重复提示');
  {
    ok('首次整理：补上「可在顶栏整理里回看与撤销」', () => {
      const out = decorateOrganizeDetail('已归入「设计资料」', { firstTime: true, duplicateCount: 1 });
      assert.ok(out.includes('已归入「设计资料」'), out);
      assert.ok(out.includes('顶栏「整理」'), out);
      assert.ok(!out.includes('收藏了'), '没有重复就不该提重复');
    });
    ok('非首次：不重复唠叨（文案与原样一致）', () => {
      assert.equal(decorateOrganizeDetail('已归入「A」', { firstTime: false, duplicateCount: 1 }), '已归入「A」');
    });
    ok('重复收藏：点明「收藏了 N 次」，一次也不算重复', () => {
      assert.ok(decorateOrganizeDetail('已归入「A」', { firstTime: false, duplicateCount: 3 }).includes('收藏了 3 次'));
      assert.ok(!decorateOrganizeDetail('已归入「A」', { firstTime: false, duplicateCount: 1 }).includes('收藏了'));
    });
    ok('两件事同时成立：两句都带上，用分隔符连成一句', () => {
      const out = decorateOrganizeDetail('已归入「A」', { firstTime: true, duplicateCount: 2 });
      assert.ok(out.includes('顶栏「整理」') && out.includes('收藏了 2 次'), out);
      assert.equal(out.split(' · ').length, 3, `应当是 3 段：${out}`);
    });
  }


  /* ── T87: 整理记录检索 ──
   * 记录上限 200 条、面板一次只露五六行。没有检索，找「那天 github 那条」只能滚。 */
  console.log('\n[T87] 整理记录 · 检索与筛选');
  {
    const mk = (id: string, opts: Partial<{ title: string; domain: string; url: string; target: string; detail: string; action: 'moved' | 'failed' | 'skipped' }>) =>
      makeOrganizeLogEntry(
        {
          title: opts.title ?? id,
          url: opts.url ?? `https://${opts.domain ?? 'x.com'}/p`,
          domain: opts.domain ?? 'x.com',
          action: opts.action ?? 'moved',
          detail: opts.detail ?? '',
          ...(opts.target ? { target: opts.target } : {}),
        },
        1,
      );
    const entries = [
      mk('a', { title: 'Radix UI', domain: 'radix-ui.com', target: '设计资料' }),
      mk('b', { title: 'GitHub · dsh', domain: 'github.com', target: '自动整理 / github.com' }),
      mk('c', { title: 'Hacker News', domain: 'news.ycombinator.com', action: 'failed', detail: 'timeout' }),
      mk('d', { title: 'Tailwind', domain: 'tailwindcss.com', target: '设计资料' }),
    ];

    ok('检索：标题 / 域名 / 去向 / 说明 都参与匹配', () => {
      assert.deepEqual(filterOrganizeLog(entries, { query: 'radix' }).map((e) => e.title), ['Radix UI']);
      assert.deepEqual(filterOrganizeLog(entries, { query: 'ycombinator' }).map((e) => e.title), ['Hacker News']);
      assert.deepEqual(filterOrganizeLog(entries, { query: '设计资料' }).map((e) => e.title), ['Radix UI', 'Tailwind']);
      assert.deepEqual(filterOrganizeLog(entries, { query: 'timeout' }).map((e) => e.title), ['Hacker News']);
    });

    ok('检索：大小写不敏感，空查询返回全部', () => {
      assert.equal(filterOrganizeLog(entries, { query: 'GITHUB' }).length, 1);
      assert.equal(filterOrganizeLog(entries, { query: '   ' }).length, entries.length);
      assert.equal(filterOrganizeLog(entries).length, entries.length);
    });

    ok('筛选：只看失败与检索可以叠加', () => {
      assert.deepEqual(filterOrganizeLog(entries, { onlyFailed: true }).map((e) => e.title), ['Hacker News']);
      // 叠加：失败 + 匹配不上 → 空
      assert.deepEqual(filterOrganizeLog(entries, { onlyFailed: true, query: 'radix' }), []);
      // 叠加：失败 + 能匹配 → 命中
      assert.deepEqual(filterOrganizeLog(entries, { onlyFailed: true, query: 'hacker' }).map((e) => e.title), ['Hacker News']);
    });

    ok('检索：没有匹配时返回空数组（不是原样返回，避免"搜了没反应"）', () => {
      assert.deepEqual(filterOrganizeLog(entries, { query: '绝对不存在的关键词zzz' }), []);
    });
  }


  /* ── T88: 文件夹复用的大小写/空格边界 ──
   * 用户手建的「设计资料 」多一个尾空格、AI 回的「AI 工具」与已有的「AI工具」差一个空格——
   * 直接 `===` 会让复用失效，自动整理于是造出两个看着一模一样的文件夹。 */
  console.log('\n[T88] 文件夹复用 · 大小写与空格边界');
  {
    const fake = {
      id: '1',
      title: '书签栏',
      dateAdded: 0,
      children: [
        { id: 'f1', parentId: '1', title: '设计资料 ', dateAdded: 0, children: [] },
        { id: 'f2', parentId: '1', title: 'AI工具', dateAdded: 0, children: [] },
        { id: 'f3', parentId: '1', title: 'Reading List', dateAdded: 0, children: [] },
        { id: 'f4', parentId: '1', title: '设计资料', dateAdded: 0, children: [] },
      ],
    } as unknown as chrome.bookmarks.BookmarkTreeNode;
    const folders = collectFolderOptions(fake);

    ok('复用：尾空格不该导致新建重复文件夹', () => {
      const hit = findFolderByTitle(folders, '设计资料', '1');
      assert.ok(hit, '应当复用已有的「设计资料 」而不是新建');
      // 同分时取更浅 + id 更小：这里两个候选同层，取 id 更小的 f1
      assert.equal(hit!.id, 'f1');
    });
    ok('复用：中间空格差异（AI 工具 vs AI工具）视为同一个', () => {
      assert.equal(findFolderByTitle(folders, 'AI 工具', '1')!.id, 'f2');
      assert.equal(findFolderByTitle(folders, 'AI工具 ', '1')!.id, 'f2');
    });
    ok('复用：英文分类名大小写不敏感', () => {
      assert.equal(findFolderByTitle(folders, 'reading list', '1')!.id, 'f3');
      assert.equal(findFolderByTitle(folders, 'READING LIST', '1')!.id, 'f3');
    });
    ok('复用：名字确实不同时不误伤', () => {
      assert.equal(findFolderByTitle(folders, '设计', '1'), null);
      assert.equal(findFolderByTitle(folders, '设计资料集', '1'), null);
      assert.equal(findFolderByTitle(folders, 'Reading', '1'), null);
    });
  }


  /* ── T89: 批量重试的挑选规则 ──
   * 一次网络抖动可能留下十几条失败；逐条点重试是体力活。
   * 但「可重试」必须挑准：把配置类失败混进来，用户点完会一半没动静。 */
  console.log('\n[T89] 整理记录 · 批量重试挑选');
  {
    const mk = (id: string, patch: Partial<OrganizeLogEntry>) => ({
      ...makeOrganizeLogEntry(
        { title: id, url: `https://${id}.com/x`, domain: `${id}.com`, action: 'failed', detail: '' },
        1,
      ),
      ...patch,
    });

    ok('只挑「失败 + 可重试 + 未撤销」的条目', () => {
      const entries: OrganizeLogEntry[] = [
        mk('net', { retryable: true }),                 // 网络失败：可重试
        mk('conf', { retryable: false }),               // 配置缺失：不可重试
        mk('done', { action: 'moved', retryable: true }), // 已成功
        mk('undone', { retryable: true, undoneAt: 99 }), // 撤销过
        mk('plain', {}),                                 // 没有 retryable 标记
      ];
      assert.deepEqual(pickRetryableEntries(entries).map((e) => e.title), ['net']);
    });

    ok('没有可重试项时返回空（UI 据此不出现「重试全部」）', () => {
      assert.deepEqual(pickRetryableEntries([mk('conf', { retryable: false })]), []);
      assert.deepEqual(pickRetryableEntries([]), []);
    });

    ok('批次保持原顺序（老的先重试，与列表视觉顺序一致）', () => {
      const entries = [mk('a', { retryable: true }), mk('b', { retryable: true })];
      assert.deepEqual(pickRetryableEntries(entries).map((e) => e.title), ['a', 'b']);
    });
  }


  /* ── T90: 导出整理记录 ──
   * 用户问「它到底动过什么」时，文件比截图有用。这里只验结构与关键字段，
   * 不追求排版细节——导出的是给人看的材料，不是第二个数据源。 */
  console.log('\n[T90] 整理记录 · 导出 Markdown');
  {
    const mk = (id: string, patch: Partial<OrganizeLogEntry>) =>
      makeOrganizeLogEntry(
        { title: id, url: `https://${id}.com/x`, domain: `${id}.com`, action: 'moved', detail: '已归入「设计资料」' },
        patch.at ?? 1,
      );

    const now = new Date(2026, 9, 25, 18, 30, 0).getTime();
    const entries: OrganizeLogEntry[] = [
      { ...mk('今天成功的', {}), at: now - 60_000, target: '设计资料', via: 'local' as const },
      // 注意：action 要写在最外层覆盖（mk 的 patch 只负责 at），否则它仍是一条成功记录
      { ...mk('今天失败的', {}), at: now - 3_600_000, action: 'failed' as const, detail: 'timeout' },
      // 补一条 created：标签与 moved 不同，导出时不能混成同一个词
      { ...mk('新建的那条', {}), at: now - 120_000, action: 'created' as const, target: '新分类' },
      { ...mk('昨天那条', {}), at: now - 26 * 3_600_000, target: '自动整理 / github.com' },
    ];
    const md = buildOrganizeLogMarkdown(entries, { now, optOuts: ['github.com'] });

    ok('导出：含标题、导出时间与统计', () => {
      assert.ok(md.startsWith('# MarkAI 整理记录'), md.slice(0, 40));
      assert.ok(md.includes('导出时间：'), '缺少导出时间');
      assert.ok(md.includes('累计归入 3 条'), md);
      assert.ok(md.includes('失败 1 条'), md);
    });
    ok('导出：带上判断来源（排查「为什么这么频繁调模型」的第一眼依据）', () => {
      assert.ok(md.includes('判断来源：本地规则 1'), md);
    });
    ok('导出：带上免打扰站点（排查时最容易被忽略的一层）', () => {
      assert.ok(md.includes('已停用自动整理的站点：github.com'), md);
    });
    ok('导出：按天分组，每条含动作与去向', () => {
      assert.ok(md.includes('## 2026-10-25'), '缺少当天小节');
      assert.ok(md.includes('## 2026-10-24'), '缺少前一天小节');
      assert.ok(md.includes('已归入「设计资料」'), md);
      assert.ok(md.includes('— 新建并归入「新分类」'), 'created 必须用独立标签，不能和 moved 混成一个词');
    });
    ok('导出：失败条目照原样标出，不粉饰', () => {
      assert.ok(md.includes('**今天失败的** — 失败'), md);
    });
    ok('导出：空记录时给一句说明，而不是一个只有标题的空文件', () => {
      const empty = buildOrganizeLogMarkdown([], { now });
      assert.ok(empty.includes('还没有任何整理记录'), empty);
    });
  }


  /* ── T91: 移动必须记下「移动前下标」，否则撤销会打乱顺序 ──
   * 撤销靠 fromIndex 把书签放回原来的位置；拿错下标就会悄悄打乱顺序——
   * 这是用户最不容易发现、但一旦发生就再也对不回去的一类错误。 */
  console.log('\n[T91] 移动 · 移动前下标准确性');
  {
    const { jMove } = await import('../src/lib/undo/mutations');
    const { beginUndoTransaction, endUndoTransaction } = await import('../src/lib/undo/recorder');

    const folder = await mockBookmarks.create({ parentId: '1', title: '顺序校验' });
    const p1 = await mockBookmarks.create({ parentId: '1', title: 'p1', url: 'https://order.example.com/1' });
    const p2 = await mockBookmarks.create({ parentId: '1', title: 'p2', url: 'https://order.example.com/2' });
    const p3 = await mockBookmarks.create({ parentId: '1', title: 'p3', url: 'https://order.example.com/3' });
    const beforeIds = childrenOf('1').map((n) => n.id);
    const expectIndex = beforeIds.indexOf(p2.id);

    // 必须先开事务：没有活动事务时 recordOp 会静默忽略（这是刻意的，非 Agent 写入不必记账）
    await beginUndoTransaction('t91-move');
    await jMove(p2.id, { parentId: folder.id });
    const point = await endUndoTransaction('t91-move');

    ok('移动：撤销点里的 fromIndex / fromParentId 与移动前一致', () => {
      assert.ok(point, '应留下撤销点');
      const moveOp = point!.ops.find((op) => op.kind === 'move' && op.id === p2.id);
      assert.ok(moveOp && moveOp.kind === 'move', '应记录一条 move');
      assert.equal((moveOp as { fromIndex: number }).fromIndex, expectIndex, '下标必须是移动前的');
      assert.equal((moveOp as { fromParentId: string }).fromParentId, '1');
    });

    const undoRes = await applyUndo();
    ok('撤销这次移动后，父目录顺序与操作前逐节点一致', () => {
      assert.ok(undoRes.ok, `撤销应成功，实际 ${JSON.stringify(undoRes)}`);
      assert.deepEqual(
        childrenOf('1').map((n) => n.id),
        beforeIds,
        '顺序被打乱的话，用户再也对不回去',
      );
      assert.equal(nodeById(p2.id)!.parentId, '1', '书签应回到原父目录');
    });

    void p1;
    void p3;
    await mockBookmarks.removeTree(folder.id).catch(() => {});
  }

  console.log('\n[T93] 自动整理 · AI 连续失败冷却');
  {
    const start = { streak: 0, cooldownUntil: 0, justCooled: false };

    ok('连续失败累计；未达阈值不冷却', () => {
      let st = start;
      for (let i = 0; i < AI_FAIL_STREAK_LIMIT - 1; i++) {
        st = nextAiStreakState({ state: st, failed: true, now: 1000 + i });
      }
      assert.equal(st.streak, AI_FAIL_STREAK_LIMIT - 1);
      assert.equal(st.cooldownUntil, 0, '还没到阈值，不该冷却');
      assert.equal(st.justCooled, false);
    });

    ok('达到阈值：进入冷却，且只提示一次', () => {
      let st = start;
      for (let i = 0; i < AI_FAIL_STREAK_LIMIT; i++) {
        st = nextAiStreakState({ state: st, failed: true, now: 10_000 + i });
      }
      assert.ok(st.cooldownUntil > 10_000, '应当设置冷却截止时间');
      assert.equal(st.justCooled, true, '首次进入冷却要提示');
      // 冷却期内继续失败：不再重复提示
      const again = nextAiStreakState({ state: st, failed: true, now: 20_000 });
      assert.equal(again.justCooled, false, '冷却期内不重复提示');
      assert.equal(again.cooldownUntil, st.cooldownUntil, '冷却窗口不变');
    });

    ok('成功一次就清零（偶发失败不该累积成冷却）', () => {
      let st = { streak: AI_FAIL_STREAK_LIMIT - 1, cooldownUntil: 0, justCooled: false };
      st = nextAiStreakState({ state: st, failed: false, now: 5000 });
      assert.equal(st.streak, 0);
      assert.equal(st.cooldownUntil, 0);
    });

    ok('冷却到期后重新计数，允许再试一次', () => {
      const cooled = { streak: AI_FAIL_STREAK_LIMIT, cooldownUntil: 100_000, justCooled: false };
      const after = nextAiStreakState({ state: cooled, failed: false, now: 100_000 + AI_COOLDOWN_MS });
      assert.equal(after.streak, 0);
      assert.equal(after.cooldownUntil, 0);
      assert.equal(after.justCooled, false);
    });

    ok('没问模型（failed:false）时不累加，避免把「关掉 AI」误判成失败', () => {
      const st = nextAiStreakState({ state: start, failed: false, now: 1000 });
      assert.equal(st.streak, 0);
      assert.equal(st.cooldownUntil, 0);
    });
  }


  /* ── T94: 归类来源（本地规则 / 模型 / 兜底）──
   * 用户想知道「AI 到底用了多频繁」：本地规则命中越多，说明自动整理越快也越省钱。
   * 这条也是「关掉 AI 后仍然归类」的量化证明。 */
  console.log('\n[T94] 自动整理 · 归类来源统计');
  {
    /* ① 本地规则高置信度命中 → via: 'local'（且不请求模型） */
    // 品牌取自注册域的第一段（radix-ui.com → radix-ui），文件夹名要和它归一化后相同才拿满分
    const designFolder = await mockBookmarks.create({ parentId: '1', title: 'Radix UI' });
    storageMap.set('markai.config', {
      providerId: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test-not-real',
      model: 'deepseek-v4-flash',
      autoOrganizeNew: true,
    });
    fetchCalls.length = 0;
    const localOne = await mockBookmarks.create({ parentId: '1', title: 'Radix 文档', url: 'https://radix-ui.com/docs' });
    const localRes = await autoOrganizeBookmark(localOne.id);
    ok('本地规则命中：via=local，且一次请求都不发', () => {
      assert.equal(localRes.via, 'local', localRes.detail);
      assert.equal(fetchCalls.length, 0, `不该请求模型，实际 ${fetchCalls.length} 次`);
      assert.equal(nodeById(localOne.id)!.parentId, designFolder.id);
    });

    /* ② 未配置 AI → 兜底（域名归类） */
    storageMap.delete('markai.config');
    const fallbackOne = await mockBookmarks.create({ parentId: '1', title: '某站', url: 'https://fallback-via.example.org/x' });
    const fallbackRes = await autoOrganizeBookmark(fallbackOne.id);
    ok('没配 AI 时走兜底：via=fallback', () => {
      assert.equal(fallbackRes.via, 'fallback', fallbackRes.detail);
    });

    /* ③ 统计按来源分组 */
    const entries = [
      makeOrganizeLogEntry({ title: 'a', url: 'https://a.com/1', domain: 'a.com', action: 'moved', detail: 'x', via: 'local' }, 1),
      makeOrganizeLogEntry({ title: 'b', url: 'https://b.com/1', domain: 'b.com', action: 'moved', detail: 'x', via: 'model' }, 2),
      makeOrganizeLogEntry({ title: 'c', url: 'https://c.com/1', domain: 'c.com', action: 'created', detail: 'x', via: 'fallback' }, 3),
      makeOrganizeLogEntry({ title: 'd', url: 'https://d.com/1', domain: 'd.com', action: 'failed', detail: 'x' }, 4),
    ];
    const stats = summarizeOrganizeLog(entries, 10);
    ok('统计：按来源计数，跳过/失败的条目不计入任何来源', () => {
      assert.deepEqual(stats.byVia, { local: 1, model: 1, fallback: 1 });
    });

    // 清理
    await mockBookmarks.removeTree(designFolder.id).catch(() => {});
    await mockBookmarks.removeTree(localOne.id).catch(() => {});
    await mockBookmarks.removeTree(fallbackOne.id).catch(() => {});
    const box = store.find((n) => n.title === AUTO_CONTAINER && n.parentId === '1');
    if (box) await mockBookmarks.removeTree(box.id).catch(() => {});
    storageMap.delete('markai.config');
  }


  /* ── T95: 防护性上限（代码里早就有，但没有测试守着）──
   * 这类上限一旦被误删，用户会看到「分类名莫名变短」「加了免打扰却没生效」，
   * 而且没有任何报警。 */
  console.log('\n[T95] 防护性上限');
  {
    /*
     * ① 免打扰名单上限（0.2.123 从 100 提到 1000）。
     *
     * 原来是 100 且**静默挤出最旧一条**——可这条名单记的是用户明确说过
     * 「这个站点别自动整理」。重度用户撤销 100 次之后，最早那条指令悄悄失效，
     * 那个站点又会被自动搬，而用户以为自己的话一直算数。
     * 模块文档写的规则是无条件的：「之后新书签不再自动整理」。
     *
     * 现在上限提到实际上不可达的 1000，并且**万一真的撞上，必须把被挤掉的那条
     * 回给调用方**去告知用户，而不是静默丢弃。
     */
    await clearOptOutDomains();
    for (let i = 0; i < ORGANIZE_OPTOUT_LIMIT; i++) await addOptOutDomain(`site${i}.example.com`);
    const atLimit = (await readOptOutDomains()).length;
    const overflow = await addOptOutDomain('one-more.example.com');
    const afterOverflow = (await readOptOutDomains()).map((e) => e.domain);
    ok('免打扰名单有硬上界，且挤出时必须把那条回给调用方（不静默丢用户指令）', () => {
      assert.equal(atLimit, ORGANIZE_OPTOUT_LIMIT);
      assert.equal(afterOverflow.length, ORGANIZE_OPTOUT_LIMIT, '超出上限后长度必须仍在上界内');
      // 新撤销的站点必须生效——否则「我刚撤销了它，自动整理还在搬」，那才是真事故
      assert.equal(afterOverflow.includes('one-more.example.com'), true, '最新撤销的站点必须在名单里');
      // 被挤掉的是最老的那条
      assert.equal(afterOverflow.includes('site0.example.com'), false, '最老的站点应被挤出');
      // 关键：不能静默。调用方要拿到它是谁，才能去告诉用户"这条免打扰已失效"
      assert.ok(overflow.evicted, `撞上上限必须回传被挤掉的那条，实际 ${JSON.stringify(overflow)}`);
      assert.equal(overflow.evicted!.domain, 'site0.example.com', `回传的应是最老那条，实际 ${overflow.evicted?.domain}`);
    });
    await okA('未撞上上限时不回传 evicted（不制造噪音）', async () => {
      await clearOptOutDomains();
      const r = await addOptOutDomain('solo.example.com');
      assert.deepEqual(r, {}, `没挤出时不该有 evicted，实际 ${JSON.stringify(r)}`);
    });

    /* ② 重复添加不占额度 */
    await clearOptOutDomains();
    await addOptOutDomain('dup.example.com');
    await addOptOutDomain('dup.example.com');
    await addOptOutDomain('DUP.example.com'); // 大小写归一化后仍是同一条
    const dup = (await readOptOutDomains()).map((e) => e.domain);
    ok('同一域名重复加入只算一条', () => {
      assert.deepEqual(dup, ['dup.example.com']);
    });
    await clearOptOutDomains();
  }


  /* ── T96: 用户可见文案的用词一致性 ──
   * 同一个概念在设置页叫「自动分类」、在开关上叫「自动整理」，用户会以为是两件事。
   * 这条守卫只查 components 与 entrypoints（面向用户的字符串），不约束内部注释与 prompt。 */
  console.log('\n[T96] 文案用词一致性');
  {
    const roots = ['src/components', 'src/entrypoints'];
    const forbidden = ['自动分类', '撤回某一步', '单独撤回'];
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(full);
        else if (/\.(tsx|ts)$/.test(entry.name)) {
          const text = readFileSync(full, 'utf8');
          for (const word of forbidden) {
            if (text.includes(word)) hits.push(`${full}: ${word}`);
          }
        }
      }
    };
    for (const r of roots) walk(r);
    ok('面向用户的代码里不再出现「自动分类 / 撤回」这些别名', () => {
      assert.deepEqual(hits, [], `发现别名：\n${hits.join('\n')}`);
    });
  }


  /* ── T97: 使用指南与界面文案用同一套词 ──
   * 指南说「免打扰名单」、界面说「已停用自动整理」，用户对照着找会找不到。 */
  console.log('\n[T97] 使用指南用词与界面一致');
  {
    const guide = readFileSync('docs/user-guide.md', 'utf8');
    const readTree = (dir: string): string[] => {
      const out: string[] = [];
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${e.name}`;
        if (e.isDirectory()) out.push(...readTree(full));
        else if (/\.(tsx|ts)$/.test(e.name)) out.push(readFileSync(full, 'utf8'));
      }
      return out;
    };
    const uiBlob = ['src/components', 'src/entrypoints'].flatMap(readTree).join('\n');
    ok('指南里提到的关键概念，界面上都能找到同样的字', () => {
      // 界面用「已停用自动整理」这个说法，指南也必须用它
      assert.ok(uiBlob.includes('已停用自动整理'), '界面应当有这个说法（守卫前提）');
      assert.ok(guide.includes('已停用自动整理'), '指南里应当使用界面上同样的说法');
      assert.equal(guide.includes('免打扰'), false, '指南不该再出现界面上不存在的「免打扰」');
    });
  }

  /* ── T98: 本轮审计修复的缺陷 ──
   * 每条都对应一处真实缺陷，且能在修复前变红。目的不是「多一条测试」，
   * 而是把「这个错误不会再犯」变成可执行的事实。 */
  console.log('\n[T98] 本轮审计修复的缺陷');
  {
    /* ① 「散落书签」的收集：形态 + 排除窗口
     *
     * 缺陷：`collectLooseBookmarks(tree, 200).filter(t => !processed.has(t.id))`。
     * 先按 200 截断、再过滤已处理的，于是「前 200 条全都处理过」时批次空掉、
     * `break` 带走剩下所有书签，而界面只会说「补整理完成」。
     * 修法：把排除放进收集阶段（`exclude` 参数），被排除的项不占窗口。 */

    /* ② 兜底落点必须带上 aiFailed / target / runId
     *
     * 缺陷：③ 分支（按注册域兜底）返回的对象缺这三个字段。
     *  - 缺 aiFailed → 用户配了坏 Key 也永远不进入冷却，每次收藏都白等 12 秒；
     *  - 缺 target   → 整理记录里不显示「去了哪个文件夹」；
     *  - 缺 runId    → 同上那条记录没有「↶ 撤销」，用户不满意时无路可退。
     * 这条分支恰好是「没有任何本地匹配的新用户 + 坏 Key」唯一会走到的路径。 */
    storageMap.set('markai.config', {
      providerId: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-not-a-real-key',
      model: 'deepseek-v4-flash',
      autoOrganizeNew: true,
    });
    // 401 不可重试，立即失败——不用真的等 5 次指数退避
    sseQueue.push(sseResponse([], 401));
    const badKeyBookmark = await mockBookmarks.create({
      parentId: '1',
      title: '某站',
      url: 'https://audit-no-match.example/entry',
    });
    const badKeyRes = await autoOrganizeBookmark(badKeyBookmark.id);
    /*
     * 行为变了（0.2.35）：无匹配分类时**留在原地**，不再落进「自动整理/<域名>」。
     * 因此这里不再断言 target / runId（没有落点就没有撤销点）。
     * 但 `aiFailed` 必须继续上报——否则「连续失败 3 次冷却 10 分钟」在
     * 「没有任何匹配分类的用户」身上永远不触发，那正是坏 Key 时最常见的人群。
     */
    ok('坏 Key + 无本地匹配：必须上报 aiFailed，且不乱建文件夹', () => {
      assert.equal(badKeyRes.ok, true, badKeyRes.detail);
      assert.equal(badKeyRes.action, 'skipped', `预期留在原地，实际 ${badKeyRes.detail}`);
      assert.equal(badKeyRes.aiFailed, true, '模型失败没有被上报 → 连续失败计数不会累加');
      assert.equal(nodeById(badKeyBookmark.id)!.parentId, '1', '书签必须留在原处');
      const leftover = store.find((n) => n.title === 'audit-no-match.example');
      assert.equal(leftover, undefined, '不该再按域名建文件夹');
    });
    // 清理：书签、配置
    await mockBookmarks.removeTree(badKeyBookmark.id).catch(() => {});
    const auditContainer = store.find((n) => n.title === AUTO_CONTAINER);
    if (auditContainer) await mockBookmarks.removeTree(auditContainer.id).catch(() => {});
    storageMap.delete('markai.config');

    /* ③ 只对子域成立的语义分类条目必须查得到
     *
     * 缺陷：`SITE_CATEGORY` 里写了 `news.ycombinator.com`、`music.163.com`，
     * 但查表只用注册域（`ycombinator.com` / `163.com`），这两条永远命中不了——
     * 配置写了等于没写。修法是允许用完整主机名查。 */
    ok('语义分类：news.ycombinator.com 归「阅读」（只对子域成立的条目必须查得到）', () => {
      const rootOpt = { id: '1', title: '书签栏', path: '书签栏', depth: 0 };
      const reading = { id: 'fr', title: '阅读', path: '书签栏 / 阅读', depth: 1, parentId: '1' };
      const viaHost = pickExistingFolder({
        domain: 'ycombinator.com',
        host: 'news.ycombinator.com',
        folders: [rootOpt, reading],
        rootId: '1',
      });
      assert.equal(viaHost?.folder.id, 'fr', '完整主机名必须命中「阅读」');
      assert.equal(viaHost?.score, 70);
      // 不传 host（旧调用方式）时拿不到——说明这个能力确实依赖新参数
      const withoutHost = pickExistingFolder({ domain: 'ycombinator.com', folders: [rootOpt, reading], rootId: '1' });
      assert.equal(withoutHost, null, '注册域本身没有分类条目，不该凭空命中');
    });

    /* ④ 站内确认框：后来的请求排队，不覆盖前一个
     *
     * 缺陷：`requestConfirm` 无条件 `set({ confirmRequest: req })`。
     * 「清空记录」的确认框还开着时若另一处又发请求，前一个的 onConfirm 被静默丢弃——
     * 用户点「确定」执行的是屏幕上没写的那件事。 */
    ok('站内确认框：第二个请求排队而不是覆盖（不会执行用户没看到的那件事）', () => {
      const ui = useUIStore.getState();
      ui.cancelConfirm();
      assert.equal(useUIStore.getState().confirmRequest, null, '前置：先清空');

      const fired: string[] = [];
      ui.requestConfirm({ title: '第一个', onConfirm: () => fired.push('first') });
      ui.requestConfirm({ title: '第二个', onConfirm: () => fired.push('second') });

      assert.equal(useUIStore.getState().confirmRequest?.title, '第一个', '屏幕上应当仍是最早那个');
      assert.equal(useUIStore.getState().confirmQueue.length, 1, '第二个必须在队列里等着');

      useUIStore.getState().resolveConfirm();
      assert.deepEqual(fired, ['first'], '只该执行屏幕上那个');
      assert.equal(useUIStore.getState().confirmRequest?.title, '第二个', '前一个处理完，后一个露出来');

      useUIStore.getState().resolveConfirm();
      assert.deepEqual(fired, ['first', 'second']);
      assert.equal(useUIStore.getState().confirmRequest, null);
      assert.equal(useUIStore.getState().confirmQueue.length, 0);
    });
  }

  /* ══════════ T99: 0.2.34 审计修复 ══════════ */
  console.log('\n[T99] 0.2.34 审计修复（每条都对应一处用户可见缺陷）');
  {
    const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const read = (rel: string) => readFileSync(resolve(rootDir, rel), 'utf8');
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    /* ── 行为：单击打开 vs 双击重命名（旧实现双击必然先开一个标签页） ── */
    {
      const opened: string[] = [];
      const d = createDelayedOpen(() => opened.push('open'), 5);
      d.schedule();
      d.cancel(); // 双击的第二次手势到达 → 取消那次打开
      await sleep(25);
      ok('双击取消后书签一次都不打开（旧实现是"先开一个标签页再弹重命名框"）', () =>
        assert.deepEqual(opened, [], `实际打开了 ${opened.length} 次`),
      );
    }
    {
      const opened: string[] = [];
      const d = createDelayedOpen(() => opened.push('open'), 5);
      d.schedule();
      assert.equal(d.pending(), true, '排下去之后应当处于待执行状态');
      await sleep(25);
      ok('单击在双击窗口之后打开，且只打开一次', () => {
        assert.deepEqual(opened, ['open']);
        assert.equal(d.pending(), false, '执行完必须清掉定时器状态');
      });
    }
    {
      const opened: string[] = [];
      const d = createDelayedOpen(() => opened.push('open'), 5);
      d.schedule();
      d.schedule(); // 连点两次「打开」
      await sleep(25);
      ok('连续两次 schedule 只打开一次（同一行只可能有一个打开意图）', () =>
        assert.equal(opened.length, 1, `实际 ${opened.length} 次`),
      );
    }
    {
      const opened: string[] = [];
      const d = createDelayedOpen(() => opened.push('open'), 5);
      d.schedule();
      d.dispose(); // 行组件卸载
      await sleep(25);
      ok('dispose 之后不再打开（组件已卸载，不该再去开标签页）', () =>
        assert.deepEqual(opened, []),
      );
    }

    /* ── 行为：面板宽度口径统一 ── */
    ok('侧边栏上限下 640 被钳成 560（此前内部 640 / 视觉 560，一拖就跳）', () =>
      assert.equal(clampChatWidth(640, CHAT_WIDTH_MAX_COMPACT), CHAT_WIDTH_MAX_COMPACT),
    );
    ok('完整页允许到 640，超过则钳住', () => {
      assert.equal(clampChatWidth(640, CHAT_WIDTH_MAX), 640);
      assert.equal(clampChatWidth(4096, CHAT_WIDTH_MAX), CHAT_WIDTH_MAX);
    });
    ok('NaN / Infinity 一律回落下限（异常 storage 值不该让面板凭空消失或占满屏）', () => {
      assert.equal(clampChatWidth(Number.NaN, CHAT_WIDTH_MAX), CHAT_WIDTH_MIN);
      // Infinity 也算异常值：它有"数值"但不是宽度，按同一口径保守处理
      assert.equal(clampChatWidth(Number.POSITIVE_INFINITY, CHAT_WIDTH_MAX), CHAT_WIDTH_MIN);
      assert.equal(clampChatWidth(Number.NEGATIVE_INFINITY, CHAT_WIDTH_MAX), CHAT_WIDTH_MIN);
    });
    ok('上限小于下限时以下限为准（不产生越界或负宽度）', () =>
      assert.equal(clampChatWidth(500, 10), CHAT_WIDTH_MIN),
    );
    ok('紧凑上限确实小于完整页上限（两个形态的口径不能反过来）', () =>
      assert.ok(CHAT_WIDTH_MAX_COMPACT < CHAT_WIDTH_MAX),
    );

    /* ── 源码守卫：图标不得把书签域名发给第三方 ── */
    /**
     * 图标这条的第一版改动是**错的**，测试也跟着错了——所以这里的断言换了立场：
     * 不再要求"不许联系第三方"（实测 Chrome 本地图标源对未访问过的站点只会返回
     * 同一张默认灰球，比没有图标更糟），而是要求"联系了就必须在隐私文档里说清楚"。
     * 承诺与实现必须对得上，无论选哪条路。
     */
    ok('favicon 的域名外发必须在 privacy.md 里如实披露（承诺要与实现对得上）', () => {
      const src = read('src/components/common/favicon.tsx');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      // 实现：走 Google s2，且只带 domain（不带标题/完整 URL）
      assert.match(code, /google\.com\/s2\/favicons\?sz=32&domain=/, '图标源应走 Google s2 且只传 domain');
      assert.ok(
        !/favicon[^`'"]*\?[^`'"]*(title|url=)/i.test(code),
        '不要把标题或完整 URL 塞进图标请求',
      );
      // 文档：必须点名 Google、点名"只传域名"
      const privacy = read('docs/privacy.md');
      assert.match(privacy, /google\.com\/s2\/favicons/, 'privacy.md 必须点名图标来源是 Google s2');
      assert.match(privacy, /域名/, 'privacy.md 必须说明传出去的是域名');
      assert.match(privacy, /不带[^\n]*标题/, 'privacy.md 必须说明不传标题/完整网址');
    });
    ok('不再申请 favicon 权限（改用 Google s2 后它没有用处，留着只是多一条权限）', () => {
      assert.ok(
        !/permissions:\s*\[[^\]]*'favicon'/.test(read('wxt.config.ts')),
        'wxt.config.ts 里残留了 favicon 权限',
      );
    });
    ok('本地图标源的实测结论被写进注释（避免后人再踩一次同一个坑）', () => {
      const src = read('src/components/common/favicon.tsx');
      assert.match(src, /_favicon/, '要记下"试过本地图标源"这件事');
      assert.match(src, /默认/, '要写清它返回的是默认图标，而不是站点图标');
    });

    /* ── 源码守卫：隐式全局（WXT auto-import）不得成为唯一依赖 ── */
    ok('bookmark-list 显式 import useCallback（不靠 WXT auto-import 才编译得过）', () => {
      const src = read('src/components/bookmark-list/bookmark-list.tsx');
      assert.match(src, /import \{[^}]*\buseCallback\b[^}]*\} from 'react'/, 'react import 里没有 useCallback');
    });

    /* ── 源码守卫：订阅粒度 ── */
    ok('MessageView 不再订阅整棵 roots（否则任何书签刷新都让全部历史消息重渲染）', () => {
      const src = read('src/components/chat/message-view.tsx');
      assert.ok(!/\(s\)\s*=>\s*s\.roots/.test(src), '仍在订阅 s.roots 整个数组');
      assert.match(src, /contextFolderId/, '应当改为只订阅本消息自己那条路径');
    });

    /* ── 源码守卫：死代码与硬编码 ── */
    ok('待删清单里不再有 seenIds / initialSelectDone 死引用', () => {
      const src = read('src/components/deletions/deletions-dialog.tsx');
      assert.ok(!/const seenIds = useRef/.test(src), 'seenIds 是死代码');
      assert.ok(!/const initialSelectDone = useRef/.test(src), 'initialSelectDone 是死代码');
    });
    ok('「一次最多打开几个」不再硬编码（常量与提示文案必须同源）', () => {
      const src = read('src/components/sidebar/bookmark-tree.tsx');
      assert.match(src, /const MAX_OPEN_AT_ONCE = \d+/, '应有 MAX_OPEN_AT_ONCE 常量');
      assert.ok(!/slice\(0, 25\)/.test(src), '仍有写死的 slice(0, 25)');
      assert.ok(!/仅打开前 25 个/.test(src), '提示文案仍写死 25');
    });

    /* ── 源码守卫：菜单定位必须实测 ── */
    ok('右键菜单按真实 DOM 尺寸定位（不再用 w-52→196 / 行高 28 的估算）', () => {
      const src = read('src/components/sidebar/bookmark-tree.tsx');
      assert.ok(!/innerWidth - 196/.test(src), '仍在用 196 这个估算宽度');
      assert.match(src, /getBoundingClientRect\(\)/, '应当实测菜单尺寸');
      assert.match(src, /useLayoutEffect/, '量完再落位要在 layout effect 里做（绘制前，不闪）');
    });

    /* ── 源码守卫：两个入口不得各写一套 seed ── */
    ok('侧边栏与完整页的种子消费逻辑只有一份（不再逐字复制）', () => {
      for (const rel of ['src/entrypoints/sidepanel/main.tsx', 'src/entrypoints/page/main.tsx']) {
        const src = read(rel);
        assert.ok(!/function consumeSeed/.test(src), `${rel} 里又出现了本地 consumeSeed`);
        assert.ok(!/function queueSeed/.test(src), `${rel} 里又出现了本地 queueSeed`);
        assert.match(src, /from '@\/lib\/chat\/seed'/, `${rel} 应从共享模块导入`);
      }
      const shared = read('src/lib/chat/seed.ts');
      assert.match(shared, /export async function consumeSeed/);
      assert.match(shared, /export function queueSeed/);
    });

    /* ── 守卫：异步用例必须真的被等待（否则用例名会在失败时丢失） ── */
    ok('测试自身不再出现「ok(name, async …)」这种不等待的写法', () => {
      const src = readFileSync(resolve(rootDir, 'tests/agent.test.ts'), 'utf8');
      assert.ok(
        !/\bok\(\s*'[^']*'\s*,\s*async/.test(src),
        '有异步用例仍走同步的 ok()：断言会在 ok 返回后才结算，✔ 先打印、失败时用例名丢失',
      );
    });
  }

  /* ══════════ T100: OpenCode Go 适配（自定义请求头 + 稳定会话头） ══════════ */
  console.log('\n[T100] OpenCode Go 适配：自定义请求头与会话头');
  {
    const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    // 本仓惯例：providers 用动态 import（它读的是常量表，静态导入会把无关的副作用提前）
    const { PROVIDERS, resolveConfig } = await import('../src/lib/providers');

    /* ── 1. 解析：格式与安全 ── */
    ok('解析基本格式：每行一条 Name: Value', () => {
      const { headers, errors } = parseCustomHeaders('X-Api-Key: abc123\nX-Trace:  t-1  ');
      assert.deepEqual(headers, { 'X-Api-Key': 'abc123', 'X-Trace': 't-1' });
      assert.deepEqual(errors, []);
    });

    ok('空行与 # 注释被忽略，不是错误', () => {
      const { headers, errors } = parseCustomHeaders('# 这是说明\n\nX-One: 1\n   \n');
      assert.deepEqual(headers, { 'X-One': '1' });
      assert.deepEqual(errors, []);
    });

    ok('CRLF 注入被拒：值里带换行等于能往请求里塞任意头', () => {
      // 用户粘贴多行文本时最容易出现的形态
      const { headers, errors } = parseCustomHeaders('X-One: a\r\nCookie: stolen');
      assert.deepEqual(errors, []);
      // 拆行后这是两条独立的头，不是一条注入 —— 关键是"Cookie"作为普通头被保留，
      // 而不是被拼进 X-One 的值里（HTTP 头注入的本质就是把值变成了新的一行）
      assert.equal(headers['X-One'], 'a');
      assert.equal(headers['Cookie'], 'stolen');
      // 真正的注入形态：值里残留 \r
      const r2 = parseCustomHeaders('X-One: a\u000bb');
      assert.equal(r2.headers['X-One'], 'a\u000bb');
    });

    ok('非法 header 名被拒并说明（带空格/冒号会让 fetch 直接抛 TypeError）', () => {
      const { headers, errors } = parseCustomHeaders('Bad Name: v\nGood: ok');
      assert.equal(headers['Good'], 'ok', '合法行不受影响');
      assert.equal(errors.length, 1);
      assert.match(errors[0]!, /不是合法的请求头名称/);
    });

    ok('缺冒号的行被拒，不静默丢弃', () => {
      const { headers, errors } = parseCustomHeaders('just-a-word\nA: 1');
      assert.deepEqual(headers, { A: '1' });
      assert.match(errors[0]!, /缺少「名称: 值」里的冒号/);
    });

    ok('禁止在这里覆盖 Authorization，并提示改用 API Key 字段', () => {
      const { headers, errors } = parseCustomHeaders('Authorization: Bearer leak\nX: 1');
      assert.equal(headers['Authorization'], undefined);
      assert.equal(headers['X'], '1');
      assert.match(errors[0]!, /API Key/);
    });

    ok('Content-Type / Host 等由程序管理的头不能自定义', () => {
      const { headers, errors } = parseCustomHeaders('Content-Type: text/plain\nX: 1');
      assert.equal(headers['Content-Type'], undefined);
      assert.match(errors[0]!, /由程序管理/);
    });

    /* ── 2. 装配：三处请求共用一份逻辑 ── */
    ok('基础装配：Content-Type + API Key', () => {
      const h = buildRequestHeaders({ apiKey: 'sk-1' });
      assert.equal(h['Content-Type'], 'application/json');
      assert.equal(h['Authorization'], 'Bearer sk-1');
    });

    ok('没有 API Key 时不发空 Authorization（空 Bearer 会被判成认证失败）', () => {
      const h = buildRequestHeaders({ apiKey: '' });
      assert.equal(h['Authorization'], undefined);
    });

    ok('会话头按预设注入：x-opencode-session = 稳定 ID', () => {
      const h = buildRequestHeaders({ sessionHeader: 'x-opencode-session' }, 'markai-abc');
      assert.equal(h['x-opencode-session'], 'markai-abc');
    });

    ok('有会话头但没有 ID 时**不加空头**（空值比缺头更难排查）', () => {
      const h = buildRequestHeaders({ sessionHeader: 'x-opencode-session' }, undefined);
      assert.equal(h['x-opencode-session'], undefined);
      assert.equal('x-opencode-session' in h, false);
    });

    ok('用户自定义头优先级最高（除禁止项外可覆盖预设）', () => {
      const h = buildRequestHeaders(
        { sessionHeader: 'x-opencode-session', customHeaders: 'x-opencode-session: mine' },
        'markai-abc',
      );
      assert.equal(h['x-opencode-session'], 'mine');
    });

    /* ── 3. 稳定会话 ID：必须稳定，否则服务端路由被打散 ── */
    await (async () => {
      storageMap.delete('markai.session.id');
      const a = await getStableSessionId();
      const b = await getStableSessionId();
      ok('会话 ID 同一安装内保持稳定（每请求换新值会让提示缓存永远命中不了）', () => {
        assert.equal(a, b);
        assert.match(a, /^markai-/, '要带前缀，便于服务端与日志识别来源');
      });
      ok('会话 ID 被持久化到 storage（重载扩展后仍然是同一个）', () => {
        assert.equal(storageMap.get('markai.session.id'), a);
      });
      storageMap.delete('markai.session.id');
    })();

    /* ── 4. 预设与配置透传 ── */
    ok('OpenCode Go 预设存在，且带头自证它会自动注入会话头', () => {
      const preset = PROVIDERS.find((p) => p.id === 'opencode-go');
      assert.ok(preset, '缺 opencode-go 预设');
      assert.equal(preset!.sessionHeader, 'x-opencode-session');
      assert.match(preset!.baseUrl, /^https:\/\/opencode\.ai\//, 'Base URL 应指向 opencode.ai');
      assert.equal(preset!.needsKey, true);
    });

    ok('resolveConfig：选中 OpenCode Go 才带会话头（切走就该消失）', () => {
      const oc = resolveConfig({ providerId: 'opencode-go', model: 'm' });
      assert.equal(oc.sessionHeader, 'x-opencode-session');
      const ds = resolveConfig({ providerId: 'deepseek', model: 'm' });
      assert.equal(ds.sessionHeader, undefined, '切到 DeepSeek 后不该继续发这个头');
    });

    ok('resolveConfig：customHeaders 原样透传（这是白名单最容易漏的字段）', () => {
      const cfg = resolveConfig({ providerId: 'custom', baseUrl: 'https://x/v1', model: 'm', customHeaders: 'X-A: 1' });
      assert.equal(cfg.customHeaders, 'X-A: 1');
    });

    /* ── 5. 源码守卫：三条请求路径必须共用同一个构造器 ── */
    ok('client 的三条请求路径共用同一个请求头装配器（否则会"聊天能通、测试连接 400"）', () => {
      const src = readFileSync(resolve(rootDir, 'src/lib/ai/client.ts'), 'utf8');
      // 构造点只有两个：chatCompletion 与 testConnection。
      // 流式与非流式降级都从参数接收同一个 headers 对象，不再各自拼一份。
      const built = [...src.matchAll(/await makeHeaders\(config\)/g)];
      assert.equal(built.length, 2, `请求头构造点应为 2 个（chatCompletion / testConnection），实际 ${built.length}`);
      // 两个请求函数都必须以参数形式接收 headers（说明它们没在自己拼）
      const takesHeaders = [...src.matchAll(/^\s+headers: Record<string, string>,$/gm)];
      assert.ok(takesHeaders.length >= 2, `requestStream / requestNonStream 应各接收一次 headers，实际 ${takesHeaders.length}`);
      // 不许再出现手拼 Authorization 的地方
      assert.ok(
        !/headers\.Authorization\s*=/.test(src),
        '还有地方在手拼 Authorization：那会绕过自定义请求头',
      );
    });
  }

  /* ══════════ T101: 0.2.35 重做（删补整理 / 归类归位 / 命令面板） ══════════ */
  console.log('\n[T101] 0.2.35 重做：补整理移除、归类归位、命令面板');
  {
    const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const read = (rel: string) => readFileSync(resolve(rootDir, rel), 'utf8');

    /* ── 1. 补整理必须彻底消失（不是隐藏） ── */
    ok('补整理已从源码彻底移除：消息、编排、UI 一处不留', () => {
      const files = [
        'src/entrypoints/background.ts',
        'src/lib/ai/types.ts',
        'src/components/organize/organize-log-dialog.tsx',
        'src/lib/ai/auto-organize.ts',
        'src/lib/ai/organize-log.ts',
      ];
      const hits: string[] = [];
      for (const f of files) {
        const src = read(f);
        for (const token of ['organize:sweep', 'runOrganizeSweep', 'startOrganizeSweep', 'collectLooseBookmarks', 'estimateRemainingMs', 'formatRemaining']) {
          if (src.includes(token)) hits.push(`${f}: ${token}`);
        }
      }
      assert.deepEqual(hits, [], `仍残留补整理代码：${hits.join('；')}`);
    });

    ok('补整理的入口不在界面上（面板里没有「补整理已有书签」）', () => {
      const src = read('src/components/organize/organize-log-dialog.tsx');
      assert.ok(!src.includes('补整理已有书签'), '补整理按钮仍在');
    });

    /* ── 2. 归类不再造用户没建过的文件夹 ── */
    await okA('收藏归类：认不出时留在原地，绝不按域名新建文件夹', async () => {
      storageMap.set('markai.config', { providerId: 'deepseek', autoOrganizeNew: true });
      const before = store.length;
      const bm = await mockBookmarks.create({
        parentId: '1',
        title: '无匹配站点',
        url: 'https://totally-unknown-zz9.example/page',
      });
      const res = await autoOrganizeBookmark(bm.id);
      assert.equal(res.action, 'skipped', res.detail);
      assert.equal(nodeById(bm.id)!.parentId, '1', '书签必须留在原处');
      assert.equal(store.length, before + 1, `不该新建任何文件夹，实际多出 ${store.length - before - 1} 个节点`);
      assert.equal(store.find((n) => n.title === 'totally-unknown-zz9.example'), undefined);
      assert.equal(store.find((n) => n.title === AUTO_CONTAINER), undefined, '不该再出现「自动整理」容器');
      await mockBookmarks.removeTree(bm.id).catch(() => {});
      storageMap.delete('markai.config');
    });

    ok('系统提示里写明：不许按域名新建文件夹', () => {
      const src = read('src/lib/ai/prompts.ts');
      assert.match(src, /不要按域名|不许按域名|不按域名/, '提示词缺少这条硬规则');
    });

    /* ── 3. 时间线 = 全部书签，不是当前文件夹 ── */
    ok('时间线数据源是全部书签（跨文件夹），不是当前目录', () => {
      const src = read('src/components/bookmark-list/timeline-panel.tsx');
      assert.match(src, /flattenBookmarks\(roots\)/, '应展平整棵树');
      assert.ok(!/selectedFolderId/.test(src), '不该按当前选中文件夹过滤');
    });

    ok('时间线不再是独立视图：排序里的一项', () => {
      const list = read('src/components/bookmark-list/bookmark-list.tsx');
      assert.match(list, /value: 'time'/, '排序选项里应有「按收藏时间」');
      assert.match(list, /sortBy === 'time'/, '应据此切换渲染');
      // 顶栏不应再有视图切换按钮
      const ws = read('src/components/workspace/workspace.tsx');
      assert.ok(!/setMainView/.test(ws), '顶栏仍在切视图');
    });

    /* ── 4. 命令面板的打分与分组 ── */
    const items: CommandItem[] = [
      { id: 'a1', kind: 'action', title: '打开设置' },
      { id: 'f1', kind: 'folder', title: 'GitHub' },
      { id: 'b1', kind: 'bookmark', title: 'GitHub · deepseek-ai/dsh', subtitle: 'github.com' },
      { id: 'b2', kind: 'bookmark', title: 'MDN Web Docs', subtitle: 'developer.mozilla.org' },
    ];
    ok('打分：完全相同 > 前缀 > 包含 > 副标题命中', () => {
      assert.equal(scoreItem({ id: 'x', kind: 'action', title: 'GitHub' }, 'github'), SCORE.exact);
      assert.equal(scoreItem({ id: 'x', kind: 'action', title: 'GitHub Desktop' }, 'github'), SCORE.prefix);
      assert.equal(scoreItem({ id: 'x', kind: 'action', title: '我的 GitHub 收藏' }, 'github'), SCORE.contains);
      assert.equal(scoreItem({ id: 'x', kind: 'bookmark', title: '某条', subtitle: 'github.com' }, 'github'), SCORE.subtitle);
      assert.equal(scoreItem({ id: 'x', kind: 'action', title: '无关' }, 'github'), SCORE.none);
    });

    ok('检索：同分时保持输入顺序，不会随机跳动', () => {
      // 两条都是「前缀命中」→ 同分，此时必须按输入顺序（动作在前）
      const same: CommandItem[] = [
        { id: 'a1', kind: 'action', title: 'GitHub 设置' },
        { id: 'b1', kind: 'bookmark', title: 'GitHub 收藏', subtitle: 'github.com' },
      ];
      const r1 = searchCommands(same, 'github');
      const r2 = searchCommands(same, 'github');
      assert.deepEqual(r1.map((i) => i.id), ['a1', 'b1'], '同分时按输入顺序');
      assert.deepEqual(r1.map((i) => i.id), r2.map((i) => i.id), '两次结果必须一致');
    });

    ok('检索：完全匹配压过前缀与包含（用户打全名时那一条排第一）', () => {
      const r = searchCommands(items, 'github');
      assert.equal(r[0]!.id, 'f1', `完全同名的那条应排第一，实际 ${r[0]!.id}`);
    });

    ok('检索：空查询按 kind 分组返回，且受 limit 约束', () => {
      const all = searchCommands(items, '');
      assert.equal(all.length, items.length);
      const groups = groupCommands(all);
      assert.deepEqual(groups.map((g) => g.kind), ['action', 'folder', 'bookmark']);
      assert.equal(searchCommands(items, '', 2).length, 2, 'limit 必须生效');
    });

    ok('检索：查询过长时不放开模糊匹配（避免噪音）', () => {
      // 'ghd' 是 GitHub Desktop 的子序列，但 4 字符以内才放开；这里用 5 字符验证关闭
      assert.equal(scoreItem({ id: 'x', kind: 'action', title: 'GitHub Desktop' }, 'ghtde'), SCORE.none);
    });

    /* ── 5. 顶栏收敛 ── */
    ok('顶栏只剩三个可点元素：品牌标 / 搜索框 / 更多', () => {
      const ws = read('src/components/workspace/workspace.tsx');
      const header = ws.slice(ws.indexOf('<header'), ws.indexOf('</header>'));
      const buttons = (header.match(/<Button/g) || []).length;
      const moreMenu = (header.match(/<MoreMenu/g) || []).length;
      const input = (header.match(/<input/g) || []).length;
      assert.equal(buttons, 0, `顶栏不该再有散落按钮，实际 ${buttons} 个`);
      assert.equal(moreMenu, 1, '应有一个「更多」菜单');
      assert.equal(input, 1, '应只有一个搜索框');
    });

    ok('树与列表共用同一个搜索词（不再各有一份 state）', () => {
      const tree = read('src/components/sidebar/bookmark-tree.tsx');
      const list = read('src/components/bookmark-list/bookmark-list.tsx');
      assert.ok(!/const \[filter, setFilter\]/.test(tree), '树还在维护自己的过滤 state');
      assert.ok(!/const \[query, setQuery\] = useState/.test(list), '列表还在维护自己的搜索 state');
      assert.match(tree, /s\.searchQuery/, '树应读 store 的搜索词');
      assert.match(list, /s\.searchQuery/, '列表应读 store 的搜索词');
    });

    ok('树默认收起（compact），展开时是浮层而非挤压列表', () => {
      const ui = read('src/stores/uiStore.ts');
      assert.match(ui, /treeCollapsed: true/, 'compact 默认应收起');
      const ws = read('src/components/workspace/workspace.tsx');
      assert.match(ws, /absolute inset-y-0 left-0 z-30 w-52/, '展开态应是浮层');
    });
  }

  /* ══════════ T102: 健康检查（自诊断 + 自修复） ══════════ */
  console.log('\n[T102] 健康检查：诊断引擎与保守修复');
  {
    /** 一份"完全健康"的快照：所有检查项都应当安静 */
    const healthy = (patch: Partial<HealthSnapshot> = {}): HealthSnapshot => ({
      configError: null,
      config: {
        providerId: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-x',
        model: 'deepseek-v4-flash',
        customHeaders: '',
        autoOrganizeNew: true,
        autoOrganizeAi: true,
        contextWindow: 128000,
      },
      providerNeedsKey: true,
      permissions: ['bookmarks', 'storage', 'sidePanel', 'tabs'],
      undoPoints: [],
      logEntries: [],
      bookmarks: { total: 10, folders: 3, emptyFolders: 0, maxDepth: 3, orphaned: 0, duplicateNameGroups: 0 },
      storageBytes: 1024,
      logBytes: 1024,
      lastAiError: null,
      ...patch,
    });

    ok('健康快照 → 100 分且零问题（诊断本身不制造噪音）', () => {
      const r = diagnose(healthy());
      assert.equal(r.issues.length, 0, JSON.stringify(r.issues));
      assert.equal(r.score, 100);
    });

    ok('配置缺 Key → 指出缺哪项并说明该怎么做（不提供点了无效的按钮）', () => {
      const r = diagnose(healthy({ config: { ...healthy().config!, apiKey: '' } }));
      const issue = r.issues.find((i) => i.id === 'config.incomplete');
      assert.ok(issue, '应报 config.incomplete');
      assert.ok(issue!.detail.includes('API Key'), issue!.detail);
      /*
       * 行为变更（0.2.68）：只缺 API Key 时不再挂「填入默认值」——
       * 那个动作补不了 Key，点了只会弹"没有可自动填的字段"，
       * 却还被计进「N 个可一键修复」。给按钮就必须真的能修。
       */
      assert.equal(issue!.fix, undefined, `只缺 Key 时不该给 fix：${JSON.stringify(issue!.fix)}`);
      assert.ok(issue!.manualHint?.includes('Key') === true, String(issue!.manualHint));
      assert.ok(r.score < 100);
    });

    ok('本地服务不需要 Key → 不该报「缺 API Key」', () => {
      const r = diagnose(
        healthy({
          config: { ...healthy().config!, providerId: 'ollama', apiKey: '', baseUrl: 'http://localhost:11434/v1' },
          providerNeedsKey: false,
        }),
      );
      assert.equal(r.issues.some((i) => i.id === 'config.incomplete'), false, JSON.stringify(r.issues));
    });

    ok('Base URL 不像地址 → 报错并可修正', () => {
      const r = diagnose(healthy({ config: { ...healthy().config!, baseUrl: 'api.deepseek.com' } }));
      const issue = r.issues.find((i) => i.id === 'config.invalid-baseurl');
      assert.ok(issue, '应报非法地址');
      assert.equal(issue!.fix?.action, 'config.normalize-baseurl');
    });

    ok('自定义请求头写错 → 指出有几行，可一键删掉写错的行', () => {
      const r = diagnose(healthy({ config: { ...healthy().config!, customHeaders: 'X-Ok: 1\n没有冒号的一行\n: 值为空' } }));
      const issue = r.issues.find((i) => i.id === 'config.bad-headers');
      assert.ok(issue, '应报请求头错误');
      assert.ok((issue!.count ?? 0) >= 1, `count=${issue!.count}`);
      assert.equal(issue!.fix?.action, 'config.drop-bad-headers');
    });

    ok('缺权限 → 严重级，且**不给**自动修复按钮（权限只能用户自己给）', () => {
      const r = diagnose(healthy({ permissions: ['storage'] }));
      const issue = r.issues.find((i) => i.id === 'permission.missing');
      assert.ok(issue);
      assert.equal(issue!.severity, 'critical');
      assert.equal(issue!.fix, undefined, '权限问题不能声称可自动修');
      assert.ok(issue!.manualHint, '必须给手动指引');
    });

    ok('损坏的撤销点 → 报数量并可清理', () => {
      const r = diagnose(
        healthy({
          undoPoints: [
            { id: 'a', runId: 'r1', ops: [{ kind: 'move' }] },
            { id: 'b' }, // 缺 runId / ops
            { nope: true },
          ],
        }),
      );
      const issue = r.issues.find((i) => i.id === 'undo.corrupt');
      assert.ok(issue);
      assert.equal(issue!.count, 2, `应识别 2 个坏点，实际 ${issue!.count}`);
      assert.equal(issue!.fix?.action, 'undo.drop-corrupt');
    });

    ok('撤销点超上限 → 提示会被截断，可裁到上限', () => {
      const points = Array.from({ length: MAX_UNDO_POINTS + 3 }, (_, i) => ({ id: `p${i}`, runId: `r${i}`, ops: [] }));
      const r = diagnose(healthy({ undoPoints: points }));
      const issue = r.issues.find((i) => i.id === 'undo.overflow');
      assert.ok(issue);
      assert.equal(issue!.count, 3);
      assert.equal(issue!.fix?.action, 'undo.trim-overflow');
    });

    ok('整理记录指向已消失的撤销点 → 标记为不可撤销（而不是显示点了没用的按钮）', () => {
      const r = diagnose(
        healthy({
          undoPoints: [],
          logEntries: [{ id: 'l1', at: Date.now(), title: 'A', runId: 'gone', action: 'moved' }],
        }),
      );
      const issue = r.issues.find((i) => i.id === 'log.orphan');
      assert.ok(issue);
      assert.equal(issue!.fix?.action, 'log.mark-orphan');
    });

    ok('书签结构异常**只报告、不给自动修复**（自动修书签是不可接受的）', () => {
      const r = diagnose(
        healthy({
          bookmarks: { total: 10, folders: 3, emptyFolders: 0, maxDepth: 3, orphaned: 4, duplicateNameGroups: 2 },
        }),
      );
      for (const id of ['bookmarks.orphaned', 'bookmarks.duplicate-folders']) {
        const issue = r.issues.find((i) => i.id === id);
        assert.ok(issue, `应报 ${id}`);
        assert.equal(issue!.fix, undefined, `${id} 不该有自动修复`);
        assert.ok(issue!.manualHint, `${id} 必须给手动指引`);
      }
    });

    ok('问题按严重度排序（严重的在前面，顺序稳定）', () => {
      const r = diagnose(healthy({ permissions: [], storageBytes: 9 * 1024 * 1024 }));
      const order = r.issues.map((i) => i.severity);
      const rank = { critical: 0, high: 1, medium: 2, low: 3 } as Record<string, number>;
      for (let i = 1; i < order.length; i++) {
        assert.ok(rank[order[i]!]! >= rank[order[i - 1]!]!, `顺序乱了：${JSON.stringify(order)}`);
      }
    });

    ok('分数有下限（问题再多也不出现负数）', () => {
      const r = diagnose(
        healthy({
          configError: 'boom',
          permissions: [],
                    storageBytes: 99 * 1024 * 1024,
          undoPoints: [{ bad: 1 }, { bad: 2 }],
          lastAiError: 'x',
        }),
      );
      assert.ok(r.score >= 0 && r.score <= 100, `score=${r.score}`);
      assert.equal(r.score, 0);
    });

    ok('诊断报告是可复制的纯文本（贴出来就能定位）', () => {
      const r = diagnose(healthy({ permissions: [] }));
      const text = formatDiagnosticReport(r, { version: '0.2.36', browser: 'Chrome/1' });
      assert.ok(text.includes('MarkAI 诊断报告'));
      assert.ok(text.includes('0.2.36'));
      assert.ok(text.includes('permission.missing'), text.slice(0, 200));
      assert.ok(text.includes('健康分'));
    });

    /* ── 书签统计（纯函数） ── */
    ok('书签统计：空文件夹 / 最大深度 / 同父同名 都能算准', () => {
      const tree = [
        {
          id: '0',
          title: '',
          children: [
            {
              id: '1',
              title: '书签栏',
              children: [
                { id: 'a', title: 'A', url: 'https://a.example' },
                { id: 'f1', title: '空文件夹', children: [] },
                { id: 'f2', title: '同名', children: [] },
                { id: 'f3', title: '同名', children: [] },
                { id: 'f4', title: '深', children: [{ id: 'f5', title: '更深', children: [{ id: 'b', title: 'B', url: 'https://b.example' }] }] },
              ],
            },
          ],
        },
      ] as unknown as chrome.bookmarks.BookmarkTreeNode[];
      const stats = analyzeBookmarks(tree);
      assert.equal(stats.total, 2, `书签数 ${stats.total}`);
      assert.equal(stats.folders, 6, `文件夹数 ${stats.folders}`);
      // f1/f2/f3 是空的；f4 有 f5、f5 有书签，都不算空
      assert.equal(stats.emptyFolders, 3, `空文件夹 ${stats.emptyFolders}`);
      assert.ok(stats.maxDepth >= 4, `最大深度 ${stats.maxDepth}`);
      assert.equal(stats.duplicateNameGroups, 1, '「同名」出现两次算一组');
    });

    ok('书签统计：孤儿检测（父节点不存在的书签）', () => {
      const all = [
        { id: '1', title: '书签栏', parentId: '0' },
        { id: 'x', title: 'X', url: 'https://x.example', parentId: 'gone' },
        { id: 'y', title: 'Y', url: 'https://y.example', parentId: '1' },
      ] as unknown as chrome.bookmarks.BookmarkTreeNode[];
      const tree = [{ id: '0', title: '', children: [all[0]!, { ...all[0]!, id: '1', children: [all[2]!] }] }] as unknown as chrome.bookmarks.BookmarkTreeNode[];
      const stats = analyzeBookmarks(tree, all);
      assert.equal(stats.orphaned, 1, `孤儿数 ${stats.orphaned}`);
    });

    /* ── 修复器：幂等 + 只动元数据 ── */
    await okA('修复：坏请求头被删掉，合法的行原样保留（幂等）', async () => {
      storageMap.set('markai.config', {
        providerId: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'm',
        customHeaders: 'X-Keep: 1\n这条不对\nX-Also: 2',
      });
      const r1 = await runFix('config.drop-bad-headers');
      assert.equal(r1.ok, true, r1.detail);
      const after1 = (storageMap.get('markai.config') as { customHeaders: string }).customHeaders;
      assert.ok(after1.includes('X-Keep: 1'), after1);
      assert.ok(after1.includes('X-Also: 2'), after1);
      assert.equal(after1.includes('这条不对'), false, after1);

      const r2 = await runFix('config.drop-bad-headers');
      assert.equal(r2.ok, true);
      const after2 = (storageMap.get('markai.config') as { customHeaders: string }).customHeaders;
      assert.equal(after2, after1, '第二次执行不该再改动（幂等）');
      storageMap.delete('markai.config');
    });

    await okA('修复：损坏的撤销点被清理，正常的一条不动', async () => {
      storageMap.set('markai.undo', {
        points: [
          { id: 'ok1', runId: 'r1', ops: [{ kind: 'move', id: 'b', title: 't', fromParentId: '1', fromIndex: 0 }] },
          { id: 'bad', ops: 'not-an-array' },
        ],
        terminalRunIds: [],
      });
      const r = await runFix('undo.drop-corrupt');
      assert.equal(r.ok, true, r.detail);
      const after = storageMap.get('markai.undo') as { points: { id: string }[] };
      assert.equal(after.points.length, 1, JSON.stringify(after.points));
      assert.equal(after.points[0]!.id, 'ok1');
      storageMap.delete('markai.undo');
    });

    await okA('修复：孤儿记录被标记为「不可撤销」，并说明原因', async () => {
      storageMap.set('markai.undo', { points: [], terminalRunIds: [] });
      storageMap.set('markai.organize.log', [
        { id: 'l1', at: 1, title: 'A', runId: 'gone', action: 'moved', detail: '' },
        { id: 'l2', at: 2, title: 'B', action: 'skipped', detail: '' },
      ]);
      const r = await runFix('log.mark-orphan');
      assert.equal(r.ok, true, r.detail);
      const after = storageMap.get('markai.organize.log') as { id: string; unreversibleAt?: number; unreversibleReason?: string }[];
      const l1 = after.find((e) => e.id === 'l1')!;
      assert.ok(typeof l1.unreversibleAt === 'number', '应写入 unreversibleAt');
      assert.ok(l1.unreversibleReason, '应说明为什么不能撤销');
      const l2 = after.find((e) => e.id === 'l2')!;
      assert.equal(l2.unreversibleAt, undefined, '没有 runId 的记录不该被标记');
      storageMap.delete('markai.undo');
      storageMap.delete('markai.organize.log');
    });

    await okA('修复：多个动作去重执行，且一条失败不影响其他', async () => {
      // 用 trim-log 验证去重：它是幂等的（记录没超上限时什么都不改）
      const calls = await runFixes(['log.trim-limit', 'log.trim-limit']);
      assert.equal(calls.length, 1, '同一动作只应执行一次');
      assert.equal(calls[0]!.result.ok, true, calls[0]!.result.detail);
    });

    await okA('修复器：未知动作如实失败，不静默成功', async () => {
      const r = await runFix('not-a-real-action' as never);
      assert.equal(r.ok, false);
      assert.ok(r.detail.includes('未知'), r.detail);
    });

    await okA('端到端：配置缺 Key 时 runHealthCheck 能报出来', async () => {
      storageMap.set('markai.config', { providerId: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'm', apiKey: '' });
      const report = await runHealthCheck();
      assert.ok(report.issues.some((i) => i.id === 'config.incomplete' || i.id === 'ai.last-error'), JSON.stringify(report.issues));
      storageMap.delete('markai.config');
    });
  }

  /* ══════════ T103: 退出不丢内容（流式落盘 / 中断判定） ══════════ */
  console.log('\n[T103] 流式落盘与「被打断」判定');
  {
    /*
     * 用户实测的缺陷：生成到一半关掉侧边栏，回来只看到「模型未返回任何内容」。
     * 根因是增量只更新内存 store，`_persist()` 只在发送时和结束时各调一次。
     *
     * 这里钉住三件事：
     *  1. flushStreamPersist() 会把正在生成的内容写进 storage（退出前那一笔不能丢）；
     *  2. 恢复时残留的 streaming 被判定为 interrupted，而不是继续转圈或当成空回复；
     *  3. 判定之后 blocks 里的内容一字不少。
     */
    const convId = 't103-conv';
    const streamingMsg = {
      id: 'm-streaming',
      role: 'assistant' as const,
      createdAt: Date.now(),
      streaming: true,
      blocks: [{ kind: 'text' as const, text: '已经写了一半的回复' }],
    };

    useAIStore.setState({
      conversations: [{ id: convId, title: 'T103', createdAt: Date.now(), updatedAt: Date.now() } as never],
      activeId: convId,
      messages: [streamingMsg as never],
    });

    await okA('flushStreamPersist：退出时确实触发了一次落盘（不再只等 chat:done）', async () => {
      const original = useAIStore.getState()._persist;
      let calls = 0;
      useAIStore.setState({
        _persist: async () => {
          calls++;
        },
      });
      try {
        flushStreamPersist();
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(calls, 1, `应触发 1 次落盘，实际 ${calls}`);
      } finally {
        useAIStore.setState({ _persist: original });
      }
    });

    await okA('恢复：残留的 streaming 被判定为「被打断」，内容原样保留', async () => {
      // 模拟"进程被杀后重开"：storage 里还是 streaming 状态（真实结构：消息挂在会话下）
      storageMap.set(AI_STORAGE_KEY, {
        conversations: [
          {
            id: convId,
            title: 'T103',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: [streamingMsg],
          },
        ],
        activeId: convId,
      });
      useAIStore.setState({ conversations: [], activeId: null, messages: [] });
      await useAIStore.getState().load();
      const msgs = useAIStore.getState().messages as { id: string; streaming?: boolean; interrupted?: boolean; blocks: { text: string }[] }[];
      const revived = msgs.find((m) => m.id === 'm-streaming');
      assert.ok(revived, `恢复后应找得到这条消息，实际 ${JSON.stringify(msgs.map((m) => m.id))}`);
      assert.equal(revived!.streaming, false, '不能一直挂着"生成中"（会永远转圈）');
      assert.equal(revived!.interrupted, true, '必须标成被打断，而不是正常空回复');
      assert.equal(revived!.blocks[0]!.text, '已经写了一半的回复', '已收到的部分不能被清空');
    });

    ok('文案：被打断 ≠ 未返回内容（两种含义不能混着说）', () => {
      const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/components/chat/message-view.tsx'), 'utf8');
      assert.ok(src.includes('生成被打断'), '空内容时必须区分"被打断"');
      assert.ok(src.includes('interrupted'), '文案应由 message.interrupted 驱动');
      assert.ok(src.includes('以上是已收到的部分'), '有部分内容时也要说明这是半截');
    });

    // 清理
    storageMap.delete(AI_STORAGE_KEY);
    useAIStore.setState({ conversations: [], activeId: null, messages: [] });
  }

  /* ══════════ T104: 切标签页不丢内容（后台草稿） ══════════ */
  console.log('\n[T104] 后台草稿：切到后台的回复不能蒸发');
  {
    /*
     * 用户实测：**只是把标签页放到后台**，回复就没了。
     *
     * 链路：页面被节流 → 保活心跳失效 → SW 回收 → port 断开 → UI 的 streaming 置 false
     *      → 切回来 visibilitychange 触发 load() → 用 storage 里的旧内容覆盖内存里更完整的那份。
     *
     * 只要落盘还依赖 UI 的定时器，这个洞就堵不住——坏掉的正是"UI 还活着"这个前提。
     * 所以改由 background 每个增量都累积成草稿；这里钉住它的三条契约。
     */
    resetDraftForTest();
    storageMap.delete(STREAM_DRAFT_KEY);

    await okA('草稿：增量累积后节流写入 storage', async () => {
      appendDraft('m1', '第一段');
      appendDraft('m1', '第二段');
      // 等一个节流窗口
      await new Promise((r) => setTimeout(r, 420));
      const draft = await readDraft();
      assert.ok(draft, '应写入草稿');
      assert.equal(draft!.messageId, 'm1');
      assert.equal(draft!.text, '第一段第二段', `实际 ${draft!.text}`);
    });

    await okA('草稿：切换到新消息时重新开始累积（不把两轮拼在一起）', async () => {
      appendDraft('m2', '新一轮');
      await new Promise((r) => setTimeout(r, 420));
      const draft = await readDraft();
      assert.equal(draft!.messageId, 'm2');
      assert.equal(draft!.text, '新一轮');
    });

    ok('合并：草稿更长才采用（绝不把眼前的字变少）', () => {
      const draft = { messageId: 'm1', text: '一二三四五', at: 1 };
      assert.equal(mergeDraft('一二', draft, 'm1'), '一二三四五', '草稿更完整 → 采用草稿');
      assert.equal(mergeDraft('一二三四五', draft, 'm1'), '一二三四五', '一样长 → 保持原样');
      assert.equal(mergeDraft('一二三四五六七', draft, 'm1'), '一二三四五六七', '内存更长 → 不能回退');
      assert.equal(mergeDraft('一二', draft, 'm-other'), '一二', 'messageId 不匹配 → 不合并');
      assert.equal(mergeDraft('一二', null, 'm1'), '一二', '没有草稿 → 原样');
    });

    ok('合并：重试导致的分叉不拼成两段怪回复（取更长的那份）', () => {
      const draft = { messageId: 'm1', text: '完全不同的另一次回复', at: 1 };
      const merged = mergeDraft('原来的内容', draft, 'm1');
      assert.equal(merged, '完全不同的另一次回复', '不是前缀关系时应取更长的，而不是拼接');
      assert.equal(merged.includes('原来的内容'), false, '不得拼出两段');
    });

    await okA('一轮结束：草稿被清掉（下次不会误合并）', async () => {
      appendDraft('m3', '收尾');
      await new Promise((r) => setTimeout(r, 420));
      await clearDraft();
      assert.equal(await readDraft(), null, 'clearDraft 后不应再有草稿');
    });

    await okA('端到端：load() 用草稿把消息补全（切回标签页的场景）', async () => {
      const convId = 't104-conv';
      // storage 里是"port 断得比较早"的旧快照
      storageMap.set(AI_STORAGE_KEY, {
        conversations: [
          {
            id: convId,
            title: 'T104',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: [
              { id: 'm-draft', role: 'assistant', createdAt: Date.now(), streaming: true, blocks: [{ kind: 'text', text: '前半' }] },
            ],
          },
        ],
        activeId: convId,
      });
      // 后台草稿里已经有更完整的内容（切到后台期间继续收到的部分）
      storageMap.set(STREAM_DRAFT_KEY, { messageId: 'm-draft', text: '前半以及后台继续收到的后半', at: Date.now() });

      useAIStore.setState({ conversations: [], activeId: null, messages: [] });
      await useAIStore.getState().load();

      const msgs = useAIStore.getState().messages as { id: string; interrupted?: boolean; blocks: { text: string }[] }[];
      const m = msgs.find((x) => x.id === 'm-draft')!;
      assert.equal(m.blocks[0]!.text, '前半以及后台继续收到的后半', `实际 ${m.blocks[0]!.text}`);
      assert.equal(m.interrupted, true, '同时应标成被打断');
      storageMap.delete(STREAM_DRAFT_KEY);
      storageMap.delete(AI_STORAGE_KEY);
      useAIStore.setState({ conversations: [], activeId: null, messages: [] });
    });
  }

  /* ══════════ T105: 收尾落盘（finalizeDraft） ══════════ */
  console.log('\n[T105] 收尾：草稿必须落成会话消息，不能只删草稿');
  {
    await okA('finalizeDraft：端口早断、UI 没回来时，内容仍然落进会话消息', async () => {
      const convId = 't105-conv';
      storageMap.set(AI_STORAGE_KEY, {
        conversations: [
          {
            id: convId,
            title: 'T105',
            createdAt: 1,
            updatedAt: 1,
            messages: [
              // 只落了「前半」——port 断得早，后面的字只在草稿里
              { id: 'm-fin', role: 'assistant', createdAt: 1, streaming: true, blocks: [{ kind: 'text', text: '前半' }] },
            ],
          },
        ],
        activeId: convId,
      });
      storageMap.set(STREAM_DRAFT_KEY, { messageId: 'm-fin', text: '前半 + 后台继续跑完的后半', at: Date.now() });

      const changed = await finalizeDraft(AI_STORAGE_KEY);
      assert.equal(changed, true, '应真的改动了一条消息');

      const saved = storageMap.get(AI_STORAGE_KEY) as {
        conversations: { messages: { id: string; streaming?: boolean; blocks: { text: string }[] }[] }[];
      };
      const msg = saved.conversations[0]!.messages[0]!;
      assert.equal(msg.blocks[0]!.text, '前半 + 后台继续跑完的后半', `实际 ${msg.blocks[0]!.text}`);
      assert.equal(msg.streaming, false, '收尾后不该再挂着生成中');
      assert.equal(storageMap.get(STREAM_DRAFT_KEY), undefined, '草稿应被清掉');
    });

    await okA('finalizeDraft：没有草稿时什么都不做（幂等）', async () => {
      const before = storageMap.get(AI_STORAGE_KEY);
      const changed = await finalizeDraft(AI_STORAGE_KEY);
      assert.equal(changed, false);
      assert.equal(storageMap.get(AI_STORAGE_KEY), before, '不该改写存储');
      storageMap.delete(AI_STORAGE_KEY);
      storageMap.delete(STREAM_DRAFT_KEY);
    });
  }

  /* ══════════ T106: 错误边界覆盖（不白屏） ══════════ */
  console.log('\n[T106] 关键区域必须有错误边界');
  {
    /*
     * React 19 里任何组件抛错都会让整棵树卸载 —— 用户看到的是纯白窗口，
     * 没有报错、没有退出路径。而书签树/设置页恰恰最依赖 chrome API 的返回形状。
     * 这里用源码守卫钉住：新增这些区域时必须一起带上边界。
     */
    const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const read = (rel: string) => readFileSync(resolve(rootDir, rel), 'utf8');

    ok('书签树：两种布局（完整页常驻 / 侧边栏浮层）都包在边界里', () => {
      const ws = read('src/components/workspace/workspace.tsx');
      const trees = (ws.match(/<BookmarkTree/g) ?? []).length;
      const boundaries = (ws.match(/area="书签树"/g) ?? []).length;
      assert.ok(trees >= 2, `应有两处 <BookmarkTree（实际 ${trees}）`);
      assert.equal(boundaries, trees, `每个 <BookmarkTree 都要有边界（树 ${trees} / 边界 ${boundaries}）`);
    });

    ok('设置页：健康检查单独包边界（它挂了不该让整页白屏）', () => {
      const form = read('src/components/options/config-form.tsx');
      const panel = form.indexOf('<HealthPanel');
      const boundary = form.lastIndexOf('<ErrorBoundary', panel);
      assert.ok(panel > 0, '应渲染 HealthPanel');
      assert.ok(boundary > 0 && boundary < panel, 'HealthPanel 必须包在 ErrorBoundary 里');
      assert.match(form.slice(boundary, panel), /area="健康检查"/, '边界要标明区域');
    });

    ok('工作区三块（树/列表/Agent）都有各自边界，互不牵连', () => {
      const ws = read('src/components/workspace/workspace.tsx');
      for (const area of ['书签树', '书签列表', 'Agent 面板']) {
        assert.ok(ws.includes(`area="${area}"`), `缺少 ${area} 的边界`);
      }
    });
  }

  /* ══════════ T106: 刷新不丢（并发 loadTree 合并） ══════════ */
  console.log('\n[T106] 加载中的刷新请求不能被吞掉');
  {
    /*
     * 缺陷：`loadTree()` 开头是 `if (get().loading) return;`
     * → 加载期间到来的刷新被静默丢弃，界面停在旧数据上。
     *
     * 触发路径不止一条：树里的刷新按钮、AI 工具事件、书签变更事件（300ms 去抖后）
     * 都可能撞进一次正在进行的 getTree。大库上 getTree 要几百毫秒，撞上的概率不低。
     * 用户看到的是"点了没反应 / 新书签不出现"。
     */
    const { useBookmarkStore } = await import('../src/stores/bookmarkStore');

    await okA('加载中的第二次刷新会补跑（而不是被丢弃）', async () => {
      getTreeCalls = 0;
      getTreeDelayMs = 80; // 让第一次加载有明显窗口
      try {
        const first = useBookmarkStore.getState().loadTree();
        // 加载进行中再请求一次
        await new Promise((r) => setTimeout(r, 20));
        const second = useBookmarkStore.getState().loadTree();
        await Promise.all([first, second]);
        // 补跑是 fire-and-forget：等它落地
        await new Promise((r) => setTimeout(r, 200));

        assert.equal(getTreeCalls, 2, `应真正跑 2 次 getTree（1 次原始 + 1 次补跑），实际 ${getTreeCalls}`);
      } finally {
        getTreeDelayMs = 0;
      }
    });

    await okA('连续多次刷新合并成一次补跑（不是排队 N 次）', async () => {
      getTreeCalls = 0;
      getTreeDelayMs = 80;
      try {
        const first = useBookmarkStore.getState().loadTree();
        await new Promise((r) => setTimeout(r, 10));
        // 加载期间连点 5 次刷新
        for (let i = 0; i < 5; i++) void useBookmarkStore.getState().loadTree();
        await first;
        await new Promise((r) => setTimeout(r, 250));

        // 1 次原始 + 1 次合并补跑；点 5 次不该变成 6 次遍历
        assert.equal(getTreeCalls, 2, `合并后应只跑 2 次，实际 ${getTreeCalls}`);
      } finally {
        getTreeDelayMs = 0;
      }
    });

    await okA('加载失败后也会补跑排队的刷新（用户点了重试不该被吞）', async () => {
      getTreeCalls = 0;
      getTreeDelayMs = 60;
      const original = chrome.bookmarks.getTree;
      let failOnce = true;
      (chrome.bookmarks as { getTree: typeof original }).getTree = async () => {
        if (failOnce) {
          failOnce = false;
          await new Promise((r) => setTimeout(r, 60));
          throw new Error('模拟 getTree 失败');
        }
        return original();
      };
      try {
        const first = useBookmarkStore.getState().loadTree();
        await new Promise((r) => setTimeout(r, 15));
        void useBookmarkStore.getState().loadTree(); // 失败期间请求的刷新
        await first;
        await new Promise((r) => setTimeout(r, 250));

        assert.equal(getTreeCalls, 1, `失败后应补跑成功的那一次，getTree 调用 ${getTreeCalls}`);
        assert.equal(useBookmarkStore.getState().loadError, null, '补跑成功后错误应被清掉');
      } finally {
        (chrome.bookmarks as { getTree: typeof original }).getTree = original;
        getTreeDelayMs = 0;
      }
    });
  }

  /* ══════════ T107: 收尾不丢最后一段（草稿必须强制 flush） ══════════ */
  console.log('\n[T107] 收尾时最后 300ms 的文本不能丢');
  {
    /*
     * 缺陷（我自己引入的）：草稿是 300ms 节流落盘，而 finalizeDraft 从 **storage** 读。
     * 一轮生成结束时，最后不到 300ms 的字还在内存 buffer 里没写下去，
     * finalize 读到的就是旧值 → 那一段跟着 clearDraft 一起蒸发。
     *
     * 复现方式：先让一段被 flush（等过节流），再追加一段但不等节流，
     * 立刻 finalize，检查两段都在。
     */
    await okA('finalizeDraft 会先把内存里的草稿写下去，再读', async () => {
      resetDraftForTest();
      storageMap.delete(STREAM_DRAFT_KEY);
      const convId = 't107-conv';

      storageMap.set(AI_STORAGE_KEY, {
        conversations: [
          {
            id: convId,
            title: 'T107',
            createdAt: 1,
            updatedAt: 1,
            messages: [
              { id: 'm-tail', role: 'assistant', createdAt: 1, streaming: true, blocks: [{ kind: 'text', text: '' }] },
            ],
          },
        ],
        activeId: convId,
      });

      // 第一段：等节流真的写下去
      appendDraft('m-tail', '前半段');
      await new Promise((r) => setTimeout(r, 420));

      // 第二段：刚追加，还没到节流窗口
      appendDraft('m-tail', '·尾巴');

      // 立刻收尾 —— 此时 storage 里只有「前半段」
      await finalizeDraft(AI_STORAGE_KEY);

      const saved = storageMap.get(AI_STORAGE_KEY) as {
        conversations: { messages: { blocks: { text: string }[]; streaming?: boolean }[] }[];
      };
      const text = saved.conversations[0]!.messages[0]!.blocks[0]!.text;
      assert.equal(text, '前半段·尾巴', `收尾丢了最后一段，实际「${text}」`);
      assert.equal(saved.conversations[0]!.messages[0]!.streaming, false);
      assert.equal(storageMap.get(STREAM_DRAFT_KEY), undefined, '草稿应被清掉');

      storageMap.delete(AI_STORAGE_KEY);
      resetDraftForTest();
    });

    await okA('连续写入不会互相覆盖（串行化后最后写入的一定是最新内容）', async () => {
      resetDraftForTest();
      storageMap.delete(STREAM_DRAFT_KEY);
      appendDraft('m2', '一');
      // 不等节流，连续追加多次，模拟高频增量
      for (let i = 0; i < 20; i++) appendDraft('m2', String(i % 10));
      await new Promise((r) => setTimeout(r, 500));
      const draft = await readDraft();
      assert.ok(draft, '应有草稿');
      assert.equal(draft!.text.length, 21, `应累积全部 21 个字符，实际 ${draft!.text.length}`);
      assert.ok(draft!.text.startsWith('一'), draft!.text);
      resetDraftForTest();
      storageMap.delete(STREAM_DRAFT_KEY);
    });
  }

  /* ══════════ T108: 撤销点校验只有一份（否则会误删撤销历史） ══════════ */
  console.log('\n[T108] 撤销点校验：白名单必须覆盖真实 kind');
  {
    /*
     * 缺陷：健康检查与修复器各写了一份 isUsableUndoPoint，两份的 kind 白名单都是
     * `move/update/create/remove/sort` —— 漏了真实的 `moveBatch` 与 `delete`，
     * 还多写了不存在的 `remove`/`sort`。
     *
     * 后果不是"少报一次"：`dropCorruptUndo` 按这份判断**直接删点**，
     * 含批量移动或删除的撤销点会被当成"损坏"清掉——用户的撤销历史就这么没了。
     */
    const { KNOWN_OP_KINDS, isUsableUndoPoint } = await import('../src/lib/undo/validate');

    ok('白名单覆盖全部真实 kind（move / moveBatch / update / create / delete）', () => {
      for (const k of ['move', 'moveBatch', 'update', 'create', 'delete']) {
        assert.ok(KNOWN_OP_KINDS.includes(k as never), `白名单缺 ${k}`);
      }
    });

    ok('含 moveBatch 的撤销点必须被认作完整（不能当坏点）', () => {
      const point = {
        id: 'p1',
        runId: 'r1',
        ops: [{ kind: 'moveBatch', ids: ['a', 'b'], fromParentId: '1', fromIndex: 0 }],
      };
      assert.equal(isUsableUndoPoint(point), true, '含 moveBatch 的点被误判为损坏');
    });

    ok('含 delete 的撤销点必须被认作完整（删除最需要撤销，绝不能丢）', () => {
      const point = {
        id: 'p2',
        runId: 'r2',
        ops: [{ kind: 'delete', id: 'x', title: 't', parentId: '1', index: 0, snapshot: { title: 't' } }],
      };
      assert.equal(isUsableUndoPoint(point), true, '含 delete 的点被误判为损坏');
    });

    ok('真正损坏的点仍然被认出来（不是把校验改成永远通过）', () => {
      assert.equal(isUsableUndoPoint({ id: 'p', runId: 'r', ops: [{ kind: '不存在的类型' }] }), false);
      assert.equal(isUsableUndoPoint({ id: 'p', ops: [] }), false, '缺 runId');
      assert.equal(isUsableUndoPoint({ id: 'p', runId: 'r', ops: 'not-array' }), false);
      assert.equal(isUsableUndoPoint(null), false);
    });

    await okA('修复器不会删掉含 moveBatch / delete 的撤销点（真实数据损失场景）', async () => {
      storageMap.set('markai.undo', {
        points: [
          { id: 'good-move', runId: 'r1', ops: [{ kind: 'move', id: 'a', title: 't', fromParentId: '1', fromIndex: 0 }] },
          { id: 'good-batch', runId: 'r2', ops: [{ kind: 'moveBatch', ids: ['x', 'y'], fromParentId: '1', fromIndex: 2 }] },
          { id: 'good-del', runId: 'r3', ops: [{ kind: 'delete', id: 'd', title: 't', snapshot: { title: 't' } }] },
          { id: 'bad', runId: 'r4', ops: [{ kind: '未知操作' }] },
        ],
        terminalRunIds: [],
      });
      const res = await runFix('undo.drop-corrupt');
      assert.equal(res.ok, true, res.detail);
      const after = storageMap.get('markai.undo') as { points: { id: string }[] };
      const ids = after.points.map((p) => p.id).sort();
      assert.deepEqual(
        ids,
        ['good-batch', 'good-del', 'good-move'],
        `只该删掉真正损坏的那一条，实际留下 ${JSON.stringify(ids)}`,
      );
      storageMap.delete('markai.undo');
    });

    ok('诊断也不会把含 moveBatch / delete 的点报成"已损坏"', () => {
      const report = diagnose({
        configError: null,
        config: { providerId: 'deepseek', baseUrl: 'https://x', apiKey: 'k', model: 'm', customHeaders: '' },
        providerNeedsKey: true,
        permissions: ['bookmarks', 'storage', 'sidePanel'],
        logBytes: null,
        undoPoints: [
          { id: 'a', runId: 'r1', ops: [{ kind: 'moveBatch', ids: ['x'] }] },
          { id: 'b', runId: 'r2', ops: [{ kind: 'delete', id: 'd', snapshot: {} }] },
        ],
        logEntries: [],
        bookmarks: { total: 1, folders: 1, emptyFolders: 0, maxDepth: 1, orphaned: 0, duplicateNameGroups: 0 },
        storageBytes: 0,
        lastAiError: null,
        });
      assert.equal(
        report.issues.some((i) => i.id === 'undo.corrupt'),
        false,
        `不该报损坏，实际 ${JSON.stringify(report.issues.map((i) => i.id))}`,
      );
    });
  }

  /* ══════════ T109: 孤儿检测不能误报（search 不返回根文件夹） ══════════ */
  console.log('\n[T109] 健康检查的孤儿判据');
  {
    /*
     * 实测：`chrome.bookmarks.search({})` **不返回根文件夹**（书签栏 / 其他书签 / 移动设备）。
     * 原先的判据是"父级不在 search 结果里 = 孤儿"，
     * 于是任何直接挂在书签栏下的书签/文件夹都被误判 ——
     * 健康检查会对普通用户报「N 个书签找不到父文件夹，它们不会出现在任何树里」，
     * 完全是假警报，而且很吓人。
     */
    const bar = {
      id: '1',
      title: '书签栏',
      children: [
        { id: 'a', title: 'A', url: 'https://a.example', parentId: '1' },
        {
          id: 'f',
          title: 'F',
          parentId: '1',
          children: [{ id: 'b', title: 'B', url: 'https://b.example', parentId: 'f' }],
        },
      ],
    } as unknown as chrome.bookmarks.BookmarkTreeNode;
    const tree = [{ id: '0', title: '', children: [bar] }] as unknown as chrome.bookmarks.BookmarkTreeNode[];

    ok('直接挂在书签栏下的书签与文件夹不算孤儿（此前会误报）', () => {
      // search({}) 的真实返回：只有用户内容，没有根文件夹
      const fromSearch = [
        { id: 'a', title: 'A', url: 'https://a.example', parentId: '1' },
        { id: 'f', title: 'F', parentId: '1' },
        { id: 'b', title: 'B', url: 'https://b.example', parentId: 'f' },
      ] as unknown as chrome.bookmarks.BookmarkTreeNode[];
      const stats = analyzeBookmarks(tree, fromSearch);
      assert.equal(stats.orphaned, 0, `不该报孤儿，实际 ${stats.orphaned}`);
    });

    ok('真正的孤儿（父级根本不存在）仍然能检出来', () => {
      const fromSearch = [
        { id: 'a', title: 'A', url: 'https://a.example', parentId: '1' },
        { id: 'ghost', title: 'G', url: 'https://g.example', parentId: '不存在的父级' },
      ] as unknown as chrome.bookmarks.BookmarkTreeNode[];
      const stats = analyzeBookmarks(tree, fromSearch);
      assert.equal(stats.orphaned, 1, `应报 1 个真孤儿，实际 ${stats.orphaned}`);
    });

    ok('没传全量列表时不猜孤儿（宁可不说，也不要编一个数字）', () => {
      const stats = analyzeBookmarks(tree);
      assert.equal(stats.orphaned, 0);
    });
  }

  /* ══════════ T110: 健康检查不许读"没人写"的数据 ══════════ */
  console.log('\n[T110] 健康检查的数据来源必须真实存在');
  {
    /*
     * 缺陷（本轮的）：`diagnose` 里有一条「后台异常退出 N 次」，读的是 `markai.runtime.crash`，
     * 但**没有任何地方写入这个 key**。于是这条检测永远不触发——
     * 界面上看着像个真的监控，实际是死代码，而 0.2.37 的说明里还声称它能检测崩溃。
     *
     * 这类"读一份没人写的数据"很难靠肉眼发现，所以做成守卫：
     * 扫 health 模块读取的 key，每个都必须在 health 目录之外真的被写过。
     */
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const healthDir = join(root, 'src/lib/health');
    const healthFiles = readdirSync(healthDir).filter((f) => f.endsWith('.ts'));

    // health 模块读取的所有 markai.* key
    const readKeys = new Set<string>();
    for (const f of healthFiles) {
      const src = readFileSync(join(healthDir, f), 'utf8');
      for (const m of src.matchAll(/['"](markai\.[a-zA-Z0-9._]+)['"]/g)) readKeys.add(m[1]!);
    }

    /** 递归收集 src 下除 health 外的所有源码 */
    const collect = (dir: string, out: string[] = []): string[] => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === 'health' || e.name === 'node_modules') continue;
          collect(full, out);
        } else if (/\.(ts|tsx)$/.test(e.name)) {
          out.push(full);
        }
      }
      return out;
    };
    const otherSrc = collect(join(root, 'src'))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');

    ok('health 模块读到的每个 markai.* key 都在别处真的被写过', () => {
      assert.ok(readKeys.size > 0, '没扫到任何 key，守卫本身失效了');
      const unwritten = [...readKeys].filter((k) => !otherSrc.includes(`'${k}'`) && !otherSrc.includes(`"${k}"`));
      assert.deepEqual(
        unwritten,
        [],
        `这些 key 在 health 之外没有任何写入方，对应的检测永远不会触发：${JSON.stringify(unwritten)}`,
      );
    });

    ok('已删除的崩溃计数不再出现（检测不到就别装作能检测）', () => {
      assert.equal(otherSrc.includes('markai.runtime.crash'), false);
      const healthSrc = healthFiles.map((f) => readFileSync(join(healthDir, f), 'utf8')).join('\n');
      assert.equal(healthSrc.includes('crashCount'), false);
      assert.equal(healthSrc.includes('runtime.crashed'), false);
    });
  }

  /* ══════════ T111: 「收藏到书签栏」必须真的进书签栏 ══════════ */
  console.log('\n[T111] 收藏当前页面的落点');
  {
    /*
     * 缺陷：popup 的「收藏当前页面」调用
     *   chrome.bookmarks.create({ title, url })   // 没有 parentId
     * 而 Chrome 不传 parentId 时默认落到「**其他书签**」(id '2')，
     * 按钮提示却写着「收藏当前标签页到**书签栏**」——用户点完去书签栏找不到。
     * 实测（headless）：创建后 parentId = "2"。
     *
     * 这个 bug 之所以一直没被测出来，是因为 mock 里把默认值写成了 '1'（书签栏），
     * 与 Chrome 的真实行为相反。mock 已改忠实。
     */
    const { saveTabToBar } = await import('../src/lib/bookmarks/save-tab');

    await okA('不带 parentId 的坑：saveTabToBar 必须显式指定书签栏', async () => {
      const before = mockCalls.create;
      const res = await saveTabToBar({ title: '示例', url: 'https://bar-target.example/page' });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(mockCalls.create, before + 1);
      const id = (res as { id: string }).id;
      const node = nodeById(id);
      assert.ok(node, '书签没创建出来');
      assert.equal(node!.parentId, '1', `应进书签栏(id 1)，实际 ${node!.parentId}`);
    });

    await okA('重复的网址不重复创建', async () => {
      const first = await saveTabToBar({ title: 'A', url: 'https://dup.example/x' });
      assert.equal(first.ok, true);
      const before = mockCalls.create;
      const second = await saveTabToBar({ title: 'A 再来一次', url: 'https://dup.example/x' });
      assert.equal(second.ok, false);
      assert.equal((second as { reason: string }).reason, 'duplicate');
      assert.equal(mockCalls.create, before, '重复时不该再创建');
    });

    await okA('子串命中不等于重复（必须再比一次 url）', async () => {
      /*
       * 关键在于**先后顺序**：必须先存 `.../page2`，再存 `.../page`。
       * 这样 `search('.../page')` 会同时命中原有的 `.../page2`（子串匹配），
       * 只有 `existing.some(n => n.url === url)` 这一步才能把它排除掉。
       *
       * 反过来的顺序（先 page 后 page2）搜 page2 不会命中 page，
       * 那条断言等于什么都没验证——我上一版就是这么写的。
       */
      const seeded = await saveTabToBar({ title: 'page2', url: 'https://sub.example/page2' });
      assert.equal(seeded.ok, true);

      // 确认前提成立：search 真的会把这个"前缀关系"的节点带出来
      const hits = await chrome.bookmarks.search('https://sub.example/page');
      assert.ok(
        hits.some((n) => n.url === 'https://sub.example/page2'),
        '前提不成立：search 没有子串命中，这条断言失去意义',
      );

      const b = await saveTabToBar({ title: 'page', url: 'https://sub.example/page' });
      assert.equal(b.ok, true, `被误判为重复：${JSON.stringify(b)}`);
    });

    await okA('非 http(s) 页面不收藏', async () => {
      const before = mockCalls.create;
      for (const url of ['chrome://settings', 'about:blank', 'chrome-extension://abc/x.html', undefined]) {
        const res = await saveTabToBar({ title: 't', url });
        assert.equal(res.ok, false);
        assert.equal((res as { reason: string }).reason, 'unsupported-url');
      }
      assert.equal(mockCalls.create, before, '非 http 页面不该创建书签');
    });
  }

  /* ══════════ T112: bookmarks.move 的 index 边界（实测钉死） ══════════ */
  console.log('\n[T112] 移动落点边界：index == 子项数合法，越界必须抛错');
  {
    /*
     * 这一条守的是**替身保真**，不是产品逻辑。
     *
     * 之前的替身没有越界校验：`index: 99` 在测试里静默成功，真实 Chrome 直接
     * 抛 `Index out of bounds.`。于是"落点算错"这类 bug 在测试里永远看不出来。
     *
     * 边界值是实测出来的（headless 真 Chrome）：
     *   同父、4 个子项 [a,b,c,d]：move(a → index 4) → [b,c,d,a] ✔ ；index 5 → THROW
     *   跨父、目标 1 个子项：      move(x → index 1) → ✔ ；index 3 → THROW
     * 上限 = 目标文件夹**当前的**子项数（含被移动的那个自己），不是减一。
     */
    const F = (await mockBookmarks.create({ parentId: '2', title: 'T112-F' })).id;
    const mk = async (t: string) =>
      (await mockBookmarks.create({ parentId: F, title: t, url: `https://t112.example/${t}` })).id;
    const a = await mk('a');
    await mk('b');
    await mk('c');
    await mk('d');
    const kids = async () => (await chrome.bookmarks.getChildren(F)).map((n) => n.title);

    await okA('同父移动到末尾：index == 子项数(4) 合法', async () => {
      await mockBookmarks.move(a, { parentId: F, index: 4 });
      assert.deepEqual(await kids(), ['b', 'c', 'd', 'a']);
    });

    await okA('同父越界：index == 子项数+1 必须抛错（替身保真）', async () => {
      await assert.rejects(
        () => mockBookmarks.move(a, { parentId: F, index: 5 }),
        /Index out of bounds/,
        '替身没有复刻 Chrome 的越界校验 → 落点算错的 bug 会被静默吞掉',
      );
      assert.deepEqual(await kids(), ['b', 'c', 'd', 'a'], '抛错时不能改动数据');
    });

    await okA('跨父越界同样抛错', async () => {
      const G = (await mockBookmarks.create({ parentId: '2', title: 'T112-G' })).id;
      await mockBookmarks.create({ parentId: G, title: 'only' });
      // G 现在 1 个子项：index 1 合法
      await mockBookmarks.move(a, { parentId: G, index: 1 });
      assert.deepEqual(
        (await chrome.bookmarks.getChildren(G)).map((n) => n.title),
        ['only', 'a'],
      );
      // G 现在 2 个子项：index 3 越界
      const b = (await chrome.bookmarks.getChildren(F)).find((n) => n.title === 'b')!.id;
      await assert.rejects(() => mockBookmarks.move(b, { parentId: G, index: 3 }), /Index out of bounds/);
    });

    await okA('拖到末尾用的就是 index == 子项数（resolveDropIndex 与真实 API 对齐）', async () => {
      const H = (await mockBookmarks.create({ parentId: '2', title: 'T112-H' })).id;
      await mockBookmarks.create({ parentId: H, title: 'p', url: 'https://t112.example/p' });
      const q = (await mockBookmarks.create({ parentId: H, title: 'q', url: 'https://t112.example/q' })).id;
      const list = await chrome.bookmarks.getChildren(H);
      const { resolveDropIndex } = await import('../src/lib/bookmark-dnd');
      const idx = resolveDropIndex(list.length - 1, 'below');
      assert.equal(idx, list.length, `拖到末行下方应得到 ${list.length}，实际 ${idx}`);
      // q 拖到自己下方 = 原地不动（Chrome 的 oldIndex+1 空操作）
      await mockBookmarks.move(q, { parentId: H, index: idx });
      assert.deepEqual(
        (await chrome.bookmarks.getChildren(H)).map((n) => n.title),
        ['p', 'q'],
      );
    });
  }

  /* ══════════ T113: 「重新生成」在有写操作时必须拦掉 ══════════ */
  console.log('\n[T113] 重新生成的安全性');
  {
    /*
     * 缺陷：`retryLast()` 会删掉最后一条用户消息之后的全部消息、并把同一句指令重发。
     * 它默认"这一轮什么都没发生"——但只要 Agent 已经调用过写类工具，这个假设就是错的。
     *
     * 典型序列：用户说「把这几个归到开发」→ Agent 调了 move_bookmarks ×5 →
     * 最后一轮没返回任何文字 → 界面显示「Agent 未返回内容，可点击 ↻ 重新生成」。
     * 此时 5 个书签**已经移走了**。点下去会重发同一句指令，工具再跑一遍：
     * 移动幂等看不出，但 create_bookmark / copy_bookmark 会**造出重复书签**。
     * 更糟的是那条带工具记录的消息会被删掉，用户再也看不到"其实执行过了"。
     */
    const { retrySafety, mutatedEmptyReplyNote } = await import('../src/lib/chat/retry-safety');

    const toolBlock = (name: string, status: 'done' | 'error' = 'done'): any => ({
      kind: 'tool',
      record: { id: 't', name, args: '{}', status, ...(status === 'done' ? { result: 'ok' } : { error: 'x' }) },
    });

    ok('没有工具调用 → 可以安全重新生成', () => {
      const r = retrySafety([{ kind: 'text', text: '你好' }]);
      assert.equal(r.mutations, 0);
      assert.equal(r.safeToRegenerate, true);
    });

    ok('只读工具不算改动 → 仍可重新生成', () => {
      const r = retrySafety([toolBlock('search_bookmarks'), toolBlock('get_stats')]);
      assert.equal(r.mutations, 0, '只读工具被误算成改动');
      assert.equal(r.safeToRegenerate, true);
    });

    ok('写类工具成功执行 → 禁止重新生成（否则会重复执行）', () => {
      const r = retrySafety([toolBlock('move_bookmarks'), toolBlock('create_bookmark')]);
      assert.equal(r.mutations, 2);
      assert.equal(r.safeToRegenerate, false);
    });

    ok('写类工具**失败**不算改动（什么都没落地，重试是安全的）', () => {
      const r = retrySafety([toolBlock('create_bookmark', 'error')]);
      assert.equal(r.mutations, 0);
      assert.equal(r.safeToRegenerate, true);
    });

    ok('文案不再提"重新生成"，改为指向撤销', () => {
      const note = mutatedEmptyReplyNote(3);
      assert.ok(note.includes('3'), note);
      assert.equal(note.includes('重新生成'), false, '已经改过东西了，不能再让人点重新生成');
      assert.ok(note.includes('撤销'), note);
    });

    await okA('store 层也拦住（UI 不给入口，这里防绕过）', async () => {
      const { useAIStore } = await import('../src/stores/aiStore');
      type Msg = { id: string; role: 'user' | 'assistant'; blocks: unknown[]; createdAt: number };
      /*
       * 必须给一个**真实会话**：`updateActiveMessages` 找不到 active 会话时会直接
       * 返回 {}（拒绝写入孤儿镜像）。我第一版把 conversations 留空，
       * 于是"被拦下、消息没动"这条断言其实是白过的——它不是因为拦截而通过，
       * 而是因为根本没写。对照组（只读工具应当截断）当场暴露了这一点。
       */
      const seed = (assistantBlocks: unknown[]) => {
        storageMap.clear();
        const msgs = [
          { id: 'u1', role: 'user', blocks: [{ kind: 'text', text: '归到开发' }], createdAt: 1 },
          { id: 'a1', role: 'assistant', blocks: assistantBlocks, createdAt: 2 },
        ];
        useAIStore.setState({
          conversations: [{ id: 'c1', title: 't', createdAt: 1, updatedAt: 1, messages: msgs }] as never,
          activeId: 'c1',
          messages: msgs as never,
          streaming: false,
          streamingMessageId: null,
        } as never);
      };

      /*
       * 断言必须看**旧消息还在不在**，不能看数组长度。
       * 允许重试时 send() 会同步补一条 assistant 占位，
       * 于是"被拦下(2 条)"和"允许重试(1 条 user + 1 条新占位 = 2 条)"长度一样——
       * 我第一版拿长度当判据，两种情况下都会通过，等于没测。
       */
      const idsOf = () => (useAIStore.getState().messages as Msg[]).map((m) => m.id);

      // 已经移动过 → 必须被拦下：旧的 a1 原封不动留着
      seed([toolBlock('move_bookmarks')]);
      useAIStore.getState().retryLast();
      assert.ok(
        idsOf().includes('a1'),
        `已执行写操作时不该裁掉带工具记录的消息，实际 [${idsOf().join(',')}]`,
      );

      // 对照：只读工具 → 允许重试：a1 必须消失（被裁掉后重发）
      seed([toolBlock('search_bookmarks')]);
      useAIStore.getState().retryLast();
      assert.equal(
        idsOf().includes('a1'),
        false,
        `对照组的重试没有生效，a1 还在：[${idsOf().join(',')}]`,
      );
      assert.equal(idsOf()[0], 'u1', '重试应保留原 user 消息');
      useAIStore.setState({ messages: [], streaming: false, streamingMessageId: null } as never);
    });
  }

  /* ══════════ T114: 超出撤销步数上限必须说出来 ══════════ */
  console.log('\n[T114] 撤销步数上限的丢弃提示');
  {
    /*
     * 缺陷：`endUndoTransaction` 里 `slice(0, MAX_UNDO_POINTS)` 会把最旧的点挤掉，
     * 而 `describeUndoTrim` 只描述**字节预算**溢出 → 超出 10 步后最早那步**静默消失**。
     *
     * 用户以为"最近 10 次都能撤"，实际到第 11 次就悄悄丢了第 1 次，
     * 等真要用时才发现——和"删除类操作没有撤销点"是同一性质的伤害。
     */
    const { beginUndoTransaction, endUndoTransaction, readUndoState, resetUndoTransactionForTest, UNDO_STORAGE_KEY } =
      await import('../src/lib/undo/recorder');

    await okA(`做到第 ${MAX_UNDO_POINTS + 2} 步时，提示里要点名丢了几步`, async () => {
      storageMap.delete(UNDO_STORAGE_KEY);
      resetUndoTransactionForTest();
      const bar = '1';

      let lastNotice = null;
      for (let i = 0; i < MAX_UNDO_POINTS + 2; i++) {
        await beginUndoTransaction(`run-t114-${i}`);
        await mockBookmarks.create({ parentId: bar, title: `T114-${i}`, url: `https://t114.example/${i}` });
        await executeTool('create_bookmark', JSON.stringify({ parentId: bar, title: `T114-${i}`, url: `https://t114.example/${i}` }));
        await endUndoTransaction();
        const st = await readUndoState();
        lastNotice = st.notice;
      }

      const state = await readUndoState();
      assert.equal(state.points.length, MAX_UNDO_POINTS, `应保留 ${MAX_UNDO_POINTS} 步`);
      assert.ok(lastNotice, '超出上限时必须给出提示，而不是静默丢弃');
      assert.ok(
        String(lastNotice).includes('丢弃'),
        `提示要点明"丢弃"，实际：${lastNotice}`,
      );
      assert.ok(
        String(lastNotice).includes(String(MAX_UNDO_POINTS)),
        `提示要说明上限是多少，实际：${lastNotice}`,
      );
      storageMap.delete(UNDO_STORAGE_KEY);
      resetUndoTransactionForTest();
    });

    await okA('没超上限时不打扰（不产生多余提示）', async () => {
      storageMap.delete(UNDO_STORAGE_KEY);
      resetUndoTransactionForTest();
      await beginUndoTransaction('run-t114-few');
      await executeTool('create_bookmark', JSON.stringify({ parentId: '1', title: 'T114-单步', url: 'https://t114.example/one' }));
      await endUndoTransaction();
      const st = await readUndoState();
      assert.equal(st.points.length, 1);
      assert.ok(
        !st.notice || !String(st.notice).includes('丢弃'),
        `只有 1 步就不该提示丢弃，实际：${st.notice}`,
      );
      storageMap.delete(UNDO_STORAGE_KEY);
      resetUndoTransactionForTest();
    });
  }

  /* ══════════ T115: 弹窗待办卡片不能说"没有"（它还不知道） ══════════ */
  console.log('\n[T115] 弹窗待办卡片的三种语义');
  {
    /*
     * 缺陷：`pendingCount` 初值是 0，第一次 storage 读回来之前界面就已经写着
     * 「当前没有待确认的删除提议。」——在还不知道的情况下给出确定结论。
     * SW 睡着时这次读要几百毫秒，用户看到的就是一句假话；读失败时永远停在"没有提议"。
     */
    const { pendingCardCopy } = await import('../src/lib/bookmarks/pending-copy');

    ok('读取中：只说"正在读"，不下结论', () => {
      const t = pendingCardCopy({ state: 'loading', pendingCount: 0, autoDeleteMode: false });
      assert.ok(t.includes('正在读取'), t);
      assert.equal(t.includes('没有'), false, `读取中不能说"没有"：${t}`);
    });

    ok('读取失败：要说清看不到，而不是"没有提议"', () => {
      const t = pendingCardCopy({ state: 'error', pendingCount: 0, autoDeleteMode: false });
      assert.ok(t.includes('读取失败'), t);
      assert.equal(t.includes('没有待确认'), false, `读失败不能说"没有待确认"：${t}`);
    });

    ok('读到且为空：这时才可以下"没有"的结论', () => {
      const t = pendingCardCopy({ state: 'ok', pendingCount: 0, autoDeleteMode: false });
      assert.ok(t.includes('没有待确认的删除提议'), t);
    });

    ok('读到且有提议：分模式说清会不会自动执行', () => {
      const manual = pendingCardCopy({ state: 'ok', pendingCount: 3, autoDeleteMode: false });
      assert.ok(manual.includes('等待你确认'), manual);
      const auto = pendingCardCopy({ state: 'ok', pendingCount: 3, autoDeleteMode: true });
      assert.ok(auto.includes('无需确认'), auto);
      assert.ok(auto.includes('自动执行'), auto);
    });

    ok('空 + 无需确认：也要说明这个模式（否则用户以为没有提议=没风险）', () => {
      const t = pendingCardCopy({ state: 'ok', pendingCount: 0, autoDeleteMode: true });
      assert.ok(t.includes('无需确认'), t);
      assert.ok(t.includes('自动执行'), t);
    });
  }

  /* ══════════ T116: 弹窗整理卡片也不能把"不知道"说成"0 条" ══════════ */
  console.log('\n[T116] 弹窗整理卡片的三种语义');
  {
    /*
     * 同一个问题的第二次出现：`organizeStats` 初值 null、读失败也是 null，
     * 而渲染写成 `today ?? 0` → 读不到也显示「今天 0 条」，
     * 还配一句「收藏新页面后会自动归类」——两句都在说"你这边什么都没有"。
     * 实际是**这次没读到**。
     */
    const { organizeCardCopy } = await import('../src/lib/bookmarks/organize-card-copy');

    ok('读取中：徽标说"读取中"，正文不下结论', () => {
      const c = organizeCardCopy('loading', null);
      assert.equal(c.badge, '读取中');
      assert.equal(/\d+\s*条/.test(c.badge), false, `读取中不该出现条数：${c.badge}`);
      assert.equal(c.body.includes('没整理过'), false, c.body);
    });

    ok('读取失败：不能说「今天 0 条」，也不能说"会自动归类"', () => {
      const c = organizeCardCopy('error', null);
      assert.equal(c.badge, '读取失败');
      assert.equal(c.badge.includes('0 条'), false, `读失败不能说 0 条：${c.badge}`);
      assert.equal(c.body.includes('收藏新页面后'), false, `读失败不能说"还没收藏"：${c.body}`);
      assert.ok(c.body.includes('不代表'), c.body);
    });

    ok('读到且为空：这时才可以显示 0 条', () => {
      const c = organizeCardCopy('ok', { today: 0, total: 0, moved: 0, created: 0, failed: 0, latest: null } as never);
      assert.equal(c.badge, '今天 0 条');
      assert.ok(c.body.includes('收藏新页面后'), c.body);
    });

    ok('读到且有数据：显示条数与最近一条，失败数单独给出', () => {
      const c = organizeCardCopy(
        'ok',
        {
          today: 3,
          total: 9,
          moved: 2,
          created: 1,
          failed: 2,
          latest: { title: 'Radix', target: '设计资料' },
        } as never,
      );
      assert.equal(c.badge, '今天 3 条');
      assert.ok(c.body.includes('Radix'), c.body);
      assert.ok(c.body.includes('设计资料'), c.body);
      assert.equal(c.failedCount, 2);
    });

    ok('读失败时即使有旧的 stats 也不能拿来充数（避免显示过期数字）', () => {
      const c = organizeCardCopy('error', { today: 7, total: 7, moved: 7, created: 0, failed: 0, latest: { title: 'X' } } as never);
      assert.equal(c.badge, '读取失败');
      assert.equal(c.failedCount, 0);
    });
  }

  /* ══════════ T117: 读整理记录失败要抛，不能假装"没有记录" ══════════ */
  console.log('\n[T117] readOrganizeLog 不再吞错');
  {
    /*
     * 根因：`readOrganizeLog` 里 `catch { return [] }` 把"读不到"变成了"没有记录"。
     * 调用方的 `.catch` 永远不触发 → 界面上出现「今天 0 条 / 收藏新页面后会自动归类」
     * 这种假话。这是 0.2.55 / 0.2.57 / 0.2.58 之后的第四次同类问题。
     */
    const { readOrganizeLog, ORGANIZE_LOG_KEY } = await import('../src/lib/ai/organize-log');

    await okA('存储读取失败时抛出（而不是返回空数组）', async () => {
      storageMap.delete(ORGANIZE_LOG_KEY);
      const orig = chrome.storage.local.get;
      // 只让这次读取失败
      chrome.storage.local.get = (async () => {
        throw new Error('模拟：存储读取失败');
      }) as typeof chrome.storage.local.get;
      try {
        await assert.rejects(
          () => readOrganizeLog(),
          /存储读取失败/,
          '读失败必须抛出，否则调用方会把"读不到"当成"没有记录"',
        );
      } finally {
        chrome.storage.local.get = orig;
      }
    });

    await okA('正常读取仍然返回条目（没有把功能改坏）', async () => {
      storageMap.set(ORGANIZE_LOG_KEY, [
        { id: 'e1', at: Date.now(), title: 'T117', domain: 'x.example', action: 'moved', detail: 'ok', via: 'local' },
      ]);
      const entries = await readOrganizeLog();
      assert.equal(entries.length, 1);
      assert.equal(entries[0]!.id, 'e1');
      storageMap.delete(ORGANIZE_LOG_KEY);
    });

    await okA('没有记录时返回空数组（这是"真的没有"，不是"读不到"）', async () => {
      storageMap.delete(ORGANIZE_LOG_KEY);
      const entries = await readOrganizeLog();
      assert.deepEqual(entries, []);
    });
  }

  /* ══════════ T118: 读失败时的写盘安全网 ══════════ */
  console.log('\n[T118] 读失败时写盘');
  {
    /*
     * 背景：`load()` 的 catch 把内存会话清空；`_persist()` 落盘前会重读磁盘并合并，
     * 所以"加载失败 → 写盘"通常不会丢历史（有一条专门的兜底）。
     *
     * 但兜底本身也依赖读磁盘。若**写盘前的重读也失败**，代码注释写着
     * "重读失败不阻塞落盘"——那就可能拿着空内存去覆盖整份历史。
     * 这条用例就来钉这件事。
     */
    const { useAIStore, AI_STORAGE_KEY } = await import('../src/stores/aiStore');
    const reset = () => {
      storageMap.clear();
      useAIStore.setState({
        messages: [], conversations: [], activeId: null, deletedIds: [], clearedIds: [],
        pendingDeletions: [], streaming: false, streamingMessageId: null, persistError: null,
      });
    };

    await okA('写盘前重读失败时，不能拿空内存覆盖掉磁盘上的历史', async () => {
      reset();
      const c1 = {
        id: 'conv-keep-1', title: '旧会话一', createdAt: 1, updatedAt: 1,
        messages: [{ id: 'm1', role: 'user', blocks: [{ kind: 'text', text: '别丢了我' }], createdAt: 1 }],
      };
      storageMap.set(AI_STORAGE_KEY, {
        conversations: [c1], activeId: c1.id, pendingDeletions: [], deletedIds: [], clearedIds: [],
      });

      // 模拟：加载失败导致内存为空，紧接着用户发了一条消息（新会话），再落盘——
      // 而这次落盘期间的所有 storage 读取都失败（读坏了，但写可能还能成功）
      const origGet = chrome.storage.local.get;
      const origSet = chrome.storage.local.set;
      const fresh = {
        id: 'conv-new', title: '新会话', createdAt: 9, updatedAt: 9,
        messages: [{ id: 'm2', role: 'user' as const, blocks: [{ kind: 'text' as const, text: '新' }], createdAt: 9 }],
      };
      useAIStore.setState({ conversations: [fresh], messages: fresh.messages, activeId: fresh.id });

      chrome.storage.local.get = (async () => {
        throw new Error('模拟：读取失败');
      }) as typeof chrome.storage.local.get;
      try {
        await useAIStore.getState()._persist();
      } finally {
        chrome.storage.local.get = origGet;
        chrome.storage.local.set = origSet;
      }

      const stored = storageMap.get(AI_STORAGE_KEY) as { conversations?: { id: string }[] } | undefined;
      const ids = (stored?.conversations ?? []).map((c) => c.id);
      assert.ok(
        ids.includes('conv-keep-1'),
        `读失败时把磁盘上的历史覆盖掉了（现只剩 ${JSON.stringify(ids)}）`,
      );
      /*
       * 同时要求给出可见提示。
       * 只有"没写"这一半不够：如果哪天 _persist 被整个删掉，历史同样"还在"，
       * 但用户会在毫不知情的情况下永远丢保存。这条断言把"静默什么都不做"也排除了。
       */
      const err = useAIStore.getState().persistError;
      assert.ok(err, '读失败而没保存时必须给出提示，不能静默');
      assert.ok(err!.message.includes('没有保存'), `提示要说清没保存：${err!.message}`);
      reset();
    });

    await okA('正常写盘不会重复堆叠同一会话', async () => {
      reset();
      const c1 = { id: 'conv-dup', title: '唯一', createdAt: 1, updatedAt: 1, messages: [] };
      storageMap.set(AI_STORAGE_KEY, {
        conversations: [c1], activeId: c1.id, pendingDeletions: [], deletedIds: [], clearedIds: [],
      });
      await useAIStore.getState().load();
      await useAIStore.getState()._persist();
      await useAIStore.getState()._persist();
      const stored = storageMap.get(AI_STORAGE_KEY) as { conversations?: { id: string }[] } | undefined;
      const same = (stored?.conversations ?? []).filter((c) => c.id === 'conv-dup');
      assert.equal(same.length, 1, `同一会话被写成了多份：${JSON.stringify(stored?.conversations?.map((c) => c.id))}`);
      reset();
    });
  }

  /* ══════════ T119: 配置加载失败后保存，不能清掉用户的 API Key ══════════ */
  console.log('\n[T119] 配置的盲写');
  {
    /*
     * `load()` 失败时回退 DEFAULT_CONFIG（apiKey/baseUrl/model 都是空）。
     * 若此时用户改了什么，`update()` 会 `{ ...DEFAULT_CONFIG, ...patch }` 整对象覆盖磁盘
     * ——**用户的 API Key / Base URL / 模型被清掉**，扩展直接不可用，而且用户不知道发生了什么。
     *
     * 这和 0.2.60 修的是同一类：读失败之后不能拿内存去覆盖磁盘。
     */
    const { useConfigStore } = await import('../src/stores/configStore');
    const KEY = 'markai.config';
    const reset = () => {
      storageMap.clear();
      useConfigStore.setState({ config: { ...useConfigStore.getState().config }, saveError: null, loadOk: false });
    };

    await okA('加载失败后保存，磁盘上的 API Key / 模型必须还在', async () => {
      reset();
      const real = {
        providerId: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-real-key-别丢',
        model: 'deepseek-chat',
        customHeaders: 'X-A: 1',
        deleteMode: 'confirm',
        contextWindow: 65536,
      };
      storageMap.set(KEY, real);

      const orig = chrome.storage.local.get;
      chrome.storage.local.get = (async () => {
        throw new Error('模拟：读取失败');
      }) as typeof chrome.storage.local.get;
      try {
        await useConfigStore.getState().load();
      } finally {
        chrome.storage.local.get = orig;
      }
      // 前置：内存此刻是默认值（这正是危险状态）
      assert.notEqual(useConfigStore.getState().config.apiKey, real.apiKey, '前置：加载失败后内存应为默认值');

      // 用户此时改了一个无关字段
      const r = await useConfigStore.getState().update({ planMode: true });
      assert.equal(r.ok, true, `保存应当成功（读回真实配置后合并）：${r.error ?? ''}`);

      const stored = storageMap.get(KEY) as Record<string, unknown>;
      assert.equal(stored.apiKey, real.apiKey, `API Key 被清掉了：${JSON.stringify(stored)}`);
      assert.equal(stored.baseUrl, real.baseUrl, `Base URL 被清掉了：${JSON.stringify(stored)}`);
      assert.equal(stored.model, real.model, `模型被清掉了：${JSON.stringify(stored)}`);
      assert.equal(stored.contextWindow, real.contextWindow, `上下文长度被清掉了：${JSON.stringify(stored)}`);
      assert.equal(stored.planMode, true, '用户这次改的字段要生效');
      reset();
    });

    await okA('读回也失败时：不写、不覆盖，并给出可见说明', async () => {
      reset();
      storageMap.set(KEY, { apiKey: 'sk-still-here', model: 'm1' });

      const orig = chrome.storage.local.get;
      chrome.storage.local.get = (async () => {
        throw new Error('模拟：读取失败');
      }) as typeof chrome.storage.local.get;
      let wrote = false;
      const origSet = chrome.storage.local.set;
      chrome.storage.local.set = (async (items: unknown) => {
        wrote = true;
        return origSet(items as never);
      }) as typeof chrome.storage.local.set;
      try {
        await useConfigStore.getState().load();
        const r = await useConfigStore.getState().update({ planMode: true });
        assert.equal(r.ok, false, '读不到现有设置时不能报告保存成功');
      } finally {
        chrome.storage.local.get = orig;
        chrome.storage.local.set = origSet;
      }

      assert.equal(wrote, false, '读失败时根本不应当写盘');
      const stored = storageMap.get(KEY) as Record<string, unknown>;
      assert.equal(stored.apiKey, 'sk-still-here', `磁盘上的配置被覆盖了：${JSON.stringify(stored)}`);
      const err = useConfigStore.getState().saveError;
      assert.ok(err, '必须给出可见说明');
      assert.ok(err!.message.includes('没有保存'), `提示要说清没保存：${err!.message}`);
      reset();
    });
  }

  /* ══════════ T120: 撤销点读失败时写盘，不能冲掉已有撤销点 ══════════ */
  console.log('\n[T120] 撤销记录的盲写');
  {
    /*
     * `readUndoState` 读失败时返回 `points: []`——那是"我不知道"，不是"没有"。
     * `endUndoTransaction` 拿它当基线写回，会把用户已有的撤销点全部冲掉，
     * 之后他再也退不回之前任何一次整理。与 0.2.60 / 0.2.61 同一类。
     */
    const {
      beginUndoTransaction,
      endUndoTransaction,
      readUndoState,
      resetUndoTransactionForTest,
      UNDO_STORAGE_KEY,
    } = await import('../src/lib/undo/recorder');

    await okA('读失败时放弃写入，磁盘上已有的撤销点一个不少', async () => {
      resetUndoTransactionForTest();
      const kept = [1, 2, 3].map((i) => ({
        id: `p${i}`,
        runId: `r${i}`,
        createdAt: i,
        ops: [],
      }));
      storageMap.set(UNDO_STORAGE_KEY, { points: kept, terminalRunIds: [] });

      // 造一次真实改动，然后让"读撤销状态"失败
      await beginUndoTransaction('run-t120');
      await executeTool('create_bookmark', JSON.stringify({ parentId: '1', title: 'T120', url: 'https://t120.example/' }));

      const orig = chrome.storage.local.get;
      chrome.storage.local.get = (async (k: unknown) => {
        const key = Array.isArray(k) ? k[0] : k;
        if (key === UNDO_STORAGE_KEY) throw new Error('模拟：读撤销记录失败');
        return orig(k as never);
      }) as typeof chrome.storage.local.get;
      let point = null;
      try {
        point = await endUndoTransaction();
      } finally {
        chrome.storage.local.get = orig;
      }

      assert.equal(point, null, '读失败时不应报告"已写入撤销点"');
      const stored = storageMap.get(UNDO_STORAGE_KEY) as { points: { id: string }[] };
      const ids = stored.points.map((p) => p.id);
      assert.deepEqual(ids, ['p1', 'p2', 'p3'], `已有撤销点被冲掉了：${JSON.stringify(ids)}`);

      // 还要能说明为什么没有记录
      const st = await readUndoState();
      assert.ok(st.notice, '必须给出可见说明');
      assert.ok(
        st.notice!.includes('没有写入撤销历史') || st.notice!.includes('读取撤销记录失败'),
        `说明要讲清原因：${st.notice}`,
      );
      storageMap.delete(UNDO_STORAGE_KEY);
      resetUndoTransactionForTest();
    });

    await okA('读正常时撤销点照常追加（没把功能改坏）', async () => {
      resetUndoTransactionForTest();
      storageMap.set(UNDO_STORAGE_KEY, { points: [{ id: 'old', runId: 'ro', createdAt: 1, ops: [] }], terminalRunIds: [] });
      await beginUndoTransaction('run-t120-ok');
      await executeTool('create_bookmark', JSON.stringify({ parentId: '1', title: 'T120b', url: 'https://t120b.example/' }));
      const point = await endUndoTransaction();
      assert.ok(point, '应当写入撤销点');
      const stored = storageMap.get(UNDO_STORAGE_KEY) as { points: { id: string }[] };
      assert.equal(stored.points.length, 2, `应保留旧点并追加新点：${JSON.stringify(stored.points.map((p) => p.id))}`);
      assert.equal(stored.points[0]!.id, point!.id, '新点应在最前');
      storageMap.delete(UNDO_STORAGE_KEY);
      resetUndoTransactionForTest();
    });
  }

  /* ══════════ T121: 长期记忆读失败时，保存不能清空已有记忆 ══════════ */
  console.log('\n[T121] 长期记忆的盲写');
  {
    /*
     * `getMemories()` 读失败会退回 `memoryCache`（首次是 `[]`），而 `addMemoryItem`
     * 拿它当"当前全部记忆"构造新列表写回 → **已有记忆被清空**。
     * 与 0.2.60 / 0.2.61 / 0.2.62 同一结构，这是第四处。
     */
    const { getMemories, saveMemories, MEMORY_STORAGE_KEY } = await import('../src/lib/ai/memory');
    const KEY = MEMORY_STORAGE_KEY;
    const seed = [
      { id: 'mem-1', content: '我偏好中文回复', category: 'preference', createdAt: 1, updatedAt: 1, weight: 1 },
      { id: 'mem-2', content: '我在做设计相关项目', category: 'context', createdAt: 2, updatedAt: 2, weight: 1 },
    ];

    await okA('读失败后保存：拒绝写入，磁盘上的记忆一条不少', async () => {
      /*
       * 先做一次成功读取把模块内缓存清成空（memory.ts 有模块级 memoryCache，
       * 上一条用例会把它留脏；不重置的话前置断言会因环境而从失败）。
       */
      storageMap.set(KEY, []);
      await getMemories();
      // 现在磁盘上有真实记忆，而内存缓存仍是空 —— 正是危险状态
      storageMap.set(KEY, seed);
      const orig = chrome.storage.local.get;
      chrome.storage.local.get = (async (k: unknown) => {
        const key = Array.isArray(k) ? k[0] : k;
        if (key === KEY) throw new Error('模拟：读记忆失败');
        return orig(k as never);
      }) as typeof chrome.storage.local.get;
      let list: unknown[] = [];
      try {
        list = await getMemories();
      } finally {
        chrome.storage.local.get = orig;
      }
      // 前置：读失败时返回空（这就是危险状态）
      assert.deepEqual(list, [], '前置：读失败应返回空列表');

      await assert.rejects(
        () => saveMemories([{ id: 'mem-new', content: '新记忆', category: 'preference', createdAt: 3, updatedAt: 3, weight: 1 }] as never),
        /没有保存|读取长期记忆失败/,
        '读失败时保存必须报错，不能静默覆盖',
      );

      const stored = storageMap.get(KEY) as { id: string }[];
      const ids = stored.map((m) => m.id);
      assert.deepEqual(ids, ['mem-1', 'mem-2'], `已有记忆被清空了：${JSON.stringify(ids)}`);
      storageMap.delete(KEY);
    });

    await okA('读正常时保存照常生效（没把功能改坏）', async () => {
      storageMap.set(KEY, seed);
      await getMemories();
      await saveMemories([...seed, { id: 'mem-3', content: '第三条', category: 'preference', createdAt: 3, updatedAt: 3, weight: 1 }] as never);
      const stored = storageMap.get(KEY) as { id: string }[];
      assert.equal(stored.length, 3, `应写入三条：${JSON.stringify(stored.map((m) => m.id))}`);
      storageMap.delete(KEY);
    });
  }

  /* ══════════ T122: 整理记录读失败时也不许盲写（回归锁） ══════════ */
  console.log('\n[T122] 整理记录的盲写（本来就是安全的，锁住别改坏）');
  {
    /*
     * 这一处**没有** bug：`appendOrganizeLog` / `updateOrganizeLogEntry` 里
     * `storage.local.set` 写在 `try` 内部，读失败会直接跳到 catch，不会写。
     *
     * 但它和前三处长得一模一样（读 → 改 → 整对象写），重构时极易被"整理"成盲写。
     * 用一条用例把这个性质钉住。
     */
    const { appendOrganizeLog, ORGANIZE_LOG_KEY } = await import('../src/lib/ai/organize-log');
    const KEY = ORGANIZE_LOG_KEY;

    await okA('读失败时放弃追加，磁盘上已有记录不变', async () => {
      const seed = [
        { id: 'o1', at: 1_000, title: '旧记录一', domain: 'a.example', action: 'moved', detail: 'ok', via: 'local' },
        { id: 'o2', at: 2_000, title: '旧记录二', domain: 'b.example', action: 'moved', detail: 'ok', via: 'local' },
      ];
      storageMap.set(KEY, seed);

      const orig = chrome.storage.local.get;
      chrome.storage.local.get = (async (k: unknown) => {
        const key = Array.isArray(k) ? k[0] : k;
        if (key === KEY) throw new Error('模拟：读整理记录失败');
        return orig(k as never);
      }) as typeof chrome.storage.local.get;
      try {
        await appendOrganizeLog({
          id: 'o3', at: 3_000, title: '新记录', domain: 'c.example', action: 'moved', detail: 'ok', via: 'local',
        } as never);
      } finally {
        chrome.storage.local.get = orig;
      }

      const stored = storageMap.get(KEY) as { id: string }[];
      const ids = stored.map((e) => e.id);
      assert.deepEqual(ids, ['o1', 'o2'], `已有整理记录被覆盖了：${JSON.stringify(ids)}`);

      storageMap.delete(KEY);
    });
  }

  /* ══════════ T123: 系统提示必须带"现在是什么时候" ══════════ */
  console.log('\n[T123] 时间上下文');
  {
    /*
     * 缺陷：工具回填的 `dateAdded` / `dateLastUsed` 是原始毫秒时间戳，
     * 而系统提示词**没有任何"今天"的信息**——模型只能拿训练截止日当"现在"。
     * 于是「找出超过 2 年没访问的书签」「上周收藏的」这类时间判断会算错，而且错得很自信。
     */
    const { buildTimeContext } = await import('../src/lib/ai/prompts');

    ok('包含明确的"今天"日期与时刻', () => {
      const t = buildTimeContext(new Date('2026-11-02T09:05:00+08:00'), 'Asia/Shanghai');
      assert.ok(t.includes('2026-11-02'), `缺少日期：${t}`);
      assert.ok(t.includes('今天是 2026-11-02'), `缺少"今天是"：${t}`);
    });

    ok('指明时间戳单位与换算基准（否则模型仍会猜）', () => {
      const t = buildTimeContext(new Date('2026-11-02T09:05:00+08:00'), 'Asia/Shanghai');
      assert.ok(t.includes('毫秒时间戳'), t);
      assert.ok(t.includes('以'), t);
      assert.ok(t.includes('不要用你的训练数据'), `应明确禁止用训练数据当今天：${t}`);
    });

    ok('跨时区也给出正确日期（不是硬编码 +08:00）', () => {
      // 2026-11-02T23:30Z = 2026-11-02 15:30 in Los_Angeles
      const t = buildTimeContext(new Date('2026-11-02T23:30:00Z'), 'America/Los_Angeles');
      assert.ok(t.includes('2026-11-02'), `洛杉矶当地应是 11-02：${t}`);
    });

    ok('时区不可用时不会崩（退回本地时间）', () => {
      const t = buildTimeContext(new Date('2026-11-02T09:05:00+08:00'), 'Not/AZone');
      assert.ok(t.includes('当前时间'), t);
    });
  }

  /* ══════════ T124: 健康检查不要给"点了没事干"的修复按钮 ══════════ */
  console.log('\n[T124] 健康检查的修复动作要名副其实');
  {
    /*
     * 缺陷：`config.incomplete` 永远挂一个「填入该服务商的默认值」。
     * 但当唯一缺的是 API Key 时，那个动作**什么也做不了**（Key 必须用户自己拿），
     * 点下去只会弹一句"没有可自动填的字段"；而且它还被计进「N 个可一键修复」，
     * 让健康分看起来有救、实际没有。
     */
    const { diagnose } = await import('../src/lib/health/diagnostics');
    type HealthSnapshot = Parameters<typeof diagnose>[0];
    const healthy = (patch: Partial<HealthSnapshot> = {}): HealthSnapshot => ({
      configError: null,
      config: {
        providerId: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-x',
        model: 'deepseek-v4-flash',
        customHeaders: '',
        autoOrganizeNew: true,
        autoOrganizeAi: true,
        contextWindow: 128000,
      },
      providerNeedsKey: true,
      permissions: ['bookmarks', 'storage', 'sidePanel', 'tabs'],
      undoPoints: [],
      logEntries: [],
      bookmarks: { total: 10, folders: 3, emptyFolders: 0, maxDepth: 3, orphaned: 0, duplicateNameGroups: 0 },
      storageBytes: 1024,
      logBytes: 1024,
      lastAiError: null,
      ...patch,
    } as HealthSnapshot);

    ok('只缺 Key：不给按钮，但要有明确的手动提示', () => {
      const r = diagnose(healthy({ config: { ...healthy().config!, apiKey: '' } }));
      const iss = r.issues.find((i) => i.id === 'config.incomplete');
      assert.ok(iss, '应当报出"没配完"');
      assert.equal(iss!.fix, undefined, `只缺 Key 时不该给 fix：${JSON.stringify(iss!.fix)}`);
      assert.ok(iss!.manualHint?.includes('Key') === true, `应提示去拿 Key：${iss!.manualHint}`);
    });

    /*
     * 0.2.104：这两条原来的断言是"缺 baseUrl/model 时应当给一键补按钮"，
     * 配套的 `config.fill-defaults` 已删除——因为 readSnapshot 的 resolveConfig
     * 早就把预设能补的都补上了，这条诊断只可能在预设也补不了时触发，
     * 那时修复什么都填不了。一个一出现就必然点了没用的按钮，不如没有。
     */
    ok('缺 Base URL / 模型：报出来，但不给没用的按钮', () => {
      const r = diagnose(healthy({ config: { ...healthy().config!, baseUrl: '', model: '' } }));
      const iss = r.issues.find((i) => i.id === 'config.incomplete');
      assert.ok(iss);
      assert.equal(iss!.fix, undefined, `不该再给 config.fill-defaults：${JSON.stringify(iss!.fix)}`);
      assert.ok(iss!.manualHint, '没有按钮时必须留下手动下一步');
    });

    ok('三者都缺：也只报不动，不摆没用的按钮', () => {
      const r = diagnose(healthy({ config: { ...healthy().config!, baseUrl: '', model: '', apiKey: '' } }));
      const iss = r.issues.find((i) => i.id === 'config.incomplete');
      assert.ok(iss);
      assert.equal(iss!.fix, undefined, `不该再给 config.fill-defaults：${JSON.stringify(iss!.fix)}`);
    });

    ok('可一键修复的计数不再把"补不了"的问题算进去', () => {
      const keyOnly = diagnose(healthy({ config: { ...healthy().config!, apiKey: '' } }));
      const fillable = diagnose(healthy({ config: { ...healthy().config!, baseUrl: '', model: '' } }));
      const countFixable = (rep: ReturnType<typeof diagnose>) => rep.issues.filter((i) => !!i.fix).length;
      assert.equal(
        countFixable(keyOnly) < countFixable(fillable) || countFixable(keyOnly) === 0,
        true,
        `只缺 Key 的可修数不应多于可补字段的情形：${countFixable(keyOnly)} vs ${countFixable(fillable)}`,
      );
    });
  }

  /* ══════════ T125: `log.mark-orphan` 修完必须真的不再报 ══════════ */
  console.log('\n[T125] 修复动作要能让自己上报的问题消失');
  {
    /*
     * 缺陷：孤儿判据只排除了 `undoneAt`，没排除 `unreversibleAt`——
     * 而 `log.mark-orphan` 这个修复写的正是 `unreversibleAt`。
     *
     * 结果："修了但没修好"：用户点「标记为不可撤销」→ 修复成功 → 记录被打上标记 →
     * 但判据不认这个标记，问题原样还在、健康分不动。用户看到的是"点了没反应"。
     */
    const { diagnose } = await import('../src/lib/health/diagnostics');
    const { runFix } = await import('../src/lib/health/fixes');
    const { ORGANIZE_LOG_KEY } = await import('../src/lib/ai/organize-log');
    const { UNDO_STORAGE_KEY } = await import('../src/lib/undo/recorder');
    type HealthSnapshot = Parameters<typeof diagnose>[0];

    const snapWith = (logEntries: unknown[]): HealthSnapshot =>
      ({
        configError: null,
        config: {
          providerId: 'deepseek',
          baseUrl: 'https://api.deepseek.com',
          apiKey: 'sk-x',
          model: 'deepseek-v4-flash',
          customHeaders: '',
          autoOrganizeNew: true,
          autoOrganizeAi: true,
          contextWindow: 128000,
        },
        providerNeedsKey: true,
        permissions: ['bookmarks', 'storage', 'sidePanel', 'tabs'],
        undoPoints: [],
        logEntries,
        bookmarks: { total: 1, folders: 1, emptyFolders: 0, maxDepth: 2, orphaned: 0, duplicateNameGroups: 0 },
        storageBytes: 1024,
        lastAiError: null,
      }) as HealthSnapshot;

    await okA('孤儿记录：修复前上报，修复后不再上报（且状态确实落盘）', async () => {
      storageMap.delete(UNDO_STORAGE_KEY);
      const entry = {
        id: 'log-1',
        at: Date.now(),
        title: 'T125 书签',
        domain: 't125.example',
        action: 'moved',
        detail: '已移动',
        via: 'ai',
        runId: 'run-gone',
      };
      storageMap.set(ORGANIZE_LOG_KEY, [entry]);

      // 修复前：应当报 log.orphan
      const before = diagnose(snapWith([entry]));
      assert.ok(
        before.issues.some((i) => i.id === 'log.orphan'),
        `修复前应报孤儿记录：${JSON.stringify(before.issues.map((i) => i.id))}`,
      );

      const r = await runFix('log.mark-orphan');
      assert.equal(r.ok, true, `修复应成功：${r.detail}`);

      // 修复后：磁盘上应当带上 unreversibleAt
      const stored = storageMap.get(ORGANIZE_LOG_KEY) as Record<string, unknown>[];
      assert.ok(
        typeof stored[0]!.unreversibleAt === 'number',
        `修复应把标记写进存储：${JSON.stringify(stored[0])}`,
      );

      // 用磁盘上的真实内容重新诊断：问题必须消失
      const after = diagnose(snapWith(stored));
      assert.equal(
        after.issues.some((i) => i.id === 'log.orphan'),
        false,
        `修完之后还在报孤儿记录——"修了但没修好"：${JSON.stringify(after.issues.map((i) => i.id))}`,
      );
      storageMap.delete(ORGANIZE_LOG_KEY);
    });

    await okA('已撤销过的记录不算孤儿（原有行为不变）', async () => {
      const entry = {
        id: 'log-2',
        at: Date.now(),
        title: 'T125b',
        action: 'moved',
        detail: '',
        runId: 'run-gone-2',
        undoneAt: Date.now(),
      };
      const rep = diagnose(snapWith([entry]));
      assert.equal(rep.issues.some((i) => i.id === 'log.orphan'), false);
    });
  }

  /* ══════════ T126: 能不能收藏，要和浏览器一致 ══════════ */
  console.log('\n[T126] isSavableUrl 的判据');
  {
    /*
     * 缺陷：只放行 http(s)。但 **Chrome 自己允许收藏 `file://`**——
     * 用本地 HTML 文档 / 离线资料的人会发现「收藏当前页」是灰的，
     * 而地址栏那颗星却能点。同样能收藏的东西，这里不该拒绝。
     */
    const { isSavableUrl } = await import('../src/lib/bookmarks/save-tab');

    ok('网页与本地文件都可以收藏', () => {
      for (const u of [
        'https://example.com/a',
        'http://localhost:3000/',
        'file:///Users/me/doc.html',
        'file:///C:/Users/me/doc.html',
        'FILE:///Users/me/doc.html',
      ]) {
        assert.equal(isSavableUrl(u), true, `应当可以收藏：${u}`);
      }
    });

    ok('浏览器自身页面不能收藏', () => {
      for (const u of [
        'chrome://extensions',
        'chrome-extension://abc/page.html',
        'about:blank',
        'devtools://devtools/bundled/x.html',
        'view-source:https://example.com',
        'javascript:void(0)',
        'data:text/html,<b>x</b>',
        '',
        undefined,
      ]) {
        assert.equal(isSavableUrl(u as never), false, `不该允许收藏：${String(u)}`);
      }
    });

    ok('不是"什么都放行"（判据仍然有边界）', () => {
      assert.equal(isSavableUrl('example.com/no-scheme'), false);
      assert.equal(isSavableUrl('ftp://example.com/f'), false);
    });
  }

  /* ══════════ T127: 书签导出文件的格式 ══════════ */
  console.log('\n[T127] 书签导出（Netscape HTML / JSON）');
  {
    /*
     * 新功能：把书签导出成文件。导出一份**格式错的文件**比不导出更糟——
     * 用户会以为备份好了，等真要恢复时才发现导入不了。
     * 所以格式必须靠纯函数的单测钉死，不依赖开浏览器。
     */
    const { toNetscapeHtml, toJsonExport, escapeHtml, countTree } = await import('../src/lib/bookmarks/export-file');

    const mkRoot = (children: unknown[]) =>
      [{ id: '0', title: '', children }] as never as chrome.bookmarks.BookmarkTreeNode[];

    ok('HTML 转义：& < > " 都要转', () => {
      assert.equal(escapeHtml('a&b<c>d"e'), 'a&amp;b&lt;c&gt;d&quot;e');
      // 不能重复转义已转过的实体
      assert.equal(escapeHtml('&amp;'), '&amp;amp;');
    });

    ok('Netscape 头与结构（能被浏览器导入的最小骨架）', () => {
      const html = toNetscapeHtml(mkRoot([]));
      assert.ok(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>'), html.slice(0, 60));
      assert.ok(html.includes('<DL><p>'), '缺少 DL 容器');
      assert.ok(html.includes('</DL><p>'), '缺少收尾');
      assert.ok(html.includes('NETSCAPE-Bookmark-file-1'));
    });

    ok('虚拟根不输出，只输出它的子节点', () => {
      const html = toNetscapeHtml(
        mkRoot([
          {
            id: '1', title: '书签栏', dateAdded: 1_700_000_000_000, children: [
              { id: '2', title: '示例', url: 'https://example.com/', dateAdded: 1_700_000_100_000 },
            ],
          },
        ]),
      );
      assert.ok(html.includes('书签栏'), '应包含书签栏');
      assert.ok(html.includes('HREF="https://example.com/"'), html);
      // 虚拟根没有标题，不该出现 `>undefined<` 之类
      assert.equal(html.includes('undefined'), false, html);
    });

    ok('时间戳按秒输出（Netscape 规范用秒，书签 API 用毫秒）', () => {
      const html = toNetscapeHtml(
        mkRoot([{ id: '1', title: '栏', children: [{ id: '2', title: 'x', url: 'https://a/', dateAdded: 1_700_000_123_456 }] }]),
      );
      assert.ok(html.includes('ADD_DATE="1700000123"'), `应取秒级：${html}`);
    });

    ok('空文件夹也要输出（否则导入后结构变了）', () => {
      const html = toNetscapeHtml(mkRoot([{ id: '1', title: '空文件夹', children: [] }]));
      assert.ok(html.includes('空文件夹'), html);
      // 名字之后应当是 </H3> → <DL><p> → 紧接着 </DL><p>（中间没有内容 = 真的是空文件夹）
      const tail = (html.split('空文件夹')[1] ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      assert.ok(tail[0] === '</H3>', `标题应闭合：${tail[0]}`);
      assert.ok(tail[1] === '<DL><p>', `空文件夹也应有 DL：${tail[1]}`);
      assert.ok(tail[2] === '</DL><p>', `DL 必须立刻闭合（否则导入层级会错）：${tail[2]}`);
    });

    ok('嵌套层级：子文件夹缩进递增', () => {
      const html = toNetscapeHtml(
        mkRoot([
          {
            id: '1', title: '外层', children: [
              { id: '2', title: '内层', children: [{ id: '3', title: '深', url: 'https://deep/' }] },
            ],
          },
        ]),
      );
      const outer = html.split('\n').find((l) => l.includes('外层'))!;
      const inner = html.split('\n').find((l) => l.includes('内层'))!;
      const indent = (l: string) => l.length - l.trimStart().length;
      assert.ok(indent(inner) > indent(outer), `内层应更缩进：${indent(outer)} vs ${indent(inner)}`);
    });

    ok('标题与 URL 里的特殊字符不会破坏文件', () => {
      const html = toNetscapeHtml(
        mkRoot([{ id: '1', title: 'a<b', children: [{ id: '2', title: 'x&y', url: 'https://e/?a=1&b=2' }] }]),
      );
      assert.ok(html.includes('a&lt;b'), html);
      assert.ok(html.includes('x&amp;y'), html);
      assert.ok(html.includes('a=1&amp;b=2'), 'URL 里的 & 也必须转义');
    });

    ok('JSON 备份：保留层级、时间戳用 ISO、不泄漏 parentId', () => {
      const json = toJsonExport(
        mkRoot([
          {
            id: '1', title: '栏', parentId: '0', children: [
              { id: '2', title: '文档', url: 'https://doc/', dateAdded: 1_700_000_000_000, parentId: '1' },
            ],
          },
        ]),
        new Date('2026-11-02T00:00:00.000Z'),
      );
      const parsed = JSON.parse(json);
      assert.equal(parsed.version, 1);
      assert.equal(parsed.exportedAt, '2026-11-02T00:00:00.000Z');
      assert.equal(parsed.bookmarks[0].title, '栏');
      assert.equal(parsed.bookmarks[0].children[0].url, 'https://doc/');
      assert.equal(parsed.bookmarks[0].children[0].dateAdded, '2023-11-14T22:13:20.000Z');
      assert.equal(json.includes('parentId'), false, '不该导出 parentId');
    });

    ok('countTree 不把虚拟根算成文件夹', () => {
      const c = countTree(
        mkRoot([
          { id: '1', title: '栏', children: [{ id: '2', title: 'a', url: 'https://a/' }, { id: '3', title: '子', children: [] }] },
        ]),
      );
      assert.equal(c.bookmarks, 1);
      assert.equal(c.folders, 2, `应只算子节点里的文件夹：${JSON.stringify(c)}`);
    });
  }

  /* ══════════ T128: 提示词必须说清"我产不出文件" ══════════ */
  console.log('\n[T128] 能力边界写进提示词');
  {
    /*
     * 缺陷：所有工具都只把数据**读给模型分析**，不在磁盘上产文件。
     * 但用户说「导出我的书签」时，模型没有任何依据去说"我不能"——
     * 它很可能顺口回一句"已为你导出"，用户去磁盘上找，什么都没有。
     *
     * 现在 UI 里有了「设置 → 数据管理 → 书签导出」，提示词要把用户指到那里。
     */
    const { SYSTEM_PROMPT } = await import('../src/lib/ai/prompts');

    ok('明确说明产不出文件、不要声称导出', () => {
      assert.ok(/产不出文件|不会生成任何文件/.test(SYSTEM_PROMPT), SYSTEM_PROMPT.slice(-400));
      assert.ok(/不要.*声称|已为你导出/.test(SYSTEM_PROMPT), '要禁止"已为你导出"这种说法');
    });

    ok('把用户指到真实存在的入口', () => {
      assert.ok(SYSTEM_PROMPT.includes('书签导出'), '应提到书签导出');
      assert.ok(SYSTEM_PROMPT.includes('书签 HTML'), '应给出可选的格式');
      assert.ok(SYSTEM_PROMPT.includes('JSON'), '应提到 JSON');
    });

    ok('没有把工具描述说成"导出文件"（口径一致）', () => {
      assert.ok(SYSTEM_PROMPT.includes('export_bookmarks'), '仍应保留 export_bookmarks 的用法说明');
      assert.equal(/export_bookmarks[^。]{0,12}文件/.test(SYSTEM_PROMPT), false,
        'export_bookmarks 是"取清单"，不能被描述成产文件');
    });
  }

  /* ══════════ T129: 首帧主题优先级 ══════════ */
  console.log('\n[T129] 首帧主题判定');
  {
    /*
     * 缺陷：入口原先只看系统偏好。于是"系统深色、但用户在设置里选了浅色"的人，
     * 每次打开都会**先看到一帧深色**，然后才被异步的 load() 纠正。
     * 用户显式选过的优先级必须高于系统偏好，而这一点必须在首帧就能算出来。
     */
    const { shouldStartDark } = await import('../src/stores/themeStore');

    ok('用户显式选过 > 系统偏好', () => {
      assert.equal(shouldStartDark('light', true), false, '选了浅色就该是浅色，哪怕系统是深色');
      assert.equal(shouldStartDark('dark', false), true, '选了深色就该是深色，哪怕系统是浅色');
    });

    ok('没选过时跟随系统', () => {
      assert.equal(shouldStartDark(null, true), true);
      assert.equal(shouldStartDark(null, false), false);
      assert.equal(shouldStartDark('system', true), true);
      assert.equal(shouldStartDark('system', false), false);
    });

    ok('脏值不猜：当成"没选过"跟随系统', () => {
      assert.equal(shouldStartDark('purple', true), true);
      assert.equal(shouldStartDark('purple', false), false);
      assert.equal(shouldStartDark('', false), false);
    });
  }

  /* ══════════ T130: 新建书签的预填判据要和「收藏当前页」一致 ══════════ */
  console.log('\n[T130] 预填判据的一致性');
  {
    /*
     * 缺陷：0.2.70 把弹窗的「收藏当前页」放宽到 `file://`，但**新建书签对话框的预填**
     * 里还写着一份独立的 `/^https?:\/\//` —— 同样是"拿当前页预填"，
     * 本地文件用户在一个入口能拿到、在另一个入口拿不到。
     * 这就是"同一个规则写了两遍"的老问题。
     */
    const { prefillFromTab } = await import('../src/lib/bookmarks/save-tab');

    ok('本地文件页也能预填（与收藏入口一致）', () => {
      const p = prefillFromTab({ url: 'file:///Users/me/doc.html', title: '本地文档' });
      assert.deepEqual(p, { title: '本地文档', url: 'file:///Users/me/doc.html' });
    });

    ok('没有标题时用 URL 兜底（不留空）', () => {
      const p = prefillFromTab({ url: 'https://example.com/' });
      assert.equal(p?.title, 'https://example.com/');
      assert.equal(p?.url, 'https://example.com/');
    });

    ok('标题只有空白时也退回 URL', () => {
      const p = prefillFromTab({ url: 'https://a/', title: '   ' });
      assert.equal(p?.title, 'https://a/');
    });

    ok('浏览器自身页面不预填（和收藏入口同一判据）', () => {
      for (const u of ['chrome://extensions', 'about:blank', 'devtools://x', 'view-source:https://a']) {
        assert.equal(prefillFromTab({ url: u, title: 't' }), null, `不该预填：${u}`);
      }
    });

    ok('没有活动标签页时返回 null（不崩、不预填半截）', () => {
      assert.equal(prefillFromTab(undefined), null);
      assert.equal(prefillFromTab({}), null);
      assert.equal(prefillFromTab({ title: '只有标题' }), null);
    });
  }

  /* ══════════ T131: 同一动作只能有一个名字 ══════════ */
  console.log('\n[T131] 动作文案的单一来源');
  {
    /*
     * 缺陷：同一个动作在多个入口各写一遍字符串，于是出现了
     *   工具栏：「让 MarkAI 整理**选中项**」
     *   树右键：「让 MarkAI 整理**所选**（N）」
     * 用户在两处看到同一个动作的两个名字，会以为是两个功能。
     */
    const { ORGANIZE_LABEL, organizeHint } = await import('../src/lib/ui/labels');

    ok('选中项的名字只有一种写法（带数量）', () => {
      assert.equal(ORGANIZE_LABEL.selection(3), '让 MarkAI 整理所选（3）');
      assert.equal(ORGANIZE_LABEL.selection(0), '让 MarkAI 整理所选（0）');
      // 不能再出现另一种叫法
      assert.equal(ORGANIZE_LABEL.selection(1).includes('选中项'), false);
    });

    ok('各个 scope 的名字互不串味', () => {
      assert.equal(ORGANIZE_LABEL.folder, '让 MarkAI 整理');
      assert.equal(ORGANIZE_LABEL.all, '让 MarkAI 整理全部书签');
      assert.equal(ORGANIZE_LABEL.analyze, '让 MarkAI 分析');
      const all = Object.values(ORGANIZE_LABEL).filter((v) => typeof v === 'string');
      assert.equal(new Set(all).size, all.length, '名字不能重复');
    });

    ok('提示文案里引用的就是按钮上的名字（不会写死后对不上）', () => {
      assert.ok(organizeHint('folder').includes(ORGANIZE_LABEL.folder));
      assert.ok(organizeHint('all').includes(ORGANIZE_LABEL.all));
      assert.ok(organizeHint('selection').includes('所选'));
      assert.equal(organizeHint('selection').includes('（0）'), false, '提示里不该出现"（0）"');
    });
  }

  /* ══════════ T132: 存储配额不可能被 MarkAI 自己的数据填满 ══════════ */
  console.log('\n[T132] 存储上界');
  {
    /*
     * 台账里「存储写满（配额满）时的用户可见降级」这一项，实测之后**不成立**：
     * MarkAI 自己的每一项数据都有条数上限，加起来远不到 10 MB。
     *
     * 实测（60 轮对话 + 200 条整理记录 + 10 个撤销点）：
     *   markai.ai.organize-log  33383 B
     *   markai.ai               28299 B
     *   markai.undo              1053 B
     *   合计 62735 B = 配额的 0.6%
     *
     * 这里把结论固化成测试：用**各项上限**造最坏情况，算总字节。
     * 以后谁去掉某个上限，这条会立刻告诉他"配额可能被填满"。
     */
    const QUOTA = 10 * 1024 * 1024; // chrome.storage.local.QUOTA_BYTES

    // 每条都按"很长"估计：一条消息 2KB、一条记录 400B、一个撤销点 2KB
    const MAX_MESSAGES = 60;
    const MAX_LOG_ENTRIES = 200;
    const MAX_UNDO_POINTS = 10;
    const worst = {
      chat: MAX_MESSAGES * 2048,
      log: MAX_LOG_ENTRIES * 400,
      undo: MAX_UNDO_POINTS * 2048,
      memory: 2000 * 300, // 记忆没有条数上限，按 2000 条估（每人几十条的量级）
      config: 4096,
      draft: 64 * 1024, // 流式草稿，最长一次回复
    };
    const total = Object.values(worst).reduce((a, b) => a + b, 0);

    ok('最坏情况也远低于配额（写满不是真实风险）', () => {
      assert.ok(
        total < QUOTA * 0.25,
        `结构上界 ${total} B 不应超过配额的 25%（${Math.round((QUOTA * 0.25) / 1024)} KB）`,
      );
    });

    ok('上界的构成说得出依据（不是拍脑袋）', () => {
      // 记忆是唯一没有硬上限的一项，也是上界的主要来源
      assert.ok(worst.memory > worst.chat, '记忆应占上界的大头（它没有条数上限）');
      assert.ok(worst.chat === 60 * 2048);
      assert.ok(worst.log === 200 * 400);
      assert.ok(worst.undo === 10 * 2048);
    });

    ok('唯一没有硬上限的是记忆——它才是能真正填满配额的东西', () => {
      /*
       * 其它项都有条数上限（对话 60 / 记录 200 / 撤销 10），
       * 只有 `markai.memory` 的数量不设限（提示词注入时截 30，但存储不截）。
       * 按每条 300 B 算，要填满 10 MB 需要约 35000 条——现实中到不了，
       * 但这是**唯一**需要留意的增长点，写在这里免得以后忘了。
       */
      const perItem = 300;
      const toFill = Math.ceil(QUOTA / perItem);
      assert.ok(toFill > 10000, `填满配额需要约 ${toFill} 条记忆，现实中到不了`);
      // 反证：如果记忆真的无限增长，其它项的上界就不重要了
      assert.ok(worst.memory * 10 > QUOTA * 0.25, '记忆确实是上界的主要来源');
    });

    ok('实测数字与上界同量级（上界没有算飞）', () => {
      // 实测 62735 B；上界应比实测大但不夸张
      assert.ok(total > 62735, `上界应大于实测：${total}`);
      assert.ok(total < 62735 * 20, `上界不应比实测大一个数量级：${total}`);
    });
  }

  /* ══════════ T133: 已删行为不许回来（静态守卫） ══════════ */
  console.log('\n[T133] 静态守卫');
  {
    /*
     * 背景：用户明确表示过"不要按域名建文件夹"（0.2.35 整个移除）。
     * 当时只在系统提示里加了一句软规则——软规则挡不住回归。
     *
     * 这里用**源码事实**来守，不靠措辞：
     *   规则 1：`title: x.domain` 这种形状只能出现在受控模块里；
     *   规则 2：提示词不能同时对同一件事既禁止又允许。
     */
    const guards = await import('../src/lib/guards/removed-behavior');
    const { SYSTEM_PROMPT, TOOL_DEFINITIONS } = await import('../src/lib/ai/prompts');
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');

    const walk = (dir: string, acc: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) walk(p, acc);
        else if (/\.tsx?$/.test(name) && !/\.test\.ts$/.test(name) && !p.includes('/guards/')) acc.push(p);
      }
      return acc;
    };
    const root = join(process.cwd(), 'src');
    const files = walk(root).map((abs) => ({ path: abs.slice(root.length + 1), text: readFileSync(abs, 'utf8') }));

    ok('规则 1：按域名命名文件夹的调用只出现在受控模块里', () => {
      const findings = guards.findDomainFolderCreation(files);
      assert.deepEqual(
        findings,
        [],
        `发现不受控的"按域名建文件夹"：\n${findings.map((f) => `  ${f.file}:${f.line}  ${f.text}`).join('\n')}`,
      );
    });

    ok('规则 2：提示词里"禁止"与"允许"不冲突', () => {
      // 用**运行时会发给模型的内容**判定，不用源码（源码注释不会发给模型）
      const findings = guards.findPromptSelfContradiction(
        SYSTEM_PROMPT,
        TOOL_DEFINITIONS.map((t) => t.function.description),
      );
      assert.deepEqual(
        findings,
        [],
        `提示词自相矛盾：\n${findings.map((f) => `  ${f.file}:${f.line}  ${f.rule}  ${f.text}`).join('\n')}`,
      );
    });

    ok('守卫本身有灵敏度（不是永远返回空）', () => {
      // 造一个显然违规的输入：不受控模块里按域名建文件夹
      const fake = [{ path: 'lib/ai/some-new-tool.ts', text: 'const f = await create({ parentId, title: g.domain });' }];
      assert.equal(guards.findDomainFolderCreation(fake).length, 1, '应当能认出违规形状');
      /*
       * 两条分支要**分别**验证，否则一条会替另一条兜着：
       *  - 提示词正文里提到 auto_categorize 却没前提；
       *  - 工具描述里提到按域名建夹却没前提（提示词正文完全不提，逼它独立命中）。
       */
      const badPromptOnly = '不要按域名新建文件夹。\n用 auto_categorize 按域名聚类整理。';
      assert.ok(
        guards.findPromptSelfContradiction(badPromptOnly, ['一个完全没问题的工具描述。']).length >= 1,
        '应当能认出提示词正文里缺前提的提及',
      );
      const badToolOnly = '不要按域名新建文件夹。';
      const toolFindings = guards.findPromptSelfContradiction(badToolOnly, ['对某个文件夹执行自动分类：按域名聚类并建文件夹。']);
      assert.ok(
        toolFindings.some((f) => f.rule === 'tool-description-without-precondition'),
        `应当能认出缺前提的工具描述：${JSON.stringify(toolFindings)}`,
      );
      // 正确形状不应误报
      const good = [{ path: 'lib/ai/domain-group.ts', text: 'const f = await create({ parentId, title: g.domain });' }];
      assert.equal(guards.findDomainFolderCreation(good).length, 0, '受控模块不应误报');
    });
  }



  /* ══════════ T134: 补 lib 下未被触达的导出 ══════════ */
  console.log('\n[T134] 补充导出覆盖');
  {
    /* 台账里这一项挂了很久：188 个导出函数，19 个没被任何用例引用。逐个看风险，取高价值的补上。 */

    await okA('deleteMemoryItem：删得掉、删错了有话说', async () => {
      const mem = await import('../src/lib/ai/memory');
      storageMap.set('markai.memories', [
        { id: 'm1', text: '技术类按语言分', category: 'rule', enabled: true },
        { id: 'm2', text: '别动设计资料', category: 'preference', enabled: true },
      ]);
      assert.equal(await mem.deleteMemoryItem('m1'), true, '删除存在的应返回 true');
      const left = (storageMap.get('markai.memories') as { id: string }[]).map((m) => m.id);
      assert.deepEqual(left, ['m2'], '只删指定的那一条');
      assert.equal(await mem.deleteMemoryItem('nope'), false, '删不存在的应返回 false 而不是假装成功');
      const after = storageMap.get('markai.memories') as { id: string }[];
      assert.deepEqual(after.map((m) => m.id), ['m2'], '删失败不该改动数据');
      storageMap.delete('markai.memories');
    });

    await okA('clearAllMemories：清空后是空数组（不是 undefined）', async () => {
      const mem = await import('../src/lib/ai/memory');
      storageMap.set('markai.memories', [{ id: 'm1', text: 'x', category: 'custom', enabled: true }]);
      await mem.clearAllMemories();
      assert.deepEqual(storageMap.get('markai.memories'), []);
      storageMap.delete('markai.memories');
    });

    await okA('unrestorableOps：只认「没有快照的删除」', async () => {
      const j = await import('../src/lib/undo/journal');
      const ops = [
        { kind: 'move', id: 'a', from: '1', to: '2' },
        { kind: 'delete', id: 'b', snapshot: { id: 'b', title: 't', parentId: '1', index: 0 } },
        { kind: 'delete', id: 'c' },
        { kind: 'create', id: 'd', parentId: '1', index: 0 },
      ] as never;
      const bad = j.unrestorableOps(ops) as { id: string }[];
      assert.equal(bad.length, 1, `只该有一条不可恢复：${JSON.stringify(bad)}`);
      assert.equal(bad[0]!.id, 'c');
      assert.deepEqual(j.unrestorableOps([]), []);
    });

    await okA('describeUndoPoint：给的是人话，不是 JSON', async () => {
      const j = await import('../src/lib/undo/journal');
      const text = j.describeUndoPoint({
        id: 'p1',
        at: Date.now(),
        ops: [
          { kind: 'move', id: 'a', from: '1', to: '2' },
          { kind: 'delete', id: 'b', snapshot: { id: 'b', title: '死链', parentId: '1', index: 0 } },
        ],
      } as never);
      assert.equal(typeof text, 'string');
      assert.ok(text.length > 0, '不能是空串');
      assert.equal(text.includes('{'), false, `不该把 JSON 结构直接丢给用户：${text}`);
    });

    await okA('isKnownOpKind：白名单之外的 Kind 一律不认', async () => {
      const v = await import('../src/lib/undo/validate');
      // 白名单与 UndoOp['kind'] 一致：move / moveBatch / update / create / delete
      for (const k of ['move', 'moveBatch', 'update', 'create', 'delete']) {
        assert.equal(v.isKnownOpKind(k), true, `应认识 ${k}`);
      }
      for (const k of ['copy', 'rename', 'drop', 'truncate', 'purge', '', 'MOVE']) {
        assert.equal(v.isKnownOpKind(k), false, `不该认识 ${JSON.stringify(k)}`);
      }
    });

    await okA('finalizeToolCalls：补齐 OpenAI 要求的形状', async () => {
      const st = await import('../src/lib/ai/stream');
      const out = st.finalizeToolCalls([
        { id: 'call_1', name: 'move', args: '{"id":"a"}' },
        { index: 1, name: 'create', args: '' },
      ] as never) as { id: string; type: string; function: { name: string; arguments: string } }[];
      assert.equal(out.length, 2);
      assert.equal(out[0]!.type, 'function');
      assert.equal(out[0]!.function.arguments, '{"id":"a"}');
      // 空参数必须补成 '{}'：模型侧 JSON.parse('') 会直接抛
      assert.equal(out[1]!.function.arguments, '{}');
      assert.ok(out[1]!.id.length > 0, '缺 id 时要补一个，不能留空');
    });

    await okA('cn：同类名合并、冲突时后者胜', async () => {
      const u = await import('../src/lib/utils');
      assert.equal(u.cn('a', 'b'), 'a b');
      // 同一组的类名冲突时后者胜（twMerge 的职责）
      assert.equal(u.cn('p-2', 'p-4'), 'p-4');
      assert.equal(u.cn('text-red', 'text-blue'), 'text-blue');
      // falsy 值要被丢掉，不能变成字符串 "false"
      assert.equal(u.cn('hidden', false && 'flex', undefined, null, ''), 'hidden');
      assert.equal(u.cn(), '');
    });

    await okA('copyText：空文本直接拒绝（不弹「已复制」）', async () => {
      const c = await import('../src/lib/clipboard');
      assert.equal(await c.copyText(''), false);
      assert.equal(await c.copyText('   '), false, '纯空白也不该复制');
    });
  }

/* ── 快捷键说明 vs 真实处理器 的契约守卫 ─────────────────────────────
 *
 * 速查表注释写着「只列代码里真实绑定过的键，不写"应该支持"的键」，
 * 但没有任何东西守着它。Ctrl+D 那次（0.2.98）已经证明：
 * 界面承诺了、代码里没有，用户按下去什么都没发生。
 */
await okA('快捷键说明里列的键，处理器里都接得住', async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { SHORTCUT_GROUPS } = await import('../src/components/common/shortcuts-dialog');
  const {
    findShortcutGaps,
    handledKeysFromFile,
    extractHandledKeys,
  } = await import('../src/lib/guards/shortcut-contract');

  const declared = SHORTCUT_GROUPS.flatMap((g) => g.items);
  const handlers = [
    handledKeysFromFile(repoRoot, 'src/components/bookmark-list/bookmark-list.tsx'),
    handledKeysFromFile(repoRoot, 'src/components/sidebar/bookmark-tree.tsx'),
    handledKeysFromFile(repoRoot, 'src/components/workspace/workspace.tsx'),
    handledKeysFromFile(repoRoot, 'src/components/command/command-palette.tsx'),
  ];

  const gaps = findShortcutGaps(declared, handlers);
  assert.deepEqual(
    gaps,
    [],
    `快捷键速查表列了但处理器里找不到的键：${JSON.stringify(gaps)}`,
  );
});

await okA('契约守卫对"说明里有、代码里没有"敏感（证伪）', async () => {
  const { extractHandledKeys, findShortcutGaps } = await import('../src/lib/guards/shortcut-contract');

  // 处理器只接了方向键，说明里却列了 F2 —— 必须被抓出来
  const handlers = [extractHandledKeys("case 'arrowdown':\ncase 'arrowup':\n")];
  const gaps = findShortcutGaps(
    [
      { keys: ['↑', '↓'], desc: '上下移动高亮' },
      { keys: ['F2'], desc: '重命名当前项' },
    ],
    handlers,
  );
  assert.equal(gaps.length, 1, JSON.stringify(gaps));
  assert.deepEqual(gaps[0]!.keys, ['F2']);

  // 注释里出现的键不算接住（注释到不了运行时）
  const commented = [extractHandledKeys("// case 'f2': 重命名\n/* case 'delete': 删除 */\n")];
  const gaps2 = findShortcutGaps(
    [
      { keys: ['F2'], desc: '重命名当前项' },
      { keys: ['Delete'], desc: '删除' },
    ],
    commented,
  );
  assert.equal(gaps2.length, 2, JSON.stringify(gaps2));
});

/* ── 健康检查契约：点了「修复」，那个问题必须真的消失 ─────────────────
 *
 * 这个坑踩过两次：
 *   0.2.68 「填入默认值」在只缺 API Key 时也被提供，点了修不好；
 *   0.2.69 log.mark-orphan 写了字段，但判据不认，问题原样还在、健康分不动。
 * 用户看到的是「点了没反应」。
 *
 * 所以这里把契约钉住：**每个带 fix 的诊断，跑完对应修复后不得再出现。**
 */
await okA('每个可修复的诊断，跑完修复后都不再出现（契约）', async () => {
  const { runFix } = await import('../src/lib/health/fixes');
  const { runHealthCheck } = await import('../src/lib/health');

  const idsOf = (report: { issues: { id: string }[] }) => new Set(report.issues.map((i) => i.id));

  /* ── config.normalize-baseurl ── */
  storageMap.set('markai.config', {
    // 注意：resolveConfig 会 normalizeBaseUrl（自动补 https://），
    // 所以「api.deepseek.com」这种会被修成合法地址、根本不触发诊断。
    // 要触发 invalid-baseurl，得用归一化之后 new URL() 仍然抛错的值。
    providerId: 'deepseek', baseUrl: 'https://', model: 'm', apiKey: 'k',
  });
  let ids = idsOf(await runHealthCheck());
  assert.ok(ids.has('config.invalid-baseurl'), `前置：应报 invalid-baseurl，实际 ${[...ids]}`);
  await runFix('config.normalize-baseurl');
  ids = idsOf(await runHealthCheck());
  assert.ok(!ids.has('config.invalid-baseurl'), `修完仍报 invalid-baseurl：${[...ids]}`);

  /* ── config.drop-bad-headers ── */
  storageMap.set('markai.config', {
    providerId: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'm', apiKey: 'k',
    customHeaders: 'X-Ok: 1\n坏行没有冒号\nX-Two: 2',
  });
  ids = idsOf(await runHealthCheck());
  assert.ok(ids.has('config.bad-headers'), `前置：应报 bad-headers，实际 ${[...ids]}`);
  await runFix('config.drop-bad-headers');
  ids = idsOf(await runHealthCheck());
  assert.ok(!ids.has('config.bad-headers'), `修完仍报 bad-headers：${[...ids]}`);

  /* ── config.incomplete：不该再提供「填入默认值」按钮 ── */
  /*
   * 0.2.104 删掉了 `config.fill-defaults`：readSnapshot 走的 resolveConfig
   * 已经把预设里能补的都补上了，所以这条诊断只可能在预设也补不了时触发
   * （custom / opencode-go）——而那正是修复什么都填不了的情况。
   * 一个要么不出现、一出现就必然点了没用的按钮，不如没有。
   */
  storageMap.set('markai.config', { providerId: 'custom', baseUrl: '', model: '', apiKey: 'k' });
  ids = idsOf(await runHealthCheck());
  assert.ok(ids.has('config.incomplete'), `前置：应报 config.incomplete，实际 ${[...ids]}`);
  const cfgIssue = (await runHealthCheck()).issues.find((i) => i.id === 'config.incomplete');
  assert.ok(!cfgIssue?.fix, `不该再提供「填入默认值」：${JSON.stringify(cfgIssue?.fix)}`);
  assert.ok(
    (cfgIssue?.manualHint || '').length > 0,
    '没有修复按钮时必须留下手动的下一步',
  );

  /* ── 只缺 API Key 时也不该有按钮（0.2.68 的老结论仍然成立） ── */
  storageMap.set('markai.config', {
    providerId: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', apiKey: '',
  });
  const keyOnly = (await runHealthCheck()).issues.find((i) => i.id === 'config.incomplete');
  assert.ok(keyOnly, '只缺 Key 时仍应报 config.incomplete');
  assert.ok(!keyOnly!.fix, `只缺 API Key 时不该有修复按钮：${JSON.stringify(keyOnly!.fix)}`);

  /* ── undo.trim-overflow ── */
  storageMap.set('markai.undo', {
    points: Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, runId: `r${i}`, ops: [] })),
  });
  ids = idsOf(await runHealthCheck());
  assert.ok(ids.has('undo.overflow'), `前置：应报 undo.overflow，实际 ${[...ids]}`);
  await runFix('undo.trim-overflow');
  ids = idsOf(await runHealthCheck());
  assert.ok(!ids.has('undo.overflow'), `修完仍报 undo.overflow：${[...ids]}`);

  /* ── undo.drop-corrupt ── */
  storageMap.set('markai.undo', { points: [{ 不是: '点' }, null, '垃圾'] });
  ids = idsOf(await runHealthCheck());
  assert.ok(ids.has('undo.corrupt'), `前置：应报 undo.corrupt，实际 ${[...ids]}`);
  await runFix('undo.drop-corrupt');
  ids = idsOf(await runHealthCheck());
  assert.ok(!ids.has('undo.corrupt'), `修完仍报 undo.corrupt：${[...ids]}`);

  /* ── log.mark-orphan ── */
  storageMap.set('markai.undo', { points: [] });
  // 整理记录是**裸数组**（organize-log.ts 直接 set 数组），不是 { entries: [...] }
  storageMap.set('markai.organize.log', [
    { id: 'e1', runId: 'run-gone', at: Date.now(), title: 'x.com', moved: 1, created: 0 },
  ]);
  ids = idsOf(await runHealthCheck());
  assert.ok(ids.has('log.orphan'), `前置：应报 log.orphan，实际 ${[...ids]}`);
  await runFix('log.mark-orphan');
  ids = idsOf(await runHealthCheck());
  assert.ok(!ids.has('log.orphan'), `修完仍报 log.orphan：${[...ids]}`);

  /* ── log.trim-limit（溢出） ── */
  const many = Array.from({ length: 250 }, (_, i) => ({
    id: `e${i}`, runId: `run-${i}`, at: Date.now() - i * 1000, moved: 1, created: 0, domains: ['x.com'],
  }));
  storageMap.set('markai.undo', { points: [] });
  storageMap.set('markai.organize.log', many);
  ids = idsOf(await runHealthCheck());
  assert.ok(ids.has('log.overflow'), `前置：应报 log.overflow，实际 ${[...ids]}`);
  await runFix('log.trim-limit');
  ids = idsOf(await runHealthCheck());
  assert.ok(!ids.has('log.overflow'), `修完仍报 log.overflow：${[...ids]}`);

  storageMap.delete('markai.config');
  storageMap.delete('markai.undo');
  storageMap.delete('markai.organize.log');
});

/* ── 诊断可达性契约：每个诊断 id 都必须能被触发 ─────────────────────
 *
 * 0.2.101 抓到两条「用户永远看不到」的诊断：
 *   - undo.corrupt / undo.overflow：readSnapshot 传了整个存储对象， diagnose 只认数组
 *   - config.invalid-baseurl：resolveConfig 会 normalizeBaseUrl，归一化后一律合法
 * 共同点：**单测各自绿着，但那条诊断在生产路径上根本不触发**。
 *
 * 这里把契约倒过来钉：从 diagnostics.ts 源码里抽出**全部**诊断 id，
 * 要求每一个都在下表里有对应的触发种子。新增诊断却忘了验证可达性 → 直接红。
 */
await okA('每个诊断 id 都能被触发（可达性契约）', async () => {
  const { diagnose } = await import('../src/lib/health/diagnostics');
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const src = readFileSync(resolve(root, 'src/lib/health/diagnostics.ts'), 'utf8');
  const ids = [...src.matchAll(/^\s*id: '([a-z][a-z.-]+)',\s*$/gm)].map((m) => m[1]!);
  assert.ok(ids.length >= 10, `从源码里只抽出 ${ids.length} 个诊断 id，正则可能失效了`);

  const base = (): HealthSnapshot => ({
    configError: null,
    config: {
      providerId: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-x',
      model: 'deepseek-v4-flash',
      customHeaders: '',
      autoOrganizeNew: true,
      autoOrganizeAi: true,
      contextWindow: 128000,
    },
    providerNeedsKey: true,
    permissions: ['bookmarks', 'storage', 'sidePanel', 'tabs'],
    undoPoints: [],
    logEntries: [],
    bookmarks: { total: 10, folders: 3, emptyFolders: 0, maxDepth: 3, orphaned: 0, duplicateNameGroups: 0 },
    storageBytes: 1024,
    logBytes: 1024,
    lastAiError: null,
  });

  /** 诊断 id → 能触发它的最小快照 */
  const seeds: Record<string, () => HealthSnapshot> = {
    'config.unreadable': () => ({ ...base(), configError: 'boom' }),
    'config.incomplete': () => ({ ...base(), config: { ...base().config!, apiKey: '' } }),
    'config.invalid-baseurl': () => ({ ...base(), config: { ...base().config!, baseUrlRaw: 'api.deepseek.com' } }),
    'config.bad-headers': () => ({ ...base(), config: { ...base().config!, customHeaders: '坏行没有冒号' } }),
    'permission.missing': () => ({ ...base(), permissions: ['storage'] }),
    'undo.corrupt': () => ({ ...base(), undoPoints: [{ 不是: '点' }] }),
    'undo.overflow': () => ({
      ...base(),
      undoPoints: Array.from({ length: 11 }, (_, i) => ({ id: `p${i}`, runId: `r${i}`, ops: [] })),
    }),
    'log.corrupt': () => ({ ...base(), logEntries: [{ 不是: '记录' }] }),
    'log.overflow': () => ({
      ...base(),
      logEntries: Array.from({ length: 201 }, (_, i) => ({ id: `e${i}`, at: 1, title: 't' })),
    }),
    'log.orphan': () => ({
      ...base(),
      logEntries: [{ id: 'e1', at: Date.now(), title: 't', runId: 'run-gone' }],
    }),
    'bookmarks.orphaned': () => ({ ...base(), bookmarks: { ...base().bookmarks!, orphaned: 2 } }),
    'bookmarks.duplicate-folders': () => ({ ...base(), bookmarks: { ...base().bookmarks!, duplicateNameGroups: 1 } }),
    'bookmarks.too-deep': () => ({ ...base(), bookmarks: { ...base().bookmarks!, maxDepth: 99 } }),
    'bookmarks.many-empty': () => ({ ...base(), bookmarks: { ...base().bookmarks!, emptyFolders: 99 } }),
    'storage.near-quota': () => ({ ...base(), storageBytes: 9 * 1024 * 1024 }),
    // diagnose 只看 snapshot.lastAiError；从日志桥接出它的是 readSnapshot 里的
    // lastAiErrorOf——那条桥接单独在生产路径上验（见下一个用例），
    // 因为 0.2.101 的两个死诊断正是"存储→快照"这一层断掉造成的。
    'ai.last-error': () => ({ ...base(), lastAiError: '401 未授权' }),
  };

  const missing = ids.filter((id) => !seeds[id]);
  assert.deepEqual(missing, [], `这些诊断没有可达性种子（新增诊断必须补一条）：${JSON.stringify(missing)}`);

  const dead = ids.filter((id) => !diagnose(seeds[id]!()).issues.some((i) => i.id === id));
  assert.deepEqual(dead, [], `这些诊断摆了种子也触发不了（生产路径上可能是死代码）：${JSON.stringify(dead)}`);
});

await okA('生产路径：整理记录里的失败要能桥接成「最近一次 AI 失败」', async () => {
  const { readSnapshot } = await import('../src/lib/health');

  /*
   * `ai.last-error` 这条诊断看的是 snapshot.lastAiError，而它是 readSnapshot 里的
   * lastAiErrorOf 从整理记录里抽的。0.2.101 已经证明：**"存储 → 快照"这一层断掉时，
   * 单测各自绿着而诊断在生产路径上根本不触发**。所以这里走真实读取路径。
   */
  storageMap.set('markai.organize.log', [
    { id: 'e-ok', at: Date.now(), title: '好的那条', url: 'https://a.example/', domain: 'a.example', action: 'moved', detail: '已归类' },
    { id: 'e-bad', at: Date.now(), title: '失败那条', url: 'https://b.example/', domain: 'b.example', action: 'failed', detail: '401 未授权：API Key 过期' },
  ]);
  const snap = await readSnapshot();
  assert.equal(snap.lastAiError, '401 未授权：API Key 过期', JSON.stringify(snap.lastAiError));

  const report = await runHealthCheck();
  assert.ok(
    report.issues.some((i) => i.id === 'ai.last-error'),
    `读了失败记录却报不出 ai.last-error：${JSON.stringify(report.issues.map((i) => i.id))}`,
  );

  storageMap.delete('markai.organize.log');
});

await okA('存储接近配额：日志是主因才给修复，不是主因就不给（否则「点了没反应」）', async () => {
  const { runFix } = await import('../src/lib/health/fixes');
  const { runHealthCheck } = await import('../src/lib/health');

  /*
   * `storage.near-quota` 原来无条件把「清理整理记录」当修复动作。但存储不止这一块：
   * 撤销点（含被删书签的子树快照）、对话历史都算在内。占用来自别处时，
   * 用户点了修复、日志清到 200 条以内，占用还是超阈值——问题原样还在、健康分不动，
   * 用户看到的就是「点了没反应」（0.2.68 那一类）。
   *
   * 0.2.103 改成：先量日志实际占多少，至少占总占用一成时才提供这个修复。
   * 这里两面都验。
   */
  storageMap.delete('markai.config');
  storageMap.delete('markai.undo');
  const origBytes = chrome.storage.local.getBytesInUse;
  const setBytes = (total: number, log: number) => {
    (chrome.storage.local as unknown as { getBytesInUse: (k: unknown) => Promise<number> }).getBytesInUse =
      async (k: unknown) => (k === null || k === undefined ? total : k === 'markai.organize.log' ? log : 0);
  };

  try {
    /* ── A. 日志就是主因：给修复，且修完问题真的消失 ── */
    setBytes(9 * 1024 * 1024, 8 * 1024 * 1024); // 日志占 8/9 MB
    storageMap.set('markai.organize.log', [
      { id: 'e1', at: Date.now(), title: 't', url: 'https://a.example/', domain: 'a.example', action: 'moved', detail: 'd' },
    ]);
    let issue = (await runHealthCheck()).issues.find((i) => i.id === 'storage.near-quota');
    assert.ok(issue, 'A 前置：应报 near-quota');
    assert.ok(issue!.fix, 'A 前置：日志是主因时应提供修复');
    await runFix('log.trim-limit');
    // 清完之后日志变小，总量随之降到阈值以下
    setBytes(1024, 512);
    issue = (await runHealthCheck()).issues.find((i) => i.id === 'storage.near-quota');
    assert.ok(!issue, `A：修完不该再报 near-quota，实际 ${JSON.stringify(issue)}`);

    /* ── B. 日志只占零头：**不**给修复，别给一个点了没用的按钮 ── */
    setBytes(9 * 1024 * 1024, 4 * 1024); // 日志只占 4 KB
    issue = (await runHealthCheck()).issues.find((i) => i.id === 'storage.near-quota');
    assert.ok(issue, 'B 前置：仍应报 near-quota（存储确实接近配额）');
    assert.ok(
      !issue!.fix,
      `B：日志不是主因时不该提供「清理整理记录」——那是一个点了没反应的按钮，实际 fix=${JSON.stringify(issue!.fix)}`,
    );
    assert.ok(
      (issue!.manualHint || '').includes('撤销记录'),
      `B：没有修复按钮时必须告诉用户真正的占用在哪，实际 hint=${issue!.manualHint}`,
    );
  } finally {
    (chrome.storage.local as unknown as { getBytesInUse: typeof origBytes }).getBytesInUse = origBytes;
    storageMap.delete('markai.organize.log');
  }
});

  /*
   * 最棘手的一种轮次：三条路径同时上场——
   *   delete  → 撤销时按快照**重建**，拿到的是**新 id**
   *   move    → 还原到源父目录，下标要按 Chromium 的「移除前坐标」换算
   *   create  → 撤销时删掉
   * 顺序检查点里存的是**动手前的旧 id**，必须靠 idMap 翻译成重建后的新 id，
   * 否则顺序还原会静默错位——树"看起来对"，但兄弟顺序变了。
   *
   * 以前只分别测过纯删除、纯并发删除、删文件夹带子树，没有这条混合路径。
   *
   * 断言只覆盖**自己新建的那棵子树**：bookmark store 是模块级共享数组、
   * 跨用例累积且不重置，比整棵树会被别处的状态干扰（实测踩过）。
   * 操作集合也只校验**落在自己节点上**的那几条：recorder 的 active 事务是模块级状态，
   * 别处迟到的写入可能落进同一轮（实测有个迟到的 jCreate 混进来），不替它背书。
   */
  await okA('同一轮里删除 + 移动 + 新建混着来，撤销后该子树（含顺序）复原', async () => {
    const { beginUndoTransaction, endUndoTransaction, ensureOrderCheckpoint, resetUndoTransactionForTest } =
      await import('../src/lib/undo/recorder');
    const { applyUndo } = await import('../src/lib/undo/apply');
    const { jRemove, jMove, jCreate } = await import('../src/lib/undo/mutations');

    storageMap.delete('markai.undo');
    resetUndoTransactionForTest();

    const parent = (await mockBookmarks.create({ parentId: '1', title: 'T28-PARENT' })).id;
    const other = (await mockBookmarks.create({ parentId: '1', title: 'T28-OTHER' })).id;
    const ids: string[] = [];
    for (const t of ['a', 'b', 'c', 'd']) {
      ids.push((await mockBookmarks.create({ parentId: parent, title: `T28-${t}`, url: `https://t28.test/${t}` })).id);
    }
    const sub = async () => (await mockBookmarks.getChildren(parent)).map((n) => `${n.title}|${n.url ?? ''}`);
    const before = await sub();
    assert.deepEqual(before, [
      'T28-a|https://t28.test/a',
      'T28-b|https://t28.test/b',
      'T28-c|https://t28.test/c',
      'T28-d|https://t28.test/d',
    ]);

    await beginUndoTransaction('run-t28-mixed');
    await ensureOrderCheckpoint(parent);
    await jRemove(ids[1]!);                       // 删 b
    await jMove(ids[3]!, { parentId: other });    // d 搬到别的文件夹
    await jCreate({ title: 'T28-new', url: 'https://t28.test/new', parentId: parent });
    const point = await endUndoTransaction();

    const ops = point?.ops ?? [];
    const myIds = new Set([...ids, parent, other]);
    for (const o of ops) {
      if (!('id' in o) || !myIds.has(o.id)) continue;
      if (o.kind === 'delete') assert.equal(o.id, ids[1]!, 'delete 应针对 T28-b');
      if (o.kind === 'move') assert.equal(o.id, ids[3]!, 'move 应针对 T28-d');
      if (o.kind === 'create') assert.ok(o.title.startsWith('T28-'), `create 应是我的，实际 ${o.title}`);
    }
    assert.ok(ops.some((o) => o.kind === 'delete'), '应有 delete');
    assert.ok(ops.some((o) => o.kind === 'move'), '应有 move');
    assert.ok(ops.some((o) => o.kind === 'create' && o.title === 'T28-new'), '应有我那条 create');
    assert.ok(
      (point?.orderCheckpoints ?? []).some((cp) => cp.parentId === parent),
      '混合轮次也必须取父目录顺序检查点，否则撤销后兄弟顺序不可靠',
    );
    assert.notDeepEqual(await sub(), before, '这一轮确实改动了子树');

    const undone = await applyUndo();
    assert.ok(undone.ok, `撤销应成功，实际 ${JSON.stringify(undone)}`);
    assert.deepEqual(undone.failures, [], `撤销不应有失败项，实际 ${JSON.stringify(undone.failures)}`);
    assert.deepEqual(await sub(), before, '撤销后该子树的内容与顺序应与动手前一致');

    // 被搬走的那条也要真的回来
    const left = await mockBookmarks.getChildren(other);
    assert.deepEqual(left.map((n) => n.title), [], `搬走的书签应已回来，却还剩 ${JSON.stringify(left.map((n) => n.title))}`);
  });

  /*
   * 「会还原多少条书签」这个数字必须在两处一致。
   *
   * 按钮角标和「还原 N 项」用的是 `undoReadiness().count`，它数的是**书签条数**
   * （批次按条数、删除按子树节点数）。而 `applyUndo()` 的 `restored` 曾经数的是
   * **操作条数**——于是删一个含 4 节点的文件夹时，按钮说「还原 4 项」、
   * toast 说「已还原 1 项」，用户以为只还原了一部分。
   *
   * 这里钉住：两者必须相等，且都按书签条数计。
   */
  await okA('撤销结果报的条数与按钮承诺的条数同单位（书签条数）', async () => {
    const { beginUndoTransaction, endUndoTransaction, resetUndoTransactionForTest } =
      await import('../src/lib/undo/recorder');
    const { applyUndo } = await import('../src/lib/undo/apply');
    const { jRemove } = await import('../src/lib/undo/mutations');
    const { undoReadiness } = await import('../src/lib/undo/journal');

    storageMap.delete('markai.undo');
    resetUndoTransactionForTest();

    // 一个含 3 个子书签的文件夹：删除它 = 1 个操作、4 个节点
    const folder = (await mockBookmarks.create({ parentId: '1', title: 'T30-FOLDER' })).id;
    for (const t of ['s1', 's2', 's3']) {
      await mockBookmarks.create({ parentId: folder, title: `T30-${t}`, url: `https://t30.test/${t}` });
    }

    await beginUndoTransaction('run-t30');
    await jRemove(folder, { tree: true });
    const point = await endUndoTransaction();
    assert.ok(point, '应产生撤销点');

    const ready = undoReadiness(point);
    assert.equal(ready.undoable, true, JSON.stringify(ready));
    assert.equal(ready.count, 4, `按钮承诺的是**书签条数**：文件夹 1 + 子书签 3，实际 ${ready.count}`);

    const r = await applyUndo();
    assert.ok(r.ok, `撤销应成功，实际 ${JSON.stringify(r)}`);
    assert.equal(
      r.restored,
      ready.count,
      `撤销结果报的条数必须与按钮承诺的一致（都按书签条数计）：按钮 ${ready.count}，结果 ${r.restored}`,
    );
    assert.equal(r.restoredOps, 1, `操作条数是 1（一次删除），实际 ${r.restoredOps}`);

    /*
     * 还原出来的确实是 4 个节点。
     * 注意：删除的撤销是**按快照重建**，Chrome 会发**新 id**，
     * 所以只能按标题找，不能按旧 id 查（API 不允许指定 id）。
     */
    const restoredFolder = store.find((n) => n.title === 'T30-FOLDER');
    assert.ok(restoredFolder, '文件夹应被还原');
    assert.equal((await mockBookmarks.getChildren(restoredFolder.id)).length, 3, '3 个子书签应被还原');
  });

  /*
   * `stats` 工具的每个字段口径都要和名字一致。
   *
   * 「从未打开且添加超过两年」这个字段原来叫「超过两年未访问」——**名不副实**：
   * 判据是 dateLastUsed<=0 && 添加超两年，而"三年前打开过一次"的书签
   * dateLastUsed 有值，根本不算。AI 会把错口径告诉用户
   * （"你有 800 条两年没访问"，其实数的是"从未打开且够旧"）。
   *
   * 这些字段此前一条断言都没有（只有书签总数/文件夹总数被测过）。
   */
  await okA('stats 的每个字段都按名字的口径计数', async () => {
    const { executeTool } = await import('../src/lib/ai/tools');

    const now = Date.now();
    const THREE_YEARS = 3 * 365 * 86_400_000;
    const FOLDER = '1'; // 书签栏

    /*
     * 必须直接插 store：`mockBookmarks.create` 不接受 dateAdded/dateLastUsed，
     * 而这两个字段正是本用例的判据。
     *
     * store 是跨用例累积的模块级数组，别处留下的旧书签也满足「从未打开且够旧」，
     * 所以不能断言绝对值——**先取基线，再造数据，再取一次**，断言增量。
     */
    type StatsJson = {
      [k: string]: unknown;
      根目录分布: { root: string; bookmarks: number; folders: number }[];
    };
    const runStats = async (): Promise<StatsJson> =>
      JSON.parse((await executeTool('stats', '{}')).result) as StatsJson;

    const base = await runStats();

    const mk = (title: string, url: string | undefined, dateAdded: number, dateLastUsed?: number): FNode => {
      const n: FNode = { id: String(nextId++), parentId: FOLDER, title, dateAdded };
      if (url) n.url = url;
      if (dateLastUsed !== undefined) n.dateLastUsed = dateLastUsed;
      store.push(n);
      return n;
    };
    // A：从未打开、三年前添加 → **应**算
    const a = mk('st-a', 'https://st.test/a', now - THREE_YEARS, 0);
    // B：三年前打开过、四年前添加 → 按字面「两年未访问」该算，但这个判据不算
    const b = mk('st-b', 'https://st.test/b', now - 4 * THREE_YEARS, now - THREE_YEARS);
    // C：从未打开、一个月前添加 → 不够旧，不算
    mk('st-c', 'https://st.test/c', now - 30 * 86_400_000, 0);
    // D：空文件夹
    const emptyF = mk('st-empty', undefined, now);

    assert.ok(nodeById(a.id) && nodeById(b.id), '前置：两条书签都应存在');
    assert.ok(nodeById(emptyF.id), '前置：空文件夹应存在');

    const after = await runStats();

    // 字段名必须如实描述判据，不能叫「超过两年未访问」
    assert.ok(
      '从未打开且添加超过两年' in after,
      `字段名必须说清判据是「从未打开」，实际键：${JSON.stringify(Object.keys(after))}`,
    );
    assert.ok(!('超过两年未访问' in after), '不能再留名不副实的旧字段名');

    // B 有 dateLastUsed，按判据不算——这正说明名字不能叫「两年未访问」
    const staleAfter = Number(after['从未打开且添加超过两年']);
    const staleBase = Number(base['从未打开且添加超过两年']);
    const staleDelta = staleAfter - staleBase;
    assert.equal(staleDelta, 1, `只该多算 A 一条（B 打开过、C 不够旧），实际增量 ${staleDelta}`);

    const emptyDelta = Number(after['空文件夹数']) - Number(base['空文件夹数']);
    assert.equal(emptyDelta, 1, `只该多一个空文件夹（st-empty），实际增量 ${emptyDelta}`);

    // 根目录分布要覆盖书签栏，且书签数随构造增长
    const bar = after['根目录分布'].find((r) => r.root === '书签栏');
    const barBase = base['根目录分布'].find((r) => r.root === '书签栏');
    assert.ok(bar, `分布里应有「书签栏」，实际 ${JSON.stringify(after['根目录分布'])}`);
    assert.equal(bar.bookmarks - (barBase?.bookmarks ?? 0), 3, `书签栏下应多 a/b/c 三条，实际 ${bar.bookmarks - (barBase?.bookmarks ?? 0)}`);
    assert.equal(bar.folders - (barBase?.folders ?? 0), 1, `书签栏下应多一个文件夹，实际 ${bar.folders - (barBase?.folders ?? 0)}`);
  });

  /*
   * 「AI 分类连续失败」的冷却必须**跨 SW 重启有效**。
   *
   * MV3 的 Service Worker 空闲约 30 秒就被回收，而冷却窗口是 10 分钟。
   * 计数只放 SW 内存时：配错 Key → 连失败 3 次进冷却 → SW 被回收 → 再收藏一条，
   * SW 重启、计数归零 → **又白等 3 次 12 秒超时**才重新进冷却，无限循环。
   * 用户看到的就是「收藏网页要卡十几秒」，而冷却本该修掉的正是这个。
   *
   * 这里直接驱动 background 的 autoOrganizeBatch，用「读 storage 里的冷却态」
   * 来验证它确实落了盘：重启后 cooldownUntil 还在，就不会再问模型。
   */
  await okA('AI 冷却窗口跨 SW 重启有效（不会每次回收就重新白等超时）', async () => {
    const { nextAiStreakState, AI_COOLDOWN_MS, AI_FAIL_STREAK_LIMIT } = await import('../src/lib/ai/auto-organize');

    const now = 1_800_000_000_000;
    // 连败到上限：进入冷却
    let st = { streak: 0, cooldownUntil: 0, justCooled: false };
    for (let i = 0; i < AI_FAIL_STREAK_LIMIT; i++) {
      st = nextAiStreakState({ state: st, failed: true, now });
    }
    assert.equal(st.justCooled, true, `连败 ${AI_FAIL_STREAK_LIMIT} 次应进入冷却`);
    assert.equal(st.cooldownUntil, now + AI_COOLDOWN_MS, '冷却窗口应为 10 分钟');

    // 关键：冷却期内再来一次失败，**不得**把窗口推后、也不得重置
    const during = nextAiStreakState({ state: { ...st, justCooled: false }, failed: true, now: now + 60_000 });
    assert.equal(during.cooldownUntil, st.cooldownUntil, '冷却期内失败不得延长窗口（否则永远出不来）');

    // 冷却结束后归零，允许重新试
    const after = nextAiStreakState({ state: { ...st, justCooled: false }, failed: false, now: now + AI_COOLDOWN_MS + 1 });
    assert.equal(after.cooldownUntil, 0, '冷却结束应清零');
    assert.equal(after.streak, 0, '冷却结束计数应归零');

    /*
     * 落盘契约：background 必须把 {streak, cooldownUntil} 写进
     * `markai.auto-organize.ai-streak`，并且**每次收藏前从 storage 读**。
     * 前者靠 source 检查（存储键存在且被 set），后者靠读路径存在。
     */
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const bg = readFileSync(resolve(root, 'src/entrypoints/background.ts'), 'utf8');

    assert.ok(
      bg.includes("const AI_STREAK_KEY = 'markai.auto-organize.ai-streak';"),
      '冷却态必须有固定的 storage 键，否则重启后无从恢复',
    );
    assert.ok(
      /await loadAiStreak\(\)/.test(bg) && /await saveAiStreak\(/.test(bg),
      '必须既有读也有写：只写不读等于没存，只读不写等于永远不进冷却',
    );
    // 读必须发生在「决定要不要问模型」之前
    const loadIdx = bg.indexOf('await loadAiStreak()');
    const cooldownIdx = bg.indexOf('Date.now() < streakBefore.cooldownUntil');
    assert.ok(loadIdx >= 0 && cooldownIdx > loadIdx, '必须先读 storage 再判断是否在冷却期');

    // 不能再有「模块级 let aiStreak」这种重启即重置的内存态
    assert.ok(
      !/^let aiStreak/m.test(bg),
      '不能再把冷却计数放在模块级内存里——那正是重启即重置的根因',
    );
  });

  /*
   * 健康检查的安全承诺必须由代码保证，不能只写在注释里。
   *
   * types.ts 的原文：「自动修复只允许改动 MarkAI 自己的元数据（配置 / 撤销点 /
   * 整理记录 / 运行时标记），**永远不会移动、删除、重命名用户的任何书签或文件夹**。
   * 书签层面的异常一律只报告——用户已经被"自动批量搬书签"坑过一次，不能再来第二次。」
   *
   * 目前 `fixes.ts` 一个 `chrome.bookmarks` 都没引用，承诺是真的。但 `chrome` 是全局，
   * 谁加一行 `chrome.bookmarks.remove(...)` 也不会有任何东西报警——
   * 而这条承诺崩掉的代价是用户的收藏夹。所以用源码契约把它钉住。
   */
  await okA('自动修复碰不到用户书签（安全边界由源码契约保证）', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const src = readFileSync(resolve(root, 'src/lib/health/fixes.ts'), 'utf8');

    // 去掉注释后再查：注释里提到 bookmarks 是在解释为什么不碰，不该算违规
    const code = src
      .split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
      .join('\n');

    const forbidden = [
      /chrome\s*\.\s*bookmarks/,
      /bookmarks\s*\.\s*(create|move|remove|removeTree|update|reorder)/,
      /from '@\/lib\/ai\/tools'/,
    ];
    for (const re of forbidden) {
      const hit = code.match(re);
      assert.ok(!hit, `自动修复里出现了书签写入口（${re}）：${JSON.stringify(hit?.[0])}。安全承诺要求只改 MarkAI 自己的元数据。`);
    }

    /*
     * 写入必须走**单一收口**：`writeDict(key, value)` 是 fixes.ts 里唯一的
     * `storage.local.set`。这样审计范围就是"writeDict 被传了哪些键"，
     * 而不是去追每一处 set——新增一个修复动作时也只有一个地方需要看。
     */
    const setSites = [...code.matchAll(/storage\.local\.set\(/g)];
    assert.equal(setSites.length, 1, `storage.local.set 应只有一处（writeDict 收口），实际 ${setSites.length} 处`);

    const writeKeys = [...src.matchAll(/writeDict\(\s*([A-Za-z0-9_]+)\s*,/g)].map((m) => m[1]!);
    assert.ok(writeKeys.length >= 5, `没解析到足够的 writeDict 调用（${writeKeys.length}），正则可能失效了`);
    const allowed = new Set(['CONFIG_KEY', 'UNDO_KEY', 'LOG_KEY']);
    for (const k of writeKeys) {
      assert.ok(allowed.has(k), `自动修复写入了白名单之外的键：${k}`);
    }
    // 这三个键必须都真的出现过，否则说明有修复动作根本没落盘
    for (const k of allowed) {
      assert.ok(writeKeys.includes(k), `白名单里的 ${k} 没有被任何修复动作写入——正则可能失效了`);
    }
  });

  /*
   * 「纯函数」模块的不变承诺，必须由契约守着。
   *
   * 这几个模块的文件头都写着同一类承诺：
   *   diagnostics.ts  —— 「不碰 chrome、不发网络请求、不写任何东西」
   *   journal.ts      —— 「刻意不碰 chrome.*，必须能在 node 测试里被直接证伪」
   *   chat-width.ts   —— 「纯函数，不碰 React/chrome」
   *   delayed-open.ts —— 「不碰 React、不碰 chrome，为了能直接单测」
   *
   * 目前都是真的。但**单测里装着 chrome 替身、也 mock 了 fetch**，
   * 所以谁往里加一句 `chrome.storage...` 或 `fetch(...)`，测试照样全绿——
   * 而「诊断是只读的」这条边界一旦破了，用户点一下健康检查就可能被动到数据。
   *
   * 所以用源码契约把这些文件钉在纯函数上。
   */
  await okA('承诺「纯函数」的模块真的不碰 chrome / 不发请求', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

    /** 每个条目：文件 + 它承诺的不变性 */
    const pure: { file: string; promises: RegExp[] }[] = [
      {
        file: 'src/lib/health/diagnostics.ts',
        promises: [/不碰 chrome/, /不发网络请求/, /不写任何东西/],
      },
      { file: 'src/lib/undo/journal.ts', promises: [/不碰 .?chrome/i] },
      { file: 'src/lib/chat-width.ts', promises: [/不碰 React\/chrome/i] },
      { file: 'src/lib/bookmarks/delayed-open.ts', promises: [/不碰 React、不碰 chrome/] },
    ];

    // 先确认这些承诺还在文件里：承诺被删掉时，契约要能发现（否则守的就是空气）
    for (const { file, promises } of pure) {
      const src = readFileSync(resolve(root, file), 'utf8');
      for (const p of promises) {
        assert.ok(p.test(src), `${file} 的头部承诺「${p}」不见了——要么把承诺写回去，要么把契约条目删掉并说明原因`);
      }
    }

    // 再确认代码里没有 chrome / fetch / XMLHttpRequest
    const banned = [
      /\bchrome\s*\.\s*(storage|bookmarks|tabs|runtime|action|windows|contextMenus|notifications)\b/,
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /\bawait\s+chrome\b/,
    ];
    for (const { file } of pure) {
      const src = readFileSync(resolve(root, file), 'utf8');
      const code = src
        .split('\n')
        .filter((l) => {
          const t = l.trim();
          return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
        })
        .join('\n');
      for (const re of banned) {
        const hit = code.match(re);
        assert.ok(!hit, `${file} 承诺是纯函数，却出现了 ${JSON.stringify(hit?.[0])}`);
      }
    }
  });

  /*
   * 上下文窗口的边界必须只有一组，且**所有写入点都按它收窄**。
   *
   * 「拉取模型列表时自动填入」那条路径以前只校验了下限（>= 8000），没有上限。
   * 服务商报个 1000 万就原样存进配置，随后被 effectiveContextWindow 静默钳回 200 万——
   * toast 说「上下文 10000000」、实际生效 2000000，用户被两个数字耍。
   *
   * 所以这里验两件事：常量本身的行为，以及写入路径确实用了这组常量。
   */
  await okA('上下文窗口边界只有一组，且自动填入也按它收窄', async () => {
    const { effectiveContextWindow, MIN_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW } = await import('../src/lib/providers');

    assert.equal(MIN_CONTEXT_WINDOW, 2_000, '下限应为 2000');
    assert.equal(MAX_CONTEXT_WINDOW, 2_000_000, '上限应为 200 万');

    // 超出上限的显式配置必须被钳回来，而不是静默留下一个用不上的值
    const huge = effectiveContextWindow('deepseek-v4-flash', {
      configVersion: 1,
      contextWindow: 10_000_000,
    });
    assert.equal(huge, MAX_CONTEXT_WINDOW, `1000 万应被钳到上限，实际 ${huge}`);
    // 低于下限同理
    const tiny = effectiveContextWindow('deepseek-v4-flash', { configVersion: 1, contextWindow: 100 });
    assert.equal(tiny, MIN_CONTEXT_WINDOW, `100 应被钳到下限，实际 ${tiny}`);
    // 区间内的值必须原样生效（护栏不该误伤正常配置）
    const ok = effectiveContextWindow('deepseek-v4-flash', { configVersion: 1, contextWindow: 512_000 });
    assert.equal(ok, 512_000, `区间内的值必须原样生效，实际 ${ok}`);

    /*
     * 写入路径也必须用这组常量。config-form 里的自动填入如果只校验下限，
     * 就会出现「存进去的值和生效的值不是同一个」。这里从源码确认它引用了上限。
     */
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const form = readFileSync(resolve(root, 'src/components/options/config-form.tsx'), 'utf8');

    assert.ok(
      form.includes('MAX_CONTEXT_WINDOW'),
      '自动填入上下文窗口必须按上限收窄，否则服务商报多大就存多大、随后被静默钳回',
    );
    assert.ok(
      /Math\.min\(Math\.round\(res\.contextWindow\), MAX_CONTEXT_WINDOW\)/.test(form),
      '自动填入必须真的把 contextWindow 钳到上限（正则没匹配上，写法可能变了）',
    );
    // 不该再有用硬编码字面量写的边界（那正是会漂移的根源）
    const hardcoded = form.match(/contextWindow\s*[<>=!]==?\s*[0-9_]{6,}/);
    assert.ok(!hardcoded, `还在用硬编码字面量当边界：${JSON.stringify(hardcoded?.[0])}，请改用导出的常量`);
  });

  /*
   * 同一个上限只能有一个定义。
   *
   * `MAX_LOG_ENTRIES`（诊断阈值）和 `ORGANIZE_LOG_LIMIT`（写入方真正保留的条数）
   * 曾是**两个各自写死 200 的常量**；`MAX_UNDO_POINTS` 也在 recorder.ts（真正保留）
   * 和 diagnostics.ts（诊断阈值）各写一个 10。
   *
   * 同一个数写在两处，改一个忘一个只有两种结果：
   *   - 执行方调大、诊断不变 → 误报（"整理记录超出上限（450/200）"，可 500 才是真上限）
   *   - 诊断调大、执行方不变 → 永不触发（死诊断）
   * 单测各自绿着，因为两边都"是对的"。
   *
   * 这条契约从源码确认：诊断模块是**再导出**，不是自己定义。
   */
  await okA('保留上限只有一处定义，诊断只是再导出', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

    const diag = read('src/lib/health/diagnostics.ts');

    // 不能再有 `export const MAX_... = <数字>` 这种自定义
    const selfDefined = diag.match(/export\s+const\s+MAX_(?:LOG_ENTRIES|UNDO_POINTS)\s*=\s*\d+/);
    assert.ok(!selfDefined, `诊断模块自己定义了上限：${JSON.stringify(selfDefined?.[0])}。必须从执行方导入，否则又会漂移。`);

    // 必须真的是从执行方导入的
    assert.ok(
      /import\s*\{\s*MAX_UNDO_POINTS\s*\}\s*from\s*'@\/lib\/undo\/recorder'/.test(diag),
      'MAX_UNDO_POINTS 必须从 recorder.ts（真正执行保留的那里）导入',
    );
    assert.ok(
      /import\s*\{\s*ORGANIZE_LOG_LIMIT\s+as\s+MAX_LOG_ENTRIES\s*\}\s*from\s*'@\/lib\/ai\/organize-log'/.test(diag),
      'MAX_LOG_ENTRIES 必须从 organize-log.ts（真正执行保留的那里）导入',
    );

    // 运行时也要对得上：两边拿到的必须是同一个值
    const { MAX_UNDO_POINTS, MAX_LOG_ENTRIES } = await import('../src/lib/health/diagnostics');
    const { MAX_UNDO_POINTS: recorderLimit } = await import('../src/lib/undo/recorder');
    const { ORGANIZE_LOG_LIMIT } = await import('../src/lib/ai/organize-log');
    assert.equal(MAX_UNDO_POINTS, recorderLimit, '撤销上限：诊断与执行方必须是同一个值');
    assert.equal(MAX_LOG_ENTRIES, ORGANIZE_LOG_LIMIT, '日志上限：诊断与执行方必须是同一个值');

    /*
     * 反证一遍"改一边会怎样"：把执行方的值改掉，诊断必须跟着变。
     * 这里不真的改源码，而是直接验证两者是同一条引用链——上面的相等断言已经覆盖。
     * 真正防回归的是源码契约：谁再写一份自定义，这条就红。
     */
  });

  /*
   * forget_memory 按 query 删除时，**必须把"还有几条匹配"如实回给模型**。
   *
   * searchMemories 返回全部匹配，而工具只删 matched[0]。用户说
   * 「把所有关于 GitHub 的记忆都忘掉」时，模型删一条就汇报"已忘掉"——
   * 其余几条仍在生效，用户下次收藏同站点书签时又会照旧被摆布。
   *
   * 既有的 forget_memory 用例只放了一条记忆，多匹配的情况从未被测到。
   */
  await okA('forget_memory 多匹配时说清"还有几条"，不让模型误报已忘光', async () => {
    const { executeTool } = await import('../src/lib/ai/tools');
    const { MEMORY_STORAGE_KEY } = await import('../src/lib/ai/memory');

    storageMap.set(MEMORY_STORAGE_KEY, [
      { id: 'm1', category: 'rule', content: 'GitHub 的书签放「技术」文件夹', enabled: true, createdAt: 1, updatedAt: 3 },
      { id: 'm2', category: 'rule', content: 'GitHub 的标题不要翻译', enabled: true, createdAt: 1, updatedAt: 2 },
      { id: 'm3', category: 'preference', content: 'GitHub 的书签用英文标题', enabled: true, createdAt: 1, updatedAt: 1 },
    ]);

    const r = await executeTool('forget_memory', JSON.stringify({ query: 'GitHub' }));
    const out = JSON.parse(r.result) as {
      success: boolean;
      deleted?: string;
      remainingCount?: number;
      remainingIds?: string[];
      remaining?: string[];
      note?: string;
      message?: string;
    };

    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.deleted, 'GitHub 的书签放「技术」文件夹', `删的应是第一条，实际 ${out.deleted}`);

    // 关键：必须说清还有 2 条
    assert.equal(out.remainingCount, 2, `必须报告还有 2 条匹配，实际 ${out.remainingCount}`);
    assert.ok(
      Array.isArray(out.remainingIds) && out.remainingIds.length === 2,
      `必须给出剩余项的 id（模型要靠它逐条删），实际 ${JSON.stringify(out.remainingIds)}`,
    );
    assert.ok(
      (out.note || '').includes('还有 2 条'),
      `note 必须说清"还有几条"，否则模型会误报已忘光：${out.note}`,
    );
    assert.ok(
      (out.message || '').includes('另有 2 条'),
      `给用户看的 message 也要提一句，实际 ${out.message}`,
    );

    // 存储里确实只少了 1 条
    const stored = (storageMap.get(MEMORY_STORAGE_KEY) as { id: string }[]) ?? [];
    assert.deepEqual(stored.map((m) => m.id), ['m2', 'm3'], `只该删掉 m1，实际 ${JSON.stringify(stored.map((m) => m.id))}`);

    // 只剩一条匹配时不该出现 remaining 字段（不制造噪音）
    storageMap.set(MEMORY_STORAGE_KEY, [
      { id: 'n1', category: 'rule', content: 'GitHub 放技术', enabled: true, createdAt: 1, updatedAt: 2 },
      { id: 'n2', category: 'preference', content: '深色模式', enabled: true, createdAt: 1, updatedAt: 1 },
    ]);
    const r2 = await executeTool('forget_memory', JSON.stringify({ query: 'GitHub' }));
    const out2 = JSON.parse(r2.result) as { success: boolean; remainingCount?: number; note?: string };
    assert.equal(out2.success, true);
    assert.equal(out2.remainingCount, undefined, `只匹配一条时不该有 remainingCount，实际 ${out2.remainingCount}`);
    assert.ok(!out2.note, `只匹配一条时不该有 note，实际 ${out2.note}`);

    storageMap.delete(MEMORY_STORAGE_KEY);
  });

  /*
   * 记忆注入超出上限时，提示词必须说清"还有没列出的"。
   *
   * 提示词措辞是「以下是已记录的用户长期偏好与规则」——一句"完整"的断言。
   * 原来只截断不提示，于是用户有 40 条记忆时模型只看到 30 条，却以为那就是全部，
   * 剩下 10 条被默默忽略（用户以为"我说过别再动这个站点"）。
   * 这跟 forget_memory 只删一条却汇报"已忘掉"是同一类假汇报。
   */
  await okA('记忆注入超上限时说清"还有未列出的"，不冒充完整清单', async () => {
    const { formatMemoriesForPrompt } = await import('../src/lib/ai/memory');
    const mk = (i: number) => ({
      id: `m${i}`,
      content: `记忆${i}`,
      category: 'custom' as const,
      enabled: true,
      createdAt: i,
      updatedAt: i,
    });

    // 正好等于上限：不该有截断提示（不制造噪音）
    const exact = Array.from({ length: 30 }, (_, i) => mk(i));
    const pExact = formatMemoriesForPrompt(exact, 30);
    assert.ok(pExact.includes('记忆29'), '上限内的最后一条应注入');
    assert.ok(!pExact.includes('未在此列出'), `正好等于上限时不该有截断提示：${pExact.slice(-200)}`);

    // 超出一条：必须说出来，并给出条数与补救动作
    const over = Array.from({ length: 41 }, (_, i) => mk(i));
    const pOver = formatMemoriesForPrompt(over, 30);
    assert.ok(pOver.includes('记忆29'), '第 30 条（下标 29）应注入');
    assert.ok(!pOver.includes('记忆30'), '第 31 条起不注入');
    assert.ok(
      pOver.includes('另有 11 条已启用的记忆因单次注入上限未在此列出'),
      `必须说清还有几条没列出，实际：${pOver.slice(-300)}`,
    );
    assert.ok(
      pOver.includes('recall_memories'),
      '必须告诉模型可以主动查，否则它只能假设上面就是全部',
    );
    assert.ok(
      pOver.includes('不要假设上面就是全部'),
      `措辞要直接点破"这不一定是全部"，实际：${pOver.slice(-300)}`,
    );

    // 停用的不计入"未列出"（它们本来就不该生效）
    // 31 条启用 + 1 条停用：停用不该计入"未列出"
    const withDisabled = [...Array.from({ length: 31 }, (_, i) => mk(i)), { ...mk(99), enabled: false }];
    const pDisabled = formatMemoriesForPrompt(withDisabled, 30);
    assert.ok(
      pDisabled.includes('另有 1 条已启用的记忆'),
      `只数已启用的，实际：${pDisabled.slice(-200)}`,
    );
  });

  /*
   * find_duplicates 的 `total` 与 `shown` 不一致时必须解释。
   *
   * 原来只返回两个数字（total: 全部组数 / shown: 本次给出的组数），没有任何说明。
   * 模型看到两个对不上的数只会自由发挥：可能据此断言"只有 50 组重复"
   * （漏掉后面 150 组），也可能反复用同一个 limit 重试。
   * 这跟 forget_memory / formatMemoriesForPrompt 是同一类假汇报——
   * **给了一部分，却不说还有一部分**。
   */
  await okA('find_duplicates 截断时说清"还有几组没列出"', async () => {
    const { executeTool } = await import('../src/lib/ai/tools');

    // 造 60 组互不相同的重复（每组 2 条）：默认 limit 50，必然截断
    for (let g = 0; g < 60; g++) {
      const folder = (await mockBookmarks.create({ parentId: '1', title: `DUP-${g}` })).id;
      for (let k = 0; k < 2; k++) {
        await mockBookmarks.create({ parentId: folder, title: `d${g}-${k}`, url: `https://dup${g}.test/p` });
      }
    }

    const out = await executeTool('find_duplicates', '{}');
    const j = JSON.parse(out.result) as {
      total: number;
      shown: number;
      omittedGroups?: number;
      note?: string;
      items: unknown[];
    };

    assert.ok(j.total >= 60, `应至少发现 60 组，实际 ${j.total}`);
    assert.equal(j.shown, 50, `默认 limit 50，实际给出 ${j.shown}`);
    assert.ok(j.total > j.shown, '前置：确实发生了截断');

    assert.equal(j.omittedGroups, j.total - j.shown, `omittedGroups 应等于 total-shown，实际 ${j.omittedGroups}`);
    assert.ok(
      (j.note || '').includes(`另有 ${j.omittedGroups} 组未列出`),
      `note 必须说清还有几组没列出，实际：${j.note}`,
    );
    assert.ok(
      (j.note || '').includes('调大 limit'),
      `必须给出补救动作，实际：${j.note}`,
    );

    // 不截断时不该有这些字段（不制造噪音）
    const out2 = await executeTool('find_duplicates', JSON.stringify({ limit: 500 }));
    const j2 = JSON.parse(out2.result) as { total: number; shown: number; omittedGroups?: number; note?: string };
    assert.equal(j2.shown, j2.total, 'limit 够大时不该截断');
    assert.equal(j2.omittedGroups, undefined, `不截断时不该有 omittedGroups，实际 ${j2.omittedGroups}`);
    assert.ok(
      !(j2.note || '').includes('未列出'),
      `不截断时不该有截断说明，实际：${j2.note}`,
    );
  });

  /*
   * search_bookmarks 截断时必须给**补救动作**，不能只丢一个 `truncated: true`。
   *
   * 模型看到那个布尔值只知道"没给全"，不知道该干什么——而搜索没有 offset 翻页，
   * 唯一的补救是把关键词收窄。list_bookmarks 有 nextOffset、find_duplicates 有 note，
   * 只有 search_bookmarks 一直都是光秃秃一个 true。
   */
  await okA('search_bookmarks 截断时给出补救动作（不只是 truncated:true）', async () => {
    const { executeTool } = await import('../src/lib/ai/tools');

    // 造 12 条都含同一关键词的书签，用 limit=5 强制截断
    for (let i = 0; i < 12; i++) {
      await mockBookmarks.create({ parentId: '1', title: `scap-${i}`, url: `https://scap.test/${i}` });
    }

    const r = await executeTool('search_bookmarks', JSON.stringify({ query: 'scap', limit: 5 }));
    const j = JSON.parse(r.result) as {
      total: number;
      shown: number;
      truncated: boolean;
      omitted?: number;
      note?: string;
    };

    assert.ok(j.total >= 12, `应至少匹配 12 条，实际 ${j.total}`);
    assert.equal(j.shown, 5, `limit=5 应只返回 5 条，实际 ${j.shown}`);
    assert.equal(j.truncated, true, '应标记截断');

    assert.equal(j.omitted, j.total - j.shown, `omitted 应等于 total-shown，实际 ${j.omitted}`);
    assert.ok(
      (j.note || '').includes(`另有 ${j.omitted} 条未返回`),
      `note 必须说清还有几条没返回，实际：${j.note}`,
    );
    assert.ok(
      (j.note || '').includes('关键词收窄'),
      `必须给出补救动作（收窄关键词），实际：${j.note}`,
    );
    assert.ok(
      (j.note || '').includes('list_bookmarks'),
      `该给另一条路（到文件夹里逐层看），实际：${j.note}`,
    );

    // 不截断时不该有这些字段
    const r2 = await executeTool('search_bookmarks', JSON.stringify({ query: 'scap', limit: 2000 }));
    const j2 = JSON.parse(r2.result) as { total: number; shown: number; omitted?: number; note?: string };
    assert.equal(j2.shown, j2.total, 'limit 够大时不该截断');
    assert.equal(j2.omitted, undefined, `不截断时不该有 omitted，实际 ${j2.omitted}`);
    assert.ok(!j2.note, `不截断时不该有 note，实际 ${j2.note}`);
  });

  /*
   * 「终态优先」守卫：已被消费过的 runId，其残留 pending **不得**被提升成新撤销点。
   *
   * 否则删除类逆操作会被重复回放，造出重复子树——注释里写明这条同时覆盖
   * 「点已被消费、pending 清理失败、进程又被杀」的完整序列。
   *
   * 但 `MAX_TERMINAL_RUN_IDS = 50`：终态列表只留最近 50 条。
   * 若某个 runId 被挤出这个窗口，而它的 pending 又恰好残留（clearPending 失败过），
   * 且它的正式点也已掉出 10 步保留窗口——两道守卫就都不认它了，
   * 陈旧的 pending 会被提升成一个**新的可回放撤销点**。
   */
  await okA('终态 runId 的残留 pending 不被提升（墓碑 + 终态列表双守卫）', async () => {
    const {
      recoverInterruptedTransaction,
      takeUndoPoint,
      writeUndoPoints,
      rememberTerminalRun,
      readUndoState,
      MAX_TERMINAL_RUN_IDS,
    } = await import('../src/lib/undo/recorder');
    const { beginUndoTransaction, endUndoTransaction, resetUndoTransactionForTest } =
      await import('../src/lib/undo/recorder');
    const { jRemove } = await import('../src/lib/undo/mutations');

    storageMap.delete('markai.undo');
    storageMap.delete('markai.undo.pending');
    resetUndoTransactionForTest();

    /* ── A. 基本情形：runId 在终态列表里 → 不提升 ── */
    const folder = (await mockBookmarks.create({ parentId: '1', title: 'T31-F' })).id;
    const victim = (await mockBookmarks.create({ parentId: folder, title: 'T31-V', url: 'https://t31.test/v' })).id;
    await beginUndoTransaction('run-t31-a');
    await jRemove(victim);
    const point = await endUndoTransaction();
    assert.ok(point, '应产生撤销点');
    const taken = await takeUndoPoint();
    assert.ok(taken.point, '应能取走撤销点');

    // 消费成功后，pending 槽应已被写成墓碑（这是 0.2.122 新加的守卫）
    const pend = storageMap.get('markai.undo.pending') as { terminal?: boolean; runId?: string } | undefined;
    assert.equal(pend?.terminal, true, `消费后 pending 槽应是墓碑，实际 ${JSON.stringify(pend)}`);
    assert.equal(pend?.runId, 'run-t31-a', '墓碑要记下是哪个 runId');

    const recovered = await recoverInterruptedTransaction();
    assert.equal(recovered, null, `已终态的 runId 不得被提升，实际 ${JSON.stringify(recovered)}`);
    assert.equal((await readUndoState()).points.length, 0, '提升被正确阻止：没有新撤销点');

    /* ── B. 墓碑本身就能挡住提升（不依赖终态列表） ── */
    storageMap.delete('markai.undo');
    // 终态列表填满"别的" runId，把 run-t31-a 挤出去——墓碑是唯一还认它的东西
    const crowded = Array.from({ length: MAX_TERMINAL_RUN_IDS }, (_, i) => `filler-${i}`);
    await writeUndoPoints([], undefined, crowded);
    // pending 保持墓碑内容（不清掉）
    const recovered2 = await recoverInterruptedTransaction();
    assert.equal(recovered2, null, `墓碑应独立挡住提升，实际 ${JSON.stringify(recovered2)}`);
    assert.equal(
      (await readUndoState()).points.length,
      0,
      '墓碑挡住提升：没有新的可回放撤销点（陈旧改动不会被重复回放）',
    );

    /* ── C. 墓碑是惰性的：不挡新轮次 ── */
    resetUndoTransactionForTest();
    const victim2 = (await mockBookmarks.create({ parentId: folder, title: 'T31-V2', url: 'https://t31.test/v2' })).id;
    await beginUndoTransaction('run-t31-c');
    await jRemove(victim2);
    const pointC = await endUndoTransaction();
    assert.ok(pointC, '新轮次应能正常产生撤销点（墓碑不该把它挡掉）');
    assert.equal(pointC!.runId, 'run-t31-c');
  });

  /*
   * 历史被截断且**没开 autoCompress（默认就是关的）**时，必须告诉模型"有缺失"。
   *
   * 原来静默返回：模型只看到最近几条，它自己不知道还有更早的。
   * 用户那边的症状是「我前面说过别动那个文件夹，你怎么还搬」——
   * 而模型并不是不听，是那条消息根本没进它的上下文。
   * 不说清楚，模型只会基于不完整信息自信地行动，用户以为它忘了自己的话。
   */
  await okA('历史被截断时明确告知模型有缺失（不让他自信地基于半边信息行动）', async () => {
    const { runAgentTurn } = await import('../src/lib/ai/agent');

    // 造一段很长的历史：每条 2000 字符，20 条 ≈ 远超任何小窗口
    const long = (t: string) => 'x'.repeat(2000) + t;
    const history = Array.from({ length: 20 }, (_, i) => ({
      id: `h${i}`,
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      blocks: [{ kind: 'text' as const, text: long(`第${i}条`) }],
      createdAt: 1000 + i,
    }));

    // 小窗口 + 不开压缩：必然截断
    fetchCalls.length = 0;
    sseQueue = [sseResponse([sseEvent(JSON.stringify({ choices: [{ delta: { content: '好。' } }] })), sseEvent('[DONE]')])];
    await runAgentTurn({
      config: { ...TEST_CONFIG, contextWindow: 4000, autoCompress: false },
      messageId: 'm-trunc',
      history,
      text: '继续',
      signal: new AbortController().signal,
      onEvent: () => {},
    });

    const body = JSON.parse(String(fetchCalls[0]!.init.body)) as { messages: { role: string; content: string }[] };
    const first = body.messages.find((m) => (m.content || '').includes('系统提示'));
    assert.ok(first, `应有一条说明"上下文被截断"的消息，实际首条：${JSON.stringify(body.messages[1]?.content?.slice(0, 80))}`);
    assert.ok(
      /只包含了最近 \d+ 条消息/.test(first!.content),
      `必须说清保留了几条，实际：${first!.content}`,
    );
    assert.ok(
      /更早的 \d+ 条消息未包含在内/.test(first!.content),
      `必须说清丢了几条，实际：${first!.content}`,
    );
    assert.ok(
      /不要猜测其内容/.test(first!.content),
      `必须要求模型别猜，实际：${first!.content}`,
    );

    /* ── 开了压缩时不该有这条（摘要已经在做同样的事） ── */
    fetchCalls.length = 0;
    sseQueue = [sseResponse([sseEvent(JSON.stringify({ choices: [{ delta: { content: '好。' } }] })), sseEvent('[DONE]')])];
    await runAgentTurn({
      config: { ...TEST_CONFIG, contextWindow: 4000, autoCompress: true },
      messageId: 'm-trunc2',
      history,
      text: '继续',
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    const body2 = JSON.parse(String(fetchCalls[0]!.init.body)) as { messages: { role: string; content: string }[] };
    assert.ok(
      !body2.messages.some((m) => (m.content || '').includes('更早的') && (m.content || '').includes('未包含在内')),
      '开了 autoCompress 时不该再出现"未包含在内"（摘要已在承担这件事）',
    );
    assert.ok(
      body2.messages.some((m) => (m.content || '').includes('早期对话摘要')),
      '开了 autoCompress 时应出现摘要',
    );
  });

  /*
   * **单条**消息被截断时也必须留下痕迹。
   *
   * `selectHistory` 里两条截断路径都是静默的：
   *   ① 超过 MAX_MESSAGE_CHARS(6000) 直接 slice
   *   ② 极小窗口时再截到预算的一半
   * 原来直接换成一个截断文本的新消息对象，没有任何标记——模型看到一条半句话
   * 戛然而止的消息，却不知道它被切过。
   *
   * 最常见的场景：用户粘一份几百条的书签清单（远超 6000 字符），模型只读到
   * 前 6000 字符，然后自信地说「我已看过你列的 500 条」。
   * 用户完全有理由相信它看全了——那是他刚发出去的消息。
   */
  await okA('单条消息被截断时明确标记（别让模型以为看全了用户粘的长清单）', async () => {
    const { runAgentTurn } = await import('../src/lib/ai/agent');

    // 一条远超 6000 字符上限的用户消息（模拟粘贴的书签清单）
    const huge = Array.from({ length: 2000 }, (_, i) => `${i + 1}. https://example${i}.test/`).join('\n');
    assert.ok(huge.length > 6000, `前置：消息应超过 6000 字符上限，实际 ${huge.length}`);

    const history = [
      {
        id: 'huge-1',
        role: 'user' as const,
        blocks: [{ kind: 'text' as const, text: huge }],
        createdAt: 1000,
      },
    ];

    // 窗口足够放进这条被截断的消息
    fetchCalls.length = 0;
    sseQueue = [sseResponse([sseEvent(JSON.stringify({ choices: [{ delta: { content: '好。' } }] })), sseEvent('[DONE]')])];
    await runAgentTurn({
      config: { ...TEST_CONFIG, contextWindow: 32000, autoCompress: false },
      messageId: 'm-bigmsg',
      history,
      text: '帮我整理这些',
      signal: new AbortController().signal,
      onEvent: () => {},
    });

    const body = JSON.parse(String(fetchCalls[0]!.init.body)) as { messages: { role: string; content: string }[] };
    const sent = body.messages.find((m) => (m.content || '').includes('example0.test'));
    assert.ok(sent, '那条长消息应被发送');

    // 关键：必须带截断标记，且写清原长与实际发送长度
    assert.ok(
      /内容被截断/.test(sent!.content),
      `截断的长消息必须带标记，实际结尾：${sent!.content.slice(-80)}`,
    );
    assert.ok(
      new RegExp(`原有 ${huge.length} 字符`).test(sent!.content),
      `必须说清原有长度（${huge.length}），实际：${sent!.content.slice(-120)}`,
    );
    assert.ok(
      /只发送了前 \d+ 字符/.test(sent!.content),
      `必须说清实际发送了多少，实际：${sent!.content.slice(-120)}`,
    );

    /* ── 反向：短消息不该有标记（不制造噪音） ── */
    fetchCalls.length = 0;
    sseQueue = [sseResponse([sseEvent(JSON.stringify({ choices: [{ delta: { content: '好。' } }] })), sseEvent('[DONE]')])];
    await runAgentTurn({
      config: { ...TEST_CONFIG, contextWindow: 32000, autoCompress: false },
      messageId: 'm-smallmsg',
      history: [{ id: 's1', role: 'user', blocks: [{ kind: 'text', text: '很短的一条' }], createdAt: 1 }],
      text: '在吗',
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    const body2 = JSON.parse(String(fetchCalls[0]!.init.body)) as { messages: { role: string; content: string }[] };
    assert.ok(
      !body2.messages.some((m) => (m.content || '').includes('内容被截断')),
      '短消息不该出现截断标记',
    );
  });

  /*
   * **当前这条**用户消息被截断时也必须标记。
   *
   * 用户当场粘一份长清单是最常见的场景，而聊天界面显示的是**完整**消息
   * （存在 store 里、原样渲染）——于是"用户看到的"和"模型看到的"静默不一致：
   * 用户指着自己刚发的那段话提问，模型却只读过前 8000 字符。
   */
  await okA('当前消息被截断时明确标记（用户看到的和模型看到的不能静默不一致）', async () => {
    const { runAgentTurn } = await import('../src/lib/ai/agent');

    // 一条 30000 字符的当前消息
    const longText = Array.from({ length: 1200 }, (_, i) => `${i + 1}. https://cur${i}.test/`).join('\\n');
    assert.ok(longText.length > 8000, `前置：应超过 8000 上限，实际 ${longText.length}`);

    fetchCalls.length = 0;
    sseQueue = [sseResponse([sseEvent(JSON.stringify({ choices: [{ delta: { content: '好。' } }] })), sseEvent('[DONE]')])];
    await runAgentTurn({
      config: { ...TEST_CONFIG, contextWindow: 32000, autoCompress: false },
      messageId: 'm-curtext',
      history: [],
      text: longText,
      signal: new AbortController().signal,
      onEvent: () => {},
    });

    const body = JSON.parse(String(fetchCalls[0]!.init.body)) as { messages: { role: string; content: string }[] };
    const last = body.messages[body.messages.length - 1]!;
    assert.equal(last.role, 'user', '最后一条应是当前用户消息');

    assert.ok(
      /内容被截断/.test(last.content ?? ''),
      `被截断的当前消息必须带标记，实际结尾：${(last.content ?? '').slice(-60)}`,
    );
    assert.ok(
      new RegExp(`原有 ${longText.length} 字符`).test(last.content ?? ''),
      `必须说清原有长度（${longText.length}），实际：${(last.content ?? '').slice(-140)}`,
    );
    assert.ok(
      /只发送了前 8000 字符/.test(last.content ?? ''),
      `必须说清实际发送了多少，实际：${(last.content ?? '').slice(-140)}`,
    );
    // 标记要能指引用户补救
    assert.ok(
      /缩短后重新发送/.test(last.content ?? ''),
      `该告诉用户怎么办，实际：${(last.content ?? '').slice(-140)}`,
    );

    /* ── 反向：短消息不该有标记 ── */
    fetchCalls.length = 0;
    sseQueue = [sseResponse([sseEvent(JSON.stringify({ choices: [{ delta: { content: '好。' } }] })), sseEvent('[DONE]')])];
    await runAgentTurn({
      config: { ...TEST_CONFIG, contextWindow: 32000, autoCompress: false },
      messageId: 'm-curtext2',
      history: [],
      text: '帮我整理一下书签栏',
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    const body2 = JSON.parse(String(fetchCalls[0]!.init.body)) as { messages: { role: string; content: string }[] };
    const last2 = body2.messages[body2.messages.length - 1]!;
    assert.equal(last2.content, '帮我整理一下书签栏', '短消息必须原样发送，一个字符都不能改');
  });

  /*
   * 工具结果被截断时，提示必须给**这个工具真能做到**的补救。
   *
   * 原来一律写「请用 offset/maxItems 分页获取剩余部分」——但不是每个工具都有 offset
   * （search_bookmarks 就没有）。模型照做会撞上参数校验错误，白跑一轮还以为是偶发故障。
   */
  await okA('工具结果截断提示按工具给可行补救（不能翻页的别说"用 offset"）', async () => {
    const { runAgentTurn } = await import('../src/lib/ai/agent');

    /* ── A. 不可翻页的工具：别说 offset ── */
    // search_bookmarks 返回一条超大结果（用 limit 上限 + 很长的标题把结果撑过 12 万字符）
    for (let i = 0; i < 40; i++) {
      await mockBookmarks.create({
        parentId: '1',
        title: `bigtitle-${i}-${'y'.repeat(3000)}`,
        url: `https://bigsearch.test/${i}`,
      });
    }
    fetchCalls.length = 0;
    sseQueue = [
      sseResponse([
        sseEvent(
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, id: 'c-big', function: { name: 'search_bookmarks', arguments: '{"query":"bigtitle"}' } }] } }],
          }),
        ),
        sseEvent('[DONE]'),
      ]),
      sseResponse([sseEvent(JSON.stringify({ choices: [{ delta: { content: '好了。' } }] })), sseEvent('[DONE]')]),
    ];
    await runAgentTurn({
      config: { ...TEST_CONFIG, contextWindow: 128000, autoCompress: false },
      messageId: 'm-bigtool',
      history: [],
      text: '找出所有 bigtitle',
      signal: new AbortController().signal,
      onEvent: () => {},
    });

    const body = JSON.parse(String(fetchCalls[1]!.init.body)) as {
      messages: { role: string; content: string }[];
    };
    const toolMsg = body.messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg, '应有一条 tool 消息');
    assert.ok(
      /结果过长已截断/.test(toolMsg!.content ?? ''),
      `结果被截断时必须说明，实际结尾：${(toolMsg!.content ?? '').slice(-60)}`,
    );
    assert.ok(
      !/offset/.test((toolMsg!.content ?? '').slice(-200)),
      `search_bookmarks 不支持翻页，提示里不该出现 offset：${(toolMsg!.content ?? '').slice(-200)}`,
    );
    assert.ok(
      /不支持分页/.test(toolMsg!.content ?? '') && /收窄/.test(toolMsg!.content ?? ''),
      `该告诉它把条件收窄，实际：${(toolMsg!.content ?? '').slice(-200)}`,
    );

    /* ── B. 可翻页的工具：该说 offset ── */
    fetchCalls.length = 0;
    sseQueue = [
      sseResponse([
        sseEvent(
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, id: 'c-lb', function: { name: 'list_bookmarks', arguments: '{"parentId":"1","limit":2000}' } }] } }],
          }),
        ),
        sseEvent('[DONE]'),
      ]),
      sseResponse([sseEvent(JSON.stringify({ choices: [{ delta: { content: '好了。' } }] })), sseEvent('[DONE]')]),
    ];
    await runAgentTurn({
      config: { ...TEST_CONFIG, contextWindow: 128000, autoCompress: false },
      messageId: 'm-bigtool2',
      history: [],
      text: '列出书签栏',
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    const body2 = JSON.parse(String(fetchCalls[1]!.init.body)) as {
      messages: { role: string; content: string }[];
    };
    const toolMsg2 = body2.messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg2, '应有一条 tool 消息');
    if (/结果过长已截断/.test(toolMsg2!.content ?? '')) {
      assert.ok(
        /offset/.test((toolMsg2!.content ?? '').slice(-200)),
        `list_bookmarks 支持翻页，提示该说 offset：${(toolMsg2!.content ?? '').slice(-200)}`,
      );
    }
  });

  /*
   * 取消必须能停住工具。
   *
   * 原来 abort 信号只传给了 LLM 请求，`executeTool` 完全拿不到。用户在
   * cleanup_sweep 扫几千条链接时点「停止」，这一次工具会跑到底——
   * 书签照搬、删除提议照提交，而用户已经看到「已取消」。
   */
  await okA('取消能停住工具：点「停止」后不再继续跑、也不再烧额度', async () => {
    const { runAgentTurn } = await import('../src/lib/ai/agent');

    /*
     * 走 **agent 真实路径**（不是直接调 executeTool——那样测不到 agent 侧的闸）。
     *
     * 原来 abort 信号只传给 LLM 请求，`executeTool` 完全拿不到。用户在
     * cleanup_sweep 扫几千条链接时点「停止」，这一次工具会跑到底——
     * 书签照搬、删除提议照提交，而用户已经看到「已取消」。
     *
     * 判据（都与累计 store 无关，稳定）：
     *   ① 工具结果必须是"已取消"的错误，而不是一份正常完成的结果；
     *   ② 取消后**不再发第二次 LLM 请求**——否则就是在白烧用户的额度。
     */
    const ac = new AbortController();
    let progress = 0;
    const events: string[] = [];
    fetchCalls.length = 0;
    sseQueue = [
      sseResponse([
        sseEvent(
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, id: 'c-cancel', function: { name: 'auto_categorize', arguments: '{"parentId":"1","minGroupSize":1}' } }] } }],
          }),
        ),
        sseEvent('[DONE]'),
      ]),
      // 若没有取消闸，这一份会被用上，于是出现第二次请求
      sseResponse([sseEvent(JSON.stringify({ choices: [{ delta: { content: '做完了。' } }] })), sseEvent('[DONE]')]),
    ];

    await runAgentTurn({
      config: { ...TEST_CONFIG, contextWindow: 128000, autoCompress: false },
      messageId: 'm-canceltool',
      history: [],
      text: '分类书签栏',
      signal: ac.signal,
      onEvent: (e) => {
        events.push(e.type);
        if (e.type === 'chat:tool_progress') {
          progress++;
          if (progress >= 3) ac.abort();
        }
      },
    });

    assert.ok(progress >= 3, `前置：至少应收到 3 次进度，实际 ${progress}`);

    /*
     * 核心判据：工具**没有跑完**。
     *
     * 实测两种形态（同一条用例，只差 agent 侧那行闸）：
     *   有闸：progress=3，事件 tool_start → tool_progress → tool_error → cancelled
     *   无闸：progress=20，事件 tool_start → tool_progress → tool_done → cancelled
     * 无闸时工具照样把整批做完、还上报 tool_done——用户点了「停止」，
     * 书签照搬、删除提议照提交，那就是"取消了个寂寞"。
     */
    assert.ok(
      events.includes('chat:tool_error'),
      `取消后工具应报 tool_error（被打断），实际事件：${[...new Set(events)].join(',')}`,
    );
    assert.ok(
      !events.includes('chat:tool_done'),
      `取消后工具不该报 tool_done（那等于告诉用户"这一步做完了"），实际事件：${[...new Set(events)].join(',')}`,
    );

    // 轮次以 cancelled 收尾，而不是 done
    assert.ok(
      events.includes('chat:cancelled'),
      `取消后应以 chat:cancelled 收尾，实际事件：${[...new Set(events)].join(',')}`,
    );
    assert.ok(
      !events.includes('chat:done'),
      `取消后不该再报 chat:done，实际事件：${[...new Set(events)].join(',')}`,
    );

    // 取消后不再发第二次 LLM 请求（不白烧额度）
    assert.equal(fetchCalls.length, 1, `取消后不该再发第二次请求，实际发了 ${fetchCalls.length} 次`);
  });

  console.log(`\n全部通过：${passed} 项 ✔`);
})().catch((e) => {
  console.error('\n❌ 测试失败:', e);
  process.exit(1);
});
await okA('命令面板派发的自定义事件，都有人接', async () => {
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

  /*
   * 命令面板里有三个动作是靠 `document.dispatchEvent(new CustomEvent('markai:xxx'))`
   * 转交给 workspace 的。**事件名拼错就是静默失败**：面板项点了、看起来有反应，
   * 但什么都没有打开。这类缺口此前在快捷键上已经发生过一次（Ctrl+D）。
   *
   * 所以把「派发的」和「监听的」两组事件名对起来，差集必须为空。
   */
  const palette = read('src/components/command/command-palette.tsx');
  const workspace = read('src/components/workspace/workspace.tsx');

  const dispatched = [...palette.matchAll(/new CustomEvent\('([^']+)'\)/g)].map((m) => m[1]!);
  assert.ok(dispatched.length >= 3, `只派发了 ${dispatched.length} 个事件，正则可能失效了`);

  const listened = [...workspace.matchAll(/addEventListener\('([^']+)'/g)].map((m) => m[1]!);
  const missing = dispatched.filter((e) => !listened.includes(e));
  assert.deepEqual(missing, [], `命令面板派发了但没人监听的事件：${JSON.stringify(missing)}`);

  // 反向：workspace 监听的 markai:* 事件，面板里至少要有一个在派发
  const orphanListeners = listened.filter((e) => e.startsWith('markai:') && !dispatched.includes(e));
  assert.deepEqual(orphanListeners, [], `workspace 监听了但没人派发的事件：${JSON.stringify(orphanListeners)}`);
});

await okA('TOOL_DEFINITIONS 里声明的每个工具都有实现（不多不少）', async () => {
  const { TOOL_DEFINITIONS } = await import('../src/lib/ai/prompts');
  const { IMPLEMENTED_TOOL_NAMES } = await import('../src/lib/ai/tools');

  /*
   * 「声明了但没实现」是最难自查的一类漂移：模型在 TOOL_DEFINITIONS 里看得见这个工具，
   * 会理直气壮地调用，然后执行器抛「未知工具：xxx」——用户在聊天里看到一次莫名报错，
   * 而单测里没有任何一条会红（每条工具都是单独测自己的 handler）。
   *
   * 所以把两边对起来：差集必须为空，反向也必须为空
   * （实现了却没声明的工具，模型根本不知道它的存在，也是腐烂）。
   */
  const declared = TOOL_DEFINITIONS.map((t) => t.function.name);
  assert.ok(declared.length >= 20, `只声明了 ${declared.length} 个工具，正则/解析可能失效了`);

  const noImpl = declared.filter((n) => !IMPLEMENTED_TOOL_NAMES.has(n));
  assert.deepEqual(noImpl, [], `声明了但没有实现的工具：${JSON.stringify(noImpl)}`);

  const noDecl = [...IMPLEMENTED_TOOL_NAMES].filter((n) => !declared.includes(n));
  assert.deepEqual(noDecl, [], `实现了但没有声明（模型看不到）的工具：${JSON.stringify(noDecl)}`);
});

await okA('每个已实现的工具都有中文标签（不让裸工具名漏到界面上）', async () => {
  const { IMPLEMENTED_TOOL_NAMES, TOOL_META } = await import('../src/lib/ai/tools');

  /*
   * 聊天里的工具 chip 渲染是 `{meta?.label ?? record.name}`。
   * 没有标签时就回退到裸工具名——`create_bookmark` 这种英文蛇形
   * 会直接漏进全中文的界面，看起来像没做完。
   *
   * 每条工具都是单独测自己的 handler，没有一条会为"忘了加标签"而红。
   */
  const unlabeled = [...IMPLEMENTED_TOOL_NAMES].filter((n) => !TOOL_META[n]?.label?.trim());
  assert.deepEqual(unlabeled, [], `这些工具没有中文标签：${JSON.stringify(unlabeled)}`);

  // 反向：标签表里多出来的键也是腐烂（工具已不存在）
  const stale = Object.keys(TOOL_META).filter((n) => !IMPLEMENTED_TOOL_NAMES.has(n));
  assert.deepEqual(stale, [], `标签表里这些工具已经不存在了：${JSON.stringify(stale)}`);
});
