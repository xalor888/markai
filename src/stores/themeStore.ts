/** ── 主题 store（light / dark / system，持久化到 chrome.storage.local） ── */

import { create } from 'zustand';

export type Theme = 'light' | 'dark' | 'system';

const THEME_KEY = 'markai.theme';

interface ThemeState {
  theme: Theme;
  load: () => Promise<void>;
  setTheme: (t: Theme) => Promise<void>;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: 'system',

  async load() {
    try {
      const data = await chrome.storage.local.get(THEME_KEY);
      const saved = data[THEME_KEY] as Theme | undefined;
      set({ theme: saved ?? 'system' });
      applyTheme(saved ?? 'system');
    } catch {
      set({ theme: 'system' });
      applyTheme('system');
    }
  },

  async setTheme(t) {
    try {
      await chrome.storage.local.set({ [THEME_KEY]: t });
    } catch {
      // 持久化失败不影响本次切换
    }
    set({ theme: t });
    applyTheme(t);
  },
}));

/** 解析最终主题并应用到 <html> 的 .dark class */
export function applyTheme(theme: Theme): void {
  const isDark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', isDark);
}

/** 监听系统主题变化（system 模式时实时跟随） */
export function watchSystemTheme(): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const listener = () => {
    if (useThemeStore.getState().theme === 'system') applyTheme('system');
  };
  mq.addEventListener('change', listener);
  return () => mq.removeEventListener('change', listener);
}

/**
 * 跨窗口主题同步：任一窗口切换主题后，其他窗口立即跟随。
 * 自身写入通过 storage.set 后的状态判断跳过（避免循环）。
 */
export function initThemeSync(): () => void {
  const onChanged = (
    changes: { [key: string]: chrome.storage.StorageChange },
    area: chrome.storage.AreaName,
  ) => {
    if (area !== 'local' || !changes[THEME_KEY]) return;
    const next = changes[THEME_KEY].newValue as Theme | undefined;
    if (!next || next === useThemeStore.getState().theme) return;
    useThemeStore.setState({ theme: next });
    applyTheme(next);
  };
  chrome.storage.onChanged.addListener(onChanged);
  return () => chrome.storage.onChanged.removeListener(onChanged);
}
