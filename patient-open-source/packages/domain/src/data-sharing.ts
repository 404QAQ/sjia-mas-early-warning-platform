import type { Iso } from './types.js';

export const DATA_SHARING_STATUSES = ['PENDING', 'ACTIVE', 'REVOKED'] as const;
export type DataSharingStatus = (typeof DATA_SHARING_STATUSES)[number];
export const DATA_SHARING_OPERATIONS = ['REQUEST', 'CONFIRM', 'UPDATE', 'REVOKE'] as const;
export type DataSharingOperation = (typeof DATA_SHARING_OPERATIONS)[number];

export interface DataSharingScopes {
  observations: boolean;
  medications: boolean;
  alerts: boolean;
  psychScreening: boolean;
  /** 永久 false；情绪日记不允许跨院共享。 */
  moodDiary: false;
  lifeInfo: boolean;
}

export interface DataSharingOrgLink {
  fromOrgId: string;
  toOrgId: string;
  agreementRef: string;
  status: 'ACTIVE' | 'TERMINATED';
  establishedAt: Iso;
  terminatedAt?: Iso;
  version: number;
}

export interface DataSharingScope {
  patientId: string;
  fromOrgId: string;
  toOrgId: string;
  scopes: DataSharingScopes;
  status: DataSharingStatus;
  version: number;
  requestedAt: Iso;
  requestedBy: string;
  patientConfirmedAt?: Iso;
  patientConfirmedBy?: string;
  lastChangedAt: Iso;
  lastChangedBy: string;
  revokedAt?: Iso;
}

export function normalizeDataSharingScopes(value: unknown): DataSharingScopes {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RangeError('共享范围必须是对象');
  const input = value as Record<string, unknown>;
  const allowed = ['observations', 'medications', 'alerts', 'psychScreening', 'moodDiary', 'lifeInfo'];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new RangeError('共享范围包含未支持字段');
  for (const key of ['observations', 'medications', 'alerts', 'psychScreening', 'lifeInfo']) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new RangeError('共享范围必须使用布尔值');
  }
  if (input.moodDiary !== undefined && input.moodDiary !== false) throw new RangeError('情绪日记永久禁止跨院共享');
  return {
    observations: input.observations === true,
    medications: input.medications === true,
    alerts: input.alerts === true,
    psychScreening: input.psychScreening === true,
    moodDiary: false,
    lifeInfo: input.lifeInfo === true,
  };
}

export function isDataSharingScopes(value: unknown): value is DataSharingScopes {
  try { normalizeDataSharingScopes(value); return true; } catch { return false; }
}

export function isDataSharingScope(value: unknown): value is DataSharingScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const allowed = ['patientId', 'fromOrgId', 'toOrgId', 'scopes', 'status', 'version', 'requestedAt', 'requestedBy', 'patientConfirmedAt', 'patientConfirmedBy', 'lastChangedAt', 'lastChangedBy', 'revokedAt'];
  return !Object.keys(item).some(key => !allowed.includes(key))
    && text(item.patientId) && text(item.fromOrgId) && text(item.toOrgId) && item.fromOrgId !== item.toOrgId
    && isDataSharingScopes(item.scopes) && DATA_SHARING_STATUSES.includes(item.status as DataSharingStatus)
    && Number.isSafeInteger(item.version) && Number(item.version) >= 1
    && iso(item.requestedAt) && text(item.requestedBy) && iso(item.lastChangedAt) && text(item.lastChangedBy)
    && optionalIso(item.patientConfirmedAt) && optionalText(item.patientConfirmedBy) && optionalIso(item.revokedAt)
    && (item.patientConfirmedAt === undefined) === (item.patientConfirmedBy === undefined)
    && (item.status === 'PENDING' ? item.patientConfirmedAt === undefined && item.revokedAt === undefined
      : item.status === 'ACTIVE' ? item.patientConfirmedAt !== undefined && item.patientConfirmedBy !== undefined && item.revokedAt === undefined
        : item.revokedAt !== undefined);
}

export function isDataSharingOrgLink(value: unknown): value is DataSharingOrgLink {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return text(item.fromOrgId) && text(item.toOrgId) && item.fromOrgId !== item.toOrgId && text(item.agreementRef)
    && (item.status === 'ACTIVE' || item.status === 'TERMINATED') && iso(item.establishedAt)
    && (item.status === 'TERMINATED' ? iso(item.terminatedAt) : item.terminatedAt === undefined)
    && Number.isSafeInteger(item.version) && Number(item.version) >= 1;
}

function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[\0\r\n]/.test(value); }
function optionalText(value: unknown): value is string | undefined { return value === undefined || text(value); }
function iso(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function optionalIso(value: unknown): value is string | undefined { return value === undefined || iso(value); }
