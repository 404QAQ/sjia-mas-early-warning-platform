/**
 * L-02 工作与职场自助。
 *
 * 这是教育内容的使用留痕，与 Observation、告警和通知完全分离。使用记录
 * 只保留功能类型和“已开启/已完成”状态，不能承载患者填写的答案或自由文本。
 */

export const WORK_SUPPORT_TYPES = {
  WORK_DISCLOSURE: 'WORK_DISCLOSURE',
  FATIGUE_MGMT: 'FATIGUE_MGMT',
  WORK_RETURN: 'WORK_RETURN',
} as const;
export type WorkSupportType = (typeof WORK_SUPPORT_TYPES)[keyof typeof WORK_SUPPORT_TYPES];

export const WORK_SUPPORT_STATUSES = { OPENED: 'OPENED', COMPLETED: 'COMPLETED' } as const;
export type WorkSupportStatus = (typeof WORK_SUPPORT_STATUSES)[keyof typeof WORK_SUPPORT_STATUSES];

export interface WorkSupportUsage {
  id: string;
  patientId: string;
  type: WorkSupportType;
  status: WorkSupportStatus;
  openedAt: string;
  completedAt?: string;
  /** L-02 使用痕迹永远是非临床数据。 */
  tags: readonly ['NO_ALERT'];
  contentRef: string;
  updatedAt: string;
}

export function isWorkSupportType(value: unknown): value is WorkSupportType {
  return value === WORK_SUPPORT_TYPES.WORK_DISCLOSURE || value === WORK_SUPPORT_TYPES.FATIGUE_MGMT || value === WORK_SUPPORT_TYPES.WORK_RETURN;
}

export function isWorkSupportStatus(value: unknown): value is WorkSupportStatus {
  return value === WORK_SUPPORT_STATUSES.OPENED || value === WORK_SUPPORT_STATUSES.COMPLETED;
}

export function isWorkSupportUsage(value: unknown): value is WorkSupportUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const allowed = ['id', 'patientId', 'type', 'status', 'openedAt', 'completedAt', 'tags', 'contentRef', 'updatedAt'];
  if (Object.keys(item).some(key => !allowed.includes(key))) return false;
  if (typeof item.id !== 'string' || typeof item.patientId !== 'string' || !isWorkSupportType(item.type) || !isWorkSupportStatus(item.status)) return false;
  if (typeof item.openedAt !== 'string' || typeof item.updatedAt !== 'string' || typeof item.contentRef !== 'string' || !item.contentRef.trim()) return false;
  if (!Array.isArray(item.tags) || item.tags.length !== 1 || item.tags[0] !== 'NO_ALERT') return false;
  if (item.completedAt !== undefined && typeof item.completedAt !== 'string') return false;
  return item.status === 'COMPLETED' ? item.completedAt !== undefined : item.completedAt === undefined;
}
