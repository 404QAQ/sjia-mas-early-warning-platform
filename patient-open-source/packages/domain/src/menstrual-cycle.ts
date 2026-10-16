import type { Iso } from './types.js';

/** 女性患者自报的经期事实。该切片不推算排卵、疾病或治疗建议。 */
export const MENSTRUAL_PHASES = ['BLEEDING', 'RECENTLY_ENDED', 'BETWEEN_PERIODS', 'UNKNOWN'] as const;
export type MenstrualPhase = (typeof MENSTRUAL_PHASES)[number];

export interface MenstrualCycleSnapshot {
  version: number;
  periodStart?: Iso;
  periodEnd?: Iso;
  at: Iso;
  by: string;
  sharedWithCareTeam: boolean;
}

export interface MenstrualCycle {
  patientId: string;
  periodStart?: Iso;
  periodEnd?: Iso;
  sharedWithCareTeam: boolean;
  version: number;
  updatedAt: Iso;
  updatedBy: string;
  history: MenstrualCycleSnapshot[];
}

export interface MenstrualCycleView {
  patientId: string;
  version: number;
  updatedAt: Iso;
  /** 自报日期；只有患者本人或患者明确共享后医护可见。 */
  periodStart?: Iso;
  periodEnd?: Iso;
  sharedWithCareTeam: boolean;
  /** 只依据自报起止日期和读取时间给出粗粒度阶段。 */
  phase: MenstrualPhase;
  medicationReview: MenstrualMedicationReview;
}

export interface MenstrualMedicationReview {
  needsClinicianReview: boolean;
  medications: string[];
  message: string;
}

export interface MenstrualCycleShareView {
  patientId: string;
  sharedWithCareTeam: boolean;
  version: number;
}

/**
 * 阶段只表达患者已提供的经期窗口，不对排卵、周期长度、疾病活动或生育意愿作推断。
 * 起止日期缺失或非法时统一降级 UNKNOWN。
 */
export function deriveMenstrualPhase(value: Pick<MenstrualCycle, 'periodStart' | 'periodEnd'>, asOf: string): MenstrualPhase {
  const at = Date.parse(asOf);
  const start = value.periodStart ? Date.parse(value.periodStart) : NaN;
  const end = value.periodEnd ? Date.parse(value.periodEnd) : NaN;
  if (!Number.isFinite(at) || !Number.isFinite(start)) return 'UNKNOWN';
  if (Number.isFinite(end) && end < start) return 'UNKNOWN';
  if (at >= start && (!Number.isFinite(end) || at <= end)) return 'BLEEDING';
  if (Number.isFinite(end) && at > end && at - end <= 3 * 24 * 60 * 60 * 1000) return 'RECENTLY_ENDED';
  if (at > start && Number.isFinite(end)) return 'BETWEEN_PERIODS';
  return 'UNKNOWN';
}

export function isMenstrualCycle(value: unknown): value is MenstrualCycle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const allowed = ['patientId', 'periodStart', 'periodEnd', 'sharedWithCareTeam', 'version', 'updatedAt', 'updatedBy', 'history'];
  if (Object.keys(item).some(key => !allowed.includes(key))) return false;
  if (!text(item.patientId) || typeof item.sharedWithCareTeam !== 'boolean' || !version(item.version) || !iso(item.updatedAt) || !text(item.updatedBy)) return false;
  if (!optionalIso(item.periodStart) || !optionalIso(item.periodEnd)) return false;
  if (item.periodStart && item.periodEnd && Date.parse(String(item.periodEnd)) < Date.parse(String(item.periodStart))) return false;
  if (!Array.isArray(item.history) || item.history.length !== item.version) return false;
  return item.history.every((entry, index) => isSnapshot(entry, index + 1))
    && JSON.stringify(item.history[item.history.length - 1]) === JSON.stringify({ version: item.version, periodStart: item.periodStart, periodEnd: item.periodEnd, at: item.updatedAt, by: item.updatedBy, sharedWithCareTeam: item.sharedWithCareTeam });
}

function isSnapshot(value: unknown, expected: number): value is MenstrualCycleSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const allowed = ['version', 'periodStart', 'periodEnd', 'at', 'by', 'sharedWithCareTeam'];
  return Object.keys(item).every(key => allowed.includes(key)) && item.version === expected
    && optionalIso(item.periodStart) && optionalIso(item.periodEnd) && iso(item.at) && text(item.by)
    && typeof item.sharedWithCareTeam === 'boolean'
    && !(item.periodStart && item.periodEnd && Date.parse(String(item.periodEnd)) < Date.parse(String(item.periodStart)));
}

function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[\0\r\n]/.test(value); }
function iso(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function optionalIso(value: unknown): boolean { return value === undefined || iso(value); }
function version(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1; }
