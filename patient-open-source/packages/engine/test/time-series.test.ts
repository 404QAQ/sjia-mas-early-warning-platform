import { describe, expect, it } from 'vitest';
import { buildSeries, dailyMaxTemp, seriesOf, windowPoints } from '../src/series.js';
import { InvalidTimeError, toMs } from '../src/time.js';
import { timeSlices } from '../src/backtest.js';
import { fullInput, NOW, patient } from './fixtures.js';
import type { Observation } from '@mas/domain';

const observation = (overrides: Partial<Observation> = {}): Observation => ({
  id: 'obs-test', patientId: patient.id, code: 'TEMP', display: '体温',
  valueNumeric: 39, unit: '℃', observedAt: NOW, recordedAt: NOW,
  source: 'PATIENT_REPORTED', recordedBy: 'self', ...overrides,
});

describe('显式时间与回测边界', () => {
  it.each(['bad', '', '2026-06-12', '2026-06-12T08:00:00', '2026-02-30T00:00:00Z', '2026-06-12T24:00:00Z'])('拒绝非法或未带时区的时间 %s', (value) => {
    expect(() => toMs(value)).toThrow(InvalidTimeError);
  });
  it('不同偏移的同一时刻相等，数字时间必须在 Date 有效范围', () => {
    expect(toMs(NOW)).toBe(toMs('2026-06-12T01:00:00Z'));
    for (const value of [NaN, Infinity, -Infinity, 9e15]) expect(() => toMs(value)).toThrow(InvalidTimeError);
  });
  it.each([0, -1, NaN, Infinity, 1e-20])('空输入仍拒绝非法步长 %s', (step) => {
    expect(() => timeSlices([], step)).toThrow(RangeError);
  });
  it('限制过大的回测区间且拒绝倒置区间', () => {
    expect(() => timeSlices([observation()], 1, '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z')).toThrow(RangeError);
    expect(() => timeSlices([observation()], 6, '2026-06-13T00:00:00Z', '2026-06-12T00:00:00Z')).toThrow(RangeError);
  });
  it('乱序切片包含首尾边界，且不修改原记录', () => {
    const input = [observation({ observedAt: '2026-06-12T12:00:00Z' }), observation({ observedAt: '2026-06-12T00:00:00Z' })];
    const before = JSON.stringify(input);
    expect(timeSlices(input, 6)).toEqual(['2026-06-12T00:00:00.000Z', '2026-06-12T06:00:00.000Z', '2026-06-12T12:00:00.000Z']);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('序列输入和业务日', () => {
  it('同一时刻的不同 ISO 偏移按上海日历归入同一天', () => {
    const observations = [
      observation({ id: 'a', observedAt: '2026-06-11T16:30:00Z', valueNumeric: 38.5 }),
      observation({ id: 'b', observedAt: '2026-06-12T00:30:00+08:00', valueNumeric: 39.2 }),
    ];
    const series = seriesOf(buildSeries(observations), 'TEMP');
    expect(dailyMaxTemp(series, toMs(NOW), 3)).toEqual([{ date: '2026-06-12', value: 39.2 }]);
  });
  it('同一时刻的观测按稳定标识排序，输入乱序不改变最新值', () => {
    const observations = [observation({ id: 'b', valueNumeric: 39.2 }), observation({ id: 'a', valueNumeric: 38.5 })];
    expect(buildSeries(observations)).toEqual(buildSeries([...observations].reverse()));
  });
  it('NO_ALERT 与未确认 OCR 不参与任何序列或活跃时间', () => {
    expect(buildSeries([
      observation({ tags: ['NO_ALERT'] }), observation({ tags: ['OCR_UNVERIFIED'] }),
    ])).toMatchObject({ latestObservedAt: undefined, rejectedTotal: 0, symptoms: [] });
    expect(buildSeries([observation({ tags: ['OCR_UNVERIFIED'] })]).byCode.size).toBe(0);
  });
  it('非法观测时间显式失败，不会静默判为在管', () => {
    expect(() => buildSeries([observation({ observedAt: 'bad' })])).toThrow(InvalidTimeError);
  });
  it('单位与数值不合法的记录不会作为活跃时间兜底', () => {
    const result = buildSeries([observation({ unit: 'K' }), observation({ valueNumeric: NaN })]);
    expect(result.rejectedTotal).toBe(2);
    expect(result.latestObservedAt).toBeUndefined();
    expect(seriesOf(result, 'TEMP')?.points).toEqual([]);
  });
  it('时间窗口左右边界都包含', () => {
    const series = seriesOf(buildSeries(fullInput().observations), 'PLATELET');
    const points = windowPoints(series, toMs('2026-06-12T09:00:00+08:00'), 48);
    expect(points[0]?.value).toBe(210);
    expect(points.at(-1)?.value).toBe(152);
  });
});
