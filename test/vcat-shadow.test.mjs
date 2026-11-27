// 小V猫只读影子版测试（假上游 Streamable HTTP MCP，全离线）：
// 覆盖白名单过滤、写工具永不暴露/永不转发、refresh 强制 false、代理鉴权与 Host 校验、
// 采集跳过本人与 preRunHook 退出码、本机答题页回环与同源校验、以及 卡片→答案→入库→镜像→下次命中 完整闭环。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import {
  assertSafeKbExportPath,
  ensureProxyToken,
  parseCardsUrl,
  parseUpstreamUrl,
  proxyTokenFromFile,
  readConfig,
  resolveUpstreamToken,
} from '../integrations/vcat/config.mjs';
import { openShadowStore } from '../integrations/vcat/store.mjs';
import {
  VCAT_READ_WHITELIST,
  createUpstreamClient,
  parseToolResultJson,
  redactUpstreamError,
  sanitizeUpstreamArgs,
} from '../integrations/vcat/upstream.mjs';
import { collectFromUpstream } from '../integrations/vcat/collector.mjs';
import { notifyPendingCards } from '../integrations/vcat/notify.mjs';
import {
  LOCAL_TOOL_SCHEMAS,
  MCP_PATH,
  createVcatProxyHttp,
} from '../integrations/vcat/mcp-proxy.mjs';
import { runHook, PRECHECK_OK } from '../integrations/vcat/hook.mjs';
import { createCardsWebHandler } from '../integrations/vcat/cards-web.mjs';

const UPSTREAM_TOKEN = 'vcat_mcp_fake_upstream_token_for_unit_test_123456';
const PROXY_TOKEN = 'p'.repeat(43);

const WRITE_TOOL_NAMES = [
  'vcat_reply_comment',
  'vcat_send_message',
  'vcat_set_top_comment',
  'vcat_like_comment',
  'vcat_create_reply_comment_task',
  'vcat_draft_reply',
];

function rawHttp(port, { method = 'POST', pathName = MCP_PATH, headers = {}, body = '{}' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: pathName,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    if (method === 'POST' || method === 'PUT') req.end(body);
    else req.end();
  });
}

/** 启动一个假上游小V猫 Streamable HTTP MCP：同时注册白名单读工具与全部写工具，记录所有收到的调用。 */
async function startFakeUpstream() {
  const calls = [];
  const state = {
    accounts: [
      { uid: 'acc_dy_1', platform: 'Douyin', nickname: 'Kinso讲AI' },
      { uid: 'acc_bili_1', platform: 'Bili', nickname: 'KinsoB站' },
    ],
    comments: [
      {
        commentId: 'c1',
        platform: 'Douyin',
        uid: 'acc_dy_1',
        accountUid: 'acc_dy_1',
        workId: 'w1',
        workTitle: 'AI工作流实操',
        authorId: 'u_101',
        authorName: '阿明',
        isAuthor: false,
        content: '请问课程怎么报名？价格是多少？',
        createdAt: '2026-11-27T10:00:00+08:00',
      },
      {
        commentId: 'c2',
        platform: 'Bili',
        accountUid: 'acc_bili_1',
        workId: 'w2',
        workTitle: 'AI工作流实操',
        authorId: 'u_102',
        authorName: '小鹿',
        isAuthor: false,
        content: '这个课怎么报名啊，有没有链接',
        createdAt: '2026-11-27T10:05:00+08:00',
      },
      {
        commentId: 'c_self',
        platform: 'Douyin',
        accountUid: 'acc_dy_1',
        workId: 'w1',
        authorId: 'acc_dy_1',
        authorName: 'Kinso讲AI',
        isAuthor: true,
        content: '我自己回复的评论，不该进入 inbox',
        createdAt: '2026-11-27T10:06:00+08:00',
      },
      {
        commentId: 'c_ad',
        platform: 'Douyin',
        accountUid: 'acc_dy_1',
        workId: 'w1',
        authorId: 'u_ad',
        authorName: '低价中转站',
        isAuthor: false,
        content: '稳定API中转站低价出额度，私我领取',
        createdAt: '2026-11-27T10:07:00+08:00',
      },
    ],
    sessions: [
      { sessionId: 'sess_1', platform: 'Douyin', accountUid: 'acc_dy_1', peerId: 'p_1', peerName: '山风', unreadCount: 1 },
      { sessionId: 'sess_self_done', platform: 'Douyin', accountUid: 'acc_dy_1', peerId: 'p_2', peerName: '老周', unreadCount: 0 },
    ],
    sessionMessages: {
      sess_1: [
        { messageId: 'm0', fromSelf: false, senderName: '山风', content: '你好', sendTime: '2026-11-27T09:00:00+08:00' },
        { messageId: 'm1', fromSelf: true, senderName: 'Kinso讲AI', content: '你好请说', sendTime: '2026-11-27T09:05:00+08:00' },
        { messageId: 'm2', fromSelf: false, senderName: '山风', content: '开发票可以开专票吗？', sendTime: '2026-11-27T10:10:00+08:00' },
      ],
      sess_self_done: [
        { messageId: 'm10', fromSelf: false, senderName: '老周', content: '谢谢分享', sendTime: '2026-11-27T09:10:00+08:00' },
        { messageId: 'm11', fromSelf: true, senderName: 'Kinso讲AI', content: '客气哈', sendTime: '2026-11-27T09:12:00+08:00' },
      ],
    },
  };

  const allTools = [
    { name: 'vcat_list_accounts', description: '列账号', inputSchema: { type: 'object', properties: {} } },
    {
      name: 'vcat_list_comments',
      description: '列评论',
      inputSchema: {
        type: 'object',
        properties: {
          startDate: { type: 'string' },
          endDate: { type: 'string' },
          includeAuthor: { type: 'boolean' },
        },
      },
    },
    { name: 'vcat_get_comment_summary', description: '评论汇总', inputSchema: { type: 'object', properties: {} } },
    { name: 'vcat_get_unread_messages', description: '未读私信数', inputSchema: { type: 'object', properties: {} } },
    { name: 'vcat_list_message_sessions', description: '私信会话', inputSchema: { type: 'object', properties: {} } },
    {
      name: 'vcat_get_session_messages',
      description: '会话消息',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          uid: { type: 'string' },
          platform: { type: 'string' },
          refresh: { type: 'boolean', description: '是否实时刷新平台' },
        },
        required: ['sessionId'],
      },
    },
    ...WRITE_TOOL_NAMES.map((name) => ({
      name,
      description: `危险写工具 ${name}`,
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    })),
  ];

  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${UPSTREAM_TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'empty body' }));
      return;
    }
    const body = JSON.parse(raw);
    const mcp = new Server({ name: 'fake-vcat', version: '1.0.0' }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools }));
    mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args = {} } = request.params;
      calls.push({ name, args });
      if (name === 'vcat_list_accounts') return { content: [{ type: 'text', text: JSON.stringify({ accounts: state.accounts }) }] };
      if (name === 'vcat_list_comments') return { content: [{ type: 'text', text: JSON.stringify({ items: state.comments }) }] };
      if (name === 'vcat_get_comment_summary') return { content: [{ type: 'text', text: JSON.stringify({ total: state.comments.length }) }] };
      if (name === 'vcat_get_unread_messages') return { content: [{ type: 'text', text: JSON.stringify({ totalUnread: 1 }) }] };
      if (name === 'vcat_list_message_sessions') return { content: [{ type: 'text', text: JSON.stringify({ sessions: state.sessions }) }] };
      if (name === 'vcat_get_session_messages') {
        return { content: [{ type: 'text', text: JSON.stringify({ messages: state.sessionMessages[args.sessionId] || [] }) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ wrote: true, name }) }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close().catch(() => {}); mcp.close().catch(() => {}); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe('小V猫只读影子版（假上游全链路）', () => {
  let tmpDir;
  let fakeUpstream;
  let upstreamClient;
  let store;
  let proxyServer;
  let proxyPort;
  let proxyLogs;
  let cardsServer;
  let cardsPort;
  let kbExportFile;
  let feishuRequests;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-shadow-test-'));
    kbExportFile = path.join(tmpDir, '小V猫问答库.md');
    fakeUpstream = await startFakeUpstream();
    upstreamClient = createUpstreamClient({ url: fakeUpstream.url, token: UPSTREAM_TOKEN });
    const { exposedTools, droppedCount } = await upstreamClient.syncTools();
    assert.equal(droppedCount, WRITE_TOOL_NAMES.length);

    store = openShadowStore(path.join(tmpDir, 'shadow.db'));
    proxyLogs = [];
    feishuRequests = [];

    let proxyHandler;
    proxyServer = http.createServer((req, res) => proxyHandler(req, res));
    await new Promise((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
    proxyPort = proxyServer.address().port;
    proxyHandler = createVcatProxyHttp({
      store,
      upstream: upstreamClient,
      upstreamTools: exposedTools,
      token: PROXY_TOKEN,
      port: proxyPort,
      notifyOptions: {
        cardsUrl: 'http://127.0.0.1:8794/cards',
        webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-mock',
        fetchImpl: async (url, init) => {
          feishuRequests.push({ url, body: JSON.parse(init.body) });
          return new Response(JSON.stringify({ code: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        },
      },
      log: (line) => proxyLogs.push(line),
    });

    let cardsHandler;
    cardsServer = http.createServer((req, res) => cardsHandler(req, res));
    await new Promise((resolve) => cardsServer.listen(0, '127.0.0.1', resolve));
    cardsPort = cardsServer.address().port;
    cardsHandler = createCardsWebHandler({
      store,
      port: cardsPort,
      kbExportFile,
      log: () => {},
    });
  });

  after(async () => {
    await new Promise((resolve) => cardsServer.close(resolve));
    await new Promise((resolve) => proxyServer.close(resolve));
    await fakeUpstream.close();
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function connectProxy(token = PROXY_TOKEN, host = '127.0.0.1') {
    const transport = new StreamableHTTPClientTransport(new URL(`http://${host}:${proxyPort}${MCP_PATH}`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: 'test-cindy', version: '0.1.0' });
    await client.connect(transport);
    return client;
  }

  test('1. 写工具（含 vcat_draft_reply）永不暴露且直接调用一律拦截', async () => {
    const client = await connectProxy();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      const expected = [...VCAT_READ_WHITELIST, ...LOCAL_TOOL_SCHEMAS.map((t) => t.name)].sort();
      assert.deepEqual([...names].sort(), expected);
      for (const writeName of WRITE_TOOL_NAMES) {
        assert.ok(!names.includes(writeName), `${writeName} 绝不能暴露`);
        const res = await client.callTool({ name: writeName, arguments: { text: '禁止发送' } });
        assert.equal(res.isError, true, `${writeName} 直接调用必须报错`);
      }
      const sessionTool = tools.find((t) => t.name === 'vcat_get_session_messages');
      assert.deepEqual(sessionTool.inputSchema.properties.refresh.enum, [false]);
    } finally {
      await client.close();
    }
    assert.equal(fakeUpstream.calls.filter((c) => WRITE_TOOL_NAMES.includes(c.name)).length, 0);
  });

  test('2. refresh 无论传 true / 嵌套 / 省略，发往上游时一律强制为 false', async () => {
    assert.deepEqual(
      sanitizeUpstreamArgs('vcat_get_session_messages', { sessionId: 's1', refresh: true, nested: { refresh: true, forceRefresh: 1 } }),
      { sessionId: 's1', refresh: false, nested: { refresh: false, forceRefresh: false } },
    );
    const beforeCount = fakeUpstream.calls.length;
    const client = await connectProxy();
    try {
      const r1 = await client.callTool({ name: 'vcat_get_session_messages', arguments: { sessionId: 'sess_1', refresh: true } });
      assert.ok(!r1.isError);
      const r2 = await client.callTool({ name: 'vcat_get_session_messages', arguments: { sessionId: 'sess_1' } });
      assert.ok(!r2.isError);
    } finally {
      await client.close();
    }
    const newCalls = fakeUpstream.calls.slice(beforeCount);
    assert.equal(newCalls.length, 2);
    assert.equal(newCalls[0].args.refresh, false);
    assert.equal(newCalls[1].args.refresh, false);
  });

  test('3. 代理 HTTP 安全：Bearer 鉴权、Host 防 DNS rebinding、方法/路径与日志脱敏', async () => {
    const initBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    });
    assert.equal((await rawHttp(proxyPort, { body: initBody })).status, 401);
    assert.equal((await rawHttp(proxyPort, { body: initBody, headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await rawHttp(proxyPort, { body: initBody, headers: { Authorization: `Bearer ${PROXY_TOKEN}`, Host: `evil.test:${proxyPort}` } })).status, 403);
    assert.equal((await rawHttp(proxyPort, { pathName: '/other', headers: { Authorization: `Bearer ${PROXY_TOKEN}` } })).status, 404);
    assert.equal((await rawHttp(proxyPort, { method: 'GET', headers: { Authorization: `Bearer ${PROXY_TOKEN}` } })).status, 405);
    assert.equal((await rawHttp(proxyPort, { body: '{bad', headers: { Authorization: `Bearer ${PROXY_TOKEN}` } })).status, 400);
    assert.equal((await rawHttp(proxyPort, { body: initBody, headers: { Authorization: `Bearer ${PROXY_TOKEN}`, Host: `LOCALHOST:${proxyPort}` } })).status, 200);

    const allLogs = proxyLogs.join('\n');
    assert.ok(!allLogs.includes(PROXY_TOKEN));
    assert.ok(!allLogs.includes(UPSTREAM_TOKEN));
    assert.ok(!allLogs.includes('课程怎么报名'));
  });

  test('4. 答题页本机校验：回环 + Host + 无代理头 + 同源 Origin，违背任一项返回 403', async () => {
    const validHost = `127.0.0.1:${cardsPort}`;
    const validOrigin = `http://${validHost}`;
    assert.equal((await rawHttp(cardsPort, { method: 'GET', pathName: '/cards', headers: { Host: validHost } })).status, 200);
    assert.equal((await rawHttp(cardsPort, { method: 'GET', pathName: '/cards', headers: { Host: `evil.test:${cardsPort}` } })).status, 403);
    assert.equal((await rawHttp(cardsPort, { method: 'GET', pathName: '/cards', headers: { Host: validHost, 'X-Forwarded-For': '1.2.3.4' } })).status, 403);
    assert.equal((await rawHttp(cardsPort, { method: 'GET', pathName: '/cards', headers: { Host: validHost, 'CF-Connecting-IP': '1.2.3.4' } })).status, 403);

    // 写接口缺 Origin 或跨站 Origin 一律 403
    assert.equal((await rawHttp(cardsPort, { method: 'POST', pathName: '/api/cards/1/skip', headers: { Host: validHost }, body: '{}' })).status, 403);
    assert.equal((await rawHttp(cardsPort, { method: 'POST', pathName: '/api/cards/1/skip', headers: { Host: validHost, Origin: 'http://evil.test' }, body: '{}' })).status, 403);
    assert.equal((await rawHttp(cardsPort, { method: 'POST', pathName: '/api/cards/1/skip', headers: { Host: validHost, Origin: validOrigin, 'X-Real-IP': '127.0.0.1' }, body: '{}' })).status, 403);
    assert.equal((await rawHttp(cardsPort, { method: 'GET', pathName: '/api/cards/1/skip', headers: { Host: validHost } })).status, 405);
  });

  test('5. 完整影子闭环：采集(跳本人) → 出卡并合并聚合卡 → 飞书合批卡 → 答题入库+镜像 → 下次同类问题命中', async () => {
    // 第 1 轮：preRunHook 采集（跳过本人评论 c_self 和已回复会话 sess_self_done 以及 m0/m1）
    const hookConfig = { lookbackDays: 3, selfAuthors: [], cardsUrl: 'http://127.0.0.1:8794/cards' };
    const check1 = await runHook(['check'], { config: hookConfig, upstream: upstreamClient, store });
    assert.equal(check1.code, 0);
    assert.ok(check1.out.includes(PRECHECK_OK));
    // 应当只入库 4 条：c1、c2、c_ad、m2
    assert.equal(store.pendingCount(), 4);
    const dmCalls = fakeUpstream.calls.filter((c) => c.name === 'vcat_get_session_messages');
    assert.ok(dmCalls.every((c) => c.args.refresh === false));

    const client = await connectProxy();
    let aggCardId;
    let dmCardId;
    try {
      const pendingRes = await client.callTool({ name: 'pending_items', arguments: { limit: 20 } });
      const pendingData = JSON.parse(pendingRes.content[0].text);
      assert.equal(pendingData.count, 4);
      const itemC1 = pendingData.items.find((i) => i.id.endsWith(':c1'));
      const itemC2 = pendingData.items.find((i) => i.id.endsWith(':c2'));
      const itemAd = pendingData.items.find((i) => i.id.endsWith(':c_ad'));
      const itemDm = pendingData.items.find((i) => i.id.endsWith(':m2'));
      assert.ok(itemC1 && itemC2 && itemAd && itemDm);

      // 问答库为空时检索未命中
      const emptyKb = JSON.parse((await client.callTool({ name: 'kb_search', arguments: { query: itemC1.content, platform: 'Douyin' } })).content[0].text);
      assert.equal(emptyKb.autoReplyEnabled, false);
      assert.equal(emptyKb.count, 0);

      // 提交 c1 为新问题卡，再用相同 topicKey 提交 c2，验证自动合并为聚合卡
      const sub1 = JSON.parse((await client.callTool({
        name: 'card_submit',
        arguments: {
          inboxIds: [itemC1.id],
          cardType: 'comment',
          questionSummary: '课程怎么报名与价格咨询',
          suggestedReply: '这里不方便展开说，看我主页私聊发你课程介绍哈',
          topicKey: 'course-signup',
        },
      })).content[0].text);
      assert.equal(sub1.merged, false);
      assert.equal(sub1.card.cardType, 'comment');
      aggCardId = sub1.card.id;

      const sub2 = JSON.parse((await client.callTool({
        name: 'card_submit',
        arguments: {
          inboxIds: [itemC2.id],
          cardType: 'comment',
          questionSummary: '课程怎么报名与链接',
          suggestedReply: '看主页私聊发你',
          topicKey: 'course-signup',
        },
      })).content[0].text);
      assert.equal(sub2.merged, true);
      assert.equal(sub2.card.id, aggCardId);
      assert.equal(sub2.card.cardType, 'aggregate');
      assert.equal(sub2.card.items.length, 2);

      // 私信提交为 dm 卡片
      const subDm = JSON.parse((await client.callTool({
        name: 'card_submit',
        arguments: {
          inboxIds: [itemDm.id],
          cardType: 'dm',
          questionSummary: '是否支持开具增值税专票',
          suggestedReply: '目前支持普票，专票我先确认一下',
          topicKey: 'invoice-special',
        },
      })).content[0].text);
      dmCardId = subDm.card.id;
      assert.equal(subDm.card.cardType, 'dm');

      // 广告记为 shadow_record(ad)
      const recAd = JSON.parse((await client.callTool({
        name: 'shadow_record',
        arguments: { items: [{ inboxId: itemAd.id, decision: 'ad', reason: 'API 中转站引流广告' }] },
      })).content[0].text);
      assert.equal(recAd.shadowOnly, true);
      assert.equal(recAd.recorded, 1);
      assert.equal(recAd.rejected.length, 0);

      // 本轮合批推送飞书卡片，包含两张卡与「去处理」按钮
      const notify1 = JSON.parse((await client.callTool({ name: 'cards_notify', arguments: {} })).content[0].text);
      assert.equal(notify1.sent, true);
      assert.equal(notify1.count, 2);
      assert.equal(feishuRequests.length, 1);
      const feishuCard = feishuRequests[0].body.card;
      assert.equal(feishuRequests[0].body.msg_type, 'interactive');
      const actionEl = feishuCard.elements.find((e) => e.tag === 'action');
      assert.equal(actionEl.actions[0].text.content, '去处理');
      assert.equal(actionEl.actions[0].url, 'http://127.0.0.1:8794/cards');

      // 重复调用 cards_notify 不重复推送
      const notify2 = JSON.parse((await client.callTool({ name: 'cards_notify', arguments: {} })).content[0].text);
      assert.equal(notify2.sent, false);
      assert.equal(notify2.count, 0);
    } finally {
      await client.close();
    }

    // 收件箱已空：preRunHook 返回 exit 2 不花 token
    const checkIdle = await runHook(['check'], { config: hookConfig, upstream: upstreamClient, store });
    assert.equal(checkIdle.code, 2);
    assert.ok(checkIdle.out.includes(PRECHECK_OK));

    // Kinso 在本机答题页处理两张卡：聚合卡保存答案入库，私信卡选「不回」
    const validHost = `127.0.0.1:${cardsPort}`;
    const validHeaders = { Host: validHost, Origin: `http://${validHost}` };
    const ansRes = await rawHttp(cardsPort, {
      method: 'POST',
      pathName: `/api/cards/${aggCardId}/answer`,
      headers: validHeaders,
      body: JSON.stringify({
        question: '课程怎么报名和收费标准',
        platform: 'all',
        answer: '这里不方便展开说，看我主页私聊发你课程介绍和报名方式哈',
        keywords: '课程 报名 价格 链接',
      }),
    });
    assert.equal(ansRes.status, 200);
    const ansBody = JSON.parse(ansRes.body);
    assert.equal(ansBody.ok, true);
    assert.equal(ansBody.card.status, 'answered');
    assert.equal(ansBody.kbEntry.autoReply, false);
    assert.equal(ansBody.exportedTo, kbExportFile);

    // 重复答题同一张卡返回 409
    const dupAns = await rawHttp(cardsPort, {
      method: 'POST',
      pathName: `/api/cards/${aggCardId}/answer`,
      headers: validHeaders,
      body: JSON.stringify({ answer: '重复提交' }),
    });
    assert.equal(dupAns.status, 409);

    // 私信卡点「不回」
    const skipRes = await rawHttp(cardsPort, {
      method: 'POST',
      pathName: `/api/cards/${dmCardId}/skip`,
      headers: validHeaders,
      body: '{}',
    });
    assert.equal(skipRes.status, 200);
    assert.equal(JSON.parse(skipRes.body).card.status, 'skipped');

    // 验证数据库硬约束：影子期绝不允许把 kb_entries.auto_reply 改成 1
    assert.throws(() => store.db.exec('UPDATE kb_entries SET auto_reply = 1'), /CHECK constraint/i);

    // 验证只读 Markdown 镜像已导出
    const mdText = fs.readFileSync(kbExportFile, 'utf8');
    assert.ok(mdText.includes('课程怎么报名和收费标准'));
    assert.ok(mdText.includes('autoReply=false'));

    // 第 2 轮：假上游新增一条同类问题评论，验证能命中刚才入库的答案并记录 shadow_log(hit)
    fakeUpstream.state.comments.push({
      commentId: 'c3_repeat',
      platform: 'Douyin',
      accountUid: 'acc_dy_1',
      workId: 'w1',
      authorId: 'u_201',
      authorName: '新粉丝',
      isAuthor: false,
      content: '请问课程在哪里报名，收费怎么算？',
      createdAt: '2026-11-27T10:30:00+08:00',
    });
    const check2 = await runHook(['check'], { config: hookConfig, upstream: upstreamClient, store });
    assert.equal(check2.code, 0);
    assert.equal(store.pendingCount(), 1);

    const client2 = await connectProxy();
    try {
      const pending2 = JSON.parse((await client2.callTool({ name: 'pending_items', arguments: {} })).content[0].text);
      assert.equal(pending2.count, 1);
      const newItem = pending2.items[0];
      const searchRes = JSON.parse((await client2.callTool({
        name: 'kb_search',
        arguments: { query: newItem.content, platform: newItem.platform },
      })).content[0].text);
      assert.ok(searchRes.count >= 1, '应召回刚才入库的问答条目');
      const top = searchRes.candidates[0];
      assert.equal(top.id, ansBody.kbEntry.id);
      assert.equal(top.autoReply, false);
      assert.ok(top.score > 0.3);

      const hitRec = JSON.parse((await client2.callTool({
        name: 'shadow_record',
        arguments: {
          items: [{
            inboxId: newItem.id,
            decision: 'hit',
            kbEntryId: top.id,
            wouldReply: '这里不方便细说哈，看我主页私聊发你课程和报名说明',
            reason: '命中课程报名问答条目',
          }],
        },
      })).content[0].text);
      assert.equal(hitRec.recorded, 1);
    } finally {
      await client2.close();
    }

    const stats = store.stats();
    assert.equal(stats.inbox.pending, 0);
    assert.equal(stats.shadow.hit, 1);
    assert.equal(stats.shadow.newQuestion, 3);
    assert.equal(stats.shadow.ad, 1);
    assert.equal(stats.kb.total, 1);
    assert.equal(stats.kb.autoReplyEnabled, 0);
    // 全程零上游写工具调用
    assert.equal(fakeUpstream.calls.filter((c) => WRITE_TOOL_NAMES.includes(c.name)).length, 0);
  });
});

describe('配置与路径安全防护', () => {
  test('上游只允许本机回环 http', () => {
    assert.equal(parseUpstreamUrl('http://127.0.0.1:3199/mcp'), 'http://127.0.0.1:3199/mcp');
    assert.equal(parseUpstreamUrl('http://localhost:3199/mcp'), 'http://localhost:3199/mcp');
    assert.throws(() => parseUpstreamUrl('http://192.168.1.10:3199/mcp'), /回环/);
    assert.throws(() => parseUpstreamUrl('https://evil.example/mcp'), /http/);
  });

  test('问答库镜像路径禁止指向 OpenBot 正式文件或符号链接', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-cfg-'));
    try {
      assert.throws(() => assertSafeKbExportPath(path.join(dir, '评论私信回复记录.md')), /OpenBot/);
      assert.throws(() => assertSafeKbExportPath(path.join(dir, '评论私信待确认.md')), /OpenBot/);
      assert.throws(() => assertSafeKbExportPath(path.join(dir, '评论私信回复话术.md')), /OpenBot/);
      assert.throws(() => assertSafeKbExportPath(path.join(dir, 'kb.txt')), /\.md/);

      const realOpenBot = path.join(dir, '评论私信回复话术.md');
      const sym = path.join(dir, '小V猫问答库.md');
      fs.writeFileSync(realOpenBot, 'keep');
      fs.symlinkSync(realOpenBot, sym);
      assert.throws(() => assertSafeKbExportPath(sym), /符号链接/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('钥匙串使用独立 argv，默认账户可覆盖，环境令牌优先', () => {
    for (const account of ['', 'custom account']) {
      const cfg = readConfig({ VCAT_UPSTREAM_TOKEN_KEYCHAIN_SERVICE: 'my service', VCAT_UPSTREAM_TOKEN_KEYCHAIN_ACCOUNT: account });
      const execFile = (bin, args, opts) => {
        assert.equal(bin, '/usr/bin/security');
        assert.deepEqual(args, ['find-generic-password', '-s', 'my service', '-a', account || os.userInfo().username, '-w']);
        assert.equal(opts.shell, undefined);
        return ' fixture\n';
      };
      assert.equal(resolveUpstreamToken(cfg, { execFile }), 'fixture');
      assert.equal(resolveUpstreamToken({ ...cfg, upstreamTokenEnv: 'direct' }, { execFile: assert.fail }), 'direct');
    }
  });

  test('钥匙串失败或返回空值时停止，不泄漏错误内容', () => {
    const cfg = readConfig({ VCAT_UPSTREAM_TOKEN_KEYCHAIN_SERVICE: 'service' });
    for (const empty of [true, false]) {
      let calls = 0;
      const execFile = () => {
        calls++;
        if (empty) return ' ';
        throw Object.assign(new Error('private'), { status: 44, stdout: 'private', stderr: 'private' });
      };
      assert.throws(() => resolveUpstreamToken(cfg, { execFile }), { message: empty ? 'keychain_read_failed' : 'keychain_read_failed (exit 44)' });
      assert.equal(calls, 1);
    }
  });

  test('resolveUpstreamToken 支持 env 优先或启动时 op read（不落盘）', () => {
    assert.equal(resolveUpstreamToken({ upstreamTokenEnv: 'vcat_mcp_direct', upstreamTokenOpRef: '', opBin: 'op' }), 'vcat_mcp_direct');
    let received = null;
    const tok = resolveUpstreamToken(
      { upstreamTokenEnv: '', upstreamTokenOpRef: 'op://Private/小V猫 MCP/credential', opBin: '/opt/homebrew/bin/op' },
      {
        execFile: (bin, args) => {
          received = { bin, args };
          return 'vcat_mcp_from_op\n';
        },
      },
    );
    assert.equal(tok, 'vcat_mcp_from_op');
    assert.deepEqual(received, { bin: '/opt/homebrew/bin/op', args: ['read', 'op://Private/小V猫 MCP/credential'] });
    assert.throws(
      () => resolveUpstreamToken(
        { upstreamTokenEnv: '', upstreamTokenOpRef: 'op://Private/小V猫 MCP/credential', opBin: 'op' },
        { execFile: () => { throw new Error('item not found'); } },
      ),
      /小V猫 MCP/,
    );
  });

  test('ensureProxyToken 自动生成 0600 权限 .env 令牌', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-env-'));
    try {
      const envFile = path.join(dir, '.env');
      const env = {};
      const token = ensureProxyToken(env, envFile);
      assert.ok(token.length >= 43);
      assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
      assert.equal(ensureProxyToken(env, envFile), token);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('第 1 轮评审阻断项回归测试', () => {
  test('R1-1 & N1：全部白名单工具未传 refresh 时也强制补 false，且 syncTools 跟随 nextCursor 翻页', async () => {
    assert.deepEqual(sanitizeUpstreamArgs('vcat_list_accounts', {}), { refresh: false });
    assert.deepEqual(sanitizeUpstreamArgs('vcat_list_comments', undefined), { refresh: false });
    assert.deepEqual(sanitizeUpstreamArgs('vcat_get_unread_messages', { refresh: true }), { refresh: false });

    const seenCalls = [];
    const server = http.createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'empty body' }));
        return;
      }
      const body = JSON.parse(raw);
      const mcp = new Server({ name: 'paged-fake', version: '0.1.0' }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async (request) => {
        const cursor = request.params?.cursor;
        if (!cursor) {
          return {
            tools: [
              { name: 'vcat_list_accounts', description: 'p1', inputSchema: { type: 'object', properties: {} } },
              { name: 'vcat_reply_comment', description: 'write', inputSchema: { type: 'object', properties: {} } },
            ],
            nextCursor: 'page2',
          };
        }
        return {
          tools: [
            { name: 'vcat_get_session_messages', description: 'p2', inputSchema: { type: 'object', properties: { refresh: { type: 'boolean' } } } },
          ],
        };
      });
      mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
        seenCalls.push({ name: request.params.name, args: request.params.arguments });
        return { content: [{ type: 'text', text: JSON.stringify({ accounts: [] }) }] };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { transport.close().catch(() => {}); mcp.close().catch(() => {}); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const upstream = createUpstreamClient({ url: `http://127.0.0.1:${server.address().port}/mcp`, token: UPSTREAM_TOKEN });
      const synced = await upstream.syncTools();
      assert.deepEqual(synced.exposedTools.map((t) => t.name).sort(), ['vcat_get_session_messages', 'vcat_list_accounts']);
      assert.equal(synced.droppedCount, 1);
      await upstream.callReadTool('vcat_list_accounts', {});
      assert.equal(seenCalls[0].args.refresh, false);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test('R1-2：上游 HTTP 错误体与工具错误正文均严格脱敏，不泄露敏感内容', async () => {
    const secretLeak = 'SENSITIVE_COOKIE_OR_BODY_987654';
    const badServer = http.createServer((_req, res) => {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`upstream failed: ${secretLeak}`);
    });
    await new Promise((r) => badServer.listen(0, '127.0.0.1', r));
    try {
      const upstream = createUpstreamClient({ url: `http://127.0.0.1:${badServer.address().port}/mcp`, token: UPSTREAM_TOKEN });
      await assert.rejects(
        () => upstream.syncTools(),
        (err) => {
          assert.match(err.message, /HTTP 502/);
          assert.ok(!err.message.includes(secretLeak), '异常消息不应泄露上游响应正文');
          return true;
        },
      );
      assert.throws(
        () => parseToolResultJson({ isError: true, content: [{ type: 'text', text: secretLeak }] }),
        (err) => !err.message.includes(secretLeak),
      );
      const redacted = redactUpstreamError(new Error(`Error POSTing to endpoint (HTTP 500): ${secretLeak}`), '测试');
      assert.ok(!redacted.message.includes(secretLeak));
      assert.match(redacted.message, /HTTP 500/);
    } finally {
      await new Promise((r) => badServer.close(r));
    }
  });

  test('R1-3：锁定端口 8793/8794 与本机答题页 URL；运行中 .env 变为 0644 或符号链接立即拒用', () => {
    assert.throws(() => readConfig({ VCAT_PROXY_PORT: '8787' }), /8793/);
    assert.throws(() => readConfig({ VCAT_CARDS_PORT: '9000' }), /8794/);
    assert.throws(() => parseCardsUrl('https://evil.example/cards', 8794), /http/);
    assert.throws(() => parseCardsUrl('http://127.0.0.1:8787/cards', 8794), /8794/);
    assert.throws(() => parseCardsUrl('http://127.0.0.1:8794/other', 8794), /\/cards/);
    assert.equal(parseCardsUrl('http://localhost:8794/cards', 8794), 'http://localhost:8794/cards');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-perm-'));
    try {
      const envFile = path.join(dir, '.env');
      const validToken = 't'.repeat(43);
      fs.writeFileSync(envFile, `VCAT_PROXY_TOKEN=${validToken}\n`, { mode: 0o600 });
      fs.chmodSync(envFile, 0o600);
      const readToken = proxyTokenFromFile(envFile);
      assert.equal(readToken(), validToken);

      // 运行中把权限放宽为 0644，热读必须立刻失效返回 null
      fs.chmodSync(envFile, 0o644);
      assert.equal(readToken(), null);

      // 收紧回 0600 立刻恢复
      fs.chmodSync(envFile, 0o600);
      assert.equal(readToken(), validToken);

      // 换成符号链接也必须拒用
      const realEnv = path.join(dir, 'real.env');
      fs.renameSync(envFile, realEnv);
      fs.symlinkSync(realEnv, envFile);
      assert.equal(readToken(), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('R1-4 & N2：已处理 inbox 禁止重复出卡入库；多平台聚合卡合并 3 次无重复平台', () => {
    const store = openShadowStore(':memory:');
    try {
      store.ingestInbox([
        { id: 'c:1', kind: 'comment', platform: 'Douyin', content: '怎么报名', occurredAt: '2026-11-27T01:00:00.000Z' },
        { id: 'c:2', kind: 'comment', platform: 'Bili', content: '怎么报名2', occurredAt: '2026-11-27T01:01:00.000Z' },
        { id: 'c:3', kind: 'comment', platform: 'XHS', content: '怎么报名3', occurredAt: '2026-11-27T01:02:00.000Z' },
      ]);
      const first = store.submitCard({ inboxIds: ['c:1'], questionSummary: '课程报名', topicKey: 'course' });
      const second = store.submitCard({ inboxIds: ['c:2'], questionSummary: '课程报名', topicKey: 'course' });
      const third = store.submitCard({ inboxIds: ['c:3'], questionSummary: '课程报名', topicKey: 'course' });
      assert.equal(second.card.id, first.card.id);
      assert.equal(third.card.id, first.card.id);
      assert.equal(third.card.platform, 'Bili,Douyin,XHS');

      const answered = store.answerCard(first.card.id, { answer: '看主页私聊' });
      assert.equal(answered.ok, true);

      // 已答完的 inbox 重放 card_submit 必须报错，不能再建新卡或改旧 shadow_log
      assert.throws(
        () => store.submitCard({ inboxIds: ['c:1'], questionSummary: '课程报名', topicKey: 'course' }),
        /禁止重复出卡/,
      );
      assert.equal(store.stats().cards.total, 1);
      assert.equal(store.stats().kb.total, 1);
    } finally {
      store.close();
    }
  });

  test('R1-5：shadow_record 严格要求 new_question 绑定已建卡、hit 必须带有效 kbEntryId', () => {
    const store = openShadowStore(':memory:');
    try {
      store.ingestInbox([
        { id: 'i:1', kind: 'comment', platform: 'Douyin', content: '问题1', occurredAt: '2026-11-27T01:00:00.000Z' },
        { id: 'i:2', kind: 'comment', platform: 'Douyin', content: '问题2', occurredAt: '2026-11-27T01:01:00.000Z' },
      ]);
      const card1 = store.submitCard({ inboxIds: ['i:1'], questionSummary: '问题1' });
      // i:2 试图不带 cardId 或借用 card1 的 cardId 记 new_question，以及缺 kbEntryId 记 hit，都必须被拒绝且不标已处理
      const res = store.recordShadow([
        { inboxId: 'i:2', decision: 'new_question' },
        { inboxId: 'i:2', decision: 'new_question', cardId: card1.card.id },
        { inboxId: 'i:2', decision: 'hit', wouldReply: '假命中' },
      ]);
      assert.equal(res.recorded, 0);
      assert.equal(res.rejected.length, 3);
      assert.equal(store.pendingCount(), 1, '被拒条目不能退出待办');
    } finally {
      store.close();
    }
  });

  test('R1-6：上游返回非 JSON 或缺少列表字段时 fail-closed 抛错，不误报空闲 exit 2', async () => {
    const store = openShadowStore(':memory:');
    try {
      const brokenNonJsonUpstream = {
        async callReadTool() {
          return { content: [{ type: 'text', text: 'not-a-json-payload' }] };
        },
      };
      await assert.rejects(
        () => runHook(['check'], { config: { lookbackDays: 3, selfAuthors: [] }, upstream: brokenNonJsonUpstream, store }),
        /非 JSON/,
      );
      assert.equal(store.getMeta('lastCollectAt'), null);

      const missingListUpstream = {
        async callReadTool() {
          return { content: [{ type: 'text', text: JSON.stringify({ status: 'ok', message: 'unexpected shape' }) }] };
        },
      };
      await assert.rejects(
        () => runHook(['check'], { config: { lookbackDays: 3, selfAuthors: [] }, upstream: missingListUpstream, store }),
        /缺少列表字段/,
      );
      assert.equal(store.getMeta('lastCollectAt'), null);
    } finally {
      store.close();
    }
  });

  test('R1-7：会话超过单轮配额时按轮转游标覆盖后续会话；本人识别按明确 ID 优先不误杀同名粉丝且识别 userId', async () => {
    const store = openShadowStore(':memory:');
    try {
      const fakeUpstream = {
        async callReadTool(name, args) {
          if (name === 'vcat_list_accounts') {
            return { content: [{ type: 'text', text: JSON.stringify({ accounts: [{ uid: 'acc_me', platform: 'Douyin', nickname: 'Kinso讲AI' }] }) }] };
          }
          if (name === 'vcat_list_comments') {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  comments: [
                    // 同名但 authorId 明确不同 -> 粉丝，绝不能误杀
                    { commentId: 'fan_same_name', platform: 'Douyin', accountUid: 'acc_me', authorId: 'fan_999', authorName: 'Kinso讲AI', content: '我也是同名粉丝来提问' },
                    // 仅用 userId 表示本人 -> 必须跳过
                    { commentId: 'me_by_userid', platform: 'Douyin', accountUid: 'acc_me', userId: 'acc_me', authorName: '小号昵称', content: '这是本人用 userId 发的回复' },
                  ],
                }),
              }],
            };
          }
          if (name === 'vcat_list_message_sessions') {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  sessions: [1, 2, 3, 4, 5].map((n) => ({
                    sessionId: `sess_${n}`,
                    platform: 'Douyin',
                    accountUid: 'acc_me',
                    peerName: `粉丝${n}`,
                    peerId: `peer_${n}`,
                  })),
                }),
              }],
            };
          }
          if (name === 'vcat_get_session_messages') {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  messages: [{ messageId: `m_${args.sessionId}`, fromSelf: false, senderId: `peer_${args.sessionId}`, content: `来自 ${args.sessionId} 的私信` }],
                }),
              }],
            };
          }
          throw new Error(`unexpected tool ${name}`);
        },
      };

      // 单轮上限设为 2，连跑 3 轮应覆盖全部 5 个会话，且同名粉丝入库、userId 本人被跳过
      const r1 = await collectFromUpstream({ upstream: fakeUpstream, store, maxSessionsPerPoll: 2 });
      assert.equal(r1.inspectedSessions, 2);
      const r2 = await collectFromUpstream({ upstream: fakeUpstream, store, maxSessionsPerPoll: 2 });
      assert.equal(r2.inspectedSessions, 2);
      const r3 = await collectFromUpstream({ upstream: fakeUpstream, store, maxSessionsPerPoll: 2 });
      assert.equal(r3.inspectedSessions, 2);

      const items = store.pendingItems(20);
      const ids = items.map((i) => i.id);
      assert.ok(ids.some((id) => id.includes('fan_same_name')), '同名但不同 ID 的粉丝不能被误杀');
      assert.ok(!ids.some((id) => id.includes('me_by_userid')), 'userId 匹配本人必须被跳过');
      for (let n = 1; n <= 5; n += 1) {
        assert.ok(ids.some((id) => id.includes(`sess_${n}`)), `第 ${n} 个会话不应被遗漏`);
      }
    } finally {
      store.close();
    }
  });

  test('HTTP 504 后保留认领，下一轮不重复投递', async () => {
    const store = openShadowStore(':memory:');
    try {
      store.ingestInbox([{ id: 'n:1', kind: 'comment', platform: 'Douyin', content: '问1', occurredAt: '2026-11-27T01:00:00.000Z' }]);
      store.submitCard({ inboxIds: ['n:1'], questionSummary: '问1', topicKey: 'same-topic' });
      let posts = 0;
      const options = {
        webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/fake',
        fetchImpl: async (_url, init) => {
          assert.equal(init.method, 'POST');
          posts += 1;
          return new Response(null, { status: 504 });
        },
      };
      const first = await notifyPendingCards(store, options);
      assert.equal(first.uncertainCount, 1);
      await notifyPendingCards(store, options);
      assert.equal(posts, 1);
    } finally {
      store.close();
    }
  });

  test('R1-8：飞书通知原子互斥防重发、合并新问题不被旧回写覆盖、非 JSON 拒判成功、遗留未发卡片唤醒 preRunHook', async () => {
    const store = openShadowStore(':memory:');
    try {
      store.ingestInbox([
        { id: 'n:1', kind: 'comment', platform: 'Douyin', content: '问1', occurredAt: '2026-11-27T01:00:00.000Z' },
        { id: 'n:2', kind: 'comment', platform: 'Bili', content: '问2', occurredAt: '2026-11-27T01:01:00.000Z' },
      ]);
      const c1 = store.submitCard({ inboxIds: ['n:1'], questionSummary: '问1', topicKey: 'same-topic' });

      // inbox 全部已处理但卡片未通知时，hook check --no-collect 必须返回 exit 0 以唤醒补发
      const pre = await runHook(['check', '--no-collect'], { config: {}, store });
      assert.equal(pre.code, 0);

      // 确定失败（HTTP 400）应释放认领锁允许后续重试，不写 notified_at
      const http400Res = await notifyPendingCards(store, {
        webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/fake',
        fetchImpl: async () => new Response('bad request', { status: 400 }),
      });
      assert.equal(http400Res.sent, false);
      assert.equal(http400Res.uncertain, false);
      assert.equal(store.unnotifiedPendingCount(), 1);

      // 并发调用两次 notifyPendingCards：第二次不得重复发请求；且发送期间合并了 n:2 后，旧请求回写不能吞掉更新后的卡
      let fetchCount = 0;
      let releaseFetch;
      const slowFetch = () => {
        fetchCount += 1;
        return new Promise((resolve) => {
          releaseFetch = () => resolve(new Response(JSON.stringify({ code: 0 }), { status: 200 }));
        });
      };
      const p1 = notifyPendingCards(store, { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/fake', fetchImpl: slowFetch });
      const p2 = notifyPendingCards(store, { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/fake', fetchImpl: slowFetch });
      const r2 = await p2;
      assert.equal(r2.sent, false);
      assert.equal(r2.reason, 'no_unnotified_cards');
      assert.equal(fetchCount, 1);

      // 在 p1 尚在途期间，同主题合并进新问题 n:2（notify_version 递增）
      store.submitCard({ inboxIds: ['n:2'], questionSummary: '问1', topicKey: 'same-topic' });
      releaseFetch();
      const r1 = await p1;
      assert.equal(r1.sent, true);
      assert.equal(r1.confirmed, 0, '旧版本通知回写不应把已合并新问题的卡片标为已通知');
      assert.equal(store.getCard(c1.card.id).notifiedAt, null);
      assert.equal(store.unnotifiedPendingCount(), 1);
    } finally {
      store.close();
    }
  });

  test('R1-9 & R1-10：父目录符号链接拦截、超过 1000 条全量导出不截断、目录不可写时不脏写数据库', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-export-'));
    const store = openShadowStore(':memory:');
    try {
      // 1. 父目录符号链接拦截
      const realTargetDir = path.join(dir, 'real-dir');
      const symParentDir = path.join(dir, 'sym-dir');
      fs.mkdirSync(realTargetDir, { recursive: true });
      fs.symlinkSync(realTargetDir, symParentDir);
      assert.throws(() => assertSafeKbExportPath(path.join(symParentDir, '小V猫问答库.md')), /符号链接/);

      // 2. 导出目录无写权限：answerCard 在写库前报错，卡片保持 pending，修好权限后可正常入库不撞 409
      const roDir = path.join(dir, 'readonly-dir');
      fs.mkdirSync(roDir, { recursive: true });
      fs.chmodSync(roDir, 0o555);
      store.ingestInbox([{ id: 'ro:1', kind: 'comment', platform: 'Douyin', content: '权限测试', occurredAt: '2026-11-27T01:00:00.000Z' }]);
      const roCard = store.submitCard({ inboxIds: ['ro:1'], questionSummary: '权限测试' });
      const roTarget = path.join(roDir, '小V猫问答库.md');
      assert.throws(() => store.answerCard(roCard.card.id, { answer: '答案A' }, { kbExportFile: roTarget }));
      assert.equal(store.getCard(roCard.card.id).status, 'pending');
      assert.equal(store.stats().kb.total, 0);

      fs.chmodSync(roDir, 0o755);
      const fixed = store.answerCard(roCard.card.id, { answer: '答案A' }, { kbExportFile: roTarget });
      assert.equal(fixed.ok, true);
      assert.equal(store.stats().kb.total, 1);

      // 3. 超过 1000 条全量导出不截断
      const insertKb = store.db.prepare(`
        INSERT INTO kb_entries (question, answer, platform, source_card_id, auto_reply, keywords, created_at, updated_at)
        VALUES (?, ?, 'all', NULL, 0, '', '2026-11-27T01:00:00.000Z', '2026-11-27T01:00:00.000Z')
      `);
      for (let i = 1; i <= 1004; i += 1) {
        insertKb.run(`批量问题_${i}`, `批量答案_${i}`);
      }
      const fullFile = path.join(realTargetDir, '小V猫问答库.md');
      store.exportKbMarkdown(fullFile);
      const md = fs.readFileSync(fullFile, 'utf8');
      assert.match(md, /entries: 1005/);
      assert.ok(md.includes('批量问题_1') && md.includes('批量问题_1004'), '最早与最新条目均应完整保留在镜像中');
    } finally {
      store.close();
      try { fs.chmodSync(path.join(dir, 'readonly-dir'), 0o755); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('R1-11：答题页有建议回复时「用这个答案」按钮可点击，无建议回复时禁用', async () => {
    const store = openShadowStore(':memory:');
    const server = http.createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    server.on('request', createCardsWebHandler({ store, port, log: () => {} }));
    try {
      const page = await rawHttp(port, { method: 'GET', pathName: '/cards', headers: { Host: `127.0.0.1:${port}` } });
      assert.equal(page.status, 200);
      const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(page.body);
      assert.ok(scriptMatch);

      function makeMockNode(tag) {
        return {
          tag,
          attrs: {},
          children: [],
          disabled: false,
          className: '',
          textContent: '',
          value: '',
          dataset: {},
          classList: { toggle() {} },
          setAttribute(k, v) { this.attrs[k] = v; if (k === 'disabled') this.disabled = true; },
          addEventListener() {},
          append(...nodes) { this.children.push(...nodes); },
          replaceChildren(...nodes) { this.children = nodes; },
        };
      }
      const elementsById = {
        stats: makeMockNode('div'),
        content: makeMockNode('div'),
        toast: makeMockNode('div'),
        refreshBtn: makeMockNode('button'),
      };
      const sandbox = {
        document: {
          createElement: makeMockNode,
          createTextNode: (t) => ({ text: t }),
          getElementById: (id) => elementsById[id] || makeMockNode('div'),
          querySelectorAll: () => [],
        },
        fetch: async () => ({ ok: true, json: async () => ({ stats: { cards: { pending: 0 }, kb: { total: 0 }, shadow: { hit: 0, newQuestion: 0, ad: 0, skip: 0 } }, cards: [], entries: [], shadowLog: [] }) }),
        setTimeout: () => 0,
        clearTimeout: () => {},
      };
      vm.runInNewContext(`${scriptMatch[1]}\nthis.__renderPendingCard = renderPendingCard;`, sandbox);

      function findUseButton(node) {
        if (!node || typeof node !== 'object') return null;
        if (node.tag === 'button' && node.textContent === '用这个答案') return node;
        for (const child of node.children || []) {
          const found = findUseButton(child);
          if (found) return found;
        }
        return null;
      }

      const cardWithSuggestion = sandbox.__renderPendingCard({
        id: 1,
        cardType: 'comment',
        platform: 'Douyin',
        questionSummary: '怎么报名',
        suggestedReply: '看主页私聊',
        items: [],
      });
      const enabledBtn = findUseButton(cardWithSuggestion);
      assert.ok(enabledBtn);
      assert.equal(enabledBtn.disabled, false);
      assert.equal(Object.prototype.hasOwnProperty.call(enabledBtn.attrs, 'disabled'), false);

      const cardWithoutSuggestion = sandbox.__renderPendingCard({
        id: 2,
        cardType: 'comment',
        platform: 'Douyin',
        questionSummary: '新问题',
        suggestedReply: '',
        items: [],
      });
      const disabledBtn = findUseButton(cardWithoutSuggestion);
      assert.ok(disabledBtn);
      assert.equal(disabledBtn.disabled, true);
    } finally {
      await new Promise((r) => server.close(r));
      store.close();
    }
  });
});

describe('第 2 轮评审阻断与非阻断回归测试', () => {
  test('R2-1：tools/list 超过 20 页正常翻完第 21 页；超上限或循环游标 fail-closed 抛错', async () => {
    // 场景 A：21 页有效分页，白名单工具在第 21 页必须被发现
    const server21 = http.createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const mcp = new Server({ name: 'paged-21', version: '0.1.0' }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async (request) => {
        const page = Number(request.params?.cursor || 1);
        if (page < 21) {
          return {
            tools: [{ name: `vcat_dummy_tool_${page}`, description: 'non-whitelist', inputSchema: { type: 'object', properties: {} } }],
            nextCursor: String(page + 1),
          };
        }
        return {
          tools: [{ name: 'vcat_list_accounts', description: 'on page 21', inputSchema: { type: 'object', properties: {} } }],
        };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { transport.close().catch(() => {}); mcp.close().catch(() => {}); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    });
    await new Promise((r) => server21.listen(0, '127.0.0.1', r));

    // 场景 B：循环游标必须 fail-closed 抛错，不得静默截断
    const serverLoop = http.createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const mcp = new Server({ name: 'paged-loop', version: '0.1.0' }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: 'vcat_list_accounts', description: 'loop', inputSchema: { type: 'object', properties: {} } }],
        nextCursor: 'same-cursor',
      }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { transport.close().catch(() => {}); mcp.close().catch(() => {}); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    });
    await new Promise((r) => serverLoop.listen(0, '127.0.0.1', r));

    try {
      const up21 = createUpstreamClient({ url: `http://127.0.0.1:${server21.address().port}/mcp`, token: UPSTREAM_TOKEN });
      const synced = await up21.syncTools();
      assert.deepEqual(synced.exposedTools.map((t) => t.name), ['vcat_list_accounts']);

      const upLoop = createUpstreamClient({ url: `http://127.0.0.1:${serverLoop.address().port}/mcp`, token: UPSTREAM_TOKEN });
      await assert.rejects(() => upLoop.syncTools(), /循环分页游标/);
    } finally {
      await new Promise((r) => server21.close(r));
      await new Promise((r) => serverLoop.close(r));
    }
  });

  test('R2-2 & N2：配置校验错误不回显查询参数/令牌，[::1] 被拒，代理直调上游 isError 正文脱敏', async () => {
    const secretMarker = 'SECRET_URL_TOKEN_998877';
    assert.throws(
      () => parseCardsUrl(`http://127.0.0.1:8794/cards?token=${secretMarker}`, 8794),
      (err) => {
        assert.match(err.message, /VCAT_CARDS_URL/);
        assert.ok(!err.message.includes(secretMarker), 'VCAT_CARDS_URL 报错不得回显查询参数令牌');
        return true;
      },
    );
    assert.throws(
      () => parseUpstreamUrl(`http://127.0.0.1:3199/mcp?token=${secretMarker}`),
      (err) => {
        assert.match(err.message, /VCAT_UPSTREAM_URL/);
        assert.ok(!err.message.includes(secretMarker), 'VCAT_UPSTREAM_URL 报错不得回显查询参数令牌');
        return true;
      },
    );
    assert.throws(() => parseCardsUrl('http://[::1]:8794/cards', 8794), /回环/);

    // 代理直调白名单工具遇到上游 isError 时，不得把原始错误正文回显给调用方
    const store = openShadowStore(':memory:');
    const fakeUpstream = {
      callReadTool: async () => ({ isError: true, content: [{ type: 'text', text: `internal leak ${secretMarker}` }] }),
    };
    const proxyServer = http.createServer();
    await new Promise((r) => proxyServer.listen(0, '127.0.0.1', r));
    const port = proxyServer.address().port;
    proxyServer.on('request', createVcatProxyHttp({
      store,
      upstream: fakeUpstream,
      upstreamTools: [{ name: 'vcat_list_accounts', description: 'read', inputSchema: { type: 'object', properties: {} } }],
      token: PROXY_TOKEN,
      port,
      log: () => {},
    }));
    const client = new Client({ name: 'test-proxy-redact', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${MCP_PATH}`), {
      requestInit: { headers: { Authorization: `Bearer ${PROXY_TOKEN}` } },
    });
    try {
      await client.connect(transport);
      const res = await client.callTool({ name: 'vcat_list_accounts', arguments: {} });
      assert.equal(res.isError, true);
      const txt = res.content.map((c) => c.text).join('\n');
      assert.ok(!txt.includes(secretMarker), '代理直调上游 isError 时不得回显原始正文');
    } finally {
      await client.close().catch(() => {});
      await new Promise((r) => proxyServer.close(r));
      store.close();
    }
  });

  test('R2-4：旧版无 UNIQUE 约束的数据库升级后自动清理重复 card_items，禁止同一 inbox 生成第 2 条 KB', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcat-legacy-'));
    const dbFile = path.join(dir, 'shadow.db');
    try {
      // 用原生 DatabaseSync 模拟旧版 0c5f9f1 表结构与已产生的重复出卡数据
      const { DatabaseSync } = await import('node:sqlite');
      const legacyDb = new DatabaseSync(dbFile);
      legacyDb.exec(`
        CREATE TABLE inbox (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL, platform TEXT NOT NULL,
          account_id TEXT, account_name TEXT, session_id TEXT, work_id TEXT, work_title TEXT,
          author_name TEXT, author_id TEXT, content TEXT NOT NULL,
          occurred_at TEXT NOT NULL, received_at TEXT NOT NULL, raw_json TEXT, processed_at TEXT
        );
        CREATE TABLE kb_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT, question TEXT NOT NULL, answer TEXT NOT NULL,
          platform TEXT NOT NULL DEFAULT 'all', source_card_id INTEGER,
          auto_reply INTEGER NOT NULL DEFAULT 0 CHECK (auto_reply = 0),
          keywords TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE cards (
          id INTEGER PRIMARY KEY AUTOINCREMENT, card_type TEXT NOT NULL, platform TEXT NOT NULL,
          account TEXT, question_summary TEXT NOT NULL, suggested_reply TEXT, topic_key TEXT,
          status TEXT NOT NULL DEFAULT 'pending', final_answer TEXT, kb_entry_id INTEGER,
          notified_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT
        );
        CREATE TABLE card_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER NOT NULL, inbox_id TEXT NOT NULL,
          platform TEXT, account TEXT, author_name TEXT, excerpt TEXT, created_at TEXT NOT NULL,
          UNIQUE (card_id, inbox_id)
        );
        CREATE TABLE shadow_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT, inbox_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
          platform TEXT NOT NULL, decision TEXT NOT NULL, kb_entry_id INTEGER, card_id INTEGER,
          would_reply TEXT, reason TEXT, created_at TEXT NOT NULL
        );
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `);
      const ts = '2026-11-27T01:00:00.000Z';
      legacyDb.prepare("INSERT INTO inbox (id, kind, platform, content, occurred_at, received_at, processed_at) VALUES ('dup:1', 'comment', 'Douyin', '旧重复问题', ?, ?, ?)").run(ts, ts, ts);
      legacyDb.prepare("INSERT INTO kb_entries (id, question, answer, platform, source_card_id, auto_reply, keywords, created_at, updated_at) VALUES (1, '旧重复问题', '旧答案1', 'Douyin', 1, 0, '', ?, ?)").run(ts, ts);
      legacyDb.prepare("INSERT INTO cards (id, card_type, platform, question_summary, status, final_answer, kb_entry_id, created_at, updated_at, resolved_at) VALUES (1, 'comment', 'Douyin', '旧重复问题', 'answered', '旧答案1', 1, ?, ?, ?)").run(ts, ts, ts);
      legacyDb.prepare("INSERT INTO cards (id, card_type, platform, question_summary, status, created_at, updated_at) VALUES (2, 'comment', 'Douyin', '旧重复问题（重放卡）', 'pending', ?, ?)").run(ts, ts);
      legacyDb.prepare("INSERT INTO card_items (card_id, inbox_id, platform, excerpt, created_at) VALUES (1, 'dup:1', 'Douyin', '旧重复问题', ?)").run(ts);
      legacyDb.prepare("INSERT INTO card_items (card_id, inbox_id, platform, excerpt, created_at) VALUES (2, 'dup:1', 'Douyin', '旧重复问题', ?)").run(ts);
      legacyDb.prepare("INSERT INTO shadow_log (inbox_id, kind, platform, decision, card_id, created_at) VALUES ('dup:1', 'comment', 'Douyin', 'new_question', 2, ?)").run(ts);
      legacyDb.close();

      // 用新版 openShadowStore 打开旧库：自动去重迁移 + 关停空壳重复卡 + 建 UNIQUE 索引
      const store = openShadowStore(dbFile);
      try {
        const secondCard = store.getCard(2);
        assert.equal(secondCard.status, 'skipped', '旧库空壳重复 pending 卡应被自动关闭');
        const ansRes = store.answerCard(2, { answer: '试图二次入库' });
        assert.equal(ansRes.ok, false);
        assert.equal(ansRes.code, 409);
        assert.equal(store.listKb(10).length, 1, '同一 inbox 最终只能有 1 条 KB');
        assert.equal(store.listShadowLog(10)[0].cardId, 1, 'shadow_log 应回指已保留的卡片 #1');
      } finally {
        store.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('R2-5：shadow_record 拒绝非字符串 wouldReply（如 {}）与非字符串 reason', () => {
    const store = openShadowStore(':memory:');
    try {
      store.ingestInbox([
        { id: 'type:1', kind: 'comment', platform: 'Douyin', content: '怎么用', occurredAt: '2026-11-27T01:00:00.000Z' },
        { id: 'type:2', kind: 'comment', platform: 'Douyin', content: '广告', occurredAt: '2026-11-27T01:01:00.000Z' },
      ]);
      store.db.prepare(`
        INSERT INTO kb_entries (id, question, answer, platform, source_card_id, auto_reply, keywords, created_at, updated_at)
        VALUES (1, '怎么用', '看置顶', 'all', NULL, 0, '', '2026-11-27T01:00:00.000Z', '2026-11-27T01:00:00.000Z')
      `).run();

      const badRes = store.recordShadow([
        { inboxId: 'type:1', decision: 'hit', kbEntryId: 1, wouldReply: {} },
        { inboxId: 'type:2', decision: 'ad', reason: ['bad'] },
      ]);
      assert.equal(badRes.recorded, 0);
      assert.equal(badRes.rejected.length, 2);
      assert.equal(store.pendingCount(), 2, '非字符串 wouldReply/reason 不得将 inbox 标记为已处理');
    } finally {
      store.close();
    }
  });

  test('R2-8：飞书降级文本路径返回非 JSON 200 拒判成功；回执丢失 fail-closed 不重复推送，新问题合并后可再发', async () => {
    const store = openShadowStore(':memory:');
    try {
      store.ingestInbox([
        { id: 'f:1', kind: 'comment', platform: 'Douyin', content: '降级测试', occurredAt: '2026-11-27T01:00:00.000Z' },
        { id: 'f:2', kind: 'comment', platform: 'Douyin', content: '断线测试1', occurredAt: '2026-11-27T01:01:00.000Z' },
        { id: 'f:3', kind: 'comment', platform: 'Bili', content: '断线测试2', occurredAt: '2026-11-27T01:02:00.000Z' },
      ]);

      // 场景 A：主请求返回非零业务码 -> 触发默认降级文本 -> 降级收到 HTTP 200 非 JSON -> 绝不误记 sent
      const cFallback = store.submitCard({ inboxIds: ['f:1'], questionSummary: '降级测试', topicKey: 'fb-topic' });
      let callIdx = 0;
      const fallbackRes = await notifyPendingCards(store, {
        webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/fake',
        fetchImpl: async () => {
          callIdx += 1;
          if (callIdx === 1) return new Response(JSON.stringify({ code: 19001, msg: 'card rejected' }), { status: 200 });
          return new Response('<html>proxy ok</html>', { status: 200 });
        },
      });
      assert.equal(callIdx, 2);
      assert.equal(fallbackRes.sent, false);
      assert.equal(fallbackRes.uncertain, true);
      assert.equal(store.getCard(cFallback.card.id).notifiedAt, null, '降级返回非 JSON 时绝不能写入 notified_at');

      // 场景 B：接收方已收到但响应前断线 -> 下一轮绝不重复发送同一版本；合并新问题后再发新版本
      const cDrop = store.submitCard({ inboxIds: ['f:2'], questionSummary: '断线问题', topicKey: 'drop-topic' });
      let receivedByPeer = 0;
      const dropFetch = async () => {
        receivedByPeer += 1;
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      };
      const drop1 = await notifyPendingCards(store, {
        webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/fake',
        fetchImpl: dropFetch,
      });
      assert.equal(drop1.sent, false);
      assert.equal(drop1.uncertain, true);
      assert.equal(receivedByPeer, 1);
      assert.equal(store.getCard(cDrop.card.id).notifiedAt, null);

      // 下一轮通知同一版本：不得再次发送给接收方
      const drop2 = await notifyPendingCards(store, {
        webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/fake',
        fetchImpl: dropFetch,
      });
      assert.equal(drop2.sent, false);
      assert.equal(drop2.reason, 'no_unnotified_cards');
      assert.equal(receivedByPeer, 1, '回执丢失后同版本绝不自动重发');

      // 当新问题 f:3 合并进该卡后（notify_version 递增），允许发出新版聚合卡
      store.submitCard({ inboxIds: ['f:3'], questionSummary: '断线问题', topicKey: 'drop-topic' });
      const resent = await notifyPendingCards(store, {
        webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/fake',
        fetchImpl: async () => {
          receivedByPeer += 1;
          return new Response(JSON.stringify({ code: 0 }), { status: 200 });
        },
      });
      assert.equal(resent.sent, true);
      assert.equal(receivedByPeer, 2);
      assert.ok(store.getCard(cDrop.card.id).notifiedAt);
    } finally {
      store.close();
    }
  });
});

describe('第 3 轮评审阻断项回归测试', () => {
  test('R3-1：飞书投递前持久化已开始投递，超 60s TTL 绝不重发同版本，晚归 ECONNRESET 仍精准记 uncertainCount=1', async () => {
    const store = openShadowStore(':memory:');
    try {
      store.ingestInbox([
        { id: 'r3:1', kind: 'comment', platform: 'Douyin', content: '超时重入测试', occurredAt: '2026-11-27T01:00:00.000Z' },
        { id: 'r3:2', kind: 'comment', platform: 'Bili', content: '合并新版测试', occurredAt: '2026-11-27T01:01:00.000Z' },
        { id: 'r3:3', kind: 'comment', platform: 'Douyin', content: '确定未送达可重试', occurredAt: '2026-11-27T01:02:00.000Z' },
      ]);
      const card1 = store.submitCard({ inboxIds: ['r3:1'], questionSummary: '超时问题', topicKey: 'r3-timeout' });

      let clockMs = Date.parse('2026-11-27T02:00:00.000Z');
      const now = () => clockMs;
      let sendCount = 0;
      let rejectFirst;
      const hangingFetch = () => {
        sendCount += 1;
        return new Promise((_, reject) => {
          rejectFirst = () => reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }));
        });
      };

      // 第 1 次发出请求，在回执返回前卡住
      const p1 = notifyPendingCards(store, {
        webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/fake',
        fetchImpl: hangingFetch,
        now,
      });
      assert.equal(sendCount, 1);
      assert.equal(store.unnotifiedPendingCount(), 0, '已开始投递的同版本不应继续唤醒轮询');

      // 时钟推进 60,001 ms（超过默认 60s claim TTL），再调一次绝不能重新认领并重发版本 1
      clockMs += 60_001;
      const r2 = await notifyPendingCards(store, {
        webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/fake',
        fetchImpl: hangingFetch,
        now,
      });
      assert.equal(r2.sent, false);
      assert.equal(r2.reason, 'no_unnotified_cards');
      assert.equal(sendCount, 1, '超过 60s 后同版本仍不得重复发送');

      // 第一次请求晚归 ECONNRESET：原 claimToken 未被抢走，uncertainCount 必须精确为 1
      rejectFirst();
      const r1 = await p1;
      assert.equal(r1.sent, false);
      assert.equal(r1.uncertain, true);
      assert.equal(r1.uncertainCount, 1);
      assert.equal(store.getCard(card1.card.id).notifiedAt, null);

      // 合并新问题 r3:2 后版本递增，允许发出新版聚合卡
      store.submitCard({ inboxIds: ['r3:2'], questionSummary: '超时问题', topicKey: 'r3-timeout' });
      const rMerged = await notifyPendingCards(store, {
        webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/fake',
        fetchImpl: async () => {
          sendCount += 1;
          return new Response(JSON.stringify({ code: 0 }), { status: 200 });
        },
        now,
      });
      assert.equal(rMerged.sent, true);
      assert.equal(sendCount, 2);

      // 确定未送达（ECONNREFUSED）时应释放投递标记，下一轮允许重试并成功
      store.submitCard({ inboxIds: ['r3:3'], questionSummary: '连接被拒问题', topicKey: 'r3-refused' });
      const refused = await notifyPendingCards(store, {
        webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/fake',
        fetchImpl: async () => {
          throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
        },
        now,
      });
      assert.equal(refused.sent, false);
      assert.equal(refused.uncertain, false);
      assert.equal(store.unnotifiedPendingCount(), 1, '确定未送达必须恢复可重试状态');
      const retried = await notifyPendingCards(store, {
        webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/fake',
        fetchImpl: async () => new Response(JSON.stringify({ code: 0 }), { status: 200 }),
        now,
      });
      assert.equal(retried.sent, true);
      assert.equal(retried.confirmed, 1);
    } finally {
      store.close();
    }
  });

  test('R3-2：tools/list 返回空字符串 nextCursor 时按字段存在继续翻页并原样传递游标，重复空游标按循环报错', async () => {
    const seenParams = [];
    const serverEmptyCursor = http.createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const mcp = new Server({ name: 'empty-cursor-ok', version: '0.1.0' }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async (request) => {
        const hasCursor = Boolean(request.params && Object.prototype.hasOwnProperty.call(request.params, 'cursor'));
        seenParams.push(hasCursor ? request.params.cursor : undefined);
        if (!hasCursor) {
          return {
            tools: [{ name: 'vcat_non_whitelist_1', description: 'p1', inputSchema: { type: 'object', properties: {} } }],
            nextCursor: '',
          };
        }
        assert.equal(request.params.cursor, '');
        return {
          tools: [{ name: 'vcat_list_accounts', description: 'p2', inputSchema: { type: 'object', properties: {} } }],
        };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { transport.close().catch(() => {}); mcp.close().catch(() => {}); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    });
    await new Promise((r) => serverEmptyCursor.listen(0, '127.0.0.1', r));

    const serverEmptyLoop = http.createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const mcp = new Server({ name: 'empty-cursor-loop', version: '0.1.0' }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: 'vcat_list_accounts', description: 'loop', inputSchema: { type: 'object', properties: {} } }],
        nextCursor: '',
      }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { transport.close().catch(() => {}); mcp.close().catch(() => {}); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    });
    await new Promise((r) => serverEmptyLoop.listen(0, '127.0.0.1', r));

    try {
      const upOk = createUpstreamClient({ url: `http://127.0.0.1:${serverEmptyCursor.address().port}/mcp`, token: UPSTREAM_TOKEN });
      const synced = await upOk.syncTools();
      assert.deepEqual(seenParams, [undefined, '']);
      assert.deepEqual(synced.exposedTools.map((t) => t.name), ['vcat_list_accounts']);

      const upLoop = createUpstreamClient({ url: `http://127.0.0.1:${serverEmptyLoop.address().port}/mcp`, token: UPSTREAM_TOKEN });
      await assert.rejects(() => upLoop.syncTools(), /循环分页游标/);
    } finally {
      await new Promise((r) => serverEmptyCursor.close(r));
      await new Promise((r) => serverEmptyLoop.close(r));
    }
  });

  test('R3-3：VCAT_KB_EXPORT_FILE 与 VCAT_UPSTREAM_TOKEN_OP_REF 校验失败均不回显环境变量值', () => {
    const secret = 'FIXTURE_ONLY_SECRET_999';
    assert.throws(
      () => readConfig({ VCAT_KB_EXPORT_FILE: `/tmp/review-demo?token=${secret}` }),
      (err) => {
        assert.match(err.message, /VCAT_KB_EXPORT_FILE/);
        assert.ok(!err.message.includes(secret), 'VCAT_KB_EXPORT_FILE 报错不得回显路径或查询参数');
        return true;
      },
    );
    assert.throws(
      () => resolveUpstreamToken(
        { upstreamTokenEnv: '', upstreamTokenOpRef: `op://Private/${secret}/credential`, opBin: 'op' },
        { execFile: () => { throw new Error('missing'); } },
      ),
      (err) => {
        assert.match(err.message, /小V猫 MCP/);
        assert.ok(!err.message.includes(secret), 'resolveUpstreamToken 报错不得回显 op:// 引用内容');
        return true;
      },
    );
  });
});
