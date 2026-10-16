import { describe, expect, it } from 'vitest';
import type { CareLeave, CareLeaveAssignment, CareLeaveEvent } from '../src/care-leave.js';
import { mergePatientCareIntervals, patientCareLeaveNoticeDrafts } from '../src/patient-care.js';

const at = (hour: number) => `2026-10-05T${String(hour).padStart(2, '0')}:00:00.000Z`;
const interval = (start: number, end: number) => ({ startsAt: at(start), endsAt: at(end) });
const assignment = (patientId: string, start: number, end: number, suffix = ''): CareLeaveAssignment => ({
  patientId, fromActorId: `from-${patientId}${suffix}`, toActorId: `to-${patientId}${suffix}`,
  ...interval(start, end), sourceMembershipIds: [`membership-${patientId}${suffix}`],
});
const leave = (extra: Partial<CareLeave> = {}): CareLeave => ({
  id: 'leave-1', orgUnitId: 'org-1', fromUserId: 'doctor-1', toUserId: 'doctor-2',
  ...interval(2, 14), reason: '不得向患者公开的原因', scopeFingerprint: 'private-fingerprint',
  assignments: [assignment('p1', 2, 14)], requestedBy: { actorId: 'scheduler', userId: 'scheduler-user' },
  requestedAt: at(0), status: 'ACCEPTED', version: 2, acceptedAt: at(4), effectiveStartsAt: at(4),
  resolvedAt: at(4), resolvedBy: { actorId: 'to-p1', userId: 'doctor-2' }, ...extra,
});
const event = (extra: Partial<CareLeaveEvent> = {}): CareLeaveEvent => ({
  id: 'event-accepted', leaveId: 'leave-1', orgUnitId: 'org-1', type: 'ACCEPTED', version: 2,
  at: at(4), actorId: 'to-p1', userId: 'doctor-2', reason: '不得向患者公开的确认说明', ...extra,
});

describe('患者照护区间', () => {
  it('重叠与相邻区间归并，保留真实间隙并裁剪到指定窗口', () => {
    const input = [interval(9, 12), interval(2, 5), interval(4, 7), interval(7, 8), interval(2, 5)];
    expect(mergePatientCareIntervals(input, interval(4, 11))).toEqual([interval(4, 8), interval(9, 11)]);
  });

  it('采用左闭右开区间，边界相接的裁剪不产生零长段', () => {
    expect(mergePatientCareIntervals([interval(2, 4), interval(8, 10)], interval(4, 8))).toEqual([]);
    expect(mergePatientCareIntervals([interval(2, 4)], interval(4, 4))).toEqual([]);
    expect(mergePatientCareIntervals([])).toEqual([]);
  });

  it('按绝对时间处理跨午夜、等价时区和夏令时回拨，不按文本排序', () => {
    const result = mergePatientCareIntervals([
      { startsAt: '2026-11-01T01:30:00-05:00', endsAt: '2026-11-01T02:00:00-05:00' },
      { startsAt: '2026-10-31T23:30:00-04:00', endsAt: '2026-11-01T01:30:00-04:00' },
      { startsAt: '2026-11-01T05:30:00Z', endsAt: '2026-11-01T01:30:00-05:00' },
    ]);
    expect(result).toEqual([{ startsAt: '2026-11-01T03:30:00.000Z', endsAt: '2026-11-01T07:00:00.000Z' }]);
  });

  it.each([
    '2026-10-05T01:00:00', '2026-02-30T01:00:00Z', '2026-10-05T24:00:00Z',
    '2026-10-05T01:00:60Z', '2026-10-05T01:00:00.0001Z', '2026-10-05T01:00:00+24:00',
  ])('拒绝非法或隐式时区：%s', invalid => {
    expect(() => mergePatientCareIntervals([{ startsAt: invalid, endsAt: at(4) }])).toThrow(RangeError);
  });

  it('拒绝零长/倒序源区间与倒序裁剪窗口，即使该段位于裁剪外', () => {
    expect(() => mergePatientCareIntervals([interval(4, 4)])).toThrow(RangeError);
    expect(() => mergePatientCareIntervals([interval(8, 4)], interval(10, 12))).toThrow(RangeError);
    expect(() => mergePatientCareIntervals([], interval(8, 4))).toThrow(RangeError);
  });

  it('不修改输入，每次返回新的确定性结果', () => {
    const input = [interval(4, 8), interval(2, 5)];
    const original = structuredClone(input), result = mergePatientCareIntervals(input);
    result[0]!.startsAt = at(0);
    expect(input).toEqual(original);
    expect(mergePatientCareIntervals(input)).toEqual([interval(2, 8)]);
  });
});

describe('015 请假患者级变更记录', () => {
  it('按患者去重、多 Actor 归并，并稳定排序而不填满中间空档', () => {
    const source = leave({ assignments: [assignment('p2', 2, 14), assignment('p1', 2, 6),
      assignment('p1', 5, 8, '-other'), assignment('p1', 8, 9), assignment('p1', 11, 14)] });
    const drafts = patientCareLeaveNoticeDrafts(source, event());
    expect(drafts.map(item => item.patientId)).toEqual(['p1', 'p2']);
    expect(drafts[0]!.plannedIntervals).toEqual([interval(4, 9), interval(11, 14)]);
    expect(drafts[0]!.effectiveIntervals).toEqual(drafts[0]!.plannedIntervals);
    expect(drafts[1]!.plannedIntervals).toEqual([interval(4, 14)]);
  });

  it('只保留该患者的安全白名单，不返回原因、Actor、成员或整个 manifest', () => {
    const draft = patientCareLeaveNoticeDrafts(leave(), event())[0]!;
    expect(draft).toEqual({ patientId: 'p1', orgUnitId: 'org-1',
      source: { kind: 'CARE_LEAVE', id: 'leave-1', eventId: 'event-accepted', eventType: 'ACCEPTED', version: 2, at: at(4) },
      fromUserId: 'doctor-1', toUserId: 'doctor-2', acceptedAt: at(4), effectiveStartsAt: at(4), endsAt: at(14),
      plannedIntervals: [interval(4, 14)], effectiveIntervals: [interval(4, 14)],
    });
    expect(JSON.stringify(draft)).not.toMatch(/reason|Actor|membership|fingerprint|assignments/);
  });

  it('未来确认保留安排开始时刻，不追溯到确认时刻；不使用现在时推定已接替', () => {
    const source = leave({ acceptedAt: at(1), effectiveStartsAt: at(2), resolvedAt: at(1) });
    const draft = patientCareLeaveNoticeDrafts(source, event({ at: at(1) }))[0]!;
    expect(draft.source.at).toBe(at(1));
    expect(draft.effectiveStartsAt).toBe(at(2));
    expect(draft.plannedIntervals).toEqual([interval(2, 14)]);
    expect(Object.keys(draft)).not.toContain('isActive');
  });

  it('结束仅截短有效时间交集，原计划不变；患者实际开始可以晚于全单开始', () => {
    const source = leave({ status: 'ENDED', version: 3, endedAt: at(10), resolvedAt: at(10),
      assignments: [assignment('p1', 2, 8), assignment('p1', 11, 14), assignment('p2', 11, 14)] });
    const drafts = patientCareLeaveNoticeDrafts(source, event({ id: 'event-ended', type: 'ENDED', version: 3, at: at(10) }));
    expect(drafts[0]!.plannedIntervals).toEqual([interval(4, 8), interval(11, 14)]);
    expect(drafts[0]!.effectiveIntervals).toEqual([interval(4, 8)]);
    expect(drafts[1]!.plannedIntervals).toEqual([interval(11, 14)]);
    expect(drafts[1]!.effectiveIntervals).toEqual([]);
    expect(drafts.every(item => item.endedAt === at(10))).toBe(true);
  });

  it('未来安排在生效前结束，仍有一条历史结束记录，有效区间为空', () => {
    const source = leave({ status: 'ENDED', version: 3, acceptedAt: at(0), effectiveStartsAt: at(2), endedAt: at(1), resolvedAt: at(1) });
    const drafts = patientCareLeaveNoticeDrafts(source, event({ type: 'ENDED', version: 3, at: at(1) }));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.plannedIntervals).toEqual([interval(2, 14)]);
    expect(drafts[0]!.effectiveIntervals).toEqual([]);
  });

  it('ENDED 晚于原截止不扩张任何区间', () => {
    const source = leave({ status: 'ENDED', version: 3, endedAt: at(16), resolvedAt: at(16) });
    const draft = patientCareLeaveNoticeDrafts(source, event({ type: 'ENDED', version: 3, at: at(16) }))[0]!;
    expect(draft.effectiveIntervals).toEqual([interval(4, 14)]);
  });

  it('用已结束单重建原 ACCEPTED，不把后来的结束事实写进历史确认', () => {
    const original = leave(), ended = { ...original, status: 'ENDED' as const, version: 3, endedAt: at(6), resolvedAt: at(6) };
    expect(patientCareLeaveNoticeDrafts(ended, event())).toEqual(patientCareLeaveNoticeDrafts(original, event()));
    expect(patientCareLeaveNoticeDrafts(ended, event())[0]).not.toHaveProperty('endedAt');
  });

  it('患者 assignment 全部早于确认时刻也保留空安排记录，不生成虚假照护区间', () => {
    const drafts = patientCareLeaveNoticeDrafts(leave({ assignments: [assignment('p1', 2, 3)] }), event());
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.plannedIntervals).toEqual([]);
    expect(drafts[0]!.effectiveIntervals).toEqual([]);
  });

  it.each(['REQUESTED', 'DECLINED', 'CANCELLED'] as const)('%s 不是本切片的患者变更源', type => {
    expect(patientCareLeaveNoticeDrafts(leave(), event({ type }))).toEqual([]);
  });

  it.each([
    { leaveId: 'other' }, { orgUnitId: 'other' }, { version: 3 }, { at: at(5) },
  ])('拒绝与请假确认事实不匹配的事件：%j', change => {
    expect(() => patientCareLeaveNoticeDrafts(leave(), event(change))).toThrow(RangeError);
  });

  it('拒绝不完整、倒序或状态错误的确认事实，不能静默漏发', () => {
    for (const change of [{ acceptedAt: undefined }, { effectiveStartsAt: undefined }, { acceptedAt: at(15) },
      { effectiveStartsAt: at(2) }, { status: 'PENDING' as const }, { version: 1 }]) {
      expect(() => patientCareLeaveNoticeDrafts(leave(change), event())).toThrow(RangeError);
    }
  });

  it('ENDED 必须匹配结束状态、版本、时刻，且不能早于确认', () => {
    const ended = leave({ status: 'ENDED', version: 3, endedAt: at(6), resolvedAt: at(6) });
    const endedEvent = event({ type: 'ENDED', version: 3, at: at(6) });
    for (const change of [{ endedAt: undefined }, { endedAt: at(3) }, { status: 'ACCEPTED' as const }, { version: 2 }]) {
      expect(() => patientCareLeaveNoticeDrafts({ ...ended, ...change }, endedEvent)).toThrow(RangeError);
    }
    expect(() => patientCareLeaveNoticeDrafts(ended, { ...endedEvent, at: at(7) })).toThrow(RangeError);
    expect(() => patientCareLeaveNoticeDrafts(ended, { ...endedEvent, version: 2 })).toThrow(RangeError);
  });

  it('不修改源事实或共享输出数组，打乱 manifest 顺序仍得到相同结果', () => {
    const source = leave({ assignments: [assignment('p2', 2, 14), assignment('p1', 5, 8), assignment('p1', 2, 6)] });
    const original = structuredClone(source), occurrence = event(), originalEvent = structuredClone(occurrence);
    const first = patientCareLeaveNoticeDrafts(source, occurrence);
    expect(patientCareLeaveNoticeDrafts({ ...source, assignments: [...source.assignments].reverse() }, occurrence)).toEqual(first);
    first[0]!.effectiveIntervals[0]!.startsAt = at(0);
    expect(first[0]!.plannedIntervals).toEqual([interval(4, 8)]);
    expect(source).toEqual(original);
    expect(occurrence).toEqual(originalEvent);
  });
});
