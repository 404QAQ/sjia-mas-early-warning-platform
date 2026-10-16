/** 患者录入的是已有医嘱的记录安排，来源不得与医生确认的治疗方案混淆。 */
export interface MedicationProvenance {
  source?: 'CLINICIAN' | 'PATIENT_REPORTED'; prescriptionNote?: string; version?: number;
  originReportedPlanId?: string; reviewedPlanId?: string; confirmedAt?: string;
}
export interface PlanDraft {
  id: string; expectedVersion: number; kind: string; drug: string; dose: string; unit: string;
  route: string; frequency: string; startDate: string; originalStartedAt: string;
  prescriptionNote: string; status: string;
}
export const PLAN_KIND_OPTIONS = [{ value: 'SUPPORTIVE', label: '其他处方用药' }, { value: 'STEROID', label: '激素' }, { value: 'BIOLOGIC', label: '生物制剂' }];
export const PLAN_ROUTE_OPTIONS = [{ value: 'ORAL', label: '口服' }, { value: 'SC_INJECTION', label: '皮下注射' }];
export const PLAN_FREQUENCY_OPTIONS = [{ value: 'DAILY', label: '每日' }, { value: 'WEEKLY', label: '每周' }, { value: 'EVERY_4_WEEKS', label: '每 4 周' }, { value: 'AS_NEEDED', label: '按需' }];
export const PLAN_STATUS_OPTIONS = [{ value: 'ACTIVE', label: '继续记录' }, { value: 'PAUSED', label: '暂停记录' }, { value: 'STOPPED', label: '结束记录' }];
export function emptyPlanDraft(startDate = ''): PlanDraft {
  return { id: '', expectedVersion: 0, kind: 'SUPPORTIVE', drug: '', dose: '', unit: '', route: 'ORAL', frequency: 'DAILY', startDate, originalStartedAt: '', prescriptionNote: '', status: 'ACTIVE' };
}
function cleanText(value: unknown, max: number): value is string { return typeof value === 'string' && Boolean(value.trim()) && value.length <= max && !/[\x00-\x1f\x7f]/.test(value); }
export function validMedicationProvenance(value: Record<string, unknown>): boolean {
  if (value.confirmedAt !== undefined && (typeof value.confirmedAt !== 'string' || !Number.isFinite(Date.parse(value.confirmedAt)))) return false;
  if (value.source !== undefined && value.source !== 'CLINICIAN' && value.source !== 'PATIENT_REPORTED') return false;
  if (value.prescriptionNote !== undefined && !cleanText(value.prescriptionNote, 300)) return false;
  if (value.version !== undefined && (!Number.isSafeInteger(value.version) || Number(value.version) < 1)) return false;
  if (value.originReportedPlanId !== undefined && !cleanText(value.originReportedPlanId, 256)) return false;
  if (value.reviewedPlanId !== undefined && !cleanText(value.reviewedPlanId, 256)) return false;
  return value.source !== 'PATIENT_REPORTED' || Boolean(value.prescriptionNote && value.version);
}
export function buildReportedPlanPayload(draft: PlanDraft, idempotencyKey: string): Record<string, unknown> {
  const drug = draft.drug.trim(), unit = draft.unit.trim(), prescriptionNote = draft.prescriptionNote.trim();
  if (!cleanText(drug, 200)) throw new Error('请填写处方上的药品名称（最多 200 字）。');
  if (!draft.dose.trim() || !Number.isFinite(Number(draft.dose)) || Number(draft.dose) <= 0) throw new Error('请填写处方上的单次剂量，必须大于 0。');
  if (!cleanText(unit, 32)) throw new Error('请填写剂量单位，例如 mg、片或 ml。');
  if (!cleanText(prescriptionNote, 300)) throw new Error('请填写医嘱来源，例如医院、处方日期或出院医嘱（最多 300 字）。');
  if (!PLAN_KIND_OPTIONS.some(item => item.value === draft.kind) || !PLAN_ROUTE_OPTIONS.some(item => item.value === draft.route) || !PLAN_FREQUENCY_OPTIONS.some(item => item.value === draft.frequency) || !PLAN_STATUS_OPTIONS.some(item => item.value === draft.status)) throw new Error('请选择有效的用药类别、途径、频率和记录状态。');
  const at = Date.parse(`${draft.startDate}T00:00:00+08:00`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.startDate) || !Number.isFinite(at) || new Date(at + 8 * 3600000).toISOString().slice(0, 10) !== draft.startDate) throw new Error('请选择有效的开始日期。');
  const original = Date.parse(draft.originalStartedAt);
  const originalDate = Number.isFinite(original) ? new Date(original + 8 * 3600000).toISOString().slice(0, 10) : '';
  const startedAt = originalDate === draft.startDate ? draft.originalStartedAt : new Date(at).toISOString();
  const payload: Record<string, unknown> = { idempotencyKey, kind: draft.kind, drug, dose: Number(draft.dose), unit, route: draft.route, frequency: draft.frequency, startedAt, prescriptionNote };
  if (draft.id) {
    if (!Number.isSafeInteger(draft.expectedVersion) || draft.expectedVersion < 1) throw new Error('记录安排已变化，请刷新后再编辑。');
    Object.assign(payload, { planId: draft.id, expectedVersion: draft.expectedVersion, status: draft.status });
  }
  return payload;
}
