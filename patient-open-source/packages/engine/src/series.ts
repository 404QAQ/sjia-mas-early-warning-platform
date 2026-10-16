/**
 * 观测值 → 按指标的时间序列（已换算到标准单位）。
 * 换算集中在这一层：规则层拿到的永远是「已换算 + 带单位标记」的值（tech/01 §3.1）。
 * 单位缺失/未知的观测值不参与判读，并作为数据质量问题单独上报 —— 不静默按原值计算。
 */
import { CODE_TABLE, toCanonical, type Code, type Observation, type SymptomCode } from '@mas/domain';
import { toMs } from './time.js';

export interface SeriesPoint {
  at: string;
  atMs: number;
  value: number;
  unit: string;
  source: Observation['source'];
  recordedBy: string;
  confidence: Observation['confidence'];
}

export interface CodeSeries {
  code: Code;
  unit: string;
  points: SeriesPoint[]; // 按时间升序
  /** 换算失败的观测值（单位缺失/未知），需要提示数据质量问题 */
  rejected: Array<{ id: string; observedAt: string; unit: string; reason: string }>;
}

export interface SymptomEvent {
  code: SymptomCode;
  at: string;
  atMs: number;
  recordedBy: string;
}

export interface SeriesBundle {
  byCode: Map<Code, CodeSeries>;
  symptoms: SymptomEvent[];
  /** 所有观测值里最新的 observedAt（用于「最后活跃时间」的辅助判断） */
  latestObservedAt?: string;
  rejectedTotal: number;
}

export function buildSeries(observations: Observation[]): SeriesBundle {
  const byCode = new Map<Code, CodeSeries>();
  const symptoms: SymptomEvent[] = [];
  let latestObservedAt: string | undefined;
  let rejectedTotal = 0;

  const eligible = observations
    .filter((o) => !(o.tags ?? []).some((tag) => tag === 'NO_ALERT' || tag === 'OCR_UNVERIFIED'))
    .map((o) => ({ observation: o, atMs: toMs(o.observedAt), recordedMs: toMs(o.recordedAt) }))
    .sort((a, b) => a.atMs - b.atMs || a.recordedMs - b.recordedMs || (a.observation.id < b.observation.id ? -1 : a.observation.id > b.observation.id ? 1 : 0));

  for (const { observation: o, atMs } of eligible) {

    if (o.valueCoded) {
      symptoms.push({ code: o.valueCoded as SymptomCode, at: o.observedAt, atMs, recordedBy: o.recordedBy });
      latestObservedAt = o.observedAt;
      continue;
    }
    if (o.valueNumeric === undefined || o.valueNumeric === null) continue;
    if (!(o.code in CODE_TABLE)) continue;

    const existing: CodeSeries =
      byCode.get(o.code) ?? { code: o.code, unit: CODE_TABLE[o.code].canonicalUnit, points: [], rejected: [] };
    try {
      if (!Number.isFinite(o.valueNumeric)) throw new Error('观测值必须为有限数值');
      const c = toCanonical(o.valueNumeric, o.unit, o.code);
      existing.points.push({
        at: o.observedAt,
        atMs,
        value: c.value,
        unit: c.unit,
        source: o.source,
        recordedBy: o.recordedBy,
        confidence: o.confidence,
      });
      latestObservedAt = o.observedAt;
    } catch (e) {
      rejectedTotal += 1;
      existing.rejected.push({
        id: o.id,
        observedAt: o.observedAt,
        unit: o.unit,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
    byCode.set(o.code, existing);
  }

  for (const s of byCode.values()) {
    s.points.sort((a, b) => a.atMs - b.atMs);
  }
  symptoms.sort((a, b) => a.atMs - b.atMs);
  return { byCode, symptoms, latestObservedAt, rejectedTotal };
}

/** 取窗口内的点（含边界），按时间升序 */
export function windowPoints(series: CodeSeries | undefined, nowMs: number, hours: number): SeriesPoint[] {
  if (!series) return [];
  const from = nowMs - hours * 3_600_000;
  return series.points.filter((p) => p.atMs >= from && p.atMs <= nowMs);
}

/** 最新一点（可以是窗口内的最新） */
export function latest(series: CodeSeries | undefined): SeriesPoint | null {
  if (!series || series.points.length === 0) return null;
  return series.points[series.points.length - 1]!;
}

/** 距离 now 最近的一次症状事件（多编码时取最先找到的） */
export function recentSymptom(
  symptoms: SymptomEvent[],
  codes: SymptomCode[],
  nowMs: number,
  withinHours: number,
): SymptomEvent | null {
  const from = nowMs - withinHours * 3_600_000;
  const hit = symptoms.filter((s) => codes.includes(s.code) && s.atMs >= from && s.atMs <= nowMs);
  if (hit.length === 0) return null;
  return hit[hit.length - 1]!;
}

/** 某症状在窗口内的出现次数 */
export function symptomCount(symptoms: SymptomEvent[], code: SymptomCode, nowMs: number, withinHours: number): number {
  const from = nowMs - withinHours * 3_600_000;
  return symptoms.filter((s) => s.code === code && s.atMs >= from && s.atMs <= nowMs).length;
}

/** 数据是否陈旧（>staleDataDays 未更新） */
export function isStale(series: CodeSeries | undefined, nowMs: number, staleDays: number): boolean {
  const last = latest(series);
  if (!last) return true;
  return nowMs - last.atMs > staleDays * 24 * 3_600_000;
}

/** 派生：连续若干天的每日最高体温（用于发热峰值上升判断） */
export function dailyMaxTemp(
  series: CodeSeries | undefined,
  nowMs: number,
  days: number,
): Array<{ date: string; value: number }> {
  const points = windowPoints(series, nowMs, days * 24);
  const byDate = new Map<string, number>();
  for (const p of points) {
    const key = businessDate.format(new Date(p.atMs));
    const cur = byDate.get(key);
    if (cur === undefined || p.value > cur) byDate.set(key, p.value);
  }
  return [...byDate.entries()]
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// 一期单中心业务日按上海时区划分，与部署服务器的 TZ 无关。
const businessDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});

/** 取某指标的序列（未测过则返回 undefined —— 调用方必须显式处理「未测」，不得默认 0） */
export function seriesOf(bundle: SeriesBundle, code: Code): CodeSeries | undefined {
  return bundle.byCode.get(code);
}
