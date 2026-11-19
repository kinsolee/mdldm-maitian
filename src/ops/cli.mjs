#!/usr/bin/env node
// hub ops：运营侧账号表、登录检测、写入口令。不读 config.json 也能跑 accounts / tokens。
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { openOpsDb } from './db.mjs';
import { importAccounts, listAccounts, setUid, setCapability, CAPABILITIES } from './accounts.mjs';
import { checkLogins, scanLogin } from './login.mjs';
import { initTokens } from './tokens.mjs';
import { opsDbPath, envPath, seedPath } from './paths.mjs';

export const USAGE = `用法：hub ops <子命令>
  accounts import [清单文件]                  导入账号清单（默认 src/ops/accounts.seed.json，幂等）
  accounts list [--json]                       列出账号、登录状态、能力位
  accounts set-uid <platformCode> <uid>        给 uid 还是 pending 的账号登记真实 uid（space 名跟着改）
  accounts set-cap <账号id> <能力位> <true|false>   开关能力位（账号 id 写 <platformCode>:<uid>）
  login --check [--platform <code>] [--json]   只读检测登录、核对 uid
  login <platformCode|账号id>                  打开登录页交给负责人扫码，交还后自动检测一次
  tokens init                                  生成写入口令到仓库根目录 .env（已有的不动，不打印口令值）
  engage sync --once [--platform <code>] [--kind comments|dms] [--force] [--json]   跑一轮评论私信抓取（退出码 0 跑完、1 参数错、5 已有一轮在跑）
  engage status [--json]                       评论私信：每个平台每个 kind 最近一次抓取、未处理事件数

login 的退出码：0 全部检测完（含 out、unknown）；2 有账号 UID 不符（硬停）；1 有检测失败（runner 失败、结果结构不对、已登录但没读到 uid）；
  否则有跳过的账号：3 profile-needed（Ego 里没有要用的 profile）> 4 user-controlled（负责人在手动操作）> 5 busy（被别的任务占着）。
  多个账号时取最严重的：2 > 1 > 3 > 4 > 5 > 0。
文件：ops.db 默认 data/ops.db（MAITIAN_OPS_DB 可改）；口令 .env 默认仓库根目录（MAITIAN_ENV_FILE 可改）。`;

const pad = (s, n) => String(s ?? '').padEnd(n);

function printAccounts(list) {
  for (const a of list) {
    const on = CAPABILITIES.filter((c) => a.capabilities[c]);
    console.log(`${pad(a.id, 42)} ${pad(a.platformName, 9)} ${pad(a.loginState, 13)} ${pad(a.loginCheckedAt ?? '-', 24)} 能力位：${on.length ? on.join(',') : '全关'}`);
  }
}

function printRows(rows) {
  for (const r of rows) console.log(`${pad(r.id, 42)} ${pad(r.result === 'skipped' ? `跳过(${r.skipped})` : r.result, 18)} ${r.message ?? ''}`);
}

export async function main(argv = process.argv.slice(2)) {
  const [group, sub, ...rest] = argv;
  if (group === 'engage') return (await import('../daemon/sync.mjs')).main(argv.slice(1));
  const { values, positionals } = parseArgs({ args: group === 'login' ? argv.slice(1) : rest, allowPositionals: true, options: {
    json: { type: 'boolean', default: false }, check: { type: 'boolean', default: false }, platform: { type: 'string' }, help: { type: 'boolean', short: 'h', default: false },
  } });
  if (!group || values.help || group === 'help') { console.log(USAGE); return 0; }

  if (group === 'tokens' && sub === 'init') { console.log(initTokens(envPath())); return 0; }

  const db = openOpsDb(opsDbPath());
  if (group === 'accounts') {
    if (sub === 'import') { const r = importAccounts(db, positionals[0] ?? seedPath()); console.log(`新增 ${r.inserted}，pending 改成真实 uid ${r.upgraded}，已有跳过 ${r.skipped}`); return 0; }
    if (sub === 'list') { const list = listAccounts(db); if (values.json) console.log(JSON.stringify(list, null, 1)); else printAccounts(list); return 0; }
    if (sub === 'set-uid' && positionals.length === 2) { console.log(`已登记：${setUid(db, positionals[0], positionals[1])}`); return 0; }
    if (sub === 'set-cap' && positionals.length === 3 && /^(true|false)$/.test(positionals[2])) {
      setCapability(db, positionals[0], positionals[1], positionals[2] === 'true');
      console.log(`${positionals[0]} ${positionals[1]} = ${positionals[2]}`);
      return 0;
    }
  }
  if (group === 'login') {
    const r = values.check
      ? await checkLogins(db, values.platform ? { platform: values.platform } : {})
      : positionals[0] ? await scanLogin(db, positionals[0]) : null;
    if (r) {
      if (values.json) console.log(JSON.stringify({ exitCode: r.exitCode, rows: r.rows }, null, 1));
      else printRows(r.rows);
      return r.exitCode;
    }
  }
  console.error(USAGE);
  return 1;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === import.meta.filename) {
  main().then((code) => process.exit(code), (e) => { console.error(`出错：${e.message}`); process.exit(1); });
}
