import { getPreset } from '@/lib/providers';
import { parseCustomHeaders } from '@/lib/ai/request-headers';
import { MAX_LOG_ENTRIES, MAX_UNDO_POINTS } from '@/lib/health/diagnostics';
import type { FixAction } from '@/lib/health/types';

/**
 * ── 修复动作 ──
 *
 * 三条硬规矩（写在这里是因为它们比代码更重要的）：
 *
 * 1. **只动 MarkAI 自己的元数据**：`markai.config` / `markai.undo` / `markai.organize.log` /
 *    运行时标记。永远不移动、删除、重命名用户的任何书签或文件夹。
 *    书签层面的问题只报告——用户已经被"自动批量搬书签"坑过一次。
 * 2. **幂等**：同一个动作连跑三次，结果和跑一次一样。
 * 3. **不抛异常**：失败返回 `{ ok: false, detail }`，让调用方能把原因显示出来。
 *    修复本身炸掉，比不修复更让人慌。
 */

export interface FixResult {
  ok: boolean;
  detail: string;
}

const CONFIG_KEY = 'markai.config';
const UNDO_KEY = 'markai.undo';
const LOG_KEY = 'markai.organize.log';
/** service worker 非正常退出的计数（由 SW 启动时读取/累加，这里只负责清零） */
export const CRASH_KEY = 'markai.runtime.crash';

type Dict = Record<string, unknown>;

async function readDict(key: string): Promise<Dict> {
  const data = await chrome.storage.local.get(key).catch(() => ({}) as Dict);
  const v = (data as Dict)[key];
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Dict) : {};
}

async function writeDict(key: string, value: unknown): Promise<boolean> {
  try {
    await chrome.storage.local.set({ [key]: value });
    return true;
  } catch {
    return false;
  }
}

/* ────────────────────────── 配置类 ────────────────────────── */

/** 补齐该服务商的默认 Base URL 与空模型名（不碰用户已填的值） */
async function fillConfigDefaults(): Promise<FixResult> {
  const cfg = await readDict(CONFIG_KEY);
  const preset = getPreset(typeof cfg.providerId === 'string' ? cfg.providerId : '');
  if (!preset) return { ok: false, detail: '这个服务商没有内置默认值，请手动填写 Base URL 与模型。' };

  const patch: Dict = {};
  if (!String(cfg.baseUrl ?? '').trim() && preset.baseUrl) patch.baseUrl = preset.baseUrl;
  if (!String(cfg.model ?? '').trim() && preset.models?.[0]) patch.model = preset.models[0];
  if (Object.keys(patch).length === 0) {
    return { ok: false, detail: '没有可以自动填的字段（Base URL 与模型都已填好），请检查 API Key。' };
  }
  const ok = await writeDict(CONFIG_KEY, { ...cfg, ...patch });
  return ok
    ? { ok: true, detail: `已填入：${Object.keys(patch).join(' / ')}。API Key 需要你自己去服务商后台拿，无法代为填写。` }
    : { ok: false, detail: '写入配置失败（存储不可写）。' };
}

/** 把不像地址的 Base URL 修成合法形式：补协议、去尾部斜杠 */
async function normalizeBaseUrl(): Promise<FixResult> {
  const cfg = await readDict(CONFIG_KEY);
  const raw = String(cfg.baseUrl ?? '').trim();
  if (!raw) return { ok: false, detail: 'Base URL 是空的，没有可修正的内容。' };

  let next = raw.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(next)) next = `https://${next}`;
  try {
    // eslint-disable-next-line no-new
    new URL(next);
  } catch {
    return { ok: false, detail: `「${raw.slice(0, 60)}」修不成合法地址，请手动填写。` };
  }
  if (next === raw) return { ok: true, detail: '已经是合法地址，无需改动。' };

  const ok = await writeDict(CONFIG_KEY, { ...cfg, baseUrl: next });
  return ok ? { ok: true, detail: `已改为 ${next}` } : { ok: false, detail: '写入配置失败。' };
}

/** 删掉解析失败的自定义请求头行（合法的行原样保留） */
async function dropBadHeaders(): Promise<FixResult> {
  const cfg = await readDict(CONFIG_KEY);
  const raw = String(cfg.customHeaders ?? '');
  if (!raw.trim()) return { ok: true, detail: '没有自定义请求头，无需处理。' };

  const parsed = parseCustomHeaders(raw);
  if (parsed.errors.length === 0) return { ok: true, detail: '所有行都合法，无需改动。' };

  // 逐行重新走一次解析：只保留自己能独立解析成功的行
  const kept: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      kept.push(line);
      continue;
    }
    if (parseCustomHeaders(line).errors.length === 0) kept.push(line);
  }
  const next = kept.join('\n').trim();
  const ok = await writeDict(CONFIG_KEY, { ...cfg, customHeaders: next });
  return ok
    ? { ok: true, detail: `已删除 ${parsed.errors.length} 行写错的请求头，其余保留。` }
    : { ok: false, detail: '写入配置失败。' };
}

/* ────────────────────────── 撤销点 ────────────────────────── */

const KNOWN_OP_KINDS = new Set(['move', 'update', 'create', 'remove', 'sort']);

function isUsableUndoPoint(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const p = value as Dict;
  if (typeof p.id !== 'string' || !p.id) return false;
  if (typeof p.runId !== 'string') return false;
  if (!Array.isArray(p.ops)) return false;
  return p.ops.every((op) => !!op && typeof op === 'object' && KNOWN_OP_KINDS.has(String((op as Dict).kind)));
}

/** 清理结构损坏的撤销点（正常的点一条不动） */
async function dropCorruptUndo(): Promise<FixResult> {
  const store = await readDict(UNDO_KEY);
  const points = Array.isArray(store.points) ? store.points : [];
  const kept = points.filter(isUsableUndoPoint);
  const dropped = points.length - kept.length;
  if (dropped === 0) return { ok: true, detail: '没有损坏的撤销点。' };

  const ok = await writeDict(UNDO_KEY, { ...store, points: kept });
  return ok
    ? { ok: true, detail: `已清理 ${dropped} 个损坏的撤销点，保留 ${kept.length} 个正常记录。` }
    : { ok: false, detail: '写入撤销记录失败。' };
}

/** 超出上限的撤销点裁到最近 N 个（与运行时保留策略一致：新的在前） */
async function trimUndoOverflow(): Promise<FixResult> {
  const store = await readDict(UNDO_KEY);
  const points = Array.isArray(store.points) ? store.points.filter(isUsableUndoPoint) : [];
  if (points.length <= MAX_UNDO_POINTS) return { ok: true, detail: `撤销点数量正常（${points.length}）。` };

  const kept = points.slice(0, MAX_UNDO_POINTS);
  const ok = await writeDict(UNDO_KEY, { ...store, points: kept });
  return ok
    ? { ok: true, detail: `已保留最近 ${kept.length} 个撤销点，放弃 ${points.length - kept.length} 个更早的。` }
    : { ok: false, detail: '写入撤销记录失败。' };
}

/* ────────────────────────── 整理记录 ────────────────────────── */

function isUsableLogEntry(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const e = value as Dict;
  return typeof e.id === 'string' && typeof e.at === 'number' && typeof e.title === 'string';
}

/** 裁剪到上限，并顺手丢掉格式异常的条目 */
async function trimLog(): Promise<FixResult> {
  const data = await chrome.storage.local.get(LOG_KEY).catch(() => ({}) as Dict);
  const list = (data as Dict)[LOG_KEY];
  if (!Array.isArray(list)) return { ok: true, detail: '没有整理记录需要处理。' };

  const usable = list.filter(isUsableLogEntry) as Dict[];
  const kept = usable.slice(0, MAX_LOG_ENTRIES);
  const removed = list.length - kept.length;
  if (removed === 0) return { ok: true, detail: '整理记录数量正常。' };

  const ok = await writeDict(LOG_KEY, kept);
  return ok ? { ok: true, detail: `已清理 ${removed} 条（含格式异常的），保留 ${kept.length} 条。` } : { ok: false, detail: '写入整理记录失败。' };
}

/**
 * 给"撤销点已不在"的记录打上标记。
 *
 * 只写一个 `undoneAt` 会让语义变形（那是"用户撤销过"），所以用专门的字段
 * `unreversibleAt` 表示"这条已经没法撤销了"，面板据此把按钮变灰并说明原因。
 */
async function markOrphanLog(): Promise<FixResult> {
  const data = await chrome.storage.local.get(LOG_KEY).catch(() => ({}) as Dict);
  const list = (data as Dict)[LOG_KEY];
  if (!Array.isArray(list)) return { ok: true, detail: '没有整理记录需要处理。' };

  const undoStore = await readDict(UNDO_KEY);
  const liveRunIds = new Set(
    (Array.isArray(undoStore.points) ? undoStore.points.filter(isUsableUndoPoint) : []).map((p) =>
      String((p as Dict).runId),
    ),
  );

  let marked = 0;
  const next = list.map((raw) => {
    if (!isUsableLogEntry(raw)) return raw;
    const e = raw as Dict;
    const runId = typeof e.runId === 'string' ? e.runId : '';
    if (!runId) return raw;
    if (e.undoneAt || e.unreversibleAt) return raw;
    if (liveRunIds.has(runId)) return raw;
    marked++;
    return { ...e, unreversibleAt: Date.now(), unreversibleReason: '对应的撤销点已被上限挤掉' };
  });

  if (marked === 0) return { ok: true, detail: '所有记录的撤销点都还在。' };
  const ok = await writeDict(LOG_KEY, next);
  return ok ? { ok: true, detail: `已标记 ${marked} 条为「不可撤销」，面板上不会再显示点了没用的按钮。` } : { ok: false, detail: '写入整理记录失败。' };
}

/* ────────────────────────── 运行时 ────────────────────────── */

async function clearCrashMark(): Promise<FixResult> {
  const ok = await writeDict(CRASH_KEY, { count: 0, clearedAt: Date.now() });
  return ok ? { ok: true, detail: '已清除异常退出计数。再次出现时计数会重新开始。' } : { ok: false, detail: '写入失败。' };
}

/** 动作 → 实现（显式映射，缺一个会编译报错） */
const FIXES: Record<FixAction, () => Promise<FixResult>> = {
  'config.fill-defaults': fillConfigDefaults,
  'config.normalize-baseurl': normalizeBaseUrl,
  'config.drop-bad-headers': dropBadHeaders,
  'undo.drop-corrupt': dropCorruptUndo,
  'undo.trim-overflow': trimUndoOverflow,
  'log.mark-orphan': markOrphanLog,
  'log.trim-limit': trimLog,
  'runtime.clear-crash-mark': clearCrashMark,
};

export async function runFix(action: FixAction): Promise<FixResult> {
  const fn = FIXES[action];
  if (!fn) return { ok: false, detail: `未知的修复动作：${action}` };
  try {
    return await fn();
  } catch (e) {
    // 修复自己炸掉也要给出原因，而不是静默失败
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** 依次执行多个修复；一条失败不影响后面的（每条都独立） */
export async function runFixes(actions: FixAction[]): Promise<{ action: FixAction; result: FixResult }[]> {
  const seen = new Set<FixAction>();
  const out: { action: FixAction; result: FixResult }[] = [];
  for (const action of actions) {
    if (seen.has(action)) continue; // 同一个动作只跑一次（幂等 + 省时间）
    seen.add(action);
    out.push({ action, result: await runFix(action) });
  }
  return out;
}
