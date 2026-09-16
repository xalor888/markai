/** ── 主题 store（light / dark / system，持久化到 chrome.storage.local） ── */

import { create } from 'zustand';

import { pushToast } from '@/lib/toast';

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
    } catch (e) {
      set({ theme: 'system' });
      applyTheme('system');
      pushToast('无法读取主题设置', {
        description: `${e instanceof Error ? e.message : String(e)}；已临时使用系统默认主题。`,
        variant: 'destructive',
      });
    }
  },

  async setTheme(t) {
    try {
      await chrome.storage.local.set({ [THEME_KEY]: t });
    } catch (e) {
      // 本次切换照常生效（不卡界面），但**不能静默丢弃设置**：
      // 与设置页同一标准——保存失败要让用户知道，否则重启后主题"自己变回去了"。
      pushToast('主题设置没有保存成功', {
        description: `${e instanceof Error ? e.message : String(e)}；本次切换已生效，但重开浏览器后可能回到原来的主题。`,
        variant: 'destructive',
      });
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
