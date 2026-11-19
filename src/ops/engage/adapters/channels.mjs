// 视频号评论、私信。业务页面在 wujie 微前端的 shadowRoot 里，请求从沙箱 iframe 发，外层挂钩抓不到，所以读 Vue 2 组件数据。
//   评论：/platform/interaction/comment。左侧作品列表组件的 commentFeeds（objectNonce、createTime、commentCount），
//        挑近 maxAgeDays 天、评论数 >0 的作品（最多 maxWorks 个，新的优先）逐个点开（会把评论标已读，允许），
//        点「展开更多回复」（只读展开）后读 .comment-item 的 __vue__.$props.dataSource。
//        二楼在 levelTwoComment[] 里，同时也会单独渲染成一个 .comment-item，按 id 去重。
//        replyCommentId 指向谁就挂谁，没有就挂一楼。平台不给评论者 uid，isMe 按昵称等于 finderUser.nickname。
//   私信：/platform/private_msg，.session-wrap 往上的 Vue 实例 $data.sessionList；messageList 新到旧、只带最近 2 条，
//        取 ts 最大的判 last.by（fromUsername == sessionInfo.username 是对方）。
// 不点 .like-action、不点回复图标、不往任何输入框里写字。
import { open, atLogin, clickMarked, mainPage, sleep } from './page-lib.mjs';
import { clip, isoOf, numOrNull, okResult, str } from './shape.mjs';

export const FILE = 'channels.mjs';
export const LIMITS = { maxWorks: 10, maxAgeDays: 30, maxExpand: 15, waitMs: 20000 };
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
  if (login || (a && a.errCode !== 0)) return { loginLost: true, evidence: `auth/auth_data errCode=${a?.errCode}；${login ? `页面在 ${login}` : '页面没跳登录'}` };
  const me = { nickname: a?.data?.finderUser?.nickname ?? null };
  return params.kind === 'dms' ? { kind: 'dms', me, ...(await rawDms(page, o)) } : { kind: 'comments', me, ...(await rawComments(page, o)) };
}

const inShadow = (page, fnSrc, arg) => page.evaluate(new Function('arg', `const sr = document.querySelector('wujie-app')?.shadowRoot; if (!sr) return null; ${fnSrc}`), arg ?? null);

async function waitShadow(page, sel, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(1000)) if (await inShadow(page, `return !!sr.querySelector(${JSON.stringify(sel)});`)) return true;
  return false;
}

const FEEDS_SRC = `let x = sr.querySelector('.comment-feed-wrap'); let vm = null;
  for (let i = 0; x && i < 8 && !vm; x = x.parentElement, i++) if (Array.isArray(x.__vue__?.commentFeeds)) vm = x.__vue__;
  return vm ? vm.commentFeeds.map((f, i) => ({ i, objectId: f.objectId, objectNonce: f.objectNonce, createTime: f.createTime, commentCount: f.commentCount, commentClose: f.commentClose,
    desc: { description: f.desc?.description ?? null, shortTitle: (f.desc?.shortTitle ?? []).map((s) => ({ shortTitle: s.shortTitle })) } })) : null;`;

const ITEMS_SRC = `return [...sr.querySelectorAll('.comment-item')].map((e) => e.__vue__?.$props?.dataSource).filter(Boolean).map((c) => {
  const one = (c) => ({ commentId: c.commentId, commentNickname: c.commentNickname, commentContent: c.commentContent, commentCreatetime: c.commentCreatetime, commentLikeCount: c.commentLikeCount,
    replyCommentId: c.replyCommentId ?? null, downContinueFlag: c.downContinueFlag, visibleFlag: c.visibleFlag, readFlag: c.readFlag, likeFlag: c.likeFlag, username: c.username });
  return { ...one(c), levelTwoComment: (c.levelTwoComment || []).map(one) }; });`;

async function rawComments(page, o) {
  if (!(await waitShadow(page, '.comment-feed-wrap', o.waitMs))) return { feeds: [], works: [], note: '作品列表没出来' };
  const sinceSec = o.now / 1000 - o.maxAgeDays * 86400;
  // 作品列表滚动懒加载：滚到最后一个，直到最早的早于窗口或不再变多
  let feeds = (await inShadow(page, FEEDS_SRC)) ?? [];
  for (let i = 0; i < 6 && feeds.length && Math.min(...feeds.map((f) => f.createTime)) >= sinceSec; i++) {
    await inShadow(page, `const l = [...sr.querySelectorAll('.comment-feed-wrap')].at(-1); l?.scrollIntoView({ block: 'end' }); return true;`);
    await sleep(2500);
    const next = (await inShadow(page, FEEDS_SRC)) ?? [];
    if (next.length <= feeds.length) break;
    feeds = next;
  }
  const pick = feeds.filter((f) => f.commentCount > 0 && f.createTime >= sinceSec).sort((p, q) => q.createTime - p.createTime).slice(0, o.maxWorks);
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
    works.push({ objectNonce: f.objectNonce, opened: true, clicks, expandLeft: left ?? 0, items: (await inShadow(page, ITEMS_SRC)) ?? [] });
  }
  return { feeds, works };
}

async function rawDms(page, o) {
  if (!(await waitShadow(page, '.session-wrap', o.waitMs))) return { sessions: [], note: '会话列表没出来' };
  await sleep(1500);
  const sessions = await inShadow(page, `let v = null; for (let x = sr.querySelector('.session-wrap'), i = 0; x && i < 8 && !v; x = x.parentElement, i++) if (x.__vue__?.$data?.sessionList) v = x.__vue__;
    if (!v) return null;
    return v.$data.sessionList.map(([id, s]) => ({ sessionId: id, sessionType: s.sessionType ?? null, newMsgCount: s.newMsgCount ?? 0, sessionIsUnread: !!s.sessionIsUnread,
      sessionInfo: { sessionId: s.sessionInfo?.sessionId, username: s.sessionInfo?.username, nickname: s.sessionInfo?.nickname, fromUserType: s.sessionInfo?.fromUserType ?? null },
      messageList: (s.messageList ?? []).map((m) => ({ message: { msgId: m.message?.msgId ?? m.message?.newMsgId ?? null, fromUsername: m.message?.fromUsername, toUsername: m.message?.toUsername, ts: m.message?.ts, msgType: m.message?.msgType, textMsg: m.message?.textMsg ? { content: m.message.textMsg.content } : null } })) }));`);
  return { sessions: sessions ?? [] };
}

// —— 解析 ——
export function parse(kind, raw, ctx) {
  if (!raw || raw.kind !== kind) throw new Error(`原始数据不是 ${kind}`);
  return kind === 'comments' ? parseComments(raw, ctx) : parseDms(raw, ctx);
}

const titleOf = (f) => f.desc?.shortTitle?.[0]?.shortTitle || String(f.desc?.description ?? '').split(/\s#/)[0].trim() || null;

export function parseComments(raw, { accountUid, nickname, fetchedAt }) {
  const myNick = raw.me?.nickname ?? nickname ?? null;
  const feeds = new Map(raw.feeds.map((f) => [f.objectNonce, f]));
  const works = [], comments = [], scannedWorks = [];
  for (const w of raw.works) {
    const f = feeds.get(w.objectNonce);
    works.push({ nativeId: String(w.objectNonce), title: f ? titleOf(f) : null, url: null, postTime: isoOf(f?.createTime) });
    if (!w.opened) { scannedWorks.push({ workNativeId: String(w.objectNonce), complete: false, threadsPartial: true }); continue; }
    // 嵌套的 levelTwoComment 和单独渲染的 .comment-item 合起来按 id 去重；replyCommentId 链往上走到没有 replyCommentId 的那条就是一楼
    const all = new Map();
    let more = w.expandLeft > 0;
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
    const seen = all;
    const f2 = feeds.get(w.objectNonce);
    scannedWorks.push({ workNativeId: String(w.objectNonce), complete: !more && seen.size >= (f2?.commentCount ?? 0), threadsPartial: more });
  }
  return okResult({ platformCode: 'Channels', accountUid, kind: 'comments', fetchedAt, works, comments, scannedWorks });
}

// msgType：1 文字、3 图片，其余按 other（分享卡片等没见到样本）
const TYPE = (t) => (Number(t) === 1 ? 'text' : Number(t) === 3 ? 'image' : 'other');

export function parseDms(raw, { accountUid, fetchedAt }) {
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
