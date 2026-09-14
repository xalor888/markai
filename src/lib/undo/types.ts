/**
 * 操作日志（operation journal）的数据模型。
 *
 * 目的：让 Agent 的每一次写操作**可逆**。删除已有独立的确认闸门（deletion proposal），
 * 撤销覆盖其余写操作（移动 / 重命名 / 改 URL / 新建 / 复制 / 排序 / 合并 / 自动分类），
 * 两条线正交。
 *
 * 记录原则：只记录「还原所需的最小信息」，且必须在**动手之前**取到——
 * 例如移动的 fromIndex 必须是移动**前**在旧父目录中的下标（移动后再读就是新位置了）。
 */

/** 书签子树快照（删除操作的还原依据；递归含全部后代） */
export interface BookmarkSnapshot {
  title: string;
  url?: string;
  children?: BookmarkSnapshot[];
}

/** 单条可逆写操作（按发生顺序记录；撤销时逆序执行） */
export type UndoOp =
  | {
      kind: 'move';
      id: string;
      title: string;
      /** 移动前所在的父目录；撤销时移回这里 */
      fromParentId: string;
      /** 移动前在旧父目录中的下标（0 基）。必须是移动**前**的值 */
      fromIndex: number;
    }
  | {
      kind: 'update';
      id: string;
      title: string;
      /** 仅包含本次真正被改动的字段的旧值 */
      before: { title?: string; url?: string };
    }
  | {
      kind: 'create';
      id: string;
      title: string;
      /** 文件夹需 removeTree 撤销，书签用 remove */
      isFolder: boolean;
    }
  | {
      /**
       * 并发批量移动（目前只有 auto_categorize）。
       *
       * 为什么不能拆成逐条 move：并发 worker 各自读到的 fromIndex 来自**正在被别人修改**的
       * 兄弟列表，那组下标不构成任何一致的串行历史，撤销后顺序会错乱（5000 节点规模测试实测）。
       * 所以整批只记一条，并带上批次开始前源文件夹的**完整子序**——它是批次自身的"操作前状态"，
       * 与撤销的逆序回放天然一致（自包含，不与其他操作的下标混用坐标系）。
       */
      kind: 'moveBatch';
      title: string;
      /** 这些节点从 fromParentId 被移走 */
      fromParentId: string;
      ids: string[];
      /** 批次开始前 fromParentId 的完整子项顺序（用于精确还原顺序） */
      order: string[];
    }
  | {
      kind: 'delete';
      id: string;
      title: string;
      /** 删除前所在父目录（撤销时重建到这里） */
      parentId?: string;
      /**
       * 兜底位置。**只在没有该父目录的顺序检查点时使用**。
       *
       * 注意：并发删除下这个下标是**不可靠的**（每个 worker 读到的是同伴正在修改的列表，
       * 且"抓取顺序"与"记录顺序"并不一致）。位置的正解是 UndoPoint.orderCheckpoints
       * ——由工具在动手前对每个将失去子项的父目录取一次完整子序。这里保留 index
       * 只是为了在缺少检查点时尽力而为。
       */
      index?: number;
      /** 子树快照。**没有快照 = 历史日志点（v0.2.3 及更早写的），不可撤销** */
      snapshot?: BookmarkSnapshot;
    };

export type UndoOpKind = UndoOp['kind'];

/**
 * 一个撤销点 = 一个 Agent 轮次（messageId）内发生的全部写操作。
 * 粒度是「轮」而不是「单步」：它服务于聊天交互（「撤销刚才那一步」）。
 */
export interface UndoPoint {
  id: string;
  /** 产生它的 Agent 轮次（assistant messageId） */
  runId: string;
  createdAt: number;
  /** 正序记录；撤销时按逆序执行 */
  ops: UndoOp[];
  /**
   * 父目录顺序检查点：`parentId → 本轮第一次改动它之前的完整子序`。
   *
   * 删除的位置还原必须靠它：并发删除的逐条下标不可靠（抓取顺序与记录顺序不一致），
   * 撤销最后按检查点把父目录的子序整体校正回原样，就与并发无关了。
   * 由调用方（工具）在动手**之前**调用 `ensureOrderCheckpoint` 取。
   */
  orderCheckpoints?: { parentId: string; order: string[] }[];
  /** 本轮流是否包含删除（删除没有快照，无法完整撤销，需明确拒绝而不是假装成功） */
  containsDelete: boolean;
  /** 已执行过撤销的时间；存在即表示该点已消费 */
  appliedAt?: number;
}

/** undo:list 的结果 */
export interface UndoListResult {
  /** 新的在前 */
  points: UndoPoint[];
}

/** undo:apply 的结果（成功与失败都必须如实上报） */
export interface UndoApplyResult {
  ok: boolean;
  /** 无法撤销时的原因（含删除、点不存在、点已消费等） */
  reason?: string;
  /** 真正还原成功的操作数 */
  restored: number;
  failures: { op: UndoOpKind; title: string; error: string }[];
}
