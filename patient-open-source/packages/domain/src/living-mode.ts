/** 患者自愿开启的独居安全模式设置。它是患者画像设置，不是临床观测或告警事实。 */
export interface LivingModeSetting {
  patientId: string;
  enabled: boolean;
  version: number;
  updatedAt: string;
  updatedBy: string;
}

export function isLivingModeSetting(value: unknown): value is LivingModeSetting {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every(key => ['patientId', 'enabled', 'version', 'updatedAt', 'updatedBy'].includes(key))
    && typeof item.patientId === 'string' && item.patientId.trim().length > 0
    && typeof item.enabled === 'boolean'
    && Number.isSafeInteger(item.version) && Number(item.version) >= 0
    && typeof item.updatedAt === 'string' && Number.isFinite(Date.parse(item.updatedAt))
    && typeof item.updatedBy === 'string' && item.updatedBy.trim().length > 0;
}
