// 页面脚本共用（在 ego-browser nodejs 里跑，由各平台的 runInSpace import）。只读：只看、只抄回响应，不调页面上的写函数。
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// space 里第一个受管页面；没有就收养第一个 tab，再没有就新开（同 src/ops/space-check.mjs）
export async function mainPage(task) {
  const pages = await task.pages();
  if (pages[0]) return pages[0];
  const tab = (await task.tabs())[0];
  if (tab && !tab.label && tab.openedBy !== 'unknown') return task.adopt(tab.page);
  return task.newPage();
}

/** 超过 2^53 的整数先改成字符串再解析（抖音 id、B站私信 msg_key 会丢精度）。坏 JSON 返回 null。 */
export function bigJson(text) {
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text.replace(/([:\[,]\s*)(-?\d{16,})(?=\s*[,\]}])/g, '$1"$2"')); } catch { return null; }
}

// 挂钩页面自己发的 fetch / XHR：只把 JSON 响应抄一份到 window.__engCap。URL 只留 KEEP 里的几个 id 参数，签名、msToken、xsec_token 不留。
// 要在 goto 之前装，对之后的新文档生效。
const HOOK = `(()=>{if(window.__engCap)return;const cap=window.__engCap=[];const MAX=2000000;
const KEEP=['note_id','root_comment_id','comment_id','item_id','chat_user_id','cursor'];
const strip=(u)=>{try{const x=new URL(String(u),location.href);const q=new URLSearchParams();for(const k of KEEP)if(x.searchParams.has(k))q.set(k,x.searchParams.get(k));const s=q.toString();return x.origin+x.pathname+(s?'?'+s:'')}catch(e){return String(u).split('?')[0]}};
const keep=(url,text)=>{try{if(!text||text[0]!=='{'&&text[0]!=='[')return;cap.push({url:strip(url),t:Date.now(),body:text.length>MAX?'':text});if(cap.length>400)cap.shift()}catch(e){}};
const of=window.fetch;window.fetch=function(...a){return of.apply(this,a).then(r=>{try{const u=typeof a[0]==='string'?a[0]:a[0]&&a[0].url;r.clone().text().then(t=>keep(u,t)).catch(()=>{})}catch(e){};return r})};
const oo=XMLHttpRequest.prototype.open,os=XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open=function(m,u,...r){this.__u=u;return oo.call(this,m,u,...r)};
XMLHttpRequest.prototype.send=function(...a){this.addEventListener('load',()=>{try{if(this.responseType===''||this.responseType==='text')keep(this.__u,this.responseText);else if(this.responseType==='json')keep(this.__u,JSON.stringify(this.response))}catch(e){}});return os.apply(this,a)}})()`;

export async function installHook(page) {
  await page.cdp('Page.enable', {});
  await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });
}

/** 抓到的响应（URL 匹配 re 源码），从第 from 条起：[{ url, t, body }]；body 是原文字符串。 */
export function captured(page, re, from = 0) {
  return page.evaluate(({ re, from }) => (window.__engCap || []).slice(from).filter((c) => new RegExp(re).test(c.url)), { re, from });
}
export const capCount = (page) => page.evaluate(() => (window.__engCap || []).length);

/** 等到抓到匹配 re 的响应（从第 from 条起），最多 timeoutMs；返回是否等到。 */
export async function waitCaptured(page, re, { from = 0, timeoutMs = 30000, stepMs = 1000 } = {}) {
  for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(stepMs)) {
    if ((await captured(page, re, from)).length) return true;
  }
  return false;
}

/** 当前页是不是登录页（URL 带 login / passport）。 */
export async function atLogin(page) {
  const u = await page.url();
  return /\/login|passport\.|\/signin/i.test(u) ? u.split('?')[0] : null;
}

/**
 * 点一个只读的「展开」按钮：在页面里给第一个符合条件的元素打标记，滚到可见后 page.click；点不到时退回 DOM click()。
 * findSrc 是在页面里执行的函数源码，返回要点的元素或 null（调用方保证只返回展开类按钮）。
 */
export async function clickMarked(page, findSrc, label) {
  const found = await page.evaluate(new Function(`const roots = [document, document.querySelector('wujie-app')?.shadowRoot].filter(Boolean);
    roots.forEach((r) => r.querySelectorAll('[data-eng-click]').forEach((x) => x.removeAttribute('data-eng-click')));
    const el = (${findSrc})();
    if (!el) return false; el.setAttribute('data-eng-click', '1'); el.dataset.engDone = '1'; el.scrollIntoView({ block: 'center' }); return true;`));
  if (!found) return false;
  await sleep(400);
  try { await page.click('[data-eng-click]', { label }); }
  catch { await page.evaluate(() => (document.querySelector('[data-eng-click]') ?? document.querySelector('wujie-app')?.shadowRoot?.querySelector('[data-eng-click]'))?.click()); }
  return true;
}

/** goto（等到 commit），超时重试一次；抖音、视频号后台有时 30 秒还没 commit。 */
export async function open(page, url, { timeout = 60000 } = {}) {
  try { await page.goto(url, { waitUntil: 'commit', timeout }); }
  catch { await sleep(2000); await page.goto(url, { waitUntil: 'commit', timeout }); }
}

/** 深拷贝时去掉 xsec_token 一类的键（小红书的 user_info、item_info 里都有），值不出页面。 */
export function dropSecrets(v) {
  if (Array.isArray(v)) return v.map(dropSecrets);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !/xsec|token|cookie|sign/i.test(k)).map(([k, x]) => [k, dropSecrets(x)]));
  return v;
}

/** 抓到的 URL 里留下的参数（见 HOOK 的 KEEP）。 */
export function urlParam(url, k) {
  try { return new URL(url, 'https://x.invalid').searchParams.get(k); } catch { return null; }
}
