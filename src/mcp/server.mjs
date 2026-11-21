#!/usr/bin/env node
// 麦田本地 MCP（stdio）。启动：node src/mcp/server.mjs --scope read | engage
// 只做参数校验和转发到 src/ops/engage/*。stdout 只走 MCP 协议，日志写 stderr。
//   read：只查库，不现抓、不起 runner。
//   engage：只注册 reply_comment、send_dm，和 B站处置 delete_comment、block_user、delete_conversation（不带 read 组），而且只在进程环境的 MAITIAN_ENGAGE_TOKEN 和仓库 .env 里的一致时注册
//          （src/ops/tokens.mjs 的 checkToken，常数时间）；对不上或缺失就一个工具都不注册，只往 stderr 写一句原因。口令值不进日志、错误、返回。
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openOpsDb } from '../ops/db.mjs';
import { opsDbPath } from '../ops/paths.mjs';
import * as q from '../ops/engage/query.mjs';
import { engageWrite } from '../ops/engage/write.mjs';
import { checkToken, TOKEN_SCOPES } from '../ops/tokens.mjs';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { subscribe, unsubscribe, EVENT_TYPES } from '../ops/engage/subscribers.mjs';

export const SCOPES = ['read', 'engage', 'publish', 'manage'];

const platforms = z.array(z.string()).optional().describe('平台代码，例如 ["Douyin","Bili"]；不传是全部');
const cursor = z.string().optional().describe('上一页返回的 nextCursor');
const limit = z.number().int().positive().optional().describe('每页条数，默认 50，最多 200');
const since = z.string().optional().describe('ISO 时间');
const compact = z.boolean().optional().describe('true 时返回扁平精简列表（JSON 不缩进），每条只有 id、author、isMe、replyTo、text、at、depth，省 token；不传返回完整版');
const compactEvents = z.boolean().optional().describe('true 时返回扁平精简列表（JSON 不缩进），每条只有 id、type、subjectId、author、isMe、replyTo、text、at、depth（推送前被过滤的多一个 filteredReason）；回复用 subjectId。不传返回完整版');
const id = (what) => z.string().describe(`${what}，写成 <platformCode>:<原生 id>`);

// [工具名, 说明, 入参, (db, args) => 结果]
const READ_TOOLS = [
  ['list_accounts', '列出账号：登录状态、能力位、各类数据上次抓取成功的时间（lastSync）', {}, (db) => q.listAccounts(db)],
  ['inbox', '每个平台的未处理事件数、未读会话数、未回复评论数', { platforms }, (db, a) => q.inbox(db, a)],
  ['list_events', '列事件（旧到新）。unhandled: true 取还没回执的，用来补漏推。推送前被确定规则过滤的（self-author、peer-reply）已自动回执 skipped，带 filteredReason。compact: true 返回精简条目', {
    types: z.array(z.enum(EVENT_TYPES)).optional(), platforms, unhandled: z.boolean().optional(), since, cursor, limit, compact: compactEvents,
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
  ['list_comments', '扁平评论列表（新的在前），带 parentId/rootId/depth 和 replied。replied: false 只返回别人写的、还没回的。compact: true 返回精简条目', {
    workId: id('作品 id').optional(), platforms, since, replied: z.boolean().optional(), includeGone: z.boolean().optional(), cursor, limit, compact,
  }, (db, a) => q.listComments(db, a)],
  ['get_comment_thread', '评论所在的整楼：嵌套树 + 作品标题和链接 + partial（楼中楼拿不全时 true）。compact: true 返回扁平列表和 total；再加 around、n 只取目标前后 n 条（一楼总在第一条），omitted 是省掉的条数', {
    commentId: id('评论 id'), compact,
    around: id('只看这条评论前后，需要 compact: true').optional(), n: z.number().int().positive().optional().describe('around 前后各取几条，默认 5，最多 50；要和 around 一起用'),
  }, (db, a) => q.getCommentThread(db, a.commentId, { compact: a.compact, around: a.around, n: a.n })],
  ['list_conversations', '私信会话列表（最近的在前）', {
    platforms, unread: z.boolean().optional(), lastBy: z.enum(['me', 'peer']).optional(), since, cursor, limit,
  }, (db, a) => q.listConversations(db, a)],
  ['get_conversation', '一个会话最近 limit 条消息（旧到新）', { conversationId: id('会话 id'), limit }, (db, a) => q.getConversation(db, a.conversationId, a.limit)],
  ['refresh_now', '让守护进程马上抓一次（同一平台同一 kind 5 分钟内只认一次），返回 job id。只在回复前确认最新状态时用', {
    kind: z.enum(['comments', 'dms']), platform: z.string(),
  }, (db, a) => q.refreshNow(db, a)],
];

const text = z.string().describe('要发的正文，1 到 1000 字');
const idempotencyKey = z.string().describe('幂等键，建议填事件 id；同一个键 24 小时内发出过就返回 duplicate，点了发送没回读到的也不再发');
const eventId = z.string().optional().describe('对应的事件 id（可选）；发出后自动回执 replied。不填时回执这个目标所有没回执的同类事件');
const WRITE_NOTE = '发前在平台上重读、发后回读；返回 status：sent（回读到了）、needs_readback（点了发送但没回读到，绝不重试，请人工看）、failed（没发，reason 说明，如 comment-gone、already-replied、last-is-me）、duplicate、rejected（能力位关、本轮已满 15 条、平台正被占用等）';

// B站处置（广告评论、私信）。生效并回读确认才返回 sent；对象是我自己一律 rejected self-target
const modEventId = z.string().optional().describe('对应的事件 id（可选）；生效后自动回执 ignored。不填时回执这个目标所有没回执的同类事件');
const MOD_NOTE = '只做 B站。发前重读、接口只调一次、发后回读；返回 status：sent（回读确认已生效）、needs_readback（调了接口没读回，绝不重试，请人工看）、failed（没调接口，reason 如 already-gone、already-blocked、not-my-work、not-a-user）；调过接口但平台报错、回读也没确认的记 needs_readback / send-error-unconfirmed，不要重试、duplicate、rejected（self-target、capability-off、round-limit 每小时每种 10 条等）';
const mod = (op, targetKey) => (db, a, deps) => engageWrite(db, { op, targetId: a[targetKey], idempotencyKey: a.idempotencyKey, eventId: a.eventId, caller: deps.caller() }, deps);
const MODERATE_TOOLS = [
  ['delete_comment', `删除自己作品下别人的一条评论（一楼、楼中楼都行）。${MOD_NOTE}`, { commentId: id('评论 id'), idempotencyKey, eventId: modEventId }, mod('delete', 'commentId')],
  ['block_user', `拉黑一个人。target 可以是 Bili:<mid>，也可以是这个人的评论 id 或私信会话 id（从库里推出 mid）；只认库里见过的人。${MOD_NOTE}`,
    { target: z.string().describe('Bili:<mid>、评论 id 或会话 id'), idempotencyKey, eventId: modEventId }, mod('block', 'target')],
  ['delete_conversation', `从私信会话列表里删掉一个会话（B站 remove_session：只移除会话，聊天记录还在，对方再发消息会话会回来；配合 block_user 用）。${MOD_NOTE}`,
    { conversationId: id('会话 id'), idempotencyKey, eventId: modEventId }, mod('deleteConversation', 'conversationId')],
];

// [工具名, 说明, 入参, (db, args, deps) => 结果]
const ENGAGE_TOOLS = [
  ['reply_comment', `回复一条评论（含楼中楼）。${WRITE_NOTE}`, { commentId: id('评论 id'), text, idempotencyKey, eventId },
    (db, a, deps) => engageWrite(db, { op: 'reply', targetId: a.commentId, text: a.text, idempotencyKey: a.idempotencyKey, eventId: a.eventId, caller: deps.caller() }, deps)],
  ['send_dm', `回复一个私信会话。${WRITE_NOTE}`, { conversationId: id('会话 id'), text, idempotencyKey, eventId },
    (db, a, deps) => engageWrite(db, { op: 'sendDM', targetId: a.conversationId, text: a.text, idempotencyKey: a.idempotencyKey, eventId: a.eventId, caller: deps.caller() }, deps)],
  ...MODERATE_TOOLS,
];

// compact 的结果不缩进，省 token
const reply = (value, compact = false) => ({ content: [{ type: 'text', text: compact ? JSON.stringify(value) : JSON.stringify(value, null, 1) }] });

export const READ_TOOL_NAMES = READ_TOOLS.map(([name]) => name);
export const ENGAGE_TOOL_NAMES = ENGAGE_TOOLS.map(([name]) => name);

/** engage 口令：对上返回 null，否则返回原因（不含口令值）。 */
export function engageTokenProblem({ token = process.env.MAITIAN_ENGAGE_TOKEN, envPath } = {}) {
  const name = TOKEN_SCOPES.engage;
  if (!token) return `进程环境里没有 ${name}`;
  return checkToken('engage', token, envPath ? { envPath } : undefined) ? null : `${name} 和仓库 .env 里的不一致，或 .env 里没有这个口令`;
}

function register(server, db, list, deps) {
  for (const [name, description, inputSchema, run] of list) {
    server.registerTool(name, { description, inputSchema }, async (args) => {
      try { return reply(await run(db, args ?? {}, deps), args?.compact === true); } catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; }
    });
  }
}

/**
 * scope read：tools 只注册这几个（不传是 read 组全部），名字不在 read 组里直接抛错，免得拼错后悄悄少一个。
 * scope engage：口令（engageToken，默认读进程环境）对上才注册 engage 组；writeDeps 透传给 engageWrite（测试注入假 writer、假通知）。
 */
export function buildServer(db, { scope = 'read', tools = null, log = (s) => console.error(s), engageToken = process.env.MAITIAN_ENGAGE_TOKEN, envPath, writeDeps = {} } = {}) {
  if (!SCOPES.includes(scope)) throw new Error(`--scope 只能是 ${SCOPES.join('、')}：${scope}`);
  const server = new McpServer({ name: 'maitian', version: '0.3.0' });
  if (scope === 'engage') {
    const problem = engageTokenProblem({ token: engageToken, envPath });
    if (problem) {
      log(`[maitian-mcp] --scope engage：${problem}，没有注册任何工具`);
      // 声明一个空的工具列表，客户端 tools/list 拿到 []，不会当成服务坏了
      server.server.registerCapabilities({ tools: {} });
      server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
      return server;
    }
    const caller = () => `mcp:${server.server.getClientVersion()?.name ?? 'unknown'}`;
    register(server, db, ENGAGE_TOOLS, { ...writeDeps, caller });
    return server;
  }
  if (scope !== 'read') log(`[maitian-mcp] --scope ${scope}：写工具还没做，只注册 read 组`);
  const unknown = (tools ?? []).filter((t) => !READ_TOOL_NAMES.includes(t));
  if (unknown.length) throw new Error(`不在 read 组里的工具：${unknown.join('、')}`);
  register(server, db, READ_TOOLS.filter(([name]) => !tools || tools.includes(name)), {});
  return server;
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { scope: { type: 'string', default: 'read' } } });
  const db = openOpsDb(opsDbPath());
  const server = buildServer(db, { scope: values.scope });
  await server.connect(new StdioServerTransport());
  const n = values.scope === 'engage' ? (engageTokenProblem() ? 0 : ENGAGE_TOOLS.length) : READ_TOOLS.length;
  console.error(`[maitian-mcp] 已启动（scope ${values.scope}，${n} 个工具）`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === import.meta.filename) {
  main().catch((e) => { console.error(`[maitian-mcp] 出错：${e.message}`); process.exit(1); });
}
