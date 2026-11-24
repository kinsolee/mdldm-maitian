#!/usr/bin/env node
// 每日数据流程（KIN-339）：给 Cindy 脚本自动化用的幂等调度命令。自己不采也不写数据，只调用现有的采集命令和库外的收口脚本。
//   check    前置检查（preRunHook）：今天有事可做 exit 0，没有（做完了、在等负责人、空间被占着、另一轮在跑）exit 2；出错 exit 1。只读。
//            检查完整跑完（0 或 2）才在最后输出 CINDY_PRECHECK_OK。
//   run      把今天能做的做完。stdout 只写一行 cindy-script/1 完成帧；需要负责人动手或某一步出错时，摘要同时写在 stderr 末尾并 exit 1。
//   status   只读：今天每一步的情况（--json 输出 JSON）。
//   plan     只读预演：下一次 run 会执行什么。
// 「今天做没做」从数据本身判断（采集记录、影子导出、数据笔记的抓取时间、看板数据文件的修改时间）。
// 状态文件只记：正在进行、要重试的同步，已经提醒过的事，在等登录的时间。详见 docs/migration/S3-works.md 的「定时」一节。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, opsDbPath, shadowDir } from '../../src/ops/paths.mjs';
import { dateCn, POSTS_MIN_DAYS } from '../../src/ops/export.mjs';
import { stableNodeExecPath } from '../../src/ops/node-bin.mjs';
import { PRECHECK_OK } from './inbox.mjs';

export const PROTOCOL = 'cindy-script/1';
const PLATFORMS = [['Douyin', '抖音'], ['XiaoHongShu', '小红书'], ['Bili', 'B站'], ['Channels', '视频号']];
const LABEL = Object.fromEntries(PLATFORMS);
const NOTE_PLATFORM = { Douyin: '抖音', XiaoHongShu: '小红书', Bili: '哔哩哔哩', Channels: '视频号' };   // 数据笔记 frontmatter 里的 platform
const CLOSER_TOOLS = ['python3', 'lark-cli', 'ego-browser'];   // 收口脚本要用的命令：笔记和看板、飞书、Ego 后台抓取
const COLLECT_RESULTS = new Set(['ok', 'out', 'skipped', 'failed', 'uid-mismatch']);
const BUSY_WINDOW_MS = 30 * 60_000;      // 评论私信同步 running 超过这么久不再当成占着空间（进程可能早就退了）
const LOCK_MAX_MS = 6 * 3600_000;        // 锁的主人进程还活着也只认这么久（防 pid 被系统复用）
const LOGIN_RE = /LOGIN|未登录/;
const SYNC_ERR_RE = /^(feishu_sync|账号日数据同步飞书|工作台)/;
const CHANNELS_LOGIN = '视频号助手在 Ego 里未登录：在 Ego 里扫码登录 channels.weixin.qq.com';
const MP_LOGIN = '公众号后台在 Ego 里未登录：在 Ego 里扫码登录 mp.weixin.qq.com';

const USAGE = `用法：node integrations/cindy/daily.mjs check|run|status|plan [--closer <收口脚本>] [--vault <知识库根>] [--dashboard-data <看板 data.js>] [--state <状态文件>] [--retry-waiting] [--json]
  --closer 不传（也没有 MAITIAN_DAILY_CLOSER）时只做采集，回填写「未配置」。
  --retry-waiting：手动补跑时用，连「在等负责人」的平台也重试一次；重试后还不行照样提醒。
  路径也能用环境变量改：MAITIAN_OPS_DB、MAITIAN_OPS_SHADOW_DIR、MAITIAN_DAILY_VAULT、MAITIAN_DAILY_DASHBOARD、MAITIAN_DAILY_STATE、MAITIAN_DAILY_CLOSER。`;

export function readConfig(values = {}, env = process.env) {
  const home = env.HOME || os.homedir();
  const ms = (k, d) => (env[k] ? Number(env[k]) : d);
  return {
    now: env.MAITIAN_DAILY_NOW ? Date.parse(env.MAITIAN_DAILY_NOW) : Date.now(),
    opsDb: opsDbPath(),
    shadow: shadowDir(),
    vault: values.vault || env.MAITIAN_DAILY_VAULT || path.join(home, 'Documents', 'OPC-vault'),
    dashboard: values['dashboard-data'] || env.MAITIAN_DAILY_DASHBOARD || path.join(home, 'code', 'local-tests', 'kinso-dashboard', 'data.js'),
    closer: values.closer || env.MAITIAN_DAILY_CLOSER || null,
    state: values.state || env.MAITIAN_DAILY_STATE || path.join(import.meta.dirname, 'data', 'daily-state.json'),
    collectCmd: env.MAITIAN_DAILY_COLLECT_CMD ? [env.MAITIAN_DAILY_COLLECT_CMD] : [stableNodeExecPath(), path.join(ROOT, 'src', 'ops', 'cli.mjs')],
    // Cindy 起脚本时 PATH 只有系统目录；子进程按麦田常驻服务的惯例给（用户本地 bin、Homebrew、系统目录）
    childPath: env.MAITIAN_DAILY_PATH || `${home}/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    mpProbeMs: ms('MAITIAN_DAILY_MP_PROBE_MINUTES', 60) * 60_000,
    collectTimeoutMs: ms('MAITIAN_DAILY_COLLECT_TIMEOUT_MS', 8 * 60_000),
    closerTimeoutMs: ms('MAITIAN_DAILY_CLOSER_TIMEOUT_MS', 10 * 60_000),
    killGraceMs: ms('MAITIAN_DAILY_KILL_GRACE_MS', 10_000),
    retryWaiting: !!values['retry-waiting'],
  };
}

// ---------- 读数据（全部只读） ----------

const mtime = (file) => { try { return fs.statSync(file).mtimeMs; } catch { return null; } };

function readDb(file, sinceIso, now) {
  if (!fs.existsSync(file)) throw new Error(`找不到 ops.db：${file}`);
  const db = new DatabaseSync(file, { readOnly: true, timeout: 5000 });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    const runs = tables.has('collect_runs')
      ? db.prepare('SELECT platformCode, finishedAt, result, reason, message, days FROM collect_runs WHERE finishedAt >= ? ORDER BY finishedAt').all(sinceIso).map((r) => ({ ...r }))
      : [];
    const syncOk = {}, busy = new Set();
    if (tables.has('sync_jobs')) {
      for (const r of db.prepare("SELECT platformCode p, MAX(finishedAt) t FROM sync_jobs WHERE status = 'ok' GROUP BY platformCode").all()) syncOk[r.p] = r.t;
      for (const r of db.prepare("SELECT DISTINCT platformCode p FROM sync_jobs WHERE status = 'running' AND COALESCE(startedAt, requestedAt) >= ?").all(new Date(now - BUSY_WINDOW_MS).toISOString())) busy.add(r.p);
    }
    return { runs, syncOk, busy };
  } finally { db.close(); }
}

/** 数据笔记（frontmatter type 为「平台数据」）：platform、post_id、fetched_at、daily_fetched_at。 */
export function scanNotes(vault) {
  const base = path.join(vault, '10.个人IP', '数据', '平台数据');
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) {
        const m = /^---\n([\s\S]*?)\n---/.exec(fs.readFileSync(p, 'utf8'));
        if (!m) continue;
        const fm = {};
        for (const line of m[1].split('\n')) {
          const kv = /^([A-Za-z_]\w*):\s?(.*)$/.exec(line);
          if (kv) fm[kv[1]] = kv[2].trim().replace(/^"(.*)"$/, '$1');
        }
        if (fm.type === '平台数据') out.push({ platform: fm.platform, postId: String(fm.post_id ?? ''), fetchedAt: fm.fetched_at || '', dailyFetchedAt: fm.daily_fetched_at || '' });
      }
    }
  };
  walk(base);
  return out;
}

/** 当天的影子导出：两份文件都在、都是数组、每条作品有 postId 和四个平台之一，才算可用。 */
function readExport(postsFile, accountsFile) {
  const at = Math.min(mtime(postsFile) ?? NaN, mtime(accountsFile) ?? NaN);
  if (!Number.isFinite(at)) return { missing: true };
  const sig = `${mtime(postsFile)}:${mtime(accountsFile)}`;
  const parse = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { bad: `${path.basename(file)} 不是合法 JSON（${e.message}）` }; } };
  const raw = parse(postsFile), acc = parse(accountsFile);
  const posts = Array.isArray(raw) ? raw : Array.isArray(raw?.list) ? raw.list : null;
  let problem = raw?.bad ?? acc?.bad ?? null;
  if (!problem && !posts) problem = `${path.basename(postsFile)} 不是作品数组`;
  if (!problem && posts.some((p) => !p || p.postId == null || !LABEL[p.platform])) problem = `${path.basename(postsFile)} 有作品缺 postId 或平台不对`;
  if (!problem && (!Array.isArray(acc) || acc.length === 0)) problem = `${path.basename(accountsFile)} 不是非空的账号数组`;
  return { at, sig, posts: problem ? [] : posts, problem };
}

const onPath = (cmd, PATH) => PATH.split(':').some((d) => { try { fs.accessSync(path.join(d, cmd), fs.constants.X_OK); return true; } catch { return false; } });

// ---------- 判断今天每一步的情况 ----------

/** 采集结果里要负责人动手的，返回一句要做什么；瞬时原因（busy、user-controlled）和失败返回 null。 */
function humanNeed(row) {
  const label = LABEL[row.platformCode];
  if (row.result === 'out') return `${label}未登录：扫码登录（node src/ops/cli.mjs login ${row.platformCode}）`;
  if (row.result === 'uid-mismatch') return `${label}登录的账号 UID 和账号表不符：核对账号后重新登录，或用 hub ops accounts set-uid 改登记`;
  if (row.result === 'skipped' && row.reason === 'profile-needed') return `${label}在 Ego 里没有要用的 profile：先在 Ego 里建好再扫码登录`;
  if (row.result === 'skipped' && row.reason === 'uid-pending') return `${label}的 UID 还没登记：hub ops accounts set-uid ${row.platformCode} <uid>`;
  if (row.result === 'skipped' && row.reason === 'no-account') return `${label}在账号表里没有账号：hub ops accounts import 导入后再扫码登录`;
  return null;
}

/**
 * 今天的计划。每一步 status：done 做完；todo 本轮可做；waiting 在等负责人；busy 空间被占着，下一轮再说；
 * off 能力位关着，不算今天要做的；blocked 前一步没做完；unconfigured 没配置收口脚本；env 环境缺命令。
 * retryWaiting 只在本轮挑要做的事时用；跑完之后重算计划不带它，免得刚发生的失败被当成「待做」漏掉提醒。
 */
export function buildPlan(cfg, state, { retryWaiting = false } = {}) {
  const today = dateCn(cfg.now);
  const compact = today.replaceAll('-', '');
  const { runs, syncOk, busy } = readDb(cfg.opsDb, new Date(Date.parse(`${today}T00:00:00+08:00`)).toISOString(), cfg.now);
  const recovered = (code, sinceIso) => !!syncOk[code] && syncOk[code] > sinceIso;   // 失败之后守护进程的评论私信同步又成功过：登录已恢复

  const collect = {};
  for (const [code] of PLATFORMS) {
    const rows = runs.filter((r) => r.platformCode === code);
    const ok = rows.filter((r) => r.result === 'ok' && (r.days ?? 0) >= POSTS_MIN_DAYS).at(-1);   // 导出 posts 只收采满 30 天的
    const last = rows.at(-1);
    let s;
    if (ok) s = { status: 'done', at: ok.finishedAt };
    else if (!last) s = { status: 'todo' };
    else if (last.result === 'skipped' && last.reason === 'capability-off') s = { status: 'off' };
    else if (humanNeed(last)) {
      s = recovered(code, last.finishedAt) || retryWaiting ? { status: 'todo' }
        : { status: 'waiting', need: humanNeed(last), key: `collect:${code}:${last.reason ?? last.result}` };
    } else s = { status: 'todo', last: last.result === 'failed' ? `上次失败：${last.message ?? '原因不明'}` : last.result === 'ok' ? `上次只采了 ${last.days} 天` : `上次跳过（${last.reason}）` };
    if (s.status === 'todo' && busy.has(code)) s = { ...s, status: 'busy' };
    collect[code] = s;
  }
  const plan = { date: today, closer: cfg.closer, collect, env: [], issues: [], exportStale: false, exportReady: false, posts: [] };
  if (!cfg.closer) return plan;   // 只做采集：不读导出、不读知识库

  for (const [key, need] of [['env:closer', (() => { try { fs.accessSync(cfg.closer, fs.constants.X_OK); return null; } catch { return `找不到收口脚本或没有执行权限：${cfg.closer}`; } })()],
    ...CLOSER_TOOLS.map((t) => [`env:${t}`, onPath(t, cfg.childPath) ? null : `子进程的 PATH 里找不到 ${t}（PATH=${cfg.childPath}）`])]) {
    if (need) plan.env.push({ key, need, status: 'waiting' });
  }

  plan.postsFile = path.join(cfg.shadow, `posts-${compact}.json`);
  plan.accountsFile = path.join(cfg.shadow, `accounts-${compact}.json`);
  const doneAt = Object.values(collect).filter((c) => c.status === 'done').map((c) => Date.parse(c.at));
  const ex = readExport(plan.postsFile, plan.accountsFile);
  if (doneAt.length) {
    if (ex.missing || Math.max(...doneAt) > ex.at) plan.exportStale = true;
    else if (ex.problem) {
      // 不合格的导出先重新导出一次；导出过还是这份，就是要人看的问题，提醒一次
      if (state.exportTried === ex.sig) plan.issues.push({ key: `export:${ex.sig}`, status: 'waiting', need: `影子导出不合格：${ex.problem}。跑 hub ops export posts / accounts 看原因` });
      else plan.exportStale = true;
    } else { plan.exportReady = true; plan.posts = ex.posts; plan.exportAt = ex.at; plan.exportSig = ex.sig; }
  }
  plan.exportProblem = ex.problem ?? null;
  plan.exportCheckedSig = ex.sig ?? null;
  const closerState = plan.env.length ? 'env' : plan.exportReady ? null : 'blocked';

  const notes = scanNotes(cfg.vault);
  const isToday = (s) => typeof s === 'string' && s.startsWith(today);
  const keyOf = (platformCn, id) => `${platformCn}\u0000${id}`;
  // 同一条作品可能有两篇笔记（backfill.py 只更新它先找到的那篇），有一篇今天抓过就算回填过；按平台 + post_id 认
  const fetchedToday = new Set(notes.filter((n) => isToday(n.fetchedAt)).map((n) => keyOf(n.platform, n.postId)));
  const platformsById = new Map();
  for (const n of notes) platformsById.set(n.postId, new Set([...(platformsById.get(n.postId) ?? []), n.platform]));

  plan.backfill = {};
  for (const [code, label] of PLATFORMS) {
    if (collect[code].status === 'off') { plan.backfill[code] = { status: 'off' }; continue; }
    if (collect[code].status !== 'done' || closerState === 'blocked') { plan.backfill[code] = { status: 'blocked' }; continue; }
    const mine = plan.posts.filter((p) => p.platform === code);
    const notDone = mine.filter((p) => !fetchedToday.has(keyOf(NOTE_PLATFORM[code], String(p.postId))));
    // backfill.py 按 post_id 找笔记、不看平台：别的平台有同 ID 的笔记时会写错，不传，提醒一次
    const conflicts = notDone.filter((p) => [...(platformsById.get(String(p.postId)) ?? [])].some((x) => x !== NOTE_PLATFORM[code]));
    const pending = notDone.filter((p) => !conflicts.includes(p));
    for (const p of conflicts) plan.issues.push({ key: `conflict:${code}:${p.postId}`, status: 'waiting', need: `${label}作品 ${p.postId} 在别的平台也有同 ID 的数据笔记，回填会写错笔记：先改正那篇笔记的 platform 或 post_id` });
    plan.backfill[code] = { status: pending.length ? closerState ?? 'todo' : 'done', posts: mine.length, pending: pending.length, pendingPosts: pending, ...(conflicts.length ? { conflicts: conflicts.length } : {}) };
  }

  if (notes.some((n) => n.platform === '视频号' && isToday(n.dailyFetchedAt)) || state.channelsOk === today) plan.channels = { status: 'done' };
  else if (closerState) plan.channels = { status: closerState };
  else if (collect.Channels.status === 'waiting') plan.channels = { status: 'waiting', need: collect.Channels.need, key: collect.Channels.key };
  else if (state.channelsLoginAt && !recovered('Channels', state.channelsLoginAt) && !retryWaiting) plan.channels = { status: 'waiting', need: CHANNELS_LOGIN, key: 'channels:login' };
  else plan.channels = { status: 'todo' };

  if (notes.some((n) => n.platform === '公众号' && isToday(n.fetchedAt)) || state.mpOk === today) plan.mp = { status: 'done' };
  else if (closerState) plan.mp = { status: closerState };
  else if (state.mpLoginAt && cfg.now - Date.parse(state.mpProbeAt ?? state.mpLoginAt) < cfg.mpProbeMs && !retryWaiting) {
    plan.mp = { status: 'waiting', need: MP_LOGIN, key: 'mp:login', nextProbe: new Date(Date.parse(state.mpProbeAt ?? state.mpLoginAt) + cfg.mpProbeMs).toISOString() };
  } else plan.mp = { status: 'todo', ...(state.mpLoginAt ? { probe: true } : {}) };

  // 看板要比今天的导出新；收口脚本跑之前就记下「同步进行中」，拿到成功证据才清掉（中途断了下一轮照样重跑）
  const dash = mtime(cfg.dashboard);
  const dashFresh = dash != null && dateCn(dash) === today && plan.exportReady && dash >= plan.exportAt;
  if (closerState) plan.sync = { status: closerState };
  else plan.sync = { status: dashFresh && !state.syncPending ? 'done' : 'todo', ...(state.syncPending ? { last: '上次同步没做完' } : !dashFresh && dash != null ? { last: '看板比今天的导出旧' } : {}) };
  return plan;
}

const closerSteps = (plan) => (plan.closer ? [...Object.values(plan.backfill), plan.channels, plan.mp, plan.sync] : []);
const closerTodo = (plan) => closerSteps(plan).some((s) => s.status === 'todo');
/** 要负责人动手、今天还没提醒过的。 */
function unnotified(plan, state) {
  const items = [...Object.values(plan.collect), plan.channels, plan.mp, ...plan.env, ...plan.issues].filter((s) => s?.key && s.status === 'waiting');
  const seen = new Set();
  return items.filter((s) => !state.notified?.[s.key] && !seen.has(s.key) && seen.add(s.key));
}
export function doable(plan, state) {
  return Object.values(plan.collect).some((c) => c.status === 'todo') || plan.exportStale || closerTodo(plan) || unnotified(plan, state).length > 0;
}
const isComplete = (plan) => Object.values(plan.collect).every((c) => ['done', 'off'].includes(c.status))
  && closerSteps(plan).every((s) => ['done', 'off'].includes(s.status)) && !plan.issues.length;

// ---------- 文字 ----------

const WORD = { done: '做完', todo: '待做', waiting: '在等负责人', busy: '空间被占着，下一轮再试', off: '能力位关着，不做', blocked: '等前一步', unconfigured: '未配置', env: '环境缺命令' };
const word = (s) => `${WORD[s.status] ?? s.status}${s.need ? `（${s.need}）` : ''}${s.last ? `（${s.last}）` : ''}`;
export function statusLines(plan) {
  const lines = [`日期：${plan.date}`, ...PLATFORMS.map(([c, l]) => `采集 ${l}：${word(plan.collect[c])}`)];
  if (!plan.closer) return [...lines, '回填：未配置（没传 --closer），只做采集'];
  return [
    ...lines,
    `影子导出：${plan.exportReady ? '可用' : plan.exportStale ? '要重新导出' : plan.exportProblem ? `不合格（${plan.exportProblem}）` : '还没有（没有平台采集成功）'}`,
    ...PLATFORMS.map(([c, l]) => { const b = plan.backfill[c]; return `回填笔记 ${l}：${word(b)}${b.posts != null ? `，${b.posts} 条作品，${b.pending} 条待回填${b.conflicts ? `，${b.conflicts} 条 ID 冲突` : ''}` : ''}`; }),
    `视频号分日：${word(plan.channels)}`,
    `公众号阅读：${word(plan.mp)}${plan.mp.nextProbe ? `，${plan.mp.nextProbe} 后再探` : ''}`,
    `飞书和看板：${word(plan.sync)}`,
    ...[...plan.env, ...plan.issues].map((e) => `要处理：${e.need}`),
  ];
}
export function planLines(plan, state) {
  const out = [];
  const todo = PLATFORMS.filter(([c]) => plan.collect[c].status === 'todo');
  if (todo.length) out.push(`采集：hub ops collect --export --json ${todo.map(([c]) => c).join(' ')}`);
  if (plan.exportStale) out.push('导出：影子导出比采集旧或不合格，跑 hub ops export posts / accounts');
  if (!plan.closer) out.push('回填：未配置（没传 --closer），跳过');
  else if (closerTodo(plan)) {
    const n = Object.values(plan.backfill).reduce((a, b) => a + (b.status === 'todo' ? b.pending : 0), 0);
    out.push(`回填：收口脚本，笔记只传 ${n} 条还没回填的作品；${plan.channels.status === 'todo' ? '跑' : '跳过'}视频号分日；${plan.mp.status === 'todo' ? '跑' : '跳过'}公众号；同步飞书和看板`);
  } else if (todo.length || plan.exportStale) out.push('回填：采集和导出之后再看');
  for (const u of unnotified(plan, state)) out.push(`提醒：${u.need}`);
  return out.length ? out : ['没有要做的：今天已做完，或者在等负责人'];
}
function waitingText(plan) {
  const out = [];
  for (const [c, l] of PLATFORMS) if (!['done', 'off'].includes(plan.collect[c].status)) out.push(`${l}采集（${WORD[plan.collect[c].status]}）`);
  if (plan.closer) {
    for (const [c, l] of PLATFORMS) if (['todo', 'waiting', 'env'].includes(plan.backfill[c].status)) out.push(`${l}笔记（${WORD[plan.backfill[c].status]}）`);
    if (!['done', 'off'].includes(plan.channels.status)) out.push(`视频号分日（${WORD[plan.channels.status]}）`);
    if (plan.mp.status !== 'done') out.push(`公众号阅读（${WORD[plan.mp.status]}）`);
    if (plan.sync.status !== 'done') out.push(`飞书和看板（${WORD[plan.sync.status]}）`);
    for (const i of plan.issues) out.push(i.need);
  }
  return out.join('、') || '无';
}

// ---------- 状态文件、锁、子进程 ----------

function loadState(file, today) {
  let s = null;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error(`读不了状态文件 ${file}：${e.message}`); }
  return s?.date === today ? s : { date: today, notified: {} };
}
function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 1)}\n`);
  fs.renameSync(tmp, file);
}

const lockFile = (cfg) => `${cfg.state}.lock`;
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readLock = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return e.code === 'ENOENT' ? null : {}; } };
/** 锁在不在用：主人进程还活着（不论锁多旧，除非超过 LOCK_MAX_MS）。读不出内容的锁刚写一半时也当在用，1 分钟后才算死锁。 */
function lockLive(file) {
  const l = readLock(file);
  if (!l) return false;
  if (!Number.isInteger(l.pid)) return (Date.now() - (mtime(file) ?? 0)) < 60_000;
  return pidAlive(l.pid) && Date.now() - (l.at ?? 0) < LOCK_MAX_MS;
}
/** 争锁：wx 原子创建。死锁先改名到唯一的名字再核对是不是刚读到的那把，免得两个进程互删对方刚建的锁。拿到返回 token，被占返回 null，其他错误照常抛出。 */
function takeLock(cfg) {
  const file = lockFile(cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = `${process.pid}-${randomUUID()}`;
  for (let i = 0; i < 3; i++) {
    try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token, at: Date.now() }), { flag: 'wx' }); return token; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (lockLive(file)) return null;
    const seen = readLock(file);
    const grave = `${file}.stale-${token}`;
    try { fs.renameSync(file, grave); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (readLock(grave)?.token !== seen?.token) {   // 改名时拿到的已经是别人刚建的新锁：放回去，算被占
      try { fs.linkSync(grave, file); } catch { /* 第三个进程又建了锁，同样算被占 */ }
      fs.rmSync(grave, { force: true });
      return null;
    }
    fs.rmSync(grave, { force: true });
  }
  return null;
}
function releaseLock(cfg, token) {
  if (token && readLock(lockFile(cfg))?.token === token) fs.rmSync(lockFile(cfg), { force: true });
}

const children = new Set();
const killGroup = (child, sig) => { try { process.kill(-child.pid, sig); } catch { /* 已经退了 */ } };
// Cindy 超时会杀本进程；子进程各在自己的进程组里，要带上一起杀
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { for (const c of children) killGroup(c, 'SIGKILL'); process.exit(sig === 'SIGTERM' ? 143 : 130); });

/** 起子进程（自己一个进程组）：stdout 收下来解析，stderr 原样转到自己的 stderr。超时先 TERM 整组，过 killGraceMs 再 KILL 整组。 */
function runChild(cfg, cmd, args, { env, timeoutMs }) {
  return new Promise((resolve) => {
    let out = '', errTail = '', timedOut = false, graceTimer = null;
    const child = spawn(cmd[0], [...cmd.slice(1), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    children.add(child);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, 'SIGTERM');
      graceTimer = setTimeout(() => killGroup(child, 'SIGKILL'), cfg.killGraceMs);
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { process.stderr.write(d); errTail = (errTail + d).slice(-600); });
    const done = (r) => { clearTimeout(timer); clearTimeout(graceTimer); children.delete(child); killGroup(child, 'SIGKILL'); resolve(r); };
    child.on('error', (e) => done({ code: -1, out, err: e.message, json: null }));
    child.on('close', (code) => {
      let json = null;
      try { json = JSON.parse(out.slice(out.indexOf('{'))); } catch { /* 按 json 为空处理 */ }
      done({ code: timedOut ? -1 : code, out, err: timedOut ? `超过 ${Math.round(timeoutMs / 1000)} 秒没跑完，已停掉整组进程` : errTail.trim(), json });
    });
  });
}

// ---------- run ----------

const short = (s, n = 300) => (String(s ?? '').length > n ? `${String(s).slice(0, n)}…` : String(s ?? ''));

async function runOnce(cfg) {
  const today = dateCn(cfg.now);
  const t0 = Date.now();
  const nowIso = () => new Date(cfg.now + (Date.now() - t0)).toISOString();   // 事情真正发生的时刻（测试里时钟是假的，跟着它走）
  const state = loadState(cfg.state, today);
  const errors = [], progress = [];
  const childEnv = { ...process.env, PATH: cfg.childPath };
  const replan = () => buildPlan(cfg, state);
  let plan = buildPlan(cfg, state, { retryWaiting: cfg.retryWaiting });
  if (!doable(plan, state)) {
    return { ok: true, text: isComplete(plan) ? `今天的数据流程已做完，没有要做的。${plan.closer ? '' : '回填未配置。'}` : `本轮没有要做的，还在等：${waitingText(plan)}` };
  }

  // 1. 采集今天还没成功的平台
  const todo = PLATFORMS.filter(([c]) => plan.collect[c].status === 'todo').map(([c]) => c);
  if (todo.length) {
    const r = await runChild(cfg, cfg.collectCmd, ['collect', '--export', '--json', ...todo], { env: childEnv, timeoutMs: cfg.collectTimeoutMs });
    const rows = Array.isArray(r.json?.rows) ? r.json.rows : null;
    if (!rows || ![0, 1, 2, 3].includes(r.code)) errors.push(`采集命令出错（退出码 ${r.code}）：${short(r.err || r.out.slice(-300))}`);
    else {
      for (const code of todo) if (!rows.some((x) => x.platformCode === code)) errors.push(`${LABEL[code]}采集没有返回结果`);
      for (const row of rows) {
        const l = LABEL[row.platformCode] ?? row.platformCode;
        if (!COLLECT_RESULTS.has(row.result)) errors.push(`${l}采集结果看不懂：${short(row.result)}`);
        else if (row.result === 'ok') progress.push(`${l}采集成功`);
        else if (row.result === 'failed') errors.push(`${l}采集失败：${short(row.message ?? '原因不明')}`);
        else if (row.result === 'skipped' && ['busy', 'user-controlled'].includes(row.reason)) progress.push(`${l}这轮没采（${row.reason === 'busy' ? '空间被评论私信同步占着' : '负责人正在操作'}），下一轮再试`);
      }
      for (const e of ['posts', 'accounts']) { const x = r.json.export?.[e]; if (x && x.exitCode === 1) errors.push(`导出 ${e} 不合格：${short(x.message ?? (x.problems ?? []).join('；'))}`); }
    }
    plan = replan();
  }

  // 2. 影子导出比采集旧或不合格：重新导出一次；还不合格就记下这份，下一次计划里变成提醒
  if (plan.closer && plan.exportStale) {
    for (const kind of ['posts', 'accounts']) {
      const r = await runChild(cfg, cfg.collectCmd, ['export', kind, '--json'], { env: childEnv, timeoutMs: cfg.collectTimeoutMs });
      if (![0, 3].includes(r.code)) errors.push(`导出 ${kind} 出错（退出码 ${r.code}）：${short(r.err || r.json?.message)}`);
    }
    plan = replan();
    if (plan.exportStale && plan.exportProblem) { state.exportTried = plan.exportCheckedSig; plan = replan(); }
    else if (plan.exportStale) errors.push('重新导出之后影子导出还是比采集旧');
  }

  // 3. 收口脚本：只在有可用的当天导出时跑。笔记只传今天还没回填的作品；做完的分日和公众号跳过；看板始终用完整的作品文件
  if (plan.closer && closerTodo(plan) && plan.exportReady) {
    const pending = PLATFORMS.flatMap(([c]) => (plan.backfill[c].status === 'todo' ? plan.backfill[c].pendingPosts : []));
    const subset = path.join(path.dirname(cfg.state), `daily-posts-${plan.date.replaceAll('-', '')}.json`);
    fs.mkdirSync(path.dirname(subset), { recursive: true });
    fs.writeFileSync(subset, JSON.stringify(pending));
    const runChannels = plan.channels.status === 'todo', runMp = plan.mp.status === 'todo';
    const args = ['--posts', subset, '--vault', cfg.vault, '--source', '麦田', '--dashboard-posts', plan.postsFile, '--accounts', plan.accountsFile, '--no-llm'];   // 定时流程零 token：看板分析走规则版
    if (!runChannels) args.push('--skip-channels');
    if (!runMp) args.push('--skip-mp');
    state.syncPending = true;   // 先落盘：收口脚本中途断了，下一轮照样重跑同步
    saveState(cfg.state, state);
    const r = await runChild(cfg, [cfg.closer], args, { env: childEnv, timeoutMs: cfg.closerTimeoutMs });
    const s = r.json;
    if (r.code === 3) errors.push(`笔记回填失败（backfill.py）：${short((s?.errors ?? []).join('；') || r.err)}`);
    else if (![0, 4].includes(r.code)) errors.push(`收口脚本出错（退出码 ${r.code}）：${short((s?.errors ?? []).join('；') || r.err)}`);
    else if (!s || typeof s !== 'object' || !Array.isArray(s.errors) || (runChannels && !s.channels_daily) || (runMp && !s.mp)) {
      errors.push(`收口脚本的输出看不懂（退出码 ${r.code}）：${short(r.out.slice(-300) || r.err)}`);
    } else {
      const errs = s.errors.filter(Boolean).map(String);
      const attributed = new Set();
      const take = (re) => errs.filter((e) => re.test(e) && attributed.add(e));
      if (pending.length) progress.push(`回填了 ${pending.length} 条作品的笔记`);
      if (runChannels) {
        const cd = s.channels_daily;
        if (cd.skipped) {
          if (LOGIN_RE.test(cd.skipped)) state.channelsLoginAt = nowIso();
          else errors.push(`视频号分日失败：${short(cd.skipped)}`);
        } else if (Array.isArray(cd.updated) && cd.updated.length === 0) state.channelsOk = today;   // 抓到了但一篇都没对上：不再整天重试（PR 评审遗留里有说明）
      }
      if (runMp) {
        const mpErr = take(/^(公众号后台|mp_backfill)/);
        if (s.mp.ok && !mpErr.length) {
          if (!(s.mp.updated?.length || s.mp.created?.length)) state.mpOk = today;   // 抓到了、这几天没有要更新的笔记
          delete state.mpLoginAt; delete state.mpProbeAt;
        } else if (!s.mp.ok && LOGIN_RE.test(s.mp.error ?? '')) {
          state.mpLoginAt ??= nowIso(); state.mpProbeAt = nowIso();
          if (state.notified?.['mp:login']) progress.push('公众号后台仍未登录');
        } else errors.push(`公众号阅读失败：${short(mpErr.join('；') || s.mp.error || '原因不明')}`);
      }
      const syncErr = take(SYNC_ERR_RE);
      const dashSkipped = s.dashboard?.refresh?.skipped;
      const dash = mtime(cfg.dashboard);
      if (syncErr.length) errors.push(...syncErr.map((e) => `飞书和看板同步失败：${short(e)}`));
      else if (dashSkipped) errors.push(`看板没刷新：${short(dashSkipped)}`);
      else if (!(dash != null && dateCn(dash) === today && dash >= plan.exportAt)) errors.push('收口脚本说成功，但看板 data.js 没有更新');
      else { delete state.syncPending; progress.push('飞书和看板已同步'); }
      const rest = errs.filter((e) => !attributed.has(e));
      errors.push(...rest.map((e) => `收口脚本报错：${short(e)}`));
      if (r.code === 4 && !errs.length) errors.push('收口脚本退出码 4，但没说哪一步失败');
    }
    saveState(cfg.state, state);
    plan = replan();
    // 读回：传进去的作品今天应该都有抓取记录了；分日说更新了就该有今天的 daily_fetched_at
    if ([0, 4].includes(r.code) && s) {
      const left = PLATFORMS.reduce((n, [c]) => n + (plan.backfill[c].status === 'todo' ? plan.backfill[c].pending : 0), 0);
      if (pending.length && left) errors.push(`回填后还有 ${left} 条作品的笔记不是今天的抓取时间`);
      if (runChannels && s.channels_daily && !s.channels_daily.skipped && plan.channels.status !== 'done') errors.push('视频号分日说更新了，但笔记里没有今天的分日抓取时间');
      if (runMp && s.mp?.ok && plan.mp.status !== 'done' && state.mpOk !== today) errors.push('公众号说抓到了，但公众号笔记没有今天的抓取时间');
    }
  }

  // 4. 当天第一次发现要负责人动手的：这一轮以失败结束一次，之后同样的情况不再提醒
  const fresh = unnotified(plan, state);
  state.notified ??= {};
  for (const u of fresh) state.notified[u.key] = nowIso();
  saveState(cfg.state, state);

  const status = `进度：${progress.length ? progress.join('；') : '无'}`;
  if (errors.length || fresh.length) {
    // Cindy 的失败通知只取 stderr 最后 1000 字：要负责人做的事放在最后
    return { ok: false, text: ['今天的数据流程这一轮没走完。', ...errors.map((e) => `出错：${e}（下一轮自动重试）`), status, ...fresh.map((u) => `需要你：${u.need}`)].join('\n') };
  }
  if (isComplete(plan)) return { ok: true, text: `今天的数据流程全部做完${plan.closer ? '：采集、回填、视频号分日、公众号阅读、飞书和看板' : '：采集完成；回填未配置（没传 --closer），跳过'}。\n${status}` };
  return { ok: true, text: `本轮推进了，还没做完。${status}\n还差：${waitingText(plan)}` };
}

// ---------- 入口 ----------

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    closer: { type: 'string' }, vault: { type: 'string' }, 'dashboard-data': { type: 'string' }, state: { type: 'string' },
    'retry-waiting': { type: 'boolean', default: false }, json: { type: 'boolean', default: false },
  } });
  const [mode] = positionals;
  const write = (s) => process.stdout.write(`${s}\n`);
  if (mode === 'run') {
    const frame = (text) => write(JSON.stringify({ protocol: PROTOCOL, type: 'complete', resultText: text.slice(0, 8000) }));
    let cfg = null, token = null;
    try {
      cfg = readConfig(values, env);
      token = takeLock(cfg);
      if (!token) { frame('另一轮还在跑，本轮跳过。'); return 0; }
      const r = await runOnce(cfg);
      frame(r.text);
      if (!r.ok) process.stderr.write(`\n${r.text}\n`);
      return r.ok ? 0 : 1;
    } catch (e) {
      const text = `每日数据流程出错：${e.message}`;
      frame(text);
      process.stderr.write(`\n${text}\n`);
      return 1;
    } finally { if (cfg && token) releaseLock(cfg, token); }
  }
  const cfg = readConfig(values, env);
  const today = dateCn(cfg.now);
  if (mode === 'check') {
    if (lockLive(lockFile(cfg))) { write(`另一轮还在跑，跳过\n${PRECHECK_OK}`); return 2; }
    const state = loadState(cfg.state, today);
    const plan = buildPlan(cfg, state);
    const go = doable(plan, state);
    write(`${go ? '有事可做' : '跳过'}：${planLines(plan, state).join('；')}\n${PRECHECK_OK}`);
    return go ? 0 : 2;
  }
  if (mode === 'status' || mode === 'plan') {
    const state = loadState(cfg.state, today);
    const plan = buildPlan(cfg, state);
    if (values.json) {
      const backfill = plan.backfill && Object.fromEntries(Object.entries(plan.backfill).map(([k, v]) => [k, { ...v, pendingPosts: v.pendingPosts?.map((p) => p.postId) }]));
      write(JSON.stringify({ ...plan, posts: undefined, backfill, doable: doable(plan, state), complete: isComplete(plan), plan: planLines(plan, state) }, null, 1));
    } else write((mode === 'status' ? statusLines(plan) : planLines(plan, state)).join('\n'));
    return 0;
  }
  process.stderr.write(`${USAGE}\n`);
  return 1;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === import.meta.filename) {
  main().then((code) => process.exit(code), (e) => { process.stderr.write(`daily.mjs 出错：${e.message}\n`); process.exit(1); });
}
