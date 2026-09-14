/**
 * 书签右键菜单的编排逻辑（从 background 抽出来，便于用替身直接单测）。
 *
 * 为什么要有这个模块：这段逻辑做的是"写一条指令 → 打开侧边栏 → 广播"的交接，
 * 而**写入可能失败**。原先 `.catch(() => {})` 吞掉失败后照样打开侧边栏，
 * 用户看到的是空聊天，完全不知道指令没保存；而 handleContextMenuClick 是事件监听器，
 * 返回值没有任何消费者——所以修法只能走**真实的可见通路**，也就是工具栏。
 *
 * 不依赖 storage 的失败信号只有工具栏：storage 写不进去时，badge + title 仍然可用。
 */

export interface SeedPayload {
  text: string;
  folderId?: string;
  notice?: string;
  createdAt: number;
}

export interface ContextMenuDeps {
  /** 读取被右键的节点（可能已被删除） */
  getNode: (id: string) => Promise<chrome.bookmarks.BookmarkTreeNode | undefined>;
  setSeed: (seed: SeedPayload) => Promise<void>;
  clearSeed: () => Promise<void>;
  openSidePanel: (windowId?: number) => Promise<void>;
  broadcastSeed: () => Promise<void>;
  getWindowId: () => Promise<number | undefined>;
  openTab: (url: string) => Promise<void>;
  pageUrl: () => string;
  /** 工具栏错误提示（storage 不可用时的唯一可见通路） */
  setErrorHint: (title: string) => Promise<void>;
  clearErrorHint: () => Promise<void>;
}

/** 右键菜单点击所需的最小信息（与 chrome.contextMenus.OnClickData 兼容） */
export interface ContextMenuClickInfo {
  menuItemId: string;
  bookmarkId?: string;
  windowId?: number;
}

const ERROR_TITLE = 'MarkAI：右键指令未能保存，请重新选择书签后重试';

/** 组织成发给 Agent 的指令文本 */
function buildInstruction(
  menuItemId: string,
  node: chrome.bookmarks.BookmarkTreeNode | undefined,
): { text: string; folderId?: string; notice?: string } {
  const title = node?.title || '此书签';
  // 书签上下文菜单但目标已不存在（菜单打开后书签被删）：给用户可见提示，而不是静默无反馈
  if (!node) return { text: '', notice: '右键的书签已被删除或不可用，请重新选择。' };

  if (menuItemId === 'markai:organize') {
    if (node.url) {
      // 单个书签：归位到合适分类（与文件夹的"整理全部子项"语义区分）
      return {
        text: `请处理书签「${title}」（${node.url}）：判断现有分类里是否有合适的文件夹，把它归位到位；没有合适分类时新建一个语义清晰的文件夹。`,
      };
    }
    return {
      text: `请整理书签文件夹「${title}」：浏览其全部书签，创建合适的子分类并把书签归类移动到位。`,
      folderId: node.id, // 仅文件夹提供上下文
    };
  }
  if (menuItemId === 'markai:analyze') {
    return {
      text: `请分析书签「${title}」${node.url ? `（${node.url}）` : ''}：检查链接是否有效、内容是否过时，给出整理或清理建议。`,
    };
  }
  return { text: '' };
}

/**
 * 处理一次右键点击。
 *
 * 关键语义：**指令没保存成功就不要假装它被送出了**——不打开侧边栏、不广播，
 * 改为在工具栏上给出可见的错误提示。
 */
export async function handleContextMenuClick(
  info: ContextMenuClickInfo,
  deps: ContextMenuDeps,
): Promise<void> {
  // 「在完整页打开」直接开标签页，无需书签上下文；失败也要有可见反馈
  if (info.menuItemId === 'markai:fullpage') {
    try {
      await deps.openTab(deps.pageUrl());
    } catch {
      await deps.setErrorHint('MarkAI：完整页打开失败，请重试');
    }
    return;
  }

  const node = info.bookmarkId ? await deps.getNode(info.bookmarkId) : undefined;
  const { text, folderId, notice } = buildInstruction(info.menuItemId, node);

  if (text || notice) {
    const seed: SeedPayload = {
      text,
      ...(folderId ? { folderId } : {}),
      ...(notice ? { notice } : {}),
      createdAt: Date.now(),
    };
    try {
      await deps.setSeed(seed);
    } catch {
      // 写不进去：既不打开侧边栏也不广播（否则用户只会看到一个空聊天），
      // 改用不依赖 storage 的工具栏提示说清失败
      await deps.setErrorHint(ERROR_TITLE);
      return;
    }
  } else {
    // 无新指令：清除残留的旧种子，避免下次挂载误消费幽灵指令
    try {
      await deps.clearSeed();
    } catch {
      // 清不掉不会造成错误指令（本轮没有要送出的指令）
    }
  }

  // 到这里 seed 已经落盘：打开失败也只是"用户需要手动打开侧边栏"，
  // 那时挂载仍会照常消费这条指令（不是数据丢失，所以不加错误提示）
  const windowId = info.windowId ?? (await deps.getWindowId());
  try {
    await deps.openSidePanel(windowId);
  } catch {
    // best-effort：seed 已保存，用户手动打开侧边栏即可继续
  }

  // 若侧边栏已打开，直接广播（比等挂载更即时）
  if (text || notice) {
    try {
      await deps.broadcastSeed();
    } catch {
      // 无页面在监听，忽略（种子已在 storage 中）
    }
  }

  // 本次成功送出指令：清掉可能残留的历史错误提示
  await deps.clearErrorHint();
}
