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
| `refresh_now` | `kind`（`comments` 或 `dms`）、`platform`（只接受 `Douyin`、`Channels`、`XiaoHongShu`、`Bili`，其他平台报错） | `{ jobId, deduped, status }`。同一平台同一 kind 已经有在排队或在跑的任务，或者 5 分钟内刚结束过一次（成功、跳过、失败都算）时，不新建任务，返回那条任务（`deduped: true`）。守护进程崩溃时留下的任务，开始 30 分钟后还没收尾就会记成失败（`error` 写「遗留的 running 任务已回收」），之后再调 `refresh_now` 会新建任务 |

评论字段的含义：

- `parentId`：直接回复的那条评论，一楼为 `null`。`rootId`：所在楼的一楼。`depth`：一楼是 0。
- `replied`：这条评论的子树里有我写的、还没被删的回复。
- `list_comments({ replied: false })` 只返回别人写的、还没回的评论，和 `inbox` 里的未回复数一致。
- 平台上被删掉的评论不删行，只标 `goneAt`。`list_comments` 默认不返回这些评论，传 `includeGone: true` 才返回。
- `partial: true` 表示这个作品的楼中楼麦田拿不全（平台接口核实不了），树里可能缺回复。楼里有评论的 parent 不在库里时（例如被回复的那条已经被删），这条评论挂在一楼下面，这时 `partial` 也是 `true`。所在楼的一楼不在库里时，`root` 是占位节点 `{ id, missing: true, children }`，这时 `partial` 也是 `true`。
- 会话的 `last`：平台这一轮没读到最后一句时（例如小红书没打开过的会话），麦田保留上次记下的 `last`，不会清空。

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

一个账号**第一次成功同步**某类数据（评论、私信分开算）时，麦田只入库、不出事件。这一轮哪怕什么都没抓到（例如账号还没有评论），也算同步过一次。不然上线第一轮会把历史评论、历史私信全推一遍。从第二轮起，只对新出现的内容出事件。

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

## 8. 抓取节奏和运维

这一节写给麦田负责人。bot 不需要读。

### 时间表

- 抓评论和抓私信分开排，四个平台（抖音、视频号、小红书、B站）也各排各的。
- 本机时间（台湾）08:00 到 23:00 之间每 15 分钟抓一次，包括 08:00，不包括 23:00。其余时间每小时整点抓一次。
- 抓取时间按时钟对齐：白天是 :00、:15、:30、:45，夜里是整点。上一轮跑得晚，下一轮不会跟着往后推。
- 守护进程停了一段时间再启动时，只补抓一轮，不把错过的轮次都补上。
- Instagram 和其他平台不抓。

### refresh_now

- bot 调 `refresh_now` 后，守护进程最多 1 分钟就会看到这条任务。如果这时没有别的一轮在跑，就马上开始抓。
- 同一平台同一 kind 的任务 5 分钟内只跑一次（见第 3 节）。
- 守护进程的主循环里有些步骤会长时间阻塞（例如知识站建课），阻塞期间新任务要等这些步骤结束才开始。

### 先开能力位

账号的能力位关着时不抓。开能力位：

```sh
hub ops accounts set-cap Douyin:106707338905 readComments true   # 抓评论
hub ops accounts set-cap Douyin:106707338905 readDM true         # 抓私信
```

uid 还是 `pending` 的账号（例如视频号），要先用 `hub ops accounts set-uid` 登记真实 uid，才会抓。

### 守护进程做什么

- 守护进程（launchd `com.maitian.daemon`）只负责调度，不打开页面。它每分钟检查一次：有排着的 `refresh_now`，或有到点的任务，并且没有别的一轮在跑，就起一个子进程 `node src/daemon/sync.mjs --once`。
- 子进程逐个账号抓，不并行。每个任务都通过 runner 短进程在账号自己的 space 里跑。space 被占着（`busy`）或负责人正在手动操作（`user-controlled`）时跳过这个任务，不算失败。
- 一轮抓完后统一推送一次事件，所以同一轮的新评论合在一批里推。
- 同一时刻只有一轮在跑。轮锁在 `data/engage-sync.lock`（可用 `MAITIAN_ENGAGE_LOCK` 改）。持锁进程已退出或锁超过 60 分钟时，锁视为过期，下一轮会接管。
- 同一平台同一 kind 连续失败 2 次，发一张飞书卡片。账号掉线时也发一张，同一账号 6 小时内只发一次。

### 关掉

在守护进程的环境里设置 `HUB_NO_ENGAGE=1` 后重启守护进程，就不再自动抓取。手动抓不受影响。

### 手动跑和查看状态

```sh
hub ops engage sync --once                                    # 跑一轮：先跑 refresh_now，再跑到点的任务
hub ops engage sync --once --platform Douyin --kind comments --force   # 不看时间表，立刻抓抖音评论
hub ops engage status                                         # 每个平台每个 kind 最近一次任务的状态、时间、条数，以及未处理事件数
```

`sync` 的退出码：`0` 表示这一轮跑完了（有任务失败也是 `0`，失败通过事件和飞书通知）；`1` 表示参数错；`5` 表示已有一轮在跑，这次没有跑。加 `--json` 时，标准输出只有 JSON，日志写到标准错误。

### 日志

每个任务在 `data/daemon.log` 里写一行：时间、平台、kind、结果，以及条数或跳过原因。日志里不写评论正文、昵称、密钥、cookie、token，也不写订阅地址的 query。能力位关着这类原因只在第一次出现或原因变化时写一行。

## 9. OpenBot 接法（KIN-324）

代码在 `integrations/openbot/`，不改麦田 `src/`。链路：

```
麦田守护进程 ──POST（X-Maitian-Signature）──▶ 接收端 127.0.0.1:8790/maitian/hook
  验签 → 按事件 id 去重入队（integrations/openbot/data/receiver.db）→ 马上回 200
  └─后台逐批▶ openbot-cli run 数据小管家 - --id maitian-<批次键>
                └─▶ 数据小管家：挂麦田 MCP read 组，按 persona「麦田事件处理」分类登记，每条 ack_event
```

### 为什么没用 OpenBot 原生 webhook routine

1. 原生 webhook 地址不在本机。OpenBot 用账号的 Signal 票据生成 `https://<OpenBot 云端>/v1/webhooks/<routeId>`，请求经云端中转回本机，评论私信内容会出本机，还依赖 OpenBot 账号在线。
2. 原生 webhook 的签名格式和麦田不同（`X-OpenBot-Signature` 覆盖 `<unix 秒>.<deliveryId>.<body>`，或 Standard Webhooks），而且签名密钥只在 OpenBot 界面里显示，要负责人手动建 routine 再复制密钥，没法自动完成，也没法复现。

本机 CLI 两个问题都没有：`--id` 是 OpenBot 的消息重试键（同一个键不重复投递），同一个 bot 在跑时新消息排队、不并发。

### 去重和批次键

- 接收端按 `events[].id` 去重，状态存盘，重启不丢。
- 批次键是**排序后的事件 id 列表**的 sha256 前 32 位，不含时间戳和随机数。同一批重试一直用同一个键，`--id maitian-<键>`。
- 投给 OpenBot 的消息里只有事件 id，没有评论私信正文。正文由 agent 用 MCP 读。

### 投递失败

CLI 非零退出或 60 秒超时算失败，同一批按 30 秒、2 分钟、10 分钟重试。4 次都失败就不再投，这批事件**不回执**，留给 agent 每轮开头的 `list_events({ unhandled: true })` 补漏。日志只写条数、批次键前缀、deliveryId 和错误摘要。

### 配置（`integrations/openbot/.env`，权限 0600，不进仓库）

见 `.env.example`。`OPENBOT_CLI` 默认是 app 内路径，启动时找不到文件就报错退出。`MAITIAN_SECRET` 由首次登记自动写入，不打印。

### 启动和查看

```sh
node integrations/openbot/receiver.mjs                    # 启动：先 subscribe_events（openbot-engage），再监听
curl -s http://127.0.0.1:8790/health                      # 收到、已投、待投、放弃的条数
node /Applications/OpenBot.app/Contents/Resources/cli/openbot-cli.mjs status 数据小管家 <deliveryId>   # 查一批的处理结果
```

`<deliveryId>` 在接收端日志「投递成功 … delivery <id>」里。launchd 模板：`integrations/openbot/com.maitian.openbot-receiver.plist`。

### 给数据小管家挂麦田 MCP

在 OpenBot「Marketplace → Apps」里加 stdio 服务（只有负责人能把服务分给 bot）：命令 `node`，参数 `<检出>/src/mcp/server.mjs --scope read`，环境变量只放 `MAITIAN_OPS_DB`。不要放 `MAITIAN_ENGAGE_TOKEN` 等写入口令。

## 10. Cindy 接法（KIN-325）

代码在 `integrations/cindy/`。本阶段 **Cindy 只订阅、只做对照**：正式处理和 `ack_event` 都归 OpenBot。Cindy 的结果只写进单独的对照文件 `~/Documents/OPC-vault/10.个人IP/数据/麦田事件对照-Cindy.jsonl`，不写正式记录和待确认文件，也不回执。

```
麦田发件箱 ──POST──▶ 127.0.0.1:8791/maitian/hook（receiver.mjs：验签、按事件 id 去重进收件箱、马上回 200）
                        │
Cindy 定时任务（每 2 分钟）── preRunHook：inbox.mjs check（有事件 exit 0，没有 exit 2 跳过、不花 token）
                        │
             agent（挂 127.0.0.1:8792/mcp，只有三个只读工具）：inbox.mjs pending → 读评论树或私信 → 分类 → inbox.mjs record
                        │
             对照文件（按事件 id 去重追加）写成功后，才把这些事件在收件箱里标成已处理
```

### 为什么没用 Cindy 原生的 webhook 触发

Cindy 0.1.141 的定时任务支持 webhook 触发，但打包版只走 Cindy 云端：公网地址、要登录 Cindy 账号、有配额，评论私信正文会出本机。本机 `127.0.0.1` 入口只在开发构建里、设了 `XDT_SCHEDULE_WEBHOOK_LOCAL=1` 才开。它验的签名头是 `x-hub-signature-256`，麦田发的是 `X-Maitian-Signature`。所以改用本机接收端加前置检查（preRunHook）。前置检查是 Cindy 给轮询类任务推荐的做法：exit 0 照常跑，exit 2 跳过这一轮。

### 两边同时订阅时要知道的

- 订阅方 id 不同：OpenBot 用 `openbot-engage`（8790），Cindy 用 `cindy-engage`（8791）。
- 麦田只推**还没回执**的事件。Cindy 的推送失败、等到重试时 OpenBot 已经回执了，这条就不会再推给 Cindy。接收端每 15 分钟用 `list_events`（不带 `unhandled`）补一次漏，保证两边收到的事件集合一致。补漏从「上次补漏成功开始的时间」往前 2 小时起查（水位存在收件箱里，停机重启也接得上；从没补过就查最近 24 小时），读完全部页才推进水位。连接加调用超过 60 秒按失败算，下一轮重来。
- 「2 小时没回执」提醒看的是全局 `events.handledAt`（`src/daemon/outbox.mjs`）：OpenBot 回执了，Cindy 那边就不会提醒。只有 OpenBot 也超时没回执时，两个订阅方各提醒一次。
- 以后要让 Cindy 当主处理方：OpenBot 停止回执（或对 `openbot-engage` 调 `unsubscribe_events`），Cindy 这边改 `agent-prompt.md` 加回执和正式记录。麦田不用改。

### 麦田 MCP 的 HTTP 版（给 Cindy 挂）

Cindy 的「添加 MCP 服务器」只收远程 http / sse 型，不收 stdio。所以 `integrations/cindy/mcp-http.mjs` 把麦田 MCP 包成 Streamable HTTP：

- 只监听 `127.0.0.1:8792`（`CINDY_MCP_PORT`），路径 `/mcp`，无会话模式，只收 POST。
- 每个请求都要带 `Authorization: Bearer <CINDY_MCP_TOKEN>`。token 首次启动时自动生成写进 `.env`（0600），不打印。Host 头只认 `127.0.0.1:端口` 和 `localhost:端口`，防 DNS rebinding。
- 只注册 `get_comment_thread`、`get_conversation`、`get_work` 三个只读工具（`buildServer` 的 `tools` 白名单）。`ack_event`、`list_events`、订阅、`refresh_now` 在这个入口上不存在，提示词以外多一道门。
- 日志只写方法和状态码，不写参数和结果。
- launchd 模板：`integrations/cindy/com.maitian.cindy-mcp.plist`。

### 配置（`integrations/cindy/.env`，权限 0600，不进仓库）

见 `integrations/cindy/.env.example`。`MAITIAN_SUBSCRIBER_ID` 不能用 `openbot` 开头的 id，`CINDY_LEDGER_FILE` 必须是 `.jsonl` 且不能指向 OpenBot 的记录、待确认、话术文件，配错了启动直接报错。`MAITIAN_SECRET` 由首次登记自动写入，不打印。验签、`.env` 读写、订阅登记直接复用 `integrations/openbot/` 的代码。

### 启动和查看

```sh
node integrations/cindy/receiver.mjs                      # 启动：先 subscribe_events（cindy-engage），再监听，再补漏
curl -s http://127.0.0.1:8791/health                      # 收件箱总数、已处理、待处理
node integrations/cindy/inbox.mjs check; echo $?          # 0 有待处理，2 没有
node integrations/cindy/compare.mjs --hours 24            # OpenBot 与 Cindy 的对照报告（只读，打印到终端）
```

launchd 模板：`integrations/cindy/com.maitian.cindy-receiver.plist`。Cindy 每轮的规则：`integrations/cindy/agent-prompt.md`。

### 在 Cindy 里要做的（负责人在界面上操作）

1. 在 Cindy 里把 `<检出>/integrations/cindy/project` 当项目打开。Cindy 会读到 `.cindy/automations/schedules.json` 里的「麦田事件对照」任务，同意导入。
2. 在设置里「添加 MCP 服务器」：显示名称 `麦田（只读）`，传输类型 HTTP，端点 URL `http://127.0.0.1:8792/mcp`，Bearer Token 填 `.env` 里的 `CINDY_MCP_TOKEN`。请求头不用加。保存后新建或重启的会话才生效。
3. 给这个任务选执行的伙伴（agent），确认它能用上一步的 MCP（工具列表里有 `get_comment_thread`）。
