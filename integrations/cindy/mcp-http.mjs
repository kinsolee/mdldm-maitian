#!/usr/bin/env node
// 麦田 MCP 的 HTTP 版，专给 Cindy 用（Cindy 只能挂 http / sse 型 MCP）。
// 只监听 127.0.0.1；每个请求要带 Authorization: Bearer <CINDY_MCP_TOKEN>，Host 只认本机。
// 只注册 Cindy 要的三个只读工具：get_comment_thread、get_conversation、get_work。
// list_events、ack_event、订阅、refresh_now 都不在这里，Cindy 想调也调不到。
// 无会话模式：每个请求起一个新的 server + transport，处理完就关。日志只写方法和状态码，不写参数和结果。
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServer } from '../../src/mcp/server.mjs';
import { openOpsDb } from '../../src/ops/db.mjs';
import { opsDbPath } from '../../src/ops/paths.mjs';
import { ENV_FILE, enforceEnvPerms, loadEnvFile, readEnvFile, writeEnvValue } from './config.mjs';

export const CINDY_TOOLS = ['get_comment_thread', 'get_conversation', 'get_work'];
export const MCP_PATH = '/mcp';
export const DEFAULT_PORT = 8792;
const MAX_BODY_BYTES = 1024 * 1024;

const stamp = () => new Date().toISOString();
const defaultLog = (line) => console.log(`${stamp()} ${line}`);

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
/** 比较 Bearer token：先各自哈希成定长再 timingSafeEqual，长度不同也不提前返回。 */
export function checkBearer(token, header) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(String(header ?? ''));
  return Boolean(token) && Boolean(m) && crypto.timingSafeEqual(digest(token), digest(m[1]));
}

/** 每次请求从 .env 取当前 token（按 mtime 缓存）：在麦田网页里换了 token，不用重启服务，旧的立刻失效。 */
export function tokenFromFile(file = ENV_FILE) {
  let stamp = '', cached = null;
  return () => {
    let st;
    try { st = fs.statSync(file); } catch { return null; }
    const now = `${st.mtimeMs}:${st.size}:${st.ino}`;
    if (now !== stamp) { cached = readEnvFile(file).CINDY_MCP_TOKEN || null; stamp = now; }
    return cached;
  };
}

/** token：字符串，或每次请求调用一次的函数（返回当前 token）。少于 32 个字符的 token 一律当作没有。 */
export function createMcpHttp({ db, token, port, log = defaultLog }) {
  const current = typeof token === 'function' ? token : () => token;
  if (typeof token !== 'function' && (!token || token.length < 32)) throw new Error('CINDY_MCP_TOKEN 太短或没有');
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  return async function handler(req, res) {
    const send = (code, body) => { if (!res.headersSent) res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const done = (code) => log(`${req.method} ${code}`);
    if (!allowedHosts.includes(req.headers.host)) { send(403, { error: 'host not allowed' }); done(403); return; }
    if (req.url.split('?')[0] !== MCP_PATH) { send(404, { error: 'not found' }); done(404); return; }
    const tok = current();
    if (!tok || tok.length < 32 || !checkBearer(tok, req.headers.authorization)) { send(401, { error: 'unauthorized' }); done(401); return; }
    // 无会话模式只用 POST；GET（SSE 通知流）和 DELETE（结束会话）都没有意义
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); send(405, { error: 'method not allowed' }); done(405); return; }

    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY_BYTES) { send(413, { error: 'body too large' }); done(413); return; }
      chunks.push(c);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { send(400, { error: 'body is not JSON' }); done(400); return; }

    const server = buildServer(db, { scope: 'read', tools: CINDY_TOOLS, log });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      done(res.statusCode);
    } catch (e) {
      log(`处理失败：${e.message}`);
      send(500, { error: 'internal error' });
    }
  };
}

/** token 没有就生成一个写进 .env（0600），不打印。返回 token。 */
export function ensureToken(env = process.env, file = ENV_FILE) {
  if (env.CINDY_MCP_TOKEN) return env.CINDY_MCP_TOKEN;
  const token = crypto.randomBytes(32).toString('base64url');
  writeEnvValue(file, 'CINDY_MCP_TOKEN', token);
  env.CINDY_MCP_TOKEN = token;
  return token;
}

export async function main() {
  enforceEnvPerms(ENV_FILE);
  loadEnvFile(ENV_FILE);
  const port = Number(process.env.CINDY_MCP_PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`CINDY_MCP_PORT 不是有效端口：${process.env.CINDY_MCP_PORT}`);
  const created = !process.env.CINDY_MCP_TOKEN;
  const dbFile = process.env.MAITIAN_OPS_DB || opsDbPath();
  const db = openOpsDb(dbFile);
  ensureToken();   // 首次启动生成；之后以 .env 里的为准
  const server = http.createServer(createMcpHttp({ db, token: tokenFromFile(ENV_FILE), port }));
  server.requestTimeout = 30_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  defaultLog(`麦田 MCP（HTTP，${CINDY_TOOLS.join('、')}）已启动：http://127.0.0.1:${port}${MCP_PATH}，库 ${path.basename(dbFile)}${created ? '；token 首次生成，已写进 .env' : ''}`);
  const stop = () => server.close(() => { db.close(); process.exit(0); });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === import.meta.filename) {
  main().catch((e) => { console.error(`${stamp()} 麦田 MCP（HTTP）启动失败：${e.message}`); process.exit(1); });
}
