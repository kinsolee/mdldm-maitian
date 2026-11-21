// B站处置写入脚本（删评论、拉黑、删会话）对假 B站接口：不起浏览器、不连任何真实地址、不调任何真实写接口。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deleteComment, block, deleteConversation, runInSpace } from '../src/ops/engage/writers/bili-moderate.mjs';

const ME = '478358005';
const rp = (rpid, o = {}) => ({ rpid, rpid_str: String(rpid), root: o.root ?? 0, parent: o.parent ?? 0, parent_str: String(o.parent ?? 0),
  member: { mid: o.mid ?? '9001', uname: o.uname ?? '甲' }, content: { message: o.text ?? `评论${rpid}` } });

/** 假 B站：nav、view、reply/reply、reply/del、x/relation、relation/modify、get_sessions、remove_session。posts 记下所有写请求。 */
function fakeBili(o = {}) {
  const st = {
    login: o.login ?? true, mid: o.mid ?? ME, owner: o.owner ?? ME,
    threads: o.threads ?? { 100: { root: rp(100, { mid: '9001' }), replies: [rp(101, { root: 100, parent: 100, mid: '9002' }), rp(102, { root: 100, parent: 100, mid: ME })] } },
    delCode: o.delCode ?? 0, delEffective: o.delEffective ?? true, throws: o.throws ?? null,
    relations: o.relations ?? { 9001: 0, 9002: 2 }, modifyCode: o.modifyCode ?? 0, modifyEffective: o.modifyEffective ?? true,
    // 会话按 get_sessions 的 session_type 分组：1 用户与系统、2 未关注人、5 被拦截、8 陌生人。只给 sessions 的放在 1 组
    groups: o.groups ?? { 1: o.sessions ?? [{ talker_id: 777, session_type: 1, session_ts: 3 }, { talker_id: 888, session_type: 1, session_ts: 2 }] },
    pageSize: o.pageSize ?? 20, removeCode: o.removeCode ?? 0, removeEffective: o.removeEffective ?? true,
  };
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
        if (!t) return { code: 12022, message: '已经被删除了' };
        const pn = Number(q('pn'));
        return { code: 0, data: { page: { count: t.replies.length, num: pn, size: 20 }, root: t.root, replies: t.replies.slice((pn - 1) * 20, pn * 20) } };
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

  test('大楼：目标 rpid 不在楼里 → target-not-found（不是 already-gone），不调接口', async () => {
    const f = fakeBili({ threads: bigThread() });
    for (const id of ['1001', '999', '99999']) {
      const r = await deleteComment(f.api, P('delete', { ...sub, commentId: id }));
      assert.deepEqual([r.blocked, r.sendAttempted], ['target-not-found', false], id);
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

  test('reply/reply 的一页不是按 rpid 递增 → thread-incomplete（定位不了），不调接口', async () => {
    const t = bigThread(100);
    t[100].replies.reverse();
    const f = fakeBili({ threads: t });
    const r = await deleteComment(f.api, P('delete', { ...sub, commentId: String(1000 + 50 * 3) }));
    assert.deepEqual([r.blocked, r.sendAttempted], ['thread-incomplete', false]);
    assert.equal(f.posts.length, 0);
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
