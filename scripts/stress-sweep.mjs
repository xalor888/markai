/**
 * MarkAI 补整理压力测试（CDP，无第三方依赖）
 *
 * 目的：验证「导入几千条书签后点补整理」不会崩、不会卡死、能跑完。
 * 日常 e2e 只验 1200 条的**渲染**；这里验的是**批量写入**路径：
 * 逐条决策 + 撤销事务 + 日志写入，任何一个 O(n²) 都会在几分钟内暴露。
 *
 * 与 e2e 分开的原因：这个脚本要跑几分钟，不该拖慢每次验证。
 *
 * 用法：
 *   node scripts/stress-sweep.mjs                 # 默认 3000 条
 *   COUNT=1500 node scripts/stress-sweep.mjs
 *   CHROME_BIN=/path/to/chrome node scripts/stress-sweep.mjs
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
/** 补整理的总预算：超过这个时长就算失败（用户不会等更久） */
const BUDGET_MS = Number(process.env.BUDGET_MS || 300_000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launchChrome() {
  if (!existsSync(CHROME)) throw new Error(`找不到 Chrome：${CHROME}`);
  return spawn(
    CHROME,
    [
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${PROFILE}`,
      '--disable-extensions-except=' + OUT_DIR,
      '--load-extension=' + OUT_DIR,
      `--remote-debugging-port=${CDP_PORT}`,
      '--window-size=1280,900',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  );
}

async function getJson(path) {
  const r = await fetch(CDP + path);
  return r.json();
}

class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      // 造 3000 条数据本身可能超过 20 秒，给到 120 秒
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 120_000);
    });
  }
}

async function main() {
  const chrome = launchChrome();
  let failed = false;
  try {
    for (let i = 0; i < 120; i++) {
      try {
        await getJson('/json/version');
        break;
      } catch {
        await sleep(250);
      }
    }
    const version = await getJson('/json/version');
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((r, j) => {
      ws.addEventListener('open', r);
      ws.addEventListener('error', j);
    });
    const cdp = new Session(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${EXT_ID}/page.html` });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);

    const ev = async (expression) => {
      const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
      if (res.exceptionDetails) {
        throw new Error(`页面执行异常: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
      }
      return res.result.value;
    };
    for (let i = 0; i < 100; i++) {
      if (await ev(`!!document.querySelector('header')`).catch(() => false)) break;
      await sleep(150);
    }

    // 关掉自动整理：否则 3000 次 create 会各自触发一轮后台处理，测的就不是补整理了
    await ev(`(async () => {
      const cfg = (await chrome.storage.local.get('markai.config'))['markai.config'] || {};
      await chrome.storage.local.set({ 'markai.config': { ...cfg, providerId: 'deepseek', baseUrl: '', apiKey: '', model: '', autoOrganizeNew: false } });
      await chrome.storage.local.remove(['markai.organize.log', 'markai.organize.optout']);
      return true;
    })()`);

    console.log(`[1/4] 造 ${COUNT} 条散落书签…`);
    const seed = await ev(`(async () => {
      const bar = (await chrome.bookmarks.getTree())[0].children.find(c => c.id === '1');
      const folder = await chrome.bookmarks.create({ parentId: bar.id, title: 'STRESS-不参与' });
      const t0 = Date.now();
      const batch = [];
      for (let i = 0; i < ${COUNT}; i++) {
        // 让域名分布接近真实：少数站点占多数（补整理的同域复用才有意义）
        const site = i % 7;
        batch.push(chrome.bookmarks.create({
          parentId: bar.id,
          title: '压测条目 ' + i,
          url: 'https://site' + site + '.stress-example.com/p/' + i,
        }));
        // 分批等待，避免一次性堆积过多未决 promise
        if (batch.length >= 200) { await Promise.all(batch); batch.length = 0; }
      }
      await Promise.all(batch);
      return { ms: Date.now() - t0, folderId: folder.id };
    })()`);
    console.log(`      造完：${seed.ms}ms`);

    // 量化瓶颈：每次整理都会调 getTree() 去找根目录，库越大这一下越贵
    const treeCost = await ev(`(async () => {
      const N = 10;
      const t0 = performance.now();
      for (let i = 0; i < N; i++) await chrome.bookmarks.getTree();
      const total = performance.now() - t0;
      return { avg: Math.round(total / N), total: Math.round(total) };
    })()`);
    console.log(`      getTree 单次平均 ${treeCost.avg}ms（${treeCost.total}ms / 10 次）`);

    // 重新打开自动整理开关（补整理需要它；sweep 本身不看这个开关）
    await ev(`(async () => {
      const cfg = (await chrome.storage.local.get('markai.config'))['markai.config'] || {};
      await chrome.storage.local.set({ 'markai.config': { ...cfg, autoOrganizeNew: true } });
      return true;
    })()`);

    // 在页面里挂监听收集进度（background 通过 runtime.sendMessage 广播）
    await ev(`(() => {
      window.__sweep = { done: 0, total: 0, moved: 0, failed: 0, finished: false, cancelled: false };
      window.__msgs = {};
      // 区分「页面发出的请求」与「页面收到的广播」：两者数量差异很大，混在一起会误判瓶颈
      window.__sent = {};
      if (!window.__sendHooked) {
        window.__sendHooked = true;
        const origSend = chrome.runtime.sendMessage.bind(chrome.runtime);
        chrome.runtime.sendMessage = (msg, ...rest) => {
          if (msg && msg.type) window.__sent[msg.type] = (window.__sent[msg.type] || 0) + 1;
          return origSend(msg, ...rest);
        };
      }
      if (!window.__sweepHooked) {
        window.__sweepHooked = true;
        chrome.runtime.onMessage.addListener((m) => {
          if (m && m.type) window.__msgs[m.type] = (window.__msgs[m.type] || 0) + 1;
          if (!m || !window.__sweep) return;
          if (m.type === 'markai:sweep-progress') {
            window.__sweep.done = m.done; window.__sweep.total = m.total;
            window.__sweep.moved = m.moved; window.__sweep.failed = m.failed;
          } else if (m.type === 'markai:sweep-done') {
            window.__sweep.finished = true; window.__sweep.cancelled = m.cancelled === true;
            window.__sweep.moved = m.moved; window.__sweep.failed = m.failed; window.__sweep.done = m.done;
          }
        });
      }
      return true;
    })()`);

    // 主线程健康度：补整理期间界面还能不能用，靠帧间隔说话。
    // 3000 条连续移动会触发大量书签事件，页面若在每个事件上都重算全树就会卡成幻灯片。
    await ev(`(() => {
      window.__raf = { max: 0, samples: 0, over100: 0, longFrames: [] };
      const t0 = performance.now();
      let last = performance.now();
      const tick = () => {
        const now = performance.now();
        const delta = now - last;
        last = now;
        if (delta > 0) {
          window.__raf.samples++;
          if (delta > window.__raf.max) window.__raf.max = delta;
          if (delta > 100) {
            window.__raf.over100++;
            // 记下长帧发生的相对时间点，便于判断它落在「补整理期间」还是「收尾渲染」
            window.__raf.longFrames.push({ atMs: Math.round(now - t0), gap: Math.round(delta) });
          }
        }
        if (window.__rafOn) requestAnimationFrame(tick);
      };
      window.__rafOn = true;
      requestAnimationFrame(tick);
      return true;
    })()`);

    console.log('[2/4] 触发补整理…');
    const t0 = Date.now();
    const started = await ev(`chrome.runtime.sendMessage({ type: 'organize:sweep' })`);
    console.log(`      响应：${JSON.stringify(started)}`);
    if (!started?.started) {
      console.log('补整理没有启动，终止');
      failed = true;
      return;
    }

    console.log('[3/4] 等进度（每 5 秒打一次）…');
    let last = -1;
    while (Date.now() - t0 < BUDGET_MS) {
      const s = await ev(`window.__sweep`);
      if (s.done !== last) {
        last = s.done;
        const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
        console.log(`      ${s.done}/${s.total}（${pct}%）· 已归入 ${s.moved} · 失败 ${s.failed}`);
      }
      if (s.finished) break;
      await sleep(5000);
    }

    const elapsed = Date.now() - t0;
    const final = await ev(`window.__sweep`);
    const raf = await ev(`(() => { window.__rafOn = false; return window.__raf; })()`);
    const msgs = await ev(`window.__msgs`);
    const sent = await ev(`window.__sent`);
    console.log(`      页面发出：${JSON.stringify(sent)}`);
    console.log(`      页面收到：${JSON.stringify(msgs)}`);
    if (raf.longFrames && raf.longFrames.length > 0) {
      console.log(`      长帧位置：${raf.longFrames.map((f) => `${f.atMs}ms(${f.gap}ms)`).join(' · ')}`);
    }
    console.log(
      `      主线程：最长一帧 ${Math.round(raf.max)}ms · 超过 100ms 的帧 ${raf.over100} 个 / 共 ${raf.samples} 帧`,
    );
    if (raf.max > 1500) {
      console.log('      ⚠️ 出现超长卡顿（>1.5s），界面在这段时间不可用');
    }
    const perItem = final.done > 0 ? (elapsed / final.done).toFixed(1) : '—';
    console.log(`[4/4] 结束：${final.done}/${final.total} 条 · 耗时 ${(elapsed / 1000).toFixed(1)}s · 平均 ${perItem}ms/条`);

    const ok = final.finished && final.done === final.total && elapsed < BUDGET_MS;
    if (!ok) {
      failed = true;
      console.log(`❌ 未在预算内跑完（finished=${final.finished} done=${final.done}/${final.total}）`);
    } else {
      console.log(`✅ ${final.total} 条补整理跑完，耗时 ${(elapsed / 1000).toFixed(1)}s`);
    }

    console.log('[5/5] 测量撤销耗时（每个撤销点 = 一批 200 条 op）…');
    const undoPerf = await ev(`(async () => {
      const list = await chrome.runtime.sendMessage({ type: 'undo:list' });
      const points = list?.points || [];
      const results = [];
      // 撤销必须从最新开始：依次 apply 最新的那个
      for (const p of points) {
        const t0 = performance.now();
        const res = await chrome.runtime.sendMessage({ type: 'undo:apply', id: p.id });
        results.push({
          ops: (p.ops || []).length,
          ms: Math.round(performance.now() - t0),
          ok: res?.result?.ok === true,
          restored: res?.result?.restored ?? 0,
        });
      }
      return { count: points.length, results };
    })()`);
    console.log(`      撤销点 ${undoPerf.count} 个：`);
    for (const r of undoPerf.results) {
      console.log(`        ${r.ops} op → ${r.ms}ms（ok=${r.ok}, restored=${r.restored}）`);
    }
    const totalUndo = undoPerf.results.reduce((a, r) => a + r.ms, 0);
    console.log(`      撤销合计 ${totalUndo}ms`);

    // 清理：把造出来的书签和产生的文件夹全部删掉，避免污染真实库
    console.log('      清理中…');
    await ev(`(async () => {
      const tree = await chrome.bookmarks.getTree();
      const bar = tree[0].children.find(c => c.id === '1');
      const isStress = (t) => /stress-example\\.com$/.test(t || '');
      for (const child of bar.children || []) {
        // 只删本次压测造的站点文件夹，以及它自己的占位文件夹
        if (!child.url && (child.title === 'STRESS-不参与' || isStress(child.title))) {
          await chrome.bookmarks.removeTree(child.id).catch(() => {});
          continue;
        }
        // 「自动整理」容器：只删里面属于压测的站点文件夹；容器空了才删容器
        if (!child.url && child.title === '自动整理') {
          const kids = await chrome.bookmarks.getChildren(child.id).catch(() => []);
          for (const k of kids) {
            if (!k.url && isStress(k.title)) await chrome.bookmarks.removeTree(k.id).catch(() => {});
          }
          const left = await chrome.bookmarks.getChildren(child.id).catch(() => []);
          if (left.length === 0) await chrome.bookmarks.removeTree(child.id).catch(() => {});
          continue;
        }
        // 根目录下还没被收走的压测书签
        if (child.url && child.url.includes('stress-example.com')) {
          await chrome.bookmarks.remove(child.id).catch(() => {});
        }
      }
      return true;
    })()`);
  } catch (e) {
    failed = true;
    console.error('压测失败：', e instanceof Error ? e.message : e);
  } finally {
    try {
      chrome.kill('SIGTERM');
    } catch {
      /* 已退出 */
    }
    // 必须清掉临时 profile：跑几轮之后残留的 Chrome 进程与几十个 profile 会互相抢 CPU，
    // 让后面的测量凭空慢 3 倍（这轮就被它误导过——回滚了其实没问题的改动）。
    await sleep(500);
    try {
      rmSync(PROFILE, { recursive: true, force: true });
    } catch {
      /* 目录可能已被系统回收 */
    }
  }
  process.exit(failed ? 1 : 0);
}

void main();
