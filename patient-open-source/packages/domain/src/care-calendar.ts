import { parseCareInstant } from './care-routing.js';

export interface CareCalendarDay { date: string; startsAt: string; endsAt: string }
export interface CareCalendarWeek {
  weekStart: string;
  previousWeekStart: string;
  nextWeekStart: string;
  startsAt: string;
  endsAt: string;
  days: CareCalendarDay[];
}

const DAY = 86_400_000;
type OffsetSegment = { start: number; end: number; offset: number };

/**
 * 科室当地周一开始的七个公历日。日界是达到当地午夜的首个真实瞬间：
 * 午夜缺失时顺延至当天首个时刻，重复午夜取第一次；跳过整天则返回空日。
 * 所有区间共享相邻边界且为 [startsAt, endsAt)，不以固定 168 小时推导周长。
 */
export function careCalendarWeek(weekStart: string | undefined, timeZone: string, at: string): CareCalendarWeek {
  const stamp = parseCareInstant(at);
  const format = formatter(timeZone);
  const localDay = Math.floor(wallTime(format, stamp) / DAY) * DAY;
  const monday = weekStart === undefined ? localDay - ((new Date(localDay).getUTCDay() + 6) % 7) * DAY : dateEpoch(weekStart);
  if (new Date(monday).getUTCDay() !== 1) invalid('周起始日期必须为周一');
  // 前后周链接也必须可再次传入同一接口，不能返回五位年份或公元零年。
  const firstDate = dayKey(monday), previousWeekStart = dayKey(monday - 7 * DAY), nextWeekStart = dayKey(monday + 7 * DAY);
  const segments = offsetSegments(format, monday - 2 * DAY, monday + 9 * DAY);
  const boundaries = Array.from({ length: 8 }, (_, index) => boundary(monday + index * DAY, segments));
  const days = Array.from({ length: 7 }, (_, index) => ({
    date: dayKey(monday + index * DAY), startsAt: iso(boundaries[index]!), endsAt: iso(boundaries[index + 1]!),
  }));
  return { weekStart: firstDate, previousWeekStart, nextWeekStart, startsAt: days[0]!.startsAt, endsAt: days[6]!.endsAt, days };
}

function invalid(message: string): never { throw new RangeError(message); }
function iso(stamp: number): string { return new Date(stamp).toISOString(); }
function dayKey(day: number): string {
  const key = iso(day).slice(0, 10);
  dateEpoch(key);
  return key;
}
function dateEpoch(value: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) invalid('周历日期必须是有效的 YYYY-MM-DD');
  const day = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(day) || iso(day).slice(0, 10) !== value) invalid('周历日期必须是有效的 YYYY-MM-DD');
  return day;
}
function formatter(timeZone: string): Intl.DateTimeFormat {
  if (typeof timeZone !== 'string' || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(timeZone) || timeZone.length > 100) invalid('无效的 IANA 时区');
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone, calendar: 'gregory', numberingSystem: 'latn', era: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
  } catch { return invalid('无效的 IANA 时区'); }
}
function wallTime(format: Intl.DateTimeFormat, stamp: number): number {
  const parts = new Map(format.formatToParts(stamp).map(part => [part.type, part.value]));
  const rawYear = Number(parts.get('year'));
  const date = new Date(0);
  date.setUTCFullYear(parts.get('era') === 'BC' ? 1 - rawYear : rawYear, Number(parts.get('month')) - 1, Number(parts.get('day')));
  date.setUTCHours(Number(parts.get('hour')), Number(parts.get('minute')), Number(parts.get('second')), 0);
  return date.getTime();
}
function offsetAt(format: Intl.DateTimeFormat, stamp: number): number {
  const seconds = Math.floor(stamp / 1000) * 1000;
  return wallTime(format, seconds) - seconds;
}

/** 与通知日历相同：六小时采样定位 offset 变化，再二分到 IANA 的秒精度。 */
function offsetSegments(format: Intl.DateTimeFormat, start: number, end: number): OffsetSegment[] {
  const segments: OffsetSegment[] = [];
  const step = 6 * 60 * 60_000;
  let segmentStart = start, previousAt = start, previousOffset = offsetAt(format, start);
  for (let probe = start + step; probe <= end; probe += step) {
    const offset = offsetAt(format, probe);
    if (offset !== previousOffset) {
      let low = previousAt, high = probe;
      while (high - low > 1000) {
        const middle = Math.floor((low + high) / 2000) * 1000;
        if (offsetAt(format, middle) === previousOffset) low = middle; else high = middle;
      }
      segments.push({ start: segmentStart, end: high, offset: previousOffset });
      segmentStart = high;
      previousOffset = offset;
    }
    previousAt = probe;
  }
  segments.push({ start: segmentStart, end, offset: previousOffset });
  return segments;
}

function boundary(midnight: number, segments: OffsetSegment[]): number {
  for (const segment of segments) {
    const candidate = Math.max(segment.start, midnight - segment.offset);
    // 分段依真实时间递增：首个达到日期阈值的片段兼容午夜跳变和整日缺失。
    if (candidate < segment.end) return candidate;
  }
  return invalid('无法确定科室日界');
}
