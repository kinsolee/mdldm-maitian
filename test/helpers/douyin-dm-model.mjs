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
    serverId: m.ids & 1 ? 'S' + m.number : null, clientMessageId: m.ids & 2 ? 'C' + m.number : null,
    indexInConversation: m.index ? String(m.number + 10) : null,
    createdAt: m.seconds ? m.ms / 1000 : m.ms, isFromMe: m.mine,
    type: 7, content: JSON.stringify({ text: String(m.number) }),
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
