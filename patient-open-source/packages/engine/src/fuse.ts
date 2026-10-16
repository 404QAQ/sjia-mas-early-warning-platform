/**
 * 融合层：把 L1/L2/L3 的信号融合成三个正交维度 + 建议动作 + 数据缺口 + 信号指纹。
 *
 * 【工程初稿·需临床复核】设计文档（docs/02）只给了输入与输出维度，没有给融合表。
 * 这里的所有判断都由 ThresholdConfig.fusion 驱动，不得硬编码 —— 答辩时能说
 * 「阈值可配置，并在合作医院做回顾性校准」（docs/02 §10）。
 *
 * 两条必须遵守的原则：
 *   ① 界面上的「红」由行动分级决定，不由风险等级决定。一个无法触发任何行动的告警，
 *      无论数值多高，都不该显示为红色（红色是注意力货币，用一次少一次）。
 *   ② 敏感性优先，用分级机制与忽略留痕对冲假阳性，而不是把阈值调高（docs/01 §4.6）。
 */
import type {
  ActionLevel,
  AlertReason,
  DataGap,
  EvidenceItem,
  RiskLevel,
  SafetyNetStatus,
  ThresholdConfig,
} from '@mas/domain';
import { CODE_TABLE } from '@mas/domain';

export interface FuseInput {
  reasons: AlertReason[];
  cfg: ThresholdConfig;
  safetyNetStatus: SafetyNetStatus;
  safetyNetNote?: string;
  criticalMissing: string[];
  staleNotes: string[];
  /** 是否存在被「已处理」解释的临床干预（决定 HIGH + OBSERVE 这种组合） */
  explainedByIntervention?: boolean;
  /** 已满足的 2016 标准 */
  criteriaMet: boolean;
  /** 分数是否跨线，与输入完整性和升级资格分开，供连续值和模型分歧展示。 */
  msCrossed: boolean;
  msCanEscalate: boolean;
  trendOverridesScore: boolean;
  scoreValue: number | null;
  scoreCutoff: number;
  /** MS score 中按 0 代入的缺项；非空时分数与截断值的比较不能下确定结论。 */
  scoreMissingInputs?: string[];
  /** 数据缺口来源（未测项） */
  notMeasuredItems: Array<{ code: string; display: string }>;
}

export interface FuseOutput {
  riskLevel: RiskLevel;
  actionLevel: ActionLevel;
  reasons: AlertReason[];
  suggestions: string[];
  dataGaps: DataGap[];
  divergenceText?: string;
  signalFingerprint: string;
}

export function fuse(input: FuseInput): FuseOutput {
  const { cfg } = input;
  const reasons = [...input.reasons];

  // ---------- 风险等级 ----------
  const criticalHit = cfg.fusion.criticalSignals.some((key) => {
    if (key === 'CRITERIA_2016_MET') return input.criteriaMet;
    if (key === 'MS_SCORE_CROSSED') return input.msCrossed && input.msCanEscalate;
    return reasons.some((r) => r.code === key);
  });
  const s3 = reasons.filter((r) => r.severity === 3).length;
  const s2 = reasons.filter((r) => r.severity === 2).length;

  let riskLevel: RiskLevel;
  if (criticalHit) riskLevel = 'CRITICAL';
  else if (s3 >= cfg.fusion.highThreshold.severity3 && s2 >= cfg.fusion.highThreshold.severity2) riskLevel = 'HIGH';
  else if (s3 >= 1) riskLevel = 'HIGH';
  else if (s2 >= cfg.fusion.mediumThreshold.severity2) riskLevel = 'MEDIUM';
  else riskLevel = 'LOW';

  // ---------- 行动分级（与风险等级正交） ----------
  const actionable = reasons.filter((r) => r.actionability === 1 && r.severity >= 2);
  let actionLevel: ActionLevel;
  if (riskLevel === 'CRITICAL' || riskLevel === 'HIGH') {
    actionLevel = actionable.length > 0 ? 'ACT_NOW' : 'OBSERVE';
  } else if (riskLevel === 'MEDIUM') {
    actionLevel = actionable.length > 0 ? 'REVIEW' : 'OBSERVE';
  } else {
    actionLevel = 'OBSERVE';
  }
  // 已住院/已有干预且指标偏离可解释 → 灰色 + 一句解释，不是红色（docs/02 §6.2 推论）
  if (input.explainedByIntervention && actionLevel === 'ACT_NOW') {
    actionLevel = 'OBSERVE';
  }

  // ---------- 安全网：高危且停止记录 → 升一级（但升级的是行动，不是风险） ----------
  // 「临床风险：低 ｜ 安全网：无人响应」这个组合必须能表达，且引导到完全不同的动作。
  if (input.safetyNetStatus !== 'IN_CARE' && actionLevel === 'OBSERVE' && riskLevel === 'LOW') {
    actionLevel = 'REVIEW';
    reasons.push({
      code: 'SAFETY_NET',
      label: '安全网',
      detail: input.safetyNetNote ?? '安全网异常',
      source: 'SAFETY_NET',
      severity: 1,
      actionability: 1,
    });
  }

  // ---------- 建议动作：每条告警必须带可执行动作，不写「风险升高」 ----------
  const suggestions = buildSuggestions(reasons, input);

  // ---------- 数据缺口 ----------
  const dataGaps: DataGap[] = input.notMeasuredItems.map((item, idx) => ({
    code: item.code,
    display: item.display,
    priority: priorityOf(item.code, idx),
    reason: gapReason(item.code),
  }));
  for (const note of input.staleNotes) {
    dataGaps.push({ code: 'STALE', display: '数据陈旧', priority: 50, reason: note });
  }

  // ---------- 模型分歧提示（docs/02 §5.3） ----------
  let divergenceText: string | undefined;
  if (input.trendOverridesScore && input.scoreValue !== null && !input.msCrossed) {
    // 缺项按 0 代入时分数可能偏高也可能偏低（各项系数正负不同），
    // 不能对医生说「未跨越截断值」这种确定结论。
    const missing = input.scoreMissingInputs ?? [];
    divergenceText = missing.length
      ? `MS score ${input.scoreValue} 含缺项（${missing.join('、')}，按 0 代入），与截断值 ${input.scoreCutoff} 的比较仅供参考；趋势层给出高权重恶化信号 —— 两者不一致，建议人工复评。以趋势层为准。`
      : `MS score ${input.scoreValue}（未跨越截断值 ${input.scoreCutoff}），但趋势层给出高权重恶化信号 —— 两者不一致，建议人工复评。以趋势层为准。`;
  }

  return {
    riskLevel,
    actionLevel,
    reasons,
    suggestions,
    dataGaps: dataGaps.sort((a, b) => a.priority - b.priority),
    divergenceText,
    signalFingerprint: fingerprint(reasons),
  };
}

function buildSuggestions(reasons: AlertReason[], input: FuseInput): string[] {
  const out = new Set<string>();
  for (const r of reasons) {
    switch (r.code) {
      case 'CRITERIA_2016_MET':
        out.add('已满足 2016 分类标准，建议立即联系上级医师并复评');
        break;
      case 'CRITERIA_2016_NEAR':
        out.add('距 2016 标准仅差 1 项，建议加测剩余实验室项目');
        break;
      case 'CNS':
        out.add('立即急诊：抽搐 / 意识改变 / 剧烈头痛');
        break;
      case 'BLEEDING':
        out.add('联系家属确认出血情况，并复评凝血功能');
        break;
      case 'PLATELET_DROP':
        out.add('建议今日复查血常规，确认血小板下降速度');
        break;
      case 'FERRITIN_RISE':
        out.add('建议复评铁蛋白并加测甘油三酯 + 纤维蛋白原');
        break;
      case 'COMBO_PLT_FER':
        out.add('血小板与铁蛋白反向变化，建议今日复评');
        break;
      case 'ARTHRITIS_IMPROVED':
        out.add('关节症状减轻伴全身症状时，请勿按「好转」处理，建议复评炎症指标');
        break;
      case 'FEVER_RISING':
        out.add('联系家属确认当前症状，并复评发热模式');
        break;
      case 'INTERFERENCE_HINT':
        out.add('排除感染或肝损伤等干扰因素后再判断 MAS 风险');
        break;
      case 'SAFETY_NET':
        out.add('安排社会支持介入：联系患者与联系人，确认当前情况');
        break;
      default:
        break;
    }
  }
  if (input.criticalMissing.length > 0) {
    out.add(`建议补测关键指标：${input.criticalMissing.map((c) => CODE_TABLE[c as keyof typeof CODE_TABLE]?.display ?? c).join('、')}`);
  }
  if (input.notMeasuredItems.length > 0) {
    out.add(`建议加测 ${input.notMeasuredItems.map((i) => i.display).join(' + ')}`);
  }
  // 注意：永远不出现「风险升高」这类没有动作的句子
  return [...out];
}

function priorityOf(code: string, fallback: number): number {
  const table: Record<string, number> = {
    PLATELET: 1,
    FERRITIN: 2,
    TRIGLYCERIDE: 10,
    FIBRINOGEN: 11,
    LDH: 20,
    D_DIMER: 21,
    PCT: 30,
  };
  return table[code] ?? 90 + fallback;
}

function gapReason(code: string): string {
  const table: Record<string, string> = {
    PLATELET: '关键指标缺失，风险可能被低估',
    FERRITIN: '关键指标缺失，风险可能被低估',
    TRIGLYCERIDE: '2016 分类标准的实验室条件之一',
    FIBRINOGEN: '2016 分类标准的实验室条件之一',
    LDH: 'MS score 的输入项之一',
    D_DIMER: '提示凝血纤溶激活，需警惕出血',
    PCT: '用于区分感染通道的证据',
  };
  return table[code] ?? '用于缩小判读范围';
}

/**
 * 信号指纹：命中项 code 排序后的稳定 hash。
 * 用途：同一患者 6h 内重复产出同一指纹 → 合并，不重复告警（docs/01 §4.6）。
 * 不使用随机数，保证可重放。
 */
export function fingerprint(reasons: AlertReason[]): string {
  const keys = [...new Set(reasons.map((r) => r.code))].sort().join('|');
  return `fp_${fnv1a(keys)}`;
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function evidenceToItems(evidence: EvidenceItem[]): EvidenceItem[] {
  return evidence;
}
