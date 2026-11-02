/**
 * ── 自动整理日志（可回看、可统计、可重试） ──
 *
 * 为什么需要：自动整理是在后台静默发生的写操作。用户收藏一个页面，几秒后它
 * 可能已经换了位置——如果没有任何记录，这从「贴心」变成「东西自己跑了」。
 * 一条 toast 会消失，日志不会：它回答三个问题：
 *   刚才动了什么？动到哪去了？哪条没成功、能不能重试？
 *
 * 存储：`chrome.storage.local` 的一个键，环形缓冲（默认保留最近 200 条）。
 * 并发：写入通过模块级 promise 链串行化——多条书签同时整理完成时，
 * 「读-改-写」若并发交错会互相覆盖丢记录（真实并发场景：串行队列 + toast 回调）。
 */

export const ORGANIZE_LOG_KEY = 'markai.organize.log';
/** 环形缓冲容量：200 条足够覆盖「最近几次整理」，又不会把 storage 撑大 */
export const ORGANIZE_LOG_LIMIT = 200;
/** 单条字段上限：日志是给人看的摘要，不该把整段 URL/错误栈原样存下来 */
const MAX_DETAIL = 240;
const MAX_URL = 500;

export type OrganizeAction = 'moved' | 'created' | 'skipped' | 'failed';

/** 这次归类是谁下的结论（见 AutoOrganizeResult.via） */
export type OrganizeVia = 'local' | 'model' | 'fallback';

export interface OrganizeLogEntry {
  id: string;
  at: number;
  title: string;
  url: string;
  domain: string;
  action: OrganizeAction;
  detail: string;
  /** 成功后实际落到的文件夹名（用于「它去哪了」） */
  target?: string;
  /** 这次归类是谁下的结论：本地规则 / 模型 / 兜底（缺省 = 这次没有归类） */
  via?: OrganizeVia;
  /** 是否值得用户看一眼（失败 / 因批量风暴跳过） */
  needsAttention?: boolean;
  /** 失败是否可重试（网络/超时类可以，配置类不行） */
  retryable?: boolean;
  /**
   * 对应的撤销点 runId（`auto-organize:<bookmarkId>`）。
   * 自动整理是真实的书签移动，「不满意就撤回来」必须是一步操作，
   * 而不是让用户去撤销历史里翻一个英文 id。
   */
  runId?: string;
  /** 已撤销的时间（存在即表示这条已经撤回过，按钮要变灰） */
  undoneAt?: number;
}

const clip = (s: string, max: number): string => {
  const v = (s ?? '').replace(/\s+/g, ' ').trim();
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
};

/** 生成一条日志（id/at 可注入，便于单测确定性） */
export function makeOrganizeLogEntry(
  input: Omit<OrganizeLogEntry, 'id' | 'at'> & { at?: number },
  now: number = Date.now(),
): OrganizeLogEntry {
  const at = input.at ?? now;
  return {
    id: `${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at,
    title: clip(input.title, 180),
    url: clip(input.url, MAX_URL),
    domain: clip(input.domain, 120),
    action: input.action,
    detail: clip(input.detail, MAX_DETAIL),
    ...(input.target ? { target: clip(input.target, 120) } : {}),
    ...(input.via ? { via: input.via } : {}),
    ...(input.needsAttention ? { needsAttention: true } : {}),
    ...(input.retryable ? { retryable: true } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.undoneAt ? { undoneAt: input.undoneAt } : {}),
  };
}

/**
 * 写入串行化：保证「读-改-写」不会并发覆盖。
 *
 * 声明在**所有使用者之前**：`let` 有暂时性死区，把声明放在第一个使用者后面虽然
 * 靠"函数延迟求值"侥幸能跑，但任何一次顶层调用改造都会立刻变成 ReferenceError。
 */
let writeChain: Promise<void> = Promise.resolve();

/** 就地更新一条日志（用于标记「已撤销」），同样走串行链 */
export function updateOrganizeLogEntry(id: string, patch: Partial<OrganizeLogEntry>): Promise<void> {
  const next = writeChain.then(async () => {
    try {
      const data = await chrome.storage.local.get(ORGANIZE_LOG_KEY);
      const prev = Array.isArray(data[ORGANIZE_LOG_KEY]) ? (data[ORGANIZE_LOG_KEY] as OrganizeLogEntry[]) : [];
      const merged = prev.map((e) => (e?.id === id ? { ...e, ...patch, id: e.id } : e));
      await chrome.storage.local.set({ [ORGANIZE_LOG_KEY]: merged });
    } catch {
      /* 标记失败不影响撤销本身已经发生的事实 */
    }
  });
  writeChain = next.catch(() => {});
  return next;
}

/** 追加一条日志（失败不抛出：日志写不进去不该影响整理本身） */
export function appendOrganizeLog(entry: OrganizeLogEntry): Promise<void> {
  const next = writeChain.then(async () => {
    try {
      const data = await chrome.storage.local.get(ORGANIZE_LOG_KEY);
      const prev = Array.isArray(data[ORGANIZE_LOG_KEY]) ? (data[ORGANIZE_LOG_KEY] as OrganizeLogEntry[]) : [];
      // 新的在前：UI 默认展示「最近发生了什么」
      const merged = [entry, ...prev.filter((e) => e?.id !== entry.id)].slice(0, ORGANIZE_LOG_LIMIT);
      await chrome.storage.local.set({ [ORGANIZE_LOG_KEY]: merged });
    } catch {
      // 配额满 / storage 不可用：整理本身照常完成，不把日志故障升级成用户可见错误
    }
  });
  // 链上任何一环失败都不能毒化后续写入
  writeChain = next.catch(() => {});
  return next;
}

/** 读取日志（按时间倒序，容忍脏数据） */
/**
 * 读整理记录。
 *
 * **读失败会抛**，不再返回空数组。
 *
 * 早先这里 `catch { return [] }`，把"读不到"变成了"没有记录"——
 * 调用方的 `.catch` 永远不触发，于是界面上就会出现
 * 「今天 0 条 / 收藏新页面后会自动归类」这种假话（见 0.2.55 / 0.2.57 / 0.2.58 同类问题）。
 * 错误必须让调用方看见，由它决定怎么呈现。
 */
export async function readOrganizeLog(): Promise<OrganizeLogEntry[]> {
  {
    const data = await chrome.storage.local.get(ORGANIZE_LOG_KEY);
    const raw = Array.isArray(data[ORGANIZE_LOG_KEY]) ? (data[ORGANIZE_LOG_KEY] as unknown[]) : [];
    return raw
      .filter((e): e is OrganizeLogEntry => {
        if (!e || typeof e !== 'object') return false;
        const o = e as Partial<OrganizeLogEntry>;
        return typeof o.id === 'string' && typeof o.at === 'number' && typeof o.action === 'string';
      })
      .sort((a, b) => b.at - a.at)
      .slice(0, ORGANIZE_LOG_LIMIT);
  }
}

/** 清空日志 */
export function clearOrganizeLog(): Promise<void> {
  const next = writeChain.then(async () => {
    try {
      await chrome.storage.local.remove(ORGANIZE_LOG_KEY);
    } catch {
      /* 忽略 */
    }
  });
  writeChain = next.catch(() => {});
  return next;
}

export interface OrganizeStats {
  /** 按归类来源计数：本地规则 / 模型 / 兜底（让用户知道 AI 到底用了多频繁） */
  byVia: Record<OrganizeVia, number>;
  total: number;
  moved: number;
  created: number;
  failed: number;
  /** 今天（本地自然日）成功归类的条数：popup 上「今天已自动整理 N 条」 */
  today: number;
  /** 最近一条成功记录（popup 摘要用） */
  latest: OrganizeLogEntry | null;
}

/** 本地自然日的起点（今天 00:00） */
function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 统计日志（纯函数，便于单测） */
export function summarizeOrganizeLog(entries: OrganizeLogEntry[], now: number = Date.now()): OrganizeStats {
  const dayStart = startOfLocalDay(now);
  let moved = 0;
  let created = 0;
  let failed = 0;
  let today = 0;
  for (const e of entries) {
    if (e.action === 'moved') moved++;
    else if (e.action === 'created') created++;
    else if (e.action === 'failed') failed++;
    if ((e.action === 'moved' || e.action === 'created') && e.at >= dayStart) today++;
  }
  // 「最近一条成功」按时间取最大，**不依赖调用方已排序**：
  // 这个函数被声明为纯函数，单测和导出路径都会直接喂数组，
  // 用 `entries.find(...)` 会静默假设倒序，一旦传入顺序变了就返回错的记录。
  let latest: OrganizeLogEntry | null = null;
  for (const e of entries) {
    if (e.action !== 'moved' && e.action !== 'created') continue;
    if (!latest || e.at > latest.at) latest = e;
  }
  const byVia: Record<OrganizeVia, number> = { local: 0, model: 0, fallback: 0 };
  for (const e of entries) {
    if (e.via) byVia[e.via] += 1;
  }
  return { total: entries.length, moved, created, failed, today, latest, byVia };
}

export interface OrganizeTargetGroup {
  target: string;
  count: number;
}

/**
 * 按「去了哪个文件夹」聚合（只看真正归位的 moved/created）。
 *
 * 用途：用户最想知道的是「它把我东西都塞哪儿了」——单看逐条记录要自己数。
 * 按条数降序；同数按名称排序，保证渲染稳定（不会每次刷新顺序变）。
 */
export function groupByTarget(entries: OrganizeLogEntry[]): OrganizeTargetGroup[] {
  const map = new Map<string, number>();
  for (const e of entries) {
    if (e.action !== 'moved' && e.action !== 'created') continue;
    const target = (e.target || '').trim();
    if (!target) continue;
    map.set(target, (map.get(target) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([target, count]) => ({ target, count }))
    .sort((a, b) => b.count - a.count || a.target.localeCompare(b.target, 'zh'));
}

/**
 * 挑出「可以批量重试」的记录（纯函数，便于单测）。
 *
 * 一次导入/一次网络抖动可能留下十几条失败；逐条点重试是纯粹的体力活。
 * 只挑同时满足「失败 + 可重试 + 还没撤销过」的条目——把不可重试的（配置缺失）
 * 混进来只会让用户点完发现一半没动静。
 */
export function pickRetryableEntries(entries: OrganizeLogEntry[]): OrganizeLogEntry[] {
  return entries.filter((e) => e.action === 'failed' && e.retryable === true && !e.undoneAt);
}

/**
 * 整理记录的筛选（纯函数，便于单测）。
 *
 * 记录上限 200 条，面板一次也只露得出五六行；想找「那天 github 那条」只能滚。
 * 这里把「只看失败」与关键词检索收敛成一次纯计算，UI 只负责渲染结果。
 */
export function filterOrganizeLog(
  entries: OrganizeLogEntry[],
  opts: { query?: string; onlyFailed?: boolean } = {},
): OrganizeLogEntry[] {
  const q = (opts.query ?? '').trim().toLowerCase();
  return entries.filter((e) => {
    if (opts.onlyFailed && e.action !== 'failed') return false;
    if (!q) return true;
    // 标题、域名、网址、去向、说明都参与匹配：用户记得的往往是其中任意一个
    return [e.title, e.domain, e.url, e.target ?? '', e.detail]
      .some((field) => (field ? field.toLowerCase().includes(q) : false));
  });
}

/**
 * 给「自动整理成功」的那条详情补两句人话（纯函数，便于单测）。
 *
 * 两个场景都只在**第一次**或**确实存在**时才说，避免变成每次收藏都重复的噪声：
 *  1. 第一次自动整理：很多人不知道这个后台动作有地方回看/撤销，这是最自然的告知时机；
 *  2. 网址重复：浏览器允许同一 URL 收藏多次，用户往往是手滑点了两次，
 *     在结果里点一句比事后自己去翻「查重」要省事。
 */
export function decorateOrganizeDetail(
  detail: string,
  opts: { firstTime: boolean; duplicateCount: number },
): string {
  const parts = [detail];
  if (opts.firstTime) parts.push('之后可在顶栏「整理」里回看与撤销');
  if (opts.duplicateCount > 1) parts.push(`这个网址你收藏了 ${opts.duplicateCount} 次`);
  return parts.filter(Boolean).join(' · ');
}

/** 本地时间 `YYYY-MM-DD HH:mm`（导出文件要人能读，不用 ISO 的 T/Z） */
function localStamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const ACTION_LABEL: Record<OrganizeAction, string> = {
  moved: '已归入',
  created: '新建并归入',
  failed: '失败',
  skipped: '跳过',
};

/**
 * 把整理记录渲染成 Markdown（纯函数，便于单测）。
 *
 * 为什么需要导出：用户问「它到底动过什么」时，截图和口头描述都不如一份文件；
 * 这也是排查「书签怎么跑到那去了」时最直接的材料。按天分组、每天一个小节。
 */
export function buildOrganizeLogMarkdown(
  entries: OrganizeLogEntry[],
  opts: { now?: number; optOuts?: string[] } = {},
): string {
  const now = opts.now ?? Date.now();
  const out: string[] = ['# MarkAI 整理记录', '', `导出时间：${localStamp(now)}`];

  if (entries.length === 0) {
    out.push('', '（还没有任何整理记录）');
    return out.join('\n');
  }

  const stats = summarizeOrganizeLog(entries, now);
  out.push(
    '',
    `统计：今天 ${stats.today} 条 · 累计归入 ${stats.moved + stats.created} 条 · 失败 ${stats.failed} 条`,
  );
  // 判断来源：排查「怎么这么慢/这么费」时，第一眼要看的就是本地规则命中率
  const viaTotal = stats.byVia.local + stats.byVia.model + stats.byVia.fallback;
  if (viaTotal > 0) {
    out.push(
      '',
      `判断来源：本地规则 ${stats.byVia.local} · 模型 ${stats.byVia.model} · 兜底 ${stats.byVia.fallback}`,
    );
  }
  if (opts.optOuts && opts.optOuts.length > 0) {
    out.push('', `已停用自动整理的站点：${opts.optOuts.join('、')}`);
  }

  // 按天分组（输入已按时间倒序）
  let currentDay = '';
  for (const e of entries) {
    const day = localStamp(e.at).slice(0, 10);
    if (day !== currentDay) {
      currentDay = day;
      out.push('', `## ${day}`, '');
    }
    const time = localStamp(e.at).slice(11);
    const head = `- **${e.title || '(无标题)'}** — ${ACTION_LABEL[e.action] ?? e.action}${
      e.target ? `「${e.target}」` : ''
    }`;
    const meta = [e.domain, time, e.undoneAt ? '已撤销' : ''].filter(Boolean).join(' · ');
    out.push(head);
    if (meta) out.push(`  - ${meta}`);
    if (e.detail) out.push(`  - ${e.detail}`);
  }
  out.push('');
  return out.join('\n');
}

/** 哪些失败值得重试：网络/超时/解析类可重试，配置缺失类不可 */
export function isRetryableFailure(detail: string): boolean {
  const d = detail || '';
  if (/读取配置失败|未开启|非网页|无法识别|不是书签|无法定位/.test(d)) return false;
  return /超时|timeout|abort|网络|network|fetch|5\d\d|429|解析|失败/.test(d);
}
