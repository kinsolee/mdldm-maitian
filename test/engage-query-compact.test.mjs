// compact 模式：get_comment_thread（含 around / n）、list_events、list_comments 的扁平精简形状；不传 compact 时不变。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ingestSnapshot } from '../src/ops/engage/store.mjs';
import * as q from '../src/ops/engage/query.mjs';
import { freshDb, douyin, comment, commentsSnap, conv, dmsSnap, T0, MIN, at } from './helpers/engage-fixtures.mjs';

const KEYS = ['id', 'author', 'isMe', 'replyTo', 'text', 'at', 'depth'];
const ts = (m) => new Date(Date.UTC(2026, 10, 19, 1, m)).toISOString();

// 楼 r1：r1 ← a ← me（回 a），r1 ← b、c、d、e、f、g（按时间）；另一楼 r2
function seeded() {
  const db = freshDb();
  const acc = douyin(db);
  const list = [
    comment('r1', { createdAt: ts(1), text: '一楼正文' }),
    comment('a', { parent: 'r1', root: 'r1', createdAt: ts(2) }),
    comment('me', { parent: 'a', root: 'r1', isMe: true, replyTo: { uid: 'u-a', nickname: '昵称a' }, createdAt: ts(3) }),
    ...['b', 'c', 'd', 'e', 'f', 'g'].map((x, i) => comment(x, { parent: 'r1', root: 'r1', createdAt: ts(4 + i) })),
    comment('r2', { createdAt: ts(20) }),
  ];
  ingestSnapshot(db, acc, commentsSnap([comment('r0', { createdAt: ts(0) })]), { now: at(T0) });
  ingestSnapshot(db, acc, commentsSnap([comment('r0', { createdAt: ts(0) }), ...list]), { now: at(T0 + MIN) });
  ingestSnapshot(db, acc, dmsSnap([conv('k1', { at: ts(29), text: '旧' })]), { now: at(T0 + 2 * MIN) });
  ingestSnapshot(db, acc, dmsSnap([conv('k1', { at: ts(30), text: '私信内容' })]), { now: at(T0 + 3 * MIN) });
  return db;
}

describe('compact', () => {
  test('get_comment_thread：扁平先序、只带 7 个字段、total 和 partial', () => {
    const db = seeded();
    const t = q.getCommentThread(db, 'Douyin:me', { compact: true });
    assert.deepEqual(t.work, { id: 'Douyin:w1', title: '作品一', url: 'https://example.test/w1' });
    assert.equal(t.partial, false);
    assert.equal(t.total, 9);
    assert.equal('root' in t, false);
    assert.deepEqual(t.items.map((c) => c.id), ['r1', 'a', 'me', 'b', 'c', 'd', 'e', 'f', 'g'].map((x) => `Douyin:${x}`));
    for (const c of t.items) assert.deepEqual(Object.keys(c), KEYS);
    assert.deepEqual(t.items[0], { id: 'Douyin:r1', author: '昵称r1', isMe: false, replyTo: null, text: '一楼正文', at: ts(1), depth: 0 });
    assert.deepEqual(t.items[2], { id: 'Douyin:me', author: '昵称me', isMe: true, replyTo: '昵称a', text: '评论me', at: ts(3), depth: 2 });
    assert.equal(JSON.stringify(t).length < JSON.stringify(q.getCommentThread(db, 'Douyin:me')).length / 3, true);
  });

  test('around + n：一楼总在第一条，目标前后各 n 条，omitted 是省掉的条数', () => {
    const db = seeded();
    const t = q.getCommentThread(db, 'Douyin:b', { compact: true, around: 'Douyin:e', n: 1 });
    assert.deepEqual(t.items.map((c) => c.id), ['r1', 'd', 'e', 'f'].map((x) => `Douyin:${x}`));
    assert.equal(t.total, 9);
    assert.equal(t.omitted, 5);
    // 目标靠前时不重复一楼
    assert.deepEqual(q.getCommentThread(db, 'Douyin:b', { compact: true, around: 'Douyin:a', n: 1 }).items.map((c) => c.id), ['Douyin:r1', 'Douyin:a', 'Douyin:me']);
    assert.deepEqual(q.getCommentThread(db, 'Douyin:b', { compact: true, around: 'Douyin:r1', n: 1 }).items.map((c) => c.id), ['Douyin:r1', 'Douyin:a']);
    // 默认 n = 5；目标在末尾
    const d = q.getCommentThread(db, 'Douyin:b', { compact: true, around: 'Douyin:g' });
    assert.deepEqual(d.items.map((c) => c.id), ['r1', 'b', 'c', 'd', 'e', 'f', 'g'].map((x) => `Douyin:${x}`));
    assert.equal(d.omitted, 2);
    assert.throws(() => q.getCommentThread(db, 'Douyin:b', { compact: true, around: 'Douyin:r2' }), /不在这栋楼里/);
    assert.throws(() => q.getCommentThread(db, 'Douyin:b', { around: 'Douyin:e' }), /compact/);
    assert.throws(() => q.getCommentThread(db, 'Douyin:b', { compact: true, around: 'Douyin:e', n: 0 }), /n 要是正整数/);
    assert.throws(() => q.getCommentThread(db, 'Douyin:b', { compact: true, n: 3 }), /n 只能和 around 一起用/);
    // n 比楼长大：全给，omitted 0；n 超过 50 按 50 算
    const big = q.getCommentThread(db, 'Douyin:b', { compact: true, around: 'Douyin:e', n: 999 });
    assert.equal(big.items.length, 9);
    assert.equal(big.omitted, 0);
  });

  test('不传 compact 时形状不变', () => {
    const db = seeded();
    const full = q.getCommentThread(db, 'Douyin:me');
    assert.deepEqual(Object.keys(full), ['work', 'partial', 'root']);
    assert.equal(full.root.children[0].children[0].author.isMe, true);
    assert.equal('likeCount' in q.listComments(db, {}).items[0], true);
    assert.equal('delivery' in q.listEvents(db, {}).items[0], true);
  });

  test('list_comments compact：分页照旧，每条 7 个字段', () => {
    const db = seeded();
    const p1 = q.listComments(db, { compact: true, limit: 3 });
    for (const c of p1.items) assert.deepEqual(Object.keys(c), KEYS);
    assert.deepEqual(p1.items.map((c) => c.id), ['Douyin:r2', 'Douyin:g', 'Douyin:f']);
    const p2 = q.listComments(db, { compact: true, limit: 3, cursor: p1.nextCursor });
    assert.deepEqual(p2.items.map((c) => c.id), ['Douyin:e', 'Douyin:d', 'Douyin:c']);
  });

  test('list_events compact：评论事件补 isMe/replyTo/depth，私信事件带对方昵称和正文', () => {
    const db = seeded();
    const { items } = q.listEvents(db, { compact: true });
    const byId = Object.fromEntries(items.map((e) => [e.id, e]));
    for (const e of items) assert.deepEqual(Object.keys(e), ['id', 'type', 'subjectId', ...KEYS.slice(1)]);
    assert.deepEqual(byId['comment.created:Douyin:me'], undefined); // 我自己写的不出事件
    assert.deepEqual(byId['comment.created:Douyin:a'], {
      id: 'comment.created:Douyin:a', type: 'comment.created', subjectId: 'Douyin:a', author: '昵称a', isMe: false, replyTo: null,
      text: '评论a', at: byId['comment.created:Douyin:a'].at, depth: 1,
    });
    const dm = items.find((e) => e.type === 'dm.received');
    assert.equal(dm.author, '对方k1');
    assert.equal(dm.text, '私信内容');
    assert.equal(dm.depth, null);
  });

  test('一楼缺失、孤儿评论、已删评论', () => {
    const db = freshDb();
    const acc = douyin(db);
    ingestSnapshot(db, acc, commentsSnap([comment('z0', { createdAt: ts(0) })]), { now: at(T0) });
    // x1 的一楼 rx 不在库里；o1 的 parent px 不在库里（挂到一楼 r1）；g1 下一轮被删
    ingestSnapshot(db, acc, commentsSnap([
      comment('z0', { createdAt: ts(0) }),
      comment('x1', { parent: 'rx', root: 'rx', createdAt: ts(1) }),
      comment('r1', { createdAt: ts(2) }),
      comment('o1', { parent: 'px', root: 'r1', createdAt: ts(3) }),
      comment('g1', { parent: 'r1', root: 'r1', createdAt: ts(4) }),
    ]), { now: at(T0 + MIN) });
    const missing = q.getCommentThread(db, 'Douyin:x1', { compact: true, around: 'Douyin:x1', n: 1 });
    assert.equal(missing.partial, true);
    assert.deepEqual(missing.items, [{ id: 'Douyin:rx', missing: true }, { id: 'Douyin:x1', author: '昵称x1', isMe: false, replyTo: null, text: '评论x1', at: ts(1), depth: 1 }]);
    assert.equal(missing.total, 2);
    assert.equal(missing.omitted, 0);
    const orphan = q.getCommentThread(db, 'Douyin:o1', { compact: true });
    assert.equal(orphan.partial, true);
    assert.deepEqual(orphan.items.map((c) => c.id), ['Douyin:r1', 'Douyin:o1', 'Douyin:g1']);
    ingestSnapshot(db, acc, commentsSnap(['z0', 'x1', 'r1', 'o1'].map((x) => comment(x, {
      parent: { x1: 'rx', o1: 'px' }[x], root: { x1: 'rx', o1: 'r1' }[x], createdAt: ts({ z0: 0, x1: 1, r1: 2, o1: 3 }[x]),
    }))), { now: at(T0 + 2 * MIN) });
    assert.equal(q.getCommentThread(db, 'Douyin:r1', { compact: true }).items.find((c) => c.id === 'Douyin:g1').gone, true);
    const listed = q.listComments(db, { compact: true, includeGone: true }).items.find((c) => c.id === 'Douyin:g1');
    assert.deepEqual(Object.keys(listed), [...KEYS, 'gone']);
    assert.equal(q.listComments(db, { compact: true }).items.some((c) => c.id === 'Douyin:g1'), false);
  });

  test('list_events compact：replyTo、一楼 depth 0、分页游标和完整版一致', () => {
    const db = freshDb();
    const acc = douyin(db);
    ingestSnapshot(db, acc, commentsSnap([comment('z0', { createdAt: ts(0) })]), { now: at(T0) });
    ingestSnapshot(db, acc, commentsSnap([
      comment('z0', { createdAt: ts(0) }),
      comment('r1', { createdAt: ts(1) }),
      comment('a', { parent: 'r1', root: 'r1', createdAt: ts(2) }),
      comment('b', { parent: 'a', root: 'r1', replyTo: { uid: 'u-a', nickname: '昵称a' }, createdAt: ts(3) }),
    ]), { now: at(T0 + MIN) });
    const all = q.listEvents(db, { compact: true }).items;
    const byId = Object.fromEntries(all.map((e) => [e.id, e]));
    assert.equal(byId['comment.created:Douyin:r1'].depth, 0);
    assert.equal(byId['comment.created:Douyin:b'].replyTo, '昵称a');
    assert.equal(byId['comment.created:Douyin:b'].depth, 2);
    const p1 = q.listEvents(db, { compact: true, limit: 2 });
    assert.equal(p1.nextCursor, q.listEvents(db, { limit: 2 }).nextCursor);
    const p2 = q.listEvents(db, { compact: true, limit: 2, cursor: p1.nextCursor });
    assert.deepEqual([...p1.items, ...p2.items].map((e) => e.id), all.map((e) => e.id));
  });
});
