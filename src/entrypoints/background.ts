/**
 * ── MarkAI background Service Worker ──
 * 职责：
 *  1. 浏览器原生书签右键菜单（contextMenus）→ 打开侧边栏并注入种子指令
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
import { executeDeletions as runDeletions } from '@/lib/ai/deletion-executor';
import { normalizeBaseUrl, resolveConfig } from '@/lib/providers';
import { CONFIG_STORAGE_KEY } from '@/stores/configStore';
import { applyUndo } from '@/lib/undo/apply';
import { readUndoState } from '@/lib/undo/recorder';
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

  // ── 1. 浏览器原生书签右键菜单 ──
  // 注：'bookmark' 上下文是较新的 Chrome API，@types/chrome 尚未收录，通过断言助手创建
  // 只在安装/更新时注册（onInstalled），避免 SW 重启后重复 id 报错；重复注册兜底吞错
  chrome.runtime.onInstalled.addListener(async () => {
    // 先清空再注册，彻底避免重复 id 报错（onInstalled 在 install/update 时触发）
    await chrome.contextMenus.removeAll().catch(() => {});
    const createChecked = (props: chrome.contextMenus.CreateProperties, label: string) => {
      chrome.contextMenus.create(props);
      // MV3 下 create 是同步的，lastError 在每次调用后被重置：每项都查，不静默
      if (chrome.runtime.lastError) {
        console.warn(`[MarkAI] contextMenus 注册失败（${label}）:`, chrome.runtime.lastError.message);
      }
    };
    createChecked(bookmarkMenuProps('markai:organize', '让 MarkAI 整理此文件夹'), 'organize');
    createChecked(bookmarkMenuProps('markai:analyze', '让 MarkAI 分析此书签'), 'analyze');
    createChecked(
      {
        id: 'markai:sep',
        type: 'separator',
        contexts: ['bookmark'],
      } as unknown as chrome.contextMenus.CreateProperties,
      'separator',
    );
    createChecked(bookmarkMenuProps('markai:open', '打开 MarkAI 管理面板'), 'open');
    createChecked(bookmarkMenuProps('markai:fullpage', '在 MarkAI 完整页打开'), 'fullpage');
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
    // 每个连接一份登记表：决定只结算本连接上挂起的计划
    const planApprovals = createPlanApprovalRegistry();

    port.onMessage.addListener((raw: ChatInbound) => {
      if (raw.type === 'chat:send') {
        // 同一 Port 连续发送时，取消上一次未完成的流式
        abort?.abort();
        // 上一条若停在计划确认上：abort 不会让它的 await 返回，这里补一次结算（纵深防御）
        planApprovals.cancelAll();
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
      abort?.abort();
      abort = null;
      // 面板关了没人能点确认：未决计划按"未批准"结算（绝不挂死一轮）
      planApprovals.cancelAll();
    });
  });

  void ensureRoots().catch(() => {});
});

/** 书签上下文菜单选项（'bookmark' 上下文为较新 API，@types/chrome 未收录，断言绕过） */
function bookmarkMenuProps(id: string, title: string): chrome.contextMenus.CreateProperties {
  return { id, title, contexts: ['bookmark'] } as unknown as chrome.contextMenus.CreateProperties;
}

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

    case 'task:status': {
      // popup 主动查询：SW 活着才有准确状态；SW 已回收则任务必然中断（sendMessage 会失败，popup 按未处理中处理）
      return { type: 'task:status:result', running: agentTaskRunning };
    }
  }
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
      onEvent: (e) => safePost(port, e),
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
