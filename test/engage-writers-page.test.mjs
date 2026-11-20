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
    test('私信：没有输入框 → no-input-box', async () => assertNoSend(await dm('nobox'), 'no-input-box'));
    test('私信：uid 不符', async () => assertNoSend(await dm('ok', { uid: '999' }), 'uid-mismatch'));
    test('私信：页面报错 → sendError', async () => { const x = await dm('fail'); assertNotReadBack(x); assert.match(x.r.sendError, /发送失败/); });
    test('私信：输入框内容不一致 → input-mismatch', async () => { const x = await dm('mangle'); assertNoSend(x, 'input-mismatch'); assertCleared(x); });
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
      assert.deepEqual(x.probe.mine, [{ commentId: 'new1', text: TEXT, replyCommentId: null }]);
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

    test('私信：只点一次发送、回读到一条', async () => {
      const x = await dm('ok');
      assertSent(x, 'nm1');
      assert.deepEqual(x.probe.mine, [{ session: 's_1', text: '你好，在的' }]);
    });
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
