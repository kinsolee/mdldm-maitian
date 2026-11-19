// runInSpace 的 space 锁、心跳、截止时间、退出码（不需要 Ego Lite）：用 test/fixtures/fake-ego/ego-browser 代替真 CLI，
// 它真的执行前言（写心跳、取 space、截止时间），只是 Ego 的全局函数是假的。每个测试一个临时 OPS_DIR。
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInSpace } from '../src/ego-runner/index.mjs';
import { opsPaths } from '../src/ego-runner/paths.mjs';

const FAKE_DIR = fileURLToPath(new URL('./fixtures/fake-ego/', import.meta.url));
const FAKE_BIN = join(FAKE_DIR, 'ego-browser');
const HANG_BIN = fileURLToPath(new URL('./fixtures/hang-ego-browser.mjs', import.meta.url));
const CLI = fileURLToPath(new URL('../src/ego-runner/cli.mjs', import.meta.url));
const INDEX_URL = new URL('../src/ego-runner/index.mjs', import.meta.url).href;
const SPACE = 'kinso/test/lock';
const NOWHERE = '/nonexistent/ego-browser';   // 拿不到锁时不该起子进程：真起了就会是 spawn-failed

let opsDir, logFile;
const calls = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const useSpaces = (spaces) => { process.env.FAKE_EGO_SPACES = JSON.stringify(spaces); };
const run = (o) => runInSpace({ space: SPACE, egoBin: FAKE_BIN, opsDir, ...o });
const sleepScript = (ms) => `const t0 = Date.now(); await new Promise((r) => setTimeout(r, ${ms})); return { t0, t1: Date.now() };`;
const lockFile = (space = SPACE) => opsPaths(space, opsDir).spaceLock;
const beatFile = (space = SPACE) => opsPaths(space, opsDir).heartbeat;
const writeBeat = (at, space = SPACE) => { mkdirSync(dirname(beatFile(space)), { recursive: true }); writeFileSync(beatFile(space), JSON.stringify({ space, at })); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 10_000) {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('等不到条件成立'); await sleep(20); }
}
// 在另一个 node 进程里跑 runInSpace（用来测进程被杀、被 SIGTERM）
function runnerProcess(opts) {
  const src = `const { runInSpace } = await import(${JSON.stringify(INDEX_URL)});
const r = await runInSpace(${JSON.stringify({ space: SPACE, opsDir, ...opts })});
console.log(JSON.stringify(r));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, out })));
  return { child, exited };
}

describe('runInSpace space 锁（不需要 Ego Lite）', () => {
  beforeEach(() => {
    opsDir = mkdtempSync(join(tmpdir(), 'maitian-ops-'));
    logFile = join(opsDir, 'fake-ego-log.jsonl');
    process.env.FAKE_EGO_LOG = logFile;
    delete process.env.FAKE_EGO_PROFILES;
    useSpaces([{ id: 9, name: SPACE, profileId: 'Profile 5', ownership: 'agent' }, { id: 10, name: 'kinso/test/lock2', profileId: 'Profile 5', ownership: 'agent' }]);
  });

  test('wait：同一 space 的两个任务排队，时间不重叠；跑完锁文件删掉', async () => {
    const [a, b] = await Promise.all([run({ script: sleepScript(600) }), run({ script: sleepScript(600) })]);
    assert.equal(a.ok && b.ok, true, `${a.error} ${b.error}`);
    assert.equal(a.exitCode, 0);
    const [first, second] = [a.result, b.result].sort((x, y) => x.t0 - y.t0);
    assert.ok(second.t0 >= first.t1, `第二个任务 ${second.t0} 应在第一个结束 ${first.t1} 之后开始`);
    assert.equal(existsSync(lockFile()), false);
  });

  test('skip：space 被占时马上返回 locked、退出码 5，不起子进程', async () => {
    const first = run({ script: sleepScript(1500) });
    await waitFor(() => existsSync(lockFile()));
    const t0 = Date.now();
    const r = await run({ script: 'return 1', lock: 'skip', egoBin: NOWHERE });
    assert.ok(Date.now() - t0 < 1000, 'skip 应立即返回');
    assert.equal(r.ok, false); assert.equal(r.reason, 'locked'); assert.equal(r.exitCode, 5);
    assert.match(r.error, /正被别的任务占用.*pid \d+/);
    assert.equal((await first).ok, true);
  });

  test('wait 带 lockTimeoutMs：等不到返回 locked，不起子进程', async () => {
    const first = run({ script: sleepScript(2000) });
    await waitFor(() => existsSync(lockFile()));
    const t0 = Date.now();
    const r = await run({ script: 'return 1', lockTimeoutMs: 500, egoBin: NOWHERE });
    assert.ok(Date.now() - t0 >= 450, '应等到超时');
    assert.equal(r.reason, 'locked'); assert.equal(r.exitCode, 5);
    await first;
  });

  test('不同 space 能同时跑', async () => {
    const [a, b] = await Promise.all([run({ script: sleepScript(800) }), run({ space: 'kinso/test/lock2', script: sleepScript(800) })]);
    assert.equal(a.ok && b.ok, true, `${a.error} ${b.error}`);
    assert.ok(a.result.t0 < b.result.t1 && b.result.t0 < a.result.t1, '两个任务时间应重叠');
  });

  test('超时：不放锁；放弃后心跳新鲜时新任务 previous-still-running，心跳过期后放行', async () => {
    const STALE = 1000;
    const r = await run({ script: 'return 1', egoBin: HANG_BIN, timeoutMs: 1500, heartbeatStaleMs: STALE });
    assert.equal(r.reason, 'timeout'); assert.equal(r.exitCode, 1);
    const held = JSON.parse(readFileSync(lockFile(), 'utf8'));
    assert.equal(held.pid, process.pid); assert.ok(held.abandonedAt > 0, '锁里应记下放弃时刻');
    // 模拟 CLI 被杀后脚本还在 Ego 里跑：心跳一直在更新
    writeBeat(Date.now());
    const busy = await run({ script: 'return 1', egoBin: NOWHERE, heartbeatStaleMs: STALE });
    assert.equal(busy.reason, 'previous-still-running'); assert.equal(busy.exitCode, 5);
    assert.ok(existsSync(lockFile()), '心跳新鲜时不回收锁');
    // wait 模式也不排队等它
    const t0 = Date.now();
    const busyWait = await run({ script: 'return 1', egoBin: NOWHERE, lock: 'wait', heartbeatStaleMs: STALE });
    assert.equal(busyWait.reason, 'previous-still-running'); assert.ok(Date.now() - t0 < 500);
    // 脚本停了：心跳不再更新，过期后放行
    writeBeat(Date.now() - 5 * STALE);
    await sleep(STALE + 100);
    const ok = await run({ script: 'return 7', heartbeatStaleMs: STALE });
    assert.equal(ok.ok, true, ok.error); assert.equal(ok.result, 7);
    assert.equal(existsSync(lockFile()), false);
  });

  test('超时后没有心跳文件：从放弃时刻起算，过期前也不放行', async () => {
    const STALE = 1000;
    await run({ script: 'return 1', egoBin: HANG_BIN, timeoutMs: 1500, heartbeatStaleMs: STALE });
    const busy = await run({ script: 'return 1', egoBin: NOWHERE, heartbeatStaleMs: STALE });
    assert.equal(busy.reason, 'previous-still-running');
    await sleep(STALE + 100);
    const ok = await run({ script: 'return 1', heartbeatStaleMs: STALE });
    assert.equal(ok.ok, true, ok.error);
  });

  test('持锁进程被 kill -9：锁留下，进程已死且没有心跳时回收', async () => {
    const p = runnerProcess({ script: 'return 1', egoBin: HANG_BIN, timeoutMs: 60_000 });
    await waitFor(() => existsSync(lockFile()));
    const holder = JSON.parse(readFileSync(lockFile(), 'utf8'));
    assert.equal(holder.pid, p.child.pid);
    p.child.kill('SIGKILL');
    await p.exited;
    assert.ok(existsSync(lockFile()), 'kill -9 来不及放锁');
    const r = await run({ script: 'return 2' });
    assert.equal(r.ok, true, r.error); assert.equal(r.result, 2);
  });

  test('持锁进程被 kill -9 但心跳还新鲜：previous-still-running', async () => {
    const p = runnerProcess({ script: 'return 1', egoBin: HANG_BIN, timeoutMs: 60_000 });
    await waitFor(() => existsSync(lockFile()));
    p.child.kill('SIGKILL');
    await p.exited;
    writeBeat(Date.now());
    const r = await run({ script: 'return 1', egoBin: NOWHERE });
    assert.equal(r.reason, 'previous-still-running'); assert.equal(r.exitCode, 5);
  });

  test('SIGTERM / SIGINT（X-B5）：杀掉 CLI、进程按原信号退出，但不放锁，标成 abandoned；心跳过期前新任务 previous-still-running', async () => {
    const STALE = 1000;
    for (const sig of ['SIGTERM', 'SIGINT']) {
      const p = runnerProcess({ script: 'return 1', egoBin: HANG_BIN, timeoutMs: 60_000 });
      await waitFor(() => existsSync(lockFile()));
      await sleep(300);   // 等假 CLI 起来
      p.child.kill(sig);
      const { signal, out } = await p.exited;
      assert.equal(signal, sig, out);
      assert.ok(existsSync(lockFile()), `${sig} 后锁不该释放（Ego 里的脚本可能还在跑）`);
      assert.ok(JSON.parse(readFileSync(lockFile(), 'utf8')).abandonedAt > 0, '锁里应记下放弃时刻');
      const busy = await run({ script: 'return 1', egoBin: NOWHERE, heartbeatStaleMs: STALE });
      assert.equal(busy.reason, 'previous-still-running'); assert.equal(busy.exitCode, 5);
      await sleep(STALE + 100);
      const ok = await run({ script: 'return 1', heartbeatStaleMs: STALE });
      assert.equal(ok.ok, true, ok.error);
    }
  });

  test('锁里有残缺内容（创建方死在写入前）且已过 5 秒：回收', async () => {
    mkdirSync(dirname(lockFile()), { recursive: true });
    writeFileSync(lockFile(), '');
    const r = await run({ script: 'return 1', lock: 'skip' });
    assert.equal(r.reason, 'locked', '刚创建的空锁先当被占');
    const { utimesSync } = await import('node:fs');
    const old = new Date(Date.now() - 10_000);
    utimesSync(lockFile(), old, old);
    const r2 = await run({ script: 'return 1', lock: 'skip' });
    assert.equal(r2.ok, true, r2.error);
  });
});

describe('runInSpace 心跳、截止时间、user-owned、profile（不需要 Ego Lite）', () => {
  beforeEach(() => {
    opsDir = mkdtempSync(join(tmpdir(), 'maitian-ops-'));
    logFile = join(opsDir, 'fake-ego-log.jsonl');
    process.env.FAKE_EGO_LOG = logFile;
    delete process.env.FAKE_EGO_PROFILES;
    useSpaces([{ id: 9, name: SPACE, profileId: 'Profile 5', ownership: 'agent' }]);
  });

  test('脚本运行中心跳文件在、记着 space 和 deadline；结束后删掉', async () => {
    const r = await run({ script: `const fs = await import("node:fs"); return { beat: JSON.parse(fs.readFileSync(${JSON.stringify(beatFile())}, "utf8")), deadline };`, timeoutMs: 60_000 });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.result.beat.space, SPACE);
    assert.equal(r.result.beat.deadline, r.result.deadline);
    assert.ok(r.result.deadline > Date.now() + 40_000 && r.result.deadline < Date.now() + 60_000, '截止时间在 runner 超时之前');
    assert.equal(existsSync(beatFile()), false);
  });

  test('脚本抛错：心跳删掉、锁放掉，失败（不吞错）', async () => {
    const r = await run({ script: 'throw new Error("boom")' });
    assert.equal(r.ok, false); assert.equal(r.reason, 'exit-code'); assert.equal(r.exitCode, 1);
    assert.match(r.stderr + r.stdout, /boom/);
    assert.equal(existsSync(beatFile()), false);
    assert.equal(existsSync(lockFile()), false);
  });

  test('到截止时间：脚本自己以 deadline 失败退出，心跳删掉，锁放掉', async () => {
    const t0 = Date.now();
    const r = await run({ script: sleepScript(30_000), timeoutMs: 3000 });
    assert.equal(r.reason, 'deadline', r.error); assert.equal(r.exitCode, 1);
    assert.ok(Date.now() - t0 < 3000, '应在 runner 超时前由脚本自己退出');
    assert.equal(existsSync(beatFile()), false);
    assert.equal(existsSync(lockFile()), false);
  });

  for (const ownership of ['user', 'agentDelegatedToUser']) {
    test(`ownership=${ownership}：返回 user-owned、退出码 4，没调 claim/takeOver/taskSpace`, async () => {
      useSpaces([{ id: 9, name: SPACE, profileId: 'Profile 5', ownership }]);
      const r = await run({ script: 'return 1' });
      assert.equal(r.ok, false); assert.equal(r.reason, 'user-owned'); assert.equal(r.exitCode, 4);
      assert.equal(r.ownership, ownership); assert.match(r.error, new RegExp(`ownership=${ownership}`));
      assert.deepEqual(calls(), []);
      assert.equal(existsSync(lockFile()), false);
    });
  }

  test('takeBack：agentDelegatedToUser 调 takeOverTaskSpace 收回后跑；user 仍 user-owned 不碰', async () => {
    useSpaces([{ id: 9, name: SPACE, profileId: 'Profile 5', ownership: 'agentDelegatedToUser' }]);
    const r = await run({ script: 'return task.spaceId', takeBack: true });
    assert.equal(r.ok, true, r.error); assert.equal(r.result, 9);
    assert.deepEqual(calls(), [{ fn: 'takeOverTaskSpace', arg: 9 }]);
    useSpaces([{ id: 9, name: SPACE, profileId: 'Profile 5', ownership: 'user' }]);
    const u = await run({ script: 'return 1', takeBack: true });
    assert.equal(u.reason, 'user-owned');
    assert.deepEqual(calls(), [{ fn: 'takeOverTaskSpace', arg: 9 }]);
  });

  test('Profile 5 不存在：profile-missing、退出码 3，不建 profile 也不建 space', async () => {
    process.env.FAKE_EGO_PROFILES = '["Profile 1"]';
    useSpaces([]);
    const r = await run({ script: 'return 1' });
    assert.equal(r.reason, 'profile-missing'); assert.equal(r.exitCode, 3);
    assert.match(r.error, /Profile 5/);
    assert.deepEqual(calls(), []);
  });

  test('Profile 6、space 名不对：分别退出码 3、2，不拿锁不起子进程', async () => {
    const p6 = await run({ script: 'return 1', profileId: 'Profile 6', egoBin: NOWHERE });
    assert.equal(p6.reason, 'profile-rejected'); assert.equal(p6.exitCode, 3);
    const bad = await run({ space: 'someone/else', script: 'return 1', egoBin: NOWHERE });
    assert.equal(bad.reason, 'bad-space-name'); assert.equal(bad.exitCode, 2);
    assert.equal(existsSync(opsPaths(null, opsDir).lockDir), false);
  });

  test('space 名只按名字找：不存在时 taskSpace(name, { profileId: "Profile 5" })', async () => {
    useSpaces([]);
    const r = await run({ script: 'return 1' });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(calls(), [{ fn: 'taskSpace', arg: SPACE, opts: { profileId: 'Profile 5' } }]);
  });
});

describe('cli 退出码（不需要 Ego Lite）', () => {
  beforeEach(() => {
    opsDir = mkdtempSync(join(tmpdir(), 'maitian-ops-'));
    logFile = join(opsDir, 'fake-ego-log.jsonl');
    process.env.FAKE_EGO_LOG = logFile;
    delete process.env.FAKE_EGO_PROFILES;
  });
  const cli = (args, input = 'return 1') => new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, '--space', SPACE, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${FAKE_DIR}:${process.env.PATH}`, MAITIAN_OPS_DIR: opsDir },
    });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, json: JSON.parse(out.trim().split('\n').at(-1)) }));
    c.stdin.end(input);
  });

  test('成功 0；user-owned 4；--lock skip 被占 5；--lock 值不对 2', async () => {
    useSpaces([{ id: 9, name: SPACE, profileId: 'Profile 5', ownership: 'agent' }]);
    assert.deepEqual(await cli([], 'return 6 * 7').then((r) => [r.code, r.json.result]), [0, 42]);
    useSpaces([{ id: 9, name: SPACE, profileId: 'Profile 5', ownership: 'user' }]);
    const u = await cli([]);
    assert.equal(u.code, 4); assert.equal(u.json.reason, 'user-owned');
    useSpaces([{ id: 9, name: SPACE, profileId: 'Profile 5', ownership: 'agent' }]);
    const first = run({ script: sleepScript(2000) });
    await waitFor(() => existsSync(lockFile()));
    const l = await cli(['--lock', 'skip']);
    assert.equal(l.code, 5); assert.equal(l.json.reason, 'locked');
    const lw = await cli(['--lock-timeout-ms', '300']);
    assert.equal(lw.code, 5); assert.equal(lw.json.reason, 'locked');
    await first;
    const bad = await cli(['--lock', 'maybe']);
    assert.equal(bad.code, 2); assert.equal(bad.json.reason, 'bad-args');
  });

  test('--finish：user-owned 时不去关那个 space', async () => {
    useSpaces([{ id: 9, name: SPACE, profileId: 'Profile 5', ownership: 'user' }]);
    const r = await cli(['--finish']);
    assert.equal(r.code, 4); assert.equal(r.json.finish, undefined);
    assert.deepEqual(calls(), []);
  });
});
