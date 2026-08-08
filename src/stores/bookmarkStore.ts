/** ── 书签树 store（树结构、选中态、展开态、多选与右键菜单） ── */

import { create } from 'zustand';
import { pushToast } from '@/lib/toast';

type BNode = chrome.bookmarks.BookmarkTreeNode;
export type { BNode };

/** 应用内右键菜单状态 */
export interface TreeContextMenu {
  x: number;
  y: number;
  bookmarkId: string;
}

interface BookmarkState {
  roots: BNode[]; // 三个根文件夹（书签栏 / 其他书签 / 移动设备）
  loading: boolean;
  /** 树加载失败原因（空 = 正常）；失败时 UI 显示重试入口，不再静默空白 */
  loadError: string | null;
  selectedFolderId: string | null; // 中栏当前查看的文件夹
  expandedIds: string[];
  selectedBookmarkIds: string[]; // 中栏多选
  contextMenu: TreeContextMenu | null;
  searchQuery: string; // 中栏搜索关键字（空 = 浏览模式）
  revealId: string | null; // 「在树中显示」目标（树组件消费后清空）

  loadTree: () => Promise<void>;
  selectFolder: (id: string | null) => void;
  toggleExpand: (id: string) => void;
  isExpanded: (id: string) => boolean;
  /** 全部折叠（书签多时快速收起导航） */
  collapseAll: () => void;
  /** 全部展开（树顶「全部展开」按钮） */
  expandAll: () => void;
  /** 折叠其他（右键菜单：只保留当前分支展开） */
  collapseOthers: (id: string) => void;
  /** 展开此分支（右键菜单：展开文件夹自身及全部子孙） */
  expandBranch: (id: string) => void;
  toggleSelect: (id: string) => void;
  /** 批量选择（键盘 Ctrl+A 全选用） */
  selectMany: (ids: string[]) => void;
  /** 整体替换多选（Shift 范围选择的收缩语义需要原子替换，而非并集） */
  replaceSelection: (ids: string[]) => void;
  clearSelection: () => void;
  /** 在树中定位：展开祖先链并选中（搜索结果/列表右键「在树中显示」） */
  revealInTree: (id: string) => void;
  setContextMenu: (menu: TreeContextMenu | null) => void;
  setSearchQuery: (q: string) => void;
}

/** UI 状态持久化 key（展开集合 + 当前文件夹） */
const UI_STORAGE_KEY = 'markai.ui';

/** 跨窗口同步标记：本窗口写入 UI 状态时置位，onChanged 据此跳过自身 */
const crossUIWrite = { current: false };
let uiSyncTimer: ReturnType<typeof setTimeout> | null = null;
/** 跨会话 UI 恢复标记：首次 loadTree 恢复上次选中，之后保留用户当前查看 */
let uiRestored = false;

/**
 * 跨窗口同步树 UI 状态：侧边栏与完整页同时打开时，展开/选中保持一致。
 * 与 aiStore 的跨窗口同步互补（那边同步聊天，这边同步书签 UI）。
 */
export function initUIWindowSync(): () => void {
  const onChanged = (
    changes: { [key: string]: chrome.storage.StorageChange },
    area: chrome.storage.AreaName,
  ) => {
    const change = changes[UI_STORAGE_KEY];
    if (area !== 'local' || !change || crossUIWrite.current) return;
    if (uiSyncTimer) clearTimeout(uiSyncTimer);
    uiSyncTimer = setTimeout(() => {
      uiSyncTimer = null;
      const saved = change.newValue as
        | { expandedIds?: string[]; selectedFolderId?: string | null }
        | undefined;
      if (!saved) return;
      useBookmarkStore.setState((s) => ({
        // 并集合并：保留本地未持久化的展开
        expandedIds: [
          ...new Set([...s.expandedIds, ...(saved.expandedIds ?? []).filter((id) => findNode(s.roots, id))]),
        ],
        selectedFolderId:
          saved.selectedFolderId && findNode(s.roots, saved.selectedFolderId)
            ? saved.selectedFolderId
            : s.selectedFolderId,
      }));
    }, 300);
  };
  chrome.storage.onChanged.addListener(onChanged);
  return () => {
    chrome.storage.onChanged.removeListener(onChanged);
    if (uiSyncTimer) {
      clearTimeout(uiSyncTimer);
      uiSyncTimer = null;
    }
  };
}

/** 防抖保存 UI 状态（展开/选中） */
let persistTimer: ReturnType<typeof setTimeout> | undefined;
function schedulePersistUI(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    const s = useBookmarkStore.getState();
    crossUIWrite.current = true;
    void chrome.storage.local
      .set({
        [UI_STORAGE_KEY]: { expandedIds: s.expandedIds, selectedFolderId: s.selectedFolderId },
      })
      .catch(() => {})
      .finally(() => {
        crossUIWrite.current = false;
      });
  }, 500);
}

export const useBookmarkStore = create<BookmarkState>((set, get) => ({
  roots: [],
  loading: false,
  loadError: null,
  selectedFolderId: null,
  expandedIds: [],
  selectedBookmarkIds: [],
  contextMenu: null,
  searchQuery: '',
  revealId: null,

  async loadTree() {
    if (get().loading) return;
    set({ loading: true, loadError: null });
    try {
      const tree = await chrome.bookmarks.getTree();
      const roots = tree[0]?.children ?? [];
      set((s) => ({
        roots,
        loading: false,
        // 首次加载默认选中书签栏，并默认展开第一个根（书签栏）
        // 已选中的文件夹若被删除（AI 删除/其他窗口）：回退到书签栏，避免中栏永久"加载中"
        selectedFolderId:
          s.selectedFolderId && findNode(roots, s.selectedFolderId)
            ? s.selectedFolderId
            : (roots[0]?.id ?? null),
        // 多选中已不存在的节点（被 AI 删除）一并清理，避免悬空多选条
        selectedBookmarkIds: s.selectedBookmarkIds.filter((id) => findNode(roots, id)),
        expandedIds: s.expandedIds.length === 0 && roots[0] ? [roots[0].id] : s.expandedIds,
      }));
      // 恢复上次的 UI 状态（节点仍存在才恢复）
      try {
        const data = await chrome.storage.local.get(UI_STORAGE_KEY);
        const saved = data[UI_STORAGE_KEY] as
          | { expandedIds?: string[]; selectedFolderId?: string | null }
          | undefined;
        if (saved) {
          const validExpanded = (saved.expandedIds ?? []).filter((id) => findNode(roots, id));
          if (validExpanded.length > 0) {
            // 并集合并：保留本地未持久化的展开（另一窗口触发刷新时用户正在展开的文件夹不被收回）
            set((s) => ({ expandedIds: [...new Set([...s.expandedIds, ...validExpanded])] }));
          }
          // 仅首次加载（跨会话恢复）时覆盖选中文件夹；刷新时保留用户当前查看
          if (!uiRestored) {
            uiRestored = true;
            if (saved.selectedFolderId && findNode(roots, saved.selectedFolderId)) {
              set({ selectedFolderId: saved.selectedFolderId });
            }
          }
        }
      } catch {
        // 忽略恢复失败
      }
    } catch (e) {
      // 树加载失败：记录原因供 UI 显示重试，不再静默空白
      console.error('[bookmarkStore] loadTree 失败:', e);
      set({ loading: false, loadError: e instanceof Error ? e.message : String(e) });
    }
  },

  selectFolder(id) {
    // 切换文件夹时清空多选（原生行为，避免跨目录残留选择）
    set({ selectedFolderId: id, searchQuery: '', selectedBookmarkIds: [] });
    schedulePersistUI();
  },

  toggleExpand(id) {
    set((s) => ({
      expandedIds: s.expandedIds.includes(id)
        ? s.expandedIds.filter((x) => x !== id)
        : [...s.expandedIds, id],
    }));
    schedulePersistUI();
  },

  isExpanded(id) {
    return get().expandedIds.includes(id);
  },

  collapseAll() {
    set({ expandedIds: [] });
    schedulePersistUI();
  },

  /** 折叠其他：只保留指定文件夹的祖先链展开（右键菜单「折叠其他」） */
  collapseOthers(id: string) {
    set((s) => {
      const keep = new Set<string>();
      let cur = findNode(s.roots, id);
      while (cur?.parentId && cur.parentId !== '0') {
        keep.add(cur.parentId);
        cur = findNode(s.roots, cur.parentId);
      }
      return { expandedIds: [...keep] };
    });
    schedulePersistUI();
  },

  /** 展开此分支：展开文件夹自身及全部子孙（右键菜单；限 500 个防卡顿） */
  expandBranch(id: string) {
    set((s) => {
      const ids = new Set<string>(s.expandedIds);
      const node = findNode(s.roots, id);
      if (!node) return {};
      // 祖先链保持展开
      let cur: BNode | null = node;
      while (cur?.parentId && cur.parentId !== '0') {
        ids.add(cur.parentId);
        cur = findNode(s.roots, cur.parentId);
      }
      let truncated = false;
      const walk = (n: BNode): boolean => {
        if (!n.children) return true;
        ids.add(n.id);
        if (ids.size > 500) {
          truncated = true;
          return false;
        }
        for (const c of n.children) {
          if (!walk(c)) return false;
        }
        return true;
      };
      walk(node);
      if (truncated) pushToast('文件夹过多，已展开前 500 个', { variant: 'default' });
      return { expandedIds: [...ids] };
    });
    schedulePersistUI();
  },

  /** 全部展开（树顶「全部展开」按钮）；超大书签库限最多展开 500 个文件夹，避免渲染卡顿 */
  expandAll() {
    const s = get();
    const ids = new Set<string>(s.expandedIds);
    let truncated = false;
    const walk = (nodes: BNode[]): boolean => {
      for (const n of nodes) {
        if (!n.children) continue;
        ids.add(n.id);
        if (ids.size > 500) {
          truncated = true;
          return false;
        }
        if (!walk(n.children)) return false;
      }
      return true;
    };
    walk(s.roots);
    set({ expandedIds: [...ids] });
    schedulePersistUI();
    if (truncated) pushToast('文件夹过多，已展开前 500 个', { variant: 'default' });
  },

  toggleSelect(id) {
    set((s) => ({
      selectedBookmarkIds: s.selectedBookmarkIds.includes(id)
        ? s.selectedBookmarkIds.filter((x) => x !== id)
        : [...s.selectedBookmarkIds, id],
    }));
  },

  selectMany(ids) {
    set((s) => ({ selectedBookmarkIds: [...new Set([...s.selectedBookmarkIds, ...ids])] }));
  },

  replaceSelection(ids) {
    set({ selectedBookmarkIds: [...ids] });
  },

  clearSelection() {
    set({ selectedBookmarkIds: [] });
  },

  revealInTree(id) {
    set((s) => {
      const node = findNode(s.roots, id);
      if (!node) return {};
      // 收集祖先链（沿 parentId 上溯到根）
      const ancestors: string[] = [];
      let cur: BNode | null = node;
      let depth = 0;
      while (cur?.parentId && cur.parentId !== '0' && depth++ < 32) {
        ancestors.unshift(cur.parentId);
        cur = findNode(s.roots, cur.parentId);
      }
      return {
        expandedIds: [...new Set([...s.expandedIds, ...ancestors])],
        // 书签定位到父文件夹；文件夹定位到自身
        selectedFolderId: node.url ? (node.parentId ?? null) : node.id,
        // 定位时清理多选（与 selectFolder 一致），避免多选条悬空
        selectedBookmarkIds: [],
        searchQuery: '',
        // 通知树组件滚动到目标节点
        revealId: id,
      };
    });
  },

  setContextMenu(menu) {
    set({ contextMenu: menu });
  },

  setSearchQuery(q) {
    // 搜索词变化时清理多选（旧选择在搜索结果中未必存在，避免悬空）；
    // 保留 selectedFolderId：清空搜索后回到原浏览文件夹，而不是掉进「请选择文件夹」空态
    set({ searchQuery: q, selectedBookmarkIds: [] });
  },
}));

/** 监听书签变更事件自动刷新树（去抖，页面级调用一次） */
export function initBookmarkListeners(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void useBookmarkStore.getState().loadTree();
    }, 300);
  };

  chrome.bookmarks.onCreated.addListener(scheduleRefresh);
  chrome.bookmarks.onRemoved.addListener(scheduleRefresh);
  chrome.bookmarks.onMoved.addListener(scheduleRefresh);
  chrome.bookmarks.onChanged.addListener(scheduleRefresh);

  return () => {
    chrome.bookmarks.onCreated.removeListener(scheduleRefresh);
    chrome.bookmarks.onRemoved.removeListener(scheduleRefresh);
    chrome.bookmarks.onMoved.removeListener(scheduleRefresh);
    chrome.bookmarks.onChanged.removeListener(scheduleRefresh);
  };
}

/** 在树中查找节点（id → 节点） */
export function findNode(nodes: BNode[], id: string): BNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children) {
      const found = findNode(n.children, id);
      if (found) return found;
    }
  }
  return null;
}

/** 解析节点完整标题路径（用于面包屑） */
export function resolveTitlePath(nodes: BNode[], id: string): string {
  const parts: string[] = [];
  const walk = (node: BNode, chain: string[]): boolean => {
    const next = [...chain, node.title || '(未命名)'];
    if (node.id === id) {
      parts.push(...next);
      return true;
    }
    for (const child of node.children ?? []) {
      if (walk(child, next)) return true;
    }
    return false;
  };
  for (const root of nodes) {
    if (walk(root, [])) break;
  }
  return parts.join(' / ') || '(未命名)';
}

/** 深拷贝节点到目标文件夹（文件夹递归复制全部子项），返回新节点 id */
export async function copyNodeDeep(
  node: BNode,
  parentId: string,
  index?: number,
): Promise<string> {
  if (node.url) {
    const created = await chrome.bookmarks.create({ parentId, title: node.title, url: node.url, index });
    return created.id;
  }
  const folder = await chrome.bookmarks.create({ parentId, title: node.title, index });
  for (const child of node.children ?? []) {
    await copyNodeDeep(child, folder.id);
  }
  return folder.id;
}
