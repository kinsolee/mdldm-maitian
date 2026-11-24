// 抖音私信页面内接口写法：页面内函数（假 document / React fiber / IM SDK）、发前重读和发后回读的护栏（假接口）、节奏、入口分流。
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { dmInPage, dmCaller, douyinDmApi } from '../src/ops/engage/writers/api-dm.mjs';
import { runApiWrite } from '../src/ops/engage/writers/api-reply.mjs';
import { runInSpace } from '../src/ops/engage/writers/douyin.mjs';
import { dmWorld, peerMsg, myMsg } from './helpers/douyin-dm-world.mjs';

const ME = '106707338905';
const noSleep = async () => {};
function fakeTask({ uid = ME } = {}) {
  const page = { cdp: async () => ({}), goto: async () => {}, url: async () => 'https://creator.douyin.com/creator-micro/data/following/chat', evaluate: async () => true };
  return { task: { pages: async () => [page] }, plat: { api: douyinDmApi, hook: false, url: () => 'https://creator.douyin.com/x', login: async () => ({ uid }) } };
}
const params = (extra = {}) => ({ op: 'sendDM', uid: ME, text: '你好，资料发你了', target: { conversationId: 'c1', peerUid: 'p1' }, timeouts: { readbackMs: 0, settleMs: 0 }, ...extra });
const run = (w, p = params(), o = {}) => { const { task, plat } = fakeTask(o); return runApiWrite(task, p, plat, { serviceCaller: async () => (w ? w.call : null), sleep: noSleep }); };

describe('抖音私信接口写法：发送和回读', () => {
  test('发送成功、回读到恰好 1 条我发的新消息 → found，nativeId 是服务端 id；发送函数只调一次', async () => {
    const w = dmWorld();
    const r = await run(w);
    assert.deepEqual([r.sendAttempted, r.via, r.readBack.found, r.readBack.count, r.readBack.nativeId], [true, 'api', true, 1, 's-new']);
    assert.equal(w.count('send'), 1);
    assert.ok(!('sendError' in r));
    // 诊断只有接口名、返回码、耗时，不带正文
    assert.match(r.readBack.detail, /api=sendMessageWithAuth send=s1,st0,b0/);
    assert.ok(!r.readBack.detail.includes('资料'));
  });

  test('发送接口说成功但回读没找到 → found:false、count 0，带诊断', async () => {
    const w = dmWorld({ send: 'silent' });
    const r = await run(w);
    assert.deepEqual([r.sendAttempted, r.readBack.found, r.readBack.count], [true, false, 0]);
    assert.match(r.readBack.detail, /诊断api v1 .*pull=getMessagesByConversation n=1\/0\/0\/0/);
    assert.equal(w.count('send'), 1);
  });

  test('发送接口报错、返回 undefined、被拒、仅自己可见：都不算成功，只调一次，不设 sendError', async () => {
    for (const send of ['throw', 'undefined', 'rejected', 'self-visible']) {
      const w = dmWorld({ send });
      const r = await run(w);
      assert.deepEqual([r.sendAttempted, r.readBack.found, 'sendError' in r], [true, false, false], send);
      assert.equal(w.count('send'), 1, send);
      assert.match(r.readBack.detail, /api=sendMessageWithAuth/, send);
    }
  });

  test('回读拉消息出错 → found:false，detail 写拉消息失败', async () => {
    const w = dmWorld();
    const pull = w.call;
    let n = 0;
    w.call = async (m, a) => (m === 'pull' && ++n > 1 ? { ok: false, error: 'getMessagesByConversation 出错：超时' } : pull(m, a));
    const r = await run(w);
    assert.deepEqual([r.readBack.found, r.readBack.count], [false, 0]);
    assert.match(r.readBack.detail, /pull=err/);
  });

  test('回读到两条一样的新消息 → count 2，不算回读到', async () => {
    const w = dmWorld();
    const send = w.call;
    w.call = async (m, a) => { const r = await send(m, a); if (m === 'send') w.msgs.push(myMsg('s-dup', 99, a.text)); return r; };
    const r = await run(w);
    assert.deepEqual([r.readBack.found, r.readBack.count], [false, 2]);
  });
});

describe('抖音私信接口写法：发前重读', () => {
  test('页面私信服务找不到 → cannot-send，没发，提示关 writeDmViaApi', async () => {
    const r = await run(null);
    assert.deepEqual([r.blocked, r.sendAttempted], ['cannot-send', false]);
    assert.match(r.detail, /writeDmViaApi/);
  });

  test('会话不在列表 → target-not-found；群聊 → cannot-send；最后一句是我 → last-is-me；发送函数零调用', async () => {
    const cases = [
      [dmWorld({ conv: { missing: true } }), 'target-not-found'],
      [dmWorld({ conv: { group: true } }), 'cannot-send'],
      [dmWorld({ msgs: [peerMsg('s1', 1), myMsg('s2', 2, '好的')] }), 'last-is-me'],
    ];
    for (const [w, want] of cases) {
      const r = await run(w);
      assert.deepEqual([r.blocked, r.sendAttempted], [want, false], want);
      assert.equal(w.count('send'), 0, want);
    }
  });

  test('本地记的最后一句不是我、但服务端拉到的最后一句是我 → last-is-me', async () => {
    const w = dmWorld({ msgs: [peerMsg('s1', 1), myMsg('s2', 2, '好的')], conv: { last: { sid: 's1', type: 7, mine: false } } });
    const r = await run(w);
    assert.equal(r.blocked, 'last-is-me');
    assert.equal(w.count('send'), 0);
  });

  test('拉到的不是最新一页（没有会话最后一条）→ precheck-error；拉消息出错 → precheck-error；都没发', async () => {
    for (const pull of ['stale', 'throw']) {
      const w = dmWorld({ pull });
      const r = await run(w);
      assert.deepEqual([r.blocked, r.sendAttempted], ['precheck-error', false], pull);
      assert.equal(w.count('send'), 0, pull);
    }
  });

  test('超过编辑框上限 500 字 → text-too-long，不调接口', async () => {
    const w = dmWorld();
    const r = await run(w, params({ text: '字'.repeat(501) }));
    assert.deepEqual([r.blocked, w.calls.length], ['text-too-long', 0]);
  });

  test('页面登录的不是这个账号 → uid-mismatch，不调接口', async () => {
    const w = dmWorld();
    const r = await run(w, params(), { uid: 'someone-else' });
    assert.deepEqual([r.blocked, w.calls.length], ['uid-mismatch', 0]);
  });
});

describe('dmInPage：照页面的顺序调 IM SDK（假 document / fiber）', () => {
  afterEach(() => { delete globalThis.document; });

  function page({ sendResult = 'ok', ctx: extra = {} } = {}) {
    const calls = [];
    const conv = { id: '0:1:me:p1', isGroupChat: false, isStrangerChat: false, toParticipantUserId: 'p1', lastMessage: { serverId: '7001', type: 7, isFromMe: false } };
    const msg = { clientId: 'cli-1', type: 7, serverId: undefined, flightStatus: 0 };
    const ctx = {
      bytedIM: {
        createMessage: async (o) => { calls.push(['create', o]); return msg; },
        getMessagesByConversation: async (a) => { calls.push(['pull', a]); return { messages: [{ serverId: '7001', clientId: 'x', isFromMe: false, content: JSON.stringify({ text: '在吗', aweType: 700 }), indexInConversation: { toString: () => '12' }, type: 7, conversationId: conv.id }, { serverId: '9', conversationId: 'other', isFromMe: true, content: '{}' }], hasMore: true }; },
      },
      sendMessageWithAuth: async (a) => {
        calls.push(['send', a]);
        if (sendResult === 'throw') throw new Error('IM SDK not initialized');
        if (sendResult === 'undefined') return undefined;
        a.message.serverId = '7300'; a.message.flightStatus = 3;
        return { success: true, statusCode: 0, body: { status: 0 }, checkCode: { toString: () => '0' }, payload: a.message };
      },
      reportAction: (x) => { calls.push(['report', x]); return Promise.reject(new Error('上报失败不影响')); },
      conversationList: [conv], strangerConversationList: [], loading: false, ...extra,
    };
    // li 往上三层 fiber 才是 Context Provider
    const fiber = { memoizedProps: {}, return: { memoizedProps: { value: { other: 1 } }, return: { memoizedProps: { value: ctx }, return: null } } };
    const li = { '__reactFiber$abc': fiber };
    globalThis.document = { querySelectorAll: (sel) => (sel === 'li.semi-list-item' ? [li] : []) };
    return { calls, conv, ctx };
  }

  test('locate、conv：按会话 id 找，也认 peerUid；找不到给 notFound', async () => {
    const { conv } = page();
    assert.deepEqual(await dmInPage({ method: 'locate' }), { ok: true });
    const c = await dmInPage({ method: 'conv', args: { conversationId: conv.id } });
    assert.deepEqual(c.conv, { id: conv.id, group: false, stranger: false, last: { sid: '7001', type: 7, mine: false } });
    assert.equal((await dmInPage({ method: 'conv', args: { conversationId: 'nope', peerUid: 'p1' } })).conv.id, conv.id);
    assert.equal((await dmInPage({ method: 'conv', args: { conversationId: 'nope' } })).notFound, true);
  });

  test('没有 Context：locate 返回 ok:false', async () => {
    globalThis.document = { querySelectorAll: () => [] };
    assert.equal((await dmInPage({ method: 'locate' })).ok, false);
  });

  test('pull：direction 3（FROM_LATEST），只留这个会话的消息，正文从 content JSON 里取', async () => {
    const { calls, conv } = page();
    const r = await dmInPage({ method: 'pull', args: { conversationId: conv.id, limit: 20 } });
    assert.deepEqual(calls[0][1], { conversation: conv, direction: 3, limit: 20 });
    assert.deepEqual(r.msgs, [{ key: '7001', sid: '7001', mine: false, text: '在吗', idx: '12', type: 7 }]);
  });

  test('send：createMessage（TEXT=7、content 带 aweType 774）→ reportAction → sendMessageWithAuth（isRetry:false）各一次，返回服务端 id', async () => {
    const { calls, conv } = page();
    const r = await dmInPage({ method: 'send', args: { conversationId: conv.id, text: '你好' } });
    assert.deepEqual(calls.map(([m]) => m), ['create', 'report', 'send']);
    assert.deepEqual(calls[0][1], { type: 7, content: JSON.stringify({ text: '你好', aweType: 774 }), conversation: conv });
    assert.equal(calls[1][1].messageClientId, 'cli-1');
    assert.equal(calls[2][1].isRetry, false);
    assert.deepEqual(r.res, { success: true, statusCode: 0, bodyStatus: 0, checkCode: 0, sid: '7300', flight: 3 });
  });

  test('send：Context 上有页面自己的 createMessage 时用它（同页面）', async () => {
    const own = [];
    const { calls, conv } = page({ ctx: { createMessage: async (o) => { own.push(o); return { clientId: 'c2', type: 7 }; } } });
    await dmInPage({ method: 'send', args: { conversationId: conv.id, text: '你好' } });
    assert.equal(own.length, 1);
    assert.ok(!calls.some(([m]) => m === 'create'));
  });

  test('send：sendMessageWithAuth 抛错 → ok:false stage send；返回 undefined → res:null', async () => {
    const a = page({ sendResult: 'throw' });
    const r = await dmInPage({ method: 'send', args: { conversationId: a.conv.id, text: '你好' } });
    assert.deepEqual([r.ok, r.stage], [false, 'send']);
    const b = page({ sendResult: 'undefined' });
    const r2 = await dmInPage({ method: 'send', args: { conversationId: b.conv.id, text: '你好' } });
    assert.deepEqual([r2.ok, r2.res], [true, null]);
  });
});

describe('dmCaller 节奏和入口分流', () => {
  test('两次调用至少隔 800ms', async () => {
    const waits = [];
    const page = { evaluate: async (_fn, a) => (a.method === 'locate' ? { ok: true } : { ok: true, at: Date.now() }) };
    const call = await dmCaller(page, 'Douyin', { waitMs: 0, sleep: async (ms) => { waits.push(ms); await new Promise((r) => setTimeout(r, ms)); } });
    await call('conv', {});
    await call('pull', {});
    assert.equal(waits.length, 1);
    assert.ok(waits[0] > 700 && waits[0] <= 800, String(waits[0]));
  });

  test('私信服务一直等不到 → null', async () => {
    const page = { evaluate: async () => ({ ok: false }) };
    assert.equal(await dmCaller(page, 'Douyin', { waitMs: 0, sleep: noSleep }), null);
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
