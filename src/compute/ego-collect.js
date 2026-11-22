// 在 Ego Lite 的只读 space 里跑的采集脚本（ego-runner 任务脚本：async 函数体，可用 task / params，返回值即结果）。
// 严格只读：只打开页面、读页面文字、调页面自己的只读查询接口；唯一的点击是 Flow 顶栏「账号详情」头像菜单（只展开看点数，读完按 Esc 关掉）。
// 不点生成、不启动 Colab / Kaggle 会话、不改设置、不点任何确认按钮。登录凭证只在页面里用，不出现在返回值里；邮箱打码。
const page = (await task.pages())[0] || await task.newPage();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const redact = (s) => String(s).replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>');
const onLogin = () => /accounts\.google\.com|ServiceLogin|\/signin|\/login/i.test(page.url());
const open = async (url, wait = 7000) => { await page.goto(url, { waitUntil: 'commit', timeout: 30000 }); await sleep(wait); };
const out = {};
const step = async (name, fn) => {
  try { out[name] = await fn(); }
  catch (e) { out[name] = { status: 'error', error: redact(e && e.message || e).slice(0, 200) }; }
};

await step('flow', async () => {
  await open('https://flow.google.com/', 8000);
  if (onLogin()) return { status: 'logged_out', error: 'Flow 登录失效' };
  const r = await page.evaluate(async () => {
    const b = [...document.querySelectorAll('button,[role=button]')].find((x) => (x.getAttribute('aria-label') || '') === '账号详情');
    if (!b) return { noButton: true, ultra: /ULTRA/.test(document.body.innerText) };
    b.click(); await new Promise((r) => setTimeout(r, 2500));
    const t = [...document.querySelectorAll('[role=dialog],[role=menu],.cdk-overlay-pane')].map((d) => d.innerText).join('\n') || document.body.innerText;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return { text: t.slice(0, 2000), ultra: /ULTRA/.test(document.body.innerText) };
  });
  if (r.noButton) return { status: 'error', error: '没找到 Flow 账号菜单（页面改版或没登录）' };
  const pts = r.text.match(/([\d,]+)\s*个\s*Google Flow\s*点数/);
  const rs = r.text.match(/重置时间[：:]\s*(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/);
  if (!pts) return { status: 'error', error: '账号菜单里没读到 Flow 点数' };
  return { status: 'ok', metrics: { credits: Number(pts[1].replace(/,/g, '')), resetText: rs ? `${rs[1]}月${rs[2]}日 ${rs[3]}:${rs[4]}` : null, reset: rs ? { month: +rs[1], day: +rs[2], hour: +rs[3], minute: +rs[4] } : null, plan: r.ultra ? 'ULTRA' : null } };
});

await step('flowmusic', async () => {
  await open('https://www.flowmusic.app/', 7000);
  const r = await page.evaluate(async () => {
    const parts = document.cookie.split('; ').filter((c) => /^sb-.*-auth-token/.test(c)).sort().map((c) => decodeURIComponent(c.slice(c.indexOf('=') + 1)));
    let raw = parts.join(''), tok = null;
    try { if (raw.startsWith('base64-')) raw = atob(raw.slice(7)); const j = JSON.parse(raw); tok = j.access_token || (Array.isArray(j) ? j[0] : null); } catch {}
    if (!tok) return { noToken: true };
    const get = async (p) => { const x = await fetch(p, { headers: { authorization: 'Bearer ' + tok } }); return { status: x.status, body: x.ok ? await x.json() : null }; };
    const c = await get('/__api/billing/credits'), s = await get('/__api/billing/subscription');
    return { c: { status: c.status, credits: c.body?.data?.credits_remaining ?? null, last: (c.body?.add_token_transactions || []).slice(0, 3).map((t) => ({ type: t.type, credits: t.credits, at: t.created_at })) }, s: { status: s.status, tier: s.body?.data?.subscription_tier ?? null, plan: s.body?.data?.subscription_plan ?? null } };
  });
  if (r.noToken) return { status: 'logged_out', error: 'Flow Music 登录失效' };
  if (r.c.status === 401 || r.c.status === 403) return { status: 'logged_out', error: `Flow Music 登录失效（HTTP ${r.c.status}）` };
  if (r.c.credits == null) return { status: 'error', error: `Flow Music 余额没读到（HTTP ${r.c.status}）` };
  return { status: 'ok', metrics: { credits: r.c.credits, tier: r.s.tier, plan: r.s.plan, recent: r.c.last } };
});

await step('kaggle', async () => {
  await open('https://www.kaggle.com/settings', 7000);
  const r = await page.evaluate(async () => {
    const x = (document.cookie.match(/XSRF-TOKEN=([^;]+)/) || [])[1];
    const call = async (m) => { const res = await fetch('/api/i/' + m, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', ...(x ? { 'x-xsrf-token': decodeURIComponent(x) } : {}) }, body: '{}' }); return { status: res.status, body: res.ok ? await res.json() : null }; };
    return { q: await call('kernels.KernelsService/GetAcceleratorQuotaStatistics'), s: await call('kernels.KernelsService/ListKernelSessions') };
  });
  if ([401, 403].includes(r.q.status)) return { status: 'logged_out', error: `Kaggle 登录失效（HTTP ${r.q.status}）` };
  if (!r.q.body) return { status: 'error', error: `Kaggle 额度没读到（HTTP ${r.q.status}）` };
  // 会话读不到就不能说「空闲」：整项算失败，保留上次成功快照
  if ([401, 403].includes(r.s.status)) return { status: 'logged_out', error: `Kaggle 会话列表登录失效（HTTP ${r.s.status}）` };
  if (r.s.status !== 200 || !r.s.body) return { status: 'error', error: `Kaggle 会话列表没读到（HTTP ${r.s.status}）` };
  const sec = (v) => (v == null ? null : Number(String(v).replace(/s$/, '')));
  const quota = (q) => q && { totalHours: sec(q.totalTimeAllowed) / 3600, usedHours: sec(q.timeUsed) / 3600, reservedHours: sec(q.timeReserved) / 3600, leftHours: (sec(q.totalTimeAllowed) - sec(q.timeUsed) - sec(q.timeReserved)) / 3600 };
  // ListKernelSessions：没有会话时只回 quotaLimits；有会话时是一个数组字段，名字不确定，取所有对象数组
  const sb = r.s.body || {};
  const list = Object.entries(sb).filter(([k, v]) => k !== 'quotaLimits' && Array.isArray(v)).flatMap(([, v]) => v);
  const sessions = list.map((s, i) => ({ id: String(s.id ?? s.kernelSessionId ?? s.sessionId ?? i), title: String(s.title ?? s.kernelTitle ?? s.name ?? '').slice(0, 80), accelerator: String(s.accelerator ?? s.machineShape ?? '') }));
  return { status: 'ok', metrics: { gpu: quota(r.q.body.gpuQuota), tpu: quota(r.q.body.tpuQuota), refreshAt: r.q.body.quotaRefreshTime || null, sessionsKnown: r.s.status === 200 }, sessions };
});

for (const [name, url, label] of [['pics', 'https://docs.google.com/images/u/0/', 'Pics'], ['vids', 'https://docs.google.com/videos/u/0/', 'Vids']]) {
  await step(name, async () => {
    await open(url, 6000);
    if (onLogin()) return { status: 'logged_out', error: `${label} 登录失效` };
    const r = await page.evaluate(() => ({ title: document.title, host: location.host }));
    if (r.host !== 'docs.google.com') return { status: 'error', error: `${label} 跳到了 ${r.host}` };
    return { status: 'ok', metrics: { signedIn: true, title: r.title.slice(0, 60) } };
  });
}
return JSON.parse(redact(JSON.stringify(out)));
