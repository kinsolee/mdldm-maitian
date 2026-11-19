#!/usr/bin/env node
// 评论私信抓取轮：先跑排着的 refresh_now，再跑到点的定时任务；账号之间串行（每个任务自己起 runner 短进程）；
// 一轮结束调一次 deliverPending（推送合批靠这个）。守护进程只调度、不持页面：到点了起一个 `sync.mjs --once` 子进程。
//   node src/daemon/sync.mjs --once [--platform X] [--kind comments|dms] [--force] [--json]
//   node src/daemon/sync.mjs status [--json]
// 退出码：0 跑完（有失败也是 0，失败靠事件和飞书）；1 参数错；5 拿不到轮锁（已有一轮在跑）。
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { openOpsDb } from '../ops/db.mjs';
import { listAccounts, getAccount, PENDING, PLATFORM_NAMES } from '../ops/accounts.mjs';
import { opsDbPath, engageLockPath } from '../ops/paths.mjs';
import { defaultNotify } from '../ops/login.mjs';
import { ingestSnapshot, createJob, startJob, finishJob, getJob, pendingRefreshes, recordSyncFailure, recordLoginLost, SYNC_KINDS } from '../ops/engage/store.mjs';
import { deliverPending } from './outbox.mjs';
import { ENGAGE_PLATFORMS, isDue } from './schedule.mjs';
import { acquireRoundLock, heldLock } from './round-lock.mjs';

export const EXIT_LOCKED = 5;
export const TICK_MS = 60_000;
const CAP = { comments: 'readComments', dms: 'readDM' };
const KIND_CN = { comments: '评论', dms: '私信' };
const iso = (ms) => new Date(ms).toISOString();
const localTime = (ms) => new Date(ms).toLocaleString('sv-SE', { hour12: false });

/** 错误信息去敏：地址只留 origin + path，cookie / token 一类的值打码，截到 300 字。日志、库、飞书都用它。 */
export function redact(s) {
  return String(s ?? '')
    .replace(/https?:\/\/[^\s"'<>）)]+/g, (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return '（地址）'; } })
    .replace(/\b(set-cookie|cookie|xsec_token|access_token|refresh_token|token|authorization|secret|password|passwd|sessionid|sid)\b(\s*[:=]\s*)(bearer\s+)?[^\s;,&]+/gi, '$1$2***')
    .slice(0, 300);
}

// ---------- 每个平台每个 kind 的定时状态（只有这里建这张表） ----------

export function ensureScheduleTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS engage_schedule (
    platformCode TEXT NOT NULL, kind TEXT NOT NULL, lastScheduledAt TEXT, note TEXT, PRIMARY KEY (platformCode, kind))`);
}
const scheduleRow = (db, platformCode, kind) => db.prepare('SELECT * FROM engage_schedule WHERE platformCode = ? AND kind = ?').get(platformCode, kind) ?? {};
function setSchedule(db, platformCode, kind, fields) {
  const row = { lastScheduledAt: null, note: null, ...scheduleRow(db, platformCode, kind), ...fields };
  db.prepare(`INSERT INTO engage_schedule (platformCode, kind, lastScheduledAt, note) VALUES (?, ?, ?, ?)
    ON CONFLICT(platformCode, kind) DO UPDATE SET lastScheduledAt = excluded.lastScheduledAt, note = excluded.note`).run(platformCode, kind, row.lastScheduledAt, row.note);
}

// ---------- 选账号 ----------

/** 能抓就返回 null，否则返回原因（日志用，不含密钥）。 */
function ineligible(account, kind) {
  if (!account) return '没有这个账号';
  if (!ENGAGE_PLATFORMS.includes(account.platformCode)) return `${account.platformCode} 不在评论私信抓取范围内`;
  if (account.uid === PENDING) return `${account.id} 还没登记真实 uid`;
  if (!account.capabilities?.[CAP[kind]]) return `${account.id} 的能力位 ${CAP[kind]} 关着（要开：hub ops accounts set-cap ${account.id} ${CAP[kind]} true）`;
  return null;
}

// ---------- 跑一个任务 ----------

async function safeNotify(notify, text, log) {
  try { return (await notify(text)) === true; } catch (e) { log(`飞书提醒出错：${redact(e.message)}`); return false; }
}

async function runJob(db, account, kind, jobId, deps) {
  const { now, collect, notify, log } = deps;
  const name = `${PLATFORM_NAMES[account.platformCode] ?? account.platformCode}${KIND_CN[kind]}`;
  startJob(db, jobId, { now, accountId: account.id });
  let r;
  try { r = await collect({ account, kind }); } catch (e) { r = { ok: false, reason: 'exception', error: e?.message ?? String(e) }; }
  const out = { jobId, platformCode: account.platformCode, accountId: account.id, kind };

  if (r?.ok === true) {
    try {
      const s = ingestSnapshot(db, account, r, { now });
      const stats = { inserted: s.inserted, updated: s.updated, gone: s.gone, events: s.events.length };
      finishJob(db, jobId, { status: 'ok', stats, now });
      return { ...out, status: 'ok', stats };
    } catch (e) { r = { ok: false, reason: 'ingest', error: e.message }; }
  }
  if (r?.ok === false && r.skipped) {
    finishJob(db, jobId, { status: 'skipped', error: r.skipped, now });
    return { ...out, status: 'skipped', skipped: r.skipped };
  }

  const reason = r?.reason ?? 'bad-result';
  const error = redact(`${reason}${r?.error ? `：${r.error}` : ''}`);
  finishJob(db, jobId, { status: 'failed', error, now });
  const res = { ...out, status: 'failed', reason, error, events: [] };
  if (reason === 'login-lost') {
    const ev = recordLoginLost(db, { accountId: account.id, jobId, evidence: error, now });
    const sf = recordSyncFailure(db, jobId, { now });
    res.events = [ev, sf].filter(Boolean);
    if (ev) await safeNotify(notify, `🔑 ${PLATFORM_NAMES[account.platformCode] ?? account.platformCode}掉线了，评论私信抓不到 | ${account.id}\n最后的错误：${error}\n请扫码重新登录：hub ops login ${account.id}\n6 小时内同一账号不再重复提醒。`, log);
    return res;
  }
  const sf = recordSyncFailure(db, jobId, { now });
  if (sf) {
    res.events = [sf];
    await safeNotify(notify, `⚠️ ${name}抓取连续 2 次失败 | ${account.id}\n最后的错误：${error}\n之后再失败不重复提醒，成功一次后重新计数。可用 hub ops engage status 查看。`, log);
  }
  return res;
}

function logJob(log, now, j) {
  const head = `${localTime(now())} [engage] ${j.platformCode} ${j.kind}`;
  if (j.status === 'ok') log(`${head} ok 新增 ${j.stats.inserted} 更新 ${j.stats.updated} 消失 ${j.stats.gone} 事件 ${j.stats.events}`);
  else if (j.status === 'skipped') log(`${head} 跳过（${j.skipped}）`);
  else log(`${head} 失败 ${j.error}`);
}

// ---------- 一轮 ----------

/**
 * 跑一轮。opts：now（毫秒时间函数）、collect（适配器，生产路径见 loadCollect）、notify（飞书，返回 true 才算发出）、fetchImpl（推送用）、
 * platforms / kinds（只跑这些）、trigger（'schedule' 只跑到点的；'manual' 不看时间表，选中的都跑）、lockPath、timeZone、log。
 * 拿不到轮锁返回 { ran: false, reason: 'locked' }；否则 { ran: true, jobs, delivery }。
 */
export async function runRound(db, {
  now = Date.now, collect, notify = defaultNotify, fetchImpl = fetch, platforms = ENGAGE_PLATFORMS, kinds = SYNC_KINDS,
  trigger = 'schedule', lockPath = engageLockPath(), timeZone, log = console.log,
} = {}) {
  if (typeof collect !== 'function') throw new Error('runRound 需要 collect');
  const lock = acquireRoundLock(lockPath, { now });
  if (!lock) return { ran: false, reason: 'locked' };
  if (lock.taken) log(`${localTime(now())} [engage] 接管了过期的轮锁`);
  const deps = { now, collect, notify, log };
  const jobs = [];
  const run = async (account, kind, jobId) => {
    let j;
    try { j = await runJob(db, account, kind, jobId, deps); } catch (e) {
      j = { jobId, platformCode: account.platformCode, accountId: account.id, kind, status: 'failed', error: redact(e.message) };
      if (getJob(db, jobId)?.status === 'running') finishJob(db, jobId, { status: 'failed', error: j.error, now });
    }
    jobs.push(j);
    logJob(log, now, j);
  };
  try {
    ensureScheduleTable(db);
    const refreshed = new Set();
    // 1. refresh_now：用那条 job，不新建
    for (const job of pendingRefreshes(db)) {
      if (!platforms.includes(job.platformCode) && ENGAGE_PLATFORMS.includes(job.platformCode)) continue;
      if (!kinds.includes(job.kind)) continue;
      const account = job.accountId ? getAccount(db, job.accountId) : listAccounts(db, { platform: job.platformCode })[0];
      const why = ineligible(account, job.kind);
      if (why) {
        startJob(db, job.id, { now });
        finishJob(db, job.id, { status: 'skipped', error: why, now });
        const j = { jobId: job.id, platformCode: job.platformCode, accountId: job.accountId, kind: job.kind, status: 'skipped', skipped: why };
        jobs.push(j); logJob(log, now, j);
        continue;
      }
      refreshed.add(`${job.platformCode}/${job.kind}`);
      await run(account, job.kind, job.id);
    }
    // 2. 到点的定时任务
    for (const platformCode of platforms.filter((p) => ENGAGE_PLATFORMS.includes(p))) {
      for (const kind of kinds) {
        const sched = scheduleRow(db, platformCode, kind);
        if (trigger !== 'manual' && !isDue({ lastScheduledAt: sched.lastScheduledAt ?? null, now: now(), timeZone })) continue;
        const accounts = listAccounts(db, { platform: platformCode });
        const reasons = accounts.length ? accounts.map((a) => ineligible(a, kind)).filter(Boolean) : [`没有 ${platformCode} 的账号`];
        const note = reasons.length ? reasons.join('；') : null;
        if (note && note !== (sched.note ?? null)) log(`${localTime(now())} [engage] ${platformCode} ${kind} 不抓：${note}`);   // 原因变了才说一次
        setSchedule(db, platformCode, kind, { lastScheduledAt: iso(now()), note });
        if (refreshed.has(`${platformCode}/${kind}`)) continue;   // 这一轮刚因 refresh_now 抓过
        for (const account of accounts.filter((a) => !ineligible(a, kind))) {
          await run(account, kind, createJob(db, { platformCode, accountId: account.id, kind, trigger: 'schedule', now }));
        }
      }
    }
    let delivery;
    try {
      const d = await deliverPending(db, { now, fetchImpl, notify });
      delivery = { batches: d.batches.length, failedBatches: d.batches.filter((b) => !b.ok).length, alerts: d.alerts };
      if (d.batches.length) log(`${localTime(now())} [engage] 推送 ${d.batches.length} 批，失败 ${delivery.failedBatches} 批`);
    } catch (e) { delivery = { error: redact(e.message) }; log(`${localTime(now())} [engage] 推送出错：${delivery.error}`); }
    return { ran: true, jobs, delivery };
  } finally { lock.release(); }
}

// ---------- 守护进程：要不要起一轮 ----------

/** 有可跑的 refresh_now，或有到点的定时任务，且没有一轮在跑 → { start: true }。守护进程每分钟问一次。 */
export function shouldStartRound(db, { now = Date.now, lockPath = engageLockPath(), timeZone } = {}) {
  if (heldLock(lockPath, { now })) return { start: false, reason: 'running' };
  if (pendingRefreshes(db).length) return { start: true, reason: 'refresh_now' };
  ensureScheduleTable(db);
  for (const p of ENGAGE_PLATFORMS) for (const kind of SYNC_KINDS) {
    if (isDue({ lastScheduledAt: scheduleRow(db, p, kind).lastScheduledAt ?? null, now: now(), timeZone })) return { start: true, reason: 'schedule' };
  }
  return { start: false, reason: 'idle' };
}

/** 守护进程每分钟调一次的 tick：该起就起一个 `sync.mjs --once` 子进程，不等它；子进程没退出前不再起。 */
export function makeEngageTicker({ openDb = () => openOpsDb(opsDbPath()), spawnImpl = spawn, now = Date.now, lockPath, log = console.log } = {}) {
  let db = null, child = null;
  return function tick() {
    try {
      if (child) return { started: false, reason: 'child-running' };
      db ??= openDb();
      const d = shouldStartRound(db, { now, lockPath });
      if (!d.start) return { started: false, reason: d.reason };
      child = spawnImpl(process.execPath, [import.meta.filename, '--once'], { stdio: 'inherit', detached: false });
      const t0 = now();
      child.on('exit', (code, signal) => { log(`${localTime(now())} [engage] 抓取轮子进程退出 code=${code ?? signal}，用时 ${Math.round((now() - t0) / 1000)} 秒`); child = null; });
      child.on('error', (e) => { log(`${localTime(now())} [engage] 起抓取轮失败：${redact(e.message)}`); child = null; });
      return { started: true, reason: d.reason };
    } catch (e) { log(`${localTime(now())} [engage] 调度出错：${redact(e.message)}`); return { started: false, reason: 'error' }; }
  };
}

export function startEngageTimer(opts) {
  const tick = makeEngageTicker(opts);
  console.log('评论私信抓取调度已启动（每分钟检查一次；HUB_NO_ENGAGE=1 可关）');
  return setInterval(tick, TICK_MS);
}

// ---------- status ----------

export function engageStatus(db) {
  ensureScheduleTable(db);
  const last = db.prepare('SELECT * FROM sync_jobs WHERE platformCode = ? AND kind = ? ORDER BY requestedAt DESC, rowid DESC LIMIT 1');
  const unhandled = db.prepare('SELECT count(*) n FROM events WHERE platformCode = ? AND handledAt IS NULL');
  const platforms = ENGAGE_PLATFORMS.map((platformCode) => ({
    platformCode,
    unhandledEvents: unhandled.get(platformCode).n,
    kinds: Object.fromEntries(SYNC_KINDS.map((kind) => {
      const j = last.get(platformCode, kind);
      const s = scheduleRow(db, platformCode, kind);
      return [kind, { lastScheduledAt: s.lastScheduledAt ?? null, note: s.note ?? null,
        lastJob: j ? { id: j.id, trigger: j.trigger, status: j.status, requestedAt: j.requestedAt, finishedAt: j.finishedAt, error: j.error, stats: j.stats ? JSON.parse(j.stats) : null } : null }];
    })),
  }));
  return { platforms, unhandledEvents: db.prepare('SELECT count(*) n FROM events WHERE handledAt IS NULL').get().n };
}

function printStatus(st) {
  for (const p of st.platforms) {
    for (const kind of SYNC_KINDS) {
      const k = p.kinds[kind], j = k.lastJob;
      const what = !j ? '还没跑过' : `${j.status}${j.status === 'ok' && j.stats ? `（新增 ${j.stats.inserted} 更新 ${j.stats.updated} 消失 ${j.stats.gone} 事件 ${j.stats.events}）` : j.error ? `（${j.error}）` : ''} ${j.finishedAt ?? j.requestedAt}`;
      console.log(`${p.platformCode.padEnd(10)} ${kind.padEnd(8)} ${what}${k.note ? `  不抓：${k.note}` : ''}`);
    }
    console.log(`${p.platformCode.padEnd(10)} 未处理事件 ${p.unhandledEvents}`);
  }
  console.log(`未处理事件合计 ${st.unhandledEvents}`);
}

// ---------- 命令行 ----------

export const USAGE = `用法：
  node src/daemon/sync.mjs --once [--platform ${ENGAGE_PLATFORMS.join('|')}] [--kind comments|dms] [--force] [--json]
      跑一轮：先 refresh_now，再到点的定时任务（--force：不看时间表，选中的都跑）。退出码 0 跑完（失败靠事件和飞书）、1 参数错、5 已有一轮在跑
  node src/daemon/sync.mjs status [--json]   每个平台每个 kind 最近一次任务、未处理事件数`;

// 生产路径的适配器：dev-2 的 src/ops/engage/adapters/index.mjs，用到时才加载（加载失败按这个任务失败记）
const loadCollect = async (args) => (await import('../ops/engage/adapters/index.mjs')).collect(args);

export async function main(argv = process.argv.slice(2), deps = {}) {
  const [first, ...rest] = argv;
  const isStatus = first === 'status';
  let values;
  try {
    ({ values } = parseArgs({ args: isStatus || first === 'sync' ? rest : argv, options: {
      once: { type: 'boolean', default: false }, platform: { type: 'string' }, kind: { type: 'string' },
      force: { type: 'boolean', default: false }, json: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false },
    } }));
  } catch (e) { console.error(`${e.message}\n${USAGE}`); return 1; }
  if (values.help) { console.log(USAGE); return 0; }
  const db = openOpsDb(opsDbPath());
  if (isStatus) {
    const st = engageStatus(db);
    if (values.json) console.log(JSON.stringify(st, null, 1)); else printStatus(st);
    return 0;
  }
  if (!values.once) { console.error(USAGE); return 1; }
  if (values.platform && !ENGAGE_PLATFORMS.includes(values.platform)) { console.error(`--platform 只能是 ${ENGAGE_PLATFORMS.join('、')}：${values.platform}`); return 1; }
  if (values.kind && !SYNC_KINDS.includes(values.kind)) { console.error(`--kind 只能是 comments 或 dms：${values.kind}`); return 1; }
  const log = values.json ? (s) => console.error(s) : (s) => console.log(s);   // --json 时 stdout 只放 JSON
  const r = await runRound(db, {
    collect: deps.collect ?? loadCollect, ...(deps.notify ? { notify: deps.notify } : {}),
    platforms: values.platform ? [values.platform] : ENGAGE_PLATFORMS, kinds: values.kind ? [values.kind] : SYNC_KINDS,
    trigger: values.force ? 'manual' : 'schedule', log,
  });
  if (values.json) console.log(JSON.stringify(r, null, 1));
  if (!r.ran) { if (!values.json) console.error('已有一轮在跑，这一轮不跑'); return EXIT_LOCKED; }
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === import.meta.filename) {
  main().then((code) => process.exit(code), (e) => { console.error(`出错：${redact(e.message)}`); process.exit(1); });
}
