// 测试共用：Ego Lite 在不在、临时 space 名、本地测试页地址。
import { randomBytes } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runEgoScript } from '../../src/ego-runner/index.mjs';

export const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));
export const fixtureUrl = (name) => pathToFileURL(FIXTURE_DIR + name).href;

export const tempSpaceName = (tag = 't') => `kinso/test/${tag}-${randomBytes(4).toString('hex')}`;

// Ego Lite 没装、没开或没有 Profile 5 时返回原因，测试据此 skip（不假装通过）
export async function egoUnavailableReason() {
  const r = await runEgoScript('console.log("@@RESULT " + JSON.stringify((await profiles()).some((p) => p.id === "Profile 5")))', { timeoutMs: 30_000 });
  if (!r.ok) return `Ego Lite 不可用：${r.reason} ${r.error}`;
  if (r.result !== true) return 'Ego Lite 里没有 Profile 5';
  return null;
}

/**
 * 测试收尾：关掉一个 kinso/test/ 临时 space，留在用户手里的（测 user-owned 时故意造的）也认领后关掉。
 * 只给测试用：runner 的 finishSpace 按 spec 不碰用户的 space。
 */
export async function closeTestSpace(name) {
  // 关不掉就抛错（让测试失败），不悄悄留下临时 space
  if (!/^kinso\/test\//.test(name)) throw new Error(`只关 kinso/test/ 的临时 space：${name}`);
  return runEgoScript(`const s = (await listTaskSpaces()).find((x) => x.name === ${JSON.stringify(name)} && x.profileId === "Profile 5");
let r = { existed: !!s };
if (s) {
  const t = s.ownership === "agent" ? await taskSpace(s.id) : s.ownership === "user" ? await claimTaskSpace(s.id) : await takeOverTaskSpace(s.id);
  r = { existed: true, ...(await t.finish({ keep: [] })) };
}
console.log("@@RESULT " + JSON.stringify(r));`, { timeoutMs: 60_000 });
  if (!r.ok || (r.result.existed && !r.result.closedSpace)) throw new Error(`没关掉临时 space ${name}：${r.reason ?? ''} ${r.error ?? JSON.stringify(r.result)} ${(r.stderr ?? '').slice(-300)}`);
  return r;
}

export const EGO_SKIP = await egoUnavailableReason();
if (EGO_SKIP) console.log(`# SKIP Ego Lite 行为测试：${EGO_SKIP}`);
