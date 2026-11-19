// 发件箱：合批 ≤20、签名可验、1/5/15 分钟重试、重试用完发一次飞书、2 小时没回执重带并只提醒一次、401 算失败。
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { insertEvent } from '../src/ops/engage/store.mjs';
import { subscribe, unsubscribe } from '../src/ops/engage/subscribers.mjs';
import { ackEvent } from '../src/ops/engage/query.mjs';
import { deliverPending, RETRY_DELAYS_MS } from '../src/daemon/outbox.mjs';
import { startFakeBot, verify } from './helpers/fake-bot.mjs';
import { freshDb, T0, MIN, at } from './helpers/engage-fixtures.mjs';

let bots = [];
afterEach(async () => { await Promise.all(bots.map((b) => b.close())); bots = []; });

async function setup({ mode = 'ok', types = ['comment.created'], platforms, onBatch } = {}) {
  const db = freshDb();
  const bot = await startFakeBot({ mode, onBatch });
  bots.push(bot);
  const { secret } = subscribe(db, { subscriberId: 'bot-a', url: bot.url, types, platforms }, { now: at(T0) });
  bot.secret = secret;
  return { db, bot, secret };
}

function addEvents(db, n, { type = 'comment.created', platformCode = 'Douyin', t = T0 + MIN, tag = 'c' } = {}) {
  for (let i = 0; i < n; i++) {
    const id = `${type}:${platformCode}:${tag}${String(i).padStart(3, '0')}`;
    insertEvent(db, { id, type, platformCode, accountId: `${platformCode}:1`, subjectId: `${platformCode}:c${i}`, createdAt: new Date(t + i).toISOString(), payload: { text: `第${i}条` } });
  }
}

function fakeNotify() {
  const sent = [];
  return { sent, notify: async (text) => { sent.push(text); return true; } };
}

const deliveries = (db) => db.prepare('SELECT * FROM event_deliveries ORDER BY eventId').all();

describe('合批与签名', () => {
  test('45 条按 createdAt 分成 20、20、5 三批；签名、时间戳、批次头可验；body 结构对', async () => {
    const { db, bot, secret } = await setup();
    addEvents(db, 45);
    addEvents(db, 3, { type: 'dm.received' });   // 没订阅的类型不推
    const r = await deliverPending(db, { now: at(T0 + 2 * MIN), notify: fakeNotify().notify });
    assert.deepEqual(r.batches.map((b) => [b.size, b.ok]), [[20, true], [20, true], [5, true]]);
    assert.deepEqual(bot.received.map((x) => x.body.events.length), [20, 20, 5]);
    const ids = bot.received.flatMap((x) => x.body.events.map((e) => e.id));
    assert.deepEqual(ids, [...ids].sort());
    const first = bot.received[0];
    assert.ok(verify(secret, first.raw, first.headers['x-maitian-signature']));
    assert.equal(first.headers['content-type'], 'application/json');
    assert.equal(first.headers['x-maitian-batch'], first.body.batchId);
    assert.equal(first.headers['x-maitian-timestamp'], first.body.sentAt);
    assert.equal(first.body.subscriberId, 'bot-a');
    const e = first.body.events[0];
    assert.deepEqual(Object.keys(e).sort(), ['accountId', 'createdAt', 'delivery', 'handled', 'id', 'payload', 'platform', 'subjectId', 'type']);
    assert.deepEqual(e.delivery, { attempts: 1, lastAttemptAt: first.body.sentAt, deliveredAt: null });
    assert.equal(e.handled, null);
    assert.ok(deliveries(db).every((d) => d.deliveredAt && d.attempts === 1));
    // 已送达的不再推
    assert.deepEqual((await deliverPending(db, { now: at(T0 + 3 * MIN), notify: fakeNotify().notify })).batches, []);
  });

  test('平台过滤；订阅之前的事件不推；退订后不推；已回执的不推', async () => {
    const { db, bot } = await setup({ platforms: ['Bili'] });
    addEvents(db, 2, { t: T0 - MIN, platformCode: 'Bili', tag: 'old' });   // 订阅之前
    addEvents(db, 2, { platformCode: 'Douyin' });
    addEvents(db, 2, { platformCode: 'Bili' });
    ackEvent(db, 'comment.created:Bili:c001', 'skipped');
    await deliverPending(db, { now: at(T0 + 2 * MIN), notify: fakeNotify().notify });
    assert.deepEqual(bot.received.flatMap((x) => x.body.events.map((e) => e.id)), ['comment.created:Bili:c000']);
    unsubscribe(db, 'bot-a');
    insertEvent(db, { id: 'comment.created:Bili:late', type: 'comment.created', platformCode: 'Bili', accountId: 'Bili:1', subjectId: 'Bili:late', createdAt: new Date(T0 + 5 * MIN).toISOString(), payload: {} });
    await deliverPending(db, { now: at(T0 + 6 * MIN), notify: fakeNotify().notify });
    assert.equal(bot.received.length, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM events WHERE id = 'comment.created:Bili:late'").get().n, 1);   // 留在库里
  });

  test('验签失败的 bot 返回 401，算失败', async () => {
    const { db, bot } = await setup();
    bot.secret = 'f'.repeat(64);
    addEvents(db, 1);
    const r = await deliverPending(db, { now: at(T0 + 2 * MIN), notify: fakeNotify().notify });
    assert.equal(r.batches[0].ok, false);
    assert.equal(r.batches[0].error, 'HTTP 401');
    assert.equal(bot.rejected, 1);
    const d = deliveries(db)[0];
    assert.equal(d.deliveredAt, null);
    assert.equal(d.attempts, 1);
  });
});

describe('重试', () => {
  test('按 1、5、15 分钟重试；第 3 次重试仍失败发一次飞书，之后不再自动重试；重新登记后恢复', async () => {
    const { db, bot } = await setup({ mode: 'fail' });
    addEvents(db, 2);
    const { sent, notify } = fakeNotify();
    assert.deepEqual(RETRY_DELAYS_MS, [MIN, 5 * MIN, 15 * MIN]);
    let t = T0 + 2 * MIN;
    await deliverPending(db, { now: at(t), notify });
    assert.equal(deliveries(db)[0].nextAttemptAt, new Date(t + MIN).toISOString());
    await deliverPending(db, { now: at(t + 30_000), notify });   // 没到点
    assert.equal(bot.received.length, 1);
    t += MIN; await deliverPending(db, { now: at(t), notify });
    assert.equal(deliveries(db)[0].nextAttemptAt, new Date(t + 5 * MIN).toISOString());
    t += 5 * MIN; await deliverPending(db, { now: at(t), notify });
    assert.equal(deliveries(db)[0].nextAttemptAt, new Date(t + 15 * MIN).toISOString());
    assert.equal(sent.length, 0);
    t += 15 * MIN; const r = await deliverPending(db, { now: at(t), notify });
    assert.equal(bot.received.length, 4);
    assert.ok(deliveries(db).every((d) => d.attempts === 4 && d.gaveUpAt && d.nextAttemptAt === null));
    assert.equal(sent.length, 1);
    assert.equal(r.alerts, 1);
    assert.match(sent[0], /bot-a/);
    assert.match(sent[0], /2 条/);
    assert.match(sent[0], /HTTP 500/);
    assert.doesNotMatch(sent[0], /should-not-leak|token=/);
    assert.doesNotMatch(sent[0], new RegExp(bot.secret));
    // 之后不再自动重试，也不再提醒
    await deliverPending(db, { now: at(t + 3600_000), notify });
    assert.equal(bot.received.length, 4);
    assert.equal(sent.length, 1);
    // bot 修好后重新登记：恢复推送
    bot.mode = 'ok';
    subscribe(db, { subscriberId: 'bot-a', url: bot.url, types: ['comment.created'] }, { now: at(t + 3600_000) });
    await deliverPending(db, { now: at(t + 3600_000 + 1), notify });
    assert.equal(bot.received.at(-1).body.events.length, 2);
    assert.ok(deliveries(db).every((d) => d.deliveredAt));
  });

  test('飞书没真发出：下一轮再发，发出后不再发', async () => {
    const { db } = await setup({ mode: 'fail' });
    addEvents(db, 1);
    let t = T0 + 2 * MIN;
    const calls = [];
    let ok = false;
    const notify = async (text) => { calls.push(text); return ok; };
    for (const d of [0, MIN, 5 * MIN, 15 * MIN]) await deliverPending(db, { now: at((t += d)), notify });
    assert.equal(calls.length, 1);
    ok = true;
    await deliverPending(db, { now: at(t + MIN), notify });
    await deliverPending(db, { now: at(t + 2 * MIN), notify });
    assert.equal(calls.length, 2);
  });

  test('超时算失败（注入短超时，不真等 30 秒）', async () => {
    const { db } = await setup({ mode: 'hang' });
    addEvents(db, 1);
    const r = await deliverPending(db, { now: at(T0 + 2 * MIN), notify: fakeNotify().notify, timeoutMs: 150 });
    assert.equal(r.batches[0].ok, false);
    assert.match(r.batches[0].error, /超时/);
  });

  test('连不上算失败', async () => {
    const db = freshDb();
    subscribe(db, { subscriberId: 'gone', url: 'http://127.0.0.1:9/hook', types: ['comment.created'] }, { now: at(T0) });
    addEvents(db, 1);
    const r = await deliverPending(db, { now: at(T0 + 2 * MIN), notify: fakeNotify().notify });
    assert.equal(r.batches[0].ok, false);
    assert.match(r.batches[0].error, /连不上/);
  });
});

describe('回执', () => {
  test('2 小时没回执：下一批重带一次（redeliveredAt），每个事件只提醒一次；回执了的不带', async () => {
    const { db, bot } = await setup({ onBatch: () => {} });
    addEvents(db, 3);
    const { sent, notify } = fakeNotify();
    await deliverPending(db, { now: at(T0 + 2 * MIN), notify });
    ackEvent(db, 'comment.created:Douyin:c000', 'replied');
    await deliverPending(db, { now: at(T0 + 60 * MIN), notify });
    assert.equal(bot.received.length, 1);
    const t2 = T0 + 2 * MIN + 2 * 3600_000;
    await deliverPending(db, { now: at(t2), notify });
    assert.equal(bot.received.length, 2);
    const re = bot.received[1].body.events;
    assert.deepEqual(re.map((e) => e.id), ['comment.created:Douyin:c001', 'comment.created:Douyin:c002']);
    assert.equal(re[0].delivery.attempts, 1);
    assert.ok(re[0].delivery.deliveredAt);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /2 条/);
    assert.ok(deliveries(db).filter((d) => d.eventId !== 'comment.created:Douyin:c000').every((d) => d.redeliveredAt && d.remindedAt));
    await deliverPending(db, { now: at(t2 + 3 * 3600_000), notify });
    assert.equal(bot.received.length, 2);
    assert.equal(sent.length, 1);
  });

  test('bot 收到后调 ackEvent 回执', async () => {
    let db;
    const s = await setup({ onBatch: (body) => { for (const e of body.events) ackEvent(db, e.id, 'pending_human', '待确认'); } });
    db = s.db;
    addEvents(db, 2);
    await deliverPending(db, { now: at(T0 + 2 * MIN), notify: fakeNotify().notify });
    assert.equal(db.prepare("SELECT count(*) n FROM events WHERE handledOutcome = 'pending_human'").get().n, 2);
  });
});
