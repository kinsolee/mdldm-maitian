// 小V猫只读影子版配置：环境变量从 integrations/vcat/.env（0600）读取。
// 上游凭据仅供进程使用，禁止记录凭据输出。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadEnvFile as loadEnv, writeEnvValue, enforceEnvPerms as baseEnforceEnvPerms } from '../openbot/config.mjs';

export { writeEnvValue };

export const HERE = import.meta.dirname;
export const REPO_ROOT = path.resolve(HERE, '../..');
export const ENV_FILE = process.env.VCAT_ENV_FILE || path.join(HERE, '.env');
export const DEFAULT_UPSTREAM_URL = 'http://127.0.0.1:3199/mcp';
export const DEFAULT_OP_REF = 'op://Private/小V猫 MCP/credential';
export const DEFAULT_OP_BIN = '/opt/homebrew/bin/op';
export const DEFAULT_PROXY_PORT = 8793;
export const DEFAULT_CARDS_PORT = 8794;
export const DEFAULT_LOOKBACK_DAYS = 3;
export const DEFAULT_SHADOW_DB = path.join(HERE, 'data', 'shadow.db');
export const DEFAULT_KB_EXPORT_FILE = path.join(os.homedir(), 'Documents', 'OPC-vault', '10.个人IP', '数据', '小V猫问答库.md');

/** OpenBot 的正式文件：小V猫影子版一个字也不能写进去。 */
export const OPENBOT_FILES = Object.freeze([
  '评论私信回复记录.md',
  '评论私信待确认.md',
  '评论私信回复话术.md',
]);

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const CARDS_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
const MACOS_ROOT_SYMLINKS = new Set(['/var', '/tmp', '/etc']);

export const loadEnvFile = (file = ENV_FILE) => loadEnv(file);

/** 启动时检查 .env 非符号链接并收紧为 0600。 */
export function enforceEnvPerms(file = ENV_FILE) {
  let stat = null;
  try { stat = fs.lstatSync(file); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (stat?.isSymbolicLink()) {
    throw new Error('VCAT_ENV_FILE 指向的 .env 不能是符号链接');
  }
  baseEnforceEnvPerms(file);
}

/** 直接从 .env 读成键值对象，不修改 process.env。文件不存在返回 {}。 */
export function readEnvFile(file = ENV_FILE) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  const out = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(trimmed);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

/** 校验问答库只读镜像导出路径：必须是 .md，不能指向 OpenBot 正式文件，且路径本身与任意非系统祖先目录均不能是符号链接。 */
export function assertSafeKbExportPath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('VCAT_KB_EXPORT_FILE 不能为空');
  }
  const resolved = path.resolve(filePath.trim());
  if (OPENBOT_FILES.includes(path.basename(resolved)) || path.extname(resolved) !== '.md') {
    throw new Error('VCAT_KB_EXPORT_FILE 必须是独立的 .md 文件，且不能指向 OpenBot 正式文件');
  }

  // 逐级检查路径中的每一段（含所有已存在的父目录和目标文件本身），拒绝任何符号链接（仅放行 macOS 顶层 /var、/tmp、/etc）
  const root = path.parse(resolved).root;
  const segments = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (let i = 0; i < segments.length; i += 1) {
    current = path.join(current, segments[i]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (err) {
      if (err.code === 'ENOENT') break;
      throw new Error(`VCAT_KB_EXPORT_FILE 路径检查失败（${err?.code || 'fs_error'}）`);
    }
    if (stat.isSymbolicLink()) {
      const isTopSystemLink = i === 0 && MACOS_ROOT_SYMLINKS.has(current);
      if (!isTopSystemLink) {
        throw new Error('VCAT_KB_EXPORT_FILE 路径或其父目录不能是符号链接');
      }
    }
  }

  try {
    const real = fs.realpathSync(resolved);
    if (OPENBOT_FILES.includes(path.basename(real))) {
      throw new Error('VCAT_KB_EXPORT_FILE 不能间接指向 OpenBot 正式文件');
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new Error(`VCAT_KB_EXPORT_FILE 路径解析失败（${err?.code || 'fs_error'}）`);
    }
  }
  return resolved;
}

/** 校验上游地址只能是本机回环 HTTP，避免令牌外泄。 */
export function parseUpstreamUrl(rawUrl = DEFAULT_UPSTREAM_URL) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new Error('VCAT_UPSTREAM_URL 不是合法地址'); }
  if (parsed.protocol !== 'http:') throw new Error('VCAT_UPSTREAM_URL 只允许本机 http 协议');
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('VCAT_UPSTREAM_URL 不允许包含用户信息、查询参数或锚点');
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error('VCAT_UPSTREAM_URL 只允许本机回环地址（127.0.0.1 / localhost）');
  }
  return parsed.toString();
}

/** 锁定监听端口，防止配置漂移到非指定端口或冲突端口（如 8787 工作台）。 */
function parseFixedPort(raw, expectedPort, name) {
  if (raw == null || String(raw).trim() === '') return expectedPort;
  const port = Number(raw);
  if (!Number.isInteger(port) || port !== expectedPort) {
    throw new Error(`${name} 必须固定为 ${expectedPort}`);
  }
  return port;
}

/** 锁定本机答题页 URL，确保飞书按钮只能指向本机答题页 127.0.0.1/localhost:<cardsPort>/cards。 */
export function parseCardsUrl(rawUrl, cardsPort = DEFAULT_CARDS_PORT) {
  const fallback = `http://127.0.0.1:${cardsPort}/cards`;
  const input = rawUrl == null || String(rawUrl).trim() === '' ? fallback : String(rawUrl).trim();
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('VCAT_CARDS_URL 不是合法地址');
  }
  if (parsed.protocol !== 'http:') {
    throw new Error('VCAT_CARDS_URL 只允许本机 http 协议');
  }
  if (parsed.username || parsed.password) {
    throw new Error('VCAT_CARDS_URL 不允许包含用户信息');
  }
  if (!CARDS_LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error('VCAT_CARDS_URL 只允许本机回环地址（127.0.0.1 / localhost）');
  }
  if (Number(parsed.port) !== cardsPort) {
    throw new Error(`VCAT_CARDS_URL 端口必须为 ${cardsPort}`);
  }
  if (parsed.pathname !== '/cards' || parsed.search || parsed.hash) {
    throw new Error('VCAT_CARDS_URL 路径必须为 /cards（不允许查询参数或锚点）');
  }
  return parsed.toString();
}

export function readConfig(env = process.env) {
  const proxyPort = parseFixedPort(env.VCAT_PROXY_PORT, DEFAULT_PROXY_PORT, 'VCAT_PROXY_PORT');
  const cardsPort = parseFixedPort(env.VCAT_CARDS_PORT, DEFAULT_CARDS_PORT, 'VCAT_CARDS_PORT');
  const lookbackDays = Number(env.VCAT_LOOKBACK_DAYS || DEFAULT_LOOKBACK_DAYS);
  if (!Number.isInteger(lookbackDays) || lookbackDays <= 0 || lookbackDays > 90) {
    throw new Error('VCAT_LOOKBACK_DAYS 必须是 1 到 90 的整数');
  }
  const kbExportFile = env.VCAT_KB_EXPORT_FILE === ''
    ? null
    : assertSafeKbExportPath(env.VCAT_KB_EXPORT_FILE || DEFAULT_KB_EXPORT_FILE);
  const selfAuthors = String(env.VCAT_SELF_AUTHORS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    upstreamUrl: parseUpstreamUrl(env.VCAT_UPSTREAM_URL || DEFAULT_UPSTREAM_URL),
    upstreamTokenEnv: env.VCAT_UPSTREAM_TOKEN ? String(env.VCAT_UPSTREAM_TOKEN).trim() : '',
    keychainService: String(env.VCAT_UPSTREAM_TOKEN_KEYCHAIN_SERVICE || '').trim(),
    keychainAccount: String(env.VCAT_UPSTREAM_TOKEN_KEYCHAIN_ACCOUNT || '').trim(),
    upstreamTokenOpRef: String(env.VCAT_UPSTREAM_TOKEN_OP_REF ?? DEFAULT_OP_REF).trim(),
    opBin: String(env.VCAT_OP_BIN || DEFAULT_OP_BIN).trim(),
    proxyPort,
    cardsPort,
    cardsUrl: parseCardsUrl(env.VCAT_CARDS_URL, cardsPort),
    shadowDb: env.VCAT_SHADOW_DB || DEFAULT_SHADOW_DB,
    kbExportFile,
    lookbackDays,
    selfAuthors,
    maitianConfig: env.MAITIAN_CONFIG || path.join(REPO_ROOT, 'config.json'),
  };
}

/** 优先使用环境变量，其次使用指定钥匙串条目，未指定服务时兼容旧 op 引用。 */
export function resolveUpstreamToken(config, { execFile = execFileSync } = {}) {
  if (config.upstreamTokenEnv) return config.upstreamTokenEnv;
  if (config.keychainService) {
    const account = config.keychainAccount || os.userInfo().username;
    const args = ['find-generic-password', '-s', config.keychainService, '-a', account, '-w'];
    let token;
    try {
      token = execFile('/usr/bin/security', args, {
        encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch (err) {
      const status = Number.isInteger(err?.status) ? ' (exit ' + err.status + ')' : '';
      throw new Error('keychain_read_failed' + status);
    }
    if (!token) throw new Error('keychain_read_failed');
    return token;
  }
  const ref = config.upstreamTokenOpRef;
  if (!ref || !ref.startsWith('op://')) {
    throw new Error('未配置 VCAT_UPSTREAM_TOKEN，且 VCAT_UPSTREAM_TOKEN_OP_REF 不是有效的 op:// 引用');
  }
  try {
    const token = String(execFile(config.opBin, ['read', ref], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] })).trim();
    if (!token) throw new Error('1Password 返回了空令牌');
    return token;
  } catch (err) {
    const code = err?.code && /^[A-Z0-9_]+$/.test(String(err.code)) ? err.code : 'op_read_failed';
    throw new Error(`无法从 1Password 读取小V猫 MCP 令牌：请确认已在 1Password 建立条目「小V猫 MCP」的 credential 字段，或设置 VCAT_UPSTREAM_TOKEN（原因：${code}）`);
  }
}

/** 代理自己的 Bearer 令牌：没有就随机生成 32 字节写进 .env（0600），绝不打印。 */
export function ensureProxyToken(env = process.env, file = ENV_FILE) {
  if (env.VCAT_PROXY_TOKEN && env.VCAT_PROXY_TOKEN.length >= 32) return env.VCAT_PROXY_TOKEN;
  const existing = readEnvFile(file).VCAT_PROXY_TOKEN;
  if (existing && existing.length >= 32) {
    env.VCAT_PROXY_TOKEN = existing;
    return existing;
  }
  const token = crypto.randomBytes(32).toString('base64url');
  writeEnvValue(file, 'VCAT_PROXY_TOKEN', token);
  env.VCAT_PROXY_TOKEN = token;
  return token;
}

/** 按 .env 的 mtime/size/ino/mode 缓存热读代理令牌；若文件是符号链接或权限不是 0600，一律拒用。 */
export function proxyTokenFromFile(file = ENV_FILE) {
  let stamp = '';
  let cached = null;
  return () => {
    let stat;
    try { stat = fs.lstatSync(file); } catch { cached = null; stamp = ''; return null; }
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600) {
      cached = null;
      stamp = '';
      return null;
    }
    const currentStamp = `${stat.mtimeMs}:${stat.size}:${stat.ino}:${stat.mode}`;
    if (currentStamp !== stamp) {
      cached = readEnvFile(file).VCAT_PROXY_TOKEN || null;
      stamp = currentStamp;
    }
    return cached;
  };
}
