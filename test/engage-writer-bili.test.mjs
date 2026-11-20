// B站写入适配器（回复评论、发私信）对假 B站接口：不起浏览器、不连任何真实地址。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { reply, sendDM } from '../src/ops/engage/writers/bili.mjs';

const ME = '478358005';
const member = (mid, uname) => ({ mid, uname });
const rp = (rpid, o = {}) => ({ rpid, rpid_str: String(rpid), root: o.root ?? 0, parent: o.parent ?? 0, parent_str: String(o.parent ?? 0),
  member: member(o.mid ?? '9001', o.uname ?? '甲'), content: { message: o.text ?? `评论${rpid}` } });

/** 假 B站：nav、view、reply/reply、reply/add、fetch_session_msgs、send_msg。posts 记下所有写请求（不含 csrf 值）。 */
function fakeBili(o = {}) {
  const st = {
    login: o.login ?? true, mid: o.mid ?? ME,
    threads: o.threads ?? { 100: { root: rp(100, { uname: '甲' }), replies: [rp(101, { root: 100, parent: 100, mid: '9002', uname: '乙' })] } },
    addCode: o.addCode ?? 0, addVisible: o.addVisible ?? true, addThrows: o.addThrows ?? false,
    msgs: o.msgs ?? { 777: [{ msg_seqno: 1, sender_uid: 777, msg_type: 1, content: JSON.stringify({ content: '在吗' }), timestamp: 1763500000 }] },
    sendCode: o.sendCode ?? 0, sendVisible: o.sendVisible ?? true, readbackDup: o.readbackDup ?? false,
  };
  const posts = [];
  let seq = 1000;
  const api = {
    sleep: async () => {},
    async get(url) {
      const u = new URL(url);
      const q = (k) => u.searchParams.get(k);
      if (u.pathname === '/x/web-interface/nav') return st.login ? { code: 0, data: { isLogin: true, mid: Number(st.mid) } } : { code: -101, data: { isLogin: false } };
      if (u.pathname === '/x/web-interface/view') return q('bvid') === 'BV1xx' ? { code: 0, data: { aid: 555, bvid: 'BV1xx' } } : { code: -404, message: '啥都木有' };
      if (u.pathname === '/x/v2/reply/reply') {
        assert.equal(q('oid'), '555');
        const t = st.threads[q('root')];
        if (!t) return { code: 12022, message: '已经被删除了' };
        const pn = Number(q('pn'));
        return { code: 0, data: { page: { count: t.replies.length, num: pn, size: 20 }, root: t.root, replies: t.replies.slice((pn - 1) * 20, pn * 20) } };
      }
      if (u.pathname === '/svr_sync/v1/svr_sync/fetch_session_msgs') {
        const m = st.msgs[q('talker_id')];
        return m ? { code: 0, data: { messages: [...m].reverse() } } : { code: 1, message: '会话不存在' };
      }
      throw new Error(`假 B站没有这个 GET：${u.pathname}`);
    },
    async post(url, form, csrfFields) {
      const u = new URL(url);
      posts.push({ path: u.pathname, form, csrfFields });
      if (u.pathname === '/x/v2/reply/add') {
        if (st.addThrows) throw new Error('网络断了');
        if (st.addCode !== 0) return { code: st.addCode, message: '被拦了' };
        const rpid = ++seq;
        const n = st.readbackDup ? 2 : 1;
        if (st.addVisible) for (let i = 0; i < n; i++) st.threads[form.root].replies.push(rp(rpid + i, { root: Number(form.root), parent: Number(form.parent), mid: st.mid, uname: '我', text: form.message }));
        return { code: 0, data: { rpid, rpid_str: String(rpid) } };
      }
      if (u.pathname === '/web_im/v1/web_im/send_msg') {
        if (st.sendCode !== 0) return { code: st.sendCode, message: '发不了' };
        const talker = form['msg[receiver_id]'];
        if (st.sendVisible) st.msgs[talker].push({ msg_seqno: ++seq, sender_uid: Number(st.mid), msg_type: 1, content: form['msg[content]'], timestamp: Number(form['msg[timestamp]']), msg_key: '7400000000000000001' });
        return { code: 0, data: { msg_key: '7400000000000000001' } };
      }
      throw new Error(`假 B站没有这个 POST：${u.pathname}`);
    },
  };
  return { api, posts, st };
}

const rootTarget = { commentId: '100', workId: 'BV1xx', parentId: null, rootId: '100', authorUid: '9001', authorNickname: '甲', commentText: '评论100' };
const subTarget = { commentId: '101', workId: 'BV1xx', parentId: '100', rootId: '100', authorUid: '9002', authorNickname: '乙', commentText: '评论101' };
const P = (target, extra = {}) => ({ op: 'reply', uid: ME, text: '谢谢', target, ...extra });
const D = (extra = {}) => ({ op: 'sendDM', uid: ME, text: '你好', target: { conversationId: '777', peerUid: '777', peerNickname: '丙' }, ...extra });

describe('B站 reply（假接口）', () => {
  test('回复一楼：reply/add 只调一次，参数 root/parent 对，回读到 1 条 → found', async () => {
    const f = fakeBili();
    const r = await reply(f.api, P(rootTarget));
    assert.equal(r.uidSeen, ME);
    assert.equal(r.sendAttempted, true);
    assert.deepEqual(r.readBack, { found: true, count: 1, nativeId: '1001' });
    assert.equal(f.posts.length, 1);
    assert.deepEqual({ ...f.posts[0].form }, { oid: '555', type: '1', root: '100', parent: '100', message: '谢谢', plat: '1' });
    assert.deepEqual(f.posts[0].csrfFields, ['csrf']);
  });

  test('回复楼中楼：正文前加「回复 @昵称 :」，回读按加了前缀的正文数', async () => {
    const f = fakeBili();
    const r = await reply(f.api, P(subTarget));
    assert.equal(f.posts[0].form.message, '回复 @乙 :谢谢');
    assert.equal(f.posts[0].form.parent, '101');
    assert.equal(r.readBack.found, true);
  });

  test('没登录 → loginLost；登录的不是这个账号 → uid-mismatch，都不发', async () => {
    const a = fakeBili({ login: false });
    assert.equal((await reply(a.api, P(rootTarget))).loginLost, true);
    const b = fakeBili({ mid: '123' });
    const r = await reply(b.api, P(rootTarget));
    assert.deepEqual([r.blocked, r.uidSeen, r.sendAttempted], ['uid-mismatch', '123', false]);
    assert.equal(a.posts.length + b.posts.length, 0);
  });

  test('发前重读：楼被删（12022）、楼里找不到这条 → comment-gone；已有我对它的直接回复 → already-replied；都不发', async () => {
    const gone = fakeBili({ threads: {} });
    assert.equal((await reply(gone.api, P(rootTarget))).blocked, 'comment-gone');
    const missing = fakeBili({ threads: { 100: { root: rp(100), replies: [] } } });
    assert.equal((await reply(missing.api, P(subTarget))).blocked, 'comment-gone');
    const replied = fakeBili({ threads: { 100: { root: rp(100), replies: [rp(101, { root: 100, parent: 100, mid: '9002', uname: '乙' }), rp(102, { root: 100, parent: 101, mid: ME, uname: '我', text: '回复 @乙 :早就回了' })] } } });
    assert.equal((await reply(replied.api, P(subTarget))).blocked, 'already-replied');
    // 我回的是别的楼中楼，不算回过这一条
    const other = fakeBili({ threads: { 100: { root: rp(100), replies: [rp(101, { root: 100, parent: 100, mid: '9002' }), rp(103, { root: 100, parent: 100, mid: ME })] } } });
    assert.equal((await reply(other.api, P(subTarget))).readBack.found, true);
    for (const f of [gone, missing, replied]) assert.equal(f.posts.length, 0);
  });

  test('B2：整楼超过 10 页读不全（我的旧回复可能在后面）→ thread-incomplete，不发', async () => {
    const many = Array.from({ length: 205 }, (_, i) => rp(200 + i, { root: 100, parent: 100, mid: '9100' }));
    many.push(rp(999, { root: 100, parent: 101, mid: ME, uname: '我', text: '回复 @乙 :早回过' }));
    const f = fakeBili({ threads: { 100: { root: rp(100), replies: [rp(101, { root: 100, parent: 100, mid: '9002', uname: '乙' }), ...many] } } });
    const r = await reply(f.api, P(subTarget));
    assert.deepEqual([r.blocked, r.sendAttempted], ['thread-incomplete', false]);
    assert.equal(f.posts.length, 0);
  });

  test('B4：reply/add 报错、但这期间有人用同一账号发了同样的话 → 不算发出', async () => {
    const f = fakeBili({ addCode: 12015 });
    const add = f.api.post;
    f.api.post = async (url, form, c) => { const r = await add(url, form, c); f.st.threads[100].replies.push(rp(4242, { root: 100, parent: 100, mid: ME, uname: '我', text: '谢谢' })); return r; };
    const r = await reply(f.api, P(rootTarget));
    assert.equal(r.readBack.found, false);
    assert.match(r.sendError, /12015/);
  });

  test('B4：接口给了新 rpid，回读到的那条不是它 → found:false', async () => {
    const f = fakeBili({ addVisible: false });
    const add = f.api.post;
    f.api.post = async (url, form, c) => { const r = await add(url, form, c); f.st.threads[100].replies.push(rp(4242, { root: 100, parent: 100, mid: ME, uname: '我', text: '谢谢' })); return r; };
    const r = await reply(f.api, P(rootTarget));
    assert.deepEqual([r.readBack.found, r.readBack.count], [false, 1]);
  });

  test('作品找不到 → target-not-found，不发', async () => {
    const f = fakeBili();
    const r = await reply(f.api, P({ ...rootTarget, workId: 'BVnone' }));
    assert.deepEqual([r.blocked, r.sendAttempted], ['target-not-found', false]);
  });

  test('reply/add code≠0 → sendError，sendAttempted:true', async () => {
    const f = fakeBili({ addCode: 12015 });
    const r = await reply(f.api, P(rootTarget));
    assert.equal(r.sendAttempted, true);
    assert.match(r.sendError, /12015/);
    assert.equal(r.readBack.found, false);
  });

  test('reply/add 抛错（不知道发没发）→ sendAttempted:true，照样回读，不重发', async () => {
    const f = fakeBili({ addThrows: true });
    const r = await reply(f.api, P(rootTarget));
    assert.equal(r.sendAttempted, true);
    assert.equal(r.readBack.found, false);
    assert.equal(f.posts.length, 1);
  });

  test('接口说成功但回读不到 / 回读到 2 条 → found:false', async () => {
    assert.deepEqual((await reply(fakeBili({ addVisible: false }).api, P(rootTarget))).readBack, { found: false, count: 0, nativeId: '1001' });
    assert.equal((await reply(fakeBili({ readbackDup: true }).api, P(rootTarget))).readBack.count, 2);
  });

  test('重读前出错（nav 不是 JSON 等）→ blocked precheck-error，sendAttempted:false', async () => {
    const f = fakeBili();
    f.api.get = async () => { throw new Error('GET x http=500 不是 JSON'); };
    const r = await reply(f.api, P(rootTarget));
    assert.deepEqual([r.blocked, r.sendAttempted], ['precheck-error', false]);
  });
});

describe('B站 sendDM（假接口）', () => {
  test('发出：send_msg 只调一次，content 是 JSON，csrf 两个字段由页面里填；回读到新消息 → found', async () => {
    const f = fakeBili();
    const r = await sendDM(f.api, D());
    assert.equal(r.sendAttempted, true);
    assert.deepEqual(r.readBack, { found: true, count: 1, nativeId: '7400000000000000001' });
    assert.equal(f.posts.length, 1);
    const form = f.posts[0].form;
    assert.equal(form['msg[sender_uid]'], ME);
    assert.equal(form['msg[receiver_id]'], '777');
    assert.equal(form['msg[msg_type]'], '1');
    assert.deepEqual(JSON.parse(form['msg[content]']), { content: '你好' });
    assert.deepEqual(f.posts[0].csrfFields, ['csrf', 'csrf_token']);
    assert.ok(!JSON.stringify(form).includes('bili_jct'));
  });

  test('会话最后一句已是我 → last-is-me，不发；会话读不到 → target-not-found', async () => {
    const f = fakeBili({ msgs: { 777: [{ msg_seqno: 1, sender_uid: 777, msg_type: 1, content: '{"content":"在吗"}', timestamp: 1 }, { msg_seqno: 2, sender_uid: Number(ME), msg_type: 1, content: '{"content":"在"}', timestamp: 2 }] } });
    assert.equal((await sendDM(f.api, D())).blocked, 'last-is-me');
    const g = fakeBili({ msgs: {} });
    assert.equal((await sendDM(g.api, D())).blocked, 'target-not-found');
    assert.equal(f.posts.length + g.posts.length, 0);
  });

  test('send_msg code≠0 → sendError；成功但回读不到 → found:false', async () => {
    const a = await sendDM(fakeBili({ sendCode: 21046 }).api, D());
    assert.equal(a.sendAttempted, true);
    assert.match(a.sendError, /21046/);
    const b = await sendDM(fakeBili({ sendVisible: false }).api, D());
    assert.equal(b.readBack.found, false);
  });

  test('B4：send_msg 给的 msg_key 和回读到的那条对不上 → found:false', async () => {
    const f = fakeBili({ sendVisible: false });
    const send = f.api.post;
    f.api.post = async (url, form, c) => { const r = await send(url, form, c); f.st.msgs[777].push({ msg_seqno: 5000, sender_uid: Number(ME), msg_type: 1, content: JSON.stringify({ content: '你好' }), timestamp: 9, msg_key: '1' }); return r; };
    const r = await sendDM(f.api, D());
    assert.deepEqual([r.readBack.found, r.readBack.count], [false, 1]);
  });

  test('只数这次之后的新消息：历史里有一样的话不算', async () => {
    const f = fakeBili({ msgs: { 777: [{ msg_seqno: 1, sender_uid: Number(ME), msg_type: 1, content: '{"content":"你好"}', timestamp: 1 }, { msg_seqno: 2, sender_uid: 777, msg_type: 1, content: '{"content":"在吗"}', timestamp: 2 }] } });
    const r = await sendDM(f.api, D());
    assert.deepEqual([r.readBack.found, r.readBack.count], [true, 1]);
  });
});
