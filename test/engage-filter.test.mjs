// 推送前的确定过滤：仅保留 self-author 的命中与不命中，自动回执 skipped，不进 unhandled，不推给订阅方；楼中楼网友互回照常推。
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ingestSnapshot, insertEvent } from '../src/ops/engage/store.mjs';
import { FILTER_RULES, applyEventFilters, filterRuleFor } from '../src/ops/engage/filter.mjs';
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
  test('FILTER_RULES 仅包含 self-author', () => {
    assert.deepEqual(FILTER_RULES, ['self-author']);
  });

  test('depth = 0 一楼评论不过滤', () => {
    const db = freshDb();
    seed(db, () => [comment('top', { uid: 'u-x' })]);
    assert.equal(ruleOf(db, 'top'), null);
  });

  test('楼中楼回 Kinso：父评论是 Kinso 的，或 replyTo 指向 Kinso，不过滤', () => {
    const db = freshDb();
    seed(db, (me, acc) => [
      comment('toMe', { parent: 'me0', uid: 'u-x' }),
      comment('toMe2', { parent: 'r1', uid: 'u-x', replyTo: { uid: acc.uid, nickname: 'Kinso' } }),
    ]);
    assert.equal(ruleOf(db, 'toMe'), null);
    assert.equal(ruleOf(db, 'toMe2'), null);
  });

  test('depth = 1 挂网友一楼且 replyTo 为空：不过滤（不再按 peer-reply 过滤）', () => {
    const db = freshDb();
    seed(db, () => [comment('peer', { parent: 'r1', uid: 'u-x' })]);
    assert.equal(db.prepare("SELECT depth FROM comments WHERE id = 'Douyin:peer'").get().depth, 1);
    assert.equal(ruleOf(db, 'peer'), null);
  });

  test('depth ≥ 2 带另一个网友的 replyToUid：不过滤', () => {
    const db = freshDb();
    seed(db, () => [
      comment('peer', { parent: 'r1', uid: 'u-x' }),
      comment('peer2', { parent: 'peer', uid: 'u-y', replyTo: { uid: 'u-x', nickname: '昵称peer' } }),
    ]);
    assert.equal(db.prepare("SELECT depth FROM comments WHERE id = 'Douyin:peer2'").get().depth, 2);
    assert.equal(ruleOf(db, 'peer2'), null);
  });

  test('缺行或孤儿评论：不过滤', () => {
    const db = freshDb();
    seed(db, () => [
      comment('nickOnly', { parent: 'r1', uid: 'u-x', replyTo: { uid: null, nickname: 'Kinso' } }),
      comment('orphan', { parent: 'ghost', root: 'r1', uid: 'u-x' }),
    ]);
    assert.equal(ruleOf(db, 'nickOnly'), null);
    assert.equal(ruleOf(db, 'orphan'), null);
    assert.equal(ruleOf(db, 'nope'), null);
  });

  test('作品的楼中楼拿不全（thread_partial）：不过滤，照常推', () => {
    const db = freshDb();
    const acc = douyin(db);
    const base = [comment('r1', { uid: 'u-r1' })];
    ingestSnapshot(db, acc, commentsSnap(base), { now: at(T0) });
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
  test('self-author 自动回执 skipped、note 写规则名；不进 unhandled；完整版与 compact 版可见；重复运行幂等', () => {
    const db = freshDb();
    const acc = seed(db, () => [comment('peer', { parent: 'r1', uid: 'u-x' }), comment('toMe', { parent: 'me0', uid: 'u-y' }), comment('top', { uid: 'u-z' })]);
    // 作者是自己的评论入库时不出事件；这里补一条，模拟作者标记后来变了的情况
    insertEvent(db, { id: 'comment.created:Douyin:me0', type: 'comment.created', platformCode: 'Douyin', accountId: acc.id, subjectId: 'Douyin:me0', createdAt: new Date(T0 + MIN).toISOString(), payload: {} });
    const hits = applyEventFilters(db, { now: at(T0 + 2 * MIN) });
    assert.deepEqual(hits.map((h) => [h.eventId, h.rule]), [['comment.created:Douyin:me0', 'self-author']]);

    const unhandled = listEvents(db, { unhandled: true }).items.map((e) => e.id).sort();
    assert.deepEqual(unhandled, ['comment.created:Douyin:peer', 'comment.created:Douyin:toMe', 'comment.created:Douyin:top']);

    const all = Object.fromEntries(listEvents(db, {}).items.map((e) => [e.id, e]));
    assert.equal(all['comment.created:Douyin:me0'].filteredReason, 'self-author');
    assert.deepEqual({ ...all['comment.created:Douyin:me0'].handled, at: null }, { at: null, outcome: 'skipped', actionId: null, note: 'self-author' });
    assert.equal('filteredReason' in all['comment.created:Douyin:peer'], false);
    assert.equal('filteredReason' in all['comment.created:Douyin:top'], false);
    const compact = Object.fromEntries(listEvents(db, { compact: true }).items.map((e) => [e.id, e]));
    assert.equal(compact['comment.created:Douyin:me0'].filteredReason, 'self-author');
    assert.equal('filteredReason' in compact['comment.created:Douyin:peer'], false);
    assert.equal('filteredReason' in compact['comment.created:Douyin:top'], false);

    // 再跑一遍什么都不做
    assert.deepEqual(applyEventFilters(db, { now: at(T0 + 3 * MIN) }), []);
  });

  test('已经送达过订阅方的事件不再补过滤；已回执的不动', () => {
    const db = freshDb();
    const acc = seed(db, () => []);
    insertEvent(db, { id: 'comment.created:Douyin:me0', type: 'comment.created', platformCode: 'Douyin', accountId: acc.id, subjectId: 'Douyin:me0', createdAt: new Date(T0 + MIN).toISOString(), payload: {} });
    insertEvent(db, { id: 'comment.created:Douyin:kreply', type: 'comment.created', platformCode: 'Douyin', accountId: acc.id, subjectId: 'Douyin:kreply', createdAt: new Date(T0 + MIN).toISOString(), payload: {} });
    db.prepare("INSERT INTO event_deliveries (eventId, subscriberId, attempts, deliveredAt) VALUES ('comment.created:Douyin:me0', 'bot-a', 1, ?)").run(new Date(T0).toISOString());
    ackEvent(db, 'comment.created:Douyin:kreply', 'pending_human', '人看', { now: at(T0 + MIN) });
    assert.deepEqual(applyEventFilters(db, { now: at(T0 + 2 * MIN) }), []);
  });

  test('推送失败停了自动重试、之后被过滤自动回执的：不再发「推送失败」提醒', async () => {
    const db = freshDb();
    subscribe(db, { subscriberId: 'bot-a', url: 'http://127.0.0.1:9/maitian/hook', types: ['comment.created'] }, { now: at(T0 - MIN) });
    const acc = seed(db, () => []);
    insertEvent(db, { id: 'comment.created:Douyin:me0', type: 'comment.created', platformCode: 'Douyin', accountId: acc.id, subjectId: 'Douyin:me0', createdAt: new Date(T0 + MIN).toISOString(), payload: {} });
    // 模拟：这条之前推送失败、停了自动重试，提醒还没发出去，后来评论标记为本账号自己写的
    db.prepare("INSERT INTO event_deliveries (eventId, subscriberId, attempts, gaveUpAt, lastError) VALUES ('comment.created:Douyin:me0', 'bot-a', 4, ?, 'HTTP 500')").run(new Date(T0).toISOString());
    const sent = [];
    const r = await deliverPending(db, { now: at(T0 + 2 * MIN), notify: async (t) => { sent.push(t); return true; }, fetchImpl: async () => new Response('{}') });
    assert.deepEqual(r.filtered.map((f) => f.rule), ['self-author']);
    assert.ok(!sent.some((t) => t.includes('推送失败')), sent.join('\n'));
  });

  test('deliverPending：self-author 不推，网友回网友的楼中楼和其余事件照常推、形状不变', async () => {
    const db = freshDb();
    const bot = await startFakeBot({ mode: 'ok' });
    bots.push(bot);
    bot.secret = subscribe(db, { subscriberId: 'bot-a', url: bot.url, types: ['comment.created', 'dm.received'] }, { now: at(T0 - MIN) }).secret;
    const acc = seed(db, () => [comment('peer', { parent: 'r1', uid: 'u-x' }), comment('toMe', { parent: 'me0', uid: 'u-y' })]);
    insertEvent(db, { id: 'comment.created:Douyin:me0', type: 'comment.created', platformCode: 'Douyin', accountId: acc.id, subjectId: 'Douyin:me0', createdAt: new Date(T0 + MIN).toISOString(), payload: {} });
    ingestSnapshot(db, acc, dmsSnap([conv('c1')]), { now: at(T0) });
    ingestSnapshot(db, acc, dmsSnap([conv('c1', { at: '2026-11-19T03:00:00.000Z', text: '在吗' })]), { now: at(T0 + MIN) });
    const r = await deliverPending(db, { now: at(T0 + 2 * MIN), notify: async () => true });
    assert.deepEqual(r.filtered, [{ eventId: 'comment.created:Douyin:me0', rule: 'self-author' }]);
    const pushed = bot.received.flatMap((x) => x.body.events);
    assert.deepEqual(pushed.map((e) => e.id).sort(), ['comment.created:Douyin:peer', 'comment.created:Douyin:toMe', 'dm.received:Douyin:c1:2026-11-19T03:00:00.000Z']);
    assert.deepEqual(Object.keys(pushed[0]).sort(), ['accountId', 'createdAt', 'delivery', 'handled', 'id', 'payload', 'platform', 'subjectId', 'type']);
    assert.equal(db.prepare("SELECT count(*) n FROM event_deliveries WHERE eventId = 'comment.created:Douyin:me0'").get().n, 0);
  });
});
