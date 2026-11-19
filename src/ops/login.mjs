// 登录检测（只读）、扫码登录、掉线提醒。
// 每个账号起一个 runner 任务（space 名按账号），在 space 里跑 space-check.mjs。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { listAccounts, getAccount, migrateUid, accountId, normalizeUid, PENDING, PLATFORM_NAMES } from './accounts.mjs';
import { ROOT, siteAdmin as configuredSiteAdmin } from './paths.mjs';

export const ALERT_INTERVAL_MS = 6 * 3600_000;
const CHECK_TIMEOUT_MS = 2 * 60_000;
const SPACE_CHECK_URL = pathToFileURL(path.join(import.meta.dirname, 'space-check.mjs')).href;

// 后台首页（判断登录）和登录页（扫码）；知识站用 config.json 的 site.admin
const PAGES = {
  Douyin: { home: 'https://creator.douyin.com/creator-micro/home', loginUrl: 'https://creator.douyin.com/' },
  XiaoHongShu: { home: 'https://creator.xiaohongshu.com/new/home', loginUrl: 'https://creator.xiaohongshu.com/login' },
  Bili: { home: 'https://member.bilibili.com/platform/home', loginUrl: 'https://passport.bilibili.com/login' },
  GongZhongHao: { home: 'https://mp.weixin.qq.com/', loginUrl: 'https://mp.weixin.qq.com/' },
  Weibo: { home: 'https://weibo.com/', loginUrl: 'https://passport.weibo.com/sso/signin' },
  Channels: { home: 'https://channels.weixin.qq.com/platform', loginUrl: 'https://channels.weixin.qq.com/login.html' },
  X: { home: 'https://x.com/home', loginUrl: 'https://x.com/i/flow/login' },
  YouTube: { home: 'https://studio.youtube.com/', loginUrl: 'https://studio.youtube.com/' },
  Instagram: { home: 'https://www.instagram.com/', loginUrl: 'https://www.instagram.com/accounts/login/' },
  Zhishi: { home: null, loginUrl: null },
};

// runner 的跳过原因 → 退出码（接口约定）
const SKIP_EXIT = { 'profile-needed': 3, 'user-controlled': 4, busy: 5 };
const SKIP_CN = { 'profile-needed': 'Ego 里没有要用的 profile，需要负责人新建', 'user-controlled': '负责人正在手动操作这个 space', busy: '另一个任务正占着这个 space' };

/**
 * 整条命令的退出码：有 UID 不符 → 2；否则有其他失败 → 1；否则有跳过的 → 按最先的跳过原因 3（profile-needed）> 4（user-controlled）> 5（busy）；
 * 否则 0（检测跑完了就是 0，检测结果是 out 或 unknown 也是 0，掉线靠提醒和 loginState 体现）。
 */
export function exitCodeOf(rows) {
  if (rows.some((r) => r.result === 'uid-mismatch')) return 2;
  if (rows.some((r) => r.result === 'failed')) return 1;
  for (const reason of ['profile-needed', 'user-controlled', 'busy']) if (rows.some((r) => r.skipped === reason)) return SKIP_EXIT[reason];
  return 0;
}

const loadRunner = async () => (await import('../ego-runner/index.mjs')).runEgoTask;
const lazyFinish = async (...args) => (await import('../ego-runner/index.mjs')).finishSpace(...args);

// 默认通知：feishu.mjs 在没有 config.json 时会 process.exit，所以先看配置在不在，再动态 import。
// 不用 feishu.mjs 的 notify：它吞掉失败、不返回结果。这里照它的消息体自己发（先卡片，飞书返回 code 非 0 时退回纯文字），
// 只有真的发出（HTTP 2xx 且 code 为 0 或没有 code）才返回 true，节流时间才会记。
// stdout 不写任何东西（--json 的 stdout 要保持合法 JSON），日志只写 stderr，不打印 webhook 地址。
async function postFeishu(webhook, body) {
  let res;
  try {
    res = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  } catch (e) { return { sent: false, why: e.name === 'TimeoutError' ? '超过 10 秒没响应' : `连不上（${e.cause?.code ?? e.name}）` }; }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) return { sent: false, why: `HTTP ${res.status}` };
  if (j.code != null && j.code !== 0) return { sent: false, rejected: true, why: `飞书返回 code=${j.code}${j.msg ? ` ${String(j.msg).slice(0, 80)}` : ''}` };
  return { sent: true };
}

export async function defaultNotify(text) {
  const head = String(text).split('\n')[0];
  const cfg = process.env.MAITIAN_CONFIG || path.join(ROOT, 'config.json');
  if (!fs.existsSync(cfg)) { console.error(`没有 ${cfg}，飞书提醒没发：${head}`); return false; }
  const { config, toCard } = await import('../feishu.mjs');
  if (!config.feishuWebhook) { console.error(`config.json 没配 feishuWebhook，飞书提醒没发：${head}`); return false; }
  let r = await postFeishu(config.feishuWebhook, { msg_type: 'interactive', card: toCard(text) });
  if (r.rejected) r = await postFeishu(config.feishuWebhook, { msg_type: 'text', content: { text } });
  if (!r.sent) { console.error(`飞书提醒没发出（${r.why}）：${head}`); return false; }
  console.error(`[飞书] 已发：${head}`);
  return true;
}

function selectAccounts(db, { ids, platform, platforms }) {
  const want = platforms ?? (platform ? [platform] : null);
  for (const p of want ?? []) if (!PLATFORM_NAMES[p]) throw new Error(`不认识的平台：${p}（可选：${Object.keys(PLATFORM_NAMES).join(', ')}）`);
  return listAccounts(db).filter((a) => (!ids || ids.includes(a.id)) && (!want || want.includes(a.platformCode)));
}

const homeOf = (a, siteAdmin) => (a.platformCode === 'Zhishi' ? siteAdmin : PAGES[a.platformCode]?.home);
const loginUrlOf = (a, siteAdmin) => (a.platformCode === 'Zhishi' ? siteAdmin : PAGES[a.platformCode]?.loginUrl);

function save(db, a, { loginState, evidence, at }) {
  db.prepare('UPDATE accounts SET loginState = ?, loginEvidence = ?, loginCheckedAt = ? WHERE platformCode = ? AND uid = ?')
    .run(loginState, evidence, at, a.platformCode, a.uid);
}

async function alert(db, a, text, { notify, now }) {
  const last = a.alertSentAt ? Date.parse(a.alertSentAt) : null;
  if (last != null && now() - last < ALERT_INTERVAL_MS) return false;
  if ((await notify(text)) !== true) return false;   // 没真的发出去就不记，补好配置后下次还能发
  db.prepare('UPDATE accounts SET alertSentAt = ? WHERE platformCode = ? AND uid = ?').run(new Date(now()).toISOString(), a.platformCode, a.uid);
  return true;
}

// pending 登记成真实 uid 后，旧的 kinso/<平台>/pending space 没人用了，关掉；关没关成只写进 message
async function closeOld(finishTask, a) {
  try {
    const f = await finishTask(a.spaceName, { profileId: a.profileId });
    return f?.ok ? `旧 space ${a.spaceName} 已关` : `旧 space ${a.spaceName} 没关：${f?.reason ?? '没返回原因'}`;
  } catch (e) { return `旧 space ${a.spaceName} 没关：${e.message}`; }
}

async function checkOne(db, a, { runTask, finishTask, notify, now, siteAdmin }) {
  const row = { id: a.id, platformCode: a.platformCode, platformName: a.platformName };
  const at = new Date(now()).toISOString();
  const home = homeOf(a, siteAdmin);
  if (!home) {
    const evidence = '没有后台地址（config.json 未配置 site.admin），没检测';
    save(db, a, { loginState: 'unknown', evidence, at });
    return { ...row, result: 'unknown', loginState: 'unknown', message: evidence };
  }
  const r = await runTask({ space: a.spaceName, profileId: a.profileId, timeoutMs: CHECK_TIMEOUT_MS,
    params: { mode: 'check', platformCode: a.platformCode, uid: a.uid, home, moduleUrl: SPACE_CHECK_URL },
    script: 'const { runInSpace } = await import(params.moduleUrl);\nreturn runInSpace(task, params);' });
  if (!r.ok && SKIP_EXIT[r.reason]) return { ...row, result: 'skipped', skipped: r.reason, loginState: a.loginState, message: `跳过：${SKIP_CN[r.reason]}（${r.reason}），登录状态没改` };
  if (!r.ok) return { ...row, result: 'failed', loginState: a.loginState, message: `runner 失败：${r.reason}${r.error ? ` ${String(r.error).slice(0, 160)}` : ''}，登录状态没改` };

  const c = r.result;
  if (!c || typeof c !== 'object' || !['ok', 'out', 'unknown'].includes(c.state) || typeof c.evidence !== 'string' || !c.evidence) {
    return { ...row, result: 'failed', loginState: a.loginState, message: `检测结果结构不对（state 要是 ok/out/unknown，evidence 要有内容），登录状态没改` };
  }
  const state = c.state;
  const evidence = c.evidence;
  const seen = normalizeUid(c.uidSeen);

  if (state === 'ok' && seen && a.uid !== PENDING && seen !== a.uid) {
    const message = `UID 不符：登记的是 ${a.uid}，页面上看到的是 ${seen}。没有写成 ok，这个账号先别用，请核对 space ${a.spaceName} 登的是哪个号`;
    save(db, a, { loginState: 'unknown', evidence: `${message}；${evidence}`, at });
    await alert(db, getAccount(db, a.id), `❌ ${a.platformName}账号 UID 不符 | ${a.id}\n${message}`, { notify, now });
    return { ...row, result: 'uid-mismatch', loginState: 'unknown', uidRegistered: a.uid, uidSeen: seen, message };
  }

  if (state === 'ok' && !seen) {
    // 没读到 uid 就没法核对（pending 的也没法登记），不能写成 ok
    const message = `登录了但没读到 uid，没法核对（登记的是 ${a.uid}），没有写成 ok`;
    save(db, a, { loginState: 'unknown', evidence: `${message}；${evidence}`, at });
    return { ...row, result: 'failed', loginState: 'unknown', message };
  }

  let id = a.id, message = evidence;
  if (state === 'ok' && a.uid === PENDING) {
    id = migrateUid(db, a.platformCode, PENDING, seen);
    message = `登记了真实 uid ${seen}（space 改为 kinso/${a.platformCode}/${seen}，${await closeOld(finishTask, a)}）；${evidence}`;
  }
  let cur = getAccount(db, id);
  save(db, cur, { loginState: state, evidence, at });
  // 昵称只在 UID 核对通过（或 pending 登记成功）之后写，免得错号的昵称写进登记账号
  if (state === 'ok' && c.nickname && !cur.nickname) db.prepare('UPDATE accounts SET nickname = ? WHERE platformCode = ? AND uid = ?').run(String(c.nickname), cur.platformCode, cur.uid);
  // 只要这次是 out 就走 alert()，同一账号 6 小时最多一次由 alertSentAt 保证
  if (state === 'out') {
    await alert(db, cur, `❌ ${a.platformName}账号掉线 | ${id}\n${evidence}\n扫码登录：hub ops login ${a.platformCode}`, { notify, now });
  }
  return { ...row, id, result: state, loginState: state, ...(seen ? { uidSeen: seen } : {}), message };
}

/**
 * hub ops login --check：逐个账号检测（只读）。返回 { rows, exitCode }。
 * opts: platform | platforms | ids；runTask（默认 runEgoTask）；finishTask（默认 finishSpace，pending 迁移后关旧 space）；notify（默认飞书）；now；siteAdmin（默认读 config.json）。
 */
export async function checkLogins(db, opts = {}) {
  const runTask = opts.runTask ?? (await loadRunner());
  const ctx = { runTask, finishTask: opts.finishTask ?? lazyFinish, notify: opts.notify ?? defaultNotify, now: opts.now ?? Date.now, siteAdmin: 'siteAdmin' in opts ? opts.siteAdmin : configuredSiteAdmin() };
  const rows = [];
  for (const a of selectAccounts(db, opts)) rows.push(await checkOne(db, a, ctx));
  return { rows, exitCode: exitCodeOf(rows) };
}

/**
 * hub ops login <platformCode|id>：打开登录页并 handOff() 交给负责人扫码；交还后自动跑一次 check（含 UID 核对）。
 * 只给负责人手动用，定时任务路径不调它。
 */
export async function scanLogin(db, target, opts = {}) {
  const runTask = opts.runTask ?? (await loadRunner());
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? 10_000, maxWaitMs = opts.maxWaitMs ?? 30 * 60_000;
  const siteAdmin = 'siteAdmin' in opts ? opts.siteAdmin : configuredSiteAdmin();
  const list = String(target).includes(':') ? [getAccount(db, target)].filter(Boolean) : listAccounts(db, { platform: target });
  if (list.length !== 1) throw new Error(list.length ? `${target} 有 ${list.length} 个账号，用账号 id：${list.map(accountId).join(', ')}` : `没有这个账号：${target}`);
  const a = list[0];
  const loginUrl = loginUrlOf(a, siteAdmin);
  if (!loginUrl) return { exitCode: 1, rows: [{ id: a.id, result: 'failed', message: '没有登录页地址（知识站要在 config.json 配 site.admin）' }] };

  const h = await runTask({ space: a.spaceName, profileId: a.profileId, timeoutMs: CHECK_TIMEOUT_MS,
    params: { mode: 'handoff', platformCode: a.platformCode, uid: a.uid, loginUrl, moduleUrl: SPACE_CHECK_URL },
    script: 'const { runInSpace } = await import(params.moduleUrl);\nreturn runInSpace(task, params);' });
  if (!h.ok) {
    const code = SKIP_EXIT[h.reason] ?? 1;
    return { exitCode: code, rows: [{ id: a.id, result: SKIP_EXIT[h.reason] ? 'skipped' : 'failed', skipped: SKIP_EXIT[h.reason] ? h.reason : undefined, message: `没能交给负责人：${SKIP_CN[h.reason] ?? h.reason}` }] };
  }
  save(db, a, { loginState: 'awaiting_user', evidence: '已打开登录页并交给负责人扫码', at: new Date(now()).toISOString() });

  const start = now();
  for (;;) {
    await sleep(pollMs);
    const r = await checkLogins(db, { ids: [a.id], runTask, finishTask: opts.finishTask, notify: opts.notify, now, siteAdmin });
    const waiting = r.rows[0]?.skipped === 'user-controlled' || r.rows[0]?.skipped === 'busy';
    if (!waiting) return r;
    if (now() - start >= maxWaitMs) return { exitCode: 4, rows: [{ ...r.rows[0], message: `等了 ${Math.round(maxWaitMs / 60000)} 分钟，space 还在负责人手里；交还后跑 hub ops login --check --platform ${a.platformCode}` }] };
  }
}
