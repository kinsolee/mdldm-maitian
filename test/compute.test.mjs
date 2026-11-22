// 谷歌算力面板：假 colab CLI、假 ego runner、临时 studio.db。
// 覆盖 auth_required、unconfigured、ego 各种失败保留旧快照、单飞锁、stop 的 localOnly/sameOrigin 拒绝、状态灯判定。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readColab, stopColab, parseUsage, parseSessions, AUTH_HINT } from '../src/compute/colab.mjs';
import { readGemini, geminiKey, GEMINI_HINT } from '../src/compute/gemini.mjs';
import { createComputeService, computeLight, runEgo, EGO_PROVIDERS } from '../src/compute/service.mjs';
import { openStudio } from '../src/compute/store.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIX = path.join(ROOT, 'test', 'fixtures', 'compute');
const COLAB = path.join(FIX, 'fake-colab.mjs'), EGO = path.join(FIX, 'fake-ego-cli.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'compute-'));
const dbIn = (d) => path.join(d, 'studio.db');
const withEnv = async (vars, fn) => {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v); }
};
const OK_EGO = async () => ({ ok: true, result: { flow: { status: 'ok', metrics: { credits: 25031 } }, flowmusic: { status: 'ok', metrics: { credits: 30560 } }, kaggle: { status: 'ok', metrics: { gpu: { leftHours: 60 } }, sessions: [] }, pics: { status: 'ok', metrics: { signedIn: true } }, vids: { status: 'ok', metrics: { signedIn: true } } } });
const svcWith = (o = {}) => createComputeService({ dbFile: dbIn(tmp()), colab: async () => ({ status: 'ok', metrics: { balance: 1, assignments: 0 }, sessions: [] }), gemini: async () => ({ status: 'unconfigured', error: GEMINI_HINT }), ego: OK_EGO, ...o });

describe('Colab CLI 解析和降级', () => {
  test('解析 usage / sessions；name 是 ? 的不能一键停', () => {
    assert.deepEqual(parseUsage('Current balance: 2497.39 compute units\nUsage rate: 1.76/hr\nActive assignments: 1'), { balance: 2497.39, ratePerHour: 1.76, assignments: 1 });
    const s = parseSessions('[gpu-1] m-s-abc | Hardware: T4 | Shape: Standard | Variant: GPU\n[?] m-s-x | Hardware: CPU | Shape: Standard | Variant: DEFAULT\n[colab] No active sessions');
    assert.equal(s.length, 2);
    assert.deepEqual([s[0].id, s[0].hardware, s[0].stoppable, s[1].stoppable], ['gpu-1', 'T4', true, false]);
  });

  test('没授权：auth_required + 文案，不回显授权网址', async () => {
    await withEnv({ FAKE_COLAB_MODE: 'auth' }, async () => {
      const r = await readColab({ bin: COLAB });
      assert.equal(r.status, 'auth_required');
      assert.equal(r.error, AUTH_HINT);
      assert.ok(!JSON.stringify(r).includes('accounts.example'));
      const st = await stopColab('gpu-1', { bin: COLAB });
      assert.equal(st.ok, false);
    });
  });

  test('正常 / 有会话 / 失败 / 没装 CLI', async () => {
    await withEnv({ FAKE_COLAB_MODE: 'ok' }, async () => {
      const r = await readColab({ bin: COLAB });
      assert.equal(r.status, 'ok'); assert.equal(r.metrics.balance, 2497.39); assert.deepEqual(r.sessions, []);
    });
    await withEnv({ FAKE_COLAB_MODE: 'active' }, async () => {
      const r = await readColab({ bin: COLAB });
      assert.equal(r.sessions.length, 2); assert.equal(r.metrics.assignments, 1);
    });
    await withEnv({ FAKE_COLAB_MODE: 'fail' }, async () => {
      const r = await readColab({ bin: COLAB });
      assert.equal(r.status, 'error'); assert.ok(!r.error.includes('secret-ish'), 'stderr 不外露');
    });
    const r = await readColab({ bin: path.join(tmp(), 'nope') });
    assert.equal(r.status, 'error'); assert.match(r.error, /没找到 colab CLI/);
  });

  test('stop：会话名校验，调用 stop --session', async () => {
    const log = path.join(tmp(), 'log');
    await withEnv({ FAKE_COLAB_MODE: 'active', FAKE_COLAB_LOG: log }, async () => {
      assert.equal((await stopColab('bad name;rm', { bin: COLAB })).ok, false);
      assert.equal(fs.existsSync(log), false, '名字不对就不调 CLI');
      assert.equal((await stopColab('gpu-1', { bin: COLAB })).ok, true);
      assert.equal(fs.readFileSync(log, 'utf8').trim(), 'stop --session gpu-1');
    });
  });
});

describe('Gemini 探活', () => {
  test('没配密钥：unconfigured，不发请求', async () => {
    const r = await readGemini({ key: '' });
    assert.deepEqual(r, { status: 'unconfigured', error: GEMINI_HINT });
    const d = tmp(), f = path.join(d, '.env');
    fs.writeFileSync(f, 'OTHER=1\n');
    assert.equal(geminiKey({ env: {}, file: f }), '');
    fs.writeFileSync(f, 'export GEMINI_API_KEY="abc"\n');
    assert.equal(geminiKey({ env: {}, file: f }), 'abc');
  });

  test('密钥只走请求头；被拒时错误里没有密钥', async () => {
    let seen;
    const srv = http.createServer((req, res) => { seen = { url: req.url, key: req.headers['x-goog-api-key'] }; res.writeHead(seen.key === 'good-key' ? 200 : 403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ models: [{ name: 'models/gemini-3-pro' }, { name: 'models/embed' }] })); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      await withEnv({ MAITIAN_GEMINI_BASE: `http://127.0.0.1:${srv.address().port}` }, async () => {
        const ok = await readGemini({ key: 'good-key' });
        assert.equal(ok.status, 'ok'); assert.equal(ok.metrics.models, 2); assert.deepEqual(ok.metrics.sample, ['gemini-3-pro']);
        assert.ok(!seen.url.includes('good-key'));
        const bad = await readGemini({ key: 'bad-key' });
        assert.equal(bad.status, 'error'); assert.ok(!JSON.stringify(bad).includes('bad-key'));
      });
    } finally { srv.close(); }
  });
});

describe('状态灯', () => {
  const v = (colab, kaggle) => ({ colab: { ok: colab }, kaggle: { ok: kaggle } });
  test('Colab 或 Kaggle 有会话 → warn；读到且空闲 → ok；都没读过 → idle', () => {
    assert.equal(computeLight(v(null, null)).level, 'idle');
    assert.equal(computeLight(v({ sessions: [], metrics: { assignments: 0 } }, null)).level, 'ok');
    assert.equal(computeLight(v(null, { sessions: [] })).level, 'ok');
    assert.equal(computeLight(v({ sessions: [{ id: 'a' }] }, null)).level, 'warn');
    assert.equal(computeLight(v({ sessions: [], metrics: { assignments: 1 } }, null)).level, 'warn', 'sessions 空但有 assignment 也算');
    const both = computeLight(v({ sessions: [{ id: 'a' }] }, { sessions: [{ id: 'k' }] }));
    assert.equal(both.level, 'warn'); assert.match(both.text, /Colab、Kaggle/);
  });

  test('auth_required 不算读到：灯保持灰', async () => {
    const s = svcWith({ colab: async () => ({ status: 'auth_required', error: AUTH_HINT }) });
    try {
      await s.refresh('fast').promise;
      const st = s.status({ poll: false });
      assert.equal(st.providers.colab.last.status, 'auth_required');
      assert.equal(st.providers.colab.last.error, AUTH_HINT);
      assert.equal(st.providers.gemini.last.status, 'unconfigured');
      assert.equal(st.light.level, 'idle');
    } finally { s.close(); }
  });
});

describe('服务：单飞、防抖、ego 失败保留旧快照', () => {
  test('单飞锁：刷新中再点不再起，结束后能再起', async () => {
    let n = 0, release;
    const s = svcWith({ ego: () => { n++; return new Promise((r) => { release = () => r({ ok: true, result: {} }); }); } });
    try {
      const a = s.refresh('all'), b = s.refresh('all'), c = s.refresh('fast');
      assert.equal(a.started, true); assert.equal(b.started, false); assert.equal(c.started, false);
      assert.equal(s.status({ poll: false }).refreshing.scope, 'all');
      await new Promise((r) => setImmediate(r));
      assert.equal(n, 1);
      release(); await a.promise;
      assert.equal(s.status({ poll: false }).refreshing, null);
      const d = s.refresh('fast'); assert.equal(d.started, true); await d.promise;
      assert.throws(() => s.refresh('nope'));
    } finally { s.close(); }
  });

  test('status 秒回不等 Colab；15 秒内不重复读；peek 不读', async () => {
    let n = 0, t = 1_000_000;
    const s = svcWith({ now: () => t, colab: () => { n++; return new Promise((r) => setTimeout(() => r({ status: 'ok', sessions: [] }), 50)); } });
    try {
      s.status({ poll: false }); assert.equal(n, 0, 'peek 不触发');
      const t0 = Date.now(); s.status(); assert.ok(Date.now() - t0 < 30, '不阻塞'); await Promise.resolve(); await Promise.resolve(); assert.equal(n, 1);
      s.status(); assert.equal(n, 1, '在读的时候不再起');
      await s.idle();
      t += 5_000; s.status(); assert.equal(n, 1, '防抖内');
      t += 15_000; s.status(); await Promise.resolve(); await Promise.resolve(); assert.equal(n, 2);
      await s.idle();
    } finally { s.close(); }
  });

  for (const mode of ['busy', 'user-controlled', 'timeout']) {
    test(`ego ${mode}：五项记失败原因，最近一次成功的数字还在`, async () => {
      const d = tmp();
      await withEnv({ MAITIAN_COMPUTE_EGO_CLI: EGO }, async () => {
        const s = createComputeService({ dbFile: dbIn(d), colab: async () => ({ status: 'ok', sessions: [] }), gemini: async () => ({ status: 'unconfigured' }), ego: () => runEgo({ timeoutMs: 5000 }) });
        try {
          await withEnv({ FAKE_EGO_MODE: 'ok' }, () => s.refresh('all').promise);
          await withEnv({ FAKE_EGO_MODE: mode }, () => s.refresh('all').promise);
          const st = s.status({ poll: false });
          for (const p of EGO_PROVIDERS) {
            assert.equal(st.providers[p].last.status, mode === 'user-controlled' ? 'user_controlled' : mode, p);
            assert.ok(st.providers[p].last.error, `${p} 有原因`);
            assert.equal(st.providers[p].ok.status, 'ok', `${p} 旧快照还在`);
          }
          assert.equal(st.providers.flow.ok.metrics.credits, 25031);
          assert.equal(st.providers.kaggle.ok.metrics.gpu.leftHours, 60);
        } finally { s.close(); }
      });
    });
  }

  test('ego 部分失败：登录失效的那项单独标，漏采的记「这次没采到」', async () => {
    await withEnv({ MAITIAN_COMPUTE_EGO_CLI: EGO, FAKE_EGO_MODE: 'partial' }, async () => {
      const s = svcWith({ ego: () => runEgo({ timeoutMs: 5000 }) });
      try {
        await s.refresh('all').promise;
        const st = s.status({ poll: false });
        assert.equal(st.providers.flow.last.status, 'logged_out');
        assert.equal(st.providers.vids.last.error, '这次没采到');
        assert.equal(st.providers.kaggle.last.status, 'ok');
      } finally { s.close(); }
    });
  });

  test('runEgo 传只读 space，Kaggle 有会话时灯变橙', async () => {
    const log = path.join(tmp(), 'ego.log');
    await withEnv({ MAITIAN_COMPUTE_EGO_CLI: EGO, FAKE_EGO_MODE: 'kaggle-active', FAKE_EGO_LOG: log }, async () => {
      const s = svcWith({ ego: () => runEgo({ timeoutMs: 5000 }) });
      try {
        await s.refresh('all').promise;
        assert.match(fs.readFileSync(log, 'utf8'), /--space kinso\/google-compute\/ultra --timeout-ms 5000 .*ego-collect\.js/);
        assert.equal(s.status({ poll: false }).light.level, 'warn');
      } finally { s.close(); }
    });
  });

  test('stopColab：只停最近读到、本机有记录的会话；停完回读', async () => {
    let stopped = null, reads = 0;
    const s = svcWith({
      colab: async () => { reads++; return stopped ? { status: 'ok', sessions: [] } : { status: 'ok', sessions: [{ id: 'gpu-1', stoppable: true }, { id: '?', stoppable: false }] }; },
      stop: async (id) => { stopped = id; return { ok: true }; },
    });
    try {
      await s.refresh('fast').promise;
      assert.equal((await s.stopColab('nope')).code, 404);
      assert.equal((await s.stopColab('?')).code, 400);
      assert.equal(stopped, null);
      const before = reads;
      assert.deepEqual(await s.stopColab('gpu-1'), { ok: true });
      assert.equal(stopped, 'gpu-1'); assert.equal(reads, before + 1, '停完回读一次');
      assert.equal(s.status({ poll: false }).light.level, 'ok');
    } finally { s.close(); }
  });

  test('studio.db：表结构、失败也记、旧成功不动', () => {
    const st = openStudio(dbIn(tmp()));
    try {
      const cols = st.db.prepare('PRAGMA table_info(google_compute_snapshots)').all().map((c) => c.name);
      for (const c of ['provider', 'status', 'metrics_json', 'active_sessions_json', 'error', 'fetched_at']) assert.ok(cols.includes(c), c);
      st.record('flow', { status: 'ok', metrics: { credits: 1 } });
      st.record('flow', { status: 'busy', error: 'x' });
      const l = st.latest('flow');
      assert.equal(l.last.status, 'busy'); assert.equal(l.ok.metrics.credits, 1);
      assert.throws(() => st.record('evil', { status: 'ok' }));
    } finally { st.close(); }
  });
});

describe('网页接口（起真的网页服务，假 colab）', () => {
  async function serve(run) {
    const dir = tmp(), port = 20000 + Math.floor(Math.random() * 20000), log = path.join(dir, 'colab.log');
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ web: { port, key: 'test-key' }, rootPath: dir }));
    fs.writeFileSync(path.join(dir, '.env'), '');
    const env = { ...process.env, MAITIAN_CONFIG: path.join(dir, 'config.json'), MAITIAN_DB: path.join(dir, 'hub.db'), MAITIAN_OPS_DB: path.join(dir, 'ops.db'), CINDY_ENV_FILE: path.join(dir, '.env'),
      MAITIAN_ENV_FILE: path.join(dir, '.env'), MAITIAN_STUDIO_DB: dbIn(dir), MAITIAN_COLAB_BIN: COLAB, MAITIAN_COMPUTE_EGO_CLI: EGO, FAKE_COLAB_MODE: 'active', FAKE_COLAB_LOG: log };
    delete env.GEMINI_API_KEY;
    const p = spawn(process.execPath, ['--input-type=module', '-e', `const { startWeb } = await import(${JSON.stringify(path.join(ROOT, 'src', 'web.mjs'))}); startWeb();`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise((ok, bad) => { p.stdout.on('data', (d) => /麦田网页/.test(d) && ok()); p.on('exit', (c) => bad(new Error(`服务退出 ${c}`))); setTimeout(() => bad(new Error('服务没起来')), 10000); });
      const req = (method, url, headers = {}, body) => new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: { cookie: 'mt_key=test-key', host: `localhost:${port}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
          let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b, json: (() => { try { return JSON.parse(b); } catch { return null; } })() }));
        });
        r.on('error', reject); r.end(body);
      });
      await run({ req, port, log });
    } finally { p.kill(); }
  }
  const until = async (fn, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } throw new Error('等不到'); };

  test('页面、状态、刷新同源、停机只给本机同源', async () => {
    await serve(async ({ req, port, log }) => {
      const origin = { origin: `http://localhost:${port}` };
      const page = await req('GET', '/compute');
      assert.equal(page.status, 200); assert.match(page.body, /谷歌算力/);

      const st0 = await req('GET', '/api/compute/status');
      assert.equal(st0.status, 200); assert.equal(st0.json.local, true);
      assert.equal(st0.json.providers.gemini.last, null);
      assert.equal((await req('GET', '/api/compute/status', { host: 'maitian.example.com' })).json.local, false);
      assert.equal((await req('POST', '/api/compute/status', origin)).status, 405);

      // 刷新：要同源
      assert.equal((await req('POST', '/api/compute/refresh?scope=fast')).status, 403);
      assert.equal((await req('POST', '/api/compute/refresh?scope=fast', { origin: 'https://evil.example' })).status, 403);
      assert.equal((await req('POST', '/api/compute/refresh?scope=bad', origin)).status, 400);
      const rf = await req('POST', '/api/compute/refresh?scope=fast', origin);
      assert.ok(rf.status === 202 || rf.status === 409);
      const st = await until(async () => { const s = (await req('GET', '/api/compute/status?peek=1')).json; return !s.refreshing && s.providers.gemini.last && s; });
      assert.equal(st.providers.gemini.last.status, 'unconfigured');
      assert.equal(st.providers.colab.ok.sessions[0].id, 'gpu-1');
      assert.equal(st.light.level, 'warn');

      // 停机：隧道、跨站、没 Origin、代理头一律 403，不调 CLI
      const body = JSON.stringify({ id: 'gpu-1' });
      for (const h of [{}, { origin: 'https://evil.example' }, { host: 'maitian.example.com', origin: 'http://maitian.example.com' }, { ...origin, 'cf-connecting-ip': '1.2.3.4' }, { ...origin, 'x-forwarded-for': '1.2.3.4' }, { ...origin, via: '1.1 proxy' }]) {
        assert.equal((await req('POST', '/api/compute/colab/stop', h, body)).status, 403, JSON.stringify(h));
      }
      assert.ok(!fs.readFileSync(log, 'utf8').includes('stop'), '拒绝时没调 colab stop');
      assert.equal((await req('GET', '/api/compute/colab/stop', origin)).status, 405);
      assert.equal((await req('POST', '/api/compute/colab/stop', origin, '{bad')).status, 400);
      assert.equal((await req('POST', '/api/compute/colab/stop', origin, JSON.stringify({ id: 'm-s-orphan' }))).status, 404);
      const ok = await req('POST', '/api/compute/colab/stop', origin, body);
      assert.equal(ok.status, 200, ok.body);
      assert.match(fs.readFileSync(log, 'utf8'), /stop --session gpu-1/);
    });
  });
});
