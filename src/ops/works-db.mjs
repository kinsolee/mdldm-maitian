// S3 作品和粉丝的库表（建在 ops.db 里，和账号表同库）。由这里建表，不改 db.mjs：兄弟 spec 也在动 src/ops/，共用文件少碰。
// 作品记录、账号记录都按小V猫同形的 JSON 原样存，导出时原样写出，字段顺序不丢。
export function ensureWorksTables(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS collect_runs (
  runId TEXT NOT NULL,
  platformCode TEXT NOT NULL,
  uid TEXT,                  -- 表里没有这个平台的账号时为空
  startedAt TEXT NOT NULL,
  finishedAt TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('ok', 'out', 'skipped', 'failed', 'uid-mismatch')),
  reason TEXT,
  message TEXT,
  postCount INTEGER,
  stats TEXT                 -- 平台模块 map 给的诊断（翻页数、各接口返回码等，不含凭据），JSON
);
CREATE INDEX IF NOT EXISTS collect_runs_ok ON collect_runs (platformCode, uid, result, finishedAt);
CREATE TABLE IF NOT EXISTS works (
  platformCode TEXT NOT NULL,
  uid TEXT NOT NULL,
  postId TEXT NOT NULL,
  record TEXT NOT NULL,      -- 最近一次采集到的记录（小V猫 posts 同形）
  postTime TEXT,
  firstSeenAt TEXT NOT NULL,
  lastSeenAt TEXT NOT NULL,
  lastRunId TEXT NOT NULL,
  PRIMARY KEY (platformCode, uid, postId)
);
CREATE TABLE IF NOT EXISTS work_snapshots (
  runId TEXT NOT NULL,
  platformCode TEXT NOT NULL,
  uid TEXT NOT NULL,
  postId TEXT NOT NULL,
  collectedAt TEXT NOT NULL,
  record TEXT NOT NULL,
  PRIMARY KEY (runId, platformCode, uid, postId)
);
CREATE TABLE IF NOT EXISTS account_snapshots (
  runId TEXT NOT NULL,
  platformCode TEXT NOT NULL,
  uid TEXT NOT NULL,
  collectedAt TEXT NOT NULL,
  fans REAL,
  loginStatus TEXT,
  record TEXT NOT NULL,      -- 小V猫 accounts 同形（uid, loginStatus, fans, updateTime, daily）
  PRIMARY KEY (runId, platformCode, uid)
);
CREATE TABLE IF NOT EXISTS fans_daily (
  platformCode TEXT NOT NULL,
  uid TEXT NOT NULL,
  date TEXT NOT NULL,        -- YYYY-MM-DD
  fansTotal REAL,
  fansNet REAL,
  collectedAt TEXT NOT NULL,
  PRIMARY KEY (platformCode, uid, date)
);`);
  // 早期建的 collect_runs 没有 stats 列（CREATE TABLE IF NOT EXISTS 不会补列）
  if (!db.prepare('PRAGMA table_info(collect_runs)').all().some((c) => c.name === 'stats')) db.exec('ALTER TABLE collect_runs ADD COLUMN stats TEXT');
}

export function recordRun(db, row) {
  db.prepare('INSERT INTO collect_runs (runId, platformCode, uid, startedAt, finishedAt, result, reason, message, postCount, stats) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(row.runId, row.platformCode, row.uid ?? null, row.startedAt, row.finishedAt, row.result, row.reason ?? null, row.message ?? null, row.postCount ?? null, row.stats == null ? null : JSON.stringify(row.stats));
}

/**
 * 一个账号这次采集的结果整段写进去（一个事务，失败整段回滚后抛出）。
 * fans_daily：平台这次给了 null 的不覆盖已有的非 null 值（B站分日没有总数，抖音的当天可能还没出）。
 */
export function saveCollected(db, { runId, platformCode, uid, at, posts, account }) {
  const upsertWork = db.prepare(`INSERT INTO works (platformCode, uid, postId, record, postTime, firstSeenAt, lastSeenAt, lastRunId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (platformCode, uid, postId) DO UPDATE SET record = excluded.record, postTime = excluded.postTime, lastSeenAt = excluded.lastSeenAt, lastRunId = excluded.lastRunId`);
  const snap = db.prepare('INSERT INTO work_snapshots (runId, platformCode, uid, postId, collectedAt, record) VALUES (?, ?, ?, ?, ?, ?)');
  const accSnap = db.prepare('INSERT INTO account_snapshots (runId, platformCode, uid, collectedAt, fans, loginStatus, record) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const daily = db.prepare(`INSERT INTO fans_daily (platformCode, uid, date, fansTotal, fansNet, collectedAt) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (platformCode, uid, date) DO UPDATE SET fansTotal = COALESCE(excluded.fansTotal, fansTotal), fansNet = COALESCE(excluded.fansNet, fansNet), collectedAt = excluded.collectedAt`);
  db.exec('BEGIN');
  try {
    for (const p of posts) {
      const rec = JSON.stringify(p);
      upsertWork.run(platformCode, uid, p.postId, rec, p.postTime ?? null, at, at, runId);
      snap.run(runId, platformCode, uid, p.postId, at, rec);
    }
    accSnap.run(runId, platformCode, uid, at, account.fans ?? null, account.loginStatus ?? null, JSON.stringify(account));
    for (const d of account.daily ?? []) daily.run(platformCode, uid, d.date, d.fansTotal ?? null, d.fansNet ?? null, at);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
