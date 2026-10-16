import { describe, expect, it } from 'vitest';
import { summarizeInjectionSites, validateMedicationInjection, type MedicationLog } from '../src/index.js';

const at = '2026-10-04T00:00:00.000Z';
const injection = { route: 'SC_INJECTION' as const };
const oral = { route: 'ORAL' as const };
const log = (id: string, takenAt: string, injectionSite: MedicationLog['injectionSite']): MedicationLog => ({
  id, patientId: 'p1', planId: 'plan-1', takenAt, actualDose: 8, unit: 'mg', source: 'PATIENT', administeredBy: 'actor', recordedAt: takenAt, idempotencyKey: id, injectionSite,
});

describe('M-03 皮下注射四象限与冷链记录', () => {
  it('只允许皮下注射计划，要求四象限与注射人，并保留冷链事实而不判定可用性', () => {
    const value = validateMedicationInjection(injection, {
      injectionSite: 'LUQ', injectionAdministeredBy: 'SELF',
      coldChainEvent: { type: 'UNREFRIGERATED', durationHours: 3, reportedAt: at },
    }, at, at);
    expect(value).toEqual({ injectionSite: 'LUQ', injectionAdministeredBy: 'SELF', coldChainEvent: { type: 'UNREFRIGERATED', durationHours: 3, reportedAt: at } });
    expect(value).not.toHaveProperty('usable');
    expect(() => validateMedicationInjection(oral, value, at, at)).toThrow(/非皮下注射/);
    expect(() => validateMedicationInjection(injection, { injectionSite: 'CENTER' as never, injectionAdministeredBy: 'SELF' }, at, at)).toThrow(/合法/);
  });

  it('拒绝未来注射/未来报告、负时长和未知冷链类型，且没有自动补打字段', () => {
    const base = { injectionSite: 'RUQ' as const, injectionAdministeredBy: 'FAMILY' as const };
    expect(() => validateMedicationInjection(injection, base, '2026-10-05T00:00:00.000Z', at)).toThrow(/注射时间/);
    expect(() => validateMedicationInjection(injection, { ...base, coldChainEvent: { type: 'OTHER', durationHours: 1, reportedAt: '2026-10-05T00:00:00.000Z' } }, at, at)).toThrow(/报告时间/);
    expect(() => validateMedicationInjection(injection, { ...base, coldChainEvent: { type: 'OTHER', durationHours: -1, reportedAt: at } }, at, at)).toThrow(/冷链/);
    expect(() => validateMedicationInjection(injection, { ...base, coldChainEvent: { type: 'INVALID' as never, durationHours: 1, reportedAt: at } }, at, at)).toThrow(/冷链/);
    expect(validateMedicationInjection(injection, base, at, at)).not.toHaveProperty('catchUp');
  });

  it('按实际时间取最近注射，计算连续同部位并建议不同象限；跨计划不混入', () => {
    const result = summarizeInjectionSites('plan-1', [
      log('old', '2026-09-01T00:00:00.000Z', 'LLQ'),
      log('newer', '2026-10-02T00:00:00.000Z', 'RUQ'),
      log('latest', '2026-10-03T00:00:00.000Z', 'RUQ'),
      { ...log('other', '2026-10-04T00:00:00.000Z', 'LUQ'), planId: 'other' },
    ]);
    expect(result).toEqual({ lastSite: 'RUQ', suggestedSite: 'LUQ', consecutiveCount: 2 });
    expect(summarizeInjectionSites('missing', [])).toEqual({ consecutiveCount: 0 });
  });
});
