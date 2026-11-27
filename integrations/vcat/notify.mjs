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
    return { sent: false, why: err.name === 'TimeoutError' ? '超过 10 秒没响应' : `连不上（${err.cause?.code ?? err.name}）` };
  }
  if (!res.ok) return { sent: false, why: `HTTP ${res.status}` };
  let json;
  try {
    const raw = await res.text();
    json = JSON.parse(raw);
  } catch {
    return { sent: false, why: '飞书响应不是合法 JSON' };
  }
  if (!json || typeof json !== 'object') {
    return { sent: false, why: '飞书响应格式异常' };
  }
  const code = json.code ?? json.StatusCode;
  if (code !== 0) {
    return { sent: false, rejected: code != null, why: `飞书返回 code=${code ?? 'missing'}` };
  }
  return { sent: true };
}

async function lazyDefaultNotify(text) {
  const mod = await import('../../src/ops/login.mjs');
  return mod.defaultNotify(text);
}

/**
 * 把未推送的 pending 卡片合批发出一次飞书交互卡片。
 * 只有飞书确认发送成功才给卡片打上 notified_at；没配 webhook 或发送失败不丢卡片。
 */
export async function notifyPendingCards(store, opts = {}) {
  const {
    cardsUrl = 'http://127.0.0.1:8794/cards',
    webhook = null,
    maitianConfig,
    fetchImpl = fetch,
    fallbackNotify = lazyDefaultNotify,
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

  const cardPayload = buildShadowBatchCard(cards, { cardsUrl, now });
  let outcome = await postFeishu(targetWebhook, { msg_type: 'interactive', card: cardPayload }, fetchImpl);
  if (outcome.rejected) {
    try {
      const fallbackOk = await fallbackNotify(buildFallbackText(cards, { cardsUrl }));
      outcome = { sent: Boolean(fallbackOk), why: fallbackOk ? 'fallback_defaultNotify' : outcome.why };
    } catch {
      outcome = { sent: false, why: 'fallback_failed' };
    }
  }

  if (outcome.sent) {
    const versions = cards.map((c) => ({ id: c.id, notifyVersion: c.notifyVersion }));
    const confirmed = store.confirmCardsNotified(claimToken, versions, { now });
    return { sent: true, count: cards.length, confirmed, cardIds: cards.map((c) => c.id) };
  }
  store.releaseNotifyClaim(claimToken);
  return { sent: false, count: cards.length, cardIds: cards.map((c) => c.id), reason: outcome.why || 'send_failed' };
}
