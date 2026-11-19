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
