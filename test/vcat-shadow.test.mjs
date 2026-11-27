// 小V猫只读影子版测试（假上游 Streamable HTTP MCP，全离线）：
// 覆盖白名单过滤、写工具永不暴露/永不转发、refresh 强制 false、代理鉴权与 Host 校验、
// 采集跳过本人与 preRunHook 退出码、本机答题页回环与同源校验、以及 卡片→答案→入库→镜像→下次命中 完整闭环。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import {
  assertSafeKbExportPath,
  ensureProxyToken,
  parseUpstreamUrl,
  resolveUpstreamToken,
} from '../integrations/vcat/config.mjs';
import { openShadowStore } from '../integrations/vcat/store.mjs';
import {
  VCAT_READ_WHITELIST,
  createUpstreamClient,
  sanitizeUpstreamArgs,
} from '../integrations/vcat/upstream.mjs';
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
