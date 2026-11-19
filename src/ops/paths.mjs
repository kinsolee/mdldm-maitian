// ops 的数据目录：按接口约定从 src/ego-runner/paths.mjs 取 OPS_DIR（dev-1 建）。
// 那个文件合并前还不存在，这里按同一规则算一个兜底：MAITIAN_OPS_DIR 优先，否则 <仓库根>/data/ops。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let fromRunner = null;
try { fromRunner = await import('../ego-runner/paths.mjs'); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }

/** 每次调用重新读环境变量，测试可以在同一进程里换临时目录。 */
export function opsDir() {
  if (process.env.MAITIAN_OPS_DIR) return process.env.MAITIAN_OPS_DIR;
  return fromRunner?.OPS_DIR ?? path.join(ROOT, 'data', 'ops');
}
