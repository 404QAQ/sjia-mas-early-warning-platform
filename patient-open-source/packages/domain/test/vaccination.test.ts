import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INACTIVATED_VACCINES,
  DEFAULT_LIVE_ATTENUATED_VACCINES,
  buildVaccinationSchedule,
  isInfluenzaVaccineName,
  isVaccinationSchedule,
} from '../src/vaccination.js';

const at = '2026-10-05T00:00:00.000Z';

describe('L-03 疫苗领域规则', () => {
  it('免疫抑制状态未知时不输出任何疫苗分类', () => {
    const schedule = buildVaccinationSchedule({ patientId: 'p1', asOf: at, medicationPlans: [], records: [], householdMembers: [] });
    expect(schedule.immunosuppressionStateRef.status).toBe('UNKNOWN');
    expect(schedule.liveAttenuated.classification).toBe('UNKNOWN');
    expect(schedule.liveAttenuated.blocked).toBe(false);
    expect(schedule.liveAttenuated.vaccines).toEqual([]);
    expect(schedule.inactivated).toEqual([]);
    expect(schedule.spacingRules).toEqual([]);
    expect(schedule.message).toContain('需要先确认当前用药');
    expect(isVaccinationSchedule(schedule)).toBe(true);
  });

  it('有免疫抑制用药时，减毒活疫苗固定为 BLOCKED，并返回可复核的年度流感窗口', () => {
    const schedule = buildVaccinationSchedule({
      patientId: 'p1', asOf: at,
      medicationPlans: [{ kind: 'STEROID', drug: '泼尼松', status: 'ACTIVE', startedAt: '2026-01-01T00:00:00.000Z' }],
      records: [{ id: 'r1', patientId: 'p1', vaccine: '流感', administeredAt: '2026-09-01T00:00:00.000Z', facility: '医院', source: 'CLINICIAN', recordedAt: at, recordedBy: 'doctor' }],
      householdMembers: [],
    });
    expect(schedule.liveAttenuated.classification).toBe('BLOCKED');
    expect(schedule.liveAttenuated.blocked).toBe(true);
    expect(schedule.liveAttenuated.vaccines).toEqual(DEFAULT_LIVE_ATTENUATED_VACCINES);
    expect(schedule.inactivated.map(item => item.vaccine)).toEqual(DEFAULT_INACTIVATED_VACCINES);
    expect(schedule.inactivated.every(item => item.classification === 'INACTIVATED' && item.sourceRef.length > 0)).toBe(true);
    expect(schedule.annualInfluenza).toMatchObject({
      vaccine: 'INFLUENZA', localYear: 2026, status: 'CURRENT_YEAR_RECORDED',
      window: { from: '2026-09-01', to: '2026-10-31', reminderFrom: '2026-08-01' },
      lastRecord: { id: 'r1', administeredAt: '2026-09-01T00:00:00.000Z', facility: '医院' },
    });
    for (const item of schedule.inactivated.filter(item => item.vaccine !== '流感')) {
      expect(Object.keys(item).sort()).toEqual(['classification', 'sourceRef', 'vaccine']);
    }
  });

  it('没有流感记录时仍给出当前年度知识窗口，不伪造上次接种时间', () => {
    const schedule = buildVaccinationSchedule({
      patientId: 'p1', asOf: at,
      medicationPlans: [{ kind: 'STEROID', drug: '泼尼松', status: 'ACTIVE', startedAt: '2026-01-01T00:00:00.000Z' }],
      records: [], householdMembers: [],
    });
    expect(schedule.annualInfluenza).toMatchObject({
      localYear: 2026, status: 'WINDOW_OPEN',
      window: { from: '2026-09-01', to: '2026-10-31', reminderFrom: '2026-08-01' },
    });
    expect(schedule.annualInfluenza.lastRecord).toBeUndefined();
  });

  it('生物制剂只生成未定天数的待医生核对间隔，不伪造医学数值', () => {
    const schedule = buildVaccinationSchedule({
      patientId: 'p1', asOf: at,
      medicationPlans: [{ kind: 'BIOLOGIC', drug: '托珠单抗', status: 'ACTIVE', startedAt: '2026-01-01T00:00:00.000Z' }],
      records: [], householdMembers: [],
    });
    expect(schedule.spacingRules).toHaveLength(1);
    expect(schedule.spacingRules[0]).toMatchObject({ vaccine: '灭活疫苗', biologicalAgent: '托珠单抗', minIntervalDays: null });
    expect(schedule.spacingRules[0]?.sourceRef).toBeTruthy();
  });

  it('家庭成员是独立、可选的确认清单，成员完成状态不影响患者分类', () => {
    const schedule = buildVaccinationSchedule({
      patientId: 'p1', asOf: at,
      medicationPlans: [{ kind: 'STEROID', drug: '泼尼松', status: 'ACTIVE', startedAt: '2026-01-01T00:00:00.000Z' }],
      records: [], householdMembers: [{ relation: '爸爸', vaccines: [{ name: '流感', done: false }] }],
    });
    expect(schedule.householdMembers).toEqual([{ relation: '爸爸', vaccines: [{ name: '流感', done: false }] }]);
    expect(schedule.liveAttenuated.classification).toBe('BLOCKED');
  });

  it('成人模式增加成人疫苗，仍不输出自动接种建议', () => {
    const schedule = buildVaccinationSchedule({
      patientId: 'p1', asOf: at, adult: true,
      medicationPlans: [{ kind: 'STEROID', drug: '泼尼松', status: 'ACTIVE', startedAt: '2026-01-01T00:00:00.000Z' }],
      records: [], householdMembers: [],
    });
    expect(schedule.inactivated.map(item => item.vaccine)).toContain('带状疱疹');
    expect(schedule.inactivated.map(item => item.vaccine)).toContain('HPV');
    expect(JSON.stringify(schedule)).not.toMatch(/应该|建议去接种|recommend/i);
  });

  it('按上海本地日历判断年度窗口，并覆盖 UTC 跨日边界', () => {
    const medicationPlans = [{ kind: 'STEROID' as const, drug: '泼尼松', status: 'ACTIVE' as const, startedAt: '2026-01-01T00:00:00.000Z' }];
    const at = (asOf: string) => buildVaccinationSchedule({ patientId: 'p1', asOf, medicationPlans, records: [], householdMembers: [] }).annualInfluenza.status;
    expect(at('2026-07-31T15:59:59.999Z')).toBe('NEXT_WINDOW');
    expect(at('2026-07-31T16:00:00.000Z')).toBe('WINDOW_APPROACHING');
    expect(at('2026-08-31T15:59:59.999Z')).toBe('WINDOW_APPROACHING');
    expect(at('2026-08-31T16:00:00.000Z')).toBe('WINDOW_OPEN');
    expect(at('2026-10-31T15:59:59.999Z')).toBe('WINDOW_OPEN');
    expect(at('2026-10-31T16:00:00.000Z')).toBe('WINDOW_PASSED');
  });

  it('按上海本地年份识别记录，忽略 asOf 之后的未来事实', () => {
    const medicationPlans = [{ kind: 'STEROID' as const, drug: '泼尼松', status: 'ACTIVE' as const, startedAt: '2026-01-01T00:00:00.000Z' }];
    const records = [
      { id: 'future', patientId: 'p1', vaccine: '四价流感疫苗', administeredAt: '2026-09-02T00:00:00.000Z', facility: '未来医院', source: 'CLINICIAN' as const, recordedAt: '2026-09-02T00:00:00.000Z', recordedBy: 'doctor' },
      { id: 'late-record', patientId: 'p1', vaccine: '流感', administeredAt: '2026-08-01T00:00:00.000Z', facility: '未来医院', source: 'CLINICIAN' as const, recordedAt: '2026-09-02T00:00:00.000Z', recordedBy: 'doctor' },
      { id: 'prior', patientId: 'p1', vaccine: 'influenza vaccine', administeredAt: '2025-10-01T00:00:00.000Z', facility: '医院', source: 'PATIENT' as const, recordedAt: '2026-08-01T00:00:00.000Z', recordedBy: 'patient' },
    ];
    const schedule = buildVaccinationSchedule({ patientId: 'p1', asOf: '2026-09-01T00:00:00.000Z', medicationPlans, records, householdMembers: [] });
    expect(schedule.annualInfluenza.status).toBe('WINDOW_OPEN');
    expect(schedule.annualInfluenza.lastRecord?.id).toBe('prior');
    expect(schedule.annualInfluenza.lastRecord?.administeredAt).toBe('2025-10-01T00:00:00.000Z');
    expect(schedule.records.map(record => record.id)).toEqual(['prior']);
  });

  it('规范化常见流感名称，但不把任意含流感文本当成事实', () => {
    for (const value of ['流感', '流感疫苗', '四价流感疫苗', '三价流感', 'influenza vaccine', 'FLU']) {
      expect(isInfluenzaVaccineName(value)).toBe(true);
    }
    for (const value of ['流感样疾病', '流感相关检查', '新冠疫苗', '肺炎链球菌']) {
      expect(isInfluenzaVaccineName(value)).toBe(false);
    }
  });

  it('年度状态在免疫抑制状态未知时保持 UNKNOWN，不渲染分类', () => {
    const schedule = buildVaccinationSchedule({
      patientId: 'p1', asOf: at, medicationPlans: [], householdMembers: [],
      records: [{ id: 'r1', patientId: 'p1', vaccine: '流感', administeredAt: '2026-09-01T00:00:00.000Z', facility: '医院', source: 'CLINICIAN', recordedAt: at, recordedBy: 'doctor' }],
    });
    expect(schedule.annualInfluenza.status).toBe('UNKNOWN');
    expect(schedule.inactivated).toEqual([]);
    expect(isVaccinationSchedule(schedule)).toBe(true);
  });

  it('严格校验年度流感 DTO，缺失或日期不可能时拒绝', () => {
    const schedule = buildVaccinationSchedule({
      patientId: 'p1', asOf: at,
      medicationPlans: [{ kind: 'STEROID', drug: '泼尼松', status: 'ACTIVE', startedAt: '2026-01-01T00:00:00.000Z' }],
      records: [], householdMembers: [],
    });
    const missing = { ...schedule } as Record<string, unknown>;
    delete missing.annualInfluenza;
    expect(isVaccinationSchedule(missing)).toBe(false);
    const malformed = structuredClone(schedule);
    malformed.annualInfluenza.window.to = '2026-02-31';
    expect(isVaccinationSchedule(malformed)).toBe(false);
  });

  it('拒绝无时区或不存在日历日期，避免 Date.parse 隐式修正', () => {
    expect(() => buildVaccinationSchedule({ patientId: 'p1', asOf: '2026-10-05T00:00:00', medicationPlans: [], records: [], householdMembers: [] })).toThrow('快照时间必须是有效时间');
    expect(() => buildVaccinationSchedule({ patientId: 'p1', asOf: '2026-02-31T00:00:00.000Z', medicationPlans: [], records: [], householdMembers: [] })).toThrow('快照时间必须是有效时间');
    expect(() => buildVaccinationSchedule({
      patientId: 'p1', asOf: at, medicationPlans: [], householdMembers: [],
      records: [{ id: 'bad', patientId: 'p1', vaccine: '流感', administeredAt: '2026-02-31T00:00:00.000Z', facility: '医院', source: 'PATIENT', recordedAt: at, recordedBy: 'patient' }],
    })).toThrow('接种日期必须是有效时间');
  });

  it('拒绝跨患者接种记录，并拒绝未知免疫状态下被伪造的年度分类', () => {
    expect(() => buildVaccinationSchedule({
      patientId: 'p1', asOf: at,
      medicationPlans: [], householdMembers: [],
      records: [{ id: 'r2', patientId: 'p2', vaccine: '流感', administeredAt: '2026-09-01T00:00:00.000Z', facility: '医院', source: 'CLINICIAN', recordedAt: at, recordedBy: 'doctor' }],
    })).toThrow('接种记录患者不匹配');

    const schedule = buildVaccinationSchedule({ patientId: 'p1', asOf: at, medicationPlans: [], records: [], householdMembers: [] });
    const forged = structuredClone(schedule);
    forged.annualInfluenza.status = 'CURRENT_YEAR_RECORDED';
    expect(isVaccinationSchedule(forged)).toBe(false);

    const known = buildVaccinationSchedule({
      patientId: 'p1', asOf: at,
      medicationPlans: [{ kind: 'STEROID', drug: '泼尼松', status: 'ACTIVE', startedAt: '2026-01-01T00:00:00.000Z' }],
      records: [], householdMembers: [],
    });
    const wrongYear = structuredClone(known);
    wrongYear.annualInfluenza.localYear = 2025;
    wrongYear.annualInfluenza.window = { from: '2025-09-01', to: '2025-10-31', reminderFrom: '2025-08-01' };
    expect(isVaccinationSchedule(wrongYear)).toBe(false);
  });
});
