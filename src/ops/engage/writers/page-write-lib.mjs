// 页面写入适配器共用（在 ego-browser nodejs 里跑，由 douyin / channels / xhs 的 runInSpace import）。
// 流程固定：打开页面 → 核对登录账号 → 平台各自的「发前重读」（找目标、判已回复 / 最后一句是我、点开输入框）
//          → 输入并读回 → 只点一次发送 → 在 readbackMs 内回读「我发的、内容等于 text」的新条目。
// 只碰评论回复框、私信框和它们的发送按钮。发送绝不重试：点过之后任何异常都按 sendAttempted:true 返回。
import { atLogin, capCount, captured, bigJson, installHook, mainPage, open, sleep } from '../adapters/page-lib.mjs';
import { redact } from '../redact.mjs';

export const DEFAULT_TIMEOUTS = { loadMs: 60000, readbackMs: 10000, settleMs: 3000, boxMs: 10000, sendMs: 2000 };

/** 比较用的正文：统一换行、nbsp、零宽字符，去掉末尾换行（contenteditable 的 innerText 常多一个）。 */
export const norm = (s) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/ /g, ' ').replace(/[​‌‍﻿]/g, '').replace(/\n+$/, '');

// 页面里的前言：在 document 和 wujie 的 shadowRoot（视频号）里都找
const PRELUDE = `const __roots = [document, document.querySelector('wujie-app')?.shadowRoot].filter(Boolean);
const __q = (s) => { for (const r of __roots) { const e = r.querySelector(s); if (e) return e; } return null; };
const __qa = (s) => __roots.flatMap((r) => [...r.querySelectorAll(s)]);
const __marked = (tag) => __q('[data-eng-w="' + tag + '"]');
`;

/** 在页面里跑一段函数体（可用 arg、__q、__qa、__marked），返回值要能 JSON 化。 */
export const inPage = (page, body, arg = null) => page.evaluate(new Function('arg', PRELUDE + body), arg);

export const markSel = (tag) => `[data-eng-w="${tag}"]`;

/** 给 findBody 返回的元素打上 data-eng-w=<tag>（先去掉旧的同名标记）；找不到返回 false。 */
export function mark(page, tag, findBody, arg = null) {
  return inPage(page, `__qa('[data-eng-w="${tag}"]').forEach((x) => x.removeAttribute('data-eng-w'));
    const el = (() => { ${findBody} })();
    if (!el) return false;
    el.setAttribute('data-eng-w', ${JSON.stringify(tag)});
    return true;`, arg);
}

export async function waitFor(fn, ms, stepMs = 500) {
  for (const end = Date.now() + ms; ;) {
    const v = await fn();
    if (v || Date.now() >= end) return v;
    await sleep(stepMs);
  }
}

// —— 输入框 ——
const BOX_TEXT = `const el = __marked('box'); if (!el) return null;
  return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? el.value : el.innerText;`;
export const boxText = (page) => inPage(page, BOX_TEXT);

// 聚焦；contenteditable 把光标放到末尾
const FOCUS = `const el = __marked('box'); if (!el) return false;
  el.focus();
  if (el.isContentEditable) { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  return true;`;

/** 清空输入框：先全选再按一次退格（走编辑器自己的输入路径）；还有字就直接置空并发 input 事件。 */
export async function clearBox(page) {
  await inPage(page, `const el = __marked('box'); if (!el) return false; el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') el.select();
    else { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    return true;`);
  await page.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await sleep(200);
  if (!norm(await boxText(page))) return true;
  await inPage(page, `const el = __marked('box'); if (!el) return false;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, ''); }
    else el.textContent = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;`);
  await sleep(200);
  return !norm(await boxText(page));
}

/** 往已标记的 box 里输入 text：聚焦 → Input.insertText → 读回；不一致就清空并返回 blocked。 */
export async function typeText(page, text) {
  await page.cdp('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  // 框里有残留草稿时先清掉，否则读回必然对不上
  if (norm(await boxText(page))) await clearBox(page);
  if (!(await inPage(page, FOCUS))) return { blocked: 'no-input-box', detail: '输入框在输入前消失了' };
  await page.cdp('Input.insertText', { text });
  await sleep(300);
  const got = norm(await boxText(page));
  if (got === norm(text)) return {};
  const cleared = await clearBox(page);
  return { blocked: 'input-mismatch', detail: `输入框读回 ${got.length} 字，和要发的 ${norm(text).length} 字不一致${cleared ? '，已清空' : '，清空后仍有残留'}；没点发送` };
}

/** 发送按钮：从输入框往上最多 levels 层，找文字等于 re 的按钮类元素（不进评论操作区）。 */
export const sendNearBox = (re = '^发送$', levels = 4) => `const box = __marked('box'); if (!box) return null;
  const re = new RegExp(${JSON.stringify(re)});
  const txt = (e) => (e.innerText || e.textContent || '').trim();
  for (let e = box.parentElement, i = 0; e && i < ${levels}; e = e.parentElement, i++) {
    const hits = [...e.querySelectorAll('button, [role=button], div, span, a')]
      .filter((x) => re.test(txt(x)) && !x.closest('[class*=operations-]') && !x.querySelector('textarea, [contenteditable=true]') && !box.contains(x));
    // 取最里层的那个（外层容器的文字也可能正好是「发送」）
    const inner = hits.filter((h) => !hits.some((o) => o !== h && h.contains(o)));
    if (inner.length) return inner.at(-1);
  }
  return null;`;

// 页面上的报错提示（toast / alert 类），只看可见的、短的
const TOASTS = `const re = /失败|错误|异常|频繁|稍后|违规|无法|不能|受限|限制|不支持/;
  const out = [];
  for (const e of __qa('[class*=toast], [class*=Toast], [role=alert], [class*=notice], [class*=Notice]')) {
    const t = (e.innerText || '').trim();
    if (t && t.length < 80 && re.test(t) && e.getClientRects().length) out.push(t);
  }
  return [...new Set(out)];`;
export const toasts = (page) => inPage(page, TOASTS);

/** 抓到的 JSON 响应（从第 from 条起，URL 匹配 re）：[{ url, json }]。 */
export async function capturedJson(page, re, from = 0) {
  return (await captured(page, re, from)).map((c) => ({ url: c.url, json: bigJson(c.body) })).filter((c) => c.json);
}

/** 在 JSON 里递归找满足 test 的对象（深度有限）。 */
export function findObjects(v, test, depth = 6, out = []) {
  if (!v || typeof v !== 'object' || depth < 0) return out;
  if (!Array.isArray(v) && test(v)) out.push(v);
  for (const x of Array.isArray(v) ? v : Object.values(v)) if (x && typeof x === 'object') findObjects(x, test, depth - 1, out);
  return out;
}

const uniqById = (xs) => [...new Map(xs.map((x) => [String(x.id), x])).values()];

/**
 * 写入主流程。plat：
 *   hook             是否挂钩页面请求（installHook，goto 前装）
 *   url(params, op)  要打开的页面
 *   login(page, params, t)  → { uid, nickname } | { loginLost, evidence } | { uid: null, detail }
 *   prepareReply / prepareDM(ctx)  → { blocked, detail } | { send: 找按钮的函数体 | 'enter', items(), apiError?(from) }
 *       调用前 ctx 已核对过账号；返回时输入框已打上 'box' 标记。
 *       items() 返回页面上能看到的条目 [{ id, mine, rel, text }]：rel 表示「挂在目标下 / 在这个会话里」。
 */
export async function runWrite(task, params, plat) {
  const t = { ...DEFAULT_TIMEOUTS, ...(params.timeouts ?? {}) };
  const out = { uidSeen: null, sendAttempted: false };
  if (params.op !== 'reply' && params.op !== 'sendDM') return { ...out, blocked: 'precheck-error', detail: `op 只能是 reply 或 sendDM：${params.op}` };
  if (!norm(params.text).trim()) return { ...out, blocked: 'precheck-error', detail: 'text 为空' };
  try {
    const page = await mainPage(task);
    if (plat.hook) await installHook(page);
    await open(page, plat.url(params));
    await waitFor(() => page.evaluate(() => document.readyState === 'complete'), Math.min(t.loadMs, 30000));
    const lost = await atLogin(page);
    if (lost) return { ...out, loginLost: true, evidence: redact(`页面在 ${lost}`) };
    const who = (await plat.login(page, params, t)) ?? {};
    if (who.loginLost) return { ...out, loginLost: true, evidence: redact(who.evidence ?? '') };
    out.uidSeen = who.uid == null || who.uid === '' ? null : String(who.uid);
    if (!out.uidSeen) return { ...out, blocked: 'no-uid', detail: redact(who.detail ?? '页面上没读到当前登录账号的 uid') };
    if (out.uidSeen !== String(params.uid).trim()) return { ...out, blocked: 'uid-mismatch', detail: `页面登录的是 ${out.uidSeen}，要用的账号是 ${params.uid}` };
    const ctx = { page, params, t, me: who };
    const step = params.op === 'reply' ? await plat.prepareReply(ctx) : await plat.prepareDM(ctx);
    if (step.blocked) return { ...out, blocked: step.blocked, ...(step.detail ? { detail: redact(step.detail) } : {}) };
    const typed = await typeText(page, params.text);
    if (typed.blocked) return { ...out, ...typed };
    // 输入后页面要重渲染一下才把发送按钮从 disabled 放开，最多等 sendMs 再找
    if (step.send !== 'enter' && !(await waitFor(() => mark(page, 'send', step.send), t.sendMs, 250))) {
      await clearBox(page);
      return { ...out, blocked: 'cannot-send', detail: '输入框旁边没找到能点的发送按钮（没有，或一直是 disabled），已清空输入框，没点发送' };
    }
    const before = new Set((await step.items()).map((x) => String(x.id)));
    const toastBefore = new Set(await toasts(page));
    const capFrom = plat.hook ? await capCount(page) : 0;
    out.sendAttempted = true;
    if (step.send === 'enter') {
      await page.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
      await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    } else await page.click(markSel('send'), { label: 'send reply once' });
    return { ...out, ...(await readBack(page, step, { before, toastBefore, capFrom, t, text: params.text })) };
  } catch (e) {
    // 点过发送之后的异常一律不往外抛：发没发出去不确定，交给上层按「已尝试」处理
    if (out.sendAttempted) return { ...out, readBack: { found: false, count: 0, nativeId: null, detail: redact(`发送后出错：${e?.message ?? e}`) } };
    // 还没点发送：一定没发，按「重读出错」返回，框架记 failed（可再试），不记 needs_readback
    return { ...out, blocked: 'precheck-error', detail: redact(`发送前出错：${e?.message ?? e}`) };
  }
}

async function readBack(page, step, { before, toastBefore, capFrom, t, text }) {
  const want = norm(text);
  const fresh = async () => uniqById((await step.items()).filter((x) => x.id != null && !before.has(String(x.id)) && x.mine && x.rel && norm(x.text) === want));
  const pageError = async () => {
    const api = step.apiError ? await step.apiError(capFrom) : null;
    if (api) return api;
    return (await toasts(page)).find((x) => !toastBefore.has(x)) ?? null;
  };
  let hits = [], err = null;
  for (const end = Date.now() + t.readbackMs; ;) {
    hits = await fresh();
    if (hits.length) break;
    err ??= await pageError();
    if (Date.now() >= end) break;
    await sleep(500);
  }
  // 读到了再等一下重数一次，看有没有重复出现的
  if (hits.length) { await sleep(1000); hits = await fresh(); }
  const count = hits.length;
  if (count === 1) return { readBack: { found: true, count, nativeId: String(hits[0].id) } };
  if (count > 1) return { readBack: { found: false, count, nativeId: null, detail: `读到 ${count} 条我发的、内容相同的新条目` } };
  err ??= await pageError();
  if (err) return { sendError: redact(err), readBack: { found: false, count: 0, nativeId: null, detail: '页面报错，且没读到新条目' } };
  return { readBack: { found: false, count: 0, nativeId: null, detail: `${t.readbackMs}ms 内没读到我发的这条` } };
}
