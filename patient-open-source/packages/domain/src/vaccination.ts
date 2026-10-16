import type { Iso } from './types.js';
import { isClinicianMedicationPlan, type MedicationPlan, type MedicationPlanStatus } from './medication.js';
import { parseCareInstant } from './care-routing.js';

/** L-03 疫苗分类只表达知识规则，不表达个体接种建议或适合性判断。 */
export type ImmunosuppressionStatus = 'KNOWN' | 'UNKNOWN';
export type VaccinationClassification = 'BLOCKED' | 'INACTIVATED' | 'UNKNOWN';
export type VaccinationRecordSource = 'PATIENT' | 'CAREGIVER' | 'CLINICIAN';

export interface ImmunosuppressionStateRef {
  status: ImmunosuppressionStatus;
  regimen?: string;
  effectiveFrom?: Iso;
  /** 只允许表示服务端当前用药读取；客户端不能写入。 */
  source: 'SERVER_MEDICATIONS';
}

export interface LiveAttenuatedVaccinationGroup {
  classification: Extract<VaccinationClassification, 'BLOCKED' | 'UNKNOWN'>;
  blocked: boolean;
  vaccines: string[];
  reasonRef?: string;
  sourceRef: string;
}

export interface InactivatedVaccinationItem {
  vaccine: string;
  classification: Extract<VaccinationClassification, 'INACTIVATED' | 'UNKNOWN'>;
  /** 可复核的知识来源，不是个体化医疗建议。 */
  sourceRef: string;
}

export interface VaccinationSpacingRule {
  vaccine: string;
  biologicalAgent: string;
  /** 规格未给出安全间隔时为 null，必须由医生/运营知识库核对。 */
  minIntervalDays: number | null;
  sourceRef: string;
}

export interface HouseholdVaccinationItem {
  name: string;
  done: boolean;
  doneAt?: Iso;
}

export interface HouseholdVaccinationMember {
  relation: string;
  vaccines: HouseholdVaccinationItem[];
}

export interface VaccinationRecord {
  id: string;
  patientId: string;
  vaccine: string;
  administeredAt: Iso;
  facility: string;
  source: VaccinationRecordSource;
  recordedAt: Iso;
  recordedBy: string;
  idempotencyKey?: string;
}

export type VaccinationRecordView = Omit<VaccinationRecord, 'recordedBy' | 'idempotencyKey'>;

export interface VaccinationRecordConfirmationView {
  status: 'UNCONFIRMED' | 'CONFIRMED';
  confirmedAt?: Iso;
  confirmedByDisplayName?: string;
}

export type VaccinationDoctorRecordView = VaccinationRecordView & { confirmation: VaccinationRecordConfirmationView };

export type AnnualInfluenzaStatus =
  | 'CURRENT_YEAR_RECORDED'
  | 'WINDOW_APPROACHING'
  | 'WINDOW_OPEN'
  | 'WINDOW_PASSED'
  | 'NEXT_WINDOW'
  | 'UNKNOWN';

export interface AnnualInfluenzaWindow {
  from: string;
  to: string;
  reminderFrom: string;
}

export interface AnnualInfluenzaStatusView {
  vaccine: 'INFLUENZA';
  localYear: number;
  status: AnnualInfluenzaStatus;
  window: AnnualInfluenzaWindow;
  sourceRef: string;
  lastRecord?: Pick<VaccinationRecordView, 'id' | 'patientId' | 'administeredAt' | 'facility' | 'source' | 'recordedAt'>;
}

export interface VaccinationDoctorAnnualInfluenzaView extends Omit<AnnualInfluenzaStatusView, 'lastRecord'> {
  lastRecord?: { id: string; administeredAt: Iso; facility: string; source: VaccinationRecordSource; confirmed: boolean };
}

export interface VaccinationSchedule {
  patientId: string;
  asOf: Iso;
  immunosuppressionStateRef: ImmunosuppressionStateRef;
  liveAttenuated: LiveAttenuatedVaccinationGroup;
  inactivated: InactivatedVaccinationItem[];
  spacingRules: VaccinationSpacingRule[];
  householdMembers: HouseholdVaccinationMember[];
  records: VaccinationRecordView[];
  annualInfluenza: AnnualInfluenzaStatusView;
  /** 状态未知时用于显式告知，而不是渲染空白分类。 */
  message?: string;
}

export type VaccinationDoctorSchedule = Omit<VaccinationSchedule, 'records' | 'annualInfluenza'> & { records: VaccinationDoctorRecordView[]; annualInfluenza: VaccinationDoctorAnnualInfluenzaView };

export interface VaccinationMedicationInput {
  source?: MedicationPlan['source'];
  kind: 'STEROID' | 'BIOLOGIC' | 'SUPPORTIVE';
  drug: string;
  status: MedicationPlanStatus;
  startedAt: Iso;
  /** 旧数据或测试可不提供；不影响分类规则。 */
  biologicalAgent?: string;
}

export const DEFAULT_LIVE_ATTENUATED_VACCINES = ['麻腮风', '水痘', '卡介苗', '口服脊灰'] as const;
export const DEFAULT_INACTIVATED_VACCINES = ['流感', '肺炎链球菌', '乙肝', '甲肝', '百白破'] as const;
export const ADULT_INACTIVATED_VACCINES = ['带状疱疹', 'HPV'] as const;

export const VACCINATION_KNOWLEDGE_SOURCES = {
  liveAttenuated: 'https://www.cdc.gov/vaccines/hcp/acip-recs/general-recs/immunocompetence.html',
  inactivated: 'https://www.cdc.gov/vaccines/hcp/acip-recs/general-recs/contraindications.html',
  spacing: 'knowledge://mas-sjia/vaccination/biologic-spacing/v1',
  annualInfluenza: 'knowledge://mas-sjia/vaccination/annual-influenza/v1',
} as const;

export interface BuildVaccinationScheduleInput {
  patientId: string;
  asOf: Iso;
  medicationPlans: readonly VaccinationMedicationInput[];
  records: readonly VaccinationRecord[];
  householdMembers: readonly HouseholdVaccinationMember[];
  adult?: boolean;
  /** 只有经过审核的知识配置才能提供数值；默认保持 null。 */
  spacingIntervalDays?: number | null;
}

export function buildVaccinationSchedule(input: BuildVaccinationScheduleInput): VaccinationSchedule {
  assertIso(input.asOf, '快照时间');
  if (!input.patientId.trim()) throw new RangeError('患者标识不能为空');
  const asOfStamp = parseCareInstant(input.asOf);
  const plans = input.medicationPlans.filter(plan => isClinicianMedicationPlan(plan) && plan.status !== 'STOPPED' && parseCareInstant(plan.startedAt) <= asOfStamp);
  const immunosuppressive = plans.filter(plan => plan.kind === 'STEROID' || plan.kind === 'BIOLOGIC');
  if (input.records.some(record => record.patientId !== input.patientId)) throw new RangeError('接种记录患者不匹配');
  const records = input.records.map(toRecordView).filter(record => parseCareInstant(record.administeredAt) <= asOfStamp && parseCareInstant(record.recordedAt) <= asOfStamp).sort((a, b) => parseCareInstant(b.administeredAt) - parseCareInstant(a.administeredAt) || b.id.localeCompare(a.id));
  const householdMembers = input.householdMembers.map(cloneHouseholdMember);
  const annualInfluenza = buildAnnualInfluenzaStatus(input.asOf, records, immunosuppressive.length > 0, input.patientId);
  if (!immunosuppressive.length) {
    return {
      patientId: input.patientId,
      asOf: input.asOf,
      immunosuppressionStateRef: { status: 'UNKNOWN', source: 'SERVER_MEDICATIONS' },
      liveAttenuated: { classification: 'UNKNOWN', blocked: false, vaccines: [], sourceRef: VACCINATION_KNOWLEDGE_SOURCES.liveAttenuated },
      inactivated: [], spacingRules: [], householdMembers, records, annualInfluenza,
      message: '需要先确认当前用药，暂不显示疫苗分类。',
    };
  }
  const regimen = immunosuppressive.map(plan => plan.drug.trim()).filter(Boolean).join(' + ');
  const effectiveFrom = immunosuppressive.map(plan => plan.startedAt).sort((a, b) => parseCareInstant(a) - parseCareInstant(b))[0];
  const inactivatedNames = [...DEFAULT_INACTIVATED_VACCINES, ...(input.adult ? ADULT_INACTIVATED_VACCINES : [])];
  const inactivated = inactivatedNames.map(vaccine => {
    return {
      vaccine,
      classification: 'INACTIVATED' as const,
      sourceRef: VACCINATION_KNOWLEDGE_SOURCES.inactivated,
    };
  });
  const biologicalAgents = immunosuppressive.filter(plan => plan.kind === 'BIOLOGIC');
  const spacingRules = biologicalAgents.map(plan => ({
    vaccine: '灭活疫苗',
    biologicalAgent: (plan.biologicalAgent ?? plan.drug).trim(),
    minIntervalDays: input.spacingIntervalDays ?? null,
    sourceRef: VACCINATION_KNOWLEDGE_SOURCES.spacing,
  }));
  return {
    patientId: input.patientId,
    asOf: input.asOf,
    immunosuppressionStateRef: { status: 'KNOWN', regimen, effectiveFrom, source: 'SERVER_MEDICATIONS' },
    liveAttenuated: {
      classification: 'BLOCKED', blocked: true, vaccines: [...DEFAULT_LIVE_ATTENUATED_VACCINES],
      reasonRef: 'IMMUNOSUPPRESSION_LIVE_ATTENUATED_RISK', sourceRef: VACCINATION_KNOWLEDGE_SOURCES.liveAttenuated,
    },
    inactivated, spacingRules, householdMembers, records, annualInfluenza,
  };
}

/**
 * 构造年度流感的事实状态，不表达「应该接种」或个体适合性判断。
 *
 * 窗口使用上海本地日历：每年 9 月 1 日至 10 月 31 日，8 月 1 日起
 * 进入一个月前提示期。按本地年份匹配记录，而不是用固定 365 天，避免
 * 闰年和跨时区边界改变结果。
 */
export function buildAnnualInfluenzaStatus(
  asOf: Iso,
  records: readonly VaccinationRecordView[],
  immunosuppressionKnown: boolean,
  patientId?: string,
): AnnualInfluenzaStatusView {
  const asOfDate = shanghaiCalendarDate(asOf);
  const asOfStamp = parseCareInstant(asOf);
  const year = asOfDate.year;
  const window: AnnualInfluenzaWindow = {
    from: `${year}-09-01`,
    to: `${year}-10-31`,
    reminderFrom: `${year}-08-01`,
  };
  const eligible = records
    .filter(record => (!patientId || record.patientId === patientId) && parseCareInstant(record.administeredAt) <= asOfStamp && parseCareInstant(record.recordedAt) <= asOfStamp && isInfluenzaVaccineName(record.vaccine))
    .sort((left, right) => parseCareInstant(right.administeredAt) - parseCareInstant(left.administeredAt) || right.id.localeCompare(left.id));
  const lastRecord = eligible[0];
  const currentYearRecord = eligible.find(record => shanghaiCalendarDate(record.administeredAt).year === year);
  let status: AnnualInfluenzaStatus;
  if (!immunosuppressionKnown) status = 'UNKNOWN';
  else if (currentYearRecord) status = 'CURRENT_YEAR_RECORDED';
  else if (asOfDate.month === 8) status = 'WINDOW_APPROACHING';
  else if (asOfDate.month === 9 || asOfDate.month === 10) status = 'WINDOW_OPEN';
  else if (asOfDate.month >= 11) status = 'WINDOW_PASSED';
  else status = 'NEXT_WINDOW';
  return {
    vaccine: 'INFLUENZA', localYear: year, status, window,
    sourceRef: VACCINATION_KNOWLEDGE_SOURCES.annualInfluenza,
    ...(lastRecord ? { lastRecord: { id: lastRecord.id, patientId: lastRecord.patientId, administeredAt: lastRecord.administeredAt, facility: lastRecord.facility, source: lastRecord.source, recordedAt: lastRecord.recordedAt } } : {}),
  };
}

/** 允许知识库与医院录入的常见流感名称，但不把任意含「流感」文本当成接种事实。 */
export function isInfluenzaVaccineName(value: string): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.normalize('NFKC').trim().toLocaleLowerCase().replace(/[\s\u3000·•・._()（）\[\]【】-]/g, '').replace(/vaccine$/, '').replace(/疫苗$/, '');
  return normalized === '流感' || normalized === 'influenza' || normalized === 'flu' || /^(三价|四价|高剂量|鼻喷)?流感$/.test(normalized);
}

export function isVaccinationSchedule(value: unknown): value is VaccinationSchedule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !['patientId', 'asOf', 'immunosuppressionStateRef', 'liveAttenuated', 'inactivated', 'spacingRules', 'householdMembers', 'records', 'annualInfluenza', 'message'].includes(key))) return false;
  if (typeof item.patientId !== 'string' || !item.patientId.trim() || !isIso(item.asOf)) return false;
  if (!isImmunosuppression(item.immunosuppressionStateRef) || !isLiveGroup(item.liveAttenuated) || !Array.isArray(item.inactivated) || !item.inactivated.every(isInactivated) || !Array.isArray(item.spacingRules) || !item.spacingRules.every(isSpacing) || !Array.isArray(item.householdMembers) || !item.householdMembers.every(isHousehold) || !Array.isArray(item.records) || !item.records.every(isRecordView) || !isAnnualInfluenza(item.annualInfluenza)) return false;
  if (item.message !== undefined && typeof item.message !== 'string') return false;
  const patientId = item.patientId;
  const asOf = item.asOf as Iso;
  const asOfStamp = parseCareInstant(asOf);
  const annual = item.annualInfluenza as AnnualInfluenzaStatusView;
  if ((item.records as VaccinationRecordView[]).some(record => record.patientId !== patientId)) return false;
  if (annual.localYear !== shanghaiCalendarDate(asOf).year) return false;
  if (annual.lastRecord) {
    if (annual.lastRecord.patientId !== patientId || parseCareInstant(annual.lastRecord.administeredAt) > asOfStamp || parseCareInstant(annual.lastRecord.recordedAt) > asOfStamp) return false;
  }
  if (annual.status === 'CURRENT_YEAR_RECORDED' && (!annual.lastRecord || shanghaiCalendarDate(annual.lastRecord.administeredAt).year !== annual.localYear)) return false;
  if ((item.immunosuppressionStateRef as ImmunosuppressionStateRef).status === 'UNKNOWN') {
    if ((item.liveAttenuated as LiveAttenuatedVaccinationGroup).classification !== 'UNKNOWN' || (item.liveAttenuated as LiveAttenuatedVaccinationGroup).blocked || (item.inactivated as unknown[]).length || (item.spacingRules as unknown[]).length) return false;
    if ((item.annualInfluenza as AnnualInfluenzaStatusView).status !== 'UNKNOWN') return false;
  }
  return true;
}

function toRecordView(record: VaccinationRecord): VaccinationRecordView {
  assertIso(record.administeredAt, '接种日期'); assertIso(record.recordedAt, '记录时间');
  if (!record.id.trim() || !record.patientId.trim() || !record.vaccine.trim() || !record.facility.trim() || !record.recordedBy.trim() || !['PATIENT', 'CAREGIVER', 'CLINICIAN'].includes(record.source)) throw new RangeError('接种记录字段无效');
  return { id: record.id, patientId: record.patientId, vaccine: record.vaccine.trim(), administeredAt: record.administeredAt, facility: record.facility.trim(), source: record.source, recordedAt: record.recordedAt };
}
function cloneHouseholdMember(member: HouseholdVaccinationMember): HouseholdVaccinationMember {
  if (!member || Object.keys(member).some(key => !['relation', 'vaccines'].includes(key)) || !member.relation.trim() || !Array.isArray(member.vaccines)) throw new RangeError('家庭成员清单字段无效');
  return { relation: member.relation.trim(), vaccines: member.vaccines.map(vaccine => { if (!vaccine || Object.keys(vaccine).some(key => !['name', 'done', 'doneAt'].includes(key)) || !vaccine.name.trim() || typeof vaccine.done !== 'boolean' || vaccine.doneAt !== undefined && !vaccine.done) throw new RangeError('家庭成员疫苗字段无效'); if (vaccine.doneAt) assertIso(vaccine.doneAt, '家庭成员接种日期'); return { ...vaccine, name: vaccine.name.trim() }; }) };
}
function isImmunosuppression(value: unknown): value is ImmunosuppressionStateRef { const item = value as Record<string, unknown>; return Boolean(item && (item.status === 'KNOWN' || item.status === 'UNKNOWN') && item.source === 'SERVER_MEDICATIONS' && (item.regimen === undefined || typeof item.regimen === 'string') && (item.effectiveFrom === undefined || isIso(item.effectiveFrom))); }
function isLiveGroup(value: unknown): value is LiveAttenuatedVaccinationGroup { const item = value as Record<string, unknown>; return Boolean(item && (item.classification === 'BLOCKED' || item.classification === 'UNKNOWN') && typeof item.blocked === 'boolean' && Array.isArray(item.vaccines) && item.vaccines.every(entry => typeof entry === 'string') && typeof item.sourceRef === 'string' && item.sourceRef.length > 0 && (item.reasonRef === undefined || typeof item.reasonRef === 'string')); }
function isInactivated(value: unknown): value is InactivatedVaccinationItem { const item = value as Record<string, unknown>; return Boolean(item && typeof item.vaccine === 'string' && item.vaccine.trim() && item.classification === 'INACTIVATED' && typeof item.sourceRef === 'string' && item.sourceRef.length > 0 && Object.keys(item).every(key => ['vaccine', 'classification', 'sourceRef'].includes(key))); }
function isSpacing(value: unknown): value is VaccinationSpacingRule { const item = value as Record<string, unknown>; const interval = item?.minIntervalDays; return Boolean(item && typeof item.vaccine === 'string' && typeof item.biologicalAgent === 'string' && (interval === null || (typeof interval === 'number' && Number.isSafeInteger(interval) && interval >= 0)) && typeof item.sourceRef === 'string' && item.sourceRef.length > 0); }
function isHousehold(value: unknown): value is HouseholdVaccinationMember { const item = value as Record<string, unknown>; return Boolean(item && typeof item.relation === 'string' && Array.isArray(item.vaccines) && Object.keys(item).every(key => ['relation', 'vaccines'].includes(key)) && item.vaccines.every(entry => { const vaccine = entry as Record<string, unknown>; return Boolean(vaccine && typeof vaccine.name === 'string' && typeof vaccine.done === 'boolean' && (vaccine.doneAt === undefined || (vaccine.done === true && isIso(vaccine.doneAt))) && Object.keys(vaccine).every(key => ['name', 'done', 'doneAt'].includes(key))); })); }
function isRecordView(value: unknown): value is VaccinationRecordView { const item = value as Record<string, unknown>; return Boolean(item && typeof item.id === 'string' && typeof item.patientId === 'string' && typeof item.vaccine === 'string' && isIso(item.administeredAt) && typeof item.facility === 'string' && ['PATIENT', 'CAREGIVER', 'CLINICIAN'].includes(String(item.source)) && isIso(item.recordedAt) && Object.keys(item).every(key => ['id', 'patientId', 'vaccine', 'administeredAt', 'facility', 'source', 'recordedAt'].includes(key))); }
function isAnnualInfluenza(value: unknown): value is AnnualInfluenzaStatusView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !['vaccine', 'localYear', 'status', 'window', 'sourceRef', 'lastRecord'].includes(key))) return false;
  if (item.vaccine !== 'INFLUENZA' || typeof item.localYear !== 'number' || !Number.isSafeInteger(item.localYear) || item.localYear < 1900 || item.localYear > 9999 || !['CURRENT_YEAR_RECORDED', 'WINDOW_APPROACHING', 'WINDOW_OPEN', 'WINDOW_PASSED', 'NEXT_WINDOW', 'UNKNOWN'].includes(String(item.status)) || typeof item.sourceRef !== 'string' || !item.sourceRef.trim()) return false;
  const window = item.window as Record<string, unknown>;
  if (!window || typeof window !== 'object' || Array.isArray(window) || Object.keys(window).some(key => !['from', 'to', 'reminderFrom'].includes(key)) || !isCalendarDate(window.from) || !isCalendarDate(window.to) || !isCalendarDate(window.reminderFrom)) return false;
  if (window.from !== `${item.localYear}-09-01` || window.to !== `${item.localYear}-10-31` || window.reminderFrom !== `${item.localYear}-08-01`) return false;
  if (item.lastRecord === undefined) return true;
  const record = item.lastRecord as Record<string, unknown>;
  return Boolean(record && typeof record === 'object' && !Array.isArray(record) && Object.keys(record).every(key => ['id', 'patientId', 'administeredAt', 'facility', 'source', 'recordedAt'].includes(key)) && typeof record.id === 'string' && typeof record.patientId === 'string' && isIso(record.administeredAt) && typeof record.facility === 'string' && ['PATIENT', 'CAREGIVER', 'CLINICIAN'].includes(String(record.source)) && isIso(record.recordedAt));
}
function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return year >= 1900 && year <= 9999 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}
function shanghaiCalendarDate(value: string): { year: number; month: number; day: number } {
  const at = parseCareInstant(value);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date(at));
  const part = (type: 'year' | 'month' | 'day'): number => Number(parts.find(entry => entry.type === type)?.value);
  return { year: part('year'), month: part('month'), day: part('day') };
}
function assertIso(value: string, label: string): void { if (!isIso(value)) throw new RangeError(`${label}必须是有效时间`); }
function isIso(value: unknown): value is Iso {
  if (typeof value !== 'string') return false;
  try { parseCareInstant(value); return true; } catch { return false; }
}
