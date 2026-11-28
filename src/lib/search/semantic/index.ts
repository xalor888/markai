/**
 * ── 语义索引：分片、增量、容量护栏 ──
 *
 * 存储放在 `chrome.storage.local`，但本文件不直接依赖 chrome：
 * 读写的差异被收进 `SemanticStore`，测试用内存实现就能跑完整逻辑。
 *
 * 为什么分片：单 key 塞进上千条向量会逼近存储配额，而且每次改一条书签都要
 * 重写整个 key。按 id 哈希分片后，增量事件只重写命中的那一片。
 *
 * 为什么有容量护栏：`storage.local` 总量有限，向量只是"更好搜"的增强，
 * 不能因为它把配额吃满、连带聊天记录与设置都存不进去。超预算时按
 * 「最近使用 → 最近收藏」保留向量，其余降级为仅关键词，并在状态里如实计数。
 */

import { EMBED_DIM, TOKENIZER_VERSION, embedBookmark, type BookmarkEmbedInput } from './local-embed';

type BNode = chrome.bookmarks.BookmarkTreeNode;

/** 索引结构版本：分词/存储格式变更时 +1，旧索引整库重建 */
export const INDEX_VERSION = TOKENIZER_VERSION;

/** 单片上限：超过 200 条就重新选分片数 */
export const SHARD_LIMIT = 200;

/** 索引默认存储预算：8 MiB（chrome.storage.local 总配额 10 MiB） */
export const STORAGE_BUDGET_BYTES = 8 * 1024 * 1024;

export const STORAGE_PREFIX = 'markai.semantic.v1';
export const MANIFEST_KEY = `${STORAGE_PREFIX}.manifest`;
export const shardKey = (index: number): string => `${STORAGE_PREFIX}.shard.${index}`;

export interface IndexEntry {
  id: string;
  url: string;
  title: string;
  path: string;
  parentId?: string;
  /** 从根到父文件夹的 id 链：用于文件夹限定与整棵子树删除 */
  ancestors: string[];
  dateAdded: number;
  dateLastUsed?: number;
  /** L2 归一化向量；降级/未加载时可能为 null */
  vector: number[] | null;
  /** 唯一 token（排序后截断），用于同义扩展加分 */
  tokens: string[];
  /** true = 超预算降级，仅参与关键词匹配，不持久化向量 */
  degraded: boolean;
}

export interface IndexManifest {
  version: number;
  dim: number;
  /** 向量实现标识：本地 = local-hash-vN，远端 = remote:<model> */
  model: string;
  shards: number;
  count: number;
  degradedCount: number;
  updatedAt: number;
  bytes: number;
}

/** 书签向量化接口：本地同步实现、远端批量实现共用 */
export interface Embedder {
  id: string;
  /** 维度；远端实现第一次请求前为 0，拿到响应后由调用方写入 */
  dim: number;
  embedBookmarks(inputs: BookmarkEmbedInput[]): Promise<number[][]>;
  embedQuery(query: string): Promise<number[]>;
}

export const localEmbedder: Embedder = {
  id: 'local-hash-v2',
  dim: EMBED_DIM,
  async embedBookmarks(inputs) {
    return inputs.map((input) => embedBookmark(input).vector);
  },
  async embedQuery(query) {
    // 查询与书签必须用同一套 token 规则；否则余弦相似度没有意义
    return embedBookmark({ title: query }).vector;
  },
};

export interface SemanticStore {
  readManifest(): Promise<IndexManifest | null>;
  readShard(index: number): Promise<IndexEntry[]>;
  writeShard(index: number, entries: IndexEntry[]): Promise<void>;
  removeShard(index: number): Promise<void>;
  writeManifest(manifest: IndexManifest): Promise<void>;
  /** 实际占用（可选）：有就用来校准预算，没有就用序列化长度估算 */
  bytesInUse?(): Promise<number>;
}

/** 内存实现（测试 / 无 chrome 环境） */
export function createMemoryStore(): SemanticStore & {
  dump(): Record<string, unknown>;
  totalBytes(): number;
} {
  const data = new Map<string, unknown>();
  return {
    async readManifest() {
      return (data.get(MANIFEST_KEY) as IndexManifest | undefined) ?? null;
    },
    async readShard(index) {
      return (data.get(shardKey(index)) as IndexEntry[] | undefined) ?? [];
    },
    async writeShard(index, entries) {
      data.set(shardKey(index), entries);
    },
    async removeShard(index) {
      data.delete(shardKey(index));
    },
    async writeManifest(manifest) {
      data.set(MANIFEST_KEY, manifest);
    },
    async bytesInUse() {
      let total = 0;
      for (const value of data.values()) total += JSON.stringify(value).length;
      return total;
    },
    dump() {
      return Object.fromEntries(data);
    },
    totalBytes() {
      let total = 0;
      for (const value of data.values()) total += JSON.stringify(value).length;
      return total;
    },
  };
}

/** chrome.storage.local 实现（只在扩展环境调用） */
export function createChromeStore(): SemanticStore {
  const area = () => chrome.storage.local;
  return {
    async readManifest() {
      const data = await area().get(MANIFEST_KEY);
      return (data[MANIFEST_KEY] as IndexManifest | undefined) ?? null;
    },
    async readShard(index) {
      const key = shardKey(index);
      const data = await area().get(key);
      return (data[key] as IndexEntry[] | undefined) ?? [];
    },
    async writeShard(index, entries) {
      await area().set({ [shardKey(index)]: entries });
    },
    async removeShard(index) {
      await area().remove(shardKey(index));
    },
    async writeManifest(manifest) {
      await area().set({ [MANIFEST_KEY]: manifest });
    },
    async bytesInUse() {
      return area().getBytesInUse();
    },
  };
}

/*
 * ── 树的扁平化 ──
 *
 * `timeline.ts` 的 `flattenBookmarks` 只给显示路径；索引还需要祖先 id 链
 * （文件夹限定、删除整棵子树），所以这里独立走一遍。路径口径保持一致：
 * 根节点用固定名称（书签栏 / 其他书签 / 移动设备），段与段之间用 " / "。
 */

export interface FlatBookmark {
  id: string;
  url: string;
  title: string;
  path: string;
  parentId?: string;
  ancestors: string[];
  dateAdded: number;
  dateLastUsed?: number;
}

function labelOf(node: BNode, isRoot: boolean): string {
  const title = (node.title || '').trim();
  if (title) return title;
  if (!isRoot) return '(未命名)';
  if (node.id === '1') return '书签栏';
  if (node.id === '2') return '其他书签';
  if (node.id === '3') return '移动设备';
  return '根目录';
}

export function flattenWithAncestors(roots: BNode[]): FlatBookmark[] {
  const out: FlatBookmark[] = [];
  const walk = (node: BNode, parentNames: string[], ancestors: string[], isRoot: boolean) => {
    if (node.url) {
      out.push({
        id: node.id,
        url: node.url,
        title: node.title || node.url,
        path: parentNames.join(' / '),
        ...(node.parentId ? { parentId: node.parentId } : {}),
        ancestors,
        dateAdded: typeof node.dateAdded === 'number' ? node.dateAdded : 0,
        ...(typeof node.dateLastUsed === 'number' && node.dateLastUsed > 0
          ? { dateLastUsed: node.dateLastUsed }
          : {}),
      });
      return;
    }
    const nextNames = [...parentNames, labelOf(node, isRoot)];
    const nextAncestors = [...ancestors, node.id];
    for (const child of node.children ?? []) walk(child, nextNames, nextAncestors, false);
  };
  for (const root of roots) walk(root, [], [], true);
  return out;
}

/** 持久化时降级条目不带向量：它们只需要标题/路径/ token 供关键词使用 */
export function serializeEntry(entry: IndexEntry): IndexEntry {
  return entry.degraded ? { ...entry, vector: null, degraded: true } : entry;
}

const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

/**
 * 存储预算按 UTF-8 字节算。
 *
 * `JSON.stringify(...).length` 数的是 UTF-16 码元：中文标题/路径/ token
 * 实际占 3 字节却只算 1，按它做 8 MiB 预算会低估到接近配额上限才降级。
 */
function utf8Length(text: string): number {
  return textEncoder ? textEncoder.encode(text).length : text.length * 3;
}

export function estimateEntryBytes(entry: IndexEntry): number {
  return utf8Length(JSON.stringify(serializeEntry(entry)));
}

/**
 * 容量护栏：先算出"全部降级"的底座占用，再按最近使用/收藏顺序把向量装回去。
 * 返回需要降级的 id 集合（纯函数，便于断言）。
 */
export function planDegradedIds(entries: IndexEntry[], budget = STORAGE_BUDGET_BYTES): Set<string> {
  if (entries.length === 0) return new Set();
  let base = 0;
  const vectorBytes = new Map<string, number>();
  for (const entry of entries) {
    const degradedForm = { ...entry, vector: null, degraded: true };
    const degradedBytes = utf8Length(JSON.stringify(degradedForm));
    base += degradedBytes;
    if (entry.vector) {
      /*
       * 显式按「未降级」序列化来算差价。
       * 不能用 `estimateEntryBytes(entry)`：它在 entry.degraded 为 true 时会把向量剥掉，
       * 于是"已降级"条目的向量占用被算成 0，下一轮容量检查会把它重新判定为可保留——
       * 索引会在"超预算 → 解除降级 → 再超预算"之间来回抖。
       */
      const fullBytes = utf8Length(JSON.stringify({ ...entry, degraded: false }));
      vectorBytes.set(entry.id, Math.max(0, fullBytes - degradedBytes));
    }
  }
  if (base >= budget) return new Set(entries.filter((e) => e.vector).map((e) => e.id));

  const candidates = entries
    .filter((entry) => entry.vector)
    .sort((a, b) => {
      // 最近打开优先；其次是最近收藏；最后用 id 保证确定性
      const ua = a.dateLastUsed || 0;
      const ub = b.dateLastUsed || 0;
      if (ua !== ub) return ub - ua;
      if (a.dateAdded !== b.dateAdded) return b.dateAdded - a.dateAdded;
      return a.id.localeCompare(b.id, 'en', { numeric: true });
    });

  let used = base;
  const kept = new Set<string>();
  for (const entry of candidates) {
    const bytes = vectorBytes.get(entry.id) ?? 0;
    if (used + bytes > budget) continue;
    used += bytes;
    kept.add(entry.id);
  }
  return new Set(candidates.filter((entry) => !kept.has(entry.id)).map((entry) => entry.id));
}

/* ── 分片 ── */

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function bucketOf(id: string, shards: number): number {
  return shards <= 1 ? 0 : fnv1a(id) % shards;
}

/** 选一个让每片都不超过 SHARD_LIMIT 的分片数（id 哈希分布不均时逐次加片） */
export function chooseShardCount(ids: string[], limit = SHARD_LIMIT): number {
  if (ids.length === 0) return 1;
  let shards = Math.max(1, Math.ceil(ids.length / limit));
  for (let guard = 0; guard <= ids.length; guard++) {
    const counts = new Array<number>(shards).fill(0);
    for (const id of ids) counts[bucketOf(id, shards)] = (counts[bucketOf(id, shards)] ?? 0) + 1;
    if (counts.every((count) => count <= limit)) return shards;
    shards++;
  }
  return ids.length;
}

function shardFits(ids: string[], shards: number, limit = SHARD_LIMIT): boolean {
  if (shards <= 0) return false;
  const counts = new Array<number>(shards).fill(0);
  for (const id of ids) {
    const index = bucketOf(id, shards);
    counts[index] = (counts[index] ?? 0) + 1;
    if ((counts[index] ?? 0) > limit) return false;
  }
  return true;
}

const yieldToMain = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

export interface BuildOptions {
  budget?: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** 每个批次之间的让出间隔（测试里可以设为 0 次） */
  yieldBetweenBatches?: boolean;
}

function makeEntry(item: FlatBookmark, vector: number[]): IndexEntry {
  const tokens = embedBookmark({ title: item.title, url: item.url, path: item.path }).tokens;
  return {
    id: item.id,
    url: item.url,
    title: item.title,
    path: item.path,
    ...(item.parentId ? { parentId: item.parentId } : {}),
    ancestors: item.ancestors,
    dateAdded: item.dateAdded,
    ...(item.dateLastUsed ? { dateLastUsed: item.dateLastUsed } : {}),
    vector,
    tokens,
    degraded: false,
  };
}

/** 批量向量化：64 条一批，批间让出主线程（首次建索引不阻塞 UI） */
export async function embedItems(
  items: FlatBookmark[],
  embedder: Embedder,
  opts: BuildOptions = {},
): Promise<IndexEntry[]> {
  const out: IndexEntry[] = [];
  const batchSize = 64;
  const shouldYield = opts.yieldBetweenBatches !== false;
  for (let offset = 0; offset < items.length; offset += batchSize) {
    if (opts.signal?.aborted) throw new Error('索引构建已取消');
    const slice = items.slice(offset, offset + batchSize);
    const vectors = await embedder.embedBookmarks(
      slice.map((item) => ({ title: item.title, url: item.url, path: item.path })),
    );
    if (vectors.length !== slice.length) {
      throw new Error(`向量数量不匹配：期望 ${slice.length}，实际 ${vectors.length}`);
    }
    const first = vectors[0];
    if (embedder.dim === 0 && first) embedder.dim = first.length;
    for (let i = 0; i < slice.length; i++) {
      const item = slice[i]!;
      const vector = vectors[i] ?? [];
      if (vector.length !== embedder.dim) {
        throw new Error(`向量维度不一致：索引为 ${embedder.dim}，本次为 ${vector.length}`);
      }
      out.push(makeEntry(item, vector));
    }
    opts.onProgress?.(Math.min(1, (offset + slice.length) / Math.max(1, items.length)));
    if (shouldYield) await yieldToMain();
  }
  opts.onProgress?.(1);
  return out;
}

/** 无状态建索引（Agent 工具在 Service Worker 里按需使用，不落盘） */
export function buildEntriesFromRoots(roots: BNode[]): IndexEntry[] {
  const items = flattenWithAncestors(roots);
  return items.map((item) => makeEntry(item, embedBookmark({ title: item.title, url: item.url, path: item.path }).vector));
}

export class SemanticIndex {
  readonly entries = new Map<string, IndexEntry>();
  manifest: IndexManifest | null = null;

  private readonly store: SemanticStore;
  private readonly embedder: Embedder;
  private readonly now: () => number;
  private dirtyIds = new Set<string>();
  private dirtyBuckets = new Set<number>();

  constructor(store: SemanticStore, embedder: Embedder, now: () => number = Date.now) {
    this.store = store;
    this.embedder = embedder;
    this.now = now;
  }

  get ready(): boolean {
    return this.manifest !== null;
  }

  get count(): number {
    return this.entries.size;
  }

  get modelId(): string {
    return this.embedder.id;
  }

  /** 从存储加载；版本/模型/维度不匹配时返回 false，调用方整库重建 */
  async load(): Promise<boolean> {
    const manifest = await this.store.readManifest();
    if (!manifest) return false;
    if (manifest.version !== INDEX_VERSION || manifest.model !== this.embedder.id) return false;
    if (this.embedder.dim !== 0 && manifest.dim !== this.embedder.dim) return false;
    if (this.embedder.dim === 0) this.embedder.dim = manifest.dim;
    if (!shardFits([], manifest.shards)) return false;

    const shards = await Promise.all(
      Array.from({ length: manifest.shards }, (_, i) => this.store.readShard(i)),
    );
    this.entries.clear();
    for (const shard of shards) {
      for (const entry of shard) {
        this.entries.set(entry.id, {
          ...entry,
          ancestors: entry.ancestors ?? [],
          tokens: entry.tokens ?? [],
          degraded: entry.degraded ?? entry.vector === null,
          vector: entry.vector ?? null,
        });
      }
    }
    this.manifest = manifest;
    this.dirtyIds.clear();
    this.dirtyBuckets.clear();
    return true;
  }

  /** 整库重建：不 await 在入口处等待，由 UI 层以异步进度方式驱动 */
  async rebuild(roots: BNode[], opts: BuildOptions = {}): Promise<void> {
    const items = flattenWithAncestors(roots);
    const entries = await embedItems(items, this.embedder, opts);
    if (opts.signal?.aborted) throw new Error('索引构建已取消');
    this.entries.clear();
    for (const entry of entries) this.entries.set(entry.id, entry);
    this.applyCapacity(opts.budget ?? STORAGE_BUDGET_BYTES);
    await this.persistAll();
  }

  /**
   * 与整棵树对齐的增量同步。
   *
   * 只对「标题/URL 变了」的条目重算向量；路径、父级、时间变化只更新元数据。
   * 移动文件夹会改变整棵子树的 path，但子树的向量不变——这正是增量要省的部分。
   */
  async sync(
    roots: BNode[],
    opts: BuildOptions = {},
  ): Promise<{ added: number; updated: number; removed: number }> {
    const items = flattenWithAncestors(roots);
    const seen = new Set<string>();
    let added = 0;
    let updated = 0;
    let removed = 0;
    const pending: FlatBookmark[] = [];

    for (const item of items) {
      seen.add(item.id);
      const current = this.entries.get(item.id);
      if (!current) {
        pending.push(item);
        continue;
      }
      const contentChanged = current.title !== item.title || current.url !== item.url;
      if (contentChanged) {
        pending.push(item);
        continue;
      }
      const sameAncestors =
        current.ancestors.length === item.ancestors.length &&
        current.ancestors.every((id, i) => id === item.ancestors[i]);
      const metaChanged =
        current.path !== item.path ||
        current.parentId !== item.parentId ||
        !sameAncestors ||
        current.dateAdded !== item.dateAdded ||
        (current.dateLastUsed ?? 0) !== (item.dateLastUsed ?? 0);
      if (metaChanged) {
        this.entries.set(item.id, {
          ...current,
          path: item.path,
          ...(item.parentId ? { parentId: item.parentId } : { parentId: undefined }),
          ancestors: item.ancestors,
          dateAdded: item.dateAdded,
          ...(item.dateLastUsed ? { dateLastUsed: item.dateLastUsed } : { dateLastUsed: undefined }),
        });
        this.dirtyIds.add(item.id);
        updated++;
      }
    }

    const vectors = await embedItems(pending, this.embedder, opts);
    for (const entry of vectors) {
      const existed = this.entries.has(entry.id);
      this.entries.set(entry.id, entry);
      this.dirtyIds.add(entry.id);
      if (existed) updated++;
      else added++;
    }

    for (const id of [...this.entries.keys()]) {
      if (seen.has(id)) continue;
      if (this.manifest) this.dirtyBuckets.add(bucketOf(id, this.manifest.shards));
      this.entries.delete(id);
      removed++;
    }

    this.applyCapacity(opts.budget ?? STORAGE_BUDGET_BYTES);
    await this.persist();
    return { added, updated, removed };
  }

  /** 超预算时按优先级把部分条目标记为"仅关键词" */
  applyCapacity(budget = STORAGE_BUDGET_BYTES): void {
    const degraded = planDegradedIds([...this.entries.values()], budget);
    for (const entry of this.entries.values()) {
      const next = degraded.has(entry.id);
      if (entry.degraded !== next) {
        entry.degraded = next;
        this.dirtyIds.add(entry.id);
      }
    }
  }

  private updatedManifest(shards: number): IndexManifest {
    let bytes = 0;
    let degradedCount = 0;
    for (const entry of this.entries.values()) {
      bytes += estimateEntryBytes(entry);
      if (entry.degraded) degradedCount++;
    }
    return {
      version: INDEX_VERSION,
      dim: this.embedder.dim,
      model: this.embedder.id,
      shards,
      count: this.entries.size,
      degradedCount,
      updatedAt: this.now(),
      bytes,
    };
  }

  private pickShards(): number {
    const ids = [...this.entries.keys()];
    const current = this.manifest?.shards ?? 0;
    if (current > 0 && shardFits(ids, current)) return current;
    return chooseShardCount(ids);
  }

  private async persist(): Promise<void> {
    const ids = [...this.entries.keys()];
    const shards = this.pickShards();
    if (!this.manifest || this.manifest.shards !== shards) {
      await this.persistAll(shards);
      return;
    }

    const affected = new Set<number>(this.dirtyBuckets);
    for (const id of this.dirtyIds) affected.add(bucketOf(id, shards));
    if (affected.size === 0) return;

    const buckets = new Map<number, IndexEntry[]>();
    for (const id of ids) {
      const bucket = bucketOf(id, shards);
      if (!affected.has(bucket)) continue;
      const entry = this.entries.get(id);
      if (!entry) continue;
      const list = buckets.get(bucket) ?? [];
      list.push(serializeEntry(entry));
      buckets.set(bucket, list);
    }
    for (const bucket of affected) {
      // 已删空的片写空数组而不是 removeShard：manifest 仍引用这个编号
      await this.store.writeShard(bucket, buckets.get(bucket) ?? []);
    }
    this.manifest = this.updatedManifest(shards);
    await this.store.writeManifest(this.manifest);
    this.dirtyIds.clear();
    this.dirtyBuckets.clear();
  }

  private async persistAll(shards = this.pickShards()): Promise<void> {
    const buckets = new Map<number, IndexEntry[]>();
    for (const entry of this.entries.values()) {
      const bucket = bucketOf(entry.id, shards);
      const list = buckets.get(bucket) ?? [];
      list.push(serializeEntry(entry));
      buckets.set(bucket, list);
    }
    for (let i = 0; i < shards; i++) {
      await this.store.writeShard(i, buckets.get(i) ?? []);
    }
    const previous = this.manifest?.shards ?? 0;
    for (let i = shards; i < previous; i++) await this.store.removeShard(i);
    this.manifest = this.updatedManifest(shards);
    await this.store.writeManifest(this.manifest);
    this.dirtyIds.clear();
    this.dirtyBuckets.clear();
  }

  /** 清空索引（设置页「重建」失败时不留半库） */
  async clear(): Promise<void> {
    const previous = this.manifest?.shards ?? 0;
    for (let i = 0; i < previous; i++) await this.store.removeShard(i);
    this.entries.clear();
    this.manifest = null;
    this.dirtyIds.clear();
    this.dirtyBuckets.clear();
  }
}
