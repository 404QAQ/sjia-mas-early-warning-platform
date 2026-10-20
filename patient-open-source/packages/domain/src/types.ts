/**
 * 患者端与风险评估共享类型。字段名与公开契约保持一致，便于跨端对照。
 * 时间统一用 ISO 8601 字符串（带时区），不用 Date 对象跨层传递。
 */

import type { Code, ObservationSource, SymptomCode } from './codes.js';
import type { LegacyPregnancyStatus, PregnancyStatus } from './pregnancy.js';

export type Iso = string;

// ---------- 主体与关系 ----------

export type DiseaseType = 'sJIA' | 'AOSD' | 'OTHER_JIA';
export type LifeStage = 'CHILD' | 'TRANSITION' | 'ADULT';
/** 患者登记性别；UNKNOWN 表示尚未采集，不能据此推断生育器官或意愿。 */
export type PatientSex = 'FEMALE' | 'MALE' | 'INTERSEX' | 'UNKNOWN';

export interface Patient {
  id: string;
  /** 姓名密文（应用层信封加密）；展示名由「姓名索引 + 授权后解密」取得 */
  nameEncrypted?: string;
  /** 展示用名（脱敏后），如「张小某」 */
  displayName: string;
  birthDate: Iso;
  /** 登记性别；旧 seed 在迁移期间可省略，服务端按 UNKNOWN 处理。 */
  sex?: PatientSex;
  diseaseType: DiseaseType;
  onsetDate: Iso;
  onsetAgeMonths: number;
  lifeStage: LifeStage;
  /** 生命阶段是否被人工覆盖（覆盖后不再按生日推导） */
  lifeStageOverridden?: boolean;
  isLivingAlone: boolean;
  pregnancyStatus?: PregnancyStatus | LegacyPregnancyStatus;
  /** 专业基线备注，用于风险解释与复诊准备。 */
  clinicianBaselineNote?: string;
}

export type ActorRelation = 'SELF' | 'LEGAL_GUARDIAN' | 'CAREGIVER' | 'SPOUSE' | 'PROXY' | 'CLINICIAN';

export interface Actor {
  id: string;
  userId: string;
  /** 患者端审计所需的安全展示名；未配置时由访问层使用关系泛化名。 */
  displayName?: string;
  patientId: string;
  relation: ActorRelation;
  activeFrom: Iso;
  activeUntil?: Iso;
  revokedAt?: Iso;
  /** 休眠代理权（docs/01 §2.5）：医生触发「患者暂无法自主决策」时激活 */
  isDormantProxy: boolean;
  /** 休眠代理权当前是否被激活 */
  dormantProxyActivatedAt?: Iso;
}

export type Visibility = 'G1_NOTIFY' | 'G2_SUMMARY' | 'G3_FULL';

export interface Contact {
  id: string;
  patientId: string;
  actorId?: string;
  /** 打码后的展示名，如「王女士」 */
  displayName: string;
  phoneEncrypted: string;
  phoneIndex: string;
  tier: 1 | 2 | 'PROFESSIONAL';
  visibility: Visibility;
  quietHours?: { from: string; to: string };
  capabilityTags: string[];
  lastConfirmedAt: Iso;
}

// ---------- 观测值 ----------

export interface Observation {
  id: string;
  patientId: string;
  code: Code;
  display: string;
  valueNumeric?: number;
  valueText?: string;
  valueCoded?: SymptomCode | string;
  /** 原单位，必须有 */
  unit: string;
  /** 发生时间（不是录入时间） */
  observedAt: Iso;
  /** 录入时间 */
  recordedAt: Iso;
  source: ObservationSource;
  recordedBy: string;
  recordedByIdentity?: string;
  confidence?: 'HIGH' | 'LOW';
  tags?: string[];
  notes?: string;
  idempotencyKey?: string;
}

// ---------- 个性化基线 ----------

export interface StabilityPeriod {
  from: Iso;
  to: Iso;
  markedBy?: string;
  note?: string;
}

export interface PersonalBaseline {
  patientId: string;
  code: Code;
  baselineValue: number;
  unit: string;
  source: 'COMPUTED' | 'CLINICIAN';
  stabilityPeriods: StabilityPeriod[];
  /** 专业备注，可含显式阈值 */
  clinicianNote?: string;
  /** 从 clinicianNote 解析出的覆盖阈值【工程初稿】 */
  clinicianThresholds?: ClinicianThreshold[];
  updatedAt: Iso;
}

export interface ClinicianThreshold {
  code: Code;
  /** 超过此值即「不对劲」 */
  above?: number;
  /** 低于此值即「不对劲」 */
  below?: number;
  unit: string;
  /** 原文片段，供界面回显 */
  rawText: string;
}

// ---------- 引擎输入 ----------

export interface SafetyNetState {
  /** 患者最后一次任何形式记录的活跃时间 */
  lastActiveAt?: Iso;
  /** 患者本人是否已读最近一次告警 */
  patientAcknowledged: boolean;
  /** 一级/二级联系人是否均无响应 */
  contactsUnresponsive: boolean;
  /** 是否有未确认的通知 */
  hasPendingNotification: boolean;
  isLivingAlone: boolean;
}

export interface JointAssessment {
  patientId: string;
  observedAt: Iso;
  assessedBy: string;
  morningStiffnessMinutes?: number;
  painNrs?: number;
  activityLevel: 'FULL' | 'LIMITED' | 'SEVERE';
  source: 'PATIENT' | 'CAREGIVER' | 'CLINICIAN';
  trendFlag?: 'IMPROVED' | 'STABLE' | 'WORSENED' | 'UNKNOWN';
  /** 采集质量与 UI 来源由 J-01 领域切片补充；旧引擎输入保持兼容。 */
  dataQuality?: 'OK' | 'CONFLICT';
  sourceUi?: 'DAILY_RECORD';
}

export interface InterventionResponse {
  interventionId: string;
  atHours: 24 | 48;
  deltas: Record<string, number>;
  clinicianJudgement?: string;
}

// ---------- 输出 ----------

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type ActionLevel = 'OBSERVE' | 'REVIEW' | 'ACT_NOW';
export type SafetyNetStatus = 'IN_CARE' | 'PENDING' | 'NO_RESPONSE';

export interface AlertReason {
  code: string;
  label: string;
  /** 人话描述，直接上界面，如「血小板 48h 内 210→152（↓28%），连续 4 次下降」 */
  detail: string;
  actual?: number | string;
  threshold?: number | string;
  unit?: string;
  /** 该项依据什么判读 */
  source: 'GUIDELINE_2016' | 'CONSENSUS_2016_DYNAMIC' | 'HLH_2004' | 'SYMPTOM_RULE' | 'BASELINE_COMPUTED' | 'BASELINE_CLINICIAN' | 'MS_SCORE' | 'SAFETY_NET';
  severity: 1 | 2 | 3;
  actionability: 0 | 1;
}

export interface EvidenceItem {
  kind: 'GUIDELINE' | 'CONSENSUS' | 'BASELINE';
  ref: string;
  text: string;
}

export interface Standard2016Item {
  key: 'FEVER' | 'FERRITIN' | 'PLATELET' | 'AST' | 'TRIGLYCERIDE' | 'FIBRINOGEN';
  display: string;
  met: boolean | 'NOT_MEASURED';
  actual?: number;
  threshold?: number;
  unit?: string;
  /** 距离阈值还差多少（未满足时给出），界面文案「距阈值差 18」 */
  gap?: number;
  /** 方向说明：如「> 684」或「≤ 181」 */
  rule: string;
}

export interface StandardProgress {
  /** 必要条件是否满足（发热 + 铁蛋白） */
  prerequisitesMet: boolean;
  /** 四项实验室条件满足数 */
  labCriteriaMet: number;
  /** 是否满足 2016 分类标准 */
  satisfied: boolean;
  items: Standard2016Item[];
  /** 建议加测哪几项（docs/02 §3.1：「建议加测甘油三酯 + 纤维蛋白原」） */
  suggestedTests: string[];
  /** 结论文案，如「已满足 2016 标准 2 项实验室条件」 */
  summary: string;
}

export interface TrendSignal {
  code: Code;
  kind: 'DELTA_PCT' | 'CONSECUTIVE_DECLINE' | 'BASELINE_DEVIATION' | 'SLOPE' | 'RATE_OF_CHANGE';
  value: number;
  windowHours?: number;
  /** 语义标注文案（docs/02 §4.2 模板） */
  semanticLabel: string;
  severity: 1 | 2 | 3;
  /** 与文档示例一致：上升用 ↑、下降用 ↓ */
  direction: 'UP' | 'DOWN' | 'FLAT';
  fromValue?: number;
  toValue?: number;
}

export interface MsScoreResult {
  value: number | null;
  cutoff: number;
  delta?: number;
  /** 缺失的输入项 */
  missingInputs: string[];
  /** 是否跨越截断值 */
  crossed: boolean;
  /** 部分项按 0 代入时的置信度 */
  confidence: 'FULL' | 'PARTIAL';
  /** 与趋势层冲突（docs/02 §5.3）：以趋势层为准并显著展示 */
  divergence?: 'TREND_OVERRIDES_SCORE' | 'SCORE_OVERRIDES_TREND';
  divergenceText?: string;
  series?: Array<{ at: Iso; value: number }>;
}

export interface DifferentialChannel {
  key: 'MAS_SUPPORT' | 'SJIA_FLARE_SUPPORT' | 'INFECTION_SUPPORT' | 'OTHER_SUPPORT';
  display: string;
  evidenceCount: number;
  /** 负向证据单独计数，不能与支持项混为零条证据。 */
  negativeEvidenceCount?: number;
  strength?: 'STRONG' | 'MEDIUM' | 'WEAK';
  items: Array<{
    code: string;
    detail: string;
    weight: number;
    direction: string;
    /** 可追溯到哪一类输入，供医生详情只读展示。 */
    source?: 'OBSERVATION' | 'SYMPTOM' | 'JOINT' | 'BASELINE' | 'INTERVENTION';
    /** 规则与配置的版本，不参与风险等级或信号指纹。 */
    ruleVersion?: string;
    configVersion?: string;
    inputRefs?: string[];
  }>;
  gaps: string[];
  /** 与其他通道冲突时的提示（docs/08 §3.3） */
  conflictNote?: string;
}

export interface DataGap {
  code: string;
  display: string;
  priority: number;
  reason: string;
}

export interface EngineInput {
  patient: Patient;
  /** 临床观测值。调用方必须已剔除 NO_ALERT（引擎不做权限与隔离判断） */
  observations: Observation[];
  baseline: PersonalBaseline[];
  thresholds: ThresholdConfig;
  joints: JointAssessment[];
  interventions: InterventionResponse[];
  safetyNet: SafetyNetState;
  /** 在本次快照时刻已知的上一 MS score；未提供时不计算变化量。 */
  previousMsScore?: number | null;
  /** 显式传入，不读系统时间 */
  now: Iso;
}

export interface EngineOutput {
  riskLevel: RiskLevel;
  actionLevel: ActionLevel;
  safetyNetStatus: SafetyNetStatus;
  reasons: AlertReason[];
  evidence: EvidenceItem[];
  standard2016: StandardProgress;
  msScore: MsScoreResult;
  trends: TrendSignal[];
  suggestions: string[];
  differential: DifferentialChannel[];
  dataGaps: DataGap[];
  /** 安全网异常时的一句话解释（文档 §6.1b：临床风险低 + 安全网无人响应） */
  safetyNetNote?: string;
  engineVersion: string;
  configVersion: string;
  /** 信号指纹，用于告警去重 */
  signalFingerprint: string;
}

// ---------- 阈值配置 ----------

export interface ThresholdConfig {
  version: string;
  clinicalReviewRequired: boolean;
  masRules: {
    ferritinCutoff: number;
    plateletCutoff: number;
    astCutoff: number;
    triglycerideCutoff: number;
    fibrinogenCutoff: number;
    msScoreCutoff: number;
    msScoreCoefficients: {
      cns: number;
      bleeding: number;
      arthritis: number;
      platelet: number;
      ldh: number;
      fibrinogen: number;
      ferritin: number;
    };
  };
  trend: {
    plateletDrop48hWarning: number;
    plateletDrop48hCritical: number;
    ferritinRise24hWarning: number;
    consecutiveDeclineCount: number;
    /** 相对基线的偏离倍数触发（docs/08 YAML FERRITIN_VS_BASELINE threshold 2.0） */
    baselineDeviationFactor: number;
    staleDataDays: number;
    /** 斜率/速度的最小数据点 */
    minPointsForTrend: number;
    /** 速度异常：与既往最大变化速度比较的倍数【工程初稿】 */
    rateOfChangeAnomalyFactor: number;
  };
  safetyNet: {
    noRecordHoursHighRisk: number;
    contactNoResponseMinutes: number;
    livingAloneNoRecordHours: number;
  };
  symptoms: {
    feverHighC: number;
    feverRisingDays: number;
    /** 症状在多少小时内被视作「当前」 */
    recencyHours: number;
  };
  routing: {
    l1TimeoutHours: number;
    l2TimeoutHours: number;
    l3TimeoutMinutes: number;
    quietHoursSuppressL1: boolean;
    quietHours: { from: string; to: string };
  };
  notification: {
    l3InappToSmsMinutes: number;
    l3SmsToVoiceMinutes: number;
    crisisInappToVoiceMinutes: number;
    voiceRetry: number;
  };
  session: {
    clinicianAccessTokenMinutes: number;
    clinicianRefreshTokenHours: number;
  };
  disposition: {
    pendingReviewHours: number;
    maxRepeatIgnore: number;
  };
  /** 融合参数【工程初稿·需临床复核】 */
  fusion: {
    criticalSignals: string[];
    highThreshold: { severity3: number; severity2: number };
    mediumThreshold: { severity3: number; severity2: number };
  };
  /** 二期证据板配置。缺失或未复核时，引擎保持空证据板。 */
  differential?: DifferentialConfig;
}

export type DifferentialChannelKey = DifferentialChannel['key'];

export interface DifferentialConfig {
  /** 只有临床团队复核后的配置才允许进入引擎输出。 */
  reviewed: boolean;
  ruleVersion: string;
  channels: Array<{
    key: DifferentialChannelKey;
    items: Array<{ code: string; direction: string; weight: number; threshold?: number }>;
  }>;
  dataGapPriority: string[];
  strengthThresholds: { strong: number; medium: number };
  /** 供展示层过滤；引擎阶段 0 仍返回稳定四通道。 */
  presentation?: { showChannelWhen: 'EVIDENCE' | 'ALWAYS'; minStrengthToShow: 'WEAK' | 'MEDIUM' | 'STRONG' };
}

export type PatientFollowUpState = 'PENDING_REVIEW' | 'CLOSED';

export interface PatientFollowUp {
  id: string;
  patientId: string;
  alertId: string;
  state: PatientFollowUpState;
  reviewDueAt: Iso;
  ignoreCount: number;
  lastActionId?: string;
  closedAt?: Iso;
  closedBy?: string;
}
