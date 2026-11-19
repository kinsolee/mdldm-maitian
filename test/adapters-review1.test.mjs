// KIN-323 评审第 1 轮阻断（X-B3/X-B4/X-B5/X-B10/X-B11）的回归测试：接口出错、页面数据读不到时，
// 出错的作品绝不能 complete:true，读不到列表绝不能报 ok:true。经 collect 注入假 runner，喂改过的脱敏样例。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { collect } from '../src/ops/engage/adapters/index.mjs';

const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/engage/${name}.json`, import.meta.url), 'utf8'));
const NOW = Date.parse('2026-11-19T13:40:00.000Z');
const ACCOUNTS = {
  Douyin: { platformCode: 'Douyin', uid: 'user_68f33f7a', spaceName: 'kinso/Douyin/x', profileId: 'Profile 5', nickname: null },
  XiaoHongShu: { platformCode: 'XiaoHongShu', uid: 'user_de0cde99', spaceName: 'kinso/XiaoHongShu/x', profileId: 'Profile 5', nickname: null },
  Channels: { platformCode: 'Channels', uid: 'user_c20ee8c3', spaceName: 'kinso/Channels/x', profileId: 'Profile 5', nickname: null },
  Bili: { platformCode: 'Bili', uid: 'user_8f127407', spaceName: 'kinso/Bili/x', profileId: 'Profile 5', nickname: null },
};
const run = (code, kind, raw, extra = {}) => collect({ account: ACCOUNTS[code], kind, now: () => NOW, runner: async () => ({ ok: true, result: raw }), ...extra });
const scanned = (r, id) => r.scannedWorks.find((s) => s.workNativeId === id);

// —— X-B3 抖音 ——
const DY_FULL = '7708984451971452170';
test('X-B3 抖音：一楼列表有一条 status_code 非 0 的响应，这个作品不算拿全，别的作品照常', async () => {
  const raw = fixture('douyin-comments');
  raw.works.find((w) => w.item_id_plain === DY_FULL).selectErrors = [{ status_code: 2154 }];
  const r = await run('Douyin', 'comments', raw);
  assert.equal(r.ok, true);
  assert.deepEqual(scanned(r, DY_FULL), { workNativeId: DY_FULL, complete: false, threadsPartial: true });
  assert.ok(r.scannedWorks.some((s) => s.workNativeId !== DY_FULL && s.complete));
});

test('X-B3 抖音：最后一页一楼列表没有 has_more（结构不明），不算拿全', async () => {
  const raw = fixture('douyin-comments');
  delete raw.works.find((w) => w.item_id_plain === DY_FULL).select.at(-1).has_more;
  const r = await run('Douyin', 'comments', raw);
  assert.equal(scanned(r, DY_FULL).complete, false);
});

test('X-B3 抖音：子回复响应 status_code 非 0，这个作品楼中楼拿不全', async () => {
  const raw = fixture('douyin-comments');
  raw.works.find((w) => w.item_id_plain === DY_FULL).replies[0].status_code = 8;
  const r = await run('Douyin', 'comments', raw);
  assert.deepEqual(scanned(r, DY_FULL), { workNativeId: DY_FULL, complete: false, threadsPartial: true });
});

test('X-B3 抖音：作品列表接口全部非 0 → api-error；没抓到作品列表 → no-data', async () => {
  const bad = fixture('douyin-comments');
  bad.itemListCodes = [8];
  const r1 = await run('Douyin', 'comments', bad);
  assert.deepEqual([r1.ok, r1.reason], [false, 'api-error']);
  assert.match(r1.error, /item\/list/);
  const none = fixture('douyin-comments');
  none.itemListCodes = [];
  const r2 = await run('Douyin', 'comments', none);
  assert.deepEqual([r2.ok, r2.reason], [false, 'no-data']);
});

// —— X-B4 小红书 ——
const XHS_FULL = '6afbd09e00000000250132bd';
test('X-B4 小红书：笔记页 comment/page 返回 code 非 0，这篇笔记不算拿全', async () => {
  const raw = fixture('xhs-comments');
  raw.notes.find((n) => n.noteId === XHS_FULL).pages[0].code = -1;
  const r = await run('XiaoHongShu', 'comments', raw);
  assert.equal(r.ok, true);
  assert.deepEqual(scanned(r, XHS_FULL), { workNativeId: XHS_FULL, complete: false, threadsPartial: true });
});

test('X-B4 小红书：comment/sub/page 返回 code 非 0，这篇笔记楼中楼拿不全', async () => {
  const raw = fixture('xhs-comments');
  raw.notes.find((n) => n.noteId === XHS_FULL).subs[0].code = 300013;
  const r = await run('XiaoHongShu', 'comments', raw);
  assert.deepEqual(scanned(r, XHS_FULL), { workNativeId: XHS_FULL, complete: false, threadsPartial: true });
});

test('X-B4 小红书：comment/page 缺 comments 数组，不算拿全', async () => {
  const raw = fixture('xhs-comments');
  delete raw.notes.find((n) => n.noteId === XHS_FULL).pages[0].data.comments;
  const r = await run('XiaoHongShu', 'comments', raw);
  assert.equal(scanned(r, XHS_FULL).complete, false);
});

test('X-B4 小红书：you/mentions 全部 code 非 0 → api-error', async () => {
  const raw = fixture('xhs-comments');
  for (const m of raw.mentions) m.code = -1;
  const r = await run('XiaoHongShu', 'comments', raw);
  assert.deepEqual([r.ok, r.reason], [false, 'api-error']);
  assert.match(r.error, /you\/mentions/);
});

// —— X-B11 小红书通知兜底按窗口过滤 ——
test('X-B11 小红书：通知兜底入库前按抓取窗口过滤，窗口之前的旧通知不入库', async () => {
  const raw = fixture('xhs-comments');   // windowStart = 2026-11-12T13:37:31Z
  const r = await run('XiaoHongShu', 'comments', raw);
  const ids = new Set(r.comments.map((c) => c.nativeId));
  for (const old of ['6af3d977000000000a01f3df', '6aeedc95000000001402c9f2', '6ad403df0000000008035d5a']) assert.ok(!ids.has(old), `${old} 在窗口之前`);
  assert.ok(!r.works.some((w) => w.nativeId === '6af3d48c000000002c00ef84'), '只有旧通知的笔记也不报');
  const wide = await run('XiaoHongShu', 'comments', fixture('xhs-comments'), { since: '2026-11-10T00:00:00.000Z' });
  assert.ok(wide.comments.some((c) => c.nativeId === '6af3d977000000000a01f3df'), 'since 放宽后照常入库');
  assert.ok(!wide.comments.some((c) => c.nativeId === '6aeedc95000000001402c9f2'));
});

// —— X-B5 视频号 ——
test('X-B5 视频号：作品列表的 Vue 数据读不到 → no-data，不报 ok', async () => {
  const raw = fixture('channels-comments');
  raw.feeds = null;
  raw.note = '作品列表组件没找到';
  const r = await run('Channels', 'comments', raw);
  assert.deepEqual([r.ok, r.reason], [false, 'no-data']);
});

test('X-B5 视频号：作品列表为空且页面没显示空状态 → no-data；页面明确为空才 ok', async () => {
  const raw = { ...fixture('channels-comments'), feeds: [], works: [] };
  const r = await run('Channels', 'comments', raw);
  assert.deepEqual([r.ok, r.reason], [false, 'no-data']);
  const empty = await run('Channels', 'comments', { ...raw, emptyState: true });
  assert.equal(empty.ok, true);
  assert.deepEqual([empty.works, empty.comments], [[], []]);
});

test('X-B5 视频号：打开的作品读不到评论组件，这个作品不算拿全', async () => {
  const raw = fixture('channels-comments');
  const w = raw.works[0];
  w.items = null;
  const r = await run('Channels', 'comments', raw);
  assert.equal(r.ok, true);
  assert.deepEqual(scanned(r, w.objectNonce), { workNativeId: w.objectNonce, complete: false, threadsPartial: true });
});

test('X-B5 视频号：私信会话列表读不到 → no-data；为空且没显示空状态 → no-data', async () => {
  const r1 = await run('Channels', 'dms', { ...fixture('channels-dms'), sessions: null });
  assert.deepEqual([r1.ok, r1.reason], [false, 'no-data']);
  const r2 = await run('Channels', 'dms', { ...fixture('channels-dms'), sessions: [] });
  assert.deepEqual([r2.ok, r2.reason], [false, 'no-data']);
  const r3 = await run('Channels', 'dms', { ...fixture('channels-dms'), sessions: [], emptyState: true });
  assert.equal(r3.ok, true);
});

// —— X-B10 B站私信 ——
test('X-B10 B站：fetch_session_msgs 返回非 0 的会话不给 messages，会话本身照常', async () => {
  const raw = fixture('bili-dms');
  const [bad, ...rest] = Object.keys(raw.msgs);
  raw.msgs[bad] = { code: -400, messages: raw.msgs[bad].messages };   // 非 0 时带回来的消息也不能用
  const r = await run('Bili', 'dms', raw);
  assert.equal(r.ok, true);
  assert.ok(r.conversations.some((c) => c.nativeId === bad), '会话照常报');
  assert.ok(!r.messages.some((m) => m.conversationNativeId === bad), '失败的会话不给空消息冒充');
  assert.ok(r.messages.some((m) => rest.includes(m.conversationNativeId)));
});

test('X-B10 B站：fetch_session_msgs 全部失败 → api-error；user/cards 全部失败 → api-error', async () => {
  const raw = fixture('bili-dms');
  for (const k of Object.keys(raw.msgs)) raw.msgs[k] = { code: -101, messages: [] };
  const r = await run('Bili', 'dms', raw);
  assert.deepEqual([r.ok, r.reason], [false, 'api-error']);
  assert.match(r.error, /fetch_session_msgs/);
  const r2 = await run('Bili', 'dms', { ...fixture('bili-dms'), cardsCodes: [-412] });
  assert.deepEqual([r2.ok, r2.reason], [false, 'api-error']);
  assert.match(r2.error, /user\/cards/);
});

// —— U1（协调者升级）：私信列表读不到不能报 ok ——
test('U1 抖音私信：0 个会话且页面没显示空状态 → no-data；明确为空才 ok', async () => {
  const r = await run('Douyin', 'dms', { ...fixture('douyin-dms'), conversations: [] });
  assert.deepEqual([r.ok, r.reason], [false, 'no-data']);
  const empty = await run('Douyin', 'dms', { ...fixture('douyin-dms'), conversations: [], emptyState: true });
  assert.deepEqual([empty.ok, empty.conversations], [true, []]);
});

test('U1 小红书私信：v3/chats 没有一页 code=0 → api-error；成功且为空才 ok', async () => {
  const r = await run('XiaoHongShu', 'dms', { ...fixture('xhs-dms'), chatsCodes: [-1, 300013] });
  assert.deepEqual([r.ok, r.reason], [false, 'api-error']);
  assert.match(r.error, /v3\/chats/);
  const empty = await run('XiaoHongShu', 'dms', { kind: 'dms', chatsCodes: [0], chats: [], unread: {}, histories: [] });
  assert.deepEqual([empty.ok, empty.conversations], [true, []]);
});
