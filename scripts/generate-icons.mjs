/**
 * MarkAI 插件图标生成器（纯 Node，无第三方依赖）
 *
 * 设计 v9：与 UI 品牌标（BrandMark）同一设计 —— Indigo 圆角方块 + 白色
 * lucide `BookMarked` 书签字形（书本轮廓 + 内嵌书签带燕尾缺口）。
 * 此前 v8 的「卡片 + V 缺口缎带」几何在 16px 下读不出语义，已废弃；
 * 品牌标以 UI 里用户认可的那一版为准（见 theme-provider.tsx 的 BrandMark 注释）。
 * 绘制：圆角方块走 SDF；字形按 lucide 原始路径（24 viewBox）拉直 + 胶囊描边
 * （stroke-width 2 等比放大），超采样抗锯齿。
 * 运行：node scripts/generate-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [16, 32, 48, 96, 128];

/* ── PNG 编码（RGBA 8bit） ── */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  const rowLen = width * 4;
  for (let y = 0; y < height; y++) {
    raw[y * (rowLen + 1)] = 0; // filter: none
    rgba.copy(raw, y * (rowLen + 1) + 1, y * rowLen, (y + 1) * rowLen);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ── SDF 基元（512 基准画布） ── */

/** 圆角矩形 SDF（<0 在内部） */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 点到线段距离（胶囊描边用） */
function distToSeg(px, py, a, b) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const apx = px - a[0];
  const apy = py - a[1];
  const len2 = abx * abx + aby * aby;
  const t = len2 > 0 ? Math.max(0, Math.min(1, (apx * abx + apy * aby) / len2)) : 0;
  return Math.hypot(px - (a[0] + t * abx), py - (a[1] + t * aby));
}

/* ── 圆角方块（全幅，比例对齐 UI 的 rounded-md：半径 ≈ 边长 21%） ── */
const MARGIN = 16; // 四周留 3% 安全边，避免抗锯齿边缘贴死画布
const CARD = { cx: 256, cy: 256, hw: 256 - MARGIN, hh: 256 - MARGIN, r: 104 };

const BG = [0x4f, 0x46, 0xe5]; // indigo-600（品牌 accent）
const WHITE = [0xff, 0xff, 0xff];

/* ── BookMarked 字形：lucide 原始路径（24 viewBox，stroke-width 2） ──
   path1: M4 19.5 v-15 A2.5 2.5 0 0 1 6.5 2 H20 v20 H6.5 a2.5 2.5 0 0 1 0 -5 H20
   path2: M10 2 v8 l3 -3 l3 3 V2                                              */

/** 把 SVG 弧（端点表示）拉直成折线点（512 画布坐标） */
function arcPoints(p0, p1, r, sweep, steps = 12) {
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const d = Math.hypot(dx, dy);
  const h = d / 2;
  const l = Math.sqrt(Math.max(r * r - h * h, 0));
  const mx = (p0[0] + p1[0]) / 2;
  const my = (p0[1] + p1[1]) / 2;
  // sweep=1（正角方向，y 向下屏坐标系里为顺时针）→ 圆心在弦左侧法向
  const sign = sweep === 1 ? 1 : -1;
  const cx = mx + (sign * l * -dy) / d;
  const cy = my + (sign * l * dx) / d;
  const a0 = Math.atan2(p0[1] - cy, p0[0] - cx);
  let a1 = Math.atan2(p1[1] - cy, p1[0] - cx);
  if (sweep === 1) {
    while (a1 <= a0) a1 += Math.PI * 2;
  } else {
    while (a1 >= a0) a1 -= Math.PI * 2;
  }
  const pts = [];
  for (let i = 1; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/** 构建 BookMarked 字形的全部描边线段（512 画布坐标） */
function buildGlyphSegments() {
  // lucide 24 空间 → 512 画布：内容跨 (4..20, 2..22)，居中缩放
  const S = 13; // 缩放：字形高 20×13=260，宽 16×13=208
  const T = (x, y) => [256 + (x - 12) * S, 256 + (y - 12) * S];
  const STROKE = 2 * S;

  // path1：书本轮廓
  const p = [];
  p.push(T(4, 19.5)); // M
  p.push(T(4, 4.5)); // v-15
  p.push(...arcPoints(T(4, 4.5), T(6.5, 2), 2.5 * S, 1)); // A → 右折上角
  p.push(T(20, 2)); // H20
  p.push(T(20, 22)); // v20
  p.push(T(6.5, 22)); // H6.5
  p.push(...arcPoints(T(6.5, 22), T(6.5, 17), 2.5 * S, 1)); // a → 左侧书脊回弯
  p.push(T(20, 17)); // H20

  // path2：内嵌书签（燕尾缺口）
  const q = [T(10, 2), T(10, 10), T(13, 7), T(16, 10), T(16, 2)];

  const segs = [];
  for (const line of [p, q]) {
    for (let i = 0; i < line.length - 1; i++) segs.push([line[i], line[i + 1]]);
  }
  return { segs, halfStroke: STROKE / 2 };
}

const GLYPH = buildGlyphSegments();

/** 采样一个点（512 坐标）：返回 [r,g,b,a] */
function sample(px, py) {
  // Indigo 圆角方块
  if (sdRoundRect(px, py, CARD.cx, CARD.cy, CARD.hw, CARD.hh, CARD.r) < 0) {
    // 白色 BookMarked 描边字形：任一线段的胶囊距离内即命中（round cap/join）
    for (const [a, b] of GLYPH.segs) {
      if (distToSeg(px, py, a, b) <= GLYPH.halfStroke) return [...WHITE, 255];
    }
    return [...BG, 255];
  }
  return [0, 0, 0, 0];
}

/** 渲染目标尺寸（超采样抗锯齿；小尺寸提高采样率） */
function render(size) {
  const N = size <= 32 ? 8 : 4;
  const out = Buffer.alloc(size * size * 4);
  const scale = 512 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const px = (x + (sx + 0.5) / N) * scale;
          const py = (y + (sy + 0.5) / N) * scale;
          const [sr, sg, sb, sa] = sample(px, py);
          r += sr; g += sg; b += sb; a += sa;
        }
      }
      const div = N * N;
      const i = (y * size + x) * 4;
      out[i] = Math.round(r / div);
      out[i + 1] = Math.round(g / div);
      out[i + 2] = Math.round(b / div);
      out[i + 3] = Math.round(a / div);
    }
  }
  return out;
}

/* ── 输出 ── */
const outDir = join(ROOT, 'public', 'icon');
mkdirSync(outDir, { recursive: true });
for (const size of SIZES) {
  const png = encodePNG(size, size, render(size));
  const file = join(outDir, `${size}.png`);
  writeFileSync(file, png);
  console.log(`✔ ${size}.png  ${png.length} B`);
}
console.log('完成。');
