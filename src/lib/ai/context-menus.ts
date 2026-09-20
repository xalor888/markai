/**
 * 原生右键菜单的**注册**（可单测；与负责装配指令的 context-menu.ts 分工不同）。
 *
 * ── 为什么单独成模块 ──
 * 这段代码原先直接写在 background 里、用 `contexts: ['bookmark']` 注册，而
 * **Chrome 的 contextMenus 根本没有 bookmark 上下文**——那是 Firefox `menus` API 的取值。
 * Chrome 只接受这 14 个：
 *   all / page / frame / selection / link / editable / image / video / audio /
 *   launcher / browser_action / page_action / action / tab
 * 后果：菜单项**一个都没注册成功**，用户侧只表现为"右键里没有 MarkAI"，唯一症状是控制台里
 * 一条未捕获的 Promise 拒绝：
 *   Uncaught (in promise) TypeError: Error in invocation of contextMenus.create(...)
 *   Error at property 'contexts': Value must be one of action, all, audio, ...
 * 更隐蔽的是旧写法只查 `chrome.runtime.lastError`：MV3 下不传 callback 时 `create` 返回
 * Promise、校验失败走 **Promise 拒绝**，那句 console.warn 是死代码，一次都没打过。
 *
 * 因此这里做三件事：
 * 1. 注册前按白名单校验 contexts——写错立刻被测试抓住，不必等用户报故障；
 * 2. 同时覆盖「Promise 拒绝」与「lastError」两种运行形态，**逐项独立**记账（一项失败不影响其余）；
 * 3. 返回成功/失败清单，由调用方决定怎么呈现（绝不静默）。
 *
 * ⚠️ **原生书签管理器（chrome://bookmarks）的右键菜单在 Chrome 上无法实现**：
 * chrome:// 页面不接受扩展注入，contextMenus 也没有 bookmark 上下文（Firefox 才有）。
 * 书签维度的「整理此文件夹 / 分析此书签」在 MarkAI 自己的书签树右键里
 * （`src/components/sidebar/bookmark-tree.tsx`）；本模块只负责扩展图标（action）上的入口。
 */

/** Chrome `contextMenus.ContextType` 的完整取值（对照官方 API 文档，2026-09 核对） */
export const CHROME_CONTEXT_TYPES = [
  'all',
  'page',
  'frame',
  'selection',
  'link',
  'editable',
  'image',
  'video',
  'audio',
  'launcher',
  'browser_action',
  'page_action',
  'action',
  'tab',
] as const;

export type ChromeContextType = (typeof CHROME_CONTEXT_TYPES)[number];

/**
 * 只在 Firefox `menus` API 里存在的取值（Chrome 会直接拒绝）。
 * 留在这里是为了让"为什么会写成 bookmark"这件事有出处，也给测试一个明确的靶子。
 */
export const FIREFOX_ONLY_CONTEXTS = ['bookmark'] as const;

export interface MenuItemSpec {
  id: string;
  title: string;
  contexts: readonly ChromeContextType[];
  type?: 'normal' | 'checkbox' | 'radio' | 'separator';
}

/**
 * 扩展图标（action）上的菜单项，顺序即展示顺序：
 * 分隔线把「打开界面」与「让 AI 干活」分开。
 */
export const ACTION_MENUS: readonly MenuItemSpec[] = [
  { id: 'markai:open', title: '打开 MarkAI 管理面板', contexts: ['action'] },
  { id: 'markai:fullpage', title: '在 MarkAI 完整页打开', contexts: ['action'] },
  { id: 'markai:sep', title: '', type: 'separator', contexts: ['action'] },
  { id: 'markai:tidy-all', title: '让 MarkAI 整理全部书签', contexts: ['action'] },
];

export interface ContextMenuRegistrationResult {
  /** 注册成功的菜单 id（顺序同入参 specs） */
  ok: string[];
  /** 失败的菜单 id 与原因——调用方必须呈现出去，不允许只吞进日志 */
  failed: { id: string; message: string }[];
}

export interface ContextMenusApi {
  removeAll: () => Promise<unknown>;
  /**
   * 真实 `chrome.contextMenus.create`：MV3 下不传 callback 时**返回 Promise**
   * （校验失败 = Promise 拒绝）；旧实现同步返回 id，失败写进 `runtime.lastError`。
   * 这里两种都当 unknown 接住，见下方逐项处理。
   */
  create: (props: chrome.contextMenus.CreateProperties) => unknown;
  /** 读 `chrome.runtime.lastError?.message`（调用方注入，便于单测） */
  lastError: () => string | undefined;
}

/** 注册菜单项，逐项如实回报成败（失败项不会让其余项一起失效） */
export async function registerContextMenus(
  api: ContextMenusApi,
  specs: readonly MenuItemSpec[] = ACTION_MENUS,
): Promise<ContextMenuRegistrationResult> {
  const ok: string[] = [];
  const failed: { id: string; message: string }[] = [];

  // 先清空再注册：onInstalled 在 install/update 时触发，残留旧 id 会让 create 报错。
  // 清空失败不阻断注册——真的残留时 create 会以"重复 id"如实报错，比整块不注册更容易定位。
  await api.removeAll().catch(() => {});

  for (const spec of specs) {
    if (spec.contexts.length === 0) {
      // Chrome 的 contexts 是「至少一项」的列表，空数组同样会被拒绝——先拦下来说清楚
      failed.push({ id: spec.id, message: 'contexts 为空：Chrome 至少需要一个上下文（如 action）' });
      continue;
    }
    const unknown = spec.contexts.filter((c) => !(CHROME_CONTEXT_TYPES as readonly string[]).includes(c));
    if (unknown.length > 0) {
      // 本地先拦：这种取值只会让浏览器抛 "Value must be one of ..."，挡在这里能直接指出错在哪一项
      failed.push({
        id: spec.id,
        message: `contexts 含 Chrome 不支持的取值：${unknown.join('、')}（合法取值见 CHROME_CONTEXT_TYPES，其中 bookmark 等只有 Firefox 支持）`,
      });
      continue;
    }
    try {
      // contexts 在 @types/chrome 里是「非空元组」类型，这里按元组形态构造（首项已保证存在）
      const [first, ...rest] = spec.contexts;
      const ret = api.create({
        id: spec.id,
        ...(spec.title ? { title: spec.title } : {}),
        ...(spec.type ? { type: spec.type } : {}),
        contexts: [first!, ...rest],
      });
      // Promise 形态与同步形态都要等/查，两种都覆盖才算没吞错
      await Promise.resolve(ret);
      const err = api.lastError();
      if (err) throw new Error(err);
      ok.push(spec.id);
    } catch (e) {
      failed.push({ id: spec.id, message: e instanceof Error ? e.message : String(e) });
    }
  }

  return { ok, failed };
}
