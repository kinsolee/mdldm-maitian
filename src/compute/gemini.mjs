// GCP / Gemini API：只在配了密钥时探活（列模型，不调生成、不花钱）。密钥只放请求头，不进 URL、日志、错误信息和快照。
import fs from 'node:fs';
import { envPath } from '../ops/paths.mjs';

export const GEMINI_HINT = '还没配 Gemini 密钥：等 1Password 的 Google-Gemini-API 条目存入，再在麦田 .env 里填 GEMINI_API_KEY';
const BASE = () => process.env.MAITIAN_GEMINI_BASE || 'https://generativelanguage.googleapis.com';

export function geminiKey({ env = process.env, file = envPath() } = {}) {
  if (env.GEMINI_API_KEY) return env.GEMINI_API_KEY;
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*(.*?)\s*$/);
      if (m && m[1]) return m[1].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {}
  return '';
}

export async function readGemini({ key = geminiKey(), timeoutMs = 10_000 } = {}) {
  if (!key) return { status: 'unconfigured', error: GEMINI_HINT };
  try {
    const r = await fetch(`${BASE()}/v1beta/models?pageSize=1000`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(timeoutMs) });
    if (r.status === 400 || r.status === 401 || r.status === 403) return { status: 'error', error: `密钥被拒（HTTP ${r.status}）` };
    if (!r.ok) return { status: 'error', error: `探活失败（HTTP ${r.status}）` };
    const j = await r.json().catch(() => ({}));
    const models = Array.isArray(j.models) ? j.models.map((m) => String(m.name || '').replace(/^models\//, '')) : [];
    return { status: 'ok', metrics: { reachable: true, models: models.length, sample: models.filter((n) => /gemini/i.test(n)).slice(0, 6) } };
  } catch (e) {
    return { status: 'error', error: e.name === 'TimeoutError' ? '探活超时' : '连不上 Gemini API' };
  }
}
