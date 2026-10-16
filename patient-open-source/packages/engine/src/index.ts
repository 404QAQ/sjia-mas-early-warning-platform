/**
 * MAS 预警引擎 —— 纯函数、无 IO、可重放。
 *
 * 架构原则（docs/04 §2.1）：给定同一组观测值，必须算出同一个结果；
 * 且历史告警可以用当时的规则重新计算。
 *   - now 显式传入，不读系统时间
 *   - 不访问数据库：所有输入由调用方准备好
 *   - 不可变：不修改 input，返回新对象
 */
import type {
  ActionLevel,
  AlertReason,
  Code,
  DataGap,
  EngineInput,
  EngineOutput,
  EvidenceItem,
  MsScoreResult,
  RiskLevel,
  SafetyNetStatus,
  StandardProgress,
  ThresholdConfig,
  TrendSignal,
} from '@mas/domain';
import { CODE_TABLE } from '@mas/domain';
import { DEFAULT_CONFIG } from './config.js';
import { evaluateSafetyNet, layer1Rules, missingCriticalNote } from './layer1-rules.js';
import { layer2Trend } from './layer2-trend.js';
import { canEscalateOnScoreOnly, layer3Score } from './layer3-score.js';
import { buildSeries, seriesOf, type SeriesBundle } from './series.js';
import { fuse, type FuseInput } from './fuse.js';
import { toMs } from './time.js';
import { evaluateDifferential } from './differential.js';

export const ENGINE_VERSION = '0.1.0';

export { DEFAULT_CONFIG } from './config.js';
export * from './time.js';
export * from './series.js';
export * from './baseline.js';
export * from './layer1-rules.js';
export * from './layer2-trend.js';
export * from './layer3-score.js';
export * from './fuse.js';
export * from './differential.js';
export { sensitivity } from './sensitivity.js';
export { backtest, type BacktestCase, type BacktestResult } from './backtest.js';

/**
 * 主入口。纯函数：相同输入永远得到相同输出（不读时钟、不读库、不随机）。
 */
export function evaluate(rawInput: EngineInput): EngineOutput {
  const input = inputSnapshot(rawInput);
  const cfg: ThresholdConfig = input.thresholds ?? DEFAULT_CONFIG;
  const series = buildSeries(input.observations);

  // ---- L1 规则层 ----
  const l1 = layer1Rules(series, cfg, input.safetyNet, input.now);

  // ---- 关节炎活动度：来自关节评估（一期通常为空 → 缺项） ----
  const arthritisActive = resolveArthritisActive(input, series);

  // ---- L2 趋势层 ----
  const l2 = layer2Trend(series, input.baseline, cfg, input.now);

  // ---- L3 评分层 ----
  const l3 = layer3Score({
    series,
    cfg,
    now: input.now,
    arthritisActive,
    previous: input.previousMsScore,
  });

  // ---- 融合 ----
  const allReasons: AlertReason[] = [...l1.reasons, ...l2.reasons];

  const notMeasured = l1.standard.items
    .filter((i) => i.met === 'NOT_MEASURED')
    .map((i) => ({ code: i.key, display: i.display }));

  const fusionInput: Omit<FuseInput, 'safetyNetStatus' | 'safetyNetNote'> = {
    reasons: allReasons,
    cfg,
    criticalMissing: l1.criticalMissing,
    staleNotes: l2.staleNotes,
    criteriaMet: l1.standard.satisfied,
    msCrossed: l3.crossed,
    msCanEscalate: canEscalateOnScoreOnly(l3),
    trendOverridesScore: l2.trendOverridesScore,
    scoreValue: l3.value,
    scoreCutoff: l3.cutoff,
    scoreMissingInputs: l3.missingInputs,
    notMeasuredItems: notMeasured
      .filter((n) => ['TRIGLYCERIDE', 'FIBRINOGEN', 'AST'].includes(n.code))
      .map((n) => ({ code: n.code, display: n.display })),
  };
  // 先融合全部临床信号，再判断安全网；L2/L3 的高风险不能被 L1 局部结果遗漏。
  const clinical = fuse({ ...fusionInput, safetyNetStatus: 'IN_CARE' });
  const safetyNet = evaluateSafetyNet(
    input.safetyNet,
    series,
    cfg,
    toMs(input.now),
    clinical.riskLevel === 'HIGH' || clinical.riskLevel === 'CRITICAL',
  );
  // 始终使用原始临床触发项，不把安全网原因回灌为临床风险信号。
  const fused = fuse({
    ...fusionInput,
    safetyNetStatus: safetyNet.status,
    safetyNetNote: safetyNet.note,
  });

  // ---- 缺失关键指标提示并入结论 ----
  const criticalNote = missingCriticalNote(l1.criticalMissing);
  const reasonsFinal = [...fused.reasons];
  if (criticalNote) {
    reasonsFinal.push({
      code: 'DATA_GAP_CRITICAL',
      label: '数据缺口',
      detail: criticalNote,
      source: 'SAFETY_NET',
      severity: 1,
      actionability: 1,
    });
  }

  const suggestions = [...fused.suggestions];
  if (l1.suggestedTests.length > 0) {
    const line = `建议加测 ${l1.suggestedTests.join(' + ')}`;
    if (!suggestions.includes(line)) suggestions.push(line);
  }

  // 证据板与风险融合并列：它只读既有临床信号，不回灌 risk/action/fingerprint。
  const differential = evaluateDifferential({
    cfg,
    configVersion: cfg.version,
    differential: cfg.differential,
    reasons: allReasons,
    standard: l1.standard,
    trends: l2.signals,
    baseline: input.baseline,
    series,
    joints: input.joints,
    diseaseType: input.patient.diseaseType,
    now: input.now,
  });

  return {
    riskLevel: fused.riskLevel,
    actionLevel: fused.actionLevel,
    safetyNetStatus: safetyNet.status,
    reasons: reasonsFinal,
    evidence: buildEvidence(l1.evidence, input),
    standard2016: l1.standard,
    msScore: attachDivergence(l3, fused.divergenceText),
    trends: l2.signals,
    suggestions,
    differential: differential.channels,
    dataGaps: mergeGaps([...fused.dataGaps, ...differential.dataGaps], l1.criticalMissing),
    safetyNetNote: safetyNet.note,
    engineVersion: ENGINE_VERSION,
    configVersion: cfg.version,
    signalFingerprint: fused.signalFingerprint,
  };
}

/** 只使用当时已经发生且已录入的本患者数据；历史重放不得读取未来信息。 */
export function inputSnapshot(input: EngineInput): EngineInput {
  if (typeof input.now !== 'string') throw new Error('now 必须是带时区的 ISO 时间字符串');
  const nowMs = toMs(input.now);
  for (const field of ['observations', 'baseline', 'joints'] as const) {
    if (input[field].some((record) => record.patientId !== input.patient.id)) {
      throw new Error(`${field} 中的 patientId 与当前患者不一致`);
    }
  }
  const lastActiveAt = input.safetyNet.lastActiveAt;
  return {
    ...input,
    observations: input.observations.filter((observation) =>
      !(observation.tags ?? []).some((tag) => tag === 'NO_ALERT' || tag === 'OCR_UNVERIFIED') &&
      toMs(observation.observedAt) <= nowMs && toMs(observation.recordedAt) <= nowMs),
    baseline: input.baseline.filter((baseline) => toMs(baseline.updatedAt) <= nowMs),
    joints: input.joints
      .filter((joint) => toMs(joint.observedAt) <= nowMs)
      .sort((a, b) => toMs(a.observedAt) - toMs(b.observedAt) || jointSortKey(a).localeCompare(jointSortKey(b))),
    safetyNet: {
      ...input.safetyNet,
      // 全量病例带来的未来活跃时间不能掩盖历史失联；规则层会回退到快照中的最近观测。
      lastActiveAt: lastActiveAt !== undefined && toMs(lastActiveAt) <= nowMs ? lastActiveAt : undefined,
    },
  };
}

function jointSortKey(joint: EngineInput['joints'][number]): string {
  return [joint.assessedBy, joint.source, joint.activityLevel, joint.trendFlag ?? '', joint.dataQuality ?? '', String(joint.painNrs ?? ''), String(joint.morningStiffnessMinutes ?? '')].join('|');
}

function attachDivergence(score: MsScoreResult, divergenceText?: string): MsScoreResult {
  if (!divergenceText) return score;
  return { ...score, divergence: 'TREND_OVERRIDES_SCORE', divergenceText };
}

function resolveArthritisActive(input: EngineInput, series: SeriesBundle): boolean | null {
  // 关节评估（一期为空）优先
  const joints = (input.joints ?? []).filter((joint) => joint.dataQuality !== 'CONFLICT');
  if (joints.length > 0) {
    const recent = joints[joints.length - 1]!;
    if (recent.trendFlag) return recent.trendFlag === 'WORSENED';
    return recent.activityLevel !== 'FULL';
  }
  // 兜底：症状码 ARTHRITIS_IMPROVED 说明关节症状减轻 → 关节炎判为「不活动」
  // 但这是反直觉信号：MS score 中关节炎是负权重，关节症状减轻反而推高分数
  const nowMs = toMs(input.now);
  const improved = series.symptoms.some((s) => s.code === 'ARTHRITIS_IMPROVED' && nowMs - s.atMs <= 7 * 86_400_000);
  if (improved) return false;
  if (seriesOf(series, 'PLATELET')) {
    // 没有任何关节信息来源 → 缺项，不猜
    return null;
  }
  return null;
}

function buildEvidence(base: EvidenceItem[], input: EngineInput): EvidenceItem[] {
  const out = [...base];
  const clinicianNotes = input.baseline.filter((b) => b.source === 'CLINICIAN' && b.clinicianNote);
  for (const b of clinicianNotes) {
    out.push({
      kind: 'BASELINE',
      ref: `该患者个性化基线（${b.code}）`,
      text: b.clinicianNote!,
    });
  }
  // 医生在患者主页写的那句话本身可能不属于某个指标的 baseline 记录（例如写在患者级备注里），
  // 必须在「依据」里原样带出 —— 交班摘要也依赖这一行。
  if (input.patient.clinicianBaselineNote) {
    out.push({ kind: 'BASELINE', ref: '该患儿基线特点（随诊医师手写）', text: input.patient.clinicianBaselineNote });
  }
  const computed = input.baseline.filter((b) => b.source === 'COMPUTED');
  if (computed.length > 0) {
    out.push({
      kind: 'BASELINE',
      ref: '该患者个性化基线（系统推测）',
      text: computed.map((b) => `${b.code} ≈ ${b.baselineValue}`).join('；'),
    });
  }
  return out;
}

function mergeGaps(gaps: DataGap[], criticalMissing: Code[]): DataGap[] {
  const out = [...gaps];
  for (const code of criticalMissing) {
    if (!out.some((g) => g.code === code)) {
      out.push({ code, display: CODE_TABLE[code].display, priority: 0, reason: '关键指标缺失，风险可能被低估' });
    }
  }
  return out.sort((a, b) => a.priority - b.priority);
}

export type { EngineInput, EngineOutput, RiskLevel, ActionLevel, SafetyNetStatus, StandardProgress, TrendSignal };
