// 视频号处置：删评论、拉黑。接口约定见 writers/index.mjs；都调 wujie 沙箱 iframe 里页面自己的评论服务（同 S9 回复用的那个对象，
// 见 ../inpage-api.mjs），鉴权头和请求体里的 _log_finder_uin 等由页面的请求封装加，Node 里不拼。
// 入口和参数只从页面代码里读来（2026-11-22 只读核对，没调过任何写接口）：
//   删评论 delete：deleteComment({ exportId: 作品 objectId, commentId }) → POST .../comment/del_comment，成功是 errCode=0。
//        （评论「删除」确认框的 handleDelete 就这么调。）发前用 getCommentList 把目标所在的楼读全（同 S9 回复）：
//          楼不在了 → already-gone；没读全 → thread-incomplete；昵称是我 → self-target；
//          一楼下面有回复 → deletes-thread（rejected，页面删一楼时把整条连楼下回复一起拿掉）。
//        发后再读一遍：楼读全了、目标不在了（一楼目标：一楼列表翻到底也没有它），才算 found。
//   拉黑 block：blockUser({ refCommentId: 评论 id, refObjectId: 作品 objectId, modType: 1 }) → POST .../comment/block_user，成功是 errCode=0。
//        （评论「更多 → 拉黑」确认后的 handleConfirmBlockUser 就这么调；modType 枚举 Add=1、Del=2。）
//        平台不给评论者 uid，拉黑只能从一条评论发起（库里的目标就是这条评论，见 moderate.mjs）。
//        发前重读这条评论：不在 → target-not-found（拉黑要靠它）；昵称是我 → self-target；blacklistFlag 已是真 → already-blocked。
//        发后再读：这条评论的 blacklistFlag 为真才算 found（页面「已在黑名单」就是按它显示的）。
//   删会话：不做，原因见 moderate.mjs 的 MOD_UNSUPPORTED。
// 调了写接口之后出任何错都只回读、不重调，返回 sendAttempted: true。
import { mainPage, open, sleep as realSleep } from '../adapters/page-lib.mjs';
import { serviceCaller } from '../inpage-api.mjs';
import { redact } from '../redact.mjs';
import { channelsExportId, channelsThread } from './api-reply.mjs';
import { login } from './channels.mjs';
import { DEFAULT_TIMEOUTS } from './page-write-lib.mjs';

export const FILE = 'channels-moderate.mjs';
export const PAGE = 'https://channels.weixin.qq.com/platform/interaction/comment';
const MOD_ADD = 1;

const errText = (e) => redact(String(e?.message ?? e)).slice(0, 300);
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ''));
const stop = (me, blocked, detail, extra = {}) => ({ uidSeen: me ?? null, blocked, detail: redact(detail), sendAttempted: false, ...extra });

/** 楼里找目标：{ node } / { gone, detail } / { blocked, detail }。th 是 channelsThread 的结果。 */
function locate(th, target, rootId) {
  if (th.error) return { blocked: 'precheck-error', detail: th.error };
  if (!th.root) return th.end ? { gone: true, detail: `一楼列表翻到底了也没有楼 ${rootId}` } : { blocked: 'target-not-found', detail: `一楼翻到上限还没找到楼 ${rootId}` };
  if (target === rootId) return { node: th.root };
  if (!th.complete) return { blocked: 'thread-incomplete', detail: `楼 ${rootId} 的回复没读全（读到 ${th.l2.length} 条），删了也确认不了，没动` };
  const node = th.l2.find((c) => String(c.commentId) === target);
  return node ? { node } : { gone: true, detail: `楼 ${rootId} 读全了，里面已没有 ${target}` };
}

/** 发前共用：核对账号、找到作品 exportId、读到目标评论。返回 { done } 或 { me, myNick, exportId, node, th }。 */
async function prepare(api, p, ids) {
  const who = await api.whoAmI();
  if (who.done) return { done: who.done };
  const me = who.uid, myNick = who.nickname ?? p.nickname ?? null;
  if (!myNick) return { done: stop(me, 'no-uid', '没读到自己的视频号昵称，判断不了哪条是我发的') };
  if (!ids.target || !ids.rootId || !ids.workId) return { done: stop(me, 'target-not-found', `评论 id、楼 id 或作品 id 缺失：${ids.target} / ${ids.rootId} / ${ids.workId}`) };
  const fe = await api.exportId(ids.workId);
  if (fe.blocked) return { done: stop(me, fe.blocked, fe.detail) };
  const th = await channelsThread(api.call, { exportId: fe.exportId, rootId: ids.rootId });
  return { me, myNick, exportId: fe.exportId, th, at: locate(th, ids.target, ids.rootId) };
}

export async function deleteComment(api, p) {
  const t = p.target ?? {};
  const ids = { target: String(t.commentId ?? ''), rootId: String(t.rootId ?? t.commentId ?? ''), workId: String(t.workId ?? '') };
  let me, exportId;
  try {
    const pre = await prepare(api, p, ids);
    if (pre.done) return pre.done;
    ({ me, exportId } = pre);
    if (!(await api.hasMethod('deleteComment'))) return stop(me, 'cannot-send', '页面评论服务里没有 deleteComment（页面可能改版了），没删');
    const { at } = pre;
    if (at.gone) return stop(me, 'already-gone', at.detail);
    if (at.blocked) return stop(me, at.blocked, at.detail);
    if (at.node.commentNickname === pre.myNick) return stop(me, 'self-target', '这条是我自己的评论，不删');
    if (ids.target === ids.rootId) {
      // 删一楼会连楼下回复一起拿掉：楼读不全、或下面有回复（不管是谁的）都不删
      if (!pre.th.complete) return stop(me, 'thread-incomplete', '一楼下面的回复没读全，判断不了有没有回复，没删');
      if (pre.th.l2.length > 0) return stop(me, 'deletes-thread', `${ids.target} 是一楼，下面有 ${pre.th.l2.length} 条回复；删一楼会把楼下回复一起删掉，不删`, { rejected: true });
    }
  } catch (e) {
    return stop(me, 'precheck-error', errText(e));
  }

  let sendError = null, postError = null;
  try {
    const r = await api.call('deleteComment', { exportId, commentId: ids.target });
    if (!r.ok) postError = r.error;
    else if (r.data?.errCode !== 0) sendError = `del_comment errCode=${r.data?.errCode ?? '无'} ${r.data?.errMsg ?? ''}`.trim();
  } catch (e) { postError = errText(e); }
  let readBack;
  try {
    await api.sleep(2000);
    const at = locate(await channelsThread(api.call, { exportId, rootId: ids.rootId }), ids.target, ids.rootId);
    const gone = !!at.gone && !sendError;
    readBack = { found: gone, count: gone ? 1 : 0, nativeId: ids.target,
      detail: [gone ? at.detail : at.node ? '回读时这条还在' : at.gone ? null : at.detail, postError ? `del_comment 出错：${postError}` : null].filter(Boolean).join('；') };
  } catch (e) { readBack = { found: false, count: 0, nativeId: ids.target, detail: `回读出错：${errText(e)}` }; }
  return { uidSeen: me, sendAttempted: true, ...(sendError ? { sendError: redact(sendError) } : {}), readBack: clean({ ...readBack, detail: readBack.detail && redact(readBack.detail) }) };
}

export async function block(api, p) {
  const s = p.target?.source;
  if (s?.kind !== 'comment') return stop(null, 'target-not-found', '视频号拉黑只能从评论发起（平台不给评论者 uid），没有来源评论');
  const ids = { target: String(s.commentId ?? ''), rootId: String(s.rootId ?? s.commentId ?? ''), workId: String(s.workId ?? '') };
  let me, exportId;
  try {
    const pre = await prepare(api, p, ids);
    if (pre.done) return pre.done;
    ({ me, exportId } = pre);
    if (!(await api.hasMethod('blockUser'))) return stop(me, 'cannot-send', '页面评论服务里没有 blockUser（页面可能改版了），没拉黑');
    const { at } = pre;
    if (at.gone) return stop(me, 'target-not-found', `来源评论 ${ids.target} 已不在，视频号拉黑要从评论发起，没拉黑（${at.detail}）`);
    if (at.blocked) return stop(me, at.blocked, at.detail);
    if (at.node.commentNickname === pre.myNick) return stop(me, 'self-target', '这条评论是我自己发的，不拉黑');
    if (at.node.blacklistFlag) return stop(me, 'already-blocked', `评论 ${ids.target} 的作者已在黑名单里`);
  } catch (e) {
    return stop(me, 'precheck-error', errText(e));
  }

  let sendError = null, postError = null;
  try {
    const r = await api.call('blockUser', { refCommentId: ids.target, refObjectId: exportId, modType: MOD_ADD });
    if (!r.ok) postError = r.error;
    else if (r.data?.errCode !== 0) sendError = `block_user errCode=${r.data?.errCode ?? '无'} ${r.data?.errMsg ?? ''}`.trim();
  } catch (e) { postError = errText(e); }
  let readBack;
  try {
    await api.sleep(1500);
    const at = locate(await channelsThread(api.call, { exportId, rootId: ids.rootId }), ids.target, ids.rootId);
    const ok = !!at.node?.blacklistFlag && !sendError;
    readBack = { found: ok, count: ok ? 1 : 0, nativeId: ids.target,
      detail: [at.node ? (at.node.blacklistFlag ? null : '回读时这条评论的 blacklistFlag 还是假') : `回读时读不到这条评论：${at.detail}`, postError ? `block_user 出错：${postError}` : null].filter(Boolean).join('；') };
  } catch (e) { readBack = { found: false, count: 0, nativeId: ids.target, detail: `回读出错：${errText(e)}` }; }
  return { uidSeen: me, sendAttempted: true, ...(sendError ? { sendError: redact(sendError) } : {}), readBack: clean({ ...readBack, detail: readBack.detail && redact(readBack.detail) }) };
}

const OPS = { delete: deleteComment, block };

export async function runInSpace(task, params) {
  const run = OPS[params.op];
  if (!run) return { uidSeen: null, blocked: 'precheck-error', detail: `channels-moderate 不认识 op ${params.op}`, sendAttempted: false };
  const t = { ...DEFAULT_TIMEOUTS, ...(params.timeouts ?? {}) };
  let page, call;
  try {
    page = await mainPage(task);
    await open(page, params.urls?.comments ?? PAGE);
  } catch (e) {
    return { uidSeen: null, blocked: 'precheck-error', detail: errText(e), sendAttempted: false };
  }
  const api = {
    sleep: realSleep,
    async whoAmI() {
      const who = (await login(page, params, t)) ?? {};
      if (who.loginLost) return { done: { uidSeen: null, loginLost: true, evidence: redact(who.evidence ?? ''), sendAttempted: false } };
      const uid = who.uid == null || who.uid === '' ? null : String(who.uid);
      if (!uid) return { done: { uidSeen: null, blocked: 'no-uid', detail: redact(who.detail ?? '页面上没读到当前登录账号'), sendAttempted: false } };
      if (uid !== String(params.uid)) return { done: { uidSeen: uid, blocked: 'uid-mismatch', detail: `页面登录的是 ${uid}，要用的账号是 ${params.uid}`, sendAttempted: false } };
      // 评论服务要等沙箱 iframe 起来
      call = await serviceCaller(page, 'Channels', { waitMs: Math.min(t.loadMs, 60000) });
      if (!call) return { done: { uidSeen: uid, blocked: 'cannot-send', detail: '页面自己的评论服务没找到（页面可能改版了），没动', sendAttempted: false } };
      return { uid, nickname: who.nickname ?? null };
    },
    exportId: (workId) => channelsExportId(page, workId),
    hasMethod: (name) => page.evaluate((n) => typeof window.__engSvc?.Channels?.[n] === 'function', name),
    call: (method, args) => call(method, args),
  };
  return run(api, params);
}
