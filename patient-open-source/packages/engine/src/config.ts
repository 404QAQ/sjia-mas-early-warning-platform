/**
 * 默认阈值配置。对应 docs/02 §10 的 YAML（原样保留其数值与注释），
 * 补上工程需要但文档未给值的项，全部标【工程初稿·需临床复核】。
 * 所有阈值必须外置，不得硬编码进规则实现（docs/02 §10）。
 */
import type { ThresholdConfig } from '@mas/domain';

export const DEFAULT_CONFIG: ThresholdConfig = {
  version: '2016-standard-v1',
  clinicalReviewRequired: true,
  masRules: {
    ferritinCutoff: 684, // ng/mL, 2016 标准
    plateletCutoff: 181, // ×10⁹/L, 2016 标准
    astCutoff: 48, // U/L, 2016 标准
    triglycerideCutoff: 156, // mg/dL, 2016 标准
    fibrinogenCutoff: 360, // mg/dL, 2016 标准
    msScoreCutoff: -2.1,
    msScoreCoefficients: {
      // ⚠ 系数来自二手资料，实施前必须核对 PRINTO 原始论文（docs/09 A1.1 阻断项）
      cns: 1.54,
      bleeding: 1.54,
      arthritis: -1.3,
      platelet: -0.003,
      ldh: 0.001,
      fibrinogen: -0.004,
      ferritin: 0.0001,
    },
  },
  trend: {
    plateletDrop48hWarning: 0.2, // 下降 20% 触发
    plateletDrop48hCritical: 0.3,
    ferritinRise24hWarning: 0.5,
    consecutiveDeclineCount: 3,
    baselineDeviationFactor: 2.0, // docs/08 YAML FERRITIN_VS_BASELINE threshold
    staleDataDays: 30,
    minPointsForTrend: 3,
    rateOfChangeAnomalyFactor: 1.5, // 【工程初稿·需临床复核】
  },
  safetyNet: {
    noRecordHoursHighRisk: 12,
    contactNoResponseMinutes: 30,
    livingAloneNoRecordHours: 12,
  },
  symptoms: {
    feverHighC: 38.5,
    feverRisingDays: 3,
    recencyHours: 72, // 【工程初稿】症状在 72h 内视作「当前」
  },
  routing: {
    l1TimeoutHours: 24,
    l2TimeoutHours: 2,
    l3TimeoutMinutes: 30,
    quietHoursSuppressL1: true,
    quietHours: { from: '22:00', to: '08:00' },
  },
  notification: {
    l3InappToSmsMinutes: 2,
    l3SmsToVoiceMinutes: 5,
    crisisInappToVoiceMinutes: 1,
    voiceRetry: 1,
  },
  session: {
    clinicianAccessTokenMinutes: 15,
    clinicianRefreshTokenHours: 8,
  },
  disposition: {
    pendingReviewHours: 24,
    maxRepeatIgnore: 2,
  },
  fusion: {
    // 阈值命中「极危集」即 CRITICAL
    criticalSignals: [
      'CNS',
      'BLEEDING',
      'CRITERIA_2016_MET',
      'MS_SCORE_CROSSED',
    ],
    highThreshold: { severity3: 1, severity2: 2 },
    mediumThreshold: { severity3: 1, severity2: 2 },
  },
};
