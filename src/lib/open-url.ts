/**
 * 打开链接的统一入口。
 *
 * 为什么需要它：UI 里原先有近二十处 `void chrome.tabs.create({...}).catch(() => {})`——
 * 打开失败被彻底吞掉。用户在书签树上按了回车、点了"打开全部"，**没有任何反应也不知道为什么**
 * （浏览器拦截、协议不支持、窗口已关闭、标签页数超限都会走这条路）。
 *
 * 批量路径更糟：循环里逐条 fire-and-forget，然后**无条件**弹一句「已打开 N 个标签页」——
 * 把"可能一个都没打开"说成了成功。
 *
 * 这里统一成两件事：
 * 1. 失败必须可见（复用既有 toast 通道）；
 * 2. 提示里**只说来源**（origin），不把完整 URL 打进 UI——书签 URL 可能带 token/查询参数，
 *    把它复制到提示里等于多开一处泄漏面。
 */
import { pushToast } from './toast';

export interface OpenOptions {
  /** 是否切到新标签页（默认 true；"后台打开"传 false） */
  active?: boolean;
  /** 在指定窗口打开 */
  windowId?: number;
}

export interface OpenOutcome {
  opened: number;
  failed: number;
}

/**
 * 提示里用来指代一个 URL 的短标签：**只取来源**，不含路径与查询串。
 * 解析失败（自定义协议等）时退化成协议名，再不行就泛指"该链接"。
 */
export function describeTarget(url: string): string {
  try {
    const u = new URL(url);
    // chrome:// / file:// 之类 origin 是 "null"，此时用协议名更有信息量
    if (u.origin === 'null' || u.origin === '') return u.protocol.replace(':', '') || '该链接';
    return u.origin;
  } catch {
    return '该链接';
  }
}

/** 打开失败时的统一人话说明（不含完整 URL） */
export function failureMessage(url: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${describeTarget(url)}：${detail || '浏览器拒绝了这次打开'}`;
}

function createTab(url: string, opts: OpenOptions): Promise<unknown> {
  const props: chrome.tabs.CreateProperties = { url };
  if (opts.active !== undefined) props.active = opts.active;
  if (opts.windowId !== undefined) props.windowId = opts.windowId;
  return chrome.tabs.create(props);
}

/** 打开单个链接。失败时弹一条 destructive 提示并返回 false。 */
export async function openUrl(url: string, opts: OpenOptions = {}): Promise<boolean> {
  try {
    await createTab(url, opts);
    return true;
  } catch (e) {
    pushToast('无法打开链接', { description: failureMessage(url, e), variant: 'destructive' });
    return false;
  }
}

/**
 * 打开一组链接，并按**实际结果**如实提示。
 *
 * 调用方不要再自己弹"已打开 N 个"——那正是会撒谎的地方。这里：
 * - 全部成功 → success「已打开 N 个标签页」；
 * - 有失败 → destructive「已打开 X 个，Y 个失败」并把首个失败原因带上；
 * - 全部失败 → destructive「打开失败」。
 */
export async function openUrls(
  urls: string[],
  opts: OpenOptions & { label?: string } = {},
): Promise<OpenOutcome> {
  if (urls.length === 0) return { opened: 0, failed: 0 };
  const results = await Promise.all(
    urls.map(async (url) => {
      try {
        await createTab(url, opts);
        return { ok: true as const };
      } catch (e) {
        return { ok: false as const, message: failureMessage(url, e) };
      }
    }),
  );
  const opened = results.filter((r) => r.ok).length;
  const failed = results.length - opened;
  const what = opts.label ?? '标签页';

  if (failed === 0) {
    pushToast(`已打开 ${opened} 个${what}`, { variant: 'success' });
  } else if (opened === 0) {
    const first = results.find((r) => !r.ok);
    pushToast('打开失败', {
      description: first && !first.ok ? first.message : '浏览器拒绝了这次打开',
      variant: 'destructive',
    });
  } else {
    const first = results.find((r) => !r.ok);
    pushToast(`已打开 ${opened} 个，${failed} 个失败`, {
      description: first && !first.ok ? first.message : undefined,
      variant: 'destructive',
    });
  }
  return { opened, failed };
}

/**
 * 批量打开并**分组**，按实际结果如实提示。
 *
 * 为什么单独抽出来：两处调用点（书签树右键「在标签页组中打开」/ 多选多选版）都是
 * `await Promise.all(list.map(...))` 然后统一提示。而 `Promise.all` 在**第一个失败时
 * 立刻 reject**——其余的标签页可能已经建好了：
 *
 *   - 用户看到「打开失败」，实际开了 9 个（而且这 9 个没被分组）；
 *   - 分组那一步被整个跳过，标签页散落在窗口里。
 *
 * 这里改成逐条结算：成功的照样分组，失败的逐条计数，提示说真话。
 */
export interface GroupedOpenOutcome extends OpenOutcome {
  /** 实际进入标签页组的数量 */
  grouped: number;
  /** 分组失败的原因（组不成功不影响标签页已打开的事实） */
  groupError?: string;
}

export async function openUrlsInGroup(
  urls: string[],
  opts: OpenOptions & { label?: string; groupTitle?: string; collapse?: boolean } = {},
): Promise<GroupedOpenOutcome> {
  if (urls.length === 0) return { opened: 0, failed: 0, grouped: 0 };

  const results = await Promise.all(
    urls.map(async (url) => {
      try {
        const tab = await createTab(url, opts);
        const id = (tab as { id?: number } | undefined)?.id;
        return { ok: true as const, id };
      } catch (e) {
        return { ok: false as const, message: failureMessage(url, e) };
      }
    }),
  );

  const okIds = results.filter((r): r is { ok: true; id: number | undefined } => r.ok).map((r) => r.id);
  const tabIds = okIds.filter((id): id is number => typeof id === 'number');
  const opened = results.filter((r) => r.ok).length;
  const failed = results.length - opened;
  const what = opts.label ?? '标签页';

  let grouped = 0;
  let groupError: string | undefined;
  if (tabIds.length > 0) {
    try {
      const groupId = (await chrome.tabs.group({
        tabIds: tabIds as [number, ...number[]],
      })) as unknown as number;
      grouped = tabIds.length;
      if (opts.groupTitle) {
        await chrome.tabGroups.update(groupId, { title: opts.groupTitle }).catch(() => {});
      }
      if (opts.collapse) {
        await chrome.tabGroups.update(groupId, { collapsed: true }).catch(() => {});
      }
    } catch (e) {
      // 组没建成，但标签页确实开了——不能因此报「打开失败」
      groupError = e instanceof Error ? e.message : String(e);
    }
  }

  const firstFail = results.find((r) => !r.ok);
  if (opened === 0) {
    pushToast('打开失败', {
      description: firstFail && !firstFail.ok ? firstFail.message : '浏览器拒绝了这次打开',
      variant: 'destructive',
    });
  } else if (failed === 0) {
    pushToast(
      grouped > 0 ? `已在标签页组中打开 ${grouped} 个${what}` : `已打开 ${opened} 个${what}`,
      grouped > 0 && !groupError ? { variant: 'success' } : { variant: 'default' },
    );
  } else {
    // 部分成功：数字要分行说清，并带上首个失败原因
    pushToast(`已打开 ${opened} 个，${failed} 个失败`, {
      description: firstFail && !firstFail.ok ? firstFail.message : undefined,
      variant: 'destructive',
    });
  }

  return { opened, failed, grouped, ...(groupError ? { groupError } : {}) };
}
