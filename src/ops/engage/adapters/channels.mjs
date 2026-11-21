// 视频号评论、私信。业务页面在 wujie 微前端的 shadowRoot 里，请求从沙箱 iframe 发，外层挂钩抓不到，所以读 Vue 2 组件数据。
//   评论：/platform/interaction/comment。左侧作品列表组件的 commentFeeds（objectNonce、createTime、commentCount），
//        挑近 maxAgeDays 天、评论数 >0 的作品（最多 maxWorks 个，新的优先）逐个点开（会把评论标已读，允许），
//        点「展开更多回复」（只读展开）后读 .comment-item 的 __vue__.$props.dataSource。
//        二楼在 levelTwoComment[] 里，同时也会单独渲染成一个 .comment-item，按 id 去重。
//        replyCommentId 指向谁就挂谁，没有就挂一楼。平台不给评论者 uid，isMe 按昵称等于 finderUser.nickname。
//   私信：/platform/private_msg，.session-wrap 往上的 Vue 实例 $data.sessionList；messageList 新到旧、只带最近 2 条，
//        取 ts 最大的判 last.by（fromUsername == sessionInfo.username 是对方）。
//   S9 页面内接口（账号能力位 readViaApi 打开时，params.readVia = 'api'）：作品列表照旧读组件的 commentFeeds，
//        评论改成调沙箱 iframe 里页面自己的评论服务 getCommentList（见 ../inpage-api.mjs），不再点作品、不点「展开更多回复」：
//        一楼 { lastBuff, exportId: objectId }，楼中楼加 rootCommentId 和那条一楼的 lastBuff（同页面自己的 fetchReply）。
//        不调 updateFeedCommentReadState，所以评论不会被标已读。原始数据形状同 DOM 路径；找不到页面服务时退回 DOM（raw.apiFallback）。
// 不点 .like-action、不点回复图标、不往任何输入框里写字。
import { pageEnd, pageMore, serviceCaller } from '../inpage-api.mjs';
import { open, atLogin, clickMarked, mainPage, sleep } from './page-lib.mjs';
import { adapterFail, clip, isoOf, numOrNull, okResult, str } from './shape.mjs';

export const FILE = 'channels.mjs';
export const LIMITS = { maxWorks: 10, maxAgeDays: 30, maxExpand: 15, waitMs: 20000, maxPages: 10, apiGapMs: 800 };
const COMMENT_PAGE = 'https://channels.weixin.qq.com/platform/interaction/comment';
const DM_PAGE = 'https://channels.weixin.qq.com/platform/private_msg';

// —— 页面脚本 ——
export async function runInSpace(task, params) {
  const o = { ...LIMITS, ...params };
  const page = await mainPage(task);
  await open(page, params.kind === 'dms' ? DM_PAGE : COMMENT_PAGE);
  const auth = await page.fetch('/cgi-bin/mmfinderassistant-bin/auth/auth_data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', timeout: 15000 }).catch(() => null);
  let a = null; try { a = JSON.parse(auth?.body ?? 'null'); } catch {}
  const login = await atLogin(page);
  if (login || (a && a.errCode != null && a.errCode !== 0)) return { loginLost: true, evidence: `auth/auth_data errCode=${a?.errCode}；${login ? `页面在 ${login}` : '页面没跳登录'}` };
  // G-B4b：没拿到自己的昵称就没法判 isMe（自己的回复会被当成新评论），不往下采
  const fu = a?.data?.finderUser;
  if (!a || !fu?.nickname) return { failed: 'auth-failed', error: `auth/auth_data ${!auth ? '请求失败或超时' : !a ? '不是 JSON' : `errCode=${a.errCode} 缺 finderUser.nickname`}` };
  const me = { nickname: fu.nickname };
  const uidSeen = fu.uniqId ?? null;
  return params.kind === 'dms' ? { kind: 'dms', uidSeen, me, ...(await rawDms(page, o)) } : { kind: 'comments', uidSeen, me, ...(await rawComments(page, o)) };
}

const inShadow = (page, fnSrc, arg) => page.evaluate(new Function('arg', `const sr = document.querySelector('wujie-app')?.shadowRoot; if (!sr) return null; ${fnSrc}`), arg ?? null);

// 页面明确显示「暂无…」空状态
const emptyShown = async (page) => !!(await inShadow(page, `return /暂无|没有(更多)?(作品|评论|私信|消息)/.test(sr.textContent || '');`));

async function waitShadow(page, sel, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(1000)) if (await inShadow(page, `return !!sr.querySelector(${JSON.stringify(sel)});`)) return true;
  return false;
}

// 页面内取数源码（在 wujie shadowRoot 上跑，sr 是 shadowRoot；导出给测试在假 shadowRoot 上跑）。
// 组件读不到返回 null；组件在、数据是合法空数组才返回 []（X2-B3）。作品一个都没有时 .comment-feed-wrap 不存在，所以退而扫全部元素找组件。
export const FEEDS_SRC = `let x = sr.querySelector('.comment-feed-wrap'); let vm = null;
  for (let i = 0; x && i < 8 && !vm; x = x.parentElement, i++) if (Array.isArray(x.__vue__?.commentFeeds)) vm = x.__vue__;
  if (!vm) for (const e of sr.querySelectorAll('*')) if (Array.isArray(e.__vue__?.commentFeeds)) { vm = e.__vue__; break; }
  return vm ? vm.commentFeeds.map((f, i) => ({ i, objectId: f.objectId, objectNonce: f.objectNonce, createTime: f.createTime, commentCount: f.commentCount, commentClose: f.commentClose,
    desc: { description: f.desc?.description ?? null, shortTitle: (f.desc?.shortTitle ?? []).map((s) => ({ shortTitle: s.shortTitle })) } })) : null;`;

// X2-B4：一个评论组件都没有、或有组件读不到 dataSource，返回 null（不和「零评论」的 [] 混在一起）
export const ITEMS_SRC = `const els = [...sr.querySelectorAll('.comment-item')]; const ds = els.map((e) => e.__vue__?.$props?.dataSource);
  if (!els.length || ds.some((d) => !d)) return null;
  return ds.map((c) => {
  const one = (c) => ({ commentId: c.commentId, commentNickname: c.commentNickname, commentContent: c.commentContent, commentCreatetime: c.commentCreatetime, commentLikeCount: c.commentLikeCount,
    replyCommentId: c.replyCommentId ?? null, downContinueFlag: c.downContinueFlag, visibleFlag: c.visibleFlag, readFlag: c.readFlag, likeFlag: c.likeFlag, username: c.username });
  return { ...one(c), levelTwoComment: (c.levelTwoComment || []).map(one) }; });`;

export const SESSIONS_SRC = `let v = null; for (let x = sr.querySelector('.session-wrap'), i = 0; x && i < 8 && !v; x = x.parentElement, i++) if (Array.isArray(x.__vue__?.$data?.sessionList)) v = x.__vue__;
    if (!v) for (const e of sr.querySelectorAll('*')) if (Array.isArray(e.__vue__?.$data?.sessionList)) { v = e.__vue__; break; }
    if (!v) return null;
    return v.$data.sessionList.map(([id, s]) => ({ sessionId: id, sessionType: s.sessionType ?? null, newMsgCount: s.newMsgCount ?? 0, sessionIsUnread: !!s.sessionIsUnread,
      sessionInfo: { sessionId: s.sessionInfo?.sessionId, username: s.sessionInfo?.username, nickname: s.sessionInfo?.nickname, fromUserType: s.sessionInfo?.fromUserType ?? null },
      messageList: (s.messageList ?? []).map((m) => ({ message: { msgId: m.message?.msgId ?? m.message?.newMsgId ?? null, fromUsername: m.message?.fromUsername, toUsername: m.message?.toUsername, ts: m.message?.ts, msgType: m.message?.msgType, textMsg: m.message?.textMsg ? { content: m.message.textMsg.content } : null } })) }));`;

/** 列表 → 原始数据里的 { [key], emptyState }：组件给了数组（含合法空数组）就用它，空数组即明确为空；组件读不到时只有页面显示「暂无…」才算空，否则 null（X2-B3）。 */
export function listState(key, list, emptyShownFlag) {
  if (Array.isArray(list)) return { [key]: list, emptyState: list.length === 0 };
  return emptyShownFlag ? { [key]: [], emptyState: true } : { [key]: null, emptyState: false, note: `${key} 组件读不到` };
}

async function pollList(page, src, ms) {
  let list = null;
  for (const end = Date.now() + ms; !Array.isArray(list) && Date.now() < end; await sleep(1000)) list = await inShadow(page, src);
  return list;
}

async function rawComments(page, o) {
  const sinceSec = o.now / 1000 - o.maxAgeDays * 86400;
  const windowStartSec = Math.floor(sinceSec);
  let feeds = await pollList(page, FEEDS_SRC, o.waitMs);
  if (!Array.isArray(feeds) || !feeds.length) return { windowStartSec, ...listState('feeds', feeds, await emptyShown(page)), works: [] };
  // 作品列表滚动懒加载：滚到最后一个，直到最早的早于窗口或不再变多
  for (let i = 0; i < 6 && feeds.length && Math.min(...feeds.map((f) => f.createTime)) >= sinceSec; i++) {
    await inShadow(page, `const l = [...sr.querySelectorAll('.comment-feed-wrap')].at(-1); l?.scrollIntoView({ block: 'end' }); return true;`);
    await sleep(2500);
    const next = (await inShadow(page, FEEDS_SRC)) ?? feeds;
    if (next.length <= feeds.length) break;
    feeds = next;
  }
  const pick = feeds.filter((f) => f.commentCount > 0 && f.createTime >= sinceSec).sort((p, q) => q.createTime - p.createTime).slice(0, o.maxWorks);
  let apiFallback = null;
  if (o.readVia === 'api') {
    const call = await serviceCaller(page, 'Channels', { waitMs: o.waitMs, gapMs: o.apiGapMs });
    if (call) return { via: 'api', windowStartSec, ...listState('feeds', feeds, false), works: await worksViaApi(call, pick, o) };
    apiFallback = '页面评论服务没找到，退回 DOM 路径';
  }
  const works = [];
  for (const f of pick) {
    const ok = await clickMarked(page, `() => document.querySelector('wujie-app').shadowRoot.querySelectorAll('.comment-feed-wrap')[${f.i}]`, 'open post comments');
    if (!ok) { works.push({ objectNonce: f.objectNonce, opened: false }); continue; }
    await sleep(4000);
    let clicks = 0;
    while (clicks < o.maxExpand && await clickMarked(page, `() => [...document.querySelector('wujie-app').shadowRoot.querySelectorAll('*')].find((e) => e.children.length === 0 && /^展开更多回复$/.test(e.textContent.trim()))`, 'expand more replies')) {
      clicks++; await sleep(2000);
    }
    const left = await inShadow(page, `return [...sr.querySelectorAll('*')].filter((e) => e.children.length === 0 && /^展开更多回复$/.test(e.textContent.trim()) && e.getBoundingClientRect().height > 0).length;`);
    works.push({ objectNonce: f.objectNonce, opened: true, clicks, expandLeft: left, items: await inShadow(page, ITEMS_SRC) });
  }
  return { via: 'dom', ...(apiFallback ? { apiFallback } : {}), windowStartSec, ...listState('feeds', feeds, false), works };
}

// 同 ITEMS_SRC 里的 one：接口给的评论对象和组件 dataSource 是同一份数据
export const slimApiComment = (c) => ({ commentId: c.commentId, commentNickname: c.commentNickname, commentContent: c.commentContent, commentCreatetime: c.commentCreatetime,
  commentLikeCount: c.commentLikeCount, replyCommentId: c.replyCommentId ?? null, downContinueFlag: c.downContinueFlag, visibleFlag: c.visibleFlag, readFlag: c.readFlag,
  likeFlag: c.likeFlag, username: c.username });
export const listArgs = (exportId, lastBuff, rootCommentId = null) => ({ lastBuff: lastBuff ?? '', exportId, ...(rootCommentId ? { rootCommentId } : {}), commentSelection: false, forMcn: false });
/** getCommentList 的返回 → data（errCode 为 0、comment 是数组才算），否则 null。 */
export const listData = (r) => (r?.ok && r.data?.errCode === 0 && Array.isArray(r.data?.data?.comment) ? r.data.data : null);

/**
 * 接口读评论（S9）。一楼最多 maxPages 页；楼中楼每个作品最多 maxExpand 次请求（同 DOM 路径「展开更多回复」的上限）。
 * 返回和 DOM 路径一样的 works：没读全的（一楼还有下一页、楼中楼预算用完或出错）记进 expandLeft，parse 判成楼中楼不全。
 */
export async function worksViaApi(call, feeds, o) {
  const works = [];
  for (const f of feeds) {
    const roots = [];
    let buf = '', topLeft = 0, error = null;
    for (let p = 0; ; p++) {
      const d = listData(await call('getCommentList', listArgs(f.objectId, buf)));
      if (!d) { error = '一楼列表接口没返回 errCode=0 的列表'; break; }
      // 翻页时有新评论插进来，同一条一楼可能跨页重复：按 commentId 去重
      for (const c of d.comment) if (!roots.some((x) => String(x.commentId) === String(c.commentId))) roots.push(c);
      if (pageEnd(d.downContinueFlag)) break;
      // 还有下一页但到上限、翻不动，或标志缺失：一楼没读全
      if (!pageMore(d.downContinueFlag) || p + 1 >= o.maxPages || !d.lastBuff || d.lastBuff === buf) { topLeft = 1; break; }
      buf = d.lastBuff;
    }
    if (error) { works.push({ objectNonce: f.objectNonce, opened: false, via: 'api', error }); continue; }
    let calls = 0, left = 0;
    for (const root of roots) {
      root.levelTwoComment = Array.isArray(root.levelTwoComment) ? [...root.levelTwoComment] : [];
      while (!pageEnd(root.downContinueFlag)) {
        if (!pageMore(root.downContinueFlag)) { left++; break; }   // 标志缺失或不认识：按没读全
        if (calls >= o.maxExpand) { left++; break; }
        calls++;
        const d = listData(await call('getCommentList', listArgs(f.objectId, root.lastBuff, root.commentId)));
        if (!d) { left++; break; }
        root.levelTwoComment.push(...d.comment);
        if (pageMore(d.downContinueFlag) && (!d.lastBuff || d.lastBuff === root.lastBuff)) { left++; break; }
        root.lastBuff = d.lastBuff; root.downContinueFlag = d.downContinueFlag;
      }
    }
    const items = roots.map((c) => ({ ...slimApiComment(c), levelTwoComment: c.levelTwoComment.map(slimApiComment) }));
    works.push({ objectNonce: f.objectNonce, opened: true, via: 'api', clicks: calls, expandLeft: left + topLeft, items });
  }
  return works;
}

async function rawDms(page, o) {
  // 会话列表先渲染出来再读（读到的是合法空数组也再等一会儿，避免刚加载时的空列表）
  await waitShadow(page, '.session-wrap', o.waitMs);
  await sleep(1500);
  const sessions = await pollList(page, SESSIONS_SRC, 5000);
  return listState('sessions', sessions, Array.isArray(sessions) ? false : await emptyShown(page));
}

// —— 解析 ——
export function parse(kind, raw, ctx) {
  if (!raw || raw.kind !== kind) throw new Error(`原始数据不是 ${kind}`);
  return kind === 'comments' ? parseComments(raw, ctx) : parseDms(raw, ctx);
}

const titleOf = (f) => f.desc?.shortTitle?.[0]?.shortTitle || String(f.desc?.description ?? '').split(/\s#/)[0].trim() || null;

// X-B5：必需的页面数据读不到（null），或为空但页面没显示空状态，整个 kind 失败
function requireList(list, emptyState, what, note) {
  if (!Array.isArray(list)) adapterFail('no-data', `${what}读不到${note ? `：${note}` : ''}`);
  if (!list.length && !emptyState) adapterFail('no-data', `${what}为空，但页面没显示空状态${note ? `：${note}` : ''}`);
}

export function parseComments(raw, { accountUid, nickname, fetchedAt }) {
  requireList(raw.feeds, raw.emptyState, '视频号作品列表', raw.note);
  // S9 接口读：要扫的作品一个都没读到一楼（接口全报错），整个 kind 失败，同步失败会告警；DOM 路径不变
  if (raw.via === 'api' && raw.works.length && !raw.works.some((w) => w.opened)) {
    adapterFail('no-data', `${raw.works.length} 个近期作品的评论接口都没读到：${[...new Set(raw.works.map((w) => w.error).filter(Boolean))].join('；') || '原因不明'}`);
  }
  const myNick = raw.me?.nickname ?? nickname ?? null;
  const feeds = new Map(raw.feeds.map((f) => [f.objectNonce, f]));
  const works = [], comments = [], scannedWorks = [];
  for (const w of raw.works) {
    const f = feeds.get(w.objectNonce);
    works.push({ nativeId: String(w.objectNonce), title: f ? titleOf(f) : null, url: null, postTime: isoOf(f?.createTime) });
    if (!w.opened || !Array.isArray(w.items)) { scannedWorks.push({ workNativeId: String(w.objectNonce), complete: false, threadsPartial: true }); continue; }
    // 嵌套的 levelTwoComment 和单独渲染的 .comment-item 合起来按 id 去重；replyCommentId 链往上走到没有 replyCommentId 的那条就是一楼
    const all = new Map();
    let more = w.expandLeft !== 0;   // 剩余「展开更多回复」读不到（null）也算没展开完
    for (const c of w.items) {
      if (Number(c.downContinueFlag) === 1) more = true;
      for (const x of [c, ...c.levelTwoComment.map((r) => ({ ...r, replyCommentId: r.replyCommentId || c.commentId }))]) {
        const prev = all.get(x.commentId);
        all.set(x.commentId, { ...prev, ...x, replyCommentId: x.replyCommentId || prev?.replyCommentId || null });
      }
    }
    const rootOf = (id) => { let x = all.get(id); for (let i = 0; x?.replyCommentId && all.has(x.replyCommentId) && i < 50; i++) x = all.get(x.replyCommentId); return String(x.commentId); };
    const thread = [...all.values()].map((c) => {
      const root = rootOf(c.commentId);
      const id = String(c.commentId);
      const to = str(c.replyCommentId);
      const parent = id === root ? null : to && all.has(to) ? to : root;
      const p = parent && parent !== root ? all.get(parent) : null;
      return { nativeId: id, workNativeId: String(w.objectNonce), parentNativeId: parent, rootNativeId: root,
        author: { uid: null, nickname: c.commentNickname ?? '', isMe: myNick != null && c.commentNickname === myNick },
        replyTo: p ? { uid: null, nickname: p.commentNickname ?? null } : null,
        text: c.commentContent ?? '', createdAt: isoOf(c.commentCreatetime), likeCount: numOrNull(c.commentLikeCount), likedByMe: c.likeFlag == null ? null : Number(c.likeFlag) === 1,
        pinned: null, replyCount: null, ipLabel: null };
    });
    for (const x of thread) if (x.parentNativeId === null) x.replyCount = thread.filter((y) => y.rootNativeId === x.nativeId && y !== x).length;
    comments.push(...thread);
    // G-B4c：commentCount 含二楼（S0 实测每个作品去重后的条数等于它）。不是数字不算拿全；读到的少于它算楼中楼拿不全
    const count = f?.commentCount;
    const known = typeof count === 'number' && Number.isFinite(count);
    const short = known && all.size < count;
    scannedWorks.push({ workNativeId: String(w.objectNonce), complete: known && !more && !short, threadsPartial: more || short });
  }
  // G-B11a：窗口内评论数为 0 的作品（列表本身读成功了）也算扫过、拿全，库里这个作品已删的评论才能标 goneAt
  const scannedIds = new Set(scannedWorks.map((x) => x.workNativeId));
  for (const f of raw.feeds) {
    const id = String(f.objectNonce);
    if (f.commentCount !== 0 || scannedIds.has(id) || raw.windowStartSec == null || !(Number(f.createTime) >= raw.windowStartSec)) continue;
    works.push({ nativeId: id, title: titleOf(f), url: null, postTime: isoOf(f.createTime) });
    scannedWorks.push({ workNativeId: id, complete: true, threadsPartial: false });
  }
  return okResult({ platformCode: 'Channels', accountUid, kind: 'comments', fetchedAt, works, comments, scannedWorks });
}

// msgType：1 文字、3 图片，其余按 other（分享卡片等没见到样本）
const TYPE = (t) => (Number(t) === 1 ? 'text' : Number(t) === 3 ? 'image' : 'other');

export function parseDms(raw, { accountUid, fetchedAt }) {
  requireList(raw.sessions, raw.emptyState, '视频号私信会话列表', raw.note);
  const conversations = [], messages = [];
  for (const s of raw.sessions) {
    const peer = s.sessionInfo?.username ?? null;
    const msgs = s.messageList.map((m) => m.message).filter((m) => m && m.ts != null).sort((p, q) => Number(q.ts) - Number(p.ts));
    const by = (m) => (m.fromUsername === peer ? 'peer' : 'me');
    const lm = msgs[0];
    const id = String(s.sessionId);
    conversations.push({ nativeId: id, peer: { uid: str(peer), nickname: s.sessionInfo?.nickname ?? null, kind: 'user' },
      unread: Number(s.newMsgCount) || (s.sessionIsUnread ? 1 : 0),
      last: lm ? { by: by(lm), at: isoOf(lm.ts), text: lm.textMsg ? clip(lm.textMsg.content) : null, type: TYPE(lm.msgType) } : null, canSend: true });
    for (const m of msgs) messages.push({ nativeId: String(m.msgId ?? `${id}:${m.ts}:${m.fromUsername === peer ? 'p' : 'm'}`), conversationNativeId: id, by: by(m), at: isoOf(m.ts), type: TYPE(m.msgType), text: m.textMsg ? clip(m.textMsg.content) : null });
  }
  return okResult({ platformCode: 'Channels', accountUid, kind: 'dms', fetchedAt, conversations, messages });
}
