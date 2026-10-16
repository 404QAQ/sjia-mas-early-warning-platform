import type { CareOrganization, CareShift } from './care-routing.js';

export type CareShiftChangeMode = 'FULL_FUTURE' | 'REMAINDER_ON_ACCEPT';

export interface CareShiftChange {
  id: string;
  orgUnitId: string;
  /** Missing on legacy records; interpreted as FULL_FUTURE without rewriting them. */
  mode?: CareShiftChangeMode;
  sourceShift: CareShift;
  toUserId: string;
  reason: string;
  requestedBy: { actorId: string; userId: string };
  requestedAt: string;
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED';
  version: number;
  replacementShift?: CareShift;
  resolvedAt?: string;
  resolvedBy?: { actorId: string; userId: string };
  resolutionReason?: string;
}
/** Read-only proof of an original personal confirmation, never a current permission grant. */
export interface CareConfirmedHistorySegment {
  changeId: string;
  sourceShift: CareShift;
  acceptedAt: string;
  startsAt: string;
  endsAt: string;
}
export interface CareShiftChangeEvent {
  id: string;
  changeId: string;
  orgUnitId: string;
  version: number;
  type: 'REQUESTED' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED';
  at: string;
  actorId: string;
  userId: string;
  reason: string;
}
export interface CareScheduleNotice {
  id: string;
  eventId: string;
  changeId: string;
  orgUnitId: string;
  recipientUserId: string;
  sourceUserId: string;
  toUserId: string;
  startsAt: string;
  endsAt: string;
  mode?: CareShiftChangeMode;
  effectiveStartsAt?: string;
  eventType: CareShiftChangeEvent['type'];
  createdAt: string;
  readAt?: string;
}
export interface CareShiftChangeRecord {
  change: CareShiftChange;
  events: CareShiftChangeEvent[];
  canAccept: boolean;
  unavailableReason?: string;
}
export interface CareShiftChangePage {
  organization: CareOrganization;
  asOf: string;
  revision: number;
  canSchedule: boolean;
  from: string;
  to: string;
  records: CareShiftChangeRecord[];
  nextCursor?: string;
}
export interface CareScheduleNoticePage {
  orgUnitId: string;
  asOf: string;
  notices: CareScheduleNotice[];
  nextCursor?: string;
}
