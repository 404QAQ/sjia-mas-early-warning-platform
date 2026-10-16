import type { EmergencyPlan } from './emergency-plan.js';
import { EMERGENCY_CARD_CAN_DO, EMERGENCY_CARD_NEVER_DO } from './emergency-card.js';
import type { Iso, Patient } from './types.js';

export type EmergencyShareRecipientHint = 'GRANDPARENT' | 'BABYSITTER' | 'FRIEND';

/** E-04 只保存分享授权的生命周期；联系人读取时重新裁剪当前 E-01 事实。 */
export interface EmergencyShare {
  code: string;
  patientId: string;
  planVersionRef: number;
  shareToken: string;
  visibility: 'G2_SUMMARY';
  createdBy: string;
  createdAt: Iso;
  expiresAt: Iso;
  revokedAt?: Iso;
  recipientsHint: EmergencyShareRecipientHint[];
}

export interface EmergencyShareSummary {
  title: '紧急情况怎么办（简化版）';
  description: '你看到的这一份是简化版，只写了要做的事。';
  patientDisplayName?: string;
  updatedAt: Iso;
  planVersion: number;
  thresholds: string[];
  hospitalName: string;
  nightEntrance?: string;
  arrivalMinutesNight: number;
  triageScript: string;
  followUpClinicianPhone: string;
  neverDo: string[];
  canDo: string[];
}

/** 联系人侧只展示行动信息，不带化验、完整处方或内部实体标识。 */
export function emergencyShareSummary(plan: EmergencyPlan, patientDisplayName?: string, diseaseType?: Patient['diseaseType']): EmergencyShareSummary {
  if (plan.status !== 'CONFIRMED' || plan.clinician.nightCapable !== 'TRUE' || !plan.caregiver.primaryHospital || !plan.caregiver.route || !plan.clinician.triageScript || !plan.clinician.followUpClinicianPhone || !plan.clinician.onCallContact) {
    throw new RangeError('只有已确认夜间收治能力且资料完整的应急预案可以分享');
  }
  return {
    title: '紧急情况怎么办（简化版）',
    description: '你看到的这一份是简化版，只写了要做的事。',
    ...(patientDisplayName === undefined ? {} : { patientDisplayName }),
    updatedAt: plan.updatedAt,
    planVersion: plan.version,
    thresholds: plan.decisionThresholds.map(item => item.label),
    hospitalName: plan.caregiver.primaryHospital.name,
    ...(plan.caregiver.primaryHospital.nightEntrance === undefined ? {} : { nightEntrance: plan.caregiver.primaryHospital.nightEntrance }),
    arrivalMinutesNight: plan.caregiver.route.minutesNight,
    // 医生自由文本可能含化验或用药细节；公开 G2 仅使用已登记病种的固定话术。
    triageScript: diseaseType === 'sJIA' ? 'sJIA，有 MAS 风险' : diseaseType === 'AOSD' ? 'AOSD，有 MAS 风险' : '有 MAS 风险，请告知急诊医护',
    followUpClinicianPhone: plan.clinician.followUpClinicianPhone,
    neverDo: [...EMERGENCY_CARD_NEVER_DO],
    canDo: [...EMERGENCY_CARD_CAN_DO],
  };
}

export function validateEmergencyShare(value: EmergencyShare): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RangeError('应急分享授权无效');
  text(value.code, '分享码', 32); text(value.patientId, '患者标识', 200); text(value.shareToken, '分享令牌', 1000); text(value.createdBy, '创建者', 200);
  instant(value.createdAt); instant(value.expiresAt); if (value.revokedAt !== undefined) instant(value.revokedAt);
  if (value.visibility !== 'G2_SUMMARY' || !Number.isSafeInteger(value.planVersionRef) || value.planVersionRef < 1) throw new RangeError('应急分享授权字段无效');
  if (!Array.isArray(value.recipientsHint) || value.recipientsHint.length < 1 || value.recipientsHint.length > 3 || new Set(value.recipientsHint).size !== value.recipientsHint.length || value.recipientsHint.some(item => !['GRANDPARENT', 'BABYSITTER', 'FRIEND'].includes(item))) throw new RangeError('分享对象提示无效');
}

function text(value: unknown, label: string, max: number): asserts value is string { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) throw new RangeError(`${label}无效`); }
function instant(value: unknown): void { text(value, '时间', 80); if (!Number.isFinite(Date.parse(value))) throw new RangeError('时间无效'); }
