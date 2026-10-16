import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/index.js';
import { layer1Rules } from '../src/layer1-rules.js';
import { buildSeries } from '../src/series.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { fullInput, NOW, patient } from './fixtures.js';
import type { Code, Observation } from '@mas/domain';

function lab(code: Code, valueNumeric: number, unit: string, observedAt = NOW): Observation {
  return { id: `${code}-${observedAt}`, patientId: patient.id, code, display: code,
    valueNumeric, unit, observedAt, recordedAt: observedAt, source: 'LAB', recordedBy: 'doctor' };
}
function rules(observations: Observation[]) {
  return layer1Rules(buildSeries(observations), DEFAULT_CONFIG, fullInput().safetyNet, NOW);
}

describe('2016 规则清单边界（不等同于临床诊断）', () => {
  it.each([
    ['FERRITIN', 684, 'ng/mL', false], ['FERRITIN', 685, 'ng/mL', true],
    ['PLATELET', 181, '10^9/L', true], ['PLATELET', 182, '10^9/L', false],
    ['AST', 48, 'U/L', false], ['AST', 49, 'U/L', true],
    ['TRIGLYCERIDE', 156, 'mg/dL', false], ['TRIGLYCERIDE', 157, 'mg/dL', true],
    ['FIBRINOGEN', 360, 'mg/dL', true], ['FIBRINOGEN', 361, 'mg/dL', false],
  ] as const)('%s 在 %s 的比较符正确', (code, value, unit, met) => {
    expect(rules([lab(code, value, unit)]).standard.items.find((item) => item.key === code)?.met).toBe(met);
  });
  it('纤维蛋白原 2016 的 360 和 HLH 的 150 分别判读', () => {
    const result = rules([lab('FIBRINOGEN', 3, 'g/L')]);
    expect(result.standard.items.find((item) => item.key === 'FIBRINOGEN')?.met).toBe(true);
    expect(result.hlh.fibrinogenMet).toBe(false);
    expect(rules([lab('FIBRINOGEN', 1.5, 'g/L')]).hlh.fibrinogenMet).toBe(true);
  });
  it('无发热观测应标记未测，不能当成未发热', () => {
    expect(rules([]).standard.items.find((item) => item.key === 'FEVER')?.met).toBe('NOT_MEASURED');
  });
  it('单独构造早期病例：标准未满足也会因神经症状立即行动', () => {
    const observations: Observation[] = [lab('TEMP', 39, '℃'), lab('FERRITIN', 900, 'ng/mL'), lab('PLATELET', 180, '10^9/L'),
      { ...lab('TEMP', 0, 'code'), valueNumeric: undefined, valueCoded: 'CNS' }];
    const out = evaluate(fullInput({ observations, baseline: [] }));
    expect(out.standard2016.satisfied).toBe(false);
    expect(out.standard2016.labCriteriaMet).toBe(1);
    expect(out.actionLevel).toBe('ACT_NOW');
    expect(out.reasons.some((reason) => reason.code === 'CNS')).toBe(true);
  });
  it('隔日记录不能算连续三天发热峰值升高', () => {
    const out = rules([
      lab('TEMP', 38.7, '℃', '2026-06-08T09:00:00+08:00'),
      lab('TEMP', 39, '℃', '2026-06-10T09:00:00+08:00'),
      lab('TEMP', 39.3, '℃', '2026-06-12T09:00:00+08:00'),
    ]);
    expect(out.reasons.some((reason) => reason.code === 'FEVER_RISING')).toBe(false);
  });
  it('正常体温连续升高不能触发发热趋势或立即行动', () => {
    const observations = [
      lab('TEMP', 36.5, '℃', '2026-06-10T09:00:00+08:00'),
      lab('TEMP', 36.6, '℃', '2026-06-11T09:00:00+08:00'),
      lab('TEMP', 36.7, '℃', '2026-06-12T09:00:00+08:00'),
    ];
    const out = evaluate(fullInput({ observations, baseline: [] }));
    expect(out.reasons.some((reason) => reason.code === 'FEVER_RISING')).toBe(false);
    expect(out.riskLevel).toBe('LOW');
    expect(out.actionLevel).toBe('OBSERVE');
  });
  it('临床风险与安全网正交', () => {
    const input = fullInput({ observations: [], baseline: [], safetyNet: { ...fullInput().safetyNet, contactsUnresponsive: true } });
    const out = evaluate(input);
    expect(out.riskLevel).toBe('LOW');
    expect(out.safetyNetStatus).toBe('NO_RESPONSE');
    expect(out.actionLevel).toBe('REVIEW');
    expect(out.suggestions.some((suggestion) => suggestion.includes('社会支持'))).toBe(true);
  });
});
