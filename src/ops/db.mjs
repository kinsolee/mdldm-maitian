// ops.db：运营侧的账号表（和麦田原库 data/hub.db 分开）。S1 只建 accounts。
// 不存 space id：Ego 会回收闲置 space，一律按 spaceName 找。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { migrateEngage } from './engage-db.mjs';

export function openOpsDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  platformCode TEXT NOT NULL,
  platformName TEXT NOT NULL,
  uid TEXT NOT NULL,
  nickname TEXT,
  profileId TEXT NOT NULL DEFAULT 'Profile 5',
  spaceName TEXT NOT NULL,
  loginState TEXT NOT NULL DEFAULT 'unknown' CHECK (loginState IN ('ok', 'out', 'awaiting_user', 'unknown')),
  loginCheckedAt TEXT,
  loginEvidence TEXT,
  capabilities TEXT NOT NULL,
  alertSentAt TEXT,          -- 上次发掉线/UID 不符提醒的时间（6 小时节流）
  PRIMARY KEY (platformCode, uid)
);`);
  migrateEngage(db);
  return db;
}
