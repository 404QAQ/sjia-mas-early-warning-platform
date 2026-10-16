/**
 * L-05 生活事件（当前只实现搬家/换城市的最小骨架）。
 *
 * 生活事件与 observation、alert 分离，因此不会进入临床引擎或通知管道。
 * 这里保留三件事的独立状态和时间戳；真正的医院目录、联系人重设和应急
 * 预案更新由后续切片负责，本实体只保存流程引用。
 */

export const LIFE_EVENT_TYPES = { RELOCATION: 'RELOCATION' } as const;
export type LifeEventType = (typeof LIFE_EVENT_TYPES)[keyof typeof LIFE_EVENT_TYPES];

export const LIFE_EVENT_STATUSES = { DRAFT: 'DRAFT', IN_PROGRESS: 'IN_PROGRESS', COMPLETED: 'COMPLETED' } as const;
export type LifeEventStatus = (typeof LIFE_EVENT_STATUSES)[keyof typeof LIFE_EVENT_STATUSES];

export const LIFE_EVENT_TASKS = {
  FIND_DOCTOR: 'FIND_DOCTOR',
  REFERRAL_SUMMARY: 'REFERRAL_SUMMARY',
  EMERGENCY_RESET: 'EMERGENCY_RESET',
} as const;
export type LifeEventTaskType = (typeof LIFE_EVENT_TASKS)[keyof typeof LIFE_EVENT_TASKS];

export const LIFE_EVENT_TASK_STATUSES = {
  NOT_STARTED: 'NOT_STARTED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
} as const;
export type LifeEventTaskStatus = (typeof LIFE_EVENT_TASK_STATUSES)[keyof typeof LIFE_EVENT_TASK_STATUSES];

export interface LifeEventTask {
  status: LifeEventTaskStatus;
  /** 第一次开始该件事的时间；状态重放不会覆盖它。 */
  startedAt?: string;
  /** 完成时间；只有完成状态才存在。 */
  completedAt?: string;
  /** 最后一次状态变更时间，便于患者端显示进度。 */
  updatedAt: string;
}

export interface ReferralSummaryContent {
  diagnosis: string;
  course: string;
  current_meds: string;
  taper_plan: string;
  allergies: string;
  key_trends_6m: string;
  mas_history: string;
  /** 必须放在摘要最后，供新医生快速阅读。 */
  personal_baseline_note: string;
}

export interface ReferralSummaryTask extends LifeEventTask {
  generatedAt?: string;
  confirmedBy?: string;
  confirmedAt?: string;
  /** 医生确认后才会有文书引用；系统不生成诊断文书。 */
  docRef?: string;
  content?: ReferralSummaryContent;
}

export interface LifeEvent {
  id: string;
  patientId: string;
  type: 'RELOCATION';
  fromRegion?: string;
  toRegion: string;
  initiatedAt: string;
  completedAt?: string;
  status: LifeEventStatus;
  /** 生活事件不参与告警，固定保留该边界标记。 */
  tags: readonly ['NO_ALERT'];
  findDoctor: LifeEventTask & { doctorReference?: string };
  referralSummary: ReferralSummaryTask;
  emergencyReset: LifeEventTask & { emergencyPlanRef?: string; contactReferences?: string[] };
  /** 患者级 CAS；每个成功写操作递增。 */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface LifeEventInput {
  type: 'RELOCATION';
  fromRegion?: string;
  toRegion: string;
  expectedVersion: number;
  idempotencyKey: string;
}

export function isLifeEventType(value: unknown): value is LifeEventType {
  return value === LIFE_EVENT_TYPES.RELOCATION;
}

export function isLifeEventStatus(value: unknown): value is LifeEventStatus {
  return value === LIFE_EVENT_STATUSES.DRAFT || value === LIFE_EVENT_STATUSES.IN_PROGRESS || value === LIFE_EVENT_STATUSES.COMPLETED;
}

export function isLifeEventTaskStatus(value: unknown): value is LifeEventTaskStatus {
  return value === LIFE_EVENT_TASK_STATUSES.NOT_STARTED || value === LIFE_EVENT_TASK_STATUSES.IN_PROGRESS || value === LIFE_EVENT_TASK_STATUSES.COMPLETED;
}

export function isLifeEvent(value: unknown): value is LifeEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as unknown as Record<string, unknown>;
  const allowed = ['id', 'patientId', 'type', 'fromRegion', 'toRegion', 'initiatedAt', 'completedAt', 'status', 'tags', 'findDoctor', 'referralSummary', 'emergencyReset', 'version', 'createdAt', 'updatedAt'];
  if (Object.keys(item).some(key => !allowed.includes(key))) return false;
  if (typeof item.id !== 'string' || typeof item.patientId !== 'string' || item.type !== 'RELOCATION' || typeof item.toRegion !== 'string' || !item.toRegion.trim()) return false;
  if (item.fromRegion !== undefined && typeof item.fromRegion !== 'string') return false;
  if (!isLifeEventStatus(item.status) || !Array.isArray(item.tags) || item.tags.length !== 1 || item.tags[0] !== 'NO_ALERT') return false;
  if (!Number.isSafeInteger(item.version) || Number(item.version) < 1) return false;
  if (typeof item.initiatedAt !== 'string' || typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string') return false;
  if (!isTask(item.findDoctor, ['doctorReference']) || !isTask(item.emergencyReset, ['emergencyPlanRef', 'contactReferences']) || !isReferralTask(item.referralSummary)) return false;
  const findDoctor = item.findDoctor as { status: LifeEventTaskStatus; doctorReference?: unknown };
  const emergencyReset = item.emergencyReset as { status: LifeEventTaskStatus; emergencyPlanRef?: unknown; contactReferences?: unknown };
  if (findDoctor.status === 'COMPLETED' && (typeof findDoctor.doctorReference !== 'string' || !findDoctor.doctorReference.trim())) return false;
  if (emergencyReset.status === 'COMPLETED' && (typeof emergencyReset.emergencyPlanRef !== 'string' || !emergencyReset.emergencyPlanRef.trim() || !Array.isArray(emergencyReset.contactReferences) || emergencyReset.contactReferences.length === 0)) return false;
  const tasks = [item.findDoctor, item.referralSummary, item.emergencyReset] as Array<LifeEventTask & { status: LifeEventTaskStatus }>;
  const allNotStarted = tasks.every(task => task.status === 'NOT_STARTED');
  const allCompleted = tasks.every(task => task.status === 'COMPLETED');
  if (item.status === 'DRAFT' && !allNotStarted) return false;
  if (item.status === 'IN_PROGRESS' && (allNotStarted || allCompleted)) return false;
  if (item.status === 'COMPLETED' && !allCompleted) return false;
  if (item.status === 'COMPLETED') return typeof item.completedAt === 'string';
  return item.completedAt === undefined;
}

function isTask(value: unknown, extraKeys: readonly string[] = []): value is LifeEventTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const allowed = ['status', 'startedAt', 'completedAt', 'updatedAt', ...extraKeys];
  if (Object.keys(item).some(key => !allowed.includes(key))) return false;
  if (!isLifeEventTaskStatus(item.status) || typeof item.updatedAt !== 'string') return false;
  if (item.doctorReference !== undefined && typeof item.doctorReference !== 'string') return false;
  if (item.emergencyPlanRef !== undefined && typeof item.emergencyPlanRef !== 'string') return false;
  if (item.contactReferences !== undefined && (!Array.isArray(item.contactReferences) || item.contactReferences.some(entry => typeof entry !== 'string' || !entry.trim()))) return false;
  if (item.startedAt !== undefined && typeof item.startedAt !== 'string') return false;
  if (item.completedAt !== undefined && typeof item.completedAt !== 'string') return false;
  if (item.status === 'NOT_STARTED') return item.startedAt === undefined && item.completedAt === undefined;
  if (item.status === 'IN_PROGRESS') return typeof item.startedAt === 'string' && item.completedAt === undefined;
  return typeof item.startedAt === 'string' && typeof item.completedAt === 'string';
}

function isReferralTask(value: unknown): value is ReferralSummaryTask {
  if (!isTask(value, ['generatedAt', 'confirmedBy', 'confirmedAt', 'docRef', 'content'])) return false;
  const item = value as unknown as Record<string, unknown>;
  if (item.generatedAt !== undefined && typeof item.generatedAt !== 'string') return false;
  if (item.confirmedBy !== undefined && typeof item.confirmedBy !== 'string') return false;
  if (item.confirmedAt !== undefined && typeof item.confirmedAt !== 'string') return false;
  if (item.docRef !== undefined && typeof item.docRef !== 'string') return false;
  if (item.content !== undefined && !isReferralContent(item.content)) return false;
  if (item.status === 'COMPLETED' && (typeof item.generatedAt !== 'string' || typeof item.confirmedBy !== 'string' || typeof item.confirmedAt !== 'string' || typeof item.docRef !== 'string' || !item.docRef.trim() || item.content === undefined)) return false;
  return true;
}

function isReferralContent(value: unknown): value is ReferralSummaryContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const keys = ['diagnosis', 'course', 'current_meds', 'taper_plan', 'allergies', 'key_trends_6m', 'mas_history', 'personal_baseline_note'];
  return Object.keys(item).length === keys.length && keys.every(key => typeof item[key] === 'string');
}
