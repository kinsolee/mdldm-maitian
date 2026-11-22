// 评论回复、私信的写入适配器：每个平台一个文件，导出 FILE 和 runInSpace(task, params)，经 runner 在账号自己的 space 里跑（runner 自带 space 锁）。
// params：{ op: 'reply'|'sendDM', uid, nickname, text, target, urls?, timeouts? }，target 见 src/ops/engage/write.mjs 的 targetOf。
// 返回（原样 JSON）：{ uidSeen, loginLost?, evidence?, blocked?, detail?, sendAttempted, sendError?, readBack?: { found, count, nativeId?, detail? } }
// 规则：动手前核对账号（不符 blocked 'uid-mismatch'）；发前在页面上重读；发送只触发一次、绝不重试；点了发送之后出任何错都要返回 sendAttempted:true。
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const WRITER_FILES = { Bili: 'bili.mjs', Douyin: 'douyin.mjs', Channels: 'channels.mjs', XiaoHongShu: 'xhs.mjs' };
// 处置组（delete、block、deleteConversation）每个平台单独一个文件；哪个操作放行哪个平台由 moderate.mjs 的 MOD_SUPPORT 决定
export const MODERATE_FILES = { Bili: 'bili-moderate.mjs' };
const MODERATE_OPS = new Set(['delete', 'block', 'deleteConversation']);
// B站走接口，几秒就完；页面平台打开后台、切作品要 10 到 60 秒（S0）
export const WRITE_TIMEOUT_MS = { Bili: 2 * 60_000, Douyin: 6 * 60_000, Channels: 6 * 60_000, XiaoHongShu: 6 * 60_000 };
const SCRIPT = 'const m = await import(params.moduleUrl);\nreturn m.runInSpace(task, params);';

export const writerModuleUrl = (code, op) => {
  const file = MODERATE_OPS.has(op) ? MODERATE_FILES[code] : WRITER_FILES[code];
  if (!file) throw new Error(`${code} 没有 ${op} 的写入脚本`);
  return pathToFileURL(path.join(import.meta.dirname, file)).href;
};

/** 在账号的 space 里跑写入脚本。返回 runner 的结果：{ ok: true, result } 或 { ok: false, reason, error }。 */
export async function runWriterInSpace({ account, params }, { runner } = {}) {
  const run = runner ?? (await import('../../../ego-runner/index.mjs')).runEgoTask;
  return run({ space: account.spaceName, profileId: account.profileId ?? 'Profile 5', timeoutMs: WRITE_TIMEOUT_MS[account.platformCode],
    params: { ...params, moduleUrl: writerModuleUrl(account.platformCode, params.op) }, script: SCRIPT });
}
