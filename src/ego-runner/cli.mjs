#!/usr/bin/env node
// 命令行入口：拿 space 锁后在一个 Ego Lite space 里跑一段任务脚本（async 函数体，返回值即结果）。
//   node src/ego-runner/cli.mjs --space kinso/test/demo [--profile "Profile 5"] [--plugin-dir <dir>]
//        [--params '{"k":1}'] [--timeout-ms 600000] [--lock wait|skip] [--lock-timeout-ms 60000]
//        [--take-back] [--finish] [script.js]   # 不给脚本文件就读 stdin
// 结果以一行 JSON 打到 stdout，失败时带 reason；退出码见 index.mjs 的 EXIT_CODES：
//   0 成功；1 任务失败；2 space 名不对；3 Profile 6 或 Profile 5 不存在；4 space 在用户手里；5 space 锁被占或上一个任务还在跑。
// --take-back 只给负责人手动「扫完了，收回」用：space 是 agentDelegatedToUser 时收回；定时任务不要带。
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { runInSpace, DEFAULT_PROFILE, DEFAULT_PLUGIN_DIR } from './index.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    space: { type: 'string' },
    profile: { type: 'string', default: DEFAULT_PROFILE },
    'plugin-dir': { type: 'string', default: process.env.MAITIAN_PLUGIN_DIR || DEFAULT_PLUGIN_DIR },
    params: { type: 'string', default: '{}' },
    'timeout-ms': { type: 'string' },
    lock: { type: 'string', default: 'wait' },
    'lock-timeout-ms': { type: 'string' },
    'take-back': { type: 'boolean', default: false },
    finish: { type: 'boolean', default: false },
  },
});

if (values.lock !== 'wait' && values.lock !== 'skip') {
  console.log(JSON.stringify({ ok: false, reason: 'bad-args', error: `--lock 只能是 wait 或 skip：${values.lock}` }));
  process.exit(1);
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const script = positionals[0] ? await readFile(positionals[0], 'utf8') : await readStdin();
const r = await runInSpace({
  space: values.space,
  profileId: values.profile,
  pluginDir: values['plugin-dir'],
  params: JSON.parse(values.params),
  script,
  lock: values.lock,
  takeBack: values['take-back'],
  finish: values.finish,
  ...(values['timeout-ms'] ? { timeoutMs: Number(values['timeout-ms']) } : {}),
  ...(values['lock-timeout-ms'] ? { lockTimeoutMs: Number(values['lock-timeout-ms']) } : {}),
});
const { stdout = '', stderr = '', ...summary } = r;
const finishFailed = r.finish && !r.finish.ok;
console.log(JSON.stringify(r.ok ? summary : { ...summary, output: (stdout + stderr).slice(-2000) }));
process.exit(r.ok ? (finishFailed ? 1 : 0) : r.exitCode);
