import type {
  AlertReason,
  DataGap,
  DifferentialChannel,
  DifferentialChannelKey,
  DifferentialConfig,
  EngineInput,
  StandardProgress,
  ThresholdConfig,
  TrendSignal,
} from '@mas/domain';
import { CODE_TABLE, DIFFERENTIAL_RULE_DIRECTIONS } from '@mas/domain';
import { effectiveBaselineValue } from './baseline.js';
import { latest, recentSymptom, seriesOf, type SeriesBundle } from './series.js';
import { toMs } from './time.js';

const CHANNEL_ORDER: DifferentialChannelKey[] = ['MAS_SUPPORT', 'SJIA_FLARE_SUPPORT', 'INFECTION_SUPPORT', 'OTHER_SUPPORT'];
const CHANNEL_DISPLAY: Record<DifferentialChannelKey, string> = {
  MAS_SUPPORT: '支持 MAS',
  SJIA_FLARE_SUPPORT: '支持 sJIA 活动',
  INFECTION_SUPPORT: '支持感染',
  OTHER_SUPPORT: '支持其他',
};

const GAP_DISPLAY: Record<string, string> = {
  PLATELET: '血小板',
  FIBRINOGEN: '纤维蛋白原',
  FERRITIN: '铁蛋白或个体基线',
  FERRITIN_BASELINE: '铁蛋白个体基线',
  FERRITIN_TREND: '铁蛋白趋势数据',
  AST: 'AST',
  LDH: 'LDH',
  D_DIMER: 'D-二聚体',
  PCT: '降钙素原',
  WBC: '白细胞与分类',
  EBV_CMV: 'EBV / CMV 血清学',
  LIVER_SPLEEN_EXAM: '肝脾体格检查',
  FEVER_PATTERN: '发热模式',
  JOINT_DIRECTION: '关节方向性评估',
  CULTURE: '血 / 尿 / 痰培养',
  FOCUS_FOUND: '感染灶记录',
  DISEASE_SCOPE: '病种适用范围',
};

interface DifferentialContext {
  cfg: ThresholdConfig;
  configVersion: string;
  differential: DifferentialConfig;
  reasons: AlertReason[];
  standard: StandardProgress;
  trends: TrendSignal[];
  baseline: EngineInput['baseline'];
  series: SeriesBundle;
  joints: EngineInput['joints'];
  diseaseType: EngineInput['patient']['diseaseType'];
  /** 快照时刻；缺失时对依赖时效的规则 fail-closed。 */
  now?: EngineInput['now'];
}

interface RuleEvidence {
  detail: string;
  source: NonNullable<DifferentialChannel['items'][number]['source']>;
  inputRefs: string[];
}

interface RuleResult {
  evidence?: RuleEvidence;
  gap?: string;
}

export interface DifferentialEvaluation {
  channels: DifferentialChannel[];
  dataGaps: DataGap[];
}

/**
 * 阶段 0 的证据板：只消费已经过滤、排序的引擎输入和既有 L1/L2 结果。
 * 配置缺失或未复核时 fail-closed，避免把工程初稿显示成临床定案。
 */
export function evaluateDifferential(context: Omit<DifferentialContext, 'differential'> & { differential?: DifferentialConfig }): DifferentialEvaluation {
  const differential = context.differential;
  if (!differential || !differential.reviewed) return { channels: [], dataGaps: [] };

  const normalized: DifferentialContext = { ...context, differential };
  const channels = CHANNEL_ORDER.map((key) => evaluateChannel(key, normalized));
  applyConflicts(channels);
  return { channels, dataGaps: buildDataGaps(channels, differential.dataGapPriority) };
}

function evaluateChannel(key: DifferentialChannelKey, context: DifferentialContext): DifferentialChannel {
  const config = context.differential.channels.find((channel) => channel.key === key);
  const items: DifferentialChannel['items'] = [];
  const gaps = new Set<string>();
  for (const rule of config?.items ?? []) {
    // sJIA 活动是疾病专属解释；AOSD 不套用该通道的规则。
    if (key === 'SJIA_FLARE_SUPPORT' && context.diseaseType !== 'sJIA') {
      gaps.add('DISEASE_SCOPE');
      continue;
    }
    if (context.diseaseType === 'AOSD' && key === 'MAS_SUPPORT' && ['CRITERIA_2016_MET', 'CRITERIA_2016_NEAR'].includes(rule.code)) {
      gaps.add('DISEASE_SCOPE');
      continue;
    }
    const result = evaluateRule(rule.code, rule.direction, rule.threshold, context);
    if (result.evidence) {
      items.push({
        code: rule.code,
        detail: result.evidence.detail,
        weight: rule.weight,
        direction: rule.direction,
        source: result.evidence.source,
        ruleVersion: context.differential.ruleVersion,
        configVersion: context.configVersion,
        inputRefs: result.evidence.inputRefs,
      });
    }
    if (result.gap) gaps.add(result.gap);
  }
  const score = items.reduce((sum, item) => sum + item.weight, 0);
  const strength = score >= context.differential.strengthThresholds.strong
    ? 'STRONG'
    : score >= context.differential.strengthThresholds.medium
      ? 'MEDIUM'
      : score > 0 ? 'WEAK' : undefined;
  return {
    key,
    display: CHANNEL_DISPLAY[key],
    evidenceCount: items.filter((item) => item.weight > 0).length,
    negativeEvidenceCount: items.filter((item) => item.weight < 0).length,
    ...(strength ? { strength } : {}),
    items,
    gaps: [...gaps],
  };
}

function evaluateRule(code: string, direction: string, threshold: number | undefined, context: DifferentialContext): RuleResult {
  const allowedDirections = DIFFERENTIAL_RULE_DIRECTIONS[code];
  if (allowedDirections && !allowedDirections.includes(direction)) return { gap: `RULE:${code}:DIRECTION_MISMATCH` };
  const standardItem = (key: StandardProgress['items'][number]['key']) => context.standard.items.find((item) => item.key === key);
  const latestValue = (codeName: keyof typeof CODE_TABLE) => latest(seriesOf(context.series, codeName));
  const missing = (gap: string): RuleResult => ({ gap });
  const noEvidence = (): RuleResult => ({});
  const thresholdMismatch = expectedThresholdMismatch(code, threshold, context.cfg);
  if (thresholdMismatch) return { gap: thresholdMismatch };
  const reason = findReason(code, context.reasons);
  if (reason) return { evidence: { detail: reason.detail, source: sourceFor(code), inputRefs: [`reason:${reason.code}`] } };

  if (code === 'FERRITIN_VS_BASELINE') {
    const signal = context.trends.find((item) => item.code === 'FERRITIN' && item.kind === 'BASELINE_DEVIATION' && item.direction === 'UP');
    if (signal) {
      const latestFerritin = latest(seriesOf(context.series, 'FERRITIN'));
      return { evidence: { detail: signal.semanticLabel, source: 'BASELINE', inputRefs: ['trend:FERRITIN:BASELINE_DEVIATION', ...(latestFerritin ? [`series:FERRITIN:${latestFerritin.at}`] : [])] } };
    }
    const ferritin = seriesOf(context.series, 'FERRITIN');
    if (!ferritin?.points.length) return { gap: 'FERRITIN' };
    if (effectiveBaselineValue(context.baseline, 'FERRITIN') === null) return { gap: 'FERRITIN_BASELINE' };
    return ferritin.points.length < context.cfg.trend.minPointsForTrend ? { gap: 'FERRITIN_TREND' } : noEvidence();
  }

  switch (code) {
    case 'FIBRINOGEN': {
      const item = standardItem('FIBRINOGEN');
      if (!item || item.met === 'NOT_MEASURED') return missing('FIBRINOGEN');
      if (direction === 'DOWN' && item.met === true) return { evidence: { detail: formatStandard(item), source: 'OBSERVATION', inputRefs: standardInputRefs(context, 'FIBRINOGEN') } };
      if ((direction === 'NORMAL_OR_UP' || direction === 'UP') && item.met === false) return { evidence: { detail: formatStandard(item), source: 'OBSERVATION', inputRefs: standardInputRefs(context, 'FIBRINOGEN') } };
      return noEvidence();
    }
    case 'AST': {
      const item = standardItem('AST');
      if (!item || item.met === 'NOT_MEASURED') return missing('AST');
      if (direction === 'UP' && item.met === true) return { evidence: { detail: formatStandard(item), source: 'OBSERVATION', inputRefs: standardInputRefs(context, 'AST') } };
      return noEvidence();
    }
    case 'PLATELET':
    case 'PLATELET_NORMAL_OR_UP': {
      const item = standardItem('PLATELET');
      if (!item || item.met === 'NOT_MEASURED') return missing('PLATELET');
      if (direction === 'NORMAL_OR_UP' && item.met === false) return { evidence: { detail: formatStandard(item), source: 'OBSERVATION', inputRefs: standardInputRefs(context, 'PLATELET') } };
      return noEvidence();
    }
    case 'FIBRINOGEN_NORMAL_OR_UP': {
      const item = standardItem('FIBRINOGEN');
      if (!item || item.met === 'NOT_MEASURED') return missing('FIBRINOGEN');
      if (item.met === false) return { evidence: { detail: formatStandard(item), source: 'OBSERVATION', inputRefs: standardInputRefs(context, 'FIBRINOGEN') } };
      return noEvidence();
    }
    case 'ARTHRITIS_WORSENED': {
      const joint = latestUsableJoint(context.joints);
      if (!joint) return missing('JOINT_DIRECTION');
      if (joint.trendFlag === 'WORSENED' || joint.activityLevel === 'SEVERE') return { evidence: { detail: `关节方向评估：${joint.trendFlag === 'WORSENED' ? '较前恶化' : '活动能力严重受限'}`, source: 'JOINT', inputRefs: [`joint:${joint.observedAt}`] } };
      return noEvidence();
    }
    case 'PCT':
    case 'FERRITIN_EXTREME': {
      const seriesCode = code === 'PCT' ? 'PCT' : 'FERRITIN';
      const point = latestValue(seriesCode);
      if (!point) return missing(seriesCode);
      if (threshold === undefined) return missing(`${seriesCode}_THRESHOLD`);
      if (point.value > threshold) return { evidence: { detail: `${CODE_TABLE[seriesCode].display} ${point.value} ${point.unit}（> ${threshold}）`, source: 'OBSERVATION', inputRefs: [`series:${seriesCode}:${point.at}`] } };
      return noEvidence();
    }
    case 'CNS_INVOLVEMENT':
    case 'BLEEDING': {
      const symptomReason = context.reasons.find((item) => item.code === (code === 'CNS_INVOLVEMENT' ? 'CNS' : 'BLEEDING'));
      if (symptomReason) return { evidence: { detail: symptomReason.detail, source: 'SYMPTOM', inputRefs: [`reason:${symptomReason.code}`] } };
      return noEvidence();
    }
    case 'FEVER_PATTERN': {
      /*
       * A2.2（发热模式自动分类）尚未完成临床定义和准确率验证。
       * 仅有体温序列时，不能从每日最高值推断“峰值间不降”或“间歇期降至正常”；
       * 否则稀疏单点、陈旧数据会被误报成热型。当前只接受时效窗口内的显式
       * FEVER_HIGH 症状作为 CONTINUOUS 证据，其他情况保持缺口。
       */
      if (!context.now) return missing('FEVER_PATTERN');
      const feverHigh = recentSymptom(
        context.series.symptoms,
        ['FEVER_HIGH'],
        toMs(context.now),
        context.cfg.symptoms.recencyHours,
      );
      if (!feverHigh) return missing('FEVER_PATTERN');
      if (direction !== 'CONTINUOUS') return missing('FEVER_PATTERN');
      const reason = findReason('FEVER_HIGH', context.reasons);
      return {
        evidence: {
          detail: reason?.detail ?? '当前时效窗口内报告持续高热',
          source: 'SYMPTOM',
          inputRefs: [`symptom:FEVER_HIGH:${feverHigh.at}`],
        },
      };
    }
    case 'CULTURE':
      return missing('CULTURE');
    case 'FOCUS_FOUND':
      return missing('FOCUS_FOUND');
    case 'EBV_CMV':
      return missing('EBV_CMV');
    case 'WBC':
      return seriesOf(context.series, 'WBC')?.points.length ? missing('RULE:WBC') : missing('WBC');
    case 'LDH':
      return seriesOf(context.series, 'LDH')?.points.length ? missing('RULE:LDH') : missing('LDH');
    case 'D_DIMER':
      return seriesOf(context.series, 'D_DIMER')?.points.length ? missing('RULE:D_DIMER') : missing('D_DIMER');
    case 'ARTHRITIS_IMPROVED': {
      const joint = latestUsableJoint(context.joints);
      if (!joint) return missing('JOINT_DIRECTION');
      if (joint.trendFlag === 'IMPROVED') return { evidence: { detail: '关节方向评估：较前改善', source: 'JOINT', inputRefs: [`joint:${joint.observedAt}`] } };
      if (joint.trendFlag === undefined) return missing('JOINT_DIRECTION');
      return noEvidence();
    }
    default:
      return missing(`RULE:${code}`);
  }
}

function latestUsableJoint(joints: EngineInput['joints']): EngineInput['joints'][number] | undefined {
  return joints.filter((joint) => joint.dataQuality !== 'CONFLICT').at(-1);
}

function expectedThresholdMismatch(code: string, threshold: number | undefined, cfg: ThresholdConfig): string | undefined {
  if (threshold === undefined) return undefined;
  const expected: Record<string, number | undefined> = {
    PLATELET: cfg.masRules.plateletCutoff,
    PLATELET_NORMAL_OR_UP: cfg.masRules.plateletCutoff,
    PLATELET_DROP_48H: cfg.trend.plateletDrop48hWarning,
    FERRITIN_VS_BASELINE: cfg.trend.baselineDeviationFactor,
    AST: cfg.masRules.astCutoff,
    FIBRINOGEN: cfg.masRules.fibrinogenCutoff,
    FIBRINOGEN_NORMAL_OR_UP: cfg.masRules.fibrinogenCutoff,
  };
  const value = expected[code];
  return value !== undefined && value !== threshold ? `RULE:${code}:THRESHOLD_MISMATCH` : undefined;
}

function findReason(code: string, reasons: AlertReason[]): AlertReason | undefined {
  const map: Record<string, string> = {
    PLATELET_DROP_48H: 'PLATELET_DROP',
    FERRITIN_VS_BASELINE: 'FERRITIN_VS_BASELINE',
    ARTHRITIS_IMPROVED: 'ARTHRITIS_IMPROVED',
    ESR_CRP_DIVERGENCE: 'INTERFERENCE_HINT',
  };
  const reasonCode = map[code] ?? code;
  return reasons.find((reason) => reason.code === reasonCode);
}

function sourceFor(code: string): NonNullable<DifferentialChannel['items'][number]['source']> {
  if (['CNS_INVOLVEMENT', 'BLEEDING', 'ARTHRITIS_IMPROVED'].includes(code)) return 'SYMPTOM';
  if (code === 'FERRITIN_VS_BASELINE') return 'BASELINE';
  return 'OBSERVATION';
}

function formatStandard(item: StandardProgress['items'][number]): string {
  if (item.actual === undefined) return `${item.display}：已测，但没有可展示的数值`;
  return `${item.display} ${item.actual}${item.unit ? ` ${item.unit}` : ''}（${item.rule}）`;
}

function standardInputRefs(context: DifferentialContext, code: 'PLATELET' | 'FIBRINOGEN' | 'AST'): string[] {
  const point = latest(seriesOf(context.series, code));
  return point ? [`series:${code}:${point.at}`] : [`standard2016:${code}`];
}

function applyConflicts(channels: DifferentialChannel[]): void {
  const mas = channels.find((channel) => channel.key === 'MAS_SUPPORT');
  const sjia = channels.find((channel) => channel.key === 'SJIA_FLARE_SUPPORT');
  if (!mas || !sjia) return;
  const pairs: Array<[{ code: string; direction?: string }, { code: string; direction?: string }, string]> = [
    [{ code: 'ARTHRITIS_IMPROVED' }, { code: 'ARTHRITIS_WORSENED' }, '关节方向证据冲突'],
    [{ code: 'PLATELET_DROP_48H' }, { code: 'PLATELET', direction: 'NORMAL_OR_UP' }, '血小板方向证据冲突'],
    [{ code: 'FIBRINOGEN', direction: 'DOWN' }, { code: 'FIBRINOGEN', direction: 'NORMAL_OR_UP' }, '纤维蛋白原方向证据冲突'],
  ];
  const notes: string[] = [];
  for (const [left, right, label] of pairs) {
    const matches = (item: DifferentialChannel['items'][number], expected: { code: string; direction?: string }) =>
      item.code === expected.code && (expected.direction === undefined || item.direction === expected.direction);
    const rightMatches = (item: DifferentialChannel['items'][number]) =>
      matches(item, right) || (right.code === 'PLATELET' && item.code === 'PLATELET_NORMAL_OR_UP' && item.direction === right.direction);
    if (mas.items.some((item) => matches(item, left)) && sjia.items.some(rightMatches)) {
      notes.push(label);
    }
  }
  if (notes.length > 0) {
    const note = `${notes.join('；')}，请复核数据来源与时间；证据板不作诊断结论`;
    mas.conflictNote = note;
    sjia.conflictNote = note;
  }
}

function buildDataGaps(channels: DifferentialChannel[], order: string[]): DataGap[] {
  const unique = new Set(channels.flatMap((channel) => channel.gaps));
  return [...unique]
    .map((code) => {
      const priority = order.indexOf(code);
      const actualPriority = priority < 0 ? order.length : priority;
      const display = GAP_DISPLAY[code] ?? (code.startsWith('RULE:') ? `规则 ${code.slice(5)}` : code);
      return { code, display, priority: actualPriority, reason: code.startsWith('RULE:') ? '配置项尚未接入可验证的采集来源' : '当前没有足够输入支持该项判读' };
    })
    .sort((a, b) => a.priority - b.priority || a.code.localeCompare(b.code));
}
