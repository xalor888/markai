/**
 * 重复书签的判定与「保留哪一条」的规则（纯逻辑，不碰 chrome.*）。
 *
 * 抽出来的理由：清理重复原先要靠模型把每组的 id 逐个抄进 propose_deletions，
 * 几百组时既费 token 又极易抄错。这里把「分组」与「保留谁」变成可单测的确定性逻辑，
 * 工具只负责按既有安全闸门执行。
 */

/** 去重所需的最小节点形状（与 chrome.bookmarks.BookmarkTreeNode 兼容） */
export interface DupeNode {
  id: string;
  title: string;
  url?: string;
  parentId?: string;
  /** 收藏时间（越小越早） */
  dateAdded?: number;
  /** 最近使用时间（可能缺省，0 表示未知） */
  dateLastUsed?: number;
  children?: DupeNode[];
}

export interface DupeGroup {
  /** 归一化后的 URL（分组键） */
  key: string;
  items: DupeNode[];
}

/**
 * 不影响内容的跟踪类查询参数。
 *
 * 只剥这些，**不是**剥掉全部查询参数：参数在很多站点就是内容标识
 * （`youtube.com/watch?v=…`、`shop/item?id=…`、`forum/post?p=…`）。
 * 一律丢掉会把两个**完全不同的页面**判成重复，去重工具接着就把其中一条删了。
 */
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'utm_name',
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid', 'yclid', 'twclid',
  'mc_cid', 'mc_eid', 'igshid', 'vero_id', 'oly_anon_id', 'oly_enc_id',
  '_ga', '_gl', 'ref_src', 'ref_url', 'spm', 'scm',
]);

/**
 * 是否是跟踪参数。
 *
 * 除了名单里的具体项，还认 **`utm_` 前缀**（`utm_source`/`utm_medium`…）与裸 `utm`——
 * 后者是常见的简写形式，只列具体项会漏掉它。
 */
function isTrackingParam(name: string): boolean {
  const n = name.toLowerCase();
  return TRACKING_PARAMS.has(n) || n === 'utm' || n.startsWith('utm_');
}

/** 去掉跟踪参数；没有参数剩余时把 `?` 也去掉（否则会留下一个空查询串影响字符串比较） */
function stripTrackingParams(parsed: URL): void {
  const keep: [string, string][] = [];
  for (const [k, v] of parsed.searchParams) {
    if (!isTrackingParam(k)) keep.push([k, v]);
  }
  if (keep.length === 0) {
    parsed.search = '';
    return;
  }
  // 重排为规范顺序：同一组参数在不同顺序下应判为同一页
  const sp = new URLSearchParams();
  for (const [k, v] of keep.sort((a, b) => (a[0] === b[0] ? 0 : a[0] < b[0] ? -1 : 1))) sp.append(k, v);
  parsed.search = sp.toString();
}

/**
 * URL 归一化：去片段、去跟踪参数、去 www、去尾斜杠。
 *
 * **保留真正的内容参数**：`?v=AAA` 与 `?v=BBB` 是两个不同的页面，不能判成重复
 * （见 `TRACKING_PARAMS` 的说明）。参数顺序也会被规范化，避免同一页因顺序不同漏判。
 *
 * 注意**协议差异按设计保留**（http 与 https 视为不同）：
 * 自动改写协议或据此判重都可能在用户不知情时改变收藏的语义。
 */
export function normalizeUrl(u?: string): string {
  if (!u) return '';
  try {
    const parsed = new URL(u.trim());
    parsed.hash = '';
    stripTrackingParams(parsed);
    if (parsed.hostname.startsWith('www.')) parsed.hostname = parsed.hostname.slice(4);
    return parsed.toString().replace(/\/$/, '');
  } catch {
    // 非标准 URL（如缺失协议）：尽力剥离常见噪声（**同样只剥跟踪参数**）
    const withoutHash = u.trim().replace(/#.*$/, '');
    const qAt = withoutHash.indexOf('?');
    const base = (qAt >= 0 ? withoutHash.slice(0, qAt) : withoutHash).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
    const query = qAt >= 0 ? withoutHash.slice(qAt + 1) : '';
    const kept = query
      .split('&')
      .filter(Boolean)
      .filter((kv) => !isTrackingParam(kv.split('=')[0]!))
      .sort()
      .join('&');
    return (kept ? `${base}?${kept}` : base).replace(/\/+$/, '');
  }
}

/** 按归一化 URL 分组，只返回有重复的组（组内多的在前） */
export function buildDuplicateGroups(nodes?: DupeNode[]): DupeGroup[] {
  if (!nodes || nodes.length === 0) return [];
  const byUrl = new Map<string, DupeNode[]>();
  const walk = (list: DupeNode[]) => {
    for (const n of list) {
      if (n.url) {
        const key = normalizeUrl(n.url);
        const arr = byUrl.get(key) ?? [];
        arr.push(n);
        byUrl.set(key, arr);
      }
      if (n.children?.length) walk(n.children);
    }
  };
  walk(nodes);
  return [...byUrl.entries()]
    .filter(([, arr]) => arr.length > 1)
    .map(([key, items]) => ({ key, items }))
    .sort((a, b) => b.items.length - a.items.length);
}

export interface KeeperChoice {
  /** 保留哪一条 */
  keep: DupeNode;
  /** 建议删除的其余条目 */
  remove: DupeNode[];
  /** 为什么留它（面向用户的人话，会出现在提议与预览里） */
  reason: string;
}

/**
 * 标题是不是「只是网址原文」——`https://e.test/a`、`e.test/a` 这类。
 *
 * 为什么要区分：原来这里判的是 `title !== url`，想表达"用户改过名"。
 * 但 Chrome 收藏页面时标题取的是**页面标题**，几乎从不等于 URL —— 于是那条规则
 * 对绝大多数书签恒为真，用户看到的理由永远是「它有自定义标题（改过名的通常是你在意的那条）」，
 * 可他从来没改过名；真正决定胜负的根本不是它。
 *
 * 改成判「标题是否只是网址」：这类标题确实没有信息量，保留它没意义。
 */
function isUrlLikeTitle(n: DupeNode): boolean {
  const t = (n.title || '').trim();
  if (!t) return true;
  const u = (n.url || '').trim();
  if (!u) return false;
  const bare = (x: string) =>
    x.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '').toLowerCase();
  return t.toLowerCase() === u.toLowerCase() || bare(t) === bare(u);
}

/** 四道规则的稳定比较（分值越小越优先） */
function rank(a: DupeNode, b: DupeNode): number {
  // 「只是网址原文」的排在后面：Number(true)=1 大，排在后面
  const readable = Number(isUrlLikeTitle(a)) - Number(isUrlLikeTitle(b));
  if (readable !== 0) return readable;
  const used = (b.dateLastUsed ?? 0) - (a.dateLastUsed ?? 0);
  if (used !== 0) return used;
  const added = (a.dateAdded ?? Number.MAX_SAFE_INTEGER) - (b.dateAdded ?? Number.MAX_SAFE_INTEGER);
  if (added !== 0) return added;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function pickDuplicateKeeper(items: DupeNode[]): KeeperChoice {
  if (items.length === 0) throw new Error('pickDuplicateKeeper：组内没有条目');
  const sorted = [...items].sort(rank);
  const keep = sorted[0]!;
  const remove = sorted.slice(1);

  /*
   * 理由**按真正分出胜负的那一步**来说。
   *
   * 原来是一串 if：先看 keep 有没有"自定义标题"，有就写"它有自定义标题"——
   * 但那条规则几乎恒为真，于是无论实际是哪一步决定胜负，理由永远说同一句话。
   * 用户读到的是一个与事实无关的解释。
   */
  const runner = sorted[1];
  let reason: string;
  if (!runner) {
    reason = '组内只有这一条';
  } else if (isUrlLikeTitle(runner) && !isUrlLikeTitle(keep)) {
    reason = '它的标题是给人看的，其余几条只是网址原文';
  } else if ((keep.dateLastUsed ?? 0) !== (runner.dateLastUsed ?? 0) && (keep.dateLastUsed ?? 0) > 0) {
    reason = '它最近被使用过';
  } else if ((keep.dateAdded ?? Number.MAX_SAFE_INTEGER) !== (runner.dateAdded ?? Number.MAX_SAFE_INTEGER)) {
    reason = '它收藏得最早';
  } else {
    reason = '按 id 稳定排序取第一条（其余条件相同）';
  }

  return { keep, remove, reason };
}
