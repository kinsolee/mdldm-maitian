// hub ops collect：四个平台近 N 天作品和粉丝（只读），写进 ops.db。
// 每个账号起一个 runner 任务，在 space 里跑 collect-space.mjs → 平台模块的 fetchRaw；拿回 raw 后在宿主侧 map、校验、写库。
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { listAccounts, normalizeUid, PENDING } from './accounts.mjs';
import { ensureWorksTables, recordRun, saveCollected } from './works-db.mjs';
import { SCOPE, postsProblems, accountProblems } from './export.mjs';

// 抖音、小红书要翻页，每页间隔 2.5 秒，给足 5 分钟
const COLLECT_TIMEOUT_MS = 5 * 60_000;
const COLLECT_SPACE_URL = pathToFileURL(path.join(import.meta.dirname, 'collect-space.mjs')).href;
const SCRIPT = 'const { collectInSpace } = await import(params.collectSpaceUrl);\nreturn collectInSpace(task, params);';
// 跳过原因同 login.mjs；user-controlled 时 space 在负责人手里，不抢（不 takeOver）
const SKIP_CN = { 'profile-needed': 'Ego 里没有要用的 profile，需要负责人新建', 'user-controlled': '负责人正在手动操作这个 space', busy: '另一个任务正占着这个 space' };
const OUT_OF_SCOPE = { Instagram: 'Instagram 账号被锁，暂时跳过，不做任何自动操作' };

const loadRunner = async () => (await import('../ego-runner/index.mjs')).runEgoTask;
// 平台模块由 KIN-328 dev-2 写在 src/ops/works/；动态 import，测试注入假的时不需要它存在
const loadWorks = () => import('./works/index.mjs');
const iso = (ms) => new Date(ms).toISOString();

/** 退出码：有 uid-mismatch → 2；全部 ok → 0；有 ok 也有非 ok → 3（部分成功）；一个 ok 都没有 → 1。 */
export function exitCodeOf(rows) {
  if (rows.some((r) => r.result === 'uid-mismatch')) return 2;
  const ok = rows.filter((r) => r.result === 'ok').length;
  if (!ok) return 1;
  return ok === rows.length ? 0 : 3;
}

async function collectOne(db, a, ctx) {
  const { runId, now, days, nowMs } = ctx;
  const code = a.platformCode;
  const startedAt = iso(now());
  const finish = (result, extra = {}) => {
    const row = { runId, id: a.id, platformCode: code, uid: a.uid, startedAt, finishedAt: iso(now()), result, ...extra };
    recordRun(db, row);
    console.error(`[collect] ${a.id} ${result}${row.reason ? `(${row.reason})` : ''} ${row.message ?? ''}`);
    return row;
  };
  if (a.uid === PENDING) return finish('skipped', { reason: 'uid-pending', message: `uid 未登记，先跑 hub ops login --check --platform ${code}` });
  if (!a.capabilities.readWorks) return finish('skipped', { reason: 'capability-off', message: `能力位 readWorks 没开，没采。要开：hub ops accounts set-cap ${a.id} readWorks true` });

  const r = await ctx.runTask({ space: a.spaceName, profileId: a.profileId, timeoutMs: COLLECT_TIMEOUT_MS,
    params: { platformCode: code, moduleUrl: await ctx.moduleUrlOf(code), collectSpaceUrl: COLLECT_SPACE_URL, days, nowMs }, script: SCRIPT });
  if (!r.ok && SKIP_CN[r.reason]) return finish('skipped', { reason: r.reason, message: `跳过：${SKIP_CN[r.reason]}（${r.reason}），没采` });
  if (!r.ok) return finish('failed', { reason: r.reason, message: `runner 失败：${r.reason}${r.error ? ` ${String(r.error).slice(0, 160)}` : ''}` });

  let m;
  try { m = (await ctx.loadPlatform(code)).map(r.result, { days, nowMs }); }
  catch (e) { return finish('failed', { reason: 'map-failed', message: `映射失败：${String(e?.message ?? e).slice(0, 160)}` }); }
  if (!m || typeof m !== 'object' || typeof m.loggedIn !== 'boolean') return finish('failed', { reason: 'bad-map', message: 'map 结果结构不对（要有 loggedIn 布尔值），没写库' });
  if (!m.loggedIn) return finish('out', { reason: 'logged-out', message: `没登录，作品和粉丝都没写。扫码登录：hub ops login ${code}` });
  const seen = normalizeUid(m.uidSeen);
  if (!seen) return finish('failed', { reason: 'no-uid', message: `登录了但没读到 uid，没法核对（登记的是 ${a.uid}），没写库` });
  if (seen !== a.uid) return finish('uid-mismatch', { reason: 'uid-mismatch', uidSeen: seen, message: `UID 不符：登记的是 ${a.uid}，页面上看到的是 ${seen}。没写库，这个账号先别用，请核对 space ${a.spaceName} 登的是哪个号` });
  if (!Array.isArray(m.posts) || !m.account) return finish('failed', { reason: 'bad-map', message: 'map 结果结构不对（要有 posts 数组和 account），没写库' });

  // 不合格的记录不进库：否则之后每天的导出都会因为它整份不写；这次算失败，导出用上一次成功的
  const problems = [
    ...postsProblems(m.posts),
    ...m.posts.flatMap((p, i) => (p?.platform !== code ? [`第 ${i + 1} 条 platform：要是 ${code}`] : [])),
    ...accountProblems(m.account).map((x) => `account ${x}`),
    ...(m.account.uid !== a.uid ? [`account uid：要是 ${a.uid}，实际 ${m.account.uid}`] : []),
  ];
  if (problems.length) return finish('failed', { reason: 'bad-record', problems, message: `${problems.length} 处不合格，没写库：${problems.slice(0, 3).join('；')}` });

  try { saveCollected(db, { runId, platformCode: code, uid: a.uid, at: iso(now()), posts: m.posts, account: m.account }); }
  catch (e) { return finish('failed', { reason: 'db-failed', message: `写库失败，已整段回滚：${e.message}` }); }
  return finish('ok', { postCount: m.posts.length, message: `作品 ${m.posts.length} 条，粉丝 ${m.account.fans}` });
}

/**
 * opts: platforms（默认四个平台）；days（默认 30）；runTask（默认 runEgoTask）；loadPlatform、moduleUrlOf（默认 src/ops/works/index.mjs）；now。
 * 返回 { runId, rows, exitCode }。平台不在范围直接抛错（CLI 退出码 1）。
 */
export async function collectWorks(db, opts = {}) {
  const platforms = [...new Set(opts.platforms?.length ? opts.platforms : SCOPE)];
  for (const p of platforms) if (!SCOPE.includes(p)) throw new Error(OUT_OF_SCOPE[p] ?? `${p} 不在 S3 采集范围（只采 ${SCOPE.join('、')}）`);
  const days = opts.days ?? 30;
  if (!Number.isInteger(days) || days <= 0) throw new Error(`--days 要是正整数：${opts.days}`);
  ensureWorksTables(db);
  const now = opts.now ?? Date.now;
  const works = opts.loadPlatform && opts.moduleUrlOf ? null : await loadWorks();
  const ctx = {
    runId: `${iso(now())}-${randomBytes(3).toString('hex')}`, now, days, nowMs: now(),
    runTask: opts.runTask ?? (await loadRunner()), loadPlatform: opts.loadPlatform ?? works.loadPlatform, moduleUrlOf: opts.moduleUrlOf ?? works.moduleUrlOf,
  };
  // 各平台并行；同一平台多个账号依次跑（同一 space 的互斥由 runner 的 space 锁保证）
  const perPlatform = await Promise.all(platforms.map(async (code) => {
    const accounts = listAccounts(db, { platform: code });
    if (!accounts.length) {
      const at = iso(now());
      const row = { runId: ctx.runId, id: `${code}:-`, platformCode: code, uid: null, startedAt: at, finishedAt: at, result: 'skipped', reason: 'no-account', message: `表里没有 ${code} 的账号，先 hub ops accounts import` };
      recordRun(db, row);
      return [row];
    }
    const rows = [];
    for (const a of accounts) rows.push(await collectOne(db, a, ctx));
    return rows;
  }));
  const rows = perPlatform.flat();
  return { runId: ctx.runId, rows, exitCode: exitCodeOf(rows) };
}
