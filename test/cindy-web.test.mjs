// 麦田网页的「Cindy 接入」：状态接口不带 token；取 token、换 token 只给本机同源请求；换了之后旧 token 在运行中的 MCP 上立刻失效。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { rotateToken, readToken, cindyStatus, probeMcp } from '../integrations/cindy/admin.mjs';
import { createMcpHttp, tokenFromFile, CINDY_TOOLS } from '../integrations/cindy/mcp-http.mjs';
import { freshDb } from './helpers/engage-fixtures.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-web-'));

async function listen(handlerFor) {
  let handler;
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  handler = handlerFor(port);
  return { port, close: () => new Promise((r) => server.close(r)) };
}

function envFile(dir, extra = '') {
  const f = path.join(dir, '.env');
  fs.writeFileSync(f, `CINDY_INBOX_DB=${path.join(dir, 'inbox.db')}\nCINDY_LEDGER_FILE=${path.join(dir, 'ledger.jsonl')}\nRECEIVER_PORT=1\n${extra}`, { mode: 0o600 });
  return f;
}

describe('admin：token 和链路状态', () => {
  test('rotateToken 写进 .env（0600），每次都不一样；readToken 读得到', () => {
    const f = envFile(tmp());
    const a = rotateToken(f), b = rotateToken(f);
    assert.notEqual(a, b);
    assert.equal(readToken(f), b);
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(f, 'utf8').match(/CINDY_MCP_TOKEN=/g).length, 1);
  });

  test('服务都没起：状态里 MCP、接收端都是不通，没有 token 字样', async () => {
    const dir = tmp(), f = envFile(dir, 'CINDY_MCP_PORT=1\n');
    const token = rotateToken(f);
    const s = await cindyStatus({ envFile: f });
    assert.equal(s.mcp.ok, false);
    assert.equal(s.mcp.hasToken, true);
    assert.equal(s.receiver.ok, false);
    assert.equal(s.inbox, null);
    assert.equal(s.ledger.exists, false);
    assert.ok(!JSON.stringify(s).includes(token));
  });

  test('MCP 在跑：探测通过、只有三个工具；换 token 后旧的立刻 401，不用重启', async () => {
    const dir = tmp(), f = envFile(dir);
    const old = rotateToken(f);
    const db = freshDb();
    const srv = await listen((port) => createMcpHttp({ db, token: tokenFromFile(f), port, log: () => {} }));
    try {
      fs.appendFileSync(f, `CINDY_MCP_PORT=${srv.port}\n`);
      const s = await cindyStatus({ envFile: f });
      assert.equal(s.mcp.ok, true, s.mcp.error);
      assert.deepEqual(s.mcp.tools, [...CINDY_TOOLS].sort());

      const url = `http://127.0.0.1:${srv.port}/mcp`;
      const fresh = rotateToken(f);
      assert.equal((await probeMcp(url, old)).error, 'token 对不上');
      assert.equal((await probeMcp(url, fresh)).ok, true);
    } finally { await srv.close(); db.close(); }
  });
});

describe('探测结果不回显对方的内容', () => {
  // 假 MCP：initialize 照常，tools/list 按 mode 回；mode=leak 时回 500，正文里带 Authorization
  async function fakeMcp(mode) {
    return listen(() => (req, res) => {
      let b = ''; req.on('data', (d) => { b += d; });
      req.on('end', () => {
        const m = JSON.parse(b || '{}');
        const reply = (result) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result })); };
        if (m.method === 'initialize') return reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } });
        if (!('id' in m)) { res.writeHead(202); return res.end(); }
        if (mode === 'leak') { res.writeHead(500); return res.end(`boom ${req.headers.authorization}`); }
        const names = mode === 'dup' ? ['get_comment_thread', 'get_comment_thread', 'get_conversation'] : ['get_comment_thread', 'get_conversation', 'get_work', 'ack_event'];
        reply({ tools: names.map((name) => ({ name, inputSchema: { type: 'object' } })) });
      });
    });
  }

  test('错误正文里有 token：状态里只有固定文案', async () => {
    const srv = await fakeMcp('leak');
    try {
      const token = 'T'.repeat(43);
      const r = await probeMcp(`http://127.0.0.1:${srv.port}/mcp`, token);
      assert.equal(r.ok, false);
      assert.ok(!JSON.stringify(r).includes(token), JSON.stringify(r));
    } finally { await srv.close(); }
  });

  test('重复名字凑够三个、或多出工具：都不算通', async () => {
    for (const mode of ['dup', 'extra']) {
      const srv = await fakeMcp(mode);
      try {
        const r = await probeMcp(`http://127.0.0.1:${srv.port}/mcp`, 'T'.repeat(43));
        assert.equal(r.ok, false, mode);
        assert.ok(!JSON.stringify(r).includes('ack_event'));
      } finally { await srv.close(); }
    }
  });

  test('接收端健康检查只带三个数字', async () => {
    const dir = tmp();
    const srv = await listen(() => (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, total: 3, processed: 1, pending: 2, secret: 'leak' })); });
    try {
      fs.writeFileSync(path.join(dir, '.env'), `CINDY_INBOX_DB=${path.join(dir, 'i.db')}\nCINDY_LEDGER_FILE=${path.join(dir, 'l.jsonl')}\nRECEIVER_PORT=${srv.port}\nCINDY_MCP_PORT=1\n`);
      const st = await cindyStatus({ envFile: path.join(dir, '.env') });
      assert.deepEqual(st.receiver, { ok: true, total: 3, processed: 1, pending: 2 });
    } finally { await srv.close(); }
  });
});

describe('网页接口（起真的网页服务）', () => {
  async function serve(run) {
    const dir = tmp(), f = envFile(dir, 'CINDY_MCP_PORT=1\n');
    const port = 20000 + Math.floor(Math.random() * 20000);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ web: { port, key: 'test-key' }, rootPath: dir }));
    const p = spawn(process.execPath, ['--input-type=module', '-e', `const { startWeb } = await import(${JSON.stringify(path.join(ROOT, 'src', 'web.mjs'))}); startWeb();`],
      { env: { ...process.env, MAITIAN_CONFIG: path.join(dir, 'config.json'), MAITIAN_DB: path.join(dir, 'hub.db'), MAITIAN_OPS_DB: path.join(dir, 'ops.db'), CINDY_ENV_FILE: f }, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise((ok, bad) => { p.stdout.on('data', (d) => /麦田网页/.test(d) && ok()); p.on('exit', (c) => bad(new Error(`服务退出 ${c}`))); setTimeout(() => bad(new Error('服务没起来')), 10000); });
      // fetch 改不了 Host，用 http.request
      const req = (method, url, headers = {}) => new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: { cookie: 'mt_key=test-key', host: `localhost:${port}`, ...headers } }, (res) => {
          let body = ''; res.on('data', (d) => { body += d; }); res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        r.on('error', reject); r.end();
      });
      await run({ req, port, f });
    } finally { p.kill(); }
  }

  test('页面能打开；状态接口不带 token；本机同源才能取、换 token', async () => {
    await serve(async ({ req, port, f }) => {
      const origin = { origin: `http://localhost:${port}` };
      assert.equal((await req('GET', '/cindy')).status, 200);
      assert.equal((await req('POST', '/api/cindy/token', { ...origin, cookie: '' })).status, 401, '没登录');
      assert.equal((await req('POST', '/api/cindy/token', origin)).status, 404, '还没有 token');

      const gen = await req('POST', '/api/cindy/token?rotate=1', origin);
      assert.equal(gen.status, 200);
      const { token } = JSON.parse(gen.body);
      assert.equal(token, readToken(f));
      assert.equal(JSON.parse((await req('POST', '/api/cindy/token', origin)).body).token, token);

      const st = await req('GET', '/api/cindy/status');
      assert.equal(st.status, 200);
      assert.equal(JSON.parse(st.body).local, true);
      assert.ok(!st.body.includes(token));

      // 没有 Origin、跨站 Origin、隧道或局域网（Host 不是本机、带代理头）一律 403，token 不变
      assert.equal((await req('POST', '/api/cindy/token?rotate=1')).status, 403);
      assert.equal((await req('POST', '/api/cindy/token?rotate=1', { origin: 'https://evil.example' })).status, 403);
      assert.equal((await req('POST', '/api/cindy/token', { host: 'maitian.example.com', origin: 'https://maitian.example.com' })).status, 403);
      assert.equal((await req('POST', '/api/cindy/token', { ...origin, 'cf-connecting-ip': '1.2.3.4' })).status, 403);
      assert.equal((await req('POST', '/api/cindy/token', { ...origin, 'x-forwarded-for': '1.2.3.4' })).status, 403);
      assert.equal((await req('POST', '/api/cindy/token', { ...origin, 'x-forwarded-proto': 'https' })).status, 403);
      assert.equal((await req('POST', '/api/cindy/token', { ...origin, via: '1.1 proxy' })).status, 403);
      assert.equal((await req('POST', '/api/cindy/token?rotate=1', { origin: `https://localhost:${port}` })).status, 403, '跨协议');
      assert.equal((await req('POST', '/api/cindy/token?rotate=1', { origin: `http://localhost:${port + 1}` })).status, 403, '跨端口');
      assert.equal((await req('POST', '/api/cindy/status')).status, 405);
      assert.equal(JSON.parse((await req('GET', '/api/cindy/status', { host: 'maitian.example.com' })).body).local, false);
      assert.equal(readToken(f), token);

      assert.equal((await req('GET', '/api/cindy/token', origin)).status, 404, 'GET 不给 token');
    });
  });
});
