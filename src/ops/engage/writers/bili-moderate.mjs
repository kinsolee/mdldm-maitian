// B站处置：删评论、拉黑、删私信会话。和 bili.mjs 一样在 member.bilibili.com 页面里调接口，接口约定见 writers/index.mjs。
//   删评论 delete：nav 核对账号 → x/web-interface/view 取 aid、确认作品是我的 → x/v2/reply/reply 按 rpid 二分页码，只定位目标这一条
//        （楼已不在 → already-gone；定位不到 → target-not-found；定位不了 → thread-incomplete；作者是我 → self-target；
//        一楼下面有回复 → deletes-thread，rejected，因为 B站删一楼会连整楼回复一起删）
//        → x/v2/reply/del 只调一次 → 等 2 秒再定位这一条：楼没了，或这条不在、它原来前后的两条现在挨着，才算 found。
//        reply/reply 定位不到（第 1 页空、count>0，或楼中楼被隐藏），或读到的页 rpid 乱序（不能二分、邻居证据也不成立）：
//        目标可能还在 x/v2/reply/up/fulllist 里。
//        改按作品把 fulllist 读全、找这一条（rpid、作品、楼、作者都对上），删后用同一套读法确认它不在了才算 found；
//        fulllist 里也没有才报 target-not-found，读不全就不删（thread-incomplete）。
//   拉黑 block：x/relation?fid= 重读（attribute 128 已拉黑 → already-blocked）→ x/relation/modify act=5 只调一次 → 再读 x/relation，attribute 128 才算 found。
//   删会话 deleteConversation：session_svr/get_sessions 把用户与系统、未关注人、被拦截、陌生人四组都翻完重读
//        （都不在 → already-gone；哪组翻不完 → list-incomplete）→ session_svr/remove_session 只调一次 → 四组再翻一遍，都翻完且都不在才算 found。
//        只是从会话列表里移除，聊天记录还在；对方再发消息会话会回来。
// 目标是登录账号自己（mid 相同）一律不动手（self-target）。csrf（cookie bili_jct）只在页面里读、只在页面里填，不回到 Node。
// 返回同 writers/index.mjs：found 的含义是「回读确认生效了」（评论没了、已拉黑、会话不在列表里）。
import { bigJson, mainPage, open, sleep } from '../adapters/page-lib.mjs';

export const FILE = 'bili-moderate.mjs';
export const PAGE = 'https://member.bilibili.com/platform/comment/article';
const API = 'https://api.bilibili.com';
const VC = 'https://api.vc.bilibili.com';
const GONE_CODES = new Set([12022, -404]);   // 12022：评论已经被删除了
// reply/reply 的 12006「没有该评论」：root 这栋楼不存在。root 填错也是 12006，所以发前不认（不能把填错的 id 当已删）；
// 发后回读才认：发前已经用同一接口读到过这栋楼，发后变成 12006 就是楼被删了，楼里的每一条自然也不在了。
const READBACK_GONE_CODES = new Set([...GONE_CODES, 12006]);
const BLOCKED_ATTR = 128;                    // x/relation 的 attribute：128 = 已拉黑
const MAX_SESSION_PAGES = 50;              // 一次扫描（四组加起来）最多读这么多页：发前、发后各一次，留在 120 秒写入超时里

export async function runInSpace(task, params) {
  let page;
  try {
    page = await mainPage(task);
    await open(page, params.urls?.comments ?? PAGE);
    await sleep(3000);
  } catch (e) {
    return { uidSeen: null, blocked: 'precheck-error', detail: errText(e), sendAttempted: false };
  }
  const api = {
    sleep,
    async get(url) {
      const r = await page.fetch(url, { credentials: 'include', timeout: 20000 });
      const j = bigJson(String(r.body));
      if (!j) throw new Error(`GET ${url.split('?')[0]} http=${r.status} 不是 JSON`);
      return j;
    },
    async post(url, form, csrfFields) {
      const text = await page.evaluate(async ({ url, form, csrfFields }) => {
        const csrf = (document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/) || [])[1];
        if (!csrf) return JSON.stringify({ code: -111, message: '页面里没有 bili_jct，没调接口', noCsrf: true });
        const body = new URLSearchParams(form);
        for (const k of csrfFields) body.set(k, csrf);
        const r = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
        return await r.text();
      }, { url, form, csrfFields });
      const j = bigJson(String(text));
      if (!j) throw new Error(`POST ${url.split('?')[0]} 返回的不是 JSON`);
      return j;
    },
  };
  const run = OPS[params.op];
  if (!run) return { uidSeen: null, blocked: 'precheck-error', detail: `bili-moderate 不认识 op ${params.op}`, sendAttempted: false };
  return run(api, params);
}

const strForm = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)]));
const midOf = (x) => String(x?.member?.mid ?? x?.mid ?? '');
const rpidOf = (x) => String(x?.rpid_str ?? x?.rpid ?? '');
const errText = (e) => String(e?.message ?? e).slice(0, 300);
const noCsrf = (me, r) => ({ uidSeen: me, blocked: 'send-error', detail: String(r.message ?? '页面里没有 bili_jct，没调接口'), sendAttempted: false });

async function whoAmI(api, uid) {
  const nav = await api.get(`${API}/x/web-interface/nav`);
  if (nav.code === -101 || !nav.data?.isLogin) return { done: { uidSeen: null, loginLost: true, evidence: `x/web-interface/nav code=${nav.code}`, sendAttempted: false } };
  const me = nav.data?.mid == null ? null : String(nav.data.mid);
  if (!me) return { done: { uidSeen: null, blocked: 'no-uid', detail: 'nav 没给 mid', sendAttempted: false } };
  if (me !== String(uid)) return { done: { uidSeen: me, blocked: 'uid-mismatch', detail: `登记的是 ${uid}，页面上登录的是 ${me}`, sendAttempted: false } };
  return { me };
}

// —— 删评论：只定位目标这一条，不读整楼 ——
// x/v2/reply/reply 大多数楼的 rpid 是递增的，按 rpid 二分页码，十来页就能落到目标那一页，再按 rpid 精确对上。
// 但这不是接口保证：2026-11-23 只读核过 BV1BGWx6YE8J 的一栋楼（page.count=21），第 1 页 20 条里有 4 处 rpid 倒退。
// 读到乱序（页内，或目标和相邻页之间）就不二分、不用邻居证据，发前改按作品读 up/fulllist；发后回读在这条路径上遇到乱序只算确认不了。
// 回读不靠「整楼读全」：发前记下目标前后的两条（邻居），发后这条不见了、并且这两条现在挨着，才算删掉。
// 「挨着」的证据只认两种（用到的每一页都要没少给：满页，或条数够得上 page.count）：同一次读到的同一页里两条相邻；或者跨页时先读后一页、再读前一页（删除只会让后面的往前挪，
// 这个顺序拼不出假的「挨着」），前一页还得是满的。「楼的末尾」要本页不满、条数和 page.count 对得上，或下一页空、count 也到这儿为止。
const PS = 20;
const MAX_LOCATE_PAGES = 30;               // 一次定位最多读这么多页（二分 2^25 页的楼也够）
const START = 'start', END = 'end';        // 邻居：目标前面没有了 / 后面没有了
const bigOf = (x) => (/^\d+$/.test(String(x ?? '')) ? BigInt(String(x)) : null);
// 条数只认非负整数（数字，或纯数字的字符串）：负数、小数、false、空白串都不能当「下面没有回复」的证据
const countOf = (x) => (typeof x === 'number' ? (Number.isInteger(x) && x >= 0 ? x : NaN) : typeof x === 'string' && /^\d+$/.test(x) ? Number(x) : NaN);
const showId = (x) => (x === START ? '楼的开头' : x === END ? '楼的末尾' : x == null ? '（读不到）' : String(x));

/** 按页读楼，带缓存和页数上限。page(pn) → { replies, ids, count, root } / { gone, code } / { error, unsure?, unordered? }。page.sawUnordered()：读过的页里有没有乱序。goneCodes：哪些 code 算楼已不在。 */
function threadReader(api, oid, root, goneCodes = GONE_CODES) {
  const cache = new Map();
  let unordered = false;
  const page = async (pn) => {
    if (cache.has(pn)) return cache.get(pn);
    if (cache.size >= MAX_LOCATE_PAGES) return { error: `reply/reply 读了 ${MAX_LOCATE_PAGES} 页还没定位到`, unsure: true };
    if (cache.size) await api.sleep(200);
    const j = await api.get(`${API}/x/v2/reply/reply?oid=${oid}&type=1&root=${root}&ps=${PS}&pn=${pn}`);
    let r;
    if (goneCodes.has(j.code)) r = { gone: true, code: j.code };
    else if (j.code !== 0) r = { error: `reply/reply 第 ${pn} 页 code=${j.code} ${j.message ?? ''}`.trim() };
    else if (!Array.isArray(j.data?.replies) && j.data?.replies !== null) r = { error: `reply/reply 第 ${pn} 页缺 data.replies` };
    else {
      const replies = j.data.replies ?? [];
      const ids = replies.map((x) => bigOf(rpidOf(x)));
      if (ids.some((x) => x == null)) r = { error: `reply/reply 第 ${pn} 页有条目缺 rpid`, unsure: true };
      else if (ids.some((x, i) => i > 0 && x <= ids[i - 1])) { unordered = true; r = { error: `reply/reply 第 ${pn} 页不是按 rpid 递增，定位不了`, unsure: true, unordered: true }; }
      else r = { replies, ids, count: countOf(j.data?.page?.count), root: j.data?.root ?? null };
    }
    // 每页各自递增也可能跨页倒退：和已读过的页比一遍
    if (r.ids?.length) for (const [q, c] of cache) if (c.ids?.length && (q < pn ? c.ids.at(-1) >= r.ids[0] : r.ids.at(-1) >= c.ids[0])) unordered = true;
    cache.set(pn, r);
    return r;
  };
  page.sawUnordered = () => unordered;
  return page;
}

/** 这一页本身没少给：满页，或者前面各页加本页的条数够得上这次读到的 page.count（隐藏、折叠、少给的页不算）。 */
const whole = (pn, p) => p.ids.length === PS || (pn - 1) * PS + p.ids.length >= p.count;

/** 第 pn 页（p 是这一页）后面那一条：下一页第 1 条、END（有证据到底了），或 null（证明不了）。 */
async function after(page, pn, p) {
  // 本页不满：本页就是最后一页，但条数要和 page.count 对得上（少给的页不算到底）
  if (p.ids.length < PS) return whole(pn, p) ? END : null;
  const next = await page(pn + 1);
  if (!next.ids) return null;
  // 下一页第 1 条也要来自没少给的页
  if (next.ids.length) return whole(pn + 1, next) ? next.ids[0] : null;
  return pn * PS >= next.count ? END : null;
}

/** 第 pn 页前面那一条：START、上一页的最后一条（上一页必须是满的），或 null。 */
async function before(page, pn) {
  if (pn === 1) return START;
  const prev = await page(pn - 1);
  return prev.ids?.length === PS ? prev.ids.at(-1) : null;
}

/** 在楼里按 rpid 找：{ at: { pn, i, node } } / { slot: { pn, i } }（不在，i 是它该在的位置）/ { gone } / { error, unsure?, hidden?, unordered? }。 */
async function seek(page, rpid) {
  const first = await page(1);
  if (!first.ids) return first;
  if (!Number.isFinite(first.count)) return { error: 'reply/reply 的 page.count 不是非负整数', unsure: true };
  // X3-B1：第 1 页是空的、count 却说有回复，不能当空楼
  if (!first.ids.length && first.count > 0) return { error: `reply/reply 第 1 页是空的，但 page.count=${first.count}`, unsure: true, hidden: true };
  let last = Math.max(1, Math.ceil(first.count / PS));
  let lo = 1, hi = last;
  for (;;) {
    while (lo <= hi) {
      const pn = Math.floor((lo + hi) / 2);
      const p = await page(pn);
      if (!p.ids) return p;
      if (!p.ids.length || rpid < p.ids[0]) { hi = pn - 1; continue; }   // 空页：已经过了楼的末尾
      if (rpid > p.ids.at(-1)) { lo = pn + 1; continue; }
      const i = p.ids.indexOf(rpid);
      return i >= 0 ? { at: { pn, i, node: p.replies[i] } } : { slot: { pn, i: p.ids.findIndex((x) => x > rpid) } };
    }
    if (lo <= last) break;
    // 目标比 count 算出的最后一页还靠后：最后一页满、下一页还有回复，说明 count 偏小，往后加倍再找（受 30 页上限约束）
    const tail = await page(last);
    if (!tail.ids) return tail;
    if (tail.ids.length < PS) break;
    const more = await page(last + 1);
    if (!more.ids) return more;
    if (!more.ids.length) break;
    lo = last + 1; last *= 2; hi = last;
  }
  return { slot: { pn: lo, i: 0 } };
}

// —— reply/reply 靠不住时（楼中楼被隐藏、rpid 乱序）：按作品读 UP 主评论管理 ——
// 2026-11-22 登录态只读核过（B站 478358005，两条被隐藏的广告楼中楼）：
//   x/v2/reply/up/fulllist?bvid=&order=1&filter=-1&type=1&pn=&ps=20 只给这个作品的评论（含楼中楼，新到旧），page.total 是这个作品的条数
//   （BV1iBsg6sEjz total=21：第 1 页 20 条、第 2 页 1 条；BV1aasw6xEiB total=4）；翻过末尾、或 bvid 不存在时 data.list 是 null。
//   不认 rpid 参数（带了照样给全部作品）。条目有 rpid、oid、root、parent、bvid、mid / member.mid。
//   被隐藏的那两条 state=0、attr=0、invisible=false、folder.is_folded=false、reply_control.is_garbage=false、pass_type=0，
//   和看得见的评论没有区别：没有字段标「隐藏 / 折叠 / 待审」，所以不靠字段判断，只靠「reply/reply 没有、fulllist 有」。
// 「读全」的证据：每页 page.total 一样、条目都是这个作品的、没有重复，读到的条数等于 page.total。
// 这个接口没有游标或快照，翻页中间有增删时列表会挪位，可能刚好漏掉一条而上面几条照样成立（R1 Codex-1）。
// 所以发后回读不只看「这条不在」：读到的整个集合要正好等于发前那一次减去这一条，作品下有任何别的变化都判确认不了；
// 一页的内容和 page.total 也可能不是同一时刻的（R2 Codex-1：旧页面配新 total，前面删了一条、目标挪进读过的页），
// 所以这样的结果要隔一会儿再完整读一遍、两次集合一样才算。
const MAX_FULLLIST_PAGES = 20;             // 一个作品最多读 400 条：发前一遍、发后两遍最多 60 页；写入 runner 的脚本时限约 108 秒，慢接口下回读没读完只会记 needs_readback，不重试

/** 按作品读全 fulllist：{ items: Map(rpid → 条目), total } / { error, unsure? }。 */
async function scanWork(api, bvid, oid) {
  const items = new Map();
  let total = null;
  for (let pn = 1; ; pn++) {
    if (pn > MAX_FULLLIST_PAGES) return { error: `作品 ${bvid} 读了 ${MAX_FULLLIST_PAGES} 页还没读完`, unsure: true };
    if (pn > 1) await api.sleep(300);
    const j = await api.get(`${API}/x/v2/reply/up/fulllist?bvid=${encodeURIComponent(bvid)}&order=1&filter=-1&type=1&pn=${pn}&ps=${PS}`);
    if (j.code !== 0) return { error: `第 ${pn} 页 code=${j.code} ${j.message ?? ''}`.trim() };
    const list = j.data?.list;
    if (!Array.isArray(list) && list !== null) return { error: `第 ${pn} 页缺 data.list` };
    const n = countOf(j.data?.page?.total);
    if (!Number.isFinite(n)) return { error: `第 ${pn} 页的 page.total 不是非负整数`, unsure: true };
    if (total != null && n !== total) return { error: `翻页时 page.total 从 ${total} 变成了 ${n}`, unsure: true };
    total = n;
    for (const x of list ?? []) {
      const id = bigOf(rpidOf(x));
      if (id == null) return { error: `第 ${pn} 页有条目缺 rpid`, unsure: true };
      if (String(x?.oid ?? '') !== String(oid)) return { error: `按 bvid=${bvid} 读，第 ${pn} 页却给了评论区 ${x?.oid ?? '（没给）'} 的评论`, unsure: true };
      if (items.has(String(id))) return { error: `翻页时 ${id} 出现了两次（列表在变）`, unsure: true };
      items.set(String(id), x);
    }
    if ((list?.length ?? 0) < PS || pn * PS >= total) break;
  }
  if (items.size !== total) return { error: `作品 ${bvid} 读到 ${items.size} 条，page.total=${total}，对不上`, unsure: true };
  return { items, total };
}

const isSelf = (mid, me, p) => mid === me || mid === String(p.uid) || (p.selfUids ?? []).includes(mid);

/** 发前：确认目标还在、rpid 对得上、作者不是我。返回 { done }（不调接口）或 { check }（发后回读要用）。 */
async function precheckComment(api, p, me, oid) {
  const t = p.target;
  const stop = (blocked, detail) => ({ done: { uidSeen: me, blocked, detail, sendAttempted: false } });
  const rpid = bigOf(t.commentId);
  if (rpid == null) return stop('target-not-found', `评论 id 不对：${t.commentId}`);
  const page = threadReader(api, oid, t.rootId);

  if (String(t.commentId) === String(t.rootId)) {
    // 删一楼：B站会把它下面的整楼回复一起删掉。下面有回复（不管是谁的）就不删
    const first = await page(1);
    if (first.gone) return stop('already-gone', `楼 ${t.rootId} 已不在（code=${first.code}）`);
    if (!first.ids) return stop(first.unsure ? 'thread-incomplete' : 'precheck-error', first.error);
    if (!first.root || rpidOf(first.root) !== String(t.commentId)) return stop('target-not-found', `reply/reply 给的一楼是 ${first.root ? rpidOf(first.root) : '（没给）'}，不是 ${t.commentId}`);
    if (first.root.oid != null && String(first.root.oid) !== String(oid)) return stop('target-not-found', `一楼 ${t.commentId} 在评论区 ${first.root.oid}，不是 ${oid}`);
    const author = midOf(first.root);
    if (!author) return stop('precheck-error', '读不到这条评论的作者');
    if (isSelf(author, me, p)) return stop('self-target', '这条是我自己的评论，不删');
    if (!Number.isFinite(first.count)) return stop('thread-incomplete', 'reply/reply 的 page.count 读不到或不是非负整数，判断不了一楼下面有没有回复');
    const extra = [first.root.rcount, first.root.count].filter((x) => x != null);
    if (extra.some((x) => !Number.isFinite(countOf(x)))) return stop('thread-incomplete', '一楼的 rcount / count 不是非负整数，判断不了下面有没有回复');
    const n = Math.max(first.count, first.ids.length, ...extra.map(countOf));
    if (n > 0) return { done: { ...stop('deletes-thread', `${t.commentId} 是一楼，下面有 ${n} 条回复；B站删一楼会把整楼回复一起删掉，不删`).done, rejected: true } };
    return { check: { isRoot: true } };
  }

  const s = await seek(page, rpid);
  if (s.gone) return stop('already-gone', `楼 ${t.rootId} 已不在（code=${s.code}）`);
  const viaWork = async (why) => precheckFromWork(p, me, oid, rpid, stop, await scanWork(api, t.workId, oid), why, page.sawUnordered());
  if (s.hidden || s.unordered) return viaWork(s.error);
  if (s.error) return stop(s.unsure ? 'thread-incomplete' : 'precheck-error', s.error);
  if (!s.at) return viaWork(`按 rpid 定位到楼 ${t.rootId} 第 ${s.slot.pn} 页，没有 ${t.commentId}`);
  const node = s.at.node;
  const nodeRoot = String(node.root_str ?? node.root ?? '');
  if (nodeRoot !== String(t.rootId)) return stop('target-not-found', `对上 rpid 的这条属于楼 ${nodeRoot || '（没给）'}，不是楼 ${t.rootId}`);
  if (node.oid != null && String(node.oid) !== String(oid)) return stop('target-not-found', `对上 rpid 的这条在评论区 ${node.oid}，不是 ${oid}`);
  const author = midOf(node);
  if (!author) return stop('precheck-error', '读不到这条评论的作者');
  if (isSelf(author, me, p)) return stop('self-target', '这条是我自己的评论，不删');
  // 邻居按发后回读同一套规则取（前一页要满、末尾要和 count 对得上），发前能过的，发后才确认得了
  const here = await page(s.at.pn);
  if (!whole(s.at.pn, here)) return stop('thread-incomplete', `目标所在的第 ${s.at.pn} 页只有 ${here.ids.length} 条，和 page.count=${here.count} 对不上，删了也确认不了，没删`);
  const prev = s.at.i > 0 ? here.ids[s.at.i - 1] : await before(page, s.at.pn);
  const next = s.at.i < here.ids.length - 1 ? here.ids[s.at.i + 1] : await after(page, s.at.pn, here);
  // 邻居证据要求读过的页都按 rpid 递增：页内乱序或跨页倒退都不能用
  if (page.sawUnordered()) return viaWork(`楼 ${t.rootId} 第 ${s.at.pn} 页附近不是按 rpid 递增，邻居证据用不了`);
  if (prev == null || next == null) return stop('thread-incomplete', `定位到了 ${t.commentId}（第 ${s.at.pn} 页），但读不到它前后的两条，删了也确认不了，没删`);
  return { check: { isRoot: false, rpid, prev, next } };
}

/** reply/reply 靠不住时，在 fulllist 里找这一条（w 是 scanWork 的结果，why 是 reply/reply 那边的情况）。needAuthor：乱序时必须有预期作者并对上。 */
function precheckFromWork(p, me, oid, rpid, stop, w, why, needAuthor = false) {
  const t = p.target;
  if (w.error) return stop(w.unsure ? 'thread-incomplete' : 'precheck-error', `${why}；改查 up/fulllist：${w.error}，没删`);
  const node = w.items.get(String(rpid));
  if (!node) return stop('target-not-found', `${why}；up/fulllist 作品 ${t.workId} 的 ${w.total} 条评论里也没有 ${t.commentId}`);
  const nodeRoot = String(node.root_str ?? node.root ?? '');
  if (nodeRoot !== String(t.rootId)) return stop('target-not-found', `up/fulllist 里的 ${t.commentId} 属于楼 ${nodeRoot || '（没给）'}，不是楼 ${t.rootId}`);
  const author = midOf(node);
  if (!author) return stop('precheck-error', '读不到这条评论的作者');
  if (isSelf(author, me, p)) return stop('self-target', '这条是我自己的评论，不删');
  if (needAuthor && (t.authorUid == null || String(t.authorUid) === '')) return stop('target-not-found', `${why}；这条没有预期作者，核对不了，没删`);
  if (t.authorUid != null && String(t.authorUid) !== '' && String(t.authorUid) !== author) return stop('target-not-found', `up/fulllist 里 ${t.commentId} 的作者是 ${author}，不是 ${t.authorUid}`);
  return { check: { isRoot: false, viaWork: true, rpid, before: new Set(w.items.keys()) } };
}

/** 发后：只回读这一条在不在。{ gone, detail }，gone 只在拿到证据时为 true。 */
async function readBackComment(api, p, oid, check) {
  const t = p.target;
  const page = threadReader(api, oid, t.rootId, READBACK_GONE_CODES);
  if (check.isRoot) {
    const first = await page(1);
    if (first.gone) return { gone: true, detail: `楼 ${t.rootId} 已不在（code=${first.code}）` };
    if (!first.ids) return { gone: false, detail: first.error };
    if (first.root && rpidOf(first.root) === String(t.commentId)) return { gone: false, detail: '回读时这条还在' };
    return { gone: false, detail: `回读时 reply/reply 给的一楼是 ${first.root ? rpidOf(first.root) : '（没给）'}，确认不了` };
  }
  if (check.viaWork) {
    // 发前就是在 fulllist 里核对的，reply/reply 看不到它或顺序不可信：用同一套读法确认它不在了
    const w = await scanWork(api, t.workId, oid);
    if (w.error) return { gone: false, detail: `回读 up/fulllist：${w.error}，确认不了` };
    if (w.items.has(String(check.rpid))) return { gone: false, detail: '回读时 up/fulllist 里这条还在' };
    const added = [...w.items.keys()].filter((id) => !check.before.has(id));
    const lost = [...check.before].filter((id) => id !== String(check.rpid) && !w.items.has(id));
    if (added.length || lost.length) return { gone: false, detail: `回读时 up/fulllist 里这条不在了，但作品 ${t.workId} 的评论还有别的变化（多了 ${added.length} 条、少了 ${lost.length} 条），翻页可能挪了位，确认不了` };
    await api.sleep(1500);
    const again = await scanWork(api, t.workId, oid);
    if (again.error) return { gone: false, detail: `第二遍回读 up/fulllist：${again.error}，确认不了` };
    if (again.items.size !== w.items.size || [...again.items.keys()].some((id) => !w.items.has(id))) return { gone: false, detail: `两遍回读 up/fulllist 读到的不一样（${w.items.size} 条、${again.items.size} 条），确认不了` };
    return { gone: true, detail: `up/fulllist 作品 ${t.workId} 的 ${w.total} 条评论里已没有 ${t.commentId}` };
  }
  const s = await seek(page, check.rpid);
  if (s.gone) return { gone: true, detail: `楼 ${t.rootId} 已不在（code=${s.code}）` };
  if (s.error) return { gone: false, detail: s.error };
  if (s.at) return { gone: false, detail: '回读时这条还在' };
  if (page.sawUnordered()) return { gone: false, detail: `回读时楼 ${t.rootId} 跨页不是按 rpid 递增，确认不了` };
  let pred, succ, freshUnordered;
  if (s.slot.i > 0) {
    // 目标该在的位置在一页中间：同一次读到的这一页里，前后两条直接相邻
    const here = await page(s.slot.pn);
    if (whole(s.slot.pn, here)) [pred, succ] = [here.ids[s.slot.i - 1], here.ids[s.slot.i]];
    else [pred, succ] = [null, null];
  } else {
    // 跨页：不用定位时的缓存，先重读后一页、再重读前一页
    const fresh = threadReader(api, oid, t.rootId, READBACK_GONE_CODES);
    freshUnordered = fresh.sawUnordered;
    const pn = s.slot.pn;
    const back = await fresh(pn);
    if (back.gone) return { gone: true, detail: `楼 ${t.rootId} 已不在（code=${back.code}）` };
    if (!back.ids) return { gone: false, detail: back.error };
    if (back.ids.includes(check.rpid)) return { gone: false, detail: '回读时这条还在' };
    if (back.ids.length && !whole(pn, back)) return { gone: false, detail: `回读时第 ${pn} 页只有 ${back.ids.length} 条，和 page.count=${back.count} 对不上，确认不了` };
    if (pn === 1) {
      pred = START;
      succ = back.ids.length ? back.ids[0] : back.count === 0 ? END : null;
    } else {
      const front = await fresh(pn - 1);
      if (front.gone) return { gone: true, detail: `楼 ${t.rootId} 已不在（code=${front.code}）` };
      if (!front.ids) return { gone: false, detail: front.error };
      if (front.ids.includes(check.rpid)) return { gone: false, detail: '回读时这条还在' };
      pred = front.ids.length ? front.ids.at(-1) : null;
      if (front.ids.length === PS) succ = back.ids.length ? back.ids[0] : (pn - 1) * PS >= back.count ? END : null;
      // 前一页不满：它就该是最后一页，后一页必须是空的，条数还要和它自己的 count 对得上
      else succ = !back.ids.length && pred != null && (pn - 2) * PS + front.ids.length >= front.count ? END : null;
    }
  }
  if (freshUnordered?.()) return { gone: false, detail: `回读时楼 ${t.rootId} 跨页不是按 rpid 递增，确认不了` };
  const nextOk = succ === check.next || (check.next === END && typeof succ === 'bigint' && succ > check.rpid);
  if (pred === check.prev && nextOk) return { gone: true, detail: `楼 ${t.rootId} 里已没有 ${t.commentId}` };
  return { gone: false, detail: `回读时定位不到 ${t.commentId}，但证明不了它原来前后两条现在挨着（原来 ${showId(check.prev)}、${showId(check.next)}，现在 ${showId(pred)}、${showId(succ)}），确认不了` };
}

export async function deleteComment(api, p) {
  const t = p.target;
  let me, oid, check;
  try {
    const who = await whoAmI(api, p.uid);
    if (who.done) return who.done;
    me = who.me;
    const view = await api.get(`${API}/x/web-interface/view?bvid=${encodeURIComponent(t.workId)}`);
    oid = view.data?.aid == null ? null : String(view.data.aid);
    if (!oid) return { uidSeen: me, blocked: 'target-not-found', detail: `作品 ${t.workId} 读不到（view code=${view.code}）`, sendAttempted: false };
    const owner = view.data?.owner?.mid == null ? null : String(view.data.owner.mid);
    if (owner !== me) return { uidSeen: me, blocked: 'not-my-work', detail: `作品 ${t.workId} 的作者是 ${owner ?? '（读不到）'}，不是我，只删自己作品下的评论`, sendAttempted: false };
    const pre = await precheckComment(api, p, me, oid);
    if (pre.done) return pre.done;
    check = pre.check;
  } catch (e) {
    return { uidSeen: me ?? null, blocked: 'precheck-error', detail: errText(e), sendAttempted: false };
  }

  // 从这里起算调过接口：之后出任何错都只回读，不重调
  let sendError = null, postError = null;
  try {
    const r = await api.post(`${API}/x/v2/reply/del`, strForm({ oid, type: 1, rpid: t.commentId }), ['csrf']);
    if (r.noCsrf) return noCsrf(me, r);
    // 12022：调的时候已经被删了（别人或平台先删的）。回读确认不在就算达成
    if (r.code !== 0 && r.code !== 12022) sendError = `reply/del code=${r.code} ${r.message ?? ''}`.trim();
  } catch (e) { postError = errText(e); }
  let readBack;
  try {
    await api.sleep(2000);
    const rb = await readBackComment(api, p, oid, check);
    const gone = rb.gone && !sendError;
    readBack = { found: gone, count: gone ? 1 : 0, nativeId: String(t.commentId),
      detail: [rb.detail, postError ? `reply/del 出错：${postError}` : null].filter(Boolean).join('；') || undefined };
  } catch (e) { readBack = { found: false, count: 0, nativeId: String(t.commentId), detail: `回读出错：${errText(e)}` }; }
  return { uidSeen: me, sendAttempted: true, ...(sendError ? { sendError } : {}), readBack: clean(readBack) };
}

async function relationAttr(api, mid) {
  const j = await api.get(`${API}/x/relation?fid=${encodeURIComponent(mid)}`);
  const a = j.data?.attribute;
  const ok = (typeof a === 'number' && Number.isFinite(a)) || (typeof a === 'string' && /^\d+$/.test(a));
  if (j.code !== 0 || !ok) return { error: `x/relation code=${j.code} ${j.message ?? ''}`.trim() };
  return { attribute: Number(j.data.attribute) };
}

export async function block(api, p) {
  const mid = String(p.target.mid ?? '');
  let me;
  try {
    const who = await whoAmI(api, p.uid);
    if (who.done) return who.done;
    me = who.me;
    if (!/^\d+$/.test(mid)) return { uidSeen: me, blocked: 'target-not-found', detail: `拉黑对象的 mid 不对：${mid}`, sendAttempted: false };
    if (mid === me || mid === String(p.uid) || (p.selfUids ?? []).includes(mid)) return { uidSeen: me, blocked: 'self-target', detail: '对象是我自己，不拉黑', sendAttempted: false };
    const rel = await relationAttr(api, mid);
    if (rel.error) return { uidSeen: me, blocked: 'precheck-error', detail: rel.error, sendAttempted: false };
    if (rel.attribute === BLOCKED_ATTR) return { uidSeen: me, blocked: 'already-blocked', detail: `${mid} 已在黑名单里`, sendAttempted: false };
  } catch (e) {
    return { uidSeen: me ?? null, blocked: 'precheck-error', detail: errText(e), sendAttempted: false };
  }

  let sendError = null, postError = null;
  try {
    const r = await api.post(`${API}/x/relation/modify`, strForm({ fid: mid, act: 5, re_src: 11 }), ['csrf']);
    if (r.noCsrf) return noCsrf(me, r);
    if (r.code !== 0) sendError = `relation/modify code=${r.code} ${r.message ?? ''}`.trim();
  } catch (e) { postError = errText(e); }
  let readBack;
  try {
    await api.sleep(1500);
    const rel = await relationAttr(api, mid);
    const ok = !rel.error && rel.attribute === BLOCKED_ATTR && !sendError;
    readBack = { found: ok, count: ok ? 1 : 0, nativeId: mid,
      detail: [rel.error ?? (rel.attribute === BLOCKED_ATTR ? null : `回读 attribute=${rel.attribute}，不是 ${BLOCKED_ATTR}`), postError ? `relation/modify 出错：${postError}` : null].filter(Boolean).join('；') || undefined };
  } catch (e) { readBack = { found: false, count: 0, nativeId: mid, detail: `回读出错：${errText(e)}` }; }
  return { uidSeen: me, sendAttempted: true, ...(sendError ? { sendError } : {}), readBack: clean(readBack) };
}

// get_sessions 的 session_type 是「哪一组」：1 用户与系统、2 未关注人、5 被拦截、8 陌生人（接口文档还有 3 粉丝团、7 系统消息，
// 都不是用户会话，不读）。广告私信常落在未关注人、被拦截里，只读 1 组会把它们当成「已不在」。发前、发后都把这几组翻完。
const SESSION_GROUPS = [[1, '用户与系统'], [2, '未关注人'], [5, '被拦截'], [8, '陌生人']];
const groupName = ([type, name]) => `session_type=${type}（${name}）`;

/** 翻完一组会话列表找 talker：{ present, complete } 或 { error }。budget.left 是这次扫描还能读的页数。 */
async function findInGroup(api, talker, type, budget) {
  let endTs = null, present = false;
  // 命中了也要翻完：发前和发后用同一个「翻完」标准，翻不完的在调接口前就拦下
  for (;;) {
    if (budget.left <= 0) return { present, complete: false };
    if (budget.used++) await api.sleep(300);
    budget.left--;
    const j = await api.get(`${VC}/session_svr/v1/session_svr/get_sessions?session_type=${type}&group_fold=1&unfollow_fold=0&sort_rule=2${endTs != null ? `&end_ts=${endTs}` : ''}&build=0&mobi_app=web`);
    if (j.code !== 0) return { error: `get_sessions code=${j.code} ${j.message ?? ''}`.trim() };
    // 文档：没有会话时 session_list 是 null
    if (j.data?.session_list === null && !j.data?.has_more) return { present, complete: true };
    if (!Array.isArray(j.data?.session_list)) return { error: 'get_sessions code=0 但缺 data.session_list' };
    const l = j.data.session_list;
    const hits = l.filter((s) => String(s.talker_id) === talker);
    // 会话条目缺 session_type：证明不了是用户会话（2 是粉丝团），不猜
    if (hits.some((s) => s.session_type == null || s.session_type === '')) return { error: `get_sessions 里 ${talker} 的会话缺 session_type，判断不了是不是用户会话` };
    if (hits.some((s) => Number(s.session_type) === 1)) present = true;
    // sort_rule=2 是按会话时间从新到旧：session_ts 要都是数字、页内不升、不比上一页的游标新，否则翻页不可信
    const ts = l.map((x) => bigOf(x.session_ts));
    if (ts.some((x) => x == null) || ts.some((x, i) => i > 0 && x > ts[i - 1]) || (endTs != null && ts.length && ts[0] > endTs)) return { present, complete: false };
    if (!j.data?.has_more) return { present, complete: true };
    // 还有下一页却给了空页、或者翻页游标没往更早的方向走：翻不完
    const next = ts.at(-1);
    if (!l.length || (endTs != null && next >= endTs)) return { present, complete: false };
    endTs = next;
  }
}

/**
 * 把每一组都翻完找 talker：{ present, complete, in, cut, groups } 或 { error }。
 * 有一组翻不完就不再读后面几组（结论已定：发前不删、发后不算删掉）。发后回读（stopOnFound）在某组里找到也停。
 * 发前找到了也要读完四组：四组都翻得完，发后才确认得了。
 */
async function findSession(api, talker, { stopOnFound = false } = {}) {
  const found = [], cut = [], budget = { left: MAX_SESSION_PAGES, used: 0 };
  for (const g of SESSION_GROUPS) {
    const r = await findInGroup(api, talker, g[0], budget);
    if (r.error) return { error: `${groupName(g)} ${r.error}` };
    if (r.present) found.push(groupName(g));
    if (!r.complete) cut.push(groupName(g));
    if (cut.length || (stopOnFound && found.length)) break;
  }
  return { present: found.length > 0, complete: !cut.length, in: found, cut, groups: SESSION_GROUPS.map(groupName).join('、') };
}

export async function deleteConversation(api, p) {
  const talker = String(p.target.conversationId ?? '');
  let me;
  try {
    const who = await whoAmI(api, p.uid);
    if (who.done) return who.done;
    me = who.me;
    if (!/^\d+$/.test(talker)) return { uidSeen: me, blocked: 'target-not-found', detail: `会话 id 不对：${talker}`, sendAttempted: false };
    if (talker === me || talker === String(p.uid) || (p.selfUids ?? []).includes(talker)) return { uidSeen: me, blocked: 'self-target', detail: '会话对象是我自己，不删', sendAttempted: false };
    const s = await findSession(api, talker);
    if (s.error) return { uidSeen: me, blocked: 'precheck-error', detail: s.error, sendAttempted: false };
    if (!s.complete) return { uidSeen: me, blocked: 'list-incomplete', detail: `会话列表 ${s.cut.join('、')} 超过 ${MAX_SESSION_PAGES} 页翻不完，删了也确认不了，没删`, sendAttempted: false };
    if (!s.present) return { uidSeen: me, blocked: 'already-gone', detail: `会话列表里已没有 ${talker}（${s.groups} 都翻完了）`, sendAttempted: false };
  } catch (e) {
    return { uidSeen: me ?? null, blocked: 'precheck-error', detail: errText(e), sendAttempted: false };
  }

  let sendError = null, postError = null;
  try {
    const r = await api.post(`${VC}/session_svr/v1/session_svr/remove_session`, strForm({ talker_id: talker, session_type: 1, build: 0, mobi_app: 'web' }), ['csrf', 'csrf_token']);
    if (r.noCsrf) return noCsrf(me, r);
    if (r.code !== 0) sendError = `remove_session code=${r.code} ${r.message ?? ''}`.trim();
  } catch (e) { postError = errText(e); }
  let readBack;
  try {
    await api.sleep(1500);
    const s = await findSession(api, talker, { stopOnFound: true });
    const ok = !s.error && s.complete && !s.present && !sendError;
    readBack = { found: ok, count: ok ? 1 : 0, nativeId: talker,
      detail: [s.error ?? (s.present ? `回读时会话还在列表里（${s.in.join('、')}）` : s.complete ? null : `回读时会话列表 ${s.cut.join('、')} 没翻完`), postError ? `remove_session 出错：${postError}` : null].filter(Boolean).join('；') || undefined };
  } catch (e) { readBack = { found: false, count: 0, nativeId: talker, detail: `回读出错：${errText(e)}` }; }
  return { uidSeen: me, sendAttempted: true, ...(sendError ? { sendError } : {}), readBack: clean(readBack) };
}

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const OPS = { delete: deleteComment, block, deleteConversation };
