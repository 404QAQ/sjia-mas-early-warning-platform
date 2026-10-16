import { describe, expect, it } from 'vitest';
import { careCalendarWeek } from '../src/care-calendar.js';
import type { CareCalendarWeek } from '../src/care-calendar.js';

const AT = '2026-10-04T23:30:00.000Z';
const durationHours = (value: { startsAt: string; endsAt: string }) => (Date.parse(value.endsAt) - Date.parse(value.startsAt)) / 3_600_000;
function expectPartition(week: CareCalendarWeek): void {
  expect(week.days).toHaveLength(7);
  expect(week.startsAt).toBe(week.days[0]!.startsAt);
  expect(week.endsAt).toBe(week.days[6]!.endsAt);
  for (let index = 0; index < 7; index++) {
    expect(Date.parse(week.days[index]!.endsAt)).toBeGreaterThanOrEqual(Date.parse(week.days[index]!.startsAt));
    if (index) expect(week.days[index]!.startsAt).toBe(week.days[index - 1]!.endsAt);
  }
  expect(week.days.reduce((sum, day) => sum + durationHours(day), 0)).toBe(durationHours(week));
}

describe('科室周历由当地日期组成', () => {
  it('上海当地周一午夜开始，七个真实日连续且返回前后周', () => {
    const week = careCalendarWeek('2026-10-05', 'Asia/Shanghai', AT);
    expect(week).toEqual({
      weekStart: '2026-10-05', previousWeekStart: '2026-09-28', nextWeekStart: '2026-10-12',
      startsAt: '2026-10-04T16:00:00.000Z', endsAt: '2026-10-11T16:00:00.000Z',
      days: Array.from({ length: 7 }, (_, index) => ({
        date: `2026-10-${String(index + 5).padStart(2, '0')}`,
        startsAt: `2026-10-${String(index + 4).padStart(2, '0')}T16:00:00.000Z`,
        endsAt: `2026-10-${String(index + 5).padStart(2, '0')}T16:00:00.000Z`,
      })),
    });
    expectPartition(week);
  });
  it('省略周一时由科室当地at推导，UTC日期周日仍可属于上海下一周', () => {
    expect(careCalendarWeek(undefined, 'Asia/Shanghai', AT).weekStart).toBe('2026-10-05');
    expect(careCalendarWeek(undefined, 'America/New_York', AT).weekStart).toBe('2026-09-28');
    expect(careCalendarWeek(undefined, 'UTC', '2026-10-04T23:59:59.999Z').weekStart).toBe('2026-09-28');
    expect(careCalendarWeek(undefined, 'UTC', '2026-10-05T00:00:00.000Z').weekStart).toBe('2026-10-05');
  });
  it('跨年与闰日均保留真实公历日期，不用Date.UTC的两位年份自动平移', () => {
    const year = careCalendarWeek('2025-12-29', 'Asia/Shanghai', AT);
    expect(year.days.map(day => day.date)).toEqual(['2025-12-29', '2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']);
    expect(year).toMatchObject({ previousWeekStart: '2025-12-22', nextWeekStart: '2026-01-05', startsAt: '2025-12-28T16:00:00.000Z', endsAt: '2026-01-04T16:00:00.000Z' });
    expect(careCalendarWeek('2024-02-26', 'UTC', AT).days[3]!.date).toBe('2024-02-29');
    expect(careCalendarWeek('0099-06-01', 'UTC', AT).startsAt).toBe('0099-06-01T00:00:00.000Z');
    expectPartition(year);
  });
  it('同一绝对at的Z/显式偏移等价；显式weekStart不由at覆写', () => {
    expect(careCalendarWeek(undefined, 'Asia/Shanghai', '2026-10-05T07:30:00+08:00')).toEqual(careCalendarWeek(undefined, 'Asia/Shanghai', AT));
    expect(careCalendarWeek('2026-03-02', 'America/New_York', AT).weekStart).toBe('2026-03-02');
  });
  it('IANA Etc固定偏移区按其真实符号转换，不解析或反转时区名', () => {
    expect(careCalendarWeek('2026-10-05', 'Etc/GMT-8', AT)).toEqual(careCalendarWeek('2026-10-05', 'Asia/Shanghai', AT));
    expect(careCalendarWeek('2026-10-05', 'Etc/GMT+8', AT).startsAt).toBe('2026-10-05T08:00:00.000Z');
  });
  it('返回值无共享可变数组；调用方修改不会污染后续结果', () => {
    const first = careCalendarWeek('2026-10-05', 'UTC', AT);
    first.days[0]!.startsAt = 'changed';
    first.days.splice(1);
    const next = careCalendarWeek('2026-10-05', 'UTC', AT);
    expect(next.days).toHaveLength(7);
    expect(next.days[0]!.startsAt).toBe('2026-10-05T00:00:00.000Z');
  });
});

describe('周历按真实时区转换，不固定168小时', () => {
  it('纽约春季周167小时，周日23小时', () => {
    const week = careCalendarWeek('2026-03-02', 'America/New_York', AT);
    expect(week).toMatchObject({ startsAt: '2026-03-02T05:00:00.000Z', endsAt: '2026-03-09T04:00:00.000Z' });
    expect(durationHours(week)).toBe(167);
    expect(week.days.map(durationHours)).toEqual([24, 24, 24, 24, 24, 24, 23]);
    expectPartition(week);
  });
  it('纽约秋季周169小时，周日25小时', () => {
    const week = careCalendarWeek('2026-10-26', 'America/New_York', AT);
    expect(week).toMatchObject({ startsAt: '2026-10-26T04:00:00.000Z', endsAt: '2026-11-02T05:00:00.000Z' });
    expect(durationHours(week)).toBe(169);
    expect(week.days.map(durationHours)).toEqual([24, 24, 24, 24, 24, 24, 25]);
    expectPartition(week);
  });
  it('Lord Howe春季半小时跳变产生167.5小时周及23.5小时日', () => {
    const week = careCalendarWeek('2026-09-28', 'Australia/Lord_Howe', AT);
    expect(week).toMatchObject({ startsAt: '2026-09-27T13:30:00.000Z', endsAt: '2026-10-04T13:00:00.000Z' });
    expect(durationHours(week)).toBe(167.5);
    expect(durationHours(week.days[6]!)).toBe(23.5);
    expectPartition(week);
  });
  it('Lord Howe秋季半小时回拨产生168.5小时周及24.5小时日', () => {
    const week = careCalendarWeek('2026-03-30', 'Australia/Lord_Howe', AT);
    expect(week).toMatchObject({ startsAt: '2026-03-29T13:00:00.000Z', endsAt: '2026-04-05T13:30:00.000Z' });
    expect(durationHours(week)).toBe(168.5);
    expect(durationHours(week.days[6]!)).toBe(24.5);
    expectPartition(week);
  });
  it('Apia国际日期线跳日保留零长12月30日，不伪造班次覆盖时间', () => {
    const week = careCalendarWeek('2011-12-26', 'Pacific/Apia', AT);
    expect(week).toMatchObject({ startsAt: '2011-12-26T10:00:00.000Z', endsAt: '2012-01-01T10:00:00.000Z' });
    expect(durationHours(week)).toBe(144);
    expect(week.days[4]).toEqual({ date: '2011-12-30', startsAt: '2011-12-30T10:00:00.000Z', endsAt: '2011-12-30T10:00:00.000Z' });
    expect(week.days.map(durationHours)).toEqual([24, 24, 24, 24, 0, 24, 24]);
    expectPartition(week);
  });
  it('圣保罗午夜不存在时以当天首个真实时间为日界', () => {
    const week = careCalendarWeek('2018-10-29', 'America/Sao_Paulo', AT);
    expect(week.days[6]).toEqual({ date: '2018-11-04', startsAt: '2018-11-04T03:00:00.000Z', endsAt: '2018-11-05T02:00:00.000Z' });
    expect(durationHours(week)).toBe(167);
    expectPartition(week);
  });
  it('哈瓦那重复午夜选最早真实边界，重复小时归入同一天', () => {
    const week = careCalendarWeek('2026-10-26', 'America/Havana', AT);
    expect(week.days[6]).toEqual({ date: '2026-11-01', startsAt: '2026-11-01T04:00:00.000Z', endsAt: '2026-11-02T05:00:00.000Z' });
    expect(durationHours(week)).toBe(169);
    expectPartition(week);
  });
  it('前后周导航共享同一个绝对边界，DST结束不留下重复或缺口', () => {
    for (const [weekStart, timeZone] of [['2026-03-02', 'America/New_York'], ['2026-10-26', 'America/New_York'], ['2011-12-26', 'Pacific/Apia'], ['2018-10-29', 'America/Sao_Paulo']] as const) {
      const week = careCalendarWeek(weekStart, timeZone, AT);
      const before = careCalendarWeek(week.previousWeekStart, timeZone, AT);
      const after = careCalendarWeek(week.nextWeekStart, timeZone, AT);
      expect(before.endsAt).toBe(week.startsAt);
      expect(after.startsAt).toBe(week.endsAt);
    }
  });
});

describe('周历输入不能隐式修正', () => {
  it.each(['', '2026-10-06', '2026-10-04', '2026-2-02', '2026-02-30', '2025-02-29', '2026-13-01', '2026-00-01', '0000-01-03', '2026-10-05T00:00:00Z', '2026-10-05 ', ' 2026-10-05', null, 20261005])('拒绝非法或非周一的周起始：%j', value => {
    expect(() => careCalendarWeek(value as string, 'UTC', AT)).toThrow(RangeError);
  });
  it.each(['', 'Mars/Olympus', '+08:00', 'UTC+08:00', 'Asia/Shanghai ', ' Asia/Shanghai', 'Asia//Shanghai', null, 8])('拒绝非法IANA时区：%j', value => {
    expect(() => careCalendarWeek('2026-10-05', value as string, AT)).toThrow(RangeError);
  });
  it.each(['', '2026-10-04', '2026-10-04T12:00:00', '2026-02-30T12:00:00Z', '2026-10-04T24:00:00Z', '2026-10-04T12:00:00+24:00', null, 0])('显式周仍拒绝非法at：%j', value => {
    expect(() => careCalendarWeek('2026-10-05', 'UTC', value as string)).toThrow(RangeError);
  });
  it('拒绝使前后周导航超出可再次输入的四位公历年范围', () => {
    expect(() => careCalendarWeek('0001-01-01', 'UTC', AT)).toThrow(RangeError);
    expect(() => careCalendarWeek('9999-12-27', 'UTC', AT)).toThrow(RangeError);
    expect(() => careCalendarWeek(undefined, 'UTC', '0000-01-03T00:00:00Z')).toThrow(RangeError);
  });
});
