import { ApiFailure, patientId, request, session } from '../../api';
import { MutationOutbox, deniedOperations, newIdempotencyKey, wxStorage, type MutationEntry } from '../../mutation-outbox';

type Stiffness = 0 | 15 | 30 | 60;
type Activity = 'FULL' | 'LIMITED' | 'SEVERE';
type Respondent = 'PATIENT' | 'CAREGIVER';
interface JointAssessment { id: string; patientId: string; observedAt: string; morningStiffnessMinutes: Stiffness; painNrs: number; activityLevel: Activity; respondent: Respondent; }
interface Scope { userId: string; actorId: string; patientId: string; }

const STIFFNESS_VALUES: Stiffness[] = [0, 15, 30, 60];
const ACTIVITY_VALUES: Activity[] = ['FULL', 'LIMITED', 'SEVERE'];

function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function text(value: unknown, max = 256): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\0\r\n]/.test(value); }
function instant(value: unknown): value is string { return text(value, 80) && Number.isFinite(Date.parse(value)) && Date.parse(value) <= Date.now(); }
function only(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).every(key => keys.includes(key)); }
function currentScope(): Scope | null { const current = session(); const id = patientId(); return current && id ? { userId: current.userId, actorId: current.actorId, patientId: id } : null; }
function scopeKey(scope: Scope | null): string { return scope ? `${scope.userId}:${scope.actorId}:${scope.patientId}` : ''; }
function sameScope(scope: Scope): boolean { const latest = currentScope(); return Boolean(latest && latest.userId === scope.userId && latest.actorId === scope.actorId && latest.patientId === scope.patientId); }
// 关节记录服务端要求 G3_FULL；配偶/代理当前仅有 G2 摘要权限，不能在 UI 中显示一个必然 403 的写入表单。
function canWrite(role: string): boolean { return ['PATIENT', 'LEGAL_GUARDIAN', 'CAREGIVER'].includes(role); }
function localDate(value = new Date()): string { return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`; }
function observedAtForDate(value: string): string { return value === localDate() ? new Date().toISOString() : new Date(`${value}T12:00:00.000+08:00`).toISOString(); }
function respondentForRole(role: string): Respondent { return role === 'PATIENT' ? 'PATIENT' : 'CAREGIVER'; }
function describeError(error: unknown, fallback: string): string { return error instanceof Error ? error.message : fallback; }

function parseAssessment(value: unknown, patient: string): JointAssessment {
  if (!object(value) || !only(value, ['id', 'patientId', 'observedAt', 'morningStiffnessMinutes', 'painNrs', 'activityLevel', 'respondent']) || value.patientId !== patient || !text(value.id) || !instant(value.observedAt) || !STIFFNESS_VALUES.includes(value.morningStiffnessMinutes as Stiffness) || !Number.isSafeInteger(value.painNrs) || Number(value.painNrs) < 0 || Number(value.painNrs) > 10 || !ACTIVITY_VALUES.includes(value.activityLevel as Activity) || !['PATIENT', 'CAREGIVER'].includes(String(value.respondent))) throw new Error('关节速记回执格式无效，这条已留在本机，可以直接重试。');
  return { id: value.id, patientId: patient, observedAt: value.observedAt, morningStiffnessMinutes: value.morningStiffnessMinutes as Stiffness, painNrs: value.painNrs as number, activityLevel: value.activityLevel as Activity, respondent: value.respondent as Respondent };
}

function parseSnapshot(value: unknown, patient: string): JointAssessment[] {
  if (!object(value) || !only(value, ['patientId', 'assessments']) || value.patientId !== patient || !Array.isArray(value.assessments) || value.assessments.length > 100) throw new Error('关节速记响应格式无效，未更新当前记录。');
  return value.assessments.map(item => parseAssessment(item, patient));
}

Page({
  data: {
    loading: true,
    saving: false,
    error: '',
    message: '',
    scopeKey: '',
    role: '',
    canWrite: false,
    assessments: [] as JointAssessment[],
    observedDate: localDate(),
    today: localDate(),
    stiffness: 0 as Stiffness,
    painNrs: 0,
    activityLevel: 'FULL' as Activity,
    stiffnessOptions: [{ value: 0, label: '没有' }, { value: 15, label: '15 分钟' }, { value: 30, label: '30 分钟' }, { value: 60, label: '1 小时以上' }] as Array<{ value: Stiffness; label: string }>,
    activityOptions: [{ value: 'FULL', label: '基本都能做' }, { value: 'LIMITED', label: '有些事情费劲' }, { value: 'SEVERE', label: '很多事情做不了' }] as Array<{ value: Activity; label: string }>,
    pendingCount: 0,
    rejectedCount: 0,
  },
  outbox: null as MutationOutbox | null,
  scope: null as Scope | null,

  onLoad() { this.onShow(); },

  onShow() {
    const current = session();
    if (!current) {
      // redirectTo 不是同步操作；在跳转完成前先清掉旧患者的敏感记录和本地队列引用。
      this.scope = null;
      this.outbox = null;
      this.setData({ loading: false, saving: false, error: '', message: '', scopeKey: '', role: '', canWrite: false, assessments: [], pendingCount: 0, rejectedCount: 0 });
      wx.redirectTo({ url: '/pages/auth/index' });
      return;
    }
    const scope = currentScope();
    if (!scope) { this.setData({ loading: false, error: '当前微信身份尚未绑定患者档案。' }); return; }
    const key = scopeKey(scope);
    if (key !== this.data.scopeKey) {
      const outbox = new MutationOutbox(wxStorage(), scope.actorId, scope.patientId, scope.userId);
      this.scope = scope;
      this.outbox = outbox;
      this.setData({ scopeKey: key, role: current.role, canWrite: canWrite(current.role), assessments: [], observedDate: localDate(), today: localDate(), stiffness: 0, painNrs: 0, activityLevel: 'FULL', error: '', message: '' });
      this.refreshQueue();
      this.load(scope);
    }
  },

  refreshQueue() {
    try {
      const entries: MutationEntry[] = this.outbox?.entries().filter((entry: MutationEntry) => entry.operation === 'JOINT_ASSESSMENT') ?? [];
      this.setData({ pendingCount: entries.filter(entry => entry.state === 'PENDING').length, rejectedCount: entries.filter(entry => entry.state === 'REJECTED').length });
    } catch (error) { this.setData({ error: describeError(error, '本机待提交记录不可读。') }); }
  },

  load(expectedScope?: Scope | null) {
    const scope = expectedScope ?? this.scope ?? currentScope();
    if (!scope || !sameScope(scope)) { this.setData({ loading: false, error: '身份已切换，请返回首页后重新打开。' }); return; }
    this.setData({ loading: true, error: '' });
    request<unknown>(`/api/v1/patients/${encodeURIComponent(scope.patientId)}/joint-assessments`).then(value => {
      if (!sameScope(scope)) throw new ApiFailure('身份已切换，请刷新当前页面。', 409);
      this.setData({ assessments: parseSnapshot(value, scope.patientId) });
    }).catch(error => { if (sameScope(scope)) this.setData({ error: describeError(error, '关节速记暂不可见。'), assessments: [] }); }).finally(() => { if (sameScope(scope)) this.setData({ loading: false }); });
  },

  dateChange(event: { detail?: { value?: string } }) { const value = event.detail?.value; if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value <= (this.data.today as string)) this.setData({ observedDate: value, error: '' }); },
  stiffnessChange(event: { detail?: { value?: unknown } }) { const value = Number(event.detail?.value); if (STIFFNESS_VALUES.includes(value as Stiffness)) this.setData({ stiffness: value as Stiffness, error: '' }); },
  painChange(event: { detail?: { value?: unknown } }) { const value = Number(event.detail?.value); if (Number.isSafeInteger(value) && value >= 0 && value <= 10) this.setData({ painNrs: value, error: '' }); },
  activityChange(event: { detail?: { value?: unknown } }) { const value = event.detail?.value; if (ACTIVITY_VALUES.includes(value as Activity)) this.setData({ activityLevel: value as Activity, error: '' }); },

  async save() {
    if (this.data.saving || !this.data.canWrite) return;
    const scope = this.scope;
    const outbox = this.outbox;
    const observedDate = String(this.data.observedDate ?? '');
    const stiffness = Number(this.data.stiffness);
    const painNrs = Number(this.data.painNrs);
    const activityLevel = this.data.activityLevel as Activity;
    if (!scope || !outbox || !sameScope(scope)) { this.setData({ error: '身份已切换，请返回首页后重新打开。' }); return; }
    const dateValue = Date.parse(`${observedDate}T12:00:00.000+08:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(observedDate) || observedDate > (this.data.today as string) || !Number.isFinite(dateValue) || !STIFFNESS_VALUES.includes(stiffness as Stiffness) || !Number.isSafeInteger(painNrs) || painNrs < 0 || painNrs > 10 || !ACTIVITY_VALUES.includes(activityLevel)) { this.setData({ error: '请填写有效的关节速记内容。' }); return; }
    const payload: Record<string, unknown> = { observedAt: observedAtForDate(observedDate), morningStiffnessMinutes: stiffness, painNrs, activityLevel, respondent: respondentForRole(this.data.role as string), idempotencyKey: '' };
    let previous: MutationEntry | undefined;
    try { previous = outbox.entries().find((entry: MutationEntry) => entry.operation === 'JOINT_ASSESSMENT' && entry.payload.observedAt === payload.observedAt && entry.payload.morningStiffnessMinutes === stiffness && entry.payload.painNrs === painNrs && entry.payload.activityLevel === activityLevel && entry.payload.respondent === payload.respondent); }
    catch (error) { this.setData({ error: describeError(error, '本机待提交记录不可读，未覆盖原有操作。') }); return; }
    payload.idempotencyKey = previous?.idempotencyKey ?? newIdempotencyKey('JOINT_ASSESSMENT');
    try { outbox.enqueue({ operation: 'JOINT_ASSESSMENT', idempotencyKey: payload.idempotencyKey as string, payload }); }
    catch (error) { this.setData({ error: describeError(error, '关节速记未保存。') }); return; }
    await this.flush(scope);
  },

  async sendEntry(entry: MutationEntry, scope: Scope): Promise<void> {
    if (entry.operation !== 'JOINT_ASSESSMENT') return;
    if (!sameScope(scope)) throw new ApiFailure('身份已切换，请刷新当前页面。', 409);
    const value = await request<unknown>(`/api/v1/patients/${encodeURIComponent(scope.patientId)}/joint-assessments`, 'POST', entry.payload);
    try { parseAssessment(value, scope.patientId); }
    catch (error) { throw new ApiFailure(error instanceof Error ? error.message : '关节速记回执不完整，这条已留在本机，可以直接重试。', 200); }
    if (!sameScope(scope)) throw new ApiFailure('身份已切换，请刷新当前页面。', 409);
  },

  async flush(expectedScope?: Scope | null, retryRejected = true) {
    const scope = expectedScope ?? this.scope ?? currentScope();
    const outbox = this.outbox;
    if (!outbox || !scope || !sameScope(scope) || this.data.saving) return;
    this.setData({ saving: true, error: '', message: '' });
    try {
      const result = await outbox.flush((entry: MutationEntry) => this.sendEntry(entry, scope), retryRejected, ['JOINT_ASSESSMENT']);
      if (result.denied) { try { outbox.clear(deniedOperations(['JOINT_ASSESSMENT'], Boolean(session()))); } catch { /* 保留当前错误 */ } this.setData({ error: '当前身份无权提交关节速记，待确认内容已清理。' }); this.refreshQueue(); return; }
      if (result.networkError) this.setData({ message: '网络未确认服务端是否收到，关节速记已保留；恢复网络后可重试。' });
      else if (result.rejected > 0) this.setData({ error: '关节速记未被服务端确认，已留在本机，请重试。' });
      else if (result.sent > 0) { this.setData({ message: '关节速记已保存。', observedDate: localDate(), stiffness: 0, painNrs: 0, activityLevel: 'FULL' }); this.load(scope); }
      this.refreshQueue();
    } catch (error) { this.setData({ error: describeError(error, '关节速记未确认，这条已留在本机，可以直接重试。') }); this.refreshQueue(); }
    finally { this.setData({ saving: false }); }
  },

  retry() { void this.flush(this.scope ?? currentScope(), true); },
  refresh() { this.load(this.scope ?? currentScope()); },
});

export { parseAssessment, parseSnapshot, observedAtForDate };
