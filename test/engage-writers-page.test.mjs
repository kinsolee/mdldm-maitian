// 抖音、视频号、小红书页面写入适配器（回复评论、发私信）的行为测试：
// 在 Ego Lite Profile 5 的临时 space（kinso/test/*）里打开本地测试页（file://），真跑 runInSpace。
// 测试页仿 S0 记的真实 DOM，按 ?mode= 模拟各种情形，并用 window.__probe() 报告发送按钮被点了几次、输入框里剩什么。
import './helpers/ops-dir.mjs';   // 锁目录指到临时目录
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { runEgoTask, finishSpace } from '../src/ego-runner/index.mjs';
import { EGO_SKIP, tempSpaceName, fixtureUrl } from './helpers/ego.mjs';

const moduleUrl = (f) => new URL(`../src/ops/engage/writers/${f}`, import.meta.url).href;
let seq = 0;
const pageUrl = (f, q) => `${fixtureUrl(`engage-write/${f}`)}?${new URLSearchParams({ ...q, n: String(++seq) })}`;
// 协调者框架的调用方式（import + runInSpace），后面再读一次测试页的 __probe
const SCRIPT = `const m = await import(params.moduleUrl);
const r = await m.runInSpace(task, params);
const p = (await task.pages())[0];
const probe = p ? await p.evaluate(() => (window.__probe ? window.__probe() : null)) : null;
return { r, probe };`;
const TIMEOUTS = { loadMs: 8000, readbackMs: 2500, settleMs: 200, boxMs: 3000 };

async function write(space, file, params) {
  const res = await runEgoTask({ space, script: SCRIPT, timeoutMs: 120_000, params: { moduleUrl: moduleUrl(file), timeouts: TIMEOUTS, ...params } });
  assert.equal(res.ok, true, `${res.reason}: ${res.error}\n${res.stderr}\n${res.stdout}`);
  return res.result;
}

/** 没输入、没点发送：sendAttempted:false，发送按钮 0 次。 */
function assertNoSend({ r, probe }, blocked) {
  assert.equal(r.blocked, blocked, JSON.stringify(r));
  assert.equal(r.sendAttempted, false);
  assert.equal(r.readBack, undefined);
  assert.equal(probe.sendClicks, 0);
}
/** 正常发出：只点一次，回读到恰好一条。 */
function assertSent({ r, probe }, nativeId) {
  assert.equal(r.blocked, undefined, JSON.stringify(r));
  assert.equal(r.sendAttempted, true);
  assert.deepEqual(r.readBack, { found: true, count: 1, nativeId });
  assert.equal(r.sendError, undefined);
  assert.equal(probe.sendClicks, 1);
}
/** 输入框还在、已清空（contenteditable 清空后 innerText 可能剩一个换行）。 */
function assertCleared({ probe }) {
  assert.deepEqual(probe.boxes.map((b) => b.trim()), ['']);
}
function assertNotReadBack({ r, probe }) {
  assert.equal(r.sendAttempted, true, JSON.stringify(r));
  assert.equal(r.readBack.found, false);
  assert.equal(r.readBack.count, 0);
  assert.equal(probe.sendClicks, 1);
}

describe('页面写入适配器（真实 Ego Lite + 本地测试页）', { skip: EGO_SKIP ?? false }, () => {
  const spaces = [];
  const space = (tag) => { const s = tempSpaceName(tag); spaces.push(s); return s; };
  after(async () => { for (const s of spaces) await finishSpace(s); });

  describe('抖音', () => {
    const s = space('dyw');
    const base = { uid: '106', nickname: '麦田测试号', test: { loginFromPage: true } };
    const TEXT = '谢谢支持！';
    const reply = (mode, target = {}, extra = {}) => write(s, 'douyin.mjs', { ...base, op: 'reply', text: TEXT,
      target: { commentId: 'c1', workId: '7001', parentId: null, rootId: 'c1', authorUid: '501', authorNickname: '甲', commentText: '第一条评论', ...target },
      urls: { comments: pageUrl('douyin-comments.html', { mode }) }, ...extra });
    const dm = (mode, extra = {}) => write(s, 'douyin.mjs', { ...base, op: 'sendDM', text: '您好，链接在主页',
      target: { conversationId: '0:1:106:601', peerUid: '601', peerNickname: '甲' }, urls: { dms: pageUrl('douyin-dms.html', { mode }) }, ...extra });

    test('导出 FILE 和真实页面地址', async () => {
      const m = await import(moduleUrl('douyin.mjs'));
      assert.equal(m.FILE, 'douyin.mjs');
      assert.match(m.PAGES.comments, /^https:\/\/creator\.douyin\.com\//);
      assert.match(m.PAGES.dms, /^https:\/\/creator\.douyin\.com\//);
    });

    test('回复一楼：只点一次发送，回读到一条，顶部一级评论框始终为空', async () => {
      const x = await reply('ok');
      assertSent(x, 'n1');
      assert.equal(x.r.uidSeen, '106');
      assert.equal(x.probe.top, '');
      assert.equal(x.probe.deleteClicks, 0);
      assert.deepEqual(x.probe.mine, [{ cid: 'n1', text: TEXT, reply_id: 'c1', reply_to_reply_id: '0' }]);
    });

    test('回复楼中楼：先展开再回复，回复对象是那条楼中楼', async () => {
      const x = await reply('ok', { commentId: 'c1r1', parentId: 'c1', rootId: 'c1', authorUid: '502', authorNickname: '乙', commentText: '楼中楼一条' });
      assertSent(x, 'n1');
      assert.equal(x.probe.top, '');
      assert.deepEqual(x.probe.mine, [{ cid: 'n1', text: TEXT, reply_id: 'c1', reply_to_reply_id: 'c1r1' }]);
    });

    test('uid 不符：不打开回复框、不输入、不点发送', async () => {
      const x = await reply('ok', {}, { uid: '999' });
      assertNoSend(x, 'uid-mismatch');
      assert.equal(x.r.uidSeen, '106');
      assert.deepEqual(x.probe.boxes, []);
      assert.equal(x.probe.top, '');
    });

    test('读不到登录账号：no-uid', async () => {
      const x = await reply('nouid');
      assertNoSend(x, 'no-uid');
      assert.equal(x.r.uidSeen, null);
    });

    test('目标评论已删除：comment-gone', async () => assertNoSend(await reply('gone'), 'comment-gone'));
    test('目标下已有我的直接回复：already-replied', async () => assertNoSend(await reply('replied'), 'already-replied'));
    test('展开到上限楼里还没加载全（可能藏着我的旧回复）：thread-incomplete，不发', async () => assertNoSend(await reply('stuck', {}, { maxExpand: 2 }), 'thread-incomplete'));
    test('找不到目标评论：target-not-found', async () => assertNoSend(await reply('ok', { commentId: 'nope', rootId: 'nope' }), 'target-not-found'));

    test('输入框内容和正文不一致：清空、不点发送', async () => {
      const x = await reply('mangle');
      assertNoSend(x, 'input-mismatch');
      assertCleared(x);
      assert.equal(x.probe.top, '');
    });

    test('点了发送但回读不到：sendAttempted:true、found:false', async () => {
      const x = await reply('silent');
      assertNotReadBack(x);
      assert.equal(x.r.sendError, undefined);
    });

    test('页面报错：sendError', async () => {
      const x = await reply('fail');
      assertNotReadBack(x);
      assert.match(x.r.sendError, /回复失败/);
    });

    test('私信：打开会话、只点一次发送、回读到一条', async () => {
      const x = await dm('ok');
      assertSent(x, 'cm1');
      assert.equal(x.probe.openId, '0:1:106:601');
      assert.deepEqual(x.probe.mine, [{ conv: '0:1:106:601', text: '您好，链接在主页' }]);
    });
    test('私信：最后一句是我 → last-is-me', async () => assertNoSend(await dm('lastme'), 'last-is-me'));
    test('私信：点开的不是目标会话（列表顺序变了）→ target-not-found，不发', async () => assertNoSend(await dm('swap'), 'target-not-found'));
    test('私信：没有输入框 → no-input-box', async () => assertNoSend(await dm('nobox'), 'no-input-box'));
    test('私信：uid 不符', async () => assertNoSend(await dm('ok', { uid: '999' }), 'uid-mismatch'));
    test('私信：页面报错 → sendError', async () => { const x = await dm('fail'); assertNotReadBack(x); assert.match(x.r.sendError, /发送失败/); });
    test('私信：输入框内容不一致 → input-mismatch', async () => { const x = await dm('mangle'); assertNoSend(x, 'input-mismatch'); assertCleared(x); });
  });

  // 2026-11-21 真实页面（Douyin:106707338905 评论管理页）只读核对后做的测试页：fiber 上是视图模型（没有 cid + text），
  // 回复按钮是 operations- 下带图标的 div，发送按钮没字时 disabled。旧测试页的结构对不上真实页面，第一次真实调用就找不到「回复」。
  describe('抖音（真实页面结构）', () => {
    const s = space('dyr');
    const base = { uid: '106', nickname: '麦田测试号', test: { loginFromPage: true } };
    const TEXT = '谢谢支持！';
    const reply = (mode, target = {}, extra = {}) => write(s, 'douyin.mjs', { ...base, op: 'reply', text: TEXT,
      target: { commentId: 'c1', workId: '7001', parentId: null, rootId: 'c1', authorUid: '501', authorNickname: '甲', commentText: '第一条评论', ...target },
      urls: { comments: pageUrl('douyin-comments-real.html', { mode }) }, ...extra });
    const sub = { commentId: 'c1r1', parentId: 'c1', rootId: 'c1', authorUid: '502', authorNickname: '乙', commentText: '楼中楼一条' };
    const untouched = (x) => { assert.equal(x.probe.top, ''); assert.equal(x.probe.deleteClicks, 0); assert.equal(x.probe.reportClicks, 0); };

    test('回复一楼：找到「回复」、只点一次发送、回读到一条', async () => {
      const x = await reply('ok');
      assertSent(x, 'n1');
      untouched(x);
      assert.deepEqual(x.probe.mine, [{ cid: 'n1', text: TEXT, reply_id: 'c1', reply_to_reply_id: '0' }]);
    });
    test('没有写接口响应、页面上的新回复看不出回的是谁：不算 sent（needs_readback）', async () => {
      const x = await reply('okdom');
      assertNotReadBack(x);
      untouched(x);
    });
    test('楼中楼没抓到接口、楼里有我一条看不出回谁的回复：thread-incomplete，不发', async () => {
      const x = await reply('nocapsub', sub);
      assertNoSend(x, 'thread-incomplete');
      assert.deepEqual(x.probe.boxes, []);
    });
    test('点「回复」后打开的是别的评论的框：no-input-box，不往那个框里写', async () => {
      const x = await reply('otherbox');
      assertNoSend(x, 'no-input-box');
      assert.deepEqual(x.probe.boxes, ['']);
    });
    test('回复楼中楼：展开后找到那条楼中楼自己的「回复」', async () => {
      const x = await reply('ok', sub);
      assertSent(x, 'n1');
      untouched(x);
      assert.deepEqual(x.probe.mine, [{ cid: 'n1', text: TEXT, reply_id: 'c1', reply_to_reply_id: 'c1r1' }]);
    });
    test('一楼下已有我的直接回复：already-replied', async () => assertNoSend(await reply('replied'), 'already-replied'));
    test('我在楼里回的是楼中楼，不算回过一楼：照常发', async () => assertSent(await reply('otherreply'), 'n1'));
    test('我回过的楼中楼再回一次：already-replied', async () => assertNoSend(await reply('otherreply', sub), 'already-replied'));
    test('目标评论已删除：comment-gone', async () => assertNoSend(await reply('gone'), 'comment-gone'));
    test('找不到目标评论：target-not-found', async () => assertNoSend(await reply('ok', { commentId: 'nope', rootId: 'nope' }), 'target-not-found'));
    test('输入后「发送」仍是 disabled：cannot-send，框已清空，不点', async () => {
      const x = await reply('locked');
      assertNoSend(x, 'cannot-send');
      assertCleared(x);
    });
    test('输入框内容不一致：input-mismatch，框已清空', async () => { const x = await reply('mangle'); assertNoSend(x, 'input-mismatch'); assertCleared(x); untouched(x); });
    test('点了发送但回读不到', async () => { const x = await reply('silent'); assertNotReadBack(x); assert.equal(x.r.sendError, undefined); });
    test('页面报错：sendError', async () => { const x = await reply('fail'); assertNotReadBack(x); assert.match(x.r.sendError, /回复失败/); });
  });

  // 2026-11-21 真实调用：旧作品下的 8 条报「切不到作品」、1 条切过去了却「没找到评论」。只读核对真实页面后做的测试页：
  // 抽屉作品列表打开后最慢 3.3 秒才出来、滚到底才翻页；默认作品的一楼列表晚到会盖掉已切过去的作品；一楼每页 10 条，滚到页面底部才加载下一页。
  describe('抖音（选择作品、一楼翻页）', () => {
    const s = space('dyp');
    const base = { uid: '106', nickname: '麦田测试号', test: { loginFromPage: true } };
    const TEXT = '谢谢支持！';
    const reply = (mode, target = {}, extra = {}, q = {}) => write(s, 'douyin.mjs', { ...base, op: 'reply', text: TEXT,
      target: { commentId: 'w05-c1', workId: 'w05', parentId: null, rootId: 'w05-c1', authorUid: '601', authorNickname: '用户1', commentText: '一楼评论1', ...target },
      urls: { comments: pageUrl('douyin-comments-picker.html', { mode, ...q }) }, ...extra });
    const on = (w, i) => ({ commentId: `${w}-c${i}`, workId: w, rootId: `${w}-c${i}` });
    const sentOn = (x, w, cid) => { assertSent(x, 'n1'); assert.equal(x.probe.current, w); assert.deepEqual(x.probe.mine.map((m) => [m.aweme_id, m.reply_id]), [[w, cid]]); assert.equal(x.probe.top, ''); };

    test('作品列表打开 3.5 秒后才出来：等到再切，回复发出', async () => sentOn(await reply('ok'), 'w05', 'w05-c1'));
    test('旧作品在作品列表第 2 页：滚动抽屉翻页后切过去', async () => sentOn(await reply('ok', on('w30', 2)), 'w30', 'w30-c2'));
    test('默认作品的一楼列表晚到（会盖掉已切过去的作品）：等它到了再切', async () => sentOn(await reply('race'), 'w05', 'w05-c1'));
    test('目标在一楼第 2 页：滚到页面底部加载下一页后找到', async () => sentOn(await reply('ok', on('w05', 15)), 'w05', 'w05-c15'));
    test('第 3 页的旧作品、第 2 页的评论：两边都翻页', async () => sentOn(await reply('ok', on('w44', 18)), 'w44', 'w44-c18'));

    test('作品列表翻到底也没有：target-not-found，写明翻到底', async () => {
      const x = await reply('ok', on('w99', 1), {}, { drawerDelay: 300 });
      assertNoSend(x, 'target-not-found');
      assert.match(x.r.detail, /切不到作品 w99/);
      assert.match(x.r.detail, /到底.*45 个作品/);
    });
    test('作品在第 3 页、翻页上限 2：target-not-found，写明上限', async () => {
      const x = await reply('ok', on('w44', 1), { maxPickerPages: 2 }, { drawerDelay: 300 });
      assertNoSend(x, 'target-not-found');
      assert.match(x.r.detail, /切不到作品 w44.*上限/);
    });
    test('一楼加载上限 1 页、目标在第 2 页：target-not-found，写明上限', async () => {
      const x = await reply('ok', on('w05', 15), { maxCommentPages: 1 }, { drawerDelay: 300 });
      assertNoSend(x, 'target-not-found');
      assert.match(x.r.detail, /没找到评论 w05-c15.*上限/);
    });
    test('一楼翻到底也没有目标：target-not-found，写明翻到底', async () => {
      const x = await reply('ok', { commentId: 'w05-nope', workId: 'w05', rootId: 'w05-nope' }, {}, { drawerDelay: 300 });
      assertNoSend(x, 'target-not-found');
      assert.match(x.r.detail, /没找到评论 w05-nope.*翻到底/);
    });
    test('翻页找到的评论下已有我的回复：already-replied，不发', async () => assertNoSend(await reply('replied', on('w30', 15), {}, { drawerDelay: 300 }), 'already-replied'));

    // 第一轮评审（Gemini、GPT）指出的边界
    test('默认作品没有评论：照样切过去发出', async () => sentOn(await reply('emptydefault', {}, {}, { drawerDelay: 300 }), 'w05', 'w05-c1'));
    test('一楼要翻 4 页、响应比渲染早到：每次等页面渲染好再滚，「回复」等它渲染出来', async () =>
      sentOn(await reply('ok', on('w05', 33), {}, { drawerDelay: 300, roots: 35, renderDelay: 1500 }), 'w05', 'w05-c33'));
    test('前面 30 条一楼都有楼中楼、目标是第 31 条下的楼中楼：先展开目标所在的楼', async () => {
      const x = await reply('ok', { commentId: 'w05-c30r1', workId: 'w05', parentId: 'w05-c30', rootId: 'w05-c30' }, {}, { drawerDelay: 300, roots: 35, subsAll: '1' });
      sentOn(x, 'w05', 'w05-c30');
      assert.deepEqual(x.probe.mine.map((m) => m.reply_to_reply_id), ['w05-c30r1']);
    });
    test('最后一页满 10 条、接口还说有下一页、下一页是空的：按翻到底报 target-not-found', async () => {
      const x = await reply('ok', { commentId: 'w05-nope', workId: 'w05', rootId: 'w05-nope' }, {}, { drawerDelay: 300, roots: 20, emptyTail: '1' });
      assertNoSend(x, 'target-not-found');
      assert.match(x.r.detail, /翻到底（3 页）/);
    });
    test('要切作品但页面上没有「选择作品」：target-not-found，写明原因', async () => {
      const x = await reply('nopicker');
      assertNoSend(x, 'target-not-found');
      assert.match(x.r.detail, /没有「选择作品」/);
    });
    test('点了作品后一楼列表一直不来：target-not-found，写明没加载出列表', async () => {
      const x = await reply('noload', {}, {}, { drawerDelay: 300 });
      assertNoSend(x, 'target-not-found');
      assert.match(x.r.detail, /没加载出.*一楼列表/);
    });

    // 读适配器（抓评论）用同一个 switchTo
    const switchTo = async (work, opts = {}, then = null) => {
      const res = await runEgoTask({ space: s, timeoutMs: 120_000, params: { adapterUrl: new URL('../src/ops/engage/adapters/douyin.mjs', import.meta.url).href,
        libUrl: new URL('../src/ops/engage/adapters/page-lib.mjs', import.meta.url).href, url: pageUrl('douyin-comments-picker.html', { mode: 'ok' }), work, opts, then },
      script: `const m = await import(params.adapterUrl); const L = await import(params.libUrl);
const page = await L.mainPage(task); await L.open(page, params.url); await L.sleep(1500);
const r = await m.switchTo(page, params.work, params.opts); await L.sleep(1500);
const afterFirst = await page.evaluate(() => window.__probe());
const r2 = params.then ? await m.switchTo(page, params.then) : null; if (params.then) await L.sleep(1500);
return { r, r2, afterFirst, probe: await page.evaluate(() => window.__probe()) };` });
      assert.equal(res.ok, true, `${res.reason}: ${res.error}`);
      return res.result;
    };
    test('读适配器 switchTo：等作品列表出来、翻到第 3 页切过去', async () => {
      const x = await switchTo('w44');
      assert.equal(x.r.ok, true, JSON.stringify(x.r));
      assert.equal(x.probe.current, 'w44');
      assert.equal(x.probe.sendClicks, 0);
    });
    test('读适配器 switchTo：没有这个作品时 ok:false 并写明原因', async () => {
      const x = await switchTo('w99');
      assert.equal(x.r.ok, false);
      assert.match(x.r.detail, /到底/);
      assert.equal(x.probe.current, 'w00');
    });
    test('读适配器 switchTo：没找到时关掉抽屉，下一个作品照常切过去', async () => {
      const x = await switchTo('w99', {}, 'w44');
      assert.equal(x.r.ok, false);
      assert.equal(x.afterFirst.drawerOpen, false);
      assert.equal(x.r2.ok, true, JSON.stringify(x.r2));
      assert.equal(x.probe.current, 'w44');
    });
  });

  describe('视频号', () => {
    const s = space('chw');
    const base = { uid: 'v2_me', nickname: '麦田测试号', test: { loginFromPage: true } };
    const TEXT = '感谢关注～';
    const reply = (mode, target = {}, extra = {}) => write(s, 'channels.mjs', { ...base, op: 'reply', text: TEXT,
      target: { commentId: 'cc1', workId: 'n2', parentId: null, rootId: 'cc1', authorUid: null, authorNickname: '甲', commentText: '视频号评论一', ...target },
      urls: { comments: pageUrl('channels-comments.html', { mode }) }, ...extra });
    const dm = (mode, extra = {}) => write(s, 'channels.mjs', { ...base, op: 'sendDM', text: '你好，在的',
      target: { conversationId: 's_1', peerUid: 'peer_a', peerNickname: '甲' }, urls: { dms: pageUrl('channels-dms.html', { mode }) }, ...extra });

    test('导出 FILE 和真实页面地址', async () => {
      const m = await import(moduleUrl('channels.mjs'));
      assert.equal(m.FILE, 'channels.mjs');
      assert.match(m.PAGES.comments, /^https:\/\/channels\.weixin\.qq\.com\//);
      assert.match(m.PAGES.dms, /^https:\/\/channels\.weixin\.qq\.com\//);
    });

    test('回复一楼：切到目标作品、只点一次发送、回读到一条，不点赞', async () => {
      const x = await reply('ok');
      assertSent(x, 'new1');
      assert.equal(x.r.uidSeen, 'v2_me');
      assert.equal(x.probe.likeClicks, 0);
      assert.equal(x.probe.hiddenClicks, 0);
      assert.deepEqual(x.probe.mine, [{ commentId: 'new1', text: TEXT, replyCommentId: 'cc1' }]);
    });
    test('回复二楼：回复对象是那条二楼', async () => {
      const x = await reply('ok', { commentId: 'cc1r1', parentId: 'cc1', authorNickname: '乙', commentText: '二楼一条' });
      assertSent(x, 'new1');
      assert.deepEqual(x.probe.mine, [{ commentId: 'new1', text: TEXT, replyCommentId: 'cc1r1' }]);
    });
    test('uid 不符：不输入', async () => { const x = await reply('ok', {}, { uid: 'v2_other' }); assertNoSend(x, 'uid-mismatch'); assert.deepEqual(x.probe.boxes, []); });
    test('读不到登录账号：no-uid', async () => assertNoSend(await reply('nouid'), 'no-uid'));
    test('目标评论已删除：comment-gone', async () => assertNoSend(await reply('gone'), 'comment-gone'));
    test('已有我的回复（按昵称判）：already-replied', async () => assertNoSend(await reply('replied'), 'already-replied'));
    test('展开到上限还有「展开更多回复」：thread-incomplete，不发', async () => assertNoSend(await reply('stuck', {}, { maxExpand: 2 }), 'thread-incomplete'));
    test('作品里找不到目标评论：target-not-found', async () => assertNoSend(await reply('ok', { commentId: 'nope' }), 'target-not-found'));
    test('输入框内容不一致：input-mismatch，框已清空', async () => { const x = await reply('mangle'); assertNoSend(x, 'input-mismatch'); assertCleared(x); });
    test('点了发送但回读不到', async () => { const x = await reply('silent'); assertNotReadBack(x); assert.equal(x.r.sendError, undefined); });
    test('页面报错：sendError', async () => { const x = await reply('fail'); assertNotReadBack(x); assert.match(x.r.sendError, /回复失败/); });
    // 2026-11-21 真实页面：发送按钮是 .create-ft 里文字「评论」的 tag-wrap，没字时带 disabled class
    test('输入后「评论」仍是 disabled：cannot-send，框已清空，不点', async () => { const x = await reply('locked'); assertNoSend(x, 'cannot-send'); assertCleared(x); assert.equal(x.probe.hiddenClicks, 0); });

    test('私信：只点一次发送、回读到一条', async () => {
      const x = await dm('ok');
      assertSent(x, 'nm1');
      assert.deepEqual(x.probe.mine, [{ session: 's_1', text: '你好，在的' }]);
    });
    test('私信：点开的不是目标会话 → target-not-found，不发', async () => assertNoSend(await dm('swap'), 'target-not-found'));
    test('私信：最后一句是我 → last-is-me', async () => assertNoSend(await dm('lastme'), 'last-is-me'));
    test('私信：没有输入框 → no-input-box', async () => assertNoSend(await dm('nobox'), 'no-input-box'));
    test('私信：回读不到', async () => assertNotReadBack(await dm('silent')));
    test('私信：输入框内容不一致 → input-mismatch', async () => { const x = await dm('mangle'); assertNoSend(x, 'input-mismatch'); assertCleared(x); });
  });

  describe('小红书', () => {
    const s = space('xhsw');
    // 小红书读登录账号走真实读法（页面 __INITIAL_STATE__），不用测试钩子
    const base = { uid: 'me_x', nickname: '麦田测试号' };
    const TEXT = '谢谢喜欢～';
    const reply = (mode, target = {}, extra = {}) => write(s, 'xhs.mjs', { ...base, op: 'reply', text: TEXT,
      target: { commentId: 'xc1', workId: 'note1', parentId: null, rootId: 'xc1', authorUid: 'u1', authorNickname: '甲', commentText: '小红书评论一，写得真好', ...target },
      urls: { comments: pageUrl('xhs-comments.html', { mode }) }, ...extra });
    const dm = (mode, extra = {}) => write(s, 'xhs.mjs', { ...base, op: 'sendDM', text: '你好呀',
      target: { conversationId: 'p1', peerUid: 'p1', peerNickname: '甲' }, urls: { dms: pageUrl('xhs-dms.html', { mode, peer: 'p1' }) }, ...extra });

    test('导出 FILE 和真实页面地址', async () => {
      const m = await import(moduleUrl('xhs.mjs'));
      assert.equal(m.FILE, 'xhs.mjs');
      assert.match(m.PAGES.comments, /^https:\/\/www\.xiaohongshu\.com\/notification/);
      assert.match(m.PAGES.dms, /^https:\/\/www\.xiaohongshu\.com\/chat/);
    });

    test('回复通知里的评论：只点一次发送，按接口响应回读到一条，结果里没有 xsec_token', async () => {
      const x = await reply('ok');
      assertSent(x, 'newc1');
      assert.equal(x.r.uidSeen, 'me_x');
      assert.doesNotMatch(JSON.stringify(x.r), /tok-should-not-leak/);
    });
    test('uid 不符：不输入', async () => { const x = await reply('ok', {}, { uid: 'someone' }); assertNoSend(x, 'uid-mismatch'); assert.deepEqual(x.probe.boxes, []); });
    test('读不到登录账号：no-uid', async () => assertNoSend(await reply('nouid'), 'no-uid'));
    test('目标评论已删除：comment-gone', async () => assertNoSend(await reply('gone'), 'comment-gone'));
    test('已有我的回复：already-replied', async () => assertNoSend(await reply('replied'), 'already-replied'));
    test('通知里没有这条：target-not-found', async () => assertNoSend(await reply('ok', { commentId: 'nope' }), 'target-not-found'));
    test('目标是纯图片评论（正文为空，不能按正文唯一定位）：target-not-found，不发', async () => assertNoSend(await reply('img', { commentText: '' }), 'target-not-found'));
    test('读不到自己的昵称（判断不了已回复）：no-uid，不发', async () => assertNoSend(await reply('nonick', {}, { nickname: null }), 'no-uid'));
    test('输入框内容不一致：input-mismatch，框已清空', async () => { const x = await reply('mangle'); assertNoSend(x, 'input-mismatch'); assertCleared(x); });
    test('点了发送但回读不到', async () => { const x = await reply('silent'); assertNotReadBack(x); assert.equal(x.r.sendError, undefined); });
    test('接口 code≠0：sendError', async () => { const x = await reply('fail'); assertNotReadBack(x); assert.match(x.r.sendError, /code=-9131|评论失败/); });

    test('私信：只点一次发送、回读到一条', async () => assertSent(await dm('ok'), 'sm1'));
    test('私信：最后一句是我 → last-is-me', async () => assertNoSend(await dm('lastme'), 'last-is-me'));
    test('私信：官方号没有输入框 → cannot-send', async () => assertNoSend(await dm('official'), 'cannot-send'));
    test('私信：没有输入框 → no-input-box', async () => assertNoSend(await dm('nobox'), 'no-input-box'));
    test('私信：uid 不符', async () => assertNoSend(await dm('ok', { uid: 'someone' }), 'uid-mismatch'));
    test('私信：接口报错 → sendError', async () => { const x = await dm('fail'); assertNotReadBack(x); assert.ok(x.r.sendError); });
    test('私信：输入框内容不一致 → input-mismatch', async () => { const x = await dm('mangle'); assertNoSend(x, 'input-mismatch'); assertCleared(x); });
  });
});
