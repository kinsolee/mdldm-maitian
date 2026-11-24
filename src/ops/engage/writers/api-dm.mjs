// 抖音发私信走页面内接口（账号能力位 writeDmViaApi 打开时 params.writeVia = 'api'）。不点会话、不往编辑框打字、不点发送。
// 调的是私信页自己的函数，IM 长连接、protobuf、ticket、身份安全 token 都由页面和 IM SDK 自己处理，Node 里不拼任何东西。
// 2026-11-24 只读探针（只读模块源码和 Context 字段，没调发送、没调读写接口）核对的页面发送流程（私信页是 Garfish 子应用 douyin_creator_data）：
//   聊天区 React Context 的 value 上有 bytedIM（IM SDK 实例）、sendMessageWithAuth、reportAction、conversationList；
//   更外层的 Context 上有 userInfo（uid、is_confer_login）。
//   编辑框按回车或点「发送」时：
//     checkIMPermisstion(is_confer_login)：代运营登录才去查代运营权限。我们不调它，改成「只有证实是本人登录才发」：
//       userInfo.is_confer_login 严格是 false、userInfo.uid 等于要用的账号，否则不发（cannot-send）
//     msg = bytedIM.createMessage({ type: 7（TEXT）, content: JSON.stringify({ text, aweType: 774 }), conversation })   只建本地消息
//     reportAction({ conversationId, messageClientId: msg.clientId, content, actionParams: {}, msgType: msg.type })     不等它
//     r = sendMessageWithAuth({ message: msg, isRetry: false })   先取身份安全 token（scene im_send_msg）加到发送头，再 bytedIM.sendMessage
//   页面认的成功：r.success === true，并且 r.body.status 缺失或为 0；成功时 SDK 把服务端 id 写进 msg.serverId。
//   身份安全 token 超时时 sendMessageWithAuth 不发、返回 undefined。
// 发前重读、发后回读：bytedIM.getMessagesByConversation({ conversation, direction: 3（FROM_LATEST）, limit })，从服务端拉最新一页。
//   发前：拉到的消息里要有会话（拉完时）的最后一条，才算拉到了最新一页；记下这一页最大的会话序号当边界。
//   发后：只数序号大于边界的消息；这一页要覆盖到边界（有序号不大于边界的消息），否则确认不了只有一条。
// 返回不是上面的成功形状（包括抛错、undefined、返回码的类型或值不认识），一律不当成功也不当失败，交给框架记 needs_readback。
// 页面明确还没调 sendMessageWithAuth 就停下的（服务没了、会话没了、建消息出错），返回 notSent，记 cannot-send，不锁目标。
// 诊断只有固定的接口名、阶段、数字返回码、条数、耗时，不带异常原文（可能含正文）、cookie、token。
import { idOf } from '../inpage-api.mjs';
import { norm } from './page-write-lib.mjs';

export const DM_LIMITS = { pull: 20, maxText: 500 };

/**
 * 在私信页里执行（page.evaluate 序列化，函数体要自包含）。method：
 *   locate：私信服务出来了没有（IM SDK 初始化完、会话列表加载过）
 *   conv  { conversationId, peerUid, uid }：找会话、核对本人登录，返回摘要
 *   pull  { conversationId, limit }：从服务端拉最新一页消息
 *   send  { conversationId, text, uid }：照页面的顺序建消息、发一次
 * 返回 { ok: true, ... } | { ok: false, code, notSent?, missing?, notFound? }。不返回异常原文；消息正文只在 pull 里带回（Node 侧比对用）。
 */
export async function dmInPage({ method, args = {} }) {
  const fiberOf = (el) => { const k = Object.keys(el).find((x) => x.startsWith('__reactFiber')); return k ? el[k] : null; };
  const isSvc = (v) => !!v && typeof v === 'object' && !!v.bytedIM && typeof v.bytedIM.createMessage === 'function'
    && typeof v.bytedIM.getMessagesByConversation === 'function' && typeof v.sendMessageWithAuth === 'function' && Array.isArray(v.conversationList);
  const isUser = (v) => !!v && typeof v === 'object' && !!v.userInfo && typeof v.userInfo === 'object';
  let svc = null, user = null;
  const starts = [...document.querySelectorAll('li.semi-list-item'), ...document.querySelectorAll('[class*=chat-]')].slice(0, 30);
  for (const el of starts) {
    for (let f = fiberOf(el), d = 0; f && d < 200 && !(svc && user); f = f.return, d++) {
      const v = f.memoizedProps?.value;
      if (!svc && isSvc(v)) svc = v;
      if (!user && isUser(v)) user = v.userInfo;
    }
    if (svc && user) break;
  }
  if (!svc) return { ok: false, code: 'service-missing', missing: true, notSent: true };
  if (method === 'locate') return svc.conversationList.length > 0 || svc.loading === false ? { ok: true } : { ok: false, code: 'list-loading' };

  const codeOf = (e) => (typeof e?.type === 'number' && Number.isInteger(e.type) ? `t${e.type}` : /^[A-Za-z]{1,40}$/.test(String(e?.name ?? '')) ? e.name : 'Error');
  const sidOf = (v) => (v != null && /^\d{1,30}$/.test(String(v)) && String(v) !== '0' ? String(v) : null);
  const idxOf = (v) => (v != null && /^\d{1,25}$/.test(String(v)) ? String(v) : null);
  const isGroup = (c) => !!(c.isGroupChat ?? c.type === 2);
  // 本人登录：is_confer_login 严格是 false，并且 userInfo 的 uid 就是要用的账号
  const login = { owner: user ? (user.is_confer_login === false ? 1 : user.is_confer_login === true ? 0 : -1) : null,
    uidMatch: !!user && args.uid != null && String(user.uid) === String(args.uid) };
  const all = [...svc.conversationList, ...(Array.isArray(svc.strangerConversationList) ? svc.strangerConversationList : [])].filter(Boolean);
  // 给了会话 id 就只认这个会话；只有没给会话 id 时才按对方 uid 找单聊
  const conv = args.conversationId != null ? all.find((c) => String(c.id) === String(args.conversationId))
    : args.peerUid != null ? all.find((c) => !isGroup(c) && String(c.toParticipantUserId) === String(args.peerUid)) : null;
  if (!conv) return { ok: false, code: 'conv-not-found', notFound: true, notSent: true };
  const summary = () => {
    const lm = conv.lastMessage;
    return { id: String(conv.id), group: isGroup(conv), stranger: !!conv.isStrangerChat,
      last: lm ? { sid: sidOf(lm.serverId), idx: idxOf(lm.indexInConversation), mine: typeof lm.isFromMe === 'boolean' ? lm.isFromMe : null } : null };
  };
  if (method === 'conv') return { ok: true, conv: summary(), login };

  const t0 = Date.now();
  if (method === 'pull') {
    let r;
    try { r = await svc.bytedIM.getMessagesByConversation({ conversation: conv, direction: 3, limit: args.limit ?? 20 }); }
    catch (e) { return { ok: false, code: `pull:${codeOf(e)}`, ms: Date.now() - t0 }; }
    if (!r || !Array.isArray(r.messages)) return { ok: false, code: 'pull:no-messages', ms: Date.now() - t0 };
    const msgs = r.messages.filter((m) => m && (m.conversationId == null || String(m.conversationId) === String(conv.id))).map((m) => {
      let text = null;
      try { text = (typeof m.content === 'string' ? JSON.parse(m.content) : m.content)?.text ?? null; } catch { text = null; }
      return { sid: sidOf(m.serverId), mine: m.isFromMe === true, text: typeof text === 'string' ? text : null, idx: idxOf(m.indexInConversation) };
    });
    // 会话摘要在拉完之后取：SDK 处理拉到的消息时会更新会话的最后一条
    return { ok: true, conv: summary(), msgs, total: r.messages.length, ms: Date.now() - t0 };
  }

  if (method === 'send') {
    // 下面这几种都在调 sendMessageWithAuth 之前停下，页面确定没发
    if (login.owner !== 1 || !login.uidMatch) return { ok: false, code: 'not-owner-login', notSent: true };
    if (isGroup(conv)) return { ok: false, code: 'group', notSent: true };
    const content = JSON.stringify({ text: String(args.text), aweType: 774 });
    const o = { type: 7, content, conversation: conv };
    let msg;
    try { msg = await (typeof svc.createMessage === 'function' ? svc.createMessage(o) : svc.bytedIM.createMessage(o)); }
    catch (e) { return { ok: false, code: `create:${codeOf(e)}`, notSent: true }; }
    if (!msg) return { ok: false, code: 'create:empty', notSent: true };
    try { const p = svc.reportAction?.({ conversationId: conv.id, messageClientId: msg.clientId, content, actionParams: {}, msgType: msg.type }); p?.catch?.(() => {}); } catch { /* 页面自己也不等它、出错只打日志 */ }
    let r;
    try { r = await svc.sendMessageWithAuth({ message: msg, isRetry: false }); }
    catch (e) { return { ok: false, code: `send:${codeOf(e)}`, ms: Date.now() - t0 }; }
    // 返回码只认整数；缺失记 null，其余类型（false、空串、对象…）记 'x'，Node 侧按不认识处理
    const int = (v) => (v == null ? null : typeof v === 'number' && Number.isInteger(v) ? v : 'x');
    const long = (v) => (v == null ? null : typeof v === 'number' && Number.isInteger(v) ? v : typeof v?.toString === 'function' && /^-?\d{1,12}$/.test(String(v)) ? Number(String(v)) : 'x');
    return { ok: true, ms: Date.now() - t0, res: r == null ? null : {
      success: r.success === true ? 1 : r.success === false ? 0 : 'x', statusCode: int(r.statusCode), bodyStatus: int(r.body?.status), checkCode: long(r.checkCode),
      sid: sidOf(msg.serverId), flight: int(msg.flightStatus),
    } };
  }
  return { ok: false, code: 'bad-method', notSent: true };
}

/** 等私信服务出来（最多 waitMs），返回 call(method, args)；等不到返回 null。两次页面调用（含最后一次定位）之间至少隔 gapMs（S9 第 6 节）。 */
export async function dmCaller(page, _platform, { waitMs = 60000, stepMs = 1500, gapMs = 800, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let found = false;
  for (const end = Date.now() + waitMs; ; await sleep(stepMs)) {
    found = (await page.evaluate(dmInPage, { method: 'locate' }).catch(() => null))?.ok === true;
    if (found || Date.now() >= end) break;
  }
  if (!found) return null;
  let last = Date.now();
  return async (method, args) => {
    const wait = last + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    // 页面调用本身失败：不知道页面里跑到了哪一步，不带 notSent
    try { return await page.evaluate(dmInPage, { method, args }); }
    catch { return { ok: false, code: 'evaluate-failed' }; }
    finally { last = Date.now(); }
  };
}

const big = (s) => BigInt(s);
const sendDiag = (r) => (!r.ok ? `send=err:${r.code ?? '-'}` : !r.res ? 'send=undefined'
  : `send=s${r.res.success},st${r.res.statusCode ?? '-'},b${r.res.bodyStatus ?? '-'},ck${r.res.checkCode ?? '-'},fs${r.res.flight ?? '-'},id${+(r.res.sid != null)}`) + `,${r.ms ?? '-'}ms`;
const head = (s) => `诊断api v1 api=sendMessageWithAuth ${s.diag ?? 'send=-'}`;

export const douyinDmApi = {
  platform: 'Douyin',
  op: 'sendDM',
  cap: 'writeDmViaApi',
  service: '页面自己的私信服务（IM SDK）',
  quietIds: true,
  caller: dmCaller,
  async precheck({ call, params }) {
    const t = params.target ?? {};
    if ([...norm(params.text)].length > DM_LIMITS.maxText) return { blocked: 'text-too-long', detail: `私信页编辑框最多 ${DM_LIMITS.maxText} 字` };
    const c = await call('conv', { conversationId: t.conversationId ?? null, peerUid: t.conversationId == null ? t.peerUid ?? null : null, uid: params.uid });
    if (!c.ok) {
      if (c.missing) return { blocked: 'cannot-send', detail: '页面自己的私信服务（IM SDK）不见了，没发' };
      if (c.notFound) return { blocked: 'target-not-found', detail: `私信列表里没有会话 ${t.conversationId ?? t.peerUid}（列表只显示最近的会话）` };
      return { blocked: 'precheck-error', detail: `找会话出错（${c.code ?? '-'}）` };
    }
    if (c.login?.owner !== 1) return { blocked: 'cannot-send', detail: `没能证实是本人登录（is_confer_login ${c.login?.owner === 0 ? '是 true，代运营登录' : '读不到'}），接口写法不发` };
    if (!c.login.uidMatch) return { blocked: 'uid-mismatch', detail: '私信页 userInfo 的 uid 不是要用的账号' };
    if (c.conv.group) return { blocked: 'cannot-send', detail: '群聊不发' };
    if (c.conv.last?.mine === true) return { blocked: 'last-is-me', detail: '会话最后一句是我说的' };
    const p = await call('pull', { conversationId: c.conv.id, limit: DM_LIMITS.pull });
    if (!p.ok) return p.missing ? { blocked: 'cannot-send', detail: '页面自己的私信服务（IM SDK）不见了，没发' } : { blocked: 'precheck-error', detail: `发前拉会话消息失败（${p.code ?? '-'}）` };
    // 拉到的要是最新一页：拉完时会话的最后一条（要有服务端 id）得在里面，否则确认不了最后一句是谁说的
    const last = p.conv?.last;
    if (!last?.sid || !p.msgs.some((m) => m.sid === last.sid)) return { blocked: 'precheck-error', detail: `发前拉到的 ${p.msgs.length} 条里没有会话的最后一条（或最后一条没有服务端 id），确认不了最后一句是谁说的，没发` };
    const top = p.msgs.filter((m) => m.idx != null).sort((a, b) => (big(a.idx) < big(b.idx) ? -1 : big(a.idx) > big(b.idx) ? 1 : 0)).at(-1);
    if (!top) return { blocked: 'precheck-error', detail: '发前拉到的消息都没有会话序号，没发' };
    if (last.mine === true || top.mine) return { blocked: 'last-is-me', detail: '拉到的最后一句是我说的' };
    return { state: { conversationId: c.conv.id, boundary: top.idx, diag: null } };
  },
  async send({ call, params }, s) {
    const r = await call('send', { conversationId: s.conversationId, text: params.text, uid: params.uid });
    s.diag = sendDiag(r);
    if (!r.ok && r.notSent) return { ok: false, notSent: true, detail: `${head(s)}，页面没调发送函数` };
    const x = r.ok ? r.res : null;
    const sid = x && x.success === 1 && (x.bodyStatus === null || x.bodyStatus === 0) ? idOf(x.sid) : null;
    if (sid != null) return { ok: true, nativeId: sid };
    return { ok: false, detail: head(s) };
  },
  async fresh({ call, params }, s) {
    const p = await call('pull', { conversationId: s.conversationId, limit: DM_LIMITS.pull });
    if (!p.ok) return { items: null, detail: `${head(s)} pull=err:${p.code ?? '-'}` };
    const b = big(s.boundary);
    const covered = p.msgs.some((m) => m.idx != null && big(m.idx) <= b);
    const newer = p.msgs.filter((m) => m.idx != null && big(m.idx) > b), mine = newer.filter((m) => m.mine);
    const eq = mine.filter((m) => m.text != null && norm(m.text) === norm(params.text));
    const detail = `${head(s)} pull=getMessagesByConversation n=${p.msgs.length}/${newer.length}/${mine.length}/${eq.length},cov${+covered},${p.ms ?? '-'}ms`;
    // 这一页没覆盖到发送前的边界：中间可能还有没拉到的新消息，确认不了「恰好 1 条」
    if (!covered) return { items: null, detail };
    // 我发的消息没有序号：分不清它在边界前还是后
    if (p.msgs.some((m) => m.mine && m.idx == null)) return { items: null, detail: `${detail},noidx` };
    return { items: [...new Set(eq.map((m) => m.sid ?? `idx:${m.idx}`))], detail };
  },
};
