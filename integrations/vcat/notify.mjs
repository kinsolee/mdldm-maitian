// 飞书合批交互卡片：复用麦田现有 config.json 里的 feishuWebhook（不改 src/ops/login.mjs），
// 卡片含每张待处理卡的问题摘要、建议回法和「去处理」按钮（打开本机答题页 127.0.0.1:8794/cards）。
// 卡片被飞书拒收时退回调用 src/ops/login.mjs 的 defaultNotify。
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './config.mjs';

const TYPE_LABEL = { comment: '评论卡', dm: '私信卡', aggregate: '聚合卡' };
const escMd = (s) => String(s || '').replace(/[<>]/g, (ch) => ({ '<': '&lt;', '>': '&gt;' }[ch]));
const clip = (s, max = 140) => {
  const text = String(s || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/** 从麦田现有 config.json 只读读取 feishuWebhook，不写任何日志或打印 webhook 地址。 */
export function readFeishuWebhook(configPath = process.env.MAITIAN_CONFIG || path.join(REPO_ROOT, 'config.json')) {
  if (!fs.existsSync(configPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return typeof parsed.feishuWebhook === 'string' && parsed.feishuWebhook.trim() ? parsed.feishuWebhook.trim() : null;
  } catch {
    return null;
  }
}

/** 把一批待确认卡片排成一张飞书交互卡片，附「去处理」按钮打开本机答题页。 */
export function buildShadowBatchCard(cards, { cardsUrl = 'http://127.0.0.1:8794/cards', now = Date.now } = {}) {
  const ts = new Date(typeof now === 'function' ? now() : now)
    .toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Taipei' })
    .slice(5, 16);
  const elements = [];
  for (const card of cards) {
    const label = TYPE_LABEL[card.cardType] || card.cardType;
    const countTag = card.items?.length > 1 ? ` · ${card.items.length} 条同类` : '';
    const accountTag = card.account ? ` · ${escMd(card.account)}` : '';
    const parts = [
      `**#${card.id} [${label}]** ${escMd(card.platform)}${accountTag}${countTag}`,
      `问题：${escMd(clip(card.questionSummary, 160))}`,
      `建议回法：${card.suggestedReply ? escMd(clip(card.suggestedReply, 180)) : '（暂无建议，请到答题页填写或选不回）'}`,
    ];
    elements.push({ tag: 'markdown', content: parts.join('\n') });
    elements.push({ tag: 'hr' });
  }
  elements.push({
    tag: 'note',
    elements: [{ tag: 'plain_text', content: `小V猫影子版（仅观察，不发真实回复） · ${ts}` }],
  });
  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '去处理' },
        type: 'primary',
        url: cardsUrl,
      },
    ],
  });
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: `待确认问题 ${cards.length} 张（小V猫影子版）` },
    },
    elements,
  };
}

export function buildFallbackText(cards, { cardsUrl = 'http://127.0.0.1:8794/cards' } = {}) {
  const lines = [`👉 小V猫影子版待确认 ${cards.length} 张`];
  for (const card of cards) {
    const label = TYPE_LABEL[card.cardType] || card.cardType;
    lines.push(`#${card.id} [${label}/${card.platform}] 问题：${clip(card.questionSummary, 100)}`);
    if (card.suggestedReply) lines.push(`建议：${clip(card.suggestedReply, 120)}`);
  }
  lines.push(`去处理：${cardsUrl}`);
  return lines.join('\n');
}

const DEFINITE_CONNECT_ERRORS = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

async function postFeishu(webhook, body, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const code = err?.cause?.code || (typeof err?.code === 'string' ? err.code : '');
    if (code && DEFINITE_CONNECT_ERRORS.has(code)) {
      return { sent: false, uncertain: false, why: `连不上（${code}）` };
    }
    return {
      sent: false,
      uncertain: true,
      why: err?.name === 'TimeoutError' ? '超过 10 秒没响应（结果未知，已暂停自动重发）' : `回执中断（${code || err?.name || 'unknown'}，结果未知，已暂停自动重发）`,
    };
  }
  if (!res.ok) {
    const rejected = res.status >= 400 && res.status < 500 && res.status !== 408;
    return { sent: false, uncertain: !rejected, why: `HTTP ${res.status}` };
  }
  let json;
  try {
    const raw = await res.text();
    json = JSON.parse(raw);
  } catch {
    return { sent: false, uncertain: true, why: '飞书响应不是合法 JSON（结果未知，已暂停自动重发）' };
  }
  if (!json || typeof json !== 'object') {
    return { sent: false, uncertain: true, why: '飞书响应格式异常（结果未知，已暂停自动重发）' };
  }
  const code = json.code ?? json.StatusCode;
  if (code == null) {
    return { sent: false, uncertain: true, why: '飞书响应缺少状态码（结果未知，已暂停自动重发）' };
  }
  if (code !== 0) {
    return { sent: false, uncertain: false, rejected: true, why: `飞书返回 code=${code}` };
  }
  return { sent: true, uncertain: false };
}

/**
 * 把未推送的 pending 卡片合批发出一次飞书交互卡片。
 * 只有飞书确认发送成功（HTTP 2xx + 合法 JSON + code=0）才打上 notified_at；
 * 确定未送达释放认领锁允许重试；回执丢失/非 JSON 等未知结果 fail-closed 标记 uncertain，既不误记已发送也不自动重发同版本。
 */
export async function notifyPendingCards(store, opts = {}) {
  const {
    cardsUrl = 'http://127.0.0.1:8794/cards',
    webhook = null,
    maitianConfig,
    fetchImpl = fetch,
    fallbackNotify = null,
    now = Date.now,
    limit = 20,
    claimTtlMs = 60_000,
  } = opts;
  const { claimToken, cards } = store.claimUnnotifiedCards(limit, { claimTtlMs, now });
  if (cards.length === 0) return { sent: false, count: 0, cardIds: [], reason: 'no_unnotified_cards' };

  const targetWebhook = webhook || readFeishuWebhook(maitianConfig);
  if (!targetWebhook) {
    store.releaseNotifyClaim(claimToken);
    return { sent: false, count: cards.length, cardIds: cards.map((c) => c.id), reason: 'missing_webhook' };
  }

  const claimedVersions = cards.map((c) => ({ id: c.id, notifyVersion: c.notifyVersion }));
  const dispatchedSet = new Set(store.markNotifyDispatched(claimToken, claimedVersions, { now }));
  const activeCards = cards.filter((c) => dispatchedSet.has(c.id));
  if (activeCards.length === 0) {
    return { sent: false, count: 0, cardIds: [], reason: 'no_unnotified_cards' };
  }
  const versions = activeCards.map((c) => ({ id: c.id, notifyVersion: c.notifyVersion }));

  const cardPayload = buildShadowBatchCard(activeCards, { cardsUrl, now });
  let outcome = await postFeishu(targetWebhook, { msg_type: 'interactive', card: cardPayload }, fetchImpl);
  if (outcome.rejected) {
    const fallbackText = buildFallbackText(activeCards, { cardsUrl });
    if (typeof fallbackNotify === 'function') {
      try {
        const res = await fallbackNotify(fallbackText);
        if (res === true || (res && typeof res === 'object' && res.sent === true)) {
          outcome = { sent: true, uncertain: false, why: 'fallback_custom' };
        } else if (res && typeof res === 'object' && res.uncertain === true) {
          outcome = { sent: false, uncertain: true, why: res.why || 'fallback_uncertain' };
        } else {
          outcome = { sent: false, uncertain: false, why: (res && res.why) || outcome.why };
        }
      } catch {
        outcome = { sent: false, uncertain: true, why: 'fallback_uncertain' };
      }
    } else {
      // 默认文本降级复用同一飞书 webhook，仍走严格 JSON + code===0 校验，绝不把非 JSON 200 误记成功
      outcome = await postFeishu(targetWebhook, { msg_type: 'text', content: { text: fallbackText } }, fetchImpl);
    }
  }

  if (outcome.sent) {
    const confirmed = store.confirmCardsNotified(claimToken, versions, { now });
    return { sent: true, count: activeCards.length, confirmed, cardIds: activeCards.map((c) => c.id) };
  }
  if (outcome.uncertain) {
    const uncertainCount = store.markNotifyUncertain(claimToken, versions, { now });
    return {
      sent: false,
      uncertain: true,
      uncertainCount,
      count: activeCards.length,
      cardIds: activeCards.map((c) => c.id),
      reason: outcome.why || 'send_uncertain',
    };
  }
  store.releaseNotifyClaim(claimToken, versions);
  return { sent: false, uncertain: false, count: activeCards.length, cardIds: activeCards.map((c) => c.id), reason: outcome.why || 'send_failed' };
}
