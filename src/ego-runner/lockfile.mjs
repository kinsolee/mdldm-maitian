// 锁文件的公共操作：排他创建、读、按 token 删、回收。space 锁（runner 进程里）和前台锁（ego-browser 脚本里）共用。
// 只用 node:fs，在 ego-browser nodejs 的运行时里也能 import。
import { openSync, writeSync, closeSync, readFileSync, unlinkSync, statSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

// 回收守卫文件超过这么久还在，说明回收的那个进程死在半路了，可以删掉
const RECLAIM_GUARD_STALE_MS = 5_000;

export const newToken = () => randomBytes(8).toString('hex');

/** 排他创建锁文件（open 'wx'，原子）；成功返回 true，已存在返回 false，其他错误照抛。 */
export function tryCreate(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  let fd;
  try { fd = openSync(file, 'wx'); }
  catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  try { writeSync(fd, JSON.stringify(content)); } finally { closeSync(fd); }
  return true;
}

/** 读锁文件：{ content, mtimeMs }；文件不在返回 null；内容坏了（刚创建还没写完）content 为 null。 */
export function readLock(file) {
  let mtimeMs, text;
  try { mtimeMs = statSync(file).mtimeMs; text = readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try { return { content: JSON.parse(text), mtimeMs }; } catch { return { content: null, mtimeMs }; }
}

/** 锁文件里的 token 还是 token 时才删（不删别人的锁）。返回是否删了。 */
export function removeIfOwned(file, token) {
  const cur = readLock(file);
  if (cur?.content?.token !== token) return false;
  try { unlinkSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

/** 锁文件里的 token 还是 token 时，原子地改写内容（写临时文件再 rename）。 */
export function rewriteIfOwned(file, token, content) {
  if (readLock(file)?.content?.token !== token) return false;
  const tmp = `${file}.${newToken()}.tmp`;
  try { tryCreate(tmp, content); renameSync(tmp, file); return true; }
  finally { try { unlinkSync(tmp); } catch { /* rename 过了就不在了 */ } }
}

/**
 * 回收一把判定为失效的锁：只在锁文件还是 seen 那一份（token 相同，或都读不出内容且 mtime 相同）时删。
 * 用一个排他创建的守卫文件把「再读一次、删掉」做成一步，免得两个回收方一个删了旧锁、新建，另一个又把新锁删了。
 * 返回是否删了（没删也不要紧，调用方重试创建即可）。
 */
export function reclaim(file, seen) {
  const guard = `${file}.reclaim`;
  if (!tryCreate(guard, { at: Date.now() })) {
    const g = readLock(guard);
    if (g && Date.now() - g.mtimeMs > RECLAIM_GUARD_STALE_MS) { try { unlinkSync(guard); } catch { /* 别人删了 */ } }
    return false;
  }
  try {
    const cur = readLock(file);
    if (!cur) return false;
    const same = seen.content?.token ? cur.content?.token === seen.content.token : !cur.content && cur.mtimeMs === seen.mtimeMs;
    if (!same) return false;
    unlinkSync(file);
    return true;
  } finally { try { unlinkSync(guard); } catch { /* 已删 */ } }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
