import { describe, expect, it } from 'vitest';
import {
  confirmEmergencyPlan,
  createEmergencyPlan,
  saveEmergencyPlanDraft,
  submitEmergencyPlan,
  type EmergencyPlan,
} from '../src/emergency-plan.js';
import {
  emergencyShareSummary,
  validateEmergencyShare,
  type EmergencyShare,
} from '../src/emergency-share.js';

const T0 = '2026-10-05T02:00:00.000Z';
const T1 = '2026-10-05T02:01:00.000Z';
const T2 = '2026-10-06T02:01:00.000Z';

function confirmedPlan(): EmergencyPlan {
  let plan = createEmergencyPlan('patient-internal-1', 'plan-internal-1', T0);
  plan = saveEmergencyPlanDraft(plan, {
    step: 4,
    locationKey: 'city-shanghai',
    caregiver: {
      primaryHospital: {
        name: '儿童医院',
        address: '人民路 1 号',
        nightEntrance: '东门急诊',
        nightCapable: 'TRUE',
      },
      route: { minutesNight: 20, minutesDay: 35, notes: '沿环城路直行' },
      transport: { primary: 'DRIVE', backup: '120', driverName: '家长' },
    },
  }, 'caregiver-internal-1', T0);
  plan = submitEmergencyPlan(plan, T1, 'caregiver-internal-1');
  return confirmEmergencyPlan(plan, 'clinician-internal-1', {
    nightCapable: 'TRUE',
    triageScript: 'sJIA，有 MAS 风险，正在发热',
    followUpClinicianPhone: '13800000001',
    onCallContact: { label: '值班医师（今晚）', phone: '医院总机转' },
  }, T1);
}

function validShare(): EmergencyShare {
  return {
    code: 'Ab3dEf7',
    patientId: 'patient-internal-1',
    planVersionRef: 3,
    shareToken: 'hmac-token-for-share',
    visibility: 'G2_SUMMARY',
    createdBy: 'caregiver-internal-1',
    createdAt: T1,
    expiresAt: '2026-10-12T02:01:00.000Z',
    recipientsHint: ['GRANDPARENT'],
  };
}

describe('EmergencyShare domain', () => {
  it('从已确认预案生成只含行动信息的简化版摘要', () => {
    const plan = confirmedPlan();
    const summary = emergencyShareSummary(plan, '小明', 'sJIA');

    expect(summary).toMatchObject({
      title: '紧急情况怎么办（简化版）',
      description: '你看到的这一份是简化版，只写了要做的事。',
      patientDisplayName: '小明',
      updatedAt: plan.updatedAt,
      planVersion: plan.version,
      thresholds: [
        '抽搐 / 意识不清 / 叫不醒',
        '持续高热 + 精神明显变差',
        '出血表现（牙龈 / 鼻血不止 / 瘀点）',
        '剧烈头痛 / 呕吐不止',
      ],
      hospitalName: '儿童医院',
      nightEntrance: '东门急诊',
      arrivalMinutesNight: 20,
      triageScript: 'sJIA，有 MAS 风险',
      followUpClinicianPhone: '13800000001',
      neverDo: expect.arrayContaining(['不要自行停激素']),
      canDo: expect.arrayContaining(['少量多次补水']),
    });
  });

  it('拒绝未确认或资料不完整的预案', () => {
    const plan = confirmedPlan();
    expect(() => emergencyShareSummary({ ...plan, status: 'DRAFT', clinician: {} }, '小明')).toThrow(/已确认/);
    expect(() => emergencyShareSummary({ ...plan, caregiver: { ...plan.caregiver, route: undefined } }, '小明')).toThrow(/已确认/);
    expect(() => emergencyShareSummary({ ...plan, clinician: { ...plan.clinician, triageScript: undefined } }, '小明')).toThrow(/已确认/);
  });

  it('裁剪掉患者、预案、告警标识以及化验和完整用药信息', () => {
    const plan = confirmedPlan() as EmergencyPlan & {
      labs: unknown[];
      medicationPlans: unknown[];
      alertId: string;
    };
    plan.labs = [{ ferritin: 10000 }];
    plan.medicationPlans = [{ drug: '内部处方' }];
    plan.alertId = 'alert-internal-1';

    const summary = emergencyShareSummary(plan, '小明');
    expect(Object.keys(summary).sort()).toEqual([
      'arrivalMinutesNight',
      'canDo',
      'description',
      'followUpClinicianPhone',
      'hospitalName',
      'neverDo',
      'nightEntrance',
      'patientDisplayName',
      'planVersion',
      'thresholds',
      'title',
      'triageScript',
      'updatedAt',
    ].sort());
    expect(summary).not.toHaveProperty('patientId');
    expect(summary).not.toHaveProperty('planId');
    expect(summary).not.toHaveProperty('alertId');
    expect(summary).not.toHaveProperty('labs');
    expect(summary).not.toHaveProperty('medicationPlans');
    expect(summary).not.toHaveProperty('history');
  });

  it('医生未确认夜间收治能力时不生成联系人摘要', () => {
    const plan = confirmedPlan();
    expect(() => emergencyShareSummary({ ...plan, clinician: { ...plan.clinician, nightCapable: 'UNKNOWN' } }, '小明')).toThrow(/夜间/);
    expect(() => emergencyShareSummary({ ...plan, clinician: { ...plan.clinician, nightCapable: 'FALSE' } }, '小明')).toThrow(/夜间/);
  });

  it('公开分诊话术不透传含化验或用药细节的医生自由文本', () => {
    const plan = confirmedPlan();
    plan.clinician.triageScript = '铁蛋白 3400，泼尼松每天 5 mg';
    expect(emergencyShareSummary(plan, '小明', 'AOSD').triageScript).toBe('AOSD，有 MAS 风险');
    expect(emergencyShareSummary(plan).triageScript).toBe('有 MAS 风险，请告知急诊医护');
    expect(JSON.stringify(emergencyShareSummary(plan))).not.toMatch(/3400|泼尼松|5 mg/);
  });

  it('读取当前预案版本，旧分享链接无需保存旧快照', () => {
    const original = confirmedPlan();
    const updated = { ...original, version: original.version + 1, updatedAt: T2 };

    expect(emergencyShareSummary(original).planVersion).toBe(original.version);
    expect(emergencyShareSummary(updated).planVersion).toBe(original.version + 1);
    expect(emergencyShareSummary(updated).updatedAt).toBe(T2);
  });

  it('验证分享授权的字段、枚举和时间格式', () => {
    expect(() => validateEmergencyShare(validShare())).not.toThrow();

    expect(() => validateEmergencyShare({ ...validShare(), code: '' })).toThrow(/分享码/);
    expect(() => validateEmergencyShare({ ...validShare(), code: 'bad\ncode' })).toThrow(/分享码/);
    expect(() => validateEmergencyShare({ ...validShare(), visibility: 'FULL' as never })).toThrow(/字段无效/);
    expect(() => validateEmergencyShare({ ...validShare(), planVersionRef: 0 })).toThrow(/字段无效/);
    expect(() => validateEmergencyShare({ ...validShare(), recipientsHint: ['FRIEND', 'FRIEND'] })).toThrow(/分享对象/);
    expect(() => validateEmergencyShare({ ...validShare(), recipientsHint: ['CHILD' as never] })).toThrow(/分享对象/);
    expect(() => validateEmergencyShare({ ...validShare(), expiresAt: 'not-a-date' })).toThrow(/时间/);
    expect(() => validateEmergencyShare({ ...validShare(), revokedAt: 'not-a-date' })).toThrow(/时间/);
  });
});
