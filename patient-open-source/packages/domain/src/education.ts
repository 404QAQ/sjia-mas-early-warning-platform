/** 患者教育内容与临床数据严格分离；文章版本不可覆盖，已读按操作者分别记录。 */
export const EDUCATION_TRIGGERS = ['STEROID_PLAN_START', 'STEROID_DOSE_DECREASE', 'RED_ALERT_FOLLOWUP', 'MANUAL_CLINICIAN', 'PSYCH_SCREENING_MILD'] as const;
export type EducationTrigger = (typeof EDUCATION_TRIGGERS)[number];
export const EDUCATION_AUDIENCES = ['SELF', 'LEGAL_GUARDIAN', 'CAREGIVER', 'CLINICIAN'] as const;
export type EducationAudience = (typeof EDUCATION_AUDIENCES)[number];
export type EducationArticleStatus = 'PUBLISHED' | 'RETIRED';
export interface EducationSource { id: string; title: string; citation: string; url?: string; }
export interface EducationArticleVersion {
  articleId: string; version: number; slug: string; title: string; body: string;
  audiences: readonly EducationAudience[]; lifeStages: readonly string[]; diseaseTypes: readonly string[];
  source: EducationSource; verifiedAt: string; reviewDueAt: string; reviewedBy: string;
  status: EducationArticleStatus; requiresAcknowledgement: boolean; contentHash: string;
}
export interface EducationDelivery {
  id: string; patientId: string; articleId: string; version: number; trigger: EducationTrigger;
  triggerRef: string; audienceRelation: EducationAudience; issuedAt: string; required: boolean;
}
export interface EducationReadReceipt {
  deliveryId: string; patientId: string; actorId: string; actorRelation: EducationAudience;
  readAt: string; requestId: string; idempotencyKey: string;
}
export function isEducationAudience(value: unknown): value is EducationAudience { return typeof value === 'string' && (EDUCATION_AUDIENCES as readonly string[]).includes(value); }
export function isEducationTrigger(value: unknown): value is EducationTrigger { return typeof value === 'string' && (EDUCATION_TRIGGERS as readonly string[]).includes(value); }
export function isEducationArticleVersion(value: unknown): value is EducationArticleVersion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>; const source = item.source as Record<string, unknown> | null;
  return typeof item.articleId === 'string' && item.articleId.length > 0 && Number.isSafeInteger(item.version) && Number(item.version) > 0
    && typeof item.slug === 'string' && item.slug.length > 0 && typeof item.title === 'string' && item.title.length > 0
    && typeof item.body === 'string' && item.body.length > 0 && Array.isArray(item.audiences) && item.audiences.length > 0 && item.audiences.every(isEducationAudience)
    && Array.isArray(item.lifeStages) && item.lifeStages.every(v => typeof v === 'string') && Array.isArray(item.diseaseTypes) && item.diseaseTypes.every(v => typeof v === 'string')
    && source !== null && typeof source === 'object' && typeof source.id === 'string' && typeof source.title === 'string' && typeof source.citation === 'string'
    && typeof item.verifiedAt === 'string' && typeof item.reviewDueAt === 'string' && typeof item.reviewedBy === 'string'
    && (item.status === 'PUBLISHED' || item.status === 'RETIRED') && typeof item.requiresAcknowledgement === 'boolean' && typeof item.contentHash === 'string' && item.contentHash.length > 0;
}
export function isEducationDelivery(value: unknown): value is EducationDelivery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string' && typeof item.patientId === 'string' && typeof item.articleId === 'string'
    && Number.isSafeInteger(item.version) && Number(item.version) > 0 && isEducationTrigger(item.trigger) && typeof item.triggerRef === 'string' && item.triggerRef.length > 0
    && isEducationAudience(item.audienceRelation) && typeof item.issuedAt === 'string' && typeof item.required === 'boolean';
}
