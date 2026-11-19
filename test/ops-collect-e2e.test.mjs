// S3 端到端（不需要 Ego Lite）：真实的平台模块 map（src/ops/works/*.mjs）+ 已有的脱敏 raw 样例
// → collectWorks（假 runTask 直接返回 raw）→ exportPosts / exportAccounts → scripts/ops-export-check.py。
// raw 取自 spikes/results/samples/06-*-works.json 和 test/fixtures/works/*-account.json，拼法同 test/ops-works-map.test.mjs。
import { test, describe } from 'node:test';
import './helpers/ops-dir.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectWorks } from '../src/ops/collect.mjs';
import { exportPosts, exportAccounts } from '../src/ops/export.mjs';
import { loadPlatform, moduleUrlOf } from '../src/ops/works/index.mjs';
import { prepareDb, PLATFORMS } from './fixtures/ops-export/fake.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CHECK = path.join(ROOT, 'scripts', 'ops-export-check.py');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ops-e2e-'));
const json = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const sample = (name) => json(`spikes/results/samples/06-${name}-works.json`).raw;
const fixture = (name) => json(`test/fixtures/works/${name}-account.json`);
// 视频号样例的 uniqId 打了码（<uniqId>），换成 sph 开头的假值，refresh.py 才认
const CH_UID = 'sphE2eUniqId01';
// 样例里的原始响应没有 http（fetchRaw 才加），按 200 补上
const h = (o) => (o && o.http == null ? { http: 200, ...o } : o);
// 样例只留了 1 条作品，总数改成 1，否则 map 判「只拿到 1 条」不完整
const one = (o, key) => ({ ...o, data: { ...o.data, [key]: 1 } });
const unmask = (o) => JSON.parse(JSON.stringify(o).replaceAll('<uniqId>', CH_UID));
// 四个样例里最晚的读取时间（视频号 2026-11-19 15:36:47），作品都在近 30 天里
const NOW = Date.parse('2026-11-19T15:36:47+08:00');

function rawOf(code, patch = {}) {
  const r = {
    Douyin: () => { const S = sample('douyin'), fx = fixture('douyin'); return { info: fx.info, pages: [{ http: 200, ...S.work_list }], fans: fx.fans }; },
    XiaoHongShu: () => { const S = sample('xhs'), fx = fixture('xhs'); return { atLoginPage: false, analyze: [h(one(S.analyze, 'total'))], posted: [{ http: 200, code: 0, data: { notes: [fx.postedNote] } }, h(S.posted)], userInfo: h(fx.userInfo), personalInfo: h(S.personal_info), fans: h(fx.fans) }; },
    Bili: () => { const S = sample('bili'), fx = fixture('bili'); return { nav: h(fx.nav), archives: [h(S.archives)], compare: h(S.compare), fansGraph: h(fx.fansGraph), fansNum: h(S.fansNum) }; },
    Channels: () => { const S = sample('channels'), fx = fixture('channels'); return unmask({ auth: h(fx.auth), postList: [h(one(S.postList, 'totalCount'))], fansTrend: h(fx.fansTrend) }); },
  }[code]();
  return { ...r, ...patch };
}

function setup() {
  const db = prepareDb(path.join(tmp(), 'ops.db'), { channelsUid: false });
  db.prepare("UPDATE accounts SET uid = ?, spaceName = ? WHERE platformCode = 'Channels'").run(CH_UID, `kinso/Channels/${CH_UID}`);
  db.prepare("UPDATE accounts SET capabilities = json_set(capabilities, '$.readWorks', json('true')) WHERE platformCode IN ('Douyin', 'XiaoHongShu', 'Bili', 'Channels')").run();
  return db;
}
const collect = (db, { patches = {}, days, now = NOW, platforms } = {}) => collectWorks(db, {
  runTask: async (o) => ({ ok: true, result: rawOf(o.params.platformCode, patches[o.params.platformCode]) }),
  loadPlatform, moduleUrlOf, now: () => now, days, platforms,
});
const pyCheck = (...a) => spawnSync('python3', ['-I', CHECK, ...a], { encoding: 'utf8' });
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

describe('端到端：真实 map → 采集 → 导出 → 下游读取校验', () => {
  test('四个平台都 ok，导出过 ops-export-check.py，每平台条数对', async () => {
    const db = setup();
    const r = await collect(db);
    assert.equal(r.exitCode, 0, JSON.stringify(r.rows, null, 1));
    const out = tmp();
    const p = exportPosts(db, { out, now: () => NOW });
    const a = exportAccounts(db, { out, now: () => NOW });
    assert.equal(p.exitCode, 0, JSON.stringify(p));
    assert.equal(a.exitCode, 0, JSON.stringify(a));
    const posts = read(p.file);
    assert.deepEqual(Object.fromEntries(PLATFORMS.map((c) => [c, posts.filter((x) => x.platform === c).length])), { Douyin: 1, XiaoHongShu: 1, Bili: 1, Channels: 1 });
    assert.equal(read(a.file).length, 4);
    const c = pyCheck('--posts', p.file, '--accounts', a.file);
    assert.equal(c.status, 0, c.stdout + c.stderr);
  });

  test('B站粉丝总数接口失败（fans:null）：平台照样 ok、作品照写，accounts 里 fans 是 null 且过校验', async () => {
    const db = setup();
    const r = await collect(db, { patches: { Bili: { fansNum: { http: 200, code: -500, data: null } } } });
    const bili = r.rows.find((x) => x.platformCode === 'Bili');
    assert.equal(bili.result, 'ok', bili.message);
    assert.equal(bili.postCount, 1);
    const out = tmp();
    const p = exportPosts(db, { out, now: () => NOW });
    const a = exportAccounts(db, { out, now: () => NOW });
    assert.equal(a.exitCode, 0, JSON.stringify(a));
    assert.equal(read(a.file).find((x) => x.uid === '478358005').fans, null);
    assert.equal(read(p.file).filter((x) => x.platform === 'Bili').length, 1);
    const c = pyCheck('--posts', p.file, '--accounts', a.file);
    assert.equal(c.status, 0, c.stdout + c.stderr);
  });

  test('先采 30 天、再 --days 7：exportPosts 仍导出 30 天那次；accounts 用最近一次', async () => {
    const db = setup();
    await collect(db);
    const first = db.prepare("SELECT runId FROM collect_runs WHERE platformCode = 'Douyin'").get().runId;
    const r7 = await collect(db, { days: 7, now: NOW + 60_000 });
    assert.equal(r7.exitCode, 0);
    const out = tmp();
    const p = exportPosts(db, { out, now: () => NOW + 60_000 });
    assert.equal(p.exitCode, 0, JSON.stringify(p));
    assert.ok(p.exported.every((x) => x.runId === first), JSON.stringify(p.exported));
    const a = exportAccounts(db, { out, now: () => NOW + 60_000 });
    assert.ok(a.exported.every((x) => x.runId === r7.runId));
  });
});
