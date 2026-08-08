/** ── Agent 消息模型（UI 与 background 共享） ── */

/** 工具执行状态 */
export type ToolStatus = 'running' | 'done' | 'error';

/** 待删除提议状态 */
export type DeletionStatus = 'pending' | 'confirmed' | 'declined' | 'executed';

/** 待删除提议（安全机制：默认必须用户确认后才执行；"无需确认"模式下自动执行） */
export interface DeletionProposal {
  id: string;
  bookmarkId: string;
  title: string;
  url?: string;
  reason: string;
  status: DeletionStatus;
  createdAt: number;
  /** 删除全部书签的提议（bookmarkId 为特殊标记，执行时清空所有根的子项） */
  all?: boolean;
}

/** 单次工具调用记录（渲染为聊天中的状态 chip / 删除卡片） */
export interface ToolCallRecord {
  id: string; // 工具调用 id（来自 AI 或本地生成）
  name: string; // 工具名
  args: string; // 参数 JSON 字符串
  status: ToolStatus;
  result?: string; // 执行结果（JSON 文本）
  error?: string;
  deletions?: DeletionProposal[]; // propose_deletions 的提议载荷
}

/** 聊天块：文本或工具调用（按到达顺序排列，保证时序正确） */
export type ChatBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; record: ToolCallRecord };

/** 一条聊天消息 */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  blocks: ChatBlock[];
  createdAt: number;
  /** 用户消息发送时附带的上下文文件夹（消息内展示 Agent 视野） */
  contextFolderId?: string;
}

/** AI 连接配置（options 页配置，chrome.storage.local 明文存储） */
export interface AIConfig {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 删除执行模式：confirm = 始终需用户确认；auto = AI 删除提议自动执行（默认需确认更安全） */
  deleteMode?: 'confirm' | 'auto';
  /** 模型上下文长度（token）：默认 1024K（1M），用户在设置页可手动调整，服务商返回 context_window 时可自动带入 */
  contextWindow?: number;
  /** 自动压缩阈值（0.5~0.95）：历史用量达到 窗口×阈值 时触发压缩，默认 0.8 */
  compressThreshold?: number;
  /** 上下文自动压缩：达到阈值时压缩早期消息再继续 */
  autoCompress?: boolean;
}

/** ── UI ↔ background 长连接 Port 协议（聊天流式代理） ── */

/** UI → background */
export type ChatInbound =
  | {
      type: 'chat:send';
      messageId: string; // UI 生成的 assistant 消息 id，用于回传事件
      text: string;
      history: ChatMessage[]; // 历史消息快照（不含本次）
      contextFolderId?: string; // 用户当前查看的文件夹
    }
  | { type: 'chat:cancel' }
  // 保活心跳：MV3 下 SW 约 30s 无事件即被回收，长任务（大库检测/分类）期间
  // LLM 往返可能超过该窗口；UI 每 20s 发一次 ping，消息到达即重置空闲计时器
  | { type: 'chat:ping' };

/** background → UI */
export type ChatOutbound =
  | { type: 'chat:start'; messageId: string }
  | { type: 'chat:delta'; messageId: string; text: string }
  | { type: 'chat:tool_start'; messageId: string; record: ToolCallRecord }
  | { type: 'chat:tool_progress'; messageId: string; recordId: string; text: string }
  | { type: 'chat:tool_done'; messageId: string; record: ToolCallRecord }
  | { type: 'chat:tool_error'; messageId: string; record: ToolCallRecord }
  | { type: 'chat:done'; messageId: string }
  | { type: 'chat:cancelled'; messageId: string }
  | { type: 'chat:error'; messageId: string; message: string };

/** ── 一次性消息协议（runtime.sendMessage，用于非流式请求） ── */

/** UI → background */
export type OneShotInbound =
  | { type: 'ai:test'; config: AIConfig }
  | { type: 'ai:models'; config: AIConfig }
  | { type: 'deletions:execute'; items: { proposalId: string; bookmarkId: string }[] }
  | { type: 'sidepanel:open'; windowId: number }
  | { type: 'seed:consume' }
  // 查询当前是否有 Agent 任务在跑（SW 活着才有准确状态；SW 已回收 = 任务已中断）
  | { type: 'task:status' };

/** background → UI（sendResponse 载荷） */
export type OneShotOutbound =
  | { type: 'ai:test:result'; ok: boolean; message: string; model?: string }
  | { type: 'ai:models:result'; ok: boolean; models: string[]; message: string; contextWindow?: number }
  | { type: 'deletions:result'; count: number; failed: { proposalId: string; error: string }[] }
  | { type: 'sidepanel:opened'; ok: boolean }
  | { type: 'seed:value'; text?: string; folderId?: string; notice?: string }
  | { type: 'task:status:result'; running: boolean };

/** contextMenus 种子指令（存储中转，侧边栏挂载时消费） */
export interface SeedPayload {
  text: string;
  folderId?: string;
  /** 非指令类提示（如右键的书签已不存在）：消费方 toast 展示，不发给 Agent */
  notice?: string;
  createdAt: number;
}
