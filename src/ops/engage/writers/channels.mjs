// 视频号页面写入：回复评论（互动管理 → 评论）、发私信（私信页）。和读适配器 adapters/channels.mjs 用同一套页面。
// 业务页面在 wujie 微前端的开放 shadowRoot 里，读 Vue 2 组件数据（元素上的 __vue__）；page.click 的选择器能进开放的 shadowRoot（S0）。
//   账号：POST auth/auth_data 的 finderUser.uniqId 核对账号（同读适配器的 uidSeen），errCode≠0 算掉线。
//        平台不给评论者 uid，「是不是我」按昵称：页面上的 finderUser.nickname，没有再用 params.nickname。
//   回复：左侧作品列表组件的 commentFeeds 找到 objectNonce（或 objectId）等于 workId 的作品点开，
//        读 .comment-item 的 __vue__.$props.dataSource（二楼同时在一楼的 levelTwoComment 里），找不到就点「展开更多回复」（只读）。
//        「已有我的回复」：昵称是我、直接回复的是目标（replyCommentId 是它；嵌在它 levelTwoComment 里且没有 replyCommentId 也算）。
//        回复入口 .weui-icon-outlined-comment，输入框 textarea.create-input。
//   私信：.session-wrap 往上的 Vue 实例 $data.sessionList（同读适配器）；messageList 取 ts 最大的判最后一句
//        （fromUsername == sessionInfo.username 是对方）。输入框 textarea.edit_area。
// 不点 .like-action、不置顶、不删除。
import { FEEDS_SRC, SESSIONS_SRC } from '../adapters/channels.mjs';
import { clickMarked, sleep } from '../adapters/page-lib.mjs';
import { inPage, mark, markSel, runWrite, sendNearBox, waitFor } from './page-write-lib.mjs';

export const FILE = 'channels.mjs';
export const PAGES = {
  comments: 'https://channels.weixin.qq.com/platform/interaction/comment',
  dms: 'https://channels.weixin.qq.com/platform/private_msg',
};
export const LIMITS = { maxExpand: 15, maxScroll: 6 };

export function runInSpace(task, params) {
  return runWrite(task, params, { hook: false, url, login, prepareReply, prepareDM });
}

const url = (p) => (p.op === 'reply' ? p.urls?.comments ?? PAGES.comments : p.urls?.dms ?? PAGES.dms);

async function login(page, params, t) {
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
    return own.length === 1 ? own[0] : all.length === 1 ? all[0] : null;`, id), t.boxMs);
  if (!box) return { blocked: 'no-input-box', detail: '点了回复后没出现唯一的回复框（textarea.create-input）' };
  return {
    send: sendNearBox('^(发送|回复)$', 3),
    items: async () => (await items(page)).map((x) => ({ id: x.id, mine: x.nick === myNick, rel: directTo(x) === id, text: x.text })),
  };
}

// —— 私信 ——
const sessions = async (page) => (await inShadow(page, SESSIONS_SRC)) ?? [];
const lastOf = (s) => [...(s.messageList ?? [])].map((m) => m.message).filter((m) => m && m.ts != null).sort((a, b) => Number(b.ts) - Number(a.ts))[0] ?? null;

async function prepareDM({ page, params, t }) {
  const tg = params.target ?? {};
  const find = (list) => list.find((s) => String(s.sessionId) === String(tg.conversationId)) ?? (tg.peerUid != null ? list.find((s) => s.sessionInfo?.username === String(tg.peerUid)) : null);
  const list = await waitFor(async () => { const l = await sessions(page); return l.length ? l : null; }, t.loadMs, 1000);
  const s = list && find(list);
  if (!s) return { blocked: 'target-not-found', detail: `私信列表里没有会话 ${tg.conversationId ?? tg.peerUid}` };
  const peer = s.sessionInfo?.username ?? null;
  const lastIsMe = (x) => { const m = lastOf(x); return !!m && m.fromUsername !== peer; };
  if (lastIsMe(s)) return { blocked: 'last-is-me', detail: '会话最后一句是我说的' };
  const sid = String(s.sessionId);
  // 会话行：shadowRoot 里 __vue__.$props 带这个 sessionId 的第一个元素
  const row = await mark(page, 'conv', `const sr = document.querySelector('wujie-app')?.shadowRoot; if (!sr) return null;
    for (const e of sr.querySelectorAll('*')) { const p = e.__vue__?.$props; if (p && Object.values(p).some((v) => v && typeof v === 'object' && (String(v.sessionId) === arg || String(v.sessionInfo?.sessionId) === arg))) return e; }
    return null;`, sid);
  if (!row) return { blocked: 'target-not-found', detail: `读到了会话 ${sid} 的数据，但没找到能点开的会话行` };
  await page.click(markSel('conv'), { label: 'open conversation' });
  const box = await waitFor(() => mark(page, 'box', `const sr = document.querySelector('wujie-app')?.shadowRoot; if (!sr) return null;
    const all = [...sr.querySelectorAll('textarea.edit_area')].filter((e) => e.getClientRects().length);
    return all.length === 1 ? all[0] : null;`), t.boxMs);
  // 点开的必须是这个会话：从输入框往上找聊天区组件，它 props / data 里带的会话 id 要等于 sid（同抖音按 conversationId 核对）
  const openedSid = await inPage(page, `const sr = document.querySelector('wujie-app')?.shadowRoot; if (!sr) return null;
    const box = __marked('box');   // 前面 mark 标出的那个可见输入框
    const idOf = (v) => (v && typeof v === 'object' ? v.sessionId ?? v.sessionInfo?.sessionId ?? null : null);
    for (let e = box, i = 0; e && i < 12; e = e.parentElement || e.getRootNode()?.host, i++) {
      const vm = e.__vue__; if (!vm) continue;
      for (const bag of [vm.$props, vm.$data]) { const own = idOf(bag); if (own != null) return String(own); }
      for (const bag of [vm.$props, vm.$data]) for (const v of Object.values(bag ?? {})) { const id = idOf(v); if (id != null) return String(id); }
    }
    return null;`);
  if (box && openedSid !== sid) return { blocked: 'target-not-found', detail: openedSid ? `点开的是会话 ${openedSid}，不是 ${sid}，没发` : `点开后读不到聊天区当前是哪个会话，核对不了是不是 ${sid}，没发` };
  const now = find(await sessions(page));
  if (now && lastIsMe(now)) return { blocked: 'last-is-me', detail: '打开会话后看到最后一句是我说的' };
  if (!box) return { blocked: 'no-input-box', detail: '打开会话后没有唯一的输入框（textarea.edit_area）' };
  return {
    send: sendNearBox('^发送$', 3),
    items: async () => {
      const cur = find(await sessions(page));
      return (cur?.messageList ?? []).map((m) => m.message).filter(Boolean)
        .map((m) => ({ id: String(m.msgId ?? `${m.ts}:${m.fromUsername}`), mine: m.fromUsername !== peer, rel: true, text: m.textMsg?.content ?? null }));
    },
  };
}
