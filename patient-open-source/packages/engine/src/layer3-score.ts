/**
 * L3 评分层：MS score（Ravelli 等提出，2016/2019 经 PRINTO 更新；AUC 0.97）。
 *
 * ⚠ 系数来自二手资料，实施前必须核对原始文献（docs/09 A1.1 是阻断项）。
 * 因此系数全部走配置，界面要标注「依据 MS score（系数待与原始文献核对）」。
 *
 * 在产品中的三个用途（docs/02 §5.3）：
 *   1. 连续值曲线  2. 截断值参考线（−2.1）  3. Δ MS score
 * 并必须说明局限：MS score 是群体模型，它不知道「这个孩子的基线」。
 */
import type { MsScoreResult, ThresholdConfig } from '@mas/domain';
import { CODE_TABLE } from '@mas/domain';
import { latest, recentSymptom, seriesOf, type SeriesBundle } from './series.js';
import { round, toMs } from './time.js';

export interface ScoreLayerInput {
  series: SeriesBundle;
  cfg: ThresholdConfig;
  now: string;
  /** 关节炎是否有活动记录（来自关节评估或症状码；负数权重项，MAS 活动时关节症状反而可能减轻） */
  arthritisActive: boolean | null;
  /** 上一次的 MS score，用于 Δ */
  previous?: number | null;
}

export function layer3Score(input: ScoreLayerInput): MsScoreResult {
  const { series, cfg, now } = input;
  const nowMs = toMs(now);
  if (input.previous !== undefined && input.previous !== null && !Number.isFinite(input.previous)) throw new RangeError('上一 MS score 必须是有限数值');
  const c = cfg.masRules.msScoreCoefficients;

  const missingInputs: string[] = [];

  const cns = recentSymptom(series.symptoms, ['CNS'], nowMs, 24 * 7) ? 1 : 0;
  const bleeding = recentSymptom(series.symptoms, ['BLEEDING'], nowMs, 24 * 7) ? 1 : 0;
  // 当前模型只存阳性症状；无记录不等于医生明确评估为阴性。
  // 保留缺项按 0 的参考值，但缺项不能作为独立升级依据。
  if (!cns) missingInputs.push('中枢神经系统表现');
  if (!bleeding) missingInputs.push('出血表现');

  let arthritisTerm: number | null = null;
  if (input.arthritisActive === null) {
    missingInputs.push('关节炎活动度');
    arthritisTerm = 0; // 缺项按 0 代入，但必须标注
  } else {
    arthritisTerm = input.arthritisActive ? 1 : 0;
  }

  const platelet = latest(seriesOf(series, 'PLATELET'));
  const ldh = latest(seriesOf(series, 'LDH'));
  const fibrinogen = latest(seriesOf(series, 'FIBRINOGEN'));
  const ferritin = latest(seriesOf(series, 'FERRITIN'));

  if (!platelet) missingInputs.push(CODE_TABLE.PLATELET.display);
  if (!ldh) missingInputs.push(CODE_TABLE.LDH.display);
  if (!fibrinogen) missingInputs.push(CODE_TABLE.FIBRINOGEN.display);
  if (!ferritin) missingInputs.push(CODE_TABLE.FERRITIN.display);

  // 四项实验室输入全缺时不给分数 —— 一个由 0 组成的分数比没有分数更危险
  const labMissingCount = [platelet, ldh, fibrinogen, ferritin].filter((x) => !x).length;
  if (labMissingCount === 4) {
    return {
      value: null,
      cutoff: cfg.masRules.msScoreCutoff,
      missingInputs,
      crossed: false,
      confidence: 'PARTIAL',
    };
  }

  const value =
    c.cns * cns +
    c.bleeding * bleeding +
    c.arthritis * (arthritisTerm ?? 0) +
    c.platelet * (platelet?.value ?? 0) +
    c.ldh * (ldh?.value ?? 0) +
    c.fibrinogen * (fibrinogen?.value ?? 0) +
    c.ferritin * (ferritin?.value ?? 0);

  const rounded = round(value, 2);
  const crossed = rounded > cfg.masRules.msScoreCutoff;
  const delta = input.previous !== undefined && input.previous !== null ? round(rounded - input.previous, 2) : undefined;

  return {
    value: rounded,
    cutoff: cfg.masRules.msScoreCutoff,
    delta,
    missingInputs,
    crossed,
    confidence: missingInputs.length === 0 ? 'FULL' : 'PARTIAL',
  };
}

/** 缺项评分仅供观察，不允许独立升级；这是输入完整性守卫，不是临床系数校准。 */
export function canEscalateOnScoreOnly(score: MsScoreResult): boolean {
  return score.value !== null && score.missingInputs.length === 0;
}
