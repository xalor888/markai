/**
 * ── 窄面板密度基线（离线，不渲染） ──
 *
 * 侧边栏是常驻窄面板（360–420px 宽）。用户最常做的事是"翻书签"，
 * 所以"一屏能看多少行"直接决定观感与效率。
 *
 * 这个脚本从**源码**解析出行高（不硬编码），算不同面板高度下的可见行数，
 * 给"要不要调密度"一个可对比的依据——而不是凭感觉改间距。
 *
 * 用法：npx tsx scripts/measure-density.ts
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = readFileSync(resolve(process.cwd(), 'src/components/bookmark-list/bookmark-list.tsx'), 'utf8');

// 行容器：'group relative flex h-10 cursor-pointer ...'
const row = /'group relative flex h-(\d+(?:\.\d+)?) cursor-pointer/.exec(src);
if (!row?.[1]) throw new Error('没解析出行高（BookmarkRow 的容器 class 变了？）');
const rowUnits = Number(row[1]);
const ROW_PX = rowUnits * 4; // Tailwind 1 unit = 4px

// 顶部固定区（顶栏 + 搜索/筛选 + 列表内边距 p-2）
const HEADER_PX = 150;

console.log('\n窄面板密度基线（离线计算，按源码行高）');
console.log('─'.repeat(56));
console.log(`  行高 h-${rowUnits} = ${ROW_PX}px（含 16px favicon / 复选框 / 两行文字）`);
console.log(`  顶部固定区约 ${HEADER_PX}px（顶栏 + 搜索 + 列表内边距，估算）\n`);

console.log('【一屏可见行数】');
for (const h of [600, 700, 800, 900, 1000]) {
  const usable = h - HEADER_PX;
  const rows = Math.floor(Math.max(0, usable) / ROW_PX);
  console.log(`  面板高 ${String(h).padStart(4)}px → 可用 ${String(usable).padStart(4)}px → ${rows} 行`);
}

console.log('\n【如果改行高】（同一 800px 面板）');
for (const alt of [32, 36, 40, 44]) {
  const rows = Math.floor((800 - HEADER_PX) / alt);
  const mark = alt === ROW_PX ? ' ← 当前' : '';
  console.log(`  h-${alt / 4} (${alt}px) → ${rows} 行${mark}`);
}

console.log('\n【结论】');
console.log(`  · 当前 ${ROW_PX}px/行：800px 面板约 ${Math.floor((800 - HEADER_PX) / ROW_PX)} 行，是桌面端的舒适值`);
console.log('  · 低于 32px 会低于可点击区底线（触控/精细鼠标都不稳），高于 44px 一屏太少');
console.log('  · 结论：不调行高。要提升"信息密度"应该靠折叠/分组，而不是把行压扁\n');
