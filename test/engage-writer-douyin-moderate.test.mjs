// 抖音处置写入脚本（writers/douyin-moderate.mjs）：假评论服务、假网页版函数，不起 runner、不碰任何页面。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deleteComment, block, locateWebFns, WEB_FNS } from '../src/ops/engage/writers/douyin-moderate.mjs';
import { setCapability } from '../src/ops/accounts.mjs';
import { ingestSnapshot } from '../src/ops/engage/store.mjs';
import { engageWrite } from '../src/ops/engage/write.mjs';
import { writerModuleUrl } from '../src/ops/engage/writers/index.mjs';
import { freshDb, tmpDbFile, douyin, comment, commentsSnap, conv, dmsSnap, T0, MIN } from './helpers/engage-fixtures.mjs';

const ME = '106707338905';
const AWEME = '7000000000000000001';
const user = (uid) => ({ uid, sec_uid: `SEC-${uid}`, nickname: `n${uid}` });

/** 假评论服务：一楼 roots、楼中楼 replies[rootCid]。del：调 multi_delete 时怎么回、删不删。 */
function fakeComments({ roots, replies = {}, del = { status_code: 0, remove: true }, hasDelete = true } = {}) {
  const st = { roots: roots.map((r) => ({ ...r })), replies: Object.fromEntries(Object.entries(replies).map(([k, v]) => [k, v.map((x) => ({ ...x }))])) };
  const calls = [];
  const call = async (method, args) => {
    calls.push({ method, args });
    if (method === 'awemeV1CommentListSelect') return { ok: true, data: { status_code: 0, comments: st.roots.filter((r) => r.aweme_id === args.aweme_id), has_more: 0, cursor: 0 } };
    if (method === 'awemeV1CommentListReply') return { ok: true, data: { status_code: 0, comments: st.replies[args.comment_id] ?? [], has_more: 0, cursor: 0 } };
    if (method === 'awemeV1CommentMultiDelete') {
      if (del.throws) return { ok: false, error: del.throws };
      if (del.remove) {
        st.roots = st.roots.filter((r) => r.cid !== args.cids);
        for (const k of Object.keys(st.replies)) {
          const before = st.replies[k].length;
          st.replies[k] = st.replies[k].filter((x) => x.cid !== args.cids);
          const root = st.roots.find((r) => r.cid === k);
          if (root && before !== st.replies[k].length) root.reply_comment_total = st.replies[k].length;
        }
      }
      return { ok: true, data: { status_code: del.status_code, delete_result: [{ cid: args.cids, result: del.status_code === 0 }] } };
    }
    return { ok: false, error: `没有 ${method}` };
  };
  return { st, calls, call, hasMethod: async (n) => n !== 'awemeV1CommentMultiDelete' || hasDelete };
}

const root = (cid, uid, total = 0) => ({ cid, aweme_id: AWEME, user: user(uid), text: 'x', reply_id: '0', reply_comment_total: total });
const sub = (cid, rootCid, uid) => ({ cid, aweme_id: AWEME, user: user(uid), text: 'y', reply_id: rootCid, reply_to_reply_id: '0' });

function apiOf(fc, { who = { uid: ME }, web = null, conversation = null } = {}) {
  return { sleep: async () => {}, whoAmI: async () => who, call: fc.call, hasMethod: fc.hasMethod, conversation: async () => conversation, web: async () => web };
}

const delParams = (o = {}) => ({ op: 'delete', uid: ME, selfUids: [ME], target: { commentId: '201', workId: AWEME, parentId: '101', rootId: '101', authorUid: '900', ...o } });
const deletes = (fc) => fc.calls.filter((c) => c.method === 'awemeV1CommentMultiDelete');

describe('抖音删评论', () => {
  test('楼中楼：楼读全、调一次 multi_delete（need_block=false）、回读楼里没有了 → found', async () => {
    const fc = fakeComments({ roots: [root('101', '800', 2)], replies: { 101: [sub('201', '101', '900'), sub('202', '101', '901')] } });
    const r = await deleteComment(apiOf(fc), delParams());
    assert.equal(r.sendAttempted, true);
    assert.equal(r.sendError, undefined);
    assert.deepEqual(r.readBack.found, true);
    assert.equal(r.readBack.nativeId, '201');
    assert.deepEqual(deletes(fc).map((c) => c.args), [{ cids: '201', need_block: false }]);
  });

  test('一楼、下面没有回复：删掉后一楼列表翻到底没有它 → found', async () => {
    const fc = fakeComments({ roots: [root('101', '800', 0), root('102', '801', 0)] });
    const r = await deleteComment(apiOf(fc), delParams({ commentId: '101', rootId: '101', parentId: null }));
    assert.equal(r.readBack.found, true);
    assert.equal(deletes(fc).length, 1);
  });

  test('一楼下面有回复 → deletes-thread（rejected），不调接口', async () => {
    const fc = fakeComments({ roots: [root('101', '800', 1)], replies: { 101: [sub('201', '101', '900')] } });
    const r = await deleteComment(apiOf(fc), delParams({ commentId: '101', rootId: '101', parentId: null }));
    assert.deepEqual([r.blocked, r.rejected, r.sendAttempted], ['deletes-thread', true, false]);
    assert.equal(deletes(fc).length, 0);
  });

  test('评审修复：一楼 total=0 但楼中楼接口有回复 → deletes-thread；total 是负数 → thread-incomplete；都不调接口', async () => {
    const fc = fakeComments({ roots: [root('101', '800', 0)], replies: { 101: [sub('201', '101', '900')] } });
    const r = await deleteComment(apiOf(fc), delParams({ commentId: '101', rootId: '101', parentId: null }));
    assert.deepEqual([r.blocked, r.rejected], ['deletes-thread', true]);
    const neg = fakeComments({ roots: [root('101', '800', -1)] });
    assert.equal((await deleteComment(apiOf(neg), delParams({ commentId: '101', rootId: '101', parentId: null }))).blocked, 'thread-incomplete');
    assert.equal(deletes(fc).length + deletes(neg).length, 0);
  });

  test('评审修复：楼中楼的 reply_id 不是这栋楼、aweme_id 缺失 → target-not-found，不调接口', async () => {
    const wrong = fakeComments({ roots: [root('101', '800', 1)], replies: { 101: [sub('201', '999', '900')] } });
    assert.equal((await deleteComment(apiOf(wrong), delParams())).blocked, 'target-not-found');
    const noAweme = fakeComments({ roots: [root('101', '800', 1)], replies: { 101: [{ ...sub('201', '101', '900'), aweme_id: undefined }] } });
    assert.equal((await deleteComment(apiOf(noAweme), delParams())).blocked, 'target-not-found');
    assert.equal(deletes(wrong).length + deletes(noAweme).length, 0);
  });

  test('评审第 2 轮：楼中楼目标所在楼 total 是负数 → thread-incomplete；一楼 total=0 但楼中楼第一页空且 has_more=1 → thread-incomplete；不调接口', async () => {
    const neg = fakeComments({ roots: [root('101', '800', -1)], replies: { 101: [sub('201', '101', '900')] } });
    assert.equal((await deleteComment(apiOf(neg), delParams())).blocked, 'thread-incomplete');
    const more = fakeComments({ roots: [root('101', '800', 0)] });
    const call = more.call;
    const api = apiOf(more);
    api.call = async (m, a) => (m === 'awemeV1CommentListReply' ? { ok: true, data: { status_code: 0, comments: [], has_more: 1, cursor: 10 } } : call(m, a));
    assert.equal((await deleteComment(api, delParams({ commentId: '101', rootId: '101', parentId: null }))).blocked, 'thread-incomplete');
    assert.equal(deletes(neg).length + deletes(more).length, 0);
  });

  test('评审第 2 轮：multi_delete 返回 status_code=0 但 delete_result 没有这条 / result 不明确 → 回读看到不在也不算 found', async () => {
    for (const delete_result of [[], [{ cid: '201', result: '0' }], [{ cid: '999', result: true }]]) {
      const fc = fakeComments({ roots: [root('101', '800', 1)], replies: { 101: [sub('201', '101', '900')] } });
      const call = fc.call;
      const api = apiOf(fc);
      api.call = async (m, a) => { const r = await call(m, a); return m === 'awemeV1CommentMultiDelete' ? { ok: true, data: { status_code: 0, delete_result } } : r; };
      const r = await deleteComment(api, delParams());
      assert.deepEqual([r.sendAttempted, r.readBack.found], [true, false], JSON.stringify(delete_result));
      assert.match(r.readBack.detail, /没有明确说/);
      assert.equal(deletes(fc).length, 1);
    }
  });

  test('已不在：楼读全了没有这条 → already-gone，不调接口；整栋楼都不在了也是 already-gone', async () => {
    const fc = fakeComments({ roots: [root('101', '800', 1)], replies: { 101: [sub('202', '101', '901')] } });
    assert.equal((await deleteComment(apiOf(fc), delParams())).blocked, 'already-gone');
    const fc2 = fakeComments({ roots: [] });
    assert.equal((await deleteComment(apiOf(fc2), delParams())).blocked, 'already-gone');
    assert.equal(deletes(fc).length + deletes(fc2).length, 0);
  });

  test('作者是我自己（登录 uid 或登记的别的本平台账号）→ self-target，不调接口', async () => {
    for (const uid of [ME, '555']) {
      const fc = fakeComments({ roots: [root('101', '800', 1)], replies: { 101: [sub('201', '101', uid)] } });
      const r = await deleteComment(apiOf(fc), { ...delParams(), selfUids: [ME, '555'] });
      assert.equal(r.blocked, 'self-target', uid);
      assert.equal(deletes(fc).length, 0);
    }
  });

  test('楼没读全（总数比读到的多）→ thread-incomplete，不调接口', async () => {
    const fc = fakeComments({ roots: [root('101', '800', 5)], replies: { 101: [sub('201', '101', '900')] } });
    const r = await deleteComment(apiOf(fc), delParams());
    assert.equal(r.blocked, 'thread-incomplete');
    assert.equal(deletes(fc).length, 0);
  });

  test('回读时还在（接口说成功、平台没删）→ found=false，只调过一次', async () => {
    const fc = fakeComments({ roots: [root('101', '800', 1)], replies: { 101: [sub('201', '101', '900')] }, del: { status_code: 0, remove: false } });
    const r = await deleteComment(apiOf(fc), delParams());
    assert.deepEqual([r.sendAttempted, r.readBack.found], [true, false]);
    assert.match(r.readBack.detail, /还在/);
    assert.equal(deletes(fc).length, 1);
  });

  test('接口报错 → sendError，回读不认 found；页面服务抛错也只调一次、sendAttempted=true', async () => {
    const fc = fakeComments({ roots: [root('101', '800', 1)], replies: { 101: [sub('201', '101', '900')] }, del: { status_code: 2053, remove: false } });
    const r = await deleteComment(apiOf(fc), delParams());
    assert.match(r.sendError, /status_code=2053/);
    assert.equal(r.readBack.found, false);
    const fc2 = fakeComments({ roots: [root('101', '800', 1)], replies: { 101: [sub('201', '101', '900')] }, del: { throws: '网络断了' } });
    const r2 = await deleteComment(apiOf(fc2), delParams());
    assert.deepEqual([r2.sendAttempted, r2.readBack.found], [true, false]);
    assert.match(r2.readBack.detail, /网络断了/);
    assert.equal(deletes(fc2).length, 1);
  });

  test('删评论：multi_delete 抛出空消息错误（new Error(\'\')、throw \'\'、{ message: \'\' }）或返回 { ok: false, error: \'\' }、回读已不在 → found=false，只调一次', async () => {
    const cases = [
      ...[['new Error(\'\')', () => new Error('')], ["throw ''", () => ''], ["{ message: '' }", () => ({ message: '' })]].map(([name, err]) => [name, async () => { throw err(); }]),
      ["{ ok: false, error: '' }", async () => ({ ok: false, error: '' })],
    ];
    for (const [name, onDelete] of cases) {
      const fc = fakeComments({ roots: [root('101', '800', 1)], replies: { 101: [sub('201', '101', '900')] } });
      const api = apiOf(fc);
      const call = fc.call;
      api.call = async (m, a) => {
        if (m !== 'awemeV1CommentMultiDelete') return call(m, a);
        await call(m, a);   // 记一次调用，并把这条真的删掉：回读会看到不在
        return onDelete();
      };
      const r = await deleteComment(api, delParams());
      assert.deepEqual([r.sendAttempted, r.readBack.found], [true, false], name);
      assert.match(r.readBack.detail, /multi_delete 出错：未知错误/, name);
      assert.equal(deletes(fc).length, 1, name);
    }
  });

  test('回读出错（读接口坏了）→ found=false，不重调删除', async () => {
    const fc = fakeComments({ roots: [root('101', '800', 1)], replies: { 101: [sub('201', '101', '900')] } });
    let n = 0;
    const api = apiOf(fc);
    const call = api.call;
    api.call = async (m, a) => { if (m === 'awemeV1CommentListSelect' && ++n > 1) return { ok: false, error: '读挂了' }; return call(m, a); };
    const r = await deleteComment(api, delParams());
    assert.deepEqual([r.sendAttempted, r.readBack.found], [true, false]);
    assert.equal(deletes(fc).length, 1);
  });

  test('页面服务里没有 multi_delete → cannot-send；账号不对 → 原样返回 whoAmI 的结果', async () => {
    const fc = fakeComments({ roots: [root('101', '800', 1)], replies: { 101: [sub('201', '101', '900')] }, hasDelete: false });
    assert.equal((await deleteComment(apiOf(fc), delParams())).blocked, 'cannot-send');
    const lost = { done: { uidSeen: null, loginLost: true, evidence: 'x', sendAttempted: false } };
    assert.deepEqual(await deleteComment(apiOf(fc, { who: lost }), delParams()), lost.done);
    assert.equal(deletes(fc).length, 0);
  });
});

// 网页版函数返回的字段写法（2026-11-22 只读核对，见 douyin-moderate.mjs 文件头）：
//   real：self、other 转过驼峰（statusCode、user.isBlock），block 是接口原样（status_code、block_status）。
//   snake / camel：三个都是下划线 / 都是驼峰（找到的函数换成不转换的那个，或页面改版）。
const camel = (o) => (Array.isArray(o) || o === null || typeof o !== 'object' ? o
  : Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), camel(v)])));
const STYLES = { real: { self: camel, other: camel, block: (o) => o }, snake: { self: (o) => o, other: (o) => o, block: (o) => o }, camel: { self: camel, other: camel, block: camel } };

/** 假网页版：blocked 集合；block 调用记下来。接口按下划线写，style 决定交出去的写法。 */
function fakeWeb({ selfUid = ME, blocked = [], blockResp = { status_code: 0, block_status: 1 }, apply = true, users = {}, style = 'real' } = {}) {
  const set = new Set(blocked);
  const calls = [];
  const as = STYLES[style];
  return {
    calls,
    self: async () => as.self({ status_code: 0, status_msg: null, log_pb: {}, user: { uid: selfUid, sec_uid: `SEC-${selfUid}` } }),
    other: async (sec) => { const uid = users[sec] ?? sec.replace(/^SEC-/, ''); return as.other({ status_code: 0, status_msg: null, log_pb: {}, user: { uid, sec_uid: sec, is_block: set.has(uid), is_blocked: false } }); },
    block: async (uid, sec) => { calls.push([uid, sec]); if (apply && blockResp.status_code === 0) set.add(uid); return as.block(blockResp); },
  };
}
const blkParams = (o = {}) => ({ op: 'block', uid: ME, selfUids: [ME], target: { mid: '900', via: 'comment', source: { kind: 'comment', commentId: '201', workId: AWEME, parentId: '101', rootId: '101', authorUid: '900' }, ...o } });
const thread = () => fakeComments({ roots: [root('101', '800', 1)], replies: { 101: [sub('201', '101', '900')] } });

describe('抖音拉黑', () => {
  test('从来源评论读出 sec_uid → 网页版核对账号 → 拉黑一次 → 回读 is_block=true → found（实测写法、全下划线、全驼峰都认）', async () => {
    for (const style of Object.keys(STYLES)) {
      const w = fakeWeb({ style });
      const r = await block(apiOf(thread(), { web: w }), blkParams());
      assert.deepEqual([r.sendAttempted, r.sendError, r.readBack.found, r.readBack.nativeId], [true, undefined, true, '900'], style);
      assert.deepEqual(w.calls, [['900', 'SEC-900']], style);
    }
  });

  test('已拉黑、接口报错、block_status 不是 1：每种写法都认得出来', async () => {
    for (const style of Object.keys(STYLES)) {
      const already = await block(apiOf(thread(), { web: fakeWeb({ style, blocked: ['900'] }) }), blkParams());
      assert.equal(already.blocked, 'already-blocked', style);
      const err = await block(apiOf(thread(), { web: fakeWeb({ style, blockResp: { status_code: 2096, status_msg: '操作太频繁' } }) }), blkParams());
      assert.match(err.sendError, /status_code=2096 操作太频繁/, style);
      const half = await block(apiOf(thread(), { web: fakeWeb({ style, blockResp: { status_code: 0, block_status: 0 } }) }), blkParams());
      assert.match(half.sendError, /block_status=0/, style);
      assert.equal(half.readBack.found, false, style);
    }
  });

  test('profile/other 读不到 is_block（两种写法都没有、或不是布尔值）→ precheck-error，不调拉黑', async () => {
    for (const user of [{ uid: '900' }, { uid: '900', is_block: 1 }, { uid: '900', isBlock: 'false' }, { uid: '900', is_block: null }]) {
      for (const top of [{ status_code: 0 }, { statusCode: 0 }]) {
        const w = fakeWeb();
        w.other = async () => ({ ...top, user });
        const r = await block(apiOf(thread(), { web: w }), blkParams());
        assert.deepEqual([r.blocked, r.sendAttempted], ['precheck-error', false], JSON.stringify({ top, user }));
        assert.match(r.detail, /is_block/);
        assert.equal(w.calls.length, 0);
      }
    }
  });

  test('profile/self、profile/other 的 status_code 两种写法都没有 / 不是 0 → precheck-error，不调拉黑', async () => {
    const cases = [
      ['self 没有状态码', (w) => { w.self = async () => ({ user: { uid: ME } }); }],
      ['self statusCode=8', (w) => { w.self = async () => ({ statusCode: 8, user: { uid: ME } }); }],
      ['other 没有状态码', (w) => { w.other = async () => ({ user: { uid: '900', isBlock: false } }); }],
      ['other status_code=2', (w) => { w.other = async () => ({ status_code: 2, user: { uid: '900', is_block: false } }); }],
    ];
    for (const [name, patch] of cases) {
      const w = fakeWeb();
      patch(w);
      const r = await block(apiOf(thread(), { web: w }), blkParams());
      assert.deepEqual([r.blocked, r.sendAttempted], ['precheck-error', false], name);
      assert.equal(w.calls.length, 0, name);
    }
  });

  test('评审第 1 轮：两种写法同时出现且值冲突（含一边是 null）、状态码是字符串 "0" → 发前 precheck-error，不调拉黑', async () => {
    const others = [
      { status_code: null, statusCode: 0, user: { uid: '900', isBlock: false } },
      { status_code: 0, user: { uid: '900', is_block: null, isBlock: false } },
      { status_code: 0, user: { uid: '900', is_block: true, isBlock: false } },
      { status_code: '0', user: { uid: '900', is_block: false } },
    ];
    for (const o of others) {
      const w = fakeWeb();
      w.other = async () => o;
      const r = await block(apiOf(thread(), { web: w }), blkParams());
      assert.deepEqual([r.blocked, r.sendAttempted], ['precheck-error', false], JSON.stringify(o));
      assert.equal(w.calls.length, 0);
    }
    // 评审第 2 轮：返回是数组（哪怕带了 status_code、user 属性）也不认
    const arr = Object.assign([], { status_code: 0, user: { uid: '900', is_block: false } });
    const wa = fakeWeb();
    wa.other = async () => arr;
    assert.equal((await block(apiOf(thread(), { web: wa }), blkParams())).blocked, 'precheck-error');
    assert.equal(wa.calls.length, 0);
    const w = fakeWeb();
    w.self = async () => ({ status_code: 8, statusCode: 0, user: { uid: ME } });
    assert.equal((await block(apiOf(thread(), { web: w }), blkParams())).blocked, 'precheck-error');
    assert.equal(w.calls.length, 0);
  });

  test('评审第 1 轮：拉黑返回两种写法冲突（status_code: null + statusCode: 0、block_status: null + blockStatus: 1）、状态码是 "0" → sendError，回读已拉黑也不算 found', async () => {
    const resps = [
      { status_code: null, statusCode: 0, block_status: null, blockStatus: 1 },
      { status_code: 0, block_status: null, blockStatus: 1 },
      { status_code: 0, block_status: 0, blockStatus: 1 },
      { status_code: '0', block_status: 1 },
    ];
    for (const resp of resps) {
      const w = fakeWeb();
      w.block = async (uid, sec) => { w.calls.push([uid, sec]); w.other = async () => ({ statusCode: 0, user: { uid: '900', isBlock: true } }); return resp; };
      const r = await block(apiOf(thread(), { web: w }), blkParams());
      assert.deepEqual([r.sendAttempted, r.readBack.found], [true, false], JSON.stringify(resp));
      assert.ok(r.sendError, JSON.stringify(resp));
      assert.equal(w.calls.length, 1);
    }
  });

  test('拉黑返回里读不到 status_code / block_status → sendError，回读已拉黑也不算 found', async () => {
    for (const resp of [{}, { status_code: 0 }, { statusCode: 0 }, null]) {
      const w = fakeWeb();
      w.block = async (uid, sec) => { w.calls.push([uid, sec]); w.other = async () => ({ statusCode: 0, user: { uid: '900', isBlock: true } }); return resp; };
      const r = await block(apiOf(thread(), { web: w }), blkParams());
      assert.deepEqual([r.sendAttempted, r.readBack.found], [true, false], JSON.stringify(resp));
      assert.match(r.sendError, /status_code=无|block_status=无/, JSON.stringify(resp));
      assert.equal(w.calls.length, 1);
    }
  });

  test('从来源会话读出 sec_uid；会话对方不是这个人 → target-not-found；群聊 → not-a-user', async () => {
    const src = { kind: 'conversation', conversationId: 'c1', peerUid: '900' };
    const w = fakeWeb();
    const ok = await block(apiOf(thread(), { web: w, conversation: { peer: '900', secUid: 'SEC-900', group: false } }), blkParams({ via: 'conversation', source: src }));
    assert.equal(ok.readBack.found, true);
    const bad = await block(apiOf(thread(), { web: fakeWeb(), conversation: { peer: '901', secUid: 'SEC-901', group: false } }), blkParams({ via: 'conversation', source: src }));
    assert.equal(bad.blocked, 'target-not-found');
    const grp = await block(apiOf(thread(), { web: fakeWeb(), conversation: { peer: '900', secUid: 'S', group: true } }), blkParams({ via: 'conversation', source: src }));
    assert.equal(grp.blocked, 'not-a-user');
  });

  test('已经拉黑 → already-blocked，不调拉黑', async () => {
    const w = fakeWeb({ blocked: ['900'] });
    const r = await block(apiOf(thread(), { web: w }), blkParams());
    assert.deepEqual([r.blocked, r.sendAttempted], ['already-blocked', false]);
    assert.equal(w.calls.length, 0);
  });

  test('对象是我自己 → self-target，不碰网页版', async () => {
    const w = fakeWeb();
    for (const mid of [ME, '555']) {
      const r = await block(apiOf(thread(), { web: w }), { ...blkParams({ mid }), selfUids: [ME, '555'] });
      assert.equal(r.blocked, 'self-target', mid);
    }
    assert.equal(w.calls.length, 0);
  });

  test('网页版登录的不是这个账号 → uid-mismatch；sec_uid 对应的不是这个人 → target-not-found；都不调拉黑', async () => {
    const w1 = fakeWeb({ selfUid: '123' });
    assert.equal((await block(apiOf(thread(), { web: w1 }), blkParams())).blocked, 'uid-mismatch');
    const w2 = fakeWeb({ users: { 'SEC-900': '777' } });
    assert.equal((await block(apiOf(thread(), { web: w2 }), blkParams())).blocked, 'target-not-found');
    assert.equal(w1.calls.length + w2.calls.length, 0);
  });

  test('来源评论已不在、作者对不上、没有来源 → target-not-found，不调拉黑', async () => {
    const w = fakeWeb();
    const gone = fakeComments({ roots: [root('101', '800', 0)] });
    assert.equal((await block(apiOf(gone, { web: w }), blkParams())).blocked, 'target-not-found');
    assert.equal((await block(apiOf(thread(), { web: w }), blkParams({ mid: '901' }))).blocked, 'target-not-found');
    assert.equal((await block(apiOf(thread(), { web: w }), blkParams({ source: null }))).blocked, 'target-not-found');
    assert.equal(w.calls.length, 0);
  });

  test('回读还没拉黑 → found=false；接口报错 → sendError；都只调一次', async () => {
    const w = fakeWeb({ apply: false });
    const r = await block(apiOf(thread(), { web: w }), blkParams());
    assert.deepEqual([r.sendAttempted, r.readBack.found], [true, false]);
    assert.match(r.readBack.detail, /is_block 还是 false/);
    const w2 = fakeWeb({ blockResp: { status_code: 2096, status_msg: '操作太频繁' } });
    const r2 = await block(apiOf(thread(), { web: w2 }), blkParams());
    assert.match(r2.sendError, /status_code=2096/);
    assert.equal(r2.readBack.found, false);
    assert.equal(w.calls.length + w2.calls.length, 2);
  });

  test('评审第 3 轮：拉黑调用抛错但回读已拉黑 → found=false（不当成这次拉黑的）', async () => {
    const w = fakeWeb();
    w.block = async (uid, sec) => { w.calls.push([uid, sec]); w.other = async () => ({ status_code: 0, user: { uid: '900', is_block: true } }); throw new Error('超时'); };
    const r = await block(apiOf(thread(), { web: w }), blkParams());
    assert.deepEqual([r.sendAttempted, r.readBack.found], [true, false]);
    assert.equal(w.calls.length, 1);
  });

  // 错误消息为空时 errText 曾得到 ''，postError 是假值，回读看到已生效就判成 found
  const EMPTY_ERRORS = [['new Error(\'\')', () => new Error('')], ["throw ''", () => ''], ["{ message: '' }", () => ({ message: '' })]];

  test('拉黑调用抛出空消息错误（new Error(\'\')、throw \'\'、{ message: \'\' }）、回读已拉黑 → found=false，只调一次', async () => {
    for (const [name, err] of EMPTY_ERRORS) {
      const w = fakeWeb();
      w.block = async (uid, sec) => { w.calls.push([uid, sec]); w.other = async () => ({ status_code: 0, user: { uid: '900', is_block: true } }); throw err(); };
      const r = await block(apiOf(thread(), { web: w }), blkParams());
      assert.deepEqual([r.sendAttempted, r.readBack.found], [true, false], name);
      assert.match(r.readBack.detail, /user\/block 出错：未知错误/, name);
      assert.equal(w.calls.length, 1, name);
    }
  });

  test('拉黑：页面函数返回 { __error: \'\' }（unwrap 抛 new Error(\'\')）、回读已拉黑 → found=false', async () => {
    const w = fakeWeb();
    w.block = async (uid, sec) => { w.calls.push([uid, sec]); w.other = async () => ({ status_code: 0, user: { uid: '900', is_block: true } }); const r = { __error: '' }; if ('__error' in r) throw new Error(r.__error); return r; };
    const r = await block(apiOf(thread(), { web: w }), blkParams());
    assert.deepEqual([r.sendAttempted, r.readBack.found], [true, false]);
  });

  test('拉黑调用抛错 → sendAttempted=true，回读照做、不重调', async () => {
    const w = fakeWeb();
    w.block = async (uid, sec) => { w.calls.push([uid, sec]); throw new Error('超时'); };
    const r = await block(apiOf(thread(), { web: w }), blkParams());
    assert.deepEqual([r.sendAttempted, r.readBack.found], [true, false]);
    assert.match(r.readBack.detail, /超时/);
    assert.equal(w.calls.length, 1);
  });
});

describe('locateWebFns（假 window）', () => {
  test('按接口路径在 webpack 模块里各找到唯一一个函数；缺一个就返回 false', () => {
    const mods = {
      a: Object.assign(function a() {}, { toString: () => `x("${WEB_FNS.block}") y("${WEB_FNS.other}")` }),
      b: Object.assign(function b() {}, { toString: () => `z("${WEB_FNS.self}")` }),
    };
    const blockFn = Object.assign(async () => ({}), { toString: () => `async function T(){return v_("${WEB_FNS.block}")}` });
    const otherFn = Object.assign(async () => ({}), { toString: () => `async function k(){return U2("${WEB_FNS.other}")}` });
    const selfFn = Object.assign(async () => ({}), { toString: () => `async function b(){return U2("${WEB_FNS.self}")}` });
    const exportsOf = { a: { Ox: blockFn, et: otherFn, RK: async () => {} }, b: { fetchUserProfileSelf: selfFn } };
    const req = (id) => exportsOf[id];
    req.m = mods;
    const chunk = [];
    chunk.push = function (c) { c[2](req); };
    globalThis.window = { webpackChunkdouyin_web: chunk };
    try {
      assert.equal(locateWebFns(WEB_FNS), true);
      assert.deepEqual(Object.keys(window.__engDyWeb).sort(), ['block', 'other', 'self']);
      assert.equal(window.__engDyWeb.block, blockFn);
      globalThis.window = { webpackChunkdouyin_web: chunk };
      delete exportsOf.b;
      req.m = { a: mods.a };
      assert.equal(locateWebFns(WEB_FNS), false);
    } finally { delete globalThis.window; }
  });
});

describe('框架接线（临时库 + 假 writer）', () => {
  function setup() {
    const db = freshDb(tmpDbFile());
    const acct = douyin(db);
    ingestSnapshot(db, acct, commentsSnap([]), { now: () => T0 });
    ingestSnapshot(db, acct, commentsSnap([comment('101', { uid: '800' }), comment('201', { parent: '101', root: '101', uid: '900' })]), { now: () => T0 + MIN });
    ingestSnapshot(db, acct, dmsSnap([]), { now: () => T0 });
    ingestSnapshot(db, acct, dmsSnap([{ ...conv('c1'), peer: { uid: '900', nickname: 'x', kind: 'user' } }]), { now: () => T0 + MIN });
    for (const c of ['deleteComment', 'block', 'deleteConversation']) setCapability(db, acct.id, c, true);
    const calls = [];
    const runWriter = async (a) => { calls.push(a); return { ok: true, result: { uidSeen: ME, sendAttempted: true, readBack: { found: true, count: 1, nativeId: 'x' } } }; };
    return { db, acct, calls, deps: { now: () => T0 + 2 * MIN, runWriter, notify: async () => true, log: () => {} } };
  }

  test('删评论：走 douyin-moderate.mjs，writer 拿到楼信息', async () => {
    const s = setup();
    const r = await engageWrite(s.db, { op: 'delete', targetId: 'Douyin:201', idempotencyKey: 'k1', caller: 't' }, s.deps);
    assert.equal(r.status, 'sent');
    assert.match(writerModuleUrl('Douyin', 'delete'), /douyin-moderate\.mjs$/);
    assert.deepEqual(s.calls[0].params.target, { commentId: '201', workId: 'w1', parentId: '101', rootId: '101', authorUid: '900' });
  });

  test('拉黑：评论 id、会话 id、uid 三种入口都推出 Douyin:900，source 分别是评论、会话、最近的评论', async () => {
    const s = setup();
    const a = await engageWrite(s.db, { op: 'block', targetId: 'Douyin:201', idempotencyKey: 'k1', caller: 't' }, s.deps);
    assert.deepEqual([a.status, a.targetId], ['sent', 'Douyin:900']);
    assert.equal(s.calls[0].params.target.source.kind, 'comment');
    const s2 = setup();
    await engageWrite(s2.db, { op: 'block', targetId: 'Douyin:c1', idempotencyKey: 'k2', caller: 't' }, s2.deps);
    assert.deepEqual(s2.calls[0].params.target.source, { kind: 'conversation', conversationId: 'c1', peerUid: '900' });
    const s3 = setup();
    await engageWrite(s3.db, { op: 'block', targetId: 'Douyin:900', idempotencyKey: 'k3', caller: 't' }, s3.deps);
    assert.deepEqual([s3.calls[0].params.target.via, s3.calls[0].params.target.source.commentId], ['mid', '201']);
  });

  test('拉黑我自己的 uid → rejected self-target；删会话 → rejected unsupported-platform（带原因）；都不起 writer', async () => {
    const s = setup();
    const me = await engageWrite(s.db, { op: 'block', targetId: `Douyin:${ME}`, idempotencyKey: 'k1', caller: 't' }, s.deps);
    assert.deepEqual([me.status, me.reason], ['rejected', 'self-target']);
    const dc = await engageWrite(s.db, { op: 'deleteConversation', targetId: 'Douyin:c1', idempotencyKey: 'k2', caller: 't' }, s.deps);
    assert.deepEqual([dc.status, dc.reason], ['rejected', 'unsupported-platform']);
    assert.match(dc.detail, /MarkConversationDelete/);
    assert.equal(s.calls.length, 0);
  });

  test('写入脚本回读没确认（found=false）→ needs_readback；同一个 key 再调不再起 writer', async () => {
    const s = setup();
    s.deps.runWriter = async (a) => { s.calls.push(a); return { ok: true, result: { uidSeen: ME, sendAttempted: true, readBack: { found: false, count: 0, detail: '回读时这条还在' } } }; };
    const r = await engageWrite(s.db, { op: 'delete', targetId: 'Douyin:201', idempotencyKey: 'k1', caller: 't' }, s.deps);
    assert.equal(r.status, 'needs_readback');
    const again = await engageWrite(s.db, { op: 'delete', targetId: 'Douyin:201', idempotencyKey: 'k1', caller: 't' }, s.deps);
    assert.equal(again.status, 'needs_readback');
    assert.equal(s.calls.length, 1);
  });
});
