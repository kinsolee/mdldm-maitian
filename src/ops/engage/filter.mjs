// 推送前的确定过滤：命中的事件只记库、不推，自动回执成 skipped（note 写规则名），events.filteredReason 记规则名。
// 规则只看 comments 表里入库时就定下的字段（authorIsMe），不看任何文本；评论行不在库里的一律不过滤，照常推。
import { ackEvent } from './query.mjs';

export const FILTER_RULES = ['self-author'];

/**
 * 一条 comment.created 事件命中哪条规则，没命中返回 null。
 * self-author：评论作者是本账号（comments.authorIsMe === 1）。
 */
export function filterRuleFor(db, event) {
  if (event.type !== 'comment.created' || !event.subjectId) return null;
  const c = db.prepare('SELECT authorIsMe FROM comments WHERE id = ?').get(event.subjectId);
  if (!c) return null;
  return c.authorIsMe === 1 ? 'self-author' : null;
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
