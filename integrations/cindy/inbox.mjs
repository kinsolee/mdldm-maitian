#!/usr/bin/env node
// 给 Cindy 用的收件箱命令。不碰麦田签名密钥，不调 ack_event，不写正式记录和待确认文件。
//   check            前置检查（preRunHook）：有没处理的事件 exit 0，没有 exit 2；只看不取。检查完整成功才输出 CINDY_PRECHECK_OK。
//   pending [n]      列最早的 n 条（默认 20）没处理的事件，JSON：id、type、platform、subjectId、conversationId、createdAt。
//   record           从 stdin 读 JSON 数组 [{ eventId, category, suggestedReply }]，写进对照文件，写成功才标已处理。
import fs from 'node:fs';
import { ENV_FILE, loadEnvFile, readPaths } from './config.mjs';
import { openInbox, exists, PENDING_LIMIT } from './store.mjs';
import { recordResults } from './ledger.mjs';

export const PRECHECK_OK = 'CINDY_PRECHECK_OK';

/** 返回 { code, out }，不直接退出，方便测试。 */
export function run(argv, { paths, stdin = '', now = Date.now } = {}) {
  const [cmd, arg] = argv;
  if (cmd === 'check') {
    // 收件箱文件还没有（接收端没起过）：没有事件可处理，跳过本轮
    if (!exists(paths.stateDb)) return { code: 2, out: `收件箱还没建：${paths.stateDb}\n${PRECHECK_OK}` };
    const inbox = openInbox(paths.stateDb, { readOnly: true });
    try {
      const n = inbox.pendingCount();
      return { code: n > 0 ? 0 : 2, out: `待处理 ${n} 条\n${PRECHECK_OK}` };
    } finally { inbox.close(); }
  }
  if (cmd === 'pending') {
    const limit = arg == null ? PENDING_LIMIT : Number(arg);
    if (!Number.isInteger(limit) || limit <= 0 || limit > 100) return { code: 1, out: 'pending 的条数要是 1 到 100 的整数' };
    if (!exists(paths.stateDb)) return { code: 0, out: '[]' };
    const inbox = openInbox(paths.stateDb, { readOnly: true });
    try { return { code: 0, out: JSON.stringify(inbox.pending(limit), null, 1) }; } finally { inbox.close(); }
  }
  if (cmd === 'record') {
    let results;
    try { results = JSON.parse(stdin); } catch { results = null; }
    if (!Array.isArray(results)) return { code: 1, out: 'stdin 不是 JSON 数组' };
    const inbox = openInbox(paths.stateDb);
    try {
      const r = recordResults({ inbox, file: paths.ledger, results, now });
      return { code: r.rejected.length ? 1 : 0, out: JSON.stringify(r) };
    } finally { inbox.close(); }
  }
  return { code: 1, out: '用法：inbox.mjs check | pending [n] | record（stdin 传 JSON 数组）' };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === import.meta.filename) {
  try {
    loadEnvFile(ENV_FILE);
    const paths = readPaths();
    const stdin = process.argv[2] === 'record' ? fs.readFileSync(0, 'utf8') : '';
    const { code, out } = run(process.argv.slice(2), { paths, stdin });
    (code === 1 ? process.stderr : process.stdout).write(`${out}\n`);
    process.exit(code);
  } catch (e) {
    // 意外失败不能输出 CINDY_PRECHECK_OK，也不能 exit 2：exit 1 让 Cindy 阻止本轮并记失败
    process.stderr.write(`inbox.mjs 出错：${e.message}\n`);
    process.exit(1);
  }
}
