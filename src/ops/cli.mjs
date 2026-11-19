#!/usr/bin/env node
// 账号层命令行（hub ops ... 转到这里，也可以直接 node src/ops/cli.mjs ...）
//   accounts seed                         写入初始账号登记（幂等：已有的平台不动）
//   accounts list                         列出登记（每行一个 JSON，不含任何凭据）
//   login --check [平台] [--take-back]    只读检测登录，写回登录状态；不带平台时检测全部（跳过 Instagram、知识站）
//                                         --check、--take-back 放在平台名前后都行
//                                         --take-back：只在你扫完码后手动跑，收回交给你的 space；必须和 --check 一起用
//   login <平台>                          打开该平台登录页，把 space 交给你扫码
//   tokens init                           生成写入类口令到仓库根目录 .env（已有的不覆盖，不打印口令值）
// 平台：platformCode（不分大小写，如 douyin、xiaohongshu、bili、gongzhonghao、weibo、channels、x、youtube），
//       或中文名（抖音、小红书、B站、公众号、微博、视频号），或麦田 id（xhs、bilibili、mp、zsz）
// 退出码：0 正常；1 出错；2 参数不对 / 不处理的平台 / bad-space-name；3 profile 问题；4 space 在你手里；
//         5 被锁跳过；6 uid 不一致；7 能力没开；8 缺口令。--check 多个平台时取最严重的。
//         检测到掉线（out）本身不算出错，退出码 0，靠飞书提醒。--check 的 stdout 只有逐行 JSON，提示写 stderr。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, opsDir } from './paths.mjs';
import { resolvePlatform } from './accounts.mjs';
import { openOpsDb, seedAccounts, listAccounts, getAccount } from './store.mjs';
import { checkLogin, startLogin } from './login.mjs';
import { initTokens } from './tokens.mjs';

// 用法就是文件开头那段注释
const HEAD = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1);
const USAGE = HEAD.slice(0, HEAD.findIndex((l) => !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');

// runner 懒加载：点名不处理的平台、accounts、tokens 都用不到它
const defaultRunInSpace = async (opts) => (await import('../ego-runner/index.mjs')).runInSpace(opts);
const defaultFinishSpace = async (space, opts) => (await import('../ego-runner/index.mjs')).finishSpace(space, opts);

// 懒加载 feishu.mjs：它在没有 config.json 时会直接退出进程，所以先自己看一眼配置。
// 返回 false 表示没发出去（不记节流时间）；本地提示只写 stderr，stdout 留给逐行 JSON。
function defaultNotify(err) {
  return async (text) => {
    const cfg = process.env.MAITIAN_CONFIG || path.join(ROOT, 'config.json');
    let webhook = null;
    try { webhook = JSON.parse(fs.readFileSync(cfg, 'utf8')).feishuWebhook || null; } catch {}
    if (!webhook) { err(`没有配置飞书 webhook（${cfg}），提醒没发：${text.split('\n')[0]}`); return false; }
    const { notify } = await import('../feishu.mjs');
    await notify(text, { quiet: true });
    err(`[飞书] 已发：${text.split('\n')[0]}`);
    return true;
  };
}

/** 统一解析参数：返回 { cmd, platArg, takeBack }，用法不对返回 null。 */
export function parseArgs(argv) {
  const [group, sub, ...rest] = argv;
  if (group === 'tokens') return sub === 'init' && !rest.length ? { cmd: 'tokens-init' } : null;
  if (group === 'accounts') return (sub === 'seed' || sub === 'list') && !rest.length ? { cmd: `accounts-${sub}` } : null;
  if (group !== 'login') return null;
  const args = argv.slice(1);
  const flags = args.filter((x) => x.startsWith('-'));
  const pos = args.filter((x) => !x.startsWith('-'));
  if (flags.some((f) => f !== '--check' && f !== '--take-back') || new Set(flags).size !== flags.length) return null;
  const check = flags.includes('--check'), takeBack = flags.includes('--take-back');
  if (takeBack && !check) return null;
  if (check ? pos.length > 1 : pos.length !== 1) return null;
  return { cmd: check ? 'login-check' : 'login', platArg: pos[0] ?? null, takeBack };
}

/**
 * @param {string[]} argv  ops 之后的参数
 * @param {{ out?, err?, runInSpace?, finishSpace?, notify?, now?, root?, dir?, genToken? }} deps  测试注入
 * @returns {Promise<number>} 退出码
 */
export async function main(argv, deps = {}) {
  const out = deps.out ?? ((s) => process.stdout.write(`${s}\n`));
  const err = deps.err ?? ((s) => process.stderr.write(`${s}\n`));
  const json = (o) => out(JSON.stringify(o));
  if (!argv.length || ['help', '--help', '-h'].includes(argv[0])) { err(USAGE); return 0; }
  const a = parseArgs(argv);
  if (!a) { err(USAGE); return 2; }

  if (a.cmd === 'tokens-init') {
    const r = initTokens({ root: deps.root ?? ROOT, gen: deps.genToken });
    for (const t of r.tokens) out(`${t.name}：${t.status}`);
    out(`写在 ${r.envFile}（权限 600）${r.gitignoreAdded ? '；.gitignore 已加 .env' : ''}`);
    return 0;
  }

  if (a.cmd === 'accounts-seed' || a.cmd === 'accounts-list') {
    const db = openOpsDb(deps.dir ?? opsDir());
    try {
      if (a.cmd === 'accounts-seed') {
        const r = seedAccounts(db);
        out(`新登记 ${r.added.length} 个${r.added.length ? `：${r.added.join('、')}` : ''}；已有没动 ${r.kept.length} 个`);
      } else {
        for (const acct of listAccounts(db)) json(acct);
      }
      return 0;
    } finally { db.close(); }
  }

  // login / login --check
  const plat = a.platArg ? resolvePlatform(a.platArg) : null;
  if (a.platArg && !plat) { err(`认不出平台：${a.platArg}`); return 2; }
  // 点名不处理的平台：直接拒绝，不调 runInSpace、不开任何页面
  if (plat?.outOfScope) { json({ platform: plat.name, platformCode: plat.code, result: 'refused', reason: 'out-of-scope', note: '负责人定为暂时不处理，不检测、不开页面', exitCode: 2 }); return 2; }

  const runInSpace = deps.runInSpace ?? defaultRunInSpace;
  const now = deps.now ?? Date.now;
  const db = openOpsDb(deps.dir ?? opsDir());
  try {
    const accounts = plat ? [getAccount(db, plat.code)].filter(Boolean) : listAccounts(db);
    if (!accounts.length) { err(plat ? `${plat.name} 还没登记，先跑 hub ops accounts seed` : '还没有任何登记，先跑 hub ops accounts seed'); return 2; }
    if (a.cmd === 'login-check') {
      const r = await checkLogin(db, accounts, { runInSpace, finishSpace: deps.finishSpace ?? defaultFinishSpace, now, notify: deps.notify ?? defaultNotify(err), takeBack: a.takeBack });
      for (const row of r.rows) json(row);
      return r.exitCode;
    }
    const row = await startLogin(db, accounts[0], { runInSpace, now });
    json(row);
    if (row.note) out(row.note);
    return row.exitCode;
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
