// 麦田网页「Cindy 接入」页的后端：看整条链路的状态、生成或更换 Cindy 挂 MCP 用的 token。
// token 只存在 integrations/cindy/.env（0600）。状态接口不返回 token；只有本机请求能取 token 或换 token（web.mjs 把关）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ENV_FILE, readEnvFile, readPaths, writeEnvValue } from './config.mjs';
import { exists, openInbox } from './store.mjs';
import { CINDY_TOOLS, DEFAULT_PORT, MCP_PATH } from './mcp-http.mjs';

const TOKEN_KEY = 'CINDY_MCP_TOKEN';
const PROBE_TIMEOUT_MS = 5000;

export const readToken = (file = ENV_FILE) => readEnvFile(file)[TOKEN_KEY] || null;

/** 生成新 token 写进 .env（0600），旧的立刻失效（mcp-http 每个请求按文件比对）。返回新 token。 */
export function rotateToken(file = ENV_FILE) {
  const token = crypto.randomBytes(32).toString('base64url');
  writeEnvValue(file, TOKEN_KEY, token);
  return token;
}

const mcpUrl = (env) => `http://127.0.0.1:${Number(env.CINDY_MCP_PORT || DEFAULT_PORT)}${MCP_PATH}`;

/** 用 token 真连一次 MCP：initialize + tools/list。不调任何工具，不碰数据。 */
export async function probeMcp(url, token, timeoutMs = PROBE_TIMEOUT_MS) {
  if (!token) return { ok: false, error: '还没有 token' };
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  const client = new Client({ name: 'maitian-web-probe', version: '1' });
  let timer;
  try {
    const run = (async () => { await client.connect(transport); return (await client.listTools()).tools.map((t) => String(t.name)); })();
    const names = await Promise.race([run, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('超时')), timeoutMs); })]);
    // 三个工具各出现且只出现一次，不多不少；只回报认识的名字，对方返回的任何文字都不进状态接口
    const want = [...CINDY_TOOLS].sort();
    const ok = names.length === want.length && [...names].sort().every((n, i) => n === want[i]);
    const tools = want.filter((t) => names.includes(t));
    return ok ? { ok: true, tools } : { ok: false, tools, error: '工具列表不是预期的三个只读工具' };
  } catch (e) {
    // 错误文案固定：MCP 的错误正文可能回显请求头（含 token），一个字都不往外带
    const msg = String(e?.message || e);
    return { ok: false, error: /ECONNREFUSED|fetch failed/.test(msg) ? '服务没在跑（127.0.0.1 上连不上）' : /401|unauthorized/i.test(msg) ? 'token 对不上' : msg === '超时' ? '连接超时' : '连接失败'};
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}

async function probeReceiver(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!r.ok) return { ok: false, error: `接收端不健康（HTTP ${r.status}）` };
    const j = await r.json();
    const n = (v) => (Number.isFinite(v) ? v : null);   // 只取三个数字，别的字段一律不带
    return { ok: true, total: n(j.total), processed: n(j.processed), pending: n(j.pending) };
  } catch { return { ok: false, error: '接收端没在跑' }; }
}

/** 对照文件：行数和最后一行的处理时间。只读，不返回建议回复。 */
function ledgerSummary(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { exists: false }; }
  const lines = text.split('\n').filter(Boolean);
  let last = null;
  try { last = JSON.parse(lines.at(-1) ?? 'null')?.processedAt ?? null; } catch {}
  return { exists: true, rows: lines.length, lastProcessedAt: last };
}

/** 整条链路的状态。不含 token。 */
export async function cindyStatus({ envFile = ENV_FILE } = {}) {
  const env = readEnvFile(envFile);
  const token = env[TOKEN_KEY] || null;
  const paths = readPaths(env);
  const url = mcpUrl(env);
  let inbox = null;
  if (exists(paths.stateDb)) {
    const ib = openInbox(paths.stateDb, { readOnly: true });
    try { inbox = ib.stats(); } finally { ib.close(); }
  }
  const [mcp, receiver] = await Promise.all([probeMcp(url, token), probeReceiver(Number(env.RECEIVER_PORT || 8791))]);
  return {
    mcp: { url, hasToken: Boolean(token), ...mcp },
    receiver,
    inbox,
    ledger: { file: paths.ledger, ...ledgerSummary(paths.ledger) },
  };
}
