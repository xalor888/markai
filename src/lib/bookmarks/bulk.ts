/**
 * 批量移动/复制的**如实计数**与统一话术。
 *
 * 为什么需要它：同一件事（把若干项移到某文件夹）在 UI 里有四处实现，报告方式却各不相同——
 * 两处用 `Promise.allSettled` 数出成功/失败并如实报「已移动 X 项」（`bookmark-tree` 的
 * "移动到其他根文件夹"、`move-picker`），另两处用顺序 `await` 循环 + `pushToast('移动失败')`：
 * 第 3 项抛错时前 2 项**已经移过去了**，提示却只说"移动失败"，用户不知道到底动了几项。
 *
 * 这不是"静默失败"（确实报了失败），但它把"部分完成"说成了"整体失败"，与项目
 * 「宁可降级并说清楚」的标准不符；而且同一功能两种口径本身就是缺陷。
 *
 * 这里把计数与话术抽出来，让四处只有一种口径。
 */
import { pushToast, type ToastVariant } from '@/lib/toast';

export interface BulkOutcome {
  /** 成功项数 */
  ok: number;
  /** 失败项数 */
  failed: number;
  /** 首个失败原因（如果有） */
  firstError?: string;
}

/** 供测试与调用方复用的"批量移动"执行器：逐项独立，一项失败不影响其余 */
export async function moveMany(
  ids: string[],
  dest: { parentId: string; index?: number },
  move: (id: string, dest: { parentId: string; index?: number }) => Promise<unknown>,
): Promise<BulkOutcome> {
  const results = await Promise.allSettled(ids.map((id) => move(id, dest)));
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.length - ok;
  const firstRejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  const firstError = firstRejected
    ? firstRejected.reason instanceof Error
      ? firstRejected.reason.message
      : String(firstRejected.reason)
    : undefined;
  return { ok, failed, ...(firstError ? { firstError } : {}) };
}

export interface BulkToast {
  title: string;
  opts?: { description?: string; variant?: ToastVariant };
}

/**
 * 把计数翻成一句话：**不夸大也不缩小**。
 * - 全成功 → success「已移动 N 项」；
 * - 部分成功 → destructive「已移动 X 项，Y 项失败」+ 首个原因；
 * - 全失败 → destructive「移动失败」+ 首个原因；
 * - 一项都没有（空输入）→ default「没有可移动的项」。
 */
export function describeBulk(action: string, o: BulkOutcome, target?: string): BulkToast {
  const where = target ? `至「${target}」` : '';
  if (o.ok === 0 && o.failed === 0) return { title: `没有可${action}的项` };
  if (o.failed === 0) return { title: `已${action} ${o.ok} 项${where}`, opts: { variant: 'success' } };
  if (o.ok === 0) {
    return {
      title: `${action}失败`,
      opts: { variant: 'destructive', ...(o.firstError ? { description: o.firstError } : {}) },
    };
  }
  return {
    title: `已${action} ${o.ok} 项${where}，${o.failed} 项失败`,
    opts: { variant: 'destructive', ...(o.firstError ? { description: o.firstError } : {}) },
  };
}

/** 执行 + 如实提示，供四处调用点直接使用 */
export async function moveManyWithToast(
  ids: string[],
  dest: { parentId: string; index?: number },
  move: (id: string, dest: { parentId: string; index?: number }) => Promise<unknown>,
  targetTitle?: string,
): Promise<BulkOutcome> {
  const outcome = await moveMany(ids, dest, move);
  const { title, opts } = describeBulk('移动', outcome, targetTitle);
  pushToast(title, opts);
  return outcome;
}
