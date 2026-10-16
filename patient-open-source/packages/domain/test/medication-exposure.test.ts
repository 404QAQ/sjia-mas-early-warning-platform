import { describe, expect, it } from 'vitest';
import { buildSteroidExposure, type MedicationLog, type MedicationPlan } from '../src/index.js';

const plan = (id: string, unit: string, frequency: MedicationPlan['frequency'], startedAt: string, status: MedicationPlan['status'] = 'ACTIVE'): MedicationPlan => ({
  id, patientId: 'patient-1', kind: 'STEROID', drug: id === 'plan-g' ? '甲泼尼龙' : '泼尼松', dose: 10, unit, route: 'ORAL', frequency,
  startedAt, schedule: [{ effectiveFrom: startedAt, plannedDose: 10 }], status,
  createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'doctor-1',
});

const log = (id: string, planId: string, takenAt: string, actualDose: number, unit: string): MedicationLog => ({
  id, patientId: 'patient-1', planId, takenAt, actualDose, unit, source: 'PATIENT', administeredBy: 'patient-1', recordedAt: takenAt, idempotencyKey: id,
});

describe('T-04 激素累积暴露', () => {
  it('跨计划合并可换算的实际剂量，并保留每个计划的可追溯构成', () => {
    const result = buildSteroidExposure([
      plan('plan-mg', 'mg', 'DAILY', '2026-01-01T00:00:00.000Z'),
      plan('plan-g', 'g', 'WEEKLY', '2026-02-01T00:00:00.000Z'),
    ], [
      log('dose-1', 'plan-mg', '2026-01-01T09:00:00.000Z', 10, 'mg'),
      log('dose-2', 'plan-mg', '2026-01-02T09:00:00.000Z', 10, 'mg'),
      log('dose-3', 'plan-g', '2026-02-01T09:00:00.000Z', 1, 'g'),
    ], '2026-02-03T00:00:00.000Z');

    // 不同激素的 mg 不能直接视为等效剂量；总量必须 fail-closed，按药物分别展示。
    expect(result.cumulativeDoseMg).toBeNull();
    expect(result.cumulativeDoseByDrugMg).toEqual([
      { drug: '泼尼松', cumulativeDoseMg: 20, logIds: ['dose-1', 'dose-2'] },
      { drug: '甲泼尼龙', cumulativeDoseMg: 1000, logIds: ['dose-3'] },
    ]);
    expect(result.quality).toBe('PARTIAL');
    expect(result.components.map(item => [item.planId, item.actualDoseMg, item.observedLogIds])).toEqual([
      ['plan-g', 1000, ['dose-3']], ['plan-mg', 20, ['dose-1', 'dose-2']],
    ]);
    expect(result.components.find(item => item.planId === 'plan-mg')?.missingDoseCount).toBe(32);
    expect(result.calculation.includedLogIds).toEqual(['dose-1', 'dose-2', 'dose-3']);
  });

  it('单位不可换算或缺少实际记录时显式标记，不伪造累计剂量', () => {
    const result = buildSteroidExposure([
      plan('plan-unknown', 'mg/kg', 'DAILY', '2026-01-01T00:00:00.000Z'),
    ], [log('dose-unknown', 'plan-unknown', '2026-01-01T09:00:00.000Z', 0.5, 'mg/kg')], '2026-01-02T00:00:00.000Z');

    expect(result.cumulativeDoseMg).toBeNull();
    expect(result.quality).toBe('UNKNOWN');
    expect(result.calculation.includedLogIds).toEqual([]);
    expect(result.excludedLogs).toEqual([{ logId: 'dose-unknown', planId: 'plan-unknown', takenAt: '2026-01-01T09:00:00.000Z', unit: 'mg/kg', reason: 'UNSUPPORTED_UNIT' }]);
    expect(result.gaps[0]?.reason).toBe('UNSUPPORTED_UNIT');
  });

  it('不纳入非激素计划、患者外记录和未来记录，且不修改输入', () => {
    const plans = [plan('plan-mg', 'mg', 'AS_NEEDED', '2026-01-01T00:00:00.000Z')];
    const logs = [
      log('future', 'plan-mg', '2026-02-01T00:00:00.000Z', 10, 'mg'),
      log('other-patient', 'plan-mg', '2026-01-01T00:00:00.000Z', 10, 'mg'),
    ];
    logs[1] = { ...logs[1]!, patientId: 'patient-2' };
    const before = structuredClone({ plans, logs });
    const result = buildSteroidExposure(plans, logs, '2026-01-02T00:00:00.000Z');
    expect(result.cumulativeDoseMg).toBeNull();
    expect(result.components[0]?.observedLogIds).toEqual([]);
    expect({ plans, logs }).toEqual(before);
  });

  it('没有用药事实时仍保留请求患者 ID，避免空聚合跨患者歧义', () => {
    const result = buildSteroidExposure([], [], '2026-01-02T00:00:00.000Z', 'patient-2');
    expect(result.patientId).toBe('patient-2');
    expect(result.components).toEqual([]);
  });

  it('暂停/停止计划只计算状态变更前窗口，不把停药后的空白伪装为漏药', () => {
    const stopped = { ...plan('plan-stopped', 'mg', 'DAILY', '2026-01-01T00:00:00.000Z', 'STOPPED'), statusCommands: [{
      patientId: 'patient-1', planId: 'plan-stopped', idempotencyKey: 'stop-1', fromStatus: 'ACTIVE' as const, toStatus: 'STOPPED' as const,
      actorId: 'doctor-1', at: '2026-01-03T00:00:00.000Z',
    }] } as MedicationPlan;
    const result = buildSteroidExposure([stopped], [
      log('before-stop', 'plan-stopped', '2026-01-02T09:00:00.000Z', 10, 'mg'),
      log('after-stop', 'plan-stopped', '2026-01-05T09:00:00.000Z', 10, 'mg'),
    ], '2026-01-10T00:00:00.000Z');
    expect(result.cumulativeDoseMg).toBe(10);
    expect(result.components[0]?.expectedDoseCount).toBe(2);
    expect(result.components[0]?.missingDoseCount).toBe(1);
    expect(result.excludedLogs.some(item => item.logId === 'after-stop' && item.reason === 'AFTER_STATUS_CHANGE')).toBe(true);
    expect(result.steroidMonthsTotal).toBeCloseTo(0.07, 2);
  });

  it('按历史时间读取时，未来的停止命令不会截断停止前的有效窗口', () => {
    const stopped = { ...plan('plan-future-stop', 'mg', 'DAILY', '2026-01-01T00:00:00.000Z', 'STOPPED'), statusCommands: [{
      patientId: 'patient-1', planId: 'plan-future-stop', idempotencyKey: 'stop-future', fromStatus: 'ACTIVE' as const, toStatus: 'STOPPED' as const,
      actorId: 'doctor-1', at: '2026-01-10T00:00:00.000Z',
    }] } as MedicationPlan;
    const result = buildSteroidExposure([stopped], [log('historical-dose', 'plan-future-stop', '2026-01-05T09:00:00.000Z', 10, 'mg')], '2026-01-06T00:00:00.000Z');
    expect(result.steroidMonthsTotal).toBeGreaterThan(0);
    expect(result.excludedLogs).toEqual([]);
  });

  it('未来的暂停→停止命令不能单独证明截面前存在完整激素生命周期', () => {
    const stopped = { ...plan('plan-future-paused-stop', 'mg', 'DAILY', '2026-01-01T00:00:00.000Z', 'STOPPED'), statusCommands: [{
      patientId: 'patient-1', planId: 'plan-future-paused-stop', idempotencyKey: 'stop-future-paused', fromStatus: 'PAUSED' as const, toStatus: 'STOPPED' as const,
      actorId: 'doctor-1', at: '2026-01-10T00:00:00.000Z',
    }] } as MedicationPlan;
    const result = buildSteroidExposure([stopped], [log('historical-dose-paused', 'plan-future-paused-stop', '2026-01-05T09:00:00.000Z', 10, 'mg')], '2026-01-06T00:00:00.000Z');
    expect(result.steroidMonthsTotal).toBeNull();
    expect(result.components[0]?.status).toBe('PAUSED');
    expect(result.gaps[0]?.reason).toBe('LIFECYCLE_UNKNOWN');
  });
});
