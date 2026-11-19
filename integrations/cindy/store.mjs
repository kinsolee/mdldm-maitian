// Cindy 侧本地收件箱：按事件 id 去重，记下待 Cindy 处理的事件。一个 sqlite 文件，重启不丢。
// 只存 id 和引用（平台、subjectId、会话 id、时间），不存评论私信正文：正文由 agent 用麦田 MCP 读。
// processedAt 只由 ledger.recordResults 在对照文件写成功之后打上。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const PENDING_LIMIT = 20;

const iso = (ms) => new Date(ms).toISOString();

export function openInbox(file, { readOnly = false } = {}) {
  if (!readOnly && file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, readOnly ? { readOnly: true } : {});
  if (!readOnly) {
    db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, platform TEXT, subjectId TEXT, conversationId TEXT,
        createdAt TEXT, receivedAt TEXT NOT NULL, source TEXT NOT NULL, processedAt TEXT);
      CREATE INDEX IF NOT EXISTS events_pending ON events (processedAt, createdAt);`);
  }

  const insert = readOnly ? null : db.prepare(`INSERT OR IGNORE INTO events (id, type, platform, subjectId, conversationId, createdAt, receivedAt, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const str = (v) => (typeof v === 'string' && v ? v : null);

  return {
    db,
    close: () => db.close(),

    /** 收下事件，返回 { accepted, duplicate }。source：push（麦田推送）或 backfill（list_events 补漏）。 */
    receive(events, now, source = 'push') {
      let accepted = 0;
      const at = iso(now);
      for (const e of events) {
        accepted += insert.run(e.id, e.type, str(e.platform), str(e.subjectId), str(e.payload?.conversationId), str(e.createdAt), at, source).changes;
      }
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
      const at = iso(now);
      const stmt = db.prepare('UPDATE events SET processedAt = ? WHERE id = ? AND processedAt IS NULL');
      for (const id of ids) stmt.run(at, id);
    },

    /** 收件箱里最新一条事件的 createdAt，补漏从这里往回退一段开始。 */
    latestCreatedAt() {
      return db.prepare('SELECT MAX(createdAt) AS t FROM events').get().t ?? null;
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
