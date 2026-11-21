// B站处置：删评论、拉黑、删私信会话。和 bili.mjs 一样在 member.bilibili.com 页面里调接口，接口约定见 writers/index.mjs。
//   删评论 delete：nav 核对账号 → x/web-interface/view 取 aid、确认作品是我的 → x/v2/reply/reply 拉整楼重读
//        （楼或这条已不在 → already-gone；作者是我 → self-target；楼没读全 → thread-incomplete）
//        → x/v2/reply/del 只调一次 → 等 2 秒再拉整楼，确认这条不在了才算 found。
//   拉黑 block：x/relation?fid= 重读（attribute 128 已拉黑 → already-blocked）→ x/relation/modify act=5 只调一次 → 再读 x/relation，attribute 128 才算 found。
//   删会话 deleteConversation：session_svr/get_sessions 翻完整个会话列表重读（不在 → already-gone；翻不完 → list-incomplete）
//        → session_svr/remove_session 只调一次 → 再翻一遍，翻完且不在才算 found。只是从会话列表里移除，聊天记录还在；对方再发消息会话会回来。
// 目标是登录账号自己（mid 相同）一律不动手（self-target）。csrf（cookie bili_jct）只在页面里读、只在页面里填，不回到 Node。
// 返回同 writers/index.mjs：found 的含义是「回读确认生效了」（评论没了、已拉黑、会话不在列表里）。
import { bigJson, mainPage, open, sleep } from '../adapters/page-lib.mjs';

export const FILE = 'bili-moderate.mjs';
export const PAGE = 'https://member.bilibili.com/platform/comment/article';
const API = 'https://api.bilibili.com';
const VC = 'https://api.vc.bilibili.com';
const GONE_CODES = new Set([12022, -404]);   // 12022：评论已经被删除了
const BLOCKED_ATTR = 128;                    // x/relation 的 attribute：128 = 已拉黑
const MAX_THREAD_PAGES = 10;
const MAX_SESSION_PAGES = 30;

export async function runInSpace(task, params) {
  let page;
  try {
    page = await mainPage(task);
    await open(page, params.urls?.comments ?? PAGE);
    await sleep(3000);
  } catch (e) {
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
        if (!csrf) return JSON.stringify({ code: -111, message: '页面里没有 bili_jct，没调接口', noCsrf: true });
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
  const run = OPS[params.op];
  if (!run) return { uidSeen: null, blocked: 'precheck-error', detail: `bili-moderate 不认识 op ${params.op}`, sendAttempted: false };
  return run(api, params);
}

const strForm = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)]));
const midOf = (x) => String(x?.member?.mid ?? x?.mid ?? '');
const rpidOf = (x) => String(x?.rpid_str ?? x?.rpid ?? '');
const errText = (e) => String(e?.message ?? e).slice(0, 300);
const noCsrf = (me, r) => ({ uidSeen: me, blocked: 'send-error', detail: String(r.message ?? '页面里没有 bili_jct，没调接口'), sendAttempted: false });

async function whoAmI(api, uid) {
  const nav = await api.get(`${API}/x/web-interface/nav`);
  if (nav.code === -101 || !nav.data?.isLogin) return { done: { uidSeen: null, loginLost: true, evidence: `x/web-interface/nav code=${nav.code}`, sendAttempted: false } };
  const me = nav.data?.mid == null ? null : String(nav.data.mid);
  if (!me) return { done: { uidSeen: null, blocked: 'no-uid', detail: 'nav 没给 mid', sendAttempted: false } };
  if (me !== String(uid)) return { done: { uidSeen: me, blocked: 'uid-mismatch', detail: `登记的是 ${uid}，页面上登录的是 ${me}`, sendAttempted: false } };
  return { me };
}

/** 整楼：{ ok, root, replies, complete } / { gone, code } / { error }。replies 缺失只有 page.count 明确为 0 才是空楼。 */
async function thread(api, oid, root) {
  const replies = [];
  let rootNode = null;
  for (let pn = 1; pn <= MAX_THREAD_PAGES; pn++) {
    const j = await api.get(`${API}/x/v2/reply/reply?oid=${oid}&type=1&root=${root}&ps=20&pn=${pn}`);
    if (GONE_CODES.has(j.code)) return { gone: true, code: j.code };
    if (j.code !== 0) return { error: `reply/reply code=${j.code} ${j.message ?? ''}`.trim() };
    rootNode = j.data?.root ?? rootNode;
    const count = j.data?.page?.count;
    if (!Array.isArray(j.data?.replies) && !(j.data?.replies === null && count === 0)) return { ok: true, root: rootNode, replies, complete: false };
    const rs = j.data.replies ?? [];
    replies.push(...rs);
    if (rs.length < 20 || (Number.isFinite(count) && pn * 20 >= count)) return { ok: true, root: rootNode, replies, complete: true };
  }
  return { ok: true, root: rootNode, replies, complete: false };
}

/** 这条评论在不在：'present'（带节点）、'gone'、'unknown'（读不全或出错，带原因）。 */
function locate(th, rootId, commentId) {
  if (th.gone) return { state: 'gone', detail: `楼 ${rootId} 已不在（code=${th.code}）` };
  if (th.error) return { state: 'unknown', detail: th.error };
  const isRoot = String(commentId) === String(rootId);
  if (isRoot) {
    if (!th.root) return { state: 'unknown', detail: `reply/reply 没给楼 ${rootId} 的一楼` };
    return rpidOf(th.root) === String(commentId) ? { state: 'present', node: th.root } : { state: 'unknown', detail: `reply/reply 给的一楼 ${rpidOf(th.root)} 不是 ${commentId}` };
  }
  const node = th.replies.find((x) => rpidOf(x) === String(commentId));
  if (node) return { state: 'present', node };
  if (!th.complete) return { state: 'unknown', detail: `楼 ${rootId} 超过 ${MAX_THREAD_PAGES} 页没读全` };
  return { state: 'gone', detail: `楼 ${rootId} 里已没有 ${commentId}` };
}

export async function deleteComment(api, p) {
  const t = p.target;
  let me, oid;
  try {
    const who = await whoAmI(api, p.uid);
    if (who.done) return who.done;
    me = who.me;
    const view = await api.get(`${API}/x/web-interface/view?bvid=${encodeURIComponent(t.workId)}`);
    oid = view.data?.aid == null ? null : String(view.data.aid);
    if (!oid) return { uidSeen: me, blocked: 'target-not-found', detail: `作品 ${t.workId} 读不到（view code=${view.code}）`, sendAttempted: false };
    const owner = view.data?.owner?.mid == null ? null : String(view.data.owner.mid);
    if (owner !== me) return { uidSeen: me, blocked: 'not-my-work', detail: `作品 ${t.workId} 的作者是 ${owner ?? '（读不到）'}，不是我，只删自己作品下的评论`, sendAttempted: false };
    const at = locate(await thread(api, oid, t.rootId), t.rootId, t.commentId);
    if (at.state === 'gone') return { uidSeen: me, blocked: 'already-gone', detail: at.detail, sendAttempted: false };
    if (at.state === 'unknown') return { uidSeen: me, blocked: at.detail.includes('没读全') ? 'thread-incomplete' : 'target-not-found', detail: at.detail, sendAttempted: false };
    const author = midOf(at.node);
    if (!author) return { uidSeen: me, blocked: 'precheck-error', detail: '读不到这条评论的作者', sendAttempted: false };
    if (author === me || author === String(p.uid) || (p.selfUids ?? []).includes(author)) return { uidSeen: me, blocked: 'self-target', detail: '这条是我自己的评论，不删', sendAttempted: false };
  } catch (e) {
    return { uidSeen: me ?? null, blocked: 'precheck-error', detail: errText(e), sendAttempted: false };
  }

  // 从这里起算调过接口：之后出任何错都只回读，不重调
  let sendError = null, postError = null;
  try {
    const r = await api.post(`${API}/x/v2/reply/del`, strForm({ oid, type: 1, rpid: t.commentId }), ['csrf']);
    if (r.noCsrf) return noCsrf(me, r);
    // 12022：调的时候已经被删了（别人或平台先删的）。回读确认不在就算达成
    if (r.code !== 0 && r.code !== 12022) sendError = `reply/del code=${r.code} ${r.message ?? ''}`.trim();
  } catch (e) { postError = errText(e); }
  let readBack;
  try {
    await api.sleep(2000);
    const at = locate(await thread(api, oid, t.rootId), t.rootId, t.commentId);
    const gone = at.state === 'gone' && !sendError;
    readBack = { found: gone, count: gone ? 1 : 0, nativeId: String(t.commentId),
      detail: [at.state === 'present' ? '回读时这条还在' : at.detail, postError ? `reply/del 出错：${postError}` : null].filter(Boolean).join('；') || undefined };
  } catch (e) { readBack = { found: false, count: 0, nativeId: String(t.commentId), detail: `回读出错：${errText(e)}` }; }
  return { uidSeen: me, sendAttempted: true, ...(sendError ? { sendError } : {}), readBack: clean(readBack) };
}

async function relationAttr(api, mid) {
  const j = await api.get(`${API}/x/relation?fid=${encodeURIComponent(mid)}`);
  if (j.code !== 0 || j.data == null || !Number.isFinite(Number(j.data.attribute))) return { error: `x/relation code=${j.code} ${j.message ?? ''}`.trim() };
  return { attribute: Number(j.data.attribute) };
}

export async function block(api, p) {
  const mid = String(p.target.mid ?? '');
  let me;
  try {
    const who = await whoAmI(api, p.uid);
    if (who.done) return who.done;
    me = who.me;
    if (!/^\d+$/.test(mid)) return { uidSeen: me, blocked: 'target-not-found', detail: `拉黑对象的 mid 不对：${mid}`, sendAttempted: false };
    if (mid === me || mid === String(p.uid) || (p.selfUids ?? []).includes(mid)) return { uidSeen: me, blocked: 'self-target', detail: '对象是我自己，不拉黑', sendAttempted: false };
    const rel = await relationAttr(api, mid);
    if (rel.error) return { uidSeen: me, blocked: 'precheck-error', detail: rel.error, sendAttempted: false };
    if (rel.attribute === BLOCKED_ATTR) return { uidSeen: me, blocked: 'already-blocked', detail: `${mid} 已在黑名单里`, sendAttempted: false };
  } catch (e) {
    return { uidSeen: me ?? null, blocked: 'precheck-error', detail: errText(e), sendAttempted: false };
  }

  let sendError = null, postError = null;
  try {
    const r = await api.post(`${API}/x/relation/modify`, strForm({ fid: mid, act: 5, re_src: 11 }), ['csrf']);
    if (r.noCsrf) return noCsrf(me, r);
    if (r.code !== 0) sendError = `relation/modify code=${r.code} ${r.message ?? ''}`.trim();
  } catch (e) { postError = errText(e); }
  let readBack;
  try {
    await api.sleep(1500);
    const rel = await relationAttr(api, mid);
    const ok = !rel.error && rel.attribute === BLOCKED_ATTR && !sendError;
    readBack = { found: ok, count: ok ? 1 : 0, nativeId: mid,
      detail: [rel.error ?? (rel.attribute === BLOCKED_ATTR ? null : `回读 attribute=${rel.attribute}，不是 ${BLOCKED_ATTR}`), postError ? `relation/modify 出错：${postError}` : null].filter(Boolean).join('；') || undefined };
  } catch (e) { readBack = { found: false, count: 0, nativeId: mid, detail: `回读出错：${errText(e)}` }; }
  return { uidSeen: me, sendAttempted: true, ...(sendError ? { sendError } : {}), readBack: clean(readBack) };
}

/** 翻完整个会话列表找 talker：{ present } 或 { error }；没翻完 complete:false。 */
async function findSession(api, talker) {
  let endTs = null;
  for (let i = 0; i < MAX_SESSION_PAGES; i++) {
    const j = await api.get(`${VC}/session_svr/v1/session_svr/get_sessions?session_type=1&group_fold=1&unfollow_fold=0&sort_rule=2${endTs ? `&end_ts=${endTs}` : ''}&build=0&mobi_app=web`);
    if (j.code !== 0) return { error: `get_sessions code=${j.code} ${j.message ?? ''}`.trim() };
    if (!Array.isArray(j.data?.session_list)) return { error: 'get_sessions code=0 但缺 data.session_list' };
    const l = j.data.session_list;
    if (l.some((s) => String(s.talker_id) === talker && Number(s.session_type ?? 1) === 1)) return { present: true, complete: true };
    if (!j.data?.has_more || !l.length) return { present: false, complete: true };
    endTs = l.at(-1).session_ts;
    await api.sleep(300);
  }
  return { present: false, complete: false };
}

export async function deleteConversation(api, p) {
  const talker = String(p.target.conversationId ?? '');
  let me;
  try {
    const who = await whoAmI(api, p.uid);
    if (who.done) return who.done;
    me = who.me;
    if (!/^\d+$/.test(talker)) return { uidSeen: me, blocked: 'target-not-found', detail: `会话 id 不对：${talker}`, sendAttempted: false };
    if (talker === me || talker === String(p.uid) || (p.selfUids ?? []).includes(talker)) return { uidSeen: me, blocked: 'self-target', detail: '会话对象是我自己，不删', sendAttempted: false };
    const s = await findSession(api, talker);
    if (s.error) return { uidSeen: me, blocked: 'precheck-error', detail: s.error, sendAttempted: false };
    if (!s.present) {
      return s.complete ? { uidSeen: me, blocked: 'already-gone', detail: `会话列表里已没有 ${talker}`, sendAttempted: false }
        : { uidSeen: me, blocked: 'list-incomplete', detail: `会话列表超过 ${MAX_SESSION_PAGES} 页没翻完，没找到 ${talker}`, sendAttempted: false };
    }
  } catch (e) {
    return { uidSeen: me ?? null, blocked: 'precheck-error', detail: errText(e), sendAttempted: false };
  }

  let sendError = null, postError = null;
  try {
    const r = await api.post(`${VC}/session_svr/v1/session_svr/remove_session`, strForm({ talker_id: talker, session_type: 1, build: 0, mobi_app: 'web' }), ['csrf', 'csrf_token']);
    if (r.noCsrf) return noCsrf(me, r);
    if (r.code !== 0) sendError = `remove_session code=${r.code} ${r.message ?? ''}`.trim();
  } catch (e) { postError = errText(e); }
  let readBack;
  try {
    await api.sleep(1500);
    const s = await findSession(api, talker);
    const ok = !s.error && s.complete && !s.present && !sendError;
    readBack = { found: ok, count: ok ? 1 : 0, nativeId: talker,
      detail: [s.error ?? (s.present ? '回读时会话还在列表里' : s.complete ? null : '回读时会话列表没翻完'), postError ? `remove_session 出错：${postError}` : null].filter(Boolean).join('；') || undefined };
  } catch (e) { readBack = { found: false, count: 0, nativeId: talker, detail: `回读出错：${errText(e)}` }; }
  return { uidSeen: me, sendAttempted: true, ...(sendError ? { sendError } : {}), readBack: clean(readBack) };
}

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const OPS = { delete: deleteComment, block, deleteConversation };
