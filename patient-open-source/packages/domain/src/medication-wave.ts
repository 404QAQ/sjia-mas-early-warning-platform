import type { Code, ObservationSource } from './codes.js';
import type { Iso, Observation } from './types.js';
import { parseCareInstant } from './time.js';
import type { MedicationFrequency, MedicationLog, MedicationPlan, MedicationPlanStatus } from './medication.js';

/**
 * 用药与波动共享投影中的单条观测。
 * 该视图只用于对齐时间，不包含诊断或风险结论。
 */
export interface MedicationWaveObservation {
  id: string;
  code: Code;
  display: string;
  valueNumeric?: number;
  valueText?: string;
  unit: string;
  observedAt: Iso;
  source: ObservationSource;
}

export interface MedicationWavePlan {
  id: string;
  drug: string;
  kind: MedicationPlan['kind'];
  route: MedicationPlan['route'];
  frequency: MedicationFrequency;
  unit: string;
  status: MedicationPlanStatus;
}

export interface MedicationWavePlannedDose {
  planId: string;
  drug: string;
  plannedDose: number;
  unit: string;
  dueAt: Iso;
  frequency: MedicationFrequency;
}

export interface MedicationWaveActualDose {
  logId: string;
  planId: string;
  drug: string;
  actualDose: number;
  unit: string;
  takenAt: Iso;
  source: MedicationLog['source'];
  frequency: MedicationFrequency;
  /** 计划接续后，原自记计划日志可同时关联到接续计划。 */
  relatedPlanIds: string[];
}

export type MedicationWaveRelationKind = 'ON_PLAN' | 'BELOW_PLAN' | 'ABOVE_PLAN' | 'MISSED' | 'UNPLANNED' | 'AS_NEEDED';

export interface MedicationWaveRelationHint {
  kind: MedicationWaveRelationKind;
  text: string;
  planId?: string;
  observationIds?: string[];
}

export interface MedicationWaveDay {
  /** 上海业务日，格式 YYYY-MM-DD。 */
  date: string;
  observations: MedicationWaveObservation[];
  planned: MedicationWavePlannedDose[];
  actual: MedicationWaveActualDose[];
  relationHints: MedicationWaveRelationHint[];
}

export interface MedicationWaveView {
  patientId: string;
  asOf: Iso;
  range: { from: string; to: string; days: 14 };
  plans: MedicationWavePlan[];
  days: MedicationWaveDay[];
}

export interface BuildMedicationWaveInput {
  patientId: string;
  asOf: Iso;
  plans: readonly MedicationPlan[];
  logs: readonly MedicationLog[];
  observations: readonly Observation[];
  /** 计划在 asOf 前暂停/停止时的首个结束时间；用于裁剪之后的计划剂量。 */
  planEndAt?: Readonly<Record<string, Iso>>;
}

/**
 * 生成共享用药—波动时间轴。
 *
 * 时间窗严格固定为 asOf 所在上海业务日及之前 13 天；所有输入记录均按
 * observed/taken/recorded 时间同时不晚于 asOf 过滤，避免患者端和医生端读到
 * 不同版本的未来记录。该函数只描述事实关系，不输出诊断结论。
 */
export function buildMedicationWave(input: BuildMedicationWaveInput): MedicationWaveView {
  const asOfMs = parseCareInstant(input.asOf);
  const asOf = new Date(asOfMs).toISOString();
  const toDay = businessDayNumber(asOf);
  const fromDay = toDay - 13;
  const from = businessDateAt(fromDay);
  const to = businessDateAt(toDay);

  const plans = input.plans
    .filter(plan => plan.patientId === input.patientId && parseCareInstant(plan.createdAt) <= asOfMs && parseCareInstant(plan.startedAt) <= asOfMs)
    .map(plan => ({ id: plan.id, drug: plan.drug, kind: plan.kind, route: plan.route, frequency: plan.frequency, unit: plan.unit, status: plan.status }));
  const sourcePlans = input.plans.filter(plan => plans.some(item => item.id === plan.id));
  const days = Array.from({ length: 14 }, (_, index) => {
    const day = fromDay + index;
    const date = businessDateAt(day);
    const observations = input.observations
      .filter(item => item.patientId === input.patientId && parseCareInstant(item.observedAt) <= asOfMs && parseCareInstant(item.recordedAt) <= asOfMs && businessDayNumber(item.observedAt) === day)
      .sort((left, right) => parseCareInstant(left.observedAt) - parseCareInstant(right.observedAt) || left.id.localeCompare(right.id))
      .map(toObservationView);
    const planned = sourcePlans.flatMap(plan => plannedDosesForDay(plan, day, asOfMs, input.planEndAt?.[plan.id]));
    const actual = input.logs
      .filter(log => log.patientId === input.patientId && parseCareInstant(log.takenAt) <= asOfMs && parseCareInstant(log.recordedAt) <= asOfMs && businessDayNumber(log.takenAt) === day && sourcePlans.some(plan => log.planId === plan.id || log.planId === plan.originReportedPlanId))
      .sort((left, right) => parseCareInstant(left.takenAt) - parseCareInstant(right.takenAt) || left.id.localeCompare(right.id))
      .map(log => toActualView(log, sourcePlans));
    return { date, observations, planned, actual, relationHints: relationHints(planned, actual, observations) };
  });

  return { patientId: input.patientId, asOf, range: { from, to, days: 14 }, plans, days };
}

function plannedDosesForDay(plan: MedicationPlan, day: number, asOfMs: number, endAt?: Iso): MedicationWavePlannedDose[] {
  if (plan.frequency === 'AS_NEEDED') return [];
  const anchor = Math.max(parseCareInstant(plan.startedAt), parseCareInstant(plan.schedule[0]?.effectiveFrom ?? plan.startedAt));
  const anchorDay = businessDayNumber(new Date(anchor).toISOString());
  const cadence = plan.frequency === 'DAILY' ? 1 : plan.frequency === 'WEEKLY' ? 7 : 28;
  if (day < anchorDay || (day - anchorDay) % cadence !== 0) return [];
  const dueAt = businessDateAt(day);
  const dueInstant = anchor + (day - anchorDay) * 86_400_000;
  if (dueInstant > asOfMs || endAt !== undefined && dueInstant >= parseCareInstant(endAt) || plan.confirmedAt !== undefined && dueInstant < parseCareInstant(plan.confirmedAt)) return [];
  const schedule = [...plan.schedule].reverse().find(point => parseCareInstant(point.effectiveFrom) <= dueInstant);
  if (!schedule) return [];
  return [{ planId: plan.id, drug: plan.drug, plannedDose: schedule.plannedDose, unit: plan.unit, dueAt, frequency: plan.frequency }];
}

function toObservationView(item: Observation): MedicationWaveObservation {
  return {
    id: item.id,
    code: item.code,
    display: item.display,
    ...(item.valueNumeric === undefined ? {} : { valueNumeric: item.valueNumeric }),
    ...(item.valueText === undefined ? {} : { valueText: item.valueText }),
    unit: item.unit,
    observedAt: item.observedAt,
    source: item.source,
  };
}

function toActualView(log: MedicationLog, plans: readonly MedicationPlan[]): MedicationWaveActualDose {
  const plan = plans.find(item => item.id === log.planId || item.originReportedPlanId === log.planId);
  const relatedPlanIds = [log.planId, ...plans.filter(item => item.originReportedPlanId === log.planId).map(item => item.id)];
  return { logId: log.id, planId: log.planId, drug: plan?.drug ?? '未知用药', actualDose: log.actualDose, unit: log.unit, takenAt: log.takenAt, source: log.source, frequency: plan?.frequency ?? 'AS_NEEDED', relatedPlanIds: [...new Set(relatedPlanIds)] };
}

function relationHints(planned: readonly MedicationWavePlannedDose[], actual: readonly MedicationWaveActualDose[], observations: readonly MedicationWaveObservation[]): MedicationWaveRelationHint[] {
  const hints: MedicationWaveRelationHint[] = [];
  for (const item of planned) {
    const doses = actual.filter(log => log.planId === item.planId || log.relatedPlanIds.includes(item.planId));
    const match = doses[0];
    if (!match) {
      hints.push({ kind: 'MISSED', text: `${item.drug}计划剂量未记录`, planId: item.planId, ...(observations.length ? { observationIds: observations.map(observation => observation.id) } : {}) });
    } else {
      // A scheduled day can contain more than one recorded dose. Preserve
      // every comparison so the shared view never hides a later deviation.
      for (const dose of doses) {
        if (dose.actualDose === item.plannedDose) hints.push({ kind: 'ON_PLAN', text: `${item.drug}按计划记录`, planId: item.planId });
        else if (dose.actualDose < item.plannedDose) hints.push({ kind: 'BELOW_PLAN', text: `${item.drug}实际剂量低于计划`, planId: item.planId });
        else hints.push({ kind: 'ABOVE_PLAN', text: `${item.drug}实际剂量高于计划`, planId: item.planId });
      }
    }
  }
  for (const item of actual.filter(log => !planned.some(plan => plan.planId === log.planId || log.relatedPlanIds.includes(plan.planId)))) {
    hints.push(item.frequency === 'AS_NEEDED'
      ? { kind: 'AS_NEEDED', text: '当天记录为按需用药', planId: item.planId }
      : { kind: 'UNPLANNED', text: `${item.drug}有实际记录但当天没有计划剂量`, planId: item.planId });
  }
  return hints;
}

const businessDateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
function businessDay(value: string): string { return businessDateFormatter.format(new Date(parseCareInstant(value))); }
function businessDayNumber(value: string): number { return Math.floor(Date.parse(`${businessDay(value)}T00:00:00.000Z`) / 86_400_000); }
function businessDateAt(day: number): string { return new Date(day * 86_400_000).toISOString().slice(0, 10); }
