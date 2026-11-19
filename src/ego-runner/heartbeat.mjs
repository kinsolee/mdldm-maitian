// 心跳文件：任务脚本（跑在 ego-browser nodejs 里）每 HEARTBEAT_INTERVAL_MS 写一次，结束时删掉；
// runner 据此判断上一个脚本是不是还在 Ego 里跑（S0 ③：普通模式下杀掉 CLI，脚本照样跑）。
import { writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { readLock, newToken } from './lockfile.mjs';

export const HEARTBEAT_INTERVAL_MS = 5_000;
/**
 * 心跳多久没更新算过期（上一个脚本已停）。取 30 秒 = 6 个心跳间隔：
 * 心跳定时器和脚本共用一个事件循环，脚本里同步的大段计算、大文件读写会把它推迟几秒，留 6 倍余量不会误判成已停；
 * 误判的代价是两个进程同时操作同一页（S0 ③ 实测 Ego 不拦），而多等的代价只是同一 space 的下一个任务晚 30 秒开始。
 */
export const HEARTBEAT_STALE_MS = 30_000;

/**
 * 开始写心跳。返回 stop()：停定时器并删掉自己的心跳文件（幂等）。进程退出（含 process.exit）时自动 stop。
 * @param {string} file
 * @param {object} info  一并写进文件的信息（space、deadline 等）
 */
export function startHeartbeat(file, info = {}, intervalMs = HEARTBEAT_INTERVAL_MS) {
  mkdirSync(dirname(file), { recursive: true });
  const token = newToken();
  const startedAt = Date.now();
  const beat = () => {
    const tmp = `${file}.${token}.tmp`;
    try { writeFileSync(tmp, JSON.stringify({ ...info, token, pid: process.pid, startedAt, at: Date.now() })); renameSync(tmp, file); }
    catch { /* 写心跳失败不拖垮任务；心跳过期只会让下一个任务多等 */ }
  };
  beat();
  const timer = setInterval(beat, intervalMs);
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    process.off('exit', stop);
    if (readLock(file)?.content?.token === token) { try { unlinkSync(file); } catch { /* 已删 */ } }
  };
  process.once('exit', stop);
  return stop;
}

/** 心跳文件最近一次更新的时间戳（毫秒）；没有心跳文件返回 null。 */
export function lastBeat(file) {
  const r = readLock(file);
  if (!r) return null;
  return Number.isFinite(r.content?.at) ? r.content.at : r.mtimeMs;
}
