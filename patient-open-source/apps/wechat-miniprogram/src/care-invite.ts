import { request } from './api';

/**
 * 患者邀请医生加入照护团队（ADR-005「患者端」接口）。
 *
 * 签发响应里的明文码只出现这一次：这里只解析并交给页面放进 data，不写本机存储、
 * 不进离线队列（MutationOutbox 会把请求和结果持久化），也没有幂等键 —— 明文码不可重放。
 */
export interface IssuedCareInvite { inviteId: string; patientId: string; code: string; issuedAt: string; expiresAt: string; ttlHours: number; supersededCount: number; script: string; }
export interface PendingCareInvite { inviteId: string; issuedAt: string; expiresAt: string; }
export interface InvitedClinician { inviteId: string; acceptedAt: string; clinicianLabel: string; active: boolean; removedAt?: string; }
export interface CareInviteOverview { patientId: string; asOf: string; pending: PendingCareInvite | null; invited: InvitedClinician[]; policy: { ttlHours: number; maxIssuesPerHour: number }; }
export interface RevokedCareInvite { inviteId: string; status: 'REVOKED'; closedAt: string; }
export interface RemovedClinician { inviteId: string; membershipId: string; removedAt: string; }

const CODE_FORMAT = /^[0-9A-Z]{4}-[0-9A-Z]{4}$/;
const MAX_INVITED = 50;

function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function text(value: unknown, max = 500): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\0\r\n]/.test(value); }
function instant(value: unknown): value is string { return text(value, 80) && Number.isFinite(Date.parse(value)); }
function only(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).every(key => keys.includes(key)); }
function count(value: unknown, min: number): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min; }
function base(patientId: string): string { return `/api/v1/patients/${encodeURIComponent(patientId)}/care-invites`; }

export function parseIssuedInvite(value: unknown, patientId: string): IssuedCareInvite {
  if (!object(value) || !only(value, ['inviteId', 'patientId', 'code', 'issuedAt', 'expiresAt', 'ttlHours', 'supersededCount', 'script']) || !text(value.inviteId, 200) || value.patientId !== patientId ||
    typeof value.code !== 'string' || !CODE_FORMAT.test(value.code) || !instant(value.issuedAt) || !instant(value.expiresAt) || Date.parse(value.expiresAt) <= Date.parse(value.issuedAt) ||
    !count(value.ttlHours, 1) || !count(value.supersededCount, 0) || !text(value.script, 1000) || !value.script.includes(value.code)) throw new Error('邀请码响应格式无效，请刷新后查看是否已生成。');
  return { inviteId: value.inviteId, patientId, code: value.code, issuedAt: value.issuedAt, expiresAt: value.expiresAt, ttlHours: value.ttlHours, supersededCount: value.supersededCount, script: value.script };
}

function parsePending(value: unknown): PendingCareInvite | null {
  if (value === null) return null;
  if (!object(value) || !only(value, ['inviteId', 'issuedAt', 'expiresAt']) || !text(value.inviteId, 200) || !instant(value.issuedAt) || !instant(value.expiresAt)) throw new Error('待使用邀请码格式无效。');
  return { inviteId: value.inviteId, issuedAt: value.issuedAt, expiresAt: value.expiresAt };
}

function parseInvited(value: unknown): InvitedClinician {
  if (!object(value) || !only(value, ['inviteId', 'acceptedAt', 'clinicianLabel', 'active', 'removedAt']) || !text(value.inviteId, 200) || !instant(value.acceptedAt) || !text(value.clinicianLabel, 200) ||
    typeof value.active !== 'boolean' || value.removedAt !== undefined && (!instant(value.removedAt) || value.active)) throw new Error('受邀医生条目格式无效。');
  return { inviteId: value.inviteId, acceptedAt: value.acceptedAt, clinicianLabel: value.clinicianLabel, active: value.active, ...(value.removedAt === undefined ? {} : { removedAt: value.removedAt as string }) };
}

export function parseInviteOverview(value: unknown, patientId: string): CareInviteOverview {
  if (!object(value) || !only(value, ['patientId', 'asOf', 'pending', 'invited', 'policy']) || value.patientId !== patientId || !instant(value.asOf) || !('pending' in value) ||
    !Array.isArray(value.invited) || value.invited.length > MAX_INVITED || !object(value.policy) || !only(value.policy, ['ttlHours', 'maxIssuesPerHour']) ||
    !count(value.policy.ttlHours, 1) || !count(value.policy.maxIssuesPerHour, 1)) throw new Error('邀请记录响应格式无效。');
  return { patientId, asOf: value.asOf, pending: parsePending(value.pending), invited: value.invited.map(parseInvited), policy: { ttlHours: value.policy.ttlHours, maxIssuesPerHour: value.policy.maxIssuesPerHour } };
}

export function parseRevoked(value: unknown, inviteId: string): RevokedCareInvite {
  if (!object(value) || !only(value, ['inviteId', 'status', 'closedAt']) || value.inviteId !== inviteId || value.status !== 'REVOKED' || !instant(value.closedAt)) throw new Error('作废回执不完整，请刷新后核对。');
  return { inviteId, status: 'REVOKED', closedAt: value.closedAt };
}

export function parseRemoved(value: unknown, inviteId: string): RemovedClinician {
  if (!object(value) || !only(value, ['inviteId', 'membershipId', 'removedAt']) || value.inviteId !== inviteId || !text(value.membershipId, 300) || !instant(value.removedAt)) throw new Error('移除回执不完整，请刷新后核对。');
  return { inviteId, membershipId: value.membershipId, removedAt: value.removedAt };
}

export async function issueCareInvite(patientId: string): Promise<IssuedCareInvite> {
  return parseIssuedInvite(await request<unknown>(base(patientId), 'POST', {}), patientId);
}

export async function loadCareInvites(patientId: string): Promise<CareInviteOverview> {
  return parseInviteOverview(await request<unknown>(base(patientId)), patientId);
}

export async function revokeCareInvite(patientId: string, inviteId: string): Promise<RevokedCareInvite> {
  return parseRevoked(await request<unknown>(`${base(patientId)}/${encodeURIComponent(inviteId)}/revoke`, 'POST', {}), inviteId);
}

export async function removeInvitedClinician(patientId: string, inviteId: string): Promise<RemovedClinician> {
  return parseRemoved(await request<unknown>(`${base(patientId)}/${encodeURIComponent(inviteId)}/remove`, 'POST', {}), inviteId);
}
