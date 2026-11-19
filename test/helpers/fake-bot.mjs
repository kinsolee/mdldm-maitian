// 本地假 bot：验签、记录收到的批次、按 mode 返回（ok → 200，fail → 500，hang → 不回直到关掉）。
// 验签不过返回 401。onBatch(body) 可以在收到后做事（例如调 ackEvent 回执）。
import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

export const sign = (secret, raw) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

export function verify(secret, raw, header) {
  const want = Buffer.from(sign(secret, raw));
  const got = Buffer.from(String(header ?? ''));
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function startFakeBot({ secret = null, mode = 'ok', onBatch = null } = {}) {
  const bot = { secret, mode, onBatch, received: [], rejected: 0 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!bot.secret || !verify(bot.secret, raw, req.headers['x-maitian-signature'])) { bot.rejected++; res.writeHead(401).end(); return; }
      const body = JSON.parse(raw);
      bot.received.push({ headers: req.headers, raw, body });
      if (bot.mode === 'hang') return;
      if (bot.mode === 'fail') { res.writeHead(500).end(); return; }
      bot.onBatch?.(body);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  bot.url = `http://127.0.0.1:${server.address().port}/hook?token=should-not-leak`;
  bot.close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return bot;
}
