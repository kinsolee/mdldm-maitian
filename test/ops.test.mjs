// hub ops 核心行为（不需要 Ego Lite）：账号表、导入、能力位、登录检测、掉线提醒、写入口令。
// 一律用临时目录里的 ops.db / .env，runner 和飞书通知都注入假的。
import { test, describe, beforeEach, after } from 'node:test';
import './helpers/ops-dir.mjs';   // 锁目录指到临时目录（必须在加载 runner 之前）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openOpsDb } from '../src/ops/db.mjs';
import { importAccounts, listAccounts, getAccount, setUid, setCapability, requireCapability, CAPABILITIES } from '../src/ops/accounts.mjs';
import { checkLogins, scanLogin, ALERT_INTERVAL_MS } from '../src/ops/login.mjs';
import { initTokens, checkToken, TOKEN_NAMES } from '../src/ops/tokens.mjs';

const SEED = path.resolve(import.meta.dirname, '../src/ops/accounts.seed.json');
const REPO = path.resolve(import.meta.dirname, '..');
const repoLeftovers = () => ['data', '.env'].filter((f) => fs.existsSync(path.join(REPO, f)));
const LEFTOVERS_BEFORE = repoLeftovers();
after(() => { assert.deepEqual(repoLeftovers(), LEFTOVERS_BEFORE, '测试不应在仓库根下留下 data/ 或 .env'); });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ops-test-'));

function freshDb() {
  const db = openOpsDb(path.join(tmp(), 'ops.db'));
  importAccounts(db, SEED);
  return db;
}

// 假 runner：按 space 名给结果；记下每次调用
function fakeRunner(byPlatform) {
  const calls = [];
  const runTask = async (opts) => {
    calls.push(opts);
    const code = opts.space.split('/')[1];
    const r = byPlatform[code];
    if (typeof r === 'function') return r(opts);
    return r ?? { ok: false, reason: 'exit-code', error: '没配' };
  };
  return { runTask, calls };
}
const okResult = (result) => ({ ok: true, result });
function fakeNotify() {
  const sent = [];
  const notify = async (text) => { sent.push(text); return true; };
  return { notify, sent };
}

describe('账号表与导入', () => {
  test('导入 10 个账号，space 名按 kinso/<platformCode>/<uid>，Profile 5', () => {
    const db = freshDb();
    const all = listAccounts(db);
    assert.equal(all.length, 10);
    const dy = getAccount(db, 'Douyin:106707338905');
    assert.equal(dy.spaceName, 'kinso/Douyin/106707338905');
    assert.equal(dy.profileId, 'Profile 5');
    assert.equal(dy.loginState, 'unknown');
    assert.equal(getAccount(db, 'Channels:pending').spaceName, 'kinso/Channels/pending');
  });

  test('重复导入不重复、不覆盖登录状态和已登记的真实 uid', async () => {
    const db = freshDb();
    setUid(db, 'X', 'kinsolee79');
    const { runTask } = fakeRunner({ Douyin: okResult({ state: 'ok', evidence: 'e', uidSeen: '106707338905' }) });
    await checkLogins(db, { platform: 'Douyin', runTask, notify: async () => {} });
    const r = importAccounts(db, SEED);
    assert.equal(r.inserted, 0);
    const all = listAccounts(db);
    assert.equal(all.length, 10);
    assert.equal(all.filter((a) => a.platformCode === 'X').length, 1);
    assert.equal(getAccount(db, 'X:kinsolee79').spaceName, 'kinso/X/kinsolee79');
    assert.equal(getAccount(db, 'Douyin:106707338905').loginState, 'ok');
  });

  test('能力位默认全 false，false 时被拒，打开后放行', () => {
    const db = freshDb();
    const a = getAccount(db, 'Bili:478358005');
    for (const c of CAPABILITIES) assert.equal(a.capabilities[c], false, c);
    assert.equal(CAPABILITIES.length, 11);
    assert.throws(() => requireCapability(db, 'Bili:478358005', 'reply'), /Bili:478358005.*reply/);
    setCapability(db, 'Bili:478358005', 'reply', true);
    assert.doesNotThrow(() => requireCapability(db, 'Bili:478358005', 'reply'));
    assert.throws(() => requireCapability(db, 'Bili:478358005', 'publish'), /publish/);
    assert.throws(() => setCapability(db, 'Bili:478358005', 'fly', true), /fly/);
    assert.throws(() => requireCapability(db, 'Nope:1', 'reply'), /Nope:1/);
  });

  test('手动 set-uid：pending 账号改成真实 uid，space 名跟着改', () => {
    const db = freshDb();
    setUid(db, 'YouTube', 'UCabc_123');
    assert.equal(getAccount(db, 'YouTube:pending'), null);
    assert.equal(getAccount(db, 'YouTube:UCabc_123').spaceName, 'kinso/YouTube/UCabc_123');
  });
});

describe('登录检测 check', () => {
  let db;
  beforeEach(() => { db = freshDb(); });

  test('ok：写回 ok、检测时间和证据；按账号的 space 名起任务，Profile 5', async () => {
    const { runTask, calls } = fakeRunner({ Bili: okResult({ state: 'ok', evidence: 'nav code=0', uidSeen: 478358005 }) });
    const r = await checkLogins(db, { platform: 'Bili', runTask, notify: async () => {}, now: () => 1000 });
    assert.equal(r.exitCode, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].space, 'kinso/Bili/478358005');
    assert.equal(calls[0].profileId, 'Profile 5');
    const a = getAccount(db, 'Bili:478358005');
    assert.equal(a.loginState, 'ok');
    assert.equal(a.loginEvidence, 'nav code=0');
    assert.equal(a.loginCheckedAt, new Date(1000).toISOString());
  });

  test('out：写 out，发一次掉线提醒', async () => {
    const { runTask } = fakeRunner({ Douyin: okResult({ state: 'out', evidence: 'status_code=8', uidSeen: null }) });
    const n = fakeNotify();
    const r = await checkLogins(db, { platform: 'Douyin', runTask, notify: n.notify });
    assert.equal(getAccount(db, 'Douyin:106707338905').loginState, 'out');
    assert.equal(n.sent.length, 1);
    assert.match(n.sent[0], /抖音/);
    assert.equal(r.rows[0].loginState, 'out');
  });

  test('UID 不符：硬停（非零）、发提醒、不写 ok，输出写明两个 uid', async () => {
    const { runTask } = fakeRunner({ Weibo: okResult({ state: 'ok', evidence: 'cfg', uidSeen: '999' }) });
    const n = fakeNotify();
    const r = await checkLogins(db, { platform: 'Weibo', runTask, notify: n.notify });
    assert.notEqual(r.exitCode, 0);
    const a = getAccount(db, 'Weibo:2272770294');
    assert.notEqual(a.loginState, 'ok');
    assert.equal(n.sent.length, 1);
    assert.match(r.rows[0].message, /2272770294/);
    assert.match(r.rows[0].message, /999/);
  });

  test('UID 不符的账号在多账号里也让整条命令非零', async () => {
    const { runTask } = fakeRunner({
      Weibo: okResult({ state: 'ok', evidence: 'cfg', uidSeen: '999' }),
      Bili: okResult({ state: 'ok', evidence: 'nav', uidSeen: '478358005' }),
    });
    const r = await checkLogins(db, { platforms: ['Weibo', 'Bili'], runTask, notify: async () => {} });
    assert.notEqual(r.exitCode, 0);
    assert.equal(getAccount(db, 'Bili:478358005').loginState, 'ok');
  });

  test('pending uid 被登记成真实 uid，spaceName 跟着改；X 的 handle 去掉 @', async () => {
    const { runTask } = fakeRunner({
      Channels: okResult({ state: 'ok', evidence: 'auth_data', uidSeen: 'sph_real1' }),
      X: okResult({ state: 'ok', evidence: 'side', uidSeen: '@kinsolee79' }),
    });
    const r = await checkLogins(db, { platforms: ['Channels', 'X'], runTask, notify: async () => {}, finishTask: async () => ({ ok: true }) });
    assert.equal(r.exitCode, 0);
    assert.equal(getAccount(db, 'Channels:pending'), null);
    const ch = getAccount(db, 'Channels:sph_real1');
    assert.equal(ch.spaceName, 'kinso/Channels/sph_real1');
    assert.equal(ch.loginState, 'ok');
    assert.equal(getAccount(db, 'X:kinsolee79').spaceName, 'kinso/X/kinsolee79');
    assert.equal(listAccounts(db).length, 10);
  });

  for (const [reason, code] of [['busy', 5], ['user-controlled', 4], ['profile-needed', 3]]) {
    test(`runner 返回 ${reason}：跳过、不改登录状态、不发提醒，单账号退出码 ${code}`, async () => {
      const ok = fakeRunner({ Bili: okResult({ state: 'ok', evidence: 'nav', uidSeen: '478358005' }) });
      await checkLogins(db, { platform: 'Bili', runTask: ok.runTask, notify: async () => {}, now: () => 5 });
      const before = getAccount(db, 'Bili:478358005');
      const { runTask } = fakeRunner({ Bili: { ok: false, reason, error: 'x' } });
      const n = fakeNotify();
      const r = await checkLogins(db, { platform: 'Bili', runTask, notify: n.notify, now: () => 99999 });
      assert.equal(r.exitCode, code);
      assert.equal(r.rows[0].skipped, reason);
      const after = getAccount(db, 'Bili:478358005');
      assert.equal(after.loginState, before.loginState);
      assert.equal(after.loginCheckedAt, before.loginCheckedAt);
      assert.equal(n.sent.length, 0);
    });
  }

  test('ok 但没读到 uid：已登记的、pending 的都不写 ok，记 unknown，退出码 1', async () => {
    const { runTask } = fakeRunner({
      GongZhongHao: okResult({ state: 'ok', evidence: '落地 URL 带 token；页面含登记的 gh_ id=false', uidSeen: null }),
      YouTube: okResult({ state: 'ok', evidence: 'studio', uidSeen: '' }),
    });
    const r = await checkLogins(db, { platforms: ['GongZhongHao', 'YouTube'], runTask, notify: async () => {} });
    assert.equal(r.exitCode, 1);
    const gzh = getAccount(db, 'GongZhongHao:gh_eb2c407bc687');
    assert.equal(gzh.loginState, 'unknown');
    assert.match(gzh.loginEvidence, /没读到 uid/);
    const yt = getAccount(db, 'YouTube:pending');
    assert.ok(yt, 'pending 账号不应被改 uid');
    assert.equal(yt.loginState, 'unknown');
    for (const row of r.rows) assert.equal(row.result, 'failed');
  });

  for (const [label, result] of [['state 不合法', { state: 'logged-in', evidence: 'e', uidSeen: '478358005' }], ['缺 evidence', { state: 'ok', uidSeen: '478358005' }], ['result 不是对象', 'ok'], ['result 缺失', undefined]]) {
    test(`结果结构不对（${label}）：记失败、不改登录状态，退出码 1`, async () => {
      const ok = fakeRunner({ Bili: okResult({ state: 'ok', evidence: 'nav', uidSeen: '478358005' }) });
      await checkLogins(db, { platform: 'Bili', runTask: ok.runTask, notify: async () => {}, now: () => 5 });
      const before = getAccount(db, 'Bili:478358005');
      const { runTask } = fakeRunner({ Bili: okResult(result) });
      const r = await checkLogins(db, { platform: 'Bili', runTask, notify: async () => {}, now: () => 99999 });
      assert.equal(r.exitCode, 1);
      assert.equal(r.rows[0].result, 'failed');
      const a = getAccount(db, 'Bili:478358005');
      assert.equal(a.loginState, before.loginState);
      assert.equal(a.loginCheckedAt, before.loginCheckedAt);
    });
  }

  test('知识站没配后台地址：记 unknown 并说明，不起任务', async () => {
    const { runTask, calls } = fakeRunner({});
    const r = await checkLogins(db, { platform: 'Zhishi', runTask, notify: async () => {}, siteAdmin: null });
    assert.equal(calls.length, 0);
    assert.equal(r.exitCode, 0);
    const z = getAccount(db, 'Zhishi:pending');
    assert.equal(z.loginState, 'unknown');
    assert.match(z.loginEvidence, /site\.admin/);
  });

  test('汇总和证据里不出现 token 值', async () => {
    const { runTask } = fakeRunner({ GongZhongHao: okResult({ state: 'ok', evidence: '落地 URL 带 token 参数（值不记）', uidSeen: 'gh_eb2c407bc687', url: 'https://mp.weixin.qq.com/cgi-bin/home?t=home&token=123456789' }) });
    const r = await checkLogins(db, { platform: 'GongZhongHao', runTask, notify: async () => {} });
    assert.doesNotMatch(JSON.stringify(r), /123456789/);
    assert.doesNotMatch(JSON.stringify(listAccounts(db)), /123456789/);
  });
});

describe('pending 迁移后关掉旧的 pending space', () => {
  const chOk = () => fakeRunner({ Channels: okResult({ state: 'ok', evidence: 'auth_data', uidSeen: 'sph_real1' }), Bili: okResult({ state: 'ok', evidence: 'nav', uidSeen: '478358005' }) });

  test('pending 改成真实 uid 后调用一次 finishTask，参数是旧 space 名和 Profile 5', async () => {
    const db = freshDb();
    const calls = [];
    const r = await checkLogins(db, { platform: 'Channels', runTask: chOk().runTask, notify: async () => {}, finishTask: async (space, o) => { calls.push([space, o?.profileId]); return { ok: true }; } });
    assert.deepEqual(calls, [['kinso/Channels/pending', 'Profile 5']]);
    assert.equal(r.exitCode, 0);
    assert.equal(r.rows[0].result, 'ok');
    assert.match(r.rows[0].message, /kinso\/Channels\/pending 已关/);
  });

  test('非 pending 账号不调用 finishTask', async () => {
    const db = freshDb();
    let n = 0;
    await checkLogins(db, { platform: 'Bili', runTask: chOk().runTask, notify: async () => {}, finishTask: async () => { n++; return { ok: true }; } });
    assert.equal(n, 0);
  });

  for (const [label, finishTask, why] of [
    ['返回 ok:false', async () => ({ ok: false, reason: 'user-controlled' }), /没关：user-controlled/],
    ['抛错', async () => { throw new Error('ego 挂了'); }, /没关：ego 挂了/],
  ]) {
    test(`finishTask ${label}：检测结果仍是 ok、退出码 0，message 说明没关`, async () => {
      const db = freshDb();
      const r = await checkLogins(db, { platform: 'Channels', runTask: chOk().runTask, notify: async () => {}, finishTask });
      assert.equal(r.exitCode, 0);
      assert.equal(r.rows[0].result, 'ok');
      assert.equal(getAccount(db, 'Channels:sph_real1').loginState, 'ok');
      assert.match(r.rows[0].message, why);
    });
  }

  test('scanLogin 把 finishTask 传给交还后的检测', async () => {
    const db = freshDb();
    const runTask = async (opts) => opts.params.mode === 'handoff' ? okResult({ handedOff: true }) : okResult({ state: 'ok', evidence: 'auth', uidSeen: 'sph_9' });
    const calls = [];
    const r = await scanLogin(db, 'Channels', { runTask, notify: async () => {}, sleep: async () => {}, pollMs: 1, maxWaitMs: 1000, finishTask: async (s) => { calls.push(s); return { ok: true }; } });
    assert.equal(r.exitCode, 0);
    assert.deepEqual(calls, ['kinso/Channels/pending']);
  });
});

describe('掉线提醒节流', () => {
  test('同一账号 6 小时内最多一次，过了 6 小时再掉线再发', async () => {
    const db = freshDb();
    let t = Date.parse('2026-11-19T00:00:00Z');
    const now = () => t;
    const n = fakeNotify();
    const seq = [];
    const { runTask } = fakeRunner({ Douyin: () => okResult(seq.shift()) });
    const run = async (state) => { seq.push({ state, evidence: state, uidSeen: state === 'ok' ? '106707338905' : null }); await checkLogins(db, { platform: 'Douyin', runTask, notify: n.notify, now }); };

    await run('out');                       // ok/unknown → out：发
    assert.equal(n.sent.length, 1);
    t += 60_000; await run('ok');
    t += 60_000; await run('out');          // 6 小时内又掉：不发
    assert.equal(n.sent.length, 1);
    t += 60_000; await run('out');          // 一直 out：不算「变成 out」
    assert.equal(n.sent.length, 1);
    t = Date.parse('2026-11-19T00:00:00Z') + ALERT_INTERVAL_MS; await run('ok');
    t += 1; await run('out');               // 超过 6 小时再掉：发
    assert.equal(n.sent.length, 2);
    assert.equal(ALERT_INTERVAL_MS, 6 * 3600_000);
  });
});

describe('评审第 1 轮补发（Gemini）', () => {
  test('昵称只在 UID 核对通过后写：错号的昵称不写进登记账号', async () => {
    const db = freshDb();
    const bad = fakeRunner({ Weibo: okResult({ state: 'ok', evidence: 'cfg', uidSeen: '999', nickname: '别人' }) });
    await checkLogins(db, { platform: 'Weibo', runTask: bad.runTask, notify: async () => true });
    assert.equal(getAccount(db, 'Weibo:2272770294').nickname, null);
    const good = fakeRunner({ Weibo: okResult({ state: 'ok', evidence: 'cfg', uidSeen: '2272770294', nickname: '自己' }) });
    await checkLogins(db, { platform: 'Weibo', runTask: good.runTask, notify: async () => true });
    assert.equal(getAccount(db, 'Weibo:2272770294').nickname, '自己');
    const ch = fakeRunner({ Channels: okResult({ state: 'ok', evidence: 'auth', uidSeen: 'sph_1', nickname: '视频号昵称' }) });
    await checkLogins(db, { platform: 'Channels', runTask: ch.runTask, notify: async () => true, finishTask: async () => ({ ok: true }) });
    assert.equal(getAccount(db, 'Channels:sph_1').nickname, '视频号昵称');
  });

  test('set-uid 带 @ 和空白会规范化，之后 check 不误报 UID 不符', async () => {
    const db = freshDb();
    assert.equal(setUid(db, 'X', ' @kinsolee79 '), 'X:kinsolee79');
    assert.equal(getAccount(db, 'X:kinsolee79').spaceName, 'kinso/X/kinsolee79');
    assert.equal(setUid(db, 'X', '@kinsolee79'), 'X:kinsolee79');
    const n = fakeNotify();
    const { runTask } = fakeRunner({ X: okResult({ state: 'ok', evidence: 'side', uidSeen: '@kinsolee79' }) });
    const r = await checkLogins(db, { platform: 'X', runTask, notify: n.notify });
    assert.equal(r.exitCode, 0);
    assert.equal(getAccount(db, 'X:kinsolee79').loginState, 'ok');
    assert.equal(n.sent.length, 0);
    assert.throws(() => setUid(db, 'YouTube', ' @ '), /uid/);
  });

  test('导入清单里带 @ 的 uid 也规范化', () => {
    const db = openOpsDb(path.join(tmp(), 'ops.db'));
    const f = path.join(tmp(), 'seed.json');
    fs.writeFileSync(f, JSON.stringify([{ platformCode: 'X', uid: '@kinsolee79' }]));
    importAccounts(db, f);
    assert.ok(getAccount(db, 'X:kinsolee79'));
    assert.equal(importAccounts(db, f).inserted, 0);
  });

  test('掉线→恢复→6 小时内再掉线被节流，之后一直 out，7 小时后的检测要发提醒', async () => {
    const db = freshDb();
    const T0 = Date.parse('2026-11-19T00:00:00Z');
    let t = T0;
    const n = fakeNotify();
    const seq = [];
    const { runTask } = fakeRunner({ Douyin: () => okResult(seq.shift()) });
    const run = async (state, at) => { t = at; seq.push({ state, evidence: state, uidSeen: state === 'ok' ? '106707338905' : null }); await checkLogins(db, { platform: 'Douyin', runTask, notify: n.notify, now: () => t }); };
    await run('out', T0);
    assert.equal(n.sent.length, 1);
    await run('ok', T0 + 10 * 60_000);
    await run('out', T0 + 20 * 60_000);
    assert.equal(n.sent.length, 1);
    await run('out', T0 + 7 * 3600_000);
    assert.equal(n.sent.length, 2);
  });

  test('提醒没真的发出去（notify 返回 false）不记节流时间，补好后马上能发', async () => {
    const db = freshDb();
    let t = Date.parse('2026-11-19T00:00:00Z');
    const { runTask } = fakeRunner({ Douyin: okResult({ state: 'out', evidence: 'status_code=8', uidSeen: null }) });
    let tried = 0;
    await checkLogins(db, { platform: 'Douyin', runTask, notify: async () => { tried++; return false; }, now: () => t });
    assert.equal(tried, 1);
    assert.equal(getAccount(db, 'Douyin:106707338905').alertSentAt, null);
    t += 60_000;
    const n = fakeNotify();
    await checkLogins(db, { platform: 'Douyin', runTask, notify: n.notify, now: () => t });
    assert.equal(n.sent.length, 1);
    assert.equal(getAccount(db, 'Douyin:106707338905').alertSentAt, new Date(t).toISOString());
  });
});

describe('扫码登录', () => {
  test('打开登录页并交给负责人，交还后自动 check（含 UID 核对）', async () => {
    const db = freshDb();
    const scripts = [];
    let delegated = 2;   // 交出去之后，前两次检测时还在负责人手里
    const runTask = async (opts) => {
      scripts.push(opts.params.mode);
      if (opts.params.mode === 'handoff') return okResult({ handedOff: true });
      if (delegated-- > 0) return { ok: false, reason: 'user-controlled', error: 'x' };
      return okResult({ state: 'ok', evidence: 'nav', uidSeen: '478358005' });
    };
    const r = await scanLogin(db, 'Bili', { runTask, notify: async () => {}, sleep: async () => {}, pollMs: 1, maxWaitMs: 1000 });
    assert.deepEqual(scripts, ['handoff', 'check', 'check', 'check']);
    assert.equal(r.exitCode, 0);
    assert.equal(getAccount(db, 'Bili:478358005').loginState, 'ok');
  });

  test('交还后 UID 不符：非零并提醒', async () => {
    const db = freshDb();
    const runTask = async (opts) => opts.params.mode === 'handoff' ? okResult({ handedOff: true }) : okResult({ state: 'ok', evidence: 'nav', uidSeen: '1' });
    const n = fakeNotify();
    const r = await scanLogin(db, 'Bili', { runTask, notify: n.notify, sleep: async () => {}, pollMs: 1, maxWaitMs: 1000 });
    assert.notEqual(r.exitCode, 0);
    assert.equal(n.sent.length, 1);
  });
});

describe('写入口令', () => {
  test('生成三个、权限 600、重复执行不覆盖、输出不含值', () => {
    const dir = tmp();
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(envPath, 'OTHER=1\n');
    const out1 = initTokens(envPath);
    const text = fs.readFileSync(envPath, 'utf8');
    const values = TOKEN_NAMES.map((k) => text.match(new RegExp(`^${k}=([0-9a-f]{64})$`, 'm'))?.[1]);
    assert.deepEqual(TOKEN_NAMES, ['MAITIAN_ENGAGE_TOKEN', 'MAITIAN_PUBLISH_TOKEN', 'MAITIAN_MANAGE_TOKEN']);
    for (const v of values) assert.ok(v, '每个口令都写进 .env');
    assert.equal(new Set(values).size, 3);
    assert.match(text, /^OTHER=1$/m);
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
    const out2 = initTokens(envPath);
    assert.equal(fs.readFileSync(envPath, 'utf8'), text);
    for (const v of values) { assert.ok(!out1.includes(v)); assert.ok(!out2.includes(v)); }
    assert.match(out1, /已生成/); assert.match(out2, /已存在/);
  });

  test('checkToken：对的放行，错的、缺的、未知 scope 一律拒绝', () => {
    const envPath = path.join(tmp(), '.env');
    initTokens(envPath);
    const v = fs.readFileSync(envPath, 'utf8').match(/^MAITIAN_PUBLISH_TOKEN=(\w+)$/m)[1];
    assert.equal(checkToken('publish', v, { envPath }), true);
    assert.equal(checkToken('publish', v.slice(0, -1) + (v.endsWith('0') ? '1' : '0'), { envPath }), false);
    assert.equal(checkToken('engage', v, { envPath }), false);
    assert.equal(checkToken('publish', '', { envPath }), false);
    assert.equal(checkToken('publish', undefined, { envPath }), false);
    assert.equal(checkToken('root', v, { envPath }), false);
    const empty = path.join(tmp(), '.env');
    assert.equal(checkToken('publish', v, { envPath: empty }), false);
    fs.writeFileSync(empty, 'MAITIAN_PUBLISH_TOKEN=\n');
    assert.equal(checkToken('publish', '', { envPath: empty }), false);
  });
});

describe('space 里的检测脚本（真 Ego Lite，只用 kinso/test/* 临时 space 和本地测试页）', async () => {
  const { EGO_SKIP, tempSpaceName, fixtureUrl } = await import('./helpers/ego.mjs');
  const { runEgoTask, finishSpace } = await import('../src/ego-runner/index.mjs');
  const { pathToFileURL } = await import('node:url');
  test('runner 能加载 space-check.mjs，打开 home 后返回状态和证据', { skip: EGO_SKIP ?? false, timeout: 120_000 }, async () => {
    const space = tempSpaceName('ops');
    try {
      const r = await runEgoTask({ space, timeoutMs: 90_000,
        params: { mode: 'check', platformCode: 'Zhishi', uid: 'pending', home: fixtureUrl('basic.html'), moduleUrl: pathToFileURL(path.resolve(import.meta.dirname, '../src/ops/space-check.mjs')).href },
        script: 'const { runInSpace } = await import(params.moduleUrl);\nreturn runInSpace(task, params);' });
      assert.equal(r.ok, true, `${r.reason} ${r.error} ${(r.stdout ?? '') + (r.stderr ?? '')}`.slice(0, 600));
      assert.equal(r.result.state, 'unknown');
      assert.match(r.result.evidence, /basic\.html/);
    } finally { await finishSpace(space); }
  });
});
