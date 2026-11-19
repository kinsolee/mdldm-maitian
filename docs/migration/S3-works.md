# S3 作品和粉丝采集（`hub ops collect` / `hub ops export`）

`hub ops collect` 在抖音、小红书、B站、视频号四个平台的长期 space 里只读采集近 N 天作品、指标和粉丝，写进 `ops.db`。`hub ops export` 把每个平台最近一次成功的采集导出成和小V猫同形的 `posts-YYYYMMDD.json`、`accounts-YYYYMMDD.json`，给下游 `vcat-backfill/backfill.py` 和 `kinso-dashboard/refresh.py` 读。字段读法和下游读哪些字段见 `spikes/results/06-works.md`。

## 命令

```sh
hub ops collect [--days N] [platform ...] [--export] [--json]   # 默认 30 天、四个平台；--export 采完接着导出 posts 和 accounts（每天定时用）
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
