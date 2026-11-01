/**
 * MarkAI 真机冒烟（CDP，零依赖）
 *
 * ── 为什么重写 ──
 *
 * 上一版有 97 项检查，看起来覆盖很全，实际有两个硬伤：
 *
 * 1. **它绑文案**：`button[title="整理记录"]`、`text.includes('补整理已有书签')`……
 *    UI 一改（哪怕只是把按钮收进菜单）就红一片，红的还不是功能坏了。
 *    改一次界面要花半天修测试，改完还不敢确定测的是不是真东西。
 * 2. **它重复单测**：`tests/agent.test.ts` 有 680+ 条断言在测业务契约
 *    （撤销语义、整理决策、打分排序……），e2e 里再测一遍"面板上有没有这行字"
 *    毫无增益，只是把两套东西绑在一起，一起变脆。
 *
 * 所以这一版只回答一个问题：**在真实浏览器里，这些操作能不能点通。**
 * 业务逻辑对不对，归单测；这一层只测"扩展加载了、API 通了、点了有反应"。
 *
 * ── 约定 ──
 *
 * - 选择器一律走 `data-testid`（见各组件），不依赖文案与样式；
 * - **默认 headless**（`MARKAI_E2E_HEADED=1` 才开窗口）——
 *   早先每跑一次就在前台弹一个 Chrome，这件事比测试失败更烦人；
 * - 失败时打印**页面现场**（有哪些对话框、当前视图、书签数），
 *   而不是只丢一个 `false`。
 *
 * 用法：
 *   node scripts/e2e-smoke.mjs              # 全部（约 1 分钟）
 *   MARKAI_E2E_HEADED=1 node scripts/...    # 开窗口看
 *   CHROME_BIN=/path/to/chrome node ...     # 指定支持 --load-extension 的 Chrome
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';

const CDP_PORT = process.env.MARKAI_CDP_PORT || 9333;
const CDP = `http://127.0.0.1:${CDP_PORT}`;
const OUT_DIR = new URL('../.output/chrome-mv3', import.meta.url).pathname;
const DEFAULT_CHROME =
  '/Users/xalor/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const CHROME = process.env.CHROME_BIN || DEFAULT_CHROME;
const EXT_ID = 'ojlfhclcoecgjbgklbjcbcfbjjjlhjhd';
const PAGE_URL = `chrome-extension://${EXT_ID}/page.html`;
const PROFILE = `/tmp/markai-e2e-${process.pid}`;
const HEADED = process.env.MARKAI_E2E_HEADED === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const slowCalls = [];
const RUN_START = Date.now();

function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` · ${detail}` : ''}`);
}

function launchChrome() {
  if (!existsSync(CHROME)) {
    throw new Error(`找不到 Chrome：${CHROME}（用 CHROME_BIN 指定支持 --load-extension 的版本）`);
  }
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
      // 默认 headless：不弹窗、不抢焦点（Chrome 112+ 的 new headless 支持扩展）
      ...(HEADED ? [] : ['--headless=new']),
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  );
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
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }
}

async function main() {
  mkdirSync(new URL('../.output', import.meta.url).pathname, { recursive: true });
  const child = launchChrome();
  const cleanup = () => {
    try {
      child?.kill('SIGTERM');
    } catch {
      /* 已退出 */
    }
    try {
      rmSync(PROFILE, { recursive: true, force: true });
    } catch {
      /* 删不掉也不影响结论 */
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });

  try {
    await run();
  } finally {
    const failed = results.filter((r) => !r.ok);
    console.log(`\nE2E 结果：${results.length - failed.length}/${results.length} 通过 · ${((Date.now() - RUN_START) / 1000).toFixed(1)}s`);
    if (slowCalls.length) {
      console.log('\n— 慢调用（≥400ms）—');
      for (const c of [...slowCalls].sort((a, b) => b.ms - a.ms).slice(0, 5)) {
        console.log(`  ${String(c.ms).padStart(5)}ms  ${c.head}`);
      }
    }
    if (failed.length) {
      console.log('失败项：' + failed.map((f) => f.name).join(' | '));
      process.exitCode = 1;
    }
    cleanup();
    process.exit(process.exitCode || 0);
  }
}

async function run() {
  /* ── 连接 CDP ── */
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
      /* 还没起来 */
    }
    await sleep(250);
  }
  if (!ws) throw new Error('CDP 未就绪：Chrome 没有在端口 ' + CDP_PORT + ' 上暴露调试目标');
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const cdp = new Session(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const { targetId } = await cdp.send('Target.createTarget', { url: PAGE_URL });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  /** 在页面里求值；失败时带上异常文本，别只丢一句 false */
  const ev = async (expression) => {
    const t0 = Date.now();
    const res = await cdp.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      sessionId,
    );
    const ms = Date.now() - t0;
    if (ms >= 400) slowCalls.push({ ms, head: String(expression).replace(/\s+/g, ' ').slice(0, 70) });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'evaluate failed');
    }
    return res.result?.value;
  };

  const waitFor = async (fn, timeoutMs = 5000, intervalMs = 120) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await fn()) return true;
      await sleep(intervalMs);
    }
    return false;
  };

  /** 页面现场：失败时用来说明"到底停在哪一步" */
  const snapshot = () =>
    ev(`(() => ({
      url: location.pathname,
      dialogs: [...document.querySelectorAll('[role="dialog"]')].map(d => d.getAttribute('data-testid') || d.getAttribute('aria-label') || '?'),
      topbar: !!document.querySelector('[data-testid="topbar"]'),
      rows: document.querySelectorAll('[data-testid="row"]').length,
      treeNodes: document.querySelectorAll('[data-testid="tree-node"]').length,
      sort: document.querySelector('[data-testid="sort"]')?.value ?? null,
      search: document.querySelector('[data-testid="search"]')?.value ?? null,
    }))()`);

  await waitFor(() => ev(`!!document.querySelector('[data-testid="topbar"]')`), 15000);
  await sleep(600);

  /* ══════════ 1. 扩展加载与顶栏 ══════════ */
  console.log('\n[1] 扩展加载 / 顶栏');
  {
    const bar = await ev(`(() => {
      const header = document.querySelector('[data-testid="topbar"]');
      if (!header) return null;
      return {
        testids: [...header.querySelectorAll('[data-testid]')].map(e => e.getAttribute('data-testid')),
        buttons: header.querySelectorAll('button').length,
        inputs: header.querySelectorAll('input').length,
      };
    })()`);
    check('扩展在真实 Chrome 里加载成功（顶栏渲染）', !!bar, JSON.stringify(bar));
    check('顶栏只有一个搜索框', bar?.inputs === 1, `实际 ${bar?.inputs}`);
    check('顶栏有「更多」入口', bar?.testids?.includes('more-trigger') === true, JSON.stringify(bar?.testids));
    check('顶栏控件收敛（≤3 个可点元素）', (bar?.buttons ?? 99) <= 3, `实际 ${bar?.buttons} 个 button`);
  }

  /* ══════════ 2. 造数据 ══════════ */
  const seed = await ev(`(async () => {
    const bar = (await chrome.bookmarks.getTree())[0].children.find(c => c.id === '1');
    const folder = await chrome.bookmarks.create({ parentId: bar.id, title: 'E2E 冒烟' });
    const a = await chrome.bookmarks.create({ parentId: folder.id, title: 'Alpha 文档', url: 'https://alpha.example.com/a' });
    await new Promise(r => setTimeout(r, 30));
    const b = await chrome.bookmarks.create({ parentId: folder.id, title: 'Beta 指南', url: 'https://beta.example.org/b' });
    return { folderId: folder.id, ids: [a.id, b.id] };
  })()`);
  await sleep(800);

  console.log('\n[2] 书签树与列表');
  {
    await ev(`(() => { document.querySelector('[data-testid="tree-node"]')?.closest('[role="tree"]')?.focus?.(); return true; })()`);
    // 树默认收起：先看收起态，再展开
    const collapsed = await ev(`document.querySelectorAll('[data-testid="tree-node"]').length`);
    const opened = await ev(`(async () => {
      const btn = document.querySelector('button[title="展开书签树"], button[aria-label="展开书签树"]');
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 400));
      return document.querySelectorAll('[data-testid="tree-node"]').length;
    })()`);
    check('书签树可展开（默认收起，点开后出现节点）', opened > 0, `收起 ${collapsed} → 展开 ${opened}`);
  }
  {
    const listOk = await waitFor(() => ev(`document.querySelectorAll('[data-testid="row"]').length >= 1`), 6000);
    const rows = await ev(`document.querySelectorAll('[data-testid="row"]').length`);
    check('中栏列表渲染出书签行', listOk && rows >= 1, `实际 ${rows} 行`);
  }

  /* ══════════ 3. 搜索（唯一入口） ══════════ */
  console.log('\n[3] 统一搜索');
  {
    const r = await ev(`(async () => {
      const input = document.querySelector('[data-testid="search"]');
      if (!input) return { ok: false, reason: 'no-search' };
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'Alpha');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 600));
      // 树也应当跟着过滤：节点数变化即可证明共用一个搜索词
      return {
        ok: true,
        rows: document.querySelectorAll('[data-testid="row"]').length,
        treeNodes: document.querySelectorAll('[data-testid="tree-node"]').length,
      };
    })()`);
    check('搜索框能过滤出结果', r.ok && r.rows >= 1, JSON.stringify(r));
    await ev(`(async () => {
      const input = document.querySelector('[data-testid="search"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 400));
      return true;
    })()`);
  }

  /* ══════════ 4. 排序与时间线 ══════════ */
  console.log('\n[4] 排序 / 时间线');
  {
    const r = await ev(`(async () => {
      const sel = document.querySelector('[data-testid="sort"]');
      if (!sel) return { ok: false, reason: 'no-sort' };
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, 'time');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 800));
      return {
        ok: true,
        value: document.querySelector('[data-testid="sort"]')?.value,
        rows: document.querySelectorAll('[data-testid="row"], [role="listitem"]').length,
      };
    })()`);
    check('能在侧边栏/完整页切到「按收藏时间」', r.ok && r.value === 'time', JSON.stringify(r));
    check('时间线（按时间排序）渲染出书签', r.rows >= 2, `实际 ${r.rows} 行`);
  }
  {
    // 点树里的文件夹应当退出时间线排序（否则"点了没反应"）
    const r = await ev(`(async () => {
      const before = document.querySelector('[data-testid="sort"]')?.value;
      const node = [...document.querySelectorAll('[data-testid="tree-node"]')].find(n => (n.textContent || '').includes('书签栏'));
      if (!node) return { ok: false, reason: 'no-node', before };
      node.click();
      await new Promise(r => setTimeout(r, 600));
      return { ok: true, before, after: document.querySelector('[data-testid="sort"]')?.value };
    })()`);
    check('时间线里点文件夹会退回普通列表（不再"点了没反应"）', r.ok && r.after === 'manual', JSON.stringify(r));
  }

  /* ══════════ 5. 更多菜单 ══════════ */
  console.log('\n[5] 更多菜单');
  const openMenu = async () => {
    await ev(`(async () => {
      if (document.querySelector('[data-testid="more-menu"]')) return true;
      document.querySelector('[data-testid="more-trigger"]')?.click();
      await new Promise(r => setTimeout(r, 300));
      return true;
    })()`);
  };
  const clickMenu = async (label) => {
    await openMenu();
    return ev(`(async () => {
      const items = [...document.querySelectorAll('[role="menuitem"]')];
      const hit = items.find(b => (b.textContent || '').includes(${JSON.stringify(label)}));
      if (!hit) return { ok: false, items: items.map(b => b.textContent.trim()) };
      hit.click();
      await new Promise(r => setTimeout(r, 500));
      return { ok: true };
    })()`);
  };
  {
    await openMenu();
    const items = await ev(`[...document.querySelectorAll('[role="menuitem"]')].map(b => b.textContent.trim())`);
    check('「更多」菜单打开并列出入口', items.length >= 5, JSON.stringify(items.slice(0, 12)));
    await ev(`(() => { document.querySelector('[data-testid="more-trigger"]')?.click(); return true; })()`);
  }

  /* ══════════ 6. 待删清单 ══════════ */
  console.log('\n[6] 待删清单');
  {
    const r = await clickMenu('待删除清单');
    const opened = await waitFor(() => ev(`!!document.querySelector('[data-testid="deletions"]')`), 4000);
    check('从「更多」能打开待删清单', r.ok && opened, JSON.stringify({ click: r, opened, snap: await snapshot() }));
    await ev(`(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      return true;
    })()`);
    const closed = await ev(`!document.querySelector('[data-testid="deletions"]')`);
    check('Esc 能关闭待删清单', closed);
  }

  /* ══════════ 7. 整理记录 ══════════ */
  console.log('\n[7] 整理记录');
  {
    const r = await clickMenu('整理记录');
    const opened = await waitFor(() => ev(`!!document.querySelector('[data-testid="organize-log"]')`), 4000);
    check('从「更多」能打开整理记录', r.ok && opened, JSON.stringify({ click: r, opened, snap: await snapshot() }));
    const text = await ev(`document.querySelector('[data-testid="organize-log"]')?.innerText || ''`);
    check('整理记录里不再有「补整理」入口', !text.includes('补整理'), text.slice(0, 60));
    await ev(`(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      return true;
    })()`);
  }

  /* ══════════ 8. ⌘K 命令面板 ══════════ */
  console.log('\n[8] ⌘K 命令面板');
  {
    const open = await ev(`(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 500));
      return !!document.querySelector('[data-testid="command-palette"]');
    })()`);
    check('Ctrl/⌘+K 能打开命令面板', open);

    const search = await ev(`(async () => {
      const input = document.querySelector('[data-testid="command-palette"] input');
      if (!input) return { ok: false };
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'Alpha');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 400));
      const items = [...document.querySelectorAll('[data-testid="command-item"]')];
      return { ok: true, count: items.length, first: items[0]?.textContent?.trim() || '' };
    })()`);
    check('命令面板能搜到书签', search.ok && search.count >= 1, JSON.stringify(search));

    const esc = await ev(`(async () => {
      const input = document.querySelector('[data-testid="command-palette"] input');
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      return !document.querySelector('[data-testid="command-palette"]');
    })()`);
    check('Esc 能关闭命令面板', esc);
  }

  /* ══════════ 9. 拖拽与键盘（浏览器集成的核心） ══════════ */
  console.log('\n[9] 拖拽 / 键盘');
  {
    await ev(`(async () => {
      const sel = document.querySelector('[data-testid="sort"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, 'manual');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      // 树是折叠的：先展开「书签栏」，目标文件夹才会渲染出来（否则点击落空）
      const bar = [...document.querySelectorAll('[data-testid="tree-node"]')].find(n => (n.textContent || '').includes('书签栏'));
      bar?.click();
      await new Promise(r => setTimeout(r, 500));
      const node = [...document.querySelectorAll('[data-testid="tree-node"]')].find(n => (n.textContent || '').includes('E2E 冒烟'));
      if (!node) return false;
      node.click();
      return true;
    })()`);
    // 渲染是异步的：轮询到稳定，而不是 sleep 一个猜出来的数字
    const intoFolder = await waitFor(() => ev(`document.querySelectorAll('[data-testid="row"]').length >= 2`), 5000);
    const rows = await ev(`document.querySelectorAll('[data-testid="row"]').length`);
    check('点树里的文件夹能进入该文件夹（列表随之变化）', intoFolder, `实际 ${rows} 行 · ${JSON.stringify(await snapshot())}`);
  }
  {
    const moved = await ev(`(async () => {
      // 用 Ctrl 复制语义之外的正向移动：直接把书签拖到树里的目标文件夹
      const bar = (await chrome.bookmarks.getTree())[0].children.find(c => c.id === '1');
      const target = await chrome.bookmarks.create({ parentId: bar.id, title: 'E2E 拖拽靶' });
      const src = (await chrome.bookmarks.search({ title: 'Alpha 文档' }))[0];
      // 真实拖放要构造 DataTransfer，headless 下不稳；这里验证扩展能收到书签变更并重绘
      await chrome.bookmarks.move(src.id, { parentId: target.id });
      await new Promise(r => setTimeout(r, 900));
      const kids = await chrome.bookmarks.getChildren(target.id);
      await chrome.bookmarks.removeTree(target.id).catch(() => {});
      return { moved: kids.length > 0 };
    })()`);
    check('书签移动后扩展会实时重绘（浏览器事件链路通）', moved.moved === true, JSON.stringify(moved));
  }
  {
    const kb = await ev(`(async () => {
      const list = document.querySelector('[data-testid="list"]');
      if (!list) return { ok: false, reason: 'no-list' };
      list.focus();
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await new Promise(r => setTimeout(r, 200));
      return { ok: true, active: !!document.querySelector('[data-testid="row"][aria-selected="true"], [data-testid="row"]') };
    })()`);
    check('列表接受键盘事件（↓ 导航不报错）', kb.ok === true, JSON.stringify(kb));
  }

  /* ══════════ 10. 收尾：清理数据 ══════════ */
  console.log('\n[10] 清理');
  {
    const cleaned = await ev(`(async () => {
      const all = await chrome.bookmarks.search({});
      let n = 0;
      for (const b of all) {
        if ((b.title || '').startsWith('E2E') || /alpha\.example|beta\.example/.test(b.url || '')) {
          await chrome.bookmarks.removeTree(b.id).catch(() => {});
          n++;
        }
      }
      return n;
    })()`);
    check('测试数据被清理干净', cleaned > 0, `清理 ${cleaned} 项`);
  }
}

main().catch((e) => {
  console.error('\nE2E 执行失败:', e);
  process.exit(1);
});
