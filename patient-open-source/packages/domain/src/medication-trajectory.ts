import { parseCareInstant } from './time.js';
import type { Iso } from './types.js';
import type { MedicationLog, MedicationPlan } from './medication.js';

export type MedicationTrajectoryPointKind = 'PLAN' | 'ACTUAL';
export type MedicationTrajectoryComparison = 'PLANNED' | 'ON_PLAN' | 'ABOVE_PLAN' | 'BELOW_PLAN' | 'UNPLANNED';

/**
 * M-02 的只读轨迹点。缺少实际记录时只返回计划事实，不把缺失伪装成 0；
 * 跨计划、计划开始前或单位不一致的实际记录会保留为 UNPLANNED，交给上层显式提示。
 */
export interface MedicationTrajectoryPoint {
  at: Iso;
  kind: MedicationTrajectoryPointKind;
  plannedDose?: number;
  actualDose?: number;
  delta?: number;
  comparison: MedicationTrajectoryComparison;
  logId?: string;
  unit: string;
}

/** 生成确定性的计划/实际双轨事实，纯函数且不会修改输入。 */
export function buildMedicationTrajectory(plan: MedicationPlan, logs: readonly MedicationLog[], asOf: Iso): MedicationTrajectoryPoint[] {
  const cutoff = parseCareInstant(asOf);
  const schedule = [...plan.schedule].sort((left, right) => parseCareInstant(left.effectiveFrom) - parseCareInstant(right.effectiveFrom));
  const points: MedicationTrajectoryPoint[] = [];
  for (const point of schedule) {
    if (parseCareInstant(point.effectiveFrom) <= cutoff) points.push({ at: canonical(point.effectiveFrom), kind: 'PLAN', plannedDose: point.plannedDose, comparison: 'PLANNED', unit: plan.unit });
  }
  for (const item of logs) {
    if (item.patientId !== plan.patientId || item.planId !== plan.id || parseCareInstant(item.takenAt) > cutoff) continue;
    const active = [...schedule].reverse().find(point => parseCareInstant(point.effectiveFrom) <= parseCareInstant(item.takenAt));
    if (!active || item.unit !== plan.unit) {
      points.push({ at: canonical(item.takenAt), kind: 'ACTUAL', actualDose: item.actualDose, comparison: 'UNPLANNED', logId: item.id, unit: item.unit });
      continue;
    }
    const delta = item.actualDose - active.plannedDose;
    points.push({ at: canonical(item.takenAt), kind: 'ACTUAL', plannedDose: active.plannedDose, actualDose: item.actualDose, delta, comparison: delta === 0 ? 'ON_PLAN' : delta > 0 ? 'ABOVE_PLAN' : 'BELOW_PLAN', logId: item.id, unit: item.unit });
  }
  return points.sort((left, right) => parseCareInstant(left.at) - parseCareInstant(right.at) || (left.kind === right.kind ? (left.logId ?? '').localeCompare(right.logId ?? '') : left.kind === 'PLAN' ? -1 : 1));
}

function canonical(value: string): string { return new Date(parseCareInstant(value)).toISOString(); }
