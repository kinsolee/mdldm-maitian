// KIN-327 评审第 1 轮阻断问题的回归测试（不需要 Ego Lite）：X-B1 profile 白名单、X-B2 损坏的锁文件、
// X-B3 finishSpace 不碰用户的 space 且拿 space 锁、X-B4 不再公开不拿锁的入口、X-B6 参数非法不忙等。
// X-B5（被信号打断不放锁）在 runner-lock.test.mjs 的 SIGTERM / SIGINT 那条。
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as runner from '../src/ego-runner/index.mjs';
import { runInSpace, finishSpace } from '../src/ego-runner/index.mjs';
import { acquireSpaceLock } from '../src/ego-runner/space-lock.mjs';
import { createForegroundLock } from '../src/ego-runner/foreground.mjs';
import { opsPaths } from '../src/ego-runner/paths.mjs';
import { openSpace } from '../src/ego-runner/space.mjs';
import { closeTestSpace } from './helpers/ego.mjs';

const FAKE_DIR = fileURLToPath(new URL('./fixtures/fake-ego/', import.meta.url));
const FAKE_BIN = join(FAKE_DIR, 'ego-browser');
const CLI = fileURLToPath(new URL('../src/ego-runner/cli.mjs', import.meta.url));
const SPACE = 'kinso/test/review';
const NOWHERE = '/nonexistent/ego-browser';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 最多等 ms，过了还没结束就判为卡死（忙等、死循环）
const within = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw new Error(`${ms}ms 内没有返回（卡死）`); })]);

let opsDir, logFile;
const calls = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const useSpaces = (spaces) => { process.env.FAKE_EGO_SPACES = JSON.stringify(spaces); };
const lockFile = () => opsPaths(SPACE, opsDir).spaceLock;
const writeLock = (text, ageMs = 0) => {
  mkdirSync(dirname(lockFile()), { recursive: true });
  writeFileSync(lockFile(), text);
  if (ageMs) { const t = new Date(Date.now() - ageMs); utimesSync(lockFile(), t, t); }
};
const cli = (args, input = 'return 1') => new Promise((resolve) => {
  const c = spawn(process.execPath, [CLI, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PATH: `${FAKE_DIR}:${process.env.PATH}`, MAITIAN_OPS_DIR: opsDir } });
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.on('close', (code) => resolve({ code, json: JSON.parse(out.trim().split('\n').at(-1)) }));
  c.stdin.end(input);
});

beforeEach(() => {
  opsDir = mkdtempSync(join(tmpdir(), 'maitian-ops-'));
  logFile = join(opsDir, 'fake-ego-log.jsonl');
  process.env.FAKE_EGO_LOG = logFile;
  delete process.env.FAKE_EGO_PROFILES;
  useSpaces([{ id: 9, name: SPACE, profileId: 'Profile 5', ownership: 'agent' }]);
});

describe('X-B1 只用 Profile 5（白名单）', () => {
  for (const profileId of ['Profile 1', 'Profile 7', 'Default', '', 'Profile 6']) {
    test(`runInSpace / finishSpace 拒绝 ${JSON.stringify(profileId)}：profile-rejected、退出码 3，不起子进程`, async () => {
      const r = await runInSpace({ space: SPACE, profileId, script: 'return 1', egoBin: NOWHERE, opsDir });
      assert.equal(r.reason, 'profile-rejected'); assert.equal(r.exitCode, 3);
      const f = await finishSpace(SPACE, { profileId, egoBin: NOWHERE, opsDir });
      assert.equal(f.reason, 'profile-rejected'); assert.equal(f.exitCode, 3);
      assert.equal(existsSync(opsPaths(null, opsDir).lockDir), false, '不该拿锁');
    });
  }
  test('cli --profile "Profile 7"：退出码 3', async () => {
    const r = await cli(['--space', SPACE, '--profile', 'Profile 7']);
    assert.equal(r.code, 3); assert.equal(r.json.reason, 'profile-rejected');
    assert.deepEqual(calls(), []);
  });
  test('openSpace 拒绝 Profile 1，不调任何接口', async () => {
    const ego = { listTaskSpaces: async () => { throw new Error('不该调'); }, taskSpace: async () => { throw new Error('不该调'); } };
    await assert.rejects(openSpace(ego, { name: SPACE, profileId: 'Profile 1' }), /只用 Profile 5/);
  });
});

describe('X-B2 合法 JSON 但字段不全的锁文件按损坏处理', () => {
  test('新写的 {}：skip 马上返回 locked，错误信息不抛 Invalid time value', async () => {
    writeLock('{}');
    const r = await within(runInSpace({ space: SPACE, script: 'return 1', lock: 'skip', egoBin: NOWHERE, opsDir }), 2000);
    assert.equal(r.reason, 'locked'); assert.equal(r.exitCode, 5);
    assert.match(r.error, /损坏/);
  });
  test('新写的 {}：wait 带 lockTimeoutMs 到点返回 locked，不卡死', async () => {
    writeLock('{}');
    const r = await within(runInSpace({ space: SPACE, script: 'return 1', lockTimeoutMs: 300, egoBin: NOWHERE, opsDir }), 3000);
    assert.equal(r.reason, 'locked');
  });
  test('放了很久的 {}：回收后能跑', async () => {
    writeLock('{}', 10_000);
    const r = await within(runInSpace({ space: SPACE, script: 'return 3', lock: 'skip', egoBin: FAKE_BIN, opsDir }), 5000);
    assert.equal(r.ok, true, r.error); assert.equal(r.result, 3);
  });
  for (const [what, content] of [
    ['缺 host', { token: 'x', pid: process.pid, startedAt: Date.now() }],
    ['缺 token', { pid: process.pid, host: 'h', startedAt: Date.now() }],
    ['startedAt 不是数字', { token: 'x', pid: process.pid, host: 'h', startedAt: 'bad' }],
    ['pid 不是整数', { token: 'x', pid: 'abc', host: 'h', startedAt: Date.now() }],
  ]) {
    test(`${what}：新写的当被占（不当永久 active），放久了回收`, async () => {
      writeLock(JSON.stringify(content));
      const busy = await within(runInSpace({ space: SPACE, script: 'return 1', lock: 'skip', egoBin: NOWHERE, opsDir }), 2000);
      assert.equal(busy.reason, 'locked');
      writeLock(JSON.stringify(content), 10_000);
      const r = await within(runInSpace({ space: SPACE, script: 'return 1', lock: 'skip', egoBin: FAKE_BIN, opsDir }), 5000);
      assert.equal(r.ok, true, r.error);
    });
  }
  test('回收失败（别人正在回收）：skip 返回 locked、wait 到点返回，不死循环', async () => {
    writeLock('{}', 10_000);
    writeFileSync(`${lockFile()}.reclaim`, JSON.stringify({ at: Date.now() }));   // 新鲜的回收守卫：回收必失败
    const s = await within(runInSpace({ space: SPACE, script: 'return 1', lock: 'skip', egoBin: NOWHERE, opsDir }), 2000);
    assert.equal(s.reason, 'locked');
    const w = await within(runInSpace({ space: SPACE, script: 'return 1', lockTimeoutMs: 300, egoBin: NOWHERE, opsDir }), 3000);
    assert.equal(w.reason, 'locked');
  });
  test('前台锁：放了很久的 {} 也能回收', async () => {
    const file = join(opsDir, 'locks', '_foreground.lock');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{}');
    const old = new Date(Date.now() - 60_000); utimesSync(file, old, old);
    const lock = createForegroundLock(file, { staleMs: 300 });
    assert.equal(await within(lock(async () => 'got'), 3000), 'got');
  });
});

describe('X-B3 finishSpace 不碰用户的 space，且拿 space 锁', () => {
  for (const ownership of ['user', 'agentDelegatedToUser']) {
    test(`ownership=${ownership}：user-owned、退出码 4，不调 claim/takeOver/finish`, async () => {
      useSpaces([{ id: 9, name: SPACE, profileId: 'Profile 5', ownership }]);
      const r = await finishSpace(SPACE, { egoBin: FAKE_BIN, opsDir });
      assert.equal(r.ok, false); assert.equal(r.reason, 'user-owned'); assert.equal(r.exitCode, 4);
      assert.equal(r.ownership, ownership);
      assert.deepEqual(calls(), []);
      assert.equal(existsSync(lockFile()), false, '用完放锁');
    });
  }
  test('space 锁被占：skip 返回 locked、退出码 5，不起子进程', async () => {
    const holder = await acquireSpaceLock(SPACE, { opsDir });
    try {
      const r = await within(finishSpace(SPACE, { egoBin: NOWHERE, opsDir, lock: 'skip' }), 2000);
      assert.equal(r.reason, 'locked'); assert.equal(r.exitCode, 5);
      const w = await within(finishSpace(SPACE, { egoBin: NOWHERE, opsDir, lockTimeoutMs: 300 }), 3000);
      assert.equal(w.reason, 'locked');
    } finally { holder.lock.release(); }
  });
  test('agent 的 space：拿锁、finish、放锁，exitCode 0', async () => {
    const r = await finishSpace(SPACE, { egoBin: FAKE_BIN, opsDir });
    assert.equal(r.ok, true, r.error); assert.equal(r.exitCode, 0);
    assert.deepEqual(calls(), [{ fn: 'taskSpace', arg: 9 }, { fn: 'finish', id: 9, keep: [] }]);
    assert.equal(existsSync(lockFile()), false);
  });
  test('runInSpace finish=true 在自己持锁时关 space，不自己等自己', async () => {
    const r = await within(runInSpace({ space: SPACE, script: 'return 1', egoBin: FAKE_BIN, opsDir, finish: true }), 5000);
    assert.equal(r.ok, true, r.error); assert.equal(r.finish.ok, true, r.finish.error);
  });
});

describe('X-B4 不拿锁的入口不公开', () => {
  test('index.mjs 的导出是白名单：原来那个不拿锁的公开入口、runUnlocked 都不在里面（G2-B3）', () => {
    assert.deepEqual(Object.keys(runner).sort(), [
      'DEFAULT_PLUGIN_DIR', 'DEFAULT_PROFILE', 'DEFAULT_TIMEOUT_MS', 'EXIT_CODES', 'OPS_PREFIX', 'RESULT_PREFIX',
      'buildTaskSource', 'exitCodeOf', 'finishSpace', 'parseOps', 'parseResult', 'runEgoScript', 'runInSpace',
    ]);
    assert.equal('runUnlocked' in runner, false);
  });
});

describe('X-B6 参数非法：返回参数错误，不忙等', () => {
  for (const args of [['--lock-timeout-ms', 'abc'], ['--lock-timeout-ms', '-1'], ['--timeout-ms', 'abc'], ['--timeout-ms', '0'], ['--params', '{bad'], ['--params', '[1]'], ['--no-such-flag']]) {
    test(`cli ${args.join(' ')}：bad-args、退出码 2`, async () => {
      const r = await within(cli(['--space', SPACE, ...args]), 5000);
      assert.equal(r.code, 2, JSON.stringify(r.json)); assert.equal(r.json.reason, 'bad-args');
      assert.deepEqual(calls(), []);
    });
  }
  for (const o of [{ lockTimeoutMs: NaN }, { lockTimeoutMs: -5 }, { lockTimeoutMs: '300' }, { timeoutMs: NaN }, { timeoutMs: 0 }, { lock: 'maybe' }]) {
    test(`runInSpace ${JSON.stringify(o, (k, v) => (Number.isNaN(v) ? 'NaN' : v))}：bad-args、退出码 2，不拿锁`, async () => {
      const r = await runInSpace({ space: SPACE, script: 'return 1', egoBin: NOWHERE, opsDir, ...o });
      assert.equal(r.reason, 'bad-args'); assert.equal(r.exitCode, 2);
      assert.equal(existsSync(opsPaths(null, opsDir).lockDir), false);
    });
  }
  test('acquireSpaceLock 的 timeoutMs 不是有限非负数：抛 TypeError', async () => {
    for (const timeoutMs of [NaN, Infinity, -1, '5']) await assert.rejects(acquireSpaceLock(SPACE, { timeoutMs, opsDir }), TypeError);
  });
});

describe('G-B9 前台锁的生命周期', () => {
  const fgFile = () => join(opsDir, 'locks', '_foreground.lock');
  test('dispose() 移除 exit 监听器、幂等；建多个再各自 dispose，监听器数回到原样', () => {
    const base = process.listenerCount('exit');
    const locks = [1, 2, 3].map(() => createForegroundLock(fgFile()));
    assert.equal(process.listenerCount('exit'), base + 3);
    for (const l of locks) { l.dispose(); l.dispose(); }
    assert.equal(process.listenerCount('exit'), base);
  });
  test('持锁中 dispose()：放掉自己的 token、停掉摸锁定时器', async () => {
    const lock = createForegroundLock(fgFile(), { refreshMs: 30 });
    let release;
    const held = lock(() => new Promise((r) => { release = r; }));
    await sleep(50);
    assert.ok(existsSync(fgFile()));
    lock.dispose();
    assert.equal(existsSync(fgFile()), false, 'dispose 后锁文件应已删');
    await sleep(100);
    assert.equal(existsSync(fgFile()), false, '定时器不该再把锁文件摸出来');
    release(); await held;
  });
  test('摸锁前核对 token：锁文件已换成别人的，不替别人续期', async () => {
    const lock = createForegroundLock(fgFile(), { refreshMs: 30 });
    let release;
    const held = lock(() => new Promise((r) => { release = r; }));
    await sleep(50);
    writeFileSync(fgFile(), JSON.stringify({ token: 'someone-else', pid: 1, at: 0 }));
    const old = new Date(Date.now() - 60_000); utimesSync(fgFile(), old, old);
    await sleep(150);
    const { mtimeMs } = (await import('node:fs')).statSync(fgFile());
    assert.ok(Date.now() - mtimeMs > 50_000, '别人的锁文件 mtime 不该被刷新');
    release(); await held;
    assert.equal(JSON.parse(readFileSync(fgFile(), 'utf8')).token, 'someone-else', '也不删别人的锁');
    lock.dispose();
  });
  test('到截止时间时脚本正持着前台锁：前言退出前放掉前台锁', async () => {
    const r = await runInSpace({ space: SPACE, egoBin: FAKE_BIN, opsDir, timeoutMs: 3000, script: 'await withForegroundLock(() => new Promise(() => {})); return 1;' });
    assert.equal(r.reason, 'deadline', r.error);
    assert.equal(existsSync(fgFile()), false);
  });
});

describe('G2-B2 runInSpace finish=true：finish 那步超时也不放锁', () => {
  test('任务成功、finish 挂住超时：锁标 abandoned 不删，心跳过期前新任务 previous-still-running', async () => {
    const STALE = 1000;
    process.env.FAKE_EGO_FINISH_HANG = '1';
    try {
      const r = await within(runInSpace({ space: SPACE, script: 'return 1', egoBin: FAKE_BIN, opsDir, finish: true, timeoutMs: 1500, heartbeatStaleMs: STALE }), 8000);
      assert.equal(r.ok, true, r.error); assert.equal(r.finish.reason, 'timeout');
      assert.ok(existsSync(lockFile()), 'finish 超时后锁不该释放（Ego 里的 finish 脚本可能还在跑）');
      assert.ok(JSON.parse(readFileSync(lockFile(), 'utf8')).abandonedAt > 0, '锁里应记下放弃时刻');
      const busy = await runInSpace({ space: SPACE, script: 'return 1', egoBin: NOWHERE, opsDir, heartbeatStaleMs: STALE });
      assert.equal(busy.reason, 'previous-still-running'); assert.equal(busy.exitCode, 5);
    } finally { delete process.env.FAKE_EGO_FINISH_HANG; }
    await sleep(1100);
    const ok = await runInSpace({ space: SPACE, script: 'return 1', egoBin: FAKE_BIN, opsDir, heartbeatStaleMs: 1000 });
    assert.equal(ok.ok, true, ok.error);
  });
});

describe('G2-B4 测试收尾 closeTestSpace 关不掉就抛错', () => {
  test('ego-browser 起不来：抛错', async () => {
    await assert.rejects(closeTestSpace(SPACE, { egoBin: NOWHERE }), /没关掉临时 space/);
  });
  test('finish 后 space 没关上（closedSpace 不是 true）：抛错', async () => {
    await assert.rejects(closeTestSpace(SPACE, { egoBin: FAKE_BIN }), /没关掉临时 space/);
  });
  test('space 不存在：不抛', async () => {
    useSpaces([]);
    const r = await closeTestSpace(SPACE, { egoBin: FAKE_BIN });
    assert.deepEqual(r.result, { existed: false });
  });
});
