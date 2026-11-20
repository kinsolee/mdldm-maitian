// 小红书页面写入：回复评论（主站通知「评论和@」）、发私信（主站 /chat/<对方 uid>）。和读适配器 adapters/xhs.mjs 用同一套页面。
// 挂钩页面自己发的请求（installHook，只抄响应；xsec_token 不出页面）。
//   账号：页面自己发的 user/me 响应 → window.__INITIAL_STATE__.user.userInfo → 私信会话列表里的 user_id（同读适配器 selfUid）。
//   回复：you/mentions 里找 comment_info.id 等于目标的通知（S0 回复框就在通知页：点 .action-reply 出 textarea.comment-input）。
//        通知行 DOM 上没有组件数据可读，按「评论者昵称 + 评论正文前 20 字」在 .action-reply 所在的通知行里唯一定位，不唯一就不发。
//        回读：页面发回复时自己发的 comment/post 响应（code=0、content 等于正文、作者是我、target_comment 是目标）。
//   私信：/chat/<对方 uid> 抄回 messages/history（sender_id 判最后一句），输入框 div.xhs-im-input-bar-editor；
//        官方号会话没有输入框（S0），会话列表 v3/chats 里 info.is_official 为真时直接不发。
//        回读：点发送后抓到的响应里，sender_id 是我、内容等于正文的新消息。
// 不点赞、不删除，只碰回复框、私信框和它们的发送按钮。
import { dropSecrets, sleep, urlParam, waitCaptured } from '../adapters/page-lib.mjs';
import { capturedJson, findObjects, inPage, mark, markSel, runWrite, sendNearBox, waitFor } from './page-write-lib.mjs';

export const FILE = 'xhs.mjs';
export const PAGES = {
  comments: 'https://www.xiaohongshu.com/notification',
  dms: 'https://www.xiaohongshu.com/chat',
};
export const LIMITS = { maxMentionPages: 4 };
const MENTIONS = 'you/mentions';
const POST = 'comment/post';

export function runInSpace(task, params) {
  return runWrite(task, params, { hook: true, url, login, prepareReply, prepareDM });
}

const peerOf = (p) => String(p.target?.peerUid ?? p.target?.conversationId ?? '');
// urls.dms 给了就原样打开（测试页）；没给就打开 /chat/<对方 uid>（读适配器实测按行号点会话不稳，直接开地址）
const url = (p) => (p.op === 'reply' ? p.urls?.comments ?? PAGES.comments : p.urls?.dms ?? `${PAGES.dms}/${encodeURIComponent(peerOf(p))}`);

const notLoggedIn = (j) => j && (j.code === -100 || j.code === -101);

async function login(page, params, t) {
  await sleep(t.settleMs);
  const all = await capturedJson(page, '');
  const lost = all.find((c) => notLoggedIn(c.json));
  if (lost) return { loginLost: true, evidence: `${lost.url.replace(/^https?:\/\/[^/]+/, '')} code=${lost.json.code}` };
  const meResp = (await capturedJson(page, 'user/me')).map((c) => c.json?.data).find((d) => d && (d.user_id || d.userId));
  const st = await page.evaluate(() => {
    try { const v = (x) => (x && typeof x === 'object' && ('_value' in x || '_rawValue' in x) ? x._value ?? x._rawValue : x); const u = v(window.__INITIAL_STATE__?.user?.userInfo); return u ? { uid: u.user_id ?? u.userId ?? null, nickname: u.nickname ?? null } : null; } catch { return null; }
  });
  if (meResp) return { uid: String(meResp.user_id ?? meResp.userId), nickname: meResp.nickname ?? st?.nickname ?? null };
  if (st?.uid) return { uid: String(st.uid), nickname: st.nickname };
  const self = [...new Set((await capturedJson(page, 'im/web/v3/chats')).flatMap((c) => c.json?.data?.chats ?? []).map((c) => c.user_id).filter(Boolean))];
  if (self.length === 1) return { uid: String(self[0]), nickname: null };
  return { uid: null, detail: '没从 user/me、__INITIAL_STATE__、私信会话列表读到当前登录用户' };
}

// —— 回复 ——
const mentionList = async (page) => (await capturedJson(page, MENTIONS)).filter((c) => c.json?.code === 0).flatMap((c) => c.json.data?.message_list ?? []);

// 在页面里定位通知行：每个 .action-reply 往上走到只含它一个 .action-reply 的最大祖先就是一行；
// 按昵称 + 正文前 20 字（去空白）匹配。正文对不上时再看「昵称 + 已删除」的行（评论删了正文会换成提示）。
const LOCATE_SRC = `const n = (s) => String(s || '').replace(/\\s+/g, '');
  const GONE = /^(该评论已(被)?删除|评论已(被)?删除)/;
  const rows = new Set();
  for (const b of document.querySelectorAll('.action-reply')) { let e = b; while (e.parentElement && e.parentElement.querySelectorAll('.action-reply').length === 1) e = e.parentElement; rows.add(e); }
  __qa('[data-eng-w="item"]').forEach((x) => x.removeAttribute('data-eng-w'));
  const goneIn = (e) => [...e.querySelectorAll('*')].some((x) => !x.children.length && GONE.test((x.textContent || '').trim()));
  let hits = [...rows].filter((e) => { const t = n(e.innerText); return t.includes(n(arg.nick)) && t.includes(n(arg.content).slice(0, 20)); });
  if (!hits.length) hits = [...rows].filter((e) => n(e.innerText).includes(n(arg.nick)) && goneIn(e));
  if (hits.length !== 1) return { count: hits.length };
  const it = hits[0];
  it.setAttribute('data-eng-w', 'item');
  // 这一行里已经显示了我的回复（类名带 reply、文字里有我的昵称，回复入口和输入框除外）
  const replied = !!arg.myNick && [...it.querySelectorAll('[class*=reply]')].some((x) => !x.matches('.action-reply') && !x.closest('.action-reply') && !x.querySelector('textarea, .action-reply') && n(x.innerText).includes(n(arg.myNick)));
  return { count: 1, gone: goneIn(it), replied };`;

async function prepareReply({ page, params, t, me }) {
  const tg = params.target ?? {};
  const id = String(tg.commentId);
  // 「评论和@」已选中时再点会让列表出不来（S0），所以只在没抓到 you/mentions 时点
  if (!(await waitCaptured(page, MENTIONS, { timeoutMs: Math.min(8000, t.loadMs) }))) {
    await page.click('text="评论和@"', { label: 'open comments tab' }).catch(() => {});
    await waitCaptured(page, MENTIONS, { timeoutMs: t.loadMs });
  }
  let list = await mentionList(page);
  if (!list.length) return { blocked: 'target-not-found', detail: `${t.loadMs}ms 内没抓到 you/mentions` };
  const find = () => list.find((m) => String(m.comment_info?.id) === id);
  // 不在第一页就往下翻（同读适配器：滚到底触发下一页）
  for (let i = 1; i < LIMITS.maxMentionPages && !find(); i++) {
    const pages = await capturedJson(page, MENTIONS);
    if (!pages.at(-1)?.json?.data?.has_more) break;
    const from = (await page.evaluate(() => (window.__engCap || []).length));
    await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); for (const e of document.querySelectorAll('*')) if (e.scrollHeight > e.clientHeight + 50 && /auto|scroll/.test(getComputedStyle(e).overflowY)) e.scrollTop = e.scrollHeight; });
    if (!(await waitCaptured(page, MENTIONS, { from, timeoutMs: 10000 }))) break;
    list = await mentionList(page);
  }
  const m = find();
  if (!m) return { blocked: 'target-not-found', detail: `通知「评论和@」里没有评论 ${id}` };
  const arg = { nick: m.user_info?.nickname ?? tg.authorNickname ?? '', content: m.comment_info?.content ?? tg.commentText ?? '', myNick: me.nickname ?? params.nickname ?? null };
  // 页面上只能按「昵称 + 正文」定位通知行：昵称或正文为空（纯图片、表情评论）就分不清是哪条，不发
  if (!String(arg.nick).trim() || !String(arg.content).trim()) return { blocked: 'target-not-found', detail: `评论 ${id} 的昵称或正文为空（纯图片、表情？），在页面上没法唯一定位，没发` };
  // 判「已有我的回复」要靠我的昵称
  if (!String(arg.myNick ?? '').trim()) return { blocked: 'no-uid', detail: '读不到当前账号的昵称，判断不了是否已回复，没发' };
  // 列表渲染不稳，实测有时 30 秒以上才出来（S0），回复入口最长等 loadMs
  await waitFor(() => page.evaluate(() => document.querySelectorAll('.action-reply').length > 0), t.loadMs, 1000);
  const at = await inPage(page, LOCATE_SRC, arg);
  if (at.count !== 1) return { blocked: 'target-not-found', detail: at.count ? `页面上有 ${at.count} 条同昵称、同正文的通知，分不清是哪条` : '页面上没渲染出这条通知' };
  if (at.gone) return { blocked: 'comment-gone', detail: `评论 ${id} 显示已删除` };
  if (at.replied) return { blocked: 'already-replied', detail: `评论 ${id} 的通知里已显示我的回复` };
  // 本页里之前发过的回复（同一页面会话里）
  if ((await posted(page)).some((c) => c.mine(me) && c.target === id)) return { blocked: 'already-replied', detail: `评论 ${id} 已在本页回复过` };
  await mark(page, 'reply', `return __marked('item')?.querySelector('.action-reply') ?? null;`);
  await page.click(markSel('reply'), { label: 'open reply box' });
  const box = await waitFor(() => mark(page, 'box', `const all = [...document.querySelectorAll('textarea.comment-input')].filter((e) => e.getClientRects().length);
    const own = all.filter((e) => __marked('item')?.contains(e));
    return own.length === 1 ? own[0] : all.length === 1 ? all[0] : null;`), t.boxMs);
  if (!box) return { blocked: 'no-input-box', detail: '点了「回复」后没出现唯一的回复框（textarea.comment-input）' };
  return {
    send: sendNearBox('^发送$', 3),
    items: async () => (await posted(page)).map((c) => ({ id: c.id, mine: c.mine(me), rel: c.target === id, text: c.text })),
    apiError: async (from) => apiError(page, POST, from),
  };
}

/** 抓到的 comment/post 成功响应里的新评论。 */
async function posted(page) {
  return (await capturedJson(page, POST)).filter((c) => c.json?.code === 0).map((c) => c.json.data?.comment).filter((c) => c?.id != null)
    .map((c) => ({ id: String(c.id), text: c.content ?? '', target: c.target_comment?.id != null ? String(c.target_comment.id) : null,
      mine: (me) => String(c.user_info?.user_id ?? c.user_info?.userid ?? '') === String(me.uid) }));
}

/** 点发送之后抓到的、URL 匹配 re 且 code≠0 的响应 → 错误摘要。 */
async function apiError(page, re, from) {
  const bad = (await capturedJson(page, re, from)).find((c) => c.json && c.json.code != null && c.json.code !== 0);
  return bad ? `${bad.url.replace(/^https?:\/\/[^/]+/, '')} code=${bad.json.code}${bad.json.msg ? ` ${bad.json.msg}` : ''}` : null;
}

// —— 私信 ——
const content = (m) => { try { const c = JSON.parse(m.content); return Number(c.content_type) === 1 ? c.content ?? null : null; } catch { return null; } };

async function prepareDM({ page, params, t, me }) {
  const peer = peerOf(params);
  const hist = await waitFor(async () => (await capturedJson(page, 'im/web/messages/history')).find((c) => urlParam(c.url, 'chat_user_id') === peer) ?? null, Math.min(t.loadMs, 30000), 1000);
  if (!hist) return { blocked: 'target-not-found', detail: `没抓到和 ${peer} 的消息记录（messages/history）` };
  if (hist.json.code !== 0) return { blocked: 'target-not-found', detail: `messages/history code=${hist.json.code}` };
  const msgs = hist.json.data?.out_message_list ?? hist.json.data?.message_list;
  if (!Array.isArray(msgs)) return { blocked: 'target-not-found', detail: 'messages/history 没有消息列表' };
  const last = [...msgs].sort((a, b) => Number(b.created_at) - Number(a.created_at))[0];
  if (last && String(last.sender_id) === String(me.uid)) return { blocked: 'last-is-me', detail: '会话最后一句是我说的' };
  const chat = (await capturedJson(page, 'im/web/v3/chats')).flatMap((c) => c.json?.data?.chats ?? []).find((c) => String(c.chat_user_id) === peer);
  if (chat?.info?.is_official) return { blocked: 'cannot-send', detail: '官方号会话，不能发私信' };
  const box = await waitFor(() => mark(page, 'box', `const all = [...document.querySelectorAll('div.xhs-im-input-bar-editor')].filter((e) => e.getClientRects().length);
    return all.length === 1 ? all[0] : null;`), t.boxMs);
  if (!box) return { blocked: 'no-input-box', detail: '会话页没有唯一的输入框（div.xhs-im-input-bar-editor），可能是官方号或不能私信' };
  return {
    send: (await mark(page, 'send', sendNearBox('^发送$', 3))) ? sendNearBox('^发送$', 3) : 'enter',
    items: async () => (await capturedJson(page, 'im/')).flatMap((c) => findObjects(dropSecrets(c.json), (o) => o.id != null && o.sender_id != null && typeof o.content === 'string'))
      .map((o) => ({ id: String(o.id), mine: String(o.sender_id) === String(me.uid), rel: String(o.receiver_id ?? peer) === peer, text: content(o) })),
    apiError: async (from) => apiError(page, 'im/web/.*send', from),
  };
}
