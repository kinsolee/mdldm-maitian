// 对外 id：<platformCode>:<原生 id>（例如 Douyin:7709328922249741096）。原生 id 里可以再有冒号。
import { PLATFORM_NAMES } from '../accounts.mjs';

export const joinId = (platformCode, nativeId) => `${platformCode}:${nativeId}`;

/** 拆 id；格式不对或平台不认识就报错，what 写进错误里（例如「评论 id」）。 */
export function splitId(id, what = 'id') {
  const s = typeof id === 'string' ? id : '';
  const i = s.indexOf(':');
  const platformCode = s.slice(0, i), nativeId = s.slice(i + 1);
  if (i <= 0 || !nativeId) throw new Error(`${what} 要写成 <platformCode>:<原生 id>，收到：${JSON.stringify(id)}`);
  if (!PLATFORM_NAMES[platformCode]) throw new Error(`${what} 的平台不认识：${platformCode}（可选：${Object.keys(PLATFORM_NAMES).join(', ')}）`);
  return { platformCode, nativeId };
}

export function checkPlatforms(platforms) {
  if (platforms == null) return null;
  if (!Array.isArray(platforms)) throw new Error('platforms 要是数组');
  for (const p of platforms) if (!PLATFORM_NAMES[p]) throw new Error(`不认识的平台：${p}（可选：${Object.keys(PLATFORM_NAMES).join(', ')}）`);
  return platforms.length ? platforms : null;
}
