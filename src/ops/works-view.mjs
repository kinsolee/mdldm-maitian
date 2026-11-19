// KIN-330：工作台「作品」页的只读数据（GET /api/ops/works）。读 ops.db，不写。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { SCOPE, dateCn } from './export.mjs';
import { HUB_KEY } from './hub-followers.mjs';

const NAMES = { douyin: '抖音', xhs: '小红书', bilibili: 'B站', channels: '视频号' };   // 同 src/db.mjs 的 NAMES
const DAYS = 30;
const FIELDS = ['title', 'postTime', 'statusText', 'url', 'view', 'like', 'comment', 'favorite', 'forward', 'fansAdd'];

/**
 * 四个平台近 30 天（东八区，按 postTime）的作品，按发布时间倒序；每个平台最近一次采集（任何结果）。
 * platform 可以是工作台的键（douyin）或 platformCode（Douyin）。记录里没有的值一律 null，不补 0。
 */
export function worksView(db, { platform, nowMs = Date.now() } = {}) {
  const codes = SCOPE.filter((c) => !platform || c === platform || HUB_KEY[c] === platform);
  const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const lastRun = has('collect_runs') && db.prepare('SELECT finishedAt, result, reason, message FROM collect_runs WHERE platformCode = ? ORDER BY finishedAt DESC, rowid DESC LIMIT 1');
  const platforms = codes.map((c) => {
    const r = lastRun && lastRun.get(c);
    return { platform: HUB_KEY[c], platformCode: c, name: NAMES[HUB_KEY[c]], lastRun: r ? { finishedAt: r.finishedAt, result: r.result, reason: r.reason, message: r.message } : null };
  });
  const works = [];
  if (has('works')) {
    const q = db.prepare('SELECT postId, record FROM works WHERE platformCode = ? AND postTime >= ?');
    const since = dateCn(nowMs - DAYS * 86400_000);
    for (const c of codes) for (const w of q.all(c, since)) {
      const rec = JSON.parse(w.record);
      works.push({ platform: HUB_KEY[c], platformCode: c, name: NAMES[HUB_KEY[c]], postId: w.postId, ...Object.fromEntries(FIELDS.map((k) => [k, rec[k] ?? null])) });
    }
  }
  works.sort((a, b) => (a.postTime < b.postTime ? 1 : a.postTime > b.postTime ? -1 : 0));
  return { platforms, works };
}

/** 按路径只读打开；文件不存在时不建，直接返回空结构。 */
export function readWorksView(file, opts) {
  if (!fs.existsSync(file)) return worksView(new DatabaseSync(':memory:'), opts);
  const db = new DatabaseSync(file, { readOnly: true });
  try { return worksView(db, opts); } finally { db.close(); }
}
