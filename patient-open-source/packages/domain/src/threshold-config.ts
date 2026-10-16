import type { DifferentialChannelKey, DifferentialConfig, Iso, ThresholdConfig } from './types.js';
import { DIFFERENTIAL_RULE_DIRECTIONS } from './differential-rules.js';
export { DIFFERENTIAL_RULE_DIRECTIONS } from './differential-rules.js';
const DIFFERENTIAL_DIRECTIONS = ['UP', 'DOWN', 'CONTINUOUS', 'NORMAL_OR_UP', 'INTERMITTENT', 'POSITIVE', 'RESPONDED', 'NO_RESPONSE'] as const;

/** O-01 registry lifecycle.  A snapshot is immutable once persisted. */
export type ThresholdConfigStatus = 'DRAFT' | 'PREVIEWED' | 'PUBLISHED' | 'ROLLED_BACK';

/** The only fields that may be tuned by an organization. */
export const THRESHOLD_CONFIG_KEYS = [
  'version', 'clinicalReviewRequired', 'masRules', 'trend', 'safetyNet', 'symptoms', 'routing', 'notification', 'session', 'disposition', 'fusion', 'differential',
] as const;

/** Impact estimate is deliberately limited to aggregate, non-clinical metrics. */
export interface ThresholdConfigBacktest {
  sampleDays: number;
  sampleCount: number;
  inputFingerprint: string;
  alertsDelta: number;
  earlyDetectionsDelta: number;
  falsePositiveDelta: number;
  baselineVersion?: number;
  generatedAt?: Iso;
}

export interface ThresholdConfigSnapshot {
  id: string;
  orgUnitId: string;
  version: number;
  config: ThresholdConfig;
  status: ThresholdConfigStatus;
  effectiveFrom: Iso;
  createdBy: string;
  createdAt: Iso;
  backtest: ThresholdConfigBacktest;
  supersedesVersion?: number;
  supersededBy?: string;
  rollbackOfVersion?: number;
}

export interface ThresholdConfigCommandReceipt {
  orgUnitId: string;
  actorId: string;
  idempotencyKey: string;
  fingerprint: string;
  result: ThresholdConfigSnapshot;
  createdAt: Iso;
  action: string;
}

/** Values fixed by the 2016 criteria and the published MS score model. */
export const LOCKED_THRESHOLD_VALUES = {
  ferritinCutoff: 684,
  plateletCutoff: 181,
  astCutoff: 48,
  triglycerideCutoff: 156,
  fibrinogenCutoff: 360,
  msScoreCutoff: -2.1,
  msScoreCoefficients: {
    cns: 1.54,
    bleeding: 1.54,
    arthritis: -1.3,
    platelet: -0.003,
    ldh: 0.001,
    fibrinogen: -0.004,
    ferritin: 0.0001,
  },
} as const;

const CONFIG_SHAPE: Record<string, readonly string[]> = {
  masRules: ['ferritinCutoff', 'plateletCutoff', 'astCutoff', 'triglycerideCutoff', 'fibrinogenCutoff', 'msScoreCutoff', 'msScoreCoefficients'],
  msScoreCoefficients: ['cns', 'bleeding', 'arthritis', 'platelet', 'ldh', 'fibrinogen', 'ferritin'],
  trend: ['plateletDrop48hWarning', 'plateletDrop48hCritical', 'ferritinRise24hWarning', 'consecutiveDeclineCount', 'baselineDeviationFactor', 'staleDataDays', 'minPointsForTrend', 'rateOfChangeAnomalyFactor'],
  safetyNet: ['noRecordHoursHighRisk', 'contactNoResponseMinutes', 'livingAloneNoRecordHours'],
  symptoms: ['feverHighC', 'feverRisingDays', 'recencyHours'],
  routing: ['l1TimeoutHours', 'l2TimeoutHours', 'l3TimeoutMinutes', 'quietHoursSuppressL1', 'quietHours'],
  quietHours: ['from', 'to'],
  notification: ['l3InappToSmsMinutes', 'l3SmsToVoiceMinutes', 'crisisInappToVoiceMinutes', 'voiceRetry'],
  session: ['clinicianAccessTokenMinutes', 'clinicianRefreshTokenHours'],
  disposition: ['pendingReviewHours', 'maxRepeatIgnore'],
  fusion: ['criticalSignals', 'highThreshold', 'mediumThreshold'],
  highThreshold: ['severity3', 'severity2'],
  mediumThreshold: ['severity3', 'severity2'],
};

export function createThresholdConfigSnapshot(input: {
  id?: string;
  orgUnitId: string;
  version: number;
  config: ThresholdConfig;
  createdBy: string;
  createdAt: string;
  effectiveFrom: string;
  backtest: ThresholdConfigBacktest;
  status?: ThresholdConfigStatus;
  supersedesVersion?: number;
  supersededBy?: string;
  rollbackOfVersion?: number;
}): ThresholdConfigSnapshot {
  text(input.orgUnitId, '机构');
  text(input.createdBy, '创建人');
  if (!Number.isSafeInteger(input.version) || input.version < 1) throw new RangeError('阈值配置版本必须为正整数');
  const createdAt = instant(input.createdAt, '创建时间');
  const effectiveFrom = instant(input.effectiveFrom, '生效时间');
  validateThresholdConfig(input.config);
  validateThresholdConfigBacktest(input.backtest);
  return structuredClone({
    id: input.id ?? `${input.orgUnitId}:threshold:${input.version}`,
    orgUnitId: input.orgUnitId,
    version: input.version,
    config: input.config,
    status: input.status ?? 'DRAFT',
    effectiveFrom,
    createdBy: input.createdBy,
    createdAt,
    backtest: input.backtest,
    ...(input.supersedesVersion === undefined ? {} : { supersedesVersion: input.supersedesVersion }),
    ...(input.supersededBy === undefined ? {} : { supersededBy: input.supersededBy }),
    ...(input.rollbackOfVersion === undefined ? {} : { rollbackOfVersion: input.rollbackOfVersion }),
  });
}

export function validateThresholdConfigBacktest(value: unknown): asserts value is ThresholdConfigBacktest {
  if (!record(value)) throw new RangeError('回测结果必须是对象');
  exactKeys(value, ['sampleDays', 'sampleCount', 'inputFingerprint', 'alertsDelta', 'earlyDetectionsDelta', 'falsePositiveDelta'], ['baselineVersion', 'generatedAt']);
  integer(value.sampleDays, 1, 3650, '回测天数');
  integer(value.sampleCount, 0, 10_000_000, '回测样本数');
  text(value.inputFingerprint, '回测输入指纹', 256);
  numberFinite(value.alertsDelta, '告警变化');
  numberFinite(value.earlyDetectionsDelta, '提前预警变化');
  numberFinite(value.falsePositiveDelta, '假阳性变化');
  if (value.baselineVersion !== undefined) integer(value.baselineVersion, 1, Number.MAX_SAFE_INTEGER, '回测基线版本');
  if (value.generatedAt !== undefined) instant(value.generatedAt, '回测时间');
}

export function validateThresholdConfig(value: unknown): asserts value is ThresholdConfig {
  if (!record(value)) throw new RangeError('阈值配置必须是对象');
  // differential 是向后兼容的可选段；旧版本配置不包含它时仍可回放。
  exactKeys(value, THRESHOLD_CONFIG_KEYS.filter((key) => key !== 'differential'), ['differential']);
  text(value.version, '配置版本', 128);
  if (typeof value.clinicalReviewRequired !== 'boolean') throw new RangeError('临床复核标志无效');
  validateNestedShape(value);
  const mas = value.masRules as Record<string, unknown>;
  const coefficients = mas.msScoreCoefficients as Record<string, unknown>;
  for (const [key, expected] of Object.entries(LOCKED_THRESHOLD_VALUES)) {
    const actual = key === 'msScoreCoefficients' ? coefficients : mas[key];
    if (key === 'msScoreCoefficients') {
      for (const [coefficient, fixed] of Object.entries(expected)) if (coefficients[coefficient] !== fixed) throw new RangeError(`指南锁定项 ${coefficient} 不能修改`);
    } else if (actual !== expected) throw new RangeError(`指南锁定项 ${key} 不能修改`);
  }
  numberFinite(mas.msScoreCutoff, 'MS cutoff');
  const trend = value.trend as Record<string, unknown>;
  range(trend.plateletDrop48hWarning, 0, 1, '血小板预警比例', false);
  range(trend.plateletDrop48hCritical, 0, 1, '血小板高危比例', false);
  if ((trend.plateletDrop48hCritical as number) < (trend.plateletDrop48hWarning as number)) throw new RangeError('趋势阈值范围无效');
  range(trend.ferritinRise24hWarning, 0, 10, '铁蛋白上升比例', false);
  integer(trend.consecutiveDeclineCount, 1, 100, '连续下降次数');
  range(trend.baselineDeviationFactor, 0, 100, '基线偏离倍数', false);
  integer(trend.staleDataDays, 1, 3650, '陈旧数据天数');
  integer(trend.minPointsForTrend, 1, 1000, '趋势最小点数');
  range(trend.rateOfChangeAnomalyFactor, 0, 100, '变化速度倍数', false);
  const safety = value.safetyNet as Record<string, unknown>;
  range(safety.noRecordHoursHighRisk, 0, 8760, '高危未记录小时数', false);
  range(safety.contactNoResponseMinutes, 0, 10080, '联系人无响应分钟数', false);
  range(safety.livingAloneNoRecordHours, 0, 8760, '独居未记录小时数', false);
  const symptoms = value.symptoms as Record<string, unknown>;
  range(symptoms.feverHighC, 30, 45, '高热温度', false);
  integer(symptoms.feverRisingDays, 1, 100, '发热上升天数');
  integer(symptoms.recencyHours, 1, 8760, '症状时效');
  const routing = value.routing as Record<string, unknown>;
  range(routing.l1TimeoutHours, 0, 8760, 'L1 超时', false); range(routing.l2TimeoutHours, 0, 8760, 'L2 超时', false); range(routing.l3TimeoutMinutes, 0, 10080, 'L3 超时', false);
  if (typeof routing.quietHoursSuppressL1 !== 'boolean') throw new RangeError('静默时段开关无效');
  const quiet = routing.quietHours as Record<string, unknown>; text(quiet.from, '静默起始'); text(quiet.to, '静默结束');
  const notification = value.notification as Record<string, unknown>; for (const key of ['l3InappToSmsMinutes', 'l3SmsToVoiceMinutes', 'crisisInappToVoiceMinutes']) range(notification[key], 0, 10080, key, false); integer(notification.voiceRetry, 0, 100, '语音重试次数');
  const session = value.session as Record<string, unknown>; range(session.clinicianAccessTokenMinutes, 1, 1440, '访问令牌时长', false); range(session.clinicianRefreshTokenHours, 1, 720, '刷新令牌时长', false);
  const disposition = value.disposition as Record<string, unknown>; range(disposition.pendingReviewHours, 0, 8760, '待复评时长', false); integer(disposition.maxRepeatIgnore, 0, 100, '再忽略上限');
  const fusion = value.fusion as Record<string, unknown>; if (!Array.isArray(fusion.criticalSignals) || fusion.criticalSignals.some(item => typeof item !== 'string' || !item.trim())) throw new RangeError('极危信号无效');
  for (const key of ['highThreshold', 'mediumThreshold']) { const threshold = fusion[key] as Record<string, unknown>; integer(threshold.severity3, 0, 100, `${key}.severity3`); integer(threshold.severity2, 0, 100, `${key}.severity2`); }
  if (value.differential !== undefined) validateDifferentialConfig(value.differential);
}

function validateNestedShape(config: Record<string, unknown>): void {
  for (const key of ['masRules', 'trend', 'safetyNet', 'symptoms', 'routing', 'notification', 'session', 'disposition', 'fusion'] as const) {
    const value = config[key];
    if (!record(value)) throw new RangeError(`${key} 必须是对象`);
    exactKeys(value, CONFIG_SHAPE[key]!);
  }
  const masRules = config.masRules as Record<string, unknown>;
  if (!record(masRules.msScoreCoefficients)) throw new RangeError('msScoreCoefficients 必须是对象');
  exactKeys(masRules.msScoreCoefficients, CONFIG_SHAPE.msScoreCoefficients!);
  const routing = config.routing as Record<string, unknown>;
  if (!record(routing.quietHours)) throw new RangeError('quietHours 必须是对象');
  exactKeys(routing.quietHours, CONFIG_SHAPE.quietHours!);
  const fusion = config.fusion as Record<string, unknown>;
  for (const key of ['highThreshold', 'mediumThreshold'] as const) {
    if (!record(fusion[key])) throw new RangeError(`${key} 必须是对象`);
    exactKeys(fusion[key] as Record<string, unknown>, CONFIG_SHAPE[key]!);
  }
}

function validateDifferentialConfig(value: unknown): asserts value is DifferentialConfig {
  if (!record(value)) throw new RangeError('differential 必须是对象');
  exactKeys(value, ['reviewed', 'ruleVersion', 'channels', 'dataGapPriority', 'strengthThresholds'], ['presentation']);
  if (typeof value.reviewed !== 'boolean') throw new RangeError('differential.reviewed 无效');
  text(value.ruleVersion, 'differential.ruleVersion', 128);
  if (!Array.isArray(value.channels) || value.channels.length !== 4) throw new RangeError('differential.channels 必须包含四个通道');
  const keys: DifferentialChannelKey[] = ['MAS_SUPPORT', 'SJIA_FLARE_SUPPORT', 'INFECTION_SUPPORT', 'OTHER_SUPPORT'];
  const seen = new Set<string>();
  for (const channel of value.channels) {
    if (!record(channel)) throw new RangeError('differential channel 必须是对象');
    exactKeys(channel, ['key', 'items']);
    if (typeof channel.key !== 'string' || !keys.includes(channel.key as DifferentialChannelKey) || seen.has(channel.key)) throw new RangeError('differential channel key 无效');
    seen.add(channel.key);
    if (!Array.isArray(channel.items)) throw new RangeError('differential.items 必须是数组');
    for (const item of channel.items) {
      if (!record(item)) throw new RangeError('differential item 必须是对象');
      exactKeys(item, ['code', 'direction', 'weight'], ['threshold']);
      text(item.code, 'differential.item.code', 128); text(item.direction, 'differential.item.direction', 64);
      if (!DIFFERENTIAL_DIRECTIONS.includes(item.direction as typeof DIFFERENTIAL_DIRECTIONS[number])) throw new RangeError('differential.item.direction 无效');
      const allowedDirections = DIFFERENTIAL_RULE_DIRECTIONS[item.code];
      if (allowedDirections && !allowedDirections.includes(item.direction)) throw new RangeError('differential.item.code 与 direction 不匹配');
      numberFinite(item.weight, 'differential.item.weight');
      if (item.weight === 0 || item.weight < -10 || item.weight > 10) throw new RangeError('differential.item.weight 范围无效');
      if (item.threshold !== undefined) numberFinite(item.threshold, 'differential.item.threshold');
    }
  }
  if (seen.size !== keys.length) throw new RangeError('differential.channels 缺少通道');
  if (!Array.isArray(value.dataGapPriority) || value.dataGapPriority.some(item => typeof item !== 'string' || !item.trim())) throw new RangeError('differential.dataGapPriority 无效');
  const strengths = value.strengthThresholds;
  if (!record(strengths)) throw new RangeError('differential.strengthThresholds 无效');
  exactKeys(strengths, ['strong', 'medium']); numberFinite(strengths.strong, 'differential.strengthThresholds.strong'); numberFinite(strengths.medium, 'differential.strengthThresholds.medium');
  if (strengths.strong <= strengths.medium || strengths.medium <= 0) throw new RangeError('differential.strengthThresholds 范围无效');
  if (value.presentation !== undefined) {
    if (!record(value.presentation)) throw new RangeError('differential.presentation 无效');
    exactKeys(value.presentation, ['showChannelWhen', 'minStrengthToShow']);
    if (!['EVIDENCE', 'ALWAYS'].includes(value.presentation.showChannelWhen as string)) throw new RangeError('differential.showChannelWhen 无效');
    if (!['WEAK', 'MEDIUM', 'STRONG'].includes(value.presentation.minStrengthToShow as string)) throw new RangeError('differential.minStrengthToShow 无效');
  }
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], optional: readonly string[] = []): void { const expected = new Set([...keys, ...optional]); if (Object.keys(value).some(key => !expected.has(key)) || keys.some(key => !(key in value))) throw new RangeError('配置包含未知或缺失字段'); }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function text(value: unknown, label: string, max = 200): asserts value is string { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) throw new RangeError(`${label}无效`); }
function instant(value: unknown, label: string): string { text(value, label, 128); const ms = Date.parse(value); if (!Number.isFinite(ms)) throw new RangeError(`${label}无效`); return new Date(ms).toISOString(); }
function numberFinite(value: unknown, label: string): asserts value is number { if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError(`${label}必须是有限数字`); }
function integer(value: unknown, min: number, max: number, label: string): asserts value is number { if (!Number.isSafeInteger(value)) throw new RangeError(`${label}范围无效`); const numeric = value as number; if (numeric < min || numeric > max) throw new RangeError(`${label}范围无效`); }
function range(value: unknown, min: number, max: number, label: string, inclusive = true): asserts value is number {
  numberFinite(value, label);
  const numeric = value as number;
  if (inclusive ? numeric < min || numeric > max : numeric <= min || numeric >= max) throw new RangeError(`${label}范围无效`);
}
