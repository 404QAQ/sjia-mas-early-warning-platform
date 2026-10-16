import { describe, expect, it } from 'vitest';
import type { Observation } from '@mas/domain';
import { evaluate } from '../src/index.js';
import { fullInput, NOW } from './fixtures.js';

function trendInput(values = [200, 180, 130], isLivingAlone = true) {
  const hoursAgo = [28, 22, 16];
  const observations: Observation[] = values.map((valueNumeric, index) => {
    const at = new Date(Date.parse(NOW) - hoursAgo[index]! * 3_600_000).toISOString();
    return {
      id: `platelet-${index}`, patientId: 'pat-zhang', code: 'PLATELET', display: '血小板计数',
      valueNumeric, unit: '10^9/L', observedAt: at, recordedAt: at, source: 'LAB', recordedBy: 'clinician-test',
    };
  });
  const input = fullInput({ observations, baseline: [], joints: [] });
  return {
    ...input,
    patient: { ...input.patient, isLivingAlone },
    safetyNet: { ...input.safetyNet, lastActiveAt: undefined, isLivingAlone },
  };
}

describe('安全网使用最终临床风险', () => {
  it('只有趋势层判为高危的独居患者，16h 无记录时必须显示无人响应', () => {
    const out = evaluate(trendInput());
    expect(out.standard2016.satisfied).toBe(false);
    expect(out.msScore.confidence).toBe('PARTIAL');
    expect(out.reasons.find((reason) => reason.code === 'PLATELET_DROP')?.severity).toBe(3);
    expect(out.riskLevel).toBe('HIGH');
    expect(out.actionLevel).toBe('ACT_NOW');
    expect(out.safetyNetStatus).toBe('NO_RESPONSE');
    expect(out.safetyNetNote).toContain('16 小时');
  });

  it('相同的趋势高危在非独居状态下显示待确认', () => {
    const out = evaluate(trendInput([200, 180, 130], false));
    expect(out.riskLevel).toBe('HIGH');
    expect(out.safetyNetStatus).toBe('PENDING');
    expect(out.safetyNetNote).toContain('16 小时');
  });

  it('补充当前活跃记录只改变安全网状态，不改变临床风险', () => {
    const input = trendInput();
    const silent = evaluate(input);
    const active = evaluate({ ...input, safetyNet: { ...input.safetyNet, lastActiveAt: NOW } });
    expect(silent.safetyNetStatus).toBe('NO_RESPONSE');
    expect(active.safetyNetStatus).toBe('IN_CARE');
    expect(active.safetyNetNote).toBeUndefined();
    expect(active.riskLevel).toBe(silent.riskLevel);
  });

  it('稳定指标不因独居且16h无记录而被改成临床高危', () => {
    const out = evaluate(trendInput([200, 200, 200]));
    expect(out.riskLevel).toBe('LOW');
    expect(out.safetyNetStatus).toBe('IN_CARE');
    expect(out.actionLevel).toBe('OBSERVE');
  });

  it('低临床风险的联系人失联只升级安全网行动，不升级临床风险', () => {
    const input = trendInput([200, 200, 200]);
    const out = evaluate({ ...input, safetyNet: { ...input.safetyNet, contactsUnresponsive: true } });
    expect(out.riskLevel).toBe('LOW');
    expect(out.safetyNetStatus).toBe('NO_RESPONSE');
    expect(out.actionLevel).toBe('REVIEW');
    expect(out.reasons.filter((reason) => reason.code === 'SAFETY_NET')).toHaveLength(1);
    expect(out.suggestions.some((suggestion) => suggestion.includes('社会支持介入'))).toBe(true);
  });

  it('两阶段计算可重复，且不修改原始输入', () => {
    const input = trendInput();
    const original = structuredClone(input);
    const first = evaluate(input);
    expect(evaluate(input)).toEqual(first);
    expect(input).toEqual(original);
  });
});
