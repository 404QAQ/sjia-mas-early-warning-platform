export interface CareCapabilities { canMessageCareTeam: boolean; hasTreatmentClinician: boolean; }

/** 旧响应或读取失败保持未知；列表空白不能证明没有医护收件人。 */
export function parseCareCapabilities(value: unknown, expectedPatientId: string): CareCapabilities | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.patientId !== expectedPatientId || typeof item.asOf !== 'string' || !Number.isFinite(Date.parse(item.asOf))) return null;
  if (!item.capabilities || typeof item.capabilities !== 'object' || Array.isArray(item.capabilities)) return null;
  const capabilities = item.capabilities as Record<string, unknown>;
  return typeof capabilities.canMessageCareTeam === 'boolean' && typeof capabilities.hasTreatmentClinician === 'boolean'
    ? { canMessageCareTeam: capabilities.canMessageCareTeam, hasTreatmentClinician: capabilities.hasTreatmentClinician } : null;
}
