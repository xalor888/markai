/**
 * 轮次级计划：把一轮里的**写操作**先收成一份计划，等用户确认后再执行。
 *
 * 为什么需要：现在 `dryRun` 只覆盖三个批量工具，其余写操作在 agent 循环里**直接落库**
 * （`agent.ts:314-318`）。这个模块是"整体轮次级预览"的第一片——**纯逻辑**，不碰 chrome、
 * 不碰 UI、不碰 agent 循环，因此可以单独验证。
 *
 * 三条安全语义（都有测试钉住）：
 * 1. **安全默认**：`applyPlan` 不显式传 `confirmed: true` 就一条都不执行——"忘记确认"的
 *    后果必须是"什么也没发生"，而不是"悄悄全做了"；
 * 2. **闸门类不进计划**：`propose_deletions` / `delete_all_bookmarks` 本身已经是"延迟的
 *    删除"（自带 confirm/auto 闸门，见 tools.ts:1709）。把它们塞进计划等于二次延迟，还会
 *    让人误以为"确认计划 = 授权删除"。所以它们不进计划，保持自己的闸门。
 * 3. **失败不静默中断**：逐条捕获、继续执行、如实计数并带上首个原因——沿用
 *    `lib/bookmarks/bulk.ts` 的口径，不另起一套。
 */
import { TOOL_META } from './tools';

export type ToolClass = 'read' | 'write' | 'gate' | 'declare' | 'unknown';

/**
 * 读类工具：立即执行，用来把计划算出来（`agent.ts:22-37` 的同一组）。
 * 注意 `open_bookmark` 在这里算读类——它不写书签库。
 */
const READ_TOOLS = new Set([
  'list_bookmarks',
  'search_bookmarks',
  'get_recent_bookmarks',
  'get_folder_path',
  'list_all_folders',
  'list_empty_folders',
  'get_folder_content',
  'export_bookmarks',
  'check_urls',
  'check_urls_bulk',
  'classify_urls',
  'stats',
  'find_duplicates',
  'open_bookmark',
]);

/**
 * 闸门类工具：**自身即延迟**，不并入轮次计划。
 * 两者都会按 `deleteMode` 要么只产生提议、要么直接执行删除（`tools.ts:1717-1760`、`1787+`）。
 */
const GATE_TOOLS = new Set(['propose_deletions', 'delete_all_bookmarks']);

/**
 * 声明类工具：**只记录意图、不产生任何副作用**。
 * `submit_plan` 让模型把整轮打算做的写操作一次说清，从而把"每回次确认"升级为"整轮一次确认"。
 * 注意：它不是安全边界——真正的闸门仍是逐回次的（未声明的写操作照样要确认）。
 */
const DECLARE_TOOLS = new Set(['submit_plan']);

export function classifyTool(name: string): ToolClass {
  if (READ_TOOLS.has(name)) return 'read';
  if (DECLARE_TOOLS.has(name)) return 'declare';
  if (GATE_TOOLS.has(name)) return 'gate';
  if (TOOL_META[name]) return 'write';
  return 'unknown';
}

export interface PlannedStep {
  /** 工具名 */
  name: string;
  /** 原始参数 JSON（执行时原样传回） */
  args: string;
  /** 人话标签（复用 TOOL_META.label） */
  label: string;
  /** 按参数**推断**的条数；推断不出时为 1 */
  count: number;
  /**
   * 这个条数是**明确声明/可推断**出来的，还是"没得依据、退回 1"。
   * UI 必须据此区分「1 项」与「条数未声明」——否则会把"不知道"显示成"就 1 条"。
   */
  countDeclared: boolean;
  /** 一句话摘要（给人看的） */
  summary: string;
  /** 该步本身只是 dryRun 预览（执行它不会落库） */
  preview: boolean;
  /** 目标文件夹 id（若有）。路径解析留给 UI 层——纯函数不碰 chrome */
  targetId?: string;
}

export interface PlanStepResult {
  name: string;
  ok: boolean;
  error?: string;
}

export interface PlanOutcome {
  /** 成功步数 */
  ok: number;
  /** 失败步数 */
  failed: number;
  /** 首个失败原因 */
  firstError?: string;
  /** 未确认（计划被丢弃，一条都没执行） */
  cancelled: boolean;
  /** 逐步结果，与计划顺序一一对应 */
  results: PlanStepResult[];
}

/** 解析参数 JSON；坏 JSON 不抛（由执行阶段如实报错） */
function parseArgs(args: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(args || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 按参数推断"这一步会影响几条"，并说明这个数**是否有依据**。
 * 显式的 `count`（模型在 submit_plan 里声明的规模）优先，其次是数组字段的长度；
 * 都没有就退回 1 并标 `declared: false`——**不猜大也不猜小，更不假装知道**。
 */
function inferCount(a: Record<string, unknown> | undefined): { count: number; declared: boolean } {
  if (!a) return { count: 1, declared: false };
  const explicit = a.count;
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) {
    return { count: explicit, declared: true };
  }
  for (const key of ['bookmarkIds', 'items', 'ids', 'bookmarkIdList']) {
    const v = a[key];
    if (Array.isArray(v)) return { count: v.length, declared: true };
  }
  return { count: 1, declared: false };
}

/** 只要条数（供"已批准规模"比较用） */
export function inferStepCount(a: Record<string, unknown> | undefined): number {
  return inferCount(a).count;
}

/** 从参数 JSON 直接算条数（调用点少写一次 parse） */
export function stepCountOf(argsJson: string): number {
  return inferStepCount(parseArgs(argsJson));
}

/** 目标文件夹 id（用于 UI 解析路径） */
function inferTarget(a: Record<string, unknown> | undefined): string | undefined {
  if (!a) return undefined;
  for (const key of ['parentId', 'folderId', 'targetId']) {
    const v = a[key];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

/**
 * 把一轮里"打算做的事"收成计划：只保留写类，保持原顺序。
 * 读类不进来（它们已经执行过、用来算这份计划）；闸门类不进来（保持自己的闸门）。
 */
export function buildPlan(steps: { name: string; args: string }[]): PlannedStep[] {
  const out: PlannedStep[] = [];
  for (const s of steps) {
    if (classifyTool(s.name) !== 'write') continue;
    const a = parseArgs(s.args);
    const label = TOOL_META[s.name]?.label ?? s.name;
    const { count, declared } = inferCount(a);
    const preview = a?.dryRun === true;
    const targetId = inferTarget(a);
    const summary = `${label}${declared && count !== 1 ? ` ${count} 项` : ''}${preview ? '（仅预览）' : ''}`;
    out.push({
      name: s.name,
      args: s.args,
      label,
      count,
      countDeclared: declared,
      summary,
      preview,
      ...(targetId ? { targetId } : {}),
    });
  }
  return out;
}

export interface ApplyPlanOptions {
  /**
   * 是否已获得用户确认。**默认 false**——这是刻意的安全默认：
   * 任何忘记传它的调用点都会"什么也不做"，而不是"悄悄全做了"。
   */
  confirmed?: boolean;
}

/**
 * 执行计划：串行、逐条捕获错误、如实计数。
 * 未确认时**不调用 executor**（零写入），返回 `cancelled: true`。
 */
export async function applyPlan(
  steps: PlannedStep[],
  executor: (step: PlannedStep) => Promise<unknown>,
  opts: ApplyPlanOptions = {},
): Promise<PlanOutcome> {
  if (opts.confirmed !== true) {
    return { ok: 0, failed: 0, cancelled: true, results: [] };
  }
  const results: PlanStepResult[] = [];
  let ok = 0;
  let failed = 0;
  let firstError: string | undefined;
  for (const step of steps) {
    try {
      await executor(step);
      ok += 1;
      results.push({ name: step.name, ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failed += 1;
      firstError ??= msg;
      results.push({ name: step.name, ok: false, error: msg });
    }
  }
  return {
    ok,
    failed,
    cancelled: false,
    results,
    ...(firstError !== undefined ? { firstError } : {}),
  };
}
