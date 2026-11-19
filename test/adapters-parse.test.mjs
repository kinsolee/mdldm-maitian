// 四个平台的解析函数吃脱敏样例（test/fixtures/engage/，真实页面 JSON 的脱敏版），输出符合约定形状，层级、isMe、last.by、threadsPartial 和原始数据一致。
// 期望值是从样例里挑出来的具体记录（id 原样保留；昵称、uid 换成了 user_<sha256 前 8 位>）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { shapeErrors } from '../src/ops/engage/adapters/shape.mjs';
import * as bili from '../src/ops/engage/adapters/bili.mjs';
import * as douyin from '../src/ops/engage/adapters/douyin.mjs';
import * as channels from '../src/ops/engage/adapters/channels.mjs';
import * as xhs from '../src/ops/engage/adapters/xhs.mjs';

const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/engage/${name}.json`, import.meta.url), 'utf8'));
const fetchedAt = '2026-11-19T13:00:00.000Z';
// 样例里各账号自己的 uid（脱敏后）
const ME = { Bili: 'user_8f127407', Douyin: 'user_68f33f7a', Channels: 'user_c20ee8c3', XiaoHongShu: 'user_de0cde99' };

function assertShape(r) {
  assert.deepEqual(shapeErrors(r), []);
  const ids = new Set(r.comments.map((c) => c.nativeId));
  assert.equal(ids.size, r.comments.length, '评论 id 不重复');
  for (const c of r.comments) if (c.parentNativeId) assert.notEqual(c.rootNativeId, c.nativeId);
}
const byId = (r) => new Map(r.comments.map((c) => [c.nativeId, c]));

test('B站评论：rpid/root/parent 原样当原生 id 和 parent，isMe 按 mid', () => {
  const r = bili.parse('comments', fixture('bili-comments'), { accountUid: ME.Bili, fetchedAt });
  assertShape(r);
  const m = byId(r);
  const deep = m.get('324410072800');
  assert.deepEqual([deep.rootNativeId, deep.parentNativeId], ['323306804048', '323955183696']);
  assert.equal(deep.author.uid, 'user_4b59451a');
  const root = m.get('320534516305');
  assert.deepEqual([root.parentNativeId, root.rootNativeId], [null, '320534516305']);
  const mine = m.get('324327537808');
  assert.equal(mine.author.isMe, true);
  assert.equal(mine.parentNativeId, '320534516305', '直接回复一楼的挂一楼');
  assert.equal(mine.replyTo, null);
  assert.ok(r.works.some((w) => w.nativeId === 'BV1sYWd6hEev' && w.url === 'https://www.bilibili.com/video/BV1sYWd6hEev' && w.postTime));
  // 样例只截了 fulllist 前两页（reachedEnd=false）：拿到的楼完整，但作品不算这一轮拿全
  assert.ok(r.scannedWorks.length > 0 && r.scannedWorks.every((s) => s.complete === false && s.threadsPartial === false));
});

test('B站私信：last.by 按发送方 uid，系统通知会话是 official、不能回', () => {
  const r = bili.parse('dms', fixture('bili-dms'), { accountUid: ME.Bili, fetchedAt });
  assertShape(r);
  const c = new Map(r.conversations.map((x) => [x.nativeId, x]));
  assert.equal(c.get('user_b39253ec').last.by, 'peer');
  assert.equal(c.get('user_fea647b8').last.by, 'peer');
  assert.equal(c.get('user_1a4dd8ff').last.by, 'me');
  assert.deepEqual([c.get('user_ca6d6f7e').peer.kind, c.get('user_ca6d6f7e').canSend], ['official', false]);
  assert.equal(c.get('user_b39253ec').peer.kind, 'user');
  assert.ok(r.conversations.filter((x) => x.peer.kind === 'user').every((x) => x.peer.nickname), '用户会话的昵称从 user/cards 补上');
  assert.ok(r.messages.length > 0 && r.messages.every((x) => c.has(x.conversationNativeId)));
});

test('抖音评论：reply_id 是一楼，reply_to_reply_id 是直接回复的那条（"0" 挂一楼）', () => {
  const r = douyin.parse('comments', fixture('douyin-comments'), { accountUid: ME.Douyin, fetchedAt });
  assertShape(r);
  const m = byId(r);
  const deep = m.get('7709312548901864249');
  assert.deepEqual([deep.rootNativeId, deep.parentNativeId], ['7709180408285365049', '7709190237947888427']);
  assert.deepEqual(deep.replyTo, { uid: ME.Douyin, nickname: deep.replyTo.nickname });
  assert.equal(deep.author.isMe, false);
  const toRoot = m.get('7709190237947888427');
  assert.deepEqual([toRoot.parentNativeId, toRoot.author.isMe, toRoot.replyTo], ['7709180408285365049', true, null]);
  assert.equal(m.get('7709180408285365049').parentNativeId, null);
  const sw = new Map(r.scannedWorks.map((s) => [s.workNativeId, s]));
  assert.deepEqual(sw.get('7708984451971452170'), { workNativeId: '7708984451971452170', complete: true, threadsPartial: false });
  // 这个作品还剩一个「查看 N 条回复」没展开出来：楼中楼拿不全
  assert.deepEqual(sw.get('7706755631885126912'), { workNativeId: '7706755631885126912', complete: false, threadsPartial: true });
  assert.ok(r.works.every((w) => w.url === `https://www.douyin.com/video/${w.nativeId}` && w.postTime));
});

test('抖音私信：lastMessage.isFromMe 判 last.by，消息至少放最后一条', () => {
  const r = douyin.parse('dms', fixture('douyin-dms'), { accountUid: ME.Douyin, fetchedAt });
  assertShape(r);
  const c = r.conversations;
  assert.deepEqual(c.slice(0, 3).map((x) => x.last.by), ['peer', 'peer', 'me']);
  assert.equal(c[0].last.type, 'share');
  assert.equal(c[1].last.type, 'text');
  assert.equal(c[0].last.at, new Date(1795075878978).toISOString());
  assert.equal(c[0].unread, 1);
  assert.equal(r.messages.length, c.filter((x) => x.last).length);
});

test('视频号评论：replyCommentId 指向谁挂谁，二楼单独渲染的那份去重，isMe 按 finderUser 昵称', () => {
  const raw = fixture('channels-comments');
  const r = channels.parse('comments', raw, { accountUid: ME.Channels, fetchedAt });
  assertShape(r);
  const m = byId(r);
  const deep = m.get('15050954164908136460');
  assert.deepEqual([deep.rootNativeId, deep.parentNativeId], ['15050946807626536999', '15050949321207319916']);
  assert.equal(deep.replyTo.nickname, m.get('15050949321207319916').author.nickname);
  assert.equal(m.get('15050949321207319916').parentNativeId, '15050946807626536999');
  const mine = r.comments.filter((c) => c.author.isMe);
  assert.ok(mine.length > 0 && mine.every((c) => c.author.nickname === raw.me.nickname));
  assert.ok(r.comments.every((c) => c.author.uid === null), '视频号不给评论者 uid');
  assert.ok(r.scannedWorks.every((s) => s.complete && !s.threadsPartial));
  // 每个作品的评论数和作品列表上的评论数一致
  for (const w of raw.works) assert.equal(r.comments.filter((c) => c.workNativeId === w.objectNonce).length, raw.feeds.find((f) => f.objectNonce === w.objectNonce).commentCount);
});

test('视频号私信：messageList 新到旧，取 ts 最大的判 last.by', () => {
  const r = channels.parse('dms', fixture('channels-dms'), { accountUid: ME.Channels, fetchedAt });
  assertShape(r);
  const c = new Map(r.conversations.map((x) => [x.nativeId, x]));
  assert.deepEqual([c.get('user_2e3ad0ee').last.by, c.get('user_2e3ad0ee').last.at], ['me', new Date(1794931923 * 1000).toISOString()]);
  assert.equal(c.get('user_2e3ad0ee').peer.uid, 'user_6f83a1fe');
  assert.ok(r.messages.some((x) => x.conversationNativeId === 'user_2e3ad0ee' && x.by === 'peer'));
});

test('小红书评论：笔记页整楼，target_comment.id 还原 parent；只在通知里的评论按两层入库并标 threadsPartial', () => {
  const r = xhs.parse('comments', fixture('xhs-comments'), { accountUid: ME.XiaoHongShu, fetchedAt });
  assertShape(r);
  const m = byId(r);
  const sub = m.get('6afc44b70000000032023a42');
  assert.deepEqual([sub.rootNativeId, sub.parentNativeId, sub.author.isMe], ['6afc3f9a000000002f02a289', '6afc3f9a000000002f02a289', true]);
  // comment/sub/page 拉来的子评论按 URL 里的 root_comment_id 归楼
  assert.equal(m.get('6afd06e6000000002f036d96').rootNativeId, '6afc3f9a000000002f02a289');
  assert.equal(m.get('6afb23010000000031015e5c').rootNativeId, '6af84da50000000031023307');
  const sw = new Map(r.scannedWorks.map((s) => [s.workNativeId, s]));
  assert.deepEqual(sw.get('6afbd09e00000000250132bd'), { workNativeId: '6afbd09e00000000250132bd', complete: true, threadsPartial: false });
  // 只出现在 you/mentions 里的笔记
  assert.deepEqual(sw.get('6af3d48c000000002c00ef84'), { workNativeId: '6af3d48c000000002c00ef84', complete: false, threadsPartial: true });
  const fromMention = m.get('6af3d977000000000a01f3df');
  assert.deepEqual([fromMention.parentNativeId, fromMention.rootNativeId], ['6af3d73b00000000140397ed', '6af3d73b00000000140397ed']);
  assert.equal(m.get('6af3d73b00000000140397ed').parentNativeId, null, '被回复的那条当一楼');
  assert.equal(m.get('6af3d61e0000000014001786').parentNativeId, null);
  assert.ok(r.works.every((w) => w.url === `https://www.xiaohongshu.com/explore/${w.nativeId}`));
  assert.doesNotMatch(JSON.stringify(r), /xsec/i);
});

test('小红书评论：二层回复的是同楼另一条子评论时，parent 是那条', () => {
  const raw = fixture('xhs-comments');
  const top = raw.notes[0].pages[0].data.comments[0];
  const first = top.sub_comments[0];
  top.sub_comments.push({ ...first, id: 'synthetic-reply', create_time: first.create_time + 1000, target_comment: { id: first.id, user_info: first.user_info } });
  top.sub_comment_count = String(Number(top.sub_comment_count) + 1);
  const m = byId(xhs.parse('comments', raw, { accountUid: ME.XiaoHongShu, fetchedAt }));
  const x = m.get('synthetic-reply');
  assert.deepEqual([x.rootNativeId, x.parentNativeId], [top.id, first.id]);
  assert.equal(x.replyTo.uid, first.user_info.user_id);
});

test('小红书私信：打开过的会话按 sender_id 判 last.by；没打开的有 since 时不报、没有 since 时 last 为 null', () => {
  const raw = fixture('xhs-dms');
  const r = xhs.parse('dms', raw, { accountUid: ME.XiaoHongShu, fetchedAt });
  assertShape(r);
  const c = new Map(r.conversations.map((x) => [x.nativeId, x]));
  assert.deepEqual([c.get('user_534e71a8').last.by, c.get('user_534e71a8').last.type], ['peer', 'share']);
  assert.equal(c.get('user_f4800048').last.by, 'me');
  assert.equal(c.get('user_f05d5380').last, null);
  assert.equal(r.conversations.length, raw.chats.length);
  const withSince = xhs.parse('dms', raw, { accountUid: ME.XiaoHongShu, fetchedAt, since: '2026-11-18T00:00:00.000Z' });
  assert.equal(withSince.conversations.length, raw.histories.length);
});

test('解析前先认 kind：原始数据和 kind 对不上就抛错', () => {
  assert.throws(() => bili.parse('dms', fixture('bili-comments'), { accountUid: ME.Bili, fetchedAt }));
  assert.throws(() => xhs.parse('comments', { nothing: true }, { accountUid: ME.XiaoHongShu, fetchedAt }));
});
