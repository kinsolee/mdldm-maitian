// 视频号：近 N 天作品 + 指标、粉丝总数和分日粉丝。读法和字段对照见 spikes/results/06-works.md「视频号」，
// 请求、翻页照搬 spikes/platform/06-works-channels.mjs（2026-11-19 实测）。
// 不用签名，靠 cookie；请求体要带 _log_finder_id=finderUsername。finderUsername 只在 fetchRaw 里当局部变量用，
// 不进 raw、不进 map 的返回值。用 page.fetch 发（page.evaluate 有 15 秒上限，连发几次会超时）。
// 这些接口是只读查询，虽然是 POST。fetchRaw 在 Ego space 里跑；map 是宿主侧纯函数。
import { DAY, cst, cstDate, cstDay0, num, pct, pick } from './fmt.mjs';

export const PLATFORM = 'Channels';
export const START_URL = 'https://channels.weixin.qq.com/platform';
export const SETTLE_MS = 8000;
const PAGE_GAP_MS = 2500;
const MAX_PAGES = 10;   // 每页 20 条

// 东八区当天 0 点往前 N 天（秒）；post_list 的 startTime/endTime 是秒
const startOf = (days, nowMs) => cstDay0(Math.floor(nowMs / 1000)) - days * DAY;

async function post(page, url, body) {
  const r = await page.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), timeout: 40000 });
  let json = null;
  try { json = JSON.parse(r.body); } catch {}
  return { http: r.status, json };
}

const ITEM_KEYS = ['objectId', 'objectNonce', 'createTime', 'status', 'readCount', 'favCount', 'likeCount', 'commentCount', 'forwardCount', 'followCount', 'fullPlayRate', 'avgPlayTimeSec', 'exportId', 'disableInfo'];
const trimItem = (p) => ({
  ...pick(p, ITEM_KEYS),
  desc: { shortTitle: p.desc?.shortTitle ?? [], description: p.desc?.description ?? null, media: (p.desc?.media ?? []).slice(0, 1).map((m) => pick(m, ['coverUrl', 'thumbUrl', 'url'])) },
});

export async function fetchRaw(page, { days, nowMs, sleep }) {
  const auth = await post(page, '/cgi-bin/mmfinderassistant-bin/auth/auth_data', { timestamp: String(nowMs), _log_finder_uin: '', _log_finder_id: '', rawKeyBuff: '', pluginSessionId: null, scene: 7, reqScene: 7 });
  const fu = auth.json?.data?.finderUser;
  const raw = { auth: { http: auth.http, errCode: auth.json?.errCode ?? null, finderUser: fu ? pick(fu, ['uniqId', 'nickname', 'fansCount', 'feedsCount']) : null } };
  const finderUsername = fu?.finderUsername;
  if (!finderUsername) return raw;

  const base = { _log_finder_uin: '', _log_finder_id: finderUsername, rawKeyBuff: '', pluginSessionId: null, scene: 7, reqScene: 7 };
  const call = (path, p) => post(page, `/micro/statistic/cgi-bin/mmfinderassistant-bin/${path}`, { ...p, timestamp: String(nowMs), ...base });
  const now = Math.floor(nowMs / 1000);
  const start = startOf(days, nowMs);

  raw.postList = [];
  raw.hitMaxPages = true;
  let got = 0;
  for (let p = 1; p <= MAX_PAGES; p++) {
    await sleep(PAGE_GAP_MS);
    const r = await call('statistic/post_list', { pageSize: 20, currentPage: p, sort: 0, order: 0, startTime: start, endTime: now });
    const d = r.json?.data;
    const list = (d?.list ?? []).map(trimItem);
    const total = d?.totalCount ?? d?.total ?? null;
    raw.postList.push({ http: r.http, errCode: r.json?.errCode ?? null, data: { totalCount: total, list } });
    got += list.length;
    // data.totalCount 是窗口内总数，翻到够数
    if (!list.length || got >= (total ?? 0)) { raw.hitMaxPages = false; break; }
  }

  await sleep(PAGE_GAP_MS);
  const today = cstDay0(now);
  const tr = await call('statistic/fans_trend', { startTs: String(start), endTs: String(today), interval: 3 });
  const t = tr.json?.data;
  // 第 i 个点是 startTs + i 天，map 要用 startTs 推日期
  raw.fansTrend = { http: tr.http, errCode: tr.json?.errCode ?? null, startTs: start, data: t ? pick(t, ['add', 'reduce', 'netAdd', 'total']) : null };
  return raw;
}

export function map(raw, { days, nowMs }) {
  const now = Math.floor(nowMs / 1000);
  const start = startOf(days, nowMs);
  const fu = raw.auth?.finderUser ?? null;
  const loggedIn = raw.auth?.errCode === 0 && !!fu;
  // 小V猫和 kinso-dashboard/refresh.py 认的视频号 uid 是 finderUser.uniqId（视频号 ID），不是 finderUsername
  const uid = fu?.uniqId ?? null;
  const items = (raw.postList ?? []).flatMap((x) => x.data?.list ?? []);

  const posts = items.filter((p) => p.createTime >= start).map((p) => {
    const media = p.desc?.media?.[0];
    return {
      // 小V猫的 postId 是 objectNonce（不是 objectId），已回填的笔记按它存 post_id，换了会重复建
      postId: String(p.objectNonce), objectId: p.objectId == null ? null : String(p.objectId), uid, platform: PLATFORM, account: fu?.nickname ?? null,
      title: p.desc?.shortTitle?.[0]?.shortTitle || (p.desc?.description || '').split('\n')[0].slice(0, 60), desc: p.desc?.description ?? null,
      cover: media?.coverUrl ?? media?.thumbUrl ?? null,
      // post_list 只含已发表的；仅自己可见的另外带 punish
      postType: '视频', postTypeCode: '1', publishStatus: 'published', statusText: '已发布', status: p.status == null ? null : String(p.status),
      postTime: cst(p.createTime), timing: null,
      url: media?.url ?? null,
      // 字段名和页面图标是反的：favCount 是 👍 点赞，likeCount 是 ♡ 推荐（小V猫也是这样对的）
      view: num(p.readCount), like: num(p.favCount), comment: num(p.commentCount),
      // 视频号没有收藏数
      favorite: null,
      forward: num(p.forwardCount), love: num(p.likeCount),
      fansAdd: num(p.followCount), fullView: pct(p.fullPlayRate), viewTime: num(p.avgPlayTimeSec),
      exportId: p.exportId ?? null,
      ...(p.disableInfo?.isDisabled ? { punish: true, punishReason: p.disableInfo.disableAddWording ?? null } : {}),
      platformName: '视频号',
    };
  });

  const t = raw.fansTrend?.data ?? {};
  const t0 = raw.fansTrend?.startTs ?? start;
  const account = {
    uid, loginStatus: loggedIn ? '登录有效' : '登录失效', fans: num(fu?.fansCount), updateTime: cst(now),
    daily: (t.total ?? []).map((v, i) => ({ date: cstDate(t0 + i * DAY), fansTotal: num(v), fansNet: num(t.netAdd?.[i]), fansAdd: num(t.add?.[i]), fansDrop: num(t.reduce?.[i]) })),
  };

  const stats = {
    pages: (raw.postList ?? []).length,
    http: { auth: raw.auth?.http ?? null, postList: (raw.postList ?? []).map((x) => x.http), fansTrend: raw.fansTrend?.http ?? null },
    errCode: { auth: raw.auth?.errCode ?? null, postList: (raw.postList ?? []).map((x) => x.errCode), fansTrend: raw.fansTrend?.errCode ?? null },
    total: raw.postList?.[0]?.data?.totalCount ?? null, feedsCountAllTime: num(fu?.feedsCount), fetched: items.length, inWindow: posts.length,
    hitMaxPages: raw.hitMaxPages ?? false,
  };
  return { loggedIn, uidSeen: uid, posts, account, stats };
}
