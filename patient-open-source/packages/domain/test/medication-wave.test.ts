import { describe, expect, it } from 'vitest';
import { buildMedicationWave, type MedicationLog, type MedicationPlan, type Observation } from '../src/index.js';

const plan: MedicationPlan = {
  id: 'plan-1', patientId: 'patient-1', kind: 'STEROID', drug: '泼尼松', dose: 10, unit: 'mg', route: 'ORAL', frequency: 'DAILY',
  startedAt: '2026-09-15T00:00:00.000Z', schedule: [{ effectiveFrom: '2026-09-15T00:00:00.000Z', plannedDose: 10 }], status: 'ACTIVE',
  createdAt: '2026-09-14T00:00:00.000Z', createdBy: 'doctor-1',
};

const log = (id: string, takenAt: string, actualDose = 10): MedicationLog => ({
  id, patientId: 'patient-1', planId: 'plan-1', takenAt, actualDose, unit: 'mg', source: 'CAREGIVER', administeredBy: 'caregiver-1', recordedAt: takenAt, idempotencyKey: id,
});

const observation = (id: string, observedAt: string): Observation => ({
  id, patientId: 'patient-1', code: 'TEMP', display: '体温', valueNumeric: 38.2, unit: '℃', observedAt, recordedAt: observedAt, source: 'CAREGIVER_REPORTED', recordedBy: 'caregiver-1',
});

describe('M-02 用药与波动共享 14 日投影', () => {
  it('固定返回 asOf 所在日向前 14 个上海业务日，并对齐观测、计划和实际记录', () => {
    const result = buildMedicationWave({
      patientId: 'patient-1', asOf: '2026-10-03T12:00:00.000Z', plans: [plan],
      logs: [log('ok', '2026-10-03T01:00:00.000Z'), log('low', '2026-10-02T01:00:00.000Z', 5), log('future', '2026-10-04T01:00:00.000Z')],
      observations: [observation('temp', '2026-10-02T02:00:00.000Z'), observation('future-observation', '2026-10-04T02:00:00.000Z')],
    });
    expect(result.range).toEqual({ from: '2026-09-20', to: '2026-10-03', days: 14 });
    expect(result.days).toHaveLength(14);
    expect(result.days.at(-1)).toMatchObject({ date: '2026-10-03', planned: [{ plannedDose: 10 }], actual: [{ actualDose: 10 }], relationHints: [{ kind: 'ON_PLAN' }] });
    expect(result.days.at(-2)).toMatchObject({ date: '2026-10-02', observations: [{ id: 'temp' }], relationHints: [{ kind: 'BELOW_PLAN' }] });
    expect(result.days.flatMap(day => day.actual).map(item => item.logId)).not.toContain('future');
    expect(result.days.flatMap(day => day.observations).map(item => item.id)).not.toContain('future-observation');
  });

  it('计划日没有实际记录时明确提示漏记，按需用药不虚构计划剂量', () => {
    const asNeeded: MedicationPlan = { ...plan, id: 'plan-prn', drug: '退热药', frequency: 'AS_NEEDED' };
    const result = buildMedicationWave({ patientId: 'patient-1', asOf: '2026-10-03T12:00:00.000Z', plans: [asNeeded], logs: [{ ...log('prn', '2026-10-02T01:00:00.000Z'), planId: 'plan-prn' }], observations: [] });
    expect(result.days.at(-2)?.planned).toEqual([]);
    expect(result.days.at(-2)?.relationHints).toEqual([{ kind: 'AS_NEEDED', text: '当天记录为按需用药', planId: 'plan-prn' }]);
  });

  it('快照包含停药前的历史事实，但不把停药后的日期虚构为计划剂量', () => {
    const result = buildMedicationWave({
      patientId: 'patient-1', asOf: '2026-10-03T12:00:00.000Z', plans: [plan], logs: [], observations: [],
      planEndAt: { 'plan-1': '2026-10-02T00:00:00.000Z' },
    });
    expect(result.days.find(day => day.date === '2026-10-01')?.planned).toHaveLength(1);
    expect(result.days.find(day => day.date === '2026-10-02')?.planned).toEqual([]);
  });

  it('同一计划日有多条实际记录时保留每条与计划的关系提示', () => {
    const result = buildMedicationWave({
      patientId: 'patient-1', asOf: '2026-10-03T12:00:00.000Z', plans: [plan],
      logs: [log('first', '2026-10-03T01:00:00.000Z', 10), log('second', '2026-10-03T02:00:00.000Z', 5)], observations: [],
    });
    expect(result.days.at(-1)?.relationHints.map(item => item.kind)).toEqual(['ON_PLAN', 'BELOW_PLAN']);
  });
});
