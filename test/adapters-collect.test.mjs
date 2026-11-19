// collect 对 runner 各种结果的处理（注入假 runner，不起 Ego）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { collect } from '../src/ops/engage/adapters/index.mjs';
import { shapeErrors } from '../src/ops/engage/adapters/shape.mjs';

const account = { platformCode: 'Bili', uid: '478358005', spaceName: 'kinso/Bili/478358005', profileId: 'Profile 5', nickname: null };
const fakeRunner = (r, seen = []) => async (opts) => { seen.push(opts); return r; };

for (const reason of ['busy', 'user-controlled', 'profile-needed']) {
  test(`runner 返回 ${reason}：原样跳过`, async () => {
    const r = await collect({ account, kind: 'comments', runner: fakeRunner({ ok: false, reason, error: `正被进程 1 占用` }) });
    assert.equal(r.ok, false);
    assert.equal(r.skipped, reason);
    assert.deepEqual(shapeErrors(r), []);
  });
}

test('runner 返回 profile-rejected：按失败返回，不算跳过', async () => {
  const r = await collect({ account, kind: 'dms', runner: fakeRunner({ ok: false, reason: 'profile-rejected', error: '不允许使用 Profile 6' }) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'profile-rejected');
  assert.equal(r.skipped, undefined);
});

test('页面落到登录页：reason=login-lost', async () => {
  const r = await collect({ account, kind: 'comments', runner: fakeRunner({ ok: true, result: { loginLost: true, evidence: 'nav isLogin=false' } }) });
  assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: 'login-lost' });
});

test('其余异常：reason + error，error 里不带 cookie/token', async () => {
  const r = await collect({ account, kind: 'comments', runner: fakeRunner({ ok: false, reason: 'exit-code', error: 'GET https://x.com/a?msToken=abc&a_bogus=def failed; cookie: SESSDATA=zzz; xsec_token=qq' }) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'exit-code');
  assert.doesNotMatch(r.error, /abc|def|zzz|qq/);
});

test('页面脚本抛错的结果结构不对：reason=parse', async () => {
  const r = await collect({ account, kind: 'comments', runner: fakeRunner({ ok: true, result: { nothing: true } }) });
  assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: 'parse' });
});

test('按账号的 space 和 Profile 跑，Instagram 不跑', async () => {
  const seen = [];
  await collect({ account, kind: 'dms', runner: fakeRunner({ ok: false, reason: 'busy' }, seen) });
  assert.equal(seen[0].space, 'kinso/Bili/478358005');
  assert.equal(seen[0].profileId, 'Profile 5');
  assert.equal(seen[0].params.kind, 'dms');
  const ig = [];
  const r = await collect({ account: { ...account, platformCode: 'Instagram', uid: 'x', spaceName: 'kinso/Instagram/x' }, kind: 'comments', runner: fakeRunner({ ok: true, result: {} }, ig) });
  assert.equal(r.ok, false);
  assert.equal(ig.length, 0);
});

test('kind 不对直接报错，不起 runner', async () => {
  const seen = [];
  const r = await collect({ account, kind: 'likes', runner: fakeRunner({ ok: true }, seen) });
  assert.equal(r.ok, false);
  assert.equal(seen.length, 0);
});
