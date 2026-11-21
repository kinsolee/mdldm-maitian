// 事件发件箱：按订阅方合批 POST，HMAC-SHA256 签名，失败按 1、5、15 分钟重试，
// 第 3 次重试仍失败发飞书卡片后停止自动重试；送达 2 小时没回执的重带一次、飞书提醒一次。
// 至少送达一次：bot 靠事件 id 去重。守护进程每轮抓完调 deliverPending，也能单独调。
import { createHmac, randomUUID } from 'node:crypto';
import { defaultNotify } from '../ops/login.mjs';
import { toEvent } from '../ops/engage/query.mjs';
import { applyEventFilters } from '../ops/engage/filter.mjs';

export const BATCH_SIZE = 20;
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;   // 第一次 + 3 次重试
export const ACK_TIMEOUT_MS = 2 * 3600_000;
export const POST_TIMEOUT_MS = 30_000;

const iso = (ms) => new Date(ms).toISOString();
export const signBody = (secret, raw) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

// 订阅方匹配的事件：类型、平台对得上，订阅之后产生的，还没回执的
const MATCH = `e.type IN (SELECT value FROM json_each(:types))
  AND (:platforms IS NULL OR e.platformCode IN (SELECT value FROM json_each(:platforms)))
  AND e.createdAt >= :since AND e.handledAt IS NULL`;

function enqueue(db, s) {
  db.prepare(`INSERT OR IGNORE INTO event_deliveries (eventId, subscriberId, nextAttemptAt)
    SELECT e.id, :sub, e.createdAt FROM events e WHERE ${MATCH}`).run({ sub: s.id, types: s.types, platforms: s.platforms, since: s.createdAt });
}

function due(db, s, nowMs) {
  return db.prepare(`SELECT e.*, d.attempts, d.lastAttemptAt, d.deliveredAt FROM event_deliveries d JOIN events e ON e.id = d.eventId
    WHERE d.subscriberId = :sub AND ${MATCH} AND (
      (d.deliveredAt IS NULL AND d.gaveUpAt IS NULL AND d.nextAttemptAt <= :now)
      OR (d.deliveredAt IS NOT NULL AND d.redeliveredAt IS NULL AND d.deliveredAt <= :ackDue))
    ORDER BY e.createdAt, e.id`)
    .all({ sub: s.id, types: s.types, platforms: s.platforms, since: s.createdAt, now: iso(nowMs), ackDue: iso(nowMs - ACK_TIMEOUT_MS) });
}

async function post(fetchImpl, url, headers, raw, timeoutMs) {
  try {
    const res = await fetchImpl(url, { method: 'POST', headers, body: raw, signal: AbortSignal.timeout(timeoutMs) });
    await res.text().catch(() => {});
    return res.ok ? null : `HTTP ${res.status}`;
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return `超时（${Math.round(timeoutMs / 1000)} 秒没响应）`;
    return `连不上（${e.cause?.code ?? e.name}）`;
  }
}

async function sendBatch(db, s, rows, { now, fetchImpl, timeoutMs }) {
  const batchId = `batch_${randomUUID()}`;
  const sentAt = iso(now());
  const events = rows.map((r) => toEvent(r, { attempts: r.deliveredAt ? r.attempts : r.attempts + 1, lastAttemptAt: sentAt, deliveredAt: r.deliveredAt }));
  const raw = JSON.stringify({ subscriberId: s.id, batchId, sentAt, events });
  const error = await post(fetchImpl, s.url, {
    'Content-Type': 'application/json', 'X-Maitian-Signature': signBody(s.secret, raw), 'X-Maitian-Timestamp': sentAt, 'X-Maitian-Batch': batchId,
  }, raw, timeoutMs);
  record(db, s, rows, { at: sentAt, error });
  return { subscriberId: s.id, batchId, size: rows.length, ok: !error, ...(error ? { error } : {}) };
}

function record(db, s, rows, { at, error }) {
  const atMs = Date.parse(at);
  const ok = db.prepare('UPDATE event_deliveries SET attempts = attempts + 1, lastAttemptAt = ?, deliveredAt = ?, nextAttemptAt = NULL, lastError = NULL WHERE eventId = ? AND subscriberId = ?');
  const fail = db.prepare('UPDATE event_deliveries SET attempts = ?, lastAttemptAt = ?, nextAttemptAt = ?, lastError = ?, gaveUpAt = ? WHERE eventId = ? AND subscriberId = ?');
  const redo = db.prepare('UPDATE event_deliveries SET redeliveredAt = ?, lastError = ? WHERE eventId = ? AND subscriberId = ?');
  for (const r of rows) {
    if (r.deliveredAt) { redo.run(at, error, r.id, s.id); continue; }   // 重带只带一次，失败也不再重试
    if (!error) { ok.run(at, at, r.id, s.id); continue; }
    const attempts = r.attempts + 1;
    const giveUp = attempts >= MAX_ATTEMPTS;
    fail.run(attempts, at, giveUp ? null : iso(atMs + RETRY_DELAYS_MS[attempts - 1]), error, giveUp ? at : null, r.id, s.id);
  }
  // 推成功了说明 bot 恢复了：之前停止自动重试的事件放回队列，下一轮推
  if (!error) db.prepare('UPDATE event_deliveries SET gaveUpAt = NULL, alertedAt = NULL, attempts = 0, nextAttemptAt = ? WHERE subscriberId = ? AND deliveredAt IS NULL AND gaveUpAt IS NOT NULL').run(at, s.id);
}

// 飞书里只写地址的 origin + path：query 里可能带 bot 自己的 token
function safeUrl(url) {
  try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return '（地址无法解析）'; }
}

// 两种提醒都按库里的状态算：没真发出（notify 不是 true）就不记，下一轮还会再发
async function alerts(db, s, { now, notify }) {
  let sent = 0;
  // 已回执的（例如后来被推送前过滤自动回执 skipped）不再算推送失败
  const failed = db.prepare(`SELECT d.eventId, d.lastError FROM event_deliveries d JOIN events e ON e.id = d.eventId
    WHERE d.subscriberId = ? AND d.deliveredAt IS NULL AND d.gaveUpAt IS NOT NULL AND d.alertedAt IS NULL AND e.handledAt IS NULL ORDER BY d.gaveUpAt DESC`).all(s.id);
  if (failed.length) {
    const text = `⚠️ 事件推送失败 | ${s.id}\n${failed.length} 条事件重试 ${RETRY_DELAYS_MS.length} 次仍没送达，最后的错误：${failed[0].lastError}\n接收地址：${safeUrl(s.url)}\n已停止自动重试。bot 可调 list_events({ unhandled: true }) 补；bot 重新登记或下一次推送成功后自动恢复。`;
    if ((await notify(text)) === true) {
      const mark = db.prepare('UPDATE event_deliveries SET alertedAt = ? WHERE eventId = ? AND subscriberId = ?');
      for (const f of failed) mark.run(iso(now()), f.eventId, s.id);
      sent++;
    }
  }
  const late = db.prepare(`SELECT d.eventId, e.type FROM event_deliveries d JOIN events e ON e.id = d.eventId
    WHERE d.subscriberId = ? AND d.deliveredAt IS NOT NULL AND d.deliveredAt <= ? AND e.handledAt IS NULL AND d.remindedAt IS NULL`).all(s.id, iso(now() - ACK_TIMEOUT_MS));
  if (late.length) {
    const byType = Object.entries(Object.groupBy(late, (r) => r.type)).map(([t, l]) => `${t} ${l.length}`).join('，');
    const text = `⏰ 事件 2 小时没回执 | ${s.id}\n${late.length} 条事件送达 2 小时还没 ack_event（${byType}），已在下一批重带一次。\n请检查 bot 是否在处理；漏的可调 list_events({ unhandled: true })。`;
    if ((await notify(text)) === true) {
      const mark = db.prepare('UPDATE event_deliveries SET remindedAt = ? WHERE eventId = ? AND subscriberId = ?');
      for (const l of late) mark.run(iso(now()), l.eventId, s.id);
      sent++;
    }
  }
  return sent;
}

/**
 * 推一轮。opts：now（毫秒时间函数）、fetchImpl、notify（返回 true 才算发出，默认飞书）、timeoutMs（默认 30 秒）。
 * 同一订阅方一批失败就不再推它后面的批次（地址多半整个不通），留到下一轮。
 * 推之前先跑确定过滤（filter.mjs）：命中的自动回执 skipped，不进任何订阅方的队列。
 * 返回 { batches: [{ subscriberId, batchId, size, ok, error? }], alerts, filtered: [{ eventId, rule }] }。
 */
export async function deliverPending(db, { now = Date.now, fetchImpl = fetch, notify = defaultNotify, timeoutMs = POST_TIMEOUT_MS } = {}) {
  const filtered = applyEventFilters(db, { now });
  const subs = db.prepare('SELECT * FROM subscribers WHERE active = 1 ORDER BY createdAt, id').all();
  const batches = [];
  let alertCount = 0;
  for (const s of subs) {
    enqueue(db, s);
    const rows = due(db, s, now());
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const b = await sendBatch(db, s, rows.slice(i, i + BATCH_SIZE), { now, fetchImpl, timeoutMs });
      batches.push(b);
      if (!b.ok) break;
    }
    alertCount += await alerts(db, s, { now, notify });
  }
  return { batches, alerts: alertCount, filtered };
}
