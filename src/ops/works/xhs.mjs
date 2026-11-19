// 小红书：近 N 天笔记 + 指标、粉丝总数和分日粉丝。读法和字段对照见 spikes/results/06-works.md「小红书」，
// 请求、签名、翻页照搬 spikes/platform/06-works-xhs.mjs（2026-11-19 实测）。
// 两个作品列表接口直接 fetch 会 406，要带 X-s/X-t：用页面自己的 window._webmsxyw 在 page.evaluate 里现算、在页面里 fetch，
// 签名不出页面。粉丝三个接口不用签名。fetchRaw 在 Ego space 里跑；map 是宿主侧纯函数。
import { DAY, cst, cstMs, cstDate, cstDay0, num, pick } from './fmt.mjs';

export const PLATFORM = 'XiaoHongShu';
export const START_URL = 'https://creator.xiaohongshu.com/new/note-manager';
export const SETTLE_MS = 8000;
const PAGE_GAP_MS = 2500;
const MAX_ANALYZE_PAGES = 10;   // 每页 10 条
const MAX_POSTED_PAGES = 5;

// 时间窗：东八区当天 0 点往前 N 天，到今天 23:59:59（页面「近30天」就是这样传的毫秒时间戳）
const windowOf = (days, nowMs) => {
  const today0 = cstDay0(Math.floor(nowMs / 1000)) * 1000;
  return { begin: today0 - days * DAY * 1000, end: today0 + DAY * 1000 - 1000 };
};

// 在页面里算签名并 fetch；只把响应带回来，签名头不回传
const signedGet = (page, path) => page.evaluate(async (p) => {
  if (typeof window._webmsxyw !== 'function') return { error: '页面没有 _webmsxyw' };
  const s = window._webmsxyw(p, undefined);
  const r = await fetch(p, { credentials: 'include', headers: { 'X-s': s['X-s'], 'X-t': String(s['X-t']) } });
  const t = await r.text();
  try { return { http: r.status, json: JSON.parse(t) }; } catch { return { http: r.status }; }
}, path);

async function get(page, url) {
  const r = await page.fetch(url, { timeout: 15000 });
  let json = null;
  try { json = JSON.parse(r.body); } catch {}
  return { http: r.status, json };
}

const NOTE_KEYS = ['id', 'title', 'type', 'audit_status', 'post_time', 'cover_url', 'imp_count', 'read_count', 'like_count', 'comment_count', 'fav_count', 'share_count', 'increase_fans_count', 'view_time_avg', 'coverClickRate', 'danmaku_count'];
// xsec_token 不进 raw：url 不带它，也免得被谁落盘
const POSTED_KEYS = ['id', 'sticky', 'time', 'permission_code', 'permission_msg', 'tab_status', 'schedule_post_time'];
const head = (r) => ({ http: r.http ?? null, code: r.json?.code ?? null, ...(r.error ? { error: r.error } : {}) });

export async function fetchRaw(page, { days, nowMs, sleep }) {
  const url = await page.url();
  const raw = { atLoginPage: /\/login/.test(url) };
  if (raw.atLoginPage) return raw;

  const { begin, end } = windowOf(days, nowMs);
  const analyzeUrl = (n) => `/api/galaxy/creator/datacenter/note/analyze/list?post_begin_time=${begin}&post_end_time=${end}&type=0&page_size=10&page_num=${n}`;
  raw.analyze = [];
  let got = 0;
  for (let n = 1; n <= MAX_ANALYZE_PAGES; n++) {
    if (n > 1) await sleep(PAGE_GAP_MS);
    const r = await signedGet(page, analyzeUrl(n));
    const d = r.json?.data;
    const notes = (d?.note_infos ?? []).map((x) => pick(x, NOTE_KEYS));
    raw.analyze.push({ ...head(r), data: { total: d?.total ?? null, note_infos: notes } });
    got += notes.length;
    // data.total 是窗口内总数，按 page_num 翻到够数
    if (!notes.length || got >= (d?.total ?? 0)) break;
  }

  // 笔记管理列表（状态、定时发布）：page 从 0 起，翻到早于窗口为止；置顶笔记排最前，判断时跳过
  raw.posted = [];
  for (let n = 0; n < MAX_POSTED_PAGES; n++) {
    await sleep(PAGE_GAP_MS);
    const r = await signedGet(page, `/api/galaxy/v2/creator/note/user/posted?tab=0&page=${n}`);
    const list = (r.json?.data?.notes ?? []).map((x) => pick(x, POSTED_KEYS));
    raw.posted.push({ ...head(r), data: { notes: list } });
    if (!list.length || list.some((x) => !x.sticky && Date.parse(`${String(x.time).replace(' ', 'T')}+08:00`) < begin)) break;
  }

  await sleep(PAGE_GAP_MS);
  const ui = await get(page, '/api/galaxy/user/info');
  raw.userInfo = { ...head(ui), data: ui.json?.data ? pick(ui.json.data, ['userId', 'userName']) : null };
  await sleep(PAGE_GAP_MS);
  const pi = await get(page, '/api/galaxy/creator/home/personal_info');
  raw.personalInfo = { ...head(pi), data: pi.json?.data ? pick(pi.json.data, ['name', 'fans_count']) : null };
  await sleep(PAGE_GAP_MS);
  const fo = await get(page, '/api/galaxy/creator/data/fans/overall_new');
  const t = fo.json?.data?.thirty;
  raw.fans = { ...head(fo), data: { thirty: t ? pick(t, ['fans_count', 'fans_list', 'rise_fans_list', 'leave_fans_list']) : null } };
  return raw;
}

export function map(raw, { days, nowMs }) {
  const { begin } = windowOf(days, nowMs);
  const loggedIn = !raw.atLoginPage && raw.personalInfo?.code === 0;
  const uid = raw.userInfo?.data?.userId ?? null;
  const name = raw.personalInfo?.data?.name ?? raw.userInfo?.data?.userName ?? null;
  const notes = (raw.analyze ?? []).flatMap((x) => x.data?.note_infos ?? []);
  const postedById = new Map((raw.posted ?? []).flatMap((x) => x.data?.notes ?? []).map((x) => [x.id, x]));

  const posts = notes.filter((x) => x.post_time >= begin).map((x) => {
    const p = postedById.get(x.id);
    const published = x.audit_status === 1;
    const isVideo = x.type === 2;
    return {
      postId: x.id, uid, platform: PLATFORM, account: name,
      // 两个列表接口都没有正文
      title: x.title ?? null, desc: null, cover: x.cover_url ?? null,
      postType: isVideo ? '视频' : '图文', postTypeCode: isVideo ? '1' : '2',
      publishStatus: published ? 'published' : 'unknown', statusText: published ? '已发布' : `audit_status=${x.audit_status}`,
      status: x.audit_status == null ? null : String(x.audit_status),
      // 小红书是毫秒
      postTime: cstMs(x.post_time), timing: p?.schedule_post_time ? cstMs(p.schedule_post_time) : null,
      url: `https://www.xiaohongshu.com/explore/${x.id}`,
      show: num(x.imp_count), view: num(x.read_count), like: num(x.like_count), comment: num(x.comment_count),
      favorite: num(x.fav_count), forward: num(x.share_count), fansAdd: num(x.increase_fans_count), viewTime: num(x.view_time_avg),
      // 数据看板没有完播率
      fullView: null,
      coverClickRate: num(x.coverClickRate), danmu: num(x.danmaku_count),
      permission: p ? { code: p.permission_code ?? null, msg: p.permission_msg ?? null, tab: p.tab_status ?? null } : null,
      platformName: '小红书',
    };
  });

  const t30 = raw.fans?.data?.thirty ?? {};
  const rise = new Map((t30.rise_fans_list ?? []).map((x) => [x.date, num(x.count)]));
  const leave = new Map((t30.leave_fans_list ?? []).map((x) => [x.date, num(x.count)]));
  const account = {
    uid, loginStatus: loggedIn ? '登录有效' : '登录失效',
    fans: num(raw.personalInfo?.data?.fans_count ?? t30.fans_count), updateTime: cst(Math.floor(nowMs / 1000)),
    daily: (t30.fans_list ?? []).map((x) => {
      const r = rise.get(x.date) ?? null;
      const l = leave.get(x.date) ?? null;
      // date 是东八区 0 点的毫秒
      return { date: cstDate(x.date / 1000), fansTotal: num(x.count), fansNet: r != null && l != null ? r - l : null, fansRise: r, fansLeave: l };
    }),
  };

  const stats = {
    atLoginPage: !!raw.atLoginPage,
    pages: { analyze: (raw.analyze ?? []).length, posted: (raw.posted ?? []).length },
    http: { analyze: (raw.analyze ?? []).map((x) => x.http), posted: (raw.posted ?? []).map((x) => x.http), userInfo: raw.userInfo?.http ?? null, personalInfo: raw.personalInfo?.http ?? null, fans: raw.fans?.http ?? null },
    code: { analyze: (raw.analyze ?? []).map((x) => x.code), posted: (raw.posted ?? []).map((x) => x.code), userInfo: raw.userInfo?.code ?? null, personalInfo: raw.personalInfo?.code ?? null, fans: raw.fans?.code ?? null },
    errors: [...(raw.analyze ?? []), ...(raw.posted ?? [])].map((x) => x.error).filter(Boolean),
    total: raw.analyze?.[0]?.data?.total ?? null, fetched: notes.length, inWindow: posts.length,
    postedMatched: posts.filter((p) => p.permission).length,
  };
  return { loggedIn, uidSeen: uid, posts, account, stats };
}
