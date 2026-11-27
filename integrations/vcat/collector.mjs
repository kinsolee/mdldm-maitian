// 小V猫只读采集器：只调白名单读工具，refresh 强制 false，绝不触发平台实时刷新。
// 跳过 Kinso 自己发的评论和自己发的私信，去重写入 shadow.db 的 inbox 表。
import crypto from 'node:crypto';
import { parseToolResultJson } from './upstream.mjs';

const MAX_SESSIONS_PER_POLL = 30;

function extractArray(payload, candidateKeys = ['items', 'list', 'comments', 'sessions', 'messages', 'accounts', 'data']) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of candidateKeys) {
    if (Array.isArray(payload[key])) return payload[key];
    if (payload[key] && typeof payload[key] === 'object') {
      for (const nested of candidateKeys) {
        if (Array.isArray(payload[key][nested])) return payload[key][nested];
      }
    }
  }
  return [];
}

function formatDateYmd(ms) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function pickString(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'string' && val.trim()) return val.trim();
    if (typeof val === 'number' && Number.isFinite(val)) return String(val);
  }
  return '';
}

function parseTimestamp(raw, fallbackMs) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    return new Date(ms).toISOString();
  }
  if (typeof raw === 'string' && raw.trim()) {
    const num = Number(raw.trim());
    if (Number.isFinite(num) && /^\d{10,13}$/.test(raw.trim())) {
      return new Date(num < 1e12 ? num * 1000 : num).toISOString();
    }
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(fallbackMs).toISOString();
}

function stableHash(parts) {
  return crypto.createHash('sha1').update(parts.map((p) => String(p ?? '')).join('|')).digest('hex').slice(0, 16);
}

function isSelfEntry(entry, selfNames, selfIds) {
  if (!entry || typeof entry !== 'object') return false;
  if (
    entry.isAuthor === true
    || entry.isSelf === true
    || entry.fromSelf === true
    || entry.isMe === true
    || entry.is_author === true
    || entry.is_self === true
    || entry.from_self === true
    || String(entry.direction || '').toLowerCase() === 'out'
    || String(entry.senderRole || entry.role || '').toLowerCase() === 'self'
    || String(entry.senderRole || entry.role || '').toLowerCase() === 'author'
  ) {
    return true;
  }
  // 注意：小V猫里顶层 uid 通常表示当前媒体账号 UID，不能当作发言人 ID，否则会把粉丝评论误判为本人。
  const authorId = pickString(entry, ['authorId', 'author_id', 'commenterId', 'senderId', 'sender_id', 'fromUid']);
  const authorName = pickString(entry, ['authorName', 'author_name', 'author', 'nickname', 'userName', 'senderName', 'fromName']);
  if (authorId && selfIds.has(authorId.toLowerCase())) return true;
  if (authorName && selfNames.has(authorName.toLowerCase())) return true;
  return false;
}

/** 从上游小V猫只读拉取已采到的评论与私信，跳过本人内容，去重写入 shadow.db。 */
export async function collectFromUpstream({ upstream, store, lookbackDays = 3, selfAuthors = [], now = Date.now }) {
  const nowMs = typeof now === 'function' ? now() : now;
  const selfNames = new Set(selfAuthors.map((s) => s.toLowerCase()));
  const selfIds = new Set(selfAuthors.map((s) => s.toLowerCase()));
  const accountMap = new Map();

  // 1. 读账号列表，用于映射账号名称和识别本人发出内容
  const accountsRes = await upstream.callReadTool('vcat_list_accounts', {});
  const accounts = extractArray(parseToolResultJson(accountsRes), ['accounts', 'items', 'list', 'data']);
  for (const acc of accounts) {
    const uid = pickString(acc, ['uid', 'accountUid', 'accountId', 'id']);
    const name = pickString(acc, ['nickname', 'name', 'accountName', 'userName']);
    const platform = pickString(acc, ['platform', 'platformName', 'site']);
    if (uid) {
      accountMap.set(uid, { uid, name, platform });
      selfIds.add(uid.toLowerCase());
    }
    if (name) selfNames.add(name.toLowerCase());
  }

  const normalizedItems = [];
  let fetchedComments = 0;
  let fetchedDms = 0;
  let skippedSelf = 0;

  // 2. 读评论（只读已采到的，includeAuthor: false，不触发实时刷新）
  const startDate = formatDateYmd(nowMs - Math.max(1, lookbackDays) * 86_400_000);
  const endDate = formatDateYmd(nowMs);
  const commentsRes = await upstream.callReadTool('vcat_list_comments', {
    startDate,
    endDate,
    includeAuthor: false,
    refresh: false,
  });
  const comments = extractArray(parseToolResultJson(commentsRes), ['comments', 'items', 'list', 'data']);
  for (const comment of comments) {
    fetchedComments += 1;
    if (isSelfEntry(comment, selfNames, selfIds)) {
      skippedSelf += 1;
      continue;
    }
    const content = pickString(comment, ['content', 'text', 'commentText', 'message', 'body']);
    if (!content) continue;
    const accountId = pickString(comment, ['accountUid', 'accountId', 'account_id', 'ownerUid', 'uid']);
    const accInfo = accountId ? accountMap.get(accountId) : null;
    const platform = pickString(comment, ['platform', 'platformName', 'site']) || accInfo?.platform || 'unknown';
    const accountName = pickString(comment, ['accountName', 'account_name']) || accInfo?.name || '';
    const nativeId = pickString(comment, ['commentId', 'comment_id', 'id', 'cid'])
      || stableHash([platform, accountId, comment.workId || comment.postId, comment.authorName || comment.author, content, comment.createdAt || comment.time]);
    normalizedItems.push({
      id: `comment:${platform}:${accountId || '-'}:${nativeId}`,
      kind: 'comment',
      platform,
      accountId: accountId || null,
      accountName: accountName || null,
      workId: pickString(comment, ['workId', 'postId', 'itemId', 'awemeId', 'videoId']) || null,
      workTitle: pickString(comment, ['workTitle', 'postTitle', 'title', 'videoTitle']) || null,
      authorName: pickString(comment, ['authorName', 'author_name', 'author', 'nickname', 'userName']) || null,
      authorId: pickString(comment, ['authorId', 'author_id', 'userId', 'user_id']) || null,
      content,
      occurredAt: parseTimestamp(comment.createdAt ?? comment.commentTime ?? comment.createTime ?? comment.time, nowMs),
      raw: comment,
    });
  }

  // 3. 读私信会话列表 + 逐会话读取本地已采消息（显式 refresh: false）
  const sessionsRes = await upstream.callReadTool('vcat_list_message_sessions', { refresh: false });
  const sessions = extractArray(parseToolResultJson(sessionsRes), ['sessions', 'items', 'list', 'data']);
  let inspectedSessions = 0;
  for (const session of sessions) {
    if (inspectedSessions >= MAX_SESSIONS_PER_POLL) break;
    if (session.lastFromSelf === true || session.lastIsSelf === true) {
      skippedSelf += 1;
      continue;
    }
    const sessionId = pickString(session, ['sessionId', 'session_id', 'talkId', 'conversationId', 'id']);
    if (!sessionId) continue;
    const accountId = pickString(session, ['accountUid', 'uid', 'accountId', 'account_id']);
    const accInfo = accountId ? accountMap.get(accountId) : null;
    const platform = pickString(session, ['platform', 'platformName', 'site']) || accInfo?.platform || 'unknown';
    const accountName = pickString(session, ['accountName', 'account_name']) || accInfo?.name || '';
    const peerName = pickString(session, ['peerName', 'peerNickname', 'userName', 'nickname', 'title']);
    const peerId = pickString(session, ['peerId', 'peerUid', 'userId']);

    inspectedSessions += 1;
    const msgArgs = { sessionId, refresh: false };
    if (accountId) msgArgs.uid = accountId;
    if (platform !== 'unknown') msgArgs.platform = platform;
    const messagesRes = await upstream.callReadTool('vcat_get_session_messages', msgArgs);
    const messages = extractArray(parseToolResultJson(messagesRes), ['messages', 'items', 'list', 'data']);
    if (messages.length === 0) continue;

    const ordered = [...messages].sort((a, b) => {
      const ta = Date.parse(parseTimestamp(a.createdAt ?? a.sendTime ?? a.timestamp ?? a.time, nowMs));
      const tb = Date.parse(parseTimestamp(b.createdAt ?? b.sendTime ?? b.timestamp ?? b.time, nowMs));
      return ta - tb;
    });

    // 找到最后一条本人发出的消息；只收集其之后对方新发的消息，避免把已回复旧私信或本人发言入队
    let lastSelfIdx = -1;
    for (let idx = 0; idx < ordered.length; idx += 1) {
      if (isSelfEntry(ordered[idx], selfNames, selfIds)) lastSelfIdx = idx;
    }
    if (lastSelfIdx >= 0) skippedSelf += lastSelfIdx + 1;

    for (let idx = lastSelfIdx + 1; idx < ordered.length; idx += 1) {
      const msg = ordered[idx];
      fetchedDms += 1;
      if (isSelfEntry(msg, selfNames, selfIds)) {
        skippedSelf += 1;
        continue;
      }
      const content = pickString(msg, ['content', 'text', 'message', 'body']);
      if (!content) continue;
      const msgId = pickString(msg, ['messageId', 'msgId', 'msg_id', 'id'])
        || stableHash([platform, accountId, sessionId, msg.senderName || peerName, content, msg.createdAt || msg.sendTime || msg.time]);
      normalizedItems.push({
        id: `dm:${platform}:${accountId || '-'}:${sessionId}:${msgId}`,
        kind: 'dm',
        platform,
        accountId: accountId || null,
        accountName: accountName || null,
        sessionId,
        authorName: pickString(msg, ['senderName', 'authorName', 'nickname', 'fromName']) || peerName || null,
        authorId: pickString(msg, ['senderId', 'authorId', 'fromUid', 'userId']) || peerId || null,
        content,
        occurredAt: parseTimestamp(msg.createdAt ?? msg.sendTime ?? msg.timestamp ?? msg.time, nowMs),
        raw: msg,
      });
    }
  }

  const { accepted, duplicate } = store.ingestInbox(normalizedItems, { now: nowMs });
  store.setMeta('lastCollectAt', new Date(nowMs).toISOString());
  return {
    fetchedComments,
    fetchedDms,
    skippedSelf,
    accepted,
    duplicate,
    pending: store.pendingCount(),
  };
}
