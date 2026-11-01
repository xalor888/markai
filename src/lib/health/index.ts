import { getPreset, resolveConfig } from '@/lib/providers';
import type { AIConfig } from '@/lib/ai/types';
import { CRASH_KEY } from '@/lib/health/fixes';
import { diagnose } from '@/lib/health/diagnostics';
import type { HealthReport, HealthSnapshot } from '@/lib/health/types';

/**
 * ── 健康检查编排 ──
 *
 * 把「读浏览器状态」和「判断」分开：
 *   - 判断在 `diagnostics.ts`，纯函数、可穷举；
 *   - 读取在这里，只负责把真实状态搬进快照，不掺任何结论。
 *
 * 这样将来加一条检查时，只需要在 diagnostics 里加一个分支 + 一个单测，
 * 不用碰浏览器 API，也不会因为 mock 和真实行为漂移而漏判。
 */

type BNode = chrome.bookmarks.BookmarkTreeNode;

/** 书签库的形状统计（纯函数：传一棵树进来，算完返回） */
export function analyzeBookmarks(roots: BNode[], allNodes?: BNode[]): NonNullable<HealthSnapshot['bookmarks']> {
  let folders = 0;
  let emptyFolders = 0;
  let maxDepth = 0;
  let total = 0;

  const walk = (nodes: BNode[], depth: number) => {
    if (depth > maxDepth) maxDepth = depth;
    for (const n of nodes) {
      if (n.url) {
        total++;
      } else {
        folders++;
        const kids = n.children ?? [];
        if (kids.length === 0) emptyFolders++;
        walk(kids, depth + 1);
      }
    }
  };
  for (const root of roots) walk(root.children ?? [], 1);

  // 同父同名的文件夹组数（同一父目录下重名 → 归类时容易选错）
  let duplicateNameGroups = 0;
  const scanDup = (parent: BNode) => {
    const seen = new Map<string, number>();
    for (const child of parent.children ?? []) {
      if (child.url) continue;
      const key = (child.title || '').trim().toLowerCase();
      if (!key) continue;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      scanDup(child);
    }
    for (const n of seen.values()) if (n > 1) duplicateNameGroups++;
  };
  for (const root of roots) scanDup(root);

  /*
   * 孤儿：书签的 parentId 指向一个不存在的节点。
   * 这种数据不会出现在任何树里（chome 的 getTree 只管能连上的），
   * 所以必须拿全量列表自己比对——否则永远显示"0 个孤儿"。
   */
  let orphaned = 0;
  if (allNodes) {
    const ids = new Set(allNodes.map((n) => n.id));
    for (const n of allNodes) {
      // 三个根节点的 parentId 是 "0"，它不在列表里，属于正常
      if (n.parentId && n.parentId !== '0' && !ids.has(n.parentId)) orphaned++;
    }
  }

  return { total, folders, emptyFolders, maxDepth, orphaned, duplicateNameGroups };
}

/** 从整理记录里找最近一条失败原因（诊断要给"最近一次 AI 为什么失败"） */
function lastAiErrorOf(entries: unknown): string | null {
  if (!Array.isArray(entries)) return null;
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const rec = e as Record<string, unknown>;
    if (rec.action === 'failed' && typeof rec.detail === 'string' && rec.detail.trim()) {
      return rec.detail.trim();
    }
  }
  return null;
}

/** 采集真实状态（只读，不写任何东西） */
export async function readSnapshot(): Promise<HealthSnapshot> {
  let configError: string | null = null;
  let config: HealthSnapshot['config'] = null;
  try {
    // 与 background 走同一个 storage key 与同一套归一化（resolveConfig），
    // 否则诊断看到的配置和运行时实际用的不是同一份，结论就是错的
    const raw = await chrome.storage.local.get('markai.config');
    const c = resolveConfig(raw['markai.config'] as Partial<AIConfig> | undefined);
    config = {
      providerId: c.providerId ?? null,
      baseUrl: c.baseUrl ?? null,
      apiKey: c.apiKey ?? null,
      model: c.model ?? null,
      customHeaders: c.customHeaders ?? null,
      autoOrganizeNew: c.autoOrganizeNew ?? null,
      autoOrganizeAi: c.autoOrganizeAi ?? null,
      contextWindow: (c as { contextWindow?: number }).contextWindow ?? null,
    };
  } catch (e) {
    configError = e instanceof Error ? e.message : String(e);
  }

  const preset = config?.providerId ? getPreset(config.providerId) : undefined;
  const providerNeedsKey = preset?.needsKey === true;

  /*
   * `chrome.permissions` 在极少数环境里可能不存在（旧内核 / 测试替身）。
   * 这里防御性读：拿不到就当作"未报告权限"，而不是让整次体检崩掉——
   * 一次检查失败会让用户以为扩展坏了，比漏报一条更糟。
   */
  const permissions = await (chrome.permissions?.getAll?.() ?? Promise.resolve({ permissions: [] as string[] }))
    .then((p) => p.permissions ?? [])
    .catch(() => [] as string[]);

  const store = await chrome.storage.local.get(['markai.undo', 'markai.organize.log', CRASH_KEY]).catch(() => ({}) as Record<string, unknown>);
  const undoPoints = (store as Record<string, unknown>)['markai.undo'];
  const logEntries = (store as Record<string, unknown>)['markai.organize.log'];
  const crash = (store as Record<string, unknown>)[CRASH_KEY] as { count?: number } | undefined;

  let bookmarks: HealthSnapshot['bookmarks'] = null;
  try {
    const tree = await chrome.bookmarks.getTree();
    // 全量 search 只为算孤儿；库太大时（>5000）跳过，避免一次诊断就卡住
    const all = await chrome.bookmarks.search({}).catch(() => null);
    bookmarks = analyzeBookmarks(tree, all && all.length <= 5000 ? all : undefined);
  } catch {
    bookmarks = null;
  }

  let storageBytes: number | null = null;
  try {
    storageBytes = await chrome.storage.local.getBytesInUse(null);
  } catch {
    storageBytes = null;
  }

  return {
    configError,
    config,
    providerNeedsKey,
    permissions,
    undoPoints,
    logEntries,
    bookmarks,
    storageBytes,
    lastAiError: lastAiErrorOf(logEntries),
    crashCount: typeof crash?.count === 'number' ? crash.count : 0,
  };
}

/** 读 + 判 = 一次完整检查 */
export async function runHealthCheck(): Promise<HealthReport> {
  return diagnose(await readSnapshot());
}
