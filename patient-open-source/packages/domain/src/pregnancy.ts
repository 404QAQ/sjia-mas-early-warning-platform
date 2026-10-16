import type { Iso, PatientSex } from './types.js';
import { parseCareInstant } from './care-routing.js';

/** L-06 妊娠与生育状态；不参与孕期 MAS 风险评分。 */
export const PREGNANCY_STATES = ['CONSIDERING', 'PLANNING', 'PREGNANT', 'POSTPARTUM', 'NONE'] as const;
export type PregnancyState = (typeof PREGNANCY_STATES)[number];

/**
 * `pregnant` 保留给旧患者摘要/医生端 DTO；新接口以 state 为权威。
 * `lastIdempotencyKey` 只供仓储内部回放，公开 DTO 必须移除。
 */
export interface PregnancyStatus {
  state: PregnancyState;
  pregnant: boolean;
  since?: Iso;
  edd?: Iso;
  deliveryDate?: Iso;
  affectedMedications: string[];
  postpartumWatchUntil?: Iso;
  version: number;
  updatedAt?: Iso;
  updatedBy?: string;
  lastIdempotencyKey?: string;
}

export type FertilityContentMode = 'PREGNANCY' | 'FERTILITY' | 'GENERAL';

export interface FertilityContentSection {
  id: 'PRECONCEPTION' | 'MEDICATIONS' | 'GENETICS' | 'FOLLOWUP';
  title: string;
  items: string[];
}

export interface FertilityContentView {
  patientId: string;
  sex: PatientSex;
  mode: FertilityContentMode;
  title: string;
  intro: string;
  sections: FertilityContentSection[];
  affectedMedications: string[];
}

export interface PregnancyQuestion {
  id: 'MEDICATION_CONTINUATION' | 'TIMING' | 'MEDICATION_LEAD_TIME';
  prompt: string;
}

export interface PregnancyChecklistView {
  patientId: string;
  statusVersion: number;
  generatedAt: Iso;
  questions: PregnancyQuestion[];
}

export interface PregnancyQuestionSet extends PregnancyChecklistView {
  id: string;
  sexSnapshot: PatientSex;
  contentVersion: 1;
  usedAt?: Iso;
}

/**
 * 性别只决定内容入口，不推断生育器官、意愿或临床风险；未知值使用中性内容。
 * 这里的药物只作为待与医生核对的服务端派生清单，不构成用药建议。
 */
export function fertilityContentForSex(patientId: string, sex: PatientSex | undefined, affectedMedications: readonly string[]): FertilityContentView {
  const resolved: PatientSex = sex === 'FEMALE' || sex === 'MALE' || sex === 'INTERSEX' || sex === 'UNKNOWN' ? sex : 'UNKNOWN';
  if (resolved === 'MALE') return {
    patientId, sex: resolved, mode: 'FERTILITY', title: '生育这件事',
    intro: '备孕前可以把当前用药带给医生核对，具体安排由医生和你一起确认。',
    sections: [
      { id: 'PRECONCEPTION', title: '备孕前可以谈什么', items: ['当前用药对生育是否有需要核对的影响', '什么时候是合适的时机', '备孕前是否需要提前评估'] },
      { id: 'MEDICATIONS', title: '当前用药', items: affectedMedications.length ? [`需要医生复核：${affectedMedications.join('、')}`] : ['把当前用药清单带给医生核对'] },
      { id: 'GENETICS', title: '遗传咨询', items: ['如果你担心遗传方面的问题，可以做一次遗传咨询，不用自己猜。'] },
    ], affectedMedications: [...affectedMedications],
  };
  if (resolved === 'FEMALE') return {
    patientId, sex: resolved, mode: 'PREGNANCY', title: '怀孕这件事',
    intro: '这个病和怀孕有关系，所以有些事需要提前想。不是不能怀，是要提前安排。',
    sections: [
      { id: 'PRECONCEPTION', title: '孕前要谈的几件事', items: ['现在的用药能不能继续', '什么时候是合适的时机', '需要提前多久调整用药'] },
      { id: 'MEDICATIONS', title: '用药和监测', items: ['孕期用药和监测需要由风湿科与产科共同确认。'] },
      { id: 'GENETICS', title: '遗传咨询', items: ['如果你担心遗传方面的问题，可以做一次遗传咨询，不用自己猜。'] },
      { id: 'FOLLOWUP', title: '产后', items: ['产后 6 周内需要特别留意并按随访计划和医生保持联系。'] },
    ], affectedMedications: [...affectedMedications],
  };
  return {
    patientId, sex: resolved, mode: 'GENERAL', title: '生育这件事',
    intro: '如果你在考虑生育，可以把当前用药和想法带给医生一起讨论。',
    sections: [
      { id: 'PRECONCEPTION', title: '可以和医生谈什么', items: ['当前用药是否需要核对', '什么时候是合适的时机', '是否需要风湿科与相关专科共同确认'] },
      { id: 'GENETICS', title: '遗传咨询', items: ['如果你担心遗传风险，可以做一次遗传咨询，不用自己猜。'] },
    ], affectedMedications: [...affectedMedications],
  };
}

export function pregnancyChecklistFor(patientId: string, statusVersion: number, generatedAt: Iso): PregnancyChecklistView {
  return {
    patientId, statusVersion, generatedAt,
    questions: [
      { id: 'MEDICATION_CONTINUATION', prompt: '现在的药能不能继续？' },
      { id: 'TIMING', prompt: '什么时候是最合适的时机？' },
      { id: 'MEDICATION_LEAD_TIME', prompt: '需要提前多久调整用药？' },
    ],
  };
}

export interface LegacyPregnancyStatus {
  pregnant: boolean;
  gestationalWeeks?: number;
  postpartumWeeks?: number;
}

export function pregnancyStatePregnant(state: PregnancyState): boolean {
  return state === 'PREGNANT';
}

export function postpartumWatchUntil(deliveryDate: string): string {
  let parsed: number;
  try { parsed = parseCareInstant(deliveryDate); } catch { throw new RangeError('deliveryDate must be a valid instant'); }
  return new Date(parsed + 42 * 24 * 60 * 60 * 1000).toISOString();
}

export function normalizePregnancyStatus(value: unknown): PregnancyStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyPregnancyStatus();
  const raw = value as Record<string, unknown>;
  if (typeof raw.state === 'string' && PREGNANCY_STATES.includes(raw.state as PregnancyState)) {
    const state = raw.state as PregnancyState;
    return {
      state,
      pregnant: state === 'PREGNANT',
      ...(typeof raw.since === 'string' ? { since: raw.since } : {}),
      ...(typeof raw.edd === 'string' ? { edd: raw.edd } : {}),
      ...(typeof raw.deliveryDate === 'string' ? { deliveryDate: raw.deliveryDate } : {}),
      affectedMedications: Array.isArray(raw.affectedMedications) ? raw.affectedMedications.filter((item): item is string => typeof item === 'string') : [],
      ...(typeof raw.postpartumWatchUntil === 'string' ? { postpartumWatchUntil: raw.postpartumWatchUntil } : {}),
      version: Number.isSafeInteger(raw.version) && Number(raw.version) >= 0 ? Number(raw.version) : 0,
      ...(typeof raw.updatedAt === 'string' ? { updatedAt: raw.updatedAt } : {}),
      ...(typeof raw.updatedBy === 'string' ? { updatedBy: raw.updatedBy } : {}),
      ...(typeof raw.lastIdempotencyKey === 'string' ? { lastIdempotencyKey: raw.lastIdempotencyKey } : {}),
    };
  }
  if (typeof raw.pregnant === 'boolean') {
    const state: PregnancyState = raw.pregnant ? 'PREGNANT' : 'NONE';
    return { state, pregnant: raw.pregnant, affectedMedications: [], version: 0 };
  }
  return emptyPregnancyStatus();
}

export function emptyPregnancyStatus(): PregnancyStatus {
  return { state: 'NONE', pregnant: false, affectedMedications: [], version: 0 };
}

export function publicPregnancyStatus(value: PregnancyStatus): Omit<PregnancyStatus, 'lastIdempotencyKey' | 'updatedBy'> {
  const { lastIdempotencyKey: _lastIdempotencyKey, updatedBy: _updatedBy, ...publicValue } = structuredClone(value);
  return publicValue;
}
