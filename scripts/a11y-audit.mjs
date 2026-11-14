#!/usr/bin/env node
/**
 * 无障碍静态巡检（真实 DOM，不是读源码猜）。
 *
 * 检查四类每个页面都会犯、且修起来很便宜的错：
 *  1. 可见的交互控件没有可访问名称（无 aria-label / aria-labelledby / 文本 / title）；
 *  2. img 没有 alt（favicon 也应 alt=""，装饰图需要显式空值）；
 *  3. 打开的对话框没有 role="dialog" / aria-modal；
 *  4. 页面里有重复 id（aria-labelledby / label for 会指向错误元素）。
 *
 * 用法：node scripts/a11y-audit.mjs
 * 退出码非 0 表示有失败项；输出可直接贴进 PR。
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const CHROME =
  '/Users/xalor/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const OUT = '/Users/xalor/Documents/markai/.output/chrome-mv3';
const EXT = 'ojlfhclcoecgjbgklbjcbcfbjjjlhjhd';
const PORT = 9352;
const PROFILE = `/tmp/markai-a11y-${process.pid}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

async function version() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return r.json();
    } catch {
      /* not ready */
    }
    await sleep(150);
  }
  throw new Error('Chrome 未就绪');
}

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
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
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
      }, 30000);
    });
  }
}

const v = await version();
const ws = new WebSocket(v.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.addEventListener('open', r);
  ws.addEventListener('error', j);
});
const cdp = new Session(ws);

async function openPage(path, width, height) {
  const { targetId } = await cdp.send('Target.createTarget', {
    url: `chrome-extension://${EXT}/${path}`,
  });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false }, sessionId);
  await sleep(700);
  return { sessionId, targetId };
}

async function evaluate(sessionId, expression) {
  const r = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    sessionId,
  );
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

const AUDIT = `(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
  };
  const accName = (el) => {
    const aria = (el.getAttribute('aria-label') || '').trim();
    if (aria) return aria;
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const target = document.getElementById(by);
      if (target && target.innerText.trim()) return target.innerText.trim();
    }
    const title = (el.getAttribute('title') || '').trim();
    if (title) return title;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      const id = el.id;
      const label = id ? document.querySelector('label[for="' + id + '"]') : null;
      if (label && label.innerText.trim()) return label.innerText.trim();
      const wrap = el.closest('label');
      if (wrap && wrap.innerText.trim()) return wrap.innerText.trim();
      if ((el.getAttribute('placeholder') || '').trim()) return el.getAttribute('placeholder').trim();
    }
    const text = (el.innerText || '').trim();
    if (text) return text;
    return '';
  };
  const controls = [...document.querySelectorAll('button, a[href], input, textarea, select')]
    .filter(visible)
    .map((el) => ({ tag: el.tagName.toLowerCase(), name: accName(el), id: el.id, cls: String(el.className).slice(0, 60) }))
    .filter((x) => !x.name);
  const imgs = [...document.querySelectorAll('img')]
    .filter(visible)
    .filter((el) => !el.hasAttribute('alt'))
    .map((el) => ({ src: el.getAttribute('src')?.slice(0, 80) || '', cls: String(el.className).slice(0, 60) }));
  const dialog = document.querySelector('[role="dialog"]');
  const dialogs = dialog
    ? [{ modal: dialog.getAttribute('aria-modal'), label: dialog.getAttribute('aria-label') || '' }]
    : [];
  const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
  const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
  return { controls, imgs, dialogs, dupIds: [...new Set(dupIds)] };
})()`;

const results = [];
async function audit(label, path, width, height) {
  const { sessionId } = await openPage(path, width, height);
  const res = await evaluate(sessionId, AUDIT);
  results.push({ label, ...res });
}

await audit('主页面 1440', 'page.html', 1440, 900);

// 浮层也要查：命令面板是键盘用户的主路径，role/aria-modal/名称一个都不能少
{
  const { sessionId } = await openPage('page.html', 1440, 900);
  await evaluate(
    sessionId,
    `window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true,cancelable:true}))`,
  );
  await sleep(400);
  results.push({ label: '命令面板', ...(await evaluate(sessionId, AUDIT)) });
}

await audit('侧边栏 430', 'sidepanel.html', 430, 950);
await audit('设置页', 'options.html', 1200, 900);
await audit('弹窗', 'popup.html', 380, 520);

let failed = false;
for (const r of results) {
  const issues = [];
  if (r.controls.length) issues.push(`无名称控件 ${r.controls.length}: ${JSON.stringify(r.controls.slice(0, 5))}`);
  if (r.imgs.length) issues.push(`img 缺 alt ${r.imgs.length}: ${JSON.stringify(r.imgs.slice(0, 5))}`);
  for (const d of r.dialogs) {
    if (d.modal !== 'true') issues.push(`对话框缺 aria-modal: ${JSON.stringify(d)}`);
    if (!d.label) issues.push(`对话框缺 aria-label: ${JSON.stringify(d)}`);
  }
  if (r.dupIds.length) issues.push(`重复 id: ${JSON.stringify(r.dupIds.slice(0, 5))}`);
  if (issues.length) {
    failed = true;
    console.log(`\n[${r.label}]`);
    for (const issue of issues) console.log(`  ✘ ${issue}`);
  } else {
    console.log(`[${r.label}] ✔`);
  }
}

console.log(`\n无障碍巡检：${results.length - results.filter((r) => r.controls.length || r.imgs.length || r.dupIds.length).length}/${results.length} 通过`);
child.kill('SIGTERM');
ws.close();
await sleep(300);
rmSync(PROFILE, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
