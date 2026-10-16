/**
 * 黄金用例：直接来自设计文档的示例病例（design/01、design/03、docs/01 §4.4 的 SBAR 示例）。
 *
 * 张小某 6岁3月 sJIA ｜ 2024-03 确诊 ｜ 激素 0.5mg/kg 减量中
 * 文档给出的关键数值：
 *   血小板 48h 内 210→152（↓28%），连续 4 次下降
 *   铁蛋白 6h 内 1500→3400（↑127%），高于该患儿基线 3.2 倍
 *   甘油三酯 138（未达 156）、纤维蛋白原 410（未达 360）
 *   MS score −1.4（↑1.8），截断值 −2.1
 *   结论：高危 · 立即行动 ｜ 安全网：在管
 *   建议：今日加测甘油三酯 + 纤维蛋白原；联系家属确认当前症状；考虑复评
 */
import type { EngineInput, Observation, Patient } from '@mas/domain';
import { DEFAULT_CONFIG } from '../src/config.js';

export const NOW = '2026-06-12T09:00:00+08:00';

export const patient: Patient = {
  id: 'pat-zhang',
  displayName: '张小某',
  birthDate: '2020-03-01',
  diseaseType: 'sJIA',
  onsetDate: '2024-03-01',
  onsetAgeMonths: 48,
  lifeStage: 'CHILD',
  isLivingAlone: false,
};

let seq = 0;
function obs(partial: Partial<Observation> & Pick<Observation, 'code' | 'display' | 'observedAt'>): Observation {
  seq += 1;
  return {
    id: `obs-${seq}`,
    patientId: patient.id,
    unit: '',
    recordedAt: partial.observedAt,
    source: 'LAB',
    recordedBy: 'actor-mother',
    ...partial,
  } as Observation;
}

/** 血小板：/ 06-08 250 → 06-09 220 → 06-10 205 → 06-11 175 → 06-12 152（连续 4 次下降） */
export const plateletSeries: Observation[] = [
  obs({ code: 'PLATELET', display: '血小板计数', valueNumeric: 250, unit: '10^9/L', observedAt: '2026-06-07T08:00:00+08:00' }),
  obs({ code: 'PLATELET', display: '血小板计数', valueNumeric: 210, unit: '10^9/L', observedAt: '2026-06-10T09:00:00+08:00' }),
  obs({ code: 'PLATELET', display: '血小板计数', valueNumeric: 196, unit: '10^9/L', observedAt: '2026-06-10T21:00:00+08:00' }),
  obs({ code: 'PLATELET', display: '血小板计数', valueNumeric: 175, unit: '10^9/L', observedAt: '2026-06-11T09:00:00+08:00' }),
  obs({ code: 'PLATELET', display: '血小板计数', valueNumeric: 152, unit: '10^9/L', observedAt: '2026-06-12T08:00:00+08:00' }),
];

/** 铁蛋白：06-11 21:00 1500 → 06-12 03:00 3400（6h 内 ↑127%） */
export const ferritinSeries: Observation[] = [
  obs({ code: 'FERRITIN', display: '铁蛋白', valueNumeric: 1200, unit: 'ng/mL', observedAt: '2026-06-09T09:00:00+08:00' }),
  obs({ code: 'FERRITIN', display: '铁蛋白', valueNumeric: 1500, unit: 'ng/mL', observedAt: '2026-06-11T21:00:00+08:00' }),
  obs({ code: 'FERRITIN', display: '铁蛋白', valueNumeric: 3400, unit: 'ng/mL', observedAt: '2026-06-12T03:00:00+08:00' }),
];

/** 甘油三酯 138（未达 156）、纤维蛋白原 410（未达 360）、AST 52（>48 已满足） */
export const otherLabs: Observation[] = [
  obs({ code: 'TRIGLYCERIDE', display: '甘油三酯', valueNumeric: 138, unit: 'mg/dL', observedAt: '2026-06-12T08:10:00+08:00' }),
  obs({ code: 'FIBRINOGEN', display: '纤维蛋白原', valueNumeric: 410, unit: 'mg/dL', observedAt: '2026-06-12T08:10:00+08:00' }),
  obs({ code: 'AST', display: 'AST', valueNumeric: 52, unit: 'U/L', observedAt: '2026-06-12T08:10:00+08:00' }),
  obs({ code: 'LDH', display: 'LDH', valueNumeric: 480, unit: 'U/L', observedAt: '2026-06-12T08:10:00+08:00' }),
];

/** 家长报告：最近 6h 最高 39.8℃，精神差、拒食；连续 3 天体温上升 */
export const symptoms: Observation[] = [
  obs({ code: 'TEMP', display: '体温', valueNumeric: 38.9, unit: '℃', observedAt: '2026-06-10T20:00:00+08:00', source: 'CAREGIVER_REPORTED', recordedByIdentity: '奶奶' }),
  obs({ code: 'TEMP', display: '体温', valueNumeric: 39.5, unit: '℃', observedAt: '2026-06-11T21:00:00+08:00', source: 'CAREGIVER_REPORTED', recordedByIdentity: '妈妈' }),
  obs({ code: 'TEMP', display: '体温', valueNumeric: 39.8, unit: '℃', observedAt: '2026-06-12T03:00:00+08:00', source: 'CAREGIVER_REPORTED', recordedByIdentity: '妈妈' }),
  obs({ code: 'TEMP', display: '症状', valueCoded: 'FEVER_HIGH', valueText: '持续高热', unit: 'code', observedAt: '2026-06-12T03:05:00+08:00', source: 'CAREGIVER_REPORTED' }),
  obs({ code: 'TEMP', display: '症状', valueCoded: 'LETHARGY', valueText: '精神差', unit: 'code', observedAt: '2026-06-12T03:06:00+08:00', source: 'CAREGIVER_REPORTED' }),
  obs({ code: 'TEMP', display: '症状', valueCoded: 'ANOREXIA', valueText: '拒食', unit: 'code', observedAt: '2026-06-12T03:06:00+08:00', source: 'CAREGIVER_REPORTED' }),
];

export const baseline = [
  {
    patientId: patient.id,
    code: 'FERRITIN' as const,
    baselineValue: 1060,
    unit: 'ng/mL',
    // 医生写了备注 → source 记为 CLINICIAN（引擎取基线时 CLINICIAN 优先于 COMPUTED）
    source: 'CLINICIAN' as const,
    stabilityPeriods: [{ from: '2026-01-01T00:00:00+08:00', to: '2026-05-01T00:00:00+08:00' }],
    clinicianNote: '该患儿发热时铁蛋白通常在 1500 左右，血小板稳定在 200+；如果铁蛋白超过 3000 或血小板跌破 170，那就是不对劲了。',
    clinicianThresholds: [
      { code: 'FERRITIN' as const, above: 3000, unit: 'ng/mL', rawText: '铁蛋白超过 3000' },
      { code: 'PLATELET' as const, below: 170, unit: '10^9/L', rawText: '血小板跌破 170' },
    ],
    updatedAt: '2026-05-02T10:00:00+08:00',
  },
  {
    patientId: patient.id,
    code: 'PLATELET' as const,
    baselineValue: 210,
    unit: '10^9/L',
    source: 'COMPUTED' as const,
    stabilityPeriods: [{ from: '2026-01-01T00:00:00+08:00', to: '2026-05-01T00:00:00+08:00' }],
    updatedAt: '2026-05-02T10:00:00+08:00',
  },
];

export function fullInput(overrides: Partial<EngineInput> = {}): EngineInput {
  return {
    patient,
    thresholds: DEFAULT_CONFIG,
    observations: [...symptoms, ...plateletSeries, ...ferritinSeries, ...otherLabs],
    baseline,
    joints: [],
    interventions: [],
    safetyNet: {
      lastActiveAt: '2026-06-12T08:10:00+08:00',
      patientAcknowledged: false,
      contactsUnresponsive: false,
      hasPendingNotification: false,
      isLivingAlone: false,
    },
    now: NOW,
    ...overrides,
  };
}
