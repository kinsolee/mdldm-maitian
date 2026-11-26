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
import { setCapability } from '../src/ops/accounts.mjs';
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

function installFakeDoc({ domLis = [], chatEls = [], emptyNode = false, bodyText = '' } = {}) {
  globalThis.document = {
    body: { innerText: bodyText },
    querySelector: (sel) => (sel === '.semi-list-empty' && emptyNode ? {} : null),
    querySelectorAll: (sel) => {
      if (sel === 'li.semi-list-item') return domLis;
      if (sel === '[class*=chat-]') return chatEls;
      if (sel === '[class*=semi-list]') return [];
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

  test('Context 明确加载完成且为空列表：emptyState=true，parseDms 返回合法空结果', async () => {
    const ctx = { bytedIM: {}, loading: false, conversationList: [], strangerConversationList: [] };
    const chatEl = { __reactFiber$test: { memoizedProps: { value: ctx }, return: null } };
    installFakeDoc({ domLis: [], chatEls: [chatEl] });

    const raw = await rawDms(fakePage(), { readVia: 'api', settleMs: 0, contextWaitMs: 0 });
    assert.equal(raw.via, 'context');
    assert.equal(raw.emptyState, true);
    assert.equal(raw.strangerCount, 0);
    const parsed = parseDms(raw, { accountUid: ME, fetchedAt: new Date(T0).toISOString() });
    assert.deepEqual(shapeErrors(parsed), []);
    assert.equal(parsed.conversations.length, 0);
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
    assert.equal(logs.filter((l) => l.includes('入库延迟告警')).length, 2, '冷却期内日志仍记录');

    nowMs += DM_DELAY_ALERT_COOLDOWN_MS + 15 * MIN;
    const r5 = await runRound(db, base);
    assert.equal(r5.jobs[0].stats.maxDmDelayMs, 3 * HOUR);
    assert.equal(r5.jobs[0].stats.delayAlerted, true);
    assert.equal(r5.jobs[0].stats.via, 'dom');
    assert.equal(notices.length, 2, '冷却期过后再次提醒');
    assert.equal(DM_DELAY_ALERT_MS, 2 * HOUR);
  });
});
