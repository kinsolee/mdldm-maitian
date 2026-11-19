// ops.db：账号登记和（以后的）写操作记录。与麦田原库 data/hub.db 分开。
// 不存 spaceId：Ego 会回收闲置 space，编号会变（S0 00-spaces），一律按 spaceName 找。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { opsDir } from './paths.mjs';
import { PLATFORMS, CAPABILITIES, DEFAULT_PROFILE, PENDING, spaceNameOf } from './accounts.mjs';

export const LOGIN_STATES = ['ok', 'out', 'awaiting_user', 'unknown'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  platformCode TEXT NOT NULL,
  uid TEXT NOT NULL,
  platformName TEXT NOT NULL,
  nickname TEXT,
  profileId TEXT NOT NULL,
  spaceName TEXT NOT NULL UNIQUE,
  loginState TEXT NOT NULL DEFAULT 'unknown' CHECK (loginState IN ('ok','out','awaiting_user','unknown')),
  loginCheckedAt TEXT,
  capabilities TEXT NOT NULL,
  lastAlertAt TEXT,
  PRIMARY KEY (platformCode, uid)
);
-- S1 只建表、不写入：以后的回复、私信、发布都先在这里登记，幂等键防重
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caller TEXT NOT NULL,
  platformCode TEXT NOT NULL,
  uid TEXT NOT NULL,
  action TEXT NOT NULL,
  contentHash TEXT,
  readback TEXT,
  idempotencyKey TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT,
  FOREIGN KEY (platformCode, uid) REFERENCES accounts (platformCode, uid) ON UPDATE CASCADE
);
`;

export function openOpsDb(dir = opsDir()) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'ops.db'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  db.exec(SCHEMA);
  return db;
}

const parse = (row) => row && { ...row, capabilities: JSON.parse(row.capabilities) };

export const listAccounts = (db) => db.prepare('SELECT * FROM accounts ORDER BY rowid').all().map(parse);
export const getAccount = (db, platformCode) => parse(db.prepare('SELECT * FROM accounts WHERE platformCode=? ORDER BY rowid LIMIT 1').get(platformCode));

/**
 * 写入初始登记。幂等：某个平台已经有登记（哪怕 uid 已从 pending 改成真实值）就不动它。
 * @returns {{ added: string[], kept: string[] }}
 */
export function seedAccounts(db) {
  const added = [], kept = [];
  const has = db.prepare('SELECT 1 FROM accounts WHERE platformCode=?');
  const ins = db.prepare('INSERT INTO accounts (platformCode, uid, platformName, nickname, profileId, spaceName, loginState, capabilities) VALUES (?,?,?,?,?,?,?,?)');
  for (const p of PLATFORMS) {
    if (has.get(p.code)) { kept.push(p.code); continue; }
    ins.run(p.code, p.uid, p.name, null, DEFAULT_PROFILE, spaceNameOf(p.code, p.uid), 'unknown', JSON.stringify(p.caps));
    added.push(p.code);
  }
  return { added, kept };
}

export function setLoginState(db, { platformCode, uid }, state, checkedAt) {
  db.prepare('UPDATE accounts SET loginState=?, loginCheckedAt=COALESCE(?, loginCheckedAt) WHERE platformCode=? AND uid=?').run(state, checkedAt ?? null, platformCode, uid);
}

export function setLastAlertAt(db, { platformCode, uid }, at) {
  db.prepare('UPDATE accounts SET lastAlertAt=? WHERE platformCode=? AND uid=?').run(at, platformCode, uid);
}

/** uid 从 pending 改成真实值：主键和 spaceName 一起改，同时写登录状态；一个事务。返回新名字。 */
export const validUid = (v) => typeof v === 'string' && v !== '' && v !== PENDING && !/[/\s]/.test(v);

export function adoptUid(db, { platformCode, uid: oldUid }, newUid, state, checkedAt) {
  // 读到的值要能当主键和 space 名的一段：不能空、不能是 pending、不能含 / 或空白
  if (!validUid(newUid)) throw new Error(`读到的 uid 不合格（${typeof newUid}，长度 ${String(newUid ?? '').length}），登记没改`);
  const spaceName = spaceNameOf(platformCode, newUid);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE accounts SET uid=?, spaceName=?, loginState=?, loginCheckedAt=? WHERE platformCode=? AND uid=?').run(newUid, spaceName, state, checkedAt, platformCode, oldUid);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return spaceName;
}

/** 以后的写入类子命令先过这一关：能力没开就拒绝。 */
export function requireCapability(account, cap) {
  if (!CAPABILITIES.includes(cap)) return { ok: false, reason: 'capability-disabled', exitCode: 7, error: `没有这项能力：${cap}` };
  if (account?.capabilities?.[cap] !== true) return { ok: false, reason: 'capability-disabled', exitCode: 7, error: `${account?.platformName ?? account?.platformCode ?? '账号'} 没开 ${cap}` };
  return { ok: true };
}
