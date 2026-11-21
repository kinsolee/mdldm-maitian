// 抖音评论、私信。评论接口带 msToken / a_bogus 签名，不能自己拼，所以挂钩页面自己发的请求，只抄响应。
//   评论：评论管理页。作品列表来自页面请求的 /aweme/v1/creator/item/list（item_id_plain、comment_count、发布时间）；
//        挑评论数 >0 的近期作品（最多 maxWorks 个），点「选择作品」→ 作品列表里点那一项切过去，
//        抄回 comment/list/select（一楼），再点「查看 N 条回复」（只读展开）抄回 comment/list/reply（楼中楼）。
//        楼中楼（S6a 核实）：reply_id 是所在楼的一楼 cid，reply_to_reply_id 是直接回复的那条（"0" 表示回复一楼），
//        reply_to_userid / reply_to_username 是被回复的人。
//   私信：li.semi-list-item 的 React fiber 往上 2 层 memoizedProps.item（IM SDK Conversation），lastMessage.isFromMe 判 last.by。
//   S9 页面内接口（账号能力位 readViaApi 打开时，params.readVia = 'api'）：作品列表照旧抄页面自己发的 item/list，
//        一楼、楼中楼改成调页面自己的评论服务（awemeV1CommentListSelect / awemeV1CommentListReply，见 ../inpage-api.mjs），
//        不再点「选择作品」「查看回复」。翻页上限同 DOM 路径（一楼 maxSelectPages 页、楼中楼共 maxExpand 次请求），原始数据形状不变。
//        找不到页面服务时退回 DOM 路径（raw.apiFallback 写明原因）。
// 不点「回复」、不往输入框里写字、不调 Context 上的写函数。
import { countOf, pageEnd, pageMore, serviceCaller } from '../inpage-api.mjs';
import { open, atLogin, bigJson, capCount, captured, clickMarked, installHook, mainPage, sleep, waitCaptured } from './page-lib.mjs';
import { adapterFail, clip, isoOf, numOrNull, okResult, str } from './shape.mjs';

export const FILE = 'douyin.mjs';
export const LIMITS = { maxWorks: 8, maxAgeDays: 30, maxExpand: 25, loadMs: 90000, maxPickerPages: 10, maxSelectPages: 30, apiGapMs: 800 };
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
// 页面脚本里的归一化（导出给测试）：缺失的列表字段保留成 null，不当成功的空列表（X2-B5、X2-S4）
export const slimList = (j) => ({ status_code: j.status_code, has_more: j.has_more, cursor: j.cursor, total: j.total, comments: Array.isArray(j.comments) ? j.comments.map(slimComment) : null });
export const itemListCodeOf = (j) => (j.status_code === 0 && !Array.isArray(j.item_info_list) ? 'no-list' : j.status_code ?? null);
export const slimItem = (x) => ({ item_id_plain: str(x.item_id_plain), title: x.title ?? null, create_time: x.create_time ?? null, comment_count: Number.isFinite(x.comment_count) ? x.comment_count : null });
/** 一楼列表：all 是整页抓到的（按 aweme_id 归到这个作品），fresh 是切到这个作品之后抓到的；fresh 里出错或缺 comments 的记成 selectErrors。 */
export function splitSelect(all, itemId, fresh) {
  const select = all.filter((j) => j.status_code === 0 && Array.isArray(j.comments) && j.comments.length && j.comments.every((c) => String(c.aweme_id) === itemId));
  const selectErrors = fresh.filter((j) => j.status_code !== 0 || !Array.isArray(j.comments)).map((j) => ({ status_code: j.status_code ?? null, comments: Array.isArray(j.comments) ? 'array' : 'missing' }));
  return { select, selectErrors };
}

async function rawComments(page, o) {
  await waitCaptured(page, 'creator/item/list', { timeoutMs: o.loadMs });
  const itemLists = await bodies(page, 'creator/item/list', 0);
  const itemListCodes = itemLists.map(itemListCodeOf);
  const items = itemLists.filter((j) => itemListCodeOf(j) === 0).flatMap((j) => j.item_info_list).map(slimItem);
  const { windowStartMs, recent } = recentWorks(items, o);
  let apiFallback = null;
  if (o.readVia === 'api') {
    const call = await serviceCaller(page, 'Douyin', { waitMs: Math.min(o.loadMs, 60000), gapMs: o.apiGapMs });
    if (call) return { via: 'api', itemListCodes, windowStartMs, items, works: await worksViaApi(call, recent, o) };
    apiFallback = '页面评论服务没找到，退回 DOM 路径';
  }
  // 页面渲染很慢（实测 30 秒以上才出「选择作品」按钮）
  for (const end = Date.now() + o.loadMs; Date.now() < end; await sleep(1500)) if (await page.evaluate(new Function(`return !!(${PICKER_SRC})()`))) break;
  // 默认作品的一楼列表比「选择作品」按钮晚到；先切走的话，它晚到的响应会把列表盖回默认作品（2026-11-21 实测）
  if (recent.length) await waitCaptured(page, SELECT, { timeoutMs: 30000 });
  const works = [];
  for (const it of recent) {
    const from = await capCount(page);
    const switched = await switchTo(page, it.item_id_plain, { maxPages: o.maxPickerPages });
    if (!switched.ok) { works.push({ item_id_plain: it.item_id_plain, opened: false }); continue; }
    // 切到的就是默认作品时页面不重新请求，它的一楼列表开头已经抓到了，不用再等
    // 只在还没切走过时用（切走后再切回来页面会重新请求，要等新的）
    const had = !works.some((w) => w.opened) && (await bodies(page, SELECT, 0)).some((j) => j.status_code === 0 && Array.isArray(j.comments) && j.comments.length && j.comments.every((c) => String(c.aweme_id) === it.item_id_plain));
    const got = had || await waitCaptured(page, SELECT, { from, timeoutMs: 20000 });
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
    const { select, selectErrors } = splitSelect((await bodies(page, SELECT, 0)).map(slimList), it.item_id_plain, (await bodies(page, SELECT, from)).map(slimList));
    const replies = (await bodies(page, REPLY, from)).map(slimList);
    works.push({ item_id_plain: it.item_id_plain, opened: true, clicks, expandLeft: left.length, expandLeftTexts: left, select, replies, selectErrors });
  }
  return { via: 'dom', ...(apiFallback ? { apiFallback } : {}), itemListCodes, windowStartMs, items, works };
}

/** 近 maxAgeDays 天、评论数 > 0 的作品，最多 maxWorks 个（DOM、接口两条路径共用）。 */
export function recentWorks(items, o) {
  const windowStartMs = o.now - o.maxAgeDays * 86400_000;
  return { windowStartMs, recent: items.filter((x) => x.comment_count > 0 && (publishedAt(x.create_time) ?? o.now) >= windowStartMs).slice(0, o.maxWorks) };
}

// 参数同页面自己发的一楼请求（探针看到的：aweme_id、cursor、count=10、comment_select_options=0、sort_options=0、channel_id=618；app_id、aid、device_platform 由页面封装补）
export const selectArgs = (awemeId, cursor) => ({ aweme_id: String(awemeId), cursor, count: 10, comment_select_options: 0, sort_options: 0, channel_id: 618 });
export const replyArgs = (cid, cursor) => ({ comment_id: String(cid), cursor, count: 10, channel_id: 618 });

/**
 * 接口读一楼和楼中楼（S9）。call 是 ../inpage-api.mjs 的 serviceCaller 给的。返回和 DOM 路径一样的 works（parse 不变）：
 * 一楼最多 maxSelectPages 页，接口出错记进 selectErrors；楼中楼每个作品最多 maxExpand 次请求（同 DOM 路径的「展开」上限），用完还没读完的楼数记 expandLeft。
 */
export async function worksViaApi(call, recent, o) {
  const works = [];
  for (const it of recent) {
    const select = [], selectErrors = [], replies = [];
    let cursor = 0;
    for (let p = 0; p < o.maxSelectPages; p++) {
      const r = await call('awemeV1CommentListSelect', selectArgs(it.item_id_plain, cursor));
      const j = r.ok ? slimList(r.data ?? {}) : null;
      if (!j || j.status_code !== 0 || !Array.isArray(j.comments)) {
        selectErrors.push({ status_code: j?.status_code ?? null, comments: Array.isArray(j?.comments) ? 'array' : 'missing', ...(r.ok ? {} : { error: r.error }) });
        break;
      }
      select.push(j);
      // 没有明确翻到底（has_more 不是 0）时，最后一页的 has_more 留着，parse 判成没拿全
      if (pageEnd(j.has_more) || !pageMore(j.has_more) || j.cursor == null || j.cursor === cursor) break;
      cursor = j.cursor;
    }
    // 一楼跨页可能重复（新评论插进来），按 cid 去重后再拉楼中楼；总数读不到的也拉
    const roots = new Map();
    for (const c of select.flatMap((j) => j.comments)) { const n = countOf(c.reply_comment_total); if (n == null || n > 0) roots.set(String(c.cid), c); }
    let calls = 0, left = 0;
    for (const cid of roots.keys()) {
      for (let cur = 0; ;) {
        if (calls >= o.maxExpand) { left++; break; }
        calls++;
        const r = await call('awemeV1CommentListReply', replyArgs(cid, cur));
        const j = r.ok ? slimList(r.data ?? {}) : { status_code: null, has_more: null, cursor: null, total: null, comments: null };
        replies.push(j);
        if (j.status_code !== 0 || !Array.isArray(j.comments) || pageEnd(j.has_more)) break;
        // 还有下一页却翻不动、或 has_more 缺失：这栋楼没读全
        if (!pageMore(j.has_more) || j.cursor == null || j.cursor === cur) { left++; break; }
        cur = j.cursor;
      }
    }
    // 一楼一页都没读到的作品记 opened:false，全部作品都这样时 parse 报 no-data（同步失败会告警），不会悄悄记成功
    works.push({ item_id_plain: it.item_id_plain, opened: select.length > 0, via: 'api', clicks: calls, expandLeft: left, expandLeftTexts: [], select, replies, selectErrors });
  }
  return works;
}

export const EXPAND_SRC = `() => { const re = /^(查看\\s*\\d+\\s*条回复|展开\\s*\\d*\\s*条?更多回复|展开更多)$/; return [...document.querySelectorAll('div, span, button')].filter((e) => re.test(e.textContent.trim()) && ![...e.children].some((c) => re.test(c.textContent.trim()))); }`;
const PICKER_SRC = `() => [...document.querySelectorAll('button, [class*=-button]')].find((e) => e.textContent.trim() === '选择作品')`;

// 抽屉里的作品项：类名会变（实测两个版本），按「发布于」文字找叶子，再沿 fiber 找 props 里的作品对象（item_id_plain）。
// 只认抽屉（[class*=sidesheet]）里的：页头也显示当前作品的「发布于」，它的 fiber 上也有作品对象（2026-11-21 第二次核对），点它不会切作品。
const WORK_CARDS = `const cards = () => [...document.querySelectorAll('[class*=sidesheet] *')].filter((el) => el.children.length === 0 && /^发布于/.test(el.textContent.trim()) && el.getClientRects().length > 0).map((el) => {
    for (let e = el, i = 0; e && i < 8; e = e.parentElement, i++) {
      const k = Object.keys(e).find((k) => k.startsWith('__reactFiber'));
      for (let f = e[k], j = 0; f && j < 8; f = f.return, j++) { const p = f.memoizedProps; if (p && typeof p === 'object') for (const v of Object.values(p)) if (v && typeof v === 'object' && v.item_id_plain != null) return { el, id: String(v.item_id_plain) }; }
    }
    return null; }).filter(Boolean);`;
const cardIds = (page) => page.evaluate(new Function(`${WORK_CARDS} return cards().map((c) => c.id);`));
// 抽屉的滚动容器（最后一个作品项往上第一个能纵向滚动的）滚到底；作品列表每页 20 个，滚到底才请求下一页
const SCROLL_CARDS = `${WORK_CARDS} const last = cards().at(-1)?.el; if (!last) return false;
  for (let e = last.parentElement; e; e = e.parentElement) if (e.scrollHeight > e.clientHeight + 5 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)) {
    e.scrollTop = e.scrollHeight; e.dispatchEvent(new Event('scroll')); return true; }
  last.scrollIntoView({ block: 'end' }); return true;`;

async function until(fn, ms, stepMs = 250) {
  for (const end = Date.now() + ms; ;) { const v = await fn(); if (v || Date.now() >= end) return v; await sleep(stepMs); }
}

// 关掉「选择作品」抽屉：按 Esc；还开着就点遮罩（Semi SideSheet 默认点遮罩关）；还开着就点关闭按钮。每步都确认关了没有。
// 抽屉开着时遮罩盖住「选择作品」按钮，下一次就打不开了。按抽屉、遮罩节点判开没开（作品列表没出来时抽屉也是开着的）
const DRAWER_OPEN = `return [...document.querySelectorAll('[class*=sidesheet-inner], [class*=sidesheet-mask]')].some((e) => e.getClientRects().length > 0);`;
async function closePicker(page) {
  const closed = async () => !(await page.evaluate(new Function(DRAWER_OPEN)));
  if (await closed()) return;
  await page.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
  await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
  if (await until(closed, 1000)) return;
  for (const sel of ['[class*=sidesheet-mask]', '[class*=sidesheet-close]']) {
    await page.evaluate((s) => [...document.querySelectorAll(s)].filter((e) => e.getClientRects().length > 0).at(-1)?.click(), sel);
    if (await until(closed, 1500)) return;
  }
}

/**
 * 「选择作品」→ 作品列表里 item_id_plain 等于 id 的那一项。返回 { ok, detail }；没切成时关掉抽屉再返回。
 * 作品列表是打开抽屉后才请求的（实测 0 到 3.3 秒才出来），每页 20 个；目标不在已加载的里面就把抽屉滚到底翻页，
 * 最多 maxPages 页。抽屉底部「没有更多视频」还有下一页时也显示，所以按「滚了没出新作品 id」判到底（按 id 不按个数，列表复用节点时个数不涨）。
 */
export async function switchTo(page, id, { maxPages = LIMITS.maxPickerPages, listMs = 15000, pageMs = 8000 } = {}) {
  const want = String(id);
  if (!(await clickMarked(page, PICKER_SRC, 'open work picker'))) return { ok: false, detail: '页面上没有「选择作品」按钮' };
  const fail = async (detail) => { await closePicker(page); return { ok: false, detail }; };
  const seen = new Set(await until(async () => { const x = await cardIds(page); return x.length ? x : null; }, listMs) ?? []);
  if (!seen.size) return fail(`打开「选择作品」${Math.round(listMs / 1000)} 秒内作品列表没出来`);
  // 上限按实际加载的作品个数算（第一页的个数当每页大小）：滚动可能多带出一页，只在前 maxPages 页的作品里找
  const cap = seen.size * maxPages;
  for (;;) {
    const picked = await clickMarked(page, `() => { ${WORK_CARDS} return cards().slice(0, ${cap}).filter((c) => c.id === ${JSON.stringify(want)}).at(-1)?.el ?? null; }`, 'pick a work');
    if (picked) { await sleep(2500); return { ok: true, detail: null }; }
    if (seen.size >= cap) return fail(`作品列表翻了 ${maxPages} 页（前 ${cap} 个作品）到上限，还没有这个作品`);
    // 先看有没有新作品，没有再滚（上一页刚渲染完时那一下滚动可能没触发加载，所以等的时候反复滚）
    const grew = await until(async () => {
      const fresh = (await cardIds(page)).filter((x) => !seen.has(x));
      if (fresh.length) { fresh.forEach((x) => seen.add(x)); return true; }
      await page.evaluate(new Function(SCROLL_CARDS));
      return false;
    }, pageMs, 500);
    if (!grew) return fail(`作品列表翻到底了（${seen.size} 个作品），没有这个作品`);
  }
}

/**
 * 私信列表明确为空（在页面里跑，导出给测试传假 doc）：页面上没有会话行，且列表组件显示了 Semi 的空状态或「暂无私信」类文案。
 * 抖音的会话列表只能从 DOM 行的 fiber 读，没有能直接读的列表数组，所以靠空状态判断（U1 复查）。
 */
export function dyDmEmptyState(doc) {
  const d = doc ?? document;
  if (d.querySelectorAll('li.semi-list-item').length) return false;
  return !!d.querySelector('.semi-list-empty') || /暂无(私信|消息|会话)|没有(私信|消息|会话)/.test(d.body?.innerText ?? '');
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
  const emptyState = conversations.length ? false : await page.evaluate(dyDmEmptyState);
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
    const bad = (j) => j.status_code !== 0 || !Array.isArray(j.comments);
    // 同一条一楼跨页重复时回复总数取保守值：任一份读不到就当读不到，都读到取大的（不让后一份把「不知道」盖成 0）
    for (const j of w.select.filter((x) => !bad(x))) for (const c of j.comments) {
      const id = String(c.cid), n = numOrNull(c.reply_comment_total), prev = seen.get(id);
      const replyCount = !prev ? n : prev.replyCount == null || n == null ? null : Math.max(prev.replyCount, n);
      seen.set(id, { ...base(c, wid), parentNativeId: null, rootNativeId: id, replyTo: null, replyCount });
    }
    const roots = new Map([...seen.values()].map((c) => [c.nativeId, 0]));
    // X-B3：一楼或子回复有任何一条 status_code 非 0 的响应，这个作品拿不全
    const apiError = (w.selectErrors ?? []).length > 0 || w.select.some(bad) || w.replies.some(bad);
    const replies = w.replies.filter((j) => !bad(j));
    let partial = apiError || w.expandLeft !== 0 || replies.some((j) => Number(j.has_more) === 1 && j.comments.length === 0);
    for (const j of replies) for (const c of j.comments) {
      const id = String(c.cid), root = str(c.reply_id) ?? null;
      if (!root || root === '0') continue;
      const to = str(c.reply_to_reply_id);
      const first = !seen.has(id);
      seen.set(id, { ...base(c, wid), rootNativeId: root, parentNativeId: to && to !== '0' ? to : root,
        replyTo: c.reply_to_userid ? { uid: str(c.reply_to_userid), nickname: c.reply_to_username ?? null } : null, replyCount: null });
      // 同一条楼中楼在几页响应里重复出现时只数一次，否则会把没读全的楼数成读全了
      if (first && roots.has(root)) roots.set(root, roots.get(root) + 1);
    }
    // 子回复数对不上（没展开完、或分页没跟到）的楼算拿不全
    // 子回复总数缺失时不知道拿全没有，算拿不全（X2-S8）
    for (const [root, n] of roots) { const total = seen.get(root).replyCount; if (total == null || total > n) partial = true; }
    comments.push(...seen.values());
    const lastSelect = w.select.at(-1);
    // has_more 必须明确是 0/false 才算翻到底
    const lastPage = pageEnd(lastSelect.has_more);
    scannedWorks.push({ workNativeId: wid, complete: lastPage && !partial, threadsPartial: partial });
  }
  // G-B11a：窗口内评论数为 0 的作品（作品列表接口成功）也算扫过、拿全，库里这个作品已删的评论才能标 goneAt
  const scannedIds = new Set(scannedWorks.map((x) => x.workNativeId));
  for (const it of raw.items) {
    const id = String(it.item_id_plain), t = publishedAt(it.create_time);
    if (it.comment_count !== 0 || scannedIds.has(id) || raw.windowStartMs == null || t == null || t < raw.windowStartMs) continue;
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
