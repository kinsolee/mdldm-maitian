// MCP：用 SDK 的 Client + stdio 起 src/mcp/server.mjs，MAITIAN_OPS_DB 指临时库（先灌固定数据）。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ingestSnapshot } from '../src/ops/engage/store.mjs';
import { freshDb, douyin, tmpDbFile, comment, commentsSnap, T0, MIN, at } from './helpers/engage-fixtures.mjs';

const SERVER = path.resolve(import.meta.dirname, '../src/mcp/server.mjs');
const READ_TOOLS = ['ack_event', 'get_comment_thread', 'get_conversation', 'get_work', 'get_work_flow', 'inbox', 'list_accounts', 'list_comments',
  'list_conversations', 'list_events', 'list_works', 'refresh_now', 'subscribe_events', 'unsubscribe_events'];

async function connect(file, args = ['--scope', 'read']) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, ...args], stderr: 'pipe',
    env: { ...process.env, MAITIAN_OPS_DB: file, MAITIAN_CONFIG: path.join(path.dirname(file), 'no-config.json') } });
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

  test('--scope engage：stderr 说明后只注册 read 组', async () => {
    const c = await connect(file, ['--scope', 'engage']);
    const { tools } = await c.client.listTools();
    assert.deepEqual(tools.map((x) => x.name).sort(), READ_TOOLS);
    assert.match(c.stderr(), /scope engage.*只注册 read 组/);
    await c.client.close();
  });
});
