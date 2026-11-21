// 接收端本地状态：按事件 id 去重 + 待投递队列。一个 sqlite 文件，重启不丢。
// 一行一个事件。batchKey 在第一次取出投递时定下，之后重试一直用同一批、同一个键。
// 攒批：队里最早一条还没分批的事件进队满 batchWindowMs 后，才把队里没分批的事件一次切成一批。按库里的 receivedAt 算，重启不清零。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const BATCH_SIZE = 100;   // 一批最多这么多条（窗口里攒的超过了，剩下的紧接着再切一批）
export const DEFAULT_BATCH_WINDOW_MS = 30 * 60_000;
export const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

const iso = (ms) => new Date(ms).toISOString();

/** 批次键：排序后的事件 id 列表的哈希。同一组事件永远得到同一个键，OpenBot 靠它（--id）挡重复投递。 */
export function batchKey(ids) {
  return createHash('sha256').update([...ids].sort().join('\n')).digest('hex').slice(0, 32);
}

export function openStore(file, { batchWindowMs = DEFAULT_BATCH_WINDOW_MS } = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, receivedAt TEXT NOT NULL,
      batchKey TEXT, attempts INTEGER NOT NULL DEFAULT 0, nextAttemptAt TEXT,
      forwardedAt TEXT, deliveryId TEXT, lastError TEXT, gaveUpAt TEXT);
    CREATE INDEX IF NOT EXISTS events_pending ON events (forwardedAt, gaveUpAt, receivedAt);`);

  const insert = db.prepare('INSERT OR IGNORE INTO events (id, type, receivedAt, nextAttemptAt) VALUES (?, ?, ?, ?)');
  const unbatchedSince = () => {
    const r = db.prepare('SELECT MIN(receivedAt) AS t FROM events WHERE batchKey IS NULL AND forwardedAt IS NULL AND gaveUpAt IS NULL').get();
    return r?.t ? Date.parse(r.t) : null;
  };

  return {
    db,
    close: () => db.close(),

    /** 收下一批事件，返回 { accepted, duplicate }。已见过的 id 不再入队。 */
    receive(events, now) {
      let accepted = 0;
      const at = iso(now);
      for (const e of events) accepted += insert.run(e.id, e.type, at, at).changes;
      return { accepted, duplicate: events.length - accepted };
    },

    /** 取下一批到点要投递的事件：先取已定键的重试批；没有的话，最早一条未分批的进队满窗口才切一批并定键。 */
    nextBatch(now) {
      const at = iso(now);
      const retry = db.prepare(`SELECT batchKey FROM events WHERE batchKey IS NOT NULL AND forwardedAt IS NULL AND gaveUpAt IS NULL
        AND nextAttemptAt <= ? ORDER BY nextAttemptAt, receivedAt LIMIT 1`).get(at);
      if (retry) {
        const rows = db.prepare('SELECT id, attempts FROM events WHERE batchKey = ? ORDER BY id').all(retry.batchKey);
        return { key: retry.batchKey, ids: rows.map((r) => r.id), attempts: rows[0].attempts };
      }
      const oldest = unbatchedSince();
      if (oldest == null || oldest + batchWindowMs > now) return null;
      const rows = db.prepare(`SELECT id FROM events WHERE batchKey IS NULL AND forwardedAt IS NULL AND gaveUpAt IS NULL
        ORDER BY receivedAt, id LIMIT ?`).all(BATCH_SIZE);
      if (!rows.length) return null;
      const ids = rows.map((r) => r.id).sort();
      const key = batchKey(ids);
      const stamp = db.prepare('UPDATE events SET batchKey = ? WHERE id = ?');
      for (const id of ids) stamp.run(key, id);
      return { key, ids, attempts: 0 };
    },

    markForwarded(key, deliveryId, now) {
      db.prepare('UPDATE events SET forwardedAt = ?, deliveryId = ?, attempts = attempts + 1, lastError = NULL, nextAttemptAt = NULL WHERE batchKey = ?')
        .run(iso(now), deliveryId ?? null, key);
    },

    /** 记一次失败。返回 { attempts, gaveUp, nextAttemptAt }。用尽后这批不再重试，留给 agent 的 list_events 补漏。 */
    markFailed(key, error, now) {
      const { attempts } = db.prepare('SELECT attempts FROM events WHERE batchKey = ? LIMIT 1').get(key);
      const n = attempts + 1;
      const gaveUp = n >= MAX_ATTEMPTS;
      const next = gaveUp ? null : iso(now + RETRY_DELAYS_MS[n - 1]);
      db.prepare('UPDATE events SET attempts = ?, lastError = ?, nextAttemptAt = ?, gaveUpAt = ? WHERE batchKey = ?')
        .run(n, error, next, gaveUp ? iso(now) : null, key);
      return { attempts: n, gaveUp, nextAttemptAt: next };
    },

    /** 下一个到点时间（毫秒）：重试批的 nextAttemptAt 和未分批的「最早进队 + 窗口」取早的；没有待投递的返回 null。 */
    nextDueAt() {
      const r = db.prepare(`SELECT MIN(nextAttemptAt) AS t FROM events WHERE batchKey IS NOT NULL AND forwardedAt IS NULL AND gaveUpAt IS NULL`).get();
      const retry = r?.t ? Date.parse(r.t) : null;
      const oldest = unbatchedSince();
      const fresh = oldest == null ? null : oldest + batchWindowMs;
      if (retry == null) return fresh;
      return fresh == null ? retry : Math.min(retry, fresh);
    },

    stats() {
      return db.prepare(`SELECT COUNT(*) AS total, SUM(forwardedAt IS NOT NULL) AS forwarded,
        SUM(forwardedAt IS NULL AND gaveUpAt IS NULL) AS pending, SUM(gaveUpAt IS NOT NULL) AS gaveUp FROM events`).get();
    },
  };
}
