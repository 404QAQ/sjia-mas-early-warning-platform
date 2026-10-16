/**
 * 五层规则函数的实现（docs/01 §3 的形式化）。
 *
 *   can(actor, action, target) :=
 *        active_relation(actor, patient)
 *     && scope_allows(relation, action)
 *     && visible(actor, action, target)
 *     && lifecycle_allows(patient.life_stage, actor)
 *     && NOT revoked(actor, patient)
 *
 * scope_allows 是**代码内常量**而非数据库表：关系类型与动作的对应关系是领域知识
 * （LEGAL_GUARDIAN 能做什么是设计决定），放数据库会让人以为可以随便改，改错就是权限漏洞。
 */

import type { Actor, ActorRelation, Contact, LifeStage, Patient, Visibility } from './types.js';

export const ACTIONS = {
  VIEW_CLINICAL: 'VIEW_CLINICAL',
  VIEW_PRIVATE_SPACE: 'VIEW_PRIVATE_SPACE',
  RECORD_OBSERVATION: 'RECORD_OBSERVATION',
  MANAGE_CONTACTS: 'MANAGE_CONTACTS',
  CHANGE_VISIBILITY: 'CHANGE_VISIBILITY',
  MODIFY_TREATMENT_PLAN: 'MODIFY_TREATMENT_PLAN',
  ALERT_IGNORE: 'ALERT_IGNORE',
  ALERT_CLOSE: 'ALERT_CLOSE',
  CONFIG_THRESHOLDS: 'CONFIG_THRESHOLDS',
  TRIGGER_DORMANT_PROXY: 'TRIGGER_DORMANT_PROXY',
  VIEW_AUDIT_SELF: 'VIEW_AUDIT_SELF',
} as const;

export type Action = (typeof ACTIONS)[keyof typeof ACTIONS];

/** 关系类型 → 允许的动作。CLINICIAN 的可见范围另由照护团队与班次决定（见 §4） */
const SCOPE_ALLOWS: Record<ActorRelation, Action[]> = {
  SELF: [
    ACTIONS.VIEW_CLINICAL,
    ACTIONS.VIEW_PRIVATE_SPACE,
    ACTIONS.RECORD_OBSERVATION,
    ACTIONS.MANAGE_CONTACTS,
    ACTIONS.CHANGE_VISIBILITY,
    ACTIONS.VIEW_AUDIT_SELF,
  ],
  LEGAL_GUARDIAN: [
    ACTIONS.VIEW_CLINICAL,
    ACTIONS.RECORD_OBSERVATION,
    ACTIONS.MANAGE_CONTACTS,
    ACTIONS.CHANGE_VISIBILITY,
    ACTIONS.VIEW_AUDIT_SELF,
  ],
  CAREGIVER: [ACTIONS.VIEW_CLINICAL, ACTIONS.RECORD_OBSERVATION],
  SPOUSE: [ACTIONS.VIEW_CLINICAL],
  PROXY: [ACTIONS.VIEW_CLINICAL, ACTIONS.RECORD_OBSERVATION],
  CLINICIAN: [
    ACTIONS.VIEW_CLINICAL,
    ACTIONS.RECORD_OBSERVATION,
    ACTIONS.MODIFY_TREATMENT_PLAN,
    ACTIONS.ALERT_IGNORE,
    ACTIONS.ALERT_CLOSE,
    ACTIONS.CONFIG_THRESHOLDS,
    ACTIONS.TRIGGER_DORMANT_PROXY,
  ],
};

/** 儿童期为受限的「自我记录」子集：8–14 岁患儿可用轻量入口记录自己的感受 */
const CHILD_SELF_ALLOWED: Action[] = [
  ACTIONS.VIEW_CLINICAL,
  ACTIONS.VIEW_PRIVATE_SPACE,
  ACTIONS.RECORD_OBSERVATION,
];

export interface CanContext {
  patient: Patient;
  actor: Actor;
  /** 目标数据的可见颗粒度要求（当目标是某条记录时） */
  requiredVisibility?: Visibility;
  /** 当前操作者绑定的联系人授权记录；不是待管理的目标联系人 */
  contact?: Contact;
  /** 该 Actor 是否在患者照护团队内（医护） */
  clinicianInCareTeam?: boolean;
  /** 医护当前是否在班（值班只在本班次内可见） */
  clinicianOnDuty?: boolean;
  /** 该动作只允许随诊/主诊（如真关闭告警） */
  requiresPrimaryRole?: boolean;
  /** 已核验的 CONFIG 授权；仅照护团队成员身份不足以配置阈值 */
  canConfigureThresholds?: boolean;
  /** 调用方给出的医护角色 */
  clinicianRole?: 'ATTENDING' | 'PRIMARY' | 'ON_CALL' | 'CONSULTANT' | 'NURSE';
  now: string;
}

export interface CanDecision {
  allowed: boolean;
  /** 逐层判定结果，用于审计「为什么允许/拒绝」 */
  layers: {
    activeRelation: boolean;
    scopeAllows: boolean;
    visible: boolean;
    lifecycleAllows: boolean;
    notRevoked: boolean;
  };
  reason?: string;
  /**
 * 拒绝的种类，供服务端给 403 附 `denial` 字段。
   *
   * 存在的理由：`FORBIDDEN` 一个码同时承载「照护范围已失效」和「角色/资源不适用」，
   * 客户端只能靠白名单猜，猜错就把医生正在看的整屏清掉。白名单不能解决这个
   * 问题——它只是把 FORBIDDEN 整个当成范围失效。
   *
   * SCOPE：关系、照护团队、班次、撤销状态任一不成立 —— 这位患者不再归当前身份照护。
   * ROLE：身份与患者的关系没问题，但这个动作不归该关系/角色做。
   * NOT_APPLICABLE：可见颗粒度或资源范围不够，内容拿不到，照护范围没有失效。
   */
  denialKind?: 'SCOPE' | 'ROLE' | 'NOT_APPLICABLE';
}

const VISIBILITY_RANK: Record<Visibility, number> = { G1_NOTIFY: 1, G2_SUMMARY: 2, G3_FULL: 3 };

export function can(action: Action, ctx: CanContext): CanDecision {
  const { patient, actor } = ctx;
  const nowMs = permissionInstant(ctx.now);

  // 1. 是否与该患者有生效关系
  const activeRelation =
    actor.patientId === patient.id &&
    permissionInstant(actor.activeFrom) <= nowMs &&
    (actor.activeUntil === undefined || permissionInstant(actor.activeUntil) > nowMs);

  // 2. 该关系类型是否允许该动作
  let scopeAllows = SCOPE_ALLOWS[actor.relation].includes(action);
  if (actor.relation === 'SELF' && patient.lifeStage === 'CHILD') {
    // 儿童期：本人只能走轻量入口的动作子集
    scopeAllows = CHILD_SELF_ALLOWED.includes(action);
  }
  // 组建/角色两类失败要分开：前者是「你不在这位患者的照护范围内」，后者是
  // 「你在，但这个动作不归你的角色做」。合成一个布尔值就无法给客户端分类。
  let teamAllows = true;
  let roleAllows = true;
  if (actor.relation === 'CLINICIAN') {
    // 医护必须在照护团队内；值班只在本班次内可见
    teamAllows = Boolean(ctx.clinicianInCareTeam);
    if (ctx.clinicianRole === 'ON_CALL' && !ctx.clinicianOnDuty) teamAllows = false;
    if (action === ACTIONS.ALERT_CLOSE || ctx.requiresPrimaryRole) {
      roleAllows = ctx.clinicianRole === 'PRIMARY' || ctx.clinicianRole === 'ATTENDING' || ctx.clinicianRole === 'CONSULTANT';
    }
    if (action === ACTIONS.MODIFY_TREATMENT_PLAN || action === ACTIONS.TRIGGER_DORMANT_PROXY) {
      roleAllows = roleAllows && (ctx.clinicianRole === 'PRIMARY' || ctx.clinicianRole === 'ATTENDING' || ctx.clinicianRole === 'CONSULTANT' || ctx.clinicianRole === 'ON_CALL');
    }
    if (action === ACTIONS.CONFIG_THRESHOLDS) roleAllows = roleAllows && ctx.canConfigureThresholds === true;
    scopeAllows = scopeAllows && teamAllows && roleAllows;
  }

  // 3. 可见颗粒度
  let visible = !ctx.contact || (ctx.contact.patientId === patient.id && ctx.contact.actorId === actor.id);
  if (ctx.requiredVisibility) {
    const granted = visibilityOf(ctx);
    visible = visible && VISIBILITY_RANK[granted] >= VISIBILITY_RANK[ctx.requiredVisibility];
  }
  // 个人空间：家长不可见，医生也仅在患者主动分享时可见
  if (action === ACTIONS.VIEW_PRIVATE_SPACE) {
    if (actor.relation === 'LEGAL_GUARDIAN' || actor.relation === 'CAREGIVER') visible = false;
    if (actor.relation === 'CLINICIAN') visible = false; // 主动分享走另一条通道（分享记录）
  }

  // 4. 生命阶段
  const lifecycleAllows = lifecycleAllowsAction(patient.lifeStage, actor, ctx.now);

  // 5. 未撤销；未来生效的撤销不能提前切断当前授权，非法时间仍 fail-closed。
  const notRevoked = actor.revokedAt === undefined || permissionInstant(actor.revokedAt) > nowMs;

  const allowed = activeRelation && scopeAllows && visible && lifecycleAllows && notRevoked;
  return {
    allowed,
    layers: { activeRelation, scopeAllows, visible, lifecycleAllows, notRevoked },
    reason: allowed ? undefined : explain({ activeRelation, scopeAllows, visible, lifecycleAllows, notRevoked }),
    // 关系/团队/班次/撤销任一不成立就是范围失效；其次才是角色；最后才是内容拿不到。
    ...(allowed ? {} : { denialKind: !activeRelation || !notRevoked || !teamAllows ? 'SCOPE' as const : !lifecycleAllows || !roleAllows ? 'ROLE' as const : 'NOT_APPLICABLE' as const }),
  };
}

/** 告警权限在临床权限之上收紧；角色须来自当前有效照护、排班和替班解析。 */
export function canViewAlert(ctx: CanContext, currentLevel: number): CanDecision {
  const decision = can(ACTIONS.VIEW_CLINICAL, ctx);
  if (!decision.allowed) return decision;
  if (currentLevel === 1 && ctx.actor.relation === 'CLINICIAN' && ctx.clinicianRole === 'ON_CALL') {
    return {
      ...decision,
      allowed: false,
      layers: { ...decision.layers, visible: false },
      reason: '纯值班医师不可查看L1告警',
      // 值班医师在照护团队内、只是这一级别的告警不归他看，不是范围失效。
      denialKind: 'ROLE',
    };
  }
  return decision;
}

function visibilityOf(ctx: CanContext): Visibility {
  if (ctx.contact) return ctx.contact.visibility;
  if (ctx.actor.relation === 'CLINICIAN') return 'G3_FULL';
  if (ctx.actor.relation === 'SELF') return 'G3_FULL';
  if (ctx.actor.relation === 'LEGAL_GUARDIAN' || ctx.actor.relation === 'CAREGIVER') return 'G3_FULL';
  return 'G2_SUMMARY';
}

/**
 * 生命阶段判定。过渡期的渐进移交时间表（docs/01 §2.2）：
 *   16 岁起：用药提醒直接发给患者本人
 *   17 岁起：患者可自行确认复诊时间
 *   17.5 岁起：患者开始接收告警通知，家长同步抄送
 *   18 岁：完成正式交接
 */
export function lifecycleAllowsAction(stage: LifeStage, actor: Actor, at: string): boolean {
  if (stage === 'CHILD') {
    // 儿童期：监护人/照护者为主；本人走轻量入口
    return true;
  }
  if (stage === 'TRANSITION') {
    return true;
  }
  // 成年期：本人自主。家长降级为紧急联系人 —— 但**休眠代理权激活期间**例外。
  // 「休眠」的要义是：仅当医生显式发起激活，且有效激活时刻已到，才恢复代理权；
  // 只持有 isDormantProxy 标记（尚未激活）不足以获得权限，否则「休眠」形同虚设。
  if (actor.relation === 'LEGAL_GUARDIAN' || actor.relation === 'CAREGIVER') {
    return actor.isDormantProxy && permissionInstant(actor.dormantProxyActivatedAt) <= permissionInstant(at);
  }
  return true;
}

/** 过渡期按年龄计算的权限移交阶段，供界面对照表展示与通知路由使用 */
export function transitionMilestones(
  patient: Patient,
  at: string,
): Array<{ atAge: number; label: string; reached: boolean }> {
  const ageMonths = ageInMonths(patient.birthDate, at);
  return [
    { atAge: 16, label: '用药提醒直接发给本人', reached: ageMonths >= 192 },
    { atAge: 17, label: '可自行确认复诊时间', reached: ageMonths >= 204 },
    { atAge: 17.5, label: '开始接收告警通知（家长同步抄送）', reached: ageMonths >= 210 },
    { atAge: 18, label: '完成正式交接', reached: ageMonths >= 216 },
  ];
}

export function ageInYears(birthDate: string, at: string): number {
  return Math.floor(ageInMonths(birthDate, at) / 12);
}

/** 「6岁3月」这类年龄展示（界面与卡片用） */
export function ageDisplay(birthDate: string, at: string): string {
  const months = Math.max(0, ageInMonths(birthDate, at));
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (y === 0) return `${m}月`;
  return m === 0 ? `${y}岁` : `${y}岁${m}月`;
}

/** 生命阶段推导（由出生日期，可人工覆盖） */
export function deriveLifeStage(birthDate: string, at: string): LifeStage {
  const years = ageInYears(birthDate, at);
  if (years < 14) return 'CHILD';
  if (years < 18) return 'TRANSITION';
  return 'ADULT';
}

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

const SHANGHAI_DATE = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric',
});

/** 出生日期是日历日；时间点统一按上海日期计算，不依赖服务器所在时区。 */
function calendarDate(value: string): CalendarDate {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    const date = { year: Number(dateOnly[1]), month: Number(dateOnly[2]), day: Number(dateOnly[3]) };
    if (date.month < 1 || date.month > 12 || date.day < 1 || date.day > daysInMonth(date.year, date.month)) {
      throw new RangeError('无效的日历日期');
    }
    return date;
  }
  const parts = SHANGHAI_DATE.formatToParts(new Date(value));
  const part = (type: 'year' | 'month' | 'day'): number => Number(parts.find((item) => item.type === type)!.value);
  return { year: part('year'), month: part('month'), day: part('day') };
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** 授权时间必须是带时区且日历真实的 ISO 时间；非法值以 NaN 参与比较，从而默认拒绝。 */
function permissionInstant(value: string | undefined): number {
  if (typeof value !== 'string') return Number.NaN;
  const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!iso) return Number.NaN;
  const year = Number(iso[1]);
  const month = Number(iso[2]);
  const day = Number(iso[3]);
  const hour = Number(iso[4]);
  const minute = Number(iso[5]);
  const second = Number(iso[6]);
  const zone = iso[7]!;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) return Number.NaN;
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)) return Number.NaN;
  return Date.parse(value);
}

function ageInMonths(birthDate: string, at: string): number {
  const birth = calendarDate(birthDate);
  const current = calendarDate(at);
  let months = (current.year - birth.year) * 12 + current.month - birth.month;
  // 例如 8 月 31 日的半年生日在次年 2 月末，不顺延到 3 月。
  const anniversaryDay = Math.min(birth.day, daysInMonth(current.year, current.month));
  if (current.day < anniversaryDay) months -= 1;
  return months;
}

function explain(l: CanDecision['layers']): string {
  if (!l.notRevoked) return '该操作者与患者的关系已被撤销';
  if (!l.activeRelation) return '该操作者与患者当前没有生效关系';
  if (!l.scopeAllows) return '当前关系类型不允许该操作';
  if (!l.visible) return '可见颗粒度不足';
  return '生命阶段不允许该操作';
}
