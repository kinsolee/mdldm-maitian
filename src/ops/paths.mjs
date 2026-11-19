// ops 的数据目录：按接口约定从 src/ego-runner/paths.mjs 取 OPS_DIR。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPS_DIR } from '../ego-runner/paths.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** OPS_DIR 在 import 时就定了；这里每次再看一眼环境变量，测试可以在同一进程里换临时目录。 */
export const opsDir = () => process.env.MAITIAN_OPS_DIR || OPS_DIR;
