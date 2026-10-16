import { describe, expect, it } from 'vitest';
import type { EngineInput, JointAssessment, Observation, PersonalBaseline } from '@mas/domain';
import { evaluate } from '../src/index.js';
import { fullInput, NOW } from './fixtures.js';

const FUTURE = '2026-06-13T09:00:00+08:00';

function joint(overrides: Partial<JointAssessment> = {}): JointAssessment {
  return {
    patientId: 'pat-zhang',
    observedAt: NOW,
    assessedBy: 'clinician-test',
    activityLevel: 'FULL',
    source: 'CLINICIAN',
    ...overrides,
  };
}

function freezeDeep(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
}

describe('引擎输入快照', () => {
  it('关键指标缺失时使用中文名称提示数据缺口', () => {
    const out = evaluate(fullInput({ observations: [], baseline: [], joints: [] }));
    expect(out.dataGaps.find((gap) => gap.code === 'PLATELET')?.display).toBe('血小板计数');
    expect(out.dataGaps.find((gap) => gap.code === 'FERRITIN')?.display).toBe('铁蛋白');
  });

  it.each(['', 'not-a-date', '2026-99-99T00:00:00Z', undefined, null])('now=%s 无效时显式拒绝', (now) => {
    expect(() => evaluate(fullInput({ now: now as string }))).toThrow(/now|时间/);
  });

  it.each(['observations', 'baseline', 'joints'] as const)('%s 中的其他患者数据不能进入判读', (field) => {
    const input = structuredClone(fullInput({ joints: [joint()] }));
    input[field][0]!.patientId = 'another-patient';
    expect(() => evaluate(input)).toThrow(/patientId|患者/);
  });

  it('即使错属患者的数据处于未来，也显式拒绝而非静默丢弃', () => {
    const input = fullInput();
    const future: Observation = { ...input.observations[0]!, patientId: 'another-patient', observedAt: FUTURE };
    expect(() => evaluate({ ...input, observations: [...input.observations, future] })).toThrow(/patientId|患者/);
  });

  it('未来的化验和症状不影响当前判读、证据或指纹', () => {
    const input = fullInput();
    const futureLab: Observation = {
      ...input.observations.find((o) => o.code === 'FERRITIN')!,
      id: 'future-lab', valueNumeric: 100_000, observedAt: FUTURE, recordedAt: FUTURE,
    };
    const futureSymptom: Observation = {
      ...input.observations.find((o) => o.valueCoded)!,
      id: 'future-cns', valueCoded: 'CNS', observedAt: FUTURE, recordedAt: FUTURE,
    };
    expect(evaluate({ ...input, observations: [...input.observations, futureLab, futureSymptom] })).toEqual(evaluate(input));
  });

  it('观察时间已发生、录入时间在未来的回填不泄漏到历史判读', () => {
    const input = fullInput();
    const backfill: Observation = {
      ...input.observations.find((o) => o.code === 'FERRITIN')!, id: 'future-backfill',
      valueNumeric: 100_000, observedAt: NOW, recordedAt: FUTURE, tags: ['OFFLINE_BACKFILL'],
    };
    expect(evaluate({ ...input, observations: [...input.observations, backfill] })).toEqual(evaluate(input));
  });

  it.each(['NO_ALERT', 'OCR_UNVERIFIED'])('%s 数据在快照入口隔离，其无效日期也不参与解析', (tag) => {
    const input = fullInput();
    const excluded: Observation = {
      ...input.observations.find((o) => o.code === 'FERRITIN')!, id: 'excluded',
      valueNumeric: 100_000, observedAt: 'invalid', recordedAt: 'invalid', tags: [tag],
    };
    expect(evaluate({ ...input, observations: [...input.observations, excluded] })).toEqual(evaluate(input));
  });

  it('未来的最后活跃时间不能掩盖历史失联，回退到当时已知的观测', () => {
    const now = '2026-06-13T05:00:00+08:00';
    const input = fullInput({ now });
    const historical = evaluate({ ...input, safetyNet: { ...input.safetyNet, lastActiveAt: undefined } });
    const withFuture = evaluate({ ...input, safetyNet: { ...input.safetyNet, lastActiveAt: FUTURE } });
    expect(historical.safetyNetStatus).toBe('PENDING');
    expect(withFuture).toEqual(historical);
  });

  it('未来关节评估不填补当前缺失的临床输入', () => {
    const input = fullInput();
    const actual = evaluate({ ...input, joints: [joint({ observedAt: FUTURE, activityLevel: 'SEVERE' })] });
    expect(actual).toEqual(evaluate(input));
    expect(actual.msScore.missingInputs).toContain('关节炎活动度');
  });

  it('未来更新的基线不进入当前趋势或证据', () => {
    const input = fullInput();
    const futureBaseline: PersonalBaseline = {
      ...input.baseline[0]!, baselineValue: 10, updatedAt: FUTURE, clinicianNote: '未来才确认的基线备注',
    };
    expect(evaluate({ ...input, baseline: [...input.baseline, futureBaseline] })).toEqual(evaluate(input));
  });

  it('使用不晚于 now 的最新关节评估，输入排列不影响结果', () => {
    const input = fullInput();
    const older = joint({ observedAt: '2026-06-11T09:00:00+08:00', activityLevel: 'SEVERE' });
    const current = joint();
    expect(evaluate({ ...input, joints: [current, older] })).toEqual(evaluate({ ...input, joints: [older, current] }));
  });

  it('恰好在 now 的记录仍参与判读', () => {
    const input = fullInput();
    const symptom: Observation = {
      ...input.observations.find((o) => o.valueCoded)!, id: 'current-cns', valueCoded: 'CNS', observedAt: NOW, recordedAt: NOW,
    };
    const actual = evaluate({ ...input, observations: [...input.observations, symptom], joints: [joint()] });
    expect(actual.reasons.some((reason) => reason.code === 'CNS')).toBe(true);
    expect(actual.msScore.missingInputs).not.toContain('关节炎活动度');
  });

  it('过滤、排序和重复评估均不修改调用方的输入', () => {
    const input: EngineInput = structuredClone(fullInput({ joints: [joint({ observedAt: FUTURE }), joint()] }));
    const before = structuredClone(input);
    freezeDeep(input);
    const first = evaluate(input);
    expect(evaluate(input)).toEqual(first);
    expect(input).toEqual(before);
  });
});
