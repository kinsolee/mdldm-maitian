#!/usr/bin/env node
// hub ops：运营侧账号表、登录检测、写入口令。不读 config.json 也能跑 accounts / tokens。
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { openOpsDb } from './db.mjs';
import { importAccounts, listAccounts, setUid, setCapability, CAPABILITIES } from './accounts.mjs';
import { checkLogins, scanLogin } from './login.mjs';
import { collectWorks } from './collect.mjs';
import { exportPosts, exportAccounts } from './export.mjs';
import { initTokens } from './tokens.mjs';
import { opsDbPath, envPath, seedPath } from './paths.mjs';

export const USAGE = `用法：hub ops <子命令>
  accounts import [清单文件]                  导入账号清单（默认 src/ops/accounts.seed.json，幂等）
  accounts list [--json]                       列出账号、登录状态、能力位
  accounts set-uid <platformCode> <uid>        给 uid 还是 pending 的账号登记真实 uid（space 名跟着改）
  accounts set-cap <账号id> <能力位> <true|false>   开关能力位（账号 id 写 <platformCode>:<uid>）
  login --check [--platform <code>] [--json]   只读检测登录、核对 uid（--check 不接位置参数，平台用 --platform）
  login <platformCode|账号id>                  打开登录页交给负责人扫码，交还后自动检测一次（不接 --platform）
  tokens init                                  生成写入口令到仓库根目录 .env（已有的不动，不打印口令值）
  collect [--days N] [platform ...] [--export] [--json]   只读采集近 N 天（默认 30）作品和粉丝（Douyin、XiaoHongShu、Bili、Channels）；--export 接着导出
  export posts|accounts [--out 目录] [--date YYYYMMDD] [--max-age-hours N] [--json]   导出给下游的 posts-/accounts-YYYYMMDD.json

login 的退出码：0 全部检测完（含 out、unknown）；2 有账号 UID 不符（硬停）；1 有检测失败（runner 失败、结果结构不对、已登录但没读到 uid）；
  否则有跳过的账号：3 profile-needed（Ego 里没有要用的 profile）> 4 user-controlled（负责人在手动操作）> 5 busy（被别的任务占着）。
  多个账号时取最严重的：2 > 1 > 3 > 4 > 5 > 0。
collect 的退出码：0 全部 ok；2 有账号 UID 不符（硬停，没写库）；3 部分成功（有跳过、未登录或失败的）；1 一个 ok 都没有，或平台不在范围。
export 的退出码：0 四个平台都导出；3 有平台没导出（最近一次成功采集超过 --max-age-hours，默认 26，或从没成功过）；
  1 一个平台都没有、或有记录不合格（这两种都不写文件）。collect --export 取三者最严重的：2 > 1 > 3 > 0。
文件：ops.db 默认 data/ops.db（MAITIAN_OPS_DB 可改）；导出默认 data/ops-shadow/（MAITIAN_OPS_SHADOW_DIR 可改）；口令 .env 默认仓库根目录（MAITIAN_ENV_FILE 可改）。`;

const pad = (s, n) => String(s ?? '').padEnd(n);

function printAccounts(list) {
  for (const a of list) {
    const on = CAPABILITIES.filter((c) => a.capabilities[c]);
    console.log(`${pad(a.id, 42)} ${pad(a.platformName, 9)} ${pad(a.loginState, 13)} ${pad(a.loginCheckedAt ?? '-', 24)} 能力位：${on.length ? on.join(',') : '全关'}`);
  }
}

const worst = (codes) => [2, 1, 3].find((c) => codes.includes(c)) ?? 0;
const printExport = (e) => { console.log(e.file ? `已写 ${e.file}（${e.count} 条）` : e.message); for (const x of e.excluded) console.log(`  没导出 ${x.platformCode}：${x.reason}`); for (const p of e.problems ?? []) console.log(`  不合格：${p}`); };

function printRows(rows) {
  for (const r of rows) console.log(`${pad(r.id, 42)} ${pad(r.result === 'skipped' ? `跳过(${r.skipped ?? r.reason})` : r.result, 18)} ${r.message ?? ''}`);
}

// deps：测试注入假的 runTask / loadPlatform / moduleUrlOf / now（见 test/fixtures/ops-export/cli.mjs）
export async function main(argv = process.argv.slice(2), deps = {}) {
  const [group, sub, ...rest] = argv;
  const { values, positionals } = parseArgs({ args: ['login', 'collect'].includes(group) ? argv.slice(1) : rest, allowPositionals: true, options: {
    json: { type: 'boolean', default: false }, check: { type: 'boolean', default: false }, platform: { type: 'string' }, help: { type: 'boolean', short: 'h', default: false },
    days: { type: 'string' }, export: { type: 'boolean', default: false }, out: { type: 'string' }, date: { type: 'string' }, 'max-age-hours': { type: 'string' },
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
    let bad = null;
    if (values.check) {
      if (positionals.length) bad = `--check 不接位置参数（收到 ${positionals.map((p) => JSON.stringify(p)).join(' ')}），平台用 --platform`;
      else if (values.platform === '') bad = '--platform 不能是空串';
    } else if (values.platform !== undefined) bad = '扫码登录不接 --platform，写 hub ops login <platformCode|账号id>';
    else if (positionals.length > 1) bad = `扫码登录只接一个 <platformCode|账号id>；要检测写 --check（收到 ${positionals.map((p) => JSON.stringify(p)).join(' ')}）`;
    if (bad) { console.error(`${bad}\n${USAGE}`); return 1; }
    const r = values.check
      ? await checkLogins(db, values.platform ? { platform: values.platform } : {})
      : positionals[0] ? await scanLogin(db, positionals[0]) : null;
    if (r) {
      if (values.json) console.log(JSON.stringify({ exitCode: r.exitCode, rows: r.rows }, null, 1));
      else printRows(r.rows);
      return r.exitCode;
    }
  }
  if (group === 'collect') {
    const r = await collectWorks(db, { ...deps, platforms: positionals, days: values.days == null ? undefined : Number(values.days) });
    const ex = values.export ? [exportPosts(db, { now: deps.now }), exportAccounts(db, { now: deps.now })] : [];
    const exitCode = values.export ? worst([r.exitCode, ...ex.map((e) => e.exitCode)]) : r.exitCode;
    if (values.json) console.log(JSON.stringify({ exitCode, runId: r.runId, rows: r.rows, ...(values.export ? { export: { posts: ex[0], accounts: ex[1] } } : {}) }, null, 1));
    else { printRows(r.rows); ex.forEach(printExport); }
    return exitCode;
  }
  if (group === 'export' && ['posts', 'accounts'].includes(sub) && !positionals.length) {
    const opts = { now: deps.now, out: values.out, date: values.date, ...(values['max-age-hours'] != null ? { maxAgeHours: Number(values['max-age-hours']) } : {}) };
    const e = (sub === 'posts' ? exportPosts : exportAccounts)(db, opts);
    if (values.json) console.log(JSON.stringify(e, null, 1)); else printExport(e);
    return e.exitCode;
  }
  console.error(USAGE);
  return 1;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === import.meta.filename) {
  main().then((code) => process.exit(code), (e) => { console.error(`出错：${e.message}`); process.exit(1); });
}
