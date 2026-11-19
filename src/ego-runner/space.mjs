// 在 ego-browser nodejs 里运行：按名字取用 task space（有就接着用，没有才在指定 profile 上新建）。
// 只取用、不建 profile；Profile 6 一律拒绝。调用方只认名字，不存 spaceId（S0：Ego 会回收闲置 space，id 会变）。
export const FORBIDDEN_PROFILE = 'Profile 6';
export const USER_OWNED = 'user-owned';

/**
 * @param {{ listTaskSpaces: Function, taskSpace: Function, claimTaskSpace?: Function, takeOverTaskSpace?: Function }} ego  ego-browser 提供的全局函数
 * @param {{ name: string, profileId: string, takeBack?: boolean }} opts
 *   ownership 为 user 或 agentDelegatedToUser 时不接管，抛 code='user-owned' 的错（带 ownership）。
 *   takeBack=true（只给负责人手动「扫完了，收回」用）时，agentDelegatedToUser 用 takeOverTaskSpace 收回；user 仍不碰。
 */
export async function openSpace(ego, { name, profileId, takeBack = false }) {
  if (!profileId || profileId === FORBIDDEN_PROFILE) throw new Error(`不允许使用 ${profileId || '默认 profile'}`);
  const found = (await ego.listTaskSpaces()).find((s) => s.name === name);
  if (!found) return ego.taskSpace(name, { profileId });
  if (found.profileId !== profileId) throw new Error(`space ${name} 在 ${found.profileId} 上，不是 ${profileId}`);
  if (found.ownership === 'agent') return ego.taskSpace(found.id);
  if (found.ownership === 'agentDelegatedToUser' && takeBack) return ego.takeOverTaskSpace(found.id);
  const e = new Error(`space ${name} 现在由用户控制（ownership=${found.ownership}），不接管、不碰页面`);
  if (found.ownership === 'user' || found.ownership === 'agentDelegatedToUser') Object.assign(e, { code: USER_OWNED, ownership: found.ownership });
  throw e;
}
