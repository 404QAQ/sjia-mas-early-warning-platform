/**
 * 小程序里的时间显示口径。与照护工作台采用同一套取值，
 * 但小程序端只保留患者自己会看到的几种：患者看到的时刻必须和照护团队在工作台念出来的
 * 是同一个 —— 「昨晚 39.6℃」对不上时间，家属会以为记录错了。
 *
 * 默认 `Asia/Shanghai`，不是设备时区。患者可能把手机设成别的时区、或者只是出国旅行，
 * 而病历时间指的是当时当地发生的事实（`observedAt` 由服务端记录），不该跟着手机重新解释。
 * 这一点跟医生端一致，两边不能各自决定。
 */
const ZONE = 'Asia/Shanghai';

/** 数字月日 + 两位时分（带年份）。详情、列表条目用它。 */
export function at(value: string | number | Date): string {
  return new Date(value).toLocaleString('zh-CN', { timeZone: ZONE, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** 只有日期（数字月日）。经期、联系人、共享这类「按天」的事实用它。 */
export function longDate(value: string | number | Date): string {
  return new Date(value).toLocaleDateString('zh-CN', { timeZone: ZONE });
}

/** 月日，不带年份。趋势图横轴上的近处时间用它。 */
export function monthDay(value: string | number | Date): string {
  return new Date(value).toLocaleDateString('zh-CN', { timeZone: ZONE, month: 'numeric', day: 'numeric' });
}
