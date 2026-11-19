// 错误信息、日志去敏：守护进程日志、sync_jobs.error、飞书、适配器的 error 都过这里。
// 宁可多打码：键名不要求词边界、大小写不敏感（msToken、X-CSRF-Token、bili_jct 都算）。
const KEY = /([\w-]*(?:token|bogus|sessdata|bili_jct|web_session|csrf|sign|ticket|secret|passw(?:or)?d|sessionid|\bsid|\ba1)[\w-]*)(\s*[:=]\s*)["']?[^\s&;"',]+/gi;
const MAX = 300;

/** redact(text) => string：URL 只留 origin + path；cookie 串、Authorization 整段去掉；敏感键名的值换成 ***；截到 300 字。 */
export function redact(text) {
  return String(text ?? '')
    .replace(/\b(set-cookie|cookie)\b\s*[:=][^\n]*/gi, '$1: ***')
    .replace(/\b(authorization)\b\s*[:=]\s*(?:(?:bearer|basic|token)\s+)?[^\s,;]+/gi, '$1: ***')
    .replace(/\bbearer\s+[\w.~+/=-]+/gi, 'Bearer ***')
    .replace(/https?:\/\/[^\s"'<>）)]+/g, (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return '（地址）'; } })
    .replace(KEY, '$1$2***')
    .slice(0, MAX);
}
