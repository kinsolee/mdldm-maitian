// 只查库的读接口：MCP read 组和以后的 CLI 共用。入参出参的 id 都是 <platformCode>:<原生 id>。
// 列表一律游标分页：{ items, nextCursor }，nextCursor 为 null 表示没有下一页。
import { listAccounts as listAccountRows, getAccount } from '../accounts.mjs';
import { splitId, checkPlatforms } from './ids.mjs';
import { requestRefresh } from './store.mjs';

export const OUTCOMES = ['replied', 'skipped', 'pending_human', 'ignored'];
const DEFAULT_LIMIT = 50, MAX_LIMIT = 200, TOP_COMMENTS = 20;

const iso = (ms) => new Date(ms).toISOString();
const bool = (v) => (v == null ? null : v === 1);
const json = (s) => (s == null ? null : JSON.parse(s));

// 有「我的、没 gone 的回复」在子树里的评论 id：从我的每条回复沿 parent 往上走（rootId 一定算，parent 链断了也不漏）
const REPLIED_CTE = `WITH RECURSIVE replied(id) AS (
  SELECT parentId FROM comments WHERE authorIsMe = 1 AND goneAt IS NULL AND parentId IS NOT NULL
  UNION SELECT rootId FROM comments WHERE authorIsMe = 1 AND goneAt IS NULL AND rootId <> id
  UNION SELECT c.parentId FROM comments c JOIN replied r ON c.id = r.id WHERE c.parentId IS NOT NULL)`;
const REPLIED = '(c.id IN (SELECT id FROM replied))';

function checkTime(v, name) {
  if (v == null) return null;
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw new Error(`${name} 要是 ISO 时间：${JSON.stringify(v)}`);
  return iso(Date.parse(v));
}

function checkLimit(limit, max = MAX_LIMIT, name = 'limit') {
  if (limit == null) return Math.min(DEFAULT_LIMIT, max);
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`${name} 要是正整数：${limit}`);
  return Math.min(limit, max);
}

const encodeCursor = (key, id) => Buffer.from(JSON.stringify([key, id])).toString('base64url');
function decodeCursor(cursor) {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string') return v;
  } catch { /* 落到下面报错 */ }
  throw new Error('cursor 不对：用上一页返回的 nextCursor 原样传回');
}

/** 按 (key, id) 稳定排序的游标分页。where 是对外层列的条件，key 是排序用的 SQL 表达式（不能为 null），prefix 放 WITH。 */
function page(db, { cols, from, where, params, key, desc, limit, cursor, prefix = '', map }) {
  const conds = [...where], args = [...params];
  if (cursor) {
    const [k, id] = decodeCursor(cursor);
    conds.push(`(_key, id) ${desc ? '<' : '>'} (?, ?)`);
    args.push(k, id);
  }
  const n = checkLimit(limit);
  const dir = desc ? 'DESC' : 'ASC';
  const sql = `${prefix} SELECT * FROM (SELECT ${cols}, ${key} AS _key FROM ${from}) WHERE ${conds.length ? conds.join(' AND ') : '1'} ORDER BY _key ${dir}, id ${dir} LIMIT ?`;
  const rows = db.prepare(sql).all(...args, n + 1);
  const more = rows.length > n;
  const items = rows.slice(0, n);
  return { items: items.map(map), nextCursor: more ? encodeCursor(items.at(-1)._key, items.at(-1).id) : null };
}

function inList(col, values, where, params) {
  if (!values) return;
  where.push(`${col} IN (${values.map(() => '?').join(', ')})`);
  params.push(...values);
}

// ---------- 形状 ----------

const toComment = (r) => ({
  id: r.id, workId: r.workId, accountId: r.accountId, platform: r.platformCode,
  parentId: r.parentId, rootId: r.rootId, depth: r.depth,
  author: { uid: r.authorUid, nickname: r.authorNickname, isMe: r.authorIsMe === 1 },
  replyTo: r.replyToUid == null && r.replyToNickname == null ? null : { uid: r.replyToUid, nickname: r.replyToNickname },
  text: r.text, createdAt: r.createdAt, likeCount: r.likeCount, likedByMe: bool(r.likedByMe), pinned: bool(r.pinned),
  replyCount: r.replyCount, ipLabel: r.ipLabel, replied: r.replied === 1, firstSeenAt: r.firstSeenAt, lastSeenAt: r.lastSeenAt, goneAt: r.goneAt,
});

const toConversation = (r) => ({
  id: r.id, accountId: r.accountId, platform: r.platformCode,
  peer: { uid: r.peerUid, nickname: r.peerNickname, kind: r.peerKind },
  unread: r.unread, last: r.lastBy == null ? null : { by: r.lastBy, at: r.lastAt, text: r.lastText, type: r.lastType },
  canSend: bool(r.canSend), firstSeenAt: r.firstSeenAt, updatedAt: r.updatedAt,
});

const toMessage = (r) => ({ id: r.id, conversationId: r.conversationId, by: r.by, at: r.at, type: r.type, text: r.text });

export const toEvent = (r, delivery = { attempts: r.attempts ?? 0, lastAttemptAt: r.lastAttemptAt ?? null, deliveredAt: r.deliveredAt ?? null }) => ({
  id: r.id, type: r.type, platform: r.platformCode, accountId: r.accountId, subjectId: r.subjectId, createdAt: r.createdAt,
  payload: json(r.payload),
  delivery,
  handled: r.handledAt == null ? null : { at: r.handledAt, outcome: r.handledOutcome, actionId: r.actionId, note: r.handledNote },
  ...(r.filteredReason ? { filteredReason: r.filteredReason } : {}),   // 推送前被过滤（见 filter.mjs）才有
});

const toWork = (r) => ({
  id: r.id, accountId: r.accountId, platform: r.platformCode, title: r.title, url: r.url, postTime: r.postTime,
  status: r.status, punishReason: null, visibility: r.visibility, metrics: json(r.metrics), metricsAt: r.metricsAt,
  commentCount: r.commentCount, unrepliedCount: r.unrepliedCount, monitored: r.monitored === 1,
});

// ---------- 评论 ----------

const COMMENT_COLS = `c.*, ${REPLIED} AS replied`;

// compact：给回评官省 token 的扁平形状，每条只带这几项（评论已删的多一个 gone: true）
export const toCompactComment = (c) => ({
  id: c.id, author: c.author.nickname, isMe: c.author.isMe, replyTo: c.replyTo?.nickname ?? null, text: c.text, at: c.createdAt, depth: c.depth,
  ...(c.goneAt ? { gone: true } : {}),
});

export function listComments(db, { workId, platforms, since, replied, includeGone = false, cursor, limit, compact = false } = {}) {
  const where = [], params = [];
  if (workId != null) { splitId(workId, 'workId'); where.push('workId = ?'); params.push(workId); }
  inList('platformCode', checkPlatforms(platforms), where, params);
  const s = checkTime(since, 'since');
  if (s) { where.push('createdAt >= ?'); params.push(s); }
  // replied: false 只要别人写的、还没回的（和 inbox 的未回复数一致）；我自己写的回复永远不算「待回复」
  if (replied === true) where.push('replied = 1');
  if (replied === false) where.push('replied = 0 AND authorIsMe = 0');
  if (!includeGone) where.push('goneAt IS NULL');
  return page(db, { prefix: REPLIED_CTE, cols: COMMENT_COLS, from: 'comments c', where, params, key: "coalesce(c.createdAt, '')", desc: true, limit, cursor, map: compact ? (r) => toCompactComment(toComment(r)) : toComment });
}

const workBrief = (db, workId) => {
  const w = db.prepare('SELECT id, title, url FROM engage_works WHERE id = ?').get(workId);
  return w ? { id: w.id, title: w.title, url: w.url } : { id: workId, title: null, url: null };
};

/**
 * 整楼嵌套树。所在楼的一楼不在库里时 root 是占位（missing: true）。
 * partial：作品标了楼中楼不全，或这楼里有 parent 不在库里的评论（被删的楼中楼，子评论只能挂到一楼），或一楼缺失。
 * compact：改成扁平列表（先序：一楼、再按时间逐个子树），每条见 toCompactComment；total 是楼里的条数（含一楼）。
 *   around（评论 id）+ n：只取目标前后各 n 条（默认 5，最多 50），一楼总在第一条；omitted 是没给出的条数。
 */
export function getCommentThread(db, commentId, { compact = false, around, n } = {}) {
  splitId(commentId, 'commentId');
  if (around != null && !compact) throw new Error('around 只能和 compact: true 一起用');
  if (n != null && around == null) throw new Error('n 只能和 around 一起用');
  const hit = db.prepare('SELECT rootId, workId FROM comments WHERE id = ?').get(commentId);
  if (!hit) throw new Error(`没有这条评论：${commentId}`);
  const rows = db.prepare(`${REPLIED_CTE} SELECT ${COMMENT_COLS} FROM comments c WHERE c.rootId = ? OR c.id = ? ORDER BY coalesce(c.createdAt, ''), c.id`).all(hit.rootId, hit.rootId);
  const nodes = new Map(rows.map((r) => [r.id, { ...toComment(r), children: [] }]));
  let root = nodes.get(hit.rootId);
  if (!root) root = { id: hit.rootId, missing: true, children: [] };
  let orphan = false;
  for (const node of nodes.values()) {
    if (node === root) continue;
    const parent = nodes.get(node.parentId);
    if (!parent) orphan = true;
    (parent ?? root).children.push(node);
  }
  const flag = db.prepare('SELECT partial FROM thread_partial WHERE workId = ?').get(hit.workId);
  const partial = flag?.partial === 1 || orphan || !!root.missing;
  if (!compact) return { work: workBrief(db, hit.workId), partial, root };
  const flat = [];
  const walk = (node) => { flat.push(node.missing ? { id: node.id, missing: true } : toCompactComment(node)); node.children.forEach(walk); };
  walk(root);
  const out = { work: workBrief(db, hit.workId), partial, total: flat.length, items: flat };
  if (around == null) return out;
  splitId(around, 'around');
  const at = flat.findIndex((c) => c.id === around);
  if (at < 0) throw new Error(`around 不在这栋楼里：${around}`);
  const k = n == null ? 5 : checkLimit(n, 50, 'n');
  const from = Math.max(1, at - k), to = Math.min(flat.length, at + k + 1);
  const items = at === 0 ? flat.slice(0, to) : [flat[0], ...flat.slice(from, to)];
  return { ...out, items, omitted: flat.length - items.length };
}

// ---------- 私信 ----------

export function listConversations(db, { platforms, unread, lastBy, since, cursor, limit } = {}) {
  const where = [], params = [];
  inList('platformCode', checkPlatforms(platforms), where, params);
  if (unread != null) where.push(unread ? 'unread > 0' : 'unread = 0');
  if (lastBy != null) {
    if (!['me', 'peer'].includes(lastBy)) throw new Error(`lastBy 只能是 me 或 peer：${lastBy}`);
    where.push('lastBy = ?'); params.push(lastBy);
  }
  const s = checkTime(since, 'since');
  if (s) { where.push('lastAt >= ?'); params.push(s); }
  return page(db, { cols: '*', from: 'conversations', where, params, key: "coalesce(lastAt, '')", desc: true, limit, cursor, map: toConversation });
}

/** 会话 + 最近 limit 条消息（旧到新）。 */
export function getConversation(db, conversationId, limit) {
  splitId(conversationId, 'conversationId');
  const c = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
  if (!c) throw new Error(`没有这个会话：${conversationId}`);
  const rows = db.prepare("SELECT * FROM messages WHERE conversationId = ? ORDER BY coalesce(at, '') DESC, id DESC LIMIT ?").all(conversationId, checkLimit(limit));
  return { conversation: toConversation(c), messages: rows.reverse().map(toMessage) };
}

// ---------- 事件 ----------

// 送达情况按所有订阅方汇总：最多的尝试次数、最近一次尝试、最早一次送达
const EVENT_COLS = `e.*, coalesce((SELECT max(attempts) FROM event_deliveries d WHERE d.eventId = e.id), 0) AS attempts,
  (SELECT max(lastAttemptAt) FROM event_deliveries d WHERE d.eventId = e.id) AS lastAttemptAt,
  (SELECT min(deliveredAt) FROM event_deliveries d WHERE d.eventId = e.id) AS deliveredAt`;

// compact 事件：评论事件按库里的评论补 isMe、replyTo、depth；subjectId 留着，回复时要用
function compactEvent(db) {
  const get = db.prepare('SELECT depth, authorIsMe, replyToNickname FROM comments WHERE id = ?');
  return (r) => {
    const p = json(r.payload) ?? {};
    const c = r.type === 'comment.created' && r.subjectId ? get.get(r.subjectId) : null;
    return {
      id: r.id, type: r.type, subjectId: r.subjectId, author: p.nickname ?? null, isMe: c ? c.authorIsMe === 1 : false,
      replyTo: c?.replyToNickname ?? null, text: p.text ?? null, at: r.createdAt, depth: c?.depth ?? null,
      ...(r.filteredReason ? { filteredReason: r.filteredReason } : {}),
    };
  };
}

export function listEvents(db, { types, platforms, unhandled, since, cursor, limit, compact = false } = {}) {
  const where = [], params = [];
  if (types != null) {
    if (!Array.isArray(types) || !types.length) throw new Error('types 要是非空数组');
    inList('type', types, where, params);
  }
  inList('platformCode', checkPlatforms(platforms), where, params);
  if (unhandled != null) where.push(unhandled ? 'handledAt IS NULL' : 'handledAt IS NOT NULL');
  const s = checkTime(since, 'since');
  if (s) { where.push('createdAt >= ?'); params.push(s); }
  return page(db, { cols: EVENT_COLS, from: 'events e', where, params, key: 'e.createdAt', desc: false, limit, cursor, map: compact ? compactEvent(db) : (r) => toEvent(r) });
}

/** 回执。同一事件可以再回执一次（例如 pending_human 之后人工回复了改成 replied），以最后一次为准。 */
export function ackEvent(db, eventId, outcome, note = null, { now = Date.now, actionId = null } = {}) {
  if (!OUTCOMES.includes(outcome)) throw new Error(`outcome 只能是 ${OUTCOMES.join('、')}：${outcome}`);
  if (typeof eventId !== 'string' || !eventId) throw new Error('eventId 不能为空');
  const r = db.prepare('UPDATE events SET handledAt = ?, handledOutcome = ?, handledNote = ?, actionId = ? WHERE id = ?')
    .run(iso(now()), outcome, note == null ? null : String(note).slice(0, 1000), actionId, eventId);
  if (!r.changes) throw new Error(`没有这个事件：${eventId}`);
  const row = db.prepare(`SELECT ${EVENT_COLS} FROM events e WHERE e.id = ?`).get(eventId);
  return { eventId, handled: toEvent(row).handled };
}

// ---------- 收件箱、账号、作品 ----------

export function inbox(db, { platforms } = {}) {
  const want = checkPlatforms(platforms);
  const codes = [...new Set(listAccountRows(db).map((a) => a.platformCode))].filter((p) => !want || want.includes(p));
  const ev = db.prepare('SELECT count(*) n FROM events WHERE platformCode = ? AND handledAt IS NULL');
  const conv = db.prepare('SELECT count(*) n FROM conversations WHERE platformCode = ? AND unread > 0');
  const com = db.prepare(`${REPLIED_CTE} SELECT count(*) n FROM comments c WHERE c.platformCode = ? AND c.goneAt IS NULL AND c.authorIsMe = 0 AND NOT ${REPLIED}`);
  return codes.map((p) => ({ platform: p, unhandledEvents: ev.get(p).n, unreadConversations: conv.get(p).n, unrepliedComments: com.get(p).n }));
}

function lastSyncOf(db, platformCode) {
  const rows = db.prepare("SELECT kind, max(finishedAt) at FROM sync_jobs WHERE platformCode = ? AND status = 'ok' GROUP BY kind").all(platformCode);
  return Object.fromEntries(rows.map((r) => [r.kind, r.at]));
}

const toAccount = (db, a) => ({
  id: a.id, platform: a.platformCode, platformName: a.platformName, uid: a.uid, nickname: a.nickname,
  loginState: a.loginState, loginCheckedAt: a.loginCheckedAt, capabilities: a.capabilities, lastSync: lastSyncOf(db, a.platformCode),
});

export const listAccounts = (db) => listAccountRows(db).map((a) => toAccount(db, a));
export function getAccountInfo(db, id) {
  splitId(id, '账号 id');
  const a = getAccount(db, id);
  return a ? toAccount(db, a) : null;
}

const WORK_COLS = `w.*,
  (SELECT count(*) FROM comments c WHERE c.workId = w.id AND c.goneAt IS NULL) AS commentCount,
  (SELECT count(*) FROM comments c WHERE c.workId = w.id AND c.goneAt IS NULL AND c.authorIsMe = 0 AND NOT ${REPLIED}) AS unrepliedCount`;

export function listWorks(db, { platforms, since, until, cursor, limit } = {}) {
  const where = [], params = [];
  inList('platformCode', checkPlatforms(platforms), where, params);
  const s = checkTime(since, 'since'), u = checkTime(until, 'until');
  if (s) { where.push('postTime >= ?'); params.push(s); }
  if (u) { where.push('postTime < ?'); params.push(u); }
  return page(db, { prefix: REPLIED_CTE, cols: WORK_COLS, from: 'engage_works w', where, params, key: "coalesce(w.postTime, w.firstSeenAt)", desc: true, limit, cursor, map: toWork });
}

function workRow(db, workId) {
  splitId(workId, 'workId');
  const r = db.prepare(`${REPLIED_CTE} SELECT ${WORK_COLS} FROM engage_works w WHERE w.id = ?`).get(workId);
  if (!r) throw new Error(`没有这个作品：${workId}`);
  return r;
}

/** Work + WorkSample 序列（S3 才有，先返回空数组）+ 一楼评论最新的 20 条（不含 gone）。 */
export function getWork(db, workId) {
  const work = toWork(workRow(db, workId));
  const top = db.prepare(`${REPLIED_CTE} SELECT ${COMMENT_COLS} FROM comments c WHERE c.workId = ? AND c.depth = 0 AND c.goneAt IS NULL ORDER BY coalesce(c.createdAt, '') DESC, c.id DESC LIMIT ?`).all(workId, TOP_COMMENTS);
  return { work, samples: [], topComments: top.map(toComment) };
}

/** 流速（S5 才有）：不编数。 */
export function getWorkFlow(db, workId) {
  workRow(db, workId);
  return { workId, hours: [], note: '流速数据由 S5 提供' };
}

export function refreshNow(db, { kind, platform, now }) {
  return requestRefresh(db, { kind, platform, ...(now ? { now } : {}) });
}
