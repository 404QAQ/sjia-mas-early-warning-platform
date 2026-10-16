import { describe, expect, it } from 'vitest';
import { createEmergencyKit, saveEmergencyKitDraft } from '../src/emergency-kit.js';
import { confirmEmergencyPlan, createEmergencyPlan, saveEmergencyPlanDraft, submitEmergencyPlan } from '../src/emergency-plan.js';
import { createEmergencyCard, emergencyCardTextRows, evaluateEmergencyCard, markEmergencyCardReprint, renderEmergencyCardSvg } from '../src/emergency-card.js';

const T0 = '2026-10-05T02:00:00.000Z';
const T1 = '2026-10-05T02:01:00.000Z';

function sources() {
  let plan = createEmergencyPlan('patient-1', 'plan-1', T0);
  plan = saveEmergencyPlanDraft(plan, {
    step: 4,
    locationKey: 'city-a',
    caregiver: {
      primaryHospital: { name: '合作医院', address: '急诊路 1 号', nightEntrance: '东门急诊', nightCapable: 'TRUE' },
      route: { minutesNight: 18, minutesDay: 30, notes: '沿环城路直行' },
      transport: { primary: 'DRIVE', backup: '120', driverName: '家长' },
    },
  }, 'caregiver-1', T0);
  plan = submitEmergencyPlan(plan, T0, 'caregiver-1');
  plan = confirmEmergencyPlan(plan, 'clinician-1', { nightCapable: 'TRUE', triageScript: 'sJIA，有 MAS 风险，正在发热', followUpClinicianPhone: '13800000001', onCallContact: { label: '值班医师（今晚）', phone: '医院总机转' } }, T1);
  let kit = createEmergencyKit('patient-1', 'kit-1', T0);
  kit = saveEmergencyKitDraft(kit, { locationNote: '门边鞋柜第二层', familyInformed: true }, 'caregiver-1', T1);
  return { plan, kit };
}

describe('EmergencyCard', () => {
  it('从已确认 E-01 与 E-02 生成不可变快照并渲染 SVG', () => {
    const { plan, kit } = sources();
    const card = createEmergencyCard(plan, kit, 'card-1', 'caregiver-1', T1);
    expect(card.planVersion).toBe(plan.version);
    expect(card.kitVersion).toBe(kit.version);
    expect(card.destination.hospitalName).toBe('合作医院');
    expect(card.destination.triageScript).toContain('MAS');
    expect(card.destination.followUpClinicianPhone).toBe('13800000001');
    expect(card.destination.onCallContact).toEqual({ label: '值班医师（今晚）', phone: '医院总机转' });
    expect(card.thresholds).toHaveLength(4);
    expect(card.neverDo).toContain('不要自行停激素');
    expect(card.canDo).toContain('少量多次补水');
    expect(card.printHints).toMatchObject({ size: 'A4', orientation: 'PORTRAIT', monochrome: true });
    expect(renderEmergencyCardSvg(card)).toContain('<svg');
    expect(renderEmergencyCardSvg(card)).toContain('绝对不要做');
    expect(emergencyCardTextRows(card).join('\n')).toContain('□ 抽搐 / 意识不清 / 叫不醒');
    expect(emergencyCardTextRows(card).join('\n')).toContain('随诊医师电话：13800000001');
    expect(emergencyCardTextRows(card).join('\n')).toContain('值班医师（今晚）：医院总机转');
  });

  it('对账源版本后标记重印，且人工标记有审计事件', () => {
    const { plan, kit } = sources();
    const card = createEmergencyCard(plan, kit, 'card-1', 'caregiver-1', T1);
    expect(evaluateEmergencyCard(card, plan.version + 1, kit.version)).toMatchObject({ needsReprint: true, reprintReason: 'PLAN_UPDATED', planChanged: true, kitChanged: false });
    const marked = markEmergencyCardReprint(card, 'MANUAL', 'clinician-1', T1);
    expect(marked.needsReprint).toBe(true);
    expect(marked.reprintReason).toBe('MANUAL');
    expect(marked.version).toBe(card.version + 1);
    expect(marked.history.at(-1)?.type).toBe('REPRINT_MARKED');
  });

  it('拒绝未确认预案、缺少存放位置和跨患者来源', () => {
    const { plan, kit } = sources();
    expect(() => createEmergencyCard({ ...plan, status: 'DRAFT', clinician: {} }, kit, 'card-1', 'a', T1)).toThrow();
    expect(() => createEmergencyCard({ ...plan, clinician: { ...plan.clinician, nightCapable: 'UNKNOWN' } }, kit, 'card-1', 'a', T1)).toThrow(/夜间/);
    expect(() => createEmergencyCard(plan, { ...kit, locationNote: undefined }, 'card-1', 'a', T1)).toThrow();
    expect(() => createEmergencyCard(plan, { ...kit, patientId: 'patient-2' }, 'card-1', 'a', T1)).toThrow();
  });
});
