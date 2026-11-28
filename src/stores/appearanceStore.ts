/**
 * ── 外观 store：主题预设 / 背景 / 动效强度 ──
 *
 * 与 `themeStore`（light|dark|system）分工不同：
 *  · themeStore 决定"明暗"，必须首帧同步（localStorage 镜像），否则会白闪；
 *  · appearanceStore 决定"长什么样"（强调色、背景、玻璃强度、动效），
 *    允许异步加载后平滑套用，套用方式是往 `<html>` 写 CSS 变量 + data 属性。
 *
 * 为什么用 CSS 变量而不是把颜色塞进 Tailwind 配置：
 * 变量能被子树覆盖（某块区域单独换背景），也能被"实时预览"直接改而不触发 React 重渲染。
 *
 * 落盘 key 与 AI 配置、宠物设置分开，互不影响。
 */

import { create } from 'zustand';
import { pushToast } from '@/lib/toast';

export const APPEARANCE_KEY = 'markai.appearance';

/** 强调色预设：id 稳定（落盘/测试都用 id），色值只在 CSS 里出现一次 */
export type AccentPreset = 'indigo' | 'ocean' | 'forest' | 'amber' | 'rose' | 'graphite';

/** 背景：无 / 极光渐变 / 网格 / 自定义图片 */
export type BackgroundKind = 'none' | 'aurora' | 'mesh' | 'image';

export type MotionLevel = 'full' | 'calm' | 'off';

export interface Appearance {
  accent: AccentPreset;
  background: BackgroundKind;
  /** 自定义背景图（data URL 或 https URL）；只允许 http(s)/data:image */
  backgroundImage: string;
  /** 背景压暗程度 0–100：图片背景上文字要够读，这个值直接乘进遮罩 */
  backgroundDim: number;
  /** 玻璃强度 0–100：映射到 blur / 透明度；0 = 实心（弱机省电） */
  glass: number;
  /** 动效：full = 全部；calm = 只留必要的过渡；off = 尊重无障碍，全部关闭 */
  motion: MotionLevel;
  /** 界面密度：compact 更紧凑（侧边栏默认），cozy 更松 */
  density: 'compact' | 'cozy';
}

export const APPEARANCE_DEFAULT: Appearance = {
  accent: 'indigo',
  background: 'aurora',
  backgroundImage: '',
  backgroundDim: 24,
  glass: 62,
  motion: 'full',
  density: 'compact',
};

export const ACCENT_PRESETS: { id: AccentPreset; label: string; swatch: string }[] = [
  { id: 'indigo', label: '靛蓝', swatch: '#4f46e5' },
  { id: 'ocean', label: '海蓝', swatch: '#0e7490' },
  { id: 'forest', label: '松绿', swatch: '#15803d' },
  { id: 'amber', label: '琥珀', swatch: '#b45309' },
  { id: 'rose', label: '玫瑰', swatch: '#be123c' },
  { id: 'graphite', label: '石墨', swatch: '#475569' },
];

export const BACKGROUND_OPTIONS: { id: BackgroundKind; label: string; hint: string }[] = [
  { id: 'none', label: '纯色', hint: '最省电，文字对比最稳' },
  { id: 'aurora', label: '极光', hint: '缓慢流动的柔和渐变' },
  { id: 'mesh', label: '网格', hint: '细网格，像工程图纸' },
  { id: 'image', label: '自定义图片', hint: '支持粘贴图片链接或本地上传' },
];

export const MOTION_OPTIONS: { id: MotionLevel; label: string; hint: string }[] = [
  { id: 'full', label: '完整', hint: '全部过渡与入场动画' },
  { id: 'calm', label: '克制', hint: '只保留状态变化的过渡' },
  { id: 'off', label: '关闭', hint: '不播放任何动画（也适合录屏/低配机）' },
];

/** 只接受可安全渲染的图片地址：data:image / http(s) / 扩展内资源 */
export function isSafeImageUrl(raw: string): boolean {
  const v = raw.trim();
  if (!v) return false;
  if (/^data:image\/(png|jpe?g|webp|avif|gif);base64,[a-z0-9+/=\s]+$/i.test(v)) return true;
  if (/^https?:\/\/[^\s"'<>]+$/i.test(v)) return true;
  return false;
}

/** 净化外部输入：越界/非法值一律回落默认，避免一个坏值把界面搞黑 */
export function normalizeAppearance(raw: unknown): Appearance {
  if (!raw || typeof raw !== 'object') return APPEARANCE_DEFAULT;
  const src = raw as Record<string, unknown>;
  const accent = ACCENT_PRESETS.some((p) => p.id === src.accent)
    ? (src.accent as AccentPreset)
    : APPEARANCE_DEFAULT.accent;
  const background = BACKGROUND_OPTIONS.some((o) => o.id === src.background)
    ? (src.background as BackgroundKind)
    : APPEARANCE_DEFAULT.background;
  const image = typeof src.backgroundImage === 'string' && isSafeImageUrl(src.backgroundImage)
    ? src.backgroundImage
    : '';
  const clamp = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : fallback;
  return {
    accent,
    // 选了图片却没给合法地址：回落极光，而不是留一个空背景
    background: background === 'image' && !image ? 'aurora' : background,
    backgroundImage: image,
    backgroundDim: clamp(src.backgroundDim, APPEARANCE_DEFAULT.backgroundDim),
    glass: clamp(src.glass, APPEARANCE_DEFAULT.glass),
    motion: MOTION_OPTIONS.some((o) => o.id === src.motion)
      ? (src.motion as MotionLevel)
      : APPEARANCE_DEFAULT.motion,
    density: src.density === 'cozy' ? 'cozy' : 'compact',
  };
}

/**
 * 套用到 `<html>`。
 *
 * 变量名统一 `--mk-*`：与现有 `--glass-*` / `--liquid-*` 并存，新的玻璃层读 `--mk-glass-*`，
 * 老样式不受影响——这样"外观"可以独立上线，不必等玻璃层重写完。
 */
export function applyAppearance(a: Appearance): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.accent = a.accent;
  root.dataset.background = a.background;
  root.dataset.motion = a.motion;
  root.dataset.density = a.density;
  root.style.setProperty('--mk-glass', String(a.glass / 100));
  root.style.setProperty('--mk-glass-blur', `${Math.round(6 + (a.glass / 100) * 26)}px`);
  root.style.setProperty('--mk-bg-dim', String(a.backgroundDim / 100));
  if (a.background === 'image' && a.backgroundImage) {
    root.style.setProperty('--mk-bg-image', `url("${a.backgroundImage.replace(/"/g, '%22')}")`);
  } else {
    root.style.removeProperty('--mk-bg-image');
  }
}

interface AppearanceState extends Appearance {
  loaded: boolean;
  load: () => Promise<void>;
  update: (patch: Partial<Appearance>) => Promise<void>;
  reset: () => Promise<void>;
}

export const useAppearanceStore = create<AppearanceState>((set, get) => ({
  ...APPEARANCE_DEFAULT,
  loaded: false,

  async load() {
    try {
      const data = await chrome.storage.local.get(APPEARANCE_KEY);
      const next = normalizeAppearance(data[APPEARANCE_KEY]);
      set({ ...next, loaded: true });
      applyAppearance(next);
    } catch {
      // 读不到就按默认套用：外观不该因为 storage 抖动变成裸 HTML
      set({ loaded: true });
      applyAppearance(APPEARANCE_DEFAULT);
    }
  },

  async update(patch) {
    const next = normalizeAppearance({ ...pickAppearance(get()), ...patch });
    set(next);
    applyAppearance(next);
    try {
      await chrome.storage.local.set({ [APPEARANCE_KEY]: next });
    } catch (e) {
      pushToast('外观设置没有保存成功', {
        description: `${e instanceof Error ? e.message : String(e)}；本次已生效，重开浏览器后可能恢复。`,
        variant: 'destructive',
      });
    }
  },

  async reset() {
    set(APPEARANCE_DEFAULT);
    applyAppearance(APPEARANCE_DEFAULT);
    try {
      await chrome.storage.local.set({ [APPEARANCE_KEY]: APPEARANCE_DEFAULT });
    } catch {
      /* 恢复默认失败不阻塞：下次打开会再读一次磁盘值 */
    }
  },
}));

function pickAppearance(s: Appearance): Appearance {
  return {
    accent: s.accent,
    background: s.background,
    backgroundImage: s.backgroundImage,
    backgroundDim: s.backgroundDim,
    glass: s.glass,
    motion: s.motion,
    density: s.density,
  };
}

/** 跨窗口同步：设置页改了外观，已打开的侧边栏立即跟随 */
export function initAppearanceSync(): () => void {
  const onChanged = (
    changes: { [key: string]: chrome.storage.StorageChange },
    area: chrome.storage.AreaName,
  ) => {
    if (area !== 'local' || !changes[APPEARANCE_KEY]) return;
    const next = normalizeAppearance(changes[APPEARANCE_KEY].newValue);
    useAppearanceStore.setState(next);
    applyAppearance(next);
  };
  chrome.storage.onChanged.addListener(onChanged);
  return () => chrome.storage.onChanged.removeListener(onChanged);
}
