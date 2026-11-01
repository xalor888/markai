/**
 * ── MarkAI background Service Worker ──
 * 职责：
 *  1. 扩展图标（action）右键菜单 → 打开侧边栏/完整页，或注入种子指令（注册逻辑见 lib/ai/context-menus.ts）
 *  2. 一次性消息：AI 连接测试 / 删除执行（转交 deletion-executor，会记入操作日志因此可撤销）/ 侧边栏打开 / 种子消费
 *  3. 聊天长连接 Port：Agent 流式代理（工具调用循环在后台闭环，UI 零 CORS 压力）
 */

import { runAgentTurn } from '@/lib/ai/agent';
import { ChatError, testConnection } from '@/lib/ai/client';
import { ensureRoots } from '@/lib/ai/tools';
import { recoverInterruptedTransaction } from '@/lib/undo/recorder';
import { toolbarClear, toolbarError } from '@/lib/ai/toolbar-hint';
import { createPlanApprovalRegistry, requestPlanApprovalWithAbort } from '@/lib/ai/plan-approval';
import {
  handleContextMenuClick as runContextMenuClick,
  type ContextMenuClickInfo,
} from '@/lib/ai/context-menu';
import { appendDraft, finalizeDraft } from '@/lib/ai/stream-draft';
import { ACTION_MENUS, registerContextMenus } from '@/lib/ai/context-menus';
import { executeDeletions as runDeletions } from '@/lib/ai/deletion-executor';
import {
  AI_COOLDOWN_MS,
  autoOrganizeBookmark,
  nextAiStreakState,
  type OrganizeContext,
} from '@/lib/ai/auto-organize';
import {
  appendOrganizeLog,
  clearOrganizeLog,
  decorateOrganizeDetail,
  type OrganizeLogEntry,
  isRetryableFailure,
  makeOrganizeLogEntry,
  pickRetryableEntries,
  readOrganizeLog,
  summarizeOrganizeLog,
  updateOrganizeLogEntry,
} from '@/lib/ai/organize-log';
import { registrableDomain } from '@/lib/bookmarks/domain';
import { addOptOutDomain, clearOptOutDomains, readOptOutDomains, removeOptOutDomain } from '@/lib/ai/organize-optout';
import { normalizeBaseUrl, resolveConfig } from '@/lib/providers';
import { CONFIG_STORAGE_KEY } from '@/stores/configStore';
import { applyUndo } from '@/lib/undo/apply';
import { readUndoPoints, readUndoState } from '@/lib/undo/recorder';
import type {
  AIConfig,
  ChatInbound,
  ChatOutbound,
  OneShotInbound,
  OneShotOutbound,
  SeedPayload,
} from '@/lib/ai/types';

export default defineBackground(() => {
  // ── 0. 收尾上一轮被中断的事务 ──
  // 只有在**启动**时机才能安全地做这件事：此刻能看到的 pending 快照必然来自已经死掉的
  // 进程（当前进程还没开始任何轮次），因此不会误提升正在进行中的事务——这也是本方案
  // 不需要额外"存活心跳标记"的原因。恢复出来的操作会变成一个正常的撤销点，
  // 并带一条"上一轮被中断"的提示。
  void recoverInterruptedTransaction();

  // ── 1. 扩展图标（action）右键菜单 ──
  // 注：Chrome 的 contextMenus **没有 bookmark 上下文**（那是 Firefox menus API 的取值），
  // 也无法向 chrome://bookmarks 注入——原生书签管理器的右键菜单在 Chrome 上无法实现。
  // 书签维度的「整理此文件夹 / 分析此书签」在 MarkAI 自己的书签树右键里
  // （src/components/sidebar/bookmark-tree.tsx）；这里只注册扩展图标上的入口。
  // 只在安装/更新时注册（onInstalled），避免 SW 重启后重复 id 报错；成败逐项如实上报。
  chrome.runtime.onInstalled.addListener(async (details) => {
    /* 首次安装**不**自动打开设置页。
     *
     * 曾实现过 `openOptionsPage()`：以为「装完直接落到配置页」能降低流失。实测发现代价更大——
     * Chrome 扩展的多个页面（options / sidepanel / page / popup）共享**同一个渲染进程**，
     * 设置页那套 900 行表单的初始化会和工作区抢主线程，
     * 真实现象是：安装后同时开着侧边栏时，时间线在 1200 条书签下从 19ms 变成 20 秒不响应。
     * （e2e 里稳定复现；关掉这一行立刻恢复 19ms。）
     *
     * 「不知道去哪配置」这件事已经由三个可见入口覆盖：popup 的「AI 服务尚未配置 → 去配置」、
     * 聊天欢迎卡片的提示、设置页顶部的「三步开始用」。宁可少开一个页面，不要让它卡。
     */
    const { ok, failed } = await registerContextMenus(
      {
        removeAll: () => chrome.contextMenus.removeAll(),
        create: (props) => chrome.contextMenus.create(props),
        lastError: () => (chrome.runtime.lastError as { message?: string } | undefined)?.message,
      },
      ACTION_MENUS,
    );
    if (failed.length === 0) return;
    console.warn(
      `[MarkAI] 右键菜单注册失败 ${failed.length}/${ok.length + failed.length} 项：` +
        failed.map((f) => `${f.id}（${f.message}）`).join('；'),
    );
    // 全部失败 = 扩展图标右键入口整体消失（本项目真实发生过：'bookmark' 上下文让 5 项全废，
    // 而症状只在控制台里）。"功能看起来本该有、其实没有"这类失败必须让人看得见。
    if (ok.length === 0) {
      await toolbarError('MarkAI：扩展右键菜单未能注册，请重新加载扩展或查看后台控制台');
    }
  });
  chrome.contextMenus.onClicked.addListener(handleContextMenuClick);

  // 全局快捷键：Ctrl+Shift+M 打开侧边栏
  chrome.commands.onCommand.addListener(async (command) => {
    if (command !== 'open-markai') return;
    const win = await chrome.windows.getCurrent();
    if (win.id !== undefined) {
      try {
        await chrome.sidePanel.open({ windowId: win.id });
      } catch {
        // 按了快捷键却什么都没发生是"失败被吞掉"的典型：用一个不依赖 storage 的
        // 工具栏提示告诉用户"没打开，请手动点扩展图标"。
        await toolbarError('MarkAI：侧边栏未能自动打开，请点扩展图标手动打开');
      }
    }
  });

  // ── 1.5 新书签自动整理 ──
  // 用户/浏览器收藏一个页面后，自动识别并归类（无需手动点「整理」）。
  // 关键约束：
  //  - Agent 轮次进行中不插手（模型自己会整理，两个流程同时动手会互相搬来搬去）；
  //  - 1.2s 去抖：Chrome 收藏是「先建再改标题」两步，太早读到的是 URL 兜底标题；
  //  - 批量导入/同步风暴（8 秒内 >5 条）跳过并冷却 60s，避免几百次模型调用与文件夹爆炸。
  chrome.bookmarks.onCreated.addListener((id, node) => {
    if (!node.url) return; // 文件夹不处理
    scheduleAutoOrganize(id);
  });

  // ── 2. 一次性消息 ──
  chrome.runtime.onMessage.addListener((msg: OneShotInbound, _sender, sendResponse) => {
    void handleOneShot(msg)
      .then(sendResponse)
      .catch((e) => {
        // 兜底：handler 抛错也必须响应，否则 UI 侧 sendMessage 永久挂起
        // （如 confirmDeletions 卡死在"执行中"且无法重试）。
        const errMsg = e instanceof Error ? e.message : String(e);
        try {
          // 按消息类型回发匹配的响应形状：此前非删除类消息抛错也会回 deletions:result，
          // 会被调用方误解为删除结果（类型错乱）。
          if (msg.type === 'deletions:execute') {
            // failed 必须带真实 proposalId：空串会让 UI 把所有项标记为 executed（假成功且无法重试）
            const failed = msg.items.map((i) => ({ proposalId: i.proposalId, error: errMsg }));
            sendResponse({ type: 'deletions:result', count: 0, failed } satisfies OneShotOutbound);
            return;
          }
          if (msg.type === 'ai:test') {
            sendResponse({ type: 'ai:test:result', ok: false, message: errMsg } satisfies OneShotOutbound);
            return;
          }
          if (msg.type === 'ai:models') {
            sendResponse({ type: 'ai:models:result', ok: false, models: [], message: errMsg } satisfies OneShotOutbound);
            return;
          }
          if (msg.type === 'undo:list') {
            // 读不到就当作没有撤销点，UI 显示按钮为不可用即可
            sendResponse({ type: 'undo:list:result', points: [], notice: '读取撤销记录失败' } satisfies OneShotOutbound);
            return;
          }
          if (msg.type === 'undo:apply') {
            // 撤销抛错必须如实上报，不能假装成功
            sendResponse({
              type: 'undo:apply:result',
              result: { ok: false, reason: errMsg, restored: 0, failures: [] },
            } satisfies OneShotOutbound);
            return;
          }
          // 其余类型（sidepanel:open / seed:consume / task:status）极少抛错；回一个无害的
          // seed:value 空值（消费方当作"无种子/未处理"），避免把删除结果错发给无关调用方。
          sendResponse({ type: 'seed:value', text: undefined, folderId: undefined } satisfies OneShotOutbound);
        } catch {
          // 响应通道已断开，忽略
        }
      });
    return true; // 异步响应
  });

  // ── 3. 聊天长连接 Port：Agent 流式代理 ──
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'markai-chat') return;
    let abort: AbortController | null = null;
    /** 断开后的宽限计时器：新一轮开始时要清掉，否则上一轮的倒计时会把新请求杀掉 */
    const abortTimers: ReturnType<typeof setTimeout>[] = [];
    // 每个连接一份登记表：决定只结算本连接上挂起的计划
    const planApprovals = createPlanApprovalRegistry();

    port.onMessage.addListener((raw: ChatInbound) => {
      if (raw.type === 'chat:send') {
        // 同一 Port 连续发送时，取消上一次未完成的流式
        abort?.abort();
        // 上一条若停在计划确认上：abort 不会让它的 await 返回，这里补一次结算（纵深防御）
        planApprovals.cancelAll();
        // 新的一轮：清掉上一轮遗留的"宽限中止"计时器，否则它到点会把这一轮杀掉
        for (const t of abortTimers.splice(0)) clearTimeout(t);
        const ctrl = new AbortController();
        abort = ctrl;
        void handleChatSend(port, raw, ctrl.signal, planApprovals).finally(() => {
          // 仅当仍是当前请求时才清空，避免旧请求的 finally 覆盖新请求的 abort
          if (abort === ctrl) abort = null;
        });
      } else if (raw.type === 'chat:cancel') {
        abort?.abort();
        // 轮次被中止：把还挂着的计划按"未批准"结算，避免 await 永远不返回
        planApprovals.cancelAll();
      } else if (raw.type === 'chat:plan_decision') {
        // 只结算对应 messageId 的那一轮；迟到的决定不会批准别的计划
        planApprovals.resolve(raw.messageId, raw.approved);
      }
    });

    port.onDisconnect.addListener(() => {
      /*
       * **不立刻中止**。
       *
       * 切标签页、切窗口、侧边栏被收起，都会让 port 断开——但用户并没有说"别生成了"。
       * 早先这里直接 abort()，于是"只是把标签页放后台"就等于把回复砍掉，
       * 这就是用户报的「切个标签页就没」。
       *
       * 现在给 30 秒宽限期：期间一轮跑完，内容会经 finalizeDraft 落进会话消息，
       * 用户切回来能直接看到完整回复；确实没人回来，才中止以免白烧 token。
       */
      if (abort) {
        const pending = setTimeout(() => {
          abort?.abort();
          abort = null;
        }, 30_000);
        // 新一轮开始时清掉（见下面的 abort = new AbortController() 处）
        abortTimers.push(pending);
      }
      // 面板关了没人能点确认：未决计划按"未批准"结算（绝不挂死一轮）
      planApprovals.cancelAll();
    });
  });

  void ensureRoots().catch(() => {});
});

/** ── contextMenus 点击处理：编排逻辑在 src/lib/ai/context-menu.ts（可单测） ── */
async function handleContextMenuClick(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<void> {
  await runContextMenuClick(toClickInfo(info, tab), {
    getNode: async (id) => (await chrome.bookmarks.get(id).catch(() => []))[0],
    setSeed: async (seed) => {
      await chrome.storage.local.set({ 'markai.seed': seed });
    },
    clearSeed: async () => {
      await chrome.storage.local.remove('markai.seed');
    },
    openSidePanel: async (windowId) => {
      // 拿不到窗口 id 就没法打开：抛出去让编排层按 best-effort 处理（seed 已保存）
      if (windowId === undefined) throw new Error('没有可用的窗口 id');
      await chrome.sidePanel.open({ windowId });
    },
    broadcastSeed: async () => {
      await chrome.runtime.sendMessage({ type: 'markai:seed' });
    },
    getWindowId: async () => (await chrome.windows.getCurrent()).id,
    openTab: async (url) => {
      await chrome.tabs.create({ url });
    },
    pageUrl: () => chrome.runtime.getURL('page.html'),
    // storage 写不进去时的唯一可见通路：工具栏标记 + 悬停说明（与快捷键失败共用同一模块）
    setErrorHint: toolbarError,
    clearErrorHint: toolbarClear,
  });
}

/** 把 contextMenus 的点击数据收敛成本模块需要的最小形状（bookmarkId 尚未进 @types） */
function toClickInfo(
  info: chrome.contextMenus.OnClickData,
  tab?: chrome.tabs.Tab,
): ContextMenuClickInfo {
  const bookmarkId = (info as unknown as { bookmarkId?: string }).bookmarkId;
  return {
    menuItemId: String(info.menuItemId),
    ...(bookmarkId ? { bookmarkId } : {}),
    ...(tab?.windowId !== undefined ? { windowId: tab.windowId } : {}),
  };
}

/** ── 一次性消息分发 ── */
/** 最近消费的种子内容（SW 生命周期内防多窗口重复消费同一种子） */
let lastConsumedSeed = '';

/**
 * 重试一条失败记录（单条与批量共用）。
 *
 * 以**网址**为准而不是书签 id：用户可能在两次整理之间重建过这条书签，id 会变，网址还是同一个页面。
 * 且显式 `ignoreOptOut`——用户点了「重试」就是明确要求，免打扰名单只该挡后台的自动行为。
 */
async function retryOrganizeEntry(entry: OrganizeLogEntry): Promise<{ ok: boolean; detail: string }> {
  if (!entry.url) return { ok: false, detail: '这条记录没有可重试的网址' };
  const found = await chrome.bookmarks.search(entry.url).catch(() => [] as chrome.bookmarks.BookmarkTreeNode[]);
  const node = found.find((n) => n.url === entry.url);
  if (!node) return { ok: false, detail: '这条书签已不在收藏夹里，无需重试' };
  const res = await autoOrganizeBookmark(node.id, { ignoreOptOut: true });
  const succeeded = res.ok && res.action !== 'skipped';
  // 就地更新这一条，**不追加新记录**：
  // 追加会让同一个书签在列表里同时存在一条红（旧的失败）和一条绿（新的成功），
  // 用户会以为「重试没生效」，而那条红的还会一直挂着可重试按钮。
  await updateOrganizeLogEntry(entry.id, {
    action: res.action,
    detail: succeeded ? `重试成功：${res.detail}` : res.detail,
    ...(res.target ? { target: res.target } : {}),
    ...(res.runId ? { runId: res.runId } : {}),
    ...(succeeded
      ? { needsAttention: false, retryable: false }
      : { needsAttention: true, retryable: isRetryableFailure(res.detail) }),
  });
  return { ok: succeeded, detail: res.detail };
}

async function handleOneShot(msg: OneShotInbound): Promise<OneShotOutbound> {
  switch (msg.type) {
    case 'ai:test': {
      const result = await testConnection(msg.config);
      return { type: 'ai:test:result', ok: result.ok, message: result.message, model: result.model };
    }

    case 'ai:models': {
      // 从上游拉取模型列表：OpenAI 兼容 {data:[{id,context_window?}]} 或 Ollama {models:[{name}]}
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      try {
        const url = `${normalizeBaseUrl(msg.config.baseUrl)}/models`;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (msg.config.apiKey) headers.Authorization = `Bearer ${msg.config.apiKey}`;
        let res: Response;
        try {
          res = await fetch(url, { headers, signal: ctrl.signal });
        } catch (e) {
          // 网络层错误与超时分开报告，避免误导为「API Key 错误」
          if (e instanceof DOMException && e.name === 'AbortError') {
            return { type: 'ai:models:result', ok: false, models: [], message: '请求超时（15 秒），请检查 Base URL 是否可达。' };
          }
          return { type: 'ai:models:result', ok: false, models: [], message: '无法连接服务商，请检查 Base URL 与网络。' };
        } finally {
          clearTimeout(timer);
        }
        if (!res.ok) {
          return { type: 'ai:models:result', ok: false, models: [], message: `服务商返回 ${res.status}，无法获取模型列表。` };
        }
        let json: unknown;
        try {
          json = await res.json();
        } catch {
          return { type: 'ai:models:result', ok: false, models: [], message: '响应不是有效 JSON，端点可能不兼容 OpenAI 协议。' };
        }
        const d = json as { data?: { id: string; context_window?: number }[]; models?: { name: string }[] };
        if (!d || typeof d !== 'object' || (!Array.isArray(d.data) && !Array.isArray(d.models))) {
          return { type: 'ai:models:result', ok: false, models: [], message: '响应格式不兼容（缺少 data/models 字段）。' };
        }
        // OpenAI 风格：data 数组，可能带 context_window（模型上下文长度，可直接采用）
        const models = (Array.isArray(d.data) ? d.data.map((m) => m.id) : []).concat(
          Array.isArray(d.models) ? d.models.map((m) => m.name) : [],
        );
        if (models.length === 0) {
          return { type: 'ai:models:result', ok: false, models: [], message: '服务商未返回可用模型。' };
        }
        // 若服务商返回了当前模型的上下文长度，附带给 UI（自动填入设置）
        const current = (Array.isArray(d.data) ? d.data : []).find((m) => m.id === msg.config.model);
        const contextWindow = typeof current?.context_window === 'number' ? current.context_window : undefined;
        return {
          type: 'ai:models:result',
          ok: true,
          models,
          message: `获取到 ${models.length} 个模型${contextWindow ? `，${msg.config.model} 上下文 ${contextWindow}` : ''}`,
          contextWindow,
        };
      } catch {
        return { type: 'ai:models:result', ok: false, models: [], message: '获取模型列表失败，请稍后重试。' };
      }
    }

    case 'deletions:execute':
      return executeDeletions(msg.items);

    case 'sidepanel:open': {
      try {
        await chrome.sidePanel.open({ windowId: msg.windowId });
        return { type: 'sidepanel:opened', ok: true };
      } catch {
        return { type: 'sidepanel:opened', ok: false };
      }
    }

    case 'seed:consume': {
      // 原子消费：SW 单线程内读-比-删之间无 await 交错；
      // 多窗口并发请求时用「内容 + 时间戳」判重保证只有第一个窗口拿到种子。
      // 判重仅对非空 text 生效：notice 提示种子（text 为空）不判重，永远送达
      const data = await chrome.storage.local.get('markai.seed');
      const seed = data['markai.seed'] as SeedPayload | undefined;
      if (!seed) return { type: 'seed:value', text: undefined, folderId: undefined };
      const sig = `${seed.text}|${seed.createdAt}`;
      if (seed.text && sig === lastConsumedSeed) {
        await chrome.storage.local.remove('markai.seed').catch(() => {});
        return { type: 'seed:value', text: undefined, folderId: undefined };
      }
      lastConsumedSeed = sig;
      await chrome.storage.local.remove('markai.seed').catch(() => {});
      return { type: 'seed:value', text: seed.text || undefined, folderId: seed.folderId, notice: seed.notice };
    }

    case 'undo:list': {
      // 连同 notice 一起回传：撤销点被裁剪/写失败时必须让 UI 能说出实话
      const state = await readUndoState();
      return {
        type: 'undo:list:result',
        points: state.points,
        ...(state.notice ? { notice: state.notice } : {}),
        ...(state.noticeAt ? { noticeAt: state.noticeAt } : {}),
      };
    }

    case 'undo:apply': {
      // 撤销本身不记入操作日志（apply.ts 走裸 API），失败与拒绝都如实回传
      const result = await applyUndo(msg.id);
      return { type: 'undo:apply:result', result };
    }

    case 'organize:list': {
      const entries = await readOrganizeLog();
      return { type: 'organize:list:result', entries, stats: summarizeOrganizeLog(entries) };
    }

    case 'organize:clear': {
      await clearOrganizeLog();
      return { type: 'organize:clear:result', ok: true };
    }

    case 'organize:retry': {
      const entries = await readOrganizeLog();
      const entry = entries.find((e) => e.id === msg.id);
      if (!entry) return { type: 'organize:retry:result', ok: false, detail: '这条记录已不存在' };
      const r = await retryOrganizeEntry(entry);
      return { type: 'organize:retry:result', ok: r.ok, detail: r.detail };
    }

    case 'organize:retry:all': {
      // 一次网络抖动可能留下十几条失败：逐条点重试是体力活。
      // 串行执行——每条都要开自己的撤销事务，并发会互相打断。
      const entries = await readOrganizeLog();
      const targets = pickRetryableEntries(entries);
      if (targets.length === 0) {
        return { type: 'organize:retry:all:result', attempted: 0, succeeded: 0, failed: 0, detail: '没有可重试的失败记录' };
      }
      let succeeded = 0;
      let failed = 0;
      for (const entry of targets) {
        const r = await retryOrganizeEntry(entry);
        if (r.ok) succeeded++;
        else failed++;
      }
      return {
        type: 'organize:retry:all:result',
        attempted: targets.length,
        succeeded,
        failed,
        detail: `重试 ${targets.length} 条：成功 ${succeeded}${failed > 0 ? `，仍失败 ${failed}` : ''}`,
      };
    }


    case 'organize:optout:list': {
      const list = await readOptOutDomains();
      return { type: 'organize:optout:list:result', domains: list };
    }

    case 'organize:optout:clear': {
      await clearOptOutDomains();
      return { type: 'organize:optout:clear:result', ok: true };
    }

    case 'organize:optout:remove': {
      await removeOptOutDomain(msg.domain);
      return { type: 'organize:optout:remove:result', ok: true };
    }

    case 'organize:undo': {
      // 用户对某次自动整理不满意 → 一步撤回，不必去撤销历史里翻英文 runId。
      const entries = await readOrganizeLog();
      const entry = entries.find((e) => e.id === msg.id);
      if (!entry) return { type: 'organize:undo:result', ok: false, detail: '这条记录已不存在' };
      if (entry.undoneAt) return { type: 'organize:undo:result', ok: false, detail: '这次整理已经撤销过了' };
      if (!entry.runId) return { type: 'organize:undo:result', ok: false, detail: '这条记录没有可撤销的改动' };
      const points = await readUndoPoints();
      const point = points.find((p) => p.runId === entry.runId);
      if (!point) {
        return {
          type: 'organize:undo:result',
          ok: false,
          detail: '对应的撤销点已不在保留范围内（最多保留最近 10 步），可在「撤销历史」里查看',
        };
      }
      const result = await applyUndo(point.id);
      if (result.ok) {
        // 标记原记录：否则用户会对着同一条反复点，每次只得到「已不存在」
        await updateOrganizeLogEntry(entry.id, { undoneAt: Date.now() });
        // 撤销 = 用户否定了这个站点的归类方式 → 该站点不再自动整理（可在面板里恢复）
        if (entry.domain) await addOptOutDomain(entry.domain);
      }
      return {
        type: 'organize:undo:result',
        ok: result.ok,
        detail: result.ok
          ? `已撤销「${entry.title}」的整理，书签回到原处`
          : result.reason || '撤销没有完成',
      };
    }

    case 'task:status': {
      // popup 主动查询：SW 活着才有准确状态；SW 已回收则任务必然中断（sendMessage 会失败，popup 按未处理中处理）
      return { type: 'task:status:result', running: agentTaskRunning };
    }
  }
}

/**
 * 「AI 分类连续失败」的计数与冷却窗口（SW 内存态，重启即重置）。
 * 用户配错 Key 时，不该让每一次收藏都白等 12 秒——见 nextAiStreakState 的注释。
 */
let aiStreak: { streak: number; cooldownUntil: number; justCooled: boolean } = {
  streak: 0,
  cooldownUntil: 0,
  justCooled: false,
};

/** 首次自动整理是否已提示过（跨 SW 重启有效：存在 storage 里） */
const ORGANIZE_HINTED_KEY = 'markai.organize.hinted';

/**
 * 给成功的那条结果补上「首次引导」与「重复收藏」提示。
 * 只有成功时才调用——第一次就失败的话，不该把引导名额用掉。
 */
async function decorateSuccessDetail(detail: string, url: string): Promise<string> {
  let firstTime = false;
  try {
    const data = await chrome.storage.local.get(ORGANIZE_HINTED_KEY);
    if (!data[ORGANIZE_HINTED_KEY]) {
      firstTime = true;
      await chrome.storage.local.set({ [ORGANIZE_HINTED_KEY]: true });
    }
  } catch {
    // 读不到标记时就不提引导，宁可不提示也不要重复提示
  }
  let duplicateCount = 1;
  if (url) {
    try {
      const found = await chrome.bookmarks.search(url);
      // search 是子串匹配，必须精确比对 URL 再计数
      duplicateCount = found.filter((n) => n.url === url).length;
    } catch {
      duplicateCount = 1;
    }
  }
  return decorateOrganizeDetail(detail, { firstTime, duplicateCount });
}

/** ── 新书签自动整理的调度状态（SW 内存态，重启即重置） ── */
const autoPending = new Set<string>();
let autoTimer: ReturnType<typeof setTimeout> | null = null;
let autoCooldownUntil = 0;
let autoBurstNotified = false;
const autoRecentCreates: number[] = [];
/** 批量风暴窗口与阈值：正常收藏（几秒内连点几次）不该被误判；导入/同步通常是几十上百条 */
const AUTO_BURST_WINDOW_MS = 10_000;
const AUTO_BURST_THRESHOLD = 15;


/** 调度一次自动整理（去抖 + 批量导入保护） */
function scheduleAutoOrganize(id: string): void {
  const now = Date.now();
  while (autoRecentCreates.length > 0 && now - autoRecentCreates[0]! > AUTO_BURST_WINDOW_MS) {
    autoRecentCreates.shift();
  }
  autoRecentCreates.push(now);
  if (autoRecentCreates.length > AUTO_BURST_THRESHOLD) {
    // 批量导入 / 跨设备同步：逐条分类只会制造噪音与成本
    autoCooldownUntil = now + 60_000;
    autoPending.clear();
    if (!autoBurstNotified) {
      autoBurstNotified = true;
      notifyAutoOrganized(false, '检测到批量新增书签（可能是导入或同步），本轮跳过自动整理。', true);
      // 风暴也要留痕：用户事后能在「整理记录」里看到跳过原因，并从这里补整理
      void appendOrganizeLog(
        makeOrganizeLogEntry({
          title: `批量新增 ${autoRecentCreates.length} 条`,
          url: '',
          domain: '',
          action: 'skipped',
          detail: '检测到批量新增书签（可能是导入或同步），本轮跳过自动整理；可在「整理记录」里补整理。',
          needsAttention: true,
        }),
      );
      setTimeout(() => {
        autoBurstNotified = false;
      }, 60_000);
    }
    return;
  }
  if (now < autoCooldownUntil) return;
  if (agentTaskRunning) return; // Agent 正在整理，别抢方向盘
  autoPending.add(id);
  /*
   * 短窗口去抖：单条收藏 150ms 后就开始整理（原来固定等 1.2 秒，收藏完干等像「没反应」）；
   * 150ms 内继续来的收藏会把这个窗口往后推并合并成一次 flush，
   * 所以批量导入仍会自然累积、进而触发上面的风暴保护，不会变成逐条跑。
   * 试过「第一条直接同步触发」——太激进：造数据/导入的第一条会被单独提前整理，打乱批量语义。
   */
  const isFirstInBatch = autoPending.size === 1 && !autoTimer;
  if (autoTimer) clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    autoTimer = null;
    void flushAutoOrganize();
  }, isFirstInBatch ? 150 : 1_200);
}

/**
 * 让被让路的自动整理重新排队。
 *
 * `flushAutoOrganize` 在补整理或 Agent 任务期间会把 id 原样放回 `autoPending` 并直接返回
 * （刻意不重排定时器，避免几百条轮询起一堆 timer）。那么「什么时候再试」就必须由
 * **结束方**负责——否则那几条书签会永远躺在集合里，而没有任何地方记录过这次没整理。
 *
 * `clearTimeout` 保证同一时刻只有一个等待中的定时器：多条结束路径先后触发不会叠加。
 */
function wakeAutoOrganize(delayMs = 150): void {
  if (autoPending.size === 0 || agentTaskRunning) return;
  if (autoTimer) clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    autoTimer = null;
    void flushAutoOrganize();
  }, delayMs);
}

/** 串行执行队列：一次只整理一条，避免并发分类把同一条书签搬两次 */
async function flushAutoOrganize(): Promise<void> {
  const ids = [...autoPending];
  autoPending.clear();
  if (ids.length === 0) return;
  /*
   * Agent 任务正在跑：**让路**，但要把 id 放回集合。
   * 原先这里直接 `return`，那几条待整理的书签就被静默丢掉了——
   * 用户下次收藏同一站点前，它们会一直躺在根目录，而没有任何地方记录过"这次没整理"。
   * 唤醒由 `clearBadge`（任务结束/取消/失败三条路径都经过它）负责。
   */
  if (agentTaskRunning) {
    for (const id of ids) autoPending.add(id);
    return;
  }
  for (const id of ids) {
    // 先取元信息：日志要回答「哪一条、哪个站点、去了哪里」。
    // 移动后 id 仍可查询，但标题/URL 属于书签本身，前后都一致。
    const nodes = await chrome.bookmarks.get(id).catch(() => [] as chrome.bookmarks.BookmarkTreeNode[]);
    const node = nodes[0];
    // 冷却期内不再问模型：归类照常做（本地规则 + 域名兜底），只是省掉那次注定超时的等待
    const inCooldown = Date.now() < aiStreak.cooldownUntil;
    const res = await autoOrganizeBookmark(id, inCooldown ? { skipAi: true } : {});
    aiStreak = nextAiStreakState({ state: aiStreak, failed: res.aiFailed === true, now: Date.now() });
    if (aiStreak.justCooled) {
      notifyAutoOrganized(true, `AI 分类连续失败，已暂停 ${Math.round(AI_COOLDOWN_MS / 60_000)} 分钟（期间按本地规则归类）。可在设置页检查服务商配置。`, false, 'ai-cooldown');
    }
    // 静默场景：未开启 / 已在正确位置 / 用户给这个站点设了免打扰。
    // 免打扰是用户自己关的，每次收藏都弹一条「自动整理未完成」的红警告纯属噪音——
    // 但**要留痕**（用户回头可能想问「为什么这条没整理」），所以写日志、不弹 toast。
    const optedOut = res.action === 'skipped' && res.detail.includes('撤销过');
    const silentSkip =
      res.action === 'skipped' &&
      (res.detail === '未开启自动整理' || res.detail.includes('已在') || optedOut);
    if (silentSkip) {
      if (optedOut && node) {
        void appendOrganizeLog(
          makeOrganizeLogEntry({
            title: node.title || node.url || '(无标题)',
            url: node.url ?? '',
            domain: node.url ? (registrableDomain(node.url) ?? '') : '',
            action: 'skipped',
            detail: res.detail,
          }),
        );
        // 静默是为了不吵；但第一次遇到「怎么没整理」时，用户需要一个解释。
        // 只提示一次（全局），之后靠整理记录里的留痕。
        try {
          const key = 'markai.organize.optoutHinted';
          const data = await chrome.storage.local.get(key);
          if (!data[key]) {
            await chrome.storage.local.set({ [key]: true });
            notifyAutoOrganized(true, res.detail, false, 'optout');
          }
        } catch {
          // 读不到标记就不提示，宁可不提示也不要次次提示
        }
      }
      continue;
    }
    /** toast 用的文案（可能被补上引导/重复提示；失败时保持原样） */
    let notifyDetail = res.detail;
    // 「真的把它归位了」才算成功：skipped（非网页 / 书签已不存在 / 无法识别域名）
    // 既不是成功也不是失败，不该占用「首次引导」名额，也不该弹报警
    const succeeded = res.ok && res.action !== 'skipped';
    if (node) {
      const failed = res.action === 'failed';
      // 成功的那条补「首次引导 / 重复收藏」提示（失败与跳过都不占用首次提示名额）
      const detail = succeeded ? await decorateSuccessDetail(res.detail, node.url ?? '') : res.detail;
      notifyDetail = detail;
      void appendOrganizeLog(
        makeOrganizeLogEntry({
          title: node.title || node.url || '(无标题)',
          url: node.url ?? '',
          domain: node.url ? (registrableDomain(node.url) ?? '') : '',
          action: res.action,
          detail,
          ...(res.via ? { via: res.via } : {}),
          ...(res.target ? { target: res.target } : {}),
          // 记下撤销点：用户不满意时能在同一条记录上「一步撤回」
          ...(res.runId ? { runId: res.runId } : {}),
          // 失败必须能回看：toast 会消失，日志不会
          ...(failed ? { needsAttention: true, retryable: isRetryableFailure(res.detail) } : {}),
        }),
      );
    }
    // 跳过不弹 toast：收藏一个 chrome:// 或 mailto: 书签时弹红色「自动整理未完成」，
    // 是在为一个用户没要求的动作报警。该留的痕已经写进日志了。
    if (succeeded || res.action === 'failed') {
      notifyAutoOrganized(succeeded, notifyDetail, false);
    }
  }
}

/** ── 补整理：把散落在根目录的已有书签也走一遍同一套决策 ── */

/** 通知已打开的界面弹 toast；没有界面在听时静默（自动动作不需要打扰） */
function notifyAutoOrganized(ok: boolean, detail: string, burst: boolean, kind?: 'optout' | 'ai-cooldown'): void {
  chrome.runtime
    .sendMessage({ type: 'markai:auto-organized', ok, detail, burst, ...(kind ? { kind } : {}) })
    .catch(() => {
      // 没有接收方（侧边栏/完整页都没开）：自动整理照常完成，不需要报错
    });
}

/** ── 删除执行：实现在 src/lib/ai/deletion-executor.ts（可单测，且会记入操作日志） ── */
async function executeDeletions(
  items: { proposalId: string; bookmarkId: string; all?: boolean }[],
): Promise<OneShotOutbound> {
  const { count, failed } = await runDeletions(items);
  return { type: 'deletions:result', count, failed };
}

/** 任务徽标令牌：并发/连续任务时只有最新任务的清理才能动 badge（旧任务的清理直接忽略） */
let badgeToken = 0;
/** 当前是否有 Agent 任务在跑（popup 通过 task:status 查询；SW 回收即消失） */
let agentTaskRunning = false;

/** ── 聊天 Port：Agent 流式代理 ── */
async function handleChatSend(
  port: chrome.runtime.Port,
  msg: Extract<ChatInbound, { type: 'chat:send' }>,
  signal: AbortSignal,
  planApprovals: ReturnType<typeof createPlanApprovalRegistry>,
): Promise<void> {
  safePost(port, { type: 'chat:start', messageId: msg.messageId });
  // 处理中醒目提醒：工具栏图标显示「…」徽标，结束时清除（错误红色 '!'）。
  // 每次任务独占令牌：旧任务结束后不得清掉新任务的徽标（多窗口/快速连发场景）
  const token = ++badgeToken;
  agentTaskRunning = true;
  void setTaskBadge('…', '#4f46e5').catch(() => {});
  const clearBadge = (error = false) => {
    if (token !== badgeToken) return;
    agentTaskRunning = false;
    void (error ? setTaskBadge('!', '#dc2626') : chrome.action.setBadgeText({ text: '' })).catch(() => {});
    // Agent 任务期间被让路的自动整理在这里补一次唤醒。
    // 正常结束 / 取消 / 失败三条路径都会经过 clearBadge，所以这里放一次就够。
    wakeAutoOrganize();
  };

  // 读取配置（与 options 页共用 key，未填项回落到预设默认值）
  let config: AIConfig;
  try {
    const data = await chrome.storage.local.get(CONFIG_STORAGE_KEY);
    config = resolveConfig(data[CONFIG_STORAGE_KEY] as Partial<AIConfig> | undefined);
  } catch {
    safePost(port, {
      type: 'chat:error',
      messageId: msg.messageId,
      message: '读取配置失败，请打开设置页重新保存。',
    });
    clearBadge(true);
    return;
  }

  if (!config.baseUrl || !config.model) {
    safePost(port, {
      type: 'chat:error',
      messageId: msg.messageId,
      message: '尚未配置 AI 服务，请先在设置页填写 Base URL 与模型。',
    });
    clearBadge(true);
    return;
  }

  // 解析当前上下文文件夹标题，让 Agent 更聪明地处理"整理"类指令
  let text = msg.text;
  if (msg.contextFolderId) {
    const nodes = await chrome.bookmarks.get(msg.contextFolderId).catch(() => []);
    const folder = nodes[0];
    if (folder) {
      text = `（当前上下文：用户正在查看书签文件夹「${folder.title || '(未命名)'}」）\n${text}`;
    } else {
      // 上下文文件夹已不存在（被删/移动）：明确告知 Agent，避免它误以为有上下文视野
      text = `（注：用户此前查看的上下文文件夹已不存在，请按全部书签处理）\n${text}`;
    }
  }

  try {
    await runAgentTurn({
      config,
      messageId: msg.messageId,
      history: msg.history,
      text,
      signal,
      /*
       * 每个事件既推给 UI，也在后台侧留下痕迹。
       *
       * 只推给 UI 是不够的：切到后台后页面定时器被节流、SW 被回收、port 断开，
       * 而 UI 的落盘正是靠那些被节流的定时器——坏掉的恰恰是"UI 还活着"这个前提。
       * 增量在后台累积成草稿并节流落盘，UI 恢复时再合并，内容就不会因为切标签页蒸发。
       */
      onEvent: (e) => {
        safePost(port, e);
        if (e.type === 'chat:delta') {
          appendDraft(e.messageId, e.text);
        } else if (e.type === 'chat:done' || e.type === 'chat:error' || e.type === 'chat:cancelled') {
          /*
           * 收尾：先把草稿落到**会话消息**里，再清掉草稿。
           *
           * 只 clear 不 finalize 的话，port 早断、UI 一直没回来的那种情况，
           * 内容就只剩草稿这一份——一删就真没了。会话消息才是 UI 下次 load 读的地方。
           */
          void finalizeDraft('markai.ai').catch(() => {});
        }
      },
      // 计划模式的真实确认通道：发出 chat:plan 后等这个连接上的 chat:plan_decision；
      // 端口断开/取消时由登记表按"未批准"结算（绝不挂死一轮）
      requestPlanApproval: (steps, messageId) =>
        requestPlanApprovalWithAbort(
          planApprovals,
          messageId,
          steps,
          (m) => safePost(port, m),
          signal,
        ),
    });
  } catch (e) {
    if (signal.aborted) {
      safePost(port, { type: 'chat:cancelled', messageId: msg.messageId });
      // 取消也要清徽标（否则 '…' 永久残留）
      clearBadge();
      return;
    }
    const message = e instanceof ChatError ? e.message : 'AI 请求失败，请检查网络与配置。';
    safePost(port, { type: 'chat:error', messageId: msg.messageId, message });
    clearBadge(true);
    return;
  }
  // 正常结束（chat:done）→ 清除徽标
  clearBadge();
}

/** 设置工具栏徽标（text + 背景色） */
async function setTaskBadge(text: string, color: string): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
  await chrome.action.setBadgeText({ text }).catch(() => {});
}

/** Port 已断开时 postMessage 会抛错，静默吞掉 */
function safePost(port: chrome.runtime.Port, event: ChatOutbound): void {
  try {
    port.postMessage(event);
  } catch {
    // UI 侧已断开
  }
}
