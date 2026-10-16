import type { CareShift } from './care-routing.js';

export const SHIFT_SWAP_CONFIRMATION_REASON = '本人同意两班互换';

export interface CareShiftSwapConfirmation {
  actorId: string;
  userId: string;
  at: string;
  incomingSourceShiftId: string;
}

/** Both immutable source slots are replaced together after two distinct personal consents. */
export interface CareShiftSwap {
  id: string;
  orgUnitId: string;
  sourceShifts: [CareShift, CareShift];
  reason: string;
  requestedBy: { actorId: string; userId: string };
  requestedAt: string;
  confirmations: CareShiftSwapConfirmation[];
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED';
  version: number;
  /** Same slot order as sourceShifts; each slot receives the other source's user. */
  replacementShifts?: [CareShift, CareShift];
  resolvedAt?: string;
  resolvedBy?: { actorId: string; userId: string };
  resolutionReason?: string;
}

export interface CareShiftSwapEvent {
  id: string;
  swapId: string;
  orgUnitId: string;
  version: number;
  type: 'REQUESTED' | 'CONFIRMED' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED';
  at: string;
  actorId: string;
  userId: string;
  reason: string;
}

/** Scheduling facts only; no clinical patient identifiers or free-text reasons. */
export interface CareShiftSwapNotice {
  id: string;
  eventId: string;
  swapId: string;
  orgUnitId: string;
  recipientUserId: string;
  sourceShifts: [CareShift, CareShift];
  eventType: CareShiftSwapEvent['type'];
  actorUserId: string;
  createdAt: string;
  readAt?: string;
}

export interface CareShiftSwapRecord {
  swap: CareShiftSwap;
  events: CareShiftSwapEvent[];
  canConfirm: boolean;
  canDecline: boolean;
  canCancel: boolean;
  unavailableReason?: string;
}

export interface CareShiftSwapPage {
  orgUnitId: string;
  asOf: string;
  revision: number;
  canSchedule: boolean;
  from: string;
  to: string;
  records: CareShiftSwapRecord[];
  nextCursor?: string;
}

export interface CareShiftSwapNoticePage {
  orgUnitId: string;
  asOf: string;
  revision: number;
  notices: CareShiftSwapNotice[];
  nextCursor?: string;
}
