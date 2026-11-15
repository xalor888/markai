/**
 * ── 角色几何：造型的唯一真相 ──
 *
 * 这一版把造型从"贴纸"改成"角色"：
 *  · **身体**是一块深色圆角方块（squircle，四角曲率略不对称，避免看起来像按钮）；
 *    深色身体 + 白眼的对比度是所有表情的基础，也是这套造型能做的根本原因——
 *    白眼在黑体上永远读得清，深色主题里也不会因为背景暗而糊掉。
 *  · **眼睛**是两颗大白"豆"，用**眼皮裁切**（clipPath + 盖子矩形）而不是整体缩放：
 *    缩放会把瞳孔一起压扁，裁切出来的半闭眼才像眼皮压下来（这是"活着"的关键）。
 *  · **眉毛**很克制：只在需要区分情绪时（担心 / 出错 / 在想）才显形，
 *    平时几乎透明——造型主体仍是"黑体 + 大眼睛"。
 *
 * 所有坐标写在 100×100 的视口里，缩放由外框决定；任意尺寸都锐利，零图片资源。
 * 本文件不含任何 import（可被 Node 脚本直接读取），因此可以被实时组件与
 * 表情总览图（scripts/pet-sheet.ts）共用同一份坐标。
 */
import type { MouthShape } from './mood';

/** 坐标系（正方形） */
export const PET_VIEWBOX = 100;

/**
 * 身体：圆角方块，四角曲率不同（左上更圆、右下更方）。
 * 完全对称的圆角矩形会读成"UI 按钮"，不对称才有生物感。
 */
export const PET_BODY_PATH =
  'M 50 14 C 70 14 82 21 85 34 C 87 45 87 57 84 68 C 80 80 69 87 50 87 C 31 87 20 80 16 68 C 13 57 13 45 15 34 C 18 21 30 14 50 14 Z';

/** 压扁的支点：底边中点（脚踩在地上，压扁时脚不动） */
export const PET_PIVOT_BOTTOM = 87;

/** 眼睛：中心 / 半宽 / 半高 —— 占身体宽度约 45%，这是"大眼睛"的量化口径 */
export const PET_EYES = {
  left: { x: 36, y: 46 },
  right: { x: 64, y: 46 },
  rx: 11.2,
  ry: 12.8,
  /** 瞳孔半径（基准） */
  pupil: 6.2,
  /** 高光半径（白眼上的小黑瞳孔上的一点亮，是"有神"的来源） */
  catch: 2.1,
  /** 高光相对瞳孔中心的偏移 */
  catchOffset: { x: -2.4, y: -3.2 },
} as const;

/** 眉毛（短线，绕自身中心旋转；sty 为基准高度） */
export const PET_BROWS = {
  left: { x: 36, y: 27.5 },
  right: { x: 64, y: 27.5 },
  halfWidth: 7,
  /** 眉头到眉尾的拱高（正值向上拱） */
  arch: 1.8,
  width: 2.2,
} as const;

/** 嘴：以 (50, 68) 附近为中心的一组形状（白描边，grin/oh 实心） */
export const PET_MOUTHS: Record<MouthShape, string> = {
  smile: 'M 44.5 66 Q 50 70.6 55.5 66',
  grin: 'M 43.5 65.4 Q 50 73.8 56.5 65.4 Q 50 67.9 43.5 65.4 Z',
  flat: 'M 45.5 67.4 L 54.5 67.4',
  oh: 'M 50 66.2 A 3 3 0 1 1 49.99 66.2 Z',
  wavy: 'M 44.2 67.4 Q 47.1 65 50 67.4 Q 52.9 69.8 55.8 67.4',
  frown: 'M 44 69.8 Q 50 64.4 56 69.8',
  /** 猫嘴：两个小拱 —— 得意/卖乖用它最像活物 */
  cat: 'M 43.6 67.2 Q 46.8 63.9 50.2 67.2 Q 53.6 63.9 56.4 67.2',
  sleep: 'M 46.2 67 Q 50 64.8 53.8 67',
};

/** 闭眼弧线（眼皮完全合上时替换掉眼球） */
export const PET_SLEEP_EYES = [
  { x: 36, y: 46 },
  { x: 64, y: 46 },
] as const;

/** 闭眼弧的路径（相对眼睛中心，两侧同形） */
export function closedEyeArc(cx: number, cy: number): string {
  return `M ${cx - 8} ${cy} Q ${cx} ${cy + 4.6} ${cx + 8} ${cy}`;
}

/** 腮红（贴在下眼睑外侧，不能压到眼睛：眼底在 y≈58.8） */
export const PET_BLUSH = [
  { cx: 28, cy: 64.5, rx: 6, ry: 3 },
  { cx: 72, cy: 64.5, rx: 6, ry: 3 },
] as const;

/** 眼白上缘的睫毛阴影（一条极淡的暗带，让"白眼球"不至于像贴纸） */
export const PET_LASH = { height: 6, opacity: 0.1 } as const;

/** 地面阴影 */
export const PET_SHADOW = { cx: 50, cy: 92.5, rx: 26, ry: 4.6 } as const;

/** 高光（左上掠射的那块柔和亮面） */
export const PET_SHEEN = { cx: 33, cy: 24.5, rx: 15, ry: 8, rotate: -16 } as const;

/**
 * 特效几何：全部贴在**轮廓之外**（压在身上会读成疤），尺寸按"缩到 56px 仍能认出符号"定。
 */
export const PET_FX = {
  sparkles: [
    { x: 18, y: 22 },
    { x: 82, y: 18 },
    { x: 12, y: 52 },
    { x: 88, y: 50 },
  ],
  zzz: [
    { x: 78, y: 26, s: 9 },
    { x: 86, y: 16, s: 6.2 },
    { x: 92, y: 8, s: 4.2 },
  ],
  sweat: 'M 87 20 C 83.4 25.6 81.8 28.4 81.8 31.4 A 5.2 5.2 0 0 0 92.2 31.4 C 92.2 28.4 90.6 25.6 87 20 Z',
  question: {
    path: 'M 84 12 A 5.4 5.4 0 1 1 89.4 17.4 C 89.4 21 84 21 84 24',
    dot: { cx: 84, cy: 27.4, r: 1.8 },
  },
  bang: {
    rect: { x: 79.5, y: 6.5, w: 4.6, h: 12, rx: 2.3 },
    dot: { cx: 81.8, cy: 23, r: 2.1 },
  },
  dots: [
    { x: 40, y: 12 },
    { x: 50, y: 9 },
    { x: 60, y: 12 },
  ],
  ring: { cx: 50, cy: 52, r: 43 },
} as const;

/**
 * 两套配色。
 *
 * 身体在两套主题里都是深色（这是造型的前提），差别在**边缘**：
 * 浅色背景上靠自身的高光与投影分开，深色背景上再加一圈极淡的 rim 才不糊进背景。
 */
export interface PetPalette {
  bodyTop: string;
  bodyBottom: string;
  rim: string;
  sheen: string;
  eye: string;
  pupil: string;
  catch: string;
  mouth: string;
  brow: string;
  blush: string;
  fx: string;
  alert: string;
  ring: string;
  shadow: string;
  /** 眼皮盖子的填充（跟身体同色系，userSpaceOnUse 渐变下与身体完全对齐） */
  lidTop: string;
  lidBottom: string;
}

export const PET_PALETTES: Record<'light' | 'dark', PetPalette> = {
  light: {
    bodyTop: '#15181f',
    bodyBottom: '#2b3242',
    rim: 'rgb(255 255 255 / 0.10)',
    sheen: 'rgb(255 255 255 / 0.07)',
    eye: '#fbfcfe',
    pupil: '#0a0c11',
    catch: '#ffffff',
    mouth: '#fbfcfe',
    brow: '#fbfcfe',
    blush: 'rgb(255 255 255 / 0.10)',
    fx: '#4f46e5',
    alert: '#e5484d',
    ring: 'rgb(79 70 229 / 0.4)',
    shadow: 'rgb(16 24 40 / 0.16)',
    lidTop: '#15181f',
    lidBottom: '#2b3242',
  },
  dark: {
    bodyTop: '#1a1f2a',
    bodyBottom: '#333c4e',
    rim: 'rgb(255 255 255 / 0.16)',
    sheen: 'rgb(255 255 255 / 0.09)',
    eye: '#f7f9fd',
    pupil: '#07090d',
    catch: '#ffffff',
    mouth: '#f7f9fd',
    brow: '#f7f9fd',
    blush: 'rgb(255 255 255 / 0.12)',
    fx: '#a5b4fc',
    alert: '#fda29b',
    ring: 'rgb(165 180 252 / 0.45)',
    shadow: 'rgb(0 0 0 / 0.55)',
    lidTop: '#1a1f2a',
    lidBottom: '#333c4e',
  },
};
