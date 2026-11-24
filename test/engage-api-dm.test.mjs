// 抖音私信页面内接口写法：页面内函数（假 document / React fiber / IM SDK）、发前重读和发后回读的护栏（假接口）、节奏、入口分流。
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { dmInPage, dmCaller, douyinDmApi } from '../src/ops/engage/writers/api-dm.mjs';
import { runApiWrite } from '../src/ops/engage/writers/api-reply.mjs';
import { runInSpace } from '../src/ops/engage/writers/douyin.mjs';
import { dmWorld, peerMsg, myMsg } from './helpers/douyin-dm-world.mjs';

const ME = '106707338905';
const TEXT = '你好，资料发你了';
const noSleep = async () => {};

function fakeTask({ uid = ME } = {}) {
  const page = { cdp: async () => ({}), goto: async () => {}, url: async () => 'https://creator.douyin.com/creator-micro/data/following/chat', evaluate: async () => true };
  return { task: { pages: async () => [page] }, plat: { api: douyinDmApi, hook: false, url: () => 'https://creator.douyin.com/x', login: async () => ({ uid }) } };
}
const params = (extra = {}) => ({ op: 'sendDM', uid: ME, text: TEXT, target: { conversationId: 'c1', peerUid: 'p1' }, timeouts: { readbackMs: 0, settleMs: 0 }, ...extra });
const run = (w, p = params(), o = {}) => { const { task, plat } = fakeTask(o); return runApiWrite(task, p, plat, { serviceCaller: async () => (w ? w.call : null), sleep: noSleep }); };

describe('抖音私信接口写法：发送和回读', () => {
  test('发送成功、回读到恰好 1 条我发的新消息 → found，nativeId 是服务端 id；发送函数只调一次', async () => {
    const w = dmWorld();
    const r = await run(w);
    assert.deepEqual([r.sendAttempted, r.via, r.readBack.found, r.readBack.count, r.readBack.nativeId], [true, 'api', true, 1, '900']);
    assert.equal(w.count('send'), 1);
    assert.ok(!('sendError' in r));
    // 诊断只有接口名、返回码、条数、耗时，不带正文
    assert.match(r.readBack.detail, /api=sendMessageWithAuth send=s1,st0,b0,ck0,fs3,id1,3ms pull=getMessagesByConversation n=2\/1\/1\/1,cov1/);
    assert.ok(!r.readBack.detail.includes('资料'));
  });

  test('发送接口说成功但回读没找到 → found:false、count 0，带诊断', async () => {
    const w = dmWorld({ send: 'silent' });
    const r = await run(w);
    assert.deepEqual([r.sendAttempted, r.readBack.found, r.readBack.count], [true, false, 0]);
    assert.match(r.readBack.detail, /诊断api v1 .*n=1\/0\/0\/0,cov1/);
    assert.equal(w.count('send'), 1);
  });

  test('发送接口报错、返回 undefined、被拒、仅自己可见、返回码类型不认识：都不算成功，只调一次，不设 sendError', async () => {
    for (const send of ['throw', 'undefined', 'rejected', 'self-visible', 'status-x', 'status-null']) {
      const w = dmWorld({ send });
      const r = await run(w);
      assert.deepEqual([r.sendAttempted, r.readBack.found, 'sendError' in r], [true, false, false], send);
      assert.equal(w.count('send'), 1, send);
      assert.match(r.readBack.detail, /api=sendMessageWithAuth/, send);
    }
  });

  test('返回码类型不认识时，回读到同一个 id 也不算回读到', async () => {
    const r = await run(dmWorld({ send: 'status-x' }));
    assert.deepEqual([r.readBack.found, r.readBack.count], [false, 1]);
    assert.match(r.readBack.detail, /b x|bx/);
  });

  test('回读拉消息出错 → found:false，detail 只有错误码', async () => {
    const w = dmWorld();
    const pull = w.call;
    let n = 0;
    w.call = async (m, a) => (m === 'pull' && ++n > 1 ? { ok: false, code: 'pull:t7' } : pull(m, a));
    const r = await run(w);
    assert.deepEqual([r.readBack.found, r.readBack.count], [false, 0]);
    assert.match(r.readBack.detail, /pull=err:pull:t7$/);
  });

  test('回读到两条序号在边界后的同文我的消息 → count 2，不算回读到', async () => {
    const w = dmWorld();
    const base = w.call;
    w.call = async (m, a) => { const r = await base(m, a); if (m === 'send') w.msgs.push(myMsg('901', 99, TEXT)); return r; };
    const r = await run(w);
    assert.deepEqual([r.readBack.found, r.readBack.count], [false, 2]);
  });

  test('边界前的同文旧消息补上了服务端 id：按序号算，不会被当成新消息', async () => {
    const old = { sid: null, mine: true, text: TEXT, idx: '1' };
    const w = dmWorld({ msgs: [old, peerMsg('102', 2)], pullAfter: (msgs) => [{ ...old, sid: '555' }, ...msgs.slice(1)] });
    const r = await run(w);
    assert.deepEqual([r.readBack.found, r.readBack.count], [true, 1]);
  });

  test('回读这一页没覆盖到发送前的边界（中间新消息超过一页）→ 不算回读到', async () => {
    const w = dmWorld({ pullAfter: (msgs) => [...Array.from({ length: 19 }, (_, i) => peerMsg(String(2000 + i), 10 + i)), { ...msgs.at(-1), idx: '30' }] });
    const base = w.call;
    w.call = async (m, a) => { const r = await base(m, a); if (m === 'pull' && w.sent) r.conv = { ...r.conv, last: { sid: '900', idx: '30', mine: true } }; return r; };
    const r = await run(w);
    assert.deepEqual([r.readBack.found, r.readBack.count], [false, 0]);
    assert.match(r.readBack.detail, /cov0/);
  });

  test('回读时有消息没有序号、或边界后有看不出是谁发的 → 不算回读到', async () => {
    const a = await run(dmWorld({ msgs: [peerMsg('100', 1), peerMsg('101', 2)], pullAfter: (msgs) => [{ ...msgs[0], idx: null }, ...msgs.slice(1)] }));
    assert.equal(a.readBack.found, false);
    assert.match(a.readBack.detail, /unsure/);
    const w = dmWorld();
    const base = w.call;
    w.call = async (m, x) => { const r = await base(m, x); if (m === 'pull' && w.sent) r.msgs = [...r.msgs.slice(0, -1), { sid: '950', mine: null, text: '?', idx: '2' }, { ...r.msgs.at(-1), idx: '3' }]; if (m === 'pull' && w.sent) r.conv = { ...r.conv, last: { sid: '900', idx: '3', mine: true } }; return r; };
    const b = await run(w);
    assert.equal(b.readBack.found, false);
    assert.match(b.readBack.detail, /unsure/);
  });

  test('回读页覆盖到边界、但没拉到最新端（拉完时会话最后一条是另一条同文的 12，页里只到 11）→ 不算回读到', async () => {
    const w = dmWorld({ msgs: [peerMsg('101', 10)] });
    const base = w.call;
    w.call = async (m, a) => { const r = await base(m, a); if (m === 'pull' && w.sent) r.conv = { ...r.conv, last: { sid: '999', idx: '12', mine: true } }; return r; };
    const r = await run(w);
    assert.deepEqual([r.readBack.found, r.readBack.count], [false, 0]);
    assert.match(r.readBack.detail, /cov1,top0/);
  });

  test('边界后另有一条我发的文字消息正文读不出来 → 不算回读到；之后补成同文 → count 2；已知的非文字消息不挡', async () => {
    const mk = (extra) => { const w = dmWorld(); const base = w.call; w.call = async (m, a) => { const r = await base(m, a); if (m === 'send') w.msgs.push({ sid: '901', mine: true, text: extra.text, idx: String(BigInt(w.msgs.at(-1).idx) + 1n), type: extra.type }); return r; }; return w; };
    const a = await run(mk({ text: null, type: 7 }));
    assert.deepEqual([a.readBack.found], [false]);
    assert.match(a.readBack.detail, /unsure/);
    const b = await run(mk({ text: null, type: null }));
    assert.equal(b.readBack.found, false);
    const c = await run(mk({ text: TEXT, type: 7 }));
    assert.deepEqual([c.readBack.found, c.readBack.count], [false, 2]);
    const d = await run(mk({ text: null, type: 27 }));
    assert.deepEqual([d.readBack.found, d.readBack.count], [true, 1]);   // 已知是图片（type 27）：不是同文候选，不挡
  });

  test('回读正文和发送原文不严格相等（少了零宽连接符）→ 不算回读到', async () => {
    const text = '👩\u200d💻 资料发你了';
    const w = dmWorld({ pullAfter: (msgs) => [...msgs.slice(0, -1), { ...msgs.at(-1), text: text.replace('\u200d', '') }] });
    const r = await run(w, params({ text }));
    assert.deepEqual([r.readBack.found, r.readBack.count], [false, 0]);
  });

  test('会话序号超过 2^53 时照常按大整数比较', async () => {
    const r = await run(dmWorld({ msgs: [peerMsg('101', '9007199254740993')] }));
    assert.deepEqual([r.readBack.found, r.readBack.count], [true, 1]);
  });

  test('发前重读之后会话最后一句变了 → 页面不发（last-changed）→ cannot-send，没尝试发送', async () => {
    const w = dmWorld({ send: 'last-changed' });
    const r = await run(w);
    assert.deepEqual([r.blocked, r.sendAttempted], ['cannot-send', false]);
    assert.equal(w.calls.find(([m]) => m === 'send')[1].lastSid, '101');
  });

  test('send 时页面确定没调发送函数（服务没了）→ cannot-send，sendAttempted:false，不回读', async () => {
    const w = dmWorld({ send: 'notSent' });
    const r = await run(w);
    assert.deepEqual([r.blocked, r.sendAttempted, r.readBack], ['cannot-send', false, undefined]);
    assert.equal(w.count('pull'), 1);
  });

  test('send 时页面调用本身失败（不知道跑到哪一步）→ 仍按点过发送、回读不到处理', async () => {
    const w = dmWorld();
    const base = w.call;
    w.call = async (m, a) => (m === 'send' ? { ok: false, code: 'evaluate-failed' } : base(m, a));
    const r = await run(w);
    assert.deepEqual([r.sendAttempted, r.readBack.found], [true, false]);
    assert.match(r.readBack.detail, /send=err:evaluate-failed/);
  });
});

describe('抖音私信接口写法：发前重读', () => {
  test('页面私信服务找不到 → cannot-send，没发，提示关 writeDmViaApi', async () => {
    const r = await run(null);
    assert.deepEqual([r.blocked, r.sendAttempted], ['cannot-send', false]);
    assert.match(r.detail, /writeDmViaApi/);
  });

  test('会话不在列表 → target-not-found；群聊 → cannot-send；最后一句是我 → last-is-me；服务中途没了 → cannot-send；发送函数零调用', async () => {
    const cases = [
      [dmWorld({ conv: { notFound: true } }), 'target-not-found'],
      [dmWorld({ conv: { missing: true } }), 'cannot-send'],
      [dmWorld({ pull: 'vanish' }), 'cannot-send'],
      [dmWorld({ conv: { group: true } }), 'cannot-send'],
      [dmWorld({ msgs: [peerMsg('101', 1), myMsg('102', 2, '好的')] }), 'last-is-me'],
    ];
    for (const [w, want] of cases) {
      const r = await run(w);
      assert.deepEqual([r.blocked, r.sendAttempted], [want, false], want);
      assert.equal(w.count('send'), 0, want);
    }
  });

  test('没能证实本人登录（代运营登录、读不到 is_confer_login）→ cannot-send；userInfo 的 uid 不符 → uid-mismatch；都没发', async () => {
    for (const [login, want] of [[{ owner: 0 }, 'cannot-send'], [{ owner: -1 }, 'cannot-send'], [{ owner: null }, 'cannot-send'], [{ uidMatch: false }, 'uid-mismatch']]) {
      const w = dmWorld({ login });
      const r = await run(w);
      assert.deepEqual([r.blocked, r.sendAttempted, w.count('pull'), w.count('send')], [want, false, 0, 0], JSON.stringify(login));
    }
  });

  test('给了会话 id 时不按 peerUid 找别的会话', async () => {
    const w = dmWorld();
    await run(w);
    assert.deepEqual(w.calls[0][1], { conversationId: 'c1', peerUid: null, uid: ME });
  });

  test('本地记的最后一句不是我、但服务端拉到的最后一句是我 → last-is-me', async () => {
    const w = dmWorld({ msgs: [peerMsg('101', 1), myMsg('102', 2, '好的')], conv: { last: { sid: '101', idx: '1', mine: false } } });
    const base = w.call;
    w.call = async (m, a) => { const r = await base(m, a); if (m === 'pull') r.conv = { ...r.conv, last: { sid: '102', idx: '2', mine: true } }; return r; };
    const r = await run(w);
    assert.equal(r.blocked, 'last-is-me');
    assert.equal(w.count('send'), 0);
  });

  test('拉完时会话最后一条（我的 102）不在拉到的页里（页面只到对方的 101）→ precheck-error', async () => {
    const w = dmWorld({ msgs: [peerMsg('101', 1)] });
    const base = w.call;
    w.call = async (m, a) => { const r = await base(m, a); if (m === 'pull') r.conv = { ...r.conv, last: { sid: '102', idx: '2', mine: true } }; return r; };
    const r = await run(w);
    assert.deepEqual([r.blocked, w.count('send')], ['precheck-error', 0]);
  });

  test('拉到的不是最新一页、拉消息出错、最后一条没有服务端 id 或序号、看不出谁说的、空页 → precheck-error；都没发', async () => {
    const unknownAuthor = dmWorld();
    const base = unknownAuthor.call;
    unknownAuthor.call = async (m, a) => { const r = await base(m, a); if (m === 'pull') { r.msgs = r.msgs.map((x) => ({ ...x, mine: null })); r.conv = { ...r.conv, last: { ...r.conv.last, mine: null } }; } return r; };
    const noIdx = dmWorld();
    const b2 = noIdx.call;
    noIdx.call = async (m, a) => { const r = await b2(m, a); if (m === 'pull') r.conv = { ...r.conv, last: { ...r.conv.last, idx: null } }; return r; };
    const worlds = [dmWorld({ pull: 'stale' }), dmWorld({ pull: 'throw' }), dmWorld({ msgs: [{ sid: null, mine: false, text: '在吗', idx: '1' }] }), dmWorld({ msgs: [] }), unknownAuthor, noIdx];
    for (const w of worlds) {
      const r = await run(w);
      assert.deepEqual([r.blocked, r.sendAttempted, w.count('send')], ['precheck-error', false, 0]);
    }
  });

  test('超过编辑框上限 500 字（按原文计，尾部换行也算）→ text-too-long，不调接口', async () => {
    for (const text of ['字'.repeat(501), '字'.repeat(500) + '\n']) {
      const w = dmWorld();
      const r = await run(w, params({ text }));
      assert.deepEqual([r.blocked, w.calls.length], ['text-too-long', 0]);
    }
  });

  test('页面登录的不是这个账号 → uid-mismatch，不调接口', async () => {
    const w = dmWorld();
    const r = await run(w, params(), { uid: 'someone-else' });
    assert.deepEqual([r.blocked, w.calls.length], ['uid-mismatch', 0]);
  });
});

describe('dmInPage：照页面的顺序调 IM SDK（假 document / fiber）', () => {
  afterEach(() => { delete globalThis.document; });

  function page({ sendResult = 'ok', ctx: extra = {}, user = { uid: ME, is_confer_login: false }, convs = null, decoy = null } = {}) {
    const calls = [];
    const conv = { id: '0:1:me:p1', isGroupChat: false, isStrangerChat: false, toParticipantUserId: 'p1', lastMessage: { serverId: '7001', indexInConversation: { toString: () => '12' }, isFromMe: false } };
    const msg = { clientId: 'cli-1', type: 7, serverId: undefined, flightStatus: 0 };
    const ctx = {
      bytedIM: {
        createMessage: async (o) => { calls.push(['create', o]); return msg; },
        getMessagesByConversation: async (a) => { calls.push(['pull', a]); return { messages: [{ serverId: '7001', clientId: 'x', isFromMe: false, content: JSON.stringify({ text: '在吗', aweType: 700 }), indexInConversation: { toString: () => '12' }, type: 7, conversationId: conv.id }, { serverId: '9', conversationId: 'other', isFromMe: true, content: '{}' }], hasMore: true }; },
      },
      sendMessageWithAuth: async (a) => {
        calls.push(['send', a]);
        if (sendResult === 'throw') { const e = new Error(`校验失败 content=${a.message.content} token=abc`); e.name = 'PrivateMessageText'; throw e; }
        if (sendResult === 'undefined') return undefined;
        if (sendResult === 'status-false') { a.message.serverId = '7300'; return { success: true, body: { status: false }, payload: a.message }; }
        if (sendResult === 'status-null') { a.message.serverId = '7300'; return { success: true, body: { status: null }, payload: a.message }; }
        a.message.serverId = '7300'; a.message.flightStatus = 3;
        return { success: true, statusCode: 0, body: { status: 0 }, checkCode: { toString: () => '0' }, payload: a.message };
      },
      reportAction: (x) => { calls.push(['report', x]); return Promise.reject(new Error('上报失败不影响')); },
      conversationList: convs ?? [conv], strangerConversationList: [], loading: false, ...extra,
    };
    // li 往上：第 2 层是私信 Context，第 3 层是带 userInfo 的 Context
    const fiber = { memoizedProps: {}, return: { memoizedProps: { value: ctx }, return: { memoizedProps: { value: user ? { userInfo: user } : { other: 1 } }, return: null } } };
    const li = { '__reactFiber$abc': fiber };
    // decoy：排在前面的另一条链，只有 userInfo、没有私信服务
    const other = decoy ? [{ '__reactFiber$abc': { memoizedProps: { value: { userInfo: decoy } }, return: null } }] : [];
    globalThis.document = { querySelectorAll: (sel) => (sel === 'li.semi-list-item' ? [...other, li] : []) };
    return { calls, conv, ctx };
  }
  const send = (conv, extra = {}) => dmInPage({ method: 'send', args: { conversationId: conv.id, text: '你好', uid: ME, lastSid: '7001', ...extra } });

  test('locate、conv：按会话 id 精确找；没给会话 id 才认 peerUid；本人登录核对', async () => {
    const { conv } = page();
    assert.deepEqual(await dmInPage({ method: 'locate' }), { ok: true });
    const c = await dmInPage({ method: 'conv', args: { conversationId: conv.id, uid: ME } });
    assert.deepEqual(c.conv, { id: conv.id, group: false, stranger: false, last: { sid: '7001', idx: '12', mine: false } });
    assert.deepEqual(c.login, { owner: 1, uidMatch: true });
    assert.equal((await dmInPage({ method: 'conv', args: { peerUid: 'p1' } })).conv.id, conv.id);
    const miss = await dmInPage({ method: 'conv', args: { conversationId: 'nope', peerUid: 'p1' } });
    assert.deepEqual([miss.ok, miss.notFound], [false, true]);
  });

  test('群聊判定同 DOM 写法：没有 isGroupChat 时看 type === 2', async () => {
    const g = { id: 'g1', type: 2, toParticipantUserId: 'p1', lastMessage: null };
    page({ convs: [g] });
    assert.equal((await dmInPage({ method: 'conv', args: { conversationId: 'g1' } })).conv.group, true);
    assert.equal((await dmInPage({ method: 'conv', args: { peerUid: 'p1' } })).ok, false);
    const r = await dmInPage({ method: 'send', args: { conversationId: 'g1', text: '你好', uid: ME } });
    assert.deepEqual([r.ok, r.code, r.notSent], [false, 'group', true]);
    // 两个字段矛盾（isGroupChat:false、type:2）也按群聊
    page({ convs: [{ ...g, isGroupChat: false }] });
    assert.equal((await dmInPage({ method: 'conv', args: { conversationId: 'g1' } })).conv.group, true);
  });

  test('身份只认私信服务同一条祖先链外层的 userInfo：前面另一条链上本人登录的身份不借用', async () => {
    const { calls, conv } = page({ user: { uid: ME, is_confer_login: true }, decoy: { uid: ME, is_confer_login: false } });
    assert.equal((await dmInPage({ method: 'conv', args: { conversationId: conv.id, uid: ME } })).login.owner, 0);
    const r = await send(conv);
    assert.deepEqual([r.code, r.notSent, calls.length], ['not-owner-login', true, 0]);
    const b = page({ user: null, decoy: { uid: ME, is_confer_login: false } });
    assert.equal((await send(b.conv)).code, 'not-owner-login');
  });

  test('send：会话最后一句不是发前核对的那条、或是我说的 → last-changed，SDK 零调用', async () => {
    for (const extra of [{ lastSid: '6999' }]) {
      const { calls, conv } = page();
      const r = await send(conv, extra);
      assert.deepEqual([r.code, r.notSent, calls.length], ['last-changed', true, 0]);
    }
    const { calls, conv } = page();
    conv.lastMessage.isFromMe = true;
    assert.deepEqual([(await send(conv)).code, calls.length], ['last-changed', 0]);
  });

  test('没有 Context：locate 返回 ok:false，并标明没发', async () => {
    globalThis.document = { querySelectorAll: () => [] };
    const r = await dmInPage({ method: 'send', args: {} });
    assert.deepEqual([r.ok, r.missing, r.notSent], [false, true, true]);
    assert.equal((await dmInPage({ method: 'locate' })).ok, false);
  });

  test('pull：direction 3（FROM_LATEST），只留这个会话的消息，正文从 content JSON 里取，摘要在拉完后取', async () => {
    const { calls, conv } = page();
    const r = await dmInPage({ method: 'pull', args: { conversationId: conv.id, limit: 20 } });
    assert.deepEqual(calls[0][1], { conversation: conv, direction: 3, limit: 20 });
    assert.deepEqual(r.msgs, [{ sid: '7001', mine: false, text: '在吗', idx: '12', type: 7 }]);
    assert.equal(r.conv.last.sid, '7001');
  });

  test('send：createMessage（TEXT=7、content 带 aweType 774）→ reportAction → sendMessageWithAuth（isRetry:false）各一次，返回服务端 id', async () => {
    const { calls, conv } = page();
    const r = await send(conv);
    assert.deepEqual(calls.map(([m]) => m), ['create', 'report', 'send']);
    assert.deepEqual(calls[0][1], { type: 7, content: JSON.stringify({ text: '你好', aweType: 774 }), conversation: conv });
    assert.equal(calls[1][1].messageClientId, 'cli-1');
    assert.equal(calls[2][1].isRetry, false);
    assert.deepEqual(r.res, { success: 1, statusCode: 0, bodyStatus: 0, checkCode: 0, sid: '7300', flight: 3 });
  });

  test('send：没能证实本人登录 → 建消息之前就停下（notSent），SDK 零调用', async () => {
    for (const user of [{ uid: ME, is_confer_login: true }, { uid: ME }, null, { uid: 'other', is_confer_login: false }]) {
      const { calls, conv } = page({ user });
      const r = await send(conv);
      assert.deepEqual([r.ok, r.code, r.notSent, calls.length], [false, 'not-owner-login', true, 0], JSON.stringify(user));
    }
  });

  test('send：Context 上有页面自己的 createMessage 时用它（同页面）', async () => {
    const own = [];
    const { calls, conv } = page({ ctx: { createMessage: async (o) => { own.push(o); return { clientId: 'c2', type: 7 }; } } });
    await send(conv);
    assert.equal(own.length, 1);
    assert.ok(!calls.some(([m]) => m === 'create'));
  });

  test('send：sendMessageWithAuth 抛错 → 只回错误码，不带异常原文（正文、token）', async () => {
    const { conv } = page({ sendResult: 'throw' });
    const r = await send(conv);
    assert.deepEqual([r.ok, r.code, 'notSent' in r], [false, 'send:Error', false]);
    assert.ok(!JSON.stringify(r).includes('你好') && !JSON.stringify(r).includes('abc') && !JSON.stringify(r).includes('PrivateMessageText'));
  });

  test('send：返回 undefined → res:null；body.status 是 false → bodyStatus 记 x（不认识）', async () => {
    const a = page({ sendResult: 'undefined' });
    assert.equal((await send(a.conv)).res, null);
    const b = page({ sendResult: 'status-false' });
    assert.equal((await send(b.conv)).res.bodyStatus, 'x');
    const c = page({ sendResult: 'status-null' });
    assert.equal((await send(c.conv)).res.bodyStatus, 'x');
  });
});

describe('dmCaller 节奏和入口分流', () => {
  test('定位之后、每两次调用之间都至少隔 800ms', async () => {
    const at = [];
    const page = { evaluate: async (_fn, a) => { at.push(Date.now()); return a.method === 'locate' ? { ok: true } : { ok: true }; } };
    const call = await dmCaller(page, 'Douyin', { waitMs: 0, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
    await call('conv', {});
    await call('pull', {});
    assert.equal(at.length, 3);
    for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 795, `${i}: ${at[i] - at[i - 1]}ms`);
  });

  test('私信服务一直等不到 → null；页面调用失败只回错误码', async () => {
    assert.equal(await dmCaller({ evaluate: async () => ({ ok: false }) }, 'Douyin', { waitMs: 0, sleep: noSleep }), null);
    let n = 0;
    const call = await dmCaller({ evaluate: async () => { if (n++) throw new Error('Target closed token=abc'); return { ok: true }; } }, 'Douyin', { waitMs: 0, gapMs: 0, sleep: noSleep });
    assert.deepEqual(await call('send', {}), { ok: false, code: 'evaluate-failed' });
  });

  test('douyin.runInSpace：writeVia=api 的 sendDM 走接口写法，dom 的走页面写法', async () => {
    const task = { pages: async () => { throw new Error('页面没起来'); } };
    const api = await runInSpace(task, { op: 'sendDM', uid: ME, text: '你好', target: { conversationId: 'c1' }, writeVia: 'api' });
    assert.deepEqual([api.via, api.blocked, api.sendAttempted], ['api', 'precheck-error', false]);
    const dom = await runInSpace(task, { op: 'sendDM', uid: ME, text: '你好', target: { conversationId: 'c1' }, writeVia: 'dom' });
    assert.notEqual(dom.via, 'api');
    assert.equal(dom.sendAttempted, false);
  });
});
