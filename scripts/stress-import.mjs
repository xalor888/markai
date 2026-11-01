/**
 * MarkAI 批量写入压力测试（CDP，无第三方依赖）
 *
 * 目的：验证「一次导入几千条书签」不会崩、不会卡死、能跑完。
 * 日常 e2e 只验 1200 条的**渲染**；这里验的是**批量写入**路径：
 * 书签事件风暴 → UI 去抖合并 → 撤销事务 → 整理记录写入。
 * 任何一个 O(n²) 都会在几分钟内暴露。
 *
 * 注意：它**不碰真实书签**——用独立的临时 profile，跑完即删。
 *
 * 历史：这个脚本的前身 `stress-sweep.mjs` 测的是「补整理」按钮，
 * 那个功能在 0.2.35 已删除（它会把存量书签按域名批量搬走，用户明确不要）。
 * 脚本当时没跟着删，于是发 `organize:sweep` 只会超时——已移除并改写为通用导入压测。
 *
 * 用法：
 *   node scripts/stress-import.mjs                 # 默认 3000 条
 *   COUNT=1500 node scripts/stress-import.mjs
 *   CHROME_BIN=/path/to/chrome node scripts/stress-import.mjs
 */
import { existsSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';

const CDP_PORT = process.env.MARKAI_CDP_PORT || 9335;
const CDP = `http://127.0.0.1:${CDP_PORT}`;
const OUT_DIR = new URL('../.output/chrome-mv3', import.meta.url).pathname;
const DEFAULT_CHROME =
  '/Users/xalor/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const CHROME = process.env.CHROME_BIN || DEFAULT_CHROME;
const EXT_ID = 'ojlfhclcoecgjbgklbjcbcfbjjjlhjhd';
const PROFILE = `/tmp/markai-stress-${process.pid}`;
const COUNT = Number(process.env.COUNT || 3000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
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
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 120000);
    });
  }
}

async function main() {
  if (!existsSync(CHROME)) throw new Error(`找不到 Chrome：${CHROME}`);
  if (!existsSync(OUT_DIR)) throw new Error(`找不到构建产物：先跑 npm run build`);

  const child = spawn(
    CHROME,
    [
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${PROFILE}`,
      '--disable-extensions-except=' + OUT_DIR,
      '--load-extension=' + OUT_DIR,
      `--remote-debugging-port=${CDP_PORT}`,
      '--window-size=1280,900',
      '--headless=new',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const cleanup = () => {
    try {
      child.kill('SIGTERM');
    } catch {
      /* 已退出 */
    }
    try {
      rmSync(PROFILE, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  };
  process.on('exit', cleanup);

  let ws = null;
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(CDP + '/json/list')).json();
      const page = list.find((t) => t.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        break;
      }
    } catch {
      /* 未就绪 */
    }
    await sleep(250);
  }
  if (!ws) throw new Error('CDP 未就绪');
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const cdp = new Session(ws);
  await cdp.send('Runtime.enable');

  const { targetId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${EXT_ID}/page.html` });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  const ev = async (expression) => {
    const res = await cdp.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      sessionId,
    );
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || 'evaluate failed');
    return res.result?.value;
  };

  // 等界面就绪
  for (let i = 0; i < 100; i++) {
    if (await ev(`!!document.querySelector('[data-testid="topbar"]')`).catch(() => false)) break;
    await sleep(150);
  }

  console.log(`批量写入压测：${COUNT} 条`);
  const result = await ev(`(async () => {
    const t0 = performance.now();
    const bar = (await chrome.bookmarks.getTree())[0].children.find((c) => c.id === '1');
    const folder = await chrome.bookmarks.create({ parentId: bar.id, title: 'STRESS' });
    let batch = [];
    for (let i = 0; i < ${COUNT}; i++) {
      batch.push(chrome.bookmarks.create({ parentId: folder.id, title: 'S' + i, url: 'https://s' + i + '.example.com/p' }));
      if (batch.length >= 100) { await Promise.all(batch); batch = []; }
    }
    if (batch.length) await Promise.all(batch);
    const writeMs = Math.round(performance.now() - t0);

    /*
     * 真正要量的是「打开这个文件夹，N 行多久渲染出来」。
     * 只量树节点数没意义——默认布局下树是收起的，永远只有几个节点。
     */
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    /*
     * ① 等树刷新出 STRESS，再点进去。
     *
     * 注意顺序：书签创建完的瞬间树还没刷新（事件去抖 300ms~1.2s），
     * 这时点「全部展开」摊开的是**旧树**，STRESS 根本不在里面。
     * 所以必须轮询到它出现，必要时再展开一次。
     */
    let foundFolder = false;
    for (let round = 0; round < 10 && !foundFolder; round++) {
      const expandAll = document.querySelector('button[aria-label="全部展开"]');
      if (expandAll) expandAll.click();
      await wait(400);
      foundFolder = [...document.querySelectorAll('[data-testid="tree-node"]')].some((n) =>
        (n.textContent || '').includes('STRESS'),
      );
      if (!foundFolder) await wait(600);
    }

    // ② 点进 STRESS 文件夹
    const target = [...document.querySelectorAll('[data-testid="tree-node"]')].find((n) =>
      (n.textContent || '').includes('STRESS'),
    );
    if (target) target.click();
    await wait(100);

    // ③ 量「多少毫秒后渲染出 N 行」
    const t1 = performance.now();
    let rendered = 0;
    for (let i = 0; i < 200; i++) {
      await wait(50);
      rendered = document.querySelectorAll('[data-testid="row"]').length;
      if (rendered >= ${COUNT}) break;
      if (performance.now() - t1 > 15000) break;
    }
    const renderMs = Math.round(performance.now() - t1);
    return { writeMs, renderMs, rendered, foundFolder, folderId: folder.id };
  })()`);

  console.log(`  写入 ${COUNT} 条：${result.writeMs}ms（${(result.writeMs / COUNT).toFixed(2)}ms/条）`);
  console.log(`  打开后渲染 ${result.rendered}/${COUNT} 行：${result.renderMs}ms`);
  if (!result.foundFolder) console.log('  ⚠ 没在树里找到 STRESS 文件夹（展开/去抖可能没跟上）');

  // 清理
  await ev(`chrome.bookmarks.removeTree(${JSON.stringify(result.folderId)}).catch(() => {})`);
  ws.close();
  cleanup();

  const okRender = result.foundFolder && result.rendered >= COUNT && result.renderMs < 3000;
  console.log(
    `\n结果：${okRender ? 'PASS' : 'FAIL'}（${COUNT} 行须在 3s 内渲染完，且数量对得上）`,
  );
  process.exit(okRender ? 0 : 1);
}

main().catch((e) => {
  console.error('压测失败:', e);
  process.exit(1);
});
