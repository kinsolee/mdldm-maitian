# S7 MCP engage 组：回复评论、发私信（KIN-326 第一期）

这一期只做 `reply_comment` 和 `send_dm`，以及它们需要的框架。另有处置工具 `delete_comment`、`block_user`、`delete_conversation`，见第 8 节。点赞、置顶（`like_comment` / `unlike_comment` / `pin_comment` / `unpin_comment`）留到后续。

- B站：走接口，回复评论和私信都做了，用假 B站接口测过。**还没有在真实账号上发过**。
- 抖音、视频号、小红书：页面适配器已经写好，只在本地测试页上验证过。能力位默认关着。

## 1. 起服务

engage 组单独起一个 stdio 服务，和所有 bot 共用的 read 组分开：

```sh
MAITIAN_OPS_DB=<检出>/data/ops.db MAITIAN_ENGAGE_TOKEN=<口令> node <检出>/src/mcp/server.mjs --scope engage
```

- `--scope engage` 只注册 `reply_comment`、`send_dm` 和第 8 节的三个处置工具，不带 read 组工具。要读评论树、会话，请用另一个 `--scope read` 服务。
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

`needs_readback` 的记录（`sendAttempted = 1`，真点过发送或发到一半中断的）会一直拦住同一个 key 和同一个目标（评论、私信会话），换 key 也不行。之后每次被拦，`actions` 里还会多记一行 `needs_readback`、`sendAttempted = 0` 的审计行，它只是记录，不拦任何调用，也不用处理。去平台上看过之后，把原记录改掉：

```sh
# 平台上确实发出了（只有一条）：记成 sent，之后按已发出处理
sqlite3 data/ops.db "UPDATE actions SET status = 'sent', reason = 'human-confirmed' WHERE id = '<actionId>' AND status = 'needs_readback' AND sendAttempted = 1"
# 平台上确实没发出：记成 failed，之后可以再发
sqlite3 data/ops.db "UPDATE actions SET status = 'failed', reason = 'human-cleared' WHERE id = '<actionId>' AND status = 'needs_readback' AND sendAttempted = 1"
```

`<actionId>` 取法：第一次返回 `needs_readback` 的那次调用，用它返回的 `actionId`；之后被拦的调用，用返回里的 `previousActionId`（总是指向原记录），**不要**用被拦调用自己的 `actionId`（那是审计行，上面的 SQL 带了 `sendAttempted = 1`，改不动它）。也可以用下面查最近写入的 SQL 找 `sendAttempted = 1` 的那一行。

#### 抖音私信回读诊断

抖音 `send_dm` 回读没读到时，`readBack.detail` 末尾带一段脱敏诊断，只有数字和字段是否存在，没有正文、id、uid。根因还没用真实发送证实，下一次出现 `readback-missing` 时这样读：

```sh
sqlite3 -readonly data/ops.db "SELECT id, createdAt, json_extract(readBack,'$.detail') FROM actions WHERE platformCode = 'Douyin' AND op = 'sendDM' AND reason = 'readback-missing' ORDER BY createdAt DESC LIMIT 1"
```

格式：`诊断v1 msg=全部/本会话/我发的/候选新消息/同文候选 deep=A noid=B row=me,srv,new,eq hit=cm,ci,srv,content类型,fs,d`。

口径：这是回读落空后的一次扫描，只能提示下一步查什么，不能证明某条消息就是这次发的。

- 「本会话」包括没有 `conversationId` 的对象。
- 「候选新消息」和 `new1` 只表示它的 id 不在发送前快照里。快照只收正式回读能识别的消息（fiber 6 层内），所以发送前就存在、当时在更深层的旧消息也可能被算成候选。
- `msg` 末位是 0 只表示这次扫描没命中，不代表消息没发出。

| 看到的 | 说明 |
| --- | --- |
| `msg` 末位是 0，`row` 是 `me1,srv1,new1,eq1` | 目标会话行的 `lastMessage` 有同文候选，本次聊天区 fiber 扫描（20 层内）未命中。要另行验证它是否属于这次发送，才能考虑改读列表行 |
| `deep` 大于 0 | 同文候选在 fiber 第 6 层或更深，正式回读看不到。同样要先排除旧消息 |
| `noid` 大于 0 | 同文候选既没有 `clientMessageId` 也没有 `serverId`，正式回读会跳过。可能还没拿到服务端确认，这时不能算发出 |
| `hit` 的 content 类型是 `object` | 诊断能取到正文，正式回读只解析 JSON 字符串，两处解析方式不同。这种情况加长窗口没有用 |
| `hit` 是 `cm0,ci1,srv1,string` 且 `deep=0`、`noid=0` | 窗口结束时正式回读应该能读到。确认晚于最后一次回读是待验证的原因之一 |
| `msg` 末位和 `row` 的 `eq` 都是 0 | 这次扫描两处都没命中，先去平台确认是否真的发出 |

另外两张新表：`engage_write_leases`（平台写入租约）和 `engage_write_trips`（自动关能力位的记录，`alertedAt` 是提醒真正发出的时间）。

查最近的写入：

```sh
sqlite3 data/ops.db "SELECT id, createdAt, op, targetId, status, reason, sendAttempted, json_extract(readBack,'$.count') FROM actions ORDER BY createdAt DESC LIMIT 20"
```

## 5. 各平台现状

| 平台 | 回复评论 | 私信 | 怎么验证过 |
|---|---|---|---|
| B站 | 接口：`x/v2/reply/add`（楼中楼的正文前加「回复 @昵称 :」），用 `x/v2/reply/reply` 拉整楼重读和回读 | 接口：`web_im/v1/web_im/send_msg`，用 `svr_sync/v1/svr_sync/fetch_session_msgs` 重读和回读，回读只数这次之后的新消息 | 假 B站接口（`test/engage-writer-bili.test.mjs`）。真实账号还没发过。私信发送的表单字段按网页版写法，没在真实平台上核实 |
| 抖音 | 页面：评论管理页。「回复」是 `[class*=operations-]` 下文字为「回复」的子元素，按 fiber 上操作区组件的 `cid` 认目标；回复框 `[class*=reply-content-] [contenteditable=true]`；发送是同一个 reply-content- 里唯一的、没 disabled 的「发送」button | 页面：`[class*=chat-editor-] [contenteditable=true]` | 评论：2026-11-21 在真实评论管理页上只读核对过结构（找评论、「回复」按钮、回复框、发送按钮、楼中楼）；楼中楼只在页面视图模型里读到、不知道回的是谁的我的回复，按 `thread-incomplete` 不发，发后回读也不认它，测试页 `test/fixtures/engage-write/douyin-comments-real.html` 按真实结构做；同日再核对「选择作品」和一楼翻页：作品列表打开抽屉后才请求、最慢 3.3 秒才出来、每页 20 个滚到底翻页；默认作品的一楼列表比「选择作品」按钮晚几秒，先切走会被它晚到的响应盖回；一楼每页 10 条，滚到页面底部才加载下一页，页面上「没有更多视频」「没有更多评论」还有下一页时也显示，只认接口 has_more。写入器先等默认作品的一楼列表、作品列表最多翻 10 页、一楼最多加载 30 页，到上限还没找到按 `target-not-found` 返回并写明原因，测试页 `douyin-comments-picker.html`；同日第二次核对：页头当前作品的「发布于」fiber 上也有作品对象，作品卡片只认抽屉（`[class*=sidesheet]`）里的；按 Esc 关不掉抽屉，点遮罩能关；还偶尔出现过另一个版本的抽屉（`semi-sidesheet-*`，卡片 fiber 上读不到 `item_id_plain`），之后连续 17 次都没再出现，没拿到它的结构，遇到时切作品失败、按 `target-not-found` 不发；楼中楼总数读不到、或目标所在楼的一楼没加载出来，按 `thread-incomplete` 不发；一楼接口响应缺 `status_code` 或非 0 时不拿抓到的评论当依据；还没真发过，写接口的地址和响应没见过。私信只在本地测试页上验证过 |
| 视频号 | 页面：`textarea.create-input`（在 wujie shadowRoot 里，只认挂在目标 `.comment-item` 里的那个）；发送是同一个 `.comment-create-content` 里 `.create-ft` 下文字为「评论」、class 不带 `disabled` 的 `.tag-wrap` | 页面：`textarea.edit_area`；发送是所在 `.footer` 内唯一可见且非禁用态（非 `disabled` / `aria-disabled="true"` / `*disabled*` class / `pointer-events:none`）的「发送」按钮 | 评论：2026-11-21 在真实评论页上核对过回复入口、回复框、发送按钮（填一个占位字看它从 disabled 变可点，随即清空，没点）和回读用的 `replyCommentId`；还没真发过。私信：2026-11-25 在真实 `/platform/private_msg` 上只读核对过 DOM/Vue 结构（`.private-msg-wrapper` 的 `$data.sessionList` 与 computed `currentSessionId`、`.session-container` 滚动懒加载、`transition-group` 渲染无 `__vue__` 的 `.session-wrap`、`.session-dialog .header` 的 `sessionInfo.sessionId`、`mp-button` 发送按钮及乐观写入 `currentMsgStatus` 0/1/2/3 与服务端 `svrMsgId`、`-4300` `.phone-check-dialog`）；已按真实结构修复并重做测试页 `test/fixtures/engage-write/channels-dms.html`；还没真发过 |
| 小红书 | 页面：`textarea.comment-input` | 页面：`div.xhs-im-input-bar-editor` | 只在本地测试页上验证过 |

页面内接口写法（调页面自己的函数，不点按钮、不往框里打字）按能力位选用，默认都关，见 [S9-in-page-api.md](S9-in-page-api.md)：

| 能力位 | 管哪个操作 | 平台 |
|---|---|---|
| `writeViaApi` | `reply_comment` | 抖音、视频号 |
| `writeDmViaApi` | `send_dm` | 抖音 |

两个能力位各自开关、各自回撤，互不影响。它们只选写法，本身不授权：回复仍要 `reply`，私信仍要 `sendDM`。

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

B站私信（`sendDM`）、抖音、视频号、小红书各走一遍同样的流程。抖音私信的页面内接口写法（`writeDmViaApi`）另见下面「抖音私信接口写法首次真发」。页面平台第一次真发时，负责人最好在旁边看着 Ego 里那个 space 的页面。如果返回 `needs_readback`，先去平台上人工确认，查明原因前不要打开下一个平台。

关掉写入：`node src/hub.mjs ops accounts set-cap <账号 id> reply false`（`sendDM` 同理）。连续 2 轮失败时会自动关掉，并发飞书提醒。

### 抖音私信接口写法首次真发

只在负责人当次同意后做。步骤和上面相同，下面只写多出来的：

1. 负责人同意本次真发，并指定会话。最好是负责人自己用小号发来私信的会话，**最后一句要是对方说的**。
2. 打开能力位。负责人在 Ego 里看着 `kinso/Douyin/106707338905` 这个 space 的私信页：

   ```sh
   node src/hub.mjs ops accounts set-cap Douyin:106707338905 sendDM true
   node src/hub.mjs ops accounts set-cap Douyin:106707338905 writeDmViaApi true
   ```

3. 回评官调一次 `send_dm({ conversationId, text, idempotencyKey })`。应该返回 `status: "sent"`、`readBack.found: true`、`readBack.count: 1`，`readBack.nativeId` 不为空。
4. 在抖音私信页确认：消息只有一条，在正确的会话里，对方能看到（用小号看），页面没有弹安全验证，也没有「消息发送失败」提示。
5. 用同一个 key 再调一次，应该返回 `duplicate`。
6. 查 actions 表。`readBack.detail` 里有 `诊断api v1`，记着发送返回码和拉消息的条数：

   ```sh
   sqlite3 -readonly data/ops.db "SELECT id, createdAt, status, reason, json_extract(readBack,'$.detail') FROM actions WHERE platformCode = 'Douyin' AND op = 'sendDM' ORDER BY createdAt DESC LIMIT 5"
   ```

   格式：`send=s<成功>,st<statusCode>,b<body.status>,ck<checkCode>,fs<flightStatus>,id<有没有服务端 id>,<毫秒>ms pull=getMessagesByConversation n=<拉到>/<边界后的>/<我发的>/<同文>,cov<这一页有没有覆盖到发前边界>,top<有没有拉到最新端>,<毫秒>ms`，末尾 `unsure` 表示有消息缺序号或看不出是谁发的。返回码不是整数时记 `x`。出错时是 `send=err:<阶段>:<错误类型>` 或 `pull=err:<错误码>`，不带异常原文。回读到的 id 和发送返回的对不上时末尾加 `idMatch=0`。没有正文、消息 id、cookie、token。
7. 之后观察：每次 `readBack.found` 都要是 `true`。守护进程 stderr 里出现「页面自己的私信服务（IM SDK）没找到」、`precheck-error`，或者 actions 表里出现 `needs_readback`，马上回撤。

回撤（关掉接口写法，私信回到页面写法）：

```sh
node src/hub.mjs ops accounts set-cap Douyin:106707338905 writeDmViaApi false
```

要连私信一起停，再执行：

```sh
node src/hub.mjs ops accounts set-cap Douyin:106707338905 sendDM false
```

`needs_readback` 的记录按第 4 节「人工处理 needs_readback」处理。连续 2 轮失败自动关的是 `sendDM`，`writeDmViaApi` 不会被自动关：查明原因前要先手动关掉它，再重新打开 `sendDM`。

## 8. 处置：删评论、拉黑、删私信会话

用来处理广告评论和广告私信。每种操作做得到的平台见下表（代码里是 `src/ops/engage/moderate.mjs` 的 `MOD_SUPPORT`），其余调用返回 `rejected` / `unsupported-platform`，`detail` 写原因（`MOD_UNSUPPORTED`）。MCP 工具的说明按这两张表生成。三个工具和 `reply_comment` 在同一个 `--scope engage` 服务里，用同一个口令把关，走第 3 节同一套流程：回收、幂等、目标、能力位、库里预检、每轮上限、平台写入租约、在 space 里写、回执、连续失败自动关。

### 各平台能不能做

2026-11-22 只读核对各平台创作者后台的页面代码（没调写接口、没点按钮）。

| 平台 | `delete_comment` | `block_user` | `delete_conversation` |
|---|---|---|---|
| B站 | 能 | 能 | 能 |
| 抖音 | 能（见下文「抖音」） | 能（见下文「抖音」） | 不做：私信页删普通会话时，页面 IM SDK 先删本地、再调 `MarkConversationDelete`，服务端报错被 SDK 吞掉；页面上没有能确认服务端已删的读接口 |
| 视频号 | 能（见下文「视频号」） | 能，只能从评论发起（见下文「视频号」） | 做不了：视频号助手私信页没有删除会话（页面代码里 `deleteSessionById` 只打日志） |
| 小红书 | 在评估 | 做不了：网页版没有拉黑入口，页面只提示「请前往手机端」 | 做不了：网页版私信只能删群聊（`chats/remove/group`），单聊没有删除接口 |

### 视频号

写入脚本 `src/ops/engage/writers/channels-moderate.mjs`。调 wujie 沙箱 iframe 里页面自己的评论服务（和 S9 回复用的是同一个对象），鉴权头、请求体里的 `_log_finder_uin` 等由页面的请求封装加。入口和参数只从页面代码里读来（2026-11-22），**没有在真实账号上调过写接口**。

| 工具 | 页面服务调用 | 发前重读（命中就不调接口） | 发后回读（满足才算 `sent`） |
|---|---|---|---|
| `delete_comment` | `deleteComment({ exportId: 作品 objectId, commentId })` → `POST .../comment/del_comment`，`errCode=0` 是成功。和评论「删除」确认框一样 | 核对登录账号（`auth/auth_data`）；作品列表里找到作品的 `objectId`；用 `getCommentList` 把目标所在的楼读全（同 S9 回复）。楼读全了没有这条、或一楼列表翻到底没有这栋楼 → `already-gone`；楼没读全 → `thread-incomplete`；昵称是我 → `self-target`；一楼下面有回复、或回复没读全 → `deletes-thread` / `thread-incomplete` | 等 2 秒再读楼：楼读全了、这条不在了；一楼目标是一楼列表翻到底也没有它 |
| `block_user` | `blockUser({ refCommentId: 评论 id, refObjectId: 作品 objectId, modType: 1 })` → `POST .../comment/block_user`，`errCode=0` 是成功（`modType` 枚举 `Add=1`、`Del=2`）。和评论「更多 → 拉黑」一样 | 同上读到这条评论：不在了 → `target-not-found`（拉黑要靠它）；昵称是我 → `self-target`；`blacklistFlag` 已为真 → `already-blocked` | 等 1.5 秒再读这条评论，`blacklistFlag` 为真（页面上「已在黑名单」就是按它显示的） |

- 视频号不给评论者 uid（读适配器里 `author.uid` 是 `null`，「是不是我」按昵称），所以 `block_user` 的 `target` 只能是评论 id。`actions.targetId` 按这条评论记，`eventId` 只认这条评论自己的 `comment.created`。同一个人换一条评论再拉黑，框架认不出是同一个人，写入脚本发前看 `blacklistFlag` 会返回 `already-blocked`。
- 拉黑不删评论，所以一楼的作者也能拉黑，不受「一楼有回复」限制。
- 页面服务里没有 `deleteComment` / `blockUser`（页面改版）时返回 `failed` / `cannot-send`，不调接口。
- 删会话做不了，原因见上表。

能力位（默认全关）：

```sh
node src/hub.mjs ops accounts set-cap Channels:<uid> deleteComment true
node src/hub.mjs ops accounts set-cap Channels:<uid> block true
```

首次真发验收同 B站，每种操作第一次都要负责人当次同意。视频号另外要核对：没有要求验证手机（`baseResp.errcode=-4300`）；拉黑后这条评论的 `blacklistFlag` 确实变成真（`readBack`）；拉黑后对方的评论是否还显示在评论列表里（不显示的话回读会读不到，记 `needs_readback`，要改回读方法）。

### 抖音

写入脚本 `src/ops/engage/writers/douyin-moderate.mjs`。都调页面自己的接口封装函数，`msToken`、`a_bogus`、安全 SDK 的头由页面加，Node 里不拼签名。入口和参数只从页面代码里读来（2026-11-22），**没有在真实账号上调过写接口**。

| 工具 | 在哪调 | 发前重读（命中就不调接口） | 发后回读（满足才算 `sent`） |
|---|---|---|---|
| `delete_comment` | 评论管理页（`creator.douyin.com`）的评论服务 `awemeV1CommentMultiDelete({ cids, need_block: false })` → `POST /aweme/janus/creator/comment/aweme/v1/web/comment/multi_delete/`。和页面「删除」按钮一样；`need_block: true` 是「删除并拉黑」，不用 | 核对登录账号（`user/info`）；用 `awemeV1CommentListSelect` / `awemeV1CommentListReply` 把目标所在的楼读全（同 S9 回复）。楼读全了没有这条、或一楼列表翻到底没有这栋楼 → `already-gone`；楼没读全 → `thread-incomplete`；这条不属于这个作品 → `target-not-found`；作者是我 → `self-target`；一楼下面有回复 → `rejected` / `deletes-thread` | 等 2 秒再读楼：楼读全了、这条不在了；一楼目标是一楼列表翻到底也没有它 |
| `block_user` | 抖音网页版（`www.douyin.com`，和创作者后台同一个登录态）个人页模块里的拉黑函数 `(uid, sec_uid, 1, 0)` → `POST /aweme/v1/web/user/block/`，返回 `block_status=1` 是已拉黑。和网页版点「拉黑」一样 | 核对创作者后台登录账号；从来源评论（评论接口的 `user.sec_uid`）或来源会话（私信页会话对象的 `secUid`）重读对方的 `sec_uid`，重读出的 uid 要等于要拉黑的 uid；网页版 `profile/self` 的 uid 也要是这个账号（否则 `uid-mismatch`）；`profile/other` 的 uid 要对得上，`is_block` 已是 `true` → `already-blocked` | 等 1.5 秒再读 `profile/other`，`is_block` 是 `true` |

- 拉黑的来源：`target` 是评论 id 时用这条评论，是会话 id 时用这个会话，只给 `Douyin:<uid>` 时用库里这个人最近的一条评论（没有就用最近的会话）。来源评论已不在、来源会话不在私信列表里时读不到 `sec_uid`，返回 `failed` / `target-not-found`，换一条这个人的评论或会话再试。
- 模块 id 每次发版会变，按源码里的接口路径找函数：评论服务按方法名（同 S9），网页版按 `/aweme/v1/web/user/block/`、`/aweme/v1/web/user/profile/other/`、`/aweme/v1/web/user/profile/self/` 各找唯一一个函数。找不到返回 `failed` / `cannot-send`，不调接口。
- 删一楼：抖音删一楼会连楼下回复一起删，规则同 B站「删一楼」：`reply_comment_total` 或读到的楼中楼大于 0 就 `deletes-thread`，读不到 `reply_comment_total` 报 `thread-incomplete`。
- 已知限制：一楼列表最多读 30 页（同 S9），一楼目标所在作品的一楼超过 300 条时，删掉后确认不了「翻到底也没有它」，会记 `needs_readback`。
- 删会话不做，原因见上表。

能力位（默认全关）：

```sh
node src/hub.mjs ops accounts set-cap Douyin:106707338905 deleteComment true
node src/hub.mjs ops accounts set-cap Douyin:106707338905 block true
```

首次真发验收同 B站（下文「首次真发验收」），每种操作第一次都要负责人当次同意。抖音另外要核对：页面没有弹安全验证；`multi_delete` 的 `delete_result`、`user/block` 的 `block_status` 和这里写的一致（看 `actions` 的 `detail`）；拉黑后在抖音 App「设置 → 隐私 → 黑名单」里能看到对方。

### 工具

| 工具 | 入参 | 做什么 | B站接口 |
|---|---|---|---|
| `delete_comment` | `commentId`、`idempotencyKey`、`eventId?` | 删自己作品下别人的一条评论。楼中楼都可以删；一楼只在下面没有回复时删（见下文「删一楼」） | `x/v2/reply/del`（`oid`、`type=1`、`rpid`） |
| `block_user` | `target`、`idempotencyKey`、`eventId?` | 拉黑一个人 | `x/relation/modify`（`fid`、`act=5`、`re_src=11`） |
| `delete_conversation` | `conversationId`、`idempotencyKey`、`eventId?` | 从私信会话列表里删掉一个会话 | `session_svr/v1/session_svr/remove_session`（`talker_id`、`session_type=1`） |

- 三个接口都在 `member.bilibili.com` 页面里调，csrf（cookie `bili_jct`）只在页面里读、只在页面里填，不回到 Node。写入脚本是 `src/ops/engage/writers/bili-moderate.mjs`。
- `block_user` 的 `target` 有三种写法：`Bili:<mid>`、这个人的评论 id、和这个人的私信会话 id（B站会话 id 就是对方 mid）。框架从库里推出 mid，`actions.targetId` 按 `Bili:<mid>` 记，所以同一个人换一种写法也认得出。只认库里见过的人（评论作者或私信对方），没见过的返回 `rejected` / `unknown-target`。群聊、官方号会话的 id 不是用户 mid，返回 `rejected` / `not-a-user`，绝不拿来拉黑。同一个 id 既是评论 id、又是另一个人的 mid 时返回 `rejected` / `ambiguous-target`。
- `eventId`：`delete_comment` 填这条评论的 `comment.created`，`delete_conversation` 填这个会话的 `dm.received`，`block_user` 填这个人的任一条 `comment.created` 或 `dm.received`。事件必须是 B站同一个账号下的，别的平台 uid 碰巧一样也不算。对不上时返回 `rejected` / `event-mismatch`。
- `delete_conversation` 只删用户会话，群聊、官方号会话返回 `failed` / `not-a-user`。它只把会话从列表里移除，聊天记录还在。对方再发消息，会话会回到列表里。所以广告私信要先 `block_user`，再 `delete_conversation`。

### 返回字段

和 `reply_comment` 一样（见第 2 节），另外：

- `status` 用 `sent` 表示「已生效，并且回读确认了」，不另设 `done`。这样幂等、每轮上限、连续失败的判断和回复组用同一套规则。
- `op`：`delete`、`block`、`deleteConversation`。`actions.op` 也是这三个值。
- `targetId`：`block_user` 是推出来的 `Bili:<mid>`；入参写的是评论 id 或会话 id 时，多一个 `inputTarget`，原样返回入参。
- `readBack`：`found`（回读确认生效）、`count`（确认生效时为 1，否则为 0）、`nativeId`（被删的评论 rpid、被拉黑的 mid、被删的会话 talker_id）、`detail`。
- `ackedEvents`：自动回执的事件。处置组回执成 `ignored`（不是 `replied`），`handledNote` 写 `<op> <actionId>`。

### 发前重读和发后回读

| 工具 | 发前重读（命中就不调接口） | 发后回读（满足才算 `sent`） |
|---|---|---|
| `delete_comment` | 核对登录账号；作品的作者是我（`view` 的 `owner.mid`）；只定位目标这一条，不读整楼（见下文「删评论怎么定位」）。楼已删（`12022` / `-404`）→ `already-gone`；楼里定位不到这个 rpid、或对上的这条不属于这栋楼 → `target-not-found`；定位不了（`page.count` 不是非负整数、页内 rpid 不递增、读满 30 页、证明不了前后两条是谁）→ `thread-incomplete`；`reply/reply` 报错（如 `-412` 限流）→ `precheck-error`；作者是我 → `self-target`；一楼下面有回复 → `rejected` / `deletes-thread` | 等 2 秒再定位这一条：楼不在了（`12022` / `-404`），或者这条不在了、并且有证据表明它原来前后的两条现在挨着（见下文） |
| `block_user` | 核对登录账号；mid 是我 → `self-target`；`x/relation?fid=` 的 `attribute` 是 `128` → `already-blocked` | 等 1.5 秒再读 `x/relation?fid=`，`attribute` 是 `128` |
| `delete_conversation` | 核对登录账号；对方是我 → `self-target`；`get_sessions` 的四组会话列表都翻完（四组加起来最多 50 页，找到了也要翻完，分组见下文）。哪一组读失败 → `precheck-error`；哪一组翻不完 → `list-incomplete`（删了也确认不了）；四组都翻完了都没有这个会话 → `already-gone` | 等 1.5 秒再把四组翻一遍：都翻完了，并且哪一组都没有这个会话（在某一组里看到、或某一组翻不完，就不再读后面几组） |

- 接口只调一次。调过之后出任何错都只回读，不重调。
- 回读不满足时记 `needs_readback`，**绝不重试**。同一个目标换 key 也会被拦（`target-needs-readback`），人工处理方法同第 4 节。
- 接口明确报错（`code` 不是 0）时不算生效。和回复组不同，处置组调过接口却没确认生效的，一律记 `needs_readback` / `send-error-unconfirmed`（不记 `failed`），所以换 key 也不会再调第二次。例外：`reply/del` 返回 `12022`（调的时候已经被删了），回读确认不在就算 `sent`。
- 「翻完」要求严格：会话列表 `has_more` 为真时给了空页、`session_ts` 不是数字、页内不是从新到旧、比上一页的游标还新、或游标没往更早的方向走，都算没翻完。

#### 删评论怎么定位

删评论不需要判重（判重是回复才要的），所以不读整楼，只确认目标这一条。以前要求整楼读全（最多 10 页），热门大楼里的楼中楼广告因此永远是 `thread-incomplete`，删不掉（2026-11-21 第一次真实调用，两条都是这样）。

- 用的接口：`GET x/v2/reply/reply?oid=<aid>&type=1&root=<一楼 rpid>&ps=20&pn=<页码>`，和读适配器、回复写入脚本是同一个接口。接口文档（bilibili-API-collect `docs/comment/list.md`）写的是「按照回复顺序排序」，楼中楼的 rpid 随时间递增，所以可以按 rpid 二分页码：先读第 1 页拿 `page.count`，再二分，十来页就落到目标那一页，然后按 rpid 精确对上，并核对这条的 `root` 是这栋楼、`oid` 是这个作品、作者不是我。一次定位最多读 30 页。`page.count` 偏小（最后一页是满的、后面还有回复）时，往后加倍再找。
- 没用的接口：`x/v2/reply/info`（按 rpid 查单条）文档标注「已经弃用」；`x/v2/reply/wbi/main` 的 `seek_rpid` 要 Wbi 签名，而且是一楼列表，不是楼中楼；`x/v2/reply/dialog/cursor` 要对话树根 rpid，库里没有。
- 不猜：页内 rpid 不是递增的、第 1 页的 `page.count` 不是非负整数（缺失、负数、小数、`false`、空白串都算）、第 1 页是空的而 `page.count` 大于 0，都按「定位不了」报 `thread-incomplete`，不调接口。二分落空（按 rpid 该在的那一页没有它）报 `target-not-found`，不当成 `already-gone`，因为定位规则本身可能不准。
- 发前记下目标前后两条的 rpid（邻居，可以跨页，可以是「楼的开头」「楼的末尾」），读不到邻居也报 `thread-incomplete`。
- 发后回读：同样二分定位。这条还在 → 没删掉；这条不在了，并且有证据表明它原来前后的两条现在挨着 → 删掉了（原来后面是楼的末尾的，删完又来了新回复也算）；邻居变了（比如同时有别的删除）→ 确认不了。确认不了的一律 `needs_readback`，不重调。
- 「挨着」的证据只认这几种，并且用到的每一页都不能少给（满页，或者前面各页加本页的条数够得上这次读到的 `page.count`，B站隐藏、折叠了目标时页会对不上）：同一次读到的同一页里两条相邻；跨页时，不用定位时的缓存，先重读后一页、再重读前一页（删除只会让后面的评论往前挪，这个顺序拼不出假的「挨着」），并且前一页是满的；「楼的开头」就是第 1 页。「楼的末尾」要本页不满、并且前面各页加本页的条数够得上这次读到的 `page.count`，或者下一页是空的、`page.count` 也到这一页为止。接口少给、给空页时，凑不出这些证据，只会 `needs_readback`。
- 发前目标所在的页也要不少给，否则 `thread-incomplete`。如果 B站把还在的目标隐藏了、又从后面补了一条把页填满，这里分不出来（已知限制）。
- 发前取邻居用同一套规则：发后一定确认不了的（比如 `page.count` 偏大，删整楼最后一条），发前就报 `thread-incomplete`，不调接口。

#### 删一楼

B站删一楼，会把它下面的整楼回复一起删掉（别人的、我自己的都会没）。所以删一楼时先读第 1 页：`page.count`、本页条数、一楼的 `rcount` / `count` 里有一个大于 0，就返回 `rejected` / `deletes-thread`，不调接口，也不占每轮上限。`page.count` 读不到时判断不了，报 `failed` / `thread-incomplete`。一楼下面没有回复时照常删，回读看一楼还在不在（楼不在了才算删掉）。下面的回复删干净后，可以换一个 key 再删这个一楼。

写入脚本返回 `rejected: true` 时，框架记 `rejected`（不是 `failed`）。目前只有 `deletes-thread` 这样返回。

#### 私信会话的分组

`get_sessions` 的 `session_type` 是「读哪一组会话」，不是会话本身的类型。接口文档列了：1 用户与系统、2 未关注人、3 粉丝团、4 所有、5 被拦截、6 花火商单、7 所有系统消息、8 陌生人（不含官方消息）、9 关注的人与系统。以前只读 1 组，广告私信常落在未关注人、被拦截里，可能被误报成 `already-gone`（2026-11-21 删会话 `13030183` 就是这样，原因还没在平台上确认）。

现在发前、发后都把 1、2、5、8 四组翻完（四组加起来最多 50 页，发前发后各一次，留在 120 秒写入超时里），参数一样（`group_fold=1&unfollow_fold=0&sort_rule=2`），四组都没有才报 `already-gone`，`detail` 里写明读了哪几组。不读 3、7（粉丝团、系统消息，不是用户会话，也不删），不读 4（文档说 `sort_rule` 对 4 无效，按 `end_ts` 翻页的顺序没有保证），不读 6、9（6 是商单；9 是关注的人，按文档的说法应该已在 1 组里）。会话条目里的 `session_type` 仍要是 1（用户）才算对上。

### 绝不对自己动手

账号自身的 mid（例如 `Bili:478358005`），以及库里登记的所有 B站账号，一律拒绝，有两层：

1. 框架在库里判断：评论是我的（`authorIsMe = 1`，或作者 uid 是本平台账号）、拉黑对象是本平台账号（库里没见过这个 mid 也一样，先于 `unknown-target` 判）、会话对方是本平台账号，都返回 `rejected` / `self-target`。能力位开没开都一样，不起 runner。
2. 写入脚本在页面上再核一次：评论作者、拉黑 mid、会话 talker 是登录账号或本平台账号时，返回 `failed` / `self-target`，不调接口。

### reason 列表

| `status` | `reason` |
|---|---|
| `rejected` | `deletes-thread`（删一楼会连整楼回复一起删）、`self-target`、`not-a-user`、`unknown-target`、`ambiguous-target`、`capability-off`、`round-limit`、`lease-busy`、`in-progress`、`unsupported-platform`、`event-mismatch`、`idempotency-key-reused` |
| `failed`（没调接口） | `already-gone`（评论已不在，或会话已不在列表里；库里已标 `goneAt`、之前已删过的同一目标也是这个）、`already-blocked`（已在黑名单里，或之前已拉黑过这个 mid）、`not-a-user`、`not-my-work`、`thread-incomplete`（定位不了这条评论）、`list-incomplete`、`target-not-found`（楼里定位不到这条）、`self-target`、`uid-mismatch`、`no-uid`、`login-lost`、`precheck-error`、`send-error`（页面里没有 `bili_jct`）；space：`space-busy`、`space-user-controlled` |
| `needs_readback` | `send-error-unconfirmed`、`readback-missing`、`target-needs-readback`、`previous-needs-readback`、`runner-timeout`、`runner-exit-code`、`interrupted` |

`already-gone`、`already-blocked` 时事件不自动回执，需要时调用方自己 `ack_event`。

### 能力位、每轮上限、连续失败自动关

- 能力位：`deleteComment`（删评论）、`block`（拉黑）、`deleteConversation`（删会话，本次新增）。默认全关，各管各的，例如只开 `block` 不能删评论。
- 每轮上限：每个平台每轮（整点小时）每种操作分别最多 10 条（`MOD_ROUND_LIMIT`），只要调过接口就计数。处置组的条数不占回复组的 15 条，回复组也不占处置组的。
- 连续失败自动关：处置组单独判断。B站最近两个有处置的轮次都没有一条生效，并且都有调过接口却失败的，就关掉 `deleteComment`、`block`、`deleteConversation` 这三个能力位（回复的能力位不动），返回 `writeDisabled: true`，并用和第 3 节一样的方式（`defaultNotify`）发提醒。`engage_write_trips` 的 `family` 列记 `moderate`（回复组记 `write`，旧记录为空也当 `write`）。回复组的失败不会关处置能力位，处置组的失败也不会关回复能力位。

打开能力位：

```sh
node src/hub.mjs ops accounts set-cap Bili:478358005 deleteComment true
node src/hub.mjs ops accounts set-cap Bili:478358005 block true
node src/hub.mjs ops accounts set-cap Bili:478358005 deleteConversation true
```

关掉时把 `true` 改成 `false`。

### 私信能不能删会话

能。依据：B站网页版私信接口文档（SocialSisterYi/bilibili-API-collect 的 `docs/message/private_msg.md`）记有 `POST https://api.vc.bilibili.com/session_svr/v1/session_svr/remove_session`，表单是 `talker_id`、`session_type`（1 是用户）、`csrf`、`csrf_token`，可选 `build`、`mobi_app`；返回 `code` 0 成功、-101 没登录、-400 请求错误。文档说明它只把会话从列表里移除，不删聊天记录。本仓库的读适配器已经在用同一组的 `get_sessions`。**这个接口没有在真实账号上调过**，表单字段按文档写，第一次真删时要核对。

### 首次真发验收（每种操作第一次都要负责人当次同意）

删评论、拉黑、删会话都是对外的写操作，第一次在真实账号上做之前，都要负责人在当次对话里同意，并指定目标。最好用负责人自己的小号留一条评论、发一条私信来测，测完从黑名单里移除小号。每种操作分开验，一种没验过就不打开它的能力位。

以删评论为例：

1. 负责人同意本次在 B站真删一条评论，并指定是哪一条。
2. 用 `list_comments` 或 `get_comment_thread` 确认它在库里，记下 `commentId`。
3. 打开能力位：`node src/hub.mjs ops accounts set-cap Bili:478358005 deleteComment true`
4. 让回评官调用 `delete_comment({ commentId, idempotencyKey: "<事件 id>" })`。
5. 验收：
   - 返回 `status: "sent"`、`readBack.found: true`。
   - 在 B站评论管理页上这条评论已经不在，同楼别的评论都还在。
   - `actions` 表里有这一行，`op = 'delete'`、`status = 'sent'`。
   - 对应事件的回执是 `ignored`。
6. 用同一个 key 再调一次，应该返回 `duplicate`，接口没有再调。
7. 结果写进 PR 或 Linear（脱敏：昵称、正文都不写）。

拉黑：同样的步骤，打开 `block`，调 `block_user({ target: "<小号的评论 id>", idempotencyKey })`。验收时在 B站「黑名单」里能看到小号，`readBack.nativeId` 是小号的 mid。验完在网页上把小号移出黑名单。

删会话：打开 `deleteConversation`，调 `delete_conversation({ conversationId, idempotencyKey })`。验收时网页版私信列表里这个会话不在了。先核对 `remove_session` 的表单字段和返回是不是和文档一致（看 `readBack` 和 `actions` 的 `detail`），并核对 `get_sessions` 的 2、5、8 组在真实账号上返回的是不是对应分组。

删评论第一次真删时，还要核对：`x/v2/reply/reply` 楼中楼是不是真的按 rpid 递增（`detail` 里不该出现「不是按 rpid 递增」），以及大楼里翻到 30 页以内能不能定位到。

任何一步返回 `needs_readback`，先去平台上人工确认，查明原因前不要打开下一种操作。

## 9. 后续

- `like_comment` / `unlike_comment`（回读 `likedByMe`）、`pin_comment` / `unpin_comment`（每个作品只能置顶一条，返回里写明被顶掉的是哪条）。
- 页面平台要在真实页面上核对：怎么找到目标评论、回读的做法。
- OpenBot 回评官从「只登记」改成按话术真实回复。这部分属于 KIN-324 那边的人设和规则，不在这个 PR 里。
