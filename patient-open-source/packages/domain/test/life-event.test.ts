import { describe, expect, it } from 'vitest';
import { isLifeEvent } from '../src/life-event.js';

const base = {
  id: 'event-1', patientId: 'patient-1', type: 'RELOCATION', fromRegion: '上海市', toRegion: '杭州市',
  initiatedAt: '2026-10-03T12:00:00.000Z', status: 'DRAFT', tags: ['NO_ALERT'],
  findDoctor: { status: 'NOT_STARTED', updatedAt: '2026-10-03T12:00:00.000Z' },
  referralSummary: { status: 'NOT_STARTED', updatedAt: '2026-10-03T12:00:00.000Z' },
  emergencyReset: { status: 'NOT_STARTED', updatedAt: '2026-10-03T12:00:00.000Z' },
  version: 1, createdAt: '2026-10-03T12:00:00.000Z', updatedAt: '2026-10-03T12:00:00.000Z',
};

describe('L-05 life event domain contract', () => {
  it('accepts the initial three-task relocation skeleton', () => {
    expect(isLifeEvent(base)).toBe(true);
  });

  it('rejects extra fields and inconsistent task/overall states', () => {
    expect(isLifeEvent({ ...base, unexpected: true })).toBe(false);
    expect(isLifeEvent({ ...base, findDoctor: { status: 'COMPLETED', startedAt: base.initiatedAt, completedAt: base.initiatedAt, updatedAt: base.initiatedAt } })).toBe(false);
    expect(isLifeEvent({ ...base, status: 'COMPLETED', completedAt: base.initiatedAt })).toBe(false);
  });

  it('requires the fixed referral summary fields when present', () => {
    const content = { diagnosis: 'sJIA', course: '病程', current_meds: '用药', taper_plan: '减量', allergies: '无', key_trends_6m: '趋势', mas_history: '无', personal_baseline_note: '基线' };
    expect(isLifeEvent({ ...base, status: 'IN_PROGRESS', findDoctor: { status: 'IN_PROGRESS', startedAt: base.initiatedAt, updatedAt: base.initiatedAt }, referralSummary: { status: 'IN_PROGRESS', startedAt: base.initiatedAt, updatedAt: base.initiatedAt, generatedAt: base.initiatedAt, content } })).toBe(true);
    expect(isLifeEvent({ ...base, status: 'IN_PROGRESS', findDoctor: { status: 'IN_PROGRESS', startedAt: base.initiatedAt, updatedAt: base.initiatedAt }, referralSummary: { status: 'IN_PROGRESS', startedAt: base.initiatedAt, updatedAt: base.initiatedAt, content: { ...content, unknown: 'x' } } })).toBe(false);
  });

  it('requires clinician confirmation evidence for a completed referral summary', () => {
    const content = { diagnosis: 'sJIA', course: '病程', current_meds: '用药', taper_plan: '减量', allergies: '无', key_trends_6m: '趋势', mas_history: '无', personal_baseline_note: '基线' };
    const completed = { status: 'COMPLETED' as const, startedAt: base.initiatedAt, completedAt: base.updatedAt, generatedAt: base.updatedAt, confirmedBy: 'doctor-1', confirmedAt: base.updatedAt, docRef: 'doc-1', content, updatedAt: base.updatedAt };
    expect(isLifeEvent({ ...base, status: 'IN_PROGRESS', findDoctor: { status: 'IN_PROGRESS', startedAt: base.initiatedAt, updatedAt: base.updatedAt }, referralSummary: completed })).toBe(true);
    expect(isLifeEvent({ ...base, status: 'IN_PROGRESS', findDoctor: { status: 'IN_PROGRESS', startedAt: base.initiatedAt, updatedAt: base.updatedAt }, referralSummary: { ...completed, docRef: undefined } })).toBe(false);
  });

  it('rejects empty references on completed relocation tasks', () => {
    const completedFind = { status: 'COMPLETED' as const, startedAt: base.initiatedAt, completedAt: base.updatedAt, updatedAt: base.updatedAt, doctorReference: '新城市风湿科' };
    const completedReferral = { status: 'IN_PROGRESS' as const, startedAt: base.initiatedAt, updatedAt: base.updatedAt };
    const completedEmergency = { status: 'COMPLETED' as const, startedAt: base.initiatedAt, completedAt: base.updatedAt, updatedAt: base.updatedAt, emergencyPlanRef: 'plan-1', contactReferences: ['contact-1'] };
    expect(isLifeEvent({ ...base, status: 'IN_PROGRESS', findDoctor: completedFind, referralSummary: completedReferral, emergencyReset: { ...completedEmergency, contactReferences: [''] } })).toBe(false);
    expect(isLifeEvent({ ...base, status: 'IN_PROGRESS', findDoctor: { ...completedFind, doctorReference: '' }, referralSummary: completedReferral, emergencyReset: completedEmergency })).toBe(false);
  });
});
