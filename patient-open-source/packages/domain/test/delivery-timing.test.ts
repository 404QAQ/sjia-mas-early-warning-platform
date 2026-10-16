import { describe, expect, it } from 'vitest';
import { decideDeliveryTiming, validateDeliveryTimingPolicy } from '../src/delivery-timing.js';
import type { DeliveryTimingPolicy } from '../src/delivery-timing.js';

const policy = (patch: Partial<DeliveryTimingPolicy> = {}): DeliveryTimingPolicy => ({
  orgUnitId: 'rheumatology', version: 1, timeZone: 'Asia/Shanghai',
  weeklyWindows: Object.fromEntries(['1', '2', '3', '4', '5'].map(day => [day, [{ start: '08:00', end: '18:00' }]])),
  dateOverrides: [], batchMinutes: 15, approval: 'ENGINEERING_DRAFT', effectiveFrom: '2026-01-01T00:00:00Z', ...patch,
});
const decide = (level: 'L1' | 'L2' | 'L3' | 'CRISIS', at: string, data = policy(), queued = at, deadline?: string) => decideDeliveryTiming(data, level, queued, at, deadline);

describe('通知日历不改变临床时限与告警', () => {
  it('未配置、未生效、到期明确即时，不虚构医院日历', () => {
    const at = '2026-10-04T12:00:00Z';
    expect(decideDeliveryTiming(undefined, 'L1', at, at)).toMatchObject({ mode: 'IMMEDIATE', reason: 'NO_DELIVERY_POLICY', policyVersion: null });
    expect(decide('L1', at, policy({ effectiveFrom: '2026-10-05T00:00:00Z' }))).toMatchObject({ mode: 'IMMEDIATE', reason: 'POLICY_NOT_YET_EFFECTIVE', policyVersion: 1 });
    expect(decide('L1', at, policy({ effectiveUntil: at }))).toMatchObject({ mode: 'IMMEDIATE', reason: 'POLICY_EXPIRED' });
  });
  it('L3与危机在周末/全闭假日也立即绕过降噪', () => {
    const data = policy({ weeklyWindows: {}, dateOverrides: [{ date: '2026-10-04', kind: 'HOLIDAY', windows: [] }] });
    for (const level of ['L3', 'CRISIS'] as const) expect(decide(level, '2026-10-04T15:00:00Z', data)).toMatchObject({ mode: 'IMMEDIATE', reason: 'URGENT_BYPASS' });
  });
  it('工作窗口为[start,end)，主机时区不参与判断', () => {
    expect(decide('L1', '2026-10-05T00:00:00Z')).toMatchObject({ mode: 'IMMEDIATE', reason: 'WORKING_WINDOW', windowEnd: '2026-10-05T10:00:00.000Z' });
    expect(decide('L2', '2026-10-05T09:59:59.999Z').mode).toBe('IMMEDIATE');
    expect(decide('L1', '2026-10-05T10:00:00Z')).toMatchObject({ mode: 'DEFERRED', eligibleAt: '2026-10-06T00:00:00.000Z' });
  });
  it('周末L1保留至下个真实工作日；未声明假日不能猜测休假', () => {
    expect(decide('L1', '2026-10-04T12:00:00Z')).toMatchObject({ mode: 'DEFERRED', eligibleAt: '2026-10-05T00:00:00.000Z' });
    const data = policy({ dateOverrides: [{ date: '2026-10-05', kind: 'HOLIDAY', windows: [] }] });
    expect(decide('L1', '2026-10-04T12:00:00Z', data).eligibleAt).toBe('2026-10-06T00:00:00.000Z');
    const adjusted = policy({ dateOverrides: [{ date: '2026-10-04', kind: 'WORKDAY', windows: [{ start: '08:00', end: '18:00' }] }] });
    expect(decide('L1', '2026-10-04T01:00:00Z', adjusted).mode).toBe('IMMEDIATE');
  });
  it('L1的释放必须重新看now，错过窗口不会拿旧开工时间当允许发送', () => {
    const queued = '2026-10-04T12:00:00Z';
    expect(decide('L1', '2026-10-05T11:00:00Z', policy(), queued).eligibleAt).toBe('2026-10-06T00:00:00.000Z');
  });
  it('没有未来窗口可返回null；有限期策略不把到期后窗口伪装为工时', () => {
    expect(decide('L1', '2026-10-04T12:00:00Z', policy({ weeklyWindows: {} }))).toMatchObject({ mode: 'DEFERRED', reason: 'NO_FUTURE_WORKING_WINDOW', eligibleAt: null });
    expect(decide('L1', '2026-10-04T12:00:00Z', policy({ effectiveUntil: '2026-10-04T13:00:00Z' })).eligibleAt).toBeNull();
  });
  it('只配置远期例外工作日也能直接找到，不逐分钟搜索一年', () => {
    const data = policy({ weeklyWindows: {}, dateOverrides: [{ date: '2029-02-28', kind: 'WORKDAY', windows: [{ start: '09:00', end: '10:00' }] }] });
    expect(decide('L1', '2026-10-04T12:00:00Z', data).eligibleAt).toBe('2029-02-28T01:00:00.000Z');
  });
  it('周期工作日被连续日期覆盖时跳到第一个未覆盖周期', () => {
    const data = policy({ weeklyWindows: { '1': [{ start: '08:00', end: '09:00' }] }, dateOverrides: [
      { date: '2026-10-05', kind: 'HOLIDAY', windows: [] }, { date: '2026-10-12', kind: 'HOLIDAY', windows: [] },
    ] });
    expect(decide('L1', '2026-10-04T12:00:00Z', data).eligibleAt).toBe('2026-10-19T00:00:00.000Z');
  });
  it('跨午夜窗口按开始日归属，全闭假日午夜截断前日spill', () => {
    const data = policy({ weeklyWindows: { '1': [{ start: '20:00', end: '06:00' }] } });
    expect(decide('L1', '2026-10-05T18:00:00Z', data)).toMatchObject({ mode: 'IMMEDIATE', windowEnd: '2026-10-05T22:00:00.000Z' });
    const holiday = { ...data, dateOverrides: [{ date: '2026-10-06', kind: 'HOLIDAY' as const, windows: [] }] };
    expect(decide('L1', '2026-10-05T15:59:59Z', holiday).windowEnd).toBe('2026-10-05T16:00:00.000Z');
    expect(decide('L1', '2026-10-05T16:00:00Z', holiday)).toMatchObject({ mode: 'DEFERRED', eligibleAt: '2026-10-12T12:00:00.000Z' });
  });
  it('24:00表示真实日末，重叠窗口形成连续工时', () => {
    const data = policy({ weeklyWindows: { '1': [{ start: '00:00', end: '12:00' }, { start: '11:00', end: '24:00' }] } });
    expect(decide('L1', '2026-10-05T03:00:00Z', data).windowEnd).toBe('2026-10-05T16:00:00.000Z');
  });
});

describe('L2固定批次与SLA边界', () => {
  it('同一网格内告警相同边界，重复扫描不会延后', () => {
    const queued = '2026-10-04T12:02:00Z';
    for (const now of [queued, '2026-10-04T12:14:59Z', '2026-10-04T12:31:00Z']) {
      expect(decide('L2', now, policy(), queued)).toMatchObject({ mode: 'BATCH', reason: 'NON_WORKING_BATCH', eligibleAt: '2026-10-04T12:15:00.000Z', windowEnd: '2026-10-04T12:15:00.000Z' });
    }
    expect(decide('L2', '2026-10-04T12:07:00Z').eligibleAt).toBe('2026-10-04T12:15:00.000Z');
    expect(decide('L2', '2026-10-04T12:15:00Z').eligibleAt).toBe('2026-10-04T12:30:00.000Z');
  });
  it('响应截止比批次早时截断，过期截止也不顺延', () => {
    const queued = '2026-10-04T12:02:00Z', deadline = '2026-10-04T12:04:00Z';
    for (const now of [queued, '2026-10-04T12:20:00Z']) expect(decide('L2', now, policy(), queued, deadline)).toMatchObject({ reason: 'RESPONSE_DEADLINE', eligibleAt: '2026-10-04T12:04:00.000Z', windowEnd: '2026-10-04T12:15:00.000Z' });
  });
  it('开工或策略结束可提前释放，但都以queuedAt固定计算', () => {
    const data = policy({ weeklyWindows: { '1': [{ start: '08:07', end: '18:00' }] } });
    expect(decide('L2', '2026-10-05T00:02:00Z', data)).toMatchObject({ reason: 'NEXT_WORKING_WINDOW', eligibleAt: '2026-10-05T00:07:00.000Z' });
    expect(decide('L2', '2026-10-05T00:08:00Z', data, '2026-10-05T00:02:00Z').mode).toBe('IMMEDIATE');
    expect(decide('L2', '2026-10-04T12:02:00Z', policy({ effectiveUntil: '2026-10-04T12:04:00Z' }))).toMatchObject({ reason: 'POLICY_END', eligibleAt: '2026-10-04T12:04:00.000Z' });
  });
  it('不能整除一天的批次在本地午夜重新锚定', () => {
    expect(decide('L2', '2026-10-04T15:59:00Z', policy({ batchMinutes: 17, weeklyWindows: {} })).eligibleAt).toBe('2026-10-04T16:00:00.000Z');
  });
});

describe('IANA时区转换与DST实际时间', () => {
  it('春季不存在的开工时间跳到首个真实窗口片段', () => {
    const data = policy({ timeZone: 'America/New_York', weeklyWindows: { '7': [{ start: '02:30', end: '03:30' }] } });
    expect(decide('L1', '2026-03-08T06:59:00Z', data)).toMatchObject({ eligibleAt: '2026-03-08T07:00:00.000Z', windowEnd: '2026-03-08T07:30:00.000Z' });
    expect(decide('L1', '2026-03-08T07:00:00Z', data).mode).toBe('IMMEDIATE');
    const gapOnly = policy({ timeZone: 'America/New_York', weeklyWindows: { '7': [{ start: '02:10', end: '02:40' }] } });
    expect(decide('L1', '2026-03-08T06:59:00Z', gapOnly).eligibleAt).toBe('2026-03-15T06:10:00.000Z');
    expect(decide('L1', '2026-03-07T12:00:00Z', gapOnly).eligibleAt).toBe('2026-03-15T06:10:00.000Z');
  });
  it('秋季重复小时保留两个真实工作片段，不把中间间隙算成工时', () => {
    const data = policy({ timeZone: 'America/New_York', weeklyWindows: { '7': [{ start: '01:15', end: '01:45' }] } });
    expect(decide('L1', '2026-11-01T05:30:00Z', data).mode).toBe('IMMEDIATE');
    expect(decide('L1', '2026-11-01T05:50:00Z', data)).toMatchObject({ mode: 'DEFERRED', eligibleAt: '2026-11-01T06:15:00.000Z' });
    expect(decide('L1', '2026-11-01T06:30:00Z', data).mode).toBe('IMMEDIATE');
  });
  it('批次越过春季缺失时刻，秋季回拨则用下一真实网格边界', () => {
    const data = policy({ timeZone: 'America/New_York', weeklyWindows: {} });
    expect(decide('L2', '2026-03-08T06:58:00Z', data).eligibleAt).toBe('2026-03-08T07:00:00.000Z');
    expect(decide('L2', '2026-11-01T05:58:00Z', data).eligibleAt).toBe('2026-11-01T06:00:00.000Z');
    expect(decide('L2', '2026-11-01T06:08:00Z', data).eligibleAt).toBe('2026-11-01T06:15:00.000Z');
  });
  it('半小时DST跳变也正确，不假定所有时区跳一小时', () => {
    const data = policy({ timeZone: 'Australia/Lord_Howe', weeklyWindows: { '7': [{ start: '02:15', end: '03:00' }] } });
    expect(decide('L1', '2026-10-03T15:29:00Z', data)).toMatchObject({ eligibleAt: '2026-10-03T15:30:00.000Z', windowEnd: '2026-10-03T16:00:00.000Z' });
  });
  it('跨国际日期变更线跳过的整天不会产生虚假的工作窗口', () => {
    const data = policy({ timeZone: 'Pacific/Apia', effectiveFrom: '2011-01-01T00:00:00Z', weeklyWindows: {}, dateOverrides: [
      { date: '2011-12-30', kind: 'WORKDAY', windows: [{ start: '08:00', end: '10:00' }] },
      { date: '2011-12-31', kind: 'WORKDAY', windows: [{ start: '08:00', end: '10:00' }] },
    ] });
    expect(decide('L1', '2011-12-30T09:00:00Z', data).eligibleAt).toBe('2011-12-30T18:00:00.000Z');
  });
  it('带偏移ISO时间与Z写法得到相同绝对决策', () => {
    expect(decide('L2', '2026-10-04T20:02:00+08:00')).toEqual(decide('L2', '2026-10-04T12:02:00Z'));
  });
});

describe('策略输入严格校验', () => {
  it.each([
    null, [], {}, { ...policy(), unexpected: true }, { ...policy(), version: 0 }, { ...policy(), version: 1.5 },
    { ...policy(), orgUnitId: '' }, { ...policy(), timeZone: 'Mars/Olympus' }, { ...policy(), timeZone: '+08:00' },
    { ...policy(), weeklyWindows: null }, { ...policy(), weeklyWindows: { '0': [] } },
    { ...policy(), weeklyWindows: { '1': [{ start: '8:00', end: '18:00' }] } },
    { ...policy(), weeklyWindows: { '1': [{ start: '08:00', end: '24:01' }] } },
    { ...policy(), weeklyWindows: { '1': [{ start: '24:00', end: '06:00' }] } },
    { ...policy(), weeklyWindows: { '1': [{ start: '08:00', end: '08:00' }] } },
    { ...policy(), weeklyWindows: { '1': Array.from({ length: 9 }, () => ({ start: '08:00', end: '09:00' })) } },
    { ...policy(), dateOverrides: [{ date: '2026-02-29', kind: 'HOLIDAY', windows: [] }] },
    { ...policy(), dateOverrides: [{ date: '2026-10-04', kind: 'UNKNOWN', windows: [] }] },
    { ...policy(), dateOverrides: Array.from({ length: 2 }, () => ({ date: '2026-10-04', kind: 'HOLIDAY', windows: [] })) },
    { ...policy(), batchMinutes: 0 }, { ...policy(), batchMinutes: 1.5 }, { ...policy(), batchMinutes: 1441 },
    { ...policy(), approval: 'APPROVED' }, { ...policy(), effectiveFrom: '2026-02-30T00:00:00Z' },
    { ...policy(), effectiveFrom: '2026-10-04T00:00:00' }, { ...policy(), effectiveUntil: '2025-01-01T00:00:00Z' },
  ])('拒绝畸形或含未知字段的运行时输入：%j', value => {
    expect(() => validateDeliveryTimingPolicy(value as DeliveryTimingPolicy)).toThrow();
  });
  it('决策也校验时间与级别；不借null策略掩盖坏输入', () => {
    expect(() => decideDeliveryTiming(null as unknown as DeliveryTimingPolicy, 'L1', '2026-10-04T12:00:00Z', '2026-10-04T12:00:00Z')).toThrow();
    expect(() => decideDeliveryTiming(undefined, 'L1', 'bad', '2026-10-04T12:00:00Z')).toThrow();
    expect(() => decideDeliveryTiming(undefined, 'L4' as 'L1', '2026-10-04T12:00:00Z', '2026-10-04T12:00:00Z')).toThrow();
  });
  it('决策不改变调用方策略', () => {
    const data = policy(), original = structuredClone(data);
    decide('L2', '2026-10-04T12:02:00Z', data);
    expect(data).toEqual(original);
  });
});
