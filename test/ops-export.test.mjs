// hub ops export（不需要 Ego Lite）：posts-/accounts-YYYYMMDD.json 导出、下游读取校验、CLI。
// 一律临时目录（MAITIAN_OPS_DB / MAITIAN_OPS_DIR / MAITIAN_OPS_SHADOW_DIR），不碰仓库的 data/ 和 /Users/kinso/code/local-tests/。
import { test, describe, after } from 'node:test';
import './helpers/ops-dir.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectWorks } from '../src/ops/collect.mjs';
import { exportPosts, exportAccounts } from '../src/ops/export.mjs';
import { openOpsDb } from '../src/ops/db.mjs';
import { ensureWorksTables, saveCollected, recordRun } from '../src/ops/works-db.mjs';
import { prepareDb, fakes, mapped, post, account, UIDS, PLATFORMS, SECRET } from './fixtures/ops-export/fake.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CHECK = path.join(ROOT, 'scripts', 'ops-export-check.py');
const repoLeftovers = () => ['data', '.env'].filter((f) => fs.existsSync(path.join(ROOT, f)));
const LEFTOVERS_BEFORE = repoLeftovers();
after(() => { assert.deepEqual(repoLeftovers(), LEFTOVERS_BEFORE, '测试不应在仓库根下留下 data/ 或 .env'); });

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ops-export-'));
const T0 = Date.parse('2026-11-19T01:00:00Z');   // 东八区 2026-11-19 09:00
const H = 3600_000;
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const pyCheck = (...args) => spawnSync('python3', ['-I', CHECK, ...args], { encoding: 'utf8' });

async function collected(byPlatform = {}, { now = T0, db = prepareDb(path.join(tmp(), 'ops.db')), platforms } = {}) {
  await collectWorks(db, { ...fakes(byPlatform), now: () => now, platforms });
  return db;
}

describe('导出', () => {
  test('每个平台取最近一次 ok：顶层数组，字段名和顺序原样，四个平台都在 → 退出码 0', async () => {
    const db = await collected();
    // 第二次：抖音的作品数变了；小红书失败（导出仍用它上一次 ok 的）
    await collected({ Douyin: mapped('Douyin', { posts: [post('Douyin', 'D1', { view: 7 }), post('Douyin', 'D2')] }), XiaoHongShu: { ok: false, reason: 'exit-code' } }, { db, now: T0 + H });
    const out = tmp();
    const r = exportPosts(db, { out, now: () => T0 + H });
    assert.equal(r.exitCode, 0, JSON.stringify(r));
    assert.equal(r.file, path.join(out, 'posts-20261119.json'));
    const list = read(r.file);
    assert.ok(Array.isArray(list));
    assert.deepEqual(list.map((p) => `${p.platform}:${p.postId}`).sort(), ['Bili:Bili-1', 'Channels:Channels-1', 'Douyin:D1', 'Douyin:D2', 'XiaoHongShu:XiaoHongShu-1'].sort());
    assert.deepEqual(Object.keys(list.find((p) => p.postId === 'D1')), Object.keys(post('Douyin', 'D1')));
    assert.equal(list.find((p) => p.postId === 'D1').view, 7);
    assert.ok(!fs.readFileSync(r.file, 'utf8').includes(SECRET));
    assert.deepEqual(fs.readdirSync(out), ['posts-20261119.json'], '不留临时文件');
  });

  test('过期的平台被排除，退出码 3；--max-age-hours 可调', async () => {
    const db = await collected({}, { platforms: ['Douyin'] });
    await collected({}, { db, now: T0 + 30 * H, platforms: ['XiaoHongShu', 'Bili', 'Channels'] });
    const out = tmp();
    const r = exportPosts(db, { out, now: () => T0 + 30 * H });
    assert.equal(r.exitCode, 3);
    assert.deepEqual(r.excluded.map((x) => x.platformCode), ['Douyin']);
    assert.match(r.excluded[0].reason, /超过 26 小时/);
    assert.ok(!read(r.file).some((p) => p.platform === 'Douyin'));
    assert.equal(exportPosts(db, { out, now: () => T0 + 30 * H, maxAgeHours: 48 }).exitCode, 0);
  });

  test('采集不完整的一次不算 ok：导出回退到上一次完整的；上一次也过期就排除', async () => {
    const db = await collected();
    await collected({ XiaoHongShu: mapped('XiaoHongShu', { posts: [], complete: false, incomplete: '作品列表没拿到数据' }) }, { db, now: T0 + 2 * H });
    const out = tmp();
    const r = exportPosts(db, { out, now: () => T0 + 2 * H });
    assert.equal(r.exitCode, 0, JSON.stringify(r));
    assert.equal(read(r.file).filter((p) => p.platform === 'XiaoHongShu').length, 1);
    assert.equal(r.exported.find((x) => x.platformCode === 'XiaoHongShu').finishedAt, new Date(T0).toISOString());
    await collected({ XiaoHongShu: mapped('XiaoHongShu', { complete: false, incomplete: '又没拿到' }) }, { db, now: T0 + 27 * H });
    const later = exportPosts(db, { out, now: () => T0 + 27 * H, maxAgeHours: 26 });
    assert.ok(later.excluded.some((x) => x.platformCode === 'XiaoHongShu'));
  });

  test('从没成功过的平台写明，退出码 3', async () => {
    const db = await collected({ Channels: { ok: false, reason: 'busy' } });
    const r = exportAccounts(db, { out: tmp(), now: () => T0 });
    assert.equal(r.exitCode, 3);
    assert.deepEqual(r.excluded, [{ platformCode: 'Channels', reason: '从没成功采集过' }]);
  });

  test('一个平台都没有：退出码 1，不写文件（posts、accounts 都是）', async () => {
    const out = tmp();
    const empty = openOpsDb(path.join(tmp(), 'ops.db'));
    for (const fn of [exportPosts, exportAccounts]) {
      const r = fn(empty, { out, now: () => T0 });
      assert.equal(r.exitCode, 1);
      assert.equal(r.file, null);
    }
    const stale = await collected();
    for (const fn of [exportPosts, exportAccounts]) assert.equal(fn(stale, { out, now: () => T0 + 27 * H }).exitCode, 1);
    assert.deepEqual(fs.readdirSync(out), []);
  });

  test('校验不合格：整份不写，退出码 1，列出哪条哪个字段', async () => {
    const db = await collected();
    // 绕过采集时的校验直接写进库（模拟库里已有的坏记录）
    const runId = 'bad-run';
    saveCollected(db, { runId, platformCode: 'Bili', uid: UIDS.Bili, at: new Date(T0 + H).toISOString(), posts: [post('Bili', 'BVbad', { like: '3', postTime: null })], account: account('Bili', { fans: '100' }) });
    recordRun(db, { runId, platformCode: 'Bili', uid: UIDS.Bili, startedAt: new Date(T0 + H).toISOString(), finishedAt: new Date(T0 + H).toISOString(), result: 'ok', days: 30 });
    const out = tmp();
    const p = exportPosts(db, { out, now: () => T0 + H });
    assert.equal(p.exitCode, 1);
    assert.equal(p.file, null);
    assert.ok(p.problems.some((x) => /BVbad.*like/.test(x)), p.problems.join('\n'));
    assert.ok(p.problems.some((x) => /BVbad.*postTime/.test(x)));
    const a = exportAccounts(db, { out, now: () => T0 + H });
    assert.equal(a.exitCode, 1);
    assert.ok(a.problems.some((x) => /478358005 fans/.test(x)));
    assert.deepEqual(fs.readdirSync(out), []);
  });

  test('accounts：{uid, loginStatus, fans, updateTime, daily}，daily 取 fans_daily 近 30 天、升序', async () => {
    const db = await collected({ Bili: mapped('Bili', { account: account('Bili', { fans: 96, daily: [{ date: '2026-10-01', fansTotal: 50, fansNet: 1 }, { date: '2026-11-18', fansTotal: null, fansNet: 2 }, { date: '2026-11-12', fansTotal: null, fansNet: 5 }] }) }) });
    const r = exportAccounts(db, { out: tmp(), now: () => T0 });
    assert.equal(r.exitCode, 0, JSON.stringify(r));
    const list = read(r.file);
    assert.equal(list.length, 4);
    assert.deepEqual(list.map((a) => a.uid).sort(), PLATFORMS.map((p) => UIDS[p]).sort());
    const bili = list.find((a) => a.uid === UIDS.Bili);
    assert.deepEqual(Object.keys(bili), ['uid', 'loginStatus', 'fans', 'updateTime', 'daily']);
    assert.equal(bili.fans, 96);
    assert.deepEqual(bili.daily, [{ date: '2026-11-12', fansTotal: null, fansNet: 5 }, { date: '2026-11-18', fansTotal: null, fansNet: 2 }]);
  });

  test('默认目录 MAITIAN_OPS_SHADOW_DIR，文件名按东八区日期；--date 指定', async () => {
    const dir = tmp();
    process.env.MAITIAN_OPS_SHADOW_DIR = dir;
    try {
      const now = Date.parse('2026-11-18T17:00:00Z');   // 东八区已是 11-19
      const db = await collected({}, { now });
      assert.equal(exportPosts(db, { now: () => now }).file, path.join(dir, 'posts-20261119.json'));
      assert.equal(exportAccounts(db, { now: () => now, date: '20261231' }).file, path.join(dir, 'accounts-20261231.json'));
      assert.throws(() => exportPosts(db, { now: () => now, date: '2026-12-31' }), /YYYYMMDD/);
    } finally { delete process.env.MAITIAN_OPS_SHADOW_DIR; }
  });
});

describe('下游读取校验 scripts/ops-export-check.py', () => {
  test('合格的导出 → 0；不合格 → 1 并逐条列出', async () => {
    const db = await collected();
    const out = tmp();
    const p = exportPosts(db, { out, now: () => T0 }).file;
    const a = exportAccounts(db, { out, now: () => T0 }).file;
    const ok = pyCheck('--posts', p, '--accounts', a);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);

    const badPosts = path.join(out, 'bad-posts.json');
    fs.writeFileSync(badPosts, JSON.stringify([post('Bili', 'B1', { view: '12' }), post('Bili', 'B1'), post('Weibo', 'W1'), post('Douyin', 'D1', { postTime: '' })]));
    const badAccounts = path.join(out, 'bad-accounts.json');
    fs.writeFileSync(badAccounts, JSON.stringify([account('Bili', { uid: '3076192038' }), account('Douyin', { loginStatus: '已失效', daily: [{ date: '20261118', fansTotal: 1, fansNet: 0 }] })]));
    const bad = pyCheck('--posts', badPosts, '--accounts', badAccounts);
    assert.equal(bad.status, 1);
    for (const want of [/view/, /重复/, /Weibo/, /postTime/, /3076192038/, /loginStatus/, /daily\[0\]\.date/]) assert.match(bad.stdout, want);

    const notArray = path.join(out, 'obj.json');
    fs.writeFileSync(notArray, '{}');
    assert.equal(pyCheck('--posts', notArray).status, 1);
    assert.notEqual(pyCheck().status, 0, '一个参数都不给要报错');
  });
});

describe('hub ops collect / export 命令行', () => {
  const HUB = path.join(ROOT, 'src', 'hub.mjs');
  const FAKE_CLI = path.join(ROOT, 'test', 'fixtures', 'ops-export', 'cli.mjs');
  function sandbox() {
    const dir = tmp();
    const env = { ...process.env, MAITIAN_CONFIG: path.join(dir, 'no-config.json'), MAITIAN_DB: path.join(dir, 'hub.db'), MAITIAN_OPS_DB: path.join(dir, 'ops.db'),
      MAITIAN_ENV_FILE: path.join(dir, '.env'), MAITIAN_OPS_DIR: path.join(dir, 'ops'), MAITIAN_OPS_SHADOW_DIR: path.join(dir, 'shadow') };
    const hub = (...args) => spawnSync(process.execPath, [HUB, 'ops', ...args], { env, encoding: 'utf8' });
    const fake = (args, extra = {}) => spawnSync(process.execPath, [FAKE_CLI, ...args], { env: { ...env, FAKE_NOW: String(T0), ...extra }, encoding: 'utf8' });
    return { dir, env, hub, fake };
  }
  const ready = (hub) => {
    for (const args of [['accounts', 'import'], ['accounts', 'set-uid', 'Channels', UIDS.Channels], ...PLATFORMS.map((p) => ['accounts', 'set-cap', `${p}:${UIDS[p]}`, 'readWorks', 'true'])]) {
      const r = hub(...args);
      assert.equal(r.status, 0, r.stderr);
    }
  };

  test('collect --export --json：stdout 是合法 JSON，采集后接着导出，导出文件过下游校验', () => {
    const { dir, hub, fake } = sandbox();
    ready(hub);
    const r = fake(['collect', '--export', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.exitCode, 0);
    assert.equal(j.rows.length, 4);
    assert.equal(j.export.posts.exitCode, 0);
    assert.equal(j.export.accounts.file, path.join(dir, 'shadow', 'accounts-20261119.json'));
    assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET));
    const check = pyCheck('--posts', j.export.posts.file, '--accounts', j.export.accounts.file);
    assert.equal(check.status, 0, check.stdout);
    // 只采 B站且 busy：一个 ok 都没有 → 1
    const part = fake(['collect', 'Bili', '--days', '7', '--json'], { FAKE_MAPPED: JSON.stringify({ Bili: { ok: false, reason: 'busy' } }) });
    assert.equal(part.status, 1, part.stderr);
    assert.equal(JSON.parse(part.stdout).rows[0].reason, 'busy');
    assert.ok(!fs.existsSync(path.join(dir, 'hub.db')), 'hub ops 不应加载麦田原库');
  });

  test('collect --export：uid 不符时整条退出码 2', () => {
    const { hub, fake } = sandbox();
    ready(hub);
    const r = fake(['collect', '--export', '--json'], { FAKE_MAPPED: JSON.stringify({ Douyin: { ...mapped('Douyin'), uidSeen: '1' } }) });
    assert.equal(r.status, 2, r.stderr);
    assert.equal(JSON.parse(r.stdout).export.posts.exitCode, 3);
  });

  test('export posts --json：没数据时退出码 1、stdout 合法 JSON、不写文件；参数不对退出码 1', () => {
    const { dir, hub } = sandbox();
    const r = hub('export', 'posts', '--json');
    assert.equal(r.status, 1, r.stderr);
    assert.equal(JSON.parse(r.stdout).file, null);
    assert.ok(!fs.existsSync(path.join(dir, 'shadow')));
    assert.equal(hub('export', 'nope').status, 1);
    assert.equal(hub('export', 'posts', '--date', '2026-11-19').status, 1);
  });

  test('collect Instagram / Weibo：拒绝，退出码 1，不起 runner', () => {
    const { hub } = sandbox();
    ready(hub);
    const r = hub('collect', 'Instagram', '--json');
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /Instagram 账号被锁，暂时跳过，不做任何自动操作/);
    assert.match(hub('collect', 'Weibo').stderr, /不在 S3 采集范围/);
  });

  test('help 里有 collect 和 export', () => {
    const { hub } = sandbox();
    const h = hub('help');
    assert.match(h.stdout, /collect \[--days N\]/);
    assert.match(h.stdout, /export posts\|accounts/);
  });
});

// 库表自己建：重复调用不出错
test('ensureWorksTables 幂等', () => {
  const db = openOpsDb(path.join(tmp(), 'ops.db'));
  ensureWorksTables(db);
  ensureWorksTables(db);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('collect_runs', 'works', 'work_snapshots', 'account_snapshots', 'fans_daily')").get().n, 5);
});

describe('评审第 1 轮：fans 可为 null、posts 只取 30 天及以上的采集', () => {
  test('fans:null 的账号照常采、照常导出 null；字符串、NaN 仍拒绝（Node 和 Python 两边）', async () => {
    const db = await collected({ Bili: mapped('Bili', { account: account('Bili', { fans: null }) }) });
    const out = tmp();
    const a = exportAccounts(db, { out, now: () => T0 });
    assert.equal(a.exitCode, 0, JSON.stringify(a));
    assert.equal(read(a.file).find((x) => x.uid === UIDS.Bili).fans, null);
    assert.equal(pyCheck('--accounts', a.file).status, 0);
    const bad = path.join(out, 'bad.json');
    for (const fans of ['100', 'NaN']) {
      fs.writeFileSync(bad, `[${JSON.stringify(account('Bili')).replace('"fans":100', `"fans":${fans === 'NaN' ? 'NaN' : '"100"'}`)}]`);
      const r = pyCheck('--accounts', bad);
      assert.equal(r.status, 1, `${fans}: ${r.stdout}`);
      assert.match(r.stdout, /fans/);
    }
    const s = await collected({ Bili: mapped('Bili', { account: account('Bili', { fans: '100' }) }) }, { platforms: ['Bili'] });
    assert.equal(s.prepare("SELECT result FROM collect_runs WHERE platformCode = 'Bili'").get().result, 'failed');
  });

  test('collect_runs 记 days；exportPosts 跳过不足 30 天的 ok，没有合格的时写明只采了几天；accounts 不受影响', async () => {
    const db = await collected({}, { platforms: ['Douyin'] });
    await collected({}, { db, now: T0 + H, platforms: ['Douyin'] }).then(() => {});
    db.prepare("UPDATE collect_runs SET days = 7 WHERE finishedAt = ?").run(new Date(T0 + H).toISOString());
    assert.deepEqual(db.prepare("SELECT days FROM collect_runs ORDER BY rowid").all().map((x) => x.days), [30, 7]);
    const out = tmp();
    const p = exportPosts(db, { out, now: () => T0 + H });
    assert.equal(p.exported.find((x) => x.platformCode === 'Douyin').finishedAt, new Date(T0).toISOString());
    const a = exportAccounts(db, { out, now: () => T0 + H });
    assert.equal(a.exported.find((x) => x.platformCode === 'Douyin').finishedAt, new Date(T0 + H).toISOString());
    // 只有短窗口的 ok
    const short = await collected({}, { platforms: ['Bili'] });
    short.prepare("UPDATE collect_runs SET days = 7").run();
    const r = exportPosts(short, { out: tmp(), now: () => T0 });
    assert.equal(r.exitCode, 1);
    assert.match(r.excluded.find((x) => x.platformCode === 'Bili').reason, /只采了 7 天/);
  });

  test('旧库的 collect_runs 没有 days 列：补列，旧行 NULL 不算 30 天（posts 不导出它，accounts 照用）', () => {
    const db = openOpsDb(path.join(tmp(), 'ops.db'));
    db.exec(`CREATE TABLE collect_runs (runId TEXT NOT NULL, platformCode TEXT NOT NULL, uid TEXT, startedAt TEXT NOT NULL, finishedAt TEXT NOT NULL,
      result TEXT NOT NULL, reason TEXT, message TEXT, postCount INTEGER, stats TEXT)`);
    ensureWorksTables(db);
    const at = new Date(T0).toISOString();
    saveCollected(db, { runId: 'old', platformCode: 'Bili', uid: UIDS.Bili, at, posts: [post('Bili', 'B1')], account: account('Bili') });
    db.prepare("INSERT INTO collect_runs (runId, platformCode, uid, startedAt, finishedAt, result) VALUES ('old', 'Bili', ?, ?, ?, 'ok')").run(UIDS.Bili, at, at);
    assert.equal(db.prepare('SELECT days FROM collect_runs').get().days, null);
    const p = exportPosts(db, { out: tmp(), now: () => T0 });
    assert.equal(p.exitCode, 1);
    assert.match(p.excluded.find((x) => x.platformCode === 'Bili').reason, /没记采集天数/);
    assert.equal(exportAccounts(db, { out: tmp(), now: () => T0 }).exported[0].runId, 'old');
  });

  test('同一时刻的两次 ok：取后写入的那次（rowid）', async () => {
    const db = await collected({}, { platforms: ['Douyin'] });
    await collected({ Douyin: mapped('Douyin', { posts: [post('Douyin', 'D-later')] }) }, { db, platforms: ['Douyin'] });
    const p = exportPosts(db, { out: tmp(), now: () => T0 });
    assert.deepEqual(read(p.file).map((x) => x.postId), ['D-later']);
  });
});
