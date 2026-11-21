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
    sessions: o.sessions ?? [{ talker_id: 777, session_type: 1, session_ts: 3 }, { talker_id: 888, session_type: 1, session_ts: 2 }],
    pageSize: o.pageSize ?? 20, removeCode: o.removeCode ?? 0, removeEffective: o.removeEffective ?? true,
  };
  const posts = [], gets = [];
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
        const rest = st.sessions.filter((s) => s.session_ts < end);
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
        if (st.removeEffective) st.sessions = st.sessions.filter((s) => String(s.talker_id) !== form.talker_id);
        return { code: 0, data: {} };
      }
      throw new Error(`假 B站没有这个 POST：${u.pathname}`);
    },
  };
  return { api, posts, gets, st };
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

  test('删一楼：回读整楼 12022 → found', async () => {
    const f = fakeBili();
    const r = await deleteComment(f.api, P('delete', root));
    assert.equal(r.readBack.found, true);
    assert.equal(f.posts.length, 1);
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

  test('发前重读：楼已被删、楼里已没有这条 → already-gone，不调接口', async () => {
    const gone = fakeBili({ threads: {} });
    assert.equal((await deleteComment(gone.api, P('delete', sub))).blocked, 'already-gone');
    const missing = fakeBili({ threads: { 100: { root: rp(100), replies: [] } } });
    assert.equal((await deleteComment(missing.api, P('delete', sub))).blocked, 'already-gone');
    assert.equal(gone.posts.length + missing.posts.length, 0);
  });

  test('不是我的作品 → not-my-work；作品读不到 → target-not-found；都不调接口', async () => {
    const f = fakeBili({ owner: '123' });
    assert.equal((await deleteComment(f.api, P('delete', sub))).blocked, 'not-my-work');
    const g = fakeBili();
    assert.equal((await deleteComment(g.api, P('delete', { ...sub, workId: 'BVnone' }))).blocked, 'target-not-found');
    assert.equal(f.posts.length + g.posts.length, 0);
  });

  test('楼超过 10 页读不全、没找到这条 → thread-incomplete，不调接口', async () => {
    const many = Array.from({ length: 205 }, (_, i) => rp(200 + i, { root: 100, parent: 100, mid: '9100' }));
    const f = fakeBili({ threads: { 100: { root: rp(100), replies: many } } });
    const r = await deleteComment(f.api, P('delete', { ...sub, commentId: '999' }));
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
    f.api.get = async (url) => { const j = await get(url); if (url.includes('reply/reply') && n++ === 0) j.data.replies.push(rp(101, { root: 100, parent: 100, mid: '9002' })); return j; };
    const r = await deleteComment(f.api, P('delete', sub));
    assert.equal(r.sendError, undefined);
    assert.equal(r.readBack.found, true);
  });

  test('X-B2：reply/reply 声明 count=100 却只给了 2 条（不到 20 条就停）→ 没读全：发前 thread-incomplete；回读不算删掉', async () => {
    const f = fakeBili();
    const get = f.api.get;
    f.api.get = async (url) => { const j = await get(url); if (url.includes('reply/reply') && j.data) j.data.page.count = '100'; return j; };
    const r = await deleteComment(f.api, P('delete', { ...sub, commentId: '999' }));
    assert.deepEqual([r.blocked, r.sendAttempted], ['thread-incomplete', false]);
    // 发前读全了，回读时声明的 count 对不上（空页）→ 不能说删掉了
    const g = fakeBili();
    const get2 = g.api.get;
    g.api.get = async (url) => { const j = await get2(url); if (url.includes('reply/reply') && j.data && g.posts.length) { j.data.page.count = 100; j.data.replies = []; } return j; };
    const r2 = await deleteComment(g.api, P('delete', sub));
    assert.deepEqual([r2.sendAttempted, r2.readBack.found], [true, false]);
    assert.equal(f.posts.length, 0);
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

  test('列表超过 30 页翻不完、没找到 → list-incomplete，不调接口', async () => {
    const sessions = Array.from({ length: 40 }, (_, i) => ({ talker_id: 1000 + i, session_type: 1, session_ts: 100 - i }));
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

  test('接口说成功但会话还在 → found:false；接口报错 → sendError', async () => {
    const f = fakeBili({ removeEffective: false });
    const r = await deleteConversation(f.api, C('777'));
    assert.deepEqual([r.readBack.found, r.readBack.detail], [false, '回读时会话还在列表里']);
    const g = fakeBili({ removeCode: -400 });
    assert.match((await deleteConversation(g.api, C('777'))).sendError, /-400/);
  });
});

test('runInSpace 打开页面就出错 → precheck-error、sendAttempted:false（不抛错）', async () => {
  const r = await runInSpace({ pages: async () => { throw new Error('导航超时'); } }, P('delete', sub));
  assert.deepEqual([r.blocked, r.sendAttempted], ['precheck-error', false]);
});
