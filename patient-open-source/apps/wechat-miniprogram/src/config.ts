/**
 * 构建脚本会把此开发占位替换为 MAS_WECHAT_API_BASE；微信包中不放任何密钥。
 * 未配置时仅允许本机开发服务，生产构建必须显式传入备案 HTTPS 域名。
 */
export const API_BASE = 'http://127.0.0.1:4302';
/**
 * 仅由免登录会议演示包在构建时打开。它让“进入日常记录”提交固定演示 code 建立会话，
 * 不依赖当前开发者工具的 wx.login；服务端仍必须提供开发身份映射，标准包保持真实微信登录。
 */
export const AUTO_DEMO_LOGIN = false;
export const SESSION_KEY = 'mas.wechat.session.v1';
export const ENTRY_SEX_INTENT_KEY = 'mas.wechat.entry-sex-intent.v1';
export const PATIENT_KEY = 'mas.wechat.patientId.v1';
export const MUTATION_OUTBOX_KEY_PREFIX = 'mas.wechat.mutation-outbox.v1';
export const PENDING_MESSAGE_KEY_PREFIX = 'mas.wechat.pending-message.v2';
export const RECORD_OUTBOX_KEY_PREFIX = 'mas.wechat.pending.v2';

/**
 * 体温、症状记录队列的键。带上 API 源并逐段编码，含 ':' 的 id 不会撞键；v2 前缀不动旧 v1 数据。
 * 键格式与另外两类不同，所以集中在这里生成，会话失效清理和队列本身用的是同一个键。
 */
export function recordOutboxKey(userId: string, actorId: string, patientId: string): string {
  return [RECORD_OUTBOX_KEY_PREFIX, ...[API_BASE, userId, actorId, patientId].map(part => encodeURIComponent(part))].join(':');
}

export function medicationReminderKey(userId: string, actorId: string, patientId: string): string {
  return ['mas.wechat.medication-reminder.v1', ...[API_BASE, userId, actorId, patientId].map(part => encodeURIComponent(part))].join(':');
}

/** 按 userId:actorId:patientId 隔离、会话失效时必须一并清除的本机待提交数据。 */
export function localFollowupKey(userId: string, actorId: string, patientId: string): string {
  return ['mas.wechat.followup.v1', ...[API_BASE, userId, actorId, patientId].map(part => encodeURIComponent(part))].join(':');
}

export function transitionChecklistKey(userId: string, actorId: string, patientId: string): string {
  return ['mas.wechat.transition-checklist.v1', ...[API_BASE, userId, actorId, patientId].map(part => encodeURIComponent(part))].join(':');
}

export function identityStorageKeys(userId: string, actorId: string, patientId: string): string[] {
  const archiveKey = `mas.clinical-archive.v1:${JSON.stringify([API_BASE, userId, actorId, patientId])}`;
  let clinicalKeys: string[] = [];
  try { clinicalKeys = (wx.getStorageInfoSync?.().keys ?? []).filter(key => key.startsWith(`${archiveKey}:pending:`) || key.startsWith(`${archiveKey}:upload:`)); } catch { /* 固定键仍须清理。 */ }
  return [
    ...[MUTATION_OUTBOX_KEY_PREFIX, PENDING_MESSAGE_KEY_PREFIX].map(prefix => `${prefix}:${userId}:${actorId}:${patientId}`),
    recordOutboxKey(userId, actorId, patientId),
    medicationReminderKey(userId, actorId, patientId),
    localFollowupKey(userId, actorId, patientId),
    transitionChecklistKey(userId, actorId, patientId),
    ['mas.wechat.vitals.v1', ...[API_BASE, userId, actorId, patientId].map(encodeURIComponent)].join(':'),
    archiveKey,
    `${archiveKey}:demo-seeded`,
    ...clinicalKeys,
  ];
}

export type MiniRole = 'PATIENT' | 'LEGAL_GUARDIAN' | 'CAREGIVER' | 'SPOUSE' | 'PROXY' | 'CONTACT';

export function roleLabel(role: MiniRole): string {
  return ({ PATIENT: '患者本人', LEGAL_GUARDIAN: '法定监护人', CAREGIVER: '照护者', SPOUSE: '配偶/家庭支持者', PROXY: '授权代理人', CONTACT: '应急联系人' } as Record<MiniRole, string>)[role];
}

export function isMiniRole(value: unknown): value is MiniRole {
  return value === 'PATIENT' || value === 'LEGAL_GUARDIAN' || value === 'CAREGIVER' || value === 'SPOUSE' || value === 'PROXY' || value === 'CONTACT';
}
