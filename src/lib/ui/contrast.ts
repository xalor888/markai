/**
 * ── WCAG 对比度计算（纯函数） ──
 *
 * 为什么需要它：玻璃层是**半透明**的，文字实际压在一个"玻璃叠在底板上"的合成色上。
 * 只看 token 里的前景/背景两色算对比度是不够的——半透明会让实际背景变亮或变暗，
 * 而小字号（11–12px）最怕这个。项目里已经出过一次同类事故（深色 accent 只有 4.0:1）。
 *
 * 这里只做数学，不读文件：token 由测试从 main.css 解析出来再喂进来，
 * 于是"改了 token 忘了对比度"会当场转红。
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** `#rrggbb` → Rgb（项目 token 全是这种格式） */
export function parseHex(hex: string): Rgb {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m?.[1]) throw new Error(`不是 #rrggbb 颜色：${hex}`);
  const n = m[1];
  return {
    r: parseInt(n.slice(0, 2), 16),
    g: parseInt(n.slice(2, 4), 16),
    b: parseInt(n.slice(4, 6), 16),
  };
}

/**
 * 解析 CSS 颜色：支持 `#rrggbb` 与 `rgb(255 255 255 / 0.72)` 两种写法。
 * 后者是 main.css 里 glass token 的实际格式。
 */
export function parseCssColor(value: string): { rgb: Rgb; alpha: number } {
  const v = value.trim();
  const hex = /^#[0-9a-f]{6}$/i;
  if (hex.test(v)) return { rgb: parseHex(v), alpha: 1 };
  const fn = /^rgba?\(\s*(\d+)\s*(\d+)\s*(\d+)\s*(?:\/\s*([\d.]+)|,\s*([\d.]+))?\s*\)$/.exec(v);
  if (fn) {
    const alphaRaw = fn[4] ?? fn[5];
    return {
      rgb: { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]) },
      alpha: alphaRaw === undefined ? 1 : Number(alphaRaw),
    };
  }
  throw new Error(`无法解析颜色：${value}`);
}

/** 相对亮度（WCAG 2.1 定义） */
export function relativeLuminance(c: Rgb): number {
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** 对比度（1–21）；参数顺序无所谓 */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** 半透明前景叠在不透明背景上得到的实际颜色（简单 alpha 合成） */
export function composite(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  const a = Math.min(Math.max(alpha, 0), 1);
  return {
    r: Math.round(fg.r * a + bg.r * (1 - a)),
    g: Math.round(fg.g * a + bg.g * (1 - a)),
    b: Math.round(fg.b * a + bg.b * (1 - a)),
  };
}

/** 正文与次要文字的 AA 门槛（小字号一律按正文标准，不给豁免） */
export const AA_NORMAL = 4.5;
