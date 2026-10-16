import type { Iso } from './types.js';

export type JointRespondent = 'PATIENT' | 'CAREGIVER';
export type JointActivityLevel = 'FULL' | 'LIMITED' | 'SEVERE';
export type JointDataQuality = 'OK' | 'CONFLICT';
/** 方向必须由经批准的引擎策略计算；未配置策略时显式保留 UNKNOWN。 */
export type JointTrendFlag = 'IMPROVED' | 'STABLE' | 'WORSENED' | 'UNKNOWN';
export type JointActivityRestriction = 'NONE' | 'MILD' | 'MODERATE' | 'SEVERE';
export type JointInstrument = 'JADAS' | 'CHAQ' | 'cJADAS' | 'NONE';

export interface JointAssessmentInput {
  observedAt: Iso;
  morningStiffnessMinutes: 0 | 15 | 30 | 60;
  painNrs: number;
  activityLevel: JointActivityLevel;
  respondent: JointRespondent;
}

export interface JointExamInput {
  assessedAt: Iso;
  tenderJointCount?: number;
  swollenJointCount?: number;
  morningStiffnessMinutes?: number;
  physicianGlobalAssessment?: number;
  activityRestriction?: JointActivityRestriction;
  instrument?: JointInstrument;
}

export interface JointAssessmentRecord extends JointAssessmentInput {
  id: string;
  patientId: string;
  assessedBy: string;
  recordedAt: Iso;
  trendFlag: JointTrendFlag;
  dataQuality: JointDataQuality;
  sourceUi: 'DAILY_RECORD';
  source: JointRespondent;
  idempotencyKey: string;
}

export interface JointExamRecord extends JointExamInput {
  id: string;
  patientId: string;
  assessedBy: string;
  recordedAt: Iso;
  deltaVsPrevious?: { tender?: number; swollen?: number; stiffness?: number; direction: JointTrendFlag };
  /** 当前门诊评估尚未与告警方向做经批准的对照时为 null。 */
  conflictWithAlerts: boolean | null;
  idempotencyKey: string;
}

export function validateJointAssessmentInput(raw: unknown): JointAssessmentInput {
  if (!record(raw) || Object.keys(raw).some(key => !['observedAt', 'morningStiffnessMinutes', 'painNrs', 'activityLevel', 'respondent'].includes(key)) ||
    !instant(raw.observedAt) || !([0, 15, 30, 60] as number[]).includes(raw.morningStiffnessMinutes as number) ||
    !Number.isInteger(raw.painNrs) || (raw.painNrs as number) < 0 || (raw.painNrs as number) > 10 ||
    !['FULL', 'LIMITED', 'SEVERE'].includes(raw.activityLevel as string) || !['PATIENT', 'CAREGIVER'].includes(raw.respondent as string)) {
    throw new Error('关节速记字段无效');
  }
  return { observedAt: new Date(raw.observedAt as string).toISOString(), morningStiffnessMinutes: raw.morningStiffnessMinutes as JointAssessmentInput['morningStiffnessMinutes'], painNrs: raw.painNrs as number, activityLevel: raw.activityLevel as JointActivityLevel, respondent: raw.respondent as JointRespondent };
}

export function validateJointExamInput(raw: unknown): JointExamInput {
  if (!record(raw) || Object.keys(raw).some(key => !['assessedAt', 'tenderJointCount', 'swollenJointCount', 'morningStiffnessMinutes', 'physicianGlobalAssessment', 'activityRestriction', 'instrument'].includes(key)) || !instant(raw.assessedAt) ||
    !optionalInteger(raw.tenderJointCount, 0, 68) || !optionalInteger(raw.swollenJointCount, 0, 66) || !optionalInteger(raw.morningStiffnessMinutes, 0, 1440) ||
    !optionalNumber(raw.physicianGlobalAssessment, 0, 10) || (raw.activityRestriction !== undefined && !['NONE', 'MILD', 'MODERATE', 'SEVERE'].includes(raw.activityRestriction as string)) ||
    (raw.instrument !== undefined && !['JADAS', 'CHAQ', 'cJADAS', 'NONE'].includes(raw.instrument as string))) throw new Error('门诊关节评估字段无效');
  return {
    assessedAt: new Date(raw.assessedAt as string).toISOString(),
    ...(raw.tenderJointCount === undefined ? {} : { tenderJointCount: raw.tenderJointCount as number }),
    ...(raw.swollenJointCount === undefined ? {} : { swollenJointCount: raw.swollenJointCount as number }),
    ...(raw.morningStiffnessMinutes === undefined ? {} : { morningStiffnessMinutes: raw.morningStiffnessMinutes as number }),
    ...(raw.physicianGlobalAssessment === undefined ? {} : { physicianGlobalAssessment: raw.physicianGlobalAssessment as number }),
    ...(raw.activityRestriction === undefined ? {} : { activityRestriction: raw.activityRestriction as JointActivityRestriction }),
    ...(raw.instrument === undefined ? {} : { instrument: raw.instrument as JointInstrument }),
  };
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function instant(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function optionalInteger(value: unknown, min: number, max: number): boolean { return value === undefined || Number.isInteger(value) && (value as number) >= min && (value as number) <= max; }
function optionalNumber(value: unknown, min: number, max: number): boolean { return value === undefined || typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max; }
