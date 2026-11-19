// 登录检测（login --check）和人发起的扫码（login <平台>）。
// 依赖全部从参数传入（runInSpace、notify、now），测试注入假的；cli.mjs 负责接上真的。
import { PENDING, platformOf } from './accounts.mjs';
import { setLoginState, setLastAlertAt, adoptUid } from './store.mjs';
import { DETECT_SCRIPT, LOGIN_SCRIPT } from './probe.mjs';

export const ALERT_INTERVAL_MS = 6 * 3600_000;

// runInSpace 的 reason → 退出码（接口约定表）；runner 返回了 exitCode 就以它为准
const REASON_EXIT = { locked: 5, 'previous-still-running': 5, 'user-owned': 4, 'profile-rejected': 3, 'profile-missing': 3, 'bad-space-name': 2 };
export const exitCodeOf = (r) => r.exitCode ?? REASON_EXIT[r.reason] ?? 1;

// 多个平台时取最严重的：uid 不一致 > 出错 > profile 问题 > 参数 > 在负责人手里 > 被锁跳过 > 正常
const SEVERITY = [6, 1, 8, 7, 3, 2, 4, 5, 0];
export const worstExit = (codes) => codes.reduce((w, c) => (SEVERITY.indexOf(c) < SEVERITY.indexOf(w) ? c : w), 0);

const cmdName = (code) => code.toLowerCase();
const describe = (v) => `${typeof v}，长度 ${String(v).length}`;

/** 掉线提醒：同一账号 6 小时内最多一次。notify 返回 false 表示没发出去，不记节流时间。 */
async function alertOut(db, acct, nowMs, notify) {
  const last = acct.lastAlertAt ? Date.parse(acct.lastAlertAt) : null;
  if (last != null && nowMs - last < ALERT_INTERVAL_MS) return 'throttled';
  const p = cmdName(acct.platformCode);
  const text = `❌ 账号掉线：${acct.platformName}\n${acct.platformName}：未登录（${acct.spaceName}）\n请跑 hub ops login ${p} 扫码；扫完后跑 hub ops login --check ${p} --take-back`;
  const sent = await notify(text);
  if (sent === false) return 'not-sent';
  setLastAlertAt(db, acct, new Date(nowMs).toISOString());
  return 'sent';
}

/** 关掉 pending 改名后留下的旧 space。只关 agent 持有的；在负责人手里（user-owned）不碰。 */
async function closeOldSpace(acct, finishSpace) {
  let r;
  try { r = await finishSpace(acct.spaceName, { profileId: acct.profileId }); }
  catch (e) { r = { ok: false, reason: 'error', error: String(e?.message ?? e) }; }
  if (r.ok) return { status: 'closed', note: `旧 space ${acct.spaceName} 已关`, exitCode: 0 };
  if (r.reason === 'user-owned') return { status: 'user-owned', note: `旧 space ${acct.spaceName} 在你手里，没关`, exitCode: 0 };
  return { status: 'close-failed', note: `旧 space ${acct.spaceName} 没关掉（${r.reason}：${r.error ?? ''}），请在 Ego Lite 里手动关`, exitCode: 1 };
}

// Instagram、知识站：负责人定为暂时不处理。公开函数里也拦，直接调库函数同样不会交给 runner。
const outOfScopeRow = (acct, note) => (platformOf(acct.platformCode)?.outOfScope
  ? { platform: acct.platformName, platformCode: acct.platformCode, result: 'refused', reason: 'out-of-scope', note, exitCode: 2 }
  : null);

/** 检测一个账号，返回一行结果（含 exitCode）。只读：不改页面状态，只写本地登记。 */
async function checkOne(db, acct, { runInSpace, finishSpace, notify, now, takeBack }) {
  const base = { platform: acct.platformName, platformCode: acct.platformCode, spaceName: acct.spaceName };
  let r;
  try {
    r = await runInSpace({ space: acct.spaceName, profileId: acct.profileId, lock: 'skip', takeBack: !!takeBack, script: DETECT_SCRIPT, params: { platformCode: acct.platformCode, uid: acct.uid } });
  } catch (e) {
    return { ...base, result: 'error', error: String(e?.message ?? e), exitCode: 1 };
  }
  const nowMs = now();
  const at = new Date(nowMs).toISOString();
  if (!r.ok) {
    const exitCode = exitCodeOf(r);
    if (r.reason === 'user-owned') {
      setLoginState(db, acct, 'awaiting_user', at);
      return { ...base, result: 'awaiting_user', loginState: 'awaiting_user', note: 'space 在负责人手里，没接管、没碰页面', exitCode };
    }
    if (exitCode === 5) return { ...base, result: 'skipped', loginState: acct.loginState, note: `这一轮跳过（${r.reason}），登录状态没改`, exitCode };
    return { ...base, result: 'error', loginState: acct.loginState, reason: r.reason, error: r.error, exitCode };
  }

  const c = r.result ?? {};
  const state = ['ok', 'out', 'unknown'].includes(c.state) ? c.state : 'unknown';
  const seen = c.uidSeen == null || c.uidSeen === '' ? null : String(c.uidSeen);
  const row = { ...base, result: state, evidence: c.evidence };

  if (seen != null && acct.uid !== PENDING && seen !== acct.uid) {
    // 硬停：登录的不是登记的那个账号，登记一个字段都不改
    return { ...row, result: 'uid-mismatch', loginState: acct.loginState, reason: 'uid-mismatch', error: `${acct.platformName} uid 不一致：登记 ${acct.uid}（${describe(acct.uid)}），读到 ${seen}（${describe(seen)}）；登记没改，先确认 space 里登录的是哪个账号`, exitCode: 6 };
  }
  if (seen != null && acct.uid === PENDING && state === 'ok') {
    let newName;
    try { newName = adoptUid(db, acct, seen, state, at); }
    catch (e) { return { ...row, result: 'error', loginState: acct.loginState, error: `uid 改名失败：${e.message}`, exitCode: 1 }; }
    // Ego 没有给 space 改名的接口：关掉旧的 .../pending，新名字的 space 由 runner 下次按名字建（登录态是 profile 级 cookie，不用重扫）。
    // 这时 runInSpace 已经返回、旧名的锁已释放，finishSpace 自己拿锁。
    const old = await closeOldSpace(acct, finishSpace);
    return { ...row, loginState: state, uid: seen, spaceName: newName, oldSpace: old.status, note: `space 改名：${acct.spaceName} → ${newName}；${old.note}`, exitCode: old.exitCode };
  }
  setLoginState(db, acct, state, at);
  const out = { ...row, loginState: state, uid: seen ?? '未读到', exitCode: 0 };
  if (state === 'out') out.alert = await alertOut(db, acct, nowMs, notify);
  return out;
}

/**
 * login --check：accounts 是要检测的登记行（cli 已按平台筛好、已排除不处理的平台）。
 * @returns {Promise<{ rows: object[], exitCode: number }>}
 */
export async function checkLogin(db, accounts, deps) {
  const rows = [];
  for (const acct of accounts) {
    const skip = outOfScopeRow(acct, '跳过：负责人定为暂时不处理');
    if (skip) { rows.push({ ...skip, result: 'skipped', exitCode: 0 }); continue; }
    rows.push(await checkOne(db, acct, deps));
  }
  return { rows, exitCode: worstExit(rows.map((r) => r.exitCode)) };
}

/** login <平台>：排队拿锁，打开扫码页，handOff 交给负责人。 */
export async function startLogin(db, acct, { runInSpace, now }) {
  const refused = outOfScopeRow(acct, '负责人定为暂时不处理，不开登录页');
  if (refused) return refused;
  const base = { platform: acct.platformName, platformCode: acct.platformCode, spaceName: acct.spaceName };
  const next = `扫完后跑 hub ops login --check ${cmdName(acct.platformCode)} --take-back`;
  let r;
  try {
    r = await runInSpace({ space: acct.spaceName, profileId: acct.profileId, lock: 'wait', script: LOGIN_SCRIPT, params: { platformCode: acct.platformCode } });
  } catch (e) {
    return { ...base, result: 'error', error: String(e?.message ?? e), exitCode: 1 };
  }
  const at = new Date(now()).toISOString();
  if (r.ok) {
    setLoginState(db, acct, 'awaiting_user', at);
    return { ...base, result: 'awaiting_user', note: `已打开登录页并交给你（Ego Lite 里的 ${acct.spaceName}）；${next}`, exitCode: 0 };
  }
  if (r.reason === 'user-owned') {
    setLoginState(db, acct, 'awaiting_user', at);
    return { ...base, result: 'awaiting_user', note: `space 已经在你手里，没动它；${next}`, exitCode: exitCodeOf(r) };
  }
  return { ...base, result: 'error', reason: r.reason, error: r.error, exitCode: exitCodeOf(r) };
}
