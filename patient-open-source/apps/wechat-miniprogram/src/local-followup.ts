import { localFollowupKey } from './config';

interface FollowupScope { userId: string; actorId: string; patientId: string; }
export interface LocalFollowup { date: string; note: string; hospital?: string; department?: string; doctor?: string; examItems?: string; }

function optionalText(value: unknown, max = 200): string | undefined {
  return typeof value === 'string' && value.trim() ? value.slice(0, max) : undefined;
}

export function validFollowupDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

/** 用户自己记下的日期，与医疗团队确认的预约明确区分。 */
export function readLocalFollowup(scope: FollowupScope): LocalFollowup | null {
  try {
    const raw = wx.getStorageSync<unknown>(localFollowupKey(scope.userId, scope.actorId, scope.patientId));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    if (typeof item.date !== 'string' || !validFollowupDate(item.date)) return null;
    const hospital = optionalText(item.hospital);
    const department = optionalText(item.department);
    const doctor = optionalText(item.doctor);
    const examItems = optionalText(item.examItems);
    return { date: item.date, note: typeof item.note === 'string' ? item.note.slice(0, 200) : '', ...(hospital ? { hospital } : {}), ...(department ? { department } : {}), ...(doctor ? { doctor } : {}), ...(examItems ? { examItems } : {}) };
  } catch { return null; }
}

export function saveLocalFollowup(scope: FollowupScope, value: LocalFollowup): void {
  if (!validFollowupDate(value.date)) throw new Error('请选择有效的复诊日期。');
  const hospital = optionalText(value.hospital);
  const department = optionalText(value.department);
  const doctor = optionalText(value.doctor);
  const examItems = optionalText(value.examItems);
  wx.setStorageSync(localFollowupKey(scope.userId, scope.actorId, scope.patientId), { date: value.date, note: value.note.slice(0, 200), ...(hospital ? { hospital } : {}), ...(department ? { department } : {}), ...(doctor ? { doctor } : {}), ...(examItems ? { examItems } : {}) });
}
