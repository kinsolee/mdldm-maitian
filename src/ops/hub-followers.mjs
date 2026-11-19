// KIN-330：把 ops.db 的 fans_daily 同步进麦田原库 hub.db 的 followers，工作台的粉丝曲线就能看到。
// 不 import src/db.mjs：它会顺带加载 feishu.mjs，没有 config.json 时 process.exit（见 paths.mjs）。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.mjs';
import { SCOPE, dateCn } from './export.mjs';
import { ensureWorksTables } from './works-db.mjs';

/** ops 的 platformCode → 工作台的平台键（board.html 的 PN）。 */
export const HUB_KEY = { Douyin: 'douyin', [SCOPE[1]]: 'xhs', Bili: 'bilibili', Channels: 'channels' };
export const hubDbPath = () => process.env.MAITIAN_DB || path.join(ROOT, 'data', 'hub.db');

/** 打开 hub.db。文件不存在时返回 null，不新建：路径配错时不在别处凭空建一个麦田原库。 */
export function openHubDb(file = hubDbPath()) {
  if (!fs.existsSync(file)) return null;
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout=5000;');
  return db;
}

/**
 * 幂等：按 followers 主键 (day, platform) upsert，source 写 'ops'（旧采集见到 ops 行不覆盖）。
 * 每个平台只取 accounts 表里这个平台的第一个账号（按导入顺序 rowid），其余 uid 不算、不求和。
 * fansTotal 为空：已有那天的行留着原 total；没有那天的行就不写（工作台曲线读 total，不放空值）。
 * gain/loss 由 fansNet 推：> 0 记 gain，< 0 记 loss 的绝对值，其余为 null。
 * 今天：抖音、B站、小红书的分日只到昨天，今天的总数只在 account_snapshots.fans。取最新一条 fans 非空的快照，
 * 按东八区日期写一行；fans_daily 那天已有 fansTotal 时以 fans_daily 为准（快照不写），没有时 total 取快照、gain/loss 仍按 fans_daily 的 fansNet（没有就 null）。
 */
export function syncFollowers(opsDb, hubDb) {
  ensureWorksTables(opsDb);
  // 同 src/followers.mjs 的定义
  hubDb.exec('CREATE TABLE IF NOT EXISTS followers (day TEXT, platform TEXT, total INTEGER, gain INTEGER, loss INTEGER, source TEXT, collected_at TEXT, PRIMARY KEY (day, platform));');
  const first = opsDb.prepare('SELECT uid FROM accounts WHERE platformCode = ? ORDER BY rowid LIMIT 1');
  const rows = opsDb.prepare('SELECT date, fansTotal, fansNet, collectedAt FROM fans_daily WHERE platformCode = ? AND uid = ? ORDER BY date');
  const snap = opsDb.prepare('SELECT fans, collectedAt FROM account_snapshots WHERE platformCode = ? AND uid = ? AND fans IS NOT NULL ORDER BY collectedAt DESC, rowid DESC LIMIT 1');
  const up = hubDb.prepare(`INSERT INTO followers (day, platform, total, gain, loss, source, collected_at) SELECT ?, ?, ?, ?, ?, 'ops', ?
    WHERE ?3 IS NOT NULL OR EXISTS (SELECT 1 FROM followers WHERE day = ?1 AND platform = ?2)
    ON CONFLICT (day, platform) DO UPDATE SET total = COALESCE(excluded.total, total), gain = excluded.gain, loss = excluded.loss, source = 'ops', collected_at = excluded.collected_at`);
  const out = { written: 0, platforms: {} };
  hubDb.exec('BEGIN');
  try {
    for (const [code, key] of Object.entries(HUB_KEY)) {
      const a = first.get(code);
      let n = 0;
      const write = (day, total, net, at) => { n += Number(up.run(day, key, total, net > 0 ? net : null, net < 0 ? -net : null, at).changes); };
      if (a) {
        const daily = rows.all(code, a.uid);
        for (const r of daily) write(r.date, r.fansTotal, r.fansNet, r.collectedAt);
        const s = snap.get(code, a.uid), day = s && dateCn(Date.parse(s.collectedAt));
        const d = s && daily.find((r) => r.date === day);
        if (s && d?.fansTotal == null) write(day, Math.round(s.fans), d?.fansNet ?? null, s.collectedAt);
      }
      out.platforms[key] = n;
      out.written += n;
    }
    hubDb.exec('COMMIT');
  } catch (e) {
    hubDb.exec('ROLLBACK');
    throw e;
  }
  return out;
}

/** CLI 用：打开 hub.db 同步一次。hub.db 不存在时返回 { ok: false, message }。 */
export function syncFollowersToHub(opsDb, file = hubDbPath()) {
  const hub = openHubDb(file);
  if (!hub) return { ok: false, message: `没有 ${file}（hub.db），没同步粉丝` };
  try { return { ok: true, file, ...syncFollowers(opsDb, hub) }; } finally { hub.close(); }
}
