// space-check.mjs 的公众号判据（不碰真实平台）：直接测 runInSpace，传假的 task/page；evaluate 在 Node 里给 fn 提供假的 window/document。
import { test, describe } from 'node:test';
import './helpers/ops-dir.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInSpace } from '../src/ops/space-check.mjs';
import { openOpsDb } from '../src/ops/db.mjs';
import { importAccounts, getAccount } from '../src/ops/accounts.mjs';
import { checkLogins } from '../src/ops/login.mjs';

const SEED = path.resolve(import.meta.dirname, '../src/ops/accounts.seed.json');
const TOKEN = '987654321';
const REG = JSON.parse(fs.readFileSync(SEED, 'utf8')).find((a) => a.platformCode === 'GongZhongHao').uid;
const OTHER = 'gh_0123456789ab';
const THIRD = 'gh_ba9876543210';

// 假 page：url 带不带 token、页面全局 wx、页面 HTML、settingpage 的响应
function fakePage({ token = TOKEN, wx, html = '<body></body>', setting = '' } = {}) {
  const fetched = [];
  const page = {
    goto: async () => {},
    url: async () => `https://mp.weixin.qq.com/cgi-bin/home?t=home/index${token ? `&token=${token}` : ''}&lang=zh_CN`,
    evaluate: async (fn, arg) => {
      const saved = { window: globalThis.window, document: globalThis.document };
      globalThis.window = { wx };
      globalThis.document = { documentElement: { innerHTML: html } };
      try { return await fn(arg); } finally { Object.assign(globalThis, saved); }
    },
    fetch: async (url, opts) => { fetched.push({ url, opts }); return { status: 200, body: setting }; },
  };
  return { page, fetched };
}
const taskOf = (page) => ({ pages: async () => [page] });
const check = (page) => runInSpace(taskOf(page), { mode: 'check', platformCode: 'GongZhongHao', uid: REG, home: 'https://mp.weixin.qq.com/' }, { waitMs: 0 });

describe('公众号：读页面上实际登录的 gh_ id', () => {
  test('commonData.data.user_name 是登记的 gh_ → ok，uidSeen=登记值，来源 commonData', async () => {
    const { page, fetched } = fakePage({ wx: { commonData: { data: { user_name: REG } } }, html: `<p>${OTHER}</p>` });
    const r = await check(page);
    assert.equal(r.state, 'ok');
    assert.equal(r.uidSeen, REG);
    assert.match(r.evidence, /commonData/);
    assert.equal(fetched.length, 0);
  });

  test('commonData.user_name（没有 data 层）也认', async () => {
    const { page } = fakePage({ wx: { commonData: { user_name: OTHER } } });
    assert.equal((await check(page)).uidSeen, OTHER);
  });

  test('commonData 给出别的 gh_ → checkLogins 得到 uid-mismatch、退出码 2、发提醒、不写 ok', async () => {
    const { page } = fakePage({ wx: { commonData: { data: { user_name: OTHER } } } });
    const result = await check(page);
    const db = openOpsDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-gzh-')), 'ops.db'));
    importAccounts(db, SEED);
    const sent = [];
    const r = await checkLogins(db, { platform: 'GongZhongHao', runTask: async () => ({ ok: true, result }), notify: async (t) => { sent.push(t); return true; }, finishTask: async () => ({ ok: true }) });
    assert.equal(r.exitCode, 2);
    assert.equal(r.rows[0].result, 'uid-mismatch');
    assert.equal(r.rows[0].uidSeen, OTHER);
    assert.equal(sent.length, 1);
    assert.notEqual(getAccount(db, `GongZhongHao:${REG}`).loginState, 'ok');
  });

  test('commonData 的值格式不对就丢掉，往下取 HTML', async () => {
    const { page } = fakePage({ wx: { commonData: { data: { user_name: 'gh_XYZ' } } }, html: `<a>${OTHER}</a>` });
    const r = await check(page);
    assert.equal(r.uidSeen, OTHER);
    assert.match(r.evidence, /html/);
  });

  test('没有 commonData，HTML 里只有一个（可重复出现）→ 取它', async () => {
    const { page, fetched } = fakePage({ html: `<a>${OTHER}</a><b>"${OTHER}"</b>` });
    const r = await check(page);
    assert.equal(r.state, 'ok');
    assert.equal(r.uidSeen, OTHER);
    assert.match(r.evidence, /html.*1 个/);
    assert.equal(fetched.length, 0);
  });

  test('HTML 里两个不同值 → uidSeen=null，证据写明找到 2 个、没法确定', async () => {
    const { page, fetched } = fakePage({ html: `<a>${OTHER}</a><b>${THIRD}</b>` });
    const r = await check(page);
    assert.equal(r.state, 'ok');
    assert.equal(r.uidSeen, null);
    assert.match(r.evidence, /找到 2 个不同的 gh_ id，没法确定当前账号/);
    assert.equal(fetched.length, 0);
  });

  test('commonData 有值时不和 HTML 里的其他值比', async () => {
    const { page } = fakePage({ wx: { commonData: { data: { user_name: REG } } }, html: `${OTHER} ${THIRD}` });
    assert.equal((await check(page)).uidSeen, REG);
  });

  test('前两步都没有 → GET 同源 settingpage（带 URL 里的 token），从响应里取', async () => {
    const { page, fetched } = fakePage({ setting: `<div>原始ID ${REG}</div>` });
    const r = await check(page);
    assert.equal(r.state, 'ok');
    assert.equal(r.uidSeen, REG);
    assert.match(r.evidence, /settingpage/);
    assert.equal(fetched.length, 1);
    assert.equal(fetched[0].url, `/cgi-bin/settingpage?t=setting/index&action=index&token=${TOKEN}&lang=zh_CN`);
    assert.ok(!fetched[0].opts?.method || fetched[0].opts.method === 'GET');
  });

  test('三处都没有 → uidSeen=null', async () => {
    const { page } = fakePage({ setting: 'nothing' });
    const r = await check(page);
    assert.equal(r.state, 'ok');
    assert.equal(r.uidSeen, null);
  });

  test('settingpage 请求抛错 → uidSeen=null，不抛', async () => {
    const { page } = fakePage();
    page.fetch = async () => { throw new Error('net'); };
    const r = await check(page);
    assert.equal(r.uidSeen, null);
  });

  test('URL 不带 token → out，不读页面、不发请求', async () => {
    const { page, fetched } = fakePage({ token: null, wx: { commonData: { data: { user_name: REG } } } });
    const r = await check(page);
    assert.equal(r.state, 'out');
    assert.equal(r.uidSeen, null);
    assert.equal(fetched.length, 0);
  });

  test('evidence 不含 token 值', async () => {
    for (const opts of [{ wx: { commonData: { data: { user_name: REG } } } }, { html: OTHER }, { html: `${OTHER} ${THIRD}` }, { setting: REG }, { setting: '' }, { token: null }]) {
      const { page } = fakePage(opts);
      const r = await check(page);
      assert.doesNotMatch(JSON.stringify(r), new RegExp(TOKEN));
    }
  });
});
