import { describe, expect, it } from 'vitest';
import { validateJointAssessmentInput, validateJointExamInput } from '../src/joint.js';

describe('J-01/J-02 关节领域校验', () => {
  it('接受完整患者速记并保留三项量表边界', () => {
    expect(validateJointAssessmentInput({
      observedAt: '2026-10-05T09:00:00.000Z', morningStiffnessMinutes: 15, painNrs: 4,
      activityLevel: 'LIMITED', respondent: 'PATIENT',
    })).toMatchObject({ morningStiffnessMinutes: 15, painNrs: 4, activityLevel: 'LIMITED', respondent: 'PATIENT' });
  });

  it('拒绝越界疼痛和非离散晨僵', () => {
    expect(() => validateJointAssessmentInput({ observedAt: '2026-10-05T09:00:00.000Z', morningStiffnessMinutes: 20, painNrs: 11, activityLevel: 'FULL', respondent: 'PATIENT' })).toThrow();
  });

  it('门诊评估允许缺项，但拒绝超出 68/66 和 PhGA 范围', () => {
    expect(validateJointExamInput({ assessedAt: '2026-10-05T09:00:00.000Z', instrument: 'NONE' })).toMatchObject({ instrument: 'NONE' });
    expect(() => validateJointExamInput({ assessedAt: '2026-10-05T09:00:00.000Z', tenderJointCount: 69 })).toThrow();
    expect(() => validateJointExamInput({ assessedAt: '2026-10-05T09:00:00.000Z', physicianGlobalAssessment: -1 })).toThrow();
  });
});
