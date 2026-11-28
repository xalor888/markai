/**
 * ── 玻璃 / 动效 / 外观 / 检查更新 的契约测试 ──
 *
 * 运行：npx tsx tests/glass.test.ts
 *
 * 覆盖四组：
 *  1. 版本比较（semver 核心规则 + 非法输入）；
 *  2. 检查更新状态机（200 新版本 / 200 同版本 / 403 / 网络错误 / 解析失败 / 缓存命中）；
 *  3. 外观 normalize + applyAppearance 写出的 data 与 CSS 变量；
 *  4. CSS 守卫（扩展页禁用 backdrop url、玻璃 v2 三层、动效可被 data-motion 关停）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions, isNewerVersion, parseVersion } from '../src/lib/update/version';
import {
  checkForUpdate,
  classifyHttpError,
  parseRelease,
  readCachedUpdate,
  summarizeNotes,
  UPDATE_CACHE_TTL_MS,
  type UpdateCachePort,
} from '../src/lib/update/check';
import {
  APPEARANCE_DEFAULT,
  applyAppearance,
  normalizeAppearance,
} from '../src/stores/appearanceStore';
import { dataUrlByteLength, fitWithin } from '../src/lib/ui/image-upload';
import { AA_NORMAL, composite, contrastRatio, parseCssColor, parseHex } from '../src/lib/ui/contrast';

let passed = 0;

function ok(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✔ ${name}`);
  } catch (e) {
    console.error(`  ✘ ${name}`);
    throw e;
  }
}

async function okA(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ✔ ${name}`);
  } catch (e) {
    console.error(`  ✘ ${name}`);
    throw e;
  }
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => resolve(root, 'src', rel);
const read = (rel: string): string => readFileSync(src(rel), 'utf8');

function release(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: 'v0.2.175',
    name: 'v0.2.175',
    html_url: 'https://github.com/xalor888/markai/releases/tag/v0.2.175',
    published_at: '2026-11-29T00:00:00Z',
    body: '## 更新\n- 液态玻璃 v2',
    prerelease: false,
    ...overrides,
  };
}

function jsonResponse(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

interface MemoryCache extends UpdateCachePort {
  value: unknown;
}

function memoryCache(initial: unknown = null): MemoryCache {
  return {
    value: initial,
    async read() {
      return this.value;
    },
    async write(next) {
      this.value = next;
    },
  };
}

async function main() {
  console.log('\n[G1] 语义化版本比较');
  {
    ok('大于：补丁号高就是新版本', () => {
      assert.equal(compareVersions('0.2.175', '0.2.174'), 1);
      assert.equal(compareVersions('1.0.0', '0.9.9'), 1);
    });

    ok('小于：方向相反', () => {
      assert.equal(compareVersions('0.2.174', '0.2.175'), -1);
    });

    ok('相等：忽略前导 v 与构建元数据', () => {
      assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
      assert.equal(compareVersions('1.2.3+build.9', '1.2.3'), 0);
    });

    ok('预发布低于同版本正式版', () => {
      assert.equal(compareVersions('1.0.0-beta', '1.0.0'), -1);
      assert.equal(compareVersions('1.0.0', '1.0.0-beta'), 1);
    });

    ok('预发布逐段比较：数值段按大小、数字低于字母', () => {
      assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.1'), 1);
      assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
      assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1);
    });

    ok('非法输入返回 null，不误报更新', () => {
      assert.equal(compareVersions('1.2', '1.2.0'), null);
      assert.equal(compareVersions('', '1.0.0'), null);
      assert.equal(compareVersions('1.0.0.0', '1.0.0'), null);
      assert.equal(compareVersions('x.y.z', '1.0.0'), null);
      assert.equal(isNewerVersion('not-a-version', '1.0.0'), false);
      assert.equal(parseVersion('v2.3.4-rc.1+build.9')?.prerelease.join('.'), 'rc.1');
    });
  }

  console.log('\n[G2] 检查更新状态机');
  {
    await okA('200 + 更高的 tag → available（不是"已更新"文案）', async () => {
      const cache = memoryCache();
      const result = await checkForUpdate({
        current: '0.2.174',
        now: () => 1_000_000,
        cache,
        fetchImpl: async () => jsonResponse(release()),
      });
      assert.equal(result.status, 'available');
      if (result.status === 'available') {
        assert.equal(result.release.version, '0.2.175');
        assert.equal(result.cached, false);
        assert.equal(result.checkedAt, 1_000_000);
      }
    });

    await okA('200 + 同版本 → up-to-date', async () => {
      const result = await checkForUpdate({
        current: '0.2.175',
        cache: memoryCache(),
        fetchImpl: async () => jsonResponse(release()),
      });
      assert.equal(result.status, 'up-to-date');
    });

    await okA('403 → rate-limit（可重试但要等）', async () => {
      const result = await checkForUpdate({
        current: '0.2.174',
        cache: memoryCache(),
        fetchImpl: async () => jsonResponse({ message: 'rate limited' }, 403),
      });
      assert.equal(result.status, 'error');
      if (result.status === 'error') {
        assert.equal(result.error.kind, 'rate-limit');
        assert.equal(result.error.status, 403);
      }
    });

    await okA('网络异常 → network', async () => {
      const result = await checkForUpdate({
        current: '0.2.174',
        cache: memoryCache(),
        fetchImpl: async () => {
          throw new TypeError('Failed to fetch');
        },
      });
      assert.equal(result.status, 'error');
      if (result.status === 'error') assert.equal(result.error.kind, 'network');
    });

    await okA('返回不是合法 JSON → parse', async () => {
      const result = await checkForUpdate({
        current: '0.2.174',
        cache: memoryCache(),
        fetchImpl: async () => new Response('not json', { status: 200 }),
      });
      assert.equal(result.status, 'error');
      if (result.status === 'error') assert.equal(result.error.kind, 'parse');
    });

    await okA('500 → http', async () => {
      const result = await checkForUpdate({
        current: '0.2.174',
        cache: memoryCache(),
        fetchImpl: async () => jsonResponse({}, 500),
      });
      assert.equal(result.status, 'error');
      if (result.status === 'error') assert.equal(result.error.kind, 'http');
    });

    await okA('30 分钟内命中缓存：不再发请求', async () => {
      const cache = memoryCache();
      let calls = 0;
      const now = 2_000_000;
      await checkForUpdate({
        current: '0.2.174',
        now: () => now,
        cache,
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse(release());
        },
      });
      const second = await checkForUpdate({
        current: '0.2.174',
        now: () => now + 60_000,
        cache,
        fetchImpl: async () => {
          calls += 1;
          throw new Error('缓存命中时不该发请求');
        },
      });
      assert.equal(calls, 1);
      assert.equal(second.status, 'available');
      if (second.status === 'available') assert.equal(second.cached, true);
    });

    await okA('超过 TTL 后重新请求（force 同样绕过缓存）', async () => {
      const cache = memoryCache();
      let calls = 0;
      const now = 3_000_000;
      await checkForUpdate({
        current: '0.2.174',
        now: () => now,
        cache,
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse(release());
        },
      });
      await checkForUpdate({
        current: '0.2.174',
        now: () => now + UPDATE_CACHE_TTL_MS + 1,
        cache,
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse(release());
        },
      });
      await checkForUpdate({
        current: '0.2.174',
        now: () => now + 1_000,
        force: true,
        cache,
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse(release());
        },
      });
      assert.equal(calls, 3);
    });

    await okA('只读缓存：不触发网络，且能给出小圆点所需的状态', async () => {
      const cache = memoryCache();
      await checkForUpdate({
        current: '0.2.174',
        now: () => 4_000_000,
        cache,
        fetchImpl: async () => jsonResponse(release()),
      });
      const cached = await readCachedUpdate('0.2.174', cache, () => 4_060_000);
      assert.equal(cached?.status, 'available');
      // 超过 TTL 的缓存不再拿来点亮小圆点
      assert.equal(await readCachedUpdate('0.2.174', cache, () => 4_000_000 + UPDATE_CACHE_TTL_MS), null);
    });

    await okA('release 解析：缺 tag / 非法 tag → null；notes 截到 600 字', async () => {
      assert.equal(parseRelease({ tag_name: 'not-a-version' }), null);
      assert.equal(parseRelease({ body: 'x' }), null);
      const parsed = parseRelease(release({ body: 'a'.repeat(700) }));
      assert.equal(parsed?.notes.length, 601);
      assert.ok(parsed?.notes.endsWith('…'));
      assert.equal(summarizeNotes('a'.repeat(700)).length, 601);
    });

    ok('限流错误的类型与文案', () => {
      const err = classifyHttpError(403, new Headers({ 'x-ratelimit-reset': '1700000000' }));
      assert.equal(err.kind, 'rate-limit');
      assert.match(err.message, /限流/);
      assert.equal(classifyHttpError(404).kind, 'http');
    });
  }

  console.log('\n[G3] 外观：normalize 与 applyAppearance');
  {
    type RootStub = {
      dataset: Record<string, string>;
      style: {
        setProperty: (k: string, v: string) => void;
        removeProperty: (k: string) => void;
      };
    };
    const props = new Map<string, string>();
    const fakeRoot: RootStub = {
      dataset: {},
      style: {
        setProperty: (k, v) => props.set(k, v),
        removeProperty: (k) => props.delete(k),
      },
    };
    (globalThis as unknown as { document: unknown }).document = { documentElement: fakeRoot };

    ok('data 属性与 CSS 变量按 store 的值写出', () => {
      props.clear();
      applyAppearance({
        ...APPEARANCE_DEFAULT,
        accent: 'rose',
        background: 'mesh',
        motion: 'off',
        density: 'cozy',
        glass: 80,
        backgroundDim: 50,
      });
      assert.equal(fakeRoot.dataset.accent, 'rose');
      assert.equal(fakeRoot.dataset.background, 'mesh');
      assert.equal(fakeRoot.dataset.motion, 'off');
      assert.equal(fakeRoot.dataset.density, 'cozy');
      assert.equal(props.get('--mk-glass'), '0.8');
      assert.equal(props.get('--mk-bg-dim'), '0.5');
      assert.equal(props.has('--mk-bg-image'), false);
    });

    ok('图片背景写 --mk-bg-image，切回纯色时移除', () => {
      props.clear();
      applyAppearance({
        ...APPEARANCE_DEFAULT,
        background: 'image',
        backgroundImage: 'data:image/png;base64,iVBORw0KGgo=',
      });
      assert.match(props.get('--mk-bg-image') ?? '', /^url\("data:image\/png/);
      applyAppearance({ ...APPEARANCE_DEFAULT, background: 'none', backgroundImage: '' });
      assert.equal(props.has('--mk-bg-image'), false);
    });

    ok('非法输入被净化：越界数值、未知枚举、非图片地址', () => {
      assert.equal(normalizeAppearance({ glass: 999 }).glass, 100);
      assert.equal(normalizeAppearance({ glass: -5 }).glass, 0);
      assert.equal(normalizeAppearance({ accent: 'neon-pink' }).accent, APPEARANCE_DEFAULT.accent);
      assert.equal(normalizeAppearance({ motion: 'bouncy' }).motion, APPEARANCE_DEFAULT.motion);
      const badImage = normalizeAppearance({
        background: 'image',
        backgroundImage: 'javascript:alert(1)',
      });
      assert.equal(badImage.background, 'aurora');
      assert.equal(badImage.backgroundImage, '');
    });

    ok('图片压缩的纯函数：长边约束与字节数换算', () => {
      assert.deepEqual(fitWithin(4000, 2000, 1920), { width: 1920, height: 960 });
      assert.deepEqual(fitWithin(800, 600, 1920), { width: 800, height: 600 });
      assert.equal(dataUrlByteLength('data:image/png;base64,AAAA'), 3);
      assert.equal(dataUrlByteLength('data:image/png;base64,AAA='), 2);
    });

    delete (globalThis as unknown as { document?: unknown }).document;
  }

  console.log('\n[G4] CSS 守卫');
  {
    const css = read('assets/main.css');
    const appearance = read('assets/appearance.css');

    ok('不出现 backdrop-filter: url(（扩展页会静默丢背景）', () => {
      assert.doesNotMatch(css, /backdrop-filter:\s*url\(/);
    });

    ok('玻璃 v2 三层齐全：底色 + conic 厚边 + 指针反光 + 噪点', () => {
      assert.match(css, /\.mk-glass-2/);
      assert.match(css, /\.markai-glass-liquid::before,\s*\.mk-glass-2::before/);
      assert.match(css, /conic-gradient\(/, '厚边必须用 conic 四向色带');
      assert.match(css, /padding:\s*var\(--mk-edge-w/, '厚边宽度要可调（1.5–2px）');
      assert.match(css, /--mk-edge-light/);
      assert.match(css, /--mk-edge-cool/);
      assert.match(css, /--mk-edge-warm/);
      assert.match(css, /\.mk-glass-2::after/);
      assert.match(css, /--mk-mx/);
      assert.match(css, /--liquid-mx/, '旧指针变量必须保留兼容');
      assert.match(css, /var\(--liquid-noise\)/, '噪点层不能丢');
      assert.match(css, /blur\(4px\) blur\(var\(--liquid-blur\)\)/, '需要多层模糊（近场 + 远场）');
    });

    ok('深浅色各有一套 v2 token，暗色高光压到 30% 左右', () => {
      const light = css.slice(0, css.indexOf('.dark {'));
      const darkEnd = css.indexOf('@layer base');
      const dark = css.slice(css.indexOf('.dark {'), darkEnd);
      for (const block of [light, dark]) {
        assert.match(block, /--mk-edge-light:/);
        assert.match(block, /--mk-glass-tint:/);
      }
      assert.match(dark, /--mk-edge-light:\s*rgb\(255 255 255 \/ 0\.3\)/);
    });

    ok('玻璃 v2 最透（68%）时，正文与次要文字仍达 AA', () => {
      const token = (block: string, name: string): string => {
        const m = new RegExp(`${name}:\\s*([^;]+);`).exec(block);
        assert.ok(m?.[1], `没找到 token ${name}`);
        return m[1]!.trim();
      };
      const light = css.slice(0, css.indexOf('.dark {'));
      const dark = css.slice(css.indexOf('.dark {'), css.indexOf('@layer base'));
      for (const [label, block] of [['浅色', light], ['深色', dark]] as const) {
        const tint = parseCssColor(token(block, '--mk-glass-tint')).rgb;
        const fg = parseHex(token(block, '--color-foreground'));
        const muted = parseHex(token(block, '--color-muted-foreground'));
        for (const baseName of ['--color-background', '--color-card']) {
          const base = parseHex(token(block, baseName));
          const shown = composite(tint, 0.68, base);
          const fgRatio = contrastRatio(fg, shown);
          const mutedRatio = contrastRatio(muted, shown);
          assert.ok(fgRatio >= AA_NORMAL, `${label}玻璃上正文只有 ${fgRatio.toFixed(2)}:1（${baseName}）`);
          assert.ok(mutedRatio >= AA_NORMAL, `${label}玻璃上次要文字只有 ${mutedRatio.toFixed(2)}:1（${baseName}）`);
        }
      }
    });

    ok('动效 token 统一：120 / 180ms + 两条缓动', () => {
      assert.match(css, /--mk-dur-1:\s*120ms/);
      assert.match(css, /--mk-dur-2:\s*180ms/);
      assert.match(css, /--mk-ease:\s*cubic-bezier\(0\.2, 0\.8, 0\.2, 1\)/);
      assert.match(css, /--mk-ease-spring:\s*cubic-bezier\(0\.32, 0\.72, 0, 1\)/);
      assert.match(css, /@keyframes mk-panel-in/);
      assert.match(css, /@keyframes mk-panel-out/);
    });

    ok('所有新动画都能被 data-motion 关停（main.css 不放 !important）', () => {
      assert.match(appearance, /:root\[data-motion='off'\] \*/);
      assert.match(appearance, /animation:\s*none\s*!important/);
      assert.match(appearance, /transition:\s*none\s*!important/);
      assert.match(appearance, /:root\[data-motion='calm'\] \*/);
      assert.match(appearance, /transition-duration:\s*120ms\s*!important/);
      assert.doesNotMatch(css, /^\s*(animation|transition):[^;]*!important/m);
    });

    ok('玻璃预算：超过 3 层时退出 backdrop', () => {
      assert.match(css, /\[data-glass-budget='low'\] \.markai-glass-liquid/);
      assert.match(css, /\[data-glass-budget='low'\] \.mk-glass-2/);
      assert.match(css, /backdrop-filter:\s*none/);
      const lib = read('lib/ui/liquid-glass-global.ts');
      assert.match(lib, /dataset\.glassBudget = 'low'/);
      assert.match(lib, /GLASS_BUDGET = 3/);
    });

    ok('不支持 backdrop-filter 时退回实心底色（新旧类都在）', () => {
      const fallback = css.slice(css.indexOf('@supports not ((backdrop-filter'));
      assert.ok(fallback.length > 0, '缺少 @supports 降级块');
      assert.match(fallback, /background:\s*var\(--color-card\)/);
      assert.match(fallback, /\.markai-glass-liquid/);
      assert.match(fallback, /\.mk-glass-2/);
    });

    ok('四个接入点换成 v2 类，同时保留旧类名做别名', () => {
      for (const file of [
        'components/ui/dialog.tsx',
        'components/toast/toast.tsx',
        'components/workspace/more-menu.tsx',
        'components/command/command-palette.tsx',
      ]) {
        const txt = read(file);
        assert.match(txt, /mk-glass-2/, `${file} 没有挂 v2 玻璃类`);
        assert.match(txt, /markai-glass-liquid/, `${file} 旧类名必须保留（别名）`);
      }
    });

    ok('指针反光双写 --mk-mx 与 --liquid-mx，且不跑 rAF', () => {
      const lib = read('lib/ui/liquid-glass-global.ts');
      assert.match(lib, /--mk-mx/);
      assert.match(lib, /--mk-my/);
      assert.match(lib, /--liquid-mx/);
      assert.match(lib, /--liquid-my/);
      assert.match(lib, /pointermove/);
      assert.doesNotMatch(lib, /requestAnimationFrame/);
    });
  }

  console.log(`\n全部通过：${passed} 项 ✔`);
}

main().catch((e) => {
  console.error('\n❌ 测试失败:', e);
  process.exit(1);
});
