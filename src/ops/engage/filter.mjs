// 推送前的确定过滤：命中的事件只记库、不推，自动回执成 skipped（note 写规则名），events.filteredReason 记规则名。
// 两条规则只看 comments 表里入库时就定下的字段（authorIsMe、depth、parentId、replyToUid），不看任何文本。
// 拿不准的（评论行不在库里、父评论不在库里、replyTo 只有昵称没有 uid、作品的楼中楼拿不全）一律不过滤，照常推。
import { ackEvent } from './query.mjs';

export const FILTER_RULES = ['self-author', 'peer-reply'];

/**
 * 一条 comment.created 事件命中哪条规则，没命中返回 null。
 * self-author：评论作者是本账号。
 * peer-reply：楼中楼（depth ≥ 1），直接回复的那条在库里且不是本账号写的，replyTo 也没指向本账号。
 *   一楼永远不算；回的是 Kinso 的（父评论是我的，或 replyToUid 是我的 uid）也不算。
 */
export function filterRuleFor(db, event) {
  if (event.type !== 'comment.created' || !event.subjectId) return null;
  const c = db.prepare('SELECT accountId, workId, depth, parentId, authorIsMe, replyToUid, replyToNickname FROM comments WHERE id = ?').get(event.subjectId);
  if (!c) return null;
  if (c.authorIsMe === 1) return 'self-author';
  if (c.depth < 1 || c.parentId == null) return null;
  // 楼中楼拿不全时，有的适配器（小红书、视频号）把找不到的父评论改挂到一楼、清掉 replyTo：这时「父评论是网友的」不可信
  if (db.prepare('SELECT partial FROM thread_partial WHERE workId = ?').get(c.workId)?.partial === 1) return null;
  const parent = db.prepare('SELECT authorIsMe FROM comments WHERE id = ?').get(c.parentId);
  if (!parent || parent.authorIsMe === 1) return null;
  if (c.replyToUid == null) return c.replyToNickname == null ? 'peer-reply' : null;
  return myUids(db, c.accountId).has(c.replyToUid) ? null : 'peer-reply';
}

// 本账号的 uid：账号表里的，加上库里我写过的评论的 authorUid（有的平台评论里的 uid 和账号 uid 写法不同）
function myUids(db, accountId) {
  const uids = new Set(db.prepare('SELECT authorUid FROM comments WHERE accountId = ? AND authorIsMe = 1 AND authorUid IS NOT NULL').all(accountId).map((r) => r.authorUid));
  const i = accountId.indexOf(':');
  if (i > 0) uids.add(accountId.slice(i + 1));
  return uids;
}

/**
 * 给还没回执、还没送达过任何订阅方的 comment.created 事件跑一遍规则。命中的标 filteredReason 并回执 skipped。
 * 已经送达过的不动：bot 手里可能正在处理。返回 [{ eventId, rule }]。
 */
export function applyEventFilters(db, { now = Date.now } = {}) {
  const mark = db.prepare('UPDATE events SET filteredReason = ? WHERE id = ?');
  // 查和写在同一个写事务里：别的进程（MCP 的 ack_event）不会在中间回执同一条、再被这里盖成 skipped
  db.exec('BEGIN IMMEDIATE');
  try {
    const rows = db.prepare(`SELECT id, type, subjectId FROM events e WHERE e.type = 'comment.created' AND e.handledAt IS NULL AND e.filteredReason IS NULL
      AND NOT EXISTS (SELECT 1 FROM event_deliveries d WHERE d.eventId = e.id AND d.deliveredAt IS NOT NULL) ORDER BY e.createdAt, e.id`).all();
    const hits = rows.map((r) => ({ eventId: r.id, rule: filterRuleFor(db, r) })).filter((h) => h.rule);
    for (const h of hits) { mark.run(h.rule, h.eventId); ackEvent(db, h.eventId, 'skipped', h.rule, { now }); }
    db.exec('COMMIT');
    return hits;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
