/**
 * ── 生成「心情总览」页（配图用） ──
 *
 * 用法：npx tsx scripts/pet-sheet.ts [输出目录]
 * 产物：
 *   <dir>/pet-sheet-light.html
 *   <dir>/pet-sheet-dark.html
 *
 * 为什么是 HTML 而不是直接出 PNG：截图交给浏览器（CDP）完成——
 * 这样出图用的就是页面同一套渲染器（字体、抗锯齿、暗色主题全一致），
 * 不需要在 CI 里塞一套 SVG→PNG 的依赖。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { renderPetSheet } from '../src/lib/pet/sheet';

const outDir = resolve(process.argv[2] ?? '.output/pet-sheet');
mkdirSync(outDir, { recursive: true });

const light = resolve(outDir, 'pet-sheet-light.html');
const dark = resolve(outDir, 'pet-sheet-dark.html');
writeFileSync(light, renderPetSheet({ dark: false }), 'utf8');
writeFileSync(dark, renderPetSheet({ dark: true }), 'utf8');

console.log(`✔ ${light}`);
console.log(`✔ ${dark}`);
console.log(`  （目录 ${dirname(light)}）`);
