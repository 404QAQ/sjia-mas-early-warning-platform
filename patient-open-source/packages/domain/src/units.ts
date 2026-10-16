/**
 * 单位换算。依据：docs/04 §1.2、docs/tech/01 §3。
 *
 * 三条实现约束：
 *  1. 存储层只存「原值 + 原单位」，不归一化存储（医生看到的数字必须与化验单一致）
 *  2. 换算发生在读取路径：toCanonical(value, unit, code) → { value, unit }
 *  3. 比较前必须显式换算；缺单位或未知单位一律抛错，不默认、不静默返回原值
 *
 * 换算系数是物理常数，不是业务配置，所以硬编码在此，不进 ThresholdConfig。
 */

export class UnitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnitError';
  }
}

/** 线性换算：canonical = raw * factor（部分单位带偏移，用 scale/offset 表达） */
interface UnitRule {
  /** canonical = raw * scale + offset */
  scale: number;
  offset: number;
}

/**
 * 甘油三酯：1 mmol/L = 88.57 mg/dL
 * 纤维蛋白原：1 g/L = 100 mg/dL
 * 铁蛋白：ng/mL 与 μg/L 为 1:1
 * 体温：℃ ↔ ℉（仿射变换）
 */
const CONVERSIONS: Record<string, Record<string, UnitRule>> = {
  TRIGLYCERIDE: {
    'mg/dL': { scale: 1, offset: 0 },
    'mmol/L': { scale: 88.57, offset: 0 },
    // 部分检验科报 g/L
    'g/L': { scale: 100, offset: 0 },
  },
  FIBRINOGEN: {
    'mg/dL': { scale: 1, offset: 0 },
    'g/L': { scale: 100, offset: 0 },
  },
  FERRITIN: {
    'ng/mL': { scale: 1, offset: 0 },
    'ug/L': { scale: 1, offset: 0 },
    'µg/L': { scale: 1, offset: 0 },
    'μg/L': { scale: 1, offset: 0 },
  },
  TEMP: {
    '℃': { scale: 1, offset: 0 },
    '°C': { scale: 1, offset: 0 },
    'C': { scale: 1, offset: 0 },
    '℉': { scale: 5 / 9, offset: -32 * (5 / 9) },
    '°F': { scale: 5 / 9, offset: -32 * (5 / 9) },
    'F': { scale: 5 / 9, offset: -32 * (5 / 9) },
  },
  // 以下指标本期只有一种常用单位，也显式登记，避免「未知单位」被静默放过
  PLATELET: { '10^9/L': { scale: 1, offset: 0 }, '×10⁹/L': { scale: 1, offset: 0 }, '10*9/L': { scale: 1, offset: 0 } },
  AST: { 'U/L': { scale: 1, offset: 0 } },
  LDH: { 'U/L': { scale: 1, offset: 0 } },
  CRP: { 'mg/L': { scale: 1, offset: 0 }, 'mg/dL': { scale: 10, offset: 0 } },
  ESR: { 'mm/h': { scale: 1, offset: 0 } },
  D_DIMER: { 'ug/mL FEU': { scale: 1, offset: 0 }, 'mg/L FEU': { scale: 1, offset: 0 }, 'μg/mL FEU': { scale: 1, offset: 0 } },
  SODIUM: { 'mmol/L': { scale: 1, offset: 0 } },
  HEMOGLOBIN: { 'g/L': { scale: 1, offset: 0 }, 'g/dL': { scale: 10, offset: 0 } },
  WBC: { '10^9/L': { scale: 1, offset: 0 }, '×10⁹/L': { scale: 1, offset: 0 } },
  NEUTROPHIL_PCT: { '%': { scale: 1, offset: 0 } },
  PCT: { 'ng/mL': { scale: 1, offset: 0 }, 'ng/L': { scale: 0.001, offset: 0 } },
  WEIGHT: { kg: { scale: 1, offset: 0 } },
  HEIGHT_SD: { SD: { scale: 1, offset: 0 } },
  BONE_AGE_LAG_YEARS: { '年': { scale: 1, offset: 0 }, years: { scale: 1, offset: 0 } },
};

export interface CanonicalValue {
  value: number;
  unit: string;
}

/**
 * 把原值换算到该指标的标准单位。
 * @throws UnitError 缺单位、未知指标、未知单位
 */
export function toCanonical(value: number, unit: string | null | undefined, code: string): CanonicalValue {
  requireFinite(value);
  if (unit === null || unit === undefined || String(unit).trim() === '') {
    // T5：缺失单位必须抛错，不默认
    throw new UnitError(`观测值缺少单位，无法换算（code=${code}）`);
  }
  const table = CONVERSIONS[code];
  if (!table) {
    throw new UnitError(`未知指标编码：${code}`);
  }
  const rule = table[unit.trim()];
  if (!rule) {
    // T6：未知单位必须抛错，不静默返回原值
    throw new UnitError(`指标 ${code} 不支持的单位：${unit}`);
  }
  const converted = value * rule.scale + rule.offset;
  // 消除浮点尾差：保留 6 位有效小数
  return { value: roundTo(converted, 6), unit: canonicalUnitOf(code) };
}

/** 该指标的标准单位（用于换算结果标注） */
export function canonicalUnitOf(code: string): string {
  const table = CONVERSIONS[code];
  if (!table) throw new UnitError(`未知指标编码：${code}`);
  // 约定：每个指标的第一项即标准单位，与 CODE_TABLE.canonicalUnit 保持一致
  const first = Object.keys(table)[0];
  if (!first) throw new UnitError(`指标 ${code} 未登记换算关系`);
  return first;
}

/** 反向换算：把标准单位的值转成指定单位（展示层用，如把 156 mg/dL 显示成 1.76 mmol/L） */
export function fromCanonical(canonical: number, targetUnit: string, code: string): number {
  requireFinite(canonical);
  const rule = CONVERSIONS[code]?.[targetUnit.trim()];
  if (!rule) throw new UnitError(`指标 ${code} 不支持的单位：${targetUnit}`);
  return roundTo((canonical - rule.offset) / rule.scale, 6);
}

/** 是否支持该单位（不抛错的探测） */
export function supportsUnit(code: string, unit: string): boolean {
  return Boolean(CONVERSIONS[code]?.[unit.trim()]);
}

function roundTo(n: number, digits: number): number {
  requireFinite(n);
  const f = 10 ** digits;
  const rounded = Math.round(n * f) / f;
  requireFinite(rounded);
  return rounded;
}

function requireFinite(value: number): void {
  if (!Number.isFinite(value)) throw new UnitError('观测值或换算结果必须是有限数值');
}
