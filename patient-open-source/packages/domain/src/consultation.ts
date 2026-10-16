/** 跨端远程求助/会诊闭环；仅记录协作事实，不自动生成诊断或处置结论。 */
export const CONSULTATION_STATUSES = ['PENDING', 'ACCEPTED', 'RESPONDED', 'ACKNOWLEDGED', 'CLOSED', 'DECLINED', 'CANCELLED'] as const;
export type ConsultationStatus = (typeof CONSULTATION_STATUSES)[number];
export const CONSULTATION_URGENCIES = ['ROUTINE', 'SOON', 'URGENT'] as const;
export type ConsultationUrgency = (typeof CONSULTATION_URGENCIES)[number];
export const CONSULTATION_EVENT_TYPES = ['REQUESTED', 'ACCEPTED', 'REPLIED', 'ACKNOWLEDGED', 'CLOSED', 'DECLINED', 'CANCELLED'] as const;
export type ConsultationEventType = (typeof CONSULTATION_EVENT_TYPES)[number];

export interface ConsultationEvent {
  id: string;
  type: ConsultationEventType;
  actorId: string;
  at: string;
  body?: string;
  nextStep?: string;
}

export interface Consultation {
  id: string;
  patientId: string;
  requesterActorId: string;
  assignedActorId?: string;
  topic: string;
  detail?: string;
  urgency: ConsultationUrgency;
  status: ConsultationStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  events: ConsultationEvent[];
}
