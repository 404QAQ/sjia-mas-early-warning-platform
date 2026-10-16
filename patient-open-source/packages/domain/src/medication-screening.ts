import { parseCareInstant } from './care-routing.js';
import type { Iso } from './types.js';

/** 长期用药必须持续关注的五类筛查。筛查优先级不随缓解期降低。 */
export type MedicationScreeningType =
  | 'OPHTHALMOLOGY'
  | 'BONE_DENSITY'
  | 'GROWTH'
  | 'BP_GLUCOSE'
  | 'DENTAL';

export type MedicationScreeningStatus = 'OK' | 'DUE_SOON' | 'OVERDUE' | 'DONE';

export interface MedicationScreeningDefinition {
  type: MedicationScreeningType;
  label: string;
  defaultIntervalMonths?: number;
  reason: string;
}

export interface MedicationScreeningSchedule {
  patientId: string;
  type: MedicationScreeningType;
  /** null 表示按每次复诊安排，由临床端提供具体 dueAt。 */
  intervalMonths: number | null;
  lastDoneAt?: Iso;
  dueAt: Iso;
  status?: MedicationScreeningStatus;
  doneAt?: Iso;
  doneAtFacility?: string;
  extendedByClinician?: boolean;
  extendedAt?: Iso;
  extendedBy?: string;
  extensionReason?: string;
}

export interface MedicationScreeningEvaluation {
  status: MedicationScreeningStatus;
  daysUntilDue: number;
  /** 永远提醒这些筛查不因缓解期而降级。 */
  priority: 'MAINTAINED';
}

const DEFINITIONS: readonly MedicationScreeningDefinition[] = [
  { type: 'OPHTHALMOLOGY', label: '眼科检查（白内障 / 青光眼）', defaultIntervalMonths: 6, reason: '激素可能影响眼睛，早期自己感觉不到。定期查是为了早点发现。' },
  { type: 'BONE_DENSITY', label: '骨密度', defaultIntervalMonths: 12, reason: '长期用药需要持续关注骨骼变化。' },
  { type: 'GROWTH', label: '生长曲线与骨龄', defaultIntervalMonths: 6, reason: '生长变化需要结合曲线持续观察。' },
  { type: 'BP_GLUCOSE', label: '血压 / 血糖', reason: '复诊时一起记录，便于持续观察用药影响。' },
  { type: 'DENTAL', label: '口腔检查', defaultIntervalMonths: 6, reason: '长期用药期间需要规律关注口腔健康。' },
];

const byType = new Map(DEFINITIONS.map(item => [item.type, item]));
const DAY = 86_400_000;
const DUE_SOON_DAYS = 31;

export function medicationScreeningDefinitions(): readonly MedicationScreeningDefinition[] {
  return DEFINITIONS.map(item => ({ ...item }));
}

export function medicationScreeningDefinition(type: unknown): MedicationScreeningDefinition | undefined {
  if (typeof type !== 'string') return undefined;
  const item = byType.get(type as MedicationScreeningType);
  return item ? { ...item } : undefined;
}

/** 以公历月推进日期，月底取目标月最后一天，不依赖运行环境本地时区。 */
export function addScreeningMonths(value: Iso, months: number): Iso {
  const stamp = parseCareInstant(value);
  if (!Number.isInteger(months) || months <= 0) throw new RangeError('筛查间隔必须是正整数月');
  const source = new Date(stamp);
  const target = new Date(stamp);
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(source.getUTCDate(), lastDay));
  target.setUTCHours(source.getUTCHours(), source.getUTCMinutes(), source.getUTCSeconds(), source.getUTCMilliseconds());
  return target.toISOString();
}

export function evaluateMedicationScreening(schedule: MedicationScreeningSchedule, now: Iso): MedicationScreeningEvaluation {
  validateSchedule(schedule);
  const nowStamp = parseCareInstant(now);
  const dueStamp = parseCareInstant(schedule.dueAt);
  if (schedule.doneAt !== undefined && parseCareInstant(schedule.doneAt) > nowStamp) throw new RangeError('筛查完成时间不能晚于当前时间');
  const deltaMilliseconds = dueStamp - nowStamp;
  const deltaDays = deltaMilliseconds < 0 ? Math.floor(deltaMilliseconds / DAY) : Math.ceil(deltaMilliseconds / DAY);
  if (deltaMilliseconds < 0) return { status: 'OVERDUE', daysUntilDue: deltaDays, priority: 'MAINTAINED' };
  if (deltaDays <= DUE_SOON_DAYS) return { status: 'DUE_SOON', daysUntilDue: deltaDays, priority: 'MAINTAINED' };
  if (schedule.doneAt !== undefined) return { status: 'DONE', daysUntilDue: deltaDays, priority: 'MAINTAINED' };
  return { status: 'OK', daysUntilDue: deltaDays, priority: 'MAINTAINED' };
}

export function recordMedicationScreening(
  schedule: MedicationScreeningSchedule,
  doneAt: Iso,
  facility: string,
): MedicationScreeningSchedule {
  validateSchedule(schedule);
  if (typeof facility !== 'string' || !facility.trim() || facility.length > 200) throw new RangeError('筛查机构不能为空');
  const doneStamp = parseCareInstant(doneAt);
  const latestDoneAt = schedule.lastDoneAt ?? schedule.doneAt;
  if (latestDoneAt !== undefined && doneStamp < parseCareInstant(latestDoneAt)) throw new RangeError('筛查完成日期不能早于最近一次完成日期');
  const nextDueAt = schedule.intervalMonths === null ? schedule.dueAt : addScreeningMonths(doneAt, schedule.intervalMonths);
  return { ...schedule, lastDoneAt: doneAt, doneAt, doneAtFacility: facility.trim(), dueAt: nextDueAt, status: 'DONE' };
}

/** 延期是临床决定；患者端不能自行调用此函数，必须带操作者与理由。 */
export function extendMedicationScreening(
  schedule: MedicationScreeningSchedule,
  dueAt: Iso,
  clinicianId: string,
  reason: string,
  at: Iso,
): MedicationScreeningSchedule {
  validateSchedule(schedule);
  if (typeof clinicianId !== 'string' || !clinicianId.trim()) throw new RangeError('延期必须记录临床操作者');
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) throw new RangeError('延期必须记录理由');
  if (parseCareInstant(dueAt) <= parseCareInstant(schedule.dueAt)) throw new RangeError('新的筛查日期必须晚于原日期');
  parseCareInstant(at);
  if (parseCareInstant(at) > parseCareInstant(dueAt)) throw new RangeError('延期决定时间无效');
  return { ...schedule, dueAt, extendedByClinician: true, extendedAt: at, extendedBy: clinicianId, extensionReason: reason.trim(), status: undefined };
}

function validateSchedule(schedule: MedicationScreeningSchedule): void {
  if (!schedule || typeof schedule !== 'object' || !medicationScreeningDefinition(schedule.type)) throw new RangeError('未知的筛查类型');
  if (typeof schedule.patientId !== 'string' || !schedule.patientId.trim()) throw new RangeError('患者标识不能为空');
  if (schedule.intervalMonths !== null && (!Number.isInteger(schedule.intervalMonths) || schedule.intervalMonths <= 0 || schedule.intervalMonths > 120)) throw new RangeError('筛查间隔无效');
  parseCareInstant(schedule.dueAt);
  if (schedule.lastDoneAt !== undefined) parseCareInstant(schedule.lastDoneAt);
  if (schedule.doneAt !== undefined) parseCareInstant(schedule.doneAt);
  if (schedule.extendedAt !== undefined) parseCareInstant(schedule.extendedAt);
  if (schedule.extendedByClinician && (!schedule.extendedBy || !schedule.extensionReason)) throw new RangeError('延期记录不完整');
}
