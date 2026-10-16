import { describe, expect, it } from 'vitest';
import type { Code, Observation } from '@mas/domain';
import { DEFAULT_CONFIG } from '../src/config.js';
import { layer2Trend } from '../src/layer2-trend.js';
import { buildSeries } from '../src/series.js';
import { NOW } from './fixtures.js';

function points(code: Code, values: number[], staleDays = 0): Observation[] {
  return values.map((valueNumeric, index) => {
    const observedAt = new Date(Date.parse(NOW) - (values.length - 1 - index) * 6 * 3_600_000 - staleDays * 86_400_000).toISOString();
    return {
      id: `${code}-${index}`, patientId: 'pat-zhang', code, display: code, valueNumeric,
      unit: code === 'PLATELET' ? '10^9/L' : 'ng/mL',
      observedAt, recordedAt: observedAt, source: 'LAB', recordedBy: 'clinician-test',
    };
  });
}

function trend(platelets: number[], ferritin: number[], staleDays = 0) {
  return layer2Trend(buildSeries([...points('PLATELET', platelets, staleDays), ...points('FERRITIN', ferritin, staleDays)]), [], DEFAULT_CONFIG, NOW);
}

describe('趋势触发资格回归', () => {
  it.each([
    ['稳定', [210, 210, 210]], ['上升', [210, 220, 250]], ['下降未达阈值', [210, 205, 200]],
  ] as const)('血小板%s时，铁蛋白上升不能被误报为双指标协同', (_name, platelets) => {
    const out = trend([...platelets], [100, 130, 180]);
    expect(out.reasons.map((reason) => reason.code)).toContain('FERRITIN_RISE');
    expect(out.reasons.map((reason) => reason.code)).not.toContain('PLATELET_DROP');
    expect(out.reasons.map((reason) => reason.code)).not.toContain('COMBO_PLT_FER');
  });

  it('血小板稳定且只有铁蛋白升高时保留干扰因素提示', () => {
    expect(trend([210, 210, 210], [100, 130, 180]).reasons.map((r) => r.code)).toContain('INTERFERENCE_HINT');
  });

  it('血小板下降恰好达到 20% 且铁蛋白上升达到 50% 时触发协同', () => {
    const out = trend([200, 180, 160], [100, 120, 150]);
    expect(out.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(['PLATELET_DROP', 'FERRITIN_RISE', 'COMBO_PLT_FER']));
  });

  it('铁蛋白环比上升未达到触发阈值时，不把弱变化升级为双指标协同', () => {
    const out = trend([200, 180, 160], [100, 110, 135]);
    expect(out.reasons.map((r) => r.code)).toContain('PLATELET_DROP');
    expect(out.reasons.map((r) => r.code)).not.toContain('FERRITIN_RISE');
    expect(out.reasons.map((r) => r.code)).not.toContain('COMBO_PLT_FER');
  });

  it('跨周铁蛋白升高保留趋势展示，但不能冒充 24h 急剧升高或协同告警', () => {
    const times = ['2026-06-01T09:00:00+08:00', '2026-06-05T09:00:00+08:00', NOW];
    const ferritin = points('FERRITIN', [100, 100, 200]).map((observation, index) => ({
      ...observation, observedAt: times[index]!, recordedAt: times[index]!,
    }));
    const out = layer2Trend(buildSeries([...points('PLATELET', [200, 180, 160]), ...ferritin]), [], DEFAULT_CONFIG, NOW);
    expect(out.signals.some((signal) => signal.code === 'FERRITIN' && signal.kind === 'DELTA_PCT')).toBe(true);
    expect(out.reasons.map((r) => r.code)).toContain('PLATELET_DROP');
    expect(out.reasons.map((r) => r.code)).not.toContain('FERRITIN_RISE');
    expect(out.reasons.map((r) => r.code)).not.toContain('COMBO_PLT_FER');
  });

  it('铁蛋白间隔超过 24h 一分钟时，不因显示值四舍五入越过时间边界', () => {
    const offsets = [48 * 60, 24 * 60 + 1, 0];
    const ferritin = points('FERRITIN', [100, 100, 200]).map((observation, index) => {
      const at = new Date(Date.parse(NOW) - offsets[index]! * 60_000).toISOString();
      return { ...observation, observedAt: at, recordedAt: at };
    });
    const out = layer2Trend(buildSeries(ferritin), [], DEFAULT_CONFIG, NOW);
    expect(out.reasons.map((r) => r.code)).not.toContain('FERRITIN_RISE');
  });

  it.each([
    ['血小板', [200, 140], [100, 130, 180]],
    ['铁蛋白', [200, 180, 140], [100, 180]],
    ['两项', [200, 140], [100, 180]],
  ] as const)('%s仅有两点时，不能绕过最小样本量规则形成相应趋势或协同', (name, platelets, ferritin) => {
    const out = trend([...platelets], [...ferritin]);
    expect(out.reasons.map((r) => r.code)).not.toContain('COMBO_PLT_FER');
    if (name === '血小板' || name === '两项') {
      expect(out.reasons.map((r) => r.code)).not.toContain('PLATELET_DROP');
      expect(out.signals.filter((s) => s.code === 'PLATELET')).toEqual([]);
    }
    if (name === '铁蛋白' || name === '两项') {
      expect(out.reasons.map((r) => r.code)).not.toContain('FERRITIN_RISE');
      expect(out.signals.filter((s) => s.code === 'FERRITIN')).toEqual([]);
    }
  });

  it('陈旧的两组化验仍显示陈旧提示，但不产生趋势告警', () => {
    const out = trend([200, 180, 140], [100, 130, 180], 31);
    expect(out.staleNotes).toHaveLength(2);
    expect(out.signals).toEqual([]);
    expect(out.reasons).toEqual([]);
    expect(out.trendOverridesScore).toBe(false);
  });

  it('AST 下降属于改善方向，不应触发趋势覆盖评分提示', () => {
    const observations = [100, 80, 50].map((valueNumeric, index) => {
      const observedAt = new Date(Date.parse(NOW) - (2 - index) * 6 * 3_600_000).toISOString();
      return {
        id: `AST-${index}`, patientId: 'pat-zhang', code: 'AST' as const, display: 'AST', valueNumeric,
        unit: 'U/L', observedAt, recordedAt: observedAt, source: 'LAB' as const, recordedBy: 'clinician-test',
      };
    });
    const out = layer2Trend(buildSeries(observations), [], DEFAULT_CONFIG, NOW);
    expect(out.signals.some((signal) => signal.code === 'AST' && signal.severity === 3 && signal.direction === 'DOWN')).toBe(true);
    expect(out.trendOverridesScore).toBe(false);
  });

  it('只排除陈旧指标，不影响另一指标的有效趋势', () => {
    const out = layer2Trend(buildSeries([
      ...points('PLATELET', [200, 180, 140], 31),
      ...points('FERRITIN', [100, 130, 180]),
    ]), [], DEFAULT_CONFIG, NOW);
    expect(out.reasons.map((r) => r.code)).toContain('FERRITIN_RISE');
    expect(out.reasons.map((r) => r.code)).not.toContain('PLATELET_DROP');
    expect(out.reasons.map((r) => r.code)).not.toContain('COMBO_PLT_FER');
  });

  it('提高 minPointsForTrend 后，窗口触发项也服从该配置', () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.trend.minPointsForTrend = 4;
    const out = layer2Trend(buildSeries([...points('PLATELET', [200, 180, 140]), ...points('FERRITIN', [100, 130, 180])]), [], cfg, NOW);
    expect(out.signals).toEqual([]);
    expect(out.reasons).toEqual([]);
  });
});
