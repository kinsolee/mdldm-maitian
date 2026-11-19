// 假平台模块（接口同 src/ops/works/ 的平台模块）：fetchRaw 在 space 里跑，map 在宿主侧跑。用来测 collect-space.mjs 和任务脚本。
export const PLATFORM = 'Bili';
export const START_URL = 'https://member.bilibili.com/platform/upload-manager/article';
export const SETTLE_MS = 5;

export async function fetchRaw(page, { days, nowMs, sleep }) {
  await sleep(1);
  return { landed: await page.url(), days, nowMs, finderUsername: 'v2_SECRET_finderUsername@finder' };
}

export function map(raw, { days, nowMs }) {
  const rec = { postId: 'BV1fake', uid: '478358005', platform: 'Bili', account: 'Kinsolee', title: raw.landed, statusText: '已发布', postTime: '2026-11-17 11:56:29', view: days, like: 0, comment: 0, favorite: 0, forward: 0, fansAdd: 0 };
  return { loggedIn: true, uidSeen: 478358005, posts: [rec], account: { uid: '478358005', loginStatus: '登录有效', fans: 101, updateTime: '2026-11-19 09:00:00', daily: [{ date: '2026-11-18', fansTotal: null, fansNet: 2 }] }, stats: { nowMs } };
}
