# S9 评论、私信改用页面内接口（KIN-326）

在账号自己的 space 里，**调页面自己的接口封装函数**，代替「点选择作品、点查看回复、点发送」。签名、鉴权头、风控 SDK 都由页面自己加，Node 里不拼签名。两种写法并存，按账号能力位选用，默认还是 DOM，合并以后线上行为不变。

评估依据：`/Users/kinso/OpenBot/Shared/maitian-api-direct-eval-20261121.md`。探针在 2026-11-21 做，只调读接口，没点按钮、没输入。

## 1. 现状

| 平台 | 读评论 | 读私信 | 回评论 | 发私信 |
|---|---|---|---|---|
| B站 | 接口（原来就是） | 接口（原来就是） | 接口（原来就是） | 接口（原来就是） |
| 抖音 | **页面内接口（可选）**：页面评论服务 `awemeV1CommentListSelect` / `awemeV1CommentListReply` | **Context 读取（可选，挂 `readViaApi`）**：读聊天区 React Context 的 `conversationList` + `strangerConversationList`（含首屏外与陌生人会话），读不到或结构异常时退回 DOM（IM SDK 的 fiber） | **页面内接口（可选）**：页面评论服务 `awemeV1CommentMultiPublish` | **页面内接口（可选）**：私信页的 `sendMessageWithAuth`，回读用 IM SDK 的 `getMessagesByConversation` |
| 视频号 | **页面内接口（可选）**：沙箱 iframe 里的评论服务 `getCommentList` | DOM（Vue 组件数据） | **页面内接口（可选）**：同一个服务的 `createComment` | DOM |
| 小红书 | 不变（抄页面自己的响应） | 不变 | 不变（DOM） | 不变（DOM） |

「可选」是指账号能力位打开时才走，关着时走原来的 DOM 路径。

## 2. 开关

账号能力位里新加三个，默认都是 `false`：

| 能力位 | 打开后 |
|---|---|
| `readViaApi` | 抖音、视频号的评论采集改成调页面服务（不再点作品、不点展开）；抖音私信采集改为读聊天区 React Context（`conversationList` + `strangerConversationList`，首次 Context 同步按采集水位过滤旧私信，Context 不可用或结构异常时自动回落 DOM）；视频号私信不变 |
| `writeViaApi` | 抖音、视频号的 `reply_comment` 改成调页面服务。`send_dm` 不受它影响 |
| `writeDmViaApi` | 抖音的 `send_dm` 改成调私信页自己的发送函数。`reply_comment` 不受它影响 |

每轮每个抖音会话只采一份末条。首屏有这个会话就使用 DOM，包括撤回、己方回复和空末条；首屏外才使用 Context。两者共用 DOM 的消息解析和消息表原生键，文本只取可见正文。首屏按前一次 DOM 末条的时间判断更新。Context 不推进 DOM 水位。两路切换时比较已入库的原生 ID，遇到只有一边保留毫秒的读数，再核对同会话、方向、类型和可见正文。原始 SDK 时间用于事件去重，保留可用的毫秒。消息表保留已经处理的来源。若一条本应由 DOM 派发的消息只因与 Context 旧行同秒同文而暂缓，重启后读到可区分的 ID 时仍可派发。

首次开启 Context 时优先使用同账号上次成功私信任务的开始时间，再使用已保存的采集时间。若旧库只有基线入库时间，首屏外未见过的旧消息按该时间建基线；首屏使用上次已观察到的最新发送时间。旧库为空时，首屏沿用 main 的派发行为。账号采集基线之后、成功任务开始之前的首屏外消息先入库；进入首屏时按 DOM 判断派发。会话首次采集的历史末条单独保留，撤回不改变基线。关闭 `readViaApi` 可恢复纯 DOM 采集；回滚代码时可以保留新增表和可空列。

```sh
node src/hub.mjs ops accounts set-cap Douyin:106707338905 readViaApi true
node src/hub.mjs ops accounts set-cap Douyin:106707338905 writeViaApi true   # 只有负责人同意首次真发时才开，见第 7 节
node src/hub.mjs ops accounts set-cap Douyin:106707338905 writeViaApi false  # 关回页面写法
node src/hub.mjs ops accounts set-cap Douyin:106707338905 writeDmViaApi true   # 私信，只有负责人同意首次真发时才开，见第 7 节
node src/hub.mjs ops accounts set-cap Douyin:106707338905 writeDmViaApi false  # 私信关回页面写法
```

- 这三个能力位只选择读写的方法，本身不授权写入：回复评论仍然要打开 `reply`，私信仍然要打开 `sendDM`。连续 2 轮失败自动关写能力位时，`reply`、`sendDM` 会被关掉，所以 `writeViaApi`、`writeDmViaApi` 不用另外关。
- 回复评论和私信分开开关：出问题时只回撤出问题的那一个。
- 小红书、B站开了也没有影响；视频号开 `writeDmViaApi` 也没有影响。
- 页面服务找不到时（例如页面改版）：读退回 DOM 路径，原始数据里写 `apiFallback`；写（回复评论、私信）不发送，返回 `failed` / `cannot-send`，不算写入失败，也不退回 DOM。

## 3. 怎么找到页面服务

见 `src/ops/engage/inpage-api.mjs`。往页面的 webpack chunk 数组里 push 一个空 chunk，拿到 `__webpack_require__`；按方法名在模块源码里找模块（模块 id 每次发版都会变），再在模块导出里找带这些方法的对象。只读取函数引用，不改页面状态。

- 抖音：评论管理页是 Garfish 子应用 `interactive`，chunk 在 `Garfish.activeApps[*].global.webpackChunkcreator_interactive`。
- 视频号：chunk 在 wujie 沙箱 iframe（`name=interaction`，和页面同源）的 `webpackChunkinteraction` 上。

两次调用之间至少隔 800 毫秒。翻页上限和 DOM 路径相同：

- 抖音：一楼 30 页，楼中楼每个作品 25 次请求。
- 视频号：一楼 10 页，楼中楼每个作品 15 次请求。

读不全的作品照旧标 `threadsPartial`。

## 4. 探针结果（脱敏）

### 抖音（主动读请求共 4 次）

- 页面的 `fetch`、`XMLHttpRequest` 都被字节的 SDK 包装过，不是原生函数。在页面里用页面的 `fetch` 发请求，会**自动带上 `msToken` 和 `a_bogus`**。
- 一楼：`GET /web/api/third_party/aweme/api/comment/read/aweme/v1/web/comment/list/select/`
  - 参数：`aweme_id=<id>&cursor=0&count=10&comment_select_options=0&sort_options=0&channel_id=618&app_id=2906&aid=2906&device_platform=webapp&msToken=<页面加>&a_bogus=<页面加>`
  - 返回：HTTP 200、`status_code=0`，`comments` 6 条，`has_more=0`。
- 楼中楼：`GET /web/api/third_party/aweme/api/comment/read/aweme/v1/web/comment/list/reply/`
  - 参数：`comment_id=<cid>&cursor=0&count=10&channel_id=618&app_id=2906&aid=2906&device_platform=webapp&msToken&a_bogus`
  - 返回：`status_code=0`，4 条，等于一楼的 `reply_comment_total`；`reply_id` 是一楼 cid。
- 旧路径 `/aweme/v1/creator/comment/list/select/`、`/aweme/v1/creator/comment/list/reply/` 返回 HTTP 200、`status_code=0`，但 `status_msg` 是 `url doesn't match`，并且**没有 `comments`**。所以「`status_code=0` 但没有列表」要按出错处理，代码里已经这样处理。
- 作品列表不用主动请求：页面打开时自己会发 `GET /aweme/v1/creator/item/list?cursor=&aid=2906&msToken&a_bogus`，照旧抄这个响应。
- 页面评论服务能拿到（只看了 `typeof`，没有调写函数）：`awemeV1WebCommentDigg`、`awemeV1CommentPublish`、`awemeV1CommentMultiPublish`、`awemeV1CommentListSelect`、`awemeV1CommentListReply`、`awemeV1CommentMultiDelete`。

### 抖音私信（2026-11-24，没有主动请求）

只读了私信页的 webpack 模块源码（`String(模块函数)`），看了 React Context 上字段的 `typeof`。没有调发送函数、没有调读写接口、没有点会话、没有往编辑框打字。

- 私信页是 Garfish 子应用 `douyin_creator_data`，chunk 在 `Garfish.activeApps[*].global.webpackChunkdouyin_creator_data`。用的是新版 PC IM SDK（`createPcIM`，Context 上 `isNewIMSDK = true`），SDK 核心类和旧版是同一个模块。
- 聊天区的 React Context（从 `li.semi-list-item` 的 fiber 往上约 36 层）上有：`bytedIM`（IM SDK 实例，被页面用 Proxy 包了一层）、`sendMessageWithAuth`、`reportAction`、`conversationList`、`strangerConversationList`、`conversation` 等。`createMessage` 字段是 `undefined`。
- 编辑框按回车或点「发送」时，页面这样调：
  1. `checkIMPermisstion(is_confer_login)`：只有代运营登录才去查代运营权限，本人登录直接通过。
  2. `bytedIM.createMessage({ type: 7, content: JSON.stringify({ text, aweType: 774 }), conversation })`：只在本地建消息（`flightStatus = Created`）。`type` 7 是 `MessageType.TEXT`。
  3. `reportAction({ conversationId, messageClientId, content, actionParams: {}, msgType })`：不等它返回。
  4. `sendMessageWithAuth({ message, isRetry: false })`：先 `IdentitySecurityToken.getIdentitySecurityToken({ scene: "im_send_msg" })`，把 `identity_security_token` 等加到发送头（`updateSendMessageHeaders`），再 `bytedIM.sendMessage({ message })`。取 token 超时时不发，返回 `undefined`，并提示「系统繁忙」。
  5. 成功的判断：`success === true`，并且 `body.status` 缺失或为 0。SDK 在 `status = 0` 时把 `server_message_id` 写进 `message.serverId`。`status` 的含义：1 不在会话里，2 会话校验没过，3 消息校验没过，4 消息校验没过但自己可见。
- SDK 的 `sendMessage` 内部用会话的 `ticket` 拼 protobuf 请求（`SendMessage`），走 `imapi.douyin.com`。这些都在 SDK 里，**Node 里不拼 protobuf、不拼签名**。
- 拉消息：`bytedIM.getMessagesByConversation({ conversation, cursor, direction, limit })` → `{ messages, hasMore, cursor }`。`direction` 的取值：1 是 `OLDER`，2 是 `NEWER`，3 是 `FROM_LATEST`。页面自己翻历史时用 `OLDER` 加游标。我们发前重读、发后回读都用 `FROM_LATEST` 拉最新 20 条。

### 视频号（主动读请求共 1 次）

- 外层页面挂钩抓不到业务请求。wujie 沙箱 iframe 和页面同源，iframe 里的 `fetch` 被包装过，`XMLHttpRequest` 是原生的。
- 业务请求的地址是 `/micro/interaction/cgi-bin/mmfinderassistant-bin/<path>?_aid&_rid&_pageUrl`。请求封装（`helperRequest`）会：
  - 加请求头 `X-WECHAT-UIN`；
  - 往请求体里并入 `timestamp`、`_log_finder_uin`、`_log_finder_id`、`rawKeyBuff`、`pluginSessionId`、`scene`、`reqScene`，值来自 localStorage。
- 一楼：调页面服务 `getCommentList({ lastBuff: '', exportId: <作品 objectId>, commentSelection: false, forMcn: false })`，实际发出 `POST .../comment/comment_list`。
  - 返回：`errCode=0`、`errMsg="request successful"`，用时 461 ms。
  - `data` 里有 `comment[]`、`lastBuff`、`commentCount`、`downContinueFlag`；一楼带 `levelTwoComment[]`、`lastBuff`、`downContinueFlag`，二楼带 `replyCommentId`。
- 楼中楼续页：页面自己的 `fetchReply` 调 `getCommentList({ lastBuff: <这条一楼的 lastBuff>, exportId, rootCommentId, … })`。

### 小红书（主动读请求共 3 次）：没通过，停用

- 页面全局有签名函数 `window._webmsxyw`，`fetch`、`XMLHttpRequest` 也都被包装过。但我们自己发的 XHR **不会被自动签名**：请求头里没有 `x-s`。
- 页面自己的请求都带 `x-s`、`x-t`、`x-s-common`、`x-b3-traceid`、`x-xray-traceid`。
- `GET /api/im/web/messages/history?chat_user_id=<id>&num=20&cursor=`：带上 `_webmsxyw` 算出的 `X-s`、`X-t`，返回 `code=0`，有 2 条消息。
- `GET /api/sns/web/v2/comment/page?note_id=<id>&cursor=&top_comment_id=&image_formats=jpg,webp,avif&xsec_token=<页面内>`：
  - 不带签名：HTTP 406，`code=-1`；
  - 带 `X-s`、`X-t`（没有 `x-s-common`）：HTTP 200，**`code=300011`，`msg="Account abnormal. Switch account and retry."`**。
- 之后马上停了所有主动请求。被动复查（只打开通知页，看页面自己发的请求）时，`user/me`、`you/mentions` 都是 `code=0`，说明账号本身没被限制，300011 只针对我们自己签名的那次请求。
- 结论：小红书风控最敏感，自己补签名很容易被判异常，这一期**不做页面内接口**，读写都维持原样。以后要做，只能像抖音、视频号那样调页面自己的接口封装函数（让页面补 `x-s-common`），并且要单独评估。

## 5. 写接口从哪里来

只读了页面自己的代码：缓存里的 JS bundle，以及沙箱里的 webpack 模块源码。**没有为了抓写请求点过发送，也没有调过任何写接口。**

- 抖音（`main.e05a91d0.js`，creator_interactive）。评论管理页点「回复」时，新版评论（`useNewComment` 为真，和读接口用的 `comment/read` 是同一套）这样调：
  - 调用：`awemeV1CommentMultiPublish({ aweme_id: 作品 item_id_plain, text, reply_to_comment_ids: 目标 cid, channel_id: 618 })`
  - 地址：`POST /aweme/janus/creator/comment/aweme/v1/web/comment/multi_publish/`
  - 成功的判断：`status_code=0`，并且 `comments` 里每条的 `code` 都是 0，第一条有 `comment.cid`。
  - 这个路径在页面安全 SDK 的 `consumerPathList` 里，会加 `bd-ticket-guard` 一类的头，所以**必须通过页面服务调用**，不能自己拼 fetch。
  - 旧版评论走 `POST /aweme/v1/creator/comment/reply/`（`comment_Id`、`item_id`、`text`），没有用。
- 视频号（`404.*.js` / `512.*.js`）。回复框的 `handleOk` 这样调：
  - 调用：`store.createComment({ replyCommentId: 目标, content, clientId: uuid, rootCommentId: 一楼, comment: 目标评论对象 })`，store 再给 service 加上 `exportId`；
  - 地址：`POST .../comment/create_comment`；
  - 成功的判断：`errCode=0` 并且有 `data.comment`。`data.baseResp.errcode=-4300` 表示要验证手机。
- 私信：
  - 抖音：调私信页 Context 上的 `sendMessageWithAuth`，流程见第 4 节「抖音私信」。代码在 `src/ops/engage/writers/api-dm.mjs`，能力位 `writeDmViaApi`。
  - 视频号的发送服务是 `/private-msg/send-private-msg`，但入参没摸清，继续用 DOM；
  - 小红书见上一节，继续用 DOM。

## 6. 护栏

`write.mjs` 这一层全部不变：幂等 key、actions 表、`needs_readback` 不重试、每平台每小时 15 条、连续 2 轮失败自动关写能力位。

接口写法（`src/ops/engage/writers/api-reply.mjs`）自己做下面这些：

- 先核对页面上登录的账号，规则同 DOM 写法。
- **发前重读**用读接口拉整楼：
  - 一楼翻到底也没有这条，返回 `comment-gone`；
  - 翻到上限还没找到，返回 `target-not-found`；
  - 楼中楼没读全（抖音读到的条数少于 `reply_comment_total`，视频号 `downContinueFlag` 还是 1），返回 `thread-incomplete`；
  - 楼里已经有我对目标的直接回复，返回 `already-replied`。抖音按 uid 和 `reply_to_reply_id` 判断，视频号按昵称和 `replyCommentId` 判断。
- 发送接口只调一次。
- 返回不是第 5 节写的成功形状（包括调用抛错），**一律不当成功也不当失败**：不设 `sendError`，框架记 `needs_readback`。发后回读到了也一样。
- 发后回读：恰好 1 条新的、我发的、正文一样，并且就是发送接口返回的那个 id，才算回读到，记 `sent`。

抖音私信的接口写法（`src/ops/engage/writers/api-dm.mjs`）和上面一样，只是发前重读、发后回读换成拉会话消息：

- 只有证实是本人登录才发：私信服务所在那条 React 祖先链外层最近的 `userInfo`，`is_confer_login` 严格是 `false`，并且 `uid` 就是要用的账号（不借别的组件链上的身份）。代运营登录或读不到，返回 `cannot-send`；uid 不符返回 `uid-mismatch`。发送前一刻在页面里再核对一次。
- 给了会话 id 就只认这个会话，找不到返回 `target-not-found`，不按对方 uid 换成别的会话。群聊（`isGroupChat` 是 true 或 `type === 2` 任一成立，两个字段矛盾也按群聊）返回 `cannot-send`。正文按原文（不去尾部换行）超过编辑框上限 500 字，返回 `text-too-long`。
- 发前用 `FROM_LATEST` 拉最新 20 条。拉完时会话的最后一条要有服务端 id 和序号、出现在页里、并且是页里序号最大的，否则返回 `precheck-error`，不发。最后一句是我说的，返回 `last-is-me`；看不出是谁说的，返回 `precheck-error`。这条的序号当边界。
- 发送前一刻在页面里复核：会话的最后一句还是发前核对的那条、并且是对方说的，否则不建消息、不发（`cannot-send`）。
- 发送照页面的顺序调一次（建消息、上报、`sendMessageWithAuth`），绝不重试。抛错、返回 `undefined`、`success` 不是 true、`body.status` 不是 0，都交给框架记 `needs_readback`。
- 发后回读再拉一次最新 20 条，只数会话序号大于边界的、我发的、正文一样的消息，并且要是发送返回的那个服务端 id。两头都要证实：这一页覆盖到边界（中间新消息没超过一页），并且拉完时会话的最后一条在页里、是序号最大的。页里有消息缺序号、边界后有看不出是谁发的消息、或边界后我发的文字消息（或类型不明的）正文读不出来，也不算回读到。正文按原文严格相等比，不做 DOM 写法的归一化。
- 页面明确还没调 `sendMessageWithAuth` 就停下的（私信服务、会话在发送前一刻没了，建消息出错，登录核对没过），返回 `failed` / `cannot-send`，不锁目标。页面调用本身失败、不知道跑到哪一步的，照旧记 `needs_readback`。
- 成功只认 `success === true`，并且 `body.status` 缺失（undefined）或是整数 0。显式的 `null`、`false`、空串等一律不算成功。
- 错误只记 SDK 的数字错误类型或几个固定的内置错误名，异常的 `message`、`name` 原文不进 `actions`。
- 诊断写在 `readBack.detail`，格式见 S7 第 7 节「抖音私信接口写法首次真发」。只有接口名、返回码、条数、耗时，不带 cookie、token、正文。DOM 写法的 `dmDiagnose` 不变。

## 7. 首次真发验收（每个平台第一次都要负责人当次同意）

和 S7 第 7 节一样，下面只写接口写法要多做的。以抖音为例，视频号把账号 id 换成 `Channels:<uid>`：

1. 先只开读：`set-cap Douyin:106707338905 readViaApi true`。跑一周，对比以前 DOM 采集的评论条数和 `threadsPartial`，看守护进程 stderr 里有没有「页面内接口没用上」、接口出错或验证码。
2. 负责人同意本次真发，并指定目标，最好是负责人自己用小号留的评论。
3. 打开 `reply` 和 `writeViaApi`。负责人在 Ego 里看着那个 space 的页面。
4. 回评官调一次 `reply_comment`。应该返回 `status: "sent"`、`readBack.found: true`、`readBack.count: 1`、`readBack.nativeId` 不为空。
5. 在平台上确认回复只有一条，挂在正确的评论下面。抖音再确认页面没有弹安全验证，视频号确认没有要求验证手机（`-4300`）。
6. 用同一个 key 再调一次，应该返回 `duplicate`。
7. 返回 `needs_readback` 时：先去平台上看，关掉 `writeViaApi`，查明原因前不开下一个平台。

抖音私信（`writeDmViaApi`）的首次真发步骤和回撤命令写在 S7 第 7 节「抖音私信接口写法首次真发」。

## 8. 没验证的

- **所有真实写入都没验证。** 抖音 `multi_publish`、视频号 `create_comment` 的请求和响应只从代码里读到，没有在线上调用过。
- 抖音私信：`sendMessageWithAuth` 和 `getMessagesByConversation` 都只从代码里读到，一次都没调过，包括读。`FROM_LATEST` 拉最新一页这件事也没在线上跑过。发前自检要求拉完时会话的最后一条（要有服务端 id）出现在拉到的页里，能拦下大部分方向、游标不对的情况，但不能保证全部拦下，首次真发时要人工在平台上核对。
- 抖音私信：页面在发送前会记录用户操作（`recordAction`，点击、按键），发送时上报（`reportAction`）。接口写法没有点击和按键，风控会不会因此判异常，要靠首次真发和之后的观察。接口写法不调页面的代运营权限检查（`checkIMPermisstion`），改成只在证实本人登录（`is_confer_login === false`，2026-11-24 只读核对这个账号是 `false`）时才发，代运营登录一律不发。
- 抖音读评论只核对了 1 个作品的一楼（1 页）和 1 栋楼的楼中楼（1 页）。一楼翻页（`cursor`）、楼中楼翻页没有在真实页面上跑过。
- 视频号只核对了 1 个作品的一楼第 1 页。一楼续页、楼中楼续页（`rootCommentId`）没在真实页面上跑过。
- 主动调接口的频率能不能被风控识别，要靠第 7 节第 1 步的只读试跑来观察。
