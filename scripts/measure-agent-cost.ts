/**
 * ── Agent 成本基线（离线测量） ──
 *
 * 为什么先测量再优化：项目规矩是"没有数字的优化不做"。
 * 这个脚本不联网、不调用任何 API，只把**每一轮请求必然携带的固定开销**
 * 和上下文预算的实际占用算出来，给后续优化一个可对比的基线。
 *
 * 用法：npx tsx scripts/measure-agent-cost.ts
 */

import { estimateRequestTokens, estimateTokens } from '../src/lib/ai/agent';
import { PLAN_MODE_INSTRUCTION, SYSTEM_PROMPT, TOOL_DEFINITIONS } from '../src/lib/ai/prompts';
import { effectiveContextWindow, getModelContextWindow } from '../src/lib/providers';
import type { ApiMessage } from '../src/lib/ai/client';

const fmt = (n: number): string => n.toLocaleString('zh-CN');
const pct = (part: number, whole: number): string => `${((part / whole) * 100).toFixed(1)}%`;

const systemTokens = estimateTokens(SYSTEM_PROMPT);
const planTokens = estimateTokens(PLAN_MODE_INSTRUCTION);
const toolTokens = estimateTokens(JSON.stringify(TOOL_DEFINITIONS));

console.log('\nMarkAI Agent 成本基线（离线测量 · 不调用任何 API）');
console.log('─'.repeat(58));

console.log('\n【固定开销】每轮请求都要带，与对话长短无关');
console.log(`  系统提示词        ${fmt(systemTokens).padStart(6)} tok`);
console.log(`  计划模式说明      ${fmt(planTokens).padStart(6)} tok（仅 planMode 开启时）`);
console.log(`  工具定义 ${TOOL_DEFINITIONS.length} 个   ${fmt(toolTokens).padStart(6)} tok  ← 占比最大`);
const fixed = systemTokens + toolTokens;
console.log(`  小计（不含记忆）  ${fmt(fixed).padStart(6)} tok`);

console.log('\n【工具定义成本排名】（前 8，按描述+schema 估算）');
const perTool = TOOL_DEFINITIONS.map((t) => ({
  name: t.function.name,
  tokens: estimateTokens(JSON.stringify(t)),
}));
perTool.sort((a, b) => b.tokens - a.tokens);
for (const t of perTool.slice(0, 8)) {
  console.log(`  ${t.name.padEnd(22)} ${fmt(t.tokens).padStart(5)} tok  (${pct(t.tokens, toolTokens)})`);
}
console.log(`  平均每工具             ${fmt(Math.round(toolTokens / TOOL_DEFINITIONS.length))} tok`);

console.log('\n【上下文预算】window × compressThreshold(0.8) − 固定开销 = 历史可用');
for (const [label, model] of [
  ['128K（DeepSeek/GLM）', 'deepseek-v4-pro'],
  ['256K（Kimi）', 'kimi-k3'],
  ['1M（GPT-5.6）', 'gpt-5.6'],
] as const) {
  const window = getModelContextWindow(model);
  const budget = effectiveContextWindow(model, null);
  const usable = Math.max(0, Math.round(budget * 0.8) - fixed);
  console.log(
    `  ${label.padEnd(20)} 窗口 ${fmt(window).padStart(7)} → 预算 ${fmt(budget).padStart(7)}，` +
      `固定开销占 ${pct(fixed, budget).padStart(6)}，历史可用 ${fmt(usable)} tok`,
  );
}

// 用一条代表性的历史（含一次工具往返）测"每条消息的真实成本"
const sampleTurn: ApiMessage[] = [
  { role: 'user', content: '把我收藏夹里所有关于「Rust 异步」的文章整理到一个子文件夹里，太旧的删掉。' },
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'search_bookmarks', arguments: '{"query":"Rust 异步","limit":50}' },
      },
    ],
  },
  {
    role: 'tool',
    tool_call_id: 'call_1',
    content: JSON.stringify(
      Array.from({ length: 12 }, (_, i) => ({
        id: String(i + 1),
        title: `Rust 异步编程实践 ${i + 1}`,
        url: `https://example.com/rust-async-${i + 1}`,
      })),
    ),
  },
];
const turnTokens = estimateRequestTokens(sampleTurn) - toolTokens;
console.log('\n【一次工具往返的成本】用户消息 + 工具调用 + 12 条结果');
console.log(`  合计 ${fmt(turnTokens)} tok（其中工具结果本身 ${fmt(estimateTokens(sampleTurn[2]!.content ?? ''))} tok）`);

const window = getModelContextWindow('deepseek-v4-pro');
const usable = Math.round(window * 0.8) - fixed;
console.log(
  `  这样的一轮在 128K 预算里装得下约 ${Math.floor(usable / turnTokens)} 轮（含系统提示词与工具定义）`,
);

console.log('\n【结论】');
const toolShare = (toolTokens / (toolTokens + systemTokens)) * 100;
console.log(`  · 固定开销的大头是工具定义：占总固定开销 ${toolShare.toFixed(0)}%`);
console.log(`  · 工具定义平均 ${fmt(Math.round(toolTokens / TOOL_DEFINITIONS.length))} tok/个，描述越啰嗦越贵——每轮都付一次`);
console.log(`  · 128K 模型上固定开销占预算 ${pct(fixed, Math.round(window * 0.8))}，压缩阈值触发前只剩 ${fmt(usable)} tok`);
console.log('  · 优化方向（按收益）：①压缩工具描述 ②并行只读工具减少往返 ③工具结果裁剪\n');
