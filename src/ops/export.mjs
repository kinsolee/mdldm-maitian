// 导出给下游（vcat-backfill/backfill.py、kinso-dashboard/refresh.py）读的 posts-YYYYMMDD.json、accounts-YYYYMMDD.json，
// 和小V猫导出同形：顶层数组，作品记录原样写出。下游取目录里最新一份，所以宁可不写也不写残缺、空的文件。
import fs from 'node:fs';
import path from 'node:path';
import { ensureWorksTables } from './works-db.mjs';
import { shadowDir } from './paths.mjs';

/** S3 采集、导出的平台。和 src/ops/works/index.mjs 的 COLLECT_PLATFORMS 一致；refresh.py 也只认这四个。 */
export const SCOPE = ['Douyin', 'XiaoHongShu', 'Bili', 'Channels'];
export const DEFAULT_MAX_AGE_HOURS = 26;
const DAILY_DAYS = 30;
const METRICS = ['view', 'like', 'comment', 'favorite', 'forward', 'fansAdd'];
const OPTIONAL_NUMBERS = ['fullView', 'viewTime'];
// backfill.py 取 postTime 前 10 位当日期，refresh.py 用 datetime.fromisoformat 解析
const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isTime = (v) => typeof v === 'string' && LOCAL_TIME.test(v) && !Number.isNaN(Date.parse(v.replace(' ', 'T')));
const show = (v) => (v === undefined ? '没有' : JSON.stringify(v));

/** 东八区日期：dateCn(ms) → 'YYYY-MM-DD'。 */
export const dateCn = (ms) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);

/** 一条作品记录哪些字段下游读不了（规则同 scripts/ops-export-check.py）。返回问题列表，空的就是合格。 */
export function postProblems(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['不是对象'];
  const out = [];
  if (!SCOPE.includes(p.platform)) out.push(`platform：要是 ${SCOPE.join('/')} 之一，实际 ${show(p.platform)}`);
  if (typeof p.postId !== 'string' || !p.postId) out.push(`postId：要是非空字符串，实际 ${show(p.postId)}`);
  if (!isTime(p.postTime)) out.push(`postTime：要是 YYYY-MM-DD HH:mm:ss，实际 ${show(p.postTime)}`);
  if (typeof p.statusText !== 'string') out.push(`statusText：要是字符串，实际 ${show(p.statusText)}`);
  for (const k of METRICS) if (p[k] != null && !isNum(p[k])) out.push(`${k}：要是数字、-1 或 null，实际 ${show(p[k])}`);
  for (const k of OPTIONAL_NUMBERS) if (p[k] != null && !isNum(p[k])) out.push(`${k}：要是数字或 null，实际 ${show(p[k])}`);
  return out;
}

/** 一条账号记录（{uid, loginStatus, fans, updateTime, daily}）哪些字段 refresh.py 读不了。 */
export function accountProblems(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return ['不是对象'];
  const out = [];
  if (typeof a.uid !== 'string' || !a.uid) out.push(`uid：要是非空字符串，实际 ${show(a.uid)}`);
  if (a.loginStatus !== '登录有效') out.push(`loginStatus：要是「登录有效」，实际 ${show(a.loginStatus)}`);
  // 粉丝总数接口失败时平台模块给 null（作品照常完整）；refresh.py 的 ingest_accounts 遇到空的 fans 会跳过，不会出错
  if (a.fans !== null && !isNum(a.fans)) out.push(`fans：要是数字或 null，实际 ${show(a.fans)}`);
  if (!isTime(a.updateTime)) out.push(`updateTime：要是 YYYY-MM-DD HH:mm:ss，实际 ${show(a.updateTime)}`);
  if (!Array.isArray(a.daily)) out.push(`daily：要是数组，实际 ${show(a.daily)}`);
  else a.daily.forEach((d, i) => {
    if (!DATE.test(d?.date ?? '')) out.push(`daily[${i}].date：要是 YYYY-MM-DD，实际 ${show(d?.date)}`);
    for (const k of ['fansTotal', 'fansNet']) if (d?.[k] != null && !isNum(d[k])) out.push(`daily[${i}].${k}：要是数字或 null，实际 ${show(d[k])}`);
  });
  return out;
}

/** 一批作品：逐条校验，再查 (platform, postId) 重复。返回 ['<平台> <postId> 字段：…', …]。 */
export function postsProblems(posts) {
  const out = [], seen = new Set();
  posts.forEach((p, i) => {
    const label = `第 ${i + 1} 条（${p?.platform ?? '?'} ${p?.postId ?? '?'}）`;
    for (const x of postProblems(p)) out.push(`${label} ${x}`);
    const key = `${p?.platform}\u0000${p?.postId}`;
    if (seen.has(key)) out.push(`${label} postId：同一平台重复`);
    seen.add(key);
  });
  return out;
}

// posts 只取采了 POSTS_MIN_DAYS 天及以上的采集：refresh.py 读最新一份 posts，短窗口的会让看板丢掉更早的期数。
// days 为 NULL 的是加 days 列之前的旧行，可能是短窗口，也不算。
export const POSTS_MIN_DAYS = 30;

// 每个平台最近一次（minDays 时还要天数够）ok 的采集；没有或太旧的放进 excluded
function latestRuns(db, { maxAgeHours, now, minDays }) {
  const runs = [], excluded = [];
  const latest = db.prepare("SELECT runId, uid, finishedAt, days FROM collect_runs WHERE platformCode = ? AND result = 'ok' ORDER BY finishedAt DESC, rowid DESC LIMIT 1");
  const latestLong = db.prepare("SELECT runId, uid, finishedAt, days FROM collect_runs WHERE platformCode = ? AND result = 'ok' AND days >= ? ORDER BY finishedAt DESC, rowid DESC LIMIT 1");
  for (const platformCode of SCOPE) {
    const any = latest.get(platformCode);
    if (!any) { excluded.push({ platformCode, reason: '从没成功采集过' }); continue; }
    const r = minDays ? latestLong.get(platformCode, minDays) : any;
    if (!r) {
      const why = any.days == null ? '最近一次 ok 采集没记采集天数（加 days 列之前的旧记录）' : `最近一次 ok 采集只采了 ${any.days} 天`;
      excluded.push({ platformCode, uid: any.uid, runId: any.runId, reason: `${why}，没有采满 ${minDays} 天的 ok 采集；跑一次 hub ops collect（默认 30 天）` });
      continue;
    }
    const ageH = (now() - Date.parse(r.finishedAt)) / 3600_000;
    if (ageH > maxAgeHours) { excluded.push({ platformCode, uid: r.uid, runId: r.runId, reason: `最近一次成功采集在 ${r.finishedAt}（${ageH.toFixed(1)} 小时前，超过 ${maxAgeHours} 小时）` }); continue; }
    runs.push({ platformCode, ...r });
  }
  return { runs, excluded };
}

function writeAtomic(file, list) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try { fs.writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`); fs.renameSync(tmp, file); }
  catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

/**
 * 共用：取各平台最近一次 ok 的采集 → build(run) 出记录 → 校验 → 写文件。
 * 退出码：0 四个平台都导出；3 有平台没导出（太旧或没成功过）；1 一个都没有、或校验不合格（这两种都不写文件）。
 */
function exportKind(db, kind, build, check, { out, date, maxAgeHours = DEFAULT_MAX_AGE_HOURS, now = Date.now, minDays } = {}) {
  if (date != null && !/^\d{8}$/.test(date)) throw new Error(`--date 要写成 YYYYMMDD：${date}`);
  if (!(maxAgeHours > 0)) throw new Error(`--max-age-hours 要是正数：${maxAgeHours}`);
  const file = path.join(out ?? shadowDir(), `${kind}-${date ?? dateCn(now()).replaceAll('-', '')}.json`);
  const { runs, excluded } = latestRuns(db, { maxAgeHours, now, minDays });
  const exported = [], list = [];
  for (const run of runs) {
    const records = build(run);
    list.push(...records);
    exported.push({ platformCode: run.platformCode, uid: run.uid, runId: run.runId, finishedAt: run.finishedAt, count: records.length });
  }
  const base = { kind, file: null, exported, excluded };
  if (!runs.length) return { ...base, exitCode: 1, message: `没有可导出的平台，没写 ${file}（写空文件会把下游看板清空）` };
  const problems = check(list);
  if (problems.length) return { ...base, problems, exitCode: 1, message: `${problems.length} 处不合格，整份没写 ${file}` };
  writeAtomic(file, list);
  return { ...base, file, count: list.length, exitCode: excluded.length ? 3 : 0 };
}

export function exportPosts(db, opts = {}) {
  ensureWorksTables(db);   // 没采过的库也能跑（返回退出码 1）
  const q = db.prepare('SELECT record FROM work_snapshots WHERE runId = ? AND platformCode = ? AND uid = ? ORDER BY rowid');
  return exportKind(db, 'posts', (run) => q.all(run.runId, run.platformCode, run.uid).map((r) => JSON.parse(r.record)), postsProblems, { ...opts, minDays: POSTS_MIN_DAYS });
}

export function exportAccounts(db, opts = {}) {
  ensureWorksTables(db);
  const now = opts.now ?? Date.now;
  const since = dateCn(now() - DAILY_DAYS * 86400_000);
  const snap = db.prepare('SELECT record FROM account_snapshots WHERE runId = ? AND platformCode = ? AND uid = ?');
  const daily = db.prepare('SELECT date, fansTotal, fansNet FROM fans_daily WHERE platformCode = ? AND uid = ? AND date > ? ORDER BY date');
  const build = (run) => {
    const a = JSON.parse(snap.get(run.runId, run.platformCode, run.uid).record);
    // 分日取 fans_daily 累积的（每次采集只补 null 不盖掉旧值），不取这次快照里的
    return [{ uid: a.uid, loginStatus: a.loginStatus, fans: a.fans, updateTime: a.updateTime, daily: daily.all(run.platformCode, run.uid, since).map((d) => ({ ...d })) }];
  };
  const check = (list) => list.flatMap((a) => accountProblems(a).map((x) => `${a.uid} ${x}`));
  return exportKind(db, 'accounts', build, check, { ...opts, now });
}
