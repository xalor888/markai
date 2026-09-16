import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  const rowLen = width * 4;
  for (let y = 0; y < height; y++) {
    raw[y * (rowLen + 1)] = 0;
    rgba.copy(raw, y * (rowLen + 1) + 1, y * rowLen, (y + 1) * rowLen);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function renderTile(width, height) {
  const buf = Buffer.alloc(width * height * 4);
  const bgR = 0x0f, bgG = 0x17, bgB = 0x2a; // Slate-900
  const accentR = 0x4f, accentG = 0x46, accentB = 0xe5; // Indigo-600
  const cx = width / 2, cy = height / 2;
  const badgeRadius = Math.min(width, height) * 0.28;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const dx = x - cx, dy = y - cy;
      const dist = Math.hypot(dx, dy);
      if (dist <= badgeRadius) {
        // Center bookmark badge
        const bookmarkW = badgeRadius * 0.5;
        const bookmarkH = badgeRadius * 0.7;
        const bx = Math.abs(dx), by = dy;
        if (bx <= bookmarkW && Math.abs(by) <= bookmarkH) {
          // Notch test at bottom
          const notchTop = bookmarkH * 0.4;
          if (by > notchTop && Math.abs(dx) <= (bookmarkW * (by - notchTop) / (bookmarkH - notchTop))) {
            buf[idx] = accentR; buf[idx + 1] = accentG; buf[idx + 2] = accentB; buf[idx + 3] = 255;
          } else {
            buf[idx] = 255; buf[idx + 1] = 255; buf[idx + 2] = 255; buf[idx + 3] = 255;
          }
        } else {
          buf[idx] = accentR; buf[idx + 1] = accentG; buf[idx + 2] = accentB; buf[idx + 3] = 255;
        }
      } else {
        // Subtle gradient background
        const grad = Math.min(1, Math.hypot(x / width - 0.5, y / height - 0.5));
        buf[idx] = Math.round(bgR * (1 - grad * 0.4));
        buf[idx + 1] = Math.round(bgG * (1 - grad * 0.4));
        buf[idx + 2] = Math.round(bgB * (1 - grad * 0.4));
        buf[idx + 3] = 255;
      }
    }
  }
  return buf;
}

const outDir = join(ROOT, 'public', 'store');
mkdirSync(outDir, { recursive: true });

const tiles = [
  { name: 'promo-small-440x280.png', w: 440, h: 280 },
  { name: 'promo-marquee-1400x560.png', w: 1400, h: 560 },
];
for (const t of tiles) {
  const png = encodePNG(t.w, t.h, renderTile(t.w, t.h));
  writeFileSync(join(outDir, t.name), png);
  console.log(`✔ ${t.name} (${t.w}x${t.h}) ${png.length} B`);
}
