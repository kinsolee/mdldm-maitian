// Cindy 侧本地收件箱：按事件 id 去重，记下待 Cindy 处理的事件。一个 sqlite 文件，重启不丢。
// 只存 id 和引用（平台、subjectId、会话 id、时间），不存评论私信正文：正文由 agent 用麦田 MCP 读。
// processedAt 只由 ledger.recordResults 在对照文件写成功之后打上。
// 接收端、inbox.mjs record、inbox.mjs check、compare.mjs 是不同进程：开库都带 5 秒锁等待，批量写包事务。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const PENDING_LIMIT = 20;
export const BUSY_TIMEOUT_MS = 5000;
const WATERMARK = 'backfillWatermark';

const iso = (ms) => new Date(ms).toISOString();

/** 文件在不在。只有 ENOENT 算不在；没权限、路径上有文件挡着等真错误照常抛出。 */
export function exists(file) {
  try { fs.statSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

const text = (v) => typeof v === 'string' && v !== '';

/** 事件够不够用：agent 要靠 platform、subjectId 读上下文，补漏要靠 createdAt 定位。合格返回 null，否则返回原因。 */
export function eventProblem(e) {
  if (!e || typeof e !== 'object') return '不是对象';
  for (const k of ['id', 'type', 'platform', 'subjectId', 'createdAt']) if (!text(e[k])) return `缺 ${k}`;
  if (Number.isNaN(Date.parse(e.createdAt))) return 'createdAt 不是有效时间';
  return null;
}

export function openInbox(file, { readOnly = false } = {}) {
  if (!readOnly && file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { timeout: BUSY_TIMEOUT_MS, ...(readOnly ? { readOnly: true } : {}) });
  if (!readOnly) {
    db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, platform TEXT, subjectId TEXT, conversationId TEXT,
        createdAt TEXT, receivedAt TEXT NOT NULL, source TEXT NOT NULL, processedAt TEXT);
      CREATE INDEX IF NOT EXISTS events_pending ON events (processedAt, createdAt);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }

  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  return {
    db,
    close: () => db.close(),

    /** 收下事件，返回 { accepted, duplicate }。source：push（麦田推送）或 backfill（list_events 补漏）。整批一个事务。 */
    receive(events, now, source = 'push') {
      const bad = events.find((e) => eventProblem(e));
      if (bad) throw new Error(`事件不合格（${eventProblem(bad)}）`);
      const insert = db.prepare(`INSERT OR IGNORE INTO events (id, type, platform, subjectId, conversationId, createdAt, receivedAt, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      const at = iso(now);
      const accepted = tx(() => events.reduce((n, e) => n
        + insert.run(e.id, e.type, e.platform, e.subjectId, text(e.payload?.conversationId) ? e.payload.conversationId : null,
          new Date(e.createdAt).toISOString(), at, source).changes, 0));
      return { accepted, duplicate: events.length - accepted };
    },

    pendingCount() {
      return db.prepare('SELECT COUNT(*) AS n FROM events WHERE processedAt IS NULL').get().n;
    },

    /** 最早的一批还没处理的事件（只有 id 和引用）。 */
    pending(limit = PENDING_LIMIT) {
      return db.prepare(`SELECT id, type, platform, subjectId, conversationId, createdAt FROM events
        WHERE processedAt IS NULL ORDER BY createdAt, id LIMIT ?`).all(limit).map((r) => ({ ...r }));
    },

    get(id) {
      const r = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
      return r ? { ...r } : null;
    },

    markProcessed(ids, now) {
      const stmt = db.prepare('UPDATE events SET processedAt = ? WHERE id = ? AND processedAt IS NULL');
      const at = iso(now);
      tx(() => { for (const id of ids) stmt.run(at, id); });
    },

    /** 上次补漏成功开始时的时间（毫秒），没补过返回 null。 */
    watermark() {
      const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(WATERMARK);
      return r ? Date.parse(r.value) : null;
    },

    setWatermark(ms) {
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(WATERMARK, iso(ms));
    },

    all() {
      return db.prepare('SELECT * FROM events ORDER BY createdAt, id').all().map((r) => ({ ...r }));
    },

    stats() {
      return { ...db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(processedAt IS NOT NULL), 0) AS processed,
        COALESCE(SUM(processedAt IS NULL), 0) AS pending FROM events`).get() };
    },
  };
}
