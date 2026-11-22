// Colab：调本机 colab CLI（usage / sessions / stop）。stdin 关着跑：没授权时 CLI 会打授权网址、等人贴授权码，
// 读到 EOF 就退出，我们据此判 auth_required，不在服务里发起 OAuth，也不回显那个网址。
import { spawn } from 'node:child_process';

export const colabBin = () => process.env.MAITIAN_COLAB_BIN || '/Users/kinso/.local/bin/colab';
export const AUTH_HINT = '本机终端运行 colab usage 完成一次 Google 授权即可实时读取与一键停机';
export const SESSION_NAME = /^[\w.-]{1,64}$/;
const TIMEOUT_MS = 25_000;

export function runColab(args, { bin = colabBin(), timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    let p;
    try { p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { resolve({ code: null, out: '', err: e.code || e.message }); return; }
    const t = setTimeout(() => { if (!done) { p.kill('SIGKILL'); finish(null, 'timeout'); } }, timeoutMs);
    const finish = (code, extra = '') => { if (done) return; done = true; clearTimeout(t); resolve({ code, out, err: err + extra }); };
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => finish(null, e.code || e.message));
    p.on('close', (code) => finish(code));
  });
}

const needsAuth = (r) => /To authorize colab-cli|authorization code|EOF when reading a line/i.test(r.out + r.err);
const cleanErr = (r) => (r.err.includes('timeout') && r.code === null ? 'colab CLI 超时' : r.err.includes('ENOENT') ? '没找到 colab CLI' : `colab CLI 退出码 ${r.code}`);

/** `Current balance: 2497.39 compute units / Usage rate: 1.76/hr / Active assignments: 1` */
export function parseUsage(text) {
  const num = (re) => { const m = text.match(re); return m ? Number(m[1]) : null; };
  return { balance: num(/Current balance:\s*([\d.]+)/i), ratePerHour: num(/Usage rate:\s*([\d.]+)/i), assignments: num(/Active assignments:\s*(\d+)/i) };
}

/** `[name] endpoint | Hardware: T4 | Shape: Standard | Variant: GPU[ | Status: …]`，每行一个会话；name 是 ? 表示本机没有记录（只能去网页停）。 */
export function parseSessions(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\[([^\]]*)\]\s+(\S+)\s*\|(.*)$/);
    if (!m) continue;
    const kv = Object.fromEntries(m[3].split('|').map((s) => s.split(':').map((x) => x.trim())).filter((a) => a.length >= 2).map(([k, ...v]) => [k.toLowerCase(), v.join(':')]));
    const name = m[1].trim();
    rows.push({ id: name, endpoint: m[2], hardware: kv.hardware || '', shape: kv.shape || '', variant: kv.variant || '', stoppable: SESSION_NAME.test(name) });
  }
  return rows;
}

/** 读一次 Colab：{ status, metrics, sessions, error } */
export async function readColab(opts = {}) {
  const u = await runColab(['usage'], opts);
  if (needsAuth(u)) return { status: 'auth_required', error: AUTH_HINT };
  if (u.code !== 0) return { status: 'error', error: cleanErr(u) };
  const s = await runColab(['sessions'], opts);
  if (needsAuth(s)) return { status: 'auth_required', error: AUTH_HINT };
  if (s.code !== 0) return { status: 'error', metrics: parseUsage(u.out), error: cleanErr(s) };
  return { status: 'ok', metrics: parseUsage(u.out), sessions: parseSessions(s.out) };
}

export async function stopColab(id, opts = {}) {
  if (!SESSION_NAME.test(String(id || ''))) return { ok: false, error: '会话名不对' };
  const r = await runColab(['stop', '--session', id], opts);
  if (needsAuth(r)) return { ok: false, error: AUTH_HINT };
  if (r.code !== 0) return { ok: false, error: cleanErr(r) };
  if (/not found/i.test(r.out)) return { ok: false, error: `没有叫 ${id} 的会话` };
  return { ok: /terminated/i.test(r.out), error: /terminated/i.test(r.out) ? null : 'colab 没回「已停止」' };
}
