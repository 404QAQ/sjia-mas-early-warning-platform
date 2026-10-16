import { describe, expect, it } from 'vitest';
import { decideAlertRouting, DEFAULT_CARE_ROUTING_POLICY, resolveCareContext } from '../src/care-routing.js';
import type { CareHolidayRoster, CareMembership, CareResponsibility, CareShift, CareSnapshot } from '../src/care-routing.js';
import { canViewAlert } from '../src/permissions.js';
import type { Actor, Patient } from '../src/types.js';

const START = '2026-10-04T15:00:00.000Z';
const NOW = '2026-10-04T15:10:00.000Z';
const END = '2026-10-04T18:00:00.000Z';
const BEFORE = '2026-10-04T14:00:00.000Z';
const AFTER = '2026-10-04T22:00:00.000Z';
const roster = (patch: Partial<CareHolidayRoster> = {}): CareHolidayRoster => ({
  id: 'holiday1', orgUnitId: 'org1', label: '独立假日班表', startsAt: START, endsAt: END,
  status: 'ACTIVE', version: 1, ...patch,
});
const actor = (id: string, patch: Partial<Actor> = {}): Actor => ({
  id, userId: `user-${id}`, patientId: 'p1', relation: 'CLINICIAN',
  activeFrom: '2026-01-01T00:00:00Z', isDormantProxy: false, ...patch,
});
const membership = (id: string, role: CareMembership['role'] = 'ON_CALL', patch: Partial<CareMembership> = {}): CareMembership => ({
  id: `member-${id}`, patientId: 'p1', actorId: id, role, activeFrom: '2026-01-01T00:00:00Z', version: 1, ...patch,
});
const shift = (id: string, kind: CareShift['kind'], holidayRosterId?: string, patch: Partial<CareShift> = {}): CareShift => ({
  id: `shift-${id}`, orgUnitId: 'org1', clinicianUserId: `user-${id}`, kind, holidayRosterId,
  startsAt: holidayRosterId ? START : BEFORE, endsAt: holidayRosterId ? END : AFTER,
  status: 'CONFIRMED', version: 1, confirmedVersion: 1,
  confirmedBy: `user-${id}`, confirmedAt: '2026-01-01T00:00:00Z', ...patch,
});
const snapshot = (patch: Partial<CareSnapshot> = {}): CareSnapshot => ({
  patientId: 'p1', organization: { id: 'org1', name: '风湿科', timeZone: 'Asia/Shanghai' },
  actors: ['primary', 'attending', 'ordinary', 'ordinaryBackup', 'holiday', 'holidayBackup', 'cover'].map(id => actor(id)),
  memberships: [membership('primary', 'PRIMARY'), membership('attending', 'ATTENDING'), membership('cover', 'CONSULTANT'),
    ...['ordinary', 'ordinaryBackup', 'holiday', 'holidayBackup'].map(id => membership(id))],
  shifts: [shift('ordinary', 'ON_CALL'), shift('ordinaryBackup', 'BACKUP'), shift('holiday', 'ON_CALL', 'holiday1'), shift('holidayBackup', 'BACKUP', 'holiday1')],
  covers: [], holidayRosters: [roster()], ...patch,
});
const patient: Patient = {
  id: 'p1', displayName: '测试患者', birthDate: '2016-01-01', diseaseType: 'sJIA',
  onsetDate: '2024-01-01', onsetAgeMonths: 96, lifeStage: 'CHILD', isLivingAlone: false,
};
const view = (data: CareSnapshot, actorId: string, level = 3, at = NOW) => canViewAlert({
  patient, actor: data.actors.find(item => item.id === actorId)!, now: at,
  ...resolveCareContext(data, at).clinicians.find(item => item.actorId === actorId),
}, level);
const route = (data: CareSnapshot, level: 1 | 2 | 3 = 3, at = NOW, previous?: CareResponsibility, createdAt = NOW) =>
  decideAlertRouting({ patientId: 'p1', currentLevel: level, status: 'OPEN', createdAt }, previous,
    resolveCareContext(data, at), DEFAULT_CARE_ROUTING_POLICY, at);

describe('独立假日班表的选择与责任路由', () => {
  it('唯一当前假日表屏蔽同时确认的普通表，只使用本表当班和二线', () => {
    const data = snapshot();
    const context = resolveCareContext(data, NOW);
    expect(context).toMatchObject({ activeHolidayRosterId: 'holiday1', onCallActorIds: ['holiday'], backupActorIds: ['holidayBackup'] });
    expect(context.coverageErrors).toEqual([]);
    expect(route(data)).toMatchObject({ stage: 'ON_CALL', responsibleActorIds: ['holiday'], ccActorIds: ['attending'] });
  });

  it('旧快照不提供假日表时保留普通排班行为', () => {
    const data = snapshot({ holidayRosters: undefined, shifts: [shift('ordinary', 'ON_CALL'), shift('ordinaryBackup', 'BACKUP')] });
    const context = resolveCareContext(data, NOW);
    expect(context).toMatchObject({ onCallActorIds: ['ordinary'], backupActorIds: ['ordinaryBackup'] });
    expect(context.activeHolidayRosterId).toBeUndefined();
    expect(context.coverageErrors).toEqual([]);
  });

  it('空假日表即使普通表完整也不回落，L3显式缺岗', () => {
    const data = snapshot({ shifts: [shift('ordinary', 'ON_CALL'), shift('ordinaryBackup', 'BACKUP')] });
    const result = route(data);
    expect(result).toMatchObject({ stage: 'BACKUP', responsibleActorIds: [], ccActorIds: ['attending'] });
    expect(result.coverageErrors).toEqual(expect.arrayContaining(['NO_ON_CALL', 'NO_BACKUP']));
  });

  it.each([{ status: 'DRAFT' as const }, { confirmedVersion: 0 }, { confirmedBy: 'user-ordinary' }, { confirmedAt: END }])('假日当班未有效确认时仅本表二线兜底：%j', (patch) => {
    const data = snapshot();
    data.shifts = data.shifts.map(item => item.id === 'shift-holiday' ? { ...item, ...patch } : item);
    const result = route(data);
    expect(result).toMatchObject({ stage: 'BACKUP', responsibleActorIds: ['holidayBackup'], ccActorIds: ['attending'] });
    expect(result.coverageErrors).toContain('ON_CALL_UNCONFIRMED');
  });

  it('假日当班和二线都未确认时拒绝借用普通表', () => {
    const data = snapshot();
    data.shifts = data.shifts.map(item => item.holidayRosterId ? { ...item, status: 'DRAFT' } : item);
    const result = route(data);
    expect(result.responsibleActorIds).toEqual([]);
    expect(result.coverageErrors).toEqual(expect.arrayContaining(['ON_CALL_UNCONFIRMED', 'BACKUP_UNCONFIRMED', 'NO_ON_CALL', 'NO_BACKUP']));
  });

  it('取消假日表恢复普通表；仍引用取消表的班次不成为普通班', () => {
    const data = snapshot({ holidayRosters: [roster({ status: 'CANCELLED', cancellationReason: '排班调整', version: 2 })] });
    const context = resolveCareContext(data, NOW);
    expect(context).toMatchObject({ onCallActorIds: ['ordinary'], backupActorIds: ['ordinaryBackup'] });
    expect(context.activeHolidayRosterId).toBeUndefined();
    expect(view(data, 'holiday').allowed).toBe(false);
    expect(view(data, 'ordinary').allowed).toBe(true);
  });

  it('L3超时仅转本假日表二线，不回落普通二线', () => {
    const at = '2026-10-04T15:40:00.000Z';
    const data = snapshot();
    expect(route(data, 3, at)).toMatchObject({ stage: 'BACKUP', responsibleActorIds: ['holidayBackup'], respondBy: at });
    data.shifts = data.shifts.filter(item => item.id !== 'shift-holidayBackup');
    expect(route(data, 3, at).responsibleActorIds).toEqual([]);
    expect(route(data, 3, at).coverageErrors).toContain('NO_BACKUP');
  });

  it('重叠假日表令当班与二线均失效，主诊/随诊/确认替班仍按原规则', () => {
    const data = snapshot({ holidayRosters: [roster(), roster({ id: 'holiday2' })], covers: [{
      id: 'cover1', patientId: 'p1', fromActorId: 'primary', toActorId: 'cover', startsAt: BEFORE, endsAt: AFTER,
      status: 'CONFIRMED', version: 1, confirmedVersion: 1, confirmedBy: 'user-cover', confirmedAt: BEFORE,
    }] });
    const context = resolveCareContext(data, NOW);
    expect(context).toMatchObject({ onCallActorIds: [], backupActorIds: [], primaryActorIds: ['cover'], attendingActorIds: ['attending'] });
    expect(context.activeHolidayRosterId).toBeUndefined();
    expect(context.coverageErrors).toContain('HOLIDAY_ROSTER_CONFLICT');
    expect(route(data).responsibleActorIds).toEqual([]);
    expect(route(data, 1)).toMatchObject({ stage: 'PRIMARY', responsibleActorIds: ['cover'] });
    expect(resolveCareContext({ ...data, holidayRosters: [...data.holidayRosters!].reverse(), shifts: [...data.shifts].reverse() }, NOW)).toEqual(context);
  });

  it('不同科室同时生效的假日表不构成本科冲突', () => {
    const data = snapshot({ holidayRosters: [roster(), roster({ id: 'other', orgUnitId: 'org2' })] });
    const context = resolveCareContext(data, NOW);
    expect(context.onCallActorIds).toEqual(['holiday']);
    expect(context.coverageErrors).not.toContain('HOLIDAY_ROSTER_CONFLICT');
  });
});

describe('假日表时间边界与损坏引用', () => {
  it('跨午夜窗口在准确start切入、end恢复普通班，边界进入下一次核验', () => {
    const data = snapshot({ holidayRosters: [roster({ startsAt: '2026-10-04T23:00:00+08:00', endsAt: '2026-10-05T02:00:00+08:00' })] });
    const before = resolveCareContext(data, '2026-10-04T14:59:59.999Z');
    expect(before.onCallActorIds).toEqual(['ordinary']);
    expect(before.nextReconcileAt).toBe(START);
    const atStart = resolveCareContext(data, START);
    expect(atStart.onCallActorIds).toEqual(['holiday']);
    expect(atStart.nextReconcileAt).toBe(END);
    expect(resolveCareContext(data, '2026-10-04T17:59:59.999Z').onCallActorIds).toEqual(['holiday']);
    expect(resolveCareContext(data, END)).toMatchObject({ onCallActorIds: ['ordinary'], backupActorIds: ['ordinaryBackup'], nextReconcileAt: AFTER });
    expect(resolveCareContext(data, END).activeHolidayRosterId).toBeUndefined();
  });

  it('即使未来假日表为空也在表开始/结束边界唤醒，取消表不留下核验任务', () => {
    const data = snapshot({ shifts: [], holidayRosters: [roster()] });
    expect(resolveCareContext(data, BEFORE).nextReconcileAt).toBe(START);
    expect(resolveCareContext(data, NOW).nextReconcileAt).toBe(END);
    expect(resolveCareContext(data, END).nextReconcileAt).toBeUndefined();
    data.holidayRosters = [roster({ status: 'CANCELLED', cancellationReason: '取消', version: 2 })];
    expect(resolveCareContext(data, BEFORE).nextReconcileAt).toBeUndefined();
  });

  it.each([
    { startsAt: '2026-03-08T01:30:00-05:00', endsAt: '2026-03-08T03:30:00-04:00', before: '2026-03-08T06:29:59.999Z', start: '2026-03-08T06:30:00.000Z', inside: '2026-03-08T07:15:00.000Z', end: '2026-03-08T07:30:00.000Z' },
    { startsAt: '2026-11-01T01:30:00-04:00', endsAt: '2026-11-01T01:30:00-05:00', before: '2026-11-01T05:29:59.999Z', start: '2026-11-01T05:30:00.000Z', inside: '2026-11-01T06:15:00.000Z', end: '2026-11-01T06:30:00.000Z' },
  ])('DST区间以显式offset表示真实绝对时间：$startsAt → $endsAt', ({ startsAt, endsAt, before, start, inside, end }) => {
    const data = snapshot({ organization: { id: 'org1', name: '风湿科', timeZone: 'America/New_York' }, holidayRosters: [roster({ startsAt, endsAt })], shifts: [
      shift('ordinary', 'ON_CALL', undefined, { startsAt: '2026-01-01T00:00:00Z', endsAt: '2026-12-01T00:00:00Z' }),
      shift('holiday', 'ON_CALL', 'holiday1', { startsAt, endsAt }),
    ] });
    expect(resolveCareContext(data, before)).toMatchObject({ onCallActorIds: ['ordinary'], nextReconcileAt: start });
    expect(resolveCareContext(data, start)).toMatchObject({ onCallActorIds: ['holiday'], nextReconcileAt: end });
    expect(resolveCareContext(data, inside).onCallActorIds).toEqual(['holiday']);
    expect(resolveCareContext(data, end).onCallActorIds).toEqual(['ordinary']);
  });

  it.each([
    { holidayRosterId: 'missing' }, { holidayRosterId: '' }, { holidayRosterId: 'other-org' },
    { startsAt: BEFORE }, { endsAt: AFTER }, { startsAt: '2026-10-04T15:00:00' },
    { startsAt: '2026-02-30T15:00:00Z' }, { startsAt: END, endsAt: START },
  ])('失联/跨科/越界/非法时间的关联班次不能赋权：%j', (patch) => {
    const data = snapshot({ holidayRosters: [roster(), roster({ id: 'other-org', orgUnitId: 'org2' })], shifts: [
      shift('ordinary', 'ON_CALL'), shift('holiday', 'ON_CALL', 'holiday1', patch),
    ] });
    const context = resolveCareContext(data, NOW);
    expect(context.onCallActorIds).toEqual([]);
    expect(context.coverageErrors).toContain('HOLIDAY_ROSTER_INVALID');
    expect(view(data, 'holiday').allowed).toBe(false);
  });

  it('失联表的班次在无生效表时也不能冒充普通表', () => {
    const data = snapshot({ holidayRosters: [], shifts: [shift('holiday', 'ON_CALL', 'missing')] });
    expect(resolveCareContext(data, NOW).onCallActorIds).toEqual([]);
    expect(resolveCareContext(data, NOW).coverageErrors).toContain('HOLIDAY_ROSTER_INVALID');
  });

  it('其他科室的shift不能借用本科假日表引用授权', () => {
    const data = snapshot({ shifts: [shift('holiday', 'ON_CALL', 'holiday1', { orgUnitId: 'org2' })] });
    expect(resolveCareContext(data, NOW).onCallActorIds).toEqual([]);
    expect(view(data, 'holiday').allowed).toBe(false);
  });

  it.each([
    { startsAt: '2026-10-04T15:00:00' }, { startsAt: '2026-02-30T15:00:00Z' },
    { startsAt: END, endsAt: START }, { endsAt: START }, { version: 0 }, { version: 1.5 },
  ])('同科ACTIVE假日表本身损坏时不能静默启用普通表：%j', (patch) => {
    const data = snapshot({ holidayRosters: [roster(patch)] });
    const context = resolveCareContext(data, NOW);
    expect(context).toMatchObject({ onCallActorIds: [], backupActorIds: [], primaryActorIds: ['primary'] });
    expect(context.coverageErrors).toContain('HOLIDAY_ROSTER_INVALID');
    expect(route(data, 1).responsibleActorIds).toEqual(['primary']);
  });

  it('相同ID重复表不按数组先后任选一个赋权', () => {
    const data = snapshot({ holidayRosters: [roster(), roster({ startsAt: BEFORE })] });
    const context = resolveCareContext(data, NOW);
    expect(context).toMatchObject({ onCallActorIds: [], backupActorIds: [] });
    expect(context.coverageErrors).toContain('HOLIDAY_ROSTER_INVALID');
  });
});

describe('假日切表的权限和SLA', () => {
  it('只有选中表获得临时值班访问，纯值班L1限制仍生效', () => {
    const data = snapshot();
    expect(view(data, 'ordinary').allowed).toBe(false);
    expect(view(data, 'holiday').allowed).toBe(true);
    expect(view(data, 'holiday', 1).allowed).toBe(false);
    expect(view(data, 'ordinary', 3, END).allowed).toBe(true);
    expect(view(data, 'holiday', 3, END).allowed).toBe(false);
  });

  it('普通当班兼随诊或已确认替班时保留相应权限，不能因班表屏蔽一起撤销', () => {
    const mixed = snapshot();
    mixed.memberships.push(membership('ordinary', 'PRIMARY', { id: 'ordinary-primary' }));
    const covered = snapshot({ covers: [{
      id: 'cover1', patientId: 'p1', fromActorId: 'primary', toActorId: 'ordinary', startsAt: BEFORE, endsAt: AFTER,
      status: 'CONFIRMED', version: 1, confirmedVersion: 1, confirmedBy: 'user-ordinary', confirmedAt: BEFORE,
    }] });
    for (const data of [mixed, covered]) {
      expect(resolveCareContext(data, NOW).clinicians.find(item => item.actorId === 'ordinary')).toMatchObject({ clinicianRole: 'PRIMARY', clinicianOnDuty: false });
      expect(view(data, 'ordinary', 1).allowed).toBe(true);
      expect(route(data, 1).responsibleActorIds).toContain('ordinary');
    }
  });

  it.each([{ patientId: 'p2' }, { revokedAt: NOW }, { activeUntil: NOW }])('假日表确认也不能恢复跨患者、撤销或到期的Actor：%j', (patch) => {
    const data = snapshot();
    data.actors = data.actors.map(item => item.id === 'holiday' ? { ...item, ...patch } : item);
    expect(resolveCareContext(data, NOW).onCallActorIds).toEqual([]);
    expect(route(data).responsibleActorIds).toEqual(['holidayBackup']);
    expect(view(data, 'holiday').allowed).toBe(false);
  });

  it('从普通切入假日或取消恢复普通只换责任人，不重启本级SLA', () => {
    const enteredAt = '2026-10-04T14:50:00.000Z';
    const previous: CareResponsibility = { stage: 'ON_CALL', currentLevel: 3, levelEnteredAt: enteredAt, assignedAt: enteredAt, responsibleActorIds: ['ordinary'], ccActorIds: ['attending'] };
    const data = snapshot();
    expect(route(data, 3, NOW, previous, enteredAt)).toMatchObject({ stage: 'ON_CALL', responsibleActorIds: ['holiday'], levelEnteredAt: enteredAt, respondBy: '2026-10-04T15:20:00.000Z' });
    data.holidayRosters = [roster({ status: 'CANCELLED', cancellationReason: '取消', version: 2 })];
    expect(route(data, 3, NOW, { ...previous, responsibleActorIds: ['holiday'] }, enteredAt)).toMatchObject({ stage: 'ON_CALL', responsibleActorIds: ['ordinary'], levelEnteredAt: enteredAt, respondBy: '2026-10-04T15:20:00.000Z' });
  });

  it('假日结束时仍按已过期L3原SLA转普通二线，不重新给普通当班30分钟', () => {
    const previous: CareResponsibility = { stage: 'ON_CALL', currentLevel: 3, levelEnteredAt: NOW, assignedAt: NOW, responsibleActorIds: ['holiday'], ccActorIds: ['attending'] };
    expect(route(snapshot(), 3, END, previous)).toMatchObject({ stage: 'BACKUP', responsibleActorIds: ['ordinaryBackup'], levelEnteredAt: NOW, respondBy: '2026-10-04T15:40:00.000Z' });
  });

  it('被屏蔽普通表的纯值班失去MANUAL资格，恢复假日当班且不延SLA', () => {
    const previous: CareResponsibility = { stage: 'MANUAL', currentLevel: 3, levelEnteredAt: NOW, assignedAt: NOW, acceptedAt: NOW, manualActorId: 'ordinary', responsibleActorIds: ['ordinary'], ccActorIds: [] };
    const result = route(snapshot(), 3, NOW, previous);
    expect(result).toMatchObject({ stage: 'ON_CALL', responsibleActorIds: ['holiday'], levelEnteredAt: NOW, respondBy: '2026-10-04T15:40:00.000Z' });
    expect(result.coverageErrors).toContain('MANUAL_TARGET_UNAVAILABLE');
  });
});
