import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { runInSpace, runEgoScript, parseResult, finishSpace } from '../src/ego-runner/index.mjs';
import { opsPaths } from '../src/ego-runner/paths.mjs';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EGO_SKIP, tempSpaceName, closeTestSpace } from './helpers/ego.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HANG_BIN = fileURLToPath(new URL('./fixtures/hang-ego-browser.mjs', import.meta.url));
const CLI = fileURLToPath(new URL('../src/ego-runner/cli.mjs', import.meta.url));

describe('parseResult（不需要 Ego Lite）', () => {
  test('最后一行 @@RESULT 解析成结果', () => {
    assert.deepEqual(parseResult('log\n@@RESULT {"a":1}\n', 0), { ok: true, result: { a: 1 } });
  });
  test('结果行后面只跟 Ego 的提示行也算最后一行', () => {
    assert.deepEqual(parseResult('@@RESULT 7\n[ego-browser:notice] update\n', 0), { ok: true, result: 7 });
  });
  test('没有 @@RESULT 行是失败', () => {
    const r = parseResult('hello\n', 0);
    assert.equal(r.ok, false); assert.equal(r.reason, 'no-result');
  });
  test('@@RESULT 后面不是最后一行是失败', () => {
    const r = parseResult('@@RESULT 1\nmore output\n', 0);
    assert.equal(r.ok, false); assert.equal(r.reason, 'no-result');
  });
  test('JSON 坏了是失败', () => {
    const r = parseResult('@@RESULT {bad\n', 0);
    assert.equal(r.ok, false); assert.equal(r.reason, 'bad-json');
  });
  test('退出码非零是失败，即使有结果行', () => {
    const r = parseResult('@@RESULT {"a":1}\n', 2);
    assert.equal(r.ok, false); assert.equal(r.reason, 'exit-code'); assert.equal(r.code, 2);
  });
});

describe('runInSpace 参数检查（不需要 Ego Lite）', () => {
  test('Profile 6 被拒绝，不起子进程', async () => {
    const r = await runInSpace({ space: 'kinso/test/x', profileId: 'Profile 6', script: 'return 1', egoBin: '/nonexistent/ego-browser' });
    assert.equal(r.ok, false); assert.equal(r.reason, 'profile-rejected');
  });
  test('space 名不符合 kinso/<平台>/<uid> 被拒绝', async () => {
    const r = await runInSpace({ space: 'someone-else', script: 'return 1', egoBin: '/nonexistent/ego-browser' });
    assert.equal(r.ok, false); assert.equal(r.reason, 'bad-space-name');
  });
  test('ego-browser 起不来是失败', async () => {
    const r = await runEgoScript('console.log(1)', { egoBin: '/nonexistent/ego-browser' });
    assert.equal(r.ok, false); assert.equal(r.reason, 'spawn-failed');
  });
  test('超时是失败：杀掉 CLI，返回 reason=timeout，不留子进程', async () => {
    const t0 = Date.now();
    // 2 秒：留够 node 冷启动的时间，让假程序先打出 pid 再被杀（300ms 时冷启动偶尔来不及）
    const r = await runEgoScript('console.log(1)', { egoBin: HANG_BIN, timeoutMs: 2000 });
    assert.ok(Date.now() - t0 < 6000, '超时后应很快返回');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'timeout');
    assert.match(r.error, /超过 2000ms/);
    const pid = Number(r.stderr.match(/hang-pid (\d+)/)?.[1]);
    assert.ok(pid > 0, '假 ego-browser 应已启动');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, '子进程应已被杀掉');
  });
});

describe('runInSpace 基本行为 真实 Ego Lite', { skip: EGO_SKIP ?? false }, () => {
  const space = tempSpaceName('runner');
  after(() => closeTestSpace(space));

  test('脚本返回值经 @@RESULT 带回，space 在 Profile 5 上', async () => {
    const r = await runInSpace({ space, params: { n: 41 }, script: 'return { n: params.n + 1, spaceName: task.name, spaceId: task.spaceId }' });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.result.n, 42);
    assert.equal(r.result.spaceName, space);
    const spaces = await runEgoScript(`console.log("@@RESULT " + JSON.stringify((await listTaskSpaces()).find((s) => s.name === ${JSON.stringify(space)})))`);
    assert.equal(spaces.result.profileId, 'Profile 5');
  });
  test('同名 space 第二次运行复用同一个', async () => {
    const a = await runInSpace({ space, script: 'return task.spaceId' });
    const b = await runInSpace({ space, script: 'return task.spaceId' });
    assert.equal(a.ok && b.ok, true);
    assert.equal(a.result, b.result);
  });
  test('脚本没返回值（缺 @@RESULT 行）是失败', async () => {
    const r = await runInSpace({ space, script: 'console.log("done")' });
    assert.equal(r.ok, false); assert.equal(r.reason, 'no-result');
  });
  test('脚本抛错（退出码非零）是失败', async () => {
    const r = await runInSpace({ space, script: 'throw new Error("boom")' });
    assert.equal(r.ok, false); assert.equal(r.reason, 'exit-code');
    assert.match(r.stderr + r.stdout, /boom/);
  });
  test('process.exit(3) 是失败', async () => {
    const r = await runInSpace({ space, script: 'console.log("@@RESULT 1"); process.exit(3)' });
    assert.equal(r.ok, false); assert.equal(r.reason, 'exit-code'); assert.equal(r.code, 3);
  });
  test('脚本里能加载插件 lib', async () => {
    const r = await runInSpace({ space, script: 'const cdp = await loadPlugin("lib/cdp.js"); const pub = await loadPlugin("lib/publish.js"); return { evaluate: typeof cdp.evaluate, preflight: typeof pub.preflight }' });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.result, { evaluate: 'function', preflight: 'function' });
  });
});

describe('runInSpace 真实 Ego Lite', { skip: EGO_SKIP ?? false }, () => {
  const opsDir = mkdtempSync(join(tmpdir(), 'maitian-ops-'));
  const spaces = [];
  const space = (tag) => { const s = tempSpaceName(tag); spaces.push(s); return s; };
  after(async () => { for (const s of spaces) await closeTestSpace(s); });
  const ownershipOf = async (s) => (await runEgoScript(`console.log("@@RESULT " + JSON.stringify((await listTaskSpaces()).find((x) => x.name === ${JSON.stringify(s)})?.ownership ?? null))`)).result;

  test('运行中有心跳、能用 withForegroundLock；结束后心跳、space 锁、前台锁都删掉', async () => {
    const s = space('beat');
    const { heartbeat, spaceLock, foregroundLock } = opsPaths(s, opsDir);
    const r = await runInSpace({ space: s, opsDir, script: `const fs = await import("node:fs");
      const beat = JSON.parse(fs.readFileSync(${JSON.stringify(heartbeat)}, "utf8"));
      const inLock = await withForegroundLock(async () => fs.existsSync(${JSON.stringify(foregroundLock)}));
      return { beatSpace: beat.space, inLock, deadline, spaceName: task.name };` });
    assert.equal(r.ok, true, `${r.reason} ${r.error} ${r.stderr}`);
    assert.equal(r.exitCode, 0);
    assert.deepEqual({ ...r.result, deadline: typeof r.result.deadline }, { beatSpace: s, inLock: true, deadline: 'number', spaceName: s });
    for (const f of [heartbeat, spaceLock, foregroundLock]) assert.equal(existsSync(f), false, f);
  });

  test('到截止时间脚本自己退出（不靠杀 CLI），心跳停下并删掉', async () => {
    const s = space('deadline');
    const t0 = Date.now();
    // G-B9：到点时正持着前台锁，前言退出前也要放掉
    const r = await runInSpace({ space: s, opsDir, timeoutMs: 12_000, script: 'await withForegroundLock(() => new Promise((r) => setTimeout(r, 60_000))); return 1;' });
    assert.equal(r.reason, 'deadline', `${r.error} ${r.stderr}`); assert.equal(r.exitCode, 1);
    assert.ok(Date.now() - t0 < 12_000, '应在 runner 超时前结束');
    assert.equal(existsSync(opsPaths(s, opsDir).heartbeat), false);
    assert.equal(existsSync(opsPaths(s, opsDir).foregroundLock), false, '前台锁应已放掉');
  });

  test('上次 finish 保留了页面（ownership=user）：返回 user-owned、退出码 4，不认领', async () => {
    const s = space('owned');
    const kept = await runInSpace({ space: s, opsDir, script: 'await task.page("p1").goto("about:blank"); return (await task.finish({ keep: "all" })).keptManagedLabels;' });
    assert.equal(kept.ok, true, `${kept.error} ${kept.stderr}`);
    assert.equal(await ownershipOf(s), 'user');
    const r = await runInSpace({ space: s, opsDir, script: 'return 1' });
    assert.equal(r.reason, 'user-owned', `${r.error} ${r.stderr}`); assert.equal(r.exitCode, 4);
    assert.equal(r.ownership, 'user');
    assert.equal(await ownershipOf(s), 'user', '没有被认领');
    // X-B3：finishSpace 也不认领、不关
    const f = await finishSpace(s, { opsDir });
    assert.equal(f.reason, 'user-owned', `${f.error} ${f.stderr}`); assert.equal(f.exitCode, 4);
    assert.equal(await ownershipOf(s), 'user', 'finishSpace 没有认领');
  });
});

describe('命令行入口', () => {
  const cli = (args, input) => new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, json: JSON.parse(out.trim().split('\n').at(-1)) }));
    c.stdin.end(input);
  });

  test('Profile 6 被拒绝，退出码 3（KIN-327：退出码按 reason 区分）', async () => {
    const r = await cli(['--space', 'kinso/test/x', '--profile', 'Profile 6'], 'return 1');
    assert.equal(r.code, 3); assert.equal(r.json.reason, 'profile-rejected');
  });

  test('从 stdin 读脚本跑完并 --finish 关掉 space', { skip: EGO_SKIP ?? false }, async () => {
    const space = tempSpaceName('cli');
    const r = await cli(['--space', space, '--params', '{"x":2}', '--finish'], 'return params.x * 21');
    assert.equal(r.code, 0);
    const { finish, ...task } = r.json;
    assert.deepEqual(task, { ok: true, result: 42, code: 0, signal: null, exitCode: 0 });
    assert.equal(finish.ok, true); assert.equal(finish.result.closedSpace, true);
    const left = await runEgoScript(`console.log("@@RESULT " + JSON.stringify((await listTaskSpaces()).some((s) => s.name === ${JSON.stringify(space)})))`);
    assert.equal(left.result, false);
  });
});
