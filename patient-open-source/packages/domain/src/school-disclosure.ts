/** L-01 校园分层告知。此聚合只保存授权与文书版本，不保存学校端的临床回执。 */
export const SCHOOL_RECIPIENT_ROLES = ['HEAD_TEACHER', 'SCHOOL_NURSE', 'SUBJECT_TEACHER'] as const;
export type SchoolRecipientRole = (typeof SCHOOL_RECIPIENT_ROLES)[number];
export const SCHOOL_DISCLOSURE_LEVELS = ['ESSENTIAL', 'LIMITED'] as const;
export type SchoolDisclosureLevel = (typeof SCHOOL_DISCLOSURE_LEVELS)[number];
export const PE_ARRANGEMENTS = ['FULL', 'LIMITED', 'EXEMPT'] as const;
export type PeArrangement = (typeof PE_ARRANGEMENTS)[number];
export const PEER_DISCLOSURE_DECISIONS = ['SHARE', 'DO_NOT_SHARE'] as const;
export type PeerDisclosureDecision = (typeof PEER_DISCLOSURE_DECISIONS)[number];

export interface SchoolDisclosureRecipient {
  role: SchoolRecipientRole;
  level: SchoolDisclosureLevel;
  generatedDocRef?: string;
  generatedAt?: string;
}

export interface SchoolEmergencyContact {
  name: string;
  relation: string;
  /** 应用层只保存掩码，原始号码不能进入校园说明或应急分享投影。 */
  phoneMasked: string;
  authorized: boolean;
}

export interface PeerDisclosureChoice {
  decision: PeerDisclosureDecision;
  setAt: string;
  /** 仅患者本人可写；对非临床投影隐藏。 */
  setBy: string;
}

export interface SchoolDisclosureHistoryEntry {
  version: number;
  term: string;
  at: string;
  by: string;
  reason: 'SET' | 'TERM_CHANGED' | 'GENERATE_DOCUMENT' | 'PEER_DECISION';
}

export interface SchoolDisclosure {
  patientId: string;
  term: string;
  recipients: SchoolDisclosureRecipient[];
  /** 默认 FULL；EXEMPT 绝不由服务端自动选择。 */
  peArrangement: PeArrangement;
  peClinicianNoteRef?: string;
  schoolEmergencyContact?: SchoolEmergencyContact;
  peerDecision?: PeerDisclosureChoice;
  version: number;
  updatedAt: string;
  history: SchoolDisclosureHistoryEntry[];
}

export function isSchoolRecipientRole(value: unknown): value is SchoolRecipientRole {
  return typeof value === 'string' && (SCHOOL_RECIPIENT_ROLES as readonly string[]).includes(value);
}
export function isSchoolDisclosureLevel(value: unknown): value is SchoolDisclosureLevel {
  return value === 'ESSENTIAL' || value === 'LIMITED';
}
export function isPeArrangement(value: unknown): value is PeArrangement {
  return value === 'FULL' || value === 'LIMITED' || value === 'EXEMPT';
}
export function isPeerDisclosureDecision(value: unknown): value is PeerDisclosureDecision {
  return value === 'SHARE' || value === 'DO_NOT_SHARE';
}
export function isSchoolDisclosure(value: unknown): value is SchoolDisclosure {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const allowed = ['patientId', 'term', 'recipients', 'peArrangement', 'peClinicianNoteRef', 'schoolEmergencyContact', 'peerDecision', 'version', 'updatedAt', 'history'];
  if (Object.keys(item).some(key => !allowed.includes(key))) return false;
  if (typeof item.patientId !== 'string' || !item.patientId || typeof item.term !== 'string' || !/^\d{4}-S[12]$/.test(item.term)) return false;
  const version = item.version;
  if (!isPeArrangement(item.peArrangement) || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1 || typeof item.updatedAt !== 'string') return false;
  if (item.peClinicianNoteRef !== undefined && (typeof item.peClinicianNoteRef !== 'string' || !item.peClinicianNoteRef.trim())) return false;
  if (!Array.isArray(item.recipients) || item.recipients.some(recipient => !isRecipient(recipient))) return false;
  if (item.schoolEmergencyContact !== undefined && !isEmergencyContact(item.schoolEmergencyContact)) return false;
  if (item.peerDecision !== undefined && !isPeerChoice(item.peerDecision)) return false;
  if (!Array.isArray(item.history) || item.history.length !== version || item.history.some(entry => !isHistory(entry))) return false;
  return true;
}

function isRecipient(value: unknown): value is SchoolDisclosureRecipient {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !['role', 'level', 'generatedDocRef', 'generatedAt'].includes(key))) return false;
  if (!isSchoolRecipientRole(item.role) || !isSchoolDisclosureLevel(item.level)) return false;
  if (item.role === 'SUBJECT_TEACHER' && item.level !== 'LIMITED') return false;
  if ((item.role === 'HEAD_TEACHER' || item.role === 'SCHOOL_NURSE') && item.level !== 'ESSENTIAL') return false;
  if (item.generatedDocRef !== undefined && (typeof item.generatedDocRef !== 'string' || !item.generatedDocRef.trim())) return false;
  return item.generatedAt === undefined || typeof item.generatedAt === 'string';
}
function isEmergencyContact(value: unknown): value is SchoolEmergencyContact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every(key => ['name', 'relation', 'phoneMasked', 'authorized'].includes(key))
    && typeof item.name === 'string' && Boolean(item.name.trim()) && typeof item.relation === 'string' && Boolean(item.relation.trim())
    && typeof item.phoneMasked === 'string' && /^\d{3}\*{4}\d{4}$/.test(item.phoneMasked) && typeof item.authorized === 'boolean';
}
function isPeerChoice(value: unknown): value is PeerDisclosureChoice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every(key => ['decision', 'setAt', 'setBy'].includes(key)) && isPeerDisclosureDecision(item.decision)
    && typeof item.setAt === 'string' && typeof item.setBy === 'string' && Boolean(item.setBy);
}
function isHistory(value: unknown): value is SchoolDisclosureHistoryEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every(key => ['version', 'term', 'at', 'by', 'reason'].includes(key)) && Number.isSafeInteger(item.version) && Number(item.version) >= 1
    && typeof item.term === 'string' && /^\d{4}-S[12]$/.test(item.term) && typeof item.at === 'string' && typeof item.by === 'string' && Boolean(item.by)
    && ['SET', 'TERM_CHANGED', 'GENERATE_DOCUMENT', 'PEER_DECISION'].includes(String(item.reason));
}
