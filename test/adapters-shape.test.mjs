// 两层平台「回复 @某人」还原 parent 的规则，和输出形状校验本身。
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveParents, shapeErrors } from '../src/ops/engage/adapters/shape.mjs';

const c = (nativeId, createdAt, author, extra = {}) => ({
  nativeId, workNativeId: 'w1', rootNativeId: 'r1', parentNativeId: undefined,
  author: { uid: author.uid ?? null, nickname: author.nickname, isMe: false }, replyTo: null,
  text: 'x', createdAt, likeCount: null, likedByMe: null, pinned: null, replyCount: null, ipLabel: null, ...extra,
});
const root = { ...c('r1', '2026-11-18T00:00:00.000Z', { uid: 'u1', nickname: '甲' }), parentNativeId: null };

test('回复 @某人：按被回复者 uid 找同楼最近一条更早的评论', () => {
  const list = [
    root,
    c('a', '2026-11-18T01:00:00.000Z', { uid: 'u2', nickname: '乙' }),
    c('b', '2026-11-18T02:00:00.000Z', { uid: 'u2', nickname: '乙' }),
    c('d', '2026-11-18T03:00:00.000Z', { uid: 'u3', nickname: '丙' }, { replyTo: { uid: 'u2', nickname: '乙' } }),
    c('late', '2026-11-18T04:00:00.000Z', { uid: 'u2', nickname: '乙' }),
  ];
  const byId = Object.fromEntries(resolveParents(list).map((x) => [x.nativeId, x.parentNativeId]));
  assert.equal(byId.d, 'b', '取更早的里最近的一条，不取更晚的 late');
  assert.equal(byId.a, 'r1', '没有回复对象的二层挂一楼');
  assert.equal(byId.r1, null);
});

test('回复 @某人：没有 uid 时按昵称找；找不到挂一楼', () => {
  const list = [
    root,
    c('a', '2026-11-18T01:00:00.000Z', { nickname: '乙' }),
    c('b', '2026-11-18T02:00:00.000Z', { nickname: '丙' }, { replyTo: { uid: null, nickname: '乙' } }),
    c('e', '2026-11-18T03:00:00.000Z', { nickname: '丙' }, { replyTo: { uid: null, nickname: '查无此人' } }),
    c('f', '2026-11-18T03:30:00.000Z', { nickname: '丁' }, { replyTo: { uid: null, nickname: '甲' } }),
  ];
  const byId = Object.fromEntries(resolveParents(list).map((x) => [x.nativeId, x.parentNativeId]));
  assert.equal(byId.b, 'a');
  assert.equal(byId.e, 'r1');
  assert.equal(byId.f, 'r1', '回复的是一楼作者，就挂一楼');
});

test('回复 @某人：平台给了直接 parent 的不改', () => {
  const list = [root, c('a', '2026-11-18T01:00:00.000Z', { uid: 'u2', nickname: '乙' }, { parentNativeId: 'r1' }),
    c('b', '2026-11-18T02:00:00.000Z', { uid: 'u3', nickname: '丙' }, { parentNativeId: 'r1', replyTo: { uid: 'u2', nickname: '乙' } })];
  assert.equal(resolveParents(list).find((x) => x.nativeId === 'b').parentNativeId, 'r1');
});

test('形状校验能抓出缺字段和类型错误', () => {
  const ok = { ok: true, platformCode: 'Bili', accountUid: '1', kind: 'comments', fetchedAt: '2026-11-19T00:00:00.000Z', works: [], comments: [root], scannedWorks: [], conversations: [], messages: [] };
  assert.deepEqual(shapeErrors(ok), []);
  assert.ok(shapeErrors({ ...ok, comments: [{ ...root, nativeId: 1 }] }).length > 0, '原生 id 必须是字符串');
  assert.ok(shapeErrors({ ...ok, comments: [{ ...root, rootNativeId: undefined }] }).length > 0);
  assert.ok(shapeErrors({ ...ok, conversations: [{ nativeId: 'c', peer: { uid: 'p', nickname: 'n', kind: 'bot' }, unread: 0, last: null, canSend: true }] }).length > 0, 'peer.kind 只能是 user/official/group');
});
