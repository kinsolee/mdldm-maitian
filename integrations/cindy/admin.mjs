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
    const run = (async () => { await client.connect(transport); return (await client.listTools()).tools.map((t) => t.name).sort(); })();
    const tools = await Promise.race([run, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('超时')), timeoutMs); })]);
    const extra = tools.filter((t) => !CINDY_TOOLS.includes(t));
    return { ok: extra.length === 0 && tools.length === CINDY_TOOLS.length, tools, ...(extra.length ? { error: `多出了工具：${extra.join('、')}` } : {}) };
  } catch (e) {
    const msg = String(e?.message || e);
    return { ok: false, error: /ECONNREFUSED|fetch failed/.test(msg) ? '服务没在跑（127.0.0.1 上连不上）' : /401|unauthorized/i.test(msg) ? 'token 对不上' : msg.slice(0, 200) };
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}

async function probeReceiver(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const j = await r.json();
    return r.ok ? { ok: true, ...j } : { ok: false, error: j.error || String(r.status) };
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
