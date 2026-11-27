# S10. Cindy 经小V猫 MCP 的评论私信只读影子版

代码位于 `integrations/vcat/`，完全独立于麦田工作台（8787）、`com.maitian.daemon`、OpenBot 以及现有 Cindy「麦田事件对照」任务（8791/8792）。

## 1. 架构与数据流

```text
小V猫桌面端 MCP (127.0.0.1:3199/mcp, Bearer 令牌来自登录钥匙串)
        ▲  (仅 initialize / tools/list / 固定白名单只读工具；refresh 强制 false)
        │
   ┌────┴─────────────────────────────────────────────────────────┐
   │                                                              │
hook.mjs check (Cindy preRunHook, 每 5 分钟)          mcp-proxy.mjs (127.0.0.1:8793/mcp)
  - 只读拉取已采评论/私信、跳过本人发言                   - 启动时向小V猫 tools/list 核对白名单交集
  - 去重写入 integrations/vcat/data/shadow.db           - 写工具(含 vcat_draft_reply)永不暴露、永不转发
  - 有待处理 exit 0；无待处理 exit 2 (不花 token)         - 暴露本地工具：pending_items / kb_search /
                                                          card_submit / shadow_record / cards_notify
        │                                                         │
        └──────────────────▶ Cindy 影子伙伴 ◀──────────────────────┘
                                   │
            ┌──────────────────────┴───────────────────────┐
            ▼                                              ▼
   命中问答库 / 广告 / 跳过                             未覆盖新问题
   → shadow_record 写入 shadow_log              → card_submit 生成/合并聚合卡
   （绝不发真实回复，只记「本来会怎么回」）             → cards_notify 复用麦田飞书 webhook 合批推送
                                                           │
                                                           ▼ (点击「去处理」按钮)
                                               cards-web.mjs (127.0.0.1:8794/cards)
                                                 - 本机直连 + 同源校验（同 /api/cindy/token）
                                                 - 「用这个答案」/「编辑后保存」→ 写入 kb_entries (auto_reply=0)
                                                   + 原子导出只读镜像 ~/Documents/OPC-vault/10.个人IP/数据/小V猫问答库.md
                                                 - 「不回」→ 卡片标 skipped
```

## 2. 硬性只读边界

- **固定白名单读工具**：仅允许 `vcat_list_accounts`、`vcat_list_comments`、`vcat_get_comment_summary`、`vcat_get_unread_messages`、`vcat_list_message_sessions`、`vcat_get_session_messages`。启动时与上游 `tools/list` 取交集，白名单外的所有工具（包括 `vcat_reply_comment`、`vcat_send_message`、`vcat_set_top_comment`、`vcat_like_comment`、`vcat_create_reply_comment_task`、`vcat_draft_reply` 等）既不暴露也不转发。
- **`refresh` 强制为 `false`**：上游 schema 中将 `refresh` 锁为 `enum: [false]`，运行时在转发前再次递归把任意层级的 `refresh` 覆盖为 `false`（对 `vcat_get_session_messages` 即使未传也强制补 `refresh: false`），绝不触发平台实时刷新。
- **影子期自动回复硬锁定**：`kb_entries.auto_reply` 在 SQLite 表约束上写了 `CHECK (auto_reply = 0)`，代码与接口恒返回 `autoReply: false`。
- **数据隔离**：使用独立数据库 `integrations/vcat/data/shadow.db`，不改上游表结构；问答库只读镜像路径强制校验非符号链接、必须 `.md`、且禁止指向 OpenBot 正式文件（`评论私信回复记录.md`、`评论私信待确认.md`、`评论私信回复话术.md`）。
- **端口与本机安全**：
  - `127.0.0.1:8793/mcp`：仅回环监听、`Host` 白名单、`Authorization: Bearer` 常数时间校验、日志仅记方法与状态码（绝不写令牌、参数或正文）。
  - `127.0.0.1:8794/cards`：仅回环监听；所有接口校验回环 + 本机 `Host` + 无代理头；所有写接口额外要求 `Origin` 与 `http://<host>` 严格同源。

## 3. 配置上游令牌

在 macOS「钥匙串访问」的登录钥匙串中建立通用密码，名称为 `vcat-mcp`，账户为运行代理的 macOS 用户名，密码为上游令牌。在运行目录的 0600 `.env` 和 LaunchAgent 中设置 `VCAT_UPSTREAM_TOKEN_KEYCHAIN_SERVICE=vcat-mcp`。其他账户名可用 `VCAT_UPSTREAM_TOKEN_KEYCHAIN_ACCOUNT` 指定。首次启动可能需要在桌面批准访问。轮换时更新同一条目的密码，再重启代理以重新读取。

解析顺序为进程环境中的 `VCAT_UPSTREAM_TOKEN`、指定的钥匙串服务、旧版 1Password 引用。使用钥匙串时清除直接令牌配置。钥匙串读取失败即退出，仅未指定钥匙串服务时才走旧版引用。代理和独立采集 hook 共用此解析逻辑。

## 4. 安装与启动（部署阶段）

```sh
# 1. 准备 .env（权限 0600，不进 git）
cp integrations/vcat/.env.example integrations/vcat/.env
chmod 600 integrations/vcat/.env

# 2. 单独验证上游连通性与只读采集（需先配置登录钥匙串条目）
node integrations/vcat/hook.mjs check; echo "exit=$?"

# 3. 安装 launchd 服务（代理 8793 + 答题页 8794）
cp integrations/vcat/com.maitian.vcat-mcp.plist ~/Library/LaunchAgents/
cp integrations/vcat/com.maitian.vcat-cards.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.maitian.vcat-mcp.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.maitian.vcat-cards.plist
```

首次启动 `mcp-proxy.mjs` 会自动生成 32 字节的 `VCAT_PROXY_TOKEN` 并写入 `integrations/vcat/.env`（0600，不打印）。

## 5. Cindy 界面配置步骤

经只读核查本机 Cindy 数据目录（`~/Library/Application Support/CindyGlobal/safe-storage/owner_*_mcp_token_*.enc`），Cindy 的自定义 MCP 令牌由 Electron `safeStorage` 加密存储，不适合通过外部脚本直接改写配置文件，请在 Cindy 界面按以下三步完成：

1. **添加 MCP 服务器**：在 Cindy 设置 →「添加 MCP 服务器」：
   - 显示名称：`小V猫影子代理（只读）`
   - 传输类型：`HTTP`
   - 端点 URL：`http://127.0.0.1:8793/mcp`
   - Bearer Token：从本机 `integrations/vcat/.env` 里的 `VCAT_PROXY_TOKEN` 复制填入（仅本机查看，勿发聊天）
2. **伙伴 MCP**：在「伙伴设置 → 能力 → MCP」中选择允许列表（allowlist），只勾选本地影子代理。本机已登记的名称为 `vcat-proxy`。伙伴的项目模式可能在运行时恢复继承可用 MCP。
3. **项目定时任务**：打开运行检出的 `integrations/vcat/project`。本机目录为 `/Users/kinso/code/github/kinsolee/mdldm-maitian-vcat-run/integrations/vcat/project`。清单的提示词和 preRunHook 分别从这个工作目录定位 `../agent-prompt.md` 和 `../hook.mjs`。项目自动化不能在清单中绑定伙伴或指定 MCP 允许列表；任务按项目会话的引擎和工作目录取得可用 MCP。清单显式使用 `agentKind: "codex"`，具体模型沿用 Cindy 的 Codex 配置。每五分钟先运行本机采集检查；没有待处理项且没有待通知卡片时，hook 退出码为 2，调度器跳过本轮模型会话。导入前请核对项目会话的工具范围，伙伴允许列表不会自动应用到该任务。

## 6. 测试

```sh
node --test test/vcat-shadow.test.mjs
```

测试使用本地假上游 MCP（同时注册读工具与全部常见写工具），离线验证：写工具永不暴露且直接调用被拒、`refresh` 强制改写为 `false`、代理 Bearer/Host 安全校验、采集跳过本人发言与退出码 0/2、本机答题页回环与同源校验、以及「出卡 → 同类合并聚合卡 → 飞书合批交互卡 → 答题入库（`autoReply=false` + 只读镜像导出）→ 下次同类问题命中并记录 `wouldReply`」完整闭环。
