import { describe, expect, it } from 'vitest';
import {
  addEmergencyKitMonths,
  createEmergencyKit,
  evaluateEmergencyKit,
  markEmergencyKitItem,
  markEmergencyKitReprint,
  verifyEmergencyKit,
} from '../src/index.js';

const at = '2026-10-03T12:00:00.000Z';

describe('E-02 急诊包领域规则', () => {
  it('创建时提供三类八项清单，所有条目必须人工准备', () => {
    const kit = createEmergencyKit('patient-demo', 'kit-1', at);
    expect(kit.version).toBe(0);
    expect(kit.items).toHaveLength(8);
    expect(kit.items.map(item => item.type)).toEqual([
      'DOC', 'DOC', 'DOC', 'DOC', 'PHYSICAL', 'PHYSICAL', 'DIGITAL', 'DIGITAL',
    ]);
    expect(kit.items.every(item => item.prepared === false && item.needsReprint === false)).toBe(true);
    expect(evaluateEmergencyKit(kit, at)).toMatchObject({ status: 'NOT_VERIFIED', completedCount: 0, totalCount: 8 });
  });

  it('位置和家庭知情是核对的前置条件，逐项勾选不会自动改变其它项', () => {
    const kit = createEmergencyKit('patient-demo', 'kit-1', at);
    expect(() => verifyEmergencyKit(kit, 'caregiver-1', at)).toThrow(/存放位置/);
    const placed = { ...kit, locationNote: '门边鞋柜第二层', familyInformed: true };
    const checked = markEmergencyKitItem(placed, 'DOC_REFERRAL', true, 'caregiver-1', at);
    expect(checked.items.find(item => item.id === 'DOC_REFERRAL')?.prepared).toBe(true);
    expect(checked.items.find(item => item.id === 'DOC_LABS')?.prepared).toBe(false);
    const verified = verifyEmergencyKit(checked, 'caregiver-1', at);
    expect(verified.lastVerifiedAt).toBe(at);
    expect(verified.verifiedBy).toBe('caregiver-1');
    expect(evaluateEmergencyKit(verified, '2027-01-02T12:00:00.000Z').status).toBe('CURRENT');
    expect(evaluateEmergencyKit(verified, '2027-01-04T12:00:00.000Z').status).toBe('DUE');
  });

  it('逐项需重印独立于准备状态，按日历月计算三个月到期', () => {
    const kit = createEmergencyKit('patient-demo', 'kit-1', '2026-01-31T12:00:00.000Z');
    const placed = { ...kit, locationNote: '门边', familyInformed: true };
    const prepared = markEmergencyKitItem(placed, 'DOC_REFERRAL', true, 'caregiver-1', '2026-01-31T12:00:00.000Z');
    const verified = verifyEmergencyKit(prepared, 'caregiver-1', '2026-01-31T12:00:00.000Z');
    const flagged = markEmergencyKitReprint(verified, 'DOC_REFERRAL', true, 'doctor-1', '2026-02-01T12:00:00.000Z');
    expect(flagged.items.find(item => item.id === 'DOC_REFERRAL')).toMatchObject({ prepared: true, needsReprint: true });
    expect(addEmergencyKitMonths('2026-01-31T12:00:00.000Z', 3)).toBe('2026-04-30T12:00:00.000Z');
    expect(evaluateEmergencyKit(verified, '2026-04-30T12:00:00.000Z').status).toBe('CURRENT');
    expect(evaluateEmergencyKit(verified, '2026-05-01T00:00:00.000Z').status).toBe('DUE');
  });
});
