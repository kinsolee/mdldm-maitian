// MCP：用 SDK 的 Client + stdio 起 src/mcp/server.mjs，MAITIAN_OPS_DB 指临时库（先灌固定数据）。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ingestSnapshot } from '../src/ops/engage/store.mjs';
import { openOpsDb } from '../src/ops/db.mjs';
import { freshDb, douyin, tmpDbFile, comment, commentsSnap, T0, MIN, at } from './helpers/engage-fixtures.mjs';

const SERVER = path.resolve(import.meta.dirname, '../src/mcp/server.mjs');
const READ_TOOLS = ['ack_event', 'get_comment_thread', 'get_conversation', 'get_work', 'get_work_flow', 'inbox', 'list_accounts', 'list_comments',
  'list_conversations', 'list_events', 'list_works', 'refresh_now', 'subscribe_events', 'unsubscribe_events'];

async function connect(file, args = ['--scope', 'read'], env = {}) {
  const base = { ...process.env };
  delete base.MAITIAN_ENGAGE_TOKEN;
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, ...args], stderr: 'pipe',
    env: { ...base, MAITIAN_OPS_DB: file, MAITIAN_CONFIG: path.join(path.dirname(file), 'no-config.json'), MAITIAN_ENV_FILE: path.join(path.dirname(file), 'no.env'), ...env } });
  let stderr = '';
  transport.stderr.on('data', (d) => { stderr += d; });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}
const call = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, value: r.isError ? r.content[0].text : JSON.parse(r.content[0].text) };
};

describe('MCP read 组', () => {
  let file, conn;
  before(async () => {
    file = tmpDbFile();
    const db = freshDb(file);
    ingestSnapshot(db, douyin(db), commentsSnap([comment('r1')]), { now: at(T0) });
    ingestSnapshot(db, douyin(db), commentsSnap([comment('r1'), comment('a', { parent: 'r1' }), comment('me', { parent: 'a', root: 'r1', isMe: true })]), { now: at(T0 + MIN) });
    db.close();
    conn = await connect(file);
  });
  after(async () => { await conn.client.close(); });

  test('列出全部 read 工具', async () => {
    const { tools } = await conn.client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), READ_TOOLS);
  });

  test('调工具核对返回结构', async () => {
    const accounts = (await call(conn.client, 'list_accounts')).value;
    assert.ok(accounts.some((x) => x.id === 'Douyin:106707338905' && 'lastSync' in x && 'capabilities' in x));
    const ib = (await call(conn.client, 'inbox', { platforms: ['Douyin'] })).value;
    assert.deepEqual(ib, [{ platform: 'Douyin', unhandledEvents: 1, unreadConversations: 0, unrepliedComments: 0 }]);
    const ev = (await call(conn.client, 'list_events', { unhandled: true })).value;
    assert.equal(ev.items[0].id, 'comment.created:Douyin:a');
    assert.deepEqual(Object.keys(ev.items[0].delivery), ['attempts', 'lastAttemptAt', 'deliveredAt']);
    const t = (await call(conn.client, 'get_comment_thread', { commentId: 'Douyin:me' })).value;
    assert.equal(t.root.id, 'Douyin:r1');
    assert.equal(t.root.children[0].children[0].author.isMe, true);
    assert.equal(t.work.title, '作品一');
    const ack = (await call(conn.client, 'ack_event', { eventId: 'comment.created:Douyin:a', outcome: 'replied' })).value;
    assert.equal(ack.handled.outcome, 'replied');
    const sub = (await call(conn.client, 'subscribe_events', { subscriberId: 'b1', url: 'https://bot.example/h', types: ['comment.created'] })).value;
    assert.match(sub.secret, /^[0-9a-f]{64}$/);
    assert.equal('secret' in (await call(conn.client, 'subscribe_events', { subscriberId: 'b1', url: 'https://bot.example/h2', types: ['dm.received'] })).value, false);
    const job = (await call(conn.client, 'refresh_now', { kind: 'comments', platform: 'Douyin' })).value;
    assert.match(job.jobId, /^job_/);
    assert.deepEqual((await call(conn.client, 'get_work_flow', { workId: 'Douyin:w1' })).value.hours, []);
  });

  test('参数不对报清楚的错', async () => {
    const r = await call(conn.client, 'get_comment_thread', { commentId: 'abc' });
    assert.equal(r.isError, true);
    assert.match(r.value, /<platformCode>:<原生 id>/);
    const bad = await call(conn.client, 'ack_event', { eventId: 'x', outcome: 'done' });
    assert.equal(bad.isError, true);
  });

});

// engage 组：口令对上才注册，且只注册 reply_comment、send_dm。测试只走到 runner 之前就返回的路径（能力位关着、库里拦下），绝不起浏览器。
const ENGAGE_TOOLS = ['block_user', 'delete_comment', 'delete_conversation', 'reply_comment', 'send_dm'];
const TOKEN = 'a'.repeat(64);
const listNames = async (client) => {
  if (!client.getServerCapabilities()?.tools) return [];
  return (await client.listTools()).tools.map((t) => t.name).sort();
};

describe('MCP engage 组（--scope engage）', () => {
  let file, envFile;
  before(() => {
    file = tmpDbFile();
    const db = freshDb(file);
    ingestSnapshot(db, douyin(db), commentsSnap([comment('r1')]), { now: at(T0) });
    ingestSnapshot(db, douyin(db), commentsSnap([comment('r1'), comment('a', { parent: 'r1' })]), { now: at(T0 + MIN) });
    db.close();
    envFile = path.join(path.dirname(file), '.env');
    fs.writeFileSync(envFile, `MAITIAN_ENGAGE_TOKEN=${TOKEN}\n`, { mode: 0o600 });
  });

  test('口令和 .env 一致：只注册 engage 组（回复、私信、B站处置），不带 read 组', async () => {
    const c = await connect(file, ['--scope', 'engage'], { MAITIAN_ENV_FILE: envFile, MAITIAN_ENGAGE_TOKEN: TOKEN });
    try {
      assert.deepEqual(await listNames(c.client), ENGAGE_TOOLS);
      const { tools } = await c.client.listTools();
      const rc = tools.find((t) => t.name === 'reply_comment');
      assert.deepEqual(Object.keys(rc.inputSchema.properties).sort(), ['commentId', 'eventId', 'idempotencyKey', 'text']);
      assert.deepEqual(rc.inputSchema.required.sort(), ['commentId', 'idempotencyKey', 'text']);
      const sd = tools.find((t) => t.name === 'send_dm');
      assert.deepEqual(Object.keys(sd.inputSchema.properties).sort(), ['conversationId', 'eventId', 'idempotencyKey', 'text']);
      const props = (n) => Object.keys(tools.find((t) => t.name === n).inputSchema.properties).sort();
      assert.deepEqual(props('delete_comment'), ['commentId', 'eventId', 'idempotencyKey']);
      assert.deepEqual(props('block_user'), ['eventId', 'idempotencyKey', 'target']);
      assert.deepEqual(props('delete_conversation'), ['conversationId', 'eventId', 'idempotencyKey']);
      assert.ok(!c.stderr().includes(TOKEN));
    } finally { await c.client.close(); }
  });

  for (const [label, env] of [
    ['进程环境里没有口令', {}],
    ['口令对不上', { MAITIAN_ENGAGE_TOKEN: 'b'.repeat(64) }],
    ['.env 里没有口令', { MAITIAN_ENGAGE_TOKEN: TOKEN, MAITIAN_ENV_FILE: '__no_env__' }],
  ]) {
    test(`${label}：一个工具都不注册，stderr 写一句原因，不出现口令值`, async () => {
      const e = { MAITIAN_ENV_FILE: envFile, ...env };
      if (e.MAITIAN_ENV_FILE === '__no_env__') e.MAITIAN_ENV_FILE = path.join(path.dirname(file), 'missing.env');
      const c = await connect(file, ['--scope', 'engage'], e);
      try {
        assert.deepEqual(await listNames(c.client), []);
        assert.match(c.stderr(), /engage.*没有注册任何工具/);
        assert.ok(!c.stderr().includes(TOKEN));
        assert.ok(!c.stderr().includes('b'.repeat(64)));
      } finally { await c.client.close(); }
    });
  }

  test('--scope read 带着口令也不注册写工具', async () => {
    const c = await connect(file, ['--scope', 'read'], { MAITIAN_ENV_FILE: envFile, MAITIAN_ENGAGE_TOKEN: TOKEN });
    try { assert.deepEqual(await listNames(c.client), READ_TOOLS); } finally { await c.client.close(); }
  });

  test('能力位关着：reply_comment 返回 rejected，记 actions（调用方是 MCP 客户端名），不起 runner', async () => {
    const c = await connect(file, ['--scope', 'engage'], { MAITIAN_ENV_FILE: envFile, MAITIAN_ENGAGE_TOKEN: TOKEN });
    try {
      const r = (await call(c.client, 'reply_comment', { commentId: 'Douyin:a', text: '谢谢', idempotencyKey: 'comment.created:Douyin:a' })).value;
      assert.equal(r.status, 'rejected');
      assert.equal(r.reason, 'capability-off');
      assert.equal(r.sendAttempted, false);
      const bad = await call(c.client, 'send_dm', { conversationId: 'nope', text: 'x', idempotencyKey: 'k' });
      assert.equal(bad.isError, true);
      assert.match(bad.value, /<platformCode>:<原生 id>/);
    } finally { await c.client.close(); }
    const db = openOpsDb(file);
    try {
      const row = db.prepare('SELECT caller, status, reason FROM actions').get();
      assert.deepEqual({ ...row }, { caller: 'mcp:test', status: 'rejected', reason: 'capability-off' });
    } finally { db.close(); }
  });

  test('处置工具：非 B站 → rejected unsupported-platform，不起 runner', async () => {
    const c = await connect(file, ['--scope', 'engage'], { MAITIAN_ENV_FILE: envFile, MAITIAN_ENGAGE_TOKEN: TOKEN });
    try {
      for (const [name, args] of [['delete_comment', { commentId: 'Douyin:a' }], ['block_user', { target: 'Douyin:a' }], ['delete_conversation', { conversationId: 'Douyin:c' }]]) {
        const r = (await call(c.client, name, { ...args, idempotencyKey: `k-${name}` })).value;
        assert.deepEqual([r.status, r.reason, r.sendAttempted], ['rejected', 'unsupported-platform', false], name);
      }
    } finally { await c.client.close(); }
  });
});
