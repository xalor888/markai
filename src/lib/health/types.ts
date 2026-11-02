/**
 * ── 健康检查：数据模型 ──
 *
 * 为什么要有这套东西：扩展出问题时，用户能看到的只有"扩展图标上一个红色感叹号"。
 * 点开是 `chrome://extensions` 里一串英文栈，既看不出严重程度，也不知道该修还是该删。
 * 而真正的原因往往很普通——没填 Key、自定义请求头写错一行、撤销点攒满被截断。
 *
 * 所以这里把"诊断"做成产品能力：
 *   1. 用**纯函数**把各类快照判成一组有据可查的 Issue（可单测，不碰 chrome）；
 *   2. 每条 Issue 要么给出**可自动执行的修复动作**，要么给出**用户可照做的手动指引**；
 *   3. 一键生成可复制的诊断文本——贴给开发者就能定位，不用再猜。
 *
 * 安全边界（最重要的一条）：
 *   **自动修复只允许改动 MarkAI 自己的元数据**（配置 / 撤销点 / 整理记录 / 运行时标记），
 *   永远不会移动、删除、重命名用户的任何书签或文件夹。
 *   书签层面的异常一律只报告——用户已经被"自动批量搬书签"坑过一次，不能再来第二次。
 */

/** 严重程度：决定颜色与"要不要现在就管" */
export type IssueSeverity = 'critical' | 'high' | 'medium' | 'low';

/** 问题归属：用于分组展示与快速定位 */
export type IssueArea = 'config' | 'permission' | 'undo' | 'log' | 'bookmarks' | 'storage' | 'ai' | 'runtime';

/** 可自动执行的修复动作 id（与 fixes.ts 一一对应） */
export type FixAction =
  | 'config.fill-defaults'
  | 'config.normalize-baseurl'
  | 'config.drop-bad-headers'
  | 'undo.drop-corrupt'
  | 'undo.trim-overflow'
  | 'log.mark-orphan'
  | 'log.trim-limit';

export interface Issue {
  /** 稳定标识（`area.problem`），测试与去重都靠它 */
  id: string;
  area: IssueArea;
  severity: IssueSeverity;
  /** 一句话说清"是什么问题"（用户视角，不是代码视角） */
  title: string;
  /** 具体证据：几个、哪一条、什么值 */
  detail: string;
  /** 有则可一键修复 */
  fix?: { action: FixAction; label: string };
  /** 没 fix 时必须给出用户能照做的下一步 */
  manualHint?: string;
  /** 受影响的数量（几条记录 / 几个文件夹） */
  count?: number;
}

/**
 * 诊断输入：**只读快照**。
 *
 * 刻意不做成"传 chrome 进来自己查"——那样诊断就绑死在浏览器 API 上，
 * 单测只能靠 mock，而 mock 里的规则迟早和真实行为漂移。
 * 这里让调用方把已读到的东西交进来，诊断保持纯粹。
 */
export interface HealthSnapshot {
  /** 读配置失败时的错误（null 表示读到了） */
  configError: string | null;
  config: {
    providerId?: string | null;
    baseUrl?: string | null;
    /**
     * 用户**原始输入**的 Base URL（未归一化）。
     *
     * 必须有这个字段：`readSnapshot` 为了"诊断看到的配置和运行时实际用的是同一份"
     * 会走 `resolveConfig`，而它会 `normalizeBaseUrl`（自动补 https://、去尾斜杠）。
     * 于是 `config.invalid-baseurl` 这条判据**永远不可能触发**——
     * 用户输入什么都不像地址的值，归一化之后 `new URL()` 全都通过。
     * 那个「修正为合法地址」的修复按钮因此是用户永远看不到的死代码。
     */
    baseUrlRaw?: string | null;
    apiKey?: string | null;
    model?: string | null;
    customHeaders?: string | null;
    autoOrganizeNew?: boolean | null;
    autoOrganizeAi?: boolean | null;
    contextWindow?: number | null;
  } | null;
  /** 该服务商是否需要 API Key */
  providerNeedsKey: boolean;
  /** 实际持有的权限（chrome.permissions.getAll 的 permissions） */
  permissions: string[];
  /** 撤销点原始数据（结构可能损坏，诊断要能容忍） */
  undoPoints: unknown;
  /** 整理记录原始数据 */
  logEntries: unknown;
  /**
   * 整理记录自己占用的字节数（null = 量不到）。
   *
   * `storage.near-quota` 原来无条件把「清理整理记录」当作修复动作，
   * 但存储不止这一块：撤销点（含被删书签的子树快照）、对话历史都算在内。
   * 占用来自别处时，清日志根本降不到阈值以下——用户看到的是
   * 「点了修复，问题还在、分数不动」（0.2.68 那一类）。
   * 所以必须先知道日志到底占多少，只在真能帮上时才提供这个修复。
   */
  logBytes: number | null;
  /** 书签统计（由调用方遍历一次树算出） */
  bookmarks: {
    total: number;
    folders: number;
    emptyFolders: number;
    maxDepth: number;
    /** 父节点已不存在的书签数（理论上不该出现） */
    orphaned: number;
    /** 同父同名的文件夹组数 */
    duplicateNameGroups: number;
  } | null;
  /** 存储用量（字节），拿不到则为 null */
  storageBytes: number | null;
  /** 上一次自动整理/分类留下的错误（来自整理记录） */
  lastAiError: string | null;
}

/** 诊断结论 */
export interface HealthReport {
  /** 0–100：100 表示没有任何问题 */
  score: number;
  issues: Issue[];
  checkedAt: number;
}

export const SEVERITY_ORDER: Record<IssueSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export const SEVERITY_LABEL: Record<IssueSeverity, string> = {
  critical: '严重',
  high: '需处理',
  medium: '建议处理',
  low: '提示',
};

export const AREA_LABEL: Record<IssueArea, string> = {
  config: '配置',
  permission: '权限',
  undo: '撤销',
  log: '整理记录',
  bookmarks: '书签',
  storage: '存储',
  ai: 'AI 服务',
  runtime: '运行时',
};
