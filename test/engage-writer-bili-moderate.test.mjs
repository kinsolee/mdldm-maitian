// B站处置写入脚本（删评论、拉黑、删会话）对假 B站接口：不起浏览器、不连任何真实地址、不调任何真实写接口。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deleteComment, block, deleteConversation, runInSpace } from '../src/ops/engage/writers/bili-moderate.mjs';

const ME = '478358005';
const rp = (rpid, o = {}) => ({ rpid, rpid_str: String(rpid), root: o.root ?? 0, parent: o.parent ?? 0, parent_str: String(o.parent ?? 0),
  member: { mid: o.mid ?? '9001', uname: o.uname ?? '甲' }, content: { message: o.text ?? `评论${rpid}` } });

/** 假 B站：nav、view、reply/reply、up/fulllist、reply/del、x/relation、relation/modify、get_sessions、remove_session。posts 记下所有写请求。 */
function fakeBili(o = {}) {
  const st = {
    login: o.login ?? true, mid: o.mid ?? ME, owner: o.owner ?? ME,
    threads: o.threads ?? { 100: { root: rp(100, { mid: '9001' }), replies: [rp(101, { root: 100, parent: 100, mid: '9002' }), rp(102, { root: 100, parent: 100, mid: ME })] } },
    delCode: o.delCode ?? 0, delEffective: o.delEffective ?? true, throws: o.throws ?? null,
    relations: o.relations ?? { 9001: 0, 9002: 2 }, modifyCode: o.modifyCode ?? 0, modifyEffective: o.modifyEffective ?? true,
    // 会话按 get_sessions 的 session_type 分组：1 用户与系统、2 未关注人、5 被拦截、8 陌生人。只给 sessions 的放在 1 组
    groups: o.groups ?? { 1: o.sessions ?? [{ talker_id: 777, session_type: 1, session_ts: 3 }, { talker_id: 888, session_type: 1, session_ts: 2 }] },
    pageSize: o.pageSize ?? 20, removeCode: o.removeCode ?? 0, removeEffective: o.removeEffective ?? true,
    // hidden：B站对外隐藏的楼中楼，reply/reply 不给、page.count 照算；UP 主评论管理 up/fulllist 里有
    hidden: o.hidden ?? [],
  };
  /** up/fulllist 按作品给：楼（一楼 + 看得见的回复）加上被隐藏的，新到旧（rpid 从大到小） */
  const fulllist = () => [...Object.values(st.threads).flatMap((t) => [t.root, ...t.replies]), ...st.hidden]
    .map((x) => ({ ...x, oid: x.oid ?? 555, bvid: 'BV1xx' })).sort((a, b) => b.rpid - a.rpid);
  const posts = [], gets = [], sessionTypes = [];
  const api = {
    sleep: async () => {},
    async get(url) {
      const u = new URL(url);
      const q = (k) => u.searchParams.get(k);
      gets.push(u.pathname);
      if (u.pathname === '/x/web-interface/nav') return st.login ? { code: 0, data: { isLogin: true, mid: Number(st.mid) } } : { code: -101, data: { isLogin: false } };
      if (u.pathname === '/x/web-interface/view') return q('bvid') === 'BV1xx' ? { code: 0, data: { aid: 555, bvid: 'BV1xx', owner: { mid: Number(st.owner) } } } : { code: -404, message: '啥都木有' };
      if (u.pathname === '/x/v2/reply/reply') {
        assert.equal(q('oid'), '555');
        const t = st.threads[q('root')];
        if (!t) return o.missingCode ? { code: o.missingCode, message: '没有该评论', data: null } : { code: 12022, message: '已经被删除了' };
        const pn = Number(q('pn'));
        const count = t.replies.length + st.hidden.filter((x) => String(x.root) === q('root')).length;
        return { code: 0, data: { page: { count, num: pn, size: 20 }, root: t.root, replies: t.replies.slice((pn - 1) * 20, pn * 20) } };
      }
      if (u.pathname === '/x/v2/reply/up/fulllist') {
        if (o.fulllist) return o.fulllist(u, fulllist());
        const all = q('bvid') === 'BV1xx' ? fulllist() : [];
        const pn = Number(q('pn')), ps = Number(q('ps'));
        const list = all.slice((pn - 1) * ps, pn * ps);
        return { code: 0, data: { page: { num: pn, size: ps, total: all.length }, list: list.length ? list : null } };
      }
      if (u.pathname === '/x/relation') {
        const a = st.relations[q('fid')];
        return a == null ? { code: -400, message: '请求错误' } : { code: 0, data: { mid: Number(q('fid')), attribute: a } };
      }
      if (u.pathname === '/session_svr/v1/session_svr/get_sessions') {
        const end = q('end_ts') == null ? Infinity : Number(q('end_ts'));
        sessionTypes.push(q('session_type'));
        if (o.groupError?.[q('session_type')]) return { code: 2, message: '非法参数' };
        const rest = (st.groups[q('session_type')] ?? []).filter((s) => s.session_ts < end);
        const page = rest.slice(0, st.pageSize);
        return { code: 0, data: { session_list: page, has_more: rest.length > page.length ? 1 : 0 } };
      }
      throw new Error(`假 B站没有这个 GET：${u.pathname}`);
    },
    async post(url, form, csrfFields) {
      const u = new URL(url);
      posts.push({ path: u.pathname, form, csrfFields });
      if (st.throws === u.pathname) throw new Error('网络断了');
      if (u.pathname === '/x/v2/reply/del') {
        if (st.delCode !== 0) return { code: st.delCode, message: '没权限' };
        if (st.delEffective) {
          for (const [root, t] of Object.entries(st.threads)) {
            if (String(t.root.rpid) === form.rpid) delete st.threads[root];
            else t.replies = t.replies.filter((x) => String(x.rpid) !== form.rpid);
          }
          st.hidden = st.hidden.filter((x) => String(x.rpid) !== form.rpid);
        }
        return { code: 0, data: null };
      }
      if (u.pathname === '/x/relation/modify') {
        if (st.modifyCode !== 0) return { code: st.modifyCode, message: '拉黑失败' };
        if (st.modifyEffective) st.relations[form.fid] = 128;
        return { code: 0 };
      }
      if (u.pathname === '/session_svr/v1/session_svr/remove_session') {
        if (st.removeCode !== 0) return { code: st.removeCode, message: '请求错误' };
        if (st.removeEffective) for (const g of Object.keys(st.groups)) if (!(o.removeKeeps ?? []).includes(g)) st.groups[g] = st.groups[g].filter((s) => String(s.talker_id) !== form.talker_id);
        return { code: 0, data: {} };
      }
      throw new Error(`假 B站没有这个 POST：${u.pathname}`);
    },
  };
  return { api, posts, gets, st, sessionTypes };
}

const root = { commentId: '100', workId: 'BV1xx', parentId: null, rootId: '100', authorUid: '9001' };
const sub = { commentId: '101', workId: 'BV1xx', parentId: '100', rootId: '100', authorUid: '9002' };
const mine = { commentId: '102', workId: 'BV1xx', parentId: '100', rootId: '100', authorUid: ME };
const P = (op, target, extra = {}) => ({ op, uid: ME, nickname: '我', target, selfUids: [ME], ...extra });

describe('B站 delete（假接口）', () => {
  test('删楼中楼：reply/del 只调一次（oid/type/rpid，csrf 由页面填），回读整楼没有了 → found', async () => {
    const f = fakeBili();
    const r = await deleteComment(f.api, P('delete', sub));
    assert.equal(r.sendAttempted, true);
    assert.deepEqual(r.readBack, { found: true, count: 1, nativeId: '101', detail: '楼 100 里已没有 101' });
    assert.equal(f.posts.length, 1);
    assert.deepEqual({ ...f.posts[0].form }, { oid: '555', type: '1', rpid: '101' });
    assert.deepEqual(f.posts[0].csrfFields, ['csrf']);
  });

  test('删一楼（下面没有回复）：回读整楼 12022 → found', async () => {
    const f = fakeBili({ threads: { 100: { root: rp(100, { mid: '9001' }), replies: [] } } });
    const r = await deleteComment(f.api, P('delete', root));
    assert.equal(r.readBack.found, true);
    assert.equal(f.posts.length, 1);
  });

  test('删一楼、下面有回复（B站会连整楼一起删）→ deletes-thread，不调接口；只读第 1 页', async () => {
    const f = fakeBili();
    const r = await deleteComment(f.api, P('delete', root));
    assert.deepEqual([r.blocked, r.rejected, r.sendAttempted], ['deletes-thread', true, false]);
    assert.match(r.detail, /2 条回复/);
    // 回复只有我自己的也一样：删一楼会把它们一起删掉
    const g = fakeBili({ threads: { 100: { root: rp(100, { mid: '9001' }), replies: [rp(102, { root: 100, parent: 100, mid: ME })] } } });
    assert.equal((await deleteComment(g.api, P('delete', root))).blocked, 'deletes-thread');
    // page.count 是 0 但一楼的 rcount 说有回复：也不删
    const h = fakeBili({ threads: { 100: { root: { ...rp(100, { mid: '9001' }), rcount: 3 }, replies: [] } } });
    assert.equal((await deleteComment(h.api, P('delete', root))).blocked, 'deletes-thread');
    assert.equal(f.posts.length + g.posts.length + h.posts.length, 0);
    assert.equal(f.gets.filter((x) => x === '/x/v2/reply/reply').length, 1);
  });

  test('删一楼：page.count 读不到、判断不了下面有没有回复 → thread-incomplete，不调接口', async () => {
    const f = fakeBili({ threads: { 100: { root: rp(100, { mid: '9001' }), replies: [] } } });
    const get = f.api.get;
    f.api.get = async (url) => { const j = await get(url); if (url.includes('reply/reply') && j.data) delete j.data.page.count; return j; };
    const r = await deleteComment(f.api, P('delete', root));
    assert.deepEqual([r.blocked, r.sendAttempted], ['thread-incomplete', false]);
  });

  test('删一楼：reply/reply 给的一楼不是这条 → target-not-found，不调接口', async () => {
    const f = fakeBili({ threads: { 100: { root: rp(150, { mid: '9001' }), replies: [] } } });
    assert.equal((await deleteComment(f.api, P('delete', root))).blocked, 'target-not-found');
    assert.equal(f.posts.length, 0);
  });

  test('绝不删我自己的评论：作者 mid 是登录账号 → self-target，不调接口', async () => {
    const f = fakeBili();
    const r = await deleteComment(f.api, P('delete', mine));
    assert.deepEqual([r.blocked, r.sendAttempted], ['self-target', false]);
    // 作者是另一个登记过的本平台账号（selfUids）也不删
    const g = fakeBili({ threads: { 100: { root: rp(100), replies: [rp(101, { root: 100, parent: 100, mid: '5550001' })] } } });
    const r2 = await deleteComment(g.api, P('delete', sub, { selfUids: [ME, '5550001'] }));
    assert.equal(r2.blocked, 'self-target');
    assert.equal(f.posts.length + g.posts.length, 0);
  });

  test('发前重读：楼已被删 → already-gone；楼里定位不到这条 → target-not-found；都不调接口', async () => {
    const gone = fakeBili({ threads: {} });
    assert.equal((await deleteComment(gone.api, P('delete', sub))).blocked, 'already-gone');
    const missing = fakeBili({ threads: { 100: { root: rp(100), replies: [] } } });
    assert.equal((await deleteComment(missing.api, P('delete', sub))).blocked, 'target-not-found');
    assert.equal(gone.posts.length + missing.posts.length, 0);
  });

  // 12006「没有该评论」：root 楼不存在（root 填错也是它）。发后回读认作楼已不在，发前不认
  test('12006：删一楼（下面没有回复）后回读 reply/reply 返回 12006 → found，detail 写明 code=12006', async () => {
    const f = fakeBili({ missingCode: 12006, threads: { 100: { root: rp(100, { mid: '9001' }), replies: [] } } });
    const r = await deleteComment(f.api, P('delete', root));
    assert.equal(r.sendAttempted, true);
    assert.deepEqual(r.readBack, { found: true, count: 1, nativeId: '100', detail: '楼 100 已不在（code=12006）' });
    assert.equal(f.posts.length, 1);
  });

  test('12006：删楼中楼后整栋楼都没了，回读返回 12006 → found；只调一次', async () => {
    const f = fakeBili({ missingCode: 12006 });
    const post = f.api.post;
    // 删的同时一楼也被删了：发后整栋楼 12006
    f.api.post = async (url, form, c) => { const r = await post(url, form, c); delete f.st.threads[100]; return r; };
    const r = await deleteComment(f.api, P('delete', sub));
    assert.deepEqual(r.readBack, { found: true, count: 1, nativeId: '101', detail: '楼 100 已不在（code=12006）' });
    assert.equal(f.posts.length, 1);
  });

  test('12006：大楼里删一页的第一条（跨页重读）后整栋楼 12006 → found', async () => {
    const replies = Array.from({ length: 45 }, (_, i) => rp(1000 + i * 3, { root: 100, parent: 100, mid: '9100' }));
    const f = fakeBili({ missingCode: 12006, threads: { 100: { root: rp(100), replies } } });
    const post = f.api.post, get = f.api.get;
    // 回读定位（第 1、2 页）时楼还在，跨页重读第 2 页时楼已被删 → 走的是 fresh 这条路
    let after = null;
    f.api.post = async (url, form, c) => { const r = await post(url, form, c); after = 0; return r; };
    f.api.get = async (url) => { if (after != null && url.includes('reply/reply') && ++after === 3) delete f.st.threads[100]; return get(url); };
    const r = await deleteComment(f.api, P('delete', { ...sub, commentId: String(1000 + 20 * 3), authorUid: '9100' }));
    assert.equal(r.readBack.found, true, r.readBack.detail);
    assert.match(r.readBack.detail, /code=12006/);
  });

  test('12006：发前 reply/reply 就返回 12006（root 可能填错）→ 不调 reply/del，blocked 不是 already-gone', async () => {
    for (const target of [root, sub]) {
      const f = fakeBili({ missingCode: 12006, threads: {} });
      const r = await deleteComment(f.api, P('delete', target));
      assert.equal(r.sendAttempted, false);
      assert.notEqual(r.blocked, 'already-gone');
      assert.equal(r.blocked, 'precheck-error');
      assert.match(r.detail, /code=12006/);
      assert.equal(f.posts.length, 0);
    }
  });

  test('楼中楼对上了 rpid、但它的 root 不是这栋楼 → target-not-found，不调接口', async () => {
    const f = fakeBili({ threads: { 100: { root: rp(100), replies: [rp(101, { root: 77, parent: 77, mid: '9002' })] } } });
    assert.equal((await deleteComment(f.api, P('delete', sub))).blocked, 'target-not-found');
    assert.equal(f.posts.length, 0);
  });

  test('不是我的作品 → not-my-work；作品读不到 → target-not-found；都不调接口', async () => {
    const f = fakeBili({ owner: '123' });
    assert.equal((await deleteComment(f.api, P('delete', sub))).blocked, 'not-my-work');
    const g = fakeBili();
    assert.equal((await deleteComment(g.api, P('delete', { ...sub, workId: 'BVnone' }))).blocked, 'target-not-found');
    assert.equal(f.posts.length + g.posts.length, 0);
  });

  // 热门大楼：1000 条楼中楼（50 页），远超过以前「最多读 10 页」
  const bigThread = (n = 1000, extra = {}) => ({ 100: { root: rp(100), replies: Array.from({ length: n }, (_, i) => rp(1000 + i * 3, { root: 100, parent: 100, mid: '9100', ...extra })) } });
  const replyGets = (f) => f.gets.filter((x) => x === '/x/v2/reply/reply').length;

  test('大楼：目标在第 37 页（超过 10 页）也能定位、删掉、回读确认 → found；只读十几页，不读整楼', async () => {
    const f = fakeBili({ threads: bigThread() });
    const target = String(1000 + 730 * 3);   // 第 731 条，第 37 页
    const r = await deleteComment(f.api, P('delete', { ...sub, commentId: target, authorUid: '9100' }));
    assert.equal(r.sendAttempted, true);
    assert.equal(r.readBack.found, true, r.readBack.detail);
    assert.equal(r.readBack.nativeId, target);
    assert.equal(f.posts.length, 1);
    assert.deepEqual({ ...f.posts[0].form }, { oid: '555', type: '1', rpid: target });
    assert.ok(replyGets(f) <= 30, `reply/reply 读了 ${replyGets(f)} 页`);
  });

  test('大楼：目标是一页的第一条、最后一条，或整楼最后一条（跨页找邻居）都能确认删掉', async () => {
    for (const i of [0, 19, 20, 399, 999]) {
      const f = fakeBili({ threads: bigThread() });
      const r = await deleteComment(f.api, P('delete', { ...sub, commentId: String(1000 + i * 3), authorUid: '9100' }));
      assert.equal(r.readBack.found, true, `第 ${i + 1} 条：${r.readBack.detail}`);
    }
  });

  test('大楼：目标 rpid 不在楼里 → 不是 already-gone，不调接口；改查 up/fulllist，作品 1001 条超过 400 条读不全 → thread-incomplete', async () => {
    const f = fakeBili({ threads: bigThread() });
    for (const id of ['1001', '999', '99999']) {
      const r = await deleteComment(f.api, P('delete', { ...sub, commentId: id }));
      assert.deepEqual([r.blocked, r.sendAttempted], ['thread-incomplete', false], id);
      assert.match(r.detail, /up\/fulllist.*20 页/);
    }
    assert.equal(f.posts.length, 0);
  });

  test('大楼：目标作者是我 → self-target，不调接口', async () => {
    const f = fakeBili({ threads: bigThread(1000, { mid: ME }) });
    assert.equal((await deleteComment(f.api, P('delete', { ...sub, commentId: String(1000 + 500 * 3) }))).blocked, 'self-target');
    assert.equal(f.posts.length, 0);
  });

  test('大楼：接口说成功但这条还在 → found:false；只调一次', async () => {
    const f = fakeBili({ threads: bigThread(), delEffective: false });
    const r = await deleteComment(f.api, P('delete', { ...sub, commentId: String(1000 + 600 * 3), authorUid: '9100' }));
    assert.deepEqual([r.sendAttempted, r.readBack.found, r.readBack.detail], [true, false, '回读时这条还在']);
    assert.equal(f.posts.length, 1);
  });

  test('回读：这条不见了，但前后邻居也变了（同时有别的删除）→ 不算删掉（needs_readback），不重调', async () => {
    const f = fakeBili({ threads: bigThread() });
    const target = 1000 + 600 * 3;
    const post = f.api.post;
    // 删的同时，它前一条也被别人删了：拿不出「它前后两条现在挨着」的证据
    f.api.post = async (url, form, c) => { const r = await post(url, form, c); f.st.threads[100].replies = f.st.threads[100].replies.filter((x) => x.rpid !== target - 3); return r; };
    const r = await deleteComment(f.api, P('delete', { ...sub, commentId: String(target), authorUid: '9100' }));
    assert.deepEqual([r.sendAttempted, r.readBack.found], [true, false]);
    assert.match(r.readBack.detail, /邻居|确认不了/);
    assert.equal(f.posts.length, 1);
  });

  test('回读：删完之后楼里又来了新回复（排在最后），删的是最后一条也能确认', async () => {
    const f = fakeBili({ threads: bigThread(45) });
    const last = 1000 + 44 * 3;
    const post = f.api.post;
    f.api.post = async (url, form, c) => { const r = await post(url, form, c); f.st.threads[100].replies.push(rp(9000, { root: 100, parent: 100 })); return r; };
    const r = await deleteComment(f.api, P('delete', { ...sub, commentId: String(last), authorUid: '9100' }));
    assert.equal(r.readBack.found, true, r.readBack.detail);
  });

  test('reply/reply 的一页不是按 rpid 递增 → 不二分，改按 up/fulllist 核对、删除、回读', async () => {
    const t = bigThread(100);
    t[100].replies.reverse();
    const f = fakeBili({ threads: t });
    const r = await deleteComment(f.api, P('delete', { ...sub, commentId: String(1000 + 50 * 3), authorUid: '9100' }));
    assert.equal(r.readBack.found, true, r.readBack.detail);
    assert.match(r.readBack.detail, /up\/fulllist/);
    assert.equal(f.posts.length, 1);
  });

  test('没登录 → loginLost；登录的不是这个账号 → uid-mismatch；都不调接口', async () => {
    const a = fakeBili({ login: false });
    assert.equal((await deleteComment(a.api, P('delete', sub))).loginLost, true);
    const b = fakeBili({ mid: '123' });
    assert.equal((await deleteComment(b.api, P('delete', sub))).blocked, 'uid-mismatch');
    assert.equal(a.posts.length + b.posts.length, 0);
  });

  test('接口说成功但回读这条还在 → found:false（框架记 needs_readback）；只调一次', async () => {
    const f = fakeBili({ delEffective: false });
    const r = await deleteComment(f.api, P('delete', sub));
    assert.deepEqual([r.sendAttempted, r.readBack.found, r.readBack.detail], [true, false, '回读时这条还在']);
    assert.equal(f.posts.length, 1);
  });

  test('reply/del 报错（-403）→ sendError；reply/del 抛错 → 照样回读、不重调', async () => {
    const f = fakeBili({ delCode: -403 });
    const r = await deleteComment(f.api, P('delete', sub));
    assert.match(r.sendError, /-403/);
    assert.equal(r.readBack.found, false);
    const g = fakeBili({ throws: '/x/v2/reply/del' });
    const r2 = await deleteComment(g.api, P('delete', sub));
    assert.equal(r2.sendAttempted, true);
    assert.equal(g.posts.length, 1);
  });

  test('reply/del 回 12022（调的时候已被删）：回读确认不在 → found', async () => {
    const f = fakeBili({ delCode: 12022 });
    f.st.threads[100].replies = f.st.threads[100].replies.filter((x) => x.rpid !== 101);
    // 发前重读时还在：先放回去，接口调用时再消失
    const get = f.api.get;
    let n = 0;
    f.api.get = async (url) => { const j = await get(url); if (url.includes('reply/reply') && n++ === 0) { j.data.replies.unshift(rp(101, { root: 100, parent: 100, mid: '9002' })); j.data.page.count += 1; } return j; };
    const r = await deleteComment(f.api, P('delete', sub));
    assert.equal(r.sendError, undefined);
    assert.equal(r.readBack.found, true);
  });

  test('X-B2：reply/reply 声明 count=100 却只给了 2 条 → 发前定位不到 target-not-found；回读拿空页不算删掉', async () => {
    const f = fakeBili();
    const get = f.api.get;
    f.api.get = async (url) => { const j = await get(url); if (url.includes('reply/reply') && j.data) j.data.page.count = '100'; return j; };
    const r = await deleteComment(f.api, P('delete', { ...sub, commentId: '999' }));
    assert.deepEqual([r.blocked, r.sendAttempted], ['target-not-found', false]);
    // 发前读全了，回读时声明的 count 对不上（空页）→ 不能说删掉了
    const g = fakeBili();
    const get2 = g.api.get;
    g.api.get = async (url) => { const j = await get2(url); if (url.includes('reply/reply') && j.data && g.posts.length) { j.data.page.count = 100; j.data.replies = []; } return j; };
    const r2 = await deleteComment(g.api, P('delete', sub));
    assert.deepEqual([r2.sendAttempted, r2.readBack.found], [true, false]);
    assert.equal(f.posts.length, 0);
    assert.equal(g.posts.length, 1);
  });

  // R1 Gemini：回读的「挨着」证据必须来自同一个时刻能成立的读取
  const seqThread = (n) => ({ 100: { root: rp(100), replies: Array.from({ length: n }, (_, i) => rp(101 + i, { root: 100, parent: 100, mid: '9100' })) } });
  /** 删除调用之后，reply/reply 的第 pn 页先按 fn 改写（目标一直还在：delEffective=false）。 */
  const afterPost = (f, fn) => { const get = f.api.get; f.api.get = async (url) => { const j = await get(url); const u = new URL(url); if (f.posts.length && u.pathname === '/x/v2/reply/reply' && j.data) fn(Number(u.searchParams.get('pn')), j); return j; }; };
  const subOf = (id) => ({ ...sub, commentId: String(id), authorUid: '9100' });

  test('R1 Gemini-1：回读时读完第 1 页、读第 2 页前，前面有一条被删（整楼往前挪）→ 不能拿旧的第 1 页拼出「挨着」，目标还在 → found:false', async () => {
    const f = fakeBili({ threads: seqThread(60), delEffective: false });
    let shifted = false;
    afterPost(f, (pn) => { if (pn === 1 && !shifted) { shifted = true; f.st.threads[100].replies = f.st.threads[100].replies.filter((x) => x.rpid !== 105); } });
    const r = await deleteComment(f.api, P('delete', subOf(121)));
    assert.deepEqual([r.sendAttempted, r.readBack.found], [true, false], r.readBack.detail);
  });

  test('R1 Gemini-2：回读时第 2 页异常给空页、末页少给、前一页少给 → 都不算到底，目标还在 → found:false', async () => {
    const cases = [
      [21, 121, (pn, j) => { if (pn === 2) j.data.replies = []; }],
      [5, 105, (pn, j) => { if (pn === 1) j.data.replies = j.data.replies.slice(0, 4); }],
      [40, 120, (pn, j) => { if (pn === 1) j.data.replies = j.data.replies.slice(0, 19); }],
    ];
    for (const [n, target, fn] of cases) {
      const f = fakeBili({ threads: seqThread(n), delEffective: false });
      afterPost(f, fn);
      const r = await deleteComment(f.api, P('delete', subOf(target)));
      assert.deepEqual([r.sendAttempted, r.readBack.found], [true, false], `${n} 条删 ${target}：${r.readBack.detail}`);
    }
  });

  test('R1 Gemini-3：删一楼时 page.count / rcount 是 false、空白串、数组 → thread-incomplete，不调接口', async () => {
    for (const [cnt, rc] of [[false, undefined], ['   ', undefined], [[], undefined], [0, false], [0, '  ']]) {
      const f = fakeBili({ threads: { 100: { root: { ...rp(100, { mid: '9001' }), ...(rc === undefined ? {} : { rcount: rc }) }, replies: [] } } });
      const get = f.api.get;
      f.api.get = async (url) => { const j = await get(url); if (url.includes('reply/reply') && j.data) j.data.page.count = cnt; return j; };
      const r = await deleteComment(f.api, P('delete', root));
      assert.deepEqual([r.blocked, r.sendAttempted], ['thread-incomplete', false], `count=${JSON.stringify(cnt)} rcount=${JSON.stringify(rc)}`);
    }
  });

  test('R1 Gemini-4：page.count 偏大（可见 900 条、count=1000），删最后一条 → 发前就 thread-incomplete，不会删了再 needs_readback', async () => {
    const f = fakeBili({ threads: seqThread(900) });
    const get = f.api.get;
    f.api.get = async (url) => { const j = await get(url); if (url.includes('reply/reply') && j.data) j.data.page.count = 1000; return j; };
    const r = await deleteComment(f.api, P('delete', subOf(1000)));
    assert.deepEqual([r.blocked, r.sendAttempted], ['thread-incomplete', false]);
    assert.equal(f.posts.length, 0);
  });

  test('R1 Gemini-8：删一楼时一楼的 oid 不是这个作品 → target-not-found；一楼是我自己的、下面有回复 → self-target', async () => {
    const f = fakeBili({ threads: { 100: { root: { ...rp(100, { mid: '9001' }), oid: 999 }, replies: [] } } });
    assert.equal((await deleteComment(f.api, P('delete', root))).blocked, 'target-not-found');
    const g = fakeBili({ threads: { 100: { root: rp(100, { mid: ME }), replies: [rp(101, { root: 100, parent: 100 })] } } });
    assert.equal((await deleteComment(g.api, P('delete', root))).blocked, 'self-target');
    assert.equal(f.posts.length + g.posts.length, 0);
  });

  test('R1 Gemini-9：reply/reply 报 -412（限流）→ precheck-error（可重试），不报 target-not-found', async () => {
    for (const t of [sub, root]) {
      const f = fakeBili();
      const get = f.api.get;
      f.api.get = async (url) => (url.includes('reply/reply') ? { code: -412, message: '请求被拦截' } : get(url));
      const r = await deleteComment(f.api, P('delete', t));
      assert.deepEqual([r.blocked, r.sendAttempted], ['precheck-error', false], t.commentId);
    }
  });

  test('R2 Codex-1：回读时这一页少给了目标（隐藏 / 折叠），页不满、条数对不上 page.count → 不算删掉；目标在页中间、在第一条都一样', async () => {
    for (const [n, target] of [[3, 102], [3, 101], [3, 103], [25, 121]]) {
      const f = fakeBili({ threads: seqThread(n), delEffective: false });
      afterPost(f, (pn, j) => { j.data.replies = j.data.replies.filter((x) => x.rpid !== target); });
      const r = await deleteComment(f.api, P('delete', subOf(target)));
      assert.deepEqual([r.sendAttempted, r.readBack.found], [true, false], `${n} 条删 ${target}：${r.readBack.detail}`);
    }
  });

  test('R2 Codex-1：发前目标所在的页就不满、条数对不上 page.count → thread-incomplete，不调接口', async () => {
    const f = fakeBili({ threads: seqThread(3) });
    const get = f.api.get;
    f.api.get = async (url) => { const j = await get(url); if (url.includes('reply/reply') && j.data) j.data.page.count = 5; return j; };
    const r = await deleteComment(f.api, P('delete', subOf(102)));
    assert.deepEqual([r.blocked, r.sendAttempted], ['thread-incomplete', false]);
    assert.equal(f.posts.length, 0);
  });

  test('R3 Codex-1：目标是第 1 页最后一条、第 2 页少给（count=40 却只有 1 条）→ 取不到可信的后邻居，发前 thread-incomplete，不调接口', async () => {
    const f = fakeBili({ threads: seqThread(40) });
    const get = f.api.get;
    f.api.get = async (url) => { const j = await get(url); if (url.includes('reply/reply') && j.data && new URL(url).searchParams.get('pn') === '2') j.data.replies = j.data.replies.filter((x) => x.rpid === 122); return j; };
    const r = await deleteComment(f.api, P('delete', subOf(120)));
    assert.deepEqual([r.blocked, r.sendAttempted], ['thread-incomplete', false]);
    assert.equal(f.posts.length, 0);
  });

  test('删唯一一条楼中楼（前后都没有）→ 回读第 1 页空、count=0 → found', async () => {
    const f = fakeBili({ threads: seqThread(1) });
    const r = await deleteComment(f.api, P('delete', subOf(101)));
    assert.equal(r.readBack.found, true, r.readBack.detail);
  });

  test('R1 Codex-1：删一楼时 page.count 是负数 / 小数，或一楼 rcount 是负数 → thread-incomplete，不调接口', async () => {
    for (const [cnt, rc] of [[-1, undefined], [0.5, undefined], [0, -2]]) {
      const f = fakeBili({ threads: { 100: { root: { ...rp(100, { mid: '9001' }), ...(rc === undefined ? {} : { rcount: rc }) }, replies: [] } } });
      const get = f.api.get;
      f.api.get = async (url) => { const j = await get(url); if (url.includes('reply/reply') && j.data) j.data.page.count = cnt; return j; };
      const r = await deleteComment(f.api, P('delete', root));
      assert.deepEqual([r.blocked, r.sendAttempted], ['thread-incomplete', false], `count=${cnt} rcount=${rc}`);
      assert.equal(f.posts.length, 0);
    }
  });

  test('R1 Codex-3 / Gemini-6：page.count 偏小（说 20 条、实际 45 条），目标在第 3 页 → 往后找到、删掉、回读确认', async () => {
    const f = fakeBili({ threads: bigThread(45) });
    const get = f.api.get;
    f.api.get = async (url) => { const j = await get(url); if (url.includes('reply/reply') && j.data) j.data.page.count = Math.min(20, j.data.page.count); return j; };
    const r = await deleteComment(f.api, P('delete', { ...sub, commentId: String(1000 + 42 * 3), authorUid: '9100' }));
    assert.equal(r.sendAttempted, true);
    assert.equal(r.readBack.found, true, r.readBack.detail);
    assert.equal(f.posts.length, 1);
  });

  test('KIN-326 真实现象：楼中楼在第 1 页、整楼超过 10 页 → 以前 thread-incomplete 永远删不掉，现在删掉并回读确认', async () => {
    const many = Array.from({ length: 205 }, (_, i) => rp(200 + i, { root: 100, parent: 100, mid: '9100' }));
    const f = fakeBili({ threads: { 100: { root: rp(100), replies: [rp(101, { root: 100, parent: 100, mid: '9002' }), ...many] } } });
    const r = await deleteComment(f.api, P('delete', sub));
    assert.equal(r.sendAttempted, true);
    assert.equal(r.readBack.found, true, r.readBack.detail);
    assert.equal(f.posts.length, 1);
  });

  test('页面里没有 bili_jct：没调接口，sendAttempted:false', async () => {
    const f = fakeBili();
    f.api.post = async () => ({ code: -111, message: '页面里没有 bili_jct，没调接口', noCsrf: true });
    const r = await deleteComment(f.api, P('delete', sub));
    assert.deepEqual([r.blocked, r.sendAttempted], ['send-error', false]);
  });

  // KIN-326 真实现象：B站把广告类楼中楼对外隐藏，reply/reply 不给它、page.count 照算；UP 主评论管理 up/fulllist 里还在
  describe('被隐藏的楼中楼（reply/reply 看不到，up/fulllist 里有）', () => {
    const vis = (ids) => ids.map((id) => rp(id, { root: 100, parent: 100, mid: '9100' }));
    // 形态 1：第 1 页 5 条、page.count=6，第 2 页空，目标不在 reply/reply 里
    const shape1 = (extra = {}) => fakeBili({ threads: { 100: { root: rp(100), replies: vis([101, 102, 103, 105, 106]) } },
      hidden: [rp(104, { root: 100, parent: 102, mid: '9666' })], ...extra });
    // 形态 2：第 1 页 0 条、page.count=1
    const shape2 = (extra = {}) => fakeBili({ threads: { 100: { root: rp(100), replies: [] } }, hidden: [rp(104, { root: 100, parent: 100, mid: '9666' })], ...extra });
    const hid = { commentId: '104', workId: 'BV1xx', parentId: '102', rootId: '100', authorUid: '9666' };
    const fullGets = (f) => f.gets.filter((x) => x === '/x/v2/reply/up/fulllist').length;

    for (const [name, make] of [['第 1 页 5 条、count=6', shape1], ['第 1 页空、count=1', shape2]]) {
      test(`${name}：在 up/fulllist 里找到 → reply/del 只调一次，回读 fulllist 不见了 → found`, async () => {
        const f = make();
        const r = await deleteComment(f.api, P('delete', hid));
        assert.equal(r.sendAttempted, true, r.detail);
        assert.equal(r.readBack.found, true, r.readBack.detail);
        assert.match(r.readBack.detail, /up\/fulllist.*已没有 104/);
        assert.equal(f.posts.length, 1);
        assert.deepEqual({ ...f.posts[0].form }, { oid: '555', type: '1', rpid: '104' });
        assert.ok(fullGets(f) >= 2);
      });

      test(`${name}：up/fulllist 里也没有 → target-not-found，不调接口`, async () => {
        const f = make({ hidden: [] });
        // 第 1 页空、count=1 但 fulllist 没有：reply/reply 的 count 由 hidden 算，这里单独改成 1
        if (make === shape2) { const get = f.api.get; f.api.get = async (url) => { const j = await get(url); if (url.includes('reply/reply') && j.data) j.data.page.count = 1; return j; }; }
        const r = await deleteComment(f.api, P('delete', hid));
        assert.deepEqual([r.blocked, r.sendAttempted], ['target-not-found', false], r.detail);
        assert.match(r.detail, /up\/fulllist/);
        assert.equal(f.posts.length, 0);
      });
    }

    test('up/fulllist 读不全 → 不删：total 和条数对不上、缺 page.total、翻页时 total 变了、有别的作品的评论、有重复、超过 20 页', async () => {
      const cases = {
        'total 偏大': (u, all) => ({ code: 0, data: { page: { total: all.length + 1 }, list: all } }),
        '缺 page.total': (u, all) => ({ code: 0, data: { page: {}, list: all } }),
        '缺 data.list': () => ({ code: 0, data: { page: { total: 3 } } }),
        'total 变了': (u, all) => { const pn = Number(u.searchParams.get('pn')); return { code: 0, data: { page: { total: pn === 1 ? 25 : 24 }, list: pn === 1 ? Array.from({ length: 20 }, (_, i) => ({ ...rp(5000 + i), oid: 555 })) : all.slice(0, 4) } }; },
        '别的作品': (u, all) => ({ code: 0, data: { page: { total: all.length }, list: all.map((x, i) => (i ? x : { ...x, oid: 777 })) } }),
        '重复': (u, all) => { const pn = Number(u.searchParams.get('pn')); const page = Array.from({ length: 20 }, (_, i) => ({ ...rp(5000 + i), oid: 555 })); return { code: 0, data: { page: { total: 40 }, list: pn === 1 ? page : page } }; },
        '超过 20 页': (u) => ({ code: 0, data: { page: { total: 1000 }, list: Array.from({ length: 20 }, (_, i) => ({ ...rp(Number(u.searchParams.get('pn')) * 100 + i), oid: 555 })) } }),
      };
      for (const [name, fulllist] of Object.entries(cases)) {
        const f = shape1({ fulllist });
        const r = await deleteComment(f.api, P('delete', hid));
        assert.equal(r.sendAttempted, false, name);
        assert.equal(r.blocked, name === '缺 data.list' ? 'precheck-error' : 'thread-incomplete', `${name}：${r.detail}`);
        assert.equal(f.posts.length, 0, name);
        if (name === '超过 20 页') assert.equal(fullGets(f), 20);
      }
      // fulllist 报错（限流）→ precheck-error，可重试
      const g = shape2({ fulllist: () => ({ code: -412, message: '请求被拦截' }) });
      assert.deepEqual([(await deleteComment(g.api, P('delete', hid))).blocked, g.posts.length], ['precheck-error', 0]);
    });

    test('在 up/fulllist 里找到，但作者是我 → self-target；作者 mid 和目标对不上、楼不是这栋 → target-not-found；都不调接口', async () => {
      const a = shape1({ hidden: [rp(104, { root: 100, parent: 102, mid: ME })] });
      assert.equal((await deleteComment(a.api, P('delete', { ...hid, authorUid: ME }))).blocked, 'self-target');
      const b = shape1();
      const rb = await deleteComment(b.api, P('delete', { ...hid, authorUid: '9001' }));
      assert.equal(rb.blocked, 'target-not-found');
      assert.match(rb.detail, /作者是 9666/);
      const c = shape1({ hidden: [rp(104, { root: 300, parent: 300, mid: '9666' })] });
      assert.equal((await deleteComment(c.api, P('delete', hid))).blocked, 'target-not-found');
      assert.equal(a.posts.length + b.posts.length + c.posts.length, 0);
    });

    test('回读：接口说成功但 fulllist 里还在 → found:false；回读时 fulllist 读不全 → found:false；都只调一次', async () => {
      const f = shape1({ delEffective: false });
      const r = await deleteComment(f.api, P('delete', hid));
      assert.deepEqual([r.sendAttempted, r.readBack.found, f.posts.length], [true, false, 1]);
      assert.match(r.readBack.detail, /还在/);
      let after = false;
      const g = shape2({ fulllist: (u, all) => ({ code: 0, data: { page: { total: after ? all.length + 1 : all.length }, list: all.length ? all : null } }) });
      const post = g.api.post;
      g.api.post = async (...a) => { after = true; return post(...a); };
      const r2 = await deleteComment(g.api, P('delete', hid));
      assert.deepEqual([r2.sendAttempted, r2.readBack.found, g.posts.length], [true, false, 1]);
      assert.match(r2.readBack.detail, /确认不了/);
    });

    test('R1 Codex-1：回读时翻页挪了位（total 不变、无重复，但刚好漏掉还在的目标）→ found:false；作品下来了新评论也 found:false', async () => {
      // 作品 40 条（rpid 60..21，新到旧），目标 40 是第 2 页第 1 条，被隐藏、一直没删掉（delEffective:false）
      const others = Array.from({ length: 39 }, (_, i) => ({ ...rp(60 - i - (60 - i <= 40 ? 1 : 0), { root: 300, parent: 300 }), oid: 555 }));
      const target = { ...rp(40, { root: 100, parent: 100, mid: '9666' }), oid: 555 };
      const before = [...others.slice(0, 20), target, ...others.slice(20)];
      const tgt = { ...hid, commentId: '40' };
      // 回读：第 1 页照旧；第 2 页时列表挪了一位：目标被挤到第 1 页（已读过），第 2 页末尾多了一条新的 20
      const drift = [...others.slice(0, 20), ...others.slice(20), { ...rp(20, { root: 300, parent: 300 }), oid: 555 }];
      let sent = false;
      const page = (list, pn) => list.slice((pn - 1) * 20, pn * 20);
      const f = shape2({ hidden: [target], delEffective: false,
        fulllist: (u) => { const pn = Number(u.searchParams.get('pn')); return { code: 0, data: { page: { total: 40 }, list: page(sent && pn === 2 ? drift : before, pn) } }; } });
      const post = f.api.post;
      f.api.post = async (...a) => { sent = true; return post(...a); };
      const r = await deleteComment(f.api, P('delete', tgt));
      assert.deepEqual([r.sendAttempted, r.readBack.found, f.posts.length], [true, false, 1], r.readBack.detail);
      assert.match(r.readBack.detail, /别的变化/);
      // 真删掉了，但同时作品下来了一条新评论 → 也确认不了，不猜
      const g = shape1({ fulllist: (u, all) => { const list = g.posts.length ? [{ ...rp(999, { root: 300, parent: 300 }), oid: 555 }, ...all] : all; return { code: 0, data: { page: { total: list.length }, list } }; } });
      const r2 = await deleteComment(g.api, P('delete', hid));
      assert.deepEqual([r2.sendAttempted, r2.readBack.found], [true, false]);
      assert.match(r2.readBack.detail, /多了 1 条/);
    });

    test('R2 Codex-1（fulllist）：回读第 1 页是旧内容配新 total、前面删了一条让目标挪进读过的页 → 这一遍集合正好等于发前减去目标，第二遍对不上 → found:false', async () => {
      // 作品 40 条，A=60 在第 1 页，目标 40 在第 2 页第 1 条；reply/del 没生效。回读第一遍读第 1 页时 A 刚被别人删掉：
      // 第 1 页给的还是旧内容（含 A），total 已经是 39；第 2 页按删后的列表给，目标挪到了第 1 页，被漏掉
      const ids = Array.from({ length: 40 }, (_, i) => 60 - i);
      const item = (id) => (id === 40 ? { ...rp(40, { root: 100, parent: 100, mid: '9666' }), oid: 555 } : { ...rp(id, { root: 300, parent: 300 }), oid: 555 });
      const before = ids.map(item), afterDel = ids.filter((id) => id !== 60).map(item);
      let reads = 0;
      const page = (list, pn) => list.slice((pn - 1) * 20, pn * 20);
      const f = shape2({ hidden: [item(40)], delEffective: false, fulllist: (u) => {
        const pn = Number(u.searchParams.get('pn'));
        if (!f.posts.length) return { code: 0, data: { page: { total: 40 }, list: page(before, pn) } };
        reads++;
        return { code: 0, data: { page: { total: 39 }, list: reads === 1 ? page(before, pn) : page(afterDel, pn) } };
      } });
      const r = await deleteComment(f.api, P('delete', { ...hid, commentId: '40' }));
      assert.deepEqual([r.sendAttempted, r.readBack.found, f.posts.length], [true, false, 1], r.readBack.detail);
      assert.match(r.readBack.detail, /还在|不一样/);
    });

    test('reply/reply 定位得到的楼中楼照旧走邻居回读，不读 up/fulllist', async () => {
      const f = fakeBili();
      const r = await deleteComment(f.api, P('delete', sub));
      assert.equal(r.readBack.found, true);
      assert.equal(fullGets(f), 0);
    });
  });
});

// 2026-11-23 真实现象：楼中楼的 rpid 不跟时间走，reply/reply 一页内可以乱序，这时不能二分，也不能用邻居证据
describe('reply/reply 乱序的楼（改走 up/fulllist）', () => {
  const reply = (id, mid = '9100') => rp(id, { root: 100, parent: 100, mid });
  const replies = (ids) => ids.map((id) => reply(id));
  const asc = (from, n, step = 1) => Array.from({ length: n }, (_, i) => from + i * step);
  const messy = (extra = {}) => fakeBili({ threads: { 100: { root: rp(100), replies: replies([105, 103, 106]) } },
    hidden: [rp(104, { root: 100, parent: 105, mid: '9666' })], ...extra });
  const target = { commentId: '104', workId: 'BV1xx', parentId: '105', rootId: '100', authorUid: '9666' };
  const fullGets = (f) => f.gets.filter((x) => x === '/x/v2/reply/up/fulllist').length;

  test('乱序、fulllist 有目标 → 只调一次删除，回读 found', async () => {
    const f = messy();
    const r = await deleteComment(f.api, P('delete', target));
    assert.equal(r.readBack.found, true, r.readBack.detail);
    assert.match(r.readBack.detail, /up\/fulllist/);
    assert.equal(f.posts.length, 1);
    assert.equal(fullGets(f), 3);   // 发前一遍、发后两遍
  });

  test('乱序、fulllist 没有 → target-not-found，不删', async () => {
    const f = messy({ hidden: [] });
    const r = await deleteComment(f.api, P('delete', target));
    assert.deepEqual([r.blocked, r.sendAttempted, f.posts.length], ['target-not-found', false, 0]);
  });

  test('乱序、fulllist 读不全 → thread-incomplete，不删', async () => {
    const f = messy({ fulllist: (_u, all) => ({ code: 0, data: { page: { total: all.length + 1 }, list: all } }) });
    const r = await deleteComment(f.api, P('delete', target));
    assert.deepEqual([r.blocked, r.sendAttempted, f.posts.length], ['thread-incomplete', false, 0]);
  });

  test('乱序、fulllist 里楼或作者对不上 → 不删', async () => {
    const wrongRoot = messy({ hidden: [rp(104, { root: 200, parent: 200, mid: '9666' })] });
    assert.equal((await deleteComment(wrongRoot.api, P('delete', target))).blocked, 'target-not-found');
    const wrongAuthor = messy({ hidden: [rp(104, { root: 100, parent: 105, mid: '9777' })] });
    assert.equal((await deleteComment(wrongAuthor.api, P('delete', target))).blocked, 'target-not-found');
    const self = messy({ hidden: [rp(104, { root: 100, parent: 105, mid: ME })] });
    assert.equal((await deleteComment(self.api, P('delete', { ...target, authorUid: ME }))).blocked, 'self-target');
    assert.equal(wrongRoot.posts.length + wrongAuthor.posts.length + self.posts.length, 0);
  });

  test('第 2 页才乱序 → 同样改走 fulllist', async () => {
    const f = fakeBili({ threads: { 100: { root: rp(100), replies: replies([...asc(1000, 20), ...asc(1020, 20).reverse()]) } } });
    const r = await deleteComment(f.api, P('delete', { ...target, commentId: '1030', authorUid: '9100' }));
    assert.equal(r.readBack.found, true, r.readBack.detail);
    assert.match(r.readBack.detail, /up\/fulllist/);
    assert.equal(f.posts.length, 1);
  });

  test('目标所在页有序、取邻居的下一页乱序 → 不用邻居证据，改走 fulllist', async () => {
    const f = fakeBili({ threads: { 100: { root: rp(100), replies: replies([...asc(1000, 20), 1025, 1021, 1023]) } } });
    const r = await deleteComment(f.api, P('delete', { ...target, commentId: '1019', authorUid: '9100' }));
    assert.equal(r.readBack.found, true, r.readBack.detail);
    assert.match(r.readBack.detail, /up\/fulllist/);
  });

  test('每页各自有序、跨页倒退 → 不用邻居证据，改走 fulllist', async () => {
    const f = fakeBili({ threads: { 100: { root: rp(100), replies: replies([...asc(1000, 20, 2), ...asc(1001, 5, 2)]) } } });
    const r = await deleteComment(f.api, P('delete', { ...target, commentId: '1038', authorUid: '9100' }));
    assert.equal(r.readBack.found, true, r.readBack.detail);
    assert.match(r.readBack.detail, /up\/fulllist/);
  });

  test('删后 fulllist 还有别的变化 → found=false，只调一次', async () => {
    const f = messy();
    const post = f.api.post;
    f.api.post = async (url, form, c) => { const x = await post(url, form, c); f.st.hidden.push(rp(99, { root: 100, parent: 100 })); return x; };
    const r = await deleteComment(f.api, P('delete', target));
    assert.equal(r.readBack.found, false);
    assert.match(r.readBack.detail, /别的变化/);
    assert.equal(f.posts.length, 1);
  });

  test('发前有序、发后 reply/reply 变乱序 → 确认不了（found=false），不猜成功', async () => {
    const f = fakeBili({ threads: { 100: { root: rp(100), replies: replies([101, 102, 103]) } } });
    const post = f.api.post;
    f.api.post = async (url, form, c) => { const x = await post(url, form, c); f.st.threads[100].replies.reverse(); return x; };
    const r = await deleteComment(f.api, P('delete', { ...target, commentId: '102', authorUid: '9100' }));
    assert.equal(r.readBack.found, false);
    assert.match(r.readBack.detail, /rpid/);
    assert.equal(f.posts.length, 1);
  });

  for (const authorUid of [null, undefined, '']) {
    test(`乱序、预期作者是 ${JSON.stringify(authorUid) ?? 'undefined'} → 核对不了作者，不删`, async () => {
      const f = messy();
      const r = await deleteComment(f.api, P('delete', { ...target, authorUid }));
      assert.deepEqual([r.blocked, r.sendAttempted, f.posts.length], ['target-not-found', false, 0]);
    });
  }

  test('每页有序、跨页倒退且目标在没细看的前一页：删除没生效 → 回读不能报 found', async () => {
    const f = fakeBili({ delEffective: false, threads: { 100: { root: rp(100), replies: replies(asc(101, 60)) } } });
    const post = f.api.post;
    f.api.post = async (url, form, c) => {
      const x = await post(url, form, c);
      f.st.threads[100].replies = replies([...asc(101, 19), 130, ...asc(120, 10), ...asc(131, 30)]);
      return x;
    };
    const r = await deleteComment(f.api, P('delete', { ...target, commentId: '130', authorUid: '9100' }));
    assert.equal(r.readBack.found, false, r.readBack.detail);
    assert.equal(f.posts.length, 1);
  });

  test('回读二分途中发现跨页倒退，下一页再返回 12006 → 不能盖过乱序，found=false', async () => {
    const f = fakeBili({ delEffective: false, threads: { 100: { root: rp(100), replies: replies(asc(101, 100)) } } });
    const get = f.api.get;
    f.api.get = async (url) => {
      const j = await get(url);
      if (!f.posts.length || !url.includes('reply/reply')) return j;
      const pn = Number(new URL(url).searchParams.get('pn'));
      if (pn === 4) return { code: 12006, message: '没有该评论', data: null };
      if (pn === 1) j.data.replies = replies([...asc(101, 19), 190]);
      if (pn === 3) j.data.replies = replies(asc(141, 20));
      return j;
    };
    const r = await deleteComment(f.api, P('delete', { ...target, commentId: '171', authorUid: '9100' }));
    assert.equal(r.readBack.found, false, r.readBack.detail);
    assert.equal(f.posts.length, 1);
  });

  test('发前二分发现跨页倒退、目标所在页又少给 → 仍改走 fulllist，不停在 thread-incomplete', async () => {
    const f = fakeBili({ threads: { 100: { root: rp(100), replies: replies(asc(101, 100)) } } });
    const get = f.api.get;
    f.api.get = async (url) => {
      const j = await get(url);
      if (f.posts.length || !url.includes('reply/reply')) return j;
      const pn = Number(new URL(url).searchParams.get('pn'));
      if (pn === 1) j.data.replies = replies([...asc(101, 19), 190]);
      if (pn === 3) j.data.replies = replies(asc(141, 15));
      return j;
    };
    const r = await deleteComment(f.api, P('delete', { ...target, commentId: '150', authorUid: '9100' }));
    assert.equal(r.sendAttempted, true, r.detail);
    assert.equal(r.readBack.found, true, r.readBack.detail);
    assert.match(r.readBack.detail, /up\/fulllist/);
    assert.equal(f.posts.length, 1);
  });

  test('删一楼、page(1) 乱序 → 仍然不删，也不改走 fulllist', async () => {
    const f = messy();
    const r = await deleteComment(f.api, P('delete', { ...root }));
    assert.deepEqual([r.blocked, r.sendAttempted, f.posts.length, fullGets(f)], ['thread-incomplete', false, 0, 0]);
  });
});

describe('B站 block（假接口）', () => {
  test('拉黑：relation/modify act=5 只调一次，回读 attribute 128 → found', async () => {
    const f = fakeBili();
    const r = await block(f.api, P('block', { mid: '9001', via: 'comment' }));
    assert.deepEqual(r.readBack, { found: true, count: 1, nativeId: '9001' });
    assert.equal(f.posts.length, 1);
    assert.deepEqual({ ...f.posts[0].form }, { fid: '9001', act: '5', re_src: '11' });
    assert.deepEqual(f.posts[0].csrfFields, ['csrf']);
  });

  test('绝不拉黑我自己：mid 是登录账号或登记过的本平台账号 → self-target，连 x/relation 都不读', async () => {
    const f = fakeBili();
    assert.equal((await block(f.api, P('block', { mid: ME }))).blocked, 'self-target');
    assert.equal((await block(f.api, P('block', { mid: '5550001' }, { selfUids: [ME, '5550001'] }))).blocked, 'self-target');
    assert.equal(f.posts.length, 0);
    assert.ok(!f.gets.includes('/x/relation'));
  });

  test('已经拉黑了 → already-blocked，不调接口；x/relation 读不到 → precheck-error', async () => {
    const f = fakeBili({ relations: { 9001: 128 } });
    assert.equal((await block(f.api, P('block', { mid: '9001' }))).blocked, 'already-blocked');
    const g = fakeBili({ relations: {} });
    assert.equal((await block(g.api, P('block', { mid: '9001' }))).blocked, 'precheck-error');
    assert.equal(f.posts.length + g.posts.length, 0);
  });

  test('接口说成功但回读不是 128 → found:false；接口报错 → sendError', async () => {
    const f = fakeBili({ modifyEffective: false });
    const r = await block(f.api, P('block', { mid: '9001' }));
    assert.deepEqual([r.sendAttempted, r.readBack.found], [true, false]);
    assert.match(r.readBack.detail, /attribute=0/);
    const g = fakeBili({ modifyCode: 22120 });
    assert.match((await block(g.api, P('block', { mid: '9001' }))).sendError, /22120/);
    assert.equal(f.posts.length, 1);
  });

  test('G-7：x/relation 的 attribute 是 null / 空串 → precheck-error，不当成「没拉黑」', async () => {
    for (const bad of [null, '', false]) {
      const f = fakeBili();
      const get = f.api.get;
      f.api.get = async (url) => (url.includes('/x/relation') ? { code: 0, data: { mid: 9001, attribute: bad } } : get(url));
      assert.equal((await block(f.api, P('block', { mid: '9001' }))).blocked, 'precheck-error', String(bad));
      assert.equal(f.posts.length, 0);
    }
  });

  test('mid 不是数字 → target-not-found，不调接口', async () => {
    const f = fakeBili();
    assert.equal((await block(f.api, P('block', { mid: 'abc' }))).blocked, 'target-not-found');
    assert.equal(f.posts.length, 0);
  });
});

describe('B站 deleteConversation（假接口）', () => {
  const C = (id) => P('deleteConversation', { conversationId: id, peerUid: id });

  test('删会话：remove_session 只调一次（talker_id、session_type=1，csrf 两个字段由页面填），回读列表翻完没有了 → found', async () => {
    const f = fakeBili();
    const r = await deleteConversation(f.api, C('777'));
    assert.deepEqual(r.readBack, { found: true, count: 1, nativeId: '777' });
    assert.equal(f.posts.length, 1);
    assert.deepEqual({ ...f.posts[0].form }, { talker_id: '777', session_type: '1', build: '0', mobi_app: 'web' });
    assert.deepEqual(f.posts[0].csrfFields, ['csrf', 'csrf_token']);
  });

  test('翻页找会话：在第二页也能找到', async () => {
    const f = fakeBili({ pageSize: 1 });
    const r = await deleteConversation(f.api, C('888'));
    assert.equal(r.readBack.found, true);
  });

  test('会话已不在列表里 → already-gone；会话对象是我自己 → self-target；都不调接口', async () => {
    const f = fakeBili();
    assert.equal((await deleteConversation(f.api, C('999'))).blocked, 'already-gone');
    assert.equal((await deleteConversation(f.api, C(ME))).blocked, 'self-target');
    assert.equal(f.posts.length, 0);
  });

  test('G-B3：目标在第 1 页、但列表超过 50 页翻不完 → list-incomplete，不调接口（删了也确认不了）', async () => {
    const sessions = [{ talker_id: 777, session_type: 1, session_ts: 1000 }, ...Array.from({ length: 60 }, (_, i) => ({ talker_id: 2000 + i, session_type: 1, session_ts: 900 - i }))];
    const f = fakeBili({ sessions, pageSize: 1 });
    assert.equal((await deleteConversation(f.api, C('777'))).blocked, 'list-incomplete');
    assert.equal(f.posts.length, 0);
  });

  test('列表超过 50 页翻不完、没找到 → list-incomplete，不调接口', async () => {
    const sessions = Array.from({ length: 60 }, (_, i) => ({ talker_id: 1000 + i, session_type: 1, session_ts: 100 - i }));
    const f = fakeBili({ sessions, pageSize: 1 });
    assert.equal((await deleteConversation(f.api, C('777'))).blocked, 'list-incomplete');
    assert.equal(f.posts.length, 0);
  });

  test('X-B3：get_sessions 给了空页却 has_more=1 → 翻不完：发前 list-incomplete；回读不算删掉', async () => {
    const f = fakeBili();
    const get = f.api.get;
    f.api.get = async (url) => (url.includes('get_sessions') ? { code: 0, data: { session_list: [], has_more: 1 } } : get(url));
    assert.equal((await deleteConversation(f.api, P('deleteConversation', { conversationId: '777' }))).blocked, 'list-incomplete');
    assert.equal(f.posts.length, 0);
    const g = fakeBili();
    const get2 = g.api.get;
    g.api.get = async (url) => (url.includes('get_sessions') && g.posts.length ? { code: 0, data: { session_list: [], has_more: 1 } } : get2(url));
    const r = await deleteConversation(g.api, P('deleteConversation', { conversationId: '777' }));
    assert.deepEqual([r.sendAttempted, r.readBack.found], [true, false]);
  });

  const GROUPS = ['1', '2', '5', '8'];

  test('分组：发前、发后都读同一套分组（1 用户与系统、2 未关注人、5 被拦截、8 陌生人）', async () => {
    const f = fakeBili();
    await deleteConversation(f.api, C('777'));
    assert.deepEqual([...new Set(f.sessionTypes)].sort(), GROUPS);
    assert.deepEqual(f.sessionTypes, [...GROUPS, ...GROUPS]);
  });

  test('回读在某一组里还看得到会话 → 不再读后面几组，found:false', async () => {
    const f = fakeBili({ removeEffective: false });
    const r = await deleteConversation(f.api, C('777'));
    assert.equal(r.readBack.found, false);
    assert.deepEqual(f.sessionTypes, [...GROUPS, '1']);
  });

  for (const [g, name] of [['2', '未关注人'], ['5', '被拦截'], ['8', '陌生人']]) {
    test(`会话只在「${name}」分组（session_type=${g}）里 → 找得到，删掉后回读各组都没有 → found`, async () => {
      const f = fakeBili({ groups: { 1: [{ talker_id: 888, session_type: 1, session_ts: 2 }], [g]: [{ talker_id: 13030183, session_type: 1, session_ts: 5 }] } });
      const r = await deleteConversation(f.api, C('13030183'));
      assert.equal(r.sendAttempted, true);
      assert.deepEqual(r.readBack, { found: true, count: 1, nativeId: '13030183' });
      assert.deepEqual({ ...f.posts[0].form }, { talker_id: '13030183', session_type: '1', build: '0', mobi_app: 'web' });
    });
  }

  test('哪一组都没有 → already-gone；detail 写明读了哪些分组', async () => {
    const f = fakeBili({ groups: { 1: [{ talker_id: 888, session_type: 1, session_ts: 2 }], 2: [], 5: [], 8: [] } });
    const r = await deleteConversation(f.api, C('13030183'));
    assert.deepEqual([r.blocked, r.sendAttempted], ['already-gone', false]);
    assert.match(r.detail, /未关注人/);
    assert.match(r.detail, /被拦截/);
    assert.equal(f.posts.length, 0);
  });

  test('某一组读失败 → precheck-error（不当成不在），不调接口', async () => {
    const f = fakeBili({ groupError: { 5: true } });
    const r = await deleteConversation(f.api, C('13030183'));
    assert.deepEqual([r.blocked, r.sendAttempted], ['precheck-error', false]);
    assert.match(r.detail, /session_type=5/);
    assert.equal(f.posts.length, 0);
  });

  test('某一组翻不完 → list-incomplete，不调接口', async () => {
    const f = fakeBili({ pageSize: 1, groups: { 1: [{ talker_id: 777, session_type: 1, session_ts: 3 }], 2: Array.from({ length: 60 }, (_, i) => ({ talker_id: 3000 + i, session_type: 1, session_ts: 100 - i })) } });
    const r = await deleteConversation(f.api, C('777'));
    assert.deepEqual([r.blocked, r.sendAttempted], ['list-incomplete', false]);
    assert.match(r.detail, /session_type=2/);
  });

  test('回读：1 组里没了，但被拦截组里还在 → found:false（needs_readback）', async () => {
    const f = fakeBili({ groups: { 1: [{ talker_id: 777, session_type: 1, session_ts: 3 }], 5: [{ talker_id: 777, session_type: 1, session_ts: 3 }] }, removeKeeps: ['5'] });
    const r = await deleteConversation(f.api, C('777'));
    assert.deepEqual([r.sendAttempted, r.readBack.found], [true, false]);
    assert.match(r.readBack.detail, /session_type=5/);
  });

  test('R1 Gemini-5：四组每组都 49 页 → 一次扫描总页数有上限，报 list-incomplete，不调接口；第一组翻不完就不再读后面几组', async () => {
    const grp = (base) => Array.from({ length: 49 }, (_, i) => ({ talker_id: base + i, session_type: 1, session_ts: 1000 - i }));
    const f = fakeBili({ pageSize: 1, groups: { 1: [{ talker_id: 777, session_type: 1, session_ts: 2000 }, ...grp(3000)], 2: grp(4000), 5: grp(5000), 8: grp(6000) } });
    const r = await deleteConversation(f.api, C('777'));
    assert.deepEqual([r.blocked, r.sendAttempted], ['list-incomplete', false]);
    assert.ok(f.sessionTypes.length <= 50, `读了 ${f.sessionTypes.length} 页`);
    assert.deepEqual([...new Set(f.sessionTypes)], ['1']);
    assert.equal(f.posts.length, 0);
  });

  test('R2 Codex-2：翻页游标往新的方向走、不是数字、页内不是从新到旧 → list-incomplete（不当成翻完了），不调接口', async () => {
    const bad = [
      (end) => (end == null ? [[{ talker_id: 888, session_type: 1, session_ts: 100 }], 1] : [[{ talker_id: 999, session_type: 1, session_ts: 200 }], 0]),
      (end) => (end == null ? [[{ talker_id: 888, session_type: 1, session_ts: 'abc' }], 1] : [[], 0]),
      (end) => (end == null ? [[{ talker_id: 888, session_type: 1, session_ts: 1 }, { talker_id: 889, session_type: 1, session_ts: 5 }], 1] : [[], 0]),
    ];
    for (const [k, gen] of bad.entries()) {
      const f = fakeBili();
      const get = f.api.get;
      f.api.get = async (url) => {
        const u = new URL(url);
        if (u.pathname !== '/session_svr/v1/session_svr/get_sessions') return get(url);
        f.sessionTypes.push(u.searchParams.get('session_type'));
        if (u.searchParams.get('session_type') !== '1') return { code: 0, data: { session_list: [], has_more: 0 } };
        const [list, more] = gen(u.searchParams.get('end_ts'));
        return { code: 0, data: { session_list: list, has_more: more } };
      };
      const r = await deleteConversation(f.api, C('777'));
      assert.deepEqual([r.blocked, r.sendAttempted], ['list-incomplete', false], `第 ${k + 1} 种`);
      assert.equal(f.posts.length, 0);
    }
  });

  test('R3 Codex-2：翻页游标是 0 → 下一页照样带 end_ts=0，不会回到第一页', async () => {
    const f = fakeBili();
    const ends = [];
    f.api.get = async (url) => {
      const u = new URL(url);
      if (u.pathname === '/x/web-interface/nav') return { code: 0, data: { isLogin: true, mid: Number(ME) } };
      const type = u.searchParams.get('session_type'), end = u.searchParams.get('end_ts');
      if (type !== '1') return { code: 0, data: { session_list: [], has_more: 0 } };
      ends.push(end);
      if (end == null) return { code: 0, data: { session_list: [{ talker_id: 888, session_type: 1, session_ts: 1 }], has_more: 1 } };
      if (end === '1') return { code: 0, data: { session_list: [{ talker_id: 889, session_type: 1, session_ts: 0 }], has_more: 1 } };
      return { code: 0, data: { session_list: [], has_more: 0 } };
    };
    const r = await deleteConversation(f.api, C('777'));
    assert.deepEqual(ends, [null, '1', '0']);
    assert.deepEqual([r.blocked, r.sendAttempted], ['already-gone', false]);
  });

  test('R1 Codex-2：会话条目缺 session_type → precheck-error，不当成用户会话、不调接口', async () => {
    for (const g of ['1', '5']) {
      const f = fakeBili({ groups: { [g]: [{ talker_id: 777, session_ts: 3 }] } });
      const r = await deleteConversation(f.api, C('777'));
      assert.deepEqual([r.blocked, r.sendAttempted], ['precheck-error', false], g);
      assert.match(r.detail, /缺 session_type/);
      assert.equal(f.posts.length, 0);
    }
  });

  test('同一个 talker_id 只作为粉丝团（session_type=2）出现 → 不算这个用户会话 → already-gone', async () => {
    const f = fakeBili({ groups: { 1: [{ talker_id: 777, session_type: 2, session_ts: 3 }] } });
    assert.equal((await deleteConversation(f.api, C('777'))).blocked, 'already-gone');
    assert.equal(f.posts.length, 0);
  });

  test('接口说成功但会话还在 → found:false；接口报错 → sendError', async () => {
    const f = fakeBili({ removeEffective: false });
    const r = await deleteConversation(f.api, C('777'));
    assert.equal(r.readBack.found, false);
    assert.match(r.readBack.detail, /^回读时会话还在列表里（session_type=1/);
    const g = fakeBili({ removeCode: -400 });
    assert.match((await deleteConversation(g.api, C('777'))).sendError, /-400/);
  });
});

test('runInSpace 打开页面就出错 → precheck-error、sendAttempted:false（不抛错）', async () => {
  const r = await runInSpace({ pages: async () => { throw new Error('导航超时'); } }, P('delete', sub));
  assert.deepEqual([r.blocked, r.sendAttempted], ['precheck-error', false]);
});
