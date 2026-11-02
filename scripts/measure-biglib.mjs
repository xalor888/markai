#!/usr/bin/env node
/**
 * 大库热点测量：`flattenBookmarks` / `collectFolderOptions` / 健康检查 / `search({})`。
 *
 * 为什么要这个脚本：台账里"5000 条库的耗时基线"这一项一直没有实测。
 * 这几个函数都在**主线程同步跑**（时间线、移动选择器、健康检查），
 * 书签多了之后直接决定界面卡不卡——必须带数字，不能凭感觉。
 *
 * 用法：
 *   node scripts/measure-biglib.mjs [书签数] [重复次数]
 */

import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const BOOKMARKS = Number(process.argv[2] ?? 5000);
const RUNS = Number(process.argv[3] ?? 3);

const PORT = 9393;
const CDP = `http://127.0.0.1:${PORT}`;
const OUT = '/Users/xalor/Documents/markai/.output/chrome-mv3';
const CHROME =
  '/Users/xalor/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const EXT = 'ojlfhclcoecgjbgklbjcbcfbjjjlhjhd';
const PROFILE = `/tmp/mk-biglib-${process.pid}`;

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
      }, 60000);
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
  } catch {}
  try {
    rmSync(PROFILE, { recursive: true, force: true });
  } catch {}
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
    } catch {}
    await sleep(250);
  }
  if (!ws) throw new Error('连不上 Chrome DevTools');
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const s = new Session(ws);
  await s.send('Runtime.enable');

  const { targetId } = await s.send('Target.createTarget', { url: `chrome-extension://${EXT}/page.html` });
  const { sessionId } = await s.send('Target.attachToTarget', { targetId, flatten: true });
  const ev = async (expr) => {
    const r = await s.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description };
    return r.result?.value;
  };
  for (let i = 0; i < 100; i++) {
    if (await ev(`!!document.querySelector('[data-testid="topbar"]')`)) break;
    await sleep(150);
  }

  const created = await ev(`(async () => {
    const bar = (await chrome.bookmarks.getTree())[0].children.find((c) => c.id === '1');
    const folders = Math.max(1, Math.round(${BOOKMARKS} / 10));
    let n = 0;
    for (let i = 0; i < folders && n < ${BOOKMARKS}; i++) {
      const f = await chrome.bookmarks.create({ parentId: bar.id, title: 'Big-' + i });
      for (let j = 0; j < 10 && n < ${BOOKMARKS}; j++) {
        await chrome.bookmarks.create({ parentId: f.id, title: 'b' + i + '-' + j, url: 'https://big.example/' + i + '/' + j });
        n++;
      }
    }
    return n;
  })()`);
  console.log(`种子书签数: ${created}`);

  // 1) chrome.bookmarks.search({})：诊断里用过（现在有 5000 条截断），实测它到底多贵
  const searchBench = await ev(`(async () => {
    const out = [];
    for (let i = 0; i < ${RUNS}; i++) {
      const t0 = performance.now();
      await chrome.bookmarks.search({});
      out.push(Math.round(performance.now() - t0));
    }
    return { ms: out, avg: Math.round(out.reduce((a, b) => a + b, 0) / out.length) };
  })()`);
  console.log('search({}) 全库:', JSON.stringify(searchBench));

  /*
   * `flattenBookmarks` / `collectFolderOptions` 在打包产物里，页面里没法直接 import。
   * 用**同等复杂度的等价实现**来量：都是对整棵树的一次遍历。
   * 这测的是"这类操作的量级"，不是那两个函数的精确耗时。
   */
  const local = await ev(`(async () => {
    const roots = await chrome.bookmarks.getTree();
    const flatten = (rs) => { const out = []; const walk = (n, p) => { if (n.url) { out.push({ id: n.id, title: n.title, url: n.url, path: p.join(' / ') }); return; } const np = [...p, n.title]; for (const c of n.children ?? []) walk(c, np); }; const top = rs.length === 1 && !rs[0].url ? (rs[0].children ?? []) : rs; for (const n of top) walk(n, [n.title]); return out; };
    const collectFolders = (rs) => { const out = []; const walk = (n, p) => { if (n.url) return; const np = [...p, n.title]; out.push({ id: n.id, title: n.title, path: np.join(' / ') }); for (const c of n.children ?? []) walk(c, np); }; const top = rs.length === 1 && !rs[0].url ? (rs[0].children ?? []) : rs; for (const n of top) walk(n, []); return out; };
    const time = (fn) => { const o = []; for (let i = 0; i < ${RUNS}; i++) { const t0 = performance.now(); fn(); o.push(Math.round(performance.now() - t0)); } return { ms: o, avg: Math.round(o.reduce((a,b)=>a+b,0)/o.length) }; };
    const f = flatten(roots);
    const c = collectFolders(roots);
    return {
      bookmarkCount: f.length,
      folderCount: c.length,
      flatten: time(() => flatten(roots)),
      collectFolders: time(() => collectFolders(roots)),
    };
  })()`);
  console.log('树遍历实测:', JSON.stringify(local));

  await s.send('Target.closeTarget', { targetId });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('测量失败:', e);
    process.exit(1);
  });
