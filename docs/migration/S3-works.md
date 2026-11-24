# S3 作品和粉丝采集（`hub ops collect` / `hub ops export`）

`hub ops collect` 在抖音、小红书、B站、视频号四个平台的长期 space 里只读采集近 N 天作品、指标和粉丝，写进 `ops.db`。`hub ops export` 把每个平台最近一次成功的采集导出成和小V猫同形的 `posts-YYYYMMDD.json`、`accounts-YYYYMMDD.json`，给下游 `vcat-backfill/backfill.py` 和 `kinso-dashboard/refresh.py` 读。字段读法和下游读哪些字段见 `spikes/results/06-works.md`。

## 命令

```sh
hub ops collect [--days N] [platform ...] [--export] [--json]   # 默认 30 天、四个平台；--export 采完接着导出 posts 和 accounts（每日定时见下面「定时」）
hub ops export posts    [--out 目录] [--date YYYYMMDD] [--max-age-hours N] [--json]
hub ops export accounts [--out 目录] [--date YYYYMMDD] [--max-age-hours N] [--json]
python3 scripts/ops-export-check.py --posts <文件> --accounts <文件>       # 按下游读法检查导出文件（只读，两个参数至少给一个）
```

platform 只收 `Douyin`、`XiaoHongShu`、`Bili`、`Channels`。其他平台直接报错，退出码 1；Instagram 账号被锁，暂时跳过，不做任何自动操作。`--json` 时 stdout 只有一个 JSON 对象，日志写 stderr。

## 采集

- 每个账号起一个 runner 任务（space `kinso/<platformCode>/<uid>`，Profile 5，超时 5 分钟）。任务脚本 import `src/ops/collect-space.mjs`，它再 import 平台模块（`src/ops/works/<平台>`，地址由 `src/ops/works/index.mjs` 的 `moduleUrlOf` 给），`goto START_URL`（`waitUntil: "commit"`）、等 `SETTLE_MS`，调 `fetchRaw` 返回原始结果。宿主侧用 `loadPlatform(code).map(raw)` 映射，再校验、写库。
- 四个平台并行；同一 space 的互斥由 runner 的 space 锁保证。
- 跳过、不起 runner：uid 还是 `pending`（先跑 `hub ops login --check`）；能力位 `readWorks` 没开（`hub ops accounts set-cap <id> readWorks true`）。
- runner 返回 `busy`、`user-controlled`、`profile-needed` 时跳过。space 在负责人手里时不抢，不 takeOver。其他 runner 失败记 failed。
- map 结果：没登录记 `out`，不写作品、粉丝，提示 `hub ops login <platformCode>`；页面上的 uid 和登记的不一致记 `uid-mismatch`，不写库；`complete` 不是 `true`（平台模块判断这次没读全，例如某个接口没拿到数据、翻页没翻完；缺这个字段也算）记 failed、reason `incomplete`，message 带 `incomplete` 的说明，不写作品、粉丝、快照，导出自动回退到上一次完整的采集；没读到 uid、记录不合格（规则同导出校验）、写库出错都记 failed，不写库。一个账号的写入在一个事务里，出错整段回滚。
- stdout 和库里不放 cookie、token、finderUsername、签名：raw 只在内存里给 map 用，不存、不打印；`--json` 每行带 map 的 `stats`，平台模块保证里面没有凭据。

| 退出码 | 含义 |
|---|---|
| 0 | 全部 ok |
| 2 | 有账号 UID 不符（硬停，这个账号没写库） |
| 3 | 部分成功：有 ok，也有跳过、未登录或失败的 |
| 1 | 一个 ok 都没有，或平台不在范围、参数不对 |

`collect --export` 的退出码取采集、posts 导出、accounts 导出三者最严重的：2 > 1 > 3 > 0。

## 表（都在 `ops.db`，由 `src/ops/works-db.mjs` 的 `ensureWorksTables` 建）

| 表 | 一行是 | 说明 |
|---|---|---|
| `collect_runs` | 一次采集里的一个账号 | runId、platformCode、uid、startedAt、finishedAt、result（ok / out / skipped / failed / uid-mismatch）、reason、message、postCount、days（这次的 `--days`）、stats（map 给的诊断 JSON，不含凭据；没跑到 map 时为空）。早期建的表由 `ensureWorksTables` 补 days、stats 两列，旧行为空 |
| `works` | 一条作品（主键 platformCode, uid, postId） | 最近一次的记录 JSON、postTime、firstSeenAt、lastSeenAt、lastRunId |
| `work_snapshots` | 一次采集里的一条作品（主键 runId, platformCode, uid, postId） | collectedAt、记录 JSON，每次采集都留 |
| `account_snapshots` | 一次采集里的一个账号 | collectedAt、fans、loginStatus、记录 JSON |
| `fans_daily` | 一个账号一天（主键 platformCode, uid, date） | fansTotal、fansNet、collectedAt。平台这次给 null 的不覆盖已有的非 null 值 |

## 导出

- 默认目录 `data/ops-shadow/`（`MAITIAN_OPS_SHADOW_DIR` 可改，`--out` 优先），文件名日期默认东八区当天（`--date` 可改）。先写临时文件再 rename。
- 每个平台取最近一次 ok 的采集（同一时刻按写入先后）：posts 是那次的 `work_snapshots`，原样写出，不改值。**posts 只认 `days >= 30` 的采集**：跑过 `--days 7` 后仍导出最近一次 30 天的，因为 refresh.py 读最新一份 posts，短窗口会让看板丢掉更早的期数；`days` 为空的旧记录也不认。没有合格的采集时 `excluded` 写明「最近一次 ok 采集只采了 N 天」。accounts 不看天数（粉丝分日固定 30 天），用那次的账号快照，加上 `fans_daily` 近 30 天的分日，形状是 `{uid, loginStatus, fans, updateTime, daily: [{date, fansTotal, fansNet}]}`，`daily` 按日期升序。
- 顶层是数组。accounts 只有这四个平台：微博不进；公众号粉丝归 S4。
- 最近一次 ok 早于 `--max-age-hours`（默认 26）或从没成功过的平台不导出，结果里的 `excluded` 写明原因。
- 写之前逐条校验，规则同 `scripts/ops-export-check.py`：posts 的 `platform`、`postId`、`postTime`（能被 `datetime.fromisoformat` 解析）、`statusText`、六个指标（数字、-1 或 null）、`fullView`/`viewTime`、`(platform, postId)` 不重复；accounts 的 `loginStatus == "登录有效"`、`fans`（数字或 null）、`updateTime`、`daily`。
- 粉丝总数接口失败不影响采集：平台模块照样给 `complete: true`，`fans` 写 null，作品照常写库，导出原样写 null（refresh.py 的 `ingest_accounts` 遇到空的 `fans` 跳过，保留上一次的总数）。字符串、NaN 仍不合格。

| 退出码 | 含义 |
|---|---|
| 0 | 四个平台都导出了 |
| 3 | 有平台没导出（过期或从没成功过），文件照写 |
| 1 | 一个平台都没有，或有记录不合格：**不写文件**（refresh.py 取最新一份，写残缺或空文件会把看板清空） |

## 定时

每天的采集和回填由 Cindy 的一个脚本自动化驱动（2026-11-24 负责人确认，取代迁移记录里「定时抓取由常驻守护进程负责」的写法；守护进程不改）。它不启动 agent，不消耗模型额度。命令是 `integrations/cindy/daily.mjs`，自己不采也不写数据，只调用 `hub ops collect --export` 和库外的收口脚本 `~/.hermes/scripts/content-data-daily.sh`。

```sh
node integrations/cindy/daily.mjs check  --closer ~/.hermes/scripts/content-data-daily.sh   # 前置检查：exit 0 有事可做，exit 2 跳过本轮，exit 1 出错；检查跑完才在最后输出 CINDY_PRECHECK_OK
node integrations/cindy/daily.mjs run    --closer ~/.hermes/scripts/content-data-daily.sh   # 把今天能做的做完
node integrations/cindy/daily.mjs status --closer ~/.hermes/scripts/content-data-daily.sh [--json]   # 只读：今天每一步的情况
node integrations/cindy/daily.mjs plan   --closer ~/.hermes/scripts/content-data-daily.sh [--json]   # 只读预演：下一次 run 会做什么
```

不传 `--closer`（也没有 `MAITIAN_DAILY_CLOSER`）时只做采集，不读影子导出和知识库，摘要写「回填未配置」。

### 每一步「今天做没做」

都从数据本身判断，手动跑过、中途断了重跑、同一天触发多次都不会多写一行。

| 步骤 | 判据 |
|---|---|
| 采集（按平台） | `collect_runs` 里今天（东八区）有这个平台采满 30 天的 `ok`（导出 posts 不收短窗口） |
| 影子导出 | 当天的 `posts-`、`accounts-` 两份都在、比最后一次成功采集新、结构对（作品数组每条有 `postId` 和平台，账号数组非空） |
| 笔记回填（按作品） | 今天影子导出里的每条作品，同平台、同 `post_id` 的数据笔记有一篇 `fetched_at` 是今天 |
| 视频号分日 | 有视频号数据笔记的 `daily_fetched_at` 是今天 |
| 公众号阅读 | 有公众号数据笔记的 `fetched_at` 是今天 |
| 飞书和看板 | 看板的 `data.js` 比今天的影子导出新，且状态文件里没有「同步没做完」 |

状态文件（默认 `integrations/cindy/data/daily-state.json`，按天重置）只记：同步进行中（调收口脚本之前就写下，拿到成功证据才清掉）、已经提醒过的事、在等登录的时间。同一时刻只有一轮在跑：锁文件 `daily-state.json.lock` 记着主人进程，进程还活着就不抢，进程死了才回收。

### 一轮 run 做什么

1. 采集今天还没成功的平台：`collect --export --json <平台...>`。`busy`、`user-controlled` 本轮不重试，交给下一轮；评论私信同步正占着某个平台（`sync_jobs` 里 30 分钟内的 `running`）时，前置检查先不放行这个平台。
2. 影子导出缺失、比采集旧（例如手动跑过不带 `--export` 的采集）或结构不对时重新导出一次；重新导出后还不对，提醒一次，不调收口脚本。
3. 有可用的当天导出才调收口脚本，一轮一次：`--posts` 只放今天还没回填的作品，按作品挑（backfill.py 每跑一次就给每条作品的笔记追加一行，不幂等；中途断了下一轮只传剩下的）；别的平台有同 `post_id` 的笔记时这条不传（backfill.py 只按 `post_id` 找笔记，会写错），提醒一次；`--dashboard-posts` 给今天完整的 `posts-YYYYMMDD.json`，看板始终是四个平台；`--no-llm` 让看板「数据分析」走规则版，整条流程不调模型；视频号分日、公众号阅读做完了就加 `--skip-channels`、`--skip-mp`；飞书每次都同步（按键去重，重复跑不多行）；`--source 麦田`。收口脚本的输出解析不了、看板被跳过或 `data.js` 没变新，都算同步失败；跑完再读一次知识库，确认传进去的作品都有今天的抓取时间。
4. 采集、导出各限 8 分钟，收口脚本限 10 分钟；超时先 TERM 再 KILL 整个进程组（包括孙进程）。

### 等负责人和通知

- 平台未登录、UID 不符、Ego 里缺 profile、UID 没登记：当天第一次发现的那一轮以失败结束，摘要写明是哪个平台、要做什么。之后前置检查跳过这个平台，直到守护进程的评论私信同步在那次失败之后又成功过（说明已经重新扫码），下一轮自动补上。视频号分日和视频号采集用同一个登录。
- 公众号后台未登录：提醒一次，之后最多每小时探一次（真跑一轮收口脚本的公众号那步）。还没登录时这一轮不再算失败，但 Cindy 每一次真正运行都会按开关通知。
- 账号表里没有这个平台的账号：提醒一次怎么导入，之后跳过。
- 收口脚本某一步失败（包括公众号抓到了但 `mp_backfill.py` 写笔记失败）、采集 `failed`、采集命令没给某个平台的结果：这一轮失败，摘要写原因，下一轮只重试没做完的步骤。
- 子进程的 PATH 里找不到 `python3`、`lark-cli`、`ego-browser`，或收口脚本不存在：失败一次，写明缺什么。
- 当天的事全部做完的那一轮成功一次；做完之后前置检查一直跳过。

### Cindy 里的自动化

项目配置文件 `integrations/cindy/project/.cindy/automations/schedules.json` 导入不了脚本模式：Cindy 的导入（`scheduleConfigToCreateInput`）不读 `executionMode` 和 `scriptConfig`，写进去会被当成 agent 任务导入、按 prompt 启动 agent。所以这条自动化不写进项目配置，用 Cindy 的接口或界面手动建，参数如下：

| 字段 | 值 |
|---|---|
| 名称 | 麦田每日数据流程 |
| 运行方式 | 脚本（`executionMode: "script"`），能力白名单为空 |
| 工作目录 | `/Users/kinso/code/github/kinsolee/mdldm-maitian/integrations/cindy/project`（项目工作区） |
| 时间 | `*/15 10-22 * * *`，时区 `Asia/Taipei`（10:00 到 22:45 每 15 分钟），重复 |
| 命令 | `/opt/homebrew/bin/node /Users/kinso/code/github/kinsolee/mdldm-maitian/integrations/cindy/daily.mjs run --closer /Users/kinso/.hermes/scripts/content-data-daily.sh` |
| 整轮超时 | 1200000 毫秒（20 分钟） |
| 前置检查 | `/opt/homebrew/bin/node /Users/kinso/code/github/kinsolee/mdldm-maitian/integrations/cindy/daily.mjs check --closer /Users/kinso/.hermes/scripts/content-data-daily.sh`，超时 15000 毫秒 |
| 通知 | 桌面开，飞书关 |
| worktree、持续会话 | 关（脚本模式不支持） |

Cindy 起脚本时去掉密钥类环境变量，PATH 只有系统目录；命令给子进程的 PATH 是 `~/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`（和麦田常驻服务一样）。stdout 只有一行 `cindy-script/1` 完成帧（出错也有）；失败时摘要同时写在 stderr 末尾、exit 1，「需要你」那几行放在最后，因为 Cindy 的失败通知只取 stderr 最后 1000 字。

### 手动补和回滚

- 手动补一次：在 Cindy 里点「立即运行」（走前置检查，效果和自动触发一样），或者在终端跑上面的 `run`。连「在等负责人」的平台也想重试一次时加 `--retry-waiting`；重试后还不行照样提醒。
- 排查：`status` 看每一步，`plan` 看下一次会做什么，都不写任何东西。
- 回滚：在 Cindy 里暂停这条自动化。命令本身不改库、不改守护进程，停掉就回到手动。

## 和下游的关系

- 下游现在读小V猫的导出（`vcat-backfill/posts-*.json`、`kinso-dashboard/raw/accounts-*.json`）。麦田的导出先写到 `data/ops-shadow/` 影子目录，不碰下游目录。什么时候把回填和看板切到这里，由主对话决定。
- 切换前用 `scripts/ops-export-check.py` 检查影子文件，再和同一天小V猫的导出逐字段对比。检查脚本不 import、不运行 backfill.py、refresh.py（它们会写知识库和看板）。
- refresh.py 只收它登记的 uid：B站 `478358005`、抖音 `106707338905`、小红书 `5944af205e87e701889da649`、视频号 `finderUser.uniqId`（`sph` 开头）。

## 文件位置

| 文件 | 默认 | 环境变量 |
|---|---|---|
| 库 | `data/ops.db` | `MAITIAN_OPS_DB` |
| 导出 | `data/ops-shadow/` | `MAITIAN_OPS_SHADOW_DIR`（或 `--out`） |
| space 锁 | `data/ops/locks/` | `MAITIAN_OPS_DIR` |
| 每日流程状态文件 | `integrations/cindy/data/daily-state.json` | `MAITIAN_DAILY_STATE`（或 `--state`） |
| 每日流程读的知识库、看板 | `~/Documents/OPC-vault`、`~/code/local-tests/kinso-dashboard/data.js` | `MAITIAN_DAILY_VAULT`、`MAITIAN_DAILY_DASHBOARD`（或 `--vault`、`--dashboard-data`） |
