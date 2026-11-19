// 短进程 runner：每个任务起一个 ego-browser nodejs 子进程，脚本从 stdin 传入，
// 子进程最后一行打印 `@@RESULT <json>`，这里解析成结果。没有这一行、JSON 坏、退出码非零都是失败。
// 实测：ego-browser CLI 把脚本的 console.log 全写到它自己的 stderr（stdout 为空），所以解析 stdout+stderr。
//
// ego-browser nodejs 的脚本不继承环境变量、不在本进程的工作目录里跑，
// 所以参数以 JSON 字面量写进脚本前言，模块用 file:// 绝对地址加载（已实测可以 import 本地 ESM）。
//
// space 锁：runEgoTask / finishSpace 起子进程前先取该 space 的文件锁，拿不到立即返回 busy，不排队。
// 杀掉 CLI 停不掉 Ego 里的脚本（spikes/results/03），所以脚本自己写心跳文件、到截止时间自己退出；
// runner 超时后要等心跳确认旧脚本停了才释放锁，没停就把锁留给它（见 locks.mjs 的 orphanLock）。
import { spawn } from 'node:child_process';
import { ALLOWED_PROFILES, profileAllowed } from './space.mjs';
import { locksDir as defaultLocksDir, orphanLock, releaseLock, spaceLockPath, tryLock, waitQuiet } from './locks.mjs';

export const DEFAULT_PROFILE = 'Profile 5';
export const DEFAULT_PLUGIN_DIR = '/Users/kinso/code/github/kinsolee/mdldm-maitian-publisher';
export const RESULT_PREFIX = '@@RESULT ';
// 前言判定的失败（截止时间到、profile 不存在、space 由用户控制…）打一行 `@@FAIL {"reason","error"}` 再以非零退出
export const FAIL_PREFIX = '@@FAIL ';
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** 失败原因 → 命令行退出码；成功 0，表里没有的失败 1。 */
export const EXIT_CODES = Object.freeze({ 'profile-needed': 3, 'user-controlled': 4, busy: 5 });
export const exitCodeOf = (r) => (r.ok ? 0 : EXIT_CODES[r.reason] ?? 1);
const SPACE_NAME = /^kinso\/[a-z0-9_-]+\/[^/\s]+$/i;
const EGO_NOTICE = /^\[ego-browser:/;

const SHIM_URL = new URL('../ego-shim.mjs', import.meta.url).href;
const SPACE_URL = new URL('./space.mjs', import.meta.url).href;

/** 从子进程输出里取结果：最后一个非空、非 Ego 提示的行必须是 `@@RESULT <json>`，且退出码为 0。 */
export function parseResult(output, code) {
  const lines = output.split('\n').map((l) => l.trimEnd()).filter((l) => l && !EGO_NOTICE.test(l));
  if (code !== 0) {
    const fail = lines.findLast((l) => l.startsWith(FAIL_PREFIX));
    if (fail) {
      try { const { reason, error } = JSON.parse(fail.slice(FAIL_PREFIX.length)); return { ok: false, reason, code, error }; }
      catch { /* 坏的 @@FAIL 行按普通退出码失败处理 */ }
    }
    return { ok: false, reason: 'exit-code', code, error: `ego-browser nodejs 退出码 ${code}` };
  }
  const last = lines.at(-1) ?? '';
  if (!last.startsWith(RESULT_PREFIX)) return { ok: false, reason: 'no-result', error: '最后一行不是 @@RESULT' };
  try { return { ok: true, result: JSON.parse(last.slice(RESULT_PREFIX.length)) }; }
  catch (e) { return { ok: false, reason: 'bad-json', error: `@@RESULT 不是合法 JSON：${e.message}` }; }
}

/** 原样跑一段 ego-browser nodejs 脚本（不加前言），返回 { ok, result | reason, error, code, stdout, stderr }。 */
export function runEgoScript(source, { egoBin = 'ego-browser', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', settled = false, timedOut = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ stdout, stderr, ...r }); } };
    const child = spawn(egoBin, ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => done({ ok: false, reason: 'spawn-failed', error: e.message }));
    child.on('close', (code, signal) => {
      // 实测：不带 --session 时杀掉 CLI 不会停掉 Ego Node 服务里的脚本（spikes/results/03）
      if (timedOut) return done({ ok: false, reason: 'timeout', error: `超过 ${timeoutMs}ms，已杀掉 ego-browser CLI；脚本可能仍在 Ego 里跑`, code });
      done({ ...parseResult(stdout + stderr, code ?? (signal ? 128 : 1)), code: code ?? null, signal });
    });
    child.stdin.on('error', () => { /* 子进程没起来时写 stdin 会报 EPIPE，结果由 error/close 给出 */ });
    child.stdin.end(source);
  });
}

/**
 * 把任务脚本包上前言：取用 space、装好 chrome 垫片、提供 params / loadPlugin / withFocus，最后把返回值打成 @@RESULT。
 * heartbeat（{file, intervalMs}）：脚本每 intervalMs 往 file 写一次心跳，结束时写 stopped:true。
 * deadlineAt（epoch ms）：到点脚本自己以 @@FAIL deadline 退出（process.exit 只结束本脚本，实测不影响 Ego 里别的脚本）。
 * 任务脚本里的错误（含浏览器调用抛的错）不吞：停心跳后原样抛出，脚本以失败退出。
 */
export function buildTaskSource({ space, profileId, params, pluginDir, script, heartbeat = null, deadlineAt = null, locksDir, focusTimeoutMs }) {
  const ctx = { space, profileId, params, pluginDir, shimUrl: SHIM_URL, spaceUrl: SPACE_URL, heartbeat, deadlineAt, shimOptions: { locksDir, focusTimeoutMs } };
  return `const __ctx = ${JSON.stringify(ctx)};
const __fs = await import("node:fs");
// 先写临时文件再 rename，runner 读心跳时不会读到半写的 JSON
const __heartbeat = (stopped) => {
  if (!__ctx.heartbeat) return;
  const tmp = __ctx.heartbeat.file + "." + Math.random().toString(36).slice(2) + ".tmp";
  try { __fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), stopped })); __fs.renameSync(tmp, __ctx.heartbeat.file); }
  catch (e) { try { __fs.rmSync(tmp, { force: true }); } catch {} throw e; }
};
let __beat = null, __deadline = null;
const __stop = () => {
  clearInterval(__beat); clearTimeout(__deadline);
  try { __heartbeat(true); } catch { /* 写不了「已停」时 runner 按心跳过期判断，结果一样 */ }
};
const __fail = (reason, error) => { __stop(); console.log(${JSON.stringify(FAIL_PREFIX)} + JSON.stringify({ reason, error })); process.exit(1); };
__heartbeat(false);
if (__ctx.heartbeat) __beat = setInterval(() => { try { __heartbeat(false); } catch (e) { __fail("heartbeat-failed", "写心跳失败：" + e.message); } }, __ctx.heartbeat.intervalMs);
if (__ctx.deadlineAt) __deadline = setTimeout(() => __fail("deadline", "脚本到了截止时间 " + new Date(__ctx.deadlineAt).toISOString() + "，自己退出"), Math.max(0, __ctx.deadlineAt - Date.now()));
const { openSpace } = await import(__ctx.spaceUrl);
const { createEgoChrome } = await import(__ctx.shimUrl);
let task;
try { task = await openSpace({ listTaskSpaces, taskSpace, claimTaskSpace, profiles }, { name: __ctx.space, profileId: __ctx.profileId }); }
catch (e) { __fail(["profile-needed", "user-controlled"].includes(e.code) ? e.code : "open-space-failed", e.message); }
const shim = createEgoChrome(task, __ctx.shimOptions);
globalThis.chrome = shim.chrome;
const { chrome, recoverTabs, withFocus } = shim;
const params = __ctx.params;
const pluginDir = __ctx.pluginDir;
const loadPlugin = (rel) => import(new URL(rel, "file://" + pluginDir.replace(/\\/?$/, "/")).href);
let __value;
try {
  __value = await (async () => {
${script}
  })();
} finally { __stop(); }
if (__value !== undefined) console.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify(__value));
`;
}

const deadlineMargin = (timeoutMs) => Math.min(30_000, Math.max(200, Math.round(timeoutMs * 0.1)));
const holderInfo = (h) => h && { pid: h.pid ?? null, space: h.space, startedAt: h.startedAt, heartbeatAt: h.heartbeatAt, ...(h.orphanedAt ? { orphanedAt: h.orphanedAt } : {}) };

/**
 * 持 space 锁跑 run(lock)。拿不到锁立即返回 busy。run 结果是 timeout 时（CLI 被杀、脚本可能还在 Ego 里跑），
 * 最多等 graceMs 看心跳停没停：停了才释放，没停就把锁留给旧脚本。返回值加 lockReleased。
 */
async function withSpaceLock(space, { lock, locksDir, staleMs, graceMs }, run) {
  if (!lock) return run(null);
  const got = tryLock(spaceLockPath(locksDir, space), { staleMs, meta: { space } });
  if (!got.ok) {
    const h = got.holder;
    if (h?.corrupt) return { ok: false, reason: 'busy', error: `space ${space} 的锁文件 ${h.path} 内容损坏，不能接管；确认没有任务在跑后手动删掉它`, holder: { corrupt: true, path: h.path } };
    const who = h?.pid ? `进程 ${h.pid}` : 'Ego 里超时后还没停的旧脚本';
    return { ok: false, reason: 'busy', error: `space ${space} 正被${who}占用${h ? `（开始于 ${new Date(h.startedAt).toISOString()}）` : ''}`, holder: holderInfo(h) };
  }
  let r;
  try { r = await run(got.lock); }
  catch (e) { releaseLock(got.lock); throw e; }
  if (r.reason === 'timeout' && !(await waitQuiet(got.lock, { quietMs: staleMs, graceMs }))) {
    orphanLock(got.lock);
    return { ...r, lockReleased: false, error: `${r.error}；${graceMs}ms 内心跳仍在更新，space 锁留给旧脚本，它心跳停了 ${staleMs}ms 后才能被接管` };
  }
  releaseLock(got.lock);
  return { ...r, lockReleased: true };
}

/**
 * 在一个 space 里跑一段任务脚本。脚本是 async 函数体，可用 task、chrome、recoverTabs、withFocus、params、pluginDir、loadPlugin；
 * 返回值即结果（返回 undefined 视为没有结果、算失败）。
 * 默认持该 space 的文件锁（lock:false 关掉），拿不到立即返回 reason='busy'。
 * @param {object} o
 * @param {number} [o.timeoutMs]      runner 超时，到点杀 CLI（默认 10 分钟）
 * @param {number} [o.deadlineMs]     脚本截止时间（从起进程算），默认比 timeoutMs 短 10%（至少 200ms、至多 30s）
 * @param {boolean} [o.lock]          是否取 space 锁（默认 true）
 * @param {string} [o.locksDir]       锁目录，默认 $MAITIAN_OPS_DIR/locks 或 <仓库根>/data/ops/locks
 * @param {number} [o.heartbeatMs]    脚本写心跳的间隔（默认 2s）
 * @param {number} [o.staleMs]        心跳多久没更新算停了（默认 10s）
 * @param {number} [o.graceMs]        超时后最多等多久确认旧脚本停了（默认 30s）
 * @param {number} [o.focusTimeoutMs] 等全局前台锁最多多久（默认 120s）
 * @returns {Promise<{ok: true, result: any, lockReleased?: boolean} | {ok: false, reason: string, error: string, lockReleased?: boolean, holder?: object}>}
 */
export async function runEgoTask({
  space, script, profileId = DEFAULT_PROFILE, params = {}, pluginDir = DEFAULT_PLUGIN_DIR, egoBin,
  timeoutMs = DEFAULT_TIMEOUT_MS, deadlineMs, lock = true, locksDir = defaultLocksDir(),
  heartbeatMs = 2000, staleMs = 10_000, graceMs = 30_000, focusTimeoutMs,
} = {}) {
  if (!profileAllowed(profileId)) return { ok: false, reason: 'profile-rejected', error: `不允许使用 ${profileId || '空 profile'}（只认 ${ALLOWED_PROFILES.join('、')}）` };
  if (!SPACE_NAME.test(space || '')) return { ok: false, reason: 'bad-space-name', error: `space 名要是 kinso/<平台>/<uid>：${space}` };
  return withSpaceLock(space, { lock, locksDir, staleMs, graceMs }, (held) => {
    const deadlineAt = Date.now() + (deadlineMs ?? timeoutMs - deadlineMargin(timeoutMs));
    const heartbeat = held && { file: held.heartbeatFile, intervalMs: heartbeatMs };
    return runEgoScript(buildTaskSource({ space, profileId, params, pluginDir, script, heartbeat, deadlineAt, locksDir, focusTimeoutMs }), { egoBin, timeoutMs });
  });
}

/**
 * 关掉指定名字的 space（不存在就什么都不做）。只动 kinso/ 开头、且在 profileId 上的；profile 只认 ALLOWED_PROFILES。
 * 同名 space 在别的 profile 上时不接管、不关，返回 ok:false, reason:'profile-mismatch'。
 * 只关 ownership=agent 的；user、agentDelegatedToUser 等在负责人手里的不 claim、不关，返回 reason:'user-controlled'。
 * 跟 runEgoTask 一样持 space 锁：别的任务正持锁时不关，返回 reason:'busy'。
 */
export async function finishSpace(space, { profileId = DEFAULT_PROFILE, lock = true, locksDir = defaultLocksDir(), staleMs = 10_000, graceMs = 30_000, ...opts } = {}) {
  if (!profileAllowed(profileId)) return { ok: false, reason: 'profile-rejected', error: `不允许使用 ${profileId || '空 profile'}（只认 ${ALLOWED_PROFILES.join('、')}）` };
  if (!SPACE_NAME.test(space || '')) return { ok: false, reason: 'bad-space-name', error: space };
  const r = await withSpaceLock(space, { lock, locksDir, staleMs, graceMs }, () => runEgoScript(`const s = (await listTaskSpaces()).find((x) => x.name === ${JSON.stringify(space)});
const want = ${JSON.stringify(profileId)};
let r = { closed: false, existed: !!s };
if (s && s.profileId !== want) r = { closed: false, existed: true, mismatch: true, profileId: s.profileId ?? null };
else if (s && s.ownership !== "agent") r = { closed: false, existed: true, userControlled: true, ownership: s.ownership ?? null };
else if (s) r = { existed: true, ...(await (await taskSpace(s.id)).finish({ keep: [] })) };
console.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify(r));`, opts));
  if (r.ok && r.result?.mismatch) return { ...r, ok: false, reason: 'profile-mismatch', error: `space ${space} 在 ${r.result.profileId} 上，不是 ${profileId}，没有关` };
  if (r.ok && r.result?.userControlled) return { ...r, ok: false, reason: 'user-controlled', error: `space ${space} 在负责人手里（ownership=${r.result.ownership}），没有关` };
  return r;
}
