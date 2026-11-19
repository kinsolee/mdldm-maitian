// hub ops 的文件位置。都能用环境变量改到别处（测试用临时目录，绝不碰仓库真实的 data/ 和 .env）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const opsDbPath = () => process.env.MAITIAN_OPS_DB || path.join(ROOT, 'data', 'ops.db');
export const envPath = () => process.env.MAITIAN_ENV_FILE || path.join(ROOT, '.env');
export const shadowDir = () => process.env.MAITIAN_OPS_SHADOW_DIR || path.join(ROOT, 'data', 'ops-shadow');
export const seedPath =() => path.join(ROOT, 'src', 'ops', 'accounts.seed.json');

// 知识站后台地址：config.json 的 site.base + site.adminPath（同 src/site.mjs 的算法）。
// 不 import site.mjs / feishu.mjs：它们在没有 config.json 时会 process.exit。
export function siteAdmin() {
  const file = process.env.MAITIAN_CONFIG || path.join(ROOT, 'config.json');
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8')).site;
    return s?.base ? s.base.replace(/\/$/, '') + (s.adminPath || '/admin') : null;
  } catch { return null; }
}
