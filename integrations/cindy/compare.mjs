#!/usr/bin/env node
// OpenBot 和 Cindy 的对照报告。全部只读：ops.db、OpenBot 的记录和待确认文件、Cindy 的收件箱和对照文件。
// 用法：node integrations/cindy/compare.mjs [--hours 24] [--until <ISO 时间>]
// 报告打印到 stdout（Markdown），不写任何文件。只列事件 id、平台、分类，不带评论私信正文。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { ENV_FILE, loadEnvFile, readPaths, DEFAULT_TYPES } from './config.mjs';
import { openInbox, exists, BUSY_TIMEOUT_MS } from './store.mjs';
import { readLedger } from './ledger.mjs';

const DATA_DIR = path.join(os.homedir(), 'Documents', 'OPC-vault', '10.个人IP', '数据');
export const OPENBOT_RECORDS = path.join(DATA_DIR, '评论私信回复记录.md');
export const OPENBOT_PENDING = path.join(DATA_DIR, '评论私信待确认.md');

/** 从 Markdown 里找反引号包住的事件 id，记下每个 id 第一次出现时所在的二级标题。 */
export function idsBySection(markdown) {
  const out = new Map();
  let section = '';
  for (const line of String(markdown ?? '').split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h && !line.startsWith('###')) { section = h[1]; continue; }
    for (const m of line.matchAll(/`([a-z]+\.[a-z_]+:[^`\s]+)`/g)) if (!out.has(m[1])) out.set(m[1], section);
  }
  return out;
}

export const UNKNOWN = '未知';

/**
 * OpenBot 对一条事件的分类，按 Cindy 的四类算。还没处理返回 null。
 * 回执了、但两个文件里都找不到这个 id 的，分不出类，返回「未知」，不硬算成建议回复。
 */
export function openbotCategory(ev, recordIds, pendingIds) {
  const sec = pendingIds.get(ev.id);
  if (sec != null) return sec.includes('广告') ? '广告' : '新问题';
  if (ev.handledOutcome === 'skipped' || ev.handledOutcome === 'ignored') return '跳过';
  if (recordIds.has(ev.id)) return '建议回复';
  if (ev.handledAt) return UNKNOWN;
  return null;
}

const minutes = (a, b) => (Date.parse(b) - Date.parse(a)) / 60_000;

export function summarize(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0 };
  const pick = (p) => v[Math.min(v.length - 1, Math.ceil(p * v.length) - 1)];
  return { n: v.length, median: pick(0.5), p90: pick(0.9), max: v.at(-1) };
}

/**
 * 算对照。events：ops.db 里窗口内的事件（id、type、platformCode、createdAt、handledAt、handledOutcome）。
 * inboxRows：Cindy 收件箱的行；ledger：Map<eventId, 对照行>；records、pending：OpenBot 两个文件的全文。
 */
export function buildReport({ events, inboxRows, ledger, records, pending, since, until }) {
  const recordIds = idsBySection(records ?? '');
  const pendingIds = idsBySection(pending ?? '');
  const inbox = new Map(inboxRows.map((r) => [r.id, r]));
  const rows = events.map((ev) => {
    const cindy = ledger.get(ev.id) ?? null;
    return {
      id: ev.id, platform: ev.platformCode,
      openbot: openbotCategory(ev, recordIds, pendingIds),
      cindy: cindy?.category ?? null,
      cindyReceived: inbox.has(ev.id),
      openbotDelay: ev.handledAt ? minutes(ev.createdAt, ev.handledAt) : NaN,
      cindyDelay: cindy ? minutes(ev.createdAt, cindy.processedAt) : NaN,
    };
  });
  return {
    since, until,
    total: rows.length,
    openbotHandled: rows.filter((r) => r.openbot).length,
    cindyReceived: rows.filter((r) => r.cindyReceived).length,
    cindyRecorded: rows.filter((r) => r.cindy).length,
    missingInCindy: rows.filter((r) => !r.cindyReceived).map((r) => r.id),
    receivedNotRecorded: rows.filter((r) => r.cindyReceived && !r.cindy).map((r) => r.id),
    openbotDelay: summarize(rows.map((r) => r.openbotDelay)),
    cindyDelay: summarize(rows.map((r) => r.cindyDelay)),
    mismatches: rows.filter((r) => r.openbot && r.openbot !== UNKNOWN && r.cindy && r.openbot !== r.cindy),
    cindyOnly: rows.filter((r) => r.cindy && !r.openbot),
    openbotUnknown: rows.filter((r) => r.openbot === UNKNOWN),
    missingFiles: [records == null && 'OpenBot 记录文件', pending == null && 'OpenBot 待确认文件'].filter(Boolean),
  };
}

const fmt = (s) => (s.n ? `${s.n} 条；中位 ${s.median.toFixed(1)} 分，P90 ${s.p90.toFixed(1)} 分，最长 ${s.max.toFixed(1)} 分` : '无数据');
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');

export function renderReport(r) {
  const lines = [
    `# 麦田事件对照：OpenBot 与 Cindy`,
    '',
    `窗口：${r.since} 到 ${r.until}（按事件产生时间）`,
    '',
    '| 项目 | OpenBot | Cindy |',
    '| --- | --- | --- |',
    `| 窗口内事件 | ${r.total} | ${r.total} |`,
    `| 收到 | —（以回执计） | ${r.cindyReceived}（${pct(r.cindyReceived, r.total)}） |`,
    `| 处理完（回执 / 写进对照文件） | ${r.openbotHandled}（${pct(r.openbotHandled, r.total)}） | ${r.cindyRecorded}（${pct(r.cindyRecorded, r.total)}） |`,
    `| 触发到处理完的延迟 | ${fmt(r.openbotDelay)} | ${fmt(r.cindyDelay)} |`,
    `| 两边都处理了、分类不一致 | ${r.mismatches.length} | ${r.mismatches.length} |`,
    '',
  ];
  if (r.missingFiles.length) lines.push(`> 读不到：${r.missingFiles.join('、')}。OpenBot 一侧的分类不全，下面的「未知」会偏多。`, '');
  if (r.missingInCindy.length) lines.push('## Cindy 没收到的事件', '', ...r.missingInCindy.map((id) => `- \`${id}\``), '');
  if (r.receivedNotRecorded.length) lines.push('## Cindy 收到了还没写进对照文件', '', ...r.receivedNotRecorded.map((id) => `- \`${id}\``), '');
  if (r.cindyOnly.length) {
    lines.push('## Cindy 已分类、OpenBot 还没处理', '', '| 事件 id | 平台 | Cindy |', '| --- | --- | --- |',
      ...r.cindyOnly.map((m) => `| \`${m.id}\` | ${m.platform} | ${m.cindy} |`), '');
  }
  if (r.openbotUnknown.length) {
    lines.push('## OpenBot 回执了、但记录和待确认文件里找不到（分类未知）', '', '| 事件 id | 平台 | Cindy |', '| --- | --- | --- |',
      ...r.openbotUnknown.map((m) => `| \`${m.id}\` | ${m.platform} | ${m.cindy ?? '—'} |`), '');
  }
  if (r.mismatches.length) {
    lines.push('## 分类不一致', '', '| 事件 id | 平台 | OpenBot | Cindy |', '| --- | --- | --- | --- |',
      ...r.mismatches.map((m) => `| \`${m.id}\` | ${m.platform} | ${m.openbot} | ${m.cindy} |`), '');
  }
  return lines.join('\n');
}

/** 读文本；文件不在返回 null（报告里会提示），其他错误照常抛出。 */
function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({ args: argv, options: { hours: { type: 'string', default: '24' }, until: { type: 'string' } } });
  const hours = Number(values.hours);
  if (!(hours > 0) || !Number.isFinite(hours)) throw new Error('--hours 要是正数');
  const until = values.until ? new Date(values.until).toISOString() : new Date().toISOString();
  const since = new Date(Date.parse(until) - hours * 3600_000).toISOString();
  const opsDb = env.MAITIAN_OPS_DB || path.resolve(import.meta.dirname, '../../data/ops.db');
  const paths = readPaths(env);

  const db = new DatabaseSync(opsDb, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  let events;
  try {
    // 麦田推送前过滤掉的（filteredReason）两边都没收到，不算进对照；没升级过的库没有这一列
    const filtered = db.prepare('PRAGMA table_info(events)').all().some((c) => c.name === 'filteredReason') ? 'AND filteredReason IS NULL' : '';
    events = db.prepare(`SELECT id, type, platformCode, createdAt, handledAt, handledOutcome FROM events
      WHERE type IN (SELECT value FROM json_each(?)) AND createdAt >= ? AND createdAt < ? ${filtered} ORDER BY createdAt, id`)
      .all(JSON.stringify(DEFAULT_TYPES), since, until).map((r) => ({ ...r }));
  } finally { db.close(); }

  let inboxRows = [];
  if (exists(paths.stateDb)) {
    const inbox = openInbox(paths.stateDb, { readOnly: true });
    try { inboxRows = inbox.all(); } finally { inbox.close(); }
  }
  const report = buildReport({
    events, inboxRows, ledger: readLedger(paths.ledger),
    records: readText(env.OPENBOT_RECORDS_FILE || OPENBOT_RECORDS),
    pending: readText(env.OPENBOT_PENDING_FILE || OPENBOT_PENDING),
    since, until,
  });
  return renderReport(report);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === import.meta.filename) {
  try {
    loadEnvFile(ENV_FILE);
    console.log(main());
  } catch (e) {
    console.error(`对照失败：${e.message}`);
    process.exit(1);
  }
}
