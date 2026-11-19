// 适配器输出的公共部分（Node 里跑）：结果骨架、时间换算、两层平台还原 parent、形状校验。
// 形状见 KIN-323 模块约定「适配器输出」。

export const TEXT_MAX = 500;

/** 秒或毫秒时间戳（数字或数字串）→ ISO；拿不到返回 null。 */
export function isoOf(t) {
  if (t == null || t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n < 1e12 ? n * 1000 : n).toISOString();
}

export const str = (v) => (v == null || v === '' ? null : String(v));
export const clip = (s, n = TEXT_MAX) => (s == null ? null : String(s).slice(0, n));
export const numOrNull = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** 成功结果的骨架；kind 决定哪一半是空数组。 */
export function okResult({ platformCode, accountUid, kind, fetchedAt, works = [], comments = [], scannedWorks = [], conversations = [], messages = [] }) {
  const c = kind === 'comments';
  return { ok: true, platformCode, accountUid: String(accountUid), kind, fetchedAt,
    works: c ? works : [], comments: c ? comments : [], scannedWorks: c ? scannedWorks : [],
    conversations: c ? [] : conversations, messages: c ? [] : messages };
}

/**
 * 两层平台还原 parent：parentNativeId 为 undefined 的二层评论按规则补上——
 * 有 replyTo 时，在同一楼里按被回复者 uid（没有 uid 就按昵称）找最近一条更早的评论；找不到、或没有 replyTo，挂一楼。
 * 平台直接给了 parent（字符串或一楼的 null）的不动。返回新数组，不改入参。
 */
export function resolveParents(comments) {
  const byRoot = new Map();
  for (const x of comments) {
    if (!byRoot.has(x.rootNativeId)) byRoot.set(x.rootNativeId, []);
    byRoot.get(x.rootNativeId).push(x);
  }
  const t = (x) => Date.parse(x.createdAt) || 0;
  const same = (a, r) => (r.uid ? a.uid != null && String(a.uid) === String(r.uid) : r.nickname != null && a.nickname === r.nickname);
  return comments.map((x) => {
    if (x.parentNativeId !== undefined) return x;
    if (x.nativeId === x.rootNativeId) return { ...x, parentNativeId: null };
    let parent = x.rootNativeId;
    if (x.replyTo && (x.replyTo.uid || x.replyTo.nickname)) {
      const earlier = (byRoot.get(x.rootNativeId) ?? [])
        .filter((y) => y !== x && t(y) <= t(x) && same(y.author, x.replyTo))
        .sort((a, b) => t(b) - t(a));
      if (earlier[0]) parent = earlier[0].nativeId;
    }
    return { ...x, parentNativeId: parent };
  });
}

// —— 形状校验 ——
const isStr = (v) => typeof v === 'string' && v.length > 0;
const isIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)) && /T.*Z$/.test(v);
const nullable = (f) => (v) => v === null || f(v);
const isBool = (v) => typeof v === 'boolean';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const TYPES = ['text', 'image', 'share', 'other'];

function check(errs, where, obj, spec) {
  if (!obj || typeof obj !== 'object') { errs.push(`${where} 不是对象`); return; }
  for (const [k, f] of Object.entries(spec)) if (!f(obj[k])) errs.push(`${where}.${k} 不对：${JSON.stringify(obj[k])?.slice(0, 60)}`);
}

/** 返回形状错误列表（空数组表示合格）。成功、跳过、失败三种形状都认。 */
export function shapeErrors(r) {
  const errs = [];
  if (!r || typeof r !== 'object') return ['结果不是对象'];
  if (r.ok === false) {
    if (!r.skipped && !isStr(r.reason)) errs.push('失败结果要有 reason 或 skipped');
    if (r.skipped && !['busy', 'user-controlled', 'profile-needed'].includes(r.skipped)) errs.push(`skipped 取值不对：${r.skipped}`);
    return errs;
  }
  check(errs, 'result', r, { ok: (v) => v === true, platformCode: isStr, accountUid: isStr, kind: (v) => v === 'comments' || v === 'dms', fetchedAt: isIso,
    works: Array.isArray, comments: Array.isArray, scannedWorks: Array.isArray, conversations: Array.isArray, messages: Array.isArray });
  if (errs.length) return errs;
  r.works.forEach((w, i) => check(errs, `works[${i}]`, w, { nativeId: isStr, title: nullable((v) => typeof v === 'string'), url: nullable(isStr), postTime: nullable(isIso) }));
  r.comments.forEach((c, i) => {
    check(errs, `comments[${i}]`, c, { nativeId: isStr, workNativeId: isStr, parentNativeId: nullable(isStr), rootNativeId: isStr,
      replyTo: (v) => v === null || (v && typeof v === 'object' && 'uid' in v && 'nickname' in v),
      text: (v) => typeof v === 'string', createdAt: isIso, likeCount: nullable(isNum), likedByMe: nullable(isBool), pinned: nullable(isBool),
      replyCount: nullable(isNum), ipLabel: nullable((v) => typeof v === 'string') });
    check(errs, `comments[${i}].author`, c.author, { uid: nullable(isStr), nickname: (v) => typeof v === 'string', isMe: isBool });
    if (c.parentNativeId === null && c.rootNativeId !== c.nativeId) errs.push(`comments[${i}] 一楼的 rootNativeId 要写自己`);
    if (c.parentNativeId !== null && c.rootNativeId === c.nativeId) errs.push(`comments[${i}] 楼中楼的 rootNativeId 不能是自己`);
  });
  r.scannedWorks.forEach((s, i) => check(errs, `scannedWorks[${i}]`, s, { workNativeId: isStr, complete: isBool, threadsPartial: isBool }));
  const last = (v) => v === null || (v && ['me', 'peer'].includes(v.by) && isIso(v.at) && (v.text === null || typeof v.text === 'string') && TYPES.includes(v.type));
  r.conversations.forEach((c, i) => {
    check(errs, `conversations[${i}]`, c, { nativeId: isStr, unread: isNum, last, canSend: isBool });
    check(errs, `conversations[${i}].peer`, c.peer, { uid: nullable(isStr), nickname: nullable((v) => typeof v === 'string'), kind: (v) => ['user', 'official', 'group'].includes(v) });
  });
  r.messages.forEach((m, i) => check(errs, `messages[${i}]`, m, { nativeId: isStr, conversationNativeId: isStr, by: (v) => v === 'me' || v === 'peer', at: isIso, type: (v) => TYPES.includes(v), text: nullable((v) => typeof v === 'string') }));
  return errs;
}

/** 解析时发现整个 kind 不可信（接口返回非 0、必需数据读不到）：collect 按 reason 返回失败，不报 ok。 */
export class AdapterError extends Error {
  constructor(reason, message) { super(message); this.reason = reason; }
}
export const adapterFail = (reason, message) => { throw new AdapterError(reason, message); };
