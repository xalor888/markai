/**
 * MarkAI 插件图标生成器（纯 Node，无第三方依赖）
 *
 * 设计 v8：忠实用户认可的 SVG 构图 —— 圆角外框卡片 + 内部书签（顶部平直、底部 V 缺口）
 * 品牌色化：Indigo 圆角卡片（#4f46e5）+ 白色书签（对比度保证深/浅工具栏均可见）
 * 绘制：SDF（有符号距离场）+ 超采样抗锯齿，小尺寸下依然清晰
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

/* ── SDF 几何（512 基准画布，中心 256,256；比例忠实参考 SVG viewBox 48） ── */

/** 圆角矩形 SDF（<0 在内部） */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 点是否在三角形内（同侧测试） */
function sign(p, a, b) {
  return (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]);
}
function inTriangle(p, a, b, c) {
  const d1 = sign(p, a, b);
  const d2 = sign(p, b, c);
  const d3 = sign(p, c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/* ── 几何常量（512 画布；SVG 坐标 ×10.67） ── */
// 外框卡片：SVG (8,4)-(40,44)，圆角 4
const CARD = { cx: 256, cy: 256, hw: 170.7, hh: 213.3, r: 42.7 };
// 书签（SVG）：左 (21,22) 上 (21,4)-(33,4) 右 (33,22)，V 谷 (27,15.73)
const BOOK = { x1: 224, y1: 139, x2: 352, y2: 234.7 };
const NOTCH_TRI = [
  [224, 234.7], // 左底
  [352, 234.7], // 右底
  [288, 167.8], // V 谷
];

const BG = [0x4f, 0x46, 0xe5]; // indigo-600（品牌 accent）
const WHITE = [0xff, 0xff, 0xff];

/** 采样一个点（512 坐标）：返回 [r,g,b,a] */
function sample(px, py) {
  // 外框卡片（Indigo）
  if (sdRoundRect(px, py, CARD.cx, CARD.cy, CARD.hw, CARD.hh, CARD.r) < 0) {
    // 内部书签（白色）：矩形减去底部 V 缺口
    const inRect = px >= BOOK.x1 && px <= BOOK.x2 && py >= BOOK.y1 && py <= BOOK.y2;
    const inNotch = inTriangle([px, py], NOTCH_TRI[0], NOTCH_TRI[1], NOTCH_TRI[2]);
    if (inRect && !inNotch) return [...WHITE, 255];
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
