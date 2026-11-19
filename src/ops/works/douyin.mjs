// 抖音：近 N 天作品 + 指标、粉丝总数和分日粉丝。读法和字段对照见 spikes/results/06-works.md「抖音」，
// 请求、翻页、停止条件照搬 spikes/platform/06-works-douyin.mjs（2026-11-19 实测）。
// fetchRaw 在 Ego space 里跑（只读 GET，不点任何东西）；map 是宿主侧纯函数。
import { DAY, cst, num, pct, parseBigIds, pick, pageProblem } from './fmt.mjs';

export const PLATFORM = 'Douyin';
export const START_URL = 'https://creator.douyin.com/creator-micro/content/manage';
export const SETTLE_MS = 6000;
const PAGE_GAP_MS = 2500;
// 每页 30 条；10 页够 300 条，近 30 天远用不完。到上限还没停会记在 stats.hitMaxPages
const MAX_PAGES = 10;

// 参数照页面自己的 prefetch.json，count 改成 30
const listUrl = (cursor) => `/janus/douyin/creator/pc/work_list?status=0&count=30&max_cursor=${cursor}&scene=star_atlas&device_platform=android&aid=1128`;

async function get(page, url) {
  const r = await page.fetch(url, { timeout: 20000 });
  let json = null;
  try { json = parseBigIds(r.body); } catch {}
  return { http: r.status, json };
}

// aweme 对象很大（音乐、贴纸、评论…），只留 map 用得着的键
const AWEME_KEYS = ['aweme_id', 'is_pinned', 'item_title', 'desc', 'create_time', 'aweme_type', 'status_value'];
const STAT_KEYS = ['play_count', 'digg_count', 'comment_count', 'collect_count', 'share_count'];
const METRIC_KEYS = ['subscribe_count', 'unsubscribe_count', 'homepage_visit_count', 'completion_rate', 'bounce_rate_2s', 'completion_rate_5s', 'avg_view_second', 'fan_view_proportion'];
const trimPage = ({ http, json: j }) => ({
  http, status_code: j?.status_code ?? null, total: j?.total ?? null, has_more: j?.has_more ?? null, max_cursor: j?.max_cursor ?? null,
  // 响应里没有 aweme_list 记 null（不是 []），map 据此判断这页没读成功
  aweme_list: !Array.isArray(j?.aweme_list) ? null : j.aweme_list.map((a) => ({
    ...pick(a, AWEME_KEYS), statistics: pick(a.statistics, STAT_KEYS),
    video: { cover: { url_list: (a.video?.cover?.url_list ?? []).slice(0, 1) } },
  })),
  items: (j?.items ?? []).map((x) => ({ id: String(x.id), metrics: pick(x.metrics, METRIC_KEYS) })),
});

export async function fetchRaw(page, { days, nowMs, sleep }) {
  // 先看登录：没登录就不翻作品
  const info = await get(page, '/web/api/media/user/info/');
  const user = info.json?.user;
  const raw = { info: { http: info.http, status_code: info.json?.status_code ?? null, user: user ? pick(user, ['uid', 'nickname', 'follower_count']) : null } };
  if (info.json?.status_code !== 0) return raw;

  const since = Math.floor(nowMs / 1000) - days * DAY;
  raw.pages = [];
  let cursor = 0;
  raw.hitMaxPages = true;
  for (let i = 0; i < MAX_PAGES; i++) {
    if (i) await sleep(PAGE_GAP_MS);
    const p = trimPage(await get(page, listUrl(cursor)));
    raw.pages.push(p);
    const list = p.aweme_list ?? [];
    // 置顶作品 is_pinned=true（非置顶时没有这个键）排在第一页最前，发布时间可能很早，算「最早一条」时跳过；
    // 一页全是置顶时不据此停，看 has_more
    const unpinned = list.filter((a) => a.is_pinned !== true);
    const oldest = unpinned.length ? Math.min(...unpinned.map((a) => a.create_time)) : Infinity;
    if (!list.length || !p.has_more || oldest < since) { raw.hitMaxPages = false; break; }
    cursor = p.max_cursor;
  }

  await sleep(PAGE_GAP_MS);
  const fans = await get(page, `/janus/douyin/creator/data/overview/dashboard/fans?recent_days=${days}`);
  raw.fans = {
    http: fans.http, status_code: fans.json?.status_code ?? null,
    metrics: (fans.json?.metrics ?? []).map((m) => pick(m, ['english_metric_name', 'metric_value', 'trends'])),
  };
  return raw;
}

// 102 已发布；144 页面显示「不适宜公开」；其它没见过，一律 unknown（和小V猫一致）
const STATUS = { 102: ['published', '已发布'] };
const ymd = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

export function map(raw, { days, nowMs }) {
  const now = Math.floor(nowMs / 1000);
  const since = now - days * DAY;
  const user = raw.info?.user ?? {};
  const loggedIn = raw.info?.status_code === 0;
  const uid = user.uid != null ? String(user.uid) : null;
  const pages = raw.pages ?? [];
  const aweme = pages.flatMap((p) => p.aweme_list ?? []);
  const items = new Map(pages.flatMap((p) => p.items ?? []).map((x) => [String(x.id), x]));

  // 置顶的老作品靠窗口过滤自然排除
  const posts = aweme.filter((a) => a.create_time >= since).map((a) => {
    const m = items.get(a.aweme_id)?.metrics ?? {};
    const st = a.statistics ?? {};
    const [publishStatus, statusText] = STATUS[a.status_value] ?? ['unknown', '状态未知'];
    const isImage = a.aweme_type === 68;
    return {
      postId: a.aweme_id, uid, platform: PLATFORM, account: user.nickname ?? null,
      title: a.item_title || (a.desc || '').split(/\s#/)[0], desc: a.desc ?? null,
      cover: a.video?.cover?.url_list?.[0] ?? null,
      postType: isImage ? '图文' : '视频', postTypeCode: isImage ? '2' : '1',
      publishStatus, statusText, status: a.status_value == null ? null : String(a.status_value),
      postTime: cst(a.create_time), timing: a.create_time > now ? cst(a.create_time) : null,
      url: `https://www.douyin.com/video/${a.aweme_id}`,
      view: num(st.play_count), like: num(st.digg_count), comment: num(st.comment_count), favorite: num(st.collect_count),
      // 小V猫的 forward 就是 share_count（11 条逐条对上）；forward_count 恒为 0
      forward: num(st.share_count),
      fansAdd: num(m.subscribe_count), fansDrop: num(m.unsubscribe_count), homeVisit: num(m.homepage_visit_count),
      // view2s 是小V猫起的名字，值是 2 秒跳出率
      fullView: pct(m.completion_rate), view2s: pct(m.bounce_rate_2s), view5s: pct(m.completion_rate_5s),
      viewTime: num(m.avg_view_second), fansViewRate: pct(m.fan_view_proportion),
      platformName: '抖音',
    };
  });

  // 作品列表任一页没读成功、或翻到上限还没停，都不算完整；粉丝接口失败不影响 complete
  const incomplete = !loggedIn ? '没登录，没读作品列表'
    : !raw.pages?.length ? 'work_list 没读'
    : pages.map((p, i) => pageProblem('work_list', i, { http: p.http, code: p.status_code }, Array.isArray(p.aweme_list))).find(Boolean)
      ?? (raw.hitMaxPages ? `work_list 翻到 ${MAX_PAGES} 页上限还没到窗口起点` : null);

  const metric = (name) => (raw.fans?.metrics ?? []).find((x) => x.english_metric_name === name);
  const net = new Map((metric('net_fans_cnt')?.trends ?? []).map((t) => [t.date_time, t.value]));
  const account = {
    uid, loginStatus: loggedIn ? '登录有效' : '登录失效',
    // user/info 是实时数；dashboard/fans 的 total 是昨天的
    fans: num(user.follower_count), updateTime: cst(now),
    daily: (metric('total_fans_cnt')?.trends ?? []).map((t) => ({ date: ymd(String(t.date_time)), fansTotal: num(t.value), fansNet: num(net.get(t.date_time)) })),
  };

  const stats = {
    pages: pages.length, http: { info: raw.info?.http ?? null, list: pages.map((p) => p.http), fans: raw.fans?.http ?? null },
    code: { info: raw.info?.status_code ?? null, list: pages.map((p) => p.status_code), fans: raw.fans?.status_code ?? null },
    totalAllTime: pages[0]?.total ?? null, fetched: aweme.length, inWindow: posts.length,
    itemsMatched: posts.filter((p) => items.has(p.postId)).length, hitMaxPages: raw.hitMaxPages ?? false,
    fansProblems: [
      raw.info?.status_code !== 0 && 'user/info 没读成功，fans 为 null',
      raw.fans && pageProblem('dashboard/fans', 0, { http: raw.fans.http, code: raw.fans.status_code }, true),
      !raw.fans && loggedIn && 'dashboard/fans 没读，daily 为空',
    ].filter(Boolean),
  };
  return { loggedIn, complete: !incomplete, incomplete: incomplete || null, uidSeen: uid, posts, account, stats };
}
