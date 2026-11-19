// 在 ego-browser nodejs 里运行（由 runner 任务脚本 import）：打开平台后台首页判断登录，或打开登录页交给负责人。
// 各平台判断照搬 spikes/platform/spaces.mjs 的 CHECKS（S0 实测过）；只返回状态、证据和 uid，不返回 cookie、token、原始响应。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(page, url, opts = {}) {
  const r = await page.fetch(url, { timeout: 15000, ...opts });
  let json = null;
  try { json = JSON.parse(r.body); } catch {}
  return { status: r.status, json };
}

// space 里第一个受管页面；没有就收养第一个 tab，再没有就新开（同 spikes/platform/lib.mjs 的 mainPage）
async function mainPage(task) {
  const pages = await task.pages();
  if (pages[0]) return pages[0];
  const tab = (await task.tabs())[0];
  if (tab && !tab.label && tab.openedBy !== 'unknown') return task.adopt(tab.page);
  return task.newPage();
}

// 每个平台：返回 { state: 'ok'|'out'|'unknown', evidence, uidSeen }
const CHECKS = {
  async Douyin(page) {
    const r = await getJson(page, '/web/api/media/user/info/');
    const sc = r.json?.status_code;
    return { state: sc === 0 ? 'ok' : sc === 8 ? 'out' : 'unknown', evidence: `GET /web/api/media/user/info/ http=${r.status} status_code=${sc}`, uidSeen: r.json?.user?.uid ?? r.json?.user_info?.uid ?? null };
  },
  async XiaoHongShu(page) {
    const r = await getJson(page, '/api/galaxy/creator/home/personal_info');
    const code = r.json?.code;
    const d = r.json?.data ?? {};
    const atLogin = /\/login/.test(await page.url());
    const ui = await getJson(page, '/api/galaxy/user/info');   // personal_info 里没有 userId，user/info 的 data.userId 才是
    return { state: code === 0 || r.json?.success === true ? 'ok' : code === -100 || r.status === 401 || atLogin ? 'out' : 'unknown', evidence: `GET /api/galaxy/creator/home/personal_info http=${r.status} code=${code} success=${r.json?.success}；页面${atLogin ? '跳到 /login' : '没跳登录页'}`, uidSeen: ui.json?.data?.userId ?? d.user_id ?? d.userId ?? null };
  },
  async Bili(page) {
    const r = await getJson(page, 'https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' });
    const code = r.json?.code;
    return { state: code === 0 && r.json?.data?.isLogin ? 'ok' : code === -101 ? 'out' : 'unknown', evidence: `GET api.bilibili.com/x/web-interface/nav http=${r.status} code=${code} isLogin=${r.json?.data?.isLogin}`, uidSeen: r.json?.data?.mid ?? null };
  },
  async GongZhongHao(page) {
    // 读实际登录的原始 ID（gh_ + 12 位十六进制），由 login.mjs 和登记的比对；token 只用来请求设置页，不写进证据
    const token = (await page.url()).match(/[?&]token=(\d+)/)?.[1];
    if (!token) return { state: 'out', evidence: '落地 URL 不带 token', uidSeen: null };
    const seen = await page.evaluate(() => {
      const valid = (v) => typeof v === 'string' && /^gh_[0-9a-f]{12}$/.test(v);
      let common = [];
      try { common = [...new Set([window.wx?.commonData?.data?.user_name, window.wx?.commonData?.user_name].filter(valid))]; } catch {}
      return { common, html: [...new Set(document.documentElement.innerHTML.match(/gh_[0-9a-f]{12}\b/g) ?? [])] };
    });
    let source, ids, note = '';
    if (seen.common.length) [source, ids] = ['commonData', seen.common];
    else if (seen.html.length) [source, ids] = ['html', seen.html];
    else {
      source = 'settingpage';
      try {
        const r = await page.fetch(`/cgi-bin/settingpage?t=setting/index&action=index&token=${token}&lang=zh_CN`, { method: 'GET', timeout: 15000 });
        // 只认 2xx：500、302 跳登录之类的响应不可信，不解析
        ids = r.status >= 200 && r.status < 300 ? [...new Set(String(r.body ?? '').match(/gh_[0-9a-f]{12}\b/g) ?? [])] : [];
        note = ` http=${r.status}`;
      } catch (e) { ids = []; note = ` 请求失败（${e.name}）`; }
    }
    const found = ids.length === 1 ? `取到 ${ids[0]}` : ids.length ? `找到 ${ids.length} 个不同的 gh_ id，没法确定当前账号` : '没找到 gh_ id';
    return { state: 'ok', evidence: `落地 URL 带 token；gh_ id 来源 ${source}${note}，找到 ${ids.length} 个，${found}`, uidSeen: ids.length === 1 ? ids[0] : null };
  },
  async Weibo(page, a) {
    // /ajax/profile/info 未登录也返回 ok=1，不能单独判断；要看落地 URL 和页面配置里的自己 uid
    const r = await getJson(page, `/ajax/profile/info?uid=${encodeURIComponent(a.uid)}`);
    const me = await page.evaluate(() => { try { return String(window.$CONFIG?.user?.idstr ?? window.__INITIAL_STATE__?.config?.user?.idstr ?? ''); } catch { return ''; } });
    const ok = r.json?.ok;
    const url = await page.url();
    const state = /passport|login|visitor/.test(url) || ok === -100 ? 'out' : me ? 'ok' : 'unknown';
    return { state, evidence: `GET /ajax/profile/info http=${r.status} ok=${ok}；页面配置里的自己 uid ${me ? '有' : '无'}；URL host=${new URL(url).host}`, uidSeen: me || null };
  },
  async Channels(page) {
    const url = await page.url();
    const r = await getJson(page, '/cgi-bin/mmfinderassistant-bin/auth/auth_data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    const err = r.json?.errCode;
    const fu = r.json?.data?.finderUser;
    const state = err === 0 && fu ? 'ok' : /login/.test(url) || (err != null && err !== 0) ? 'out' : 'unknown';
    // 下游认的视频号 uid 是 finderUser.uniqId
    return { state, evidence: `POST auth/auth_data http=${r.status} errCode=${err} finderUser=${fu ? '有' : '无'}；URL path=${new URL(url).pathname}`, uidSeen: fu?.uniqId ?? null, nickname: fu?.nickname ?? null };
  },
  async X(page) {
    const url = await page.url();
    const handle = await page.evaluate(() => { const b = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]'); const m = b && b.innerText.match(/@\w+/); return m ? m[0] : null; });
    return { state: handle ? 'ok' : /login|flow/.test(url) || new URL(url).pathname === '/' ? 'out' : 'unknown', evidence: `URL path=${new URL(url).pathname}；侧栏账号按钮 ${handle ? '有' : '无'}`, uidSeen: handle };
  },
  async YouTube(page) {
    const url = await page.url();
    const m = url.match(/\/channel\/(UC[\w-]+)/);
    const host = new URL(url).host;
    return { state: m ? 'ok' : /accounts\.google/.test(host) ? 'out' : 'unknown', evidence: `落地 host=${host} path=${m ? '/channel/<id>' : new URL(url).pathname}`, uidSeen: m?.[1] ?? null };
  },
  async Instagram(page) {
    const r = await page.evaluate(() => {
      const login = !!document.querySelector('input[name="username"], input[name="email"], input[name="pass"]');
      const i = [...document.querySelectorAll('a[href] img[alt]')].find((i) => /的头像|profile picture/i.test(i.alt) && i.getBoundingClientRect().x < 150);
      const remembered = /Use another profile|使用其他/.test(document.body.innerText);   // 会话过期但记住了账号，也算未登录（不点 Continue）
      return { login: login || remembered, user: i ? i.closest('a').getAttribute('href').replace(/\//g, '') : null };
    });
    return { state: r.user ? 'ok' : r.login ? 'out' : 'unknown', evidence: `登录表单或「Continue/Use another profile」 ${r.login ? '有' : '无'}；左侧栏头像 ${r.user ? '有' : '无'}`, uidSeen: r.user };
  },
  async Zhishi(page) {
    const url = await page.url();
    return { state: 'unknown', evidence: `知识站登录判断还没实现；落地 path=${new URL(url).pathname}`, uidSeen: null };
  },
};

/**
 * params: { mode: 'check'|'handoff', platformCode, uid, home, loginUrl }
 * check：打开 home（waitUntil commit 再等 6 秒；创作者后台多是长轮询 SPA，等 domcontentloaded 会超时），按平台判断。
 * handoff：打开 loginUrl 并 handOff() 交给负责人扫码。定时任务路径永远不用这个模式。
 */
export async function runInSpace(task, params, { waitMs = 6000 } = {}) {
  const page = await mainPage(task);
  if (params.mode === 'handoff') {
    await page.goto(params.loginUrl, { timeout: 30000, waitUntil: 'commit' });
    await task.handOff();
    return { handedOff: true };
  }
  const check = CHECKS[params.platformCode];
  if (!check) return { state: 'unknown', evidence: `没有 ${params.platformCode} 的登录判断`, uidSeen: null };
  await page.goto(params.home, { timeout: 30000, waitUntil: 'commit' });
  await sleep(waitMs);
  const c = await check(page, params);
  return { state: c.state, evidence: c.evidence, uidSeen: c.uidSeen == null ? null : String(c.uidSeen), ...(c.nickname ? { nickname: c.nickname } : {}) };
}
