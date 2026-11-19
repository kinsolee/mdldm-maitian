// 在 ego-browser nodejs 里运行：按名字取用 task space（有就接着用，没有才在指定 profile 上新建）。
// 只取用、不建 profile；只认 ALLOWED_PROFILES 里的 profile（Profile 6 等一律拒绝）。
// 抛出的错误带 code，runner 据此给出 reason：
//   profile-needed   要用的 profile 在 Ego 里不存在（需要负责人新建）
//   user-controlled  space 正由负责人手动操作（ownership 不是 agent/user）
export const FORBIDDEN_PROFILE = 'Profile 6';
export const ALLOWED_PROFILES = Object.freeze(['Profile 5']);
export const profileAllowed = (id) => ALLOWED_PROFILES.includes(id);

const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * @param {{ listTaskSpaces: Function, taskSpace: Function, claimTaskSpace: Function, profiles: Function }} ego  ego-browser 提供的全局函数
 * @param {{ name: string, profileId: string }} opts
 */
export async function openSpace(ego, { name, profileId }) {
  if (!profileAllowed(profileId)) throw new Error(`不允许使用 ${profileId || '默认 profile'}`);
  if (!(await ego.profiles()).some((p) => p.id === profileId)) throw fail('profile-needed', `Ego 里没有 ${profileId}，需要负责人新建`);
  const found = (await ego.listTaskSpaces()).find((s) => s.name === name);
  if (!found) return ego.taskSpace(name, { profileId });
  if (found.profileId !== profileId) throw new Error(`space ${name} 在 ${found.profileId} 上，不是 ${profileId}`);
  if (found.ownership === 'agent') return ego.taskSpace(found.id);
  if (found.ownership === 'user') return ego.claimTaskSpace(found.id);
  throw fail('user-controlled', `space ${name} 现在由用户控制（ownership=${found.ownership}），不接管`);
}
