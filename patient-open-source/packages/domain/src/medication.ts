import type { Iso } from './types.js';

export type MedicationKind = 'STEROID' | 'BIOLOGIC' | 'SUPPORTIVE';
export type MedicationRoute = 'ORAL' | 'SC_INJECTION';
export type MedicationFrequency = 'DAILY' | 'WEEKLY' | 'EVERY_4_WEEKS' | 'AS_NEEDED';
export type MedicationPlanStatus = 'ACTIVE' | 'PAUSED' | 'STOPPED';
export type MedicationInjectionSite = 'LUQ' | 'RUQ' | 'LLQ' | 'RLQ';
export type MedicationInjectionAdministeredBy = 'SELF' | 'FAMILY' | 'NURSE';
export type MedicationColdChainEventType = 'UNREFRIGERATED' | 'FROZEN' | 'TEMPERATURE_EXCURSION' | 'TRANSPORT_DELAY' | 'OTHER';

export interface MedicationColdChainEvent {
  type: MedicationColdChainEventType;
  durationHours: number;
  reportedAt: Iso;
}

export interface MedicationSchedulePoint {
  effectiveFrom: Iso;
  plannedDose: number;
}

/** 用药安排与实际记录分轨；患者自记不构成已确认的治疗计划。 */
export interface MedicationPlan {
  id: string;
  patientId: string;
  /** 旧数据未设置来源时视为原有医生计划。来源一经创建不变。 */
  source?: 'CLINICIAN' | 'PATIENT_REPORTED';
  prescriptionNote?: string;
  /** 患者自记的乐观并发版本。 */
  version?: number;
  /** 医生接续生成新计划，保留原自记与原始日志。 */
  originReportedPlanId?: string;
  /** 外院自记经本平台医生核对的时刻，不追溯确认历史。 */
  confirmedAt?: Iso;
  reviewedPlanId?: string;
  kind: MedicationKind;
  drug: string;
  dose: number;
  unit: string;
  route: MedicationRoute;
  frequency: MedicationFrequency;
  startedAt: Iso;
  schedule: MedicationSchedulePoint[];
  /** 修订后端用于裁定历史节点的服务端时点；新建计划和旧数据可省略。 */
  scheduleAsOf?: Iso;
  status: MedicationPlanStatus;
  coldChain?: boolean;
  idempotencyKey?: string;
  createdAt: Iso;
  createdBy: string;
}

export type MedicationLogSource = 'PATIENT' | 'CAREGIVER' | 'CLINICIAN';

export interface MedicationLog {
  id: string;
  patientId: string;
  planId: string;
  takenAt: Iso;
  actualDose: number;
  unit: string;
  source: MedicationLogSource;
  administeredBy: string;
  recordedAt: Iso;
  idempotencyKey: string;
  /** 皮下注射四象限；非注射计划必须为空。 */
  injectionSite?: MedicationInjectionSite;
  /** 对外可见的注射人角色，和内部 administeredBy Actor ID 分开。 */
  injectionAdministeredBy?: MedicationInjectionAdministeredBy;
  /** 仅记录冷链异常事实，不表示药品是否仍可用。 */
  coldChainEvent?: MedicationColdChainEvent;
}

/** 患者/监护人可读取的用药视图，不暴露重放键和内部操作者标识。 */
export type MedicationPlanView = Omit<MedicationPlan, 'idempotencyKey' | 'createdBy'>;
export type MedicationLogView = Omit<MedicationLog, 'idempotencyKey' | 'administeredBy' | 'recordedAt'>;

export type MedicationTodayStatus = 'RECORDED' | 'NOT_RECORDED' | 'NOT_DUE';

export interface MedicationTodayItem {
  planId: string;
  status: MedicationTodayStatus;
  lastTakenAt?: Iso;
  /** 非计划日但最近一次应到日尚未记录；用于提供联系医生入口，不改变 status 兼容值。 */
  late?: boolean;
  dueAt?: Iso;
}

export interface MedicationOverview {
  patientId: string;
  asOf: Iso;
  plans: MedicationPlanView[];
  logs: MedicationLogView[];
  today: MedicationTodayItem[];
}

/** 仅医生确认计划可作为临床决策依据；兼容此前只允许医生建计划的数据。 */
export function isClinicianMedicationPlan(plan: Pick<MedicationPlan, 'source'>): boolean { return plan.source === undefined || plan.source === 'CLINICIAN'; }
