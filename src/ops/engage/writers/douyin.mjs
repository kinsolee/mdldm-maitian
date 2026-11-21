// 抖音页面写入：回复评论（评论管理页）、发私信（私信页）。和读适配器 adapters/douyin.mjs 用同一套页面。
//   账号：GET /web/api/media/user/info/ 的 user.uid（同读适配器），status_code=8 算掉线。
//   回复：评论区元素的 React fiber 往上找评论，再并上页面自己发的 comment/list/select、comment/list/reply 等响应（installHook 抄回）
//        里的评论对象；两边对不上时以接口响应为准。真实页面（2026-11-21 只读核对）fiber 上是视图模型，不是接口对象：
//          评论块 div.container-*：组件 props { id, content, uid, levelOneCid, username, replyComments: { count } }；
//          操作区 [class*=operations-] > div.item-*（图标 + 「回复」「删除」「举报」）：按钮往上 3 层组件 props { cid, levelOneCid, uid, replyToUserName }。
//        视图模型里没有「直接回复的是谁」（reply_to_reply_id），这个只能从接口响应拿。
//        目标不在当前作品就点「选择作品」切过去（读适配器的 switchTo，作品列表要翻页）；一楼没加载到目标就滚到页面底部翻页；
//        目标所在楼没展开完就点「查看 N 条回复」（只读）。
//        「已有我的回复」：同楼里有 user.uid 是我、reply_to_reply_id 指向目标（目标是一楼时 reply_id 是它、reply_to_reply_id 为 "0"）的。
//        输入框只用 [class*=reply-content-] [contenteditable=true]（页面顶部另有一个发一级评论的框，类名一样但不在 reply-content- 里，绝不碰）。
//        发送按钮只认这个 reply-content- 里文字是「发送」、没 disabled 的 button（框里没字时页面给它 disabled）。
//   私信：li.semi-list-item 的 fiber 往上 2 层 memoizedProps.item（IM SDK Conversation，同读适配器），lastMessage.isFromMe 判最后一句；
//        点开会话后，再从聊天区元素的 fiber 里找消息对象（isFromMe、content、clientMessageId / serverId、conversationId）复核和回读。
//        输入框只用 [class*=chat-editor-] [contenteditable=true]。
// 不点赞、不置顶、不删除、不调页面 Context 上的写函数。
import { EXPAND_SRC, switchTo } from '../adapters/douyin.mjs';
import { bigJson, clickMarked, sleep } from '../adapters/page-lib.mjs';
import { capturedJson, findObjects, inPage, mark, markSel, runWrite, sendNearBox, waitFor } from './page-write-lib.mjs';

export const FILE = 'douyin.mjs';
export const PAGES = {
  comments: 'https://creator.douyin.com/creator-micro/interactive/comment',
  dms: 'https://creator.douyin.com/creator-micro/data/following/chat',
};
// maxPickerPages：「选择作品」作品列表最多翻几页（每页 20 个）；maxCommentPages：一楼最多加载几页（每页 10 条）
export const LIMITS = { maxExpand: 25, maxPickerPages: 10, maxCommentPages: 30 };

export function runInSpace(task, params) {
  return runWrite(task, params, { hook: true, url, login, prepareReply, prepareDM });
}

const url = (p) => (p.op === 'reply' ? p.urls?.comments ?? PAGES.comments : p.urls?.dms ?? PAGES.dms);

async function login(page, params, t) {
  // 测试钩子：本地测试页没有 user/info 接口，从页面全局读（只在 params 里显式给了才走）
  if (params.test?.loginFromPage) {
    const u = await page.evaluate(() => window.__loginUser ?? null);
    return { uid: u?.uid ?? null, nickname: u?.nickname ?? null };
  }
  await sleep(t.settleMs);
  const r = await page.fetch('/web/api/media/user/info/', { timeout: 15000 }).catch(() => null);
  const info = bigJson(String(r?.body ?? ''));
  if (info?.status_code === 8) return { loginLost: true, evidence: 'GET /web/api/media/user/info/ status_code=8' };
  if (info?.status_code !== 0) return { uid: null, detail: `GET /web/api/media/user/info/ ${info ? `status_code=${info.status_code}` : '请求失败或不是 JSON'}` };
  return { uid: info.user?.uid ?? info.user_info?.uid ?? null, nickname: info.user?.nickname ?? null };
}

// —— 页面里读 React fiber ——
const FIBER = `const __fiber = (el) => { const k = Object.keys(el).find((k) => k.startsWith('__reactFiber')); return k ? el[k] : null; };
const __findUp = (el, pick, levels = 8, depth = 15) => {
  for (let e = el, i = 0; e && i < levels; e = e.parentElement, i++)
    for (let f = __fiber(e), j = 0; f && j < depth; f = f.return, j++) { const p = f.memoizedProps; if (p && typeof p === 'object') { const v = pick(p); if (v) return v; } }
  return null; };
// 评论对象：接口形状 { cid, text } 原样；评论块的视图模型 { id, content, levelOneCid } 转成接口形状（拿不到 reply_to_reply_id，留空）
const __asComment = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (v.cid != null && 'text' in v) return v;
  if (v.id != null && 'content' in v && 'levelOneCid' in v) {
    const one = v.levelOneCid == null || String(v.levelOneCid) === String(v.id);
    return { cid: v.id, text: v.content ?? '', user: v.uid != null ? { uid: v.uid } : null, reply_id: one ? '0' : v.levelOneCid,
      reply_comment_total: one && v.replyComments && Number.isFinite(Number(v.replyComments.count)) ? Number(v.replyComments.count) : null };
  }
  return null; };
const __pickComment = (p) => __asComment(p) || Object.values(p).map(__asComment).find(Boolean) || null;
// 元素属于哪条评论：评论对象的 cid，或操作区组件 props 的 cid（按钮、回复框往上先碰到的是它）
const __pickCid = (p) => { const c = __pickComment(p); if (c) return String(c.cid); return p.cid != null && 'levelOneCid' in p ? String(p.cid) : null; };
const __GONE = /^(该评论已(被)?删除|评论已(被)?删除)/;
`;

/** 评论对象 → 比对用的形状。root：所在楼的一楼（一楼自己为 null）；to：直接回复的那条（回复一楼时为 null）；
 *  toKnown：知不知道直接回复的是谁。接口对象带 reply_to_reply_id（"0" 是回一楼），页面视图模型没有，为 false。 */
export function slimComment(c) {
  const s = (v) => (v == null || String(v) === '0' || v === '' ? null : String(v));
  return { id: String(c.cid), uid: c.user?.uid != null ? String(c.user.uid) : null, text: c.text ?? '', root: s(c.reply_id), to: s(c.reply_to_reply_id), toKnown: c.reply_to_reply_id != null,
    aweme: s(c.aweme_id), total: Number.isFinite(Number(c.reply_comment_total)) && c.reply_comment_total != null ? Number(c.reply_comment_total) : null };
}
/** 直接回复的对象：楼中楼回复楼中楼时是 to，回复一楼时是 root；一楼自己、以及楼中楼不知道回的是谁时为 null。 */
export const directTo = (x) => (x.root == null ? null : x.to ?? (x.toKnown ? x.root : null));

const COMMENTS_SRC = FIBER + `const out = {};
  for (const el of document.querySelectorAll('[class*=comment], [class*=reply], [class*=operations-]')) {
    if (el.closest('[class*=reply-content-]')) continue;
    const c = __findUp(el, __pickComment, 1);
    if (c) out[String(c.cid)] = c;
  }
  const gone = [];
  for (const leaf of document.querySelectorAll('div, span, p')) {
    if (leaf.children.length || !__GONE.test((leaf.textContent || '').trim())) continue;
    const c = __findUp(leaf, __pickComment);
    if (c) gone.push(String(c.cid));
  }
  return { list: Object.values(out).map((c) => ({ cid: c.cid, aweme_id: c.aweme_id, user: c.user ? { uid: c.user.uid } : null, text: c.text, reply_id: c.reply_id, reply_to_reply_id: c.reply_to_reply_id, reply_comment_total: c.reply_comment_total })), gone };`;

/** 页面上能看到的评论（fiber）并上抓到的接口响应里的评论，按 cid 去重。 */
async function comments(page) {
  const { list, gone } = await inPage(page, COMMENTS_SRC);
  const fromCap = (await capturedJson(page, 'comment')).flatMap((c) => findObjects(c.json, (o) => o.cid != null && 'text' in o && typeof o.text === 'string'));
  const m = new Map();
  // 页面上的在前、接口响应在后：同一条两边都有时接口的字段盖过页面的（视图模型缺 reply_to_reply_id、aweme_id）
  for (const c of [...list, ...fromCap]) { const x = slimComment(c); m.set(x.id, { ...m.get(x.id), ...Object.fromEntries(Object.entries(x).filter(([, v]) => v != null)) }); }
  for (const id of gone) if (m.has(id)) m.get(id).gone = true;
  return [...m.values()].map((x) => ({ root: null, to: null, toKnown: false, uid: null, aweme: null, total: null, gone: false, ...x }));
}

// 回复框所在 reply-content- 里唯一的、可点的「发送」button（没字时页面给它 disabled，点了没反应却会被记成点过发送）
const SEND = `const box = __marked('box'); const rc = box && box.closest('[class*=reply-content-]'); if (!rc) return null;
  const hits = [...rc.querySelectorAll('button')].filter((b) => (b.innerText || b.textContent || '').trim() === '发送');
  if (hits.length !== 1) return null;
  const b = hits[0];
  return b.disabled || b.getAttribute('aria-disabled') === 'true' ? null : b;`;

const PICKER = `return !![...document.querySelectorAll('button, [class*=-button]')].find((e) => e.textContent.trim() === '选择作品');`;
const SELECT = 'comment/list/select';
const SCROLL_BOTTOM = `const e = document.scrollingElement || document.documentElement; e.scrollTop = e.scrollHeight; window.dispatchEvent(new Event('scroll')); return true;`;
const hasMore = (j) => j != null && j.has_more !== 0 && j.has_more !== false && j.has_more != null;
/** 抓到的一楼列表响应（按到达顺序）；给了作品就只要评论都属于这个作品的（空页不知道属于谁，不算）。 */
async function selectPages(page, work) {
  return (await capturedJson(page, SELECT)).map((c) => c.json)
    .filter((j) => j.status_code === 0 && Array.isArray(j.comments) && (!work || (j.comments.length && j.comments.every((c) => String(c.aweme_id) === work))));
}

async function prepareReply({ page, params, t, me }) {
  const tg = params.target ?? {};
  const id = String(tg.commentId);
  const root = tg.rootId != null ? String(tg.rootId) : tg.parentId != null ? String(tg.parentId) : id;
  const work = tg.workId != null ? String(tg.workId) : null;
  const max = params.maxExpand ?? LIMITS.maxExpand;
  // 等默认作品的一楼列表到了再往下走：「选择作品」按钮比它早几秒出来，这时切走的话，它晚到的响应会把列表盖回默认作品（2026-11-21 实测）。
  // 默认作品没有评论时页面也发 comment/list/select，所以看接口响应，不只看页面上有没有评论
  await waitFor(async () => (await capturedJson(page, SELECT)).length > 0 || (await comments(page)).length > 0, t.loadMs, 1000);
  let list = await comments(page);
  if (!list.some((x) => x.id === id) && work && !list.some((x) => x.aweme === work) && (await waitFor(() => inPage(page, PICKER), Math.min(t.loadMs, 30000), 1000))) {
    const sw = await switchTo(page, work, { maxPages: params.maxPickerPages ?? LIMITS.maxPickerPages });
    if (!sw.ok) return { blocked: 'target-not-found', detail: `切不到作品 ${work}：${sw.detail}` };
    await waitFor(async () => (await comments(page)).some((x) => x.aweme === work || x.id === id), Math.min(t.loadMs, 20000), 1000);
    list = await comments(page);
  }
  // 一楼每页 10 条，滚到页面底部才加载下一页。目标（或它所在的楼）没出现、接口说还有下一页（has_more），就往下翻，最多 maxCommentPages 页。
  // 页面底部「没有更多评论」还有下一页时也显示，只认接口的 has_more
  const maxPages = params.maxCommentPages ?? LIMITS.maxCommentPages;
  let pages = (await selectPages(page, work)).length;
  const seen = () => list.some((x) => x.id === id || x.id === root);
  while (!seen() && pages < maxPages && hasMore((await selectPages(page, work)).at(-1))) {
    await inPage(page, SCROLL_BOTTOM);
    const before = pages;
    pages = (await waitFor(async () => { const n = (await selectPages(page, work)).length; return n > before ? n : 0; }, Math.min(t.loadMs, 10000), 500)) || before;
    list = await comments(page);
    if (pages === before) break;
  }
  const paging = seen() ? '' : hasMore((await selectPages(page, work)).at(-1))
    ? `；一楼加载了 ${pages} 页${pages >= maxPages ? '到上限' : '，再滚也没加载出下一页'}，还有更多`
    : `；一楼已翻到底（${pages} 页）`;
  // 目标没出现、或目标所在楼的子回复没加载全（判「已回复」要看全楼），就点「查看 N 条回复」
  for (let i = 0; i < max; i++) {
    const hit = list.find((x) => x.id === id);
    const r = list.find((x) => x.id === root);
    const loaded = list.filter((x) => x.root === root).length;
    if (hit && r && r.total != null && loaded >= r.total) break;
    if (!(await clickMarked(page, `() => (${EXPAND_SRC})().find((e) => !e.dataset.engDead)`, 'expand comment replies'))) break;
    await page.evaluate(() => document.querySelector('[data-eng-click]')?.setAttribute('data-eng-dead', '1'));
    await sleep(1200);
    list = await comments(page);
  }
  const hit = list.find((x) => x.id === id);
  if (!hit) return { blocked: 'target-not-found', detail: `评论管理页上没找到评论 ${id}${work ? `（作品 ${work}）` : ''}${paging}` };
  if (hit.gone) return { blocked: 'comment-gone', detail: `评论 ${id} 显示已删除` };
  const mine = (x) => x.uid != null && x.uid === String(me.uid);
  const prior = list.find((x) => mine(x) && x.id !== id && directTo(x) === id);
  if (prior) return { blocked: 'already-replied', detail: `评论 ${id} 下已有我的回复 ${prior.id}` };
  // 楼里有我的回复、但只从页面视图模型读到（没抓到楼中楼接口），不知道它回的是谁：可能就是回目标的，不发
  const unsure = list.find((x) => mine(x) && x.id !== id && x.root === root && !x.toKnown);
  if (unsure) return { blocked: 'thread-incomplete', detail: `楼 ${root} 里有我的回复 ${unsure.id}，但读不到它回的是哪条，判断不了是否已回复，没发` };
  // 展开到上限还没加载全：看不到的那部分可能有我的旧回复，不发
  const r = list.find((x) => x.id === root);
  const loaded = list.filter((x) => x.root === root).length;
  const leftButtons = await inPage(page, `return (${EXPAND_SRC})().length`);
  if ((r?.total != null && loaded < r.total) || (r?.total == null && leftButtons > 0)) {
    return { blocked: 'thread-incomplete', detail: `楼 ${root} 的回复没加载全（已加载 ${loaded}${r?.total != null ? ` / ${r.total}` : ''}），判断不了是否已回复，没发` };
  }

  // 「回复」：操作区的子元素，文字（去掉空白、图标没有文字）等于「回复」，并且按 fiber 属于目标评论。hover 前后都在，不用 hover
  const found = await mark(page, 'reply', FIBER + `return [...document.querySelectorAll('[class*=operations-] > *')]
    .find((e) => (e.textContent || '').replace(/\\s+/g, '') === '回复' && __findUp(e, __pickCid) === arg) || null;`, id);
  if (!found) return { blocked: 'target-not-found', detail: `找到了评论 ${id}，但没找到它的「回复」按钮` };
  await page.click(markSel('reply'), { label: 'open reply box' });
  // 只认 reply-content- 里、按 fiber 属于目标评论的那个框；页面上开着的是别人的框（点偏了）就不写
  const box = await waitFor(() => mark(page, 'box', FIBER + `const all = [...document.querySelectorAll('[class*=reply-content-] [contenteditable=true]')].filter((e) => e.getClientRects().length);
    const own = all.filter((e) => __findUp(e, __pickCid) === arg);
    return own.length === 1 ? own[0] : null;`, id), t.boxMs);
  if (!box) return { blocked: 'no-input-box', detail: '点了「回复」后没出现属于这条评论的唯一回复框（[class*=reply-content-] [contenteditable=true]）' };
  return {
    send: SEND,
    items: async () => (await comments(page)).map((x) => ({ id: x.id, mine: mine(x), rel: directTo(x) === id, text: x.text })),
    // 点发送后页面自己发的评论写接口（不是 list 类读接口）返回 status_code≠0
    apiError: async (from) => {
      const bad = (await capturedJson(page, 'comment/(?!list)', from)).find((c) => c.json.status_code != null && c.json.status_code !== 0);
      return bad ? `${bad.url.replace(/^https?:\/\/[^/]+/, '')} status_code=${bad.json.status_code}${bad.json.status_msg ? ` ${bad.json.status_msg}` : ''}` : null;
    },
  };
}

// —— 私信 ——
const CONVS_SRC = `return [...document.querySelectorAll('li.semi-list-item')].map((li, i) => {
    const k = Object.keys(li).find((k) => k.startsWith('__reactFiber'));
    let f = k && li[k]; for (let j = 0; j < 2 && f; j++) f = f.return;
    const it = f?.memoizedProps?.item;
    if (!it) return null;
    return { i, id: String(it.id), peer: it.toParticipantUserId != null ? String(it.toParticipantUserId) : null, group: !!(it.isGroupChat ?? it.type === 2),
      lastFromMe: it.lastMessage ? !!it.lastMessage.isFromMe : null };
  }).filter(Boolean);`;

// 聊天区里的消息对象（IM SDK Message）；带 conversationId 的只收这个会话的
const MSGS_SRC = FIBER + `const out = {};
  for (const el of document.querySelectorAll('body *')) {
    for (let f = __fiber(el), j = 0; f && j < 6; f = f.return, j++) {
      const p = f.memoizedProps; if (!p || typeof p !== 'object') continue;
      for (const v of [p, ...Object.values(p)]) {
        if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.isFromMe !== 'boolean' || !('content' in v) || (v.clientMessageId == null && v.serverId == null)) continue;
        if (v.conversationId != null && String(v.conversationId) !== arg) continue;
        let text = null; try { text = JSON.parse(v.content)?.text ?? null; } catch {}
        const id = String(v.clientMessageId ?? v.serverId);
        out[id] = { id, mine: v.isFromMe, text, at: v.createdAt != null ? new Date(v.createdAt).getTime() || Number(v.createdAt) || null : null };
      }
    }
  }
  return Object.values(out);`;

// 聊天区里有没有 conversationId 等于 arg 的消息对象
const CONV_OPEN_SRC = FIBER + `for (const el of document.querySelectorAll('body *')) {
    for (let f = __fiber(el), j = 0; f && j < 6; f = f.return, j++) {
      const p = f.memoizedProps; if (!p || typeof p !== 'object') continue;
      for (const v of [p, ...Object.values(p)]) if (v && typeof v === 'object' && typeof v.isFromMe === 'boolean' && v.conversationId != null && String(v.conversationId) === arg) return true;
    }
  }
  return false;`;

async function prepareDM({ page, params, t }) {
  const tg = params.target ?? {};
  await waitFor(async () => (await inPage(page, CONVS_SRC)).length > 0, t.loadMs, 1000);
  const convs = await inPage(page, CONVS_SRC);
  const c = convs.find((x) => x.id === String(tg.conversationId)) ?? (tg.peerUid != null ? convs.find((x) => !x.group && x.peer === String(tg.peerUid)) : null);
  if (!c) return { blocked: 'target-not-found', detail: `私信列表里没有会话 ${tg.conversationId ?? tg.peerUid}（列表只显示最近的会话）` };
  if (c.group) return { blocked: 'cannot-send', detail: '群聊不发' };
  if (c.lastFromMe === true) return { blocked: 'last-is-me', detail: '会话最后一句是我说的' };
  // 按会话 id 现找那一行（不用下标：新私信会把会话顶到前面，下标会指到别人）
  const row = await mark(page, 'conv', `return [...document.querySelectorAll('li.semi-list-item')].find((li) => {
    const k = Object.keys(li).find((k) => k.startsWith('__reactFiber'));
    let f = k && li[k]; for (let j = 0; j < 2 && f; j++) f = f.return;
    return String(f?.memoizedProps?.item?.id) === arg;
  }) ?? null;`, c.id);
  if (!row) return { blocked: 'target-not-found', detail: `会话 ${c.id} 在列表里找不到了` };
  await page.click(markSel('conv'), { label: 'open conversation' });
  const box = await waitFor(() => mark(page, 'box', `const all = [...document.querySelectorAll('[class*=chat-editor-] [contenteditable=true]')].filter((e) => e.getClientRects().length);
    return all.length === 1 ? all[0] : null;`), t.boxMs);
  // 点开的必须是这个会话：聊天区里要有 conversationId 等于它的消息，否则可能开到了别人的会话
  const opened = await waitFor(() => inPage(page, CONV_OPEN_SRC, c.id), Math.min(t.boxMs, 10000));
  if (!opened) return { blocked: 'target-not-found', detail: `点开后聊天区里没有会话 ${c.id} 的消息，可能开错了会话，没发` };
  // 打开后再看一次最后一句（聊天区的消息比列表新）
  const msgs = await inPage(page, MSGS_SRC, c.id);
  const last = [...msgs].filter((m) => m.at != null).sort((a, b) => b.at - a.at)[0];
  if (last?.mine) return { blocked: 'last-is-me', detail: '打开会话后看到最后一句是我说的' };
  if (!box) return { blocked: 'no-input-box', detail: '打开会话后没有唯一的输入框（[class*=chat-editor-] [contenteditable=true]）' };
  return {
    send: (await mark(page, 'send', sendNearBox('^发送$'))) ? sendNearBox('^发送$') : 'enter',
    items: async () => (await inPage(page, MSGS_SRC, c.id)).map((m) => ({ id: m.id, mine: m.mine, rel: true, text: m.text })),
  };
}
