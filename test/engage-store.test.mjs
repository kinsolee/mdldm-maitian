// 入库与出事件：两轮 ingest、重放、重开库、首轮不出事件、goneAt、楼中楼树。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openOpsDb } from '../src/ops/db.mjs';
import { ingestSnapshot } from '../src/ops/engage/store.mjs';
import { freshDb, douyin, tmpDbFile, comment, commentsSnap, conv, dmsSnap, T0, MIN, at } from './helpers/engage-fixtures.mjs';

const rows = (db, sql, ...a) => db.prepare(sql).all(...a);
const one = (db, sql, ...a) => db.prepare(sql).get(...a);

describe('评论入库与 comment.created', () => {
  test('账号首轮只入库不出事件；第二轮只对新增、不是我写的出事件', () => {
    const db = freshDb();
    const a = douyin(db);
    const r1 = ingestSnapshot(db, a, commentsSnap([comment('c1'), comment('c2')]), { now: at(T0) });
    assert.equal(r1.inserted, 3);   // 1 作品 + 2 评论
    assert.deepEqual(r1.events, []);
    assert.equal(one(db, 'SELECT count(*) n FROM events').n, 0);

    const r2 = ingestSnapshot(db, a, commentsSnap([comment('c1', { likeCount: 5 }), comment('c2'), comment('c3'), comment('c4', { isMe: true, parent: 'c3', root: 'c3' })]), { now: at(T0 + 15 * MIN) });
    assert.deepEqual(r2.events, ['comment.created:Douyin:c3']);
    assert.equal(r2.inserted, 2);
    const ev = one(db, 'SELECT * FROM events');
    assert.equal(ev.type, 'comment.created');
    assert.equal(ev.subjectId, 'Douyin:c3');
    assert.equal(ev.accountId, 'Douyin:106707338905');
    assert.deepEqual(JSON.parse(ev.payload), { workId: 'Douyin:w1', workTitle: '作品一', workUrl: 'https://example.test/w1', commentId: 'Douyin:c3', rootId: 'Douyin:c3', parentId: null, nickname: '昵称c3', text: '评论c3' });
    const c1 = one(db, "SELECT * FROM comments WHERE id = 'Douyin:c1'");
    assert.equal(c1.likeCount, 5);
    assert.equal(c1.firstSeenAt, new Date(T0).toISOString());
    assert.equal(c1.lastSeenAt, new Date(T0 + 15 * MIN).toISOString());
  });

  test('重放同一轮、重开库都不重复出事件', () => {
    const file = tmpDbFile();
    let db = freshDb(file);
    ingestSnapshot(db, douyin(db), commentsSnap([comment('c1')]), { now: at(T0) });
    const snap = commentsSnap([comment('c1'), comment('c2')]);
    assert.equal(ingestSnapshot(db, douyin(db), snap, { now: at(T0 + MIN) }).events.length, 1);
    assert.deepEqual(ingestSnapshot(db, douyin(db), snap, { now: at(T0 + 2 * MIN) }).events, []);
    db.close();
    db = openOpsDb(file);   // 模拟守护进程重启
    assert.deepEqual(ingestSnapshot(db, douyin(db), snap, { now: at(T0 + 3 * MIN) }).events, []);
    assert.equal(one(db, 'SELECT count(*) n FROM events').n, 1);
    assert.equal(one(db, 'SELECT count(*) n FROM comments').n, 2);
  });

  test('payload 原话截前 200 字', () => {
    const db = freshDb();
    ingestSnapshot(db, douyin(db), commentsSnap([comment('c1')]), { now: at(T0) });
    ingestSnapshot(db, douyin(db), commentsSnap([comment('c1'), comment('c2', { text: '长'.repeat(300) })]), { now: at(T0 + MIN) });
    assert.equal(JSON.parse(one(db, 'SELECT payload FROM events').payload).text.length, 200);
  });

  test('失败的快照不入库，直接报错', () => {
    const db = freshDb();
    assert.throws(() => ingestSnapshot(db, douyin(db), { ok: false, reason: 'timeout' }, { now: at(T0) }), /ok/);
  });
});

describe('goneAt', () => {
  test('complete 作品里消失的评论标 gone 不删；再出现清掉 goneAt；incomplete 不标', () => {
    const db = freshDb();
    const a = douyin(db);
    const works = [{ nativeId: 'w1', title: 'A', url: null, postTime: null }, { nativeId: 'w2', title: 'B', url: null, postTime: null }];
    ingestSnapshot(db, a, commentsSnap([comment('c1'), comment('c2'), comment('d1', { work: 'w2' })], { works }), { now: at(T0) });
    const r = ingestSnapshot(db, a, commentsSnap([comment('c1')], { works, scanned: [{ workNativeId: 'w1', complete: true, threadsPartial: false }, { workNativeId: 'w2', complete: false, threadsPartial: false }] }), { now: at(T0 + MIN) });
    assert.equal(r.gone, 1);
    assert.equal(one(db, "SELECT goneAt FROM comments WHERE id = 'Douyin:c2'").goneAt, new Date(T0 + MIN).toISOString());
    assert.equal(one(db, "SELECT goneAt FROM comments WHERE id = 'Douyin:d1'").goneAt, null);
    assert.equal(one(db, 'SELECT count(*) n FROM comments').n, 3);
    ingestSnapshot(db, a, commentsSnap([comment('c1'), comment('c2')], { works }), { now: at(T0 + 2 * MIN) });
    assert.equal(one(db, "SELECT goneAt FROM comments WHERE id = 'Douyin:c2'").goneAt, null);
  });
});

describe('楼中楼', () => {
  test('多层：rootId、depth 按 parent 链算；乱序也对；parent 不在本轮也不在库里时按 rootNativeId 挂、depth 1', () => {
    const db = freshDb();
    ingestSnapshot(db, douyin(db), commentsSnap([
      comment('r3', { parent: 'r2' }), comment('r1'), comment('r2', { parent: 'r1' }),
      comment('x2', { parent: 'missing', root: 'x1' }),
    ]), { now: at(T0) });
    const got = Object.fromEntries(rows(db, 'SELECT id, parentId, rootId, depth FROM comments').map((r) => [r.id, [r.parentId, r.rootId, r.depth]]));
    assert.deepEqual(got, {
      'Douyin:r1': [null, 'Douyin:r1', 0],
      'Douyin:r2': ['Douyin:r1', 'Douyin:r1', 1],
      'Douyin:r3': ['Douyin:r2', 'Douyin:r1', 2],
      'Douyin:x2': ['Douyin:missing', 'Douyin:x1', 1],
    });
  });

  test('parent 在库里不在本轮：接着库里的 depth 和 rootId', () => {
    const db = freshDb();
    ingestSnapshot(db, douyin(db), commentsSnap([comment('r1'), comment('r2', { parent: 'r1' })]), { now: at(T0) });
    ingestSnapshot(db, douyin(db), commentsSnap([comment('r3', { parent: 'r2', root: 'r1' })], { scanned: [{ workNativeId: 'w1', complete: false, threadsPartial: false }] }), { now: at(T0 + MIN) });
    const r3 = one(db, "SELECT rootId, depth FROM comments WHERE id = 'Douyin:r3'");
    assert.deepEqual({ ...r3 }, { rootId: 'Douyin:r1', depth: 2 });
  });

  test('threadsPartial 记进 thread_partial', () => {
    const db = freshDb();
    ingestSnapshot(db, douyin(db), commentsSnap([comment('c1')], { scanned: [{ workNativeId: 'w1', complete: true, threadsPartial: true }] }), { now: at(T0) });
    assert.equal(one(db, "SELECT partial FROM thread_partial WHERE workId = 'Douyin:w1'").partial, 1);
  });
});

describe('私信与 dm.received', () => {
  test('首轮不出；对方新说一句出一次；我说的、没变的不出；新会话出', () => {
    const db = freshDb();
    const a = douyin(db);
    assert.deepEqual(ingestSnapshot(db, a, dmsSnap([conv('k1')]), { now: at(T0) }).events, []);
    assert.deepEqual(ingestSnapshot(db, a, dmsSnap([conv('k1')]), { now: at(T0 + MIN) }).events, []);
    const r = ingestSnapshot(db, a, dmsSnap([
      conv('k1', { at: '2026-11-19T01:30:00.000Z', text: '在吗'.repeat(150) }),
      conv('k2', { by: 'me' }), conv('k3', { nick: '新朋友' }),
    ], [{ nativeId: 'm1', conversationNativeId: 'k1', by: 'peer', at: '2026-11-19T01:30:00.000Z', type: 'text', text: '在吗' }]), { now: at(T0 + 2 * MIN) });
    assert.deepEqual(r.events.sort(), ['dm.received:Douyin:k1:2026-11-19T01:30:00.000Z', 'dm.received:Douyin:k3:2026-11-19T01:00:00.000Z']);
    const p = JSON.parse(one(db, "SELECT payload FROM events WHERE subjectId = 'Douyin:k1'").payload);
    assert.equal(p.conversationId, 'Douyin:k1');
    assert.equal(p.nickname, '对方k1');
    assert.equal(p.text.length, 200);
    assert.equal(one(db, "SELECT count(*) n FROM messages WHERE conversationId = 'Douyin:k1'").n, 1);
    // 我回了以后对方没再说：不出
    assert.deepEqual(ingestSnapshot(db, a, dmsSnap([conv('k1', { by: 'me', at: '2026-11-19T01:40:00.000Z' })]), { now: at(T0 + 3 * MIN) }).events, []);
  });
});

// S3（KIN-328）的 works 表先建好的库（生产 ops.db 就是这样）：评论入库照常，S3 的 works 不被改动
import { test as s3test } from 'node:test';
s3test('ops.db 里已有 S3 的 works 表：评论入库照常，S3 的 works 不受影响', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { ensureWorksTables } = await import('../src/ops/works-db.mjs');
  const { openOpsDb } = await import('../src/ops/db.mjs');
  const { ingestSnapshot: ingest } = await import('../src/ops/engage/store.mjs');
  const { listComments, getCommentThread } = await import('../src/ops/engage/query.mjs');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kin323-s3-')), 'ops.db');
  const pre = new DatabaseSync(file); ensureWorksTables(pre);
  pre.prepare("INSERT INTO works (platformCode, uid, postId, record, postTime, firstSeenAt, lastSeenAt, lastRunId) VALUES ('Bili','1','BV1','{}',NULL,'t','t','r')").run(); pre.close();
  const db = openOpsDb(file);
  db.prepare("INSERT OR IGNORE INTO accounts (platformCode, platformName, uid, spaceName, capabilities) VALUES ('Bili','B站','1','kinso/Bili/1','{}')").run();
  const { getAccount } = await import('../src/ops/accounts.mjs');
  const account = getAccount(db, 'Bili:1');
  const snap = { ok: true, platformCode: 'Bili', accountUid: '1', kind: 'comments', fetchedAt: '2026-11-19T00:00:00.000Z',
    works: [{ nativeId: 'BV1', title: '作品', url: null, postTime: null }],
    comments: [{ nativeId: 'c1', workNativeId: 'BV1', parentNativeId: null, rootNativeId: 'c1', author: { uid: '9', nickname: 'x', isMe: false }, replyTo: null,
      text: 't', createdAt: '2026-11-19T00:00:00.000Z', likeCount: 0, likedByMe: null, pinned: null, replyCount: 0, ipLabel: null }],
    scannedWorks: [{ workNativeId: 'BV1', complete: true, threadsPartial: false }], conversations: [], messages: [] };
  ingest(db, account, snap, { now: () => Date.parse('2026-11-19T00:00:00Z') });
  const rows = listComments(db, {}).items ?? listComments(db, {});
  const list = Array.isArray(rows) ? rows : rows.comments;
  if (!list?.length) throw new Error('评论没入库');
  const t = getCommentThread(db, 'Bili:c1');
  if (!t) throw new Error('取不到楼');
  const s3 = db.prepare('SELECT count(*) n FROM works').get().n;
  if (s3 !== 1) throw new Error(`S3 works 行数变了：${s3}`);
  const cols = db.prepare('PRAGMA table_info(works)').all().map((c) => c.name);
  if (!cols.includes('postId') || cols.includes('nativeId')) throw new Error('S3 works 表结构被改了');
  db.close();
});
