// 运维文件的位置：space 锁、全局前台锁、心跳文件、ops.db 都在 OPS_DIR 下。
// 默认 <仓库根>/data/ops（data/ 已被 .gitignore），环境变量 MAITIAN_OPS_DIR 可覆盖（测试用临时目录）。
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export const OPS_DIR = process.env.MAITIAN_OPS_DIR || join(REPO_ROOT, 'data', 'ops');
export const LOCK_DIR = join(OPS_DIR, 'locks');

/** space 名里的 / 换成 __，当文件名用 */
export const spaceFileKey = (space) => space.replaceAll('/', '__');

/** 某个 OPS_DIR 下这几个文件的路径（不传就用 OPS_DIR） */
export function opsPaths(space, opsDir = OPS_DIR) {
  const lockDir = join(opsDir, 'locks');
  return {
    lockDir,
    spaceLock: space ? join(lockDir, `${spaceFileKey(space)}.lock`) : null,
    foregroundLock: join(lockDir, '_foreground.lock'),
    heartbeat: space ? join(opsDir, 'heartbeats', `${spaceFileKey(space)}.json`) : null,
  };
}
