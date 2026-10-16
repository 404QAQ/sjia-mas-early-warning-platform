import { ApiFailure, patientId, request, session } from '../../api';
import { roleLabel, type MiniRole } from '../../config';
import { careInviteEntry, featureScopeKey, roleAllows, unavailableReason } from '../../feature-gate';

/**
 * T-06 患者离世与档案处置（家属端 / 患者端）。
 *
 * 规格里对情绪的要求比功能要求更硬，所以这一页的克制是刻意的：
 *   - **绝不出现任何慰问语**（「节哀」「愿他安息」一律禁止）—— 平台是克制的处理者，不是慰问者；
 *   - **绝不催促决定**（「这两件事都不需要你现在决定」）；
 *   - **不进任何导航的显眼位置**，只在需要时找得到（入口放在「更多」页底部，不在首页）;
 *   - 界面无图标、无颜色强调、无鼓励语、无进度条。
 *
 * 动作边界（服务端硬约束，前端不得绕过）：
 *   - `REGISTER_DECEASED` / `REVOKE_DECEASED` 只有当前医护能做，这里不出现；
 *   - 家属只能做档案处置：转纪念档案、申请全部删除（二次确认 + 3 天冷静期）、撤回删除申请；
 *   - 「通知家属」与「保留临床价值档案」服务端尚未接通（返回 503），因此这里不提供这两个选项 ——
 *     提供一个必然失败的按钮比不提供更糟。
 */
type LifecycleStatus = 'ACTIVE' | 'DECEASED' | 'MEMORIAL' | 'DELETED_REQUESTED' | 'DELETED';
type ResponseKind = 'REQUEST_MEMORIAL' | 'REQUEST_DELETE' | 'CANCEL_DELETE';

interface Lifecycle {
  patientId: string;
  status: LifecycleStatus;
  registeredAt?: string;
  reversibleUntil?: string;
  recordRetention?: 'MEMORIAL' | 'CLINICAL_WITH_CONSENT' | 'FULL_DELETE';
  deletionRequestedAt?: string;
  deleteAfter?: string;
  version: number;
}
interface Scope { userId: string; actorId: string; patientId: string }
interface Section { title: string; body: string }
type ProfileSex = 'FEMALE' | 'MALE' | 'INTERSEX' | 'UNKNOWN';
interface ProfileSummary { name: string; sex: ProfileSex; lifeStage: string; recordCount: number; alertCount: number; ageLabel: string; diagnosis: string; msScore: string; msChange: string; lastActive: string; }
interface ProfileEntry { key: string; title: string; detail: string; icon: string; tone: string; }
interface ProfileGroup { title: string; entries: ProfileEntry[]; }

const PROFILE_ROUTES: Record<string, string> = {
  joint: '/pages/patient/joint', health: '/pages/patient/health', medication: '/pages/patient/medications', screening: '/pages/patient/screening',
  menstrual: '/pages/patient/menstrual', pregnancy: '/pages/patient/pregnancy', fertility: '/pages/patient/more?section=fertility',
  contacts: '/pages/patient/contacts', care: '/pages/patient/support', invite: '/pages/patient/care-invite',
  living: '/pages/patient/living', sharing: '/pages/patient/sharing', audit: '/pages/patient/audit',
  emergency: '/pages/patient/emergency', transition: '/pages/patient/transition', school: '/pages/patient/school',
  life: '/pages/patient/life-event', work: '/pages/patient/work-support', more: '/pages/patient/more', inbox: '/pages/patient/inbox',
};
function profileEntry(key: string, title: string, detail: string, icon: string, tone = 'teal'): ProfileEntry { return { key, title, detail, icon, tone }; }
function profileGroups(current: { userId: string; actorId: string; patientId: string; role: MiniRole }, profile: ProfileSummary | null): ProfileGroup[] {
  const groupKey = featureScopeKey(current);
  const available = (feature: 'MENSTRUAL' | 'PREGNANCY' | 'WORK_SUPPORT') => roleAllows(feature, current.role) && !unavailableReason(groupKey, feature);
  const groups: ProfileGroup[] = [
    { title: '健康与治疗', entries: [profileEntry('health', '疫苗、家族史与私密记录', '接种记录、家族健康与私人日记', 'file'), profileEntry('joint', '关节速记', '晨僵、疼痛与活动记录', 'clipboard', 'blue'), profileEntry('medication', '用药管理', '计划、打卡与用药不适', 'pill', 'blue'), profileEntry('screening', '复诊前事项', '最近的状态与想问的问题', 'clipboard', 'lavender')] },
  ];
  const personalHealth: ProfileEntry[] = [];
  if (profile?.sex === 'FEMALE' && available('MENSTRUAL')) personalHealth.push(profileEntry('menstrual', '经期与用药关注', '私密记录，由你决定共享范围', 'drop', 'rose'));
  if (profile?.sex === 'FEMALE' && profile.lifeStage === 'ADULT' && available('PREGNANCY')) personalHealth.push(profileEntry('pregnancy', '生育与妊娠', '阶段记录与孕前问题清单', 'person', 'rose'));
  if (profile?.sex === 'MALE' && profile.lifeStage === 'ADULT' && current.role === 'PATIENT') personalHealth.push(profileEntry('fertility', '男性生育与用药关注', '查看与当前治疗相关的资料', 'person', 'blue'));
  if (personalHealth.length) groups.push({ title: profile?.sex === 'FEMALE' ? '女性健康' : '男性健康', entries: personalHealth });
  const care = [profileEntry('care', '照护与服务', '照护团队、医生沟通与健康教育', 'cross', 'blue'), profileEntry('contacts', '家庭照护与联系人', '管理联系人与信息授权', 'people')];
  if (careInviteEntry(current).showCareInvite) care.push(profileEntry('invite', '邀请我的医生', '将当前医生加入照护团队', 'plus', 'blue'));
  groups.push({ title: '照护与应急', entries: [...care, profileEntry('emergency', '应急预案与急诊包', '自填预案、就医准备与急诊摘要', 'case', 'coral')] });
  const privacy = [profileEntry('sharing', '跨院数据共享', '查看共享机构与授权范围', 'share'), profileEntry('audit', '谁看过我的数据', '查看近期访问记录', 'eye', 'blue')];
  if (current.role === 'PATIENT') privacy.unshift(profileEntry('living', '独居模式', '管理独居时的照护设置', 'house'));
  groups.push({ title: '隐私与授权', entries: privacy });
  const life = [profileEntry('transition', '成长与照护交接', '自查、交接与独立照护准备', 'route', 'blue')];
  if (profile && ['CHILD', 'TRANSITION'].includes(profile.lifeStage)) life.push(profileEntry('school', '上学这件事', '管理向学校告知的内容', 'book', 'amber'));
  life.push(profileEntry('life', '复诊与搬迁安排', '复诊日程、换城市与转介准备', 'calendar'));
  if (profile && ['TRANSITION', 'ADULT'].includes(profile.lifeStage) && available('WORK_SUPPORT')) life.push(profileEntry('work', '工作与职场支持', '治疗与工作安排的准备', 'case', 'amber'));
  groups.push({ title: '生活与成长', entries: life }, { title: '其他资料', entries: [profileEntry('more', '化验与长期监测', '化验历史、监测安排与缓解期', 'file', 'blue'), profileEntry('inbox', '系统通知', '查看站内提醒与处理记录', 'bell')] });
  return groups;
}
function ageLabel(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const birth = new Date(`${value}T00:00:00+08:00`);
  if (!Number.isFinite(birth.getTime()) || birth.getTime() > Date.now()) return '';
  const today = new Date(Date.now() + 8 * 3600_000);
  const [year, month, day] = value.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return '';
  let months = (today.getUTCFullYear() - year) * 12 + today.getUTCMonth() + 1 - month;
  if (today.getUTCDate() < day) months -= 1;
  return months < 0 ? '' : `${Math.floor(months / 12)}岁${months % 12 ? `${months % 12}月` : ''}`;
}
function parseProfile(value: unknown, id: string): ProfileSummary {
  if (!object(value) || value.patientId !== id || !text(value.patientDisplayName, 100) || !['CHILD', 'TRANSITION', 'ADULT'].includes(String(value.lifeStage)) || !Number.isSafeInteger(value.observationsCount) || Number(value.observationsCount) < 0 || !Array.isArray(value.alerts)) throw new Error('个人档案暂不可用。');
  return { name: value.patientDisplayName, sex: ['FEMALE', 'MALE', 'INTERSEX'].includes(String(value.sex)) ? value.sex as ProfileSex : 'UNKNOWN', lifeStage: String(value.lifeStage), recordCount: Number(value.observationsCount), alertCount: value.alerts.length, ageLabel: ageLabel(value.birthDate), diagnosis: value.diseaseType === 'sJIA' ? '全身型幼年特发性关节炎（sJIA）' : value.diseaseType === 'AOSD' ? '成人 Still 病（AOSD）' : '', msScore: typeof value.msScore === 'number' && Number.isFinite(value.msScore) ? String(value.msScore) : '', msChange: text(value.msChange, 100) ? value.msChange : '', lastActive: text(value.lastActiveAt, 80) && Number.isFinite(Date.parse(value.lastActiveAt)) ? new Date(value.lastActiveAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' }) : '' };
}

/**
 * 家属端拿到的字段集合是服务端按关系裁剪过的：`registeredBy` / `updatedAt` / `updatedBy` /
 * `history` 只给医护，`notifyContacts` 对非医护强制为空。所以这里按裁剪后的形状严格校验，
 * 出现医护专属字段说明契约被破坏，宁可报错也不静默接受。
 */
const ALLOWED_FIELDS = ['patientId', 'status', 'registeredAt', 'reversibleUntil', 'recordRetention', 'familyConsentRef', 'familyAccessedAt', 'deletionRequestedAt', 'deleteAfter', 'version', 'notifyContacts'];
const CLINICIAN_ONLY_FIELDS = ['registeredBy', 'updatedAt', 'updatedBy', 'history'];
const STATUSES: LifecycleStatus[] = ['ACTIVE', 'DECEASED', 'MEMORIAL', 'DELETED_REQUESTED', 'DELETED'];

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function text(value: unknown, max = 500): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\0\r\n]/.test(value);
}
function instant(value: unknown): value is string {
  return text(value, 80) && Number.isFinite(Date.parse(value));
}
function only(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}
function scope(): Scope | null {
  const current = session();
  const id = patientId();
  return current && id ? { userId: current.userId, actorId: current.actorId, patientId: id } : null;
}
function sameScope(value: Scope): boolean {
  const current = scope();
  return Boolean(current && current.userId === value.userId && current.actorId === value.actorId && current.patientId === value.patientId);
}
function newKey(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}
function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
}
function currentRoleLabel(): string {
  const current = session();
  return current ? `${roleLabel(current.role)} · 按授权范围可见` : '尚未绑定患者档案';
}

function parseLifecycle(value: unknown, id: string): Lifecycle {
  if (!object(value) || !only(value, ALLOWED_FIELDS) || value.patientId !== id || !STATUSES.includes(value.status as LifecycleStatus)) throw new ApiFailure('档案状态响应无效，请稍后重试。', 0);
  if (CLINICIAN_ONLY_FIELDS.some(field => field in value)) throw new ApiFailure('档案状态响应无效，请稍后重试。', 0);
  if (!Array.isArray(value.notifyContacts) || value.notifyContacts.length > 0) throw new ApiFailure('档案状态响应无效，请稍后重试。', 0);
  if (typeof value.version !== 'number' || !Number.isSafeInteger(value.version) || value.version < 0) throw new ApiFailure('档案状态响应无效，请稍后重试。', 0);
  for (const field of ['registeredAt', 'reversibleUntil', 'familyAccessedAt', 'deletionRequestedAt', 'deleteAfter']) {
    if (value[field] !== undefined && !instant(value[field])) throw new ApiFailure('档案状态响应无效，请稍后重试。', 0);
  }
  if (value.recordRetention !== undefined && !['MEMORIAL', 'CLINICAL_WITH_CONSENT', 'FULL_DELETE'].includes(String(value.recordRetention))) throw new ApiFailure('档案状态响应无效，请稍后重试。', 0);
  if (value.familyConsentRef !== undefined && !text(value.familyConsentRef, 500)) throw new ApiFailure('档案状态响应无效，请稍后重试。', 0);
  return {
    patientId: id,
    status: value.status as LifecycleStatus,
    version: value.version,
    ...(value.registeredAt === undefined ? {} : { registeredAt: value.registeredAt as string }),
    ...(value.reversibleUntil === undefined ? {} : { reversibleUntil: value.reversibleUntil as string }),
    ...(value.recordRetention === undefined ? {} : { recordRetention: value.recordRetention as Lifecycle['recordRetention'] }),
    ...(value.deletionRequestedAt === undefined ? {} : { deletionRequestedAt: value.deletionRequestedAt as string }),
    ...(value.deleteAfter === undefined ? {} : { deleteAfter: value.deleteAfter as string }),
  };
}

/** 每个状态能给家属看什么、能做什么。文案按规格逐字取用，不自行润色。 */
function describe(value: Lifecycle): { sections: Section[]; canMemorial: boolean; canDelete: boolean; canCancel: boolean; note: string } {
  const sections: Section[] = [];
  if (value.registeredAt) sections.push({ title: '档案状态', body: `已登记日期：${formatDate(value.registeredAt)}。所有提醒、告警和随访计划都已停止。` });
  if (value.recordRetention === 'MEMORIAL') sections.push({ title: '档案保留方式', body: '记录会保留，你随时可以回来看。不会有人再看到它，也不会用于任何统计或研究。' });
  if (value.recordRetention === 'FULL_DELETE') sections.push({ title: '档案保留方式', body: '已选择删除全部记录。' });
  if (value.status === 'DELETED_REQUESTED') {
    sections.push({ title: '删除申请已提交', body: value.deleteAfter ? `记录会在 ${formatDate(value.deleteAfter)} 之后删除。在此之前可以撤回。` : '记录会在冷静期结束后删除。在此之前可以撤回。' });
  }
  if (value.status === 'MEMORIAL') sections.push({ title: '纪念档案', body: '这里只读，不会被任何人看到。' });
  return {
    sections,
    canMemorial: value.status === 'ACTIVE' || value.status === 'DECEASED' || value.status === 'DELETED_REQUESTED',
    // 只有已登记离世或纪念档案可以申请删除（服务端 STATE_CONFLICT 硬约束）。
    canDelete: value.status === 'DECEASED' || value.status === 'MEMORIAL',
    canCancel: value.status === 'DELETED_REQUESTED',
    note: value.status === 'DELETED_REQUESTED' ? '' : '这两件事都不需要你现在决定。',
  };
}

Page({
  data: {
    loading: true,
    saving: false,
    error: '',
    notice: '',
    scopeKey: '',
    lifecycle: null as Lifecycle | null,
    sections: [] as Section[],
    note: '',
    canMemorial: false,
    canDelete: false,
    canCancel: false,
    moreExpanded: false,
    profileAgeLabel: '', profileDiagnosis: '', profileMsScore: '', profileMsChange: '', profileLastActive: '', notificationCount: 0,
    profileInitial: '我',
    profileName: '我的健康档案',
    profileSubtitle: '患者本人 · 仅当前微信身份可见',
    profileId: '—',
    profileStatus: '已绑定档案',
    profileRecordCount: '—',
    profileAlertCount: '—',
    profileStage: '待读取',
    profileSexLabel: '未登记',
    profileLoading: true,
    profileNotice: '',
    profileGroups: [] as ProfileGroup[],
    /**
     * 「如果孩子不在了」这一段默认不展开。灰色按钮是一道缓冲：家属每次进这一页
     * 不该被动读一遍这句话，但入口必须找得到 —— 所以是收起，不是隐藏或删除。
     * 收起时也**不隐藏任何可用动作的永久入口**：撤回删除申请始终可见
     * （那是把已有申请收回，属于「少做一件事」，不该再被门槛挡一层）。
     */
    showingChoices: false,
    /** 全部删除需要二次确认；先展开说明再提交，不在一次点击里完成。 */
    confirmingDelete: false,
    pendingText: '',
  },
  pending: null as { kind: ResponseKind; body: Record<string, unknown> } | null,
  profileGeneration: 0,

  onLoad() { this.onShow(); },
  onShow() {
    const expected = scope();
    if (!expected) {
      this.pending = null;
      this.profileGeneration += 1;
      this.setData({ scopeKey: '', loading: false, saving: false, lifecycle: null, canMemorial: false, canDelete: false, canCancel: false, error: '', profileAgeLabel: '', profileDiagnosis: '', profileMsScore: '', profileMsChange: '', profileLastActive: '', notificationCount: 0, moreExpanded: false, profileGroups: [], profileName: '我的健康档案', profileInitial: '我', profileId: '—', profileRecordCount: '—', profileAlertCount: '—', profileStage: '待读取', profileSexLabel: '未登记', profileLoading: false, profileNotice: '' });
      wx.redirectTo({ url: '/pages/auth/index' });
      return;
    }
    const key = `${expected.userId}:${expected.actorId}:${expected.patientId}`;
    if (key !== this.data.scopeKey) {
      this.pending = null;
      this.setData({ lifecycle: null, canMemorial: false, canDelete: false, canCancel: false, sections: [], error: '', notice: '', showingChoices: false, confirmingDelete: false, pendingText: '', profileAgeLabel: '', profileDiagnosis: '', profileMsScore: '', profileMsChange: '', profileLastActive: '', notificationCount: 0, moreExpanded: false, profileId: expected.patientId.slice(-8), profileName: '我的健康档案', profileInitial: '我', profileSubtitle: currentRoleLabel(), profileRecordCount: '—', profileAlertCount: '—', profileStage: '待读取', profileSexLabel: '未登记', profileGroups: [], profileNotice: '' });
    }
    this.setData({ scopeKey: key });
    void this.load(expected);
    void this.loadProfile(expected);
    void this.loadNotificationCount(expected);
  },

  async loadProfile(expected: Scope) {
    const current = session();
    if (!current || !sameScope(expected)) return;
    const generation = ++this.profileGeneration;
    this.setData({ profileLoading: true, profileNotice: '', profileSubtitle: currentRoleLabel(), profileGroups: profileGroups({ ...expected, role: current.role }, null) });
    try {
      const profile = parseProfile(await request<unknown>(`/api/v1/patients/${encodeURIComponent(expected.patientId)}/summary`), expected.patientId);
      if (!sameScope(expected) || generation !== this.profileGeneration) return;
      this.setData({ profileAgeLabel: profile.ageLabel, profileDiagnosis: profile.diagnosis, profileMsScore: profile.msScore, profileMsChange: profile.msChange, profileLastActive: profile.lastActive, profileName: profile.name, profileInitial: profile.name.slice(0, 1), profileRecordCount: String(profile.recordCount), profileAlertCount: String(profile.alertCount), profileStage: ({ CHILD: '儿童期', TRANSITION: '过渡期', ADULT: '成人期' } as Record<string, string>)[profile.lifeStage], profileSexLabel: ({ FEMALE: '女性', MALE: '男性', INTERSEX: '其他登记', UNKNOWN: '未登记' } as Record<string, string>)[profile.sex], profileGroups: profileGroups({ ...expected, role: current.role }, profile) });
    } catch (error) {
      if (!sameScope(expected) || generation !== this.profileGeneration) return;
      this.setData({ profileNotice: error instanceof Error ? error.message : '个人档案暂不可用。', profileRecordCount: '—', profileAlertCount: '—', profileStage: '待读取', profileSexLabel: '未登记' });
    } finally { if (sameScope(expected) && generation === this.profileGeneration) this.setData({ profileLoading: false }); }
  },

  toggleMore() { this.setData({ moreExpanded: !this.data.moreExpanded }); },
  async loadNotificationCount(expected: Scope) {
    this.setData({ notificationCount: 0 });
    try {
      const value = await request<unknown>('/api/v1/notifications');
      if (!sameScope(expected) || !Array.isArray(value)) return;
      const notificationCount = value.filter(item => object(item) && item.patientId === expected.patientId && item.recipientId === expected.actorId && item.deliveryState === 'SUBMITTED' && typeof item.submittedAt === 'string' && !item.confirmedAt && !item.failedAt).length;
      this.setData({ notificationCount });
    } catch { /* 首屏不冒充未读取到的通知数量。 */ }
  },
  openFeature(event: { currentTarget?: { dataset?: { key?: unknown } } }) {
    const key = event.currentTarget?.dataset?.key;
    if (typeof key !== 'string' || !PROFILE_ROUTES[key] || !this.data.profileGroups.some((group: ProfileGroup) => group.entries.some(entry => entry.key === key))) return;
    wx.navigateTo({ url: PROFILE_ROUTES[key] });
  },
  openReport() { wx.switchTab({ url: '/pages/patient/report' }); },
  openRecords() { wx.switchTab({ url: '/pages/patient/records' }); },
  openCover() { wx.reLaunch({ url: '/pages/cover/index' }); },

  async load(expected: Scope) {
    if (!sameScope(expected)) return;
    this.setData({ loading: true, error: '' });
    try {
      const value = await request<unknown>(`/api/v1/patients/${encodeURIComponent(expected.patientId)}/lifecycle`);
      if (!sameScope(expected)) return;
      this.apply(parseLifecycle(value, expected.patientId));
    } catch (error) {
      if (!sameScope(expected)) return;
      this.setData({ error: error instanceof Error ? error.message : '档案状态读取失败，请重试。' });
    } finally {
      if (sameScope(expected)) this.setData({ loading: false });
    }
  },

  apply(value: Lifecycle) {
    const described = describe(value);
    this.setData({ lifecycle: value, sections: described.sections, note: described.note, canMemorial: described.canMemorial, canDelete: described.canDelete, canCancel: described.canCancel });
  },

  /** 展开这一段。只改本机显示状态，不读服务端、不写审计 —— 收起本身不是一种处置。 */
  showChoices() { if (!this.data.showingChoices) this.setData({ showingChoices: true, error: '' }); },
  askDelete() { if (this.data.canDelete) this.setData({ confirmingDelete: true, error: '' }); },
  cancelDeleteAsk() { this.setData({ confirmingDelete: false }); },

  memorial() {
    const expected = scope();
    if (!expected || !this.data.canMemorial) return;
    void this.send('REQUEST_MEMORIAL', { expectedVersion: this.data.lifecycle?.version ?? 0, idempotencyKey: newKey('lifecycle-memorial') }, expected, '已转为纪念档案。记录会保留，你随时可以回来看。');
  },

  /** 全部删除：二次确认 + 服务端 3 天冷静期。二次确认是服务端硬约束，缺了会返回 409。 */
  requestDelete() {
    const expected = scope();
    if (!expected || !this.data.canDelete || !this.data.confirmingDelete) return;
    void this.send('REQUEST_DELETE', { expectedVersion: this.data.lifecycle?.version ?? 0, idempotencyKey: newKey('lifecycle-delete'), secondConfirmation: true }, expected, '删除申请已提交，冷静期内可以撤回。').then(() => {
      if (sameScope(expected)) this.setData({ confirmingDelete: false });
    });
  },

  cancelDelete() {
    const expected = scope();
    if (!expected || !this.data.canCancel) return;
    void this.send('CANCEL_DELETE', { expectedVersion: this.data.lifecycle?.version ?? 0, idempotencyKey: newKey('lifecycle-cancel') }, expected, '已撤回删除申请。');
  },

  /**
   * 未知结果只重放同一份命令：刷新后的新版本、新勾选都不能改写原命令，
   * 否则「重试」会变成一次内容不同的新写入。服务端给出明确结论（4xx，非超时/限频）才丢弃。
   */
  async send(kind: ResponseKind, body: Record<string, unknown>, expected: Scope, notice: string) {
    if (!sameScope(expected) || this.data.saving) return;
    const command = this.pending ?? { kind, body };
    this.pending = command;
    this.setData({ saving: true, error: '', notice: '', pendingText: pendingTextOf(command.kind) });
    try {
      await request<unknown>(`/api/v1/patients/${encodeURIComponent(expected.patientId)}/lifecycle`, 'POST', { ...command.body, action: command.kind });
      if (!sameScope(expected)) return;
      this.pending = null;
      this.setData({ pendingText: '', notice });
      await this.load(expected);
    } catch (error) {
      if (!sameScope(expected)) return;
      const status = error instanceof ApiFailure ? error.status : 0;
      const code = error instanceof ApiFailure ? error.code : undefined;
      this.setData({ error: messageFor(code, error) });
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) { this.pending = null; this.setData({ pendingText: '' }); }
      // 版本冲突说明别处已改过这一份档案，必须重新读取再决定，不能靠重试猜。
      if (code === 'PATIENT_LIFECYCLE_VERSION_CONFLICT' || code === 'IDEMPOTENCY_CONFLICT') await this.load(expected);
      if (status === 401) wx.redirectTo({ url: '/pages/auth/index' });
    } finally {
      if (sameScope(expected)) this.setData({ saving: false });
    }
  },

  retry() {
    const expected = scope();
    const command = this.pending;
    if (!expected || !command) return;
    void this.send(command.kind, command.body, expected, '原操作已重试。');
  },
  refresh() { const expected = scope(); if (expected) { void this.load(expected); void this.loadProfile(expected); } },
});

function pendingTextOf(kind: ResponseKind): string {
  return ({ REQUEST_MEMORIAL: '待确认：转为纪念档案。', REQUEST_DELETE: '待确认：申请删除全部记录。', CANCEL_DELETE: '待确认：撤回删除申请。' } as Record<ResponseKind, string>)[kind];
}
/** 服务端的明确结论要翻译成人话；不确定的一律按「未确认」处理。 */
function messageFor(code: string | undefined, error: unknown): string {
  if (code === 'PATIENT_LIFECYCLE_VERSION_CONFLICT') return '档案状态已变化，已为你重新读取，请确认后再操作。';
  if (code === 'PATIENT_LIFECYCLE_CONFIRMATION_REQUIRED') return '删除全部记录需要先展开确认。';
  if (code === 'PATIENT_LIFECYCLE_STATE_CONFLICT') return '当前状态不能执行这个操作，已为你重新读取。';
  if (code === 'PATIENT_LIFECYCLE_NOT_READY') return '这项处置尚未开通，请联系医生。';
  if (code === 'FORBIDDEN') return '当前身份不能处置这份档案。';
  return error instanceof Error ? error.message : '操作未确认，原操作已保留，请重试。';
}

export { parseLifecycle, describe };
