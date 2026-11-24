#!/usr/bin/env node
// 假的采集命令（代替 node src/ops/cli.mjs）：按 DAILY_FAKE 场景文件给每个平台一个结果，写 collect_runs 和影子导出。
// 每次调用把参数追加到 DAILY_FAKE_LOG（一行一个 JSON）。不碰任何真实数据。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const scenario = JSON.parse(fs.readFileSync(process.env.DAILY_FAKE, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.DAILY_FAKE_LOG, `${JSON.stringify({ cmd: 'collect', args })}\n`);
if (scenario.sleepMs) await new Promise((ok) => setTimeout(ok, scenario.sleepMs));
const now = new Date(process.env.MAITIAN_DAILY_NOW).toISOString();
const ALL = ['Douyin', 'XiaoHongShu', 'Bili', 'Channels'];
const [group] = args;

const db = new DatabaseSync(process.env.MAITIAN_OPS_DB);
const dir = process.env.MAITIAN_OPS_SHADOW_DIR;
const day = new Date(Date.parse(now) + 8 * 3600_000).toISOString().slice(0, 10).replaceAll('-', '');
const writeExport = () => {
  const okNow = new Set(db.prepare("SELECT DISTINCT platformCode p FROM collect_runs WHERE result = 'ok'").all().map((r) => r.p));
  fs.mkdirSync(dir, { recursive: true });
  const posts = scenario.exportBroken ? { error: '假的导出坏了' } : scenario.posts.filter((p) => okNow.has(p.platform));
  fs.writeFileSync(path.join(dir, `posts-${day}.json`), JSON.stringify(posts));
  fs.writeFileSync(path.join(dir, `accounts-${day}.json`), JSON.stringify([...okNow].map((p) => ({ uid: p, fans: 1, daily: [] }))));
  for (const k of ['posts', 'accounts']) fs.utimesSync(path.join(dir, `${k}-${day}.json`), new Date(now), new Date(now));   // 测试的时钟是假的，文件时间跟着它
};

if (group === 'export') { writeExport(); console.log(JSON.stringify({ exitCode: 0 })); process.exit(0); }
if (scenario.collectBroken) { console.log(JSON.stringify({ error: 'collect failed' })); process.exit(1); }

const platforms = args.filter((a) => !a.startsWith('--') && a !== 'collect');
const rows = [];
for (const p of platforms.length ? platforms : ALL) {
  const r = scenario.collect?.[p] ?? 'ok';
  const [result, reason] = r === 'ok' ? ['ok', null] : r === 'out' ? ['out', 'logged-out'] : r === 'failed' ? ['failed', null] : r === 'uid-mismatch' ? ['uid-mismatch', null] : ['skipped', r];
  db.prepare('INSERT INTO collect_runs (runId, platformCode, uid, startedAt, finishedAt, result, reason, days) VALUES (?, ?, ?, ?, ?, ?, ?, 30)')
    .run('fake', p, 'u', now, now, result, reason);
  rows.push({ id: `${p}:u`, platformCode: p, result, ...(reason ? { reason } : {}), ...(result === 'failed' ? { message: '假的采集失败' } : {}), ...(reason === 'no-account' ? { message: `表里没有 ${p} 的账号，先 hub ops accounts import` } : {}) });
}
if (args.includes('--export')) writeExport();
const exitCode = rows.some((r) => r.result === 'uid-mismatch') ? 2 : rows.every((r) => r.result === 'ok') ? 0 : rows.some((r) => r.result === 'ok') ? 3 : 1;
console.log(JSON.stringify({ exitCode, runId: 'fake', rows, followersSync: null }));
process.exit(exitCode);
