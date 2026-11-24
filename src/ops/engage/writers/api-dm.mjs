// 抖音发私信走页面内接口（账号能力位 writeDmViaApi 打开时 params.writeVia = 'api'）。不点会话、不往编辑框打字、不点发送。
// 调的是私信页自己的函数，IM 长连接、protobuf、ticket、身份安全 token 都由页面和 IM SDK 自己处理，Node 里不拼任何东西。
// 2026-11-24 只读探针（只读模块源码，没调发送、没调写接口）核对的页面发送流程（私信页是 Garfish 子应用 douyin_creator_data）：
//   聊天区 React Context 的 value 上有 bytedIM（IM SDK 实例）、sendMessageWithAuth、reportAction、conversationList。
//   编辑框按回车或点「发送」时：
//     msg = bytedIM.createMessage({ type: 7（TEXT）, content: JSON.stringify({ text, aweType: 774 }), conversation })   只建本地消息
//     reportAction({ conversationId, messageClientId: msg.clientId, content, actionParams: {}, msgType: msg.type })     不等它
//     r = sendMessageWithAuth({ message: msg, isRetry: false })   先取身份安全 token（scene im_send_msg）加到发送头，再 bytedIM.sendMessage
//   页面认的成功：r.success === true，并且 r.body.status 缺失或为 0；成功时 SDK 把服务端 id 写进 msg.serverId。
//   身份安全 token 超时时 sendMessageWithAuth 不发、返回 undefined。
// 发前重读、发后回读：bytedIM.getMessagesByConversation({ conversation, direction: 3（FROM_LATEST）, limit })，从服务端拉最新一页。
// 返回不是上面的成功形状（包括抛错、undefined），一律不当成功也不当失败，交给框架记 needs_readback。
import { idOf } from '../inpage-api.mjs';
import { norm } from './page-write-lib.mjs';

export const DM_LIMITS = { pull: 20, maxText: 500 };

/**
 * 在私信页里执行（page.evaluate 序列化，函数体要自包含）。method：
 *   locate：私信服务出来了没有（IM SDK 初始化完、会话列表加载过）
 *   conv  { conversationId, peerUid }：找会话，返回摘要
 *   pull  { conversationId, limit }：从服务端拉最新一页消息
 *   send  { conversationId, text }：照页面的顺序建消息、发一次
 * 返回 { ok: true, ... } | { ok: false, error }。消息正文只在 pull 里带回（Node 侧比对用），不进日志和诊断。
 */
export async function dmInPage({ method, args = {} }) {
  const fiberOf = (el) => { const k = Object.keys(el).find((x) => x.startsWith('__reactFiber')); return k ? el[k] : null; };
  const isSvc = (v) => !!v && typeof v === 'object' && !!v.bytedIM && typeof v.bytedIM.createMessage === 'function'
    && typeof v.bytedIM.getMessagesByConversation === 'function' && typeof v.sendMessageWithAuth === 'function' && Array.isArray(v.conversationList);
  let svc = null;
  const starts = [...document.querySelectorAll('li.semi-list-item'), ...document.querySelectorAll('[class*=chat-]')].slice(0, 30);
  for (const el of starts) {
    for (let f = fiberOf(el), d = 0; f && d < 120 && !svc; f = f.return, d++) { const v = f.memoizedProps?.value; if (isSvc(v)) svc = v; }
    if (svc) break;
  }
  if (!svc) return { ok: false, error: '页面私信服务没找到' };
  if (method === 'locate') return svc.conversationList.length > 0 || svc.loading === false ? { ok: true } : { ok: false, error: '会话列表还没加载' };

  const errText = (e) => String(e?.message ?? e?.type ?? e).slice(0, 200);
  const sidOf = (v) => (v == null || v === '' || String(v) === '0' ? null : String(v));
  const all = [...svc.conversationList, ...(Array.isArray(svc.strangerConversationList) ? svc.strangerConversationList : [])].filter(Boolean);
  const want = args.conversationId != null ? String(args.conversationId) : null;
  const conv = (want != null ? all.find((c) => String(c.id) === want) : null)
    ?? (args.peerUid != null ? all.find((c) => !c.isGroupChat && String(c.toParticipantUserId) === String(args.peerUid)) : null);
  if (!conv) return { ok: false, notFound: true, error: '会话列表里没有这个会话' };
  const lm = conv.lastMessage;
  const summary = { id: String(conv.id), group: !!conv.isGroupChat, stranger: !!conv.isStrangerChat,
    last: lm ? { sid: sidOf(lm.serverId), type: lm.type ?? null, mine: typeof lm.isFromMe === 'boolean' ? lm.isFromMe : null } : null };
  if (method === 'conv') return { ok: true, conv: summary };

  const t0 = Date.now();
  if (method === 'pull') {
    let r;
    try { r = await svc.bytedIM.getMessagesByConversation({ conversation: conv, direction: 3, limit: args.limit ?? 20 }); }
    catch (e) { return { ok: false, error: `getMessagesByConversation 出错：${errText(e)}`, ms: Date.now() - t0 }; }
    if (!r || !Array.isArray(r.messages)) return { ok: false, error: 'getMessagesByConversation 返回里没有 messages', ms: Date.now() - t0 };
    const msgs = r.messages.filter((m) => m && (m.conversationId == null || String(m.conversationId) === summary.id)).map((m) => {
      let text = null;
      try { text = (typeof m.content === 'string' ? JSON.parse(m.content) : m.content)?.text ?? null; } catch { text = null; }
      const sid = sidOf(m.serverId);
      return { key: sid ?? `c:${m.clientId ?? m.uuid ?? ''}`, sid, mine: m.isFromMe === true, text: typeof text === 'string' ? text : null,
        idx: m.indexInConversation != null ? String(m.indexInConversation) : null, type: m.type ?? null };
    });
    return { ok: true, conv: summary, msgs, total: r.messages.length, ms: Date.now() - t0 };
  }

  if (method === 'send') {
    if (summary.group) return { ok: false, error: '群聊不发' };
    const content = JSON.stringify({ text: String(args.text), aweType: 774 });
    const o = { type: 7, content, conversation: conv };
    let msg;
    try { msg = await (typeof svc.createMessage === 'function' ? svc.createMessage(o) : svc.bytedIM.createMessage(o)); }
    catch (e) { return { ok: false, stage: 'create', error: `createMessage 出错：${errText(e)}`, ms: Date.now() - t0 }; }
    if (!msg) return { ok: false, stage: 'create', error: 'createMessage 没返回消息', ms: Date.now() - t0 };
    try { const p = svc.reportAction?.({ conversationId: conv.id, messageClientId: msg.clientId, content, actionParams: {}, msgType: msg.type }); p?.catch?.(() => {}); } catch { /* 页面自己也不等它、出错只打日志 */ }
    let r;
    try { r = await svc.sendMessageWithAuth({ message: msg, isRetry: false }); }
    catch (e) { return { ok: false, stage: 'send', error: `sendMessageWithAuth 出错：${errText(e)}`, ms: Date.now() - t0 }; }
    const num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : String(v).slice(0, 20));
    return { ok: true, ms: Date.now() - t0, res: r == null ? null : {
      success: r.success === true, statusCode: num(r.statusCode), bodyStatus: num(r.body?.status), checkCode: num(r.checkCode),
      sid: sidOf(msg.serverId ?? r.payload?.serverId), flight: num(msg.flightStatus),
    } };
  }
  return { ok: false, error: `不认识的 method：${method}` };
}

/** 等私信服务出来（最多 waitMs），返回 call(method, args)；等不到返回 null。两次调用之间至少隔 gapMs（S9 第 6 节）。 */
export async function dmCaller(page, _platform, { waitMs = 60000, stepMs = 1500, gapMs = 800, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let found = false;
  for (const end = Date.now() + waitMs; ; await sleep(stepMs)) {
    found = (await page.evaluate(dmInPage, { method: 'locate' }).catch(() => null))?.ok === true;
    if (found || Date.now() >= end) break;
  }
  if (!found) return null;
  let last = 0;
  return async (method, args) => {
    const wait = last + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    try { return await page.evaluate(dmInPage, { method, args }); }
    catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 300) }; }
    finally { last = Date.now(); }
  };
}

// 按会话里的序号排（序号是 int64 的十进制串）；没有序号的排最前，不当「最后一句」
const byIdx = (a, b) => (a.idx == null ? -1 : b.idx == null ? 1 : BigInt(a.idx) < BigInt(b.idx) ? -1 : BigInt(a.idx) > BigInt(b.idx) ? 1 : 0);
const sendDiag = (r) => (!r.ok ? `send=err:${r.stage ?? '?'}` : !r.res ? 'send=undefined' : `send=s${+r.res.success},st${r.res.statusCode ?? '-'},b${r.res.bodyStatus ?? '-'},ck${r.res.checkCode ?? '-'},fs${r.res.flight ?? '-'},id${+(r.res.sid != null)}`) + `,${r.ms ?? '-'}ms`;

export const douyinDmApi = {
  platform: 'Douyin',
  op: 'sendDM',
  cap: 'writeDmViaApi',
  service: '页面自己的私信服务（IM SDK）',
  caller: dmCaller,
  async precheck({ call, params }) {
    const t = params.target ?? {};
    if ([...norm(params.text)].length > DM_LIMITS.maxText) return { blocked: 'text-too-long', detail: `私信页编辑框最多 ${DM_LIMITS.maxText} 字` };
    const c = await call('conv', { conversationId: t.conversationId ?? null, peerUid: t.peerUid ?? null });
    if (!c.ok) return c.notFound ? { blocked: 'target-not-found', detail: `私信列表里没有会话 ${t.conversationId ?? t.peerUid}（列表只显示最近的会话）` } : { blocked: 'precheck-error', detail: c.error };
    if (c.conv.group) return { blocked: 'cannot-send', detail: '群聊不发' };
    if (c.conv.last?.mine === true) return { blocked: 'last-is-me', detail: '会话最后一句是我说的' };
    const p = await call('pull', { conversationId: c.conv.id, limit: DM_LIMITS.pull });
    if (!p.ok) return { blocked: 'precheck-error', detail: `发前拉会话消息失败：${p.error}` };
    // 拉到的要是最新一页：本地记着的最后一条文字消息得在里面，否则方向或游标不对，判断不了最后一句是谁说的
    if (c.conv.last?.sid && c.conv.last.type === 7 && !p.msgs.some((m) => m.sid === c.conv.last.sid)) return { blocked: 'precheck-error', detail: `发前拉到的 ${p.msgs.length} 条里没有会话的最后一条，不是最新一页，没发` };
    const last = [...p.msgs].sort(byIdx).at(-1);
    if (last?.mine) return { blocked: 'last-is-me', detail: '拉到的最后一句是我说的' };
    return { state: { conversationId: c.conv.id, before: new Set(p.msgs.map((m) => m.key)), diag: null } };
  },
  async send({ call, params }, s) {
    const r = await call('send', { conversationId: s.conversationId, text: params.text });
    s.diag = sendDiag(r);
    const x = r.ok ? r.res : null;
    const sid = x && x.success && (x.bodyStatus == null || x.bodyStatus === 0) ? idOf(x.sid) : null;
    if (sid != null) return { ok: true, nativeId: sid };
    return { ok: false, detail: `诊断api v1 api=sendMessageWithAuth ${s.diag}${r.ok ? '' : ` ${r.error}`}` };
  },
  async fresh({ call, params }, s) {
    const p = await call('pull', { conversationId: s.conversationId, limit: DM_LIMITS.pull });
    if (!p.ok) return { items: null, detail: `诊断api v1 api=sendMessageWithAuth ${s.diag ?? '-'} pull=err ${p.error}` };
    const want = norm(params.text);
    const fresh = p.msgs.filter((m) => !s.before.has(m.key)), mine = fresh.filter((m) => m.mine), eq = mine.filter((m) => m.text != null && norm(m.text) === want);
    const items = [...new Set(eq.map((m) => m.key))];
    return { items, detail: `诊断api v1 api=sendMessageWithAuth ${s.diag ?? '-'} pull=getMessagesByConversation n=${p.msgs.length}/${fresh.length}/${mine.length}/${eq.length},${p.ms ?? '-'}ms` };
  },
};
