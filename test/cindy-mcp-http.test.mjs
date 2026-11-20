// Cindy 用的麦田 MCP（HTTP 版）：鉴权、Host 校验、只有三个只读工具。临时库，监听 127.0.0.1 的随机端口。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ingestSnapshot } from '../src/ops/engage/store.mjs';
import { buildServer } from '../src/mcp/server.mjs';
import { createMcpHttp, checkBearer, ensureToken, CINDY_TOOLS, MCP_PATH } from '../integrations/cindy/mcp-http.mjs';
import { freshDb, douyin, comment, commentsSnap, T0, MIN, at } from './helpers/engage-fixtures.mjs';

const TOKEN = 'x'.repeat(43);

function raw(port, { method = 'POST', pathName = MCP_PATH, headers = {}, body = '{}' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathName, headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers } }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (method === 'POST') req.end(body); else req.end();
  });
}

const initBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });

describe('Cindy 麦田 MCP（HTTP）', () => {
  let db, server, port, logs;
  before(async () => {
    db = freshDb();
    ingestSnapshot(db, douyin(db), commentsSnap([comment('r1')]), { now: at(T0) });
    ingestSnapshot(db, douyin(db), commentsSnap([comment('r1'), comment('a', { parent: 'r1' })]), { now: at(T0 + MIN) });
    logs = [];
    // 先占端口再建处理函数：Host 白名单要用真实端口
    let handler;
    server = http.createServer((req, res) => handler(req, res));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
    handler = createMcpHttp({ db, token: TOKEN, port, log: (l) => logs.push(l) });
  });
  after(async () => { await new Promise((r) => server.close(r)); db.close(); });

  async function connect(token = TOKEN, host = '127.0.0.1') {
    const transport = new StreamableHTTPClientTransport(new URL(`http://${host}:${port}${MCP_PATH}`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(transport);
    return client;
  }

  test('只列出三个只读工具', async () => {
    const c = await connect();
    try {
      const { tools } = await c.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), [...CINDY_TOOLS].sort());
    } finally { await c.close(); }
  });

  test('get_comment_thread 能读到整楼；ack_event、list_events 调不到', async () => {
    const c = await connect();
    try {
      const r = await c.callTool({ name: 'get_comment_thread', arguments: { commentId: 'Douyin:a' } });
      assert.ok(!r.isError, r.content?.[0]?.text);
      assert.ok(JSON.parse(r.content[0].text));
      for (const name of ['ack_event', 'list_events', 'subscribe_events', 'refresh_now']) {
        const bad = await c.callTool({ name, arguments: { eventId: 'x', outcome: 'replied' } }).catch((e) => ({ isError: true, content: [{ text: e.message }] }));
        assert.ok(bad.isError, `${name} 不该能调`);
      }
    } finally { await c.close(); }
    assert.ok(db.prepare('SELECT COUNT(*) n FROM events WHERE handledAt IS NOT NULL').get().n === 0);
  });

  test('localhost 也认', async () => {
    const c = await connect(TOKEN, 'localhost');
    await c.close();
  });

  test('没带 token、token 错、格式错一律 401', async () => {
    assert.equal((await raw(port, { body: initBody })).status, 401);
    assert.equal((await raw(port, { body: initBody, headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await raw(port, { body: initBody, headers: { Authorization: TOKEN } })).status, 401);
    assert.equal((await raw(port, { body: initBody, headers: { Authorization: `Bearer ${TOKEN}x` } })).status, 401);
  });

  test('Host 不是本机回 403（防 DNS rebinding）', async () => {
    const r = await raw(port, { body: initBody, headers: { Authorization: `Bearer ${TOKEN}`, Host: `evil.example:${port}` } });
    assert.equal(r.status, 403);
  });

  test('路径不对 404，GET 和 DELETE 回 405，坏 JSON 回 400', async () => {
    const auth = { Authorization: `Bearer ${TOKEN}` };
    assert.equal((await raw(port, { pathName: '/other', headers: auth })).status, 404);
    assert.equal((await raw(port, { method: 'GET', headers: auth })).status, 405);
    assert.equal((await raw(port, { method: 'DELETE', headers: auth })).status, 405);
    assert.equal((await raw(port, { body: '{oops', headers: auth })).status, 400);
  });

  test('日志里没有 token，也没有工具参数', () => {
    const all = logs.join('\n');
    assert.ok(!all.includes(TOKEN));
    assert.ok(!all.includes('Douyin:a'));
  });

  test('token 太短拒绝启动', () => {
    assert.throws(() => createMcpHttp({ db, token: 'short', port }), /太短/);
  });
});

describe('辅助函数', () => {
  test('checkBearer', () => {
    assert.equal(checkBearer(TOKEN, `Bearer ${TOKEN}`), true);
    assert.equal(checkBearer(TOKEN, `bearer ${TOKEN}`), true);
    assert.equal(checkBearer(TOKEN, undefined), false);
    assert.equal(checkBearer('', 'Bearer '), false);
    assert.equal(checkBearer(TOKEN, `Bearer ${TOKEN} extra`), false);
  });

  test('ensureToken：没有就生成并写进 .env（0600），有就不动', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-mcp-'));
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, 'RECEIVER_PORT=8791\n', { mode: 0o644 });
    const env = {};
    const t = ensureToken(env, file);
    assert.ok(t.length >= 43);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(file, 'utf8'), /^RECEIVER_PORT=8791\nCINDY_MCP_TOKEN=\S+\n$/);
    assert.equal(ensureToken(env, file), t);
    assert.equal(ensureToken({ CINDY_MCP_TOKEN: 'keep' }, file), 'keep');
  });

  test('buildServer 的工具白名单拼错就抛错', () => {
    const db = freshDb();
    try { assert.throws(() => buildServer(db, { tools: ['get_wrok'] }), /get_wrok/); } finally { db.close(); }
  });
});
