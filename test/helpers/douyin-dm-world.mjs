// 抖音私信页面内接口的假接口（dmInPage 的 conv / pull / send 返回形状）：会话 c1，消息按 idx 排，send 的结果可配。
export const peerMsg = (sid, idx, text = '在吗') => ({ key: sid, sid, mine: false, text, idx: String(idx), type: 7 });
export const myMsg = (sid, idx, text) => ({ key: sid, sid, mine: true, text, idx: String(idx), type: 7 });

export function dmWorld({ msgs = [peerMsg('s1', 1)], send = 'ok', conv = {}, pull = 'ok' } = {}) {
  const w = { msgs: [...msgs], calls: [] };
  const last = () => w.msgs.at(-1);
  w.call = async (method, args) => {
    w.calls.push([method, args]);
    if (method === 'conv') {
      if (conv.missing) return { ok: false, notFound: true, error: '会话列表里没有这个会话' };
      const l = last();
      return { ok: true, conv: { id: 'c1', group: false, stranger: false, last: l ? { sid: l.sid, type: 7, mine: l.mine } : null, ...conv } };
    }
    if (method === 'pull') {
      if (pull === 'throw') return { ok: false, error: 'getMessagesByConversation 出错：网络' };
      if (pull === 'stale') return { ok: true, msgs: [peerMsg('s0', 0)], total: 1, ms: 4 };
      return { ok: true, msgs: w.msgs.slice(-20), total: w.msgs.length, ms: 4 };
    }
    if (method === 'send') {
      const sid = 's-new';
      const push = () => w.msgs.push(myMsg(sid, w.msgs.length + 1, args.text));
      if (send === 'throw') return { ok: false, stage: 'send', error: 'sendMessageWithAuth 出错：请求失败', ms: 3 };
      if (send === 'undefined') { push(); return { ok: true, ms: 3, res: null }; }
      if (send === 'rejected') return { ok: true, ms: 3, res: { success: false, statusCode: 3, bodyStatus: 3, checkCode: 1, sid: null, flight: 4 } };
      if (send === 'self-visible') { push(); return { ok: true, ms: 3, res: { success: false, statusCode: 4, bodyStatus: 4, checkCode: 0, sid: null, flight: 5 } }; }
      if (send !== 'silent') push();
      return { ok: true, ms: 3, res: { success: true, statusCode: 0, bodyStatus: 0, checkCode: 0, sid, flight: 3 } };
    }
    return { ok: false, error: `没有 ${method}` };
  };
  w.count = (m) => w.calls.filter(([x]) => x === m).length;
  return w;
}

