import { parseCareInstant } from './time.js';
import type { Iso } from './types.js';

/** M-04 的症状编码。分级由编码决定，患者不能自行输入严重度。 */
export type MedicationSideEffectCode =
  | 'MOON_FACE_WEIGHT_GAIN'
  | 'INCREASED_APPETITE'
  | 'MOOD_SWINGS'
  | 'SLEEP_DIFFICULTY'
  | 'ACNE_HAIR_GROWTH'
  | 'SLOW_GROWTH'
  | 'JOINT_BONE_PAIN'
  | 'HIGH_GLUCOSE_OR_BLOOD_PRESSURE'
  | 'EYE_DISCOMFORT_OR_BLUR'
  | 'MARKED_WEIGHT_GAIN_OR_SWELLING'
  | 'SEVERE_INFECTION'
  | 'BLEEDING_OR_SEVERE_ABDOMINAL_PAIN';

export type MedicationSideEffectSeverity = 'EXPECTED' | 'MONITOR' | 'REPORT' | 'URGENT';

export interface MedicationSideEffectDefinition {
  code: MedicationSideEffectCode;
  severity: MedicationSideEffectSeverity;
  label: string;
  guidance: string;
}

export interface MedicationSideEffectReport {
  id: string;
  patientId: string;
  symptomCode: MedicationSideEffectCode;
  severity: MedicationSideEffectSeverity;
  reportedAt: Iso;
  reportedBy: string;
  photoRef?: string;
  note?: string;
  handledAt?: Iso;
  handledBy?: string;
}

/** 患者提交的草稿不接受 severity；服务端必须按 symptomCode 派生。 */
export type MedicationSideEffectReportInput = Omit<MedicationSideEffectReport, 'severity'>;

const DEFINITIONS: readonly MedicationSideEffectDefinition[] = [
  { code: 'MOON_FACE_WEIGHT_GAIN', severity: 'EXPECTED', label: '脸变圆 / 体重增加', guidance: '这是激素的常见反应，减量后通常会慢慢恢复，但可能需要几个月。可以少盐、规律活动，并选择让自己舒服的穿衣和发型。' },
  { code: 'INCREASED_APPETITE', severity: 'EXPECTED', label: '食欲变好', guidance: '食欲增加是激素的常见反应。可以保持规律饮食，并在复诊时告诉医生变化。' },
  { code: 'MOOD_SWINGS', severity: 'EXPECTED', label: '情绪起伏大 / 容易发火', guidance: '激素会直接影响情绪，这不是你的性格，也不是你变坏了。若影响睡眠或日常生活，请告诉医生。' },
  { code: 'SLEEP_DIFFICULTY', severity: 'EXPECTED', label: '睡不好', guidance: '睡眠变化可能与激素有关。先记录发生时间和影响，复诊时告诉医生。' },
  { code: 'ACNE_HAIR_GROWTH', severity: 'EXPECTED', label: '长痘 / 汗毛变多', guidance: '皮肤和毛发变化可能与激素有关。记录变化，复诊时一起讨论。' },
  { code: 'SLOW_GROWTH', severity: 'MONITOR', label: '长得慢', guidance: '生长变化需要结合曲线持续观察，不要自行停药或减药。' },
  { code: 'JOINT_BONE_PAIN', severity: 'EXPECTED', label: '关节 / 骨头有点疼', guidance: '请记录疼痛出现的时间和活动影响；如果持续或加重，请告诉医生。' },
  { code: 'HIGH_GLUCOSE_OR_BLOOD_PRESSURE', severity: 'REPORT', label: '血糖高 / 血压高', guidance: '这些情况需要告诉医生，复诊时医生会结合记录判断下一步。' },
  { code: 'EYE_DISCOMFORT_OR_BLUR', severity: 'REPORT', label: '眼睛不舒服 / 看东西模糊', guidance: '这些情况需要告诉医生，不要自行调整或停药。' },
  { code: 'MARKED_WEIGHT_GAIN_OR_SWELLING', severity: 'REPORT', label: '明显变胖很多，或脸很肿', guidance: '请记录变化并告诉医生，复诊时医生会看到这条记录。' },
  { code: 'SEVERE_INFECTION', severity: 'URGENT', label: '严重感染（一直发烧、伤口化脓）', guidance: '这个现在就要联系医生或按既有安全路径求助。' },
  { code: 'BLEEDING_OR_SEVERE_ABDOMINAL_PAIN', severity: 'URGENT', label: '出血 / 剧烈腹痛', guidance: '这个现在就要联系医生或按既有安全路径求助。' },
];

const byCode = new Map(DEFINITIONS.map(item => [item.code, item]));

export function medicationSideEffectDefinitions(): readonly MedicationSideEffectDefinition[] {
  return DEFINITIONS.map(item => ({ ...item }));
}

export function medicationSideEffectDefinition(code: unknown): MedicationSideEffectDefinition | undefined {
  if (typeof code !== 'string') return undefined;
  const item = byCode.get(code as MedicationSideEffectCode);
  return item ? { ...item } : undefined;
}

export function classifyMedicationSideEffect(code: unknown): MedicationSideEffectSeverity {
  const definition = medicationSideEffectDefinition(code);
  if (!definition) throw new RangeError('未知的副作用编码');
  return definition.severity;
}

/** 构造持久化记录时统一派生分级，避免“严重感染 + EXPECTED”之类的降级输入。 */
export function buildMedicationSideEffectReport(input: MedicationSideEffectReportInput): MedicationSideEffectReport {
  if (!input || typeof input !== 'object') throw new RangeError('副作用记录无效');
  const definition = medicationSideEffectDefinition(input.symptomCode);
  if (!definition) throw new RangeError('未知的副作用编码');
  if (typeof input.id !== 'string' || !input.id.trim() || typeof input.patientId !== 'string' || !input.patientId.trim() || typeof input.reportedBy !== 'string' || !input.reportedBy.trim()) throw new RangeError('副作用记录身份字段无效');
  parseCareInstant(input.reportedAt);
  if (input.photoRef !== undefined && (typeof input.photoRef !== 'string' || input.photoRef.length > 500)) throw new RangeError('副作用照片引用无效');
  if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 2000)) throw new RangeError('副作用备注无效');
  if ((input.handledAt === undefined) !== (input.handledBy === undefined)) throw new RangeError('副作用处理字段不完整');
  if (input.handledAt !== undefined) parseCareInstant(input.handledAt);
  if (input.handledBy !== undefined && (typeof input.handledBy !== 'string' || !input.handledBy.trim())) throw new RangeError('副作用处理人无效');
  return { ...input, symptomCode: definition.code, severity: definition.severity };
}

/** 校验从持久层/队列恢复的记录，分级不一致时拒绝继续路由。 */
export function validateMedicationSideEffectReport(report: MedicationSideEffectReport): MedicationSideEffectReport {
  const rebuilt = buildMedicationSideEffectReport(report);
  if (rebuilt.severity !== report.severity) throw new RangeError('副作用分级与症状编码不一致');
  return { ...rebuilt };
}

/** 只有 URGENT 进入即时临床提示；EXPECTED 永远不产生告警或通知。 */
export function medicationSideEffectRouting(code: unknown): { createsClinicalAlert: boolean; createsFollowUp: boolean; immediateMessage: boolean } {
  const severity = classifyMedicationSideEffect(code);
  return { createsClinicalAlert: severity === 'URGENT', createsFollowUp: severity === 'MONITOR' || severity === 'REPORT', immediateMessage: severity === 'URGENT' };
}
