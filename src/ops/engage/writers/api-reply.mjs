// S9：回复评论走页面内接口（账号能力位 writeViaApi 打开时 params.writeVia = 'api'；私信不走这里，照旧用页面写法）。
// 调的是页面自己的接口封装函数（见 ../inpage-api.mjs），签名、鉴权头、风控 SDK 由页面自己加。接口路径和参数只从页面代码里读来，
// 没有为了抓写请求点过发送（docs/migration/S9-in-page-api.md）。
//   抖音：awemeV1CommentMultiPublish({ aweme_id, text, reply_to_comment_ids: 目标 cid, channel_id: 618 })
//        → POST /aweme/janus/creator/comment/aweme/v1/web/comment/multi_publish/，成功是 status_code=0 且 comments 只有 1 条、code=0、带 comment.cid。
//        （评论管理页自己点「回复」时就是这么调的。）重读、回读用 awemeV1CommentListSelect / awemeV1CommentListReply。
//   视频号：createComment({ replyCommentId: 目标, content, clientId, rootCommentId: 所在一楼, comment: 目标评论对象, exportId: 作品 objectId })
//        → comment/create_comment，成功是 errCode=0 且带 data.comment.commentId、没有 data.baseResp.errcode（-4300 是要验证手机）。
//        重读、回读用 getCommentList（楼中楼带 rootCommentId 和一楼的 lastBuff）。
// 护栏同页面写法：先核对登录账号；发前用读接口拉整楼（读不全按 thread-incomplete 不发）；发送接口只调一次、绝不重试；
// 返回不是上面写的成功形状，一律不当成功也不当失败（不设 sendError），交给框架记 needs_readback；发后回读要恰好 1 条新的、我发的、正文一样，
// 并且就是发送接口返回的那条 id，才算回读到。调了发送之后出任何错都返回 sendAttempted: true。
import { randomUUID } from 'node:crypto';
import { atLogin, installHook, mainPage, open, sleep as realSleep } from '../adapters/page-lib.mjs';
import { selectArgs, replyArgs } from '../adapters/douyin.mjs';
import { FEEDS_SRC, listArgs, listData } from '../adapters/channels.mjs';
import { serviceCaller } from '../inpage-api.mjs';
import { redact } from '../redact.mjs';
import { DEFAULT_TIMEOUTS, norm, waitFor } from './page-write-lib.mjs';

export const API_LIMITS = { Douyin: { maxCommentPages: 30, maxExpand: 25 }, Channels: { maxPages: 10, maxExpand: 15 } };
const more = (j) => j?.has_more === 1 || j?.has_more === true;
const isRootTarget = (v) => v == null || v === '' || String(v) === '0';

// —— 抖音 ——

/** 一楼里找 rootId，再把这栋楼的楼中楼读全。返回 { root, replies, complete, end, error }。 */
export async function douyinThread(call, { awemeId, rootId }, lim = API_LIMITS.Douyin) {
  let root = null, end = false, cursor = 0;
  for (let p = 0; p < lim.maxCommentPages && !root; p++) {
    const r = await call('awemeV1CommentListSelect', selectArgs(awemeId, cursor));
    const j = r.ok ? r.data : null;
    if (!j || j.status_code !== 0 || !Array.isArray(j.comments)) return { error: `一楼列表读失败：${r.ok ? `status_code=${j?.status_code}` : r.error}` };
    root = j.comments.find((c) => String(c.cid) === rootId) ?? null;
    if (root) break;
    if (!more(j) || j.cursor == null || j.cursor === cursor) { end = true; break; }
    cursor = j.cursor;
  }
  if (!root) return { root: null, end };
  const replies = [];
  let complete = Number(root.reply_comment_total) === 0;
  for (let calls = 0, cur = 0; !complete && calls < lim.maxExpand; calls++) {
    const r = await call('awemeV1CommentListReply', replyArgs(rootId, cur));
    const j = r.ok ? r.data : null;
    if (!j || j.status_code !== 0 || !Array.isArray(j.comments)) return { error: `楼中楼读失败：${r.ok ? `status_code=${j?.status_code}` : r.error}` };
    replies.push(...j.comments);
    if (!more(j)) complete = true;
    else if (j.cursor == null || j.cursor === cur) break;
    else cur = j.cursor;
  }
  const total = Number(root.reply_comment_total);
  if (!Number.isFinite(total) || replies.length < total) complete = false;
  return { root, replies, complete, end: false };
}

export const douyinApi = {
  platform: 'Douyin',
  async precheck({ call, params, me }) {
    const t = params.target ?? {};
    const target = String(t.commentId), rootId = String(t.rootId ?? t.commentId), awemeId = String(t.workId);
    const th = await douyinThread(call, { awemeId, rootId });
    if (th.error) return { blocked: 'precheck-error', detail: th.error };
    if (!th.root) return th.end ? { blocked: 'comment-gone', detail: '一楼列表翻到底了也没有这条评论所在的楼' } : { blocked: 'target-not-found', detail: `一楼翻了 ${API_LIMITS.Douyin.maxCommentPages} 页还没找到这条评论所在的楼` };
    if (!th.complete) return { blocked: 'thread-incomplete', detail: `楼中楼读到 ${th.replies.length} 条，楼里有 ${th.root.reply_comment_total ?? '未知'} 条` };
    if (target !== rootId && !th.replies.some((c) => String(c.cid) === target)) return { blocked: 'comment-gone', detail: '楼读全了，里面没有这条楼中楼' };
    const uid = String(me.uid);
    const mine = th.replies.filter((c) => String(c.user?.uid) === uid);
    const replied = target === rootId ? mine.some((c) => String(c.reply_id) === rootId && isRootTarget(c.reply_to_reply_id)) : mine.some((c) => String(c.reply_to_reply_id) === target);
    if (replied) return { blocked: 'already-replied', detail: '这栋楼里已经有我对这条评论的直接回复' };
    return { state: { awemeId, rootId, target, before: new Set(th.replies.map((c) => String(c.cid))) } };
  },
  async send({ call, params }, s) {
    const r = await call('awemeV1CommentMultiPublish', { aweme_id: s.awemeId, text: params.text, reply_to_comment_ids: s.target, channel_id: 618 });
    const d = r.ok ? r.data : null;
    const list = Array.isArray(d?.comments) ? d.comments : null;
    const cid = list?.length === 1 && list[0]?.code === 0 ? list[0].comment?.cid : null;
    if (d?.status_code === 0 && cid != null) return { ok: true, nativeId: String(cid) };
    return { ok: false, detail: r.ok ? `发送接口返回不认识：status_code=${d?.status_code ?? '无'}，comments=${list ? list.map((c) => c?.code).join(',') : '无'}` : `发送接口调用出错：${r.error}` };
  },
  async fresh({ call, params, me }, s) {
    const th = await douyinThread(call, { awemeId: s.awemeId, rootId: s.rootId });
    if (th.error || !th.root) return { items: null, detail: th.error ?? '回读时没找到这栋楼' };
    const want = norm(params.text), uid = String(me.uid);
    return { items: th.replies.filter((c) => !s.before.has(String(c.cid)) && String(c.user?.uid) === uid && norm(c.text) === want).map((c) => String(c.cid)) };
  },
};

// —— 视频号 ——

/** 一楼里找 rootId（最多 maxPages 页），再把它的楼中楼读全（最多 maxExpand 次）。返回 { root, l2, complete, end, error }。 */
export async function channelsThread(call, { exportId, rootId }, lim = API_LIMITS.Channels) {
  let root = null, end = false, buf = '';
  for (let p = 0; p < lim.maxPages && !root; p++) {
    const d = listData(await call('getCommentList', listArgs(exportId, buf)));
    if (!d) return { error: '一楼列表读失败（errCode 不是 0 或没有列表）' };
    root = d.comment.find((c) => String(c.commentId) === rootId) ?? null;
    if (root) break;
    if (Number(d.downContinueFlag) !== 1 || !d.lastBuff || d.lastBuff === buf) { end = true; break; }
    buf = d.lastBuff;
  }
  if (!root) return { root: null, end };
  const l2 = [...(root.levelTwoComment ?? [])];
  let flag = Number(root.downContinueFlag), lb = root.lastBuff;
  for (let calls = 0; flag === 1 && calls < lim.maxExpand; calls++) {
    const d = listData(await call('getCommentList', listArgs(exportId, lb, rootId)));
    if (!d) return { error: '楼中楼读失败（errCode 不是 0 或没有列表）' };
    l2.push(...d.comment);
    if (Number(d.downContinueFlag) === 1 && (!d.lastBuff || d.lastBuff === lb)) break;
    flag = Number(d.downContinueFlag); lb = d.lastBuff;
  }
  return { root, l2, complete: flag !== 1, end: false };
}

export const channelsApi = {
  platform: 'Channels',
  async precheck({ call, page, params, me }) {
    const t = params.target ?? {};
    const target = String(t.commentId), rootId = String(t.rootId ?? t.commentId), workId = String(t.workId);
    const myNick = me.nickname ?? params.nickname ?? null;
    if (!myNick) return { blocked: 'no-uid', detail: '没读到自己的视频号昵称，判断不了哪条是我发的' };
    const feeds = await waitFor(() => page.evaluate(new Function(`const sr = document.querySelector('wujie-app')?.shadowRoot; if (!sr) return null; ${FEEDS_SRC}`)), 20000, 1000);
    const feed = (feeds ?? []).find((f) => String(f.objectNonce) === workId || String(f.objectId) === workId);
    if (!feed) return { blocked: 'target-not-found', detail: '作品列表里没有这个作品' };
    const exportId = feed.objectId;
    const th = await channelsThread(call, { exportId, rootId });
    if (th.error) return { blocked: 'precheck-error', detail: th.error };
    if (!th.root) return th.end ? { blocked: 'comment-gone', detail: '一楼列表翻到底了也没有这条评论所在的楼' } : { blocked: 'target-not-found', detail: `一楼翻了 ${API_LIMITS.Channels.maxPages} 页还没找到这条评论所在的楼` };
    if (!th.complete) return { blocked: 'thread-incomplete', detail: `楼中楼读到 ${th.l2.length} 条，还有没读完的` };
    const tgt = target === rootId ? th.root : th.l2.find((c) => String(c.commentId) === target);
    if (!tgt) return { blocked: 'comment-gone', detail: '楼读全了，里面没有这条楼中楼' };
    const replied = th.l2.some((c) => c.commentNickname === myNick && (target === rootId ? isRootTarget(c.replyCommentId) || String(c.replyCommentId) === rootId : String(c.replyCommentId) === target));
    if (replied) return { blocked: 'already-replied', detail: '这栋楼里已经有我对这条评论的直接回复' };
    const { levelTwoComment: _l2, ...comment } = tgt;
    return { state: { exportId, rootId, target, comment, myNick, before: new Set(th.l2.map((c) => String(c.commentId))) } };
  },
  async send({ call, params, uuid }, s) {
    const r = await call('createComment', { replyCommentId: s.target, content: params.text, clientId: uuid(), rootCommentId: s.rootId, comment: s.comment, exportId: s.exportId });
    const d = r.ok ? r.data : null;
    const id = d?.errCode === 0 && !d?.data?.baseResp?.errcode ? d?.data?.comment?.commentId : null;
    if (id != null) return { ok: true, nativeId: String(id) };
    return { ok: false, detail: r.ok ? `发送接口返回不认识：errCode=${d?.errCode ?? '无'}，baseResp.errcode=${d?.data?.baseResp?.errcode ?? '无'}` : `发送接口调用出错：${r.error}` };
  },
  async fresh({ call, params }, s) {
    const th = await channelsThread(call, { exportId: s.exportId, rootId: s.rootId });
    if (th.error || !th.root) return { items: null, detail: th.error ?? '回读时没找到这栋楼' };
    const want = norm(params.text);
    return { items: th.l2.filter((c) => !s.before.has(String(c.commentId)) && c.commentNickname === s.myNick && norm(c.commentContent) === want).map((c) => String(c.commentId)) };
  },
};

/**
 * 发送 + 回读（不碰页面，只用 call）。导出给测试用假接口跑。
 * 返回 { readBack: { found, count, nativeId, detail } }：回读要恰好 1 条，并且发送接口认得、返回的 id 就是它，found 才是 true。
 */
export async function sendAndReadBack(api, ctx, state, { readbackMs = DEFAULT_TIMEOUTS.readbackMs, stepMs = 2500, sleep = realSleep } = {}) {
  const sent = await api.send(ctx, state);
  let got = null;
  for (const end = Date.now() + readbackMs; ;) {
    await sleep(stepMs);
    got = await api.fresh(ctx, state);
    if ((got.items && got.items.length) || Date.now() >= end) break;
  }
  const items = got.items ?? [];
  const count = items.length;
  const found = sent.ok && count === 1 && items[0] === sent.nativeId;
  const detail = !sent.ok ? sent.detail : got.items == null ? got.detail : count === 1 && !found ? `回读到的 ${items[0]} 不是发送接口返回的 ${sent.nativeId}` : null;
  return { readBack: { found, count, nativeId: sent.ok ? sent.nativeId : items.length === 1 ? items[0] : null, ...(detail ? { detail } : {}) } };
}

/** 写入脚本入口（writers/douyin.mjs、writers/channels.mjs 的 runInSpace 在 writeVia='api' 且 op='reply' 时转到这里）。plat：{ api, url, login, hook }。 */
export async function runApiReply(task, params, plat, deps = {}) {
  const t = { ...DEFAULT_TIMEOUTS, ...(params.timeouts ?? {}) };
  const out = { uidSeen: null, sendAttempted: false, via: 'api' };
  if (params.op !== 'reply') return { ...out, blocked: 'precheck-error', detail: `页面内接口只做回复评论：${params.op}` };
  if (!norm(params.text).trim()) return { ...out, blocked: 'precheck-error', detail: 'text 为空' };
  try {
    const page = await mainPage(task);
    if (plat.hook) await installHook(page);
    await open(page, plat.url(params));
    await waitFor(() => page.evaluate(() => document.readyState === 'complete'), Math.min(t.loadMs, 30000));
    const lost = await atLogin(page);
    if (lost) return { ...out, loginLost: true, evidence: redact(`页面在 ${lost}`) };
    const who = (await plat.login(page, params, t)) ?? {};
    if (who.loginLost) return { ...out, loginLost: true, evidence: redact(who.evidence ?? '') };
    out.uidSeen = who.uid == null || who.uid === '' ? null : String(who.uid);
    if (!out.uidSeen) return { ...out, blocked: 'no-uid', detail: redact(who.detail ?? '页面上没读到当前登录账号的 uid') };
    if (out.uidSeen !== String(params.uid).trim()) return { ...out, blocked: 'uid-mismatch', detail: `页面登录的是 ${out.uidSeen}，要用的账号是 ${params.uid}` };
    const call = await (deps.serviceCaller ?? serviceCaller)(page, plat.api.platform, { waitMs: Math.min(t.loadMs, 60000) });
    if (!call) return { ...out, blocked: 'cannot-send', detail: '页面自己的评论服务没找到（页面可能改版了），没发。可以关掉 writeViaApi 改回页面写法' };
    const ctx = { call, page, params, me: who, uuid: deps.uuid ?? randomUUID };
    const pre = await plat.api.precheck(ctx);
    if (pre.blocked) return { ...out, blocked: pre.blocked, ...(pre.detail ? { detail: redact(pre.detail) } : {}) };
    out.sendAttempted = true;
    const { readBack } = await sendAndReadBack(plat.api, ctx, pre.state, { readbackMs: t.readbackMs, ...(deps.sleep ? { sleep: deps.sleep } : {}) });
    return { ...out, readBack: { ...readBack, ...(readBack.detail ? { detail: redact(readBack.detail) } : {}) } };
  } catch (e) {
    if (out.sendAttempted) return { ...out, readBack: { found: false, count: 0, nativeId: null, detail: redact(`发送后出错：${e?.message ?? e}`) } };
    return { ...out, blocked: 'precheck-error', detail: redact(`发送前出错：${e?.message ?? e}`) };
  }
}
