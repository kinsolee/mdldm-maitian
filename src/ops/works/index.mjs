// 四平台作品和粉丝采集模块的索引。runner 任务脚本在 ego-browser 的 nodejs 里按 moduleUrlOf 给的 file:// 地址 import 平台模块
// 跑 fetchRaw；宿主侧用 loadPlatform 拿同一个模块跑 map。
export const COLLECT_PLATFORMS = ['Douyin', 'XiaoHongShu', 'Bili', 'Channels'];
const FILES = { Douyin: 'douyin.mjs', XiaoHongShu: 'xhs.mjs', Bili: 'bili.mjs', Channels: 'channels.mjs' };

export const moduleUrlOf = (platformCode) => {
  const f = FILES[platformCode];
  if (!f) throw new Error(`不采集这个平台：${platformCode}（只认 ${COLLECT_PLATFORMS.join('、')}）`);
  return new URL(`./${f}`, import.meta.url).href;
};

export async function loadPlatform(platformCode) {
  return import(moduleUrlOf(platformCode));
}
