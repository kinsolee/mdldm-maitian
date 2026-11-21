// 推送前的确定过滤：self-author、peer-reply 的命中与不命中，自动回执 skipped，不进 unhandled，不推给订阅方。
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ingestSnapshot, insertEvent } from '../src/ops/engage/store.mjs';
import { applyEventFilters, filterRuleFor } from '../src/ops/engage/filter.mjs';
import { listEvents, ackEvent } from '../src/ops/engage/query.mjs';
import { subscribe } from '../src/ops/engage/subscribers.mjs';
import { deliverPending } from '../src/daemon/outbox.mjs';
import { startFakeBot } from './helpers/fake-bot.mjs';
import { freshDb, douyin, comment, commentsSnap, conv, dmsSnap, T0, MIN, at } from './helpers/engage-fixtures.mjs';

let bots = [];
afterEach(async () => { await Promise.all(bots.map((b) => b.close())); bots = []; });

// 第一轮建基线（含一楼 r1 和 Kinso 的一楼 me0），第二轮的新评论出事件
function seed(db, later) {
  const acc = douyin(db);
  const me = { isMe: true, uid: acc.uid, nick: 'Kinso' };
  const base = [comment('r1', { uid: 'u-r1' }), comment('me0', me), comment('kreply', { ...me, parent: 'r1' })];
  ingestSnapshot(db, acc, commentsSnap(base), { now: at(T0) });
  ingestSnapshot(db, acc, commentsSnap([...base, ...later(me, acc)]), { now: at(T0 + MIN) });
  return acc;
}

const ruleOf = (db, nativeId) => filterRuleFor(db, { type: 'comment.created', subjectId: `Douyin:${nativeId}` });

describe('规则', () => {
  test('一楼永远不算 peer-reply', () => {
    const db = freshDb();
    seed(db, () => [comment('top', { uid: 'u-x' })]);
    assert.equal(ruleOf(db, 'top'), null);
  });

  test('楼中楼回 Kinso：父评论是 Kinso 的，不过滤', () => {
    const db = freshDb();
    seed(db, () => [comment('toMe', { parent: 'me0', uid: 'u-x' })]);
    assert.equal(ruleOf(db, 'toMe'), null);
  });

  test('楼中楼回 Kinso：父评论是网友的，但 replyTo 的 uid 是 Kinso，不过滤', (t) => {
    const db = freshDb();
    seed(db, (me, acc) => [comment('toMe2', { parent: 'r1', uid: 'u-x', replyTo: { uid: acc.uid, nickname: 'Kinso' } })]);
    assert.equal(ruleOf(db, 'toMe2'), null);
  });

  test('replyTo 的 uid 是 Kinso 在评论里的 uid（和账号 uid 写法不同）：不过滤', () => {
    const db = freshDb();
    const acc = douyin(db);
    const me = { isMe: true, uid: 'sec-kinso', nick: 'Kinso' };
    const base = [comment('r1', { uid: 'u-r1' }), comment('mine', { ...me, parent: 'r1' })];
    ingestSnapshot(db, acc, commentsSnap(base), { now: at(T0) });
    ingestSnapshot(db, acc, commentsSnap([...base, comment('back', { parent: 'r1', uid: 'u-x', replyTo: { uid: 'sec-kinso', nickname: 'Kinso' } })]), { now: at(T0 + MIN) });
    assert.equal(ruleOf(db, 'back'), null);
  });

  test('楼中楼网友互回：父评论是网友的、没有 replyTo → peer-reply', () => {
    const db = freshDb();
    seed(db, () => [comment('peer', { parent: 'r1', uid: 'u-x' })]);
    assert.equal(ruleOf(db, 'peer'), 'peer-reply');
  });

  test('楼中楼网友互回：replyTo 是另一个网友的 uid → peer-reply', () => {
    const db = freshDb();
    seed(db, () => [comment('peer2', { parent: 'r1', uid: 'u-x', replyTo: { uid: 'u-r1', nickname: '昵称r1' } })]);
    assert.equal(ruleOf(db, 'peer2'), 'peer-reply');
  });

  test('楼中楼在 Kinso 回复过的楼里、但回的是网友：仍是 peer-reply（看直接回复的那条，不看整楼）', () => {
    const db = freshDb();
    seed(db, () => [comment('peer3', { parent: 'r1', uid: 'u-y', replyTo: { uid: 'u-r1', nickname: '昵称r1' } })]);
    assert.equal(ruleOf(db, 'peer3'), 'peer-reply');
  });

  test('拿不准的不过滤：replyTo 只有昵称没有 uid；父评论不在库里；评论行不在库里', () => {
    const db = freshDb();
    seed(db, () => [
      comment('nickOnly', { parent: 'r1', uid: 'u-x', replyTo: { uid: null, nickname: 'Kinso' } }),
      comment('orphan', { parent: 'ghost', root: 'r1', uid: 'u-x' }),
    ]);
    assert.equal(ruleOf(db, 'nickOnly'), null);
    assert.equal(ruleOf(db, 'orphan'), null);
    assert.equal(ruleOf(db, 'nope'), null);
  });

  test('作品的楼中楼拿不全（thread_partial）：不判 peer-reply，照常推', () => {
    const db = freshDb();
    const acc = douyin(db);
    const base = [comment('r1', { uid: 'u-r1' })];
    ingestSnapshot(db, acc, commentsSnap(base), { now: at(T0) });
    // 小红书、视频号在被回复的那条拿不到时会改挂到一楼、清掉 replyTo，库里看起来像网友回网友
    ingestSnapshot(db, acc, commentsSnap([...base, comment('b1', { parent: 'r1', uid: 'u-x' })], { scanned: [{ workNativeId: 'w1', complete: false, threadsPartial: true }] }), { now: at(T0 + MIN) });
    assert.equal(ruleOf(db, 'b1'), null);
  });

  test('self-author：评论作者是本账号', () => {
    const db = freshDb();
    seed(db, () => []);
    assert.equal(ruleOf(db, 'me0'), 'self-author');
    assert.equal(ruleOf(db, 'kreply'), 'self-author');
  });

  test('只管 comment.created：私信事件不过滤', () => {
    const db = freshDb();
    assert.equal(filterRuleFor(db, { type: 'dm.received', subjectId: 'Douyin:c1' }), null);
  });

  test('不看文本：正文是「谢谢」的一楼照常推', () => {
    const db = freshDb();
    seed(db, () => [comment('thanks', { uid: 'u-x', text: '谢谢' })]);
    assert.equal(ruleOf(db, 'thanks'), null);
  });
});

describe('过滤后的事件', () => {
  test('自动回执 skipped、note 写规则名；不进 unhandled；不带 unhandled 时查得到并带 filteredReason', () => {
    const db = freshDb();
    const acc = seed(db, () => [comment('peer', { parent: 'r1', uid: 'u-x' }), comment('toMe', { parent: 'me0', uid: 'u-y' }), comment('top', { uid: 'u-z' })]);
    // 作者是自己的评论入库时不出事件；这里补一条，模拟作者标记后来变了的情况
    insertEvent(db, { id: 'comment.created:Douyin:me0', type: 'comment.created', platformCode: 'Douyin', accountId: acc.id, subjectId: 'Douyin:me0', createdAt: new Date(T0 + MIN).toISOString(), payload: {} });
    const hits = applyEventFilters(db, { now: at(T0 + 2 * MIN) });
    assert.deepEqual(hits.map((h) => [h.eventId, h.rule]).sort(), [['comment.created:Douyin:me0', 'self-author'], ['comment.created:Douyin:peer', 'peer-reply']]);

    const unhandled = listEvents(db, { unhandled: true }).items.map((e) => e.id).sort();
    assert.deepEqual(unhandled, ['comment.created:Douyin:toMe', 'comment.created:Douyin:top']);

    const all = Object.fromEntries(listEvents(db, {}).items.map((e) => [e.id, e]));
    assert.equal(all['comment.created:Douyin:peer'].filteredReason, 'peer-reply');
    assert.deepEqual({ ...all['comment.created:Douyin:peer'].handled, at: null }, { at: null, outcome: 'skipped', actionId: null, note: 'peer-reply' });
    assert.equal(all['comment.created:Douyin:me0'].handled.note, 'self-author');
    assert.equal('filteredReason' in all['comment.created:Douyin:top'], false);
    const compact = Object.fromEntries(listEvents(db, { compact: true }).items.map((e) => [e.id, e]));
    assert.equal(compact['comment.created:Douyin:peer'].filteredReason, 'peer-reply');
    assert.equal('filteredReason' in compact['comment.created:Douyin:top'], false);

    // 再跑一遍什么都不做
    assert.deepEqual(applyEventFilters(db, { now: at(T0 + 3 * MIN) }), []);
  });

  test('已经送达过订阅方的事件不再补过滤；已回执的不动', () => {
    const db = freshDb();
    seed(db, () => [comment('peer', { parent: 'r1', uid: 'u-x' }), comment('peer2', { parent: 'r1', uid: 'u-y' })]);
    db.prepare("INSERT INTO event_deliveries (eventId, subscriberId, attempts, deliveredAt) VALUES ('comment.created:Douyin:peer', 'bot-a', 1, ?)").run(new Date(T0).toISOString());
    ackEvent(db, 'comment.created:Douyin:peer2', 'pending_human', '人看', { now: at(T0 + MIN) });
    assert.deepEqual(applyEventFilters(db, { now: at(T0 + 2 * MIN) }), []);
  });

  test('推送失败停了自动重试、之后被过滤自动回执的：不再发「推送失败」提醒', async () => {
    const db = freshDb();
    subscribe(db, { subscriberId: 'bot-a', url: 'http://127.0.0.1:9/maitian/hook', types: ['comment.created'] }, { now: at(T0 - MIN) });
    seed(db, () => [comment('peer', { parent: 'r1', uid: 'u-x' })]);
    // 模拟：过滤上线前这条已经推送失败、停了自动重试，提醒还没发出去
    db.prepare("INSERT INTO event_deliveries (eventId, subscriberId, attempts, gaveUpAt, lastError) VALUES ('comment.created:Douyin:peer', 'bot-a', 4, ?, 'HTTP 500')").run(new Date(T0).toISOString());
    const sent = [];
    const r = await deliverPending(db, { now: at(T0 + 2 * MIN), notify: async (t) => { sent.push(t); return true; }, fetchImpl: async () => new Response('{}') });
    assert.deepEqual(r.filtered.map((f) => f.rule), ['peer-reply']);
    assert.ok(!sent.some((t) => t.includes('推送失败')), sent.join('\n'));
  });

  test('deliverPending：被过滤的不推，没命中的照常推、形状不变', async () => {
    const db = freshDb();
    const bot = await startFakeBot({ mode: 'ok' });
    bots.push(bot);
    bot.secret = subscribe(db, { subscriberId: 'bot-a', url: bot.url, types: ['comment.created', 'dm.received'] }, { now: at(T0 - MIN) }).secret;
    const acc = seed(db, () => [comment('peer', { parent: 'r1', uid: 'u-x' }), comment('toMe', { parent: 'me0', uid: 'u-y' })]);
    ingestSnapshot(db, acc, dmsSnap([conv('c1')]), { now: at(T0) });
    ingestSnapshot(db, acc, dmsSnap([conv('c1', { at: '2026-11-19T03:00:00.000Z', text: '在吗' })]), { now: at(T0 + MIN) });
    const r = await deliverPending(db, { now: at(T0 + 2 * MIN), notify: async () => true });
    assert.deepEqual(r.filtered, [{ eventId: 'comment.created:Douyin:peer', rule: 'peer-reply' }]);
    const pushed = bot.received.flatMap((x) => x.body.events);
    assert.deepEqual(pushed.map((e) => e.id).sort(), ['comment.created:Douyin:toMe', 'dm.received:Douyin:c1:2026-11-19T03:00:00.000Z']);
    assert.deepEqual(Object.keys(pushed[0]).sort(), ['accountId', 'createdAt', 'delivery', 'handled', 'id', 'payload', 'platform', 'subjectId', 'type']);
    assert.equal(db.prepare("SELECT count(*) n FROM event_deliveries WHERE eventId = 'comment.created:Douyin:peer'").get().n, 0);
  });
});
