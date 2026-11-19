# S6a 四平台评论、私信只读采集：接口核实和核对结论

KIN-323 dev-2。代码在 `src/ops/engage/adapters/`，入口 `collect({ account, kind })`（`index.mjs`），输出形状见 KIN-323 模块约定「适配器输出」。

2026-11-19 在 Profile 5 的长期 space 里真跑（只读）。账号取自真实账号表（只读打开）。Instagram 没跑。

## 结论

| 平台 | 评论（这一轮） | 楼中楼 | 私信 | 后台页面核对（20 条） |
|---|---|---|---|---|
| B站 | 13 个作品、264 条，其中楼中楼 174 条（回复楼中楼的 88 条） | 完整：13 个作品都是 `complete:true`、`threadsPartial:false` | 40 个会话，37 条消息；18 个最后一句是自己 | 找到 19 条；回复对象 5/5；日期 18 条一致 |
| 抖音 | 近 30 天有评论的 8 个作品、134 条，其中楼中楼 71 条（回复楼中楼的 36 条） | 6 个作品完整；1 个楼中楼拿不全（`threadsPartial:true`），1 个一楼还有下一页（`complete:false`） | 20 个会话，每个带最后一条消息；12 个最后一句是自己 | 找到 20 条；回复对象 10/10；同楼 14/14 |
| 视频号 | 近 30 天有评论的 10 个作品、93 条，其中楼中楼 39 条（回复楼中楼的 11 条） | 完整：10 个作品都是 `complete:true`，每个作品的条数和作品列表上的评论数一致 | 27 个会话，98 条消息；19 个最后一句是自己 | 找到 20 条；同楼 14/14；回复对象 2/3；日期 19 条一致 |
| 小红书 | 近 7 天有新评论的 5 篇笔记整楼拿全，加上通知里另外 4 篇较早笔记的评论，共 21 条，其中楼中楼 8 条 | 打开的 5 篇完整；只在通知里出现的 4 篇 `threadsPartial:true` | 56 个会话，打开最近 10 个读了 87 条消息；其余 46 个 `last` 为 null（见下文） | 第一次核对 20 条找到 14 条，第二次只加载出 4 篇笔记，核对到的 7 条全部找到。连跑几轮后被限流，见「小红书」一节 |

三个要核实的接口：

- **抖音楼中楼：核实了。** 页面展开「查看 N 条回复」时发 `GET /web/api/third_party/aweme/api/comment/read/aweme/v1/web/comment/list/reply/`（参数 `comment_id`、`item_id`、`cursor`、`count`，带 `msToken`、`a_bogus` 签名）。每条子回复的 `reply_id` 是所在楼的一楼 `cid`，`reply_to_reply_id` 是直接回复的那条（`"0"` 表示直接回复一楼），`reply_to_userid` 和 `reply_to_username` 是被回复的人，作者 uid 在 `user.uid`。PLAN 里猜的 `reply_to_reply_id` 对。
- **小红书楼中楼：核实了。** 笔记页自己发 `GET edith.xiaohongshu.com/api/sns/web/v2/comment/page`（一楼列表，每条带前几条 `sub_comments`，另有 `sub_comment_count`、`sub_comment_has_more`、`sub_comment_cursor`，列表本身用 `cursor`、`has_more` 翻页）。点「展开 N 条回复」时发 `GET /api/sns/web/v2/comment/sub/page`（参数 `note_id`、`root_comment_id`、`num`、`cursor`，也带 `xsec_token`）。子评论的 `target_comment.id` 是直接回复的那条：回复一楼时就是一楼的 id。这次的真实数据里所有子评论都直接回复一楼，没有出现回复子评论的；测试里补了一个构造的例子。
- **B站私信：核实了。** 只读接口都在 `api.vc.bilibili.com`，从 `member.bilibili.com` 页面里 `fetch(..., { credentials: 'include' })` 可以直接调，不要签名：
  - 会话：`GET /session_svr/v1/session_svr/get_sessions?session_type=1&group_fold=1&unfollow_fold=0&sort_rule=2&build=0&mobi_app=web`，`data.session_list[]`，`has_more` 和 `end_ts=<最后一个会话的 session_ts>` 翻页。`last_msg.sender_uid` 判最后一句是谁说的。
  - 消息：`GET /svr_sync/v1/svr_sync/fetch_session_msgs?talker_id=<对方 uid>&session_type=1&size=20&build=0&mobi_app=web`，`data.messages[]`，`sender_uid` 判发送方。**`msg_key` 超过 2^53**，要先改成字符串再解析（`page-lib.mjs` 的 `bigJson`）。
  - 昵称：会话列表里普通用户没有昵称（只有系统号带 `account_info.name`），用 `GET /account/v1/user/cards?uids=<逗号分隔>` 补，一次最多 20 个。
  - `content` 是 JSON 字符串：`msg_type=1` 时文字在 `.content`；`msg_type=10` 是通知卡片。`system_msg_type>0` 或带 `account_info` 的是系统号，记 `peer.kind='official'`、`canSend=false`。

## 各平台怎么读

每个平台文件分两半：`runInSpace(task, params)` 在 Ego 的 space 里跑，只读，抄回原始 JSON；`parse(kind, raw, ctx)` 在 Node 里转换成约定形状。上限都在各文件的 `LIMITS` 里，可以用 `collect` 的 `options` 改。

### B站（`bili.mjs`）

- 在 `member.bilibili.com/platform/comment/article` 页面里调接口。`x/web-interface/nav` 的 `isLogin` 为假或 `code=-101` 时，返回 `login-lost`。
- 评论：`x/v2/reply/up/fulllist?order=1&filter=-1&type=1&pn=&ps=20`（UP 主评论管理，全部作品的评论，含楼中楼，从新到旧）一直翻到底，最多 25 页。翻到底时，扫到的作品记 `complete:true`。近 `since`（默认 7 天）内有动静的楼，再用 `x/v2/reply/reply?oid=&type=1&root=&ps=20&pn=` 拉整楼，最多 60 楼。作品标题和发布时间从 `x/web-interface/view?bvid=` 取。
- 字段：`rpid`、`root`、`parent` 原样使用（`root=0` 表示一楼）。`member.mid` 是作者 uid，等于账号 uid 时 `isMe=true`。`up_action.like` 对应 `likedByMe`（UP 主点过赞）。`reply_control.location` 去掉「IP属地：」前缀后作为 `ipLabel`。`rcount` 对应 `replyCount`。楼里的置顶从 `upper.top` 取。
- 作品 id 用 `bvid`，和 S3 一致。
- 已知：这次 264 条里有 5 条的 parent、6 条的 root 不在结果里，原因是那条一楼或被回复的评论已经删了，平台不再返回。store 要能接受 parent 不存在的情况。

### 抖音（`douyin.mjs`）

- 评论管理页 `creator.douyin.com/creator-micro/interactive/comment`，挂钩页面请求（`page-lib.mjs` 的 `installHook`，URL 只保留 `comment_id`、`item_id`、`note_id`、`root_comment_id`、`chat_user_id`、`cursor`，签名参数一律丢掉）。
- 作品：页面自己发的 `/aweme/v1/creator/item/list`，取 `item_id_plain`（等于 `aweme_id`，和 S3 一致）、`title`、`create_time`（文字，形如「发布于2026年11月17日 11:56」，按东八区换算）、`comment_count`。只扫近 30 天、评论数大于 0 的作品，最多 8 个。
- 切作品：点「选择作品」按钮，在「作品列表」抽屉里按「发布于」文字找到每一项，沿 React fiber 找 props 里 `item_id_plain` 等于目标的那项，然后点它。抽屉的类名有两个版本（`publish-time-*`、`video-sub-info-*` 和 `time-*` 都见过），所以按文字找，不按类名找。
- 一楼：抄回 `comment/list/select` 的响应，按 `aweme_id` 过滤，切到默认选中的作品时页面可能不会重新请求。`stick_position>0` 记为置顶，`is_author_digged` 对应 `likedByMe`，`reply_comment_total` 对应 `replyCount`。
- 楼中楼：反复点「查看 N 条回复」「展开更多」（按文字找最里层的元素，最多 25 次）。点了 3 秒内没发出子回复请求的按钮会打上标记，之后不再点。还剩没展开的按钮，或者某楼的 `reply_comment_total` 大于拿到的条数时，`threadsPartial:true`。最后一页 `comment/list/select` 的 `has_more=1` 时，`complete:false`。
- 私信：`creator-micro/data/following/chat`，`li.semi-list-item` 的 fiber 往上 2 层是 IM SDK 的 Conversation 对象。`lastMessage.isFromMe` 判 `last.by`。`lastMessage.createdAt` 是 Date 对象，在页面里先转成毫秒。`type` 7 是文字（`content` JSON 的 `.text`），8 是分享视频。`messages` 只放每个会话的最后一条。
- 掉线：`/web/api/media/user/info/` 的 `status_code=8`，或者页面跳到登录页。
- 已知：页面很慢，实测「选择作品」按钮 10 到 50 秒才出来，`goto` 有一次 30 秒没 commit。所以导航超时设 60 秒并重试一次，按钮最多等 90 秒。一次采集 8 个作品要 4 到 7 分钟。

### 视频号（`channels.mjs`）

- 页面在 wujie 微前端的 shadowRoot 里，请求从沙箱 iframe 发出，外层挂钩抓不到，所以读 Vue 2 组件数据。`auth/auth_data` 的 `errCode` 不为 0，或页面跳到登录页时，返回 `login-lost`。`finderUser.nickname` 用来判 `isMe`。
- 作品：左侧作品列表组件的 `commentFeeds`（`objectNonce`、`objectId`、`createTime`、`commentCount`、`desc`）。列表是滚动懒加载，脚本滚到最后一个，直到覆盖近 30 天。只扫近 30 天、评论数大于 0 的作品，新的优先，最多 10 个。作品 id 用 `objectNonce`，和 S3、小V猫一致。
- 评论：点开作品（会把评论标成已读，任务允许），点「展开更多回复」（最多 15 次），再读每个 `.comment-item` 的 `__vue__.$props.dataSource`。**二楼会同时出现在一楼的 `levelTwoComment[]` 里，也会单独渲染成一个 `.comment-item`**，所以按 `commentId` 去重。层级按 `replyCommentId` 链往上走，走到没有 `replyCommentId` 的那条就是一楼；`replyCommentId` 指向同楼某条就挂它，没有就挂一楼。`downContinueFlag=1` 或还有「展开更多回复」按钮时，`threadsPartial:true`。
- 平台不给评论者 uid（`username` 有时有值、有时是空串，且不是稳定 id），所以 `author.uid` 一律是 null，`isMe` 按昵称等于 `finderUser.nickname` 判断。
- 私信：`/platform/private_msg`，`.session-wrap` 往上找到带 `$data.sessionList` 的 Vue 实例。`messageList` 从新到旧排，只带最近几条，取 `ts` 最大的那条判 `last.by`：`fromUsername` 等于 `sessionInfo.username` 就是对方说的。
- 没点 `.like-action`，也没点回复图标。

### 小红书（`xhs.mjs`）

- 评论：先在主站 `/notification`「评论和@」页面挂钩 `api/sns/web/v1/you/mentions`。没抓到时才点「评论和@」标签，因为它已经选中时再点，列表会出不来（S0）。通知最多翻 4 页，翻到早于 `since`（默认 7 天）为止。这个通知列表只用来找出近期有新评论的笔记，最多 8 篇。
- 逐篇打开 `explore/<笔记 id>?xsec_token=…&xsec_source=pc_notice`（`xsec_token` 只在页面里拼地址用，原始数据用 `dropSecrets` 去掉了所有 `xsec*`、`token` 键）。抄回 `comment/page`，一楼有下一页时把评论区滚到底，最多 5 次。再点「展开 N 条回复」（最多 20 次，点了没出请求就标记、不再点），抄回 `comment/sub/page`。子评论按 URL 里的 `root_comment_id` 归到对应的楼，`target_comment.id` 还原 parent。笔记标题和发布时间从 `window.__INITIAL_STATE__.note.noteDetailMap` 取。
- 笔记打不开、或者某楼的 `sub_comment_count` 大于拿到的条数时，`threadsPartial:true`，这篇笔记的评论只能来自通知：`comment/item` 记为一楼；`comment/comment` 挂在 `target_comment` 下面，被回复的那条当一楼（它的真实一楼不知道）。
- 私信：`/chat` 挂钩 `api/im/web/v3/chats`（`chat_user_id` 是对方，`user_id` 是自己，另有 `last_msg_time` 毫秒、`info.nickname`、`info.is_official`），未读数取自 `chat/get_unread` 的 `user_chat_unread_counts`。会话列表判不出最后一句是谁说的，所以逐个打开 `/chat/<chat_user_id>`（地址里只有对方 uid），抄回 `api/im/web/messages/history?chat_user_id=`（`out_message_list[]`，`sender_id` 判发送方；`content` 是 JSON 字符串，`content_type` 1 是文字，3 是笔记分享）。**按行号点会话不稳**，因为点开一个会话后列表会重新渲染。只打开 `last_msg_time` 比 `since` 新的会话；没有 `since` 时最多打开最近 10 个。
- 没打开的会话：有 `since` 时，这些会话在 `since` 之后没有新消息，不报；没有 `since` 时照样报，但 `last` 是 null（判不出是谁说的），这样不会把 store 里已有的值改错。官方号 `peer.kind='official'`、`canSend=false`。群聊（`chats/group`，这个账号有 5 个）不收。
- **限流**：当天对这个账号连着跑了五六轮（每轮打开 5 到 9 篇笔记）以后，笔记页 30 秒内不再发 `comment/page`，刷新一次也没用；再往后连通知页的 `you/mentions` 也抓不到。没看到验证码或登录页。适配器的应对是：笔记打不开就标 `threadsPartial`，照样用通知里的数据；每篇之间停 5 秒。正常每 1 到 2 小时跑一次、只开近期有新评论的笔记，应该碰不到，但 dev-3 排时间表时要注意别排得太密。

## 失败和跳过

- runner 返回 `busy`、`user-controlled`、`profile-needed`（锁文件损坏时 runner 也报 `busy`）：返回 `{ ok:false, skipped }`，不重试，不抢控制权。
- runner 返回 `profile-rejected`（不是 Profile 5）：返回 `{ ok:false, reason:'profile-rejected' }`，按失败处理，不算跳过。
- 页面脚本判断掉线：返回 `{ ok:false, reason:'login-lost' }`。页面脚本自己报的失败（如小红书 60 秒内没抓到接口）：返回 `{ ok:false, reason:'no-data' }`。解析出错或输出形状不对：返回 `{ ok:false, reason:'parse' }`。
- `error` 文本经过 `safeError`：去掉 URL 查询串、cookie，以及各种 token、签名的值，最多 300 字。
- 适配器不调用 `finishSpace`，space 留着给下次复用。

## 后台页面核对

做法：从这一轮的结果里每个平台抽 20 条（楼中楼优先，最多 14 条），在同一个 space 里打开后台页面（用和适配器相同的切换和展开步骤），在 DOM 里找同时包含昵称和正文前 12 个字的最小元素。然后检查三项：

- 回复对象：如果这条回复的是楼中楼，元素里要有被回复人的昵称。
- 同楼：楼中楼要和它的一楼在同一个不超过 4000 字的容器里。
- 时间：元素里显示的日期和 `createdAt` 换成东八区后的日期一致，或者显示的是相对时间。

比对脚本只在 scratchpad 里，没有提交，结论如下（昵称记 `user_<sha256 前 8 位>`，正文不留）。

| 平台 | 抽样 | 其中楼中楼 | 找到 | 回复对象 | 同楼 | 时间 |
|---|---|---|---|---|---|---|
| B站 | 20 | 11 | 19 | 5/5 | 6/11（评论管理页是平铺列表，不按楼排，这一项不适用） | 日期一致 18，没找到日期 1，没找到的 1 条不计 |
| 抖音 | 20 | 14 | 20 | 10/10 | 14/14 | 相对时间 16，日期一致 4 |
| 视频号 | 20 | 14 | 20 | 2/3（1 条的页面上不显示被回复人） | 14/14 | 日期一致 19，没找到日期 1 |
| 小红书 | 20 | 8 | 第一次 14 | 0/0（真实数据里没有回复楼中楼的） | 3/3 | 相对时间 8，日期一致 6 |

- B站没找到的 1 条是一楼，评论管理页翻了 4 页也没出现，应该在更后面的页。
- 小红书第一次核对时，9 篇笔记里有 1 篇没加载出来，没找到的 6 条里包括这篇笔记上的样本（当时没有把「没核对」和「没找到」分开记）。第二次核对时已经被限流，只加载出 4 篇，核对到的 7 条全部找到。第三次连通知页都抓不到，没有核对成。

## 脱敏样例

`test/fixtures/engage/<platform>-{comments,dms}.json` 是页面脚本真实输出（也就是 `parse` 的输入）的脱敏版：

- 结构和 id 保留。
- 昵称和 uid 换成 `user_<sha256 前 8 位>`；会话 id、消息 id 里嵌着的 uid 也一并替换，包括账号自己的 uid。
- 正文、标题、简介换成 `<已脱敏>`。消息 `content` 里的 JSON 保留结构和数字，字符串一律换成 `<已脱敏>`。
- 所有链接（头像、封面、评论配图）换成 `<去掉>`，没有任何 token。
- 各样例只截了一部分，B站只留 fulllist 的前两页，所以样例里 B站作品是 `complete:false`。

解析测试：`test/adapters-parse.test.mjs`（各平台）、`test/adapters-shape.test.mjs`（形状校验、「回复 @某人」还原 parent 的规则）、`test/adapters-collect.test.mjs`（注入假 runner 测跳过和失败）。
