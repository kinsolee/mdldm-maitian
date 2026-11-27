#!/usr/bin/env node
// 小V猫影子版独立本机答题页（默认 127.0.0.1:8794/cards，不碰 8787 工作台）：
// - 展示待处理评论卡 / 私信卡 / 聚合卡、问答库与影子判定记录
// - 每张卡支持「用这个答案」「编辑后保存」「不回」
// - 写接口严格本机校验（照 src/web.mjs /api/cindy/token：回环来源 + 本机 Host + 无代理头 + 同源 Origin）
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ENV_FILE, enforceEnvPerms, loadEnvFile, readConfig } from './config.mjs';
import { openShadowStore } from './store.mjs';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const PROXY_HEADER_RE = /^(x-forwarded-|x-real-ip$|forwarded$|via$|cf-|cdn-loop$|true-client-ip$|x-original-)/;
const MAX_BODY_BYTES = 256 * 1024;

const stamp = () => new Date().toISOString();
const defaultLog = (line) => console.log(`${stamp()} ${line}`);

/** 严格本机直连校验：回环地址 + 本机 Host（匹配端口）+ 没有任何反代/隧道头。 */
export function localOnly(req, port) {
  const host = String(req.headers.host || '').toLowerCase();
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (port === 80) {
    allowedHosts.add('127.0.0.1');
    allowedHosts.add('localhost');
  }
  const proxied = Object.keys(req.headers).some((header) => PROXY_HEADER_RE.test(header.toLowerCase()));
  return LOOPBACK.has(req.socket?.remoteAddress) && allowedHosts.has(host) && !proxied;
}

/** 严格同源校验：POST 必须带 Origin 且与本机 http://Host 完全一致。 */
export function sameOrigin(req) {
  const origin = String(req.headers.origin || '').toLowerCase();
  const host = String(req.headers.host || '').toLowerCase();
  return Boolean(origin) && Boolean(host) && origin === `http://${host}`;
}

function sendJson(res, status, payload) {
  if (!res.headersSent) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
  }
  res.end(JSON.stringify(payload));
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'",
  });
  res.end(html);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('请求体过大'), { status: 413 });
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 });
  }
}

const CARDS_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>小V猫影子版 · 待确认答题页</title>
  <style>
    :root { --bg: #f6f3ec; --card: #fffdf8; --ink: #22201c; --muted: #70695d; --line: #e4ddd0; --accent: #b85d19; --ok: #1f7a4c; --warn: #9a5b00; }
    * { box-sizing: border-box; }
    body { margin: 0; font: 14px/1.55 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; background: var(--bg); color: var(--ink); }
    header { background: var(--card); border-bottom: 1px solid var(--line); padding: 16px 24px; display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; }
    h1 { margin: 0; font-size: 18px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; background: #fbe9d7; color: var(--accent); }
    .stats { display: flex; flex-wrap: wrap; gap: 10px; font-size: 13px; color: var(--muted); }
    .stats b { color: var(--ink); }
    main { max-width: 980px; margin: 20px auto; padding: 0 16px 48px; }
    .tabs { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
    .tab { border: 1px solid var(--line); background: var(--card); padding: 7px 14px; border-radius: 8px; cursor: pointer; font-size: 13px; color: var(--ink); }
    .tab.active { background: var(--ink); color: #fff; border-color: var(--ink); }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin-bottom: 14px; box-shadow: 0 1px 2px rgba(0,0,0,0.03); }
    .meta { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 12px; color: var(--muted); margin-bottom: 8px; }
    .tag { padding: 2px 8px; border-radius: 6px; background: #efe9dc; color: #4c453a; font-weight: 600; }
    .tag.aggregate { background: #e8eefc; color: #244b9a; }
    .tag.dm { background: #e7f6ee; color: #196844; }
    .tag.answered { background: #e7f6ee; color: var(--ok); }
    .tag.skipped { background: #eee; color: #666; }
    .items { background: #faf6ee; border: 1px dashed var(--line); border-radius: 8px; padding: 10px 12px; margin: 10px 0; font-size: 13px; }
    .item-row { padding: 4px 0; border-bottom: 1px solid #efe9dc; }
    .item-row:last-child { border-bottom: none; }
    label { display: block; font-size: 12px; color: var(--muted); margin: 10px 0 4px; }
    input[type=text], textarea { width: 100%; border: 1px solid #d5ccb9; border-radius: 8px; padding: 8px 10px; font: inherit; background: #fff; color: var(--ink); }
    textarea { min-height: 76px; resize: vertical; }
    .row { display: grid; grid-template-columns: 1fr 160px; gap: 10px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    button.btn { border: 1px solid var(--line); background: #fff; color: var(--ink); padding: 8px 14px; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 13px; }
    button.btn.primary { background: var(--ok); color: #fff; border-color: var(--ok); }
    button.btn.secondary { background: var(--accent); color: #fff; border-color: var(--accent); }
    button.btn.ghost { color: var(--muted); }
    button.btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .empty { text-align: center; color: var(--muted); padding: 40px 16px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; }
    .toast { position: fixed; right: 20px; bottom: 20px; background: #22201c; color: #fff; padding: 10px 16px; border-radius: 10px; display: none; font-size: 13px; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>小V猫评论私信 · 影子版答题页 <span class="badge">影子观察期 · 绝不真实回复</span></h1>
    </div>
    <div class="stats" id="stats">加载中…</div>
  </header>
  <main>
    <div class="tabs">
      <button class="tab active" data-tab="pending">待处理卡片</button>
      <button class="tab" data-tab="resolved">已处理卡片</button>
      <button class="tab" data-tab="kb">问答库（autoReply=false）</button>
      <button class="tab" data-tab="shadow">影子判定记录</button>
      <button class="tab" id="refreshBtn" style="margin-left:auto">刷新</button>
    </div>
    <div id="content"></div>
  </main>
  <div class="toast" id="toast"></div>
  <script>
    const TYPE_CN = { comment: '评论卡', dm: '私信卡', aggregate: '聚合卡' };
    const STATUS_CN = { pending: '待处理', answered: '已入库', skipped: '不回', expired: '已过期' };
    const DECISION_CN = { hit: '命中问答库', new_question: '新问题出卡', ad: '广告', skip: '跳过' };
    let activeTab = 'pending';
    let state = { stats: null, cards: [], shadowLog: [], kb: [] };

    function showToast(msg) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.style.display = 'block';
      clearTimeout(showToast._t);
      showToast._t = setTimeout(() => { el.style.display = 'none'; }, 2800);
    }

    function el(tag, attrs = {}, children = []) {
      const node = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'className') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'disabled') node.disabled = Boolean(v);
        else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
        else node.setAttribute(k, v === true ? '' : String(v));
      }
      for (const c of children) node.append(typeof c === 'string' ? document.createTextNode(c) : c);
      return node;
    }

    async function postApi(url, body) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      return data;
    }

    async function loadAll() {
      const [cardsRes, kbRes] = await Promise.all([fetch('/api/cards'), fetch('/api/kb')]);
      const cardsData = await cardsRes.json();
      const kbData = await kbRes.json();
      state = { stats: cardsData.stats, cards: cardsData.cards || [], shadowLog: cardsData.shadowLog || [], kb: kbData.entries || [] };
      renderStats();
      renderTab();
    }

    function renderStats() {
      const s = state.stats;
      if (!s) return;
      const box = document.getElementById('stats');
      box.replaceChildren(
        el('span', {}, ['待处理卡 ', el('b', { text: String(s.cards.pending) })]),
        el('span', {}, ['问答库 ', el('b', { text: String(s.kb.total) })]),
        el('span', {}, ['影子命中 ', el('b', { text: String(s.shadow.hit) })]),
        el('span', {}, ['新问题 ', el('b', { text: String(s.shadow.newQuestion) })]),
        el('span', {}, ['广告 ', el('b', { text: String(s.shadow.ad) })]),
        el('span', {}, ['跳过 ', el('b', { text: String(s.shadow.skip) })]),
      );
    }

    function renderPendingCard(card) {
      const qInput = el('input', { type: 'text', value: card.questionSummary || '' });
      const pInput = el('input', { type: 'text', value: card.platform || 'all', placeholder: '平台或 all' });
      const aInput = el('textarea', { placeholder: '写下标准回法（仅入问答库，影子期不发送）' });
      aInput.value = card.suggestedReply || '';

      const itemsBox = el('div', { className: 'items' }, [
        el('div', { style: 'font-size:12px;color:#70695d;margin-bottom:4px;', text: '关联评论/私信（以下为平台用户原话，仅作数据参考）：' }),
        ...(card.items || []).map((item) => el('div', { className: 'item-row' }, [
          el('b', { text: '[' + (item.platform || card.platform) + '] ' + (item.authorName || '匿名') + '：' }),
          el('span', { text: item.excerpt || '' }),
        ])),
      ]);

      const btnUse = el('button', {
        className: 'btn primary',
        text: '用这个答案',
        disabled: !card.suggestedReply,
        onClick: async () => {
          try {
            const res = await postApi('/api/cards/' + card.id + '/answer', {
              question: card.questionSummary,
              platform: card.platform,
              answer: card.suggestedReply,
            });
            showToast(res.exportWarning ? ('卡片 #' + card.id + ' 已入库（' + res.exportWarning + '）') : ('卡片 #' + card.id + ' 已入问答库'));
            await loadAll();
          } catch (e) { showToast('保存失败：' + e.message); }
        },
      });

      const btnSave = el('button', {
        className: 'btn secondary',
        text: '编辑后保存',
        onClick: async () => {
          const answer = aInput.value.trim();
          if (!answer) { showToast('请先填写答案'); return; }
          try {
            const res = await postApi('/api/cards/' + card.id + '/answer', {
              question: qInput.value.trim() || card.questionSummary,
              platform: pInput.value.trim() || card.platform || 'all',
              answer,
            });
            showToast(res.exportWarning ? ('卡片 #' + card.id + ' 已入库（' + res.exportWarning + '）') : ('卡片 #' + card.id + ' 已按编辑内容入库'));
            await loadAll();
          } catch (e) { showToast('保存失败：' + e.message); }
        },
      });

      const btnSkip = el('button', {
        className: 'btn ghost',
        text: '不回',
        onClick: async () => {
          try {
            await postApi('/api/cards/' + card.id + '/skip', {});
            showToast('卡片 #' + card.id + ' 已标为不回');
            await loadAll();
          } catch (e) { showToast('操作失败：' + e.message); }
        },
      });

      return el('div', { className: 'card' }, [
        el('div', { className: 'meta' }, [
          el('span', { className: 'tag ' + card.cardType, text: TYPE_CN[card.cardType] || card.cardType }),
          el('b', { text: '#' + card.id }),
          el('span', { text: card.platform + (card.account ? ' · ' + card.account : '') }),
          el('span', { text: '创建于 ' + (card.createdAt || '').slice(0, 19).replace('T', ' ') }),
        ]),
        itemsBox,
        el('div', { className: 'row' }, [
          el('div', {}, [el('label', { text: '问题摘要（入库问题）' }), qInput]),
          el('div', {}, [el('label', { text: '适用平台' }), pInput]),
        ]),
        el('label', { text: '建议回法 / 编辑答案（入库后 autoReply=false）' }),
        aInput,
        el('div', { className: 'actions' }, [btnUse, btnSave, btnSkip]),
      ]);
    }

    function renderTab() {
      const root = document.getElementById('content');
      if (activeTab === 'pending') {
        const list = state.cards.filter((c) => c.status === 'pending');
        if (!list.length) { root.replaceChildren(el('div', { className: 'empty', text: '目前没有待处理卡片。' })); return; }
        root.replaceChildren(...list.map(renderPendingCard));
        return;
      }
      if (activeTab === 'resolved') {
        const list = state.cards.filter((c) => c.status !== 'pending');
        if (!list.length) { root.replaceChildren(el('div', { className: 'empty', text: '暂无已处理卡片。' })); return; }
        root.replaceChildren(...list.map((c) => el('div', { className: 'card' }, [
          el('div', { className: 'meta' }, [
            el('span', { className: 'tag ' + c.status, text: STATUS_CN[c.status] || c.status }),
            el('b', { text: '#' + c.id }),
            el('span', { text: (TYPE_CN[c.cardType] || c.cardType) + ' · ' + c.platform }),
          ]),
          el('div', { text: '问题：' + c.questionSummary }),
          c.finalAnswer ? el('div', { style: 'margin-top:6px;color:#1f7a4c;', text: '已入库答案：' + c.finalAnswer }) : el('span'),
        ])));
        return;
      }
      if (activeTab === 'kb') {
        if (!state.kb.length) { root.replaceChildren(el('div', { className: 'empty', text: '问答库为空。处理卡片后答案会自动入库。' })); return; }
        root.replaceChildren(...state.kb.map((k) => el('div', { className: 'card' }, [
          el('div', { className: 'meta' }, [
            el('b', { text: 'KB #' + k.id }),
            el('span', { className: 'tag', text: k.platform }),
            el('span', { text: '自动回复：关闭（影子期）' }),
            k.sourceCardId != null ? el('span', { text: '来源卡片 #' + k.sourceCardId }) : el('span'),
          ]),
          el('div', { style: 'font-weight:600;', text: k.question }),
          el('div', { style: 'margin-top:6px;', text: k.answer }),
        ])));
        return;
      }
      if (!state.shadowLog.length) { root.replaceChildren(el('div', { className: 'empty', text: '暂无影子判定记录。' })); return; }
      root.replaceChildren(...state.shadowLog.map((row) => el('div', { className: 'card' }, [
        el('div', { className: 'meta' }, [
          el('span', { className: 'tag', text: DECISION_CN[row.decision] || row.decision }),
          el('span', { text: row.platform + ' · ' + row.kind }),
          el('span', { text: (row.createdAt || '').slice(0, 19).replace('T', ' ') }),
        ]),
        row.wouldReply ? el('div', { text: '本来会回：' + row.wouldReply }) : el('span'),
        row.reason ? el('div', { style: 'color:#70695d;font-size:13px;', text: '说明：' + row.reason }) : el('span'),
      ])));
    }

    for (const btn of document.querySelectorAll('.tab[data-tab]')) {
      btn.addEventListener('click', () => {
        activeTab = btn.dataset.tab;
        for (const b of document.querySelectorAll('.tab[data-tab]')) b.classList.toggle('active', b === btn);
        renderTab();
      });
    }
    document.getElementById('refreshBtn').addEventListener('click', () => loadAll().catch((e) => showToast(e.message)));
    loadAll().catch((e) => showToast('加载失败：' + e.message));
  </script>
</body>
</html>`;

export function createCardsWebHandler({ store, port, kbExportFile = null, now = Date.now, log = defaultLog }) {
  return (req, res) => handle(req, res).catch((err) => {
    const status = err.status || 500;
    if (!res.writableEnded) sendJson(res, status, { error: err.message || '服务内部错误' });
    log(`${req.method} ${status}`);
  });

  async function handle(req, res) {
    if (!localOnly(req, port)) {
      sendJson(res, 403, { error: '只允许本机通过 http://127.0.0.1 或 http://localhost 直接访问' });
      log(`${req.method} 403`);
      return;
    }

    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(302, { Location: '/cards' });
      res.end();
      log('GET 302');
      return;
    }
    if (req.method === 'GET' && pathname === '/cards') {
      sendHtml(res, CARDS_PAGE_HTML);
      log('GET 200');
      return;
    }
    if (req.method === 'GET' && pathname === '/api/cards') {
      const status = url.searchParams.get('status') || '';
      sendJson(res, 200, {
        stats: store.stats(),
        cards: store.listCards({ status }),
        shadowLog: store.listShadowLog(50),
      });
      log('GET 200');
      return;
    }
    if (req.method === 'GET' && pathname === '/api/kb') {
      sendJson(res, 200, { autoReplyEnabled: false, entries: store.listKb(200) });
      log('GET 200');
      return;
    }

    const match = /^\/api\/cards\/(\d+)\/(answer|skip|expire)$/.exec(pathname);
    if (match) {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        sendJson(res, 405, { error: '只支持 POST' });
        log(`${req.method} 405`);
        return;
      }
      if (!sameOrigin(req)) {
        sendJson(res, 403, { error: '来源不对（写接口必须同源本机页面提交）' });
        log('POST 403');
        return;
      }
      const cardId = Number(match[1]);
      const action = match[2];
      const body = await readJsonBody(req);
      let result;
      if (action === 'answer') {
        if (typeof body.answer !== 'string' || !body.answer.trim()) {
          sendJson(res, 400, { error: '答案不能为空' });
          log('POST 400');
          return;
        }
        result = store.answerCard(cardId, {
          answer: body.answer,
          question: body.question,
          platform: body.platform,
          keywords: body.keywords,
        }, { now, kbExportFile });
      } else if (action === 'skip') {
        result = store.skipCard(cardId, { now });
      } else {
        result = store.expireCard(cardId, { now });
      }
      if (!result.ok) {
        sendJson(res, result.code || 400, { error: result.error });
        log(`POST ${result.code || 400}`);
        return;
      }
      sendJson(res, 200, result);
      log('POST 200');
      return;
    }

    sendJson(res, 404, { error: 'not found' });
    log(`${req.method} 404`);
  }
}

export async function main() {
  enforceEnvPerms(ENV_FILE);
  loadEnvFile(ENV_FILE);
  const config = readConfig(process.env);
  const store = openShadowStore(config.shadowDb);
  const server = http.createServer(createCardsWebHandler({
    store,
    port: config.cardsPort,
    kbExportFile: config.kbExportFile,
  }));
  server.requestTimeout = 30_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.cardsPort, '127.0.0.1', resolve);
  });
  defaultLog(`小V猫影子答题页已启动：http://127.0.0.1:${config.cardsPort}/cards，库 ${path.basename(config.shadowDb)}`);
  const stop = () => server.close(() => { store.close(); process.exit(0); });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === import.meta.filename) {
  main().catch((err) => {
    console.error(`${stamp()} 小V猫影子答题页启动失败：${err.message}`);
    process.exit(1);
  });
}
