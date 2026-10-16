/** 时间序列工具。不引入科学计算库：线性回归就是两行公式（tech/01 §5.1）。 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export class InvalidTimeError extends Error {
  constructor(value: string | number) {
    super(`无效时间值：${String(value)}`);
    this.name = 'InvalidTimeError';
  }
}

export function hoursBetween(a: string | number, b: string | number): number {
  return (toMs(a) - toMs(b)) / HOUR_MS;
}

export function toMs(t: string | number): number {
  if (typeof t === 'string') {
    // 只接受带时区的 ISO 时间；Date.parse 单独使用会接受无时区和 2 月 30 日等输入。
    const iso = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(t);
    if (!iso) throw new InvalidTimeError(t);
    const dayMs = Date.parse(`${iso[1]}T00:00:00Z`);
    if (!Number.isFinite(dayMs) || new Date(dayMs).toISOString().slice(0, 10) !== iso[1]) throw new InvalidTimeError(t);
  }
  const ms = typeof t === 'number' ? t : Date.parse(t);
  if (!Number.isFinite(ms) || !Number.isFinite(new Date(ms).getTime())) throw new InvalidTimeError(t);
  return ms;
}

export function isoAddHours(iso: string, hours: number): string {
  return new Date(toMs(iso) + hours * HOUR_MS).toISOString();
}

/** 截断到小时，用于「48h 内」这类窗口边界 */
export function hoursFloor(ms: number, hours: number): number {
  return Math.floor(ms / (hours * HOUR_MS)) * hours * HOUR_MS;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * 简单线性回归斜率（y 对 x）。x 单位为小时。
 * 点不足或 x 无方差时返回 null —— 不猜。
 */
export function slope(points: Array<{ x: number; y: number }>): number | null {
  if (points.length < 2) return null;
  const n = points.length;
  const meanX = points.reduce((s, p) => s + p.x, 0) / n;
  const meanY = points.reduce((s, p) => s + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - meanX) * (p.y - meanY);
    den += (p.x - meanX) ** 2;
  }
  if (den === 0) return null;
  return num / den;
}

/** 百分比变化：(to - from) / from。from 为 0 时返回 null，不产生 Infinity。 */
export function pctChange(from: number, to: number): number | null {
  if (from === 0) return null;
  return (to - from) / from;
}

export function round(n: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** 连续同向计数（从最新往回数）。用于「连续 4 次下降」 */
export function consecutiveDirection(
  series: Array<{ at: string; value: number }>,
  direction: 'UP' | 'DOWN',
): number {
  let count = 0;
  for (let i = series.length - 1; i > 0; i -= 1) {
    const cur = series[i]!.value;
    const prev = series[i - 1]!.value;
    const isDown = cur < prev;
    const isUp = cur > prev;
    if ((direction === 'DOWN' && isDown) || (direction === 'UP' && isUp)) count += 1;
    else break;
  }
  return count;
}
