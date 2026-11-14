/**
 * 「收藏当前页面」的落地逻辑（弹窗与工作区共用）。
 *
 * 为什么抽出来：这段逻辑以前内联在 popup 里，**没法被测试**，
 * 于是一个明显的错误活了下来——
 *
 *   `chrome.bookmarks.create({ title, url })` 不传 parentId 时，
 *   Chrome 默认存到「**其他书签**」，而这个按钮的提示写的是「收藏到**书签栏**」。
 *
 * 用户点完去书签栏找，找不到。实测（headless）：
 *   创建后的 parentId = "2"，也就是「其他书签」。
 *
 * 现在这里显式解析书签栏的 id 再传过去，并且整段可以被单测直接调用。
 */

export type SaveResult =
  | { ok: true; id: string; parentId: string }
  | { ok: false; reason: 'unsupported-url' }
  | { ok: false; reason: 'duplicate' }
  | { ok: false; reason: 'error'; message: string };

/** 只接受 http/https：chrome://、扩展页、about: 之类不该进书签 */
/**
 * 这个 URL 能不能收藏成书签。
 *
 * 早先只放行 `http(s)`。但 **Chrome 自己允许收藏 `file://`**——
 * 用本地 HTML 文档 / 离线资料的人会发现「收藏当前页」是灰的，
 * 而浏览器地址栏那颗星却能点。同样能收藏的东西，这里不该拒绝。
 *
 * 仍然拒绝的是浏览器自身页面：`chrome://`、`chrome-extension://`、`about:`、
 * `devtools://`、`view-source:`、`javascript:` —— 这些 Chrome 也不允许收藏成普通书签。
 */
export function isSavableUrl(url: string | undefined): url is string {
  if (!url) return false;
  const u = url.trim();
  if (/^(https?|file):\/\//i.test(u)) return true;
  // file:// 在部分平台写成三斜杠（file:///C:/...），上面已覆盖；
  // 这里兜住大小写与不带斜杠的边缘写法
  return /^https?:/i.test(u) || /^file:/i.test(u);
}

/**
 * 取「书签栏」的 id。
 *
 * 不硬编码 `'1'`：虽然 Chrome 一直用 1 作书签栏，但那是实现细节。
 * 虚拟根的 children 里第一个就是书签栏，按顺序取更稳。
 * 万一取不到（极少见），返回 undefined，让 Chrome 用它自己的默认值，
 * 至少不会把 URL 存丢。
 */
async function resolveBarId(): Promise<string | undefined> {
  try {
    const tree = await chrome.bookmarks.getTree();
    const roots = tree[0]?.children ?? [];
    return roots[0]?.id;
  } catch {
    return undefined;
  }
}

/**
 * 收藏一个标签页到书签栏。
 *
 * 重复检测按 **url 完全相等**判断：`chrome.bookmarks.search(url)` 是子串匹配，
 * 会把 `.../page2` 也算进 `.../page` 的结果里，所以必须再比一次 url。
 */
export async function saveTabToBar(tab: {
  title?: string;
  url?: string;
  /** 指定目标文件夹；缺省时存入书签栏 */
  parentId?: string;
}): Promise<SaveResult> {
  const url = tab.url;
  if (!isSavableUrl(url)) return { ok: false, reason: 'unsupported-url' };

  const parentId = tab.parentId ?? (await resolveBarId());

  try {
    const existing = await chrome.bookmarks.search(url).catch(() => [] as chrome.bookmarks.BookmarkTreeNode[]);
    if (existing.some((n) => n.url === url)) return { ok: false, reason: 'duplicate' };

    const created = await chrome.bookmarks.create({
      ...(parentId ? { parentId } : {}),
      title: tab.title || url,
      url,
    });
    return { ok: true, id: created.id, parentId: created.parentId ?? parentId ?? '' };
  } catch (e) {
    return { ok: false, reason: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 从当前标签页推导"新建书签"对话框的预填值。
 *
 * 抽成纯函数的原因：这是 UI effect，直接测不了；而它的判据（能不能预填）
 * 和「收藏当前页」必须是同一条规则——0.2.74 发现新建书签对话框里还写着一份
 * 独立的 `/^https?:\/\//`，把 `file://` 漏在了外面。
 */
export function prefillFromTab(
  tab: { url?: string; title?: string } | undefined,
): { title: string; url: string } | null {
  const url = tab?.url;
  if (!url || !isSavableUrl(url)) return null;
  return { title: tab?.title?.trim() || url, url };
}
