// KIN-329：Profile 白名单、finishSpace 不接管负责人的 space、锁文件字段缺失（不需要 Ego Lite）。
import { LOCKS_DIR } from './helpers/ops-dir.mjs';
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEgoTask, finishSpace } from '../src/ego-runner/index.mjs';
import { openSpace, ALLOWED_PROFILES, FORBIDDEN_PROFILE } from '../src/ego-runner/space.mjs';
import { tryLock, waitLock, spaceLockPath, foregroundLockPath } from '../src/ego-runner/locks.mjs';

const FAKE_DIR = fileURLToPath(new URL('./fixtures/fake-ego/', import.meta.url));
const FAKE_BIN = join(FAKE_DIR, 'ego-browser');
const CLI = fileURLToPath(new URL('../src/ego-runner/cli.mjs', import.meta.url));
const NO_BIN = '/nonexistent/ego-browser';   // 起子进程就会 spawn-failed，用来证明没起
const dir = mkdtempSync(join(tmpdir(), 'kin329-'));
let n = 0;
const uniqueSpace = (tag) => `kinso/test/${tag}-${process.pid}-${n++}`;
let logFile;
const calls = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

beforeEach(() => {
  delete process.env.FAKE_EGO_SPACES; delete process.env.FAKE_EGO_PROFILES;
  logFile = join(dir, `log-${n++}.jsonl`); process.env.FAKE_EGO_LOG = logFile;
});

describe('条目 1：Profile 只认白名单', () => {
  test('白名单只有 Profile 5，Profile 6 仍导出为禁用', () => {
    assert.deepEqual(ALLOWED_PROFILES, ['Profile 5']);
    assert.equal(FORBIDDEN_PROFILE, 'Profile 6');
  });
  for (const profileId of ['Profile 4', 'Profile 7', '', 'Profile 6']) {
    test(`runEgoTask 拒绝 ${JSON.stringify(profileId)}，不起子进程`, async () => {
      const r = await runEgoTask({ space: uniqueSpace('p'), profileId, script: 'return 1', egoBin: NO_BIN });
      assert.equal(r.ok, false); assert.equal(r.reason, 'profile-rejected', r.error);
    });
    test(`finishSpace 拒绝 ${JSON.stringify(profileId)}，不起子进程`, async () => {
      const r = await finishSpace(uniqueSpace('p'), { profileId, egoBin: NO_BIN });
      assert.equal(r.ok, false); assert.equal(r.reason, 'profile-rejected', r.error);
    });
    test(`openSpace 拒绝 ${JSON.stringify(profileId)}，不调任何 Ego 接口`, async () => {
      const called = [];
      const spy = (fn) => async (...a) => { called.push(fn); return fn === 'profiles' ? [{ id: profileId }] : []; };
      const ego = { profiles: spy('profiles'), listTaskSpaces: spy('listTaskSpaces'), taskSpace: spy('taskSpace'), claimTaskSpace: spy('claimTaskSpace') };
      await assert.rejects(openSpace(ego, { name: 'kinso/test/demo', profileId }), /不允许使用/);
      assert.deepEqual(called, []);
    });
  }
  test('cli --profile "Profile 7"：profile-rejected，退出码 1，不碰 Ego', () => {
    const p = spawnSync(process.execPath, [CLI, '--space', uniqueSpace('cli'), '--profile', 'Profile 7', '--finish'], {
      input: 'return 1', encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, PATH: `${FAKE_DIR}:${process.env.PATH}` },
    });
    assert.equal(p.status, 1, p.stdout + p.stderr);
    assert.equal(JSON.parse(p.stdout.trim().split('\n').at(-1)).reason, 'profile-rejected');
    assert.deepEqual(calls(), []);
  });
  test('Ego 里没有 Profile 5 仍是 profile-needed', async () => {
    process.env.FAKE_EGO_PROFILES = JSON.stringify([{ id: 'Profile 4' }]);
    const r = await runEgoTask({ space: uniqueSpace('need'), script: 'return 1', egoBin: FAKE_BIN, timeoutMs: 20_000 });
    assert.equal(r.reason, 'profile-needed', r.error);
  });
});

describe('条目 2：finishSpace 不接管负责人手里的 space', () => {
  for (const ownership of ['user', 'agentDelegatedToUser', 'somethingElse']) {
    test(`ownership=${ownership}：不 claim、不 take over、不 finish，返回 user-controlled`, async () => {
      const space = uniqueSpace('own');
      process.env.FAKE_EGO_SPACES = JSON.stringify([{ id: 9, name: space, profileId: 'Profile 5', ownership }]);
      const r = await finishSpace(space, { egoBin: FAKE_BIN });
      assert.equal(r.ok, false); assert.equal(r.reason, 'user-controlled');
      assert.match(r.error, new RegExp(`ownership=${ownership}`));
      assert.match(r.error, /没有关/);
      assert.deepEqual(calls(), []);
    });
  }
  test('cli --finish：任务成功但 space 在负责人手里 → 没关，finish.reason=user-controlled，退出码 1', () => {
    const space = uniqueSpace('cli');
    process.env.FAKE_EGO_SPACES = JSON.stringify([{ id: 9, name: space, profileId: 'Profile 5', ownership: 'agentDelegatedToUser' }]);
    const p = spawnSync(process.execPath, [CLI, '--space', space, '--finish'], {
      input: 'return 1', encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, PATH: `${FAKE_DIR}:${process.env.PATH}` },
    });
    const out = JSON.parse(p.stdout.trim().split('\n').at(-1));
    // 任务本身在 openSpace 就因 agentDelegatedToUser 失败（user-controlled，退出码 4），不会再去关
    assert.equal(out.reason, 'user-controlled'); assert.equal(p.status, 4);
    assert.equal(out.finish, undefined);
    assert.deepEqual(calls().filter((c) => c.fn === 'finish' || c.fn === 'claimTaskSpace'), []);
  });
  test('cli --finish：任务成功、收尾时 space 是 user 持有 → 不关，退出码 1', () => {
    const space = uniqueSpace('cli');
    process.env.FAKE_EGO_SPACES = JSON.stringify([{ id: 9, name: space, profileId: 'Profile 5', ownership: 'user' }]);
    const p = spawnSync(process.execPath, [CLI, '--space', space, '--finish'], {
      input: 'return 1', encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, PATH: `${FAKE_DIR}:${process.env.PATH}` },
    });
    const out = JSON.parse(p.stdout.trim().split('\n').at(-1));
    assert.equal(out.ok, true, p.stdout + p.stderr);
    assert.equal(out.finish.reason, 'user-controlled');
    assert.equal(p.status, 1);
    assert.deepEqual(calls().filter((c) => c.fn === 'finish'), []);
  });
  test('ownership=agent：照旧 taskSpace 后 finish', async () => {
    const space = uniqueSpace('own');
    process.env.FAKE_EGO_SPACES = JSON.stringify([{ id: 9, name: space, profileId: 'Profile 5', ownership: 'agent' }]);
    const r = await finishSpace(space, { egoBin: FAKE_BIN });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(calls(), [{ fn: 'taskSpace', arg: 9 }, { fn: 'finish', id: 9, keep: [] }]);
  });
});

describe('条目 4：锁文件字段缺失或类型不对按损坏处理', () => {
  test('损坏的 foreground.lock：waitLock 报 lock-timeout，信息写明损坏和路径、要手动删，不含 1970', async () => {
    const fdir = join(dir, `fg-${n++}`); mkdirSync(fdir, { recursive: true });
    const path = foregroundLockPath(fdir);
    writeFileSync(path, '{"token":"x","pid":');
    await assert.rejects(waitLock(path, { timeoutMs: 100, staleMs: 10 }), (e) => {
      assert.equal(e.code, 'lock-timeout');
      assert.ok(e.message.includes(path)); assert.match(e.message, /损坏/); assert.match(e.message, /手动删/);
      assert.doesNotMatch(e.message, /1970/);
      return true;
    });
  });
  const bad = {
    '空对象': {},
    '缺 heartbeatAt': { token: 'x', pid: null, startedAt: Date.now() },
    '缺 startedAt': { token: 'x', pid: null, heartbeatAt: Date.now() },
    'heartbeatAt 是字符串': { token: 'x', pid: null, startedAt: Date.now(), heartbeatAt: 'now' },
    'token 为空': { token: '', pid: null, startedAt: Date.now(), heartbeatAt: Date.now() },
    'null': null,
    '数字': 42,
    '字符串': 'lock',
    // 下面几种心跳已过期、pid 已死（或无法判断），不当损坏的话会被接管：rmSync(undefined) / pidAlive 抛错
    '缺 heartbeatFile（过期）': { token: 'x', pid: null, startedAt: 1, heartbeatAt: 1 },
    'heartbeatFile 为数字（过期）': { token: 'x', pid: null, startedAt: 1, heartbeatAt: 1, heartbeatFile: 42 },
    'heartbeatFile 为空串（过期）': { token: 'x', pid: null, startedAt: 1, heartbeatAt: 1, heartbeatFile: '' },
    'pid 为字符串（过期）': { token: 'x', pid: 'abc', startedAt: 1, heartbeatAt: 1, heartbeatFile: '/nonexistent/x.hb' },
    'pid 为负数（过期）': { token: 'x', pid: -1, startedAt: 1, heartbeatAt: 1, heartbeatFile: '/nonexistent/x.hb' },
    // 有限但超出 Date 范围：toISOString 会抛 RangeError
    'startedAt 超出 Date 范围': { token: 'x', pid: null, startedAt: 1e300, heartbeatAt: Date.now(), heartbeatFile: '/nonexistent/x.hb' },
    'heartbeatAt 超出 Date 范围': { token: 'x', pid: null, startedAt: Date.now(), heartbeatAt: 1e300, heartbeatFile: '/nonexistent/x.hb' },
  };
  const plant = (space, content) => {
    const path = spaceLockPath(LOCKS_DIR, space);
    mkdirSync(LOCKS_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify(content));
    return path;
  };
  for (const [label, content] of Object.entries(bad)) {
    test(`${label}：tryLock 返回 corrupt，runEgoTask 返回 busy（含「损坏」）、不起子进程`, async () => {
      const space = uniqueSpace('bad');
      const path = plant(space, content);
      const t = tryLock(path, { staleMs: 10 });
      assert.equal(t.ok, false); assert.equal(t.holder?.corrupt, true);
      const r = await runEgoTask({ space, script: 'return 1', egoBin: NO_BIN, staleMs: 10 });
      assert.equal(r.ok, false); assert.equal(r.reason, 'busy'); assert.match(r.error, /损坏/);
      assert.equal(readFileSync(path, 'utf8'), JSON.stringify(content), '损坏的锁文件不应被删掉或覆盖');
    });
    test(`${label}：waitLock 在 timeoutMs 内以 lock-timeout 抛出`, async () => {
      const path = plant(uniqueSpace('badw'), content);
      const t0 = Date.now();
      await assert.rejects(waitLock(path, { timeoutMs: 100, staleMs: 10 }), (e) => {
        assert.equal(e.code, 'lock-timeout'); assert.match(e.message, /损坏/); assert.doesNotMatch(e.message, /1970/);
        return true;
      });
      assert.ok(Date.now() - t0 < 2000);
    });
  }
});
