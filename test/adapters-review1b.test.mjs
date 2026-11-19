// KIN-323 评审第 1 轮 Gemini 补发（G-B3c/G-B4b/G-B4c/G-B5a/G-B6a/G-B6b/G-B7/G-B11a）的回归测试。
// 不连真实平台：经 collect 注入假 runner，或给 B站页面脚本注入假的 get。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { collect } from '../src/ops/engage/adapters/index.mjs';
import * as bili from '../src/ops/engage/adapters/bili.mjs';
import * as channels from '../src/ops/engage/adapters/channels.mjs';

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

// —— G-B7 账号核对 ——
for (const [code, name] of [['Bili', 'bili-comments'], ['Douyin', 'douyin-dms'], ['Channels', 'channels-comments'], ['XiaoHongShu', 'xhs-dms']]) {
  test(`G-B7 ${code}：页面上登录的不是这个账号 → uid-mismatch；读不到 uid → no-uid；都不入库`, async () => {
    const kind = name.endsWith('dms') ? 'dms' : 'comments';
    const wrong = await run(code, kind, { ...fixture(name), uidSeen: 'someone-else' });
    assert.deepEqual([wrong.ok, wrong.reason], [false, 'uid-mismatch']);
    assert.equal(wrong.comments, undefined);
    const none = await run(code, kind, { ...fixture(name), uidSeen: null });
    assert.deepEqual([none.ok, none.reason], [false, 'no-uid']);
    const ok = await run(code, kind, fixture(name));
    assert.equal(ok.ok, true);
  });
}

// —— G-B3c 小红书私信 messages/history ——
test('G-B3c 小红书私信：messages/history 返回 code 非 0，这个会话不给 messages、last 为 null', async () => {
  const raw = fixture('xhs-dms');
  const h = raw.histories[0];
  h.code = -1;
  const r = await run('XiaoHongShu', 'dms', raw);
  assert.equal(r.ok, true);
  const c = r.conversations.find((x) => x.nativeId === h.chat_user_id);
  assert.ok(c, '会话照常报');
  assert.equal(c.last, null);
  assert.ok(!r.messages.some((m) => m.conversationNativeId === h.chat_user_id));
  // 有 since 时也照常报这个会话（它有新消息，只是没读成）
  const r2 = await run('XiaoHongShu', 'dms', raw, { since: '2026-11-18T00:00:00.000Z' });
  assert.equal(r2.conversations.find((x) => x.nativeId === h.chat_user_id)?.last, null);
});

// —— G-B4c 视频号 commentCount ——
test('G-B4c 视频号：作品 commentCount 缺失 → complete:false', async () => {
  const raw = fixture('channels-comments');
  const w = raw.works[0];
  delete raw.feeds.find((f) => f.objectNonce === w.objectNonce).commentCount;
  const r = await run('Channels', 'comments', raw);
  assert.equal(scanned(r, w.objectNonce).complete, false);
});

test('G-B4c 视频号：读到的评论少于 commentCount（含组件没渲染出评论）→ threadsPartial:true、complete:false', async () => {
  const raw = fixture('channels-comments');
  const [w0, w1] = raw.works;
  w0.items = [];
  w1.items = w1.items.slice(0, 2);
  const r = await run('Channels', 'comments', raw);
  for (const w of [w0, w1]) assert.deepEqual(scanned(r, w.objectNonce), { workNativeId: w.objectNonce, complete: false, threadsPartial: true });
});

// —— G-B4b 视频号 auth ——
const fakePage = (authBody, url = 'https://channels.weixin.qq.com/platform/interaction/comment') => ({
  goto: async () => {}, url: async () => url, evaluate: async () => null,
  fetch: async () => (authBody instanceof Error ? Promise.reject(authBody) : { status: 200, body: authBody }),
});
const fakeTask = (page) => ({ pages: async () => [page], tabs: async () => [], newPage: async () => page });
test('G-B4b 视频号：auth_data 超时、不是 JSON、缺 finderUser 昵称时返回 auth-failed；errCode≠0 算掉线', async () => {
  const params = { kind: 'comments', now: NOW, waitMs: 10 };
  for (const body of [new Error('timeout'), '<html>', JSON.stringify({ errCode: 0, data: {} }), JSON.stringify({ errCode: 0, data: { finderUser: { uniqId: 'x' } } })]) {
    const r = await channels.runInSpace(fakeTask(fakePage(body)), params);
    assert.equal(r.failed, 'auth-failed', `body=${String(body).slice(0, 30)}`);
  }
  const lost = await channels.runInSpace(fakeTask(fakePage(JSON.stringify({ errCode: 300333 }))), params);
  assert.equal(lost.loginLost, true);
});

// —— G-B5a 抖音一个作品都没打开 ——
test('G-B5a 抖音：近期有评论的作品一个都没打开（选择作品改版）→ no-data', async () => {
  const raw = fixture('douyin-comments');
  raw.works = raw.works.map((w) => ({ item_id_plain: w.item_id_plain, opened: false }));
  const r = await run('Douyin', 'comments', raw);
  assert.deepEqual([r.ok, r.reason], [false, 'no-data']);
});

// —— G-B11a 评论数为 0 的作品 ——
test('G-B11a 抖音：窗口内评论数为 0 的作品补进 scannedWorks，complete:true', async () => {
  const r = await run('Douyin', 'comments', fixture('douyin-comments'));
  for (const id of ['7708831891893341466', '7707680385378913536', '7706754730248741199']) {
    assert.deepEqual(scanned(r, id), { workNativeId: id, complete: true, threadsPartial: false });
    assert.ok(r.works.some((w) => w.nativeId === id));
  }
});

test('G-B11a 视频号：窗口内评论数为 0 的作品补进 scannedWorks，窗口外的不补', async () => {
  const raw = fixture('channels-comments');
  raw.feeds.push({ i: 99, objectNonce: '9000000000000000001', createTime: 1794800000, commentCount: 0, desc: {} },
    { i: 100, objectNonce: '9000000000000000002', createTime: 1780000000, commentCount: 0, desc: {} });
  const r = await run('Channels', 'comments', raw);
  assert.deepEqual(scanned(r, '9000000000000000001'), { workNativeId: '9000000000000000001', complete: true, threadsPartial: false });
  assert.equal(scanned(r, '9000000000000000002'), undefined);
});

// —— G-B6a / G-B6b B站翻页 ——
const reply = (rpid, root, oid, bvid, ctime) => ({ rpid, oid, root, parent: root, ctime, mid: 1, member: { mid: '1', uname: 'a' }, content: { message: 'x' }, bvid, title: 't' });
function fakeBili({ fulllist, threadPages = () => ({ replies: [], count: 0 }) }) {
  const calls = [];
  const get = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith('/up/fulllist')) return { code: 0, data: fulllist(Number(u.searchParams.get('pn'))) };
    if (u.pathname.endsWith('/reply/reply')) { const { replies, count } = threadPages(u.searchParams.get('root'), Number(u.searchParams.get('pn'))); return { code: 0, data: { page: { count }, root: null, replies } }; }
    if (u.pathname.endsWith('/web-interface/view')) return { code: 0, data: { bvid: u.searchParams.get('bvid'), aid: 1, title: 't', pubdate: 1795000000 } };
    throw new Error(url);
  };
  return { get, calls };
}
const o = { ...bili.LIMITS, gapMs: 0, now: NOW, since: null };
const recent = Math.floor(NOW / 1000) - 3600;

test('G-B6a B站：up/fulllist 缺 page.total 时，第 1 页满 20 条不能判到底', async () => {
  const page = (pn) => (pn === 1 ? Array.from({ length: 20 }, (_, i) => reply(1000 + i, 0, 7, 'BV1', recent)) : pn === 2 ? [reply(2000, 0, 7, 'BV1', recent)] : []);
  const { get } = fakeBili({ fulllist: (pn) => ({ page: { num: pn, size: 20 }, list: page(pn) }) });
  const raw = await bili.rawComments(get, o);
  assert.equal(raw.fulllist.length, 2);
  assert.equal(raw.reachedEnd, true);
});

test('G-B6b B站：单楼 reply/reply 翻满 10 页仍满 20 条且没到 page.count，这个作品不算拿全', async () => {
  const fulllist = (pn) => ({ page: { num: pn, size: 20, total: 2 }, list: pn === 1 ? [reply(1, 0, 7, 'BV1', recent), reply(2, 0, 8, 'BV2', recent)] : [] });
  const threadPages = (root, pn) => (root === '1' ? { count: 500, replies: Array.from({ length: 20 }, (_, i) => reply(10000 + pn * 100 + i, 1, 7, 'BV1', recent)) } : { count: 0, replies: [] });
  const { get } = fakeBili({ fulllist, threadPages });
  const raw = await bili.rawComments(get, o);
  const r = bili.parse('comments', { kind: 'comments', uidSeen: 'u', me: { mid: 'u' }, ...raw }, { accountUid: 'u', fetchedAt: new Date(NOW).toISOString() });
  assert.deepEqual(scanned(r, 'BV1'), { workNativeId: 'BV1', complete: false, threadsPartial: true });
  assert.deepEqual(scanned(r, 'BV2'), { workNativeId: 'BV2', complete: true, threadsPartial: false });
});
