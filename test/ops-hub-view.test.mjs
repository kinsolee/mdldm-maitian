// KIN-330：ops.db 的粉丝同步进 hub.db.followers、作品页读库、旧采集不覆盖 ops 行。只写临时目录，不碰仓库的 data/。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openOpsDb } from '../src/ops/db.mjs';
import { ensureWorksTables, recordRun, saveCollected } from '../src/ops/works-db.mjs';
import { syncFollowers } from '../src/ops/hub-followers.mjs';
import { worksView, readWorksView } from '../src/ops/works-view.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const XHS = 'XiaoHongShu';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ops-hub-view-'));
const NOW = Date.parse('2026-11-19T04:00:00Z');   // 东八区 2026-11-19 12:00

function opsDb(dir) {
  const db = openOpsDb(path.join(dir, 'ops.db'));
  ensureWorksTables(db);
  const acc = db.prepare("INSERT INTO accounts (platformCode, platformName, uid, spaceName, capabilities) VALUES (?, ?, ?, ?, '{}')");
  for (const [code, uid] of [['Douyin', 'd1'], [XHS, 'x1'], ['Bili', 'b1'], ['Channels', 'c1']]) acc.run(code, code, uid, `kinso/${code}/${uid}`);
  return db;
}
const daily = (db, code, uid, rows, at = '2026-11-19T03:00:00.000Z') => {
  const st = db.prepare('INSERT OR REPLACE INTO fans_daily (platformCode, uid, date, fansTotal, fansNet, collectedAt) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [date, total, net] of rows) st.run(code, uid, date, total, net, at);
};
const hubRows = (hub) => hub.prepare('SELECT day, platform, total, gain, loss, source, collected_at FROM followers ORDER BY platform, day').all().map((r) => ({ ...r }));

describe('粉丝同步 ops.db.fans_daily → hub.db.followers', () => {
  test('平台键、total、gain/loss、source=ops；重复运行幂等；fansTotal 为空不覆盖已有 total', () => {
    const dir = tmp(), db = opsDb(dir), hub = new DatabaseSync(path.join(dir, 'hub.db'));
    daily(db, 'Douyin', 'd1', [['2026-11-17', 100, null], ['2026-11-18', 103, 3]]);
    daily(db, XHS, 'x1', [['2026-11-18', 50, -2]]);
    daily(db, 'Bili', 'b1', [['2026-11-18', 7, 0]]);
    daily(db, 'Channels', 'c1', [['2026-11-18', null, 4]]);   // 没有总数、hub 里也没有这一天：不写
    const r = syncFollowers(db, hub);
    assert.equal(r.written, 4);
    const rows = hubRows(hub);
    assert.deepEqual(rows, [
      { day: '2026-11-18', platform: 'bilibili', total: 7, gain: null, loss: null, source: 'ops', collected_at: '2026-11-19T03:00:00.000Z' },
      { day: '2026-11-17', platform: 'douyin', total: 100, gain: null, loss: null, source: 'ops', collected_at: '2026-11-19T03:00:00.000Z' },
      { day: '2026-11-18', platform: 'douyin', total: 103, gain: 3, loss: null, source: 'ops', collected_at: '2026-11-19T03:00:00.000Z' },
      { day: '2026-11-18', platform: 'xhs', total: 50, gain: null, loss: 2, source: 'ops', collected_at: '2026-11-19T03:00:00.000Z' },
    ]);
    syncFollowers(db, hub);
    assert.deepEqual(hubRows(hub), rows, '重复运行行数、值不变');
    // 已有 total 的那天，ops 这次没给总数：total 留着，净增照写
    daily(db, 'Douyin', 'd1', [['2026-11-18', null, 5]], '2026-11-19T05:00:00.000Z');
    syncFollowers(db, hub);
    const d = hubRows(hub).find((x) => x.platform === 'douyin' && x.day === '2026-11-18');
    assert.equal(d.total, 103);
    assert.equal(d.gain, 5);
  });

  test('同一平台多个 uid：只取 accounts 表里这个平台的第一个账号（按导入顺序）', () => {
    const dir = tmp(), db = opsDb(dir), hub = new DatabaseSync(path.join(dir, 'hub.db'));
    db.prepare("INSERT INTO accounts (platformCode, platformName, uid, spaceName, capabilities) VALUES ('Douyin', 'Douyin', 'd2', 'kinso/Douyin/d2', '{}')").run();
    daily(db, 'Douyin', 'd1', [['2026-11-18', 100, 1]]);
    daily(db, 'Douyin', 'd2', [['2026-11-18', 9999, 1]]);
    daily(db, 'Douyin', 'ghost', [['2026-11-18', 1, 1]]);   // accounts 表里没有的 uid 不算
    syncFollowers(db, hub);
    assert.deepEqual(hubRows(hub).map((x) => [x.platform, x.total]), [['douyin', 100]]);
  });
});

describe('粉丝同步：今天的总数取 account_snapshots', () => {
  const snap = (db, code, uid, collectedAt, fans, runId = collectedAt) => db.prepare("INSERT INTO account_snapshots (runId, platformCode, uid, collectedAt, fans, loginStatus, record) VALUES (?, ?, ?, ?, ?, '登录有效', '{}')").run(runId, code, uid, collectedAt, fans);
  test('fans_daily 到昨天 + 今天的快照 → 今天一行（东八区日期、source=ops、gain/loss 为 null）；fans_daily 同一天有总数时 fans_daily 胜出；幂等', () => {
    const dir = tmp(), db = opsDb(dir), hub = new DatabaseSync(path.join(dir, 'hub.db'));
    daily(db, 'Douyin', 'd1', [['2026-11-17', 100, null], ['2026-11-18', 103, 3]]);
    snap(db, 'Douyin', 'd1', '2026-11-18T10:00:00.000Z', 104);
    snap(db, 'Douyin', 'd1', '2026-11-18T17:30:00.000Z', 108.4);   // 东八区 11-19 01:30，最新
    snap(db, 'Douyin', 'd1', '2026-11-18T18:00:00.000Z', null);   // fans 为空的不算
    daily(db, 'Channels', 'c1', [['2026-11-19', 20, -1]], '2026-11-19T02:00:00.000Z');
    snap(db, 'Channels', 'c1', '2026-11-19T03:00:00.000Z', 999);   // 同一天 fans_daily 有总数：不用快照
    daily(db, 'Bili', 'b1', [['2026-11-19', null, 2]]);
    snap(db, 'Bili', 'b1', '2026-11-19T03:00:00.000Z', 7);   // 同一天 fans_daily 没总数：total 取快照，净增照 fans_daily
    syncFollowers(db, hub);
    const rows = hubRows(hub);
    assert.deepEqual(rows.find((x) => x.platform === 'douyin' && x.day === '2026-11-19'),
      { day: '2026-11-19', platform: 'douyin', total: 108, gain: null, loss: null, source: 'ops', collected_at: '2026-11-18T17:30:00.000Z' });
    assert.equal(rows.find((x) => x.platform === 'douyin' && x.day === '2026-11-18').total, 103);
    assert.deepEqual(rows.find((x) => x.platform === 'channels'), { day: '2026-11-19', platform: 'channels', total: 20, gain: null, loss: 1, source: 'ops', collected_at: '2026-11-19T02:00:00.000Z' });
    assert.deepEqual(rows.find((x) => x.platform === 'bilibili'), { day: '2026-11-19', platform: 'bilibili', total: 7, gain: 2, loss: null, source: 'ops', collected_at: '2026-11-19T03:00:00.000Z' });
    assert.equal(rows.length, 5);
    syncFollowers(db, hub);
    assert.deepEqual(hubRows(hub), rows, '重复运行行数、值不变');
  });
});

describe('旧采集（saveFollowers）不覆盖 ops 行', () => {
  test('今天的 live 和历史 backfill 都跳过 source=ops 的行，别的行照写', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'config.json'), '{}');
    const script = `
      import { db } from ${JSON.stringify(path.join(ROOT, 'src', 'db.mjs'))};
      const { saveFollowers, today } = await import(${JSON.stringify(path.join(ROOT, 'src', 'followers.mjs'))});
      const t = today();
      const ins = db.prepare("INSERT INTO followers (day, platform, total, gain, loss, source, collected_at) VALUES (?, 'douyin', ?, null, null, ?, 'x')");
      ins.run(t, 500, 'ops'); ins.run('2026-01-02', 300, 'ops'); ins.run('2026-01-03', 1, 'backfill');
      const n = saveFollowers('douyin', { total: 1, history: [{ day: '2026-01-02', total: 2 }, { day: '2026-01-03', total: 3 }, { day: '2026-01-04', total: 4 }] });
      // saveFollowers 不再预查 ops，只靠 upsert 的 WHERE：ops 的 2026-01-02 不算进补写条数
      if (n !== 2) throw new Error('补写条数应为 2，实际 ' + n);
      saveFollowers('bilibili', { total: 8, history: [] });
      console.log(JSON.stringify(db.prepare('SELECT day, platform, total, source FROM followers ORDER BY platform, day').all().map((r) => ({ ...r, day: r.day === t ? 'today' : r.day }))));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8',
      env: { ...process.env, MAITIAN_CONFIG: path.join(dir, 'config.json'), MAITIAN_DB: path.join(dir, 'hub.db') } });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), [
      { day: 'today', platform: 'bilibili', total: 8, source: 'live' },
      { day: '2026-01-02', platform: 'douyin', total: 300, source: 'ops' },
      { day: '2026-01-03', platform: 'douyin', total: 3, source: 'backfill' },
      { day: '2026-01-04', platform: 'douyin', total: 4, source: 'backfill' },
      { day: 'today', platform: 'douyin', total: 500, source: 'ops' },
    ]);
  });
});

describe('作品页读库 worksView', () => {
  const post = (code, postId, postTime, extra = {}) => ({ postId, platform: code, title: `t-${postId}`, postTime, statusText: '已发布', view: 10, like: null, comment: 1, favorite: null, forward: 0, fansAdd: null, ...extra });
  function seeded() {
    const dir = tmp(), db = opsDb(dir);
    saveCollected(db, { runId: 'r1', platformCode: 'Douyin', uid: 'd1', at: '2026-11-19T01:00:00.000Z', account: { daily: [] },
      posts: [post('Douyin', 'a', '2026-11-10 08:00:00'), post('Douyin', 'old', '2026-10-01 08:00:00'), post('Douyin', 'b', '2026-11-18 21:00:00', { view: null })] });
    saveCollected(db, { runId: 'r1', platformCode: 'Bili', uid: 'b1', at: '2026-11-19T01:00:00.000Z', account: { daily: [] }, posts: [post('Bili', 'BV1', '2026-11-15 10:00:00')] });
    const run = (platformCode, finishedAt, result, extra = {}) => recordRun(db, { runId: finishedAt, platformCode, uid: 'u', startedAt: finishedAt, finishedAt, result, ...extra });
    run('Douyin', '2026-11-18T01:00:00.000Z', 'failed', { message: '旧的' });
    run('Douyin', '2026-11-19T01:00:00.000Z', 'ok', { postCount: 3 });
    run('Bili', '2026-11-19T01:00:00.000Z', 'skipped', { reason: 'busy', message: '另一个任务正占着这个 space' });
    run(XHS, '2026-11-19T01:00:00.000Z', 'out', { message: '未登录' });
    return { dir, db };
  }

  test('近 30 天、按发布时间倒序、null 保留、每平台最近一次采集', () => {
    const { db } = seeded();
    const v = worksView(db, { nowMs: NOW });
    assert.deepEqual(v.works.map((w) => [w.platform, w.postId]), [['douyin', 'b'], ['bilibili', 'BV1'], ['douyin', 'a']]);
    const b = v.works[0];
    assert.deepEqual(b, { platform: 'douyin', platformCode: 'Douyin', name: '抖音', postId: 'b', title: 't-b', postTime: '2026-11-18 21:00:00', statusText: '已发布', url: null,
      view: null, like: null, comment: 1, favorite: null, forward: 0, fansAdd: null });
    assert.deepEqual(v.platforms.map((p) => [p.platform, p.name, p.lastRun && p.lastRun.result, p.lastRun && p.lastRun.reason]),
      [['douyin', '抖音', 'ok', null], ['xhs', '小红书', 'out', null], ['bilibili', 'B站', 'skipped', 'busy'], ['channels', '视频号', null, null]]);
    assert.equal(v.platforms[0].lastRun.finishedAt, '2026-11-19T01:00:00.000Z');
    assert.equal(v.platforms[2].lastRun.message, '另一个任务正占着这个 space');
    // 平台筛选：工作台的键和 platformCode 都认
    assert.deepEqual(worksView(db, { nowMs: NOW, platform: 'bilibili' }).works.map((w) => w.postId), ['BV1']);
    assert.deepEqual(worksView(db, { nowMs: NOW, platform: 'Douyin' }).works.map((w) => w.postId), ['b', 'a']);
  });

  test('readWorksView：只读打开；文件不存在或没有作品表时返回空结构', () => {
    const { dir } = seeded();
    const file = path.join(dir, 'ops.db');
    assert.equal(readWorksView(file, { nowMs: NOW }).works.length, 3);
    for (const f of [path.join(dir, 'nope.db'), (() => { const x = path.join(dir, 'bare.db'); openOpsDb(x).close(); return x; })()]) {
      const v = readWorksView(f, { nowMs: NOW });
      assert.deepEqual(v.works, []);
      assert.equal(v.platforms.length, 4);
      assert.ok(v.platforms.every((p) => p.lastRun === null));
    }
    assert.ok(!fs.existsSync(path.join(dir, 'nope.db')), '不存在时不建文件');
  });
});

describe('hub ops sync-followers 命令行', () => {
  test('用已有 ops.db 同步一次；hub.db 不存在时不建、退出码 1；--json 输出合法', () => {
    const dir = tmp(), db = opsDb(dir);
    daily(db, 'Bili', 'b1', [['2026-11-18', 7, 1]]);
    db.close();
    const env = { ...process.env, MAITIAN_CONFIG: path.join(dir, 'no-config.json'), MAITIAN_DB: path.join(dir, 'hub.db'), MAITIAN_OPS_DB: path.join(dir, 'ops.db'), MAITIAN_OPS_DIR: path.join(dir, 'ops') };
    const hub = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'src', 'hub.mjs'), 'ops', ...args], { env, encoding: 'utf8' });
    let r = hub('sync-followers');
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /hub\.db/);
    assert.ok(!fs.existsSync(path.join(dir, 'hub.db')));
    new DatabaseSync(path.join(dir, 'hub.db')).close();
    r = hub('sync-followers', '--json');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).written, 1);
    assert.equal(new DatabaseSync(path.join(dir, 'hub.db')).prepare("SELECT total FROM followers WHERE platform='bilibili'").get().total, 7);
    assert.match(hub('help').stdout, /sync-followers/);
  });
});

describe('GET /api/ops/works（起真的网页服务）', () => {
  async function serve(dir, run) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ web: { port, key: 'test-key' }, rootPath: dir }));
    const p = spawn(process.execPath, ['--input-type=module', '-e', `const { startWeb } = await import(${JSON.stringify(path.join(ROOT, 'src', 'web.mjs'))}); startWeb();`],
      { env: { ...process.env, MAITIAN_CONFIG: path.join(dir, 'config.json'), MAITIAN_DB: path.join(dir, 'hub.db'), MAITIAN_OPS_DB: path.join(dir, 'ops.db') }, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise((ok, bad) => { p.stdout.on('data', (d) => /麦田网页/.test(d) && ok()); p.on('exit', (c) => bad(new Error(`服务退出 ${c}`))); setTimeout(() => bad(new Error('服务没起来')), 10000); });
      const base = `http://127.0.0.1:${port}`;
      const get = (u, key = true) => fetch(base + u, key ? { headers: { cookie: 'mt_key=test-key' } } : {});
      await run(get);
    } finally { p.kill(); }
  }

  test('没带口令 401；带口令拿到四个平台的空结构（ops.db 不存在）；/works 页面能打开', async () => {
    const dir = tmp();
    await serve(dir, async (get) => {
      assert.equal((await get('/api/ops/works', false)).status, 401);
      const r = await get('/api/ops/works?platform=xhs');
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { platforms: [{ platform: 'xhs', platformCode: XHS, name: '小红书', lastRun: null }], works: [] });
      const page = await get('/works');
      assert.equal(page.status, 200);
      assert.match(await page.text(), /\/api\/ops\/works/);
      assert.ok(!fs.existsSync(path.join(dir, 'ops.db')), '只读：不建 ops.db');
    });
  });

  test('固定的 ops.db：倒序、null 保留、platforms[].lastRun；?platform=douyin 只给抖音；未带口令 /works 也是 401', async () => {
    const dir = tmp(), db = opsDb(dir);
    // 服务用真实时钟算近 30 天，发布时间按现在往回推
    const ago = (days) => new Date(Date.now() - days * 86400_000 + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
    const at = new Date().toISOString(), tB = ago(1);
    saveCollected(db, { runId: 'r1', platformCode: 'Douyin', uid: 'd1', at, account: { daily: [] }, posts: [
      { postId: 'a', platform: 'Douyin', title: '旧一点', postTime: ago(5), statusText: '已发布', view: 10, like: null, comment: 1, favorite: null, forward: 0, fansAdd: null },
      { postId: 'b', platform: 'Douyin', title: '最新', postTime: tB, statusText: '审核中', view: null, like: 2 },
      { postId: 'old', platform: 'Douyin', title: '超过 30 天', postTime: ago(40), statusText: '已发布' }] });
    saveCollected(db, { runId: 'r1', platformCode: 'Bili', uid: 'b1', at, account: { daily: [] }, posts: [{ postId: 'BV1', platform: 'Bili', title: 'B站的', postTime: ago(3), statusText: '已发布', view: 5 }] });
    recordRun(db, { runId: 'r0', platformCode: 'Douyin', uid: 'd1', startedAt: '2026-11-18T01:00:00.000Z', finishedAt: '2026-11-18T01:00:00.000Z', result: 'failed', message: '旧的' });
    recordRun(db, { runId: 'r1', platformCode: 'Douyin', uid: 'd1', startedAt: at, finishedAt: at, result: 'ok', postCount: 3 });
    recordRun(db, { runId: 'r1', platformCode: 'Bili', uid: 'b1', startedAt: at, finishedAt: at, result: 'skipped', reason: 'busy', message: '另一个任务正占着这个 space' });
    db.close();
    await serve(dir, async (get) => {
      assert.equal((await get('/works', false)).status, 401);
      assert.equal((await get('/api/ops/works', false)).status, 401);
      const all = await (await get('/api/ops/works')).json();
      assert.deepEqual(all.works.map((w) => [w.platform, w.postId]), [['douyin', 'b'], ['bilibili', 'BV1'], ['douyin', 'a']]);
      assert.deepEqual(all.works[0], { platform: 'douyin', platformCode: 'Douyin', name: '抖音', postId: 'b', title: '最新', postTime: tB, statusText: '审核中', url: null,
        view: null, like: 2, comment: null, favorite: null, forward: null, fansAdd: null });
      assert.deepEqual(all.platforms.map((p) => [p.platform, p.lastRun && p.lastRun.result, p.lastRun && p.lastRun.reason]),
        [['douyin', 'ok', null], ['xhs', null, null], ['bilibili', 'skipped', 'busy'], ['channels', null, null]]);
      assert.equal(all.platforms[0].lastRun.finishedAt, at);
      assert.equal(all.platforms[2].lastRun.message, '另一个任务正占着这个 space');
      const dy = await (await get('/api/ops/works?platform=douyin')).json();
      assert.deepEqual(dy.works.map((w) => w.postId), ['b', 'a']);
      assert.deepEqual(dy.works[1].like, null);
      assert.deepEqual(dy.platforms.map((p) => p.platform), ['douyin']);
    });
  });
});

describe('hub ops collect 之后自动同步粉丝', () => {
  test('有平台 ok 时同步进 hub.db（--json 里有 followersSync）；hub.db 是坏文件时同步失败但 collect 退出码不变', async () => {
    const { prepareDb } = await import('./fixtures/ops-export/fake.mjs');
    const dir = tmp();
    prepareDb(path.join(dir, 'ops.db')).close();
    new DatabaseSync(path.join(dir, 'hub.db')).close();
    const env = { ...process.env, MAITIAN_CONFIG: path.join(dir, 'no-config.json'), MAITIAN_DB: path.join(dir, 'hub.db'), MAITIAN_OPS_DB: path.join(dir, 'ops.db'),
      MAITIAN_OPS_DIR: path.join(dir, 'ops'), MAITIAN_OPS_SHADOW_DIR: path.join(dir, 'shadow'), FAKE_NOW: String(NOW) };
    const fake = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'test', 'fixtures', 'ops-export', 'cli.mjs'), ...args], { env, encoding: 'utf8' });
    let r = fake('collect', '--json');
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.followersSync.ok, true);
    assert.equal(j.followersSync.written, 12);   // 四个平台 × （两天分日 + 今天的快照）
    const hub = new DatabaseSync(path.join(dir, 'hub.db'));
    assert.deepEqual(hub.prepare("SELECT platform, total, gain FROM followers WHERE day = '2026-11-18' ORDER BY platform").all().map((x) => ({ ...x })),
      ['bilibili', 'channels', 'douyin', 'xhs'].map((platform) => ({ platform, total: 100, gain: 2 })));
    assert.equal(hub.prepare("SELECT count(*) n FROM followers WHERE day = '2026-11-19' AND total = 100 AND source = 'ops'").get().n, 4);
    hub.close();
    fs.writeFileSync(path.join(dir, 'hub.db'), 'not a database');
    for (const f of ['hub.db-wal', 'hub.db-shm']) fs.rmSync(path.join(dir, f), { force: true });
    r = fake('collect');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /粉丝同步出错/);
  });
});
