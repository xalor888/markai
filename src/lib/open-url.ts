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
function failureMessage(url: string, error: unknown): string {
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
