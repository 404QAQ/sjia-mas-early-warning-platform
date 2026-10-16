import { describe, expect, it } from 'vitest';
import { isIntervention, isInterventionResponse } from '../src/intervention.js';

const now = '2026-10-07T00:00:00.000Z';
const intervention = {
  id: 'intervention-1', patientId: 'patient-1', type: 'STEROID_PULSE', detail: { drug: 'methylprednisolone', dose: '30mg/kg', route: 'IV', durationDays: 3 },
  startedAt: now, recordedBy: 'doctor-1', recordedAt: now, followUpDue: [24, 48], version: 1,
} as const;

describe('F-18 intervention domain contract', () => {
  it('accepts an implemented intervention fact with fixed follow-up points', () => {
    expect(isIntervention(intervention)).toBe(true);
  });

  it('accepts objective before/after measurements and rejects judgement fields', () => {
    const response = { id: 'response-1', patientId: 'patient-1', interventionId: 'intervention-1', atHours: 24, observedAt: now, recordedAt: now, recordedBy: 'doctor-1', measurements: { ferritin: { before: 3400, after: 2100, unit: 'ng/mL' } }, interventionVersion: 2, idempotencyKey: 'response-key-1' };
    expect(isInterventionResponse(response)).toBe(true);
    expect(isInterventionResponse({ ...response, autoJudgement: '反应良好' })).toBe(false);
  });

  it('rejects unknown metrics, zero measurements and invalid CAS versions', () => {
    const response = { id: 'response-1', patientId: 'patient-1', interventionId: 'intervention-1', atHours: 24, observedAt: now, recordedAt: now, recordedBy: 'doctor-1', measurements: { ferritin: { before: 3400, after: 2100 } }, interventionVersion: 2, idempotencyKey: 'response-key-1' };
    expect(isInterventionResponse({ ...response, measurements: {} })).toBe(false);
    expect(isInterventionResponse({ ...response, measurements: { unknown: { before: 1, after: 2 } } })).toBe(false);
    expect(isInterventionResponse({ ...response, interventionVersion: 1 })).toBe(false);
    expect(isIntervention({ ...intervention, startedAt: '2026-10-07T10:00:00' })).toBe(false);
    expect(isIntervention({ ...intervention, startedAt: '2026-02-30T10:00:00.000Z' })).toBe(false);
    expect(isInterventionResponse({ ...response, observedAt: '2026-10-07T10:00:00' })).toBe(false);
  });
});
