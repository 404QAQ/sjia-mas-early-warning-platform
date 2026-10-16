import { describe, expect, it } from 'vitest';
import { isFamilyHistory, isFamilyHistoryContent } from '../src/family-history.js';

const content = { declined: false, siblings: [{ ageYears: 9, healthy: true, note: '无 sJIA' }], familyAutoimmune: ['OTHER_JIA'] as const };

describe('family history', () => {
  it('accepts a versioned non-declined snapshot and rejects unknown fields', () => {
    const value = { patientId: 'p1', ...content, version: 1, updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'a1', history: [{ version: 1, at: '2026-01-01T00:00:00.000Z', by: 'a1', ...content }] };
    expect(isFamilyHistory(value)).toBe(true);
    expect(isFamilyHistoryContent({ ...content, unsupported: true })).toBe(false);
  });

  it('accepts explicit decline only when all family data is empty', () => {
    const value = { patientId: 'p1', declined: true, siblings: [], familyAutoimmune: [], version: 1, updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'a1', history: [{ version: 1, at: '2026-01-01T00:00:00.000Z', by: 'a1', declined: true, siblings: [], familyAutoimmune: [] }] };
    expect(isFamilyHistory(value)).toBe(true);
    expect(isFamilyHistory({ ...value, siblings: [{ ageYears: 9, healthy: true }], history: [{ ...value.history[0], siblings: [{ ageYears: 9, healthy: true }] }] })).toBe(false);
  });

  it('bounds ages and allows other note only with OTHER code', () => {
    expect(isFamilyHistoryContent({ ...content, siblings: [{ ageYears: 121, healthy: true }] })).toBe(false);
    expect(isFamilyHistoryContent({ declined: false, siblings: [], familyAutoimmune: [], otherNote: '孤立说明' })).toBe(false);
    expect(isFamilyHistoryContent({ declined: false, siblings: [], familyAutoimmune: ['OTHER'], otherNote: '家族中有其他自身免疫病' })).toBe(true);
  });
});
