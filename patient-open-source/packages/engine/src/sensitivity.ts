/**
 * 敏感度分析（推演）—— docs/02 §9 第 3 个问题：「如果我把某一项改一下会怎样？」
 *
 * 例：「若血小板维持在当前水平 48h，风险等级将降为中」
 * 这是引擎纯函数的直接红利：复制输入 → 覆写一项 → 重跑 evaluate。
 * **只读，不落库**，也不产生告警。
 */
import { toCanonical, type Code, type EngineInput, type EngineOutput, type Observation } from '@mas/domain';
import { evaluate, inputSnapshot } from './index.js';
import { toMs } from './time.js';

export interface SimulateOverrides {
  /** 把某指标的最新值改成指定值（单位 = 该指标标准单位） */
  setValue?: { code: Code; value: number; unit: string };
  /** 把某指标最近一次值按百分比变化（如血小板 -0.3 表示再降 30%） */
  adjustPct?: { code: Code; pct: number };
  /** 追加一段时间（无新记录），用于「停止记录」推演 */
  advanceHours?: number;
}

export interface SensitivityResult {
  base: EngineOutput;
  simulated: EngineOutput;
  /** 人类可读结论，如「若血小板维持在当前水平 48h，风险等级将降为中」 */
  narrative: string;
  changed: {
    riskLevel: boolean;
    actionLevel: boolean;
    suggestionsAdded: string[];
    suggestionsRemoved: string[];
  };
}

export function sensitivity(rawInput: EngineInput, overrides: SimulateOverrides): SensitivityResult {
  // 固定原始时刻的已知数据；前进时间不意味着获得未来的新记录。
  const input = inputSnapshot(rawInput);
  if (overrides.advanceHours !== undefined && (!Number.isFinite(overrides.advanceHours) || overrides.advanceHours < 0)) throw new RangeError('推演前进小时数必须为有限非负数');
  if (overrides.adjustPct && (!Number.isFinite(overrides.adjustPct.pct) || overrides.adjustPct.pct < -1)) throw new RangeError('变化比例必须为有限数且不能低于 -100%');
  if (overrides.setValue) toCanonical(overrides.setValue.value, overrides.setValue.unit, overrides.setValue.code);
  const base = evaluate(input);
  const now = overrides.advanceHours ? new Date(toMs(input.now) + overrides.advanceHours * 3_600_000).toISOString() : input.now;

  let observations: Observation[] = input.observations.map((o) => ({ ...o, tags: [...(o.tags ?? [])] }));

  if (overrides.setValue) {
    observations = applyLatest(observations, input.now, overrides.setValue.code, () => overrides.setValue!.value, overrides.setValue.unit);
  }
  if (overrides.adjustPct) {
    observations = applyLatest(
      observations,
      input.now,
      overrides.adjustPct.code,
      (v) => Math.round(v * (1 + overrides.adjustPct!.pct) * 100) / 100,
    );
  }

  const simulated = evaluate({
    ...input,
    observations,
    now,
  });

  const added = simulated.suggestions.filter((s) => !base.suggestions.includes(s));
  const removed = base.suggestions.filter((s) => !simulated.suggestions.includes(s));

  return {
    base,
    simulated,
    narrative: buildNarrative(base, simulated, overrides),
    changed: {
      riskLevel: base.riskLevel !== simulated.riskLevel,
      actionLevel: base.actionLevel !== simulated.actionLevel,
      suggestionsAdded: added,
      suggestionsRemoved: removed,
    },
  };
}

function applyLatest(
  observations: Observation[],
  now: string,
  code: Code,
  transform: (v: number) => number,
  unit?: string,
): Observation[] {
  const idxs = observations
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => o.code === code && o.valueNumeric !== undefined && o.valueNumeric !== null &&
      !(o.tags ?? []).some((tag) => tag === 'NO_ALERT' || tag === 'OCR_UNVERIFIED') &&
      toMs(o.observedAt) <= toMs(now) && toMs(o.recordedAt) <= toMs(now))
    .sort((a, b) => toMs(b.o.observedAt) - toMs(a.o.observedAt) || toMs(b.o.recordedAt) - toMs(a.o.recordedAt) || (a.o.id < b.o.id ? 1 : a.o.id > b.o.id ? -1 : 0));
  const target = idxs[0];
  if (!target) throw new RangeError(`没有可用于推演的 ${code} 临床记录`);
  const out = [...observations];
  out[target.i] = {
    ...target.o,
    valueNumeric: transform(target.o.valueNumeric!),
    unit: unit ?? target.o.unit,
  };
  return out;
}

const RISK_CN: Record<string, string> = { LOW: '低', MEDIUM: '中', HIGH: '高', CRITICAL: '极危' };
const ACTION_CN: Record<string, string> = { OBSERVE: '观察', REVIEW: '复评', ACT_NOW: '立即行动' };

function buildNarrative(base: EngineOutput, sim: EngineOutput, overrides: SimulateOverrides): string {
  const parts: string[] = [];
  if (overrides.setValue) {
    parts.push(`若 ${overrides.setValue.code} 变为 ${overrides.setValue.value}，`);
  } else if (overrides.adjustPct) {
    const pct = Math.round(overrides.adjustPct.pct * 100);
    parts.push(`若 ${overrides.adjustPct.code} 在此水平${pct >= 0 ? '再升' : '再降'} ${Math.abs(pct)}%，`);
  } else if (overrides.advanceHours) {
    parts.push(`若维持当前状态 ${overrides.advanceHours} 小时，`);
  }
  if (base.riskLevel === sim.riskLevel && base.actionLevel === sim.actionLevel) {
    parts.push(`风险等级仍为「${RISK_CN[sim.riskLevel]}」，行动分级仍为「${ACTION_CN[sim.actionLevel]}」。`);
  } else {
    parts.push(`风险等级将由「${RISK_CN[base.riskLevel]}」变为「${RISK_CN[sim.riskLevel]}」，行动分级由「${ACTION_CN[base.actionLevel]}」变为「${ACTION_CN[sim.actionLevel]}」。`);
  }
  if (sim.actionLevel === 'OBSERVE' && base.actionLevel !== 'OBSERVE' && sim.suggestions.length === 0) {
    parts.push('不再需要立即行动。');
  }
  return parts.join('');
}
