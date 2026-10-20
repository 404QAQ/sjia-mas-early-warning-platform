import { parseCareInstant } from './time.js';
import type { Iso } from './types.js';

export type EmergencyKitItemType = 'DOC' | 'PHYSICAL' | 'DIGITAL';
export type EmergencyKitItemSource = 'CLINICIAN' | 'SYSTEM' | 'CAREGIVER';
export type EmergencyKitVerificationStatus = 'NOT_VERIFIED' | 'CURRENT' | 'DUE';
export type EmergencyKitEventType = 'DRAFT_SAVED' | 'ITEM_UPDATED' | 'VERIFIED' | 'REPRINT_MARKED';

export interface EmergencyKitItem {
  id: string;
  type: EmergencyKitItemType;
  label: string;
  source: EmergencyKitItemSource;
  contentRef?: string;
  prepared: boolean;
  preparedAt?: Iso;
  needsReprint: boolean;
}

export interface EmergencyKitEvent {
  id: string;
  type: EmergencyKitEventType;
  at: Iso;
  actorId: string;
  version: number;
  changedFields: string[];
}

export interface EmergencyKit {
  id: string;
  patientId: string;
  locationNote?: string;
  familyInformed: boolean;
  items: EmergencyKitItem[];
  lastVerifiedAt?: Iso;
  verifiedBy?: string;
  version: number;
  createdAt: Iso;
  updatedAt: Iso;
  history: EmergencyKitEvent[];
}

export interface EmergencyKitEvaluation {
  status: EmergencyKitVerificationStatus;
  completedCount: number;
  totalCount: number;
  needsReprintCount: number;
  verifiedAt?: Iso;
}

export const EMERGENCY_KIT_DEFAULT_ITEMS: readonly EmergencyKitItem[] = [
  { id: 'DOC_REFERRAL', type: 'DOC', label: '转诊单 / 急诊优先卡', source: 'CLINICIAN', prepared: false, needsReprint: false },
  { id: 'DOC_LABS', type: 'DOC', label: '关键化验项目单', source: 'CLINICIAN', prepared: false, needsReprint: false },
  { id: 'DOC_SUMMARY', type: 'DOC', label: '当次病案摘要（一页纸）', source: 'SYSTEM', prepared: false, needsReprint: false },
  { id: 'DOC_ID', type: 'DOC', label: '医保卡 / 就诊卡 / 证件复印件', source: 'CAREGIVER', prepared: false, needsReprint: false },
  { id: 'PHYSICAL_MEDICATION', type: 'PHYSICAL', label: '当前用药实物或清单', source: 'CAREGIVER', prepared: false, needsReprint: false },
  { id: 'PHYSICAL_THERMOMETER', type: 'PHYSICAL', label: '体温计', source: 'CAREGIVER', prepared: false, needsReprint: false },
  { id: 'DIGITAL_SUMMARY', type: 'DIGITAL', label: '急诊摘要卡（离线可读）', source: 'SYSTEM', contentRef: 'emergency-summary', prepared: false, needsReprint: false },
  { id: 'DIGITAL_PLAN', type: 'DIGITAL', label: '应急预案（离线可读）', source: 'SYSTEM', contentRef: 'emergency-plan', prepared: false, needsReprint: false },
];

export function createEmergencyKit(patientId: string, id: string, at: Iso): EmergencyKit {
  text(patientId, '患者标识'); text(id, '急诊包标识'); instant(at);
  return { id, patientId, familyInformed: false, items: defaultItems(), version: 0, createdAt: at, updatedAt: at, history: [] };
}

/** 保存位置、全家知情及整组人工勾选状态；不改变核对时间。 */
export function saveEmergencyKitDraft(kit: EmergencyKit, patch: EmergencyKitDraftPatch, actorId: string, at: Iso): EmergencyKit {
  validateEmergencyKit(kit); text(actorId, '操作者'); instant(at); validatePatch(patch);
  const next: EmergencyKit = {
    ...structuredClone(kit),
    ...(patch.locationNote === undefined ? {} : { locationNote: patch.locationNote.trim() }),
    ...(patch.familyInformed === undefined ? {} : { familyInformed: patch.familyInformed }),
    updatedAt: at,
  };
  if (patch.locationNote === '') next.locationNote = undefined;
  return append(kit, next, { type: 'DRAFT_SAVED', actorId, at, changedFields: patchFields(patch) });
}

export interface EmergencyKitDraftPatch {
  locationNote?: string;
  familyInformed?: boolean;
}

export function markEmergencyKitItem(kit: EmergencyKit, itemId: string, prepared: boolean, actorId: string, at: Iso): EmergencyKit {
  validateEmergencyKit(kit); text(itemId, '物品标识'); text(actorId, '操作者'); instant(at);
  if (typeof prepared !== 'boolean') throw new RangeError('物品准备状态无效');
  const index = kit.items.findIndex(item => item.id === itemId);
  if (index < 0) throw new RangeError('急诊包物品不存在');
  const items = structuredClone(kit.items);
  items[index] = { ...items[index]!, prepared, ...(prepared ? { preparedAt: at } : { preparedAt: undefined }) };
  return append(kit, { ...structuredClone(kit), items, updatedAt: at }, { type: 'ITEM_UPDATED', actorId, at, changedFields: [`items.${itemId}.prepared`, `items.${itemId}.preparedAt`] });
}

export function markEmergencyKitReprint(kit: EmergencyKit, itemId: string, needsReprint: boolean, actorId: string, at: Iso): EmergencyKit {
  validateEmergencyKit(kit); text(itemId, '物品标识'); text(actorId, '操作者'); instant(at);
  if (typeof needsReprint !== 'boolean') throw new RangeError('需重印状态无效');
  const index = kit.items.findIndex(item => item.id === itemId);
  if (index < 0) throw new RangeError('急诊包物品不存在');
  const items = structuredClone(kit.items); items[index] = { ...items[index]!, needsReprint };
  return append(kit, { ...structuredClone(kit), items, updatedAt: at }, { type: 'REPRINT_MARKED', actorId, at, changedFields: [`items.${itemId}.needsReprint`] });
}

/** 核对只记录事实；它不会替家长把任何条目标记为已准备。 */
export function verifyEmergencyKit(kit: EmergencyKit, actorId: string, at: Iso): EmergencyKit {
  validateEmergencyKit(kit); text(actorId, '核对人'); instant(at);
  if (!kit.locationNote?.trim()) throw new RangeError('核对前必须填写急诊包存放位置');
  if (kit.familyInformed !== true) throw new RangeError('核对前必须确认全家都知道存放位置');
  return append(kit, { ...structuredClone(kit), lastVerifiedAt: at, verifiedBy: actorId, updatedAt: at }, { type: 'VERIFIED', actorId, at, changedFields: ['lastVerifiedAt', 'verifiedBy'] });
}

export function evaluateEmergencyKit(kit: EmergencyKit, now: Iso): EmergencyKitEvaluation {
  validateEmergencyKit(kit); instant(now);
  const completedCount = kit.items.filter(item => item.prepared).length;
  const needsReprintCount = kit.items.filter(item => item.needsReprint).length;
  if (!kit.lastVerifiedAt) return { status: 'NOT_VERIFIED', completedCount, totalCount: kit.items.length, needsReprintCount };
  const status: EmergencyKitVerificationStatus = parseCareInstant(now) > parseCareInstant(addEmergencyKitMonths(kit.lastVerifiedAt, 3)) ? 'DUE' : 'CURRENT';
  return { status, completedCount, totalCount: kit.items.length, needsReprintCount, verifiedAt: kit.lastVerifiedAt };
}

/** 以公历月推进核对日期，月底不会滚到错误月份。 */
export function addEmergencyKitMonths(value: Iso, months: number): Iso {
  const source = new Date(parseCareInstant(value));
  if (!Number.isInteger(months) || months <= 0 || months > 120) throw new RangeError('月份数无效');
  const target = new Date(source);
  target.setUTCDate(1); target.setUTCMonth(target.getUTCMonth() + months);
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(source.getUTCDate(), last));
  target.setUTCHours(source.getUTCHours(), source.getUTCMinutes(), source.getUTCSeconds(), source.getUTCMilliseconds());
  return target.toISOString();
}

export function validateEmergencyKit(kit: EmergencyKit): void {
  if (!kit || typeof kit !== 'object' || Array.isArray(kit)) throw new RangeError('急诊包无效');
  text(kit.id, '急诊包标识'); text(kit.patientId, '患者标识'); instant(kit.createdAt); instant(kit.updatedAt);
  if (typeof kit.familyInformed !== 'boolean') throw new RangeError('家庭知情状态无效');
  if (kit.locationNote !== undefined) text(kit.locationNote, '存放位置', 500);
  if (!Number.isSafeInteger(kit.version) || kit.version < 0) throw new RangeError('急诊包版本无效');
  if (!Array.isArray(kit.items) || kit.items.length !== EMERGENCY_KIT_DEFAULT_ITEMS.length) throw new RangeError('急诊包物品清单无效');
  validateItemSet(kit.items);
  if (!kit.lastVerifiedAt && kit.verifiedBy !== undefined) throw new RangeError('核对人记录不完整');
  if (kit.lastVerifiedAt) instant(kit.lastVerifiedAt);
  if (kit.verifiedBy !== undefined) text(kit.verifiedBy, '核对人');
  if (!Array.isArray(kit.history) || kit.history.length > 500 || kit.history.length !== kit.version) throw new RangeError('急诊包历史无效');
  kit.history.forEach((event, i) => { if (!event || event.id !== `${kit.id}:${i + 1}` || event.version !== i + 1 || !Array.isArray(event.changedFields) || event.changedFields.some(field => !textSafe(field)) || !['DRAFT_SAVED', 'ITEM_UPDATED', 'VERIFIED', 'REPRINT_MARKED'].includes(event.type)) throw new RangeError('急诊包历史无效'); text(event.actorId, '历史操作者'); instant(event.at); });
}

function defaultItems(): EmergencyKitItem[] { return EMERGENCY_KIT_DEFAULT_ITEMS.map(item => ({ ...item })); }
function validatePatch(patch: EmergencyKitDraftPatch): void {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !['locationNote', 'familyInformed'].includes(key))) throw new RangeError('急诊包修改字段无效');
  if (patch.locationNote !== undefined && patch.locationNote !== '') text(patch.locationNote, '存放位置', 500);
  if (patch.familyInformed !== undefined && typeof patch.familyInformed !== 'boolean') throw new RangeError('家庭知情状态无效');
}
function validateItem(item: EmergencyKitItem): void {
  if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['id', 'type', 'label', 'source', 'contentRef', 'prepared', 'preparedAt', 'needsReprint'].includes(key))) throw new RangeError('急诊包物品无效');
  text(item.id, '物品标识', 80); text(item.label, '物品名称', 200);
  if (!['DOC', 'PHYSICAL', 'DIGITAL'].includes(item.type) || !['CLINICIAN', 'SYSTEM', 'CAREGIVER'].includes(item.source)) throw new RangeError('急诊包物品分类无效');
  if (item.contentRef !== undefined) text(item.contentRef, '内容引用', 200);
  if (typeof item.prepared !== 'boolean' || typeof item.needsReprint !== 'boolean') throw new RangeError('急诊包物品状态无效');
  if (item.preparedAt !== undefined) instant(item.preparedAt);
  if (!item.prepared && item.preparedAt !== undefined) throw new RangeError('未准备物品不能保留准备时间');
}
function validateItemSet(items: readonly EmergencyKitItem[]): void {
  if (!Array.isArray(items) || items.length !== EMERGENCY_KIT_DEFAULT_ITEMS.length) throw new RangeError('急诊包物品清单无效');
  const defaults = new Map(EMERGENCY_KIT_DEFAULT_ITEMS.map(item => [item.id, item]));
  const seen = new Set<string>();
  for (const item of items) {
    validateItem(item);
    const baseline = defaults.get(item.id);
    if (!baseline || seen.has(item.id) || item.type !== baseline.type || item.label !== baseline.label || item.source !== baseline.source || item.contentRef !== baseline.contentRef) throw new RangeError('急诊包物品定义不可修改');
    seen.add(item.id);
  }
}
function append(kit: EmergencyKit, next: EmergencyKit, event: Omit<EmergencyKitEvent, 'id' | 'version'>): EmergencyKit {
  if (kit.history.length >= 500) throw new RangeError('急诊包历史过长');
  const version = kit.version + 1;
  return { ...next, version, history: [...kit.history.map(item => ({ ...item, changedFields: [...item.changedFields] })), { ...event, id: `${kit.id}:${version}`, version, changedFields: [...event.changedFields] }] };
}
function patchFields(patch: EmergencyKitDraftPatch): string[] { return [...(patch.locationNote === undefined ? [] : ['locationNote']), ...(patch.familyInformed === undefined ? [] : ['familyInformed'])]; }
function text(value: unknown, label: string, max = 200): asserts value is string { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) throw new RangeError(`${label}无效`); }
function textSafe(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\r\n\0]/.test(value); }
function instant(value: unknown): asserts value is Iso { if (typeof value !== 'string' || !Number.isFinite(parseCareInstant(value))) throw new RangeError('时间无效'); }
