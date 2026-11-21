// 接收端配置：只从环境变量（integrations/openbot/.env）读。密钥不写日志、不打印。
import fs from 'node:fs';
import path from 'node:path';

export const HERE = import.meta.dirname;
export const ENV_FILE = path.join(HERE, '.env');
export const DEFAULT_CLI = '/Applications/OpenBot.app/Contents/Resources/cli/openbot-cli.mjs';
export const DEFAULT_TYPES = ['comment.created', 'dm.received'];

/** 读 .env 到 process.env（已有的变量不覆盖）。文件不存在时什么也不做。 */
export function loadEnvFile(file = ENV_FILE) {
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

/**
 * 校验并整理配置。缺东西直接抛错，错误文字说明要怎么补；不吞错。
 * MAITIAN_SECRET 可以为空：首次登记时由 subscribe 拿到并写回 .env。
 */
export function readConfig(env = process.env) {
  const cli = env.OPENBOT_CLI || DEFAULT_CLI;
  if (!fs.existsSync(cli)) {
    throw new Error(`找不到 OpenBot CLI：${cli}。OpenBot 升级后路径可能变了，请在 integrations/openbot/.env 里把 OPENBOT_CLI 改成新路径`);
  }
  const port = Number(env.RECEIVER_PORT || 8790);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`RECEIVER_PORT 不是有效端口：${env.RECEIVER_PORT}`);
  const subscriberId = env.MAITIAN_SUBSCRIBER_ID || 'openbot-engage';
  const windowMin = Number(env.RECEIVER_BATCH_WINDOW_MINUTES ?? 30);
  if (!Number.isFinite(windowMin) || windowMin < 0) throw new Error(`RECEIVER_BATCH_WINDOW_MINUTES 要是不小于 0 的分钟数：${env.RECEIVER_BATCH_WINDOW_MINUTES}`);
  const maxChars = Number(env.RECEIVER_MESSAGE_MAX_CHARS ?? 12_000);
  if (!Number.isInteger(maxChars) || maxChars < 2000) throw new Error(`RECEIVER_MESSAGE_MAX_CHARS 要是不小于 2000 的整数：${env.RECEIVER_MESSAGE_MAX_CHARS}`);
  const types = (env.MAITIAN_EVENT_TYPES || DEFAULT_TYPES.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  return {
    cli,
    agent: env.OPENBOT_AGENT || '数据小管家',
    port,
    subscriberId,
    types,
    secret: env.MAITIAN_SECRET || null,
    mcpServer: env.MAITIAN_MCP_SERVER || path.resolve(HERE, '../../src/mcp/server.mjs'),
    opsDb: env.MAITIAN_OPS_DB || null,
    contextDb: env.MAITIAN_OPS_DB || path.resolve(HERE, '../../data/ops.db'),   // 推送消息的上下文从这里只读取
    batchWindowMs: Math.round(windowMin * 60_000),
    maxChars,
    stateDb: env.RECEIVER_STATE_DB || path.join(HERE, 'data', 'receiver.db'),
    url: `http://127.0.0.1:${port}/maitian/hook`,
  };
}

/** 把一个键写进 .env（有就替换，没有就追加），文件权限 0600。 */
export function writeEnvValue(file, key, value) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else {
    if (lines.length && lines.at(-1) === '') lines.pop();
    lines.push(`${key}=${value}`, '');
  }
  if (fs.existsSync(file)) fs.chmodSync(file, 0o600);   // 先收紧再写，写入密钥时不会有可读窗口
  fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** .env 存在就把权限收紧到 0600（启动时调，覆盖重复登记不写文件的路径）。 */
export function enforceEnvPerms(file) {
  if (fs.existsSync(file) && (fs.statSync(file).mode & 0o777) !== 0o600) fs.chmodSync(file, 0o600);
}
