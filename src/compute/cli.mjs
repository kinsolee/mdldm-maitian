#!/usr/bin/env node
// 谷歌算力命令行：
//   node src/hub.mjs compute refresh [--scope fast|all]   采一次（fast：Colab CLI + Gemini 探活；all：再加网页只读采集）
//   node src/hub.mjs compute status                       打印最新快照（JSON）
// 不常驻、不建定时器；定时由 OpenBot routine 管。
import { parseArgs } from 'node:util';
import { createComputeService } from './service.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { scope: { type: 'string', default: 'fast' } } });
const sub = positionals[0];
if (sub !== 'refresh' && sub !== 'status') {
  console.log('用法：node src/hub.mjs compute refresh [--scope fast|all] | compute status');
  process.exit(sub === 'help' ? 0 : 2);
}
if (sub === 'refresh' && !['fast', 'all'].includes(values.scope)) { console.error('--scope 只能是 fast 或 all'); process.exit(2); }

const svc = createComputeService({ debounceMs: Infinity });
try {
  if (sub === 'refresh') {
    const r = svc.refresh(values.scope);
    if (!r.started) { console.error(`上一次刷新还在跑（${r.refreshing?.scope || '?'}，开始于 ${r.refreshing?.startedAt || '?'}），这次没起`); process.exitCode = 5; }
    await r.promise;
  }
  const s = svc.status();
  const brief = Object.fromEntries(Object.entries(s.providers).map(([p, v]) => [p, { status: v.last?.status || 'never', error: v.last?.error || undefined, at: v.last?.fetchedAt }]));
  if (process.exitCode !== 5) console.log(JSON.stringify(sub === 'status' ? s : { light: s.light, providers: brief }, null, 1));
} finally { svc.close(); }
