#!/usr/bin/env node
// 麦田本地 MCP（stdio）。启动：node src/mcp/server.mjs --scope read
// 只做参数校验和转发到 src/ops/engage/*：只查库，不现抓、不起 runner。stdout 只走 MCP 协议，日志写 stderr。
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openOpsDb } from '../ops/db.mjs';
import { opsDbPath } from '../ops/paths.mjs';
import * as q from '../ops/engage/query.mjs';
import { subscribe, unsubscribe, EVENT_TYPES } from '../ops/engage/subscribers.mjs';

export const SCOPES = ['read', 'engage', 'publish', 'manage'];

const platforms = z.array(z.string()).optional().describe('平台代码，例如 ["Douyin","Bili"]；不传是全部');
const cursor = z.string().optional().describe('上一页返回的 nextCursor');
const limit = z.number().int().positive().optional().describe('每页条数，默认 50，最多 200');
const since = z.string().optional().describe('ISO 时间');
const id = (what) => z.string().describe(`${what}，写成 <platformCode>:<原生 id>`);

// [工具名, 说明, 入参, (db, args) => 结果]
const READ_TOOLS = [
  ['list_accounts', '列出账号：登录状态、能力位、各类数据上次抓取成功的时间（lastSync）', {}, (db) => q.listAccounts(db)],
  ['inbox', '每个平台的未处理事件数、未读会话数、未回复评论数', { platforms }, (db, a) => q.inbox(db, a)],
  ['list_events', '列事件（旧到新）。unhandled: true 取还没回执的，用来补漏推', {
    types: z.array(z.enum(EVENT_TYPES)).optional(), platforms, unhandled: z.boolean().optional(), since, cursor, limit,
  }, (db, a) => q.listEvents(db, a)],
  ['ack_event', '回执一个事件：处理完一条就调，outcome 是 replied / skipped / pending_human / ignored', {
    eventId: z.string(), outcome: z.enum(q.OUTCOMES), note: z.string().optional(),
  }, (db, a) => q.ackEvent(db, a.eventId, a.outcome, a.note)],
  ['subscribe_events', '登记或更新事件推送订阅。首次登记返回签名密钥（只给这一次，请保存）；重复登记只更新 url、types、platforms', {
    subscriberId: z.string(), url: z.string(), types: z.array(z.string()), platforms,
  }, (db, a) => subscribe(db, a)],
  ['unsubscribe_events', '停止推送；没送达的事件留在库里，可用 list_events 取', { subscriberId: z.string() }, (db, a) => unsubscribe(db, a.subscriberId)],
  ['list_works', '列作品（新的在前）', { platforms, since, until: z.string().optional(), cursor, limit }, (db, a) => q.listWorks(db, a)],
  ['get_work', '作品详情 + 指标采样（S3 前为空）+ 最新 20 条一楼评论', { workId: id('作品 id') }, (db, a) => q.getWork(db, a.workId)],
  ['get_work_flow', '作品按小时的流速（S5 前没有数据）', { workId: id('作品 id'), hours: z.number().int().positive().optional() }, (db, a) => q.getWorkFlow(db, a.workId)],
  ['list_comments', '扁平评论列表（新的在前），带 parentId/rootId/depth 和 replied。replied: false 只返回别人写的、还没回的', {
    workId: id('作品 id').optional(), platforms, since, replied: z.boolean().optional(), includeGone: z.boolean().optional(), cursor, limit,
  }, (db, a) => q.listComments(db, a)],
  ['get_comment_thread', '评论所在的整楼：嵌套树 + 作品标题和链接 + partial（楼中楼拿不全时 true）', { commentId: id('评论 id') }, (db, a) => q.getCommentThread(db, a.commentId)],
  ['list_conversations', '私信会话列表（最近的在前）', {
    platforms, unread: z.boolean().optional(), lastBy: z.enum(['me', 'peer']).optional(), since, cursor, limit,
  }, (db, a) => q.listConversations(db, a)],
  ['get_conversation', '一个会话最近 limit 条消息（旧到新）', { conversationId: id('会话 id'), limit }, (db, a) => q.getConversation(db, a.conversationId, a.limit)],
  ['refresh_now', '让守护进程马上抓一次（同一平台同一 kind 5 分钟内只认一次），返回 job id。只在回复前确认最新状态时用', {
    kind: z.enum(['comments', 'dms']), platform: z.string(),
  }, (db, a) => q.refreshNow(db, a)],
];

const reply = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 1) }] });

export const READ_TOOL_NAMES = READ_TOOLS.map(([name]) => name);

/** tools：只注册这几个工具（不传是 read 组全部）。名字不在 read 组里直接抛错，免得拼错后悄悄少一个。 */
export function buildServer(db, { scope = 'read', tools = null, log = (s) => console.error(s) } = {}) {
  if (!SCOPES.includes(scope)) throw new Error(`--scope 只能是 ${SCOPES.join('、')}：${scope}`);
  if (scope !== 'read') log(`[maitian-mcp] --scope ${scope}：写工具还没做（S6a 只有 read 组），只注册 read 组`);
  const unknown = (tools ?? []).filter((t) => !READ_TOOL_NAMES.includes(t));
  if (unknown.length) throw new Error(`不在 read 组里的工具：${unknown.join('、')}`);
  const server = new McpServer({ name: 'maitian', version: '0.3.0' });
  for (const [name, description, inputSchema, run] of READ_TOOLS) {
    if (tools && !tools.includes(name)) continue;
    server.registerTool(name, { description, inputSchema }, async (args) => {
      try { return reply(await run(db, args ?? {})); } catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; }
    });
  }
  return server;
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { scope: { type: 'string', default: 'read' } } });
  const db = openOpsDb(opsDbPath());
  const server = buildServer(db, { scope: values.scope });
  await server.connect(new StdioServerTransport());
  console.error(`[maitian-mcp] 已启动（scope ${values.scope}，${READ_TOOLS.length} 个 read 工具）`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === import.meta.filename) {
  main().catch((e) => { console.error(`[maitian-mcp] 出错：${e.message}`); process.exit(1); });
}
