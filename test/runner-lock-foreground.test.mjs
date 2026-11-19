// 全局前台锁 withForegroundLock（不需要 Ego Lite）：跨进程串行、嵌套不自锁、抛错也放锁、持锁方死了能回收；
// ego-shim 的 tabs.create/update({active:true}) 切前台都在锁里做。
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createForegroundLock } from '../src/ego-runner/foreground.mjs';
import { createEgoChrome, GOTO_COMMIT_TIMEOUT_MS } from '../src/ego-shim.mjs';

const FG_URL = new URL('../src/ego-runner/foreground.mjs', import.meta.url).href;
let file;
beforeEach(() => { file = join(mkdtempSync(join(tmpdir(), 'maitian-fg-')), 'locks', '_foreground.lock'); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 一个独立 node 进程：rounds 轮，每轮在锁里待 holdMs，打出每轮的 [进锁, 出锁] 时间
function lockerProcess(rounds, holdMs) {
  const src = `const { createForegroundLock } = await import(${JSON.stringify(FG_URL)});
const lock = createForegroundLock(${JSON.stringify(file)});
const spans = [];
for (let i = 0; i < ${rounds}; i++) await lock(async () => { const a = Date.now(); await new Promise((r) => setTimeout(r, ${holdMs})); spans.push([a, Date.now()]); });
console.log(JSON.stringify(spans));`;
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`退出码 ${code}`))));
  });
}

describe('withForegroundLock（不需要 Ego Lite）', () => {
  test('三个进程同时抢：锁内时段两两不重叠', async () => {
    const all = (await Promise.all([lockerProcess(5, 60), lockerProcess(5, 60), lockerProcess(5, 60)])).flat().sort((a, b) => a[0] - b[0]);
    assert.equal(all.length, 15);
    for (let i = 1; i < all.length; i++) assert.ok(all[i][0] >= all[i - 1][1], `第 ${i} 段 ${all[i]} 与上一段 ${all[i - 1]} 重叠`);
    assert.equal(existsSync(file), false, '都跑完后锁文件应已删除');
  });

  test('同一脚本里嵌套调用不自锁', async () => {
    const lock = createForegroundLock(file);
    const r = await Promise.race([lock(() => lock(() => lock(async () => 'inner'))), sleep(2000).then(() => 'deadlock')]);
    assert.equal(r, 'inner');
    assert.equal(existsSync(file), false);
  });

  test('同一脚本里两段不嵌套的并发调用也串行', async () => {
    const lock = createForegroundLock(file);
    const spans = [];
    const job = () => lock(async () => { const a = Date.now(); await sleep(100); spans.push([a, Date.now()]); });
    await Promise.all([job(), job()]);
    spans.sort((a, b) => a[0] - b[0]);
    assert.ok(spans[1][0] >= spans[0][1]);
  });

  test('fn 抛错也放锁，错误照抛', async () => {
    const lock = createForegroundLock(file);
    await assert.rejects(lock(async () => { throw new Error('切前台失败'); }), /切前台失败/);
    assert.equal(existsSync(file), false);
    assert.equal(await lock(async () => 1), 1);
  });

  test('持锁方死了（锁文件很久没被摸过）：回收；还在摸的锁不回收', async () => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ token: 'dead', pid: 1, at: 0 }));
    const lock = createForegroundLock(file, { staleMs: 300 });
    const fresh = await Promise.race([lock(async () => 'got'), sleep(150).then(() => 'waiting')]);
    assert.equal(fresh, 'waiting', '刚写的锁不算失效');
    const old = new Date(Date.now() - 1000);
    utimesSync(file, old, old);
    assert.equal(await Promise.race([lock(async () => 'got'), sleep(2000).then(() => 'stuck')]), 'got');
  });

  test('持锁时间超过失效阈值也不会被别人抢走（持锁方定时摸锁文件）', async () => {
    const a = createForegroundLock(file, { staleMs: 300, refreshMs: 50 });
    const b = createForegroundLock(file, { staleMs: 300, refreshMs: 50 });
    let bIn = 0;
    const aDone = a(async () => { await sleep(800); return bIn; });
    await sleep(50);
    const bDone = b(async () => { bIn = Date.now(); });
    assert.equal(await aDone, 0, 'a 持锁期间 b 不应进锁');
    await bDone;
  });
});

// 假的 TaskSpace：记下每次 Page 调用，以及调用时前台锁是不是被持有
function fakeTask({ waitForLoadState } = {}) {
  const log = [];
  let n = 1, lockHeld = false;
  const tabs = [{ label: 'p1', url: 'about:blank', active: true }];
  const page = (label) => ({
    label,
    goto: async (url, opts) => { log.push(['goto', label, url, opts]); tabs.find((t) => t.label === label).url = url; },
    waitForLoadState: async (state, opts) => { log.push(['waitForLoadState', label, state, opts]); if (waitForLoadState) await waitForLoadState(label); },
    cdp: async (method) => { log.push(['cdp', label, method, { lockHeld }]); return {}; },
    close: async () => { log.push(['close', label]); tabs.splice(tabs.findIndex((t) => t.label === label), 1); },
    url: async () => tabs.find((t) => t.label === label).url,
    title: async () => '',
  });
  const task = {
    spaceId: 1, log, tabList: tabs,
    tabs: async () => tabs,
    page,
    newPage: async () => { const label = `p${++n}`; tabs.push({ label, url: 'about:blank', active: false }); return page(label); },
  };
  const withForegroundLock = async (fn) => { lockHeld = true; try { return await fn(); } finally { lockHeld = false; } };
  return { task, log, withForegroundLock };
}

describe('ego-shim 切前台进锁、tabs.create 不等 load（不需要 Ego Lite）', () => {
  test('tabs.create({active:true}) 和 tabs.update(id,{active:true}) 的 Page.bringToFront 都在前台锁里', async () => {
    const { task, log, withForegroundLock } = fakeTask();
    const { chrome } = createEgoChrome(task, { withForegroundLock });
    const a = await chrome.tabs.create({ url: 'file:///a', active: true });
    const b = await chrome.tabs.create({ url: 'file:///b', active: false });
    await chrome.tabs.update(b.id, { active: true });
    const fronts = log.filter((l) => l[0] === 'cdp' && l[2] === 'Page.bringToFront');
    assert.equal(fronts.length, 2);
    assert.ok(fronts.every((l) => l[3].lockHeld), JSON.stringify(fronts));
    assert.notEqual(a.id, b.id);
  });

  test('goto 只等 commit，再等 domcontentloaded；后者超时照样返回', async () => {
    const { task, log } = fakeTask({ waitForLoadState: async () => { const e = new Error('page.waitForLoadState: Timeout 10000ms exceeded'); e.name = 'TimeoutError'; throw e; } });
    const { chrome } = createEgoChrome(task);
    const tab = await chrome.tabs.create({ url: 'https://example.invalid/spa', active: false });
    assert.equal(typeof tab.id, 'number');
    assert.deepEqual(log.find((l) => l[0] === 'goto')[3], { waitUntil: 'commit', timeout: GOTO_COMMIT_TIMEOUT_MS });
    assert.equal(log.find((l) => l[0] === 'waitForLoadState')[2], 'domcontentloaded');
  });

  test('等 domcontentloaded 出的不是超时错（页面没了）：抛出，新开的页关掉', async () => {
    const { task, log } = fakeTask({ waitForLoadState: async (label) => { if (label === 'p2') throw new Error('page label not found'); } });
    const { chrome } = createEgoChrome(task);
    await chrome.tabs.create({ url: 'file:///first', active: false });   // 用掉自带的 p1
    await assert.rejects(chrome.tabs.create({ url: 'file:///second', active: false }), /page label not found/);
    assert.deepEqual(log.filter((l) => l[0] === 'close'), [['close', 'p2']]);
    assert.deepEqual(task.tabList.map((t) => t.label), ['p1']);
  });

  test('第一次 create 复用自带空白 p1：出错时不关 p1、也不多开页', async () => {
    const { task, log } = fakeTask({ waitForLoadState: async () => { throw new Error('net::ERR_CONNECTION_REFUSED'); } });
    const { chrome } = createEgoChrome(task);
    await assert.rejects(chrome.tabs.create({ url: 'http://127.0.0.1:1/', active: false }), /ERR_CONNECTION_REFUSED/);
    assert.deepEqual(log.filter((l) => l[0] === 'close'), []);
    assert.deepEqual(task.tabList.map((t) => t.label), ['p1']);
  });
});
