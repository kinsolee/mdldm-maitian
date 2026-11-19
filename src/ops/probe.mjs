// 登录判据和在 space 里跑的两段脚本（检测、交给负责人扫码）。
// 这个模块在 ego-browser nodejs 的运行时里被 import（file:// 地址），也在测试里用假页面直接调。
// 判据来自 spikes/platform/spaces.mjs 的 CHECKS（S0 实测），只读：不点按钮、不 handOff、不收回 space。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(page, url, opts = {}) {
  const r = await page.fetch(url, { timeout: 15000, ...opts });
  let json = null;
  try { json = JSON.parse(r.body); } catch {}
  return { status: r.status, json };
}

// 公众号实际登录的号：页面配置优先；否则 HTML 里只有一个 gh_ 号就是它；有多个且不含登记的号，取第一个（宁可判不一致硬停）
function pickGh({ own, ghs = [] }, uid) {
  if (own && /^gh_[0-9a-z_]+$/i.test(own)) return own;
  if (ghs.length === 1) return ghs[0];
  if (ghs.length > 1 && !ghs.includes(uid)) return ghs[0];
  return ghs.includes(uid) ? uid : null;
}

const str = (v) => (v == null || v === '' ? null : String(v));

// 每个平台：home 是创作者后台首页，loginUrl 是扫码页；check 返回 { state: 'ok'|'out'|'unknown', evidence, uidSeen }
export const CHECKS = {
  Douyin: {
    home: 'https://creator.douyin.com/creator-micro/home',
    loginUrl: 'https://creator.douyin.com/',
    async check(page) {
      const r = await getJson(page, '/web/api/media/user/info/');
      const sc = r.json?.status_code;
      return { state: sc === 0 ? 'ok' : sc === 8 ? 'out' : 'unknown', evidence: `GET /web/api/media/user/info/ http=${r.status} status_code=${sc}`, uidSeen: str(r.json?.user?.uid ?? r.json?.user_info?.uid) };
    },
  },
  XiaoHongShu: {
    home: 'https://creator.xiaohongshu.com/new/home',
    loginUrl: 'https://creator.xiaohongshu.com/login',
    async check(page) {
      const r = await getJson(page, '/api/galaxy/creator/home/personal_info');
      const code = r.json?.code;
      const atLogin = /\/login/.test(await page.url());
      // personal_info 里没有 userId；user/info 的 data.userId 才是（S0，2026-11-19）
      const ui = await getJson(page, '/api/galaxy/user/info');
      const state = code === 0 || r.json?.success === true ? 'ok' : code === -100 || r.status === 401 || atLogin ? 'out' : 'unknown';
      return { state, evidence: `GET personal_info http=${r.status} code=${code}；页面${atLogin ? '跳到 /login' : '没跳登录页'}`, uidSeen: str(ui.json?.data?.userId) };
    },
  },
  Bili: {
    home: 'https://member.bilibili.com/platform/home',
    loginUrl: 'https://passport.bilibili.com/login',
    async check(page) {
      const r = await getJson(page, 'https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' });
      const code = r.json?.code;
      return { state: code === 0 && r.json?.data?.isLogin ? 'ok' : code === -101 ? 'out' : 'unknown', evidence: `GET x/web-interface/nav http=${r.status} code=${code} isLogin=${r.json?.data?.isLogin}`, uidSeen: str(r.json?.data?.mid) };
    },
  },
  GongZhongHao: {
    home: 'https://mp.weixin.qq.com/',
    loginUrl: 'https://mp.weixin.qq.com/',
    // 实际登录的 gh_ 号：先看后台页面全局 wx.commonData.user_name，再看页面 HTML 里的 gh_ 号。
    // 读到别的号就交给上层判 uid-mismatch；只读，不调接口、不点按钮。
    async check(page, { uid }) {
      const hasToken = /[?&]token=\d+/.test(await page.url());
      const p = await page.evaluate(() => {
        let own = null;
        try { own = window.wx?.commonData?.user_name ?? null; } catch {}
        const ghs = [...new Set(document.documentElement.innerHTML.match(/gh_[0-9a-z_]+/g) ?? [])];
        const loginBox = !!document.querySelector('.login__type__container, .login_frame, .new-login, input[name="account"], input[type="password"]') || /扫码登录|使用账号登录/.test(document.body?.innerText ?? '');
        return { own, ghs, loginBox };
      }) ?? {};
      if (!hasToken) return { state: p.loginBox ? 'out' : 'unknown', evidence: `落地 URL 不带 token；登录框${p.loginBox ? '有' : '无'}`, uidSeen: null };
      return { state: 'ok', evidence: `落地 URL 带 token 参数（值不记）；${p.own ? '页面配置里有自己的 gh_ 号' : `页面里 gh_ 号 ${p.ghs?.length ?? 0} 个`}`, uidSeen: pickGh(p, uid) };
    },
  },
  Weibo: {
    home: 'https://weibo.com/',
    loginUrl: 'https://passport.weibo.com/sso/signin',
    // /ajax/profile/info 未登录也返回 ok=1，要结合落地 URL 和页面配置里的自己 uid
    async check(page, { uid }) {
      const r = await getJson(page, `/ajax/profile/info?uid=${encodeURIComponent(uid)}`);
      const me = await page.evaluate(() => { try { return String(window.$CONFIG?.user?.idstr ?? window.__INITIAL_STATE__?.config?.user?.idstr ?? ''); } catch { return ''; } });
      const url = await page.url();
      const state = /passport|login|visitor/.test(url) || r.json?.ok === -100 ? 'out' : me ? 'ok' : 'unknown';
      return { state, evidence: `GET /ajax/profile/info http=${r.status} ok=${r.json?.ok}；页面配置里的自己 uid ${me ? '有' : '无'}；URL host=${new URL(url).host}`, uidSeen: str(me) };
    },
  },
  Channels: {
    home: 'https://channels.weixin.qq.com/platform',
    loginUrl: 'https://channels.weixin.qq.com/login.html',
    // 视频号 uid 只认 finderUser.uniqId（下游作品、互动都按它，见 S0 06）
    async check(page) {
      const url = await page.url();
      const r = await getJson(page, '/cgi-bin/mmfinderassistant-bin/auth/auth_data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const err = r.json?.errCode;
      const fu = r.json?.data?.finderUser;
      const state = err === 0 && fu ? 'ok' : /login/.test(url) || (err != null && err !== 0) ? 'out' : 'unknown';
      return { state, evidence: `POST auth/auth_data http=${r.status} errCode=${err} finderUser=${fu ? '有' : '无'}；URL path=${new URL(url).pathname}`, uidSeen: str(fu?.uniqId) };
    },
  },
  X: {
    home: 'https://x.com/home',
    loginUrl: 'https://x.com/i/flow/login',
    // uid 记 handle（不带 @）
    async check(page) {
      const url = await page.url();
      const handle = await page.evaluate(() => { const b = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]'); const m = b && b.innerText.match(/@(\w+)/); return m ? m[1] : null; });
      return { state: handle ? 'ok' : /login|flow/.test(url) || new URL(url).pathname === '/' ? 'out' : 'unknown', evidence: `URL path=${new URL(url).pathname}；侧栏账号按钮 ${handle ? '有' : '无'}`, uidSeen: str(handle) };
    },
  },
  YouTube: {
    home: 'https://studio.youtube.com/',
    loginUrl: 'https://studio.youtube.com/',
    async check(page) {
      const url = await page.url();
      const m = url.match(/\/channel\/(UC[\w-]+)/);
      const host = new URL(url).host;
      return { state: m ? 'ok' : /accounts\.google/.test(host) ? 'out' : 'unknown', evidence: `落地 host=${host} path=${m ? '/channel/<id>' : new URL(url).pathname}`, uidSeen: str(m?.[1]) };
    },
  },
};

// space 里第一个受管页面；没有就收养第一个 tab，再没有就新开（同 spikes/platform/lib.mjs）
async function mainPage(task) {
  const pages = await task.pages();
  if (pages[0]) return pages[0];
  const tab = (await task.tabs())[0];
  if (tab && !tab.label && tab.openedBy !== 'unknown') return task.adopt(tab.page);
  return task.newPage();
}

/** 只读检测：打开后台首页，按判据判断。params: { platformCode, uid, settleMs } */
export async function detect(task, { platformCode, uid, settleMs = 6000 }) {
  const c = CHECKS[platformCode];
  if (!c) return { state: 'unknown', evidence: `没有 ${platformCode} 的判据`, uidSeen: null };
  const page = await mainPage(task);
  // 创作者后台多是长轮询 SPA，等 domcontentloaded 会超时；commit 后固定等几秒
  await page.goto(c.home, { timeout: 30000, waitUntil: 'commit' });
  await sleep(settleMs);
  return c.check(page, { uid });
}

/** 打开扫码页并交给负责人。withForegroundLock 由 runner 前言提供；没有时直接跑。 */
export async function openLogin(task, { platformCode }, withForegroundLock = (fn) => fn()) {
  const c = CHECKS[platformCode];
  if (!c) throw new Error(`没有 ${platformCode} 的登录页`);
  const page = await mainPage(task);
  await page.goto(c.loginUrl, { timeout: 30000, waitUntil: 'commit' });
  await withForegroundLock(() => task.handOff());
  return { handedOff: true, loginUrl: c.loginUrl };
}

const PROBE_URL = import.meta.url;

/** 交给 runInSpace 的脚本体（async 函数体，可用 task、params、withForegroundLock）。 */
export const DETECT_SCRIPT = `const { detect } = await import(${JSON.stringify(PROBE_URL)});
return await detect(task, params);`;

export const LOGIN_SCRIPT = `const { openLogin } = await import(${JSON.stringify(PROBE_URL)});
return await openLogin(task, params, typeof withForegroundLock === 'function' ? withForegroundLock : undefined);`;
