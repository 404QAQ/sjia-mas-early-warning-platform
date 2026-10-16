import type { Iso } from './types.js';

/** E-01 夜间收治能力必须显式表达，UNKNOWN 不是省略。 */
export type EmergencyNightCapability = 'TRUE' | 'FALSE' | 'UNKNOWN';
export type EmergencyPlanStatus = 'DRAFT' | 'PENDING_CLINICIAN' | 'CONFIRMED';
export type EmergencyPlanReviewStatus = 'NOT_REVIEWED' | 'CURRENT' | 'DUE';
export type EmergencyPlanTransport = 'DRIVE' | 'TAXI' | 'AMBULANCE' | 'OTHER';

export interface EmergencyHospital {
  name: string;
  address?: string;
  nightEntrance?: string;
  nightCapable: EmergencyNightCapability;
}

export interface EmergencyRoute {
  minutesNight: number;
  minutesDay: number;
  notes?: string;
}

export interface EmergencyTransport {
  primary: EmergencyPlanTransport;
  backup: string;
  driverName: string;
  driverPhone?: string;
}

export interface EmergencyCaregiverFields {
  primaryHospital?: EmergencyHospital;
  backupHospital?: EmergencyHospital;
  route?: EmergencyRoute;
  transport?: EmergencyTransport;
  customThresholds: string[];
}

/** 仅医生可写入的字段。医院能力和分诊话术与患者路线字段分开留存。 */
export interface EmergencyClinicianFields {
  nightCapable?: EmergencyNightCapability;
  triageScript?: string;
  /** 卡片上用于联系随诊医师的工作电话（由医生确认时核对）。 */
  followUpClinicianPhone?: string;
  /** 卡片上用于夜间升级的值班医师或医院总机转接信息。 */
  onCallContact?: EmergencyOnCallContact;
  confirmedBy?: string;
  confirmedAt?: Iso;
  backupHospital?: EmergencyHospital;
}

export interface EmergencyOnCallContact {
  label: string;
  phone: string;
}

export interface EmergencyDecisionThreshold {
  code: 'SEIZURE' | 'HIGH_FEVER_DULL' | 'BLEEDING' | 'SEVERE_HEADACHE';
  label: string;
  alwaysRequired: true;
}

export type EmergencyPlanEventType = 'DRAFT_SAVED' | 'SUBMITTED' | 'CONFIRMED' | 'REPLANNED';
export interface EmergencyPlanEvent {
  id: string;
  type: EmergencyPlanEventType;
  at: Iso;
  actorId: string;
  version: number;
  changedFields: string[];
  locationKey?: string;
}

export interface EmergencyPlan {
  id: string;
  patientId: string;
  status: EmergencyPlanStatus;
  step: 1 | 2 | 3 | 4;
  locationKey?: string;
  caregiver: EmergencyCaregiverFields;
  clinician: EmergencyClinicianFields;
  decisionThresholds: EmergencyDecisionThreshold[];
  lastReviewedAt?: Iso;
  nextReviewAt?: Iso;
  version: number;
  createdAt: Iso;
  updatedAt: Iso;
  history: EmergencyPlanEvent[];
}

export const EMERGENCY_PLAN_FIXED_THRESHOLDS: readonly EmergencyDecisionThreshold[] = [
  { code: 'SEIZURE', label: '抽搐 / 意识不清 / 叫不醒', alwaysRequired: true },
  { code: 'HIGH_FEVER_DULL', label: '持续高热 + 精神明显变差', alwaysRequired: true },
  { code: 'BLEEDING', label: '出血表现（牙龈 / 鼻血不止 / 瘀点）', alwaysRequired: true },
  { code: 'SEVERE_HEADACHE', label: '剧烈头痛 / 呕吐不止', alwaysRequired: true },
];

export interface EmergencyPlanDraftInput {
  step: 1 | 2 | 3 | 4;
  locationKey?: string;
  caregiver?: Partial<EmergencyCaregiverFields>;
}

export function createEmergencyPlan(patientId: string, id: string, at: Iso): EmergencyPlan {
  text(patientId, '患者标识'); uuidLike(id, '预案标识'); instant(at);
  return { id, patientId, status: 'DRAFT', step: 1, caregiver: { customThresholds: [] }, clinician: {}, decisionThresholds: fixedThresholds(), version: 0, createdAt: at, updatedAt: at, history: [] };
}

export function saveEmergencyPlanDraft(plan: EmergencyPlan, input: EmergencyPlanDraftInput, actorId: string, at: Iso): EmergencyPlan {
  validatePlan(plan); text(actorId, '操作者'); instant(at); validateStep(input.step);
  if (plan.status === 'PENDING_CLINICIAN') throw new RangeError('待医生确认的预案不能直接保存草稿，请刷新后重审');
  if (input.locationKey !== undefined) text(input.locationKey, '居住地标识', 200);
  if (input.caregiver !== undefined) validateCaregiverPatch(input.caregiver);
  const caregiver = input.caregiver ? mergeCaregiver(plan.caregiver, input.caregiver) : structuredClone(plan.caregiver);
  const caregiverChanged = input.caregiver !== undefined && !sameValue(caregiver, plan.caregiver);
  const locationChanged = input.locationKey !== undefined && input.locationKey !== plan.locationKey;
  const stepChanged = input.step !== plan.step;
  const changedAfterConfirmation = plan.status === 'CONFIRMED' && (caregiverChanged || locationChanged || stepChanged);
  if (plan.status === 'CONFIRMED' && !changedAfterConfirmation) throw new RangeError('已确认预案没有可保存的修改，请进入复核流程');
  const invalidatesClinician = changedAfterConfirmation;
  const changedFields = [ ...(input.step === undefined ? [] : ['step']), ...(input.locationKey === undefined ? [] : ['locationKey']), ...Object.keys(input.caregiver ?? {}).map(key => `caregiver.${key}`) ];
  if (plan.status !== 'DRAFT') changedFields.push('status');
  if (invalidatesClinician) changedFields.push('clinician', 'lastReviewedAt', 'nextReviewAt');
  return append(plan, {
    ...plan,
    status: 'DRAFT', step: input.step, caregiver,
    ...(input.locationKey === undefined ? {} : { locationKey: input.locationKey }),
    clinician: invalidatesClinician ? {} : structuredClone(plan.clinician),
    ...(invalidatesClinician ? { lastReviewedAt: undefined, nextReviewAt: undefined } : {}),
    updatedAt: at,
  }, { type: 'DRAFT_SAVED', actorId, at, changedFields });
}

export function submitEmergencyPlan(plan: EmergencyPlan, at: Iso, actorId = 'system'): EmergencyPlan {
  validatePlan(plan); instant(at); text(actorId, '操作者');
  if (plan.status !== 'DRAFT') throw new RangeError('只有草稿可以提交确认');
  if (!plan.caregiver.primaryHospital || !plan.caregiver.primaryHospital.nightCapable) throw new RangeError('必须明确医院夜间收治能力');
  if (plan.step !== 4) throw new RangeError('应急预案步骤不完整');
  if (!plan.caregiver.route || !plan.caregiver.transport) throw new RangeError('路线和交通方案未完成');
  return append(plan, { ...plan, status: 'PENDING_CLINICIAN', step: 4, updatedAt: at }, { type: 'SUBMITTED', actorId, at, changedFields: ['status'] });
}

export interface EmergencyClinicianConfirmation {
  nightCapable: EmergencyNightCapability;
  triageScript: string;
  followUpClinicianPhone: string;
  onCallContact: EmergencyOnCallContact;
  backupHospital?: EmergencyHospital;
}

export function confirmEmergencyPlan(plan: EmergencyPlan, clinicianId: string, input: EmergencyClinicianConfirmation, at: Iso): EmergencyPlan {
  validatePlan(plan); text(clinicianId, '医生标识'); instant(at);
  if (plan.status !== 'PENDING_CLINICIAN') throw new RangeError('当前预案不在待医生确认状态');
  validateNightCapability(input.nightCapable);
  text(input.triageScript, '分诊话术', 500);
  text(input.followUpClinicianPhone, '随诊医师电话', 50);
  validateOnCallContact(input.onCallContact);
  if (input.backupHospital !== undefined) validateHospital(input.backupHospital);
  const nextReviewAt = addMonths(at, 6);
  const clinician: EmergencyClinicianFields = { nightCapable: input.nightCapable, triageScript: input.triageScript.trim(), followUpClinicianPhone: input.followUpClinicianPhone.trim(), onCallContact: structuredClone(input.onCallContact), ...(input.backupHospital === undefined ? {} : { backupHospital: structuredClone(input.backupHospital) }), confirmedBy: clinicianId, confirmedAt: at };
  return append(plan, { ...plan, status: 'CONFIRMED', clinician, lastReviewedAt: at, nextReviewAt, updatedAt: at }, { type: 'CONFIRMED', actorId: clinicianId, at, changedFields: ['status', 'clinician', 'lastReviewedAt', 'nextReviewAt'] });
}

/** 搬家/换城市会清空医院与医生字段，但历史事件保留用于审计和复核。 */
export function emergencyPlanAfterReplan(plan: EmergencyPlan, locationKey: string, actorId: string, at: Iso): EmergencyPlan {
  validatePlan(plan); text(locationKey, '居住地标识', 200); text(actorId, '操作者'); instant(at);
  if (plan.status !== 'CONFIRMED' || !plan.nextReviewAt || parseInstant(at) < parseInstant(plan.nextReviewAt)) throw new RangeError('只有已确认且到复核期的预案可以重新制定');
  return append(plan, { ...plan, status: 'DRAFT', step: 1, locationKey, caregiver: { customThresholds: [...plan.caregiver.customThresholds] }, clinician: {}, lastReviewedAt: undefined, nextReviewAt: undefined, updatedAt: at }, { type: 'REPLANNED', actorId, at, locationKey, changedFields: ['locationKey', 'caregiver.primaryHospital', 'caregiver.backupHospital', 'caregiver.route', 'caregiver.transport', 'clinician', 'lastReviewedAt', 'nextReviewAt'] });
}

export function evaluateEmergencyPlanReview(plan: EmergencyPlan, now: Iso): EmergencyPlanReviewStatus {
  validatePlan(plan); instant(now);
  if (plan.status !== 'CONFIRMED' || !plan.nextReviewAt) return 'NOT_REVIEWED';
  return parseInstant(now) >= parseInstant(plan.nextReviewAt) ? 'DUE' : 'CURRENT';
}

export function fixedThresholds(): EmergencyDecisionThreshold[] { return EMERGENCY_PLAN_FIXED_THRESHOLDS.map(item => ({ ...item })); }

function append(plan: EmergencyPlan, next: EmergencyPlan, event: Omit<EmergencyPlanEvent, 'id' | 'version'>): EmergencyPlan {
  if (plan.history.length >= 500) throw new RangeError('应急预案历史过长');
  const version = plan.version + 1;
  return { ...next, version, decisionThresholds: fixedThresholds(), history: [...(plan.history ?? []).map(item => ({ ...item, changedFields: [...item.changedFields] })), { ...event, id: `${plan.id}:${version}`, version, changedFields: [...event.changedFields] }] };
}

function mergeCaregiver(current: EmergencyCaregiverFields, patch: Partial<EmergencyCaregiverFields>): EmergencyCaregiverFields {
  const merged = { ...current, ...structuredClone(patch) };
  if (patch.customThresholds !== undefined) merged.customThresholds = [...patch.customThresholds];
  if (merged.primaryHospital) validateHospital(merged.primaryHospital);
  if (merged.backupHospital) validateHospital(merged.backupHospital);
  if (merged.route) validateRoute(merged.route);
  if (merged.transport) validateTransport(merged.transport);
  if (!Array.isArray(merged.customThresholds) || merged.customThresholds.length > 20) throw new RangeError('自定义出发阈值无效');
  merged.customThresholds.forEach(value => text(value, '自定义出发阈值', 200));
  return merged;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== typeof right) return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  const leftRecord = left as Record<string, unknown>, rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter(key => leftRecord[key] !== undefined).sort();
  const rightKeys = Object.keys(rightRecord).filter(key => rightRecord[key] !== undefined).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && sameValue(leftRecord[key], rightRecord[key]));
}

function validateCaregiverPatch(patch: Partial<EmergencyCaregiverFields>): void {
  const allowed = ['primaryHospital', 'backupHospital', 'route', 'transport', 'customThresholds'];
  if (!patch || typeof patch !== 'object' || Object.keys(patch).some(key => !allowed.includes(key))) throw new RangeError('患者填写字段无效');
}

function validatePlan(plan: EmergencyPlan): void {
  if (!plan || typeof plan !== 'object') throw new RangeError('应急预案无效');
  uuidLike(plan.id, '预案标识'); text(plan.patientId, '患者标识');
  if (!['DRAFT', 'PENDING_CLINICIAN', 'CONFIRMED'].includes(plan.status)) throw new RangeError('应急预案状态无效');
  validateStep(plan.step); if (!Number.isSafeInteger(plan.version) || plan.version < 0) throw new RangeError('应急预案版本无效');
  instant(plan.createdAt); instant(plan.updatedAt); if (plan.locationKey !== undefined) text(plan.locationKey, '居住地标识', 200);
  if (!Array.isArray(plan.history)) throw new RangeError('应急预案历史无效');
  if (plan.history.length > 500) throw new RangeError('应急预案历史过长');
  let previousEventVersion = 0;
  for (const [index, event] of plan.history.entries()) { if (!event || typeof event !== 'object' || !textSafe(event.id) || event.id !== `${plan.id}:${index + 1}` || !textSafe(event.actorId) || event.version !== index + 1 || event.version <= previousEventVersion || event.version > plan.version || !Array.isArray(event.changedFields) || event.changedFields.length > 100 || event.changedFields.some(value => !textSafe(value)) || !['DRAFT_SAVED', 'SUBMITTED', 'CONFIRMED', 'REPLANNED'].includes(event.type)) throw new RangeError('应急预案历史无效'); instant(event.at); if (event.locationKey !== undefined) text(event.locationKey, '历史居住地标识', 200); previousEventVersion = event.version; }
  if ((plan.history.length === 0 && plan.version !== 0) || (plan.history.length > 0 && previousEventVersion !== plan.version)) throw new RangeError('应急预案历史版本不连续');
  if (!Array.isArray(plan.decisionThresholds) || plan.decisionThresholds.length !== EMERGENCY_PLAN_FIXED_THRESHOLDS.length || plan.decisionThresholds.some((item, i) => item.code !== EMERGENCY_PLAN_FIXED_THRESHOLDS[i]?.code || item.label !== EMERGENCY_PLAN_FIXED_THRESHOLDS[i]?.label || item.alwaysRequired !== true)) throw new RangeError('四条固定出发阈值不可删除');
  if (!plan.caregiver || typeof plan.caregiver !== 'object' || Array.isArray(plan.caregiver)) throw new RangeError('患者填写字段无效');
  const caregiver = plan.caregiver;
  if (caregiver.primaryHospital) validateHospital(caregiver.primaryHospital); if (caregiver.backupHospital) validateHospital(caregiver.backupHospital); if (caregiver.route) validateRoute(caregiver.route); if (caregiver.transport) validateTransport(caregiver.transport); if (!Array.isArray(caregiver.customThresholds)) throw new RangeError('自定义出发阈值无效'); caregiver.customThresholds.forEach(value => text(value, '自定义出发阈值', 200));
  if (!plan.clinician || typeof plan.clinician !== 'object' || Array.isArray(plan.clinician)) throw new RangeError('医生确认字段无效');
  const clinician = plan.clinician;
  if (clinician.nightCapable !== undefined) validateNightCapability(clinician.nightCapable);
  if (clinician.triageScript !== undefined) text(clinician.triageScript, '分诊话术', 500);
  if (clinician.followUpClinicianPhone !== undefined) text(clinician.followUpClinicianPhone, '随诊医师电话', 50);
  if (clinician.onCallContact !== undefined) validateOnCallContact(clinician.onCallContact);
  if (clinician.confirmedBy !== undefined) text(clinician.confirmedBy, '医生标识', 200);
  if (clinician.confirmedAt !== undefined) instant(clinician.confirmedAt);
  if (clinician.backupHospital !== undefined) validateHospital(clinician.backupHospital);
  const hasReview = plan.lastReviewedAt !== undefined || plan.nextReviewAt !== undefined;
  if ((plan.status === 'DRAFT' || plan.status === 'PENDING_CLINICIAN') && (Object.keys(clinician).length > 0 || hasReview)) throw new RangeError('未确认预案不能保留医生确认或复核字段');
  if (plan.status === 'CONFIRMED') {
    if (clinician.nightCapable === undefined || clinician.triageScript === undefined || !clinician.triageScript.trim() || clinician.followUpClinicianPhone === undefined || clinician.onCallContact === undefined || clinician.confirmedBy === undefined || clinician.confirmedAt === undefined || plan.lastReviewedAt === undefined || plan.nextReviewAt === undefined) throw new RangeError('已确认预案必须保留完整医生确认和复核字段');
    if (parseInstant(plan.nextReviewAt) <= parseInstant(plan.lastReviewedAt)) throw new RangeError('复核日期必须晚于上次复核');
  }
}

function validateHospital(value: EmergencyHospital): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['name', 'address', 'nightEntrance', 'nightCapable'].includes(key))) throw new RangeError('医院信息无效');
  text(value.name, '医院名称', 200); if (value.address !== undefined) text(value.address, '医院地址', 500); if (value.nightEntrance !== undefined) text(value.nightEntrance, '夜间入口', 200); validateNightCapability(value.nightCapable);
}
function validateRoute(value: EmergencyRoute): void { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['minutesNight', 'minutesDay', 'notes'].includes(key)) || !Number.isSafeInteger(value.minutesNight) || value.minutesNight < 0 || value.minutesNight > 2_880 || !Number.isSafeInteger(value.minutesDay) || value.minutesDay < 0 || value.minutesDay > 2_880) throw new RangeError('路线时间无效'); if (value.notes !== undefined) text(value.notes, '路线备注', 1000); }
function validateTransport(value: EmergencyTransport): void { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['primary', 'backup', 'driverName', 'driverPhone'].includes(key)) || !['DRIVE', 'TAXI', 'AMBULANCE', 'OTHER'].includes(value.primary)) throw new RangeError('交通方案无效'); text(value.backup, '备用交通方式', 200); text(value.driverName, '驾驶人', 100); if (value.driverPhone !== undefined) text(value.driverPhone, '驾驶人电话', 50); }
function validateOnCallContact(value: EmergencyOnCallContact): void { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['label', 'phone'].includes(key))) throw new RangeError('值班联系方式无效'); text(value.label, '值班联系方式名称', 100); text(value.phone, '值班电话', 50); }
function validateNightCapability(value: unknown): asserts value is EmergencyNightCapability { if (value !== 'TRUE' && value !== 'FALSE' && value !== 'UNKNOWN') throw new RangeError('夜间收治能力必须为 TRUE、FALSE 或 UNKNOWN'); }
function validateStep(value: unknown): asserts value is 1 | 2 | 3 | 4 { if (value !== 1 && value !== 2 && value !== 3 && value !== 4) throw new RangeError('应急预案步骤必须为 1 至 4'); }
function text(value: unknown, label: string, max = 512): asserts value is string { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) throw new RangeError(`${label}无效`); }
function textSafe(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\r\n\0]/.test(value); }
function instant(value: unknown): asserts value is Iso { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new RangeError('时间无效'); }
function parseInstant(value: string): number { const stamp = Date.parse(value); if (!Number.isFinite(stamp)) throw new RangeError('时间无效'); return stamp; }
function addMonths(value: Iso, months: number): Iso {
  const source = new Date(parseInstant(value));
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' }).formatToParts(source);
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find(item => item.type === type)?.value);
  const year = part('year'), month = part('month') - 1, day = part('day');
  const target = new Date(Date.UTC(year, month + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, last), part('hour'), part('minute'), part('second'), source.getUTCMilliseconds()) - 8 * 60 * 60 * 1000).toISOString();
}
function uuidLike(value: unknown, label: string): asserts value is string { if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\r\n\0]/.test(value)) throw new RangeError(`${label}无效`); }
