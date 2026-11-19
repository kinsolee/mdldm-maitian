// B站：近 N 天稿件 + 指标、粉丝总数和分日粉丝。读法和字段对照见 spikes/results/06-works.md「B站」，
// 请求、翻页、停止条件照搬 spikes/platform/06-works-bili.mjs（2026-11-19 实测）。
// 都在 member.bilibili.com 页面里同源 GET，带 cookie，不用 w_rid 签名。fetchRaw 在 Ego space 里跑；map 是宿主侧纯函数。
import { DAY, cst, cstDate, num, pick, pageProblem, idOf, missingIdProblem } from './fmt.mjs';

export const PLATFORM = 'Bili';
export const START_URL = 'https://member.bilibili.com/platform/home';
export const SETTLE_MS = 6000;
const PAGE_GAP_MS = 2500;
// 每页 20 条，10 页 200 条
const MAX_PAGES = 10;

async function get(page, url, opts = {}) {
  const r = await page.fetch(url, { timeout: 15000, ...opts });
  let json = null;
  try { json = JSON.parse(r.body); } catch {}
  return { http: r.status, json };
}

const ARC_KEYS = ['bvid', 'mid', 'title', 'desc', 'cover', 'state', 'state_desc', 'duration', 'ptime', 'dtime', 'ctime'];
const STAT_KEYS = ['view', 'like', 'reply', 'favorite', 'share', 'coin', 'danmaku'];
const CMP_KEYS = ['full_play_ratio', 'total_new_attention_cnt', 'unfollow'];

export async function fetchRaw(page, { days, nowMs, sleep }) {
  const nav = await get(page, 'https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' });
  const raw = { nav: { http: nav.http, code: nav.json?.code ?? null, data: nav.json?.data ? pick(nav.json.data, ['isLogin', 'mid', 'uname']) : null } };
  if (!nav.json?.data?.isLogin) return raw;

  const since = Math.floor(nowMs / 1000) - days * DAY;
  raw.archives = [];
  raw.hitMaxPages = true;
  for (let pn = 1; pn <= MAX_PAGES; pn++) {
    await sleep(PAGE_GAP_MS);
    const r = await get(page, `/x/web/archives?status=is_pubing,pubed,not_pubed&pn=${pn}&ps=20&coop=1&interactive=1`);
    const d = r.json?.data;
    const list = d?.arc_audits ?? [];
    // 没有 data 记 null、没有 arc_audits 记 null（不是 []），map 据此判断这页没读成功
    raw.archives.push({
      http: r.http, code: r.json?.code ?? null,
      data: d ? { class: d.class ?? null, page: d.page ?? null, arc_audits: Array.isArray(d.arc_audits) ? list.map((x) => ({ Archive: pick(x.Archive, ARC_KEYS), stat: pick(x.stat, STAT_KEYS) })) : null } : null,
    });
    // 按 ptime 倒序；定时稿 ptime=0，不参与「早于窗口」判断
    const pager = d?.page;
    if (!list.length || list.some((x) => x.Archive?.ptime > 0 && x.Archive.ptime < since) || (pager && pn * pager.ps >= pager.count)) { raw.hitMaxPages = false; break; }
  }

  // 数据中心「近期稿件对比」：单稿涨粉、平均播放进度。size=30 一次给全（稿件更多时能不能翻页没测过）
  await sleep(PAGE_GAP_MS);
  const cmp = await get(page, '/x/web/data/archive_diagnose/compare?size=30');
  raw.compare = { http: cmp.http, code: cmp.json?.code ?? null, data: Array.isArray(cmp.json?.data?.list) ? { list: cmp.json.data.list.map((x) => ({ bvid: x.bvid, stat: pick(x.stat, CMP_KEYS) })) } : null };
  await sleep(PAGE_GAP_MS);
  const graph = await get(page, '/x/web/data/v2/fans/stat/graph?type=all_fans&period=1');
  raw.fansGraph = { http: graph.http, code: graph.json?.code ?? null, data: Array.isArray(graph.json?.data?.tendency) ? { tendency: graph.json.data.tendency.map((t) => pick(t, ['date_key', 'total_inc'])) } : null };
  await sleep(PAGE_GAP_MS);
  const fnum = await get(page, '/x/web/data/v2/fans/stat/num?period=1');
  raw.fansNum = { http: fnum.http, code: fnum.json?.code ?? null, data: fnum.json?.data ? pick(fnum.json.data, ['all_fans']) : null };
  return raw;
}

const STATE = { 0: ['published', '已发布'], '-6': ['reviewing', '审核中'], '-30': ['reviewing', '审核中'], '-40': ['timing', '定时发布'] };

export function map(raw, { days, nowMs }) {
  const now = Math.floor(nowMs / 1000);
  const since = now - days * DAY;
  const nav = raw.nav?.data ?? {};
  const loggedIn = raw.nav?.code === 0 && nav.isLogin === true;
  const uid = nav.mid != null ? String(nav.mid) : null;
  const arcs = (raw.archives ?? []).flatMap((p) => p.data?.arc_audits ?? []);
  const cmpBy = new Map((raw.compare?.data?.list ?? []).map((x) => [x.bvid, x.stat]));

  // 未发布的定时稿 ptime=0：发布时间回退到定时时间 dtime，再回退投稿时间 ctime（refresh.py 遇到空 postTime 会抛错）
  const postSec = (a) => a.ptime || a.dtime || a.ctime;
  const posts = arcs.filter(({ Archive: a }) => postSec(a) >= since || a.dtime > now).map(({ Archive: a, stat: s }) => {
    const postId = idOf(a.bvid);
    const c = postId ? cmpBy.get(postId) : undefined;
    const [publishStatus, statusText] = STATE[a.state] ?? ['unknown', a.state_desc || `state=${a.state}`];
    const ratio = num(c?.full_play_ratio);
    return {
      postId, uid: a.mid != null ? String(a.mid) : uid, platform: PLATFORM, account: nav.uname ?? null,
      title: a.title ?? null, desc: a.desc ?? null, cover: a.cover ?? null,
      postType: '视频', postTypeCode: '1', publishStatus, statusText, status: a.state == null ? null : String(a.state),
      postTime: cst(postSec(a)), timing: a.dtime > now ? cst(a.dtime) : null,
      url: postId && `https://www.bilibili.com/video/${postId}`,
      view: num(s?.view), like: num(s?.like), comment: num(s?.reply), favorite: num(s?.favorite), forward: num(s?.share),
      fansAdd: num(c?.total_new_attention_cnt), fansDrop: num(c?.unfollow),
      danmu: num(s?.danmaku), coin: num(s?.coin),
      // full_play_ratio 是「平均播放进度」（万分比），乘时长就是平均观看秒数（avg_play_time 恒为 0 不能用）；
      // 它不是完播率，B站不给完播率，fullView 写 null
      viewTime: ratio != null && a.duration != null ? Math.round((ratio / 10000) * a.duration) : null,
      fullView: null,
      playProgress: ratio != null ? ratio / 100 : null,
      platformName: '哔哩哔哩',
    };
  });

  // 稿件列表任一页没读成功、或翻到上限还没停，都不算完整。没有稿件时 arc_audits 可能是 null 而 page.count=0，这算读成功。
  // compare 和粉丝接口失败不影响 complete：作品照出，对应值为 null，在 stats 里写明
  const arcsOk = (d) => !!d && (Array.isArray(d.arc_audits) || d.page?.count === 0);
  const incomplete = !loggedIn ? '没登录，没读稿件列表'
    : !raw.archives?.length ? 'archives 没读'
    : raw.archives.map((p, i) => pageProblem('archives', i, p, arcsOk(p.data))).find(Boolean)
      ?? missingIdProblem('archives', 'bvid', posts)
      ?? (raw.hitMaxPages ? `archives 翻到 ${MAX_PAGES} 页上限还没到窗口起点` : null);
  const sideProblem = (api, r, ok) => (!r ? (loggedIn ? `${api} 没读` : null) : pageProblem(api, 0, r, ok));

  const tend = raw.fansGraph?.data?.tendency ?? [];
  const account = {
    uid, loginStatus: loggedIn ? '登录有效' : '登录失效', fans: num(raw.fansNum?.data?.all_fans), updateTime: cst(now),
    // total_inc 字段名像增量，实际是当天总数；净增是相邻两天相减，第一天没有前一天记 null
    daily: tend.map((t, i) => {
      const total = num(t.total_inc);
      const prev = i ? num(tend[i - 1].total_inc) : null;
      return { date: cstDate(t.date_key), fansTotal: total, fansNet: total != null && prev != null ? total - prev : null };
    }),
  };

  const stats = {
    pages: (raw.archives ?? []).length,
    http: { nav: raw.nav?.http ?? null, archives: (raw.archives ?? []).map((p) => p.http), compare: raw.compare?.http ?? null, fansGraph: raw.fansGraph?.http ?? null, fansNum: raw.fansNum?.http ?? null },
    code: { nav: raw.nav?.code ?? null, archives: (raw.archives ?? []).map((p) => p.code), compare: raw.compare?.code ?? null, fansGraph: raw.fansGraph?.code ?? null, fansNum: raw.fansNum?.code ?? null },
    class: raw.archives?.[0]?.data?.class ?? null, fetched: arcs.length, inWindow: posts.length,
    compareMatched: posts.filter((p) => cmpBy.has(p.postId)).length, hitMaxPages: raw.hitMaxPages ?? false,
    compareProblem: sideProblem('compare', raw.compare, Array.isArray(raw.compare?.data?.list)),
    fansProblems: [
      sideProblem('fans/stat/graph', raw.fansGraph, Array.isArray(raw.fansGraph?.data?.tendency)),
      sideProblem('fans/stat/num', raw.fansNum, raw.fansNum?.data?.all_fans != null),
    ].filter(Boolean),
  };
  return { loggedIn, complete: !incomplete, incomplete: incomplete || null, uidSeen: uid, posts, account, stats };
}
