/**
 * P-01 复诊前状态问卷的领域合同。
 *
 * 问卷是患者支持层的事实记录，不是临床 Observation，也不参与风险引擎。
 * 每个题目单独保存，DECLINED 是有效答案状态。
 */

export type PsychRespondentRelation = 'SELF' | 'LEGAL_GUARDIAN';
export type PsychScreeningInstrument = 'CAREGIVER_BRIEF' | 'TEEN_SELF' | 'ADULT_SELF';
export type PsychAnswerStatus = 'ANSWERED' | 'DECLINED';
/** P-01 当前发布的问卷事实合同版本；历史记录保留提交时版本。 */
export const PSYCH_SCREENING_VERSION = 2 as const;
/** 一次复诊最多一份同答题关系问卷；PRE_VISIT 是触发窗口而非频率。 */
export const PSYCH_SCREENING_FREQUENCY = 'PER_VISIT' as const;
export type PsychScreeningFrequency = typeof PSYCH_SCREENING_FREQUENCY;

export interface PsychQuestion {
  code: string;
  prompt: string;
  crisis: boolean;
}

export interface PsychAnswer {
  code: string;
  status: PsychAnswerStatus;
  valueCoded?: string;
  valueNumeric?: number;
}

export interface PsychScreening {
  id: string;
  patientId: string;
  visitId: string;
  instrument: PsychScreeningInstrument;
  questionnaireVersion: number;
  frequency: PsychScreeningFrequency;
  respondentRelation: PsychRespondentRelation;
  submittedAt: string;
  submittedBy: string;
  answers: PsychAnswer[];
  /** 危机题只在此处和独立审计事件中列出；不会形成风险引擎输入。 */
  crisisItemCodes: string[];
  prescreenWindow: { trigger: 'PRE_VISIT'; visitId: string };
  visibleTo: ['CLINICIAN'];
  idempotencyKey: string;
  requestFingerprint: string;
}

const CAREGIVER_QUESTIONS: readonly PsychQuestion[] = [
  { code: 'CAREGIVER_SLEEP', prompt: '最近两周，照顾孩子时睡得怎么样？', crisis: false },
  { code: 'CAREGIVER_ENERGY', prompt: '最近两周，照顾孩子时精力怎么样？', crisis: false },
  { code: 'CAREGIVER_WORRY', prompt: '最近两周，担心孩子病情的时间多吗？', crisis: false },
  { code: 'CAREGIVER_DAILY', prompt: '最近两周，照顾孩子有没有影响日常安排？', crisis: false },
  { code: 'CAREGIVER_SUPPORT', prompt: '最近两周，你身边有人能帮你吗？', crisis: false },
  { code: 'CAREGIVER_HOPELESS', prompt: '最近两周，有没有觉得事情没有希望？', crisis: true },
];

const SELF_QUESTIONS: readonly PsychQuestion[] = [
  { code: 'SELF_SLEEP', prompt: '最近两周，你睡得怎么样？', crisis: false },
  { code: 'SELF_ENERGY', prompt: '最近两周，你做事时精力怎么样？', crisis: false },
  { code: 'SELF_LOW_MOOD', prompt: '最近两周，你觉得状态怎么样？', crisis: false },
  { code: 'SELF_DAILY', prompt: '最近两周，这些事影响日常安排了吗？', crisis: false },
  { code: 'SELF_HOPELESS', prompt: '最近两周，有没有觉得事情没有希望？', crisis: true },
  { code: 'SELF_HARM', prompt: '最近两周，有没有伤害自己的想法？', crisis: true },
];

export function psychInstrumentFor(lifeStage: 'CHILD' | 'TRANSITION' | 'ADULT', relation: PsychRespondentRelation): PsychScreeningInstrument {
  if (lifeStage === 'CHILD' && relation === 'LEGAL_GUARDIAN') return 'CAREGIVER_BRIEF';
  if (lifeStage === 'TRANSITION' && relation === 'SELF') return 'TEEN_SELF';
  if (lifeStage === 'ADULT' && relation === 'SELF') return 'ADULT_SELF';
  throw new Error('患者生命阶段与问卷答题关系不匹配');
}

export function psychQuestionsFor(instrument: PsychScreeningInstrument): readonly PsychQuestion[] {
  return instrument === 'CAREGIVER_BRIEF' ? CAREGIVER_QUESTIONS : SELF_QUESTIONS;
}

export function isPsychAnswer(value: unknown): value is PsychAnswer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<PsychAnswer>;
  if (typeof item.code !== 'string' || !item.code.trim()) return false;
  if (item.status !== 'ANSWERED' && item.status !== 'DECLINED') return false;
  if (item.status === 'DECLINED') return item.valueCoded === undefined && item.valueNumeric === undefined;
  return (typeof item.valueCoded === 'string' && item.valueCoded.length > 0 && item.valueNumeric === undefined)
    || (typeof item.valueNumeric === 'number' && Number.isFinite(item.valueNumeric) && item.valueCoded === undefined);
}

export function isPsychScreening(value: unknown): value is PsychScreening {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<PsychScreening>;
  return typeof item.id === 'string' && typeof item.patientId === 'string' && typeof item.visitId === 'string'
    && (item.instrument === 'CAREGIVER_BRIEF' || item.instrument === 'TEEN_SELF' || item.instrument === 'ADULT_SELF')
    && typeof item.questionnaireVersion === 'number' && Number.isSafeInteger(item.questionnaireVersion) && item.questionnaireVersion > 0
    && item.frequency === PSYCH_SCREENING_FREQUENCY
    && (item.respondentRelation === 'SELF' || item.respondentRelation === 'LEGAL_GUARDIAN')
    && typeof item.submittedAt === 'string' && typeof item.submittedBy === 'string'
    && Array.isArray(item.answers) && item.answers.every(isPsychAnswer)
    && Array.isArray(item.crisisItemCodes) && item.crisisItemCodes.every(code => typeof code === 'string')
    && item.prescreenWindow?.trigger === 'PRE_VISIT' && item.prescreenWindow.visitId === item.visitId
    && Array.isArray(item.visibleTo) && item.visibleTo.length === 1 && item.visibleTo[0] === 'CLINICIAN'
    && typeof item.idempotencyKey === 'string' && typeof item.requestFingerprint === 'string';
}
