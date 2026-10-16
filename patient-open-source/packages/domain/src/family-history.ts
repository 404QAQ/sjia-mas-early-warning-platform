/** T-05 家族史与手足信息。手足是内嵌描述，不是独立患者主体。 */
export const FAMILY_AUTOIMMUNE_CODES = [
  'RHEUMATOID_ARTHRITIS',
  'OTHER_JIA',
  'PSORIASIS_IBD',
  'OTHER',
] as const;
export type FamilyAutoimmuneCode = (typeof FAMILY_AUTOIMMUNE_CODES)[number];

export interface FamilyHistorySibling {
  ageYears: number;
  healthy: boolean;
  note?: string;
}

export interface FamilyHistoryContent {
  declined: boolean;
  siblings: FamilyHistorySibling[];
  familyAutoimmune: FamilyAutoimmuneCode[];
  otherNote?: string;
}

export interface FamilyHistorySnapshot extends FamilyHistoryContent {
  version: number;
  at: string;
  by: string;
}

export interface FamilyHistory extends FamilyHistoryContent {
  patientId: string;
  version: number;
  updatedAt: string;
  updatedBy: string;
  history: FamilyHistorySnapshot[];
}

export function isFamilyAutoimmuneCode(value: unknown): value is FamilyAutoimmuneCode {
  return typeof value === 'string' && (FAMILY_AUTOIMMUNE_CODES as readonly string[]).includes(value);
}

export function isFamilyHistoryContent(value: unknown): value is FamilyHistoryContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every(key => ['declined', 'siblings', 'familyAutoimmune', 'otherNote'].includes(key)) && validContent(item);
}

export function isFamilyHistory(value: unknown): value is FamilyHistory {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const allowed = ['patientId', 'siblings', 'familyAutoimmune', 'otherNote', 'declined', 'version', 'updatedAt', 'updatedBy', 'history'];
  if (Object.keys(item).some(key => !allowed.includes(key))) return false;
  if (!text(item.patientId) || !validContent(item) || !positiveVersion(item.version) || !iso(item.updatedAt) || !text(item.updatedBy)) return false;
  if (!Array.isArray(item.history) || item.history.length !== item.version || item.history.some((entry, index) => !isSnapshot(entry, index + 1))) return false;
  const latest = item.history[item.history.length - 1] as FamilyHistorySnapshot;
  return latest.at === item.updatedAt && latest.by === item.updatedBy && latest.declined === item.declined
    && latest.otherNote === item.otherNote
    && JSON.stringify(latest.siblings) === JSON.stringify(item.siblings)
    && JSON.stringify(latest.familyAutoimmune) === JSON.stringify(item.familyAutoimmune);
}

function isSnapshot(value: unknown, expectedVersion: number): value is FamilyHistorySnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const allowed = ['version', 'at', 'by', 'declined', 'siblings', 'familyAutoimmune', 'otherNote'];
  if (Object.keys(item).some(key => !allowed.includes(key))) return false;
  return item.version === expectedVersion && positiveVersion(item.version) && iso(item.at) && text(item.by) && validContent(item);
}

function validContent(item: Record<string, unknown>): boolean {
  if (typeof item.declined !== 'boolean') return false;
  if (!Array.isArray(item.siblings) || item.siblings.length > 20 || item.siblings.some(sibling => !isSibling(sibling))) return false;
  if (!Array.isArray(item.familyAutoimmune) || new Set(item.familyAutoimmune).size !== item.familyAutoimmune.length || item.familyAutoimmune.some(code => !isFamilyAutoimmuneCode(code))) return false;
  if (item.otherNote !== undefined && (!shortText(item.otherNote) || !item.familyAutoimmune.includes('OTHER'))) return false;
  return !item.declined || (item.siblings.length === 0 && item.familyAutoimmune.length === 0 && item.otherNote === undefined);
}

function isSibling(value: unknown): value is FamilyHistorySibling {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every(key => ['ageYears', 'healthy', 'note'].includes(key))
    && Number.isSafeInteger(item.ageYears) && Number(item.ageYears) >= 0 && Number(item.ageYears) <= 120
    && typeof item.healthy === 'boolean'
    && (item.note === undefined || shortText(item.note));
}

function positiveVersion(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1; }
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[\0\r\n]/.test(value); }
function shortText(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 500 && !/[\0\r\n]/.test(value); }
function iso(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
