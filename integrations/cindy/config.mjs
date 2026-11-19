// Cindy 侧配置：只从环境变量（integrations/cindy/.env）读。密钥不写日志、不打印。
// .env 的读写和权限收紧直接用 OpenBot 那份（integrations/openbot/config.mjs），不改它。
import os from 'node:os';
import path from 'node:path';
import { loadEnvFile as loadEnv } from '../openbot/config.mjs';

export { writeEnvValue, enforceEnvPerms } from '../openbot/config.mjs';

export const HERE = import.meta.dirname;
export const ENV_FILE = path.join(HERE, '.env');
export const DEFAULT_TYPES = ['comment.created', 'dm.received'];
export const DEFAULT_LEDGER = path.join(os.homedir(), 'Documents', 'OPC-vault', '10.个人IP', '数据', '麦田事件对照-Cindy.jsonl');
/** OpenBot 的正式文件：Cindy 一个字也不能写进去。 */
export const OPENBOT_FILES = ['评论私信回复记录.md', '评论私信待确认.md', '评论私信回复话术.md'];

/** OpenBot 的 loadEnvFile 默认读 openbot/.env，这里默认改成 Cindy 自己的。 */
export const loadEnvFile = (file = ENV_FILE) => loadEnv(file);

/** 收件箱和对照文件的位置。inbox.mjs（给 Cindy 用）只需要这两样，不碰密钥。对照文件必须是 .jsonl，且不能是 OpenBot 的文件。 */
export function readPaths(env = process.env) {
  const ledger = path.resolve(env.CINDY_LEDGER_FILE || DEFAULT_LEDGER);
  if (OPENBOT_FILES.includes(path.basename(ledger)) || path.extname(ledger) !== '.jsonl') {
    throw new Error(`CINDY_LEDGER_FILE 要是单独的 .jsonl 对照文件，不能指向 OpenBot 的记录、待确认或话术文件：${ledger}`);
  }
  return {
    stateDb: env.CINDY_INBOX_DB || path.join(HERE, 'data', 'inbox.db'),
    ledger,
  };
}

/** 接收端配置。缺东西直接抛错，错误文字说明要怎么补。MAITIAN_SECRET 可以为空：首次登记时写回 .env。 */
export function readConfig(env = process.env) {
  const port = Number(env.RECEIVER_PORT || 8791);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`RECEIVER_PORT 不是有效端口：${env.RECEIVER_PORT}`);
  const backfillMinutes = Number(env.BACKFILL_MINUTES || 15);
  if (!(backfillMinutes > 0) || !Number.isFinite(backfillMinutes)) throw new Error(`BACKFILL_MINUTES 要是正数：${env.BACKFILL_MINUTES}`);
  const subscriberId = env.MAITIAN_SUBSCRIBER_ID || 'cindy-engage';
  // 用 OpenBot 的订阅方 id 登记，会把 OpenBot 的推送地址改到这里，正式处理方就断了
  if (/^openbot/i.test(subscriberId)) throw new Error(`MAITIAN_SUBSCRIBER_ID 不能用 OpenBot 的订阅方 id：${subscriberId}`);
  return {
    ...readPaths(env),
    port,
    subscriberId,
    types: (env.MAITIAN_EVENT_TYPES || DEFAULT_TYPES.join(',')).split(',').map((s) => s.trim()).filter(Boolean),
    secret: env.MAITIAN_SECRET || null,
    mcpServer: env.MAITIAN_MCP_SERVER || path.resolve(HERE, '../../src/mcp/server.mjs'),
    opsDb: env.MAITIAN_OPS_DB || null,
    backfillMs: backfillMinutes * 60_000,
    url: `http://127.0.0.1:${port}/maitian/hook`,
  };
}
