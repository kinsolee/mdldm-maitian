// S7 engage 写入框架（reply_comment / send_dm 的核心）：临时 ops.db + 假 writer（不起 runner、不碰任何平台）。
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openOpsDb } from '../src/ops/db.mjs';
import { getAccount, setCapability } from '../src/ops/accounts.mjs';
import { ingestSnapshot } from '../src/ops/engage/store.mjs';
import { engageWrite, ROUND_LIMIT, LEASE_TABLE, roundKeyOf } from '../src/ops/engage/write.mjs';
import { freshDb, tmpDbFile, comment, conv, T0, MIN } from './helpers/engage-fixtures.mjs';

const BILI = 'Bili:478358005';
const HOUR = 60 * MIN;
const sha = (s) => createHash('sha256').update(s).digest('hex');

const biliComments = (comments) => ({ ok: true, platformCode: 'Bili', accountUid: '478358005', kind: 'comments', fetchedAt: '2026-11-19T02:00:00.000Z',
  works: [{ nativeId: 'BV1xx', title: '作品一', url: 'https://www.bilibili.com/video/BV1xx', postTime: '2026-11-18T00:00:00.000Z' }],
  comments: comments.map((c) => ({ ...c, workNativeId: 'BV1xx' })), scannedWorks: [{ workNativeId: 'BV1xx', complete: true, threadsPartial: false }], conversations: [], messages: [] });
const biliDms = (conversations) => ({ ok: true, platformCode: 'Bili', accountUid: '478358005', kind: 'dms', fetchedAt: '2026-11-19T02:00:00.000Z',
  works: [], comments: [], scannedWorks: [], conversations, messages: [] });

/** 库里：B站一楼 r1（别人）、楼中楼 a（别人回 r1）；会话 c1（对方最后说）、c2（我最后说）、c3（官方号）。第二轮才出事件。 */
function seed(db) {
  const acct = getAccount(db, BILI);
  ingestSnapshot(db, acct, biliComments([]), { now: () => T0 });
  ingestSnapshot(db, acct, biliComments([comment('r1', { uid: '9001', nick: '甲' }), comment('a', { parent: 'r1', root: 'r1', uid: '9002', nick: '乙' })]), { now: () => T0 + MIN });
  ingestSnapshot(db, acct, biliDms([]), { now: () => T0 });
  ingestSnapshot(db, acct, biliDms([conv('c1'), conv('c2', { by: 'me' }), { ...conv('c3'), canSend: false, peer: { uid: 'p-c3', nickname: '官方', kind: 'official' } }]), { now: () => T0 + MIN });
  for (const cap of ['reply', 'sendDM']) setCapability(db, BILI, cap, true);
}

const SENT = { uidSeen: '478358005', sendAttempted: true, readBack: { found: true, count: 1, nativeId: 'rp-new' } };

function fakeWriter(results) {
  const calls = [];
  const queue = Array.isArray(results) ? [...results] : null;
  const fn = async (args) => {
    calls.push(args);
    const r = queue ? queue.shift() : results;
    if (typeof r === 'function') return r(args);
    return r?.runnerFail ? { ok: false, ...r.runnerFail } : { ok: true, result: r };
  };
  fn.calls = calls;
  return fn;
}

function setup() {
  const file = tmpDbFile();
  const db = freshDb(file);
  seed(db);
  const notes = [];
  let clock = T0 + 2 * MIN;
  const deps = (writer, extra = {}) => ({ now: () => clock, runWriter: writer, notify: async (t) => { notes.push(t); return true; }, log: () => {}, ...extra });
  return { db, file, notes, deps, tick: (ms) => { clock += ms; }, at: (ms) => { clock = ms; } };
}

const reply = (extra = {}) => ({ op: 'reply', targetId: 'Bili:a', text: '谢谢支持', idempotencyKey: 'comment.created:Bili:a', caller: 'test-bot', ...extra });
const dm = (extra = {}) => ({ op: 'sendDM', targetId: 'Bili:c1', text: '你好呀', idempotencyKey: 'k-dm-1', caller: 'test-bot', ...extra });
const actions = (db) => db.prepare('SELECT * FROM actions ORDER BY createdAt, rowid').all();

describe('engageWrite：发出、回读、幂等', () => {
  let s;
  beforeEach(() => { s = setup(); });

  test('回读到 1 条 → sent；actions 记全字段（只记内容哈希）；对应事件自动回执 replied', async () => {
    const w = fakeWriter(SENT);
    const r = await engageWrite(s.db, reply(), s.deps(w));
    assert.equal(r.status, 'sent');
    assert.equal(r.sendAttempted, true);
    assert.deepEqual(r.readBack, { found: true, count: 1, nativeId: 'rp-new' });
    assert.deepEqual(r.ackedEvents, ['comment.created:Bili:a']);
    const [row] = actions(s.db);
    assert.equal(row.id, r.actionId);
    assert.equal(row.caller, 'test-bot');
    assert.equal(row.accountId, BILI);
    assert.equal(row.targetId, 'Bili:a');
    assert.equal(row.op, 'reply');
    assert.equal(row.textHash, sha('谢谢支持'));
    assert.equal(row.idempotencyKey, 'comment.created:Bili:a');
    assert.equal(row.eventId, 'comment.created:Bili:a');
    assert.equal(row.status, 'sent');
    assert.deepEqual(JSON.parse(row.readBack), { found: true, count: 1, nativeId: 'rp-new' });
    assert.ok(!Object.values(row).some((v) => String(v).includes('谢谢支持')), 'actions 里不存正文');
    const ev = s.db.prepare('SELECT handledOutcome, actionId FROM events WHERE id = ?').get('comment.created:Bili:a');
    assert.deepEqual({ ...ev }, { handledOutcome: 'replied', actionId: r.actionId });
  });

  test('writer 收到库里这条评论的上下文（楼、被回复的人、账号 uid）', async () => {
    const w = fakeWriter(SENT);
    await engageWrite(s.db, reply(), s.deps(w));
    const p = w.calls[0];
    assert.equal(p.account.id, BILI);
    assert.equal(p.params.op, 'reply');
    assert.equal(p.params.uid, '478358005');
    assert.equal(p.params.text, '谢谢支持');
    assert.deepEqual(p.params.target, { commentId: 'a', workId: 'BV1xx', parentId: 'r1', rootId: 'r1', authorUid: '9002', authorNickname: '乙', commentText: '评论a' });
  });

  test('同一 idempotencyKey 24 小时内成功过 → duplicate，不再调 writer；过了 24 小时，这条已回过的评论在库里就被拦下（already-replied）', async () => {
    const w = fakeWriter([SENT, { uidSeen: '478358005', sendAttempted: false, blocked: 'already-replied' }]);
    const first = await engageWrite(s.db, reply(), s.deps(w));
    s.tick(23 * HOUR);
    const dup = await engageWrite(s.db, reply(), s.deps(w));
    assert.equal(dup.status, 'duplicate');
    assert.equal(dup.previousActionId, first.actionId);
    assert.equal(w.calls.length, 1);
    s.tick(2 * HOUR);
    const later = await engageWrite(s.db, reply(), s.deps(w));
    assert.equal(w.calls.length, 1, '不再起 writer');
    assert.equal(later.status, 'failed');
    assert.equal(later.reason, 'already-replied');
  });

  test('duplicate 时带了还没回执的 eventId：照样回执 replied', async () => {
    await engageWrite(s.db, reply({ idempotencyKey: 'k1' }), s.deps(fakeWriter(SENT)));
    s.db.prepare('UPDATE events SET handledAt = NULL, handledOutcome = NULL, actionId = NULL').run();
    const dup = await engageWrite(s.db, reply({ idempotencyKey: 'k1', eventId: 'comment.created:Bili:a' }), s.deps(fakeWriter(SENT)));
    assert.equal(dup.status, 'duplicate');
    assert.equal(s.db.prepare('SELECT handledOutcome FROM events WHERE id = ?').get('comment.created:Bili:a').handledOutcome, 'replied');
  });

  test('点了发送但回读不到 → needs_readback；同一个 key 再调也不重发', async () => {
    const w = fakeWriter({ uidSeen: '478358005', sendAttempted: true, readBack: { found: false, count: 0 } });
    const r = await engageWrite(s.db, reply(), s.deps(w));
    assert.equal(r.status, 'needs_readback');
    assert.equal(r.retryable, false);
    assert.equal(s.db.prepare('SELECT handledAt FROM events WHERE id = ?').get('comment.created:Bili:a').handledAt, null, '没确认发出就不回执');
    const again = await engageWrite(s.db, reply(), s.deps(w));
    assert.equal(again.status, 'needs_readback');
    assert.equal(again.previousActionId, r.actionId);
    assert.equal(w.calls.length, 1, '绝不重试');
  });

  test('回读到 2 条也不算发出（readBackCount 必须是 1）→ needs_readback', async () => {
    const r = await engageWrite(s.db, reply(), s.deps(fakeWriter({ uidSeen: '478358005', sendAttempted: true, readBack: { found: false, count: 2 } })));
    assert.equal(r.status, 'needs_readback');
  });

  test('runner 超时或异常退出（不知道发没发）→ needs_readback，不重试', async () => {
    for (const reason of ['timeout', 'exit-code', 'no-result']) {
      const t = setup();
      const w = fakeWriter({ runnerFail: { reason, error: 'x' } });
      const r = await engageWrite(t.db, reply(), t.deps(w));
      assert.equal(r.status, 'needs_readback', reason);
      assert.equal((await engageWrite(t.db, reply(), t.deps(w))).status, 'needs_readback');
      assert.equal(w.calls.length, 1);
    }
  });

  test('点了发送、页面明确报失败 → failed send-error（没发出，可以换个 key 再来）', async () => {
    const r = await engageWrite(s.db, reply(), s.deps(fakeWriter({ uidSeen: '478358005', sendAttempted: true, sendError: 'reply/add code=12015' })));
    assert.equal(r.status, 'failed');
    assert.equal(r.reason, 'send-error');
    assert.match(r.detail, /12015/);
  });

  test('B1：成功过的 key 再调时带了别的目标的 eventId → rejected event-mismatch，不回执那个事件', async () => {
    await engageWrite(s.db, reply({ idempotencyKey: 'k-b1' }), s.deps(fakeWriter(SENT)));
    const r = await engageWrite(s.db, reply({ idempotencyKey: 'k-b1', eventId: 'comment.created:Bili:r1' }), s.deps(fakeWriter(SENT)));
    assert.deepEqual(pick(r), ['rejected', 'event-mismatch']);
    assert.equal(s.db.prepare('SELECT handledAt FROM events WHERE id = ?').get('comment.created:Bili:r1').handledAt, null);
  });

  test('G-B1：同一个 key 误用在别的目标上被拒之后，原目标再用这个 key 照样是 duplicate', async () => {
    await engageWrite(s.db, reply({ idempotencyKey: 'k-g1' }), s.deps(fakeWriter(SENT)));
    await engageWrite(s.db, reply({ idempotencyKey: 'k-g1-x', targetId: 'Bili:r1' }), s.deps(fakeWriter({ uidSeen: '478358005', sendAttempted: false, blocked: 'comment-gone' })));
    const w = fakeWriter(SENT);
    assert.equal((await engageWrite(s.db, reply({ idempotencyKey: 'k-g1', targetId: 'Bili:r1' }), s.deps(w))).reason, 'idempotency-key-reused');
    assert.equal((await engageWrite(s.db, reply({ idempotencyKey: 'k-g1' }), s.deps(w))).status, 'duplicate');
    // 只被拒过、没发过的 key 不占用：先在 r1 上被拒，再用到 a 上可以发
    s.db.prepare("UPDATE accounts SET capabilities = json_set(capabilities, '$.reply', json('false'))").run();
    await engageWrite(s.db, reply({ idempotencyKey: 'k-g1b', targetId: 'Bili:r1' }), s.deps(w));
    s.db.prepare("UPDATE accounts SET capabilities = json_set(capabilities, '$.reply', json('true'))").run();
    assert.notEqual((await engageWrite(s.db, reply({ idempotencyKey: 'k-g1b', targetId: 'Bili:x' }), s.deps(w))).reason, 'idempotency-key-reused');
  });

  test('G-B3：needs_readback 过了 24 小时，同一个 key 也不再发', async () => {
    const w = fakeWriter({ uidSeen: '478358005', sendAttempted: true, readBack: { found: false, count: 0 } });
    await engageWrite(s.db, reply(), s.deps(w));
    s.tick(3 * 24 * HOUR);
    assert.equal((await engageWrite(s.db, reply(), s.deps(w))).status, 'needs_readback');
    assert.equal(w.calls.length, 1);
  });

  test('G-B4：同一条评论换了 key：之前 sent → failed already-replied；之前 needs_readback → needs_readback；都不调 writer', async () => {
    const w = fakeWriter([SENT, { uidSeen: '478358005', sendAttempted: true, readBack: { found: false, count: 0 } }]);
    await engageWrite(s.db, reply({ idempotencyKey: 'a1' }), s.deps(w));
    assert.deepEqual(pick(await engageWrite(s.db, reply({ idempotencyKey: 'a2' }), s.deps(w))), ['failed', 'already-replied']);
    await engageWrite(s.db, reply({ idempotencyKey: 'b1', targetId: 'Bili:r1' }), s.deps(w));
    assert.equal((await engageWrite(s.db, reply({ idempotencyKey: 'b2', targetId: 'Bili:r1' }), s.deps(w))).status, 'needs_readback');
    assert.equal(w.calls.length, 2);
  });

  test('G-B4：私信换了 key：对方之后没再说话 → 不发；对方又说了新的 → 可以再发', async () => {
    const w = fakeWriter(SENT);
    await engageWrite(s.db, dm({ idempotencyKey: 'd1' }), s.deps(w));
    assert.deepEqual(pick(await engageWrite(s.db, dm({ idempotencyKey: 'd2' }), s.deps(w))), ['failed', 'last-is-me']);
    s.tick(HOUR);
    s.db.prepare("UPDATE conversations SET lastBy = 'peer', lastAt = ? WHERE id = 'Bili:c1'").run(new Date(T0 + 3 * HOUR).toISOString());
    assert.equal((await engageWrite(s.db, dm({ idempotencyKey: 'd3' }), s.deps(w))).status, 'sent');
    assert.equal(w.calls.length, 2);
  });

  test('G-B7：进程崩了留下的 pending（不是这次的 key）也会被回收成 needs_readback，并计入连续失败', async () => {
    const ins = (id, hour) => s.db.prepare(`INSERT INTO actions (id, op, caller, accountId, platformCode, targetId, textHash, idempotencyKey, status, sendAttempted, roundKey, createdAt)
      VALUES (?, 'reply', 't', ?, 'Bili', 'Bili:a', 'h', ?, 'pending', 0, ?, ?)`).run(id, BILI, `crash-${id}`, `2026-11-19T0${hour}`, `2026-11-19T0${hour}:10:00.000Z`);
    ins('p1', 3); ins('p2', 4);
    s.at(Date.parse('2026-11-19T06:00:00Z'));
    await engageWrite(s.db, dm({ idempotencyKey: 'other' }), s.deps(fakeWriter(SENT)));
    const rows = s.db.prepare("SELECT status, reason, sendAttempted FROM actions WHERE id IN ('p1','p2')").all();
    assert.deepEqual(rows.map((r) => [r.status, r.reason, r.sendAttempted]), [['needs_readback', 'interrupted', 1], ['needs_readback', 'interrupted', 1]]);
    assert.equal(getAccount(s.db, BILI).capabilities.reply, false);
    assert.equal(s.notes.length, 1);
  });

  test('X2-B1：同一评论之前 needs_readback，后来库里出现了我的回复：仍返回 target-needs-readback，不被普通预检盖掉', async () => {
    await engageWrite(s.db, reply({ idempotencyKey: 'n1' }), s.deps(fakeWriter({ uidSeen: '478358005', sendAttempted: true, readBack: { found: false, count: 0 } })));
    ingestSnapshot(s.db, getAccount(s.db, BILI), biliComments([comment('r1', { uid: '9001' }), comment('a', { parent: 'r1', root: 'r1', uid: '9002' }),
      comment('mine', { parent: 'a', root: 'r1', uid: '478358005', isMe: true })]), { now: () => T0 + 2 * MIN });
    const r = await engageWrite(s.db, reply({ idempotencyKey: 'n2' }), s.deps(fakeWriter(SENT)));
    assert.deepEqual(pick(r), ['needs_readback', 'target-needs-readback']);
  });

  test('X2-B1：私信之前 needs_readback，库里会话变成我最后说：仍返回 target-needs-readback', async () => {
    await engageWrite(s.db, dm({ idempotencyKey: 'm1' }), s.deps(fakeWriter({ uidSeen: '478358005', sendAttempted: true, readBack: { found: false, count: 0 } })));
    s.db.prepare("UPDATE conversations SET lastBy = 'me' WHERE id = 'Bili:c1'").run();
    assert.deepEqual(pick(await engageWrite(s.db, dm({ idempotencyKey: 'm2' }), s.deps(fakeWriter(SENT)))), ['needs_readback', 'target-needs-readback']);
  });

  test('X2-B2：key 已被别的目标占用、同时 eventId 也对不上 → 先报 event-mismatch', async () => {
    await engageWrite(s.db, reply({ idempotencyKey: 'k-x2', targetId: 'Bili:r1' }), s.deps(fakeWriter(SENT)));
    const r = await engageWrite(s.db, reply({ idempotencyKey: 'k-x2', eventId: 'nope' }), s.deps(fakeWriter(SENT)));
    assert.deepEqual(pick(r), ['rejected', 'event-mismatch']);
  });

  // 挑刺复审阻断：平台时间（conversations.lastAt）和本机时钟（actions.createdAt）有偏差时，换 key 不能绕过同一会话
  const skewTo = (ms) => s.db.prepare("UPDATE conversations SET lastBy = 'peer', lastAt = ? WHERE id = 'Bili:c1'").run(new Date(ms).toISOString());
  const nowMs = () => T0 + 2 * MIN;
  for (const [label, first, want] of [
    ['needs_readback', { uidSeen: '478358005', sendAttempted: true, readBack: { found: false, count: 0 } }, ['needs_readback', 'target-needs-readback']],
    ['sent', SENT, ['failed', 'last-is-me']],
  ]) {
    test(`时钟偏差：平台 lastAt 比本机快 5 秒，第一次 ${label}，换 key 再发同一会话被拦，writer 只调一次`, async () => {
      skewTo(nowMs() + 5000);
      const w = fakeWriter([first, SENT]);
      await engageWrite(s.db, dm({ idempotencyKey: 'skew1' }), s.deps(w));
      const r = await engageWrite(s.db, dm({ idempotencyKey: 'skew2' }), s.deps(w));
      assert.deepEqual(pick(r), want);
      assert.equal(w.calls.length, 1);
    });
  }

  test('时钟偏差：平台 lastAt 比本机快 5 秒，同一会话还有 pending → 换 key 被拦 in-progress', async () => {
    skewTo(nowMs() + 5000);
    s.db.prepare(`INSERT INTO actions (id, op, caller, accountId, platformCode, targetId, textHash, idempotencyKey, status, sendAttempted, roundKey, createdAt, targetLastAt)
      VALUES ('pp1', 'sendDM', 't', ?, 'Bili', 'Bili:c1', 'h', 'pk1', 'pending', 0, ?, ?, ?)`).run(BILI, roundKeyOf(nowMs()), new Date(nowMs() - MIN).toISOString(), new Date(nowMs() + 5000).toISOString());
    const w = fakeWriter(SENT);
    assert.deepEqual(pick(await engageWrite(s.db, dm({ idempotencyKey: 'pk2' }), s.deps(w))), ['rejected', 'in-progress']);
    assert.equal(w.calls.length, 0);
  });

  test('发信中对方又发了一句（lastAt 推进到 pending 之后），pending 还在 → 拦 in-progress', async () => {
    let inner;
    const w = fakeWriter(async () => {
      skewTo(nowMs() + 30_000);
      inner = await engageWrite(s.db, dm({ idempotencyKey: 'mid2' }), s.deps(fakeWriter(SENT)));
      return { ok: true, result: SENT };
    });
    await engageWrite(s.db, dm({ idempotencyKey: 'mid1' }), s.deps(w));
    assert.deepEqual(pick(inner), ['rejected', 'in-progress']);
  });

  test('X4-B1：本机比平台快——对方发了新消息（平台时间早于我的发信时间），照样可以回', async () => {
    skewTo(nowMs() - 60_000);
    const w = fakeWriter(SENT);
    assert.equal((await engageWrite(s.db, dm({ idempotencyKey: 'fast1' }), s.deps(w))).status, 'sent');
    skewTo(nowMs() - 3000);   // 对方的新消息，平台时间比本机发信时间还早 3 秒
    assert.equal((await engageWrite(s.db, dm({ idempotencyKey: 'fast2' }), s.deps(w))).status, 'sent');
    assert.equal(w.calls.length, 2);
  });

  test('X4-B1：发信时会话还没有 lastAt，对方之后说话了 → 可以回', async () => {
    s.db.prepare("UPDATE conversations SET lastBy = NULL, lastAt = NULL WHERE id = 'Bili:c1'").run();
    const w = fakeWriter(SENT);
    await engageWrite(s.db, dm({ idempotencyKey: 'nl1' }), s.deps(w));
    assert.equal(s.db.prepare("SELECT targetLastAt FROM actions WHERE idempotencyKey = 'nl1'").get().targetLastAt, '');
    skewTo(nowMs() + 60_000);
    assert.equal((await engageWrite(s.db, dm({ idempotencyKey: 'nl2' }), s.deps(w))).status, 'sent');
  });

  test('X4-B2：旧库升级来的 sent 私信（targetLastAt 为 NULL）判断不了，保守拦，平台时间领先也不放行', async () => {
    skewTo(nowMs() + 5000);
    s.db.prepare(`INSERT INTO actions (id, op, caller, accountId, platformCode, targetId, textHash, idempotencyKey, status, sendAttempted, roundKey, createdAt, finishedAt)
      VALUES ('old1', 'sendDM', 't', ?, 'Bili', 'Bili:c1', 'h', 'oldk', 'sent', 1, ?, ?, ?)`).run(BILI, roundKeyOf(nowMs()), new Date(nowMs()).toISOString(), new Date(nowMs()).toISOString());
    const w = fakeWriter(SENT);
    assert.deepEqual(pick(await engageWrite(s.db, dm({ idempotencyKey: 'newk' }), s.deps(w))), ['failed', 'last-is-me']);
    assert.equal(w.calls.length, 0);
  });

  test('保守：私信点了发送没确认（needs_readback），对方之后又说了新的也不放行，直到人工处理', async () => {
    await engageWrite(s.db, dm({ idempotencyKey: 'cv1' }), s.deps(fakeWriter({ uidSeen: '478358005', sendAttempted: true, readBack: { found: false, count: 0 } })));
    s.tick(HOUR);
    skewTo(nowMs() + 2 * HOUR);
    const w = fakeWriter(SENT);
    assert.deepEqual(pick(await engageWrite(s.db, dm({ idempotencyKey: 'cv2' }), s.deps(w))), ['needs_readback', 'target-needs-readback']);
    assert.equal(w.calls.length, 0);
  });

  // 挑刺复审：needs_readback 被拦时写下的审计行（sendAttempted=0）不能变成新的拦截源
  for (const [label, fix] of [
    ['人工改成 failed', (db, id) => db.prepare("UPDATE actions SET status = 'failed', reason = 'human-cleared' WHERE id = ? AND status = 'needs_readback' AND sendAttempted = 1").run(id)],
    ['人工改成 sent + 对方又发了新消息', (db, id) => {
      const r = db.prepare("UPDATE actions SET status = 'sent', reason = 'human-confirmed' WHERE id = ? AND status = 'needs_readback' AND sendAttempted = 1").run(id);
      if (r.changes) db.prepare("UPDATE conversations SET lastBy = 'peer', lastAt = '2026-11-19T05:00:00.000Z' WHERE id = 'Bili:c1'").run();
      return r;
    }],
  ]) {
    test(`needs_readback 被拦的审计行不锁死会话：同 key、换 key 都指向原记录，${label}后能正常发`, async () => {
      const w = fakeWriter([{ uidSeen: '478358005', sendAttempted: true, readBack: { found: false, count: 0 } }, SENT, SENT]);
      const a1 = await engageWrite(s.db, dm({ idempotencyKey: 'sh1' }), s.deps(w));
      assert.equal(a1.status, 'needs_readback');
      const same = await engageWrite(s.db, dm({ idempotencyKey: 'sh1' }), s.deps(w));
      assert.deepEqual([same.status, same.previousActionId], ['needs_readback', a1.actionId]);
      const other = await engageWrite(s.db, dm({ idempotencyKey: 'sh2' }), s.deps(w));
      assert.deepEqual([other.status, other.reason, other.previousActionId], ['needs_readback', 'target-needs-readback', a1.actionId]);
      const again = await engageWrite(s.db, dm({ idempotencyKey: 'sh2' }), s.deps(w));
      assert.equal(again.previousActionId, a1.actionId, '审计行不会变成新的 previousActionId');
      assert.equal(fix(s.db, a1.actionId).changes, 1);
      const okNew = await engageWrite(s.db, dm({ idempotencyKey: 'sh3' }), s.deps(w));
      assert.equal(okNew.status, 'sent', JSON.stringify(okNew));
      assert.equal(w.calls.length, 2);
      // 文档 SQL 带 sendAttempted = 1：拿审计行的 id 改不动
      assert.equal(fix(s.db, other.actionId).changes, 0);
    });
  }

  test('同一 key 用在别的目标上 → rejected', async () => {
    await engageWrite(s.db, reply({ idempotencyKey: 'same' }), s.deps(fakeWriter(SENT)));
    const r = await engageWrite(s.db, reply({ idempotencyKey: 'same', targetId: 'Bili:r1' }), s.deps(fakeWriter(SENT)));
    assert.equal(r.status, 'rejected');
    assert.equal(r.reason, 'idempotency-key-reused');
  });

  test('私信发出：回执这个会话所有没回执的 dm.received', async () => {
    const r = await engageWrite(s.db, dm(), s.deps(fakeWriter({ uidSeen: '478358005', sendAttempted: true, readBack: { found: true, count: 1, nativeId: 'm1' } })));
    assert.equal(r.status, 'sent');
    assert.deepEqual(r.ackedEvents, ['dm.received:Bili:c1:2026-11-19T01:00:00.000Z']);
  });
});

describe('engageWrite：发前重读', () => {
  let s;
  beforeEach(() => { s = setup(); });

  for (const blocked of ['comment-gone', 'already-replied', 'target-not-found', 'uid-mismatch', 'no-uid']) {
    test(`页面上重读：${blocked} → failed，没点发送，同一个 key 之后还能再试`, async () => {
      const w = fakeWriter([{ uidSeen: '478358005', sendAttempted: false, blocked, detail: '说明' }, SENT]);
      const r = await engageWrite(s.db, reply(), s.deps(w));
      assert.equal(r.status, 'failed');
      assert.equal(r.reason, blocked);
      assert.equal(r.sendAttempted, false);
      assert.equal((await engageWrite(s.db, reply(), s.deps(w))).status, 'sent');
    });
  }

  test('私信：会话最后一句已是我（页面重读）→ failed last-is-me', async () => {
    const r = await engageWrite(s.db, dm(), s.deps(fakeWriter({ uidSeen: '478358005', sendAttempted: false, blocked: 'last-is-me' })));
    assert.equal(r.status, 'failed');
    assert.equal(r.reason, 'last-is-me');
  });

  test('库里已标 gone 的评论：不起 runner，直接 failed comment-gone', async () => {
    s.db.prepare("UPDATE comments SET goneAt = '2026-11-19T02:00:00.000Z' WHERE id = 'Bili:a'").run();
    const w = fakeWriter(SENT);
    const r = await engageWrite(s.db, reply(), s.deps(w));
    assert.deepEqual([r.status, r.reason], ['failed', 'comment-gone']);
    assert.equal(w.calls.length, 0);
  });

  test('库里已有我对这条的直接回复：直接 failed already-replied', async () => {
    ingestSnapshot(s.db, getAccount(s.db, BILI), biliComments([comment('r1', { uid: '9001' }), comment('a', { parent: 'r1', root: 'r1', uid: '9002' }),
      comment('mine', { parent: 'a', root: 'r1', uid: '478358005', isMe: true })]), { now: () => T0 + 2 * MIN });
    const w = fakeWriter(SENT);
    const r = await engageWrite(s.db, reply(), s.deps(w));
    assert.deepEqual([r.status, r.reason], ['failed', 'already-replied']);
    assert.equal(w.calls.length, 0);
  });

  test('库里会话最后一句是我、或对方不能收私信：直接 failed', async () => {
    const w = fakeWriter(SENT);
    assert.deepEqual(pick(await engageWrite(s.db, dm({ targetId: 'Bili:c2', idempotencyKey: 'k2' }), s.deps(w))), ['failed', 'last-is-me']);
    assert.deepEqual(pick(await engageWrite(s.db, dm({ targetId: 'Bili:c3', idempotencyKey: 'k3' }), s.deps(w))), ['failed', 'cannot-send']);
    assert.equal(w.calls.length, 0);
  });

  test('落到登录页 → failed login-lost；space 被占 → failed space-busy 可重试', async () => {
    assert.deepEqual(pick(await engageWrite(s.db, reply({ idempotencyKey: 'x1' }), s.deps(fakeWriter({ loginLost: true, evidence: 'nav' })))), ['failed', 'login-lost']);
    const busy = await engageWrite(s.db, reply({ idempotencyKey: 'x2' }), s.deps(fakeWriter({ runnerFail: { reason: 'busy', error: '占用' } })));
    assert.deepEqual(pick(busy), ['failed', 'space-busy']);
    assert.equal(busy.retryable, true);
  });
});

const pick = (r) => [r.status, r.reason];

describe('engageWrite：拒绝', () => {
  let s;
  beforeEach(() => { s = setup(); });

  test('能力位没开 → rejected capability-off，不起 runner，也记 actions', async () => {
    setCapability(s.db, BILI, 'reply', false);
    const w = fakeWriter(SENT);
    const r = await engageWrite(s.db, reply(), s.deps(w));
    assert.deepEqual(pick(r), ['rejected', 'capability-off']);
    assert.equal(w.calls.length, 0);
    assert.equal(actions(s.db)[0].status, 'rejected');
    // sendDM 能力位独立
    assert.equal((await engageWrite(s.db, dm(), s.deps(fakeWriter(SENT)))).status, 'sent');
  });

  test('库里没有这条评论 / 平台不在评论私信范围 / eventId 对不上 → rejected', async () => {
    const w = fakeWriter(SENT);
    assert.deepEqual(pick(await engageWrite(s.db, reply({ targetId: 'Bili:nope', idempotencyKey: 'n1' }), s.deps(w))), ['rejected', 'unknown-target']);
    assert.deepEqual(pick(await engageWrite(s.db, reply({ targetId: 'Weibo:1', idempotencyKey: 'n2' }), s.deps(w))), ['rejected', 'unsupported-platform']);
    assert.deepEqual(pick(await engageWrite(s.db, reply({ idempotencyKey: 'n3', eventId: 'comment.created:Bili:r1' }), s.deps(w))), ['rejected', 'event-mismatch']);
    assert.deepEqual(pick(await engageWrite(s.db, reply({ idempotencyKey: 'n4', eventId: 'nope' }), s.deps(w))), ['rejected', 'event-mismatch']);
    assert.equal(w.calls.length, 0);
  });

  test('参数不对直接抛错', async () => {
    const d = s.deps(fakeWriter(SENT));
    await assert.rejects(engageWrite(s.db, reply({ text: '  ' }), d), /text/);
    await assert.rejects(engageWrite(s.db, reply({ text: 'x'.repeat(1001) }), d), /text/);
    await assert.rejects(engageWrite(s.db, reply({ idempotencyKey: '' }), d), /idempotencyKey/);
    await assert.rejects(engageWrite(s.db, reply({ targetId: 'abc' }), d), /<platformCode>:<原生 id>/);
  });

  test(`每平台每轮（整点小时）最多 ${ROUND_LIMIT} 条，下一轮恢复`, async () => {
    s.at(Date.parse('2026-11-19T03:00:00Z'));
    const extra = [];
    for (let i = 0; i < ROUND_LIMIT + 1; i++) extra.push(comment(`x${i}`, { uid: `u${i}` }));
    ingestSnapshot(s.db, getAccount(s.db, BILI), biliComments([comment('r1', { uid: '9001' }), comment('a', { parent: 'r1', root: 'r1', uid: '9002' }), ...extra]), { now: () => T0 + 3 * MIN });
    const w = fakeWriter(SENT);
    for (let i = 0; i < ROUND_LIMIT; i++) {
      s.tick(MIN);
      assert.equal((await engageWrite(s.db, reply({ targetId: `Bili:x${i}`, idempotencyKey: `r${i}` }), s.deps(w))).status, 'sent');
    }
    const over = await engageWrite(s.db, reply({ targetId: `Bili:x${ROUND_LIMIT}`, idempotencyKey: 'over' }), s.deps(w));
    assert.deepEqual(pick(over), ['rejected', 'round-limit']);
    assert.equal(over.retryable, true);
    s.at(Date.parse('2026-11-19T04:00:00Z'));
    assert.equal((await engageWrite(s.db, reply({ targetId: `Bili:x${ROUND_LIMIT}`, idempotencyKey: 'over' }), s.deps(w))).status, 'sent');
  });

  test('平台写入租约被别的写入方持有 → rejected lease-busy；过期的可以接管；写完释放', async () => {
    s.db.prepare(`INSERT INTO ${LEASE_TABLE} (platformCode, holder, acquiredAt, expiresAt) VALUES ('Bili', 'other', ?, ?)`)
      .run(new Date(T0).toISOString(), new Date(T0 + 10 * MIN).toISOString());
    const w = fakeWriter(SENT);
    const r = await engageWrite(s.db, reply(), s.deps(w));
    assert.deepEqual(pick(r), ['rejected', 'lease-busy']);
    assert.equal(r.retryable, true);
    assert.equal(w.calls.length, 0);
    s.tick(10 * MIN);
    assert.equal((await engageWrite(s.db, reply(), s.deps(w))).status, 'sent');
    assert.equal(s.db.prepare(`SELECT count(*) n FROM ${LEASE_TABLE}`).get().n, 0);
  });

  test('writer 跑的时候持有租约：别的调用这时被拒', async () => {
    let inner;
    const w = fakeWriter(async () => {
      inner = await engageWrite(s.db, reply({ targetId: 'Bili:r1', idempotencyKey: 'inner' }), s.deps(fakeWriter(SENT)));
      return { ok: true, result: SENT };
    });
    await engageWrite(s.db, reply(), s.deps(w));
    assert.deepEqual(pick(inner), ['rejected', 'lease-busy']);
  });
});

describe('engageWrite：同一平台连续 2 轮写入失败自动关写能力位', () => {
  let s;
  beforeEach(() => { s = setup(); });
  const failing = { uidSeen: '478358005', sendAttempted: true, sendError: 'code=-500' };

  test('两轮（两个整点小时）都失败 → 关掉该平台 reply、sendDM，发一次提醒；之后被拒', async () => {
    s.at(Date.parse('2026-11-19T03:10:00Z'));
    const r1 = await engageWrite(s.db, reply({ idempotencyKey: 'f1' }), s.deps(fakeWriter(failing)));
    assert.equal(r1.writeDisabled, false);
    assert.equal(getAccount(s.db, BILI).capabilities.reply, true);
    s.at(Date.parse('2026-11-19T05:10:00Z'));   // 中间没写入的小时不打断「连续」
    const r2 = await engageWrite(s.db, dm({ idempotencyKey: 'f2' }), s.deps(fakeWriter({ uidSeen: '478358005', sendAttempted: true, readBack: { found: false, count: 0 } })));
    assert.equal(r2.status, 'needs_readback');
    assert.equal(r2.writeDisabled, true);
    const caps = getAccount(s.db, BILI).capabilities;
    assert.equal(caps.reply, false);
    assert.equal(caps.sendDM, false);
    assert.equal(s.notes.length, 1);
    assert.match(s.notes[0], /B站/);
    assert.match(s.notes[0], /set-cap/);
    assert.deepEqual(pick(await engageWrite(s.db, reply({ idempotencyKey: 'f3' }), s.deps(fakeWriter(SENT)))), ['rejected', 'capability-off']);
  });

  test('X2-B3：回收崩溃留下的 pending 触发自动关 → 这次调用返回 capability-off 且 writeDisabled:true', async () => {
    const ins = (id, hour) => s.db.prepare(`INSERT INTO actions (id, op, caller, accountId, platformCode, targetId, textHash, idempotencyKey, status, sendAttempted, roundKey, createdAt)
      VALUES (?, 'reply', 't', ?, 'Bili', 'Bili:a', 'h', ?, 'pending', 0, ?, ?)`).run(id, BILI, `crash-${id}`, `2026-11-19T0${hour}`, `2026-11-19T0${hour}:10:00.000Z`);
    ins('q1', 3); ins('q2', 4);
    s.at(Date.parse('2026-11-19T06:00:00Z'));
    const r = await engageWrite(s.db, dm({ idempotencyKey: 'x2b3' }), s.deps(fakeWriter(SENT)));
    assert.deepEqual(pick(r), ['rejected', 'capability-off']);
    assert.equal(r.writeDisabled, true);
    // 下一次调用不是这次触发的，writeDisabled 回到 false
    assert.equal((await engageWrite(s.db, dm({ idempotencyKey: 'x2b3b' }), s.deps(fakeWriter(SENT)))).writeDisabled, false);
  });

  test('同一轮里有一条成功就不算这轮失败；重读拦下的不算写入失败', async () => {
    s.at(Date.parse('2026-11-19T03:10:00Z'));
    await engageWrite(s.db, reply({ idempotencyKey: 'g1' }), s.deps(fakeWriter(failing)));
    await engageWrite(s.db, dm({ idempotencyKey: 'g2' }), s.deps(fakeWriter({ uidSeen: '478358005', sendAttempted: true, readBack: { found: true, count: 1 } })));
    s.at(Date.parse('2026-11-19T04:10:00Z'));
    await engageWrite(s.db, reply({ idempotencyKey: 'g3' }), s.deps(fakeWriter({ uidSeen: '478358005', sendAttempted: false, blocked: 'comment-gone' })));
    const r = await engageWrite(s.db, reply({ idempotencyKey: 'g4', targetId: 'Bili:r1' }), s.deps(fakeWriter(failing)));
    assert.equal(r.writeDisabled, false);
    assert.equal(getAccount(s.db, BILI).capabilities.reply, true);
    assert.equal(s.notes.length, 0);
  });

  test('提醒没发出：下一次调用时补发，发出后不再发', async () => {
    s.at(Date.parse('2026-11-19T03:10:00Z'));
    let ok = false;
    const notes = [];
    const notify = async (t) => { notes.push(t); return ok; };
    await engageWrite(s.db, reply({ idempotencyKey: 'h1' }), s.deps(fakeWriter(failing), { notify }));
    s.at(Date.parse('2026-11-19T04:10:00Z'));
    await engageWrite(s.db, reply({ idempotencyKey: 'h2', targetId: 'Bili:r1' }), s.deps(fakeWriter(failing), { notify }));
    assert.equal(notes.length, 1);
    ok = true;
    await engageWrite(s.db, dm({ idempotencyKey: 'h3' }), s.deps(fakeWriter(SENT), { notify }));
    assert.equal(notes.length, 2);
    await engageWrite(s.db, dm({ idempotencyKey: 'h4' }), s.deps(fakeWriter(SENT), { notify }));
    assert.equal(notes.length, 2);
  });
});

describe('engage-db 升级', () => {
  test('旧库（没有 actions、写入租约表）打开后补上新表，旧数据不动', () => {
    const file = tmpDbFile();
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE accounts (platformCode TEXT NOT NULL, platformName TEXT NOT NULL, uid TEXT NOT NULL, nickname TEXT, profileId TEXT NOT NULL DEFAULT 'Profile 5',
      spaceName TEXT NOT NULL, loginState TEXT NOT NULL DEFAULT 'unknown', loginCheckedAt TEXT, loginEvidence TEXT, capabilities TEXT NOT NULL, alertSentAt TEXT, PRIMARY KEY (platformCode, uid));
      INSERT INTO accounts (platformCode, platformName, uid, spaceName, capabilities) VALUES ('Bili', 'B站', '478358005', 'kinso/Bili/478358005', '{"reply":true}');
      CREATE TABLE events (id TEXT PRIMARY KEY, type TEXT NOT NULL, platformCode TEXT NOT NULL, accountId TEXT, subjectId TEXT, createdAt TEXT NOT NULL, payload TEXT NOT NULL,
        handledAt TEXT, handledOutcome TEXT, handledNote TEXT, actionId TEXT);
      INSERT INTO events (id, type, platformCode, createdAt, payload) VALUES ('e1', 'comment.created', 'Bili', '2026-11-19T00:00:00.000Z', '{}');`);
    old.close();
    const db = openOpsDb(file);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    assert.ok(tables.includes('actions'));
    assert.ok(tables.includes(LEASE_TABLE));
    assert.equal(db.prepare('SELECT count(*) n FROM events').get().n, 1);
    assert.equal(getAccount(db, BILI).capabilities.reply, true);
    db.close();
    openOpsDb(file).close();   // 再开一次也不报错
  });

  test('本分支早期建的 actions（没有 targetLastAt 列）打开后补上这一列', () => {
    const file = tmpDbFile();
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE actions (id TEXT PRIMARY KEY, op TEXT NOT NULL, caller TEXT, accountId TEXT, platformCode TEXT NOT NULL, targetId TEXT NOT NULL,
      textHash TEXT NOT NULL, idempotencyKey TEXT NOT NULL, eventId TEXT, status TEXT NOT NULL, reason TEXT, detail TEXT, sendAttempted INTEGER NOT NULL DEFAULT 0, readBack TEXT,
      roundKey TEXT NOT NULL, createdAt TEXT NOT NULL, finishedAt TEXT);
      INSERT INTO actions (id, op, platformCode, targetId, textHash, idempotencyKey, status, roundKey, createdAt) VALUES ('a1', 'sendDM', 'Bili', 'Bili:c1', 'h', 'k', 'sent', '2026-11-19T00', '2026-11-19T00:00:00.000Z');`);
    old.close();
    const db = openOpsDb(file);
    assert.ok(db.prepare('PRAGMA table_info(actions)').all().some((c) => c.name === 'targetLastAt'));
    assert.equal(db.prepare('SELECT targetLastAt FROM actions WHERE id = ?').get('a1').targetLastAt, null);
    db.close();
  });
});

describe('runWriterInSpace', () => {
  test('在账号自己的 space、Profile 5 里跑对应平台的写入模块（runner 默认持 space 锁）', async () => {
    const { runWriterInSpace, WRITER_FILES, WRITE_TIMEOUT_MS } = await import('../src/ops/engage/writers/index.mjs');
    const { fileURLToPath } = await import('node:url');
    const fs = await import('node:fs');
    const db = freshDb();
    const seen = [];
    const runner = async (o) => { seen.push(o); return { ok: true, result: {} }; };
    await runWriterInSpace({ account: getAccount(db, BILI), params: { op: 'reply', text: 't' } }, { runner });
    const o = seen[0];
    assert.equal(o.space, 'kinso/Bili/478358005');
    assert.equal(o.profileId, 'Profile 5');
    assert.equal(o.timeoutMs, WRITE_TIMEOUT_MS.Bili);
    assert.equal(o.lock, undefined, '不关 space 锁');
    assert.ok(fs.existsSync(fileURLToPath(o.params.moduleUrl)));
    assert.match(o.params.moduleUrl, new RegExp(`/writers/${WRITER_FILES.Bili}$`));
    assert.match(o.script, /runInSpace\(task, params\)/);
  });
});

describe('页面写入：点发送之前出错', () => {
  for (const plat of ['douyin', 'channels', 'xhs']) {
    test(`${plat}：打开页面就出错 → blocked precheck-error、sendAttempted:false（不抛错，框架记 failed 而不是 needs_readback）`, async () => {
      const m = await import(`../src/ops/engage/writers/${plat}.mjs`);
      const task = { pages: async () => { throw new Error('页面没起来 token=abc'); } };
      const r = await m.runInSpace(task, { op: 'reply', uid: '1', text: '你好', target: {} });
      assert.equal(r.blocked, 'precheck-error');
      assert.equal(r.sendAttempted, false);
      assert.ok(!r.detail.includes('abc'), '错误文字已脱敏');
    });
  }
  test('框架：precheck-error → failed、可重试', async () => {
    const s = setup();
    const r = await engageWrite(s.db, reply(), s.deps(fakeWriter({ uidSeen: null, sendAttempted: false, blocked: 'precheck-error', detail: 'x' })));
    assert.deepEqual([r.status, r.reason, r.retryable], ['failed', 'precheck-error', true]);
  });
});
