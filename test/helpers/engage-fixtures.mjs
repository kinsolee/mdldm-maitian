// engage 测试共用：临时 ops.db、账号、适配器输出的构造器。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openOpsDb } from '../../src/ops/db.mjs';
import { importAccounts, getAccount } from '../../src/ops/accounts.mjs';

export const SEED = path.resolve(import.meta.dirname, '../../src/ops/accounts.seed.json');
export const tmpDbFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'engage-test-')), 'ops.db');

export function freshDb(file = tmpDbFile()) {
  const db = openOpsDb(file);
  importAccounts(db, SEED);
  return db;
}
export const douyin = (db) => getAccount(db, 'Douyin:106707338905');

export const T0 = Date.parse('2026-11-19T02:00:00Z');
export const MIN = 60_000;
export const at = (ms) => () => ms;

export function comment(nativeId, o = {}) {
  return {
    nativeId, workNativeId: o.work ?? 'w1', parentNativeId: o.parent ?? null, rootNativeId: o.root ?? (o.parent ? null : nativeId),
    author: { uid: o.uid ?? `u-${nativeId}`, nickname: o.nick ?? `昵称${nativeId}`, isMe: o.isMe ?? false },
    replyTo: o.replyTo ?? null, text: o.text ?? `评论${nativeId}`, createdAt: o.createdAt ?? '2026-11-19T01:00:00.000Z',
    likeCount: o.likeCount ?? 0, likedByMe: o.likedByMe ?? false, pinned: o.pinned ?? false, replyCount: o.replyCount ?? 0, ipLabel: o.ipLabel ?? null,
  };
}

export function commentsSnap(comments, o = {}) {
  const works = o.works ?? [{ nativeId: 'w1', title: '作品一', url: 'https://example.test/w1', postTime: '2026-11-18T00:00:00.000Z' }];
  return { ok: true, platformCode: 'Douyin', accountUid: '106707338905', kind: 'comments', fetchedAt: '2026-11-19T02:00:00.000Z',
    works, comments, scannedWorks: o.scanned ?? works.map((w) => ({ workNativeId: w.nativeId, complete: true, threadsPartial: false })),
    conversations: [], messages: [] };
}

export function conv(nativeId, o = {}) {
  return { nativeId, peer: { uid: `p-${nativeId}`, nickname: o.nick ?? `对方${nativeId}`, kind: 'user' }, unread: o.unread ?? 1,
    last: o.last === null ? null : { by: o.by ?? 'peer', at: o.at ?? '2026-11-19T01:00:00.000Z', text: o.text ?? '你好', type: 'text' }, canSend: true };
}

export function dmsSnap(conversations, messages = []) {
  return { ok: true, platformCode: 'Douyin', accountUid: '106707338905', kind: 'dms', fetchedAt: '2026-11-19T02:00:00.000Z',
    works: [], comments: [], scannedWorks: [], conversations, messages };
}
