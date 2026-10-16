import { describe, expect, it } from 'vitest';
import {
  EMERGENCY_PLAN_FIXED_THRESHOLDS,
  evaluateEmergencyPlanReview,
  emergencyPlanAfterReplan,
  saveEmergencyPlanDraft,
  submitEmergencyPlan,
  confirmEmergencyPlan,
  type EmergencyPlan,
} from '../src/emergency-plan.js';

const base: EmergencyPlan = {
  id: 'plan-1', patientId: 'patient-1', status: 'DRAFT', step: 4,
  caregiver: {
    primaryHospital: { name: '儿童医院', address: '人民路 1 号', nightEntrance: '东门急诊', nightCapable: 'UNKNOWN' },
    route: { minutesNight: 20, minutesDay: 35, notes: '雨天走高架' },
    transport: { primary: 'DRIVE', backup: '120', driverName: '家长', driverPhone: '13800000000' },
    customThresholds: [],
  },
  clinician: {}, decisionThresholds: [...EMERGENCY_PLAN_FIXED_THRESHOLDS], version: 0,
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', history: [],
};

describe('emergency plan domain', () => {
  it('requires an explicit night capability, while UNKNOWN is submit-able', () => {
    expect(submitEmergencyPlan(base, '2026-10-02T00:00:00.000Z').status).toBe('PENDING_CLINICIAN');
    expect(() => submitEmergencyPlan({ ...base, caregiver: { ...base.caregiver, primaryHospital: undefined } }, '2026-10-02T00:00:00.000Z')).toThrow(/夜间/);
  });

  it('confirms with a six-month review date and clinician-only fields', () => {
    const confirmed = confirmEmergencyPlan(submitEmergencyPlan(base, '2026-10-02T00:00:00.000Z'), 'doctor-1', { nightCapable: 'TRUE', triageScript: 'sJIA，有 MAS 风险，正在发热', followUpClinicianPhone: '00000000001', onCallContact: { label: '值班医师（今晚）', phone: '医院总机转' } }, '2026-10-02T00:00:00.000Z');
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.nextReviewAt).toBe('2027-04-02T00:00:00.000Z');
    expect(confirmed.clinician.confirmedBy).toBe('doctor-1');
  });

  it('replan clears hospital and clinician fields but preserves an immutable event', () => {
    const confirmed = confirmEmergencyPlan(submitEmergencyPlan(base, '2026-10-02T00:00:00.000Z'), 'doctor-1', { nightCapable: 'TRUE', triageScript: 'script', followUpClinicianPhone: '00000000001', onCallContact: { label: '值班医师（今晚）', phone: '医院总机转' } }, '2026-10-02T00:00:00.000Z');
    expect(() => emergencyPlanAfterReplan(confirmed, 'city-shanghai-2', 'actor-1', '2027-04-01T23:59:59.000Z')).toThrow(/复核期/);
    const replanned = emergencyPlanAfterReplan(confirmed, 'city-shanghai-2', 'actor-1', '2027-04-02T00:00:00.000Z');
    expect(replanned.status).toBe('DRAFT');
    expect(replanned.step).toBe(1);
    expect(replanned.caregiver.primaryHospital).toBeUndefined();
    expect(replanned.clinician).toEqual({});
    expect(replanned.history.at(-1)?.type).toBe('REPLANNED');
    expect(replanned.history.at(-1)?.changedFields).toEqual(expect.arrayContaining(['caregiver.route', 'caregiver.transport']));
  });

  it('marks a confirmed plan due after six months without mutating the plan', () => {
    const confirmed = confirmEmergencyPlan(submitEmergencyPlan(base, '2026-10-02T00:00:00.000Z'), 'doctor-1', { nightCapable: 'TRUE', triageScript: '审核后的到院话术', followUpClinicianPhone: '00000000001', onCallContact: { label: '值班医师（今晚）', phone: '医院总机转' } }, '2026-10-02T00:00:00.000Z');
    expect(evaluateEmergencyPlanReview(confirmed, '2027-04-02T00:00:00.000Z')).toBe('DUE');
    expect(evaluateEmergencyPlanReview(confirmed, '2027-04-01T23:59:59.000Z')).toBe('CURRENT');
  });

  it('adds six months at the Asia/Shanghai calendar boundary', () => {
    const confirmed = confirmEmergencyPlan(submitEmergencyPlan(base, '2026-09-30T16:30:00.000Z'), 'doctor-1', { nightCapable: 'TRUE', triageScript: '审核后的到院话术', followUpClinicianPhone: '00000000001', onCallContact: { label: '值班医师（今晚）', phone: '医院总机转' } }, '2026-09-30T16:30:00.000Z');
    expect(confirmed.nextReviewAt).toBe('2027-03-31T16:30:00.000Z');
  });

  it('rejects missing caregiver or clinician objects instead of treating them as empty', () => {
    expect(() => submitEmergencyPlan({ ...base, caregiver: undefined as never }, '2026-10-02T00:00:00.000Z')).toThrow(/患者填写/);
    expect(() => submitEmergencyPlan({ ...base, clinician: undefined as never }, '2026-10-02T00:00:00.000Z')).toThrow(/医生确认/);
    expect(() => submitEmergencyPlan({ ...base, caregiver: { ...base.caregiver, primaryHospital: { ...base.caregiver.primaryHospital!, unexpected: '污染' } as never } }, '2026-10-02T00:00:00.000Z')).toThrow(/医院/);
  });

  it('requires a non-empty clinician triage script before confirmation', () => {
    const pending = submitEmergencyPlan(base, '2026-10-02T00:00:00.000Z');
    expect(() => confirmEmergencyPlan(pending, 'doctor-1', { nightCapable: 'TRUE', triageScript: '   ', followUpClinicianPhone: '00000000001', onCallContact: { label: '值班医师（今晚）', phone: '医院总机转' } }, '2026-10-02T00:00:00.000Z')).toThrow(/分诊话术/);
  });

  it('clears clinician review facts when a confirmed caregiver field changes', () => {
    const confirmed = confirmEmergencyPlan(submitEmergencyPlan(base, '2026-10-02T00:00:00.000Z'), 'doctor-1', { nightCapable: 'TRUE', triageScript: '审核后的到院话术', followUpClinicianPhone: '00000000001', onCallContact: { label: '值班医师（今晚）', phone: '医院总机转' } }, '2026-10-02T00:00:00.000Z');
    expect(() => saveEmergencyPlanDraft(confirmed, { step: 4 }, 'caregiver-1', '2026-10-03T00:00:00.000Z')).toThrow(/可保存/);
    expect(() => saveEmergencyPlanDraft(submitEmergencyPlan(base, '2026-10-02T00:00:00.000Z'), { step: 4 }, 'caregiver-1', '2026-10-03T00:00:00.000Z')).toThrow(/待医生确认/);
    const edited = saveEmergencyPlanDraft(confirmed, { step: 4, caregiver: { customThresholds: ['新阈值'] } }, 'caregiver-1', '2026-10-03T00:00:00.000Z');
    expect(edited.status).toBe('DRAFT');
    expect(edited.clinician).toEqual({});
    expect(edited.lastReviewedAt).toBeUndefined();
    expect(edited.nextReviewAt).toBeUndefined();
  });

  it('rejects the 501st history event before making the plan unreadable', () => {
    let plan = base;
    for (let index = 0; index < 500; index += 1) {
      plan = saveEmergencyPlanDraft(plan, { step: 4 }, 'caregiver-1', `2026-10-01T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`);
    }
    expect(plan.version).toBe(500);
    expect(plan.history).toHaveLength(500);
    expect(() => saveEmergencyPlanDraft(plan, { step: 4 }, 'caregiver-1', '2026-10-02T00:00:00.000Z')).toThrow(/历史过长/);
    expect(plan.version).toBe(500);
    expect(plan.history).toHaveLength(500);
  });
});
