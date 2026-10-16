import { describe, expect, it } from 'vitest';
import type { Code, EngineInput, MsScoreResult, Observation } from '@mas/domain';
import { DEFAULT_CONFIG, evaluate } from '../src/index.js';
import { canEscalateOnScoreOnly } from '../src/layer3-score.js';
import { fullInput, NOW } from './fixtures.js';

function scoreInput(): EngineInput {
  const observations: Observation[] = [
    ['PLATELET', 200, '10^9/L'], ['LDH', 500, 'U/L'],
    ['FIBRINOGEN', 100, 'mg/dL'], ['FERRITIN', 100, 'ng/mL'],
  ].map(([code, value, unit]) => ({
    id: `score-${code}`, patientId: 'pat-zhang', code: code as Code, display: String(code),
    valueNumeric: Number(value), unit: String(unit), observedAt: NOW, recordedAt: NOW,
    source: 'LAB', recordedBy: 'clinician-test',
  }));
  return fullInput({
    observations, baseline: [], thresholds: DEFAULT_CONFIG,
    joints: [{ patientId: 'pat-zhang', observedAt: NOW, assessedBy: 'clinician-test', activityLevel: 'FULL', source: 'CLINICIAN' }],
  });
}

describe('MS score 的观察值与独立升级资格', () => {
  it.each(['PLATELET', 'LDH', 'FIBRINOGEN', 'FERRITIN'] as Code[])('缺少 %s 时保留连续分数和跨线状态，但不独立驱动极危', (code) => {
    const input = scoreInput();
    const out = evaluate({ ...input, observations: input.observations.filter((o) => o.code !== code) });
    expect(out.msScore.value).not.toBeNull();
    expect(out.msScore.crossed).toBe(true);
    expect(out.msScore.confidence).toBe('PARTIAL');
    expect(out.riskLevel).not.toBe('CRITICAL');
  });

  it('缺少关节炎活动度时，跨线分数不能独立驱动极危', () => {
    const out = evaluate({ ...scoreInput(), joints: [] });
    expect(out.msScore.value).toBe(-0.49);
    expect(out.msScore.crossed).toBe(true);
    expect(out.msScore.missingInputs).toContain('关节炎活动度');
    expect(out.riskLevel).not.toBe('CRITICAL');
  });

  it('无 CNS/出血记录不能推定阴性：完整化验仍应标注临床缺项', () => {
    const out = evaluate(scoreInput());
    expect(out.msScore.value).toBe(-0.49);
    expect(out.msScore.missingInputs).toEqual(['中枢神经系统表现', '出血表现']);
    expect(out.msScore.confidence).toBe('PARTIAL');
    expect(out.riskLevel).not.toBe('CRITICAL');
  });

  it('临床表现与实验室均有记录时可以生成完整评分', () => {
    const input = scoreInput();
    const symptoms: Observation[] = ['CNS', 'BLEEDING'].map((valueCoded) => ({
      ...input.observations[0]!, id: valueCoded, code: 'TEMP', valueNumeric: undefined, valueCoded, unit: 'code',
    }));
    const out = evaluate({ ...input, observations: [...input.observations, ...symptoms] });
    expect(out.msScore.value).toBe(2.59);
    expect(out.msScore.missingInputs).toEqual([]);
    expect(out.msScore.confidence).toBe('FULL');
    expect(out.riskLevel).toBe('CRITICAL');
  });

  it('缺项评分被禁止升级时，不把真实跨线状态改写为模型分歧', () => {
    const input = fullInput();
    const observations = input.observations.map((o) => o.code === 'PLATELET' && o.observedAt === '2026-06-12T08:00:00+08:00'
      ? { ...o, valueNumeric: 100 }
      : o);
    const out = evaluate({ ...input, observations });
    expect(out.msScore.crossed).toBe(true);
    expect(out.msScore.confidence).toBe('PARTIAL');
    expect(out.msScore.divergence).toBeUndefined();
  });

  it('独立临床红旗不被缺项评分的守卫压低', () => {
    const input = scoreInput();
    const cns: Observation = {
      ...input.observations[0]!, id: 'cns', code: 'TEMP', valueNumeric: undefined, valueCoded: 'CNS', unit: 'code',
    };
    const out = evaluate({ ...input, observations: [cns], joints: [] });
    expect(out.msScore.value).toBeNull();
    expect(out.riskLevel).toBe('CRITICAL');
    expect(out.actionLevel).toBe('ACT_NOW');
  });

  it.each(['关节炎活动度', '中枢神经系统表现', '出血表现', '血小板计数', 'LDH', '纤维蛋白原', '铁蛋白'])('评分守卫拒绝缺少 %s 的独立升级', (missing) => {
    const score: MsScoreResult = { value: -1, cutoff: -2.1, crossed: true, confidence: 'PARTIAL', missingInputs: [missing] };
    expect(canEscalateOnScoreOnly(score)).toBe(false);
  });

  it('评分守卫拒绝 null 分数并接受完整分数', () => {
    const score: MsScoreResult = { value: null, cutoff: -2.1, crossed: false, confidence: 'PARTIAL', missingInputs: [] };
    expect(canEscalateOnScoreOnly(score)).toBe(false);
    expect(canEscalateOnScoreOnly({ ...score, value: -1, confidence: 'FULL', crossed: true })).toBe(true);
  });
});
