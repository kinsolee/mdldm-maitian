// 四平台采集共用的换算。宿主侧和 Ego space 里都会 import，只用纯 JS。
// 时间一律按东八区算，不依赖本机时区：下游 refresh.py 拿 postTime 的前 10 位当发布日期。
export const DAY = 86400;
const CST = 8 * 3600_000;

// 秒 → 东八区 "YYYY-MM-DD HH:mm:ss"（小V猫导出的格式）；0 / 空 → null，由调用方决定回退
export const cst = (sec) => (sec ? new Date(sec * 1000 + CST).toISOString().replace('T', ' ').slice(0, 19) : null);
export const cstMs = (ms) => (ms ? cst(ms / 1000) : null);
export const cstDate = (sec) => (sec == null ? null : new Date(sec * 1000 + CST).toISOString().slice(0, 10));
// 东八区当天 0 点（秒）
export const cstDay0 = (sec) => Math.floor((sec + CST / 1000) / DAY) * DAY - CST / 1000;

// 平台没返回就是 null，不能写成 0：下游把 0 当真实数据
export const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
// 0–1 小数 → 百分数，保留 4 位小数（探针的精度：0.047969 → 4.7969）
export const pct = (v) => {
  const n = num(v);
  return n == null ? null : Math.round(n * 100 * 1e4) / 1e4;
};

// 抖音 items[].id 超过 2^53，直接 JSON.parse 会丢精度；先把它改成字符串再解析
export const parseBigIds = (text) => JSON.parse(String(text).replace(/"id":(\d{16,})/g, '"id":"$1"'));

// 只挑出 map 用得着的键，裁剪 raw 用（平台对象很大，raw 要控制在约 1 MB 内）
export const pick = (o, keys) => {
  if (!o || typeof o !== 'object') return o ?? null;
  const out = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
};

// 作品列表某一页没读成功的说明（成功返回 null）。没读成功的页不能当成「这页 0 条」：
// 调用方会按 map 的 posts 覆盖整个平台，把失败当 0 条就会把导出写空（KIN-328 小红书实测过一次）
// Ego 的 page.fetch 对 POST 会给 201（视频号 post_list 实测），所以 2xx 都算 http 成功
export const httpOk = (http) => Number.isInteger(http) && http >= 200 && http <= 299;
export function pageProblem(api, index, { http, code, error }, dataOk) {
  const why = error ? `error=${error}` : !httpOk(http) ? 'http 不是 2xx' : code !== 0 ? 'code 不是 0' : !dataOk ? 'data 缺失' : null;
  return why && `${api} 第 ${index + 1} 页没读成功：${why}（http=${http ?? null} code=${code ?? null}）`;
}

// 粉丝分日固定取近 30 天（spec：粉丝总数 + 近 30 天分日），和作品窗口 --days 无关
export const FANS_DAILY_DAYS = 30;

// 作品 id → 字符串；缺值 / 空串 → null。不能用 String(undefined) 生成 "undefined"：
// 它会被当成合法 postId 写库导出，backfill 按它建重复笔记
export const idOf = (v) => (v == null || v === '' ? null : String(v));
// 窗口内有作品缺 id 时整个平台算不完整（只丢那一条会让导出悄悄少一条）
export function missingIdProblem(api, field, posts) {
  const bad = posts.filter((p) => p.postId == null);
  return bad.length ? `${api} 有 ${bad.length} 条作品缺 ${field}（postTime=${bad.map((p) => p.postTime).join('、')}）` : null;
}
