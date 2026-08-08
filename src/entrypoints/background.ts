/**
 * ── MarkAI background Service Worker ──
 * 职责：
 *  1. 浏览器原生书签右键菜单（contextMenus）→ 打开侧边栏并注入种子指令
 *  2. 一次性消息：AI 连接测试 / 删除执行（removeTree 唯一执行点）/ 侧边栏打开 / 种子消费
 *  3. 聊天长连接 Port：Agent 流式代理（工具调用循环在后台闭环，UI 零 CORS 压力）
 */

import { runAgentTurn } from '@/lib/ai/agent';
import { ChatError, testConnection } from '@/lib/ai/client';
import { ensureRoots } from '@/lib/ai/tools';
import { normalizeBaseUrl, resolveConfig } from '@/lib/providers';
import { CONFIG_STORAGE_KEY } from '@/stores/configStore';
import type {
  AIConfig,
  ChatInbound,
  ChatOutbound,
  OneShotInbound,
  OneShotOutbound,
  SeedPayload,
} from '@/lib/ai/types';

export default defineBackground(() => {
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
        // 忽略（用户可手动打开）
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
        // failed 必须带真实 proposalId：空串会让 UI 把所有项标记为 executed（假成功且无法重试）
        const errMsg = e instanceof Error ? e.message : String(e);
        try {
          const failed =
            msg.type === 'deletions:execute'
              ? msg.items.map((i) => ({ proposalId: i.proposalId, error: errMsg }))
              : [{ proposalId: '', error: errMsg }];
          sendResponse({ type: 'deletions:result', count: 0, failed } as OneShotOutbound);
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

    port.onMessage.addListener((raw: ChatInbound) => {
      if (raw.type === 'chat:send') {
        // 同一 Port 连续发送时，取消上一次未完成的流式
        abort?.abort();
        const ctrl = new AbortController();
        abort = ctrl;
        void handleChatSend(port, raw, ctrl.signal).finally(() => {
          // 仅当仍是当前请求时才清空，避免旧请求的 finally 覆盖新请求的 abort
          if (abort === ctrl) abort = null;
        });
      } else if (raw.type === 'chat:cancel') {
        abort?.abort();
      }
    });

    port.onDisconnect.addListener(() => {
      abort?.abort();
      abort = null;
    });
  });

  void ensureRoots().catch(() => {});
});

/** 书签上下文菜单选项（'bookmark' 上下文为较新 API，@types/chrome 未收录，断言绕过） */
function bookmarkMenuProps(id: string, title: string): chrome.contextMenus.CreateProperties {
  return { id, title, contexts: ['bookmark'] } as unknown as chrome.contextMenus.CreateProperties;
}

/** ── contextMenus 点击处理 ── */
async function handleContextMenuClick(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<void> {
  // bookmarkId 仅出现在书签上下文，@types/chrome 尚未收录，这里断言读取
  const bookmarkId = (info as unknown as { bookmarkId?: string }).bookmarkId;

  // 「在完整页打开」直接开标签页，无需书签上下文
  if (info.menuItemId === 'markai:fullpage') {
    void chrome.tabs.create({ url: chrome.runtime.getURL('page.html') }).catch(() => {});
    return;
  }

  let node: chrome.bookmarks.BookmarkTreeNode | undefined;
  if (bookmarkId) {
    const nodes = await chrome.bookmarks.get(bookmarkId).catch(() => []);
    node = nodes[0];
  }
  const title = node?.title || '此书签';

  let text = '';
  let folderId: string | undefined;
  let notice: string | undefined;
  // 书签上下文菜单但目标已不存在（菜单打开后书签被删）：给用户可见提示，而不是静默无反馈
  if (bookmarkId && !node) {
    notice = '右键的书签已被删除或不可用，请重新选择。';
  } else if (info.menuItemId === 'markai:organize' && node) {
    if (node.url) {
      // 单个书签：归位到合适分类（与文件夹的"整理全部子项"语义区分）
      text = `请处理书签「${title}」（${node.url}）：判断现有分类里是否有合适的文件夹，把它归位到位；没有合适分类时新建一个语义清晰的文件夹。`;
    } else {
      text = `请整理书签文件夹「${title}」：浏览其全部书签，创建合适的子分类并把书签归类移动到位。`;
      folderId = node.id; // 仅文件夹提供上下文
    }
  } else if (info.menuItemId === 'markai:analyze' && node) {
    text = `请分析书签「${title}」${node.url ? `（${node.url}）` : ''}：检查链接是否有效、内容是否过时，给出整理或清理建议。`;
  }

  // 写入种子指令（侧边栏挂载时消费），并尝试打开侧边栏
  if (text || notice) {
    const seed: SeedPayload = {
      text,
      ...(folderId ? { folderId } : {}),
      ...(notice ? { notice } : {}),
      createdAt: Date.now(),
    };
    await chrome.storage.local.set({ 'markai.seed': seed }).catch(() => {});
  } else {
    // 无新指令（如「打开完整页」）：清除残留的旧种子，避免下次挂载误消费幽灵指令
    await chrome.storage.local.remove('markai.seed').catch(() => {});
  }

  const windowId = tab?.windowId ?? (await chrome.windows.getCurrent()).id;
  if (windowId !== undefined) {
    try {
      await chrome.sidePanel.open({ windowId });
    } catch {
      // 某些场景（如浏览器限制）打开失败时静默，用户可手动打开
    }
  }

  // 若侧边栏已打开，直接广播（比等挂载更即时）
  if (text || notice) {
    try {
      await chrome.runtime.sendMessage({ type: 'markai:seed' });
    } catch {
      // 无页面在监听，忽略（种子已在 storage 中）
    }
  }
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

    case 'task:status': {
      // popup 主动查询：SW 活着才有准确状态；SW 已回收则任务必然中断（sendMessage 会失败，popup 按未处理中处理）
      return { type: 'task:status:result', running: agentTaskRunning };
    }
  }
}

/** ── 删除执行（UI 确认后唯一删除入口；支持"删除全部"特殊提议） ── */
async function executeDeletions(
  items: { proposalId: string; bookmarkId: string; all?: boolean }[],
): Promise<OneShotOutbound> {
  await ensureRoots();
  let count = 0;
  const failed: { proposalId: string; error: string }[] = [];

  // 普通条目并发池 10（Chrome bookmarks API 对高频调用有限流，20 并发易触发批量失败；
  // 失败重试一次再上报）。批量清理 750 条从 ~10s 降到 ~1.5s
  const normal = items.filter((it) => it.bookmarkId !== 'markai:all');
  let cursor = 0;
  const runOne = async (it: { proposalId: string; bookmarkId: string; all?: boolean }) => {
    try {
      if (it.all) throw new Error('非"删除全部"提议携带了多余标志');
      const nodes = await chrome.bookmarks.get(it.bookmarkId).catch(() => []);
      const node = nodes[0];
      if (!node) {
        // 书签已不存在（如其他窗口已删）：视为目标已达成，避免 UI 卡在可重试的 pending 死循环
        count++;
        return;
      }
      // 双保险：根文件夹（parentId '0'）与元根永远不可删
      if (node.parentId === undefined || node.parentId === '0') throw new Error('根文件夹不可删除');
      try {
        await chrome.bookmarks.removeTree(it.bookmarkId);
      } catch {
        // 瞬时失败（限流/竞态）重试一次
        await chrome.bookmarks.removeTree(it.bookmarkId);
      }
      count++;
    } catch (e) {
      failed.push({ proposalId: it.proposalId, error: e instanceof Error ? e.message : String(e) });
    }
  };
  const workers = Array.from({ length: Math.min(10, Math.max(1, normal.length)) }, async () => {
    while (cursor < normal.length) {
      const it = normal[cursor++]!;
      await runOne(it);
    }
  });
  await Promise.all(workers);

  // "删除全部"特殊提议：清空各根目录的子项（根文件夹保留），失败逐项上报
  const allItem = items.find((it) => it.bookmarkId === 'markai:all');
  if (allItem) {
    try {
      // 纵深防御：'markai:all' 特殊值必须携带 all 标志（防止 storage 脏数据/旧版本误触发清空）
      if (!allItem.all) throw new Error('缺少删除全部授权标志');
      const tree = await chrome.bookmarks.getTree();
      const roots = tree[0]?.children ?? [];
      const targets: { id: string; title: string }[] = [];
      for (const root of roots) {
        for (const child of root.children ?? []) targets.push({ id: child.id, title: child.title || child.id });
      }
      let tcursor = 0;
      const allWorkers = Array.from({ length: Math.min(10, Math.max(1, targets.length)) }, async () => {
        while (tcursor < targets.length) {
          const t = targets[tcursor++]!;
          try {
            try {
              await chrome.bookmarks.removeTree(t.id);
            } catch {
              await chrome.bookmarks.removeTree(t.id); // 瞬时失败重试一次
            }
            count++;
          } catch (e) {
            // 单项失败上报（同一 proposalId），UI 侧据此提示部分未删除
            failed.push({
              proposalId: allItem.proposalId,
              error: `删除 ${t.title} 失败：${e instanceof Error ? e.message : String(e)}`,
            });
          }
        }
      });
      await Promise.all(allWorkers);
    } catch (e) {
      failed.push({ proposalId: allItem.proposalId, error: e instanceof Error ? e.message : String(e) });
    }
  }
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
    await runAgentTurn({ config, messageId: msg.messageId, history: msg.history, text, signal, onEvent: (e) => safePost(port, e) });
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
