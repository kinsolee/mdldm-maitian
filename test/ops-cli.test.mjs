// 账号层命令行：真的起 node src/ops/cli.mjs 子进程（不需要 Ego Lite，不开页面、不发飞书）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/ops/cli.mjs', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-cli-'));
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, MAITIAN_OPS_DIR: dir } });

test('seed、list 在 MAITIAN_OPS_DIR 下建 ops.db', () => {
  const s = run('accounts', 'seed');
  assert.equal(s.status, 0, s.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'ops.db')));
  const l = run('accounts', 'list');
  assert.equal(l.status, 0);
  assert.equal(l.stdout.trim().split('\n').length, 10);
  assert.equal(run('accounts', 'seed').status, 0);
});

test('点名 Instagram 检测：退出码 2，不加载 runner', () => {
  const r = run('login', '--check', 'instagram');
  assert.equal(r.status, 2);
  assert.match(r.stdout, /out-of-scope/);
});

test('不认识的子命令打印用法，退出码 2；help 退出码 0', () => {
  const r = run('nope');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /login --check/);
  assert.equal(run('help').status, 0);
});
