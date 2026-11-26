// 预言机只看生成时的真实消息编号；SDK 两路都拿不到这个编号。
// 正文中的标签只供测试从 webhook payload 辨认消息，不传给身份字段。
export function generateDmHistory(seed, epoch) {
  let state = seed;
  function pick(n) {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return Math.floor(state / 2 ** 32 * n);
  }
  const histories = [[], [], []];
  const timeline = [];
  function send(thread, number, mine) {
    histories[thread].push({ thread, number, mine, ms: epoch + number * 250 + pick(240) });
  }
  function view(msg) {
    if (!msg) return null;
    return { ...msg, ids: pick(4), index: !!pick(2), seconds: !!pick(2) };
  }
  send(0, -2, false);
  send(1, -1, true);
  // 先观察已有会话，每个后续样本再随机选择可见性和延迟。
  const first = histories.map((h) => h.at(-1));
  timeline.push(first);
  const rounds = [{ dom: [view(first[0])], context: first.filter(Boolean).map(view), via: 'api', crash: 0 }];
  for (let n = 1; n <= 10; n++) {
    const thread = pick(histories.length);
    if (pick(5) === 0 && histories[thread].length > 1) histories[thread].pop();
    else send(thread, n, pick(3) === 0);
    timeline.push(histories.map((h) => h.at(-1)));
    const sample = () => timeline[n - pick(Math.min(4, n + 1))];
    const dom = sample().map(view).filter((m) => m && pick(3));
    const context = sample().map(view).filter((m) => m && pick(5));
    rounds.push({ dom, context, via: ['api', 'api', 'dom', 'fallback'][pick(4)], crash: pick(8) });
  }
  return rounds;
}

export function modelItem(m) {
  return { id: 'thread-' + m.thread, isStrangerChat: !!m.thread, lastMessage: {
    serverId: m.zero ? '0' : m.ids & 1 ? 'S' + m.number : null, clientMessageId: m.ids & 2 ? 'C' + m.number : null,
    indexInConversation: m.index ? String(m.number + 10) : null,
    createdAt: m.seconds ? m.ms / 1000 : m.ms, isFromMe: m.mine,
    type: 7, content: JSON.stringify({ text: m.text ?? String(m.number) }),
  } };
}

export function expectedDms(rounds) {
  const delivered = new Set();
  for (const r of rounds.slice(1)) {
    const reads = r.via === 'api' && r.context.length ? [...r.dom, ...r.context] : r.dom;
    for (const m of reads) if (m.number > 0 && !m.mine) delivered.add(String(m.number));
  }
  return [...delivered].sort();
}

// 每个剧本的 number 是预言机的私有标识。用重复正文、身份补齐和不同精度重放同一消息。
export function identityHistory(kind, seed, epoch) {
  const ms = epoch + 1000 * (seed % 31);
  const fraction = 1 + seed * 137 % 999;
  const peer = (number, time, ids, index, text) => ({ thread: 0, mine: false, number, ms: time, ids, index, text });
  const row = (dom, ctx = dom, extra = {}) => ({ dom: [dom], context: [ctx], via: 'api', crash: seed % 4, ...extra });
  const earlier = { ...peer(-9, ms - 2000, 1, true, 'mine'), mine: true };
  const offscreen = { ...earlier, thread: 1 };
  if (kind === 'upgrade') {
    const a = { ...peer(-1, ms + fraction, 0, true, 'old'), seconds: true, zero: seed % 2 === 0 };
    const b = peer(1, ms, 1, true, 'fresh');
    const corrected = { ...a, ids: 1, zero: false };
    if (!a.zero) {
      const newer = { ...earlier, ms: ms + 2000 };
      return [row(a, a, { legacy: true }), row(b), row(earlier), row(b), row(newer), row(a), row(corrected)];
    }
    return [row(a, a, { legacy: true }), row(b), row(corrected), row(earlier), row(b), row(b)];
  }
  if (kind === 'alias') {
    const coarse = peer(1, ms, 1, false, 'same');
    const fine = { ...coarse, ms: ms + fraction, ids: 2 };
    const bridge = { ...fine, ids: 3 };
    return [row(earlier), row(coarse), row(coarse, fine), row(offscreen, fine), row(offscreen, bridge), row(coarse, fine)];
  }
  const a = peer(-1, ms, 0, false, 'same');
  const b = peer(1, ms, 1, true, 'same');
  const identifiedA = { ...a, ids: 1, index: true };
  return [row(a), row(earlier), row(b), row(identifiedA), ...(seed % 2 ? [] : [row(b)]), row(offscreen, seed % 2 ? identifiedA : b)];
}
