import { ApiFailure, patientId, session } from '../../api';
import { issueCareInvite, loadCareInvites, removeInvitedClinician, revokeCareInvite, type CareInviteOverview, type IssuedCareInvite } from '../../care-invite';
import { featureScopeKey, recordUnavailable, roleAllows, unavailableReason } from '../../feature-gate';

interface Scope { userId: string; actorId: string; patientId: string; }
interface IssuedView { inviteId: string; code: string; expiresText: string; script: string; }
interface InvitedRow { inviteId: string; label: string; joinedText: string; active: boolean; removedText: string; }

const ISSUER_NOT_ALLOWED = 'CARE_INVITE_ISSUER_NOT_ALLOWED';
// 服务端连列表读取都要求签发资格：非签发身份什么都看不到，不能写「只能查看」，也不能显示两张空列表。
const ROLE_DENIED = '只有患者本人或法定监护人可以查看和管理邀请；当前身份不能查看或管理邀请。';
const ISSUER_DENIED = '当前身份不能查看或管理邀请：未成年患者请由法定监护人操作；成年患者的监护人需在代理生效后才能操作。';
const ISSUER_READ_ONLY = '当前身份不能邀请医生：未成年患者请由法定监护人操作；成年患者的监护人需在代理生效后才能操作。';
const ISSUE_UNCERTAIN = '网络中断，未确认是否已生成；重新生成会作废之前未使用的码。';

function scopeNow(): Scope | null { const current = session(); const id = patientId(); return current && id ? { userId: current.userId, actorId: current.actorId, patientId: id } : null; }
function sameScope(scope: Scope): boolean { const latest = scopeNow(); return Boolean(latest && featureScopeKey(latest) === featureScopeKey(scope)); }
function pad(value: number): string { return String(value).padStart(2, '0'); }
/** 医生和患者都按北京时间约定「几点前有效」，不随手机时区漂移。 */
function beijingTime(value: string): string {
  const at = new Date(Date.parse(value) + 8 * 3600_000);
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
}
function issuedView(value: IssuedCareInvite): IssuedView {
  return { inviteId: value.inviteId, code: value.code, expiresText: `${beijingTime(value.expiresAt)} 前有效（${value.ttlHours} 小时内、只能使用一次）`, script: value.script };
}
function invitedRows(value: CareInviteOverview): InvitedRow[] {
  return value.invited.map(item => ({ inviteId: item.inviteId, label: item.clinicianLabel, joinedText: `${beijingTime(item.acceptedAt)} 加入`, active: item.active, removedText: item.removedAt ? `已于 ${beijingTime(item.removedAt)} 移除` : item.active ? '' : '已不在照护团队' }));
}
function businessFailure(error: unknown): error is ApiFailure { return error instanceof ApiFailure && typeof error.code === 'string' && (error.code.startsWith('CARE_INVITE_') || error.code === 'RATE_LIMITED'); }
/** CARE_INVITE_* 是「本功能现在不可用」，在页面里说明；只有其它 401/403 才代表临床访问范围失效。 */
function businessMessage(error: ApiFailure): string {
  if (error.code === 'CARE_INVITE_NO_ORGANIZATION') return '患者还没有关联照护科室，暂时不能邀请医生。请先联系主管医生或科室。';
  if (error.code === 'CARE_INVITE_PATIENT_INACTIVE') return '当前档案状态不允许邀请或接受医生。';
  if (error.code === 'CARE_INVITE_NOT_FOUND') return '这条邀请记录已不存在，列表已刷新。';
  if (error.code === 'CARE_INVITE_CLOSED') return '这张邀请码已被使用或已作废，无需再作废。';
  if (error.code === 'CARE_INVITE_CODE_UNAVAILABLE') return '暂时没能生成邀请码，请稍后再试。';
  if (error.code === 'RATE_LIMITED') {
    const seconds = error.details?.retryAfterSeconds;
    const minutes = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / 60) : 0;
    return minutes ? `生成太频繁了，请约 ${minutes} 分钟后再试。` : '生成太频繁了，请稍后再试。';
  }
  return error.message || '操作未完成，请稍后再试。';
}

Page({
  data: {
    loading: true, error: '', notice: '', scopeKey: '',
    canIssue: false, denied: false, roleDenied: false, readOnlyReason: '', readError: false, issuing: false, uncertain: '', confirmingIssue: false,
    issued: null as IssuedView | null,
    pending: null as { inviteId: string; expiresText: string } | null,
    invited: [] as InvitedRow[], policyText: '', busyId: '', confirmingRemoveId: '',
  },
  loadVersion: 0,

  onLoad() { this.onShow(); },
  onShow() {
    const current = session();
    if (!current) { this.clearSensitiveState(''); this.setData({ scopeKey: '' }); wx.redirectTo({ url: '/pages/auth/index' }); return; }
    const scope = scopeNow();
    if (!scope) { this.clearSensitiveState('当前微信身份尚未绑定患者档案。'); this.setData({ scopeKey: '' }); return; }
    const key = featureScopeKey(scope);
    // 明文码只属于生成它的那个身份：身份一变立刻清掉，不能被下一个身份看到。
    if (key !== this.data.scopeKey) { this.clearSensitiveState(''); this.setData({ scopeKey: key, uncertain: '', notice: '', ...this.permission(scope) }); this.load(scope); return; }
    // 用户常切到微信聊天把码发给医生、等医生用完再回来：屏幕上有码或待使用记录时重读一次，
    // 否则已被接受或已过期的码还挂在屏幕上，患者会误以为医生没收到而去重新生成或作废。
    if (!this.data.loading && !this.data.denied && (this.data.issued || this.data.pending)) this.load(scope);
  },
  // 不在 onHide 清明文码：用户要切到微信聊天里粘贴给医生，回来还要能看到。
  onUnload() { this.loadVersion += 1; this.setData({ issued: null }); },

  /**
   * 角色不是本人 / 法定监护人时服务端必然拒绝读取，直接判为看不到、不再发请求；
   * 回执只说明「不能签发」，能不能看列表仍以本次读取结果为准（见 markIssuerDenied）。
   */
  permission(scope: Scope): { canIssue: boolean; readOnlyReason: string; denied: boolean; roleDenied: boolean } {
    const current = session();
    if (!current || !roleAllows('CARE_INVITE_ISSUE', current.role)) return { canIssue: false, denied: true, roleDenied: true, readOnlyReason: ROLE_DENIED };
    return unavailableReason(featureScopeKey(scope), 'CARE_INVITE_ISSUE')
      ? { canIssue: false, denied: false, roleDenied: false, readOnlyReason: ISSUER_READ_ONLY }
      : { canIssue: true, denied: false, roleDenied: false, readOnlyReason: '' };
  },
  /** readError: 本次读取没有成功，两张列表是空的但不能说「没有」。 */
  clearSensitiveState(message: string, readError = false) {
    this.loadVersion += 1;
    this.setData({ issued: null, pending: null, invited: [], policyText: '', busyId: '', confirmingRemoveId: '', confirmingIssue: false, issuing: false, loading: false, readError, error: message, ...this.barePermission() });
  },
  /** 只按当前 role 算的权限，用于清屏时同步按钮状态，不读服务端回执。 */
  barePermission(): { roleDenied: boolean } {
    const current = session();
    return { roleDenied: !current || !roleAllows('CARE_INVITE_ISSUE', current.role) };
  },

  load(expected: Scope | null = scopeNow()) {
    if (!expected || !sameScope(expected)) return;
    if (this.permission(expected).denied) { this.loadVersion += 1; this.setData({ loading: false, ...this.permission(expected) }); return; }
    const version = ++this.loadVersion;
    this.setData({ loading: true });
    loadCareInvites(expected.patientId).then(overview => {
      if (version !== this.loadVersion || !sameScope(expected)) return;
      const issued = this.data.issued as IssuedView | null;
      // 屏幕上的码已不是待使用的那张：被医生用掉了，或已过期 / 作废。拿掉它，免得患者再去转发一张废码。
      const consumed = issued && overview.pending?.inviteId !== issued.inviteId
        ? { issued: null, confirmingIssue: false, notice: overview.invited.some(item => item.inviteId === issued.inviteId) ? '医生已用这张邀请码加入照护团队，邀请码已失效。' : '这张邀请码已过期或已作废，已从屏幕上移除。' }
        : {};
      this.setData({
        ...consumed,
        denied: false,
        readError: false,
        error: '',
        pending: overview.pending ? { inviteId: overview.pending.inviteId, expiresText: `${beijingTime(overview.pending.expiresAt)} 前有效` } : null,
        invited: invitedRows(overview),
        policyText: `邀请码 ${overview.policy.ttlHours} 小时内有效、只能使用一次；每小时最多生成 ${overview.policy.maxIssuesPerHour} 次。`,
        // 只读说明由 permission() 从粘性回执里重算，列表刷新不会把按钮放回来。
        ...this.permission(expected),
      });
    }).catch(error => { if (version === this.loadVersion) this.fail(error, expected, 'load'); })
      .finally(() => { if (version === this.loadVersion && sameScope(expected)) this.setData({ loading: false }); });
  },

  fail(error: unknown, scope: Scope, source: 'load' | 'issue' | 'action') {
    if (!sameScope(scope)) return;
    if (error instanceof ApiFailure && error.code === ISSUER_NOT_ALLOWED) { this.markIssuerDenied(scope, error, source === 'load'); return; }
    if (businessFailure(error)) { this.setData({ error: businessMessage(error), issuing: false }); return; }
    if (error instanceof ApiFailure && [401, 403].includes(error.status)) {
      // 会话已死的 401/403 由 api.ts 统一清会话并回登录页，这里剩下的都是会话仍在、
      // 但这次请求不被允许：如实说「这次没读到」，留住刷新这条路，不能渲染成空列表。
      this.clearSensitiveState('当前身份暂时读不到邀请记录，内容已清除；可以稍后点「刷新」重试。', true);
      return;
    }
    if (source === 'issue' && error instanceof ApiFailure && error.status === 0) { this.setData({ uncertain: ISSUE_UNCERTAIN, error: '' }); return; }
    this.setData({ error: error instanceof Error ? error.message : '邀请记录暂时读不出来，请稍后刷新。' });
  },
  /**
   * 未成年本人在会话里也是 PATIENT，客户端放出的按钮要由服务端裁决。先把回执记成粘性标志
   * （首页、照护页据此收起入口）。签发 / 操作被拒时再刷新列表、最后置只读 —— 刷新回来时
   * permission() 已经看得到标志，不会把只读说明抹掉；刷新本身若也被拒，就落到读取被拒的分支。
   */
  markIssuerDenied(scope: Scope, error: ApiFailure, fromLoad: boolean) {
    recordUnavailable(featureScopeKey(scope), 'CARE_INVITE_ISSUE', error);
    // 读取被拒说明这个身份什么都看不到：收起两张列表，不能留下「没有邀请码」「没有医生」这种不实的空状态。
    if (fromLoad) {
      this.loadVersion += 1;
      this.setData({ canIssue: false, denied: true, roleDenied: false, readOnlyReason: ISSUER_DENIED, issued: null, pending: null, invited: [], policyText: '', busyId: '', confirmingRemoveId: '', confirmingIssue: false, issuing: false, uncertain: '', error: '', loading: false, readError: false });
      return;
    }
    this.load(scope);
    this.setData({ ...this.permission(scope), issued: null, confirmingIssue: false, issuing: false, uncertain: '', error: '' });
  },

  /** 调用方已确认 wx.showModal 可用；没有系统确认框时各自退回页面内两步确认。 */
  confirm(title: string, content: string, confirmText: string): Promise<boolean> {
    if (typeof wx.showModal !== 'function') return Promise.resolve(false);
    return new Promise(resolve => wx.showModal({ title, content, confirmText, cancelText: '先不', success: result => resolve(result.confirm), fail: () => resolve(false) }));
  },
  async issue() {
    if (!this.data.canIssue || this.data.issuing) return;
    const scope = scopeNow(); if (!scope || featureScopeKey(scope) !== this.data.scopeKey) return;
    if (this.data.pending || this.data.uncertain || this.data.issued) {
      // 没有系统确认框时退回页面内两步确认：作废旧码不可撤回，不能一点就生成。
      if (typeof wx.showModal !== 'function') { this.setData({ confirmingIssue: true }); return; }
      if (!(await this.confirm('生成新的邀请码', '生成新码会作废尚未使用的旧码。旧码如果已经发给医生，医生将无法再用它加入。', '生成新码'))) return;
    }
    await this.sendIssue(scope);
  },
  confirmIssue() {
    if (!this.data.confirmingIssue) return undefined;
    this.setData({ confirmingIssue: false });
    const scope = scopeNow(); if (!scope || featureScopeKey(scope) !== this.data.scopeKey) return undefined;
    return this.sendIssue(scope);
  },
  cancelIssue() { this.setData({ confirmingIssue: false }); },
  async sendIssue(scope: Scope) {
    if (!this.data.canIssue || !sameScope(scope) || this.data.issuing) return;
    // 旧码马上会被作废，先从屏幕上拿掉，避免用户复制到一张已失效的码。
    this.setData({ issuing: true, issued: null, uncertain: '', error: '', notice: '' });
    try {
      const issued = await issueCareInvite(scope.patientId);
      if (!sameScope(scope)) return;
      this.setData({ issued: issuedView(issued), issuing: false, notice: issued.supersededCount > 0 ? '之前未使用的邀请码已作废。' : '' });
      this.load(scope);
    } catch (error) {
      this.fail(error, scope, 'issue');
    } finally {
      if (sameScope(scope)) this.setData({ issuing: false });
    }
  },
  copyCode() {
    const issued = this.data.issued as IssuedView | null; if (!issued) return;
    if (typeof wx.setClipboardData !== 'function') { this.setData({ notice: '当前微信版本不支持一键复制，请长按邀请码手动复制。' }); return; }
    wx.setClipboardData({ data: issued.code, success: () => wx.showToast({ title: '已复制邀请码', icon: 'success' }), fail: () => this.setData({ notice: '复制失败，请长按邀请码手动复制。' }) });
  },
  async revoke(event: { currentTarget?: { dataset?: { id?: unknown } } }) {
    const inviteId = event.currentTarget?.dataset?.id; const scope = scopeNow();
    if (typeof inviteId !== 'string' || !inviteId || !scope || !this.data.canIssue || this.data.busyId) return;
    if (typeof wx.showModal === 'function') {
      const confirmed = await this.confirm('作废这张邀请码', '作废后，尚未使用的这张邀请码不能再加入医生。已经加入的医生不受影响。', '作废邀请码');
      if (!confirmed || !sameScope(scope)) return;
    }
    this.setData({ busyId: inviteId, error: '', notice: '' });
    try {
      await revokeCareInvite(scope.patientId, inviteId);
      if (!sameScope(scope)) return;
      const issued = this.data.issued as IssuedView | null;
      this.setData({ notice: '邀请码已作废，医生无法再用它加入。', ...(issued?.inviteId === inviteId ? { issued: null } : {}) });
      this.load(scope);
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 0 && sameScope(scope)) this.setData({ error: '网络中断，未确认是否已作废，请刷新后核对。' });
      else { this.fail(error, scope, 'action'); if (businessFailure(error)) this.load(scope); }
    } finally {
      if (sameScope(scope)) this.setData({ busyId: '' });
    }
  },
  async remove(event: { currentTarget?: { dataset?: { id?: unknown } } }) {
    const inviteId = event.currentTarget?.dataset?.id;
    if (typeof inviteId !== 'string' || !inviteId || !this.data.canIssue || this.data.busyId) return;
    // 没有系统确认框时退回页面内两步确认，不能一点就移除。
    if (typeof wx.showModal !== 'function') { this.setData({ confirmingRemoveId: inviteId }); return; }
    if (!(await this.confirm('移除这位医生', '移除后，这位医生从下一次操作起不能再查看或处理该患者的信息。科室安排的医生不受影响。', '移除'))) return;
    await this.sendRemove(inviteId);
  },
  confirmRemove() { const inviteId = this.data.confirmingRemoveId as string; if (inviteId) void this.sendRemove(inviteId); },
  cancelRemove() { this.setData({ confirmingRemoveId: '' }); },
  async sendRemove(inviteId: string) {
    const scope = scopeNow(); if (!scope || featureScopeKey(scope) !== this.data.scopeKey || this.data.busyId) return;
    this.setData({ busyId: inviteId, confirmingRemoveId: '', error: '', notice: '' });
    try {
      await removeInvitedClinician(scope.patientId, inviteId);
      if (!sameScope(scope)) return;
      this.setData({ notice: '已移除。这位医生从下一次操作起不能再查看该患者。' });
      this.load(scope);
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 0 && sameScope(scope)) this.setData({ error: '网络中断，未确认是否已移除，请刷新后核对；再点一次移除不会重复操作。' });
      else { this.fail(error, scope, 'action'); if (businessFailure(error)) this.load(scope); }
    } finally {
      if (sameScope(scope)) this.setData({ busyId: '' });
    }
  },
  refresh() { this.setData({ error: '' }); this.load(scopeNow()); },
});
