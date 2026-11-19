// OpenBot 接收端（integrations/openbot）：验签、去重、批次键、投递重试、配置检查、订阅登记，
// 以及麦田真实发件箱（deliverPending）推到接收端的整条链路。OpenBot 本身用假的 forward 代替。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { createReceiver, HOOK_PATH } from '../integrations/openbot/receiver.mjs';
import { openStore, batchKey, RETRY_DELAYS_MS, MAX_ATTEMPTS } from '../integrations/openbot/store.mjs';
import { readConfig, writeEnvValue } from '../integrations/openbot/config.mjs';
import { taskText, clientMessageId, cliForwarder } from '../integrations/openbot/forward.mjs';
import { ensureSubscribed, subscribeViaMcp } from '../integrations/openbot/subscribe.mjs';
import { subscribe } from '../src/ops/engage/subscribers.mjs';
import { ingestSnapshot } from '../src/ops/engage/store.mjs';
import { deliverPending } from '../src/daemon/outbox.mjs';
import { freshDb, douyin, tmpDbFile, comment, commentsSnap, T0, MIN, at } from './helpers/engage-fixtures.mjs';

const SECRET = 'a'.repeat(64);
const SUB = 'openbot-engage';
const sign = (secret, raw) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'openbot-recv-'));
const ev = (id, type = 'comment.created') => ({ id, type, platform: 'Douyin', payload: { text: `正文${id}`, nickname: `昵称${id}` } });

async function start({ forward, now = Date.now, log = () => {} } = {}) {
  const store = openStore(':memory:');
  const calls = [];
  const fwd = forward ?? (async (ids, key) => { calls.push({ ids, key }); return { deliveryId: `d${calls.length}`, status: 'queued' }; });
  const r = createReceiver({ secret: SECRET, subscriberId: SUB, store, forward: fwd, log, now });
  const server = http.createServer(r.handler);
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${server.address().port}${HOOK_PATH}`;
  const post = async (body, { secret = SECRET, raw = JSON.stringify(body) } = {}) => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Maitian-Signature': sign(secret, raw) }, body: raw });
    return { status: res.status, body: await res.json() };
  };
  const close = () => new Promise((ok) => { r.stop(); server.closeAllConnections(); server.close(() => { store.close(); ok(); }); });
  return { store, calls, receiver: r, url, post, close };
}

const batch = (events, batchId = 'batch_1') => ({ subscriberId: SUB, batchId, sentAt: '2026-11-20T00:00:00.000Z', events });

describe('接收端', () => {
  test('验签不过回 401，不入队', async () => {
    const t = await start();
    const r = await t.post(batch([ev('comment.created:Douyin:1')]), { secret: 'b'.repeat(64) });
    assert.equal(r.status, 401);
    assert.equal(t.store.stats().total, 0);
    await t.close();
  });

  test('签名对的是原始字节：改一个空格就不过', async () => {
    const t = await start();
    const raw = JSON.stringify(batch([ev('x')]));
    const res = await fetch(t.url, { method: 'POST', headers: { 'X-Maitian-Signature': sign(SECRET, raw) }, body: `${raw} ` });
    assert.equal(res.status, 401);
    await t.close();
  });

  test('验签通过：回 200，按排序后的 id 投一批，批次键确定', async () => {
    const t = await start();
    const r = await t.post(batch([ev('comment.created:Douyin:2'), ev('dm.received:Douyin:c1:2026', 'dm.received'), ev('comment.created:Douyin:1')]));
    assert.equal(r.status, 200);
    assert.deepEqual({ accepted: r.body.accepted, duplicate: r.body.duplicate }, { accepted: 3, duplicate: 0 });
    await t.receiver.drain();
    assert.equal(t.calls.length, 1);
    const ids = ['comment.created:Douyin:1', 'comment.created:Douyin:2', 'dm.received:Douyin:c1:2026'];
    assert.deepEqual(t.calls[0].ids, ids);
    assert.equal(t.calls[0].key, batchKey([...ids].reverse()));
    assert.equal(t.store.stats().forwarded, 3);
    await t.close();
  });

  test('重复推送（batchId 变了）不重复入队、不重复投递', async () => {
    const t = await start();
    await t.post(batch([ev('comment.created:Douyin:1')], 'batch_a'));
    await t.receiver.drain();
    const again = await t.post(batch([ev('comment.created:Douyin:1'), ev('comment.created:Douyin:9')], 'batch_b'));
    assert.deepEqual({ accepted: again.body.accepted, duplicate: again.body.duplicate }, { accepted: 1, duplicate: 1 });
    await t.receiver.drain();
    assert.deepEqual(t.calls.map((c) => c.ids), [['comment.created:Douyin:1'], ['comment.created:Douyin:9']]);
    await t.close();
  });

  test('subscriberId 不对、不是 JSON、路径不对：拒收', async () => {
    const t = await start();
    assert.equal((await t.post({ ...batch([ev('x')]), subscriberId: 'other' })).status, 400);
    assert.equal((await t.post(null, { raw: 'not json' })).status, 400);
    const res = await fetch(t.url.replace(HOOK_PATH, '/other'), { method: 'POST', body: '{}' });
    assert.equal(res.status, 404);
    assert.equal(t.store.stats().total, 0);
    await t.close();
  });

  test('投递失败：同一批同一个键重试，用尽后不再投；日志不含正文', async () => {
    let clock = T0;
    const logs = [];
    const keys = [];
    const t = await start({ now: () => clock, log: (l) => logs.push(l), forward: async (ids, key) => { keys.push(key); throw new Error('openbot-cli 退出码 5：OpenBot does not answer'); } });
    await t.post(batch([ev('comment.created:Douyin:1'), ev('comment.created:Douyin:2')]));
    await t.receiver.drain();
    for (const d of RETRY_DELAYS_MS) { clock += d; await t.receiver.drain(); }
    clock += 3600_000;
    await t.receiver.drain();
    assert.equal(keys.length, MAX_ATTEMPTS);
    assert.equal(new Set(keys).size, 1);
    assert.equal(t.store.stats().gaveUp, 2);
    assert.match(logs.at(-1), /已用尽.*list_events/);
    assert.ok(logs.every((l) => !l.includes('正文') && !l.includes('昵称') && !l.includes(SECRET)));
    await t.close();
  });

  test('失败后恢复：下一次重试成功就标已投递', async () => {
    let clock = T0;
    let fail = true;
    const t = await start({ now: () => clock, forward: async () => { if (fail) throw new Error('超时'); return { deliveryId: 'd1' }; } });
    await t.post(batch([ev('comment.created:Douyin:1')]));
    await t.receiver.drain();
    fail = false;
    clock += RETRY_DELAYS_MS[0];
    await t.receiver.drain();
    assert.deepEqual({ ...t.store.stats() }, { total: 1, forwarded: 1, pending: 0, gaveUp: 0 });
    await t.close();
  });

  test('状态存盘：重启后已见过的 id 仍去重', () => {
    const file = path.join(tmpDir(), 'receiver.db');
    let s = openStore(file);
    s.receive([ev('a')], T0);
    s.close();
    s = openStore(file);
    assert.deepEqual(s.receive([ev('a'), ev('b')], T0), { accepted: 1, duplicate: 1 });
    s.close();
  });
});

describe('投递给 OpenBot', () => {
  test('任务文字只有事件 id，没有正文；重试键确定', () => {
    const text = taskText(['comment.created:Douyin:1']);
    assert.match(text, /comment\.created:Douyin:1/);
    assert.match(text, /ack_event/);
    assert.equal(clientMessageId('abc'), 'maitian-abc');
  });

  test('CLI：参数、stdin、退出码', async () => {
    const dir = tmpDir();
    const fake = path.join(dir, 'fake-cli.mjs');
    fs.writeFileSync(fake, `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      require('node:fs').writeFileSync(${JSON.stringify(path.join(dir, 'seen.json'))}, JSON.stringify({ argv: process.argv.slice(2), stdin: s }));
      if (process.env.FAKE_FAIL) { console.error('OpenBot does not answer'); process.exit(5); }
      console.log(JSON.stringify({ result: { deliveryId: 'dlv_1', status: 'queued' } })); });`.replace('require', 'process.getBuiltinModule'));
    const fwd = cliForwarder({ cli: fake, agent: '数据小管家' });
    assert.deepEqual(await fwd(['e1'], 'k1'), { deliveryId: 'dlv_1', status: 'queued' });
    const seen = JSON.parse(fs.readFileSync(path.join(dir, 'seen.json'), 'utf8'));
    assert.deepEqual(seen.argv, ['run', '数据小管家', '-', '--id', 'maitian-k1', '--json']);
    assert.match(seen.stdin, /- e1/);
    process.env.FAKE_FAIL = '1';
    try { await assert.rejects(fwd(['e1'], 'k1'), /退出码 5.*does not answer/); } finally { delete process.env.FAKE_FAIL; }
  });

  test('CLI 超时算失败', async () => {
    const fake = path.join(tmpDir(), 'hang.mjs');
    fs.writeFileSync(fake, 'setTimeout(() => {}, 60_000);');
    await assert.rejects(cliForwarder({ cli: fake, agent: 'x', timeoutMs: 300 })(['e'], 'k'), /超时/);
  });
});

describe('配置', () => {
  test('CLI 路径不存在：明确报错', () => {
    assert.throws(() => readConfig({ OPENBOT_CLI: '/nope/openbot-cli.mjs' }), /找不到 OpenBot CLI.*OPENBOT_CLI/);
  });

  test('默认值', () => {
    const cli = path.join(tmpDir(), 'cli.mjs');
    fs.writeFileSync(cli, '');
    const c = readConfig({ OPENBOT_CLI: cli });
    assert.equal(c.subscriberId, 'openbot-engage');
    assert.equal(c.url, 'http://127.0.0.1:8790/maitian/hook');
    assert.deepEqual(c.types, ['comment.created', 'dm.received']);
    assert.equal(c.agent, '数据小管家');
    assert.equal(c.secret, null);
  });

  test('写 .env：替换已有键，权限 0600', () => {
    const f = path.join(tmpDir(), '.env');
    fs.writeFileSync(f, 'OPENBOT_AGENT=x\nMAITIAN_SECRET=old\n', { mode: 0o644 });
    writeEnvValue(f, 'MAITIAN_SECRET', 'new');
    assert.equal(fs.readFileSync(f, 'utf8'), 'OPENBOT_AGENT=x\nMAITIAN_SECRET=new\n');
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  });
});

describe('订阅登记（经麦田 MCP）', () => {
  const MCP = path.resolve(import.meta.dirname, '../src/mcp/server.mjs');

  test('首次登记把密钥写进 .env；再登记只更新、密钥不变', async () => {
    const opsDb = tmpDbFile();
    freshDb(opsDb).close();
    const envFile = path.join(tmpDir(), '.env');
    const cfg = { mcpServer: MCP, opsDb, subscriberId: SUB, url: 'http://127.0.0.1:8790/maitian/hook', types: ['comment.created', 'dm.received'], secret: null };
    const first = await ensureSubscribed(cfg, { envFile });
    assert.equal(first.created, true);
    assert.match(first.secret, /^[0-9a-f]{64}$/);
    assert.equal(fs.readFileSync(envFile, 'utf8'), `MAITIAN_SECRET=${first.secret}\n`);
    assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
    const second = await ensureSubscribed({ ...cfg, secret: first.secret }, { envFile });
    assert.deepEqual(second, { created: false, secret: first.secret });
    await assert.rejects(ensureSubscribed(cfg, { envFile }), /MAITIAN_SUBSCRIBER_ID/);
  });

  test('subscribeViaMcp 把 MCP 的错误抛出来', async () => {
    const opsDb = tmpDbFile();
    freshDb(opsDb).close();
    await assert.rejects(subscribeViaMcp({ mcpServer: MCP, opsDb, subscriberId: 'bad id!', url: 'http://x', types: ['comment.created'] }), /subscriberId/);
  });
});

describe('整条链路：麦田发件箱 → 接收端 → OpenBot', () => {
  test('新评论出事件，推到接收端，投给 OpenBot；麦田重推同一事件不重复投', async () => {
    const t = await start();
    const db = freshDb();
    const { secret } = subscribe(db, { subscriberId: SUB, url: t.url, types: ['comment.created', 'dm.received'] }, { now: at(T0) });
    // 用接收端的密钥换成麦田发的这把
    t.receiver.stop();
    await t.close();
    const store = openStore(':memory:');
    const calls = [];
    const r = createReceiver({ secret, subscriberId: SUB, store, forward: async (ids, key) => { calls.push({ ids, key }); return { deliveryId: 'd' }; }, log: () => {} });
    const server = http.createServer(r.handler);
    await new Promise((ok) => server.listen(new URL(t.url).port, '127.0.0.1', ok));

    ingestSnapshot(db, douyin(db), commentsSnap([comment('r1')]), { now: at(T0 + MIN) });
    ingestSnapshot(db, douyin(db), commentsSnap([comment('r1'), comment('r2'), comment('a', { parent: 'r1' })]), { now: at(T0 + 2 * MIN) });
    const sent = await deliverPending(db, { now: at(T0 + 3 * MIN), notify: async () => true });
    assert.deepEqual(sent.batches.map((b) => b.ok), [true]);
    await r.drain();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].ids, ['comment.created:Douyin:a', 'comment.created:Douyin:r2']);

    // 2 小时没回执，麦田重带一次：接收端认出是重复，不再投
    const again = await deliverPending(db, { now: at(T0 + 3 * MIN + 2 * 3600_000 + MIN), notify: async () => true });
    assert.deepEqual(again.batches.map((b) => b.ok), [true]);
    await r.drain();
    assert.equal(calls.length, 1);
    assert.equal(store.stats().total, 2);

    r.stop();
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
    store.close();
    db.close();
  });

  test('接收端停了：麦田记失败并按 1 分钟后重试', async () => {
    const db = freshDb();
    subscribe(db, { subscriberId: SUB, url: 'http://127.0.0.1:9/maitian/hook', types: ['comment.created'] }, { now: at(T0) });
    ingestSnapshot(db, douyin(db), commentsSnap([comment('r1')]), { now: at(T0 + MIN) });
    ingestSnapshot(db, douyin(db), commentsSnap([comment('r1'), comment('r2')]), { now: at(T0 + 2 * MIN) });
    const r = await deliverPending(db, { now: at(T0 + 3 * MIN), notify: async () => true });
    assert.equal(r.batches[0].ok, false);
    const d = db.prepare('SELECT attempts, nextAttemptAt FROM event_deliveries').get();
    assert.equal(d.attempts, 1);
    assert.equal(d.nextAttemptAt, new Date(T0 + 4 * MIN).toISOString());
    db.close();
  });
});
