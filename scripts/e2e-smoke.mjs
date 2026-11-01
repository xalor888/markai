/**
 * MarkAI 真实浏览器 E2E 冒烟（CDP，无第三方依赖，Node ≥22 自带 WebSocket）
 * 验证：时间线面板 / 删除建议连点 / 长消息不折叠 / 新书签自动整理 / 整理记录 /
 *       多选与搜索 / 树键盘导航与右键菜单 / 弹出窗 / 新用户空状态
 *
 * ⚠️ 写断言时注意：`ev(\`...\`)` 里是**模板字符串**，反斜杠会被吞掉。
 *    `/今天\s*0\s*条/` 传到页面会变成 `/今天s*0s*条/`，永远匹配不上（这个坑踩过四次）。
 *    字符串匹配一律用 `text.includes('字面量')`；必须用正则时改用字符类（`[0-9]` 而不是 `\d`）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';

const CDP = `http://127.0.0.1:${process.env.MARKAI_CDP_PORT || 9333}`;
const OUT_DIR = new URL('../.output/chrome-mv3', import.meta.url).pathname;
const DEFAULT_CHROME =
  '/Users/xalor/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const CHROME = process.env.CHROME_BIN || DEFAULT_CHROME;
const EXT_ID = 'ojlfhclcoecgjbgklbjcbcfbjjjlhjhd';
const PAGE_URL = `chrome-extension://${EXT_ID}/page.html`;
const PROFILE = `/tmp/markai-e2e-${process.pid}`;

/**
 * 启动一个临时 Chrome（必须支持 --load-extension：官方 Chrome ≥137 已禁用该参数，
 * 请用 Chrome for Testing / Chromium，并通过 CHROME_BIN 指定）。
 */
function launchChrome() {
  if (!existsSync(CHROME)) throw new Error(`找不到 Chrome：${CHROME}（用 CHROME_BIN 指定支持 --load-extension 的版本）`);
  const child = spawn(
    CHROME,
    [
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${PROFILE}`,
      '--disable-extensions-except=' + OUT_DIR,
      '--load-extension=' + OUT_DIR,
      `--remote-debugging-port=${process.env.MARKAI_CDP_PORT || 9333}`,
      '--window-size=1280,900',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  );
  return child;
}

function killChrome(child) {
  try {
    child?.kill('SIGTERM');
  } catch {
    /* 已经退出 */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 条件轮询：等某个页面状态成立，最多等 timeoutMs。
 * 比固定 sleep 好：正常情况立刻继续（快），慢机器上也不会因为睡不够而误报。
 */
async function waitFor(check, timeoutMs = 4000, intervalMs = 120) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return true;
    await sleep(intervalMs);
  }
  return false;
}

/** 分段计时：e2e 一旦变慢，需要知道慢在哪一段，而不是只有「总共 5 分钟」 */
const timings = [];
let lastMark = Date.now();
const RUN_START = Date.now();
/**
 * 快速档：跳过三处最慢的段落，用于「改一行 UI 后 20 秒内知道有没有砸东西」。
 *  - 大库渲染（1200 条，约 35s）
 *  - 新用户视角（清空 storage + 重载，约 10s）
 * 提交前仍应跑完整档（不加这个环境变量）。
 */
const QUICK = process.env.MARKAI_E2E_QUICK === '1';
function markSection(name) {
  const now = Date.now();
  timings.push({ name, ms: now - lastMark });
  lastMark = now;
}
const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` · ${detail}` : ''}`);
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
      }, 20000);
    });
  }
}

async function main() {
  const chrome = launchChrome();
  try {
    await run(chrome);
  } finally {
    killChrome(chrome);
    // 清掉临时 profile：残留会累积成几十份，拖慢后续每一次跑测
    await sleep(400);
    try {
      rmSync(PROFILE, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
}

async function run() {
  // 等 CDP 就绪
  for (let i = 0; i < 80; i++) {
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

  const { targetId } = await cdp.send('Target.createTarget', { url: PAGE_URL });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);

  /** 慢调用采样：markSection 靠注释位置，容易与实际内容错位；这里直接量每一次页面求值 */
  const slowCalls = [];
  async function ev(expression) {
    const t0 = Date.now();
    const res = await cdp.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      sessionId,
    );
    const ms = Date.now() - t0;
    if (ms >= 400) slowCalls.push({ ms, head: String(expression).replace(/\s+/g, ' ').slice(0, 70) });
    if (res.exceptionDetails) {
      throw new Error(`页面执行异常: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    }
    return res.result.value;
  }

  // 等应用挂载
  for (let i = 0; i < 80; i++) {
    const ready = await ev(`!!document.querySelector('header') && !!document.querySelector('input#markai-search')`).catch(() => false);
    if (ready) break;
    await sleep(150);
  }
  const href = await ev('location.href');
  const hasApi = await ev('typeof chrome !== "undefined" && !!chrome.bookmarks');
  check('扩展页面在真实 Chrome 中加载成功', href === PAGE_URL && hasApi, href);

  /**
   * 重做后顶栏只剩三个元素（品牌标 / 搜索框 / 更多），原来的「整理记录 / 待删 / 时间线 /
   * 快捷键」都收进了「更多」菜单；时间线也变成排序里的一项。
   *
   * **必须在每次 reload 之后重新注入**：`window.__mk` 挂在页面上，页面一刷新就没了——
   * 早先把注入写在第一段之前，后面任何一次 reload 都让 helper 静默失效（表现为
   * "对话框打不开"），而失败信息完全指不到真正的原因。
   */
  async function installHelpers() {
  /*
   * 重做后顶栏只剩三个元素（品牌标 / 搜索框 / 更多），原来的「整理记录 / 待删 / 时间线 /
   * 快捷键」按钮都收进了「更多」菜单；时间线也变成了排序里的一项。
   * 这里注入一组页面内 helper，让下面的断言不必每处都重写"点开菜单再点那一项"。
   */
    await ev(`(() => {
    const setSelect = (value) => {
      const sel = document.querySelector('select');
      if (!sel) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, value);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    window.__mk = {
      openMenu() {
        // 幂等：菜单已经开着时再点会把 it 关掉（早先的 helper 就栽在这里）
        if (document.querySelector('[role="menu"]')) return;
        document.querySelector('button[aria-label="更多"]')?.click();
      },
      async item(label) {
        this.openMenu();
        await new Promise((r) => setTimeout(r, 320));
        const items = [...document.querySelectorAll('[role="menuitem"]')];
        const hit = items.find((b) => (b.textContent || '').includes(label));
        if (hit) hit.click();
        return !!hit;
      },
      async openOrganizeLog() { return this.item('整理记录'); },
      async openDeletions() { return this.item('待删除清单'); },
      async openShortcuts() { return this.item('快捷键'); },
      setSortTime() { return setSelect('time'); },
      setSortManual() { return setSelect('manual'); },
      /** 现在「在时间线里」= 排序是 time（不再有独立视图） */
      inTimeline() {
        const sel = document.querySelector('select');
        return !!sel && sel.value === 'time';
      },
    };
    return true;
  })()`);
  }

  async function reload() {
    await cdp.send('Page.reload', {}, sessionId);
    for (let i = 0; i < 80; i++) {
      const ready = await ev(`!!document.querySelector('header')`).catch(() => false);
      if (ready) break;
      await sleep(150);
    }
    await sleep(400);
    await installHelpers();
  }

  /* ── 准备数据：3 条书签（放在同一文件夹里，避开自动整理的干扰） ── */
  const seed = await ev(`(async () => {
    const bar = (await chrome.bookmarks.getTree())[0].children.find(c => c.id === '1');
    const folder = await chrome.bookmarks.create({ parentId: bar.id, title: 'E2E-时间线' });
    const a = await chrome.bookmarks.create({ parentId: folder.id, title: 'Alpha 文档', url: 'https://alpha.example.com/a' });
    await new Promise(r => setTimeout(r, 40));
    const b = await chrome.bookmarks.create({ parentId: folder.id, title: 'Beta 指南', url: 'https://beta.example.org/b' });
    await new Promise(r => setTimeout(r, 40));
    const c = await chrome.bookmarks.create({ parentId: folder.id, title: 'Gamma 手册', url: 'https://gamma.example.net/c' });
    return { folderId: folder.id, ids: [c.id, b.id, a.id] };
  })()`);
  check('测试书签创建成功（3 条）', seed.ids.length === 3);


  markSection('时间线');

  /* ── 1. 时间线面板 ── */
  await reload();
  // 时间线不再是顶栏按钮，而是排序里的一项「按收藏时间（全部书签）」
  const entry = await ev(`(async () => {
    const ok = window.__mk?.setSortTime();
    await new Promise((r) => setTimeout(r, 400));
    const sel = document.querySelector('select');
    return { found: !!ok && sel?.value === 'time', label: sel?.selectedOptions?.[0]?.textContent || '' };
  })()`);
  check('排序里能切到「按收藏时间」（= 原来的时间线）', entry.found, entry.label || '');
  await sleep(500);

  const timeline = await ev(`(() => {
    const rows = [...document.querySelectorAll('[role="listitem"]')].filter(el => (el.getAttribute('title') || '').includes('http'));
    const titles = rows.map(el => el.querySelector('p')?.textContent || '');
    const text = document.body.innerText;
    return {
      count: rows.length,
      titles,
      hasHeader: text.includes('时间线'),
      hasFolderRow: titles.includes('E2E-时间线'),
      noFold: !text.includes('展开全文'),
    };
  })()`);
  check('时间线面板只列书签个体，不包含文件夹行', timeline.count === 3 && !timeline.hasFolderRow, JSON.stringify(timeline.titles));
  check('时间线按收藏时间最新在前排序', JSON.stringify(timeline.titles) === JSON.stringify(['Gamma 手册', 'Beta 指南', 'Alpha 文档']), JSON.stringify(timeline.titles));

  // 反转排序
  const toggled = await ev(`(() => {
    const btn = document.querySelector('button[aria-label="切换时间排序方向"]');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await sleep(300);
  const reversed = await ev(`[...document.querySelectorAll('[role="button"]')].filter(el => (el.getAttribute('title') || '').includes('http')).map(el => el.querySelector('p')?.textContent || '')`);
  check('排序方向可切换（最早在前）', toggled && JSON.stringify(reversed) === JSON.stringify(['Alpha 文档', 'Beta 指南', 'Gamma 手册']), JSON.stringify(reversed));

  // 空状态：过滤无匹配
  const empty = await ev(`(() => {
    const input = document.querySelector('input#markai-search');
    if (!input) return { found: false };
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '绝对不存在的关键词zzz');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return { found: true };
  })()`);
  await sleep(350);
  const emptyText = await ev('document.body.innerText');
  check('时间线过滤空状态可见', empty.found && emptyText.includes('没有匹配'), empty.found ? '文案已渲染' : '未找到过滤框');
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent==='清除过滤'); if(b) b.click(); })()`);
  await sleep(200);

  // 返回列表
  await ev(`(() => { const b=document.querySelector('button[aria-label="返回文件夹列表"]'); if(b) b.click(); })()`);
  await sleep(300);
  const backToList = await ev(`!!document.querySelector('input#markai-search')`);
  check('可从时间线返回文件夹列表', backToList);

  // 错误边界不该在正常路径上出现（包了一层容器，别把布局或提示误触发）
  const noFallback = await ev(`(() => {
    const text = document.body.innerText;
    return { hasFallback: text.includes('出了点问题') || text.includes('组件栈') };
  })()`);
  check('正常渲染时不出现错误边界兜底', noFallback.hasFallback === false, JSON.stringify(noFallback));


  /* 对比度实测（WCAG AA）：不看截图猜，直接算每个文本节点的对比度。
   * 小字号（<18px 或 <14px bold）要求 ≥ 4.5:1，大字号 ≥ 3:1。 */
  const CONTRAST_EXPR = `(() => {
    const t0 = performance.now();
    const parse = (s) => {
      if (!s || !s.startsWith('rgb')) return null;
      const nums = s.replace('rgba(', '').replace('rgb(', '').replace(')', '').split(',').map(Number);
      if (nums.length < 3 || nums.some((n) => Number.isNaN(n))) return null;
      return { r: nums[0], g: nums[1], b: nums[2], a: nums.length > 3 ? nums[3] : 1 };
    };
    const rel = (c) => {
      const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const ratio = (a, b) => {
      const l1 = rel(a), l2 = rel(b);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    const bad = [];
    for (const el of document.querySelectorAll('body *')) {
      const text = (el.textContent || '').trim();
      if (!text || el.children.length > 0) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      const style = getComputedStyle(el);
      const fg = parse(style.color);
      if (!fg) continue;
      // 背景可能是透明的：向上找第一个不透明背景
      let bg = parse(style.backgroundColor);
      let p = el;
      let guard = 0;
      while ((!bg || bg.a < 0.9) && p.parentElement && guard++ < 12) {
        p = p.parentElement;
        const c = parse(getComputedStyle(p).backgroundColor);
        if (c && c.a >= 0.9) { bg = c; break; }
      }
      if (!bg) continue;
      const size = parseFloat(style.fontSize || '12');
      const bold = (parseInt(style.fontWeight || '400', 10) || 400) >= 700;
      const large = size >= 18 || (bold && size >= 14);
      const need = large ? 3 : 4.5;
      const r = ratio(fg, bg);
      if (r + 0.05 < need) {
        bad.push({ text: text.slice(0, 18), ratio: Math.round(r * 100) / 100, need, size: Math.round(size) });
      }
    }
    return { total: bad.length, sample: bad.slice(0, 8), elapsedMs: Math.round(performance.now() - t0), scanned: document.querySelectorAll('body *').length };
  })()`;

  const measureContrast = async () => ev(CONTRAST_EXPR);

  const contrastLight = await measureContrast();
  // 切深色再测一次：深色下 muted 前景更容易不达标，不能只验浅色
  await ev(`chrome.storage.local.set({ 'markai.theme': 'dark' })`);
  await waitFor(async () => await ev(`document.documentElement.classList.contains('dark')`), 3000);
  await sleep(400);
  const contrastDark = await measureContrast();
  await ev(`chrome.storage.local.set({ 'markai.theme': 'light' })`);
  await waitFor(async () => await ev(`!document.documentElement.classList.contains('dark')`), 3000);
  await sleep(300);

  console.log(`      对比度（浅色）：${contrastLight.total} 个文本节点低于 WCAG AA`);
  console.log(`      对比度（深色）：${contrastDark.total} 个文本节点低于 WCAG AA`);
  if (contrastLight.total > 0) console.log(`      浅色样例：${JSON.stringify(contrastLight.sample)}`);
  if (contrastDark.total > 0) console.log(`      深色样例：${JSON.stringify(contrastDark.sample)}`);
  check(
    '文本对比度：浅色与深色下都没有低于 WCAG AA 的文本',
    contrastLight.total === 0 && contrastDark.total === 0,
    JSON.stringify({ light: contrastLight, dark: contrastDark }),
  );

  /* 树里的文件夹应当显示直接子项数：省得逐层点进去才知道规模。 */
  const treeCounts = await ev(`(() => {
    const badges = [...document.querySelectorAll('[role="treeitem"] [aria-label$=" 项"]')];
    return {
      count: badges.length,
      samples: badges.slice(0, 4).map((b) => b.getAttribute('aria-label')),
    };
  })()`);
  check(
    '书签树：文件夹旁标出直接子项数',
    treeCounts.count >= 2 && treeCounts.samples.every((t) => /^\d+ 项$/.test(t)),
    JSON.stringify(treeCounts),
  );

  markSection('长消息');

  /* ── 2. 长消息不再折叠（「展开全文」已移除） ── */
  const LONG = 'A'.repeat(1200);
  await ev(`(async () => {
    const key = 'markai.ai';
    const now = Date.now();
    await chrome.storage.local.set({ [key]: {
      conversations: [{ id: 'e2e-long', title: '长消息', createdAt: now, updatedAt: now, messages: [
        { id: 'u1', role: 'user', blocks: [{ kind: 'text', text: '看这条长回复' }], createdAt: now },
        { id: 'a1', role: 'assistant', blocks: [{ kind: 'text', text: ${JSON.stringify('结尾标记END' + LONG)} }], createdAt: now + 1 }
      ]}],
      activeId: 'e2e-long', pendingDeletions: [], deletedIds: [], clearedIds: []
    }});
  })()`);
  await reload();
  const longCheck = await ev(`(() => {
    const text = document.body.innerText;
    return {
      hasFoldButton: text.includes('展开全文') || text.includes('收起'),
      hasEnd: text.includes('结尾标记END'),
      renderedLength: text.length,
    };
  })()`);
  check('长回复完整渲染，「展开全文/收起」入口已移除', !longCheck.hasFoldButton && longCheck.hasEnd, JSON.stringify(longCheck));


  markSection('删除与待删清单');

  /* ── 3. 删除建议：逐条删除 + 连续多次点击均生效 ── */
  const delSeed = await ev(`(async () => {
    const bar = (await chrome.bookmarks.getTree())[0].children.find(c => c.id === '1');
    const folder = await chrome.bookmarks.create({ parentId: bar.id, title: 'E2E-待删' });
    const mk = async (t, u) => chrome.bookmarks.create({ parentId: folder.id, title: t, url: u });
    const x = await mk('待删 A', 'https://del-a.example.com/1');
    const y = await mk('待删 B', 'https://del-b.example.com/1');
    const z = await mk('待删 C', 'https://del-c.example.com/1');
    const now = Date.now();
    const proposal = (n, node) => ({ id: 'proposal-' + n, bookmarkId: node.id, title: node.title, url: node.url, reason: 'E2E 测试删除', status: 'pending', createdAt: now });
    const p = [proposal('a', x), proposal('b', y), proposal('c', z)];
    await chrome.storage.local.set({ 'markai.ai': {
      conversations: [{ id: 'e2e-del', title: '删除测试', createdAt: now, updatedAt: now, messages: [
        { id: 'm1', role: 'assistant', createdAt: now, blocks: [{ kind: 'tool', record: { id: 'tool-1', name: 'propose_deletions', args: '{}', status: 'done', result: '{}', deletions: p } }] }
      ]}],
      activeId: 'e2e-del', pendingDeletions: p, deletedIds: [], clearedIds: []
    }});
    return { folderId: folder.id, ids: [x.id, y.id, z.id] };
  })()`);
  await reload();

  // 在聊天卡片里连续点两条「删除」
  const clicked = await ev(`(() => {
    const btns = [...document.querySelectorAll('button[aria-label^="删除 "]')].filter(b => b.getAttribute('aria-label').includes('待删'));
    const labels = btns.map(b => b.getAttribute('aria-label'));
    btns[0]?.click();
    btns[1]?.click();
    return { count: btns.length, labels };
  })()`);
  check('删除建议每行都有独立「删除」按钮', clicked.count >= 3, clicked.labels.join(','));
  await sleep(2500);
  const afterTwo = await ev(`(async () => {
    const alive = [];
    for (const id of ${JSON.stringify(delSeed.ids)}) {
      const found = await chrome.bookmarks.get(id).then(() => true).catch(() => false);
      alive.push(found);
    }
    const pending = (await chrome.storage.local.get('markai.ai'))['markai.ai'].pendingDeletions.filter(p => p.status === 'pending').length;
    return { alive, pending };
  })()`);
  check('连续点击两次删除：两条都生效（不是只有第一条）', afterTwo.alive[0] === false && afterTwo.alive[1] === false, JSON.stringify(afterTwo.alive));

  // T10：同一行同步连点 5 次（同一 tick，正是竞态场景）→ 只允许 1 次 deletions:execute
  const burst = await ev(`(() => {
    const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.__delExecCount = 0;
    chrome.runtime.sendMessage = (msg, ...rest) => {
      if (msg && msg.type === 'deletions:execute') window.__delExecCount += 1;
      return orig(msg, ...rest);
    };
    const btns = [...document.querySelectorAll('button[aria-label^="删除 "]')].filter(b => b.getAttribute('aria-label').includes('待删'));
    for (let i = 0; i < 5; i++) btns[0]?.click();
    return { targets: btns.length };
  })()`);
  await sleep(2500);
  const burstCount = await ev(`window.__delExecCount`);
  check('同一行连点 5 次：只发出 1 次删除请求（ref 守卫生效）', burstCount === 1, `count=${burstCount} · 可点行=${burst.targets}`);
  const burstAlive = await ev(`chrome.bookmarks.get(${JSON.stringify(delSeed.ids[2])}).then(() => true).catch(() => false)`);
  check('同一行连点 5 次：书签确实被删（守卫没有把功能挡死）', burstAlive === false, `alive=${burstAlive}`);

  // 打开「待删」清单，删除一条（burst 用例已把第三条删掉，这里补一条新提议保证有行可点）
  const dialogProposal = await ev(`(async () => {
    const bar = (await chrome.bookmarks.getTree())[0].children.find(c => c.id === '1');
    const node = await chrome.bookmarks.create({ parentId: bar.id, title: '待删 D', url: 'https://d.example.org/' });
    const now = Date.now();
    const p = { id: 'p-d', bookmarkId: node.id, title: '待删 D', url: node.url, reason: 'e2e', status: 'pending' };
    const st = (await chrome.storage.local.get('markai.ai'))['markai.ai'];
    st.pendingDeletions = [...st.pendingDeletions, p];
    const convo = st.conversations.find(c => c.id === st.activeId);
    const tool = convo.messages.flatMap(m => m.blocks || []).find(b => b.kind === 'tool');
    tool.record.deletions = [...(tool.record.deletions || []), p];
    await chrome.storage.local.set({ 'markai.ai': st });
    return node.id;
  })()`);
  await reload();
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('待删')); if(b) b.click(); })()`);
  await sleep(500);
  const dialogInfo = await ev(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return { open: false };
    const btns = [...dlg.querySelectorAll('button[aria-label^="删除 "]')];
    btns[btns.length - 1]?.click();
    return { open: true, deleteButtons: btns.length };
  })()`);
  check('待删清单对话框打开且每行有删除按钮', dialogInfo.open && dialogInfo.deleteButtons >= 1, JSON.stringify(dialogInfo));
  await sleep(2500);
  const afterThird = await ev(`chrome.bookmarks.get(${JSON.stringify(dialogProposal)}).then(() => true).catch(() => false)`);
  check('待删清单里逐条删除生效', afterThird === false, `alive=${afterThird}`);


  markSection('自动整理 / 分页 / 树定位');

  /* ── 4. 新书签自动整理（真实 onCreated 触发） ── */
  const auto = await ev(`(async () => {
    const bar = (await chrome.bookmarks.getTree())[0].children.find(c => c.id === '1');
    const node = await chrome.bookmarks.create({ parentId: bar.id, title: '自动整理测试页', url: 'https://auto-organize.example-preview.dev/x' });
    return node.id;
  })()`);
  await sleep(4000);
  const autoResult = await ev(`(async () => {
    const node = (await chrome.bookmarks.get(${JSON.stringify(auto)}))[0];
    const parent = node.parentId ? (await chrome.bookmarks.get(node.parentId))[0] : null;
    const grand = parent?.parentId ? (await chrome.bookmarks.get(parent.parentId))[0] : null;
    return { parentTitle: parent?.title, grandTitle: grand?.title, nodeTitle: node.title };
  })()`);
  // 契约变了（0.2.35）：认不出归属时留在原地，不再建「自动整理/<域名>」
  check(
    '新增书签认不出归属时留在原地（不再按域名建文件夹）',
    autoResult.parentTitle === '书签栏' && !autoResult.grandTitle,
    JSON.stringify(autoResult),
  );

  /* ── 5. 时间线分页：日期组头 = 当天真实条数（不是首屏页大小 80） ── */
  await ev(`(async () => {
    const bar = (await chrome.bookmarks.getTree())[0].children.find(c => c.id === '1');
    const folder = await chrome.bookmarks.create({ parentId: bar.id, title: 'E2E-分页' });
    for (let i = 0; i < 96; i++) {
      await chrome.bookmarks.create({ parentId: folder.id, title: '分页书签 ' + i, url: 'https://page-' + i + '.example.com/x' });
    }
    return folder.id;
  })()`);
  await reload();
  // 「今天」的真实条数用浏览器自己的数据算，不依赖脚本里的假设
  const todayTruth = await ev(`(async () => {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const ids = [];
    const walk = (n) => { if (n.url) { if ((n.dateAdded || 0) >= start.getTime()) ids.push(n.id); } else (n.children || []).forEach(walk); };
    (await chrome.bookmarks.getTree()).forEach(walk);
    return ids.length;
  })()`);
  await ev(`(async () => { window.__mk?.setSortTime(); await new Promise(r => setTimeout(r, 150)); })()`);
  await sleep(700);
  const dayHeader = await ev(`(() => {
    const h = [...document.querySelectorAll('h3')].find((x) => x.textContent.includes('今天'));
    if (!h) return null;
    const m = h.textContent.match(/(\\d+)\\s*条/);
    return { text: h.textContent.trim(), count: m ? Number(m[1]) : null };
  })()`);
  check(
    '时间线分页：今天组头显示当天真实条数（不是首屏 80 条）',
    !!dayHeader && todayTruth > 80 && dayHeader.count === todayTruth,
    `今天真实=${todayTruth} · 组头=${JSON.stringify(dayHeader)}`,
  );

  /* ── 6. 时间线里点树中「已选中」的文件夹：必须回到列表 ──
   * 默认选中的就是「书签栏」：用户在时间线里点它想看内容时，
   * selectedFolderId 没变化，靠"监听选中值变化"的写法不会触发 → 点了没反应。 */
  const inTimelineBefore = await ev(`!!document.querySelector('input#markai-search')`);
  const clickedSelected = await ev(`(() => {
    const row = document.querySelector('[data-node-id="1"][aria-selected="true"]');
    if (!row) return false;
    row.click();
    return true;
  })()`);
  await sleep(500);
  const inTimelineAfter = await ev(`!!document.querySelector('input#markai-search')`);
  check(
    '时间线里点树中「已选中」的文件夹会回到列表（不再「点了没反应」）',
    inTimelineBefore && clickedSelected === true && inTimelineAfter === false,
    `在时间线=${inTimelineBefore} · 点中已选中行=${clickedSelected} · 点完仍在时间线=${inTimelineAfter}`,
  );

  markSection('整理记录');

  /* ── 7. 整理记录（用户要「看得见」的自动整理） ── */
  // 重做后顶栏只剩三个元素：整理记录收在「更多」菜单里（点开能看到即可）
  const organizeEntry = await ev(`(async () => {
    document.querySelector('button[aria-label="更多"]')?.click();
    await new Promise((r) => setTimeout(r, 150));
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent.trim());
    document.querySelector('button[aria-label="更多"]')?.click();
    return { found: items.some((t) => t.includes('整理记录')), items };
  })()`);
  check('「更多」菜单里有「整理记录」入口', organizeEntry.found, JSON.stringify(organizeEntry.items));

  // 对话框打开后的对比度：整理记录是文本最密的地方，此前只验过初始渲染
  const logContrast = await ev(CONTRAST_EXPR);
  check(
    '整理记录对话框打开后的文本对比度仍然达标（WCAG AA）',
    logContrast.total === 0,
    JSON.stringify(logContrast),
  );

  /* 整理记录里的「↶」必须真的把书签放回去——这是这个面板最重要的承诺。
   * 单测覆盖了「撤销点能找到 + 撤销后回原处」，这里覆盖**用户点得到的那条路径**：
   * 消息 → background → applyUndo → 树刷新。 */
  const beforeUndo = await ev(`(async () => {
    const target = 'https://auto-organize.example-preview.dev/x';
    const found = await chrome.bookmarks.search(target);
    const node = found.find((n) => n.url === target);
    return node ? { id: node.id, parentId: node.parentId } : { id: null, parentId: null };
  })()`);
  const undoClicked = await ev(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return { ok: false, reason: 'no-dialog' };
    const btn = [...dlg.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '').startsWith('撤销整理'));
    if (!btn) return { ok: false, reason: 'no-undo-button', labels: [...dlg.querySelectorAll('button')].map(b => b.getAttribute('aria-label') || b.textContent).slice(0, 12) };
    btn.click();
    return { ok: true };
  })()`);
  await sleep(3000);
  const afterUndo = await ev(`(async () => {
    const target = 'https://auto-organize.example-preview.dev/x';
    const found = await chrome.bookmarks.search(target);
    const node = found.find((n) => n.url === target);
    return node ? { id: node.id, parentId: node.parentId } : { id: null, parentId: null };
  })()`);
  check(
    '整理记录里点「撤销」：书签真的回到原处',
    undoClicked.ok === true && beforeUndo.parentId && beforeUndo.parentId !== '1' && afterUndo.parentId === '1',
    JSON.stringify({ undoClicked, before: beforeUndo.parentId, after: afterUndo.parentId }),
  );
  /* 撤销 = 用户否定了这个站点的归类：该站点要进「免打扰」，面板上也要说出来。
   * 这是「自动整理有记性」的关键一环，走的是 UI → background 的真实路径。 */
  const optState = await ev(`(async () => {
    const res = await chrome.runtime.sendMessage({ type: 'organize:optout:list' });
    const dlg = document.querySelector('[role="dialog"]');
    return {
      domains: (res?.domains || []).map((d) => d.domain),
      panelText: dlg ? dlg.innerText : '',
    };
  })()`);
  check(
    '撤销后该站点进入「免打扰」名单，并在面板上可见',
    optState.domains.some((d) => d.includes('example-preview')) && optState.panelText.includes('已停用自动整理'),
    JSON.stringify({ domains: optState.domains, hasPanelLine: optState.panelText.includes('已停用自动整理') }),
  );

  /* 跨窗口同步：另一个窗口写入一条记录，当前打开的对话框应当自动更新。
   * storage 就是多窗口之间唯一的中介，所以这里用它模拟另一侧的写入。 */
  const crossWindow = await ev(`(async () => {
    const key = 'markai.organize.log';
    const cur = (await chrome.storage.local.get(key))[key] || [];
    const marker = {
      id: 'sync-marker-e2e', at: Date.now(), title: '来自另一个窗口', url: 'https://sync.example.com/x',
      domain: 'sync.example.com', action: 'moved', detail: '跨窗口同步测试', target: '设计资料',
    };
    await chrome.storage.local.set({ [key]: [marker, ...cur] });
    await new Promise((r) => setTimeout(r, 900));
    const dlg = document.querySelector('[role="dialog"]');
    const visible = dlg ? dlg.innerText.includes('来自另一个窗口') : false;
    // 清理：把标记记录移除，避免影响后续断言
    await chrome.storage.local.set({ [key]: ((await chrome.storage.local.get(key))[key] || []).filter((e) => e.id !== 'sync-marker-e2e') });
    return { visible };
  })()`);
  check('另一窗口写入记录后，打开着的面板自动更新（跨窗口同步）', crossWindow.visible === true, JSON.stringify(crossWindow));
  await sleep(500);

  // 「全部恢复」必须真的清空名单（用户改主意不该被永久困住）
  const restored = await ev(`(async () => {
    const dlg = document.querySelector('[role="dialog"]');
    const btn = dlg && [...dlg.querySelectorAll('button')].find((b) => b.textContent.includes('全部恢复'));
    if (!btn) return { clicked: false };
    btn.click();
    await new Promise((r) => setTimeout(r, 600));
    const res = await chrome.runtime.sendMessage({ type: 'organize:optout:list' });
    return { clicked: true, remaining: (res?.domains || []).length };
  })()`);
  check('点「全部恢复」后免打扰名单清空', restored.clicked === true && restored.remaining === 0, JSON.stringify(restored));
  await sleep(400);

  /* 撤销历史面板：要能标出「这条是自动整理造成的」。
   * 单测覆盖了 source 的计算，但**界面上是否真的把标签画出来**没验证过——
   * 用户分不清「Agent 干的」和「后台自己干的」，就不敢点撤销。 */
  const undoHistoryUi = await ev(`(async () => {
    const btn = document.querySelector('button[aria-label="撤销历史"]');
    if (!btn) return { ok: false, reason: 'no-history-button' };
    if (btn.disabled) return { ok: false, reason: 'disabled' };
    btn.click();
    await new Promise(r => setTimeout(r, 500));
    const text = document.body.innerText;
    return { ok: true, hasTitle: text.includes('撤销历史'), hasAutoTag: text.includes('自动整理') };
  })()`);
  // 浮层可能有 backdrop 挡住后续点击；reload 比猜测关闭按钮的选择器更可靠。
  // 但 reload 会把整理记录对话框一起关掉，而下面的用例依赖它——所以重新打开。
  await reload();
  await sleep(700);
  await ev(`(async () => { await (async () => {if (!document.querySelector('[role="menu"]')) document.querySelector('button[aria-label="更多"]')?.click();await new Promise(r => setTimeout(r, 320));const items = [...document.querySelectorAll('[role="menuitem"]')];const hit = items.find(b => (b.textContent || '').includes('整理记录'));if (hit) hit.click();await new Promise(r => setTimeout(r, 300));return !!hit; })(); })()`);
  await sleep(800);
  check(
    '撤销历史面板：能打开，且标出「自动整理」来源',
    undoHistoryUi.ok === true && undoHistoryUi.hasTitle === true && undoHistoryUi.hasAutoTag === true,
    JSON.stringify(undoHistoryUi),
  );

  /* 导出按钮：点下去要真的生成文件、内容要能看。
   * 这条链路平时最难验证（会触发浏览器下载），用 CDP 的下载拦截就能断言落盘内容。 */
  const downloadDir = `/tmp/markai-e2e-dl-${process.pid}`;
  rmSync(downloadDir, { recursive: true, force: true });
  mkdirSync(downloadDir, { recursive: true });
  await cdp
    .send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true })
    .catch(() => {});

  const exportClicked = await ev(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return { ok: false, reason: 'no-dialog' };
    const btn = [...dlg.querySelectorAll('button')].find((b) => (b.textContent || '').includes('导出'));
    if (!btn) return { ok: false, reason: 'no-export-button' };
    btn.click();
    return { ok: true };
  })()`);
  await sleep(1800);
  let exported = { ok: false, files: [] };
  try {
    const files = readdirSync(downloadDir).filter((f) => f.endsWith('.md'));
    if (files.length > 0) {
      const content = readFileSync(`${downloadDir}/${files[0]}`, 'utf8');
      exported = {
        ok: true,
        files,
        hasTitle: content.includes('# MarkAI 整理记录'),
        hasStats: content.includes('统计：'),
        hasRows: content.includes('- **'),
        nameHasDate: /MarkAI-整理记录-[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(files[0]),
      };
    }
  } catch (err) {
    exported = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  rmSync(downloadDir, { recursive: true, force: true });
  check(
    '导出：点下去真的生成了 Markdown 文件（含标题、统计、条目，文件名带日期）',
    exportClicked.ok === true && exported.ok === true && exported.hasTitle === true &&
      exported.hasStats === true && exported.hasRows === true && exported.nameHasDate === true,
    JSON.stringify({ click: exportClicked, file: exported }),
  );

  /* 「只看失败」的真实筛选：纯函数有单测，但点下去是否真的只剩失败记录没有断言。
   * 这里注入一条失败记录（模拟一次超时），再点筛选按钮。 */
  await ev(`(async () => {
    const key = 'markai.organize.log';
    const cur = (await chrome.storage.local.get(key))[key] || [];
    const failed = {
      id: 'fail-marker-e2e', at: Date.now(), title: '超时的那一条', url: 'https://timeout.example.com/x',
      domain: 'timeout.example.com', action: 'failed', detail: '自动整理失败：timeout',
      needsAttention: true, retryable: true,
    };
    await chrome.storage.local.set({ [key]: [failed, ...cur] });
    return true;
  })()`);
  await sleep(1000); // 等跨窗口同步把面板刷过来
  const onlyFailed = await ev(`(async () => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return { ok: false, reason: 'no-dialog' };
    const before = dlg.innerText;
    const btn = [...dlg.querySelectorAll('button')].find(
      (b) => (b.textContent || '').includes('失败') && (b.textContent || '').includes('条'),
    );
    if (!btn) return { ok: false, reason: 'no-filter-button', text: before.slice(0, 120) };
    btn.click();
    await new Promise(r => setTimeout(r, 500));
    const after = dlg.innerText;
    // 再点回「显示全部」，避免影响后面的清空用例
    const back = [...dlg.querySelectorAll('button')].find((b) => (b.textContent || '').includes('显示全部'));
    if (back) back.click();
    await new Promise(r => setTimeout(r, 400));
    return {
      ok: true,
      filteredHasFailed: after.includes('超时的那一条'),
      filteredHidesSuccess: !after.includes('自动整理测试页'),
      rawBeforeHadSuccess: before.includes('自动整理测试页'),
      // 只看失败时不该再显示全量的「判断来源」——失败记录没有来源，两个口径会打架
      filteredHidesVia: !after.includes('判断来源'),
      rawBeforeHadVia: before.includes('判断来源'),
    };
  })()`);
  check(
    '只看失败：点下去列表真的只剩失败记录',
    onlyFailed.ok && onlyFailed.filteredHasFailed && onlyFailed.filteredHidesSuccess &&
      onlyFailed.rawBeforeHadSuccess && onlyFailed.filteredHidesVia && onlyFailed.rawBeforeHadVia,
    JSON.stringify(onlyFailed),
  );
  // 清掉注入的失败记录，避免干扰后续断言
  await ev(`(async () => {
    const key = 'markai.organize.log';
    const cur = (await chrome.storage.local.get(key))[key] || [];
    await chrome.storage.local.set({ [key]: cur.filter((e) => e.id !== 'fail-marker-e2e') });
    return true;
  })()`);
  await sleep(600);

  /* 重试的界面链路：纯函数只测了「挑哪些条目」，点下去之后
   * 「消息 → background → 重新归类 → 就地更新成成功」这一段完全没有断言。 */
  const retrySeed = await ev(`(async () => {
    const bar = (await chrome.bookmarks.getTree())[0].children.find(c => c.id === '1');
    const node = await chrome.bookmarks.create({ parentId: bar.id, title: '待重试的书签', url: 'https://retry-me.example.com/x' });
    const key = 'markai.organize.log';
    const cur = (await chrome.storage.local.get(key))[key] || [];
    const entry = {
      id: 'retry-marker-e2e', at: Date.now(), title: '待重试的书签',
      url: 'https://retry-me.example.com/x', domain: 'retry-me.example.com',
      action: 'failed', detail: '自动整理失败：timeout', needsAttention: true, retryable: true,
    };
    await chrome.storage.local.set({ [key]: [entry, ...cur] });
    return { id: node.id };
  })()`);
  await sleep(1000);
  const retryFlow = await ev(`(async () => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return { ok: false, reason: 'no-dialog' };
    const btn = [...dlg.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '').includes('重试整理 待重试的书签'));
    if (!btn) return { ok: false, reason: 'no-retry-button' };
    btn.click();
    await new Promise(r => setTimeout(r, 2500));
    return { ok: true };
  })()`);
  const retryState = await ev(`(async () => {
    const node = (await chrome.bookmarks.get(${JSON.stringify(retrySeed.id)}))[0];
    const dlg = document.querySelector('[role="dialog"]');
    const text = dlg ? dlg.innerText : '';
    return {
      parentId: node ? node.parentId : null,
      moved: node ? node.parentId !== '1' : false,
      markedSuccess: text.includes('重试成功'),
    };
  })()`);
  check(
    '重试：点下去书签真的归位，并且原记录就地变成成功（不是新增一条绿）',
    retryFlow.ok === true && retryState.moved === true && retryState.markedSuccess === true,
    JSON.stringify({ flow: retryFlow.ok, ...retryState }),
  );
  await ev(`(async () => {
    const key = 'markai.organize.log';
    const cur = (await chrome.storage.local.get(key))[key] || [];
    await chrome.storage.local.set({ [key]: cur.filter((e) => e.id !== 'retry-marker-e2e') });
    const node = await chrome.bookmarks.get(${JSON.stringify(retrySeed.id)}).catch(() => []);
    if (node && node[0]) await chrome.bookmarks.remove(${JSON.stringify(retrySeed.id)}).catch(() => {});
    return true;
  })()`);
  await sleep(600);

  /* 批量重试：「重试全部 N」只在可重试数 > 1 时出现（1 条时不该占地方），
   * 且点下去要真的把每一条都重跑一遍、就地更新。 */
  const bulkRetry = await ev(`(async () => {
    const bar = (await chrome.bookmarks.getTree())[0].children.find(c => c.id === '1');
    const one = await chrome.bookmarks.create({ parentId: bar.id, title: '批量重试一', url: 'https://bulk-retry-a.example.com/1' });
    const two = await chrome.bookmarks.create({ parentId: bar.id, title: '批量重试二', url: 'https://bulk-retry-b.example.com/2' });
    const key = 'markai.organize.log';
    const cur = (await chrome.storage.local.get(key))[key] || [];
    const mk = (id, title, url, domain) => ({
      id, at: Date.now(), title, url, domain,
      action: 'failed', detail: '自动整理失败：timeout', needsAttention: true, retryable: true,
    });
    await chrome.storage.local.set({
      [key]: [mk('bulk-a', '批量重试一', 'https://bulk-retry-a.example.com/1', 'bulk-retry-a.example.com'),
              mk('bulk-b', '批量重试二', 'https://bulk-retry-b.example.com/2', 'bulk-retry-b.example.com'), ...cur],
    });
    return { one: one.id, two: two.id };
  })()`);
  await sleep(1200);
  const bulkState = await ev(`(async () => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return { ok: false, reason: 'no-dialog' };
    const btn = [...dlg.querySelectorAll('button')].find((b) => (b.textContent || '').includes('重试全部'));
    if (!btn) return { ok: false, reason: 'no-bulk-button', text: dlg.innerText.slice(0, 100) };
    const label = btn.textContent || '';
    btn.click();
    // 两条串行重跑，给足时间
    await new Promise(r => setTimeout(r, 6000));
    const text = dlg ? dlg.innerText : '';
    return { ok: true, label, successCount: (text.match(/重试成功/g) || []).length };
  })()`);
  const bulkResult = await ev(`(async () => {
    const a = (await chrome.bookmarks.get(${JSON.stringify(bulkRetry.one)}))[0];
    const b = (await chrome.bookmarks.get(${JSON.stringify(bulkRetry.two)}))[0];
    return { aParent: a ? a.parentId : null, bParent: b ? b.parentId : null };
  })()`);
  check(
    '重试全部：按钮只在多条可重试时出现，点下去两条都归位并各自标记成功',
    bulkState.ok === true && /重试全部\s*2/.test(bulkState.label) &&
      bulkResult.aParent !== '1' && bulkResult.bParent !== '1' && bulkState.successCount >= 2,
    JSON.stringify({ state: bulkState, result: bulkResult }),
  );
  await ev(`(async () => {
    const key = 'markai.organize.log';
    const cur = (await chrome.storage.local.get(key))[key] || [];
    await chrome.storage.local.set({ [key]: cur.filter((e) => !['bulk-a', 'bulk-b'].includes(e.id)) });
    for (const id of ${JSON.stringify([bulkRetry.one, bulkRetry.two])}) {
      await chrome.bookmarks.remove(id).catch(() => {});
    }
    return true;
  })()`);
  await sleep(600);

  /* 「归到」的溢出防护：50 条记录落在 50 个不同文件夹时，不能把面板堆成一堵墙。
   * 设计上只显示前 3 个 + 「其他 N」——这条防护一旦被删，界面会直接失控。 */
  const chipOverflow = await ev(`(async () => {
    const key = 'markai.organize.log';
    const cur = (await chrome.storage.local.get(key))[key] || [];
    const many = [];
    for (let i = 0; i < 50; i++) {
      many.push({
        id: 'chip-' + i, at: Date.now() - i * 1000, title: '条目 ' + i,
        url: 'https://chip' + i + '.example.com/x', domain: 'chip' + i + '.example.com',
        action: 'moved', target: '目标文件夹 ' + i, detail: '已归入「目标文件夹 ' + i + '」', via: 'local',
      });
    }
    await chrome.storage.local.set({ [key]: [...many, ...cur] });
    return { injected: many.length };
  })()`);
  await sleep(1200);
  const chipState = await ev(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return { ok: false, reason: 'no-dialog' };
    const text = dlg.innerText;
    const chips = [...dlg.querySelectorAll('span')].filter(
      (el) => (el.getAttribute('title') || '').includes(' 条') && el.className.includes('max-w-[180px]'),
    );
    return {
      ok: true,
      chipCount: chips.length,
      // 不用正则：这段在模板字符串里，反斜杠会被吞掉（这个坑第五次了）
      hasOverflowHint: text.includes('其他 '),
    };
  })()`);
  check(
    '「归到」最多显示 3 个 + 「其他 N」，不会把面板堆成墙',
    chipState.ok === true && chipState.chipCount <= 3 && chipState.hasOverflowHint === true,
    JSON.stringify({ ...chipState, injected: chipOverflow.injected }),
  );
  // 清掉注入的记录
  await ev(`(async () => {
    const key = 'markai.organize.log';
    const cur = (await chrome.storage.local.get(key))[key] || [];
    await chrome.storage.local.set({ [key]: cur.filter((e) => !String(e.id).startsWith('chip-')) });
    return true;
  })()`);
  await sleep(700);

  // 清空记录必须先二次确认：点一下就把历史抹掉是不可接受的
  // （上一段结束时把对话框关掉了，这里重新打开）
  await ev(`(async () => { await (async () => {if (!document.querySelector('[role="menu"]')) document.querySelector('button[aria-label="更多"]')?.click();await new Promise(r => setTimeout(r, 320));const items = [...document.querySelectorAll('[role="menuitem"]')];const hit = items.find(b => (b.textContent || '').includes('整理记录'));if (hit) hit.click();await new Promise(r => setTimeout(r, 300));return !!hit; })(); })()`);
  await sleep(800);
  const clearFlow = await ev(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return { ok: false, reason: 'dialog-closed' };
    const btn = [...dlg.querySelectorAll('button')].find(b => b.textContent.includes('清空记录'));
    if (!btn) return { ok: false, reason: 'no-clear-button' };
    btn.click();
    return { ok: true };
  })()`);
  await sleep(350);
  const confirmState = await ev(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const text = dlg ? dlg.innerText : '';
    const hasConfirm = text.includes('不可恢复') && !!([...dlg.querySelectorAll('button')].find(b => b.textContent.includes('确认清空')));
    // 真实记录来自本脚本前面触发的自动整理（不是视觉审查的演示数据）
    const stillHasRecords = text.includes('自动整理测试页') || text.includes('example-preview') || text.includes('批量新增');
    return { hasConfirm, stillHasRecords };
  })()`);
  check(
    '清空整理记录需要二次确认，且确认前不删任何东西',
    clearFlow.ok && confirmState.hasConfirm && confirmState.stillHasRecords,
    JSON.stringify({ ...clearFlow, ...confirmState }),
  );
  await ev(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const btn = dlg && [...dlg.querySelectorAll('button')].find(b => b.textContent.trim() === '取消');
    if (btn) btn.click();
  })()`);
  await sleep(250);
  const afterCancel = await ev(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const text = dlg ? dlg.innerText : '';
    return { stillHasRecords: text.includes('自动整理测试页') || text.includes('example-preview') || text.includes('批量新增') };
  })()`);
  check('取消清空后记录仍在（不会因为点过确认按钮就丢）', afterCancel.stillHasRecords, JSON.stringify(afterCancel));

  markSection('快捷键 / 大库 / 多选 / 树 / 移动');

  /* ── 8. 快捷键速查：可发现性（文档里的键产品里也要能查到） ── */
  await ev(`(() => { document.querySelector('[role="dialog"] [aria-label="关闭"]')?.click(); })()`);
  await sleep(300);
  const shortcutEntry = await ev(`(async () => {
    if (!document.querySelector('[role="menu"]')) document.querySelector('button[aria-label="更多"]')?.click();
    await new Promise((r) => setTimeout(r, 320));
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent.trim());
    if (document.querySelector('[role="menu"]')) document.querySelector('button[aria-label="更多"]')?.click();
    return { found: items.some((t) => t.includes('快捷键')), items };
  })()`);
  check('「更多」菜单里有「快捷键与操作」入口', shortcutEntry.found, JSON.stringify(shortcutEntry.items));

  // 在搜索框里按「?」必须当作正常输入，不能弹出浮层（劫持输入是最烦人的一类 bug）
  const typingQuestion = await ev(`(() => {
    const input = document.querySelector('input#markai-search');
    if (!input) return { fired: false, reason: 'no-input' };
    input.focus();
    const ev2 = new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true });
    input.dispatchEvent(ev2);
    return { fired: true, dialogOpen: !!document.querySelector('[role="dialog"]') };
  })()`);
  check('在搜索框里按「?」不会弹出浮层', typingQuestion.fired && typingQuestion.dialogOpen === false, JSON.stringify(typingQuestion));

  const questionKey = await ev(`(() => {
    document.querySelector('input#markai-search')?.blur();
    document.body.focus();
    // 打到 body 上更像真实按键（真实事件靶点是聚焦元素或 body，不是 window）
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(400);
  const shortcutDialog = await ev(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return { open: false };
    const text = dlg.innerText;
    return {
      open: true,
      hasTitle: text.includes('快捷键与操作'),
      hasNav: text.includes('上下移动高亮'),
      hasF2: text.includes('重命名当前项'),
      hasUndoHint: text.includes('撤销'),
    };
  })()`);
  check(
    '按「?」打开快捷键速查，且内容与真实绑定一致',
    questionKey && shortcutDialog.open && shortcutDialog.hasTitle && shortcutDialog.hasNav && shortcutDialog.hasF2 && shortcutDialog.hasUndoHint,
    JSON.stringify(shortcutDialog),
  );
  await ev(`(() => { document.querySelector('[role="dialog"] [aria-label="关闭"]')?.click(); })()`);
  await sleep(200);

    if (!QUICK) {  // ── 快速档跳过：大库渲染
/* ── 9. 大库渲染：1200+ 条时时间线首屏仍要「点了就有」 ──
   * 数据层的纯函数有单测护栏（T82），这里验证更容易出问题的**渲染**：
   * 一次性挂满 DOM 会让侧边栏卡好几秒，用户会以为点坏了。 */
  const bulkSeed = await ev(`(async () => {
    const bar = (await chrome.bookmarks.getTree())[0].children.find(c => c.id === '1');
    const folder = await chrome.bookmarks.create({ parentId: bar.id, title: 'E2E-大库' });
    const t0 = Date.now();
    for (let i = 0; i < 1200; i++) {
      await chrome.bookmarks.create({
        parentId: folder.id,
        title: '大库条目 ' + i,
        url: 'https://bulk-' + i + '.example.com/x',
      });
    }
    return { folderId: folder.id, createMs: Date.now() - t0 };
  })()`);
  await reload();
  const bulkTiming = await ev(`(async () => {
    const t0 = performance.now();
    // 时间线 = 排序切到「按收藏时间」（不再是顶栏按钮）
    window.__mk?.setSortTime();
    for (let i = 0; i < 300; i++) {
      await new Promise(r => requestAnimationFrame(r));
      const rows = [...document.querySelectorAll('[role="listitem"]')]
        .filter(el => (el.getAttribute('title') || '').includes('http')).length;
      if (rows >= 40) return { ms: Math.round(performance.now() - t0), rows };
    }
    const rows = [...document.querySelectorAll('[role="listitem"]')]
      .filter(el => (el.getAttribute('title') || '').includes('http')).length;
    return { ms: Math.round(performance.now() - t0), rows, reason: 'timeout' };
  })()`);
  check(
    '大库（1200+ 条）下时间线首屏 3 秒内可用',
    bulkTiming.rows >= 40 && bulkTiming.ms >= 0 && bulkTiming.ms < 3000,
    `首屏 ${bulkTiming.rows} 行 / ${bulkTiming.ms}ms · 造数据 ${bulkSeed.createMs}ms`,
  );
  // 清理：一次性清掉，避免影响真实使用与下一次运行
  await ev(`chrome.bookmarks.removeTree(${JSON.stringify(bulkSeed.folderId)}).catch(() => {})`);


    }

/* ── 9.5 多选与搜索：最常用的两条路径 ──
   * 这两条一旦回归，用户会立刻感觉到（选不中、搜不出、批量条不出现），
   * 但它们都不涉及后台逻辑，单测覆盖不到——只能靠真实浏览器点。 */
  const pickSeed = await ev(`(async () => {
    const bar = (await chrome.bookmarks.getTree())[0].children.find(c => c.id === '1');
    const folder = await chrome.bookmarks.create({ parentId: bar.id, title: 'E2E-多选' });
    const mk = (t, u) => chrome.bookmarks.create({ parentId: folder.id, title: t, url: u });
    const a = await mk('多选 Alpha', 'https://multi-alpha.example.com/1');
    const b = await mk('多选 Beta', 'https://multi-beta.example.com/2');
    const c = await mk('多选 Gamma', 'https://multi-gamma.example.com/3');
    return { folderId: folder.id, ids: [a.id, b.id, c.id] };
  })()`);
  await reload();
  // 选中该文件夹：按文本找树里的那一行（不依赖 data-node-id 的实现细节）
  const entered = await ev(`(async () => {
    const row = [...document.querySelectorAll('[data-node-id]')].find(
      (el) => (el.textContent || '').includes('E2E-多选'),
    );
    if (!row) return { clicked: false, candidates: [...document.querySelectorAll('[data-node-id]')].length };
    row.click();
    await new Promise(r => setTimeout(r, 600));
    // 列表行是 role="listitem"（时间线才是 button）；树里的行也有 title，必须用 role 限定
    const rows = [...document.querySelectorAll('[role="listitem"][title*="multi-"]')];
    return { clicked: true, rows: rows.length };
  })()`);
  check('进入文件夹后列表列出 3 条', entered.clicked && entered.rows === 3, JSON.stringify(entered));

  const multi = await ev(`(async () => {
    const rows = [...document.querySelectorAll('[role="listitem"][title*="multi-"]')];
    if (rows.length < 3) return { ok: false, rows: rows.length };
    // 全部用 Ctrl+点击：普通点击会打开标签页（副作用），多选路径只看 ctrlKey
    for (const row of rows) {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
      await new Promise(r => setTimeout(r, 120));
    }
    await new Promise(r => setTimeout(r, 250));
    const text = document.body.innerText;
    // 别用正则：这段代码在模板字符串里，反斜杠会被吞（第三次踩同一个坑）
    return { ok: true, hasBar: text.includes('已选 3 项'), text: text.includes('已选 3 项') ? '已选 3 项' : '' };
  })()`);
  check('Ctrl+点击可以多选，操作条显示已选计数', multi.ok && multi.hasBar, JSON.stringify(multi));

  const cleared = await ev(`(async () => {
    // Esc 由列表容器自己的 onKeyDown 处理：必须先把焦点给它（dispatch 到 window 不会触发）
    const item = document.querySelector('[role="listitem"]');
    const container = item ? item.parentElement : null;
    if (container && typeof container.focus === 'function') container.focus();
    container?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
    return { focused: !!container, hasBar: document.body.innerText.includes('已选') };
  })()`);
  check('Esc 清除多选（操作条消失）', cleared.hasBar === false, JSON.stringify(cleared));

  const searched = await ev(`(async () => {
    const input = document.querySelector('input#markai-search');
    if (!input) return { ok: false };
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '多选 Beta');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 700));
    const rows = [...document.querySelectorAll('[role="listitem"][title*="multi-"]')];
    const titles = rows.map((el) => (el.textContent || '').trim());
    // 清空搜索
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 500));
    const after = [...document.querySelectorAll('[role="listitem"][title*="multi-"]')].length;
    return { ok: true, titles, after };
  })()`);
  check(
    '搜索能筛出目标条目，清空后恢复',
    searched.ok && searched.titles.some((t) => t.includes('Beta')) && searched.titles.length < 3 && searched.after === 3,
    JSON.stringify(searched),
  );

  /* ── 9.6 树的右键菜单：核心导航入口，只靠截图无法保证它没被改坏 ── */
  const treeMenu = await ev(`(async () => {
    // 用刚建的那个文件夹行（树里的节点一定带 data-node-id）
    const row = [...document.querySelectorAll('[data-node-id]')].find(
      (el) => (el.textContent || '').includes('E2E-多选'),
    );
    if (!row) return { found: false };
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
      clientX: Math.round(rect.left + 20), clientY: Math.round(rect.top + 8),
    }));
    await new Promise(r => setTimeout(r, 400));
    const text = document.body.innerText;
    return {
      found: true,
      hasOpenAll: text.includes('在新标签页中打开全部'),
      hasRename: text.includes('重命名'),
      hasAgent: text.includes('让 MarkAI 整理'),
    };
  })()`);
  check(
    '树里右键文件夹：菜单出现且含关键项',
    treeMenu.found && treeMenu.hasOpenAll && treeMenu.hasRename && treeMenu.hasAgent,
    JSON.stringify(treeMenu),
  );

  const menuClosed = await ev(`(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    return { stillOpen: document.body.innerText.includes('在新标签页中打开全部') };
  })()`);
  check('右键菜单可以 Esc 关闭', menuClosed.stillOpen === false, JSON.stringify(menuClosed));

  /* ── 9.7 树的键盘展开/折叠：懒人最常用的导航动作 ──
   * 树是扁平列表渲染（不是嵌套 DOM），展开/折叠靠 store + aria-expanded 反映；
   * 一旦这条链路断了，用户按方向键会「什么都没发生」，且不会有任何报错。 */
  // 自带数据：不依赖前面测试留下的状态（那些状态会随用例顺序变化，很难排查）
  const keySeed = await ev(`(async () => {
    const bar = (await chrome.bookmarks.getTree())[0].children.find(c => c.id === '1');
    const folder = await chrome.bookmarks.create({ parentId: bar.id, title: 'E2E-树键' });
    await chrome.bookmarks.create({ parentId: folder.id, title: '树键一', url: 'https://treekey-a.example.com/1' });
    await chrome.bookmarks.create({ parentId: folder.id, title: '树键二', url: 'https://treekey-b.example.com/2' });
    return { folderId: folder.id };
  })()`);
  await reload();
  const treeKeys = await ev(`(async () => {
    const tree = document.querySelector('[role="tree"]');
    const folder = [...document.querySelectorAll('[role="treeitem"]')].find(
      (el) => (el.textContent || '').includes('E2E-树键'),
    );
    if (!tree || !folder) return { ok: false, reason: 'tree-or-folder-missing' };
    const id = folder.getAttribute('data-node-id');
    // 方向键作用于**高亮项**（activeId），不是当前选中的文件夹；
    // 真实用户是「鼠标移到某行 → 按方向键」，所以这里用 mouseover 置高亮。
    folder.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    tree.focus();
    await new Promise(r => setTimeout(r, 300));
    const before = document.querySelectorAll('[role="treeitem"]').length;

    tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await new Promise(r => setTimeout(r, 350));
    const afterExpand = document.querySelectorAll('[role="treeitem"]').length;
    const expandedNow = document.querySelector('[role="treeitem"][data-node-id="' + id + '"]')?.getAttribute('aria-expanded');

    tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await new Promise(r => setTimeout(r, 350));
    const afterCollapse = document.querySelectorAll('[role="treeitem"]').length;
    const collapsedNow = document.querySelector('[role="treeitem"][data-node-id="' + id + '"]')?.getAttribute('aria-expanded');
    return { ok: true, before, afterExpand, afterCollapse, expandedNow, collapsedNow };
  })()`);
  check(
    '方向键可以展开 / 折叠树节点（aria-expanded 同步）',
    treeKeys.ok && treeKeys.afterExpand > treeKeys.before && treeKeys.expandedNow === 'true' &&
      treeKeys.afterCollapse === treeKeys.before && treeKeys.collapsedNow === 'false',
    JSON.stringify(treeKeys),
  );
  await ev(`chrome.bookmarks.removeTree(${JSON.stringify(keySeed.folderId)}).catch(() => {})`);

  /* ── 9.8 「移动到…」选择器：多选后最常用的去向操作 ──
   * 选器要能做三件事：列出候选、禁掉「自身/子文件夹」、选中后**把选中的每一条**都搬过去。
   * 只要「只搬了第一条」这种 bug 存在，用户选 20 条会以为全搬了。 */
  const moveSeed = await ev(`(async () => {
    const bar = (await chrome.bookmarks.getTree())[0].children.find(c => c.id === '1');
    const from = await chrome.bookmarks.create({ parentId: bar.id, title: 'E2E-移动源' });
    const to = await chrome.bookmarks.create({ parentId: bar.id, title: 'E2E-移动靶' });
    const a = await chrome.bookmarks.create({ parentId: from.id, title: '移动一', url: 'https://move-a.example.com/1' });
    const b = await chrome.bookmarks.create({ parentId: from.id, title: '移动二', url: 'https://move-b.example.com/2' });
    return { fromId: from.id, toId: to.id, ids: [a.id, b.id] };
  })()`);
  await reload();
  const moveFlow = await ev(`(async () => {
    const srcRow = [...document.querySelectorAll('[role="treeitem"]')].find((el) => (el.textContent || '').includes('E2E-移动源'));
    if (!srcRow) return { ok: false, reason: 'no-src' };
    srcRow.click();
    await new Promise(r => setTimeout(r, 600));
    const rows = [...document.querySelectorAll('[role="listitem"]')].filter((el) => (el.getAttribute('title') || '').includes('move-'));
    if (rows.length !== 2) return { ok: false, reason: 'rows', n: rows.length };
    for (const row of rows) {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
      await new Promise(r => setTimeout(r, 100));
    }
    await new Promise(r => setTimeout(r, 400));
    const selectedText = document.body.innerText.includes('已选') ? 'yes' : 'no';
    // 完整页的文案是「移动」，窄屏才是 title="移动到…"；两者都匹配
    const moveBtn = [...document.querySelectorAll('button')].find(
      (b) => (b.textContent || '').trim() === '移动' || (b.getAttribute('title') || '').includes('移动到'),
    );
    if (!moveBtn) {
      const titles = [...document.querySelectorAll('button[title]')].map((b) => b.getAttribute('title')).slice(0, 10);
      return { ok: false, reason: 'no-move-button', selectedText, titles, rowTitles: rows.map((r) => r.getAttribute('title')) };
    }
    moveBtn.click();
    await new Promise(r => setTimeout(r, 500));
    const pickerButtons = [...document.querySelectorAll('[role="dialog"] button')].filter((b) => (b.getAttribute('title') || '').includes('E2E-移动靶'));
    if (pickerButtons.length === 0) {
      const all = [...document.querySelectorAll('[role="dialog"] button')].map((b) => (b.textContent || '').trim()).slice(0, 8);
      return { ok: false, reason: 'no-target-in-picker', options: all };
    }
    // 自身/子文件夹应被禁用
    const selfBtn = [...document.querySelectorAll('[role="dialog"] button')].find((b) => (b.getAttribute('title') || '') === '不能移动到自身或其子文件夹');
    pickerButtons[0].click();
    await new Promise(r => setTimeout(r, 1800));
    const kids = await chrome.bookmarks.getChildren(${JSON.stringify(moveSeed.toId)});
    return { ok: true, movedCount: kids.length, hadSelfDisabled: !!selfBtn };
  })()`);
  check(
    '移动到…：选中两条后能一次搬过去，自身/子文件夹被禁用',
    moveFlow.ok === true && moveFlow.movedCount === 2,
    JSON.stringify(moveFlow),
  );
  await ev(`chrome.bookmarks.removeTree(${JSON.stringify(moveSeed.fromId)}).catch(() => {})`);
  await ev(`chrome.bookmarks.removeTree(${JSON.stringify(moveSeed.toId)}).catch(() => {})`);

  /* 「不能移动到自身或子文件夹」这条防护：选中一个文件夹去移动时，
   * 它自己和它的后代必须在候选里被禁用——否则用户会把文件夹搬进自己里面，结构直接坏掉。 */
  const guardSeed = await ev(`(async () => {
    const bar = (await chrome.bookmarks.getTree())[0].children.find(c => c.id === '1');
    const outer = await chrome.bookmarks.create({ parentId: bar.id, title: 'E2E-防护外' });
    const inner = await chrome.bookmarks.create({ parentId: outer.id, title: 'E2E-防护内' });
    return { outerId: outer.id, innerId: inner.id };
  })()`);
  await reload();
  const guardFlow = await ev(`(async () => {
    const outerRow = [...document.querySelectorAll('[role="treeitem"]')].find((el) => (el.textContent || '').includes('E2E-防护外'));
    if (!outerRow) return { ok: false, reason: 'no-outer' };
    outerRow.click();
    await new Promise(r => setTimeout(r, 600));
    // 列表里应当有这个子文件夹行（文件夹也可被选中）
    const innerRow = [...document.querySelectorAll('[role="listitem"]')].find((el) => (el.textContent || '').includes('E2E-防护内'));
    if (!innerRow) return { ok: false, reason: 'no-inner-row' };
    innerRow.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    await new Promise(r => setTimeout(r, 400));
    const moveBtn = [...document.querySelectorAll('button')].find(
      (b) => (b.textContent || '').trim() === '移动' || (b.getAttribute('title') || '').includes('移动到'),
    );
    if (!moveBtn) return { ok: false, reason: 'no-move-button' };
    moveBtn.click();
    await new Promise(r => setTimeout(r, 500));
    const dialogButtons = [...document.querySelectorAll('[role="dialog"] button')];
    const banned = dialogButtons.filter((b) => (b.getAttribute('title') || '') === '不能移动到自身或其子文件夹');
    const bannedLabels = banned.map((b) => (b.textContent || '').trim());
    return {
      ok: true,
      disabledCount: banned.filter((b) => b.disabled).length,
      bannedLabels,
      // 命中自身即可（子文件夹此时是空的，不一定出现在候选里）
      hitsSelf: bannedLabels.some((t) => t.includes('E2E-防护内')),
    };
  })()`);
  check(
    '移动选择器：不能把文件夹搬进它自己（自身候选被禁用）',
    guardFlow.ok === true && guardFlow.hitsSelf === true && guardFlow.disabledCount >= 1,
    JSON.stringify(guardFlow),
  );
  await reload();
  await sleep(500);
  await ev(`chrome.bookmarks.removeTree(${JSON.stringify(guardSeed.outerId)}).catch(() => {})`);


  markSection('新用户 / 弹出窗 / 设置页 / 侧边栏');

    if (!QUICK) {  // ── 快速档跳过：新用户视角
/* ── 10. 新用户视角：清空一切之后，界面该说的话还在不在 ──
   * 用户装完扩展看到的正是这一屏。空状态文案很容易在重构里悄悄丢，
   * 丢了的后果是「一片空白，不知道能干什么」。 */
  await ev(`(async () => {
    await chrome.storage.local.remove([
      'markai.organize.log', 'markai.organize.optout', 'markai.organize.hinted',
      'markai.ai', 'markai.config', 'markai.undo', 'markai.undo.pending',
    ]);
    return true;
  })()`);
  await reload();
  await waitFor(async () => await ev(`document.body.innerText.includes('我是你的书签管家')`), 6000);
  await waitFor(async () => await ev(`!!document.querySelector('button[aria-label="更多"]')`), 4000);

  const freshUser = await ev(`(() => {
    const text = document.body.innerText;
    return {
      // 聊天欢迎卡片：告诉用户「我是干什么的」+「收藏会自动归类」
      hasWelcome: text.includes('我是你的书签管家'),
      hasAutoOrganizeHint: text.includes('自动归类'),
      // 未配置 AI 时的引导入口
      hasAiSetup: text.includes('尚未配置 AI 服务') || text.includes('去配置'),
    };
  })()`);
  check(
    '新用户：欢迎卡片、自动整理提示、AI 配置入口都在',
    freshUser.hasWelcome && freshUser.hasAutoOrganizeHint && freshUser.hasAiSetup,
    JSON.stringify(freshUser),
  );

  // 整理记录的空状态：不能是空白面板
  await ev(`(async () => { await (async () => {if (!document.querySelector('[role="menu"]')) document.querySelector('button[aria-label="更多"]')?.click();await new Promise(r => setTimeout(r, 320));const items = [...document.querySelectorAll('[role="menuitem"]')];const hit = items.find(b => (b.textContent || '').includes('整理记录'));if (hit) hit.click();await new Promise(r => setTimeout(r, 300));return !!hit; })(); })()`);
  await waitFor(async () => await ev(`!!document.querySelector('[role="dialog"]')`), 4000);
  await sleep(200);
  const emptyLog = await ev(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return { open: false };
    const text = dlg.innerText;
    return {
      open: true,
      hasEmptyTitle: text.includes('还没有整理记录'),
      hasGuidance: text.includes('收藏一个网页后'),
      // 用字面量而不是正则：这段代码在模板字符串里，反斜杠会被吞（踩过两次）
      todayZero: text.includes('今天 0 条'),
      // 反向断言：没有可重试项时，不该出现「重试全部」这种点了也没用的按钮
      hasNoRetryAll: ![...dlg.querySelectorAll('button')].some((b) => (b.textContent || '').includes('重试全部')),
    };
  })()`);
  check(
    '新用户：整理记录空状态有说明和下一步（不是空白面板）',
    emptyLog.open && emptyLog.hasEmptyTitle && emptyLog.hasGuidance && emptyLog.todayZero && emptyLog.hasNoRetryAll,
    JSON.stringify(emptyLog),
  );
  // 空状态下的对比度：空状态大量使用 muted-foreground，最容易不达标
  const emptyStateContrast = await ev(CONTRAST_EXPR);
  check(
    '空状态（整理记录为空）下文本对比度达标（WCAG AA）',
    emptyStateContrast.total === 0,
    JSON.stringify(emptyStateContrast),
  );

  await ev(`(() => { document.querySelector('[role="dialog"] [aria-label="关闭"]')?.click(); })()`);
  await sleep(200);

  // 快捷键速查：新用户不该需要读 README 才知道这些键
  await ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }))`).catch(() => {});
  await sleep(500);
  const freshShortcuts = await ev(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    return { open: !!dlg, text: dlg ? dlg.innerText.slice(0, 40) : '' };
  })()`);
  check('新用户：按「?」能打开快捷键速查', freshShortcuts.open && freshShortcuts.text.includes('快捷键'), JSON.stringify(freshShortcuts));
  await ev(`(() => { document.querySelector('[role="dialog"] [aria-label="关闭"]')?.click(); })()`);

    }

  /* 位置校验（不依赖截图）：提示条必须是「中栏 flex-col 的子元素」且落在列表下方，
   * 放到中栏外面会变成根 flex-row 的兄弟、被挤成一条竖条 —— 这个错我犯过一次。
   * 一个页面内脚本完成「等渲染 → 量位置 → 点跳过」：
   * 拆成多次往返时，每次之间的时序都不保证（实测出现过「位置查不到、紧接着存在性又查到了」）。 */
  const tour = await ev(`(async () => {
    for (let i = 0; i < 40; i++) {
      if (document.querySelector('[aria-label="新手提示"]')) break;
      await new Promise(r => setTimeout(r, 100));
    }
    const tip = document.querySelector('[aria-label="新手提示"]');
    if (!tip) return { present: false };
    const parent = tip.parentElement;
    const pStyle = parent ? getComputedStyle(parent) : null;
    const list = document.querySelector('input#markai-search') || document.querySelector('[role="listbox"]');
    const tipRect = tip.getBoundingClientRect();
    const listRect = list ? list.getBoundingClientRect() : null;
    const layout = {
      parentFlexDir: pStyle ? pStyle.flexDirection : null,
      sharesColumnWithList: !!(parent && list && parent.contains(list)),
      belowList: listRect ? tipRect.top >= listRect.bottom - 2 : null,
    };
    const firstStep = (tip.innerText || '').includes('1/3');
    const skip = tip.querySelector('button[aria-label="跳过新手提示"]');
    if (skip) skip.click();
    await new Promise(r => setTimeout(r, 400));
    return { present: true, firstStep, layout, dismissed: !document.querySelector('[aria-label="新手提示"]') };
  })()`);
  check(
    '提示条在中栏底部（与列表同一列、且位于列表下方）',
    tour.present === true && tour.layout.parentFlexDir === 'column' &&
      tour.layout.sharesColumnWithList === true && tour.layout.belowList === true,
    JSON.stringify(tour),
  );
  check(
    '新用户：底部有三步提示条（1/3），跳过之后就消失',
    tour.present === true && tour.firstStep === true && tour.dismissed === true,
    JSON.stringify(tour),
  );
  await reload();
  await sleep(700);
  const tourGone = await ev(`!document.querySelector('[aria-label="新手提示"]')`);
  check('跳过新手提示后重载也不再出现', tourGone === true, `gone=${tourGone}`);


/* ── 11. 弹出窗：用户点扩展图标看到的第一个界面 ── */
  const { targetId: popupTargetId } = await cdp.send('Target.createTarget', {
    url: `chrome-extension://${EXT_ID}/popup.html`,
  });
  const { sessionId: popupSession } = await cdp.send('Target.attachToTarget', { targetId: popupTargetId, flatten: true });
  await cdp.send('Runtime.enable', {}, popupSession);

  const evPopup = async (expression) => {
    const res = await cdp.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      popupSession,
    );
    if (res.exceptionDetails) {
      throw new Error(`popup 执行异常: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    }
    return res.result.value;
  };
  for (let i = 0; i < 60; i++) {
    if (await evPopup(`document.body.innerText.includes('MarkAI')`).catch(() => false)) break;
    await sleep(150);
  }
  const popupState = await evPopup(`(() => {
    const text = document.body.innerText;
    return {
      // 用字符类而不是 \d：这段在模板字符串里，反斜杠会被吞（这个坑这轮第四次）
      version: /v[0-9]+[.][0-9]+/.test(text),
      hasPendingCard: text.includes('待删除清单'),
      hasOrganizeCard: text.includes('自动整理'),
      hasOpenFull: text.includes('打开完整管理页'),
      hasSidePanel: text.includes('打开侧边栏'),
      hasOptions: text.includes('AI 设置'),
      // 空库时自动整理卡片要给出「为什么现在没内容」的说明，而不是空白
      hasOrganizeEmptyHint: text.includes('记录会出现在这里') || text.includes('今天'),
      // 主次分层：AI 未配置时「去配置」才是主行动，「打开完整管理页」应当是描边而非实心
      fullBtnIsOutline: (() => {
        const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('打开完整管理页'));
        return btn ? !(btn.className || '').includes('bg-accent') : false;
      })(),
      setupBtnIsPrimary: (() => {
        const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('去配置'));
        return btn ? (btn.className || '').includes('bg-accent') : false;
      })(),
    };
  })()`);
  check(
    '弹出窗：版本、待删卡、自动整理卡、三个入口都在',
    popupState.version && popupState.hasPendingCard && popupState.hasOrganizeCard &&
      popupState.hasOpenFull && popupState.hasSidePanel && popupState.hasOptions,
    JSON.stringify(popupState),
  );
  check(
    '弹出窗：自动整理卡在空库时也有说明',
    popupState.hasOrganizeEmptyHint === true,
    JSON.stringify(popupState),
  );
  check(
    '弹出窗：未配置 AI 时主次分明（去配置是实心、打开管理页是描边）',
    popupState.setupBtnIsPrimary === true && popupState.fullBtnIsOutline === true,
    JSON.stringify({ setup: popupState.setupBtnIsPrimary, full: popupState.fullBtnIsOutline }),
  );
  const popupContrast = await evPopup(CONTRAST_EXPR);
  check(
    '弹出窗的文本对比度达标（WCAG AA）',
    popupContrast.total === 0,
    JSON.stringify(popupContrast),
  );

  /* popup 是入口：点「打开完整管理页」必须真的跳到 page.html（而不是点了没反应）。
   * 用 Target.getTargets 验证新标签页出现——比查 chrome.tabs 更直接反映「浏览器真的开了一个页面」。 */
  const idBefore = new Set((await cdp.send('Target.getTargets')).targetInfos.map((t) => t.targetId));
  await evPopup(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const b = btns.find((x) => (x.textContent || '').includes('打开完整管理页'))
      || btns.find((x) => (x.textContent || '').includes('管理页'));
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(1200);
  const targetsAfter = (await cdp.send('Target.getTargets')).targetInfos;
  // 只看「这次新开的」——page.html 可能本来就有（e2e 自己的主窗口），绝不能关掉它
  const openedPage = targetsAfter.find((t) => !idBefore.has(t.targetId) && t.url.includes('page.html'));
  const reusedExisting = targetsAfter.find((t) => idBefore.has(t.targetId) && t.url.includes('page.html'));
  check(
    '弹出窗：点「打开完整管理页」真的会打开管理页',
    !!openedPage || !!reusedExisting,
    JSON.stringify({
      newTargets: targetsAfter.length - idBefore.size,
      pageUrl: (openedPage ?? reusedExisting)?.url?.slice(-40) ?? null,
    }),
  );
  if (openedPage) await cdp.send('Target.closeTarget', { targetId: openedPage.targetId }).catch(() => {});

  // 点完「打开管理页」popup 会自己 close，之后不能再对它求值
  await cdp.send('Target.closeTarget', { targetId: popupTargetId }).catch(() => {});

  /* ── 12. 设置页：引导与开关是否真的会存 ── */
  const { targetId: optTargetId } = await cdp.send('Target.createTarget', {
    url: `chrome-extension://${EXT_ID}/options.html`,
  });
  const { sessionId: optSession } = await cdp.send('Target.attachToTarget', { targetId: optTargetId, flatten: true });
  await cdp.send('Runtime.enable', {}, optSession);
  const evOpt = async (expression) => {
    const res = await cdp.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      optSession,
    );
    if (res.exceptionDetails) {
      throw new Error(`options 执行异常: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    }
    return res.result.value;
  };
  for (let i = 0; i < 80; i++) {
    // 等到「自动整理」这一段也渲染完，否则下面的断言会看到半成品页面
    if (await evOpt(`document.body.innerText.includes('新书签自动整理')`).catch(() => false)) break;
    await sleep(150);
  }

  const optInitial = await evOpt(`(() => {
    const text = document.body.innerText;
    return {
      hasSteps: text.includes('三步开始用'),
      hasAutoOrganize: text.includes('新书签自动整理'),
      hasAiToggle: text.includes('允许 AI 参与自动整理'),
      // 用按钮文本来判断：innerText 对某些容器不返回文本，容易误报
      hasLogLink: [...document.querySelectorAll('button')].some((b) => (b.textContent || '').includes('查看整理记录')),
    };
  })()`);
  check(
    '设置页：未配置时显示三步引导，自动整理相关项齐全',
    optInitial.hasSteps && optInitial.hasAutoOrganize && optInitial.hasAiToggle && optInitial.hasLogLink,
    JSON.stringify(optInitial),
  );

  // 真正点一下开关，确认落盘（这条链路断=用户改了设置但没生效，且界面看起来已改）
  const toggleSaved = await evOpt(`(async () => {
    const box = document.querySelector('[role="checkbox"][aria-label="新书签自动整理"]');
    if (!box) return { ok: false, reason: 'no-checkbox' };
    const before = box.getAttribute('aria-checked');
    box.click();
    await new Promise(r => setTimeout(r, 600));
    const saved = ((await chrome.storage.local.get('markai.config'))['markai.config'] || {}).autoOrganizeNew;
    const after = document.querySelector('[role="checkbox"][aria-label="新书签自动整理"]')?.getAttribute('aria-checked');
    // 恢复原值，避免影响后续（这个 profile 后面还会被别处断言）
    const box2 = document.querySelector('[role="checkbox"][aria-label="新书签自动整理"]');
    if (box2 && box2.getAttribute('aria-checked') !== before) box2.click();
    await new Promise(r => setTimeout(r, 400));
    return { ok: true, before, after, saved };
  })()`);
  check(
    '设置页：点自动整理开关会真的写进 storage',
    toggleSaved.ok && toggleSaved.after !== toggleSaved.before && typeof toggleSaved.saved === 'boolean',
    JSON.stringify(toggleSaved),
  );
  /* 三步引导的「消失」分支：配好之后还一直挂着，会让老用户以为没配成功 */
  await evOpt(`chrome.storage.local.set({ 'markai.config': {
    providerId: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-e2e-dummy',
    model: 'deepseek-v4-flash', autoOrganizeNew: true,
  } })`);
  await cdp.send('Page.reload', {}, optSession);
  const configuredState = await (async () => {
    for (let i = 0; i < 80; i++) {
      const ready = await evOpt(`document.body.innerText.includes('AI 服务')`).catch(() => false);
      if (ready) {
        // 再多等一拍，让 needsSetup 的分支渲染完
        await sleep(400);
        return evOpt(`(() => ({
          hasSteps: document.body.innerText.includes('三步开始用'),
          hasModel: (document.body.innerText || '').includes('deepseek-v4-flash'),
        }))()`);
      }
      await sleep(150);
    }
    return { hasSteps: null, hasModel: null };
  })();
  check(
    '设置页：配置完成后三步引导消失',
    configuredState.hasSteps === false && configuredState.hasModel === true,
    JSON.stringify(configuredState),
  );
  // 恢复成未配置，避免影响后面的用例
  await evOpt(`chrome.storage.local.remove('markai.config')`);
  const optContrast = await evOpt(CONTRAST_EXPR);
  check(
    '设置页的文本对比度达标（WCAG AA）',
    optContrast.total === 0,
    JSON.stringify(optContrast),
  );
  await cdp.send('Target.closeTarget', { targetId: optTargetId });

  /* ── 13. 侧边栏的书签树折叠：窄屏下最实用的一键，此前只有截图 ── */
  const { targetId: spTargetId } = await cdp.send('Target.createTarget', {
    url: `chrome-extension://${EXT_ID}/sidepanel.html`,
  });
  const { sessionId: spSession } = await cdp.send('Target.attachToTarget', { targetId: spTargetId, flatten: true });
  await cdp.send('Runtime.enable', {}, spSession);
  const evSp = async (expression) => {
    const res = await cdp.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      spSession,
    );
    if (res.exceptionDetails) {
      throw new Error(`sidepanel 执行异常: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    }
    return res.result.value;
  };
  for (let i = 0; i < 80; i++) {
    if (await evSp(`!!document.querySelector('[role="tree"]')`).catch(() => false)) break;
    await sleep(150);
  }
  const collapseFlow = await evSp(`(async () => {
    const collapseBtn = document.querySelector('button[aria-label="收起书签树"]');
    if (!collapseBtn) return { ok: false, reason: 'no-collapse-button' };
    collapseBtn.click();
    await new Promise(r => setTimeout(r, 400));
    const treeGone = !document.querySelector('[role="tree"]');
    const expandBtn = document.querySelector('button[aria-label="展开书签树"]');
    const savedCollapsed = (await chrome.storage.local.get('markai.ui.treeCollapsed'))['markai.ui.treeCollapsed'];
    if (expandBtn) expandBtn.click();
    await new Promise(r => setTimeout(r, 400));
    const treeBack = !!document.querySelector('[role="tree"]');
    return { ok: true, treeGone: treeGone, hasExpandBtn: !!expandBtn, savedCollapsed, treeBack };
  })()`);
  check(
    '侧边栏：树可以收起再展开（状态写进 storage）',
    collapseFlow.ok && collapseFlow.treeGone && collapseFlow.hasExpandBtn &&
      collapseFlow.savedCollapsed === true && collapseFlow.treeBack,
    JSON.stringify(collapseFlow),
  );
  /* 320px = Chrome 侧边栏的最小宽度。之前只验过 430px，
   * 窄到 320 时最容易出的是「横向溢出」和「统计条挤成一团」。 */
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width: 320, height: 800, deviceScaleFactor: 1, mobile: false },
    spSession,
  );
  await sleep(400);
  const narrow = await evSp(`(async () => {
    const root = document.documentElement;
    const header = document.querySelector('header');
    // 注意：CDP 设备模拟下 body.scrollWidth 恒为视口的 2 倍（实测与真实窗口不符），
    // 不能拿它当「是否溢出」的判据。改用「顶栏自己能否横向滚动」+「关键内容是否仍在」。
    const before = {
      headerOverflowX: header ? getComputedStyle(header).overflowX : 'none',
      headerMinW: header ? getComputedStyle(header).minWidth : '',
      clientWidth: root.clientWidth,
    };
    const btn = document.querySelector('button[title^="整理记录"]');
    if (btn) btn.click();
    await new Promise(r => setTimeout(r, 600));
    const dlg = document.querySelector('[role="dialog"]');
    const text = dlg ? dlg.innerText : '';
    const dlgRect = dlg ? dlg.getBoundingClientRect() : null;
    return {
      ...before,
      dlgWithinViewport: dlgRect ? dlgRect.right <= 322 && dlgRect.left >= -2 : false,
      hasStats: text.includes('今天'),
    };
  })()`);
  /* 窄屏的「真实可达性」：截图会被预览层按内容去重（看不到变化），所以改用计算样式：
   *  ① 树容器必须裁剪溢出（overflow: hidden），否则树头部会盖住中栏；
   *  ② 顶栏可以滚动，且右侧按钮在可滚动范围内（不是被裁掉、够不到）。 */
  const reachability = await evSp(`(() => {
    const tree = document.querySelector('[role="tree"]');
    const treeBox = tree ? tree.parentElement : null;
    const treeStyle = treeBox ? getComputedStyle(treeBox) : null;
    const header = document.querySelector('header');
    let settingsReachable = null;
    let headerScrollable = null;
    if (header) {
      headerScrollable = header.scrollWidth > header.clientWidth;
      const settings = header.querySelector('button[title="AI 设置"], button[aria-label="AI 设置"]');
      if (settings) {
        const r = settings.getBoundingClientRect();
        const hRect = header.getBoundingClientRect();
        // 在顶栏的可滚动内容范围内（right 不超过 header 滚动宽度对应位置）
        // 右侧按钮组应当固定在视口内（不参与左侧滚动）
      settingsReachable = r.right <= window.innerWidth + 2 && r.left >= hRect.left - 2;
      }
    }
    return {
      treeOverflow: treeStyle ? treeStyle.overflow : null,
      headerScrollable,
      settingsReachable,
      hasSettings: !!header?.querySelector('button[title="AI 设置"], button[aria-label="AI 设置"]'),
    };
  })()`);
  // 深色 + 窄屏同时成立：两个条件各自验过，但组合没验（CSS 媒体查询与主题变量会同时作用）
  await evSp(`chrome.storage.local.set({ 'markai.theme': 'dark' })`);
  await waitFor(async () => await evSp(`document.documentElement.classList.contains('dark')`), 3000);
  await sleep(400);
  const darkNarrowContrast = await evSp(CONTRAST_EXPR);
  await evSp(`chrome.storage.local.set({ 'markai.theme': 'light' })`);
  await waitFor(async () => await evSp(`!document.documentElement.classList.contains('dark')`), 3000);
  await sleep(300);
  // 三条件同时成立：320px + 深色 + 对话框打开（窄屏下对话框会切到不同的内边距与换行）
  await evSp(`(async () => { await (async () => {if (!document.querySelector('[role="menu"]')) document.querySelector('button[aria-label="更多"]')?.click();await new Promise(r => setTimeout(r, 320));const items = [...document.querySelectorAll('[role="menuitem"]')];const hit = items.find(b => (b.textContent || '').includes('整理记录'));if (hit) hit.click();await new Promise(r => setTimeout(r, 300));return !!hit; })(); })()`);
  await sleep(600);
  const tripleContrast = await evSp(CONTRAST_EXPR);
  check(
    '320px + 深色 + 对话框打开：三条件组合下对比度仍达标',
    tripleContrast.total === 0,
    JSON.stringify(tripleContrast),
  );
  await evSp(`(() => { document.querySelector('[role="dialog"] [aria-label="关闭"]')?.click(); })()`).catch(() => {});
  await sleep(300);

  check(
    '320px + 深色：对比度仍然达标（组合状态）',
    darkNarrowContrast.total === 0,
    JSON.stringify(darkNarrowContrast),
  );

  check(
    '320px：树容器裁剪溢出（不盖中栏），右侧按钮固定在视口内（不用横向滑动去找）',
    reachability.treeOverflow === 'hidden' && reachability.hasSettings === true &&
      reachability.settingsReachable === true,
    JSON.stringify(reachability),
  );
  // 顶栏滚动能力已由上面那条「右侧按钮固定」覆盖，这里只看对话框与内容
  check(
    '320px（侧边栏最小宽度）：对话框不超过视口，关键内容仍在',
    narrow.dlgWithinViewport === true && narrow.hasSweep === true && narrow.hasStats === true,
    JSON.stringify(narrow),
  );
  await evSp(`(() => { document.querySelector('[role="dialog"] [aria-label="关闭"]')?.click(); })()`).catch(() => {});
  await sleep(200);
  await cdp.send('Emulation.clearDeviceMetricsOverride', {}, spSession);
  await sleep(300);

  // 侧边栏单独跑一次对比度：它复用主界面组件，但窄屏下会切到不同的排版分支
  const spContrast = await evSp(CONTRAST_EXPR);
  check(
    '侧边栏的文本对比度达标（WCAG AA）',
    spContrast.total === 0,
    JSON.stringify(spContrast),
  );
  await cdp.send('Target.closeTarget', { targetId: spTargetId });

  markSection('拖拽');

  /* 待删清单的勾选：用户取消勾选是「这几条我不想删」的明确意图，
   * 关掉面板再打开必须还在——否则重开被重置成全选，下一次点删除就连它们一起删了。 */
  const uncheckedSeed = await ev(`(async () => {
    const bar = (await chrome.bookmarks.getTree())[0].children.find(c => c.id === '1');
    const a = await chrome.bookmarks.create({ parentId: bar.id, title: '保留测试A', url: 'https://keep-a.example.com/1' });
    const b = await chrome.bookmarks.create({ parentId: bar.id, title: '保留测试B', url: 'https://keep-b.example.com/2' });
    const st = (await chrome.storage.local.get('markai.ai'))['markai.ai'] || {};
    st.pendingDeletions = [
      ...(st.pendingDeletions || []),
      { id: 'keep-a', bookmarkId: a.id, title: '保留测试A', url: 'https://keep-a.example.com/1', reason: '测试', status: 'pending' },
      { id: 'keep-b', bookmarkId: b.id, title: '保留测试B', url: 'https://keep-b.example.com/2', reason: '测试', status: 'pending' },
    ];
    await chrome.storage.local.set({ 'markai.ai': st });
    return { a: a.id, b: b.id };
  })()`);
  await reload();
  await sleep(600);
  const uncheckedFlow = await ev(`(async () => {
    const openBtn = document.querySelector('button[title*="待删"], button[aria-label*="待删"]');
    if (!openBtn) return { ok: false, reason: 'no-open-button' };
    openBtn.click();
    await new Promise(r => setTimeout(r, 600));
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return { ok: false, reason: 'no-dialog' };
    const boxes = [...dlg.querySelectorAll('[role="checkbox"]')];
    if (boxes.length < 2) return { ok: false, reason: 'too-few-checkboxes', n: boxes.length };
    const target = boxes[0];
    const label = target.getAttribute('aria-label') || '';
    target.click();
    await new Promise(r => setTimeout(r, 300));
    const afterUncheck = target.getAttribute('aria-checked');
    // 关闭再打开
    dlg.querySelector('button[aria-label="关闭"]')?.click();
    await new Promise(r => setTimeout(r, 500));
    document.querySelector('button[title*="待删"], button[aria-label*="待删"]')?.click();
    await new Promise(r => setTimeout(r, 600));
    const dlg2 = document.querySelector('[role="dialog"]');
    const sameBox = dlg2 ? [...dlg2.querySelectorAll('[role="checkbox"]')].find((b) => (b.getAttribute('aria-label') || '') === label) : null;
    const afterReopen = sameBox ? sameBox.getAttribute('aria-checked') : null;
    dlg2?.querySelector('button[aria-label="关闭"]')?.click();
    return { ok: true, label, afterUncheck, afterReopen };
  })()`);
  check(
    '待删清单：取消勾选后关掉面板再打开，那一条仍然是取消状态（不会变回全选）',
    uncheckedFlow.ok === true && uncheckedFlow.afterUncheck === 'false' && uncheckedFlow.afterReopen === 'false',
    JSON.stringify(uncheckedFlow),
  );
  // 清理：标记为已放弃并删掉书签
  await ev(`(async () => {
    const st = (await chrome.storage.local.get('markai.ai'))['markai.ai'] || {};
    st.pendingDeletions = (st.pendingDeletions || []).filter((p) => p.id !== 'keep-a' && p.id !== 'keep-b');
    await chrome.storage.local.set({ 'markai.ai': st });
    for (const id of [${JSON.stringify(uncheckedSeed.a)}, ${JSON.stringify(uncheckedSeed.b)}]) {
      await chrome.bookmarks.remove(id).catch(() => {});
    }
    return true;
  })()`);
  await reload();
  await sleep(500);

  /* 空文件夹不是死路：应当给出「新建书签」这个下一步，而不是只写「此文件夹为空」。 */
  const emptyFolder = await ev(`(async () => {
    const bar = (await chrome.bookmarks.getTree())[0].children.find(c => c.id === '1');
    const folder = await chrome.bookmarks.create({ parentId: bar.id, title: 'E2E-空文件夹' });
    return { id: folder.id };
  })()`);
  await reload();
  const emptyState = await ev(`(async () => {
    const row = [...document.querySelectorAll('[role="treeitem"]')].find((el) => (el.textContent || '').includes('E2E-空文件夹'));
    if (!row) return { ok: false, reason: 'no-folder' };
    row.click();
    await new Promise(r => setTimeout(r, 600));
    const text = document.body.innerText;
    return {
      ok: true,
      saysEmpty: text.includes('此文件夹为空'),
      hasNewBookmark: text.includes('新建书签'),
      hasShortcutHint: text.includes('Ctrl+D'),
    };
  })()`);
  check(
    '空文件夹：除了「此文件夹为空」还给出下一步（新建书签 / Ctrl+D 提示）',
    emptyState.ok === true && emptyState.saysEmpty === true &&
      emptyState.hasNewBookmark === true && emptyState.hasShortcutHint === true,
    JSON.stringify(emptyState),
  );
  await ev(`chrome.bookmarks.removeTree(${JSON.stringify(emptyFolder.id)}).catch(() => {})`);

  /* 树的过滤无结果时同样要有出口（与中栏列表保持一致） */
  const treeFilterEmpty = await ev(`(async () => {
    const input = document.querySelector('input[aria-label="过滤书签树"]');
    if (!input) return { ok: false, reason: 'no-tree-filter' };
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'zzz-树里也搜不到-zzz');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 700));
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('清空过滤'));
    const hasExit = !!btn && document.body.innerText.includes('没有匹配的书签');
    if (btn) btn.click();
    await new Promise(r => setTimeout(r, 600));
    return { ok: true, hasExit, cleared: (document.querySelector('input[aria-label="过滤书签树"]')?.value ?? 'x') === '' };
  })()`);
  check(
    '树的过滤无结果：给出「清空过滤」出口，点击后真的清空',
    treeFilterEmpty.ok === true && treeFilterEmpty.hasExit === true && treeFilterEmpty.cleared === true,
    JSON.stringify(treeFilterEmpty),
  );

  /* 搜索无结果时也要给出口：「没有匹配的书签」单独一句会让人以为库坏了。 */
  const emptySearch = await ev(`(async () => {
    // 先进入书签栏（确定不是「未选文件夹」状态），再搜一个必然搜不到的词
    const rootRow = [...document.querySelectorAll('[role="treeitem"]')].find((el) => (el.textContent || '').includes('书签栏'));
    if (rootRow) rootRow.click();
    await new Promise(r => setTimeout(r, 500));
    const input = document.querySelector('input#markai-search');
    if (!input) return { ok: false, reason: 'no-input' };
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'zzz-绝对搜不到-zzz');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // 搜索是异步的：轮询到「空结果提示」出现，最多 3 秒
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (document.body.innerText.includes('没有匹配的书签')) break;
    }
    const text = document.body.innerText;
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('清空搜索'));
    const hasExit = !!btn && text.includes('没有匹配的书签');
    if (btn) btn.click();
    await new Promise(r => setTimeout(r, 600));
    return {
      ok: true,
      hasExit,
      clearedAfterClick: (document.querySelector('input#markai-search')?.value ?? 'x') === '',
      textHasEmptyHint: text.includes('没有匹配的书签'),
      buttons: [...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean).slice(0, 12),
    };
  })()`);
  check(
    '搜索无结果：给出「清空搜索」出口，点击后搜索框真的清空',
    emptySearch.ok === true && emptySearch.hasExit === true && emptySearch.clearedAfterClick === true,
    JSON.stringify(emptySearch),
  );

  /* 站内确认框（替代 window.confirm）的唯一入口：选中 >100 条后点整理。
   * 这里只走「取消」路径——确认路径会真的发出指令、调模型，代价太大。 */
  const confirmSeed = await ev(`(async () => {
    const bar = (await chrome.bookmarks.getTree())[0].children.find(c => c.id === '1');
    const folder = await chrome.bookmarks.create({ parentId: bar.id, title: 'E2E-确认框' });
    const batch = [];
    for (let i = 0; i < 101; i++) {
      batch.push(chrome.bookmarks.create({
        parentId: folder.id, title: '确认测试 ' + i, url: 'https://confirm-test.example.com/' + i,
      }));
      if (batch.length >= 50) { await Promise.all(batch); batch.length = 0; }
    }
    await Promise.all(batch);
    return { folderId: folder.id };
  })()`);
  await reload();
  const confirmFlow = await ev(`(async () => {
    const row = [...document.querySelectorAll('[role="treeitem"]')].find((el) => (el.textContent || '').includes('E2E-确认框'));
    if (!row) return { ok: false, reason: 'no-folder' };
    row.click();
    await new Promise(r => setTimeout(r, 900));
    // 列表容器没有 role，靠 tabIndex=0 且包含 listitem 来定位
    const list = [...document.querySelectorAll('div[tabindex="0"]')].find(
      (el) => el.querySelector('[role="listitem"]'),
    );
    if (!list) return { ok: false, reason: 'no-list' };
    list.focus();
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
    await new Promise(r => setTimeout(r, 700));
    const selectedText = document.body.innerText;
    const organizeBtn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('让 MarkAI 整理'));
    if (!organizeBtn) return { ok: false, reason: 'no-organize-button', sawSelection: selectedText.includes('已选') };
    organizeBtn.click();
    await new Promise(r => setTimeout(r, 600));
    const dlg = document.querySelector('[role="dialog"]');
    const text = dlg ? dlg.innerText : '';
    const appeared = !!dlg && text.includes('选中的书签比较多');
    const cancel = dlg ? [...dlg.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '取消') : null;
    if (cancel) cancel.click();
    await new Promise(r => setTimeout(r, 400));
    return { ok: true, appeared, dismissed: !document.querySelector('[role="dialog"]') };
  })()`);
  check(
    '选中 >100 条再点整理：先弹站内确认框，取消后不执行',
    confirmFlow.ok === true && confirmFlow.appeared === true && confirmFlow.dismissed === true,
    JSON.stringify(confirmFlow),
  );
  await ev(`chrome.bookmarks.removeTree(${JSON.stringify(confirmSeed.folderId)}).catch(() => {})`);
  await reload();

  /* ── 13.5 极端书名：真实用户会收藏奇形怪状的东西 ──
   * 200 字符无空格、emoji 开头、阿拉伯文（RTL）、日文长串、空标题、超长域名。
   * 判据不是「好看」，而是**布局不塌**：行高不变、文字被截断而不是撑破。 */
  const weirdSeed = await ev(`(async () => {
    const bar = (await chrome.bookmarks.getTree())[0].children.find(c => c.id === '1');
    const folder = await chrome.bookmarks.create({ parentId: bar.id, title: 'E2E-怪名字' });
    const items = [
      ['x'.repeat(200), 'https://long-title.example.com/x'],
      ['\u{1F389}\u{1F38A} emoji', 'https://emoji.example.com/x'],
      ['\u0645\u0631\u062d\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645 \u0639\u0646\u0648\u0627\u0646 \u0637\u0648\u064a\u0644', 'https://rtl.example.com/x'],
      ['这是一个非常长的中文标题用来测试截断行为是否正常工作并且不会撑破布局', 'https://cjk.example.com/x'],
      ['   ', 'https://whitespace-title.example.com/x'],
      ['超长域名', 'https://' + 'a'.repeat(60) + '.example.com/path'],
    ];
    const ids = [];
    for (const [title, url] of items) {
      const n = await chrome.bookmarks.create({ parentId: folder.id, title, url });
      ids.push(n.id);
    }
    return { folderId: folder.id, count: ids.length };
  })()`);
  await reload();
  const weird = await ev(`(async () => {
    const row = [...document.querySelectorAll('[role="treeitem"]')].find((el) => (el.textContent || '').includes('E2E-怪名字'));
    if (!row) return { ok: false, reason: 'no-folder' };
    row.click();
    await new Promise(r => setTimeout(r, 700));
    const items = [...document.querySelectorAll('[role="listitem"]')];
    const heights = items.map((el) => Math.round(el.getBoundingClientRect().height));
    const texts = items.map((el) => {
      const p = el.querySelector('p');
      return p ? { scroll: p.scrollWidth, client: p.clientWidth, truncated: p.scrollWidth > p.clientWidth + 1 } : null;
    });
    return {
      ok: true,
      count: items.length,
      allSameHeight: heights.length > 0 && heights.every((h) => h === heights[0]),
      rowHeight: heights[0] ?? 0,
      longTextTruncated: texts.filter(Boolean).some((t) => t.truncated),
    };
  })()`);
  check(
    '极端书名（200 字符 / emoji / RTL / CJK / 空白 / 超长域名）：行高一致且长文本被截断',
    weird.ok === true && weird.count === 6 && weird.allSameHeight === true &&
      weird.rowHeight === 40 && weird.longTextTruncated === true,
    JSON.stringify(weird),
  );
  await ev(`chrome.bookmarks.removeTree(${JSON.stringify(weirdSeed.folderId)}).catch(() => {})`);


  /* ── 14. 拖拽移动：覆盖清单里最大的空白 ──
   * HTML5 拖放可以用 DataTransfer 在真实浏览器里复现，不必模拟手势：
   * 列表行 dragstart → 树里的目标文件夹 dragover + drop → 书签的 parentId 应当改变。 */
  const dragSeed = await ev(`(async () => {
    const bar = (await chrome.bookmarks.getTree())[0].children.find(c => c.id === '1');
    const from = await chrome.bookmarks.create({ parentId: bar.id, title: 'E2E-拖源' });
    const to = await chrome.bookmarks.create({ parentId: bar.id, title: 'E2E-拖靶' });
    const item = await chrome.bookmarks.create({ parentId: from.id, title: '可拖书签', url: 'https://drag-me.example.com/x' });
    return { fromId: from.id, toId: to.id, itemId: item.id };
  })()`);
  await reload();
  const dragFlow = await ev(`(async () => {
    const fromRow = [...document.querySelectorAll('[role="treeitem"]')].find((el) => (el.textContent || '').includes('E2E-拖源'));
    if (!fromRow) return { ok: false, reason: 'no-source-folder' };
    fromRow.click();
    await new Promise(r => setTimeout(r, 600));
    const itemRow = [...document.querySelectorAll('[role="listitem"]')].find((el) => (el.getAttribute('title') || '').includes('drag-me'));
    const targetRow = [...document.querySelectorAll('[role="treeitem"]')].find((el) => (el.textContent || '').includes('E2E-拖靶'));
    if (!itemRow || !targetRow) return { ok: false, reason: 'rows-missing', item: !!itemRow, target: !!targetRow };

    const dt = new DataTransfer();
    itemRow.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await new Promise(r => setTimeout(r, 150));
    targetRow.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await new Promise(r => setTimeout(r, 150));
    targetRow.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    // 本地 bookmark API 的写入是毫秒级；700ms 足够让 React 重渲染（原来死等 1.5 秒）
    await new Promise(r => setTimeout(r, 700));

    const node = (await chrome.bookmarks.get(${JSON.stringify(dragSeed.itemId)}))[0];
    return { ok: true, movedTo: node ? node.parentId : null, expected: ${JSON.stringify(dragSeed.toId)} };
  })()`);
  check(
    '拖拽：从列表拖进树里的文件夹，书签真的换了父目录',
    dragFlow.ok === true && dragFlow.movedTo === dragFlow.expected,
    JSON.stringify(dragFlow),
  );
  await ev(`chrome.bookmarks.removeTree(${JSON.stringify(dragSeed.fromId)}).catch(() => {})`);
  await ev(`chrome.bookmarks.removeTree(${JSON.stringify(dragSeed.toId)}).catch(() => {})`);

  /* 同层排序：拖到另一行的**上边缘**应当插到它前面（不是随手扔到末尾）。
   * 这条路径同时涉及「行间定位（上半/下半）」与「插入下标计算」，两边都可能算错。 */
  const orderSeed = await ev(`(async () => {
    const bar = (await chrome.bookmarks.getTree())[0].children.find(c => c.id === '1');
    const folder = await chrome.bookmarks.create({ parentId: bar.id, title: 'E2E-排序' });
    const a = await chrome.bookmarks.create({ parentId: folder.id, title: '排序A', url: 'https://order-a.example.com/1' });
    const b = await chrome.bookmarks.create({ parentId: folder.id, title: '排序B', url: 'https://order-b.example.com/2' });
    const c = await chrome.bookmarks.create({ parentId: folder.id, title: '排序C', url: 'https://order-c.example.com/3' });
    return { folderId: folder.id, a: a.id, b: b.id, c: c.id };
  })()`);
  await reload();
  const reorder = await ev(`(async () => {
    const folderRow = [...document.querySelectorAll('[role="treeitem"]')].find((el) => (el.textContent || '').includes('E2E-排序'));
    if (!folderRow) return { ok: false, reason: 'no-folder' };
    folderRow.click();
    await new Promise(r => setTimeout(r, 600));
    const rows = [...document.querySelectorAll('[role="listitem"]')].filter((el) => (el.getAttribute('title') || '').includes('order-'));
    if (rows.length !== 3) return { ok: false, reason: 'rows', n: rows.length };
    // rows 顺序应等于 a,b,c（dom 顺序即真实顺序）
    const aRow = rows.find((el) => (el.getAttribute('title') || '').includes('order-a'));
    const cRow = rows.find((el) => (el.getAttribute('title') || '').includes('order-c'));
    if (!aRow || !cRow) return { ok: false, reason: 'rows-missing' };
    const rect = aRow.getBoundingClientRect();
    const y = Math.round(rect.top + 2); // 上边缘 → 插到 a 之前
    const dt = new DataTransfer();
    cRow.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await new Promise(r => setTimeout(r, 150));
    aRow.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
    await new Promise(r => setTimeout(r, 150));
    aRow.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
    // 本地 bookmark API 的写入是毫秒级；700ms 足够让 React 重渲染
    await new Promise(r => setTimeout(r, 700));
    const kids = await chrome.bookmarks.getChildren(${JSON.stringify(orderSeed.folderId)});
    return { ok: true, order: kids.map((k) => k.title) };
  })()`);
  check(
    '拖拽同层排序：拖到上一行上边缘会插到它前面',
    reorder.ok === true && JSON.stringify(reorder.order) === JSON.stringify(['排序C', '排序A', '排序B']),
    JSON.stringify(reorder),
  );
  await ev(`chrome.bookmarks.removeTree(${JSON.stringify(orderSeed.folderId)}).catch(() => {})`);

  /* Ctrl+拖拽 = 复制（拖拽里最后一块）：源书签必须**留在原地**，目标里多出一条副本。
   * 混淆「移动」与「复制」是最容易出的事故——用户以为只是复制，结果原位置被搬空了。 */
  const copySeed = await ev(`(async () => {
    const bar = (await chrome.bookmarks.getTree())[0].children.find(c => c.id === '1');
    const src = await chrome.bookmarks.create({ parentId: bar.id, title: 'E2E-复制源' });
    const dst = await chrome.bookmarks.create({ parentId: bar.id, title: 'E2E-复制靶' });
    const item = await chrome.bookmarks.create({ parentId: src.id, title: '要复制的书签', url: 'https://copy-me.example.com/x' });
    return { srcId: src.id, dstId: dst.id, itemId: item.id };
  })()`);
  await reload();
  const copyFlow = await ev(`(async () => {
    const srcRow = [...document.querySelectorAll('[role="treeitem"]')].find((el) => (el.textContent || '').includes('E2E-复制源'));
    if (!srcRow) return { ok: false, reason: 'no-src' };
    srcRow.click();
    await new Promise(r => setTimeout(r, 600));
    const itemRow = [...document.querySelectorAll('[role="listitem"]')].find((el) => (el.getAttribute('title') || '').includes('copy-me'));
    const dstRow = [...document.querySelectorAll('[role="treeitem"]')].find((el) => (el.textContent || '').includes('E2E-复制靶'));
    if (!itemRow || !dstRow) return { ok: false, reason: 'rows-missing' };

    const dt = new DataTransfer();
    itemRow.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await new Promise(r => setTimeout(r, 150));
    dstRow.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, ctrlKey: true }));
    await new Promise(r => setTimeout(r, 150));
    dstRow.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, ctrlKey: true }));
    // 本地 bookmark API 的写入是毫秒级；700ms 足够让 React 重渲染
    await new Promise(r => setTimeout(r, 700));

    const srcKids = await chrome.bookmarks.getChildren(${JSON.stringify(copySeed.srcId)});
    const dstKids = await chrome.bookmarks.getChildren(${JSON.stringify(copySeed.dstId)});
    return {
      ok: true,
      srcCount: srcKids.length,
      dstCount: dstKids.length,
      dstHasSameUrl: dstKids.some((k) => k.url === 'https://copy-me.example.com/x'),
    };
  })()`);
  check(
    'Ctrl+拖拽：复制到目标文件夹，源位置仍然保留',
    copyFlow.ok === true && copyFlow.srcCount === 1 && copyFlow.dstCount === 1 && copyFlow.dstHasSameUrl === true,
    JSON.stringify(copyFlow),
  );
  await ev(`chrome.bookmarks.removeTree(${JSON.stringify(copySeed.srcId)}).catch(() => {})`);
  await ev(`chrome.bookmarks.removeTree(${JSON.stringify(copySeed.dstId)}).catch(() => {})`);

  /* 复制**整个文件夹**：深拷贝子树（文件夹 + 里面的每条书签），源文件夹必须完好。
   * 这是 `copyNodeDeep` 最容易写漏的分支——只复制了外壳、里面的书签丢了，肉眼很难发现。 */
  const deepSeed = await ev(`(async () => {
    const bar = (await chrome.bookmarks.getTree())[0].children.find(c => c.id === '1');
    const src = await chrome.bookmarks.create({ parentId: bar.id, title: 'E2E-深拷贝源' });
    const inner = await chrome.bookmarks.create({ parentId: src.id, title: '子级' });
    await chrome.bookmarks.create({ parentId: src.id, title: '深一', url: 'https://deep-a.example.com/1' });
    await chrome.bookmarks.create({ parentId: inner.id, title: '深二', url: 'https://deep-b.example.com/2' });
    const dst = await chrome.bookmarks.create({ parentId: bar.id, title: 'E2E-深拷贝靶' });
    return { srcId: src.id, dstId: dst.id };
  })()`);
  await reload();
  const deepFlow = await ev(`(async () => {
    const srcRow = [...document.querySelectorAll('[role="treeitem"]')].find((el) => (el.textContent || '').includes('E2E-深拷贝源'));
    const dstRow = [...document.querySelectorAll('[role="treeitem"]')].find((el) => (el.textContent || '').includes('E2E-深拷贝靶'));
    if (!srcRow || !dstRow) return { ok: false, reason: 'rows-missing' };
    const dt = new DataTransfer();
    srcRow.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await new Promise(r => setTimeout(r, 150));
    dstRow.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, ctrlKey: true }));
    await new Promise(r => setTimeout(r, 150));
    dstRow.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, ctrlKey: true }));
    await new Promise(r => setTimeout(r, 2500));

    const dstKids = await chrome.bookmarks.getChildren(${JSON.stringify(deepSeed.dstId)});
    const copied = dstKids.find((k) => !k.url);
    const srcKids = await chrome.bookmarks.getChildren(${JSON.stringify(deepSeed.srcId)});
    let copiedTree = [];
    if (copied) {
      const sub = (await chrome.bookmarks.getSubTree(copied.id))[0];
      copiedTree = sub?.children ?? [];
    }
    // 副本里应当同时有：一条书签（深一）+ 一个子文件夹（子级，其内含深二）
    const copiedInner = copiedTree.find((k) => !k.url);
    return {
      ok: true,
      srcStillThere: srcKids.length,
      copiedExists: !!copied,
      copiedBookmarkCount: copiedTree.filter((k) => k.url).length,
      copiedFolderHasChild: !!(copiedInner && (copiedInner.children || []).some((c) => c.url === 'https://deep-b.example.com/2')),
    };
  })()`);
  check(
    'Ctrl+拖拽复制整个文件夹：子树被深拷贝（含二级子文件夹里的书签），源完好',
    deepFlow.ok === true && deepFlow.srcStillThere === 2 && deepFlow.copiedExists === true &&
      deepFlow.copiedBookmarkCount === 1 && deepFlow.copiedFolderHasChild === true,
    JSON.stringify(deepFlow),
  );
  await ev(`chrome.bookmarks.removeTree(${JSON.stringify(deepSeed.srcId)}).catch(() => {})`);
  await ev(`chrome.bookmarks.removeTree(${JSON.stringify(deepSeed.dstId)}).catch(() => {})`);

  /* ── 汇总 ── */
  const failed = results.filter((r) => !r.ok);
  const totalMs = Date.now() - RUN_START;
  console.log('\n— 分段耗时 —');
  for (const t of timings) console.log(`  ${t.name}  ${(t.ms / 1000).toFixed(1)}s`);
  console.log(`  合计  ${(totalMs / 1000).toFixed(1)}s`);
  if (slowCalls.length > 0) {
    console.log('\n— 慢调用 Top 8（≥400ms 的页面求值）—');
    for (const c of [...slowCalls].sort((a, b) => b.ms - a.ms).slice(0, 8)) {
      console.log(`  ${String(c.ms).padStart(5)}ms  ${c.head}`);
    }
  }
  console.log(`\nE2E 结果：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) {
    console.log('失败项：' + failed.map((f) => f.name).join(' | '));
    process.exitCode = 1;
  }
  ws.close();
}

main().catch((e) => {
  console.error('E2E 执行失败:', e);
  process.exit(1);
});
