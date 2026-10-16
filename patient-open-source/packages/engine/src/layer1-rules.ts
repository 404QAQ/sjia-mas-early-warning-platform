/**
 * L1 规则层：2016 分类标准（清单化）+ HLH-2004（辅助）+ 症状规则 + 安全网。
 *
 * 设计要点（docs/02 §3.1）：**不要显示「符合 / 不符合」，要显示「距离标准还差哪一项」。**
 * 理由：早期阶段本来就不符合标准，展示「距离」才是有用的信息。展示「不符合」等于告诉医生「没事」，
 * 但事实是「已经很近了」。
 */
import {
  SYMPTOMS,
  type AlertReason,
  type Code,
  type EvidenceItem,
  type SafetyNetState,
  type SafetyNetStatus,
  type Standard2016Item,
  type StandardProgress,
  type SymptomCode,
  type ThresholdConfig,
} from '@mas/domain';
import { CODE_TABLE } from '@mas/domain';
import { dailyMaxTemp, latest, recentSymptom, seriesOf, symptomCount, windowPoints, type SeriesBundle } from './series.js';
import { hoursBetween, pctChange, round, toMs } from './time.js';

export interface RuleLayerResult {
  standard: StandardProgress;
  /** 规则层产出的触发项（症状规则 + 安全网不计入 clinical，安全网单独返回） */
  reasons: AlertReason[];
  evidence: EvidenceItem[];
  hlh: { ferritinMet: boolean | 'NOT_MEASURED'; fibrinogenMet: boolean | 'NOT_MEASURED'; note: string };
  safetyNetStatus: SafetyNetStatus;
  safetyNetNote?: string;
  suggestedTests: string[];
  /** 关键指标是否缺失（docs/02 §7：风险可能被低估） */
  criticalMissing: Code[];
}

const GUIDELINE_2016: EvidenceItem = {
  kind: 'GUIDELINE',
  ref: '2016 EULAR/ACR/PRINTO classification criteria',
  text: '2016 EULAR/ACR/PRINTO 分类标准（敏感性约 73%、特异性 99%）',
};
const CONSENSUS_DYNAMIC: EvidenceItem = {
  kind: 'CONSENSUS',
  ref: '2016 consensus on dynamic laboratory markers',
  text: '2016 动态实验室指标共识（变化价值排序：血小板 > 铁蛋白 > AST）',
};
const CONSENSUS_HLH: EvidenceItem = {
  kind: 'CONSENSUS',
  ref: 'HLH-2004 guidelines',
  text: 'HLH-2004 诊断指标（辅助，不作主判据）',
};

export function layer1Rules(
  series: SeriesBundle,
  cfg: ThresholdConfig,
  safetyNet: SafetyNetState,
  now: string,
): RuleLayerResult {
  const nowMs = toMs(now);
  const reasons: AlertReason[] = [];

  // ---------- 2016 分类标准 ----------
  const ferritin = latest(seriesOf(series, 'FERRITIN'));
  const platelet = latest(seriesOf(series, 'PLATELET'));
  const ast = latest(seriesOf(series, 'AST'));
  const tg = latest(seriesOf(series, 'TRIGLYCERIDE'));
  const fib = latest(seriesOf(series, 'FIBRINOGEN'));

  const feverEvent = recentSymptom(series.symptoms, ['FEVER_HIGH'], nowMs, cfg.symptoms.recencyHours);
  const tempSeries = seriesOf(series, 'TEMP');
  const tempWindow = windowPoints(tempSeries, nowMs, cfg.symptoms.recencyHours);
  const tempRecent = tempWindow.filter((p) => p.value >= cfg.symptoms.feverHighC);
  const hasFever = Boolean(feverEvent) || tempRecent.length > 0;
  const feverActual = tempWindow.length ? Math.max(...tempWindow.map((p) => p.value)) : undefined;

  const items: Standard2016Item[] = [
    {
      key: 'FEVER',
      display: '发热',
      met: hasFever ? true : tempWindow.length ? false : 'NOT_MEASURED',
      actual: feverActual,
      threshold: cfg.symptoms.feverHighC,
      unit: '℃',
      gap: hasFever || feverActual === undefined ? undefined : round(cfg.symptoms.feverHighC - feverActual, 1),
      rule: `≥ ${cfg.symptoms.feverHighC}`,
    },
    {
      key: 'FERRITIN',
      display: '铁蛋白',
      met: ferritin ? ferritin.value > cfg.masRules.ferritinCutoff : 'NOT_MEASURED',
      actual: ferritin?.value,
      threshold: cfg.masRules.ferritinCutoff,
      unit: 'ng/mL',
      gap: ferritin && ferritin.value <= cfg.masRules.ferritinCutoff ? round(cfg.masRules.ferritinCutoff - ferritin.value, 0) : undefined,
      rule: `> ${cfg.masRules.ferritinCutoff}`,
    },
    {
      key: 'PLATELET',
      display: '血小板计数',
      met: platelet ? platelet.value <= cfg.masRules.plateletCutoff : 'NOT_MEASURED',
      actual: platelet?.value,
      threshold: cfg.masRules.plateletCutoff,
      unit: '10^9/L',
      gap: platelet && platelet.value > cfg.masRules.plateletCutoff ? round(platelet.value - cfg.masRules.plateletCutoff, 0) : undefined,
      rule: `≤ ${cfg.masRules.plateletCutoff}`,
    },
    {
      key: 'AST',
      display: 'AST',
      met: ast ? ast.value > cfg.masRules.astCutoff : 'NOT_MEASURED',
      actual: ast?.value,
      threshold: cfg.masRules.astCutoff,
      unit: 'U/L',
      gap: ast && ast.value <= cfg.masRules.astCutoff ? round(cfg.masRules.astCutoff - ast.value, 0) : undefined,
      rule: `> ${cfg.masRules.astCutoff}`,
    },
    {
      key: 'TRIGLYCERIDE',
      display: '甘油三酯',
      met: tg ? tg.value > cfg.masRules.triglycerideCutoff : 'NOT_MEASURED',
      actual: tg?.value,
      threshold: cfg.masRules.triglycerideCutoff,
      unit: 'mg/dL',
      gap: tg && tg.value <= cfg.masRules.triglycerideCutoff ? round(cfg.masRules.triglycerideCutoff - tg.value, 0) : undefined,
      rule: `> ${cfg.masRules.triglycerideCutoff}`,
    },
    {
      key: 'FIBRINOGEN',
      display: '纤维蛋白原',
      met: fib ? fib.value <= cfg.masRules.fibrinogenCutoff : 'NOT_MEASURED',
      actual: fib?.value,
      threshold: cfg.masRules.fibrinogenCutoff,
      unit: 'mg/dL',
      gap: fib && fib.value > cfg.masRules.fibrinogenCutoff ? round(fib.value - cfg.masRules.fibrinogenCutoff, 0) : undefined,
      rule: `≤ ${cfg.masRules.fibrinogenCutoff}`,
    },
  ];

  // 2016 标准的「四项实验室条件」是 血小板 / AST / 甘油三酯 / 纤维蛋白原；
  // 铁蛋白与发热属于「必要条件」，**不参与这四项计数**（这是很容易写错的一处）。
  const LAB_KEYS = ['PLATELET', 'AST', 'TRIGLYCERIDE', 'FIBRINOGEN'] as const;
  const labItems = items.filter((i) => (LAB_KEYS as readonly string[]).includes(i.key));
  const prerequisiteItems = items.filter((i) => i.key === 'FEVER' || i.key === 'FERRITIN');
  const labCriteriaMet = labItems.filter((i) => i.met === true).length;
  const prerequisitesMet = prerequisiteItems.every((i) => i.met === true);
  const satisfied = prerequisitesMet && labCriteriaMet >= 2;

  const notMeasured = labItems.filter((i) => i.met === 'NOT_MEASURED');
  const notMet = labItems.filter((i) => i.met === false);
  const suggestedTests: string[] = [];
  if (notMeasured.length > 0) suggestedTests.push(...notMeasured.map((i) => i.display));
  // 未满足但已接近（差距在阈值 25% 以内）的项也建议加测
  for (const i of notMet) {
    if (i.gap !== undefined && i.threshold !== undefined && i.gap <= i.threshold * 0.25 && !suggestedTests.includes(i.display)) {
      suggestedTests.push(i.display);
    }
  }

  const summary = satisfied
    ? `已满足 2016 标准 ${labCriteriaMet} 项实验室条件`
    : prerequisitesMet
      ? `必要条件已满足，实验室条件满足 ${labCriteriaMet} 项（需 ≥ 2 项）`
      : `尚未满足必要条件（发热 + 铁蛋白 > ${cfg.masRules.ferritinCutoff}）`;

  const standard: StandardProgress = {
    prerequisitesMet,
    labCriteriaMet,
    satisfied,
    items,
    suggestedTests,
    summary,
  };

  if (satisfied) {
    reasons.push({
      code: 'CRITERIA_2016_MET',
      label: '2016 分类标准',
      detail: `${summary}（${labItems.filter((i) => i.met === true).map((i) => i.display).join('、')}）`,
      threshold: '≥2 项 + 必要条件',
      source: 'GUIDELINE_2016',
      severity: 3,
      actionability: 1,
    });
  } else if (prerequisitesMet && labCriteriaMet === 1) {
    const near = notMet.find((i) => i.gap !== undefined);
    reasons.push({
      code: 'CRITERIA_2016_NEAR',
      label: '2016 分类标准（接近）',
      detail: `已满足 1 项实验室条件${near ? `，${near.display} ${near.actual} 距阈值差 ${near.gap}` : ''}`,
      source: 'GUIDELINE_2016',
      severity: 2,
      actionability: 1,
    });
  }

  // ---------- HLH-2004（辅助） ----------
  const hlhFerritin = ferritin ? ferritin.value >= 500 : ('NOT_MEASURED' as const);
  const hlhFibrinogen = fib ? fib.value <= 150 : ('NOT_MEASURED' as const);
  // ⚠ 两套纤维蛋白原阈值（2016 的 360 与 HLH 的 150）必须分开判读，不可混用
  const hlh = {
    ferritinMet: hlhFerritin,
    fibrinogenMet: hlhFibrinogen,
    note: 'HLH-2004 用纤维蛋白原 ≤150 mg/dL；2016 标准用 ≤360 mg/dL。同一份结果可能「满足 2016 但不满足 HLH」，这是正常的。',
  };

  // ---------- 症状规则（docs/02 §8） ----------
  const symptomRules: Array<{
    code: SymptomCode;
    label: string;
    severity: 1 | 2 | 3;
    actionability: 0 | 1;
    detail: (n: number) => string;
  }> = [
    {
      code: 'BLEEDING',
      label: '出血表现',
      severity: 3,
      actionability: 1,
      detail: () => '家长/患者报告出血表现（牙龈 / 鼻 / 皮肤瘀点）',
    },
    {
      code: 'CNS',
      label: '中枢神经系统受累',
      severity: 3,
      actionability: 1,
      detail: () => '报告抽搐 / 意识改变 / 剧烈头痛 —— 需立即急诊',
    },
    {
      code: 'LETHARGY',
      label: '精神差 / 嗜睡',
      severity: 3,
      actionability: 1,
      detail: () => '报告精神差、嗜睡或叫不醒',
    },
    {
      code: 'ARTHRITIS_IMPROVED',
      label: '关节症状减轻',
      severity: 3,
      actionability: 1,
      detail: () => '关节症状减轻（关节炎在 MS score 中为负权重：MAS 活动时关节症状反而可能减轻）',
    },
    {
      code: 'RASH',
      label: '皮疹（新发或加重）',
      severity: 2,
      actionability: 0,
      detail: () => '报告皮疹新发或加重',
    },
    {
      code: 'ANOREXIA',
      label: '拒食',
      severity: 2,
      actionability: 0,
      detail: () => '报告拒食或进食明显减少',
    },
    {
      code: 'GI',
      label: '腹痛 / 呕吐',
      severity: 2,
      actionability: 0,
      detail: () => '报告腹痛 / 呕吐（需与药物副作用鉴别）',
    },
    {
      code: 'MEDICATION_URGENT',
      label: '药物副作用紧急报告',
      severity: 3,
      actionability: 1,
      detail: () => '报告需要立即联系医生的药物副作用',
    },
  ];

  for (const rule of symptomRules) {
    const n = symptomCount(series.symptoms, rule.code, nowMs, cfg.symptoms.recencyHours);
    if (n === 0) continue;
    reasons.push({
      code: rule.code,
      label: rule.label,
      detail: rule.detail(n),
      source: 'SYMPTOM_RULE',
      severity: rule.severity,
      actionability: rule.actionability,
    });
  }

  // 发热峰值持续上升（连续 ≥3 天）—— 比单次高热更有价值
  const feverHighCount = symptomCount(series.symptoms, 'FEVER_HIGH', nowMs, cfg.symptoms.recencyHours);
  const daily = dailyMaxTemp(tempSeries, nowMs, cfg.symptoms.feverRisingDays + 2);
  const risingDays = countRisingDays(daily, cfg.symptoms.feverHighC);
  if (risingDays >= cfg.symptoms.feverRisingDays) {
    const tail = daily.slice(-risingDays);
    reasons.push({
      code: SYMPTOMS.FEVER_RISING,
      label: '发热峰值持续上升',
      detail: `近 ${risingDays} 天最高体温分别是 ${tail.map((d) => round(d.value, 1)).join(' / ')}℃ —— 在往上走`,
      source: 'SYMPTOM_RULE',
      severity: 3,
      actionability: 1,
    });
  } else if (feverHighCount > 0 || tempRecent.length > 0) {
    const max = feverActual !== undefined ? round(feverActual, 1) : undefined;
    reasons.push({
      code: SYMPTOMS.FEVER_HIGH,
      label: '持续高热',
      detail: max !== undefined ? `体温最高 ${max}℃（≥ ${cfg.symptoms.feverHighC}℃）` : '报告持续高热',
      threshold: cfg.symptoms.feverHighC,
      unit: '℃',
      actual: max,
      source: 'SYMPTOM_RULE',
      severity: 2,
      actionability: 0,
    });
  }

  if (series.rejectedTotal > 0) {
    reasons.push({
      code: 'DATA_QUALITY_UNIT',
      label: '数据质量',
      detail: `有 ${series.rejectedTotal} 条记录因单位或数值无效未参与判读，请核对原始记录`,
      source: 'SAFETY_NET',
      severity: 1,
      actionability: 1,
    });
  }

  // ---------- 安全网（不进临床风险） ----------
  const criticalMissing: Code[] = [];
  for (const c of ['PLATELET', 'FERRITIN'] as Code[]) {
    if (!seriesOf(series, c) || seriesOf(series, c)!.points.length === 0) criticalMissing.push(c);
  }

  const sn = evaluateSafetyNet(safetyNet, series, cfg, nowMs, reasons.some((r) => r.severity === 3));

  return {
    standard,
    reasons,
    evidence: [GUIDELINE_2016, CONSENSUS_DYNAMIC, CONSENSUS_HLH],
    hlh,
    safetyNetStatus: sn.status,
    safetyNetNote: sn.note,
    suggestedTests,
    criticalMissing,
  };
}

function countRisingDays(daily: Array<{ date: string; value: number }>, feverHighC: number): number {
  if (daily.length < 2 || daily[daily.length - 1]!.value < feverHighC) return 0;
  let streak = 1;
  for (let i = daily.length - 1; i > 0; i -= 1) {
    const dayGap = Date.parse(`${daily[i]!.date}T00:00:00Z`) - Date.parse(`${daily[i - 1]!.date}T00:00:00Z`);
    if (dayGap === 86_400_000 && daily[i - 1]!.value >= feverHighC && daily[i]!.value > daily[i - 1]!.value) streak += 1;
    else break;
  }
  return streak;
}

/**
 * 安全网规则（docs/02 §3.3）：不看数值，看「有没有失联」。
 * 产出的是安全网状态这一独立维度，**不计入临床风险**。
 */
export function evaluateSafetyNet(
  net: SafetyNetState,
  series: SeriesBundle,
  cfg: ThresholdConfig,
  nowMs: number,
  clinicalHighRisk: boolean,
): { status: SafetyNetStatus; note?: string } {
  const lastActive = net.lastActiveAt ?? series.latestObservedAt;
  const silentHours = lastActive ? hoursBetween(nowMs, toMs(lastActive)) : null;

  // 一二级联系人在 30min 内均无响应 → 无人响应
  if (net.contactsUnresponsive) {
    return {
      status: 'NO_RESPONSE',
      note: '一二级联系人在规定时间内均无响应 —— 这不是医学问题，是「谁去联系一下」的问题',
    };
  }
  // 独居 + 高风险 + 超过阈值无响应 → 无人响应
  if (net.isLivingAlone && clinicalHighRisk && silentHours !== null && silentHours >= cfg.safetyNet.livingAloneNoRecordHours) {
    return {
      status: 'NO_RESPONSE',
      note: `独居患者已 ${Math.floor(silentHours)} 小时无任何记录，且当前风险偏高`,
    };
  }
  // 停止记录：高危患者 > 12h 无任何记录 → 升一级（在融合层处理升级）
  if (clinicalHighRisk && silentHours !== null && silentHours >= cfg.safetyNet.noRecordHoursHighRisk) {
    return {
      status: 'PENDING',
      note: `高危患者已 ${Math.floor(silentHours)} 小时无任何记录`,
    };
  }
  if (net.hasPendingNotification) {
    return { status: 'PENDING', note: '已发出通知，尚未收到确认' };
  }
  return { status: 'IN_CARE' };
}

export function ferritinBaselineDeviationReason(
  current: number,
  baseline: number,
  cfg: ThresholdConfig,
): AlertReason | null {
  if (baseline === 0) return null;
  const ratio = current / baseline;
  if (ratio < cfg.trend.baselineDeviationFactor) return null;
  return {
    code: 'FERRITIN_VS_BASELINE',
    label: '铁蛋白高于该患儿基线',
    detail: `铁蛋白高于该患儿基线 ${round(ratio, 1)} 倍（基线 ${round(baseline, 0)}）`,
    actual: round(current, 0),
    threshold: round(baseline * cfg.trend.baselineDeviationFactor, 0),
    unit: 'ng/mL',
    source: 'BASELINE_COMPUTED',
    severity: 2,
    actionability: 1,
  };
}

export function plateletDropReason(
  fromValue: number,
  toValue: number,
  hours: number,
  cfg: ThresholdConfig,
): AlertReason | null {
  const change = pctChange(fromValue, toValue);
  if (change === null) return null;
  const drop = -change;
  if (drop < cfg.trend.plateletDrop48hWarning) return null;
  const severity: 1 | 2 | 3 = drop >= cfg.trend.plateletDrop48hCritical ? 3 : 2;
  return {
    code: 'PLATELET_DROP',
    label: '血小板下降',
    detail: `血小板 ${hours}h 内 ${round(fromValue, 0)}→${round(toValue, 0)}（↓${Math.round(drop * 100)}%）`,
    actual: round(toValue, 0),
    threshold: `↓${Math.round(cfg.trend.plateletDrop48hWarning * 100)}%`,
    unit: '10^9/L',
    source: 'CONSENSUS_2016_DYNAMIC',
    severity,
    actionability: severity === 3 ? 1 : 1,
  };
}

export function ferritinRiseReason(fromValue: number, toValue: number, hours: number, cfg: ThresholdConfig): AlertReason | null {
  const change = pctChange(fromValue, toValue);
  if (change === null) return null;
  if (change < cfg.trend.ferritinRise24hWarning) return null;
  return {
    code: 'FERRITIN_RISE',
    label: '铁蛋白急剧升高',
    detail: `铁蛋白 ${hours}h 内 ${round(fromValue, 0)}→${round(toValue, 0)}（↑${Math.round(change * 100)}%）`,
    actual: round(toValue, 0),
    threshold: `↑${Math.round(cfg.trend.ferritinRise24hWarning * 100)}%`,
    unit: 'ng/mL',
    source: 'CONSENSUS_2016_DYNAMIC',
    severity: change >= 1.0 ? 3 : 2,
    actionability: 1,
  };
}

export function missingCriticalNote(criticalMissing: Code[]): string | null {
  if (criticalMissing.length === 0) return null;
  return `因缺少关键指标（${criticalMissing.map((c) => CODE_TABLE[c]?.display ?? c).join('、')}），风险可能被低估`;
}
