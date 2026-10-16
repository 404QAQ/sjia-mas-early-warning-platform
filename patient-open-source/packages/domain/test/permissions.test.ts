import { describe, expect, it, vi } from 'vitest';
import { ACTIONS, ageDisplay, ageInYears, can, canViewAlert, deriveLifeStage, transitionMilestones } from '../src/permissions.js';
import type { CanContext } from '../src/permissions.js';
import type { Actor, Patient } from '../src/types.js';

const NOW = '2026-06-12T10:00:00+08:00';

function patient(over: Partial<Patient> = {}): Patient {
  return {
    id: 'p1',
    displayName: '张小某',
    birthDate: '2020-03-01',
    diseaseType: 'sJIA',
    onsetDate: '2024-03-01',
    onsetAgeMonths: 48,
    lifeStage: 'CHILD',
    isLivingAlone: false,
    ...over,
  };
}

function actor(over: Partial<Actor> = {}): Actor {
  return {
    id: 'a1',
    userId: 'u1',
    patientId: 'p1',
    relation: 'LEGAL_GUARDIAN',
    activeFrom: '2024-01-01T00:00:00+08:00',
    isDormantProxy: false,
    ...over,
  };
}

describe('五层权限规则', () => {
  it('监护人在儿童期可记录、可管理联系人，不可修改诊疗计划', () => {
    const ctx = { patient: patient(), actor: actor(), now: NOW };
    expect(can(ACTIONS.RECORD_OBSERVATION, ctx).allowed).toBe(true);
    expect(can(ACTIONS.MANAGE_CONTACTS, ctx).allowed).toBe(true);
    expect(can(ACTIONS.MODIFY_TREATMENT_PLAN, ctx).allowed).toBe(false);
  });

  it('照护者（祖父母/保姆）可记录可查看，不可管理联系人', () => {
    const ctx = { patient: patient(), actor: actor({ relation: 'CAREGIVER' }), now: NOW };
    expect(can(ACTIONS.RECORD_OBSERVATION, ctx).allowed).toBe(true);
    expect(can(ACTIONS.VIEW_CLINICAL, ctx).allowed).toBe(true);
    expect(can(ACTIONS.MANAGE_CONTACTS, ctx).allowed).toBe(false);
  });

  it('儿童期的患儿本人只能走受限子集，且看不到「管理联系人」', () => {
    const ctx = { patient: patient(), actor: actor({ relation: 'SELF' }), now: NOW };
    expect(can(ACTIONS.RECORD_OBSERVATION, ctx).allowed).toBe(true);
    expect(can(ACTIONS.MANAGE_CONTACTS, ctx).allowed).toBe(false);
    expect(can(ACTIONS.VIEW_AUDIT_SELF, ctx).allowed).toBe(false);
  });

  it('个人空间：家长与医生都不可见', () => {
    const guardian = can(ACTIONS.VIEW_PRIVATE_SPACE, { patient: patient(), actor: actor(), now: NOW });
    expect(guardian.allowed).toBe(false);
    expect(guardian.layers.visible).toBe(false);
    const clinician = can(ACTIONS.VIEW_PRIVATE_SPACE, {
      patient: patient(),
      actor: actor({ relation: 'CLINICIAN' }),
      now: NOW,
      clinicianInCareTeam: true,
    });
    expect(clinician.allowed).toBe(false);
  });

  it('成年患者：家长不再有权限，除非休眠代理权被激活', () => {
    const adult = patient({ lifeStage: 'ADULT', birthDate: '2003-01-01' });
    const dormant = actor({ isDormantProxy: true });
    expect(can(ACTIONS.VIEW_CLINICAL, { patient: adult, actor: dormant, now: NOW }).allowed).toBe(false);
    // 未激活（isDormantProxy 为 false）时同样拒绝
    const notDormant = actor({ isDormantProxy: false });
    expect(can(ACTIONS.VIEW_CLINICAL, { patient: adult, actor: notDormant, now: NOW }).allowed).toBe(false);
    const activated = actor({ isDormantProxy: true, dormantProxyActivatedAt: '2026-06-11T22:00:00+08:00' });
    expect(can(ACTIONS.VIEW_CLINICAL, { patient: adult, actor: activated, now: NOW }).allowed).toBe(true);
  });

  it.each(['LEGAL_GUARDIAN', 'CAREGIVER'] as const)('成年患者的 %s 必须同时具备代理授权与激活记录', (relation) => {
    const adult = patient({ lifeStage: 'ADULT', birthDate: '2003-01-01' });
    const unapproved = actor({ relation, isDormantProxy: false, dormantProxyActivatedAt: '2026-06-11T22:00:00+08:00' });
    expect(can(ACTIONS.VIEW_CLINICAL, { patient: adult, actor: unapproved, now: NOW }).allowed).toBe(false);
    expect(can(ACTIONS.VIEW_CLINICAL, { patient: adult, actor: { ...unapproved, isDormantProxy: true }, now: NOW }).allowed).toBe(true);
  });

  it.each([
    '2026-06-12T10:00:01+08:00',
    'not-a-date',
    '2026-02-30T00:00:00+08:00',
    '2026-06-11T22:00:00',
    '2026-06-11',
  ])('成年休眠代理的激活时间 %s 不可用于授权', (dormantProxyActivatedAt) => {
    const ctx = { patient: patient({ lifeStage: 'ADULT' }), actor: actor({ isDormantProxy: true, dormantProxyActivatedAt }), now: NOW };
    expect(can(ACTIONS.VIEW_CLINICAL, ctx).allowed).toBe(false);
    expect(can(ACTIONS.VIEW_CLINICAL, ctx).layers.lifecycleAllows).toBe(false);
  });

  it('休眠代理在激活时刻生效，同一瞬间的不同偏移表示一致', () => {
    const ctx = { patient: patient({ lifeStage: 'ADULT' }), actor: actor({ isDormantProxy: true, dormantProxyActivatedAt: '2026-06-12T02:00:00Z' }), now: NOW };
    expect(can(ACTIONS.VIEW_CLINICAL, ctx).allowed).toBe(true);
    expect(can(ACTIONS.VIEW_CLINICAL, { ...ctx, now: '2026-06-12T01:59:59.999Z' }).allowed).toBe(false);
  });

  it('关系撤销后一律拒绝', () => {
    const revoked = actor({ revokedAt: '2026-06-01T00:00:00+08:00' });
    const d = can(ACTIONS.VIEW_CLINICAL, { patient: patient(), actor: revoked, now: NOW });
    expect(d.allowed).toBe(false);
    expect(d.layers.notRevoked).toBe(false);
  });

  it('未来生效的关系撤销在边界前仍保持授权，达到边界立即拒绝', () => {
    const actorWithFutureRevocation = actor({ revokedAt: '2026-06-12T02:00:00Z' });
    const patientValue = patient();
    expect(can(ACTIONS.VIEW_CLINICAL, { patient: patientValue, actor: actorWithFutureRevocation, now: '2026-06-12T01:59:59.999Z' }).allowed).toBe(true);
    expect(can(ACTIONS.VIEW_CLINICAL, { patient: patientValue, actor: actorWithFutureRevocation, now: '2026-06-12T02:00:00Z' }).allowed).toBe(false);
  });

  it('关系生效期之外一律拒绝', () => {
    const future = actor({ activeFrom: '2026-07-01T00:00:00+08:00' });
    expect(can(ACTIONS.VIEW_CLINICAL, { patient: patient(), actor: future, now: NOW }).allowed).toBe(false);
    const expired = actor({ activeUntil: '2026-06-01T00:00:00+08:00' });
    expect(can(ACTIONS.VIEW_CLINICAL, { patient: patient(), actor: expired, now: NOW }).allowed).toBe(false);
  });

  it.each([
    ['activeFrom', '2024-02-30T00:00:00+08:00'],
    ['activeFrom', '2025-02-29T00:00:00Z'],
    ['activeFrom', '2024-01-01T00:00:00'],
    ['activeFrom', '2024-01-01'],
    ['activeUntil', '2027-02-29T00:00:00Z'],
    ['activeUntil', '2027-01-01T00:00:00'],
    ['activeUntil', '2027-01-01'],
    ['activeUntil', ''],
    ['now', '2026-02-30T00:00:00+08:00'],
    ['now', '2026-06-12T10:00:00'],
    ['now', '2026-06-12'],
    ['now', '2026-06-12T24:00:00Z'],
    ['now', 'not-a-date'],
  ] as const)('关系时间 %s=%s 不合法时默认拒绝', (field, value) => {
    const ctx = { patient: patient(), actor: actor(field === 'now' ? {} : { [field]: value }), now: field === 'now' ? value : NOW };
    const decision = can(ACTIONS.VIEW_CLINICAL, ctx);
    expect(decision.allowed).toBe(false);
    expect(decision.layers.activeRelation).toBe(false);
  });

  it('关系开始时刻包含、结束时刻排除，接受合法闰日及时间偏移', () => {
    const ctx = { patient: patient(), actor: actor({ activeFrom: '2024-02-29T16:00:00Z', activeUntil: NOW }), now: '2024-03-01T00:00:00+08:00' };
    expect(can(ACTIONS.VIEW_CLINICAL, ctx).allowed).toBe(true);
    expect(can(ACTIONS.VIEW_CLINICAL, { ...ctx, now: NOW }).allowed).toBe(false);
  });

  it('医护：必须在照护团队内；值班只在本班次内可见', () => {
    const clinician = actor({ relation: 'CLINICIAN' });
    expect(
      can(ACTIONS.VIEW_CLINICAL, { patient: patient(), actor: clinician, now: NOW, clinicianInCareTeam: false }).allowed,
    ).toBe(false);
    expect(
      can(ACTIONS.VIEW_CLINICAL, { patient: patient(), actor: clinician, now: NOW, clinicianInCareTeam: true }).allowed,
    ).toBe(true);
    expect(
      can(ACTIONS.VIEW_CLINICAL, {
        patient: patient(),
        actor: clinician,
        now: NOW,
        clinicianInCareTeam: true,
        clinicianRole: 'ON_CALL',
        clinicianOnDuty: false,
      }).allowed,
    ).toBe(false);
    expect(
      can(ACTIONS.VIEW_CLINICAL, {
        patient: patient(),
        actor: clinician,
        now: NOW,
        clinicianInCareTeam: true,
        clinicianRole: 'ON_CALL',
        clinicianOnDuty: true,
      }).allowed,
    ).toBe(true);
  });

  it('只有随诊/主诊/会诊可无条件真关闭告警；值班只能忽略', () => {
    const clinician = actor({ relation: 'CLINICIAN' });
    const base = { patient: patient(), actor: clinician, now: NOW, clinicianInCareTeam: true };
    // 值班医师在班时只能忽略，不能真关闭
    expect(can(ACTIONS.ALERT_IGNORE, { ...base, clinicianRole: 'ON_CALL', clinicianOnDuty: true }).allowed).toBe(true);
    // 值班医师不在班时连忽略都不允许（班次外不可见）
    expect(can(ACTIONS.ALERT_IGNORE, { ...base, clinicianRole: 'ON_CALL', clinicianOnDuty: false }).allowed).toBe(false);
    expect(can(ACTIONS.ALERT_CLOSE, { ...base, clinicianRole: 'ON_CALL', requiresPrimaryRole: true }).allowed).toBe(false);
    expect(can(ACTIONS.ALERT_CLOSE, { ...base, clinicianRole: 'PRIMARY', requiresPrimaryRole: true }).allowed).toBe(true);
    expect(can(ACTIONS.ALERT_CLOSE, { ...base, clinicianRole: 'ATTENDING', requiresPrimaryRole: true }).allowed).toBe(true);
  });

  it.each(['ON_CALL', 'NURSE', undefined] as const)('关闭告警默认拒绝角色 %s，不依赖调用方传额外限制', (clinicianRole) => {
    const ctx = { patient: patient(), actor: actor({ relation: 'CLINICIAN' }), now: NOW, clinicianInCareTeam: true, clinicianOnDuty: true, clinicianRole };
    expect(can(ACTIONS.ALERT_CLOSE, ctx).allowed).toBe(false);
    expect(can(ACTIONS.ALERT_CLOSE, { ...ctx, requiresPrimaryRole: false }).allowed).toBe(false);
  });

  it.each(['PRIMARY', 'ATTENDING', 'CONSULTANT'] as const)('关闭告警允许在照护团队内的 %s', (clinicianRole) => {
    expect(can(ACTIONS.ALERT_CLOSE, { patient: patient(), actor: actor({ relation: 'CLINICIAN' }), now: NOW, clinicianInCareTeam: true, clinicianRole }).allowed).toBe(true);
  });

  it('阈值配置默认拒绝，需显式 CONFIG 授权且保留原有关系限制', () => {
    const ctx = { patient: patient(), actor: actor({ relation: 'CLINICIAN' }), now: NOW, clinicianInCareTeam: true, clinicianRole: 'PRIMARY' as const };
    expect(can(ACTIONS.CONFIG_THRESHOLDS, ctx).allowed).toBe(false);
    expect(can(ACTIONS.CONFIG_THRESHOLDS, { ...ctx, canConfigureThresholds: false }).allowed).toBe(false);
    expect(can(ACTIONS.CONFIG_THRESHOLDS, { ...ctx, canConfigureThresholds: true }).allowed).toBe(true);
    expect(can(ACTIONS.CONFIG_THRESHOLDS, { ...ctx, canConfigureThresholds: true, clinicianInCareTeam: false }).allowed).toBe(false);
    expect(can(ACTIONS.CONFIG_THRESHOLDS, { ...ctx, canConfigureThresholds: true, actor: actor() }).allowed).toBe(false);
  });

  it.each(['NURSE', undefined] as const)('角色 %s 不可修改治疗或激活代理权', (clinicianRole) => {
    const ctx = { patient: patient(), actor: actor({ relation: 'CLINICIAN' }), now: NOW, clinicianInCareTeam: true, clinicianRole };
    expect(can(ACTIONS.MODIFY_TREATMENT_PLAN, ctx).allowed).toBe(false);
    expect(can(ACTIONS.TRIGGER_DORMANT_PROXY, ctx).allowed).toBe(false);
  });

  it.each(['ATTENDING', 'PRIMARY', 'CONSULTANT', 'ON_CALL'] as const)('医生角色 %s 可在有效关系内修改治疗或激活代理权', (clinicianRole) => {
    const ctx = { patient: patient(), actor: actor({ relation: 'CLINICIAN' }), now: NOW, clinicianInCareTeam: true, clinicianOnDuty: true, clinicianRole };
    expect(can(ACTIONS.MODIFY_TREATMENT_PLAN, ctx).allowed).toBe(true);
    expect(can(ACTIONS.TRIGGER_DORMANT_PROXY, ctx).allowed).toBe(true);
    if (clinicianRole === 'ON_CALL') {
      expect(can(ACTIONS.MODIFY_TREATMENT_PLAN, { ...ctx, clinicianOnDuty: false }).allowed).toBe(false);
      expect(can(ACTIONS.TRIGGER_DORMANT_PROXY, { ...ctx, clinicianOnDuty: false }).allowed).toBe(false);
    }
  });

  it('可见颗粒度：G1 达不到 G2 的要求', () => {
    const ctx = {
      patient: patient({ lifeStage: 'ADULT', birthDate: '2003-01-01' }),
      actor: actor({ relation: 'SPOUSE', isDormantProxy: false }),
      now: NOW,
      requiredVisibility: 'G2_SUMMARY' as const,
      contact: { id: 'c1', patientId: 'p1', actorId: 'a1', displayName: '王女士', phoneEncrypted: '', phoneIndex: '', tier: 1 as const, visibility: 'G1_NOTIFY' as const, capabilityTags: [], lastConfirmedAt: NOW },
    };
    expect(can(ACTIONS.VIEW_CLINICAL, ctx).allowed).toBe(false);
    const g2 = { ...ctx, contact: { ...ctx.contact, visibility: 'G2_SUMMARY' as const } };
    expect(can(ACTIONS.VIEW_CLINICAL, g2).allowed).toBe(true);
  });

  it('其他患者的联系人可见级别不能用于授权当前患者', () => {
    const ctx = {
      patient: patient({ lifeStage: 'ADULT' }), actor: actor({ relation: 'SPOUSE' }), now: NOW,
      requiredVisibility: 'G3_FULL' as const,
      contact: { id: 'c-other', patientId: 'p-other', displayName: '另一联系人', phoneEncrypted: '', phoneIndex: '', tier: 1 as const, visibility: 'G3_FULL' as const, capabilityTags: [], lastConfirmedAt: NOW },
    };
    expect(can(ACTIONS.VIEW_CLINICAL, ctx).allowed).toBe(false);
    expect(can(ACTIONS.VIEW_CLINICAL, { ...ctx, requiredVisibility: undefined }).allowed).toBe(false);
  });

  it.each(['another-actor', undefined])('同患者 contact.actorId=%s 不能借给当前操作者授权', (actorId) => {
    const ctx = {
      patient: patient({ lifeStage: 'ADULT' }), actor: actor({ relation: 'SPOUSE' }), now: NOW,
      requiredVisibility: 'G3_FULL' as const,
      contact: { id: 'c1', patientId: 'p1', actorId, displayName: '联系人', phoneEncrypted: '', phoneIndex: '', tier: 1 as const, visibility: 'G3_FULL' as const, capabilityTags: [], lastConfirmedAt: NOW },
    };
    expect(can(ACTIONS.VIEW_CLINICAL, ctx).allowed).toBe(false);
    expect(can(ACTIONS.VIEW_CLINICAL, { ...ctx, requiredVisibility: undefined }).allowed).toBe(false);
    expect(can(ACTIONS.VIEW_CLINICAL, { ...ctx, contact: { ...ctx.contact, actorId: 'a1' } }).allowed).toBe(true);
  });
});

describe('告警可见范围', () => {
  const clinicianContext = (patch: Partial<CanContext> = {}): CanContext => ({
    patient: patient(), actor: actor({ relation: 'CLINICIAN' }), now: NOW,
    clinicianInCareTeam: true, clinicianOnDuty: true, clinicianRole: 'ON_CALL', ...patch,
  });

  it('纯值班可看临床资料，但不能看到L1告警', () => {
    const ctx = clinicianContext();
    expect(can(ACTIONS.VIEW_CLINICAL, ctx).allowed).toBe(true);
    expect(canViewAlert(ctx, 1)).toMatchObject({
      allowed: false, layers: { activeRelation: true, scopeAllows: true, visible: false, lifecycleAllows: true, notRevoked: true },
      reason: '纯值班医师不可查看L1告警',
    });
  });

  it.each([2, 3])('纯值班L%s沿用五层临床权限', (level) => {
    const ctx = clinicianContext();
    expect(canViewAlert(ctx, level)).toEqual(can(ACTIONS.VIEW_CLINICAL, ctx));
    expect(canViewAlert(ctx, level).allowed).toBe(true);
  });

  it.each(['PRIMARY', 'ATTENDING', 'CONSULTANT', 'NURSE'] as const)('当前有效%s身份即使同时在值班也不被当成纯值班', (clinicianRole) => {
    const ctx = clinicianContext({ clinicianRole });
    expect(canViewAlert(ctx, 1)).toEqual(can(ACTIONS.VIEW_CLINICAL, ctx));
    expect(canViewAlert(ctx, 1).allowed).toBe(true);
  });

  it.each([
    { actor: actor({ relation: 'CLINICIAN', revokedAt: NOW }) },
    { actor: actor({ relation: 'CLINICIAN', patientId: 'p2' }) },
    { actor: actor({ relation: 'CLINICIAN', activeUntil: NOW }) },
    { clinicianInCareTeam: false },
    { clinicianOnDuty: false },
  ])('五层临床检查先拒绝，保留原始拒绝原因：%j', (patch) => {
    const ctx = clinicianContext(patch);
    for (const level of [1, 2, 3]) {
      expect(canViewAlert(ctx, level)).toEqual(can(ACTIONS.VIEW_CLINICAL, ctx));
      expect(canViewAlert(ctx, level).allowed).toBe(false);
    }
  });

  it.each(['SELF', 'LEGAL_GUARDIAN', 'CAREGIVER'] as const)('非医护%s沿用原临床权限，不受医护上下文残留影响', (relation) => {
    const ctx = clinicianContext({ actor: actor({ relation }) });
    expect(canViewAlert(ctx, 1)).toEqual(can(ACTIONS.VIEW_CLINICAL, ctx));
    expect(canViewAlert(ctx, 1).allowed).toBe(true);
  });
});

describe('生命阶段与年龄展示', () => {
  it('按生日推导生命阶段', () => {
    expect(deriveLifeStage('2020-03-01', NOW)).toBe('CHILD');
    expect(deriveLifeStage('2011-06-01', NOW)).toBe('TRANSITION');
    expect(deriveLifeStage('2003-01-01', NOW)).toBe('ADULT');
  });

  it('年龄展示为「6岁3月」这种形式', () => {
    expect(ageDisplay('2020-03-01', NOW)).toBe('6岁3月');
    expect(ageDisplay('2004-01-01', NOW)).toBe('22岁5月');
  });

  it('过渡期里程碑按 16/17/17.5/18 岁计算', () => {
    const p = patient({ birthDate: '2008-06-12', lifeStage: 'TRANSITION' });
    const ms = transitionMilestones(p, NOW);
    expect(ms.map((m) => m.atAge)).toEqual([16, 17, 17.5, 18]);
    expect(ms[0]!.reached).toBe(true);   // 18 岁生日当天，全部达成
    expect(ms[3]!.reached).toBe(true);
  });

  it('17.5 岁里程碑在半年生日当天生效', () => {
    const p = patient({ birthDate: '2008-06-12', lifeStage: 'TRANSITION' });
    expect(transitionMilestones(p, '2025-12-11T23:59:59+08:00')[2]!.reached).toBe(false);
    expect(transitionMilestones(p, '2025-12-12T00:00:00+08:00')[2]!.reached).toBe(true);
    expect(transitionMilestones(p, '2025-12-12T00:00:00+08:00')[3]!.reached).toBe(false);
  });

  it('半年生日遇到目标月缺少该日时按月末计算', () => {
    const p = patient({ birthDate: '2008-08-31', lifeStage: 'TRANSITION' });
    expect(transitionMilestones(p, '2026-02-27T23:59:59+08:00')[2]!.reached).toBe(false);
    expect(transitionMilestones(p, '2026-02-28T00:00:00+08:00')[2]!.reached).toBe(true);
  });

  it.each(['UTC', 'America/Los_Angeles', 'Asia/Shanghai'])('生日边界按上海日历计算，不受运行时 %s 时区影响', (timeZone) => {
    vi.stubEnv('TZ', timeZone);
    try {
      const p = patient({ birthDate: '2008-06-12', lifeStage: 'TRANSITION' });
      const before = '2026-06-11T15:59:59Z';
      const atBirthday = '2026-06-11T16:00:00Z';
      expect(ageInYears(p.birthDate, before)).toBe(17);
      expect(ageInYears(p.birthDate, atBirthday)).toBe(18);
      expect(ageDisplay(p.birthDate, atBirthday)).toBe('18岁');
      expect(deriveLifeStage(p.birthDate, before)).toBe('TRANSITION');
      expect(deriveLifeStage(p.birthDate, atBirthday)).toBe('ADULT');
      expect(transitionMilestones(p, atBirthday)[3]!.reached).toBe(true);
      expect(transitionMilestones(p, '2026-06-11T09:00:00-07:00')).toEqual(transitionMilestones(p, atBirthday));
      expect(transitionMilestones(p, '2025-12-11T16:00:00Z')[2]!.reached).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
