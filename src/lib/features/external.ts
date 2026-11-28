/**
 * ── 对外接口接缝（MCP / CLI / Skills） ──
 *
 * 目标：让外部 Agent（Claude Code、Codex、Cursor…）能**安全地**读写书签，
 * 而不是让用户手动导出 JSON 再喂进去。
 *
 * 安全模型（这一层就定死，实现不能放宽）：
 *  · 默认关闭。打开后生成一个本机 token；没有 token 的调用一律拒绝。
 *  · 删除永远不直接执行：外部调用只能"提交删除提议"，与 Agent 同一套确认闸门。
 *  · 每次调用记入审计日志（谁、何时、做了什么、结果），用户可查可关。
 *  · 只监听 127.0.0.1，不监听 0.0.0.0。
 */

export interface ExternalApiConfig {
  enabled: boolean;
  /** 本机回环端口（实现方选一个不冲突的默认值） */
  port: number;
  /** 调用方必须带 `Authorization: Bearer <token>` */
  token: string;
  /** 允许的写操作；删除不在其中（删除只能提议） */
  allowWrites: boolean;
}

export const EXTERNAL_API_DEFAULT: ExternalApiConfig = {
  enabled: false,
  port: 8787,
  token: '',
  allowWrites: false,
};

export const EXTERNAL_STORAGE_KEY = 'markai.external';

export interface ExternalAuditEntry {
  at: number;
  /** 调用来源（CLI / MCP / 未知） */
  client: string;
  tool: string;
  ok: boolean;
  /** 结果摘要（不含书签内容全文，避免日志膨胀） */
  summary: string;
}

/** 对外暴露的工具清单（与 Agent 工具同名同义，便于外部 Agent 复用提示词） */
export const EXTERNAL_TOOLS = [
  'list_bookmarks',
  'search_bookmarks',
  'get_folder_path',
  'list_all_folders',
  'stats',
  'create_folder',
  'create_bookmark',
  'move_bookmark',
  'rename_bookmark',
  'update_url',
  'propose_deletions',
] as const;

export type ExternalTool = (typeof EXTERNAL_TOOLS)[number];

/** 只读工具：即使 allowWrites=false 也允许 */
export const EXTERNAL_READ_TOOLS: readonly ExternalTool[] = [
  'list_bookmarks',
  'search_bookmarks',
  'get_folder_path',
  'list_all_folders',
  'stats',
];
