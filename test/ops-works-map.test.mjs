// S3 四平台作品和粉丝采集：fmt 换算、各平台 map（纯函数）、fetchRaw（假 page）、平台索引。
// 对照来源：spikes/results/06-works.md 和 spikes/results/samples/06-*-works.json 的 mapped。不连真实平台。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as fmt from '../src/ops/works/fmt.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const sample = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, `spikes/results/samples/06-${name}-works.json`), 'utf8'));
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, `test/fixtures/works/${name}.json`), 'utf8'));
// 东八区时间串 → 毫秒（测试里给 nowMs 用）
const cstMs = (s) => Date.parse(`${s.replace(' ', 'T')}+08:00`);

describe('fmt 换算', () => {
  test('秒 / 毫秒 → 东八区 YYYY-MM-DD HH:mm:ss，空值 → null', () => {
    assert.equal(fmt.cst(1794887817), '2026-11-17 11:56:57');
    assert.equal(fmt.cstMs(1794887838000), '2026-11-17 11:57:18');
    assert.equal(fmt.cst(0), null);
    assert.equal(fmt.cst(null), null);
    assert.equal(fmt.cstMs(undefined), null);
  });

  test('东八区日期', () => {
    assert.equal(fmt.cstDate(1792425600), '2026-10-20');        // B站 date_key 是东八区 0 点
    assert.equal(fmt.cstDate(1792425600 - 1), '2026-10-19');
  });

  test('东八区当天 0 点（秒）', () => {
    assert.equal(fmt.cstDay0(cstMs('2026-11-19 00:30:00') / 1000), cstMs('2026-11-19 00:00:00') / 1000);
    assert.equal(fmt.cstDay0(cstMs('2026-11-18 23:59:59') / 1000), cstMs('2026-11-18 00:00:00') / 1000);
  });

  test('时间换算不受本机 TZ 影响', () => {
    const old = process.env.TZ;
    try {
      for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo', 'Asia/Taipei']) {
        process.env.TZ = tz;
        assert.equal(fmt.cst(1794887817), '2026-11-17 11:56:57', tz);
        assert.equal(fmt.cstDate(1792425600), '2026-10-20', tz);
      }
    } finally {
      if (old === undefined) delete process.env.TZ; else process.env.TZ = old;
    }
  });

  test('0–1 小数 → 百分数，保留 4 位小数；空值 → null', () => {
    assert.equal(fmt.pct('0.047969'), 4.7969);
    assert.equal(fmt.pct(0.12897822445561138), 12.8978);
    assert.equal(fmt.pct('0'), 0);
    assert.equal(fmt.pct(''), null);
    assert.equal(fmt.pct(null), null);
    assert.equal(fmt.pct(undefined), null);
  });

  test('字符串数字 → 数字；null / 空串 / 缺失 / 非数字 → null，不是 0', () => {
    assert.equal(fmt.num('13.844842'), 13.844842);
    assert.equal(fmt.num('0'), 0);
    assert.equal(fmt.num(5), 5);
    assert.equal(fmt.num(''), null);
    assert.equal(fmt.num(null), null);
    assert.equal(fmt.num(undefined), null);
    assert.equal(fmt.num('abc'), null);
  });

  test('抖音超 2^53 的 id 按字符串解析，不丢精度', () => {
    const text = '{"items":[{"id":7708984451971452170,"user_id":106707338905}],"aweme_list":[{"aweme_id":"7708984451971452170"}]}';
    assert.notEqual(String(JSON.parse(text).items[0].id), '7708984451971452170');   // 直接 parse 会丢精度
    const j = fmt.parseBigIds(text);
    assert.equal(j.items[0].id, '7708984451971452170');
    assert.equal(j.items[0].user_id, 106707338905);
    assert.equal(j.aweme_list[0].aweme_id, '7708984451971452170');
  });
});

// 假 page：按 URL 正则回预设响应（对象会被 JSON.stringify，字符串原样当 body），记下每次请求
function fakePage({ url = 'https://example.invalid/', routes = [], evaluate } = {}) {
  const calls = [];
  return {
    calls,
    url: async () => url,
    fetch: async (u, opts = {}) => {
      calls.push({ url: u, opts });
      const r = routes.find(([re]) => re.test(u));
      if (!r) return { status: 404, body: 'not found' };
      const res = typeof r[1] === 'function' ? r[1](u, opts, calls) : r[1];
      return { status: res.status ?? 200, body: typeof res.body === 'string' ? res.body : JSON.stringify(res.body) };
    },
    evaluate: async (fn, arg) => { calls.push({ evaluate: arg }); return evaluate(arg, fn); },
  };
}
const fakeSleep = () => { const waits = []; return { waits, sleep: async (ms) => { waits.push(ms); } }; };
const ORDER = (o) => Object.keys(o);

describe('抖音', async () => {
  const dy = await import('../src/ops/works/douyin.mjs');
  const S = sample('douyin');
  const fx = fixture('douyin-account');
  const nowMs = cstMs('2026-11-19 14:50:13');
  const rawOf = (pages, more = {}) => ({ info: fx.info, pages, fans: fx.fans, ...more });

  test('样例 raw → 和样例 mapped 一致；置顶的 2025 年老作品被窗口过滤', () => {
    const r = dy.map(rawOf([{ http: 200, ...S.raw.work_list }]), { days: 30, nowMs });
    assert.equal(r.loggedIn, true);
    assert.equal(r.uidSeen, '106707338905');
    assert.equal(r.posts.length, 1);
    assert.deepEqual(r.posts[0], S.mapped.posts[0]);
    assert.deepEqual(ORDER(r.posts[0]), ORDER(S.mapped.posts[0]));
    assert.deepEqual(r.account, S.mapped.account);
    assert.equal(r.stats.inWindow, 1);
    assert.equal(r.stats.totalAllTime, 88);
  });

  test('status_value=144 →「状态未知」/unknown；102 正好是「已发布」', () => {
    const a = structuredClone(S.raw.work_list);
    a.aweme_list[1].status_value = 144;
    const [p] = dy.map(rawOf([a]), { days: 30, nowMs }).posts;
    assert.equal(p.statusText, '状态未知');
    assert.equal(p.publishStatus, 'unknown');
    assert.equal(p.status, '144');
  });

  test('缺 items 指标、缺 statistics → null 不是 0；forward 取 share_count', () => {
    const a = structuredClone(S.raw.work_list);
    a.items = [];
    a.aweme_list[1].statistics = { share_count: 3, forward_count: 0 };
    const [p] = dy.map(rawOf([a]), { days: 30, nowMs }).posts;
    for (const k of ['view', 'like', 'comment', 'favorite', 'fansAdd', 'fansDrop', 'homeVisit', 'fullView', 'view2s', 'view5s', 'viewTime', 'fansViewRate']) assert.equal(p[k], null, k);
    assert.equal(p.forward, 3);
  });

  test('窗口外的作品被过滤；postTime 不为空', () => {
    const a = structuredClone(S.raw.work_list);
    a.aweme_list[1].create_time = Math.floor(nowMs / 1000) - 31 * 86400;
    assert.equal(dy.map(rawOf([a]), { days: 30, nowMs }).posts.length, 0);
    assert.equal(dy.map(rawOf([a]), { days: 40, nowMs }).posts[0].postTime.length, 19);
  });

  test('未登录（status_code≠0）→ loggedIn=false、loginStatus 不是「登录有效」', () => {
    const r = dy.map({ info: { http: 200, status_code: 8, user: null } }, { days: 30, nowMs });
    assert.equal(r.loggedIn, false);
    assert.equal(r.uidSeen, null);
    assert.deepEqual(r.posts, []);
    assert.notEqual(r.account.loginStatus, '登录有效');
  });

  test('时间换算不受 TZ 影响（map 整体）', () => {
    const old = process.env.TZ;
    try {
      process.env.TZ = 'America/New_York';
      const a = dy.map(rawOf([S.raw.work_list]), { days: 30, nowMs });
      process.env.TZ = 'Asia/Taipei';
      assert.deepEqual(dy.map(rawOf([S.raw.work_list]), { days: 30, nowMs }), a);
    } finally {
      if (old === undefined) delete process.env.TZ; else process.env.TZ = old;
    }
  });

  describe('fetchRaw', () => {
    const now = Math.floor(nowMs / 1000);
    const aw = (id, t, extra = {}) => ({ aweme_id: id, item_title: `t${id}`, desc: 'd', create_time: t, aweme_type: 4, status_value: 102, statistics: { play_count: 1, share_count: 0 }, video: { cover: { url_list: ['https://example.invalid/cover.webp'] } }, music: { huge: 'x'.repeat(1000) }, ...extra });
    // body 用原始文本，items[].id 是超过 2^53 的裸数字
    const listBody = (list, more, cursor) => `{"status_code":0,"total":88,"has_more":${more},"max_cursor":${cursor},"aweme_list":${JSON.stringify(list)},"items":[${list.map((a) => `{"id":${a.aweme_id},"metrics":{"subscribe_count":"1","cover_show":"9"}}`).join(',')}]}`;
    const routes = (pages) => [
      [/user\/info/, { body: { status_code: 0, user: { uid: 106707338905, nickname: 'n', follower_count: 1, phone: 'x' } } }],
      [/work_list/, (u) => { const c = Number(new URL(u, 'https://x.invalid').searchParams.get('max_cursor')); return { body: pages[c] }; }],
      [/dashboard\/fans/, { body: { status_code: 0, metrics: [] } }],
    ];

    test('翻页用 max_cursor；置顶老作品不触发停止；页里最早的非置顶早于窗口就停；间隔用传入的 sleep', async () => {
      const pages = {
        0: listBody([aw('7510302804091669771', 1748629314, { is_pinned: true }), aw('7708984451971452170', now - 86400)], true, 111),
        111: listBody([aw('7708984451971452171', now - 2 * 86400), aw('7708984451971452172', now - 40 * 86400)], true, 222),
        222: listBody([aw('7708984451971452173', now - 50 * 86400)], false, 0),
      };
      const page = fakePage({ routes: routes(pages) });
      const { sleep, waits } = fakeSleep();
      const raw = await dy.fetchRaw(page, { days: 30, nowMs, sleep });
      const lists = page.calls.filter((c) => /work_list/.test(c.url));
      assert.equal(lists.length, 2);
      assert.match(lists[1].url, /max_cursor=111/);
      assert.ok(waits.filter((ms) => ms === 2500).length >= 1, '翻页之间用传入的 sleep 等 2.5 秒');
      assert.equal(raw.pages[1].items[0].id, '7708984451971452171');   // 大整数 id 没丢精度
      assert.equal(raw.pages[0].aweme_list[0].music, undefined);       // aweme 被裁剪
      assert.equal(raw.pages[0].items[0].metrics.cover_show, undefined);
      assert.equal(raw.info.user.phone, undefined);
      const r = dy.map(raw, { days: 30, nowMs });
      assert.deepEqual(r.posts.map((p) => p.postId), ['7708984451971452170', '7708984451971452171']);
      assert.equal(r.posts[0].fansAdd, 1);
      assert.equal(r.stats.hitMaxPages, false);
    });

    test('一页全是置顶时看 has_more 继续翻；has_more=false 就停', async () => {
      const pages = {
        0: listBody([aw('7510302804091669771', 1748629314, { is_pinned: true })], true, 5),
        5: listBody([aw('7708984451971452170', now - 86400)], false, 6),
      };
      const page = fakePage({ routes: routes(pages) });
      await dy.fetchRaw(page, { days: 30, nowMs, ...fakeSleep() });
      assert.equal(page.calls.filter((c) => /work_list/.test(c.url)).length, 2);
    });

    test('未登录：只读 user/info，不翻作品、不抛错', async () => {
      const page = fakePage({ routes: [[/user\/info/, { body: { status_code: 8 } }]] });
      const raw = await dy.fetchRaw(page, { days: 30, nowMs, ...fakeSleep() });
      assert.equal(page.calls.length, 1);
      assert.equal(dy.map(raw, { days: 30, nowMs }).loggedIn, false);
    });

    test('接口返回非 JSON（如登录页 HTML）不抛错', async () => {
      const page = fakePage({ routes: [[/user\/info/, { status: 302, body: '<html>login</html>' }]] });
      const raw = await dy.fetchRaw(page, { days: 30, nowMs, ...fakeSleep() });
      assert.equal(raw.info.http, 302);
      assert.equal(dy.map(raw, { days: 30, nowMs }).loggedIn, false);
    });
  });
});

// vcat posts-20261118.json 里各平台作品记录的键顺序（多出的平台专有字段可以插在中间，但这些键的先后不能乱）
const BASE = ['postId', 'uid', 'platform', 'account', 'title', 'desc', 'cover', 'postType', 'postTypeCode', 'publishStatus', 'statusText', 'status', 'postTime', 'timing', 'url'];
const VCAT_KEYS = {
  Douyin: [...BASE, 'view', 'like', 'comment', 'favorite', 'forward', 'fansAdd', 'fansDrop', 'homeVisit', 'fullView', 'view2s', 'view5s', 'viewTime', 'fansViewRate', 'platformName'],
  XiaoHongShu: [...BASE, 'show', 'view', 'like', 'comment', 'favorite', 'forward', 'fansAdd', 'viewTime', 'platformName'],
  Bili: [...BASE, 'view', 'like', 'comment', 'favorite', 'forward', 'fansAdd', 'fansDrop', 'danmu', 'coin', 'platformName'],
  Channels: [...BASE, 'view', 'like', 'comment', 'forward', 'love', 'fansAdd', 'fullView', 'viewTime', 'platformName'],
};
const assertVcatOrder = (post, code) => assert.deepEqual(Object.keys(post).filter((k) => VCAT_KEYS[code].includes(k)), VCAT_KEYS[code]);

test('抖音作品记录的键顺序照 vcat', async () => {
  const dy = await import('../src/ops/works/douyin.mjs');
  const fx = fixture('douyin-account');
  const r = dy.map({ ...fx, pages: [sample('douyin').raw.work_list] }, { days: 30, nowMs: cstMs('2026-11-19 14:50:13') });
  assertVcatOrder(r.posts[0], 'Douyin');
});

describe('B站', async () => {
  const bili = await import('../src/ops/works/bili.mjs');
  const S = sample('bili');
  const fx = fixture('bili-account');
  const nowMs = cstMs('2026-11-19 14:26:35');
  const rawOf = (archives = S.raw.archives) => ({ nav: fx.nav, archives: [archives], compare: S.raw.compare, fansGraph: fx.fansGraph, fansNum: S.raw.fansNum });
  const arcWith = (patch) => { const a = structuredClone(S.raw.archives); Object.assign(a.data.arc_audits[0].Archive, patch); return a; };
  const opts = { days: 30, nowMs };

  test('样例 raw → 和样例 mapped 一致；fullView 是 null（不拿播放进度顶）', () => {
    const r = bili.map(rawOf(), opts);
    assert.equal(r.loggedIn, true);
    assert.equal(r.uidSeen, '478358005');
    assert.equal(r.posts.length, 1);
    assert.deepEqual(r.posts[0], { ...S.mapped.posts[0], fullView: null });
    assertVcatOrder(r.posts[0], 'Bili');
    assert.equal(r.posts[0].viewTime, 27);   // 0.3856 × 69 秒
    assert.deepEqual({ ...r.account, daily: r.account.daily.slice(-2) }, S.mapped.account);
  });

  test('fansNet 相邻两天相减，第一天 null', () => {
    const { daily } = bili.map(rawOf(), opts).account;
    assert.deepEqual(daily[0], { date: '2026-11-16', fansTotal: 88, fansNet: null });
    assert.equal(daily[1].fansNet, 8);
  });

  test('定时稿 ptime=0：postTime 回退 dtime，timing 填 dtime，statusText「定时发布」', () => {
    const dtime = Math.floor(nowMs / 1000) + 2 * 86400;
    const [p] = bili.map(rawOf(arcWith({ ptime: 0, dtime, state: -40 })), opts).posts;
    assert.equal(p.postTime, fmt.cst(dtime));
    assert.equal(p.timing, fmt.cst(dtime));
    assert.equal(p.statusText, '定时发布');
    assert.equal(p.publishStatus, 'timing');
  });

  test('ptime=0 且没有 dtime → 回退 ctime，postTime 不为空', () => {
    const [p] = bili.map(rawOf(arcWith({ ptime: 0, dtime: 0, state: -6 })), opts).posts;
    assert.equal(p.postTime, '2026-11-17 11:56:09');
    assert.equal(p.statusText, '审核中');
  });

  test('state 其它值 → state_desc，没有 state_desc 就 state=<值>', () => {
    assert.equal(bili.map(rawOf(arcWith({ state: -2, state_desc: '已退回' })), opts).posts[0].statusText, '已退回');
    const [p] = bili.map(rawOf(arcWith({ state: -100, state_desc: '' })), opts).posts;
    assert.equal(p.statusText, 'state=-100');
    assert.equal(p.publishStatus, 'unknown');
  });

  test('compare 里没有这条 → fansAdd / viewTime / playProgress 是 null 不是 0', () => {
    const r = bili.map({ ...rawOf(), compare: { http: 200, code: 0, data: { list: [] } } }, opts);
    for (const k of ['fansAdd', 'fansDrop', 'viewTime', 'playProgress', 'fullView']) assert.equal(r.posts[0][k], null, k);
  });

  test('窗口外的稿件被过滤', () => {
    assert.equal(bili.map(rawOf(arcWith({ ptime: Math.floor(nowMs / 1000) - 31 * 86400 })), opts).posts.length, 0);
  });

  test('未登录 → loggedIn=false', () => {
    const r = bili.map({ nav: { http: 200, code: -101, data: { isLogin: false } } }, opts);
    assert.equal(r.loggedIn, false);
    assert.deepEqual(r.posts, []);
    assert.notEqual(r.account.loginStatus, '登录有效');
  });

  describe('fetchRaw', () => {
    const now = Math.floor(nowMs / 1000);
    const arc = (bvid, ptime) => ({ Archive: { bvid, mid: 478358005, title: bvid, state: 0, duration: 60, ptime, dtime: 0, ctime: ptime, tag: 'big', reject_reason: '' }, stat: { view: 1, like: 0, reply: 0, favorite: 0, share: 0, coin: 0, danmaku: 0, vv: 9 } });
    const routes = (byPn, count) => [
      [/web-interface\/nav/, { body: { code: 0, data: { isLogin: true, mid: 478358005, uname: 'u', wbi_img: { img_url: 'x' } } } }],
      [/\/x\/web\/archives/, (u) => { const pn = Number(new URL(u, 'https://x.invalid').searchParams.get('pn')); return { body: { code: 0, data: { page: { pn, ps: 20, count }, arc_audits: byPn[pn] ?? [] } } }; }],
      [/compare/, { body: { code: 0, data: { list: [] } } }],
      [/fans\/stat\/graph/, { body: { code: 0, data: { tendency: [] } } }],
      [/fans\/stat\/num/, { body: { code: 0, data: { all_fans: 101 } } }],
    ];

    test('翻到早于窗口为止；定时稿 ptime=0 不触发停止；每次请求前用传入的 sleep', async () => {
      const byPn = { 1: [arc('BV1', 0), arc('BV2', now - 86400)], 2: [arc('BV3', now - 2 * 86400), arc('BV4', now - 40 * 86400)], 3: [arc('BV5', now - 50 * 86400)] };
      const page = fakePage({ routes: routes(byPn, 100) });
      const { sleep, waits } = fakeSleep();
      const raw = await bili.fetchRaw(page, { days: 30, nowMs, sleep });
      assert.equal(page.calls.filter((c) => /\/x\/web\/archives/.test(c.url)).length, 2);
      assert.ok(waits.filter((ms) => ms === 2500).length >= 2);
      assert.equal(raw.archives[0].data.arc_audits[0].Archive.tag, undefined);   // 裁剪
      assert.equal(raw.nav.data.wbi_img, undefined);
      assert.equal(page.calls[0].opts.credentials, 'include');
    });

    test('翻够 page.count 就停', async () => {
      const byPn = { 1: Array.from({ length: 20 }, (_, i) => arc(`BV${i}`, now - 3600)), 2: [arc('BVx', now - 3600)] };
      const page = fakePage({ routes: routes(byPn, 21) });
      const raw = await bili.fetchRaw(page, { days: 30, nowMs, ...fakeSleep() });
      assert.equal(raw.archives.length, 2);
      assert.equal(bili.map(raw, { days: 30, nowMs }).posts.length, 21);
    });

    test('未登录：只读 nav', async () => {
      const page = fakePage({ routes: [[/web-interface\/nav/, { body: { code: -101, data: { isLogin: false } } }]] });
      const raw = await bili.fetchRaw(page, { days: 30, nowMs, ...fakeSleep() });
      assert.equal(page.calls.length, 1);
      assert.equal(bili.map(raw, { days: 30, nowMs }).loggedIn, false);
    });
  });
});

describe('小红书', async () => {
  const xhs = await import('../src/ops/works/xhs.mjs');
  const S = sample('xhs');
  const fx = fixture('xhs-account');
  const nowMs = cstMs('2026-11-19 14:26:09');
  const opts = { days: 30, nowMs };
  const rawOf = (analyze = S.raw.analyze) => ({
    atLoginPage: false, analyze: [analyze], posted: [{ http: 200, code: 0, data: { notes: [fx.postedNote] } }, S.raw.posted],
    userInfo: fx.userInfo, personalInfo: S.raw.personal_info, fans: fx.fans,
  });
  const noteWith = (patch) => { const a = structuredClone(S.raw.analyze); Object.assign(a.data.note_infos[0], patch); return a; };

  test('样例 raw → 和样例 mapped 一致；fullView 是 null；postTime 按毫秒换算', () => {
    const r = xhs.map(rawOf(), opts);
    assert.equal(r.loggedIn, true);
    assert.equal(r.uidSeen, '5944af205e87e701889da649');
    assert.equal(r.posts.length, 1);
    assert.deepEqual(r.posts[0], { ...S.mapped.posts[0], fullView: null });
    assertVcatOrder(r.posts[0], 'XiaoHongShu');
    assert.deepEqual(r.account, S.mapped.account);
  });

  test('fansNet = rise − leave；缺一边就是 null', () => {
    const fans = structuredClone(fx.fans);
    fans.data.thirty.leave_fans_list = [{ date: 1794758400000, count: 2 }];
    const { daily } = xhs.map({ ...rawOf(), fans }, opts).account;
    assert.equal(daily[0].fansNet, 1);
    assert.equal(daily[1].fansNet, null);
  });

  test('audit_status≠1 → statusText「audit_status=<值>」、unknown', () => {
    const [p] = xhs.map(rawOf(noteWith({ audit_status: 2 })), opts).posts;
    assert.equal(p.statusText, 'audit_status=2');
    assert.equal(p.publishStatus, 'unknown');
  });

  test('缺值 → null 不是 0', () => {
    const a = noteWith({});
    const n = a.data.note_infos[0];
    for (const k of ['imp_count', 'read_count', 'like_count', 'increase_fans_count', 'view_time_avg']) delete n[k];
    const [p] = xhs.map(rawOf(a), opts).posts;
    for (const k of ['show', 'view', 'like', 'fansAdd', 'viewTime']) assert.equal(p[k], null, k);
  });

  test('窗口外的笔记被过滤', () => {
    assert.equal(xhs.map(rawOf(noteWith({ post_time: cstMs('2026-10-19 23:59:59') })), opts).posts.length, 0);
    assert.equal(xhs.map(rawOf(noteWith({ post_time: cstMs('2026-10-20 00:00:00') })), opts).posts.length, 1);
  });

  test('未登录：跳到登录页或 personal_info code≠0 → loggedIn=false', () => {
    assert.equal(xhs.map({ atLoginPage: true }, opts).loggedIn, false);
    const r = xhs.map({ ...rawOf(), personalInfo: { http: 200, code: -100, data: null } }, opts);
    assert.equal(r.loggedIn, false);
    assert.notEqual(r.account.loginStatus, '登录有效');
  });

  describe('fetchRaw', () => {
    const note = (i, extra = {}) => ({ id: `n${i}`, title: `t${i}`, type: 2, audit_status: 1, post_time: nowMs - 86400_000, read_count: 1, cover_url: 'https://example.invalid/c.jpg', ...extra });
    // 签名在页面里算：真跑一遍传给 evaluate 的函数，给它假的 window._webmsxyw 和 fetch
    function signingPage({ analyzePages, posted, url = 'https://creator.xiaohongshu.com/new/note-manager', signer = true }) {
      const sent = [];
      const respond = (p) => {
        if (/analyze\/list/.test(p)) return analyzePages[Number(new URL(p, 'https://x.invalid').searchParams.get('page_num')) - 1] ?? { code: 0, data: { total: 0, note_infos: [] } };
        if (/user\/posted/.test(p)) return posted[Number(new URL(p, 'https://x.invalid').searchParams.get('page'))] ?? { code: 0, data: { notes: [] } };
        return { code: -1 };
      };
      const page = fakePage({
        url,
        routes: [
          [/user\/info/, { body: { code: 0, data: { userId: 'u1', userName: 'x' } } }],
          [/personal_info/, { body: { code: 0, data: { name: 'n', fans_count: 3, follow_count: 1 } } }],
          [/overall_new/, { body: { code: 0, data: { thirty: { fans_count: 3, fans_list: [], fans_list_iterator: [] } } } }],
        ],
        evaluate: async (arg, fn) => {
          const saved = { window: globalThis.window, fetch: globalThis.fetch };
          globalThis.window = signer ? { _webmsxyw: (p) => ({ 'X-s': `sig:${p}`, 'X-t': 123 }) } : {};
          globalThis.fetch = async (p, init) => { sent.push({ p, init }); return { status: 200, text: async () => JSON.stringify(respond(p)) }; };
          try { return await fn(arg); } finally { globalThis.window = saved.window; globalThis.fetch = saved.fetch; }
        },
      });
      return { page, sent };
    }

    test('analyze 按 data.total 翻够就停；请求带页面算的 X-s/X-t；签名不回到 raw；间隔用传入的 sleep', async () => {
      const analyzePages = [
        { code: 0, data: { total: 12, note_infos: Array.from({ length: 10 }, (_, i) => note(i)) } },
        { code: 0, data: { total: 12, note_infos: [note(10), note(11)] } },
      ];
      const posted = [{ code: 0, data: { notes: [{ id: 'n0', sticky: true, time: '2025-05-31 02:22', xsec_token: 'SECRET' }, { id: 'n1', time: '2026-09-01 10:00', schedule_post_time: 0 }] } }];
      const { page, sent } = signingPage({ analyzePages, posted });
      const { sleep, waits } = fakeSleep();
      const raw = await xhs.fetchRaw(page, { days: 30, nowMs, sleep });
      const an = sent.filter((s) => /analyze\/list/.test(s.p));
      assert.equal(an.length, 2);
      assert.equal(an[0].init.headers['X-s'], `sig:${an[0].p}`);
      assert.equal(an[0].init.headers['X-t'], '123');
      assert.match(an[0].p, new RegExp(`post_begin_time=${cstMs('2026-10-20 00:00:00')}&post_end_time=${cstMs('2026-11-19 23:59:59')}`));
      assert.equal(sent.filter((s) => /user\/posted/.test(s.p)).length, 1);   // 第一页非置顶的已早于窗口
      assert.ok(waits.filter((ms) => ms === 2500).length >= 2);
      const text = JSON.stringify(raw);
      assert.doesNotMatch(text, /sig:|SECRET|xsec/);
      assert.equal(xhs.map(raw, { days: 30, nowMs }).posts.length, 12);
    });

    test('置顶的老笔记不触发 posted 停止', async () => {
      const posted = [{ code: 0, data: { notes: [{ id: 'n0', sticky: true, time: '2025-05-31 02:22' }, { id: 'n1', time: '2026-11-18 10:00' }] } }, { code: 0, data: { notes: [] } }];
      const { sent, page } = signingPage({ analyzePages: [{ code: 0, data: { total: 1, note_infos: [note(1)] } }], posted });
      await xhs.fetchRaw(page, { days: 30, nowMs, ...fakeSleep() });
      assert.equal(sent.filter((s) => /user\/posted/.test(s.p)).length, 2);
    });

    test('页面没有 _webmsxyw：不抛错，错误放进 raw', async () => {
      const { page } = signingPage({ analyzePages: [], posted: [], signer: false });
      const raw = await xhs.fetchRaw(page, { days: 30, nowMs, ...fakeSleep() });
      assert.equal(raw.analyze[0].error, '页面没有 _webmsxyw');
      assert.deepEqual(xhs.map(raw, { days: 30, nowMs }).stats.errors.slice(0, 1), ['页面没有 _webmsxyw']);
    });

    test('跳到登录页：一个请求都不发', async () => {
      const { page, sent } = signingPage({ analyzePages: [], posted: [], url: 'https://creator.xiaohongshu.com/login' });
      const raw = await xhs.fetchRaw(page, { days: 30, nowMs, ...fakeSleep() });
      assert.equal(sent.length + page.calls.length, 0);
      assert.equal(xhs.map(raw, { days: 30, nowMs }).loggedIn, false);
    });
  });
});

describe('视频号', async () => {
  const ch = await import('../src/ops/works/channels.mjs');
  const S = sample('channels');
  const fx = fixture('channels-account');
  const nowMs = cstMs('2026-11-19 15:36:47');
  const opts = { days: 30, nowMs };
  const rawOf = (postList = S.raw.postList) => ({ auth: fx.auth, postList: [postList], fansTrend: fx.fansTrend });
  const itemWith = (patch) => { const a = structuredClone(S.raw.postList); Object.assign(a.data.list[0], patch); return a; };

  test('样例 raw → 和样例 mapped 一致；postId 是 objectNonce；favorite 是 null', () => {
    const r = ch.map(rawOf(), opts);
    assert.equal(r.loggedIn, true);
    assert.equal(r.uidSeen, '<uniqId>');
    assert.equal(r.posts.length, 1);
    assert.deepEqual(r.posts[0], { ...S.mapped.posts[0], favorite: null });
    assertVcatOrder(r.posts[0], 'Channels');
    assert.equal(r.posts[0].postId, '15958365167909027313');
    assert.equal(r.posts[0].objectId, '15056609950977166677');
    assert.deepEqual(r.account, S.mapped.account);
  });

  test('favCount → like、likeCount → love，不颠倒；fullPlayRate ×100', () => {
    const [p] = ch.map(rawOf(itemWith({ favCount: 7, likeCount: 2, fullPlayRate: 0.5 })), opts).posts;
    assert.equal(p.like, 7);
    assert.equal(p.love, 2);
    assert.equal(p.fullView, 50);
    assert.equal(p.statusText, '已发布');
  });

  test('isDisabled → punish: true / punishReason；没禁用时不带这两个键', () => {
    const [p] = ch.map(rawOf(itemWith({ disableInfo: { isDisabled: true, disableAddWording: '仅自己可见' } })), opts).posts;
    assert.equal(p.punish, true);
    assert.equal(p.punishReason, '仅自己可见');
    assert.equal(p.statusText, '已发布');
    assert.equal('punish' in ch.map(rawOf(), opts).posts[0], false);
  });

  test('缺值 → null 不是 0', () => {
    const a = itemWith({});
    for (const k of ['readCount', 'favCount', 'likeCount', 'followCount', 'fullPlayRate', 'avgPlayTimeSec']) delete a.data.list[0][k];
    const [p] = ch.map(rawOf(a), opts).posts;
    for (const k of ['view', 'like', 'love', 'fansAdd', 'fullView', 'viewTime', 'favorite']) assert.equal(p[k], null, k);
    const trend = { ...fx.fansTrend, data: { total: [1, 2] } };
    assert.deepEqual(ch.map({ ...rawOf(), fansTrend: trend }, opts).account.daily[0], { date: '2026-11-18', fansTotal: 1, fansNet: null, fansAdd: null, fansDrop: null });
  });

  test('窗口外的作品被过滤', () => {
    assert.equal(ch.map(rawOf(itemWith({ createTime: cstMs('2026-10-19 23:00:00') / 1000 })), opts).posts.length, 0);
  });

  test('未登录（errCode≠0 或没有 finderUser）→ loggedIn=false', () => {
    assert.equal(ch.map({ auth: { http: 200, errCode: 300334, finderUser: null } }, opts).loggedIn, false);
    assert.equal(ch.map({ auth: { http: 200, errCode: 0, finderUser: null } }, opts).loggedIn, false);
  });

  describe('fetchRaw', () => {
    const FINDER = 'v2_finderusername_TEST@finder';
    const item = (i) => ({ objectId: `9${i}`, objectNonce: `8${i}`, createTime: Math.floor(nowMs / 1000) - 3600, readCount: 1, favCount: 0, likeCount: 0, commentList: [{ content: 'x' }], desc: { description: `d${i}`, shortTitle: [], media: [{ url: 'https://example.invalid/v', coverUrl: 'https://example.invalid/c', md5sum: 'm' }] } });
    const routes = (lists) => [
      [/auth\/auth_data/, { body: { errCode: 0, data: { finderUser: { finderUsername: FINDER, uniqId: 'sphTEST', nickname: 'n', fansCount: 3, feedsCount: 61 } } } }],
      [/statistic\/post_list/, (u, o) => ({ body: lists[JSON.parse(o.body).currentPage - 1] ?? { errCode: 0, data: { list: [], totalCount: 0 } } })],
      [/statistic\/fans_trend/, { body: { errCode: 0, data: { add: [1], reduce: [0], netAdd: [1], total: [3] } } }],
    ];

    test('按 totalCount 翻够就停；请求体带 finderUsername，但它不进 raw 和 map 的返回值；间隔用传入的 sleep', async () => {
      const lists = [
        { errCode: 0, data: { totalCount: 21, list: Array.from({ length: 20 }, (_, i) => item(i)) } },
        { errCode: 0, data: { totalCount: 21, list: [item(20)] } },
      ];
      const page = fakePage({ routes: routes(lists) });
      const { sleep, waits } = fakeSleep();
      const raw = await ch.fetchRaw(page, { days: 30, nowMs, sleep });
      const pl = page.calls.filter((c) => /post_list/.test(c.url));
      assert.equal(pl.length, 2);
      const body = JSON.parse(pl[0].opts.body);
      assert.equal(body._log_finder_id, FINDER);
      assert.equal(body.startTime, cstMs('2026-10-20 00:00:00') / 1000);
      assert.equal(pl[0].opts.method, 'POST');
      assert.ok(waits.filter((ms) => ms === 2500).length >= 2);
      const r = ch.map(raw, { days: 30, nowMs });
      assert.doesNotMatch(JSON.stringify(raw), /finderusername_TEST/);
      assert.doesNotMatch(JSON.stringify(r), /finderusername_TEST/);
      assert.equal(raw.postList[0].data.list[0].commentList, undefined);   // 裁剪
      assert.equal(r.posts.length, 21);
      assert.equal(r.uidSeen, 'sphTEST');
      assert.deepEqual(r.account.daily, [{ date: '2026-10-20', fansTotal: 3, fansNet: 1, fansAdd: 1, fansDrop: 0 }]);
    });

    test('未登录：只调 auth_data', async () => {
      const page = fakePage({ routes: [[/auth\/auth_data/, { body: { errCode: 300334 } }]] });
      const raw = await ch.fetchRaw(page, { days: 30, nowMs, ...fakeSleep() });
      assert.equal(page.calls.length, 1);
      assert.equal(ch.map(raw, { days: 30, nowMs }).loggedIn, false);
    });
  });
});

describe('平台索引', async () => {
  const idx = await import('../src/ops/works/index.mjs');

  test('四个平台都能按 platformCode 加载，导出约定的接口', async () => {
    assert.deepEqual(idx.COLLECT_PLATFORMS, ['Douyin', 'XiaoHongShu', 'Bili', 'Channels']);
    for (const code of idx.COLLECT_PLATFORMS) {
      const url = idx.moduleUrlOf(code);
      assert.match(url, /^file:\/\/.+\/src\/ops\/works\/\w+\.mjs$/);
      assert.ok(fs.existsSync(new URL(url)), url);
      const m = await idx.loadPlatform(code);
      assert.equal(m.PLATFORM, code);
      assert.match(m.START_URL, /^https:\/\//);
      assert.equal(typeof m.SETTLE_MS, 'number');
      assert.equal(typeof m.fetchRaw, 'function');
      assert.equal(typeof m.map, 'function');
    }
  });

  test('不认识的平台抛错', async () => {
    assert.throws(() => idx.moduleUrlOf('Weibo'), /Weibo/);
    await assert.rejects(idx.loadPlatform('X'), /X/);
  });

  test('空 raw（接口全挂）也不抛错：loggedIn=false、posts 为空', async () => {
    for (const code of idx.COLLECT_PLATFORMS) {
      const r = (await idx.loadPlatform(code)).map({}, { days: 30, nowMs: cstMs('2026-11-19 12:00:00') });
      assert.equal(r.loggedIn, false, code);
      assert.deepEqual(r.posts, [], code);
      assert.equal(r.account.updateTime, '2026-11-19 12:00:00', code);
    }
  });
});

test('仓库夹具里没有会过期的 URL 或凭据', () => {
  const dir = path.join(ROOT, 'test/fixtures/works');
  for (const f of fs.readdirSync(dir)) {
    // note 是说明文字，不查
    const { note, ...data } = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.doesNotMatch(JSON.stringify(data), /https?:\/\/[^"]*\?(?!<)|x-expires|xsec|finderUsername|token/i, f);
  }
});

// 作品列表没读成功时不能当成「窗口内 0 条」：调用方按 posts 覆盖整个平台，会把导出写空（KIN-328 集成实测小红书出过一次）
describe('作品列表没读成功 → complete=false', () => {
  const ok = (x) => ({ http: 200, ...x });

  describe('抖音', async () => {
    const dy = await import('../src/ops/works/douyin.mjs');
    const S = sample('douyin');
    const fx = fixture('douyin-account');
    const opts = { days: 30, nowMs: cstMs('2026-11-19 14:50:13') };
    const run = (pages, more = {}) => dy.map({ info: fx.info, pages, fans: fx.fans, ...more }, opts);
    const empty = ok({ status_code: 0, total: 0, has_more: false, max_cursor: 0, aweme_list: [], items: [] });

    test('读成功 → complete=true、incomplete=null', () => {
      const r = run([ok(S.raw.work_list)]);
      assert.equal(r.complete, true);
      assert.equal(r.incomplete, null);
    });
    test('确实 0 条 → complete=true、posts=[]', () => {
      const r = run([empty]);
      assert.equal(r.complete, true);
      assert.deepEqual(r.posts, []);
    });
    test('http 406 / status_code≠0 / 没有 aweme_list（任一页）→ complete=false，写明接口和第几页', () => {
      let r = run([{ ...empty, http: 406, status_code: null, aweme_list: null }]);
      assert.equal(r.complete, false);
      assert.match(r.incomplete, /work_list 第 1 页.*http=406/);
      r = run([ok(S.raw.work_list), { ...empty, status_code: 2190008 }]);
      assert.equal(r.complete, false);
      assert.match(r.incomplete, /work_list 第 2 页.*code=2190008/);
      assert.equal(r.posts.length, 1);   // 读到的照出，调用方按 complete 决定写不写
      assert.match(run([{ ...empty, aweme_list: null }]).incomplete, /data 缺失/);
    });
    test('翻到页数上限还没停 → complete=false', () => {
      assert.equal(run([ok(S.raw.work_list)], { hitMaxPages: true }).complete, false);
    });
    test('没登录 → complete=false', () => {
      assert.equal(dy.map({ info: { http: 200, status_code: 8 } }, opts).complete, false);
    });
    test('粉丝接口失败不影响 complete：daily 为空，stats 写明', () => {
      const r = run([ok(S.raw.work_list)], { fans: { http: 500, status_code: null, metrics: [] } });
      assert.equal(r.complete, true);
      assert.deepEqual(r.account.daily, []);
      assert.match(r.stats.fansProblems.join(), /dashboard\/fans.*http=500/);
    });
    test('fetchRaw：work_list 回 406 的 HTML → complete=false', async () => {
      const page = fakePage({ routes: [[/user\/info/, { body: { status_code: 0, user: { uid: 1 } } }], [/work_list/, { status: 406, body: '<html/>' }], [/dashboard\/fans/, { body: { status_code: 0, metrics: [] } }]] });
      const r = dy.map(await dy.fetchRaw(page, { ...opts, ...fakeSleep() }), opts);
      assert.equal(r.complete, false);
      assert.match(r.incomplete, /http=406/);
    });
  });

  describe('B站', async () => {
    const bili = await import('../src/ops/works/bili.mjs');
    const S = sample('bili');
    const fx = fixture('bili-account');
    const opts = { days: 30, nowMs: cstMs('2026-11-19 14:26:35') };
    const run = (archives, more = {}) => bili.map({ nav: fx.nav, archives, compare: ok(S.raw.compare), fansGraph: fx.fansGraph, fansNum: ok(S.raw.fansNum), ...more }, opts);

    test('读成功 → complete=true', () => {
      const r = run([ok(S.raw.archives)]);
      assert.equal(r.complete, true);
      assert.deepEqual(r.stats.fansProblems, []);
      assert.equal(r.stats.compareProblem, null);
    });
    test('确实 0 条（arc_audits=null、page.count=0）→ complete=true', () => {
      const r = run([ok({ code: 0, data: { class: { pubed: 0 }, page: { pn: 1, ps: 20, count: 0 }, arc_audits: null } })]);
      assert.equal(r.complete, true);
      assert.deepEqual(r.posts, []);
    });
    test('http≠200 / code≠0 / data 缺失（任一页）→ complete=false', () => {
      assert.match(run([{ http: 412, code: null, data: null }]).incomplete, /archives 第 1 页.*http=412/);
      assert.match(run([ok(S.raw.archives), ok({ code: -400, data: null })]).incomplete, /archives 第 2 页.*code=-400/);
      assert.match(run([ok({ code: 0, data: null })]).incomplete, /data 缺失/);
      assert.equal(run([ok({ code: 0, data: { page: { count: 3 }, arc_audits: null } })]).complete, false);
    });
    test('compare 失败：作品照出、fansAdd/viewTime 为 null，complete 仍为 true，stats 写明', () => {
      const r = run([ok(S.raw.archives)], { compare: { http: 500, code: null, data: null } });
      assert.equal(r.complete, true);
      assert.equal(r.posts.length, 1);
      assert.equal(r.posts[0].fansAdd, null);
      assert.equal(r.posts[0].viewTime, null);
      assert.match(r.stats.compareProblem, /compare.*http=500/);
    });
    test('粉丝接口失败不影响 complete', () => {
      const r = run([ok(S.raw.archives)], { fansNum: { http: 200, code: -101, data: null } });
      assert.equal(r.complete, true);
      assert.equal(r.account.fans, null);
      assert.match(r.stats.fansProblems.join(), /fans\/stat\/num/);
    });
  });

  describe('小红书', async () => {
    const xhs = await import('../src/ops/works/xhs.mjs');
    const S = sample('xhs');
    const fx = fixture('xhs-account');
    const nowMs = cstMs('2026-11-19 14:26:09');
    const opts = { days: 30, nowMs };
    const one = () => { const a = structuredClone(S.raw.analyze); a.data.total = 1; return ok(a); };
    const run = (analyze, more = {}) => xhs.map({ atLoginPage: false, analyze, posted: [], userInfo: fx.userInfo, personalInfo: S.raw.personal_info, fans: fx.fans, ...more }, opts);

    test('读成功 → complete=true', () => assert.equal(run([one()]).complete, true));
    test('确实 0 条（total=0）→ complete=true', () => {
      const r = run([ok({ code: 0, data: { total: 0, note_infos: [] } })]);
      assert.equal(r.complete, true);
      assert.deepEqual(r.posts, []);
    });
    test('406 / code≠0 / data 缺失 / 签名函数缺失 → complete=false', () => {
      assert.match(run([{ http: 406, code: null, data: null }]).incomplete, /analyze\/list 第 1 页.*http=406/);
      assert.match(run([ok({ code: -1, data: null })]).incomplete, /code=-1/);
      assert.match(run([ok({ code: 0, data: null })]).incomplete, /data 缺失/);
      assert.match(run([ok({ code: 0, data: { note_infos: [] } })]).incomplete, /data 缺失/);   // 没有 total
      assert.match(run([{ http: null, code: null, error: '页面没有 _webmsxyw', data: null }]).incomplete, /_webmsxyw/);
    });
    test('第一页 total=15、实际只拿到 1 条（中途某页失败）→ complete=false', () => {
      const a = ok(S.raw.analyze);   // 样例 total=15、note_infos 只有 1 条
      const r = run([a]);
      assert.equal(r.complete, false);
      assert.match(r.incomplete, /只拿到 1 条，total=15/);
      assert.equal(run([a, { http: 500, code: null, data: null }]).complete, false);
    });
    test('跳到登录页 → complete=false', () => assert.equal(xhs.map({ atLoginPage: true }, opts).complete, false));
    test('笔记管理列表、粉丝接口失败不影响 complete', () => {
      const r = run([one()], { posted: [{ http: 406, code: null, data: { notes: [] } }], fans: { http: 500, code: null, data: { thirty: null } } });
      assert.equal(r.complete, true);
      assert.equal(r.stats.postedProblems.length, 1);
      assert.match(r.stats.fansProblems.join(), /overall_new/);
    });

    describe('fetchRaw：等签名函数、第一页重试', () => {
      // 假 page：签名函数第 readyAt 次查询时才出现；analyze 按次序回 analyzeSeq（每个元素是 {status, body}）
      function page({ readyAt = 1, analyzeSeq }) {
        const st = { polls: 0, analyze: 0 };
        const p = fakePage({
          url: 'https://creator.xiaohongshu.com/new/note-manager',
          routes: [
            [/user\/info/, { body: { code: 0, data: { userId: 'u1' } } }],
            [/personal_info/, { body: { code: 0, data: { name: 'n', fans_count: 3 } } }],
            [/overall_new/, { body: { code: 0, data: { thirty: { fans_list: [] } } } }],
          ],
          evaluate: async (arg, fn) => {
            const saved = { window: globalThis.window, fetch: globalThis.fetch };
            const ready = arg === undefined ? ++st.polls >= readyAt : st.polls >= readyAt;
            globalThis.window = ready ? { _webmsxyw: () => ({ 'X-s': 's', 'X-t': 1 }) } : {};
            globalThis.fetch = async (u) => {
              const res = /analyze\/list/.test(u) ? analyzeSeq[Math.min(st.analyze++, analyzeSeq.length - 1)] : { status: 200, body: { code: 0, data: { notes: [] } } };
              return { status: res.status ?? 200, text: async () => (typeof res.body === 'string' ? res.body : JSON.stringify(res.body)) };
            };
            try { return await fn(arg); } finally { globalThis.window = saved.window; globalThis.fetch = saved.fetch; }
          },
        });
        return { p, st };
      }
      const good = { body: { code: 0, data: { total: 1, note_infos: [{ id: 'n1', audit_status: 1, type: 2, post_time: nowMs - 3600_000 }] } } };

      test('签名函数第 4 次查询才出现：每秒查一次，就绪后才发第一个签名请求', async () => {
        const { p, st } = page({ readyAt: 4, analyzeSeq: [good] });
        const { sleep, waits } = fakeSleep();
        const raw = await xhs.fetchRaw(p, { ...opts, sleep });
        assert.equal(raw.signerPolls, 4);
        assert.equal(raw.signerReady, true);
        assert.deepEqual(waits.slice(0, 3), [1000, 1000, 1000]);
        assert.equal(st.analyze, 1);
        assert.equal(xhs.map(raw, opts).complete, true);
      });

      test('签名函数 20 秒都没出现：停止等待，complete=false', async () => {
        const { p } = page({ readyAt: Infinity, analyzeSeq: [good] });
        const { sleep, waits } = fakeSleep();
        const raw = await xhs.fetchRaw(p, { ...opts, sleep });
        assert.equal(raw.signerReady, false);
        assert.equal(waits.filter((ms) => ms === 1000).length, 20);
        const r = xhs.map(raw, opts);
        assert.equal(r.complete, false);
        assert.equal(r.stats.signerReady, false);
      });

      test('第一页 406：等 3 秒重试一次，成功就 complete=true，重试次数写进 raw 和 stats', async () => {
        const { p, st } = page({ analyzeSeq: [{ status: 406, body: '' }, good] });
        const { sleep, waits } = fakeSleep();
        const raw = await xhs.fetchRaw(p, { ...opts, sleep });
        assert.equal(st.analyze, 2);
        assert.ok(waits.includes(3000));
        assert.equal(raw.analyzeRetries, 1);
        const r = xhs.map(raw, opts);
        assert.equal(r.complete, true);
        assert.equal(r.stats.analyzeRetries, 1);
        assert.equal(r.stats.analyzeFirstTry.http, 406);
      });

      test('第一页 code≠0、重试仍失败 → 只重试一次，complete=false', async () => {
        const { p, st } = page({ analyzeSeq: [{ body: { code: -1, success: false } }] });
        const raw = await xhs.fetchRaw(p, { ...opts, ...fakeSleep() });
        assert.equal(st.analyze, 2);
        assert.equal(xhs.map(raw, opts).complete, false);
      });

      test('第一页一次成功：不重试', async () => {
        const { p, st } = page({ analyzeSeq: [good] });
        const raw = await xhs.fetchRaw(p, { ...opts, ...fakeSleep() });
        assert.equal(st.analyze, 1);
        assert.equal(raw.analyzeRetries, undefined);
      });
    });
  });

  describe('视频号', async () => {
    const ch = await import('../src/ops/works/channels.mjs');
    const S = sample('channels');
    const fx = fixture('channels-account');
    const opts = { days: 30, nowMs: cstMs('2026-11-19 15:36:47') };
    const run = (postList, more = {}) => ch.map({ auth: fx.auth, postList, fansTrend: fx.fansTrend, ...more }, opts);
    const one = () => { const a = structuredClone(S.raw.postList); a.data.totalCount = 1; return ok(a); };

    test('读成功 → complete=true', () => assert.equal(run([one()]).complete, true));
    test('确实 0 条（totalCount=0）→ complete=true', () => {
      const r = run([ok({ errCode: 0, data: { totalCount: 0, list: [] } })]);
      assert.equal(r.complete, true);
      assert.deepEqual(r.posts, []);
    });
    test('http≠200 / errCode≠0 / list 或 totalCount 缺失 → complete=false', () => {
      assert.match(run([{ http: 500, errCode: null, data: null }]).incomplete, /post_list 第 1 页.*http=500/);
      assert.match(run([one(), ok({ errCode: 300334, data: null })]).incomplete, /post_list 第 2 页.*code=300334/);
      assert.match(run([ok({ errCode: 0, data: { totalCount: 3, list: null } })]).incomplete, /data 缺失/);
      assert.match(run([ok({ errCode: 0, data: { totalCount: null, list: [] } })]).incomplete, /data 缺失/);
    });
    test('拿到的条数少于 totalCount → complete=false', () => {
      assert.match(run([ok(S.raw.postList)]).incomplete, /只拿到 1 条，totalCount=16/);
    });
    test('粉丝接口失败不影响 complete', () => {
      const r = run([one()], { fansTrend: { http: 200, errCode: -1, startTs: 0, data: null } });
      assert.equal(r.complete, true);
      assert.deepEqual(r.account.daily, []);
      assert.match(r.stats.fansProblems.join(), /fans_trend/);
    });
  });
});

test('四个平台的 map 都返回 complete 和 incomplete', async () => {
  const idx = await import('../src/ops/works/index.mjs');
  for (const code of idx.COLLECT_PLATFORMS) {
    const r = (await idx.loadPlatform(code)).map({}, { days: 30, nowMs: 0 });
    assert.equal(r.complete, false, code);
    assert.equal(typeof r.incomplete, 'string', code);
  }
});

// Ego 的 page.fetch 对 POST 会给 201（KIN-328 第二次真实采集视频号 post_list 实测），2xx 都算 http 成功
describe('http 2xx（不只是 200）都算成功', () => {
  test('fmt.pageProblem：200–299 算成功，其余判失败', () => {
    for (const http of [200, 201, 204, 299]) assert.equal(fmt.pageProblem('x', 0, { http, code: 0 }, true), null, String(http));
    for (const http of [199, 300, 302, 406, 500, null, undefined]) assert.match(fmt.pageProblem('x', 0, { http, code: 0 }, true), /http 不是 2xx/, String(http));
  });

  test('视频号 post_list http=201 + errCode=0 → complete=true；http=500 → complete=false', async () => {
    const ch = await import('../src/ops/works/channels.mjs');
    const fx = fixture('channels-account');
    const list = structuredClone(sample('channels').raw.postList);
    list.data.totalCount = 1;
    const opts = { days: 30, nowMs: cstMs('2026-11-19 15:36:47') };
    const run = (http) => ch.map({ auth: { ...fx.auth, http: 201 }, postList: [{ ...list, http }], fansTrend: { ...fx.fansTrend, http: 201 } }, opts);
    const r = run(201);
    assert.equal(r.complete, true);
    assert.equal(r.incomplete, null);
    assert.equal(r.posts.length, 1);
    assert.deepEqual(r.stats.fansProblems, []);
    assert.equal(run(500).complete, false);
    assert.match(run(500).incomplete, /http=500/);
  });

  test('视频号 fetchRaw：page.fetch 对 POST 回 201 → complete=true', async () => {
    const ch = await import('../src/ops/works/channels.mjs');
    const nowMs = cstMs('2026-11-19 15:36:47');
    const item = { objectId: '1', objectNonce: '2', createTime: Math.floor(nowMs / 1000) - 3600, desc: {} };
    const page = fakePage({ routes: [
      [/auth\/auth_data/, { status: 201, body: { errCode: 0, data: { finderUser: { finderUsername: 'f', uniqId: 'sph', nickname: 'n', fansCount: 1 } } } }],
      [/post_list/, { status: 201, body: { errCode: 0, data: { totalCount: 1, list: [item] } } }],
      [/fans_trend/, { status: 201, body: { errCode: 0, data: { total: [1], netAdd: [0] } } }],
    ] });
    const r = ch.map(await ch.fetchRaw(page, { days: 30, nowMs, ...fakeSleep() }), { days: 30, nowMs });
    assert.equal(r.complete, true);
    assert.equal(r.posts.length, 1);
  });

  test('抖音 work_list http=204 → 不判失败', async () => {
    const dy = await import('../src/ops/works/douyin.mjs');
    const fx = fixture('douyin-account');
    const r = dy.map({ info: fx.info, pages: [{ ...sample('douyin').raw.work_list, http: 204 }], fans: { ...fx.fans, http: 204 } }, { days: 30, nowMs: cstMs('2026-11-19 14:50:13') });
    assert.equal(r.complete, true);
    assert.deepEqual(r.stats.fansProblems, []);
  });

  test('B站 archives / compare / 粉丝接口 http=201 → 不判失败', async () => {
    const bili = await import('../src/ops/works/bili.mjs');
    const S = sample('bili');
    const fx = fixture('bili-account');
    const r = bili.map({ nav: fx.nav, archives: [{ ...S.raw.archives, http: 201 }], compare: { ...S.raw.compare, http: 201 }, fansGraph: { ...fx.fansGraph, http: 201 }, fansNum: { ...S.raw.fansNum, http: 201 } }, { days: 30, nowMs: cstMs('2026-11-19 14:26:35') });
    assert.equal(r.complete, true);
    assert.equal(r.stats.compareProblem, null);
    assert.deepEqual(r.stats.fansProblems, []);
  });

  test('小红书 analyze 第一页 http=201：不重试、complete=true', async () => {
    const xhs = await import('../src/ops/works/xhs.mjs');
    const nowMs = cstMs('2026-11-19 14:26:09');
    let analyzeCalls = 0;
    const page = fakePage({
      url: 'https://creator.xiaohongshu.com/new/note-manager',
      routes: [
        [/user\/info/, { status: 201, body: { code: 0, data: { userId: 'u1' } } }],
        [/personal_info/, { status: 201, body: { code: 0, data: { name: 'n', fans_count: 3 } } }],
        [/overall_new/, { status: 201, body: { code: 0, data: { thirty: { fans_list: [] } } } }],
      ],
      evaluate: async (arg, fn) => {
        const saved = { window: globalThis.window, fetch: globalThis.fetch };
        globalThis.window = { _webmsxyw: () => ({ 'X-s': 's', 'X-t': 1 }) };
        globalThis.fetch = async (u) => {
          const body = /analyze\/list/.test(u) ? (analyzeCalls++, { code: 0, data: { total: 1, note_infos: [{ id: 'n1', audit_status: 1, type: 2, post_time: nowMs - 3600_000 }] } }) : { code: 0, data: { notes: [] } };
          return { status: 201, text: async () => JSON.stringify(body) };
        };
        try { return await fn(arg); } finally { globalThis.window = saved.window; globalThis.fetch = saved.fetch; }
      },
    });
    const raw = await xhs.fetchRaw(page, { days: 30, nowMs, ...fakeSleep() });
    const r = xhs.map(raw, { days: 30, nowMs });
    assert.equal(analyzeCalls, 1);
    assert.equal(raw.analyzeRetries, undefined);
    assert.equal(r.complete, true);
    assert.deepEqual(r.stats.postedProblems, []);
    assert.deepEqual(r.stats.fansProblems, []);
  });
});

// 评审 X-B3：粉丝分日固定近 30 天，和作品窗口 --days 无关
describe('粉丝分日固定 30 天，不跟着 days 走', () => {
  test('fmt.FANS_DAILY_DAYS = 30', () => assert.equal(fmt.FANS_DAILY_DAYS, 30));

  test('抖音 fetchRaw days=7：dashboard/fans 仍请求 recent_days=30；map 不截短 daily', async () => {
    const dy = await import('../src/ops/works/douyin.mjs');
    const nowMs = cstMs('2026-11-19 14:50:13');
    const trends = Array.from({ length: 30 }, (_, i) => ({ date_time: fmt.cstDate(cstMs('2026-10-20 00:00:00') / 1000 + i * 86400).replaceAll('-', ''), value: i }));
    const page = fakePage({ routes: [
      [/user\/info/, { body: { status_code: 0, user: { uid: 1 } } }],
      [/work_list/, { body: { status_code: 0, total: 0, has_more: false, max_cursor: 0, aweme_list: [], items: [] } }],
      [/dashboard\/fans/, { body: { status_code: 0, metrics: [{ english_metric_name: 'total_fans_cnt', trends }, { english_metric_name: 'net_fans_cnt', trends }] } }],
    ] });
    const raw = await dy.fetchRaw(page, { days: 7, nowMs, ...fakeSleep() });
    const fansCall = page.calls.find((c) => /dashboard\/fans/.test(c.url));
    assert.match(fansCall.url, /recent_days=30(&|$)/);
    assert.equal(dy.map(raw, { days: 7, nowMs }).account.daily.length, 30);
  });

  test('视频号 fetchRaw days=7：fans_trend 的 startTs 是 30 天前东八区 0 点；map 的 daily 日期按它推、不截短', async () => {
    const ch = await import('../src/ops/works/channels.mjs');
    const nowMs = cstMs('2026-11-19 15:36:47');
    const total = Array.from({ length: 31 }, (_, i) => i);
    const page = fakePage({ routes: [
      [/auth\/auth_data/, { body: { errCode: 0, data: { finderUser: { finderUsername: 'f', uniqId: 'sph', fansCount: 1 } } } }],
      [/post_list/, { body: { errCode: 0, data: { totalCount: 0, list: [] } } }],
      [/fans_trend/, { body: { errCode: 0, data: { total, netAdd: total } } }],
    ] });
    const raw = await ch.fetchRaw(page, { days: 7, nowMs, ...fakeSleep() });
    const pl = JSON.parse(page.calls.find((c) => /post_list/.test(c.url)).opts.body);
    const ft = JSON.parse(page.calls.find((c) => /fans_trend/.test(c.url)).opts.body);
    assert.equal(pl.startTime, cstMs('2026-11-12 00:00:00') / 1000);         // 作品窗口仍按 days
    assert.equal(ft.startTs, String(cstMs('2026-10-20 00:00:00') / 1000));   // 粉丝固定 30 天
    const { daily } = ch.map(raw, { days: 7, nowMs }).account;
    assert.equal(daily.length, 31);
    assert.equal(daily[0].date, '2026-10-20');
    assert.equal(daily.at(-1).date, '2026-11-19');
  });

  test('小红书 overall_new、B站 fans/stat/graph?period=1 的请求不带 days', async () => {
    const src = (f) => fs.readFileSync(path.join(ROOT, 'src/ops/works', f), 'utf8');
    assert.match(src('bili.mjs'), /fans\/stat\/graph\?type=all_fans&period=1'/);
    assert.match(src('xhs.mjs'), /fans\/overall_new'/);
  });
});

// 评审 X-B5：缺 id 的作品不能生成 "undefined" 这样的 postId；整个平台 complete=false
describe('作品缺 id → postId=null、complete=false', () => {
  const badId = (r) => r.posts.filter((p) => p.postId == null || /^(undefined|null)$/.test(String(p.postId)) || /undefined|null$/.test(String(p.url ?? '')));
  const check = (r, field) => {
    assert.equal(r.complete, false);
    assert.match(r.incomplete, new RegExp(field));
    for (const p of r.posts) assert.ok(!/^(undefined|null)$/.test(String(p.postId)) || p.postId === null, 'postId 不能是 "undefined"/"null" 字符串');
    assert.ok(badId(r).every((p) => p.postId === null));
    assert.doesNotMatch(JSON.stringify(r.posts), /"postId":"(undefined|null)"|\/(video|explore)\/(undefined|null)"/);
  };

  test('视频号缺 objectNonce', async () => {
    const ch = await import('../src/ops/works/channels.mjs');
    const fx = fixture('channels-account');
    const list = structuredClone(sample('channels').raw.postList);
    list.data.totalCount = 1;
    delete list.data.list[0].objectNonce;
    check(ch.map({ auth: fx.auth, postList: [{ ...list, http: 200 }], fansTrend: fx.fansTrend }, { days: 30, nowMs: cstMs('2026-11-19 15:36:47') }), 'objectNonce');
  });

  test('抖音缺 aweme_id', async () => {
    const dy = await import('../src/ops/works/douyin.mjs');
    const fx = fixture('douyin-account');
    const wl = structuredClone(sample('douyin').raw.work_list);
    delete wl.aweme_list[1].aweme_id;
    check(dy.map({ info: fx.info, pages: [{ ...wl, http: 200 }], fans: fx.fans }, { days: 30, nowMs: cstMs('2026-11-19 14:50:13') }), 'aweme_id');
  });

  test('B站缺 bvid', async () => {
    const bili = await import('../src/ops/works/bili.mjs');
    const S = sample('bili');
    const fx = fixture('bili-account');
    const a = structuredClone(S.raw.archives);
    a.data.arc_audits[0].Archive.bvid = '';
    check(bili.map({ nav: fx.nav, archives: [{ ...a, http: 200 }], compare: S.raw.compare, fansGraph: fx.fansGraph, fansNum: S.raw.fansNum }, { days: 30, nowMs: cstMs('2026-11-19 14:26:35') }), 'bvid');
  });

  test('小红书缺 id', async () => {
    const xhs = await import('../src/ops/works/xhs.mjs');
    const S = sample('xhs');
    const fx = fixture('xhs-account');
    const an = structuredClone(S.raw.analyze);
    an.data.total = 1;
    an.data.note_infos[0].id = null;
    check(xhs.map({ atLoginPage: false, analyze: [{ ...an, http: 200 }], posted: [], userInfo: fx.userInfo, personalInfo: S.raw.personal_info, fans: fx.fans }, { days: 30, nowMs: cstMs('2026-11-19 14:26:09') }), '\\bid\\b');
  });
});
