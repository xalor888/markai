/**
 * ── 本机桥的端到端测试 ──
 *
 * 桥是"外部 Agent 与扩展之间唯一的真实链路"，所以必须验证三件真实发生的事：
 *  1. 没有 token 的请求被 401 拒绝（不是"看起来拒绝"）；
 *  2. 一次调用真的走完「HTTP → 队列 → 扩展领取 → 回结果」整条路；
 *  3. MCP stdio 的 initialize / tools/list / tools/call 都能返回合法 JSON-RPC。
 *
 * 用真子进程 + 真 HTTP，不用 mock：桥的价值就在"跨进程"这件事上。
 *
 * 运行：node tests/bridge.test.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(HERE, '..', 'tools', 'markai-bridge.mjs');
const TOKEN = 'b'.repeat(48);
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
function ok(name, fn) {
  return Promise.resolve(fn()).then(
    () => {
      passed++;
      console.log(`  ✔ ${name}`);
    },
    (e) => {
      console.error(`  ✘ ${name}`);
      throw e;
    },
  );
}

function startBridge(extraArgs = []) {
  const child = spawn(process.execPath, [BRIDGE, '--token', TOKEN, '--port', String(PORT), ...extraArgs], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [];
  createInterface({ input: child.stdout }).on('line', (l) => lines.push(l));
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += String(d);
  });
  return { child, lines, getStderr: () => stderr };
}

async function waitFor(fn, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error('等待超时');
}

/** 模拟扩展：领一个请求，回一个结果 */
async function extensionPoll() {
  const res = await fetch(`${BASE}/next`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (res.status === 204) return null;
  return res.json();
}

async function extensionResult(id, okFlag, result) {
  const res = await fetch(`${BASE}/v1/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ id, ok: okFlag, result, error: okFlag ? undefined : result }),
  });
  return res.json();
}

const bridge = startBridge();

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok);

  console.log('\n[B1] HTTP 鉴权');
  await ok('健康检查不需要 token', async () => {
    const res = await fetch(`${BASE}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });

  await ok('没有 token 的调用被 401 拒绝', async () => {
    const res = await fetch(`${BASE}/v1/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'stats', args: {} }),
    });
    assert.equal(res.status, 401);
  });

  await ok('错误 token 被 401 拒绝', async () => {
    const res = await fetch(`${BASE}/v1/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${'c'.repeat(48)}` },
      body: JSON.stringify({ tool: 'stats', args: {} }),
    });
    assert.equal(res.status, 401);
  });

  await ok('工具清单需要 token，且列出 11 个工具', async () => {
    const denied = await fetch(`${BASE}/v1/tools`);
    assert.equal(denied.status, 401);
    const res = await fetch(`${BASE}/v1/tools`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const body = await res.json();
    assert.equal(body.tools.length, 11);
    assert.equal(body.tools.find((t) => t.name === 'stats').readOnly, true);
    assert.equal(body.tools.find((t) => t.name === 'create_folder').readOnly, false);
  });

  console.log('\n[B2] 完整调用链路');
  await ok('未知工具在桥侧就被拒绝（不打扰扩展）', async () => {
    const res = await fetch(`${BASE}/v1/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ tool: 'rm_rf', args: {} }),
    });
    assert.equal(res.status, 400);
  });

  await ok('调用经队列到"扩展"，结果原路返回', async () => {
    const callPromise = fetch(`${BASE}/v1/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ tool: 'search_bookmarks', args: { query: 'react' } }),
    }).then((r) => r.json());

    const job = await waitFor(extensionPoll);
    assert.equal(job.tool, 'search_bookmarks');
    assert.deepEqual(job.args, { query: 'react' });

    const settled = await extensionResult(job.id, true, JSON.stringify({ matched: 3 }));
    assert.equal(settled.ok, true);

    const response = await callPromise;
    assert.equal(response.ok, true);
    assert.equal(JSON.parse(response.result).matched, 3);
  });

  await ok('扩展报错时，调用方拿到 ok:false 与错误文案', async () => {
    const callPromise = fetch(`${BASE}/v1/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ tool: 'stats', args: {} }),
    }).then((r) => r.json());

    const job = await waitFor(extensionPoll);
    await extensionResult(job.id, false, '书签读取失败');
    const response = await callPromise;
    assert.equal(response.ok, false);
    assert.match(response.error, /书签读取失败/);
  });

  await ok('重复回结果被识别为"没有等待中的调用"', async () => {
    const res = await fetch(`${BASE}/v1/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ id: 'not-a-real-id', ok: true }),
    });
    assert.equal(res.status, 404);
  });

  console.log('\n[B3] MCP over stdio');
  /*
   * 复用同一个桥进程：这是真实的部署形态——一个桥同时对外提供 HTTP 与 MCP stdio，
   * 两条入口共用同一条队列。再起一个进程抢同一个端口只会测到"端口冲突"。
   */
  {
    const rpc = (msg) => {
      bridge.child.stdin.write(`${JSON.stringify(msg)}\n`);
      return waitFor(async () => {
        const found = bridge.lines.find((l) => {
          try {
            return JSON.parse(l).id === msg.id;
          } catch {
            return false;
          }
        });
        return found ? JSON.parse(found) : null;
      });
    };

    await ok('initialize 返回协议版本与服务器名', async () => {
      const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
      assert.equal(res.result.protocolVersion, '2024-11-05');
      assert.equal(res.result.serverInfo.name, 'markai');
    });

    await ok('tools/list 返回带 inputSchema 的工具', async () => {
      const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      assert.equal(res.result.tools.length, 11);
      const stats = res.result.tools.find((t) => t.name === 'stats');
      assert.equal(stats.inputSchema.type, 'object');
      assert.equal(stats.annotations.readOnlyHint, true);
    });

    await ok('tools/call 走同一条队列，并回 MCP content', async () => {
      const call = rpc({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'list_bookmarks', arguments: { limit: 2 } },
      });
      const job = await waitFor(extensionPoll);
      assert.equal(job.client, 'mcp');
      await extensionResult(job.id, true, JSON.stringify({ items: 2 }));
      const res = await call;
      assert.equal(res.result.content[0].type, 'text');
      assert.equal(JSON.parse(res.result.content[0].text).items, 2);
    });

    await ok('未知方法返回 -32601', async () => {
      const res = await rpc({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
      assert.equal(res.error.code, -32601);
    });
  }

  console.log(`\n✓ bridge：${passed} 项全部通过`);
} finally {
  bridge.child.kill('SIGTERM');
}
