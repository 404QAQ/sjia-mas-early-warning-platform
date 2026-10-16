import { describe, expect, it } from 'vitest';
import { decideAlertRouting, DEFAULT_CARE_ROUTING_POLICY, resolveCareContext } from '../src/care-routing.js';
import { canViewAlert } from '../src/permissions.js';
import type { CareCover, CareMembership, CareResponsibility, CareShift, CareSnapshot } from '../src/care-routing.js';
import type { Actor, Patient } from '../src/types.js';

const NOW = '2026-10-04T08:00:00.000Z';
const BEFORE = '2026-10-04T07:00:00.000Z';
const END = '2026-10-04T20:00:00.000Z';
const ms = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();
const actor = (id: string, patch: Partial<Actor> = {}): Actor => ({
  id, userId: `user-${id}`, patientId: 'p1', relation: 'CLINICIAN',
  activeFrom: BEFORE, isDormantProxy: false, ...patch,
});
const membership = (id: string, role: CareMembership['role'], patch: Partial<CareMembership> = {}): CareMembership => ({
  id: `member-${id}`, patientId: 'p1', actorId: id, role, activeFrom: BEFORE, version: 1, ...patch,
});
const shift = (id: string, kind: CareShift['kind'], patch: Partial<CareShift> = {}): CareShift => ({
  id: `shift-${id}`, orgUnitId: 'org1', clinicianUserId: `user-${id}`, kind,
  startsAt: NOW, endsAt: END, status: 'CONFIRMED', version: 2,
  confirmedBy: `user-${id}`, confirmedVersion: 2, confirmedAt: BEFORE, ...patch,
});
const cover = (patch: Partial<CareCover> = {}): CareCover => ({
  id: 'cover1', patientId: 'p1', fromActorId: 'primary', toActorId: 'cover',
  startsAt: NOW, endsAt: END, status: 'CONFIRMED', version: 2,
  confirmedBy: 'user-cover', confirmedVersion: 2, confirmedAt: BEFORE, ...patch,
});
const snapshot = (patch: Partial<CareSnapshot> = {}): CareSnapshot => ({
  patientId: 'p1', organization: { id: 'org1', name: '风湿科', timeZone: 'Asia/Shanghai' },
  actors: ['primary', 'attending', 'duty', 'backup', 'cover'].map((id) => actor(id)),
  memberships: [membership('primary', 'PRIMARY'), membership('attending', 'ATTENDING'), membership('cover', 'CONSULTANT'), membership('duty', 'ON_CALL'), membership('backup', 'ON_CALL')],
  shifts: [shift('duty', 'ON_CALL'), shift('backup', 'BACKUP')], covers: [], ...patch,
});
const alert = (level: 1 | 2 | 3, createdAt = NOW) => ({ patientId: 'p1', currentLevel: level, status: 'OPEN' as const, createdAt });
const decide = (level: 1 | 2 | 3, at = NOW, data = snapshot(), responsibility?: CareResponsibility) =>
  decideAlertRouting(alert(level), responsibility, resolveCareContext(data, at), DEFAULT_CARE_ROUTING_POLICY, at);
const patient: Patient = {
  id: 'p1', displayName: '测试患者', birthDate: '2016-01-01', diseaseType: 'sJIA',
  onsetDate: '2024-01-01', onsetAgeMonths: 96, lifeStage: 'CHILD', isLivingAlone: false,
};
const viewAlert = (data: CareSnapshot, actorId: string, level: number, at = NOW) => canViewAlert({
  patient, actor: data.actors.find(item => item.id === actorId)!, now: at,
  ...resolveCareContext(data, at).clinicians.find(item => item.actorId === actorId),
}, level);

describe('当前有效照护、排班与替班', () => {
  it('有效团队和患者所属科室的确认班次产生不同候选集', () => {
    const result = resolveCareContext(snapshot(), NOW);
    expect(result.primaryActorIds).toEqual(['primary']);
    expect(result.attendingActorIds).toEqual(['attending']);
    expect(result.onCallActorIds).toEqual(['duty']);
    expect(result.backupActorIds).toEqual(['backup']);
    expect(result.clinicians.find((item) => item.actorId === 'duty')).toMatchObject({ clinicianRole: 'ON_CALL', clinicianOnDuty: true });
    expect(result.coverageErrors).toEqual([]);
    expect(result.nextReconcileAt).toBe(END);
  });

  it('班次生效窗口为 [start,end)，班末立即撤销临时值班访问', () => {
    expect(resolveCareContext(snapshot(), BEFORE).onCallActorIds).toEqual([]);
    expect(resolveCareContext(snapshot(), NOW).onCallActorIds).toEqual(['duty']);
    const ended = resolveCareContext(snapshot(), END);
    expect(ended.onCallActorIds).toEqual([]);
    expect(ended.clinicians.some((item) => item.actorId === 'duty')).toBe(false);
  });

  it.each([
    { status: 'DRAFT' as const }, { status: 'CANCELLED' as const }, { confirmedVersion: 1 },
    { confirmedBy: 'user-other' }, { confirmedAt: ms(1) }, { orgUnitId: 'org-other' },
  ])('未确认、过期确认、他人确认与跨科室班次不授权：%j', (patch) => {
    expect(resolveCareContext(snapshot({ shifts: [shift('duty', 'ON_CALL', patch)] }), NOW).onCallActorIds).toEqual([]);
  });

  it.each([
    { patientId: 'p2' }, { relation: 'CAREGIVER' as const }, { revokedAt: BEFORE },
    { activeFrom: ms(1) }, { activeUntil: NOW }, { activeFrom: '2026-02-30T00:00:00Z' },
    { activeFrom: '2026-10-03T10:00:00' },
  ])('无效/跨患者Actor不因班次获得权限：%j', (patch) => {
    const data = snapshot();
    data.actors = data.actors.map((item) => item.id === 'duty' ? { ...item, ...patch } : item);
    expect(resolveCareContext(data, NOW).onCallActorIds).toEqual([]);
  });

  it('无效/跨患者/过期成员关系不获得随诊权', () => {
    for (const patch of [{ patientId: 'p2' }, { revokedAt: BEFORE }, { activeUntil: NOW }]) {
      expect(resolveCareContext(snapshot({ memberships: [membership('primary', 'PRIMARY', patch)] }), NOW).primaryActorIds).toEqual([]);
    }
  });

  it('ON_CALL团队身份必须配合当前确认班次，不能获得全天权限', () => {
    const result = resolveCareContext(snapshot({ memberships: [membership('duty', 'ON_CALL')], shifts: [] }), NOW);
    expect(result.clinicians.some((item) => item.actorId === 'duty')).toBe(false);
  });

  it('当前随诊兼值班可看L1，随诊关系到期后只剩值班时立即不可见', () => {
    const data = snapshot();
    data.memberships.push(membership('duty', 'PRIMARY', { id: 'duty-primary', activeUntil: ms(5) }));
    expect(resolveCareContext(data, NOW).clinicians.find(item => item.actorId === 'duty')).toMatchObject({ clinicianRole: 'PRIMARY', clinicianOnDuty: true });
    expect(viewAlert(data, 'duty', 1).allowed).toBe(true);
    expect(resolveCareContext(data, ms(5)).clinicians.find(item => item.actorId === 'duty')?.clinicianRole).toBe('ON_CALL');
    expect(viewAlert(data, 'duty', 1, ms(5)).allowed).toBe(false);
    expect(viewAlert(data, 'duty', 2, ms(5)).allowed).toBe(true);
  });

  it('纯值班经本人确认替班获得PRIMARY可看L1，替班到期即恢复纯值班限制', () => {
    const data = snapshot({ covers: [cover({ toActorId: 'duty', confirmedBy: 'user-duty', endsAt: ms(5) })] });
    expect(resolveCareContext(data, NOW).primaryActorIds).toEqual(['duty']);
    expect(viewAlert(data, 'duty', 1).allowed).toBe(true);
    expect(viewAlert(data, 'duty', 1, ms(5)).allowed).toBe(false);
    expect(viewAlert(data, 'duty', 3, ms(5)).allowed).toBe(true);
  });

  it.each([{ status: 'PENDING' as const }, { confirmedVersion: 1 }, { confirmedBy: 'user-primary' }])('未有效确认的替班不能让纯值班看见L1：%j', (patch) => {
    const data = snapshot({ covers: [cover({ toActorId: 'duty', confirmedBy: 'user-duty', ...patch })] });
    expect(viewAlert(data, 'duty', 1).allowed).toBe(false);
  });

  it.each([{ patientId: 'p2' }, { revokedAt: NOW }, { activeUntil: NOW }])('跨患者、撤权或到期不能借混合角色/替班恢复告警权限：%j', (patch) => {
    const data = snapshot({ covers: [cover({ toActorId: 'duty', confirmedBy: 'user-duty' })] });
    data.memberships.push(membership('duty', 'PRIMARY', { id: 'duty-primary' }));
    data.actors = data.actors.map(item => item.id === 'duty' ? { ...item, ...patch } : item);
    expect(viewAlert(data, 'duty', 1).allowed).toBe(false);
    expect(viewAlert(data, 'duty', 3).allowed).toBe(false);
  });

  it.each(['NURSE', 'NONE', 'REVOKED', 'EXPIRED'] as const)('确认班次不为缺失医师资格者创建值班责任：%s', (caseName) => {
    const data = snapshot();
    data.memberships = data.memberships.filter(member => !['duty', 'backup'].includes(member.actorId));
    for (const id of ['duty', 'backup']) if (caseName !== 'NONE') data.memberships.push(membership(id, caseName === 'NURSE' ? 'NURSE' : 'ON_CALL', caseName === 'REVOKED' ? { revokedAt: NOW } : caseName === 'EXPIRED' ? { activeUntil: NOW } : {}));
    const result = resolveCareContext(data, NOW);
    expect(result.onCallActorIds).toEqual([]);
    expect(result.backupActorIds).toEqual([]);
    expect(result.clinicians.some(member => member.clinicianOnDuty)).toBe(false);
    expect(decide(3, NOW, data).responsibleActorIds).toEqual([]);
    expect(decide(3, NOW, data).coverageErrors).toContain('NO_BACKUP');
  });

  it('临时替班确认后替代原随诊，结束时恢复原随诊', () => {
    const data = snapshot({ covers: [cover()] });
    expect(resolveCareContext(data, NOW).primaryActorIds).toEqual(['cover']);
    expect(resolveCareContext(data, NOW).clinicians.find((item) => item.actorId === 'cover')?.clinicianRole).toBe('PRIMARY');
    expect(resolveCareContext(data, END).primaryActorIds).toEqual(['primary']);
  });

  it.each(['NURSE', 'NONE', 'REVOKED'] as const)('已确认替班不能给护理或缺失医生资格者授予PRIMARY：%s', (caseName) => {
    const data = snapshot({ covers: [cover()] });
    data.memberships = data.memberships.filter(member => member.actorId !== 'cover');
    if (caseName !== 'NONE') data.memberships.push(membership('cover', caseName === 'NURSE' ? 'NURSE' : 'CONSULTANT', caseName === 'REVOKED' ? { revokedAt: NOW } : {}));
    const result = resolveCareContext(data, NOW);
    expect(result.primaryActorIds).toEqual(['primary']);
    expect(result.coverageErrors).toContain('COVER_TARGET_UNAVAILABLE');
    expect(result.clinicians.find(member => member.actorId === 'cover')?.clinicianRole).not.toBe('PRIMARY');
  });

  it.each([{ status: 'PENDING' as const }, { confirmedVersion: 1 }, { confirmedBy: 'user-primary' }, { patientId: 'p2' }])('未确认或越界替班不静默生效：%j', (patch) => {
    expect(resolveCareContext(snapshot({ covers: [cover(patch)] }), NOW).primaryActorIds).toEqual(['primary']);
  });

  it('已撤销替班目标不进入临床候选集', () => {
    const data = snapshot({ covers: [cover()] });
    data.actors = data.actors.map((item) => item.id === 'cover' ? { ...item, revokedAt: BEFORE } : item);
    expect(resolveCareContext(data, NOW).primaryActorIds).toEqual(['primary']);
  });

  it('相互冲突的确认班次显式报错，并按空班执行二线兜底', () => {
    const data = snapshot({ shifts: [shift('duty', 'ON_CALL'), shift('cover', 'ON_CALL'), shift('backup', 'BACKUP')] });
    const context = resolveCareContext(data, NOW);
    expect(context.onCallActorIds).toEqual([]);
    expect(context.coverageErrors).toContain('ON_CALL_CONFLICT');
    expect(decide(3, NOW, data).stage).toBe('BACKUP');
  });

  it('两位随诊稳定排序，不受数据库返回顺序影响', () => {
    const data = snapshot();
    data.memberships.push(membership('cover', 'PRIMARY'));
    const first = resolveCareContext(data, NOW);
    expect(first.primaryActorIds).toEqual(['cover', 'primary']);
    expect(resolveCareContext({ ...data, actors: [...data.actors].reverse(), memberships: [...data.memberships].reverse() }, NOW)).toEqual(first);
  });

  it('替班目标同时正在交给别人代班时显式冲突，结果与成员顺序无关', () => {
    const data = snapshot({ covers: [cover(), cover({ id: 'cover2', fromActorId: 'cover', toActorId: 'attending', confirmedBy: 'user-attending' })] });
    data.memberships.push(membership('cover', 'PRIMARY'));
    const first = resolveCareContext(data, NOW);
    expect(first.coverageErrors).toContain('COVER_CONFLICT');
    expect(first.primaryActorIds).not.toContain('cover');
    expect(resolveCareContext({ ...data, memberships: [...data.memberships].reverse(), covers: [...data.covers].reverse() }, NOW)).toEqual(first);
  });

  it('同一位随诊有两个确认替班时显式冲突，保留原责任候选', () => {
    const result = resolveCareContext(snapshot({ covers: [cover(), cover({ id: 'cover2', toActorId: 'attending', confirmedBy: 'user-attending' })] }), NOW);
    expect(result.primaryActorIds).toEqual(['primary']);
    expect(result.coverageErrors).toContain('COVER_CONFLICT');
  });

  it('未来关系和班次边界产生下一次重新核验时间', () => {
    expect(resolveCareContext(snapshot({ shifts: [shift('duty', 'ON_CALL', { startsAt: ms(5) })] }), NOW).nextReconcileAt).toBe(ms(5));
    expect(resolveCareContext(snapshot({ memberships: [membership('primary', 'PRIMARY', { activeUntil: ms(3) })] }), NOW).nextReconcileAt).toBe(ms(3));
  });
});

describe('责任路由只调整接收责任，不改变临床风险级别', () => {
  it('L1仅随诊，24h响应期限不通知值班', () => {
    expect(decide(1)).toMatchObject({ stage: 'PRIMARY', responsibleActorIds: ['primary'], ccActorIds: [], respondBy: ms(24 * 60) });
  });
  it('无随诊显式异常，不静默给值班承担L1', () => {
    const result = decide(1, NOW, snapshot({ memberships: [] }));
    expect(result.responsibleActorIds).toEqual([]);
    expect(result.coverageErrors).toContain('NO_PRIMARY');
  });
  it('L2两小时内随诊，期限边界转值班并抄送主诊', () => {
    expect(decide(2, ms(119))).toMatchObject({ stage: 'PRIMARY', responsibleActorIds: ['primary'], respondBy: ms(120) });
    expect(decide(2, ms(120))).toMatchObject({ stage: 'ON_CALL', responsibleActorIds: ['duty'], ccActorIds: ['attending'] });
  });
  it('L3立即值班并抄送主诊，30分钟边界转二线', () => {
    expect(decide(3)).toMatchObject({ stage: 'ON_CALL', responsibleActorIds: ['duty'], ccActorIds: ['attending'], respondBy: ms(30) });
    expect(decide(3, ms(30))).toMatchObject({ stage: 'BACKUP', responsibleActorIds: ['backup'], ccActorIds: ['attending'] });
  });
  it('未确认值班立即二线，二线也未确认则显式运维异常', () => {
    const data = snapshot({ shifts: [shift('duty', 'ON_CALL', { status: 'DRAFT' }), shift('backup', 'BACKUP')] });
    expect(decide(3, NOW, data)).toMatchObject({ stage: 'BACKUP', responsibleActorIds: ['backup'] });
    const uncovered = decide(3, NOW, { ...data, shifts: [] });
    expect(uncovered.responsibleActorIds).toEqual([]);
    expect(uncovered.coverageErrors).toContain('NO_ON_CALL');
    expect(uncovered.coverageErrors).toContain('NO_BACKUP');
  });
  it('班次变化不能重置L3响应计时', () => {
    const responsibility: CareResponsibility = { stage: 'ON_CALL', currentLevel: 3, levelEnteredAt: NOW, assignedAt: ms(20), responsibleActorIds: ['duty'], ccActorIds: ['attending'] };
    expect(decide(3, ms(30), snapshot(), responsibility)).toMatchObject({ stage: 'BACKUP', respondBy: ms(30) });
  });
  it('临床级别改变重新开始本级计时，不用旧告警创建时间直接越级', () => {
    const responsibility: CareResponsibility = { stage: 'PRIMARY', currentLevel: 1, levelEnteredAt: NOW, assignedAt: NOW, responsibleActorIds: ['primary'], ccActorIds: [] };
    expect(decide(3, ms(120), snapshot(), responsibility)).toMatchObject({ stage: 'ON_CALL', respondBy: ms(150) });
  });
  it('手工转交接受后有效目标继续负责，但不豁免原SLA', () => {
    const responsibility: CareResponsibility = { stage: 'MANUAL', currentLevel: 3, levelEnteredAt: NOW, assignedAt: ms(5), acceptedAt: ms(5), manualActorId: 'primary', responsibleActorIds: ['primary'], ccActorIds: [] };
    expect(decide(3, ms(10), snapshot(), responsibility)).toMatchObject({ stage: 'MANUAL', responsibleActorIds: ['primary'], respondBy: ms(30) });
    expect(decide(3, ms(30), snapshot(), responsibility).stage).toBe('BACKUP');
  });
  it('手工目标离岗后重新自动路由，留下异常原因', () => {
    const responsibility: CareResponsibility = { stage: 'MANUAL', currentLevel: 2, levelEnteredAt: NOW, assignedAt: NOW, acceptedAt: NOW, manualActorId: 'duty', responsibleActorIds: ['duty'], ccActorIds: [] };
    const result = decide(2, ms(10), snapshot({ shifts: [] }), responsibility);
    expect(result.stage).toBe('PRIMARY');
    expect(result.coverageErrors).toContain('MANUAL_TARGET_UNAVAILABLE');
  });
  it.each(['duty', 'backup'])('既有L1手工责任不能继续交给纯值班%s，恢复随诊且不延长原SLA', (manualActorId) => {
    const responsibility: CareResponsibility = { stage: 'MANUAL', currentLevel: 1, levelEnteredAt: NOW, assignedAt: ms(5), acceptedAt: ms(5), manualActorId, responsibleActorIds: [manualActorId], ccActorIds: [] };
    const result = decide(1, ms(10), snapshot(), responsibility);
    expect(result).toMatchObject({ stage: 'PRIMARY', responsibleActorIds: ['primary'], ccActorIds: [], levelEnteredAt: NOW, respondBy: ms(1440), reason: 'MANUAL_TARGET_UNAVAILABLE' });
    expect(result.coverageErrors).toContain('MANUAL_TARGET_UNAVAILABLE');
  });
  it('L1手工目标当前兼随诊或确认替班时有效，身份到期后恢复原随诊且不重置SLA', () => {
    const responsibility: CareResponsibility = { stage: 'MANUAL', currentLevel: 1, levelEnteredAt: NOW, assignedAt: NOW, acceptedAt: NOW, manualActorId: 'duty', responsibleActorIds: ['duty'], ccActorIds: [] };
    const mixed = snapshot();
    mixed.memberships.push(membership('duty', 'PRIMARY', { id: 'duty-primary', activeUntil: ms(5) }));
    const covered = snapshot({ covers: [cover({ toActorId: 'duty', confirmedBy: 'user-duty', endsAt: ms(5) })] });
    for (const data of [mixed, covered]) {
      expect(decide(1, NOW, data, responsibility)).toMatchObject({ stage: 'MANUAL', responsibleActorIds: ['duty'], respondBy: ms(1440) });
      expect(decide(1, ms(5), data, responsibility)).toMatchObject({ stage: 'PRIMARY', responsibleActorIds: ['primary'], levelEnteredAt: NOW, respondBy: ms(1440), reason: 'MANUAL_TARGET_UNAVAILABLE' });
    }
  });
  it.each([2, 3] as const)('纯值班仍能接受L%s手工责任', (level) => {
    const responsibility: CareResponsibility = { stage: 'MANUAL', currentLevel: level, levelEnteredAt: NOW, assignedAt: NOW, acceptedAt: NOW, manualActorId: 'duty', responsibleActorIds: ['duty'], ccActorIds: [] };
    expect(decide(level, NOW, snapshot(), responsibility)).toMatchObject({ stage: 'MANUAL', responsibleActorIds: ['duty'] });
  });
  it('未接受或旧临床级别的转交不取代自动路由', () => {
    const responsibility: CareResponsibility = { stage: 'MANUAL', currentLevel: 2, levelEnteredAt: NOW, assignedAt: NOW, manualActorId: 'attending', responsibleActorIds: ['attending'], ccActorIds: [] };
    expect(decide(2, NOW, snapshot(), responsibility).stage).toBe('PRIMARY');
    expect(decide(3, NOW, snapshot(), { ...responsibility, acceptedAt: NOW }).stage).toBe('ON_CALL');
  });
  it('关闭告警不分配新责任、不保留计时任务', () => {
    const result = decideAlertRouting({ ...alert(3), status: 'RESOLVED' }, undefined, resolveCareContext(snapshot(), NOW), DEFAULT_CARE_ROUTING_POLICY, NOW);
    expect(result).toMatchObject({ stage: 'CLOSED', responsibleActorIds: [], ccActorIds: [] });
    expect(result.respondBy).toBeUndefined();
    expect(result.nextReconcileAt).toBeUndefined();
  });
  it('拒绝跨患者context和不带时区的当前时间', () => {
    expect(() => decideAlertRouting({ ...alert(3), patientId: 'p2' }, undefined, resolveCareContext(snapshot(), NOW), DEFAULT_CARE_ROUTING_POLICY, NOW)).toThrow();
    expect(() => resolveCareContext(snapshot(), '2026-10-04T08:00:00')).toThrow();
  });
  it('拒绝过时上下文及无效响应策略', () => {
    const context = resolveCareContext(snapshot(), NOW);
    expect(() => decideAlertRouting(alert(3), undefined, context, DEFAULT_CARE_ROUTING_POLICY, ms(1))).toThrow();
    expect(() => decideAlertRouting(alert(3), undefined, context, { ...DEFAULT_CARE_ROUTING_POLICY, l3ResponseMinutes: 0 }, NOW)).toThrow();
  });
  it('等价带时区时间得到相同责任决策', () => {
    expect(decide(3, '2026-10-04T16:00:00+08:00')).toEqual(decide(3, NOW));
  });
  it('下一次核验是下一班界或尚未经过的响应期限，避免过去时间忙循环', () => {
    expect(decide(3).nextReconcileAt).toBe(ms(30));
    expect(decide(3, ms(30)).nextReconcileAt).toBe(END);
  });
});
