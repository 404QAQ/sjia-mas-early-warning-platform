import { request } from './api';
import { assertClinicalScope, clinicalMutation } from './clinical-data';
import type { ArchiveScope } from './clinical-archive';
import { validFollowupDate } from './local-followup';

export interface SelfFollowup {
  id: string; patientId: string; date: string; hospital: string; department: string; doctor: string; examItems: string; note: string;
  status: 'SCHEDULED' | 'COMPLETED' | 'CANCELLED'; version: number; createdAt: string; updatedAt: string; createdBy: string;
}
export type FollowupDraft = Pick<SelfFollowup, 'date' | 'hospital' | 'department' | 'doctor' | 'examItems' | 'note' | 'status'>;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
export function parseSelfFollowup(value: unknown, patientId: string): SelfFollowup {
  if (!object(value) || value.patientId !== patientId || typeof value.id !== 'string' || !value.id || typeof value.date !== 'string' || !validFollowupDate(value.date) || !['SCHEDULED', 'COMPLETED', 'CANCELLED'].includes(String(value.status)) || !Number.isSafeInteger(value.version) || Number(value.version) < 1 || !['hospital', 'department', 'doctor', 'examItems', 'note', 'createdBy'].every(key => typeof value[key] === 'string') || !['createdAt', 'updatedAt'].every(key => typeof value[key] === 'string' && Number.isFinite(Date.parse(value[key] as string)))) throw new Error('复诊安排响应不完整，请重试。');
  return value as unknown as SelfFollowup;
}
export async function loadSelfFollowups(scope: ArchiveScope): Promise<SelfFollowup[]> {
  assertClinicalScope(scope);
  const data = await request<unknown>(`/api/v1/patients/${encodeURIComponent(scope.patientId)}/self-followups`);
  assertClinicalScope(scope);
  if (!object(data) || !Array.isArray(data.records)) throw new Error('自记复诊暂时无法读取。');
  return data.records.map(row => parseSelfFollowup(row, scope.patientId)).sort((a, b) => a.date.localeCompare(b.date));
}
export function saveSelfFollowup(scope: ArchiveScope, draft: FollowupDraft, previous?: SelfFollowup): Promise<SelfFollowup> {
  if (!validFollowupDate(draft.date)) throw new Error('请选择有效的复诊日期。');
  const path = `/api/v1/patients/${encodeURIComponent(scope.patientId)}/self-followups${previous ? `/${encodeURIComponent(previous.id)}` : ''}`;
  return clinicalMutation(scope, `followup:${previous?.id ?? 'new'}`, path, previous ? 'PUT' : 'POST', { ...draft, expectedVersion: previous?.version ?? 0 }, value => {
    if (!object(value)) throw new Error('复诊保存回执无效。'); return parseSelfFollowup(value.record, scope.patientId);
  });
}
export function nextSelfFollowup(rows: SelfFollowup[], today: string): SelfFollowup | undefined { return rows.filter(row => row.status === 'SCHEDULED' && row.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0]; }
