/**
 * P-04 本人状态速记。
 *
 * 这不是临床 Observation：单独的类型和字段白名单让它无法意外进入
 * 风险引擎、医生摘要、通知或跨机构查询。正文只在患者本人权限下返回。
 */

export const PRIVATE_DIARY_CODES = {
  FREE_TEXT: 'MOOD_FREE_TEXT',
  QUICK: 'MOOD_QUICK',
} as const;

export type PrivateDiaryCode = (typeof PRIVATE_DIARY_CODES)[keyof typeof PRIVATE_DIARY_CODES];

export const PRIVATE_DIARY_QUICK_MOODS = {
  DISTRESSED: 'DISTRESSED',
  ANGRY: 'ANGRY',
  LOW_ENERGY: 'LOW_ENERGY',
  UNCLEAR: 'UNCLEAR',
} as const;

export type PrivateDiaryQuickMood = (typeof PRIVATE_DIARY_QUICK_MOODS)[keyof typeof PRIVATE_DIARY_QUICK_MOODS];

export const PRIVATE_DIARY_QUICK_MOOD_LABEL: Record<PrivateDiaryQuickMood, string> = {
  DISTRESSED: '难受',
  ANGRY: '生气',
  LOW_ENERGY: '没力气',
  UNCLEAR: '说不清',
};

export const PRIVATE_DIARY_TAG = 'NO_ALERT' as const;

export interface PrivateDiaryEntry {
  id: string;
  patientId: string;
  code: PrivateDiaryCode;
  valueText?: string;
  valueCoded?: PrivateDiaryQuickMood;
  observedAt: string;
  recordedAt: string;
  source: 'PATIENT_REPORTED';
  tags: readonly ['NO_ALERT'];
  visibleTo: readonly ['SELF'];
  /** 患者空间中的单调写入版本，用于客户端 CAS。 */
  revision: number;
}

/** 单条记录的主动授权是独立事实，不改写正文的 SELF/NO_ALERT 边界。 */
export interface PrivateDiaryShareAuthorization {
  id: string;
  patientId: string;
  entryId: string;
  targetActorId: string;
  grantedByActorId: string;
  orgUnitId: string;
  status: 'ACTIVE' | 'REVOKED';
  version: number;
  grantedAt: string;
  expiresAt: string;
  revokedAt?: string;
  revokedByActorId?: string;
}

export function isPrivateDiaryShareAuthorization(value: unknown): value is PrivateDiaryShareAuthorization {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const allowed = ['id', 'patientId', 'entryId', 'targetActorId', 'grantedByActorId', 'orgUnitId', 'status', 'version', 'grantedAt', 'expiresAt', 'revokedAt', 'revokedByActorId'];
  if (Object.keys(item).some(key => !allowed.includes(key))) return false;
  if (![item.id, item.patientId, item.entryId, item.targetActorId, item.grantedByActorId, item.orgUnitId].every(shareText)) return false;
  if (item.status !== 'ACTIVE' && item.status !== 'REVOKED') return false;
  if (!Number.isSafeInteger(item.version) || Number(item.version) < 1) return false;
  if (!shareIso(item.grantedAt) || !shareIso(item.expiresAt) || Date.parse(item.expiresAt) <= Date.parse(item.grantedAt)) return false;
  return item.status === 'ACTIVE'
    ? item.revokedAt === undefined && item.revokedByActorId === undefined
    : shareIso(item.revokedAt) && shareText(item.revokedByActorId) && Date.parse(item.revokedAt) >= Date.parse(item.grantedAt);
}

/** 允许 UI 与 API 共用的输入形状；服务层还会校验当前操作者。 */
export interface PrivateDiaryInput {
  code: PrivateDiaryCode;
  valueText?: string;
  valueCoded?: PrivateDiaryQuickMood | string;
  observedAt?: string;
  expectedVersion: number;
  idempotencyKey: string;
}

export function isPrivateDiaryCode(value: unknown): value is PrivateDiaryCode {
  return value === PRIVATE_DIARY_CODES.FREE_TEXT || value === PRIVATE_DIARY_CODES.QUICK;
}

export function normalizePrivateDiaryQuickMood(value: unknown): PrivateDiaryQuickMood | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (Object.hasOwn(PRIVATE_DIARY_QUICK_MOODS, normalized)) return normalized as PrivateDiaryQuickMood;
  const labels: Record<string, PrivateDiaryQuickMood> = { 难受: 'DISTRESSED', 生气: 'ANGRY', 没力气: 'LOW_ENERGY', 说不清: 'UNCLEAR' };
  return labels[normalized];
}

export function isPrivateDiaryEntry(value: unknown): value is PrivateDiaryEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item);
  if (keys.some(key => !['id', 'patientId', 'code', 'valueText', 'valueCoded', 'observedAt', 'recordedAt', 'source', 'tags', 'visibleTo', 'revision'].includes(key))) return false;
  if (typeof item.id !== 'string' || typeof item.patientId !== 'string' || !isPrivateDiaryCode(item.code)) return false;
  if (item.valueText !== undefined && typeof item.valueText !== 'string') return false;
  if (item.valueCoded !== undefined && !normalizePrivateDiaryQuickMood(item.valueCoded)) return false;
  if (typeof item.observedAt !== 'string' || typeof item.recordedAt !== 'string' || item.source !== 'PATIENT_REPORTED') return false;
  if (!Array.isArray(item.tags) || item.tags.length !== 1 || item.tags[0] !== PRIVATE_DIARY_TAG) return false;
  if (!Array.isArray(item.visibleTo) || item.visibleTo.length !== 1 || item.visibleTo[0] !== 'SELF') return false;
  return Number.isSafeInteger(item.revision) && Number(item.revision) > 0;
}

function shareText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[\0\r\n]/.test(value);
}

function shareIso(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}
