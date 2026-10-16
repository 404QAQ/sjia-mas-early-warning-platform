import { describe, expect, it } from 'vitest';
import { buildMedicationTrajectory, type MedicationLog, type MedicationPlan } from '../src/index.js';

const plan: MedicationPlan = {
  id: 'plan-1', patientId: 'patient-1', kind: 'STEROID', drug: '泼尼松', dose: 10, unit: 'mg', route: 'ORAL', frequency: 'DAILY',
  startedAt: '2026-10-01T00:00:00.000Z',
  schedule: [
    { effectiveFrom: '2026-10-01T00:00:00.000Z', plannedDose: 10 },
    { effectiveFrom: '2026-10-03T00:00:00.000Z', plannedDose: 5 },
  ], status: 'ACTIVE', createdAt: '2026-09-30T00:00:00.000Z', createdBy: 'doctor-1',
};

const log = (id: string, takenAt: string, actualDose: number, patch: Partial<MedicationLog> = {}): MedicationLog => ({
  id, patientId: 'patient-1', planId: 'plan-1', takenAt, actualDose, unit: 'mg', source: 'PATIENT', administeredBy: 'patient-1', recordedAt: takenAt, idempotencyKey: id, ...patch,
});

describe('M-02 用药计划与实际记录双轨轨迹', () => {
  it('按计划生效点和实际记录生成确定性轨迹，不把缺失记录伪造成零剂量', () => {
    const result = buildMedicationTrajectory(plan, [
      log('dose-1', '2026-10-01T09:00:00.000+08:00', 10),
      log('dose-2', '2026-10-02T09:00:00.000+08:00', 10),
      log('dose-3', '2026-10-04T09:00:00.000+08:00', 4),
      log('future', '2026-10-06T09:00:00.000+08:00', 5),
      log('other-plan', '2026-10-02T10:00:00.000+08:00', 5, { planId: 'other' }),
    ], '2026-10-05T00:00:00.000Z');

    expect(result.map(point => [point.kind, point.at, point.plannedDose, point.actualDose, point.comparison])).toEqual([
      ['PLAN', '2026-10-01T00:00:00.000Z', 10, undefined, 'PLANNED'],
      ['ACTUAL', '2026-10-01T01:00:00.000Z', 10, 10, 'ON_PLAN'],
      ['ACTUAL', '2026-10-02T01:00:00.000Z', 10, 10, 'ON_PLAN'],
      ['PLAN', '2026-10-03T00:00:00.000Z', 5, undefined, 'PLANNED'],
      ['ACTUAL', '2026-10-04T01:00:00.000Z', 5, 4, 'BELOW_PLAN'],
    ]);
    expect(result[4]?.delta).toBe(-1);
  });

  it('提前记录、单位不一致和未来记录显式保留为不可比较点或被时间边界排除', () => {
    const result = buildMedicationTrajectory(plan, [
      log('before', '2026-09-30T09:00:00.000+08:00', 10),
      log('wrong-unit', '2026-10-01T10:00:00.000+08:00', 10, { unit: '片' }),
    ], '2026-10-02T00:00:00.000Z');
    expect(result.map(point => [point.kind, point.comparison, point.plannedDose, point.actualDose])).toEqual([
      ['ACTUAL', 'UNPLANNED', undefined, 10],
      ['PLAN', 'PLANNED', 10, undefined],
      ['ACTUAL', 'UNPLANNED', undefined, 10],
    ]);
  });

  it('不修改输入，按绝对时间排序并保留相同时间的计划与实际两个事实', () => {
    const logs = [log('b', '2026-10-01T09:00:00.000+08:00', 9), log('a', '2026-10-01T09:00:00.000+08:00', 10)];
    const before = structuredClone(logs);
    const result = buildMedicationTrajectory(plan, logs, '2026-10-01T01:00:00.000Z');
    expect(logs).toEqual(before);
    expect(result.map(point => point.kind)).toEqual(['PLAN', 'ACTUAL', 'ACTUAL']);
    expect(result.slice(1).map(point => point.logId)).toEqual(['a', 'b']);
  });
});
