// hub ops collect（不需要 Ego Lite）：四平台作品和粉丝采集写库。临时目录里的 ops.db，假 runner、假平台模块。
import { test, describe } from 'node:test';
import './helpers/ops-dir.mjs';   // 锁目录指到临时目录（必须在加载 runner 之前）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setCapability } from '../src/ops/accounts.mjs';
import { collectWorks } from '../src/ops/collect.mjs';
import { collectInSpace } from '../src/ops/collect-space.mjs';
import { prepareDb, fakes, mapped, post, account, UIDS, PLATFORMS, SECRET } from './fixtures/ops-export/fake.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ops-collect-'));
const freshDb = (o) => prepareDb(path.join(tmp(), 'ops.db'), o);
const count = (db, table, where = '1', ...args) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args).n;
const byCode = (rows) => Object.fromEntries(rows.map((r) => [r.platformCode, r]));
const T0 = Date.parse('2026-11-19T01:00:00Z');

describe('采集写库', () => {
  test('四平台并行都 ok：写库、退出码 0，每个账号一个 runner 任务（5 分钟超时）', async () => {
    const db = freshDb();
    const f = fakes({}, { delayMs: 30 });
    const r = await collectWorks(db, { ...f, now: () => T0 });
    assert.equal(r.exitCode, 0, JSON.stringify(r.rows));
    assert.deepEqual(r.rows.map((x) => x.result), ['ok', 'ok', 'ok', 'ok']);
    assert.ok(f.maxRunning() > 1, '各平台应并行');
    assert.deepEqual(f.calls.map((c) => c.space).sort(), PLATFORMS.map((p) => `kinso/${p}/${UIDS[p]}`).sort());
    for (const c of f.calls) {
      assert.equal(c.timeoutMs, 5 * 60_000);
      assert.equal(c.profileId, 'Profile 5');
      assert.equal(c.params.days, 30);
      assert.equal(c.params.nowMs, T0);
    }
    assert.equal(count(db, 'works'), 4);
    assert.equal(count(db, 'work_snapshots'), 4);
    assert.equal(count(db, 'account_snapshots'), 4);
    assert.equal(count(db, 'fans_daily'), 8);
    assert.equal(count(db, 'collect_runs', "result = 'ok' AND runId = ?", r.runId), 4);
    assert.equal(byCode(r.rows).Bili.postCount, 1);
    assert.ok(!JSON.stringify(r.rows).includes(SECRET), '输出里不能有 finderUsername');
  });

  for (const [label, setup, reason] of [
    ['busy', (db) => ({ Bili: { ok: false, reason: 'busy', error: '占着' } }), 'busy'],
    ['user-controlled（不抢）', (db) => ({ Bili: { ok: false, reason: 'user-controlled' } }), 'user-controlled'],
    ['profile-needed', (db) => ({ Bili: { ok: false, reason: 'profile-needed' } }), 'profile-needed'],
    ['readWorks 关着', (db) => { setCapability(db, 'Bili:478358005', 'readWorks', false); return {}; }, 'capability-off'],
  ]) {
    test(`${label}：这个账号跳过、其余照常，退出码 3`, async () => {
      const db = freshDb();
      const f = fakes(setup(db));
      const r = await collectWorks(db, { ...f });
      assert.equal(r.exitCode, 3);
      const bili = byCode(r.rows).Bili;
      assert.equal(bili.result, 'skipped');
      assert.equal(bili.reason, reason);
      assert.equal(count(db, 'works', "platformCode = 'Bili'"), 0);
      assert.equal(count(db, 'works'), 3);
      assert.equal(count(db, 'collect_runs', "platformCode = 'Bili' AND result = 'skipped' AND reason = ?", reason), 1);
      if (reason === 'capability-off') {
        assert.ok(!f.calls.some((c) => c.space.includes('/Bili/')), 'readWorks 关着不应起 runner');
        assert.match(bili.message, /hub ops accounts set-cap Bili:478358005 readWorks true/);
      }
      if (reason === 'user-controlled') assert.match(bili.message, /负责人正在手动操作/);
    });
  }

  test('uid 还是 pending：不采，提示先跑 login --check，退出码 3', async () => {
    const db = freshDb({ channelsUid: false });
    const f = fakes();
    const r = await collectWorks(db, { ...f });
    assert.equal(r.exitCode, 3);
    const ch = byCode(r.rows).Channels;
    assert.equal(ch.result, 'skipped');
    assert.equal(ch.reason, 'uid-pending');
    assert.match(ch.message, /uid 未登记，先跑 hub ops login --check/);
    assert.ok(!f.calls.some((c) => c.space.includes('/Channels/')));
  });

  test('uid 不符：不写这个账号、退出码 2', async () => {
    const db = freshDb();
    const r = await collectWorks(db, { ...fakes({ Douyin: mapped('Douyin', { uidSeen: '999' }) }) });
    assert.equal(r.exitCode, 2);
    const dy = byCode(r.rows).Douyin;
    assert.equal(dy.result, 'uid-mismatch');
    assert.match(dy.message, /106707338905/);
    assert.match(dy.message, /999/);
    assert.equal(count(db, 'works', "platformCode = 'Douyin'"), 0);
    assert.equal(count(db, 'account_snapshots', "platformCode = 'Douyin'"), 0);
    assert.equal(count(db, 'fans_daily', "platformCode = 'Douyin'"), 0);
  });

  test('没读到 uidSeen：不写，算失败', async () => {
    const db = freshDb();
    const r = await collectWorks(db, { ...fakes({ Bili: mapped('Bili', { uidSeen: null }) }), platforms: ['Bili'] });
    assert.equal(r.exitCode, 1);
    assert.equal(r.rows[0].result, 'failed');
    assert.equal(count(db, 'works'), 0);
  });

  test('全失败：退出码 1', async () => {
    const db = freshDb();
    const fail = { ok: false, reason: 'exit-code', error: 'ego-browser nodejs 退出码 1' };
    const r = await collectWorks(db, { ...fakes(Object.fromEntries(PLATFORMS.map((p) => [p, fail]))) });
    assert.equal(r.exitCode, 1);
    assert.ok(r.rows.every((x) => x.result === 'failed'));
    assert.equal(count(db, 'collect_runs', "result = 'failed'"), 4);
  });

  test('未登录：out，不写作品和粉丝，提示扫码登录', async () => {
    const db = freshDb();
    const r = await collectWorks(db, { ...fakes({ Douyin: { loggedIn: false, uidSeen: null, posts: [], account: null } }) });
    assert.equal(r.exitCode, 3);
    const dy = byCode(r.rows).Douyin;
    assert.equal(dy.result, 'out');
    assert.match(dy.message, /hub ops login Douyin/);
    assert.equal(count(db, 'works', "platformCode = 'Douyin'"), 0);
    assert.equal(count(db, 'account_snapshots', "platformCode = 'Douyin'"), 0);
  });

  test('记录不合格（指标是字符串、platform 不对）：不写库，算失败，列出字段', async () => {
    const db = freshDb();
    const bad = mapped('Bili', { posts: [post('Bili', 'BV1', { view: '12' }), post('Douyin', 'x')] });
    const r = await collectWorks(db, { ...fakes({ Bili: bad }), platforms: ['Bili'] });
    assert.equal(r.rows[0].result, 'failed');
    assert.equal(r.rows[0].reason, 'bad-record');
    assert.ok(r.rows[0].problems.some((p) => /view/.test(p)));
    assert.ok(r.rows[0].problems.some((p) => /platform：要是 Bili/.test(p)));
    assert.equal(count(db, 'works'), 0);
  });

  test('一个平台的写入在一个事务里：中途出错整段回滚', async () => {
    const db = freshDb();
    // 第二条带 BigInt，JSON.stringify 在写第二条时抛错；第一条已经写进去的要回滚
    const r = await collectWorks(db, { ...fakes({ Bili: mapped('Bili', { posts: [post('Bili', 'BV1'), post('Bili', 'BV2', { extra: 1n })] }) }), platforms: ['Bili'] });
    assert.equal(r.rows[0].result, 'failed');
    assert.equal(r.rows[0].reason, 'db-failed');
    for (const t of ['works', 'work_snapshots', 'account_snapshots', 'fans_daily']) assert.equal(count(db, t), 0, t);
    assert.equal(count(db, 'collect_runs', "result = 'failed'"), 1);
  });

  test('同一作品两次采集：works 一行、快照两行、时间戳不同；fans_daily 不被 null 覆盖', async () => {
    const db = freshDb();
    let t = T0;
    await collectWorks(db, { ...fakes(), platforms: ['Douyin'], now: () => t });
    t = T0 + 3600_000;
    const second = mapped('Douyin', {
      posts: [post('Douyin', 'Douyin-1', { view: 500 })],
      account: account('Douyin', { daily: [{ date: '2026-11-17', fansTotal: null, fansNet: null }, { date: '2026-11-18', fansTotal: 101, fansNet: 3 }, { date: '2026-11-19', fansTotal: null, fansNet: 1 }] }),
    });
    await collectWorks(db, { ...fakes({ Douyin: second }), platforms: ['Douyin'], now: () => t });
    assert.equal(count(db, 'works'), 1);
    const w = db.prepare('SELECT * FROM works').get();
    assert.equal(JSON.parse(w.record).view, 500);
    assert.equal(w.firstSeenAt, new Date(T0).toISOString());
    assert.equal(w.lastSeenAt, new Date(T0 + 3600_000).toISOString());
    const snaps = db.prepare('SELECT collectedAt, record FROM work_snapshots ORDER BY collectedAt').all();
    assert.equal(snaps.length, 2);
    assert.notEqual(snaps[0].collectedAt, snaps[1].collectedAt);
    assert.deepEqual(snaps.map((s) => JSON.parse(s.record).view), [100, 500]);
    assert.equal(count(db, 'account_snapshots'), 2);
    const daily = Object.fromEntries(db.prepare('SELECT date, fansTotal, fansNet FROM fans_daily ORDER BY date').all().map((d) => [d.date, [d.fansTotal, d.fansNet]]));
    assert.deepEqual(daily, { '2026-11-17': [98, 1], '2026-11-18': [101, 3], '2026-11-19': [null, 1] });
  });

  for (const [label, extra, want] of [
    ['complete=false', { complete: false, incomplete: '作品列表第 1 页没拿到数据（code=-1）', posts: [] }, /作品列表第 1 页没拿到数据/],
    ['缺 complete 字段', { complete: undefined, incomplete: undefined }, /没有 complete 字段/],
  ]) {
    test(`${label}：failed（incomplete），不写作品、粉丝、快照，stats 照样落库`, async () => {
      const db = freshDb();
      const m = mapped('XiaoHongShu', { ...extra, stats: { pages: 0, listCode: -1 } });
      if (extra.complete === undefined) delete m.complete;
      const r = await collectWorks(db, { ...fakes({ XiaoHongShu: m }) });
      assert.equal(r.exitCode, 3);
      const x = byCode(r.rows).XiaoHongShu;
      assert.equal(x.result, 'failed');
      assert.equal(x.reason, 'incomplete');
      assert.match(x.message, want);
      assert.deepEqual(x.stats, { pages: 0, listCode: -1 });
      for (const t of ['works', 'work_snapshots', 'account_snapshots', 'fans_daily']) assert.equal(count(db, t, "platformCode = 'XiaoHongShu'"), 0, t);
      const run = db.prepare("SELECT result, stats FROM collect_runs WHERE platformCode = 'XiaoHongShu'").get();
      assert.equal(run.result, 'failed');
      assert.deepEqual(JSON.parse(run.stats), { pages: 0, listCode: -1 });
    });
  }

  test('全部不完整：退出码 1', async () => {
    const db = freshDb();
    const r = await collectWorks(db, { ...fakes(Object.fromEntries(PLATFORMS.map((p) => [p, mapped(p, { complete: false, incomplete: '没拿到' })]))) });
    assert.equal(r.exitCode, 1);
  });

  test('ok 的行也带 stats 落库；没到 map 的行 stats 为空', async () => {
    const db = freshDb();
    const r = await collectWorks(db, { ...fakes({ Bili: { ok: false, reason: 'busy' } }) });
    assert.deepEqual(byCode(r.rows).Douyin.stats, { pages: 1 });
    assert.equal(byCode(r.rows).Bili.stats, undefined);
    const rows = Object.fromEntries(db.prepare('SELECT platformCode, stats FROM collect_runs').all().map((x) => [x.platformCode, x.stats]));
    assert.equal(rows.Douyin, '{"pages":1}');
    assert.equal(rows.Bili, null);
  });

  test('旧库的 collect_runs 没有 stats 列：自动补列，旧行保留', async () => {
    const db = freshDb();
    db.exec(`CREATE TABLE collect_runs (runId TEXT NOT NULL, platformCode TEXT NOT NULL, uid TEXT, startedAt TEXT NOT NULL, finishedAt TEXT NOT NULL,
      result TEXT NOT NULL CHECK (result IN ('ok', 'out', 'skipped', 'failed', 'uid-mismatch')), reason TEXT, message TEXT, postCount INTEGER)`);
    db.prepare("INSERT INTO collect_runs (runId, platformCode, uid, startedAt, finishedAt, result) VALUES ('old', 'Bili', '478358005', 'a', 'b', 'ok')").run();
    const r = await collectWorks(db, { ...fakes(), platforms: ['Douyin'] });
    assert.equal(r.exitCode, 0, JSON.stringify(r.rows));
    assert.equal(db.prepare("SELECT stats FROM collect_runs WHERE platformCode = 'Douyin'").get().stats, '{"pages":1}');
    assert.equal(db.prepare("SELECT stats FROM collect_runs WHERE runId = 'old'").get().stats, null);
  });

  test('不在范围的平台直接拒绝；Instagram 写明账号被锁', async () => {
    const db = freshDb();
    const f = fakes();
    await assert.rejects(collectWorks(db, { ...f, platforms: ['Instagram'] }), /Instagram 账号被锁，暂时跳过，不做任何自动操作/);
    for (const p of ['Weibo', 'GongZhongHao', 'X']) await assert.rejects(collectWorks(db, { ...f, platforms: [p] }), /不在 S3 采集范围/);
    assert.equal(f.calls.length, 0);
  });

  test('--days 传给 runner 和 map', async () => {
    const db = freshDb();
    const f = fakes();
    await collectWorks(db, { ...f, platforms: ['Bili'], days: 7 });
    assert.equal(f.calls[0].params.days, 7);
    await assert.rejects(collectWorks(db, { ...f, days: 0 }), /--days/);
  });
});

describe('in-space 任务脚本', () => {
  const FAKE_PLATFORM = pathToFileURL(path.resolve(import.meta.dirname, 'fixtures/ops-export/fake-platform.mjs')).href;
  const AsyncFunction = (async () => {}).constructor;
  const fakeTask = (gotos) => {
    let url = 'about:blank';
    const page = { async goto(u, o) { gotos.push([u, o]); url = u; }, async url() { return url; } };
    return { async pages() { return [page]; }, async tabs() { return []; }, async newPage() { return page; } };
  };

  test('collectInSpace：goto START_URL（commit、30 秒）、等 SETTLE_MS，再 fetchRaw', async () => {
    const gotos = [], slept = [];
    const raw = await collectInSpace(fakeTask(gotos), { moduleUrl: FAKE_PLATFORM, days: 30, nowMs: T0 }, { sleep: async (ms) => { slept.push(ms); } });
    assert.deepEqual(gotos, [['https://member.bilibili.com/platform/upload-manager/article', { waitUntil: 'commit', timeout: 30000 }]]);
    assert.equal(slept[0], 5);
    assert.equal(raw.landed, 'https://member.bilibili.com/platform/upload-manager/article');
    assert.equal(raw.days, 30);
    assert.equal(raw.nowMs, T0);
  });

  test('runner 收到的脚本 import collect-space.mjs 和平台模块，宿主侧 map 后写库', async () => {
    const db = freshDb();
    const gotos = [];
    const runTask = async (o) => ({ ok: true, result: JSON.parse(JSON.stringify(await new AsyncFunction('task', 'params', o.script)(fakeTask(gotos), o.params))) });
    const r = await collectWorks(db, { runTask, moduleUrlOf: () => FAKE_PLATFORM, loadPlatform: () => import(FAKE_PLATFORM), platforms: ['Bili'], days: 9 });
    assert.equal(r.exitCode, 0, JSON.stringify(r.rows));
    assert.equal(gotos.length, 1);
    const rec = JSON.parse(db.prepare('SELECT record FROM works').get().record);
    assert.equal(rec.view, 9);
    assert.equal(rec.title, 'https://member.bilibili.com/platform/upload-manager/article');
    assert.ok(!JSON.stringify(r).includes(SECRET));
  });
});
