import { describe, expect, it } from 'vitest';
import {
  ContactAuthorizationError,
  confirmContactAuthorization,
  contactAuthorizationFreshness,
  grantContactAuthorization,
  isContactAuthorizationActive,
  summarizeContactAuthorizationFreshness,
  withdrawContactAuthorization,
  type ContactAuthorization,
} from '../src/contact-safety.js';

const base = {
  patientId: 'p1',
  contactId: 'c1',
  priority: 1 as const,
  visibility: 'G2_SUMMARY' as const,
  consentText: '我同意在 CL3 时联系该联系人。',
  grantedBy: 'a-self',
  grantedAt: '2026-01-01T00:00:00.000Z',
  expectedVersion: 0,
  idempotencyKey: 'grant-1',
};

describe('contact authorization domain', () => {
  it('creates v1 active authorization with immutable consent snapshot', () => {
    const auth = grantContactAuthorization(undefined, base);
    expect(auth).toMatchObject({ patientId: 'p1', contactId: 'c1', version: 1, status: 'ACTIVE', consentText: base.consentText, grantedBy: 'a-self' });
    expect(isContactAuthorizationActive(auth, '2026-01-01T00:01:00.000Z')).toBe(true);
  });

  it('requires matching expected version and increments on withdraw/regrant', () => {
    const active = grantContactAuthorization(undefined, base);
    expect(() => grantContactAuthorization(active, { ...base, idempotencyKey: 'grant-2', expectedVersion: 0 })).toThrowError(ContactAuthorizationError);
    const withdrawn = withdrawContactAuthorization(active, { patientId: 'p1', contactId: 'c1', withdrawnBy: 'a-self', withdrawnAt: '2026-01-02T00:00:00.000Z', expectedVersion: 1, idempotencyKey: 'withdraw-1' });
    expect(withdrawn).toMatchObject({ version: 2, status: 'WITHDRAWN', withdrawnBy: 'a-self' });
    // 撤回是新的不可变版本，必须有自己的 id（PG 上 id 唯一，沿用上一版 id 会让撤回整体失败）
    expect(withdrawn.id).toBe('p1:c1:2');
    expect(active.id).toBe('p1:c1:1');
    expect(isContactAuthorizationActive(withdrawn, '2026-01-03T00:00:00.000Z')).toBe(false);
    const regranted = grantContactAuthorization(withdrawn, { ...base, grantedAt: '2026-01-03T00:00:00.000Z', grantedBy: 'a-self', expectedVersion: 2, idempotencyKey: 'grant-3' });
    expect(regranted.version).toBe(3);
    expect(regranted.id).toBe('p1:c1:3');
    expect(withdrawn.consentText).toBe(base.consentText);
  });

  it('rejects malformed visibility, priority, consent and timestamps', () => {
    expect(() => grantContactAuthorization(undefined, { ...base, visibility: 'G3_FULL' as never })).toThrowError(ContactAuthorizationError);
    expect(() => grantContactAuthorization(undefined, { ...base, priority: 3 as never })).toThrowError(ContactAuthorizationError);
    expect(() => grantContactAuthorization(undefined, { ...base, consentText: ' ' })).toThrowError(ContactAuthorizationError);
    expect(() => grantContactAuthorization(undefined, { ...base, grantedAt: 'bad' })).toThrowError(ContactAuthorizationError);
  });

  it('requires expected version and patient/contact identity on withdraw', () => {
    const auth: ContactAuthorization = grantContactAuthorization(undefined, base);
    expect(() => withdrawContactAuthorization(auth, { patientId: 'p2', contactId: 'c1', withdrawnBy: 'a-self', withdrawnAt: base.grantedAt, expectedVersion: 1, idempotencyKey: 'x' })).toThrowError(ContactAuthorizationError);
    expect(() => withdrawContactAuthorization(auth, { patientId: 'p1', contactId: 'c1', withdrawnBy: 'a-self', withdrawnAt: base.grantedAt, expectedVersion: 0, idempotencyKey: 'x' })).toThrowError(ContactAuthorizationError);
  });

  it('derives UTC calendar-month freshness with inclusive boundaries', () => {
    const auth = grantContactAuthorization(undefined, {
      ...base,
      grantedAt: '2026-01-31T23:30:00.000Z',
      lastConfirmedAt: '2026-01-31T23:30:00.000Z',
    });
    expect(contactAuthorizationFreshness(auth, '2026-07-30T23:29:59.999Z')).toEqual({ freshness: 'CURRENT', nextConfirmAt: '2026-07-31T23:30:00.000Z' });
    expect(contactAuthorizationFreshness(auth, '2026-07-31T23:30:00.000Z')).toEqual({ freshness: 'DUE', nextConfirmAt: '2026-07-31T23:30:00.000Z' });
    expect(contactAuthorizationFreshness(auth, '2027-01-30T23:29:59.999Z').freshness).toBe('DUE');
    expect(contactAuthorizationFreshness(auth, '2027-01-31T23:30:00.000Z').freshness).toBe('STALE');
    expect(contactAuthorizationFreshness({ ...auth, status: 'WITHDRAWN', withdrawnBy: 'a-self', withdrawnAt: '2026-02-01T00:00:00.000Z' }, '2027-01-31T23:30:00.000Z')).toEqual({ freshness: 'NONE', nextConfirmAt: null });
  });

  it('confirms an active authorization as a new immutable version and copies its snapshot', () => {
    const active = grantContactAuthorization(undefined, { ...base, quietHours: { from: '22:00', to: '07:00' } });
    const confirmed = confirmContactAuthorization(active, {
      patientId: 'p1',
      contactId: 'c1',
      confirmedBy: 'a-self',
      confirmedAt: '2026-07-31T23:30:00.000Z',
      expectedVersion: 1,
      idempotencyKey: 'confirm-1',
    });
    expect(confirmed).toMatchObject({ status: 'ACTIVE', version: 2, lastConfirmedAt: '2026-07-31T23:30:00.000Z', consentText: active.consentText, priority: active.priority, visibility: active.visibility, quietHours: active.quietHours, grantedBy: active.grantedBy, grantedAt: active.grantedAt });
    expect(confirmed.id).toBe('p1:c1:2');
    expect(active.version).toBe(1);
    expect(() => confirmContactAuthorization(active, { patientId: 'p1', contactId: 'c1', confirmedBy: 'a-self', confirmedAt: base.grantedAt, expectedVersion: 0, idempotencyKey: 'confirm-stale' })).toThrowError(ContactAuthorizationError);
    const withdrawn = withdrawContactAuthorization(active, { patientId: 'p1', contactId: 'c1', withdrawnBy: 'a-self', withdrawnAt: '2026-02-01T00:00:00.000Z', expectedVersion: 1, idempotencyKey: 'withdraw-2' });
    expect(() => confirmContactAuthorization(withdrawn, { patientId: 'p1', contactId: 'c1', confirmedBy: 'a-self', confirmedAt: base.grantedAt, expectedVersion: 2, idempotencyKey: 'confirm-withdrawn' })).toThrowError(ContactAuthorizationError);
  });

  it('fails closed for malformed freshness records instead of producing a fake stale state', () => {
    const malformed = { ...grantContactAuthorization(undefined, base), lastConfirmedAt: 'not-a-time' };
    expect(() => contactAuthorizationFreshness(malformed, '2026-07-01T00:00:00.000Z')).toThrowError(ContactAuthorizationError);
  });

  it('aggregates active contact freshness without exposing contact fields', () => {
    const current = grantContactAuthorization(undefined, { ...base, contactId: 'current', grantedAt: '2026-09-01T00:00:00.000Z', lastConfirmedAt: '2026-09-01T00:00:00.000Z' });
    const stale = grantContactAuthorization(undefined, { ...base, contactId: 'stale', grantedAt: '2025-10-04T12:00:00.000Z', lastConfirmedAt: '2025-10-04T12:00:00.000Z' });
    const withdrawn = withdrawContactAuthorization(grantContactAuthorization(undefined, { ...base, contactId: 'withdrawn' }), {
      patientId: 'p1', contactId: 'withdrawn', withdrawnBy: 'a-self', withdrawnAt: '2026-01-02T00:00:00.000Z', expectedVersion: 1, idempotencyKey: 'withdraw-summary',
    });
    expect(summarizeContactAuthorizationFreshness([current, stale, withdrawn], '2026-10-04T12:00:00.000Z')).toEqual({
      freshness: 'STALE', activeCount: 2, currentCount: 1, dueCount: 0, staleCount: 1,
    });
  });
});
