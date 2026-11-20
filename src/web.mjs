// 麦田：本地网页。播种（发布）、长势（流量）、收成（转化）、粮仓（档案）
import http from 'node:http'; import crypto from 'node:crypto'; import fs from 'node:fs'; import path from 'node:path'; import { spawn, execFileSync } from 'node:child_process'; import { fileURLToPath } from 'node:url';
import { db, NAMES, STATE_CN, episodes, getEpisode, getTasks, recentLogs, getSnapshot, getMeta } from './db.mjs';
import { config } from './feishu.mjs';
import { SITE } from './site.mjs';
import { review } from './review.mjs';
import { accessEmail } from './access.mjs';
import { initLogin, sessionOk, handleLogin } from './login.mjs';
import { cindyStatus, readToken, rotateToken } from '../integrations/cindy/admin.mjs';
import { readWorksView } from './ops/works-view.mjs'; import { opsDbPath } from './ops/paths.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(DIR, '..');
const W = config.web || { port: 8787, key: '' };
const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...extra }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const readPj = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'publish.json'), 'utf8')); } catch { return null; } };
const short = (n) => n.split(/[｜|]/)[0].trim();
const nickOf = (name, pj) => (pj && pj.nick) || (short(name).split(/[，,？?！!：:。]/)[0].trim() || short(name)).slice(0, 16);
const latest = db.prepare('SELECT * FROM metrics WHERE episode_id=? AND platform=? ORDER BY day DESC LIMIT 1');
const actions = [];   // 最近的操作（内存里）

function episodeView(ep, full = false) {
  const snap = getSnapshot(ep.id), pj = (snap && JSON.parse(snap.project)) || readPj(ep.dir) || { platforms: {} };
  let views = 0, inter = 0;
  const tasks = getTasks(ep.id).map(t => {
    const m = latest.get(ep.id, t.platform) || null;
    if (m) { views += m.views || 0; inter += (m.likes || 0) + (m.comments || 0) + (m.favorites || 0) + (m.shares || 0); }
    const p = pj.platforms[t.platform] || {};
    return { platform: t.platform, name: NAMES[t.platform] || t.platform, state: t.state, stateCn: STATE_CN[t.state] || t.state, detail: t.detail || '', url: t.url || '', updatedAt: t.updated_at,
      m: m && { day: m.day, views: m.views, likes: m.likes, comments: m.comments, favorites: m.favorites, shares: m.shares, extra: JSON.parse(m.extra || '{}') },
      ...(full ? { copy: { title: p.title || p.shortTitle || '', body: p.desc || p.body || p.text || p.description || '', tags: p.tags || p.topics || [], covers: p.covers || [] }, shot: fs.existsSync(path.join(ep.dir, '发布档案', `${t.platform}.jpg`)) } : {}) };
  });
  const out = { id: ep.id, episode: ep.episode, name: ep.name, short: short(ep.name), nick: nickOf(ep.name, pj), schedule: ep.schedule, createdAt: ep.created_at, dir: ep.dir,
    campaign: (JSON.stringify(pj.platforms).match(/utm_campaign=([\w-]+)/) || [])[1] || '', covers: Object.keys(pj.covers || {}), durationSec: pj.durationSec || 0, tasks, views, inter };
  if (full) {
    out.logs = recentLogs(ep.id, 200);
    out.metrics = db.prepare('SELECT day, platform, views, likes, comments, favorites, shares FROM metrics WHERE episode_id=? ORDER BY day').all(ep.id);
    out.snapshotAt = snap && snap.taken_at;
    // 复盘：已经到了第 1/3/7 天的节点（和飞书卡片同一套算法）
    const t0 = Date.parse(ep.schedule || ep.created_at);
    out.reviews = tasks.some(t => t.state === 'published') ? [1, 3, 7].filter(a => Date.now() >= t0 + a * 864e5 || a === 1).map(a => { try { const r = review(ep, a); return { age: a, partial: Date.now() < t0 + a * 864e5, views: r.cur.views, ints: r.cur.ints, rows: r.cur.rows.map(x => ({ p: x.p, views: x.m.views, inter: x.m.likes + x.m.comments + x.m.favorites + x.m.shares })), prev: r.prev && { nick: r.prev.nick, views: r.prev.views, rows: r.prev.rows.map(x => ({ p: x.p, views: x.m.views })) }, fans: r.fans.sum, conv: r.conv || null }; } catch { return null; } }).filter(Boolean) : [];
    out.files = ['成片.mp4', '字幕.srt', '发布素材.md', 'publish.json', '发布记录.json'].filter(f => fs.existsSync(path.join(ep.dir, f)));
  }
  return out;
}

const ACT = { links: '取链接', mark: '标记', 'login-expired': '登录过期', upload: '上传', fill: '填写', submit: '提交', verify: '核对' };
function feed(n = 14) {
  const names = Object.fromEntries(episodes().map(e => [e.id, e.episode])), nicks = Object.fromEntries(episodes().map(e => [e.id, nickOf(e.name, readPj(e.dir))]));
  return db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(n).map(l => {
    let r = l.result || ''; try { const j = JSON.parse(r); r = j.status || j.note || ''; } catch {}
    return { ts: l.ts, episode: names[l.episode_id] || '', nick: nicks[l.episode_id] || '', platform: NAMES[l.platform] || l.platform || '', action: ACT[l.action] || l.action, result: STATE_CN[r] || String(r).slice(0, 40) };
  });
}
async function chromeUp() { try { const r = await fetch(`http://127.0.0.1:${config.chromePort || 9333}/json/version`, { signal: AbortSignal.timeout(800) }); return r.ok; } catch { return false; } }

function widgetBase(req) {
  let base = `${req.headers['x-forwarded-proto'] || (req.headers['cf-visitor'] ? 'https' : 'http')}://${req.headers.host}`;
  try { base = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tunnel.json'), 'utf8')).base || base; } catch {}
  return base;
}
function widgetScript(req, file) {
  return fs.readFileSync(path.join(ROOT, 'scripts', 'widget', file), 'utf8').replace('__MAITIAN_URL__', widgetBase(req)).replace('__WIDGET_TOKEN__', W.widgetToken);
}
const latestPublished = () => episodes().filter(e => e.schedule && Date.parse(e.schedule) <= Date.now()).sort((a, b) => Date.parse(b.schedule) - Date.parse(a.schedule))[0];
// 手机小组件：只读汇总（粉丝、涨幅、最新一期播放、站点近 7 天），用单独的 config.web.widgetToken，只能读这一个接口
function widgetData() {
  const ORDER = ['bilibili', 'douyin', 'xhs', 'channels', 'youtube', 'x', 'instagram'];
  const rows = db.prepare("SELECT day, platform, total FROM followers WHERE day >= date('now','localtime','-40 day') AND total IS NOT NULL ORDER BY day").all();
  const by = {}; for (const r of rows) (by[r.platform] ||= []).push(r);
  const today = new Date().toLocaleDateString('sv-SE');
  const ago = (d, n) => { const t = new Date(d + 'T12:00:00'); t.setDate(t.getDate() - n); return t.toLocaleDateString('sv-SE'); };
  const stat = (p) => { const a = by[p]; if (!a || !a.length) return null; const last = a[a.length - 1];
    const prev = [...a].reverse().find(r => r.day < last.day), week = [...a].reverse().find(r => r.day <= ago(last.day, 7)) || (a[0] !== last ? a[0] : null);   // 记录不满 7 天就从最早一天算
    return { id: p, name: NAMES[p] || p, total: last.total, today: last.day === today && prev ? last.total - prev.total : 0, week: week ? last.total - week.total : 0, day: last.day }; };
  const platforms = ORDER.map(stat).filter(Boolean);
  const sum = k => platforms.reduce((n, p) => n + (p[k] || 0), 0);
  const now = Date.now();
  const pub = latestPublished();
  const ev = pub && episodeView(pub);
  const days = SITE ? db.prepare('SELECT * FROM site_daily WHERE day >= ? ORDER BY day').all(ago(today, 6)) : [];
  const zsz = stat('zsz');
  return { name: config.name || '麦田', owner: W.owner || '', avatar: !!W.avatar, fans: { total: sum('total'), today: sum('today'), week: sum('week') }, platforms,
    latest: ev && { title: ev.short, nick: ev.nick, views: ev.views, inter: ev.inter, hours: Math.round((now - Date.parse(pub.schedule)) / 36e5) },
    site: SITE && { name: SITE.name, users: zsz && zsz.total, reg: days.reduce((n, d) => n + (d.reg || 0), 0), vip: days.reduce((n, d) => n + (d.vip || 0), 0), revenue: days.reduce((n, d) => n + (d.revenue || 0), 0) },
    metricsDay: getMeta('metricsDay') || '', now: new Date().toISOString() };
}
const isHttps = req => req.headers['x-forwarded-proto'] === 'https' || /https/.test(req.headers['cf-visitor'] || '');
const tokenEq = (a, b) => { if (typeof a !== 'string' || typeof b !== 'string') return false; const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

const widgetPage = (code, auto) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>麦田小组件</title>
<style>body{font-family:-apple-system,'PingFang SC',sans-serif;margin:0;padding:22px 18px 40px;background:#f6f1e6;color:#1c1a16;line-height:1.6}h1{font-size:24px;margin:0 0 6px}ol{padding-left:20px;font-size:15px}li{margin:6px 0}
button{width:100%;height:50px;border:0;border-radius:14px;background:#1c1a16;color:#fff;font-size:17px;font-weight:800;margin:14px 0}pre{background:#fff;border-radius:12px;padding:12px;font-size:11px;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-all}
.tip{font-size:13px;color:#7a7160}</style></head><body><h1>🌾 麦田小组件</h1>
<ol><li>App Store 安装 <b>Scriptable</b>（免费）</li><li>点下面的按钮复制脚本${auto ? '（自动更新的加载器，只需粘贴这一次）' : ''}</li><li>打开 Scriptable → 右上角 <b>＋</b> → 粘贴 → 标题改成「麦田」；已经有「麦田」脚本的，打开它全选、粘贴覆盖</li><li>长按桌面 → 左上角 <b>＋</b> → 搜 Scriptable → 选中号 → 添加；长按小组件 → 编辑小组件 → Script 选「麦田」</li><li>锁屏：长按锁屏 → 自定 → 添加小组件 → Scriptable → 同样选「麦田」</li></ol>
<button id="b">复制脚本</button><p class="tip">${auto ? '以后小组件改样式，手机上会自动用上新版，不用再粘贴。' : '现在是 http 地址，脚本不自动更新（明文传输下自动拉代码可能被同一网络的人替换）；小组件改样式后回这里重新复制一次。配了 https 隧道后从隧道地址打开本页，就能用自动更新版。'}脚本里带着小组件口令，只能读汇总数字（粉丝、播放、站点近 7 天），打不开麦田别的页面。别发给别人；泄露了在 config.json 换一个 widgetToken 即可。</p>
<pre id="c"></pre><script>const code=${JSON.stringify(code).replace(/</g, '\\u003c')};document.getElementById('c').textContent=code;
document.getElementById('b').onclick=async()=>{try{await navigator.clipboard.writeText(code);b.textContent='已复制 ✓';}catch{const r=document.createRange();r.selectNodeContents(c);getSelection().removeAllRanges();getSelection().addRange(r);b.textContent='长按选中的文字复制';}};</script></body></html>`;

// 缩略图：macOS 自带 sips 缩放转 JPEG，按 原文件路径+修改时间+尺寸 缓存；失败返回 null（退回原图）
function thumb(f, w) {
  try {
    const st = fs.statSync(f), dir = path.join(ROOT, 'data', 'thumbs');
    const out = path.join(dir, crypto.createHash('sha1').update(`${f}|${st.mtimeMs}|${w}`).digest('hex') + '.jpg');
    if (fs.existsSync(out)) return out;
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('/usr/bin/sips', ['-Z', String(w), '-s', 'format', 'jpeg', '-s', 'formatOptions', '78', f, '--out', out], { stdio: 'ignore', timeout: 20000 });
    return fs.existsSync(out) ? out : null;
  } catch { return null; }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// 本机直连：来源是回环地址、Host 是 localhost / 127.0.0.1、没有代理头。cloudflared 也从本机连进来，所以要看 Host 和代理头
function localOnly(req) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  const proxied = ['x-forwarded-for', 'x-forwarded-host', 'cf-connecting-ip', 'cf-ray', 'forwarded'].some((h) => req.headers[h]);
  return LOOPBACK.has(req.socket.remoteAddress) && (host === 'localhost' || host === '127.0.0.1') && !proxied;
}
// 防跨站：POST 必须带同源的 Origin（浏览器 fetch 都会带）
function sameOrigin(req) {
  const o = req.headers.origin;
  try { return !!o && new URL(o).host === req.headers.host; } catch { return false; }
}

async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  // 访问控制：前面挂了 Cloudflare Access（邮箱验证码）就认它的登录凭证；否则用口令（第一次带 ?key= 进来，之后用 cookie）
  if (/^\/static\/icon-\d+\.png$/.test(u.pathname)) return send(res, 200, fs.readFileSync(path.join(DIR, 'web', path.basename(u.pathname))), 'image/png', { 'cache-control': 'max-age=86400' });   // 主屏幕图标不用登录
  if (u.pathname === '/api/widget/img') {   // 小组件图片：头像（config.web.avatar）或最新一期封面缩略图，同一个只读口令
    if (!W.widgetToken || !tokenEq(u.searchParams.get('t'), W.widgetToken)) return send(res, 401, '');
    let f = null;
    if (u.searchParams.get('k') === 'avatar') f = W.avatar && path.resolve(ROOT, W.avatar);
    else { const ep = latestPublished(); const pj = ep && (readPj(ep.dir) || {}); const rel = pj && ((pj.covers || {})[u.searchParams.get('k') || '4x3'] || Object.values(pj.covers || {})[0]); f = rel && path.join(ep.dir, rel); }
    if (!f || !fs.existsSync(f)) return send(res, 404, '');
    const t = thumb(f, Math.min(800, +u.searchParams.get('w') || 400));
    return send(res, 200, fs.readFileSync(t || f), t ? 'image/jpeg' : 'image/png', { 'cache-control': 'max-age=1800' });
  }
  if (u.pathname === '/api/widget/code') return W.widgetToken && tokenEq(u.searchParams.get('t'), W.widgetToken) ? send(res, 200, widgetScript(req, 'maitian-widget.js'), 'text/javascript; charset=utf-8') : send(res, 401, '');   // 加载器每次刷新来取最新代码
  if (u.pathname === '/api/widget') return W.widgetToken && tokenEq(u.searchParams.get('t') || req.headers['x-widget-token'], W.widgetToken) ? send(res, 200, widgetData()) : send(res, 401, { error: '小组件口令不对' });
  if (u.pathname === '/manifest.webmanifest') return send(res, 200, { name: config.name || '麦田', short_name: config.name || '麦田', start_url: '/', display: 'standalone', background_color: '#efe7d8', theme_color: '#efe7d8', icons: [{ src: '/static/icon-512.png', sizes: '512x512', type: 'image/png' }] }, 'application/manifest+json');
  // 飞书验证码登录（config.web.login = "feishu"）：/login 页面和接口不需要先登录
  const LOGIN = W.login === 'feishu' && config.feishuWebhook;
  if (LOGIN && await handleLogin(req, res, u, send)) return;
  const cookieKey = ((req.headers.cookie || '').match(/mt_key=([^;]+)/) || [])[1];
  const keyOk = (v) => !!W.key && tokenEq(v, W.key);
  if (!keyOk(cookieKey) && !(LOGIN && sessionOk(req)) && !(await accessEmail(req, W.access))) {
    if (keyOk(u.searchParams.get('key'))) return send(res, 302, '', 'text/plain', { 'set-cookie': `mt_key=${W.key}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`, location: '/' });
    if (LOGIN) return u.pathname.startsWith('/api/') ? send(res, 401, { error: '需要登录' }) : send(res, 302, '', 'text/plain', { location: '/login' });
    return send(res, 401, '<meta charset="utf-8"><body style="font:16px system-ui;padding:40px">需要访问口令。请用带 <code>?key=…</code> 的地址打开一次。</body>', 'text/html; charset=utf-8');
  }
  if (u.pathname.startsWith('/static/')) { const f = path.join(DIR, 'web', path.basename(u.pathname)); if (!/\.(css|js|png)$/.test(f) || !fs.existsSync(f)) return send(res, 404, ''); return send(res, 200, fs.readFileSync(f), f.endsWith('.css') ? 'text/css; charset=utf-8' : f.endsWith('.png') ? 'image/png' : 'text/javascript; charset=utf-8'); }
  if (u.pathname === '/p') return send(res, 200, fs.readFileSync(path.join(DIR, 'web', 'pages.html')), 'text/html; charset=utf-8');
  if (u.pathname === '/board') return send(res, 200, fs.readFileSync(path.join(DIR, 'web', 'board.html')), 'text/html; charset=utf-8');
  if (u.pathname === '/') return send(res, 200, fs.readFileSync(path.join(DIR, 'web', 'board.html')), 'text/html; charset=utf-8');
  if (u.pathname === '/works') return send(res, 200, fs.readFileSync(path.join(DIR, 'web', 'works.html')), 'text/html; charset=utf-8');   // KIN-330：ops.db 的作品
  if (u.pathname === '/api/ops/works') return send(res, 200, readWorksView(opsDbPath(), { platform: u.searchParams.get('platform') || undefined }));
  if (u.pathname === '/cindy') return send(res, 200, fs.readFileSync(path.join(DIR, 'web', 'cindy.html')), 'text/html; charset=utf-8');   // KIN-325：Cindy 接入
  if (u.pathname === '/api/cindy/status') return send(res, 200, { ...(await cindyStatus()), local: localOnly(req) });
  if (u.pathname === '/api/cindy/token' && req.method === 'POST') {
    // 取 token、换 token 只给本机：MCP 本来就只在 127.0.0.1 上，远程（隧道、局域网）拿到 token 没用，只会多一处泄漏
    if (!localOnly(req)) return send(res, 403, { error: '只能在麦田这台电脑上用 http://localhost 打开时操作' });
    if (!sameOrigin(req)) return send(res, 403, { error: '来源不对' });
    const rotate = u.searchParams.get('rotate') === '1';
    const token = rotate ? rotateToken() : readToken();
    return token ? send(res, 200, { token, rotated: rotate }) : send(res, 404, { error: '还没有 token，点「生成」' });
  }
  if (u.pathname === '/widget') {   // 小组件安装页（已登录才能看）：脚本里填好麦田地址和小组件口令，手机上一键复制
    if (!W.widgetToken) return send(res, 404, '<meta charset="utf-8">没配 config.web.widgetToken', 'text/html; charset=utf-8');
    // 加载器会执行麦田发来的代码：只在 https 下用；http（局域网）明文传输可能被同一网络的人替换，就给完整脚本、不自动更新
    const auto = widgetBase(req).startsWith('https://');
    return send(res, 200, widgetPage(widgetScript(req, auto ? 'maitian-loader.js' : 'maitian-widget.js'), auto), 'text/html; charset=utf-8');
  }
  if (u.pathname === '/api/overview') {
    return send(res, 200, { name: config.name || '麦田', siteOn: !!SITE, siteName: SITE ? SITE.name : '', siteLogo: !!(SITE && config.site.logo), board: config.board && config.board.url, driver: config.driver,
      episodes: episodes().sort((a, b) => (b.episode || 0) - (a.episode || 0)).map(e => episodeView(e)), actions: actions.slice(-8).reverse(),
      site: { days: db.prepare('SELECT * FROM site_daily ORDER BY day').all(), channels: db.prepare('SELECT * FROM site_channels ORDER BY revenue DESC').all(),
        campaigns: db.prepare('SELECT * FROM site_campaigns ORDER BY reg DESC').all(), campaignsOn: getMeta('siteCampaigns') === 'on' },
      metrics: db.prepare('SELECT day, episode_id, platform, views FROM metrics ORDER BY day').all(),
      followers: db.prepare("SELECT day, platform, total, gain, loss, source FROM followers WHERE day >= date('now','localtime','-40 day') ORDER BY day").all(),
      samples: db.prepare('SELECT ts, episode_id, platform, views FROM samples ORDER BY ts').all(),
      feed: feed(), health: { nas: fs.existsSync(config.rootPath), chrome: await chromeUp(), metricsDay: getMeta('metricsDay') || '', doctorDay: getMeta('doctorDay') || '', login: Object.fromEntries((config.keepAlive || []).map(k => [k, getMeta(`login:${k}`) || '']) ) }, now: new Date().toISOString() });
  }
  if (u.pathname === '/site-logo') { const f = SITE && config.site.logo && path.resolve(ROOT, config.site.logo); return f && fs.existsSync(f) ? send(res, 200, fs.readFileSync(f), /\.svg$/.test(f) ? 'image/svg+xml' : /\.jpe?g$/.test(f) ? 'image/jpeg' : 'image/png', { 'cache-control': 'max-age=3600' }) : send(res, 404, ''); }
  if (u.pathname === '/api/episode') { const ep = getEpisode(u.searchParams.get('id')); return ep ? send(res, 200, episodeView(ep, true)) : send(res, 404, { error: '没有这一期' }); }
  if (u.pathname === '/cover' || u.pathname === '/shot') {
    const ep = getEpisode(u.searchParams.get('id')); if (!ep) return send(res, 404, '');
    let f;
    if (u.pathname === '/shot') f = path.join(ep.dir, '发布档案', `${(u.searchParams.get('p') || '').replace(/\W/g, '')}.jpg`);
    else { const pj = readPj(ep.dir) || {}; const rel = (pj.covers || {})[u.searchParams.get('k') || '4x3'] || Object.values(pj.covers || {})[0]; f = rel && path.join(ep.dir, rel); }
    if (!f || !f.startsWith(ep.dir) || !fs.existsSync(f)) return send(res, 404, '');
    // 远程打开时原图（每张 ~700KB）太慢：默认给缩略图（长边 ≤ w，默认 720，JPEG），缓存在 data/thumbs；?full=1 给原图
    if (!u.searchParams.get('full') && !/\.svg$/.test(f)) { const t = thumb(f, Math.min(1600, +u.searchParams.get('w') || 720)); if (t) return send(res, 200, fs.readFileSync(t), 'image/jpeg', { 'cache-control': 'max-age=3600' }); }
    return send(res, 200, fs.readFileSync(f), /\.png$/.test(f) ? 'image/png' : /\.svg$/.test(f) ? 'image/svg+xml' : 'image/jpeg', { 'cache-control': 'max-age=300' });
  }
  if (u.pathname === '/api/action' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d); req.on('end', () => {
      let a; try { a = JSON.parse(body); } catch { return send(res, 400, { error: '请求格式不对' }); }
      const map = { sync: ['sync', a.id], metrics: a.id ? ['metrics', a.id] : ['metrics'], doctor: ['doctor', '--notify'], board: ['board'], followers: ['followers'],
        mark: ['mark', a.id, a.platform, a.state, a.note || '在麦田里标记', ...(a.url ? ['--url', a.url] : [])] };
      const argv = map[a.type];
      if (!argv || argv.some(x => x === undefined || x === null || x === '')) return send(res, 400, { error: '不支持的操作' });
      if (a.type === 'mark' && (a.state !== 'published' || !getEpisode(a.id) || !NAMES[a.platform])) return send(res, 400, { error: '状态不对' });
      if (actions.some(x => !x.done && x.type !== 'mark') && a.type !== 'mark') return send(res, 409, { error: '上一个操作还在跑，等它结束' });
      const rec = { type: a.type, label: { sync: '取链接', metrics: '采流量', doctor: '体检', board: '同步知识站数据', followers: '采粉丝', mark: '标记状态', retry: '重跑平台' }[a.type] + (a.platform ? ` · ${NAMES[a.platform] || a.platform}` : ''), startedAt: new Date().toISOString(), done: false, ok: null, tail: '' };
      actions.push(rec);
      const ch = spawn(process.execPath, [path.join(DIR, 'hub.mjs'), ...argv], { cwd: ROOT, env: { ...process.env, HUB_NO_WEB: '1' } });
      const on = (d) => { rec.tail = (rec.tail + d).slice(-600); }; ch.stdout.on('data', on); ch.stderr.on('data', on);
      ch.on('close', (code) => { rec.done = true; rec.ok = code === 0; rec.endedAt = new Date().toISOString(); });
      send(res, 200, { ok: true });
    });
    return;
  }
  send(res, 404, { error: 'not found' });
}
export function startWeb() {
  // 没有任何一道门（口令、飞书登录、Cloudflare Access）就不起：网页监听 0.0.0.0，局域网和隧道都能直接打开
  if (!W.key && !(W.login === 'feishu' && config.feishuWebhook) && !(W.access?.team && W.access?.aud)) { console.error('麦田网页没起来：config.web.key 是空的。填一串随机字符当访问口令（node src/init.mjs 会自动生成）'); return null; }
  const srv = http.createServer((req, res) => { handle(req, res).catch((e) => { try { send(res, 500, { error: e.message }); } catch {} }); });
  initLogin(ROOT);
  srv.listen(W.port, '0.0.0.0', () => console.log(`麦田网页：http://localhost:${W.port}/${W.key ? '?key=<config.web.key>' : ''}`));   // 口令不进日志
  srv.on('error', (e) => console.error('麦田网页没起来：' + e.message));
  return srv;
}
