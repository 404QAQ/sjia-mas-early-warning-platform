import { describe, expect, it } from 'vitest';
import { fromCanonical, toCanonical, UnitError, supportsUnit } from '../src/units.js';

/**
 * docs/tech/01 §3.3 的必修单测清单 T1–T7。
 * T3 是最重要的一条：2016 标准与 HLH-2004 用不同的纤维蛋白原阈值，不可混用。
 */
describe('单位换算 T1–T7', () => {
  it('T1 甘油三酯 156 mg/dL → mmol/L ≈ 1.76', () => {
    const r = toCanonical(156, 'mg/dL', 'TRIGLYCERIDE');
    expect(r.unit).toBe('mg/dL');
    expect(r.value).toBe(156);
    const asMmol = fromCanonical(156, 'mmol/L', 'TRIGLYCERIDE');
    expect(asMmol).toBeCloseTo(1.76, 2);
  });

  it('T2 甘油三酯 1.76 mmol/L → mg/dL ≈ 155.9（阈值比较走换算路径）', () => {
    const r = toCanonical(1.76, 'mmol/L', 'TRIGLYCERIDE');
    expect(r.unit).toBe('mg/dL');
    expect(r.value).toBeCloseTo(155.9, 1);
    // 与 2016 阈值 156 比较：1.76 mmol/L 未超过阈值，1.77 超过
    expect(r.value > 156).toBe(false);
    expect(toCanonical(1.77, 'mmol/L', 'TRIGLYCERIDE').value > 156).toBe(true);
  });

  it('T3 HLH-2004 纤维蛋白原 1.5 g/L = 150 mg/dL，与 2016 标准 360 mg/dL 不同且不可混用', () => {
    const r = toCanonical(1.5, 'g/L', 'FIBRINOGEN');
    expect(r.value).toBeCloseTo(150, 6);
    expect(r.unit).toBe('mg/dL');
    // 150 ≤ 360（满足 2016），同时也 ≤ 150（满足 HLH）
    expect(r.value <= 360).toBe(true);
    expect(r.value <= 150).toBe(true);
    // 而 3.0 g/L = 300 mg/dL：满足 2016（≤360），但不满足 HLH（>150）
    const r2 = toCanonical(3.0, 'g/L', 'FIBRINOGEN');
    expect(r2.value).toBeCloseTo(300, 6);
    expect(r2.value <= 360).toBe(true);
    expect(r2.value <= 150).toBe(false);
  });

  it('T4 铁蛋白 ng/mL ↔ μg/L 为 1:1，值不变', () => {
    expect(toCanonical(3400, 'ng/mL', 'FERRITIN').value).toBe(3400);
    expect(toCanonical(3400, 'μg/L', 'FERRITIN').value).toBe(3400);
    expect(toCanonical(3400, 'µg/L', 'FERRITIN').value).toBe(3400);
  });

  it('T5 缺失单位时抛错，不默认', () => {
    expect(() => toCanonical(39.2, null, 'TEMP')).toThrow(UnitError);
    expect(() => toCanonical(39.2, undefined, 'TEMP')).toThrow(UnitError);
    expect(() => toCanonical(39.2, '  ', 'TEMP')).toThrow(UnitError);
  });

  it('T6 未知单位抛错，不静默返回原值', () => {
    expect(() => toCanonical(39.2, 'K', 'TEMP')).toThrow(UnitError);
    expect(() => toCanonical(156, 'mol/L', 'TRIGLYCERIDE')).toThrow(UnitError);
    expect(() => toCanonical(1, 'x', 'UNKNOWN_CODE')).toThrow(UnitError);
  });

  it('T7 阈值比较在 mmol/L 输入下也正确判读', () => {
    // 138 mg/dL（未达 156）在 mmol/L 输入下：1.558 mmol/L
    const r = toCanonical(1.558, 'mmol/L', 'TRIGLYCERIDE');
    expect(r.value).toBeLessThan(156);
    // 距离阈值差 18（docs/02 §3.1 示例）
    const gap = 156 - (138);
    expect(gap).toBe(18);
  });

  it('甘油三酯 g/L 与 mg/dL 是质量浓度换算，1 g/L = 100 mg/dL', () => {
    expect(toCanonical(1.56, 'g/L', 'TRIGLYCERIDE')).toEqual({ value: 156, unit: 'mg/dL' });
    expect(fromCanonical(156, 'g/L', 'TRIGLYCERIDE')).toBe(1.56);
    expect(toCanonical(1.56, 'g/L', 'TRIGLYCERIDE').value > 156).toBe(false);
    expect(toCanonical(1.57, 'g/L', 'TRIGLYCERIDE').value > 156).toBe(true);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('拒绝非有限数值 %s', (value) => {
    expect(() => toCanonical(value, 'ng/mL', 'FERRITIN')).toThrow(UnitError);
    expect(() => fromCanonical(value, 'ng/mL', 'FERRITIN')).toThrow(UnitError);
  });

  it('换算溢出时拒绝产生非有限结果', () => {
    expect(() => toCanonical(Number.MAX_VALUE, 'g/L', 'TRIGLYCERIDE')).toThrow(UnitError);
    expect(() => fromCanonical(Number.MAX_VALUE, 'ng/L', 'PCT')).toThrow(UnitError);
  });

  it('体温 ℃ ↔ ℉ 为仿射变换', () => {
    expect(toCanonical(98.6, '℉', 'TEMP').value).toBeCloseTo(37, 1);
    expect(toCanonical(39.8, '℃', 'TEMP').value).toBe(39.8);
    expect(fromCanonical(39.8, '℉', 'TEMP')).toBeCloseTo(103.64, 2);
  });

  it('supportsUnit 做不抛错的探测', () => {
    expect(supportsUnit('TEMP', '℃')).toBe(true);
    expect(supportsUnit('TEMP', 'K')).toBe(false);
    expect(supportsUnit('UNKNOWN', '℃')).toBe(false);
  });
});
