#!/usr/bin/env node
// 命令行入口：拿 space 锁后在一个 Ego Lite space 里跑一段任务脚本（async 函数体，返回值即结果）。
//   node src/ego-runner/cli.mjs --space kinso/test/demo [--profile "Profile 5"] [--plugin-dir <dir>]
//        [--params '{"k":1}'] [--timeout-ms 600000] [--lock wait|skip] [--lock-timeout-ms 60000]
//        [--take-back] [--finish] [script.js]   # 不给脚本文件就读 stdin
// 结果以一行 JSON 打到 stdout，失败时带 reason；退出码见 index.mjs 的 EXIT_CODES：
//   0 成功；1 任务失败；2 space 名或参数不对；3 Profile 6 或 Profile 5 不存在；4 space 在用户手里；5 space 锁被占或上一个任务还在跑。
// --take-back 只给负责人手动「扫完了，收回」用：space 是 agentDelegatedToUser 时收回；定时任务不要带。
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { runInSpace, DEFAULT_PROFILE, DEFAULT_PLUGIN_DIR } from './index.mjs';

// 参数不对：打一行带 reason 的 JSON，退出码 2（不带着 NaN 之类的值去跑）
const badArgs = (error) => {
  console.log(JSON.stringify({ ok: false, reason: 'bad-args', error, exitCode: 2 }));
  process.exit(2);
};

let parsed;
try {
  parsed = parseArgs({
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
} catch (e) { badArgs(e.message); }
const { values, positionals } = parsed;

if (values.lock !== 'wait' && values.lock !== 'skip') badArgs(`--lock 只能是 wait 或 skip：${values.lock}`);
/** 毫秒参数：不给返回 undefined；给了就必须是 >= min 的整数，否则参数错误。 */
function msArg(name, min) {
  const v = values[name];
  if (v == null) return undefined;
  const n = /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < min) badArgs(`--${name} 要是 >= ${min} 的整数毫秒：${v}`);
  return n;
}
const timeoutMs = msArg('timeout-ms', 1);
const lockTimeoutMs = msArg('lock-timeout-ms', 0);
let params;
try { params = JSON.parse(values.params); } catch (e) { badArgs(`--params 不是合法 JSON：${e.message}`); }
if (!params || typeof params !== 'object' || Array.isArray(params)) badArgs('--params 要是 JSON 对象');

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
  params,
  script,
  lock: values.lock,
  takeBack: values['take-back'],
  finish: values.finish,
  ...(timeoutMs != null ? { timeoutMs } : {}),
  ...(lockTimeoutMs != null ? { lockTimeoutMs } : {}),
});
const { stdout = '', stderr = '', ...summary } = r;
const finishFailed = r.finish && !r.finish.ok;
console.log(JSON.stringify(r.ok ? summary : { ...summary, output: (stdout + stderr).slice(-2000) }));
process.exit(r.ok ? (finishFailed ? 1 : 0) : r.exitCode);
