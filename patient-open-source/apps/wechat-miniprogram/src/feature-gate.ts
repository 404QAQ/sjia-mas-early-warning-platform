import { ApiFailure } from './api';
import type { MiniRole } from './config';

/**
 * 入口和按钮按「当前身份能不能用」收起。客户端只拿得到 role，拿不到患者的
 * lifeStage、性别等事实，所以分两层：
 *   1. 按 role 能确定的（经期 / 妊娠只对患者本人开放，职场只对本人和法定监护人开放）直接收起；
 *   2. 按档案事实才能判断的（儿童、未登记为女性、未成年本人），以服务端回执为准：某页收到明确的
 *      403 后记在这里，同一身份下从此收起该入口 / 按钮、改为说明。
 * 只记在内存里、按 userId:actorId:patientId 分开：换身份或重启小程序后重新以服务端为准，
 * 本机存储里不留任何关于档案事实的推断。
 */
export type GatedFeature = 'MENSTRUAL' | 'PREGNANCY' | 'WORK_SUPPORT' | 'CARE_INVITE_ISSUE';

const ROLE_RULES: Record<GatedFeature, readonly MiniRole[]> = {
  MENSTRUAL: ['PATIENT'],
  PREGNANCY: ['PATIENT'],
  WORK_SUPPORT: ['PATIENT', 'LEGAL_GUARDIAN'],
  // 未成年本人在会话里同样是 PATIENT、成人的监护人可能代理未生效：这两种只能等服务端回执。
  CARE_INVITE_ISSUE: ['PATIENT', 'LEGAL_GUARDIAN'],
};

const receipts = new Map<string, Map<GatedFeature, string>>();

export function featureScopeKey(scope: { userId: string; actorId: string; patientId: string }): string {
  return `${scope.userId}:${scope.actorId}:${scope.patientId}`;
}

export function roleAllows(feature: GatedFeature, role: MiniRole): boolean {
  return ROLE_RULES[feature].includes(role);
}

/** 只有 403 才是「本档案 / 本身份不适用」的回执；401、断网、5xx 都不能据此收起入口。 */
export function recordUnavailable(scopeKey: string, feature: GatedFeature, error: unknown): void {
  if (!scopeKey || !(error instanceof ApiFailure) || error.status !== 403) return;
  const current = receipts.get(scopeKey) ?? new Map<GatedFeature, string>();
  current.set(feature, error.message);
  receipts.set(scopeKey, current);
}

export function unavailableReason(scopeKey: string, feature: GatedFeature): string | null {
  return receipts.get(scopeKey)?.get(feature) ?? null;
}

const CARE_INVITE_ROLE_NOTE = '邀请医生只对患者本人或法定监护人开放，当前身份下不显示。';

/**
 * 「邀请我的医生」入口。服务端连列表读取都要求签发资格，非签发身份点进去什么也看不到，
 * 所以入口和经期、职场一样在原位置收起并写明原因；首页与照护页共用这一处判断。
 */
export function careInviteEntry(current: { role: MiniRole; userId: string; actorId: string; patientId?: string }): { showCareInvite: boolean; careInviteNote: string } {
  if (!roleAllows('CARE_INVITE_ISSUE', current.role)) return { showCareInvite: false, careInviteNote: CARE_INVITE_ROLE_NOTE };
  const reason = current.patientId ? unavailableReason(featureScopeKey({ userId: current.userId, actorId: current.actorId, patientId: current.patientId }), 'CARE_INVITE_ISSUE') : null;
  return reason ? { showCareInvite: false, careInviteNote: `邀请我的医生已收起：${reason}` } : { showCareInvite: true, careInviteNote: '' };
}
