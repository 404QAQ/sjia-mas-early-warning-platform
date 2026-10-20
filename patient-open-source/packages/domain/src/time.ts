/**
 * 公开患者契约共用的严格 ISO 时间解析。
 *
 * 只接受带时区的时间，拒绝本地时区隐式解析和 JavaScript 自动滚动的
 * 非法日期。非法输入统一抛出 RangeError，供领域校验复用。
 */
export function parseCareInstant(value: string): number {
  if (typeof value !== 'string') throw new RangeError('时间必须是带时区的有效 ISO 时间');
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new RangeError('时间必须是带时区的有效 ISO 时间');
  const [, rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond, zone] = match;
  const year = Number(rawYear), month = Number(rawMonth), day = Number(rawDay);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = month === 2 ? leap ? 29 : 28 : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (month < 1 || month > 12 || day < 1 || day > monthDays || Number(rawHour) > 23 || Number(rawMinute) > 59 || Number(rawSecond) > 59) {
    throw new RangeError('时间必须是带时区的有效 ISO 时间');
  }
  if (zone !== 'Z' && (Number(zone!.slice(1, 3)) > 23 || Number(zone!.slice(4, 6)) > 59)) {
    throw new RangeError('时间必须是带时区的有效 ISO 时间');
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new RangeError('时间必须是带时区的有效 ISO 时间');
  return parsed;
}
