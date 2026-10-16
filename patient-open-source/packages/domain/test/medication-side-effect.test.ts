import { describe, expect, it } from 'vitest';
import { buildMedicationSideEffectReport, classifyMedicationSideEffect, medicationSideEffectDefinition, medicationSideEffectDefinitions, medicationSideEffectRouting, validateMedicationSideEffectReport } from '../src/index.js';

describe('M-04 副作用固定分级与路由', () => {
  it('常见项固定为 EXPECTED，绝不产生告警或随访', () => {
    for (const code of ['MOON_FACE_WEIGHT_GAIN', 'INCREASED_APPETITE', 'MOOD_SWINGS', 'SLEEP_DIFFICULTY', 'ACNE_HAIR_GROWTH', 'JOINT_BONE_PAIN'] as const) {
      expect(classifyMedicationSideEffect(code)).toBe('EXPECTED');
      expect(medicationSideEffectRouting(code)).toEqual({ createsClinicalAlert: false, createsFollowUp: false, immediateMessage: false });
    }
  });

  it('生长变慢进入 MONITOR，不触发告警但保留长期随访含义', () => {
    expect(classifyMedicationSideEffect('SLOW_GROWTH')).toBe('MONITOR');
    expect(medicationSideEffectRouting('SLOW_GROWTH')).toEqual({ createsClinicalAlert: false, createsFollowUp: true, immediateMessage: false });
  });

  it('需告诉医生项只进入随访清单，URGENT 才触发即时提示', () => {
    expect(medicationSideEffectRouting('EYE_DISCOMFORT_OR_BLUR')).toEqual({ createsClinicalAlert: false, createsFollowUp: true, immediateMessage: false });
    expect(medicationSideEffectRouting('SEVERE_INFECTION')).toEqual({ createsClinicalAlert: true, createsFollowUp: false, immediateMessage: true });
  });

  it('定义和文案是完整、隔离的公开值，未知编码拒绝', () => {
    const definitions = medicationSideEffectDefinitions();
    expect(definitions).toHaveLength(12);
    expect(definitions.every(item => item.label && item.guidance)).toBe(true);
    const first = medicationSideEffectDefinition('MOON_FACE_WEIGHT_GAIN')!;
    first.label = 'tampered';
    expect(medicationSideEffectDefinition('MOON_FACE_WEIGHT_GAIN')!.label).not.toBe('tampered');
    expect(medicationSideEffectDefinition('UNKNOWN')).toBeUndefined();
    expect(() => classifyMedicationSideEffect('UNKNOWN')).toThrow(/未知/);
  });

  it('报告构造器按编码派生分级，拒绝恢复时的分级篡改', () => {
    const input = { id: 'se-1', patientId: 'p-1', symptomCode: 'SEVERE_INFECTION' as const, reportedAt: '2026-10-04T00:00:00.000Z', reportedBy: 'actor-1' };
    expect(buildMedicationSideEffectReport(input).severity).toBe('URGENT');
    expect(() => validateMedicationSideEffectReport({ ...buildMedicationSideEffectReport(input), severity: 'EXPECTED' })).toThrow(/不一致/);
  });
});
