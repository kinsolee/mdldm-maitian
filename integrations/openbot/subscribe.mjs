// 向麦田登记订阅：起麦田 MCP（stdio，read 组），调 subscribe_events。
// 首次登记拿到的密钥直接写进 .env（0600），不打印、不返回给调用方以外的地方。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeEnvValue } from './config.mjs';
import { childEnv } from './forward.mjs';
import { stableNodeExecPath } from '../../src/ops/node-bin.mjs';

/** 返回 subscribe_events 的结果（created、secret 等）。MCP 报错时抛错。 */
export async function subscribeViaMcp({ mcpServer, opsDb, subscriberId, url, types, platforms }) {
  const env = childEnv();
  if (opsDb) env.MAITIAN_OPS_DB = opsDb;
  const transport = new StdioClientTransport({ command: stableNodeExecPath(), args: [mcpServer, '--scope', 'read'], env, stderr: 'ignore' });
  const client = new Client({ name: 'openbot-receiver', version: '1' });
  await client.connect(transport);
  try {
    const args = { subscriberId, url, types, ...(platforms ? { platforms } : {}) };
    const r = await client.callTool({ name: 'subscribe_events', arguments: args });
    if (r.isError) throw new Error(`subscribe_events 失败：${r.content?.[0]?.text}`);
    return JSON.parse(r.content[0].text);
  } finally {
    await client.close();
  }
}

/**
 * 启动时登记（重复登记只更新地址和类型）。返回可用的密钥。
 * 首次登记：把新密钥写进 envFile。重复登记但本地没有密钥：抛错，说明要换 subscriberId。
 */
export async function ensureSubscribed(cfg, { envFile, subscribe = subscribeViaMcp } = {}) {
  const r = await subscribe({ mcpServer: cfg.mcpServer, opsDb: cfg.opsDb, subscriberId: cfg.subscriberId, url: cfg.url, types: cfg.types });
  if (r.created) {
    writeEnvValue(envFile, 'MAITIAN_SECRET', r.secret);
    return { created: true, secret: r.secret };
  }
  if (!cfg.secret) {
    throw new Error(`麦田里已有订阅方 ${cfg.subscriberId}，但 .env 里没有 MAITIAN_SECRET（密钥只在首次登记时给一次）。`
      + '请在 .env 里换一个新的 MAITIAN_SUBSCRIBER_ID 重新启动，再对旧的调 unsubscribe_events');
  }
  return { created: false, secret: cfg.secret };
}
