/** ── Agent 工具执行器（仅在 background Service Worker 内运行） ── */

import { z } from 'zod';
import { uid } from '../format';
import type { DeletionProposal } from './types';
import { CONFIG_STORAGE_KEY } from '@/stores/configStore';

/** 工具执行结果 */
export interface ToolOutput {
  result: string; // 回填给 AI 的文本（JSON）
  deletions?: DeletionProposal[]; // 仅 propose_deletions 携带
}

/** 浏览器根文件夹 id（不可删除/移动） */
const ROOT_IDS = new Set<string>();

/** 初始化根文件夹集合（幂等） */
export async function ensureRoots(): Promise<void> {
  if (ROOT_IDS.size > 0) return;
  const tree = await chrome.bookmarks.getTree();
  const root = tree[0];
  for (const child of root?.children ?? []) ROOT_IDS.add(child.id);
}

function isRoot(id: string): boolean {
  return ROOT_IDS.has(id);
}

/** 解析书签完整路径，例如"书签栏 > 技术 > AI" */
async function resolvePath(id: string): Promise<string> {
  const parts: string[] = [];
  let cur = id;
  let depth = 0;
  while (depth++ < 32) {
    const nodes: chrome.bookmarks.BookmarkTreeNode[] = await chrome.bookmarks.get(cur).catch(() => []);
    const node = nodes[0];
    if (!node) break;
    parts.unshift(node.title || '(未命名)');
    if (!node.parentId) break;
    cur = node.parentId;
  }
  return parts.join(' > ') || '(未知路径)';
}

/**
 * 批量解析路径：一次 getTree 建立 id → {title, parentId} 索引，
 * 避免逐条 get（list/search 场景下可省数百次 API 调用）。
 */
async function resolvePaths(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const tree = await chrome.bookmarks.getTree();
  const index = new Map<string, { title: string; parentId?: string }>();
  const root = tree[0];
  if (root) index.set(root.id, { title: '(根)', parentId: undefined });
  const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[]) => {
    for (const n of nodes) {
      index.set(n.id, { title: n.title, parentId: n.parentId });
      if (n.children) walk(n.children);
    }
  };
  walk(root?.children ?? []);

  const out = new Map<string, string>();
  for (const id of ids) {
    const parts: string[] = [];
    let cur = id;
    let depth = 0;
    while (cur && depth++ < 64) {
      const node = index.get(cur);
      if (!node) break;
      parts.unshift(node.title || '(未命名)');
      if (!node.parentId) break;
      cur = node.parentId;
    }
    out.set(id, parts.join(' > ') || '(未知路径)');
  }
  return out;
}

/** 校验父文件夹存在且确实是文件夹 */
async function assertFolder(parentId?: string): Promise<string> {
  const pid = parentId ?? '1'; // 默认书签栏（root id 通常为 "1"，动态兜底见下）
  if (parentId) {
    const nodes = await chrome.bookmarks.get(pid).catch(() => []);
    const node = nodes[0];
    if (!node) throw new Error(`父文件夹不存在（id: ${pid}）`);
    if (node.url) throw new Error(`目标 ${pid} 不是文件夹，无法作为父级`);
    return pid;
  }
  // 未指定 parentId 时使用书签栏根
  const tree = await chrome.bookmarks.getTree();
  const bar = tree[0]?.children?.find((c) => c.id === '1') ?? tree[0]?.children?.[0];
  if (!bar) throw new Error('无法定位书签栏');
  return bar.id;
}

/** 校验不会造成循环嵌套（目标不能是自身或自身的子孙） */
async function assertNoCycle(bookmarkId: string, parentId: string): Promise<void> {
  let cur: string | undefined = parentId;
  let depth = 0;
  while (cur && depth++ < 64) {
    if (cur === bookmarkId) throw new Error('目标文件夹是自身或自身的子文件夹，会造成循环嵌套');
    const nodes: chrome.bookmarks.BookmarkTreeNode[] = await chrome.bookmarks.get(cur).catch(() => []);
    cur = nodes[0]?.parentId;
  }
}

function serializeBookmark(n: chrome.bookmarks.BookmarkTreeNode): Record<string, unknown> {
  return {
    id: n.id,
    title: n.title,
    url: n.url,
    folder: !n.url,
    dateAdded: n.dateAdded,
    dateLastUsed: n.dateLastUsed ?? undefined,
    dateGroupModified: n.dateGroupModified,
  };
}

/** ── 工具实现 ── */

/** 工具默认返回条数：固定 2000（list/search 未显式传 limit 时的上限，用户无需配置） */
async function getToolLimit(): Promise<number> {
  return 2000;
}

const listBookmarksSchema = z.object({
  parentId: z.string().optional(),
  // 路径定位（如"书签栏 > 技术"），与 parentId 二选一，优先用路径
  folderPath: z.string().optional(),
  // 返回条数上限：不传时用默认值 2000
  limit: z.number().int().min(1).max(2000).optional(),
  // 分页偏移：大文件夹（几千条）配合 limit 翻页取全量（返回 nextOffset/hasMore）
  offset: z.number().int().min(0).optional(),
});

async function listBookmarks(args: unknown): Promise<ToolOutput> {
  const { parentId, folderPath, limit, offset = 0 } = listBookmarksSchema.parse(args);
  let pid = parentId;
  if (!pid && folderPath) {
    pid = await findFolderByPath(folderPath);
    if (!pid) throw new Error(`找不到文件夹：${folderPath}，可用 list_all_folders 查看现有路径`);
  }
  const defaultLimit = await getToolLimit();
  const useLimit = limit ?? Math.min(defaultLimit, 2000);
  pid = pid ? await assertFolder(pid) : await assertFolder(undefined);
  const children = await chrome.bookmarks.getChildren(pid);
  const items = children.slice(offset, offset + useLimit);
  const folderName = (await resolvePath(pid)).split(' > ').pop() ?? pid;
  const paths = await resolvePaths(items.map((n) => n.id));
  const out = {
    parentId: pid,
    folder: folderName,
    path: await resolvePath(pid),
    total: children.length,
    shown: items.length,
    offset,
    nextOffset: offset + items.length < children.length ? offset + items.length : undefined,
    hasMore: offset + items.length < children.length,
    truncated: children.length > items.length,
    items: items.map((n) => ({ ...serializeBookmark(n), path: paths.get(n.id) })),
  };
  return { result: JSON.stringify(out) };
}

const searchBookmarksSchema = z.object({
  query: z.string().min(1).max(100),
  // 返回条数上限：默认 2000，Agent 可传更大值获取更完整结果
  limit: z.number().int().min(1).max(2000).optional(),
});

async function searchBookmarks(args: unknown): Promise<ToolOutput> {
  const { query, limit } = searchBookmarksSchema.parse(args);
  const defaultLimit = await getToolLimit();
  const useLimit = limit ?? Math.min(defaultLimit, 2000);
  const nodes = await chrome.bookmarks.search(query);
  const items = nodes.slice(0, useLimit);
  const paths = await resolvePaths(items.map((n) => n.id));
  const out = {
    query,
    total: nodes.length,
    shown: items.length,
    truncated: nodes.length > items.length,
    items: items.map((n) => ({ ...serializeBookmark(n), path: paths.get(n.id) })),
  };
  return { result: JSON.stringify(out) };
}

const getRecentSchema = z.object({
  count: z.number().int().min(1).max(20).optional(),
  // 只看最近 N 天（按 dateAdded 过滤，跨全部文件夹）；不传则用 chrome.bookmarks.getRecent
  days: z.number().int().min(1).max(3650).optional(),
});

async function getRecentBookmarks(args: unknown): Promise<ToolOutput> {
  const { count = 10, days } = getRecentSchema.parse(args);
  let nodes: chrome.bookmarks.BookmarkTreeNode[];
  if (days !== undefined) {
    // 全树遍历 + 时间过滤：getRecent 只支持数量，无法按天筛选
    const tree = await chrome.bookmarks.getTree();
    const since = Date.now() - days * 86_400_000;
    const hits: { n: chrome.bookmarks.BookmarkTreeNode; t: number }[] = [];
    const walk = (ns: chrome.bookmarks.BookmarkTreeNode[]) => {
      for (const n of ns) {
        if (n.url) hits.push({ n, t: n.dateAdded ?? 0 });
        if (n.children) walk(n.children);
      }
    };
    walk(tree[0]?.children ?? []);
    hits.sort((a, b) => b.t - a.t);
    nodes = hits.filter((h) => h.t >= since).slice(0, count).map((h) => h.n);
  } else {
    nodes = await chrome.bookmarks.getRecent(count);
  }
  const paths = await resolvePaths(nodes.map((n) => n.id));
  const items = nodes.map((n) => ({ ...serializeBookmark(n), path: paths.get(n.id) }));
  return { result: JSON.stringify({ count: items.length, days, items }) };
}

const getPathSchema = z.object({ bookmarkId: z.string() });

async function getFolderPath(args: unknown): Promise<ToolOutput> {
  const { bookmarkId } = getPathSchema.parse(args);
  const nodes = await chrome.bookmarks.get(bookmarkId).catch(() => []);
  const node = nodes[0];
  if (!node) throw new Error(`书签不存在（id: ${bookmarkId}）`);
  return { result: JSON.stringify({ id: bookmarkId, title: node.title, path: await resolvePath(bookmarkId), folder: !node.url }) };
}

const createFolderSchema = z.object({ title: z.string().min(1).max(100), parentId: z.string().optional() });

async function createFolder(args: unknown): Promise<ToolOutput> {
  const { title, parentId } = createFolderSchema.parse(args);
  const pid = await assertFolder(parentId);
  const node = await chrome.bookmarks.create({ parentId: pid, title });
  return { result: JSON.stringify({ created: serializeBookmark(node), path: await resolvePath(node.id) }) };
}

const createBookmarkSchema = z.object({
  title: z.string().min(1).max(200),
  // 宽松 schema + 内部校验：与 create_bookmarks 一致，避免严格 .url() 整批失败
  url: z.string().min(1).max(2000),
  parentId: z.string().optional(),
});

async function createBookmark(args: unknown): Promise<ToolOutput> {
  const { title, url, parentId } = createBookmarkSchema.parse(args);
  let finalUrl = url.trim();
  try {
    new URL(finalUrl);
  } catch {
    throw new Error(`URL 格式无效：${url}`);
  }
  const pid = await assertFolder(parentId);
  const node = await chrome.bookmarks.create({ parentId: pid, title, url: finalUrl });
  return { result: JSON.stringify({ created: serializeBookmark(node), path: await resolvePath(node.id) }) };
}

const createBookmarksSchema = z.object({
  parentId: z.string().optional(),
  parentPath: z.string().optional(),
  // url 不在此处强校验（整体拒绝会让单项非法导致全批失败）：工具内部逐条校验
  items: z.array(z.object({ title: z.string().min(1).max(200), url: z.string().min(1).max(500) })).min(1).max(50),
});

/** 批量创建书签（一次最多 50 条；支持 parentId 或 parentPath 定位目标文件夹；非法项单独失败） */
async function createBookmarks(args: unknown): Promise<ToolOutput> {
  const { parentId, parentPath, items } = createBookmarksSchema.parse(args);
  let pid = parentId;
  if (!pid && parentPath) {
    pid = await findFolderByPath(parentPath);
    if (!pid) throw new Error(`找不到文件夹：${parentPath}，可用 list_all_folders 查看现有路径`);
  }
  pid = pid ? await assertFolder(pid) : await assertFolder(undefined);
  const created: { title: string; url: string; id: string }[] = [];
  const failures: { title: string; error: string }[] = [];
  for (const it of items) {
    try {
      new URL(it.url); // 逐条校验：非法 URL 只记失败，不影响其他项
      const node = await chrome.bookmarks.create({ parentId: pid, title: it.title, url: it.url });
      created.push({ title: node.title, url: node.url ?? '', id: node.id });
    } catch (e) {
      failures.push({ title: it.title, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return {
    result: JSON.stringify({
      created: created.length,
      failed: failures.length,
      failures,
      folder: await resolvePath(pid),
      note:
        failures.length === 0
          ? `已创建 ${created.length} 个书签到「${await resolvePath(pid)}」。`
          : `${created.length} 个创建成功，${failures.length} 个失败（${failures.map((f) => f.error).join('；')}）。`,
    }),
  };
}

const moveSchema = z.object({ bookmarkId: z.string(), parentId: z.string(), index: z.number().int().min(0).optional() });

async function moveBookmark(args: unknown): Promise<ToolOutput> {
  const { bookmarkId, parentId, index } = moveSchema.parse(args);
  await ensureRoots(); // 与其余工具一致：SW 重启后先初始化根集合，根防护才生效
  if (isRoot(bookmarkId)) throw new Error('浏览器根文件夹不可移动');
  const nodes = await chrome.bookmarks.get(bookmarkId).catch(() => []);
  if (!nodes[0]) throw new Error(`书签不存在（id: ${bookmarkId}）`);
  const pid = await assertFolder(parentId);
  await assertNoCycle(bookmarkId, pid);
  const node = await chrome.bookmarks.move(bookmarkId, { parentId: pid, ...(index !== undefined ? { index } : {}) });
  return {
    result: JSON.stringify({
      moved: serializeBookmark(node),
      fromPath: await resolvePath(bookmarkId),
      toPath: `${await resolvePath(pid)} > ${node.title}`,
    }),
  };
}

const renameSchema = z.object({ bookmarkId: z.string(), title: z.string().min(1).max(200) });

async function renameBookmark(args: unknown): Promise<ToolOutput> {
  const { bookmarkId, title } = renameSchema.parse(args);
  await ensureRoots(); // 与其余工具一致：SW 重启后先初始化根集合，根防护才生效
  if (isRoot(bookmarkId)) throw new Error('浏览器根文件夹不可重命名');
  const nodes = await chrome.bookmarks.get(bookmarkId).catch(() => []);
  if (!nodes[0]) throw new Error(`书签不存在（id: ${bookmarkId}）`);
  const node = await chrome.bookmarks.update(bookmarkId, { title });
  return { result: JSON.stringify({ renamed: serializeBookmark(node), path: await resolvePath(node.id) }) };
}

const updateUrlSchema = z.object({ bookmarkId: z.string(), url: z.string().url() });

async function updateBookmarkUrl(args: unknown): Promise<ToolOutput> {
  const { bookmarkId, url } = updateUrlSchema.parse(args);
  const nodes = await chrome.bookmarks.get(bookmarkId).catch(() => []);
  const node = nodes[0];
  if (!node) throw new Error(`书签不存在（id: ${bookmarkId}）`);
  if (!node.url) throw new Error('文件夹没有 URL，无法修改');
  const updated = await chrome.bookmarks.update(bookmarkId, { url });
  return { result: JSON.stringify({ updated: serializeBookmark(updated) }) };
}

const checkUrlsSchema = z.object({
  // 宽松 schema：书签 URL 可能含未编码中文/空格，严格 .url() 会让整批失败；
  // 无效条目在工具内部跳过并计入 skipped
  urls: z.array(z.string()).min(1).max(50),
});

async function checkUrls(args: unknown): Promise<ToolOutput> {
  const { urls } = checkUrlsSchema.parse(args);
  const unique = [...new Set(urls)].slice(0, 50);
  const valid: string[] = [];
  const skipped: string[] = [];
  for (const u of unique) {
    try {
      new URL(u);
      valid.push(u);
    } catch {
      skipped.push(u);
    }
  }
  // 并发池限 5：避免一次性打满 20 个并发请求（宿主网络/站点压力），顺序保持原输入
  const results: Record<string, unknown>[] = new Array(valid.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(5, valid.length) }, async () => {
    while (cursor < valid.length) {
      const i = cursor++;
      results[i] = await checkOneUrl(valid[i]!);
    }
  });
  await Promise.all(workers);
  const out = results as Record<string, unknown>[];
  if (skipped.length > 0) out.push({ url: skipped, status: 'skipped', message: 'URL 格式无效，已跳过' });
  return { result: JSON.stringify(out) };
}

const checkUrlsBulkSchema = z.object({
  // 大规模批量检测（成千上万条）：工具内部并发完成，只把摘要回填给模型
  urls: z.array(z.string()).min(1).max(20_000),
  // 并发数：默认 20（速度与站点压力平衡），可调 1~50
  maxConcurrent: z.number().int().min(1).max(50).optional(),
  // 单条超时（毫秒）：默认 8000，可调 2000~30000
  timeoutMs: z.number().int().min(2000).max(30_000).optional(),
  // 明细返回上限：默认 200 条死链；0 = 只返回统计（省上下文）
  maxDeadList: z.number().int().min(0).max(500).optional(),
});

/**
 * 大规模链接存活检测（check_urls 的超集）：
 * - 一次调用可检测上万条（去重后），并发池 + 单条超时，任何一条失败都不阻塞整体
 * - 通过 onProgress 上报进度（UI 工具块实时显示，SW 也因事件保持活跃）
 * - 结果回填模型时只含摘要 + 死链明细（上限内），避免撑爆上下文
 */
async function checkUrlsBulk(
  args: unknown,
  onProgress?: (text: string) => void,
): Promise<ToolOutput> {
  const { urls, maxConcurrent = 20, timeoutMs = 8_000, maxDeadList = 200 } = checkUrlsBulkSchema.parse(args);
  const unique = [...new Set(urls.map((u) => u.trim()).filter(Boolean))];
  if (unique.length === 0) {
    return { result: JSON.stringify({ total: 0, ok: 0, dead: 0, note: '没有可检测的 URL。' }) };
  }
  const results: Record<string, unknown>[] = new Array(unique.length);
  let cursor = 0;
  let done = 0;
  let lastReport = 0;
  const tick = () => {
    if (!onProgress) return;
    done++;
    // 节流：每 250ms 或全部完成时上报一次（避免高频事件刷屏 UI）
    const now = Date.now();
    if (now - lastReport < 250 && done < unique.length) return;
    lastReport = now;
    const pct = Math.round((done / unique.length) * 100);
    onProgress(`正在检测链接 ${done}/${unique.length}（${pct}%）…`);
  };
  const workers = Array.from({ length: Math.min(maxConcurrent, unique.length) }, async () => {
    while (cursor < unique.length) {
      const i = cursor++;
      results[i] = await checkOneUrl(unique[i]!, timeoutMs);
      tick();
    }
  });
  await Promise.all(workers);

  const dead: Record<string, unknown>[] = [];
  let ok = 0;
  let denied = 0;
  let timeout = 0;
  let skipped = 0;
  let other = 0;
  for (const r of results) {
    if (r.status === 'ok') ok++;
    else if (r.status === 'denied') denied++;
    else if (r.status === 'timeout') {
      timeout++;
      dead.push(r);
    } else if (r.status === 'dead') {
      dead.push(r);
    } else if (r.status === 'skipped') {
      skipped++; // 非 http(s) 链接：不判死
    } else {
      other++;
      dead.push(r);
    }
  }
  const deadList = dead.slice(0, maxDeadList);
  return {
    result: JSON.stringify({
      total: unique.length,
      ok,
      dead: dead.length,
      denied,
      timeout,
      skipped,
      error: other,
      deadList,
      note: `检测完成：${ok} 个可访问，${dead.length} 个不可访问${skipped > 0 ? `，${skipped} 个非 http(s) 已跳过` : ''}${maxDeadList > 0 && dead.length > deadList.length ? `（仅列出前 ${deadList.length} 条明细）` : ''}。`,
    }),
  };
}

const classifyUrlsSchema = z.object({ urls: z.array(z.string().url()).min(1).max(500) });

/** 首页文件：路径为空、/、或 index.* 等（视为主页面） */
const INDEX_FILE = /^(index|default|home)(\.\w+)?$/;

/** URL 类型启发式（不联网）：供 classify_urls 与 cleanup_sweep 共用 */
function classifyOneUrl(raw: string): { url: string; type: 'root' | 'page' | 'sub' | 'deep' | 'unknown'; pathDepth: number; note: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { url: raw, type: 'unknown', pathDepth: -1, note: 'URL 格式无效' };
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  // 文件扩展名：2-5 位纯字母；纯数字后缀（/1.2、/v2.0）是版本号/编号，不算文件
  const hasExt = /\.[a-z]{2,5}$/i.test(last) && !/\.\d+$/.test(last);
  const hasQuery = parsed.search.length > 0;
  const depth = segments.length;

  let type: 'root' | 'page' | 'sub' | 'deep';
  let note = '';
  if (depth === 0 || (depth === 1 && INDEX_FILE.test(last))) {
    type = 'root';
    note = '主页面';
  } else if (depth === 1 && !hasExt && !hasQuery) {
    type = 'page';
    note = '浅层栏目页';
  } else if (depth <= 2 && !hasQuery) {
    type = 'sub';
    note = '子页面';
  } else {
    type = 'deep';
    note = hasQuery ? '深层页面（带查询参数）' : '深层子页面';
  }
  return { url: raw, type, pathDepth: depth, note };
}

/**
 * 批量分类 URL 类型（启发式，不联网）：
 * - root：主页面（域名根 / index.*）
 * - page：浅层页面（1 段路径，无文件扩展名）——如 /about /docs，通常是主站栏目页
 * - sub：子页面（2 段路径）或带查询参数的页面
 * - deep：深层子页面（3+ 段路径）——文章/文档页，清理场景优先考虑
 * 用于「只保留主页面」类整理任务：模型先分类，再结合 check_urls 实测存活决定去留。
 */
async function classifyUrls(args: unknown): Promise<ToolOutput> {
  const { urls } = classifyUrlsSchema.parse(args);
  const unique = [...new Set(urls)].slice(0, 500);
  const items = unique.map((raw) => classifyOneUrl(raw));
  const byType = items.reduce<Record<string, number>>((acc, it) => {
    acc[it.type] = (acc[it.type] ?? 0) + 1;
    return acc;
  }, {});
  return {
    result: JSON.stringify({
      total: items.length,
      byType,
      note: 'root=主页面，page=栏目页，sub=子页面，deep=深层子页面（清理时优先考虑）。',
      items,
    }),
  };
}

/** 常见两段式国家/地区域名后缀（注册域需取三段，如 co.uk / com.cn） */
const TWO_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'com.hk', 'com.tw', 'com.jp', 'co.jp', 'ne.jp', 'or.jp', 'co.kr', 'com.sg', 'com.au',
  'com.br', 'com.mx', 'co.in', 'com.tr', 'co.za', 'com.ar', 'com.ua', 'com.ru',
]);

/** 提取注册域（www. 与子域剥离；两段式 TLD 保留三段）用于分组 */
function registrableDomain(raw: string): string | null {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    const parts = host.split('.').filter(Boolean);
    if (parts.length < 2) return host || null;
    // 常见 ccTLD 组合（co.uk 等）：注册域 = 最后三段
    const lastTwo = parts.slice(-2).join('.');
    if (TWO_PART_TLDS.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join('.');
    return parts.slice(-2).join('.');
  } catch {
    return null;
  }
}

const autoCategorizeSchema = z.object({
  // 目标文件夹：folderId / folderPath 二选一，都不传则用书签栏
  folderId: z.string().optional(),
  folderPath: z.string().optional(),
  // 组内书签数达到该值才建文件夹（默认 2：低于 2 条留在原地）
  minGroupSize: z.number().int().min(1).max(50).optional(),
  // 最多创建多少个分类文件夹（默认 25，防产生过多零碎文件夹）
  maxGroups: z.number().int().min(1).max(100).optional(),
  // 是否把溢出组（数量超过 maxGroups 的部分）并入「其他」文件夹（默认 false：留在原地）
  foldOverflow: z.boolean().optional(),
});

/**
 * 自动分类（面向 1000+ 大书签库的核心工具）：
 * 工具内部按注册域名聚类 → 批量创建分类文件夹 → 批量移动，一次调用完成全量整理。
 * 模型只接收统计摘要，无需逐条决策，轮次与上下文占用与书签数量无关。
 */
async function autoCategorize(
  args: unknown,
  onProgress?: (text: string) => void,
): Promise<ToolOutput> {
  const { folderId, folderPath, minGroupSize = 2, maxGroups = 25, foldOverflow = false } =
    autoCategorizeSchema.parse(args);
  await ensureRoots();

  // 定位目标文件夹（folderId 优先，其次 folderPath，默认书签栏）
  let pid: string | undefined;
  if (folderId) {
    pid = await assertFolder(folderId);
  } else if (folderPath) {
    pid = await findFolderByPath(folderPath);
    if (!pid) throw new Error(`找不到文件夹：${folderPath}，可用 list_all_folders 查看现有路径`);
  } else {
    pid = await assertFolder(undefined);
  }
  const children = await chrome.bookmarks.getChildren(pid);
  // 只处理直接子书签（URL 节点）；已有子文件夹跳过，避免破坏既有结构
  const bookmarks = children.filter((n) => n.url);
  if (bookmarks.length < 2) {
    return {
      result: JSON.stringify({
        total: bookmarks.length,
        created: 0,
        moved: 0,
        note: bookmarks.length === 0 ? '该文件夹没有直接书签，无需分类。' : '书签不足 2 条，无需分类。',
      }),
    };
  }

  // 注册域聚类
  const groups = new Map<string, { domain: string; ids: string[] }>();
  let unparseable = 0;
  for (const b of bookmarks) {
    const domain = registrableDomain(b.url ?? '');
    if (!domain) {
      unparseable++;
      continue;
    }
    const g = groups.get(domain) ?? { domain, ids: [] };
    g.ids.push(b.id);
    groups.set(domain, g);
  }
  const sorted = [...groups.values()].sort((a, b) => b.ids.length - a.ids.length);
  // 达到 minGroupSize 才算「组」；取数量前 maxGroups 名
  const big = sorted.filter((g) => g.ids.length >= minGroupSize);
  const picked = big.slice(0, maxGroups);
  const overflow = foldOverflow ? big.slice(maxGroups) : [];
  const overflowIds = overflow.flatMap((g) => g.ids);
  const uncategorized = bookmarks.length - picked.reduce((a, g) => a + g.ids.length, 0) - overflowIds.length;

  // 建文件夹 + 移动（并发池 10：同一目标文件夹顺序无关，Chrome API 内部串行化；
  // 万条书签从逐条串行 ~50s 降到 ~5s；组粒度上报进度）
  let created = 0;
  let moved = 0;
  try {
    const moveGroup = async (folderId: string, ids: string[]) => {
      let cursor = 0;
      const workers = Array.from({ length: Math.min(10, ids.length) }, async () => {
        while (cursor < ids.length) {
          const id = ids[cursor++]!;
          await chrome.bookmarks.move(id, { parentId: folderId });
          moved++;
        }
      });
      await Promise.all(workers);
    };
    for (let i = 0; i < picked.length; i++) {
      const g = picked[i]!;
      const folder = await chrome.bookmarks.create({ parentId: pid, title: g.domain });
      created++;
      await moveGroup(folder.id, g.ids);
      onProgress?.(`正在归类 ${i + 1}/${picked.length}：${g.domain}（${g.ids.length} 条）`);
    }
    if (overflowIds.length > 0) {
      const folder = await chrome.bookmarks.create({ parentId: pid, title: '其他' });
      created++;
      await moveGroup(folder.id, overflowIds);
      onProgress?.(`已把 ${overflow.length} 个小众分类并入「其他」文件夹`);
    }
  } catch (e) {
    // 部分失败不整体回滚：已完成的分类保留，错误如实上报
    throw new Error(
      `分类执行中断：${e instanceof Error ? e.message : String(e)}（已创建 ${created} 个文件夹，已移动 ${moved} 条书签）`,
    );
  }

  return {
    result: JSON.stringify({
      total: bookmarks.length,
      created,
      moved,
      uncategorized,
      groups: picked.map((g) => ({ name: g.domain, count: g.ids.length })),
      note: `已按域名自动分类：创建 ${created} 个分类文件夹，移动 ${moved} 条书签，剩余 ${uncategorized} 条留在原地（数量不足或无法解析域名）${overflowIds.length > 0 ? `，${overflow.length} 个溢出分组并入「其他」` : ''}。`,
    }),
  };
}

const cleanupSweepSchema = z.object({
  // 目标文件夹：folderId / folderPath 二选一，都不传则用书签栏
  folderId: z.string().optional(),
  folderPath: z.string().optional(),
  // 只处理该年份以前（1月1日 0 点前）添加的书签；不传则处理全部
  beforeYear: z.number().int().min(1900).max(2100).optional(),
  // 保留哪些类型：root=仅主页面（默认）；page=主页面+浅层栏目页
  keepOnly: z.enum(['root', 'page']).optional(),
  // 是否实测主页面候选的存活（默认 true；false 时只按类型过滤）
  checkReachable: z.boolean().optional(),
  // 是否递归子文件夹（默认 true：只删书签本身，不删文件夹）
  recursive: z.boolean().optional(),
  // 本次处理的书签数量上限（大批量分页：第一页返回 remaining 后用 offset 继续）
  limit: z.number().int().min(1).max(1000).optional(),
  // 跳过前 N 条（按 dateAdded 升序的稳定顺序），配合 limit 分页
  offset: z.number().int().min(0).optional(),
});

/**
 * 【一键清理】扫描→分类→存活检测→批量提交删除提议，一次调用完成。
 * 面向「只保留主页面且可访问」类任务：工具内部遍历全量书签（无需模型分页拉取），
 * 按类型 + 收藏年份过滤，对保留候选实测存活，其余全部生成删除提议（带具体理由）。
 * 提议走删除安全通道：仍需用户在界面确认后才真正删除。
 */
async function cleanupSweep(
  args: unknown,
  onProgress?: (text: string) => void,
): Promise<ToolOutput> {
  const {
    folderId,
    folderPath,
    beforeYear,
    keepOnly = 'root',
    checkReachable = true,
    recursive = true,
    limit = 1000,
    offset = 0,
  } = cleanupSweepSchema.parse(args);
  await ensureRoots();

  // 定位目标文件夹
  let pid: string | undefined;
  if (folderId) {
    pid = await assertFolder(folderId);
  } else if (folderPath) {
    pid = await findFolderByPath(folderPath);
    if (!pid) throw new Error(`找不到文件夹：${folderPath}，可用 list_all_folders 查看现有路径`);
  } else {
    pid = await assertFolder(undefined);
  }

  // 遍历收集全部书签节点（递归时只删书签本身，文件夹保留）
  const collected: chrome.bookmarks.BookmarkTreeNode[] = [];
  const walk = async (folderId: string) => {
    const children = await chrome.bookmarks.getChildren(folderId);
    for (const c of children) {
      if (c.url) collected.push(c);
      else if (recursive) await walk(c.id);
    }
  };
  await walk(pid);

  // 年份过滤（dateAdded 为毫秒时间戳；beforeYear=2026 → 2026-01-01 0:00 之前）
  const cutoff = beforeYear !== undefined ? Date.UTC(beforeYear, 0, 1) : 0;
  const inScope = cutoff > 0 ? collected.filter((n) => (n.dateAdded ?? 0) > 0 && n.dateAdded! < cutoff) : collected;
  // 稳定顺序（dateAdded 升序 + id 兜底），保证分页 offset 语义一致
  const sorted = [...inScope].sort(
    (a, b) => (a.dateAdded ?? 0) - (b.dateAdded ?? 0) || a.id.localeCompare(b.id),
  );
  const page = sorted.slice(offset, offset + limit);

  // 启发式分类
  const classified = page.map((n) => ({ node: n, cls: classifyOneUrl(n.url ?? '') }));
  // 保留候选：类型满足 keepOnly
  const keptByType = classified.filter((c) => {
    if (keepOnly === 'root') return c.cls.type === 'root';
    return c.cls.type === 'root' || c.cls.type === 'page';
  });

  // 存活检测（并发池，仅检测保留候选）
  let reachable = new Set<string>();
  const deadMain: { id: string; title: string; reason: string }[] = [];
  if (checkReachable && keptByType.length > 0) {
    const results: Record<string, unknown>[] = new Array(keptByType.length);
    let cursor = 0;
    let done = 0;
    let lastReport = 0;
    const workers = Array.from({ length: Math.min(20, keptByType.length) }, async () => {
      while (cursor < keptByType.length) {
        const i = cursor++;
        results[i] = await checkOneUrl(keptByType[i]!.node.url ?? '');
        done++;
        // 进度节流
        const now = Date.now();
        if (onProgress && (now - lastReport > 250 || done === keptByType.length)) {
          lastReport = now;
          onProgress(`正在检测主页面存活 ${done}/${keptByType.length}…`);
        }
      }
    });
    await Promise.all(workers);
    const keptSet = new Set<string>();
    let skippedKeep = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      const item = keptByType[i]!;
      if (r.status === 'ok' || r.status === 'denied') {
        keptSet.add(item.node.id);
      } else if (r.status === 'skipped') {
        // 非 http(s)（chrome:// 等）：无法检测 ≠ 失效，保守保留
        keptSet.add(item.node.id);
        skippedKeep++;
      } else {
        // 主页面失效（404/超时/连接失败）→ 纳入删除
        const code = typeof r.code === 'number' ? `HTTP ${r.code}` : (r.status === 'timeout' ? '连接超时' : String(r.message ?? r.status));
        deadMain.push({ id: item.node.id, title: item.node.title || item.node.url || '(未命名)', reason: `主页面失效（${code}）` });
      }
    }
    reachable = keptSet;
    if (skippedKeep > 0 && onProgress) onProgress(`有 ${skippedKeep} 个非 http(s) 主页面无法检测，已保守保留`);
  } else if (!checkReachable) {
    reachable = new Set(keptByType.map((c) => c.node.id));
  }

  // 删除模式：auto = "无需确认"（直接执行删除）；confirm = 生成待确认提议（默认）
  const mode = await getDeleteMode();
  // 删除目标：子页面/深层页（按类型） + 失效主页面
  const targets: { id: string; title: string; reason: string }[] = [];
  for (const c of classified) {
    if (reachable.has(c.node.id)) continue;
    if (deadMain.some((d) => d.id === c.node.id)) continue; // 已加入失效主页面
    const title = c.node.title || c.node.url || '(未命名)';
    targets.push({
      id: c.node.id,
      title,
      reason:
        c.cls.type === 'deep'
          ? '深层子页面（文章/文档页）'
          : c.cls.type === 'sub'
            ? '子页面'
            : c.cls.type === 'unknown'
              ? 'URL 格式无效'
              : '页面类型不符合保留要求',
    });
  }
  for (const d of deadMain) targets.push({ id: d.id, title: d.title, reason: d.reason });

  const deletions: DeletionProposal[] = [];
  let autoDeleted = 0;
  let autoFailed = 0;
  if (mode === 'auto' && targets.length > 0) {
    // 「无需确认」模式：直接删除（并发池 10，失败重试一次），生成 executed 卡片供回显
    const retryDelete = async (id: string) => {
      try {
        await chrome.bookmarks.remove(id);
        return true;
      } catch {
        try {
          await chrome.bookmarks.remove(id);
          return true;
        } catch {
          return false;
        }
      }
    };
    let cursor = 0;
    let done = 0;
    const workers = Array.from({ length: Math.min(10, targets.length) }, async () => {
      while (cursor < targets.length) {
        const t = targets[cursor++]!;
        const ok = await retryDelete(t.id);
        done++;
        if (ok) {
          autoDeleted++;
          deletions.push({
            id: uid(),
            bookmarkId: t.id,
            title: t.title,
            reason: t.reason,
            status: 'executed',
            createdAt: Date.now(),
          });
        } else {
          autoFailed++;
        }
        if (onProgress && (done % 50 === 0 || done === targets.length)) {
          onProgress(`正在删除 ${done}/${targets.length}…`);
        }
      }
    });
    await Promise.all(workers);
  } else {
    // 确认模式：全部生成待确认提议
    for (const t of targets) {
      deletions.push({
        id: uid(),
        bookmarkId: t.id,
        title: t.title,
        reason: t.reason,
        status: 'pending',
        createdAt: Date.now(),
      });
    }
  }

  const remaining = sorted.length - (offset + page.length);
  const byType = classified.reduce<Record<string, number>>((acc, c) => {
    acc[c.cls.type] = (acc[c.cls.type] ?? 0) + 1;
    return acc;
  }, {});
  return {
    result: JSON.stringify({
      total: collected.length,
      inScope: inScope.length,
      processed: page.length,
      offset,
      remaining: remaining > 0 ? remaining : undefined,
      byType,
      keptReachable: reachable.size,
      toDelete: targets.length,
      submitted: deletions.length,
      deleted: autoDeleted,
      failed: autoFailed,
      note:
        mode === 'auto'
          ? `已扫描 ${page.length} 条${beforeYear !== undefined ? `（${beforeYear} 年前添加）` : ''}：保留可访问主页面 ${reachable.size} 条，其余 ${targets.length} 条（子页面/失效主页面）已按「无需确认」模式直接删除（成功 ${autoDeleted} 条${autoFailed > 0 ? `，失败 ${autoFailed} 条` : ''}）。${remaining > 0 ? `本轮已处理 ${offset + page.length}/${sorted.length} 条，剩余 ${remaining} 条请用 offset=${offset + page.length} 继续处理。` : ''}`
          : `已扫描 ${page.length} 条${beforeYear !== undefined ? `（${beforeYear} 年前添加）` : ''}：保留可访问主页面 ${reachable.size} 条，其余 ${targets.length} 条（子页面/失效主页面）已提交删除提议，等待你在界面确认。${remaining > 0 ? `本轮已处理 ${offset + page.length}/${sorted.length} 条，剩余 ${remaining} 条请用 offset=${offset + page.length} 继续处理。` : ''}`,
    }),
    deletions,
  };
}

/** 单 URL 存活检测：HEAD 优先，405/501 降级 GET，默认 8 秒超时（可调） */
async function checkOneUrl(raw: string, timeoutMs = 8_000): Promise<Record<string, unknown>> {
  let url: string;
  try {
    url = new URL(raw).toString();
  } catch {
    return { url: raw, status: 'error', message: 'URL 格式无效' };
  }
  // 非 http(s) 链接（chrome:// / file:// / javascript: 等）无法用 fetch 检测，
  // 直接标记 skipped 而不是误判为"死链"
  if (!/^https?:/i.test(url)) {
    return { url, status: 'skipped', message: '非 http(s) 链接，跳过检测' };
  }
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal });
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal });
    }
    if (res.status >= 200 && res.status < 400) return { url, status: 'ok', code: res.status };
    if (res.status === 401 || res.status === 403) return { url, status: 'denied', code: res.status };
    return { url, status: 'dead', code: res.status };
  } catch (e) {
    if (ctrl.signal.aborted) return { url, status: 'timeout', message: `连接超时（${Math.round(timeoutMs / 1000)} 秒）` };
    const msg = e instanceof Error ? e.message : String(e);
    return { url, status: 'error', message: `无法连接：${msg}` };
  } finally {
    clearTimeout(timeout);
  }
}

const statsSchema = z.object({});

async function stats(args: unknown): Promise<ToolOutput> {
  statsSchema.parse(args);
  await ensureRoots();
  const tree = await chrome.bookmarks.getTree();
  const roots = tree[0]?.children ?? [];

  let bookmarkCount = 0;
  let folderCount = 0;
  let emptyFolders = 0;
  let unusedTwoYears = 0;
  const perRoot: { root: string; bookmarks: number; folders: number }[] = [];

  const TWO_YEARS = 2 * 365 * 86_400_000;
  const now = Date.now();

  const walk = (node: chrome.bookmarks.BookmarkTreeNode, rootTitle: string) => {
    if (node.url) {
      bookmarkCount++;
      const lastUsed = node.dateLastUsed ?? 0;
      const added = node.dateAdded ?? 0;
      // 无使用记录且添加超过 2 年 → 视为可能长期未访问
      if (lastUsed <= 0 && added > 0 && now - added > TWO_YEARS) unusedTwoYears++;
      return;
    }
    folderCount++;
    if ((node.children?.length ?? 0) === 0) emptyFolders++;
    for (const child of node.children ?? []) walk(child, rootTitle);
  };

  for (const root of roots) {
    const before = { bookmarks: bookmarkCount, folders: folderCount };
    // 直接 walk 根节点本身，确保「书签栏/其他书签」等根文件夹也被计入文件夹数
    walk(root, root.title || root.id);
    perRoot.push({
      root: root.title || root.id,
      bookmarks: bookmarkCount - before.bookmarks,
      folders: folderCount - before.folders,
    });
  }

  return {
    result: JSON.stringify({
      书签总数: bookmarkCount,
      文件夹总数: folderCount,
      空文件夹数: emptyFolders,
      超过两年未访问: unusedTwoYears,
      根目录分布: perRoot,
    }),
  };
}

/** URL 归一化：去协议、www、查询参数与片段、尾斜杠，小写（用于重复检测） */
function normalizeUrl(u: string): string {
  try {
    const parsed = new URL(u.trim());
    parsed.hash = '';
    parsed.search = '';
    if (parsed.hostname.startsWith('www.')) parsed.hostname = parsed.hostname.slice(4);
    return parsed.toString().replace(/\/$/, '');
  } catch {
    // 非标准 URL（如缺失协议）：尽力剥离常见噪声
    return u
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/[?#].*$/, '')
      .replace(/\/+$/, '');
  }
}

const findDuplicatesSchema = z.object({ limit: z.number().int().min(1).max(500).optional() });

/** 查找重复书签（URL 归一化后相同的为一组，重复最多的在前） */
async function findDuplicates(args: unknown): Promise<ToolOutput> {
  const { limit = 50 } = findDuplicatesSchema.parse(args);
  await ensureRoots();
  const tree = await chrome.bookmarks.getTree();
  const byUrl = new Map<string, { id: string; title: string; url: string; parentId?: string }[]>();
  const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[]) => {
    for (const n of nodes) {
      if (n.url) {
        const key = normalizeUrl(n.url);
        const arr = byUrl.get(key) ?? [];
        arr.push({ id: n.id, title: n.title || n.url, url: n.url, parentId: n.parentId });
        byUrl.set(key, arr);
      }
      if (n.children) walk(n.children);
    }
  };
  walk(tree[0]?.children ?? []);
  const dupes = [...byUrl.entries()]
    .filter(([, arr]) => arr.length > 1)
    .sort((a, b) => b[1].length - a[1].length);
  const items = dupes.slice(0, limit).map(([url, arr]) => ({
    url,
    count: arr.length,
    bookmarks: arr.map((b) => ({ id: b.id, title: b.title })),
  }));
  return {
    result: JSON.stringify({
      total: dupes.length,
      shown: items.length,
      note: '重复组按数量降序；如需清理请用 propose_deletions 提交删除提议（保留其中一个）。',
      items,
    }),
  };
}

const sortFolderSchema = z.object({
  parentId: z.string(),
  by: z.enum(['title', 'url', 'dateAdded', 'dateLastUsed']).optional(),
});

/** 对文件夹内子项排序（文件夹置顶 + 按指定字段；直接改写真实顺序） */
async function sortFolder(args: unknown): Promise<ToolOutput> {
  const { parentId, by = 'title' } = sortFolderSchema.parse(args);
  const pid = await assertFolder(parentId);
  const children = await chrome.bookmarks.getChildren(pid);
  if (children.length <= 1) {
    return { result: JSON.stringify({ folder: pid, by, sorted: children.length, note: '子项不足，无需排序。' }) };
  }
  const sorted = [...children].sort((a, b) => {
    const folderDiff = (b.url ? 1 : 0) - (a.url ? 1 : 0);
    if (folderDiff !== 0) return folderDiff;
    switch (by) {
      case 'title':
        return (a.title || '').localeCompare(b.title || '', 'zh', { numeric: true });
      case 'url':
        return (a.url || '').localeCompare(b.url || '');
      case 'dateAdded':
        return (a.dateAdded ?? 0) - (b.dateAdded ?? 0);
      case 'dateLastUsed':
        return (b.dateLastUsed ?? 0) - (a.dateLastUsed ?? 0);
      default:
        return 0;
    }
  });
  for (let i = 0; i < sorted.length; i++) {
    const item = sorted[i]!;
    await chrome.bookmarks.move(item.id, { parentId: pid, index: i });
  }
  return {
    result: JSON.stringify({ folder: pid, by, sorted: sorted.length, note: '已按' + by + '排序并写入真实顺序。' }),
  };
}

const listAllFoldersSchema = z.object({
  // 返回条数上限（默认 200：文件夹很多时结果会被截断，分页取全）
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
});

/** 列出全部文件夹（id + 完整路径），一次 getTree 完成——Agent 找目标文件夹时避免逐层递归 */
async function listAllFolders(args: unknown): Promise<ToolOutput> {
  const { limit = 200, offset = 0 } = listAllFoldersSchema.parse(args);
  await ensureRoots();
  const tree = await chrome.bookmarks.getTree();
  const folders: { id: string; title: string; path: string; count: number }[] = [];
  const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[], chain: string[]) => {
    for (const n of nodes) {
      // 书签不是文件夹（空文件夹的 children 字段可能缺失，不能以 !children 判断）
      if (n.url) continue;
      const title = n.title || '(未命名)';
      const path = [...chain, title].join(' > ');
      folders.push({ id: n.id, title, path, count: n.children?.length ?? 0 });
      walk(n.children ?? [], [...chain, title]);
    }
  };
  walk(tree[0]?.children ?? [], []);
  const page = folders.slice(offset, offset + limit);
  const hasMore = offset + page.length < folders.length;
  return {
    result: JSON.stringify({
      total: folders.length,
      shown: page.length,
      offset,
      nextOffset: hasMore ? offset + page.length : undefined,
      hasMore,
      note: hasMore ? `文件夹共 ${folders.length} 个，本批显示 ${page.length} 个（用 offset=${offset + page.length} 获取下一批）。` : undefined,
      folders: page,
    }),
  };
}

const listEmptySchema = z.object({});

/** 列出所有空文件夹（含完整路径与统计）——清理场景：Agent 据此提议删除空文件夹 */
async function listEmptyFolders(args: unknown): Promise<ToolOutput> {
  listEmptySchema.parse(args);
  await ensureRoots();
  const tree = await chrome.bookmarks.getTree();
  const folders: { id: string; title: string; path: string }[] = [];
  const totalFolders = { n: 0 };
  const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[], chain: string[]) => {
    for (const n of nodes) {
      if (n.url) continue; // 书签不是文件夹
      totalFolders.n++;
      const title = n.title || '(未命名)';
      const path = [...chain, title].join(' > ');
      if ((n.children?.length ?? 0) === 0) folders.push({ id: n.id, title, path });
      walk(n.children ?? [], [...chain, title]);
    }
  };
  walk(tree[0]?.children ?? [], []);
  return {
    result: JSON.stringify({
      total: folders.length,
      totalFolders: totalFolders.n,
      folders,
      note: folders.length > 0 ? '可用 propose_deletions 提议删除这些空文件夹。' : '没有空文件夹。',
    }),
  };
}

const moveBookmarksSchema = z.object({
  ids: z.array(z.string()).min(1).max(50),
  parentId: z.string(),
  index: z.number().int().min(0).optional(),
});

/** 批量移动书签/文件夹到目标文件夹（一次调用替代多轮 move_bookmark） */
async function moveBookmarks(args: unknown): Promise<ToolOutput> {
  const { ids, parentId, index } = moveBookmarksSchema.parse(args);
  await ensureRoots();
  const pid = await assertFolder(parentId);
  const failures: { id: string; error: string }[] = [];
  // 指定 index 时按「逆序」逐个移动到目标位置：
  // 后移动的先占位，先移动的依次插到 index，最终顺序与 ids 一致（正序移动会倒置）
  const ordered = [...ids];
  if (index !== undefined) ordered.reverse();
  for (const id of ordered) {
    try {
      if (isRoot(id)) throw new Error('浏览器根文件夹不可移动');
      await chrome.bookmarks.move(id, { parentId: pid, ...(index !== undefined ? { index } : {}) });
    } catch (e) {
      failures.push({ id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return {
    result: JSON.stringify({
      moved: ids.length - failures.length,
      failed: failures.length,
      failures,
      note:
        failures.length === 0
          ? `已移动 ${ids.length} 项到目标文件夹。`
          : `${failures.length} 项移动失败（${failures.map((f) => f.error).join('；')}）。`,
    }),
  };
}

const copyBookmarkSchema = z.object({
  bookmarkId: z.string(),
  parentId: z.string(),
  title: z.string().optional(),
});

/** 复制书签/文件夹（深拷贝）到目标文件夹 */
async function copyBookmark(args: unknown): Promise<ToolOutput> {
  const { bookmarkId, parentId, title } = copyBookmarkSchema.parse(args);
  const pid = await assertFolder(parentId);
  const nodes = await chrome.bookmarks.get(bookmarkId).catch(() => []);
  const node = nodes[0];
  if (!node) throw new Error(`书签不存在（id: ${bookmarkId}）`);
  const created = await copyNodeDeep(node, pid);
  if (title && node.url) {
    await chrome.bookmarks.update(created, { title }).catch(() => {});
  }
  return { result: JSON.stringify({ copied: created, title: title || node.title || '(未命名)' }) };
}

const openBookmarkSchema = z.object({
  bookmarkId: z.string(),
  background: z.boolean().optional(),
});

/** 打开书签（新标签页；background=true 时后台打开） */
async function openBookmark(args: unknown): Promise<ToolOutput> {
  const { bookmarkId, background = false } = openBookmarkSchema.parse(args);
  const nodes = await chrome.bookmarks.get(bookmarkId).catch(() => []);
  const node = nodes[0];
  if (!node?.url) throw new Error('目标不是可打开的书签');
  await chrome.tabs.create({ url: node.url, active: !background });
  return { result: JSON.stringify({ opened: node.title || node.url }) };
}

const openBookmarksSchema = z.object({
  ids: z.array(z.string()).min(1).max(20),
  background: z.boolean().optional(),
});

/** 批量打开书签（去重；最多 20 个，避免刷爆标签页） */
async function openBookmarks(args: unknown): Promise<ToolOutput> {
  const { ids, background = false } = openBookmarksSchema.parse(args);
  const unique = [...new Set(ids)];
  const opened: string[] = [];
  for (const id of unique) {
    const nodes = await chrome.bookmarks.get(id).catch(() => []);
    const node = nodes[0];
    if (!node?.url) continue;
    await chrome.tabs.create({ url: node.url, active: !background }).catch(() => {});
    opened.push(node.title || node.url);
  }
  return {
    result: JSON.stringify({
      requested: unique.length,
      opened: opened.length,
      titles: opened.slice(0, 10),
      note: opened.length > 0 ? `已打开 ${opened.length} 个标签页。` : '没有可打开的书签。',
    }),
  };
}

/** 按路径查找文件夹 id（如"书签栏 > 技术 > AI"）；找不到返回 undefined */
async function findFolderByPath(path: string): Promise<string | undefined> {
  const tree = await chrome.bookmarks.getTree();
  const parts = path
    .split('>')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;
  const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[], depth: number): string | undefined => {
    for (const n of nodes) {
      if ((n.title || '(未命名)') !== parts[depth]) continue;
      if (depth === parts.length - 1) return n.id;
      if (n.children) {
        const hit = walk(n.children, depth + 1);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  return walk(tree[0]?.children ?? [], 0);
}

const getFolderContentSchema = z.object({
  folderId: z.string().optional(),
  folderPath: z.string().optional(),
  // 每层书签上限；不传用用户配置的默认值
  limit: z.number().int().min(1).max(500).optional(),
  // 递归深度（1=只看子项，2=含孙级），避免一次展开整个书签库
  depth: z.number().int().min(1).max(3).optional(),
});

/** 查看文件夹完整结构（支持路径定位，Agent 规划整理时先摸清结构） */
async function getFolderContent(args: unknown): Promise<ToolOutput> {
  const { folderId, folderPath, limit, depth = 2 } = getFolderContentSchema.parse(args);
  let pid = folderId;
  if (!pid) {
    if (!folderPath) throw new Error('需要 folderId 或 folderPath 之一（路径示例："书签栏 > 技术"）');
    pid = await findFolderByPath(folderPath);
    if (!pid) throw new Error(`找不到文件夹：${folderPath}，可用 list_all_folders 查看现有路径`);
  }
  await assertFolder(pid);
  const defaultLimit = await getToolLimit();
  const useLimit = limit ?? Math.min(defaultLimit, 2000);

  const nodes = await chrome.bookmarks.get(pid).catch(() => []);
  const root = nodes[0];
  if (!root) throw new Error(`文件夹不存在（id: ${pid}）`);

  const serialize = (n: chrome.bookmarks.BookmarkTreeNode, d: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {
      id: n.id,
      title: n.title,
      folder: !n.url,
      ...(n.url ? { url: n.url } : {}),
    };
    if (n.children) {
      out.count = n.children.length;
      if (d < depth) {
        const sliced = n.children.slice(0, useLimit);
        out.children = sliced.map((c) => serialize(c, d + 1));
        if (n.children.length > useLimit) out.truncated = true;
      }
    }
    return out;
  };

  return {
    result: JSON.stringify({
      id: pid,
      title: root.title,
      path: await resolvePath(pid),
      total: (root.children ?? []).length,
      tree: serialize(root, 0),
    }),
  };
}

const exportSchema = z.object({
  scope: z.enum(['all', 'folder']).default('all'),
  folderId: z.string().optional(),
  folderPath: z.string().optional(),
  format: z.enum(['markdown', 'json']).default('markdown'),
  // 每批条数（分页用）；大清单（千条级）请配合 offset 分批获取
  maxItems: z.number().int().min(1).max(5000).optional(),
  offset: z.number().int().min(0).optional(),
  // 是否在每行附带书签 id（后续需要 propose_deletions / move 等按 id 操作时开启）
  includeId: z.boolean().optional(),
});

/**
 * 导出书签清单（扁平化：每行一个书签，含完整 url；支持 offset/maxItems 分页）。
 * includeId=true 时每行附 id（供后续 propose_deletions / move 等按 id 操作，避免二次拉取）。
 * 大清单模型一次看不完时，按返回的 nextOffset 继续取下一批。
 */
async function exportBookmarks(args: unknown): Promise<ToolOutput> {
  const { scope, folderId, folderPath, format, maxItems = 500, offset = 0, includeId = false } =
    exportSchema.parse(args);
  const tree = await chrome.bookmarks.getTree();
  const root = tree[0];

  let rootTitle = '全部书签';
  let source: chrome.bookmarks.BookmarkTreeNode[];
  if (scope === 'folder') {
    let pid = folderId;
    if (!pid && folderPath) pid = await findFolderByPath(folderPath);
    if (!pid) throw new Error('需要 folderId 或 folderPath（导出指定文件夹时）');
    // 必须用 getSubTree 才能拿到子节点（get 只返回单个节点，无 children）
    const sub = await chrome.bookmarks.getSubTree(pid).catch(() => []);
    const branch = sub[0];
    if (!branch) throw new Error(`文件夹不存在（id: ${pid}）`);
    rootTitle = branch.title || '(未命名)';
    source = branch.children ?? [];
  } else {
    source = root?.children ?? [];
  }

  // 扁平化收集全部书签（url 必须完整——模型据此判断主页面/子页面/死链；
  // dateAdded 转日期——模型据此筛选"某年以前收藏"）
  const flat: { title: string; url: string; date: string; id: string }[] = [];
  const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[]) => {
    for (const n of nodes) {
      if (n.url) {
        flat.push({
          title: n.title || n.url,
          url: n.url,
          date: n.dateAdded ? new Date(n.dateAdded).toISOString().slice(0, 10) : '',
          id: n.id,
        });
      }
      if (n.children) walk(n.children);
    }
  };
  walk(source);

  const total = flat.length;
  const page = flat.slice(offset, offset + maxItems);
  const hasMore = offset + page.length < total;
  const content =
    format === 'markdown'
      ? page
          .map(
            (b) =>
              `- [${b.title.replace(/[[\]]/g, '')}](${b.url})${b.date ? ` · ${b.date}` : ''}${includeId ? ` (id: ${b.id})` : ''}`,
          )
          .join('\n')
      : JSON.stringify({
          folder: rootTitle,
          offset,
          total,
          items: page.map((b) => (includeId ? b : { title: b.title, url: b.url, date: b.date })),
        });

  return {
    result: JSON.stringify({
      format,
      scope,
      folder: rootTitle,
      total,
      offset,
      returned: page.length,
      hasMore,
      nextOffset: hasMore ? offset + page.length : undefined,
      note: `共 ${total} 条书签，本批返回 ${page.length} 条${hasMore ? `，还有 ${total - offset - page.length} 条（用 offset=${offset + page.length} 获取下一批）` : '（已全部返回）'}。`,
      content,
    }),
  };
}

const mergeSchema = z.object({
  sourceId: z.string(),
  targetId: z.string(),
});

/**
 * 合并文件夹：把 source 的全部子项移入 target（保持相对顺序）。
 * source 清空后自动提议删除空文件夹（走确认机制，不直接删）。
 */
async function mergeFolders(args: unknown): Promise<ToolOutput> {
  const { sourceId, targetId } = mergeSchema.parse(args);
  await ensureRoots();
  if (sourceId === targetId) throw new Error('源文件夹与目标文件夹相同');
  if (isRoot(sourceId) || isRoot(targetId)) throw new Error('浏览器根文件夹不可合并');

  const [s, t] = await Promise.all([
    chrome.bookmarks.get(sourceId).then((n) => n[0]).catch(() => undefined),
    chrome.bookmarks.get(targetId).then((n) => n[0]).catch(() => undefined),
  ]);
  if (!s) throw new Error(`源文件夹不存在（id: ${sourceId}）`);
  if (!t) throw new Error(`目标文件夹不存在（id: ${targetId}）`);
  if (s.url || t.url) throw new Error('合并的双方都必须是文件夹');

  await assertNoCycle(sourceId, targetId);

  const children = await chrome.bookmarks.getChildren(sourceId);
  let moved = 0;
  for (const child of children) {
    // 逐个追加到 target 末尾，保持相对顺序
    await chrome.bookmarks.move(child.id, { parentId: targetId }).catch(() => {});
    moved++;
  }

  const after = await chrome.bookmarks.getChildren(sourceId);
  const sourceEmpty = after.length === 0;
  const deletions: DeletionProposal[] = sourceEmpty
    ? [
        {
          id: uid(),
          bookmarkId: sourceId,
          title: s.title || '(未命名)',
          reason: `内容已合并到「${t.title || '(未命名)'}」，源文件夹已空`,
          status: 'pending',
          createdAt: Date.now(),
        },
      ]
    : [];

  return {
    result: JSON.stringify({
      moved,
      sourceEmpty,
      target: t.title || '(未命名)',
      note: sourceEmpty
        ? `已移动 ${moved} 项到「${t.title || '(未命名)'}」，源文件夹已空，已提议删除空文件夹等待确认。`
        : `已移动 ${moved} 项到「${t.title || '(未命名)'}」。`,
    }),
    deletions,
  };
}

/** 深拷贝节点到目标文件夹（文件夹递归复制全部子项），返回新节点 id */
async function copyNodeDeep(
  node: chrome.bookmarks.BookmarkTreeNode,
  parentId: string,
  index?: number,
): Promise<string> {
  if (node.url) {
    const created = await chrome.bookmarks.create({ parentId, title: node.title, url: node.url, index });
    return created.id;
  }
  const folder = await chrome.bookmarks.create({ parentId, title: node.title, index });
  for (const child of node.children ?? []) {
    await copyNodeDeep(child, folder.id);
  }
  return folder.id;
}

const proposeSchema = z.object({
  // 上限 1000：清理大库时一次可提议上千条（提议载荷走独立通道，不占模型上下文）
  items: z.array(z.object({ bookmarkId: z.string(), reason: z.string().min(1).max(200) })).min(1).max(1000),
});

/** 读取删除执行模式（confirm=需确认 / auto=自动执行） */
async function getDeleteMode(): Promise<'confirm' | 'auto'> {
  try {
    const data = await chrome.storage.local.get(CONFIG_STORAGE_KEY);
    const cfg = data[CONFIG_STORAGE_KEY] as { deleteMode?: 'confirm' | 'auto' } | undefined;
    return cfg?.deleteMode ?? 'confirm';
  } catch {
    return 'confirm';
  }
}

/** 删除安全机制：默认只生成提议；"无需确认"模式下自动执行 */
async function proposeDeletions(args: unknown): Promise<ToolOutput> {
  const { items } = proposeSchema.parse(args);
  await ensureRoots();
  const mode = await getDeleteMode();
  const deletions: DeletionProposal[] = [];
  let executed = 0;
  let failed = 0;
  for (const item of items) {
    const nodes = await chrome.bookmarks.get(item.bookmarkId).catch(() => []);
    const node = nodes[0];
    if (!node) continue; // 已被删除的跳过
    if (isRoot(node.id)) continue; // 根文件夹不可删
    if (mode === 'auto') {
      // 无需确认模式：直接执行删除
      try {
        if (node.url) await chrome.bookmarks.remove(node.id);
        else await chrome.bookmarks.removeTree(node.id);
        executed++;
        deletions.push({
          id: uid(),
          bookmarkId: node.id,
          title: node.title || node.url || '(未命名)',
          url: node.url,
          reason: item.reason,
          status: 'executed',
          createdAt: Date.now(),
        });
      } catch {
        failed++;
      }
      continue;
    }
    deletions.push({
      id: uid(),
      bookmarkId: node.id,
      title: node.title || node.url || '(未命名)',
      url: node.url,
      reason: item.reason,
      status: 'pending',
      createdAt: Date.now(),
    });
  }
  const note =
    mode === 'auto'
      ? `已自动删除 ${executed} 项${failed > 0 ? `，${failed} 项失败` : ''}（当前为"无需确认"模式）。`
      : '删除提议已提交，等待用户在界面确认后才真正删除。请提醒用户查看界面中的待确认卡片。';
  return {
    result: JSON.stringify({ submitted: deletions.length, skipped: items.length - deletions.length, note }),
    deletions,
  };
}

const deleteAllSchema = z.object({
  reason: z.string().min(1).max(200).optional(),
});

/**
 * 删除全部书签（清空书签栏 / 其他书签 / 移动设备 的所有子项，根文件夹保留）。
 * 默认模式下生成"删除全部"提议等待用户确认；"无需确认"模式下直接执行。
 */
async function deleteAllBookmarks(args: unknown): Promise<ToolOutput> {
  const { reason } = deleteAllSchema.parse(args);
  await ensureRoots();
  const tree = await chrome.bookmarks.getTree();
  const roots = tree[0]?.children ?? [];
  // 收集所有根下的直接子项（递归子树由 removeTree 处理）
  const targets: { id: string; title: string; url?: string }[] = [];
  for (const root of roots) {
    for (const child of root.children ?? []) {
      targets.push({ id: child.id, title: child.title || child.url || '(未命名)', url: child.url });
    }
  }
  if (targets.length === 0) {
    return { result: JSON.stringify({ deleted: 0, note: '书签库已经是空的，无需删除。' }) };
  }

  const mode = await getDeleteMode();
  if (mode === 'auto') {
    let ok = 0;
    let fail = 0;
    for (const t of targets) {
      try {
        if (t.url) await chrome.bookmarks.remove(t.id);
        else await chrome.bookmarks.removeTree(t.id);
        ok++;
      } catch {
        fail++;
      }
    }
    return {
      result: JSON.stringify({
        deleted: ok,
        failed: fail,
        note: `已自动删除全部 ${ok} 项书签（当前为"无需确认"模式）。`,
      }),
    };
  }

  // 确认模式：生成一条"删除全部"提议
  const proposal: DeletionProposal = {
    id: uid(),
    bookmarkId: 'markai:all', // 特殊标记：执行时清空所有根
    title: `全部书签（${targets.length} 项）`,
    reason: reason || 'Agent 请求删除全部书签',
    status: 'pending',
    createdAt: Date.now(),
    all: true,
  };
  return {
    result: JSON.stringify({
      submitted: 1,
      note: `已提交"删除全部书签（${targets.length} 项）"提议，等待用户在界面确认后才执行。请提醒用户查看待确认卡片。`,
    }),
    deletions: [proposal],
  };
}

/** ── 工具注册表与调度 ── */

interface ToolEntry {
  name: string;
  handler: (args: unknown, onProgress?: (text: string) => void) => Promise<ToolOutput>;
}

const TOOL_MAP: Record<string, ToolEntry> = {
  list_bookmarks: { name: 'list_bookmarks', handler: listBookmarks },
  search_bookmarks: { name: 'search_bookmarks', handler: searchBookmarks },
  get_recent_bookmarks: { name: 'get_recent_bookmarks', handler: getRecentBookmarks },
  get_folder_path: { name: 'get_folder_path', handler: getFolderPath },
  list_all_folders: { name: 'list_all_folders', handler: listAllFolders },
  list_empty_folders: { name: 'list_empty_folders', handler: listEmptyFolders },
  create_folder: { name: 'create_folder', handler: createFolder },
  create_bookmark: { name: 'create_bookmark', handler: createBookmark },
  create_bookmarks: { name: 'create_bookmarks', handler: createBookmarks },
  move_bookmark: { name: 'move_bookmark', handler: moveBookmark },
  move_bookmarks: { name: 'move_bookmarks', handler: moveBookmarks },
  copy_bookmark: { name: 'copy_bookmark', handler: copyBookmark },
  open_bookmark: { name: 'open_bookmark', handler: openBookmark },
  open_bookmarks: { name: 'open_bookmarks', handler: openBookmarks },
  get_folder_content: { name: 'get_folder_content', handler: getFolderContent },
  export_bookmarks: { name: 'export_bookmarks', handler: exportBookmarks },
  merge_folders: { name: 'merge_folders', handler: mergeFolders },
  rename_bookmark: { name: 'rename_bookmark', handler: renameBookmark },
  update_bookmark_url: { name: 'update_bookmark_url', handler: updateBookmarkUrl },
  check_urls: { name: 'check_urls', handler: checkUrls },
  check_urls_bulk: { name: 'check_urls_bulk', handler: checkUrlsBulk },
  classify_urls: { name: 'classify_urls', handler: classifyUrls },
  auto_categorize: { name: 'auto_categorize', handler: autoCategorize },
  cleanup_sweep: { name: 'cleanup_sweep', handler: cleanupSweep },
  stats: { name: 'stats', handler: stats },
  find_duplicates: { name: 'find_duplicates', handler: findDuplicates },
  sort_folder: { name: 'sort_folder', handler: sortFolder },
  propose_deletions: { name: 'propose_deletions', handler: proposeDeletions },
  delete_all_bookmarks: { name: 'delete_all_bookmarks', handler: deleteAllBookmarks },
};

/** 执行工具调用（args 为 JSON 字符串；onProgress 供长任务上报进度） */
export async function executeTool(
  name: string,
  argsJson: string,
  onProgress?: (text: string) => void,
): Promise<ToolOutput> {
  const entry = TOOL_MAP[name];
  if (!entry) throw new Error(`未知工具：${name}`);
  let args: unknown;
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    throw new Error('工具参数不是合法 JSON');
  }
  try {
    return await entry.handler(args, onProgress);
  } catch (e) {
    if (e instanceof z.ZodError) {
      throw new Error(`参数不合法：${e.issues.map((i) => i.message).join('；')}`);
    }
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/** 判断工具是否可能修改书签（用于 UI 触发书签树刷新） */
export const MUTATING_TOOLS = new Set([
  'create_folder',
  'create_bookmark',
  'move_bookmark',
  'move_bookmarks',
  'copy_bookmark',
  'rename_bookmark',
  'update_bookmark_url',
  'sort_folder',
  'merge_folders',
  'propose_deletions',
  'delete_all_bookmarks',
  'auto_categorize',
  'cleanup_sweep',
]);

/** 工具显示信息（UI chip 图标与中文名） */
export const TOOL_META: Record<string, { label: string }> = {
  list_bookmarks: { label: '查看书签' },
  search_bookmarks: { label: '搜索书签' },
  get_recent_bookmarks: { label: '最近书签' },
  get_folder_path: { label: '解析路径' },
  list_all_folders: { label: '列出文件夹' },
  list_empty_folders: { label: '空文件夹' },
  create_folder: { label: '新建文件夹' },
  create_bookmark: { label: '新建书签' },
  create_bookmarks: { label: '批量新建' },
  move_bookmark: { label: '移动书签' },
  move_bookmarks: { label: '批量移动' },
  copy_bookmark: { label: '复制书签' },
  open_bookmark: { label: '打开书签' },
  open_bookmarks: { label: '批量打开' },
  get_folder_content: { label: '查看结构' },
  export_bookmarks: { label: '导出清单' },
  merge_folders: { label: '合并文件夹' },
  rename_bookmark: { label: '重命名' },
  update_bookmark_url: { label: '修改 URL' },
  check_urls: { label: '检测链接' },
  check_urls_bulk: { label: '批量检测' },
  classify_urls: { label: '分类 URL' },
  auto_categorize: { label: '自动分类' },
  stats: { label: '统计' },
  find_duplicates: { label: '查找重复' },
  sort_folder: { label: '排序' },
  propose_deletions: { label: '删除提议' },
  delete_all_bookmarks: { label: '删除全部' },
  cleanup_sweep: { label: '一键清理' },
};
