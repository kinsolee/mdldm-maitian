// 评论、私信只读采集：collect({ account, kind }) 按 account.platformCode 分到各平台适配器。
// 每个平台文件分两半：runInSpace（经 runner 在账号的 space 里跑，只读，抄回原始 JSON）和 parse（Node 里把原始 JSON 变成约定形状）。
// runner 的 busy / user-controlled / profile-needed 原样跳过；页面落到登录页 reason='login-lost'；其余失败带 reason 和脱敏后的 error。
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { shapeErrors } from './shape.mjs';
import * as bili from './bili.mjs';
import * as douyin from './douyin.mjs';
import * as channels from './channels.mjs';
import * as xhs from './xhs.mjs';

export const ADAPTERS = { Bili: bili, Douyin: douyin, Channels: channels, XiaoHongShu: xhs };
const SKIPS = ['busy', 'user-controlled', 'profile-needed'];
const TIMEOUT_MS = { comments: 9 * 60_000, dms: 5 * 60_000 };
const SCRIPT = 'const m = await import(params.moduleUrl);\nreturn m.runInSpace(task, params);';
const moduleUrl = (code) => pathToFileURL(path.join(import.meta.dirname, `${ADAPTERS[code].FILE}`)).href;

/** 错误文本脱敏：去掉 URL 查询串、cookie 和各种 token 的值，截到 300 字。 */
export function safeError(e) {
  return String(e?.message ?? e ?? '')
    .replace(/(https?:\/\/[^\s"'?]+)\?[^\s"']*/g, '$1?<去掉>')
    .replace(/\b(cookie|set-cookie)\s*[:=]\s*[^\n]*/gi, '$1: <去掉>')
    .replace(/\b([\w-]*(?:token|bogus|sessdata|bili_jct|sign|ticket|csrf|a1|web_session)[\w-]*)\s*[=:]\s*["']?[^\s&;"',]+/gi, '$1=<去掉>')
    .slice(0, 300);
}

const fail = (reason, error) => ({ ok: false, reason, error: safeError(error) });

/**
 * @param {object} o
 * @param {object} o.account   listAccounts 的一行（platformCode、uid、spaceName、profileId、nickname）
 * @param {'comments'|'dms'} o.kind
 * @param {Function} [o.runner] 默认 ego-runner 的 runEgoTask（测试注入假的）
 * @param {Function} [o.now]    默认 Date.now
 * @param {string} [o.since]   ISO；私信只打开最后消息比它新的会话（小红书），评论只要这之后的（默认近 7 天）
 * @param {object} [o.options] 透传给页面脚本的上限（maxWorks、maxPages…），见各平台文件
 */
export async function collect({ account, kind, runner, now = Date.now, since = null, options = {} } = {}) {
  if (kind !== 'comments' && kind !== 'dms') return fail('bad-kind', `kind 只能是 comments 或 dms：${kind}`);
  const adapter = ADAPTERS[account?.platformCode];
  if (!adapter) return fail('unsupported-platform', `没有 ${account?.platformCode} 的评论/私信适配器`);
  const run = runner ?? (await import('../../../ego-runner/index.mjs')).runEgoTask;
  const params = { kind, platformCode: account.platformCode, uid: String(account.uid), nickname: account.nickname ?? null,
    since, now: now(), moduleUrl: moduleUrl(account.platformCode), ...options };
  let r;
  try {
    r = await run({ space: account.spaceName, profileId: account.profileId ?? 'Profile 5', timeoutMs: TIMEOUT_MS[kind], params, script: SCRIPT });
  } catch (e) { return fail('runner-threw', e); }
  if (!r?.ok) {
    if (SKIPS.includes(r?.reason)) return { ok: false, skipped: r.reason, error: safeError(r.error) };
    return fail(r?.reason || 'runner-failed', r?.error);
  }
  const raw = r.result;
  if (raw?.loginLost) return fail('login-lost', raw.evidence || '页面落到了登录页');
  if (raw?.failed) return fail(raw.failed, raw.error);
  let out;
  try {
    out = adapter.parse(kind, raw, { accountUid: String(account.uid), nickname: account.nickname ?? null, fetchedAt: new Date(now()).toISOString(), since });
  } catch (e) { return fail(e?.reason ?? 'parse', e); }
  const errs = shapeErrors(out);
  if (errs.length) return fail('parse', `输出形状不对：${errs.slice(0, 3).join('；')}`);
  return out;
}
