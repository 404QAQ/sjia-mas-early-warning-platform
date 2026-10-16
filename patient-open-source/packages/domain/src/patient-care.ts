import type { CareLeave, CareLeaveEvent } from './care-leave.js';
import { parseCareInstant, type CareCoverageError, type CareOrganization } from './care-routing.js';
import type { ActorRelation } from './types.js';

/** 左闭右开的绝对时间区间；输出统一为 UTC ISO。 */
export interface PatientCareInterval {
  startsAt: string;
  endsAt: string;
}

export interface PatientCareClinician {
  userId: string;
  /** 可信配置名；无姓名来源时明确显示“医师编号”，不得把 Actor ID 当姓名。 */
  label: string;
}

/** 当前授权后，从权威 careContext 裁剪；历史 notice 不能用于构造此摘要。 */
export interface PatientCareSummary {
  patientId: string;
  asOf: string;
  revision: number;
  organization?: CareOrganization;
  primary: PatientCareClinician[];
  attending: PatientCareClinician[];
  consultants: PatientCareClinician[];
  onCall: PatientCareClinician[];
  backup: PatientCareClinician[];
  /** 当前权威成员能力，不从主诊人数或历史消息推断。 */
  capabilities: { canMessageCareTeam: boolean; hasTreatmentClinician: boolean };
  coverageErrors: CareCoverageError[];
  nextReconcileAt?: string;
}

export interface PatientCareNoticeDraft {
  patientId: string;
  orgUnitId: string;
  source: {
    kind: 'CARE_LEAVE';
    id: string;
    eventId: string;
    eventType: 'ACCEPTED' | 'ENDED';
    version: 2 | 3;
    at: string;
  };
  fromUserId: string;
  toUserId: string;
  acceptedAt: string;
  effectiveStartsAt: string;
  endsAt: string;
  endedAt?: string;
  /** 此患者原确认安排的时间交集，保留真实间隙。 */
  plannedIntervals: PatientCareInterval[];
  /** ENDED 再受 endedAt 裁剪；只证明时间安排，不证明资格始终有效或实际履责。 */
  effectiveIntervals: PatientCareInterval[];
}

/** 每个源事件、每名患者仅一条事实，不按 Actor 扇出。 */
export interface PatientCareNotice extends PatientCareNoticeDraft {
  id: string;
  createdAt: string;
}

/** 内部首次已阅事实，唯一键为 (noticeId, userId)。 */
export interface PatientCareNoticeRead {
  noticeId: string;
  patientId: string;
  userId: string;
  firstActorId: string;
  relationAtRead: ActorRelation;
  readAt: string;
}

/** 患者响应只带当前登录用户本人的首次身份、关系和时刻。 */
export type PatientCareNoticeReadView = Pick<PatientCareNoticeRead, 'firstActorId' | 'relationAtRead' | 'readAt'>;
export interface PatientCareNoticeRecord {
  notice: PatientCareNotice;
  read: PatientCareNoticeReadView | null;
}

export interface PatientCareNoticePage {
  patientId: string;
  asOf: string;
  revision: number;
  records: PatientCareNoticeRecord[];
  nextCursor?: string;
}

type NumericInterval = { start: number; end: number };

/** 严格验证全部源段，再裁剪、排序、归并；不会把区间之间的空档扩成照护安排。 */
export function mergePatientCareIntervals(
  intervals: readonly PatientCareInterval[], clip?: PatientCareInterval,
): PatientCareInterval[] {
  const window = clip === undefined ? undefined : numericInterval(clip, true);
  const selected: NumericInterval[] = [];
  for (const interval of intervals) {
    const value = numericInterval(interval, false);
    const start = Math.max(value.start, window?.start ?? -Infinity);
    const end = Math.min(value.end, window?.end ?? Infinity);
    if (start < end) selected.push({ start, end });
  }
  selected.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: NumericInterval[] = [];
  for (const interval of selected) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged.map(({ start, end }) => ({ startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() }));
}

/**
 * 从 015 已确认的冻结 manifest 一次分组，生成患者级安全快照。
 * ACCEPTED 可从后来的 ENDED 单重建，但不得把 endedAt 混入原确认事实。
 * 无当前时间参数：这份历史事实不判断“现在已接替”，也不授予查看或照护资格。
 */
export function patientCareLeaveNoticeDrafts(leave: CareLeave, event: CareLeaveEvent): PatientCareNoticeDraft[] {
  if (event.type !== 'ACCEPTED' && event.type !== 'ENDED') return [];
  const timing = noticeTiming(leave, event);
  const byPatient = new Map<string, PatientCareInterval[]>();
  for (const assignment of leave.assignments) {
    if (!assignment.patientId) invalidNotice();
    const intervals = byPatient.get(assignment.patientId) ?? [];
    intervals.push({ startsAt: assignment.startsAt, endsAt: assignment.endsAt });
    byPatient.set(assignment.patientId, intervals);
  }
  const drafts: PatientCareNoticeDraft[] = [];
  for (const patientId of [...byPatient.keys()].sort()) {
    const plannedIntervals = mergePatientCareIntervals(byPatient.get(patientId)!, {
      startsAt: leave.effectiveStartsAt!, endsAt: leave.endsAt,
    });
    const effectiveIntervals = timing.end <= timing.start ? [] : mergePatientCareIntervals(plannedIntervals, {
      startsAt: leave.effectiveStartsAt!, endsAt: new Date(timing.end).toISOString(),
    });
    drafts.push({
      patientId, orgUnitId: leave.orgUnitId,
      source: { kind: 'CARE_LEAVE', id: leave.id, eventId: event.id, eventType: event.type,
        version: event.type === 'ACCEPTED' ? 2 : 3, at: event.at },
      fromUserId: leave.fromUserId, toUserId: leave.toUserId,
      acceptedAt: leave.acceptedAt!, effectiveStartsAt: leave.effectiveStartsAt!, endsAt: leave.endsAt,
      ...(event.type === 'ENDED' ? { endedAt: leave.endedAt! } : {}),
      plannedIntervals, effectiveIntervals,
    });
  }
  return drafts;
}

function noticeTiming(leave: CareLeave, event: CareLeaveEvent): NumericInterval {
  if (event.leaveId !== leave.id || event.orgUnitId !== leave.orgUnitId
    || !['ACCEPTED', 'ENDED'].includes(leave.status)
    || leave.version !== (leave.status === 'ENDED' ? 3 : 2)
    || !leave.acceptedAt || !leave.effectiveStartsAt) invalidNotice();
  const original = numericInterval(leave, false);
  const accepted = parseCareInstant(leave.acceptedAt!);
  const start = parseCareInstant(leave.effectiveStartsAt!);
  const occurred = parseCareInstant(event.at);
  if (accepted >= original.end || start !== Math.max(original.start, accepted)) invalidNotice();
  if (event.type === 'ACCEPTED') {
    if (event.version !== 2 || occurred !== accepted) invalidNotice();
    return { start, end: original.end };
  }
  if (leave.status !== 'ENDED' || event.version !== 3 || !leave.endedAt) invalidNotice();
  const ended = parseCareInstant(leave.endedAt!);
  if (occurred !== ended || ended < accepted) invalidNotice();
  return { start, end: Math.min(original.end, ended) };
}

function numericInterval(interval: PatientCareInterval, allowEmpty: boolean): NumericInterval {
  const start = parseCareInstant(interval.startsAt), end = parseCareInstant(interval.endsAt);
  if (allowEmpty ? start > end : start >= end) throw new RangeError('患者照护时间区间无效');
  return { start, end };
}

function invalidNotice(): never {
  throw new RangeError('患者照护变更与请假源事件不一致');
}
