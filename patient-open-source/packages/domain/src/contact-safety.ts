/**
 * 联系人 CL3 事前授权的领域约束。
 *
 * 这里不读取时钟、数据库或当前 Actor；服务层负责确认操作者身份，
 * 本模块只负责验证不可变授权快照和版本状态，便于历史重放与事务测试。
 */

export type ContactAuthorizationStatus = 'ACTIVE' | 'WITHDRAWN';
export type ContactAuthorizationPriority = 1 | 2;
export type ContactAuthorizationVisibility = 'G1_NOTIFY' | 'G2_SUMMARY';
export type ContactAuthorizationFreshness = 'CURRENT' | 'DUE' | 'STALE' | 'NONE';

export interface QuietHours {
  from: string;
  to: string;
}

export interface ContactAuthorization {
  id: string;
  patientId: string;
  contactId: string;
  status: ContactAuthorizationStatus;
  priority: ContactAuthorizationPriority;
  visibility: ContactAuthorizationVisibility;
  quietHours?: QuietHours;
  /** 患者确认时展示给患者的不可变文本快照。 */
  consentText: string;
  grantedBy: string;
  grantedAt: string;
  lastConfirmedAt: string;
  version: number;
  withdrawnBy?: string;
  withdrawnAt?: string;
}

export interface GrantContactAuthorizationInput {
  patientId: string;
  contactId: string;
  priority: ContactAuthorizationPriority;
  visibility: ContactAuthorizationVisibility;
  quietHours?: QuietHours;
  consentText: string;
  grantedBy: string;
  grantedAt: string;
  lastConfirmedAt?: string;
  expectedVersion: number;
  idempotencyKey: string;
}

export interface WithdrawContactAuthorizationInput {
  patientId: string;
  contactId: string;
  withdrawnBy: string;
  withdrawnAt: string;
  expectedVersion: number;
  idempotencyKey: string;
}

export interface ConfirmContactAuthorizationInput {
  patientId: string;
  contactId: string;
  confirmedBy: string;
  confirmedAt: string;
  expectedVersion: number;
  idempotencyKey: string;
}

export interface ContactAuthorizationFreshnessView {
  freshness: ContactAuthorizationFreshness;
  /** UTC instant at which the six-calendar-month confirmation becomes due. */
  nextConfirmAt: string | null;
}

/**
 * Patient-level freshness projection for clinical readers.
 *
 * This deliberately contains aggregate counts only. It is suitable for the
 * doctor detail snapshot without exposing a contact identity, phone number or
 * consent text. The aggregate severity is the most urgent active state.
 */
export interface ContactAuthorizationFreshnessSummary {
  freshness: ContactAuthorizationFreshness;
  activeCount: number;
  currentCount: number;
  dueCount: number;
  staleCount: number;
}

export class ContactAuthorizationError extends Error {
  constructor(public readonly code: ContactAuthorizationErrorCode, message: string) {
    super(message);
    this.name = 'ContactAuthorizationError';
  }
}

export type ContactAuthorizationErrorCode =
  | 'CONTACT_AUTHORIZATION_INVALID'
  | 'CONTACT_AUTHORIZATION_VERSION_CONFLICT'
  | 'CONTACT_AUTHORIZATION_IDENTITY_CONFLICT'
  | 'CONTACT_AUTHORIZATION_ALREADY_WITHDRAWN'
  | 'CONTACT_AUTHORIZATION_NOT_ACTIVE';

export function grantContactAuthorization(
  previous: ContactAuthorization | undefined,
  input: GrantContactAuthorizationInput,
): ContactAuthorization {
  validateGrantInput(input);
  const expected = previous?.version ?? 0;
  if (input.expectedVersion !== expected) throw new ContactAuthorizationError('CONTACT_AUTHORIZATION_VERSION_CONFLICT', '联系人授权版本已变化，请刷新后重试');
  if (previous && (previous.patientId !== input.patientId || previous.contactId !== input.contactId)) {
    throw new ContactAuthorizationError('CONTACT_AUTHORIZATION_IDENTITY_CONFLICT', '联系人授权主体不匹配');
  }
  const version = expected + 1;
  return {
    id: `${input.patientId}:${input.contactId}:${version}`,
    patientId: input.patientId,
    contactId: input.contactId,
    status: 'ACTIVE',
    priority: input.priority,
    visibility: input.visibility,
    ...(input.quietHours === undefined ? {} : { quietHours: { ...input.quietHours } }),
    consentText: input.consentText,
    grantedBy: input.grantedBy,
    grantedAt: input.grantedAt,
    lastConfirmedAt: input.lastConfirmedAt ?? input.grantedAt,
    version,
  };
}

export function withdrawContactAuthorization(
  previous: ContactAuthorization,
  input: WithdrawContactAuthorizationInput,
): ContactAuthorization {
  validateWithdrawInput(input);
  if (previous.patientId !== input.patientId || previous.contactId !== input.contactId) {
    throw new ContactAuthorizationError('CONTACT_AUTHORIZATION_IDENTITY_CONFLICT', '联系人授权主体不匹配');
  }
  if (input.expectedVersion !== previous.version) throw new ContactAuthorizationError('CONTACT_AUTHORIZATION_VERSION_CONFLICT', '联系人授权版本已变化，请刷新后重试');
  if (previous.status === 'WITHDRAWN') throw new ContactAuthorizationError('CONTACT_AUTHORIZATION_ALREADY_WITHDRAWN', '联系人授权已经撤回');
  return {
    ...structuredClone(previous),
    id: `${input.patientId}:${input.contactId}:${previous.version + 1}`,
    status: 'WITHDRAWN',
    version: previous.version + 1,
    withdrawnBy: input.withdrawnBy,
    withdrawnAt: input.withdrawnAt,
  };
}

/**
 * Confirm an active contact authorization by appending a new immutable version.
 * The consent, priority, visibility and quiet-hours snapshot remain unchanged;
 * only the confirmation timestamp and version advance.
 */
export function confirmContactAuthorization(
  previous: ContactAuthorization,
  input: ConfirmContactAuthorizationInput,
): ContactAuthorization {
  validateConfirmInput(input);
  validateContactAuthorization(previous);
  if (previous.patientId !== input.patientId || previous.contactId !== input.contactId) {
    throw new ContactAuthorizationError('CONTACT_AUTHORIZATION_IDENTITY_CONFLICT', '联系人授权主体不匹配');
  }
  if (input.expectedVersion !== previous.version) throw new ContactAuthorizationError('CONTACT_AUTHORIZATION_VERSION_CONFLICT', '联系人授权版本已变化，请刷新后重试');
  if (previous.status !== 'ACTIVE') throw new ContactAuthorizationError('CONTACT_AUTHORIZATION_NOT_ACTIVE', '已撤回的联系人授权不能确认');
  return {
    ...structuredClone(previous),
    id: `${input.patientId}:${input.contactId}:${previous.version + 1}`,
    status: 'ACTIVE',
    lastConfirmedAt: input.confirmedAt,
    version: previous.version + 1,
    withdrawnBy: undefined,
    withdrawnAt: undefined,
  };
}

/**
 * Derive the six/twelve calendar-month freshness state in UTC. Stored ISO
 * instants are normalized to UTC calendar fields; at exactly +6 months the
 * state becomes DUE, and at exactly +12 months it becomes STALE. Month-end
 * dates clamp to the last day of the target month (31 Jan -> 31 Jul).
 */
export function contactAuthorizationFreshness(record: ContactAuthorization | undefined, at: string): ContactAuthorizationFreshnessView {
  if (record !== undefined) validateContactAuthorization(record);
  if (!record || record.status !== 'ACTIVE') return { freshness: 'NONE', nextConfirmAt: null };
  if (!iso(at)) invalid('新鲜度计算时间无效');
  const nextConfirmAt = addCalendarMonthsUtc(record.lastConfirmedAt, 6);
  const staleAt = addCalendarMonthsUtc(record.lastConfirmedAt, 12);
  const now = Date.parse(at);
  const due = Date.parse(nextConfirmAt);
  const stale = Date.parse(staleAt);
  return { freshness: now < due ? 'CURRENT' : now < stale ? 'DUE' : 'STALE', nextConfirmAt };
}

/**
 * Collapse the latest authorization snapshot for each contact into one
 * patient-level marker. Repositories already return one latest row per
 * contact; duplicate rows are still handled deterministically for callers
 * using a plain array.
 */
export function summarizeContactAuthorizationFreshness(
  records: readonly ContactAuthorization[],
  at: string,
): ContactAuthorizationFreshnessSummary {
  if (!iso(at)) invalid('新鲜度计算时间无效');
  const latest = new Map<string, ContactAuthorization>();
  for (const record of records) {
    validateContactAuthorization(record);
    const previous = latest.get(record.contactId);
    if (!previous || record.version > previous.version) latest.set(record.contactId, record);
  }
  let currentCount = 0;
  let dueCount = 0;
  let staleCount = 0;
  for (const record of latest.values()) {
    const state = contactAuthorizationFreshness(record, at).freshness;
    if (state === 'CURRENT') currentCount += 1;
    else if (state === 'DUE') dueCount += 1;
    else if (state === 'STALE') staleCount += 1;
  }
  const activeCount = currentCount + dueCount + staleCount;
  const freshness: ContactAuthorizationFreshness = staleCount > 0 ? 'STALE' : dueCount > 0 ? 'DUE' : activeCount > 0 ? 'CURRENT' : 'NONE';
  return { freshness, activeCount, currentCount, dueCount, staleCount };
}

export function isContactAuthorizationActive(record: ContactAuthorization | undefined, _at: string): boolean {
  return record?.status === 'ACTIVE';
}

export function validateContactAuthorization(record: ContactAuthorization): void {
  if (!record || typeof record !== 'object') invalid('授权记录必须是对象');
  if (!text(record.id) || !text(record.patientId) || !text(record.contactId)) invalid('授权主体不能为空');
  if (record.status !== 'ACTIVE' && record.status !== 'WITHDRAWN') invalid('授权状态无效');
  if (record.priority !== 1 && record.priority !== 2) invalid('联系人顺位无效');
  if (record.visibility !== 'G1_NOTIFY' && record.visibility !== 'G2_SUMMARY') invalid('联系人可见范围无效');
  if (!consent(record.consentText)) invalid('授权文本无效');
  if (!text(record.grantedBy) || !iso(record.grantedAt) || !iso(record.lastConfirmedAt)) invalid('授权时间或授权人无效');
  if (!Number.isSafeInteger(record.version) || record.version < 1) invalid('授权版本无效');
  if (record.withdrawnBy !== undefined && !text(record.withdrawnBy)) invalid('撤回人无效');
  if (record.withdrawnAt !== undefined && !iso(record.withdrawnAt)) invalid('撤回时间无效');
  if (record.status === 'WITHDRAWN' && (!record.withdrawnBy || !record.withdrawnAt)) invalid('已撤回授权必须记录撤回人和撤回时间');
  if (record.status === 'ACTIVE' && (record.withdrawnBy !== undefined || record.withdrawnAt !== undefined)) invalid('有效授权不能携带撤回信息');
  if (record.quietHours !== undefined) validateQuietHours(record.quietHours);
}

function validateGrantInput(input: GrantContactAuthorizationInput): void {
  if (!input || typeof input !== 'object') invalid('授权请求无效');
  if (!text(input.patientId) || !text(input.contactId) || !text(input.grantedBy)) invalid('授权主体不能为空');
  if (input.priority !== 1 && input.priority !== 2) invalid('联系人顺位无效');
  if (input.visibility !== 'G1_NOTIFY' && input.visibility !== 'G2_SUMMARY') invalid('联系人可见范围无效');
  if (!consent(input.consentText)) invalid('授权文本无效');
  if (!iso(input.grantedAt) || (input.lastConfirmedAt !== undefined && !iso(input.lastConfirmedAt))) invalid('授权时间无效');
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) invalid('预期授权版本无效');
  if (!key(input.idempotencyKey)) invalid('幂等键无效');
  if (input.quietHours !== undefined) validateQuietHours(input.quietHours);
}

function validateWithdrawInput(input: WithdrawContactAuthorizationInput): void {
  if (!input || typeof input !== 'object') invalid('撤回请求无效');
  if (!text(input.patientId) || !text(input.contactId) || !text(input.withdrawnBy)) invalid('撤回主体不能为空');
  if (!iso(input.withdrawnAt)) invalid('撤回时间无效');
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) invalid('预期授权版本无效');
  if (!key(input.idempotencyKey)) invalid('幂等键无效');
}

function validateConfirmInput(input: ConfirmContactAuthorizationInput): void {
  if (!input || typeof input !== 'object') invalid('联系人确认请求无效');
  if (!text(input.patientId) || !text(input.contactId) || !text(input.confirmedBy)) invalid('联系人确认主体不能为空');
  if (!iso(input.confirmedAt)) invalid('联系人确认时间无效');
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) invalid('预期授权版本无效');
  if (!key(input.idempotencyKey)) invalid('幂等键无效');
}

function validateQuietHours(value: QuietHours): void {
  if (!value || typeof value !== 'object' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.from) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.to)) invalid('勿扰时段必须为 HH:mm');
  if (value.from === value.to) invalid('勿扰时段不能为空');
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\0\r\n]/.test(value);
}

function key(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[\0\r\n]/.test(value);
}

function consent(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 2000 && !/[\0\r\n]/.test(value);
}

function iso(value: unknown): value is string {
  return typeof value === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}

function addCalendarMonthsUtc(value: string, months: number): string {
  const source = new Date(value);
  const year = source.getUTCFullYear();
  const month = source.getUTCMonth();
  const day = source.getUTCDate();
  const targetIndex = month + months;
  const targetYear = year + Math.floor(targetIndex / 12);
  const targetMonth = ((targetIndex % 12) + 12) % 12;
  const monthEnd = new Date(0);
  monthEnd.setUTCHours(0, 0, 0, 0);
  monthEnd.setUTCFullYear(targetYear, targetMonth + 1, 0);
  const lastDay = monthEnd.getUTCDate();
  // `Date.UTC(1, ...)` treats 1 as 1901 for legacy compatibility. Mutating
  // the parsed Date with setUTCFullYear keeps calendar years 0000–0099 exact.
  const result = new Date(source.getTime());
  result.setUTCFullYear(targetYear, targetMonth, Math.min(day, lastDay));
  return result.toISOString();
}

function invalid(message: string): never {
  throw new ContactAuthorizationError('CONTACT_AUTHORIZATION_INVALID', message);
}
