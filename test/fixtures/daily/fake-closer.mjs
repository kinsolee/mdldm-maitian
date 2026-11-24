#!/usr/bin/env node
// 假的收口脚本（代替 ~/.hermes/scripts/content-data-daily.sh）：参数和真脚本一样，按 DAILY_FAKE 场景文件的 closer 段决定每一步成败。
// 笔记、视频号分日、公众号写进临时知识库，看板写临时 data.js（mtime 设成 MAITIAN_DAILY_NOW），飞书只记成败。
// 每次调用把参数和看板拿到的平台追加到 DAILY_FAKE_LOG。
import fs from 'node:fs';
import path from 'node:path';

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

const note = (file, fm) => fs.writeFileSync(path.join(dir, file), `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n`);
const read = (file) => Object.fromEntries(fs.readFileSync(path.join(dir, file), 'utf8').split('\n').map((l) => /^(\w+): (.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));
fs.mkdirSync(dir, { recursive: true });

if (c.backfill === 'fail') { console.log(JSON.stringify({ ok: false, step: 'backfill', errors: ['backfill.py 失败: 假的'] })); process.exit(3); }
for (const p of posts) note(`${p.postId}.md`, { type: '平台数据', platform: CN[p.platform], post_id: p.postId, fetched_at: `"${stamp}"` });

let channels;
if (has('--skip-channels')) channels = { skipped: 'skipped' };
else if (c.channels === 'login') channels = { skipped: 'Ego: LOGIN: Ego 里视频号助手未登录，需要在 Ego 里扫码登录 channels.weixin.qq.com' };
else if (c.channels === 'fail') channels = { skipped: 'channels_backfill.py: 假的出错' };
else {
  const updated = fs.readdirSync(dir).filter((f) => read(f).platform === '视频号');
  for (const f of updated) note(f, { ...read(f), daily_fetched_at: `"${stamp}"` });
  channels = { updated, unmatched: [] };
}

const errors = [];
let mp;
if (has('--skip-mp')) mp = { ok: false, error: 'skipped' };
else if (c.mp === 'login') { mp = { ok: false, error: 'Ego 路线: LOGIN: Ego 里公众号后台未登录（停在 https://mp.weixin.qq.com/），需要在 Ego 里扫码登录 mp.weixin.qq.com；备用路线（独立 Chrome）: 登录超时' }; errors.push(`公众号后台: ${mp.error}`); }
else { note('mp-1.md', { type: '平台数据', platform: '公众号', post_id: 'mp-1', fetched_at: `"${stamp}"` }); mp = { ok: true, source: 'Ego', updated: ['mp-1.md'] }; }

let feishu = {};
if (has('--skip-feishu')) feishu = { skipped: true };
else if (c.feishu === 'fail') errors.push('feishu_sync.py: 假的飞书出错');
else feishu = { works_created: 0, works_updated: posts.length };

const dash = process.env.DAILY_FAKE_DASHBOARD;
if (c.dashboard === 'fail') errors.push('工作台刷新: 假的看板出错');
else { fs.writeFileSync(dash, `window.DATA = ${JSON.stringify([...new Set(dashPosts.map((p) => p.platform))].sort())};\n`); fs.utimesSync(dash, now, now); }

const status = errors.length ? 4 : 0;
console.log(JSON.stringify({ ok: status === 0, exit_code: status, backfill: { created: [], updated_count: posts.length }, channels_daily: channels, mp, feishu, dashboard: {}, errors }, null, 1));
process.exit(status);
