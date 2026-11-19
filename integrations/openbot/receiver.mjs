#!/usr/bin/env node
// 麦田事件接收端（OpenBot 侧）。只监听 127.0.0.1。
// 收到推送：验 X-Maitian-Signature → 按事件 id 去重入队 → 马上回 200 → 后台逐批交给 OpenBot（openbot-cli run --id）。
// 同一时间只投一批；失败按 30 秒、2 分钟、10 分钟重试，用尽后不再投，留给 agent 每轮开头的 list_events 补漏。
// 日志只写条数、批次键、deliveryId、错误摘要，不写评论私信正文，不写密钥。
import fs from 'node:fs';
import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ENV_FILE, enforceEnvPerms, loadEnvFile, readConfig } from './config.mjs';
import { openStore } from './store.mjs';
import { cliForwarder } from './forward.mjs';
import { ensureSubscribed } from './subscribe.mjs';

export const HOOK_PATH = '/maitian/hook';
export const MAX_BODY_BYTES = 1024 * 1024;

export function verifySignature(secret, raw, header) {
  const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`);
  const got = Buffer.from(String(header ?? ''));
  return got.length === want.length && timingSafeEqual(got, want);
}

const stamp = () => new Date().toISOString();
const defaultLog = (line) => console.log(`${stamp()} ${line}`);

/**
 * 组装接收端。返回 { handler, drain, kick }：handler 给 http.createServer；drain() 投完当前到点的所有批次（测试用）。
 */
export function createReceiver({ secret, subscriberId, store, forward, log = defaultLog, now = Date.now }) {
  let running = null;
  let timer = null;

  async function drain() {
    for (;;) {
      const batch = store.nextBatch(now());
      if (!batch) break;
      try {
        const r = await forward(batch.ids, batch.key);
        store.markForwarded(batch.key, r?.deliveryId, now());
        log(`投递成功 ${batch.ids.length} 条 批次 ${batch.key.slice(0, 12)} delivery ${r?.deliveryId ?? '-'} ${r?.status ?? ''}`.trim());
      } catch (e) {
        const f = store.markFailed(batch.key, e.message, now());
        log(f.gaveUp
          ? `投递失败已用尽 ${batch.ids.length} 条 批次 ${batch.key.slice(0, 12)} 第 ${f.attempts} 次：${e.message}；不再重试，留给 agent 的 list_events({ unhandled: true }) 补漏`
          : `投递失败 ${batch.ids.length} 条 批次 ${batch.key.slice(0, 12)} 第 ${f.attempts} 次：${e.message}；${f.nextAttemptAt} 重试`);
      }
    }
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    const due = store.nextDueAt();
    if (due == null) return;
    timer = setTimeout(kick, Math.max(0, due - now()) + 50);
    timer.unref?.();
  }

  function kick() {
    if (!running) running = drain().finally(() => { running = null; });
    return running;
  }

  function handler(req, res) {
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/health') { send(200, { ok: true, ...store.stats() }); return; }
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
      if (!events.every((e) => e && typeof e.id === 'string' && e.id && typeof e.type === 'string' && e.type)) { send(400, { error: 'event without id or type' }); return; }
      const r = store.receive(events, now());
      log(`收到 ${events.length} 条（新 ${r.accepted}，重复 ${r.duplicate}）`);
      send(200, { ok: true, ...r });
      if (r.accepted) kick();
    });
  }

  return { handler, drain: kick, schedule, stop: () => clearTimeout(timer) };
}

export async function main() {
  enforceEnvPerms(ENV_FILE);
  loadEnvFile(ENV_FILE);
  const cfg = readConfig();
  const { secret, created } = await ensureSubscribed(cfg, { envFile: ENV_FILE });
  defaultLog(`订阅 ${cfg.subscriberId}：${created ? '首次登记，密钥已写进 .env' : '已更新'}（${cfg.types.join(', ')}）`);
  const store = openStore(cfg.stateDb);
  const receiver = createReceiver({ secret, subscriberId: cfg.subscriberId, store, forward: cliForwarder({ cli: cfg.cli, agent: cfg.agent }) });
  const server = http.createServer(receiver.handler);
  server.requestTimeout = 20_000;   // 拖着不发完请求体的连接 20 秒断开，保证 30 秒内有回应
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(cfg.port, '127.0.0.1', resolve); });
  defaultLog(`接收端已启动：127.0.0.1:${cfg.port}${HOOK_PATH}，投给 OpenBot「${cfg.agent}」`);
  receiver.drain();
  const stop = () => { receiver.stop(); server.close(() => { store.close(); process.exit(0); }); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === import.meta.filename) {
  main().catch((e) => { console.error(`${stamp()} 接收端启动失败：${e.message}`); process.exit(1); });
}
