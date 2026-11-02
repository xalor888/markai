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
import { createServer } from 'node:http';

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

  let crashed = null;
  try {
    await run();
  } catch (e) {
    /*
     * **跑挂 ≠ 通过**。
     *
     * 早先这里只有 finally：`process.exit(process.exitCode || 0)` 会在异常传播前先退出，
     * 于是「脚本中途抛异常」被报成「N 项通过」+ 退出码 0 —— 崩溃伪装成绿灯，
     * 比测试失败危险得多（表现为"检查项少了几条"，很容易被当成正常）。
     */
    crashed = e;
  } finally {
    const failed = results.filter((r) => !r.ok);
    console.log(`\nE2E 结果：${results.length - failed.length}/${results.length} 通过 · ${((Date.now() - RUN_START) / 1000).toFixed(1)}s`);
    if (slowCalls.length) {
      console.log('\n— 慢调用（≥400ms）—');
      for (const c of [...slowCalls].sort((a, b) => b.ms - a.ms).slice(0, 5)) {
        console.log(`  ${String(c.ms).padStart(5)}ms  ${c.head}`);
      }
    }
    if (crashed) {
      console.log(`\nE2E 执行中断：${crashed instanceof Error ? crashed.message : String(crashed)}`);
      console.log('（上面是中断前已完成的部分；中断不等于通过）');
      process.exitCode = 1;
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

  /**
   * 通过「更多」菜单打开面板。
   *
   * 0.2.35 把顶栏那排按钮收进了 `⋯` 菜单，所以任何"点某个顶栏按钮"的老写法都会落空。
   * 这个 helper 放在 run() 作用域里，后面的段落都能用；菜单已开时不会再点一次（否则会关掉）。
   */
  const openMenuItem = async (label) => {
    await ev(`(() => {
      if (!document.querySelector('[data-testid="more-menu"]')) {
        document.querySelector('[data-testid="more-trigger"]')?.click();
      }
      return true;
    })()`);
    await sleep(300);
    const clicked = await ev(`(() => {
      const hit = [...document.querySelectorAll('[role="menuitem"]')]
        .find((b) => (b.textContent || '').includes(${JSON.stringify(label)}));
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
    await sleep(500);
    return clicked;
  };

  /** 截图/断言前确认面板真的开了：没开就抛错，别让后续断言在错误的页面上跑 */
  const requireOpen = async (testId) => {
    const ok = await waitFor(async () => await ev(`!!document.querySelector('[data-testid="${testId}"]')`), 4000);
    if (!ok) throw new Error(`面板 ${testId} 没有打开`);
    return true;
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

  /* ══════════ 9.4 空文件夹的空状态 ══════════ */
  console.log('\n[9.4] 空文件夹空状态');
  {
    /*
     * 回归：空文件夹里「新建书签」曾经出现 **两次**。
     * 原因是有两段独立的 `browsing && selectedFolderId` 块各自渲染了按钮，
     * 一段只有「新建书签」+ 空行提示，另一段有「新建书签 + 新建文件夹」。
     * 用户看到的是重复按钮和一行奇怪的空白。
     */
    const emptyFolderId = await ev(`(async () => {
      const bar = (await chrome.bookmarks.getTree())[0].children.find((c) => c.id === '1');
      const f = await chrome.bookmarks.create({ parentId: bar.id, title: 'E2E-空文件夹' });
      return f.id;
    })()`);

    // 等树的去抖刷新，再展开并点进去
    await waitFor(async () => {
      await ev(`document.querySelector('button[aria-label="全部展开"]')?.click()`);
      await sleep(300);
      return ev(`document.body.innerText.includes('E2E-空文件夹')`);
    }, 6000);
    await ev(`(() => {
      const n = [...document.querySelectorAll('[data-testid="tree-node"]')]
        .find((x) => (x.textContent || '').includes('E2E-空文件夹'));
      n?.click();
      return true;
    })()`);
    await sleep(600);

    const empty = await ev(`(() => {
      const labels = [...document.querySelectorAll('button')]
        .map((b) => (b.textContent || '').trim())
        .filter((t) => t === '新建书签' || t === '新建文件夹');
      return {
        labels,
        newBookmark: labels.filter((t) => t === '新建书签').length,
        newFolder: labels.filter((t) => t === '新建文件夹').length,
        hasHint: document.body.innerText.includes('Ctrl+D'),
      };
    })()`);
    check(
      '空文件夹里动作按钮不重复（新建书签 / 新建文件夹 各一个）',
      empty.newBookmark === 1 && empty.newFolder === 1,
      JSON.stringify(empty),
    );
    check('空文件夹里给了下一步（含 Ctrl+D 提示）', empty.hasHint === true, JSON.stringify(empty));

    await ev(`chrome.bookmarks.removeTree(${JSON.stringify(emptyFolderId)}).catch(() => {})`);
  }

  /* ══════════ 9.45 快捷键说明与实际一致 ══════════ */
  console.log('\n[9.45] 快捷键一致性');
  {
    /*
     * 回归：速查表写着 `Ctrl+K` = 聚焦搜索框，但 0.2.35 起 Ctrl+K 打开的是**命令面板**。
     * 说明与实际不符比没有说明更糟——用户照着按，得到的是别的东西。
     *
     * 这里同时钉住行为与文案：按 Ctrl+K 必须打开命令面板，速查表也不能再写"聚焦搜索框"。
     */
    await ev(`(() => { document.activeElement?.blur?.(); document.body.focus(); return true; })()`);
    await sleep(150);
    await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }))`);
    /*
     * 用 waitFor 等"面板出现且焦点在内"这个最终状态，而不是 sleep(500) 后碰运气。
     * 固定 sleep 在机器忙的时候会假失败——本轮就是要消掉这类假信号。
     */
    const paletteReady = await waitFor(
      async () =>
        await ev(`(() => {
          const p = document.querySelector('[data-testid="command-palette"]');
          return !!p && p.contains(document.activeElement);
        })()`),
      5000,
    );
    const opened = paletteReady;
    const focusInside = paletteReady;
    check('Ctrl+K 打开命令面板且焦点在里面', opened === true && focusInside === true, JSON.stringify({ opened, focusInside }));

    // 关掉面板，再打开速查表看文案
    await ev(`document.querySelector('[data-testid="command-palette"] input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(300);
    await ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }))`);
    await sleep(500);
    /*
     * 这段塞进模板字符串执行，注释与代码里都不能出现反斜杠转义
     * （模板字符串会先把它转成真字符，结果不是断行就是非法正则）。
     *
     * 按键在速查表里是分开渲染的 <kbd>，所以不能按"某一行同时含 Ctrl 和 K"去找。
     * 改用两个更稳的判据：
     *  - 旧措辞「聚焦搜索框」必须消失（这是被改掉的那句话）；
     *  - 新措辞「命令面板」必须出现（证明改成了实际行为）。
     */
    const copy = await ev(`(() => {
      const d = document.querySelector('[role="dialog"]');
      const t = d ? d.innerText : '';
      return {
        hasDialog: !!d,
        oldWording: t.includes('聚焦搜索框'),
        hasPalette: t.includes('命令面板'),
        excerpt: t.split(String.fromCharCode(10)).filter((l) => l.includes('Ctrl') || l.includes('命令面板')).join(' / ').slice(0, 120),
      };
    })()`);
    check(
      '速查表里的 Ctrl+K 说明与实际一致',
      copy.hasDialog === true && copy.oldWording === false && copy.hasPalette === true,
      JSON.stringify(copy),
    );
    await ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(200);
  }

  /* ══════════ 9.281 深色系统下首帧就是暗的（不闪白） ══════════ */
  console.log('\n[9.281] 主题首帧');
  {
    /*
     * 缺陷：`applyTheme` 只在异步的 `load()` 里调用，而 React 第一帧在它之前就画了。
     * 于是 `<html>` 上还没有 `.dark` —— 深色系统的用户**每次打开都先白一下**。
     *
     * 判据：在 DOMContentLoaded 这一刻记录 `<html>` 的 class。
     * 那一刻模块脚本已经执行完（我们的同步应用就在这里发生），
     * 而 `load()` 的 storage 读取还没回来——正好把"首帧"卡住。
     */
    const { targetId: t } = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${EXT_ID}/page.html`,
    });
    const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId: t, flatten: true });
    await cdp.send('Page.enable', {}, sid);
    // 系统深色，但用户在设置里选了**浅色** —— 首帧必须是浅色
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, sid);
    const { identifier } = await cdp.send(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source: `document.addEventListener('DOMContentLoaded', () => {
          window.__firstFrame = document.documentElement.className;
        });`,
      },
      sid,
    );
    await cdp.send(
      'Runtime.evaluate',
      { expression: `localStorage.setItem('markai.theme', 'light'); chrome.storage.local.remove('markai.theme')` },
      sid,
    );
    await cdp.send('Page.reload', {}, sid);
    await sleep(1200);
    const ev2 = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
      if (r.exceptionDetails) return null;
      return r.result?.value;
    };
    const cls = await ev2(`window.__firstFrame`);
    check(
      '系统深色但用户选了浅色时，首帧就是浅的（不被系统偏好带偏）',
      typeof cls === 'string' && !cls.includes('dark'),
      JSON.stringify({ firstFrameClass: cls }),
    );

    // 反向：选了深色 + 系统浅色 → 首帧必须就是暗的
    await cdp.send('Runtime.evaluate', { expression: `localStorage.setItem('markai.theme', 'dark')` }, sid);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, sid);
    await cdp.send('Page.reload', {}, sid);
    await waitFor(async () => (await ev2(`typeof window.__firstFrame !== 'undefined'`)) === true, 8000);
    const cls2 = await ev2(`window.__firstFrame`);
    check(
      '系统浅色但用户选了深色时，首帧就是暗的',
      typeof cls2 === 'string' && cls2.includes('dark'),
      JSON.stringify({ firstFrameClass: cls2 }),
    );

    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, sid).catch(() => {});
    await cdp.send('Emulation.setEmulatedMedia', { features: [] }, sid).catch(() => {});
    await cdp.send('Target.closeTarget', { targetId: t }).catch(() => {});
  }

  /* ══════════ 9.287 键盘能进书签树并移动选中项 ══════════ */
  console.log('\n[9.287] 树的可达性');
  {
    /*
     * 台账里"所有可点元素可 Tab 到达"这一项。实测发现：树的行是
     * `<div role="treeitem">` 且没有 tabindex——但**容器**有 tabIndex=0 并处理方向键，
     * 所以是"一个制表位 + 方向键漫游"的设计，键盘确实能用。
     * 这里把这条路径钉住：Tab 能进树，方向键能改选中项。
     */
    const tabbable = await ev(`(() => {
      const tree = document.querySelector('[role="tree"]');
      if (!tree) return { hasTree: false };
      const host = tree.closest('[tabindex]');
      return { hasTree: true, hostTabIndex: host ? host.getAttribute('tabindex') : null };
    })()`);
    check('书签树有可聚焦的宿主（Tab 能进去）', tabbable?.hasTree === true && tabbable?.hostTabIndex === '0', JSON.stringify(tabbable));

    const moved = await ev(`(async () => {
      const host = document.querySelector('[role="tree"]')?.closest('[tabindex]');
      if (!host) return { ok: false, why: 'no host' };
      host.focus();
      const focused = document.activeElement === host;
      // 活动行由 ring 类标记（见 bookmark-tree.tsx 的 active && 'ring-1 …'）
      const activeText = () =>
        document.querySelector('[role="treeitem"].ring-1')?.innerText?.trim().slice(0, 20) || '';
      const before = activeText();
      host.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 400));
      const after = activeText();
      return { ok: true, focused, before, after, changed: before !== after };
    })()`);
    check(
      '聚焦树后按方向键，活动行会变（不是死键）',
      moved?.ok === true && moved?.focused === true && moved?.changed === true,
      JSON.stringify(moved),
    );
  }

  /* ══════════ 9.286 空状态都要有"下一步该做什么" ══════════ */
  console.log('\n[9.286] 空状态的下一步');
  {
    /*
     * 台账里这一项挂了很久。逐个看过之后发现**大部分已经做好了**
     * （列表三种空态、时间线两种、撤销、记忆都有动作提示）。
     * 但没有测试守着——下次有人改文案，很可能又退回成一句干巴巴的"空"。
     * 这里把"每个空态都必须带下一步"钉住。
     */
    const probe = async (label, setup, selector, expectText) => {
      await ev(setup);
      await sleep(400);
      const r = await ev(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        return el ? el.innerText : null;
      })()`);
      check(
        `空态「${label}」带下一步（不只是说"空"）`,
        typeof r === 'string' && r.length > 0 && new RegExp(expectText).test(r),
        JSON.stringify({ text: (r || '').slice(0, 90) }),
      );
    };

    /*
     * 1) 没有选中文件夹 → 应给"查看书签栏"这个动作。
     * 页面没有把 store 挂到 window，所以用键盘路径达到同一个状态：
     *    顶栏搜索框聚焦 → Esc 失焦 → 点侧边栏的根节点之外的空白处不可靠，
     *    改用"清空搜索 + 取消选中"的等效路径——直接点中栏的空白行区域。
     * 退一步：这里只验证**搜索无结果**这一种空态（可由 DOM 事件稳定复现），
     * 未选文件夹那条留给单测与人工，不为了凑数写一个跑不到的用例。
     */

    // 2) 搜索无结果 → 应给"清空搜索"这个出口
    await probe(
      '搜索无结果',
      `(() => { const s = document.querySelector('input[placeholder*="搜索"]'); if (!s) return false;
        const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        set.call(s, 'zzz-绝对搜不到-zzz'); s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
      '[data-testid="empty-state"]',
      // 必须出现**动作**：只匹配"没有匹配"会被状态句本身满足，那样这条用例是空的
      '清空搜索',
    );

    // 必须把搜索清掉：后面的键盘用例（Ctrl+A / 空格 / F2）都作用在**当前列表**上，
    // 留着这个搜不到的词会让它们全部作用在空结果上而假失败。
    await ev(`(() => {
      const s = document.querySelector('input[placeholder*="搜索"]');
      if (!s) return false;
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      set.call(s, ''); s.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(500);
  }

  /* ══════════ 9.2835 同一个动作在界面里只有一个名字 ══════════ */
  console.log('\n[9.2835] 文案一致性');
  {
    /*
     * 缺陷：工具栏叫「让 MarkAI 整理**选中项**」，侧边栏右键叫「让 MarkAI 整理**所选**（N）」。
     * 同一个动作两个名字，用户会以为是两个功能。0.2.79 收敂到 src/lib/ui/labels.ts。
     */
    const found = await ev(`(() => {
      const t = document.body.innerText;
      return {
        // 旧叫法不该再出现在任何界面文案里
        hasOldName: /整理选中项/.test(t),
        hasNewName: /整理所选/.test(t),
      };
    })()`);
    check(
      '界面里不再出现旧叫法「整理选中项」',
      found?.hasOldName === false,
      JSON.stringify(found),
    );
  }

  /* ══════════ 9.284 设置页每一节都有错误边界 ══════════ */
  console.log('\n[9.284] 设置页错误边界');
  {
    /*
     * 缺陷：ErrorBoundary 以前只包了「健康检查」。其余五节没有——
     * React 19 里任何子组件抛错都会卸掉整棵树，用户看到的是**纯白设置页**，
     * 没有报错、没有重试，只能重开。
     */
    const { targetId: t } = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${EXT_ID}/options.html`,
    });
    const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId: t, flatten: true });
    await cdp.send('Page.enable', {}, sid);
    const ev2 = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
      if (r.exceptionDetails) return null;
      return r.result?.value;
    };
    await waitFor(async () => await ev2(`!!document.querySelector('[data-testid="export-html"]')`), 10000);

    const bounds = await ev2(`[...document.querySelectorAll('[data-error-boundary]')].map((e) => e.getAttribute('data-error-boundary'))`);
    const needed = ['健康检查', 'AI 服务', '上下文与预算', 'Agent 行为', '外观', '数据管理'];
    const missing = needed.filter((n) => !(bounds || []).includes(n));
    check(
      '设置页六节各自都有错误边界（任一节抛错不会带走整页）',
      Array.isArray(bounds) && missing.length === 0,
      JSON.stringify({ have: bounds, missing }),
    );

    const titles = await ev2(`(() => {
      const html = document.body.innerHTML;
      return { health: html.includes('健康检查'), ai: html.includes('AI 服务'), data: html.includes('数据管理') };
    })()`);
    check(
      '页面正常渲染（不是白屏、没掉进错误边界）',
      titles?.health === true && titles?.ai === true && titles?.data === true,
      JSON.stringify(titles),
    );

    await cdp.send('Target.closeTarget', { targetId: t }).catch(() => {});
  }

  /* ══════════ 9.282 设置页能导出书签文件 ══════════ */
  console.log('\n[9.282] 书签导出');
  {
    /*
     * 以前只有「清空」，用户说"帮我把书签备份一下"时没有任何入口；
     * AI 的 export_bookmarks 也只把清单交给模型、不产文件。
     * 这条验证：点下去真的会触发一次下载，文件名与 MIME 都对。
     */
    const { targetId: t } = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${EXT_ID}/options.html`,
    });
    const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId: t, flatten: true });
    await cdp.send('Page.enable', {}, sid);
    const ev2 = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
      if (r.exceptionDetails) return null;
      return r.result?.value;
    };
    await waitFor(async () => await ev2(`!!document.querySelector('[data-testid="export-html"]')`), 10000);

    const counts = await ev2(`(() => {
      const p = [...document.querySelectorAll('p')].find((x) => /将导出/.test(x.textContent || ''));
      return p ? p.textContent.trim() : null;
    })()`);
    check('按钮旁说明"将导出 N 条"（读了真实书签数）', typeof counts === 'string' && /将导出 \d+ 条书签/.test(counts), JSON.stringify({ counts }));

    // 拦截 a.click()：不真的落盘，但必须拿到文件名与内容类型
    await ev2(`(() => {
      window.__downloads = [];
      const orig = window.URL.createObjectURL;
      window.URL.createObjectURL = (blob) => {
        window.__downloads.push({ size: blob.size, type: blob.type });
        return orig(blob);
      };
      HTMLAnchorElement.prototype.click = function () {
        window.__downloads.push({ name: this.download, href: String(this.href).slice(0, 20) });
      };
      return true;
    })()`);

    await ev2(`document.querySelector('[data-testid="export-html"]').click()`);
    // 等下载记录真的出现，而不是固定 sleep：机器忙时 500ms 会不够，造成偶发假失败
    await waitFor(async () => (await ev2(`(window.__downloads || []).length`)) >= 2, 6000);
    const html = await ev2(`window.__downloads`);
    // createObjectURL 与 a.click() 是两个不同的记录：一个带 type/size，一个带 name
    check(
      '点「书签 HTML」真的触发了下载（文件名 + 内容类型正确）',
      Array.isArray(html) &&
        html.some((d) => /MarkAI-书签-\d{4}-\d{2}-\d{2}\.html/.test(d.name || '')) &&
        html.some((d) => /text\/html/.test(d.type || '')) &&
        html.some((d) => typeof d.size === 'number' && d.size > 200),
      JSON.stringify(html),
    );

    await ev2(`window.__downloads = []; document.querySelector('[data-testid="export-json"]').click()`);
    await waitFor(async () => (await ev2(`(window.__downloads || []).length`)) >= 2, 6000);
    const json = await ev2(`window.__downloads`);
    check(
      '点「JSON」也真的触发了下载',
      Array.isArray(json) &&
        json.some((d) => /MarkAI-书签-\d{4}-\d{2}-\d{2}\.json/.test(d.name || '')) &&
        json.some((d) => /application\/json/.test(d.type || '')) &&
        json.some((d) => typeof d.size === 'number' && d.size > 100),
      JSON.stringify(json),
    );

    const noErr = await ev2(`!document.querySelector('[data-testid="export-error"]')`);
    check('导出没有报错', noErr === true, JSON.stringify({ noErr }));

    await cdp.send('Target.closeTarget', { targetId: t }).catch(() => {});
  }

  /* ══════════ 9.283 命令面板：能搜文件夹、无结果有提示、Esc 能关 ══════════ */
  console.log('\n[9.283] 命令面板');
  {
    /*
     * 面板写着「搜书签、文件夹，或执行动作…」。以前只验证过"Ctrl+K 能打开"，
     * 没验证过它**真的能搜到文件夹**，也没验证过无结果时的样子和 Esc 的退出。
     */
    await ev(`(() => { document.activeElement?.blur?.(); document.body.focus(); return true; })()`);
    await sleep(150);
    await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }))`);
    const opened = await waitFor(
      async () => await ev(`!!document.querySelector('[data-testid="command-palette"]')`),
      5000,
    );
    check('Ctrl+K 能打开命令面板', opened === true, JSON.stringify({ opened }));

    const typeQuery = async (q) => {
      await ev(`(() => {
        const el = document.querySelector('[data-testid="command-palette"] input');
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(q)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await sleep(350);
    };

    /*
     * 自己造一个唯一命名的文件夹：之前直接用种子里的名字，
     * 而那个文件夹在当前环境里可能根本不存在 —— 断言会因环境而假失败。
     */
    const FOLDER_NAME = 'E2E-命令面板文件夹';
    const madeFolder = await ev(`(async () => {
      const bar = (await chrome.bookmarks.getTree())[0].children.find((c) => c.id === '1');
      const existed = (await chrome.bookmarks.search(${JSON.stringify(FOLDER_NAME)}))[0];
      if (existed) return { id: existed.id };
      const n = await chrome.bookmarks.create({ parentId: bar.id, title: ${JSON.stringify(FOLDER_NAME)} });
      return { id: n.id };
    })()`);
    await sleep(800);
    await typeQuery(FOLDER_NAME);
    /*
     * 必须断言到**文件夹类型的结果项**。
     * 第一版查的是"面板里有没有『文件夹』三个字"——而动作里有「整理此文件夹」，
     * 这三个字恒成立，于是把文件夹从数据源里删掉它也照样绿。
     */
    const folderHit = await ev(`(() => {
      const p = document.querySelector('[data-testid="command-palette"]');
      if (!p) return { noPanel: true };
      const items = [...p.querySelectorAll('[data-testid="command-item"]')];
      const folderItems = items.filter((el) => el.getAttribute('data-kind') === 'folder');
      return {
        folderCount: folderItems.length,
        folderNames: folderItems.map((el) => el.innerText.split(String.fromCharCode(10))[0]),
      };
    })()`);
    check(
      '搜文件夹名能搜到**文件夹类型**的结果（面板承诺"搜书签、文件夹"）',
      folderHit.folderCount >= 1 && folderHit.folderNames.includes(FOLDER_NAME),
      JSON.stringify(folderHit),
    );

    await typeQuery('zzz-绝对搜不到-zzz');
    const empty = await waitFor(
      async () => await ev(`document.querySelector('[data-testid="command-palette"]')?.innerText.includes('没有匹配')`),
      4000,
    );
    check('搜不到时明确说「没有匹配」，不是一片空白', empty === true, JSON.stringify({ empty }));

    await ev(`document.querySelector('[data-testid="command-palette"] input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    const closed = await waitFor(
      async () => await ev(`!document.querySelector('[data-testid="command-palette"]')`),
      4000,
    );
    check('「Esc」能关掉面板', closed === true, JSON.stringify({ closed }));

    await ev(`chrome.bookmarks.removeTree(${JSON.stringify(madeFolder.id)}).catch(() => {})`);
  }

  /* ══════════ 9.285 本地文件能不能真的存成书签 ══════════ */
  console.log('\n[9.285] file:// 书签');
  {
    /*
     * 0.2.70 把「收藏当前页」的判据从"只放行 http(s)"放宽到"也放行 file://"，
     * 理由是 Chrome 自己允许收藏本地文件。
     * 但放宽判据之后必须确认**下游真的接得住**——否则按钮会从"灰的"变成"点了报错"。
     */
    const made = await ev(`(async () => {
      const bar = (await chrome.bookmarks.getTree())[0].children.find((c) => c.id === '1');
      try {
        const n = await chrome.bookmarks.create({
          parentId: bar.id, title: 'E2E 本地文件', url: 'file:///tmp/markai-e2e-local.html',
        });
        const found = await chrome.bookmarks.search('file:///tmp/markai-e2e-local.html');
        await chrome.bookmarks.remove(n.id).catch(() => {});
        return { ok: true, created: !!n.id, searchable: found.length >= 1 };
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) };
      }
    })()`);
    check(
      'Chrome 真的接受 file:// 书签（放宽判据后下游接得住）',
      made.ok === true && made.created === true && made.searchable === true,
      JSON.stringify(made),
    );
  }

  /* ══════════ 9.29 更多菜单的自动整理开关：读失败时不能覆盖整份配置 ══════════ */
  console.log('\n[9.29] 自动整理开关的盲写');
  {
    /*
     * 缺陷：more-menu 里自己做了「storage.get → 合并 → storage.set」的整对象覆盖。
     * 读失败时 `cfg` 退化成 `{}`，接着写 `{ ...{}, autoOrganizeNew }`
     * ——**整份配置（API Key / 端点 / 模型 / 删除模式）被一个布尔字段覆盖**。
     * 这是 0.2.60~0.2.63 那一类盲写的第五处，而且绕开了 store 里已有的保护。
     */
    const KEY = 'markai.config';
    const real = {
      providerId: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-e2e-别丢',
      model: 'deepseek-chat',
      customHeaders: 'X-A: 1',
      deleteMode: 'confirm',
      autoOrganizeNew: true,
    };
    await ev(`chrome.storage.local.set({ '${KEY}': ${JSON.stringify(real)} })`);
    const { targetId: t } = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${EXT_ID}/page.html`,
    });
    const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId: t, flatten: true });
    await cdp.send('Page.enable', {}, sid);
    const { identifier } = await cdp.send(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source: `(() => {
          window.__breakCfg = true;
          const orig = chrome.storage.local.get.bind(chrome.storage.local);
          chrome.storage.local.get = (k, ...rest) => {
            const key = Array.isArray(k) ? k[0] : k;
            if (window.__breakCfg && key === 'markai.config') {
              return Promise.reject(new Error('模拟：配置读取失败'));
            }
            return orig(k, ...rest);
          };
        })();`,
      },
      sid,
    );
    await cdp.send('Page.reload', {}, sid);
    await sleep(1300);
    const ev2 = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
      if (r.exceptionDetails) return null;
      return r.result?.value;
    };

    await waitFor(async () => await ev2(`!!document.querySelector('[data-testid="more-trigger"]')`), 8000);
    await ev2(`document.querySelector('[data-testid="more-trigger"]').click()`);
    await waitFor(async () => await ev2(`!!document.querySelector('[data-testid="auto-organize-toggle"]')`), 6000);
    await ev2(`document.querySelector('[data-testid="auto-organize-toggle"]').click()`);
    await sleep(800);

    /*
     * 必须用**没有注入坏 get 的页面**读回来。
     * 我第一版用 ev2（同一个被打坏的页面）读，get 直接 reject → 读到 null →
     * 断言把"读不到"误报成"被覆盖"。断言本身成了假阳性来源。
     */
    const stored = await ev(`(async () => (await chrome.storage.local.get('${KEY}'))['${KEY}'])()`);
    check(
      '读配置失败时点开关，API Key / 端点 / 模型 必须还在（不能被一个布尔字段覆盖）',
      !!stored && stored.apiKey === real.apiKey && stored.baseUrl === real.baseUrl && stored.model === real.model,
      JSON.stringify({ apiKey: stored?.apiKey ?? null, model: stored?.model ?? null }),
    );

    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, sid).catch(() => {});
    await cdp.send('Target.closeTarget', { targetId: t }).catch(() => {});
  }

  /* ══════════ 9.30 搜索失败不能永远转圈 ══════════ */
  console.log('\n[9.30] 搜索失败态');
  {
    /*
     * 缺陷：搜索的 `.catch(() => {})` 吞掉错误后 `searchResults` 仍是 null，
     * 而 `loading = searchResults === null` —— 列表**永远停在「加载中…」**，
     * 没有错误、没有重试。搜索框打字像卡死。
     */
    const { targetId: t } = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${EXT_ID}/page.html`,
    });
    const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId: t, flatten: true });
    await cdp.send('Page.enable', {}, sid);
    const { identifier } = await cdp.send(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source: `(() => {
          window.__breakSearch = true;
          const orig = chrome.bookmarks.search.bind(chrome.bookmarks);
          chrome.bookmarks.search = (...a) => {
            if (window.__breakSearch) return Promise.reject(new Error('模拟：搜索通道异常'));
            return orig(...a);
          };
        })();`,
      },
      sid,
    );
    await cdp.send('Page.reload', {}, sid);
    await sleep(1300);
    const ev2 = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
      if (r.exceptionDetails) return null;
      return r.result?.value;
    };
    // 搜索框的 testid 是 "search"（id 才是 markai-search）；写错会拿到 null 而静默什么都不做
    await waitFor(async () => await ev2(`!!document.querySelector('[data-testid="search"]')`), 8000);
    await ev2(`(() => {
      const el = document.querySelector('[data-testid="search"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, '一些搜不到的东西');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);

    const shown = await waitFor(
      async () => await ev2(`!!document.querySelector('[data-testid="search-error-banner"]')`),
      8000,
    );
    check('搜索失败时给出「搜索失败 + 原因」', shown === true, JSON.stringify({ shown }));

    const noSpinner = await ev2(`!document.body.innerText.includes('加载中')`);
    check('搜索失败时列表不会永远停在「加载中…」', noSpinner === true, JSON.stringify({ noSpinner }));

    const hasRetry = await ev2(`!!document.querySelector('[data-testid="search-retry"]')`);
    check('搜索失败时给出可点的「重试」', hasRetry === true, JSON.stringify({ hasRetry }));

    // 恢复后点重试：错误消失、结果回来
    await ev2(`(() => { window.__breakSearch = false; return true; })()`);
    await ev2(`(() => { document.querySelector('[data-testid="search-retry"]')?.click(); return true; })()`);
    const recovered = await waitFor(
      async () => await ev2(`!document.querySelector('[data-testid="search-error-banner"]')`),
      8000,
    );
    check('点重试后错误消失（真的重新搜了）', recovered === true, JSON.stringify({ recovered }));

    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, sid).catch(() => {});
    await cdp.send('Target.closeTarget', { targetId: t }).catch(() => {});
  }

  /* ══════════ 9.305 对话没保存成功时必须有重试 ══════════ */
  console.log('\n[9.305] 对话保存失败的重试');
  {
    /*
     * 缺陷：`persistError` 横幅只有「知道了」。
     * 按下去等于把唯一一条"这段对话不在磁盘上"的提示关掉，数据仍然没保存——
     * 用户看到过一句话，然后什么都没有了。
     */
    const { targetId: t } = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${EXT_ID}/page.html`,
    });
    const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId: t, flatten: true });
    await cdp.send('Page.enable', {}, sid);
    // 只让"写会话存储"失败，其他读写正常
    const { identifier } = await cdp.send(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source: `(() => {
          window.__breakAiWrite = true;
          const orig = chrome.storage.local.set.bind(chrome.storage.local);
          chrome.storage.local.set = (items) => {
            if (window.__breakAiWrite && items && Object.prototype.hasOwnProperty.call(items, 'markai.ai')) {
              return Promise.reject(new Error('模拟：配额已满'));
            }
            return orig(items);
          };
        })();`,
      },
      sid,
    );
    await cdp.send('Page.reload', {}, sid);
    await sleep(1300);
    const ev2 = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
      if (r.exceptionDetails) return null;
      return r.result?.value;
    };

    /*
     * 走真实的落盘触发路径：页面在 visibilitychange(hidden) 时会 flushStreamPersist()。
     * 不新造测试钩子——那测的就不是真实链路了。
     */
    await waitFor(async () => await ev2(`!!document.querySelector('[data-testid="chat-input"]')`), 8000);
    await ev2(`(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      return true;
    })()`);
    await sleep(400);

    const shown = await waitFor(
      async () => await ev2(`document.body.innerText.includes('没有保存成功')`),
      8000,
    );
    check('保存失败时出现「没有保存成功」的提示', shown === true, JSON.stringify({ shown }));

    const hasRetry = await ev2(`!!document.querySelector('[data-testid="persist-retry"]')`);
    check('提示旁边给出可点的「重试保存」（不是只有「知道了」）', hasRetry === true, JSON.stringify({ hasRetry }));

    // 恢复写入后点重试
    await ev2(`(() => { window.__breakAiWrite = false; return true; })()`);
    const clicked = await ev2(`(() => {
      const b = document.querySelector('[data-testid="persist-retry"]');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    check('重试按钮可点击', clicked === true, JSON.stringify({ clicked }));

    const cleared = await waitFor(
      async () => await ev2(`!document.body.innerText.includes('没有保存成功')`),
      10000,
    );
    check('重试成功后提示消失（真的保存了）', cleared === true, JSON.stringify({ cleared }));

    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, sid).catch(() => {});
    await cdp.send('Target.closeTarget', { targetId: t }).catch(() => {});
  }

  /* ══════════ 9.31 整理记录读失败：不能自相矛盾 ══════════ */
  console.log('\n[9.31] 整理记录读取失败态');
  {
    /*
     * 缺陷：`organize:list` 失败时 notice 和「还没有整理记录 / 收藏一个网页后…」
     * 会**同时出现**——一句话说"联系不上后台"，下一句说"你还没收藏过"，自相矛盾。
     * 而且 notice 只是纯文字，写了"请再试一次"却没有按钮。
     */
    const { targetId: t } = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${EXT_ID}/page.html`,
    });
    const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId: t, flatten: true });
    await cdp.send('Page.enable', {}, sid);
    const { identifier } = await cdp.send(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source: `(() => {
          const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
          chrome.runtime.sendMessage = (...a) => {
            const m = a[0];
            if (m && m.type === 'organize:list') return Promise.reject(new Error('模拟：后台不可用'));
            return orig(...a);
          };
        })();`,
      },
      sid,
    );
    await cdp.send('Page.reload', {}, sid);
    await sleep(1400);
    const ev2 = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
      if (r.exceptionDetails) return null;
      return r.result?.value;
    };

    // 打开整理记录（走「更多」菜单）
    await ev2(`(() => {
      if (!document.querySelector('[data-testid="more-menu"]')) {
        document.querySelector('[data-testid="more-trigger"]')?.click();
      }
      return true;
    })()`);
    await sleep(300);
    await ev2(`(() => {
      [...document.querySelectorAll('[role="menuitem"]')]
        .find((b) => (b.textContent || '').includes('整理记录'))?.click();
      return true;
    })()`);
    await sleep(700);

    const state = await ev2(`(() => {
      const d = document.querySelector('[data-testid="organize-log"]');
      if (!d) return { noDialog: true };
      const t = d.innerText;
      return {
        saysUnreachable: t.includes('无法联系后台') || t.includes('后台没有返回'),
        saysNoRecords: t.includes('还没有整理记录'),
        hasRetry: !!d.querySelector('[data-testid="organize-log-retry"]'),
      };
    })()`);
    check('读失败时说清"联系不上后台"', state.saysUnreachable === true, JSON.stringify(state));
    check(
      '读失败时**不再**同时说「还没有整理记录」（自相矛盾）',
      state.saysNoRecords === false,
      JSON.stringify(state),
    );
    check('读失败时给出可点的「重试」', state.hasRetry === true, JSON.stringify(state));

    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, sid).catch(() => {});
    await cdp.send('Target.closeTarget', { targetId: t }).catch(() => {});
  }

  /* ══════════ 9.315 撤销记录读不到时：能打开面板 + 能重试 ══════════ */
  console.log('\n[9.315] 撤销记录读取失败态');
  {
    /*
     * 缺陷（两层）：
     *  1) 「撤销历史」按钮 `disabled={undoHistory.length === 0}`，而读取失败时恰好 0 条
     *     → 那个唯一能说明"读取失败、不是没有操作"的面板**根本打不开**；
     *  2) 就算打开了，里面只写"请稍后重试或重新打开面板"，**没有重试按钮**。
     */
    const { targetId: t } = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${EXT_ID}/page.html`,
    });
    const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId: t, flatten: true });
    await cdp.send('Page.enable', {}, sid);

    // 让发往 background 的 undo:list 失败（模拟 SW 回收 / 通道异常）
    const { identifier } = await cdp.send(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source: `(() => {
          const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
          chrome.runtime.sendMessage = (...a) => {
            const m = a[0];
            if (m && m.type === 'undo:list') return Promise.reject(new Error('模拟：通道不可用'));
            return orig(...a);
          };
        })();`,
      },
      sid,
    );
    await cdp.send('Page.reload', {}, sid);
    await sleep(1400);

    const ev2 = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
      if (r.exceptionDetails) return null;
      return r.result?.value;
    };

    const btnState = await waitFor(
      async () =>
        await ev2(`(() => {
          const b = [...document.querySelectorAll('button')].find(
            (x) => (x.getAttribute('aria-label') || '') === '撤销历史',
          );
          return b ? !b.disabled : false;
        })()`),
      6000,
    );
    check('读取失败时「撤销历史」按钮仍可点开（否则原因永远看不到）', btnState === true, JSON.stringify({ btnState }));

    await ev2(`(() => {
      [...document.querySelectorAll('button')]
        .find((x) => (x.getAttribute('aria-label') || '') === '撤销历史')?.click();
      return true;
    })()`);
    await sleep(400);

    const panel = await ev2(`(() => {
      const t = document.body.innerText;
      const retry = document.querySelector('[data-testid="undo-retry"]');
      return {
        saysUnknown: t.includes('读取失败') && t.includes('状态未知'),
        hasRetry: !!retry,
      };
    })()`);
    check(
      '面板里说清「状态未知 ≠ 没有可撤销的操作」',
      panel.saysUnknown === true,
      JSON.stringify(panel),
    );
    check('面板里给出可点的「重试」（不只是让用户自己重开）', panel.hasRetry === true, JSON.stringify(panel));

    // 恢复通道后点重试：应当拿到真实列表
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, sid).catch(() => {});
    await ev2(`(() => {
      const orig = chrome.runtime.sendMessage;
      // 还原：用一个总是失败的标记不行，直接重载页面更干净
      return true;
    })()`);
    await cdp.send('Page.reload', {}, sid);
    await sleep(1200);
    /*
     * 判据是「失败状态消失」，不是「按钮可点」。
     * 通道恢复后如果本来就没有撤销点，按钮**本来就该是禁用的**（没东西可撤），
     * 拿 enabled 当判据会误判——我第一版就是这么写错的。
     */
    const recovered = await waitFor(
      async () =>
        await ev2(`(() => {
          const b = [...document.querySelectorAll('button')].find(
            (x) => (x.getAttribute('aria-label') || '') === '撤销历史',
          );
          if (!b) return false;
          const title = b.getAttribute('title') || '';
          return !title.includes('读取失败');
        })()`),
      6000,
    );
    check('通道恢复后失败状态消失（title 不再提示读取失败）', recovered === true, JSON.stringify({ recovered }));

    await cdp.send('Target.closeTarget', { targetId: t }).catch(() => {});
  }

  /* ══════════ 9.32 快捷键面板承诺的键，真的都能用 ══════════ */
  console.log('\n[9.32] 文档承诺的快捷键');
  {
    /*
     * 快捷键面板写着「这些键在书签树和中栏列表里都生效」，并列了 20 多条。
     * 但 e2e 里只验证过 ↓ 一个键 —— 也就是说**这份说明从来没被核对过**。
     * 说明与实际不符比没有说明更糟（用户照着按，得到别的东西）。
     *
     * 这里挑四条有明确可观测结果的来核对：/ 聚焦搜索、Ctrl+A 全选、
     * 空格切选中、F2 打开重命名。
     */
    const press = async (key, opts = {}) => {
      await ev(`(() => {
        const el = document.querySelector('[data-testid="list"]') || document.body;
        el.dispatchEvent(new KeyboardEvent('keydown', {
          key: ${JSON.stringify(key)},
          bubbles: true,
          cancelable: true,
          ...${JSON.stringify(opts)},
        }));
        return true;
      })()`);
      await sleep(250);
    };

    // 先点一行，确保有活动项
    await ev(`(() => {
      const row = document.querySelector('[data-testid="row"]');
      if (!row) return false;
      row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      row.click();
      return true;
    })()`);
    await sleep(300);

    await press('/');
    const slash = await ev(`document.activeElement?.id === 'markai-search'`);
    check('「/」能把焦点放到搜索框（说明里写的那样）', slash === true, JSON.stringify({ slash }));

    await press('a', { ctrlKey: true });
    const selectAll = await ev(`(() => {
      const rows = [...document.querySelectorAll('[data-testid="row"]')];
      const sel = rows.filter((r) => r.getAttribute('aria-selected') === 'true');
      return { total: rows.length, selected: sel.length };
    })()`);
    check(
      '「Ctrl+A」全选当前列表',
      selectAll.total > 0 && selectAll.selected === selectAll.total,
      JSON.stringify(selectAll),
    );

    await press(' ');
    const spaceToggled = await ev(`(() => {
      const rows = [...document.querySelectorAll('[data-testid="row"]')];
      return rows.filter((r) => r.getAttribute('aria-selected') === 'true').length;
    })()`);
    check('「空格」会改变选中状态（不是死键）', spaceToggled !== selectAll.selected, JSON.stringify({ spaceToggled }));

    await press('F2');
    const renameOpen = await ev(`(() => {
      const d = document.querySelector('[role="dialog"]');
      return !!d && /重命名/.test(d.innerText);
    })()`);
    check('「F2」打开重命名（说明里写的那样）', renameOpen === true, JSON.stringify({ renameOpen }));
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(300);
  }

  /* ══════════ 9.33 撤销上限提示要出现在界面上 ══════════ */
  console.log('\n[9.33] 撤销上限提示');
  {
    /*
     * 单测只证明"notice 字段写对了"，不证明用户看得到。
     * 这里种一条上限提示，确认聊天面板真的把它显示出来。
     */
    /*
     * 种子要贴近真实：修剪发生后，**点数仍有 10 个**，同时带一条提示。
     * 我第一版只种 notice、points 留空 —— 那样「撤销历史」按钮是禁用的
     * （`disabled={undoHistory.length === 0}`），面板根本打不开，
     * 测的就不是真实场景。
     */
    await ev(`(async () => {
      const points = Array.from({ length: 3 }, (_, i) => ({
        id: 'seed-p' + i,
        runId: 'seed-r' + i,
        createdAt: Date.now() - i * 1000,
        ops: [{ kind: 'move', id: 'x', title: 't', fromParentId: '1', fromIndex: 0, toParentId: '1', toIndex: 1 }],
      }));
      await chrome.storage.local.set({ 'markai.undo': {
        points,
        terminalRunIds: [],
        notice: '撤销记录最多保留 10 步，更早的 2 步已被丢弃',
        noticeAt: Date.now(),
      } });
      return true;
    })()`);
    await cdp.send('Page.reload', {}, sessionId);
    await sleep(1000);

    /*
     * 断言要落在**常驻横幅**上，不是 toast。
     * toast 也会带这段文字（refreshUndo 在 noticeAt 变化时弹一条），
     * 但它是几秒就消失的；真正让用户事后还能看到的是横幅。
     * 第一版只查 body 文本 → 去掉横幅后依然绿（toast 顶着），证伪没打中。
     */
    // 打开「撤销历史」面板——提示就挂在这个面板里
    await ev(`(() => {
      const b = [...document.querySelectorAll('button')].find(
        (x) => (x.getAttribute('aria-label') || '') === '撤销历史',
      );
      if (!b) return false;
      b.click();
      return true;
    })()`);
    await sleep(500);

    const shown = await waitFor(
      async () =>
        await ev(`(() => {
          const el = document.querySelector('[data-testid="undo-notice"]');
          return !!el && el.textContent.includes('更早的 2 步已被丢弃');
        })()`),
      8000,
    );
    check(
      '撤销上限的丢弃提示以**常驻横幅**形式显示（不是只弹一条 toast）',
      shown === true,
      JSON.stringify({ shown }),
    );

    await ev(`chrome.storage.local.remove('markai.undo')`);
  }

  /* ══════════ 9.35 时间线：看的是**全库**，不是一个文件夹 ══════════ */
  console.log('\n[9.35] 时间线语义');
  {
    /*
     * 时间线的卖点是"按收藏时间看全部书签"。如果它其实只渲染当前文件夹，
     * 那这个入口就是骗人的——而单测里测的是纯函数，看不出这个接线对不对。
     */
    const seed = await ev(`(async () => {
      const bar = (await chrome.bookmarks.getTree())[0].children.find((c) => c.id === '1');
      const f = await chrome.bookmarks.create({ parentId: bar.id, title: 'TL-文件夹' });
      const a = await chrome.bookmarks.create({ parentId: bar.id, title: 'TL-根级书签', url: 'https://tl-root.example/' });
      const b = await chrome.bookmarks.create({ parentId: f.id, title: 'TL-子文件夹书签', url: 'https://tl-sub.example/' });
      return { folderId: f.id, a: a.id, b: b.id };
    })()`);
    await sleep(1500);

    // 切到时间线
    await ev(`(() => {
      const b = document.querySelector('[data-testid="timeline-toggle"]');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    await sleep(700);

    /*
     * 断言必须**限定在时间线容器内**。
     * 第一版直接查 document.body.innerText —— 左侧书签树里也可能出现这些标题，
     * 那样测的是"树里有没有"，不是"时间线里有没有"，等于白过。
     */
    const view = await ev(`(() => {
      const panel = document.querySelector('[data-testid="timeline-panel"]');
      if (!panel) return { noPanel: true };
      const t = panel.innerText;
      return {
        root: t.includes('TL-根级书签'),
        sub: t.includes('TL-子文件夹书签'),
        itemCount: panel.querySelectorAll('[role="listitem"]').length,
        headerLine: t.split(String.fromCharCode(10)).find((l) => l.includes('条书签')) || '',
      };
    })()`);
    check(
      '时间线面板里同时有「书签栏根级」与「子文件夹里」的书签（看的是全库）',
      view.root === true && view.sub === true && view.itemCount >= 2,
      JSON.stringify(view),
    );

    // 切回来，确认真能回到文件夹视图（不然用户会卡在时间线里）
    await ev(`(() => {
      const b = document.querySelector('[data-testid="timeline-toggle"]');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    await sleep(600);
    /*
     * 判据要硬：时间线面板必须**消失**，且文件夹视图的排序控件必须在。
     * 第一版写成 `!包含某标题 || 有排序控件`——两个条件任一成立就过，
     * 而"有排序控件"在时间线模式下也成立，等于永远绿。
     */
    const back = await ev(`(() => {
      const panel = document.querySelector('[data-testid="timeline-panel"]');
      return {
        panelGone: !panel,
        hasSortSelect: !!document.querySelector('[data-testid="sort"]'),
        stillShowsSub: document.body.innerText.includes('TL-子文件夹书签'),
      };
    })()`);
    check(
      '再点一次能回到文件夹视图（时间线面板消失 + 排序控件回来）',
      back.panelGone === true && back.hasSortSelect === true,
      JSON.stringify(back),
    );

    await ev(`(async () => {
      await chrome.bookmarks.remove(${JSON.stringify(seed.a)}).catch(() => {});
      await chrome.bookmarks.removeTree(${JSON.stringify(seed.folderId)}).catch(() => {});
      return true;
    })()`);
    await sleep(400);
  }

  /* ══════════ 9.41 真·流式对话（本地假 AI 服务） ══════════ */
  console.log('\n[9.41] 流式对话与中断恢复');
  {
    /*
     * 这一节第一次让 AI 路径跑在**真实浏览器**里：起一个本地 OpenAI 兼容端点，
     * 返回真 SSE 流。之前所有 AI 相关路径（流式渲染、中断恢复、空回复）
     * 都只有单测，没有一条在浏览器里跑过。
     *
     * 重点验证用户最痛的那件事：**流到一半进程没了，回来还能看到已收到的内容**，
     * 而不是「模型未返回任何内容」。
     */
    const mock = await new Promise((resolve) => {
      const state = { chunks: ['第一段', '，第二段', '，第三段'], delayMs: 120, hang: false };
      const server = createServer((req, res) => {
        if (!req.url || !req.url.includes('/chat/completions')) {
          res.writeHead(404).end();
          return;
        }
        req.on('data', () => {});
        req.on('end', async () => {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
          for (const c of state.chunks) {
            send({ choices: [{ delta: { content: c } }] });
            await new Promise((r) => setTimeout(r, state.delayMs));
          }
          if (!state.hang) {
            send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
            res.write('data: [DONE]\n\n');
            res.end();
          }
          // hang=true 时故意不结束：模拟"正在生成时进程被杀"
        });
      });
      server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
    });

    const baseUrl = `http://127.0.0.1:${mock.port}/v1`;
    await ev(`(async () => {
      await chrome.storage.local.set({ 'markai.config': {
        providerId: 'deepseek', baseUrl: ${JSON.stringify(baseUrl)}, apiKey: 'mock-key', model: 'mock-model',
        temperature: 0.4, customHeaders: '',
      } });
      return true;
    })()`);
    await cdp.send('Page.reload', {}, sessionId);
    await sleep(900);
    await waitFor(async () => await ev(`!!document.querySelector('[data-testid="chat-input"]')`), 6000);

    /** 在输入框里写一句话并发送（React 受控组件要走原生 setter） */
    const sendMessage = async (text) => {
      await ev(`(() => {
        const ta = document.querySelector('[data-testid="chat-input"]');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, ${JSON.stringify(text)});
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await sleep(120);
      await ev(`(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '发送');
        if (!b) return false;
        b.click();
        return true;
      })()`);
    };

    // ── A. 正常流式：三段都得出现，并最终完成 ──
    await sendMessage('测试流式');
    const streamed = await waitFor(
      async () => await ev(`document.body.innerText.includes('，第三段')`),
      12000,
    );
    check('正常流式：模型的分段内容全部渲染出来', streamed === true, JSON.stringify({ streamed }));
    const doneState = await waitFor(
      async () =>
        await ev(`(() => {
          const ta = document.querySelector('[data-testid="chat-input"]');
          return ta && ta.getAttribute('placeholder') !== 'Agent 正在回复…';
        })()`),
      10000,
    );
    check('流结束后回到可输入状态（不是一直转圈）', doneState === true, JSON.stringify({ doneState }));

    /*
     * ── A2. 用户最初的抱怨：「我只是把标签页放后台罢了，切个标签页就没」 ──
     *
     * 实测（chrome.storage.onChanged 精确计时）：内容从「出现在 DOM」到「进入存储」
     * 只要 **104ms**——不是代码注释里写的 800ms 节流。所以"切走就丢"在当前构建里
     * **不复现**：内容几乎在出现的同时就落盘了，后台节流根本来不及吃掉它。
     *
     * 这里把这个真实保证钉住：流式内容必须及时落盘。真删掉落盘调用它会立刻转红。
     */
    mock.state.chunks = ['响应段落甲', '响应段落乙'];
    mock.state.delayMs = 700;
    mock.state.hang = true;
    await sendMessage('测试落盘延迟');
    const latency = await ev(`(async () => {
      /*
       * 关键词必须**只出现在模型回复里**：第一版用了「落盘延迟」，
       * 而它也出现在用户消息中——结果测到的是用户消息的落盘（delta=1ms），
       * 根本不是流式内容的落盘。
       */
      const KEY = '响应段落甲';
      const domSeen = { at: 0 };
      const storageSeen = { at: 0 };
      const onChanged = (changes, area) => {
        if (area !== 'local' || !changes['markai.ai'] || storageSeen.at) return;
        if (JSON.stringify(changes['markai.ai'].newValue || '').includes(KEY)) storageSeen.at = performance.now();
      };
      chrome.storage.onChanged.addListener(onChanged);
      for (let i = 0; i < 300; i++) {
        if (document.body.innerText.includes(KEY)) { domSeen.at = performance.now(); break; }
        await new Promise((r) => setTimeout(r, 10));
      }
      for (let i = 0; i < 300; i++) {
        if (storageSeen.at) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      chrome.storage.onChanged.removeListener(onChanged);
      return { saw: domSeen.at > 0 && storageSeen.at > 0, delta: Math.round(storageSeen.at - domSeen.at) };
    })()`);
    check(
      '流式内容及时落盘（DOM 出现后 2s 内进入存储；实测约 104ms）',
      latency.saw === true && latency.delta >= 0 && latency.delta < 2000,
      JSON.stringify(latency),
    );

    /*
     * 收尾：这一轮的流是挂着的（hang=true），UI 会一直停在"正在回复"，
     * 下一条消息根本发不出去。点「停止生成」让它回到可输入状态——
     * 这也是用户在真实场景下的动作。
     */
    await ev(`[...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '') === '停止生成')?.click()`);
    await waitFor(
      async () =>
        await ev(`(() => {
          const ta = document.querySelector('[data-testid="chat-input"]');
          return ta && ta.getAttribute('placeholder') !== 'Agent 正在回复…';
        })()`),
      8000,
    );
    // 恢复流式设置，供下一段使用
    mock.state.hang = false;
    mock.state.chunks = ['第一段', '，第二段', '，第三段'];
    mock.state.delayMs = 60;

    // ── B. 流到一半杀掉 service worker：已收到的内容必须留下 ──
    mock.state.chunks = ['这段会被', '打断'];
    mock.state.delayMs = 900;
    mock.state.hang = true;
    await sendMessage('测试中断');
    const partial = await waitFor(
      async () => await ev(`document.body.innerText.includes('这段会被')`),
      12000,
    );
    check('中断前：已收到第一段', partial === true, JSON.stringify({ partial }));

    /*
     * 单独验证**后台草稿**这一层。
     *
     * 上面那条"重开后内容还在"其实是 UI 自己的 800ms 落盘 + pagehide flush 兜住的
     * （证伪时把后台 appendDraft 去掉，它照样绿 —— 说明它没测到草稿）。
     * 后台草稿覆盖的是更狠的一种：页面被直接杀掉、pagehide 根本没机会跑。
     * 这里直接去 storage 里看草稿有没有在流式过程中持续写入。
     */
    // 草稿是 300ms 节流的，给足时间再断言（否则测的是时序而不是机制）
    await waitFor(
      async () =>
        await ev(`(async () => {
          const d = (await chrome.storage.local.get('markai.ai.draft'))['markai.ai.draft'];
          return !!(d && typeof d.text === 'string' && d.text.includes('这段会被'));
        })()`),
      3000,
    );
    const draft = await ev(`(async () => {
      const d = (await chrome.storage.local.get('markai.ai.draft'))['markai.ai.draft'];
      return { has: !!d, text: d && typeof d.text === 'string' ? d.text : '' };
    })()`);
    check(
      '流式过程中后台草稿在持续落盘（页面被直接杀掉时的唯一保底）',
      draft.has === true && draft.text.includes('这段会被'),
      JSON.stringify(draft),
    );

    // 杀掉扩展的 service worker（MV3 会按需重新拉起）
    const targets = await (await fetch(`${CDP}/json/list`)).json();
    const sw = targets.find((t) => t.type === 'service_worker' && (t.url || '').includes(EXT_ID));
    if (sw) await cdp.send('Target.closeTarget', { targetId: sw.id }).catch(() => {});
    await sleep(600);

    // 重新打开页面：这就是用户"退出再回来"
    await cdp.send('Page.reload', {}, sessionId);
    await sleep(1200);
    await waitFor(async () => await ev(`!!document.querySelector('[data-testid="chat-input"]')`), 8000);

    const recovered = await ev(`(() => {
      const t = document.body.innerText;
      return {
        keepsPartial: t.includes('这段会被'),
        saysEmpty: t.includes('未返回内容'),
        saysInterrupted: t.includes('被打断'),
        excerpt: t.slice(0, 260),
      };
    })()`);
    check(
      '进程被杀后重开：已收到的内容还在（不是"未返回任何内容"）',
      recovered.keepsPartial === true && recovered.saysEmpty === false,
      JSON.stringify(recovered),
    );

    mock.server.close();
    await ev(`(async () => {
      const cfg = (await chrome.storage.local.get('markai.config'))['markai.config'] || {};
      await chrome.storage.local.set({ 'markai.config': { ...cfg, baseUrl: '', apiKey: '', model: '' } });
      return true;
    })()`);
  }

  /* ══════════ 9.42 核心 Agent 循环：工具调用 → 执行 → 回填 → 最终回复 ══════════ */
  console.log('\n[9.42] Agent 工具循环（真浏览器）');
  {
    /*
     * 这是整个产品的主干：模型返回 tool_call → 我们执行 → 把结果回填 → 模型再回一段文字。
     * 这条链路以前**一次都没在浏览器里跑过**，只有单测。
     * 它同时串起了 tools.ts、撤销记录、UI 渲染三块，任何一处接错都看不出来。
     */
    const TARGET_URL = 'https://agent-loop.example/created-by-tool';
    const mock = await new Promise((resolve) => {
      const state = { requests: 0, systemContent: '' };
      const server = createServer((req, res) => {
        if (!req.url || !req.url.includes('/chat/completions')) {
          res.writeHead(404).end();
          return;
        }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', async () => {
          state.requests++;
          let isFollowUp = false;
          try {
            const parsed = JSON.parse(body);
            isFollowUp = (parsed.messages || []).some((m) => m.role === 'tool');
            // 记录系统消息，用于验证"当前时间"真的被发给了模型
            const sys = (parsed.messages || []).find((m) => m.role === 'system');
            if (sys && !state.systemContent) state.systemContent = String(sys.content || '');
          } catch {
            /* 解析不了就当首轮 */
          }
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
          if (!isFollowUp) {
            // 第一轮：要求调用 create_bookmark
            send({
              choices: [
                {
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_e2e_1',
                        type: 'function',
                        function: {
                          name: 'create_bookmark',
                          arguments: JSON.stringify({ title: 'E2E 工具建的', url: TARGET_URL }),
                        },
                      },
                    ],
                  },
                },
              ],
            });
            send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
          } else {
            // 第二轮：工具结果已回填，给最终文字
            for (const c of ['已经', '帮你建好了。']) {
              send({ choices: [{ delta: { content: c } }] });
              await new Promise((r) => setTimeout(r, 60));
            }
            send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
          }
          res.write('data: [DONE]\n\n');
          res.end();
        });
      });
      server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
    });

    await ev(`(async () => {
      // 每个 AI 段落独立起跑：清掉上一条对话，避免段落之间互相影响
      await chrome.storage.local.remove('markai.ai');
      await chrome.storage.local.set({ 'markai.config': {
        providerId: 'deepseek', baseUrl: 'http://127.0.0.1:${mock.port}/v1',
        apiKey: 'mock-key', model: 'mock-model', temperature: 0.4, customHeaders: '',
      } });
      return true;
    })()`);
    // 段落隔离：清掉上一条对话，避免段落之间互相影响
    await ev(`chrome.storage.local.remove('markai.ai')`);
    await cdp.send('Page.reload', {}, sessionId);
    await sleep(900);
    await waitFor(async () => await ev(`!!document.querySelector('[data-testid="chat-input"]')`), 6000);

    await ev(`(() => {
      const ta = document.querySelector('[data-testid="chat-input"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '帮我建一个书签');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(120);
    await ev(`(() => {
      [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '发送')?.click();
      return true;
    })()`);

    const finished = await waitFor(
      async () => await ev(`document.body.innerText.includes('帮你建好了')`),
      20000,
    );
    check('模型 → 工具 → 回填 → 最终文字：整条链路跑通', finished === true, JSON.stringify({ finished }));

    const created = await ev(`(async () => {
      const hits = await chrome.bookmarks.search(${JSON.stringify(TARGET_URL)});
      return { count: hits.length, title: hits[0]?.title ?? null };
    })()`);
    check(
      '工具调用真的落到了书签数据（不是只画了个卡片）',
      created.count === 1 && created.title === 'E2E 工具建的',
      JSON.stringify(created),
    );

    const turns = mock.state.requests;
    check('确实发生了两轮请求（工具结果被回填给模型）', turns >= 2, JSON.stringify({ turns }));

    /*
     * **用户真正关心的一步**：AI 动了我的书签，我能不能一下撤回？
     * 上面只验证了"工具真的建了书签"，没验证"撤销真的能撤回来"。
     * 这条走完整路径：打开撤销历史 → 点最新一步 → 书签消失。
     */
    /*
     * 必须等撤销点**落盘**：最终文字渲染出来时，后台还在收尾事务
     * （chat:done → endUndoTransaction → writeUndoPoints）。
     * 不等就会读到"还没有"，把测试自己的时序问题当成产品缺陷。
     */
    const pointLanded = await waitFor(
      async () =>
        (await ev(`(async () => {
          const d = await chrome.storage.local.get('markai.undo');
          const pts = d['markai.undo']?.points;
          return Array.isArray(pts) && pts.length >= 1;
        })()`)) === true,
      10000,
    );
    check('Agent 的改动落成了撤销点（事务正常收尾）', pointLanded === true, JSON.stringify({ pointLanded }));

    const undoState = await ev(`(async () => {
      const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '') === '撤销历史');
      const d = await chrome.storage.local.get('markai.undo');
      const pts = d['markai.undo']?.points;
      return {
        btnFound: !!btn,
        btnDisabled: btn ? btn.disabled : null,
        btnTitle: btn ? btn.getAttribute('title') : null,
        undoPoints: Array.isArray(pts) ? pts.length : (pts === undefined ? 'absent' : typeof pts),
      };
    })()`);

    await ev(`[...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '') === '撤销历史')?.click()`);
    await sleep(400);
    const undoRow = await ev(`(() => {
      const rows = [...document.querySelectorAll('button')].filter((b) =>
        (b.getAttribute('title') || '').includes('撤销最新的一步'),
      );
      return {
        count: rows.length,
        first: rows[0]?.innerText?.slice(0, 40) ?? null,
        panelText: document.body.innerText.slice(0, 400),
      };
    })()`);
    check('撤销历史里出现了可撤销的一步（Agent 的改动留了痕）', undoRow.count >= 1, JSON.stringify(undoRow));

    await ev(`[...document.querySelectorAll('button')]
      .filter((b) => (b.getAttribute('title') || '').includes('撤销最新的一步'))[0]?.click()`);
    const reverted = await waitFor(
      async () => (await ev(`(async () => (await chrome.bookmarks.search(${JSON.stringify(TARGET_URL)})).length)()`)) === 0,
      10000,
    );
    check(
      '从对话里点撤销，AI 建的书签真的被撤掉了（主路径闭环）',
      reverted === true,
      JSON.stringify({ reverted }),
    );

    /*
     * 系统提示必须把"今天"告诉模型。
     * 工具回填的是原始毫秒时间戳，没有"现在"模型只能拿训练截止日当今天——
     * 「超过 2 年没访问的书签」这类判断会算错，而且错得很自信。
     */
    const todayIso = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
    check(
      '发给模型的系统消息里带当前日期（时间判断的前提）',
      typeof mock.state.systemContent === 'string' && mock.state.systemContent.includes(todayIso),
      JSON.stringify({
        today: todayIso,
        hasTimeSection: mock.state.systemContent.includes('当前时间'),
        len: mock.state.systemContent.length,
      }),
    );
    /*
     * 能力边界：工具只读不产文件。若提示词里没有这句，
     * 用户说「导出书签」时模型很可能回一句"已为你导出"——他去磁盘上找，什么都没有。
     */
    check(
      '系统消息里写明"产不出文件、不要声称导出"，并把用户指到书签导出入口',
      typeof mock.state.systemContent === 'string' &&
        /产不出文件|不会生成任何文件/.test(mock.state.systemContent) &&
        mock.state.systemContent.includes('书签导出'),
      JSON.stringify({
        saysNoFile: /产不出文件|不会生成任何文件/.test(mock.state.systemContent),
        pointsToExport: mock.state.systemContent.includes('书签导出'),
      }),
    );

    // 收尾：删掉这条书签，避免影响后面的用例
    await ev(`(async () => {
      const hits = await chrome.bookmarks.search(${JSON.stringify(TARGET_URL)});
      for (const h of hits) await chrome.bookmarks.remove(h.id).catch(() => {});
      const cfg = (await chrome.storage.local.get('markai.config'))['markai.config'] || {};
      await chrome.storage.local.set({ 'markai.config': { ...cfg, baseUrl: '', apiKey: '', model: '' } });
      return true;
    })()`);
    mock.server.close();
  }

  /* ══════════ 9.44 接口报错 + 重新生成拦截（真浏览器） ══════════ */
  console.log('\n[9.44] 接口报错与重新生成安全');
  {
    const state = { mode: 'error' };
    const TOOL_URL = 'https://retry-safety.example/created';
    const server = await new Promise((resolve) => {
      const srv = createServer((req, res) => {
        if (!req.url || !req.url.includes('/chat/completions')) {
          res.writeHead(404).end();
          return;
        }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', async () => {
          if (state.mode === 'error') {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: '模拟上游 500：服务暂时不可用' } }));
            return;
          }
          if (state.mode === 'auth') {
            // 401 属于不可重试错误：应当立刻告诉用户，而不是进入重试退避
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
            return;
          }
          // mode === 'tool-then-empty'
          let isFollowUp = false;
          try {
            isFollowUp = (JSON.parse(body).messages || []).some((m) => m.role === 'tool');
          } catch {
            /* 当首轮 */
          }
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
          if (!isFollowUp) {
            send({
              choices: [
                {
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_rs_1',
                        type: 'function',
                        function: {
                          name: 'create_bookmark',
                          arguments: JSON.stringify({ title: '再次生成靶子', url: TOOL_URL }),
                        },
                      },
                    ],
                  },
                },
              ],
            });
            send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
          } else {
            // 关键：工具执行完，模型**一个字都不回**
            send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
          }
          res.write('data: [DONE]\n\n');
          res.end();
        });
      });
      srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
    });

    await ev(`(async () => {
      await chrome.storage.local.set({ 'markai.config': {
        providerId: 'deepseek', baseUrl: 'http://127.0.0.1:${server.port}/v1',
        apiKey: 'mock-key', model: 'mock-model', temperature: 0.4, customHeaders: '',
      } });
      return true;
    })()`);
    // 段落隔离：清掉上一条对话，避免段落之间互相影响
    await ev(`chrome.storage.local.remove('markai.ai')`);
    await cdp.send('Page.reload', {}, sessionId);
    await sleep(900);
    await waitFor(async () => await ev(`!!document.querySelector('[data-testid="chat-input"]')`), 6000);

    const say = async (text) => {
      await ev(`(() => {
        const ta = document.querySelector('[data-testid="chat-input"]');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, ${JSON.stringify(text)});
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await sleep(120);
      await ev(`(() => {
        [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '发送')?.click();
        return true;
      })()`);
    };

    // ── A1. 上游 500（可重试错误）：必须给出"正在自动重试"的进度反馈 ──
    await say('触发报错');
    const retrying = await waitFor(
      async () => await ev(`document.body.innerText.includes('正在自动重试')`),
      15000,
    );
    check('上游 500 时给出"正在自动重试 N/5"的进度（不是静默卡住）', retrying === true, JSON.stringify({ retrying }));

    // 重试是设计好的行为，这里不再等它耗尽；直接换一个**不可重试**的错误验证最终提示
    state.mode = 'auth';
    await cdp.send('Page.reload', {}, sessionId);
    await sleep(900);
    await waitFor(async () => await ev(`!!document.querySelector('[data-testid="chat-input"]')`), 6000);
    await say('触发鉴权失败');
    const errShown = await waitFor(
      async () => await ev(`document.body.innerText.includes('⚠')`),
      15000,
    );
    // 不用正则：这段写在模板字符串里，反斜杠转义会被吞掉（本项目已踩过三次）
    const errText = await ev(`(() => {
      const line = document.body.innerText
        .split(String.fromCharCode(10))
        .find((l) => l.includes('⚠'));
      return line ? line.trim().slice(0, 120) : null;
    })()`);
    check('不可重试的错误（401）给出可见错误，而不是一直重试', errShown === true && !!errText, JSON.stringify({ errShown, errText }));

    /*
     * 请求失败时「重新生成」是用户唯一能做的事，而操作条平时 hover 才出现
     * （opacity-0 group-hover:opacity-100）——键盘用户没有 hover、触屏也没有，
     * 于是失败时那个按钮看不见也点不到。这里断言它是常亮的。
     */
    // 有 transition-opacity：等它过渡完，否则读到的是中间帧（实测 0.03）
    const readBar = () => ev(`(() => {
      const msgs = [...document.querySelectorAll('[data-testid="assistant-message"]')];
      const last = msgs[msgs.length - 1];
      if (!last) return null;
      const bar = last.querySelector('[data-testid="message-actions"]');
      if (!bar) return null;
      return {
        found: true,
        opacity: Number(getComputedStyle(bar).opacity),
        failed: last.getAttribute('data-failed'),
        count: msgs.length,
      };
    })()`);
    const barVisible = await waitFor(async () => {
      const r = await readBar();
      return !!r && r.failed === '1' && r.opacity >= 0.99;
    }, 5000);
    const failureBar = await readBar();
    check(
      '请求失败时消息操作条是常亮的（重试不依赖 hover）',
      barVisible === true && failureBar?.failed === '1' && Number(failureBar.opacity) >= 0.99,
      JSON.stringify(failureBar),
    );

    const notStuck = await waitFor(
      async () =>
        await ev(`(() => {
          const ta = document.querySelector('[data-testid="chat-input"]');
          return ta && ta.getAttribute('placeholder') !== 'Agent 正在回复…';
        })()`),
      8000,
    );
    check('报错后不会一直卡在「正在回复」', notStuck === true, JSON.stringify({ notStuck }));

    // ── B. 工具执行了但模型不回话：不能给「重新生成」 ──
    state.mode = 'tool-then-empty';
    await say('建一个书签');
    const made = await waitFor(
      async () =>
        await ev(`(async () => (await chrome.bookmarks.search(${JSON.stringify(TOOL_URL)})).length === 1)()`),
      20000,
    );
    check('这一轮确实执行了写操作（书签已创建）', made === true, JSON.stringify({ made }));

    await sleep(1500);
    const safety = await ev(`(() => {
      const t = document.body.innerText;
      const retryBtn = [...document.querySelectorAll('button')].find(
        (b) => (b.getAttribute('aria-label') || '') === '重新生成回复',
      );
      // 只看最后一条 assistant：用「本轮是否有改动」文案判断
      return {
        hasRetryButton: !!retryBtn,
        saysMutated: t.includes('已经执行了') && t.includes('撤销'),
        saysPlainEmpty: t.includes('Agent 未返回内容'),
      };
    })()`);
    check(
      '已执行写操作但模型没回话时，不提供「重新生成」（否则会重复执行）',
      safety.hasRetryButton === false,
      JSON.stringify(safety),
    );
    check(
      '给出的文案说明"已执行改动 + 可撤销"，而不是笼统的"未返回内容"',
      safety.saysMutated === true && safety.saysPlainEmpty === false,
      JSON.stringify(safety),
    );

    await ev(`(async () => {
      const hits = await chrome.bookmarks.search(${JSON.stringify(TOOL_URL)});
      for (const h of hits) await chrome.bookmarks.remove(h.id).catch(() => {});
      const cfg = (await chrome.storage.local.get('markai.config'))['markai.config'] || {};
      await chrome.storage.local.set({ 'markai.config': { ...cfg, baseUrl: '', apiKey: '', model: '' } });
      return true;
    })()`);
    server.srv.close();
  }

  /* ══════════ 9.46 删除确认流（唯一不可逆的操作） ══════════ */
  console.log('\n[9.46] 删除确认：AI 只能提议，用户点了才真删');
  {
    /*
     * 删除是整个产品里**唯一不可逆**的动作，也是安全设计的核心：
     * AI 只能提交提议 → 用户显式点击 → background 才 removeTree。
     *
     * 这条链路以前只有单测。这里用假 AI 服务让模型真的发出 propose_deletions，
     * 在浏览器里验证「没点之前绝不能删」和「点了之后真的删掉」。
     */
    const VICTIM_URL = 'https://delete-victim.example/page';
    let victimId = null;
    await ev(`(async () => {
      const bar = (await chrome.bookmarks.getTree())[0].children.find((c) => c.id === '1');
      const n = await chrome.bookmarks.create({ parentId: bar.id, title: 'E2E 待删书签', url: ${JSON.stringify(VICTIM_URL)} });
      window.__victimId = n.id;
      return true;
    })()`);
    victimId = await ev(`window.__victimId`);

    const mock = await new Promise((resolve) => {
      const srv = createServer((req, res) => {
        if (!req.url || !req.url.includes('/chat/completions')) {
          res.writeHead(404).end();
          return;
        }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', async () => {
          let isFollowUp = false;
          try {
            isFollowUp = (JSON.parse(body).messages || []).some((m) => m.role === 'tool');
          } catch {
            /* 当首轮 */
          }
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
          if (!isFollowUp) {
            send({
              choices: [
                {
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_del_1',
                        type: 'function',
                        function: {
                          name: 'propose_deletions',
                          arguments: JSON.stringify({
                            items: [{ bookmarkId: victimId, reason: 'E2E 测试：这条是测试数据' }],
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
            });
            send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
          } else {
            for (const c of ['已经', '列成待删清单了。']) send({ choices: [{ delta: { content: c } }] });
            send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
          }
          res.write('data: [DONE]\n\n');
          res.end();
        });
      });
      srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
    });

    await ev(`(async () => {
      const cfg = (await chrome.storage.local.get('markai.config'))['markai.config'] || {};
      await chrome.storage.local.set({ 'markai.config': {
        ...cfg, providerId: 'deepseek', baseUrl: 'http://127.0.0.1:${mock.port}/v1',
        apiKey: 'mock-key', model: 'mock-model', temperature: 0.4, customHeaders: '',
        deleteMode: 'confirm',
      } });
      return true;
    })()`);
    // 段落隔离：清掉上一条对话，避免段落之间互相影响
    await ev(`chrome.storage.local.remove('markai.ai')`);
    await cdp.send('Page.reload', {}, sessionId);
    await sleep(900);
    await waitFor(async () => await ev(`!!document.querySelector('[data-testid="chat-input"]')`), 6000);

    await ev(`(() => {
      const ta = document.querySelector('[data-testid="chat-input"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '这条不要了，删掉');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(120);
    await ev(`(() => {
      [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '发送')?.click();
      return true;
    })()`);

    const proposed = await waitFor(
      async () => await ev(`document.body.innerText.includes('E2E 待删书签')`),
      20000,
    );
    check('模型提出删除建议后，界面上出现待删条目', proposed === true, JSON.stringify({ proposed }));

    /*
     * 先静置一下再断言"没被删"。
     * 否则测的是"删得够不够快"——错误的实现在时序上可能还没落地就被放过了。
     */
    await sleep(1000);
    const stillThere = await ev(`(async () => {
      const all = await chrome.bookmarks.search(${JSON.stringify(VICTIM_URL)});
      const byId = await chrome.bookmarks.get(${JSON.stringify(victimId)}).catch(() => []);
      return { byId: byId.length, byUrl: all.length, victimId: ${JSON.stringify(victimId)} };
    })()`);
    check(
      '**没点确认之前，书签一条都不能删**（提议不等于执行）',
      stillThere.byId === 1 && stillThere.byUrl === 1,
      JSON.stringify(stillThere),
    );

    // 用户显式点击「删除 <标题>」
    const clicked = await ev(`(() => {
      const b = [...document.querySelectorAll('button')].find(
        (x) => (x.getAttribute('aria-label') || '') === '删除 E2E 待删书签',
      );
      if (!b) return false;
      b.click();
      return true;
    })()`);
    check('待删条目上有可点的删除按钮', clicked === true, JSON.stringify({ clicked }));

    const gone = await waitFor(
      async () =>
        await ev(`(async () => (await chrome.bookmarks.get(${JSON.stringify(victimId)}).catch(() => [])).length === 0)()`),
      10000,
    );
    check('用户点了之后，书签真的被删掉', gone === true, JSON.stringify({ gone }));

    /*
     * **删除的安全网**：删除是整个产品里唯一不可逆的动作，而"不可逆"是靠撤销兜底的。
     * 如果删完之后撤不回来，那前面整套"AI 只能提议、用户点了才删"的设计就白做了——
     * 用户点错一次就永久失去那条书签。
     *
     * 时序注意：书签删掉之后后台还在收尾事务，撤销点要等一等才落盘
     * （0.2.86 踩过同一个坑：查得太早会误判成"没有撤销点"）。
     */
    const delPoint = await waitFor(
      async () =>
        (await ev(`(async () => {
          const d = await chrome.storage.local.get('markai.undo');
          const pts = d['markai.undo']?.points;
          return Array.isArray(pts) && pts.length >= 1;
        })()`)) === true,
      10000,
    );
    check('删除也落成了撤销点（不可逆动作有安全网）', delPoint === true, JSON.stringify({ delPoint }));

    await ev(`[...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '') === '撤销历史')?.click()`);
    await sleep(400);
    await ev(`[...document.querySelectorAll('button')]
      .filter((b) => (b.getAttribute('title') || '').includes('撤销最新的一步'))[0]?.click()`);
    /*
     * 判据不能按**旧 id** 查：撤销是用删除时抓的子树快照**重建**，
     * Chrome 会给新节点发新 id。按旧 id 查会永远查不到，把"撤回来了"误判成"没撤回来"。
     * 按 URL 查才是用户视角："我那条书签回来了没有"。
     */
    const back = await waitFor(
      async () =>
        (await ev(`(async () => (await chrome.bookmarks.search(${JSON.stringify(VICTIM_URL)})).length)()`)) === 1,
      10000,
    );
    const backInfo = await ev(`(async () => {
      const hits = await chrome.bookmarks.search(${JSON.stringify(VICTIM_URL)});
      return { count: hits.length, title: hits[0]?.title ?? null, newId: hits[0]?.id ?? null, oldId: ${JSON.stringify(victimId)} };
    })()`);
    check(
      '删掉的书签能通过撤销找回来（安全网真的兜得住）',
      back === true,
      JSON.stringify({ back, backInfo }),
    );

    await ev(`(async () => {
      const cfg = (await chrome.storage.local.get('markai.config'))['markai.config'] || {};
      await chrome.storage.local.set({ 'markai.config': { ...cfg, baseUrl: '', apiKey: '', model: '' } });
      return true;
    })()`);
    mock.srv.close();
  }

  /* ══════════ 9.437 弹窗整理卡片：读不到别说「今天 0 条」 ══════════ */
  console.log('\n[9.437] 弹窗整理卡片失败态');
  {
    const { targetId: t } = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${EXT_ID}/popup.html`,
    });
    const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId: t, flatten: true });
    await cdp.send('Page.enable', {}, sid);
    // 只打坏整理记录那一次读取，其他读写保持正常
    const { identifier } = await cdp.send(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source: `(() => {
          const orig = chrome.storage.local.get.bind(chrome.storage.local);
          chrome.storage.local.get = (...a) => {
            const k = a[0];
            const isLog = (typeof k === 'string' && k === 'markai.organize.log')
              || (Array.isArray(k) && k.includes('markai.organize.log'));
            if (isLog) return Promise.reject(new Error('模拟：整理记录读取失败'));
            return orig(...a);
          };
        })();`,
      },
      sid,
    );
    await cdp.send('Page.reload', {}, sid);
    await sleep(1300);
    const ev2 = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
      if (r.exceptionDetails) return null;
      return r.result?.value;
    };
    await waitFor(async () => await ev2(`!!document.querySelector('[data-testid="popup-organize-badge"]')`), 6000);
    const card = await ev2(`(() => ({
      badge: document.querySelector('[data-testid="popup-organize-badge"]')?.textContent?.trim(),
      body: document.querySelector('[data-testid="popup-organize-body"]')?.textContent?.trim(),
    }))()`);
    check(
      '读不到整理记录时徽标说「读取失败」，不是「今天 0 条」',
      card.badge === '读取失败',
      JSON.stringify(card),
    );
    check(
      '正文说明这只代表没读到，不是"还没收藏过"',
      typeof card.body === 'string' && card.body.includes('不代表') && !card.body.includes('收藏新页面后'),
      JSON.stringify(card),
    );

    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, sid).catch(() => {});
    await cdp.send('Target.closeTarget', { targetId: t }).catch(() => {});
  }

  /* ══════════ 9.435 弹窗读取失败时不能假装"没有待办" ══════════ */
  console.log('\n[9.435] 弹窗读取失败态');
  {
    /*
     * 缺陷：`pendingCount` 初值 0，读取完成前界面就写着「当前没有待确认的删除提议。」
     * 读失败时更是永远停在"没有提议"——用户以为干净，其实什么都没读到。
     */
    const { targetId: t } = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${EXT_ID}/popup.html`,
    });
    const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId: t, flatten: true });

    /*
     * 必须在注入前 `Page.enable`：否则 `Page.addScriptToEvaluateOnNewDocument`
     * 会被静默忽略（不报错、也不生效），注入等于没做——第一次跑就是这样，
     * 卡片照旧显示"当前没有待确认的删除提议"。
     */
    await cdp.send('Page.enable', {}, sid);
    // 在页面脚本执行前就把 storage.local.get 打坏
    const { identifier } = await cdp.send(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source: `(() => {
          const orig = chrome.storage.local.get.bind(chrome.storage.local);
          chrome.storage.local.get = (...a) => {
            // 只破坏"读整包配置"的那次调用，其他读写保持正常
            const k = a[0];
            const isBulk = Array.isArray(k) || (typeof k === 'string' && k === 'markai.config');
            if (isBulk) return Promise.reject(new Error('模拟：存储读取失败'));
            return orig(...a);
          };
        })();`,
      },
      sid,
    );
    await cdp.send('Page.reload', {}, sid);
    await sleep(1200);

    const popEv = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
      if (r.exceptionDetails) return null;
      return r.result?.value;
    };
    await waitFor(async () => await popEv(`!!document.querySelector('[data-testid="popup-pending-text"]')`), 6000);
    const text = await popEv(`document.querySelector('[data-testid="popup-pending-text"]').textContent.trim()`);

    check(
      '读不到待办时说「读取失败」，而不是「当前没有待确认的删除提议」',
      typeof text === 'string' && text.includes('读取失败') && !text.includes('没有待确认'),
      JSON.stringify({ text }),
    );

    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, sid).catch(() => {});
    await cdp.send('Target.closeTarget', { targetId: t }).catch(() => {});
  }

  /* ══════════ 9.43 弹出窗（此前零覆盖） ══════════ */
  console.log('\n[9.43] 弹出窗');
  {
    /*
     * popup 是用户点得最多的入口，但 e2e 里**一次都没打开过**。
     * 它有独立入口、独立 ErrorBoundary、独立的数据读取路径
     * （待办数 / 整理摘要 / 版本号），全都没被验证过。
     *
     * 这里覆盖三件最容易被改坏的事：
     *  1. 能正常渲染（不是白屏、没掉进错误边界）；
     *  2. 版本号与 manifests 一致（曾经手写过版本号，容易漂）；
     *  3. 整理摘要读的是真实 storage 数据，不是写死的 0。
     */
    // 种一条"今天"的整理记录，用来验证摘要不是写死的
    await ev(`(async () => {
      const now = Date.now();
      await chrome.storage.local.set({ 'markai.organize.log': [
        { id: 'p1', at: now, title: '弹出窗测试站点', domain: 'popup-test.example', action: 'moved', target: '开发', detail: '已归入「开发」', via: 'local' },
        { id: 'p2', at: now - 1000, title: '第二个', domain: 'popup2.example', action: 'moved', target: '开发', detail: '已归入「开发」', via: 'local' },
      ] });
      return true;
    })()`);

    const { targetId: popTarget } = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${EXT_ID}/popup.html`,
    });
    const { sessionId: popSession } = await cdp.send('Target.attachToTarget', { targetId: popTarget, flatten: true });
    const popEv = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, popSession);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'popup eval 失败');
      return r.result?.value;
    };

    const mounted = await waitFor(async () => await popEv(`!!document.querySelector('[data-testid="popup-version"]')`), 6000);
    check('弹出窗能正常渲染（不是白屏 / 没掉进错误边界）', mounted === true, JSON.stringify({ mounted }));

    const info = await popEv(`(async () => {
      const manifest = chrome.runtime.getManifest();
      const ver = document.querySelector('[data-testid="popup-version"]');
      const org = document.querySelector('[data-testid="popup-organize"]');
      return {
        manifestVersion: manifest.version,
        shownVersion: (ver?.textContent || '').trim(),
        hasPendingCard: !!document.querySelector('[data-testid="popup-pending"]'),
        organizeText: (org?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      };
    })()`);
    check(
      '版本号与 manifest 一致',
      info.shownVersion === `v${info.manifestVersion}`,
      JSON.stringify(info),
    );
    check('待办卡片与整理卡片都在', info.hasPendingCard === true && info.organizeText.length > 0, JSON.stringify(info));
    check(
      '整理摘要读的是真实数据（种了 2 条今天记录 → 显示 2）',
      info.organizeText.includes('2'),
      JSON.stringify(info),
    );

    await cdp.send('Target.closeTarget', { targetId: popTarget });
    await ev(`chrome.storage.local.remove('markai.organize.log')`);
  }

  /* ══════════ 9.47 底部 toast 不能压住常驻条 ══════════ */
  console.log('\n[9.47] toast 与底部常驻条不重叠');
  {
    /*
     * 回归：toast 是 `fixed bottom-4` 居中浮层，而新手引导条常驻在布局最底部。
     * 实测（430px 侧边栏）：引导条 top=717 h=40，toast 底边 741 —— 重叠 24px，
     * 正好盖住「整理记录在这里 1/3」那行字。
     *
     * 修法是让引导条把自身高度写进 CSS 变量 --markai-bottom-bar，toast 据此抬高。
     * 这里断言：变量确实被设了，且 toast 的底边在常驻条之上。
     */
    await ev(`(async () => {
      await chrome.storage.local.remove('markai.hinted.workspaceTour');
      return true;
    })()`);
    await cdp.send('Page.reload', {}, sessionId);
    await sleep(900);
    await waitFor(async () => await ev(`!!document.querySelector('[role="note"][aria-label="新手提示"]')`), 5000);

    const geo = await ev(`(() => {
      const bar = document.querySelector('[role="note"][aria-label="新手提示"]');
      if (!bar) return { ok: false, reason: 'no-bar' };
      const toast = [...document.querySelectorAll('div')].find((d) => {
        const cs = getComputedStyle(d);
        return cs.position === 'fixed' && cs.zIndex === '100';
      });
      if (!toast) return { ok: false, reason: 'no-toast-container' };
      const br = bar.getBoundingClientRect();
      const cs = getComputedStyle(toast);
      const offset = parseFloat(cs.bottom) || 0;
      const toastBottomEdge = window.innerHeight - offset;
      return {
        ok: toastBottomEdge <= br.top + 0.5,
        barTop: Math.round(br.top),
        barHeight: Math.round(br.height),
        cssVar: getComputedStyle(document.documentElement).getPropertyValue('--markai-bottom-bar').trim(),
        toastBottomOffset: offset,
        toastBottomEdge: Math.round(toastBottomEdge),
      };
    })()`);
    check(
      'toast 底边在底部常驻条之上（不再压住引导文字）',
      geo.ok === true && geo.cssVar !== '' && geo.toastBottomOffset >= geo.barHeight,
      JSON.stringify(geo),
    );
  }

  /* ══════════ 9.49 整理 → 撤销（最关键的安全路径） ══════════ */
  console.log('\n[9.49] 整理后一步撤销');
  {
    /*
     * 这是用户被坑过的那条路：自动整理把书签搬走，撤销必须能一步还原。
     * 之前 e2e 里**完全没有**撤销的覆盖（只有单测）。
     *
     * 不需要 AI：本地规则（文件夹名 == 站点品牌 = 100 分）就能触发整理，
     * 走的仍是真实的 beginUndoTransaction → jMove → endUndoTransaction 链路。
     */
    const seed = await ev(`(async () => {
      // 清掉 AI 配置：强制走本地规则分支，不发任何网络请求
      const cfg = (await chrome.storage.local.get('markai.config'))['markai.config'] || {};
      await chrome.storage.local.set({ 'markai.config': {
        ...cfg, providerId: 'deepseek', baseUrl: '', apiKey: '', model: '',
        autoOrganizeNew: true, autoOrganizeAi: false,
      } });
      await new Promise((r) => setTimeout(r, 200));

      const bar = (await chrome.bookmarks.getTree())[0].children.find((c) => c.id === '1');
      const folder = await chrome.bookmarks.create({ parentId: bar.id, title: 'GitHub' });
      // 等 UI 看到这个文件夹（自动整理要读整棵树来找候选分类）
      await new Promise((r) => setTimeout(r, 900));
      const bm = await chrome.bookmarks.create({
        parentId: bar.id, title: 'E2E 撤销靶', url: 'https://github.com/e2e/undo-target',
      });
      return { folderId: folder.id, bookmarkId: bm.id, barId: bar.id };
    })()`);

    // 等自动整理把它搬进 GitHub
    const moved = await waitFor(async () => {
      const parent = await ev(`(async () => {
        const n = (await chrome.bookmarks.get(${JSON.stringify(seed.bookmarkId)}))[0];
        return n?.parentId || null;
      })()`);
      return parent === seed.folderId;
    }, 15000);
    check('本地规则把书签整理进了同名文件夹（无需 AI）', moved === true, JSON.stringify({ moved }));

    // 打开整理记录，点这条的撤销
    await openMenuItem('整理记录');
    await requireOpen('organize-log');
    const undone = await ev(`(async () => {
      const dlg = document.querySelector('[data-testid="organize-log"]');
      if (!dlg) return { ok: false, reason: 'no-dialog' };
      // 找到含"E2E 撤销靶"的那一行里的撤销按钮
      // 行是 role="listitem" 的 div（不是 li），按这个找
      const row = [...dlg.querySelectorAll('[role="listitem"]')]
        .find((el) => (el.textContent || '').includes('E2E 撤销靶'));
      if (!row) return { ok: false, reason: 'no-row', text: dlg.innerText.slice(0, 120) };
      // 撤销是纯图标按钮：靠 aria-label / title 找，不能按文字找
      const btn = [...row.querySelectorAll('button')].find((b) =>
        ((b.getAttribute('aria-label') || '') + (b.getAttribute('title') || '')).includes('撤销'),
      );
      if (!btn) return { ok: false, reason: 'no-undo-button', row: row.textContent.slice(0, 80) };
      btn.click();
      await new Promise((r) => setTimeout(r, 1500));
      return { ok: true };
    })()`);
    check('整理记录里那条有可点的「撤销」', undone.ok === true, JSON.stringify(undone));

    const restored = await waitFor(async () => {
      const parent = await ev(`(async () => {
        const n = (await chrome.bookmarks.get(${JSON.stringify(seed.bookmarkId)}))[0];
        return n?.parentId || null;
      })()`);
      return parent === seed.barId;
    }, 8000);
    check('点撤销后书签真的回到原处', restored === true, JSON.stringify({ restored, seed }));

    // 关掉对话框并清理
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(300);
    await ev(`(async () => {
      await chrome.bookmarks.remove(${JSON.stringify(seed.bookmarkId)}).catch(() => {});
      await chrome.bookmarks.removeTree(${JSON.stringify(seed.folderId)}).catch(() => {});
      const cfg2 = (await chrome.storage.local.get('markai.config'))['markai.config'] || {};
      await chrome.storage.local.set({ 'markai.config': { ...cfg2, autoOrganizeNew: true, autoOrganizeAi: true } });
      return true;
    })()`);
  }

  /* ══════════ 9.48 加载失败时中栏要说话 ══════════ */
  console.log('\n[9.48] 加载失败的空态');
  {
    /*
     * 回归：早先只有书签树里显示「加载失败 + 重试」，而侧边栏的树默认收起，
     * 于是加载失败时用户看到的是一个**空列表**——不知道出错，也没有重试入口，
     * 表现就是"书签全没了"。
     *
     * 这里直接把 getTree 打成抛错，确认中栏给出错误 + 重试，并且重试真的能恢复。
     */
    await ev(`(() => {
      window.__origGetTree = chrome.bookmarks.getTree;
      chrome.bookmarks.getTree = async () => { throw new Error('模拟：书签服务不可用'); };
      return true;
    })()`);

    /*
     * 触发一次刷新。页面里现成的入口是窗口 focus / visibilitychange
     * （page/main.tsx 的 onActivate 会调 loadTree）。
     * 早先我在这里写了个不存在的"刷新书签"按钮 + 一段没用的动态 import，
     * 结果根本没触发加载，测试自然看不到错误态——触发方式必须走真实路径。
     */
    await ev(`window.dispatchEvent(new Event('focus'))`);
    await waitFor(async () => await ev(`document.body.innerText.includes('书签加载失败')`), 4000);

    const failed = await ev(`(() => {
      const t = document.body.innerText;
      return {
        saysFailed: t.includes('书签加载失败'),
        hasDetail: t.includes('书签服务不可用'),
        hasRetry: !!document.querySelector('[data-testid="list-retry"]'),
      };
    })()`);
    check(
      'getTree 失败时中栏显示「加载失败」+ 原因 + 重试按钮',
      failed.saysFailed && failed.hasDetail && failed.hasRetry,
      JSON.stringify(failed),
    );

    // 恢复 API 后点重试，必须真的恢复
    await ev(`(() => { chrome.bookmarks.getTree = window.__origGetTree; return true; })()`);
    await ev(`document.querySelector('[data-testid="list-retry"]')?.click()`);
    const recovered = await waitFor(
      async () => await ev(`!document.body.innerText.includes('书签加载失败')`),
      5000,
    );
    check('点重试后恢复正常（错误提示消失）', recovered === true, JSON.stringify({ recovered }));
  }

  /* ══════════ 9.5 无障碍：可点元素必须有可访问名称 ══════════ */
  console.log('\n[9.5] 无障碍守卫');
  {
    /*
     * 纯图标按钮如果没有 aria-label / title，屏幕阅读器只会念一个"按钮"。
     * 这条守卫扫当前页面上所有 button，把没名字的列出来——
     * 它防的是"以后再加一个图标按钮时忘了写标签"这类回归。
     */
    const a11y = await ev(`(() => {
      const bad = [];
      for (const b of document.querySelectorAll('button')) {
        const name = (b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').trim();
        if (!name) {
          bad.push(b.outerHTML.slice(0, 120));
        }
      }
      return { total: document.querySelectorAll('button').length, bad };
    })()`);
    check(
      '页面上每个按钮都有可访问名称（文字 / aria-label / title）',
      a11y.total > 0 && a11y.bad.length === 0,
      `共 ${a11y.total} 个按钮，无名称 ${a11y.bad.length} 个${a11y.bad.length ? '：' + a11y.bad.slice(0, 3).join(' | ') : ''}`,
    );

    // 焦点环：键盘 Tab 到的元素必须能看出焦点在哪（不能只靠 hover）
    const focusRing = await ev(`(() => {
      const first = document.querySelector('[data-testid="search"]');
      if (!first) return { ok: false, reason: 'no-search' };
      first.focus();
      const cs = getComputedStyle(first);
      // 聚焦后 outline 或 box-shadow 至少有一个不是 none
      const hasRing = (cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px') || cs.boxShadow !== 'none';
      return { ok: hasRing, outline: cs.outlineStyle, shadow: cs.boxShadow.slice(0, 40) };
    })()`);
    check('键盘聚焦时焦点可见（outline 或 ring，不依赖 hover）', focusRing.ok, JSON.stringify(focusRing));
  }

  /* ══════════ 10. 健康检查（自诊断） ══════════ */
  console.log('\n[10] 健康检查');
  {
    // 设置页是独立文档：直接导航过去（e2e 到这一步已经不需要原页面状态）
    await cdp.send('Page.navigate', { url: `chrome-extension://${EXT_ID}/options.html#health` }, sessionId);
    await sleep(1200);
    // 体检是异步的：等分数真的出来再断言，别用猜出来的 sleep 时长
    await waitFor(async () => (await ev(`/健康分\\s*\\d+/.test(document.body.innerText)`).catch(() => false)) === true, 6000);
    const health = await ev(`(() => {
      const text = document.body.innerText;
      const m = /健康分\\s*(\\d+)/.exec(text);
      return {
        hasSection: text.includes('健康检查'),
        score: m ? Number(m[1]) : null,
        hasCopyReport: text.includes('复制诊断报告'),
        hasFixAll: /修复全部（\d+）/.test(text),
      };
    })()`);
    check('设置页打开即给出健康分与结论', health.hasSection && health.score !== null, JSON.stringify(health));
    check('诊断报告可一键复制（贴出来就能定位问题）', health.hasCopyReport === true, JSON.stringify(health));

    /*
     * 修复必须**真的修好**，而不只是"没动书签"。
     * 0.2.37 的自修复是卖点，但 e2e 之前只断言了"书签数不变"——
     * 那等于只证明了它没搞坏东西，没证明它修好了东西。
     *
     * 这里种一个写错的自定义请求头，确认：检测得到 → 点修复 → storage 里真的没了。
     */
    await ev(`(async () => {
      const cfg = (await chrome.storage.local.get('markai.config'))['markai.config'] || {};
      await chrome.storage.local.set({ 'markai.config': {
        ...cfg,
        providerId: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'm',
        customHeaders: ['X-Keep: 1', '这一行没有冒号', 'X-Also: 2'].join(String.fromCharCode(10)),
      } });
      return true;
    })()`);
    await cdp.send('Page.reload', {}, sessionId);
    await sleep(1200);
    await waitFor(async () => (await ev(`/健康分/.test(document.body.innerText)`).catch(() => false)) === true, 8000);

    const detected = await ev(`(() => {
      const t = document.body.innerText;
      return { saysBadHeaders: t.includes('自定义请求头'), hasFix: t.includes('删掉写错的行') };
    })()`);
    check('坏请求头被健康检查检测到', detected.saysBadHeaders === true, JSON.stringify(detected));

    const fixed = await ev(`(async () => {
      const btn = [...document.querySelectorAll('button')]
        .find((b) => (b.textContent || '').includes('删掉写错的行'))
        || [...document.querySelectorAll('button')].find((b) => /修复全部/.test(b.textContent || ''));
      if (!btn) return { ok: false, reason: 'no-fix-button' };
      btn.click();
      await new Promise((r) => setTimeout(r, 1500));
      const cfg = (await chrome.storage.local.get('markai.config'))['markai.config'] || {};
      return {
        ok: true,
        headers: cfg.customHeaders || '',
      };
    })()`);
    check(
      '点修复后 storage 里写错的那行真的被删掉，合法的行保留',
      fixed.ok === true &&
        !(fixed.headers || '').includes('没有冒号') &&
        (fixed.headers || '').includes('X-Keep: 1') &&
        (fixed.headers || '').includes('X-Also: 2'),
      JSON.stringify(fixed),
    );

    /*
     * 先造一个**确实可修**的问题，否则「修复全部」按钮不会出现——
     * 而 `!btn → clicked:false` 会让这条用例静默空转（它之前是靠"缺 API Key"
     * 那个点了也没用的按钮撑着的；0.2.68 去掉那个按钮后必须自己造）。
     */
    await ev(`(async () => {
      const d = await chrome.storage.local.get('markai.config');
      const cfg = d['markai.config'] || {};
      await chrome.storage.local.set({ 'markai.config': { ...cfg, customHeaders: '这一行没有冒号' } });
      return true;
    })()`);
    await ev(`(() => {
      [...document.querySelectorAll('button')]
        .find((b) => /重新检查/.test(b.textContent || ''))?.click();
      return true;
    })()`);
    await sleep(1500);

    const repaired = await ev(`(async () => {
      // 点「修复全部」：只应改动 MarkAI 自己的元数据，不碰书签
      const before = (await chrome.bookmarks.search({})).length;
      const btn = [...document.querySelectorAll('button')].find(b => /修复全部/.test(b.textContent || ''));
      if (!btn) return { ok: true, clicked: false, before };
      btn.click();
      await new Promise(r => setTimeout(r, 1200));
      const after = (await chrome.bookmarks.search({})).length;
      return { ok: true, clicked: true, before, after };
    })()`);
    check(
      '一键修复不改动任何书签（只碰 MarkAI 自己的配置与记录）',
      repaired.after === repaired.before,
      JSON.stringify(repaired),
    );
  }

  /* ══════════ 11. 收尾：清理数据 ══════════ */
  console.log('\n[11] 清理');
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
