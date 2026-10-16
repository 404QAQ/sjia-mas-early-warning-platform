/**
 * 个性化基线。docs/02 §4.1 + tech/01 §5.2。
 *
 * 计算逻辑：
 *   1. 从 stability_periods 取稳定期内的观测值（稳定期来源：医生标注，或系统推测「无告警 + 用药未变」）
 *   2. 取中位数（不用均值，避免单次异常拉偏）
 *   3. 样本量 ≥ 3 才生成基线，否则不生成
 *   4. clinician_note 优先级最高：医生手写的话覆盖系统计算值
 */
import { CODE_TABLE, toCanonical, type Code, type Observation, type PersonalBaseline, type StabilityPeriod } from '@mas/domain';
import { median, toMs } from './time.js';

export interface ComputedBaseline {
  code: Code;
  value: number;
  unit: string;
  sampleCount: number;
  period: StabilityPeriod;
}

/** 为每个指标计算候选基线（不含医生手写覆盖） */
export function computeBaselines(
  observations: Observation[],
  stabilityPeriods: StabilityPeriod[],
  minPoints = 3,
): ComputedBaseline[] {
  if (!Number.isInteger(minPoints) || minPoints < 3) throw new RangeError('基线至少需要 3 个有效样本');
  const periods = stabilityPeriods.map((period) => {
    const from = toMs(period.from);
    const to = toMs(period.to);
    if (from > to) throw new RangeError('稳定期开始时间不能晚于结束时间');
    return { period, from, to };
  });
  const byCode = new Map<Code, Observation[]>();
  for (const o of observations) {
    if (o.valueNumeric === undefined || o.valueNumeric === null) continue;
    if ((o.tags ?? []).some((tag) => tag === 'NO_ALERT' || tag === 'OCR_UNVERIFIED')) continue;
    const arr = byCode.get(o.code) ?? [];
    arr.push(o);
    byCode.set(o.code, arr);
  }

  const out: ComputedBaseline[] = [];
  for (const [code, list] of byCode) {
    for (const { period, from, to } of periods) {
      const inWindow = list.filter((o) => {
        const t = toMs(o.observedAt);
        return t >= from && t <= to;
      });
      if (inWindow.length < minPoints) continue;
      let values: number[];
      try {
        values = inWindow.map((o) => toCanonical(o.valueNumeric!, o.unit, o.code).value);
      } catch {
        // 单位缺失或未知：跳过该窗口，不静默按原值计算
        continue;
      }
      const med = median(values);
      if (med === null) continue;
      out.push({ code, value: med, unit: CODE_TABLE[code].canonicalUnit, sampleCount: values.length, period });
    }
  }
  return out;
}

/** 引擎取基线时：CLINICIAN 优先于 COMPUTED（docs/02 §4.1「医生手写的话比任何算法都准」） */
export function effectiveBaselineValue(baselines: PersonalBaseline[], code: Code): number | null {
  const forCode = baselines.filter((b) => b.code === code);
  if (forCode.length === 0) return null;
  const clinician = forCode.filter((b) => b.source === 'CLINICIAN');
  if (clinician.length > 0) {
    const latest = clinician.sort((a, b) => toMs(b.updatedAt) - toMs(a.updatedAt))[0]!;
    return toCanonical(latest.baselineValue, latest.unit, latest.code).value;
  }
  const latestComputed = forCode.sort((a, b) => toMs(b.updatedAt) - toMs(a.updatedAt))[0]!;
  return toCanonical(latestComputed.baselineValue, latestComputed.unit, latestComputed.code).value;
}

/**
 * 从医生手写备注里解析显式阈值【工程初稿·需临床复核】。
 * 例：「如果铁蛋白超过 3000 或血小板跌破 170，那就是不对劲了。」
 * 解析不出就返回空数组 —— 只作文本展示，不猜。
 */
export function parseClinicianThresholds(note: string | undefined): NonNullable<PersonalBaseline['clinicianThresholds']> {
  if (!note) return [];
  const out: NonNullable<PersonalBaseline['clinicianThresholds']> = [];
  const patterns: Array<{ code: Code; above: RegExp; below: RegExp; unit: string }> = [
    {
      code: 'FERRITIN',
      above: /铁蛋白[^。；;]{0,12}?(?:超过|高于|大于|>)\s*(\d+(?:\.\d+)?)/g,
      below: /铁蛋白[^。；;]{0,12}?(?:低于|小于|跌破|<)\s*(\d+(?:\.\d+)?)/g,
      unit: 'ng/mL',
    },
    {
      code: 'PLATELET',
      above: /血小板[^。；;]{0,12}?(?:超过|高于|大于|>)\s*(\d+(?:\.\d+)?)/g,
      below: /血小板[^。；;]{0,12}?(?:低于|小于|跌破|<)\s*(\d+(?:\.\d+)?)/g,
      unit: '10^9/L',
    },
  ];
  for (const p of patterns) {
    for (const m of note.matchAll(p.above)) {
      out.push({ code: p.code, above: Number(m[1]), unit: p.unit, rawText: m[0] });
    }
    for (const m of note.matchAll(p.below)) {
      out.push({ code: p.code, below: Number(m[1]), unit: p.unit, rawText: m[0] });
    }
  }
  return out;
}
