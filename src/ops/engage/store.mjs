// 评论私信入库、出事件、抓取任务（sync_jobs）。守护进程（dev-3）和测试调这里；MCP 只经 query.mjs 读。
// 事件 id 是确定性的，INSERT OR IGNORE，所以重放同一轮、守护进程重启都不会重复出事件。
import { randomUUID } from 'node:crypto';
import { joinId, splitId } from './ids.mjs';
import { ENGAGE_PLATFORMS } from '../../daemon/schedule.mjs';

export const REFRESH_DEDUPE_MS = 5 * 60_000;
export const LOGIN_LOST_INTERVAL_MS = 6 * 3600_000;
export const SYNC_KINDS = ['comments', 'dms'];
// running 超过这么久还没收尾，就当是进程崩了留下的（runner 单次最长约 2 分钟，一轮几个账号串行）
export const STALE_RUNNING_MS = 30 * 60_000;
export const RECLAIMED_ERROR = '遗留的 running 任务已回收（上一个进程没收尾）';
const SNIPPET = 200;

const iso = (ms) => new Date(ms).toISOString();
const bool = (v) => (v == null ? null : v ? 1 : 0);
const snippet = (s) => (s == null ? null : String(s).slice(0, SNIPPET));

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/** 写一条事件；已存在（同 id）就什么都不做。返回是否新写了。 */
export function insertEvent(db, { id, type, platformCode, accountId, subjectId, createdAt, occurredAt = null, payload }) {
  const r = db.prepare('INSERT OR IGNORE INTO events (id, type, platformCode, accountId, subjectId, createdAt, occurredAt, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, type, platformCode, accountId ?? null, subjectId ?? null, createdAt, occurredAt ?? null, JSON.stringify(payload ?? {}));
  return r.changes > 0;
}

// 基线：这个账号这种 kind 成功入库过一次（哪怕是空的）。在 ingestSnapshot 的事务里写，和当前 job 有没有 finishJob 无关
const getBaselineAt = (db, accountId, kind) => db.prepare('SELECT establishedAt FROM engage_baselines WHERE accountId = ? AND kind = ?').get(accountId, kind)?.establishedAt ?? null;
const setBaseline = (db, accountId, kind, at) => db.prepare('INSERT OR IGNORE INTO engage_baselines (accountId, kind, establishedAt) VALUES (?, ?, ?)').run(accountId, kind, at);

function upsertWorks(db, ctx, works) {
  const exists = db.prepare('SELECT 1 FROM engage_works WHERE id = ?');
  const ins = db.prepare('INSERT INTO engage_works (id, accountId, platformCode, nativeId, title, url, postTime, firstSeenAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const upd = db.prepare('UPDATE engage_works SET title = coalesce(?, title), url = coalesce(?, url), postTime = coalesce(?, postTime), updatedAt = ? WHERE id = ?');
  for (const w of works) {
    const id = joinId(ctx.code, w.nativeId);
    if (exists.get(id)) { upd.run(w.title ?? null, w.url ?? null, w.postTime ?? null, ctx.at, id); ctx.stats.updated++; }
    else { ins.run(id, ctx.accountId, ctx.code, String(w.nativeId), w.title ?? null, w.url ?? null, w.postTime ?? null, ctx.at, ctx.at); ctx.stats.inserted++; }
  }
}

/**
 * 每条评论的 parentId / rootId / depth：沿 parent 链算（先找本轮，再找库里）。
 * parent 本轮和库里都没有：按适配器给的 rootNativeId 挂，depth 记 1，并把作品记进 unresolved（楼中楼不全）。
 */
function placeComments(db, code, comments, unresolved) {
  const round = new Map(comments.map((c) => [String(c.nativeId), c]));
  const inDb = db.prepare('SELECT rootId, depth FROM comments WHERE id = ?');
  const placed = new Map();
  const place = (nativeId, seen = new Set()) => {
    if (placed.has(nativeId)) return placed.get(nativeId);
    const c = round.get(nativeId);
    const id = joinId(code, nativeId);
    const parentNative = c.parentNativeId == null ? null : String(c.parentNativeId);
    let p;
    if (parentNative == null || parentNative === nativeId) p = { parentId: null, rootId: id, depth: 0 };
    else {
      const parentId = joinId(code, parentNative);
      seen.add(nativeId);
      const up = round.has(parentNative) && !seen.has(parentNative) ? place(parentNative, seen) : inDb.get(parentId);
      const fallbackRoot = c.rootNativeId != null && String(c.rootNativeId) !== nativeId ? joinId(code, c.rootNativeId) : parentId;
      p = up ? { parentId, rootId: up.rootId, depth: up.depth + 1 } : { parentId, rootId: fallbackRoot, depth: 1 };
      if (!up) unresolved.add(joinId(code, c.workNativeId));
    }
    placed.set(nativeId, p);
    return p;
  };
  for (const k of round.keys()) place(k);
  return placed;
}

function upsertComments(db, ctx, snap) {
  const { code } = ctx;
  const unresolved = new Set();
  const placed = placeComments(db, code, snap.comments, unresolved);
  const workOf = db.prepare('SELECT title, url FROM engage_works WHERE id = ?');
  const exists = db.prepare('SELECT 1 FROM comments WHERE id = ?');
  const cols = 'parentId = ?, rootId = ?, depth = ?, authorUid = ?, authorNickname = ?, authorIsMe = ?, replyToUid = ?, replyToNickname = ?, text = ?, createdAt = ?, likeCount = ?, likedByMe = ?, pinned = ?, replyCount = ?, ipLabel = ?';
  const ins = db.prepare(`INSERT INTO comments (workId, accountId, platformCode, parentId, rootId, depth, authorUid, authorNickname, authorIsMe, replyToUid, replyToNickname, text, createdAt, likeCount, likedByMe, pinned, replyCount, ipLabel, id, firstSeenAt, lastSeenAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const upd = db.prepare(`UPDATE comments SET ${cols}, lastSeenAt = ?, goneAt = NULL WHERE id = ?`);
  const seen = new Set();
  for (const c of snap.comments) {
    const id = joinId(code, c.nativeId);
    const workId = joinId(code, c.workNativeId);
    const p = placed.get(String(c.nativeId));
    const vals = [p.parentId, p.rootId, p.depth, c.author?.uid ?? null, c.author?.nickname ?? null, c.author?.isMe ? 1 : 0,
      c.replyTo?.uid ?? null, c.replyTo?.nickname ?? null, c.text ?? null, c.createdAt ?? null,
      c.likeCount ?? null, bool(c.likedByMe), bool(c.pinned), c.replyCount ?? null, c.ipLabel ?? null];
    seen.add(id);
    if (exists.get(id)) { upd.run(...vals, ctx.at, id); ctx.stats.updated++; continue; }
    ins.run(workId, ctx.accountId, code, ...vals, id, ctx.at, ctx.at);
    ctx.stats.inserted++;
    if (ctx.firstSync || c.author?.isMe) continue;
    const w = workOf.get(workId) ?? {};   // upsertWorks 已先跑：库里是合并后的值（快照里 title 为 null 不会盖掉旧的）
    emit(db, ctx, { id: `comment.created:${id}`, type: 'comment.created', subjectId: id, occurredAt: c.createdAt ?? null,
      payload: { workId, workTitle: w.title ?? null, workUrl: w.url ?? null, commentId: id, rootId: p.rootId, parentId: p.parentId, nickname: c.author?.nickname ?? null, text: snippet(c.text) } });
  }
  markGone(db, ctx, snap.scannedWorks, seen, unresolved);
}

// complete 的作品：这一轮没出现、还没 gone 的评论标 goneAt（不删行）。顺手记楼中楼拿不全的作品。
function markGone(db, ctx, scannedWorks, seen, unresolved) {
  const ofWork = db.prepare('SELECT id FROM comments WHERE workId = ? AND goneAt IS NULL');
  const gone = db.prepare('UPDATE comments SET goneAt = ? WHERE id = ?');
  const partial = db.prepare('INSERT INTO thread_partial (workId, partial, updatedAt) VALUES (?, ?, ?) ON CONFLICT(workId) DO UPDATE SET partial = excluded.partial, updatedAt = excluded.updatedAt');
  for (const s of scannedWorks) {
    const workId = joinId(ctx.code, s.workNativeId);
    partial.run(workId, s.threadsPartial || unresolved.has(workId) ? 1 : 0, ctx.at);
    unresolved.delete(workId);
    if (s.complete !== true) continue;
    for (const { id } of ofWork.all(workId)) if (!seen.has(id)) { gone.run(ctx.at, id); ctx.stats.gone++; }
  }
  for (const workId of unresolved) partial.run(workId, 1, ctx.at);   // 没在 scannedWorks 里的作品
}

const isPlaceholderNick = (v) => typeof v === 'string' && v.trim() === '陌生人消息';

function upsertConversations(db, ctx, snap) {
  const { code } = ctx;
  const prev = db.prepare('SELECT peerUid, peerNickname, peerKind, unread, lastBy, lastAt, lastText, lastType, canSend FROM conversations WHERE id = ?');
  const ins = db.prepare(`INSERT INTO conversations (accountId, platformCode, peerUid, peerNickname, peerKind, unread, lastBy, lastAt, lastText, lastType, canSend, id, firstSeenAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const upd = db.prepare('UPDATE conversations SET accountId = ?, platformCode = ?, peerUid = ?, peerNickname = ?, peerKind = ?, unread = ?, lastBy = ?, lastAt = ?, lastText = ?, lastType = ?, canSend = ?, updatedAt = ? WHERE id = ?');
  const storedMessage = db.prepare('SELECT at FROM messages WHERE id = ? AND accountId = ? AND conversationId = ? AND by = ?');
  const dmMessages = code === 'Douyin' ? new Map(snap.messages.map((m) => [m.conversationNativeId, m])) : null;
  for (const k of snap.conversations) {
    const id = joinId(code, k.nativeId);
    const observed = dmMessages?.get(k.nativeId);
    const message = observed && observed.at === k.last?.at && observed.by === k.last?.by ? observed : null;
    const stored = message
      ? storedMessage.get(joinId(code, message.nativeId), ctx.accountId, id, message.by) : null;
    // 同一个服务端 ID 沿用首次入库时间，使两条读取路径共用 main 的时间型事件 ID。
    const last = stored?.at && k.lastServerId === message.nativeId
      ? { ...k.last, at: stored.at } : k.last;
    const before = prev.get(id);
    // last 为 null 是「这一轮没读到」（例如小红书没打开的会话），不是「没有最后一句」：库里已有的不动
    // peerUid / peerNickname 读不到（例如首屏外 Context 会话没有 DOM 昵称）时保留库里已有值
    const nextUid = k.peer?.uid ?? before?.peerUid ?? null;
    const incomingNick = k.peer?.nickname != null && !isPlaceholderNick(k.peer.nickname) ? k.peer.nickname : null;
    const prevNick = before?.peerNickname != null && !isPlaceholderNick(before.peerNickname) ? before.peerNickname : null;
    const nextNick = incomingNick ?? prevNick;
    const nextKind = k.peer?.kind ?? before?.peerKind ?? null;
    const nextUnread = k.unread ?? 0;
    const nextCanSend = bool(k.canSend);
    const keepLast = !last;
    const nextLastBy = keepLast ? (before?.lastBy ?? null) : (last.by ?? null);
    const nextLastAt = keepLast ? (before?.lastAt ?? null) : (last.at ?? null);
    const nextLastText = keepLast ? (before?.lastText ?? null) : (last.text ?? null);
    const nextLastType = keepLast ? (before?.lastType ?? null) : (last.type ?? null);
    const vals = [ctx.accountId, code, nextUid, nextNick, nextKind, nextUnread,
      nextLastBy, nextLastAt, nextLastText, nextLastType, nextCanSend];
    const changed = !before
      || nextUid !== before.peerUid
      || nextNick !== before.peerNickname
      || nextKind !== before.peerKind
      || nextUnread !== before.unread
      || nextCanSend !== before.canSend
      || nextLastBy !== before.lastBy
      || nextLastAt !== before.lastAt
      || nextLastText !== before.lastText
      || nextLastType !== before.lastType;
    if (changed) ctx.stats.changedConversations++;
    if (before) { upd.run(...vals, ctx.at, id); ctx.stats.updated++; }
    else { ins.run(...vals, id, ctx.at, ctx.at); ctx.stats.inserted++; }
    const isNewer = before ? before.lastAt == null || Date.parse(last?.at) > Date.parse(before.lastAt) : !ctx.firstSync;
    if (last?.by !== 'peer' || !last.at || !isNewer) continue;
    const domPeer = snap.via === 'dom-fallback' || k.domPeerAt === k.last.at;
    const cutoff = domPeer ? ctx.domCutoff ?? ctx.contextCutoff : ctx.contextCutoff;
    if (cutoff && Date.parse(last.at) < Date.parse(cutoff)) {
      // 首次加载或重读历史行只建基线。已知会话已观察到的末条之后，新出现的消息按 main 派发。
      const unseen = message && stored?.at !== last.at;
      if (!before?.lastAt || !unseen) continue;
    }
    emit(db, ctx, { id: `dm.received:${id}:${last.at}`, type: 'dm.received', subjectId: id, occurredAt: last.at,
      payload: { conversationId: id, nickname: nextNick, text: snippet(last.text), at: last.at } });
  }
  const insMsg = db.prepare('INSERT OR IGNORE INTO messages (id, conversationId, accountId, by, at, type, text, firstSeenAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (const m of snap.messages) {
    const r = insMsg.run(joinId(code, m.nativeId), joinId(code, m.conversationNativeId), ctx.accountId, m.by, m.at ?? null, m.type ?? null, m.text ?? null, ctx.at);
    if (r.changes) ctx.stats.inserted++;
  }
}

function emit(db, ctx, e) {
  if (insertEvent(db, { ...e, platformCode: ctx.code, accountId: ctx.accountId, createdAt: ctx.at })) ctx.events.push(e.id);
}

/**
 * 吃适配器输出（见 kin323-contract.md），一个事务里入库并出事件。
 * 账号第一次同步（这个账号这种 kind 还没有成功入库过，见 engage_baselines；空的成功快照也算一次）只入库、不出事件，
 * 免得上线第一轮把历史全推一遍。
 * 返回 { inserted, updated, gone, events: [eventId...] }（events 只含本次新写的）。
 */
export function ingestSnapshot(db, account, snapshot, { now = Date.now } = {}) {
  if (!snapshot || snapshot.ok !== true) throw new Error(`快照不是 ok: true，不入库（${snapshot?.reason ?? snapshot?.skipped ?? '没有结果'}）`);
  const kind = snapshot.kind;
  if (!SYNC_KINDS.includes(kind)) throw new Error(`快照 kind 要是 comments 或 dms：${kind}`);
  const snap = { works: [], comments: [], scannedWorks: [], conversations: [], messages: [], ...snapshot };
  const stats = kind === 'dms'
    ? {
        inserted: 0, updated: 0, gone: 0,
        changedConversations: 0,
        strangerCount: typeof snap.strangerCount === 'number' ? snap.strangerCount : snap.conversations.filter((k) => k.isStranger === true).length,
        ...(snap.via ? { via: snap.via } : {}),
      }
    : { inserted: 0, updated: 0, gone: 0 };
  const ctx = { code: account.platformCode, accountId: account.id, at: iso(now()), events: [], stats };
  return tx(db, () => {
    const accountBaselineAt = getBaselineAt(db, ctx.accountId, kind);
    ctx.firstSync = accountBaselineAt == null;
    const douyinDms = kind === 'dms' && ctx.code === 'Douyin';
    const context = douyinDms && snap.via === 'context';
    const captureAt = snap.collectionStartedAt ?? snap.fetchedAt ?? ctx.at;
    if (context || (douyinDms && snap.via === 'dom-fallback')) {
      ctx.contextCutoff = getBaselineAt(db, ctx.accountId, 'dms:context');
      ctx.domCutoff = getBaselineAt(db, ctx.accountId, 'dms:legacy-dom');
      if (ctx.contextCutoff == null) {
        const job = db.prepare(`SELECT startedAt FROM sync_jobs
          WHERE platformCode = ? AND accountId = ? AND kind = 'dms' AND status = 'ok'
          ORDER BY finishedAt DESC, rowid DESC LIMIT 1`).get(ctx.code, ctx.accountId);
        const previousCapture = job?.startedAt ?? getBaselineAt(db, ctx.accountId, 'dms:capture');
        ctx.contextCutoff = previousCapture ?? accountBaselineAt ?? captureAt;
        if (accountBaselineAt && !previousCapture && !ctx.domCutoff) {
          // main 旧库只记入库时间。上次已读到的最新消息是采集时刻的下界；
          // 可见首屏沿用 main 处理两者之间的消息，Context 扩展出的历史列表仍用入库水位。
          const { latest } = db.prepare(`SELECT max(at) AS latest FROM messages
            WHERE accountId = ? AND firstSeenAt <= ? AND at <= ?`).get(ctx.accountId, accountBaselineAt, accountBaselineAt);
          ctx.domCutoff = latest ?? accountBaselineAt;
          setBaseline(db, ctx.accountId, 'dms:legacy-dom', ctx.domCutoff);
        }
      }
    }
    upsertWorks(db, ctx, snap.works);
    if (kind === 'comments') upsertComments(db, ctx, snap);
    else upsertConversations(db, ctx, snap);
    setBaseline(db, ctx.accountId, kind, ctx.at);
    if (douyinDms && ctx.firstSync) setBaseline(db, ctx.accountId, 'dms:capture', captureAt);
    if (context) setBaseline(db, ctx.accountId, 'dms:context', ctx.contextCutoff);
    return { ...ctx.stats, events: ctx.events };
  });
}

// ---------- 抓取任务 sync_jobs ----------

function checkKind(kind) {
  if (!SYNC_KINDS.includes(kind)) throw new Error(`kind 只能是 ${SYNC_KINDS.join(' 或 ')}：${kind}`);
}

const accountOfPlatform = (db, platformCode) => db.prepare('SELECT platformCode, uid FROM accounts WHERE platformCode = ? ORDER BY rowid LIMIT 1').get(platformCode);

export const getJob = (db, id) => db.prepare('SELECT * FROM sync_jobs WHERE id = ?').get(id) ?? null;

/** 新建一个任务（status requested）。返回 job id。 */
export function createJob(db, { platformCode, accountId = null, kind, trigger = 'schedule', now = Date.now }) {
  checkKind(kind);
  if (!['schedule', 'refresh_now'].includes(trigger)) throw new Error(`trigger 只能是 schedule 或 refresh_now：${trigger}`);
  const id = `job_${randomUUID()}`;
  db.prepare("INSERT INTO sync_jobs (id, platformCode, accountId, kind, trigger, status, requestedAt) VALUES (?, ?, ?, ?, ?, 'requested', ?)")
    .run(id, platformCode, accountId, kind, trigger, iso(now()));
  return id;
}

export function startJob(db, id, { now = Date.now, accountId } = {}) {
  const r = db.prepare("UPDATE sync_jobs SET status = 'running', startedAt = ?, accountId = coalesce(?, accountId) WHERE id = ? AND status = 'requested'").run(iso(now()), accountId ?? null, id);
  if (!r.changes) throw new Error(`任务不存在或不是 requested：${id}`);
}

/** 收尾：status 是 ok / skipped / failed；stats 存 JSON（例如 ingestSnapshot 的返回）。 */
export function finishJob(db, id, { status, error = null, stats = null, now = Date.now }) {
  if (!['ok', 'skipped', 'failed'].includes(status)) throw new Error(`status 只能是 ok、skipped、failed：${status}`);
  const r = db.prepare('UPDATE sync_jobs SET status = ?, finishedAt = ?, error = ?, stats = ? WHERE id = ?')
    .run(status, iso(now()), error == null ? null : String(error).slice(0, 500), stats == null ? null : JSON.stringify(stats), id);
  if (!r.changes) throw new Error(`任务不存在：${id}`);
}

/**
 * 回收进程崩了留下的 running 任务：startedAt 超过 STALE_RUNNING_MS 还是 running 的记成 failed。
 * 守护进程每轮开头（拿到轮锁之后、pendingRefreshes 之前）调。返回回收了的 job id。
 */
export function reclaimStaleJobs(db, { now = Date.now, maxRunningMs = STALE_RUNNING_MS } = {}) {
  const cutoff = iso(now() - maxRunningMs);
  const ids = db.prepare("SELECT id FROM sync_jobs WHERE status = 'running' AND startedAt < ? ORDER BY startedAt, id").all(cutoff).map((r) => r.id);
  const upd = db.prepare("UPDATE sync_jobs SET status = 'failed', finishedAt = ?, error = ? WHERE id = ? AND status = 'running'");
  for (const id of ids) upd.run(iso(now()), RECLAIMED_ERROR, id);
  return ids;
}

/** 等着跑的 refresh_now（旧的在前）。调度每轮先拿这些，startJob 后跑。 */
// 只认评论私信抓取的平台：库里遗留的其他平台任务永远不会被消费，不能让守护进程为它每分钟起一轮
export const pendingRefreshes = (db) =>
  db.prepare(`SELECT * FROM sync_jobs WHERE trigger = 'refresh_now' AND status = 'requested'
    AND platformCode IN (SELECT value FROM json_each(?)) ORDER BY requestedAt, id`).all(JSON.stringify(ENGAGE_PLATFORMS));

/**
 * refresh_now：同一平台同一 kind 已有排着的、还活着的 running（开始不到 STALE_RUNNING_MS），或 5 分钟内刚结束的 refresh
 * （ok、skipped、failed 都算，含 X-B9 回收的），就返回那条（deduped: true），不新建。平台只认 ENGAGE_PLATFORMS。
 * 返回 { jobId, deduped, status }。
 */
export function requestRefresh(db, { kind, platform, now = Date.now }) {
  checkKind(kind);
  if (!ENGAGE_PLATFORMS.includes(platform)) throw new Error(`${platform} 不在评论私信抓取范围内（只认 ${ENGAGE_PLATFORMS.join('、')}）`);
  const acc = accountOfPlatform(db, platform);
  if (!acc) throw new Error(`没有 ${platform} 的账号`);
  const since = iso(now() - REFRESH_DEDUPE_MS), alive = iso(now() - STALE_RUNNING_MS);
  const hit = db.prepare(`SELECT id, status FROM sync_jobs WHERE trigger = 'refresh_now' AND platformCode = ? AND kind = ?
    AND (status = 'requested' OR (status = 'running' AND startedAt >= ?) OR (status IN ('ok', 'skipped', 'failed') AND finishedAt >= ?)) ORDER BY requestedAt DESC LIMIT 1`).get(platform, kind, alive, since);
  if (hit) return { jobId: hit.id, deduped: true, status: hit.status };
  const jobId = createJob(db, { platformCode: platform, accountId: joinId(acc.platformCode, acc.uid), kind, trigger: 'refresh_now', now });
  return { jobId, deduped: false, status: 'requested' };
}

// ---------- 守护进程出的事件 ----------

/**
 * 某个任务以 failed 收尾之后调。同一平台同一 kind 的任务（跳过的不算）连着第 2 次失败时出 sync.failed，
 * 第 3、4 次不再出；中间成功过一次就重新数。返回事件 id 或 null。
 */
export function recordSyncFailure(db, jobId, { now = Date.now } = {}) {
  const job = getJob(db, jobId);
  if (!job) throw new Error(`任务不存在：${jobId}`);
  if (job.status !== 'failed') throw new Error(`任务 ${jobId} 不是 failed（先 finishJob）`);
  const recent = db.prepare(`SELECT status FROM sync_jobs WHERE platformCode = ? AND kind = ? AND status IN ('ok', 'failed') AND finishedAt <= ?
    ORDER BY finishedAt DESC, rowid DESC LIMIT 3`).all(job.platformCode, job.kind, job.finishedAt).map((r) => r.status);
  const streak = recent.findIndex((s) => s !== 'failed');
  if ((streak === -1 ? recent.length : streak) !== 2) return null;
  const accountId = job.accountId ?? job.platformCode;
  const id = `sync.failed:${accountId}:${job.kind}:${jobId}`;
  return insertEvent(db, { id, type: 'sync.failed', platformCode: job.platformCode, accountId: job.accountId, subjectId: jobId, createdAt: iso(now()),
    payload: { kind: job.kind, jobId, consecutiveFailures: 2, error: job.error } }) ? id : null;
}

/** 守护进程发现掉线时调。同一账号 6 小时内只出一次。返回事件 id 或 null。 */
export function recordLoginLost(db, { accountId, jobId, evidence = null, now = Date.now }) {
  const { platformCode } = splitId(accountId, '账号 id');
  const since = iso(now() - LOGIN_LOST_INTERVAL_MS);
  if (db.prepare("SELECT 1 FROM events WHERE type = 'account.login_lost' AND accountId = ? AND createdAt > ?").get(accountId, since)) return null;
  const id = `account.login_lost:${accountId}:${jobId}`;
  return insertEvent(db, { id, type: 'account.login_lost', platformCode, accountId, subjectId: accountId, createdAt: iso(now()),
    payload: { accountId, jobId, evidence: snippet(evidence) } }) ? id : null;
}
