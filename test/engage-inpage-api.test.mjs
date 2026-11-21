// S9 页面内接口：找页面服务（假 window）、抖音 / 视频号接口读评论（假接口，parse 不变）、接口回复评论的护栏（假接口）、能力位开关。
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { locateService, callInPage, SERVICES } from '../src/ops/engage/inpage-api.mjs';
import * as dy from '../src/ops/engage/adapters/douyin.mjs';
import * as ch from '../src/ops/engage/adapters/channels.mjs';
import { douyinApi, channelsApi, sendAndReadBack, runApiReply } from '../src/ops/engage/writers/api-reply.mjs';
import { collect } from '../src/ops/engage/adapters/index.mjs';

const T = Date.UTC(2026, 10, 21, 2, 0) / 1000;
const ME = '106707338905';
const noSleep = async () => {};

// —— 假接口 ——
// 抖音：评论按楼放；cursor 是下标。publish 往楼里加一条我的回复（可配：返回码、加几条、不加）
function fakeDouyin({ roots, replies, pageSize = 2, publish = 'ok' }) {
  const calls = [];
  const call = async (method, args) => {
    calls.push([method, args]);
    if (method === 'awemeV1CommentListSelect') {
      const all = roots, from = args.cursor;
      return { ok: true, data: { status_code: 0, comments: all.slice(from, from + pageSize), cursor: from + pageSize, has_more: from + pageSize < all.length ? 1 : 0 } };
    }
    if (method === 'awemeV1CommentListReply') {
      const all = replies[args.comment_id] ?? [], from = args.cursor;
      return { ok: true, data: { status_code: 0, comments: all.slice(from, from + pageSize), cursor: from + pageSize, has_more: from + pageSize < all.length ? 1 : 0 } };
    }
    if (method === 'awemeV1CommentMultiPublish') {
      const root = roots.find((r) => r.cid === args.reply_to_comment_ids) ?? roots.find((r) => (replies[r.cid] ?? []).some((c) => c.cid === args.reply_to_comment_ids));
      const mk = (cid) => dyC(cid, { uid: ME, text: args.text, reply_id: root.cid, reply_to_reply_id: root.cid === args.reply_to_comment_ids ? '0' : args.reply_to_comment_ids });
      if (publish === 'throw') return { ok: false, error: '请求网络失败' };
      if (publish === 'weird') { (replies[root.cid] ??= []).push(mk('new1')); root.reply_comment_total++; return { ok: true, data: { status_code: 0, comments: [{ code: 3 }] } }; }
      if (publish === 'silent') return { ok: true, data: { status_code: 0, comments: [{ code: 0, comment: { cid: 'new1' } }] } };
      if (publish === 'double') { for (const id of ['new1', 'new2']) { (replies[root.cid] ??= []).push(mk(id)); root.reply_comment_total++; } return { ok: true, data: { status_code: 0, comments: [{ code: 0, comment: { cid: 'new1' } }] } }; }
      (replies[root.cid] ??= []).push(mk('new1')); root.reply_comment_total++;
      return { ok: true, data: { status_code: 0, comments: [{ code: 0, comment: { cid: publish === 'otherid' ? 'zzz' : 'new1' } }] } };
    }
    return { ok: false, error: `没有 ${method}` };
  };
  return { call, calls };
}
function dyC(cid, o = {}) {
  return { cid, text: o.text ?? `评论${cid}`, aweme_id: 'w1', create_time: T - 60, digg_count: 0, user: { uid: o.uid ?? `u-${cid}`, nickname: o.nick ?? `昵称${cid}` },
    reply_id: o.reply_id ?? '0', reply_to_reply_id: o.reply_to_reply_id ?? '0', reply_comment_total: o.total ?? 0, ...(o.reply_to_userid ? { reply_to_userid: o.reply_to_userid, reply_to_username: o.reply_to_username } : {}) };
}
function dyWorld() {
  const roots = [dyC('r1', { total: 3 }), dyC('r2'), dyC('r3', { total: 1 })];
  const replies = {
    r1: [dyC('a', { reply_id: 'r1' }), dyC('b', { reply_id: 'r1', reply_to_reply_id: 'a', reply_to_userid: 'u-a', reply_to_username: '昵称a' }), dyC('c', { reply_id: 'r1' })],
    r3: [dyC('d', { reply_id: 'r3' })],
  };
  return { roots, replies };
}

describe('找页面服务', () => {
  afterEach(() => { delete globalThis.window; delete globalThis.document; });
  const chunk = (mods) => ({ push([, , run]) { const req = (id) => mods[id].exports; req.m = Object.fromEntries(Object.entries(mods).map(([k, v]) => [k, v.src])); run(req); } });

  test('抖音：Garfish 子应用 global 上按源码找模块，导出里找带方法的对象', async () => {
    const svc = { awemeV1CommentListSelect: async (a) => ({ status_code: 0, echo: a }), awemeV1CommentListReply() {}, awemeV1CommentMultiPublish() {} };
    globalThis.window = { Garfish: { activeApps: { 0: { global: { webpackChunkcreator_interactive: chunk({
      1: { src: 'function(){ other }', exports: {} },
      2: { src: 'function(){ awemeV1CommentListSelect:e=>1, awemeV1CommentMultiPublish:e=>2 }', exports: { i: svc } },
    }) } } } } };
    assert.equal(locateService({ platform: 'Douyin', ...SERVICES.Douyin }), true);
    assert.equal(window.__engSvc.Douyin, svc);
    assert.deepEqual(await callInPage({ platform: 'Douyin', method: 'awemeV1CommentListSelect', args: { cursor: 0 } }), { ok: true, data: { status_code: 0, echo: { cursor: 0 } } });
    window.__engSvc.Douyin.awemeV1CommentListReply = async () => { throw new Error('url doesn\'t match'); };
    assert.deepEqual(await callInPage({ platform: 'Douyin', method: 'awemeV1CommentListReply', args: {} }), { ok: false, error: 'url doesn\'t match' });
  });

  test('视频号：wujie iframe 里找；没有服务就返回 false', () => {
    const svc = { getCommentList() {}, createComment() {} };
    const frame = { contentWindow: { __WUJIE: {}, webpackChunkinteraction: chunk({ 9: { src: 'class{async getCommentList(e){} async createComment(e){}}', exports: { lt: svc, x: 1 } } }) } };
    globalThis.window = {};
    globalThis.document = { querySelectorAll: () => [frame] };
    assert.equal(locateService({ platform: 'Channels', ...SERVICES.Channels }), true);
    assert.equal(window.__engSvc.Channels, svc);
    globalThis.window = {};
    globalThis.document = { querySelectorAll: () => [{ contentWindow: {} }] };
    assert.equal(locateService({ platform: 'Channels', ...SERVICES.Channels }), false);
  });
});

describe('抖音：接口读评论', () => {
  const o = { ...dy.LIMITS, now: T * 1000 };
  const parse = (works) => dy.parseComments({ kind: 'comments', via: 'api', itemListCodes: [0], windowStartMs: o.now - 30 * 86400_000,
    items: [{ item_id_plain: 'w1', title: '作品一', create_time: T - 3600, comment_count: 7 }], works }, { accountUid: ME, fetchedAt: new Date(o.now).toISOString() });

  test('一楼翻页、楼中楼翻页；参数同页面自己的请求；parse 出来的树和 DOM 路径一样', async () => {
    const f = fakeDouyin(dyWorld());
    const works = await dy.worksViaApi(f.call, [{ item_id_plain: 'w1' }], o);
    assert.deepEqual(f.calls[0], ['awemeV1CommentListSelect', { aweme_id: 'w1', cursor: 0, count: 10, comment_select_options: 0, sort_options: 0, channel_id: 618 }]);
    assert.deepEqual(f.calls.find(([m]) => m === 'awemeV1CommentListReply')[1], { comment_id: 'r1', cursor: 0, count: 10, channel_id: 618 });
    assert.equal(works[0].select.length, 2);
    assert.equal(works[0].expandLeft, 0);
    const out = parse(works);
    const byId = Object.fromEntries(out.comments.map((c) => [c.nativeId, c]));
    assert.deepEqual(Object.keys(byId).sort(), ['a', 'b', 'c', 'd', 'r1', 'r2', 'r3']);
    assert.deepEqual([byId.b.rootNativeId, byId.b.parentNativeId, byId.b.replyTo.nickname], ['r1', 'a', '昵称a']);
    assert.deepEqual(out.scannedWorks, [{ workNativeId: 'w1', complete: true, threadsPartial: false }]);
  });

  test('楼中楼预算用完、接口出错：标拿不全，不报成功', async () => {
    // 预算 1 次：r1 第 1 页读了，r1 第 2 页、r3 没读
    const works = await dy.worksViaApi(fakeDouyin(dyWorld()).call, [{ item_id_plain: 'w1' }], { ...o, maxExpand: 1 });
    assert.equal(works[0].expandLeft, 2);
    assert.equal(parse(works).scannedWorks[0].threadsPartial, true);
    const bad = async (m) => (m === 'awemeV1CommentListSelect' ? { ok: false, error: '请求网络失败' } : { ok: true, data: {} });
    const w2 = await dy.worksViaApi(bad, [{ item_id_plain: 'w1' }], o);
    assert.equal(w2[0].selectErrors.length, 1);
    assert.deepEqual(parse(w2).scannedWorks[0], { workNativeId: 'w1', complete: false, threadsPartial: true });
    // 「url doesn't match」：status_code=0 但没有 comments，按出错算
    const w3 = await dy.worksViaApi(async () => ({ ok: true, data: { status_code: 0, status_msg: "url doesn't match" } }), [{ item_id_plain: 'w1' }], o);
    assert.equal(w3[0].selectErrors[0].comments, 'missing');
  });

  test('一楼翻到上限还有下一页：不算拿全', async () => {
    const works = await dy.worksViaApi(fakeDouyin(dyWorld()).call, [{ item_id_plain: 'w1' }], { ...o, maxSelectPages: 1 });
    assert.equal(parse(works).scannedWorks[0].complete, false);
  });
});

describe('视频号：接口读评论', () => {
  const o = { ...ch.LIMITS, now: T * 1000 };
  const cc = (id, x = {}) => ({ commentId: id, commentNickname: x.nick ?? `昵称${id}`, commentContent: x.text ?? `评论${id}`, commentCreatetime: T - 60, commentLikeCount: 0,
    replyCommentId: x.reply ?? undefined, downContinueFlag: x.more ?? 0, lastBuff: x.lb ?? '', levelTwoComment: x.l2 ?? [], likeFlag: 0, username: `u${id}` });
  function fakeChannels() {
    const calls = [];
    const call = async (method, args) => {
      calls.push([method, args]);
      if (args.rootCommentId === 'r1') return { ok: true, data: { errCode: 0, data: { comment: [cc('y', { reply: 'x' })], lastBuff: 'r1-2', downContinueFlag: 0 } } };
      if (args.lastBuff === '') return { ok: true, data: { errCode: 0, data: { comment: [cc('r1', { l2: [cc('x')], more: 1, lb: 'r1-1' })], lastBuff: 'p2', downContinueFlag: 1 } } };
      if (args.lastBuff === 'p2') return { ok: true, data: { errCode: 0, data: { comment: [cc('r2')], lastBuff: 'p3', downContinueFlag: 0 } } };
      return { ok: true, data: { errCode: 1 } };
    };
    return { call, calls };
  }
  const feeds = [{ objectId: 'obj1', objectNonce: 'n1', createTime: T - 3600, commentCount: 4, desc: { description: '作品', shortTitle: [] } }];

  test('一楼翻页 + 楼中楼续页（rootCommentId + 一楼的 lastBuff），parse 出两层', async () => {
    const f = fakeChannels();
    const works = await ch.worksViaApi(f.call, feeds, o);
    assert.deepEqual(f.calls.map(([, a]) => a), [ch.listArgs('obj1', ''), ch.listArgs('obj1', 'p2'), ch.listArgs('obj1', 'r1-1', 'r1')]);
    const out = ch.parseComments({ kind: 'comments', windowStartSec: T - 30 * 86400, feeds, emptyState: false, works, me: { nickname: '昵称r2' } }, { accountUid: 'sph', fetchedAt: new Date(o.now).toISOString() });
    const byId = Object.fromEntries(out.comments.map((c) => [c.nativeId, c]));
    assert.deepEqual(Object.keys(byId).sort(), ['r1', 'r2', 'x', 'y']);
    assert.deepEqual([byId.y.rootNativeId, byId.y.parentNativeId], ['r1', 'x']);
    assert.equal(byId.r2.author.isMe, true);
    assert.deepEqual(out.scannedWorks, [{ workNativeId: 'n1', complete: true, threadsPartial: false }]);
  });

  test('楼中楼预算用完、一楼接口出错：标拿不全', async () => {
    const works = await ch.worksViaApi(fakeChannels().call, feeds, { ...o, maxExpand: 0 });
    assert.equal(works[0].expandLeft, 1);
    const w2 = await ch.worksViaApi(async () => ({ ok: true, data: { errCode: 300330 } }), feeds, o);
    assert.equal(w2[0].opened, false);
  });
});

describe('抖音：接口回复评论', () => {
  const params = (commentId, rootId) => ({ op: 'reply', text: '谢谢支持', target: { commentId, rootId, workId: 'w1' } });
  const ctx = (f, p) => ({ call: f.call, params: p, me: { uid: ME } });
  const publishes = (f) => f.calls.filter(([m]) => m === 'awemeV1CommentMultiPublish');

  test('回一楼、回楼中楼：发一次，回读到恰好 1 条且 id 对上才算回读到', async () => {
    for (const [cid, root] of [['r1', 'r1'], ['b', 'r1']]) {
      const f = fakeDouyin(dyWorld());
      const pre = await douyinApi.precheck(ctx(f, params(cid, root)));
      assert.ok(pre.state, JSON.stringify(pre));
      const { readBack } = await sendAndReadBack(douyinApi, ctx(f, params(cid, root)), pre.state, { sleep: noSleep, readbackMs: 0 });
      assert.deepEqual(readBack, { found: true, count: 1, nativeId: 'new1' });
      assert.deepEqual(publishes(f).map(([, a]) => a), [{ aweme_id: 'w1', text: '谢谢支持', reply_to_comment_ids: cid, channel_id: 618 }]);
      assert.equal(f.calls.at(-1)[0], 'awemeV1CommentListReply');
    }
  });

  test('发前重读拦下：已回过、评论已删、楼没读全、楼找不到；都没调发送', async () => {
    const w = dyWorld();
    w.replies.r1.push(dyC('mine', { uid: ME, reply_id: 'r1', reply_to_reply_id: 'a' }));
    w.roots[0].reply_comment_total = 4;
    let f = fakeDouyin(w);
    assert.equal((await douyinApi.precheck(ctx(f, params('a', 'r1')))).blocked, 'already-replied');
    assert.ok((await douyinApi.precheck(ctx(f, params('b', 'r1')))).state, '回的是 a，不算回过 b');
    assert.equal((await douyinApi.precheck(ctx(f, params('gone', 'r1')))).blocked, 'comment-gone');
    assert.equal((await douyinApi.precheck(ctx(f, params('zz', 'zz')))).blocked, 'comment-gone');
    const w2 = dyWorld(); w2.roots[0].reply_comment_total = 9;
    assert.equal((await douyinApi.precheck(ctx(fakeDouyin(w2), params('a', 'r1')))).blocked, 'thread-incomplete');
    assert.equal(publishes(f).length, 0);
  });

  test('返回码不认识、调用出错、回读 2 条、id 对不上、没回读到：都不算回读到，也不当发送失败', async () => {
    for (const [mode, count] of [['weird', 1], ['throw', 0], ['double', 2], ['otherid', 1], ['silent', 0]]) {
      const f = fakeDouyin({ ...dyWorld(), publish: mode });
      const pre = await douyinApi.precheck(ctx(f, params('r1', 'r1')));
      const { readBack } = await sendAndReadBack(douyinApi, ctx(f, params('r1', 'r1')), pre.state, { sleep: noSleep, readbackMs: 0 });
      assert.equal(readBack.found, false, mode);
      assert.equal(readBack.count, count, mode);
      assert.equal(publishes(f).length, 1, `${mode}：发送只调一次`);
    }
  });
});

describe('视频号：接口回复评论', () => {
  const cc = (id, x = {}) => ({ commentId: id, commentNickname: x.nick ?? `昵称${id}`, commentContent: x.text ?? `评论${id}`, replyCommentId: x.reply ?? '', downContinueFlag: 0, lastBuff: '', levelTwoComment: x.l2 ?? [] });
  function world({ publish = 'ok' } = {}) {
    const l2 = [cc('x', { reply: '' }), cc('mine', { nick: '我', reply: 'x', text: '旧回复' })];
    const calls = [];
    const call = async (method, args) => {
      calls.push([method, args]);
      if (method === 'getCommentList') return { ok: true, data: { errCode: 0, data: { comment: [cc('r1', { l2: [...l2] })], lastBuff: '', downContinueFlag: 0 } } };
      if (method === 'createComment') {
        if (publish === 'phone') return { ok: true, data: { errCode: 0, data: { baseResp: { errcode: -4300 } } } };
        l2.push(cc('new1', { nick: '我', reply: args.replyCommentId, text: args.content }));
        return { ok: true, data: { errCode: 0, data: { comment: { commentId: 'new1' } } } };
      }
      return { ok: false, error: 'x' };
    };
    const page = { evaluate: async () => [{ objectId: 'obj1', objectNonce: 'n1' }] };
    return { call, calls, page };
  }
  const p = (commentId) => ({ op: 'reply', text: '收到', target: { commentId, rootId: 'r1', workId: 'n1' } });
  const ctx = (w, prm) => ({ call: w.call, page: w.page, params: prm, me: { nickname: '我' }, uuid: () => 'uuid-1' });

  test('回楼中楼：入参同页面自己的 createComment，回读到恰好 1 条', async () => {
    const w = world();
    const pre = await channelsApi.precheck(ctx(w, p('r1')));
    assert.ok(pre.state);
    const { readBack } = await sendAndReadBack(channelsApi, ctx(w, p('r1')), pre.state, { sleep: noSleep, readbackMs: 0 });
    assert.deepEqual(readBack, { found: true, count: 1, nativeId: 'new1' });
    const sent = w.calls.filter(([m]) => m === 'createComment');
    assert.equal(sent.length, 1);
    assert.deepEqual({ ...sent[0][1], comment: sent[0][1].comment.commentId }, { replyCommentId: 'r1', content: '收到', clientId: 'uuid-1', rootCommentId: 'r1', comment: 'r1', exportId: 'obj1' });
  });

  test('已回过、要验证手机（-4300）', async () => {
    assert.equal((await channelsApi.precheck(ctx(world(), p('x')))).blocked, 'already-replied');
    const w = world({ publish: 'phone' });
    const pre = await channelsApi.precheck(ctx(w, p('r1')));
    const { readBack } = await sendAndReadBack(channelsApi, ctx(w, p('r1')), pre.state, { sleep: noSleep, readbackMs: 0 });
    assert.equal(readBack.found, false);
    assert.match(readBack.detail, /-4300/);
  });
});

describe('runApiReply 和开关', () => {
  function fakeTask({ uid = ME } = {}) {
    const page = { cdp: async () => ({}), goto: async () => {}, url: async () => 'https://creator.douyin.com/x', evaluate: async () => true };
    return { task: { pages: async () => [page] }, plat: (api) => ({ api, hook: true, url: () => 'https://creator.douyin.com/x', login: async () => ({ uid }) }) };
  }

  test('页面服务找不到：cannot-send，没尝试发送；账号不符：uid-mismatch', async () => {
    const { task, plat } = fakeTask();
    const r = await runApiReply(task, { op: 'reply', uid: ME, text: '谢谢', target: {} }, plat(douyinApi), { serviceCaller: async () => null });
    assert.deepEqual([r.blocked, r.sendAttempted], ['cannot-send', false]);
    const other = fakeTask({ uid: 'other' });
    const r2 = await runApiReply(other.task, { op: 'reply', uid: ME, text: '谢谢', target: {} }, other.plat(douyinApi), { serviceCaller: async () => null });
    assert.equal(r2.blocked, 'uid-mismatch');
  });

  test('整条走通：sendAttempted、回读结果原样交给框架', async () => {
    const { task, plat } = fakeTask();
    const f = fakeDouyin(dyWorld());
    const r = await runApiReply(task, { op: 'reply', uid: ME, text: '谢谢支持', target: { commentId: 'r1', rootId: 'r1', workId: 'w1' }, timeouts: { readbackMs: 0, settleMs: 0 } },
      plat(douyinApi), { serviceCaller: async () => f.call, sleep: noSleep });
    assert.deepEqual([r.sendAttempted, r.readBack.found, r.via, 'sendError' in r], [true, true, 'api', false]);
  });

  test('collect：readViaApi 打开时传 readVia=api，默认 dom', async () => {
    const seen = [];
    const runner = async ({ params }) => { seen.push(params.readVia); return { ok: false, reason: 'busy' }; };
    const acc = (caps) => ({ platformCode: 'Douyin', uid: ME, spaceName: 'kinso/Douyin/x', capabilities: caps });
    await collect({ account: acc({}), kind: 'comments', runner });
    await collect({ account: acc({ readViaApi: true }), kind: 'comments', runner });
    assert.deepEqual(seen, ['dom', 'api']);
  });
});
