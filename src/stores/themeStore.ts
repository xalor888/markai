/** ── 主题 store（light / dark / system，持久化到 chrome.storage.local） ── */

import { create } from 'zustand';

import { pushToast } from '@/lib/toast';

export type Theme = 'light' | 'dark' | 'system';

export const THEME_KEY = 'markai.theme';

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
      const t = saved ?? 'system';
      set({ theme: t });
      applyTheme(t);
      mirrorTheme(t);
    } catch (e) {
      const t: Theme = 'system';
      set({ theme: t });
      applyTheme(t);
      mirrorTheme(t);
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
    mirrorTheme(t);
  },
}));

/**
 * 首帧该不该是暗的（纯函数，方便单测）。
 *
 * 优先级：**用户显式选过** > 系统偏好。之前入口只看系统偏好，
 * 于是"系统深色但用户选了浅色"的人每次打开都会先看到一帧深色，然后才被 load() 纠正。
 */
export function shouldStartDark(saved: string | null, systemPrefersDark: boolean): boolean {
  if (saved === 'dark') return true;
  if (saved === 'light') return false;
  return systemPrefersDark;
}

/** 把用户选择镜像进 localStorage：它同步可读，首帧就能拿到（chrome.storage 只能异步读） */
function mirrorTheme(t: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* 隐私模式下写不进去不影响功能，只是首帧会退回系统偏好 */
  }
}

/**
 * 在模块求值阶段（React 渲染之前）就把主题应用好。
 *
 * 四个入口都调它。读取顺序：localStorage（同步）→ 系统偏好。
 */
export function preapplyTheme(): void {
  if (typeof document === 'undefined' || typeof localStorage === 'undefined') return;
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    saved = null;
  }
  const systemDark =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.toggle('dark', shouldStartDark(saved, systemDark));
}

/**
 * 模块加载时先按「系统」应用一次。
 *
 * `load()` 是异步的（要读 storage），而 React 的第一帧在它回来之前就画了。
 * 若不做这一次同步应用，`<html>` 上还没有 `.dark`——深色系统的用户
 * **每次打开侧边栏/设置页都会先白一下**，然后才变暗。
 */
preapplyTheme();

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
