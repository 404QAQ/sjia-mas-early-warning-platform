import type { Actor, AlertStatus, CareTeamRole } from './types.js';
import type { CareLeaveProjection } from './care-leave.js';

export interface CareOrganization {
  id: string;
  name: string;
  timeZone: string;
}

export interface CarePatient {
  patientId: string;
  orgUnitId: string;
}

export interface CareMembership {
  id: string;
  patientId: string;
  actorId: string;
  role: CareTeamRole;
  activeFrom: string;
  activeUntil?: string;
  revokedAt?: string;
  version: number;
}

/** 科室显式发布的独立假日窗口；时间为带时区的绝对 [start,end)。 */
export interface CareHolidayRoster {
  id: string;
  orgUnitId: string;
  label: string;
  startsAt: string;
  endsAt: string;
  status: 'ACTIVE' | 'CANCELLED';
  version: number;
  cancellationReason?: string;
}

export interface CareShift {
  id: string;
  orgUnitId: string;
  clinicianUserId: string;
  /** 缺省为普通班表；保留取消表的引用，绝不自动改成普通班。 */
  holidayRosterId?: string;
  kind: 'ON_CALL' | 'BACKUP';
  startsAt: string;
  endsAt: string;
  status: 'DRAFT' | 'CONFIRMED' | 'CANCELLED';
  version: number;
  confirmedBy?: string;
  confirmedVersion?: number;
  confirmedAt?: string;
}

export interface CareCover {
  id: string;
  patientId: string;
  fromActorId: string;
  toActorId: string;
  startsAt: string;
  endsAt: string;
  status: 'PENDING' | 'CONFIRMED' | 'CANCELLED';
  version: number;
  confirmedBy?: string;
  confirmedVersion?: number;
  confirmedAt?: string;
}

export interface CareSnapshot {
  patientId: string;
  organization?: CareOrganization;
  actors: Actor[];
  memberships: CareMembership[];
  shifts: CareShift[];
  covers: CareCover[];
  holidayRosters?: CareHolidayRoster[];
  leaves?: CareLeaveProjection[];
}

export interface CareClinicianContext {
  actorId: string;
  userId: string;
  clinicianInCareTeam: true;
  clinicianOnDuty: boolean;
  clinicianRole: CareTeamRole;
}

export type CareCoverageError =
  | 'NO_ORGANIZATION' | 'NO_PRIMARY' | 'TOO_MANY_PRIMARY'
  | 'NO_ON_CALL' | 'NO_BACKUP' | 'ON_CALL_UNCONFIRMED' | 'BACKUP_UNCONFIRMED'
  | 'ON_CALL_CONFLICT' | 'BACKUP_CONFLICT' | 'COVER_CONFLICT' | 'COVER_TARGET_UNAVAILABLE'
  | 'MANUAL_TARGET_UNAVAILABLE' | 'HOLIDAY_ROSTER_CONFLICT' | 'HOLIDAY_ROSTER_INVALID'
  | 'LEAVE_SCOPE_CHANGED' | 'LEAVE_TARGET_UNAVAILABLE' | 'LEAVE_CONFLICT';

export interface ResolvedCareContext {
  patientId: string;
  at: string;
  clinicians: CareClinicianContext[];
  primaryActorIds: string[];
  attendingActorIds: string[];
  onCallActorIds: string[];
  backupActorIds: string[];
  activeHolidayRosterId?: string;
  coverageErrors: CareCoverageError[];
  nextReconcileAt?: string;
}

export type CareRoutingStage = 'PRIMARY' | 'ON_CALL' | 'BACKUP' | 'MANUAL' | 'CLOSED';

export interface CareResponsibility {
  stage: CareRoutingStage;
  currentLevel: 1 | 2 | 3;
  levelEnteredAt: string;
  assignedAt: string;
  responsibleActorIds: string[];
  ccActorIds: string[];
  manualActorId?: string;
  acceptedAt?: string;
  respondBy?: string;
}

export interface CareRoutingPolicy {
  version: string;
  l1ResponseMinutes: number;
  l2ResponseMinutes: number;
  l3ResponseMinutes: number;
}

/** 文档的本地草案参数；临床发布/批准由应用层管理，不因导出默认值自动获批。 */
export const DEFAULT_CARE_ROUTING_POLICY: Readonly<CareRoutingPolicy> = {
  version: 'care-routing-draft-v1', l1ResponseMinutes: 1_440, l2ResponseMinutes: 120, l3ResponseMinutes: 30,
};

export interface CareRoutingAlert {
  patientId: string;
  currentLevel: 1 | 2 | 3;
  /** IGNORED 仍处于待复评责任闭环，不等于 RESOLVED。 */
  status: AlertStatus | 'IGNORED';
  createdAt: string;
}

export interface CareRoutingDecision {
  stage: CareRoutingStage;
  levelEnteredAt: string;
  responsibleActorIds: string[];
  ccActorIds: string[];
  coverageErrors: CareCoverageError[];
  nextReconcileAt?: string;
  respondBy?: string;
  reason: string;
}

const ROLE_ORDER: CareTeamRole[] = ['ATTENDING', 'PRIMARY', 'CONSULTANT', 'NURSE', 'ON_CALL'];

/** 当前关系与已确认排班共同决定授权；排班绝不能创建/恢复 Actor 的患者关系。 */
export function resolveCareContext(snapshot: CareSnapshot, at: string): ResolvedCareContext {
  const now = requiredInstant(at, '当前时间');
  const errors = new Set<CareCoverageError>();
  const boundaries: number[] = [];
  const remember = (...values: (string | undefined)[]): void => {
    for (const value of values) {
      const stamp = instant(value);
      if (stamp > now) boundaries.push(stamp);
    }
  };
  const relevantActors = snapshot.actors.filter((actor) => actor.patientId === snapshot.patientId && actor.relation === 'CLINICIAN');
  const actors = new Map(relevantActors
    .filter((actor) => !actor.revokedAt && active(actor.activeFrom, actor.activeUntil, now))
    .map((actor) => [actor.id, actor]));
  for (const actor of relevantActors) if (!actor.revokedAt) remember(actor.activeFrom, actor.activeUntil);
  const memberships = snapshot.memberships.filter((member) => member.patientId === snapshot.patientId && !member.revokedAt);
  for (const member of memberships) remember(member.activeFrom, member.activeUntil);
  const activeMembers = memberships.filter((member) => actors.has(member.actorId) && active(member.activeFrom, member.activeUntil, now));
  const roles = new Map<string, Set<CareTeamRole>>();
  const addRole = (actorId: string, role: CareTeamRole): void => {
    const values = roles.get(actorId) ?? new Set<CareTeamRole>();
    values.add(role);
    roles.set(actorId, values);
  };
  for (const member of activeMembers) if (member.role !== 'ON_CALL') addRole(member.actorId, member.role);

  if (!snapshot.organization) errors.add('NO_ORGANIZATION');
  const { shifts: orgShifts, activeHolidayRosterId } = selectRosterShifts(snapshot, now, errors, remember);
  for (const shift of orgShifts) remember(shift.startsAt, shift.endsAt);
  const activeShifts = orgShifts.filter((shift) => active(shift.startsAt, shift.endsAt, now));
  const dutyFor = (kind: CareShift['kind']): string[] => {
    const shifts = activeShifts.filter((shift) => shift.kind === kind);
    const candidates = new Set<string>();
    for (const shift of shifts) {
      if (!confirmed(shift, shift.clinicianUserId, now)) {
        errors.add(kind === 'ON_CALL' ? 'ON_CALL_UNCONFIRMED' : 'BACKUP_UNCONFIRMED');
        continue;
      }
      for (const actor of actors.values()) if (actor.userId === shift.clinicianUserId && isCarePhysician(snapshot, actor.id, at)) candidates.add(actor.id);
    }
    const users = new Set([...candidates].map((id) => actors.get(id)!.userId));
    if (users.size > 1) {
      errors.add(kind === 'ON_CALL' ? 'ON_CALL_CONFLICT' : 'BACKUP_CONFLICT');
      return [];
    }
    return sorted(candidates);
  };
  const onCallActorIds = dutyFor('ON_CALL');
  const backupActorIds = dutyFor('BACKUP');
  const duty = new Set([...onCallActorIds, ...backupActorIds]);
  for (const id of duty) addRole(id, 'ON_CALL');

  const primary = new Set(activeMembers.filter((member) => member.role === 'PRIMARY').map((member) => member.actorId));
  const currentLeaves = (snapshot.leaves ?? []).filter(leave => {
    if (leave.orgUnitId !== snapshot.organization?.id || !['ACCEPTED', 'ENDED'].includes(leave.status)) return false;
    remember(leave.effectiveStartsAt, leave.endsAt, leave.endedAt);
    for (const assignment of leave.assignments) if (assignment.patientId === snapshot.patientId) remember(assignment.startsAt, assignment.endsAt);
    return !!leave.effectiveStartsAt && active(leave.effectiveStartsAt, leave.endsAt, now) &&
      (!leave.endedAt || now < instant(leave.endedAt));
  });
  const absentUsers = new Set(currentLeaves.map(leave => leave.fromUserId));
  const leaveActors = new Set<string>();
  for (const sourceId of [...primary]) {
    const source = actors.get(sourceId)!;
    const leaves = currentLeaves.filter(leave => leave.fromUserId === source.userId);
    if (!leaves.length) continue;
    // A failed recipient never makes the absent source silently responsible again.
    primary.delete(sourceId); leaveActors.add(sourceId);
    if (leaves.length !== 1) { errors.add('LEAVE_CONFLICT'); continue; }
    const leave = leaves[0]!;
    const assignments = leave.assignments.filter(item => item.patientId === snapshot.patientId && item.fromActorId === sourceId && active(item.startsAt, item.endsAt, now));
    if (assignments.length !== 1 || !activeMembers.some(member => member.actorId === sourceId && member.role === 'PRIMARY' && assignments[0]!.sourceMembershipIds.includes(member.id))) {
      errors.add('LEAVE_SCOPE_CHANGED'); continue;
    }
    const target = actors.get(assignments[0]!.toActorId);
    if (!target || target.userId !== leave.toUserId || target.userId === source.userId || absentUsers.has(target.userId) || !isCarePhysician(snapshot, target.id, at)) {
      errors.add('LEAVE_TARGET_UNAVAILABLE'); continue;
    }
    primary.add(target.id); leaveActors.add(target.id); addRole(target.id, 'PRIMARY');
  }
  const covers = snapshot.covers.filter((cover) => cover.patientId === snapshot.patientId && cover.status !== 'CANCELLED');
  for (const cover of covers) remember(cover.startsAt, cover.endsAt);
  // 替班按同一份原始团队快照计算；不能让遍历先后把另一位请假者重新选回。
  const confirmedCovers = covers.filter((cover) => {
    if (cover.status === 'CONFIRMED' && active(cover.startsAt, cover.endsAt, now) &&
      (leaveActors.has(cover.fromActorId) || leaveActors.has(cover.toActorId) || absentUsers.has(actors.get(cover.toActorId)?.userId ?? ''))) {
      errors.add('COVER_CONFLICT'); return false;
    }
    if (!primary.has(cover.fromActorId) || !active(cover.startsAt, cover.endsAt, now) || cover.status !== 'CONFIRMED') return false;
    const target = actors.get(cover.toActorId);
    if (!target || !isCarePhysician(snapshot, target.id, at)) { errors.add('COVER_TARGET_UNAVAILABLE'); return false; }
    return cover.fromActorId !== cover.toActorId && confirmed(cover, target.userId, now);
  });
  const coveredSources = new Set(confirmedCovers.map((cover) => cover.fromActorId));
  for (const fromId of [...primary]) {
    const targets = sorted(new Set(confirmedCovers.filter((cover) => cover.fromActorId === fromId).map((cover) => cover.toActorId)));
    if (targets.length > 1 || targets.some((id) => coveredSources.has(id))) { errors.add('COVER_CONFLICT'); continue; }
    const targetId = targets[0];
    if (targetId) {
      primary.delete(fromId);
      primary.add(targetId);
      addRole(targetId, 'PRIMARY');
    }
  }
  if (primary.size === 0) errors.add('NO_PRIMARY');
  if (primary.size > 2) errors.add('TOO_MANY_PRIMARY');
  const primaryActorIds = sorted(primary).slice(0, 2);
  const attendingActorIds = sorted(new Set(activeMembers.filter((member) => member.role === 'ATTENDING').map((member) => member.actorId)));
  const clinicians = sorted(roles.keys()).map((actorId): CareClinicianContext => ({
    actorId, userId: actors.get(actorId)!.userId, clinicianInCareTeam: true,
    clinicianOnDuty: duty.has(actorId), clinicianRole: ROLE_ORDER.find((role) => roles.get(actorId)!.has(role))!,
  }));
  return {
    patientId: snapshot.patientId, at: new Date(now).toISOString(), clinicians,
    primaryActorIds, attendingActorIds, onCallActorIds, backupActorIds,
    ...(activeHolidayRosterId ? { activeHolidayRosterId } : {}),
    coverageErrors: sorted(errors), nextReconcileAt: earliest(boundaries),
  };
}

/** 假日表与普通表互斥；表内空班、未确认或坏引用均不能借用普通表。 */
function selectRosterShifts(
  snapshot: CareSnapshot,
  now: number,
  errors: Set<CareCoverageError>,
  remember: (...values: (string | undefined)[]) => void,
): { shifts: CareShift[]; activeHolidayRosterId?: string } {
  const orgUnitId = snapshot.organization?.id;
  if (!orgUnitId) return { shifts: [] };
  const rosters = snapshot.holidayRosters ?? [];
  const byId = new Map<string, CareHolidayRoster[]>();
  for (const roster of rosters) byId.set(roster.id, [...(byId.get(roster.id) ?? []), roster]);
  const valid = (roster: CareHolidayRoster): boolean =>
    typeof roster.id === 'string' && roster.id.length > 0 && byId.get(roster.id)?.length === 1 &&
    Number.isSafeInteger(roster.version) && roster.version > 0 &&
    (roster.status === 'ACTIVE' || roster.status === 'CANCELLED') &&
    Number.isFinite(instant(roster.startsAt)) && instant(roster.endsAt) > instant(roster.startsAt);
  const current: CareHolidayRoster[] = [];
  let invalidActiveRoster = false;
  for (const roster of rosters) {
    if (roster.orgUnitId !== orgUnitId || roster.status === 'CANCELLED') continue;
    remember(roster.startsAt, roster.endsAt);
    if (!valid(roster)) {
      errors.add('HOLIDAY_ROSTER_INVALID');
      invalidActiveRoster = true;
    } else if (active(roster.startsAt, roster.endsAt, now)) current.push(roster);
  }
  if (current.length > 1) errors.add('HOLIDAY_ROSTER_CONFLICT');
  const blocked = invalidActiveRoster || current.length > 1;
  const selected = !blocked && current.length === 1 ? current[0] : undefined;
  const shifts = snapshot.shifts.filter(shift => {
    if (shift.orgUnitId !== orgUnitId || shift.status === 'CANCELLED') return false;
    if (shift.holidayRosterId === undefined) return !blocked && selected === undefined;
    const linked = byId.get(shift.holidayRosterId);
    const roster = linked?.length === 1 ? linked[0] : undefined;
    const startsAt = instant(shift.startsAt), endsAt = instant(shift.endsAt);
    if (!roster || !valid(roster) || roster.orgUnitId !== orgUnitId ||
      !(startsAt >= instant(roster.startsAt) && endsAt <= instant(roster.endsAt) && endsAt > startsAt)) {
      errors.add('HOLIDAY_ROSTER_INVALID');
      return false;
    }
    return !blocked && roster.status === 'ACTIVE' && roster.id === selected?.id;
  });
  return { shifts, ...(selected ? { activeHolidayRosterId: selected.id } : {}) };
}

/** 排班和替班只能委派责任，不能创造医师资格。 */
export function isCarePhysician(snapshot: Pick<CareSnapshot, 'patientId' | 'memberships'>, actorId: string, at: string): boolean {
  const now = requiredInstant(at, '资格判定时间');
  return snapshot.memberships.some(member => member.patientId === snapshot.patientId && member.actorId === actorId &&
    ['PRIMARY', 'ATTENDING', 'CONSULTANT', 'ON_CALL'].includes(member.role) && !member.revokedAt && active(member.activeFrom, member.activeUntil, now));
}

/** 责任升级与临床级别分离；调用方持久化决策，不能用此结果改引擎风险。 */
export function decideAlertRouting(
  alert: CareRoutingAlert,
  responsibility: CareResponsibility | undefined,
  context: ResolvedCareContext,
  policy: Readonly<CareRoutingPolicy>,
  at: string,
): CareRoutingDecision {
  const now = requiredInstant(at, '当前时间');
  if (alert.patientId !== context.patientId || requiredInstant(context.at, '上下文时间') !== now) {
    throw new RangeError('照护上下文必须匹配患者和当前时间');
  }
  const createdAt = requiredInstant(alert.createdAt, '告警创建时间');
  if (createdAt > now) throw new RangeError('告警创建时间不能晚于当前时间');
  const levelStarted = responsibility
    ? responsibility.currentLevel === alert.currentLevel ? requiredInstant(responsibility.levelEnteredAt, '本级进入时间') : now
    : createdAt;
  if (levelStarted > now || levelStarted < createdAt) throw new RangeError('本级进入时间不在告警有效时间范围');
  const levelEnteredAt = new Date(levelStarted).toISOString();
  if (alert.status === 'RESOLVED') {
    return { stage: 'CLOSED', levelEnteredAt, responsibleActorIds: [], ccActorIds: [], coverageErrors: [], reason: 'ALERT_RESOLVED' };
  }
  for (const minutes of [policy.l1ResponseMinutes, policy.l2ResponseMinutes, policy.l3ResponseMinutes]) {
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 525_600) throw new RangeError('响应时限必须是有效正分钟数');
  }
  const minutes = alert.currentLevel === 1 ? policy.l1ResponseMinutes : alert.currentLevel === 2 ? policy.l2ResponseMinutes : policy.l3ResponseMinutes;
  const deadline = levelStarted + minutes * 60_000;
  const expired = now >= deadline;
  const errors = new Set(context.coverageErrors);
  let stage: CareRoutingStage = alert.currentLevel === 3 ? expired ? 'BACKUP' : 'ON_CALL' : alert.currentLevel === 2 && expired ? 'ON_CALL' : 'PRIMARY';
  let reason = stage === 'PRIMARY' ? 'PRIMARY_FIRST' : stage === 'BACKUP' ? 'L3_RESPONSE_TIMEOUT' : alert.currentLevel === 2 ? 'L2_RESPONSE_TIMEOUT' : 'L3_IMMEDIATE';
  let responsibleActorIds: string[];
  let ccActorIds: string[] = stage === 'PRIMARY' ? [] : context.attendingActorIds;
  const manualId = responsibility?.stage === 'MANUAL' && responsibility.currentLevel === alert.currentLevel ? responsibility.manualActorId : undefined;
  const accepted = responsibility?.acceptedAt === undefined ? Number.NaN : instant(responsibility.acceptedAt);
  const manualAccepted = manualId !== undefined && accepted >= levelStarted && accepted <= now;
  const manualValid = manualAccepted && context.clinicians.some((clinician) => clinician.actorId === manualId &&
    clinician.clinicianRole !== 'NURSE' && (alert.currentLevel !== 1 || clinician.clinicianRole !== 'ON_CALL'));
  if (manualAccepted && !manualValid) errors.add('MANUAL_TARGET_UNAVAILABLE');
  if (manualValid && !expired) {
    stage = 'MANUAL';
    reason = 'MANUAL_ACCEPTED';
    responsibleActorIds = [manualId];
    ccActorIds = alert.currentLevel === 3 ? context.attendingActorIds : [];
  } else {
    if (stage === 'ON_CALL' && context.onCallActorIds.length === 0) {
      errors.add('NO_ON_CALL');
      stage = 'BACKUP';
      reason = 'ON_CALL_UNAVAILABLE';
    }
    responsibleActorIds = stage === 'PRIMARY' ? context.primaryActorIds : stage === 'ON_CALL' ? context.onCallActorIds : context.backupActorIds;
    if (stage === 'BACKUP' && responsibleActorIds.length === 0) errors.add('NO_BACKUP');
    if (manualAccepted && !manualValid) reason = 'MANUAL_TARGET_UNAVAILABLE';
  }
  const next = [instant(context.nextReconcileAt), deadline].filter((stamp) => stamp > now);
  return {
    stage, levelEnteredAt, responsibleActorIds: sorted(new Set(responsibleActorIds)),
    ccActorIds: sorted(new Set(ccActorIds.filter((id) => !responsibleActorIds.includes(id)))),
    coverageErrors: sorted(errors), nextReconcileAt: earliest(next),
    respondBy: new Date(deadline).toISOString(), reason,
  };
}

function confirmed(
  value: Pick<CareShift, 'status' | 'version' | 'confirmedVersion' | 'confirmedBy' | 'confirmedAt'> | Pick<CareCover, 'status' | 'version' | 'confirmedVersion' | 'confirmedBy' | 'confirmedAt'>,
  expectedUserId: string,
  now: number,
): boolean {
  return value.status === 'CONFIRMED' && Number.isSafeInteger(value.version) && value.version > 0 &&
    value.confirmedVersion === value.version && value.confirmedBy === expectedUserId && instant(value.confirmedAt) <= now;
}

function active(from: string, until: string | undefined, now: number): boolean {
  return instant(from) <= now && (until === undefined || instant(until) > now);
}

function sorted<T extends string>(values: Iterable<T>): T[] {
  return [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function earliest(values: number[]): string | undefined {
  return values.length ? new Date(Math.min(...values)).toISOString() : undefined;
}

function requiredInstant(value: string, label: string): number {
  const stamp = instant(value);
  if (!Number.isFinite(stamp)) throw new RangeError(`${label}必须是带时区的有效ISO时间`);
  return stamp;
}

/** API 与持久层共用的严格照护时间解析；非法输入抛 RangeError。 */
export function parseCareInstant(value: string): number {
  return requiredInstant(value, '照护时间');
}

/** 拒绝本地时区隐式解析及 JS 自动滚到下月的非法日期。 */
function instant(value: string | undefined): number {
  if (typeof value !== 'string') return Number.NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return Number.NaN;
  const [, rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond, zone] = match;
  const year = Number(rawYear), month = Number(rawMonth), day = Number(rawDay);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = month === 2 ? leap ? 29 : 28 : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (month < 1 || month > 12 || day < 1 || day > monthDays || Number(rawHour) > 23 || Number(rawMinute) > 59 || Number(rawSecond) > 59) return Number.NaN;
  if (zone !== 'Z' && (Number(zone!.slice(1, 3)) > 23 || Number(zone!.slice(4, 6)) > 59)) return Number.NaN;
  return Date.parse(value);
}
