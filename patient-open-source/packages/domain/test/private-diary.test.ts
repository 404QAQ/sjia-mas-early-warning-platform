import { describe, expect, it } from 'vitest';
import { isPrivateDiaryEntry, normalizePrivateDiaryQuickMood, PRIVATE_DIARY_CODES, PRIVATE_DIARY_TAG } from '../src/private-diary.js';

describe('P-04 private diary contract', () => {
  it('normalizes fixed quick mood labels without accepting arbitrary text', () => {
    expect(normalizePrivateDiaryQuickMood('难受')).toBe('DISTRESSED');
    expect(normalizePrivateDiaryQuickMood('LOW_ENERGY')).toBe('LOW_ENERGY');
    expect(normalizePrivateDiaryQuickMood('随便')).toBeUndefined();
  });

  it('requires the hard NO_ALERT and SELF markers', () => {
    const entry = {
      id: 'entry-1', patientId: 'patient-1', code: PRIVATE_DIARY_CODES.FREE_TEXT,
      valueText: '今天很烦', observedAt: '2026-10-03T12:00:00.000Z', recordedAt: '2026-10-03T12:00:00.000Z',
      source: 'PATIENT_REPORTED', tags: [PRIVATE_DIARY_TAG], visibleTo: ['SELF'], revision: 1,
    };
    expect(isPrivateDiaryEntry(entry)).toBe(true);
    expect(isPrivateDiaryEntry({ ...entry, tags: [] })).toBe(false);
    expect(isPrivateDiaryEntry({ ...entry, visibleTo: ['CLINICIAN'] })).toBe(false);
    expect(isPrivateDiaryEntry({ ...entry, unexpected: 'leak' })).toBe(false);
  });
});
