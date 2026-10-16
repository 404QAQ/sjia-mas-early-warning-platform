import { describe, expect, it } from 'vitest';
import { decideAlertRouting, DEFAULT_CARE_ROUTING_POLICY, resolveCareContext, type CareSnapshot } from '../src/care-routing.js';
import type { CareLeaveProjection } from '../src/care-leave.js';

const start = '2026-10-05T00:00:00.000Z', accepted = '2026-10-05T00:02:00.000Z', end = '2026-10-05T08:00:00.000Z';
const leave: CareLeaveProjection = { id: 'leave', orgUnitId: 'org', fromUserId: 'ua', toUserId: 'ub',
  startsAt: start, endsAt: end, effectiveStartsAt: accepted, status: 'ACCEPTED',
  assignments: [{ patientId: 'p', fromActorId: 'a', toActorId: 'b', startsAt: start, endsAt: end, sourceMembershipIds: ['ma'] }] };
const snapshot = (): CareSnapshot & { leaves: CareLeaveProjection[] } => ({ patientId: 'p', organization: { id: 'org', name: '测试', timeZone: 'Asia/Shanghai' },
  actors: ['a', 'b'].map(id => ({ id, userId: `u${id}`, patientId: 'p', relation: 'CLINICIAN', activeFrom: start, isDormantProxy: false })),
  memberships: ['a', 'b'].map(id => ({ id: `m${id}`, patientId: 'p', actorId: id, role: id === 'a' ? 'PRIMARY' : 'ON_CALL', activeFrom: start, version: 1 })),
  shifts: [], covers: [], leaves: [structuredClone(leave)] });

describe('整单请假投影', () => {
  it('接受前不生效，实际开始切换责任并授予已有医师临时PRIMARY，到期恢复', () => {
    const data = snapshot();
    expect(resolveCareContext(data, start).primaryActorIds).toEqual(['a']);
    const effective = resolveCareContext(data, accepted);
    expect(effective.primaryActorIds).toEqual(['b']);
    expect(effective.clinicians.find(item => item.actorId === 'b')?.clinicianRole).toBe('PRIMARY');
    expect(effective.nextReconcileAt).toBe(end);
    expect(resolveCareContext(data, end).primaryActorIds).toEqual(['a']);
  });
  it('无资格接班人不得把责任退给请假源，需暴露缺口', () => {
    const data = snapshot(); data.actors[1]!.revokedAt = accepted;
    const result = resolveCareContext(data, accepted);
    expect(result.primaryActorIds).toEqual([]);
    expect(result.coverageErrors).toEqual(expect.arrayContaining(['LEAVE_TARGET_UNAVAILABLE', 'NO_PRIMARY']));
  });
  it('提前结束不抹去原有效窗口，并忽略别科/别患者的manifest', () => {
    const data = snapshot(), endedAt = '2026-10-05T00:10:00.000Z';
    data.leaves[0] = { ...data.leaves[0]!, status: 'ENDED', endedAt };
    expect(resolveCareContext(data, accepted).primaryActorIds).toEqual(['b']);
    expect(resolveCareContext(data, endedAt).primaryActorIds).toEqual(['a']);
    data.leaves[0]!.orgUnitId = 'other';
    expect(resolveCareContext(data, accepted).primaryActorIds).toEqual(['a']);
  });
  it('新membership不借旧确认扩权；撤销的源职责不因请假复活', () => {
    const data = snapshot(); data.memberships[0]!.id = 'new-primary';
    const result = resolveCareContext(data, accepted);
    expect(result.primaryActorIds).toEqual([]);
    expect(result.coverageErrors).toContain('LEAVE_SCOPE_CHANGED');
    data.memberships[0]!.revokedAt = accepted;
    expect(resolveCareContext(data, accepted).primaryActorIds).toEqual([]);
  });
  it('L1责任变化保持已开始响应时钟', () => {
    const result = decideAlertRouting({ patientId: 'p', currentLevel: 1, createdAt: start, status: 'OPEN' },
      { stage: 'PRIMARY', currentLevel: 1, levelEnteredAt: start, assignedAt: start, responsibleActorIds: ['a'], ccActorIds: [], respondBy: '2026-10-06T00:00:00.000Z' },
      resolveCareContext(snapshot(), accepted), DEFAULT_CARE_ROUTING_POLICY, accepted);
    expect(result.responsibleActorIds).toEqual(['b']);
    expect(result.levelEnteredAt).toBe(start);
    expect(result.respondBy).toBe('2026-10-06T00:00:00.000Z');
  });
});
