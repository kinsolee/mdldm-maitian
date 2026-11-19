// B站评论、私信。页面脚本在 member.bilibili.com 页面里用 page.fetch(..., credentials:'include') 调只读接口（同 bili_comment.mjs 的读接口），
// 抄回原始 JSON；parse 在 Node 里变成约定形状。
//   评论：x/v2/reply/up/fulllist（UP 主评论管理，全部作品的评论含楼中楼，新到旧）翻到底或到页数上限；
//        近 since（默认 7 天）里出现过的楼，再用 x/v2/reply/reply?root= 拉整楼。rpid / root / parent 原样用。
//        fulllist 翻到底了，扫到的作品 complete=true（这一轮拿到了它的全部评论）。
//   私信：api.vc.bilibili.com session_svr/get_sessions（会话列表，last_msg.sender_uid 判 last.by）+
//        svr_sync/fetch_session_msgs（最近消息）+ account/v1/user/cards（对方昵称，会话列表不带）。
import { open, bigJson, mainPage, sleep } from './page-lib.mjs';
import { adapterFail, clip, isoOf, numOrNull, okResult, str } from './shape.mjs';

export const FILE = 'bili.mjs';
const PAGE = 'https://member.bilibili.com/platform/comment/article';
const API = 'https://api.bilibili.com';
const VC = 'https://api.vc.bilibili.com';
export const LIMITS = { maxPages: 25, maxThreads: 60, maxViews: 40, maxSessions: 40, maxMsgSessions: 10, gapMs: 600 };

// —— 页面脚本（ego-browser nodejs 里跑）——
export async function runInSpace(task, params) {
  const o = { ...LIMITS, ...params };
  const page = await mainPage(task);
  await open(page, PAGE);
  await sleep(3000);
  const get = async (url) => {
    const r = await page.fetch(url, { credentials: 'include', timeout: 20000 });
    const json = bigJson(String(r.body));
    if (!json) throw new Error(`GET ${url.split('?')[0]} http=${r.status} 不是 JSON`);
    return json;
  };
  const nav = await get(`${API}/x/web-interface/nav`);
  if (nav.code === -101 || !nav.data?.isLogin) return { loginLost: true, evidence: `x/web-interface/nav code=${nav.code} isLogin=${nav.data?.isLogin}` };
  const me = { mid: String(nav.data.mid) };
  const uidSeen = me.mid;
  if (params.kind === 'dms') return { kind: 'dms', uidSeen, me, ...(await rawDms(get, o)) };
  return { kind: 'comments', uidSeen, me, ...(await rawComments(get, o)) };
}

const slimMember = (m) => (m ? { mid: String(m.mid), uname: m.uname } : null);
// 只去掉体积大的展示字段（头像挂件、勋章…），结构不变
function slimReply(x) {
  if (!x || typeof x !== 'object') return x;
  const { member, content, replies, parent_info, root_info, ...rest } = x;
  return { ...rest, member: slimMember(member), content: content ? { message: content.message } : null,
    ...(parent_info ? { parent_info: { rpid: parent_info.rpid, member: slimMember(parent_info.member) } } : {}) };
}

export async function rawComments(get, o) {
  const since = (o.since ? Date.parse(o.since) : o.now - 7 * 86400_000) / 1000;
  const pages = [];
  let reachedEnd = false;
  for (let pn = 1; pn <= o.maxPages; pn++) {
    const j = await get(`${API}/x/v2/reply/up/fulllist?order=1&filter=-1&type=1&pn=${pn}&ps=20`);
    if (j.code !== 0) throw new Error(`up/fulllist code=${j.code} ${j.message ?? ''}`);
    // X2-B6：code=0 但缺 list 不能当空页（会判成到底、把旧评论标 gone）
    if (!Array.isArray(j.data?.list)) return { failed: 'api-error', error: `x/v2/reply/up/fulllist 第 ${pn} 页 code=0 但缺 data.list` };
    const list = j.data.list;
    pages.push({ code: j.code, data: { page: j.data?.page, list: list.map(slimReply) } });
    // G-B6a：total 缺失时不能拿 0 比，只有不满一页、或 total 是数字且已翻够才算到底
    const total = j.data?.page?.total;
    if (list.length < 20 || (Number.isFinite(total) && pn * 20 >= total)) { reachedEnd = true; break; }
    await sleep(o.gapMs);
  }
  const all = pages.flatMap((p) => p.data.list);
  // 近 since 里有动静的楼（一楼自己或楼里有新回复），拉整楼
  const roots = new Map();
  for (const x of all) if (x.ctime >= since) { const root = String(x.root || x.rpid); if (!roots.has(root)) roots.set(root, String(x.oid)); }
  const threads = [];
  for (const [root, oid] of [...roots].slice(0, o.maxThreads)) {
    const t = { oid, root, pages: [], ok: true };
    let done = false;
    for (let pn = 1; pn <= 10; pn++) {
      const j = await get(`${API}/x/v2/reply/reply?oid=${oid}&type=1&root=${root}&ps=20&pn=${pn}`);
      if (j.code !== 0) { t.ok = false; t.error = `reply/reply code=${j.code}`; done = true; break; }
      if (!Array.isArray(j.data?.replies) && j.data?.replies !== null) { t.ok = false; t.error = 'reply/reply 缺 data.replies'; done = true; break; }
      const rs = j.data.replies ?? [];
      const count = j.data?.page?.count;
      if (rs.length < 20 || (Number.isFinite(count) && pn * 20 >= count)) done = true;
      t.pages.push({ code: 0, data: { page: j.data?.page, root: slimReply(j.data?.root), replies: rs.map(slimReply), upper: j.data?.upper ? { mid: j.data.upper.mid, top: j.data.upper.top ? { rpid: j.data.upper.top.rpid } : null } : null } });
      if (done) break;
      await sleep(o.gapMs);
    }
    // G-B6b：翻满 10 页还没到底，这一楼拿不全
    if (!done) { t.ok = false; t.error = 'reply/reply 翻满 10 页还没到底'; }
    threads.push(t);
    await sleep(o.gapMs);
  }
  const views = {};
  for (const bvid of [...new Set(all.map((x) => x.bvid).filter(Boolean))].slice(0, o.maxViews)) {
    const j = await get(`${API}/x/web-interface/view?bvid=${bvid}`);
    views[bvid] = { code: j.code, data: j.data ? { bvid: j.data.bvid, aid: j.data.aid, title: j.data.title, pubdate: j.data.pubdate } : null };
    await sleep(o.gapMs);
  }
  return { fulllist: pages, reachedEnd, threadsCut: roots.size > o.maxThreads, threads, views };
}

export async function rawDms(get, o) {
  const sessions = [];
  let endTs = null;
  for (let i = 0; sessions.length < o.maxSessions && i < 5; i++) {
    const j = await get(`${VC}/session_svr/v1/session_svr/get_sessions?session_type=1&group_fold=1&unfollow_fold=0&sort_rule=2${endTs ? `&end_ts=${endTs}` : ''}&build=0&mobi_app=web`);
    if (j.code !== 0) throw new Error(`get_sessions code=${j.code} ${j.message ?? ''}`);
    // X2-B7：code=0 但缺 session_list 不能当没有会话
    if (!Array.isArray(j.data?.session_list)) return { failed: 'api-error', error: `session_svr/get_sessions code=0 但缺 data.session_list` };
    const l = j.data.session_list;
    sessions.push(...l);
    if (!j.data?.has_more || !l.length) break;
    endTs = l.at(-1).session_ts;
    await sleep(o.gapMs);
  }
  const list = sessions.slice(0, o.maxSessions);
  const since = o.since ? Date.parse(o.since) / 1000 : null;
  const open = list.filter((s) => s.session_type === 1 && (since == null || Number(s.last_msg?.timestamp ?? 0) > since)).slice(0, o.maxMsgSessions);
  const msgs = {};
  for (const s of open) {
    const j = await get(`${VC}/svr_sync/v1/svr_sync/fetch_session_msgs?talker_id=${s.talker_id}&session_type=${s.session_type}&size=20&build=0&mobi_app=web`);
    msgs[String(s.talker_id)] = { code: j.code, messages: Array.isArray(j.data?.messages) ? j.data.messages : null };
    await sleep(o.gapMs);
  }
  const uids = list.filter((s) => s.session_type === 1 && !s.account_info).map((s) => String(s.talker_id));
  const cards = [], cardsCodes = [];
  for (let i = 0; i < uids.length; i += 20) {
    const j = await get(`${VC}/account/v1/user/cards?uids=${uids.slice(i, i + 20).join(',')}`);
    // X2-S6：code=0 但缺 data 记成失败码
    const ok = j.code === 0 && Array.isArray(j.data);
    cardsCodes.push(ok ? 0 : j.code === 0 ? 'no-list' : j.code ?? null);
    if (ok) cards.push(...j.data.map((c) => ({ mid: String(c.mid), name: c.name })));
    await sleep(o.gapMs);
  }
  return { sessions: list.map(({ account_info, ...s }) => ({ ...s, ...(account_info ? { account_info: { name: account_info.name } } : {}) })), msgs, cards, cardsCodes };
}

// —— 解析（Node 里跑）——
export function parse(kind, raw, ctx) {
  if (!raw || raw.kind !== kind) throw new Error(`原始数据不是 ${kind}`);
  return kind === 'comments' ? parseComments(raw, ctx) : parseDms(raw, ctx);
}

const location = (x) => str(String(x.reply_control?.location ?? '').replace(/^IP属地[：:]\s*/, ''));

export function parseComments(raw, { accountUid, fetchedAt }) {
  const me = String(accountUid);
  const byId = new Map();
  const add = (x, bvid) => {
    if (!x?.rpid) return;
    const id = String(x.rpid_str ?? x.rpid);
    const prev = byId.get(id);
    byId.set(id, { ...prev, ...x, bvid: x.bvid ?? bvid ?? prev?.bvid, parent_info: x.parent_info ?? prev?.parent_info });
  };
  for (const p of raw.fulllist) for (const x of p.data.list) add(x);
  const oidToBvid = new Map([...byId.values()].map((x) => [String(x.oid), x.bvid]));
  // 拉不全的楼只影响它所在的作品；楼数超上限（threadsCut）时不知道砍掉的是哪个作品的，全部算拿不全
  const allPartial = !!raw.threadsCut;
  const badWorks = new Set();
  const pinnedIds = new Set();
  for (const t of raw.threads) {
    const bvid = oidToBvid.get(String(t.oid));
    if (!t.ok) badWorks.add(bvid ?? String(t.oid));
    for (const p of t.pages) {
      add(p.data.root, bvid);
      for (const r of p.data.replies) add(r, bvid);
      if (p.data.upper?.top?.rpid) pinnedIds.add(String(p.data.upper.top.rpid));
    }
  }
  const author = (x) => ({ uid: str(x.member?.mid ?? x.mid), nickname: x.member?.uname ?? '', isMe: String(x.member?.mid ?? x.mid) === me });
  const comments = [...byId.entries()].map(([id, x]) => {
    const root = x.root && String(x.root) !== '0' ? String(x.root) : id;
    const parent = root === id ? null : x.parent && String(x.parent) !== '0' ? String(x.parent) : root;
    return { nativeId: id, workNativeId: x.bvid ?? String(x.oid), parentNativeId: parent, rootNativeId: root, author: author(x), replyTo: null,
      text: x.content?.message ?? '', createdAt: isoOf(x.ctime), likeCount: numOrNull(x.like), likedByMe: typeof x.up_action?.like === 'boolean' ? x.up_action.like : null,
      pinned: pinnedIds.has(id) ? true : typeof x.reply_control?.is_top === 'boolean' ? x.reply_control.is_top : null,
      replyCount: numOrNull(x.rcount), ipLabel: location(x), _parentInfo: x.parent_info };
  });
  const ids = new Map(comments.map((c) => [c.nativeId, c]));
  for (const c of comments) {
    if (c.parentNativeId === null) continue;
    const p = ids.get(c.parentNativeId);
    const pm = p ? { uid: p.author.uid, nickname: p.author.nickname } : c._parentInfo?.member ? { uid: str(c._parentInfo.member.mid), nickname: c._parentInfo.member.uname ?? null } : null;
    // 直接回复一楼的不算「回复 @某人」
    c.replyTo = c.parentNativeId === c.rootNativeId ? null : pm;
  }
  for (const c of comments) delete c._parentInfo;
  const bvids = [...new Set(comments.map((c) => c.workNativeId))];
  const works = bvids.map((b) => {
    const v = raw.views[b]?.data;
    const any = [...byId.values()].find((x) => x.bvid === b);
    return { nativeId: b, title: v?.title ?? any?.title ?? null, url: /^BV/.test(b) ? `https://www.bilibili.com/video/${b}` : null, postTime: isoOf(v?.pubdate) };
  });
  const scannedWorks = bvids.map((b) => { const threadsPartial = allPartial || badWorks.has(b); return { workNativeId: b, complete: !!raw.reachedEnd && !threadsPartial, threadsPartial }; });
  return okResult({ platformCode: 'Bili', accountUid: me, kind: 'comments', fetchedAt, works, comments, scannedWorks });
}

// msg_type：1 文字、2 图片、7/11/12/14 分享（视频、专栏、卡片）、其它（撤回 5、通知卡片 10、系统 18…）
const TYPE = (t) => (t === 1 ? 'text' : t === 2 ? 'image' : [7, 11, 12, 14].includes(t) ? 'share' : 'other');
function textOf(m) {
  if (m.msg_type !== 1) return null;
  try { return clip(JSON.parse(m.content)?.content ?? null); } catch { return null; }
}

// X-B10：fetch_session_msgs 成功（code 0 且有 messages 数组）才用；失败的会话不给 messages，不拿空数组冒充「没有消息」
const msgsOk = (x) => x?.code === 0 && Array.isArray(x.messages);

export function parseDms(raw, { accountUid, fetchedAt }) {
  const me = String(accountUid);
  const tried = Object.entries(raw.msgs ?? {});
  if (tried.length && !tried.some(([, x]) => msgsOk(x))) adapterFail('api-error', `svr_sync/fetch_session_msgs 全部失败：code=${[...new Set(tried.map(([, x]) => x?.code))].join(',')}`);
  const cc = raw.cardsCodes ?? [];
  if (cc.length && !cc.includes(0)) adapterFail('api-error', `account/v1/user/cards 全部失败：code=${[...new Set(cc)].join(',')}`);
  const names = new Map(raw.cards.map((c) => [String(c.mid), c.name]));
  const conversations = [], messages = [];
  for (const s of raw.sessions) {
    const id = String(s.talker_id);
    const official = !!s.account_info || Number(s.system_msg_type) > 0;
    const kind = s.session_type === 2 ? 'group' : official ? 'official' : 'user';
    const lm = s.last_msg;
    const last = lm && lm.timestamp ? { by: String(lm.sender_uid) === me ? 'me' : 'peer', at: isoOf(lm.timestamp), text: textOf(lm), type: TYPE(lm.msg_type) } : null;
    conversations.push({ nativeId: id, peer: { uid: id, nickname: s.account_info?.name ?? names.get(id) ?? null, kind },
      unread: Number(s.unread_count) || 0, last, canSend: kind === 'user' });
    for (const m of msgsOk(raw.msgs[id]) ? raw.msgs[id].messages : []) {
      messages.push({ nativeId: String(m.msg_key ?? m.msg_seqno), conversationNativeId: id, by: String(m.sender_uid) === me ? 'me' : 'peer', at: isoOf(m.timestamp), type: TYPE(m.msg_type), text: textOf(m) });
    }
  }
  return okResult({ platformCode: 'Bili', accountUid: me, kind: 'dms', fetchedAt, conversations, messages });
}
