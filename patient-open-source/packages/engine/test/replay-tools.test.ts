import { describe, expect, it } from 'vitest';
import type { Observation, PersonalBaseline } from '@mas/domain';
import { computeBaselines, effectiveBaselineValue } from '../src/baseline.js';
import { sensitivity } from '../src/sensitivity.js';
import { backtest } from '../src/backtest.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { fullInput, NOW, patient } from './fixtures.js';

const obs = (overrides: Partial<Observation> = {}): Observation => ({
  id: 'sample', patientId: patient.id, code: 'FIBRINOGEN', display: '纤维蛋白原', valueNumeric: 3,
  unit: 'g/L', observedAt: NOW, recordedAt: NOW, source: 'LAB', recordedBy: 'doctor', ...overrides,
});
const period = { from: '2026-06-01T00:00:00+08:00', to: '2026-06-13T00:00:00+08:00' };
const baseline = (overrides: Partial<PersonalBaseline> = {}): PersonalBaseline => ({
  patientId: patient.id, code: 'FIBRINOGEN', baselineValue: 3, unit: 'g/L', source: 'CLINICIAN',
  stabilityPeriods: [period], updatedAt: NOW, ...overrides,
});

describe('个性化基线', () => {
  it('统一单位后取中位数，极端值不拉偏且不改输入', () => {
    const observations = [obs({ id: '1', valueNumeric: 2 }), obs({ id: '2', valueNumeric: 300, unit: 'mg/dL' }), obs({ id: '3', valueNumeric: 90 })];
    const original = JSON.stringify(observations);
    expect(computeBaselines(observations, [period])[0]).toMatchObject({ value: 300, unit: 'mg/dL', sampleCount: 3 });
    expect(JSON.stringify(observations)).toBe(original);
  });
  it('少于3个有效点不生成，未确认OCR/私人记录不参与', () => {
    const observations = [obs({ id: '1' }), obs({ id: '2' }), obs({ id: '3', tags: ['OCR_UNVERIFIED'] }), obs({ id: '4', tags: ['NO_ALERT'] })];
    expect(computeBaselines(observations, [period])).toEqual([]);
  });
  it('医生基线优先于系统基线且转换标准单位', () => {
    const values = [baseline(), baseline({ source: 'COMPUTED', baselineValue: 900, unit: 'mg/dL', updatedAt: '2026-06-12T10:00:00+08:00' })];
    expect(effectiveBaselineValue(values, 'FIBRINOGEN')).toBe(300);
  });
  it('非法稳定期或样本数显式拒绝', () => {
    expect(() => computeBaselines([obs()], [period], 0)).toThrow(RangeError);
    expect(() => computeBaselines([obs()], [{ from: period.to, to: period.from }])).toThrow(RangeError);
    expect(() => computeBaselines([obs()], [{ ...period, from: 'bad' }])).toThrow();
  });
});

describe('只读推演', () => {
  it('前进时间只使用原始时刻快照，不能偷看未来症状', () => {
    const input = fullInput({ observations: [obs({ code: 'TEMP', valueNumeric: undefined, valueCoded: 'CNS', unit: 'code', observedAt: '2026-06-12T10:00:00+08:00', recordedAt: '2026-06-12T10:00:00+08:00' })], baseline: [] });
    const result = sensitivity(input, { advanceHours: 2 });
    expect(result.base.riskLevel).toBe('LOW');
    expect(result.simulated.riskLevel).toBe('LOW');
    expect(result.simulated.reasons.some((r) => r.code === 'CNS')).toBe(false);
  });
  it('不改变原始输入，忽略私人记录并修改真实临床最新点', () => {
    const input = fullInput({ observations: [obs(), obs({ id: 'private', valueNumeric: 100, observedAt: '2026-06-12T09:01:00+08:00', tags: ['NO_ALERT'] })], baseline: [] });
    const original = JSON.stringify(input);
    const result = sensitivity(input, { setValue: { code: 'FIBRINOGEN', value: 500, unit: 'mg/dL' } });
    expect(result.base.standard2016.items.find((item) => item.key === 'FIBRINOGEN')?.actual).toBe(300);
    expect(result.simulated.standard2016.items.find((item) => item.key === 'FIBRINOGEN')?.actual).toBe(500);
    expect(JSON.stringify(input)).toBe(original);
  });
  it('不存在的指标与非法参数显式失败，不能生成虚假的“已推演”结论', () => {
    const input = fullInput({ observations: [], baseline: [] });
    expect(() => sensitivity(input, { setValue: { code: 'FIBRINOGEN', value: 500, unit: 'mg/dL' } })).toThrow();
    expect(() => sensitivity(fullInput(), { advanceHours: -1 })).toThrow(RangeError);
    expect(() => sensitivity(fullInput(), { advanceHours: NaN })).toThrow(RangeError);
    expect(() => sensitivity(fullInput(), { adjustPct: { code: 'PLATELET', pct: -2 } })).toThrow(RangeError);
  });
});

describe('历史回测', () => {
  it.each(['__proto__', 'constructor', 'toString'])('配置版本 %s 可以安全通过 JSON 往返', (version) => {
    const cfg = { ...DEFAULT_CONFIG, version };
    const result = backtest([{ patientId: patient.id, observations: [obs()], baseInput: fullInput(), diagnosedAt: NOW }], [cfg]);
    const parsed = JSON.parse(JSON.stringify(result));
    expect(Object.keys(parsed.summary)).toEqual([version]);
    expect(parsed.summary[version].totalAlerts).toBe(0);
    expect(parsed.cases[0].firstAlertAt[version]).toBeNull();
  });
  it('较低敏感度配置始终未检出时输出明确状态，不能返回 Infinity', () => {
    const observations = [300, 290, 200].map((valueNumeric, index) => {
      const at = `2026-06-12T${String(index * 6).padStart(2, '0')}:00:00Z`;
      return obs({ id: String(index), code: 'PLATELET', valueNumeric, unit: '10^9/L', observedAt: at, recordedAt: at });
    });
    const conservative = { ...DEFAULT_CONFIG, version: 'conservative', trend: { ...DEFAULT_CONFIG.trend, plateletDrop48hWarning: .9, plateletDrop48hCritical: .95 } };
    const result = backtest([{ patientId: patient.id, observations, baseInput: fullInput({ baseline: [] }) }], [DEFAULT_CONFIG, conservative]);
    expect(result.summary.conservative?.lateDiscoveries).toEqual([{ patientId: patient.id, status: 'NOT_DETECTED', days: null }]);
    expect(JSON.parse(JSON.stringify(result)).summary.conservative.lateDiscoveries).toEqual(result.summary.conservative?.lateDiscoveries);
  });
  it('空病例结果为空且不能静默接受非法配置/步长', () => {
    expect(backtest([], [DEFAULT_CONFIG]).summary[DEFAULT_CONFIG.version]).toMatchObject({ totalAlerts: 0, patientsAlerted: 0, meanLeadTimeDays: null });
    expect(() => backtest([], [DEFAULT_CONFIG], { stepHours: 0 })).toThrow(RangeError);
    expect(() => backtest([], [DEFAULT_CONFIG, DEFAULT_CONFIG])).toThrow();
  });
  it.each([5, 12])('晚录入的症状在可见之后才预警，默认区间包括 %s 小时后的尾点', (delay) => {
    const recordedAt = `2026-06-12T${String(delay).padStart(2, '0')}:00:00Z`;
    const event = obs({ code: 'TEMP', valueNumeric: undefined, valueCoded: 'CNS', unit: 'code',
      observedAt: '2026-06-12T00:00:00Z', recordedAt });
    const input = fullInput({ baseline: [], observations: [], safetyNet: { patientAcknowledged: false, contactsUnresponsive: false, hasPendingNotification: false, isLivingAlone: false } });
    const diagnosedAt = new Date(Date.parse(recordedAt) + 86_400_000).toISOString();
    const result = backtest([{ patientId: patient.id, observations: [event], baseInput: input, diagnosedAt }], [DEFAULT_CONFIG]);
    expect(result.cases[0]?.firstAlertAt[DEFAULT_CONFIG.version]).toBe(new Date(recordedAt).toISOString());
    expect(result.cases[0]?.leadTimeDays[DEFAULT_CONFIG.version]).toBe(1);
  });
});
