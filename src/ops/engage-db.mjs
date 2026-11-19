// S6a 评论私信、事件发件箱、订阅、抓取任务的表。都是 IF NOT EXISTS，重复跑不动已有数据。
// 主键一律存拼好的 <platformCode>:<原生 id>；时间一律 ISO 字符串（UTC）。
// engage_works：评论所属作品的基本信息（S6a 自己的表）。S3（KIN-328）的作品和指标在 works 表（src/ops/works-db.mjs），两张表同库不同名，互不覆盖。
export function migrateEngage(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS engage_works (
  id TEXT PRIMARY KEY, accountId TEXT NOT NULL, platformCode TEXT NOT NULL, nativeId TEXT NOT NULL,
  title TEXT, url TEXT, postTime TEXT,
  status TEXT NOT NULL DEFAULT 'unknown', visibility TEXT NOT NULL DEFAULT 'unknown',
  metrics TEXT, metricsAt TEXT, monitored INTEGER NOT NULL DEFAULT 0,
  firstSeenAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
-- 楼中楼核实不了的作品（get_comment_thread 返回 partial: true）
CREATE TABLE IF NOT EXISTS thread_partial (workId TEXT PRIMARY KEY, partial INTEGER NOT NULL, updatedAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY, workId TEXT NOT NULL, accountId TEXT NOT NULL, platformCode TEXT NOT NULL,
  parentId TEXT, rootId TEXT NOT NULL, depth INTEGER NOT NULL,
  authorUid TEXT, authorNickname TEXT, authorIsMe INTEGER NOT NULL DEFAULT 0,
  replyToUid TEXT, replyToNickname TEXT,
  text TEXT, createdAt TEXT, likeCount INTEGER, likedByMe INTEGER, pinned INTEGER, replyCount INTEGER, ipLabel TEXT,
  firstSeenAt TEXT NOT NULL, lastSeenAt TEXT NOT NULL, goneAt TEXT
);
CREATE INDEX IF NOT EXISTS comments_parent ON comments (parentId);
CREATE INDEX IF NOT EXISTS comments_root ON comments (rootId);
CREATE INDEX IF NOT EXISTS comments_work ON comments (workId);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, accountId TEXT NOT NULL, platformCode TEXT NOT NULL,
  peerUid TEXT, peerNickname TEXT, peerKind TEXT,
  unread INTEGER NOT NULL DEFAULT 0, lastBy TEXT, lastAt TEXT, lastText TEXT, lastType TEXT, canSend INTEGER,
  firstSeenAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, accountId TEXT NOT NULL,
  by TEXT NOT NULL, at TEXT, type TEXT, text TEXT, firstSeenAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_conv ON messages (conversationId, at);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, platformCode TEXT NOT NULL, accountId TEXT, subjectId TEXT,
  createdAt TEXT NOT NULL, payload TEXT NOT NULL,
  handledAt TEXT, handledOutcome TEXT, handledNote TEXT, actionId TEXT
);
CREATE INDEX IF NOT EXISTS events_created ON events (createdAt, id);
-- 每个事件对每个订阅方一行。gaveUpAt：重试用完、停止自动重试；alertedAt：那张「推送失败」飞书卡片真发出的时间
CREATE TABLE IF NOT EXISTS event_deliveries (
  eventId TEXT NOT NULL, subscriberId TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, lastAttemptAt TEXT, deliveredAt TEXT, nextAttemptAt TEXT, lastError TEXT,
  gaveUpAt TEXT, alertedAt TEXT, redeliveredAt TEXT, remindedAt TEXT,
  PRIMARY KEY (eventId, subscriberId)
);
CREATE TABLE IF NOT EXISTS subscribers (
  id TEXT PRIMARY KEY, url TEXT NOT NULL, types TEXT NOT NULL, platforms TEXT, secret TEXT NOT NULL,
  createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sync_jobs (
  id TEXT PRIMARY KEY, platformCode TEXT NOT NULL, accountId TEXT, kind TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'refresh_now')),
  status TEXT NOT NULL CHECK (status IN ('requested', 'running', 'ok', 'skipped', 'failed')),
  requestedAt TEXT NOT NULL, startedAt TEXT, finishedAt TEXT, error TEXT, stats TEXT
);
CREATE INDEX IF NOT EXISTS sync_jobs_platform ON sync_jobs (platformCode, kind, requestedAt);
-- 每个账号每种 kind 第一次成功入库的时间。有这行才出事件（空的首轮也算建立了基线）
CREATE TABLE IF NOT EXISTS engage_baselines (accountId TEXT NOT NULL, kind TEXT NOT NULL, establishedAt TEXT NOT NULL, PRIMARY KEY (accountId, kind));
-- 升级前的库：已经有评论、会话行的账号补上基线，免得升级后再吞一轮
INSERT OR IGNORE INTO engage_baselines SELECT accountId, 'comments', min(firstSeenAt) FROM comments GROUP BY accountId;
INSERT OR IGNORE INTO engage_baselines SELECT accountId, 'dms', min(firstSeenAt) FROM conversations GROUP BY accountId;
`);
}
