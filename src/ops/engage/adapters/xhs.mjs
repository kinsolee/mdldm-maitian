// 小红书评论、私信（主站 www.xiaohongshu.com，和创作者中心共用登录态）。挂钩页面自己发的请求，只抄响应。
//   评论：/notification「评论和@」的 api/sns/web/v1/you/mentions 只用来发现哪些笔记近期有新评论；
//        逐个打开笔记页（xsec_token 只在页面里拼地址用，不出页面），抄回笔记页自己发的
//        api/sns/web/v2/comment/page（一楼，带 sub_comments）和点「展开 N 条回复」后的 comment/sub/page（S6a 核实）。
//        target_comment.id 是直接回复的那条。笔记打不开、整楼拿不全的 threadsPartial=true，
//        仍把 you/mentions 里的评论按两层入库（被回复的那条当一楼）。
//   私信：/chat 的 api/im/web/v3/chats（会话列表，判不出最后一句是谁说的），所以逐个打开 /chat/<chat_user_id>，
//        抄回 api/im/web/messages/history（sender_id 判发送方），打开会标已读（允许）。
//        只打开最后消息比 since 新的会话（没有 since 最多打开 maxOpen 个）。群聊不收。
// 不点「回复」「发送」，不往输入框里写字。
import { open, atLogin, bigJson, capCount, captured, clickMarked, dropSecrets, installHook, mainPage, sleep, urlParam, waitCaptured } from './page-lib.mjs';
import { adapterFail, clip, isoOf, numOrNull, okResult, str } from './shape.mjs';

export const FILE = 'xhs.mjs';
export const LIMITS = { maxNotes: 8, maxMentionPages: 4, maxExpand: 20, maxScroll: 5, maxOpen: 10, loadMs: 60000, noteGapMs: 5000 };
const MENTIONS = 'you/mentions';
const PAGE_API = 'comment/page';
const SUB_API = 'comment/sub/page';

// —— 页面脚本 ——
export async function runInSpace(task, params) {
  const o = { ...LIMITS, ...params };
  const page = await mainPage(task);
  await installHook(page);
  await open(page, params.kind === 'dms' ? 'https://www.xiaohongshu.com/chat' : 'https://www.xiaohongshu.com/notification');
  await sleep(5000);
  const login = await atLogin(page);
  if (login) return { loginLost: true, evidence: `页面在 ${login}` };
  const raw = await (params.kind === 'dms' ? rawDms(page, o) : rawComments(page, o));
  return raw.kind ? { ...raw, uidSeen: await selfUid(page, raw) } : raw;
}

// G-B7：当前登录用户 id。只用页面自己已经发的请求或页面状态，不另外调接口：
// user/me 响应（主站加载时自己发）→ 页面 __INITIAL_STATE__.user.userInfo → 私信会话列表里的 user_id（自己）
async function selfUid(page, raw) {
  const me = (await jsons(page, 'user/me')).map((c) => c.json?.data).find((d) => d && (d.user_id || d.userId));
  if (me) return String(me.user_id ?? me.userId);
  const st = await page.evaluate(() => { try { const v = (x) => (x && typeof x === 'object' && ('_value' in x || '_rawValue' in x) ? x._value ?? x._rawValue : x); const u = v(window.__INITIAL_STATE__?.user?.userInfo); return u?.user_id ?? u?.userId ?? null; } catch { return null; } });
  if (st) return String(st);
  const self = [...new Set((raw.chats ?? []).map((c) => c.user_id).filter(Boolean))];
  return self.length === 1 ? String(self[0]) : null;
}

const jsons = async (page, re, from = 0) => (await captured(page, re, from)).map((c) => ({ url: c.url, json: bigJson(c.body) })).filter((c) => c.json);
const notLoggedIn = (j) => j && (j.code === -100 || j.code === -101 || /登录/.test(j.msg ?? ''));

async function rawComments(page, o) {
  // 「评论和@」已选中时再点会让列表出不来（S0），所以只在没抓到 you/mentions 时点
  if (!(await waitCaptured(page, MENTIONS, { timeoutMs: 8000 }))) {
    await page.click('text="评论和@"', { label: 'open comments tab' }).catch(() => {});
    await waitCaptured(page, MENTIONS, { timeoutMs: o.loadMs });
  }
  let mentions = await jsons(page, MENTIONS);
  if (!mentions.length) return { failed: 'no-data', error: `${o.loadMs}ms 内没抓到 you/mentions` };
  if (notLoggedIn(mentions[0].json)) return { loginLost: true, evidence: `you/mentions code=${mentions[0].json.code}` };
  const since = (o.since ? Date.parse(o.since) : o.now - 7 * 86400_000) / 1000;
  const oldest = () => Math.min(...mentions.flatMap((m) => m.json.data?.message_list ?? []).map((x) => x.time));
  for (let i = 1; i < o.maxMentionPages && mentions.at(-1).json.data?.has_more && oldest() >= since; i++) {
    const from = await capCount(page);
    await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); for (const e of document.querySelectorAll('*')) if (e.scrollHeight > e.clientHeight + 50 && /auto|scroll/.test(getComputedStyle(e).overflowY)) e.scrollTop = e.scrollHeight; });
    if (!(await waitCaptured(page, MENTIONS, { from, timeoutMs: 10000 }))) break;
    mentions = await jsons(page, MENTIONS);
  }
  const list = mentions.flatMap((m) => m.json.data?.message_list ?? []);
  // 笔记 id → xsec_token 只留在这个函数里，用来拼笔记页地址
  const tokens = new Map();
  for (const m of list) if (m.time >= since && m.item_info?.id && !tokens.has(m.item_info.id)) tokens.set(m.item_info.id, m.item_info.xsec_token ?? '');
  const notes = [];
  // 连着开笔记页会被限流（核对时连跑几轮后笔记页、通知页都不出数据），每篇之间停一下
  for (const [id, tok] of [...tokens].slice(0, o.maxNotes)) { notes.push(await openNote(page, id, tok, o)); await sleep(o.noteGapMs); }
  return { kind: 'comments', windowStart: since, mentions: mentions.map((m) => ({ code: m.json.code, data: { has_more: m.json.data?.has_more, message_list: dropSecrets(m.json.data?.message_list ?? []) } })), notes };
}

const EXPAND_SRC = `() => { const re = /^展开\\s*(\\d+\\s*条回复|更多回复?)$/; return [...document.querySelectorAll('.show-more, div, span')].filter((e) => re.test(e.textContent.trim()) && ![...e.children].some((c) => re.test(c.textContent.trim()))); }`;

export async function openNote(page, id, tok, o) {
  // 新文档的 __engCap 从 0 开始
  const from = 0;
  await open(page, `https://www.xiaohongshu.com/explore/${id}?xsec_token=${encodeURIComponent(tok)}&xsec_source=pc_notice`);
  let got = await waitCaptured(page, PAGE_API, { from, timeoutMs: 30000 });
  // 笔记页有时迟迟不发 comment/page（核对时 9 篇里有 5 篇这样），刷新一次再等
  if (!got) { await page.reload({ waitUntil: 'commit', timeout: 60000 }).catch(() => {}); got = await waitCaptured(page, PAGE_API, { timeoutMs: 30000 }); }
  if (!got) return { noteId: id, opened: false };
  await sleep(2000);
  const detail = await page.evaluate((id) => { try { const n = window.__INITIAL_STATE__?.note?.noteDetailMap?.[id]?.note; const v = (x) => (x && typeof x === 'object' && '_value' in x ? x._value : x); const nn = v(n); return nn ? { title: nn.title ?? null, time: nn.time ?? null } : null; } catch { return null; } }, id);
  // 一楼分页：滚到评论区底部触发下一页
  for (let i = 0; i < o.maxScroll; i++) {
    const pages = await jsons(page, PAGE_API, from);
    if (!pages.at(-1)?.json.data?.has_more) break;
    const n = await capCount(page);
    await page.evaluate(() => { const l = [...document.querySelectorAll('.comment-item, .parent-comment')].at(-1); l?.scrollIntoView({ block: 'end' }); document.querySelector('.note-scroller')?.scrollBy(0, 4000); });
    if (!(await waitCaptured(page, PAGE_API, { from: n, timeoutMs: 8000 }))) break;
  }
  let clicks = 0;
  for (; clicks < o.maxExpand; clicks++) {
    const before = (await captured(page, SUB_API, from)).length;
    if (!(await clickMarked(page, `() => (${EXPAND_SRC})().find((e) => !e.dataset.engDead)`, 'expand note replies'))) break;
    let fetched = false;
    for (let i = 0; i < 6 && !fetched; i++) { await sleep(500); fetched = (await captured(page, SUB_API, from)).length > before; }
    if (!fetched) await page.evaluate(() => document.querySelector('[data-eng-click]')?.setAttribute('data-eng-dead', '1'));
    await sleep(1000);
  }
  const left = await page.evaluate(new Function(`return (${EXPAND_SRC})().length`));
  const pick = (c) => ({ root_comment_id: urlParam(c.url, 'root_comment_id'), code: c.json.code, data: dropSecrets({ has_more: c.json.data?.has_more, comments: c.json.data?.comments ?? [] }) });
  const mine = (c) => !urlParam(c.url, 'note_id') || urlParam(c.url, 'note_id') === id;
  return { noteId: id, opened: true, detail, clicks, expandLeft: left,
    pages: (await jsons(page, PAGE_API, from)).filter(mine).map(pick), subs: (await jsons(page, SUB_API, from)).filter(mine).map(pick) };
}

async function rawDms(page, o) {
  await waitCaptured(page, 'im/web/v3/chats', { timeoutMs: o.loadMs });
  await page.waitForSelector('.xhs-im-conv-item', { timeout: 30000 }).catch(() => {});
  await sleep(1500);
  const chatsCap = await jsons(page, 'im/web/v3/chats');
  if (!chatsCap.length) return { failed: 'no-data', error: `${o.loadMs}ms 内没抓到 im/web/v3/chats` };
  if (notLoggedIn(chatsCap[0].json)) return { loginLost: true, evidence: `v3/chats code=${chatsCap[0].json.code}` };
  const chats = new Map();
  const chatsCodes = chatsCap.map((c) => c.json.code ?? null);
  for (const c of chatsCap) if (c.json.code === 0) for (const x of c.json.data?.chats ?? []) chats.set(x.chat_user_id, x);
  const unread = Object.assign({}, ...(await jsons(page, 'chat/get_unread')).map((c) => c.json.data?.user_chat_unread_counts ?? {}));
  const since = o.since ? Date.parse(o.since) : null;
  // 点开会话后列表会重新渲染（行数变了），按行号点不稳；直接打开 /chat/<chat_user_id>（地址里只有对方 uid）
  const histories = [], tried = [];
  const pick = [...chats.values()].filter((c) => since == null || Number(c.last_msg_time) > since)
    .sort((a, b) => Number(b.last_msg_time) - Number(a.last_msg_time)).slice(0, o.maxOpen);
  for (const c of pick) {
    await open(page, `https://www.xiaohongshu.com/chat/${encodeURIComponent(c.chat_user_id)}`);
    const re = 'im/web/messages/history';
    let h = null;
    for (const end = Date.now() + 15000; !h && Date.now() < end; await sleep(1000)) h = (await jsons(page, re)).find((x) => urlParam(x.url, 'chat_user_id') === c.chat_user_id) ?? null;
    if (!h) { tried.push('no-history'); continue; }
    tried.push(h.json.code === 0 ? 'ok' : `code=${h.json.code}`);
    const msgs = h.json.data?.out_message_list ?? h.json.data?.message_list ?? [];
    histories.push({ chat_user_id: c.chat_user_id, code: h.json.code ?? null, messages: msgs.map((m) => ({ id: m.id, sender_id: m.sender_id, receiver_id: m.receiver_id, created_at: m.created_at, content: m.content })) });
    await sleep(800);
  }
  const slim = [...chats.values()].map((c) => ({ chat_user_id: c.chat_user_id, user_id: c.user_id, last_msg_time: c.last_msg_time, last_msg_content: c.last_msg_content,
    info: { nickname: c.info?.nickname ?? null, is_official: !!c.info?.is_official, is_brand: !!c.info?.is_brand } }));
  return { kind: 'dms', chatsCodes, chats: slim, unread, histories, tried };
}

// —— 解析 ——
export function parse(kind, raw, ctx) {
  if (!raw || raw.kind !== kind) throw new Error(`原始数据不是 ${kind}`);
  return kind === 'comments' ? parseComments(raw, ctx) : parseDms(raw, ctx);
}

const uidOf = (u) => str(u?.user_id ?? u?.userid);

const okPage = (p) => p.code === 0 && Array.isArray(p.data?.comments);

export function parseComments(raw, { accountUid, fetchedAt, since = null }) {
  const me = String(accountUid);
  // X-B4：you/mentions 没有一页成功，整个 kind 失败
  const mentionPages = raw.mentions.filter((m) => m.code === 0 && Array.isArray(m.data?.message_list));
  if (!mentionPages.length) adapterFail('api-error', `you/mentions code=${raw.mentions.map((m) => m.code).join(',') || '无响应'}`);
  // X-B11：通知兜底只收抓取窗口内的（页面脚本按同一个窗口翻页，最后一页会带出更早的通知）
  const windowStart = since ? Date.parse(since) / 1000 : raw.windowStart ?? Date.parse(fetchedAt) / 1000 - 7 * 86400;
  const mentionList = mentionPages.flatMap((m) => m.data.message_list).filter((m) => Number(m.time) >= windowStart);
  const works = [], scannedWorks = [];
  const byId = new Map();
  const author = (u) => ({ uid: uidOf(u), nickname: u?.nickname ?? '', isMe: uidOf(u) === me });
  const mk = (c, noteId, root, parent, extra = {}) => ({ nativeId: String(c.id), workNativeId: noteId, parentNativeId: parent, rootNativeId: root, author: author(c.user_info), replyTo: null,
    text: c.content ?? '', createdAt: isoOf(c.create_time), likeCount: numOrNull(c.like_count), likedByMe: null, pinned: null, replyCount: null, ipLabel: str(c.ip_location), ...extra });
  const opened = new Set();
  for (const n of raw.notes) {
    const title = n.detail?.title || mentionList.find((m) => m.item_info?.id === n.noteId)?.item_info?.content || null;
    works.push({ nativeId: n.noteId, title, url: `https://www.xiaohongshu.com/explore/${n.noteId}`, postTime: isoOf(n.detail?.time) });
    // X-B4：comment/page 有任何一页 code 非 0 或缺 comments，这篇笔记的整楼数据不可信，按没打开处理（只用通知兜底）
    if (!n.opened || !n.pages.length || !n.pages.every(okPage)) { scannedWorks.push({ workNativeId: n.noteId, complete: false, threadsPartial: true }); continue; }
    opened.add(n.noteId);
    const tops = n.pages.flatMap((p) => p.data.comments);
    const subsByRoot = new Map();
    const thread = new Map();
    for (const t of tops) {
      thread.set(String(t.id), { root: String(t.id), c: t, l1: true });
      for (const s of t.sub_comments ?? []) thread.set(String(s.id), { root: String(t.id), c: s });
    }
    const subsOk = n.subs.every(okPage);
    for (const p of n.subs.filter(okPage)) for (const s of p.data.comments) {
      const root = p.root_comment_id ?? thread.get(String(s.target_comment?.id))?.root;
      if (root) thread.set(String(s.id), { root: String(root), c: s });
    }
    let partial = !subsOk || n.expandLeft > 0;
    for (const [id, { root, c, l1 }] of thread) {
      if (l1) { byId.set(id, mk(c, n.noteId, id, null, { replyCount: numOrNull(c.sub_comment_count), likedByMe: null })); continue; }
      const to = str(c.target_comment?.id);
      const parent = to && thread.has(to) ? to : root;
      const tu = c.target_comment?.user_info;
      byId.set(id, mk(c, n.noteId, root, parent, { replyTo: parent !== root && tu ? { uid: uidOf(tu), nickname: tu.nickname ?? null } : null }));
      subsByRoot.set(root, (subsByRoot.get(root) ?? 0) + 1);
    }
    for (const t of tops) if ((numOrNull(t.sub_comment_count) ?? 0) > (subsByRoot.get(String(t.id)) ?? 0)) partial = true;
    const lastPage = n.pages.at(-1).data.has_more === false;
    scannedWorks.push({ workNativeId: n.noteId, complete: lastPage && !partial, threadsPartial: partial });
  }
  // 没能打开的笔记（或超出上限的）：you/mentions 里的评论按两层入库，被回复的那条当一楼
  const seenNotes = new Set(raw.notes.map((n) => n.noteId));
  for (const m of mentionList) {
    const noteId = m.item_info?.id, ci = m.comment_info;
    if (!noteId || !ci?.id || opened.has(noteId) || byId.has(String(ci.id))) continue;
    if (!seenNotes.has(noteId)) {
      seenNotes.add(noteId);
      works.push({ nativeId: noteId, title: m.item_info?.content || null, url: `https://www.xiaohongshu.com/explore/${noteId}`, postTime: null });
      scannedWorks.push({ workNativeId: noteId, complete: false, threadsPartial: true });
    }
    const tc = ci.target_comment;
    const base = { workNativeId: noteId, text: ci.content ?? '', createdAt: isoOf(m.time), likeCount: numOrNull(ci.like_count), likedByMe: null, pinned: null, replyCount: null, ipLabel: null };
    if (tc?.id) {
      const root = String(tc.id);
      // 被回复那条的发布时间通知里没有，先用这条通知的时间（只会更晚）；笔记页打开后会被整楼数据覆盖
      if (!byId.has(root)) byId.set(root, { nativeId: root, workNativeId: noteId, parentNativeId: null, rootNativeId: root, author: author(tc.user_info), replyTo: null,
        text: tc.content ?? '', createdAt: isoOf(m.time), likeCount: numOrNull(tc.like_count), likedByMe: null, pinned: null, replyCount: null, ipLabel: null });
      byId.set(String(ci.id), { ...base, nativeId: String(ci.id), parentNativeId: root, rootNativeId: root, author: author(m.user_info), replyTo: null });
    } else {
      byId.set(String(ci.id), { ...base, nativeId: String(ci.id), parentNativeId: null, rootNativeId: String(ci.id), author: author(m.user_info), replyTo: null });
    }
  }
  return okResult({ platformCode: 'XiaoHongShu', accountUid: me, kind: 'comments', fetchedAt, works, comments: [...byId.values()], scannedWorks });
}

// content 是 JSON 字符串 {content, content_type}：1 文字、2 图片、3 笔记分享，其它（0 提示、25 卡片…）按 other
const TYPE = (t) => (Number(t) === 1 ? 'text' : Number(t) === 2 ? 'image' : Number(t) === 3 ? 'share' : 'other');
function body(m) { try { const c = JSON.parse(m.content); return { type: TYPE(c.content_type), text: Number(c.content_type) === 1 ? clip(c.content) : null }; } catch { return { type: 'other', text: null }; } }

export function parseDms(raw, { accountUid, fetchedAt, since = null }) {
  const me = String(accountUid);
  // U1：会话列表接口没有一页成功，整个 kind 失败（不能当成「没有私信」）
  const codes = raw.chatsCodes ?? [];
  if (!codes.length) adapterFail('no-data', '没抓到 api/im/web/v3/chats');
  if (!codes.includes(0)) adapterFail('api-error', `api/im/web/v3/chats code=${[...new Set(codes)].join(',')}`);
  if (!Array.isArray(raw.chats)) adapterFail('parse', 'api/im/web/v3/chats 的 chats 不是数组');
  // G-B3c：messages/history 只采信 code===0 且带消息数组的；打开了但失败的会话照常报，不给 messages、last 为 null
  const opened = new Map(raw.histories.filter((h) => h.chat_user_id).map((h) => [h.chat_user_id, h.code === 0 && Array.isArray(h.messages) ? h.messages : null]));
  const conversations = [], messages = [];
  for (const c of raw.chats) {
    const id = String(c.chat_user_id);
    const ms = opened.get(id) ?? null;
    // 没打开的会话判不出最后一句是谁说的：有 since 时它在 since 之后没有新消息，不报；没有 since 时 last 记 null
    if (!opened.has(id) && since) continue;
    const official = !!c.info?.is_official;
    const sorted = [...(ms ?? [])].sort((a, b) => Number(b.created_at) - Number(a.created_at));
    const lm = sorted[0];
    conversations.push({ nativeId: id, peer: { uid: id, nickname: c.info?.nickname ?? null, kind: official ? 'official' : 'user' },
      unread: Number(raw.unread?.[id]) || 0,
      last: lm ? { by: String(lm.sender_id) === me ? 'me' : 'peer', at: isoOf(lm.created_at), ...body(lm) } : null, canSend: !official });
    for (const m of sorted) messages.push({ nativeId: String(m.id), conversationNativeId: id, by: String(m.sender_id) === me ? 'me' : 'peer', at: isoOf(m.created_at), ...body(m) });
  }
  return okResult({ platformCode: 'XiaoHongShu', accountUid: me, kind: 'dms', fetchedAt, conversations, messages });
}
