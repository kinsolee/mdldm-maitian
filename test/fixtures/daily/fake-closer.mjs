#!/usr/bin/env node
// 假的收口脚本（代替 ~/.hermes/scripts/content-data-daily.sh）：参数和真脚本一样，按 DAILY_FAKE 场景文件的 closer 段决定每一步成败。
// 笔记那步和真的 backfill.py 一样不幂等：按 post_id 找第一篇笔记（不看平台），更新 fetched_at 并在正文追加一行抓取记录。
// 视频号分日、公众号写进临时知识库，看板写临时 data.js（mtime 设成 MAITIAN_DAILY_NOW），飞书只记成败。
// 每次调用把参数和看板拿到的平台追加到 DAILY_FAKE_LOG。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const scenario = JSON.parse(fs.readFileSync(process.env.DAILY_FAKE, 'utf8'));
const c = scenario.closer ?? {};
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i < 0 ? null : args[i + 1]; };
const has = (k) => args.includes(k);
const now = new Date(process.env.MAITIAN_DAILY_NOW);
const stamp = new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
const vault = opt('--vault');
const dir = path.join(vault, '10.个人IP', '数据', '平台数据', '2026年');
const CN = { Douyin: '抖音', XiaoHongShu: '小红书', Bili: '哔哩哔哩', Channels: '视频号' };
const posts = JSON.parse(fs.readFileSync(opt('--posts'), 'utf8'));
const dashPosts = JSON.parse(fs.readFileSync(opt('--dashboard-posts') ?? opt('--posts'), 'utf8'));
fs.appendFileSync(process.env.DAILY_FAKE_LOG, `${JSON.stringify({ cmd: 'closer', args, posts: posts.map((p) => p.postId), dashboardPlatforms: [...new Set(dashPosts.map((p) => p.platform))].sort() })}\n`);

fs.mkdirSync(dir, { recursive: true });
const readNote = (file) => {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(fs.readFileSync(path.join(dir, file), 'utf8'));
  return { fm: Object.fromEntries(m[1].split('\n').map((l) => /^(\w+): (.*)$/.exec(l)).filter(Boolean).map((x) => [x[1], x[2]])), body: m[2] };
};
const writeNote = (file, fm, body = '') => fs.writeFileSync(path.join(dir, file), `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}`);
const notes = () => fs.readdirSync(dir).filter((f) => f.endsWith('.md'));

if (c.backfill === 'fail') { console.log(JSON.stringify({ ok: false, step: 'backfill', errors: ['backfill.py 失败: 假的'] })); process.exit(3); }
const limit = c.backfill === 'partial' ? Math.ceil(posts.length / 2) : posts.length;
for (const p of posts.slice(0, limit)) {
  const existing = notes().find((f) => readNote(f).fm.post_id === p.postId);
  if (existing) { const n = readNote(existing); writeNote(existing, { ...n.fm, fetched_at: `"${stamp}"` }, `${n.body}| ${stamp} |\n`); }
  else writeNote(`${p.postId}.md`, { type: '平台数据', platform: CN[p.platform], post_id: p.postId, fetched_at: `"${stamp}"` }, `| ${stamp} |\n`);
}
if (c.backfill === 'partial') { console.error('backfill.py 写到一半出错'); console.log(JSON.stringify({ ok: false, step: 'backfill', errors: ['backfill.py 失败: 写到一半'] })); process.exit(3); }

if (c.hang) {
  // 模拟卡住：起一个孙进程（记下 pid），自己也不退出，等调度命令按超时杀整棵进程树
  const g = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  fs.writeFileSync(c.hang, String(g.pid));
  setInterval(() => {}, 1000);
} else finish();

function finish() {
  if (c.syncOkDuringRun) {
    // 模拟：本轮开始之后、视频号分日发现未登录之前，守护进程的评论私信同步成功了一次
    const db = new DatabaseSync(process.env.MAITIAN_OPS_DB);
    const at = new Date(now.getTime() + 1).toISOString();
    db.prepare("INSERT INTO sync_jobs (id, platformCode, kind, trigger, status, requestedAt, startedAt, finishedAt) VALUES ('mid', 'Channels', 'comments', 'schedule', 'ok', ?, ?, ?)").run(at, at, at);
    db.close();
  }
  let channels;
  if (has('--skip-channels')) channels = { skipped: 'skipped' };
  else if (c.channels === 'login') channels = { skipped: 'Ego: LOGIN: Ego 里视频号助手未登录，需要在 Ego 里扫码登录 channels.weixin.qq.com' };
  else if (c.channels === 'fail') channels = { skipped: 'channels_backfill.py: 假的出错' };
  else {
    const updated = notes().filter((f) => readNote(f).fm.platform === '视频号');
    for (const f of updated) { const n = readNote(f); writeNote(f, { ...n.fm, daily_fetched_at: `"${stamp}"` }, n.body); }
    channels = { updated, unmatched: [] };
  }

  const errors = [];
  let mp;
  if (has('--skip-mp')) mp = { ok: false, error: 'skipped' };
  else if (c.mp === 'login') { mp = { ok: false, error: 'Ego 路线: LOGIN: Ego 里公众号后台未登录（停在 https://mp.weixin.qq.com/），需要在 Ego 里扫码登录 mp.weixin.qq.com；备用路线（独立 Chrome）: 登录超时' }; errors.push(`公众号后台: ${mp.error}`); }
  else if (c.mp === 'backfill-fail') { mp = { ok: true, source: 'Ego', error: '', created: [], updated: [] }; errors.push('mp_backfill.py: 假的写笔记出错'); }
  else { writeNote('mp-1.md', { type: '平台数据', platform: '公众号', post_id: 'mp-1', fetched_at: `"${stamp}"` }); mp = { ok: true, source: 'Ego', created: [], updated: ['mp-1.md'] }; }

  let feishu = {};
  if (has('--skip-feishu')) feishu = { skipped: true };
  else if (c.feishu === 'fail') errors.push('feishu_sync.py: 假的飞书出错');
  else feishu = { works_created: 0, works_updated: posts.length };

  const dash = process.env.DAILY_FAKE_DASHBOARD;
  let dashboard = {};
  if (c.dashboard === 'fail') errors.push('工作台刷新: 假的看板出错');
  else if (c.dashboard === 'skipped') dashboard = { refresh: { skipped: '没有工作台工程' } };
  else { fs.writeFileSync(dash, `window.DATA = ${JSON.stringify([...new Set(dashPosts.map((p) => p.platform))].sort())};\n`); fs.utimesSync(dash, now, now); }

  if (c.extraError) errors.push(c.extraError);   // 说不清是哪一步的错
  const status = errors.length ? 4 : 0;
  if (c.garbage) { console.log('Traceback (most recent call last): 不是 JSON'); process.exit(4); }
  console.log(JSON.stringify({ ok: status === 0, exit_code: status, backfill: { created: [], updated_count: posts.length }, channels_daily: channels, mp, feishu, dashboard, errors }, null, 1));
  process.exit(status);
}
