/**
 * ── 根线（宠物工作室 + 对外接口）的测试 ──
 *
 * 两条线各自最容易坏的地方不同，所以分开测：
 *  · 宠物：storage 里可能是旧版本数据/半截对象，造型必须被洗成合法值而不是白屏；
 *  · 对外接口：安全边界是"拒绝"而不是"报错"，任何一条闸门漏了都是真实风险。
 *
 * 运行：npx tsx tests/pet-external.test.ts
 */
import assert from 'node:assert/strict';
import {
  PET_ACCESSORIES,
  PET_ACCESSORY_LABELS,
  PET_ACCESSORY_PATHS,
  PET_ACCESSORY_STYLE,
  PET_BODY_PATHS,
  PET_CATCHPHRASE_MAX,
  PET_DEFAULT_DESIGN,
  PET_NAME_MAX,
  PET_PALETTES,
  PET_SPECIES,
  cleanPetText,
  isDefaultDesign,
  normalizePetDesign,
  paletteById,
} from '../src/lib/pet/design';
import {
  MAX_ARGS_BYTES,
  MIN_TOKEN_LENGTH,
  authorize,
  byteLength,
  generateToken,
  isExternalTool,
  isReadTool,
  normalizeRequest,
  safeEqual,
  toolManifest,
} from '../src/lib/external/protocol';
import { EXTERNAL_API_DEFAULT, type ExternalApiConfig } from '../src/lib/features/external';
import { enqueueExternalDeletions } from '../src/lib/external/runtime';
import type { DeletionProposal } from '../src/lib/ai/types';

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

/* ── 最小 storage 替身：只实现被用到的 get/set ── */
const storage: Record<string, unknown> = {};
(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: {
      get: async (key: string) => (key in storage ? { [key]: storage[key] } : {}),
      set: async (obj: Record<string, unknown>) => {
        Object.assign(storage, obj);
      },
      remove: async (key: string) => {
        delete storage[key];
      },
    },
  },
};

const CONFIG: ExternalApiConfig = {
  enabled: true,
  port: 8787,
  token: 'a'.repeat(MIN_TOKEN_LENGTH),
  allowWrites: false,
};

const req = (tool: string, args: Record<string, unknown> = {}) => ({ id: 'r1', tool, args });

async function main() {
  console.log('\n[P1] 宠物造型：输入净化');
  {
    ok('空对象 → 默认造型', () => {
      assert.deepEqual(normalizePetDesign({}), PET_DEFAULT_DESIGN);
      assert.deepEqual(normalizePetDesign(null), PET_DEFAULT_DESIGN);
      assert.deepEqual(normalizePetDesign('nope'), PET_DEFAULT_DESIGN);
    });

    ok('非法枚举回落默认，合法值保留', () => {
      const a = normalizePetDesign({ species: 'dragon', accessory: 'jetpack', palette: 'neon' });
      assert.equal(a.species, PET_DEFAULT_DESIGN.species);
      assert.equal(a.accessory, PET_DEFAULT_DESIGN.accessory);
      assert.equal(a.palette, PET_DEFAULT_DESIGN.palette);
      const b = normalizePetDesign({ species: 'ghost', accessory: 'crown', palette: 'plum' });
      assert.equal(b.species, 'ghost');
      assert.equal(b.accessory, 'crown');
      assert.equal(b.palette, 'plum');
    });

    ok('名字为空/全空白 → 回落默认名（不能出现无名宠物）', () => {
      assert.equal(normalizePetDesign({ name: '   ' }).name, PET_DEFAULT_DESIGN.name);
      assert.equal(normalizePetDesign({ name: 42 }).name, PET_DEFAULT_DESIGN.name);
      assert.equal(normalizePetDesign({ name: '小墨' }).name, '小墨');
    });

    ok('名字与口头禅截断到上限', () => {
      const long = '很'.repeat(50);
      const d = normalizePetDesign({ name: long, catchphrase: long });
      assert.equal(d.name.length, PET_NAME_MAX);
      assert.equal(d.catchphrase.length, PET_CATCHPHRASE_MAX);
    });

    ok('口头禅允许留空（空 = 用内置台词）', () => {
      assert.equal(normalizePetDesign({ catchphrase: '' }).catchphrase, '');
    });

    ok('控制符被压成空格，不把两句话粘在一起', () => {
      assert.equal(cleanPetText('a\nb\tc', 20), 'a b c');
      assert.equal(cleanPetText('  前后  ', 20), '前后');
    });

    ok('isDefaultDesign 只在全部字段都是默认时为真', () => {
      assert.equal(isDefaultDesign(PET_DEFAULT_DESIGN), true);
      assert.equal(isDefaultDesign({ ...PET_DEFAULT_DESIGN, accessory: 'glasses' }), false);
    });
  }

  console.log('\n[P2] 宠物造型：几何与配色完整性');
  {
    ok('每个轮廓都有路径，且都是闭合的', () => {
      for (const species of PET_SPECIES) {
        const d = PET_BODY_PATHS[species];
        assert.ok(d.length > 40, `${species} 路径过短`);
        assert.match(d, /^M /, `${species} 必须以 M 开头`);
        assert.match(d, /Z$/, `${species} 必须闭合`);
      }
    });

    ok('每个配件都有路径与样式', () => {
      for (const accessory of PET_ACCESSORIES) {
        if (accessory === 'none') continue;
        assert.ok(PET_ACCESSORY_PATHS[accessory].length > 0, `${accessory} 缺少路径`);
        assert.ok(['stroke', 'fill'].includes(PET_ACCESSORY_STYLE[accessory]));
        assert.ok(PET_ACCESSORY_LABELS[accessory].length > 0);
      }
    });

    ok('配色 id 唯一，且每块都有两端颜色', () => {
      const ids = new Set<string>();
      for (const p of PET_PALETTES) {
        assert.equal(ids.has(p.id), false, `配色 id 重复：${p.id}`);
        ids.add(p.id);
        assert.match(p.top, /^#[0-9a-f]{6}$/i);
        assert.match(p.bottom, /^#[0-9a-f]{6}$/i);
      }
    });

    ok('未知配色 id 回落到第一块而不是 undefined', () => {
      assert.equal(paletteById('nope').id, PET_PALETTES[0]!.id);
    });
  }

  console.log('\n[E1] 对外接口：token 与鉴权');
  {
    ok('safeEqual：相等为真，长度/内容不同为假', () => {
      assert.equal(safeEqual('abcdef', 'abcdef'), true);
      assert.equal(safeEqual('abcdef', 'abcdeg'), false);
      assert.equal(safeEqual('abc', 'abcd'), false);
      assert.equal(safeEqual('', ''), true);
    });

    ok('generateToken 足够长且每次不同', () => {
      const a = generateToken();
      const b = generateToken();
      assert.equal(a.length, 48);
      assert.match(a, /^[0-9a-f]+$/);
      assert.notEqual(a, b);
    });

    ok('未启用时一律拒绝，且不透露工具是否存在', () => {
      const v = authorize({ ...CONFIG, enabled: false }, CONFIG.token, req('list_bookmarks'));
      assert.equal(v.ok, false);
      assert.equal(v.code, 'forbidden');
    });

    ok('token 缺失/过短/错误都被拒绝', () => {
      assert.equal(authorize(CONFIG, null, req('stats')).code, 'unauthorized');
      assert.equal(authorize(CONFIG, 'x', req('stats')).code, 'unauthorized');
      assert.equal(authorize({ ...CONFIG, token: 'short' }, 'short', req('stats')).code, 'forbidden');
    });

    ok('正确 token + 只读工具通过', () => {
      assert.equal(authorize(CONFIG, CONFIG.token, req('list_bookmarks')).ok, true);
    });

    ok('未知工具被拒绝', () => {
      assert.equal(authorize(CONFIG, CONFIG.token, req('rm_rf')).code, 'bad_request');
    });

    ok('未允许写操作时，写工具被拒绝', () => {
      for (const tool of ['create_folder', 'move_bookmark', 'rename_bookmark', 'propose_deletions']) {
        const v = authorize(CONFIG, CONFIG.token, req(tool));
        assert.equal(v.ok, false, `${tool} 不该通过`);
        assert.equal(v.code, 'forbidden');
      }
    });

    ok('允许写操作后，写工具通过；删除提议也只是"工具"', () => {
      const writable = { ...CONFIG, allowWrites: true };
      assert.equal(authorize(writable, CONFIG.token, req('create_folder')).ok, true);
      assert.equal(authorize(writable, CONFIG.token, req('propose_deletions')).ok, true);
    });

    ok('args 不是对象/过大都被拒绝', () => {
      const bad = { id: 'x', tool: 'stats', args: [] as unknown as Record<string, unknown> };
      assert.equal(authorize(CONFIG, CONFIG.token, bad).code, 'bad_request');
      const huge = { id: 'x', tool: 'stats', args: { blob: 'x'.repeat(MAX_ARGS_BYTES) } };
      assert.equal(authorize(CONFIG, CONFIG.token, huge).code, 'bad_request');
    });

    ok('读工具集合与工具清单一致', () => {
      const manifest = toolManifest();
      assert.equal(manifest.length, 11);
      for (const t of manifest) assert.equal(t.readOnly, isReadTool(t.name));
      assert.equal(isExternalTool('stats'), true);
      assert.equal(isExternalTool('drop_database'), false);
    });
  }

  console.log('\n[E2] 对外接口：请求外壳与字节估算');
  {
    ok('缺少 id/tool 的请求被拒绝', () => {
      assert.equal(normalizeRequest({ tool: 'stats' }), null);
      assert.equal(normalizeRequest({ id: 'x' }), null);
      assert.equal(normalizeRequest(null), null);
    });

    ok('合法请求被规范化，缺省 args 变成空对象', () => {
      const r = normalizeRequest({ id: ' a ', tool: ' stats ', client: 'codex' });
      assert.deepEqual(r, { id: 'a', tool: 'stats', args: {}, client: 'codex' });
    });

    ok('args 是数组时退化成空对象（不把数组当对象传下去）', () => {
      const r = normalizeRequest({ id: 'a', tool: 'stats', args: [1, 2] });
      assert.deepEqual(r?.args, {});
    });

    ok('byteLength：ASCII / 中文 / 代理对各按正确字节数计', () => {
      assert.equal(byteLength('abc'), 3);
      assert.equal(byteLength('中'), 3);
      assert.equal(byteLength('😀'), 4);
    });
  }

  console.log('\n[E3] 外部删除提议：合并进待确认队列');
  {
    const mk = (bookmarkId: string, status: DeletionProposal['status'] = 'pending'): DeletionProposal => ({
      id: `p-${bookmarkId}`,
      bookmarkId,
      title: `t-${bookmarkId}`,
      reason: '外部提议',
      status,
      createdAt: 1,
    });

    await okA('首次提议写入，返回新增条数', async () => {
      storage['markai.ai'] = { conversations: [], activeId: null, pendingDeletions: [] };
      const n = await enqueueExternalDeletions([mk('1'), mk('2')]);
      assert.equal(n, 2);
      const saved = storage['markai.ai'] as { pendingDeletions: DeletionProposal[] };
      assert.equal(saved.pendingDeletions.length, 2);
    });

    await okA('重复提议不重复入列', async () => {
      const n = await enqueueExternalDeletions([mk('1')]);
      assert.equal(n, 0);
      const saved = storage['markai.ai'] as { pendingDeletions: DeletionProposal[] };
      assert.equal(saved.pendingDeletions.length, 2);
    });

    await okA('已执行/已放弃的项不被外部提议复活', async () => {
      storage['markai.ai'] = {
        conversations: [],
        activeId: null,
        pendingDeletions: [mk('9', 'executed')],
      };
      const n = await enqueueExternalDeletions([mk('9')]);
      assert.equal(n, 0);
      const saved = storage['markai.ai'] as { pendingDeletions: DeletionProposal[] };
      assert.equal(saved.pendingDeletions[0]?.status, 'executed');
    });

    await okA('空数组不写 storage', async () => {
      const before = JSON.stringify(storage['markai.ai']);
      assert.equal(await enqueueExternalDeletions([]), 0);
      assert.equal(JSON.stringify(storage['markai.ai']), before);
    });
  }

  console.log(`\n✓ pet-external：${passed} 项全部通过`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
