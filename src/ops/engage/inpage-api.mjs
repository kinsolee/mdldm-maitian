// 页面内接口（S9）：在登录态页面里调页面自己的接口封装函数，签名、鉴权头、风控 SDK 都由页面自己加，Node 里不拼签名。
//   抖音：评论管理页是 Garfish 子应用 interactive，沙箱 global 上的 webpackChunkcreator_interactive 里有评论服务对象
//        （awemeV1CommentListSelect / awemeV1CommentListReply / awemeV1CommentMultiPublish …，2026-11-21 只读探针核对）。
//   视频号：业务请求从 wujie 沙箱 iframe 发，iframe window 上的 webpackChunkinteraction 里有评论服务实例
//        （getCommentList / createComment …）。
//   小红书不用：探针里自己算 x-s / x-t 去调 comment/page 返回 300011「Account abnormal」，见 docs/migration/S9-in-page-api.md。
// 找服务：往 webpack chunk 数组 push 一个空 chunk 拿到 __webpack_require__，按模块源码里的方法名找模块（模块 id 每次发版会变），
// 再在导出里找带这些方法的对象。只取函数引用，不改页面状态。找不到返回 false，调用方退回 DOM 路径。
// 调用：call(method, args) → { ok: true, data } | { ok: false, error }。页面服务对非 0 返回码会抛错（抖音）或返回 errCode（视频号），都原样交给调用方判断。

export const SERVICES = {
  Douyin: { methods: ['awemeV1CommentListSelect', 'awemeV1CommentListReply', 'awemeV1CommentMultiPublish'], marks: ['awemeV1CommentListSelect:', 'awemeV1CommentMultiPublish:'] },
  Channels: { methods: ['getCommentList', 'createComment'], marks: ['async getCommentList(', 'async createComment('] },
};

// 翻页标志：只有明确是 0 / false 才算翻到底；明确是 1 / true 才算还有下一页；缺失、别的值一律当「不知道」，按没读全处理
export const pageEnd = (v) => v === 0 || v === false || v === '0';
export const pageMore = (v) => v === 1 || v === true || v === '1';
/** 条数：有限数字或非空数字字符串才算，其余（null、''、布尔）返回 null。 */
export const countOf = (v) => ((typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v)) ? Number(v) : null);
/** 发送接口给的新 id：空串、"0" 不算。 */
export const idOf = (v) => (v == null || v === '' || String(v) === '0' ? null : String(v));

/** 在页面里找服务并挂到 window.__engSvc[platform]。参数 { platform, methods, marks }，返回是否找到。导出给测试在假 window 上跑。 */
export function locateService({ platform, methods, marks }) {
  const slot = (window.__engSvc = window.__engSvc || {});
  if (slot[platform]) return true;
  const globals = [];
  if (platform === 'Douyin') {
    const G = window.Garfish;
    for (const app of Object.values(G?.activeApps ?? {})) { const g = app?.global; if (g?.webpackChunkcreator_interactive) globals.push(g.webpackChunkcreator_interactive); }
  } else {
    for (const f of document.querySelectorAll('iframe')) {
      let w = null; try { w = f.contentWindow; if (!(w.__WUJIE || w.__POWERED_BY_WUJIE__)) w = null; } catch { w = null; }
      if (w?.webpackChunkinteraction) globals.push(w.webpackChunkinteraction);
    }
  }
  for (const chunk of globals) {
    // webpack runtime 还没接管时 push 就是数组原型上的方法，往里塞空 chunk 没用，还会留在页面数组里。
    // 不能按 toString 里有没有 [native code] 判：webpack 5 接管后的 push 是 .bind() 出来的，toString 也是 [native code]
    try { if (typeof chunk.push !== 'function' || chunk.push === Object.getPrototypeOf(chunk)?.push) continue; } catch { continue; }
    let req = null;
    try { chunk.push([[`__eng_${Date.now()}_${Math.random()}`], {}, (r) => { req = r; }]); } catch { continue; }
    if (!req?.m) continue;
    for (const id of Object.keys(req.m)) {
      let src = ''; try { src = String(req.m[id]); } catch { continue; }
      if (!marks.every((m) => src.includes(m))) continue;
      let mod = null; try { mod = req(id); } catch { continue; }
      for (const v of Object.values(mod ?? {})) {
        if (v && typeof v === 'object' && methods.every((m) => typeof v[m] === 'function')) { slot[platform] = v; return true; }
      }
    }
  }
  return false;
}

/** 在页面里调一次服务方法。返回值走 JSON 往返（去掉函数、循环引用的部分会报错，按 ok:false 返回）。 */
export async function callInPage({ platform, method, args }) {
  const s = window.__engSvc?.[platform];
  if (!s || typeof s[method] !== 'function') return { ok: false, error: `页面服务没有 ${method}` };
  try { const d = await s[method](args); return { ok: true, data: JSON.parse(JSON.stringify(d ?? null)) }; }
  catch (e) {
    let msg = e?.message;
    if (msg == null && e && typeof e === 'object') {
      try { msg = JSON.stringify({ status_code: e.status_code, status_msg: e.status_msg, errCode: e.errCode, errMsg: e.errMsg }); if (msg === '{}') msg = JSON.stringify(e); } catch { msg = null; }
    }
    return { ok: false, error: String(msg ?? e).slice(0, 300) };
  }
}

/**
 * 等页面服务出来（最多 waitMs），返回 call(method, args)；等不到返回 null。
 * gapMs：两次调用之间至少隔这么久，节奏不快于人工翻页。
 */
export async function serviceCaller(page, platform, { waitMs = 60000, stepMs = 1500, gapMs = 800, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!SERVICES[platform]) return null;
  const spec = { platform, ...SERVICES[platform] };
  let found = false;
  for (const end = Date.now() + waitMs; !found; await sleep(stepMs)) {
    found = await page.evaluate(locateService, spec).catch(() => false);
    if (found || Date.now() >= end) break;
  }
  if (!found) return null;
  let last = 0;
  return async (method, args) => {
    const wait = last + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    try { return await page.evaluate(callInPage, { platform, method, args }); }
    catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 300) }; }
    finally { last = Date.now(); }
  };
}
