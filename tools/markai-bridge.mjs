#!/usr/bin/env node
/**
 * MarkAI 本机桥：MCP (stdio) + HTTP (回环) 两种入口，共用一条队列。
 *
 * 为什么需要它：MV3 扩展不能监听 TCP 端口。桥在这里听端口，扩展用长轮询领活，
 * 在自己的上下文里执行工具（书签权限只属于扩展）。
 *
 *   MCP 客户端 ──stdio JSON-RPC──▶ 本脚本 ──队列──▶ 扩展 ──书签 API──▶ Chrome
 *   CLI/curl  ──HTTP /v1/call────▶
 *
 * 用法：
 *   node tools/markai-bridge.mjs --token <扩展设置页里的 token> [--port 8787]
 *   node tools/markai-bridge.mjs --print-mcp-config      # 打印可粘贴的 MCP 配置
 *
 * 安全：
 *  · 只监听 127.0.0.1（不是 0.0.0.0）；
 *  · 每个请求都要 Bearer token（与扩展里的一致）；
 *  · 删除永远只是"提议"——真正的删除要用户在扩展里确认。
 */
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));

/** 与 src/lib/features/external.ts 保持一致的默认端口 */
const DEFAULT_PORT = 8787;
const HOLD_MS = 25_000;
/** 单个调用最长等多久（扩展侧工具上限 120s，这里留余量） */
const CALL_TIMEOUT_MS = 150_000;

const argv = process.argv.slice(2);
function flag(name, fallback = undefined) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
}

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`MarkAI 本机桥 v${PKG.version}

  node tools/markai-bridge.mjs --token <TOKEN> [--port ${DEFAULT_PORT}]
  node tools/markai-bridge.mjs --print-mcp-config --token <TOKEN>

  HTTP（回环，需要 Bearer token）
    POST /v1/call   {"id":"...","tool":"search_bookmarks","args":{"query":"react"}}
    GET  /v1/tools  工具清单
    GET  /health    健康检查（不需要 token）

  MCP（stdio JSON-RPC 2.0）
    {"jsonrpc":"2.0","id":1,"method":"tools/list"}
    {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"stats","arguments":{}}}
`);
  process.exit(0);
}

if (argv.includes('--print-mcp-config')) {
  const token = flag('--token', '<TOKEN>');
  const port = Number(flag('--port', String(DEFAULT_PORT)));
  console.log(
    JSON.stringify(
      {
        mcpServers: {
          markai: {
            command: process.execPath,
            args: [join(HERE, 'markai-bridge.mjs'), '--token', token, '--port', String(port)],
          },
        },
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const TOKEN = flag('--token') || process.env.MARKAI_TOKEN || '';
const PORT = Number(flag('--port', String(DEFAULT_PORT)));
if (!TOKEN || TOKEN.length < 24) {
  console.error('缺少 token（至少 24 字符）。请在 MarkAI 设置 → 对外接口 里生成，然后：');
  console.error('  node tools/markai-bridge.mjs --token <TOKEN>');
  process.exit(2);
}

/** 工具清单：与扩展共享同一份定义，但桥不需要知道实现细节 */
const TOOLS = [
  ['list_bookmarks', '列出书签/文件夹（可指定 folderId、limit）', true],
  ['search_bookmarks', '按标题/URL 搜索书签', true],
  ['get_folder_path', '解析文件夹或书签的完整路径', true],
  ['list_all_folders', '列出所有文件夹与每根的书签数', true],
  ['stats', '书签库统计', true],
  ['create_folder', '新建文件夹', false],
  ['create_bookmark', '新建书签', false],
  ['move_bookmark', '移动书签或文件夹', false],
  ['rename_bookmark', '重命名书签或文件夹', false],
  ['update_url', '修改书签 URL', false],
  ['propose_deletions', '提交删除提议（需用户在扩展里确认）', false],
];

/** 待扩展领取的请求：id → { resolve, reject, timer } */
const pending = new Map();
/** 已领取但还没回结果的队列（长轮询的"下一个"） */
const inbox = [];
let waiter = null;

function enqueue(req) {
  inbox.push(req);
  if (waiter) {
    const w = waiter;
    waiter = null;
    w();
  }
}

function takeNext() {
  return inbox.shift() ?? null;
}

function dispatch(tool, args, client) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`调用超时：扩展没有在 ${CALL_TIMEOUT_MS / 1000}s 内返回。请确认 MarkAI 已打开且对外接口为启用状态。`));
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    enqueue({ id, tool, args, client });
  });
}

function settle(response) {
  const entry = pending.get(response.id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(response.id);
  if (response.ok) entry.resolve(response);
  else entry.reject(new Error(response.error || '调用失败'));
  return true;
}

function authOk(header) {
  const raw = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(raw);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

async function readBody(req, limit = 512 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);

  // 健康检查不需要 token：它只回"活着/有多少待办"，不含任何书签数据
  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, version: PKG.version, pending: pending.size, queued: inbox.length });
  }

  if (!authOk(req.headers.authorization)) {
    return json(res, 401, { ok: false, error: 'token 不正确' });
  }

  if (req.method === 'GET' && url.pathname === '/v1/tools') {
    return json(res, 200, {
      ok: true,
      tools: TOOLS.map(([name, description, readOnly]) => ({ name, description, readOnly })),
    });
  }

  // 扩展的长轮询：有活立刻给，没活挂 25s 后 204
  if (req.method === 'GET' && url.pathname === '/next') {
    const immediate = takeNext();
    if (immediate) return json(res, 200, immediate);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const item = takeNext();
      if (item) json(res, 200, item);
      else {
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        res.end();
      }
    };
    waiter = finish;
    const hold = setTimeout(finish, HOLD_MS);
    req.on('close', () => {
      clearTimeout(hold);
      if (waiter === finish) waiter = null;
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/result') {
    try {
      const body = JSON.parse(await readBody(req));
      const ok = settle(body);
      return json(res, ok ? 200 : 404, { ok, error: ok ? undefined : '没有等待中的调用' });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/v1/call') {
    try {
      const body = JSON.parse(await readBody(req));
      const tool = typeof body.tool === 'string' ? body.tool : '';
      if (!TOOLS.some(([name]) => name === tool)) {
        return json(res, 400, { ok: false, error: `未知工具：${tool}` });
      }
      const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};
      const response = await dispatch(tool, args, 'http');
      return json(res, 200, response);
    } catch (e) {
      return json(res, 502, { ok: false, error: e.message });
    }
  }

  json(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.error(`MarkAI 桥已启动：http://127.0.0.1:${PORT}  (MCP: stdio)`);
});

/* ── MCP over stdio ──
 * 只实现 MCP 的最小必要面：initialize / tools/list / tools/call。
 * 不实现 resources / prompts：这个桥的职责是"操作书签"，不是通用 MCP 平台。
 */
function sendMcp(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handleMcp(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return sendMcp({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'markai', version: PKG.version },
      },
    });
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') return sendMcp({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') {
    return sendMcp({
      jsonrpc: '2.0',
      id,
      result: {
        tools: TOOLS.map(([name, description, readOnly]) => ({
          name,
          description,
          inputSchema: { type: 'object', additionalProperties: true },
          annotations: { readOnlyHint: readOnly },
        })),
      },
    });
  }
  if (method === 'tools/call') {
    const name = params?.name;
    try {
      const response = await dispatch(name, params?.arguments ?? {}, 'mcp');
      return sendMcp({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: response.result ?? '' }] },
      });
    } catch (e) {
      return sendMcp({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: e.message }], isError: true },
      });
    }
  }
  if (id !== undefined) {
    sendMcp({ jsonrpc: '2.0', id, error: { code: -32601, message: `未知方法：${method}` } });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  try {
    const msg = JSON.parse(text);
    void handleMcp(msg);
  } catch {
    sendMcp({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '不是合法 JSON' } });
  }
});

function shutdown() {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error('桥已关闭'));
  }
  pending.clear();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
