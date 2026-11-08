/**
 * MarkAI 视觉审查（CDP，无第三方依赖）
 *
 * 用真实 Chrome 加载已构建扩展，注入一批有代表性的书签数据，然后把各个窗口
 * 截图落盘到 `.output/visual/`。用途：
 *  - UI/UX 改动前后的对照（肉眼先看，再用像素/文本断言）；
 *  - 每次改动后重跑同一组视图，避免「改了 A 弄坏了 B」；
 *  - 给 `--only=` 只重截关心的视图，节省时间。
 *
 * 用法：
 *   node scripts/visual-audit.mjs                 # 全部视图
 *   node scripts/visual-audit.mjs --only=full-light-list,timeline
 *   CHROME_BIN=/path/to/chrome node scripts/visual-audit.mjs
 *
 * 退出码：0 = 全部截图落盘成功；1 = 有视图失败（打印原因）。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const CDP_PORT = process.env.MARKAI_CDP_PORT || 9334;
const CDP = `http://127.0.0.1:${CDP_PORT}`;
const OUT_DIR = new URL('../.output/chrome-mv3', import.meta.url).pathname;
const SHOT_DIR = new URL('../.output/visual', import.meta.url).pathname;
const DEFAULT_CHROME =
  '/Users/xalor/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const CHROME = process.env.CHROME_BIN || DEFAULT_CHROME;
const EXT_ID = 'ojlfhclcoecgjbgklbjcbcfbjjjlhjhd';
const PROFILE = `/tmp/markai-visual-${process.pid}`;

/** 命令行 --only=a,b 过滤视图 */
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',').map((s) => s.trim())) : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launchChrome() {
  if (!existsSync(CHROME)) throw new Error(`找不到 Chrome：${CHROME}（用 CHROME_BIN 指定支持 --load-extension 的版本）`);
  return spawn(
    CHROME,
    [
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${PROFILE}`,
      '--disable-extensions-except=' + OUT_DIR,
      '--load-extension=' + OUT_DIR,
      `--remote-debugging-port=${CDP_PORT}`,
      '--window-size=1440,960',
      '--force-device-scale-factor=2',
      /*
       * 默认 headless。
       *
       * 早先这里没有这个参数：每跑一次就在前台弹一个 1440×960 的窗口抢焦点，
       * 而且屏幕锁了/睡了时 Chrome 根本起不来（表现为 `fetch failed`，
       * 完全指不到真正原因）。headless 两种问题一起解决。
       * 需要肉眼看的时候：`MARKAI_VISUAL_HEADED=1 node scripts/visual-audit.mjs`。
       */
      ...(process.env.MARKAI_VISUAL_HEADED === '1' ? [] : ['--headless=new']),
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
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 25000);
    });
  }
}

/** 有代表性的样本书签：多域名、长标题、中文/英文、不同文件夹层级 */
const SEED = `(async () => {
  const tree = await chrome.bookmarks.getTree();
  const bar = tree[0].children.find(c => c.id === '1');
  const other = tree[0].children.find(c => c.id === '2');
  // 幂等：已有样本目录就复用，避免重复注入
  const existing = (bar.children || []).find(c => c.title === '设计资料');
  const root = existing || await chrome.bookmarks.create({ parentId: bar.id, title: '设计资料' });
  const sub = await chrome.bookmarks.create({ parentId: root.id, title: '动效与交互' }).catch(() => null);
  const items = [
    { parentId: root.id, title: 'Refactoring UI — 设计原则速查', url: 'https://www.refactoringui.com/' },
    { parentId: root.id, title: 'Tailwind CSS v4 文档', url: 'https://tailwindcss.com/docs' },
    { parentId: root.id, title: 'Radix UI Primitives', url: 'https://www.radix-ui.com/primitives' },
    { parentId: (sub && sub.id) || root.id, title: '一个特别长的标题用来测试截断与换行行为——从零构建可访问的动效系统（含 prefers-reduced-motion 完整实践）', url: 'https://example.com/very/long/path/to/article?utm_source=bookmark&id=12345' },
    { parentId: (sub && sub.id) || root.id, title: 'Emil Kowalski · Animations on the Web', url: 'https://animations.dev/' },
  ];
  for (const it of items) {
    await chrome.bookmarks.create(it).catch(() => {});
    await new Promise(r => setTimeout(r, 30));
  }
  /*
   * 书签栏本身也要有内容。
   *
   * 之前种子里书签栏只有一个文件夹，于是"浮层盖在列表上"的视图里列表是空的——
   * 玻璃层下面没有东西可糊，截图看起来跟实心白卡一样，根本判断不了玻璃效果。
   * 真实用户的书签栏本来就是十来个书签，视觉审计的素材必须像那么回事。
   */
  const barHas = (bar.children || []).filter(c => c && c.url).length;
  if (barHas < 8) {
    for (const [title, url] of [
      ['GitHub', 'https://github.com/'],
      ['DeepSeek', 'https://chat.deepseek.com/'],
      ['Vercel 仪表盘', 'https://vercel.com/dashboard'],
      ['Figma', 'https://www.figma.com/files'],
      ['Linear', 'https://linear.app/'],
      ['Notion', 'https://www.notion.so/'],
      ['MDN Web Docs', 'https://developer.mozilla.org/'],
      ['Chrome 扩展文档', 'https://developer.chrome.com/docs/extensions/'],
      ['少数派', 'https://sspai.com/'],
      ['Hacker News', 'https://news.ycombinator.com/'],
    ]) {
      await chrome.bookmarks.create({ parentId: bar.id, title, url }).catch(() => {});
      await new Promise(r => setTimeout(r, 25));
    }
  }

  // 第二组：其他书签里的杂项，让树有多分支
  const misc = await chrome.bookmarks.create({ parentId: other.id, title: '稍后读' }).catch(() => null);
  if (misc) {
    for (const [title, url] of [
      ['GitHub · deepseek-ai/dsh', 'https://github.com/deepseek-ai/dsh'],
      ['MDN Web Docs', 'https://developer.mozilla.org/zh-CN/'],
      ['Hacker News', 'https://news.ycombinator.com/'],
    ]) {
      await chrome.bookmarks.create({ parentId: misc.id, title, url }).catch(() => {});
      await new Promise(r => setTimeout(r, 25));
    }
  }
  return { ok: true };
})()`;

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  const chrome = launchChrome();
  const results = [];
  try {
    for (let i = 0; i < 100; i++) {
      try {
        await getJson('/json/version');
        break;
      } catch {
        await sleep(200);
      }
    }
    const version = await getJson('/json/version');
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((r, j) => {
      ws.addEventListener('open', r);
      ws.addEventListener('error', j);
    });
    const cdp = new Session(ws);

    /** 打开一个扩展页面并等它挂载 */
    async function openPage(url, viewport) {
      const { targetId } = await cdp.send('Target.createTarget', { url });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      await cdp.send('Runtime.enable', {}, sessionId);
      await cdp.send('Page.enable', {}, sessionId);
      if (viewport) {
        await cdp.send(
          'Emulation.setDeviceMetricsOverride',
          { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.dsf ?? 2, mobile: false },
          sessionId,
        );
      }
      const ev = async (expression) => {
        const res = await cdp.send(
          'Runtime.evaluate',
          { expression, awaitPromise: true, returnByValue: true, userGesture: true },
          sessionId,
        );
        if (res.exceptionDetails) {
          throw new Error(`页面执行异常: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
        }
        return res.result.value;
      };
      const waitReady = async (probe, tries = 100) => {
        for (let i = 0; i < tries; i++) {
          if (await ev(probe).catch(() => false)) return true;
          await sleep(120);
        }
        return false;
      };
      const shot = async (name) => {
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
        writeFileSync(`${SHOT_DIR}/${name}.png`, Buffer.from(data, 'base64'));
        results.push({ name, ok: true });
        console.log(`SHOT  ${name}.png`);
        return true;
      };
      return { ev, waitReady, shot, sessionId, targetId };
    }

    /*
     * 通过「更多」菜单打开面板。
     *
     * 0.2.35 把顶栏那一排按钮收进了 `⋯` 菜单，脚本却还在点
     * `button[title^="整理记录"]` —— 点不到，于是**拍了一张基础页当成功**。
     * 07/10/12/14 四张"整理记录"截图全是假的，我据此做的视觉评审也就不作数。
     *
     * 所以这里做两件事：
     *  1. 走真实入口（更多菜单）；
     *  2. **打不开就抛错**——宁可脚本红，也不要一张看起来正常、内容却不对的图。
     */
    const openMenuItem = async (label) => {
      await page.ev(`(() => {
        if (!document.querySelector('[data-testid="more-menu"]')) {
          document.querySelector('[data-testid="more-trigger"]')?.click();
        }
        return true;
      })()`);
      await sleep(250);
      const clicked = await page.ev(`(() => {
        const items = [...document.querySelectorAll('[role="menuitem"]')];
        const hit = items.find((b) => (b.textContent || '').includes(${JSON.stringify(label)}));
        if (!hit) return false;
        hit.click();
        return true;
      })()`);
      await sleep(700);
      return clicked;
    };

    /** 截图前确认面板真的在：不在就抛，不产出假图 */
    const requireOpen = async (testId) => {
      const ok = await page.waitReady(`!!document.querySelector('[data-testid="${testId}"]')`, 30);
      if (!ok) throw new Error(`面板 ${testId} 没有打开，拒绝产出错误截图`);
    };

    /* ── 主页面（完整页）── */
    const page = await openPage(`chrome-extension://${EXT_ID}/page.html`, { width: 1440, height: 900 });
    const ready = await page.waitReady(`!!document.querySelector('header') && !!document.querySelector('input#markai-search')`);
    if (!ready) throw new Error('完整页未在预期时间内挂载');

    // 注入样本，仅在需要数据类视图时做一次
    await page.ev(SEED).catch((e) => console.warn('种子注入失败：', e.message));
    // 注入几条整理记录：对话框与 popup 的「自动整理」卡片需要有真实数据才看得出布局
    await page
      .ev(`(() => {
        const now = Date.now();
        // via 是「判断来源」那一行的数据源：种子必须带上，否则截图里看不到这个新功能
        const mk = (i, title, domain, action, target, detail, at, via) => ({
          id: 'seed-' + i, at, title, url: 'https://' + domain + '/x', domain, action,
          ...(target ? { target } : {}), detail,
          ...(via ? { via } : {}),
          ...(action === 'failed' ? { needsAttention: true, retryable: true } : {}),
        });
        const log = [
          mk(1, 'Radix UI Primitives', 'radix-ui.com', 'moved', '设计资料 / 动效与交互', '已归入「动效与交互」', now - 30_000, 'local'),
          mk(2, 'Tailwind CSS v4 文档', 'tailwindcss.com', 'moved', '设计资料', '已归入「设计资料」（已有「设计资料」分类，站点属于设计）', now - 120_000, 'model'),
          /*
           * 0.2.35 起不再按域名建文件夹（「自动整理/<域名>」整层已删）。
           * 这行种子原先还写着「自动整理 / github.com」——截图里等于展示了一个
           * 已经不存在的功能，看截图的人（包括我）会以为它还在。
           * 改成当前真实会出现的两种落点：进已有分类 / 认不出而留在原地。
           */
          mk(3, 'GitHub · deepseek-ai/dsh', 'github.com', 'moved', '开发', '已归入「开发」（已有「开发」分类，站点属于开发）', now - 600_000, 'fallback'),
          mk(6, '某个小众站点', 'obscure-site.example', 'skipped', null, '没有匹配到你已有的分类，保持原位（不会为你新建按域名的文件夹）', now - 900_000, 'fallback'),
          mk(4, 'Hacker News', 'news.ycombinator.com', 'failed', null, '自动整理失败：The operation was aborted due to timeout', now - 3_600_000),
          // 第二条可重试失败：让「重试全部」按钮出现（只有 1 条时不该占地方）
          mk(5, 'Lobsters', 'lobste.rs', 'failed', null, '自动整理失败：HTTP 503', now - 7_200_000),
        ];
        // 顺便放两个「免打扰」站点：面板底部那一行需要有真实数据才看得出排版
        return chrome.storage.local
          .set({
            'markai.organize.log': log,
            'markai.organize.optout': [
              { domain: 'news.ycombinator.com', at: now - 6e5 },
              { domain: 'github.com', at: now - 12e5 },
            ],
          })
          .then(() => true);
      })()`)
      .catch((e) => console.warn('整理日志注入失败：', e.message));
    await cdp.send('Page.reload', {}, page.sessionId);
    await page.waitReady(`!!document.querySelector('header')`, 100);
    await sleep(600);

    const want = (n) => !ONLY || ONLY.has(n);

    // 1) 完整页 · 浅色 · 列表
    if (want('full-light-list')) {
      await page.ev(`chrome.storage.local.set({ 'markai.theme': 'light' })`).catch(() => {});
      await cdp.send('Page.reload', {}, page.sessionId);
      await page.waitReady(`!!document.querySelector('header')`, 100);
      await sleep(700);
      await page.shot('01-full-light-list');
    }

    // 1.5) 整理记录对话框：用户要看「它到底动了什么」
    if (want('organize-log')) {
      await openMenuItem('整理记录');
      await requireOpen('organize-log');
      await page.shot('07-organize-log');
      await page.ev(`(() => { const d = document.querySelector('[role="dialog"]'); const b = d && [...d.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === '关闭'); b && b.click(); })()`).catch(() => {});
      await sleep(300);
    }

    // 1.55) 整理记录 · 只看失败（种子数据里有 1 条 timeout 失败）
    if (want('organize-log-failed')) {
      await openMenuItem('整理记录');
      await requireOpen('organize-log');
      await page.ev(`(() => {
        const d = document.querySelector('[role="dialog"]');
        if (!d) return false;
        const btn = [...d.querySelectorAll('button')].find(b => (b.textContent || '').includes('失败') && (b.textContent || '').includes('条'));
        if (!btn) return false;
        btn.click();
        return true;
      })()`).catch(() => {});
      await sleep(400);
      await page.shot('14-organize-log-failed');
      await page.ev(`(() => { const d = document.querySelector('[role="dialog"]'); const b = d && [...d.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === '关闭'); b && b.click(); })()`).catch(() => {});
      await sleep(250);
    }

    // 1.6) 快捷键速查
    if (want('shortcuts')) {
      await page.ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }))`).catch(() => {});
      await sleep(500);
      await page.shot('08-shortcuts');
      await page.ev(`(() => { const d = document.querySelector('[role="dialog"]'); const b = d && [...d.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === '关闭'); b && b.click(); })()`).catch(() => {});
      await sleep(250);
    }

    // 2) 完整页 · 浅色 · 时间线
    if (want('full-light-timeline')) {
      await page.ev(`document.querySelector('button[title^="时间线"]')?.click()`).catch(() => {});
      await sleep(500);
      await page.shot('02-full-light-timeline');
    }

    // 2.5) 深色模式下的新界面：对话框与浮层必须和浅色一样能看清
    if (want('dark-dialogs')) {
      await page.ev(`chrome.storage.local.set({ 'markai.theme': 'dark' })`).catch(() => {});
      await cdp.send('Page.reload', {}, page.sessionId);
      await page.waitReady(`!!document.querySelector('header')`, 100);
      await sleep(700);
      await openMenuItem('整理记录');
      await requireOpen('organize-log');
      await page.shot('10-dark-organize-log');
      await page.ev(`(() => { const d = document.querySelector('[role="dialog"]'); const b = d && [...d.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === '关闭'); b && b.click(); })()`).catch(() => {});
      await sleep(300);
      await page.ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }))`).catch(() => {});
      await sleep(500);
      await page.shot('11-dark-shortcuts');
      await page.ev(`(() => { const d = document.querySelector('[role="dialog"]'); const b = d && [...d.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === '关闭'); b && b.click(); })()`).catch(() => {});
      await sleep(250);
      await page.ev(`chrome.storage.local.set({ 'markai.theme': 'light' })`).catch(() => {});
    }

    // 3) 完整页 · 深色 · 列表
    if (want('full-dark-list')) {
      await page.ev(`chrome.storage.local.set({ 'markai.theme': 'dark' })`).catch(() => {});
      await cdp.send('Page.reload', {}, page.sessionId);
      await page.waitReady(`!!document.querySelector('header')`, 100);
      await sleep(700);
      await page.shot('03-full-dark-list');
      // 顺手把主题恢复，避免影响后续视图
      await page.ev(`chrome.storage.local.set({ 'markai.theme': 'light' })`).catch(() => {});
    }

    // 4) 侧边栏（紧凑工作区）：430 宽窄视口
    if (want('sidepanel') || want('sidepanel-dialog')) {
      const sp = await openPage(`chrome-extension://${EXT_ID}/sidepanel.html`, { width: 430, height: 880 });
      await sp.waitReady(`!!document.querySelector('header')`);
      await sleep(700);
      await sp.shot('04-sidepanel');
      // 窄屏里的对话框：520px 的设计宽 < 430px 视口 → 依赖 max-w 收缩，必须亲眼看
      if (want('sidepanel-dialog')) {
        // 同上：走「更多」菜单，打不开就抛错，不产假图
        await sp.ev(`(() => {
          if (!document.querySelector('[data-testid="more-menu"]')) {
            document.querySelector('[data-testid="more-trigger"]')?.click();
          }
          return true;
        })()`);
        await sleep(250);
        await sp.ev(`(() => {
          const hit = [...document.querySelectorAll('[role="menuitem"]')]
            .find((b) => (b.textContent || '').includes('整理记录'));
          if (!hit) return false;
          hit.click();
          return true;
        })()`);
        await sleep(700);
        if (!(await sp.waitReady(`!!document.querySelector('[data-testid="organize-log"]')`, 30))) {
          throw new Error('侧边栏里整理记录没打开，拒绝产出错误截图');
        }
        await sp.shot('12-sidepanel-organize-log');
        await sp.ev(`(() => { const d = document.querySelector('[role="dialog"]'); const b = d && [...d.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === '关闭'); b && b.click(); })()`).catch(() => {});
        await sleep(300);
        await sp.ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }))`).catch(() => {});
        await sleep(500);
        if (!(await sp.waitReady(`!!document.querySelector('[role="dialog"]')`, 20))) {
          throw new Error('侧边栏里快捷键面板没打开，拒绝产出错误截图');
        }
        await sp.shot('13-sidepanel-shortcuts');
      }
    }

    /*
     * 4.5) 侧边栏 · **展开**书签树。
     *
     * 原先这里拍的是"收起"，但紧凑模式下树**本来就是收起的**——
     * 于是 09 和 04 是同一张图（sha256 完全相同，我逐张看的时候才发现）。
     * 真正需要人眼确认的是相反的状态：430px 宽的侧边栏里，
     * 208px 的树覆盖层会不会把中栏挤没、会不会溢出。
     */
    if (want('sidepanel-collapsed')) {
      const sp2 = await openPage(`chrome-extension://${EXT_ID}/sidepanel.html`, { width: 430, height: 880 });
      await sp2.waitReady(`!!document.querySelector('header')`);
      await sleep(700);

      const opened = await sp2.ev(`(() => {
        const b = document.querySelector('button[aria-label="展开书签树"]');
        if (!b) return false;
        b.click();
        return true;
      })()`);
      if (!opened) throw new Error('侧边栏里没有「展开书签树」按钮，拒绝产出错误截图');
      await sleep(450);

      // 断言树真的出来了、而且有实际宽度——否则就是又拍了一张假图
      const shape = await sp2.ev(`(() => {
        const t = document.querySelector('[role="tree"]');
        if (!t) return { ok: false, reason: 'no-tree' };
        const r = t.getBoundingClientRect();
        return { ok: r.width > 120 && r.height > 100, width: Math.round(r.width), height: Math.round(r.height) };
      })()`);
      if (!shape.ok) throw new Error(`书签树没有展开（${JSON.stringify(shape)}），拒绝产出错误截图`);

      await sp2.shot('09-sidepanel-tree-open');
    }

    // 5) 弹出窗
    if (want('popup')) {
      const pop = await openPage(`chrome-extension://${EXT_ID}/popup.html`, { width: 380, height: 620 });
      await sleep(900);
      await pop.shot('05-popup');
    }

    // 6.5) 设置页 · 深色（此前只验过浅色）
    if (want('dark-options')) {
      const opt2 = await openPage(`chrome-extension://${EXT_ID}/options.html`, { width: 1180, height: 940 });
      await opt2.waitReady(`!!document.body && document.body.innerText.length > 10`);
      await opt2.ev(`chrome.storage.local.set({ 'markai.theme': 'dark' })`).catch(() => {});
      await opt2.waitReady(`document.documentElement.classList.contains('dark')`, 60);
      await sleep(700);
      await opt2.shot('15-options-dark');
      await opt2.ev(`chrome.storage.local.set({ 'markai.theme': 'light' })`).catch(() => {});
    }

    // 6) 设置页
    if (want('options')) {
      const opt = await openPage(`chrome-extension://${EXT_ID}/options.html`, { width: 1180, height: 940 });
      await opt.waitReady(`!!document.body && document.body.innerText.length > 10`);
      await sleep(700);
      await opt.shot('06-options');
    }
  } catch (e) {
    console.error('视觉审查失败：', e instanceof Error ? e.message : e);
    results.push({ name: 'fatal', ok: false, detail: String(e) });
  } finally {
    try {
      chrome.kill('SIGTERM');
    } catch {
      /* 已退出 */
    }
    await sleep(400);
    try {
      rmSync(PROFILE, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n视觉审查：${results.length - failed.length}/${results.length} 张截图落盘 → ${SHOT_DIR}`);
  process.exit(failed.length > 0 ? 1 : 0);
}

void main();
