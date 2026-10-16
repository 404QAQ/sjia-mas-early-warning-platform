import type { ActorRelation, LifeStage } from './types.js';

/** 医生一键发送的六类结构化消息模板。文案本身不构成诊断或医嘱。 */
export type PatientMessageTemplateKey =
  | 'REQUEST_LAB'
  | 'SAFETY_LINE'
  | 'ADJUST_MED'
  | 'FOLLOW_UP'
  | 'CONFIRM'
  | 'REASSURE';

export type PatientMessageMode = Extract<LifeStage, 'CHILD' | 'TRANSITION' | 'ADULT'>;
export type PatientMessageKind = 'TEMPLATE' | 'FREE_TEXT' | 'STRUCTURED';
export type PatientMessageDirection = 'OUTBOUND' | 'INBOUND';
export type PatientMessageParameter = string | number | string[];

export interface PatientMessageReplyWindow {
  startsAt: string;
  endsAt: string;
  /** 面向患者的可预期说明，不能用“尽快回复”等无时间承诺。 */
  text: string;
}

export interface PatientMessage {
  id: string;
  patientId: string;
  direction: PatientMessageDirection;
  kind: PatientMessageKind;
  senderActorId: string;
  senderUserId: string;
  recipientUserIds: string[];
  mode: PatientMessageMode;
  templateKey?: PatientMessageTemplateKey;
  parameters?: Record<string, PatientMessageParameter>;
  title: string;
  /** 自由文本原样保留；客户端只能转义后展示，不得二次医学解析。 */
  body: string;
  replyWindow?: PatientMessageReplyWindow;
  createdAt: string;
  idempotencyKey: string;
}

export interface PatientMessageRead {
  messageId: string;
  patientId: string;
  userId: string;
  firstActorId: string;
  relationAtRead: ActorRelation;
  readAt: string;
}

export type PatientMessageReadView = Pick<PatientMessageRead, 'userId' | 'firstActorId' | 'relationAtRead' | 'readAt'>;

export interface PatientMessageRecord {
  message: PatientMessage;
  read: PatientMessageReadView | null;
}

export interface PatientMessagePage {
  patientId: string;
  asOf: string;
  revision: number;
  records: PatientMessageRecord[];
  nextCursor?: string;
}
