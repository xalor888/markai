#!/usr/bin/env node
/**
 * 把 MarkAI 的 Skill 装进外部 Agent 的 skills 目录。
 *
 * 为什么不直接写死 `~/.codex/skills`：不同 Agent 的目录不同，而且用户可能用
 * `CODEX_HOME` 之类的变量改过位置。这里按优先级探测，找到就装，找不到就打印
 * 目标路径让用户自己复制——不猜、不静默失败。
 *
 * 用法：
 *   node tools/install-skill.mjs                 # 自动探测并安装
 *   node tools/install-skill.mjs --to <dir>      # 装到指定目录（<dir>/markai-bookmarks）
 *   node tools/install-skill.mjs --print         # 只打印目标路径，不写
 */
import { cp, mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, '..', 'skills', 'markai-bookmarks');
const argv = process.argv.slice(2);

function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 候选目录按"越具体越优先"排列。
 * Codex 用 `CODEX_HOME/skills`；Claude Code 用 `~/.claude/skills`；
 * 其余通用位置放最后，装错地方比不装更糟，所以只挑**已存在**的父目录。
 */
async function candidates() {
  const home = homedir();
  const list = [];
  if (process.env.CODEX_HOME) list.push(join(process.env.CODEX_HOME, 'skills'));
  list.push(join(home, '.codex', 'skills'));
  list.push(join(home, '.claude', 'skills'));
  list.push(join(home, '.agents', 'skills'));
  const found = [];
  for (const dir of list) {
    if (await exists(dir)) found.push(dir);
  }
  return found;
}

const target = flag('--to');
const printOnly = argv.includes('--print');

if (!(await exists(SOURCE))) {
  console.error(`找不到 Skill 源目录：${SOURCE}`);
  process.exit(1);
}

if (target) {
  const dest = join(target, 'markai-bookmarks');
  console.log(`目标：${dest}`);
  if (!printOnly) {
    await mkdir(target, { recursive: true });
    await cp(SOURCE, dest, { recursive: true });
    console.log('已安装。外部 Agent 下次启动即可发现 markai-bookmarks。');
  }
  process.exit(0);
}

const found = await candidates();
if (found.length === 0) {
  console.error('没有找到任何 Agent 的 skills 目录。请指定目标：');
  console.error(`  node tools/install-skill.mjs --to <你的 skills 目录>`);
  console.error(`源目录在：${SOURCE}`);
  process.exit(1);
}

for (const dir of found) {
  const dest = join(dir, 'markai-bookmarks');
  if (printOnly) {
    console.log(dest);
    continue;
  }
  await cp(SOURCE, dest, { recursive: true });
  console.log(`已安装：${dest}`);
}

if (!printOnly) {
  console.log('\n记得让外部 Agent 能拿到 token：export MARKAI_TOKEN=<设置页里的 token>');
}
