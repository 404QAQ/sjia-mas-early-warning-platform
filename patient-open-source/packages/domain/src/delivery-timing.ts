import { parseCareInstant } from './care-routing.js';

export interface DeliveryWindow { start: string; end: string }
export interface DeliveryTimingPolicy {
  orgUnitId: string;
  version: number;
  timeZone: string;
  weeklyWindows: Record<string, DeliveryWindow[]>;
  dateOverrides: Array<{ date: string; kind: 'WORKDAY' | 'HOLIDAY'; windows: DeliveryWindow[] }>;
  batchMinutes: number;
  approval: 'ENGINEERING_DRAFT' | 'HOSPITAL_APPROVED';
  effectiveFrom: string;
  effectiveUntil?: string;
}
export interface DeliveryTimingDecision {
  mode: 'IMMEDIATE' | 'DEFERRED' | 'BATCH';
  reason: string;
  policyVersion: number | null;
  eligibleAt: string | null;
  /** 工作窗口结束，或尚未受 SLA/开工时间截断的批次边界。 */
  windowEnd: string | null;
}

const MINUTE = 60_000;
const DAY = 86_400_000;
type Interval = { start: number; end: number };
type OffsetSegment = { start: number; end: number; offset: number };

/** 同时作为 API 的运行时边界；未知字段不可无声丢弃。 */
export function validateDeliveryTimingPolicy(policy: DeliveryTimingPolicy): void {
  record(policy, ['orgUnitId', 'version', 'timeZone', 'weeklyWindows', 'dateOverrides', 'batchMinutes', 'approval', 'effectiveFrom', 'effectiveUntil'], '通知时段策略');
  if (typeof policy.orgUnitId !== 'string' || !policy.orgUnitId.trim() || policy.orgUnitId.length > 200) invalid('科室标识');
  if (!Number.isSafeInteger(policy.version) || policy.version < 1) invalid('策略版本');
  formatter(policy.timeZone);
  record(policy.weeklyWindows, ['1', '2', '3', '4', '5', '6', '7'], '工作日窗口');
  for (const windows of Object.values(policy.weeklyWindows)) validateWindows(windows);
  if (!Array.isArray(policy.dateOverrides) || policy.dateOverrides.length > 3660) invalid('日期覆盖（最多 3660 天）');
  const dates = new Set<string>();
  for (const override of policy.dateOverrides) {
    record(override, ['date', 'kind', 'windows'], '日期覆盖');
    dateEpoch(override.date);
    if (dates.has(override.date)) invalid('重复日期覆盖');
    dates.add(override.date);
    if (override.kind !== 'WORKDAY' && override.kind !== 'HOLIDAY') invalid('日期类型');
    validateWindows(override.windows);
  }
  if (!Number.isInteger(policy.batchMinutes) || policy.batchMinutes < 1 || policy.batchMinutes > 1440) invalid('批次分钟数（1–1440）');
  if (policy.approval !== 'ENGINEERING_DRAFT' && policy.approval !== 'HOSPITAL_APPROVED') invalid('复核状态');
  const from = parseCareInstant(policy.effectiveFrom);
  if (policy.effectiveUntil !== undefined && parseCareInstant(policy.effectiveUntil) <= from) invalid('生效结束时间');
}

/** 纯时段决策；不修改告警级别、责任代次或原有临床响应期限。 */
export function decideDeliveryTiming(
  policy: DeliveryTimingPolicy | undefined, level: 'L1' | 'L2' | 'L3' | 'CRISIS',
  queuedAt: string, now: string, respondBy?: string,
): DeliveryTimingDecision {
  const queued = parseCareInstant(queuedAt), at = parseCareInstant(now);
  const deadline = respondBy === undefined ? undefined : parseCareInstant(respondBy);
  if (!['L1', 'L2', 'L3', 'CRISIS'].includes(level)) invalid('告警级别');
  const immediate = (reason: string, end: number | null = null): DeliveryTimingDecision => ({
    mode: 'IMMEDIATE', reason, policyVersion: policy?.version ?? null, eligibleAt: iso(at), windowEnd: end === null ? null : iso(end),
  });
  if (policy === undefined) return immediate('NO_DELIVERY_POLICY');
  validateDeliveryTimingPolicy(policy);
  if (at < parseCareInstant(policy.effectiveFrom)) return immediate('POLICY_NOT_YET_EFFECTIVE');
  const until = policy.effectiveUntil === undefined ? Infinity : parseCareInstant(policy.effectiveUntil);
  if (at >= until) return immediate('POLICY_EXPIRED');
  if (level === 'L3' || level === 'CRISIS') return immediate('URGENT_BYPASS');
  const calendar = new WorkingCalendar(policy);
  const current = calendar.currentWindow(at);
  if (current) return immediate('WORKING_WINDOW', Math.min(current.end, until));
  if (level === 'L1') {
    const next = calendar.nextWindow(at);
    return {
      mode: 'DEFERRED', reason: next && next.start < until ? 'NON_WORKING_HOURS' : 'NO_FUTURE_WORKING_WINDOW', policyVersion: policy.version,
      eligibleAt: next && next.start < until ? iso(next.start) : null,
      windowEnd: next && next.start < until ? iso(Math.min(next.end, until)) : null,
    };
  }
  // queuedAt 是首入队时间，重复扫描不得让同一批次一直向后滑动。
  const boundary = calendar.nextBatch(queued, policy.batchMinutes);
  const nextWork = calendar.currentWindow(queued) ?? calendar.nextWindow(queued);
  const workStart = nextWork ? Math.max(queued, nextWork.start) : Infinity;
  const eligible = Math.min(boundary, deadline ?? Infinity, workStart, until);
  return {
    mode: 'BATCH', reason: eligible === deadline ? 'RESPONSE_DEADLINE' : eligible === workStart ? 'NEXT_WORKING_WINDOW' : eligible === until ? 'POLICY_END' : 'NON_WORKING_BATCH',
    policyVersion: policy.version, eligibleAt: iso(eligible), windowEnd: iso(boundary),
  };
}

function invalid(field: string): never { throw new TypeError(`无效的${field}`); }
function record(value: unknown, allowed: string[], label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid(label);
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid(`${label}字段`);
}
function validateWindows(windows: DeliveryWindow[]): void {
  if (!Array.isArray(windows) || windows.length > 8) invalid('每日窗口（最多 8 个）');
  for (const window of windows) {
    record(window, ['start', 'end'], '时间窗口');
    if (minuteOfDay(window.start, false) === minuteOfDay(window.end, true)) invalid('零长度窗口（全天须写 00:00–24:00）');
  }
}
function minuteOfDay(value: string, allowEnd: boolean): number {
  if (allowEnd && value === '24:00') return 1440;
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) invalid('时间（HH:mm）');
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}
function dateEpoch(value: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) invalid('日期（YYYY-MM-DD）');
  const result = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(result) || iso(result).slice(0, 10) !== value) invalid('日期（YYYY-MM-DD）');
  return result;
}
function formatter(timeZone: string): Intl.DateTimeFormat {
  if (typeof timeZone !== 'string' || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(timeZone) || timeZone.length > 100) invalid('IANA 时区');
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, calendar: 'gregory', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  } catch { return invalid('IANA 时区'); }
}
function iso(value: number): string { return new Date(value).toISOString(); }
function dayKey(value: number): string { return iso(value).slice(0, 10); }
function isoWeekday(day: number): number { return new Date(day).getUTCDay() || 7; }

/**
 * 把本地墙钟窗口与时区的真实 offset 分段相交，而非猜测 UTC 偏移。
 * DST 缺失时间自然跳过；重复小时产生两个区间，间隙不会误算为工作时间。
 * 每个候选日仅检查固定 6 小时采样及 offset 变化的二分，不逐分钟扫描。
 */
class WorkingCalendar {
  private readonly format: Intl.DateTimeFormat;
  private readonly overrides: Map<string, DeliveryTimingPolicy['dateOverrides'][number]>;
  private readonly segments = new Map<number, OffsetSegment[]>();
  constructor(private readonly policy: DeliveryTimingPolicy) {
    this.format = formatter(policy.timeZone);
    this.overrides = new Map(policy.dateOverrides.map(value => [value.date, value]));
  }
  private wallTime(instant: number): number {
    const parts = this.format.formatToParts(instant);
    const values = new Map(parts.map(part => [part.type, part.value]));
    const year = values.get('year')!.padStart(4, '0');
    return Date.parse(`${year}-${values.get('month')}-${values.get('day')}T${values.get('hour')}:${values.get('minute')}:${values.get('second')}.000Z`);
  }
  private offset(instant: number): number {
    const seconds = Math.floor(instant / 1000) * 1000;
    return this.wallTime(seconds) - seconds;
  }
  private localDay(instant: number): number { return Math.floor(this.wallTime(instant) / DAY) * DAY; }
  private offsetSegments(day: number): OffsetSegment[] {
    const cached = this.segments.get(day);
    if (cached) return cached;
    const start = day - 2 * DAY, end = day + 3 * DAY, step = 6 * 60 * MINUTE;
    const result: OffsetSegment[] = [];
    let segmentStart = start, previousAt = start, previousOffset = this.offset(start);
    for (let probe = start + step; probe <= end; probe += step) {
      const offset = this.offset(probe);
      if (offset !== previousOffset) {
        let low = previousAt, high = probe;
        while (high - low > 1000) {
          const middle = Math.floor((low + high) / 2000) * 1000;
          if (this.offset(middle) === previousOffset) low = middle; else high = middle;
        }
        result.push({ start: segmentStart, end: high, offset: previousOffset });
        segmentStart = high;
        previousOffset = offset;
      }
      previousAt = probe;
    }
    result.push({ start: segmentStart, end, offset: previousOffset });
    this.segments.set(day, result);
    return result;
  }
  private windows(day: number): DeliveryWindow[] {
    return this.overrides.get(dayKey(day))?.windows ?? this.policy.weeklyWindows[String(isoWeekday(day))] ?? [];
  }
  private intervals(day: number): Interval[] {
    const result: Interval[] = [];
    const nextOverride = this.overrides.get(dayKey(day + DAY));
    for (const window of this.windows(day)) {
      const startMinute = minuteOfDay(window.start, false), endMinute = minuteOfDay(window.end, true);
      const startWall = day + startMinute * MINUTE;
      let endWall = day + (endMinute <= startMinute ? 1440 + endMinute : endMinute) * MINUTE;
      if (nextOverride?.kind === 'HOLIDAY' && nextOverride.windows.length === 0) endWall = Math.min(endWall, day + DAY);
      for (const segment of this.offsetSegments(day)) {
        const start = Math.max(startWall - segment.offset, segment.start);
        const end = Math.min(endWall - segment.offset, segment.end);
        if (start < end) result.push({ start, end });
      }
    }
    return result;
  }
  currentWindow(at: number): Interval | undefined {
    const day = this.localDay(at);
    const intervals = this.intervals(day - DAY).concat(this.intervals(day)).sort((a, b) => a.start - b.start);
    const current = intervals.find(value => value.start <= at && value.end > at);
    if (!current) return undefined;
    const merged = { ...current };
    for (const interval of intervals) if (interval.start <= merged.end && interval.end > merged.end) merged.end = interval.end;
    return merged;
  }
  nextWindow(at: number): Interval | undefined {
    const day = this.localDay(at), candidates = new Set<number>([day - DAY, day]);
    // 每个星期几只找第一个未被日期覆盖的周期窗口；显式覆盖直接加入。
    for (let weekday = 1; weekday <= 7; weekday++) {
      if (!(this.policy.weeklyWindows[String(weekday)]?.length)) continue;
      let candidate = day + ((weekday - isoWeekday(day) + 7) % 7) * DAY;
      if (candidate === day) candidate += 7 * DAY;
      // 周期窗口可能整段落在 DST 缺失小时（或被全闭假日截断）。
      // 这种日期不代表未来再无工时，继续下一周；日期覆盖另行处理。
      while (this.overrides.has(dayKey(candidate)) || this.intervals(candidate).length === 0) candidate += 7 * DAY;
      candidates.add(candidate);
    }
    for (const override of this.policy.dateOverrides) {
      const candidate = dateEpoch(override.date);
      if (candidate >= day && override.windows.length) candidates.add(candidate);
    }
    for (const candidate of [...candidates].sort((a, b) => a - b)) {
      const next = this.intervals(candidate).filter(value => value.end > at).sort((a, b) => a.start - b.start)[0];
      if (next) return next;
    }
    return undefined;
  }
  nextBatch(queued: number, minutes: number): number {
    const duration = minutes * MINUTE, day = this.localDay(queued), candidates: number[] = [];
    for (const segment of this.offsetSegments(day)) {
      const earliest = Math.max(queued + 1, segment.start);
      if (earliest >= segment.end) continue;
      const local = earliest + segment.offset, midnight = Math.floor(local / DAY) * DAY;
      const wallBoundary = Math.min(midnight + DAY, midnight + Math.ceil((local - midnight) / duration) * duration);
      const boundary = wallBoundary - segment.offset;
      if (boundary >= earliest && boundary < segment.end) candidates.push(boundary);
    }
    const result = Math.min(...candidates);
    if (!Number.isFinite(result)) invalid('时区批次边界');
    return result;
  }
}
