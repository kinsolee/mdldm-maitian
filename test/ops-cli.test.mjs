// hub ops 命令行（不需要 Ego Lite）：没有 config.json 时 accounts、tokens 能跑；只写临时目录，不碰仓库的 data/ 和 .env。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFile } from 'node:child_process';
import http from 'node:http';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HUB = path.join(ROOT, 'src', 'hub.mjs');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-cli-'));
  const env = { ...process.env, MAITIAN_CONFIG: path.join(dir, 'no-config.json'), MAITIAN_DB: path.join(dir, 'hub.db'),
    MAITIAN_OPS_DB: path.join(dir, 'ops.db'), MAITIAN_ENV_FILE: path.join(dir, '.env'), MAITIAN_OPS_DIR: path.join(dir, 'ops') };
  const hub = (...args) => spawnSync(process.execPath, [HUB, 'ops', ...args], { env, encoding: 'utf8' });
  return { dir, env, hub };
}

describe('hub ops 命令行（没有 config.json）', () => {
  test('accounts import / list / set-uid / set-cap', () => {
    const { dir, hub } = sandbox();
    let r = hub('accounts', 'import');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /新增 10/);
    r = hub('accounts', 'import');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /新增 0/);
    r = hub('accounts', 'set-uid', 'YouTube', 'UCxyz');
    assert.equal(r.status, 0, r.stderr);
    r = hub('accounts', 'set-cap', 'Bili:478358005', 'readWorks', 'true');
    assert.equal(r.status, 0, r.stderr);
    r = hub('accounts', 'list', '--json');
    assert.equal(r.status, 0, r.stderr);
    const list = JSON.parse(r.stdout);
    assert.equal(list.length, 10);
    assert.equal(list.find((a) => a.platformCode === 'YouTube').spaceName, 'kinso/YouTube/UCxyz');
    assert.equal(list.find((a) => a.id === 'Bili:478358005').capabilities.readWorks, true);
    assert.ok(fs.existsSync(path.join(dir, 'ops.db')));
    assert.ok(!fs.existsSync(path.join(dir, 'hub.db')), 'hub ops 不应加载麦田原库');
    assert.notEqual(hub('accounts', 'set-cap', 'Bili:478358005', 'fly', 'true').status, 0);
  });

  test('tokens init：生成、600、重复不覆盖、输出不含值', () => {
    const { dir, hub } = sandbox();
    const r1 = hub('tokens', 'init');
    assert.equal(r1.status, 0, r1.stderr);
    const envFile = path.join(dir, '.env');
    const text = fs.readFileSync(envFile, 'utf8');
    const values = [...text.matchAll(/^MAITIAN_\w+_TOKEN=(\w+)$/gm)].map((m) => m[1]);
    assert.equal(values.length, 3);
    assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
    const r2 = hub('tokens', 'init');
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(fs.readFileSync(envFile, 'utf8'), text);
    for (const v of values) for (const r of [r1, r2]) { assert.ok(!r.stdout.includes(v)); assert.ok(!r.stderr.includes(v)); }
  });

  test('不认识的子命令退出码 1，help 退出码 0', () => {
    const { hub } = sandbox();
    assert.equal(hub('nope').status, 1);
    const h = hub('help');
    assert.equal(h.status, 0);
    assert.match(h.stdout, /tokens init/);
  });
});

describe('hub ops login 参数校验（空库，不应走到 runner）', () => {
  for (const [label, args, why] of [
    ['--check 带位置参数', ['login', '--check', 'Douyin', '--json'], /--check 不接位置参数/],
    ['--check --platform 空串', ['login', '--check', '--platform', '', '--json'], /--platform/],
    ['扫码登录带 --platform', ['login', 'Douyin', '--platform', 'X', '--json'], /--platform/],
  ]) {
    test(`${label}：退出码 1，stderr 有说明和用法，没调用 checkLogins/scanLogin`, () => {
      const { hub } = sandbox();
      const r = hub(...args);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, why);
      assert.match(r.stderr, /用法/);
      assert.equal(r.stdout, '', '走到 checkLogins 时 --json 会在 stdout 打出结果');
      assert.doesNotMatch(r.stderr, /没有这个账号|出错/, '走到 scanLogin 会报没有这个账号');
    });
  }

  test('用法写明 --check 不接位置参数，平台用 --platform', () => {
    const { hub } = sandbox();
    assert.match(hub('help').stdout, /--check 不接位置参数，平台用 --platform/);
  });

  test('合法写法 login --check 在空库上照常跑完（退出码 0）', () => {
    const { hub } = sandbox();
    const r = hub('login', '--check', '--json');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).rows, []);
  });
});

describe('默认飞书提醒（defaultNotify）', () => {
  const LOGIN = pathToFileURL(path.join(ROOT, 'src', 'ops', 'login.mjs')).href;
  const run = (env) => promisify(execFile)(process.execPath, ['--input-type=module', '-e',
    `const { defaultNotify } = await import(${JSON.stringify(LOGIN)}); console.error('RET=' + await defaultNotify('❌ 抖音账号掉线 | Douyin:1\\n详情'));`],
    { env: { ...process.env, ...env } });

  // 假飞书 webhook：按队列逐次回应（'ok' → code 0，'reject' → code 19001，'500' → HTTP 500，'nocode' → 200 空对象）
  async function fakeFeishu() {
    const queue = [], got = [];
    const server = http.createServer((req, res) => {
      let b = ''; req.on('data', (d) => { b += d; });
      req.on('end', () => {
        got.push(JSON.parse(b).msg_type);
        const m = queue.shift() ?? 'ok';
        if (m === '500') { res.statusCode = 500; return res.end('{"code":0}'); }
        res.end(m === 'reject' ? '{"code":19001,"msg":"bad"}' : m === 'nocode' ? '{}' : '{"code":0}');
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { queue, got, url: `http://127.0.0.1:${server.address().port}/hook`, close: () => server.close() };
  }
  const cfgFor = (webhook) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-notify-'));
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ feishuWebhook: webhook, rootPath: dir }));
    return cfg;
  };

  for (const [label, replies, sent, types] of [
    ['code 0', ['ok'], true, ['interactive']],
    ['没有 code 字段的 2xx', ['nocode'], true, ['interactive']],
    ['卡片被拒、文字发出', ['reject', 'ok'], true, ['interactive', 'text']],
    ['卡片和文字都被拒（code 非 0）', ['reject', 'reject'], false, ['interactive', 'text']],
    ['HTTP 500', ['500'], false, ['interactive']],
  ]) {
    test(`${label}：返回 ${sent}，stdout 为空，不打印 webhook 地址`, async () => {
      const f = await fakeFeishu();
      f.queue.push(...replies);
      try {
        const { stdout, stderr } = await run({ MAITIAN_CONFIG: cfgFor(f.url) });
        assert.equal(stdout, '');
        assert.match(stderr, new RegExp(`RET=${sent}`));
        assert.deepEqual(f.got, types);
        assert.ok(!stderr.includes(f.url));
      } finally { f.close(); }
    });
  }

  test('连不上的地址：返回 false，stdout 为空', async () => {
    const url = 'http://127.0.0.1:1/hook';
    const { stdout, stderr } = await run({ MAITIAN_CONFIG: cfgFor(url) });
    assert.equal(stdout, '');
    assert.match(stderr, /RET=false/);
    assert.match(stderr, /没发出/);
    assert.ok(!stderr.includes(url));
  });

  test('检测掉线：只有真发出那次写 alertSentAt，失败后下一次检测还会再发', async () => {
    const CHECK = path.join(ROOT, 'test', 'fixtures', 'ops', 'notify-check.mjs');
    const SEED = path.join(ROOT, 'src', 'ops', 'accounts.seed.json');
    const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-notify-')), 'ops.db');
    const f = await fakeFeishu();
    const T0 = Date.parse('2026-11-19T00:00:00Z');
    const check = async (cfg, at) => {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [CHECK, db, SEED, String(at)], { env: { ...process.env, MAITIAN_CONFIG: cfg } });
      assert.equal(stdout, '');
      return JSON.parse(stderr.match(/^@@ALERT (.*)$/m)[1]);
    };
    try {
      assert.equal(await check(cfgFor('http://127.0.0.1:1/hook'), T0), null);       // 连不上
      f.queue.push('500');
      assert.equal(await check(cfgFor(f.url), T0 + 60_000), null);                 // HTTP 500
      f.queue.push('reject', 'reject');
      assert.equal(await check(cfgFor(f.url), T0 + 120_000), null);                // code 非 0
      f.queue.push('ok');
      assert.equal(await check(cfgFor(f.url), T0 + 180_000), new Date(T0 + 180_000).toISOString());   // 真发出
      assert.deepEqual(f.got, ['interactive', 'interactive', 'text', 'interactive']);
      assert.equal(await check(cfgFor(f.url), T0 + 240_000), new Date(T0 + 180_000).toISOString());   // 6 小时内不再发
      assert.equal(f.got.length, 4);
    } finally { f.close(); }
  });

  test('没有 config.json、或没配 webhook：没发，返回 false，stdout 为空', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-notify-'));
    let r = await run({ MAITIAN_CONFIG: path.join(dir, 'none.json') });
    assert.equal(r.stdout, ''); assert.match(r.stderr, /RET=false/);
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ rootPath: dir }));
    r = await run({ MAITIAN_CONFIG: cfg });
    assert.equal(r.stdout, ''); assert.match(r.stderr, /RET=false/);
  });
});
