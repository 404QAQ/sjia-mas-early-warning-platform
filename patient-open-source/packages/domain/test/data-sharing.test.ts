import { describe, expect, it } from 'vitest';
import { isDataSharingOrgLink, isDataSharingScope, normalizeDataSharingScopes } from '../src/index.js';

describe('O-04 跨院逐项共享边界', () => {
  it('默认关闭心理筛查并永久关闭情绪日记', () => {
    expect(normalizeDataSharingScopes({ observations: true, medications: true, alerts: true })).toEqual({
      observations: true, medications: true, alerts: true, psychScreening: false, moodDiary: false, lifeInfo: false,
    });
    expect(() => normalizeDataSharingScopes({ moodDiary: true })).toThrow(/情绪日记/);
  });

  it('拒绝 scope 中的额外字段和非法布尔值，避免管理员绕过固定白名单', () => {
    expect(() => normalizeDataSharingScopes({ observations: 'yes' })).toThrow(/布尔值/);
    expect(() => normalizeDataSharingScopes({ moodDiary: 'false' })).toThrow(/情绪日记/);
    expect(() => normalizeDataSharingScopes({ observations: true, arbitrary: true })).toThrow(/未支持/);
    expect(isDataSharingScope({ patientId: 'p1', fromOrgId: 'a', toOrgId: 'b', scopes: { observations: true, medications: false, alerts: false, psychScreening: false, moodDiary: false, lifeInfo: false }, status: 'ACTIVE', version: 1, requestedAt: '2026-10-08T00:00:00Z', requestedBy: 'doctor', patientConfirmedAt: '2026-10-08T00:00:00Z', patientConfirmedBy: 'patient', lastChangedAt: '2026-10-08T00:00:00Z', lastChangedBy: 'patient' })).toBe(true);
    expect(isDataSharingScope({ patientId: 'p1', fromOrgId: 'a', toOrgId: 'b', scopes: { observations: true, medications: false, alerts: false, psychScreening: false, moodDiary: true, lifeInfo: false }, status: 'ACTIVE', version: 1, requestedAt: '2026-10-08T00:00:00Z', requestedBy: 'doctor', lastChangedAt: '2026-10-08T00:00:00Z', lastChangedBy: 'doctor' })).toBe(false);
    expect(isDataSharingScope({ patientId: 'p1', fromOrgId: 'a', toOrgId: 'b', scopes: { observations: true, medications: false, alerts: false, psychScreening: false, moodDiary: false, lifeInfo: false }, status: 'ACTIVE', version: 1, requestedAt: '2026-10-08T00:00:00Z', requestedBy: 'doctor', lastChangedAt: '2026-10-08T00:00:00Z', lastChangedBy: 'doctor' })).toBe(false);
  });

  it('机构终止必须带时间，活动关系不能携带终止时间', () => {
    expect(isDataSharingOrgLink({ fromOrgId: 'a', toOrgId: 'b', agreementRef: 'agr', status: 'TERMINATED', establishedAt: '2026-10-08T00:00:00Z', version: 1 })).toBe(false);
  });
});
