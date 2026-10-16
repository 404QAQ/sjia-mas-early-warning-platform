import type { EmergencyDecisionThreshold, EmergencyPlan, EmergencyOnCallContact } from './emergency-plan.js';
import type { EmergencyKit, EmergencyKitItem } from './emergency-kit.js';
import type { Iso, Patient } from './types.js';

/** E-03 的纸质卡只包含可执行动作；它不是完整病历或用药方案。 */
export type EmergencyCardReprintReason = 'PLAN_UPDATED' | 'KIT_UPDATED' | 'MEDICATION_UPDATED' | 'PLAN_AND_KIT_UPDATED' | 'PLAN_AND_MEDICATION_UPDATED' | 'KIT_AND_MEDICATION_UPDATED' | 'ALL_SOURCES_UPDATED' | 'MANUAL';

export interface EmergencyCardDestination {
  hospitalName: string;
  address?: string;
  nightEntrance?: string;
  arrivalMinutesNight: number;
  routeNotes?: string;
  triageScript: string;
  followUpClinicianPhone: string;
  onCallContact: EmergencyOnCallContact;
  driverName?: string;
  driverPhone?: string;
}

export interface EmergencyCardItem {
  id: string;
  type: EmergencyKitItem['type'];
  label: string;
  source: EmergencyKitItem['source'];
  prepared: boolean;
  needsReprint: boolean;
  contentRef?: string;
}

export interface EmergencyCardPrintHints {
  size: 'A4';
  orientation: 'PORTRAIT';
  monochrome: true;
  suggestedLocations: readonly ['FRIDGE', 'DOOR_INSIDE', 'CAR'];
}

export type EmergencyCardEventType = 'GENERATED' | 'REPRINT_MARKED';
export interface EmergencyCardEvent {
  id: string;
  type: EmergencyCardEventType;
  at: Iso;
  actorId: string;
  version: number;
  changedFields: string[];
  reprintReason?: EmergencyCardReprintReason;
}

export interface EmergencyCard {
  id: string;
  patientId: string;
  /** The exact E-01/E-02 versions represented by the printed snapshot. */
  planId: string;
  planVersion: number;
  kitId: string;
  kitVersion: number;
  medicationVersion: string;
  patientSnapshot?: Pick<Patient, 'displayName' | 'birthDate' | 'diseaseType'>;
  planNextReviewAt?: Iso;
  generatedAt: Iso;
  generatedBy: string;
  thresholds: EmergencyDecisionThreshold[];
  destination: EmergencyCardDestination;
  kitLocation: string;
  items: EmergencyCardItem[];
  neverDo: string[];
  canDo: string[];
  printHints: EmergencyCardPrintHints;
  needsReprint: boolean;
  reprintReason?: EmergencyCardReprintReason;
  version: number;
  createdAt: Iso;
  updatedAt: Iso;
  history: EmergencyCardEvent[];
}

export interface EmergencyCardEvaluation {
  needsReprint: boolean;
  reprintReason?: EmergencyCardReprintReason;
  planChanged: boolean;
  kitChanged: boolean;
  medicationChanged: boolean;
}

export const EMERGENCY_CARD_NEVER_DO: readonly string[] = [
  '不要自行加大激素剂量',
  '不要自行停激素',
  '不要自行用抗生素',
];

export const EMERGENCY_CARD_CAN_DO: readonly string[] = [
  '物理降温 / 按医嘱退烧',
  '少量多次补水',
  '记录体温与症状（到医院直接可用）',
  '皮疹 / 出血点拍照留证',
  '保持安静、减少刺激',
];

export const EMERGENCY_CARD_PRINT_HINTS: EmergencyCardPrintHints = {
  size: 'A4', orientation: 'PORTRAIT', monochrome: true,
  suggestedLocations: ['FRIDGE', 'DOOR_INSIDE', 'CAR'],
};

export function createEmergencyCard(plan: EmergencyPlan, kit: EmergencyKit, id: string, actorId: string, at: Iso, medicationVersion = 'UNAVAILABLE', patient?: Pick<Patient, 'displayName' | 'birthDate' | 'diseaseType'>): EmergencyCard {
  validateSource(plan, kit); text(id, '应急流程卡标识'); text(actorId, '生成者'); instant(at);
  const hospital = plan.caregiver.primaryHospital!;
  const route = plan.caregiver.route!;
  const destination: EmergencyCardDestination = {
    hospitalName: hospital.name,
    ...(hospital.address === undefined ? {} : { address: hospital.address }),
    ...(hospital.nightEntrance === undefined ? {} : { nightEntrance: hospital.nightEntrance }),
    arrivalMinutesNight: route.minutesNight,
    ...(route.notes === undefined ? {} : { routeNotes: route.notes }),
    triageScript: plan.clinician.triageScript!,
    followUpClinicianPhone: plan.clinician.followUpClinicianPhone!,
    onCallContact: structuredClone(plan.clinician.onCallContact!),
    driverName: plan.caregiver.transport?.driverName,
    ...(plan.caregiver.transport?.driverPhone === undefined ? {} : { driverPhone: plan.caregiver.transport.driverPhone }),
  };
  const card: EmergencyCard = {
    id, patientId: plan.patientId, planId: plan.id, planVersion: plan.version, kitId: kit.id, kitVersion: kit.version, medicationVersion, ...(patient === undefined ? {} : { patientSnapshot: structuredClone(patient) }),
    generatedAt: at, generatedBy: actorId, ...(plan.nextReviewAt === undefined ? {} : { planNextReviewAt: plan.nextReviewAt }), thresholds: plan.decisionThresholds.map(item => ({ ...item })), destination,
    kitLocation: kit.locationNote!.trim(), items: kit.items.map(toCardItem), neverDo: [...EMERGENCY_CARD_NEVER_DO], canDo: [...EMERGENCY_CARD_CAN_DO],
    printHints: clonePrintHints(), needsReprint: kit.items.some(item => item.needsReprint), ...(kit.items.some(item => item.needsReprint) ? { reprintReason: 'KIT_UPDATED' as const } : {}), version: 1, createdAt: at, updatedAt: at,
    history: [{ id: `${id}:1`, type: 'GENERATED', at, actorId, version: 1, changedFields: ['source', 'thresholds', 'destination', 'kitLocation', 'items', 'neverDo', 'canDo', 'printHints', 'needsReprint'] }],
  };
  validateEmergencyCard(card);
  return card;
}

/** Regenerate the same card resource while retaining its CAS/history identity. */
export function regenerateEmergencyCard(previous: EmergencyCard, plan: EmergencyPlan, kit: EmergencyKit, actorId: string, at: Iso, medicationVersion = 'UNAVAILABLE', patient?: Pick<Patient, 'displayName' | 'birthDate' | 'diseaseType'>): EmergencyCard {
  validateEmergencyCard(previous);
  const generated = createEmergencyCard(plan, kit, previous.id, actorId, at, medicationVersion, patient ?? previous.patientSnapshot);
  const version = previous.version + 1;
  const next: EmergencyCard = {
    ...generated, version, createdAt: previous.createdAt,
    history: [...previous.history.map(event => ({ ...event, changedFields: [...event.changedFields] })), { id: `${previous.id}:${version}`, type: 'GENERATED', at, actorId, version, changedFields: ['source', 'thresholds', 'destination', 'kitLocation', 'items', 'neverDo', 'canDo', 'printHints', 'needsReprint'] }],
  };
  validateEmergencyCard(next);
  return next;
}

/** Marking a stale paper copy is an auditable action; generation clears the mark by creating a new snapshot. */
export function markEmergencyCardReprint(card: EmergencyCard, reason: EmergencyCardReprintReason, actorId: string, at: Iso): EmergencyCard {
  validateEmergencyCard(card); text(actorId, '操作者'); instant(at); validateReprintReason(reason);
  if (card.history.length >= 500) throw new RangeError('应急流程卡历史过长');
  const version = card.version + 1;
  const next: EmergencyCard = {
    ...structuredClone(card), needsReprint: true, reprintReason: reason, updatedAt: at, version,
    history: [...card.history.map(event => ({ ...event, changedFields: [...event.changedFields] })), { id: `${card.id}:${version}`, type: 'REPRINT_MARKED', at, actorId, version, changedFields: ['needsReprint', 'reprintReason'], reprintReason: reason }],
  };
  validateEmergencyCard(next);
  return next;
}

/** Compare a stored paper snapshot with the latest authoritative E-01/E-02 versions. */
export function evaluateEmergencyCard(card: EmergencyCard, planVersion: number, kitVersion: number, medicationVersion = card.medicationVersion): EmergencyCardEvaluation {
  validateEmergencyCard(card); version(planVersion, '预案版本'); version(kitVersion, '急诊包版本'); text(medicationVersion, '用药版本', 200);
  const planChanged = card.planVersion !== planVersion;
  const kitChanged = card.kitVersion !== kitVersion;
  const medicationChanged = card.medicationVersion !== medicationVersion;
  const reason = planChanged && kitChanged && medicationChanged ? 'ALL_SOURCES_UPDATED' : planChanged && medicationChanged ? 'PLAN_AND_MEDICATION_UPDATED' : kitChanged && medicationChanged ? 'KIT_AND_MEDICATION_UPDATED' : planChanged && kitChanged ? 'PLAN_AND_KIT_UPDATED' : planChanged ? 'PLAN_UPDATED' : kitChanged ? 'KIT_UPDATED' : medicationChanged ? 'MEDICATION_UPDATED' : card.needsReprint ? card.reprintReason : undefined;
  return { needsReprint: planChanged || kitChanged || medicationChanged || card.needsReprint, ...(reason === undefined ? {} : { reprintReason: reason }), planChanged, kitChanged, medicationChanged };
}

/** Deterministic, dependency-free SVG intended for A4 printing or image saving. */
export function renderEmergencyCardSvg(card: EmergencyCard): string {
  validateEmergencyCard(card);
  const rows = emergencyCardTextRows(card);
  if (rows.length > 52) throw new RangeError('应急流程卡内容过长，无法在一页 A4 上安全打印');
  const lineHeight = Math.min(28, Math.max(20, Math.floor(950 / Math.max(rows.length, 1))));
  // ImageMagick's SVG text decoder can leave the final UTF-8 sequence in a
  // text node undecoded when it ends with certain CJK glyphs. A zero-width
  // sentinel flushes that sequence without changing the printed content.
  const textNodes = rows.map((row, index) => `<text x="72" y="${72 + index * lineHeight}" class="${row.startsWith('绝对不要做') || row.startsWith('✗') ? 'danger' : index === 0 ? 'title' : 'body'}">${escapeXml(row)}&#x200B;</text>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 794 1123" role="img" aria-label="紧急情况怎么办（简化版）"><title>紧急情况怎么办（简化版）</title><desc>请按卡片上的行动项处理并尽快前往急诊。本卡为简化版。</desc><style>.title{font-family:sans-serif;font-size:30px;font-weight:700}.body{font-family:sans-serif;font-size:20px;font-weight:400}.danger{font-family:sans-serif;font-size:20px;font-weight:400;fill:#a40000}</style><rect width="794" height="1123" fill="white"/>${textNodes}</svg>`;
}

/** Shared line model for SVG/PDF renderers; the renderer must not invent clinical content. */
export function emergencyCardTextRows(card: EmergencyCard): string[] {
  validateEmergencyCard(card);
  const rows: string[] = ['什么情况立刻去急诊', ...card.thresholds.map(threshold => `□ ${threshold.label}`), ''];
  rows.push(`去之前：带急诊包（${card.kitLocation}）`, `去：${card.destination.hospitalName}`);
  if (card.destination.nightEntrance) rows.push(`夜间入口：${card.destination.nightEntrance}`);
  rows.push(`到院约 ${card.destination.arrivalMinutesNight} 分钟`);
  if (card.destination.routeNotes) rows.push(...wrapLine(`路线：${card.destination.routeNotes}`));
  rows.push(...wrapLine(`分诊台说：「${card.destination.triageScript}」`));
  rows.push(`随诊医师电话：${card.destination.followUpClinicianPhone}`);
  rows.push(`${card.destination.onCallContact.label}：${card.destination.onCallContact.phone}`);
  if (card.destination.driverName) rows.push(`车上先联系：${card.destination.driverName}${card.destination.driverPhone ? ` ${card.destination.driverPhone}` : ''}`);
  rows.push('', '带什么');
  const grouped = card.items.reduce<Record<EmergencyCardItem['type'], EmergencyCardItem[]>>((acc, item) => { (acc[item.type] ??= []).push(item); return acc; }, { DOC: [], PHYSICAL: [], DIGITAL: [] });
  rows.push(...(['DOC', 'PHYSICAL', 'DIGITAL'] as const).flatMap(type => [`${type === 'DOC' ? '纸质材料' : type === 'PHYSICAL' ? '实物' : '电子备份'}`, ...grouped[type].flatMap(item => wrapLine(`□ ${item.label}（${sourceLabel(item.source)}）`))]));
  rows.push('', '绝对不要做', ...card.neverDo.flatMap(item => wrapLine(`✗ ${item}`)), '', '可以做', ...card.canDo.flatMap(item => wrapLine(`· ${item}`)), '');
  if (card.patientSnapshot) rows.push(...wrapLine(`患者：${card.patientSnapshot.displayName} · ${formatAge(card.patientSnapshot.birthDate, card.generatedAt)} · ${card.patientSnapshot.diseaseType}`));
  rows.push(...wrapLine(`预案版本 ${card.planVersion} · 急诊包版本 ${card.kitVersion} · 用药版本 ${card.medicationVersion} · 生成 ${card.generatedAt}`));
  if (card.planNextReviewAt) rows.push(`下次复核 ${card.planNextReviewAt}`);
  return rows;
}

function wrapLine(value: string, max = 34): string[] { const chars = [...value]; const lines: string[] = []; for (let i = 0; i < chars.length; i += max) lines.push(chars.slice(i, i + max).join('')); return lines.length ? lines : ['']; }
function sourceLabel(value: EmergencyKitItem['source']): string { return value === 'CLINICIAN' ? '医生准备' : value === 'SYSTEM' ? '系统生成' : '家长准备'; }

function validateSource(plan: EmergencyPlan, kit: EmergencyKit): void {
  if (!plan || plan.status !== 'CONFIRMED') throw new RangeError('只有已确认的家庭应急预案可以生成应急流程卡');
  if (plan.clinician.nightCapable !== 'TRUE') throw new RangeError('医生尚未确认医院具备夜间收治能力，不能生成应急流程卡');
  if (!plan.caregiver.primaryHospital || !plan.caregiver.route || !plan.clinician.triageScript?.trim()) throw new RangeError('家庭应急预案缺少医院、路线或分诊话术');
  if (!kit || kit.patientId !== plan.patientId) throw new RangeError('应急预案与急诊包不属于同一患者');
  if (!kit.locationNote?.trim()) throw new RangeError('生成应急流程卡前必须填写急诊包存放位置');
}

function toCardItem(item: EmergencyKitItem): EmergencyCardItem {
  return { id: item.id, type: item.type, label: item.label, source: item.source, prepared: item.prepared, needsReprint: item.needsReprint, ...(item.contentRef === undefined ? {} : { contentRef: item.contentRef }) };
}

export function validateEmergencyCard(card: EmergencyCard): void {
  if (!card || typeof card !== 'object' || Array.isArray(card)) throw new RangeError('应急流程卡无效');
  text(card.id, '应急流程卡标识'); text(card.patientId, '患者标识'); text(card.planId, '预案标识'); text(card.kitId, '急诊包标识');
  version(card.planVersion, '预案版本'); version(card.kitVersion, '急诊包版本'); version(card.version, '卡片版本'); text(card.medicationVersion, '用药版本', 200);
  text(card.generatedBy, '生成者'); instant(card.generatedAt); instant(card.createdAt); instant(card.updatedAt);
  if (card.patientSnapshot !== undefined) { text(card.patientSnapshot.displayName, '患者姓名', 200); instant(card.patientSnapshot.birthDate); if (!['sJIA', 'AOSD', 'OTHER_JIA'].includes(card.patientSnapshot.diseaseType)) throw new RangeError('患者病种无效'); }
  if (!Array.isArray(card.thresholds) || card.thresholds.length !== 4 || card.thresholds.some((item, i) => item.code !== ['SEIZURE', 'HIGH_FEVER_DULL', 'BLEEDING', 'SEVERE_HEADACHE'][i] || item.alwaysRequired !== true || typeof item.label !== 'string')) throw new RangeError('应急流程卡必须保留四条固定阈值');
  const destination = card.destination;
  if (!destination || typeof destination !== 'object' || Array.isArray(destination)) throw new RangeError('应急流程卡去向无效');
  text(destination.hospitalName, '医院名称', 200); if (destination.address !== undefined) text(destination.address, '医院地址', 500); if (destination.nightEntrance !== undefined) text(destination.nightEntrance, '夜间入口', 200); version(destination.arrivalMinutesNight, '夜间到院时间'); if (destination.routeNotes !== undefined) text(destination.routeNotes, '路线备注', 1000); text(destination.triageScript, '分诊话术', 500); text(destination.followUpClinicianPhone, '随诊医师电话', 50); validateOnCallContact(destination.onCallContact); if (destination.driverName !== undefined) text(destination.driverName, '驾驶人', 100); if (destination.driverPhone !== undefined) text(destination.driverPhone, '驾驶人电话', 50);
  if (card.planNextReviewAt !== undefined) instant(card.planNextReviewAt);
  text(card.kitLocation, '急诊包存放位置', 500);
  if (!Array.isArray(card.items) || card.items.length !== 8 || card.items.some(item => !item || typeof item.id !== 'string' || typeof item.label !== 'string' || typeof item.prepared !== 'boolean' || typeof item.needsReprint !== 'boolean')) throw new RangeError('应急流程卡携带物品无效');
  if (!sameStringArray(card.neverDo, EMERGENCY_CARD_NEVER_DO) || !sameStringArray(card.canDo, EMERGENCY_CARD_CAN_DO)) throw new RangeError('应急流程卡行动项无效');
  if (!samePrintHints(card.printHints)) throw new RangeError('应急流程卡打印提示无效');
  if (typeof card.needsReprint !== 'boolean') throw new RangeError('应急流程卡重印状态无效');
  if (card.reprintReason !== undefined) validateReprintReason(card.reprintReason);
  if (!card.needsReprint && card.reprintReason !== undefined) throw new RangeError('未标记重印的应急流程卡不能保留重印原因');
  if (!Array.isArray(card.history) || card.history.length !== card.version || card.history.length > 500) throw new RangeError('应急流程卡历史无效');
  card.history.forEach((event, index) => { if (!event || event.id !== `${card.id}:${index + 1}` || event.version !== index + 1 || !['GENERATED', 'REPRINT_MARKED'].includes(event.type) || !Array.isArray(event.changedFields)) throw new RangeError('应急流程卡历史无效'); text(event.actorId, '历史操作者'); instant(event.at); if (event.reprintReason !== undefined) validateReprintReason(event.reprintReason); });
}

function clonePrintHints(): EmergencyCardPrintHints { return { size: 'A4', orientation: 'PORTRAIT', monochrome: true, suggestedLocations: ['FRIDGE', 'DOOR_INSIDE', 'CAR'] }; }
function samePrintHints(value: EmergencyCardPrintHints): boolean { return value?.size === 'A4' && value.orientation === 'PORTRAIT' && value.monochrome === true && Array.isArray(value.suggestedLocations) && value.suggestedLocations.length === 3 && value.suggestedLocations.every((item, i) => item === ['FRIDGE', 'DOOR_INSIDE', 'CAR'][i]); }
function sameStringArray(value: unknown, expected: readonly string[]): value is string[] { return Array.isArray(value) && value.length === expected.length && value.every((item, i) => item === expected[i]); }
function validateReprintReason(value: unknown): asserts value is EmergencyCardReprintReason { if (!['PLAN_UPDATED', 'KIT_UPDATED', 'MEDICATION_UPDATED', 'PLAN_AND_KIT_UPDATED', 'PLAN_AND_MEDICATION_UPDATED', 'KIT_AND_MEDICATION_UPDATED', 'ALL_SOURCES_UPDATED', 'MANUAL'].includes(value as string)) throw new RangeError('重印原因无效'); }
function validateOnCallContact(value: EmergencyOnCallContact): void { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['label', 'phone'].includes(key))) throw new RangeError('值班联系方式无效'); text(value.label, '值班联系方式名称', 100); text(value.phone, '值班电话', 50); }
function version(value: unknown, label: string): asserts value is number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) throw new RangeError(`${label}无效`); }
function text(value: unknown, label: string, max = 512): asserts value is string { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) throw new RangeError(`${label}无效`); }
function instant(value: unknown): asserts value is Iso { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new RangeError('时间无效'); }
function formatAge(birthDate: Iso, at: Iso): string { const birth = new Date(birthDate), now = new Date(at); let months = (now.getUTCFullYear() - birth.getUTCFullYear()) * 12 + now.getUTCMonth() - birth.getUTCMonth(); if (now.getUTCDate() < birth.getUTCDate()) months -= 1; return `${Math.max(0, Math.floor(months / 12))}岁${Math.max(0, months % 12)}月`; }
function escapeXml(value: string): string { return value.replace(/[&<>\"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]!)); }
