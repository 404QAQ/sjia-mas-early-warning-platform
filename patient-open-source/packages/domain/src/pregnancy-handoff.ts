import type { ClinicalSpecialty, PatientSex } from './types.js';
import type { PregnancyState } from './pregnancy.js';

/** L-06B 仅表示跨专科协调事实，不承担告警责任、SLA 或自动路由。 */
export const PREGNANCY_CARE_SPECIALTIES = ['RHEUMATOLOGY', 'OBSTETRICS'] as const;
export type PregnancyCareSpecialty = (typeof PREGNANCY_CARE_SPECIALTIES)[number];

export const PREGNANCY_HANDOFF_STATES = ['PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED'] as const;
export type PregnancyHandoffState = (typeof PREGNANCY_HANDOFF_STATES)[number];

export interface PregnancyCareHandoffSummary {
  contentVersion: 1;
  pregnancyState: PregnancyState;
  pregnancyStatusVersion: number;
  sexSnapshot: PatientSex;
  statusUpdatedAt?: string;
  since?: string;
  edd?: string;
  deliveryDate?: string;
  postpartumWatchUntil?: string;
  /** 当前服务端用药计划的药名快照；不含停换药或剂量结论。 */
  currentMedications: string[];
  questionSet?: {
    id: string;
    statusVersion: number;
    contentVersion: number;
    usedAt?: string;
  };
  clinicianBaselineNote?: string;
}

export interface PregnancyCareHandoff {
  id: string;
  patientId: string;
  fromSpecialty: PregnancyCareSpecialty;
  toSpecialty: PregnancyCareSpecialty;
  initiatedByActorId: string;
  /** 创建时由源专科明确指定的当前目标医师；ACK 只允许此身份。 */
  targetActorId: string;
  initiatedAt: string;
  /** 交接创建时绑定的妊娠状态版本；状态变化后旧交接不能再 ACK。 */
  pregnancyStatusVersion: number;
  summary: PregnancyCareHandoffSummary;
  state: PregnancyHandoffState;
  version: number;
  acceptedByActorId?: string;
  acceptedAt?: string;
  declinedByActorId?: string;
  declinedAt?: string;
  declineReason?: string;
  cancelledByActorId?: string;
  cancelledAt?: string;
}

/** 只有相邻的 PENDING 命令可以产生 ACK；重复 ACK 由服务层幂等回放。 */
export function canAcknowledgePregnancyHandoff(state: PregnancyHandoffState): boolean {
  return state === 'PENDING';
}

/** 源/目标专科必须明确不同，避免把同科回执误记为双科协调。 */
export function isCrossSpecialtyHandoff(from: ClinicalSpecialty, to: ClinicalSpecialty): boolean {
  return from !== to;
}
