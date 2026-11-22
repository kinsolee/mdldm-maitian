// 谷歌算力快照：独立的 data/studio.db（不碰 hub.db / ops.db）。每次采集一行，失败也记一行，旧的成功快照不动。
// 卡片读「最近一次尝试」看这次成没成、为什么失败，读「最近一次成功」拿数字。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const studioDbPath = () => process.env.MAITIAN_STUDIO_DB || path.join(ROOT, 'data', 'studio.db');

export const PROVIDERS = Object.freeze(['colab', 'gemini', 'flow', 'flowmusic', 'kaggle', 'pics', 'vids']);
const KEEP_PER_PROVIDER = 500;

const parse = (s) => { if (!s) return null; try { return JSON.parse(s); } catch { return null; } };
const row = (r) => r ? {
  status: r.status,
  metrics: parse(r.metrics_json),
  sessions: parse(r.active_sessions_json),
  error: r.error || null,
  fetchedAt: r.fetched_at,
} : null;

export function openStudio(file = studioDbPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec(`CREATE TABLE IF NOT EXISTS google_compute_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    status TEXT NOT NULL,
    metrics_json TEXT,
    active_sessions_json TEXT,
    error TEXT,
    fetched_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS google_compute_snapshots_provider ON google_compute_snapshots (provider, id);`);
  const ins = db.prepare('INSERT INTO google_compute_snapshots (provider, status, metrics_json, active_sessions_json, error, fetched_at) VALUES (?, ?, ?, ?, ?, ?)');
  const prune = db.prepare('DELETE FROM google_compute_snapshots WHERE provider = ? AND id <= (SELECT id FROM google_compute_snapshots WHERE provider = ? ORDER BY id DESC LIMIT 1 OFFSET ?)');
  const last = db.prepare('SELECT * FROM google_compute_snapshots WHERE provider = ? ORDER BY id DESC LIMIT 1');
  const lastOk = db.prepare("SELECT * FROM google_compute_snapshots WHERE provider = ? AND status = 'ok' ORDER BY id DESC LIMIT 1");

  return {
    db,
    /** 记一次采集结果。status：ok / auth_required / unconfigured / error / busy / timeout / logged_out … */
    record(provider, { status, metrics = null, sessions = null, error = null, at = new Date() }) {
      if (!PROVIDERS.includes(provider)) throw new Error(`未知 provider：${provider}`);
      const ts = (at instanceof Date ? at : new Date(at)).toISOString();
      ins.run(provider, String(status), metrics == null ? null : JSON.stringify(metrics), sessions == null ? null : JSON.stringify(sessions), error == null ? null : String(error).slice(0, 500), ts);
      prune.run(provider, provider, KEEP_PER_PROVIDER);
      return ts;
    },
    /** 最近一次尝试 + 最近一次成功。 */
    latest(provider) { return { last: row(last.get(provider)), ok: row(lastOk.get(provider)) }; },
    all() { return Object.fromEntries(PROVIDERS.map((p) => [p, this.latest(p)])); },
    close() { db.close(); },
  };
}
