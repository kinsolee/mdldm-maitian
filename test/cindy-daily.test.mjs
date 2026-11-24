// 每日数据流程调度命令（integrations/cindy/daily.mjs）：从命令行入口当黑盒测。
// 假的采集命令和收口脚本（test/fixtures/daily/）只写临时目录：临时 ops.db、影子目录、知识库、看板、状态文件。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { openOpsDb } from '../src/ops/db.mjs';
import { ensureWorksTables } from '../src/ops/works-db.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DAILY = path.join(ROOT, 'integrations/cindy/daily.mjs');
const FIX = path.join(ROOT, 'test/fixtures/daily');
const PLATFORMS = ['Douyin', 'XiaoHongShu', 'Bili', 'Channels'];
const POSTS = PLATFORMS.flatMap((p) => [1, 2].map((i) => ({ postId: `${p}-${i}`, platform: p, title: `${p} 作品 ${i}` })));
const T10 = '2026-11-25T02:00:00.000Z';   // 台湾 11-25 10:00
const later = (iso, min) => new Date(Date.parse(iso) + min * 60_000).toISOString();

function setup({ scenario = {}, closer = true, tools = ['python3', 'lark-cli', 'ego-browser'] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maitian-daily-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  for (const t of tools) { fs.writeFileSync(path.join(bin, t), '#!/bin/sh\nexit 0\n'); fs.chmodSync(path.join(bin, t), 0o755); }
  const db = openOpsDb(path.join(dir, 'ops.db'));
  ensureWorksTables(db);
  const t = {
    dir, db,
    fake: path.join(dir, 'scenario.json'), log: path.join(dir, 'calls.jsonl'),
    state: path.join(dir, 'state', 'daily.json'), dashboard: path.join(dir, 'data.js'),
    vault: path.join(dir, 'vault'), shadow: path.join(dir, 'shadow'),
    closer: closer ? path.join(FIX, 'fake-closer.mjs') : null,
    now: T10,
  };
  t.setScenario = (s) => fs.writeFileSync(t.fake, JSON.stringify({ posts: POSTS, ...s }));
  t.setScenario(scenario);
  fs.writeFileSync(t.log, '');
  t.env = () => ({
    HOME: dir, PATH: '/usr/bin:/bin', TZ: 'Asia/Taipei',
    MAITIAN_OPS_DB: path.join(dir, 'ops.db'), MAITIAN_OPS_SHADOW_DIR: t.shadow,
    MAITIAN_DAILY_VAULT: t.vault, MAITIAN_DAILY_DASHBOARD: t.dashboard, MAITIAN_DAILY_STATE: t.state,
    MAITIAN_DAILY_NOW: t.now, MAITIAN_DAILY_COLLECT_CMD: path.join(FIX, 'fake-collect.mjs'),
    MAITIAN_DAILY_PATH: `${bin}:/usr/bin:/bin`,
    DAILY_FAKE: t.fake, DAILY_FAKE_LOG: t.log, DAILY_FAKE_DASHBOARD: t.dashboard,
    ...t.extraEnv,
  });
  t.extraEnv = {};
  t.cli = (mode, extra = []) => {
    const args = [DAILY, mode, ...(t.closer ? ['--closer', t.closer] : []), ...extra];
    const r = spawnSync(process.execPath, args, { env: t.env(), encoding: 'utf8', input: '{"protocol":"cindy-script/1","type":"start"}\n' });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  t.cliAsync = (mode, extra = []) => new Promise((resolve) => {
    const c = spawn(process.execPath, [DAILY, mode, ...(t.closer ? ['--closer', t.closer] : []), ...extra], { env: t.env() });
    let stdout = '', stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  t.notesDir = path.join(t.vault, '10.个人IP', '数据', '平台数据', '2026年');
  t.writeNote = (file, fm) => { fs.mkdirSync(t.notesDir, { recursive: true }); fs.writeFileSync(path.join(t.notesDir, file), `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n`); };
  /** 每篇笔记今天的抓取记录行数（假收口脚本和 backfill.py 一样，每回填一次追加一行）。 */
  t.todayRows = () => Object.fromEntries(fs.readdirSync(t.notesDir).map((f) => [f, fs.readFileSync(path.join(t.notesDir, f), 'utf8').split('\n').filter((l) => l.startsWith('| 2026-11-25')).length]));
  t.calls = () => fs.readFileSync(t.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  t.clearCalls = () => fs.writeFileSync(t.log, '');
  t.syncOk = (platformCode, at) => db.prepare("INSERT INTO sync_jobs (id, platformCode, kind, trigger, status, requestedAt, startedAt, finishedAt) VALUES (?, ?, 'comments', 'schedule', 'ok', ?, ?, ?)")
    .run(`job-${platformCode}-${at}`, platformCode, at, at, at);
  t.syncRunning = (platformCode, at) => db.prepare("INSERT INTO sync_jobs (id, platformCode, kind, trigger, status, requestedAt, startedAt) VALUES (?, ?, 'comments', 'schedule', 'running', ?, ?)")
    .run(`run-${platformCode}-${at}`, platformCode, at, at);
  return t;
}

/** run 模式的标准输出：只有 JSON 行，每行是 cindy-script/1 协议帧，恰好一个完成帧且在最后。返回完成帧。 */
function frame(stdout) {
  const lines = stdout.split('\n').filter((l) => l.trim());
  assert.ok(lines.length >= 1, `stdout 没有任何帧：${JSON.stringify(stdout)}`);
  const frames = lines.map((l) => JSON.parse(l));
  for (const f of frames) assert.equal(f.protocol, 'cindy-script/1');
  assert.equal(frames.filter((f) => f.type === 'complete').length, 1);
  assert.equal(frames.at(-1).type, 'complete');
  assert.equal(typeof frames.at(-1).resultText, 'string');
  return frames.at(-1);
}

const closerCalls = (t) => t.calls().filter((c) => c.cmd === 'closer');
const collectCalls = (t) => t.calls().filter((c) => c.cmd === 'collect');
const arg = (call, k) => { const i = call.args.indexOf(k); return i < 0 ? null : call.args[i + 1]; };

describe('新的一天', () => {
  test('前置检查放行；一轮采四个平台、回填一次；做完后前置检查跳过，再触发不调用任何东西（A1–A4、A7、A8）', () => {
    const t = setup();
    assert.equal(t.cli('check').code, 0);

    const r = t.cli('run');
    assert.equal(r.code, 0, r.stderr);
    const f = frame(r.stdout);
    assert.match(f.resultText, /全部做完/);
    const [col] = collectCalls(t);
    assert.deepEqual(col.args.filter((a) => !a.startsWith('--') && a !== 'collect').sort(), [...PLATFORMS].sort());
    assert.ok(col.args.includes('--export') && col.args.includes('--json'));
    const cl = closerCalls(t);
    assert.equal(cl.length, 1);
    assert.deepEqual(cl[0].posts.sort(), POSTS.map((p) => p.postId).sort());
    assert.equal(arg(cl[0], '--source'), '麦田');
    assert.equal(arg(cl[0], '--vault'), t.vault);
    assert.ok(!cl[0].args.includes('--skip-feishu') && !cl[0].args.includes('--skip-mp') && !cl[0].args.includes('--skip-channels'));
    assert.deepEqual(cl[0].dashboardPlatforms, [...PLATFORMS].sort());
    assert.ok(arg(cl[0], '--accounts'));

    assert.equal(t.cli('check').code, 2);
    t.clearCalls();
    const again = t.cli('run');
    assert.equal(again.code, 0, again.stderr);
    assert.match(frame(again.stdout).resultText, /已做完|没有要做/);
    assert.deepEqual(t.calls(), []);
  });

  test('手动补过的日子（数据都在）：前置检查跳过，手动触发也不采不写', () => {
    const t = setup();
    t.cli('run');
    fs.rmSync(t.state, { force: true });            // 状态文件丢了也一样：判据来自数据本身
    t.clearCalls();
    assert.equal(t.cli('check').code, 2);
    const r = t.cli('run');
    assert.equal(r.code, 0, r.stderr);
    frame(r.stdout);
    assert.deepEqual(t.calls(), []);
  });

  test('同一条作品有两篇笔记（知识库里真有）：只要有一篇今天抓过就算回填过', () => {
    const t = setup();
    t.cli('run');
    const dir = path.join(t.vault, '10.个人IP', '数据', '平台数据', '2026年');
    for (const [id, plat] of [['Douyin-1', '抖音'], ['Channels-2', '视频号']]) fs.writeFileSync(path.join(dir, `zz-旧-${id}.md`), `---\ntype: 平台数据\nplatform: ${plat}\npost_id: ${id}\nfetched_at: "2026-11-16 09:42"\n---\n`);
    t.now = later(T10, 15);
    assert.equal(t.cli('check').code, 2);
  });
});

describe('平台未登录', () => {
  test('视频号未登录：当天失败一次写明要扫码，之后跳过；评论私信同步恢复后补上视频号，看板仍有四个平台（A5、A7）', () => {
    const t = setup({ scenario: { collect: { Channels: 'out' } } });
    const r1 = t.cli('run');
    assert.equal(r1.code, 1);
    frame(r1.stdout);
    assert.match(r1.stderr, /视频号/);
    assert.match(r1.stderr, /扫码/);
    const [cl1] = closerCalls(t);
    assert.deepEqual(cl1.posts.sort(), POSTS.filter((p) => p.platform !== 'Channels').map((p) => p.postId).sort());
    assert.ok(cl1.args.includes('--skip-channels'), '视频号没登录时分日也跳过');

    t.now = later(T10, 15);
    assert.equal(t.cli('check').code, 2);
    t.now = later(T10, 30);
    assert.equal(t.cli('check').code, 2);

    // 负责人扫码，守护进程的评论私信同步恢复成功
    t.syncOk('Channels', later(T10, 40));
    t.setScenario({});
    t.now = later(T10, 45);
    assert.equal(t.cli('check').code, 0);
    t.clearCalls();
    const r2 = t.cli('run');
    assert.equal(r2.code, 0, r2.stderr);
    assert.match(frame(r2.stdout).resultText, /全部做完/);
    const [col] = collectCalls(t);
    assert.deepEqual(col.args.filter((a) => !a.startsWith('--') && a !== 'collect'), ['Channels']);
    const [cl2] = closerCalls(t);
    assert.deepEqual(cl2.posts.sort(), ['Channels-1', 'Channels-2']);
    assert.ok(!cl2.args.includes('--skip-channels'));
    assert.ok(cl2.args.includes('--skip-mp'), '公众号已经做过，不重复');
    assert.deepEqual(cl2.dashboardPlatforms, [...PLATFORMS].sort());
    assert.equal(t.cli('check').code, 2);
  });

  test('UID 不符也只提醒一次', () => {
    const t = setup({ scenario: { collect: { Bili: 'uid-mismatch' } } });
    const r = t.cli('run');
    assert.equal(r.code, 1);
    frame(r.stdout);
    assert.match(r.stderr, /B站/);
    assert.match(r.stderr, /UID/);
    t.now = later(T10, 15);
    assert.equal(t.cli('check').code, 2);
  });

  test('busy 是瞬时原因：本轮不算失败，下一轮重试；评论私信同步正占着空间时前置检查先跳过', () => {
    const t = setup({ scenario: { collect: { Douyin: 'busy' } } });
    const r = t.cli('run');
    assert.equal(r.code, 0, r.stderr);
    assert.match(frame(r.stdout).resultText, /抖音/);
    t.now = later(T10, 15);
    t.syncRunning('Douyin', later(T10, 12));
    assert.equal(t.cli('check').code, 2);
    t.now = later(T10, 60);                          // 同步早该结束了，不认这条卡住的 running
    assert.equal(t.cli('check').code, 0);
    t.setScenario({});
    t.clearCalls();
    const r2 = t.cli('run');
    assert.equal(r2.code, 0, r2.stderr);
    assert.deepEqual(collectCalls(t)[0].args.filter((a) => !a.startsWith('--') && a !== 'collect'), ['Douyin']);
    assert.deepEqual(closerCalls(t)[0].posts.sort(), ['Douyin-1', 'Douyin-2']);
  });
});

describe('收口脚本出错', () => {
  test('飞书那步失败：本轮失败并写明原因；下一轮只重试同步，不再采集、不再回填笔记、不重复分日和公众号（A6）', () => {
    const t = setup({ scenario: { closer: { feishu: 'fail' } } });
    const r = t.cli('run');
    assert.equal(r.code, 1);
    frame(r.stdout);
    assert.match(r.stderr, /飞书/);
    t.now = later(T10, 15);
    assert.equal(t.cli('check').code, 0);
    t.setScenario({});
    t.clearCalls();
    const r2 = t.cli('run');
    assert.equal(r2.code, 0, r2.stderr);
    assert.deepEqual(collectCalls(t), []);
    const [cl] = closerCalls(t);
    assert.deepEqual(cl.posts, []);
    assert.ok(cl.args.includes('--skip-channels') && cl.args.includes('--skip-mp'));
    assert.ok(!cl.args.includes('--skip-feishu'));
    assert.deepEqual(cl.dashboardPlatforms, [...PLATFORMS].sort());
  });

  test('笔记那步失败（退出 3）：本轮失败，下一轮重新回填', () => {
    const t = setup({ scenario: { closer: { backfill: 'fail' } } });
    const r = t.cli('run');
    assert.equal(r.code, 1);
    frame(r.stdout);
    assert.match(r.stderr, /笔记|backfill/);
    t.setScenario({});
    t.now = later(T10, 15);
    assert.equal(t.cli('check').code, 0);
    t.clearCalls();
    assert.equal(t.cli('run').code, 0);
    assert.deepEqual(collectCalls(t), []);
    assert.equal(closerCalls(t)[0].posts.length, POSTS.length);
  });

  test('公众号未登录：提醒一次；一小时内跳过，满一小时探一次，还没登录不再算失败', () => {
    const t = setup({ scenario: { closer: { mp: 'login' } } });
    const r = t.cli('run');
    assert.equal(r.code, 1);
    frame(r.stdout);
    assert.match(r.stderr, /公众号/);
    t.now = later(T10, 30);
    assert.equal(t.cli('check').code, 2);
    t.now = later(T10, 61);
    assert.equal(t.cli('check').code, 0);
    t.clearCalls();
    const r2 = t.cli('run');
    assert.equal(r2.code, 0, r2.stderr);
    frame(r2.stdout);
    const [cl] = closerCalls(t);
    assert.deepEqual(cl.posts, []);
    assert.ok(!cl.args.includes('--skip-mp') && cl.args.includes('--skip-channels'));
    t.now = later(T10, 75);
    assert.equal(t.cli('check').code, 2);
  });
});

describe('环境和配置', () => {
  test('没配置收口脚本：只采集，摘要写明回填未配置', () => {
    const t = setup({ closer: false });
    const r = t.cli('run');
    assert.equal(r.code, 0, r.stderr);
    assert.match(frame(r.stdout).resultText, /未配置/);
    assert.equal(collectCalls(t).length, 1);
    assert.equal(closerCalls(t).length, 0);
    assert.equal(t.cli('check').code, 2);
  });

  test('子进程的 PATH 里找不到 lark-cli：明确报错、当天只报一次，不调用收口脚本', () => {
    const t = setup({ tools: ['python3', 'ego-browser'] });
    const r = t.cli('run');
    assert.equal(r.code, 1);
    frame(r.stdout);
    assert.match(r.stderr, /lark-cli/);
    assert.equal(closerCalls(t).length, 0);
    t.now = later(T10, 15);
    assert.equal(t.cli('check').code, 2);
  });

  test('状态和预演只读：不调用任何命令、不写状态文件；预演列出要做的事', () => {
    const t = setup();
    const s = t.cli('status');
    assert.equal(s.code, 0, s.stderr);
    assert.match(s.stdout, /抖音/);
    const p = t.cli('plan');
    assert.equal(p.code, 0, p.stderr);
    assert.match(p.stdout, /采集/);
    assert.match(p.stdout, /回填/);
    const j = JSON.parse(t.cli('status', ['--json']).stdout);
    assert.equal(j.date, '2026-11-25');
    assert.deepEqual(t.calls(), []);
    assert.equal(fs.existsSync(t.state), false);
  });

  test('手动跑过不带 --export 的采集：不重采，先重新导出再回填', () => {
    const t = setup();
    for (const p of PLATFORMS) t.db.prepare("INSERT INTO collect_runs (runId, platformCode, uid, startedAt, finishedAt, result, days) VALUES ('m', ?, 'u', ?, ?, 'ok', 30)").run(p, T10, T10);
    t.now = later(T10, 5);
    assert.equal(t.cli('check').code, 0);
    const r = t.cli('run');
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(collectCalls(t).map((c) => c.args.slice(0, 2)), [['export', 'posts'], ['export', 'accounts']]);
    assert.equal(closerCalls(t)[0].posts.length, POSTS.length);
  });

  test('跨天重新开始：昨天做完不影响今天', () => {
    const t = setup();
    t.cli('run');
    t.now = later(T10, 24 * 60);
    assert.equal(t.cli('check').code, 0);
  });
});

describe('第 1 轮评审补的边界', () => {
  test('笔记写到一半退出 3：下一轮只传还没回填的作品，每篇笔记今天恰好一行（B1）', () => {
    const t = setup({ scenario: { closer: { backfill: 'partial' } } });
    assert.equal(t.cli('run').code, 1);
    t.setScenario({});
    t.now = later(T10, 15);
    t.clearCalls();
    assert.equal(t.cli('run').code, 0);
    assert.equal(closerCalls(t)[0].posts.length, POSTS.length / 2);
    const rows = t.todayRows();
    for (const p of POSTS) assert.equal(rows[`${p.postId}.md`], 1, p.postId);
  });

  test('同平台只缺一篇：只传那一篇（B1）', () => {
    const t = setup();
    t.cli('run');
    t.writeNote('Bili-2.md', { type: '平台数据', platform: '哔哩哔哩', post_id: 'Bili-2', fetched_at: '"2026-11-24 10:00"' });
    t.now = later(T10, 15);
    t.clearCalls();
    assert.equal(t.cli('run').code, 0);
    assert.deepEqual(closerCalls(t)[0].posts, ['Bili-2']);
  });

  test('另一轮在跑：并发的第二轮不调用任何东西；死掉进程留下的锁会回收，活着的进程持有的锁再旧也不抢（B2、B15）', async () => {
    const t = setup({ scenario: { sleepMs: 1500 } });
    const [a, b] = await Promise.all([t.cliAsync('run'), new Promise((ok) => setTimeout(ok, 300)).then(() => t.cliAsync('run'))]);
    assert.equal(collectCalls(t).length, 1);
    assert.equal([a, b].filter((r) => /另一轮还在跑/.test(frame(r.stdout).resultText)).length, 1);

    const t2 = setup();
    fs.mkdirSync(path.dirname(t2.state), { recursive: true });
    fs.writeFileSync(`${t2.state}.lock`, JSON.stringify({ pid: 2 ** 22 + 12345, token: 'dead', at: Date.now() }));
    assert.equal(t2.cli('run').code, 0);
    assert.equal(collectCalls(t2).length, 1);

    const t3 = setup();
    fs.mkdirSync(path.dirname(t3.state), { recursive: true });
    fs.writeFileSync(`${t3.state}.lock`, JSON.stringify({ pid: process.pid, token: 'live', at: Date.now() - 60 * 60_000 }));
    assert.match(frame(t3.cli('run').stdout).resultText, /另一轮还在跑/);
    assert.equal(t3.cli('check').code, 2);
    assert.deepEqual(t3.calls(), []);
    assert.ok(fs.existsSync(`${t3.state}.lock`), '别人的锁不能删');
  });

  test('四个平台都没登录、没有当天导出：不调用收口脚本，看板不动（B3）', () => {
    const t = setup({ scenario: { collect: { Douyin: 'out', XiaoHongShu: 'out', Bili: 'out', Channels: 'out' } } });
    fs.writeFileSync(t.dashboard, 'window.DATA = "旧的"');
    const r = t.cli('run');
    assert.equal(r.code, 1);
    frame(r.stdout);
    assert.equal(closerCalls(t).length, 0);
    assert.equal(fs.readFileSync(t.dashboard, 'utf8'), 'window.DATA = "旧的"');
    t.now = later(T10, 15);
    assert.equal(t.cli('check').code, 2);
  });

  test('影子导出结构不对：先重新导出一次；还不对就提醒一次，不调用收口脚本（B4）', () => {
    const t = setup({ scenario: { exportBroken: true } });
    const r = t.cli('run');
    assert.equal(r.code, 1);
    frame(r.stdout);
    assert.match(r.stderr, /导出/);
    assert.deepEqual(collectCalls(t).map((c) => c.args[0]), ['collect', 'export', 'export']);
    assert.equal(closerCalls(t).length, 0);
    t.now = later(T10, 15);
    assert.equal(t.cli('check').code, 2);
  });

  test('只采了 1 天的 ok 不算今天采过（导出不收短窗口），会重新按 30 天采（B4）', () => {
    const t = setup();
    t.db.prepare("INSERT INTO collect_runs (runId, platformCode, uid, startedAt, finishedAt, result, days) VALUES ('m', 'Bili', 'u', ?, ?, 'ok', 1)").run(T10, T10);
    t.now = later(T10, 5);
    t.cli('run');
    assert.ok(collectCalls(t)[0].args.includes('Bili'));
  });

  test('第四个平台补采时笔记已经是今天的：照样重跑同步，看板拿到四个平台（B5）', () => {
    const t = setup({ scenario: { collect: { Channels: 'out' } } });
    t.cli('run');
    for (const i of [1, 2]) t.writeNote(`Channels-${i}.md`, { type: '平台数据', platform: '视频号', post_id: `Channels-${i}`, fetched_at: '"2026-11-25 10:20"', daily_fetched_at: '"2026-11-25 10:20"' });
    t.syncOk('Channels', later(T10, 30));
    t.setScenario({});
    t.now = later(T10, 45);
    t.clearCalls();
    assert.equal(t.cli('run').code, 0);
    const [cl] = closerCalls(t);
    assert.ok(cl, '要调收口脚本同步看板');
    assert.deepEqual(cl.posts, []);
    assert.deepEqual(cl.dashboardPlatforms, [...PLATFORMS].sort());
  });

  test('公众号抓到了但写笔记失败（退出 4）：本轮失败，下一轮重跑公众号（B6）', () => {
    const t = setup({ scenario: { closer: { mp: 'backfill-fail' } } });
    const r = t.cli('run');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /mp_backfill/);
    t.setScenario({});
    t.now = later(T10, 15);
    assert.equal(t.cli('check').code, 0);
    t.clearCalls();
    assert.equal(t.cli('run').code, 0);
    assert.ok(!closerCalls(t)[0].args.includes('--skip-mp'));
  });

  test('收口脚本输出不是 JSON：本轮失败，下一轮重试同步（B7）', () => {
    const t = setup({ scenario: { closer: { garbage: true } } });
    const r = t.cli('run');
    assert.equal(r.code, 1);
    frame(r.stdout);
    assert.match(r.stderr, /收口脚本/);
    t.setScenario({});
    t.now = later(T10, 15);
    assert.equal(t.cli('check').code, 0);
  });

  test('看板那步被跳过（没有工作台工程）：不算同步成功（B7）', () => {
    const t = setup({ scenario: { closer: { dashboard: 'skipped' } } });
    const r = t.cli('run');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /看板/);
  });

  test('--retry-waiting 强制重试后仍未登录：照样提醒一次（B9）', () => {
    const t = setup({ scenario: { collect: { Channels: 'out' } } });
    t.cli('run');
    t.now = later(T10, 15);
    fs.rmSync(t.state);
    const r = t.cli('run', ['--retry-waiting']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /视频号/);
  });

  test('评论私信同步的成功早于分日发现未登录：不当成已恢复（B10）', () => {
    const t = setup({ scenario: { closer: { channels: 'login', syncOkDuringRun: true } } });
    const r = t.cli('run');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /视频号/);
    t.now = later(T10, 15);
    assert.equal(t.cli('check').code, 2);
  });

  test('采集命令没给每个平台的结果：本轮失败（B11）', () => {
    const t = setup({ scenario: { collectBroken: true } });
    const r = t.cli('run');
    assert.equal(r.code, 1);
    frame(r.stdout);
    assert.match(r.stderr, /采集/);
  });

  test('账号表里没有这个平台：提醒一次怎么导入，之后跳过（B11）', () => {
    const t = setup({ scenario: { collect: { Bili: 'no-account' } } });
    const r = t.cli('run');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /accounts import/);
    t.now = later(T10, 15);
    assert.equal(t.cli('check').code, 2);
  });

  test('没配置收口脚本时，坏掉的旧导出不挡采集（B12）', () => {
    const t = setup({ closer: false });
    fs.mkdirSync(t.shadow, { recursive: true });
    fs.writeFileSync(path.join(t.shadow, 'posts-20261125.json'), '{坏的');
    assert.equal(t.cli('check').code, 0);
    assert.equal(t.cli('run').code, 0);
    assert.equal(collectCalls(t).length, 1);
  });

  test('状态目录建不了：退出 1，仍然恰好一个完成帧（B13）', () => {
    const t = setup();
    fs.writeFileSync(path.join(t.dir, 'plain'), '');
    const r = t.cli('run', ['--state', path.join(t.dir, 'plain', 'x', 'daily.json')]);
    assert.equal(r.code, 1);
    frame(r.stdout);
  });

  test('别的平台有同 ID 的笔记：不传给收口脚本（会写错笔记），提醒一次（B14）', () => {
    const t = setup();
    t.writeNote('冲突.md', { type: '平台数据', platform: '抖音', post_id: 'Bili-1', fetched_at: '"2026-11-25 09:00"' });
    const r = t.cli('run');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Bili-1/);
    assert.ok(!closerCalls(t)[0].posts.includes('Bili-1'));
    t.now = later(T10, 15);
    assert.equal(t.cli('check').code, 2);
  });

  test('收口脚本卡住：超时杀掉整棵进程树；笔记写了、同步没做完，下一轮补同步（B15、B16）', () => {
    const t = setup();
    const pidFile = path.join(t.dir, 'grandchild.pid');
    t.setScenario({ closer: { hang: pidFile } });
    fs.writeFileSync(t.dashboard, 'old');
    fs.utimesSync(t.dashboard, new Date(T10), new Date(T10));   // 看板今天已经刷过一次
    t.extraEnv = { MAITIAN_DAILY_CLOSER_TIMEOUT_MS: '800', MAITIAN_DAILY_KILL_GRACE_MS: '300' };
    const r = t.cli('run');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /超过/);
    const gpid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.throws(() => process.kill(gpid, 0), '孙进程要被杀掉');
    t.setScenario({});
    t.now = later(T10, 15);
    assert.equal(t.cli('check').code, 0);
    t.clearCalls();
    assert.equal(t.cli('run').code, 0);
    assert.deepEqual(closerCalls(t)[0].posts, []);
  });

  test('前置检查跑完输出 CINDY_PRECHECK_OK（N2）；需要负责人的事写在 stderr 最后（N3）', () => {
    const t = setup({ scenario: { collect: { Channels: 'out' }, closer: { feishu: 'fail' } } });
    assert.match(t.cli('check').stdout, /CINDY_PRECHECK_OK\s*$/);
    const r = t.cli('run');
    assert.match(r.stderr.trim().split('\n').at(-1), /需要你：视频号/);
  });
});

describe('零 token（B8）', () => {
  test('每次调收口脚本都传 --no-llm：看板分析走规则版，不调模型', () => {
    const t = setup({ scenario: { closer: { feishu: 'fail' } } });
    t.cli('run');
    t.setScenario({});
    t.now = later(T10, 15);
    t.cli('run');
    const calls = closerCalls(t);
    assert.equal(calls.length, 2);
    for (const c of calls) assert.ok(c.args.includes('--no-llm'), JSON.stringify(c.args));
  });
});
