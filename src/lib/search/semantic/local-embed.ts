/**
 * ── 本地确定性特征哈希向量 ──
 *
 * 为什么不用模型：书签搜索是"每次按键都要算"的热路径，而默认路径必须离线、
 * 不把用户的收藏发给第三方。特征哈希（hashing trick）没有权重文件、没有 WASM，
 * 小几百维就够把"字面相关"的书签聚在一起；它也不理解同义词，所以同义扩展
 * 由 `search.ts` 的显式同义词表补足——那里可解释、可测试，而"模型懂一切"是幻觉。
 *
 * 确定性约束：同样的输入永远得到同样的向量。这里没有随机种子、没有时间、
 * 没有做任何依赖运行环境顺序的事——索引分片落盘后重载，排序不会变。
 */

/** 向量维度：384 是 1000~5000 条书签规模下精度与存储的折中 */
export const EMBED_DIM = 384;

/** 分词规则版本：规则一改，旧索引必须整库重建 */
export const TOKENIZER_VERSION = 2;

/** 每个条目最多保留的 token 数（用于关键词扩展加分；不保留全文） */
const MAX_STORED_TOKENS = 64;

/** 中文/日文/韩文字符：这些语言按字与 2-gram 切，英文按词切 */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

/**
 * 停用词：只去掉"几乎每条书签都有"的词。
 * 去掉太多会把"设计"这种有效分类也滤掉——停用词表宁短勿长。
 */
const STOPWORDS = new Set([
  // 英文
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'with', 'at', 'by', 'from',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they', 'their', 'his', 'her',
  'not', 'no', 'but', 'if', 'then', 'so', 'do', 'does', 'did', 'can', 'could', 'should',
  'would', 'will', 'just', 'also', 'more', 'most', 'very', 's', 't', 'com', 'www',
  // 中文：单字虚词 + 常见无信息量词
  '的', '了', '和', '与', '在', '是', '我', '有', '就', '不', '人', '都', '一', '上',
  '也', '很', '到', '说', '要', '去', '你', '会', '着', '看', '好', '这', '那', '把',
  '被', '从', '对', '为', '以', '及', '等', '中', '下', '个', '们', '而', '又', '或',
  '一个', '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '如何', '以及',
  '或者', '因为', '所以', '但是', '如果', '可以', '已经', '一些', '这些', '那些',
  '就是', '还是', '只是', '没有', '自己', '现在',
]);

/** FNV-1a 32 位：小、快、确定，JS 里用 Math.imul 保证不溢出成浮点 */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function isCjk(ch: string): boolean {
  return CJK_RE.test(ch);
}

/**
 * 中英混排分词。
 *
 * 英文/数字按连续字母数字切词；CJK 按单字 + 相邻 2-gram 切，
 * 再保留长度 ≥2 的整段（让「代码托管」这种完整词有更高权重）。
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  // NFKC 把全角字母/数字归一成半角；toLowerCase 让 GitHub 与 github 同词
  const normalized = text.normalize('NFKC').toLowerCase();
  const tokens: string[] = [];
  let latin = '';
  let cjkRun = '';

  const flushLatin = () => {
    if (!latin) return;
    const word = latin;
    latin = '';
    if (word.length < 2 || STOPWORDS.has(word)) return;
    tokens.push(word);
    // 复数/第三人称单数做一次轻量词干化：tools / tool、designs / design
    if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) {
      const stem = word.slice(0, -1);
      if (!STOPWORDS.has(stem)) tokens.push(stem);
    }
  };

  const flushCjk = () => {
    if (!cjkRun) return;
    const run = cjkRun;
    cjkRun = '';
    for (const ch of run) {
      if (!STOPWORDS.has(ch)) tokens.push(ch);
    }
    for (let i = 0; i + 1 < run.length; i++) {
      const gram = run.slice(i, i + 2);
      if (!STOPWORDS.has(gram)) tokens.push(gram);
    }
    // 整段只在 2~8 字时保留：更长的一段更像句子，单独成 token 会被偶然命中
    if (run.length >= 2 && run.length <= 8 && !STOPWORDS.has(run)) tokens.push(run);
  };

  for (const ch of normalized) {
    if (isCjk(ch)) {
      flushLatin();
      cjkRun += ch;
    } else if (/[\p{L}\p{N}]/u.test(ch)) {
      flushCjk();
      latin += ch;
    } else {
      flushLatin();
      flushCjk();
    }
  }
  flushLatin();
  flushCjk();
  return tokens;
}

/**
 * 从 URL 里取"域名/路径词"。
 *
 * 书签标题往往很短（"GitHub"），域名和路径反而携带分类信息
 * （github.com/reactjs → reactjs）。这些词单独加权，避免标题一个词定生死。
 */
export function tokenizeUrl(url: string): { host: string[]; path: string[] } {
  if (!url) return { host: [], path: [] };
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    return { host: [], path: [] };
  }
  const splitParts = (value: string): string[] =>
    value
      .split(/[./\-_%+?=&#~:@!]+/)
      .flatMap((part) => part.split(/(?=[A-Z])/))
      .map((part) => part.normalize('NFKC').toLowerCase())
      .filter((part) => part.length >= 2 && !STOPWORDS.has(part));

  let host = '';
  try {
    host = decodeURIComponent(parsed.hostname);
  } catch {
    host = parsed.hostname;
  }
  let path = parsed.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // 非法百分号编码保持原样即可，分词不依赖解码成功
  }
  return {
    host: splitParts(host.replace(/^www\./, '')),
    path: [...splitParts(path), ...splitParts(parsed.search)],
  };
}

/** 加权 token 表：同一个词在不同字段出现时权重相加，但重复次数做次线性压缩 */
function addTokens(target: Map<string, number>, tokens: string[], weight: number): void {
  if (tokens.length === 0) return;
  const local = new Map<string, number>();
  for (const token of tokens) local.set(token, (local.get(token) ?? 0) + 1);
  for (const [token, count] of local) {
    // 1 + ln(tf)：标题里重复 5 次不该拿到 5 倍权重
    const w = weight * (1 + Math.log(count));
    target.set(token, (target.get(token) ?? 0) + w);
  }
}

/**
 * 由加权 token 生成 L2 归一化向量。
 *
 * 特征哈希的符号位（sign）用来抵消哈希碰撞：两个无关词撞到同一维时，
 * 一个加一个减，期望上互相抵消，而不是把相似度推到 1。
 */
export function buildVector(weights: Map<string, number>, dim = EMBED_DIM): number[] {
  const vector = new Array<number>(dim).fill(0);
  for (const [token, weight] of weights) {
    if (weight === 0) continue;
    const h = hash32(token);
    const idx = h % dim;
    const sign = (hash32(`${token}#sign`) & 1) === 0 ? 1 : -1;
    vector[idx] = (vector[idx] ?? 0) + sign * weight;
  }
  return l2Normalize(vector);
}

/** L2 归一化：零向量原样返回（空输入不该产生 NaN） */
export function l2Normalize(vector: number[]): number[] {
  let sum = 0;
  for (const value of vector) sum += value * value;
  if (sum <= 0 || !Number.isFinite(sum)) return vector.map(() => 0);
  const inv = 1 / Math.sqrt(sum);
  return vector.map((value) => Math.round(value * inv * 10000) / 10000);
}

/** 余弦相似度：两个向量都已归一化时就是点积 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na <= 0 || nb <= 0) return 0;
  return dot / Math.sqrt(na * nb);
}

export interface BookmarkEmbedInput {
  title: string;
  url?: string;
  path?: string;
}

export interface EmbedResult {
  vector: number[];
  /** 唯一 token，按权重从高到低截前 64 个，供关键词扩展加分 */
  tokens: string[];
}

/** 书签的加权 token 表：标题 1.0、路径 0.8、域名 1.6、URL 路径 1.1 */
export function bookmarkTokenWeights(input: BookmarkEmbedInput): Map<string, number> {
  const weights = new Map<string, number>();
  addTokens(weights, tokenize(input.title), 1);
  addTokens(weights, tokenize(input.path ?? ''), 0.8);
  const url = tokenizeUrl(input.url ?? '');
  addTokens(weights, url.host, 1.6);
  addTokens(weights, url.path, 1.1);
  return weights;
}

/** 把书签编码成向量 + 截断后的 token 清单（纯函数） */
export function embedBookmark(input: BookmarkEmbedInput): EmbedResult {
  const weights = bookmarkTokenWeights(input);
  const vector = buildVector(weights);
  const tokens = [...weights.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0], 'en'))
    .slice(0, MAX_STORED_TOKENS)
    .map(([token]) => token);
  return { vector, tokens };
}

/** 查询向量：只由查询词本身生成；同义扩展在 search.ts 里叠加 */
export function embedQuery(query: string): number[] {
  return buildVector(tokenWeightsOfTokens(tokenize(query)));
}

/** 由 token 列表构造权重表（查询与扩展词共用） */
export function tokenWeightsOfTokens(tokens: string[], weight = 1): Map<string, number> {
  const weights = new Map<string, number>();
  addTokens(weights, tokens, weight);
  return weights;
}
