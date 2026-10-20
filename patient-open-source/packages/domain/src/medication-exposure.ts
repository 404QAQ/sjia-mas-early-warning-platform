import { parseCareInstant } from './time.js';
import type { Iso } from './types.js';
import { isClinicianMedicationPlan, type MedicationLog, type MedicationPlan } from './medication.js';

/** T-04 的累计激素暴露质量。工程视图不会把缺失或不可换算的数据伪装成完整值。 */
export type SteroidExposureQuality = 'COMPLETE' | 'PARTIAL' | 'UNKNOWN';

/** 仓储追加的状态事实；仅消费生命周期字段，不向视图输出内部命令或操作者。 */
export interface SteroidExposurePlan extends MedicationPlan {
  statusCommands?: readonly { patientId: string; planId: string; fromStatus: MedicationPlan['status']; toStatus: MedicationPlan['status']; at: Iso }[];
}

export interface SteroidExposureExcludedLog {
  logId: string;
  planId: string;
  takenAt: Iso;
  unit: string;
  reason: 'UNSUPPORTED_UNIT' | 'OUTSIDE_PLAN_WINDOW' | 'AFTER_STATUS_CHANGE' | 'FUTURE_RECORD';
}

export interface SteroidExposureGap {
  planId: string;
  from: Iso;
  to: Iso;
  reason: 'MISSING_LOG' | 'UNSUPPORTED_UNIT' | 'NO_LOGS' | 'LIFECYCLE_UNKNOWN';
}

export interface SteroidExposureComponent {
  planId: string;
  drug: string;
  unit: string;
  status: MedicationPlan['status'];
  startedAt: Iso;
  actualDoseMg: number;
  expectedDoseMg: number | null;
  expectedDoseCount: number | null;
  observedLogIds: string[];
  missingDoseCount: number | null;
  quality: SteroidExposureQuality;
}

export interface SteroidExposureSummary {
  patientId: string;
  asOf: Iso;
  /** 计划窗口的日历跨度，重叠计划只计算一次；不代表个体预后。 */
  steroidMonthsTotal: number | null;
  /** 仅同一种药物可合并；不同激素不推定等效换算，没有可换算记录时为 null。 */
  cumulativeDoseMg: number | null;
  cumulativeDoseDrug?: string;
  cumulativeDoseByDrugMg: { drug: string; cumulativeDoseMg: number; logIds: string[] }[];
  quality: SteroidExposureQuality;
  durationBasis: 'PLAN_WINDOW';
  components: SteroidExposureComponent[];
  gaps: SteroidExposureGap[];
  excludedLogs: SteroidExposureExcludedLog[];
  calculation: {
    supportedUnits: ['mg', 'g'];
    doseBasis: 'DRUG_SPECIFIC_MASS_NOT_EQUIVALENT';
    /** 达到读取上限时无法确认更早记录是否存在，不能声称全量完整。 */
    logReadLimitReached: boolean;
    includedLogIds: string[];
    excludedLogIds: string[];
  };
}

const DAY = 86_400_000;
const MONTH = 365.2425 * DAY / 12;

/**
 * 从既有计划和实际记录生成 T-04 的只读累计暴露视图。
 *
 * 只换算 mg/g。mg/kg、片等单位必须保留为排除项，避免没有体重或药品规格
 * 时制造看似精确的 mg 数值；缺少实际记录也只进入 gap，不补写 0。
 */
export function buildSteroidExposure(
  plans: readonly SteroidExposurePlan[],
  logs: readonly MedicationLog[],
  asOf: Iso,
  patientId?: string,
  options: { logReadLimitReached?: boolean } = {},
): SteroidExposureSummary {
  const cutoff = parseCareInstant(asOf);
  const resolvedPatientId = patientId ?? plans[0]?.patientId ?? logs[0]?.patientId ?? '';
  const steroidPlans = plans.filter(plan => isClinicianMedicationPlan(plan) && (!plan.confirmedAt || parseCareInstant(plan.confirmedAt) <= cutoff) && plan.kind === 'STEROID' && plan.patientId === resolvedPatientId && parseCareInstant(plan.startedAt) <= cutoff);
  const gaps: SteroidExposureGap[] = [];
  const excludedLogs: SteroidExposureExcludedLog[] = [];
  const includedLogIds: string[] = [];
  const lifetimes = new Map(steroidPlans.map(plan => [plan.id, planLifetime(plan, cutoff)]));
  const components = steroidPlans.map(plan => {
    const lifetime = lifetimes.get(plan.id)!;
    const planLogs = logs.filter(log => log.patientId === resolvedPatientId && log.planId === plan.id);
    const inWindow = planLogs.filter(log => parseCareInstant(log.takenAt) >= lifetime.start && parseCareInstant(log.takenAt) <= cutoff
      && parseCareInstant(log.recordedAt) <= cutoff && (lifetime.end === undefined || parseCareInstant(log.takenAt) < lifetime.end));
    for (const log of planLogs) {
      const stamp = parseCareInstant(log.takenAt);
      if (stamp > cutoff || parseCareInstant(log.recordedAt) > cutoff) {
        excludedLogs.push({ logId: log.id, planId: plan.id, takenAt: canonical(log.takenAt), unit: log.unit, reason: 'FUTURE_RECORD' });
      } else if (stamp < lifetime.start) {
        excludedLogs.push({ logId: log.id, planId: plan.id, takenAt: canonical(log.takenAt), unit: log.unit, reason: 'OUTSIDE_PLAN_WINDOW' });
      } else if (lifetime.end !== undefined && stamp >= lifetime.end) {
        excludedLogs.push({ logId: log.id, planId: plan.id, takenAt: canonical(log.takenAt), unit: log.unit, reason: 'AFTER_STATUS_CHANGE' });
      }
    }
    const convertible = inWindow.filter(log => unitFactor(log.unit) !== undefined);
    for (const log of inWindow.filter(item => unitFactor(item.unit) === undefined)) {
      excludedLogs.push({ logId: log.id, planId: plan.id, takenAt: canonical(log.takenAt), unit: log.unit, reason: 'UNSUPPORTED_UNIT' });
    }
    const factor = unitFactor(plan.unit);
    const expected = lifetime.known ? expectedDose(plan, Math.min(cutoff, lifetime.end === undefined ? cutoff : lifetime.end - 1), factor) : undefined;
    const actualDoseMg = round(convertible.reduce((sum, item) => sum + item.actualDose * (unitFactor(item.unit) ?? 0), 0));
    const expectedDoseMg = expected?.doseMg === undefined || expected.doseMg === null ? null : round(expected.doseMg);
    const missingDoseCount = expected === undefined ? null : Math.max(0, expected.count - recordedOccurrences(plan, convertible, expected.firstAt ? parseCareInstant(expected.firstAt) : lifetime.start, expected.count));
    const quality: SteroidExposureQuality = !lifetime.known || factor === undefined || inWindow.length === 0 && (expected?.count ?? 0) > 0
      ? 'UNKNOWN'
      : (missingDoseCount ?? 0) > 0 || convertible.length !== inWindow.length || options.logReadLimitReached ? 'PARTIAL' : 'COMPLETE';
    if (!lifetime.known) {
      gaps.push({ planId: plan.id, from: new Date(lifetime.start).toISOString(), to: canonical(asOf), reason: 'LIFECYCLE_UNKNOWN' });
    } else if (factor === undefined) {
      gaps.push({ planId: plan.id, from: new Date(lifetime.start).toISOString(), to: canonical(asOf), reason: 'UNSUPPORTED_UNIT' });
    } else if (expected && expected.count > 0 && convertible.length === 0) {
      gaps.push({ planId: plan.id, from: canonical(expected.firstAt ?? plan.startedAt), to: canonical(expected.lastAt ?? asOf), reason: 'NO_LOGS' });
    } else if (expected && (missingDoseCount ?? 0) > 0) {
      gaps.push({ planId: plan.id, from: canonical(expected.firstAt ?? plan.startedAt), to: canonical(expected.lastAt ?? asOf), reason: 'MISSING_LOG' });
    }
    const observedLogIds = convertible.map(log => log.id).sort();
    includedLogIds.push(...observedLogIds);
    return { planId: plan.id, drug: plan.drug, unit: plan.unit, status: lifetime.status, startedAt: new Date(lifetime.start).toISOString(), actualDoseMg,
      expectedDoseMg, expectedDoseCount: expected?.count ?? null, observedLogIds, missingDoseCount, quality };
  }).sort((left, right) => left.planId.localeCompare(right.planId));

  const intervals = [...lifetimes.values()].filter(item => item.known).map(item => [item.start, Math.max(item.start, Math.min(item.end ?? cutoff, cutoff))] as const).sort((left, right) => left[0] - right[0]);
  let coveredMs = 0;
  let current: [number, number] | undefined;
  for (const interval of intervals) {
    if (!current) current = [interval[0], interval[1]];
    else if (interval[0] <= current[1]) current[1] = Math.max(current[1], interval[1]);
    else { coveredMs += current[1] - current[0]; current = [interval[0], interval[1]]; }
  }
  if (current) coveredMs += current[1] - current[0];
  const dosesByDrug = new Map<string, { drug: string; cumulativeDoseMg: number; logIds: string[] }>();
  for (const component of components) {
    if (!component.observedLogIds.length) continue;
    const drug = component.drug.trim(), existing = dosesByDrug.get(drug) ?? { drug, cumulativeDoseMg: 0, logIds: [] };
    existing.cumulativeDoseMg = round(existing.cumulativeDoseMg + component.actualDoseMg);
    existing.logIds.push(...component.observedLogIds);
    dosesByDrug.set(drug, existing);
  }
  // 按 codePoint 排序，不用 localeCompare：后者的结果依赖进程默认 ICU locale
  // （zh-CN 下「甲泼尼龙」在前，en 下「泼尼松」在前），会让同一份临床数据的
  // 输出顺序随部署环境变化。累积剂量必须跨环境确定。
  const cumulativeDoseByDrugMg = [...dosesByDrug.values()].map(item => ({ ...item, logIds: item.logIds.sort() }))
    .sort((a, b) => (a.drug < b.drug ? -1 : a.drug > b.drug ? 1 : 0));
  const singleDrug = new Set(steroidPlans.map(plan => plan.drug.trim())).size === 1 ? cumulativeDoseByDrugMg[0] : undefined;
  const quality = combineQuality(components.map(component => component.quality));
  const excludedLogIds = excludedLogs.map(item => item.logId).sort();
  return {
    patientId: resolvedPatientId, asOf: canonical(asOf), steroidMonthsTotal: steroidPlans.length && [...lifetimes.values()].every(item => item.known) ? round(coveredMs / MONTH, 2) : null,
    cumulativeDoseMg: singleDrug?.cumulativeDoseMg ?? null, ...(singleDrug ? { cumulativeDoseDrug: singleDrug.drug } : {}), cumulativeDoseByDrugMg, quality, durationBasis: 'PLAN_WINDOW',
    components, gaps, excludedLogs: excludedLogs.sort((left, right) => left.takenAt.localeCompare(right.takenAt) || left.logId.localeCompare(right.logId)),
    calculation: { supportedUnits: ['mg', 'g'], doseBasis: 'DRUG_SPECIFIC_MASS_NOT_EQUIVALENT', logReadLimitReached: options.logReadLimitReached ?? false, includedLogIds: [...new Set(includedLogIds)].sort(), excludedLogIds: [...new Set(excludedLogIds)] },
  };
}

function unitFactor(unit: string): number | undefined {
  if (typeof unit !== 'string') return undefined;
  const normalized = unit.trim().toLowerCase();
  return normalized === 'mg' ? 1 : normalized === 'g' ? 1000 : undefined;
}

function planLifetime(plan: SteroidExposurePlan, cutoff: number): { start: number; end?: number; status: MedicationPlan['status']; known: boolean } {
  const start = Math.max(parseCareInstant(plan.confirmedAt ?? plan.startedAt), parseCareInstant(plan.startedAt), ...plan.schedule.slice(0, 1).map(point => parseCareInstant(point.effectiveFrom)));
  const commands = (plan.statusCommands ?? []).filter(command => command.patientId === plan.patientId && command.planId === plan.id
    && command.fromStatus === 'ACTIVE' && (command.toStatus === 'PAUSED' || command.toStatus === 'STOPPED'))
    .map(command => ({ at: parseCareInstant(command.at), fromStatus: command.fromStatus, toStatus: command.toStatus }))
    .sort((a, b) => a.at - b.at);
  const allStatusCommands = (plan.statusCommands ?? []).filter(command => command.patientId === plan.patientId && command.planId === plan.id)
    .map(command => ({ at: parseCareInstant(command.at), fromStatus: command.fromStatus, toStatus: command.toStatus }))
    .sort((a, b) => a.at - b.at);
  const ending = commands.find(command => command.at <= cutoff)?.at;
  // When the current plan is inactive but the query cuts through a later status
  // command, the command's fromStatus is the only trustworthy state at the
  // historical boundary. Without an ACTIVE state or an in-window ACTIVE→end
  // command, duration must remain unknown rather than treating an unrelated
  // future PAUSED→STOPPED command as proof of an earlier active window.
  const firstFuture = allStatusCommands.find(command => command.at > cutoff);
  const status = firstFuture?.fromStatus ?? plan.status;
  const known = status === 'ACTIVE' || commands.some(command => command.at <= cutoff);
  return { start, ...(ending === undefined ? {} : { end: ending }), status, known };
}

function expectedDose(plan: MedicationPlan, cutoff: number, factor: number | undefined): { count: number; doseMg: number | null; firstAt?: Iso; lastAt?: Iso } {
  const step = plan.frequency === 'DAILY' ? DAY : plan.frequency === 'WEEKLY' ? 7 * DAY : plan.frequency === 'EVERY_4_WEEKS' ? 28 * DAY : null;
  if (!step) return { count: 0, doseMg: 0 };
  const schedule = [...plan.schedule].sort((left, right) => parseCareInstant(left.effectiveFrom) - parseCareInstant(right.effectiveFrom));
  const anchor = Math.max(parseCareInstant(plan.startedAt), schedule[0] === undefined ? parseCareInstant(plan.startedAt) : parseCareInstant(schedule[0].effectiveFrom));
  let count = 0;
  let doseMg = factor === undefined ? null : 0;
  let firstAt: Iso | undefined;
  let lastAt: Iso | undefined;
  for (let index = 0; index < schedule.length; index += 1) {
    const point = schedule[index]!;
    const start = anchor + Math.ceil(Math.max(0, Math.max(parseCareInstant(point.effectiveFrom), parseCareInstant(plan.confirmedAt ?? plan.startedAt)) - anchor) / step) * step;
    const end = Math.min(cutoff, index + 1 < schedule.length ? parseCareInstant(schedule[index + 1]!.effectiveFrom) - 1 : cutoff);
    if (start > end) continue;
    const occurrences = Math.floor((end - start) / step) + 1;
    count += occurrences;
    firstAt ??= new Date(start).toISOString(); lastAt = new Date(start + (occurrences - 1) * step).toISOString();
    if (doseMg !== null) doseMg += point.plannedDose * factor! * occurrences;
  }
  return { count, doseMg, ...(firstAt ? { firstAt } : {}), ...(lastAt ? { lastAt } : {}) };
}

function recordedOccurrences(plan: MedicationPlan, logs: readonly MedicationLog[], anchor: number, count: number): number {
  const cadence = plan.frequency === 'DAILY' ? 1 : plan.frequency === 'WEEKLY' ? 7 : plan.frequency === 'EVERY_4_WEEKS' ? 28 : undefined;
  if (cadence === undefined) return 0;
  const firstDay = Math.floor((anchor + 8 * 3_600_000) / DAY);
  return new Set(logs.map(log => Math.floor((parseCareInstant(log.takenAt) + 8 * 3_600_000) / DAY) - firstDay)
    .filter(day => day >= 0 && day % cadence === 0 && day / cadence < count)).size;
}

function combineQuality(values: readonly SteroidExposureQuality[]): SteroidExposureQuality {
  if (values.length === 0 || values.every(value => value === 'UNKNOWN')) return 'UNKNOWN';
  if (values.some(value => value !== 'COMPLETE')) return 'PARTIAL';
  return 'COMPLETE';
}

function canonical(value: string): Iso { return new Date(parseCareInstant(value)).toISOString(); }
function round(value: number, decimals = 6): number { const factor = 10 ** decimals; return Math.round(value * factor) / factor; }
