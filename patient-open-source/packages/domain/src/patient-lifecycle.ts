/** T-06 患者离世与档案处置。状态只描述生命周期事实，不触发通知或删除副作用。 */
export const PATIENT_LIFECYCLE_STATUSES = ['ACTIVE', 'DECEASED', 'MEMORIAL', 'DELETED_REQUESTED', 'DELETED'] as const;
export type PatientLifecycleStatus = (typeof PATIENT_LIFECYCLE_STATUSES)[number];

export const PATIENT_RECORD_RETENTIONS = ['MEMORIAL', 'CLINICAL_WITH_CONSENT', 'FULL_DELETE'] as const;
export type PatientRecordRetention = (typeof PATIENT_RECORD_RETENTIONS)[number];

export const PATIENT_LIFECYCLE_ACTIONS = [
  'REGISTER_DECEASED',
  'REVOKE_DECEASED',
  'REQUEST_MEMORIAL',
  'REQUEST_DELETE',
  'CANCEL_DELETE',
] as const;
export type PatientLifecycleAction = (typeof PATIENT_LIFECYCLE_ACTIONS)[number];

export const PATIENT_LIFECYCLE_NOTICE_METHODS = ['PLATFORM_MESSAGE', 'PHONE'] as const;
export type PatientLifecycleNoticeMethod = (typeof PATIENT_LIFECYCLE_NOTICE_METHODS)[number];

export interface PatientLifecycleNoticeContact {
  contactId: string;
  method: PatientLifecycleNoticeMethod;
}

export interface PatientLifecycleHistory {
  version: number;
  action: PatientLifecycleAction;
  status: PatientLifecycleStatus;
  at: string;
  by: string;
  registeredAt?: string;
  registeredBy?: string;
  reversibleUntil?: string;
  notifyContacts: PatientLifecycleNoticeContact[];
  recordRetention?: PatientRecordRetention;
  familyConsentRef?: string;
  familyAccessedAt?: string;
  deletionRequestedAt?: string;
  deleteAfter?: string;
}

export interface PatientLifecycle {
  patientId: string;
  status: PatientLifecycleStatus;
  registeredAt?: string;
  registeredBy?: string;
  reversibleUntil?: string;
  notifyContacts: PatientLifecycleNoticeContact[];
  recordRetention?: PatientRecordRetention;
  familyConsentRef?: string;
  familyAccessedAt?: string;
  deletionRequestedAt?: string;
  deleteAfter?: string;
  version: number;
  updatedAt: string;
  updatedBy: string;
  history: PatientLifecycleHistory[];
}

export function isPatientLifecycleAction(value: unknown): value is PatientLifecycleAction {
  return typeof value === 'string' && (PATIENT_LIFECYCLE_ACTIONS as readonly string[]).includes(value);
}

export function isPatientLifecycleStatus(value: unknown): value is PatientLifecycleStatus {
  return typeof value === 'string' && (PATIENT_LIFECYCLE_STATUSES as readonly string[]).includes(value);
}

export function isPatientRecordRetention(value: unknown): value is PatientRecordRetention {
  return typeof value === 'string' && (PATIENT_RECORD_RETENTIONS as readonly string[]).includes(value);
}

export function isPatientLifecycle(value: unknown): value is PatientLifecycle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const allowed = ['patientId', 'status', 'registeredAt', 'registeredBy', 'reversibleUntil', 'notifyContacts', 'recordRetention', 'familyConsentRef', 'familyAccessedAt', 'deletionRequestedAt', 'deleteAfter', 'version', 'updatedAt', 'updatedBy', 'history'];
  if (Object.keys(item).some(key => !allowed.includes(key))) return false;
  if (!text(item.patientId) || !isPatientLifecycleStatus(item.status) || !Array.isArray(item.notifyContacts)
    || item.notifyContacts.some(contact => !isNotice(contact)) || !positiveVersion(item.version)
    || !iso(item.updatedAt) || !text(item.updatedBy) || !Array.isArray(item.history) || item.history.length !== item.version
    || item.history.some((entry, index) => !isHistory(entry, index + 1))) return false;
  if (item.registeredAt !== undefined && !iso(item.registeredAt)) return false;
  if (item.registeredBy !== undefined && !text(item.registeredBy)) return false;
  if (item.reversibleUntil !== undefined && !iso(item.reversibleUntil)) return false;
  if (item.recordRetention !== undefined && !isPatientRecordRetention(item.recordRetention)) return false;
  if (item.familyConsentRef !== undefined && !shortText(item.familyConsentRef)) return false;
  if (item.familyAccessedAt !== undefined && !iso(item.familyAccessedAt)) return false;
  if (item.deletionRequestedAt !== undefined && !iso(item.deletionRequestedAt)) return false;
  if (item.deleteAfter !== undefined && !iso(item.deleteAfter)) return false;
  if (item.status !== 'ACTIVE' && (item.registeredAt === undefined || item.registeredBy === undefined || item.reversibleUntil === undefined)) return false;
  if (item.status === 'ACTIVE' && (item.registeredAt !== undefined || item.registeredBy !== undefined || item.reversibleUntil !== undefined || item.recordRetention !== undefined || item.familyConsentRef !== undefined || item.familyAccessedAt !== undefined || item.deletionRequestedAt !== undefined || item.deleteAfter !== undefined)) return false;
  if (item.status === 'DELETED_REQUESTED' && (item.recordRetention !== 'FULL_DELETE' || item.deletionRequestedAt === undefined || item.deleteAfter === undefined)) return false;
  if (item.status === 'MEMORIAL' && item.recordRetention !== 'MEMORIAL') return false;
  if (item.status === 'DELETED' && item.recordRetention !== 'FULL_DELETE') return false;
  const latest = item.history[item.history.length - 1] as PatientLifecycleHistory;
  return latest.status === item.status && latest.at === item.updatedAt && latest.by === item.updatedBy
    && latest.registeredAt === item.registeredAt && latest.registeredBy === item.registeredBy
    && latest.reversibleUntil === item.reversibleUntil && latest.recordRetention === item.recordRetention
    && latest.familyConsentRef === item.familyConsentRef && latest.familyAccessedAt === item.familyAccessedAt
    && latest.deletionRequestedAt === item.deletionRequestedAt && latest.deleteAfter === item.deleteAfter
    && JSON.stringify(latest.notifyContacts) === JSON.stringify(item.notifyContacts);
}

function isHistory(value: unknown, expectedVersion: number): value is PatientLifecycleHistory {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const allowed = ['version', 'action', 'status', 'at', 'by', 'registeredAt', 'registeredBy', 'reversibleUntil', 'notifyContacts', 'recordRetention', 'familyConsentRef', 'familyAccessedAt', 'deletionRequestedAt', 'deleteAfter'];
  if (Object.keys(item).some(key => !allowed.includes(key))) return false;
  if (item.version !== expectedVersion || !positiveVersion(item.version) || !isPatientLifecycleAction(item.action)
    || !isPatientLifecycleStatus(item.status) || !iso(item.at) || !text(item.by) || !Array.isArray(item.notifyContacts)
    || item.notifyContacts.some(contact => !isNotice(contact))) return false;
  for (const key of ['registeredAt', 'reversibleUntil', 'familyAccessedAt', 'deletionRequestedAt', 'deleteAfter'] as const) if (item[key] !== undefined && !iso(item[key])) return false;
  if (item.registeredBy !== undefined && !text(item.registeredBy)) return false;
  if (item.recordRetention !== undefined && !isPatientRecordRetention(item.recordRetention)) return false;
  if (item.familyConsentRef !== undefined && !shortText(item.familyConsentRef)) return false;
  return true;
}

function isNotice(value: unknown): value is PatientLifecycleNoticeContact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every(key => ['contactId', 'method'].includes(key)) && text(item.contactId)
    && typeof item.method === 'string' && (PATIENT_LIFECYCLE_NOTICE_METHODS as readonly string[]).includes(item.method);
}

function positiveVersion(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1; }
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[\0\r\n]/.test(value); }
function shortText(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 500 && !/[\0\r\n]/.test(value); }
function iso(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
