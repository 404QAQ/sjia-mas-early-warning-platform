import { ApiFailure, patientId, request, session } from '../../api';
import { buildReportedPlanPayload, emptyPlanDraft, validMedicationProvenance, PLAN_KIND_OPTIONS, PLAN_ROUTE_OPTIONS, PLAN_FREQUENCY_OPTIONS, PLAN_STATUS_OPTIONS, type MedicationProvenance, type PlanDraft } from '../../medication-plan-editor';
import { parseCareCapabilities, type CareCapabilities } from '../../care-capabilities';
import { loadMedicationReminders, saveMedicationReminder, medicationReminderLabel, type MedicationReminder } from '../../medication-reminders';
import { medicationReminderKey } from '../../config';
import { MutationOutbox, deniedOperations, newIdempotencyKey, wxStorage, type MutationEntry } from '../../mutation-outbox';

export interface Plan extends MedicationProvenance { id: string; patientId: string; kind?: 'STEROID' | 'BIOLOGIC' | 'SUPPORTIVE'; drug: string; dose: number; unit: string; route: string; frequency: string; status: 'ACTIVE' | 'PAUSED' | 'STOPPED'; startedAt?: string; schedule?: Array<{ effectiveFrom: string; plannedDose: number }>; scheduleAsOf?: string; }
export interface Log { id: string; patientId: string; planId: string; takenAt: string; actualDose: number; unit: string; source?: string; injectionSite?: InjectionSite; injectionAdministeredBy?: InjectionAdministeredBy; coldChainEvent?: ColdChainEvent; }
interface Today { planId: string; status: 'RECORDED' | 'NOT_RECORDED' | 'NOT_DUE'; lastTakenAt?: string; dueAt?: string; late?: boolean; }
interface TrajectoryPoint { at: string; kind: 'PLAN' | 'ACTUAL'; plannedDose?: number; actualDose?: number; delta?: number; comparison: 'PLANNED' | 'ON_PLAN' | 'ABOVE_PLAN' | 'BELOW_PLAN' | 'UNPLANNED'; unit: string; logId?: string; }
interface Trajectory { source?: 'CLINICIAN' | 'PATIENT_REPORTED'; planId: string; drug: string; status: Plan['status']; frequency: string; unit: string; points: TrajectoryPoint[]; missingWindows: Array<{ dueAt: string; plannedDose: number; unit: string }>; through?: string; deviation?: { direction: 'ON_PLAN' | 'SLOWER' | 'FASTER' | 'STOPPED' | 'INSUFFICIENT_DATA'; daysDeviation: number; detectedAt: string; missingDays?: number }; }
interface Overview { patientId: string; asOf: string; plans: Plan[]; logs: Log[]; today: Today[]; trajectories: Trajectory[]; }
interface MedicationWaveObservation { id: string; code: string; display: string; valueNumeric?: number; valueText?: string; unit: string; observedAt: string; source: string; }
interface MedicationWavePlannedDose { planId: string; drug: string; plannedDose: number; unit: string; dueAt: string; frequency: string; }
interface MedicationWaveActualDose { logId: string; planId: string; drug: string; actualDose: number; unit: string; takenAt: string; source: string; frequency: string; relatedPlanIds: string[]; }
interface MedicationWaveRelationHint { kind: string; text: string; planId?: string; observationIds?: string[]; }
interface MedicationWaveDay { date: string; observations: MedicationWaveObservation[]; planned: MedicationWavePlannedDose[]; actual: MedicationWaveActualDose[]; relationHints: MedicationWaveRelationHint[]; }
interface MedicationWaveView { patientId: string; asOf: string; range: { from: string; to: string; days: 14 }; plans: Array<{ id: string; drug: string; kind: string; route: string; frequency: string; unit: string; status: string }>; days: MedicationWaveDay[]; }
interface MedicationWaveRow { key: string; date: string; observationsText: string; plannedText: string; actualText: string; hintsText: string; state: 'ok' | 'warn' | 'empty'; }
interface PlanTrackRow { key: string; at: string; date: string; kind: 'PLAN' | 'ACTUAL'; label: string; dose: string; status: string; }
interface DeviationRow { key: string; drug: string; label: string; detail: string; }
interface CalendarPlanRow extends Plan { key: string; recorded: boolean; doseLabel: string; actualDoseLabel: string; takenAtLabel: string; }
interface SideEffect { id: string; patientId: string; symptomCode: string; severity: string; label: string; guidance: string; reportedAt: string; handledAt?: string; photoRef?: string; note?: string; followUpTaskId?: string; alertId?: string; routing: { createsClinicalAlert: boolean; createsFollowUp: boolean; immediateMessage: boolean }; }
interface SideEffectDefinition { code: string; severity: string; label: string; guidance: string; }
interface Screening { patientId: string; type: string; dueAt: string; dueAtLabel?: string; intervalMonths: number | null; lastDoneAt?: string; doneAt?: string; doneAtFacility?: string; extendedByClinician?: boolean; extendedAt?: string; status?: string; definition?: { type: string; label: string; defaultIntervalMonths?: number; reason: string }; evaluation?: { status: string; daysUntilDue: number; priority: 'MAINTAINED' }; }
interface Scope { userId: string; actorId: string; patientId: string; }
interface CalendarDay { key: string; day: number; label: string; inMonth: boolean; state: 'TAKEN' | 'PARTIAL' | 'EMPTY' | 'FUTURE'; }
interface CalendarSelection { key: string; label: string; logs: Log[]; duePlans: Plan[]; }
const ROUTE_LABELS: Record<string, string> = { ORAL: '口服', SC_INJECTION: '皮下注射' };
const FREQUENCY_LABELS: Record<string, string> = { DAILY: '每日', WEEKLY: '每周', EVERY_4_WEEKS: '每 4 周', AS_NEEDED: '按需' };
const SCREENING_LABELS: Record<string, string> = { OPHTHALMOLOGY: '眼科检查', BONE_DENSITY: '骨密度检查', GROWTH: '生长发育评估', BP_GLUCOSE: '血压/血糖检查', DENTAL: '口腔检查' };
const SIDE_EFFECT_SEVERITY_LABELS: Record<string, string> = { EXPECTED: '常见', MONITOR: '需观察', REPORT: '需报告', URGENT: '需尽快处理' };
const INJECTION_SITE_LABELS: Record<string, string> = { LUQ: '左上象限', RUQ: '右上象限', LLQ: '左下象限', RLQ: '右下象限' };
export type InjectionSite = 'LUQ' | 'RUQ' | 'LLQ' | 'RLQ';
export type InjectionAdministeredBy = 'SELF' | 'FAMILY' | 'NURSE';
export type ColdChainType = 'UNREFRIGERATED' | 'FROZEN' | 'TEMPERATURE_EXCURSION' | 'TRANSPORT_DELAY' | 'OTHER';
export interface ColdChainEvent { type: ColdChainType; durationHours: number; reportedAt: string; }
export interface InjectionSummary { lastSite?: InjectionSite; suggestedSite?: InjectionSite; consecutiveCount: number; }
export interface InjectionDraft { site: string; administeredBy: string; coldChainEnabled: boolean; coldChainType: string; durationHours: string; reportedAt: string; }

export const INJECTION_SITE_OPTIONS = [
  { value: '', label: '请选择注射部位' },
  { value: 'LUQ', label: '左上象限' },
  { value: 'RUQ', label: '右上象限' },
  { value: 'LLQ', label: '左下象限' },
  { value: 'RLQ', label: '右下象限' },
] as const;
export const INJECTION_ADMIN_OPTIONS = [
  { value: '', label: '请选择注射人' },
  { value: 'SELF', label: '患者本人' },
  { value: 'FAMILY', label: '家属/照护者' },
  { value: 'NURSE', label: '护士' },
] as const;
export const COLD_CHAIN_OPTIONS = [
  { value: '', label: '请选择冷链事实' },
  { value: 'UNREFRIGERATED', label: '曾离开冷藏' },
  { value: 'FROZEN', label: '曾冻结' },
  { value: 'TEMPERATURE_EXCURSION', label: '温度偏离' },
  { value: 'TRANSPORT_DELAY', label: '运输延误' },
  { value: 'OTHER', label: '其他情况' },
] as const;
const INJECTION_SITES: readonly InjectionSite[] = ['LUQ', 'RUQ', 'LLQ', 'RLQ'];
const INJECTION_ADMINS: readonly InjectionAdministeredBy[] = ['SELF', 'FAMILY', 'NURSE'];
const COLD_CHAIN_TYPES: readonly ColdChainType[] = ['UNREFRIGERATED', 'FROZEN', 'TEMPERATURE_EXCURSION', 'TRANSPORT_DELAY', 'OTHER'];

function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function text(value: unknown, max = 4096): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value); }
function validInstant(value: unknown): value is string { return text(value, 80) && Number.isFinite(Date.parse(value)); }
function only(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).every(key => keys.includes(key)); }
function currentScope(): Scope | null { const current = session(); const id = patientId(); return current && id ? { userId: current.userId, actorId: current.actorId, patientId: id } : null; }
function sameScope(scope: Scope): boolean { const latest = currentScope(); return Boolean(latest && latest.userId === scope.userId && latest.actorId === scope.actorId && latest.patientId === scope.patientId); }
function forbidden(error: unknown): boolean { return error instanceof ApiFailure && [401, 403].includes(error.status); }
function scopeKey(scope: Scope): string { return JSON.stringify([scope.userId, scope.actorId, scope.patientId]); }

function parseOverview(value: unknown, expectedPatientId?: string): Overview | null {
  if (!object(value) || !only(value, ['patientId', 'asOf', 'plans', 'logs', 'today', 'trajectories']) || !text(value.patientId, 256) || expectedPatientId !== undefined && value.patientId !== expectedPatientId || !validInstant(value.asOf) || !Array.isArray(value.plans) || !Array.isArray(value.logs) || !Array.isArray(value.today)) return null;
  const plans = value.plans.filter((plan): plan is Plan => {
    if (!object(plan) || !only(plan, ['id', 'patientId', 'kind', 'drug', 'dose', 'unit', 'route', 'frequency', 'startedAt', 'schedule', 'scheduleAsOf', 'status', 'coldChain', 'createdAt', 'source', 'prescriptionNote', 'version', 'originReportedPlanId', 'reviewedPlanId', 'confirmedAt'])) return false; const p = plan;
    const schedule = p.schedule;
    const validSchedule = schedule === undefined || Array.isArray(schedule) && schedule.length > 0 && schedule.length <= 100 && schedule.every(item => object(item) && only(item, ['effectiveFrom', 'plannedDose']) && validInstant(item.effectiveFrom) && typeof item.plannedDose === 'number' && Number.isFinite(item.plannedDose) && item.plannedDose > 0);
    return validMedicationProvenance(p) && text(p.id, 256) && p.patientId === value.patientId && text(p.drug, 512) && typeof p.dose === 'number' && Number.isFinite(p.dose) && p.dose >= 0 && text(p.unit, 64) && text(p.route, 64) && text(p.frequency, 64) && ['ORAL', 'SC_INJECTION'].includes(String(p.route)) && ['DAILY', 'WEEKLY', 'EVERY_4_WEEKS', 'AS_NEEDED'].includes(String(p.frequency)) && ['ACTIVE', 'PAUSED', 'STOPPED'].includes(String(p.status)) && (p.kind === undefined || ['STEROID', 'BIOLOGIC', 'SUPPORTIVE'].includes(String(p.kind))) && (p.startedAt === undefined || validInstant(p.startedAt)) && validSchedule && (p.scheduleAsOf === undefined || validInstant(p.scheduleAsOf)) && (p.coldChain === undefined || typeof p.coldChain === 'boolean') && (p.createdAt === undefined || validInstant(p.createdAt));
  });
  const logs = value.logs.filter((log): log is Log => {
    if (!object(log) || !only(log, ['id', 'patientId', 'planId', 'takenAt', 'actualDose', 'unit', 'source', 'injectionSite', 'injectionAdministeredBy', 'coldChainEvent'])) return false; const item = log;
    const cold = item.coldChainEvent;
    return text(item.id, 256) && item.patientId === value.patientId && text(item.planId, 256) && validInstant(item.takenAt) && typeof item.actualDose === 'number' && Number.isFinite(item.actualDose) && item.actualDose >= 0 && text(item.unit, 64) && (item.source === undefined || ['PATIENT', 'CAREGIVER', 'CLINICIAN'].includes(String(item.source))) && (item.injectionSite === undefined || INJECTION_SITES.includes(item.injectionSite as InjectionSite)) && (item.injectionAdministeredBy === undefined || INJECTION_ADMINS.includes(item.injectionAdministeredBy as InjectionAdministeredBy)) && (cold === undefined || validColdChain(cold));
  });
  const today = value.today.filter((entry): entry is Today => {
    if (!object(entry) || !only(entry, ['planId', 'status', 'lastTakenAt', 'dueAt', 'late'])) return false; const t = entry;
    return text(t.planId, 256) && ['RECORDED', 'NOT_RECORDED', 'NOT_DUE'].includes(String(t.status)) && (t.lastTakenAt === undefined || validInstant(t.lastTakenAt)) && (t.dueAt === undefined || validInstant(t.dueAt)) && (t.late === undefined || typeof t.late === 'boolean');
  });
  if (plans.length !== value.plans.length || logs.length !== value.logs.length || today.length !== value.today.length) return null;
  const planById = new Map(plans.map(plan => [plan.id, plan]));
  if (planById.size !== plans.length || new Set(logs.map(log => log.id)).size !== logs.length || new Set(today.map(item => item.planId)).size !== today.length || today.some(item => !planById.has(item.planId))) return null;
  if (logs.some(log => {
    const plan = planById.get(log.planId);
    if (!plan) return true;
    const hasInjection = log.injectionSite !== undefined || log.injectionAdministeredBy !== undefined || log.coldChainEvent !== undefined;
    return plan.route === 'SC_INJECTION' ? log.injectionSite === undefined || log.injectionAdministeredBy === undefined : hasInjection;
  })) return null;
  if (value.trajectories !== undefined) {
    if (!Array.isArray(value.trajectories)) return null;
    const trajectoryIds = new Set<string>();
    const trajectories: Trajectory[] = [];
    for (const item of value.trajectories) {
      if (!object(item) || !only(item, ['planId', 'drug', 'status', 'frequency', 'unit', 'points', 'missingWindows', 'through', 'deviation', 'source']) || !text(item.planId, 256) || trajectoryIds.has(item.planId) || !text(item.drug, 512) || !['ACTIVE', 'PAUSED', 'STOPPED'].includes(String(item.status)) || !['DAILY', 'WEEKLY', 'EVERY_4_WEEKS', 'AS_NEEDED'].includes(String(item.frequency)) || !text(item.unit, 64) || !Array.isArray(item.points) || !Array.isArray(item.missingWindows) || item.through !== undefined && !validInstant(item.through) || item.deviation !== undefined && !validTrajectoryDeviation(item.deviation)) return null;
      if (item.source !== undefined && item.source !== 'CLINICIAN' && item.source !== 'PATIENT_REPORTED') return null;
      const referencedPlan = planById.get(item.planId);
      if (referencedPlan && (referencedPlan.source ?? 'CLINICIAN') !== (item.source ?? 'CLINICIAN')) return null;
      if (item.source === 'PATIENT_REPORTED' && item.deviation !== undefined) return null;
      if (referencedPlan && (referencedPlan.drug !== item.drug || referencedPlan.status !== item.status || referencedPlan.frequency !== item.frequency || referencedPlan.unit !== item.unit)) return null;
      if (!item.points.every(point => validTrajectoryPoint(point)) || !item.missingWindows.every(window => validMissingWindow(window))) return null;
      trajectories.push({ ...(item.source === undefined ? {} : { source: item.source as 'CLINICIAN' | 'PATIENT_REPORTED' }), planId: item.planId, drug: item.drug, status: item.status as Plan['status'], frequency: String(item.frequency), unit: item.unit, points: item.points as TrajectoryPoint[], missingWindows: item.missingWindows as Trajectory['missingWindows'], ...(item.through === undefined ? {} : { through: String(item.through) }), ...(item.deviation === undefined ? {} : { deviation: item.deviation as Trajectory['deviation'] }) });
      trajectoryIds.add(item.planId);
    }
    return { patientId: value.patientId, asOf: value.asOf, plans, logs, today, trajectories };
  }
  return { patientId: value.patientId, asOf: value.asOf, plans, logs, today, trajectories: [] };
}
function validColdChain(value: unknown): value is ColdChainEvent { return object(value) && Object.keys(value).every(key => ['type', 'durationHours', 'reportedAt'].includes(key)) && COLD_CHAIN_TYPES.includes(value.type as ColdChainType) && typeof value.durationHours === 'number' && Number.isFinite(value.durationHours) && value.durationHours >= 0 && validInstant(value.reportedAt); }
function validTrajectoryPoint(value: unknown): boolean { return object(value) && only(value, ['at', 'kind', 'plannedDose', 'actualDose', 'delta', 'comparison', 'logId', 'unit']) && validInstant(value.at) && ['PLAN', 'ACTUAL'].includes(String(value.kind)) && ['PLANNED', 'ON_PLAN', 'ABOVE_PLAN', 'BELOW_PLAN', 'UNPLANNED'].includes(String(value.comparison)) && text(value.unit, 64) && (value.plannedDose === undefined || typeof value.plannedDose === 'number' && Number.isFinite(value.plannedDose) && value.plannedDose >= 0) && (value.actualDose === undefined || typeof value.actualDose === 'number' && Number.isFinite(value.actualDose) && value.actualDose >= 0) && (value.delta === undefined || typeof value.delta === 'number' && Number.isFinite(value.delta)) && (value.logId === undefined || text(value.logId, 256)); }
function validMissingWindow(value: unknown): boolean { return object(value) && only(value, ['dueAt', 'plannedDose', 'unit']) && validInstant(value.dueAt) && typeof value.plannedDose === 'number' && Number.isFinite(value.plannedDose) && value.plannedDose >= 0 && text(value.unit, 64); }
function validTrajectoryDeviation(value: unknown): boolean { return object(value) && only(value, ['direction', 'daysDeviation', 'detectedAt', 'missingDays']) && ['ON_PLAN', 'SLOWER', 'FASTER', 'STOPPED', 'INSUFFICIENT_DATA'].includes(String(value.direction)) && typeof value.daysDeviation === 'number' && Number.isFinite(value.daysDeviation) && value.daysDeviation >= 0 && validInstant(value.detectedAt) && (value.missingDays === undefined || typeof value.missingDays === 'number' && Number.isFinite(value.missingDays) && value.missingDays >= 0); }

/** 只从服务端已确认的注射事实计算轮换提示，不判断药品是否可用或是否需要补打。 */
export function deriveInjectionSummary(planId: string, logs: readonly Log[]): InjectionSummary {
  const history = logs.filter(log => log.planId === planId && log.injectionSite !== undefined)
    .slice().sort((left, right) => Date.parse(right.takenAt) - Date.parse(left.takenAt) || right.id.localeCompare(left.id));
  const lastSite = history[0]?.injectionSite;
  if (!lastSite) return { consecutiveCount: 0 };
  let consecutiveCount = 0;
  for (const log of history) { if (log.injectionSite !== lastSite) break; consecutiveCount += 1; }
  const suggestedSite = INJECTION_SITES.find(site => site !== lastSite);
  return { lastSite, suggestedSite, consecutiveCount };
}

export function buildInjectionLogPayload(plan: Pick<Plan, 'id' | 'patientId' | 'route' | 'dose' | 'unit'>, idempotencyKey: string, takenAt: string, draft: InjectionDraft): Record<string, unknown> {
  const payload: Record<string, unknown> = { idempotencyKey, planId: plan.id, takenAt, actualDose: plan.dose, unit: plan.unit };
  if (plan.route !== 'SC_INJECTION') return payload;
  if (!INJECTION_SITES.includes(draft.site as InjectionSite) || !INJECTION_ADMINS.includes(draft.administeredBy as InjectionAdministeredBy)) throw new Error('请先选择注射部位和注射人。');
  payload.injectionSite = draft.site;
  payload.injectionAdministeredBy = draft.administeredBy;
  if (!draft.coldChainEnabled) return payload;
  if (!COLD_CHAIN_TYPES.includes(draft.coldChainType as ColdChainType) || !draft.durationHours.trim() || !Number.isFinite(Number(draft.durationHours)) || Number(draft.durationHours) < 0 || !validLocalDate(draft.reportedAt) || localDateInstant(draft.reportedAt) > Date.now()) throw new Error('请完整填写冷链事实、时长和报告日期。');
  payload.coldChainEvent = { type: draft.coldChainType, durationHours: Number(draft.durationHours), reportedAt: new Date(`${draft.reportedAt}T00:00:00+08:00`).toISOString() };
  return payload;
}
function validLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number); const check = new Date(Date.UTC(year!, month! - 1, day!));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month! - 1 && check.getUTCDate() === day && Number.isFinite(Date.parse(`${value}T00:00:00+08:00`));
}
function localDateInstant(value: string): number { return Date.parse(`${value}T00:00:00+08:00`); }
function shanghaiParts(value: string | number | Date): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value)).filter(item => item.type !== 'literal').map(item => [item.type, item.value]));
}
function shanghaiMonthDay(value: string | number | Date = new Date()): { year: number; month: number; day: number } {
  const parts = shanghaiParts(value);
  return { year: Number(parts.year), month: Number(parts.month) - 1, day: Number(parts.day) };
}
function dateLabel(value: string): string {
  const parts = shanghaiParts(value);
  return `${parts.year}年${Number(parts.month)}月${Number(parts.day)}日`;
}
function shortDateLabel(value: string): string { const parts = shanghaiParts(value); return `${Number(parts.month)}月${Number(parts.day)}日`; }
function steroidRequiredKey(plan: Plan): string {
  const schedule = plan.schedule?.map(item => `${item.effectiveFrom}:${item.plannedDose}`).join('|') ?? String(plan.dose);
  return `${plan.id}:${plan.startedAt ?? ''}:${plan.scheduleAsOf ?? ''}:${schedule}`;
}
function currentPlannedDose(plan: Plan, at: string): number {
  const effective = plan.schedule?.filter(point => Date.parse(point.effectiveFrom) <= Date.parse(at)).sort((left, right) => Date.parse(left.effectiveFrom) - Date.parse(right.effectiveFrom)).at(-1);
  return effective?.plannedDose ?? plan.dose;
}
export function buildMedicationTracking(overview: Overview): { trackRows: PlanTrackRow[]; deviationRows: DeviationRow[]; steroidPlans: Array<{ id: string; drug: string; detail: string; requiredKey: string }>; plannedDoses: Record<string, string> } {
  const trackRows: PlanTrackRow[] = [];
  const deviationRows: DeviationRow[] = [];
  const steroidPlans: Array<{ id: string; drug: string; detail: string; requiredKey: string }> = [];
  const plannedDoses: Record<string, string> = {};
  for (const plan of overview.plans) {
    plannedDoses[plan.id] = `${currentPlannedDose(plan, overview.asOf)} ${plan.unit}`;
    if (plan.kind === 'STEROID' && plan.status === 'ACTIVE') {
      const upcoming = plan.schedule?.filter(point => Date.parse(point.effectiveFrom) > Date.parse(overview.asOf)).sort((left, right) => Date.parse(left.effectiveFrom) - Date.parse(right.effectiveFrom))[0];
      steroidPlans.push({ id: plan.id, drug: plan.drug, detail: upcoming ? `下一阶段：${shortDateLabel(upcoming.effectiveFrom)} 起 ${upcoming.plannedDose} ${plan.unit}，须按医生确认方案执行。` : `当前计划：${plannedDoses[plan.id]}，起始和每次减量前请再次阅读。`, requiredKey: steroidRequiredKey(plan) });
    }
  }
  for (const trajectory of overview.trajectories) {
    for (const point of trajectory.points.slice(-12)) {
      trackRows.push({ key: `${trajectory.planId}:${point.at}:${point.kind}:${point.logId ?? trackRows.length}`, at: point.at, date: shortDateLabel(point.at), kind: point.kind, label: trajectory.drug, dose: `${point.kind === 'PLAN' ? point.plannedDose ?? '—' : point.actualDose ?? '—'} ${trajectory.unit}`, status: point.kind === 'PLAN' ? trajectory.source === 'PATIENT_REPORTED' ? '自行录入 · 待核对' : '医生计划' : point.comparison === 'ON_PLAN' ? '与计划一致' : point.comparison === 'BELOW_PLAN' ? '低于计划' : point.comparison === 'ABOVE_PLAN' ? '高于计划' : '计划外记录' });
    }
    if (trajectory.source === 'PATIENT_REPORTED') continue;
    const misses = trajectory.missingWindows.filter(item => Date.parse(item.dueAt) < Date.parse(overview.asOf)).slice(-14);
    const actualDeviation = trajectory.points.filter(point => point.kind === 'ACTUAL' && ['ABOVE_PLAN', 'BELOW_PLAN', 'UNPLANNED'].includes(point.comparison));
    if (misses.length) deviationRows.push({ key: `${trajectory.planId}:missing`, drug: trajectory.drug, label: `${misses.length} 次待核对`, detail: `${misses.slice(-3).map(item => shortDateLabel(item.dueAt)).join('、')}未找到对应服药记录；如已按医嘱服用，请补充记录，不要自行补服。` });
    if (actualDeviation.length) deviationRows.push({ key: `${trajectory.planId}:deviation`, drug: trajectory.drug, label: '实际与计划有差异', detail: `最近 ${actualDeviation.length} 条记录剂量与计划不一致，请让照护团队核对原因。` });
  }
  trackRows.sort((left, right) => Date.parse(left.at) - Date.parse(right.at) || left.kind.localeCompare(right.kind));
  return { trackRows: trackRows.slice(-16), deviationRows, steroidPlans, plannedDoses };
}
function keyToUtc(key: string): Date {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!));
}
function dayKey(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function dayDistance(from: string, to: string): number {
  return Math.round((keyToUtc(to).getTime() - keyToUtc(from).getTime()) / 86400000);
}
function planStartKey(plan: Plan, fallback: string): string {
  const source = (plan as Plan & { startedAt?: string }).startedAt;
  return source ? (() => { const parts = shanghaiParts(source); return `${parts.year}-${parts.month}-${parts.day}`; })() : fallback;
}
function planDueOn(plan: Plan, key: string, fallbackStart: string): boolean {
  if (plan.status !== 'ACTIVE') return false;
  if (plan.frequency === 'AS_NEEDED') return false;
  if (plan.confirmedAt) { const confirmed = shanghaiParts(plan.confirmedAt); if (key < `${confirmed.year}-${confirmed.month}-${confirmed.day}`) return false; }
  const start = planStartKey(plan, fallbackStart);
  const distance = dayDistance(start, key);
  if (distance < 0) return false;
  if (plan.frequency === 'DAILY') return true;
  if (plan.frequency === 'WEEKLY') return keyToUtc(start).getUTCDay() === keyToUtc(key).getUTCDay();
  return distance % 28 === 0;
}
/** 接续当日保留旧记录来源，避免将一份事实展示成两个计划或补造待打卡。 */
function calendarSelectionPlans(plans: Plan[], logs: Log[], key: string, fallbackStart: string): Plan[] {
  return plans.filter(plan => logs.some(log => log.planId === plan.id) ||
    planDueOn(plan, key, fallbackStart) && !logs.some(log => log.planId === plan.originReportedPlanId));
}
export function calendarPlanRows(plans: Plan[], logs: Log[], key: string): CalendarPlanRow[] {
  const rows: CalendarPlanRow[] = [];
  for (const plan of plans) {
    const matchingLogs = logs.filter(item => item.planId === plan.id);
    const base = { ...plan, doseLabel: `计划 ${currentPlannedDose(plan, `${key}T23:59:59+08:00`)} ${plan.unit}` };
    if (!matchingLogs.length) {
      rows.push({ ...base, key: `${plan.id}:pending`, recorded: false, actualDoseLabel: '', takenAtLabel: '' });
      continue;
    }
    for (const log of matchingLogs) {
      const taken = shanghaiParts(log.takenAt);
      rows.push({ ...base, key: `${plan.id}:${log.id}`, recorded: true, actualDoseLabel: `实际 ${log.actualDose} ${log.unit}`, takenAtLabel: `${taken.hour}:${taken.minute}` });
    }
  }
  return rows;
}
function buildCalendar(overview: Overview, year: number, month: number, todayKey: string): CalendarDay[] {
  const first = new Date(Date.UTC(year, month, 1));
  const start = new Date(Date.UTC(year, month, 1 - first.getUTCDay()));
  const fallbackStart = todayKey;
  const plans = overview.plans.filter(plan => plan.status === 'ACTIVE');
  const logsByDay = new Map<string, Log[]>();
  for (const log of overview.logs) {
    const parts = shanghaiParts(log.takenAt); const key = `${parts.year}-${parts.month}-${parts.day}`;
    const entries = logsByDay.get(key) ?? []; entries.push(log); logsByDay.set(key, entries);
  }
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start.getTime() + index * 86400000);
    const key = dayKey(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const dayLogs = logsByDay.get(key) ?? [];
    const duePlans = plans.filter(plan => planDueOn(plan, key, fallbackStart));
    const takenCount = duePlans.filter(plan => dayLogs.some(log => log.planId === plan.id || log.planId === plan.originReportedPlanId)).length;
    let state: CalendarDay['state'];
    if (key > todayKey) state = 'FUTURE';
    else if (duePlans.length === 0) state = dayLogs.length > 0 ? 'TAKEN' : 'EMPTY';
    else if (takenCount >= duePlans.length) state = 'TAKEN';
    else if (takenCount > 0 || dayLogs.length > 0) state = 'PARTIAL';
    else state = 'EMPTY';
    return { key, day: date.getUTCDate(), label: key, inMonth: date.getUTCMonth() === month, state };
  });
}
function parseSideEffects(value: unknown, patientId?: string): SideEffect[] | null {
  if (!object(value) || !only(value, ['items']) || !Array.isArray(value.items)) return null;
  const items = value.items.filter((item): item is SideEffect => object(item) && only(item, ['id', 'patientId', 'symptomCode', 'severity', 'label', 'guidance', 'reportedAt', 'handledAt', 'photoRef', 'note', 'followUpTaskId', 'alertId', 'routing']) && text(item.id, 256) && text(item.patientId, 256) && (patientId === undefined || item.patientId === patientId) && text(item.symptomCode, 128) && text(item.severity, 64) && text(item.label, 512) && text(item.guidance, 4096) && validInstant(item.reportedAt) && (item.handledAt === undefined || validInstant(item.handledAt)) && (item.photoRef === undefined || text(item.photoRef, 512)) && (item.note === undefined || text(item.note, 2000)) && (item.followUpTaskId === undefined || text(item.followUpTaskId, 256)) && (item.alertId === undefined || text(item.alertId, 256)) && object(item.routing) && only(item.routing, ['createsClinicalAlert', 'createsFollowUp', 'immediateMessage']) && typeof item.routing.createsClinicalAlert === 'boolean' && typeof item.routing.createsFollowUp === 'boolean' && typeof item.routing.immediateMessage === 'boolean');
  return items.length === value.items.length ? items : null;
}
function parseSideEffectDefinitions(value: unknown): SideEffectDefinition[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const items = value.filter((item): item is SideEffectDefinition => object(item) && only(item, ['code', 'severity', 'label', 'guidance']) && text(item.code, 128) && !seen.has(item.code) && ['EXPECTED', 'MONITOR', 'REPORT', 'URGENT'].includes(String(item.severity)) && text(item.label, 512) && text(item.guidance, 4096) && (seen.add(item.code), true));
  return items.length === value.length ? items : null;
}
function parseSideEffect(value: unknown, patientId: string): SideEffect | null {
  return object(value) && only(value, ['id', 'patientId', 'symptomCode', 'severity', 'label', 'guidance', 'reportedAt', 'handledAt', 'photoRef', 'note', 'followUpTaskId', 'alertId', 'routing']) && text(value.id, 256) && value.patientId === patientId && text(value.patientId, 256) && text(value.symptomCode, 128) && text(value.severity, 64) && text(value.label, 512) && text(value.guidance, 4096) && validInstant(value.reportedAt) && (value.handledAt === undefined || validInstant(value.handledAt)) && (value.photoRef === undefined || text(value.photoRef, 512)) && (value.note === undefined || text(value.note, 2000)) && (value.followUpTaskId === undefined || text(value.followUpTaskId, 256)) && (value.alertId === undefined || text(value.alertId, 256)) && object(value.routing) && only(value.routing, ['createsClinicalAlert', 'createsFollowUp', 'immediateMessage']) && typeof value.routing.createsClinicalAlert === 'boolean' && typeof value.routing.createsFollowUp === 'boolean' && typeof value.routing.immediateMessage === 'boolean' ? value as unknown as SideEffect : null;
}
function parseScreenings(value: unknown, patientId?: string): Screening[] | null {
  if (!object(value) || !only(value, ['items']) || !Array.isArray(value.items)) return null;
  const items = value.items.filter((item): item is Screening => {
    if (!object(item) || !only(item, ['patientId', 'type', 'intervalMonths', 'lastDoneAt', 'dueAt', 'status', 'doneAt', 'doneAtFacility', 'extendedByClinician', 'extendedAt', 'definition', 'evaluation'])) return false;
    if (!text(item.patientId, 256) || patientId !== undefined && item.patientId !== patientId || !['OPHTHALMOLOGY', 'BONE_DENSITY', 'GROWTH', 'BP_GLUCOSE', 'DENTAL'].includes(String(item.type))) return false;
    if (!(item.intervalMonths === null || typeof item.intervalMonths === 'number' && Number.isInteger(item.intervalMonths) && item.intervalMonths > 0)) return false;
    if (!validInstant(item.dueAt) || item.lastDoneAt !== undefined && !validInstant(item.lastDoneAt) || item.status !== undefined && !['OK', 'DUE_SOON', 'OVERDUE', 'DONE'].includes(String(item.status)) || item.doneAt !== undefined && !validInstant(item.doneAt) || item.doneAtFacility !== undefined && !text(item.doneAtFacility, 200) || item.extendedByClinician !== undefined && typeof item.extendedByClinician !== 'boolean' || item.extendedAt !== undefined && !validInstant(item.extendedAt)) return false;
    const definition = item.definition; const evaluation = item.evaluation;
    if (!object(definition) || !only(definition, ['type', 'label', 'defaultIntervalMonths', 'reason']) || definition.type !== item.type || !text(definition.label, 512) || !text(definition.reason, 2000) || definition.defaultIntervalMonths !== undefined && !(typeof definition.defaultIntervalMonths === 'number' && Number.isInteger(definition.defaultIntervalMonths) && definition.defaultIntervalMonths > 0)) return false;
    if (!object(evaluation) || !only(evaluation, ['status', 'daysUntilDue', 'priority']) || !['OK', 'DUE_SOON', 'OVERDUE', 'DONE'].includes(String(evaluation.status)) || typeof evaluation.daysUntilDue !== 'number' || !Number.isInteger(evaluation.daysUntilDue) || evaluation.priority !== 'MAINTAINED') return false;
    return evaluation.status !== 'DONE' || item.doneAt !== undefined && item.doneAtFacility !== undefined;
  });
  return items.length === value.items.length ? items : null;
}
function describeError(error: unknown, fallback: string): string { return error instanceof Error ? error.message : fallback; }

function validBusinessDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function parseMedicationWave(value: unknown, expectedPatientId: string): MedicationWaveView | null {
  if (!object(value) || !only(value, ['patientId', 'asOf', 'range', 'plans', 'days']) || value.patientId !== expectedPatientId || !validInstant(value.asOf) || !Array.isArray(value.plans) || !Array.isArray(value.days)) return null;
  const range = value.range;
  if (!object(range) || !only(range, ['from', 'to', 'days']) || !validBusinessDate(range.from) || !validBusinessDate(range.to) || range.from > range.to || range.days !== 14) return null;
  const plans = value.plans.filter(item => object(item) && only(item, ['id', 'drug', 'kind', 'route', 'frequency', 'unit', 'status']) && text(item.id, 256) && text(item.drug, 512) && text(item.kind, 64) && text(item.route, 64) && text(item.frequency, 64) && text(item.unit, 64) && text(item.status, 64));
  if (plans.length !== value.plans.length || new Set(plans.map(item => item.id)).size !== plans.length) return null;
  const planIds = new Set(plans.map(item => item.id));
  const days = value.days.filter(item => {
    if (!object(item) || !only(item, ['date', 'observations', 'planned', 'actual', 'relationHints']) || !validBusinessDate(item.date) || !Array.isArray(item.observations) || !Array.isArray(item.planned) || !Array.isArray(item.actual) || !Array.isArray(item.relationHints)) return false;
    const observations = item.observations.every(row => object(row) && only(row, ['id', 'code', 'display', 'valueNumeric', 'valueText', 'unit', 'observedAt', 'source']) && text(row.id, 256) && text(row.code, 128) && text(row.display, 512) && text(row.unit, 64) && validInstant(row.observedAt) && text(row.source, 64) && (row.valueNumeric === undefined || typeof row.valueNumeric === 'number' && Number.isFinite(row.valueNumeric)) && (row.valueText === undefined || text(row.valueText, 512)));
    const planned = item.planned.every(row => object(row) && only(row, ['planId', 'drug', 'plannedDose', 'unit', 'dueAt', 'frequency']) && text(row.planId, 256) && planIds.has(row.planId) && text(row.drug, 512) && typeof row.plannedDose === 'number' && Number.isFinite(row.plannedDose) && row.plannedDose >= 0 && text(row.unit, 64) && validInstant(row.dueAt) && text(row.frequency, 64));
    const actual = item.actual.every(row => object(row) && only(row, ['logId', 'planId', 'drug', 'actualDose', 'unit', 'takenAt', 'source', 'frequency', 'relatedPlanIds']) && text(row.logId, 256) && text(row.planId, 256) && text(row.drug, 512) && typeof row.actualDose === 'number' && Number.isFinite(row.actualDose) && row.actualDose >= 0 && text(row.unit, 64) && validInstant(row.takenAt) && text(row.source, 64) && text(row.frequency, 64) && Array.isArray(row.relatedPlanIds) && row.relatedPlanIds.every(id => text(id, 256)));
    const hints = item.relationHints.every(row => object(row) && only(row, ['kind', 'text', 'planId', 'observationIds']) && text(row.kind, 64) && text(row.text, 512) && (row.planId === undefined || text(row.planId, 256)) && (row.observationIds === undefined || Array.isArray(row.observationIds) && row.observationIds.every(id => text(id, 256))));
    return observations && planned && actual && hints;
  });
  if (days.length !== value.days.length || days.length !== 14) return null;
  const dayKeys = days.map(item => item.date);
  if (new Set(dayKeys).size !== dayKeys.length || dayKeys[0] !== range.from || dayKeys.at(-1) !== range.to || dayKeys.some((day, index) => index > 0 && day <= dayKeys[index - 1]!)) return null;
  return { patientId: expectedPatientId, asOf: String(value.asOf), range: { from: String(range.from), to: String(range.to), days: 14 }, plans: plans as MedicationWaveView['plans'], days: days as MedicationWaveDay[] };
}

function waveDateLabel(value: string): string { const [, month, day] = value.split('-').map(Number); return `${month}月${day}日`; }
export function buildMedicationWaveRows(wave: MedicationWaveView): MedicationWaveRow[] {
  return wave.days.slice().reverse().map(day => {
    const observationsText = day.observations.map(item => `${item.display} ${item.valueNumeric ?? item.valueText ?? '已记录'}${item.unit ? ` ${item.unit}` : ''}`).join('；');
    const plannedText = day.planned.map(item => `${item.drug} ${item.plannedDose} ${item.unit}`).join('、');
    const actualText = day.actual.map(item => `${item.drug} ${item.actualDose} ${item.unit}`).join('、');
    const hintsText = day.relationHints.map(item => item.text).join('；');
    const state = day.relationHints.some(item => ['MISSED', 'BELOW_PLAN', 'ABOVE_PLAN', 'UNPLANNED'].includes(item.kind)) ? 'warn' : day.planned.length || day.actual.length || day.observations.length ? 'ok' : 'empty';
    return { key: day.date, date: waveDateLabel(day.date), observationsText, plannedText, actualText, hintsText, state };
  });
}

Page({
  data: {
    canEditPlans: false, careCapabilities: null as CareCapabilities | null, planDraft: emptyPlanDraft(), planIdentityLocked: false,
    planError: '', planCommandPending: false, rejectedPlanCommands: [] as Array<{ key: string; error: string }>,
    planKindOptions: PLAN_KIND_OPTIONS, planRouteOptions: PLAN_ROUTE_OPTIONS, planFrequencyOptions: PLAN_FREQUENCY_OPTIONS,
    planStatusOptions: PLAN_STATUS_OPTIONS, planKindIndex: 0, planRouteIndex: 0, planFrequencyIndex: 0, planStatusIndex: 0,
    planUnitOptions: ['mg', 'ml', 'g', '片', '粒', 'IU', '滴'],
    loading: true, saving: false, showSteroidGuide: false, showSideEffects: false, expandedPlanId: '', todayOptionsPlanId: '', showTrajectory: false, todayPlans: [] as Plan[], error: '', notice: '', demoReminderText: '', overview: null as Overview | null, wave: null as MedicationWaveView | null, waveRows: [] as MedicationWaveRow[], waveError: '',
    overviewUpdatedAt: '', trackRows: [] as PlanTrackRow[], deviationRows: [] as DeviationRow[], steroidPlans: [] as Array<{ id: string; drug: string; detail: string; requiredKey: string }>, plannedDoses: {} as Record<string, string>, steroidReadKeys: {} as Record<string, boolean>, steroidReadingRequired: false,
    calendarLabel: '', calendarDays: [] as CalendarDay[], calendarYear: 0, calendarMonth: 0, selectedDay: null as CalendarSelection | null, selectedDayLabel: '', selectedDayLogs: [] as Log[], selectedDayPlans: [] as CalendarPlanRow[], todayLabel: '', recordedToday: 0, todayDueCount: 0, activePlanCount: 0,
    routeLabels: ROUTE_LABELS, frequencyLabels: FREQUENCY_LABELS, screeningLabels: SCREENING_LABELS, sideEffectSeverityLabels: SIDE_EFFECT_SEVERITY_LABELS, routeOptions: [{ value: 'ORAL', label: '口服' }, { value: 'SC_INJECTION', label: '皮下注射' }], frequencyOptions: [{ value: 'DAILY', label: '每日' }, { value: 'WEEKLY', label: '每周' }, { value: 'EVERY_4_WEEKS', label: '每 4 周' }, { value: 'AS_NEEDED', label: '按需' }],
    sideEffects: [] as SideEffect[], sideEffectDefinitions: [] as SideEffectDefinition[], sideEffectCode: '', sideEffectNote: '', sideEffectError: '', screeningError: '', screenings: [] as Screening[], screeningDates: {} as Record<string, string>, screeningFacilities: {} as Record<string, string>, statusText: {} as Record<string, string>, lateText: {} as Record<string, string>,
    injectionSiteOptions: INJECTION_SITE_OPTIONS as readonly { value: string; label: string }[], injectionAdminOptions: INJECTION_ADMIN_OPTIONS as readonly { value: string; label: string }[], coldChainOptions: COLD_CHAIN_OPTIONS as readonly { value: string; label: string }[], injectionSiteIndexes: {} as Record<string, number>, injectionAdminIndexes: {} as Record<string, number>, coldChainIndexes: {} as Record<string, number>, coldChainEnabled: {} as Record<string, boolean>, coldChainDurations: {} as Record<string, string>, coldChainDates: {} as Record<string, string>, injectionSiteLabels: {} as Record<string, string>, injectionAdminLabels: {} as Record<string, string>, coldChainLabels: {} as Record<string, string>, injectionSummaryText: {} as Record<string, string>,
    pendingCount: 0, rejectedCount: 0, scopeKey: '', planEditorOpen: false, deferredText: {} as Record<string, string>, medicationReminders: [] as MedicationReminder[], reminderError: '', remindersLoading: false, actualDoseInputs: {} as Record<string, string>, deferBusy: false,
  },
  outbox: null as MutationOutbox | null, scope: null as Scope | null, reminderTimer: null as ReturnType<typeof setTimeout> | null, reminderGeneration: 0, deferGeneration: 0, loadGeneration: 0, mutationGeneration: 0,
  onLoad() {},
  stopReminderTimer() { if (this.reminderTimer !== null) clearTimeout(this.reminderTimer); this.reminderTimer = null; },
  onHide() { this.loadGeneration += 1; this.mutationGeneration += 1; this.reminderGeneration += 1; this.deferGeneration += 1; this.stopReminderTimer(); this.setData({ saving: false, deferBusy: false, remindersLoading: false }); },
  onUnload() { this.onHide(); },
  renderReminders() {
    const scope = this.scope; const overview = this.data.overview as Overview | null;
    if (!scope || !sameScope(scope) || !overview) return;
    const deferredText: Record<string, string> = {};
    for (const row of this.data.medicationReminders as MedicationReminder[]) {
      if (overview.plans.some(plan => plan.id === row.planId)) deferredText[row.planId] = medicationReminderLabel(row);
    }
    this.setData({ deferredText });
  },
  async refreshReminders() {
    this.stopReminderTimer();
    const scope = this.scope; if (!scope || !sameScope(scope)) return;
    const generation = ++this.reminderGeneration;
    const isCurrent = () => this.reminderGeneration === generation && this.scope === scope && sameScope(scope);
    this.setData({ remindersLoading: true, reminderError: '' });
    try {
      const result = await loadMedicationReminders(scope);
      if (!isCurrent()) return;
      this.setData({ medicationReminders: result.records }); this.renderReminders();
      const upcoming = result.records.filter(row => row.status === 'SCHEDULED').map(row => Date.parse(row.dueAt)).sort((a, b) => a - b)[0];
      if (upcoming !== undefined) {
        // 服务端推进到期状态；本机计时器只触发重新读取，不制造“已送达”。
        const delay = Math.min(86400000, Math.max(1000, upcoming - Date.parse(result.asOf) + 1000));
        this.reminderTimer = setTimeout(() => { if (isCurrent()) void this.refreshReminders(); }, delay);
      }
    } catch (error) {
      if (!isCurrent()) return;
      if (forbidden(error)) this.clearSensitiveState('当前身份已无权查看用药提醒，已清理本机敏感内容。');
      else this.setData({ medicationReminders: [], deferredText: {}, reminderError: describeError(error, '提醒暂时无法读取，请重试。') });
    } finally { if (isCurrent()) this.setData({ remindersLoading: false }); }
  },
  onShow() {
    const current = session();
    const next = currentScope();
    if (!next || !this.scope || scopeKey(next) !== scopeKey(this.scope)) { this.mutationGeneration += 1; this.resetPlanEditor(); this.setData({ careCapabilities: null }); }
    this.setData({ canEditPlans: Boolean(current && ['PATIENT', 'LEGAL_GUARDIAN'].includes(current.role)) });
    if (!current) {
      this.scope = null; this.outbox = null;
      this.setData({ scopeKey: '', loading: false, saving: false, error: '', notice: '', overview: null, wave: null, waveRows: [], waveError: '', activePlanCount: 0, overviewUpdatedAt: '', trackRows: [], deviationRows: [], steroidPlans: [], plannedDoses: {}, steroidReadKeys: {}, steroidReadingRequired: false, demoReminderText: '', calendarLabel: '', calendarDays: [], calendarYear: 0, calendarMonth: 0, selectedDay: null, selectedDayLabel: '', selectedDayLogs: [], selectedDayPlans: [], todayLabel: '', recordedToday: 0, todayDueCount: 0, sideEffects: [], sideEffectDefinitions: [], sideEffectCode: '', sideEffectNote: '', sideEffectError: '', screeningError: '', screenings: [], screeningDates: {}, screeningFacilities: {}, statusText: {}, lateText: {}, injectionSiteIndexes: {}, injectionAdminIndexes: {}, coldChainIndexes: {}, coldChainEnabled: {}, coldChainDurations: {}, coldChainDates: {}, injectionSiteLabels: {}, injectionAdminLabels: {}, coldChainLabels: {}, injectionSummaryText: {}, pendingCount: 0, rejectedCount: 0, planEditorOpen: false, showSteroidGuide: false, showSideEffects: false, expandedPlanId: '', todayOptionsPlanId: '', showTrajectory: false, todayPlans: [], deferredText: {}, medicationReminders: [], reminderError: '', remindersLoading: false, actualDoseInputs: {}, deferBusy: false });
      wx.redirectTo({ url: '/pages/auth/index' }); return;
    }
    const scope = currentScope();
    if (!scope) {
      this.scope = null; this.outbox = null;
      this.setData({ scopeKey: '', loading: false, saving: false, overview: null, wave: null, waveRows: [], waveError: '', activePlanCount: 0, overviewUpdatedAt: '', trackRows: [], deviationRows: [], steroidPlans: [], plannedDoses: {}, steroidReadKeys: {}, steroidReadingRequired: false, demoReminderText: '', calendarLabel: '', calendarDays: [], calendarYear: 0, calendarMonth: 0, selectedDay: null, selectedDayLabel: '', selectedDayLogs: [], selectedDayPlans: [], todayLabel: '', todayDueCount: 0, recordedToday: 0, sideEffects: [], sideEffectDefinitions: [], sideEffectCode: '', sideEffectNote: '', sideEffectError: '', screeningError: '', screenings: [], screeningDates: {}, screeningFacilities: {}, statusText: {}, lateText: {}, injectionSiteIndexes: {}, injectionAdminIndexes: {}, coldChainIndexes: {}, coldChainEnabled: {}, coldChainDurations: {}, coldChainDates: {}, injectionSiteLabels: {}, injectionAdminLabels: {}, coldChainLabels: {}, injectionSummaryText: {}, pendingCount: 0, rejectedCount: 0, planEditorOpen: false, showSteroidGuide: false, showSideEffects: false, expandedPlanId: '', todayOptionsPlanId: '', showTrajectory: false, todayPlans: [], deferredText: {}, medicationReminders: [], reminderError: '', remindersLoading: false, actualDoseInputs: {}, deferBusy: false, error: '当前微信身份尚未绑定患者档案。', notice: '' });
      return;
    }
    const key = scopeKey(scope);
    if (key === this.data.scopeKey) { this.refreshQueue(); if (!this.data.saving) this.load(this.scope ?? scope); return; }
    this.scope = scope;
    this.outbox = new MutationOutbox(wxStorage(), scope.actorId, scope.patientId, scope.userId);
    this.setData({ scopeKey: key, overview: null, wave: null, waveRows: [], waveError: '', activePlanCount: 0, overviewUpdatedAt: '', trackRows: [], deviationRows: [], steroidPlans: [], plannedDoses: {}, steroidReadKeys: {}, steroidReadingRequired: false, demoReminderText: '', calendarLabel: '', calendarDays: [], calendarYear: 0, calendarMonth: 0, selectedDay: null, selectedDayLabel: '', selectedDayLogs: [], selectedDayPlans: [], todayLabel: '', todayDueCount: 0, recordedToday: 0, sideEffects: [], sideEffectDefinitions: [], sideEffectCode: '', sideEffectNote: '', sideEffectError: '', screeningError: '', screenings: [], screeningDates: {}, screeningFacilities: {}, statusText: {}, lateText: {}, injectionSiteIndexes: {}, injectionAdminIndexes: {}, coldChainIndexes: {}, coldChainEnabled: {}, coldChainDurations: {}, coldChainDates: {}, injectionSiteLabels: {}, injectionAdminLabels: {}, coldChainLabels: {}, injectionSummaryText: {}, planEditorOpen: false, showSteroidGuide: false, showSideEffects: false, expandedPlanId: '', todayOptionsPlanId: '', showTrajectory: false, todayPlans: [], deferredText: {}, medicationReminders: [], reminderError: '', remindersLoading: false, actualDoseInputs: {}, deferBusy: false, loading: true, saving: false, error: '', notice: '' });
    this.refreshQueue(); this.load(scope);
  },
  clearSensitiveState(message = '') {
    this.onHide();
    this.resetPlanEditor(); this.setData({ careCapabilities: null, canEditPlans: false });
    if (this.scope) { try { wx.removeStorageSync(medicationReminderKey(this.scope.userId, this.scope.actorId, this.scope.patientId)); } catch { /* 旧版本本机提醒清理失败不阻塞内存清除 */ } }
    try { this.outbox?.clear(deniedOperations(['MEDICATION_LOG', 'MEDICATION_PLAN', 'MEDICATION_SIDE_EFFECT', 'MEDICATION_SCREENING'], Boolean(session()))); } catch { /* 清理失败不能阻止内存投影清除 */ }
    this.setData({ overview: null, wave: null, waveRows: [], waveError: '', activePlanCount: 0, overviewUpdatedAt: '', trackRows: [], deviationRows: [], steroidPlans: [], plannedDoses: {}, steroidReadKeys: {}, steroidReadingRequired: false, demoReminderText: '', calendarLabel: '', calendarDays: [], calendarYear: 0, calendarMonth: 0, selectedDay: null, selectedDayLabel: '', selectedDayLogs: [], selectedDayPlans: [], todayLabel: '', recordedToday: 0, todayDueCount: 0, sideEffects: [], sideEffectDefinitions: [], sideEffectCode: '', sideEffectNote: '', sideEffectError: '', screeningError: '', screenings: [], screeningDates: {}, screeningFacilities: {}, statusText: {}, lateText: {}, injectionSiteIndexes: {}, injectionAdminIndexes: {}, coldChainIndexes: {}, coldChainEnabled: {}, coldChainDurations: {}, coldChainDates: {}, injectionSiteLabels: {}, injectionAdminLabels: {}, coldChainLabels: {}, injectionSummaryText: {}, pendingCount: 0, rejectedCount: 0, planEditorOpen: false, showSteroidGuide: false, showSideEffects: false, expandedPlanId: '', todayOptionsPlanId: '', showTrajectory: false, todayPlans: [], deferredText: {}, medicationReminders: [], reminderError: '', remindersLoading: false, actualDoseInputs: {}, deferBusy: false, loading: false, saving: false, error: message, notice: '' });
  },
  refreshQueue() {
    try {
      const entries: MutationEntry[] = this.outbox ? this.outbox.entries().filter((item: MutationEntry) => ['MEDICATION_LOG', 'MEDICATION_PLAN', 'MEDICATION_SIDE_EFFECT', 'MEDICATION_SCREENING'].includes(item.operation)) : [];
      this.setData({ pendingCount: entries.filter(item => item.state === 'PENDING').length, rejectedCount: entries.filter(item => item.state === 'REJECTED').length,
        planCommandPending: entries.some(item => item.operation === 'MEDICATION_PLAN' && item.state === 'PENDING'),
        rejectedPlanCommands: entries.filter(item => item.operation === 'MEDICATION_PLAN' && item.state === 'REJECTED').map(item => ({ key: item.idempotencyKey, error: item.error ?? '记录安排未保存，请重新核对。' })) });
    }
    catch (error) { this.setData({ error: describeError(error, '本机待提交记录不可读。') }); }
  },
  refresh() { this.load(); },
  load(expectedScope?: Scope) {
    const generation = ++this.loadGeneration;
    const scope = expectedScope ?? this.scope ?? currentScope();
    if (!scope || !sameScope(scope)) { this.setData({ loading: false, error: '身份已切换，请返回首页后重新打开。' }); return; }
    const isCurrent = () => generation === this.loadGeneration && sameScope(scope);
    this.setData({ loading: true, error: '' }); const base = `/api/v1/patients/${encodeURIComponent(scope.patientId)}`;
    this.setData({ careCapabilities: null });
    void this.refreshReminders();
    request<unknown>(`${base}/care-summary`).then(value => { if (isCurrent()) this.setData({ careCapabilities: parseCareCapabilities(value, scope.patientId) }); }).catch(() => { if (isCurrent()) this.setData({ careCapabilities: null }); });
    this.setData({ wave: null, waveRows: [], waveError: '' });
    request<unknown>(`${base}/medication-wave`).then(value => {
      if (!isCurrent()) return;
      const wave = parseMedicationWave(value, scope.patientId);
      if (!wave) throw new Error('用药与波动快照响应格式无效。');
      this.setData({ wave, waveRows: buildMedicationWaveRows(wave), waveError: '' });
    }).catch((error: unknown) => {
      if (isCurrent()) this.setData({ wave: null, waveRows: [], waveError: describeError(error, '用药与波动快照暂不可见。') });
    });
    request<unknown>(`${base}/medications`).then(value => {
      if (!isCurrent()) return;
      const overview = parseOverview(value, scope.patientId); if (!overview || overview.patientId !== scope.patientId) throw new Error('用药响应格式无效，未更新当前计划。');
      const statusText: Record<string, string> = {}; const lateText: Record<string, string> = {};
      for (const plan of overview.plans) {
        const today = overview.today.find(item => item.planId === plan.id);
        statusText[plan.id] = plan.status === 'STOPPED' ? plan.reviewedPlanId ? '已由医生接续' : plan.source === 'PATIENT_REPORTED' ? '已结束记录' : '医生计划已停止' : plan.status === 'PAUSED' ? '已暂停记录' : plan.startedAt && Date.parse(plan.startedAt) > Date.now() ? '尚未开始' : today?.status === 'RECORDED' ? '今日已记录' : today?.status === 'NOT_DUE' ? plan.frequency === 'AS_NEEDED' ? '按需，可记录' : '今日无需记录' : '今日尚未记录';
        if (today?.late) lateText[plan.id] = `已超过计划时间${today.dueAt ? `（计划 ${today.dueAt.slice(0, 16).replace('T', ' ')}）` : ''}。请联系照护团队确认下一步，不要自行补打。`;
      }
      const activeToday = overview.today.filter(item => overview.plans.some(plan => plan.id === item.planId && plan.status === 'ACTIVE' && plan.frequency !== 'AS_NEEDED'));
      const dueToday = activeToday.filter(item => item.status !== 'NOT_DUE');
      const pending = dueToday.filter(item => item.status === 'NOT_RECORDED').length;
      const recorded = dueToday.filter(item => item.status === 'RECORDED').length;
      const demoReminderText = pending > 0 ? `今天还有 ${pending} 项用药尚未记录。已按医嘱用药后，请在下方记录。`
        : recorded > 0 ? `今天的 ${recorded} 项用药已记录。` : '今天暂无待记录的用药。';
      const injectionSummaryText: Record<string, string> = {}; const injectionSiteLabels: Record<string, string> = {}; const injectionAdminLabels: Record<string, string> = {}; const coldChainLabels: Record<string, string> = {};
      const injectionSiteIndexes: Record<string, number> = {}; const injectionAdminIndexes: Record<string, number> = {}; const coldChainIndexes: Record<string, number> = {};
      for (const plan of overview.plans.filter(item => item.route === 'SC_INJECTION')) {
        const summary = deriveInjectionSummary(plan.id, overview.logs);
        injectionSummaryText[plan.id] = summary.lastSite ? `最近 ${summary.consecutiveCount} 次为${INJECTION_SITE_LABELS[summary.lastSite] ?? summary.lastSite}；下次请按医生指导考虑其他象限。系统只记录事实，不判断药品是否可用，也不建议补打。` : '尚无已确认注射部位；请按医生指导选择象限。系统只记录事实，不判断药品是否可用。';
        injectionSiteIndexes[plan.id] = this.data.injectionSiteIndexes[plan.id] ?? 0;
        injectionAdminIndexes[plan.id] = this.data.injectionAdminIndexes[plan.id] ?? 0;
        coldChainIndexes[plan.id] = this.data.coldChainIndexes[plan.id] ?? 0;
        injectionSiteLabels[plan.id] = INJECTION_SITE_OPTIONS[injectionSiteIndexes[plan.id]!]!.label;
        injectionAdminLabels[plan.id] = INJECTION_ADMIN_OPTIONS[injectionAdminIndexes[plan.id]!]!.label;
        coldChainLabels[plan.id] = COLD_CHAIN_OPTIONS[coldChainIndexes[plan.id]!]!.label;
      }
      const now = new Date();
      const todayParts = shanghaiMonthDay(now); const todayKey = dayKey(todayParts.year, todayParts.month, todayParts.day);
      const calendarYear = this.data.calendarYear || todayParts.year; const calendarMonth = Number.isInteger(this.data.calendarMonth) && this.data.calendarYear ? this.data.calendarMonth : todayParts.month;
      const monthNames = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
      const calendarDays = buildCalendar(overview, calendarYear, calendarMonth, todayKey);
      const selectedKey = this.data.selectedDayLabel && calendarDays.some(item => item.key === this.data.selectedDayLabel) ? this.data.selectedDayLabel : todayKey;
      const selectedLogs = overview.logs.filter(log => { const p = shanghaiParts(log.takenAt); return `${p.year}-${p.month}-${p.day}` === selectedKey; });
      const selectedPlans = calendarSelectionPlans(overview.plans, selectedLogs, selectedKey, todayKey);
      const selectedParts = selectedKey.split('-').map(Number); const selectedDayLabel = `${selectedParts[1]}月${selectedParts[2]}日`;
      const tracking = buildMedicationTracking(overview);
      const steroidReadingRequired = tracking.steroidPlans.some(plan => !this.data.steroidReadKeys[plan.requiredKey]);
      const todayPlans = overview.plans.filter(plan => plan.status === 'ACTIVE').sort((left, right) => {
        const priority = (plan: Plan) => statusText[plan.id] === '今日尚未记录' ? 0 : plan.frequency === 'AS_NEEDED' && statusText[plan.id] !== '尚未开始' ? 1 : statusText[plan.id] === '今日已记录' ? 2 : 3;
        return priority(left) - priority(right);
      });
      const expandedTodayPlan = todayPlans.find(plan => plan.id === this.data.todayOptionsPlanId);
      const todayOptionsPlanId = expandedTodayPlan && !['尚未开始', '待服务端确认'].includes(statusText[expandedTodayPlan.id] ?? '') && (expandedTodayPlan.frequency === 'AS_NEEDED' || !['今日已记录', '今日无需记录'].includes(statusText[expandedTodayPlan.id] ?? '')) ? expandedTodayPlan.id : '';
      this.setData({ overview, todayPlans, todayOptionsPlanId, demoReminderText, overviewUpdatedAt: `更新于 ${dateLabel(overview.asOf)}`, ...tracking, steroidReadingRequired, calendarYear, calendarMonth, calendarLabel: `${calendarYear}年${monthNames[calendarMonth]}`, calendarDays, selectedDay: { key: selectedKey, label: selectedDayLabel, logs: selectedLogs, duePlans: selectedPlans }, selectedDayLabel: selectedKey, selectedDayLogs: selectedLogs, selectedDayPlans: calendarPlanRows(selectedPlans, selectedLogs, selectedKey), todayLabel: `${todayParts.month + 1}月${todayParts.day}日`, recordedToday: recorded, todayDueCount: dueToday.length, activePlanCount: overview.plans.filter(plan => plan.status === 'ACTIVE').length, statusText, lateText, injectionSummaryText, injectionSiteIndexes, injectionAdminIndexes, coldChainIndexes, injectionSiteLabels, injectionAdminLabels, coldChainLabels, sideEffectSeverityLabels: SIDE_EFFECT_SEVERITY_LABELS });
      this.renderReminders();
    }).catch((error: unknown) => { if (isCurrent()) { if (forbidden(error)) this.clearSensitiveState('当前身份已无权查看用药记录，已清理本机敏感内容。'); else this.setData({ error: describeError(error, '用药计划暂不可见。') }); } }).finally(() => { if (isCurrent()) this.setData({ loading: false }); });
    request<unknown>(`${base}/medication-side-effects?limit=20`).then(value => { if (!isCurrent()) return; const sideEffects = parseSideEffects(value, scope.patientId); if (!sideEffects) throw new Error('副作用记录响应格式无效。'); if (isCurrent()) this.setData({ sideEffects, sideEffectError: '' }); }).catch((error: unknown) => { if (isCurrent()) { if (forbidden(error)) this.clearSensitiveState('当前身份已无权查看用药不适，已清理本机敏感内容。'); else this.setData({ sideEffectError: describeError(error, '副作用记录暂不可见。') }); } });
    request<unknown>(`${base}/medication-side-effects/definitions`).then(value => { if (!isCurrent()) return; const sideEffectDefinitions = parseSideEffectDefinitions(value); if (!sideEffectDefinitions) throw new Error('副作用定义响应格式无效。'); if (isCurrent()) this.setData({ sideEffectDefinitions, sideEffectError: '' }); }).catch((error: unknown) => { if (isCurrent()) { if (forbidden(error)) this.clearSensitiveState('当前身份已无权查看用药不适选项，已清理本机敏感内容。'); else this.setData({ sideEffectError: describeError(error, '副作用选项暂不可见。') }); } });
    request<unknown>(`${base}/medication-screenings`).then(value => { if (!isCurrent()) return; const screenings = parseScreenings(value, scope.patientId); if (!screenings) throw new Error('筛查记录响应格式无效。'); const displayScreenings = screenings.map((item: Screening) => ({ ...item, dueAtLabel: dateLabel(item.dueAt) })); if (isCurrent()) this.setData({ screenings: displayScreenings, screeningError: '' }); }).catch((error: unknown) => { if (isCurrent()) { if (forbidden(error)) this.clearSensitiveState('当前身份已无权查看用药筛查，已清理本机敏感内容。'); else this.setData({ screeningError: describeError(error, '筛查状态暂不可见。') }); } });
  },
  sendEntry(entry: MutationEntry, expectedScope?: Scope): Promise<void> {
    const scope = expectedScope ?? this.scope; if (!scope || this.scope !== scope || !sameScope(scope)) return Promise.reject(new ApiFailure('身份已切换，原幂等键已保留。', 0));
    if (entry.operation === 'MEDICATION_PLAN') {
      const { planId, ...payload } = entry.payload;
      const path = planId ? `medication-plans/${encodeURIComponent(String(planId))}/self-reported` : 'medication-plans/self-reported';
      return request<unknown>(`/api/v1/patients/${encodeURIComponent(scope.patientId)}/${path}`, 'POST', payload).then(value => {
        const parsed = parseOverview({ patientId: scope.patientId, asOf: new Date().toISOString(), plans: [value], logs: [], today: [], trajectories: [] }, scope.patientId);
        const plan = parsed?.plans[0];
        if (!plan || plan.source !== 'PATIENT_REPORTED' || planId && plan.id !== planId || ['drug', 'kind', 'unit', 'route', 'frequency', 'prescriptionNote'].some(key => (plan as unknown as Record<string, unknown>)[key] !== payload[key]) || plan.startedAt !== payload.startedAt || plan.dose !== payload.dose || plan.status !== (payload.status ?? 'ACTIVE') || plan.version !== (Number(payload.expectedVersion ?? 0) + 1)) throw new ApiFailure('记录安排回执不完整，原操作已保留，请重试确认。', 200);
      });
    }
    if (entry.operation === 'MEDICATION_LOG') return request<unknown>(`/api/v1/patients/${encodeURIComponent(scope.patientId)}/medication-logs`, 'POST', entry.payload).then(value => {
      if (!object(value) || !text(value.id, 256) || value.patientId !== scope.patientId || value.planId !== entry.payload.planId || value.takenAt !== entry.payload.takenAt || value.actualDose !== entry.payload.actualDose || value.unit !== entry.payload.unit || (value.injectionSite ?? undefined) !== (entry.payload.injectionSite ?? undefined) || (value.injectionAdministeredBy ?? undefined) !== (entry.payload.injectionAdministeredBy ?? undefined) || JSON.stringify(value.coldChainEvent ?? undefined) !== JSON.stringify(entry.payload.coldChainEvent ?? undefined)) throw new ApiFailure('用药响应不完整，这条已留在本机，可以直接重试。', 200);
    });
    if (entry.operation === 'MEDICATION_SIDE_EFFECT') return request<unknown>(`/api/v1/patients/${encodeURIComponent(scope.patientId)}/medication-side-effects`, 'POST', entry.payload).then(value => { if (!parseSideEffect(value, scope.patientId)) throw new ApiFailure('副作用响应不完整，这条已留在本机，可以直接重试。', 200); });
    if (entry.operation === 'MEDICATION_SCREENING') return request<unknown>(`/api/v1/patients/${encodeURIComponent(scope.patientId)}/medication-screenings`, 'POST', { ...entry.payload, action: 'COMPLETE' }).then(value => { if (!object(value) || value.patientId !== scope.patientId || value.type !== entry.payload.type || !validInstant(value.dueAt)) throw new ApiFailure('筛查保存回执不完整，这条已留在本机，可以直接重试。', 200); });
    return Promise.resolve();
  },
  flush(retryRejected = false) {
    const scope = this.scope as Scope | null; const outbox = this.outbox as MutationOutbox | null;
    if (this.data.saving || !outbox || !scope || !sameScope(scope)) return; this.setData({ saving: true, error: '', notice: '' });
    const generation = ++this.mutationGeneration;
    const isCurrent = () => this.mutationGeneration === generation && this.scope === scope && sameScope(scope);
    outbox.flush((entry: MutationEntry) => {
      if (!isCurrent()) return Promise.reject(new ApiFailure('页面已切换，原幂等键已保留。', 0));
      return this.sendEntry(entry, scope).then(() => { if (!isCurrent()) throw new ApiFailure('页面已切换，原幂等键已保留。', 0); }).catch((error: unknown) => { if (!isCurrent()) throw new ApiFailure('页面已切换，原幂等键已保留。', 0); throw error; });
    }, retryRejected, ['MEDICATION_LOG', 'MEDICATION_PLAN', 'MEDICATION_SIDE_EFFECT', 'MEDICATION_SCREENING']).then((result: { sent: number; networkError: boolean; denied: boolean }) => {
      if (!isCurrent()) return;
      if (result.denied) { this.clearSensitiveState('当前身份无权提交该操作，本机敏感内容已清理；请重新登录或切换到患者身份。'); this.refreshQueue(); return; }
      if (result.networkError) this.setData({ notice: '暂未同步成功，记录已保留，联网后可重试。' });
      else if (result.sent > 0) {
        if (!outbox.entries().some(entry => entry.operation === 'MEDICATION_PLAN')) this.resetPlanEditor();
        this.setData({ notice: `已保存 ${result.sent} 项用药记录或安排。`, actualDoseInputs: {} }); this.load();
      }
      this.refreshQueue();
    }).catch((error: unknown) => { if (isCurrent()) { if (forbidden(error)) this.clearSensitiveState('当前身份已失效，用药敏感内容已清理。'); else this.setData({ error: describeError(error, '本机待提交记录读取失败。') }); } }).finally(() => { if (isCurrent()) this.setData({ saving: false }); });
  },
  todayKey(): string { const parts = shanghaiMonthDay(new Date()); return dayKey(parts.year, parts.month, parts.day); },
  hasTodayRecord(planId: string): boolean {
    const overview = this.data.overview as Overview | null; if (!overview) return false;
    const existing = overview.today.find(item => item.planId === planId); if (existing?.status === 'RECORDED') return true;
    const key = this.todayKey();
    const fromLogs = overview.logs.some(log => { const p = shanghaiParts(log.takenAt); return log.planId === planId && `${p.year}-${p.month}-${p.day}` === key; });
    const fromQueue = Boolean(this.outbox?.entries().some((entry: MutationEntry) => entry.operation === 'MEDICATION_LOG' && entry.payload.planId === planId && typeof entry.payload.takenAt === 'string' && (() => { const p = shanghaiParts(String(entry.payload.takenAt)); return `${p.year}-${p.month}-${p.day}` === key; })()));
    return fromLogs || fromQueue;
  },
  record(event: { currentTarget: { dataset: { planId?: string } } }) {
    const scope = this.scope; const planId = event.currentTarget.dataset.planId; const plan = this.data.overview?.plans.find((item: Plan) => item.id === planId);
    if (!scope || !sameScope(scope) || !plan || plan.status !== 'ACTIVE' || this.data.saving) return;
    if (plan.startedAt && Date.parse(plan.startedAt) > Date.now()) { this.setData({ notice: '这项安排尚未开始，请在实际用药后记录。' }); return; }
    if (plan.frequency !== 'AS_NEEDED' && this.data.overview.today.some((item: Today) => item.planId === plan.id && item.status === 'NOT_DUE')) { this.setData({ notice: '今天没有这项计划记录，请按医嘱核对用药日期。' }); return; }
    if (plan.kind === 'STEROID' && !this.data.steroidReadKeys[steroidRequiredKey(plan)]) { this.setData({ steroidReadingRequired: true, notice: '请先阅读并确认激素起始 / 减量前必读提示，再记录服药。' }); this.openSteroidGuide(); return; }
    const hasPending = this.outbox?.entries().some((entry: MutationEntry) => entry.operation === 'MEDICATION_LOG' && entry.payload.planId === plan.id);
    if (hasPending || plan.frequency !== 'AS_NEEDED' && this.hasTodayRecord(plan.id)) { this.setData({ notice: `${plan.drug} 今日已有记录或待确认操作，无需重复提交。` }); return; }
    let payload: Record<string, unknown>;
    try {
      const siteIndex = this.data.injectionSiteIndexes[plan.id] ?? 0; const adminIndex = this.data.injectionAdminIndexes[plan.id] ?? 0; const coldIndex = this.data.coldChainIndexes[plan.id] ?? 0;
      const doseInput = String(this.data.actualDoseInputs[plan.id] ?? '').trim();
      const actualDose = doseInput ? Number(doseInput) : currentPlannedDose(plan, new Date().toISOString());
      if (!Number.isFinite(actualDose) || actualDose < 0) throw new Error('请填写有效的实际剂量。');
      payload = buildInjectionLogPayload({ ...plan, dose: actualDose }, newIdempotencyKey('MEDICATION_LOG'), new Date().toISOString(), {
        site: INJECTION_SITE_OPTIONS[siteIndex]?.value ?? '', administeredBy: INJECTION_ADMIN_OPTIONS[adminIndex]?.value ?? '', coldChainEnabled: Boolean(this.data.coldChainEnabled[plan.id]),
        coldChainType: COLD_CHAIN_OPTIONS[coldIndex]?.value ?? '', durationHours: String(this.data.coldChainDurations[plan.id] ?? ''), reportedAt: String(this.data.coldChainDates[plan.id] ?? ''),
      });
    } catch (error) { this.setData({ error: describeError(error, '请先完整填写注射事实。') }); return; }
    try { this.outbox?.enqueue({ operation: 'MEDICATION_LOG', idempotencyKey: payload.idempotencyKey, payload }); } catch (error) { this.setData({ error: describeError(error, '无法保存用药记录。') }); return; }
    this.setData({ [`statusText.${plan.id}`]: '待服务端确认', todayOptionsPlanId: '', notice: `${plan.drug} 已加入待确认记录。` });
    this.refreshQueue(); this.flush();
  },
  actualDoseInput(event: { currentTarget: { dataset: { planId?: string } }; detail: { value?: string } }) {
    const planId = event.currentTarget.dataset.planId;
    if (planId && this.data.overview?.plans.some((plan: Plan) => plan.id === planId)) this.setData({ [`actualDoseInputs.${planId}`]: event.detail.value ?? '', error: '' });
  },
  injectionPicker(event: { currentTarget: { dataset: { planId?: string; field?: string } }; detail: { value?: string } }) {
    const planId = event.currentTarget.dataset.planId; const field = event.currentTarget.dataset.field; const index = Number(event.detail.value);
    if (!planId || !Number.isSafeInteger(index) || index < 0) return;
    if (field === 'site') this.setData({ [`injectionSiteIndexes.${planId}`]: index, [`injectionSiteLabels.${planId}`]: INJECTION_SITE_OPTIONS[index]?.label ?? '请选择注射部位', error: '' });
    else if (field === 'admin') this.setData({ [`injectionAdminIndexes.${planId}`]: index, [`injectionAdminLabels.${planId}`]: INJECTION_ADMIN_OPTIONS[index]?.label ?? '请选择注射人', error: '' });
    else if (field === 'cold') this.setData({ [`coldChainIndexes.${planId}`]: index, [`coldChainLabels.${planId}`]: COLD_CHAIN_OPTIONS[index]?.label ?? '请选择冷链事实', error: '' });
  },
  coldChainToggle(event: { currentTarget: { dataset: { planId?: string } }; detail: { value?: boolean } }) { const planId = event.currentTarget.dataset.planId; if (planId) this.setData({ [`coldChainEnabled.${planId}`]: Boolean(event.detail.value), error: '' }); },
  coldChainDuration(event: { currentTarget: { dataset: { planId?: string } }; detail: { value?: string } }) { const planId = event.currentTarget.dataset.planId; if (planId) this.setData({ [`coldChainDurations.${planId}`]: event.detail.value ?? '', error: '' }); },
  coldChainDate(event: { currentTarget: { dataset: { planId?: string } }; detail: { value?: string } }) { const planId = event.currentTarget.dataset.planId; if (planId) this.setData({ [`coldChainDates.${planId}`]: event.detail.value ?? '', error: '' }); },
  selectSideEffect(event: { detail: { value?: string } }) { this.setData({ sideEffectCode: event.detail.value ?? '', error: '' }); },
  sideEffectInput(event: { detail: { value?: string } }) { this.setData({ sideEffectNote: event.detail.value ?? '' }); },
  reportSideEffect() {
    const scope = this.scope; const code = this.data.sideEffectCode as string; if (!scope || !sameScope(scope) || this.data.saving || !code) { if (!code) this.setData({ error: '请选择需要记录的用药不适。' }); return; }
    if (!this.data.sideEffectDefinitions.some((item: SideEffectDefinition) => item.code === code)) { this.setData({ error: '副作用选项已更新，请重新选择。' }); return; }
    const payload = { idempotencyKey: newIdempotencyKey('MEDICATION_SIDE_EFFECT'), symptomCode: code, reportedAt: new Date().toISOString(), ...(this.data.sideEffectNote ? { note: this.data.sideEffectNote } : {}) };
    try { this.outbox?.enqueue({ operation: 'MEDICATION_SIDE_EFFECT', idempotencyKey: payload.idempotencyKey, payload }); } catch (error) { this.setData({ error: describeError(error, '无法保存副作用记录。') }); return; }
    this.refreshQueue(); this.flush();
  },
  screeningDate(event: { currentTarget: { dataset: { type?: string } }; detail: { value?: string } }) { const type = event.currentTarget.dataset.type; if (type) this.setData({ [`screeningDates.${type}`]: event.detail.value ?? '' }); },
  screeningFacility(event: { currentTarget: { dataset: { type?: string } }; detail: { value?: string } }) { const type = event.currentTarget.dataset.type; if (type) this.setData({ [`screeningFacilities.${type}`]: event.detail.value ?? '' }); },
  completeScreening(event: { currentTarget: { dataset: { type?: string } } }) {
    const scope = this.scope; const type = event.currentTarget.dataset.type; const item = this.data.screenings.find((row: Screening) => row.type === type); const doneAt = this.data.screeningDates[type ?? ''] as string; const facility = String(this.data.screeningFacilities[type ?? ''] ?? '').trim();
    if (!scope || !sameScope(scope) || this.data.saving || !item || !type) return;
    if (!doneAt || !facility) { this.setData({ screeningError: '请填写完成日期和检查机构。' }); return; }
    const isoDoneAt = new Date(`${doneAt}T00:00:00+08:00`).toISOString(); const payload = { idempotencyKey: newIdempotencyKey('MEDICATION_SCREENING'), type, doneAt: isoDoneAt, facility };
    try { this.outbox?.enqueue({ operation: 'MEDICATION_SCREENING', idempotencyKey: payload.idempotencyKey, payload }); } catch (error) { this.setData({ screeningError: describeError(error, '无法保存筛查记录。') }); return; }
    this.refreshQueue(); this.flush();
  },
  retry() { this.flush(true); },
  acknowledgeSteroid() {
    const scope = this.scope;
    if (!scope || !sameScope(scope)) return;
    const steroidReadKeys = { ...(this.data.steroidReadKeys as Record<string, boolean>) };
    for (const plan of this.data.steroidPlans) steroidReadKeys[plan.requiredKey] = true;
    this.setData({ steroidReadKeys, steroidReadingRequired: false, showSteroidGuide: false, notice: '已阅读。若出现明显情绪或睡眠变化，请及时告诉照护团队，不要自行停药或减药。' });
    wx.pageScrollTo({ scrollTop: 0, duration: 250 });
  },
  openSteroidGuide() { this.setData({ showSteroidGuide: true }); wx.pageScrollTo({ selector: '#steroid-guide', duration: 250 }); },
  toggleSteroidGuide() { if (this.data.showSteroidGuide) this.setData({ showSteroidGuide: false }); else this.openSteroidGuide(); },
  toggleTrajectory() { this.setData({ showTrajectory: !this.data.showTrajectory }); },
  toggleTodayOptions(event: { currentTarget: { dataset: { planId?: string } } }) {
    const planId = event.currentTarget.dataset.planId;
    const plan = this.data.overview?.plans.find((item: Plan) => item.id === planId);
    if (!this.scope || !sameScope(this.scope) || this.data.saving || !plan || plan.status !== 'ACTIVE' || ['尚未开始', '待服务端确认'].includes(this.data.statusText[plan.id]) || plan.frequency !== 'AS_NEEDED' && ['今日已记录', '今日无需记录'].includes(this.data.statusText[plan.id])) return;
    this.setData({ todayOptionsPlanId: this.data.todayOptionsPlanId === plan.id ? '' : plan.id });
  },
  toggleSideEffects() { this.setData({ showSideEffects: !this.data.showSideEffects }); },
  togglePlanDetails(event: { currentTarget: { dataset: { planId?: string } } }) {
    const planId = event.currentTarget.dataset.planId;
    if (!planId || !this.data.overview?.plans.some((plan: Plan) => plan.id === planId)) return;
    this.setData({ expandedPlanId: this.data.expandedPlanId === planId ? '' : planId });
  },
  openPlanDetails(event: { currentTarget: { dataset: { planId?: string } } }) {
    const planId = event.currentTarget.dataset.planId;
    if (!planId || !this.data.overview?.plans.some((plan: Plan) => plan.id === planId)) return;
    this.setData({ expandedPlanId: planId });
    const index = this.data.overview.plans.findIndex((plan: Plan) => plan.id === planId);
    wx.pageScrollTo({ selector: `#medication-plan-${index}`, duration: 250 });
  },
  resetPlanEditor() {
    this.setData({ planEditorOpen: false, planDraft: emptyPlanDraft(), planIdentityLocked: false, planError: '', planCommandPending: false, rejectedPlanCommands: [], planStatusOptions: PLAN_STATUS_OPTIONS, planKindIndex: 0, planRouteIndex: 0, planFrequencyIndex: 0, planStatusIndex: 0 });
  },
  openPlanEditor() {
    if (!this.scope || !sameScope(this.scope) || !this.data.canEditPlans || this.data.saving) return;
    this.refreshQueue();
    if (this.data.planCommandPending || this.data.rejectedPlanCommands.length) { this.setData({ notice: '请先处理上方尚未保存的用药安排，再录入下一项。' }); return; }
    this.resetPlanEditor();
    this.setData({ planEditorOpen: true, planDraft: emptyPlanDraft(this.todayKey()) });
    wx.pageScrollTo({ scrollTop: 0, duration: 250 });
  },
  closePlanEditor() { if (!this.data.saving) this.setData({ planEditorOpen: false }); },
  editReportedPlan(event: { currentTarget: { dataset: { planId?: string } } }) {
    if (!this.scope || !sameScope(this.scope) || !this.data.canEditPlans || this.data.saving) return;
    this.refreshQueue();
    if (this.data.planCommandPending || this.data.rejectedPlanCommands.length) { this.setData({ notice: '请先处理尚未保存的用药安排。' }); return; }
    const plan = (this.data.overview as Overview | null)?.plans.find(item => item.id === event.currentTarget.dataset.planId);
    if (!plan || plan.source !== 'PATIENT_REPORTED' || plan.status === 'STOPPED' || plan.reviewedPlanId) return;
    const parts = shanghaiParts(plan.startedAt ?? new Date());
    const draft: PlanDraft = { id: plan.id, expectedVersion: plan.version!, kind: plan.kind ?? 'SUPPORTIVE', drug: plan.drug, dose: String(currentPlannedDose(plan, new Date().toISOString())), unit: plan.unit, route: plan.route, frequency: plan.frequency, startDate: `${parts.year}-${parts.month}-${parts.day}`, originalStartedAt: plan.startedAt ?? '', prescriptionNote: plan.prescriptionNote ?? '', status: plan.status };
    const statuses = PLAN_STATUS_OPTIONS.filter(item => plan.status === 'ACTIVE' || item.value !== 'ACTIVE');
    this.setData({ planEditorOpen: true, planDraft: draft, planIdentityLocked: this.data.overview.logs.some((log: Log) => log.planId === plan.id), planError: '', planStatusOptions: statuses, planKindIndex: PLAN_KIND_OPTIONS.findIndex(item => item.value === draft.kind), planRouteIndex: PLAN_ROUTE_OPTIONS.findIndex(item => item.value === draft.route), planFrequencyIndex: PLAN_FREQUENCY_OPTIONS.findIndex(item => item.value === draft.frequency), planStatusIndex: statuses.findIndex(item => item.value === draft.status) });
    wx.pageScrollTo({ scrollTop: 0, duration: 250 });
  },
  planInput(event: { currentTarget: { dataset: { field?: string } }; detail: { value?: string } }) {
    const field = event.currentTarget.dataset.field;
    if (this.data.saving || this.data.planCommandPending || !field || !['drug', 'dose', 'unit', 'prescriptionNote'].includes(field) || this.data.planIdentityLocked && ['drug', 'unit'].includes(field)) return;
    this.setData({ [`planDraft.${field}`]: event.detail.value ?? '', planError: '' });
  },
  selectPlanUnit(event: { currentTarget?: { dataset?: { unit?: string } } }) { const unit = event.currentTarget?.dataset?.unit; if (unit && this.data.planUnitOptions.includes(unit)) this.planInput({ currentTarget: { dataset: { field: 'unit' } }, detail: { value: unit } }); },
  selectPlanOption(event: { currentTarget?: { dataset?: { field?: string; index?: string } } }) { const dataset = event.currentTarget?.dataset; this.planPicker({ currentTarget: { dataset: { field: dataset?.field } }, detail: { value: dataset?.index } }); },
  planPicker(event: { currentTarget: { dataset: { field?: string } }; detail: { value?: string } }) {
    const field = event.currentTarget.dataset.field, index = Number(event.detail.value);
    if (this.data.saving || this.data.planCommandPending || !Number.isSafeInteger(index) || index < 0 || this.data.planIdentityLocked && field !== 'status') return;
    const choices: Record<string, { options: readonly { value: string }[]; indexKey: string }> = { kind: { options: PLAN_KIND_OPTIONS, indexKey: 'planKindIndex' }, route: { options: PLAN_ROUTE_OPTIONS, indexKey: 'planRouteIndex' }, frequency: { options: PLAN_FREQUENCY_OPTIONS, indexKey: 'planFrequencyIndex' }, status: { options: this.data.planStatusOptions, indexKey: 'planStatusIndex' } };
    const choice = field ? choices[field] : undefined;
    if (choice?.options[index]) this.setData({ [`planDraft.${field}`]: choice.options[index]!.value, [choice.indexKey]: index, planError: '' });
  },
  planStartDate(event: { detail: { value?: string } }) {
    if (!this.data.saving && !this.data.planCommandPending && !this.data.planIdentityLocked) this.setData({ 'planDraft.startDate': event.detail.value ?? '', planError: '' });
  },
  saveReportedPlan() {
    const scope = this.scope as Scope | null;
    if (!scope || !sameScope(scope) || !this.data.canEditPlans || this.data.saving || !this.data.planEditorOpen) return;
    this.refreshQueue(); if (this.data.planCommandPending || this.data.rejectedPlanCommands.length) return;
    try {
      const payload = buildReportedPlanPayload(this.data.planDraft as PlanDraft, newIdempotencyKey('MEDICATION_PLAN'));
      this.outbox.enqueue({ operation: 'MEDICATION_PLAN', idempotencyKey: payload.idempotencyKey, payload });
      this.setData({ planError: '' }); this.refreshQueue(); this.flush();
    } catch (error) { this.setData({ planError: describeError(error, '记录安排暂未保存，请检查填写内容。') }); }
  },
  async repairReportedPlan(event: { currentTarget: { dataset: { key?: string } } }) {
    const scope = this.scope as Scope | null, outbox = this.outbox as MutationOutbox | null;
    if (!scope || !sameScope(scope) || !outbox || this.data.saving) return;
    const entry = outbox.entries().find(item => item.operation === 'MEDICATION_PLAN' && item.state === 'REJECTED' && item.idempotencyKey === event.currentTarget.dataset.key);
    if (!entry) return;
    const generation = ++this.mutationGeneration;
    const isCurrent = () => this.mutationGeneration === generation && this.scope === scope && sameScope(scope);
    this.setData({ saving: true, planError: '' });
    try {
      const overview = parseOverview(await request<unknown>(`/api/v1/patients/${encodeURIComponent(scope.patientId)}/medications`), scope.patientId);
      if (!isCurrent()) return;
      if (!overview) throw new Error('未能核对最新用药安排，请稍后重试。');
      outbox.discardRejected(entry.idempotencyKey, 'MEDICATION_PLAN');
      this.setData({ overview, saving: false }); this.refreshQueue();
      if (entry.payload.planId) {
        const latest = overview.plans.find(plan => plan.id === entry.payload.planId);
        if (!latest || latest.status === 'STOPPED') { this.resetPlanEditor(); this.setData({ notice: '原安排已结束或由医生接续，已刷新当前记录。' }); this.load(); return; }
        this.editReportedPlan({ currentTarget: { dataset: { planId: latest.id } } });
      } else {
        this.openPlanEditor();
        const payload = entry.payload;
        const parts = shanghaiParts(String(payload.startedAt));
        this.setData({ planDraft: { ...emptyPlanDraft(`${parts.year}-${parts.month}-${parts.day}`), ...Object.fromEntries(['kind', 'drug', 'unit', 'route', 'frequency', 'prescriptionNote'].map(key => [key, String(payload[key] ?? '')])), dose: String(payload.dose), originalStartedAt: String(payload.startedAt) }, planKindIndex: PLAN_KIND_OPTIONS.findIndex(item => item.value === payload.kind), planRouteIndex: PLAN_ROUTE_OPTIONS.findIndex(item => item.value === payload.route), planFrequencyIndex: PLAN_FREQUENCY_OPTIONS.findIndex(item => item.value === payload.frequency) });
      }
      this.setData({ planError: '请按最新医嘱重新核对后保存。原来被拒绝的操作不会再重试。' });
    } catch (error) { if (isCurrent()) { if (forbidden(error)) this.clearSensitiveState('当前身份已无权查看用药安排，已清理本机敏感内容。'); else this.setData({ planError: describeError(error, '暂时无法重新填写。') }); } }
    finally { if (isCurrent()) this.setData({ saving: false }); }
  },
  requestPlanAdjustment() { wx.navigateTo({ url: '/pages/patient/support?topic=medication-adjustment' }); },
  renderCalendar(overview: Overview, year?: number, month?: number) {
    const today = shanghaiMonthDay(new Date()); const todayKey = dayKey(today.year, today.month, today.day); const targetYear = year ?? this.data.calendarYear ?? today.year; const targetMonth = month ?? this.data.calendarMonth ?? today.month;
    const normalized = new Date(Date.UTC(targetYear, targetMonth, 1)); const calendarYear = normalized.getUTCFullYear(); const calendarMonth = normalized.getUTCMonth(); const calendarDays = buildCalendar(overview, calendarYear, calendarMonth, todayKey); const selectedKey = calendarDays.some(item => item.inMonth && item.key === this.data.selectedDayLabel) ? this.data.selectedDayLabel : (calendarYear === today.year && calendarMonth === today.month ? todayKey : calendarDays.find(item => item.inMonth)?.key ?? todayKey); const logs = overview.logs.filter(log => { const p = shanghaiParts(log.takenAt); return `${p.year}-${p.month}-${p.day}` === selectedKey; }); const duePlans = calendarSelectionPlans(overview.plans, logs, selectedKey, todayKey); const parts = selectedKey.split('-').map(Number); const label = `${parts[1]}月${parts[2]}日`;
    this.setData({ calendarYear, calendarMonth, calendarLabel: `${calendarYear}年${calendarMonth + 1}月`, calendarDays, selectedDay: { key: selectedKey, label, logs, duePlans }, selectedDayLabel: selectedKey, selectedDayLogs: logs, selectedDayPlans: calendarPlanRows(duePlans, logs, selectedKey) });
  },
  previousMonth() { if (this.data.overview) this.renderCalendar(this.data.overview as Overview, Number(this.data.calendarYear), Number(this.data.calendarMonth) - 1); },
  nextMonth() { if (this.data.overview) this.renderCalendar(this.data.overview as Overview, Number(this.data.calendarYear), Number(this.data.calendarMonth) + 1); },
  selectCalendarDay(event: { currentTarget: { dataset: { key?: string } } }) {
    const key = event.currentTarget.dataset.key; const overview = this.data.overview as Overview | null; if (!key || !overview) return; const today = shanghaiMonthDay(new Date()); const logs = overview.logs.filter(log => { const p = shanghaiParts(log.takenAt); return `${p.year}-${p.month}-${p.day}` === key; }); const duePlans = calendarSelectionPlans(overview.plans, logs, key, dayKey(today.year, today.month, today.day)); const parts = key.split('-').map(Number); const label = `${parts[1]}月${parts[2]}日`; this.setData({ selectedDay: { key, label, logs, duePlans }, selectedDayLabel: key, selectedDayLogs: logs, selectedDayPlans: calendarPlanRows(duePlans, logs, key) });
  },
  async deferRecord(event: { currentTarget: { dataset: { planId?: string; delay?: string } } }) {
    const scope = this.scope; const planId = event.currentTarget.dataset.planId; const delay = Number(event.currentTarget.dataset.delay);
    const plan = this.data.overview?.plans.find((item: Plan) => item.id === planId);
    if (!scope || !sameScope(scope) || !plan || plan.status !== 'ACTIVE' || plan.frequency === 'AS_NEEDED' || this.data.statusText[plan.id] !== '今日尚未记录' || ![1, 2].includes(delay) || this.data.deferBusy || this.data.saving || this.data.remindersLoading || this.data.reminderError) return;
    const generation = ++this.deferGeneration;
    const isCurrent = () => this.deferGeneration === generation && this.scope === scope && sameScope(scope);
    const current = (this.data.medicationReminders as MedicationReminder[]).find(row => row.planId === plan.id);
    this.setData({ deferBusy: true, notice: '' });
    try {
      const record = await saveMedicationReminder(scope, plan.id, delay as 1 | 2, current?.version ?? 0);
      if (!isCurrent()) return;
      this.setData({ medicationReminders: [...(this.data.medicationReminders as MedicationReminder[]).filter(row => row.planId !== plan.id), record], notice: `${plan.drug}：${medicationReminderLabel(record)}。已同步至当前患者的照护记录，用药仍以医嘱为准。` });
      this.renderReminders(); await this.refreshReminders();
    } catch (error) {
      if (!isCurrent()) return;
      if (forbidden(error)) this.clearSensitiveState('当前身份已无权设置用药提醒，已清理本机敏感内容。');
      else { this.setData({ notice: describeError(error, '提醒保存结果尚未确认，请重试原操作。') }); await this.refreshReminders(); }
    } finally { if (isCurrent()) this.setData({ deferBusy: false }); }
  },
  goBack() { wx.switchTab({ url: '/pages/home/index' }); },
  openSupport() { wx.navigateTo({ url: '/pages/patient/support' }); },
});

export { parseOverview };
