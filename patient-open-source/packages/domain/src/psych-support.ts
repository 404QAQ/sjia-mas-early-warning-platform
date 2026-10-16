import type { PsychAnswer, PsychScreening } from './psych-screening.js';

/** P-02/P-03 医生提示卡只允许出现的严重度。危机由 P-07 独立处理。 */
export type PsychSupportLevel = 'MILD' | 'MODERATE';

/** 固定、可翻译的困扰维度；不携带量表名称、分数或患者自由文本。 */
export type PsychSupportConcern = '睡眠' | '情绪' | '精力' | '日常' | '支持';

export interface PsychSupportPrompt {
  patientId: string;
  screeningIds: string[];
  trend: PsychSupportLevel[];
  level: PsychSupportLevel;
  concerns: PsychSupportConcern[];
  suggestedOpening: string;
  referralRecommended: boolean;
  latestSubmittedAt: string;
  acknowledgedAt?: string;
}

/** P-02 服务端生成的人工转介时段快照；患者只能选择其一，不能自行改写。 */
export interface PsychReferralSlot {
  id: string;
  startsAt: string;
  endsAt: string;
  department: string;
  clinicianName: string;
}

/** 接受只表示患者选择了一个候选时段，实际预约仍需临床人工确认。 */
export type PsychReferralStatus = 'OFFERED' | 'ACCEPTED_PENDING_BOOKING' | 'DECLINED' | 'SUPPRESSED' | 'UNAVAILABLE';

export interface PsychReferral {
  status: PsychReferralStatus;
  offeredSlots: PsychReferralSlot[];
  selectedSlotId?: string;
  decidedAt?: string;
}

/** P-02 响应事实；不进入 MAS 风险评分，也不向患者返回 level/concerns。 */
export interface PsychResponse {
  id: string;
  patientId: string;
  screeningId: string;
  level: PsychSupportLevel;
  concerns: PsychSupportConcern[];
  contentPushed: string[];
  referral?: PsychReferral;
  createdAt: string;
  version: number;
}

export type PsychReferralDecision =
  | { decision: 'ACCEPT'; slotId: string }
  | { decision: 'DECLINE' };

export const PSYCH_EDUCATION_ARTICLE_BY_CONCERN: Readonly<Record<PsychSupportConcern, string>> = {
  睡眠: 'psych-sleep-support',
  情绪: 'psych-mood-support',
  精力: 'psych-energy-support',
  日常: 'psych-daily-support',
  支持: 'psych-caregiver-support',
};

const DIMENSION_ORDER: readonly PsychSupportConcern[] = ['睡眠', '情绪', '精力', '日常', '支持'];
const VALUE_SCORE: Readonly<Record<string, number>> = {
  NEVER: 0,
  NO: 0,
  SOMETIMES: 1,
  LOW: 1,
  OFTEN: 2,
  MEDIUM: 2,
  ALWAYS: 3,
  YES: 3,
  HIGH: 3,
};

/**
 * 从问卷事实派生医生端最小提示。
 *
 * 这里故意不计算或返回量表分数：所有题目都只映射到固定维度和
 * MILD/MODERATE 两级。任何危机题阳性都直接交给 P-07，不能生成 P-03 卡片。
 */
export function derivePsychSupport(screenings: readonly PsychScreening[]): PsychSupportPrompt | undefined {
  if (screenings.length === 0 || screenings.some(screening => screening.crisisItemCodes.length > 0)) return undefined;
  const sorted = [...screenings].sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt) || a.id.localeCompare(b.id));
  const recent = sorted.slice(-3);
  const evaluated = recent.map(evaluateScreening);
  if (!evaluated.some(item => item !== undefined)) return undefined;
  const nonEmpty = evaluated.filter((item): item is EvaluatedScreening => item !== undefined);
  const latest = nonEmpty.at(-1)!;
  const trend = nonEmpty.map(item => item.level);
  const concernSet = new Set<PsychSupportConcern>();
  for (const item of nonEmpty) for (const concern of item.concerns) concernSet.add(concern);
  const concerns = DIMENSION_ORDER.filter(item => concernSet.has(item));
  const level: PsychSupportLevel = trend.includes('MODERATE') ? 'MODERATE' : 'MILD';
  return {
    patientId: latest.screening.patientId,
    screeningIds: nonEmpty.map(item => item.screening.id),
    trend,
    level,
    concerns: concerns.slice(0, 4),
    suggestedOpening: openingFor(latest.screening, concerns),
    referralRecommended: level === 'MODERATE',
    latestSubmittedAt: latest.screening.submittedAt,
  };
}

interface EvaluatedScreening {
  screening: PsychScreening;
  level: PsychSupportLevel;
  concerns: PsychSupportConcern[];
}

function evaluateScreening(screening: PsychScreening): EvaluatedScreening | undefined {
  const concerns = new Set<PsychSupportConcern>();
  let dailyScore = 0;
  let hasPositive = false;
  for (const answer of screening.answers) {
    if (answer.status === 'DECLINED') continue;
    const score = scoreOf(answer);
    const concern = concernFor(answer.code);
    if (concern === '支持') {
      // “身边有人能帮你吗”是反向题：NEVER/0 才表示支持不足。
      if (score === 0) { concerns.add(concern); hasPositive = true; }
      continue;
    }
    if (score <= 0 || !concern) continue;
    concerns.add(concern);
    hasPositive = true;
    if (concern === '日常') dailyScore = Math.max(dailyScore, score);
  }
  if (!hasPositive) return undefined;
  // 题目窗口固定为最近两周，因此只要“日常”出现非零影响就满足
  // “持续至少两周且影响日常”的系统侧中度条件；具体临床判读仍由医生完成。
  return { screening, level: dailyScore > 0 ? 'MODERATE' : 'MILD', concerns: [...concerns] };
}

function scoreOf(answer: PsychAnswer): number {
  if (answer.valueNumeric !== undefined) return Math.max(0, Math.min(3, answer.valueNumeric));
  return VALUE_SCORE[answer.valueCoded ?? ''] ?? 0;
}

function concernFor(code: string): PsychSupportConcern | undefined {
  if (code.endsWith('_SLEEP')) return '睡眠';
  if (code.endsWith('_LOW_MOOD') || code.endsWith('_WORRY') || code.endsWith('_HOPELESS')) return '情绪';
  if (code.endsWith('_ENERGY')) return '精力';
  if (code.endsWith('_DAILY')) return '日常';
  if (code.endsWith('_SUPPORT')) return '支持';
  return undefined;
}

function openingFor(screening: PsychScreening, concerns: readonly PsychSupportConcern[]): string {
  if (screening.instrument === 'CAREGIVER_BRIEF') return '照顾孩子这件事一直是你一个人在扛，你自己怎么样？';
  if (concerns.includes('睡眠')) return '上次的问卷里你说睡不好，现在好点了吗？';
  if (screening.instrument === 'TEEN_SELF') return '上次你说想自己跟我说点事。现在方便吗？';
  return '最近这两周感觉不太好，想聊聊是什么事吗？';
}
