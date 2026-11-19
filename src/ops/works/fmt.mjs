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
