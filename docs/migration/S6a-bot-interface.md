# S6a 事件推送与 MCP：给 bot 的接口文档

这份文档写给 OpenBot、Cindy 项目里接麦田事件的 bot 开发者。麦田不绑定任何 agent 平台，只提供两样东西：

1. **出站 webhook**：守护进程每轮抓完评论私信，把新事件合批 POST 到你登记的地址。
2. **本地 MCP（stdio）**：读账号、作品、评论树、私信、事件，回执事件，登记订阅。

平台本身没有 webhook，新评论仍靠麦田守护进程定时去页面读。所以最晚延迟是一个抓取间隔，白天是 15 分钟。

## 1. 挂载 MCP

```sh
MAITIAN_OPS_DB=/path/to/mdldm-maitian/data/ops.db node /path/to/mdldm-maitian/src/mcp/server.mjs --scope read
```

- 走 stdio。stdout 只有 MCP 协议，日志写 stderr。
- `MAITIAN_OPS_DB` 不设时用仓库里的 `data/ops.db`。
- `--scope` 不传时是 `read`。这一版只有 read 组。传 `engage`、`publish`、`manage` 时，服务在 stderr 写一行说明，仍然只注册 read 组。回复、私信这些写工具在后面的 spec 里做。
- MCP 只查库，不现抓页面，也不起浏览器。要拿最新状态就调 `refresh_now`，等守护进程抓完再读。

MCP 客户端配置示例（JSON 形式，各平台字段名可能不同）：

```json
{ "command": "node", "args": ["/path/to/mdldm-maitian/src/mcp/server.mjs", "--scope", "read"],
  "env": { "MAITIAN_OPS_DB": "/path/to/mdldm-maitian/data/ops.db" } }
```

### read 组工具

所有 id 都写成 `<platformCode>:<平台原生 id>`，例如 `Douyin:7709328922249741096`。格式不对时工具返回错误（`isError: true`），错误文字说明要怎么写。

列表工具返回 `{ items, nextCursor }`。`nextCursor` 为 `null` 表示没有下一页。要取下一页，把 `nextCursor` 原样传回 `cursor`。`limit` 默认 50，最大 200。

| 工具 | 入参 | 返回 |
|---|---|---|
| `list_accounts` | — | Account[]：`loginState`、`capabilities`、`lastSync`（各 kind 最近一次抓取成功的时间） |
| `inbox` | `platforms?` | 每个平台的 `unhandledEvents`、`unreadConversations`、`unrepliedComments` |
| `list_events` | `types?`、`platforms?`、`unhandled?`、`since?`、`cursor?`、`limit?` | Event[]，旧的在前 |
| `ack_event` | `eventId`、`outcome`、`note?` | `{ eventId, handled }` |
| `subscribe_events` | `subscriberId`、`url`、`types[]`、`platforms?` | 见第 2 节 |
| `unsubscribe_events` | `subscriberId` | `{ subscriberId, active: false }` |
| `list_works` | `platforms?`、`since?`、`until?`、`cursor?`、`limit?` | Work[]，新的在前（按 `postTime`） |
| `get_work` | `workId` | `{ work, samples: [], topComments }`。`topComments` 是最新的 20 条一楼评论。`samples` 等 S3 上线后才有数据 |
| `get_work_flow` | `workId`、`hours?` | `{ workId, hours: [], note }`。流速数据等 S5 上线后才有 |
| `list_comments` | `workId?`、`platforms?`、`since?`、`replied?`、`includeGone?`、`cursor?`、`limit?` | 扁平的 Comment[]，新的在前 |
| `get_comment_thread` | `commentId` | `{ work: { id, title, url }, partial, root }`。`root` 是整楼的嵌套树，每个节点有 `children` |
| `list_conversations` | `platforms?`、`unread?`、`lastBy?`（`me` 或 `peer`）、`since?`、`cursor?`、`limit?` | Conversation[]，最近的在前 |
| `get_conversation` | `conversationId`、`limit?` | `{ conversation, messages }`。`messages` 是最近 `limit` 条，旧的在前 |
| `refresh_now` | `kind`（`comments` 或 `dms`）、`platform` | `{ jobId, deduped, status }`。同一平台同一 kind 已经有在排队或在跑的任务，或者 5 分钟内刚成功过一次时，不新建任务，返回那条任务（`deduped: true`） |

评论字段的含义：

- `parentId`：直接回复的那条评论，一楼为 `null`。`rootId`：所在楼的一楼。`depth`：一楼是 0。
- `replied`：这条评论的子树里有我写的、还没被删的回复。
- `list_comments({ replied: false })` 只返回别人写的、还没回的评论，和 `inbox` 里的未回复数一致。
- 平台上被删掉的评论不删行，只标 `goneAt`。`list_comments` 默认不返回这些评论，传 `includeGone: true` 才返回。
- `partial: true` 表示这个作品的楼中楼麦田拿不全（平台接口核实不了），树里可能缺回复。所在楼的一楼不在库里时，`root` 是占位节点 `{ id, missing: true, children }`，这时 `partial` 也是 `true`。

## 2. 登记订阅

bot 启动时调一次 `subscribe_events`：

```json
{ "subscriberId": "openbot-engage", "url": "https://bot.example/maitian/hook",
  "types": ["comment.created", "dm.received"], "platforms": ["Douyin", "Bili"] }
```

- `subscriberId`：只能用字母、数字、`_`、`.`、`-`，1 到 64 个字符。
- `url`：只接受 `http` 和 `https`。
- `types`：可以填 `comment.created`、`dm.received`、`account.login_lost`、`sync.failed`。`work.punished`、`flow.alert` 也能登记，但这一版还不会产生这两种事件。
- `platforms`：不传就是全部平台。
- **首次登记**返回 `{ created: true, subscriberId, secret, ... }`。`secret` 是 64 位 hex（32 字节），**只在这一次返回**。请存进 bot 自己的密钥库。
- **重复登记**（同一个 `subscriberId`）只更新 `url`、`types`、`platforms`，返回 `{ created: false, ... }`，不返回密钥，密钥也不变。退订过的订阅方重新登记会恢复推送。
- 丢了密钥：换一个新的 `subscriberId` 重新登记，再对旧的调 `unsubscribe_events`。
- 只推**登记之后**产生的事件。登记之前的事件请用 `list_events({ unhandled: true })` 取。
- `unsubscribe_events` 之后不再推。没送达的事件留在库里，可以用 `list_events` 取。

## 3. 推送请求

```
POST <你登记的 url>
Content-Type: application/json
X-Maitian-Signature: sha256=<hex(HMAC-SHA256(secret, 原始请求体))>
X-Maitian-Timestamp: <sentAt，ISO 时间>
X-Maitian-Batch: <batchId>
```

请求体：

```json
{ "subscriberId": "openbot-engage", "batchId": "batch_…", "sentAt": "2026-11-19T02:15:03.120Z",
  "events": [ { "id": "comment.created:Douyin:7709…", "type": "comment.created", "platform": "Douyin",
                "accountId": "Douyin:106707338905", "subjectId": "Douyin:7709…", "createdAt": "2026-11-19T02:15:00.000Z",
                "payload": { … },
                "delivery": { "attempts": 1, "lastAttemptAt": "2026-11-19T02:15:03.120Z", "deliveredAt": null },
                "handled": null } ] }
```

| 字段 | 含义 |
|---|---|
| `subscriberId` | 你登记的 id |
| `batchId` | 这一次推送的 id。重试时 `batchId` 会变，请不要用它去重 |
| `sentAt` | 这次发出的时间，和 `X-Maitian-Timestamp` 相同 |
| `events[]` | 一批最多 20 条，按 `createdAt` 从旧到新排。多于 20 条时分成几次推送 |
| `events[].id` | 事件 id，确定性生成，**用它去重** |
| `events[].type` | 事件类型，见第 6 节 |
| `events[].platform` / `accountId` | 平台代码、账号 id（`<platformCode>:<uid>`） |
| `events[].subjectId` | 评论 id、会话 id，或者任务 id、账号 id（看事件类型） |
| `events[].payload` | 摘要，见第 6 节 |
| `events[].delivery` | 对你这个订阅方的送达情况：`attempts` 是算上这一次的尝试次数，`deliveredAt` 是第一次送达的时间（首次推送时为 `null`） |
| `events[].handled` | 回执，推出去的事件都是 `null`（已回执的事件不推） |

### 验签

签名是对**原始请求体字节**算的，请在解析 JSON 之前验签。验签不过时返回 401。

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret, rawBody, header) {
  const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`);
  const got = Buffer.from(String(header ?? ''));
  return got.length === want.length && timingSafeEqual(got, want);
}
// if (!verify(secret, raw, req.headers['x-maitian-signature'])) return res.writeHead(401).end();
```

## 4. 响应、重试、回执

- **2xx 只表示收到**。请在 30 秒内返回 2xx，处理放到后台异步做。处理结果用 `ack_event` 回执，不靠 HTTP 响应。
- **401、其他非 2xx、超过 30 秒、连不上**都算推送失败。
- **重试**：失败后分别隔 1、5、15 分钟重试（总共尝试 4 次）。第 3 次重试仍失败时，麦田发一张飞书卡片，写明订阅方、多少条事件、最后的错误，然后**停止自动重试**这些事件。卡片里的地址只写到路径，不带 query，也不带密钥。飞书卡片没发出去时，下一轮再发，直到发出为止。
- **恢复**：停止自动重试的事件，在你重新调一次 `subscribe_events`，或者下一次推送成功之后，会放回队列，在下一轮重新推送。期间可以随时用 `list_events({ unhandled: true })` 自己补。
- 同一订阅方一批推送失败时，这一轮不再推后面的批次，留到下一轮。
- **至少送达一次**：同一个事件可能推送不止一次（比如你返回 2xx 之前连接断了）。请用 `events[].id` 去重。以后的回复工具里，`idempotencyKey` 就填事件 id。
- **必须回执**：一条处理完就调 `ack_event`：

  | `outcome` | 含义 |
  |---|---|
  | `replied` | 已回复 |
  | `skipped` | 按规则不用回 |
  | `pending_human` | 要等人确认 |
  | `ignored` | 无需处理（广告、重复等） |

  同一事件可以再回执一次（例如 `pending_human` 之后人工回复了，改成 `replied`），以最后一次为准。未知的事件 id 会报错。
- **2 小时未回执**：送达满 2 小时还没回执的事件，会在下一批再推送一次（`delivery.deliveredAt` 不为 `null`，`attempts` 不变）。每个事件只重新推送这一次，同时给飞书发一次提醒，每个事件只提醒一次。之后还没回执的，请用 `list_events({ unhandled: true })` 补。
- 已回执的事件不再推，也不再重新推送。

## 5. 首轮不出事件

一个账号**第一次同步**某类数据（库里还没有这个账号的评论，或者还没有它的会话）时，麦田只入库、不出事件。不然上线第一轮会把历史评论、历史私信全推一遍。从第二轮起，只对新出现的内容出事件。

守护进程停过一段时间再启动时，会照常和库里比对。停机期间的新评论会在启动后第一轮一次出成事件，不会丢，也不会重复。

## 6. 事件类型和 payload

| 类型 | 什么时候产生 | `subjectId` | 事件 id |
|---|---|---|---|
| `comment.created` | 库里第一次出现一条评论（含楼中楼），作者不是我 | 评论 id | `comment.created:<评论 id>` |
| `dm.received` | 会话最后一句是对方说的，且比库里上次记的新；或者出现了新会话（账号首轮除外） | 会话 id | `dm.received:<会话 id>:<最后一句的时间>` |
| `sync.failed` | 同一平台同一 kind 的抓取连续第 2 次失败（跳过不算；第 3、4 次不再出，中间成功过一次后重新计数） | 任务 id | `sync.failed:<账号 id>:<kind>:<任务 id>` |
| `account.login_lost` | 守护进程发现账号掉线；同一账号 6 小时内只出一次 | 账号 id | `account.login_lost:<账号 id>:<任务 id>` |
| `work.punished`、`flow.alert` | 这一版不产生 | — | — |

`comment.created` 的 payload：

| 字段 | 含义 |
|---|---|
| `workId` | 作品 id |
| `workTitle` | 作品标题（可能为 `null`） |
| `workUrl` | 作品链接（平台没给时为 `null`） |
| `commentId` | 评论 id |
| `rootId` | 所在楼的一楼 id，用 `get_comment_thread` 读整楼 |
| `parentId` | 直接回复的那条，一楼为 `null` |
| `nickname` | 评论者昵称 |
| `text` | 原话的前 200 字 |

`dm.received` 的 payload：

| 字段 | 含义 |
|---|---|
| `conversationId` | 会话 id，用 `get_conversation` 读上下文 |
| `nickname` | 对方昵称 |
| `text` | 最后一句的前 200 字（图片、分享等可能为 `null`） |
| `at` | 最后一句的时间 |

`sync.failed` 的 payload：`kind`、`jobId`、`consecutiveFailures`（2）、`error`。

`account.login_lost` 的 payload：`accountId`、`jobId`、`evidence`（前 200 字）。

## 7. 建议的处理流程

1. 收到推送后先验签，再按事件 id 去重，然后 30 秒内返回 200。
2. 对每条 `comment.created`，调 `get_comment_thread({ commentId: subjectId })` 看整楼和作品。对每条 `dm.received`，调 `get_conversation`。
3. 要确认最新状态时，调 `refresh_now`，然后等任务完成后再读（`list_accounts` 的 `lastSync` 会更新）。
4. 处理完调 `ack_event`。
5. 启动时和定期调一次 `list_events({ unhandled: true })` 补漏。
