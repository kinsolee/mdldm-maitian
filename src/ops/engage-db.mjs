// S6a 评论私信、事件发件箱、订阅、抓取任务的表。都是 IF NOT EXISTS，重复跑不动已有数据。
// 主键一律存拼好的 <platformCode>:<原生 id>；时间一律 ISO 字符串（UTC）。
// engage_works：评论所属作品的基本信息（S6a 自己的表）。S3（KIN-328）的作品和指标在 works 表（src/ops/works-db.mjs），两张表同库不同名，互不覆盖。
function addColumnIfMissing(db, table, col, type) {
  if (db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  } catch (e) {
    if (!/duplicate column name/i.test(String(e?.message ?? ''))) throw e;
  }
}

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
-- SDK 补上 serverId 后，仍能用旧快照里的 clientMessageId 找回同一行。
CREATE TABLE IF NOT EXISTS douyin_dm_client_ids (
  conversationId TEXT NOT NULL, clientId TEXT NOT NULL, serverId TEXT NOT NULL,
  PRIMARY KEY (conversationId, clientId)
);
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
-- S7 engage 写入：每次 reply_comment / send_dm 调用一行（含被拒、重复的）。只存正文的 sha256，不存正文。
-- status：pending（正在发）、sent、needs_readback、failed、duplicate、rejected。sendAttempted：点过发送 / 调过发送接口。
-- roundKey：整点小时（UTC，'YYYY-MM-DDTHH'），每轮上限和连续失败按它算。
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY, op TEXT NOT NULL, caller TEXT, accountId TEXT, platformCode TEXT NOT NULL, targetId TEXT NOT NULL,
  textHash TEXT NOT NULL, idempotencyKey TEXT NOT NULL, eventId TEXT,
  status TEXT NOT NULL, reason TEXT, detail TEXT, sendAttempted INTEGER NOT NULL DEFAULT 0, readBack TEXT,
  roundKey TEXT NOT NULL, createdAt TEXT NOT NULL, finishedAt TEXT,
  targetLastAt TEXT   -- send_dm 发信时库里会话的 lastAt（平台时间），用它判断「对方之后有没有再说话」，不拿本机时钟和平台时间比
);
CREATE INDEX IF NOT EXISTS actions_key ON actions (idempotencyKey, createdAt);
CREATE INDEX IF NOT EXISTS actions_round ON actions (platformCode, roundKey);
CREATE INDEX IF NOT EXISTS actions_target ON actions (targetId, op, createdAt);
CREATE INDEX IF NOT EXISTS actions_status ON actions (status, createdAt);
-- 平台写入租约：同一平台同一时间只有一个写入方（跨 MCP 进程）。过期的可以接管。
CREATE TABLE IF NOT EXISTS engage_write_leases (platformCode TEXT PRIMARY KEY, holder TEXT NOT NULL, acquiredAt TEXT NOT NULL, expiresAt TEXT NOT NULL);
-- 连续 2 轮写入失败自动关写能力位的记录；alertedAt 是提醒真发出的时间（没发出下次调用时补发）
CREATE TABLE IF NOT EXISTS engage_write_trips (id TEXT PRIMARY KEY, platformCode TEXT NOT NULL, trippedAt TEXT NOT NULL, rounds TEXT NOT NULL, detail TEXT, alertedAt TEXT);
-- 升级前的库：已经有评论、会话行的账号补上基线，免得升级后再吞一轮
INSERT OR IGNORE INTO engage_baselines SELECT accountId, 'comments', min(firstSeenAt) FROM comments GROUP BY accountId;
INSERT OR IGNORE INTO engage_baselines SELECT accountId, 'dms', min(firstSeenAt) FROM conversations GROUP BY accountId;
`);
  // 本分支早期建的 actions 没有 targetLastAt
  addColumnIfMissing(db, 'actions', 'targetLastAt', 'TEXT');
  // 推送前过滤（filter.mjs）命中的规则名；没命中为 NULL
  addColumnIfMissing(db, 'events', 'filteredReason', 'TEXT');
  // 对方发出时间（ISO，UTC）：评论取 comments.createdAt，私信取 last.at；旧行与系统事件为 NULL。createdAt 保持入库时间不变
  addColumnIfMissing(db, 'events', 'occurredAt', 'TEXT');
  // 只有 SDK 明确给出的 serverId 才能区分同时间的两条对方私信；旧行保留 NULL。
  addColumnIfMissing(db, 'messages', 'douyinServerId', 'TEXT');
  // 自动关分两组：write（回复、私信）、moderate（删评论、拉黑、删会话）。旧记录 NULL 当 write
  addColumnIfMissing(db, 'engage_write_trips', 'family', 'TEXT');
}
