// B站写入：回复评论、发私信。在 member.bilibili.com 页面里调接口（同 bili_comment.mjs 的 reply 做法），接口约定见 writers/index.mjs。
//   回复：x/web-interface/view 取 aid → x/v2/reply/reply 拉整楼重读（楼被删、找不到这条、已有我对它的直接回复就不发）
//        → x/v2/reply/add（楼中楼正文前加「回复 @昵称 :」）→ 等 2 秒再拉整楼，我发的、parent 是它、正文一样的恰好 1 条才算发出。
//   私信：svr_sync/fetch_session_msgs 重读（最后一句是我就不发）→ web_im/v1/web_im/send_msg → 再读一次，只数这次之后的新消息。
// csrf（cookie bili_jct）只在页面里读、只在页面里填进表单，不回到 Node。发送接口只调一次，出任何错都不重发。
import { bigJson, mainPage, open, sleep } from '../adapters/page-lib.mjs';

export const FILE = 'bili.mjs';
export const PAGES = { comments: 'https://member.bilibili.com/platform/comment/article', dms: 'https://member.bilibili.com/platform/comment/article' };
const API = 'https://api.bilibili.com';
const VC = 'https://api.vc.bilibili.com';
const GONE_CODES = new Set([12022, -404]);   // 12022：评论已经被删除了

// —— 页面脚本（ego-browser nodejs 里跑）——
export async function runInSpace(task, params) {
  let page;
  try {
    page = await mainPage(task);
    await open(page, params.urls?.[params.op === 'sendDM' ? 'dms' : 'comments'] ?? PAGES.comments);
    await sleep(3000);
  } catch (e) {
    // 还没调任何接口，一定没发：按重读出错返回（框架记 failed、可再试），不抛成 runner 失败
    return { uidSeen: null, blocked: 'precheck-error', detail: errText(e), sendAttempted: false };
  }
  const api = {
    sleep,
    async get(url) {
      const r = await page.fetch(url, { credentials: 'include', timeout: 20000 });
      const j = bigJson(String(r.body));
      if (!j) throw new Error(`GET ${url.split('?')[0]} http=${r.status} 不是 JSON`);
      return j;
    },
    async post(url, form, csrfFields) {
      const text = await page.evaluate(async ({ url, form, csrfFields }) => {
        const csrf = (document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/) || [])[1];
        if (!csrf) return JSON.stringify({ code: -111, message: '页面里没有 bili_jct，没发' });
        const body = new URLSearchParams(form);
        for (const k of csrfFields) body.set(k, csrf);
        const r = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
        return await r.text();
      }, { url, form, csrfFields });
      const j = bigJson(String(text));
      if (!j) throw new Error(`POST ${url.split('?')[0]} 返回的不是 JSON`);
      return j;
    },
  };
  return params.op === 'sendDM' ? sendDM(api, params) : reply(api, params);
}

const strForm = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)]));
const midOf = (x) => String(x?.member?.mid ?? x?.mid ?? '');
const parentOf = (x) => String(x?.parent_str ?? x?.parent ?? '');
const rpidOf = (x) => String(x?.rpid_str ?? x?.rpid ?? '');
const errText = (e) => String(e?.message ?? e).slice(0, 300);

/** 当前登录账号：没登录返回 { loginLost }；读到 mid 后和登记的 uid 比，不符返回 blocked。 */
async function whoAmI(api, uid) {
  const nav = await api.get(`${API}/x/web-interface/nav`);
  if (nav.code === -101 || !nav.data?.isLogin) return { done: { uidSeen: null, loginLost: true, evidence: `x/web-interface/nav code=${nav.code}`, sendAttempted: false } };
  const me = nav.data?.mid == null ? null : String(nav.data.mid);
  if (!me) return { done: { uidSeen: null, blocked: 'no-uid', detail: 'nav 没给 mid', sendAttempted: false } };
  if (me !== String(uid)) return { done: { uidSeen: me, blocked: 'uid-mismatch', detail: `登记的是 ${uid}，页面上登录的是 ${me}`, sendAttempted: false } };
  return { me };
}

/** 整楼：{ ok, root, replies, complete } 或 { gone } / { error }。最多 10 页（同 bili_comment.mjs）。 */
async function thread(api, oid, root) {
  const replies = [];
  let rootNode = null;
  for (let pn = 1; pn <= 10; pn++) {
    const j = await api.get(`${API}/x/v2/reply/reply?oid=${oid}&type=1&root=${root}&ps=20&pn=${pn}`);
    if (GONE_CODES.has(j.code)) return { gone: true, code: j.code };
    if (j.code !== 0) return { error: `reply/reply code=${j.code} ${j.message ?? ''}`.trim() };
    rootNode = j.data?.root ?? rootNode;
    const count0 = j.data?.page?.count;
    // 同读适配器 X3-B1：replies 缺失或为 null 只有 page.count 明确为 0 才是空楼，否则算读不全
    if (!Array.isArray(j.data?.replies) && !(j.data?.replies === null && count0 === 0)) return { ok: true, root: rootNode, replies, complete: false };
    const rs = j.data.replies ?? [];
    replies.push(...rs);
    const count = j.data?.page?.count;
    if (rs.length < 20 || (Number.isFinite(count) && pn * 20 >= count)) return { ok: true, root: rootNode, replies, complete: true };
  }
  return { ok: true, root: rootNode, replies, complete: false };
}

export async function reply(api, p) {
  const t = p.target;
  let me, oid, message, before;
  try {
    const who = await whoAmI(api, p.uid);
    if (who.done) return who.done;
    me = who.me;
    const view = await api.get(`${API}/x/web-interface/view?bvid=${encodeURIComponent(t.workId)}`);
    oid = view.data?.aid == null ? null : String(view.data.aid);
    if (!oid) return { uidSeen: me, blocked: 'target-not-found', detail: `作品 ${t.workId} 读不到（view code=${view.code}）`, sendAttempted: false };
    const th = await thread(api, oid, t.rootId);
    if (th.gone) return { uidSeen: me, blocked: 'comment-gone', detail: `楼 ${t.rootId} 已被删（code=${th.code}）`, sendAttempted: false };
    if (th.error) return { uidSeen: me, blocked: 'target-not-found', detail: th.error, sendAttempted: false };
    // 整楼没读全时看不出我是不是已经回过：不发
    if (!th.complete) return { uidSeen: me, blocked: 'thread-incomplete', detail: `楼 ${t.rootId} 超过 10 页没读全，判断不了是否已回复，没发`, sendAttempted: false };
    const target = rpidOf(th.root) === String(t.commentId) ? th.root : th.replies.find((x) => rpidOf(x) === String(t.commentId));
    if (!target) return { uidSeen: me, blocked: 'comment-gone', detail: `楼 ${t.rootId} 里没有 ${t.commentId}`, sendAttempted: false };
    const mine = th.replies.find((x) => midOf(x) === me && parentOf(x) === String(t.commentId));
    if (mine) return { uidSeen: me, blocked: 'already-replied', detail: `已有我的回复 ${rpidOf(mine)}`, sendAttempted: false };
    before = new Set(th.replies.map(rpidOf));
    const isSub = target !== th.root;
    message = isSub ? `回复 @${target.member?.uname ?? t.authorNickname ?? ''} :${p.text}` : p.text;
  } catch (e) {
    return { uidSeen: me ?? null, blocked: 'precheck-error', detail: errText(e), sendAttempted: false };
  }

  // 从这里起算点过发送：之后出任何错都只回读，不重发
  let sendError = null, nativeId = null, postError = null;
  try {
    const r = await api.post(`${API}/x/v2/reply/add`, strForm({ oid, type: 1, root: t.rootId, parent: t.commentId, message, plat: 1 }), ['csrf']);
    if (r.code !== 0) sendError = `reply/add code=${r.code} ${r.message ?? ''}`.trim();
    nativeId = r.data?.rpid_str ?? (r.data?.rpid == null ? null : String(r.data.rpid));
  } catch (e) { postError = errText(e); }
  let readBack;
  try {
    await api.sleep(2000);
    const after = await thread(api, oid, t.rootId);
    const hits = after.ok ? after.replies.filter((x) => !before.has(rpidOf(x)) && midOf(x) === me && parentOf(x) === String(t.commentId) && x.content?.message === message) : [];
    const n = hits.length;
    readBack = { found: confirmed(hits, n, rpidOf, nativeId, sendError), count: n, nativeId, ...(after.ok ? {} : { detail: after.error ?? '回读时楼已不在' }), ...(postError ? { detail: `reply/add 出错：${postError}` } : {}) };
  } catch (e) { readBack = { found: false, count: 0, nativeId, detail: `回读出错：${errText(e)}` }; }
  return { uidSeen: me, sendAttempted: true, ...(sendError ? { sendError } : {}), readBack };
}

/**
 * 回读到的算不算这一次发的：发送接口明确报错 → 不算（那条是别人用同一账号发的）；
 * 接口给了新 id → 恰好 1 条且就是它；接口没给 id（请求出错、不知道发没发）→ 恰好 1 条新的。
 */
function confirmed(hits, n, idOf, nativeId, sendError) {
  if (sendError || n !== 1) return false;
  return nativeId == null || idOf(hits[0]) === String(nativeId);
}

const msgText = (m) => { try { return JSON.parse(m.content)?.content ?? null; } catch { return null; } };
const seqOf = (m) => Number(m?.msg_seqno ?? 0);

export async function sendDM(api, p) {
  const talker = String(p.target.conversationId);
  const url = `${VC}/svr_sync/v1/svr_sync/fetch_session_msgs?talker_id=${encodeURIComponent(talker)}&session_type=1&size=20&build=0&mobi_app=web`;
  let me, lastSeq = 0, ts;
  try {
    const who = await whoAmI(api, p.uid);
    if (who.done) return who.done;
    me = who.me;
    const j = await api.get(url);
    if (j.code !== 0 || !Array.isArray(j.data?.messages)) return { uidSeen: me, blocked: 'target-not-found', detail: `fetch_session_msgs code=${j.code}`, sendAttempted: false };
    const latest = j.data.messages.reduce((a, m) => (seqOf(m) > seqOf(a) ? m : a), null);
    if (latest && String(latest.sender_uid) === me) return { uidSeen: me, blocked: 'last-is-me', detail: '会话最后一句是我', sendAttempted: false };
    lastSeq = seqOf(latest);
    ts = Math.floor(Date.now() / 1000);
  } catch (e) {
    return { uidSeen: me ?? null, blocked: 'precheck-error', detail: errText(e), sendAttempted: false };
  }

  let sendError = null, nativeId = null, postError = null;
  try {
    const r = await api.post(`${VC}/web_im/v1/web_im/send_msg`, strForm({
      'msg[sender_uid]': me, 'msg[receiver_id]': talker, 'msg[receiver_type]': 1, 'msg[msg_type]': 1, 'msg[msg_status]': 0,
      'msg[content]': JSON.stringify({ content: p.text }), 'msg[timestamp]': ts, 'msg[new_face_version]': 0,
      'msg[dev_id]': devId(), from_firework: 0, build: 0, mobi_app: 'web' }), ['csrf', 'csrf_token']);
    if (r.code !== 0) sendError = `send_msg code=${r.code} ${r.message ?? ''}`.trim();
    nativeId = r.data?.msg_key == null ? null : String(r.data.msg_key);
  } catch (e) { postError = errText(e); }
  let readBack;
  try {
    await api.sleep(1500);
    const j = await api.get(url);
    const ok = j.code === 0 && Array.isArray(j.data?.messages);
    const hits = ok ? j.data.messages.filter((m) => seqOf(m) > lastSeq && String(m.sender_uid) === me && Number(m.msg_type) === 1 && msgText(m) === p.text) : [];
    const n = hits.length;
    readBack = { found: confirmed(hits, n, (m) => String(m.msg_key ?? ''), nativeId, sendError), count: n, nativeId, ...(ok ? {} : { detail: `回读 fetch_session_msgs code=${j.code}` }), ...(postError ? { detail: `send_msg 出错：${postError}` } : {}) };
  } catch (e) { readBack = { found: false, count: 0, nativeId, detail: `回读出错：${errText(e)}` }; }
  return { uidSeen: me, sendAttempted: true, ...(sendError ? { sendError } : {}), readBack };
}

// 网页版私信每次带一个设备 id（大写 UUID）
const devId = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16); }).toUpperCase();
