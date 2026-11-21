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
import { bigJson, capCount, clickMarked, sleep } from '../adapters/page-lib.mjs';
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
      reply_comment_total: one && v.replyComments ? __count(v.replyComments.count) : null };
  }
  return null; };
// 楼中楼总数：只认数字或数字字符串；null、''、布尔值算不知道（Number(null)、Number('') 都是 0）
const __count = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v)) ? Number(v) : null;
const __pickComment = (p) => __asComment(p) || Object.values(p).map(__asComment).find(Boolean) || null;
// 元素属于哪条评论：评论对象的 cid，或操作区组件 props 的 cid（按钮、回复框往上先碰到的是它）
const __pickCid = (p) => { const c = __pickComment(p); if (c) return String(c.cid); return p.cid != null && 'levelOneCid' in p ? String(p.cid) : null; };
const __GONE = /^(该评论已(被)?删除|评论已(被)?删除)/;
`;

/** 评论对象 → 比对用的形状。root：所在楼的一楼（一楼自己为 null）；to：直接回复的那条（回复一楼时为 null）；
 *  toKnown：知不知道直接回复的是谁。接口对象带 reply_to_reply_id（"0" 是回一楼），页面视图模型没有，为 false。 */
const countOf = (v) => ((typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v)) ? Number(v) : null);
export function slimComment(c) {
  const s = (v) => (v == null || String(v) === '0' || v === '' ? null : String(v));
  return { id: String(c.cid), uid: c.user?.uid != null ? String(c.user.uid) : null, text: c.text ?? '', root: s(c.reply_id), to: s(c.reply_to_reply_id), toKnown: c.reply_to_reply_id != null,
    aweme: s(c.aweme_id), total: countOf(c.reply_comment_total) };
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
/**
 * 第 from 条起抓到的一楼列表响应，先按作品过滤、再按 URL（带 cursor）去重（同一页留最后一次），按到达顺序。
 * 给了作品时，有评论的页要全部属于这个作品；空页、出错页算这个作品的：from 取在切作品之前，这之后的只会是这个作品的。
 * 只有 status_code === 0 且有 comments 数组的才算有效页；缺 status_code、非 0、没有 comments 的记成 error（第一条）。
 */
async function selectPages(page, work, from = 0) {
  const caps = (await capturedJson(page, SELECT, from)).filter((c) => !work || !Array.isArray(c.json.comments) || c.json.comments.every((x) => String(x.aweme_id) === work));
  const ok = (j) => j.status_code === 0 && Array.isArray(j.comments);
  const bad = caps.find((c) => !ok(c.json));
  const byUrl = new Map();
  for (const c of caps) if (ok(c.json)) { byUrl.delete(c.url); byUrl.set(c.url, c.json); }
  return { pages: [...byUrl.values()], error: bad ? `status_code=${bad.json.status_code ?? '缺失'}${bad.json.status_msg ? ` ${bad.json.status_msg}` : ''}${Array.isArray(bad.json.comments) ? '' : '，没有 comments'}` : null };
}
// 页面上（fiber）渲染出来了这条评论（接口响应比渲染早到，「回复」按钮、「已删除」都要等渲染）
const RENDERED = FIBER + `for (const el of document.querySelectorAll('[class*=comment], [class*=reply], [class*=operations-]')) {
    if (el.closest('[class*=reply-content-]')) continue;
    const c = __findUp(el, __pickComment, 1);
    if (c && String(c.cid) === arg) return true;
  }
  return false;`;
// 「查看 N 条回复」：先点属于 ROOT 这栋楼的（按 fiber 往上找到的评论是这栋楼的一楼）。
// 没有时：STRICT（这栋楼已经加载出来）只退回认不出属于哪条的按钮（结构变了时照旧能展开），不点明确属于别的楼的；否则退回页面上第一个
const EXPAND_FOR = (root, strict) => `() => { ${FIBER} const all = (${EXPAND_SRC})().filter((e) => !e.dataset.engDead);
  const own = all.find((e) => __findUp(e, __pickCid) === ${JSON.stringify(root)}); if (own) return own;
  return ${strict ? 'all.find((e) => __findUp(e, __pickCid) == null)' : 'all[0]'} ?? null; }`;

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
  // 一楼列表从第 from 条抓到的响应算起：切了作品就从切之前算，没切就从头算（当前作品就是目标作品，或没给作品）
  let from = 0;
  if (!list.some((x) => x.id === id) && work && !list.some((x) => x.aweme === work)) {
    if (!(await waitFor(() => inPage(page, PICKER), Math.min(t.loadMs, 30000), 1000))) return { blocked: 'target-not-found', detail: `评论 ${id} 在作品 ${work}，当前不是这个作品，页面上没有「选择作品」按钮，切不过去` };
    from = await capCount(page);
    const sw = await switchTo(page, work, { maxPages: params.maxPickerPages ?? LIMITS.maxPickerPages });
    if (!sw.ok) return { blocked: 'target-not-found', detail: `切不到作品 ${work}：${sw.detail}` };
    const waitMs = Math.min(t.loadMs, 20000);
    const got = await waitFor(async () => { const x = await selectPages(page, work, from); return x.pages.length > 0 || !!x.error || (await comments(page)).some((c) => c.aweme === work || c.id === id); }, waitMs, 1000);
    if (!got) {
      const { error } = await selectPages(page, work, from);
      return { blocked: 'target-not-found', detail: `切到作品 ${work} 后 ${Math.round(waitMs / 1000)} 秒内没加载出它的一楼列表${error ? `（接口 ${error}）` : ''}` };
    }
    list = await comments(page);
  }
  // 一楼每页 10 条，滚到页面底部才加载下一页。目标（或它所在的楼）没出现、接口说还有下一页（has_more），就往下翻，最多 maxCommentPages 页。
  // 页面底部「没有更多评论」还有下一页时也显示，只认接口的 has_more。响应比渲染早到，页面渲染完之前滚动不会请求下一页，所以等的时候每秒再滚一次
  const maxPages = params.maxCommentPages ?? LIMITS.maxCommentPages;
  let sp = await selectPages(page, work, from);
  const seen = () => list.some((x) => x.id === id || x.id === root);
  while (!seen() && !sp.error && sp.pages.length < maxPages && hasMore(sp.pages.at(-1))) {
    const before = sp.pages.length;
    // 先看有没有新页，没有再滚
    const next = await waitFor(async () => { const x = await selectPages(page, work, from); if (x.pages.length > before || x.error) return x; await inPage(page, SCROLL_BOTTOM); return null; }, Math.min(t.loadMs, 10000), 1000);
    if (!next) break;
    sp = next;
    list = await comments(page);
  }
  // 一楼接口返回异常（缺 status_code、非 0、没有 comments）：抓到的评论不拿来当依据
  if (sp.error) return { blocked: 'target-not-found', detail: `评论 ${id}${work ? `（作品 ${work}）` : ''}：一楼列表接口返回异常（${sp.error}），没发` };
  const n = sp.pages.length;
  const paging = seen() ? '' : !n ? '；没抓到一楼列表'
    : hasMore(sp.pages.at(-1)) ? `；一楼加载了 ${n} 页${n >= maxPages ? '到上限' : '，再滚也没加载出下一页'}，还有更多`
    : `；一楼已翻到底（${n} 页）`;
  // 目标或它所在的楼都没加载出来：楼中楼展开不出别的楼，不点（给了 rootId / parentId 时 root 就是它所在的一楼）
  const rootKnown = tg.rootId != null || tg.parentId != null;
  // 目标所在的楼在接口里有了、页面可能还没渲染：等它渲染出来，它的「查看 N 条回复」才找得到
  if (list.some((x) => x.id === root)) await waitFor(() => inPage(page, RENDERED, root), Math.min(t.loadMs, 8000), 300);
  // 目标所在楼的子回复没加载全（判「已回复」要看全楼）、或目标还没出现，就点「查看 N 条回复」，先点目标所在的楼
  for (let i = 0; i < max && (seen() || !rootKnown); i++) {
    const hit = list.find((x) => x.id === id);
    const r = list.find((x) => x.id === root);
    const loaded = list.filter((x) => x.root === root).length;
    if (hit && r && r.total != null && loaded >= r.total) break;
    const capBefore = await capCount(page), nBefore = list.length;
    if (!(await clickMarked(page, EXPAND_FOR(root, !!r), 'expand comment replies'))) break;
    // 楼中楼接口可能 1 秒以上才回：最多等 3 秒，抓到楼中楼响应或评论变多才算点开了；都没有才标记不再点
    const grew = await waitFor(async () => (await capturedJson(page, 'comment/list/reply', capBefore)).some((c) => c.json.status_code === 0 && Array.isArray(c.json.comments) && c.json.comments.length > 0) || (await comments(page)).length > nBefore, 3000, 300);
    if (!grew) await page.evaluate(() => document.querySelector('[data-eng-click]')?.setAttribute('data-eng-dead', '1'));
    await sleep(600);
    list = await comments(page);
  }
  let hit = list.find((x) => x.id === id);
  if (!hit) return { blocked: 'target-not-found', detail: `评论管理页上没找到评论 ${id}${work ? `（作品 ${work}）` : ''}${paging}` };
  if (work && hit.aweme != null && hit.aweme !== work) return { blocked: 'target-not-found', detail: `评论 ${id} 属于作品 ${hit.aweme}，不是要回复的作品 ${work}，没发` };
  // 接口响应先到、页面还没渲染出这条：等它渲染出来再看「已删除」、找「回复」
  if (!(await waitFor(() => inPage(page, RENDERED, id), Math.min(t.loadMs, 8000), 300))) return { blocked: 'target-not-found', detail: `接口里有评论 ${id}，但页面上一直没渲染出来` };
  list = await comments(page);
  hit = list.find((x) => x.id === id) ?? hit;
  if (hit.gone) return { blocked: 'comment-gone', detail: `评论 ${id} 显示已删除` };
  const mine = (x) => x.uid != null && x.uid === String(me.uid);
  const prior = list.find((x) => mine(x) && x.id !== id && directTo(x) === id);
  if (prior) return { blocked: 'already-replied', detail: `评论 ${id} 下已有我的回复 ${prior.id}` };
  // 楼里有我的回复、但只从页面视图模型读到（没抓到楼中楼接口），不知道它回的是谁：可能就是回目标的，不发
  const unsure = list.find((x) => mine(x) && x.id !== id && x.root === root && !x.toKnown);
  if (unsure) return { blocked: 'thread-incomplete', detail: `楼 ${root} 里有我的回复 ${unsure.id}，但读不到它回的是哪条，判断不了是否已回复，没发` };
  // 展开到上限还没加载全：看不到的那部分可能有我的旧回复，不发。
  // 楼的一楼没加载出来、或接口和页面都没给楼中楼总数：判断不了全没全，也不发
  const r = list.find((x) => x.id === root);
  const loaded = list.filter((x) => x.root === root).length;
  if (!r) return { blocked: 'thread-incomplete', detail: `评论 ${id} 所在楼的一楼 ${root} 没加载出来，判断不了是否已回复，没发` };
  if (r.total == null) return { blocked: 'thread-incomplete', detail: `楼 ${root} 读不到楼中楼总数（已加载 ${loaded}），判断不了是否已回复，没发` };
  if (loaded < r.total) return { blocked: 'thread-incomplete', detail: `楼 ${root} 的回复没加载全（已加载 ${loaded} / ${r.total}），判断不了是否已回复，没发` };

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
