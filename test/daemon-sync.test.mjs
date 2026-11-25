// 抓取轮：注入假 collect，不起 Ego、不连真实平台；临时库、临时锁路径；推送只发到本机假 bot。
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { setCapability } from '../src/ops/accounts.mjs';
import { requestRefresh, getJob, startJob, createJob, STALE_RUNNING_MS } from '../src/ops/engage/store.mjs';
import { subscribe } from '../src/ops/engage/subscribers.mjs';
import { runRound, shouldStartRound, makeEngageTicker, engageStatus, redact } from '../src/daemon/sync.mjs';
import { stableNodeExecPath } from '../src/ops/node-bin.mjs';
import { acquireRoundLock } from '../src/daemon/round-lock.mjs';
import { startFakeBot, verify } from './helpers/fake-bot.mjs';
import { freshDb, comment, commentsSnap, conv, dmsSnap, T0, MIN } from './helpers/engage-fixtures.mjs';

const DOUYIN = 'Douyin:106707338905';
const timeZone = 'Asia/Taipei';   // T0 = 台湾 10:00
const tmpLock = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'engage-lock-')), 'engage-sync.lock');

let bots = [];
afterEach(async () => { await Promise.all(bots.map((b) => b.close())); bots = []; });

function clock(t = T0) {
  const c = { t, now: () => c.t, advance: (ms) => { c.t += ms; } };
  return c;
}

function fakeNotify() {
  const sent = [];
  return { sent, notify: async (text) => { sent.push(text); return true; } };
}

// 假适配器：按 (platformCode, kind) 依次返回脚本里的结果，记录调用
function fakeCollect(script) {
  const calls = [];
  const collect = async ({ account, kind }) => {
    calls.push(`${account.platformCode}/${kind}`);
    const q = script[`${account.platformCode}/${kind}`];
    const r = Array.isArray(q) ? q.shift() : q;
    if (r instanceof Error) throw r;
    if (typeof r === 'function') return r();
    return r ?? { ok: false, reason: 'parse', error: '脚本里没写这一次' };
  };
  return { calls, collect };
}

function setup({ caps = [[DOUYIN, 'readComments']] } = {}) {
  const db = freshDb();
  for (const [id, cap] of caps) setCapability(db, id, cap, true);
  const c = clock();
  const n = fakeNotify();
  const logs = [];
  const base = { now: c.now, notify: n.notify, lockPath: tmpLock(), timeZone, log: (s) => logs.push(s), fetchImpl: async () => { throw new Error('不该发网络请求'); } };
  return { db, c, n, logs, base };
}

const jobsOf = (db) => db.prepare('SELECT * FROM sync_jobs ORDER BY requestedAt, rowid').all();
const events = (db, type) => db.prepare('SELECT * FROM events WHERE type = ? ORDER BY createdAt').all(type);

describe('一轮抓取', () => {
  test('两轮数据：第二轮只对新增出事件，一轮结束推一批给 bot，签名可验', async () => {
    const { db, c, base, logs } = setup();
    const bot = await startFakeBot();
    bots.push(bot);
    const { secret } = subscribe(db, { subscriberId: 'bot-a', url: bot.url, types: ['comment.created'] }, { now: c.now });
    bot.secret = secret;
    const { collect, calls } = fakeCollect({ 'Douyin/comments': [
      commentsSnap([comment('c1'), comment('c2')]),
      commentsSnap([comment('c1'), comment('c2'), comment('c3', { text: '机密正文不进日志' }), comment('c4', { parent: 'c1' })]),
    ] });
    const opts = { ...base, collect, fetchImpl: fetch };

    const r1 = await runRound(db, opts);
    assert.equal(r1.ran, true);
    assert.deepEqual(calls, ['Douyin/comments'], '只抓开了能力位的抖音评论');
    assert.equal(r1.jobs[0].status, 'ok');
    assert.equal(r1.jobs[0].stats.events, 0, '首轮只入库不出事件');
    assert.equal(bot.received.length, 0);

    c.advance(15 * MIN);
    const r2 = await runRound(db, opts);
    assert.deepEqual(r2.jobs.map((j) => j.status), ['ok']);
    assert.deepEqual(r2.jobs[0].stats, { inserted: 2, updated: 3, gone: 0, events: 2 }, '作品行算在 updated 里');
    assert.deepEqual(events(db, 'comment.created').map((e) => e.subjectId).sort(), ['Douyin:c3', 'Douyin:c4']);
    // c4 是网友回网友的楼中楼：不再按 peer-reply 过滤，和 c3 一起推给订阅方
    assert.equal(bot.received.length, 1);
    assert.deepEqual(bot.received[0].body.events.map((e) => e.subjectId).sort(), ['Douyin:c3', 'Douyin:c4']);
    assert.equal(r2.delivery.filtered, 0);
    assert.ok(verify(secret, bot.received[0].raw, bot.received[0].headers['x-maitian-signature']));
    assert.equal(r2.delivery.batches, 1);
    const jobLog = logs.filter((l) => l.includes('Douyin comments'));
    assert.match(jobLog.at(-1), /ok 新增 2 更新 3 消失 0 事件 2/);
    assert.ok(!logs.join('\n').includes('机密正文'), '日志不打印评论正文');
    assert.ok(!logs.join('\n').includes('should-not-leak'), '日志不打印订阅地址的 query');
  });

  test('评论一入库就过滤：已有事件的评论在后来的快照里 authorIsMe 变为 1，同一轮后面的任务还没跑完时已经回执 skipped、补漏捞不到，任务完成时已落库', async () => {
    const { db, c, base, logs } = setup({ caps: [[DOUYIN, 'readComments'], [DOUYIN, 'readDM']] });
    let seenDuringRound = null;
    const { collect } = fakeCollect({
      'Douyin/comments': [
        commentsSnap([comment('c1')]),
        commentsSnap([comment('c1'), comment('c4', { isMe: false })]),
        commentsSnap([comment('c1'), comment('c4', { isMe: true })]),
      ],
      'Douyin/dms': [dmsSnap([]), dmsSnap([]), () => {
        seenDuringRound = db.prepare("SELECT e.handledOutcome, e.filteredReason, j.status FROM events e, sync_jobs j WHERE e.id = 'comment.created:Douyin:c4' AND j.kind = 'comments' ORDER BY j.requestedAt DESC LIMIT 1").get();
        return dmsSnap([]);
      }],
    });
    const fetchImpl = async () => { throw new Error('不该发网络请求'); };
    await runRound(db, { ...base, collect, fetchImpl });
    c.advance(15 * MIN);
    const r2 = await runRound(db, { ...base, collect, fetchImpl });
    assert.equal(r2.delivery.filtered, 0);
    assert.equal(db.prepare("SELECT handledAt FROM events WHERE id = 'comment.created:Douyin:c4'").get().handledAt, null);
    c.advance(15 * MIN);
    const r3 = await runRound(db, { ...base, collect, fetchImpl });
    assert.equal(r3.jobs.find((j) => j.kind === 'comments').stats.events, 0);
    assert.deepEqual({ ...seenDuringRound }, { handledOutcome: 'skipped', filteredReason: 'self-author', status: 'ok' });
    assert.deepEqual(r3.jobs.find((j) => j.kind === 'comments').filtered, [{ eventId: 'comment.created:Douyin:c4', rule: 'self-author' }]);
    assert.equal(r3.delivery.filtered, 1, '入库后过滤的也算进本轮汇总，只算一次');
    assert.equal(logs.filter((l) => /过滤 1 条（self-author 1），已回执 skipped/.test(l)).length, 1);
  });

  test('推送出错时，入库后已过滤的条数照样进汇总和日志', async () => {
    const { db, c, base, logs } = setup();
    db.prepare("INSERT INTO subscribers (id, url, types, platforms, secret, createdAt, updatedAt) VALUES ('bot-a', 'http://127.0.0.1:9/h', 'not json', NULL, 's', ?, ?)").run(new Date(T0).toISOString(), new Date(T0).toISOString());
    const { collect } = fakeCollect({ 'Douyin/comments': [
      commentsSnap([comment('c1')]),
      commentsSnap([comment('c1'), comment('c4', { isMe: false })]),
      commentsSnap([comment('c1'), comment('c4', { isMe: true })]),
    ] });
    await runRound(db, { ...base, collect });
    c.advance(15 * MIN);
    await runRound(db, { ...base, collect });
    c.advance(15 * MIN);
    const r = await runRound(db, { ...base, collect });
    assert.ok(r.delivery.error, '订阅方的 types 坏了，推送出错');
    assert.equal(r.delivery.filtered, 1);
    assert.ok(logs.some((l) => /过滤 1 条（self-author 1），已回执 skipped/.test(l)));
  });

  test('busy / user-controlled 记 skipped，不出事件、不算失败', async () => {
    const { db, c, base, n } = setup();
    const { collect } = fakeCollect({ 'Douyin/comments': [
      { ok: false, skipped: 'busy', error: 'space 被占' }, { ok: false, skipped: 'user-controlled', error: '负责人在操作' }, { ok: false, skipped: 'busy' } ] });
    for (let i = 0; i < 3; i++) { await runRound(db, { ...base, collect }); c.advance(15 * MIN); }
    assert.deepEqual(jobsOf(db).map((j) => [j.status, j.error]), [['skipped', 'busy'], ['skipped', 'user-controlled'], ['skipped', 'busy']]);
    assert.equal(db.prepare('SELECT count(*) n FROM events').get().n, 0);
    assert.equal(n.sent.length, 0);
  });

  test('login-lost：出 login_lost、飞书一次；6 小时内第二次不再发', async () => {
    const { db, c, base, n } = setup();
    const lost = { ok: false, reason: 'login-lost', error: '跳到了登录页 https://creator.douyin.com/login?token=abc123&x=1 cookie=sessionid_xyz' };
    const { collect } = fakeCollect({ 'Douyin/comments': [lost, lost, lost] });
    await runRound(db, { ...base, collect });
    c.advance(15 * MIN);
    await runRound(db, { ...base, collect });
    assert.equal(events(db, 'account.login_lost').length, 1);
    const cards = n.sent.filter((t) => t.includes('掉线'));
    assert.equal(cards.length, 1);
    assert.ok(cards[0].includes(DOUYIN));
    assert.ok(!/abc123|sessionid_xyz|\?token/.test(n.sent.join('\n')), '飞书里不带 query 和 cookie');
    assert.ok(!/abc123|sessionid_xyz/.test(jobsOf(db).map((j) => j.error).join('\n')), '库里的 error 也去敏');
    assert.deepEqual(jobsOf(db).map((j) => j.status), ['failed', 'failed']);
    c.advance(6 * 60 * MIN);
    await runRound(db, { ...base, collect });
    assert.equal(events(db, 'account.login_lost').length, 2, '过了 6 小时再出一次');
    assert.equal(n.sent.filter((t) => t.includes('掉线')).length, 2);
  });

  test('连续 2 轮失败出 sync.failed、飞书一次；第 3 次不再发；异常抛出也算失败', async () => {
    const { db, c, base, n } = setup();
    const { collect } = fakeCollect({ 'Douyin/comments': [
      { ok: false, reason: 'timeout', error: '脚本超时' }, new Error('runner 炸了 xsec_token=SECRET1'), { ok: false, reason: 'profile-rejected', error: 'Profile 7' } ] });
    await runRound(db, { ...base, collect });
    assert.equal(events(db, 'sync.failed').length, 0);
    c.advance(15 * MIN);
    await runRound(db, { ...base, collect });
    const sf = events(db, 'sync.failed');
    assert.equal(sf.length, 1);
    assert.equal(n.sent.length, 1);
    assert.match(n.sent[0], /抖音评论抓取连续 2 次失败/);
    assert.ok(!n.sent[0].includes('SECRET1'));
    c.advance(15 * MIN);
    await runRound(db, { ...base, collect });
    assert.equal(events(db, 'sync.failed').length, 1);
    assert.equal(n.sent.length, 1);
    assert.deepEqual(jobsOf(db).map((j) => j.status), ['failed', 'failed', 'failed']);
  });

  test('单个任务出错不影响同轮其他任务', async () => {
    const { db, base } = setup({ caps: [[DOUYIN, 'readComments'], [DOUYIN, 'readDM'], ['Bili:478358005', 'readComments']] });
    const { collect, calls } = fakeCollect({
      'Douyin/comments': new Error('炸了'),
      'Douyin/dms': dmsSnap([conv('k1')]),
      'Bili/comments': { ...commentsSnap([comment('b1')]), platformCode: 'Bili' },
    });
    const r = await runRound(db, { ...base, collect });
    assert.deepEqual(calls, ['Douyin/comments', 'Douyin/dms', 'Bili/comments'], '账号之间串行，按顺序');
    assert.deepEqual(r.jobs.map((j) => j.status), ['failed', 'ok', 'ok']);
  });

  test('能力位关着不抓，日志只说一次；Instagram 和其他平台不碰', async () => {
    const { db, c, base, logs } = setup({ caps: [] });
    for (const cap of ['readComments', 'readDM']) for (const id of ['Instagram:pending', 'Weibo:2272770294']) setCapability(db, id, cap, true);
    const { collect, calls } = fakeCollect({});
    await runRound(db, { ...base, collect });
    c.advance(15 * MIN);
    await runRound(db, { ...base, collect });
    assert.deepEqual(calls, []);
    assert.equal(jobsOf(db).length, 0);
    const capLines = logs.filter((l) => l.includes('Douyin comments 不抓'));
    assert.equal(capLines.length, 1, '同样的原因第二轮不再说');
    assert.match(capLines[0], /readComments 关着/);
    assert.ok(!logs.some((l) => /Instagram|Weibo/.test(l)));
  });

  test('refresh_now 的 job 被消费（不新建）、状态变 ok；同一平台 kind 这一轮不再定时抓', async () => {
    const { db, c, base } = setup();
    const { collect, calls } = fakeCollect({ 'Douyin/comments': [commentsSnap([comment('c1')]), commentsSnap([comment('c1')])] });
    await runRound(db, { ...base, collect });
    c.advance(MIN);
    const { jobId } = requestRefresh(db, { kind: 'comments', platform: 'Douyin', now: c.now });
    assert.deepEqual(shouldStartRound(db, { now: c.now, lockPath: base.lockPath, timeZone }), { start: true, reason: 'refresh_now' });
    const r = await runRound(db, { ...base, collect });
    assert.deepEqual(r.jobs.map((j) => j.jobId), [jobId]);
    assert.equal(getJob(db, jobId).status, 'ok');
    assert.equal(calls.length, 2);
    assert.equal(jobsOf(db).length, 2);
  });

  test('X-B9：上一个进程崩在 running 的 refresh 每轮开头被回收为 failed，新的 refresh_now 能排上并跑', async () => {
    const { db, c, base } = setup();
    const { collect, calls } = fakeCollect({ 'Douyin/comments': [commentsSnap([comment('c1')]), commentsSnap([comment('c1')])] });
    await runRound(db, { ...base, collect });
    const stuck = requestRefresh(db, { kind: 'comments', platform: 'Douyin', now: c.now }).jobId;
    startJob(db, stuck, { now: c.now });   // 崩了，没 finishJob
    c.advance(STALE_RUNNING_MS + MIN);
    await runRound(db, { ...base, collect, kinds: ['dms'] });   // 这一轮不跑评论，只回收
    assert.equal(getJob(db, stuck).status, 'failed');
    assert.match(getJob(db, stuck).error, /遗留的 running 任务已回收/);
    assert.equal(requestRefresh(db, { kind: 'comments', platform: 'Douyin', now: c.now }).deduped, true);   // G-B8b：刚回收的 failed 5 分钟内也去重
    c.advance(5 * MIN + 1);
    const fresh = requestRefresh(db, { kind: 'comments', platform: 'Douyin', now: c.now });
    assert.equal(fresh.deduped, false);
    const r = await runRound(db, { ...base, collect });
    assert.ok(r.jobs.some((j) => j.jobId === fresh.jobId && j.status === 'ok'));
    assert.equal(calls.length, 2);
  });

  test('G-B8c：遗留的非抓取平台 requested 任务不让守护进程每分钟起一轮', async () => {
    const { db, c, base } = setup();
    const { collect } = fakeCollect({ 'Douyin/comments': commentsSnap([comment('c1')]), 'Douyin/dms': dmsSnap([]) });
    await runRound(db, { ...base, collect, trigger: 'manual' });
    createJob(db, { platformCode: 'Instagram', kind: 'comments', trigger: 'refresh_now', now: c.now });
    c.advance(MIN);
    assert.deepEqual(shouldStartRound(db, { now: c.now, lockPath: base.lockPath, timeZone }), { start: false, reason: 'idle' });
  });

  test('refresh_now 指到能力位关着的平台：记 skipped，不抓', async () => {
    const { db, base } = setup({ caps: [] });
    const { jobId } = requestRefresh(db, { kind: 'dms', platform: 'Douyin', now: base.now });
    const { collect, calls } = fakeCollect({});
    await runRound(db, { ...base, collect });
    assert.equal(getJob(db, jobId).status, 'skipped');
    assert.match(getJob(db, jobId).error, /readDM 关着/);
    assert.deepEqual(calls, []);
  });

  test('定时：同一时段只跑一次；manual 不看时间表', async () => {
    const { db, c, base } = setup();
    const ok = () => commentsSnap([comment('c1')]);
    const { collect, calls } = fakeCollect({ 'Douyin/comments': ok });
    await runRound(db, { ...base, collect });
    c.advance(5 * MIN);
    await runRound(db, { ...base, collect });
    assert.equal(calls.length, 1, '10:05 还在 10:00 这个时段');
    assert.deepEqual(shouldStartRound(db, { now: c.now, lockPath: base.lockPath, timeZone }), { start: false, reason: 'idle' });
    await runRound(db, { ...base, collect, trigger: 'manual', kinds: ['comments'] });
    assert.equal(calls.length, 2);
    c.advance(10 * MIN);
    assert.equal(shouldStartRound(db, { now: c.now, lockPath: base.lockPath, timeZone }).start, true, '10:15 到点');
  });
});

describe('轮锁', () => {
  test('第二个并发 runRound 拿不到锁；第一轮结束后锁释放', async () => {
    const { db, base } = setup();
    let release;
    const gate = new Promise((r) => { release = r; });
    const { collect } = fakeCollect({ 'Douyin/comments': async () => { await gate; return commentsSnap([comment('c1')]); } });
    const first = runRound(db, { ...base, collect });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(await runRound(db, { ...base, collect }), { ran: false, reason: 'locked' });
    assert.deepEqual(shouldStartRound(db, { now: base.now, lockPath: base.lockPath, timeZone }), { start: false, reason: 'running' });
    release();
    assert.equal((await first).ran, true);
    assert.equal(fs.existsSync(base.lockPath), false);
  });

  test('过期锁可接管：进程不在了，或超过 60 分钟', async () => {
    const { db, base, logs } = setup();
    const { collect } = fakeCollect({ 'Douyin/comments': () => commentsSnap([comment('c1')]) });
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    fs.writeFileSync(base.lockPath, JSON.stringify({ pid: dead, startedAt: new Date(base.now()).toISOString() }));
    assert.equal((await runRound(db, { ...base, collect })).ran, true);
    fs.writeFileSync(base.lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date(base.now() - 61 * MIN).toISOString() }));
    assert.equal((await runRound(db, { ...base, collect, trigger: 'manual' })).ran, true);
    assert.equal(logs.filter((l) => l.includes('接管了过期的轮锁')).length, 2);
    fs.writeFileSync(base.lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date(base.now() - 59 * MIN).toISOString() }));
    assert.equal((await runRound(db, { ...base, collect, trigger: 'manual' })).ran, false, '59 分钟、进程还在：不接管');
  });

  test('别人的锁不被我们的 release 删掉', () => {
    const file = tmpLock();
    const a = acquireRoundLock(file);
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token: 'other' }));
    a.release();
    assert.equal(fs.existsSync(file), true);
  });
});

describe('守护进程接线', () => {
  function fakeSpawn() {
    const spawned = [];
    const spawnImpl = (cmd, args, opts) => { const ch = new EventEmitter(); spawned.push({ cmd, args, opts, ch }); return ch; };
    return { spawned, spawnImpl };
  }

  test('到点起一个 --once 子进程；子进程没退出不再起；退出码记一行日志', () => {
    const { db, base } = setup();
    const { spawned, spawnImpl } = fakeSpawn();
    const logs = [];
    const tick = makeEngageTicker({ openDb: () => db, spawnImpl, now: base.now, lockPath: base.lockPath, log: (s) => logs.push(s) });
    assert.deepEqual(tick(), { started: true, reason: 'schedule' });
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].cmd, stableNodeExecPath());
    assert.match(spawned[0].args[0], /src\/daemon\/sync\.mjs$/);
    assert.equal(spawned[0].args[1], '--once');
    assert.equal(spawned[0].opts.detached, false);
    assert.deepEqual(tick(), { started: false, reason: 'child-running' });
    spawned[0].ch.emit('exit', 0, null);
    assert.match(logs.at(-1), /抓取轮子进程退出 code=0/);
  });

  test('有一轮在跑（锁有效）就不起；判断出错不让守护进程崩', () => {
    const { db, base } = setup();
    const { spawned, spawnImpl } = fakeSpawn();
    const held = acquireRoundLock(base.lockPath, { now: base.now });
    const tick = makeEngageTicker({ openDb: () => db, spawnImpl, now: base.now, lockPath: base.lockPath, log: () => {} });
    assert.deepEqual(tick(), { started: false, reason: 'running' });
    held.release();
    const broken = makeEngageTicker({ openDb: () => { throw new Error('库打不开'); }, spawnImpl, log: () => {} });
    assert.deepEqual(broken(), { started: false, reason: 'error' });
    assert.equal(spawned.length, 0);
  });
});

describe('status 与去敏', () => {
  test('engageStatus：每个平台每个 kind 最近一次 job、未处理事件数', async () => {
    const { db, c, base } = setup();
    const { collect } = fakeCollect({ 'Douyin/comments': [commentsSnap([comment('c1')]), commentsSnap([comment('c1'), comment('c2')])] });
    await runRound(db, { ...base, collect });
    c.advance(15 * MIN);
    await runRound(db, { ...base, collect });
    const st = engageStatus(db);
    assert.deepEqual(st.platforms.map((p) => p.platformCode), ['Douyin', 'Channels', 'XiaoHongShu', 'Bili']);
    const dc = st.platforms[0].kinds.comments;
    assert.equal(dc.lastJob.status, 'ok');
    assert.deepEqual(dc.lastJob.stats, { inserted: 1, updated: 2, gone: 0, events: 1 });
    assert.equal(st.platforms[0].kinds.dms.lastJob, null);
    assert.match(st.platforms[0].kinds.dms.note, /readDM 关着/);
    assert.equal(st.platforms[0].unhandledEvents, 1);
    assert.equal(st.unhandledEvents, 1);
  });

  test('redact：去掉 query、cookie、token', () => {
    const s = redact('打开 https://a.test/p?x=1&token=t0p 失败 cookie: abc; token=xyz Authorization: Bearer qqq xsec_token=zz');
    assert.ok(s.includes('https://a.test/p'));
    for (const bad of ['x=1', 't0p', 'abc', 'xyz', 'qqq', 'zz']) assert.ok(!s.includes(bad), `${bad} 应该被去掉：${s}`);
  });
});
