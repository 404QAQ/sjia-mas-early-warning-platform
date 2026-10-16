import { patientId, request, session } from './api';

/**
 * 患者侧的应急支持只读投影。页面不会使用服务端返回的任意字段，所有
 * 投影在进入 UI 前都经过白名单和类型校验；没有会话或患者范围时直接失败。
 */
export interface SupportPlan {
  id: string;
  patientId: string;
  status: 'DRAFT' | 'PENDING_CLINICIAN' | 'CONFIRMED';
  step: 1 | 2 | 3 | 4;
  version: number;
  locationKey?: string;
  nextReviewAt?: string;
  thresholds: Array<{ code: string; label: string }>;
  hospital?: { name: string; address?: string; nightEntrance?: string; nightCapable: 'TRUE' | 'FALSE' | 'UNKNOWN' };
  route?: { minutesNight: number; minutesDay: number; notes?: string };
  backupHospital?: { name: string; address?: string; nightEntrance?: string; nightCapable: 'TRUE' | 'FALSE' | 'UNKNOWN' };
  transport?: { primary: string; backup: string; driverName: string; driverPhone?: string };
  triageScript?: string;
  clinicianNightCapable?: 'TRUE' | 'FALSE' | 'UNKNOWN';
  followUpClinicianPhone?: string;
  onCallContact?: { label: string; phone: string };
}

export interface SupportKitItem { id: string; type: 'DOC' | 'PHYSICAL' | 'DIGITAL'; label: string; prepared: boolean; needsReprint: boolean; }
export interface SupportKit {
  id: string;
  patientId: string;
  locationNote?: string;
  familyInformed: boolean;
  items: SupportKitItem[];
  status: 'NOT_VERIFIED' | 'CURRENT' | 'DUE';
  completedCount: number;
  totalCount: number;
  needsReprintCount: number;
  version: number;
  updatedAt: string;
}

export interface SupportCard {
  id: string;
  patientId: string;
  planVersion: number;
  kitVersion: number;
  medicationVersion: string;
  generatedAt: string;
  needsReprint: boolean;
  reprintReason?: string;
  thresholds: Array<{ code: string; label: string }>;
  destination: {
    hospitalName: string;
    address?: string;
    nightEntrance?: string;
    arrivalMinutesNight: number;
    routeNotes?: string;
    triageScript: string;
    followUpClinicianPhone: string;
    onCallContact: { label: string; phone: string };
    driverName?: string;
    driverPhone?: string;
  };
  kitLocation: string;
  items: SupportKitItem[];
  neverDo: string[];
  canDo: string[];
  version: number;
  updatedAt: string;
}

export interface CrisisContact {
  id: string;
  kind: 'HOTLINE' | 'ON_CALL_CLINICIAN' | 'AUTHORIZED_CONTACT';
  label: string;
  phone: string;
  availability: '24_HOURS' | 'ON_CALL' | 'AUTHORIZED_PERSON';
  verificationStatus: 'VERIFIED';
  verifiedAt: string;
  verifiedUntil?: string;
  requiresConsent: boolean;
  consentGranted: boolean;
}
export type CrisisPageDegraded = 'ON_CALL_UNAVAILABLE' | 'AUTHORIZED_CONTACT_UNAVAILABLE' | 'ON_CALL_AND_CONTACT_UNAVAILABLE';
export interface CrisisView { patientId: string; trigger: 'SELF' | 'SCREENING'; contacts: CrisisContact[]; followUpRequired: true; contentVersion: 'P-06-v1'; degraded?: CrisisPageDegraded; }
export type CrisisAction = 'CALLED_HOTLINE' | 'CALLED_CLINICIAN' | 'CALLED_CONTACT';
export interface CrisisActionReceipt { patientId: string; contactId: string; action: CrisisAction; recorded: true; }
export type SupportPlanAction = 'SAVE_DRAFT' | 'SUBMIT' | 'REPLAN';
export interface SupportPlanCommand { action: SupportPlanAction; idempotencyKey: string; expectedVersion: number; step?: 1 | 2 | 3 | 4; locationKey?: string; caregiver?: Record<string, unknown>; }
export type SupportKitAction = 'SAVE_DRAFT' | 'TOGGLE_ITEM' | 'VERIFY';
export interface SupportKitCommand { action: SupportKitAction; idempotencyKey: string; expectedVersion: number; locationNote?: string; familyInformed?: boolean; itemId?: string; prepared?: boolean; }
export type SupportCardAction = 'GENERATE';
export interface SupportCardCommand { action: SupportCardAction; idempotencyKey: string; expectedVersion: number; }
export type SupportShareRecipientHint = 'GRANDPARENT' | 'BABYSITTER' | 'FRIEND';
export interface SupportShare { code: string; visibility: 'G2_SUMMARY'; recipientsHint: SupportShareRecipientHint[]; createdAt: string; expiresAt: string; revokedAt?: string; path?: string; }

interface Obj { [key: string]: unknown }
const obj = (value: unknown): value is Obj => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown, max = 1000): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\0\r\n]/.test(value);
const optionalText = (value: unknown, max = 1000): value is string | undefined => value === undefined || (typeof value === 'string' && value.length <= max && !/[\0\r\n]/.test(value));
const instant = (value: unknown): value is string => text(value, 80) && Number.isFinite(Date.parse(value));
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const keys = (value: Obj, allowed: readonly string[]): boolean => Object.keys(value).every(key => allowed.includes(key));
const phone = (value: unknown): value is string => typeof value === 'string' && /^\+?[0-9][0-9 ()-]{4,30}$/.test(value) && !/[xX*#]|待定|占位/.test(value);
const reprintReasons = ['PLAN_UPDATED', 'KIT_UPDATED', 'MEDICATION_UPDATED', 'PLAN_AND_KIT_UPDATED', 'PLAN_AND_MEDICATION_UPDATED', 'KIT_AND_MEDICATION_UPDATED', 'ALL_SOURCES_UPDATED', 'MANUAL'] as const;

type SupportHospital = NonNullable<SupportPlan['hospital']>;
function hospital(value: unknown): SupportHospital | null {
  if (!obj(value) || !keys(value, ['name', 'address', 'nightEntrance', 'nightCapable']) || !text(value.name, 200) || !optionalText(value.address, 500) || !optionalText(value.nightEntrance, 200) || !['TRUE', 'FALSE', 'UNKNOWN'].includes(value.nightCapable as string)) return null;
  return { name: value.name, ...(value.address === undefined ? {} : { address: value.address }), ...(value.nightEntrance === undefined ? {} : { nightEntrance: value.nightEntrance }), nightCapable: value.nightCapable as 'TRUE' | 'FALSE' | 'UNKNOWN' };
}
function supportThresholds(value: unknown): Array<{ code: string; label: string }> | null {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(item => obj(item) && keys(item, ['code', 'label', 'alwaysRequired']) && text(item.code, 100) && text(item.label, 500) && item.alwaysRequired === true)) return null;
  return value.map(item => ({ code: item.code as string, label: item.label as string }));
}
function parsePlanEnvelope(value: unknown, expectedPatientId: string): SupportPlan | null {
  if (!obj(value) || !keys(value, ['plan'])) return null;
  if (value.plan === null) return null;
  const item = value.plan;
  if (!obj(item) || !keys(item, ['id', 'patientId', 'status', 'step', 'locationKey', 'caregiver', 'clinician', 'decisionThresholds', 'lastReviewedAt', 'nextReviewAt', 'reviewStatus', 'version', 'createdAt', 'updatedAt', 'history']) || !text(item.id, 200) || item.patientId !== expectedPatientId || !['DRAFT', 'PENDING_CLINICIAN', 'CONFIRMED'].includes(item.status as string) || !integer(item.step, 1, 4) || item.locationKey !== undefined && !text(item.locationKey, 200) || !integer(item.version) || !instant(item.createdAt) || !instant(item.updatedAt)) return null;
  const thresholds = supportThresholds(item.decisionThresholds);
  if (!thresholds || !obj(item.caregiver) || !keys(item.caregiver, ['primaryHospital', 'backupHospital', 'route', 'transport', 'customThresholds']) || !Array.isArray(item.caregiver.customThresholds) || !item.caregiver.customThresholds.every(item => text(item, 200)) || !obj(item.clinician) || !keys(item.clinician, ['nightCapable', 'triageScript', 'followUpClinicianPhone', 'onCallContact', 'confirmedBy', 'confirmedAt', 'backupHospital'])) return null;
  const primaryHospital = item.caregiver.primaryHospital === undefined ? undefined : hospital(item.caregiver.primaryHospital);
  if (primaryHospital === null) return null;
  const route = item.caregiver.route;
  const transport = item.caregiver.transport;
  if (route !== undefined && (!obj(route) || !keys(route, ['minutesNight', 'minutesDay', 'notes']) || !integer(route.minutesNight, 0, 2880) || !integer(route.minutesDay, 0, 2880) || !optionalText(route.notes, 1000))) return null;
  if (transport !== undefined && (!obj(transport) || !keys(transport, ['primary', 'backup', 'driverName', 'driverPhone']) || !['DRIVE', 'TAXI', 'AMBULANCE', 'OTHER'].includes(transport.primary as string) || !text(transport.backup, 500) || !text(transport.driverName, 200) || !optionalText(transport.driverPhone, 80))) return null;
  const clinician = item.clinician;
  if (clinician.nightCapable !== undefined && !['TRUE', 'FALSE', 'UNKNOWN'].includes(clinician.nightCapable as string) || !optionalText(clinician.triageScript, 500) || !optionalText(clinician.followUpClinicianPhone, 80)) return null;
  if (clinician.onCallContact !== undefined && (!obj(clinician.onCallContact) || !keys(clinician.onCallContact, ['label', 'phone']) || !text(clinician.onCallContact.label, 100) || !text(clinician.onCallContact.phone, 80))) return null;
  const backupHospital = item.caregiver.backupHospital === undefined ? undefined : hospital(item.caregiver.backupHospital);
  if (backupHospital === null) return null;
  return { id: item.id, patientId: item.patientId, status: item.status as SupportPlan['status'], step: item.step as SupportPlan['step'], version: item.version, ...(item.locationKey === undefined ? {} : { locationKey: item.locationKey as string }), ...(item.nextReviewAt === undefined ? {} : { nextReviewAt: item.nextReviewAt as string }), thresholds,
    ...(primaryHospital === undefined ? {} : { hospital: primaryHospital }), ...(backupHospital === undefined ? {} : { backupHospital }), ...(route === undefined ? {} : { route: { minutesNight: route.minutesNight as number, minutesDay: route.minutesDay as number, ...(route.notes === undefined ? {} : { notes: route.notes as string }) } }), ...(transport === undefined ? {} : { transport: { primary: transport.primary as string, backup: transport.backup as string, driverName: transport.driverName as string, ...(transport.driverPhone === undefined ? {} : { driverPhone: transport.driverPhone as string }) } }),
    ...(clinician.nightCapable === undefined ? {} : { clinicianNightCapable: clinician.nightCapable as SupportPlan['clinicianNightCapable'] }), ...(clinician.triageScript === undefined ? {} : { triageScript: clinician.triageScript as string }), ...(clinician.followUpClinicianPhone === undefined ? {} : { followUpClinicianPhone: clinician.followUpClinicianPhone as string }), ...(clinician.onCallContact === undefined ? {} : { onCallContact: { label: (clinician.onCallContact as Obj).label as string, phone: (clinician.onCallContact as Obj).phone as string } }), };
}

function kitItem(value: unknown): SupportKitItem | null {
  if (!obj(value) || !keys(value, ['id', 'type', 'label', 'source', 'contentRef', 'prepared', 'preparedAt', 'needsReprint']) || !text(value.id, 200) || !['DOC', 'PHYSICAL', 'DIGITAL'].includes(value.type as string) || !text(value.label, 500) || !['CLINICIAN', 'SYSTEM', 'CAREGIVER'].includes(value.source as string) || typeof value.prepared !== 'boolean' || (value.preparedAt !== undefined && !instant(value.preparedAt)) || typeof value.needsReprint !== 'boolean') return null;
  return { id: value.id, type: value.type as SupportKitItem['type'], label: value.label, prepared: value.prepared, needsReprint: value.needsReprint };
}
function parseKitEnvelope(value: unknown, expectedPatientId: string): SupportKit | null {
  if (!obj(value) || !keys(value, ['kit']) || value.kit === null) return null;
  const item = value.kit;
  if (!obj(item) || !keys(item, ['patientId', 'id', 'locationNote', 'familyInformed', 'items', 'lastVerifiedAt', 'verifiedBy', 'version', 'createdAt', 'updatedAt', 'history', 'status', 'verificationStatus', 'completedCount', 'totalCount', 'needsReprintCount', 'verifiedAt']) || item.patientId !== expectedPatientId || !text(item.id, 200) || !optionalText(item.locationNote, 500) || typeof item.familyInformed !== 'boolean' || !Array.isArray(item.items) || item.items.length < 1 || item.items.length > 50 || !integer(item.version) || !instant(item.createdAt) || !instant(item.updatedAt) || !['NOT_VERIFIED', 'CURRENT', 'DUE'].includes(item.status as string) || item.verificationStatus !== item.status || !integer(item.completedCount) || !integer(item.totalCount, 1) || item.totalCount !== item.items.length || !integer(item.needsReprintCount) || item.needsReprintCount !== item.items.filter((entry: unknown) => obj(entry) && entry.needsReprint === true).length) return null;
  const items = item.items.map(kitItem); if (items.some(entry => entry === null) || new Set(items.map(entry => entry!.id)).size !== items.length || item.completedCount !== items.filter(entry => entry!.prepared).length) return null;
  return { id: item.id, patientId: item.patientId, ...(item.locationNote === undefined ? {} : { locationNote: item.locationNote }), familyInformed: item.familyInformed, items: items as SupportKitItem[], status: item.status as SupportKit['status'], completedCount: item.completedCount, totalCount: item.totalCount, needsReprintCount: item.needsReprintCount, version: item.version, updatedAt: item.updatedAt };
}

function parseCardEnvelope(value: unknown, expectedPatientId: string): SupportCard | null {
  if (!obj(value) || !keys(value, ['card', 'svg', 'pdf', 'created']) || value.card === null) return null;
  const item = value.card;
  if (!obj(item) || !keys(item, ['id', 'patientId', 'planId', 'planVersion', 'kitId', 'kitVersion', 'medicationVersion', 'planNextReviewAt', 'patientSnapshot', 'generatedAt', 'generatedBy', 'thresholds', 'destination', 'kitLocation', 'items', 'neverDo', 'canDo', 'printHints', 'needsReprint', 'reprintReason', 'version', 'createdAt', 'updatedAt', 'history', 'svg', 'pdf', 'verificationStatus', 'planChanged', 'kitChanged', 'medicationChanged']) || item.patientId !== expectedPatientId || !text(item.id, 200) || !integer(item.planVersion) || !integer(item.kitVersion) || !text(item.medicationVersion, 200) || !instant(item.generatedAt) || !instant(item.createdAt) || !instant(item.updatedAt) || !integer(item.version, 1) || typeof item.needsReprint !== 'boolean' || !['CURRENT', 'STALE'].includes(String(item.verificationStatus)) || item.reprintReason !== undefined && !reprintReasons.includes(item.reprintReason as typeof reprintReasons[number]) || !text(item.kitLocation, 500) || !Array.isArray(item.thresholds) || !Array.isArray(item.items) || !Array.isArray(item.neverDo) || item.neverDo.length !== 3 || !Array.isArray(item.canDo) || item.canDo.length !== 5 || !item.neverDo.every(entry => text(entry, 500)) || !item.canDo.every(entry => text(entry, 500)) || !Array.isArray(item.history) || item.history.length !== item.version || item.history.length > 500) return null;
  const thresholds = supportThresholds(item.thresholds); const destination = item.destination;
  if (!thresholds || !obj(destination) || !keys(destination, ['hospitalName', 'address', 'nightEntrance', 'arrivalMinutesNight', 'routeNotes', 'triageScript', 'followUpClinicianPhone', 'onCallContact', 'driverName', 'driverPhone']) || !text(destination.hospitalName, 200) || !optionalText(destination.address, 500) || !optionalText(destination.nightEntrance, 200) || !integer(destination.arrivalMinutesNight, 0, 2880) || !optionalText(destination.routeNotes, 1000) || !text(destination.triageScript, 500) || !text(destination.followUpClinicianPhone, 80) || !obj(destination.onCallContact) || !keys(destination.onCallContact, ['label', 'phone']) || !text(destination.onCallContact.label, 100) || !text(destination.onCallContact.phone, 80) || !optionalText(destination.driverName, 100) || !optionalText(destination.driverPhone, 80) || !obj(item.printHints) || !keys(item.printHints, ['size', 'orientation', 'monochrome', 'suggestedLocations']) || item.printHints.size !== 'A4' || item.printHints.orientation !== 'PORTRAIT' || item.printHints.monochrome !== true || !Array.isArray(item.printHints.suggestedLocations) || item.printHints.suggestedLocations.join(',') !== 'FRIDGE,DOOR_INSIDE,CAR') return null;
  const items = item.items.map(kitItem); if (items.some(entry => entry === null) || new Set(items.map(entry => entry!.id)).size !== items.length) return null;
  return { id: item.id, patientId: item.patientId, planVersion: item.planVersion, kitVersion: item.kitVersion, medicationVersion: item.medicationVersion, generatedAt: item.generatedAt, needsReprint: item.needsReprint, ...(item.reprintReason === undefined ? {} : { reprintReason: item.reprintReason as string }), thresholds, destination: { hospitalName: destination.hospitalName, ...(destination.address === undefined ? {} : { address: destination.address }), ...(destination.nightEntrance === undefined ? {} : { nightEntrance: destination.nightEntrance }), arrivalMinutesNight: destination.arrivalMinutesNight, ...(destination.routeNotes === undefined ? {} : { routeNotes: destination.routeNotes }), triageScript: destination.triageScript, followUpClinicianPhone: destination.followUpClinicianPhone, onCallContact: { label: destination.onCallContact.label, phone: destination.onCallContact.phone }, ...(destination.driverName === undefined ? {} : { driverName: destination.driverName }), ...(destination.driverPhone === undefined ? {} : { driverPhone: destination.driverPhone }) }, kitLocation: item.kitLocation, items: items as SupportKitItem[], neverDo: [...item.neverDo] as string[], canDo: [...item.canDo] as string[], version: item.version, updatedAt: item.updatedAt };
}
const VALID_DEGRADED_SET = new Set(['ON_CALL_UNAVAILABLE', 'AUTHORIZED_CONTACT_UNAVAILABLE', 'ON_CALL_AND_CONTACT_UNAVAILABLE']);
function parseCrisis(value: unknown, expectedPatientId: string): CrisisView | null {
  if (!obj(value) || !keys(value, ['patientId', 'trigger', 'contacts', 'followUpRequired', 'contentVersion', 'degraded']) || value.patientId !== expectedPatientId || !['SELF', 'SCREENING'].includes(value.trigger as string) || value.followUpRequired !== true || value.contentVersion !== 'P-06-v1') return null;
  if (value.degraded !== undefined && !VALID_DEGRADED_SET.has(value.degraded as string)) return null;
  if (!Array.isArray(value.contacts) || value.contacts.length < 1 || value.contacts.length > 3) return null;
  const contacts: CrisisContact[] = [];
  for (const entry of value.contacts) {
    if (!obj(entry) || !keys(entry, ['id', 'kind', 'label', 'phone', 'availability', 'verificationStatus', 'verifiedAt', 'verifiedUntil', 'requiresConsent', 'consentGranted']) || !text(entry.id, 100) || !text(entry.label, 200) || !phone(entry.phone) || !instant(entry.verifiedAt) || entry.verificationStatus !== 'VERIFIED' || typeof entry.requiresConsent !== 'boolean' || typeof entry.consentGranted !== 'boolean' || entry.verifiedUntil !== undefined && (!instant(entry.verifiedUntil) || Date.parse(entry.verifiedUntil) <= Date.parse(entry.verifiedAt) || Date.parse(entry.verifiedUntil) <= Date.now())) return null;
    if (entry.kind === 'HOTLINE' && (entry.availability !== '24_HOURS' || entry.requiresConsent || entry.consentGranted)) return null;
    if (entry.kind === 'ON_CALL_CLINICIAN' && (entry.availability !== 'ON_CALL' || entry.requiresConsent || entry.consentGranted)) return null;
    if (entry.kind === 'AUTHORIZED_CONTACT' && (entry.availability !== 'AUTHORIZED_PERSON' || !entry.requiresConsent || !entry.consentGranted)) return null;
    if (!['HOTLINE', 'ON_CALL_CLINICIAN', 'AUTHORIZED_CONTACT'].includes(entry.kind as string)) return null;
    contacts.push({ id: entry.id, kind: entry.kind as CrisisContact['kind'], label: entry.label, phone: entry.phone, availability: entry.availability as CrisisContact['availability'], verificationStatus: 'VERIFIED', verifiedAt: entry.verifiedAt, ...(entry.verifiedUntil === undefined ? {} : { verifiedUntil: entry.verifiedUntil }), requiresConsent: entry.requiresConsent, consentGranted: entry.consentGranted });
  }
  // 热线必须第一，不允许重复 kind，不允许热线以外的重复
  if (contacts[0]?.kind !== 'HOTLINE') return null;
  if (new Set(contacts.map(entry => entry.kind)).size !== contacts.length) return null;
  if (contacts.some((entry, i) => i > 0 && entry.kind === 'HOTLINE')) return null;
  const degraded = VALID_DEGRADED_SET.has(value.degraded as string) ? value.degraded as CrisisPageDegraded : undefined;
  return { patientId: value.patientId, trigger: value.trigger as CrisisView['trigger'], contacts, followUpRequired: true, contentVersion: 'P-06-v1', ...(degraded ? { degraded } : {}) };
}

function requirePatientScope(): { id: string; actorId: string } {
  const current = session();
  const id = patientId();
  if (!current || !id || !current.actorId) throw new Error('当前微信身份尚未绑定患者档案，请重新登录。');
  return { id, actorId: current.actorId };
}

/** 写入回执也必须走与 GET 相同的白名单解析；不可信或跨患者回执直接失败关闭。 */
export function parseSupportPlan(value: unknown, expectedPatientId: string): SupportPlan | null { return parsePlanEnvelope({ plan: value }, expectedPatientId); }
export function parseSupportKit(value: unknown, expectedPatientId: string): SupportKit | null { return parseKitEnvelope({ kit: value }, expectedPatientId); }
export function parseSupportCard(value: unknown, expectedPatientId: string): SupportCard | null { return parseCardEnvelope({ card: value, svg: undefined, pdf: undefined, created: false }, expectedPatientId); }

function parseShare(value: unknown): SupportShare | null {
  if (!obj(value) || !keys(value, ['code', 'visibility', 'recipientsHint', 'createdAt', 'expiresAt', 'revokedAt', 'path']) || typeof value.code !== 'string' || !/^[A-Za-z0-9_-]{7}$/.test(value.code) || value.visibility !== 'G2_SUMMARY' || !Array.isArray(value.recipientsHint) || value.recipientsHint.length < 1 || value.recipientsHint.length > 3 || new Set(value.recipientsHint).size !== value.recipientsHint.length || !value.recipientsHint.every(item => ['GRANDPARENT', 'BABYSITTER', 'FRIEND'].includes(String(item))) || !instant(value.createdAt) || !instant(value.expiresAt) || value.revokedAt !== undefined && !instant(value.revokedAt) || value.path !== undefined && (!text(value.path, 200) || !value.path.startsWith('/contact/?s='))) return null;
  return { code: value.code, visibility: 'G2_SUMMARY', recipientsHint: value.recipientsHint as SupportShareRecipientHint[], createdAt: value.createdAt, expiresAt: value.expiresAt, ...(value.revokedAt === undefined ? {} : { revokedAt: value.revokedAt }), ...(value.path === undefined ? {} : { path: value.path }) };
}

export async function loadSupportPlan(): Promise<SupportPlan | null> {
  const scope = requirePatientScope(); const value = await request<unknown>(`/api/v1/patients/${encodeURIComponent(scope.id)}/emergency-plan`);
  if (obj(value) && keys(value, ['plan']) && value.plan === null) return null;
  const plan = parsePlanEnvelope(value, scope.id);
  if (!plan) throw new Error('家庭应急预案资料格式无效，请重新读取。');
  return plan;
}
export async function loadSupportKit(): Promise<SupportKit | null> {
  const scope = requirePatientScope(); const value = await request<unknown>(`/api/v1/patients/${encodeURIComponent(scope.id)}/emergency-kit`);
  if (obj(value) && keys(value, ['kit']) && value.kit === null) return null;
  const kit = parseKitEnvelope(value, scope.id);
  if (!kit) throw new Error('急诊包资料格式无效，请重新读取。');
  return kit;
}
export async function loadSupportCard(): Promise<SupportCard | null> {
  const scope = requirePatientScope(); const value = await request<unknown>(`/api/v1/patients/${encodeURIComponent(scope.id)}/emergency-card`);
  if (obj(value) && keys(value, ['card']) && value.card === null) return null;
  const card = parseCardEnvelope(value, scope.id);
  if (!card) throw new Error('应急流程卡资料格式无效，请重新读取。');
  return card;
}
export async function mutateSupportPlan(command: SupportPlanCommand): Promise<{ plan: SupportPlan; created: boolean }> {
  const scope = requirePatientScope(); const value = await request<unknown>(`/api/v1/patients/${encodeURIComponent(scope.id)}/emergency-plan`, 'POST', command);
  if (!obj(value) || !keys(value, ['plan', 'created']) || typeof value.created !== 'boolean') throw new Error('家庭应急预案回执格式无效，这条已留在本机，可以直接重试。');
  const plan = parseSupportPlan(value.plan, scope.id); if (!plan) throw new Error('家庭应急预案回执格式无效，这条已留在本机，可以直接重试。');
  return { plan, created: value.created };
}
export async function mutateSupportKit(command: SupportKitCommand): Promise<{ kit: SupportKit; created: boolean }> {
  const scope = requirePatientScope(); const value = await request<unknown>(`/api/v1/patients/${encodeURIComponent(scope.id)}/emergency-kit`, 'POST', command);
  if (!obj(value) || !keys(value, ['kit', 'created']) || typeof value.created !== 'boolean') throw new Error('急诊包回执格式无效，这条已留在本机，可以直接重试。');
  const kit = parseSupportKit(value.kit, scope.id); if (!kit) throw new Error('急诊包回执格式无效，这条已留在本机，可以直接重试。');
  return { kit, created: value.created };
}
export async function mutateSupportCard(command: SupportCardCommand): Promise<{ card: SupportCard; created: boolean }> {
  const scope = requirePatientScope(); const value = await request<unknown>(`/api/v1/patients/${encodeURIComponent(scope.id)}/emergency-card`, 'POST', command);
  if (!obj(value) || !keys(value, ['card', 'created']) || typeof value.created !== 'boolean') throw new Error('应急流程卡回执格式无效，这条已留在本机，可以直接重试。');
  const card = parseSupportCard(value.card, scope.id); if (!card) throw new Error('应急流程卡回执格式无效，这条已留在本机，可以直接重试。');
  return { card, created: value.created };
}
export async function createSupportShare(recipientsHint: SupportShareRecipientHint[], idempotencyKey: string, expiresAt?: string): Promise<SupportShare> {
  const scope = requirePatientScope(); const value = await request<unknown>(`/api/v1/patients/${encodeURIComponent(scope.id)}/emergency-shares`, 'POST', { recipientsHint, ...(expiresAt === undefined ? {} : { expiresAt }), idempotencyKey });
  const share = parseShare(value); if (!share) throw new Error('应急分享回执格式无效，这条已留在本机，可以直接重试。');
  return share;
}
export async function listSupportShares(): Promise<SupportShare[]> {
  const scope = requirePatientScope(); const value = await request<unknown>(`/api/v1/patients/${encodeURIComponent(scope.id)}/emergency-shares`);
  if (!Array.isArray(value)) throw new Error('应急分享列表响应格式无效。');
  const shares = value.map(parseShare); if (shares.some(item => item === null)) throw new Error('应急分享列表响应格式无效。');
  return shares as SupportShare[];
}
export async function revokeSupportShare(code: string): Promise<void> {
  const scope = requirePatientScope(); if (!/^[A-Za-z0-9_-]{7}$/.test(code)) throw new Error('应急分享标识无效。');
  const value = await request<unknown>(`/api/v1/emergency-shares/${encodeURIComponent(code)}/revoke`, 'POST');
  if (!obj(value) || !keys(value, ['revoked']) || value.revoked !== true) throw new Error('撤回应急分享回执无效。');
  if (!scope.actorId) throw new Error('当前身份已失效。');
}
export async function loadCrisisContacts(trigger: CrisisView['trigger'] = 'SELF'): Promise<CrisisView> { const scope = requirePatientScope(); const query = trigger === 'SCREENING' ? '?trigger=SCREENING' : ''; const result = parseCrisis(await request<unknown>(`/api/v1/patients/${encodeURIComponent(scope.id)}/crisis-page${query}`), scope.id); if (!result || result.trigger !== trigger) throw new Error('危机联系方式尚未完成核验，系统不会显示未经确认的号码。'); return result; }
export async function recordCrisisAction(contactId: string, action: CrisisAction): Promise<CrisisActionReceipt> { const scope = requirePatientScope(); if (!text(contactId, 100)) throw new Error('危机联系人无效。'); const result = await request<unknown>(`/api/v1/patients/${encodeURIComponent(scope.id)}/crisis-page/actions`, 'POST', { contactId, action }); if (!obj(result) || !keys(result, ['patientId', 'contactId', 'action', 'recorded']) || result.patientId !== scope.id || result.contactId !== contactId || result.action !== action || result.recorded !== true) throw new Error('危机动作回执无效。'); return result as unknown as CrisisActionReceipt; }

export function makePhoneCall(phoneNumber: string): Promise<void> {
  if (!phone(phoneNumber)) return Promise.reject(new Error('服务端未返回经核验的电话号码。'));
  return new Promise((resolve, reject) => wx.makePhoneCall({ phoneNumber, success: resolve, fail: error => reject(new Error(error.errMsg ?? '拨号失败，请手动拨打。')) }));
}
