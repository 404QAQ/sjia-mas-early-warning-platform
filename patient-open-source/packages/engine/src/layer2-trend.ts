/**
 * L2 趋势层 —— 引擎的真正价值所在（docs/02 §4）。
 *
 * 四个维度同时计算：
 *   环比变化（识别单点跳变）/ 相对基线偏离（对「这个孩子」而言是否异常）
 *   / 趋势斜率（持续恶化而非单次波动）/ 变化速度（恶化得快不快 —— 最紧急的信号）
 *
 * 异常点必须自动标注语义，而不是只画个点让医生自己心算（docs/02 §4.2）。
 */
import type { AlertReason, Code, ThresholdConfig, TrendSignal } from '@mas/domain';
import { CODE_TABLE } from '@mas/domain';
import { effectiveBaselineValue } from './baseline.js';
import { latest, seriesOf, windowPoints, type SeriesBundle } from './series.js';
import { consecutiveDirection, hoursBetween, pctChange, round, slope, toMs } from './time.js';

export interface TrendLayerResult {
  signals: TrendSignal[];
  /** 直接可上告警的触发项（由趋势信号升级而来） */
  reasons: AlertReason[];
  /** 趋势层与 L3 是否冲突（docs/02 §5.3：冲突时以趋势层为准） */
  trendOverridesScore: boolean;
  /** 数据陈旧提示 */
  staleNotes: string[];
  /** 关键趋势文案（用于详情页与告警「为什么」） */
  highlights: string[];
}

const TREND_CODES: Code[] = ['PLATELET', 'FERRITIN', 'AST', 'TRIGLYCERIDE', 'FIBRINOGEN', 'LDH', 'CRP'];
const WORSENING_DIRECTIONS: Partial<Record<Code, TrendSignal['direction']>> = {
  PLATELET: 'DOWN',
  FERRITIN: 'UP',
  AST: 'UP',
  TRIGLYCERIDE: 'UP',
  FIBRINOGEN: 'DOWN',
  LDH: 'UP',
  CRP: 'UP',
};

export function layer2Trend(series: SeriesBundle, baselineList: Parameters<typeof effectiveBaselineValue>[0], cfg: ThresholdConfig, now: string): TrendLayerResult {
  const nowMs = toMs(now);
  const signals: TrendSignal[] = [];
  const reasons: AlertReason[] = [];
  const staleNotes: string[] = [];
  const highlights: string[] = [];
  const eligibleCodes = new Set<Code>();

  for (const code of TREND_CODES) {
    const s = seriesOf(series, code);
    const last = latest(s);
    if (!s || !last) continue;

    // 数据陈旧：趋势层降权，界面标注
    const ageDays = (nowMs - last.atMs) / 86_400_000;
    if (ageDays > cfg.trend.staleDataDays) {
      staleNotes.push(`${CODE_TABLE[code].display} 最近一次检测为 ${Math.floor(ageDays)} 天前，数据陈旧`);
      continue;
    }

    const pts = s.points;
    if (pts.length < cfg.trend.minPointsForTrend) {
      // 数据点过少：不做趋势判断，只做绝对值规则（docs/02 §7）
      continue;
    }
    eligibleCodes.add(code);

    // ---- 维度 1：环比变化 ----
    const prev = pts[pts.length - 2]!;
    const deltaPct = pctChange(prev.value, last.value);
    if (deltaPct !== null && Math.abs(deltaPct) >= 0.15) {
      const dir: TrendSignal['direction'] = deltaPct > 0 ? 'UP' : 'DOWN';
      const semantic = `${round(Math.abs(hoursBetween(last.atMs, prev.atMs)), 0)}h 内 ${dir === 'UP' ? '↑' : '↓'}${Math.abs(Math.round(deltaPct * 100))}%`;
      signals.push({
        code,
        kind: 'DELTA_PCT',
        value: round(deltaPct, 4),
        windowHours: hoursBetween(last.atMs, prev.atMs),
        semanticLabel: semantic,
        severity: Math.abs(deltaPct) >= 0.3 ? 3 : 2,
        direction: dir,
        fromValue: prev.value,
        toValue: last.value,
      });
    }

    // ---- 维度 2：相对基线偏离 ----
    const base = effectiveBaselineValue(baselineList, code);
    if (base !== null && base !== 0) {
      const dev = (last.value - base) / base;
      if (Math.abs(dev) >= cfg.trend.baselineDeviationFactor - 1) {
        const label =
          dev > 0
            ? `高于该患儿基线 ${Math.round(dev * 100)}%（基线 ${round(base, 0)}）`
            : `低于该患儿基线 ${Math.abs(Math.round(dev * 100))}%（基线 ${round(base, 0)}）`;
        signals.push({
          code,
          kind: 'BASELINE_DEVIATION',
          value: round(dev, 4),
          semanticLabel: label,
          severity: Math.abs(dev) >= 1 ? 3 : 2,
          direction: dev > 0 ? 'UP' : 'DOWN',
          fromValue: base,
          toValue: last.value,
        });
      }
    }

    // ---- 维度 3：趋势斜率（近 7 天线性回归） ----
    const week = windowPoints(s, nowMs, 168);
    if (week.length >= cfg.trend.minPointsForTrend) {
      const sl = slope(week.map((p) => ({ x: (p.atMs - week[0]!.atMs) / 3_600_000, y: p.value })));
      if (sl !== null && sl !== 0) {
        const positive = sl > 0;
        signals.push({
          code,
          kind: 'SLOPE',
          value: round(sl, 4),
          windowHours: 168,
          semanticLabel: `近 7 天${positive ? '持续上升' : '持续下降'}（斜率 ${round(sl, 2)}/h）`,
          severity: 1,
          direction: positive ? 'UP' : 'DOWN',
        });
      }
    }

    // ---- 维度 4：变化速度（最紧急的信号） ----
    const rateWindow = windowPoints(s, nowMs, 48);
    if (rateWindow.length >= 2) {
      const first = rateWindow[0]!;
      const d = pctChange(first.value, last.value);
      if (d !== null) {
        const hours = Math.max(hoursBetween(last.atMs, first.atMs), 1);
        const perHour = d / hours;
        // 与既往最大同向变化速度比较
        const historical = historicalMaxRate(s.points, first.atMs);
        if (historical !== null && Math.abs(perHour) > Math.abs(historical) * cfg.trend.rateOfChangeAnomalyFactor && Math.abs(d) >= 0.15) {
          signals.push({
            code,
            kind: 'RATE_OF_CHANGE',
            value: round(perHour, 6),
            windowHours: round(hours, 1),
            semanticLabel: `${d < 0 ? '下降' : '上升'}速度超过既往任何一次`,
            severity: 3,
            direction: d < 0 ? 'DOWN' : 'UP',
            fromValue: first.value,
            toValue: last.value,
          });
        }
      }
    }

    // ---- 连续同向计数（由症状区统一处理主指标，这里仅对血小板/铁蛋白做「为什么」文案） ----
    if (code === 'PLATELET' || code === 'FERRITIN') {
      const dir = code === 'PLATELET' ? 'DOWN' : 'UP';
      const n = consecutiveDirection(pts, dir);
      if (n >= cfg.trend.consecutiveDeclineCount) {
        signals.push({
          code,
          kind: 'CONSECUTIVE_DECLINE',
          value: n,
          semanticLabel: `连续 ${n} 次${dir === 'DOWN' ? '下降' : '上升'}`,
          severity: 2,
          direction: dir,
        });
      }
    }
  }

  // ---- 趋势信号 → 告警触发项 ----
  // 注意：临床关心的是「48h 窗口内的变化」，不是「最近两点之间的变化」。
  // 若家长一天内测了两次，最近两点可能只差几个小时，会漏掉真正的时间窗。
  // 因此这里显式用窗口内最早一点作为基线（与 design/03 示例「血小板 48h 内 210→152」一致）。
  const platelet48 = eligibleCodes.has('PLATELET') ? windowTrend(seriesOf(series, 'PLATELET'), 48) : null;
  if (platelet48 && platelet48.value <= -cfg.trend.plateletDrop48hWarning) {
    const consecutive = signals.find((s) => s.code === 'PLATELET' && s.kind === 'CONSECUTIVE_DECLINE');
    reasons.push({
      code: 'PLATELET_DROP',
      label: '血小板下降',
      detail: `血小板 ${Math.round(platelet48.windowHours)}h 内 ${round(platelet48.fromValue, 0)}→${round(platelet48.toValue, 0)}（↓${Math.abs(Math.round(platelet48.value * 100))}%）${consecutive ? `，${consecutive.semanticLabel}` : ''}`,
      actual: round(platelet48.toValue, 0),
      threshold: `↓${Math.round(cfg.trend.plateletDrop48hWarning * 100)}%`,
      unit: '10^9/L',
      source: 'CONSENSUS_2016_DYNAMIC',
      severity: Math.abs(platelet48.value) >= cfg.trend.plateletDrop48hCritical ? 3 : 2,
      actionability: 1,
    });
    highlights.push(`血小板 ${Math.round(platelet48.windowHours)}h 内 ↓${Math.abs(Math.round(platelet48.value * 100))}%`);
  }

  const ferritinWindow = eligibleCodes.has('FERRITIN') ? windowTrend(seriesOf(series, 'FERRITIN'), 24) : null;
  const ferritinRise =
    ferritinWindow && ferritinWindow.value >= cfg.trend.ferritinRise24hWarning
      ? ferritinWindow
      : signals
          .filter((s) => s.code === 'FERRITIN' && s.kind === 'DELTA_PCT' && s.direction === 'UP' && (s.windowHours ?? 0) > 0 && s.windowHours! <= 24)
          .sort((a, b) => (b.windowHours ?? 0) - (a.windowHours ?? 0))[0];
  if (ferritinRise && ferritinRise.value >= cfg.trend.ferritinRise24hWarning) {
    reasons.push({
      code: 'FERRITIN_RISE',
      label: '铁蛋白急剧升高',
      detail: `铁蛋白 ${Math.round(ferritinRise.windowHours ?? 0)}h 内 ${round(ferritinRise.fromValue ?? 0, 0)}→${round(ferritinRise.toValue ?? 0, 0)}（↑${Math.round(ferritinRise.value * 100)}%）`,
      actual: round(ferritinRise.toValue ?? 0, 0),
      threshold: `↑${Math.round(cfg.trend.ferritinRise24hWarning * 100)}%`,
      unit: 'ng/mL',
      source: 'CONSENSUS_2016_DYNAMIC',
      severity: ferritinRise.value >= 1.0 ? 3 : 2,
      actionability: 1,
    });
    highlights.push(`铁蛋白 ${Math.round(ferritinRise.windowHours ?? 0)}h 内 ↑${Math.round(ferritinRise.value * 100)}%`);
  }

  // 多指标协同（docs/02 §4.3）：仅铁蛋白↑而其余平稳 → 明确提示可能的干扰因素
  const hasPlateletDrop = reasons.some((reason) => reason.code === 'PLATELET_DROP');
  const hasFerritinRise = reasons.some((reason) => reason.code === 'FERRITIN_RISE');
  const hasAstRise = signals.some((s) => s.code === 'AST' && s.severity >= 2 && s.direction === 'UP');
  const hasTgRise = signals.some((s) => s.code === 'TRIGLYCERIDE' && s.severity >= 2 && s.direction === 'UP');
  if (hasFerritinRise && !hasPlateletDrop && !hasAstRise && !hasTgRise) {
    reasons.push({
      code: 'INTERFERENCE_HINT',
      label: '可能的干扰因素',
      detail: '仅铁蛋白升高而其余指标平稳，常见于感染或肝损伤干扰，不一定指向 MAS',
      source: 'CONSENSUS_2016_DYNAMIC',
      severity: 1,
      actionability: 0,
    });
  }
  if (hasPlateletDrop && hasFerritinRise) {
    reasons.push({
      code: 'COMBO_PLT_FER',
      label: '多指标协同',
      detail: '血小板下降 且 铁蛋白升高 —— MAS 最典型的早期组合',
      source: 'CONSENSUS_2016_DYNAMIC',
      severity: 3,
      actionability: 1,
    });
  }

  const trendOverridesScore = signals.some((s) => s.severity === 3 && WORSENING_DIRECTIONS[s.code] === s.direction);
  return { signals, reasons, trendOverridesScore, staleNotes, highlights };
}

/** 既往最大同向变化速度（%/h），排除当前窗口 */
function historicalMaxRate(points: Array<{ atMs: number; value: number }>, excludeBeforeMs: number): number | null {
  let max: number | null = null;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (b.atMs > excludeBeforeMs) break;
    const d = pctChange(a.value, b.value);
    if (d === null) continue;
    const hours = Math.max((b.atMs - a.atMs) / 3_600_000, 1);
    const perHour = Math.abs(d / hours);
    if (max === null || perHour > max) max = perHour;
  }
  return max;
}

/**
 * 窗口内的整体变化（最早一点 → 最新一点）。
 * 与「最近两点变化」的区别：这是临床真正关心的口径（「48h 内 210→152」）。
 */
export function windowTrend(
  series: import('./series.js').CodeSeries | undefined,
  hours: number,
): { fromValue: number; toValue: number; value: number; windowHours: number } | null {
  if (!series || series.points.length < 2) return null;
  const last = series.points[series.points.length - 1]!;
  const from = last.atMs - hours * 3_600_000;
  const inWindow = series.points.filter((p) => p.atMs >= from);
  if (inWindow.length < 2) return null;
  const first = inWindow[0]!;
  if (first.atMs >= last.atMs) return null;
  const change = pctChange(first.value, last.value);
  if (change === null) return null;
  return {
    fromValue: first.value,
    toValue: last.value,
    value: change,
    windowHours: (last.atMs - first.atMs) / 3_600_000,
  };
}
