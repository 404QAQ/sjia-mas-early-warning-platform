import { request } from './api';
import { assertClinicalScope, clinicalMutation } from './clinical-data';
import type { ArchiveScope } from './clinical-archive';

export interface MedicationReminder {
  id: string; patientId: string; planId: string; dueAt: string;
  status: 'SCHEDULED' | 'DUE' | 'COMPLETED' | 'CANCELLED';
  version: number; createdAt: string; updatedAt: string; createdBy: string; updatedBy: string;
  channel: 'IN_APP'; notifiedAt?: string;
}
export interface MedicationReminders { records: MedicationReminder[]; asOf: string; }
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\0\r\n]/.test(value);
const instant = (value: unknown): value is string => typeof value === 'string' && value.length <= 80 && Number.isFinite(Date.parse(value));
function base(scope: ArchiveScope): string { assertClinicalScope(scope); return `/api/v1/patients/${encodeURIComponent(scope.patientId)}`; }

export function parseMedicationReminder(value: unknown, scope: ArchiveScope): MedicationReminder {
  if (!object(value) || !text(value.id) || value.patientId !== scope.patientId || !text(value.planId) || !instant(value.dueAt)
    || !['SCHEDULED', 'DUE', 'COMPLETED', 'CANCELLED'].includes(String(value.status))
    || !Number.isSafeInteger(value.version) || Number(value.version) < 1 || !instant(value.createdAt) || !instant(value.updatedAt)
    || !text(value.createdBy) || !text(value.updatedBy) || value.channel !== 'IN_APP' || value.notifiedAt !== undefined && !instant(value.notifiedAt)) {
    throw new Error('用药提醒回执无效，请刷新后核对。');
  }
  return value as unknown as MedicationReminder;
}

export async function loadMedicationReminders(scope: ArchiveScope): Promise<MedicationReminders> {
  const data = await request<unknown>(`${base(scope)}/medication-reminders`); assertClinicalScope(scope);
  if (!object(data) || !Array.isArray(data.records) || !instant(data.asOf)) throw new Error('用药提醒暂时无法读取，请重试。');
  const records = data.records.map(row => parseMedicationReminder(row, scope));
  if (new Set(records.map(row => row.id)).size !== records.length || new Set(records.map(row => row.planId)).size !== records.length) throw new Error('用药提醒列表异常，请刷新后核对。');
  return { records, asOf: data.asOf };
}

export async function saveMedicationReminder(scope: ArchiveScope, planId: string, delayHours: 1 | 2, expectedVersion: number): Promise<MedicationReminder> {
  if (!text(planId) || ![1, 2].includes(delayHours) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error('请选择有效的稍后提醒时间。');
  return clinicalMutation(scope, `medication-reminder:${planId}`, `${base(scope)}/medication-plans/${encodeURIComponent(planId)}/reminder`, 'POST', { delayHours, expectedVersion }, value => {
    if (!object(value) || typeof value.created !== 'boolean') throw new Error('提醒保存结果尚未确认，请重试。');
    const row = parseMedicationReminder(value.record, scope);
    if (row.planId !== planId) throw new Error('提醒回执与当前用药不一致，请重新读取。');
    return row;
  });
}

export function medicationReminderLabel(row: MedicationReminder): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(row.dueAt)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  const at = `${Number(parts.month)}月${Number(parts.day)}日 ${parts.hour}:${parts.minute}`;
  if (row.status === 'COMPLETED') return '服药已记录 · 本次提醒已结束';
  if (row.status === 'CANCELLED') return '用药安排已变化 · 本次提醒已取消';
  if (row.status === 'DUE') return `${at} 站内提醒已到，请核对服药情况`;
  return `${at} 再提醒（站内）`;
}
