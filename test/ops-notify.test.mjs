// 掉线提醒走默认的 feishu notify（G-B8）：子进程、临时 MAITIAN_CONFIG，本机起一个假 webhook，不发真实消息。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openOpsDb, getAccount } from '../src/ops/store.mjs';

const HARNESS = fileURLToPath(new URL('./fixtures/ops/notify-harness.mjs', import.meta.url));
const posts = [];
const server = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { posts.push(JSON.parse(b)); res.end('{"code":0}'); }); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());

// 跑一次掉线分支（异步起子进程：假 webhook 在本进程里，不能用 spawnSync 卡住事件循环）
async function runOut(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-notify-')), cfg = path.join(dir, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify(config));
  const child = spawn(process.execPath, [HARNESS], { env: { ...process.env, MAITIAN_OPS_DIR: dir, MAITIAN_CONFIG: cfg } });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const code = await new Promise((r) => child.on('close', r));
  const db = openOpsDb(dir); const acct = getAccount(db, 'Douyin'); db.close();
  return { code, lines: stdout.split('\n').filter(Boolean), stderr, acct };
}

test('G-B8 没有 feishuWebhook：不算发出，不记 lastAlertAt，stderr 说明；stdout 只有 JSON 行', async () => {
  const r = await runOut({});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.acct.loginState, 'out');
  assert.equal(r.acct.lastAlertAt, null);
  assert.match(r.stderr, /没有配置飞书 webhook/);
  assert.equal(r.lines.length, 1, r.lines.join('\n'));
  assert.equal(JSON.parse(r.lines[0]).alert, 'not-sent');
  assert.equal(posts.length, 0);
});

test('G-B8 有 webhook：发出卡片、记 lastAlertAt；quiet，stdout 只有 JSON 行、没有「[飞书]」', async () => {
  const r = await runOut({ feishuWebhook: `http://127.0.0.1:${server.address().port}/hook` });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].msg_type, 'interactive');
  assert.ok(r.acct.lastAlertAt);
  assert.equal(r.lines.length, 1, r.lines.join('\n'));
  assert.doesNotMatch(r.lines.join('\n'), /\[飞书\]/);
  assert.equal(JSON.parse(r.lines[0]).alert, 'sent');
});
