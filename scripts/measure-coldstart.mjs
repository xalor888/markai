#!/usr/bin/env node
/**
 * 冷启动测量：从打开扩展页面到"能用的样子"，各阶段花多久。
 *
 * 为什么要这个脚本：性能相关的说法必须带数字。之前台账里挂着"冷启动预算"这一项，
 * 但一直没有实测——凭感觉说"够快"不算数。
 *
 * 三个阶段（按用户能感知的顺序）：
 *   1. topbar   顶栏出现（品牌标 / 搜索 / 更多）
 *   2. input    对话输入框出现（能开始打字）
 *   3. rows     中栏渲染出第一行书签（书签树加载完）
 *
 * 用法：
 *   node scripts/measure-coldstart.mjs [书签数] [重复次数]
 *
 * 参考基准（本机 headless Chromium 实测）：
 *   450 条  → topbar 86ms / input 82ms / rows 99ms
 *   1800 条 → topbar 164ms / input 148ms / rows 186ms
 * 基本线性，且都远低于"用户能感觉到卡"的量级（>1s）。
 */

import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const BOOKMARKS = Number(process.argv[2] ?? 450);
const RUNS = Number(process.argv[3] ?? 3);

const PORT = 9391;
const CDP = `http://127.0.0.1:${PORT}`;
const OUT = '/Users/xalor/Documents/markai/.output/chrome-mv3';
const CHROME =
  '/Users/xalor/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const EXT = 'ojlfhclcoecgjbgklbjcbcfbjjjlhjhd';
const PROFILE = `/tmp/mk-coldstart-${process.pid}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error)));
        else resolve(m.result);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout ${method}`));
        }
      }, 20000);
    });
  }
}

const child = spawn(
  CHROME,
  [
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${PROFILE}`,
    `--disable-extensions-except=${OUT}`,
    `--load-extension=${OUT}`,
    `--remote-debugging-port=${PORT}`,
    '--headless=new',
    '--window-size=1280,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const cleanup = () => {
  try {
    child.kill('SIGKILL');
  } catch {
    /* 已经退出 */
  }
  try {
    rmSync(PROFILE, { recursive: true, force: true });
  } catch {
    /* 目录不存在 */
  }
};
process.on('exit', cleanup);

async function main() {
  let ws;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`${CDP}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        break;
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  if (!ws) throw new Error('连不上 Chrome DevTools');
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const s = new Session(ws);
  await s.send('Runtime.enable');

  // 先开一次页面用于种数据
  const seedTarget = await s.send('Target.createTarget', { url: `chrome-extension://${EXT}/page.html` });
  const seedSession = (await s.send('Target.attachToTarget', { targetId: seedTarget.targetId, flatten: true })).sessionId;
  const evSeed = async (expr) => {
    const r = await s.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, seedSession);
    if (r.exceptionDetails) return null;
    return r.result?.value;
  };
  for (let i = 0; i < 100; i++) {
    if (await evSeed(`!!document.querySelector('[data-testid="topbar"]')`)) break;
    await sleep(150);
  }
  const created = await evSeed(`(async () => {
    const bar = (await chrome.bookmarks.getTree())[0].children.find((c) => c.id === '1');
    const folders = Math.max(1, Math.round(${BOOKMARKS} / 9));
    let n = 0;
    for (let i = 0; i < folders; i++) {
      const f = await chrome.bookmarks.create({ parentId: bar.id, title: 'Cold-' + i });
      for (let j = 0; j < 9 && n < ${BOOKMARKS}; j++) {
        await chrome.bookmarks.create({ parentId: f.id, title: 'b' + i + '-' + j, url: 'https://cold.example/' + i + '/' + j });
        n++;
      }
    }
    return n;
  })()`);
  console.log(`种子书签数: ${created}`);
  await s.send('Target.closeTarget', { targetId: seedTarget.targetId });
  await sleep(500);

  const runs = [];
  for (let k = 0; k < RUNS; k++) {
    const t0 = Date.now();
    const { targetId } = await s.send('Target.createTarget', { url: `chrome-extension://${EXT}/page.html` });
    const { sessionId } = await s.send('Target.attachToTarget', { targetId, flatten: true });
    const ev = async (expr) => {
      const r = await s.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) return null;
      return r.result?.value;
    };
    let topbar = 0;
    let input = 0;
    let rows = 0;
    for (let i = 0; i < 200; i++) {
      if (!topbar && (await ev(`!!document.querySelector('[data-testid="topbar"]')`))) topbar = Date.now() - t0;
      if (!input && (await ev(`!!document.querySelector('[data-testid="chat-input"]')`))) input = Date.now() - t0;
      if (!rows && (await ev(`document.querySelectorAll('[data-testid="row"]').length > 0`))) rows = Date.now() - t0;
      if (topbar && input && rows) break;
      await sleep(10);
    }
    runs.push({ topbar, input, rows });
    await s.send('Target.closeTarget', { targetId });
    await sleep(300);
  }

  const avg = (f) => Math.round(runs.reduce((a, r) => a + r[f], 0) / runs.length);
  console.log(`冷启动（${created} 条书签，${RUNS} 次）:`, JSON.stringify(runs));
  console.log(`平均: topbar=${avg('topbar')}ms 输入框=${avg('input')}ms 列表出行=${avg('rows')}ms`);
}

main()
  .then(() => {
    // WebSocket 会保活事件循环：不显式退出的话脚本跑完也不结束
    process.exit(0);
  })
  .catch((e) => {
    console.error('测量失败:', e);
    process.exit(1);
  });
