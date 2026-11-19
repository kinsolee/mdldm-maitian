// 评论私信抓取时间表：白天 08:00–23:00 每 15 分钟、其余整点，按时钟边界对齐，停机重启只补一轮。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isDue, slotStart, intervalMinutesAt } from '../src/daemon/schedule.mjs';

const timeZone = 'Asia/Taipei';
// 台湾时间（UTC+8，无夏令时）的某一刻 → 毫秒
const tw = (s) => Date.parse(`2026-11-19T${s}+08:00`);
const due = (last, now) => isDue({ lastScheduledAt: last, now, timeZone });

describe('时间表', () => {
  test('白天按 :00 :15 :30 :45 对齐', () => {
    assert.equal(slotStart(tw('10:07:31'), { timeZone }), tw('10:00:00'));
    assert.equal(slotStart(tw('10:15:00'), { timeZone }), tw('10:15:00'));
    assert.equal(slotStart(tw('10:59:59.900'), { timeZone }), tw('10:45:00'));
    assert.equal(due(tw('10:00:05'), tw('10:14:59')), false);
    assert.equal(due(tw('10:00:05'), tw('10:15:00')), true);
    assert.equal(due(tw('10:15:20'), tw('10:29:00')), false, '10:15 那轮跑过（晚了 20 秒）不漂移，下一轮仍在 10:30');
    assert.equal(due(tw('10:15:20'), tw('10:30:00')), true);
  });

  test('夜里整点', () => {
    assert.equal(intervalMinutesAt(tw('02:10:00'), { timeZone }), 60);
    assert.equal(slotStart(tw('02:45:00'), { timeZone }), tw('02:00:00'));
    assert.equal(due(tw('02:00:10'), tw('02:45:00')), false);
    assert.equal(due(tw('02:00:10'), tw('03:00:00')), true);
  });

  test('23:00 起算夜里，08:00 起算白天', () => {
    assert.equal(intervalMinutesAt(tw('22:59:59'), { timeZone }), 15);
    assert.equal(intervalMinutesAt(tw('23:00:00'), { timeZone }), 60);
    assert.equal(intervalMinutesAt(tw('07:59:59'), { timeZone }), 60);
    assert.equal(intervalMinutesAt(tw('08:00:00'), { timeZone }), 15);
    assert.equal(due(tw('22:45:01'), tw('23:00:00')), true, '23:00 是整点，要跑');
    assert.equal(due(tw('23:00:01'), tw('23:15:00')), false, '23:15 已是夜里，不跑');
    assert.equal(due(tw('23:00:01'), tw('23:59:59')), false);
    assert.equal(due(tw('07:00:01'), tw('07:45:00')), false);
    assert.equal(due(tw('07:00:01'), tw('08:00:00')), true);
    assert.equal(due(tw('08:00:01'), tw('08:15:00')), true, '08:15 已是白天');
  });

  test('从没跑过就到点；停机几小时重启只补一轮', () => {
    assert.equal(due(null, tw('10:03:00')), true);
    const last = tw('06:00:05');
    const restart = tw('10:07:00');
    assert.equal(due(last, restart), true, '重启后补一轮');
    assert.equal(due(restart, tw('10:08:00')), false, '补完这一轮就等下一个边界，不连补错过的');
    assert.equal(due(restart, tw('10:15:00')), true);
  });

  test('lastScheduledAt 也接受 ISO 字符串', () => {
    assert.equal(due(new Date(tw('10:00:05')).toISOString(), tw('10:10:00')), false);
  });
});
