// 视频号页面写入：回复评论（互动管理 → 评论）、发私信（私信页）。和读适配器 adapters/channels.mjs 用同一套页面。
// 业务页面在 wujie 微前端的开放 shadowRoot 里，读 Vue 2 组件数据（元素上的 __vue__）；page.click 的选择器能进开放的 shadowRoot（S0）。
//   账号：POST auth/auth_data 的 finderUser.uniqId 核对账号（同读适配器的 uidSeen），errCode≠0 算掉线。
//        平台不给评论者 uid，「是不是我」按昵称：页面上的 finderUser.nickname，没有再用 params.nickname。
//   回复：左侧作品列表组件的 commentFeeds 找到 objectNonce（或 objectId）等于 workId 的作品点开，
//        读 .comment-item 的 __vue__.$props.dataSource（二楼同时在一楼的 levelTwoComment 里），找不到就点「展开更多回复」（只读）。
//        「已有我的回复」：昵称是我、直接回复的是目标（replyCommentId 是它；嵌在它 levelTwoComment 里且没有 replyCommentId 也算）。
//        回复入口 .weui-icon-outlined-comment，输入框 textarea.create-input（只认挂在目标 .comment-item 里的那个）。
//        发送按钮（2026-11-21 真实页面只读核对）：输入框所在 .comment-create-content 里 .create-ft 下文字为「评论」的 .tag-wrap
//        （div，不是 button，文字也不是「发送」）；框里没字时它的 class 带 disabled，有字后去掉。
//   私信（2026-11-25 真实页面只读核对）：.private-msg-wrapper 的 Vue 实例持有 $data.sessionList 和 computed currentSessionId；
//        .session-container 滚动懒加载后续页；transition-group 渲染无 __vue__ 的 .session-wrap，按 vn.key === sessionId 找 vn.elm；
//        点开后核对列表 currentSessionId 与 .session-dialog（SessionHeader）的 sessionInfo.sessionId 均严格等于目标；
//        输入框 textarea.edit_area，发送按钮在 .footer 下文字「发送」且排除 disabled / aria-disabled / *disabled* class；
//        发后回读过滤乐观写入的 Pending(1) / Failure(3)，仅认带有效服务端 svrMsgId 的 Success(2) 或历史 None(0) 且 !sendMsgFlag；
//        新增 Failure(3) 或可见 .phone-check-dialog 记 sendError，超时仍 Pending(1) 记诊断。
// 不点 .like-action、不置顶、不删除。
import { FEEDS_SRC } from '../adapters/channels.mjs';
import { clickMarked, sleep } from '../adapters/page-lib.mjs';
import { runApiWrite, channelsApi } from './api-reply.mjs';
import { clearBox, inPage, mark, markSel, norm, runWrite, toasts, waitFor } from './page-write-lib.mjs';

export const FILE = 'channels.mjs';
export const PAGES = {
  comments: 'https://channels.weixin.qq.com/platform/interaction/comment',
  dms: 'https://channels.weixin.qq.com/platform/private_msg',
};
export const LIMITS = { maxExpand: 15, maxScroll: 6 };

// S9：writeVia='api'（能力位 writeViaApi）时回复评论走页面内接口，见 ./api-reply.mjs；私信照旧用页面写法
export function runInSpace(task, params) {
  if (params.writeVia === 'api' && params.op === 'reply') return runApiWrite(task, params, { api: channelsApi, hook: false, url, login });
  return runWrite(task, params, { hook: false, url, login, prepareReply, prepareDM });
}

const url = (p) => (p.op === 'reply' ? p.urls?.comments ?? PAGES.comments : p.urls?.dms ?? PAGES.dms);

export async function login(page, params, t) {
  // 测试钩子：本地测试页没有 auth_data 接口，从页面全局读（只在 params 里显式给了才走）
  if (params.test?.loginFromPage) {
    const u = await page.evaluate(() => window.__loginUser ?? null);
    return { uid: u?.uniqId ?? null, nickname: u?.nickname ?? null };
  }
  await sleep(t.settleMs);
  const r = await page.fetch('/cgi-bin/mmfinderassistant-bin/auth/auth_data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', timeout: 15000 }).catch(() => null);
  let a = null; try { a = JSON.parse(r?.body ?? 'null'); } catch {}
  if (a && a.errCode != null && a.errCode !== 0) return { loginLost: true, evidence: `auth/auth_data errCode=${a.errCode}` };
  const fu = a?.data?.finderUser;
  return { uid: fu?.uniqId ?? null, nickname: fu?.nickname ?? null, detail: `auth/auth_data ${!r ? '请求失败或超时' : !a ? '不是 JSON' : '缺 finderUser.uniqId'}` };
}

// shadowRoot 里跑：sr 是 wujie-app 的 shadowRoot
const inShadow = (page, body, arg) => inPage(page, `const sr = document.querySelector('wujie-app')?.shadowRoot; if (!sr) return null; ${body}`, arg);

const GONE = `/^(该评论已(被)?删除|评论已(被)?删除)/`;
// 评论：一楼和二楼合起来按 commentId 去重；root 是嵌在哪条一楼的 levelTwoComment 里，reply 是 replyCommentId
const ITEMS_SRC = `const out = {};
  const add = (c, root) => { const id = String(c.commentId);
    const o = out[id] ||= { id, nick: c.commentNickname ?? '', text: c.commentContent ?? '', reply: null, root: null, gone: false };
    if (c.replyCommentId) o.reply = String(c.replyCommentId);
    if (root) o.root = root; };
  for (const el of sr.querySelectorAll('.comment-item')) {
    const c = el.__vue__?.$props?.dataSource; if (!c || c.commentId == null) continue;
    add(c, null);
    for (const r of c.levelTwoComment || []) add(r, String(c.commentId));
  }
  for (const leaf of sr.querySelectorAll('*')) {
    if (leaf.children.length || !${GONE}.test((leaf.textContent || '').trim())) continue;
    const c = leaf.closest('.comment-item')?.__vue__?.$props?.dataSource;
    if (c && out[String(c.commentId)]) out[String(c.commentId)].gone = true;
  }
  return Object.values(out);`;

const items = async (page) => (await inShadow(page, ITEMS_SRC)) ?? [];
/** 直接回复的对象：replyCommentId，没有就看嵌在哪条一楼下；一楼自己为 null。 */
export const directTo = (x) => x.reply ?? x.root ?? null;

// 回复框旁唯一的、没 disabled 的「评论」tag-wrap
const SEND = `const box = __marked('box'); const wrap = box && box.closest('.comment-create-content'); if (!wrap) return null;
  const hits = [...wrap.querySelectorAll('.create-ft .tag-wrap')].filter((e) => (e.innerText || e.textContent || '').trim() === '评论');
  return hits.length === 1 && !hits[0].classList.contains('disabled') ? hits[0] : null;`;

const myNickOf = (me, params) => me.nickname ?? params.nickname ?? null;

async function prepareReply({ page, params, t, me }) {
  const tg = params.target ?? {};
  const id = String(tg.commentId);
  const work = String(tg.workId);
  const myNick = myNickOf(me, params);
  if (!myNick) return { blocked: 'no-uid', detail: '没读到自己的视频号昵称，判不了哪条是我写的' };
  let feeds = await waitFor(async () => { const f = await inShadow(page, FEEDS_SRC); return Array.isArray(f) && f.length ? f : null; }, t.loadMs, 1000);
  if (!feeds) return { blocked: 'target-not-found', detail: '视频号作品列表读不到' };
  const pick = () => feeds.find((f) => String(f.objectNonce) === work || String(f.objectId) === work);
  // 作品列表滚动懒加载（同读适配器）
  for (let i = 0; i < LIMITS.maxScroll && !pick(); i++) {
    await inShadow(page, `const l = [...sr.querySelectorAll('.comment-feed-wrap')].at(-1); l?.scrollIntoView({ block: 'end' }); return true;`);
    await sleep(2500);
    const next = (await inShadow(page, FEEDS_SRC)) ?? feeds;
    if (next.length <= feeds.length) break;
    feeds = next;
  }
  const f = pick();
  if (!f) return { blocked: 'target-not-found', detail: `作品列表里没有作品 ${work}` };
  if (!(await clickMarked(page, `() => document.querySelector('wujie-app').shadowRoot.querySelectorAll('.comment-feed-wrap')[${f.i}]`, 'open post comments')))
    return { blocked: 'target-not-found', detail: `点不到作品 ${work}` };
  let list = await waitFor(async () => { const l = await items(page); return l.some((x) => x.id === id) ? l : null; }, Math.min(t.loadMs, 15000), 1000) ?? (await items(page));
  for (let i = 0; i < (params.maxExpand ?? LIMITS.maxExpand); i++) {
    if (!(await clickMarked(page, `() => [...document.querySelector('wujie-app').shadowRoot.querySelectorAll('*')].find((e) => e.children.length === 0 && /^展开更多回复$/.test(e.textContent.trim()))`, 'expand more replies'))) break;
    await sleep(2000);
  }
  list = await items(page);
  const hit = list.find((x) => x.id === id);
  if (!hit) return { blocked: 'target-not-found', detail: `作品 ${work} 下没找到评论 ${id}` };
  if (hit.gone) return { blocked: 'comment-gone', detail: `评论 ${id} 显示已删除` };
  const prior = list.find((x) => x.nick === myNick && x.id !== id && directTo(x) === id);
  if (prior) return { blocked: 'already-replied', detail: `评论 ${id} 下已有我的回复 ${prior.id}` };
  // 展开到上限还有「展开更多回复」：没加载的回复里可能有我的旧回复，不发
  const more = await inPage(page, `const sr = document.querySelector('wujie-app')?.shadowRoot; return !!sr && [...sr.querySelectorAll('*')].some((e) => e.children.length === 0 && /^展开更多回复$/.test(e.textContent.trim()));`);
  if (more) return { blocked: 'thread-incomplete', detail: `作品 ${work} 的回复展开到上限还没加载全，判断不了是否已回复，没发` };

  const found = await mark(page, 'reply', `const sr = document.querySelector('wujie-app')?.shadowRoot; if (!sr) return null;
    const el = [...sr.querySelectorAll('.comment-item')].find((e) => String(e.__vue__?.$props?.dataSource?.commentId) === arg);
    return el ? [...el.querySelectorAll('.weui-icon-outlined-comment')].find((i) => i.closest('.comment-item') === el) ?? null : null;`, id);
  if (!found) return { blocked: 'target-not-found', detail: `找到了评论 ${id}，但没找到它的回复入口` };
  await page.click(markSel('reply'), { label: 'open reply box' });
  const box = await waitFor(() => mark(page, 'box', `const sr = document.querySelector('wujie-app')?.shadowRoot; if (!sr) return null;
    const all = [...sr.querySelectorAll('textarea.create-input')].filter((e) => e.getClientRects().length);
    const own = all.filter((e) => String(e.closest('.comment-item')?.__vue__?.$props?.dataSource?.commentId) === arg);
    return own.length === 1 ? own[0] : null;`, id), t.boxMs);
  if (!box) return { blocked: 'no-input-box', detail: '点了回复后没出现属于这条评论的唯一回复框（textarea.create-input）' };
  return {
    send: SEND,
    items: async () => (await items(page)).map((x) => ({ id: x.id, mine: x.nick === myNick, rel: directTo(x) === id, text: x.text })),
  };
}

// —— 私信 ——
const FIND_SESSION_VM = `let v = null;
  for (let x = sr.querySelector('.session-wrap'), i = 0; x && i < 8 && !v; x = x.parentElement, i++) if (Array.isArray(x.__vue__?.$data?.sessionList)) v = x.__vue__;
  if (!v) for (const e of sr.querySelectorAll('*')) if (Array.isArray(e.__vue__?.$data?.sessionList)) { v = e.__vue__; break; }`;

const DM_SESSIONS_SRC = `${FIND_SESSION_VM}
  if (!v) return null;
  return v.$data.sessionList.map(([id, s]) => ({
    sessionId: id,
    sessionType: s?.sessionType ?? null,
    newMsgCount: s?.newMsgCount ?? 0,
    sessionIsUnread: !!s?.sessionIsUnread,
    sessionInfo: {
      sessionId: s?.sessionInfo?.sessionId,
      username: s?.sessionInfo?.username,
      nickname: s?.sessionInfo?.nickname,
      fromUserType: s?.sessionInfo?.fromUserType ?? null,
    },
    messageList: (s?.messageList ?? []).filter(Boolean).map((m) => ({
      currentMsgStatus: typeof m.currentMsgStatus === 'number' ? m.currentMsgStatus : null,
      outLimitWarn: !!m.outLimitWarn,
      message: m.message ? {
        msgId: m.message.msgId ?? m.message.newMsgId ?? null,
        svrMsgId: m.message.svrMsgId ?? null,
        sendMsgFlag: !!m.message.sendMsgFlag,
        fromUsername: m.message.fromUsername,
        toUsername: m.message.toUsername,
        ts: m.message.ts,
        msgType: m.message.msgType,
        textMsg: m.message.textMsg ? { content: m.message.textMsg.content } : null,
      } : null,
    })),
  }));`;

const FIND_ROW_SRC = `const sr = document.querySelector('wujie-app')?.shadowRoot; if (!sr) return null;
  ${FIND_SESSION_VM}
  if (v) {
    const list = v.$data.sessionList;
    const ids = new Set(list.map(([id]) => String(id)));
    const isTg = (c) => c && (c.$options?.name === 'transition-group' || c.$options?._componentTag === 'transition-group' || c.$vnode?.componentOptions?.tag === 'transition-group');
    let foundSessionTg = false;
    const scanTg = (c) => {
      for (const arr of [c.children, c._vnode?.children]) {
        if (!Array.isArray(arr) || !arr.length) continue;
        const looksLikeSessions = arr.some((vn) => vn?.elm?.classList?.contains('session-wrap') || (vn?.key != null && ids.has(String(vn.key))));
        if (!looksLikeSessions) continue;
        foundSessionTg = true;
        const hit = arr.find((vn) => vn && vn.key != null && String(vn.key) === arg && vn.elm?.nodeType === 1 && sr.contains(vn.elm));
        if (hit) return hit.elm;
      }
      return null;
    };
    const seen = new Set();
    const queue = [v];
    while (queue.length && seen.size < 300) {
      const c = queue.shift();
      if (!c || seen.has(c)) continue;
      seen.add(c);
      if (isTg(c)) {
        const hit = scanTg(c);
        if (hit) return hit;
      }
      if (Array.isArray(c.$children)) queue.push(...c.$children);
    }
    if (!foundSessionTg) {
      for (const e of sr.querySelectorAll('*')) {
        const c = e.__vue__;
        if (c && !seen.has(c) && isTg(c)) {
          seen.add(c);
          const hit = scanTg(c);
          if (hit) return hit;
        }
      }
    }
    if (foundSessionTg) return null;
    const wraps = [...sr.querySelectorAll('.session-wrap')].filter((w) => !w.__vue__?.$data?.sessionList && !w.querySelector('.session-wrap, .session-list, .session-container'));
    if (wraps.length && wraps.length === list.length) {
      const idx = list.findIndex(([id]) => String(id) === arg);
      if (idx >= 0) return wraps[idx];
    }
  }
  for (const e of sr.querySelectorAll('*')) {
    const p = e.__vue__?.$props;
    if (p && Object.values(p).some((val) => val && typeof val === 'object' && (String(val.sessionId) === arg || String(val.sessionInfo?.sessionId) === arg))) return e;
  }
  return null;`;

const READ_OPENED_SIDS_BODY = `${FIND_SESSION_VM}
  const normId = (val) => (val == null || String(val).trim() === '' ? null : String(val).trim());
  const safe = (fn) => { try { return fn(); } catch { return null; } };
  const addUnique = (arr, val) => { const s = normId(val); if (s && !arr.includes(s)) arr.push(s); };
  const listId = v ? normId(safe(() => v.currentSessionId)) : null;
  const headerIds = [];
  const dialog = box?.closest?.('.session-dialog') ?? null;
  if (dialog) {
    const seen = new Set();
    const queue = [];
    for (const el of dialog.querySelectorAll('.header, .header *')) {
      if (el.__vue__ && !el.closest('.message-list, .footer')) queue.push(el.__vue__);
    }
    while (queue.length && seen.size < 100) {
      const vm = queue.shift();
      if (!vm || seen.has(vm)) continue;
      seen.add(vm);
      addUnique(headerIds, safe(() => vm.sessionInfo?.sessionId));
      if (Array.isArray(vm.$children)) queue.push(...vm.$children);
    }
  }
  const ids = [];
  addUnique(ids, listId);
  for (const id of headerIds) addUnique(ids, id);
  if (!ids.length && box) {
    const idOf = (val) => (val && typeof val === 'object' ? val.sessionId ?? val.sessionInfo?.sessionId ?? null : null);
    for (let el = box, depth = 0; el && depth < 12; el = el.parentElement || el.getRootNode()?.host, depth++) {
      const vm = el.__vue__;
      if (!vm) continue;
      if (Array.isArray(vm.$data?.sessionList)) {
        addUnique(ids, safe(() => vm.currentSessionId));
        break;
      }
      for (const bag of [vm.$props, vm.$data]) {
        if (!bag || typeof bag !== 'object') continue;
        addUnique(ids, safe(() => idOf(bag)));
        for (const val of safe(() => Object.values(bag)) ?? []) addUnique(ids, safe(() => idOf(val)));
      }
    }
  }
  const openedOk = ids.length > 0 && ids.every((x) => x === targetSid);`;

const READ_OPENED_SIDS_SRC = `const box = __marked('box');
  const boxes = [...sr.querySelectorAll('textarea.edit_area')].filter((el) => el.getClientRects().length);
  if (!box || !box.isConnected || !sr.contains(box) || boxes.length !== 1 || boxes[0] !== box) return { ok: false, ids: [], boxMissing: true };
  const targetSid = arg;
  ${READ_OPENED_SIDS_BODY}
  return { ok: openedOk, ids };`;

const FIND_DM_SEND_BODY = `const re = /^发送$/;
  const txt = (el) => (el.innerText || el.textContent || '').trim();
  const isVisible = (el) => {
    if (!el || !el.isConnected || !el.getClientRects().length) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const isDisabled = (el, stop) => {
    for (let cur = el; cur; cur = cur.parentElement) {
      if (cur.disabled || cur.hasAttribute?.('disabled') || cur.getAttribute?.('aria-disabled') === 'true') return true;
      if (cur.classList && [...cur.classList].some((cls) => /disabled/i.test(cls))) return true;
      if (getComputedStyle(cur).pointerEvents === 'none') return true;
      if (cur === stop) break;
    }
    return false;
  };
  const footer = box.closest('.footer');
  const scope = footer ?? (box.parentElement && !box.parentElement.querySelector('.message-list') ? box.parentElement : null);
  let sendBtn = null;
  if (scope && isVisible(scope)) {
    const hits = [...scope.querySelectorAll('button, [role=button], a, [class*=btn]')]
      .filter((el) => re.test(txt(el))
        && isVisible(el)
        && !el.closest('[class*=operations-], .message-list, .header')
        && !el.querySelector('textarea, [contenteditable=true]')
        && !box.contains(el));
    const inner = hits.filter((h) => !hits.some((other) => other !== h && h.contains(other)));
    if (inner.length === 1 && !isDisabled(inner[0], scope)) sendBtn = inner[0];
  }
`;

const dmSendSrc = (sid) => `const sr = document.querySelector('wujie-app')?.shadowRoot; if (!sr) return null;
  const box = __marked('box');
  const boxes = [...sr.querySelectorAll('textarea.edit_area')].filter((el) => el.getClientRects().length);
  if (!box || !box.isConnected || !sr.contains(box) || boxes.length !== 1 || boxes[0] !== box) return null;
  const targetSid = ${JSON.stringify(sid)};
  ${READ_OPENED_SIDS_BODY}
  if (!openedOk) return null;
  ${FIND_DM_SEND_BODY}
  return sendBtn;`;

const PRE_CLICK_VERIFY_SRC = `const box = __marked('box');
  const markedSend = __marked('send');
  const boxes = [...sr.querySelectorAll('textarea.edit_area')].filter((el) => el.getClientRects().length);
  if (!box || !box.isConnected || !sr.contains(box) || boxes.length !== 1 || boxes[0] !== box) return { ok: false, reason: '点击发送前输入框消失或不唯一' };
  const targetSid = arg;
  ${READ_OPENED_SIDS_BODY}
  if (!openedOk) return { ok: false, reason: ids.length ? '点击发送前会话已切换（期望 ' + targetSid + '，当前 ' + [...new Set(ids)].join('/') + '）' : '点击发送前读不到当前打开的会话' };
  ${FIND_DM_SEND_BODY}
  if (!sendBtn || !markedSend || sendBtn !== markedSend) return { ok: false, reason: '点击发送前发送按钮已失效或发生变化' };
  return { ok: true };`;

const PHONE_DIALOG_SRC = `return __qa('.phone-check-dialog').some((el) => {
  if (!el.getClientRects().length) return false;
  const st = getComputedStyle(el);
  if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
});`;

const dmSessions = async (page) => (await inShadow(page, DM_SESSIONS_SRC)) ?? [];
const lastOf = (s) => [...(s.messageList ?? [])]
  .filter((m) => m && m.currentMsgStatus !== 3 && m.message && m.message.ts != null)
  .map((m) => m.message)
  .sort((a, b) => Number(b.ts) - Number(a.ts))[0] ?? null;

const validSvrMsgId = (val) => {
  if (val == null) return null;
  const str = String(val).trim();
  return str && str !== '0' ? str : null;
};

const normLocalId = (val) => {
  if (val == null) return null;
  const str = String(val).trim();
  return str || null;
};

function sanitizeToastError(rawToast) {
  const text = String(rawToast ?? '');
  const codeMatch = text.match(/(?:errcode|err_code|错误码)[=:：\s]*(-?\d{1,6})(?!\d)/i);
  const codeSuffix = codeMatch ? `（errcode=${codeMatch[1]}）` : '';
  if (/验证|风控|安全|手机/.test(text)) return `私信发送触发平台安全验证提示${codeSuffix}`;
  if (/频繁|频控|稍后|上限|限流|条数/.test(text)) return `私信发送触发频控或条数限制提示${codeSuffix}`;
  if (/违规|敏感|涉政|违禁/.test(text)) return `私信发送触发内容审核限制提示${codeSuffix}`;
  if (/不支持|无法|不能|受限|限制|拒收|拉黑|关闭/.test(text)) return `私信发送受限（平台页面提示无法发送）${codeSuffix}`;
  return `私信发送失败（平台页面弹出错误提示）${codeSuffix}`;
}

function countLocalIds(messageList) {
  const counts = new Map();
  for (const raw of messageList ?? []) {
    const lid = normLocalId(raw?.message?.msgId);
    if (lid) counts.set(lid, (counts.get(lid) ?? 0) + 1);
  }
  return counts;
}

async function prepareDM({ page, params, t }) {
  const tg = params.target ?? {};
  const wantConvId = tg.conversationId != null && String(tg.conversationId).trim() !== '' ? String(tg.conversationId).trim() : null;
  const wantPeerUid = tg.peerUid != null && String(tg.peerUid).trim() !== '' ? String(tg.peerUid).trim() : null;
  if (!wantConvId && !wantPeerUid) {
    return { blocked: 'target-not-found', detail: '缺少目标会话 conversationId 和 peerUid，无法定位会话' };
  }
  const peerMatches = (list) => (wantPeerUid ? list.filter((s) => s.sessionInfo?.username === wantPeerUid) : []);
  const find = (list) => {
    if (wantConvId) return list.find((s) => String(s.sessionId) === wantConvId) ?? null;
    const hits = peerMatches(list);
    return hits.length === 1 ? hits[0] : null;
  };
  let list = await waitFor(async () => { const l = await dmSessions(page); return l.length ? l : null; }, t.loadMs, 1000);
  if (list && !find(list) && (wantConvId || peerMatches(list).length === 0)) {
    const maxScroll = params.maxScroll ?? LIMITS.maxScroll;
    for (let i = 0; i < maxScroll && !find(list); i++) {
      const scrolled = await inShadow(page, `const c = sr.querySelector('.session-container');
        if (c) {
          const prev = c.scrollTop;
          c.scrollTop = c.scrollHeight;
          if (c.scrollTop === prev) c.dispatchEvent(new Event('scroll'));
          return true;
        }
        const last = [...sr.querySelectorAll('.session-wrap')].at(-1);
        if (!last) return false;
        last.scrollIntoView({ block: 'end' });
        return true;`);
      if (!scrolled) break;
      await sleep(1500);
      const next = await dmSessions(page);
      if (!next.length) break;
      const grew = next.length > list.length;
      list = next;
      if (find(list) || (!wantConvId && peerMatches(list).length > 1) || !grew) break;
    }
  }
  if (list && !wantConvId && peerMatches(list).length > 1) {
    return { blocked: 'target-not-found', detail: `私信列表里用户 ${wantPeerUid} 匹配到多条会话，缺少 conversationId 无法唯一定位` };
  }
  const s = list && find(list);
  if (!s || s.sessionId == null || String(s.sessionId).trim() === '') {
    return { blocked: 'target-not-found', detail: `私信列表里没有会话 ${wantConvId ?? wantPeerUid}` };
  }
  const sid = String(s.sessionId);
  if (wantConvId && wantPeerUid && s.sessionInfo?.username && s.sessionInfo.username !== wantPeerUid) {
    return { blocked: 'target-not-found', detail: `会话 ${sid} 的对方账号与期望不符，没发` };
  }
  const bySid = (l) => l.find((x) => String(x.sessionId) === sid) ?? null;
  const peer = s.sessionInfo?.username ?? wantPeerUid;
  if (!peer) return { blocked: 'target-not-found', detail: `会话 ${sid} 缺少对方 username，无法判断收发方` };
  const lastIsMe = (x) => { const m = lastOf(x); return !!m && m.fromUsername !== peer; };
  if (lastIsMe(s)) return { blocked: 'last-is-me', detail: '会话最后一句是我说的' };
  const row = await mark(page, 'conv', FIND_ROW_SRC, sid);
  if (!row) return { blocked: 'target-not-found', detail: `读到了会话 ${sid} 的数据，但没找到能点开的会话行` };
  await inPage(page, `const el = __marked('conv'); if (!el) return false; el.scrollIntoView({ block: 'center' }); return true;`);
  await page.click(markSel('conv'), { label: 'open conversation' });
  const box = await waitFor(() => mark(page, 'box', `const sr = document.querySelector('wujie-app')?.shadowRoot; if (!sr) return null;
    const all = [...sr.querySelectorAll('textarea.edit_area')].filter((e) => e.getClientRects().length);
    return all.length === 1 ? all[0] : null;`), t.boxMs);
  if (box) {
    let opened = null;
    await waitFor(async () => {
      opened = await inShadow(page, READ_OPENED_SIDS_SRC, sid);
      return opened?.ok ? true : null;
    }, Math.min(t.boxMs, 1500), 200);
    if (!opened?.ok) {
      const ids = opened?.ids ?? [];
      return {
        blocked: 'target-not-found',
        detail: ids.length
          ? `点开后会话核对不一致（期望 ${sid}，读到 ${[...new Set(ids)].join('/')}），没发`
          : `点开后读不到聊天区当前是哪个会话，核对不了是不是 ${sid}，没发`,
      };
    }
  }
  const now = bySid(await dmSessions(page));
  if (now && lastIsMe(now)) return { blocked: 'last-is-me', detail: '打开会话后看到最后一句是我说的' };
  if (!box) return { blocked: 'no-input-box', detail: '打开会话后没有唯一的输入框（textarea.edit_area）' };
  const wantText = norm(params.text);
  let baseline = null;

  const snapshotBeforeClick = async () => {
    const verified = await inShadow(page, PRE_CLICK_VERIFY_SRC, sid);
    if (!verified?.ok) {
      await clearBox(page).catch(() => {});
      throw new Error(verified?.reason ?? '点击发送前页面状态校验失败');
    }
    const cur = bySid(await dmSessions(page));
    if (!cur) {
      await clearBox(page).catch(() => {});
      throw new Error(`点击发送前读不到目标会话 ${sid}`);
    }
    if (lastIsMe(cur)) {
      await clearBox(page).catch(() => {});
      throw new Error('点击发送前看到会话最后一句已是我说的');
    }
    const allLocalIds = new Set();
    const beforeSvrIds = new Set();
    let minePendingCount = 0;
    let mineAnonPendingCount = 0;
    let mineAnonUnsettledCount = 0;
    for (const raw of cur.messageList ?? []) {
      const m = raw?.message;
      if (!m) continue;
      const lid = normLocalId(m.msgId);
      if (lid) allLocalIds.add(lid);
      const svrId = validSvrMsgId(m.svrMsgId);
      if (svrId) beforeSvrIds.add(svrId);
      if (typeof raw.currentMsgStatus === 'number' && m.fromUsername !== peer) {
        if (raw.currentMsgStatus === 1) minePendingCount++;
        if (!lid) {
          if (raw.currentMsgStatus === 1) mineAnonPendingCount++;
          if (raw.currentMsgStatus === 1 || raw.currentMsgStatus === 3) mineAnonUnsettledCount++;
        }
      }
    }
    baseline = {
      allLocalIds,
      beforeSvrIds,
      minePendingCount,
      mineAnonPendingCount,
      mineAnonUnsettledCount,
      phoneDialogVisible: Boolean(await inPage(page, PHONE_DIALOG_SRC)),
      toasts: new Set((await toasts(page)) ?? []),
    };
    return cur;
  };

  return {
    send: dmSendSrc(sid),
    items: async () => {
      const isBaselinePass = !baseline;
      const cur = isBaselinePass ? await snapshotBeforeClick() : bySid(await dmSessions(page));
      const localIdCounts = countLocalIds(cur?.messageList);
      const out = [];
      for (const raw of cur?.messageList ?? []) {
        const m = raw?.message;
        if (!m) continue;
        const st = raw.currentMsgStatus;
        if (typeof st === 'number') {
          if (st === 1 || st === 3) continue;
          const okStatus = st === 2 || (st === 0 && !m.sendMsgFlag);
          const svrId = validSvrMsgId(m.svrMsgId);
          if (!okStatus || !svrId) continue;
          if (!isBaselinePass && m.fromUsername !== peer && !baseline.beforeSvrIds.has(svrId)) {
            const lid = normLocalId(m.msgId);
            if (lid && baseline.allLocalIds.has(lid)) continue;
            if (lid && (localIdCounts.get(lid) ?? 0) > 1) continue;
            if (!lid && baseline.minePendingCount > 0) continue;
          }
          out.push({ id: svrId, mine: m.fromUsername !== peer, rel: true, text: m.textMsg?.content ?? null });
        } else {
          out.push({ id: String(m.msgId ?? `${m.ts}:${m.fromUsername}`), mine: m.fromUsername !== peer, rel: true, text: m.textMsg?.content ?? null });
        }
      }
      return out;
    },
    apiError: async () => {
      if (!baseline) return null;
      const cur = bySid(await dmSessions(page));
      const phoneNow = Boolean(await inPage(page, PHONE_DIALOG_SRC));
      if (!baseline.phoneDialogVisible && phoneNow) {
        return '触发手机验证弹窗(.phone-check-dialog)，发送被风控拦截';
      }
      if (cur) {
        const localIdCounts = countLocalIds(cur.messageList);
        let curAnonUnsettledCount = 0;
        let hasAnonNewMineSuccess = false;
        const sameTextNewMineWithId = [];
        for (const raw of cur.messageList ?? []) {
          const m = raw?.message;
          const st = raw?.currentMsgStatus;
          if (!m || typeof st !== 'number' || m.fromUsername === peer) continue;
          const lid = normLocalId(m.msgId);
          if (!lid) {
            if (st === 1 || st === 3) curAnonUnsettledCount++;
            const svrId = validSvrMsgId(m.svrMsgId);
            if ((st === 2 && (!svrId || !baseline.beforeSvrIds.has(svrId))) || (st === 0 && !m.sendMsgFlag && svrId && !baseline.beforeSvrIds.has(svrId))) {
              hasAnonNewMineSuccess = true;
            }
            continue;
          }
          if (baseline.allLocalIds.has(lid)) continue;
          if (norm(m.textMsg?.content) === wantText) sameTextNewMineWithId.push({ raw, lid });
        }
        const noAnonAmbiguity = curAnonUnsettledCount === baseline.mineAnonUnsettledCount && !hasAnonNewMineSuccess;
        if (noAnonAmbiguity && sameTextNewMineWithId.length === 1) {
          const { raw, lid } = sameTextNewMineWithId[0];
          if (raw.currentMsgStatus === 3 && (localIdCounts.get(lid) ?? 0) === 1) {
            return raw.outLimitWarn
              ? '私信发送失败（页面消息状态 Failure，触发条数/频控限制）'
              : '私信发送失败（页面消息状态 Failure）';
          }
        }
      }
      const newToast = ((await toasts(page)) ?? []).find((x) => !baseline.toasts.has(x));
      if (newToast) return sanitizeToastError(newToast);
      return null;
    },
    diagnose: async () => {
      if (!baseline) return null;
      const cur = bySid(await dmSessions(page));
      if (!cur) return null;
      let curAnonPendingCount = 0;
      let hasNewPending = false;
      let hasNewNoSvrSuccess = false;
      for (const raw of cur.messageList ?? []) {
        const m = raw?.message;
        const st = raw?.currentMsgStatus;
        if (!m || typeof st !== 'number' || m.fromUsername === peer) continue;
        const lid = normLocalId(m.msgId);
        if (!lid) {
          if (st === 1) curAnonPendingCount++;
          continue;
        }
        if (baseline.allLocalIds.has(lid)) continue;
        if (norm(m.textMsg?.content) !== wantText) continue;
        if (st === 1) hasNewPending = true;
        if (st === 2 && !validSvrMsgId(m.svrMsgId)) hasNewNoSvrSuccess = true;
      }
      if (hasNewPending || curAnonPendingCount > baseline.mineAnonPendingCount) {
        return '消息仍处于发送中(Pending)，未拿到服务端 svrMsgId';
      }
      if (hasNewNoSvrSuccess) return '消息状态为 Success 但未拿到有效服务端 svrMsgId';
      return null;
    },
  };
}
