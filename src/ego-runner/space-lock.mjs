// space 锁：同一个 space 同时只有一个 runner 进程，不同 space 互不影响（S0 ③：Ego 不拦两个进程同时操作同一页）。
// 锁文件 <OPS_DIR>/locks/<space 换名>.lock，排他创建，里面记 pid、主机、开始时间。
// 持锁进程死了、或它超时放弃了任务，锁可以回收，但要先看心跳：上一个脚本还在 Ego 里跑（心跳新鲜）就不回收。
import { hostname } from 'node:os';
import { opsPaths, OPS_DIR } from './paths.mjs';
import { tryCreate, readLock, removeIfOwned, rewriteIfOwned, reclaim, newToken, sleep } from './lockfile.mjs';
import { lastBeat, HEARTBEAT_STALE_MS } from './heartbeat.mjs';

// 锁文件刚创建、内容还没写进去时读到的是空的；超过这么久还是空的，当成创建方死在半路
const EMPTY_LOCK_STALE_MS = 5_000;
const HOST = hostname();

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

/** 锁文件内容是不是完整的：token、pid、host、startedAt 都在且类型对；abandonedAt 有就得是数字。不完整的按损坏处理。 */
function validContent(c) {
  return !!c && typeof c === 'object'
    && typeof c.token === 'string' && !!c.token
    && Number.isInteger(c.pid) && c.pid > 0
    && typeof c.host === 'string' && !!c.host
    && Number.isFinite(c.startedAt)
    && (c.abandonedAt == null || Number.isFinite(c.abandonedAt));
}

/** 读锁文件，内容不完整时 content 置 null（损坏锁）；raw 留着给 reclaim 比对。 */
function readSpaceLock(file) {
  const raw = readLock(file);
  return raw && { raw, content: validContent(raw.content) ? raw.content : null, mtimeMs: raw.mtimeMs };
}

/** 持锁方还在为这个任务负责吗：没放弃、且进程还活着（别的主机上的进程查不了，当它活着）。损坏的锁刚写不久时当被占。 */
function holderActive(cur) {
  const c = cur.content;
  if (!c) return Date.now() - cur.mtimeMs <= EMPTY_LOCK_STALE_MS;
  if (c.abandonedAt) return false;
  return c.host !== HOST || pidAlive(c.pid);
}

const describe = (c) => (c ? `pid ${c.pid}@${c.host}，${new Date(c.startedAt).toISOString()} 开始${c.abandonedAt ? `，${new Date(c.abandonedAt).toISOString()} 放弃` : ''}` : '锁文件内容损坏或还没写完');

/**
 * 拿 space 锁。
 * @param {string} space
 * @param {{ mode?: 'wait'|'skip', timeoutMs?: number, opsDir?: string, heartbeatStaleMs?: number, pollMs?: number }} [opts]
 *   mode 'wait'：排队等（timeoutMs 不给就一直等）；'skip'：拿不到马上返回。
 * @returns {Promise<{ ok: true, lock: SpaceLock } | { ok: false, reason: 'locked'|'previous-still-running', error: string }>}
 */
export async function acquireSpaceLock(space, { mode = 'wait', timeoutMs, opsDir = OPS_DIR, heartbeatStaleMs = HEARTBEAT_STALE_MS, pollMs = 200 } = {}) {
  const { spaceLock: file, heartbeat } = opsPaths(space, opsDir);
  if (timeoutMs != null && !(typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs >= 0)) throw new TypeError(`timeoutMs 要是有限的非负毫秒数：${timeoutMs}`);
  if (mode !== 'wait' && mode !== 'skip') throw new TypeError(`mode 只能是 wait 或 skip：${mode}`);
  const giveUpAt = timeoutMs == null ? Infinity : Date.now() + timeoutMs;
  // 上一个脚本最后的生命迹象：心跳；超时放弃的锁还要算上放弃的时刻（脚本可能还没来得及写第一次心跳）
  const stillRunning = (abandonedAt = 0) => {
    const last = Math.max(lastBeat(heartbeat) ?? 0, abandonedAt);
    return last > 0 && Date.now() - last <= heartbeatStaleMs;
  };
  const previous = (c) => ({ ok: false, reason: 'previous-still-running', error: `space ${space} 上一个任务的脚本可能还在 Ego 里跑（心跳 ${heartbeatStaleMs / 1000} 秒内更新过；${describe(c)}），不起新任务` });

  for (;;) {
    const token = newToken();
    const content = { space, token, pid: process.pid, host: HOST, startedAt: Date.now() };
    if (tryCreate(file, content)) {
      // 拿到锁也要看心跳：持锁进程被 SIGINT/SIGTERM 时会放锁，但它起的脚本可能还在 Ego 里跑
      if (stillRunning()) { removeIfOwned(file, token); return previous(null); }
      return { ok: true, lock: spaceLock(file, token, content) };
    }
    const cur = readSpaceLock(file);
    if (!cur) continue;   // 刚被放掉：马上再抢
    if (!holderActive(cur)) {
      if (stillRunning(cur.content?.abandonedAt ?? 0)) return previous(cur.content);
      if (reclaim(file, cur.raw)) continue;
      // 回收没成（别人正在回收、或锁刚被换掉）：和被占一样走下面的 skip / 超时 / 等待
    }
    if (mode === 'skip' || Date.now() >= giveUpAt) {
      return { ok: false, reason: 'locked', error: `space ${space} 正被别的任务占用（${describe(cur.content)}）${mode === 'skip' ? '' : `，等了 ${timeoutMs}ms`}` };
    }
    await sleep(Math.max(1, Math.min(pollMs, giveUpAt - Date.now())));
  }
}

/**
 * @typedef {{ file: string, release: () => boolean, abandon: () => boolean }} SpaceLock
 * release()：正常结束、失败、被信号打断时放锁。abandon()：超时杀掉 CLI 后不放锁，只记下放弃时刻，
 * 等心跳过期后由下一个任务回收。两者都只动自己的锁，幂等。
 */
function spaceLock(file, token, content) {
  return {
    file,
    release: () => removeIfOwned(file, token),
    abandon: () => rewriteIfOwned(file, token, { ...content, abandonedAt: Date.now() }),
  };
}
