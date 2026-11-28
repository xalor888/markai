/**
 * ── 统一测试入口 ──
 *
 * 并行工作线各自新增 `tests/*.test.ts` / `*.test.mjs`，合并时不该再手工改
 * `package.json`，否则很容易出现"测试写了但没接进 CI"的假绿灯。
 * 这里按文件名排序发现全部测试，逐个用真子进程跑，任何一个失败即整体非零退出。
 *
 * 为什么用子进程而不是 import：
 *  · 桥测试会真的监听端口、起子进程，同进程内互相干扰；
 *  · 单个测试文件崩溃（段错误/未捕获异常）不应带走其它文件的结论。
 *
 * 运行：node scripts/run-tests.mjs [过滤子串]
 */
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = join(ROOT, 'tests');
const filter = process.argv[2] ?? '';

const files = (await readdir(TESTS))
  .filter((name) => /\.test\.(ts|mjs)$/.test(name))
  .filter((name) => name.includes(filter))
  .sort();

if (files.length === 0) {
  console.error(`没有匹配的测试文件（过滤：${filter || '无'}）`);
  process.exit(1);
}

function run(file) {
  return new Promise((done) => {
    const path = join(TESTS, file);
    const cmd = file.endsWith('.ts') ? 'tsx' : 'node';
    const started = Date.now();
    const child = spawn(cmd, [path], { cwd: ROOT, stdio: 'inherit' });
    child.on('exit', (code, signal) => {
      done({ file, code: code ?? (signal ? 1 : 0), ms: Date.now() - started });
    });
    child.on('error', (error) => {
      console.error(`${file}: 无法启动 ${cmd}：${error.message}`);
      done({ file, code: 1, ms: Date.now() - started });
    });
  });
}

const results = [];
for (const file of files) {
  console.log(`\n── ${file} ──`);
  const result = await run(file);
  results.push(result);
  if (result.code !== 0) break;
}

const failed = results.filter((r) => r.code !== 0);
const skipped = files.length - results.length;
console.log('\n── 汇总 ──');
for (const r of results) {
  console.log(`${r.code === 0 ? '✓' : '✗'} ${r.file} (${r.ms}ms)`);
}
if (skipped > 0) console.log(`… ${skipped} 个文件因前面的失败未运行`);

process.exit(failed.length > 0 ? 1 : 0);
