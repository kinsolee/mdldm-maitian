// S7 engage 处置组（delete_comment / block_user / delete_conversation）在库里的那一半：找目标、认自己、核对事件、库里预检。
// 写入流程（幂等、能力位、每轮上限、租约、发后回读、回执、连续失败自动关）和 reply_comment 共用 write.mjs 的 engageWrite。
// 每种操作做得到的平台见 MOD_SUPPORT；平台本身没有入口、或拿不到回读证据的，写进 MOD_UNSUPPORTED，调用时原样告诉调用方。
// 绝不对登记过的本平台账号（账号自身 mid）动手：库里看得出就 rejected self-target，写入脚本在页面上再核一次。
import { listAccounts } from '../accounts.mjs';

export const MOD_CAPS = ['deleteComment', 'block', 'deleteConversation'];
export const MOD_ROUND_LIMIT = 10;   // 每个平台每轮（整点小时）每种操作分别计
// 每种操作做得到的平台（各平台的写入脚本在 writers/index.mjs 的 MODERATE_FILES）。不在这里的调用一律 rejected unsupported-platform
export const MOD_SUPPORT = { delete: ['Bili'], block: ['Bili'], deleteConversation: ['Bili'] };
// 做不到的原因（2026-11-22 只读核对各平台页面代码）。没写原因的就是还没接上
export const MOD_UNSUPPORTED = {
  'Douyin:deleteConversation': '抖音私信页删普通会话时，页面 IM SDK 先删本地、再调 MarkConversationDelete，服务端报错被 SDK 吞掉；页面上没有能确认服务端已删的读接口，删了也回读不了，暂不做',
  'Channels:deleteConversation': '视频号助手私信页没有删除会话的入口（页面代码里 deleteSessionById 只打日志，不调接口），做不了',
  'XiaoHongShu:block': '小红书网页版没有拉黑入口（页面只提示「请前往手机端」），只能在手机 App 上拉黑',
  'XiaoHongShu:deleteConversation': '小红书网页版私信只能删群聊（chats/remove/group），单聊没有删除接口，页面上的删除只删本地列表',
};
export const modSupported = (op, platformCode) => MOD_SUPPORT[op]?.includes(platformCode) === true;
/** 不支持时给调用方的说明。 */
export const modUnsupportedDetail = (op, platformCode) => MOD_UNSUPPORTED[`${platformCode}:${op}`]
  ?? `${op} 目前只做 ${(MOD_SUPPORT[op] ?? []).join('、') || '（无）'}，${platformCode} 还没接上`;

// what：入参名；ackOutcome：生效后回执事件用的 outcome；sentReason：同一目标之前已生效时的 reason
export const MOD_OPS = {
  delete: { cap: 'deleteComment', what: 'commentId', eventType: 'comment.created', family: 'moderate', ackOutcome: 'ignored', sentReason: 'already-gone' },
  block: { cap: 'block', what: 'target', eventType: null, family: 'moderate', ackOutcome: 'ignored', sentReason: 'already-blocked' },
  deleteConversation: { cap: 'deleteConversation', what: 'conversationId', eventType: 'dm.received', family: 'moderate', ackOutcome: 'ignored', sentReason: 'already-gone', sinceLastAt: true },
};

const nativeOf = (id) => (id == null ? null : String(id).slice(String(id).indexOf(':') + 1));
export const selfUids = (db, platformCode) => listAccounts(db, { platform: platformCode }).map((a) => String(a.uid));

/**
 * block 的 target 可以是 <平台>:<mid>、评论 id、会话 id（B站会话 id 就是对方 mid）。
 * 返回 { targetId: '<平台>:<mid>', mid, accountId, via: 'comment'|'conversation'|'mid', subjectId, ackType } 或 { reject: [reason, detail] }。
 * 只认库里见过的人：评论作者或会话对方。同一个 id 既是评论又是别人的 mid（指向两个人）时拒绝，免得拉错人。
 */
export function resolveBlockTarget(db, req) {
  const n = nativeOf(req.inputId);
  const mine = new Set(selfUids(db, req.platformCode));
  const c = db.prepare('SELECT id, accountId, authorUid, authorIsMe FROM comments WHERE id = ?').get(req.inputId);
  const k = db.prepare('SELECT id, accountId, peerUid, peerKind FROM conversations WHERE id = ?').get(req.inputId);
  // 群聊、官方号的会话 id 不是用户 mid（群 id 和用户 mid 是两套号），绝不拿来拉黑
  if (k && k.peerKind !== 'user' && !c) return { reject: ['not-a-user', `${req.inputId} 是${k.peerKind === 'group' ? '群聊' : '官方号'}会话，不是普通用户，不拉黑`] };
  const asMid = db.prepare(`SELECT accountId FROM comments WHERE platformCode = ? AND authorUid = ?
    UNION SELECT accountId FROM conversations WHERE platformCode = ? AND peerUid = ? AND peerKind = 'user'`).all(req.platformCode, n, req.platformCode, n);
  const cands = [];
  // 对象是我自己（入参本身是本平台账号 mid，或评论作者是我）：先于「库里没见过」「指向两个人」判，一律 self-target
  if (mine.has(n) || (c && (c.authorIsMe === 1 || mine.has(String(c.authorUid))))) return { reject: ['self-target', `拉黑对象是我自己（${req.inputId}），不拉黑`] };
  if (c) cands.push({ mid: c.authorUid == null ? null : String(c.authorUid), accountId: c.accountId, via: 'comment', ackType: 'comment.created', isMe: c.authorIsMe === 1 });
  if (k && k.peerKind === 'user') cands.push({ mid: String(k.peerUid ?? nativeOf(k.id)), accountId: k.accountId, via: 'conversation', ackType: 'dm.received' });
  if (asMid.length) cands.push({ mid: n, accountId: asMid.length === 1 ? asMid[0].accountId : null, via: 'mid', ackType: null, accounts: asMid.length });
  if (!cands.length) return { reject: ['unknown-target', `库里没有 ${req.inputId}：不是见过的评论、会话，也不是见过的评论作者或私信对方。先 refresh_now 再试`] };
  const mids = new Set(cands.map((x) => x.mid));
  if ([...mids].some((x) => mine.has(String(x)))) return { reject: ['self-target', `拉黑对象是我自己（${req.inputId}），不拉黑`] };
  if (mids.size > 1) return { reject: ['ambiguous-target', `${req.inputId} 同时对上了不同的人（${[...mids].join('、')}），请换成评论 id 或会话 id`] };
  const pick = cands[0];
  if (!pick.mid) return { reject: ['unknown-target', `库里 ${req.inputId} 没有作者 mid`] };
  if (pick.accountId == null) return { reject: ['ambiguous-target', `${req.inputId} 在多个本平台账号下都出现过，判断不了用哪个账号拉黑`] };
  const subjectId = pick.via === 'mid' ? null : req.inputId;
  return { targetId: `${req.platformCode}:${pick.mid}`, mid: pick.mid, accountId: pick.accountId, via: pick.via, ackType: pick.ackType,
    subjectId, sourceId: subjectId ?? latestSource(db, req.platformCode, pick.accountId, pick.mid), isMe: !!pick.isMe };
}

/** 只给了 mid 时，这个人在这个账号下最近的一条评论或会话（两边一起按时间比）：有的平台要从评论或会话里重读出对方的其他 id（如抖音 sec_uid）。 */
function latestSource(db, platformCode, accountId, mid) {
  // 评论和会话放在一起按时间比，取最新的一条；时间缺失的排在最后，同一时间评论优先
  return db.prepare(`SELECT id FROM (
      SELECT id, createdAt t, 0 k, rowid r FROM comments WHERE platformCode = ? AND accountId = ? AND authorUid = ? AND goneAt IS NULL
      UNION ALL
      SELECT id, lastAt t, 1 k, rowid r FROM conversations WHERE platformCode = ? AND accountId = ? AND peerUid = ? AND peerKind = 'user')
    ORDER BY t IS NULL, t DESC, k, r DESC LIMIT 1`).get(platformCode, accountId, mid, platformCode, accountId, mid)?.id ?? null;
}

/** 拉黑的来源（评论或会话）换成写入脚本用的原生 id；没有来源返回 null。 */
function blockSource(db, id) {
  if (id == null) return null;
  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(id);
  if (c) return { kind: 'comment', commentId: nativeOf(c.id), workId: nativeOf(c.workId), parentId: nativeOf(c.parentId), rootId: nativeOf(c.rootId), authorUid: c.authorUid };
  const k = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  if (k) return { kind: 'conversation', conversationId: nativeOf(k.id), peerUid: k.peerUid };
  return null;
}

/** 库里的目标：{ accountId, row, target } 或 null。block 的目标在 resolveBlockTarget 里已经找好（req.block）。 */
export function loadModTarget(db, req) {
  if (req.op === 'delete') {
    const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.targetId);
    if (!c) return null;
    return { accountId: c.accountId, row: c, target: { commentId: nativeOf(c.id), workId: nativeOf(c.workId), parentId: nativeOf(c.parentId), rootId: nativeOf(c.rootId), authorUid: c.authorUid } };
  }
  if (req.op === 'deleteConversation') {
    const k = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.targetId);
    if (!k) return null;
    return { accountId: k.accountId, row: k, target: { conversationId: nativeOf(k.id), peerUid: k.peerUid } };
  }
  const b = req.block;
  // source：从哪条评论、哪个会话认出这个人（B站用不上；抖音要靠它重读出对方的 sec_uid）
  return { accountId: b.accountId, row: {}, target: { mid: b.mid, via: b.via, source: blockSource(db, b.sourceId) } };
}

/** 对象是本平台登记过的账号（我自己）：返回原因，否则 null。 */
export function selfTarget(db, req, t) {
  const mine = new Set(selfUids(db, req.platformCode));
  if (req.op === 'delete') {
    if (t.row.authorIsMe === 1 || mine.has(String(t.row.authorUid))) return `${req.targetId} 是我自己的评论，不删`;
    return null;
  }
  if (req.op === 'deleteConversation') {
    if (mine.has(String(t.row.peerUid)) || mine.has(String(nativeOf(t.row.id)))) return `${req.targetId} 的对方是我自己，不删`;
    return null;
  }
  if (req.block.isMe || mine.has(String(req.block.mid))) return `拉黑对象 ${req.block.mid} 是我自己，不拉黑`;
  return null;
}

/** eventId 核对：delete 是这条评论的 comment.created，deleteConversation 是这个会话的 dm.received；block 是这个人的评论或私信事件。 */
/** 目标属于哪个账号：评论、会话按库里的行，拉黑按推出 mid 时用的那一行。库里没有返回 null。 */
export function modTargetAccount(db, req) {
  if (req.op === 'block') return req.block?.accountId ?? null;
  const table = req.op === 'delete' ? 'comments' : 'conversations';
  return db.prepare(`SELECT accountId FROM ${table} WHERE id = ?`).get(req.targetId)?.accountId ?? null;
}

export function modEventMatches(db, req) {
  if (req.eventId == null) return true;
  const e = db.prepare('SELECT type, subjectId, platformCode, accountId FROM events WHERE id = ?').get(req.eventId);
  if (!e || e.platformCode !== req.platformCode) return false;
  // 事件必须是目标所属账号的（同平台登记了多个账号时，不能拿别的账号的事件来回执）
  const acct = modTargetAccount(db, req);
  if (!acct || (e.accountId != null && e.accountId !== acct)) return false;
  if (req.op !== 'block') return e.type === req.spec.eventType && e.subjectId === req.targetId;
  // 同平台、同账号下这个人的评论或私信事件（不同平台的 uid 是不同的号，不能混）
  if (e.type === 'comment.created') {
    return String(db.prepare('SELECT authorUid FROM comments WHERE id = ? AND platformCode = ? AND accountId = ?').get(e.subjectId, req.platformCode, req.block.accountId)?.authorUid ?? '') === req.block.mid;
  }
  if (e.type === 'dm.received') {
    return String(db.prepare("SELECT peerUid FROM conversations WHERE id = ? AND platformCode = ? AND accountId = ? AND peerKind = 'user'").get(e.subjectId, req.platformCode, req.block.accountId)?.peerUid ?? '') === req.block.mid;
  }
  return false;
}

/** 生效后要回执的事件类型和主体：block 按入参是评论还是会话；直接给 mid 的只回执 eventId。 */
export const modAckSubject = (req) => (req.op === 'block'
  ? { type: req.block.ackType, subjectId: req.block.subjectId }
  : { type: req.spec.eventType, subjectId: req.targetId });

/** 库里就看得出不用动手的：评论已标 goneAt。群聊、官方号会话不删（remove_session 这里只按用户会话 session_type=1 调）。 */
export function modPrecheck(req, row) {
  if (req.op === 'delete' && row.goneAt) return ['already-gone', `库里这条评论 ${row.goneAt} 起已不在平台上`];
  if (req.op === 'deleteConversation' && row.peerKind !== 'user') return ['not-a-user', `这是${row.peerKind === 'group' ? '群聊' : '官方号'}会话，不删`];
  return null;
}
