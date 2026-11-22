// 视频号处置写入脚本（writers/channels-moderate.mjs）：假评论服务，不起 runner、不碰任何页面。框架接线用临时库 + 假 writer。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deleteComment, block } from '../src/ops/engage/writers/channels-moderate.mjs';
import { getAccount, setCapability } from '../src/ops/accounts.mjs';
import { ingestSnapshot } from '../src/ops/engage/store.mjs';
import { engageWrite } from '../src/ops/engage/write.mjs';
import { writerModuleUrl } from '../src/ops/engage/writers/index.mjs';
import { freshDb, tmpDbFile, T0, MIN } from './helpers/engage-fixtures.mjs';

const ME = 'sphMxEyFyDie8K8';
const MYNICK = '我自己';
const EXPORT = 'export/obj-1';
const WORK = 'nonce-1';

const l2 = (id, nick, o = {}) => ({ commentId: id, commentNickname: nick, commentContent: 'y', replyCommentId: o.reply ?? null, blacklistFlag: o.black ?? 0 });
const root = (id, nick, kids = [], o = {}) => ({ commentId: id, commentNickname: nick, commentContent: 'x', levelTwoComment: kids, downContinueFlag: o.more ? 1 : 0, lastBuff: o.more ? 'b1' : '', blacklistFlag: o.black ?? 0 });

/** 假评论服务。del / blk：调写接口时怎么回、改不改状态。 */
function fakeChannels({ roots, del = { errCode: 0, apply: true }, blk = { errCode: 0, apply: true }, methods = ['deleteComment', 'blockUser'] } = {}) {
  let st = structuredClone(roots);
  const calls = [];
  const call = async (method, args) => {
    calls.push({ method, args });
    if (method === 'getCommentList') {
      if (args.exportId !== EXPORT) return { ok: true, data: { errCode: 0, data: { comment: [], downContinueFlag: 0, lastBuff: '' } } };
      // 楼中楼续页：一楼说还有（more）时，续页翻不动（游标不变），按没读全
      if (args.rootCommentId) return { ok: true, data: { errCode: 0, data: { comment: [], downContinueFlag: 1, lastBuff: args.lastBuff } } };
      return { ok: true, data: { errCode: 0, data: { comment: structuredClone(st), downContinueFlag: 0, lastBuff: '' } } };
    }
    if (method === 'deleteComment') {
      if (del.throws) return { ok: false, error: del.throws };
      if (del.apply) st = st.filter((r) => r.commentId !== args.commentId).map((r) => ({ ...r, levelTwoComment: r.levelTwoComment.filter((x) => x.commentId !== args.commentId) }));
      return { ok: true, data: { errCode: del.errCode, errMsg: del.errCode ? 'fail' : 'ok' } };
    }
    if (method === 'blockUser') {
      if (blk.throws) return { ok: false, error: blk.throws };
      if (blk.apply && blk.errCode === 0) st = st.map((r) => (r.commentId === args.refCommentId ? { ...r, blacklistFlag: 1 } : { ...r, levelTwoComment: r.levelTwoComment.map((x) => (x.commentId === args.refCommentId ? { ...x, blacklistFlag: 1 } : x)) }));
      return { ok: true, data: { errCode: blk.errCode } };
    }
    return { ok: false, error: `没有 ${method}` };
  };
  return { calls, call, writes: () => calls.filter((c) => c.method !== 'getCommentList'),
    api: (o = {}) => ({ sleep: async () => {}, whoAmI: async () => o.who ?? { uid: ME, nickname: MYNICK }, exportId: async (w) => (w === WORK ? { exportId: EXPORT } : { blocked: 'target-not-found', detail: '作品列表里没有这个作品' }),
      hasMethod: async (n) => methods.includes(n), call }) };
}

const delP = (o = {}) => ({ op: 'delete', uid: ME, nickname: MYNICK, target: { commentId: 'c2', workId: WORK, parentId: 'c1', rootId: 'c1', authorUid: null, ...o } });
const blkP = (o = {}) => ({ op: 'block', uid: ME, nickname: MYNICK, target: { mid: null, via: 'comment', source: { kind: 'comment', commentId: 'c2', workId: WORK, parentId: 'c1', rootId: 'c1', authorUid: null, ...o } } });

describe('视频号删评论', () => {
  test('楼中楼：楼读全、调一次 deleteComment（exportId + commentId）、回读没了 → found', async () => {
    const f = fakeChannels({ roots: [root('c1', '甲', [l2('c2', '乙'), l2('c3', '丙')])] });
    const r = await deleteComment(f.api(), delP());
    assert.deepEqual([r.sendAttempted, r.readBack.found, r.readBack.nativeId], [true, true, 'c2']);
    assert.deepEqual(f.writes().map((c) => c.args), [{ exportId: EXPORT, commentId: 'c2' }]);
  });

  test('一楼没有回复 → 删掉后一楼列表翻到底没有它 → found；一楼有回复 → deletes-thread（rejected）不调接口', async () => {
    const f = fakeChannels({ roots: [root('c1', '甲'), root('c9', '丁')] });
    assert.equal((await deleteComment(f.api(), delP({ commentId: 'c1', parentId: null }))).readBack.found, true);
    const g = fakeChannels({ roots: [root('c1', '甲', [l2('c2', '乙')])] });
    const r = await deleteComment(g.api(), delP({ commentId: 'c1', parentId: null }));
    assert.deepEqual([r.blocked, r.rejected, r.sendAttempted], ['deletes-thread', true, false]);
    assert.equal(g.writes().length, 0);
  });

  test('已不在 → already-gone；昵称是我 → self-target；楼没读全 → thread-incomplete；都不调接口', async () => {
    const gone = fakeChannels({ roots: [root('c1', '甲', [l2('c3', '丙')])] });
    assert.equal((await deleteComment(gone.api(), delP())).blocked, 'already-gone');
    const mine = fakeChannels({ roots: [root('c1', '甲', [l2('c2', MYNICK)])] });
    assert.equal((await deleteComment(mine.api(), delP())).blocked, 'self-target');
    const part = fakeChannels({ roots: [root('c1', '甲', [l2('c2', '乙')], { more: true })] });
    assert.equal((await deleteComment(part.api(), delP())).blocked, 'thread-incomplete');
    assert.equal(gone.writes().length + mine.writes().length + part.writes().length, 0);
  });

  test('回读还在 → found=false；接口 errCode≠0 → sendError；接口抛错 → sendAttempted=true；都只调一次', async () => {
    const stay = fakeChannels({ roots: [root('c1', '甲', [l2('c2', '乙')])], del: { errCode: 0, apply: false } });
    const a = await deleteComment(stay.api(), delP());
    assert.deepEqual([a.sendAttempted, a.readBack.found], [true, false]);
    assert.match(a.readBack.detail, /还在/);
    const err = fakeChannels({ roots: [root('c1', '甲', [l2('c2', '乙')])], del: { errCode: 300333, apply: false } });
    const b = await deleteComment(err.api(), delP());
    assert.match(b.sendError, /errCode=300333/);
    assert.equal(b.readBack.found, false);
    const thr = fakeChannels({ roots: [root('c1', '甲', [l2('c2', '乙')])], del: { throws: '超时' } });
    const c = await deleteComment(thr.api(), delP());
    assert.deepEqual([c.sendAttempted, c.readBack.found], [true, false]);
    assert.match(c.readBack.detail, /超时/);
    for (const f of [stay, err, thr]) assert.equal(f.writes().length, 1);
  });

  test('作品找不到 → target-not-found；没有 deleteComment → cannot-send；账号不对 → 原样返回；读不到自己的昵称 → no-uid', async () => {
    const f = fakeChannels({ roots: [root('c1', '甲', [l2('c2', '乙')])], methods: [] });
    assert.equal((await deleteComment(f.api(), delP({ workId: 'nope' }))).blocked, 'target-not-found');
    assert.equal((await deleteComment(f.api(), delP())).blocked, 'cannot-send');
    const done = { uidSeen: 'x', blocked: 'uid-mismatch', detail: 'd', sendAttempted: false };
    assert.deepEqual(await deleteComment(f.api({ who: { done } }), delP()), done);
    assert.equal((await deleteComment(f.api({ who: { uid: ME, nickname: null } }), { ...delP(), nickname: null })).blocked, 'no-uid');
    assert.equal(f.writes().length, 0);
  });
});

describe('视频号拉黑', () => {
  test('来源评论在、作者不是我、没拉黑过 → blockUser 一次（modType=1）→ 回读 blacklistFlag 为真 → found', async () => {
    const f = fakeChannels({ roots: [root('c1', '甲', [l2('c2', '乙')])] });
    const r = await block(f.api(), blkP());
    assert.deepEqual([r.sendAttempted, r.readBack.found, r.readBack.nativeId], [true, true, 'c2']);
    assert.deepEqual(f.writes().map((c) => c.args), [{ refCommentId: 'c2', refObjectId: EXPORT, modType: 1 }]);
  });

  test('一楼的作者也能拉黑（不受「一楼有回复」限制，拉黑不删评论）', async () => {
    const f = fakeChannels({ roots: [root('c1', '甲', [l2('c2', '乙')])] });
    assert.equal((await block(f.api(), blkP({ commentId: 'c1', parentId: null }))).readBack.found, true);
  });

  test('已在黑名单 → already-blocked；评论是我的 → self-target；来源评论不在 → target-not-found；没有来源评论 → target-not-found；都不调接口', async () => {
    const black = fakeChannels({ roots: [root('c1', '甲', [l2('c2', '乙', { black: 1 })])] });
    assert.equal((await block(black.api(), blkP())).blocked, 'already-blocked');
    const mine = fakeChannels({ roots: [root('c1', '甲', [l2('c2', MYNICK)])] });
    assert.equal((await block(mine.api(), blkP())).blocked, 'self-target');
    const gone = fakeChannels({ roots: [root('c1', '甲')] });
    assert.equal((await block(gone.api(), blkP())).blocked, 'target-not-found');
    assert.equal((await block(gone.api(), { ...blkP(), target: { mid: null, via: 'comment', source: null } })).blocked, 'target-not-found');
    assert.equal(black.writes().length + mine.writes().length + gone.writes().length, 0);
  });

  test('回读 blacklistFlag 还是假 → found=false；接口报错 → sendError；都只调一次', async () => {
    const no = fakeChannels({ roots: [root('c1', '甲', [l2('c2', '乙')])], blk: { errCode: 0, apply: false } });
    const a = await block(no.api(), blkP());
    assert.deepEqual([a.sendAttempted, a.readBack.found], [true, false]);
    assert.match(a.readBack.detail, /blacklistFlag/);
    const err = fakeChannels({ roots: [root('c1', '甲', [l2('c2', '乙')])], blk: { errCode: -1, apply: false } });
    const b = await block(err.api(), blkP());
    assert.match(b.sendError, /errCode=-1/);
    assert.equal(b.readBack.found, false);
    assert.equal(no.writes().length + err.writes().length, 2);
  });

  test('拉黑后评论在回读里不见了（读不到这条）→ found=false，不猜成功', async () => {
    const f = fakeChannels({ roots: [root('c1', '甲', [l2('c2', '乙')])] });
    const api = f.api();
    let n = 0;
    api.call = async (m, a) => { if (m === 'getCommentList' && ++n > 1) return { ok: true, data: { errCode: 0, data: { comment: [root('c1', '甲')], downContinueFlag: 0, lastBuff: '' } } }; return f.call(m, a); };
    const r = await block(api, blkP());
    assert.deepEqual([r.sendAttempted, r.readBack.found], [true, false]);
  });
});

describe('框架接线（临时库 + 假 writer）', () => {
  const ACCT = `Channels:${ME}`;
  const snap = (comments) => ({ ok: true, platformCode: 'Channels', accountUid: ME, kind: 'comments', fetchedAt: '2026-11-19T02:00:00.000Z',
    works: [{ nativeId: WORK, title: 't', url: null, postTime: '2026-11-18T00:00:00.000Z' }], comments,
    scannedWorks: [{ workNativeId: WORK, complete: true, threadsPartial: false }], conversations: [], messages: [] });
  const cm = (id, o = {}) => ({ nativeId: id, workNativeId: WORK, parentNativeId: o.parent ?? null, rootNativeId: o.root ?? (o.parent ? null : id),
    author: { uid: null, nickname: o.nick ?? `n${id}`, isMe: o.isMe ?? false }, replyTo: null, text: 't', createdAt: '2026-11-19T01:00:00.000Z',
    likeCount: null, likedByMe: null, pinned: null, replyCount: null, ipLabel: null });
  function setup() {
    const db = freshDb(tmpDbFile());
    if (!getAccount(db, ACCT)) db.prepare('INSERT INTO accounts (platformCode, platformName, uid, nickname, profileId, spaceName, capabilities) VALUES (?, ?, ?, ?, ?, ?, ?)').run('Channels', '视频号', ME, MYNICK, 'Profile 5', `kinso/Channels/${ME}`, '{}');
    const acct = getAccount(db, ACCT);
    ingestSnapshot(db, acct, snap([]), { now: () => T0 });
    ingestSnapshot(db, acct, snap([cm('c1'), cm('c2', { parent: 'c1', root: 'c1' }), cm('m1', { parent: 'c1', root: 'c1', nick: MYNICK, isMe: true })]), { now: () => T0 + MIN });
    for (const c of ['deleteComment', 'block', 'deleteConversation']) setCapability(db, ACCT, c, true);
    const calls = [];
    const runWriter = async (a) => { calls.push(a); return { ok: true, result: { uidSeen: ME, sendAttempted: true, readBack: { found: true, count: 1, nativeId: 'c2' } } }; };
    return { db, calls, deps: { now: () => T0 + 2 * MIN, runWriter, notify: async () => true, log: () => {} } };
  }

  test('删评论：走 channels-moderate.mjs', async () => {
    const s = setup();
    const r = await engageWrite(s.db, { op: 'delete', targetId: 'Channels:c2', idempotencyKey: 'k1', caller: 't' }, s.deps);
    assert.equal(r.status, 'sent');
    assert.match(writerModuleUrl('Channels', 'delete'), /channels-moderate\.mjs$/);
    assert.equal(s.calls[0].params.target.commentId, 'c2');
  });

  test('拉黑按评论：targetId 就是这条评论，source 是它；事件只认这条评论的 comment.created，生效后回执', async () => {
    const s = setup();
    const r = await engageWrite(s.db, { op: 'block', targetId: 'Channels:c2', idempotencyKey: 'k1', eventId: 'comment.created:Channels:c2', caller: 't' }, s.deps);
    assert.deepEqual([r.status, r.targetId], ['sent', 'Channels:c2']);
    assert.deepEqual(s.calls[0].params.target, { mid: null, via: 'comment', source: { kind: 'comment', commentId: 'c2', workId: WORK, parentId: 'c1', rootId: 'c1', authorUid: null } });
    assert.deepEqual(r.ackedEvents, ['comment.created:Channels:c2']);
    const other = await engageWrite(s.db, { op: 'block', targetId: 'Channels:c2', idempotencyKey: 'k2', eventId: 'comment.created:Channels:c1', caller: 't' }, s.deps);
    assert.deepEqual([other.status, other.reason], ['rejected', 'event-mismatch']);
  });

  test('拉黑：我自己的评论 → self-target；不是评论 id → unknown-target；删会话 → unsupported-platform；都不起 writer', async () => {
    const s = setup();
    const me = await engageWrite(s.db, { op: 'block', targetId: 'Channels:m1', idempotencyKey: 'k1', caller: 't' }, s.deps);
    assert.deepEqual([me.status, me.reason], ['rejected', 'self-target']);
    const uid = await engageWrite(s.db, { op: 'block', targetId: 'Channels:someone', idempotencyKey: 'k2', caller: 't' }, s.deps);
    assert.deepEqual([uid.status, uid.reason], ['rejected', 'unknown-target']);
    const dc = await engageWrite(s.db, { op: 'deleteConversation', targetId: 'Channels:s1', idempotencyKey: 'k3', caller: 't' }, s.deps);
    assert.deepEqual([dc.status, dc.reason], ['rejected', 'unsupported-platform']);
    assert.match(dc.detail, /deleteSessionById/);
    assert.equal(s.calls.length, 0);
  });

  test('同一条评论拉黑过（sent）→ 换 key 再调返回 already-blocked，不起 writer', async () => {
    const s = setup();
    await engageWrite(s.db, { op: 'block', targetId: 'Channels:c2', idempotencyKey: 'k1', caller: 't' }, s.deps);
    const again = await engageWrite(s.db, { op: 'block', targetId: 'Channels:c2', idempotencyKey: 'k2', caller: 't' }, s.deps);
    assert.deepEqual([again.status, again.reason], ['failed', 'already-blocked']);
    assert.equal(s.calls.length, 1);
  });

  test('回读没确认 → needs_readback；同一个 key 再调不再起 writer', async () => {
    const s = setup();
    s.deps.runWriter = async (a) => { s.calls.push(a); return { ok: true, result: { uidSeen: ME, sendAttempted: true, readBack: { found: false, count: 0, detail: '回读时这条还在' } } }; };
    assert.equal((await engageWrite(s.db, { op: 'delete', targetId: 'Channels:c2', idempotencyKey: 'k1', caller: 't' }, s.deps)).status, 'needs_readback');
    assert.equal((await engageWrite(s.db, { op: 'delete', targetId: 'Channels:c2', idempotencyKey: 'k1', caller: 't' }, s.deps)).status, 'needs_readback');
    assert.equal(s.calls.length, 1);
  });
});
