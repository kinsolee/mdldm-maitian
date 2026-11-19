// 账号层（src/ops/）：不需要 Ego Lite，全部注入假的 runInSpace、时钟、notify，数据放临时目录。
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/ops/cli.mjs';
import { openOpsDb, listAccounts, getAccount, requireCapability, seedAccounts } from '../src/ops/store.mjs';
import { checkLogin, startLogin } from '../src/ops/login.mjs';
import { initTokens, requireToken } from '../src/ops/tokens.mjs';
import { resolvePlatform } from '../src/ops/accounts.mjs';
import { CHECKS, detect, openLogin, DETECT_SCRIPT, LOGIN_SCRIPT } from '../src/ops/probe.mjs';

const H = 3600_000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ops-test-'));

// 一套测试环境：临时 ops 目录、可拨的时钟、记下调用的假 runInSpace 和 notify
function env(reply = () => ({ ok: true, result: { state: 'ok', uidSeen: null } })) {
  const dir = tmp();
  const e = { dir, t: Date.parse('2026-11-19T00:00:00Z'), calls: [], finishes: [], notes: [], lines: [], errs: [], running: 0 };
  e.finishReply = () => ({ ok: true, result: { closed: true } });
  e.deps = {
    dir,
    now: () => e.t,
    // running：runInSpace 还没返回（还持有 space 锁）的调用数；finishSpace 记下被调时的值
    runInSpace: async (opts) => { e.running++; try { e.calls.push(opts); await null; return reply(opts); } finally { e.running--; } },
    finishSpace: async (space, opts) => { e.finishes.push({ space, opts, running: e.running }); return e.finishReply(space); },
    notify: async (text) => { e.notes.push(text); },
    out: (s) => e.lines.push(s),
    err: (s) => e.errs.push(s),
  };
  e.run = (...argv) => main(argv, e.deps);
  e.rows = () => e.lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  e.acct = (code) => { const db = openOpsDb(dir); try { return getAccount(db, code); } finally { db.close(); } };
  e.reset = () => { e.calls.length = 0; e.finishes.length = 0; e.lines.length = 0; e.errs.length = 0; };
  return e;
}

describe('ops.db', () => {
  test('建表：accounts 主键 (platformCode, uid)，loginState 有 CHECK 约束，actions 有幂等键唯一约束', () => {
    const db = openOpsDb(tmp());
    const pk = db.prepare("SELECT name, pk FROM pragma_table_info('accounts') WHERE pk > 0 ORDER BY pk").all().map((r) => r.name);
    assert.deepEqual(pk, ['platformCode', 'uid']);
    const cols = db.prepare("SELECT name FROM pragma_table_info('accounts')").all().map((r) => r.name);
    assert.ok(!cols.includes('spaceId'), '不存 spaceId');
    for (const c of ['platformName', 'nickname', 'profileId', 'spaceName', 'loginState', 'loginCheckedAt', 'capabilities', 'lastAlertAt']) assert.ok(cols.includes(c), c);
    seedAccounts(db);
    assert.throws(() => db.prepare("UPDATE accounts SET loginState='bogus'").run(), /CHECK/);
    assert.throws(() => db.prepare("INSERT INTO accounts (platformCode, uid, platformName, profileId, spaceName, capabilities) VALUES ('Douyin','106707338905','抖音','Profile 5','x','{}')").run(), /UNIQUE|PRIMARY/);
    const ins = db.prepare("INSERT INTO actions (caller, platformCode, uid, action, idempotencyKey, status, createdAt) VALUES ('t','Douyin','106707338905','reply','k1','planned','now')");
    ins.run();
    assert.throws(() => ins.run(), /UNIQUE/);
    db.close();
  });

  test('requireCapability：false 拒绝，退出码 7；true 放行', () => {
    const db = openOpsDb(tmp());
    seedAccounts(db);
    const dy = getAccount(db, 'Douyin');
    assert.deepEqual(requireCapability(dy, 'readComments'), { ok: true });
    const r = requireCapability(dy, 'reply');
    assert.equal(r.ok, false); assert.equal(r.reason, 'capability-disabled'); assert.equal(r.exitCode, 7);
    assert.equal(requireCapability(dy, 'nope').ok, false);
    assert.equal(requireCapability(getAccount(db, 'Weibo'), 'readWorks').ok, false);
    db.close();
  });
});

describe('accounts seed / list', () => {
  test('初值：10 个平台、Profile 5、unknown；pending 的三个；能力按 S0 ⑥⑦', async () => {
    const e = env();
    assert.equal(await e.run('accounts', 'seed'), 0);
    const db = openOpsDb(e.dir);
    const all = listAccounts(db); db.close();
    assert.deepEqual(all.map((a) => a.platformCode), ['Douyin', 'XiaoHongShu', 'Bili', 'GongZhongHao', 'Weibo', 'Channels', 'X', 'YouTube', 'Instagram', 'Zhishi']);
    for (const a of all) {
      assert.equal(a.profileId, 'Profile 5'); assert.equal(a.loginState, 'unknown');
      assert.equal(a.spaceName, `kinso/${a.platformCode}/${a.uid}`);
      assert.equal(a.capabilities.reply || a.capabilities.sendDM || a.capabilities.publish, false);
    }
    const by = Object.fromEntries(all.map((a) => [a.platformCode, a]));
    for (const c of ['X', 'YouTube', 'Channels']) assert.equal(by[c].uid, 'pending');
    const on = (cap) => all.filter((a) => a.capabilities[cap]).map((a) => a.platformCode).sort();
    assert.deepEqual(on('readWorks'), ['Bili', 'Channels', 'Douyin', 'XiaoHongShu']);
    assert.deepEqual(on('readComments'), ['Channels', 'Douyin', 'XiaoHongShu']);
    assert.deepEqual(on('readDM'), ['Channels', 'Douyin', 'XiaoHongShu']);
  });

  test('幂等：重复跑不改已有行的登录状态和已登记 uid（包括 pending 改名后的）', async () => {
    const e = env(() => ({ ok: true, result: { state: 'ok', uidSeen: 'finder_abc' } }));
    await e.run('accounts', 'seed');
    await e.run('login', '--check', 'channels');
    const before = JSON.stringify(listAccounts(openOpsDb(e.dir)));
    e.reset();
    assert.equal(await e.run('accounts', 'seed'), 0);
    assert.match(e.lines[0], /新登记 0 个/);
    assert.equal(JSON.stringify(listAccounts(openOpsDb(e.dir))), before);
    assert.equal(e.acct('Channels').uid, 'finder_abc');
  });

  test('list 每行一个 JSON，不含凭据字段', async () => {
    const e = env();
    await e.run('accounts', 'seed'); e.reset();
    assert.equal(await e.run('accounts', 'list'), 0);
    assert.equal(e.rows().length, 10);
    assert.doesNotMatch(e.lines.join('\n'), /token|cookie|password/i);
  });
});

describe('平台参数', () => {
  test('platformCode 不分大小写、中文名、麦田 id 都认', () => {
    for (const [arg, code] of [['douyin', 'Douyin'], ['XHS', 'XiaoHongShu'], ['小红书', 'XiaoHongShu'], ['bilibili', 'Bili'], ['b站', 'Bili'], ['channels', 'Channels'], ['视频号', 'Channels'], ['zsz', 'Zhishi'], ['youtube', 'YouTube'], ['x', 'X'], ['公众号', 'GongZhongHao']]) assert.equal(resolvePlatform(arg)?.code, code, arg);
    assert.equal(resolvePlatform('tiktok'), null);
  });
});

describe('login --check', () => {
  let e;
  beforeEach(async () => { e = env(); await e.run('accounts', 'seed'); e.reset(); });

  test('只读调用：lock skip、不收回、交的是检测脚本；ok 写回状态和检测时间', async () => {
    e.deps.runInSpace = async (o) => { e.calls.push(o); return { ok: true, result: { state: 'ok', uidSeen: '106707338905', evidence: 'x' } }; };
    assert.equal(await e.run('login', '--check', 'douyin'), 0);
    assert.equal(e.calls.length, 1);
    const c = e.calls[0];
    assert.equal(c.space, 'kinso/Douyin/106707338905'); assert.equal(c.lock, 'skip'); assert.equal(c.takeBack, false); assert.equal(c.profileId, 'Profile 5');
    assert.equal(c.script, DETECT_SCRIPT); assert.doesNotMatch(c.script, /handOff/);
    const a = e.acct('Douyin');
    assert.equal(a.loginState, 'ok'); assert.equal(a.loginCheckedAt, new Date(e.t).toISOString());
    assert.equal(e.rows()[0].uid, '106707338905');
  });

  test('--take-back 才传 takeBack: true', async () => {
    await e.run('login', '--check', 'douyin', '--take-back');
    assert.equal(e.calls[0].takeBack, true);
  });

  test('登录有效但没读到 uid：记 ok，输出 uid 未读到', async () => {
    assert.equal(await e.run('login', '--check', 'weibo'), 0);
    assert.equal(e.acct('Weibo').loginState, 'ok');
    assert.equal(e.rows()[0].uid, '未读到');
  });

  test('user-owned 记 awaiting_user，不发提醒，退出码 4', async () => {
    e.deps.runInSpace = async () => ({ ok: false, reason: 'user-owned', error: 'x', exitCode: 4 });
    assert.equal(await e.run('login', '--check', 'bili'), 4);
    assert.equal(e.acct('Bili').loginState, 'awaiting_user');
    assert.equal(e.notes.length, 0);
  });

  test('locked / previous-still-running 不改状态，这一轮跳过，退出码 5', async () => {
    for (const reason of ['locked', 'previous-still-running']) {
      e.deps.runInSpace = async () => ({ ok: false, reason, error: 'x', exitCode: 5 });
      assert.equal(await e.run('login', '--check', 'bili'), 5);
      const a = e.acct('Bili');
      assert.equal(a.loginState, 'unknown'); assert.equal(a.loginCheckedAt, null);
      assert.match(e.rows().at(-1).note, /跳过/);
    }
  });

  test('out：写回 out 并发飞书卡片；6 小时内不重复，6 小时后再发', async () => {
    e.deps.runInSpace = async () => ({ ok: true, result: { state: 'out', uidSeen: null } });
    assert.equal(await e.run('login', '--check', 'douyin'), 0);
    assert.equal(e.acct('Douyin').loginState, 'out');
    assert.equal(e.notes.length, 1);
    assert.match(e.notes[0], /^❌/);
    assert.match(e.notes[0], /抖音：未登录/);
    assert.match(e.notes[0], /hub ops login douyin/);
    e.t += 5 * H;
    await e.run('login', '--check', 'douyin');
    assert.equal(e.notes.length, 1);
    assert.equal(e.rows().at(-1).alert, 'throttled');
    e.t += 1 * H;
    await e.run('login', '--check', 'douyin');
    assert.equal(e.notes.length, 2);
  });

  test('notify 没发出去（返回 false）不记节流时间，下一轮还会发', async () => {
    e.deps.runInSpace = async () => ({ ok: true, result: { state: 'out' } });
    e.deps.notify = async (t) => { e.notes.push(t); return false; };
    await e.run('login', '--check', 'douyin');
    await e.run('login', '--check', 'douyin');
    assert.equal(e.notes.length, 2);
    assert.equal(e.acct('Douyin').lastAlertAt, null);
  });

  test('uid 不一致：硬停，登记一个字段都不改，退出码 6', async () => {
    const before = e.acct('Bili');
    e.deps.runInSpace = async () => ({ ok: true, result: { state: 'ok', uidSeen: 12345 } });
    assert.equal(await e.run('login', '--check', 'bili'), 6);
    assert.deepEqual(e.acct('Bili'), before);
    const row = e.rows()[0];
    assert.equal(row.reason, 'uid-mismatch');
    assert.match(row.error, /B站/); assert.match(row.error, /478358005/); assert.match(row.error, /12345/); assert.match(row.error, /长度 5/);
    assert.equal(e.notes.length, 0);
  });

  test('pending uid 读到真实值：主键 uid 和 spaceName 一起改，输出写明改名', async () => {
    e.deps.runInSpace = async (o) => { e.calls.push(o); return { ok: true, result: { state: 'ok', uidSeen: 'UCabc_123' } }; };
    assert.equal(await e.run('login', '--check', 'youtube'), 0);
    const db = openOpsDb(e.dir);
    const yt = db.prepare("SELECT * FROM accounts WHERE platformCode='YouTube'").all();
    db.close();
    assert.equal(yt.length, 1);
    assert.equal(yt[0].uid, 'UCabc_123'); assert.equal(yt[0].spaceName, 'kinso/YouTube/UCabc_123'); assert.equal(yt[0].loginState, 'ok');
    assert.match(e.rows()[0].note, /space 改名：kinso\/YouTube\/pending → kinso\/YouTube\/UCabc_123/);
    // 下一次检测用新名字，读到同一个 uid 算一致，不再关任何 space
    e.reset();
    assert.equal(await e.run('login', '--check', 'youtube'), 0);
    assert.equal(e.calls[0].space, 'kinso/YouTube/UCabc_123');
    assert.equal(e.finishes.length, 0);
  });

  test('X-B7 pending 改名后关旧 space：runInSpace 返回（锁释放）之后才 finishSpace(旧名)', async () => {
    e.deps.runInSpace = async (o) => { e.running++; try { e.calls.push(o); await null; return { ok: true, result: { state: 'ok', uidSeen: 'v2_finder' } }; } finally { e.running--; } };
    assert.equal(await e.run('login', '--check', 'channels'), 0);
    assert.deepEqual(e.finishes.map((f) => [f.space, f.opts.profileId, f.running]), [['kinso/Channels/pending', 'Profile 5', 0]]);
    const row = e.rows()[0];
    assert.equal(row.oldSpace, 'closed');
    assert.match(row.note, /旧 space kinso\/Channels\/pending 已关/);
  });

  test('X-B7 旧 space 在负责人手里（user-owned）：不碰，输出写明没关，登记照改', async () => {
    e.deps.runInSpace = async () => ({ ok: true, result: { state: 'ok', uidSeen: 'kinso_x' } });
    e.finishReply = () => ({ ok: false, reason: 'user-owned', error: 'x', exitCode: 4 });
    assert.equal(await e.run('login', '--check', 'x'), 0);
    assert.equal(e.finishes.length, 1);
    assert.equal(e.acct('X').uid, 'kinso_x');
    assert.equal(e.rows()[0].oldSpace, 'user-owned');
    assert.match(e.rows()[0].note, /旧 space kinso\/X\/pending 在你手里，没关/);
  });

  test('X-B7 关旧 space 失败：登记已改，退出码 1，提示手动关', async () => {
    e.deps.runInSpace = async () => ({ ok: true, result: { state: 'ok', uidSeen: 'UCzz' } });
    e.finishReply = () => ({ ok: false, reason: 'timeout', error: 'slow' });
    assert.equal(await e.run('login', '--check', 'youtube'), 1);
    assert.equal(e.acct('YouTube').spaceName, 'kinso/YouTube/UCzz');
    assert.match(e.rows()[0].note, /没关掉（timeout/);
  });

  test('X-B7 uid 不是 pending 时不关任何 space', async () => {
    e.deps.runInSpace = async () => ({ ok: true, result: { state: 'ok', uidSeen: '478358005' } });
    await e.run('login', '--check', 'bili');
    assert.equal(e.finishes.length, 0);
  });

  test('pending 但这次没登录（out）不改名', async () => {
    e.deps.runInSpace = async () => ({ ok: true, result: { state: 'out', uidSeen: null } });
    await e.run('login', '--check', 'x');
    assert.equal(e.acct('X').uid, 'pending');
    assert.equal(e.acct('X').loginState, 'out');
  });

  test('不带平台：检测 8 个，跳过 Instagram 和知识站；Instagram、知识站不调 runInSpace', async () => {
    assert.equal(await e.run('login', '--check'), 0);
    const spaces = e.calls.map((c) => c.space);
    assert.equal(spaces.length, 8);
    assert.ok(!spaces.some((s) => /Instagram|Zhishi/.test(s)));
    const skipped = e.rows().filter((r) => r.result === 'skipped').map((r) => r.platformCode);
    assert.deepEqual(skipped, ['Instagram', 'Zhishi']);
    assert.match(e.rows().find((r) => r.platformCode === 'Instagram').note, /跳过：负责人定为暂时不处理/);
  });

  test('多个平台取最严重的退出码，逐平台一行 JSON', async () => {
    e.deps.runInSpace = async ({ space }) => (/Bili/.test(space) ? { ok: true, result: { state: 'ok', uidSeen: '1' } } : /Douyin/.test(space) ? { ok: false, reason: 'locked', exitCode: 5 } : { ok: true, result: { state: 'ok' } });
    assert.equal(await e.run('login', '--check'), 6);
    assert.equal(e.rows().length, 10);
  });

  test('runner 出错（timeout）不改状态，退出码 1', async () => {
    e.deps.runInSpace = async () => ({ ok: false, reason: 'timeout', error: 'x' });
    assert.equal(await e.run('login', '--check', 'douyin'), 1);
    assert.equal(e.acct('Douyin').loginState, 'unknown');
  });

  test('G-B4 公众号登录成别的号：读出实际 gh_ 号，uid-mismatch 硬停（6），登记不变', async () => {
    const before = e.acct('GongZhongHao');
    e.deps.runInSpace = async ({ params }) => ({ ok: true, result: await CHECKS[params.platformCode].check(fakePage({ url: 'https://mp.weixin.qq.com/cgi-bin/home?token=9', evaluate: () => ({ own: null, ghs: ['gh_other0000001'] }) }), params) });
    assert.equal(await e.run('login', '--check', '公众号'), 6);
    assert.deepEqual(e.acct('GongZhongHao'), before);
    assert.match(e.rows()[0].error, /gh_other0000001/);
  });

  test('G-B4 pending 读到不合格的 uid（pending、空白、含 /）不改登记，退出码 1', async () => {
    for (const bad of ['pending', 'a b', 'x/y', ' ']) {
      e.deps.runInSpace = async () => ({ ok: true, result: { state: 'ok', uidSeen: bad } });
      assert.equal(await e.run('login', '--check', 'youtube'), 1, JSON.stringify(bad));
      const yt = e.acct('YouTube');
      assert.equal(yt.uid, 'pending'); assert.equal(yt.spaceName, 'kinso/YouTube/pending'); assert.equal(yt.loginState, 'unknown');
    }
    assert.equal(e.finishes.length, 0);
  });

  test('G-B3 --check 放在平台名后面也是只读检测，不 handOff、不改成 awaiting_user', async () => {
    assert.equal(await e.run('login', 'douyin', '--check'), 0);
    assert.equal(e.calls[0].lock, 'skip'); assert.equal(e.calls[0].script, DETECT_SCRIPT);
    assert.equal(e.acct('Douyin').loginState, 'ok');
    e.reset();
    assert.equal(await e.run('login', 'douyin', '--take-back', '--check'), 0);
    assert.equal(e.calls[0].takeBack, true); assert.equal(e.calls[0].script, DETECT_SCRIPT);
  });

  test('G-B3 参数不对一律打印用法、退出码 2，不调 runInSpace', async () => {
    const bad = [
      ['login', 'douyin', '--take-back'], ['login', '--take-back'], ['login', '--check', 'douyin', 'bili'], ['login'],
      ['login', 'douyin', 'bili'], ['login', '--check', '--force'], ['login', 'douyin', '-x'], ['login', '--check', '--check'],
      ['accounts', 'seed', 'extra'], ['accounts', 'list', '--all'], ['tokens', 'init', 'x'], ['tokens'], ['accounts'], ['nope'],
    ];
    for (const argv of bad) {
      e.errs.length = 0;
      assert.equal(await e.run(...argv), 2, argv.join(' '));
      assert.match(e.errs.join('\n'), /login --check/, argv.join(' '));
    }
    assert.equal(e.calls.length, 0);
  });

  test('点名 Instagram / 知识站：拒绝，不调 runInSpace', async () => {
    for (const p of ['instagram', 'Instagram', '知识站', 'zsz']) {
      assert.equal(await e.run('login', '--check', p), 2);
      assert.equal(await e.run('login', p), 2);
    }
    assert.equal(e.calls.length, 0);
  });

  test('认不出的平台退出码 2', async () => {
    assert.equal(await e.run('login', '--check', 'tiktok'), 2);
    assert.equal(e.calls.length, 0);
  });
});

describe('U1 不处理的平台：直接调库函数也不交给 runner', () => {
  test('checkLogin / startLogin 对 Instagram、知识站不调 runInSpace', async () => {
    const db = openOpsDb(tmp());
    seedAccounts(db);
    let calls = 0;
    const deps = { runInSpace: async () => { calls++; return { ok: true, result: { state: 'ok' } }; }, finishSpace: async () => { calls++; return { ok: true }; }, notify: async () => {}, now: () => 0 };
    for (const code of ['Instagram', 'Zhishi']) {
      const acct = getAccount(db, code);
      const r = await checkLogin(db, [acct], deps);
      assert.equal(r.rows[0].result, 'skipped'); assert.equal(r.exitCode, 0);
      const s = await startLogin(db, acct, deps);
      assert.equal(s.reason, 'out-of-scope'); assert.equal(s.exitCode, 2);
      assert.equal(getAccount(db, code).loginState, 'unknown');
    }
    assert.equal(calls, 0);
    db.close();
  });
});

describe('login <平台>（人发起的扫码）', () => {
  test('lock wait、交登录脚本；成功记 awaiting_user 并提示 --take-back', async () => {
    const e = env(() => ({ ok: true, result: { handedOff: true } }));
    await e.run('accounts', 'seed'); e.reset();
    assert.equal(await e.run('login', '小红书'), 0);
    const c = e.calls[0];
    assert.equal(c.lock, 'wait'); assert.equal(c.script, LOGIN_SCRIPT); assert.ok(!c.takeBack);
    assert.equal(e.acct('XiaoHongShu').loginState, 'awaiting_user');
    assert.match(e.lines.join('\n'), /hub ops login --check xiaohongshu --take-back/);
  });

  test('没登记过：提示先 seed，退出码 2', async () => {
    const e = env();
    assert.equal(await e.run('login', 'douyin'), 2);
    assert.match(e.errs.join('\n'), /accounts seed/);
  });
});

describe('口令', () => {
  const HEX = /^[0-9a-f]{64}$/;
  let n = 0;
  const gen = () => (++n).toString(16).padStart(64, 'a');

  test('tokens init：生成两个、权限 600、.gitignore 有 .env；再跑一次不覆盖', async () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, '.gitignore'), 'data/');
    const e = env();
    e.deps.root = root; e.deps.genToken = gen;
    assert.equal(await e.run('tokens', 'init'), 0);
    const envFile = path.join(root, '.env');
    const first = fs.readFileSync(envFile, 'utf8');
    assert.match(first, /^MAITIAN_ENGAGE_TOKEN=[0-9a-f]{64}$/m);
    assert.match(first, /^MAITIAN_PUBLISH_TOKEN=[0-9a-f]{64}$/m);
    assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
    assert.deepEqual(fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n').filter(Boolean), ['data/', '.env']);
    for (const v of first.match(/[0-9a-f]{64}/g)) assert.ok(!e.lines.join('\n').includes(v) && !e.errs.join('\n').includes(v), '输出里不能有口令值');
    assert.match(e.lines.join('\n'), /已生成/);

    e.reset();
    fs.chmodSync(envFile, 0o644);
    assert.equal(await e.run('tokens', 'init'), 0);
    assert.equal(fs.readFileSync(envFile, 'utf8'), first);
    assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
    assert.match(e.lines.join('\n'), /MAITIAN_ENGAGE_TOKEN：已存在/);
    assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8').match(/^\.env$/gm).length, 1);
  });

  test('默认用 openssl rand -hex 32 生成', () => {
    const root = tmp();
    initTokens({ root });
    const vals = fs.readFileSync(path.join(root, '.env'), 'utf8').match(/=(.*)$/gm).map((s) => s.slice(1));
    assert.equal(vals.length, 2);
    for (const v of vals) assert.match(v, HEX);
    assert.notEqual(vals[0], vals[1]);
  });

  test('已有其他变量和其中一个口令：只补缺的', () => {
    const root = tmp();
    const keep = 'b'.repeat(64);
    fs.writeFileSync(path.join(root, '.env'), `FOO=1\nMAITIAN_ENGAGE_TOKEN=${keep}`);
    const r = initTokens({ root, gen });
    const text = fs.readFileSync(path.join(root, '.env'), 'utf8');
    assert.match(text, /^FOO=1$/m);
    assert.ok(text.includes(`MAITIAN_ENGAGE_TOKEN=${keep}\n`));
    assert.match(text, /^MAITIAN_PUBLISH_TOKEN=[0-9a-f]{64}$/m);
    assert.deepEqual(r.tokens.map((t) => t.status), ['已存在', '已生成']);
  });

  test('G-B2 requireToken：没有 .env 拒绝（退出码 8），哪怕环境变量是合格的 64 位 hex', () => {
    const root = tmp();
    const r = requireToken('engage', { MAITIAN_ENGAGE_TOKEN: 'c'.repeat(64) }, { root });
    assert.equal(r.ok, false); assert.equal(r.exitCode, 8); assert.equal(r.reason, 'token-missing');
    assert.equal(requireToken('other', {}, { root }).ok, false);
  });

  test('G-B2 requireToken：伪造的 64 位 hex 被拒，和 .env 一致才放行；报错不带值', () => {
    const root = tmp();
    initTokens({ root, gen });
    const real = fs.readFileSync(path.join(root, '.env'), 'utf8').match(/^MAITIAN_ENGAGE_TOKEN=(.*)$/m)[1];
    const fake = 'd'.repeat(64);
    const bad = requireToken('engage', { MAITIAN_ENGAGE_TOKEN: fake }, { root });
    assert.equal(bad.ok, false); assert.equal(bad.exitCode, 8);
    assert.ok(!bad.error.includes(fake) && !bad.error.includes(real));
    const short = requireToken('engage', { MAITIAN_ENGAGE_TOKEN: 'short-secret' }, { root });
    assert.equal(short.exitCode, 8); assert.doesNotMatch(short.error, /short-secret/);
    assert.equal(requireToken('engage', {}, { root }).exitCode, 8);
    assert.deepEqual(requireToken('engage', { MAITIAN_ENGAGE_TOKEN: real }, { root }), { ok: true });
    // engage 的口令不能拿去过 publish
    assert.equal(requireToken('publish', { MAITIAN_PUBLISH_TOKEN: real }, { root }).ok, false);
  });

  test('G-B2 requireToken：.env 里的值格式不对也拒绝', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, '.env'), 'MAITIAN_ENGAGE_TOKEN=abc\n');
    assert.equal(requireToken('engage', { MAITIAN_ENGAGE_TOKEN: 'abc' }, { root }).exitCode, 8);
  });
});

describe('检测脚本和判据（假页面，不需要 Ego Lite）', () => {
  test('交给 runInSpace 的两段脚本能作为 async 函数体编译', () => {
    const AsyncFunction = (async () => {}).constructor;
    for (const s of [DETECT_SCRIPT, LOGIN_SCRIPT]) assert.doesNotThrow(() => new AsyncFunction('task', 'params', 'withForegroundLock', s));
  });

  test('DETECT_SCRIPT 按 file:// 地址加载 probe 模块并跑 detect', async () => {
    const AsyncFunction = (async () => {}).constructor;
    const task = fakeTask({ url: 'https://member.bilibili.com/platform/home', fetch: () => ({ code: 0, data: { isLogin: true, mid: 478358005 } }) });
    const r = await new AsyncFunction('task', 'params', DETECT_SCRIPT)(task, { platformCode: 'Bili', uid: '478358005', settleMs: 0 });
    assert.deepEqual([r.state, r.uidSeen], ['ok', '478358005']);
    assert.equal(task.gotos[0].opts.waitUntil, 'commit');
    assert.equal(task.handedOff, 0);
  });

  test('各平台判据：ok / out 和 uid', async () => {
    const cases = [
      ['Douyin', { fetch: () => ({ status_code: 0, user: { uid: 106707338905 } }) }, 'ok', '106707338905'],
      ['Douyin', { fetch: () => ({ status_code: 8 }) }, 'out', null],
      ['XiaoHongShu', { fetch: (u) => (/user\/info/.test(u) ? { data: { userId: 'u1' } } : { code: 0 }) }, 'ok', 'u1'],
      ['XiaoHongShu', { url: 'https://creator.xiaohongshu.com/login', fetch: () => ({ code: -1 }) }, 'out', null],
      ['Bili', { fetch: () => ({ code: -101 }) }, 'out', null],
      ['Channels', { fetch: () => ({ errCode: 0, data: { finderUser: { uniqId: 'v2_x', finderUsername: 'not-this' } } }) }, 'ok', 'v2_x'],
      ['Channels', { url: 'https://channels.weixin.qq.com/login.html', fetch: () => ({ errCode: 300333 }) }, 'out', null],
      ['YouTube', { url: 'https://studio.youtube.com/channel/UCabc-1' }, 'ok', 'UCabc-1'],
      ['YouTube', { url: 'https://accounts.google.com/signin' }, 'out', null],
      ['X', { url: 'https://x.com/home', evaluate: () => 'kinso' }, 'ok', 'kinso'],
      ['X', { url: 'https://x.com/i/flow/login', evaluate: () => null }, 'out', null],
      ['Weibo', { url: 'https://weibo.com/', fetch: () => ({ ok: 1 }), evaluate: () => '2272770294' }, 'ok', '2272770294'],
      ['Weibo', { url: 'https://passport.weibo.com/visitor', fetch: () => ({ ok: 1 }), evaluate: () => '' }, 'out', null],
      ['GongZhongHao', { url: 'https://mp.weixin.qq.com/cgi-bin/home?t=home&token=123', evaluate: () => ({ own: 'gh_eb2c407bc687', ghs: [] }) }, 'ok', 'gh_eb2c407bc687'],
      ['GongZhongHao', { url: 'https://mp.weixin.qq.com/', evaluate: () => ({ ghs: [], loginBox: true }) }, 'out', null],
    ];
    for (const [code, page, state, uid] of cases) {
      const r = await CHECKS[code].check(fakePage(page), { uid: code === 'GongZhongHao' ? 'gh_eb2c407bc687' : '1' });
      assert.deepEqual([r.state, r.uidSeen], [state, uid], `${code} ${state}`);
    }
  });

  test('openLogin 打开登录页，handOff 走前台锁', async () => {
    const task = fakeTask({ url: 'about:blank' });
    let locked = 0;
    const r = await openLogin(task, { platformCode: 'Douyin' }, (fn) => { locked++; return fn(); });
    assert.equal(r.handedOff, true);
    assert.equal(task.gotos[0].url, CHECKS.Douyin.loginUrl);
    assert.equal(task.handedOff, 1); assert.equal(locked, 1);
  });

  test('detect 对没有判据的平台返回 unknown，不开页面', async () => {
    const task = fakeTask({});
    assert.equal((await detect(task, { platformCode: 'Instagram' })).state, 'unknown');
    assert.equal(task.gotos.length, 0);
  });
});

function fakePage({ url = 'https://example.invalid/', fetch = () => ({}), evaluate = () => null }) {
  return { url: async () => url, fetch: async (u) => ({ status: 200, body: JSON.stringify(fetch(u)) }), evaluate: async () => evaluate() };
}
function fakeTask(opts) {
  const page = fakePage(opts);
  const task = { gotos: [], handedOff: 0, pages: async () => [page], handOff: async () => { task.handedOff++; } };
  page.goto = async (u, o) => { task.gotos.push({ url: u, opts: o }); };
  return task;
}
