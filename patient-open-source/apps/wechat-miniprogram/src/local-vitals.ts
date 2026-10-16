import { API_BASE } from './config';

export interface VitalScope { userId: string; actorId: string; patientId: string; }
export interface VitalRecord { systolic: number; diastolic: number; spo2: number; heartRate: number; recordedAt: string; }
export function vitalStorageKey(scope: VitalScope): string { return ['mas.wechat.vitals.v1', ...[API_BASE, scope.userId, scope.actorId, scope.patientId].map(encodeURIComponent)].join(':'); }
export function validateVitals(value: VitalRecord): void {
  const ranges: Array<[number, number, number, string]> = [[value.systolic, 40, 260, '收缩压'], [value.diastolic, 20, 180, '舒张压'], [value.spo2, 50, 100, '血氧'], [value.heartRate, 20, 250, '心率']];
  for (const [number, min, max, label] of ranges) if (!Number.isInteger(number) || number < min || number > max) throw new Error(`请核对${label}，填写范围为 ${min}–${max}。`);
  if (value.systolic <= value.diastolic) throw new Error('收缩压应大于舒张压，请核对测量值。');
  if (!Number.isFinite(Date.parse(value.recordedAt)) || Date.parse(value.recordedAt) > Date.now() + 60_000) throw new Error('测量时间无效。');
}
export function readVitals(scope: VitalScope): VitalRecord | null {
  const raw = wx.getStorageSync<unknown>(vitalStorageKey(scope));
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('本机体征记录无法读取。');
  const value = raw as VitalRecord;
  validateVitals(value);
  return value;
}
export function saveVitals(scope: VitalScope, value: VitalRecord): void {
  validateVitals(value);
  wx.setStorageSync(vitalStorageKey(scope), { ...value });
}
