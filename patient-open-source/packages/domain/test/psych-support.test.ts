import { describe, expect, it } from 'vitest';
import { derivePsychSupport, type PsychScreening } from '../src/index.js';

const base = (overrides: Partial<PsychScreening> = {}): PsychScreening => ({
  id: 'screening-1',
  patientId: 'patient-1',
  visitId: 'visit-1',
  instrument: 'ADULT_SELF',
  questionnaireVersion: 2,
  frequency: 'PER_VISIT',
  respondentRelation: 'SELF',
  submittedAt: '2026-10-01T00:00:00.000Z',
  submittedBy: 'self-1',
  answers: [
    { code: 'SELF_SLEEP', status: 'ANSWERED', valueCoded: 'SOMETIMES' },
    { code: 'SELF_ENERGY', status: 'ANSWERED', valueCoded: 'NEVER' },
    { code: 'SELF_LOW_MOOD', status: 'ANSWERED', valueCoded: 'NEVER' },
    { code: 'SELF_DAILY', status: 'ANSWERED', valueCoded: 'NEVER' },
    { code: 'SELF_HOPELESS', status: 'ANSWERED', valueCoded: 'NEVER' },
    { code: 'SELF_HARM', status: 'ANSWERED', valueCoded: 'NEVER' },
  ],
  crisisItemCodes: [],
  prescreenWindow: { trigger: 'PRE_VISIT', visitId: 'visit-1' },
  visibleTo: ['CLINICIAN'],
  idempotencyKey: 'idempotency-1',
  requestFingerprint: 'a'.repeat(64),
  ...overrides,
});

describe('P-02/P-03 psych support derivation', () => {
  it('does not create a prompt when all non-crisis answers are neutral', () => {
    const screening = base({ answers: base().answers.map(answer => ({ ...answer, valueCoded: 'NEVER' })) });
    expect(derivePsychSupport([screening])).toBeUndefined();
  });

  it('returns a privacy-safe mild prompt with fixed concern and opening', () => {
    const prompt = derivePsychSupport([base()]);
    expect(prompt).toMatchObject({
      patientId: 'patient-1',
      screeningIds: ['screening-1'],
      trend: ['MILD'],
      level: 'MILD',
      concerns: ['睡眠'],
      suggestedOpening: '上次的问卷里你说睡不好，现在好点了吗？',
      referralRecommended: false,
      latestSubmittedAt: '2026-10-01T00:00:00.000Z',
    });
    expect(prompt).not.toHaveProperty('answers');
    expect(prompt).not.toHaveProperty('instrument');
  });

  it('returns at most three chronological levels and marks sustained daily impact as moderate', () => {
    const rows = [
      base({ id: 'screening-1', submittedAt: '2026-09-01T00:00:00.000Z' }),
      base({ id: 'screening-2', submittedAt: '2026-09-10T00:00:00.000Z', answers: base().answers.map(answer => answer.code === 'SELF_SLEEP' ? { ...answer, valueCoded: 'OFTEN' } : answer) }),
      base({ id: 'screening-3', submittedAt: '2026-10-01T00:00:00.000Z', answers: base().answers.map(answer => answer.code === 'SELF_SLEEP' || answer.code === 'SELF_DAILY' ? { ...answer, valueCoded: 'OFTEN' } : answer) }),
      base({ id: 'screening-4', submittedAt: '2026-10-05T00:00:00.000Z', answers: base().answers.map(answer => answer.code === 'SELF_SLEEP' || answer.code === 'SELF_DAILY' ? { ...answer, valueCoded: 'ALWAYS' } : answer) }),
    ];
    const prompt = derivePsychSupport(rows);
    expect(prompt?.screeningIds).toEqual(['screening-2', 'screening-3', 'screening-4']);
    expect(prompt?.trend).toEqual(['MILD', 'MODERATE', 'MODERATE']);
    expect(prompt?.level).toBe('MODERATE');
    expect(prompt?.referralRecommended).toBe(true);
  });

  it('never emits a P-03 prompt when any screening contains a crisis item', () => {
    expect(derivePsychSupport([base({ crisisItemCodes: ['SELF_HARM'] })])).toBeUndefined();
  });
});
