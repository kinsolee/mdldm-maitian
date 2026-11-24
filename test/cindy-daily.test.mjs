// 每日数据流程调度命令（integrations/cindy/daily.mjs）：从命令行入口当黑盒测。
// 假的采集命令和收口脚本（test/fixtures/daily/）只写临时目录：临时 ops.db、影子目录、知识库、看板、状态文件。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
  });
  t.cli = (mode, extra = []) => {
    const args = [DAILY, mode, ...(t.closer ? ['--closer', t.closer] : []), ...extra];
    const r = spawnSync(process.execPath, args, { env: t.env(), encoding: 'utf8', input: '{"protocol":"cindy-script/1","type":"start"}\n' });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
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
    for (const id of ['Douyin-1', 'Channels-2']) fs.writeFileSync(path.join(dir, `zz-旧-${id}.md`), `---\ntype: 平台数据\nplatform: 抖音\npost_id: ${id}\nfetched_at: "2026-11-16 09:42"\n---\n`);
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
