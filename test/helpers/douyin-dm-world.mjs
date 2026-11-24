// 抖音私信页面内接口的假接口（dmInPage 的 conv / pull / send 返回形状）：会话 c1，消息按会话序号 idx 排，send 的结果可配。
export const peerMsg = (sid, idx, text = '在吗') => ({ sid, mine: false, text, idx: String(idx) });
export const myMsg = (sid, idx, text) => ({ sid, mine: true, text, idx: String(idx) });

/**
 * conv：{ missing, notFound, group, last }（last 覆盖会话摘要的最后一条）；login：覆盖 { owner, uidMatch }；
 * pull：'ok' | 'stale'（只拉到更旧的一条）| 'throw' | 'vanish'（服务没了）；pullAfter(msgs)：发送之后的拉取改成返回它；
 * send：'ok' | 'silent' | 'throw' | 'undefined' | 'rejected' | 'self-visible' | 'status-x' | 'notSent'
 */
export function dmWorld({ msgs = [peerMsg('101', 1)], send = 'ok', conv = {}, login = {}, pull = 'ok', pullAfter = null } = {}) {
  const w = { msgs: [...msgs], calls: [], sent: false };
  // 会话摘要的最后一条：序号最大的那条（同 SDK）
  const top = () => w.msgs.filter((m) => m.idx != null).reduce((a, m) => (!a || BigInt(m.idx) > BigInt(a.idx) ? m : a), null);
  const summary = () => { const l = top(); return { id: 'c1', group: false, stranger: false, last: l ? { sid: l.sid, idx: l.idx, mine: l.mine } : null, ...conv }; };
  w.call = async (method, args) => {
    w.calls.push([method, args]);
    if (method === 'conv') {
      if (conv.missing) return { ok: false, code: 'service-missing', missing: true, notSent: true };
      if (conv.notFound) return { ok: false, code: 'conv-not-found', notFound: true, notSent: true };
      return { ok: true, conv: summary(), login: { owner: 1, uidMatch: true, ...login } };
    }
    if (method === 'pull') {
      if (pull === 'throw') return { ok: false, code: 'pull:Error', ms: 4 };
      if (pull === 'vanish') return { ok: false, code: 'service-missing', missing: true, notSent: true };
      if (pull === 'stale') return { ok: true, conv: summary(), msgs: [peerMsg('100', 0)], total: 1, ms: 4 };
      const list = w.sent && pullAfter ? pullAfter(w.msgs) : w.msgs.slice(-20);
      return { ok: true, conv: summary(), msgs: list, total: list.length, ms: 4 };
    }
    if (method === 'send') {
      const sid = '900';
      // 新消息的序号是会话最后一条 + 1（同 SDK 的 lastMessageIndex + 1）
      const push = () => { w.msgs.push(myMsg(sid, String((top() ? BigInt(top().idx) : 0n) + 1n), args.text)); };
      if (send === 'last-changed') return { ok: false, code: 'last-changed', notSent: true };
      if (send === 'notSent') return { ok: false, code: 'service-missing', missing: true, notSent: true };
      w.sent = true;
      if (send === 'throw') return { ok: false, code: 'send:Error', ms: 3 };
      if (send === 'undefined') { push(); return { ok: true, ms: 3, res: null }; }
      if (send === 'rejected') return { ok: true, ms: 3, res: { success: 0, statusCode: 3, bodyStatus: 3, checkCode: 1, sid: null, flight: 4 } };
      if (send === 'self-visible') { push(); return { ok: true, ms: 3, res: { success: 0, statusCode: 4, bodyStatus: 4, checkCode: 0, sid: null, flight: 5 } }; }
      // 返回码类型不认识（例如 body.status 是 false），但 success、id 都在，回读也能找到
      if (send === 'status-null') { push(); return { ok: true, ms: 3, res: { success: 1, statusCode: 0, bodyStatus: 'x', checkCode: 0, sid, flight: 3 } }; }
      if (send === 'status-x') { push(); return { ok: true, ms: 3, res: { success: 1, statusCode: 0, bodyStatus: 'x', checkCode: 0, sid, flight: 3 } }; }
      if (send !== 'silent') push();
      return { ok: true, ms: 3, res: { success: 1, statusCode: 0, bodyStatus: 0, checkCode: 0, sid, flight: 3 } };
    }
    return { ok: false, code: 'bad-method', notSent: true };
  };
  w.count = (m) => w.calls.filter(([x]) => x === m).length;
  return w;
}
