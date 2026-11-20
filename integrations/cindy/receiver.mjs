#!/usr/bin/env node
// 麦田事件接收端（Cindy 侧）。只监听 127.0.0.1。
// 收到推送：验 X-Maitian-Signature → 按事件 id 去重进本地收件箱 → 马上回 200。不叫 agent，不回执：
// Cindy 的定时任务用 inbox.mjs check 当前置检查，有新事件才起回合。
// 本阶段事件由 OpenBot 处理并回执，麦田只推还没回执的事件；推送重试时 OpenBot 已回执的会推不到这里，
// 所以每隔一段时间用 list_events（不带 unhandled）补漏，保证两边收到的事件集合一致。
// 日志只写条数，不写评论私信正文，不写密钥。
import fs from 'node:fs';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { verifySignature, HOOK_PATH, MAX_BODY_BYTES } from '../openbot/receiver.mjs';
import { ensureSubscribed } from '../openbot/subscribe.mjs';
import { childEnv } from '../openbot/forward.mjs';
import { ENV_FILE, enforceEnvPerms, loadEnvFile, readConfig } from './config.mjs';
import { openInbox, eventProblem } from './store.mjs';

export { HOOK_PATH };
export const BACKFILL_OVERLAP_MS = 2 * 3600_000;
export const BACKFILL_FIRST_WINDOW_MS = 24 * 3600_000;
export const BACKFILL_PAGE = 100;
export const MCP_TIMEOUT_MS = 60_000;

const stamp = () => new Date().toISOString();
const defaultLog = (line) => console.log(`${stamp()} ${line}`);

export function createReceiver({ secret, subscriberId, inbox, log = defaultLog, now = Date.now }) {
  function handler(req, res) {
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/health') {
      try { send(200, { ok: true, ...inbox.stats() }); } catch (e) { send(503, { ok: false, error: 'store failed' }); }
      return;
    }
    if (req.method !== 'POST' || req.url.split('?')[0] !== HOOK_PATH) { send(404, { error: 'not found' }); return; }
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) tooBig = true;
      else chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) { send(413, { error: 'body too large' }); return; }
      const raw = Buffer.concat(chunks);
      if (!verifySignature(secret, raw, req.headers['x-maitian-signature'])) {
        log('验签失败，已回 401');
        send(401, { error: 'bad signature' });
        return;
      }
      let body;
      try { body = JSON.parse(raw.toString('utf8')); } catch { send(400, { error: 'body is not JSON' }); return; }
      if (!body || typeof body !== 'object' || body.subscriberId !== subscriberId || !Array.isArray(body.events)) { send(400, { error: 'unexpected body' }); return; }
      const events = body.events;
      // 有一条不合格就整批拒收：回 200 会让麦田当成送达，不合格的事件就丢了
      if (events.some((e) => eventProblem(e))) { log('推送里有不合格的事件，整批回 400'); send(400, { error: 'malformed event' }); return; }
      let r;
      try { r = inbox.receive(events, now(), 'push'); } catch (e) { log(`收件箱写入失败：${e.message}`); send(503, { error: 'store failed' }); return; }
      log(`收到 ${events.length} 条（新 ${r.accepted}，重复 ${r.duplicate}）`);
      send(200, { ok: true, ...r });
    });
  }
  return { handler };
}

/**
 * 补漏一次。起点是上次补漏成功开始的时间往前退 2 小时；从没补过（或水位坏了）就从现在往前 24 小时。
 * 翻页读完、全部收进收件箱之后才推进水位；任何一页出错或有不合格的事件就抛错，水位不动，下一轮从原处重来。
 * 水位不看收件箱里最新的事件：接收端停机期间 OpenBot 回执掉的事件麦田不会再推，只能靠这里按时间找回。
 * listEvents(args) => { items, nextCursor }。返回新收的条数。
 */
export async function backfillOnce({ inbox, listEvents, types, now = Date.now }) {
  const startedAt = now();
  const mark = inbox.watermark();
  const since = new Date(Number.isFinite(mark) ? mark - BACKFILL_OVERLAP_MS : startedAt - BACKFILL_FIRST_WINDOW_MS).toISOString();
  // 先把所有页读完、校验完，再一次写进收件箱：任何一页出错，这一轮一条都不收
  let cursor;
  const items = [];
  for (;;) {
    const page = await listEvents({ types, since, limit: BACKFILL_PAGE, ...(cursor ? { cursor } : {}) });
    if (!page || !Array.isArray(page.items)) throw new Error('list_events 返回的不是 { items }');
    const bad = page.items.find((e) => eventProblem(e));
    if (bad) throw new Error(`list_events 返回了不合格的事件（${eventProblem(bad)}）`);
    items.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  const { accepted } = inbox.receive(items, now(), 'backfill');
  inbox.setWatermark(startedAt);
  return accepted;
}

/** 起麦田 MCP（stdio，read 组）调 list_events。每次调用起一次、用完关掉；连接加调用超过 timeoutMs 就关掉子进程并抛错。 */
export function mcpListEvents({ mcpServer, opsDb, timeoutMs = MCP_TIMEOUT_MS }) {
  return async (args) => {
    const env = childEnv();
    if (opsDb) env.MAITIAN_OPS_DB = opsDb;
    const transport = new StdioClientTransport({ command: process.execPath, args: [mcpServer, '--scope', 'read'], env, stderr: 'ignore' });
    const client = new Client({ name: 'cindy-receiver', version: '1' });
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`麦田 MCP 超时（${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs);
    });
    const call = (async () => {
      await client.connect(transport);
      const r = await client.callTool({ name: 'list_events', arguments: args });
      if (r.isError) throw new Error(`list_events 失败：${r.content?.[0]?.text}`);
      return JSON.parse(r.content[0].text);
    })();
    try {
      return await Promise.race([call, timeout]);
    } finally {
      clearTimeout(timer);
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  };
}

export async function main() {
  enforceEnvPerms(ENV_FILE);
  loadEnvFile(ENV_FILE);
  const cfg = readConfig();
  const { secret, created } = await ensureSubscribed(cfg, { envFile: ENV_FILE });
  defaultLog(`订阅 ${cfg.subscriberId}：${created ? '首次登记，密钥已写进 .env' : '已更新'}（${cfg.types.join(', ')}）`);
  const inbox = openInbox(cfg.stateDb);
  const receiver = createReceiver({ secret, subscriberId: cfg.subscriberId, inbox });
  const server = http.createServer(receiver.handler);
  server.requestTimeout = 20_000;   // 拖着不发完请求体的连接 20 秒断开，保证 30 秒内有回应
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(cfg.port, '127.0.0.1', resolve); });
  defaultLog(`接收端已启动：127.0.0.1:${cfg.port}${HOOK_PATH}，收件箱 ${cfg.stateDb}`);

  const listEvents = mcpListEvents(cfg);
  let backfilling = null;
  const backfill = () => {
    backfilling ??= backfillOnce({ inbox, listEvents, types: cfg.types })
      .then((n) => { if (n) defaultLog(`补漏收进 ${n} 条`); })
      .catch((e) => defaultLog(`补漏失败：${e.message}`))
      .finally(() => { backfilling = null; });
    return backfilling;
  };
  backfill();
  const timer = setInterval(backfill, cfg.backfillMs);

  const stop = () => { clearInterval(timer); server.close(() => { inbox.close(); process.exit(0); }); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === import.meta.filename) {
  main().catch((e) => { console.error(`${stamp()} 接收端启动失败：${e.message}`); process.exit(1); });
}
