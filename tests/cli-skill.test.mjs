/**
 * ── CLI / Skill / 外部删除闸门 的测试 ──
 *
 * 这三样都是"给外部 Agent 用的入口"，最容易出的问题不是崩溃，而是**说一套做一套**：
 *  · CLI 的参数形状与工具契约不一致 → 用户看到 400，却以为是扩展坏了；
 *  · Skill 文档指向不存在的命令/工具 → 外部 Agent 照着做，一路撞墙；
 *  · 外部调用在「无需确认」模式下真的删了书签 → 安全承诺失效（最严重）。
 *
 * 所以这里用真子进程跑 CLI，用真源码断言 Skill 的命令可解析，
 * 并把 `ctx.external` 对删除模式的覆盖钉死。
 *
 * 运行：node tests/cli-skill.test.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLI = join(ROOT, 'tools', 'markai.mjs');
const SKILL = join(ROOT, 'skills', 'markai-bookmarks', 'SKILL.md');
const TOOLS_SRC = readFileSync(join(ROOT, 'src', 'lib', 'ai', 'tools.ts'), 'utf8');

let passed = 0;
async function ok(name, fn) {
  await fn();
  passed++;
  console.log(`  ✔ ${name}`);
}

function run(args, env = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, MARKAI_TOKEN: '', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('exit', (code) => done({ code, stdout, stderr }));
  });
}

console.log('\n[C1] CLI 用法与退出码');

await ok('无参数打印用法，退出码 0', async () => {
  const r = await run([]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /MarkAI CLI/);
  assert.match(r.stdout, /markai search/);
});

await ok('没有 token 时以 2 退出，并指出怎么补', async () => {
  const r = await run(['stats']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /MARKAI_TOKEN/);
});

await ok('未知命令以 2 退出', async () => {
  const r = await run(['nonsense', '--token', 'x'.repeat(40)]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /未知命令/);
});

await ok('桥不可达时以 1 退出，并给出启动命令', async () => {
  const r = await run(['stats', '--token', 'x'.repeat(40), '--port', '9'], { MARKAI_PORT: '9' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /markai-bridge\.mjs/);
});

console.log('\n[C2] CLI 与工具契约一致');

await ok('propose-delete 把 ids 摊成 items（工具真实 schema）', async () => {
  const src = readFileSync(CLI, 'utf8');
  assert.match(src, /items: ids\.map\(\(bookmarkId\) => \(\{ bookmarkId, reason \}\)\)/);
  // 反向守卫：CLI 不能把 { ids } 直接发给 propose_deletions
  assert.doesNotMatch(src, /call\('propose_deletions', \{ ids/);
});

await ok('CLI 的每个子命令都对应真实存在的工具', async () => {
  const src = readFileSync(CLI, 'utf8');
  const called = [...src.matchAll(/call\('([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(called.length > 0);
  for (const tool of new Set(called)) {
    assert.match(
      TOOLS_SRC,
      new RegExp(`\\b${tool}: \\{ name: '${tool}'`),
      `CLI 调用了不存在的工具：${tool}`,
    );
  }
});

console.log('\n[C3] Skill 文档不撒谎');

await ok('SKILL.md 存在且带 frontmatter', async () => {
  const text = readFileSync(SKILL, 'utf8');
  assert.match(text, /^---\nname: markai-bookmarks\n/);
  assert.match(text, /\ndescription: .+\n---\n/);
});

await ok('Skill 里每条 markai 子命令都在 CLI 里实现', async () => {
  const skill = readFileSync(SKILL, 'utf8');
  const cli = readFileSync(CLI, 'utf8');
  const used = new Set([...skill.matchAll(/node tools\/markai\.mjs ([a-z-]+)/g)].map((m) => m[1]));
  assert.ok(used.size >= 5, 'Skill 至少要演示 5 个子命令');
  for (const cmd of used) {
    assert.match(cli, new RegExp(`case '${cmd}':`), `Skill 提到的子命令 CLI 没有实现：${cmd}`);
  }
});

await ok('Skill 明确要求"删除只提议"，且不承诺直接删除', async () => {
  const skill = readFileSync(SKILL, 'utf8');
  assert.match(skill, /只提议，不执行/);
  assert.doesNotMatch(skill, /markai delete/);
  assert.doesNotMatch(skill, /直接删除书签/);
});

console.log('\n[C4] 外部调用不能绕过删除确认');

await ok('ToolContext 有 external 标记', async () => {
  assert.match(TOOLS_SRC, /external\?: boolean;/);
});

await ok('proposeDeletions 在 external 下强制 confirm', async () => {
  const body = TOOLS_SRC.slice(
    TOOLS_SRC.indexOf('async function proposeDeletions'),
    TOOLS_SRC.indexOf('const deleteAllSchema'),
  );
  assert.match(body, /ctx\?\.external \? 'confirm' : await getDeleteMode\(\)/);
});

await ok('对外运行时确实传了 external: true', async () => {
  const runtime = readFileSync(join(ROOT, 'src', 'lib', 'external', 'runtime.ts'), 'utf8');
  assert.match(runtime, /\{ external: true \}/);
});

console.log(`\n✓ cli-skill：${passed} 项全部通过`);
