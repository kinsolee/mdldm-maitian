#!/usr/bin/env node
// 每日数据流程（KIN-339）：给 Cindy 脚本自动化用的幂等调度命令。自己不采也不写数据，只调用现有的采集命令和库外的收口脚本。
//   check    前置检查（preRunHook）：今天有事可做 exit 0，没有（做完了、在等负责人扫码、空间被占着）exit 2；出错 exit 1。只读。
//   run      把今天能做的做完。stdout 只写一行 cindy-script/1 完成帧；需要负责人动手或某一步出错时，摘要同时写在 stderr 末尾并 exit 1。
//   status   只读：今天每一步的情况（--json 输出 JSON）。
//   plan     只读预演：下一次 run 会执行什么。
// 「今天做没做」全部从数据本身判断（采集记录、数据笔记的抓取时间、看板数据文件的修改时间），状态文件只记失败要重试的步骤和已经提醒过的事。
// 详见 docs/migration/S3-works.md 的「定时」一节。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, opsDbPath, shadowDir } from '../../src/ops/paths.mjs';
import { dateCn } from '../../src/ops/export.mjs';
import { stableNodeExecPath } from '../../src/ops/node-bin.mjs';

export const PROTOCOL = 'cindy-script/1';
const PLATFORMS = [['Douyin', '抖音'], ['XiaoHongShu', '小红书'], ['Bili', 'B站'], ['Channels', '视频号']];
const LABEL = Object.fromEntries(PLATFORMS);
const NOTE_PLATFORM = { Douyin: '抖音', XiaoHongShu: '小红书', Bili: '哔哩哔哩', Channels: '视频号' };   // 数据笔记 frontmatter 里的 platform
const CLOSER_TOOLS = ['python3', 'lark-cli', 'ego-browser'];   // 收口脚本要用的命令：笔记和看板、飞书、Ego 后台抓取
const BUSY_WINDOW_MS = 30 * 60_000;     // 评论私信同步 running 超过这么久不再当成占着空间（进程可能早就退了）
const LOCK_STALE_MS = 25 * 60_000;      // Cindy 整轮超时 20 分钟，超过这个时间的锁当成上一轮没收尾
const COLLECT_TIMEOUT_MS = 8 * 60_000;
const CLOSER_TIMEOUT_MS = 10 * 60_000;
const LOGIN_RE = /LOGIN|未登录/;

const USAGE = `用法：node integrations/cindy/daily.mjs check|run|status|plan [--closer <收口脚本>] [--vault <知识库根>] [--dashboard-data <看板 data.js>] [--state <状态文件>] [--retry-waiting] [--json]
  --closer 不传（也没有 MAITIAN_DAILY_CLOSER）时只做采集，回填写「未配置」。
  --retry-waiting：手动补跑时用，连「在等负责人」的平台也重试一次。
  路径也能用环境变量改：MAITIAN_OPS_DB、MAITIAN_OPS_SHADOW_DIR、MAITIAN_DAILY_VAULT、MAITIAN_DAILY_DASHBOARD、MAITIAN_DAILY_STATE、MAITIAN_DAILY_CLOSER。`;

export function readConfig(values = {}, env = process.env) {
  const home = env.HOME || os.homedir();
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
    mpProbeMs: Number(env.MAITIAN_DAILY_MP_PROBE_MINUTES || 60) * 60_000,
    retryWaiting: !!values['retry-waiting'],
  };
}

// ---------- 读数据（全部只读） ----------

const mtime = (file) => { try { return fs.statSync(file).mtimeMs; } catch { return null; } };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw new Error(`读不了 ${file}：${e.message}`); } };
const asList = (v) => (Array.isArray(v) ? v : Array.isArray(v?.list) ? v.list : []);

function readDb(file, sinceIso, now) {
  if (!fs.existsSync(file)) throw new Error(`找不到 ops.db：${file}`);
  const db = new DatabaseSync(file, { readOnly: true, timeout: 5000 });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    const runs = tables.has('collect_runs')
      ? db.prepare('SELECT platformCode, finishedAt, result, reason, message FROM collect_runs WHERE finishedAt >= ? ORDER BY finishedAt').all(sinceIso).map((r) => ({ ...r }))
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
        if (fm.type === '平台数据') out.push({ platform: fm.platform, postId: fm.post_id, fetchedAt: fm.fetched_at || '', dailyFetchedAt: fm.daily_fetched_at || '' });
      }
    }
  };
  walk(base);
  return out;
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
  return null;
}

/**
 * 今天的计划。每一步 status：done 做完；todo 本轮可做；waiting 在等负责人；busy 空间被占着，下一轮再说；
 * off 能力位关着，不算今天要做的；blocked 前一步没做完；unconfigured 没配置收口脚本；env 环境缺命令。
 */
export function buildPlan(cfg, state) {
  const today = dateCn(cfg.now);
  const compact = today.replaceAll('-', '');
  const { runs, syncOk, busy } = readDb(cfg.opsDb, new Date(Date.parse(`${today}T00:00:00+08:00`)).toISOString(), cfg.now);
  const postsFile = path.join(cfg.shadow, `posts-${compact}.json`);
  const accountsFile = path.join(cfg.shadow, `accounts-${compact}.json`);
  const posts = asList(readJson(postsFile));
  const notes = scanNotes(cfg.vault);
  const isToday = (s) => typeof s === 'string' && s.startsWith(today);
  const recovered = (code, sinceIso) => !!syncOk[code] && syncOk[code] > sinceIso;   // 失败之后守护进程的评论私信同步又成功过：登录已恢复

  const collect = {};
  for (const [code] of PLATFORMS) {
    const rows = runs.filter((r) => r.platformCode === code);
    const ok = rows.filter((r) => r.result === 'ok').at(-1);
    const last = rows.at(-1);
    let s;
    if (ok) s = { status: 'done', at: ok.finishedAt };
    else if (!last) s = { status: 'todo' };
    else if (last.result === 'skipped' && last.reason === 'capability-off') s = { status: 'off' };
    else if (humanNeed(last)) {
      s = recovered(code, last.finishedAt) || cfg.retryWaiting ? { status: 'todo' }
        : { status: 'waiting', need: humanNeed(last), key: `collect:${code}:${last.reason ?? last.result}` };
    } else s = { status: 'todo', last: last.result === 'failed' ? `上次失败：${last.message ?? '原因不明'}` : `上次跳过（${last.reason}）` };
    if (s.status === 'todo' && busy.has(code)) s = { ...s, status: 'busy' };
    collect[code] = s;
  }
  const doneAt = Object.values(collect).filter((c) => c.status === 'done').map((c) => Date.parse(c.at));
  const exportAt = mtime(postsFile);
  const exportStale = doneAt.length > 0 && (exportAt == null || mtime(accountsFile) == null || Math.max(...doneAt) > Math.min(exportAt, mtime(accountsFile)));

  const env = [];
  if (cfg.closer) {
    try { fs.accessSync(cfg.closer, fs.constants.X_OK); } catch { env.push({ key: 'env:closer', need: `找不到收口脚本或没有执行权限：${cfg.closer}` }); }
    for (const t of CLOSER_TOOLS) if (!onPath(t, cfg.childPath)) env.push({ key: `env:${t}`, need: `子进程的 PATH 里找不到 ${t}（PATH=${cfg.childPath}）` });
  }
  const closerState = !cfg.closer ? 'unconfigured' : env.length ? 'env' : null;

  // 同一条作品可能有两篇笔记（backfill.py 只更新它先找到的那篇），有一篇今天抓过就算回填过
  const fetchedToday = new Set(notes.filter((n) => isToday(n.fetchedAt)).map((n) => String(n.postId)));
  const backfill = {};
  for (const [code] of PLATFORMS) {
    if (collect[code].status === 'off') { backfill[code] = { status: 'off' }; continue; }
    if (collect[code].status !== 'done') { backfill[code] = { status: 'blocked' }; continue; }
    const mine = posts.filter((p) => p.platform === code);
    const done = !exportStale && mine.every((p) => fetchedToday.has(String(p.postId)));
    backfill[code] = { status: done ? 'done' : closerState ?? 'todo', posts: mine.length };
  }

  let channels;
  if (notes.some((n) => n.platform === '视频号' && isToday(n.dailyFetchedAt)) || state.channelsOk === today) channels = { status: 'done' };
  else if (closerState) channels = { status: closerState };
  else if (collect.Channels.status === 'waiting') channels = { status: 'waiting', need: collect.Channels.need, key: collect.Channels.key };
  else if (state.channelsLoginAt && !recovered('Channels', state.channelsLoginAt) && !cfg.retryWaiting) channels = { status: 'waiting', need: CHANNELS_LOGIN, key: 'channels:login' };
  else channels = { status: 'todo' };

  let mp;
  if (notes.some((n) => n.platform === '公众号' && isToday(n.fetchedAt)) || state.mpOk === today) mp = { status: 'done' };
  else if (closerState) mp = { status: closerState };
  else if (state.mpLoginAt && cfg.now - Date.parse(state.mpProbeAt ?? state.mpLoginAt) < cfg.mpProbeMs && !cfg.retryWaiting) {
    mp = { status: 'waiting', need: MP_LOGIN, key: 'mp:login', nextProbe: new Date(Date.parse(state.mpProbeAt ?? state.mpLoginAt) + cfg.mpProbeMs).toISOString() };
  } else mp = { status: 'todo', ...(state.mpLoginAt ? { probe: true } : {}) };

  const dashToday = mtime(cfg.dashboard) != null && dateCn(mtime(cfg.dashboard)) === today;
  const sync = closerState ? { status: closerState } : { status: dashToday && !state.syncFailed ? 'done' : 'todo', ...(state.syncFailed ? { last: '上次同步失败' } : {}) };

  return { date: today, postsFile, accountsFile, posts, collect, exportStale, env, backfill, channels, mp, sync, closer: cfg.closer };
}

const CHANNELS_LOGIN = '视频号助手在 Ego 里未登录：在 Ego 里扫码登录 channels.weixin.qq.com';
const MP_LOGIN = '公众号后台在 Ego 里未登录：在 Ego 里扫码登录 mp.weixin.qq.com';

const closerSteps = (plan) => [...Object.values(plan.backfill), plan.channels, plan.mp, plan.sync];
const closerTodo = (plan) => closerSteps(plan).some((s) => s.status === 'todo');
/** 要负责人动手、今天还没提醒过的。 */
function unnotified(plan, state) {
  const items = [...Object.values(plan.collect), plan.channels, plan.mp, ...plan.env].filter((s) => s.key && (s.status === 'waiting' || s.key.startsWith('env:')));
  const seen = new Set();
  return items.filter((s) => !state.notified?.[s.key] && !seen.has(s.key) && seen.add(s.key));
}
export function doable(plan, state) {
  return Object.values(plan.collect).some((c) => c.status === 'todo') || plan.exportStale || closerTodo(plan) || unnotified(plan, state).length > 0;
}
const isComplete = (plan) => Object.values(plan.collect).every((c) => ['done', 'off'].includes(c.status))
  && (!plan.closer || closerSteps(plan).every((s) => ['done', 'off'].includes(s.status)));

// ---------- 文字 ----------

const WORD = { done: '做完', todo: '待做', waiting: '在等负责人', busy: '空间被占着，下一轮再试', off: '能力位关着，不做', blocked: '等采集', unconfigured: '未配置', env: '环境缺命令' };
export function statusLines(plan) {
  const w = (s) => `${WORD[s.status] ?? s.status}${s.need ? `（${s.need}）` : ''}${s.last ? `（${s.last}）` : ''}`;
  return [
    `日期：${plan.date}`,
    ...PLATFORMS.map(([c, l]) => `采集 ${l}：${w(plan.collect[c])}`),
    ...(plan.exportStale ? ['影子导出：比采集旧，要重新导出'] : []),
    ...PLATFORMS.map(([c, l]) => `回填笔记 ${l}：${w(plan.backfill[c])}${plan.backfill[c].posts != null ? `，${plan.backfill[c].posts} 条作品` : ''}`),
    `视频号分日：${w(plan.channels)}`,
    `公众号阅读：${w(plan.mp)}${plan.mp.nextProbe ? `，${plan.mp.nextProbe} 后再探` : ''}`,
    `飞书和看板：${w(plan.sync)}`,
    ...plan.env.map((e) => `环境：${e.need}`),
    ...(plan.closer ? [] : ['回填：未配置（没传 --closer），只做采集']),
  ];
}
export function planLines(plan, state) {
  const out = [];
  const todo = PLATFORMS.filter(([c]) => plan.collect[c].status === 'todo');
  if (todo.length) out.push(`采集：hub ops collect --export --json ${todo.map(([c]) => c).join(' ')}`);
  if (plan.exportStale) out.push('导出：影子导出比采集旧，跑 hub ops export posts / accounts');
  if (closerTodo(plan) || todo.length) {
    const back = PLATFORMS.filter(([c]) => plan.backfill[c].status === 'todo' || (plan.collect[c].status === 'todo' && plan.closer));
    out.push(`回填：收口脚本，笔记只传 ${back.length ? back.map(([, l]) => l).join('、') : '（无）'} 的作品；${plan.channels.status === 'todo' ? '跑' : '跳过'}视频号分日；${plan.mp.status === 'todo' ? '跑' : '跳过'}公众号；同步飞书和看板`);
  }
  if (!plan.closer) out.push('回填：未配置（没传 --closer），跳过');
  for (const u of unnotified(plan, state)) out.push(`提醒：${u.need}`);
  return out.length ? out : ['没有要做的：今天已做完，或者在等负责人'];
}

// ---------- 状态文件、锁、子进程 ----------

function loadState(file, today) {
  const s = readJson(file);
  return s?.date === today ? s : { date: today, notified: {} };
}
function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 1)}\n`);
  fs.renameSync(tmp, file);
}
const lockFile = (cfg) => `${cfg.state}.lock`;
const lockHeld = (cfg) => { const m = mtime(lockFile(cfg)); return m != null && Date.now() - m < LOCK_STALE_MS; };
function takeLock(cfg) {
  fs.mkdirSync(path.dirname(cfg.state), { recursive: true });
  if (lockHeld(cfg)) return false;
  fs.rmSync(lockFile(cfg), { force: true });
  try { fs.writeFileSync(lockFile(cfg), String(process.pid), { flag: 'wx' }); return true; } catch { return false; }
}

/** 起子进程：stdout 收下来解析，stderr 原样转到自己的 stderr（Cindy 的运行记录里看得到）。 */
function runChild(cmd, args, { env, timeoutMs }) {
  return new Promise((resolve) => {
    let out = '', errTail = '', timedOut = false;
    const child = spawn(cmd[0], [...cmd.slice(1), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { process.stderr.write(d); errTail = (errTail + d).slice(-600); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: e.message, json: null }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let json = null;
      try { json = JSON.parse(out.slice(out.indexOf('{'))); } catch { /* 下面按 json 为空处理 */ }
      resolve({ code: timedOut ? -1 : code, out, err: timedOut ? `超过 ${timeoutMs / 60_000} 分钟没跑完，已停掉` : errTail.trim(), json });
    });
  });
}

// ---------- run ----------

async function runOnce(cfg) {
  const today = dateCn(cfg.now);
  const state = loadState(cfg.state, today);
  const errors = [], progress = [];
  const childEnv = { ...process.env, PATH: cfg.childPath };
  let plan = buildPlan(cfg, state);
  if (!doable(plan, state)) {
    return { ok: true, text: isComplete(plan) ? `今天的数据流程已做完，没有要做的。${plan.closer ? '' : '回填未配置。'}` : `本轮没有要做的，还在等：${waitingText(plan)}` };
  }

  // 1. 采集今天还没成功的平台
  const todo = PLATFORMS.filter(([c]) => plan.collect[c].status === 'todo').map(([c]) => c);
  if (todo.length) {
    const r = await runChild(cfg.collectCmd, ['collect', '--export', '--json', ...todo], { env: childEnv, timeoutMs: COLLECT_TIMEOUT_MS });
    if (!r.json || ![0, 1, 2, 3].includes(r.code)) errors.push(`采集命令出错（退出码 ${r.code}）：${r.err || r.out.slice(-300)}`);
    for (const row of r.json?.rows ?? []) {
      const l = LABEL[row.platformCode] ?? row.platformCode;
      if (row.result === 'ok') progress.push(`${l}采集成功`);
      else if (row.result === 'failed') errors.push(`${l}采集失败：${row.message ?? '原因不明'}`);
      else if (row.result === 'skipped' && ['busy', 'user-controlled'].includes(row.reason)) progress.push(`${l}这轮没采（${row.reason === 'busy' ? '空间被评论私信同步占着' : '负责人正在操作'}），下一轮再试`);
    }
    for (const e of ['posts', 'accounts']) { const x = r.json?.export?.[e]; if (x && x.exitCode === 1) errors.push(`导出 ${e} 不合格：${x.message ?? (x.problems ?? []).join('；')}`); }
    plan = buildPlan(cfg, state);
  }

  // 2. 影子导出比采集旧（例如手动跑过不带 --export 的采集）：重新导出
  if (plan.exportStale) {
    for (const kind of ['posts', 'accounts']) {
      const r = await runChild(cfg.collectCmd, ['export', kind, '--json'], { env: childEnv, timeoutMs: COLLECT_TIMEOUT_MS });
      if (![0, 3].includes(r.code)) errors.push(`导出 ${kind} 出错（退出码 ${r.code}）：${r.err || r.json?.message || ''}`);
    }
    plan = buildPlan(cfg, state);
  }

  // 3. 收口脚本：笔记只传今天还没回填的平台；做完的分日和公众号用跳过开关跳过；看板用完整的作品文件
  if (closerTodo(plan) && !plan.exportStale) {
    const back = PLATFORMS.filter(([c]) => plan.backfill[c].status === 'todo').map(([c]) => c);
    const subset = path.join(path.dirname(cfg.state), `daily-posts-${plan.date.replaceAll('-', '')}.json`);
    fs.mkdirSync(path.dirname(subset), { recursive: true });
    fs.writeFileSync(subset, JSON.stringify(plan.posts.filter((p) => back.includes(p.platform))));
    const args = ['--posts', subset, '--vault', cfg.vault, '--source', '麦田', '--dashboard-posts', fs.existsSync(plan.postsFile) ? plan.postsFile : subset];
    if (fs.existsSync(plan.accountsFile)) args.push('--accounts', plan.accountsFile);
    if (plan.channels.status !== 'todo') args.push('--skip-channels');
    if (plan.mp.status !== 'todo') args.push('--skip-mp');
    const r = await runChild([cfg.closer], args, { env: childEnv, timeoutMs: CLOSER_TIMEOUT_MS });
    const s = r.json ?? {};
    if (r.code === 3) errors.push(`笔记回填失败（backfill.py）：${(s.errors ?? []).join('；') || r.err}`);
    else if (r.code !== 0 && r.code !== 4) errors.push(`收口脚本出错（退出码 ${r.code}）：${(s.errors ?? []).join('；') || r.err}`);
    else {
      if (back.length) progress.push(`回填了${back.map((c) => LABEL[c]).join('、')}的笔记`);
      if (plan.channels.status === 'todo') {
        const skipped = s.channels_daily?.skipped;
        if (!skipped) { state.channelsOk = today; delete state.channelsLoginAt; progress.push('视频号分日已更新'); }
        else if (LOGIN_RE.test(skipped)) state.channelsLoginAt = new Date(cfg.now).toISOString();
        else errors.push(`视频号分日失败：${skipped}`);
      }
      if (plan.mp.status === 'todo') {
        if (s.mp?.ok) { state.mpOk = today; delete state.mpLoginAt; delete state.mpProbeAt; progress.push('公众号阅读已更新'); }
        else if (LOGIN_RE.test(s.mp?.error ?? '')) { state.mpLoginAt ??= new Date(cfg.now).toISOString(); state.mpProbeAt = new Date(cfg.now).toISOString(); if (state.notified?.['mp:login']) progress.push('公众号后台仍未登录'); }
        else errors.push(`公众号阅读失败：${s.mp?.error || '原因不明'}`);
      }
      const syncErr = (s.errors ?? []).filter((e) => /^(feishu_sync|账号日数据同步飞书|工作台)/.test(e));
      state.syncFailed = syncErr.length > 0;
      errors.push(...syncErr.map((e) => `飞书和看板同步失败：${e}`));
      errors.push(...(s.errors ?? []).filter((e) => !syncErr.includes(e) && !e.startsWith('公众号后台')));
      if (!state.syncFailed) progress.push('飞书和看板已同步');
    }
    plan = buildPlan(cfg, state);
  }

  // 4. 当天第一次发现要负责人动手的：这一轮以失败结束一次，之后同样的情况不再提醒
  const fresh = unnotified(plan, state);
  state.notified ??= {};
  for (const u of fresh) state.notified[u.key] = new Date(cfg.now).toISOString();
  saveState(cfg.state, state);

  const status = `进度：${progress.length ? progress.join('；') : '无'}`;
  if (errors.length || fresh.length) {
    return { ok: false, text: ['今天的数据流程这一轮没走完。', ...fresh.map((u) => `需要你：${u.need}`), ...errors.map((e) => `出错：${e}（下一轮自动重试）`), status].join('\n') };
  }
  if (isComplete(plan)) return { ok: true, text: `今天的数据流程全部做完${plan.closer ? '：采集、回填、视频号分日、公众号阅读、飞书和看板' : '：采集完成；回填未配置（没传 --closer），跳过'}。\n${status}` };
  return { ok: true, text: `本轮推进了，还没做完。${status}\n还差：${waitingText(plan)}` };
}

function waitingText(plan) {
  const out = [];
  for (const [c, l] of PLATFORMS) if (!['done', 'off'].includes(plan.collect[c].status)) out.push(`${l}采集（${WORD[plan.collect[c].status]}）`);
  if (plan.closer) {
    if (!['done', 'blocked', 'off'].includes(plan.channels.status)) out.push(`视频号分日（${WORD[plan.channels.status]}）`);
    if (plan.mp.status !== 'done') out.push(`公众号阅读（${WORD[plan.mp.status]}）`);
    if (plan.sync.status !== 'done') out.push(`飞书和看板（${WORD[plan.sync.status]}）`);
  }
  return out.join('、') || '无';
}

// ---------- 入口 ----------

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    closer: { type: 'string' }, vault: { type: 'string' }, 'dashboard-data': { type: 'string' }, state: { type: 'string' },
    'retry-waiting': { type: 'boolean', default: false }, json: { type: 'boolean', default: false },
  } });
  const [mode] = positionals;
  const cfg = readConfig(values, env);
  const today = dateCn(cfg.now);
  const write = (s) => process.stdout.write(`${s}\n`);
  if (mode === 'check') {
    if (lockHeld(cfg)) { write('另一轮还在跑，跳过'); return 2; }
    const state = loadState(cfg.state, today);
    const plan = buildPlan(cfg, state);
    const go = doable(plan, state);
    write(go ? `有事可做：${planLines(plan, state).join('；')}` : `跳过：${planLines(plan, state).join('；')}`);
    return go ? 0 : 2;
  }
  if (mode === 'status' || mode === 'plan') {
    const state = loadState(cfg.state, today);
    const plan = buildPlan(cfg, state);
    if (values.json) write(JSON.stringify({ ...plan, posts: undefined, doable: doable(plan, state), complete: isComplete(plan), plan: planLines(plan, state) }, null, 1));
    else write((mode === 'status' ? statusLines(plan) : planLines(plan, state)).join('\n'));
    return 0;
  }
  if (mode === 'run') {
    const frame = (text) => write(JSON.stringify({ protocol: PROTOCOL, type: 'complete', resultText: text.slice(0, 8000) }));
    if (!takeLock(cfg)) { frame('另一轮还在跑，本轮跳过。'); return 0; }
    try {
      const r = await runOnce(cfg);
      frame(r.text);
      if (!r.ok) process.stderr.write(`\n${r.text}\n`);   // Cindy 失败通知取 stderr 末尾
      return r.ok ? 0 : 1;
    } catch (e) {
      const text = `每日数据流程出错：${e.message}`;
      frame(text);
      process.stderr.write(`\n${text}\n`);
      return 1;
    } finally { fs.rmSync(lockFile(cfg), { force: true }); }
  }
  process.stderr.write(`${USAGE}\n`);
  return 1;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === import.meta.filename) {
  main().then((code) => process.exit(code), (e) => { process.stderr.write(`daily.mjs 出错：${e.message}\n`); process.exit(1); });
}
