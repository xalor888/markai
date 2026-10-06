/** ── 长期记忆 Zustand Store ── */

import { create } from 'zustand';
import {
  MEMORY_STORAGE_KEY,
  addMemoryItem,
  clearAllMemories,
  deleteMemoryItem,
  getMemories,
  toggleMemoryItem,
  updateMemoryItem,
  type MemoryCategory,
  type MemoryItem,
} from '@/lib/ai/memory';

interface MemoryState {
  memories: MemoryItem[];
  loaded: boolean;
  searchQuery: string;

  load: () => Promise<void>;
  add: (content: string, category?: MemoryCategory) => Promise<MemoryItem>;
  update: (id: string, patch: Partial<Omit<MemoryItem, 'id' | 'createdAt'>>) => Promise<MemoryItem | null>;
  remove: (id: string) => Promise<boolean>;
  toggle: (id: string) => Promise<MemoryItem | null>;
  clear: () => Promise<void>;
  setSearchQuery: (query: string) => void;
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  memories: [],
  loaded: false,
  searchQuery: '',

  async load() {
    try {
      const list = await getMemories();
      set({ memories: list, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  async add(content, category = 'preference') {
    const item = await addMemoryItem(content, category);
    await get().load();
    return item;
  },

  async update(id, patch) {
    const updated = await updateMemoryItem(id, patch);
    if (updated) {
      set((state) => ({
        memories: state.memories.map((m) => (m.id === id ? updated : m)),
      }));
    }
    return updated;
  },

  async remove(id) {
    const ok = await deleteMemoryItem(id);
    if (ok) {
      set((state) => ({
        memories: state.memories.filter((m) => m.id !== id),
      }));
    }
    return ok;
  },

  async toggle(id) {
    const updated = await toggleMemoryItem(id);
    if (updated) {
      set((state) => ({
        memories: state.memories.map((m) => (m.id === id ? updated : m)),
      }));
    }
    return updated;
  },

  async clear() {
    await clearAllMemories();
    set({ memories: [] });
  },

  setSearchQuery(searchQuery) {
    set({ searchQuery });
  },
}));

/** 跨上下文/跨窗口存储同步监听 */
export function initMemorySync(): () => void {
  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) {
    return () => {};
  }

  const listener = (
    changes: { [key: string]: chrome.storage.StorageChange },
    area: chrome.storage.AreaName,
  ) => {
    if (area === 'local' && changes[MEMORY_STORAGE_KEY]) {
      void useMemoryStore.getState().load();
    }
  };

  chrome.storage.onChanged.addListener(listener);
  return () => {
    chrome.storage.onChanged.removeListener(listener);
  };
}
