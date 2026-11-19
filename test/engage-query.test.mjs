// 查询（MCP / CLI 共用）、订阅登记、抓取任务和守护进程事件。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ingestSnapshot, createJob, startJob, finishJob, requestRefresh, pendingRefreshes, recordSyncFailure, recordLoginLost } from '../src/ops/engage/store.mjs';
import * as q from '../src/ops/engage/query.mjs';
import { subscribe, unsubscribe } from '../src/ops/engage/subscribers.mjs';
import { freshDb, douyin, comment, commentsSnap, conv, dmsSnap, T0, MIN, at } from './helpers/engage-fixtures.mjs';

// 两层平台：「回复 @某人」已由适配器还原 parent。楼 r1：r1 ← a（别人）← me1（我回 a）；r1 ← b（别人，回复 @a）
// 楼 r2：r2 ← me2（我），但 me2 已 gone，所以 r2 算没回复
function seeded() {
  const db = freshDb();
  const a = douyin(db);
  ingestSnapshot(db, a, commentsSnap([comment('old')]), { now: at(T0) });
  ingestSnapshot(db, a, commentsSnap([
    comment('old'),
    comment('r1', { createdAt: '2026-11-19T01:01:00.000Z' }),
    comment('a', { parent: 'r1', root: 'r1', createdAt: '2026-11-19T01:02:00.000Z' }),
    comment('me1', { parent: 'a', root: 'r1', isMe: true, replyTo: { uid: 'u-a', nickname: '昵称a' }, createdAt: '2026-11-19T01:03:00.000Z' }),
    comment('b', { parent: 'a', root: 'r1', replyTo: { uid: 'u-a', nickname: '昵称a' }, createdAt: '2026-11-19T01:04:00.000Z' }),
    comment('r2', { createdAt: '2026-11-19T01:05:00.000Z' }),
    comment('me2', { parent: 'r2', isMe: true, createdAt: '2026-11-19T01:06:00.000Z' }),
  ]), { now: at(T0 + MIN) });
  // 下一轮 me2 没了（complete），标 gone
  ingestSnapshot(db, a, commentsSnap(['old', 'r1', 'a', 'me1', 'b', 'r2'].map((id) => comment(id, {
    parent: { a: 'r1', me1: 'a', b: 'a' }[id], root: ['a', 'me1', 'b'].includes(id) ? 'r1' : undefined, isMe: id === 'me1',
    createdAt: { old: '2026-11-19T01:00:00.000Z', r1: '2026-11-19T01:01:00.000Z', a: '2026-11-19T01:02:00.000Z', me1: '2026-11-19T01:03:00.000Z', b: '2026-11-19T01:04:00.000Z', r2: '2026-11-19T01:05:00.000Z' }[id],
  }))), { now: at(T0 + 2 * MIN) });
  ingestSnapshot(db, a, dmsSnap([conv('k1', { at: '2026-11-19T00:00:00.000Z' })]), { now: at(T0) });
  ingestSnapshot(db, a, dmsSnap([conv('k1', { at: '2026-11-19T01:30:00.000Z', unread: 2 }), conv('k2', { by: 'me', unread: 0 })], [
    { nativeId: 'm2', conversationNativeId: 'k1', by: 'peer', at: '2026-11-19T01:30:00.000Z', type: 'text', text: '后' },
    { nativeId: 'm1', conversationNativeId: 'k1', by: 'me', at: '2026-11-19T01:10:00.000Z', type: 'text', text: '先' },
  ]), { now: at(T0 + 3 * MIN) });
  return db;
}

describe('评论查询', () => {
  test('listComments 扁平、带树字段和 replied；默认不含 gone', () => {
    const db = seeded();
    const { items } = q.listComments(db, {});
    const byId = Object.fromEntries(items.map((c) => [c.id, c]));
    assert.equal(byId['Douyin:me2'], undefined);
    assert.equal(byId['Douyin:r1'].replied, true);
    assert.equal(byId['Douyin:a'].replied, true);
    assert.equal(byId['Douyin:b'].replied, false);
    assert.equal(byId['Douyin:r2'].replied, false);
    assert.deepEqual([byId['Douyin:me1'].parentId, byId['Douyin:me1'].rootId, byId['Douyin:me1'].depth], ['Douyin:a', 'Douyin:r1', 2]);
    assert.deepEqual(byId['Douyin:me1'].author, { uid: 'u-me1', nickname: '昵称me1', isMe: true });
    assert.equal(byId['Douyin:b'].workId, 'Douyin:w1');
    assert.equal(q.listComments(db, { includeGone: true }).items.find((c) => c.id === 'Douyin:me2').goneAt, new Date(T0 + 2 * MIN).toISOString());
  });

  test('过滤和游标分页（稳定排序，新的在前）', () => {
    const db = seeded();
    const unreplied = q.listComments(db, { replied: false }).items.map((c) => c.id);
    assert.deepEqual(unreplied, ['Douyin:r2', 'Douyin:b', 'Douyin:old']);
    assert.deepEqual(q.listComments(db, { since: '2026-11-19T01:04:00.000Z' }).items.map((c) => c.id), ['Douyin:r2', 'Douyin:b']);
    assert.equal(q.listComments(db, { platforms: ['Bili'] }).items.length, 0);
    const p1 = q.listComments(db, { limit: 2 });
    const p2 = q.listComments(db, { limit: 2, cursor: p1.nextCursor });
    const p3 = q.listComments(db, { limit: 2, cursor: p2.nextCursor });
    assert.deepEqual([...p1.items, ...p2.items, ...p3.items].map((c) => c.id), q.listComments(db, {}).items.map((c) => c.id));
    assert.equal(p3.nextCursor, null);
    assert.throws(() => q.listComments(db, { workId: 'w1' }), /<platformCode>:<原生 id>/);
    assert.throws(() => q.listComments(db, { cursor: 'garbage' }), /cursor/);
  });

  test('getCommentThread：整楼嵌套树 + 作品信息 + partial', () => {
    const db = seeded();
    const t = q.getCommentThread(db, 'Douyin:b');
    assert.equal(t.work.title, '作品一');
    assert.equal(t.work.url, 'https://example.test/w1');
    assert.equal(t.partial, false);
    const shape = (n) => [n.id, n.replied, n.children.map(shape)];
    assert.deepEqual(shape(t.root), ['Douyin:r1', true, [['Douyin:a', true, [['Douyin:me1', false, []], ['Douyin:b', false, []]]]]]);
    assert.throws(() => q.getCommentThread(db, 'Douyin:nope'), /没有这条评论/);
  });

  test('partial：作品楼中楼核实不了时 true', () => {
    const db = freshDb();
    ingestSnapshot(db, douyin(db), commentsSnap([comment('c1')], { scanned: [{ workNativeId: 'w1', complete: false, threadsPartial: true }] }), { now: at(T0) });
    assert.equal(q.getCommentThread(db, 'Douyin:c1').partial, true);
  });
});

describe('私信、作品、账号、收件箱', () => {
  test('listConversations / getConversation 旧到新', () => {
    const db = seeded();
    assert.deepEqual(q.listConversations(db, { unread: true }).items.map((c) => c.id), ['Douyin:k1']);
    assert.deepEqual(q.listConversations(db, { lastBy: 'me' }).items.map((c) => c.id), ['Douyin:k2']);
    const k1 = q.listConversations(db, {}).items.find((c) => c.id === 'Douyin:k1');
    assert.deepEqual(k1.peer, { uid: 'p-k1', nickname: '对方k1', kind: 'user' });
    assert.equal(k1.last.by, 'peer');
    const g = q.getConversation(db, 'Douyin:k1');
    assert.deepEqual(g.messages.map((m) => m.text), ['先', '后']);
    assert.deepEqual(q.getConversation(db, 'Douyin:k1', 1).messages.map((m) => m.text), ['后']);
    assert.throws(() => q.listConversations(db, { lastBy: 'x' }), /lastBy/);
  });

  test('inbox：未处理事件、未读会话、未回复评论', () => {
    const db = seeded();
    const ib = q.inbox(db, { platforms: ['Douyin'] });
    assert.deepEqual(ib, [{ platform: 'Douyin', unhandledEvents: 5, unreadConversations: 1, unrepliedComments: 3 }]);
  });

  test('listEvents / ackEvent', () => {
    const db = seeded();
    const all = q.listEvents(db, {});
    assert.equal(all.items.length, 5);
    assert.deepEqual(all.items[0].delivery, { attempts: 0, lastAttemptAt: null, deliveredAt: null });
    assert.equal(all.items[0].handled, null);
    assert.equal(all.items[0].platform, 'Douyin');
    const dm = q.listEvents(db, { types: ['dm.received'] }).items;
    assert.equal(dm.length, 1);
    const r = q.ackEvent(db, dm[0].id, 'replied', '已回', { now: at(T0 + 10 * MIN) });
    assert.deepEqual(r.handled, { at: new Date(T0 + 10 * MIN).toISOString(), outcome: 'replied', actionId: null, note: '已回' });
    assert.equal(q.listEvents(db, { unhandled: true }).items.length, 4);
    assert.throws(() => q.ackEvent(db, dm[0].id, 'done'), /outcome/);
    assert.throws(() => q.ackEvent(db, 'comment.created:Douyin:nope', 'skipped'), /没有这个事件/);
    const p1 = q.listEvents(db, { limit: 4 });
    assert.equal(q.listEvents(db, { limit: 4, cursor: p1.nextCursor }).items.length, 1);
  });

  test('listAccounts 带 lastSync；listWorks / getWork / getWorkFlow', () => {
    const db = seeded();
    const job = createJob(db, { platformCode: 'Douyin', accountId: 'Douyin:106707338905', kind: 'comments', now: at(T0) });
    startJob(db, job, { now: at(T0) });
    finishJob(db, job, { status: 'ok', now: at(T0 + MIN) });
    const acc = q.listAccounts(db).find((x) => x.id === 'Douyin:106707338905');
    assert.equal(acc.platform, 'Douyin');
    assert.equal(acc.loginState, 'unknown');
    assert.equal(acc.capabilities.reply, false);
    assert.deepEqual(acc.lastSync, { comments: new Date(T0 + MIN).toISOString() });
    const works = q.listWorks(db, {}).items;
    assert.equal(works.length, 1);
    assert.equal(works[0].commentCount, 6);
    assert.equal(works[0].unrepliedCount, 3);
    assert.equal(works[0].monitored, false);
    const w = q.getWork(db, 'Douyin:w1');
    assert.deepEqual(w.samples, []);
    assert.deepEqual(w.topComments.map((c) => c.id), ['Douyin:r2', 'Douyin:r1', 'Douyin:old']);
    assert.deepEqual(q.getWorkFlow(db, 'Douyin:w1'), { workId: 'Douyin:w1', hours: [], note: '流速数据由 S5 提供' });
    assert.throws(() => q.getWork(db, 'Douyin:none'), /没有这个作品/);
  });
});

describe('订阅登记', () => {
  test('首登返回 64 位 hex 密钥；重登不返回、只更新；退订置 inactive', () => {
    const db = freshDb();
    const r1 = subscribe(db, { subscriberId: 'openbot-1', url: 'http://127.0.0.1:9/hook', types: ['comment.created'] }, { now: at(T0) });
    assert.equal(r1.created, true);
    assert.match(r1.secret, /^[0-9a-f]{64}$/);
    const r2 = subscribe(db, { subscriberId: 'openbot-1', url: 'https://bot.example/hook', types: ['dm.received'], platforms: ['Douyin'] }, { now: at(T0 + MIN) });
    assert.equal(r2.created, false);
    assert.equal('secret' in r2, false);
    const row = db.prepare("SELECT * FROM subscribers WHERE id = 'openbot-1'").get();
    assert.equal(row.secret, r1.secret);
    assert.equal(row.url, 'https://bot.example/hook');
    assert.deepEqual(JSON.parse(row.types), ['dm.received']);
    assert.deepEqual(JSON.parse(row.platforms), ['Douyin']);
    assert.deepEqual(unsubscribe(db, 'openbot-1', { now: at(T0 + 2 * MIN) }), { subscriberId: 'openbot-1', active: false });
    assert.equal(db.prepare("SELECT active FROM subscribers WHERE id = 'openbot-1'").get().active, 0);
    assert.throws(() => unsubscribe(db, 'nobody'), /没有这个订阅方/);
  });

  test('校验：url 只收 http/https；types 只认已知类型；work.punished、flow.alert 可以登记', () => {
    const db = freshDb();
    const base = { subscriberId: 's', url: 'https://x.example/h', types: ['comment.created'] };
    assert.throws(() => subscribe(db, { ...base, url: 'ftp://x.example/h' }), /http/);
    assert.throws(() => subscribe(db, { ...base, url: 'not a url' }), /http/);
    assert.throws(() => subscribe(db, { ...base, types: ['comment.deleted'] }), /comment\.deleted/);
    assert.throws(() => subscribe(db, { ...base, types: [] }), /types/);
    assert.throws(() => subscribe(db, { ...base, platforms: ['Nope'] }), /Nope/);
    assert.equal(subscribe(db, { ...base, types: ['work.punished', 'flow.alert', 'sync.failed', 'account.login_lost'] }).created, true);
  });
});

describe('抓取任务与守护进程事件', () => {
  test('requestRefresh：5 分钟内同平台同 kind 去重', () => {
    const db = freshDb();
    const r1 = requestRefresh(db, { kind: 'comments', platform: 'Douyin', now: at(T0) });
    assert.equal(r1.deduped, false);
    assert.deepEqual(pendingRefreshes(db).map((j) => j.id), [r1.jobId]);
    assert.deepEqual(requestRefresh(db, { kind: 'comments', platform: 'Douyin', now: at(T0 + MIN) }), { jobId: r1.jobId, deduped: true, status: 'requested' });
    assert.equal(requestRefresh(db, { kind: 'dms', platform: 'Douyin', now: at(T0 + MIN) }).deduped, false);
    startJob(db, r1.jobId, { now: at(T0 + MIN) });
    finishJob(db, r1.jobId, { status: 'ok', now: at(T0 + 2 * MIN) });
    assert.equal(requestRefresh(db, { kind: 'comments', platform: 'Douyin', now: at(T0 + 6 * MIN) }).deduped, true);
    assert.equal(requestRefresh(db, { kind: 'comments', platform: 'Douyin', now: at(T0 + 8 * MIN) }).deduped, false);
    assert.throws(() => requestRefresh(db, { kind: 'works', platform: 'Douyin' }), /kind/);
    assert.equal(q.refreshNow(db, { kind: 'dms', platform: 'Douyin', now: at(T0 + 9 * MIN) }).deduped, true);
  });

  test('recordSyncFailure：连着第 2 次失败才出，第 3 次不再出，成功后重新数', () => {
    const db = freshDb();
    let t = T0;
    const run = (status) => {
      const id = createJob(db, { platformCode: 'Douyin', accountId: 'Douyin:106707338905', kind: 'comments', now: at(t) });
      startJob(db, id, { now: at(t) });
      finishJob(db, id, { status, error: status === 'failed' ? 'timeout' : null, now: at((t += MIN)) });
      return status === 'failed' ? recordSyncFailure(db, id, { now: at(t) }) : null;
    };
    assert.equal(run('failed'), null);
    run('skipped');
    const second = run('failed');
    assert.match(second, /^sync\.failed:Douyin:106707338905:comments:job_/);
    assert.equal(run('failed'), null);
    run('ok');
    assert.equal(run('failed'), null);
    assert.ok(run('failed'));
    assert.equal(db.prepare("SELECT count(*) n FROM events WHERE type = 'sync.failed'").get().n, 2);
  });

  test('recordLoginLost：同账号 6 小时一次', () => {
    const db = freshDb();
    assert.equal(recordLoginLost(db, { accountId: 'Douyin:106707338905', jobId: 'j1', now: at(T0) }), 'account.login_lost:Douyin:106707338905:j1');
    assert.equal(recordLoginLost(db, { accountId: 'Douyin:106707338905', jobId: 'j2', now: at(T0 + 3600_000) }), null);
    assert.ok(recordLoginLost(db, { accountId: 'Douyin:106707338905', jobId: 'j3', now: at(T0 + 6 * 3600_000 + 1) }));
  });
});
