# S7 MCP engage 组：回复评论、发私信（KIN-326 第一期）

这一期只做 `reply_comment` 和 `send_dm`，以及它们需要的框架。点赞、置顶（`like_comment` / `unlike_comment` / `pin_comment` / `unpin_comment`）留到后续。

- B站：走接口，回复评论和私信都做了，用假 B站接口测过。**还没有在真实账号上发过**。
- 抖音、视频号、小红书：页面适配器已经写好，只在本地测试页上验证过。能力位默认关着。

## 1. 起服务

engage 组单独起一个 stdio 服务，和所有 bot 共用的 read 组分开：

```sh
MAITIAN_OPS_DB=<检出>/data/ops.db MAITIAN_ENGAGE_TOKEN=<口令> node <检出>/src/mcp/server.mjs --scope engage
```

- `--scope engage` 只注册 `reply_comment` 和 `send_dm`，不带 read 组工具。要读评论树、会话，请用另一个 `--scope read` 服务。
- 只有进程环境里的 `MAITIAN_ENGAGE_TOKEN` 和仓库根目录 `.env` 里的值一致时，才注册这两个工具。比较用 `src/ops/tokens.mjs` 的 `checkToken`，是常数时间比较。
- 口令缺失或对不上时，服务照常启动，但一个工具都不注册（`tools/list` 返回空列表），并往 stderr 写一句原因。口令值不会出现在日志、错误和返回值里。
- `--scope read` 的行为不变。带着口令起 read 服务，也不会注册写工具。
- `.env` 的位置可以用 `MAITIAN_ENV_FILE` 改，见 S1 文档。口令用 `hub ops tokens init` 生成。

## 2. 工具

两个工具的 id 都写成 `<platformCode>:<原生 id>`，和 read 组一样。参数格式不对时，工具返回 `isError: true`，错误文字说明要怎么写。

| 工具 | 入参 | 做什么 |
|---|---|---|
| `reply_comment` | `commentId`、`text`、`idempotencyKey`、`eventId?` | 回复一条评论，一楼和楼中楼都可以 |
| `send_dm` | `conversationId`、`text`、`idempotencyKey`、`eventId?` | 在一个私信会话里回一句 |

- `text`：1 到 1000 字，不能全是空白。
- `idempotencyKey`：1 到 300 字，建议填事件 id。
- `eventId`：可选，在幂等判断之前核对。填了就必须是这个目标的事件：`reply_comment` 对应 `comment.created`，`send_dm` 对应 `dm.received`，并且事件的 `subjectId` 等于目标 id。对不上时返回 `rejected` / `event-mismatch`。

### 返回字段

```json
{ "status": "sent", "reason": null, "detail": null, "retryable": false,
  "op": "reply", "targetId": "Bili:2851...", "accountId": "Bili:478358005",
  "idempotencyKey": "comment.created:Bili:2851...", "eventId": null, "actionId": "act_…",
  "sendAttempted": true, "readBack": { "found": true, "count": 1, "nativeId": "2851..." },
  "ackedEvents": ["comment.created:Bili:2851..."], "writeDisabled": false }
```

| 字段 | 含义 |
|---|---|
| `status` | `sent`、`needs_readback`、`failed`、`duplicate`、`rejected`，含义见下表 |
| `reason` | `failed`、`rejected`、`needs_readback` 的原因代码，见下表；`sent`、`duplicate` 时为 `null` |
| `detail` | 给人看的说明（已脱敏） |
| `retryable` | 为 `true` 时，原样再调一次（用同一个 `idempotencyKey`）可能成功，例如 space 被占、本轮已满 |
| `op` | `reply` 或 `sendDM` |
| `targetId` / `accountId` | 目标 id、发送用的账号 |
| `actionId` | 这次调用在 `actions` 表里的行 |
| `sendAttempted` | 点过发送按钮或调过发送接口。runner 超时、异常退出时不知道有没有点，也记为 `true` |
| `readBack` | 发后回读的结果：`found`（恰好回读到 1 条才是 `true`）、`count`（回读到几条一样的）、`nativeId`（平台给的新回复 id，拿得到才有）、`detail`。没点发送时为 `null` |
| `previousActionId` | `duplicate`、`needs_readback`（上次没回读到）、`in-progress` 时，指向之前那次调用 |
| `ackedEvents` | 这次自动回执成 `replied` 的事件 |
| `writeDisabled` | 这次调用触发了「连续 2 轮失败自动关写能力位」（包括这次调用开头回收崩溃留下的记录时触发的） |

| `status` | 含义 | 常见 `reason` |
|---|---|---|
| `sent` | 回读确认发出了 | — |
| `needs_readback` | 点了发送，但没回读到（或回读到不止 1 条）。**绝不重试**，同一个 key 以后也不会再发。请人工去平台上看 | `readback-missing`、`readback-count`、`readback-mismatch`（回读到的那条和发送接口返回的 id 对不上）、`target-needs-readback`、`runner-timeout`、`runner-exit-code`、`previous-needs-readback`、`interrupted` |
| `failed` | 没发出。可能是发前重读拦下了，也可能是平台明确报了错 | 重读：`comment-gone`、`already-replied`、`last-is-me`、`cannot-send`、`target-not-found`、`thread-incomplete`（楼里的回复没读全，判断不了是否已回过）、`uid-mismatch`、`no-uid`、`login-lost`、`no-input-box`、`input-mismatch`、`precheck-error`；发送：`send-error`；space：`space-busy`、`space-user-controlled` |
| `duplicate` | 同一个 `idempotencyKey` 24 小时内已经发出过，这次没发 | — |
| `rejected` | 按规则拒绝，没碰平台 | `capability-off`、`round-limit`、`lease-busy`、`in-progress`、`unknown-target`、`unsupported-platform`、`event-mismatch`、`idempotency-key-reused` |

## 3. 规则

一次调用按下面的顺序走。从第 1 步到第 6 步在同一个 SQLite `BEGIN IMMEDIATE` 事务里完成，所以多个 MCP 进程同时调用时也不会抢到同一个 key 或同一份租约。

0. **回收**：先把超过 30 分钟还是 `pending` 的记录（进程崩了或被杀）一律记成 `needs_readback`（不知道点没点发送），并按第 9 步判断要不要自动关写能力位。
1. **幂等**：查同一个 `idempotencyKey` 的记录（`sent` 只看 24 小时内；`needs_readback`、`pending` 不限时间）。
   - 已经 `sent`：返回 `duplicate`。如果带了还没回执的 `eventId`，顺手回执成 `replied`。
   - 已经 `needs_readback`：返回 `needs_readback`，不再发，过了 24 小时也一样。
   - 还在 `pending`：返回 `rejected` / `in-progress`。如果 `pending` 已经超过 30 分钟，说明上一个进程崩了，这条记成 `needs_readback`。
   - 同一个 key 已经在别的目标或别的操作上发过（或点了发送没确认）：返回 `rejected` / `idempotency-key-reused`。只被拒、没发出的调用不占用 key。
   - 之前只是 `failed` 或 `rejected`：可以再试。
2. **目标**：评论或会话必须已经在库里（守护进程抓到过）。库里没有就返回 `rejected` / `unknown-target`。这时先调 `refresh_now`，等抓完再试。平台只认抖音、视频号、小红书、B站。
3. **能力位**：账号的 `reply`（回复评论）或 `sendDM`（私信）能力位必须打开，没开返回 `rejected` / `capability-off`。全部能力位默认都是关的。
4. **库里预检**：如果库里已经看得出不该发，就直接返回 `failed`，不打开页面：
   - 评论已标 `goneAt`。
   - 库里已经有我对这条评论的直接回复。
   - 会话最后一句是我说的。
   - 对方不能收私信（`canSend=false`，例如官方号）。
   - 这个目标之前用别的 key 发过（这一条最先判，库同步后显示「已回复」也不会盖掉「点了发送没确认」）：评论回过就返回 `failed` / `already-replied`；私信在对方最后一句之后发过就返回 `failed` / `last-is-me`；之前点了发送没确认的返回 `needs_readback` / `target-needs-readback`；正在发的返回 `rejected` / `in-progress`。换 key 也绕不过去。
     - 私信判断「对方之后有没有再说话」时，只比发信当时记下的会话时间（`actions.targetLastAt`，平台时间）和现在的 `lastAt`：相同就是没新话，拦；不同就放行。不拿本机时间和平台时间比，所以两边时钟有偏差既不会重发，也不会把对方的新消息一直拦住。发信时会话还没有 `lastAt` 的记成空串，对方之后一说话就放行。`targetLastAt` 为空值（NULL）的是本分支早期建的库升级来的记录，判断不了，保守拦，要人工处理：确认对方之后说的是新话，就把那一行的 `targetLastAt` 改成当时的 `lastAt`，或者按下面「人工处理」改状态。
     - 正在发（`pending`）和点了发送没确认（`needs_readback`）不看会话时间，一律拦。**私信也是保守做法**：对方之后又说了新的，也不放行，直到人工处理（见第 4 节「人工处理 needs_readback」）。
5. **每轮上限**：每个平台每轮最多 15 条，超过返回 `rejected` / `round-limit`，下一轮恢复。一轮是一个整点小时（UTC，台湾时间也是整点对齐），只要点过发送就计数。
6. **平台写入租约**（`engage_write_leases` 表）：同一个平台同一时间只有一个写入方。被别人持有时返回 `rejected` / `lease-busy`。租约时长是写入超时（B站 2 分钟，页面平台 6 分钟）再加 2 分钟，过期后可以接管，写完马上释放。
7. **在账号的 space 里写**：经 runner（`src/ego-runner`）在 `kinso/<platformCode>/<uid>` 里跑写入脚本。runner 自带 S1 的 space 锁，space 被守护进程或负责人占着时返回 `failed` / `space-busy`，可以重试。写入脚本按这个顺序做：
   - 先核对页面上登录的是不是这个账号，不是就不动手。
   - **发前重读**：看评论是不是已删、是不是已有我的回复、会话最后一句是不是我。是就返回 `failed` 和原因。抖音、视频号私信点开后要确认聊天区当前就是这个会话（抖音看聊天区消息的 `conversationId`，视频号看聊天区组件带的会话 id），否则不发（`target-not-found`）。B站页面里读不到 `bili_jct` 时不调发送接口，返回 `failed` / `send-error`，`sendAttempted` 为 false。小红书评论只能按「昵称 + 正文」在通知页上定位，昵称或正文为空（纯图片评论）时不发，读不到自己的昵称时也不发（`no-uid`）。楼里的回复读不全（B站超过 10 页、抖音和视频号展开到上限还有没加载的）时也不发，返回 `thread-incomplete`。
   - 发送只触发一次。
   - **发后回读**：发送前没有的、我发的、内容一样的新条目恰好 1 条才算 `sent`；发送接口返回了新 id 的（B站），那一条还必须就是它；发送接口明确报错时，回读到一样的也不算。否则记 `needs_readback`，**绝不重试**。
8. **回执**：`sent` 之后，`eventId` 和这个目标所有还没回执的同类事件都会自动回执成 `replied`，`actionId` 记进事件。
9. **连续失败自动关**：同一个平台最近两个有写入的轮次，如果都没有一条发出，并且都有点了发送却失败的（`failed` 或 `needs_readback`），就关掉这个平台所有账号的写能力位（`reply`、`sendDM`、`likeComment`、`pinComment`），返回里 `writeDisabled: true`，并发一张飞书提醒。提醒走 `src/ops/login.mjs` 的 `defaultNotify`，和掉线提醒用同一个机器人。下面几种情况不影响这个判断：
   - 发前重读拦下的、被拒的、space 被占的，不算写入失败。
   - 中间没有写入的小时，不打断「连续」。
   - 提醒没发出去时，下一次调用会补发。
   - 负责人重新打开能力位后，从下一轮重新计数。

## 4. actions 表

每次调用记一行，被拒、重复的也记。建表在 `src/ops/engage-db.mjs`，用的是 `CREATE TABLE IF NOT EXISTS`，所以旧库打开时会自动补上新表，已有数据不动。

| 列 | 含义 |
|---|---|
| `id` | `act_<uuid>` |
| `op` | `reply` 或 `sendDM` |
| `caller` | 调用方：`mcp:<MCP 客户端名>`（取自 MCP initialize 的 clientInfo.name） |
| `accountId`、`platformCode`、`targetId` | 账号、平台、目标 |
| `textHash` | 正文的 sha256。**不存正文** |
| `idempotencyKey`、`eventId` | 幂等键。`eventId` 是调用方给的事件；没给时记这次自动回执的事件，多个用逗号隔开 |
| `status`、`reason`、`detail` | 结果，含义同上一节。发送中是 `pending` |
| `sendAttempted` | 点过发送为 1 |
| `readBack` | 回读结果，JSON 格式 |
| `roundKey` | 整点小时，例如 `2026-11-21T03` |
| `targetLastAt` | `send_dm` 发信时库里会话的 `lastAt`（平台时间；当时没有就是空串）；回复评论、以及旧库升级来的记录为 NULL |
| `createdAt`、`finishedAt` | 开始和结束时间 |

### 人工处理 needs_readback

`needs_readback` 的记录会一直拦住同一个 key 和同一个目标（评论、私信会话），换 key 也不行。去平台上看过之后，在库里把那一行改掉：

```sh
# 平台上确实发出了（只有一条）：记成 sent，之后按已发出处理
sqlite3 data/ops.db "UPDATE actions SET status = 'sent', reason = 'human-confirmed' WHERE id = '<actionId>' AND status = 'needs_readback'"
# 平台上确实没发出：记成 failed，之后可以再发
sqlite3 data/ops.db "UPDATE actions SET status = 'failed', reason = 'human-cleared' WHERE id = '<actionId>' AND status = 'needs_readback'"
```

`actionId` 在调用返回的 `actionId` 或 `previousActionId` 里，也可以用下面查最近写入的 SQL 找。

另外两张新表：`engage_write_leases`（平台写入租约）和 `engage_write_trips`（自动关能力位的记录，`alertedAt` 是提醒真正发出的时间）。

查最近的写入：

```sh
sqlite3 data/ops.db "SELECT createdAt, op, targetId, status, reason, json_extract(readBack,'$.count') FROM actions ORDER BY createdAt DESC LIMIT 20"
```

## 5. 各平台现状

| 平台 | 回复评论 | 私信 | 怎么验证过 |
|---|---|---|---|
| B站 | 接口：`x/v2/reply/add`（楼中楼的正文前加「回复 @昵称 :」），用 `x/v2/reply/reply` 拉整楼重读和回读 | 接口：`web_im/v1/web_im/send_msg`，用 `svr_sync/v1/svr_sync/fetch_session_msgs` 重读和回读，回读只数这次之后的新消息 | 假 B站接口（`test/engage-writer-bili.test.mjs`）。真实账号还没发过。私信发送的表单字段按网页版写法，没在真实平台上核实 |
| 抖音 | 页面：评论管理页，回复框 `[class*=reply-content-] [contenteditable=true]` | 页面：`[class*=chat-editor-] [contenteditable=true]` | 只在本地测试页上验证过（`test/engage-writers-page.test.mjs`） |
| 视频号 | 页面：`textarea.create-input`（在 wujie shadowRoot 里） | 页面：`textarea.edit_area` | 只在本地测试页上验证过 |
| 小红书 | 页面：`textarea.comment-input` | 页面：`div.xhs-im-input-bar-editor` | 只在本地测试页上验证过 |

页面平台用 `Input.insertText` 填写。填完先读回输入框，内容和要发的不一致就清空，返回 `input-mismatch`，不点发送。各平台怎么找目标评论、怎么判断已经回复过、怎么回读，写在 `src/ops/engage/writers/<平台>.mjs` 文件头的注释里。

B站的 csrf（cookie `bili_jct`）只在页面里读取、只在页面里填进表单，不会回到 Node，也不会进日志。

## 6. 在 OpenBot 里只挂给回评官

所有 bot 共用的 `maitian` 服务（`--scope read`）不动。另外加一个 `maitian-engage` 服务，**只分给回评官**（agentId `agent-b3238964-0b15-4563-90eb-b20e968e7983`）。

1. 确认 `.env` 里有口令。在麦田主检出 `~/code/github/kinsolee/mdldm-maitian` 里执行 `node src/hub.mjs ops tokens init`。这个命令已有口令时不会改动，也不会打印口令值。
2. 把口令复制到剪贴板，不要显示在屏幕上：

   ```sh
   grep '^MAITIAN_ENGAGE_TOKEN=' ~/code/github/kinsolee/mdldm-maitian/.env | cut -d= -f2- | tr -d '\n' | pbcopy
   ```

3. 在 OpenBot 的「Marketplace → Apps」里新加一个 stdio 服务（只有负责人能把服务分给 bot）：
   - 名称：`maitian-engage`
   - 命令：`node`
   - 参数：`/Users/kinso/code/github/kinsolee/mdldm-maitian/src/mcp/server.mjs --scope engage`
   - 环境变量：`MAITIAN_OPS_DB=/Users/kinso/code/github/kinsolee/mdldm-maitian/data/ops.db`，以及 `MAITIAN_ENGAGE_TOKEN=`（粘贴第 2 步复制的值）
4. 只把 `maitian-engage` 分给回评官，**不要分给其他 bot**。回评官原来的 `maitian`（read）服务保留，它要靠这个服务读评论树和会话。
5. 检查：回评官的工具列表里应该出现 `reply_comment` 和 `send_dm`，其他 bot 的工具列表里不应该有这两个工具。如果回评官看不到这两个工具，看 OpenBot 里这个服务的 stderr：口令缺失时写「进程环境里没有 MAITIAN_ENGAGE_TOKEN」，口令对不上时写「…和仓库 .env 里的不一致…」。
6. 能力位此时都还关着，回评官调用只会得到 `rejected` / `capability-off`。按第 7 节开通。

换口令时（例如在 `.env` 里改了口令），OpenBot 里的值也要同步更新。改完后要重启这个服务：口令只在服务启动时校验一次。

## 7. 首次真发验收（每个平台每种操作第一次都要负责人当次同意）

对外发消息属于「必须先问」。每个平台的 `reply` 和 `sendDM` 第一次真发前，都要负责人在当次对话里同意。之后的常规自动回复属于已有授权（原 `comment-dm-auto-reply` 的范围）。

以 B站回复评论为例：

1. 负责人同意本次在 B站真发一条评论回复，并指定目标。最好是负责人自己用小号留的评论。
2. 守护进程抓到这条评论后，用 `list_comments` 或 `get_comment_thread` 确认它在库里，记下 `commentId`。
3. 打开能力位：

   ```sh
   node src/hub.mjs ops accounts set-cap Bili:478358005 reply true
   ```

4. 让回评官调用 `reply_comment({ commentId, text: "<负责人认可的话>", idempotencyKey: "<事件 id>" })`。
5. 验收以下几项：
   - 返回 `status: "sent"`、`readBack.found: true`、`readBack.count: 1`。
   - 在 B站评论管理页上能看到这条回复，并且只有一条。
   - `actions` 表里有这一行，`status = 'sent'`。
   - 对应事件的回执是 `replied`。
6. 用同一个 key 再调一次，应该返回 `duplicate`，平台上没有出现第二条。
7. 之后观察 24 小时：没有重复回复，每次写入的 `readBack.found` 都是 `true`。用第 4 节的 SQL 查。
8. 结果写进 PR 或 Linear（脱敏：昵称、正文都不写）。

B站私信（`sendDM`）、抖音、视频号、小红书各走一遍同样的流程。页面平台第一次真发时，负责人最好在旁边看着 Ego 里那个 space 的页面。如果返回 `needs_readback`，先去平台上人工确认，查明原因前不要打开下一个平台。

关掉写入：`node src/hub.mjs ops accounts set-cap <账号 id> reply false`（`sendDM` 同理）。连续 2 轮失败时会自动关掉，并发飞书提醒。

## 8. 后续

- `like_comment` / `unlike_comment`（回读 `likedByMe`）、`pin_comment` / `unpin_comment`（每个作品只能置顶一条，返回里写明被顶掉的是哪条）。
- 页面平台要在真实页面上核对：怎么找到目标评论、回读的做法。
- OpenBot 回评官从「只登记」改成按话术真实回复。这部分属于 KIN-324 那边的人设和规则，不在这个 PR 里。
