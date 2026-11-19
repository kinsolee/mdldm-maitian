// 短进程 runner：每个任务起一个 ego-browser nodejs 子进程，脚本从 stdin 传入，
// 子进程最后一行打印 `@@RESULT <json>`，这里解析成结果。没有这一行、JSON 坏、退出码非零都是失败。
// 实测：ego-browser CLI 把脚本的 console.log 全写到它自己的 stderr（stdout 为空），所以解析 stdout+stderr。
//
// ego-browser nodejs 的脚本不继承环境变量、不在本进程的工作目录里跑，
// 所以参数以 JSON 字面量写进脚本前言，模块用 file:// 绝对地址加载（已实测可以 import 本地 ESM）。
import { spawn } from 'node:child_process';
import { ALLOWED_PROFILE } from './space.mjs';
import { OPS_DIR, opsPaths } from './paths.mjs';
import { acquireSpaceLock } from './space-lock.mjs';
import { HEARTBEAT_STALE_MS } from './heartbeat.mjs';

export const DEFAULT_PROFILE = ALLOWED_PROFILE;
export const DEFAULT_PLUGIN_DIR = '/Users/kinso/code/github/kinsolee/mdldm-maitian-publisher';
export const RESULT_PREFIX = '@@RESULT ';
/** 前言自己判定失败（user-owned、deadline 等）时打一行 `@@OPS {"reason","error",...}` 再退出，runner 认这一行，不解析报错文字。 */
export const OPS_PREFIX = '@@OPS ';
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** reason → 退出码（CLI 的退出码就用它）。没列的失败一律 1。 */
export const EXIT_CODES = {
  locked: 5, 'previous-still-running': 5,
  'user-owned': 4,
  'profile-rejected': 3, 'profile-missing': 3,
  'bad-space-name': 2, 'bad-args': 2,
};
export const exitCodeOf = (r) => (r.ok ? 0 : EXIT_CODES[r.reason] ?? 1);
const SPACE_NAME = /^kinso\/[a-z0-9_-]+\/[^/\s]+$/i;
const EGO_NOTICE = /^\[ego-browser:/;

const SHIM_URL = new URL('../ego-shim.mjs', import.meta.url).href;
const SPACE_URL = new URL('./space.mjs', import.meta.url).href;
const HEARTBEAT_URL = new URL('./heartbeat.mjs', import.meta.url).href;
const FOREGROUND_URL = new URL('./foreground.mjs', import.meta.url).href;

/** 从子进程输出里取结果：最后一个非空、非 Ego 提示的行必须是 `@@RESULT <json>`，且退出码为 0。 */
export function parseResult(output, code) {
  if (code !== 0) return { ok: false, reason: 'exit-code', code, error: `ego-browser nodejs 退出码 ${code}` };
  const lines = output.split('\n').map((l) => l.trimEnd()).filter((l) => l && !EGO_NOTICE.test(l));
  const last = lines.at(-1) ?? '';
  if (!last.startsWith(RESULT_PREFIX)) return { ok: false, reason: 'no-result', error: '最后一行不是 @@RESULT' };
  try { return { ok: true, result: JSON.parse(last.slice(RESULT_PREFIX.length)) }; }
  catch (e) { return { ok: false, reason: 'bad-json', error: `@@RESULT 不是合法 JSON：${e.message}` }; }
}

/** 输出里有前言打的 `@@OPS` 行时，按它判失败原因（退出码是多少都以它为准）；没有返回 null。 */
export function parseOps(output) {
  const line = output.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(OPS_PREFIX)).at(-1);
  if (!line) return null;
  try {
    const { reason, error, ...detail } = JSON.parse(line.slice(OPS_PREFIX.length));
    return { ok: false, reason: String(reason), error: String(error ?? reason), ...detail };
  } catch { return null; }
}

/** 原样跑一段 ego-browser nodejs 脚本（不加前言），返回 { ok, result | reason, error, code, stdout, stderr }。 */
export function runEgoScript(source, { egoBin = 'ego-browser', timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', settled = false, timedOut = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve({ stdout, stderr, ...r }); } };
    const child = spawn(egoBin, ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    // 本进程被打断（SIGINT/SIGTERM）时同步杀掉 CLI，不留子进程
    const onAbort = () => { child.kill('SIGKILL'); done({ ok: false, reason: 'aborted', error: '任务被打断，已杀掉 ego-browser CLI' }); };
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => done({ ok: false, reason: 'spawn-failed', error: e.message }));
    child.on('close', (code, signal) => {
      // 实测：不带 --session 时杀掉 CLI 不会停掉 Ego Node 服务里的脚本（spikes/results/03）
      if (timedOut) return done({ ok: false, reason: 'timeout', error: `超过 ${timeoutMs}ms，已杀掉 ego-browser CLI；脚本可能仍在 Ego 里跑，别马上对同一个 space 起新任务`, code });
      done({ ...parseResult(stdout + stderr, code ?? (signal ? 128 : 1)), code: code ?? null, signal });
    });
    child.stdin.on('error', () => { /* 子进程没起来时写 stdin 会报 EPIPE，结果由 error/close 给出 */ });
    child.stdin.end(source);
  });
}

/**
 * 把任务脚本包上前言：写心跳、设截止时间、按名字取用 space（user-owned 不接管）、装好 chrome 垫片（切前台自动进前台锁），
 * 提供 params / loadPlugin / withForegroundLock / deadline，最后把返回值打成 @@RESULT。
 * 前言自己判定的失败打 @@OPS 行后 process.exit(1)；脚本自己抛的错照常让脚本以非零退出（不吞错）。
 */
export function buildTaskSource({ space, profileId, params, pluginDir, script, takeBack = false, deadline, opsDir = OPS_DIR }) {
  const { heartbeat, foregroundLock } = opsPaths(space, opsDir);
  const ctx = {
    space, profileId, params, pluginDir, takeBack, deadline,
    heartbeatPath: heartbeat, foregroundLockPath: foregroundLock,
    shimUrl: SHIM_URL, spaceUrl: SPACE_URL, heartbeatUrl: HEARTBEAT_URL, foregroundUrl: FOREGROUND_URL,
  };
  return `const __ctx = ${JSON.stringify(ctx)};
const { openSpace, USER_OWNED: __USER_OWNED } = await import(__ctx.spaceUrl);
const { createEgoChrome } = await import(__ctx.shimUrl);
const { startHeartbeat } = await import(__ctx.heartbeatUrl);
const { createForegroundLock } = await import(__ctx.foregroundUrl);
const __stopBeat = startHeartbeat(__ctx.heartbeatPath, { space: __ctx.space, deadline: __ctx.deadline });
let withForegroundLock;
const __cleanup = () => { __stopBeat(); withForegroundLock?.dispose(); };
const __ops = (reason, error, extra = {}) => {
  __cleanup();
  console.log(${JSON.stringify(OPS_PREFIX)} + JSON.stringify({ reason, error, ...extra }));
  process.exit(1);
};
const deadline = __ctx.deadline;
const __deadlineTimer = setTimeout(() => __ops("deadline", "脚本到了截止时间 " + new Date(deadline).toISOString() + "，自己退出"), Math.max(0, deadline - Date.now()));
withForegroundLock = createForegroundLock(__ctx.foregroundLockPath, { info: { space: __ctx.space } });
let task;
try {
  if (!(await profiles()).some((p) => p.id === __ctx.profileId)) __ops("profile-missing", "Ego Lite 里没有 " + __ctx.profileId + "，需要先建好这个 profile（脚本不建 profile）");
  task = await openSpace({ listTaskSpaces, taskSpace, claimTaskSpace, takeOverTaskSpace: globalThis.takeOverTaskSpace }, { name: __ctx.space, profileId: __ctx.profileId, takeBack: __ctx.takeBack });
} catch (e) {
  if (e.code === __USER_OWNED) __ops("user-owned", e.message, { ownership: e.ownership });
  __ops("script-error", "取用 space 出错：" + e.message);
}
const shim = createEgoChrome(task, { withForegroundLock });
globalThis.chrome = shim.chrome;
const { chrome, recoverTabs } = shim;
const params = __ctx.params;
const pluginDir = __ctx.pluginDir;
const loadPlugin = (rel) => import(new URL(rel, "file://" + pluginDir.replace(/\\/?$/, "/")).href);
let __value;
try {
  __value = await (async () => {
${script}
  })();
} finally {
  clearTimeout(__deadlineTimer);
  __cleanup();
}
if (__value !== undefined) console.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify(__value));
`;
}

function checkArgs(space, profileId) {
  if (profileId !== ALLOWED_PROFILE) return { ok: false, reason: 'profile-rejected', error: `不允许使用 ${profileId || '空 profile'}，只用 ${ALLOWED_PROFILE}` };
  if (!SPACE_NAME.test(space || '')) return { ok: false, reason: 'bad-space-name', error: `space 名要是 kinso/<平台>/<uid>：${space}` };
  return null;
}

const isMs = (v, min) => typeof v === 'number' && Number.isFinite(v) && v >= min;
/** 锁和超时参数：lock 只能 wait/skip；timeoutMs 要是正的有限毫秒数；lockTimeoutMs 不给或有限非负。不对返回 bad-args。 */
function checkLockArgs({ lock, timeoutMs, lockTimeoutMs }) {
  const bad = (error) => ({ ok: false, reason: 'bad-args', error });
  if (lock !== 'wait' && lock !== 'skip') return bad(`lock 只能是 wait 或 skip：${lock}`);
  if (!isMs(timeoutMs, 1)) return bad(`timeoutMs 要是正的毫秒数：${timeoutMs}`);
  if (lockTimeoutMs != null && !isMs(lockTimeoutMs, 0)) return bad(`lockTimeoutMs 要是非负的毫秒数：${lockTimeoutMs}`);
  return null;
}

// 脚本截止时间比 runner 杀 CLI 早一点，正常情况下脚本先自己退出，runner 不用杀
const deadlineFor = (timeoutMs) => Date.now() + timeoutMs - Math.min(10_000, Math.floor(timeoutMs / 10));

/** 不拿锁地跑任务脚本（内部原语，只给 runInSpace 用：公开出去就能绕过 space 锁和心跳）。 */
async function runUnlocked({ space, script, profileId, params, pluginDir, egoBin, timeoutMs, takeBack, opsDir, signal }) {
  const source = buildTaskSource({ space, profileId, params, pluginDir, script, takeBack, opsDir, deadline: deadlineFor(timeoutMs) });
  const r = await runEgoScript(source, { egoBin, timeoutMs, signal });
  if (r.reason === 'timeout' || r.reason === 'aborted' || r.reason === 'spawn-failed') return r;
  const ops = parseOps(r.stdout + r.stderr);
  return ops ? { ...ops, code: r.code, stdout: r.stdout, stderr: r.stderr } : r;
}

const withCode = (r) => ({ ...r, exitCode: exitCodeOf(r) });

/**
 * 拿 space 锁跑 fn(signal)；锁的规矩：
 * - 拿不到（skip、wait 超时）返回 locked；上一个任务的脚本心跳还新鲜返回 previous-still-running。都不起子进程。
 * - fn 返回 timeout、或本进程被 SIGINT/SIGTERM 打断：CLI 已被杀，但 Ego 里的脚本可能还在跑，
 *   所以不放锁，只标成 abandoned，等心跳过期后由下一个任务回收。其余结束方式都放锁。
 */
async function withSpaceLock(space, { lock, lockTimeoutMs, opsDir, heartbeatStaleMs }, fn) {
  const got = await acquireSpaceLock(space, { mode: lock, timeoutMs: lockTimeoutMs, opsDir, heartbeatStaleMs });
  if (!got.ok) return got;
  const ac = new AbortController();
  let keepLock = false;
  const abandon = () => { keepLock = true; got.lock.abandon(); };
  const onSignal = (sig) => {
    ac.abort();
    abandon();
    unhook();
    process.kill(process.pid, sig);   // 标完锁按原信号退出
  };
  const onExit = () => { if (!keepLock) got.lock.release(); };
  const unhook = () => { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); process.off('exit', onExit); };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal); process.on('exit', onExit);
  try {
    const r = await fn(ac.signal);
    if (r.reason === 'timeout' || r.reason === 'aborted') abandon();
    return r;
  } finally {
    unhook();
    if (!keepLock) got.lock.release();
  }
}

/**
 * 拿 space 锁后在 space 里跑任务脚本，返回带 exitCode（见 EXIT_CODES）。所有公开的任务入口都走这里。
 * 脚本是 async 函数体，可用 task、chrome、recoverTabs、params、pluginDir、loadPlugin、withForegroundLock、deadline；
 * 返回值即结果（返回 undefined 视为没有结果、算失败）。
 * - lock 'wait'：排队等 space 锁（lockTimeoutMs 超时返回 locked）；'skip'：拿不到马上返回 locked。都不起子进程。
 * - 上一个任务超时或被打断后心跳还新鲜：返回 previous-still-running。
 * - 超时、被 SIGINT/SIGTERM 打断：杀掉 CLI，不放锁（脚本可能还在 Ego 里跑），等心跳过期后由下一个任务回收。
 * - finish=true：任务跑完（超时、打断、user-owned、profile-missing 除外）后，仍在同一把锁里关掉 space，结果放在 finish 字段。
 * @returns {Promise<{ok: true, result: any, exitCode: 0} | {ok: false, reason: string, error: string, exitCode: number}>}
 */
export async function runInSpace({
  space, script, profileId = DEFAULT_PROFILE, params = {}, pluginDir = DEFAULT_PLUGIN_DIR, egoBin, timeoutMs = DEFAULT_TIMEOUT_MS,
  lock = 'wait', lockTimeoutMs, takeBack = false, finish = false, opsDir = OPS_DIR, heartbeatStaleMs = HEARTBEAT_STALE_MS,
} = {}) {
  const bad = checkArgs(space, profileId) ?? checkLockArgs({ lock, timeoutMs, lockTimeoutMs });
  if (bad) return withCode(bad);
  return withCode(await withSpaceLock(space, { lock, lockTimeoutMs, opsDir, heartbeatStaleMs }, async (signal) => {
    const r = await runUnlocked({ space, script, profileId, params, pluginDir, egoBin, timeoutMs, takeBack, opsDir, signal });
    if (!finish || ['timeout', 'aborted', 'user-owned', 'profile-missing'].includes(r.reason)) return r;
    const { stdout: _o, stderr: _e, ...fin } = await finishUnlocked(space, { profileId, egoBin, signal });
    return { ...r, finish: fin };
  }));
}

/** 不拿锁地关 space（内部用；调用方已持有这个 space 的锁）。只关 agent 持有的；用户的 space 不碰。 */
async function finishUnlocked(space, { profileId, egoBin, timeoutMs = 60_000, signal } = {}) {
  const r = await runEgoScript(`const s = (await listTaskSpaces()).find((x) => x.name === ${JSON.stringify(space)});
const want = ${JSON.stringify(profileId)};
let r = { closed: false, existed: !!s };
if (s && s.profileId !== want) r = { closed: false, existed: true, mismatch: true, profileId: s.profileId ?? null };
else if (s && s.ownership !== "agent") r = { closed: false, existed: true, userOwned: true, ownership: s.ownership ?? null };
else if (s) r = { existed: true, ...(await (await taskSpace(s.id)).finish({ keep: [] })) };
console.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify(r));`, { egoBin, timeoutMs, signal });
  if (r.ok && r.result?.mismatch) return { ...r, ok: false, reason: 'profile-mismatch', error: `space ${space} 在 ${r.result.profileId} 上，不是 ${profileId}，没有关` };
  if (r.ok && r.result?.userOwned) return { ...r, ok: false, reason: 'user-owned', ownership: r.result.ownership, error: `space ${space} 现在由用户控制（ownership=${r.result.ownership}），不接管、不关` };
  return r;
}

/**
 * 关掉指定名字的 space（不存在就什么都不做），返回带 exitCode。和 runInSpace 用同一把 space 锁（lock/lockTimeoutMs 同义）。
 * 只动 kinso/ 开头、在 Profile 5 上、ownership=agent 的；ownership 为 user / agentDelegatedToUser 时不认领、不关，返回 user-owned（4）。
 * 同名 space 在别的 profile 上时不接管、不关，返回 profile-mismatch。
 */
export async function finishSpace(space, {
  profileId = DEFAULT_PROFILE, egoBin, timeoutMs = 60_000, lock = 'wait', lockTimeoutMs, opsDir = OPS_DIR, heartbeatStaleMs = HEARTBEAT_STALE_MS,
} = {}) {
  const bad = checkArgs(space, profileId) ?? checkLockArgs({ lock, timeoutMs, lockTimeoutMs });
  if (bad) return withCode(bad);
  return withCode(await withSpaceLock(space, { lock, lockTimeoutMs, opsDir, heartbeatStaleMs }, (signal) => finishUnlocked(space, { profileId, egoBin, timeoutMs, signal })));
}
