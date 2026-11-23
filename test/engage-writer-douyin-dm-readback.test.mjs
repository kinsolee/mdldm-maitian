// 抖音私信发后回读：用仿 IM SDK Message 的对象（isFromMe 是原型 getter、客户端 id 叫 clientId、确认前没有 serverId）跑页面脚本。
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { dmDiagnose, dmItems } from '../src/ops/engage/writers/douyin.mjs';
import { readBack } from '../src/ops/engage/writers/page-write-lib.mjs';

const CONV = '0:1:106:601', OTHER = '0:1:106:602', TEXT = '您好，链接在主页';

class Msg {
  constructor({ conv = CONV, me = true, text = TEXT, serverId, clientId = 'local-uuid', content }) {
    Object.assign(this, { conversationId: conv, sender: me ? '106' : '601', type: 7, serverId, clientId, content: content ?? JSON.stringify({ text }), createdAt: new Date() });
  }
  get isFromMe() { return this.sender === '106'; }
}

const fiberEl = (message, depth = 1) => {
  let f = { memoizedProps: { message } };
  for (let i = 0; i < depth; i++) f = { memoizedProps: {}, return: f };
  return { __reactFiber$t: f };
};
const rowEl = (id, lastMessage) => ({ __reactFiber$t: { memoizedProps: {}, return: { memoizedProps: {}, return: { memoizedProps: { item: { id, lastMessage } } } } } });

let els, rows;
const page = { evaluate: async (fn, arg) => fn(arg) };
beforeEach(() => {
  els = []; rows = [];
  globalThis.document = { querySelector: () => null, querySelectorAll: (s) => (s === 'body *' ? els : s === 'li.semi-list-item' ? rows : []) };
});
afterEach(() => { delete globalThis.document; });

const show = (...ms) => { els = ms.map((m) => fiberEl(m)); };
const run = async (before = []) => (await readBack(page, { items: () => dmItems(page, CONV), diagnose: (b, w) => dmDiagnose(page, CONV, b, w) },
  { before: new Set(before), toastBefore: new Set(), capFrom: 0, t: { readbackMs: 30 }, text: TEXT })).readBack;

describe('抖音私信回读', () => {
  test('服务端确认后的新消息（只有 clientId + serverId）能确认', async () => {
    show(new Msg({ me: false, text: '请问', serverId: '1' }), new Msg({ serverId: '2' }));
    assert.deepEqual(await run(['1']), { found: true, count: 1, nativeId: '2' });
  });

  test('只有 clientId 的同文消息不算确认', async () => {
    show(new Msg({}));
    const r = await run();
    assert.equal(r.found, false);
    assert.match(r.detail, /noid=1/);
    assert.match(r.detail, /hit=cm0,ci1,srv0/);
  });

  test('旧的同文消息不算这次发的', async () => {
    show(new Msg({ serverId: 'old' }));
    assert.equal((await run(['old'])).found, false);
  });

  test('两条同文新消息 count=2，仍不算确认', async () => {
    show(new Msg({ serverId: '2', clientId: 'a' }), new Msg({ serverId: '3', clientId: 'b' }));
    const r = await run();
    assert.equal(r.found, false);
    assert.equal(r.count, 2);
  });

  test('别的会话里的同文消息不算', async () => {
    show(new Msg({ conv: OTHER, serverId: '9' }));
    const r = await run();
    assert.equal(r.found, false);
    assert.equal(r.count, 0);
  });

  test('对方发的同文消息不算', async () => {
    show(new Msg({ me: false, serverId: '9' }));
    assert.equal((await run()).found, false);
  });

  test('诊断区分「只在会话列表有」和「fiber 层数过深」，且不带正文和 id', async () => {
    const m = new Msg({ serverId: '778899' });
    rows = [rowEl(CONV, m)];
    let r = await run();
    assert.match(r.detail, /msg=0\/0\/0\/0\/0 .*row=me1,srv1,new1,eq1 hit=none/);
    for (const secret of [TEXT, '778899', CONV, '601', 'local-uuid']) assert.ok(!r.detail.includes(secret), secret);

    els = [fiberEl(m, 8)];
    r = await run();
    assert.equal(r.found, false);
    assert.match(r.detail, /deep=1/);
  });

  test('content 是对象时正式回读不认，诊断标出 object', async () => {
    show(new Msg({ serverId: '2', content: { text: TEXT } }));
    const r = await run();
    assert.equal(r.found, false);
    assert.match(r.detail, /deep=0 noid=0 .*hit=cm0,ci1,srv1,object/);
  });

  test('诊断一直不返回时，3 秒后保留原来的回读结果', async () => {
    const r = await readBack(page, { items: async () => [], diagnose: () => new Promise(() => {}) },
      { before: new Set(), toastBefore: new Set(), capFrom: 0, t: { readbackMs: 10 }, text: TEXT });
    assert.deepEqual(r.readBack, { found: false, count: 0, nativeId: null, detail: '10ms 内没读到我发的这条' });
  });

  test('诊断出错不影响回读结论', async () => {
    const r = await readBack(page, { items: async () => [], diagnose: async () => { throw new Error('boom'); } },
      { before: new Set(), toastBefore: new Set(), capFrom: 0, t: { readbackMs: 10 }, text: TEXT });
    assert.deepEqual(r.readBack, { found: false, count: 0, nativeId: null, detail: '10ms 内没读到我发的这条' });
  });
});
