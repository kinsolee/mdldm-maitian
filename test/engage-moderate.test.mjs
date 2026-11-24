// S7 处置组（delete_comment / block_user / delete_conversation）的框架：临时 ops.db + 假 writer（不起 runner、不碰任何平台）、假通知。
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getAccount, setCapability } from '../src/ops/accounts.mjs';
import { ingestSnapshot } from '../src/ops/engage/store.mjs';
import { deleteComment } from '../src/ops/engage/writers/bili-moderate.mjs';
import { engageWrite } from '../src/ops/engage/write.mjs';
import { MOD_ROUND_LIMIT, MOD_SUPPORT } from '../src/ops/engage/moderate.mjs';
import { writerModuleUrl } from '../src/ops/engage/writers/index.mjs';
import { openOpsDb } from '../src/ops/db.mjs';
import { freshDb, tmpDbFile, comment, conv, T0, MIN } from './helpers/engage-fixtures.mjs';

const BILI = 'Bili:478358005';
const ME = '478358005';
const HOUR = 60 * MIN;

const snap = (kind, rows) => ({ ok: true, platformCode: 'Bili', accountUid: ME, kind, fetchedAt: '2026-11-19T02:00:00.000Z',
  works: kind === 'comments' ? [{ nativeId: 'BV1xx', title: '作品一', url: 'https://www.bilibili.com/video/BV1xx', postTime: '2026-11-18T00:00:00.000Z' }] : [],
  comments: kind === 'comments' ? rows.map((c) => ({ ...c, workNativeId: 'BV1xx' })) : [],
  scannedWorks: kind === 'comments' ? [{ workNativeId: 'BV1xx', complete: true, threadsPartial: false }] : [],
  conversations: kind === 'dms' ? rows : [], messages: [] });
const peerConv = (id, o = {}) => ({ ...conv(id, o), peer: { uid: id, nickname: `对方${id}`, kind: 'user' } });

/** 库里：一楼 r1（9001）、楼中楼 a（9002 回 r1）、我的楼中楼 m；会话 777（对方 777）、888。第二轮才出事件。 */
function seed(db) {
  const acct = getAccount(db, BILI);
  ingestSnapshot(db, acct, snap('comments', []), { now: () => T0 });
  ingestSnapshot(db, acct, snap('comments', [comment('r1', { uid: '9001' }), comment('a', { parent: 'r1', root: 'r1', uid: '9002' }),
    comment('m', { parent: 'r1', root: 'r1', uid: ME, isMe: true })]), { now: () => T0 + MIN });
  ingestSnapshot(db, acct, snap('dms', []), { now: () => T0 });
  ingestSnapshot(db, acct, snap('dms', [peerConv('777'), peerConv('888')]), { now: () => T0 + MIN });
}

const DONE = { uidSeen: ME, sendAttempted: true, readBack: { found: true, count: 1, nativeId: 'x' } };
const LOST = { uidSeen: ME, sendAttempted: true, readBack: { found: false, count: 0, detail: '回读时这条还在' } };

function fakeWriter(results) {
  const calls = [];
  const queue = Array.isArray(results) ? [...results] : null;
  const fn = async (args) => { calls.push(args); const r = queue ? queue.shift() : results; return { ok: true, result: r }; };
  fn.calls = calls;
  return fn;
}

function setup({ caps = ['deleteComment', 'block', 'deleteConversation'] } = {}) {
  const db = freshDb(tmpDbFile());
  seed(db);
  for (const c of caps) setCapability(db, BILI, c, true);
  const notes = [];
  let clock = T0 + 2 * MIN;
  const deps = (writer) => ({ now: () => clock, runWriter: writer, notify: async (t) => { notes.push(t); return true; }, log: () => {} });
  return { db, notes, deps, tick: (ms) => { clock += ms; } };
}

const del = (extra = {}) => ({ op: 'delete', targetId: 'Bili:a', idempotencyKey: 'del-a', caller: 'test-bot', ...extra });
const blk = (extra = {}) => ({ op: 'block', targetId: 'Bili:a', idempotencyKey: 'blk-a', caller: 'test-bot', ...extra });
const dconv = (extra = {}) => ({ op: 'deleteConversation', targetId: 'Bili:777', idempotencyKey: 'dc-777', caller: 'test-bot', ...extra });
const actions = (db) => db.prepare('SELECT * FROM actions ORDER BY createdAt, rowid').all();
const caps = (db) => getAccount(db, BILI).capabilities;

describe('delete_comment', () => {
  let s;
  beforeEach(() => { s = setup(); });

  for (const [total, reason] of [[0, 'target-not-found'], [1, 'thread-incomplete']]) {
    test(`12006 经作品核实 → ${reason} 不重试`, async () => {
      ingestSnapshot(s.db, getAccount(s.db, BILI), snap('comments', [comment('100', { uid: '9001' })]), { now: () => T0 + 2 * MIN });
      const api = { get: async (url) => {
        switch (new URL(url).pathname) {
          case '/x/web-interface/nav': return { code: 0, data: { isLogin: true, mid: ME } };
          case '/x/web-interface/view': return { code: 0, data: { aid: 555, owner: { mid: ME } } };
          case '/x/v2/reply/reply': return { code: 12006 };
          case '/x/v2/reply/up/fulllist': return { code: 0, data: { list: [], page: { total } } };
          default: throw new Error('意外读取');
        }
      } };
      const writer = async ({ params }) => ({ ok: true, result: await deleteComment(api, params) });
      const r = await engageWrite(s.db, del({ targetId: 'Bili:100' }), s.deps(writer));
      assert.deepEqual([r.status, r.reason, r.retryable, r.sendAttempted], ['failed', reason, false, false]);
    });
  }

  test('回读确认删掉 → sent；actions op=delete、不存正文；事件自动回执 ignored；writer 拿到楼信息和本平台账号 uid、不拿 text', async () => {
    const w = fakeWriter(DONE);
    const r = await engageWrite(s.db, del(), s.deps(w));
    assert.equal(r.status, 'sent');
    assert.deepEqual(r.ackedEvents, ['comment.created:Bili:a']);
    const [row] = actions(s.db);
    assert.deepEqual([row.op, row.status, row.targetId, row.sendAttempted], ['delete', 'sent', 'Bili:a', 1]);
    assert.equal(row.textHash, createHash('sha256').update('').digest('hex'));
    const ev = s.db.prepare('SELECT handledOutcome, actionId FROM events WHERE id = ?').get('comment.created:Bili:a');
    assert.deepEqual({ ...ev }, { handledOutcome: 'ignored', actionId: r.actionId });
    const p = w.calls[0].params;
    assert.equal(p.op, 'delete');
    assert.equal('text' in p, false);
    assert.deepEqual(p.target, { commentId: 'a', workId: 'BV1xx', parentId: 'r1', rootId: 'r1', authorUid: '9002' });
    assert.deepEqual(p.selfUids, [ME]);
  });

  test('绝不删我自己的评论：authorIsMe 的、作者 mid 是账号自身 Bili:478358005 的 → rejected self-target，不起 writer', async () => {
    const w = fakeWriter(DONE);
    const r = await engageWrite(s.db, del({ targetId: 'Bili:m', idempotencyKey: 'k-m' }), s.deps(w));
    assert.deepEqual([r.status, r.reason, r.sendAttempted], ['rejected', 'self-target', false]);
    // 库里没标 isMe、但作者 uid 就是账号 mid 的，也拒
    s.db.prepare("UPDATE comments SET authorIsMe = 0 WHERE id = 'Bili:m'").run();
    const r2 = await engageWrite(s.db, del({ targetId: 'Bili:m', idempotencyKey: 'k-m2' }), s.deps(w));
    assert.equal(r2.reason, 'self-target');
    assert.equal(w.calls.length, 0);
  });

  test('X-B1：接口调了但报错、回读也没确认 → needs_readback（不是 failed）；换 key 也不再调第二次', async () => {
    const w = fakeWriter({ uidSeen: ME, sendAttempted: true, sendError: 'reply/del code=-403 没权限', readBack: { found: false, count: 0 } });
    const r = await engageWrite(s.db, del(), s.deps(w));
    assert.deepEqual([r.status, r.reason, r.sendAttempted], ['needs_readback', 'send-error-unconfirmed', true]);
    const again = await engageWrite(s.db, del({ idempotencyKey: 'k-new' }), s.deps(w));
    assert.deepEqual([again.status, again.reason], ['needs_readback', 'target-needs-readback']);
    assert.equal(w.calls.length, 1);
  });

  test('登记的第二个 B站账号也算我自己：它的评论不删、它不拉黑', async () => {
    s.db.prepare('INSERT INTO accounts (platformCode, platformName, uid, nickname, profileId, spaceName, capabilities) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('Bili', 'B站', '5550001', '小号', 'Profile 5', 'kinso/Bili/5550001', '{}');
    const acct = getAccount(s.db, BILI);
    ingestSnapshot(s.db, acct, snap('comments', [comment('r1', { uid: '9001' }), comment('a', { parent: 'r1', root: 'r1', uid: '9002' }),
      comment('m', { parent: 'r1', root: 'r1', uid: ME, isMe: true }), comment('alt', { parent: 'r1', root: 'r1', uid: '5550001' })]), { now: () => T0 + 2 * MIN });
    const w = fakeWriter(DONE);
    const d = await engageWrite(s.db, del({ targetId: 'Bili:alt', idempotencyKey: 'k-alt' }), s.deps(w));
    assert.deepEqual([d.status, d.reason], ['rejected', 'self-target']);
    for (const [targetId, key] of [['Bili:5550001', 'b1'], ['Bili:alt', 'b2']]) {
      const b = await engageWrite(s.db, blk({ targetId, idempotencyKey: key }), s.deps(w));
      assert.deepEqual([b.status, b.reason], ['rejected', 'self-target'], targetId);
    }
    assert.equal(w.calls.length, 0);
  });

  test('能力位 deleteComment 关着 → capability-off；只开 block 也删不了', async () => {
    const t = setup({ caps: ['block'] });
    const r = await engageWrite(t.db, del(), t.deps(fakeWriter(DONE)));
    assert.deepEqual([r.status, r.reason], ['rejected', 'capability-off']);
    assert.match(r.detail, /set-cap Bili:478358005 deleteComment true/);
  });

  test('库里已标 goneAt → failed already-gone，不起 writer；writer 说已不在 → failed already-gone，不算写入失败', async () => {
    s.db.prepare("UPDATE comments SET goneAt = '2026-11-19T03:00:00Z' WHERE id = 'Bili:a'").run();
    const w = fakeWriter(DONE);
    const r = await engageWrite(s.db, del(), s.deps(w));
    assert.deepEqual([r.status, r.reason], ['failed', 'already-gone']);
    assert.equal(w.calls.length, 0);
    s.db.prepare("UPDATE comments SET goneAt = NULL WHERE id = 'Bili:a'").run();
    const r2 = await engageWrite(s.db, del({ idempotencyKey: 'k2' }), s.deps(fakeWriter({ uidSeen: ME, sendAttempted: false, blocked: 'already-gone', detail: '楼里已没有' })));
    assert.deepEqual([r2.status, r2.reason, r2.sendAttempted], ['failed', 'already-gone', false]);
  });

  test('删一楼、下面有回复：writer 说 deletes-thread（rejected）→ rejected deletes-thread，不算调过接口、不占每轮上限；处理完回复后同一条还能再删', async () => {
    const DT = { uidSeen: ME, sendAttempted: false, blocked: 'deletes-thread', rejected: true, detail: 'r1 是一楼，下面有 2 条回复' };
    const r = await engageWrite(s.db, del({ targetId: 'Bili:r1', idempotencyKey: 'del-r1' }), s.deps(fakeWriter(DT)));
    assert.deepEqual([r.status, r.reason, r.sendAttempted, r.ackedEvents], ['rejected', 'deletes-thread', false, []]);
    const [row] = actions(s.db);
    assert.deepEqual([row.status, row.reason, row.sendAttempted], ['rejected', 'deletes-thread', 0]);
    const w = fakeWriter(DONE);
    assert.equal((await engageWrite(s.db, del({ targetId: 'Bili:r1', idempotencyKey: 'del-r1-2' }), s.deps(w))).status, 'sent');
    assert.equal(w.calls.length, 1);
  });

  test('读不回 → needs_readback，同一个 key、换个 key 都不再调 writer', async () => {
    const w = fakeWriter(LOST);
    const r = await engageWrite(s.db, del(), s.deps(w));
    assert.deepEqual([r.status, r.reason], ['needs_readback', 'readback-missing']);
    const again = await engageWrite(s.db, del(), s.deps(w));
    assert.deepEqual([again.status, again.previousActionId], ['needs_readback', r.actionId]);
    const otherKey = await engageWrite(s.db, del({ idempotencyKey: 'k-other' }), s.deps(w));
    assert.deepEqual([otherKey.status, otherKey.reason], ['needs_readback', 'target-needs-readback']);
    assert.equal(w.calls.length, 1, '接口只调一次');
    assert.equal(s.db.prepare("SELECT handledAt FROM events WHERE id = 'comment.created:Bili:a'").get().handledAt, null, '没读回不回执');
  });

  test('同一个 key 成功过 → duplicate；换 key 再删同一条 → failed already-gone', async () => {
    const w = fakeWriter(DONE);
    const first = await engageWrite(s.db, del(), s.deps(w));
    const dup = await engageWrite(s.db, del(), s.deps(w));
    assert.deepEqual([dup.status, dup.previousActionId], ['duplicate', first.actionId]);
    const other = await engageWrite(s.db, del({ idempotencyKey: 'k-x' }), s.deps(w));
    assert.deepEqual([other.status, other.reason], ['failed', 'already-gone']);
    assert.equal(w.calls.length, 1);
  });

  test('eventId 不是这条评论的 comment.created → rejected event-mismatch', async () => {
    const r = await engageWrite(s.db, del({ eventId: 'comment.created:Bili:r1' }), s.deps(fakeWriter(DONE)));
    assert.deepEqual([r.status, r.reason], ['rejected', 'event-mismatch']);
  });

  test('还没接上的平台 → rejected unsupported-platform', async () => {
    const r = await engageWrite(s.db, del({ targetId: 'XiaoHongShu:a' }), s.deps(fakeWriter(DONE)));
    assert.deepEqual([r.status, r.reason], ['rejected', 'unsupported-platform']);
  });

  test('平台本身做不到的（MOD_UNSUPPORTED）：rejected unsupported-platform，detail 写原因；不起 writer', async () => {
    const w = fakeWriter(DONE);
    for (const [op, targetId, re] of [['deleteConversation', 'Channels:s1', /deleteSessionById/], ['block', 'XiaoHongShu:u1', /手机/], ['deleteConversation', 'XiaoHongShu:c1', /群聊/], ['deleteConversation', 'Douyin:c1', /MarkConversationDelete/]]) {
      const r = await engageWrite(s.db, { op, targetId, idempotencyKey: `k-${targetId}`, caller: 'test-bot' }, s.deps(w));
      assert.deepEqual([r.status, r.reason], ['rejected', 'unsupported-platform'], targetId);
      assert.match(r.detail, re, targetId);
    }
    assert.equal(w.calls.length, 0);
  });

  test('MOD_SUPPORT 里每个平台都有处置写入脚本', () => {
    for (const [op, codes] of Object.entries(MOD_SUPPORT)) for (const c of codes) assert.match(writerModuleUrl(c, op), /-moderate\.mjs$/, `${c} ${op}`);
  });

  test('writer 路由：处置组走 bili-moderate.mjs，回复照旧走 bili.mjs', () => {
    assert.match(writerModuleUrl('Bili', 'delete'), /bili-moderate\.mjs$/);
    assert.match(writerModuleUrl('Bili', 'block'), /bili-moderate\.mjs$/);
    assert.match(writerModuleUrl('Bili', 'reply'), /\/bili\.mjs$/);
    assert.match(writerModuleUrl('Douyin', 'delete'), /douyin-moderate\.mjs$/);
    assert.match(writerModuleUrl('Douyin', 'reply'), /\/douyin\.mjs$/);
    assert.match(writerModuleUrl('Channels', 'delete'), /channels-moderate\.mjs$/);
    assert.match(writerModuleUrl('Channels', 'reply'), /\/channels\.mjs$/);
    assert.throws(() => writerModuleUrl('XiaoHongShu', 'delete'), /没有 delete/);
  });
});

describe('block_user', () => {
  let s;
  beforeEach(() => { s = setup(); });

  test('target 是评论 id：推出作者 mid，actions 按 Bili:<mid> 记，返回 inputTarget；回执这条评论的事件', async () => {
    const w = fakeWriter(DONE);
    const r = await engageWrite(s.db, blk(), s.deps(w));
    assert.deepEqual([r.status, r.targetId, r.inputTarget], ['sent', 'Bili:9002', 'Bili:a']);
    // source：从哪条评论认出这个人（抖音要靠它重读出对方的 sec_uid；B站用不上）
    assert.deepEqual(w.calls[0].params.target, { mid: '9002', via: 'comment', source: { kind: 'comment', commentId: 'a', workId: 'BV1xx', parentId: 'r1', rootId: 'r1', authorUid: '9002' } });
    assert.equal(actions(s.db)[0].targetId, 'Bili:9002');
    assert.deepEqual(r.ackedEvents, ['comment.created:Bili:a']);
  });

  test('target 是会话 id（B站会话 id 就是对方 mid）或直接给 mid：都认', async () => {
    const w = fakeWriter([DONE, DONE]);
    const a = await engageWrite(s.db, blk({ targetId: 'Bili:777', idempotencyKey: 'k1' }), s.deps(w));
    assert.deepEqual([a.status, a.targetId], ['sent', 'Bili:777']);
    const dmEvents = s.db.prepare("SELECT id FROM events WHERE type = 'dm.received' AND subjectId = 'Bili:777'").all().map((e) => e.id);
    assert.ok(dmEvents.length > 0, '种子里应有这个会话的 dm.received');
    assert.deepEqual(a.ackedEvents, dmEvents);
    assert.deepEqual(w.calls[0].params.target, { mid: '777', via: 'conversation', source: { kind: 'conversation', conversationId: '777', peerUid: '777' } });
    const b = await engageWrite(s.db, blk({ targetId: 'Bili:9001', idempotencyKey: 'k2' }), s.deps(w));
    assert.deepEqual([b.status, b.targetId, b.inputTarget], ['sent', 'Bili:9001', undefined]);
    // 只给 mid：source 取这个人在这个账号下最近的评论
    assert.deepEqual(w.calls[1].params.target, { mid: '9001', via: 'mid', source: { kind: 'comment', commentId: 'r1', workId: 'BV1xx', parentId: null, rootId: 'r1', authorUid: '9001' } });
  });

  test('只给 mid：source 在评论和会话之间按时间取最新的；评论时间缺失时排后', async () => {
    const addConv = (db, lastAt) => db.prepare(`INSERT INTO conversations (id, accountId, platformCode, peerUid, peerNickname, peerKind, lastAt, firstSeenAt, updatedAt)
      VALUES ('Bili:c9001', ?, 'Bili', '9001', 'x', 'user', ?, 'x', 'x')`).run(BILI, lastAt);
    // 9001 的评论 r1 是 2026-11-19T01:00，会话更新
    addConv(s.db, '2026-11-19T05:00:00.000Z');
    const w = fakeWriter(DONE);
    await engageWrite(s.db, blk({ targetId: 'Bili:9001', idempotencyKey: 'k1' }), s.deps(w));
    assert.deepEqual(w.calls[0].params.target.source, { kind: 'conversation', conversationId: 'c9001', peerUid: '9001' });
    // 评论比会话新 → 评论
    const s2 = setup();
    addConv(s2.db, '2026-11-18T00:00:00.000Z');
    const w2 = fakeWriter(DONE);
    await engageWrite(s2.db, blk({ targetId: 'Bili:9001', idempotencyKey: 'k1' }), s2.deps(w2));
    assert.equal(w2.calls[0].params.target.source.kind, 'comment');
    // 评论没有时间、会话有 → 会话
    const s3 = setup();
    s3.db.prepare("UPDATE comments SET createdAt = NULL WHERE id = 'Bili:r1'").run();
    addConv(s3.db, '2026-11-18T00:00:00.000Z');
    const w3 = fakeWriter(DONE);
    await engageWrite(s3.db, blk({ targetId: 'Bili:9001', idempotencyKey: 'k1' }), s3.deps(w3));
    assert.equal(w3.calls[0].params.target.source.kind, 'conversation');
  });

  test('绝不拉黑我自己：Bili:478358005、我自己的评论 id → rejected self-target，能力位开着也不起 writer', async () => {
    const w = fakeWriter(DONE);
    for (const [targetId, key] of [['Bili:478358005', 'k-me'], ['Bili:m', 'k-my-comment']]) {
      const r = await engageWrite(s.db, blk({ targetId, idempotencyKey: key }), s.deps(w));
      assert.deepEqual([r.status, r.reason, r.sendAttempted], ['rejected', 'self-target', false], targetId);
    }
    assert.equal(w.calls.length, 0);
  });

  test('G-6：账号自身 mid 在库里一条评论、会话都没有，也是 self-target（不是 unknown-target）', async () => {
    s.db.prepare("DELETE FROM comments WHERE id = 'Bili:m'").run();
    const r = await engageWrite(s.db, blk({ targetId: 'Bili:478358005', idempotencyKey: 'k-me' }), s.deps(fakeWriter(DONE)));
    assert.deepEqual([r.status, r.reason], ['rejected', 'self-target']);
  });

  test('G-B1：群聊、官方号会话不是用户：block_user 拒绝 not-a-user，delete_conversation 也不删；都不起 writer', async () => {
    s.db.prepare("UPDATE conversations SET peerKind = 'group' WHERE id = 'Bili:888'").run();
    s.db.prepare("UPDATE conversations SET peerKind = 'official' WHERE id = 'Bili:777'").run();
    const w = fakeWriter(DONE);
    for (const [targetId, key] of [['Bili:888', 'g'], ['Bili:777', 'o']]) {
      const r = await engageWrite(s.db, blk({ targetId, idempotencyKey: key }), s.deps(w));
      assert.deepEqual([r.status, r.reason], ['rejected', 'not-a-user'], targetId);
    }
    const d = await engageWrite(s.db, dconv({ targetId: 'Bili:888' }), s.deps(w));
    assert.deepEqual([d.status, d.reason], ['failed', 'not-a-user']);
    assert.equal(w.calls.length, 0);
  });

  test('G-B2：eventId 是别的平台的事件（作者 uid 碰巧一样）→ event-mismatch，不回执那个事件', async () => {
    s.db.prepare(`INSERT INTO events (id, type, platformCode, accountId, subjectId, createdAt, payload) VALUES ('comment.created:Douyin:c99', 'comment.created', 'Douyin', NULL, 'Douyin:c99', '2026-11-19T02:00:00.000Z', '{}')`).run();
    s.db.prepare(`INSERT INTO comments (id, workId, accountId, platformCode, rootId, depth, authorUid, firstSeenAt, lastSeenAt) VALUES ('Douyin:c99', 'Douyin:w', 'Douyin:x', 'Douyin', 'Douyin:c99', 0, '9002', 'x', 'x')`).run();
    const r = await engageWrite(s.db, blk({ eventId: 'comment.created:Douyin:c99' }), s.deps(fakeWriter(DONE)));
    assert.deepEqual([r.status, r.reason], ['rejected', 'event-mismatch']);
    assert.equal(s.db.prepare("SELECT handledAt FROM events WHERE id = 'comment.created:Douyin:c99'").get().handledAt, null);
  });

  test('R2-B1：同平台另一个账号的事件（subjectId 一样）→ event-mismatch；自动回执也不碰别的账号的事件', async () => {
    s.db.prepare('INSERT INTO accounts (platformCode, platformName, uid, nickname, profileId, spaceName, capabilities) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('Bili', 'B站', '5550001', '小号', 'Profile 5', 'kinso/Bili/5550001', '{}');
    s.db.prepare(`INSERT INTO events (id, type, platformCode, accountId, subjectId, createdAt, payload) VALUES ('dm.received:alt', 'dm.received', 'Bili', 'Bili:5550001', 'Bili:777', '2026-11-19T02:00:00.000Z', '{}')`).run();
    const bad = await engageWrite(s.db, dconv({ eventId: 'dm.received:alt' }), s.deps(fakeWriter(DONE)));
    assert.deepEqual([bad.status, bad.reason], ['rejected', 'event-mismatch']);
    const blkBad = await engageWrite(s.db, blk({ targetId: 'Bili:777', idempotencyKey: 'b-alt', eventId: 'dm.received:alt' }), s.deps(fakeWriter(DONE)));
    assert.deepEqual([blkBad.status, blkBad.reason], ['rejected', 'event-mismatch']);
    const ok = await engageWrite(s.db, dconv({ idempotencyKey: 'dc-ok' }), s.deps(fakeWriter(DONE)));
    assert.equal(ok.status, 'sent');
    assert.ok(!ok.ackedEvents.includes('dm.received:alt'));
    assert.equal(s.db.prepare("SELECT handledAt FROM events WHERE id = 'dm.received:alt'").get().handledAt, null);
  });

  test('拉黑读不回之后，换个入口（评论 id → mid）、换 key 也被拦 target-needs-readback', async () => {
    const w = fakeWriter(LOST);
    await engageWrite(s.db, blk(), s.deps(w));
    const r = await engageWrite(s.db, blk({ targetId: 'Bili:9002', idempotencyKey: 'k-mid' }), s.deps(w));
    assert.deepEqual([r.status, r.reason], ['needs_readback', 'target-needs-readback']);
    assert.equal(w.calls.length, 1);
  });

  test('库里没见过的 mid → rejected unknown-target，不起 writer', async () => {
    const w = fakeWriter(DONE);
    const r = await engageWrite(s.db, blk({ targetId: 'Bili:123456' }), s.deps(w));
    assert.deepEqual([r.status, r.reason], ['rejected', 'unknown-target']);
    assert.equal(w.calls.length, 0);
  });

  test('同一个 id 既是评论 id、又是别人的 mid（指向两个人）→ rejected ambiguous-target', async () => {
    const acct = getAccount(s.db, BILI);
    // 评论 9001 的作者是 5000，而 9001 本身又是 r1 的作者 mid
    ingestSnapshot(s.db, acct, snap('comments', [comment('r1', { uid: '9001' }), comment('a', { parent: 'r1', root: 'r1', uid: '9002' }),
      comment('m', { parent: 'r1', root: 'r1', uid: ME, isMe: true }), comment('9001', { uid: '5000' })]), { now: () => T0 + 2 * MIN });
    const r = await engageWrite(s.db, blk({ targetId: 'Bili:9001' }), s.deps(fakeWriter(DONE)));
    assert.deepEqual([r.status, r.reason], ['rejected', 'ambiguous-target']);
  });

  test('同一个人换个入口（评论 id → mid）、换个 key：之前已拉黑 → failed already-blocked，不起 writer', async () => {
    const w = fakeWriter(DONE);
    await engageWrite(s.db, blk(), s.deps(w));
    const r = await engageWrite(s.db, blk({ targetId: 'Bili:9002', idempotencyKey: 'k-again' }), s.deps(w));
    assert.deepEqual([r.status, r.reason], ['failed', 'already-blocked']);
    assert.equal(w.calls.length, 1);
  });

  test('eventId 是这个人的评论事件 → 可以；是别人的 → event-mismatch', async () => {
    const ok = await engageWrite(s.db, blk({ targetId: 'Bili:9002', eventId: 'comment.created:Bili:a' }), s.deps(fakeWriter(DONE)));
    assert.equal(ok.status, 'sent');
    assert.deepEqual(ok.ackedEvents, ['comment.created:Bili:a']);
    const bad = await engageWrite(s.db, blk({ targetId: 'Bili:9001', idempotencyKey: 'k2', eventId: 'comment.created:Bili:a' }), s.deps(fakeWriter(DONE)));
    assert.deepEqual([bad.status, bad.reason], ['rejected', 'event-mismatch']);
  });

  test('能力位 block 关着 → capability-off', async () => {
    const t = setup({ caps: ['deleteComment'] });
    const r = await engageWrite(t.db, blk(), t.deps(fakeWriter(DONE)));
    assert.deepEqual([r.status, r.reason], ['rejected', 'capability-off']);
  });
});

describe('delete_conversation', () => {
  let s;
  beforeEach(() => { s = setup(); });

  test('回读确认删掉 → sent；回执这个会话的 dm.received（ignored）', async () => {
    const w = fakeWriter(DONE);
    const r = await engageWrite(s.db, dconv(), s.deps(w));
    assert.equal(r.status, 'sent');
    assert.deepEqual(w.calls[0].params.target, { conversationId: '777', peerUid: '777' });
    for (const id of r.ackedEvents) assert.equal(s.db.prepare('SELECT handledOutcome FROM events WHERE id = ?').get(id).handledOutcome, 'ignored');
  });

  test('删过之后：会话没新消息，换 key 再删 → failed already-gone；对方又发了消息（lastAt 变了）→ 可以再删', async () => {
    const w = fakeWriter([DONE, DONE]);
    await engageWrite(s.db, dconv(), s.deps(w));
    const again = await engageWrite(s.db, dconv({ idempotencyKey: 'k2' }), s.deps(w));
    assert.deepEqual([again.status, again.reason], ['failed', 'already-gone']);
    s.db.prepare("UPDATE conversations SET lastAt = '2026-11-19T05:00:00.000Z' WHERE id = 'Bili:777'").run();
    const back = await engageWrite(s.db, dconv({ idempotencyKey: 'k3' }), s.deps(w));
    assert.equal(back.status, 'sent');
    assert.equal(w.calls.length, 2);
  });

  test('会话对方是我自己 → rejected self-target', async () => {
    s.db.prepare("UPDATE conversations SET peerUid = ? WHERE id = 'Bili:888'").run(ME);
    const r = await engageWrite(s.db, dconv({ targetId: 'Bili:888' }), s.deps(fakeWriter(DONE)));
    assert.deepEqual([r.status, r.reason], ['rejected', 'self-target']);
  });

  test('能力位 deleteConversation 关着 → capability-off', async () => {
    const t = setup({ caps: ['block', 'deleteComment'] });
    const r = await engageWrite(t.db, dconv(), t.deps(fakeWriter(DONE)));
    assert.deepEqual([r.status, r.reason], ['rejected', 'capability-off']);
  });
});

describe('每轮上限、连续失败自动关（处置组和回复组分开）', () => {
  /** n 条不同评论，作者各不相同 */
  function many(s, n) {
    const acct = getAccount(s.db, BILI);
    const rows = Array.from({ length: n }, (_, i) => comment(`z${i}`, { uid: `70${i}` }));
    ingestSnapshot(s.db, acct, snap('comments', [comment('r1', { uid: '9001' }), comment('a', { parent: 'r1', root: 'r1', uid: '9002' }),
      comment('m', { parent: 'r1', root: 'r1', uid: ME, isMe: true }), ...rows]), { now: () => T0 + MIN });
  }

  test(`每小时 delete 最多 ${MOD_ROUND_LIMIT} 条，block 另算；处置不占回复的 15 条`, async () => {
    const s = setup();
    setCapability(s.db, BILI, 'reply', true);
    many(s, MOD_ROUND_LIMIT + 1);
    const w = fakeWriter(DONE);
    for (let i = 0; i < MOD_ROUND_LIMIT; i++) assert.equal((await engageWrite(s.db, del({ targetId: `Bili:z${i}`, idempotencyKey: `d${i}` }), s.deps(w))).status, 'sent');
    const over = await engageWrite(s.db, del({ targetId: `Bili:z${MOD_ROUND_LIMIT}`, idempotencyKey: 'd-over' }), s.deps(w));
    assert.deepEqual([over.status, over.reason, over.retryable], ['rejected', 'round-limit', true]);
    assert.equal((await engageWrite(s.db, blk({ targetId: 'Bili:z0', idempotencyKey: 'b0' }), s.deps(w))).status, 'sent', 'block 另算');
    const rep = await engageWrite(s.db, { op: 'reply', targetId: 'Bili:z1', text: '谢谢', idempotencyKey: 'r-1', caller: 't' }, s.deps(fakeWriter({ ...DONE })));
    assert.equal(rep.status, 'sent', '回复不受处置条数影响');
    s.tick(HOUR);
    assert.equal((await engageWrite(s.db, del({ targetId: `Bili:z${MOD_ROUND_LIMIT}`, idempotencyKey: 'd-next' }), s.deps(w))).status, 'sent', '下一轮恢复');
  });

  test('连续 2 轮处置读不回 → 关掉 deleteComment、block、deleteConversation（回复的能力位不动），发一条提醒（假通知）', async () => {
    const s = setup();
    setCapability(s.db, BILI, 'reply', true);
    const w = fakeWriter([LOST, LOST]);
    const r1 = await engageWrite(s.db, del(), s.deps(w));
    assert.equal(r1.writeDisabled, false);
    s.tick(HOUR);
    const r2 = await engageWrite(s.db, blk({ targetId: 'Bili:r1', idempotencyKey: 'b-r1' }), s.deps(w));
    assert.equal(r2.status, 'needs_readback');
    assert.equal(r2.writeDisabled, true);
    const c = caps(s.db);
    assert.deepEqual([c.deleteComment, c.block, c.deleteConversation, c.reply], [false, false, false, true]);
    assert.equal(s.notes.length, 1);
    assert.match(s.notes[0], /处置.*连续 2 轮失败/);
    assert.match(s.notes[0], /set-cap Bili:478358005 deleteComment true/);
    const trip = s.db.prepare('SELECT family, alertedAt FROM engage_write_trips').get();
    assert.equal(trip.family, 'moderate');
    assert.ok(trip.alertedAt);
  });

  test('回复组连续失败不关处置能力位；处置的失败也不算进回复组', async () => {
    const s = setup();
    setCapability(s.db, BILI, 'reply', true);
    const rw = fakeWriter([LOST, LOST]);
    // 一轮处置失败 + 一轮回复失败：两组各只有 1 轮，都不关
    await engageWrite(s.db, del(), s.deps(rw));
    s.tick(HOUR);
    const r = await engageWrite(s.db, { op: 'reply', targetId: 'Bili:a', text: '谢谢', idempotencyKey: 'r-1', caller: 't' }, s.deps(rw));
    assert.equal(r.writeDisabled, false);
    assert.equal(caps(s.db).reply, true);
    assert.equal(caps(s.db).deleteComment, true);
    assert.equal(s.notes.length, 0);
  });

  test('回复组真的连续 2 轮失败：只关 reply、sendDM，处置能力位不动', async () => {
    const s = setup();
    for (const c of ['reply', 'sendDM']) setCapability(s.db, BILI, c, true);
    const rw = fakeWriter([LOST, LOST]);
    await engageWrite(s.db, { op: 'reply', targetId: 'Bili:a', text: '谢谢', idempotencyKey: 'r-1', caller: 't' }, s.deps(rw));
    s.tick(HOUR);
    const r = await engageWrite(s.db, { op: 'sendDM', targetId: 'Bili:777', text: '你好', idempotencyKey: 'dm-1', caller: 't' }, s.deps(rw));
    assert.equal(r.writeDisabled, true);
    const c = caps(s.db);
    assert.deepEqual([c.reply, c.sendDM, c.deleteComment, c.block, c.deleteConversation], [false, false, true, true, true]);
    assert.equal(s.db.prepare('SELECT family FROM engage_write_trips').get().family, 'write');
  });

  test('发前重读拦下的（already-gone、already-blocked）不算写入失败，不触发自动关', async () => {
    const s = setup();
    const w = fakeWriter([{ uidSeen: ME, sendAttempted: false, blocked: 'already-gone' }, { uidSeen: ME, sendAttempted: false, blocked: 'already-blocked' }]);
    await engageWrite(s.db, del(), s.deps(w));
    s.tick(HOUR);
    const r = await engageWrite(s.db, blk(), s.deps(w));
    assert.equal(r.writeDisabled, false);
    assert.equal(caps(s.db).deleteComment, true);
  });
});

test('旧库升级：engage_write_trips 没有 family 列时补上，旧的自动关记录（NULL）按回复组算，不挡处置组', async () => {
  const file = tmpDbFile();
  const db = freshDb(file);
  db.exec('ALTER TABLE engage_write_trips DROP COLUMN family');
  db.prepare(`INSERT INTO engage_write_trips (id, platformCode, trippedAt, rounds) VALUES ('old', 'Bili', '2026-11-19T02:30:00.000Z', '[]')`).run();
  db.close();
  const db2 = openOpsDb(file);
  assert.ok(db2.prepare('PRAGMA table_info(engage_write_trips)').all().some((c) => c.name === 'family'));
  assert.equal(db2.prepare("SELECT family FROM engage_write_trips WHERE id = 'old'").get().family, null);
  seed(db2);
  for (const c of ['deleteComment', 'block']) setCapability(db2, BILI, c, true);
  let clock = T0 + 2 * MIN;
  const deps = { now: () => clock, runWriter: fakeWriter([LOST, LOST]), notify: async () => true, log: () => {} };
  await engageWrite(db2, del(), deps);
  clock += HOUR;
  const r = await engageWrite(db2, blk({ targetId: 'Bili:r1', idempotencyKey: 'b' }), deps);
  assert.equal(r.writeDisabled, true, '旧 write 组记录不重置处置组的计数');
});
