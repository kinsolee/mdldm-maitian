// 抖音处置：删评论、拉黑。接口约定见 writers/index.mjs；都调页面自己的接口封装函数，签名（msToken、a_bogus、安全 SDK 的头）由页面加，Node 里不拼。
// 入口和参数只从页面代码里读来（2026-11-22 只读核对，没调过任何写接口）：
//   删评论 delete：评论管理页（creator.douyin.com，Garfish 子应用 interactive）的评论服务，同 S9 回复用的那个对象：
//        awemeV1CommentMultiDelete({ cids: 目标 cid, need_block: false })
//          → POST /aweme/janus/creator/comment/aweme/v1/web/comment/multi_delete/，返回 { status_code, delete_result: [{ cid, result }] }。
//        （页面「删除」按钮就这么调；need_block: true 是「删除并拉黑」，这里不用。）
//        发前用 awemeV1CommentListSelect / awemeV1CommentListReply 把目标所在的楼读全（同 S9 回复）：
//          楼不在了 → already-gone；没读全 → thread-incomplete；作者是我 → self-target；
//          一楼下面有回复 → deletes-thread（rejected，抖音删一楼会连楼下回复一起删）。
//        发后再把楼读一遍：楼读全了、目标不在了（一楼目标：一楼列表翻到底也没有它），才算 found。
//   拉黑 block：抖音网页版（www.douyin.com，和创作者后台同一个登录态）个人页模块里的两个函数：
//          拉黑：(uid, sec_uid, block_type, source) → POST /aweme/v1/web/user/block/，页面自己点「拉黑」时传 block_type=1（block）、source=0；
//               block_status=1 是已拉黑。
//          读对方：(sec_uid) → GET /aweme/v1/web/user/profile/other/，is_block 是我有没有拉黑他（is_blocked 是他有没有拉黑我）。
//          读自己：fetchUserProfileSelf() → GET /aweme/v1/web/user/profile/self/，user.uid 核对登录的是不是这个账号。
//        返回的字段名（2026-11-22 只读核对：self、other 实测，block 读的源码，没调过拉黑）：
//          self、other：找到的函数把返回过一遍驼峰转换，实测是 { statusCode, statusMsg, logPb, user: { uid, secUid, isBlock, isBlocked, ... } }。
//          block：走 POST 封装 v_，不转驼峰，返回 { log_pb, ...接口原样 { status_code, status_msg, block_status }, isVerifyPassportError, logId }。
//          拉黑所在的模块里还有一个不转驼峰的 profile/other 函数，找到哪个取决于模块顺序。所以下划线、驼峰两种都认（fieldOf），都读不到就拒绝。
//        模块 id 每次发版会变，按源码里的接口路径找函数（同 ../inpage-api.mjs 的找法）。
//        对方的 sec_uid 库里没有：从来源评论（评论接口的 user.sec_uid）或来源会话（私信页会话对象的 secUid）重读出来，
//        重读出来的 uid 要等于要拉黑的 uid。发前 profile/other 重读（is_block 已是 true → already-blocked），
//        拉黑只调一次，等 1.5 秒再读 profile/other，is_block 是 true 才算 found。
//   删会话：不做，原因见 moderate.mjs 的 MOD_UNSUPPORTED。
// 目标是登录账号自己一律不动手（self-target）。调了写接口之后出任何错都只回读、不重调，返回 sendAttempted: true。
import { mainPage, open, sleep as realSleep } from '../adapters/page-lib.mjs';
import { callInPage, countOf, locateService, pageEnd, SERVICES } from '../inpage-api.mjs';
import { replyArgs } from '../adapters/douyin.mjs';
import { redact } from '../redact.mjs';
import { douyinThread } from './api-reply.mjs';

export const FILE = 'douyin-moderate.mjs';
export const PAGES = {
  comments: 'https://creator.douyin.com/creator-micro/interactive/comment',
  dms: 'https://creator.douyin.com/creator-micro/data/following/chat',
  web: 'https://www.douyin.com/',
};
const BLOCK_TYPE = 1;      // 页面里的枚举 { block: 1, unblock: 0 }
const BLOCK_SOURCE = 0;    // 页面里的枚举 { block: 0, allowOtherSee: 1, unSeeOther: 2 }
const BLOCKED_STATUS = 1;
// www.douyin.com 里按接口路径找的三个函数
export const WEB_FNS = { block: '/aweme/v1/web/user/block/', other: '/aweme/v1/web/user/profile/other/', self: '/aweme/v1/web/user/profile/self/' };

// 错误消息是空的（throw ''、new Error('')、{ message: '' }）也要返回非空串：调用方拿它当「出过错」的标志
const errText = (e) => redact(String(e?.message ?? e)).slice(0, 300) || '未知错误';
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const isSelf = (uid, me, p) => uid === me || uid === String(p.uid) || (p.selfUids ?? []).includes(uid);
const stop = (me, blocked, detail, extra = {}) => ({ uidSeen: me ?? null, blocked, detail: redact(detail), sendAttempted: false, ...extra });

// —— 删评论 ——

/** 楼里找目标：{ node } / { gone } / { blocked, detail }。th 是 douyinThread 的结果。 */
function locate(th, t) {
  const target = String(t.commentId), rootId = String(t.rootId ?? t.commentId);
  if (th.error) return { blocked: 'precheck-error', detail: th.error };
  if (!th.root) return th.end ? { gone: true, detail: `一楼列表翻到底了也没有楼 ${rootId}` } : { blocked: 'target-not-found', detail: `一楼翻到上限还没找到楼 ${rootId}` };
  if (target === rootId) return { node: th.root };
  if (!th.complete || countOf(th.root.reply_comment_total) == null) return { blocked: 'thread-incomplete', detail: `楼 ${rootId} 的回复没读全（读到 ${th.replies.length} 条，楼里有 ${th.root.reply_comment_total ?? '未知'} 条），删了也确认不了，没删` };
  const node = th.replies.find((c) => String(c.cid) === target);
  if (!node) return { gone: true, detail: `楼 ${rootId} 读全了，里面已没有 ${target}` };
  // 楼中楼接口给的这条要挂在这栋楼下，否则不认（防止返回数据挂错楼，删到别的楼里去）
  if (String(node.reply_id ?? '') !== rootId) return { blocked: 'target-not-found', detail: `${target} 的 reply_id 是 ${node.reply_id ?? '（没给）'}，不是楼 ${rootId}` };
  return { node };
}

export async function deleteComment(api, p) {
  const t = p.target ?? {};
  const target = String(t.commentId ?? ''), rootId = String(t.rootId ?? t.commentId ?? ''), awemeId = String(t.workId ?? '');
  let me;
  try {
    const who = await api.whoAmI();
    if (who.done) return who.done;
    me = who.uid;
    if (!/^\d+$/.test(target) || !/^\d+$/.test(rootId) || !/^\d+$/.test(awemeId)) return stop(me, 'target-not-found', `评论 id、楼 id 或作品 id 不对：${target} / ${rootId} / ${awemeId}`);
    if (!(await api.hasMethod('awemeV1CommentMultiDelete'))) return stop(me, 'cannot-send', '页面评论服务里没有 awemeV1CommentMultiDelete（页面可能改版了），没删');
    const th = await douyinThread(api.call, { awemeId, rootId });
    const at = locate(th, t);
    if (at.gone) return stop(me, 'already-gone', at.detail);
    if (at.blocked) return stop(me, at.blocked, at.detail);
    const node = at.node;
    if (String(node.aweme_id ?? '') !== awemeId) return stop(me, 'target-not-found', `评论 ${target} 属于作品 ${node.aweme_id ?? '（没给）'}，不是 ${awemeId}，没删`);
    const author = node.user?.uid == null ? '' : String(node.user.uid);
    if (!author) return stop(me, 'precheck-error', '读不到这条评论的作者');
    if (isSelf(author, me, p)) return stop(me, 'self-target', '这条是我自己的评论，不删');
    if (target === rootId) {
      // 删一楼会连楼下回复一起删：下面有回复（不管是谁的）就不删；条数读不到也不删
      const total = countOf(node.reply_comment_total);
      if (total == null) return stop(me, 'thread-incomplete', '一楼的 reply_comment_total 读不到或不是非负整数，判断不了下面有没有回复，没删');
      // 总数是 0 也再读一次楼中楼第一页：总数和实际对不上时宁可不删
      const first = await api.call('awemeV1CommentListReply', replyArgs(rootId, 0));
      const fj = first.ok ? first.data : null;
      if (!fj || fj.status_code !== 0 || !Array.isArray(fj.comments)) return stop(me, 'thread-incomplete', `读一楼下面的回复失败（${first.ok ? `status_code=${fj?.status_code ?? '无'}` : first.error}），判断不了有没有回复，没删`);
      if (!fj.comments.length && !pageEnd(fj.has_more)) return stop(me, 'thread-incomplete', `一楼下面的回复第一页是空的，但 has_more=${fj.has_more ?? '缺失'}，判断不了有没有回复，没删`);
      const n = Math.max(total, th.replies?.length ?? 0, fj.comments.length);
      if (n > 0) return stop(me, 'deletes-thread', `${target} 是一楼，下面有 ${n} 条回复；抖音删一楼会把楼下回复一起删掉，不删`, { rejected: true });
    }
  } catch (e) {
    return stop(me, 'precheck-error', errText(e));
  }

  // 从这里起算调过接口：之后出任何错都只回读，不重调
  // acked：接口明确说这一条删掉了（status_code=0，delete_result 里恰好有这条且 result 是 true / 1）。没这个证据，回读看到不在也不算 found
  //（可能是别人或平台同时删的），交给框架记 needs_readback
  let sendError = null, postError = null, unacked = null;
  try {
    const r = await api.call('awemeV1CommentMultiDelete', { cids: target, need_block: false });
    const d = r.ok ? r.data : null;
    if (!r.ok) postError = r.error || '未知错误';
    else if (d?.status_code !== 0) sendError = `multi_delete status_code=${d?.status_code ?? '无'} ${d?.status_msg ?? ''}`.trim();
    else {
      const hits = Array.isArray(d.delete_result) ? d.delete_result.filter((x) => String(x?.cid) === target) : [];
      if (hits.length === 1 && (hits[0].result === false || hits[0].result === 0)) sendError = `multi_delete 说 ${target} 没删掉`;
      else if (hits.length !== 1 || !(hits[0].result === true || hits[0].result === 1)) unacked = `multi_delete 返回 status_code=0，但 delete_result 里没有明确说 ${target} 删掉了（${hits.length} 条，result=${hits[0]?.result ?? '无'}）`;
    }
  } catch (e) { postError = errText(e); }
  let readBack;
  try {
    await api.sleep(2000);
    const at = locate(await douyinThread(api.call, { awemeId, rootId }), t);
    const gone = !!at.gone && !sendError && !postError && !unacked;
    readBack = { found: gone, count: gone ? 1 : 0, nativeId: target,
      detail: [at.gone ? (sendError ? null : at.detail) : at.node ? '回读时这条还在' : at.detail, unacked, postError ? `multi_delete 出错：${postError}` : null].filter(Boolean).join('；') || undefined };
  } catch (e) { readBack = { found: false, count: 0, nativeId: target, detail: `回读出错：${errText(e)}` }; }
  return { uidSeen: me, sendAttempted: true, ...(sendError ? { sendError: redact(sendError) } : {}), readBack: clean({ ...readBack, detail: readBack.detail && redact(readBack.detail) }) };
}

// —— 拉黑 ——

/** 从来源评论或来源会话重读出对方的 sec_uid：{ secUid } 或 { blocked, detail }。 */
async function secUidOf(api, p, mid) {
  const s = p.target?.source;
  if (s?.kind === 'comment') {
    const th = await douyinThread(api.call, { awemeId: String(s.workId), rootId: String(s.rootId ?? s.commentId) });
    const at = locate(th, { commentId: s.commentId, rootId: s.rootId ?? s.commentId });
    if (at.gone) return { blocked: 'target-not-found', detail: `来源评论 ${s.commentId} 已不在，读不到对方的 sec_uid，没拉黑（换一条这个人的评论或会话再试）` };
    if (at.blocked) return { blocked: at.blocked === 'thread-incomplete' ? 'target-not-found' : at.blocked, detail: `来源评论 ${s.commentId}：${at.detail}` };
    const u = at.node.user ?? {};
    if (String(u.uid ?? '') !== mid) return { blocked: 'target-not-found', detail: `来源评论 ${s.commentId} 的作者是 ${u.uid ?? '（读不到）'}，不是要拉黑的 ${mid}` };
    return u.sec_uid ? { secUid: String(u.sec_uid) } : { blocked: 'target-not-found', detail: `来源评论 ${s.commentId} 的作者没带 sec_uid` };
  }
  if (s?.kind === 'conversation') {
    const c = await api.conversation(String(s.conversationId));
    if (!c) return { blocked: 'target-not-found', detail: `私信列表里没有会话 ${s.conversationId}（列表只显示最近的会话），读不到对方的 sec_uid` };
    if (c.group) return { blocked: 'not-a-user', detail: `${s.conversationId} 是群聊，不拉黑` };
    if (String(c.peer ?? '') !== mid) return { blocked: 'target-not-found', detail: `会话 ${s.conversationId} 的对方是 ${c.peer ?? '（读不到）'}，不是要拉黑的 ${mid}` };
    return c.secUid ? { secUid: String(c.secUid) } : { blocked: 'target-not-found', detail: `会话 ${s.conversationId} 没带对方的 sec_uid` };
  }
  return { blocked: 'target-not-found', detail: `库里没有 ${mid} 的评论或会话，读不到对方的 sec_uid，没拉黑` };
}

/** 网页版函数的返回字段，下划线、驼峰两种写法都认（见文件头）。两种键都在、值不一样（包括一边是 null）就当读不到，交给调用方拒绝。 */
function fieldOf(o, snake) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
  const camel = snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const hs = Object.hasOwn(o, snake), hc = Object.hasOwn(o, camel);
  if (hs && hc) return Object.is(o[snake], o[camel]) ? o[snake] : undefined;
  return hs ? o[snake] : o[camel];
}

/** profile/other 的 is_block：{ isBlock, uid } 或 { error }。 */
async function relation(web, secUid) {
  const d = await web.other(secUid);
  const u = d?.user, code = fieldOf(d, 'status_code'), isBlock = fieldOf(u, 'is_block');
  if (code !== 0 || !u || typeof isBlock !== 'boolean') return { error: `profile/other status_code=${code ?? '无'}${u && typeof isBlock !== 'boolean' ? '，user.is_block / isBlock 不是布尔值' : ''}` };
  return { isBlock, uid: u.uid == null ? '' : String(u.uid) };
}

export async function block(api, p) {
  const mid = String(p.target?.mid ?? '');
  let me, web, secUid;
  try {
    const who = await api.whoAmI();
    if (who.done) return who.done;
    me = who.uid;
    if (!/^\d+$/.test(mid)) return stop(me, 'target-not-found', `拉黑对象的 uid 不对：${mid}`);
    if (isSelf(mid, me, p)) return stop(me, 'self-target', '对象是我自己，不拉黑');
    const sec = await secUidOf(api, p, mid);
    if (sec.blocked) return stop(me, sec.blocked, sec.detail);
    secUid = sec.secUid;
    web = await api.web();
    if (web.done) return { ...web.done, uidSeen: web.done.uidSeen ?? me };
    // 网页版登录的也得是这个账号
    const self = await web.self();
    const webUid = self?.user?.uid == null ? null : String(self.user.uid);
    const selfCode = fieldOf(self, 'status_code');
    if (selfCode !== 0 || !webUid) return stop(me, 'precheck-error', `抖音网页版读不到当前登录账号（profile/self status_code=${selfCode ?? '无'}）`);
    if (webUid !== me) return stop(webUid, 'uid-mismatch', `抖音网页版登录的是 ${webUid}，不是 ${me}`);
    const rel = await relation(web, secUid);
    if (rel.error) return stop(me, 'precheck-error', rel.error);
    if (rel.uid !== mid) return stop(me, 'target-not-found', `sec_uid 对应的是 ${rel.uid || '（读不到）'}，不是要拉黑的 ${mid}，没拉黑`);
    if (rel.isBlock) return stop(me, 'already-blocked', `${mid} 已在黑名单里`);
  } catch (e) {
    return stop(me, 'precheck-error', errText(e));
  }

  let sendError = null, postError = null;
  try {
    const r = await web.block(mid, secUid);
    const code = fieldOf(r, 'status_code'), status = fieldOf(r, 'block_status');
    if (code !== 0) sendError = `user/block status_code=${code ?? '无'} ${fieldOf(r, 'status_msg') ?? ''}`.trim();
    else if (status !== BLOCKED_STATUS) sendError = `user/block 返回 block_status=${status ?? '无'}，不是 ${BLOCKED_STATUS}`;
  } catch (e) { postError = errText(e); }
  let readBack;
  try {
    await api.sleep(1500);
    const rel = await relation(web, secUid);
    // 拉黑调用抛错（没拿到 status_code=0）时，回读看到已拉黑也不算：可能是别的操作同时拉黑的，交给框架记 needs_readback
    const ok = !rel.error && rel.uid === mid && rel.isBlock === true && !sendError && !postError;
    readBack = { found: ok, count: ok ? 1 : 0, nativeId: mid,
      detail: [rel.error ?? (rel.isBlock ? null : '回读 is_block 还是 false'), postError ? `user/block 出错：${postError}` : null].filter(Boolean).join('；') || undefined };
  } catch (e) { readBack = { found: false, count: 0, nativeId: mid, detail: `回读出错：${errText(e)}` }; }
  return { uidSeen: me, sendAttempted: true, ...(sendError ? { sendError: redact(sendError) } : {}), readBack: clean({ ...readBack, detail: readBack.detail && redact(readBack.detail) }) };
}

const OPS = { delete: deleteComment, block };

// —— 页面 ——

/** www.douyin.com 里按接口路径找函数，挂到 window.__engDyWeb。导出给测试在假 window 上跑。 */
export function locateWebFns(paths) {
  if (window.__engDyWeb) return Object.keys(window.__engDyWeb).length === Object.keys(paths).length;
  const chunk = window.webpackChunkdouyin_web;
  try { if (!chunk || typeof chunk.push !== 'function' || chunk.push === Object.getPrototypeOf(chunk)?.push) return false; } catch { return false; }
  let req = null;
  try { chunk.push([[`__eng_${Date.now()}_${Math.random()}`], {}, (r) => { req = r; }]); } catch { return false; }
  if (!req?.m) return false;
  const found = {};
  for (const id of Object.keys(req.m)) {
    let src = ''; try { src = String(req.m[id]); } catch { continue; }
    const want = Object.entries(paths).filter(([k, path]) => !found[k] && src.includes(`"${path}"`));
    if (!want.length) continue;
    let mod = null; try { mod = req(id); } catch { continue; }
    for (const [k, path] of want) {
      const fns = Object.values(mod ?? {}).filter((v) => typeof v === 'function' && String(v).includes(`"${path}"`));
      if (fns.length === 1) found[k] = fns[0];
    }
  }
  if (Object.keys(found).length !== Object.keys(paths).length) return false;
  window.__engDyWeb = found;
  return true;
}

/** 在页面里调 window.__engDyWeb 上的函数，结果走 JSON 往返；抛错按 { __error } 返回。 */
export async function callWeb({ name, args }) {
  try { return JSON.parse(JSON.stringify((await window.__engDyWeb[name](...args)) ?? null)); }
  catch (e) { return { __error: String(e?.message ?? e).slice(0, 300) }; }
}

const unwrap = (r) => { if (r && typeof r === 'object' && '__error' in r) throw new Error(r.__error); return r; };

// 私信页会话对象：li.semi-list-item 的 fiber 往上 2 层 memoizedProps.item（同 writers/douyin.mjs）；secUid 是对方的（2026-11-22 只读核对：和自己的不同）
const CONV_SRC = (id) => `(() => { for (const li of document.querySelectorAll('li.semi-list-item')) {
  const k = Object.keys(li).find((k) => k.startsWith('__reactFiber')); let f = k && li[k]; for (let j = 0; j < 2 && f; j++) f = f.return;
  const it = f?.memoizedProps?.item; if (!it || String(it.id) !== ${JSON.stringify(id)}) continue;
  return { peer: it.toParticipantUserId != null ? String(it.toParticipantUserId) : null, secUid: it.secUid ?? null, group: !!(it.isGroupChat ?? it.type === 2) };
} return null; })()`;

export async function runInSpace(task, params) {
  const run = OPS[params.op];
  if (!run) return { uidSeen: null, blocked: 'precheck-error', detail: `douyin-moderate 不认识 op ${params.op}`, sendAttempted: false };
  let page;
  const at = { url: null };
  const go = async (url) => { if (at.url !== url) { await open(page, url); at.url = url; await realSleep(3000); } };
  try {
    page = await mainPage(task);
    const src = params.target?.source;
    await go(params.op === 'block' && src?.kind === 'conversation' ? params.urls?.dms ?? PAGES.dms : params.urls?.comments ?? PAGES.comments);
  } catch (e) {
    return { uidSeen: null, blocked: 'precheck-error', detail: errText(e), sendAttempted: false };
  }
  const waitFor = async (fn, ms, step = 1500) => { for (const end = Date.now() + ms; ; await realSleep(step)) { const v = await fn().catch(() => null); if (v || Date.now() >= end) return v; } };
  let svcReady = false;
  const svc = async () => {
    if (!svcReady) { await go(params.urls?.comments ?? PAGES.comments); svcReady = !!(await waitFor(() => page.evaluate(locateService, { platform: 'Douyin', ...SERVICES.Douyin }), 60000)); }
    return svcReady;
  };
  let last = 0;
  const api = {
    sleep: realSleep,
    async whoAmI() {
      const r = await page.fetch('/web/api/media/user/info/', { timeout: 15000 }).catch(() => null);
      let info = null; try { info = JSON.parse(String(r?.body ?? '')); } catch {}
      if (info?.status_code === 8) return { done: { uidSeen: null, loginLost: true, evidence: 'GET /web/api/media/user/info/ status_code=8', sendAttempted: false } };
      const uid = info?.status_code === 0 && info?.user?.uid != null ? String(info.user.uid) : null;
      if (!uid) return { done: { uidSeen: null, blocked: 'no-uid', detail: `GET /web/api/media/user/info/ ${info ? `status_code=${info.status_code}` : '请求失败或不是 JSON'}`, sendAttempted: false } };
      if (uid !== String(params.uid)) return { done: { uidSeen: uid, blocked: 'uid-mismatch', detail: `登记的是 ${params.uid}，页面上登录的是 ${uid}`, sendAttempted: false } };
      return { uid };
    },
    async hasMethod(name) { return (await svc()) && page.evaluate((n) => typeof window.__engSvc?.Douyin?.[n] === 'function', name); },
    async call(method, args) {
      if (!(await svc())) return { ok: false, error: '页面评论服务没找到（页面可能改版了）' };
      const wait = last + 800 - Date.now();
      if (wait > 0) await realSleep(wait);
      try { return await page.evaluate(callInPage, { platform: 'Douyin', method, args }); }
      catch (e) { return { ok: false, error: errText(e) }; }
      finally { last = Date.now(); }
    },
    async conversation(id) {
      await go(params.urls?.dms ?? PAGES.dms);
      await waitFor(() => page.evaluate(() => document.querySelectorAll('li.semi-list-item').length > 0), 30000);
      return page.evaluate(CONV_SRC(id));
    },
    async web() {
      await go(params.urls?.web ?? PAGES.web);
      svcReady = false;
      const ok = await waitFor(() => page.evaluate(locateWebFns, WEB_FNS), 60000);
      if (!ok) return { done: { uidSeen: null, blocked: 'cannot-send', detail: '抖音网页版里没找到拉黑、读用户的页面函数（页面可能改版了），没拉黑', sendAttempted: false } };
      const call = async (name, args) => unwrap(await page.evaluate(callWeb, { name, args }));
      return {
        self: () => call('self', []),
        other: (sec) => call('other', [sec]),
        block: (uid, sec) => call('block', [uid, sec, BLOCK_TYPE, BLOCK_SOURCE]),
      };
    },
  };
  return run(api, params);
}

