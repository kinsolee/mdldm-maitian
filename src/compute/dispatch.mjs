// hub.mjs 的第二个 import：`hub compute ...` 在加载 feishu/db/driver 之前转给本目录的 cli.mjs（不需要 config.json，不碰 hub.db）。
// 定时巡检由 OpenBot routine 调：node src/hub.mjs compute refresh --scope all
import { spawnSync } from 'node:child_process';
import path from 'node:path';

if (process.argv[2] === 'compute') {
  const r = spawnSync(process.execPath, [path.join(import.meta.dirname, 'cli.mjs'), ...process.argv.slice(3)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
