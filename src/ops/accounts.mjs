// 账号登记的初始数据和平台名解析。来源：spikes/platform/lib.mjs 的 ACCOUNTS（S0 实测，2026-11-19）。
// uid 是 'pending' 的，等 login --check 读到真实 uid 后改名（见 login.mjs）。

export const PENDING = 'pending';
export const DEFAULT_PROFILE = 'Profile 5';
export const CAPABILITIES = ['readWorks', 'readComments', 'readDM', 'reply', 'sendDM', 'publish'];

const caps = (on = []) => Object.fromEntries(CAPABILITIES.map((c) => [c, on.includes(c)]));

// aliases：platformCode 之外还认的叫法（不分大小写），包括中文名和麦田的平台 id
// S0 ⑥ 验证过作品读取：抖音、小红书、B站、视频号；S0 ⑦ 验证过评论和私信读取：抖音、小红书、视频号
export const PLATFORMS = [
  { code: 'Douyin', name: '抖音', uid: '106707338905', aliases: ['douyin'], caps: caps(['readWorks', 'readComments', 'readDM']) },
  { code: 'XiaoHongShu', name: '小红书', uid: '5944af205e87e701889da649', aliases: ['xhs'], caps: caps(['readWorks', 'readComments', 'readDM']) },
  { code: 'Bili', name: 'B站', uid: '478358005', aliases: ['bilibili'], caps: caps(['readWorks']) },
  { code: 'GongZhongHao', name: '公众号', uid: 'gh_eb2c407bc687', aliases: ['mp'], caps: caps() },
  { code: 'Weibo', name: '微博', uid: '2272770294', aliases: [], caps: caps() },
  { code: 'Channels', name: '视频号', uid: PENDING, aliases: ['channels'], caps: caps(['readWorks', 'readComments', 'readDM']) },
  { code: 'X', name: 'X', uid: PENDING, aliases: [], caps: caps() },
  { code: 'YouTube', name: 'YouTube', uid: PENDING, aliases: [], caps: caps() },
  // 负责人定为暂时不处理：只登记，不检测、不开页面
  { code: 'Instagram', name: 'Instagram', uid: PENDING, aliases: [], caps: caps(), outOfScope: true },
  { code: 'Zhishi', name: '知识站', uid: PENDING, aliases: ['zsz'], caps: caps(), outOfScope: true },
];

export const spaceNameOf = (platformCode, uid) => `kinso/${platformCode}/${uid}`;
export const platformOf = (code) => PLATFORMS.find((p) => p.code === code);

/** 'douyin' / 'Douyin' / '抖音' / 'bilibili' / 'B站' → 平台定义；认不出返回 null。 */
export function resolvePlatform(arg) {
  const k = String(arg ?? '').trim().toLowerCase();
  if (!k) return null;
  return PLATFORMS.find((p) => [p.code, p.name, ...p.aliases].some((n) => n.toLowerCase() === k)) ?? null;
}
