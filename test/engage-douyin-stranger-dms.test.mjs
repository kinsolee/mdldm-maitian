// KIN-340：抖音陌生人私信 Context 读取、DOM 回落、首次基线、events.occurredAt、changedConversations 与延迟告警。
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateEngage } from '../src/ops/engage-db.mjs';
import { readDmContext, rawDms, parseDms } from '../src/ops/engage/adapters/douyin.mjs';
import { shapeErrors } from '../src/ops/engage/adapters/shape.mjs';
import { ingestSnapshot } from '../src/ops/engage/store.mjs';
import { listEvents } from '../src/ops/engage/query.mjs';
import { subscribe } from '../src/ops/engage/subscribers.mjs';
import { setCapability } from '../src/ops/accounts.mjs';
import { deliverPending } from '../src/daemon/outbox.mjs';
import { runRound, DM_DELAY_ALERT_MS, DM_DELAY_ALERT_COOLDOWN_MS } from '../src/daemon/sync.mjs';
import { freshDb, douyin, comment, commentsSnap, conv, dmsSnap, T0, MIN, at } from './helpers/engage-fixtures.mjs';

const HOUR = 3600_000;
const ME = '106707338905';
const tmpLock = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kin340-lock-')), 'engage-sync.lock');

function makeLi({ item, headerText, innerText, ctxValue }) {
  const ctxFiber = ctxValue ? { memoizedProps: { value: ctxValue }, return: null } : null;
  const itemFiber = { memoizedProps: { item }, return: ctxFiber };
  const midFiber = { memoizedProps: {}, return: itemFiber };
  const leafFiber = { memoizedProps: {}, return: midFiber };
  return {
    __reactFiber$test: leafFiber,
    innerText: innerText ?? headerText ?? '',
    querySelector: (sel) => (sel.includes('item-header') && headerText != null ? { innerText: headerText } : null),
  };
}

function installFakeDoc({ domLis = [], chatEls = [], semiListEls = [], emptyNode = false, bodyText = '' } = {}) {
  globalThis.document = {
    body: { innerText: bodyText },
    querySelector: (sel) => (sel === '.semi-list-empty' && emptyNode ? {} : null),
    querySelectorAll: (sel) => {
      if (sel === 'li.semi-list-item') return domLis;
      if (sel === '[class*=chat-]') return chatEls;
      if (sel === '[class*=semi-list]') return semiListEls;
      if (sel === 'li') return domLis;
      return [];
    },
  };
  globalThis.location = { pathname: '/creator-micro/data/following/chat' };
}

function fakePage() {
  return {
    waitForSelector: async () => true,
    evaluate: async (fn, ...args) => fn(...args),
  };
}

function sdkConv(id, { uid, name, stranger = false, group = false, unread = 1, text = '你好', byMe = false, atMs = T0 - 5 * MIN, serverId = null } = {}) {
  return {
    id,
    shortId: `s-${id}`,
    toParticipantUserId: uid ?? `u-${id}`,
    isStrangerChat: stranger,
    isGroupChat: group,
    unreadCount: unread,
    ...(name !== undefined ? { name } : {}),
    lastMessage: atMs == null ? null : {
      serverId: serverId ?? `srv-${id}-${atMs}`,
      clientMessageId: null,
      type: 7,
      isFromMe: byMe,
      createdAt: String(atMs),
      content: JSON.stringify({ text }),
    },
  };
}

afterEach(() => {
  delete globalThis.document;
  delete globalThis.location;
});

describe('抖音私信 React Context 读取与 DOM 回落', () => {
  test('陌生人会话在 Context 里但不在首屏 DOM：能完整读出、去重并过滤「陌生人消息」占位标题', async () => {
    const c1 = sdkConv('0:1:me:u1', { uid: 'u1', text: '普通会话1', atMs: T0 - 2 * MIN });
    const c2 = sdkConv('0:1:me:u2', { uid: 'u2', text: '首屏外普通会话', name: '首屏外朋友', atMs: T0 - 40 * MIN });
    const s1 = sdkConv('0:1:me:s1', { uid: 's1', stranger: true, text: '陌生人旧消息', atMs: T0 - 24 * HOUR });
    const s2 = sdkConv('0:1:me:s2', { uid: 's2', stranger: true, text: '陌生人新消息', atMs: T0 - 3 * MIN });
    // s1 同时出现在折叠行 DOM（标题是「陌生人消息」）且出现在 strangerConversationList
    const ctx = {
      bytedIM: { createMessage() {} },
      loading: false,
      conversationList: [c1, c2, { ...s1, lastMessage: { ...s1.lastMessage, createdAt: String(T0 - 25 * HOUR) } }],
      strangerConversationList: [s1, s2],
      userInfoMap: { s2: { nickname: '陌生人乙' } },
    };
    const domLis = [
      makeLi({ item: c1, headerText: '普通甲\n10:00', ctxValue: ctx }),
      makeLi({ item: s1, headerText: '陌生人消息\n昨天', ctxValue: ctx }),
    ];
    installFakeDoc({ domLis });

    const ctxRes = readDmContext();
    assert.equal(ctxRes.ok, true);
    assert.equal(ctxRes.strangerCount, 2);
    assert.equal(ctxRes.hasStrangerList, true);
    assert.equal(ctxRes.conversations.length, 4, '重复会话按 id 去重');

    const raw = await rawDms(fakePage(), { readVia: 'api', settleMs: 0, contextWaitMs: 0 });
    assert.equal(raw.via, 'context');
    assert.equal(raw.strangerCount, 2);
    assert.equal(raw.apiFallback, undefined);

    const parsed = parseDms(raw, { accountUid: ME, fetchedAt: new Date(T0).toISOString() });
    assert.deepEqual(shapeErrors(parsed), []);
    assert.equal(parsed.via, 'context');
    assert.equal(parsed.strangerCount, 2);
    const byId = new Map(parsed.conversations.map((c) => [c.nativeId, c]));
    assert.equal(byId.get('0:1:me:u1').peer.nickname, '普通甲');
    assert.equal(byId.get('0:1:me:u1').isStranger, undefined);
    assert.equal(byId.get('0:1:me:u2').peer.nickname, '首屏外朋友');
    assert.equal(byId.get('0:1:me:s1').isStranger, true);
    assert.equal(byId.get('0:1:me:s1').peer.nickname, null, '不把「陌生人消息」当真实昵称');
    assert.equal(byId.get('0:1:me:s1').last.at, new Date(T0 - 24 * HOUR).toISOString(), '重复会话取较新的 lastMessage');
    assert.equal(byId.get('0:1:me:s2').isStranger, true);
    assert.equal(byId.get('0:1:me:s2').peer.nickname, '陌生人乙');
    assert.equal(byId.get('0:1:me:s2').last.text, '陌生人新消息');
  });

  test('Context 不可用时自动回落 DOM，带 apiFallback 与 via=dom；readVia=dom 不走 Context', async () => {
    const c1 = sdkConv('0:1:me:u1', { uid: 'u1', text: 'DOM会话', atMs: T0 - MIN });
    installFakeDoc({ domLis: [makeLi({ item: c1, headerText: '普通甲', ctxValue: null })] });

    const fallback = await rawDms(fakePage(), { readVia: 'api', settleMs: 0, contextWaitMs: 0, contextPollMs: 0 });
    assert.equal(fallback.via, 'dom');
    assert.match(fallback.apiFallback, /service-missing/);
    assert.equal(fallback.conversations.length, 1);
    assert.equal(fallback.conversations[0].id, '0:1:me:u1');

    const domOnly = await rawDms(fakePage(), { readVia: 'dom', settleMs: 0 });
    assert.equal(domOnly.via, 'dom');
    assert.equal(domOnly.apiFallback, undefined);
    assert.equal(domOnly.conversations.length, 1);
  });

  test('Context 明确加载完成且页面显示空状态 UI：emptyState=true，parseDms 返回合法空结果', async () => {
    const ctx = { bytedIM: {}, loading: false, conversationList: [], strangerConversationList: [] };
    const chatEl = { __reactFiber$test: { memoizedProps: { value: ctx }, return: null } };
    installFakeDoc({ domLis: [], chatEls: [chatEl], emptyNode: true });

    const raw = await rawDms(fakePage(), { readVia: 'api', settleMs: 0, contextWaitMs: 0 });
    assert.equal(raw.via, 'context');
    assert.equal(raw.emptyState, true);
    assert.equal(raw.strangerCount, 0);
    const parsed = parseDms(raw, { accountUid: ME, fetchedAt: new Date(T0).toISOString() });
    assert.deepEqual(shapeErrors(parsed), []);
    assert.equal(parsed.conversations.length, 0);
  });

  test('无空状态 UI 时，空 Context 不判 emptyState（U1 契约）', async () => {
    const ctx = { bytedIM: {}, loading: false, conversationList: [], strangerConversationList: [] };
    const chatEl = { __reactFiber$test: { memoizedProps: { value: ctx }, return: null } };
    installFakeDoc({ domLis: [], chatEls: [chatEl], emptyNode: false, bodyText: '' });

    const ctxRes = readDmContext();
    assert.equal(ctxRes.ok, false);
    assert.equal(ctxRes.code, 'empty-unconfirmed');

    const raw = await rawDms(fakePage(), { readVia: 'api', settleMs: 0, contextWaitMs: 0, contextPollMs: 0 });
    assert.equal(raw.via, 'dom');
    assert.match(raw.apiFallback, /empty-unconfirmed/);
    assert.equal(raw.emptyState, false);
    assert.throws(() => parseDms(raw, { accountUid: ME, fetchedAt: new Date(T0).toISOString() }), /没显示空状态/);
  });

  test('loading=true 时即使普通列表非空也不返回半截列表，等加载完成后再返回完整列表', async () => {
    const c1 = sdkConv('0:1:me:u1', { uid: 'u1', text: '普通1', atMs: T0 - MIN });
    const s1 = sdkConv('0:1:me:s1', { uid: 's1', stranger: true, text: '陌生人1', atMs: T0 - 2 * MIN });
    const ctx = { bytedIM: {}, loading: true, conversationList: [c1], strangerConversationList: [] };
    installFakeDoc({ domLis: [makeLi({ item: c1, headerText: '普通甲', ctxValue: ctx })] });

    const half = readDmContext();
    assert.equal(half.ok, false);
    assert.equal(half.code, 'list-loading');

    // 持续 loading=true 超时后不报 via=context，退回 DOM
    const timedOut = await rawDms(fakePage(), { readVia: 'api', settleMs: 0, contextWaitMs: 0, contextPollMs: 0 });
    assert.equal(timedOut.via, 'dom');
    assert.match(timedOut.apiFallback, /list-loading/);

    // 轮询期间先 loading=true，下一轮 loading=false 且陌生人列表就绪 -> 返回完整列表
    let calls = 0;
    const page = {
      waitForSelector: async () => true,
      evaluate: async (fn, ...args) => {
        calls++;
        if (calls >= 2) {
          ctx.loading = false;
          ctx.strangerConversationList = [s1];
        }
        return fn(...args);
      },
    };
    const full = await rawDms(page, { readVia: 'api', settleMs: 5, contextWaitMs: 500, contextPollMs: 5 });
    assert.equal(full.via, 'context');
    assert.equal(full.conversations.length, 2);
    assert.equal(full.strangerCount, 1);
  });

  test('Context 部分漂移回落 DOM：陌生人列表缺失或任一列表项全缺 id 都不得报 via=context', async () => {
    const c1 = sdkConv('0:1:me:u1', { uid: 'u1', text: '普通会话', atMs: T0 - MIN });
    const s1 = sdkConv('0:1:me:s1', { uid: 's1', stranger: true, text: '陌生人', atMs: T0 - 2 * MIN });

    // 场景 1：普通列表有效，但 strangerConversationList 缺失
    const missingStrangerCtx = { bytedIM: {}, loading: false, conversationList: [c1] };
    installFakeDoc({ domLis: [makeLi({ item: c1, headerText: '普通甲', ctxValue: missingStrangerCtx })] });
    assert.equal(readDmContext().ok, false);
    assert.equal(readDmContext().code, 'stranger-list-missing');
    const fb1 = await rawDms(fakePage(), { readVia: 'api', settleMs: 0, contextWaitMs: 0, contextPollMs: 0 });
    assert.equal(fb1.via, 'dom');
    assert.match(fb1.apiFallback, /stranger-list-missing/);

    // 场景 2：普通列表有效，但陌生人列表非空且全缺 id
    const brokenStrangerCtx = { bytedIM: {}, loading: false, conversationList: [c1], strangerConversationList: [{ badField: 1 }] };
    installFakeDoc({ domLis: [makeLi({ item: c1, headerText: '普通甲', ctxValue: brokenStrangerCtx })] });
    assert.equal(readDmContext().ok, false);
    assert.equal(readDmContext().code, 'no-valid-items');
    const fb2 = await rawDms(fakePage(), { readVia: 'api', settleMs: 0, contextWaitMs: 0, contextPollMs: 0 });
    assert.equal(fb2.via, 'dom');
    assert.match(fb2.apiFallback, /no-valid-items/);

    // 场景 3：陌生人列表有效，但普通列表非空且全缺 id
    const brokenNormalCtx = { bytedIM: {}, loading: false, conversationList: [{ badField: 1 }], strangerConversationList: [s1] };
    installFakeDoc({ domLis: [makeLi({ item: c1, headerText: '普通甲', ctxValue: brokenNormalCtx })] });
    assert.equal(readDmContext().ok, false);
    assert.equal(readDmContext().code, 'no-valid-items');
    const fb3 = await rawDms(fakePage(), { readVia: 'api', settleMs: 0, contextWaitMs: 0, contextPollMs: 0 });
    assert.equal(fb3.via, 'dom');
    assert.match(fb3.apiFallback, /no-valid-items/);
  });

  test('无 li.semi-list-item 且 [class*=chat-] 超过 30 个时，仍能从 [class*=semi-list] 找到 Context', () => {
    const c1 = sdkConv('0:1:me:u1', { uid: 'u1', text: '列表里', atMs: T0 - MIN });
    const ctx = { bytedIM: {}, loading: false, conversationList: [c1], strangerConversationList: [] };
    const noiseChats = Array.from({ length: 40 }, () => ({ __reactFiber$test: { memoizedProps: {}, return: null } }));
    const semiList = { __reactFiber$test: { memoizedProps: { value: ctx }, return: null } };
    installFakeDoc({ domLis: [], chatEls: noiseChats, semiListEls: [semiList] });

    const res = readDmContext();
    assert.equal(res.ok, true);
    assert.equal(res.conversations.length, 1);
  });

  test('missingWithDomSince 回到 list-loading 时重置，不会因早期瞬时 service-missing 过早回落 DOM', async () => {
    const c1 = sdkConv('0:1:me:u1', { uid: 'u1', text: '晚到', atMs: T0 - MIN });
    const ctx = { bytedIM: {}, loading: true, conversationList: [], strangerConversationList: [] };
    let step = 0;
    const page = {
      waitForSelector: async () => true,
      evaluate: async (fn, ...args) => {
        step++;
        if (step === 1) {
          installFakeDoc({ domLis: [makeLi({ item: c1, headerText: '甲', ctxValue: null })] });
        } else if (step <= 3) {
          ctx.loading = true;
          installFakeDoc({ domLis: [makeLi({ item: c1, headerText: '甲', ctxValue: ctx })] });
        } else {
          ctx.loading = false;
          ctx.conversationList = [c1];
          installFakeDoc({ domLis: [makeLi({ item: c1, headerText: '甲', ctxValue: ctx })] });
        }
        return fn(...args);
      },
    };
    const raw = await rawDms(page, { readVia: 'api', settleMs: 0, contextWaitMs: 500, contextPollMs: 10, contextFallbackGraceMs: 15 });
    assert.equal(raw.via, 'context');
    assert.equal(raw.conversations.length, 1);
  });

  test('serverId / clientMessageId 为 "" 或 "0" 时视为无效 id：不触发 shape 校验失败也不撞成 Douyin:0', async () => {
    const atMs = T0 - 5 * MIN;
    const emptyIds = sdkConv('0:1:me:e1', { uid: 'e1', text: '空串id', atMs });
    emptyIds.lastMessage.serverId = '';
    emptyIds.lastMessage.clientMessageId = '';
    const zeroIds = sdkConv('0:1:me:e2', { uid: 'e2', text: '零id', atMs });
    zeroIds.lastMessage.serverId = '0';
    zeroIds.lastMessage.clientMessageId = '0';
    const fallbackClient = sdkConv('0:1:me:e3', { uid: 'e3', text: '回退clientId', atMs });
    fallbackClient.lastMessage.serverId = '0';
    fallbackClient.lastMessage.clientMessageId = '';
    fallbackClient.lastMessage.clientId = 'cli-valid-3';

    const ctx = { bytedIM: {}, loading: false, conversationList: [emptyIds, zeroIds, fallbackClient], strangerConversationList: [] };
    installFakeDoc({ domLis: [makeLi({ item: emptyIds, headerText: '甲', ctxValue: ctx })] });

    const raw = await rawDms(fakePage(), { readVia: 'api', settleMs: 0, contextWaitMs: 0 });
    assert.equal(raw.via, 'context');
    const parsed = parseDms(raw, { accountUid: ME, fetchedAt: new Date(T0).toISOString() });
    assert.deepEqual(shapeErrors(parsed), []);
    const msgByConv = new Map(parsed.messages.map((m) => [m.conversationNativeId, m.nativeId]));
    assert.equal(msgByConv.get('0:1:me:e1'), `0:1:me:e1:${atMs}`);
    assert.equal(msgByConv.get('0:1:me:e2'), `0:1:me:e2:${atMs}`);
    assert.equal(msgByConv.get('0:1:me:e3'), 'cli-valid-3');
    assert.notEqual(msgByConv.get('0:1:me:e1'), msgByConv.get('0:1:me:e2'), '不同会话不得主键碰撞');
  });

  test('无 server/client id 时 Context↔DOM 切换（秒/毫秒时间戳）生成一致去重键，messages 不重复入库', async () => {
    const sec = Math.floor((T0 - 10 * MIN) / 1000);
    const ms = sec * 1000;
    const domItem = sdkConv('0:1:me:u1', { uid: 'u1', text: '同一条消息', atMs: ms });
    domItem.lastMessage.serverId = null;
    domItem.lastMessage.clientMessageId = null;
    domItem.lastMessage.createdAt = String(sec); // 秒级

    const ctxItem = sdkConv('0:1:me:u1', { uid: 'u1', text: '同一条消息', atMs: ms });
    ctxItem.lastMessage.serverId = '';
    ctxItem.lastMessage.clientMessageId = '0';
    ctxItem.lastMessage.createdAt = String(ms); // 毫秒级

    // 先走 DOM
    installFakeDoc({ domLis: [makeLi({ item: domItem, headerText: '普通甲', ctxValue: null })] });
    const rawDom = await rawDms(fakePage(), { readVia: 'dom', settleMs: 0 });
    const parsedDom = parseDms(rawDom, { accountUid: ME, fetchedAt: new Date(T0).toISOString() });
    assert.deepEqual(shapeErrors(parsedDom), []);

    // 再切 Context
    const ctx = { bytedIM: {}, loading: false, conversationList: [ctxItem], strangerConversationList: [] };
    installFakeDoc({ domLis: [makeLi({ item: ctxItem, headerText: '普通甲', ctxValue: ctx })] });
    const rawCtx = await rawDms(fakePage(), { readVia: 'api', settleMs: 0, contextWaitMs: 0 });
    const parsedCtx = parseDms(rawCtx, { accountUid: ME, fetchedAt: new Date(T0 + MIN).toISOString() });
    assert.deepEqual(shapeErrors(parsedCtx), []);

    assert.equal(parsedDom.messages[0].nativeId, parsedCtx.messages[0].nativeId);
    assert.equal(parsedDom.messages[0].nativeId, `0:1:me:u1:${ms}`);

    const db = freshDb();
    const acc = douyin(db);
    ingestSnapshot(db, acc, parsedDom, { now: at(T0) });
    ingestSnapshot(db, acc, parsedCtx, { now: at(T0 + MIN) });
    const rows = db.prepare("SELECT id FROM messages WHERE conversationId = 'Douyin:0:1:me:u1'").all();
    assert.equal(rows.length, 1, 'Context↔DOM 切换只保留 1 行消息');
  });

  test('Context 报空数组但 DOM 存在会话行：不误判空状态，退回 DOM 读出会话', async () => {
    const c1 = sdkConv('0:1:me:u1', { uid: 'u1', text: 'DOM会话', atMs: T0 - MIN });
    const ctx = { bytedIM: {}, loading: false, conversationList: [], strangerConversationList: [] };
    installFakeDoc({ domLis: [makeLi({ item: c1, headerText: '普通甲', ctxValue: ctx })] });

    const raw = await rawDms(fakePage(), { readVia: 'api', settleMs: 0, contextWaitMs: 0, contextPollMs: 0 });
    assert.equal(raw.via, 'dom');
    assert.match(raw.apiFallback, /empty-with-dom/);
    assert.equal(raw.conversations.length, 1);
    assert.equal(raw.conversations[0].id, '0:1:me:u1');
  });

  test('Context 列表非空但项结构漂移缺 id：不误判空状态，带 no-valid-items 回落 DOM', async () => {
    const c1 = sdkConv('0:1:me:u1', { uid: 'u1', text: 'DOM兜底', atMs: T0 - MIN });
    const brokenCtx = { bytedIM: {}, loading: false, conversationList: [{ badField: 1 }], strangerConversationList: [] };
    installFakeDoc({ domLis: [makeLi({ item: c1, headerText: '普通甲', ctxValue: brokenCtx })] });

    const ctxRes = readDmContext();
    assert.equal(ctxRes.ok, false);
    assert.equal(ctxRes.code, 'no-valid-items');

    const raw = await rawDms(fakePage(), { readVia: 'api', settleMs: 0, contextWaitMs: 0, contextPollMs: 0 });
    assert.equal(raw.via, 'dom');
    assert.match(raw.apiFallback, /no-valid-items/);
    assert.equal(raw.conversations.length, 1);

    // 若 DOM 也为空，不得误报 emptyState=true，parseDms 应报错
    const chatEl = { __reactFiber$test: { memoizedProps: { value: brokenCtx }, return: null } };
    installFakeDoc({ domLis: [], chatEls: [chatEl] });
    const rawNoDom = await rawDms(fakePage(), { readVia: 'api', settleMs: 0, contextWaitMs: 0, contextPollMs: 0 });
    assert.equal(rawNoDom.via, 'dom');
    assert.equal(rawNoDom.emptyState, false);
    assert.throws(() => parseDms(rawNoDom, { accountUid: ME, fetchedAt: new Date(T0).toISOString() }), /没显示空状态/);
  });

  test('tsOf("0") 返回 null 不产生 2000 年伪时间，且兼容跨 realm Date 对象', () => {
    const zeroTs = sdkConv('0:1:me:z1', { uid: 'z1', text: '零时间戳' });
    zeroTs.lastMessage.createdAt = '0';
    const crossRealmDate = sdkConv('0:1:me:d1', { uid: 'd1', text: '跨realm时间' });
    crossRealmDate.lastMessage.createdAt = { getTime: () => T0 - 5 * MIN };
    const ctx = { bytedIM: {}, loading: false, conversationList: [zeroTs, crossRealmDate], strangerConversationList: [] };
    const chatEl = { __reactFiber$test: { memoizedProps: { value: ctx }, return: null } };
    installFakeDoc({ domLis: [], chatEls: [chatEl] });

    const ctxRes = readDmContext();
    assert.equal(ctxRes.ok, true);
    const byId = new Map(ctxRes.conversations.map((c) => [c.id, c]));
    assert.equal(byId.get('0:1:me:z1').lastMessage.createdAt, null, '"0" 不得回落到 Date.parse("0")');
    assert.equal(byId.get('0:1:me:d1').lastMessage.createdAt, String(T0 - 5 * MIN));
  });
});

describe('首次基线、changedConversations 与 events.occurredAt', () => {
  test('已有 DOM 基线的账号首次切到 Context：旧陌生人与首屏外旧会话只建基线不发事件，之后新消息和新陌生人正常发事件', () => {
    const db = freshDb();
    const acc = douyin(db);
    // 第 1 轮（DOM）：建立普通 dms 基线
    const dom1 = { ...dmsSnap([conv('c1', { nick: '老朋友', at: '2026-11-19T01:00:00.000Z' })]), via: 'dom', strangerCount: 0 };
    const r0 = ingestSnapshot(db, acc, dom1, { now: at(T0) });
    assert.deepEqual(r0.events, []);
    assert.equal(r0.changedConversations, 1);

    // 第 2 轮（DOM 无变化）：changedConversations 为 0，且不提前写 dms:context / dms:stranger 基线
    const r0b = ingestSnapshot(db, acc, dom1, { now: at(T0 + 5 * MIN) });
    assert.equal(r0b.changedConversations, 0, '会话无变化时 changedConversations 为 0');

    // 第 3 轮（首次 Context）：发现历史陌生人 s1 和首屏外旧会话 c2，同时已有 c1 来了新消息
    const withNullNick = (item) => ({ ...item, peer: { ...item.peer, nickname: null } });
    const ctx1 = {
      ...dmsSnap([
        withNullNick(conv('c1', { at: '2026-11-19T02:05:00.000Z', text: '老朋友新消息' })),
        conv('c2', { nick: '历史普通会话', at: '2026-11-10T01:00:00.000Z', text: '很久以前' }),
        { ...withNullNick(conv('s1', { at: '2026-11-12T01:00:00.000Z', text: '陌生人旧消息' })), isStranger: true },
      ]),
      via: 'context',
      strangerCount: 1,
      hasStrangerList: true,
    };
    const r1 = ingestSnapshot(db, acc, ctx1, { now: at(T0 + 10 * MIN) });
    assert.deepEqual(r1.events, ['dm.received:Douyin:c1:2026-11-19T02:05:00.000Z'], '旧陌生人 s1 与历史 c2 只建基线不发事件；已有会话 c1 新消息照常发');
    assert.equal(r1.changedConversations, 3);
    assert.equal(r1.strangerCount, 1);
    assert.equal(r1.via, 'context');
    // 已有昵称在 Context 没拿到昵称时保留
    assert.equal(db.prepare("SELECT peerNickname FROM conversations WHERE id = 'Douyin:c1'").get().peerNickname, '老朋友');
    assert.ok(db.prepare("SELECT 1 FROM conversations WHERE id = 'Douyin:s1'").get(), '陌生人会话已入库建基线');

    // 第 4 轮（Context 无变化）：changedConversations 必须为 0
    const r2 = ingestSnapshot(db, acc, ctx1, { now: at(T0 + 20 * MIN) });
    assert.deepEqual(r2.events, []);
    assert.equal(r2.changedConversations, 0);
    assert.equal(r2.updated, 3);

    // 第 5 轮（Context）：s1 发来新消息 + 全新陌生人 s2 发来首条私信 → 两者都发 dm.received
    const ctx3 = {
      ...dmsSnap([
        withNullNick(conv('c1', { at: '2026-11-19T02:05:00.000Z', text: '老朋友新消息' })),
        conv('c2', { nick: '历史普通会话', at: '2026-11-10T01:00:00.000Z', text: '很久以前' }),
        { ...conv('s1', { nick: '陌生人甲', at: '2026-11-19T02:25:00.000Z', text: '还在吗' }), isStranger: true },
        { ...conv('s2', { nick: '陌生人乙', at: '2026-11-19T02:26:00.000Z', text: '你好想咨询' }), isStranger: true },
      ]),
      via: 'context',
      strangerCount: 2,
      hasStrangerList: true,
    };
    const r3 = ingestSnapshot(db, acc, ctx3, { now: at(T0 + 30 * MIN) });
    assert.deepEqual(r3.events.sort(), [
      'dm.received:Douyin:s1:2026-11-19T02:25:00.000Z',
      'dm.received:Douyin:s2:2026-11-19T02:26:00.000Z',
    ]);
    assert.equal(r3.changedConversations, 2);
    assert.equal(r3.strangerCount, 2);
  });

  test('Context 历史旧私信四种场景均挡住：首轮空后加载旧普通会话、首轮 last 为空次轮补旧消息、旧 DOM 不回退 lastAt、删近期会话露出历史会话', async () => {
    // 场景 1：首轮空快照建基线，次轮旧普通会话加载进来 -> 不发事件
    {
      const db = freshDb();
      const acc = douyin(db);
      const r1 = ingestSnapshot(db, acc, { ...dmsSnap([]), via: 'context', strangerCount: 0, hasStrangerList: true }, { now: at(T0) });
      assert.deepEqual(r1.events, []);
      const r2 = ingestSnapshot(db, acc, {
        ...dmsSnap([
          conv('c_old', { nick: '旧普通', at: new Date(T0 - 6 * HOUR).toISOString(), text: '六小时前' }),
          conv('c_new', { nick: '新普通', at: new Date(T0 + 5 * MIN).toISOString(), text: '基线后新消息' }),
        ]),
        via: 'context',
        strangerCount: 0,
        hasStrangerList: true,
      }, { now: at(T0 + 10 * MIN) });
      assert.deepEqual(r2.events, [`dm.received:Douyin:c_new:${new Date(T0 + 5 * MIN).toISOString()}`]);
    }

    // 场景 2：会话首轮 last 为空（before.lastAt == null），次轮补出旧消息 -> 不发事件；之后新消息照发
    {
      const db = freshDb();
      const acc = douyin(db);
      ingestSnapshot(db, acc, {
        ...dmsSnap([conv('c1', { last: null })]),
        via: 'context',
        strangerCount: 0,
        hasStrangerList: true,
      }, { now: at(T0) });
      const r2 = ingestSnapshot(db, acc, {
        ...dmsSnap([conv('c1', { at: new Date(T0 - 5 * HOUR).toISOString(), text: '历史旧消息' })]),
        via: 'context',
        strangerCount: 0,
        hasStrangerList: true,
      }, { now: at(T0 + 10 * MIN) });
      assert.deepEqual(r2.events, [], 'before.lastAt==null 补出早于基线的旧消息不得发事件');
      const r3 = ingestSnapshot(db, acc, {
        ...dmsSnap([conv('c1', { at: new Date(T0 + 15 * MIN).toISOString(), text: '新消息' })]),
        via: 'context',
        strangerCount: 0,
        hasStrangerList: true,
      }, { now: at(T0 + 20 * MIN) });
      assert.deepEqual(r3.events, [`dm.received:Douyin:c1:${new Date(T0 + 15 * MIN).toISOString()}`]);
    }

    // 场景 3：旧 DOM 快照不得让 conversations.lastAt 回退，后续重读已建基线消息不重发事件
    {
      const db = freshDb();
      const acc = douyin(db);
      const tBase = new Date(T0 - 5 * MIN).toISOString();
      const tStale = new Date(T0 - 3 * HOUR).toISOString();
      ingestSnapshot(db, acc, { ...dmsSnap([conv('c1', { at: tBase, text: '基线最新' })]), via: 'context', strangerCount: 0, hasStrangerList: true }, { now: at(T0) });
      const rStale = ingestSnapshot(db, acc, { ...dmsSnap([conv('c1', { at: tStale, text: '过时DOM' })]), via: 'dom', strangerCount: 0 }, { now: at(T0 + 5 * MIN) });
      assert.deepEqual(rStale.events, []);
      assert.equal(db.prepare("SELECT lastAt FROM conversations WHERE id = 'Douyin:c1'").get().lastAt, tBase, 'lastAt 只能前进不能回退');
      const rAgain = ingestSnapshot(db, acc, { ...dmsSnap([conv('c1', { at: tBase, text: '基线最新' })]), via: 'context', strangerCount: 0, hasStrangerList: true }, { now: at(T0 + 10 * MIN) });
      assert.deepEqual(rAgain.events, [], '重读已建基线消息不重复发事件');
    }

    // 场景 4：删掉近期会话后，更早的首屏外历史会话进入窗口 -> 不发事件
    {
      const db = freshDb();
      const acc = douyin(db);
      ingestSnapshot(db, acc, {
        ...dmsSnap([
          conv('c_recent', { at: new Date(T0 - 10 * MIN).toISOString() }),
          conv('c_mid', { at: new Date(T0 - 2 * HOUR).toISOString() }),
        ]),
        via: 'context',
        strangerCount: 0,
        hasStrangerList: true,
      }, { now: at(T0) });
      // 删掉 c_recent，窗口补进 c_ancient（2 天前）
      const r2 = ingestSnapshot(db, acc, {
        ...dmsSnap([
          conv('c_mid', { at: new Date(T0 - 2 * HOUR).toISOString() }),
          conv('c_ancient', { at: new Date(T0 - 48 * HOUR).toISOString(), text: '两天前旧私信' }),
        ]),
        via: 'context',
        strangerCount: 0,
        hasStrangerList: true,
      }, { now: at(T0 + 15 * MIN) });
      assert.deepEqual(r2.events, [], '窗口前移露出的历史旧会话不发事件');
    }
  });

  test('关闭 readViaApi 切回 DOM 路径时，派发结果与 origin/main 一致（Context 基线不压掉 DOM 读到的陌生人私信）', () => {
    const db = freshDb();
    const acc = douyin(db);
    // 先跑过一轮 Context（写下 dms / dms:context / dms:stranger 基线于 T0）
    ingestSnapshot(db, acc, {
      ...dmsSnap([conv('c1', { at: new Date(T0 - 10 * MIN).toISOString() })]),
      via: 'context',
      strangerCount: 0,
      hasStrangerList: true,
    }, { now: at(T0) });

    // 随后关闭 readViaApi 回到 DOM 路径：DOM 折叠行读到一个陌生人会话（last.at 早于 T0）
    const domStrangerAt = new Date(T0 - 3 * HOUR).toISOString();
    const rDom = ingestSnapshot(db, acc, {
      ...dmsSnap([
        conv('c1', { at: new Date(T0 - 10 * MIN).toISOString() }),
        { ...conv('s_dom', { nick: '陌生人甲', at: domStrangerAt, text: 'DOM先读到' }), isStranger: true },
      ]),
      via: 'dom',
      strangerCount: 1,
    }, { now: at(T0 + 15 * MIN) });
    assert.deepEqual(rDom.events, [`dm.received:Douyin:s_dom:${domStrangerAt}`], 'DOM 路径行为与 origin/main 一致，不被 Context 基线压掉');
  });

  test('占位昵称「陌生人消息」既不覆盖真实昵称，也不沿用旧行占位词到 payload.nickname', async () => {
    // 1. 回落 DOM 时，折叠行 header='陌生人消息' 不覆盖库里真实昵称
    const c1 = sdkConv('0:1:me:s1', { uid: 's1', stranger: true, text: '新消息', atMs: T0 + 5 * MIN });
    installFakeDoc({ domLis: [makeLi({ item: c1, headerText: '陌生人消息\n刚刚', ctxValue: null })] });
    const rawDom = await rawDms(fakePage(), { readVia: 'dom', settleMs: 0 });
    assert.equal(rawDom.conversations[0].name, null);
    const parsedDom = parseDms(rawDom, { accountUid: ME, fetchedAt: new Date(T0 + 5 * MIN).toISOString() });
    assert.equal(parsedDom.conversations[0].peer.nickname, null);

    const db = freshDb();
    const acc = douyin(db);
    ingestSnapshot(db, acc, dmsSnap([conv('0:1:me:s1', { nick: '真实昵称', at: new Date(T0 - 10 * MIN).toISOString() })]), { now: at(T0) });
    // 即使上层直接塞入占位昵称，也不得覆盖
    ingestSnapshot(db, acc, dmsSnap([conv('0:1:me:s1', { nick: '陌生人消息', at: new Date(T0 + 5 * MIN).toISOString() })]), { now: at(T0 + 6 * MIN) });
    assert.equal(db.prepare("SELECT peerNickname FROM conversations WHERE id = 'Douyin:0:1:me:s1'").get().peerNickname, '真实昵称');

    // 2. 升级前旧行存了 '陌生人消息'：Context 昵称为 null 时，库里清洗为 null 且事件 payload.nickname 不带占位词
    db.prepare("UPDATE conversations SET peerNickname = '陌生人消息' WHERE id = 'Douyin:0:1:me:s1'").run();
    const nextAt = new Date(T0 + 15 * MIN).toISOString();
    const r = ingestSnapshot(db, acc, {
      ...dmsSnap([{ ...conv('0:1:me:s1', { at: nextAt, text: '再问一句' }), peer: { uid: 's1', nickname: null, kind: 'user' }, isStranger: true }]),
      via: 'context',
      strangerCount: 1,
      hasStrangerList: true,
    }, { now: at(T0 + 16 * MIN) });
    assert.equal(r.events.length, 1);
    assert.equal(db.prepare("SELECT peerNickname FROM conversations WHERE id = 'Douyin:0:1:me:s1'").get().peerNickname, null);
    const evPayload = JSON.parse(db.prepare('SELECT payload FROM events WHERE id = ?').get(r.events[0]).payload);
    assert.equal(evPayload.nickname, null, 'payload.nickname 不得沿用旧行占位词');
  });

  test('双连接并发迁移不报 duplicate column name: occurredAt', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kin340-conc-')), 'ops.db');
    const setup = new DatabaseSync(file);
    setup.exec(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, platformCode TEXT NOT NULL, accountId TEXT, subjectId TEXT,
        createdAt TEXT NOT NULL, payload TEXT NOT NULL,
        handledAt TEXT, handledOutcome TEXT, handledNote TEXT, actionId TEXT
      );
    `);
    setup.close();

    const db1 = new DatabaseSync(file);
    const db2 = new DatabaseSync(file);
    db1.exec('PRAGMA busy_timeout=5000;');
    db2.exec('PRAGMA busy_timeout=5000;');
    // 确定性交错：db2 的 PRAGMA table_info(events) 看到缺 occurredAt 后，db1 抢先完成 ALTER
    const origPrepare = db2.prepare.bind(db2);
    let raced = false;
    db2.prepare = (sql) => {
      const stmt = origPrepare(sql);
      if (sql === 'PRAGMA table_info(events)' && !raced) {
        const origAll = stmt.all.bind(stmt);
        stmt.all = (...args) => {
          const cols = origAll(...args);
          if (!raced && !cols.some((c) => c.name === 'occurredAt')) {
            raced = true;
            migrateEngage(db1);
          }
          return cols;
        };
      }
      return stmt;
    };
    assert.doesNotThrow(() => migrateEngage(db2));
    assert.equal(raced, true, '确实触发了双连接并发竞争');
    assert.ok(db2.prepare('PRAGMA table_info(events)').all().some((c) => c.name === 'occurredAt'));
    db1.close();
    db2.close();
  });

  test('deliverPending 实际推送的 webhook JSON 字段集合不变（不泄漏 occurredAt）', async () => {
    const db = freshDb();
    const acc = douyin(db);
    subscribe(db, { subscriberId: 'bot-kin340', url: 'https://bot.example.test/hook', types: ['dm.received'] }, { now: at(T0 - MIN) });
    const sentAt = new Date(T0 - 30 * MIN).toISOString();
    const ingestMs = T0 + 5 * MIN;
    ingestSnapshot(db, acc, dmsSnap([conv('k0')]), { now: at(T0) });
    ingestSnapshot(db, acc, dmsSnap([conv('k0'), conv('k1', { nick: '张三', at: sentAt, text: '你好' })]), { now: at(ingestMs) });

    const posted = [];
    const fetchImpl = async (url, init) => {
      posted.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, text: async () => 'ok' };
    };
    await deliverPending(db, { now: at(ingestMs + MIN), fetchImpl, notify: async () => true });
    assert.equal(posted.length, 1);
    const body = posted[0].body;
    assert.deepEqual(Object.keys(body).sort(), ['batchId', 'events', 'sentAt', 'subscriberId']);
    assert.equal(body.events.length, 1);
    const ev = body.events[0];
    assert.deepEqual(Object.keys(ev).sort(), ['accountId', 'createdAt', 'delivery', 'handled', 'id', 'payload', 'platform', 'subjectId', 'type']);
    assert.equal('occurredAt' in ev, false, 'webhook JSON 不增加 occurredAt 字段');
    assert.deepEqual(Object.keys(ev.payload).sort(), ['at', 'conversationId', 'nickname', 'text']);
    assert.equal(ev.createdAt, new Date(ingestMs).toISOString());
    assert.equal(ev.payload.at, sentAt);
  });

  test('首轮 strangerConversationList 为空、次轮延迟加载出历史陌生人：早于基线的旧陌生人不灌事件，基线后的新陌生人正常发事件', () => {
    const db = freshDb();
    const acc = douyin(db);
    // 第 1 轮（T0）：strangerConversationList 尚未拉回（空数组），建立 dms:stranger 基线
    const r1 = ingestSnapshot(db, acc, {
      ...dmsSnap([conv('c1', { at: new Date(T0 - 5 * MIN).toISOString() })]),
      via: 'context',
      strangerCount: 0,
      hasStrangerList: true,
    }, { now: at(T0) });
    assert.deepEqual(r1.events, []);

    // 第 2 轮（T0 + 15m）：strangerConversationList 延迟加载出 1 条历史旧陌生人（24h 前）+ 1 条基线后新陌生人（T0 + 10m）
    const r2 = ingestSnapshot(db, acc, {
      ...dmsSnap([
        conv('c1', { at: new Date(T0 - 5 * MIN).toISOString() }),
        { ...conv('s_old', { nick: '历史陌生人', at: new Date(T0 - 24 * HOUR).toISOString(), text: '昨天的旧消息' }), isStranger: true },
        { ...conv('s_new', { nick: '新陌生人', at: new Date(T0 + 10 * MIN).toISOString(), text: '刚刚发来' }), isStranger: true },
      ]),
      via: 'context',
      strangerCount: 2,
      hasStrangerList: true,
    }, { now: at(T0 + 15 * MIN) });
    assert.deepEqual(r2.events, [`dm.received:Douyin:s_new:${new Date(T0 + 10 * MIN).toISOString()}`]);
    assert.equal(r2.changedConversations, 2);
    // s_old 已建基线入库，后续再发新消息会正常出事件
    const r3 = ingestSnapshot(db, acc, {
      ...dmsSnap([
        conv('c1', { at: new Date(T0 - 5 * MIN).toISOString() }),
        { ...conv('s_old', { nick: '历史陌生人', at: new Date(T0 + 20 * MIN).toISOString(), text: '又发了一条' }), isStranger: true },
        { ...conv('s_new', { nick: '新陌生人', at: new Date(T0 + 10 * MIN).toISOString(), text: '刚刚发来' }), isStranger: true },
      ]),
      via: 'context',
      strangerCount: 2,
      hasStrangerList: true,
    }, { now: at(T0 + 30 * MIN) });
    assert.deepEqual(r3.events, [`dm.received:Douyin:s_old:${new Date(T0 + 20 * MIN).toISOString()}`]);
  });

  test('events.occurredAt 写入对方发出时间，createdAt 保持入库时间且水位语义不变；迁移可重复且兼容旧 NULL 行', () => {
    // 模拟旧版库（没有 occurredAt 列）+ 已有旧事件行
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kin340-mig-')), 'ops.db');
    const rawDb = new DatabaseSync(file);
    rawDb.exec(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, platformCode TEXT NOT NULL, accountId TEXT, subjectId TEXT,
        createdAt TEXT NOT NULL, payload TEXT NOT NULL,
        handledAt TEXT, handledOutcome TEXT, handledNote TEXT, actionId TEXT
      );
      INSERT INTO events (id, type, platformCode, accountId, subjectId, createdAt, payload)
      VALUES ('dm.received:Douyin:legacy:2026-11-18T00:00:00.000Z', 'dm.received', 'Douyin', 'Douyin:106707338905', 'Douyin:legacy', '2026-11-18T00:05:00.000Z', '{"conversationId":"Douyin:legacy"}');
    `);
    migrateEngage(rawDb);
    migrateEngage(rawDb);   // 重复执行必须幂等
    const legacy = rawDb.prepare("SELECT createdAt, occurredAt FROM events WHERE id = 'dm.received:Douyin:legacy:2026-11-18T00:00:00.000Z'").get();
    assert.equal(legacy.createdAt, '2026-11-18T00:05:00.000Z');
    assert.equal(legacy.occurredAt, null);
    rawDb.close();

    // 新写入验证：dm.received 和 comment.created 都写 occurredAt，createdAt 为入库时间
    const db = freshDb();
    const acc = douyin(db);
    const ingestMs = T0 + 10 * HOUR;
    const dmSentIso = new Date(T0).toISOString();       // 10 小时前发出
    const commentIso = new Date(T0 + 9 * HOUR).toISOString();
    ingestSnapshot(db, acc, dmsSnap([conv('k0')]), { now: at(T0) });
    ingestSnapshot(db, acc, dmsSnap([conv('k0'), conv('k1', { at: dmSentIso, text: '延迟十小时的私信' })]), { now: at(ingestMs) });
    ingestSnapshot(db, acc, commentsSnap([comment('c0')]), { now: at(T0) });
    ingestSnapshot(db, acc, commentsSnap([comment('c0'), comment('c1', { createdAt: commentIso })]), { now: at(ingestMs) });

    const dmRow = db.prepare("SELECT createdAt, occurredAt FROM events WHERE subjectId = 'Douyin:k1'").get();
    assert.equal(dmRow.occurredAt, dmSentIso);
    assert.equal(dmRow.createdAt, new Date(ingestMs).toISOString());

    const cmRow = db.prepare("SELECT createdAt, occurredAt FROM events WHERE subjectId = 'Douyin:c1'").get();
    assert.equal(cmRow.occurredAt, commentIso);
    assert.equal(cmRow.createdAt, new Date(ingestMs).toISOString());

    // listEvents 水位（since）和 compact.at 仍按 createdAt（入库时间）算
    const sinceAfterSent = listEvents(db, { since: new Date(T0 + 5 * HOUR).toISOString() }).items;
    assert.equal(sinceAfterSent.length, 2, 'since 按 createdAt 过滤，不会漏掉延迟入库的事件');
    assert.equal(sinceAfterSent.find((e) => e.subjectId === 'Douyin:k1').createdAt, new Date(ingestMs).toISOString());
    const compact = listEvents(db, { compact: true }).items.find((e) => e.subjectId === 'Douyin:k1');
    assert.equal(compact.at, new Date(ingestMs).toISOString(), 'compactEvent.at 保持 createdAt 语义不变');
  });
});

describe('sync 自检统计与私信入库延迟告警', () => {
  test('stats 带 changedConversations/strangerCount/via；超阈值写日志并发飞书告警（含 6h 冷却、不泄正文）', async () => {
    const db = freshDb();
    setCapability(db, `Douyin:${ME}`, 'readDM', true);
    let nowMs = T0;
    const now = () => nowMs;
    const logs = [];
    const notices = [];
    const notify = async (text) => { notices.push(text); return true; };

    const snaps = [
      // 第 1 轮：首轮建立基线
      { ...dmsSnap([conv('c1', { at: new Date(T0 - 5 * MIN).toISOString() })]), via: 'context', strangerCount: 0, hasStrangerList: true },
      // 第 2 轮：无变化，changedConversations=0，不告警
      { ...dmsSnap([conv('c1', { at: new Date(T0 - 5 * MIN).toISOString() })]), via: 'context', strangerCount: 0, hasStrangerList: true },
      // 第 3 轮（T0 + 6h）：基线后发出的新陌生人私信延迟 5 小时才入库（超过 2h 阈值）→ 告警
      { ...dmsSnap([
        conv('c1', { at: new Date(T0 - 5 * MIN).toISOString() }),
        { ...conv('s1', { at: new Date(T0 + 1 * HOUR).toISOString(), text: '绝密私信正文不可进日志和告警' }), isStranger: true },
      ]), via: 'context', strangerCount: 1, hasStrangerList: true },
      // 第 4 轮（T0 + 6h15m，冷却期内）：又一条延迟 4 小时的新私信 → 写日志但不重复发飞书
      { ...dmsSnap([
        conv('c1', { at: new Date(T0 - 5 * MIN).toISOString() }),
        { ...conv('s1', { at: new Date(T0 + 1 * HOUR).toISOString(), text: '绝密私信正文不可进日志和告警' }), isStranger: true },
        { ...conv('s2', { at: new Date(T0 + 2 * HOUR + 15 * MIN).toISOString(), text: '第二条绝密正文' }), isStranger: true },
      ]), via: 'context', strangerCount: 2, hasStrangerList: true },
      // 第 5 轮（超过 6h 冷却）：又一条延迟 3 小时的新私信 → 再次发飞书
      { ...dmsSnap([
        conv('c1', { at: new Date(T0 - 5 * MIN).toISOString() }),
        { ...conv('s1', { at: new Date(T0 + 1 * HOUR).toISOString(), text: '绝密私信正文不可进日志和告警' }), isStranger: true },
        { ...conv('s2', { at: new Date(T0 + 2 * HOUR + 15 * MIN).toISOString(), text: '第二条绝密正文' }), isStranger: true },
        { ...conv('s3', { at: new Date(T0 + 6 * HOUR + 15 * MIN + DM_DELAY_ALERT_COOLDOWN_MS + 15 * MIN - 3 * HOUR).toISOString(), text: '第三条' }), isStranger: true },
      ]), via: 'dom', strangerCount: 3 },
    ];
    const collect = async () => snaps.shift();
    const base = { now, collect, notify, lockPath: tmpLock(), timeZone: 'Asia/Taipei', platforms: ['Douyin'], kinds: ['dms'], log: (s) => logs.push(s), fetchImpl: async () => { throw new Error('不该发网络请求'); } };

    const r1 = await runRound(db, base);
    assert.equal(r1.jobs[0].stats.changedConversations, 1);
    assert.equal(r1.jobs[0].stats.strangerCount, 0);
    assert.equal(r1.jobs[0].stats.via, 'context');
    assert.equal(notices.length, 0);

    nowMs += 15 * MIN;
    const r2 = await runRound(db, base);
    assert.equal(r2.jobs[0].stats.changedConversations, 0);
    assert.equal(r2.jobs[0].stats.updated, 1);
    assert.equal(notices.length, 0);

    nowMs = T0 + 6 * HOUR;
    const r3 = await runRound(db, base);
    assert.equal(r3.jobs[0].stats.changedConversations, 1);
    assert.equal(r3.jobs[0].stats.strangerCount, 1);
    assert.equal(r3.jobs[0].stats.via, 'context');
    assert.equal(r3.jobs[0].stats.maxDmDelayMs, 5 * HOUR);
    assert.equal(r3.jobs[0].stats.delayAlerted, true);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /入库延迟告警/);
    assert.match(notices[0], /5 小时/);
    assert.ok(!notices[0].includes('绝密'), '飞书告警不带私信正文');
    assert.ok(logs.some((l) => l.includes('入库延迟告警') && !l.includes('绝密')), '日志有告警且不带私信正文');

    nowMs += 15 * MIN;
    const r4 = await runRound(db, base);
    assert.equal(r4.jobs[0].stats.maxDmDelayMs, 4 * HOUR);
    assert.equal(r4.jobs[0].stats.delayAlerted, undefined, '6 小时冷却内不重复发飞书');
    assert.equal(notices.length, 1);
    assert.equal(logs.filter((l) => l.includes('入库延迟告警')).length, 1, '冷却期内不重复写告警日志');

    nowMs += DM_DELAY_ALERT_COOLDOWN_MS + 15 * MIN;
    const r5 = await runRound(db, base);
    assert.equal(r5.jobs[0].stats.maxDmDelayMs, 3 * HOUR);
    assert.equal(r5.jobs[0].stats.delayAlerted, true);
    assert.equal(r5.jobs[0].stats.via, 'dom');
    assert.equal(notices.length, 2, '冷却期过后再次提醒');
    assert.equal(DM_DELAY_ALERT_MS, 2 * HOUR);
  });
});
