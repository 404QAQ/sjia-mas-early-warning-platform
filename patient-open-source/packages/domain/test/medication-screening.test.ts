import { describe, expect, it } from 'vitest';
import {
  addScreeningMonths,
  evaluateMedicationScreening,
  extendMedicationScreening,
  medicationScreeningDefinitions,
  recordMedicationScreening,
} from '../src/index.js';

const base = {
  patientId: 'patient-demo',
  type: 'OPHTHALMOLOGY' as const,
  intervalMonths: 6,
  dueAt: '2026-10-10T00:00:00.000Z',
};

describe('M-05 周期筛查清单', () => {
  it('固定五类筛查，且缓解期仍保持筛查优先级', () => {
    expect(medicationScreeningDefinitions()).toHaveLength(5);
    expect(evaluateMedicationScreening(base, '2026-09-01T00:00:00.000Z')).toEqual({ status: 'OK', daysUntilDue: 39, priority: 'MAINTAINED' });
    expect(evaluateMedicationScreening(base, '2026-10-01T00:00:00.000Z')).toEqual({ status: 'DUE_SOON', daysUntilDue: 9, priority: 'MAINTAINED' });
    expect(evaluateMedicationScreening(base, '2026-10-11T00:00:00.000Z')).toEqual({ status: 'OVERDUE', daysUntilDue: -1, priority: 'MAINTAINED' });
    expect(evaluateMedicationScreening(base, '2026-10-10T01:00:00.000Z')).toEqual({ status: 'OVERDUE', daysUntilDue: -1, priority: 'MAINTAINED' });
  });

  it('按公历月计算下次日期，月底不会滚到错误月份', () => {
    expect(addScreeningMonths('2026-01-31T08:00:00.000Z', 1)).toBe('2026-02-28T08:00:00.000Z');
    const completed = recordMedicationScreening(base, '2026-10-10T00:00:00.000Z', '某人民医院');
    expect(completed).toMatchObject({
      lastDoneAt: '2026-10-10T00:00:00.000Z',
      doneAtFacility: '某人民医院',
      dueAt: '2027-04-10T00:00:00.000Z',
      status: 'DONE',
    });
    expect(evaluateMedicationScreening(completed, '2027-03-15T00:00:00.000Z')).toEqual({ status: 'DUE_SOON', daysUntilDue: 26, priority: 'MAINTAINED' });
    expect(evaluateMedicationScreening(completed, '2027-04-11T00:00:00.000Z').status).toBe('OVERDUE');
    expect(() => recordMedicationScreening(completed, '2026-10-09T00:00:00.000Z', '另一家医院')).toThrow(/不能早于最近一次/);
  });

  it('延期必须留下临床操作者和理由，不能由空字段或提前日期绕过', () => {
    expect(() => extendMedicationScreening(base, '2026-10-20T00:00:00.000Z', '', '理由', '2026-09-01T00:00:00.000Z')).toThrow(/操作者/);
    expect(() => extendMedicationScreening(base, '2026-10-01T00:00:00.000Z', 'doctor-1', '理由', '2026-09-01T00:00:00.000Z')).toThrow(/晚于原日期/);
    expect(extendMedicationScreening(base, '2026-10-20T00:00:00.000Z', 'doctor-1', '停激素后经评估调整', '2026-09-01T00:00:00.000Z')).toMatchObject({
      extendedByClinician: true,
      extendedBy: 'doctor-1',
      extensionReason: '停激素后经评估调整',
    });
  });
});
