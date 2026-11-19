// 抓取轮的文件锁：同一时刻只能有一轮在跑。锁文件里写 pid 和开始时间；
// 进程不在了、超过 60 分钟或文件读不懂，视为过期，可以接管。
import fs from 'node:fs';
import path from 'node:path';

export const ROUND_LOCK_STALE_MS = 60 * 60_000;

function readLock(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return e.code === 'ENOENT' ? null : {}; }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const isStale = (lock, nowMs) => !alive(lock.pid) || !(nowMs - Date.parse(lock.startedAt) < ROUND_LOCK_STALE_MS);

/** 锁现在有效（有人在跑）就返回锁内容，否则 null。 */
export function heldLock(file, { now = Date.now } = {}) {
  const lock = readLock(file);
  return lock && !isStale(lock, now()) ? lock : null;
}

function tryCreate(file, lock) {
  try { fs.writeFileSync(file, JSON.stringify(lock), { flag: 'wx' }); return true; } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
}

/** 拿锁：拿到返回 { release, taken }（taken：接管了过期锁），拿不到返回 null。 */
export function acquireRoundLock(file, { now = Date.now } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = { pid: process.pid, startedAt: new Date(now()).toISOString(), token: Math.random().toString(36).slice(2) };
  let taken = false;
  if (!tryCreate(file, lock)) {
    if (heldLock(file, { now })) return null;
    fs.rmSync(file, { force: true });
    taken = true;
    if (!tryCreate(file, lock)) return null;   // 别人同时接管了
  }
  const release = () => { if (readLock(file)?.token === lock.token) fs.rmSync(file, { force: true }); };
  return { release, taken };
}
