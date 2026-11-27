#!/usr/bin/env node
// Cindy preRunHook 与影子批处理辅助命令：
//   check [--no-collect]   只读同步小V猫已采数据进 shadow.db（refresh=false），有待处理 exit 0，无待处理 exit 2（不花 token）
//   notify                 把尚未推送的 pending 卡片合批发送一张飞书交互卡片（复用麦田 webhook）
//   status                 打印收件箱、卡片、问答库、影子判定统计
import fs from 'node:fs';
import { ENV_FILE, enforceEnvPerms, loadEnvFile, readConfig, resolveUpstreamToken } from './config.mjs';
import { openShadowStore } from './store.mjs';
import { createUpstreamClient } from './upstream.mjs';
import { collectFromUpstream } from './collector.mjs';
import { notifyPendingCards } from './notify.mjs';

export const PRECHECK_OK = 'VCAT_PRECHECK_OK';

export async function runHook(argv, { config, upstream = null, store = null, fetchImpl = fetch, webhook = null, now = Date.now } = {}) {
  const [cmd, ...rest] = argv;
  const noCollect = rest.includes('--no-collect');

  if (cmd === 'check') {
    const ownedStore = !store;
    const activeStore = store || openShadowStore(config.shadowDb);
    try {
      let summary = null;
      if (!noCollect) {
        const activeUpstream = upstream || createUpstreamClient({
          url: config.upstreamUrl,
          token: resolveUpstreamToken(config),
        });
        summary = await collectFromUpstream({
          upstream: activeUpstream,
          store: activeStore,
          lookbackDays: config.lookbackDays,
          selfAuthors: config.selfAuthors,
          now,
        });
      }
      const pending = activeStore.pendingCount();
      const detail = summary
        ? `新入库 ${summary.accepted} 条（重复 ${summary.duplicate}，跳过本人 ${summary.skippedSelf}），待处理 ${pending} 条`
        : `待处理 ${pending} 条`;
      return { code: pending > 0 ? 0 : 2, out: `${detail}\n${PRECHECK_OK}` };
    } finally {
      if (ownedStore) activeStore.close();
    }
  }

  if (cmd === 'notify') {
    const ownedStore = !store;
    const activeStore = store || openShadowStore(config.shadowDb);
    try {
      const result = await notifyPendingCards(activeStore, {
        cardsUrl: config.cardsUrl,
        webhook,
        maitianConfig: config.maitianConfig,
        fetchImpl,
        now,
      });
      return { code: 0, out: JSON.stringify(result) };
    } finally {
      if (ownedStore) activeStore.close();
    }
  }

  if (cmd === 'status') {
    const ownedStore = !store;
    const activeStore = store || openShadowStore(config.shadowDb);
    try {
      return {
        code: 0,
        out: JSON.stringify({
          lastCollectAt: activeStore.getMeta('lastCollectAt'),
          ...activeStore.stats(),
        }, null, 2),
      };
    } finally {
      if (ownedStore) activeStore.close();
    }
  }

  return { code: 1, out: '用法：hook.mjs check [--no-collect] | notify | status' };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === import.meta.filename) {
  try {
    enforceEnvPerms(ENV_FILE);
    loadEnvFile(ENV_FILE);
    const config = readConfig(process.env);
    const { code, out } = await runHook(process.argv.slice(2), { config });
    (code === 1 ? process.stderr : process.stdout).write(`${out}\n`);
    process.exit(code);
  } catch (err) {
    process.stderr.write(`hook.mjs 出错：${err.message}\n`);
    process.exit(1);
  }
}
