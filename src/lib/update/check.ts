/**
 * ── 检查更新：GitHub Releases → 可呈现的状态 ──
 *
 * 数据源是公开的 latest release（无 token）。这里把网络、限流、解析三类失败
 * 分开，因为用户能采取的动作不同：网络可以重试、403 要等、解析失败重试也没用。
 *
 * 结果缓存 30 分钟：侧边栏一天会被打开很多次，每次开都打一次 API 既慢又容易
 * 撞上未认证的限流（每小时 60 次）。缓存按"最近一次成功 Check"存，
 * 即使当前版本变了也能重新比较，不会把旧结论当新结论。
 *
 * 所有外部依赖（fetch / 时钟 / 存储）都可注入，测试不需要 chrome 与网络。
 */
import { appVersion } from '@/lib/version';
import { compareVersions, parseVersion } from './version';

export const UPDATE_CACHE_KEY = 'markai.update.cache';
export const UPDATE_CACHE_TTL_MS = 30 * 60 * 1000;
export const RELEASES_URL = 'https://api.github.com/repos/xalor888/markai/releases/latest';
/** 无响应就中止：卡在"检查中"比报错更让人以为按钮坏了 */
export const REQUEST_TIMEOUT_MS = 10_000;

export interface ReleaseInfo {
  /** 去掉前导 v 的版本号（用于比较与展示） */
  version: string;
  /** 原始 tag（保留给"打开发布页"与排查） */
  tag: string;
  name: string;
  url: string;
  publishedAt: string;
  /** 已截断的 release notes（纯文本摘要） */
  notes: string;
  prerelease: boolean;
}

export type UpdateErrorKind = 'network' | 'rate-limit' | 'parse' | 'http';

export interface UpdateError {
  kind: UpdateErrorKind;
  message: string;
  status?: number;
}

export type UpdateCheck =
  | {
      status: 'available';
      current: string;
      release: ReleaseInfo;
      checkedAt: number;
      cached: boolean;
    }
  | {
      status: 'up-to-date';
      current: string;
      release: ReleaseInfo;
      checkedAt: number;
      cached: boolean;
    }
  | { status: 'error'; error: UpdateError; checkedAt: number };

/** 存储端口：默认走 chrome.storage.local，测试可注入内存实现 */
export interface UpdateCachePort {
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
}

interface CacheEntry {
  checkedAt: number;
  release: ReleaseInfo;
}

/**
 * 默认存储端口。
 *
 * chrome.storage 在扩展页之外（node 测试、被嵌入的普通页面）可能不存在：
 * 这时退化成模块内存，功能仍可用，只是关掉页面后缓存丢失。
 */
export function createStorageCache(): UpdateCachePort {
  let memory: unknown = null;
  const hasChromeStorage = (): boolean => {
    try {
      return typeof chrome !== 'undefined' && Boolean(chrome.storage?.local);
    } catch {
      return false;
    }
  };
  return {
    async read() {
      if (!hasChromeStorage()) return memory;
      try {
        const data = await chrome.storage.local.get(UPDATE_CACHE_KEY);
        return data[UPDATE_CACHE_KEY] ?? memory;
      } catch {
        return memory;
      }
    },
    async write(value) {
      memory = value;
      if (!hasChromeStorage()) return;
      try {
        await chrome.storage.local.set({ [UPDATE_CACHE_KEY]: value });
      } catch {
        /* 缓存写失败不影响本次检查结果 */
      }
    },
  };
}

function readCache(raw: unknown): CacheEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;
  if (typeof src.checkedAt !== 'number' || !Number.isFinite(src.checkedAt)) return null;
  const release = readReleaseInfo(src.release);
  if (!release) return null;
  return { checkedAt: src.checkedAt, release };
}

/**
 * 缓存里存的是**已归一化**的 ReleaseInfo（notes 已截断），不是 GitHub 原始 JSON，
 * 所以不能拿 parseRelease 去验。这里只做结构校验，坏缓存当没有缓存处理。
 */
function readReleaseInfo(raw: unknown): ReleaseInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;
  if (typeof src.version !== 'string' || typeof src.tag !== 'string') return null;
  if (!parseVersion(src.version) || !parseVersion(src.tag)) return null;
  return {
    version: src.version,
    tag: src.tag,
    name: typeof src.name === 'string' && src.name ? src.name : `v${src.version}`,
    url:
      typeof src.url === 'string' && /^https?:\/\//i.test(src.url)
        ? src.url
        : 'https://github.com/xalor888/markai/releases',
    publishedAt: typeof src.publishedAt === 'string' ? src.publishedAt : '',
    notes: typeof src.notes === 'string' ? src.notes : '',
    prerelease: src.prerelease === true,
  };
}

/** Release notes 摘要：去 HTML 注释、压空行、截到 600 字（超出补省略号） */
export function summarizeNotes(body: string, limit = 600): string {
  if (typeof body !== 'string') return '';
  const text = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}…`;
}

/** 从 GitHub release JSON 里取需要的字段；缺关键字段或版本非法 → null */
export function parseRelease(raw: unknown): ReleaseInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;
  const tag = typeof src.tag_name === 'string' ? src.tag_name.trim() : '';
  const parsed = parseVersion(tag);
  if (!parsed) return null;
  const version = parsed.raw.replace(/^v/, '');
  const htmlUrl = typeof src.html_url === 'string' ? src.html_url.trim() : '';
  const url = /^https?:\/\//i.test(htmlUrl)
    ? htmlUrl
    : 'https://github.com/xalor888/markai/releases';
  return {
    version,
    tag,
    name: typeof src.name === 'string' && src.name.trim() ? src.name.trim() : `v${version}`,
    url,
    publishedAt: typeof src.published_at === 'string' ? src.published_at : '',
    notes: summarizeNotes(typeof src.body === 'string' ? src.body : ''),
    prerelease: src.prerelease === true,
  };
}

export function classifyHttpError(status: number, headers?: Headers): UpdateError {
  if (status === 403 || status === 429) {
    const reset = headers?.get('x-ratelimit-reset');
    const until = reset && /^\d+$/.test(reset) ? new Date(Number(reset) * 1000) : null;
    const when = until && !Number.isNaN(until.getTime()) ? `（额度约在 ${until.toLocaleTimeString()} 恢复）` : '';
    return { kind: 'rate-limit', message: `GitHub 接口限流${when}，请稍后再试`, status };
  }
  return { kind: 'http', message: `GitHub 返回了 HTTP ${status}`, status };
}

function settle(
  release: ReleaseInfo,
  current: string,
  checkedAt: number,
  cached: boolean,
): UpdateCheck {
  const cmp = compareVersions(release.version, current);
  if (cmp === null) {
    return {
      status: 'error',
      error: { kind: 'parse', message: `无法比较当前版本（${current}）与发布版本（${release.version}）` },
      checkedAt,
    };
  }
  return {
    status: cmp > 0 ? 'available' : 'up-to-date',
    current,
    release,
    checkedAt,
    cached,
  };
}

export interface CheckOptions {
  /** 当前版本（默认读扩展清单；测试可注入） */
  current?: string;
  /** 跳过缓存（用户点"重新检查"） */
  force?: boolean;
  now?: () => number;
  fetchImpl?: typeof fetch;
  cache?: UpdateCachePort;
}

export async function checkForUpdate(opts: CheckOptions = {}): Promise<UpdateCheck> {
  const now = opts.now ?? Date.now;
  const current = opts.current ?? appVersion();
  const cache = opts.cache ?? createStorageCache();
  const checkedAt = now();

  if (!opts.force) {
    let cached: CacheEntry | null = null;
    try {
      cached = readCache(await cache.read());
    } catch {
      cached = null;
    }
    if (cached && checkedAt - cached.checkedAt < UPDATE_CACHE_TTL_MS) {
      return settle(cached.release, current, cached.checkedAt, true);
    }
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return {
      status: 'error',
      error: { kind: 'network', message: '当前环境不支持网络请求' },
      checkedAt,
    };
  }

  let release: ReleaseInfo;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      // 浏览器 HTTP 缓存会绕过我们自己的 30 分钟 TTL，这里显式禁用
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) {
      return { status: 'error', error: classifyHttpError(res.status, res.headers), checkedAt };
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return {
        status: 'error',
        error: { kind: 'parse', message: 'GitHub 返回的内容不是合法 JSON' },
        checkedAt,
      };
    }
    const parsed = parseRelease(json);
    if (!parsed) {
      return {
        status: 'error',
        error: { kind: 'parse', message: 'Release 数据里没有可识别的版本号' },
        checkedAt,
      };
    }
    release = parsed;
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    return {
      status: 'error',
      error: {
        kind: 'network',
        message: aborted
          ? `请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒），请检查网络后重试`
          : `网络请求失败：${e instanceof Error ? e.message : String(e)}`,
      },
      checkedAt,
    };
  } finally {
    clearTimeout(timer);
  }

  await cache.write({ checkedAt, release } satisfies CacheEntry);
  return settle(release, current, checkedAt, false);
}

/** 只读缓存（挂载时给顶栏小圆点用，不触发网络） */
export async function readCachedUpdate(
  current = appVersion(),
  cache: UpdateCachePort = createStorageCache(),
  now: () => number = Date.now,
): Promise<UpdateCheck | null> {
  const entry = readCache(await cache.read().catch(() => null));
  if (!entry) return null;
  // 只把"新鲜的"缓存当小圆点依据：过期的结论可能早就被新版本推翻了
  if (now() - entry.checkedAt >= UPDATE_CACHE_TTL_MS) return null;
  return settle(entry.release, current, entry.checkedAt, true);
}
