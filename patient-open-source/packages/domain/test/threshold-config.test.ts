import { describe, expect, it } from 'vitest';
import {
  THRESHOLD_CONFIG_KEYS,
  createThresholdConfigSnapshot,
  validateThresholdConfig,
  validateThresholdConfigBacktest,
  type ThresholdConfigBacktest,
} from '../src/threshold-config.js';
import type { ThresholdConfig } from '../src/types.js';

const DEFAULT_CONFIG: ThresholdConfig = {
  version: '2016-standard-v1', clinicalReviewRequired: true,
  masRules: { ferritinCutoff: 684, plateletCutoff: 181, astCutoff: 48, triglycerideCutoff: 156, fibrinogenCutoff: 360, msScoreCutoff: -2.1,
    msScoreCoefficients: { cns: 1.54, bleeding: 1.54, arthritis: -1.3, platelet: -0.003, ldh: 0.001, fibrinogen: -0.004, ferritin: 0.0001 } },
  trend: { plateletDrop48hWarning: 0.2, plateletDrop48hCritical: 0.3, ferritinRise24hWarning: 0.5, consecutiveDeclineCount: 3, baselineDeviationFactor: 2, staleDataDays: 30, minPointsForTrend: 3, rateOfChangeAnomalyFactor: 1.5 },
  safetyNet: { noRecordHoursHighRisk: 12, contactNoResponseMinutes: 30, livingAloneNoRecordHours: 12 },
  symptoms: { feverHighC: 38.5, feverRisingDays: 3, recencyHours: 72 },
  routing: { l1TimeoutHours: 24, l2TimeoutHours: 2, l3TimeoutMinutes: 30, quietHoursSuppressL1: true, quietHours: { from: '22:00', to: '08:00' } },
  notification: { l3InappToSmsMinutes: 2, l3SmsToVoiceMinutes: 5, crisisInappToVoiceMinutes: 1, voiceRetry: 1 },
  session: { clinicianAccessTokenMinutes: 15, clinicianRefreshTokenHours: 8 }, disposition: { pendingReviewHours: 24, maxRepeatIgnore: 2 },
  fusion: { criticalSignals: ['CNS', 'BLEEDING'], highThreshold: { severity3: 1, severity2: 2 }, mediumThreshold: { severity3: 1, severity2: 2 } },
};

const at = '2026-10-06T00:00:00.000Z';
const backtest: ThresholdConfigBacktest = {
  sampleDays: 90,
  inputFingerprint: 'sha256:fixture',
  alertsDelta: 10,
  earlyDetectionsDelta: 1,
  falsePositiveDelta: 2,
  sampleCount: 20,
};

describe('threshold config registry domain', () => {
  it('accepts a configurable clone while preserving locked clinical constants', () => {
    const candidate = structuredClone(DEFAULT_CONFIG);
    candidate.trend.plateletDrop48hWarning = 0.25;
    expect(() => validateThresholdConfig(candidate)).not.toThrow();
    expect(createThresholdConfigSnapshot({ orgUnitId: 'org-a', version: 1, config: candidate, createdBy: 'actor-a', createdAt: at, effectiveFrom: at, backtest })).toMatchObject({
      orgUnitId: 'org-a', version: 1, status: 'DRAFT', config: candidate,
    });
  });

  it('rejects unknown fields, locked changes and invalid ranges', () => {
    const unknown = structuredClone(DEFAULT_CONFIG) as typeof DEFAULT_CONFIG & Record<string, unknown>;
    unknown.extra = true;
    expect(() => validateThresholdConfig(unknown)).toThrow(/未知/);
    const locked = structuredClone(DEFAULT_CONFIG);
    locked.masRules.ferritinCutoff += 1;
    expect(() => validateThresholdConfig(locked)).toThrow(/锁定/);
    const badRange = structuredClone(DEFAULT_CONFIG);
    badRange.trend.plateletDrop48hWarning = 1.2;
    expect(() => validateThresholdConfig(badRange)).toThrow(/范围/);
  });

  it('requires bounded backtest evidence and exposes an exact key set', () => {
    expect(THRESHOLD_CONFIG_KEYS).toContain('trend');
    expect(() => validateThresholdConfigBacktest({ ...backtest, inputFingerprint: '' })).toThrow();
    expect(() => validateThresholdConfigBacktest({ ...backtest, sampleDays: 0 })).toThrow();
    expect(() => validateThresholdConfigBacktest({ ...backtest, alertsDelta: Number.NaN })).toThrow();
  });

  it('accepts a reviewed, versioned four-channel differential section while keeping it optional', () => {
    const candidate = structuredClone(DEFAULT_CONFIG);
    candidate.differential = {
      reviewed: true,
      ruleVersion: 'differential-stage0-v1',
      channels: ['MAS_SUPPORT', 'SJIA_FLARE_SUPPORT', 'INFECTION_SUPPORT', 'OTHER_SUPPORT'].map((key) => ({ key: key as 'MAS_SUPPORT' | 'SJIA_FLARE_SUPPORT' | 'INFECTION_SUPPORT' | 'OTHER_SUPPORT', items: [{ code: 'AST', direction: 'UP', weight: 2, threshold: 48 }] })),
      dataGapPriority: ['PCT', 'EBV_CMV'],
      strengthThresholds: { strong: 5, medium: 3 },
      presentation: { showChannelWhen: 'ALWAYS', minStrengthToShow: 'WEAK' },
    };
    expect(() => validateThresholdConfig(candidate)).not.toThrow();
    const invalid = structuredClone(candidate);
    invalid.differential!.channels = invalid.differential!.channels.slice(0, 3);
    expect(() => validateThresholdConfig(invalid)).toThrow(/四个通道/);
    const invalidDirection = structuredClone(candidate);
    invalidDirection.differential!.channels[0]!.items[0]!.direction = 'TYPO';
    expect(() => validateThresholdConfig(invalidDirection)).toThrow(/direction/);
  });
});
