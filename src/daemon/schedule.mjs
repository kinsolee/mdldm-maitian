// 评论私信抓取的时间表（纯函数）。每个平台、每个 kind 各自独立：
// 本机时间 08:00–23:00（含 08:00，不含 23:00）每 15 分钟，其余时间每小时；按时钟边界对齐（:00 :15 :30 :45 / 整点）。
// 到没到点只和「当前这个时段的起点」比：守护进程停了几小时再起来只补一轮，不连补。
export const ENGAGE_PLATFORMS = ['Douyin', 'Channels', 'XiaoHongShu', 'Bili'];
export const DAY_START_HOUR = 8;
export const DAY_END_HOUR = 23;

// timeZone 不传就用本机时区（台湾）；测试传 'Asia/Taipei'
function localClock(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { hour: get('hour'), minute: get('minute') };
}

export function intervalMinutesAt(now, { timeZone } = {}) {
  const { hour } = localClock(now, timeZone);
  return hour >= DAY_START_HOUR && hour < DAY_END_HOUR ? 15 : 60;
}

/** now 所在时段的起点（毫秒）。 */
export function slotStart(now, { timeZone } = {}) {
  const { minute } = localClock(now, timeZone);
  const step = intervalMinutesAt(now, { timeZone });
  return now - (now % 60_000) - (minute % step) * 60_000;
}

const toMs = (v) => (v == null ? null : typeof v === 'number' ? v : Date.parse(v));

/** 这个时段还没跑过就到点。lastScheduledAt：上次定时跑的时间（毫秒或 ISO，从没跑过为 null）；now：毫秒。 */
export function isDue({ lastScheduledAt, now, timeZone }) {
  const last = toMs(lastScheduledAt);
  return last == null || Number.isNaN(last) || last < slotStart(now, { timeZone });
}
