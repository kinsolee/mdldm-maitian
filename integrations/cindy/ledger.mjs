// Cindy 的对照文件：一行一个 JSON，只放对照要用的五个字段：事件 id、平台、分类、建议回复、处理时间。
// 不放评论私信正文。按事件 id 去重：文件里已有的不再追加。
// 写成功（fsync 之后）才把收件箱里的事件标成已处理；写失败就抛错，事件留在收件箱，下一轮再处理。
import fs from 'node:fs';
import path from 'node:path';

export const CATEGORIES = ['建议回复', '新问题', '广告', '跳过'];
const NEEDS_REPLY = new Set(['建议回复', '新问题']);
export const MAX_REPLY_CHARS = 500;

const iso = (ms) => new Date(ms).toISOString();

/** 读对照文件，返回 Map<eventId, 行>。不认识的行跳过。文件不存在返回空 Map。 */
export function readLedger(file) {
  const rows = new Map();
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return rows; throw e; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r.eventId === 'string' && !rows.has(r.eventId)) rows.set(r.eventId, r);
    } catch { /* 半行（上次写到一半）不算数 */ }
  }
  return rows;
}

/** 校验 agent 交来的一条结果。合格返回 null，不合格返回原因。 */
function problem(r, inbox) {
  if (!r || typeof r !== 'object') return '不是对象';
  if (typeof r.eventId !== 'string' || !r.eventId) return '缺 eventId';
  if (!inbox.get(r.eventId)) return '收件箱里没有这个事件';
  if (!CATEGORIES.includes(r.category)) return `category 只能是 ${CATEGORIES.join('、')}`;
  if (r.suggestedReply != null && typeof r.suggestedReply !== 'string') return 'suggestedReply 要是字符串';
  if (NEEDS_REPLY.has(r.category) && !r.suggestedReply?.trim()) return `${r.category} 要写 suggestedReply`;
  return null;
}

/**
 * 登记一批结果。返回 { appended, duplicate, rejected: [{ eventId, reason }] }。
 * 不合格的不写、不标已处理。写文件失败直接抛错，这一批一条都不标已处理。
 */
export function recordResults({ inbox, file, results, now = Date.now }) {
  if (!Array.isArray(results)) throw new Error('结果要是数组');
  const existing = readLedger(file);
  const rejected = [];
  const lines = [];
  const done = [];
  let duplicate = 0;
  const seen = new Set();
  for (const r of results) {
    const why = problem(r, inbox);
    if (why) { rejected.push({ eventId: typeof r?.eventId === 'string' ? r.eventId : null, reason: why }); continue; }
    if (existing.has(r.eventId) || seen.has(r.eventId)) { duplicate++; done.push(r.eventId); continue; }
    seen.add(r.eventId);
    const reply = (r.suggestedReply ?? '').replace(/\s*\n\s*/g, ' ').trim().slice(0, MAX_REPLY_CHARS);
    lines.push(JSON.stringify({ eventId: r.eventId, platform: inbox.get(r.eventId).platform, category: r.category, suggestedReply: reply, processedAt: iso(now()) }));
    done.push(r.eventId);
  }
  if (lines.length) appendDurably(file, `${lines.join('\n')}\n`);
  inbox.markProcessed(done, now());
  return { appended: lines.length, duplicate, rejected };
}

function appendDurably(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a+', 0o600);
  try {
    // 上次写到一半没换行时，先补一个换行，免得新行接在半行后面
    const { size } = fs.fstatSync(fd);
    let prefix = '';
    if (size > 0) {
      const b = Buffer.alloc(1);
      fs.readSync(fd, b, 0, 1, size - 1);
      if (b[0] !== 0x0a) prefix = '\n';
    }
    const buf = Buffer.from(prefix + text, 'utf8');
    // writeSync 可能只写了一部分：循环写完，写不动就抛错（事件不标已处理）
    for (let off = 0; off < buf.length;) {
      const n = fs.writeSync(fd, buf, off, buf.length - off);
      if (!(n > 0)) throw new Error('对照文件写不进去（写入 0 字节）');
      off += n;
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
