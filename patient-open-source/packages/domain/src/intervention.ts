import { parseCareInstant } from './care-routing.js';
import type { Iso } from './types.js';

/** F-18 只记录已经实施的干预事实，不表达推荐、剂量排序或临床判读。 */
export const INTERVENTION_TYPES = {
  STEROID_PULSE: 'STEROID_PULSE',
  STEROID_ADJUST: 'STEROID_ADJUST',
  CYCLOSPORINE: 'CYCLOSPORINE',
  BIOLOGIC: 'BIOLOGIC',
  ANTI_INFECTIVE: 'ANTI_INFECTIVE',
  SUPPORTIVE: 'SUPPORTIVE',
  OTHER: 'OTHER',
} as const;
export type InterventionType = (typeof INTERVENTION_TYPES)[keyof typeof INTERVENTION_TYPES];

export const INTERVENTION_FOLLOW_UP_HOURS = [24, 48] as const;
export type InterventionFollowUpHours = (typeof INTERVENTION_FOLLOW_UP_HOURS)[number];

/** 允许的客观回填指标。未知指标不进入本切片，避免把自由文本误当作临床事实。 */
export const INTERVENTION_RESPONSE_METRICS = ['ferritin', 'platelet', 'ast', 'fibrinogen', 'triglyceride', 'feverPeak'] as const;
export type InterventionResponseMetric = (typeof INTERVENTION_RESPONSE_METRICS)[number];

export interface InterventionDetail {
  /** 医生实际使用的药物或支持措施名称；平台不根据此字段推荐治疗。 */
  drug?: string;
  dose?: string;
  route?: string;
  durationDays?: number;
  note?: string;
}

export interface Intervention {
  id: string;
  patientId: string;
  alertId?: string;
  type: InterventionType;
  detail: InterventionDetail;
  startedAt: Iso;
  plannedEndAt?: Iso;
  recordedBy: string;
  recordedAt: Iso;
  followUpDue: readonly [24, 48];
  /** 只表示对应回填事实已写入的服务端时间，不表示反应良好或失败。 */
  followUpDoneAt?: Partial<Record<'24' | '48', Iso>>;
  /** 患者级 CAS 版本；创建从 1 开始，追加每个回填事实递增。 */
  version: number;
}

export interface InterventionResponseMeasurement {
  before: number;
  after: number;
  unit?: string;
}

/** 24/48 小时客观回填；不含 auto_judgement 或 clinician_judgement。 */
export interface InterventionResponseRecord {
  id: string;
  patientId: string;
  interventionId: string;
  atHours: InterventionFollowUpHours;
  observedAt: Iso;
  recordedAt: Iso;
  recordedBy: string;
  measurements: Partial<Record<InterventionResponseMetric, InterventionResponseMeasurement>>;
  /** 回填写入后的干预版本，用于审计和重放。 */
  interventionVersion: number;
  idempotencyKey: string;
}

export type InterventionCommandOperation = 'CREATE' | 'APPEND_RESPONSE';

export interface InterventionCommand {
  patientId: string;
  interventionId: string;
  actorId: string;
  idempotencyKey: string;
  expectedVersion: number;
  requestFingerprint: string;
  at: Iso;
  operation: InterventionCommandOperation;
  input: Record<string, unknown>;
  result: {
    intervention: Intervention;
    response?: InterventionResponseRecord;
  };
}

export function isInterventionType(value: unknown): value is InterventionType {
  return typeof value === 'string' && (Object.values(INTERVENTION_TYPES) as readonly string[]).includes(value);
}

export function isInterventionFollowUpHours(value: unknown): value is InterventionFollowUpHours {
  return value === 24 || value === 48;
}

export function isInterventionResponseMetric(value: unknown): value is InterventionResponseMetric {
  return typeof value === 'string' && (INTERVENTION_RESPONSE_METRICS as readonly string[]).includes(value);
}

/** 严格校验干预事实，拒绝未知字段和未来不可解析的时间值。 */
export function isIntervention(value: unknown): value is Intervention {
  if (!record(value)) return false;
  const item = value as Record<string, unknown>;
  const allowed = ['id', 'patientId', 'alertId', 'type', 'detail', 'startedAt', 'plannedEndAt', 'recordedBy', 'recordedAt', 'followUpDue', 'followUpDoneAt', 'version'];
  if (Object.keys(item).some(key => !allowed.includes(key))) return false;
  if (!nonEmpty(item.id) || !nonEmpty(item.patientId) || !nonEmpty(item.recordedBy) || !isInterventionType(item.type)) return false;
  if (!isIso(item.startedAt) || !isIso(item.recordedAt) || (item.plannedEndAt !== undefined && !isIso(item.plannedEndAt))) return false;
  if (item.alertId !== undefined && !nonEmpty(item.alertId)) return false;
  if (!isInterventionDetail(item.detail)) return false;
  if (!Array.isArray(item.followUpDue) || item.followUpDue.length !== 2 || item.followUpDue[0] !== 24 || item.followUpDue[1] !== 48) return false;
  if (!isDoneAt(item.followUpDoneAt)) return false;
  return Number.isSafeInteger(item.version) && Number(item.version) > 0;
}

/** 严格校验客观回填，保证至少有一项数值前后测量。 */
export function isInterventionResponse(value: unknown): value is InterventionResponseRecord {
  if (!record(value)) return false;
  const item = value as Record<string, unknown>;
  const allowed = ['id', 'patientId', 'interventionId', 'atHours', 'observedAt', 'recordedAt', 'recordedBy', 'measurements', 'interventionVersion', 'idempotencyKey'];
  if (Object.keys(item).some(key => !allowed.includes(key))) return false;
  if (!nonEmpty(item.id) || !nonEmpty(item.patientId) || !nonEmpty(item.interventionId) || !nonEmpty(item.recordedBy) || !nonEmpty(item.idempotencyKey)) return false;
  if (!isInterventionFollowUpHours(item.atHours) || !isIso(item.observedAt) || !isIso(item.recordedAt)) return false;
  if (!record(item.measurements)) return false;
  const measurements = item.measurements as Record<string, unknown>;
  if (Object.keys(measurements).length === 0 || Object.keys(measurements).some(key => !isInterventionResponseMetric(key) || !isMeasurement(measurements[key]))) return false;
  return Number.isSafeInteger(item.interventionVersion) && Number(item.interventionVersion) > 1;
}

export function validateIntervention(value: unknown): Intervention {
  if (!isIntervention(value)) throw new RangeError('干预事实字段无效');
  return structuredClone(value);
}

export function validateInterventionResponse(value: unknown): InterventionResponseRecord {
  if (!isInterventionResponse(value)) throw new RangeError('干预回填事实字段无效');
  return structuredClone(value);
}

function isInterventionDetail(value: unknown): value is InterventionDetail {
  if (!record(value)) return false;
  const allowed = ['drug', 'dose', 'route', 'durationDays', 'note'];
  if (Object.keys(value).some(key => !allowed.includes(key))) return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length === 0) return false;
  for (const key of ['drug', 'dose', 'route', 'note']) if (item[key] !== undefined && !nonEmpty(item[key])) return false;
  return item.durationDays === undefined || (typeof item.durationDays === 'number' && Number.isSafeInteger(item.durationDays) && item.durationDays >= 0);
}

function isMeasurement(value: unknown): value is InterventionResponseMeasurement {
  if (!record(value)) return false;
  const allowed = ['before', 'after', 'unit'];
  if (Object.keys(value).some(key => !allowed.includes(key))) return false;
  const item = value as Record<string, unknown>;
  return typeof item.before === 'number' && Number.isFinite(item.before) && typeof item.after === 'number' && Number.isFinite(item.after)
    && (item.unit === undefined || nonEmpty(item.unit));
}

function isDoneAt(value: unknown): value is Intervention['followUpDoneAt'] {
  if (value === undefined) return true;
  if (!record(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every(key => (key === '24' || key === '48') && isIso(item[key]));
}

function isIso(value: unknown): value is Iso {
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  try { parseCareInstant(value); return true; } catch { return false; }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
