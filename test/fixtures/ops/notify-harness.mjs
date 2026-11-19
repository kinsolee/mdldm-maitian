// 子进程里跑 main：runInSpace 换成假的（判为掉线），notify 用默认的（真的懒加载 feishu.mjs），stdout/stderr 是真的。
// 用法：MAITIAN_OPS_DIR=... MAITIAN_CONFIG=... node notify-harness.mjs
import { main } from '../../../src/ops/cli.mjs';

const deps = { now: () => Date.parse('2026-11-19T00:00:00Z'), runInSpace: async () => ({ ok: true, result: { state: 'out' } }) };
await main(['accounts', 'seed'], { ...deps, out: () => {} });
process.exitCode = await main(['login', '--check', 'douyin'], deps);
