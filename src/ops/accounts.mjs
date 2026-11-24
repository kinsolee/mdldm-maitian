// 账号表的读写：导入清单、列出、登记真实 uid、能力位。
// 账号 id 对外写 <platformCode>:<uid>；space 名 kinso/<platformCode>/<uid>。
import fs from 'node:fs';

export const PENDING = 'pending';
export const DEFAULT_PROFILE = 'Profile 5';
// readViaApi / writeViaApi（S9）：评论读、回复评论改用页面内接口（调页面自己的接口封装函数），默认关；关着时走 DOM 路径。
// writeDmViaApi：抖音发私信改用页面内接口（调私信页自己的 IM SDK 发送函数），和 writeViaApi 分开开关、分开回撤。
// 它们只选「怎么读、怎么写」，不授权：回复照样要 reply 打开、私信要 sendDM 打开。连续失败自动关写能力位时不动它们（reply、sendDM 关了就写不了）。
export const CAPABILITIES = ['readWorks', 'readComments', 'readDM', 'reply', 'sendDM', 'likeComment', 'pinComment', 'deleteComment', 'block', 'deleteConversation', 'setVisibility', 'publish', 'readViaApi', 'writeViaApi', 'writeDmViaApi'];
export const PLATFORM_NAMES = { Douyin: '抖音', Channels: '视频号', XiaoHongShu: '小红书', Bili: 'B站', GongZhongHao: '公众号', Weibo: '微博', X: 'X', YouTube: 'YouTube', Instagram: 'Instagram', Zhishi: '知识站' };

/** uid 统一写法：去首尾空白和前导 @（X 的 handle）。空的返回 null。导入、set-uid、迁移、检测比对都用它。 */
export function normalizeUid(u) {
  if (u == null) return null;
  const s = String(u).trim().replace(/^@+/, '').trim();
  return s || null;
}

export const spaceNameOf = (platformCode, uid) => `kinso/${platformCode}/${uid}`;
export const accountId = (a) => `${a.platformCode}:${a.uid}`;
const noCaps = () => JSON.stringify(Object.fromEntries(CAPABILITIES.map((c) => [c, false])));

function parseId(id) {
  const i = String(id).indexOf(':');
  if (i <= 0) throw new Error(`账号 id 要写成 <platformCode>:<uid>：${id}`);
  return [id.slice(0, i), id.slice(i + 1)];
}

function fromRow(r) {
  if (!r) return null;
  const caps = JSON.parse(r.capabilities);
  return { id: accountId(r), ...r, capabilities: Object.fromEntries(CAPABILITIES.map((c) => [c, caps[c] === true])) };
}

export function getAccount(db, id) {
  const [code, uid] = parseId(id);
  return fromRow(db.prepare('SELECT * FROM accounts WHERE platformCode = ? AND uid = ?').get(code, uid));
}

export function listAccounts(db, { platform } = {}) {
  const rows = platform
    ? db.prepare('SELECT * FROM accounts WHERE platformCode = ? ORDER BY rowid').all(platform)
    : db.prepare('SELECT * FROM accounts ORDER BY rowid').all();
  return rows.map(fromRow);
}

/**
 * 导入手写清单（幂等）。一个平台一个账号：
 * - 同一 (platformCode, uid) 已在表里：跳过，不动登录状态。
 * - 清单写 pending、表里已有这个平台的账号（包括已登记了真实 uid 的）：跳过。
 * - 清单写真实 uid、表里这个平台还是 pending：把 pending 那行改成真实 uid。
 */
export function importAccounts(db, file) {
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  let inserted = 0, upgraded = 0, skipped = 0;
  for (const a of list) {
    if (!PLATFORM_NAMES[a.platformCode]) throw new Error(`清单里有不认识的 platformCode：${a.platformCode}`);
    const uid = normalizeUid(a.uid) ?? PENDING;
    const same = listAccounts(db, { platform: a.platformCode });
    if (same.some((x) => x.uid === uid) || (uid === PENDING && same.length)) { skipped++; continue; }
    if (same.some((x) => x.uid === PENDING)) { migrateUid(db, a.platformCode, PENDING, uid); upgraded++; continue; }
    db.prepare('INSERT INTO accounts (platformCode, platformName, uid, nickname, profileId, spaceName, capabilities) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(a.platformCode, a.platformName || PLATFORM_NAMES[a.platformCode], uid, a.nickname ?? null, DEFAULT_PROFILE, spaceNameOf(a.platformCode, uid), noCaps());
    inserted++;
  }
  return { inserted, upgraded, skipped };
}

/** 把一行的 uid（主键的一部分）改掉，spaceName 跟着改。目标行已存在时并进去、删掉旧行。返回新 id。 */
export function migrateUid(db, platformCode, fromUid, toUid) {
  toUid = normalizeUid(toUid);
  if (!toUid || /[/\s]/.test(toUid) || toUid === PENDING) throw new Error(`uid 不合法：${toUid}`);
  if (fromUid === toUid) return `${platformCode}:${toUid}`;
  const target = db.prepare('SELECT 1 FROM accounts WHERE platformCode = ? AND uid = ?').get(platformCode, toUid);
  if (target) db.prepare('DELETE FROM accounts WHERE platformCode = ? AND uid = ?').run(platformCode, fromUid);
  else db.prepare('UPDATE accounts SET uid = ?, spaceName = ? WHERE platformCode = ? AND uid = ?').run(toUid, spaceNameOf(platformCode, toUid), platformCode, fromUid);
  return `${platformCode}:${toUid}`;
}

/** 手动登记真实 uid：这个平台 uid 还是 pending 的那个账号。 */
export function setUid(db, platformCode, uid) {
  const same = listAccounts(db, { platform: platformCode });
  if (!same.length) throw new Error(`表里没有 ${platformCode} 的账号，先 hub ops accounts import`);
  uid = normalizeUid(uid);
  if (!uid) throw new Error('uid 不能为空');
  if (same.some((x) => x.uid === uid)) return `${platformCode}:${uid}`;
  const pending = same.find((x) => x.uid === PENDING);
  if (!pending) throw new Error(`${platformCode} 已登记 uid ${same.map((x) => x.uid).join(', ')}，没有 pending 的账号可改`);
  return migrateUid(db, platformCode, PENDING, uid);
}

export function setCapability(db, id, cap, value) {
  if (!CAPABILITIES.includes(cap)) throw new Error(`没有这个能力位：${cap}（可选：${CAPABILITIES.join(', ')}）`);
  const a = getAccount(db, id);
  if (!a) throw new Error(`没有这个账号：${id}`);
  const caps = { ...a.capabilities, [cap]: value === true };
  db.prepare('UPDATE accounts SET capabilities = ? WHERE platformCode = ? AND uid = ?').run(JSON.stringify(caps), a.platformCode, a.uid);
}

/** 能力位是 false（或账号不存在）就直接拒绝。 */
export function requireCapability(db, id, cap) {
  if (!CAPABILITIES.includes(cap)) throw new Error(`没有这个能力位：${cap}`);
  const a = getAccount(db, id);
  if (!a) throw new Error(`没有这个账号：${id}，拒绝 ${cap}`);
  if (!a.capabilities[cap]) throw new Error(`账号 ${id} 的能力位 ${cap} 没有打开，拒绝。要开：hub ops accounts set-cap ${id} ${cap} true`);
  return a;
}
