// 写入类子命令用的口令：MAITIAN_ENGAGE_TOKEN（回复、私信）、MAITIAN_PUBLISH_TOKEN（发布）。
// 口令只写进仓库根目录的 .env（权限 600），任何输出、日志、异常里都不出现口令值。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { ROOT } from './paths.mjs';

export const TOKEN_VARS = { engage: 'MAITIAN_ENGAGE_TOKEN', publish: 'MAITIAN_PUBLISH_TOKEN' };
const HEX64 = /^[0-9a-f]{64}$/i;

const opensslHex = () => execFileSync('openssl', ['rand', '-hex', '32'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function readEnv(file) {
  const vars = new Map();
  if (!fs.existsSync(file)) return { text: '', vars };
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/);
    if (m) vars.set(m[1], m[2].replace(/^(['"])(.*)\1$/, '$2'));
  }
  return { text, vars };
}

/** 确保 .gitignore 有单独一行 .env。返回 true 表示这次加上了。 */
export function ensureGitignore(file) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (text.split('\n').some((l) => l.trim() === '.env' || l.trim() === '/.env')) return false;
  fs.writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}.env\n`);
  return true;
}

/**
 * 生成缺的口令，已有的保留不动（幂等）。
 * @returns {{ name: string, status: '已生成' | '已存在' | '已存在（格式不对）' }[]}
 */
export function initTokens({ root, gen = opensslHex }) {
  const envFile = path.join(root, '.env');
  const { text, vars } = readEnv(envFile);
  const report = [];
  let add = '';
  for (const name of Object.values(TOKEN_VARS)) {
    if (vars.has(name)) { report.push({ name, status: HEX64.test(vars.get(name)) ? '已存在' : '已存在（格式不对）' }); continue; }
    const v = gen();
    if (!HEX64.test(v)) throw new Error(`${name} 生成失败：openssl 输出不是 64 位十六进制`);
    add += `${name}=${v}\n`;
    report.push({ name, status: '已生成' });
  }
  // 先收紧已有文件的权限再写，口令不会有一刻在 644 的文件里
  if (fs.existsSync(envFile)) fs.chmodSync(envFile, 0o600);
  if (add) fs.writeFileSync(envFile, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${add}`, { mode: 0o600 });
  const gitignoreAdded = ensureGitignore(path.join(root, '.gitignore'));
  return { envFile, tokens: report, gitignoreAdded };
}

/**
 * 写入类子命令先过这一关：环境变量里的口令必须和仓库根 .env 里登记的一致（定长比较）。
 * .env 缺、格式不对，环境变量缺、格式不对、不一致，一律拒绝；报错里不带口令值。
 */
export function requireToken(kind, env = process.env, { root = ROOT } = {}) {
  const name = TOKEN_VARS[kind];
  const deny = (error) => ({ ok: false, reason: 'token-missing', exitCode: 8, error });
  if (!name) return deny(`没有这种口令：${kind}`);
  const want = readEnv(path.join(root, '.env')).vars.get(name);
  if (!want) return deny(`.env 里没有 ${name}：先跑 hub ops tokens init`);
  if (!HEX64.test(want)) return deny(`.env 里的 ${name} 格式不对（要 64 位十六进制），重新生成`);
  const got = env[name];
  if (!got) return deny(`缺 ${name}：调用方要带上 .env 里的口令`);
  if (!HEX64.test(got)) return deny(`${name} 格式不对（要 64 位十六进制）`);
  if (!timingSafeEqual(Buffer.from(got.toLowerCase()), Buffer.from(want.toLowerCase()))) return deny(`${name} 和 .env 里的不一致`);
  return { ok: true };
}
