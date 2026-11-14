/**
 * 液态玻璃（Liquid Glass）核心：用 SVG 位移滤镜做「真折射」。
 *
 * 原理：把圆角矩形的 SDF 法线编码成一张位移图（R/G 通道，128 为原点），
 * 通过 `backdrop-filter: url(#filter)` 让 Chromium 在合成阶段对**背景**做弯折，
 * 再叠加普通的 blur/saturate。位移只发生在边缘的 bezel 带里，中心保持平整，
 * 所以文字仍然可读，视觉上却像一块有厚度的玻璃。
 *
 * 边界（有意为之）：
 * - 只有 Chromium 支持 `backdrop-filter: url()`；Firefox / Safari 会忽略整条声明，
 *   所以调用方必须先过 supportsLiquidGlass()，否则会拿到「没有模糊」的半成品。
 * - WebGL/WebGPU 常驻渲染在侧边栏里代价过高，这里只用一次性的 SVG 滤镜。
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFS_ID = 'markai-liquid-defs';
const MAP_RESOLUTION_CAP = 320;
const MAP_CACHE_LIMIT = 16;

export type LiquidGlassOptions = {
  /** 发生折射的边缘带宽度（px）。面板越小越窄；6–8 是 MarkAI 这个密度的上限。 */
  bezel?: number;
  /** 最大位移量（px）。 */
  scale?: number;
  /** 三通道色散幅度（px）。0 表示单次位移（更便宜，文字面板用这个）。 */
  aberration?: number;
};

export const LIQUID_GLASS_DEFAULTS: Required<LiquidGlassOptions> = {
  bezel: 7,
  scale: 6,
  aberration: 0,
};

let supportCache: boolean | null = null;

/** 运行时检测：`@supports (backdrop-filter: blur(1px))` 在 Firefox 也为真，不能只靠它。 */
export function supportsLiquidGlass(): boolean {
  if (supportCache !== null) return supportCache;
  supportCache =
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function' &&
    CSS.supports('backdrop-filter', `url(#${DEFS_ID}-probe)`);
  return supportCache;
}

function roundedRectSdf(x: number, y: number, w: number, h: number, r: number): number {
  const hw = w / 2;
  const hh = h / 2;
  const qx = Math.abs(x - hw) - hw + r;
  const qy = Math.abs(y - hh) - hh + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

const mapCache = new Map<string, string>();

/**
 * 生成位移图。半分辨率足够：feImage 会双线性放大，边缘反而更平滑，
 * 而 CPU 成本从 ~9ms（640×420）降到 ~1ms。
 */
function displacementMap(width: number, height: number, radius: number, bezel: number): string | null {
  const key = `${width}|${height}|${radius}|${bezel}`;
  const cached = mapCache.get(key);
  if (cached) return cached;

  const ratio = Math.min(1, MAP_RESOLUTION_CAP / Math.max(width, height));
  const mw = Math.max(8, Math.round(width * ratio));
  const mh = Math.max(8, Math.round(height * ratio));
  const mr = Math.min(radius * ratio, Math.min(mw, mh) / 2);
  const mb = Math.min(Math.max(bezel * ratio, 1), Math.min(mw, mh) / 2);

  const canvas = document.createElement('canvas');
  canvas.width = mw;
  canvas.height = mh;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const image = ctx.createImageData(mw, mh);
  const data = image.data;

  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      const sdf = roundedRectSdf(x + 0.5, y + 0.5, mw, mh, mr);
      let nx = 0;
      let ny = 0;
      if (sdf < 0) {
        const e = 0.8;
        const gx =
          roundedRectSdf(x + 0.5 + e, y + 0.5, mw, mh, mr) -
          roundedRectSdf(x + 0.5 - e, y + 0.5, mw, mh, mr);
        const gy =
          roundedRectSdf(x + 0.5, y + 0.5 + e, mw, mh, mr) -
          roundedRectSdf(x + 0.5, y + 0.5 - e, mw, mh, mr);
        const len = Math.hypot(gx, gy) || 1;
        nx = gx / len;
        ny = gy / len;
      }
      // 0 = 内侧平面，1 = 边缘；smoothstep 让过渡没有折线
      const t = Math.min(1, Math.max(0, -sdf / mb));
      const k = t * t * (3 - 2 * t);
      const i = (y * mw + x) * 4;
      data[i] = Math.round(128 - nx * k * 127);
      data[i + 1] = Math.round(128 - ny * k * 127);
      data[i + 2] = 128;
      data[i + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);
  const url = canvas.toDataURL();
  if (mapCache.size >= MAP_CACHE_LIMIT) {
    const oldest = mapCache.keys().next().value;
    if (oldest !== undefined) mapCache.delete(oldest);
  }
  mapCache.set(key, url);
  return url;
}

function ensureDefs(): SVGSVGElement {
  const existing = document.getElementById(DEFS_ID);
  if (existing instanceof SVGSVGElement) return existing;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.id = DEFS_ID;
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'position:fixed;width:0;height:0;overflow:hidden;pointer-events:none';
  document.body.appendChild(svg);
  return svg;
}

const CHANNELS: Array<[string, string]> = [
  ['r', '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0'],
  ['g', '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0'],
  ['b', '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0'],
];

function buildFilter(id: string, map: string, width: number, height: number, options: Required<LiquidGlassOptions>): SVGFilterElement {
  const filter = document.createElementNS(SVG_NS, 'filter');
  filter.setAttribute('id', id);
  filter.setAttribute('x', '0%');
  filter.setAttribute('y', '0%');
  filter.setAttribute('width', '100%');
  filter.setAttribute('height', '100%');
  filter.setAttribute('color-interpolation-filters', 'sRGB');

  const feImage = document.createElementNS(SVG_NS, 'feImage');
  feImage.setAttribute('href', map);
  feImage.setAttribute('x', '0');
  feImage.setAttribute('y', '0');
  feImage.setAttribute('width', String(width));
  feImage.setAttribute('height', String(height));
  feImage.setAttribute('preserveAspectRatio', 'none');
  feImage.setAttribute('result', 'map');
  filter.appendChild(feImage);

  const { scale, aberration } = options;

  if (aberration <= 0) {
    // 单次位移：颜色原样通过，最省
    const displacement = document.createElementNS(SVG_NS, 'feDisplacementMap');
    displacement.setAttribute('in', 'SourceGraphic');
    displacement.setAttribute('in2', 'map');
    displacement.setAttribute('scale', String(scale));
    displacement.setAttribute('xChannelSelector', 'R');
    displacement.setAttribute('yChannelSelector', 'G');
    filter.appendChild(displacement);
    return filter;
  }

  // 三通道不同位移量 → 边缘色散。务必用 feBlend(screen) 合回全彩，
  // 否则滤镜最后只剩一条通道，整块面板会变成纯蓝/纯红。
  CHANNELS.forEach(([channel, matrix], index) => {
    const displacement = document.createElementNS(SVG_NS, 'feDisplacementMap');
    displacement.setAttribute('in', 'SourceGraphic');
    displacement.setAttribute('in2', 'map');
    displacement.setAttribute('scale', String(scale - index * aberration));
    displacement.setAttribute('xChannelSelector', 'R');
    displacement.setAttribute('yChannelSelector', 'G');
    displacement.setAttribute('result', `d${channel}`);
    filter.appendChild(displacement);

    const colorMatrix = document.createElementNS(SVG_NS, 'feColorMatrix');
    colorMatrix.setAttribute('in', `d${channel}`);
    colorMatrix.setAttribute('type', 'matrix');
    colorMatrix.setAttribute('values', matrix);
    colorMatrix.setAttribute('result', channel);
    filter.appendChild(colorMatrix);
  });

  const blendRg = document.createElementNS(SVG_NS, 'feBlend');
  blendRg.setAttribute('in', 'r');
  blendRg.setAttribute('in2', 'g');
  blendRg.setAttribute('mode', 'screen');
  blendRg.setAttribute('result', 'rg');
  filter.appendChild(blendRg);

  const blendRgb = document.createElementNS(SVG_NS, 'feBlend');
  blendRgb.setAttribute('in', 'rg');
  blendRgb.setAttribute('in2', 'b');
  blendRgb.setAttribute('mode', 'screen');
  filter.appendChild(blendRgb);

  return filter;
}

/**
 * 为一个元素安装折射滤镜，并把 `--liquid-filter` 写到它身上。
 * 返回 false 表示当前环境不支持，或元素还没有尺寸（隐藏中）。
 */
export function applyLiquidFilter(
  el: HTMLElement,
  id: string,
  options: LiquidGlassOptions = {},
): boolean {
  if (!supportsLiquidGlass()) return false;
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  if (width < 8 || height < 8) return false;

  const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 8;
  const resolved: Required<LiquidGlassOptions> = {
    ...LIQUID_GLASS_DEFAULTS,
    ...options,
  };
  const map = displacementMap(width, height, radius, resolved.bezel);
  if (!map) return false;

  const defs = ensureDefs();
  document.getElementById(id)?.remove();
  defs.appendChild(buildFilter(id, map, width, height, resolved));
  el.style.setProperty('--liquid-filter', `url(#${id})`);
  return true;
}

/** 卸载：连同空掉的 defs 容器一起清掉，避免 DOM 里留垃圾。 */
export function resetLiquidFilter(el: HTMLElement, id: string): void {
  document.getElementById(id)?.remove();
  el.style.removeProperty('--liquid-filter');
  const defs = document.getElementById(DEFS_ID);
  if (defs && defs.childElementCount === 0) defs.remove();
}
