// S7 engage 写入：reply_comment / send_dm 的核心（MCP engage 组只做参数校验和转发到这里）。
// 一次调用的顺序：幂等 → 目标和账号 → 能力位 → 库里预检 → 每轮上限 → 平台写入租约 → 记 pending（这几步在一个 IMMEDIATE 事务里）
// → 在账号的 space 里跑写入脚本（runner 自带 space 锁；脚本在页面上重读、只发一次、发后回读）→ 落结果、放租约、成功就回执事件
// → 写入失败时看是否连续 2 轮失败，是就关掉这个平台的写能力位并发提醒。
// 每次调用都记 actions（含被拒、重复的），只存正文的 sha256。绝不重试：回读不到记 needs_readback，同一个 key 之后也不再发。
// 处置组（delete、block、deleteConversation，只做 B站）走同一条流程，库里那一半在 moderate.mjs；每轮上限、连续失败自动关和回复组分开算。
import { createHash, randomUUID } from 'node:crypto';
import { getAccount, listAccounts, setCapability, PLATFORM_NAMES } from '../accounts.mjs';
import { ENGAGE_PLATFORMS } from '../../daemon/schedule.mjs';
import { splitId } from './ids.mjs';
import { ackEvent } from './query.mjs';
import { redact } from './redact.mjs';
import { runWriterInSpace, WRITE_TIMEOUT_MS } from './writers/index.mjs';
import { MOD_OPS, MOD_CAPS, MOD_ROUND_LIMIT, MOD_PLATFORMS, resolveBlockTarget, loadModTarget, selfTarget, modEventMatches, modAckSubject, modPrecheck, selfUids } from './moderate.mjs';

export const STATUSES = ['sent', 'needs_readback', 'failed', 'duplicate', 'rejected'];
export const ROUND_LIMIT = 15;
export const IDEMPOTENCY_WINDOW_MS = 24 * 3600_000;
export const MAX_TEXT = 1000;
export const LEASE_TABLE = 'engage_write_leases';
export const WRITE_CAPS = ['reply', 'sendDM', 'likeComment', 'pinComment'];
// 页面平台最长 6 分钟 + runner 超时后等旧脚本 30 秒；pending 超过这么久还没落结果，就是进程崩了，按 needs_readback 处理
const PENDING_STALE_MS = 30 * 60_000;
const LEASE_GRACE_MS = 2 * 60_000;

const OPS = {
  reply: { cap: 'reply', what: 'commentId', eventType: 'comment.created', family: 'write', ackOutcome: 'replied', needsText: true },
  sendDM: { cap: 'sendDM', what: 'conversationId', eventType: 'dm.received', family: 'write', ackOutcome: 'replied', needsText: true },
  ...MOD_OPS,
};
// 两组各自算每轮上限、各自连续失败自动关：write 组全平台合计 15 条一轮，moderate 组每种操作分别 10 条一轮
const FAMILIES = {
  write: { ops: ['reply', 'sendDM'], caps: WRITE_CAPS, limit: ROUND_LIMIT, perOp: false, label: '评论私信写入' },
  moderate: { ops: Object.keys(MOD_OPS), caps: MOD_CAPS, limit: MOD_ROUND_LIMIT, perOp: true, label: '评论私信处置（删评论、拉黑、删会话）' },
};
const inList = (ops) => ops.map((o) => `'${o}'`).join(', ');
// runner 在脚本开跑之前就失败的原因：肯定没发
const BEFORE_SCRIPT = { busy: 'space-busy', 'user-controlled': 'space-user-controlled', 'profile-needed': 'profile-needed',
  'profile-rejected': 'profile-rejected', 'bad-space-name': 'bad-space-name', 'spawn-failed': 'runner-not-started', 'open-space-failed': 'runner-not-started' };
const RETRYABLE = new Set(['space-busy', 'space-user-controlled', 'lease-busy', 'round-limit', 'in-progress', 'input-mismatch', 'runner-not-started', 'precheck-error']);

const iso = (ms) => new Date(ms).toISOString();
export const roundKeyOf = (ms) => iso(ms).slice(0, 13);   // 整点小时（UTC）；台湾是 +8 整小时，同一个整点
const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
const nativeOf = (id) => (id == null ? null : String(id).slice(String(id).indexOf(':') + 1));

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function checkInput({ op, targetId, text, idempotencyKey, eventId = null, caller = null } = {}) {
  const spec = OPS[op];
  if (!spec) throw new Error(`op 只能是 ${Object.keys(OPS).join('、')}：${op}`);
  const { platformCode } = splitId(targetId, spec.what);
  if (spec.needsText) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('text 不能为空');
    if (text.length > MAX_TEXT) throw new Error(`text 最多 ${MAX_TEXT} 字，收到 ${text.length} 字`);
  } else text = '';
  if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 300) throw new Error('idempotencyKey 要是 1 到 300 字的字符串（建议填事件 id）');
  if (eventId != null && (typeof eventId !== 'string' || !eventId)) throw new Error('eventId 要是字符串');
  return { op, spec, targetId, inputId: targetId, platformCode, text, idempotencyKey, eventId, caller: caller == null ? null : String(caller).slice(0, 200) };
}

// ---------- 库里的目标 ----------

function loadTarget(db, req) {
  if (req.spec.family === 'moderate') return loadModTarget(db, req);
  if (req.op === 'reply') {
    const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.targetId);
    if (!c) return null;
    return { accountId: c.accountId, row: c,
      target: { commentId: nativeOf(c.id), workId: nativeOf(c.workId), parentId: nativeOf(c.parentId), rootId: nativeOf(c.rootId),
        authorUid: c.authorUid, authorNickname: c.authorNickname, commentText: c.text } };
  }
  const k = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.targetId);
  if (!k) return null;
  return { accountId: k.accountId, row: k, target: { conversationId: nativeOf(k.id), peerUid: k.peerUid, peerNickname: k.peerNickname } };
}

/** 库里就能看出不该发的：评论已删、已有我对它的直接回复；对方不能收私信、最后一句已是我。 */
function dbPrecheck(db, req, row) {
  if (req.spec.family === 'moderate') return modPrecheck(req, row);
  if (req.op === 'reply') {
    if (row.goneAt) return ['comment-gone', `库里这条评论 ${row.goneAt} 起已不在平台上`];
    const mine = db.prepare('SELECT id FROM comments WHERE parentId = ? AND authorIsMe = 1 AND goneAt IS NULL LIMIT 1').get(req.targetId);
    if (mine) return ['already-replied', `库里已有我的回复 ${mine.id}`];
    return null;
  }
  if (row.canSend === 0) return ['cannot-send', '这个会话不能发私信（官方号等）'];
  if (row.lastBy === 'me') return ['last-is-me', `库里会话最后一句是我（${row.lastAt ?? '时间不明'}）`];
  return null;
}

function eventMatches(db, req) {
  if (req.spec.family === 'moderate') return modEventMatches(db, req);
  if (req.eventId == null) return true;
  const e = db.prepare('SELECT type, subjectId FROM events WHERE id = ?').get(req.eventId);
  return !!e && e.type === req.spec.eventType && e.subjectId === req.targetId;
}

// ---------- actions ----------

function insertAction(db, req, fields, now) {
  const id = `act_${randomUUID()}`;
  const at = iso(now());
  db.prepare(`INSERT INTO actions (id, op, caller, accountId, platformCode, targetId, textHash, idempotencyKey, eventId, status, reason, detail, sendAttempted, readBack, roundKey, createdAt, finishedAt, targetLastAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, req.op, req.caller, fields.accountId ?? null, req.platformCode, req.targetId, sha256(req.text),
    req.idempotencyKey, req.eventId, fields.status, fields.reason ?? null, fields.detail ?? null, fields.sendAttempted ? 1 : 0,
    fields.readBack ? JSON.stringify(fields.readBack) : null, roundKeyOf(now()), at, fields.status === 'pending' ? null : at, fields.targetLastAt ?? null);
  return id;
}

function finishAction(db, id, o, now) {
  db.prepare('UPDATE actions SET status = ?, reason = ?, detail = ?, sendAttempted = ?, readBack = ?, finishedAt = ? WHERE id = ?')
    .run(o.status, o.reason ?? null, o.detail ?? null, o.sendAttempted ? 1 : 0, o.readBack ? JSON.stringify(o.readBack) : null, iso(now()), id);
}

// 占用一个 key 的记录：24 小时内 sent 的，以及任何时候的 pending、真点过发送的 needs_readback（点了发送没确认的永远不重发）。
// 被拒、没发出（failed、rejected）的不占用。needs_readback 被拦时也会记一行 needs_readback（sendAttempted=0，只是审计），
// 它不占用：否则人工把原记录改掉之后，审计行还会一直拦着。真发过或中断回收的 needs_readback 一定是 sendAttempted=1。
const REAL_NEEDS_READBACK = `(status = 'needs_readback' AND sendAttempted = 1)`;
const HOLDS_KEY = `((status = 'sent' AND createdAt >= ?) OR status = 'pending' OR ${REAL_NEEDS_READBACK})`;
/** 同一个 key 最近一次占用它的记录。 */
const blockingPrior = (db, key, since) => db.prepare(`SELECT * FROM actions WHERE idempotencyKey = ? AND ${HOLDS_KEY} ORDER BY createdAt DESC, rowid DESC LIMIT 1`).get(key, since);
const otherTarget = (db, req, since) => db.prepare(`SELECT id FROM actions WHERE idempotencyKey = ? AND ${HOLDS_KEY} AND (targetId <> ? OR op <> ?) LIMIT 1`)
  .get(req.idempotencyKey, since, req.targetId, req.op);

/**
 * 同一个目标之前（换了别的 key）在发、点了发送没确认、或已发过的。返回 [status, reason, detail, previousActionId] 或 null。
 * - pending：任何时候都拦（in-progress），不看会话时间。
 * - needs_readback：任何时候都拦，私信也一样，对方之后又说了新的也不放行，要人工处理（见 S7 文档）。
 * - sent：评论回过就不再回；私信只拦「对方最后一句之前」发的，只用发信时记下的平台时间 targetLastAt 判（等于现在的 lastAt 就是对方没新话），
 *   绝不拿本机时间和平台时间比。发信时会话还没有 lastAt 的记成 ''（对方之后一说话就放行）；targetLastAt 为 NULL 的是旧库升级来的、判断不了，保守拦。
 */
function targetPrior(db, req, row) {
  const p = db.prepare(`SELECT id, status, createdAt FROM actions WHERE op = ? AND targetId = ? AND (status = 'pending' OR ${REAL_NEEDS_READBACK})
    ORDER BY status = 'pending' DESC, createdAt DESC, rowid DESC LIMIT 1`).get(req.op, req.targetId);
  if (p?.status === 'pending') return ['rejected', 'in-progress', '这个目标正在发', p.id];
  if (p) return ['needs_readback', 'target-needs-readback', `这个目标 ${p.createdAt} 点了发送没回读到，不再发，请人工去平台上看`, p.id];
  // 删会话：会话之后又有新消息（lastAt 变了）就是回来了，可以再删
  const peerAfter = req.op === 'sendDM' ? (row.lastBy === 'peer' && row.lastAt ? row.lastAt : null) : req.spec.sinceLastAt ? row.lastAt ?? null : null;
  const s = peerAfter
    ? db.prepare(`SELECT id, createdAt FROM actions WHERE op = ? AND targetId = ? AND status = 'sent' AND (targetLastAt IS NULL OR targetLastAt = ?)
        ORDER BY createdAt DESC, rowid DESC LIMIT 1`).get(req.op, req.targetId, peerAfter)
    : db.prepare(`SELECT id, createdAt FROM actions WHERE op = ? AND targetId = ? AND status = 'sent' ORDER BY createdAt DESC, rowid DESC LIMIT 1`).get(req.op, req.targetId);
  if (!s) return null;
  const reason = req.spec.sentReason ?? (req.op === 'reply' ? 'already-replied' : 'last-is-me');
  return ['failed', reason, `这个目标 ${s.createdAt} 已经${req.spec.family === 'moderate' ? '处置' : '发'}过（${s.id}）`, s.id];
}

/** 进程崩溃、被杀留下的 pending：超过 PENDING_STALE_MS 的一律记 needs_readback（不知道点没点发送），并按连续失败判断要不要关写能力位。 */
function reclaimStale(db, now) {
  const rows = db.prepare(`SELECT id, op, platformCode FROM actions WHERE status = 'pending' AND createdAt < ?`).all(iso(now() - PENDING_STALE_MS));
  for (const r of rows) finishAction(db, r.id, { status: 'needs_readback', reason: 'interrupted', detail: '上一个进程发到一半没落结果', sendAttempted: true }, now);
  const tripped = new Set();
  for (const key of new Set(rows.map((r) => `${r.platformCode}\t${OPS[r.op]?.family ?? 'write'}`))) {
    const [code, family] = key.split('\t');
    if (maybeTrip(db, code, now, family)) tripped.add(`${code}\t${family}`);
  }
  return tripped;
}

// ---------- 租约 ----------

function takeLease(db, platformCode, holder, now) {
  const at = now();
  const cur = db.prepare(`SELECT * FROM ${LEASE_TABLE} WHERE platformCode = ?`).get(platformCode);
  if (cur && Date.parse(cur.expiresAt) > at) return cur;
  db.prepare(`INSERT INTO ${LEASE_TABLE} (platformCode, holder, acquiredAt, expiresAt) VALUES (?, ?, ?, ?)
    ON CONFLICT(platformCode) DO UPDATE SET holder = excluded.holder, acquiredAt = excluded.acquiredAt, expiresAt = excluded.expiresAt`)
    .run(platformCode, holder, iso(at), iso(at + WRITE_TIMEOUT_MS[platformCode] + LEASE_GRACE_MS));
  return null;
}
const dropLease = (db, platformCode, holder) => db.prepare(`DELETE FROM ${LEASE_TABLE} WHERE platformCode = ? AND holder = ?`).run(platformCode, holder);

// ---------- 结果 ----------

function classify(r, account) {
  if (!r?.ok) {
    const pre = BEFORE_SCRIPT[r?.reason];
    if (pre) return { status: 'failed', reason: pre, detail: redact(r?.error), sendAttempted: false };
    // 脚本可能已经点了发送（超时、异常退出、没有结果）：不知道发没发，按 needs_readback，绝不重试
    return { status: 'needs_readback', reason: `runner-${r?.reason ?? 'failed'}`, detail: redact(r?.error), sendAttempted: true };
  }
  const x = r.result ?? {};
  if (x.loginLost) return { status: 'failed', reason: 'login-lost', detail: redact(x.evidence), sendAttempted: false };
  if (!x.sendAttempted) {
    if (x.blocked) return { status: 'failed', reason: String(x.blocked), detail: redact(x.detail), sendAttempted: false };
    if (x.uidSeen != null && String(x.uidSeen) !== String(account.uid)) return { status: 'failed', reason: 'uid-mismatch', detail: `页面上登录的是 ${x.uidSeen}`, sendAttempted: false };
    return { status: 'failed', reason: 'not-sent', detail: '写入脚本没点发送，也没说原因', sendAttempted: false };
  }
  const rb = x.readBack ?? null;
  const count = Number.isInteger(rb?.count) ? rb.count : 0;
  const readBack = rb ? { found: rb.found === true && count === 1, count, ...(rb.nativeId != null ? { nativeId: String(rb.nativeId) } : {}), ...(rb.detail ? { detail: redact(rb.detail) } : {}) } : null;
  if (x.sendError && !(rb?.found === true && count >= 1)) return { status: 'failed', reason: 'send-error', detail: redact(x.sendError), sendAttempted: true, readBack };
  if (readBack?.found) return { status: 'sent', reason: null, detail: null, sendAttempted: true, readBack };
  const [reason, detail] = count > 1 ? ['readback-count', `回读到 ${count} 条一样的回复，不能确认是这一次发的`]
    : count === 1 ? ['readback-mismatch', '回读到一条一样的回复，但和发送接口返回的 id 对不上，不能确认是这一次发的']
      : ['readback-missing', '发送后没回读到这条回复，不重试，请人工去平台上看'];
  return { status: 'needs_readback', reason, detail, sendAttempted: true, readBack };
}

function ackFor(db, req, actionId, now) {
  const mod = req.spec.family === 'moderate';
  const { type, subjectId } = mod ? modAckSubject(req) : { type: req.spec.eventType, subjectId: req.targetId };
  const outcome = req.spec.ackOutcome;
  const ids = new Set(req.eventId ? [req.eventId] : []);
  if (type && subjectId) for (const { id } of db.prepare('SELECT id FROM events WHERE subjectId = ? AND type = ? AND handledAt IS NULL ORDER BY createdAt').all(subjectId, type)) ids.add(id);
  const acked = [];
  for (const id of ids) {
    const e = db.prepare('SELECT handledOutcome, type, subjectId FROM events WHERE id = ?').get(id);
    if (!e || e.handledOutcome === 'replied' || e.handledOutcome === outcome) continue;
    // 只回执这个目标的同类事件（处置组的 eventId 已在入口按 modEventMatches 核对过）
    if (id !== req.eventId || !mod) { if (e.type !== type || e.subjectId !== subjectId) continue; }
    ackEvent(db, id, outcome, `${req.op} ${actionId}`, { now, actionId });
    acked.push(id);
  }
  return acked;
}

// ---------- 连续失败自动关写能力位 ----------

/** 这个平台最近两个有写入的轮次都没有一条发出、且有点过发送却失败的，就关掉写能力位。只看上一次自动关之后的轮次。 */
// family：write（回复、私信）或 moderate（删评论、拉黑、删会话），两组的轮次、自动关各算各的
function maybeTrip(db, platformCode, now, family = 'write') {
  const f = FAMILIES[family];
  const ops = inList(f.ops);
  const last = db.prepare(`SELECT max(trippedAt) at FROM engage_write_trips WHERE platformCode = ? AND coalesce(family, 'write') = ?`).get(platformCode, family).at;
  const after = last ? roundKeyOf(Date.parse(last)) : '';
  const rounds = db.prepare(`SELECT roundKey, max(status = 'sent') anySent, sum(status IN ('failed', 'needs_readback')) fails
    FROM actions WHERE platformCode = ? AND op IN (${ops}) AND sendAttempted = 1 AND status <> 'pending' AND roundKey > ? GROUP BY roundKey ORDER BY roundKey DESC LIMIT 2`).all(platformCode, after);
  if (rounds.length < 2 || rounds.some((r) => r.anySent || !r.fails)) return null;
  const lastFail = db.prepare(`SELECT reason, detail FROM actions WHERE platformCode = ? AND op IN (${ops}) AND sendAttempted = 1 AND status IN ('failed', 'needs_readback') ORDER BY createdAt DESC, rowid DESC LIMIT 1`).get(platformCode);
  const accounts = listAccounts(db, { platform: platformCode });
  for (const a of accounts) for (const cap of f.caps) if (a.capabilities[cap]) setCapability(db, a.id, cap, false);
  const id = `trip_${randomUUID()}`;
  db.prepare('INSERT INTO engage_write_trips (id, platformCode, trippedAt, rounds, detail, family) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, platformCode, iso(now()), JSON.stringify(rounds.map((r) => r.roundKey).reverse()), redact(`${lastFail?.reason ?? ''} ${lastFail?.detail ?? ''}`.trim()), family);
  return id;
}

function tripText(t, db) {
  const name = PLATFORM_NAMES[t.platformCode] ?? t.platformCode;
  const f = FAMILIES[t.family ?? 'write'] ?? FAMILIES.write;
  const ids = listAccounts(db, { platform: t.platformCode }).map((a) => a.id);
  const rounds = JSON.parse(t.rounds).map((r) => `${r}:00Z`).join('、');
  return `⛔ ${name}${f.label}连续 2 轮失败，已自动关掉能力位（${f.caps.join('、')}） | ${ids.join('、')}\n`
    + `失败的轮次（整点小时）：${rounds}\n最后的错误：${t.detail || '（无）'}\n`
    + `查明原因后重新打开：hub ops accounts set-cap ${ids[0] ?? `${t.platformCode}:<uid>`} ${f.caps[0]} true（${f.caps.slice(1).join('、')} 同理）`;
}

/** 关能力位的提醒没真发出的，补发；发出才记 alertedAt。 */
async function sendTripAlerts(db, { notify, now, log }) {
  for (const t of db.prepare('SELECT * FROM engage_write_trips WHERE alertedAt IS NULL ORDER BY trippedAt').all()) {
    let ok = false;
    try { ok = (await notify(tripText(t, db))) === true; } catch (e) { log(`[maitian-engage] 飞书提醒出错：${redact(e.message)}`); }
    if (ok) db.prepare('UPDATE engage_write_trips SET alertedAt = ? WHERE id = ?').run(iso(now()), t.id);
  }
}

// ---------- 入口 ----------

/**
 * @param {object} input { op: 'reply'|'sendDM', targetId, text, idempotencyKey, eventId?, caller? }
 * @param {object} deps  { now, runWriter({ account, params }), notify(text) => true 才算发出, log }
 * @returns {Promise<object>} { status, reason, detail, retryable, op, targetId, accountId, idempotencyKey, eventId, actionId,
 *   sendAttempted, readBack, previousActionId?, ackedEvents, writeDisabled }
 */
export async function engageWrite(db, input, deps = {}) {
  const { now = Date.now, runWriter = runWriterInSpace, notify = defaultNotifyLazy, log = (s) => console.error(s) } = deps;
  const req = checkInput(input);
  // 这次调用回收时触发了本平台的自动关：返回里 writeDisabled 要是 true
  const trippedNow = tx(db, () => reclaimStale(db, now)).has(`${req.platformCode}\t${req.spec.family}`);
  await sendTripAlerts(db, { notify, now, log });
  const out = (o) => ({ status: o.status, reason: o.reason ?? null, detail: o.detail ?? null, retryable: RETRYABLE.has(o.reason),
    op: req.op, targetId: req.targetId, ...(req.targetId !== req.inputId ? { inputTarget: req.inputId } : {}), accountId: o.accountId ?? null, idempotencyKey: req.idempotencyKey, eventId: req.eventId,
    actionId: o.actionId ?? null, sendAttempted: !!o.sendAttempted, readBack: o.readBack ?? null,
    ...(o.previousActionId ? { previousActionId: o.previousActionId } : {}), ackedEvents: o.ackedEvents ?? [], writeDisabled: !!o.writeDisabled || trippedNow });
  const done = (fields) => out({ ...fields, actionId: insertAction(db, req, fields, now) });

  if (!ENGAGE_PLATFORMS.includes(req.platformCode)) {
    return tx(db, () => done({ status: 'rejected', reason: 'unsupported-platform', detail: `${req.platformCode} 不在评论私信范围（${ENGAGE_PLATFORMS.join('、')}）` }));
  }
  const family = FAMILIES[req.spec.family];
  if (req.spec.family === 'moderate' && !MOD_PLATFORMS.includes(req.platformCode)) {
    return tx(db, () => done({ status: 'rejected', reason: 'unsupported-platform', detail: `${req.op} 只做 ${MOD_PLATFORMS.join('、')}` }));
  }

  const start = tx(db, () => {
    const since = iso(now() - IDEMPOTENCY_WINDOW_MS);
    // 拉黑：先把评论 id、会话 id 换成对方的 mid，actions 按 mid 记，同一个人换个入口也认得出
    if (req.op === 'block') {
      const b = resolveBlockTarget(db, req);
      if (b.reject) return done({ status: 'rejected', reason: b.reject[0], detail: b.reject[1] });
      req.block = b;
      req.targetId = b.targetId;
    }
    // eventId 最先核对（早于所有幂等检查）：duplicate 也会回执事件，不能回执到别的目标上
    if (!eventMatches(db, req)) return done({ status: 'rejected', reason: 'event-mismatch', detail: `eventId 不存在，或不是 ${req.inputId} 的${req.spec.eventType ? ` ${req.spec.eventType}` : '评论或私信'}事件` });
    if (otherTarget(db, req, since)) return done({ status: 'rejected', reason: 'idempotency-key-reused', detail: '这个 idempotencyKey 已经用在了别的目标或操作上' });
    const prior = blockingPrior(db, req.idempotencyKey, since);
    if (prior?.status === 'pending' && now() - Date.parse(prior.createdAt) > PENDING_STALE_MS) {
      finishAction(db, prior.id, { status: 'needs_readback', reason: 'interrupted', detail: '上一个进程发到一半没落结果', sendAttempted: true }, now);
      prior.status = 'needs_readback';
    }
    if (prior?.status === 'sent') {
      return done({ status: 'duplicate', reason: null, detail: `同一个 idempotencyKey 在 ${prior.finishedAt ?? prior.createdAt} 已发出`, accountId: prior.accountId,
        previousActionId: prior.id, readBack: prior.readBack ? JSON.parse(prior.readBack) : null, ackedEvents: ackFor(db, req, prior.id, now) });
    }
    if (prior?.status === 'needs_readback') {
      return done({ status: 'needs_readback', reason: 'previous-needs-readback', detail: '同一个 idempotencyKey 上次点了发送但没回读到，不重发，请人工去平台上看',
        accountId: prior.accountId, previousActionId: prior.id });
    }
    if (prior?.status === 'pending') return done({ status: 'rejected', reason: 'in-progress', detail: '同一个 idempotencyKey 正在发', accountId: prior.accountId, previousActionId: prior.id });

    const t = loadTarget(db, req);
    if (!t) return done({ status: 'rejected', reason: 'unknown-target', detail: `库里没有 ${req.targetId}，先 refresh_now 再读` });
    const account = getAccount(db, t.accountId);
    if (!account) return done({ status: 'rejected', reason: 'unknown-account', detail: `库里没有账号 ${t.accountId}` });
    const accountId = account.id;
    // 处置组：对象是我自己（登记过的本平台账号）一律拒绝，能力位开没开都一样
    const self = req.spec.family === 'moderate' ? selfTarget(db, req, t) : null;
    if (self) return done({ status: 'rejected', reason: 'self-target', detail: self, accountId });
    if (!account.capabilities[req.spec.cap]) {
      return done({ status: 'rejected', reason: 'capability-off', detail: `账号 ${accountId} 的能力位 ${req.spec.cap} 没开（hub ops accounts set-cap ${accountId} ${req.spec.cap} true）`, accountId });
    }
    // 先看本目标自己的发送记录（needs_readback / pending 不能被库同步后的「已回复」盖掉），再做普通库预检
    const tp = targetPrior(db, req, t.row);
    if (tp) return done({ status: tp[0], reason: tp[1], detail: tp[2], accountId, previousActionId: tp[3] });
    const blocked = dbPrecheck(db, req, t.row);
    if (blocked) return done({ status: 'failed', reason: blocked[0], detail: blocked[1], accountId });
    const counted = family.perOp ? [req.op] : family.ops;
    const used = db.prepare(`SELECT count(*) n FROM actions WHERE platformCode = ? AND roundKey = ? AND op IN (${inList(counted)}) AND (sendAttempted = 1 OR status = 'pending')`).get(req.platformCode, roundKeyOf(now())).n;
    if (used >= family.limit) return done({ status: 'rejected', reason: 'round-limit', detail: `${PLATFORM_NAMES[req.platformCode]}这一轮（整点小时）${family.perOp ? `${req.op} ` : ''}已 ${used} 条，上限 ${family.limit}`, accountId });
    const actionId = insertAction(db, req, { status: 'pending', accountId, targetLastAt: req.op === 'sendDM' || req.spec.sinceLastAt ? t.row.lastAt ?? '' : null }, now);
    const held = takeLease(db, req.platformCode, actionId, now);
    if (held) {
      finishAction(db, actionId, { status: 'rejected', reason: 'lease-busy', detail: `${PLATFORM_NAMES[req.platformCode]}正有别的写入方在写（到 ${held.expiresAt}）` }, now);
      return out({ status: 'rejected', reason: 'lease-busy', detail: `${PLATFORM_NAMES[req.platformCode]}正有别的写入方在写`, accountId, actionId });
    }
    return { go: true, account, actionId, target: t.target };
  });
  if (!start.go) return start;

  const { account, actionId } = start;
  let r;
  try {
    const params = { op: req.op, uid: String(account.uid), nickname: account.nickname ?? null, text: req.text, target: start.target };
    if (req.spec.family === 'moderate') { delete params.text; params.selfUids = selfUids(db, req.platformCode); }
    r = await runWriter({ account, params });
  } catch (e) { r = { ok: false, reason: 'threw', error: e?.message ?? String(e) }; }
  const res = classify(r, account);

  const fin = tx(db, () => {
    finishAction(db, actionId, res, now);
    dropLease(db, req.platformCode, actionId);
    const ackedEvents = res.status === 'sent' ? ackFor(db, req, actionId, now) : [];
    // 调用方没给 eventId 时，把这次回执的事件记进 actions（多个用逗号隔开）
    if (!req.eventId && ackedEvents.length) db.prepare('UPDATE actions SET eventId = ? WHERE id = ?').run(ackedEvents.join(','), actionId);
    const failedWrite = res.sendAttempted && (res.status === 'failed' || res.status === 'needs_readback');
    return { ackedEvents, tripped: failedWrite ? maybeTrip(db, req.platformCode, now, req.spec.family) : null };
  });
  if (fin.tripped) await sendTripAlerts(db, { notify, now, log });
  return out({ ...res, accountId: account.id, actionId, ackedEvents: fin.ackedEvents, writeDisabled: !!fin.tripped });
}

// login.mjs 在没有 config.json 时也能 import，但 feishu 要等真的发时才加载
const defaultNotifyLazy = async (text) => (await import('../login.mjs')).defaultNotify(text);
