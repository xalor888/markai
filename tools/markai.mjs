#!/usr/bin/env node
/**
 * MarkAI 命令行：给"人"和"外部 Agent 的 shell"用的薄封装。
 *
 * 它自己不碰书签，也不持有端口——只把一条命令翻译成对桥的一次 `/v1/call`。
 * 这样 CLI 与 MCP 走的是同一条队列、同一套 token 与审计，不存在第二条后门。
 *
 * 用法：
 *   MARKAI_TOKEN=... node tools/markai.mjs search "react 文档"
 *   node tools/markai.mjs --token <TOKEN> folders
 *   node tools/markai.mjs propose-delete <id> <id> --reason "重复"
 *
 * 退出码：0 成功；1 调用失败；2 用法/token 错误。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));

const argv = process.argv.slice(2);

function takeFlag(name, fallback = undefined) {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value ?? fallback;
}

const TOKEN = takeFlag('--token') || process.env.MARKAI_TOKEN || '';
const PORT = Number(takeFlag('--port') || process.env.MARKAI_PORT || 8787);
const BASE = `http://127.0.0.1:${PORT}`;
const asJson = argv.includes('--json');
const rest = argv.filter((a) => a !== '--json');
const command = rest[0] || 'help';

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function help() {
  console.log(`MarkAI CLI v${PKG.version}

环境变量：MARKAI_TOKEN（或在设置页复制启动命令里的 token）、MARKAI_PORT

  markai search <关键词>            搜索书签
  markai list [--folder <id>] [--limit N]
  markai folders                    列出全部文件夹
  markai path <id>                  解析完整路径
  markai stats                      库统计
  markai tools                      列出可用工具
  markai call <tool> [json]         直接调用任意工具（高级）
  markai propose-delete <id...> --reason <文本>
  markai skill                      打印 Skill 安装位置与内容

通用：--json 输出原始 JSON；--token <TOKEN> 临时覆盖；--port <N> 指定桥端口。
`);
}

async function call(tool, args = {}) {
  if (!TOKEN) fail('缺少 token：设置 MARKAI_TOKEN，或加 --token <TOKEN>。', 2);
  let res;
  try {
    res = await fetch(`${BASE}/v1/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ tool, args }),
    });
  } catch (e) {
    fail(
      `连不上桥（${BASE}）：${e.message}\n先运行 node tools/markai-bridge.mjs --token <TOKEN>，并确认 MarkAI 已打开、对外接口已启用。`,
    );
  }
  let body;
  try {
    body = await res.json();
  } catch {
    fail(`桥返回了非 JSON（HTTP ${res.status}）`);
  }
  if (!res.ok || !body.ok) fail(body.error || `调用失败（HTTP ${res.status}）`);
  return body;
}

/** 工具结果是 JSON 文本；解析失败就原样打印，别把内容吞掉 */
function print(result) {
  if (asJson) {
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    return;
  }
  if (typeof result !== 'string') {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  try {
    console.log(JSON.stringify(JSON.parse(result), null, 2));
  } catch {
    console.log(result);
  }
}

function numberArg(name, fallback) {
  const i = rest.indexOf(name);
  if (i < 0) return fallback;
  const n = Number(rest[i + 1]);
  rest.splice(i, 2);
  return Number.isFinite(n) ? n : fallback;
}

switch (command) {
  case 'help':
  case '--help':
  case '-h':
    help();
    break;
  case 'tools': {
    if (!TOKEN) fail('缺少 token：设置 MARKAI_TOKEN，或加 --token <TOKEN>。', 2);
    const res = await fetch(`${BASE}/v1/tools`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const body = await res.json();
    if (!res.ok || !body.ok) fail(body.error || `调用失败（HTTP ${res.status}）`);
    for (const t of body.tools) console.log(`${t.readOnly ? '读' : '写'}  ${t.name.padEnd(18)} ${t.description}`);
    break;
  }
  case 'search': {
    const query = rest.slice(1).join(' ').trim();
    if (!query) fail('用法：markai search <关键词>', 2);
    print((await call('search_bookmarks', { query })).result);
    break;
  }
  case 'list': {
    const folderId = takeFlag('--folder');
    const limit = numberArg('--limit', 50);
    print((await call('list_bookmarks', { ...(folderId ? { folderId } : {}), limit })).result);
    break;
  }
  case 'folders':
    print((await call('list_all_folders')).result);
    break;
  case 'path': {
    const id = rest[1];
    if (!id) fail('用法：markai path <id>', 2);
    print((await call('get_folder_path', { id })).result);
    break;
  }
  case 'stats':
    print((await call('stats')).result);
    break;
  case 'call': {
    const tool = rest[1];
    if (!tool) fail('用法：markai call <tool> [json]', 2);
    let args = {};
    const raw = rest.slice(2).join(' ').trim();
    if (raw) {
      try {
        args = JSON.parse(raw);
      } catch {
        fail('参数不是合法 JSON', 2);
      }
    }
    print((await call(tool, args)).result);
    break;
  }
  case 'propose-delete': {
    const reason = takeFlag('--reason') || '外部 Agent 建议清理';
    const ids = rest.slice(1).filter((a) => !a.startsWith('--'));
    if (ids.length === 0) fail('用法：markai propose-delete <id...> --reason <文本>', 2);
    // 工具的真实参数是 { items: [{ bookmarkId, reason }] }，不是 { ids }。
    // 这里替用户把 ids 摊成 items，避免 CLI 和工具契约各说一套。
    print((await call('propose_deletions', { items: ids.map((bookmarkId) => ({ bookmarkId, reason })) })).result);
    break;
  }
  case 'skill': {
    const path = join(HERE, '..', 'skills', 'markai-bookmarks', 'SKILL.md');
    console.log(`Skill 文件：${path}`);
    console.log('安装到 Codex：node tools/install-skill.mjs');
    console.log('安装后，外部 Agent 会用同一套 token 通过本 CLI 操作书签（删除仍需你在扩展里确认）。');
    break;
  }
  default:
    fail(`未知命令：${command}\n\n${''}运行 markai help 查看用法。`, 2);
}
