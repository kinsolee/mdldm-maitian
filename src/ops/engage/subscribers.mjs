// bot 订阅登记。密钥只在首次登记的返回值里给一次；重复登记只更新地址、类型、平台。
import { randomBytes } from 'node:crypto';
import { checkPlatforms } from './ids.mjs';

export const EVENT_TYPES = ['comment.created', 'dm.received', 'account.login_lost', 'sync.failed', 'work.punished', 'flow.alert'];
const iso = (ms) => new Date(ms).toISOString();

function checkInput({ subscriberId, url, types, platforms }) {
  if (typeof subscriberId !== 'string' || !/^[\w.-]{1,64}$/.test(subscriberId)) throw new Error('subscriberId 只能用字母、数字、_ . -，1 到 64 个字符');
  let u;
  try { u = new URL(url); } catch { u = null; }
  if (!u || !['http:', 'https:'].includes(u.protocol)) throw new Error(`url 只接受 http 或 https 地址：${JSON.stringify(url)}`);
  if (!Array.isArray(types) || !types.length) throw new Error('types 要是非空数组');
  for (const t of types) if (!EVENT_TYPES.includes(t)) throw new Error(`不认识的事件类型：${t}（可选：${EVENT_TYPES.join(', ')}）`);
  return { url: u.href, types: [...new Set(types)], platforms: checkPlatforms(platforms) };
}

/**
 * 登记或更新订阅。新登记返回 { created: true, subscriberId, secret }（32 字节 hex，只给这一次）；
 * 已登记过（包括退订过的）返回 { created: false, subscriberId }，重新置为 active，密钥不变；
 * 同时把这个订阅方停止自动重试的事件放回队列（见 outbox.mjs）。
 */
export function subscribe(db, input, { now = Date.now } = {}) {
  const { url, types, platforms } = checkInput(input);
  const id = input.subscriberId;
  const at = iso(now());
  const plat = platforms ? JSON.stringify(platforms) : null;
  if (db.prepare('SELECT 1 FROM subscribers WHERE id = ?').get(id)) {
    db.prepare('UPDATE subscribers SET url = ?, types = ?, platforms = ?, updatedAt = ?, active = 1 WHERE id = ?').run(url, JSON.stringify(types), plat, at, id);
    db.prepare('UPDATE event_deliveries SET gaveUpAt = NULL, alertedAt = NULL, attempts = 0, nextAttemptAt = ? WHERE subscriberId = ? AND deliveredAt IS NULL AND gaveUpAt IS NOT NULL').run(at, id);
    return { created: false, subscriberId: id, url, types, platforms };
  }
  const secret = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO subscribers (id, url, types, platforms, secret, createdAt, updatedAt, active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
    .run(id, url, JSON.stringify(types), plat, secret, at, at);
  return { created: true, subscriberId: id, url, types, platforms, secret };
}

/** 退订：置 inactive，不再推；没送达的事件留在库里，可以用 list_events 取。 */
export function unsubscribe(db, subscriberId, { now = Date.now } = {}) {
  const r = db.prepare('UPDATE subscribers SET active = 0, updatedAt = ? WHERE id = ?').run(iso(now()), subscriberId);
  if (!r.changes) throw new Error(`没有这个订阅方：${subscriberId}`);
  return { subscriberId, active: false };
}
