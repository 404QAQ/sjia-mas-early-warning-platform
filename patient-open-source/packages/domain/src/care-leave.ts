/** A personally accepted, frozen set of primary-care responsibilities. */
export interface CareLeaveAssignment {
  patientId: string;
  fromActorId: string;
  toActorId: string;
  startsAt: string;
  endsAt: string;
  sourceMembershipIds: string[];
}

export type CareLeaveStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'ENDED';
export interface CareLeave {
  id: string;
  orgUnitId: string;
  fromUserId: string;
  toUserId: string;
  startsAt: string;
  endsAt: string;
  reason: string;
  scopeFingerprint: string;
  assignments: CareLeaveAssignment[];
  requestedBy: { actorId: string; userId: string };
  requestedAt: string;
  status: CareLeaveStatus;
  version: number;
  acceptedAt?: string;
  effectiveStartsAt?: string;
  resolvedAt?: string;
  resolvedBy?: { actorId: string; userId: string };
  resolutionReason?: string;
  endedAt?: string;
}

/** Patient reads receive only this patient's assignments; no reason or other patient IDs. */
export type CareLeaveProjection = Pick<CareLeave,
  'id' | 'orgUnitId' | 'fromUserId' | 'toUserId' | 'startsAt' | 'endsAt' | 'status' |
  'effectiveStartsAt' | 'endedAt' | 'assignments'>;
export type CareLeaveView = Omit<CareLeave, 'assignments'> & { patientCount: number; assignmentCount: number };
export interface CareLeaveEvent {
  id: string;
  leaveId: string;
  orgUnitId: string;
  version: number;
  type: 'REQUESTED' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'ENDED';
  at: string;
  actorId: string;
  userId: string;
  reason: string;
}
export interface CareLeaveNotice {
  id: string;
  eventId: string;
  leaveId: string;
  orgUnitId: string;
  recipientUserId: string;
  fromUserId: string;
  toUserId: string;
  startsAt: string;
  endsAt: string;
  patientCount: number;
  eventType: CareLeaveEvent['type'];
  createdAt: string;
  effectiveStartsAt?: string;
  endedAt?: string;
  readAt?: string;
}
