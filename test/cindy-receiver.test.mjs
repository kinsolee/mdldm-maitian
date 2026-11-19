// Cindy 接收端（integrations/cindy）：验签、去重进收件箱、前置检查只看不取、对照文件写成功才标已处理、
// 补漏、对照报告只读，以及麦田真实发件箱（deliverPending）和 OpenBot 同时订阅时的整条链路。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { createReceiver, backfillOnce, mcpListEvents, HOOK_PATH, BACKFILL_OVERLAP_MS } from '../integrations/cindy/receiver.mjs';
import { openInbox } from '../integrations/cindy/store.mjs';
import { recordResults, readLedger } from '../integrations/cindy/ledger.mjs';
import { run, PRECHECK_OK } from '../integrations/cindy/inbox.mjs';
import { readConfig, readPaths } from '../integrations/cindy/config.mjs';
import { buildReport, renderReport, idsBySection, main as compareMain } from '../integrations/cindy/compare.mjs';
import { subscribe } from '../src/ops/engage/subscribers.mjs';
import { ingestSnapshot } from '../src/ops/engage/store.mjs';
import { ackEvent } from '../src/ops/engage/query.mjs';
import { deliverPending } from '../src/daemon/outbox.mjs';
import { freshDb, douyin, tmpDbFile, comment, commentsSnap, T0, MIN, at } from './helpers/engage-fixtures.mjs';

const SECRET = 'b'.repeat(64);
const SUB = 'cindy-engage';
const MCP = path.resolve(import.meta.dirname, '../src/mcp/server.mjs');
const sign = (secret, raw) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-recv-'));
const ev = (id, o = {}) => ({ id, type: o.type ?? 'comment.created', platform: 'Douyin', subjectId: `Douyin:${id}`, createdAt: o.createdAt ?? '2026-11-19T02:00:00.000Z',
  payload: { text: `正文${id}`, nickname: `昵称${id}`, ...(o.conversationId ? { conversationId: o.conversationId } : {}) } });

async function listen(handler, port = 0) {
  const server = http.createServer(handler);
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${server.address().port}${HOOK_PATH}`;
  return { server, url, close: () => { server.closeAllConnections(); return new Promise((ok) => server.close(ok)); } };
}

async function start({ secret = SECRET, now = Date.now } = {}) {
  const inbox = openInbox(':memory:');
  const r = createReceiver({ secret, subscriberId: SUB, inbox, log: () => {}, now });
  const s = await listen(r.handler);
  const post = (body, { sig, raw } = {}) => {
    const data = raw ?? Buffer.from(JSON.stringify(body));
    return fetch(s.url, { method: 'POST', body: data, headers: { 'Content-Type': 'application/json', 'X-Maitian-Signature': sig ?? sign(secret, data) } });
  };
  return { inbox, post, ...s };
}

function paths() {
  const dir = tmpDir();
  return { dir, stateDb: path.join(dir, 'inbox.db'), ledger: path.join(dir, '数据', '麦田事件对照-Cindy.jsonl') };
}

describe('接收端', () => {
  test('验签通过的推送进收件箱、回 200；只存 id 和引用，不存正文', async () => {
    const t = await start();
    const res = await t.post({ subscriberId: SUB, events: [ev('c1'), ev('d1', { type: 'dm.received', conversationId: 'Douyin:conv1' })] });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, accepted: 2, duplicate: 0 });
    const rows = t.inbox.all();
    assert.deepEqual(rows.map((r) => [r.id, r.platform, r.subjectId, r.conversationId, r.source, r.processedAt]),
      [['c1', 'Douyin', 'Douyin:c1', null, 'push', null], ['d1', 'Douyin', 'Douyin:d1', 'Douyin:conv1', 'push', null]]);
    assert.ok(!JSON.stringify(rows).includes('正文'));
    await t.close();
  });

  test('签名不对回 401，不进收件箱', async () => {
    const t = await start();
    const res = await t.post({ subscriberId: SUB, events: [ev('c1')] }, { sig: sign('x'.repeat(64), Buffer.from('{}')) });
    assert.equal(res.status, 401);
    assert.equal(t.inbox.stats().total, 0);
    await t.close();
  });

  test('订阅方不对、事件缺 id 整批拒收', async () => {
    const t = await start();
    assert.equal((await t.post({ subscriberId: 'openbot-engage', events: [ev('c1')] })).status, 400);
    assert.equal((await t.post({ subscriberId: SUB, events: [ev('c1'), { type: 'comment.created' }] })).status, 400);
    assert.equal(t.inbox.stats().total, 0);
    await t.close();
  });

  test('同一事件重推只算一条', async () => {
    const t = await start();
    await t.post({ subscriberId: SUB, events: [ev('c1')] });
    const res = await t.post({ subscriberId: SUB, events: [ev('c1'), ev('c2')] });
    assert.deepEqual(await res.json(), { ok: true, accepted: 1, duplicate: 1 });
    assert.equal(t.inbox.stats().total, 2);
    await t.close();
  });

  test('/health 只给条数', async () => {
    const t = await start();
    await t.post({ subscriberId: SUB, events: [ev('c1')] });
    const res = await fetch(t.url.replace(HOOK_PATH, '/health'));
    assert.deepEqual(await res.json(), { ok: true, total: 1, processed: 0, pending: 1 });
    await t.close();
  });
});

describe('inbox.mjs：前置检查和待处理列表', () => {
  test('收件箱还没建：exit 2，跳过本轮', () => {
    const p = paths();
    const r = run(['check'], { paths: p });
    assert.equal(r.code, 2);
    assert.ok(r.out.endsWith(PRECHECK_OK));
    assert.equal(fs.existsSync(p.stateDb), false);
  });

  test('有事件 exit 0、没有 exit 2；检查不消费', () => {
    const p = paths();
    const inbox = openInbox(p.stateDb);
    assert.equal(run(['check'], { paths: p }).code, 2);
    inbox.receive([ev('c1'), ev('c2')], T0);
    for (let i = 0; i < 3; i++) {
      const r = run(['check'], { paths: p });
      assert.equal(r.code, 0);
      assert.match(r.out, /待处理 2 条/);
    }
    assert.equal(inbox.pendingCount(), 2);
    const list = JSON.parse(run(['pending', '1'], { paths: p }).out);
    assert.deepEqual(list.map((e) => e.id), ['c1']);
    assert.equal(inbox.pendingCount(), 2);
    inbox.close();
  });

  test('pending 条数不合法、未知命令都是 exit 1', () => {
    const p = paths();
    assert.equal(run(['pending', '0'], { paths: p }).code, 1);
    assert.equal(run(['ack'], { paths: p }).code, 1);
  });
});

describe('对照文件', () => {
  test('写成功才标已处理；只写五个字段', () => {
    const p = paths();
    const inbox = openInbox(p.stateDb);
    inbox.receive([ev('c1'), ev('c2')], T0);
    const r = run(['record'], { paths: p, stdin: JSON.stringify([{ eventId: 'c1', category: '建议回复', suggestedReply: '可以，\n按话术 A 来' }]), now: at(T0 + MIN) });
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { appended: 1, duplicate: 0, rejected: [] });
    const lines = fs.readFileSync(p.ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines, [{ eventId: 'c1', platform: 'Douyin', category: '建议回复', suggestedReply: '可以， 按话术 A 来', processedAt: new Date(T0 + MIN).toISOString() }]);
    assert.deepEqual(inbox.pending().map((e) => e.id), ['c2']);
    inbox.close();
  });

  test('对照文件里已有的不再追加，只补标已处理（上一轮写了文件没来得及标）', () => {
    const p = paths();
    const inbox = openInbox(p.stateDb);
    inbox.receive([ev('c1')], T0);
    fs.mkdirSync(path.dirname(p.ledger), { recursive: true });
    fs.writeFileSync(p.ledger, `${JSON.stringify({ eventId: 'c1', platform: 'Douyin', category: '跳过', suggestedReply: '', processedAt: 'x' })}\n`);
    const r = recordResults({ inbox, file: p.ledger, results: [{ eventId: 'c1', category: '广告' }, { eventId: 'c1', category: '广告' }], now: at(T0) });
    assert.deepEqual(r, { appended: 0, duplicate: 2, rejected: [] });
    assert.equal(fs.readFileSync(p.ledger, 'utf8').trim().split('\n').length, 1);
    assert.equal(inbox.pendingCount(), 0);
    inbox.close();
  });

  test('同一批里重复的 id 只写一行', () => {
    const p = paths();
    const inbox = openInbox(p.stateDb);
    inbox.receive([ev('c1')], T0);
    const r = recordResults({ inbox, file: p.ledger, results: [{ eventId: 'c1', category: '跳过' }, { eventId: 'c1', category: '跳过' }], now: at(T0) });
    assert.deepEqual(r, { appended: 1, duplicate: 1, rejected: [] });
    assert.equal(readLedger(p.ledger).size, 1);
    inbox.close();
  });

  test('不合格的不写、不标；合格的照写', () => {
    const p = paths();
    const inbox = openInbox(p.stateDb);
    inbox.receive([ev('c1'), ev('c2'), ev('c3')], T0);
    const r = run(['record'], { paths: p, stdin: JSON.stringify([
      { eventId: 'nope', category: '跳过' },
      { eventId: 'c1', category: '回复' },
      { eventId: 'c2', category: '新问题' },
      { eventId: 'c3', category: '广告' },
    ]) });
    assert.equal(r.code, 1);
    const out = JSON.parse(r.out);
    assert.equal(out.appended, 1);
    assert.deepEqual(out.rejected.map((x) => x.eventId), ['nope', 'c1', 'c2']);
    assert.deepEqual(inbox.pending().map((e) => e.id), ['c1', 'c2']);
    inbox.close();
  });

  test('写失败：抛错，一条都不标已处理', () => {
    const p = paths();
    const inbox = openInbox(p.stateDb);
    inbox.receive([ev('c1')], T0);
    fs.mkdirSync(p.ledger, { recursive: true });   // 对照文件位置是个目录，写不进去
    assert.throws(() => recordResults({ inbox, file: p.ledger, results: [{ eventId: 'c1', category: '跳过' }] }));
    assert.equal(inbox.pendingCount(), 1);
    inbox.close();
  });

  test('上次写到半行：新行另起一行，半行不算数', () => {
    const p = paths();
    const inbox = openInbox(p.stateDb);
    inbox.receive([ev('c1')], T0);
    fs.mkdirSync(path.dirname(p.ledger), { recursive: true });
    fs.writeFileSync(p.ledger, '{"eventId":"c1","plat');
    const r = recordResults({ inbox, file: p.ledger, results: [{ eventId: 'c1', category: '跳过' }] });
    assert.equal(r.appended, 1);
    assert.deepEqual([...readLedger(p.ledger).keys()], ['c1']);
    inbox.close();
  });

  test('stdin 不是 JSON：exit 1，不建对照文件', () => {
    const p = paths();
    openInbox(p.stateDb).close();
    assert.equal(run(['record'], { paths: p, stdin: 'oops' }).code, 1);
    assert.equal(fs.existsSync(p.ledger), false);
  });
});

describe('补漏', () => {
  test('从收件箱最新一条往前退 2 小时起翻页读，已有的不重复收', async () => {
    const inbox = openInbox(':memory:');
    inbox.receive([ev('c1', { createdAt: '2026-11-19T05:00:00.000Z' })], T0);
    const calls = [];
    const pages = [
      { items: [ev('c1'), ev('c2')], nextCursor: 'k1' },
      { items: [ev('c3'), { type: 'comment.created' }], nextCursor: null },
    ];
    const n = await backfillOnce({ inbox, types: ['comment.created'], now: at(T0), listEvents: async (a) => { calls.push(a); return pages[calls.length - 1]; } });
    assert.equal(n, 2);
    assert.equal(calls[0].since, new Date(Date.parse('2026-11-19T05:00:00.000Z') - BACKFILL_OVERLAP_MS).toISOString());
    assert.equal(calls[0].cursor, undefined);
    assert.equal(calls[1].cursor, 'k1');
    assert.deepEqual(inbox.all().map((r) => [r.id, r.source]).sort(), [['c1', 'push'], ['c2', 'backfill'], ['c3', 'backfill']]);
    inbox.close();
  });

  test('收件箱空：从现在往前 2 小时起', async () => {
    const inbox = openInbox(':memory:');
    let since;
    await backfillOnce({ inbox, types: ['comment.created'], now: at(T0), listEvents: async (a) => { since = a.since; return { items: [], nextCursor: null }; } });
    assert.equal(since, new Date(T0 - BACKFILL_OVERLAP_MS).toISOString());
    inbox.close();
  });
});

describe('配置', () => {
  test('默认端口 8791、订阅方 cindy-engage、只监听本机地址', () => {
    const c = readConfig({});
    assert.equal(c.port, 8791);
    assert.equal(c.subscriberId, SUB);
    assert.equal(c.url, 'http://127.0.0.1:8791/maitian/hook');
    assert.deepEqual(c.types, ['comment.created', 'dm.received']);
    assert.equal(c.backfillMs, 15 * MIN);
    assert.match(readPaths({}).ledger, /10\.个人IP\/数据\/麦田事件对照-Cindy\.jsonl$/);
    assert.throws(() => readConfig({ RECEIVER_PORT: 'abc' }), /RECEIVER_PORT/);
  });

  test('Cindy 项目自动化文件符合 Cindy 0.1.141 的校验规则，前置检查跑的是 inbox.mjs check', () => {
    const file = path.resolve(import.meta.dirname, '../integrations/cindy/project/.cindy/automations/schedules.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(cfg.version, 1);
    assert.equal(cfg.schedules.length, 1);
    const s = cfg.schedules[0];
    assert.match(s.id, /^[a-z0-9][a-z0-9-]*$/);
    for (const k of ['name', 'prompt', 'cronExpr']) assert.ok(typeof s[k] === 'string' && s[k].trim(), k);
    assert.match(s.preRunHook.command, /integrations\/cindy\/inbox\.mjs check$/);
    assert.ok(Number.isFinite(s.preRunHook.timeoutMs));
    assert.match(s.prompt, /agent-prompt\.md/);
    assert.match(s.prompt, /ack_event/);
  });

  test('Cindy 侧代码不调 ack_event，也不写 OpenBot 的记录和待确认文件', () => {
    const dir = path.resolve(import.meta.dirname, '../integrations/cindy');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.mjs'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.ok(!/name:\s*['"]ack_event['"]/.test(src), `${f} 调了 ack_event`);
      assert.ok(!/(writeFile|appendFile)\w*\([^)]*OPENBOT_/.test(src), `${f} 写了 OpenBot 文件`);
    }
  });
});

describe('对照报告', () => {
  const pendingMd = '# 评论私信待确认\n\n## 新问题\n\n| a | b |\n| --- | --- |\n| x | `comment.created:Douyin:n1` |\n\n## 广告\n\n| x | `comment.created:Douyin:ad1` |\n';
  const recordsMd = '### 2026-11-19 10:00（麦田事件）\n| `comment.created:Douyin:r1` | ... |\n| `comment.created:Douyin:s1` | 跳过 |\n';

  test('idsBySection 认反引号里的完整 id 和所在二级标题', () => {
    const m = idsBySection(pendingMd);
    assert.equal(m.get('comment.created:Douyin:n1'), '新问题');
    assert.equal(m.get('comment.created:Douyin:ad1'), '广告');
  });

  test('分类、延迟、缺漏和不一致', () => {
    const c = (id) => `comment.created:Douyin:${id}`;
    const base = { type: 'comment.created', platformCode: 'Douyin', createdAt: '2026-11-19T02:00:00.000Z' };
    const events = [
      { ...base, id: c('r1'), handledAt: '2026-11-19T02:10:00.000Z', handledOutcome: 'pending_human' },
      { ...base, id: c('s1'), handledAt: '2026-11-19T02:20:00.000Z', handledOutcome: 'skipped' },
      { ...base, id: c('n1'), handledAt: '2026-11-19T02:30:00.000Z', handledOutcome: 'pending_human' },
      { ...base, id: c('ad1'), handledAt: null, handledOutcome: null },
      { ...base, id: c('miss'), handledAt: null, handledOutcome: null },
    ];
    const ledger = new Map([
      [c('r1'), { category: '建议回复', processedAt: '2026-11-19T02:04:00.000Z' }],
      [c('s1'), { category: '跳过', processedAt: '2026-11-19T02:06:00.000Z' }],
      [c('n1'), { category: '建议回复', processedAt: '2026-11-19T02:08:00.000Z' }],
      [c('ad1'), { category: '广告', processedAt: '2026-11-19T02:02:00.000Z' }],
    ]);
    const inboxRows = [c('r1'), c('s1'), c('n1'), c('ad1')].map((id) => ({ id }));
    const r = buildReport({ events, inboxRows, ledger, records: recordsMd, pending: pendingMd, since: 's', until: 'u' });
    assert.equal(r.total, 5);
    assert.equal(r.openbotHandled, 4);
    assert.equal(r.cindyReceived, 4);
    assert.equal(r.cindyRecorded, 4);
    assert.deepEqual(r.missingInCindy, [c('miss')]);
    assert.deepEqual(r.mismatches.map((m) => [m.id, m.openbot, m.cindy]), [[c('n1'), '新问题', '建议回复']]);
    assert.deepEqual(r.openbotDelay, { n: 3, median: 20, p90: 30, max: 30 });
    assert.deepEqual(r.cindyDelay, { n: 4, median: 4, p90: 8, max: 8 });
    const md = renderReport(r);
    assert.match(md, /Cindy 没收到的事件/);
    assert.match(md, /\| `comment\.created:Douyin:n1` \| Douyin \| 新问题 \| 建议回复 \|/);
  });

  test('main 只读：跑完 ops.db、OpenBot 两个文件、收件箱、对照文件都没变', () => {
    const p = paths();
    const opsDb = tmpDbFile();
    const db = freshDb(opsDb);
    ingestSnapshot(db, douyin(db), commentsSnap([comment('r1')]), { now: at(T0) });
    ingestSnapshot(db, douyin(db), commentsSnap([comment('r1'), comment('r2')]), { now: at(T0 + MIN) });
    db.close();
    const inbox = openInbox(p.stateDb);
    inbox.receive([ev('comment.created:Douyin:r2')], T0);
    recordResults({ inbox, file: p.ledger, results: [{ eventId: 'comment.created:Douyin:r2', category: '跳过' }] });
    inbox.close();
    const records = path.join(p.dir, 'rec.md');
    const pending = path.join(p.dir, 'pend.md');
    fs.writeFileSync(records, recordsMd);
    fs.writeFileSync(pending, pendingMd);
    const files = [opsDb, records, pending, p.stateDb, p.ledger];
    const before = files.map((f) => [fs.readFileSync(f).toString('base64'), fs.statSync(f).mtimeMs]);
    const md = compareMain(['--hours', '48', '--until', new Date(T0 + 24 * 3600_000).toISOString()],
      { MAITIAN_OPS_DB: opsDb, CINDY_INBOX_DB: p.stateDb, CINDY_LEDGER_FILE: p.ledger, OPENBOT_RECORDS_FILE: records, OPENBOT_PENDING_FILE: pending });
    assert.match(md, /\| 窗口内事件 \| 1 \| 1 \|/);
    assert.deepEqual(files.map((f) => [fs.readFileSync(f).toString('base64'), fs.statSync(f).mtimeMs]), before);
  });
});

describe('整条链路：麦田发件箱同时推给 OpenBot 和 Cindy', () => {
  test('两边同时订阅；Cindy 不回执也不触发「2 小时没回执」提醒（判断看全局 handledAt）', async () => {
    const opsDb = tmpDbFile();
    const db = freshDb(opsDb);
    const openbot = await listen((req, res) => { req.resume(); req.on('end', () => res.writeHead(200).end('{}')); });
    subscribe(db, { subscriberId: 'openbot-engage', url: openbot.url, types: ['comment.created', 'dm.received'] }, { now: at(T0) });
    const inbox = openInbox(':memory:');
    const placeholder = await listen(() => {});
    const port = new URL(placeholder.url).port;
    await placeholder.close();
    const { secret } = subscribe(db, { subscriberId: SUB, url: `http://127.0.0.1:${port}${HOOK_PATH}`, types: ['comment.created', 'dm.received'] }, { now: at(T0) });
    const cindy = await listen(createReceiver({ secret, subscriberId: SUB, inbox, log: () => {} }).handler, port);

    ingestSnapshot(db, douyin(db), commentsSnap([comment('r1')]), { now: at(T0 + MIN) });
    ingestSnapshot(db, douyin(db), commentsSnap([comment('r1'), comment('r2')]), { now: at(T0 + 2 * MIN) });
    try {
      const sent = await deliverPending(db, { now: at(T0 + 3 * MIN), notify: async () => true });
      assert.deepEqual(sent.batches.map((b) => [b.subscriberId, b.ok]).sort(), [[SUB, true], ['openbot-engage', true]]);
      assert.deepEqual(inbox.all().map((r) => r.id), ['comment.created:Douyin:r2']);

      // OpenBot 回执；Cindy 不回执。2 小时后不该有任何「没回执」提醒，也不再重推
      ackEvent(db, 'comment.created:Douyin:r2', 'pending_human', '建议回复', { now: at(T0 + 10 * MIN) });
      const texts = [];
      const later = await deliverPending(db, { now: at(T0 + 3 * MIN + 2 * 3600_000 + MIN), notify: async (t) => { texts.push(t); return true; } });
      assert.deepEqual(later.batches, []);
      assert.deepEqual(texts, []);
    } finally {
      await openbot.close();
      await cindy.close();
      inbox.close();
      db.close();
    }
  });

  test('Cindy 接收端停着时 OpenBot 先回执了：麦田不再推，补漏（真麦田 MCP）收回来', async () => {
    const opsDb = tmpDbFile();
    const db = freshDb(opsDb);
    subscribe(db, { subscriberId: SUB, url: 'http://127.0.0.1:9/maitian/hook', types: ['comment.created'] }, { now: at(T0) });
    ingestSnapshot(db, douyin(db), commentsSnap([comment('r1')]), { now: at(T0 + MIN) });
    ingestSnapshot(db, douyin(db), commentsSnap([comment('r1'), comment('r2')]), { now: at(T0 + 2 * MIN) });
    assert.equal((await deliverPending(db, { now: at(T0 + 3 * MIN), notify: async () => true })).batches[0].ok, false);
    ackEvent(db, 'comment.created:Douyin:r2', 'skipped', '跳过', { now: at(T0 + 3 * MIN) });
    assert.deepEqual((await deliverPending(db, { now: at(T0 + 5 * MIN), notify: async () => true })).batches, []);
    db.close();

    const inbox = openInbox(':memory:');
    const n = await backfillOnce({ inbox, types: ['comment.created'], now: at(T0 + 10 * MIN), listEvents: mcpListEvents({ mcpServer: MCP, opsDb }) });
    assert.equal(n, 1);
    assert.deepEqual(inbox.all().map((r) => [r.id, r.source]), [['comment.created:Douyin:r2', 'backfill']]);
    inbox.close();
  });
});
