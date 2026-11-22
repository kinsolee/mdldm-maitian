// 谷歌算力面板的服务层：秒回最新快照、Colab 实时态 15 秒防抖、单飞刷新、一键停机后回读。
// 不建定时器：定时巡检由 OpenBot routine 调 `node src/hub.mjs compute refresh --scope all`。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStudio, PROVIDERS, studioDbPath } from './store.mjs';
import { readColab, stopColab } from './colab.mjs';
import { readGemini } from './gemini.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const EGO_SPACE = 'kinso/google-compute/ultra';
export const EGO_PROVIDERS = Object.freeze(['flow', 'flowmusic', 'kaggle', 'pics', 'vids']);
export const COLAB_DEBOUNCE_MS = 15_000;
const EGO_TIMEOUT_MS = 240_000;

const EGO_REASON = {
  busy: ['busy', '采集 space 正被另一个任务占用'],
  'user-controlled': ['user_controlled', '采集 space 正由你手动操作，没打扰'],
  timeout: ['timeout', '网页采集超时'],
  'profile-needed': ['error', 'Ego 里没有 Profile 5'],
  'profile-rejected': ['error', 'profile 不在白名单'],
  'profile-mismatch': ['error', 'space 不在 Profile 5 下'],
  'spawn-failed': ['error', 'Ego 没起来'],
};

/** 跑一次 ego-runner：返回 { ok, result } 或 { ok:false, status, error }。 */
export function runEgo({ cli = process.env.MAITIAN_COMPUTE_EGO_CLI || path.join(DIR, '..', 'ego-runner', 'cli.mjs'), script = path.join(DIR, 'ego-collect.js'), timeoutMs = EGO_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn(process.execPath, [cli, '--space', EGO_SPACE, '--timeout-ms', String(timeoutMs), script], { stdio: ['ignore', 'pipe', 'ignore'] });
    const kill = setTimeout(() => p.kill('SIGKILL'), timeoutMs + 60_000);
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => { clearTimeout(kill); resolve({ ok: false, status: 'error', error: 'ego-runner 起不来' }); });
    p.on('close', () => {
      clearTimeout(kill);
      let j = null;
      try { j = JSON.parse(out.trim().split('\n').pop()); } catch {}
      if (j && j.ok && j.result && typeof j.result === 'object') return resolve({ ok: true, result: j.result });
      const [status, error] = EGO_REASON[j?.reason] || ['error', j?.reason ? `网页采集失败（${j.reason}）` : '网页采集没有返回结果'];
      resolve({ ok: false, status, error });
    });
  });
}

/** 状态灯：Colab 或 Kaggle 有活跃会话 → warn（橙，提示去停机）；读到了且都空闲 → ok（绿）；都读不到 → idle（灰）。 */
export function computeLight(view) {
  const colab = view.colab?.ok, kaggle = view.kaggle?.ok;
  const colabActive = !!colab && ((colab.sessions || []).length > 0 || (colab.metrics?.assignments || 0) > 0);
  const kaggleKnown = !!kaggle && kaggle.metrics?.sessionsKnown !== false;   // 会话没读到的快照不能当「空闲」
  const kaggleActive = kaggleKnown && (kaggle.sessions || []).length > 0;
  if (colabActive || kaggleActive) return { level: 'warn', text: `${[colabActive && 'Colab', kaggleActive && 'Kaggle'].filter(Boolean).join('、')} 在跑，用完去停机` };
  if (colab || kaggleKnown) return { level: 'ok', text: '空闲' };
  return { level: 'idle', text: '未读取' };
}

const pidAlive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readLockFile = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return e.code === 'ENOENT' ? null : {}; } };
/** 跨进程刷新锁（网页服务和 hub compute refresh 共用一把）：原子 wx 建文件；持有进程已退出的锁自动接管。 */
export function tryRefreshLock(file, meta) {
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, ...meta }), { flag: 'wx' }); return { ok: true, release: () => { try { if (readLockFile(file)?.pid === process.pid) fs.rmSync(file, { force: true }); } catch {} } }; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    const h = readLockFile(file);
    if (h && pidAlive(h.pid)) return { ok: false, holder: h };
    if (h && !h.pid && h.startedAt && Date.now() - Date.parse(h.startedAt) < 10 * 60_000) return { ok: false, holder: h };   // 读到半写的文件：先当在跑
    fs.rmSync(file, { force: true });
  }
  return { ok: false, holder: readLockFile(file) };
}

export function createComputeService({ dbFile = studioDbPath(), lockFile = `${dbFile}.refresh.lock`, colab = readColab, stop = stopColab, gemini = readGemini, ego = runEgo, now = () => Date.now(), debounceMs = COLAB_DEBOUNCE_MS } = {}) {
  const store = openStudio(dbFile);
  let refreshing = null, flight = null, colabAt = 0, colabFlight = null;

  const saveColab = (r) => { store.record('colab', r); colabAt = now(); return r; };
  const pollColab = () => {
    if (colabFlight) return colabFlight;
    colabAt = now();
    colabFlight = Promise.resolve().then(colab).then(saveColab, (e) => saveColab({ status: 'error', error: String(e?.message || e).slice(0, 200) })).finally(() => { colabFlight = null; });
    return colabFlight;
  };

  async function fast() {
    await Promise.all([pollColab(), Promise.resolve().then(gemini).then((r) => store.record('gemini', r), (e) => store.record('gemini', { status: 'error', error: String(e?.message || e).slice(0, 200) }))]);
  }
  async function full() {
    const [, r] = await Promise.all([fast(), ego()]);
    for (const p of EGO_PROVIDERS) {
      if (!r.ok) { store.record(p, { status: r.status, error: r.error }); continue; }
      const x = r.result[p];
      if (!x || typeof x !== 'object') store.record(p, { status: 'error', error: '这次没采到' });
      else store.record(p, { status: String(x.status || 'error'), metrics: x.metrics ?? null, sessions: x.sessions ?? null, error: x.error ?? null });
    }
  }

  return {
    store,
    /** 刷新：已经在跑就不再起，返回 { started:false }；promise 给 CLI 等结果用。 */
    refresh(scope = 'fast') {
      if (scope !== 'fast' && scope !== 'all') throw new Error('scope 只能是 fast 或 all');
      if (flight) return { started: false, refreshing, promise: flight };
      const meta = { scope, startedAt: new Date(now()).toISOString() };
      const lk = tryRefreshLock(lockFile, meta);
      if (!lk.ok) return { started: false, refreshing: { scope: lk.holder?.scope || null, startedAt: lk.holder?.startedAt || null, elsewhere: true }, promise: Promise.resolve() };
      refreshing = meta;
      flight = Promise.resolve().then(() => (scope === 'all' ? full() : fast())).finally(() => { lk.release(); refreshing = null; flight = null; });
      return { started: true, refreshing, promise: flight };
    },
    /** 秒回：不等任何采集。poll 时 Colab 距上次读超过防抖间隔就在后台再读一次（顶栏灯用 poll:false 只看快照）。 */
    status({ local = false, poll = true } = {}) {
      const other = !flight && readLockFile(lockFile);
      const elsewhere = other && pidAlive(other.pid) ? { scope: other.scope || null, startedAt: other.startedAt || null, elsewhere: true } : null;
      if (poll && !flight && !elsewhere && now() - colabAt >= debounceMs) pollColab().catch(() => {});
      const view = store.all();
      return { providers: view, light: computeLight(view), refreshing: refreshing || elsewhere, local, now: new Date(now()).toISOString() };
    },
    async stopColab(id) {
      const ok = store.latest('colab').ok;
      const s = (ok?.sessions || []).find((x) => x.id === id);
      if (!s) return { ok: false, code: 404, error: '最近一次读到的会话里没有它，先刷新' };
      if (!s.stoppable) return { ok: false, code: 400, error: '这个会话本机没有记录，去 Colab 网页里停' };
      const r = await stop(id);
      await pollColab();
      return r.ok ? { ok: true } : { ok: false, code: 502, error: r.error };
    },
    idle: () => Promise.all([flight, colabFlight].filter(Boolean).map((p) => p.catch(() => {}))),
    close() { store.close(); },
  };
}

export { PROVIDERS };
