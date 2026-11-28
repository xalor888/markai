/**
 * 语义搜索装配。
 *
 * 入口挂载时调用一次：先注册检索器（索引没建好也不会让搜索框失效），
 * 再异步建索引。`installSemanticSearch()` 本身不 await——首次建索引要遍历
 * 整棵树并分批向量化，阻塞入口会让侧边栏打开就卡住。
 *
 * 装配状态（条数/占用/进度/降级数）通过 `subscribeSemanticStatus`
 * 暴露给设置页；书签增删改用事件驱动增量同步，不重建整库。
 */

import { registerSemanticSearcher, type SemanticHit, type SemanticSearchOptions } from '@/lib/features/semantic';
import { resolveConfig } from '@/lib/providers';
import type { AIConfig } from '@/lib/ai/types';
import {
  SemanticIndex,
  createChromeStore,
  localEmbedder,
  STORAGE_BUDGET_BYTES,
  type Embedder,
} from './index';
import { fuseSearch } from './search';
import {
  RemoteEmbedder,
  RemoteEmbedError,
  DEFAULT_REMOTE_EMBED_MODEL,
  type RemoteEmbedConfig,
} from './remote-embed';
import {
  readSemanticSettings,
  writeSemanticSettings,
  SEMANTIC_SETTINGS_KEY,
} from './settings';

type BNode = chrome.bookmarks.BookmarkTreeNode;

export interface SemanticStatus {
  ready: boolean;
  building: boolean;
  count: number;
  degradedCount: number;
  bytes: number;
  updatedAt: number;
  model: string;
  progress: number;
  note?: string;
}

const initialStatus: SemanticStatus = {
  ready: false,
  building: false,
  count: 0,
  degradedCount: 0,
  bytes: 0,
  updatedAt: 0,
  model: localEmbedder.id,
  progress: 0,
  note: '本地索引尚未建立。',
};

let status: SemanticStatus = { ...initialStatus };
const statusListeners = new Set<(next: SemanticStatus) => void>();

export function getSemanticStatus(): SemanticStatus {
  return { ...status };
}

export function subscribeSemanticStatus(listener: (next: SemanticStatus) => void): () => void {
  statusListeners.add(listener);
  listener({ ...status });
  return () => statusListeners.delete(listener);
}

function setStatus(patch: Partial<SemanticStatus>): void {
  status = { ...status, ...patch };
  for (const listener of statusListeners) listener({ ...status });
}

function statusFromIndex(target: SemanticIndex): SemanticStatus {
  const manifest = target.manifest;
  return {
    ready: target.ready,
    building: false,
    count: target.count,
    degradedCount: manifest?.degradedCount ?? 0,
    bytes: manifest?.bytes ?? 0,
    updatedAt: manifest?.updatedAt ?? 0,
    model: target.modelId,
    progress: 1,
    note: undefined,
  };
}

/* ── 环境 ── */

function hasChromeBookmarks(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.bookmarks);
}

async function readTreeRoots(): Promise<BNode[]> {
  const tree = await chrome.bookmarks.getTree();
  return tree[0]?.children ?? [];
}

async function readRemoteConfig(): Promise<RemoteEmbedConfig | null> {
  try {
    const data = await chrome.storage.local.get('markai.config');
    const config = resolveConfig((data['markai.config'] as Partial<AIConfig> | undefined) ?? null);
    if (!config.apiKey.trim() || !config.baseUrl.trim()) return null;
    return {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: DEFAULT_REMOTE_EMBED_MODEL,
    };
  } catch {
    return null;
  }
}

/* ── 索引生命周期 ── */

let index: SemanticIndex | null = null;
let embedderRef: Embedder = localEmbedder;
let bootstrapPromise: Promise<void> | null = null;
/** 构建进行中又收到"必须重建"（切换向量来源）时，等当前轮结束后再跑一轮 */
let forceQueued = false;
let buildAbort: AbortController | null = null;
let installed = false;
let listenersInstalled = false;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
const queryCache = new Map<string, number[]>();

function disposeBuild(): void {
  buildAbort?.abort();
  buildAbort = null;
}

async function rebuildWith(target: SemanticIndex, roots: BNode[], remote: boolean): Promise<boolean> {
  disposeBuild();
  const controller = new AbortController();
  buildAbort = controller;
  setStatus({
    building: true,
    ready: false,
    progress: 0,
    note: remote ? '正在用远端向量建立索引…' : '正在建立本地索引…',
  });
  try {
    await target.rebuild(roots, {
      budget: STORAGE_BUDGET_BYTES,
      signal: controller.signal,
      onProgress: (progress) => setStatus({ progress }),
    });
    index = target;
    queryCache.clear();
    setStatus(statusFromIndex(target));
    return true;
  } catch (error) {
    if (controller.signal.aborted) {
      setStatus({ building: false, note: '索引构建已取消。' });
      return false;
    }
    throw error;
  } finally {
    if (buildAbort === controller) buildAbort = null;
  }
}

async function chooseEmbedder(): Promise<{ embedder: Embedder; remote: boolean; note?: string }> {
  const settings = await readSemanticSettings();
  if (!settings.remoteEmbed) return { embedder: localEmbedder, remote: false };
  const config = await readRemoteConfig();
  if (!config) {
    return {
      embedder: localEmbedder,
      remote: false,
      note: '远端向量未启用：缺少 Base URL 或 API Key，已使用本地向量。',
    };
  }
  const remote = new RemoteEmbedder(config, {
    onDisabled: (reason) => {
      // 401/403 立即停用：继续重试只会让每次搜索都多等一个超时
      void writeSemanticSettings({ remoteEmbed: false });
      setStatus({ note: reason });
    },
  });
  return { embedder: remote, remote: true };
}

async function bootstrap(forceRebuild = false): Promise<void> {
  if (bootstrapPromise) {
    if (!forceRebuild) return bootstrapPromise;
    forceQueued = true;
    try {
      await bootstrapPromise;
    } catch {
      // 当前轮的错误已由它自己的 catch 处理；这里只负责排队下一轮
    }
    if (!forceQueued) return;
    forceQueued = false;
    return bootstrap(true);
  }
  if (!hasChromeBookmarks()) return;
  bootstrapPromise = (async () => {
    const roots = await readTreeRoots();
    const chosen = await chooseEmbedder();
    if (chosen.note) setStatus({ note: chosen.note });

    if (chosen.remote) {
      const remoteIndex = new SemanticIndex(createChromeStore(), chosen.embedder);
      if (!forceRebuild) {
        try {
          if (await remoteIndex.load()) {
            index = remoteIndex;
            embedderRef = chosen.embedder;
            setStatus(statusFromIndex(remoteIndex));
            void syncIndex();
            return;
          }
        } catch {
          // 读旧索引失败不值得单独提示：直接重建即可
        }
      }
      try {
        const ok = await rebuildWith(remoteIndex, roots, true);
        if (ok) {
          /*
           * 远端索引可能建得比较久，期间用户把开关关掉了。
           * 以**最新设置**为准：关掉就继续走下面的本地重建，
           * 不把一个用户已经拒绝的远端索引留在磁盘上。
           */
          const latest = await readSemanticSettings();
          if (latest.remoteEmbed) {
            embedderRef = chosen.embedder;
            return;
          }
          setStatus({ note: '已关闭远端向量，正在改用本地索引…' });
        } else {
          return; // 用户取消：保留旧索引，不再往下重建成本地
        }
      } catch (error) {
        if (error instanceof RemoteEmbedError && error.disabled) {
          await writeSemanticSettings({ remoteEmbed: false });
        }
        setStatus({
          note: `远端向量不可用，已改用本地向量：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    // 本地路径（默认，也是远端失败后的降级路径）
    const localIndex = new SemanticIndex(createChromeStore(), localEmbedder);
    if (!forceRebuild) {
      try {
        if (await localIndex.load()) {
          index = localIndex;
          embedderRef = localEmbedder;
          setStatus(statusFromIndex(localIndex));
          void syncIndex();
          return;
        }
      } catch {
        // 同远端：损坏的旧索引直接重建
      }
    }
    const ok = await rebuildWith(localIndex, roots, false);
    if (ok) embedderRef = localEmbedder;
  })()
    .catch((error) => {
      setStatus({
        building: false,
        note: `索引装配失败：${error instanceof Error ? error.message : String(error)}`,
      });
    })
    .finally(() => {
      bootstrapPromise = null;
    });
  return bootstrapPromise;
}

async function syncIndex(): Promise<void> {
  if (!index || !index.ready || status.building) return;
  try {
    const roots = await readTreeRoots();
    const result = await index.sync(roots, { budget: STORAGE_BUDGET_BYTES });
    if (result.added || result.updated || result.removed) {
      setStatus(statusFromIndex(index));
    }
  } catch (error) {
    if (error instanceof RemoteEmbedError && error.disabled) {
      await writeSemanticSettings({ remoteEmbed: false });
    }
    setStatus({
      note: `索引增量更新失败：${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

function scheduleSync(): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void syncIndex();
  }, 600);
}

function installBookmarkListeners(): void {
  if (listenersInstalled || !hasChromeBookmarks()) return;
  listenersInstalled = true;
  chrome.bookmarks.onCreated.addListener(scheduleSync);
  chrome.bookmarks.onRemoved.addListener(scheduleSync);
  chrome.bookmarks.onChanged.addListener(scheduleSync);
  chrome.bookmarks.onMoved.addListener(scheduleSync);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[SEMANTIC_SETTINGS_KEY]) {
      const next = changes[SEMANTIC_SETTINGS_KEY].newValue as { remoteEmbed?: boolean } | undefined;
      const nextRemote = next?.remoteEmbed === true;
      // 已经是目标实现时不必重建：远端构建失败会自动写回 false，这条事件不该再触发一轮
      if (nextRemote === embedderRef.id.startsWith('remote:')) return;
      // 开关状态决定向量来源；切换必须整库重建，不能混用两种向量
      void bootstrap(true).catch(() => {});
      if (nextRemote) setStatus({ note: '已开启远端向量，正在重建索引…' });
      return;
    }
    if (changes['markai.config'] && embedderRef.id.startsWith('remote:')) {
      void bootstrap(true).catch(() => {});
    }
  });
}

/** 入口调用：注册检索器 + 异步建索引（永不阻塞入口） */
export function installSemanticSearch(): void {
  if (installed) return;
  installed = true;
  registerSemanticSearcher(async (roots, query, opts) => runSemanticSearch(roots, query, opts));
  if (!hasChromeBookmarks()) return;
  installBookmarkListeners();
  void bootstrap();
}

/** 设置页「重建索引」 */
export async function rebuildSemanticIndex(): Promise<void> {
  if (!hasChromeBookmarks()) return;
  if (bootstrapPromise) await bootstrapPromise;
  await bootstrap(true);
}

/** 设置页「取消」：只停当前构建，已落盘的旧索引继续可用 */
export function cancelSemanticBuild(): void {
  disposeBuild();
}

/**
 * 检索入口：索引未就绪返回空数组，由 `features/semantic` 的关键词兜底接手。
 *
 * 远端索引的查询向量必须用同一个模型现算；远端失败时同样返回空数组，
 * 让整条链路退回关键词——绝不在这里抛错把搜索框打挂。
 */
export async function runSemanticSearch(
  roots: BNode[],
  query: string,
  opts: SemanticSearchOptions = {},
): Promise<SemanticHit[]> {
  if (!query.trim()) return [];
  if (!index || !index.ready) {
    if (hasChromeBookmarks() && !bootstrapPromise && !status.building) void bootstrap();
    return [];
  }

  let queryVector: number[] | undefined;
  if (embedderRef.id.startsWith('remote:')) {
    const cacheKey = `${embedderRef.id}:${query.trim().toLowerCase()}`;
    queryVector = queryCache.get(cacheKey);
    if (!queryVector) {
      try {
        queryVector = await embedderRef.embedQuery(query);
        if (queryCache.size > 32) queryCache.clear();
        queryCache.set(cacheKey, queryVector);
      } catch {
        return [];
      }
    }
  }

  try {
    return fuseSearch(index.entries.values(), query, {
      ...opts,
      ...(queryVector ? { queryVector } : {}),
      // 远端向量没有哈希碰撞问题，纯语义命中不该被词汇锚点限制
      ...(embedderRef.id.startsWith('remote:') ? { requireLexicalAnchor: false } : {}),
    });
  } catch {
    return [];
  }
}
