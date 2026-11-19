// S3 采集、导出测试共用：准备好四个平台账号的 ops.db，假 runner、假平台模块（map 原样返回 raw.mapped）。
import path from 'node:path';
import { openOpsDb } from '../../../src/ops/db.mjs';
import { importAccounts, setUid, setCapability } from '../../../src/ops/accounts.mjs';

export const SEED = path.resolve(import.meta.dirname, '../../../src/ops/accounts.seed.json');
export const PLATFORMS = ['Douyin', 'XiaoHongShu', 'Bili', 'Channels'];
export const UIDS = { Douyin: '106707338905', XiaoHongShu: '5944af205e87e701889da649', Bili: '478358005', Channels: 'sphMxEyFyDie8K8' };
export const SECRET = 'v2_SECRET_finderUsername@finder';

/** seed 导入 + 视频号登记 uid + 四个平台 readWorks 打开。channelsUid:false 时视频号保持 pending。 */
export function prepareDb(file, { channelsUid = true } = {}) {
  const db = openOpsDb(file);
  importAccounts(db, SEED);
  if (channelsUid) setUid(db, 'Channels', UIDS.Channels);
  for (const p of PLATFORMS) if (p !== 'Channels' || channelsUid) setCapability(db, `${p}:${UIDS[p]}`, 'readWorks', true);
  return db;
}

// 字段和顺序照 posts-20261118.json
export const post = (platform, postId, extra = {}) => ({
  postId, uid: UIDS[platform], platform, account: 'Kinso', title: `标题 ${postId}`, desc: null, cover: null, postType: '视频', postTypeCode: '1',
  publishStatus: 'published', statusText: '已发布', status: '1', postTime: '2026-11-17 11:56:57', timing: null, url: null,
  view: 100, like: 3, comment: 1, favorite: 2, forward: 0, fansAdd: 1, ...extra,
});
export const account = (platform, extra = {}) => ({
  uid: UIDS[platform], loginStatus: '登录有效', fans: 100, updateTime: '2026-11-19 09:00:00',
  daily: [{ date: '2026-11-17', fansTotal: 98, fansNet: 1 }, { date: '2026-11-18', fansTotal: 100, fansNet: 2 }], ...extra,
});
export const mapped = (platform, o = {}) => ({ loggedIn: true, uidSeen: UIDS[platform], posts: [post(platform, `${platform}-1`)], account: account(platform), stats: { pages: 1 }, complete: true, incomplete: null, ...o });

/**
 * byPlatform[code]：map 结果（默认 mapped(code)），或 {ok:false, reason} 表示 runner 失败；也可以是函数 (opts) => 二者之一。
 * runner 返回的 raw 里带一个假 finderUsername，用来查它不会出现在输出里。
 */
export function fakes(byPlatform = {}, { delayMs = 0 } = {}) {
  const calls = [];
  let running = 0, maxRunning = 0;
  const runTask = async (opts) => {
    calls.push(opts);
    running++; maxRunning = Math.max(maxRunning, running);
    await new Promise((r) => setTimeout(r, delayMs));
    running--;
    const code = opts.space.split('/')[1];
    let v = byPlatform[code] ?? mapped(code);
    if (typeof v === 'function') v = v(opts);
    if (v.ok === false) return v;
    return { ok: true, result: { finderUsername: SECRET, mapped: v } };
  };
  const loadPlatform = async (code) => ({ PLATFORM: code, map: (raw) => raw.mapped });
  const moduleUrlOf = (code) => `file:///fake/${code}.mjs`;
  return { runTask, loadPlatform, moduleUrlOf, calls, maxRunning: () => maxRunning };
}
