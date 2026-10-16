import { describe, expect, it } from 'vitest';
import type { DifferentialConfig, Observation, ThresholdConfig } from '@mas/domain';
import { DEFAULT_CONFIG, evaluate, evaluateDifferential } from '../src/index.js';
import { buildSeries } from '../src/series.js';
import { fullInput, patient } from './fixtures.js';

const reviewedDifferential: DifferentialConfig = {
  reviewed: true,
  ruleVersion: 'differential-stage0-v1',
  channels: [
    { key: 'MAS_SUPPORT', items: [
      { code: 'PLATELET_DROP_48H', direction: 'UP', weight: 3 },
      { code: 'FERRITIN_VS_BASELINE', direction: 'UP', weight: 2 },
      { code: 'AST', direction: 'UP', weight: 2 },
      { code: 'ARTHRITIS_IMPROVED', direction: 'UP', weight: 3 },
      { code: 'FIBRINOGEN', direction: 'DOWN', weight: 3 },
      { code: 'FEVER_PATTERN', direction: 'CONTINUOUS', weight: 2 },
    ] },
    { key: 'SJIA_FLARE_SUPPORT', items: [
      { code: 'ARTHRITIS_WORSENED', direction: 'UP', weight: 3 },
      { code: 'PLATELET', direction: 'NORMAL_OR_UP', weight: 2 },
      { code: 'FIBRINOGEN_NORMAL_OR_UP', direction: 'NORMAL_OR_UP', weight: 2 },
      { code: 'FEVER_PATTERN', direction: 'INTERMITTENT', weight: 2 },
    ] },
    { key: 'INFECTION_SUPPORT', items: [
      { code: 'PCT', direction: 'UP', weight: 2, threshold: 0.5 },
      { code: 'CULTURE', direction: 'POSITIVE', weight: 3 },
    ] },
    { key: 'OTHER_SUPPORT', items: [
      { code: 'FERRITIN_EXTREME', direction: 'UP', weight: 2, threshold: 10_000 },
    ] },
  ],
  dataGapPriority: ['LDH', 'D_DIMER', 'PCT', 'EBV_CMV', 'CULTURE', 'FEVER_PATTERN', 'JOINT_DIRECTION'],
  strengthThresholds: { strong: 5, medium: 3 },
  presentation: { showChannelWhen: 'ALWAYS', minStrengthToShow: 'WEAK' },
};

function thresholds(overrides: Partial<ThresholdConfig> = {}): ThresholdConfig {
  return { ...DEFAULT_CONFIG, ...overrides, differential: reviewedDifferential };
}

describe('四通道证据板 · 阶段 0 工程结构合同', () => {
  it('配置缺失或未复核时 fail-closed，且不改变旧输出', () => {
    const base = evaluate(fullInput());
    const withoutConfig = evaluate(fullInput({ thresholds: { ...DEFAULT_CONFIG, differential: undefined } }));
    const draft = evaluate(fullInput({ thresholds: { ...DEFAULT_CONFIG, differential: { ...reviewedDifferential, reviewed: false } } }));
    expect(base.differential).toEqual([]);
    expect(withoutConfig.differential).toEqual([]);
    expect(draft.differential).toEqual([]);
    expect(withoutConfig.riskLevel).toBe(base.riskLevel);
    expect(withoutConfig.signalFingerprint).toBe(base.signalFingerprint);
  });

  it('复核配置输出固定四通道、可追溯证据与优先级缺口', () => {
    const out = evaluate(fullInput({ thresholds: thresholds() }));
    expect(out.differential.map((channel) => channel.key)).toEqual(['MAS_SUPPORT', 'SJIA_FLARE_SUPPORT', 'INFECTION_SUPPORT', 'OTHER_SUPPORT']);
    const mas = out.differential[0]!;
    expect(mas.evidenceCount).toBeGreaterThan(0);
    expect(mas.items.some((item) => item.code === 'PLATELET_DROP_48H' && item.ruleVersion === 'differential-stage0-v1')).toBe(true);
    expect(mas.items.some((item) => item.code === 'FERRITIN_VS_BASELINE')).toBe(true);
    expect(out.dataGaps.find((gap) => gap.code === 'CULTURE')?.priority).toBe(4);
    expect(out.riskLevel).toBe(evaluate(fullInput()).riskLevel);
    expect(out.actionLevel).toBe(evaluate(fullInput()).actionLevel);
  });

  it('关节方向相反时显式暴露冲突，AOSD 不套用 sJIA 活动通道', () => {
    const improved: Observation = {
      id: 'arthritis-improved', patientId: patient.id, code: 'TEMP', display: '症状', valueCoded: 'ARTHRITIS_IMPROVED',
      unit: 'code', observedAt: '2026-06-12T04:00:00+08:00', recordedAt: '2026-06-12T04:00:00+08:00', source: 'PATIENT_REPORTED', recordedBy: 'patient',
    };
    const joint = { patientId: patient.id, observedAt: '2026-06-12T05:00:00+08:00', assessedBy: 'doctor', activityLevel: 'SEVERE' as const, source: 'CLINICIAN' as const, trendFlag: 'WORSENED' as const };
    const out = evaluate(fullInput({ thresholds: thresholds(), observations: [...fullInput().observations, improved], joints: [joint] }));
    expect(out.differential.find((channel) => channel.key === 'MAS_SUPPORT')?.conflictNote).toMatch(/冲突/);
    expect(out.differential.find((channel) => channel.key === 'SJIA_FLARE_SUPPORT')?.conflictNote).toMatch(/冲突/);
    const aosd = evaluate(fullInput({ thresholds: thresholds(), patient: { ...patient, diseaseType: 'AOSD' }, joints: [joint] }));
    const sjia = aosd.differential.find((channel) => channel.key === 'SJIA_FLARE_SUPPORT')!;
    expect(sjia.evidenceCount).toBe(0);
    expect(sjia.gaps).toContain('DISEASE_SCOPE');

    const conflictOnly = evaluate(fullInput({ thresholds: thresholds(), joints: [{ ...joint, dataQuality: 'CONFLICT' }] }));
    const conflictSjia = conflictOnly.differential.find((channel) => channel.key === 'SJIA_FLARE_SUPPORT')!;
    expect(conflictSjia.items.some((item) => item.code === 'ARTHRITIS_WORSENED')).toBe(false);
    expect(conflictSjia.gaps).toContain('JOINT_DIRECTION');
  });

  it('按 code + direction 识别规范配置中的纤维蛋白原方向冲突', () => {
    const config = structuredClone(reviewedDifferential);
    config.channels.find((channel) => channel.key === 'SJIA_FLARE_SUPPORT')!.items = [
      { code: 'FIBRINOGEN', direction: 'NORMAL_OR_UP', weight: 2 },
    ];
    const input = fullInput({ thresholds: { ...DEFAULT_CONFIG, differential: config } });
    const base = evaluate(input);
    const out = evaluateDifferential({
      cfg: input.thresholds,
      configVersion: input.thresholds.version,
      differential: config,
      reasons: [{ code: 'FIBRINOGEN', label: '纤维蛋白原', detail: '来自标准项的纤维蛋白原方向证据', source: 'GUIDELINE_2016', severity: 1, actionability: 1 }],
      standard: base.standard2016,
      trends: base.trends,
      baseline: input.baseline,
      series: buildSeries(input.observations),
      joints: input.joints,
      diseaseType: input.patient.diseaseType,
    });
    expect(out.channels.find((channel) => channel.key === 'MAS_SUPPORT')?.conflictNote).toMatch(/纤维蛋白原方向证据冲突/);
    expect(out.channels.find((channel) => channel.key === 'SJIA_FLARE_SUPPORT')?.conflictNote).toMatch(/纤维蛋白原方向证据冲突/);
  });

  it('保留负向证据并单独计数', () => {
    const improved: Observation = {
      id: 'arthritis-improved-negative', patientId: patient.id, code: 'TEMP', display: '症状', valueCoded: 'ARTHRITIS_IMPROVED',
      unit: 'code', observedAt: '2026-06-12T04:00:00+08:00', recordedAt: '2026-06-12T04:00:00+08:00', source: 'PATIENT_REPORTED', recordedBy: 'patient',
    };
    const config = structuredClone(reviewedDifferential);
    config.channels.find((channel) => channel.key === 'INFECTION_SUPPORT')!.items.push({ code: 'ARTHRITIS_IMPROVED', direction: 'UP', weight: -2 });
    const out = evaluate(fullInput({ thresholds: { ...DEFAULT_CONFIG, differential: config }, observations: [...fullInput().observations, improved] }));
    const infection = out.differential.find((channel) => channel.key === 'INFECTION_SUPPORT')!;
    expect(infection.negativeEvidenceCount).toBe(1);
    expect(infection.items.find((item) => item.code === 'ARTHRITIS_IMPROVED')?.weight).toBe(-2);
  });

  it('规则阈值与运行配置不一致时只报配置缺口，不输出误配证据', () => {
    const config = structuredClone(reviewedDifferential);
    config.channels.find((channel) => channel.key === 'MAS_SUPPORT')!.items.find((item) => item.code === 'AST')!.threshold = 49;
    const out = evaluate(fullInput({ thresholds: { ...DEFAULT_CONFIG, differential: config } }));
    const mas = out.differential.find((channel) => channel.key === 'MAS_SUPPORT')!;
    expect(mas.items.some((item) => item.code === 'AST')).toBe(false);
    expect(mas.gaps).toContain('RULE:AST:THRESHOLD_MISMATCH');
  });

  it('过滤未来与 NO_ALERT 输入，重复运行及乱序保持确定', () => {
    const input = fullInput({ thresholds: thresholds(), observations: [
      ...fullInput().observations,
      { id: 'future-pct', patientId: patient.id, code: 'PCT', display: '降钙素原', valueNumeric: 2, unit: 'ng/mL', observedAt: '2026-06-13T00:00:00+08:00', recordedAt: '2026-06-13T00:00:00+08:00', source: 'LAB', recordedBy: 'lab' },
      { id: 'private-pct', patientId: patient.id, code: 'PCT', display: '降钙素原', valueNumeric: 2, unit: 'ng/mL', observedAt: '2026-06-12T04:00:00+08:00', recordedAt: '2026-06-12T04:00:00+08:00', source: 'LAB', recordedBy: 'lab', tags: ['NO_ALERT'] },
    ] });
    const a = evaluate(input);
    const b = evaluate({ ...input, observations: [...input.observations].reverse() });
    expect(a.differential).toEqual(b.differential);
    expect(a.differential.find((channel) => channel.key === 'INFECTION_SUPPORT')?.items.some((item) => item.code === 'PCT')).toBe(false);
  });

  it('仅接受当前时效窗口内的显式持续高热，体温序列分类未复核时保持缺口', () => {
    const continuous = evaluate(fullInput({ thresholds: thresholds() }));
    const mas = continuous.differential.find((channel) => channel.key === 'MAS_SUPPORT')!;
    expect(mas.items.find((item) => item.code === 'FEVER_PATTERN')?.direction).toBe('CONTINUOUS');
    expect(mas.items.find((item) => item.code === 'FEVER_PATTERN')?.source).toBe('SYMPTOM');
    expect(mas.items.find((item) => item.code === 'FEVER_PATTERN')?.inputRefs?.[0]).toMatch(/^symptom:FEVER_HIGH:/);
    expect(continuous.differential.find((channel) => channel.key === 'SJIA_FLARE_SUPPORT')?.gaps).toContain('FEVER_PATTERN');

    const intermittentTemps: Observation[] = [
      { ...fullInput().observations.find((item) => item.code === 'TEMP' && item.valueNumeric !== undefined)!, id: 'fever-day-1', valueNumeric: 39.1, observedAt: '2026-06-10T20:00:00+08:00', recordedAt: '2026-06-10T20:00:00+08:00' },
      { ...fullInput().observations.find((item) => item.code === 'TEMP' && item.valueNumeric !== undefined)!, id: 'fever-day-2', valueNumeric: 37.2, observedAt: '2026-06-11T12:00:00+08:00', recordedAt: '2026-06-11T12:00:00+08:00' },
      { ...fullInput().observations.find((item) => item.code === 'TEMP' && item.valueNumeric !== undefined)!, id: 'fever-day-3', valueNumeric: 39.0, observedAt: '2026-06-12T03:00:00+08:00', recordedAt: '2026-06-12T03:00:00+08:00' },
    ];
    const intermittent = evaluate(fullInput({ thresholds: thresholds(), observations: fullInput().observations.filter((item) => item.code !== 'TEMP').concat(intermittentTemps) }));
    const sjia = intermittent.differential.find((channel) => channel.key === 'SJIA_FLARE_SUPPORT')!;
    expect(sjia.items.some((item) => item.code === 'FEVER_PATTERN')).toBe(false);
    expect(sjia.gaps).toContain('FEVER_PATTERN');
    const insufficient = evaluate(fullInput({ thresholds: thresholds(), observations: fullInput().observations.filter((item) => item.code !== 'TEMP').concat(intermittentTemps.slice(0, 2)) }));
    expect(insufficient.differential.find((channel) => channel.key === 'MAS_SUPPORT')?.gaps).toContain('FEVER_PATTERN');

    const stale = evaluate(fullInput({
      thresholds: thresholds(),
      now: '2026-06-20T09:00:00+08:00',
      observations: fullInput().observations.filter((item) => item.observedAt < '2026-06-13T00:00:00+08:00'),
    }));
    expect(stale.differential.find((channel) => channel.key === 'MAS_SUPPORT')?.items.some((item) => item.code === 'FEVER_PATTERN')).toBe(false);
    expect(stale.differential.find((channel) => channel.key === 'MAS_SUPPORT')?.gaps).toContain('FEVER_PATTERN');

    const futureOnly = evaluate(fullInput({
      thresholds: thresholds(),
      observations: [
        { ...intermittentTemps[0]!, id: 'future-fever-1', observedAt: '2026-06-13T03:00:00+08:00', recordedAt: '2026-06-13T03:00:00+08:00' },
        { ...intermittentTemps[1]!, id: 'future-fever-2', observedAt: '2026-06-14T03:00:00+08:00', recordedAt: '2026-06-14T03:00:00+08:00' },
        { ...intermittentTemps[2]!, id: 'private-fever', observedAt: '2026-06-12T03:00:00+08:00', recordedAt: '2026-06-12T03:00:00+08:00', tags: ['NO_ALERT'] },
      ],
    }));
    expect(futureOnly.differential.find((channel) => channel.key === 'MAS_SUPPORT')?.items.some((item) => item.code === 'FEVER_PATTERN')).toBe(false);
    expect(futureOnly.differential.find((channel) => channel.key === 'SJIA_FLARE_SUPPORT')?.gaps).toContain('FEVER_PATTERN');
  });
});
