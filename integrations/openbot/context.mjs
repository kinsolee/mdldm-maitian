// 推送消息里的精简上下文：从麦田 ops.db 只读取，复用 MCP compact 模式的查询函数。
// 读不到（库不在、事件不在、评论或会话不在）就少带或不带，不挡投递：agent 仍可用工具自己查。
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { getCommentThread, getConversation } from '../../src/ops/engage/query.mjs';

export const THREAD_AROUND = 3;   // 楼片段：目标前后各 3 条（一楼总在第一条）
export const DM_LAST = 5;         // 私信：会话最后 5 条
export const TEXT_MAX = 500;      // 单个文本字段最多这么多字

const clip = (s) => (typeof s === 'string' && s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX)}…` : s ?? null);
const json = (s) => { try { return JSON.parse(s); } catch { return {}; } };

/** 只读打开 ops.db；文件不在返回 null。 */
export function openOpsDbReadOnly(file) {
  if (!file || !fs.existsSync(file)) return null;
  return new DatabaseSync(file, { readOnly: true, timeout: 5000 });
}

function commentContext(db, e, p) {
  const c = db.prepare('SELECT authorNickname, authorIsMe, replyToNickname, text, depth, workId FROM comments WHERE id = ?').get(e.subjectId);
  const workTitle = (c && db.prepare('SELECT title FROM engage_works WHERE id = ?').get(c.workId)?.title) ?? p.workTitle ?? null;
  const out = {
    author: clip(c?.authorNickname ?? p.nickname ?? null), isMe: c ? c.authorIsMe === 1 : null, replyTo: clip(c?.replyToNickname ?? null),
    text: clip(c?.text ?? p.text ?? null), workTitle: clip(workTitle), depth: c?.depth ?? null,
  };
  if (!c) return out;
  const t = getCommentThread(db, e.subjectId, { compact: true, around: e.subjectId, n: THREAD_AROUND });
  out.thread = { partial: t.partial, total: t.total, omitted: t.omitted, items: t.items.map((x) => (x.missing ? x : { ...x, author: clip(x.author), replyTo: clip(x.replyTo), text: clip(x.text) })) };
  return out;
}

function dmContext(db, e, p) {
  const conversationId = p.conversationId ?? e.subjectId;
  const out = { conversationId, peer: clip(p.nickname ?? null), text: clip(p.text ?? null) };
  if (!conversationId || !db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(conversationId)) return out;
  const { conversation, messages } = getConversation(db, conversationId, DM_LAST);
  out.peer = clip(conversation.peer.nickname ?? out.peer);
  out.messages = messages.map((m) => ({ by: m.by, at: m.at, type: m.type, text: clip(m.text) }));
  return out;
}

/** 每个事件 id 的上下文：Map<id, object>。库里没有的事件不进 Map。 */
export function loadContexts(db, ids) {
  const get = db.prepare('SELECT id, type, platformCode, subjectId, payload FROM events WHERE id = ?');
  const out = new Map();
  for (const id of ids) {
    const e = get.get(id);
    if (!e) continue;
    const p = json(e.payload);
    const base = { id, type: e.type, platform: e.platformCode, subjectId: e.subjectId };
    try {
      if (e.type === 'comment.created') out.set(id, { ...base, ...commentContext(db, e, p) });
      else if (e.type === 'dm.received') out.set(id, { ...base, ...dmContext(db, e, p) });
      else out.set(id, base);
    } catch {
      out.set(id, base);   // 某一条读坏了只少这一条的上下文
    }
  }
  return out;
}

/** 给 cliForwarder 用：每次投递现开现关只读库，出任何错都返回空 Map（消息里只有 id，agent 自己查）。 */
export function opsContextSource(file, { log = () => {} } = {}) {
  return (ids) => {
    let db;
    try {
      db = openOpsDbReadOnly(file);
      return db ? loadContexts(db, ids) : new Map();
    } catch (e) {
      log(`读麦田上下文失败，这批只带 id：${e.code ?? e.message}`);
      return new Map();
    } finally {
      db?.close();
    }
  };
}
