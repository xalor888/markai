/**
 * ── 模型目录的缓存与加载（IO 全部注入，所以能单测） ──
 *
 * 三条硬规则：
 *  1. **失败不许伪装成成功**：拉不到就如实返回 `error`，并告诉调用方现在的数据来自哪
 *     （`fallback` / 上次缓存）——跟 0.2.x 那一串「静默失败」是同一类教训。
 *  2. **内置快照不算新鲜数据**：`source: 'fallback'` 的缓存永远触发刷新，
 *     否则一次断网会把过期快照钉死 24 小时。
 *  3. **结构版本不符就重拉**，不做迁移：目录是外部数据，迁移代码只会成为负担。
 *
 * 体积：上游 5.7 MB / 235 providers。归一化 + description 截断后落盘约 0.7 MB，
 * 读一次 parse 十几毫秒，而且只在设置页/请求构建时读一次。
 */

import { fallbackCatalog, normalizeCatalog } from './catalog';
import type { CatalogIssue, CatalogProvider, ModelCatalog } from './types';

export const CATALOG_STORAGE_KEY = 'markai.models.catalog';
/** 缓存结构版本：不匹配一律重拉（外部数据不做迁移） */
export const CATALOG_CACHE_VERSION = 1;
/** 新鲜期：24 小时。模型目录不是分钟级数据，拉太勤只是白费流量 */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
export const CATALOG_FETCH_TIMEOUT_MS = 30_000;
export const CATALOG_URL = 'https://models.dev/api.json';
/** description 落盘截断长度（它是唯一的长字段，全留会让缓存翻倍） */
const DESCRIPTION_MAX = 80;

/** 缓存的读写端口（chrome.storage.local 的薄适配在 background 里） */
export interface CatalogCachePort {
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
}

/** 拉取器（注入 AbortSignal，调用方负责超时） */
export type CatalogFetcher = (signal: AbortSignal) => Promise<unknown>;

interface CachedShape {
  version: number;
  fetchedAt: number;
  source: 'remote' | 'fallback';
  providers: CatalogProvider[];
}

/** 目录 → 可落盘结构（裁掉超长 description） */
export function encodeCatalog(catalog: ModelCatalog): CachedShape {
  return {
    version: CATALOG_CACHE_VERSION,
    fetchedAt: catalog.fetchedAt,
    source: catalog.source,
    providers: catalog.providers.map((p) => ({
      id: p.id,
      name: p.name,
      models: p.models.map((m) => ({
        ...m,
        description: m.description && m.description.length > DESCRIPTION_MAX
          ? `${m.description.slice(0, DESCRIPTION_MAX)}…`
          : m.description,
      })),
    })),
  };
}

/**
 * 落盘结构 → 目录。
 *
 * 返回 null 的三种情况都有明确语义：版本不符（重拉）、结构坏（重拉）、源不是 remote/fallback。
 * 不做"尽力修复"——修复出来的半份目录比没有更危险（UI 会显示一堆残缺模型）。
 */
export function decodeCatalog(raw: unknown): ModelCatalog | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r['version'] !== CATALOG_CACHE_VERSION) return null;
  if (typeof r['fetchedAt'] !== 'number' || !Number.isFinite(r['fetchedAt'])) return null;
  const source = r['source'];
  if (source !== 'remote' && source !== 'fallback') return null;
  if (!Array.isArray(r['providers'])) return null;
  const providers: CatalogProvider[] = [];
  for (const p of r['providers'] as unknown[]) {
    if (typeof p !== 'object' || p === null) return null;
    const pr = p as Record<string, unknown>;
    const id = pr['id'];
    if (typeof id !== 'string' || !id) return null;
    if (!Array.isArray(pr['models'])) return null;
    const models = [];
    for (const m of pr['models'] as unknown[]) {
      if (typeof m !== 'object' || m === null) return null;
      const mr = m as Record<string, unknown>;
      if (typeof mr['id'] !== 'string' || !mr['id']) return null;
      // 缺字段的模型一律丢（宁可少一个选项，也不给一个点不动的选项）
      if (typeof mr['reasoning'] !== 'object' || mr['reasoning'] === null) return null;
      models.push(m as ModelCatalog['providers'][number]['models'][number]);
    }
    providers.push({ id, name: typeof pr['name'] === 'string' ? pr['name'] : id, models });
  }
  return { fetchedAt: r['fetchedAt'] as number, source, providers };
}

/** 缓存是否还在新鲜期内（内置快照永远不算新鲜） */
export function isCatalogFresh(fetchedAt: number, now: number, ttl: number = CATALOG_TTL_MS): boolean {
  if (fetchedAt <= 0) return false;
  const age = now - fetchedAt;
  // 时钟被回拨（age < 0）时按"不新鲜"处理：宁可多拉一次，也不要拿未来时间戳当新鲜
  return age >= 0 && age < ttl;
}

export interface CatalogLoadResult {
  catalog: ModelCatalog;
  /** 本次是否真的走了网络（true = 刚拉到的） */
  refreshed: boolean;
  /** null = 一切正常；非空 = 这次没拉到，下面的目录来自缓存或内置快照 */
  error: string | null;
  /** 归一化时被丢掉的坏条目（不静默） */
  issues: CatalogIssue[];
}

interface LoadOptions {
  /** 强制刷新（用户点"刷新目录"） */
  force?: boolean;
  ttlMs?: number;
}

/**
 * 加载目录：缓存优先 → 过期/强制则拉取 → 拉取失败退到旧缓存 → 再退到内置快照。
 *
 * 每一步都把"现在这份数据是什么"说清楚（error 文案里带来源），
 * 因为设置页要据此显示「目录来自 2026-11-08 的缓存，这次刷新失败：…」。
 */
export async function loadCatalog(
  cache: CatalogCachePort,
  fetcher: CatalogFetcher,
  now: number,
  opts: LoadOptions = {},
): Promise<CatalogLoadResult> {
  let cached: ModelCatalog | null = null;
  let cacheError: string | null = null;
  try {
    cached = decodeCatalog(await cache.read());
  } catch (e) {
    // 读缓存失败不是致命错误（本地存储偶发异常），但也不能当作"没有缓存"而静默——记下来
    cacheError = `读取本地缓存失败：${e instanceof Error ? e.message : String(e)}`;
  }

  const ttl = opts.ttlMs ?? CATALOG_TTL_MS;
  if (!opts.force && cached && cached.source === 'remote' && isCatalogFresh(cached.fetchedAt, now, ttl)) {
    return { catalog: cached, refreshed: false, error: cacheError, issues: [] };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CATALOG_FETCH_TIMEOUT_MS);
  try {
    const json = await fetcher(ctrl.signal);
    const { catalog, issues } = normalizeCatalog(json);
    if (catalog.providers.length === 0) {
      // 拉到一份空目录 = 上游改接口了，比网络错误更隐蔽，必须显式失败
      throw new Error('目录里没有任何 provider（上游可能改了接口结构）');
    }
    catalog.fetchedAt = now;
    catalog.source = 'remote';
    try {
      await cache.write(encodeCatalog(catalog));
    } catch (e) {
      // 写缓存失败不影响这次使用，但要留痕（下次会重新拉）
      console.warn('[MarkAI] 模型目录写入缓存失败：', e);
    }
    return { catalog, refreshed: true, error: null, issues };
  } catch (e) {
    const reason = describeFetchError(e);
    if (cached) {
      return {
        catalog: cached,
        refreshed: false,
        error: `刷新模型目录失败：${reason}（当前使用 ${cached.source === 'remote' ? '上次缓存的目录' : '内置离线快照'}）`,
        issues: [],
      };
    }
    const fallback = fallbackCatalog();
    return {
      catalog: fallback,
      refreshed: false,
      error: `刷新模型目录失败：${reason}（当前使用内置离线快照，可能已过期）`,
      issues: [],
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 把底层异常翻译成用户能照做的中文（网络错误与超时不能混为一谈） */
export function describeFetchError(e: unknown): string {
  if (e instanceof DOMException && e.name === 'AbortError') {
    return `请求超时（${CATALOG_FETCH_TIMEOUT_MS / 1000} 秒），请检查网络或代理`;
  }
  if (e instanceof Error) {
    const m = e.message;
    if (m.includes('没有任何 provider')) return m;
    if (m.includes('Failed to fetch') || m.includes('NetworkError') || m.includes('fetch failed')) {
      return '无法连接 models.dev，请检查网络或代理';
    }
    return m;
  }
  return String(e);
}

/** 真实拉取（只在 background 里用；页面侧走消息代理，避免每个页面各自拉 5.7 MB） */
export async function fetchCatalogJson(signal: AbortSignal): Promise<unknown> {
  const res = await fetch(CATALOG_URL, { signal });
  if (!res.ok) throw new Error(`models.dev 返回 ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new Error('目录响应不是有效 JSON');
  }
}
