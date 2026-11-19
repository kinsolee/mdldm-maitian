// 在 ego-browser nodejs 里运行（由 runner 任务脚本 import）：打开平台后台，交给平台模块读近 N 天作品和粉丝（只读）。
// 只返回平台模块 fetchRaw 的原始结果；映射（map）在宿主侧做，Ego 里不跑我们的业务逻辑，出错也好查。
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// space 里第一个受管页面；没有就收养第一个 tab，再没有就新开（同 space-check.mjs 的 mainPage）
async function mainPage(task) {
  const pages = await task.pages();
  if (pages[0]) return pages[0];
  const tab = (await task.tabs())[0];
  if (tab && !tab.label && tab.openedBy !== 'unknown') return task.adopt(tab.page);
  return task.newPage();
}

/**
 * params: { moduleUrl（平台模块的 file:// 地址）, days, nowMs }
 * 先 goto START_URL（waitUntil commit，创作者后台多是长轮询 SPA），等 SETTLE_MS 让页面把签名函数、cookie 准备好，再 fetchRaw。
 */
export async function collectInSpace(task, params, { sleep = realSleep } = {}) {
  const m = await import(params.moduleUrl);
  const page = await mainPage(task);
  await page.goto(m.START_URL, { waitUntil: 'commit', timeout: 30000 });
  await sleep(m.SETTLE_MS);
  return m.fetchRaw(page, { days: params.days, nowMs: params.nowMs, sleep });
}
