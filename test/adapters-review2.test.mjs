// KIN-323 评审第 2 轮（X2-B1…X2-B7）和同类扫描（X2-S*）的回归测试：页面脚本不能把缺失字段归一成空数组。
// 每条都走到页面脚本那一层：导出的归一化纯函数、在假 shadowRoot 上跑视频号的页面内取数源码、给 B站页面脚本注入假 get。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { collect } from '../src/ops/engage/adapters/index.mjs';
import * as bili from '../src/ops/engage/adapters/bili.mjs';
import * as douyin from '../src/ops/engage/adapters/douyin.mjs';
import * as channels from '../src/ops/engage/adapters/channels.mjs';
import * as xhs from '../src/ops/engage/adapters/xhs.mjs';

const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/engage/${name}.json`, import.meta.url), 'utf8'));
const NOW = Date.parse('2026-11-19T13:40:00.000Z');
const fetchedAt = new Date(NOW).toISOString();
const ACCOUNTS = {
  Douyin: { platformCode: 'Douyin', uid: 'user_68f33f7a', spaceName: 'kinso/Douyin/x', profileId: 'Profile 5', nickname: null },
  XiaoHongShu: { platformCode: 'XiaoHongShu', uid: 'user_de0cde99', spaceName: 'kinso/XiaoHongShu/x', profileId: 'Profile 5', nickname: null },
  Channels: { platformCode: 'Channels', uid: 'user_c20ee8c3', spaceName: 'kinso/Channels/x', profileId: 'Profile 5', nickname: null },
  Bili: { platformCode: 'Bili', uid: 'user_8f127407', spaceName: 'kinso/Bili/x', profileId: 'Profile 5', nickname: null },
};
const run = (code, kind, raw) => collect({ account: ACCOUNTS[code], kind, now: () => NOW, runner: async () => ({ ok: true, result: raw }) });
const scanned = (r, id) => r.scannedWorks.find((s) => s.workNativeId === id);

// —— 小红书 ——
const XHS_FULL = '6afbd09e00000000250132bd';
test('X2-B1 小红书：comment/page 响应 code=0 但缺 comments，归一后仍是 null，这篇笔记不算拿全', async () => {
  const page = xhs.slimCommentPage({ url: 'https://edith.xiaohongshu.com/api/sns/web/v2/comment/page?note_id=n', json: { code: 0, data: { has_more: false } } });
  assert.equal(page.data.comments, null);
  const raw = fixture('xhs-comments');
  const n = raw.notes.find((x) => x.noteId === XHS_FULL);
  n.pages = [page];
  n.subs = [];
  const r = await run('XiaoHongShu', 'comments', raw);
  assert.deepEqual(scanned(r, XHS_FULL), { workNativeId: XHS_FULL, complete: false, threadsPartial: true });
});

test('X2-B1 小红书：comment/sub/page 响应缺 comments，这篇笔记楼中楼拿不全', async () => {
  const sub = xhs.slimCommentPage({ url: 'https://edith.xiaohongshu.com/api/sns/web/v2/comment/sub/page?root_comment_id=r', json: { code: 0, data: { has_more: false } } });
  assert.equal(sub.data.comments, null);
  const raw = fixture('xhs-comments');
  raw.notes.find((x) => x.noteId === XHS_FULL).subs = [sub];
  const r = await run('XiaoHongShu', 'comments', raw);
  assert.deepEqual(scanned(r, XHS_FULL), { workNativeId: XHS_FULL, complete: false, threadsPartial: true });
});

test('X2-B2 小红书：you/mentions code=0 但缺 message_list，不算成功页 → api-error', async () => {
  const m = xhs.slimMentionPage({ code: 0, data: { has_more: false } });
  assert.equal(m.data.message_list, null);
  const r = await run('XiaoHongShu', 'comments', { ...fixture('xhs-comments'), mentions: [m] });
  assert.deepEqual([r.ok, r.reason], [false, 'api-error']);
  // 明确为空数组才是成功的空结果
  const empty = await run('XiaoHongShu', 'comments', { ...fixture('xhs-comments'), mentions: [xhs.slimMentionPage({ code: 0, data: { has_more: false, message_list: [] } })], notes: [] });
  assert.deepEqual([empty.ok, empty.comments.length], [true, 0]);
});

test('X2-S1 小红书：v3/chats code=0 但缺 chats，不算成功页 → api-error', async () => {
  assert.equal(xhs.chatsCodeOf({ code: 0, data: {} }), 'no-list');
  assert.equal(xhs.chatsCodeOf({ code: 0, data: { chats: [] } }), 0);
  const r = await run('XiaoHongShu', 'dms', { ...fixture('xhs-dms'), chatsCodes: [xhs.chatsCodeOf({ code: 0, data: {} })] });
  assert.deepEqual([r.ok, r.reason], [false, 'api-error']);
});

test('X2-S2 小红书：messages/history code=0 但缺消息列表，归一后是 null，不给 messages', async () => {
  const h = xhs.slimHistory('peer', { code: 0, data: {} });
  assert.equal(h.messages, null);
  const raw = fixture('xhs-dms');
  raw.histories[0] = xhs.slimHistory(raw.histories[0].chat_user_id, { code: 0, data: {} });
  const r = await run('XiaoHongShu', 'dms', raw);
  assert.equal(r.conversations.find((c) => c.nativeId === raw.histories[0].chat_user_id).last, null);
  assert.ok(!r.messages.some((m) => m.conversationNativeId === raw.histories[0].chat_user_id));
});

// —— 视频号：在假的 wujie shadowRoot 上跑页面内的取数源码 ——
function fakeShadow({ wraps = [], items = [], others = [] }) {
  const all = [...wraps, ...items, ...others];
  const pick = (sel) => (sel === '.comment-feed-wrap' ? wraps : sel === '.comment-item' ? items : sel === '.session-wrap' ? others.filter((e) => e.cls === 'session-wrap') : sel === '*' ? all : []);
  return { querySelector: (sel) => pick(sel)[0] ?? null, querySelectorAll: (sel) => pick(sel) };
}
const runSrc = (src, sr) => new Function('sr', src)(sr);

test('X2-B3 视频号：作品列表组件在、commentFeeds 是合法空数组 → 明确为空，ok 空结果', async () => {
  const vmHost = { __vue__: { commentFeeds: [] }, parentElement: null };
  const feeds = runSrc(channels.FEEDS_SRC, fakeShadow({ others: [vmHost] }));
  assert.deepEqual(feeds, []);
  const r = await run('Channels', 'comments', { ...fixture('channels-comments'), ...channels.listState('feeds', feeds, false), works: [] });
  assert.deepEqual([r.ok, r.works, r.comments], [true, [], []]);
  // 组件读不到才是 no-data
  const none = runSrc(channels.FEEDS_SRC, fakeShadow({ others: [{ parentElement: null }] }));
  assert.equal(none, null);
  const r2 = await run('Channels', 'comments', { ...fixture('channels-comments'), ...channels.listState('feeds', none, false), works: [] });
  assert.deepEqual([r2.ok, r2.reason], [false, 'no-data']);
});

test('X2-B3 视频号私信：sessionList 是合法空数组 → ok 空结果；组件读不到 → no-data', async () => {
  const host = { cls: 'session-wrap', __vue__: { $data: { sessionList: [] } }, parentElement: null };
  const sessions = runSrc(channels.SESSIONS_SRC, fakeShadow({ others: [host] }));
  assert.deepEqual(sessions, []);
  const r = await run('Channels', 'dms', { ...fixture('channels-dms'), ...channels.listState('sessions', sessions, false) });
  assert.deepEqual([r.ok, r.conversations], [true, []]);
  const none = runSrc(channels.SESSIONS_SRC, fakeShadow({ others: [] }));
  const r2 = await run('Channels', 'dms', { ...fixture('channels-dms'), ...channels.listState('sessions', none, false) });
  assert.deepEqual([r2.ok, r2.reason], [false, 'no-data']);
});

test('X2-B4 视频号：评论组件没有 dataSource 或一个评论组件都没有 → items 是 null，不是 []', async () => {
  assert.equal(runSrc(channels.ITEMS_SRC, fakeShadow({ items: [{ __vue__: { $props: {} } }] })), null);
  assert.equal(runSrc(channels.ITEMS_SRC, fakeShadow({ items: [] })), null);
  const ok = runSrc(channels.ITEMS_SRC, fakeShadow({ items: [{ __vue__: { $props: { dataSource: { commentId: 'c1', commentNickname: 'n', levelTwoComment: [] } } } }] }));
  assert.equal(ok.length, 1);
  // 评论数为 0、打开过但 items 读不到的作品不能 complete
  const raw = fixture('channels-comments');
  const w = raw.works[0];
  raw.feeds.find((f) => f.objectNonce === w.objectNonce).commentCount = 0;
  w.items = runSrc(channels.ITEMS_SRC, fakeShadow({ items: [] }));
  const r = await run('Channels', 'comments', raw);
  assert.equal(scanned(r, w.objectNonce).complete, false);
});

test('X2-S3 视频号：还剩几个「展开更多回复」读不到（null）时不算拿全', async () => {
  const raw = fixture('channels-comments');
  raw.works[0].expandLeft = null;
  const r = await run('Channels', 'comments', raw);
  assert.equal(scanned(r, raw.works[0].objectNonce).complete, false);
});

// —— 抖音 ——
const DY_FULL = '7708984451971452170';
test('X2-B5 抖音：comment/list/select 缺 comments，归一后是 null，算这个作品的接口错误', async () => {
  const bad = douyin.slimList({ status_code: 0, has_more: 0 });
  assert.equal(bad.comments, null);
  const raw = fixture('douyin-comments');
  const w = raw.works.find((x) => x.item_id_plain === DY_FULL);
  const { select, selectErrors } = douyin.splitSelect([...w.select, bad], DY_FULL, [bad]);
  assert.equal(select.length, w.select.length);
  assert.equal(selectErrors.length, 1);
  Object.assign(w, { select, selectErrors });
  const r = await run('Douyin', 'comments', raw);
  assert.deepEqual(scanned(r, DY_FULL), { workNativeId: DY_FULL, complete: false, threadsPartial: true });
});

test('X2-B5 抖音：comment/list/reply 缺 comments，这个作品楼中楼拿不全', async () => {
  const raw = fixture('douyin-comments');
  raw.works.find((x) => x.item_id_plain === DY_FULL).replies.push(douyin.slimList({ status_code: 0, has_more: 0 }));
  const r = await run('Douyin', 'comments', raw);
  assert.deepEqual(scanned(r, DY_FULL), { workNativeId: DY_FULL, complete: false, threadsPartial: true });
});

test('X2-S4 抖音：creator/item/list status_code=0 但缺 item_info_list 不算成功；comment_count 缺失的作品不当 0 评论补进 scannedWorks', async () => {
  assert.equal(douyin.itemListCodeOf({ status_code: 0 }), 'no-list');
  assert.equal(douyin.itemListCodeOf({ status_code: 0, item_info_list: [] }), 0);
  const r = await run('Douyin', 'comments', { ...fixture('douyin-comments'), itemListCodes: ['no-list'] });
  assert.deepEqual([r.ok, r.reason], [false, 'api-error']);
  assert.equal(douyin.slimItem({ item_id_plain: '1', title: 't' }).comment_count, null);
  const raw = fixture('douyin-comments');
  raw.items.find((x) => x.item_id_plain === '7708831891893341466').comment_count = null;
  const r2 = await run('Douyin', 'comments', raw);
  assert.equal(scanned(r2, '7708831891893341466'), undefined);
});

// —— B站：给页面脚本注入假 get ——
const recent = Math.floor(NOW / 1000) - 3600;
const o = { ...bili.LIMITS, gapMs: 0, now: NOW, since: null };
const reply = (rpid, oid, bvid) => ({ rpid, oid, root: 0, parent: 0, ctime: recent, mid: 1, member: { mid: '1', uname: 'a' }, content: { message: 'x' }, bvid, title: 't' });
const routes = (map) => async (url) => { const p = new URL(url).pathname; for (const [k, f] of Object.entries(map)) if (p.endsWith(k)) return f(new URL(url)); throw new Error(url); };

test('X2-B6 B站：up/fulllist code=0 但缺 data.list，不判到底 → api-error', async () => {
  const raw = await bili.rawComments(routes({ '/up/fulllist': () => ({ code: 0, data: { page: { total: 40 } } }) }), o);
  assert.equal(raw.failed, 'api-error');
  assert.match(raw.error, /up\/fulllist/);
  const r = await run('Bili', 'comments', { kind: 'comments', uidSeen: 'user_8f127407', ...raw });
  assert.deepEqual([r.ok, r.reason], [false, 'api-error']);
});

test('X2-S5 B站：单楼 reply/reply code=0 但缺 replies，这一楼拿不全', async () => {
  const get = routes({
    '/up/fulllist': (u) => ({ code: 0, data: { page: { total: 1 }, list: u.searchParams.get('pn') === '1' ? [reply(1, 7, 'BV1')] : [] } }),
    '/reply/reply': () => ({ code: 0, data: { page: { count: 3 } } }),
    '/web-interface/view': () => ({ code: 0, data: { bvid: 'BV1', aid: 7, title: 't', pubdate: recent } }),
  });
  const raw = await bili.rawComments(get, o);
  assert.equal(raw.threads[0].ok, false);
  const r = bili.parse('comments', { kind: 'comments', ...raw }, { accountUid: 'u', fetchedAt });
  assert.deepEqual(scanned(r, 'BV1'), { workNativeId: 'BV1', complete: false, threadsPartial: true });
});

// X3-B1：replies=null 只有在 page.count 明确为 0 时才算空楼；count>0 或缺失时这一楼拿不全，不能把已有楼中楼标 gone
const biliThread = (data) => routes({
  '/up/fulllist': (u) => ({ code: 0, data: { page: { total: 1 }, list: u.searchParams.get('pn') === '1' ? [reply(1, 7, 'BV1')] : [] } }),
  '/reply/reply': () => ({ code: 0, data }),
  '/web-interface/view': () => ({ code: 0, data: { bvid: 'BV1', aid: 7, title: 't', pubdate: recent } }),
});
const biliScanned = async (data) => {
  const raw = await bili.rawComments(biliThread(data), o);
  return [raw.threads[0].ok, scanned(bili.parse('comments', { kind: 'comments', ...raw }, { accountUid: 'u', fetchedAt }), 'BV1')];
};

test('X3-B1 B站：单楼 reply/reply code=0、replies=null 但 page.count>0，这一楼拿不全', async () => {
  const [ok, s] = await biliScanned({ page: { count: 3 }, replies: null });
  assert.equal(ok, false);
  assert.deepEqual(s, { workNativeId: 'BV1', complete: false, threadsPartial: true });
});

test('X3-B1 B站：replies=null 且缺 page.count，不当空楼', async () => {
  const [ok, s] = await biliScanned({ replies: null });
  assert.equal(ok, false);
  assert.equal(s.complete, false);
});

test('X3-B1 B站：replies=null 且 page.count 明确为 0，才算空楼', async () => {
  const [ok, s] = await biliScanned({ page: { count: 0 }, replies: null });
  assert.equal(ok, true);
  assert.deepEqual(s, { workNativeId: 'BV1', complete: true, threadsPartial: false });
});

test('X3-B1 B站：最后一页不满 20 条但累计条数不到 page.count，这一楼拿不全', async () => {
  const sub = { rpid: 2, oid: 7, root: 1, parent: 1, ctime: recent, mid: 2, member: { mid: '2', uname: 'b' }, content: { message: 'y' } };
  const [ok, s] = await biliScanned({ page: { count: 3 }, replies: [sub] });
  assert.equal(ok, false);
  assert.equal(s.complete, false);
});

test('X3-B1 B站：累计条数达到 page.count，照常算拿全', async () => {
  const sub = { rpid: 2, oid: 7, root: 1, parent: 1, ctime: recent, mid: 2, member: { mid: '2', uname: 'b' }, content: { message: 'y' } };
  const [ok, s] = await biliScanned({ page: { count: 1 }, replies: [sub] });
  assert.equal(ok, true);
  assert.equal(s.complete, true);
});

test('X2-B7 B站：get_sessions code=0 但缺 session_list → api-error；明确为空 → ok 空会话', async () => {
  const bad = await bili.rawDms(routes({ '/get_sessions': () => ({ code: 0, data: { has_more: 0 } }) }), o);
  assert.equal(bad.failed, 'api-error');
  assert.match(bad.error, /get_sessions/);
  const empty = await bili.rawDms(routes({ '/get_sessions': () => ({ code: 0, data: { has_more: 0, session_list: [] } }) }), o);
  const r = await run('Bili', 'dms', { kind: 'dms', uidSeen: 'user_8f127407', ...empty });
  assert.deepEqual([r.ok, r.conversations], [true, []]);
});

test('X2-S6 B站：user/cards code=0 但缺 data，记成失败码，不当成功', async () => {
  const get = routes({
    '/get_sessions': () => ({ code: 0, data: { has_more: 0, session_list: [{ talker_id: 5, session_type: 1, unread_count: 0, last_msg: { sender_uid: 5, msg_type: 1, content: '{"content":"x"}', timestamp: recent, msg_key: 9 } }] } }),
    '/fetch_session_msgs': () => ({ code: 0, data: { messages: [] } }),
    '/user/cards': () => ({ code: 0 }),
  });
  const raw = await bili.rawDms(get, o);
  assert.deepEqual(raw.cardsCodes, ['no-list']);
  const r = await run('Bili', 'dms', { kind: 'dms', uidSeen: 'user_8f127407', ...raw });
  assert.deepEqual([r.ok, r.reason], [false, 'api-error']);
});

test('X2-S7 抖音私信（U1 复查）：有会话行却读不到 fiber 不算空；Semi 空状态或「暂无私信」才算明确为空', () => {
  const doc = ({ rows = 0, empty = false, text = '' }) => ({ querySelectorAll: () => ({ length: rows }), querySelector: (s) => (s === '.semi-list-empty' && empty ? {} : null), body: { innerText: text } });
  assert.equal(douyin.dyDmEmptyState(doc({ rows: 3, empty: true })), false);
  assert.equal(douyin.dyDmEmptyState(doc({ empty: true })), true);
  assert.equal(douyin.dyDmEmptyState(doc({ text: '暂无私信' })), true);
  assert.equal(douyin.dyDmEmptyState(doc({ text: '加载中' })), false);
});

test('X2-S8 小红书、抖音：一楼的子评论总数缺失时，这个作品楼中楼算拿不全', async () => {
  const x = fixture('xhs-comments');
  delete x.notes.find((n) => n.noteId === XHS_FULL).pages[0].data.comments[0].sub_comment_count;
  assert.deepEqual(scanned(await run('XiaoHongShu', 'comments', x), XHS_FULL), { workNativeId: XHS_FULL, complete: false, threadsPartial: true });
  const d = fixture('douyin-comments');
  delete d.works.find((w) => w.item_id_plain === DY_FULL).select[0].comments[0].reply_comment_total;
  assert.deepEqual(scanned(await run('Douyin', 'comments', d), DY_FULL), { workNativeId: DY_FULL, complete: false, threadsPartial: true });
});
