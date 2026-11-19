// 全局前台锁：所有会切前台的步骤（tabs.create/update({active:true})、插件 withFocus 整段）跨 space、跨进程串行。
// S0 ④：两个 space 同时切前台会互相抢窗口焦点，加一把只锁这一步的文件锁后 20 轮 0 次抢。
// 在 ego-browser nodejs 的任务脚本里用（前言把锁文件路径写进来），也能在普通 Node 进程里用。
import { utimesSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { tryCreate, readLock, removeIfOwned, reclaim, newToken, sleep } from './lockfile.mjs';

// 持锁方每 2 秒摸一下锁文件；15 秒没被摸过，说明持锁的脚本已经不在了（Ego 里各脚本的 pid 不可靠，不按 pid 判）
export const FOREGROUND_REFRESH_MS = 2_000;
export const FOREGROUND_STALE_MS = 15_000;

/**
 * @param {string} file  锁文件路径（<OPS_DIR>/locks/_foreground.lock）
 * @returns {((fn: () => any) => Promise<any>) & { dispose: () => void }}
 *   withForegroundLock(fn)：拿到锁跑 fn，跑完（成功或抛错）放锁。同一个脚本里嵌套调用（withFocus 里再 tabs.update active）直接跑，不会自己等自己。
 *   withForegroundLock.dispose()：幂等的收尾，停掉摸锁定时器、放掉自己持有的锁、移除 exit 监听器；前言在脚本结束、deadline、@@OPS 退出前都调。
 */
export function createForegroundLock(file, { pollMs = 50, staleMs = FOREGROUND_STALE_MS, refreshMs = FOREGROUND_REFRESH_MS, info = {} } = {}) {
  const inside = new AsyncLocalStorage();
  const held = new Map();   // token → 摸锁定时器
  const drop = (token) => { clearInterval(held.get(token)); held.delete(token); removeIfOwned(file, token); };
  const dispose = () => { for (const t of [...held.keys()]) drop(t); process.off('exit', dispose); };
  process.on('exit', dispose);   // 兜底：脚本崩掉、被 process.exit 时也放锁（Ego 里 process 按脚本隔离，exit 在本脚本结束时触发）

  async function acquire() {
    const token = newToken();
    for (;;) {
      if (tryCreate(file, { ...info, token, pid: process.pid, at: Date.now() })) return token;
      const cur = readLock(file);
      if (cur && Date.now() - cur.mtimeMs > staleMs && reclaim(file, cur)) continue;
      await sleep(pollMs);
    }
  }

  // 只给自己的锁续期：锁文件已被回收、换成别人的，就停掉定时器
  const touch = (token) => {
    if (readLock(file)?.content?.token !== token) { clearInterval(held.get(token)); return; }
    try { const t = new Date(); utimesSync(file, t, t); } catch { /* 刚被删 */ }
  };

  async function withForegroundLock(fn) {
    if (inside.getStore()) return fn();
    const token = await acquire();
    held.set(token, setInterval(() => touch(token), refreshMs));
    try { return await inside.run(true, fn); }
    finally { drop(token); }
  }
  withForegroundLock.dispose = dispose;
  return withForegroundLock;
}
