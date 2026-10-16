/**
 * LOINC 对齐的指标编码表（一期子集）。
 * 依据：docs/04 §1.4（术语标准）、docs/02 §3（规则层用到的指标）、docs/08 §2.1（证据板采集项）。
 * 注意：code 是系统内部主键，LOINC 只是对齐字段，便于将来接入 HIS/FHIR。
 */

export const CODES = {
  TEMP: 'TEMP',
  FERRITIN: 'FERRITIN',
  PLATELET: 'PLATELET',
  AST: 'AST',
  TRIGLYCERIDE: 'TRIGLYCERIDE',
  FIBRINOGEN: 'FIBRINOGEN',
  LDH: 'LDH',
  CRP: 'CRP',
  ESR: 'ESR',
  D_DIMER: 'D_DIMER',
  SODIUM: 'SODIUM',
  HEMOGLOBIN: 'HEMOGLOBIN',
  WBC: 'WBC',
  NEUTROPHIL_PCT: 'NEUTROPHIL_PCT',
  PCT: 'PCT',
  WEIGHT: 'WEIGHT',
  HEIGHT_SD: 'HEIGHT_SD',
  BONE_AGE_LAG_YEARS: 'BONE_AGE_LAG_YEARS',
} as const;

export type Code = (typeof CODES)[keyof typeof CODES];

export interface CodeDef {
  code: Code;
  loinc: string;
  display: string;
  /** 系统内部「标准单位」：所有比较都在这个单位下进行 */
  canonicalUnit: string;
  /** 该指标是否属于 2016 分类标准的实验室四项 */
  in2016Criteria: boolean;
  /** 是否关键指标：缺失时要在告警里提示「风险可能被低估」（docs/02 §7） */
  critical: boolean;
  /** 趋势优先级：依 2016 动态实验室指标共识排序（docs/02 §4.2），数字越小越优先 */
  trendPriority: number;
}

export const CODE_TABLE: Record<Code, CodeDef> = {
  TEMP: { code: 'TEMP', loinc: '8310-5', display: '体温', canonicalUnit: '℃', in2016Criteria: false, critical: false, trendPriority: 99 },
  FERRITIN: { code: 'FERRITIN', loinc: '2276-4', display: '铁蛋白', canonicalUnit: 'ng/mL', in2016Criteria: true, critical: true, trendPriority: 2 },
  PLATELET: { code: 'PLATELET', loinc: '777-3', display: '血小板计数', canonicalUnit: '10^9/L', in2016Criteria: true, critical: true, trendPriority: 1 },
  AST: { code: 'AST', loinc: '1920-8', display: 'AST', canonicalUnit: 'U/L', in2016Criteria: true, critical: false, trendPriority: 3 },
  TRIGLYCERIDE: { code: 'TRIGLYCERIDE', loinc: '2571-8', display: '甘油三酯', canonicalUnit: 'mg/dL', in2016Criteria: true, critical: false, trendPriority: 4 },
  FIBRINOGEN: { code: 'FIBRINOGEN', loinc: '3255-7', display: '纤维蛋白原', canonicalUnit: 'mg/dL', in2016Criteria: true, critical: false, trendPriority: 5 },
  LDH: { code: 'LDH', loinc: '2532-0', display: 'LDH', canonicalUnit: 'U/L', in2016Criteria: false, critical: false, trendPriority: 6 },
  CRP: { code: 'CRP', loinc: '1988-5', display: 'CRP', canonicalUnit: 'mg/L', in2016Criteria: false, critical: false, trendPriority: 7 },
  ESR: { code: 'ESR', loinc: '4537-7', display: 'ESR', canonicalUnit: 'mm/h', in2016Criteria: false, critical: false, trendPriority: 8 },
  D_DIMER: { code: 'D_DIMER', loinc: '48065-7', display: 'D-二聚体', canonicalUnit: 'ug/mL FEU', in2016Criteria: false, critical: false, trendPriority: 9 },
  SODIUM: { code: 'SODIUM', loinc: '2951-2', display: '血钠', canonicalUnit: 'mmol/L', in2016Criteria: false, critical: false, trendPriority: 10 },
  HEMOGLOBIN: { code: 'HEMOGLOBIN', loinc: '718-7', display: '血红蛋白', canonicalUnit: 'g/L', in2016Criteria: false, critical: false, trendPriority: 11 },
  WBC: { code: 'WBC', loinc: '6690-2', display: '白细胞', canonicalUnit: '10^9/L', in2016Criteria: false, critical: false, trendPriority: 12 },
  NEUTROPHIL_PCT: { code: 'NEUTROPHIL_PCT', loinc: '770-8', display: '中性粒细胞%', canonicalUnit: '%', in2016Criteria: false, critical: false, trendPriority: 13 },
  PCT: { code: 'PCT', loinc: '33959-8', display: '降钙素原', canonicalUnit: 'ng/mL', in2016Criteria: false, critical: false, trendPriority: 14 },
  WEIGHT: { code: 'WEIGHT', loinc: '29463-7', display: '体重', canonicalUnit: 'kg', in2016Criteria: false, critical: false, trendPriority: 98 },
  HEIGHT_SD: { code: 'HEIGHT_SD', loinc: '59576-9', display: '身高 SD', canonicalUnit: 'SD', in2016Criteria: false, critical: false, trendPriority: 97 },
  BONE_AGE_LAG_YEARS: { code: 'BONE_AGE_LAG_YEARS', loinc: '8352-7', display: '骨龄落后', canonicalUnit: '年', in2016Criteria: false, critical: false, trendPriority: 96 },
};

/** 症状编码（docs/02 §8 与 docs/03 §1.2 的卡片一一对应） */
export const SYMPTOMS = {
  FEVER_HIGH: 'FEVER_HIGH',
  FEVER_RISING: 'FEVER_RISING',
  LETHARGY: 'LETHARGY',
  RASH: 'RASH',
  ANOREXIA: 'ANOREXIA',
  GI: 'GI',
  BLEEDING: 'BLEEDING',
  CNS: 'CNS',
  ARTHRITIS_IMPROVED: 'ARTHRITIS_IMPROVED',
  EYE_RED: 'EYE_RED',
  CANNOT_WALK: 'CANNOT_WALK',
  MEDICATION_URGENT: 'MEDICATION_URGENT',
} as const;

export type SymptomCode = (typeof SYMPTOMS)[keyof typeof SYMPTOMS];

export const SYMPTOM_LABEL: Record<SymptomCode, string> = {
  FEVER_HIGH: '持续高热',
  FEVER_RISING: '发热峰值持续上升',
  LETHARGY: '精神差 / 嗜睡',
  RASH: '皮疹（新发或加重）',
  ANOREXIA: '拒食 / 进食明显减少',
  GI: '腹痛 / 呕吐',
  BLEEDING: '出血表现',
  CNS: '抽搐 / 意识改变 / 剧烈头痛',
  ARTHRITIS_IMPROVED: '关节好像不疼了',
  EYE_RED: '眼睛红 / 怕光',
  CANNOT_WALK: '不愿走路 / 不愿动',
  MEDICATION_URGENT: '药物副作用紧急报告',
};

/** 观测值来源（docs/04 §1.1） */
export const OBSERVATION_SOURCES = {
  PATIENT_REPORTED: 'PATIENT_REPORTED',
  CAREGIVER_REPORTED: 'CAREGIVER_REPORTED',
  LAB: 'LAB',
  CLINIC: 'CLINIC',
  DEVICE: 'DEVICE',
} as const;

export type ObservationSource = (typeof OBSERVATION_SOURCES)[keyof typeof OBSERVATION_SOURCES];

/** 观测值标签。NO_ALERT = 心理层 / 个人空间，永久禁止进入引擎与跨院共享（docs/05 §5） */
export const OBSERVATION_TAG = {
  NO_ALERT: 'NO_ALERT',
  OFFLINE_BACKFILL: 'OFFLINE_BACKFILL',
  OCR_UNVERIFIED: 'OCR_UNVERIFIED',
} as const;
