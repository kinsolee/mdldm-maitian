// 抖音评论、私信。评论接口带 msToken / a_bogus 签名，不能自己拼，所以挂钩页面自己发的请求，只抄响应。
//   评论：评论管理页。作品列表来自页面请求的 /aweme/v1/creator/item/list（item_id_plain、comment_count、发布时间）；
//        挑评论数 >0 的近期作品（最多 maxWorks 个），点「选择作品」→ 作品列表里点那一项切过去，
//        抄回 comment/list/select（一楼），再点「查看 N 条回复」（只读展开）抄回 comment/list/reply（楼中楼）。
//        楼中楼（S6a 核实）：reply_id 是所在楼的一楼 cid，reply_to_reply_id 是直接回复的那条（"0" 表示回复一楼），
//        reply_to_userid / reply_to_username 是被回复的人。
//   私信：li.semi-list-item 的 React fiber 往上 2 层 memoizedProps.item（IM SDK Conversation），lastMessage.isFromMe 判 last.by。
// 不点「回复」、不往输入框里写字、不调 Context 上的写函数。
import { open, atLogin, bigJson, capCount, captured, clickMarked, installHook, mainPage, sleep, waitCaptured } from './page-lib.mjs';
import { adapterFail, clip, isoOf, numOrNull, okResult, str } from './shape.mjs';

export const FILE = 'douyin.mjs';
export const LIMITS = { maxWorks: 8, maxAgeDays: 30, maxExpand: 25, loadMs: 90000 };
const COMMENT_PAGE = 'https://creator.douyin.com/creator-micro/interactive/comment';
const DM_PAGE = 'https://creator.douyin.com/creator-micro/data/following/chat';
const SELECT = 'comment/list/select';
const REPLY = 'comment/list/reply';

// —— 页面脚本 ——
export async function runInSpace(task, params) {
  const o = { ...LIMITS, ...params };
  const page = await mainPage(task);
  await installHook(page);
  await open(page, params.kind === 'dms' ? DM_PAGE : COMMENT_PAGE);
  await sleep(3000);
  const info = bigJson(String((await page.fetch('/web/api/media/user/info/', { timeout: 15000 }).catch(() => ({ body: '' }))).body));
  const login = await atLogin(page);
  if (login || info?.status_code === 8) return { loginLost: true, evidence: `GET /web/api/media/user/info/ status_code=${info?.status_code}；${login ? `页面在 ${login}` : '页面没跳登录'}` };
  // G-B5b/G-B7：user/info 读不到或非 0（又不是掉线）时不往下采；uid 交给 collect 核对账号
  if (info?.status_code !== 0) return { failed: 'auth-failed', error: `GET /web/api/media/user/info/ ${info ? `status_code=${info.status_code}` : '请求失败或不是 JSON'}` };
  const uidSeen = str(info.user?.uid ?? info.user_info?.uid);
  return params.kind === 'dms' ? { kind: 'dms', uidSeen, ...(await rawDms(page, o)) } : { kind: 'comments', uidSeen, ...(await rawComments(page, o)) };
}

const slimUser = (u) => (u ? { uid: str(u.uid), nickname: u.nickname ?? '' } : null);
function slimComment(c) {
  const { user, reply_comment, label_list, text_extra, image_list, video_list, decorated_emoji_info, ...rest } = c;
  return { ...rest, user: slimUser(user) };
}
const bodies = async (page, re, from) => (await captured(page, re, from)).map((c) => bigJson(c.body)).filter(Boolean);
const slimList = (j) => ({ status_code: j.status_code, has_more: j.has_more, cursor: j.cursor, total: j.total, comments: (j.comments ?? []).map(slimComment) });

async function rawComments(page, o) {
  await waitCaptured(page, 'creator/item/list', { timeoutMs: o.loadMs });
  const itemLists = await bodies(page, 'creator/item/list', 0);
  const itemListCodes = itemLists.map((j) => j.status_code ?? null);
  const items = itemLists.filter((j) => j.status_code === 0).flatMap((j) => j.item_info_list ?? [])
    .map((x) => ({ item_id_plain: str(x.item_id_plain), title: x.title ?? null, create_time: x.create_time ?? null, comment_count: x.comment_count ?? 0 }));
  // 页面渲染很慢（实测 30 秒以上才出「选择作品」按钮）
  for (const end = Date.now() + o.loadMs; Date.now() < end; await sleep(1500)) if (await page.evaluate(new Function(`return !!(${PICKER_SRC})()`))) break;
  const windowStartMs = o.now - o.maxAgeDays * 86400_000;
  const recent = items.filter((x) => x.comment_count > 0 && (publishedAt(x.create_time) ?? o.now) >= windowStartMs).slice(0, o.maxWorks);
  const works = [];
  for (const it of recent) {
    const from = await capCount(page);
    const switched = await switchTo(page, it.item_id_plain);
    if (!switched) { works.push({ item_id_plain: it.item_id_plain, opened: false }); continue; }
    const got = await waitCaptured(page, SELECT, { from, timeoutMs: 20000 });
    // 列表加载失败时页面显示「点击刷新」，点一次（只读）
    if (!got && await clickMarked(page, `() => [...document.querySelectorAll('[class*=reload-list-]')].find((e) => /点击刷新/.test(e.textContent))`, 'reload comment list')) await waitCaptured(page, SELECT, { from, timeoutMs: 30000 });
    await sleep(1500);
    // 「查看 N 条回复」「展开更多」：按文字找最里层的那个元素（类名会变）。点了 3 秒内没出子回复请求的，标记后不再点
    let clicks = 0;
    for (; clicks < o.maxExpand; clicks++) {
      const before = (await captured(page, REPLY, from)).length;
      if (!(await clickMarked(page, `() => (${EXPAND_SRC})().find((e) => !e.dataset.engDead)`, 'expand comment replies'))) break;
      let fetched = false;
      for (let i = 0; i < 6 && !fetched; i++) { await sleep(500); fetched = (await captured(page, REPLY, from)).length > before; }
      if (!fetched) await page.evaluate(() => document.querySelector('[data-eng-click]')?.setAttribute('data-eng-dead', '1'));
      await sleep(1200);
    }
    const left = await page.evaluate(new Function(`return (${EXPAND_SRC})().map((e) => e.textContent.trim().replace(/\\d+/g, 'N'))`));
    // 默认选中的作品切过去可能不重新请求，所以一楼列表从头找、按 aweme_id 过滤
    const select = (await bodies(page, SELECT, 0)).map(slimList).filter((j) => j.comments.length && j.comments.every((c) => String(c.aweme_id) === it.item_id_plain));
    const replies = (await bodies(page, REPLY, from)).map(slimList);
    // 切到这个作品后的一楼请求里出错的（status_code 非 0，错误响应没有 comments 可按作品过滤）
    const selectErrors = (await bodies(page, SELECT, from)).filter((j) => j.status_code !== 0).map((j) => ({ status_code: j.status_code ?? null }));
    works.push({ item_id_plain: it.item_id_plain, opened: true, clicks, expandLeft: left.length, expandLeftTexts: left, select, replies, selectErrors });
  }
  return { itemListCodes, windowStartMs, items, works };
}

export const EXPAND_SRC = `() => { const re = /^(查看\\s*\\d+\\s*条回复|展开\\s*\\d*\\s*条?更多回复|展开更多)$/; return [...document.querySelectorAll('div, span, button')].filter((e) => re.test(e.textContent.trim()) && ![...e.children].some((c) => re.test(c.textContent.trim()))); }`;
const PICKER_SRC = `() => [...document.querySelectorAll('button, [class*=-button]')].find((e) => e.textContent.trim() === '选择作品')`;

// 「选择作品」→ 作品列表里 fiber props 的 item_id_plain 等于目标的那一项
export async function switchTo(page, id) {
  if (!(await clickMarked(page, PICKER_SRC, 'open work picker'))) return false;
  await sleep(2500);
  // 作品列表的类名会变（实测两个版本），按「发布于」文字找项，再沿 fiber 找 props 里 item_id_plain 等于目标的；页头也显示当前作品，取最后一个（抽屉里的）
  const ok = await clickMarked(page, `() => [...document.querySelectorAll('*')].filter((el) => el.children.length === 0 && /^发布于/.test(el.textContent.trim()) && (() => {
      for (let e = el, i = 0; e && i < 8; e = e.parentElement, i++) {
        const k = Object.keys(e).find((k) => k.startsWith('__reactFiber'));
        for (let f = e[k], j = 0; f && j < 8; f = f.return, j++) { const p = f.memoizedProps; if (p && typeof p === 'object') for (const v of Object.values(p)) if (v && typeof v === 'object' && v.item_id_plain != null) return String(v.item_id_plain) === ${JSON.stringify(id)}; }
      }
      return false; })()).at(-1)`, 'pick a work');
  await sleep(2500);
  return ok;
}

async function rawDms(page, o) {
  await page.waitForSelector('li.semi-list-item', { timeout: o.loadMs }).catch(() => {});
  await sleep(2000);
  const conversations = await page.evaluate(() => [...document.querySelectorAll('li.semi-list-item')].map((li) => {
    const k = Object.keys(li).find((k) => k.startsWith('__reactFiber'));
    let f = li[k]; for (let i = 0; i < 2 && f; i++) f = f.return;
    const it = f?.memoizedProps?.item;
    if (!it) return null;
    const lm = it.lastMessage;
    const name = li.querySelector('[class*=item-header], [class*=name]')?.innerText?.split('\n')[0] ?? li.innerText.split('\n')[0];
    return { id: it.id, shortId: it.shortId != null ? String(it.shortId) : null, toParticipantUserId: it.toParticipantUserId != null ? String(it.toParticipantUserId) : null, isStrangerChat: !!it.isStrangerChat,
      isGroupChat: !!(it.isGroupChat ?? it.type === 2), unreadCount: it.unreadCount ?? 0, name,
      lastMessage: lm ? { serverId: lm.serverId != null ? String(lm.serverId) : null, clientMessageId: lm.clientMessageId ?? null, type: lm.type, isFromMe: !!lm.isFromMe, createdAt: lm.createdAt != null ? String(new Date(lm.createdAt).getTime() || Number(lm.createdAt) || '') || null : null, content: lm.content ?? null } : null };
  }).filter(Boolean));
  const diag = conversations.length ? null : await page.evaluate(() => ({ path: location.pathname, txt: document.body?.innerText.length ?? 0, li: document.querySelectorAll('li').length, semi: document.querySelectorAll('[class*=semi-list]').length }));
  // U1：0 个会话时只有页面明确显示空状态才算「没有私信」
  const emptyState = conversations.length ? false : await page.evaluate(() => /暂无(私信|消息|会话)|没有(私信|消息|会话)/.test(document.body?.innerText ?? ''));
  return { conversations, emptyState, ...(diag ? { diag } : {}) };
}

// —— 解析 ——
export function parse(kind, raw, ctx) {
  if (!raw || raw.kind !== kind) throw new Error(`原始数据不是 ${kind}`);
  return kind === 'comments' ? parseComments(raw, ctx) : parseDms(raw, ctx);
}

/** 「发布于2026年11月17日 11:56」（东八区）→ epoch ms；数字时间戳也认。 */
export function publishedAt(t) {
  if (t == null) return null;
  if (typeof t === 'number' || /^\d+$/.test(String(t))) return Date.parse(isoOf(t));
  const m = String(t).match(/(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s*(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0'] = m;
  return Date.UTC(+y, +mo - 1, +d, +h - 8, +mi);
}

export function parseComments(raw, { accountUid, fetchedAt }) {
  const me = String(accountUid);
  // X-B3：作品列表读不到或接口全错，整个 kind 失败（不能把「没作品」当成成功）
  const codes = raw.itemListCodes ?? [];
  if (!codes.length) adapterFail('no-data', '没抓到 /aweme/v1/creator/item/list');
  if (!codes.includes(0)) adapterFail('api-error', `/aweme/v1/creator/item/list status_code=${codes.join(',')}`);
  // G-B5a：有近期作品要扫，却一个都没切过去（「选择作品」改版之类），不能报成功
  if (raw.works.length && !raw.works.some((w) => w.opened)) adapterFail('no-data', `${raw.works.length} 个近期作品一个都没能切过去（「选择作品」或作品列表没找到）`);
  const items = new Map(raw.items.map((x) => [x.item_id_plain, x]));
  const works = [], comments = [], scannedWorks = [];
  const author = (u) => ({ uid: str(u?.uid), nickname: u?.nickname ?? '', isMe: str(u?.uid) === me });
  const base = (c, wid) => ({ nativeId: String(c.cid), workNativeId: wid, author: author(c.user), text: c.text ?? '', createdAt: isoOf(c.create_time),
    likeCount: numOrNull(c.digg_count), likedByMe: typeof c.is_author_digged === 'boolean' ? c.is_author_digged : null,
    pinned: c.stick_position == null ? null : Number(c.stick_position) > 0, ipLabel: str(c.ip_label) });
  for (const w of raw.works) {
    const wid = String(w.item_id_plain);
    const it = items.get(wid);
    const t = publishedAt(it?.create_time);
    works.push({ nativeId: wid, title: it?.title ?? null, url: `https://www.douyin.com/video/${wid}`, postTime: t ? new Date(t).toISOString() : null });
    if (!w.opened || !w.select.length) { scannedWorks.push({ workNativeId: wid, complete: false, threadsPartial: true }); continue; }
    const seen = new Map();
    for (const j of w.select) for (const c of j.comments) seen.set(String(c.cid), { ...base(c, wid), parentNativeId: null, rootNativeId: String(c.cid), replyTo: null, replyCount: numOrNull(c.reply_comment_total) });
    const roots = new Map([...seen.values()].map((c) => [c.nativeId, 0]));
    // X-B3：一楼或子回复有任何一条 status_code 非 0 的响应，这个作品拿不全
    const apiError = (w.selectErrors ?? []).length > 0 || w.select.some((j) => j.status_code !== 0) || w.replies.some((j) => j.status_code !== 0);
    let partial = apiError || w.expandLeft > 0 || w.replies.some((j) => Number(j.has_more) === 1 && j.comments.length === 0);
    for (const j of w.replies) for (const c of j.comments) {
      const id = String(c.cid), root = str(c.reply_id) ?? null;
      if (!root || root === '0') continue;
      const to = str(c.reply_to_reply_id);
      seen.set(id, { ...base(c, wid), rootNativeId: root, parentNativeId: to && to !== '0' ? to : root,
        replyTo: c.reply_to_userid ? { uid: str(c.reply_to_userid), nickname: c.reply_to_username ?? null } : null, replyCount: null });
      if (roots.has(root)) roots.set(root, roots.get(root) + 1);
    }
    // 子回复数对不上（没展开完、或分页没跟到）的楼算拿不全
    for (const [root, n] of roots) if ((seen.get(root).replyCount ?? 0) > n) partial = true;
    comments.push(...seen.values());
    const lastSelect = w.select.at(-1);
    // has_more 必须明确是 0/false 才算翻到底
    const lastPage = lastSelect.has_more === 0 || lastSelect.has_more === false;
    scannedWorks.push({ workNativeId: wid, complete: lastPage && !partial, threadsPartial: partial });
  }
  // G-B11a：窗口内评论数为 0 的作品（作品列表接口成功）也算扫过、拿全，库里这个作品已删的评论才能标 goneAt
  const scannedIds = new Set(scannedWorks.map((x) => x.workNativeId));
  for (const it of raw.items) {
    const id = String(it.item_id_plain), t = publishedAt(it.create_time);
    if (Number(it.comment_count) !== 0 || scannedIds.has(id) || raw.windowStartMs == null || t == null || t < raw.windowStartMs) continue;
    works.push({ nativeId: id, title: it.title ?? null, url: `https://www.douyin.com/video/${id}`, postTime: new Date(t).toISOString() });
    scannedWorks.push({ workNativeId: id, complete: true, threadsPartial: false });
  }
  return okResult({ platformCode: 'Douyin', accountUid: me, kind: 'comments', fetchedAt, works, comments, scannedWorks });
}

// lastMessage.type：7 文字、8 分享视频；content 是 JSON 字符串，文字取 .text
const TYPE = (t) => (Number(t) === 7 ? 'text' : Number(t) === 8 ? 'share' : Number(t) === 2 || Number(t) === 27 ? 'image' : 'other');
function textOf(m) {
  if (Number(m.type) !== 7) return null;
  try { return clip(JSON.parse(m.content ?? 'null')?.text ?? null); } catch { return null; }
}

export function parseDms(raw, { accountUid, fetchedAt }) {
  if (!Array.isArray(raw.conversations)) adapterFail('no-data', '抖音私信会话列表读不到');
  if (!raw.conversations.length && !raw.emptyState) adapterFail('no-data', `抖音私信 0 个会话，但页面没显示空状态${raw.diag ? `：${JSON.stringify(raw.diag)}` : ''}`);
  const conversations = [], messages = [];
  for (const c of raw.conversations) {
    const id = String(c.id);
    const lm = c.lastMessage;
    const at = lm?.createdAt ? isoOf(lm.createdAt) : null;
    const last = lm && at ? { by: lm.isFromMe ? 'me' : 'peer', at, text: textOf(lm), type: TYPE(lm.type) } : null;
    conversations.push({ nativeId: id, peer: { uid: c.isGroupChat ? null : str(c.toParticipantUserId), nickname: c.name ?? null, kind: c.isGroupChat ? 'group' : 'user' },
      unread: Number(c.unreadCount) || 0, last, canSend: !c.isGroupChat });
    if (last) messages.push({ nativeId: String(lm.serverId ?? lm.clientMessageId ?? `${id}:${lm.createdAt}`), conversationNativeId: id, by: last.by, at, type: last.type, text: last.text });
  }
  return okResult({ platformCode: 'Douyin', accountUid, kind: 'dms', fetchedAt, conversations, messages });
}
