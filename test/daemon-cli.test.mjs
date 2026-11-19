// sync.mjs 命令行和 hub ops engage 转发：临时库、临时锁、没有 config.json；能力位全关，所以不会加载适配器、不起 Ego、不发网络请求。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HUB = path.join(ROOT, 'src', 'hub.mjs');
const SYNC = path.join(ROOT, 'src', 'daemon', 'sync.mjs');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engage-cli-'));
  const env = { ...process.env, MAITIAN_CONFIG: path.join(dir, 'no-config.json'), MAITIAN_DB: path.join(dir, 'hub.db'), MAITIAN_OPS_DB: path.join(dir, 'ops.db'),
    MAITIAN_ENV_FILE: path.join(dir, '.env'), MAITIAN_OPS_DIR: path.join(dir, 'ops'), MAITIAN_ENGAGE_LOCK: path.join(dir, 'engage-sync.lock') };
  const run = (file, ...args) => spawnSync(process.execPath, [file, ...args], { env, encoding: 'utf8' });
  return { dir, env, lock: env.MAITIAN_ENGAGE_LOCK, sync: (...a) => run(SYNC, ...a), hub: (...a) => run(HUB, 'ops', ...a) };
}

describe('sync.mjs 命令行', () => {
  test('参数错退出 1', () => {
    const { sync, hub } = sandbox();
    assert.equal(sync().status, 1, '没写 --once');
    assert.equal(sync('--once', '--kind', 'likes').status, 1);
    assert.equal(sync('--once', '--platform', 'Instagram').status, 1);
    assert.equal(sync('--once', '--nope').status, 1);
    assert.equal(hub('engage', 'sync', '--once', '--kind', 'x').status, 1);
  });

  test('跑一轮退出 0（--json 的 stdout 是合法 JSON）；拿不到轮锁退出 5', () => {
    const { sync, hub, lock } = sandbox();
    assert.equal(hub('accounts', 'import').status, 0);
    let r = sync('--once', '--json');
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ran, true);
    assert.deepEqual(out.jobs, [], '能力位全关：一个都不抓');
    assert.match(r.stderr, /readComments 关着/);
    r = hub('engage', 'sync', '--once', '--platform', 'Douyin', '--kind', 'dms', '--force');
    assert.equal(r.status, 0, r.stderr);
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    r = sync('--once');
    assert.equal(r.status, 5);
    assert.match(r.stderr, /已有一轮在跑/);
    assert.equal(hub('engage', 'sync', '--once').status, 5);
    assert.ok(fs.existsSync(lock), '别人的锁不动');
  });

  test('hub ops engage status', () => {
    const { hub } = sandbox();
    assert.equal(hub('accounts', 'import').status, 0);
    let r = hub('engage', 'status', '--json');
    assert.equal(r.status, 0, r.stderr);
    const st = JSON.parse(r.stdout);
    assert.deepEqual(st.platforms.map((p) => p.platformCode), ['Douyin', 'Channels', 'XiaoHongShu', 'Bili']);
    assert.equal(st.unhandledEvents, 0);
    r = hub('engage', 'status');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Douyin +comments +还没跑过/);
    assert.match(hub('help').stdout, /engage sync --once/);
  });
});
