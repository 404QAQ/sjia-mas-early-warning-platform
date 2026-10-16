import { ApiFailure, patientId, request, session } from '../../api';
import { featureScopeKey, recordUnavailable } from '../../feature-gate';
import { MutationOutbox, deniedOperations, newIdempotencyKey, wxStorage, type MutationEntry } from '../../mutation-outbox';

type Cycle = { patientId: string; version: number; updatedAt: string; periodStart?: string; periodEnd?: string; sharedWithCareTeam: boolean; phase: string; phaseLabel: string; phaseNote: string; medicationReview: { needsClinicianReview: boolean; medications: string[]; message: string } };
interface Scope { userId: string; actorId: string; patientId: string; }
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function text(value: unknown, max = 4096): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value); }
function instant(value: unknown): value is string { return text(value, 80) && Number.isFinite(Date.parse(value)); }
function only(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).every(key => keys.includes(key)); }
function currentScope(): Scope | null { const current = session(); const id = patientId(); return current && id ? { userId: current.userId, actorId: current.actorId, patientId: id } : null; }
function sameScope(scope: Scope): boolean { const latest = currentScope(); return Boolean(latest && latest.userId === scope.userId && latest.actorId === scope.actorId && latest.patientId === scope.patientId); }
function parseCycle(value: unknown, patient: string): Cycle | null {
  if (!object(value) || !only(value, ['patientId', 'version', 'updatedAt', 'periodStart', 'periodEnd', 'sharedWithCareTeam', 'phase', 'medicationReview']) || value.patientId !== patient || !Number.isSafeInteger(value.version) || Number(value.version) < 0 || !instant(value.updatedAt) || typeof value.sharedWithCareTeam !== 'boolean' || !['BLEEDING', 'RECENTLY_ENDED', 'BETWEEN_PERIODS', 'UNKNOWN'].includes(String(value.phase)) || !object(value.medicationReview)) return null;
  const review = value.medicationReview;
  if (!only(review, ['needsClinicianReview', 'medications', 'message']) || typeof review.needsClinicianReview !== 'boolean' || !Array.isArray(review.medications) || !review.medications.every((item: unknown) => text(item, 512)) || !text(review.message, 4096)) return null;
  if (value.periodStart !== undefined && !instant(value.periodStart)) return null;
  if (value.periodEnd !== undefined && !instant(value.periodEnd)) return null;
  const phase = PHASE_LABEL[value.phase as string] ? value.phase as string : 'UNKNOWN';
  return { patientId: patient, phase, phaseLabel: PHASE_LABEL[phase] ?? '未知', phaseNote: PHASE_NOTE[phase] ?? '', version: value.version as number, updatedAt: value.updatedAt, ...(value.periodStart === undefined ? {} : { periodStart: value.periodStart as string }), ...(value.periodEnd === undefined ? {} : { periodEnd: value.periodEnd as string }), sharedWithCareTeam: value.sharedWithCareTeam, medicationReview: { needsClinicianReview: review.needsClinicianReview, medications: review.medications as string[], message: review.message } };
}
/**
 * 阶段标签。措辞与医生端 menstrual-cycle-panel.ts 一致 —— 同一事实在两端
 * 必须用同一个说法，否则患者与医生会以为在看两件事。
 * 只说「已提供的窗口」，不出现排卵、周期长度、疾病活动等任何推断。
 */
const PHASE_LABEL: Record<string, string> = { BLEEDING: '经期中', RECENTLY_ENDED: '刚结束', BETWEEN_PERIODS: '经期之间', UNKNOWN: '未知' };
const PHASE_NOTE: Record<string, string> = {
  BLEEDING: '按你提供的日期，今天是经期内。',
  RECENTLY_ENDED: '按你提供的日期，经期刚结束（3 天内）。',
  BETWEEN_PERIODS: '按你提供的日期，现在不在经期内。',
  UNKNOWN: '还没有可判断的日期，或日期不完整。',
};
function describeError(error: unknown, fallback: string): string { return error instanceof Error ? error.message : fallback; }
function forbidden(error: unknown): boolean { return error instanceof ApiFailure && [401, 403].includes(error.status); }

Page({
  data: {
    loading: true, saving: false, error: '', notice: '', cycle: null as Cycle | null, periodStartDate: '', periodEndDate: '',
    pendingCount: 0, rejectedCount: 0, scopeKey: '',
  },
  outbox: null as MutationOutbox | null, scope: null as Scope | null,
  onLoad() { this.onShow(); },
  onShow() {
    const current = session();
    if (!current) {
      this.scope = null; this.outbox = null;
      this.setData({ scopeKey: '', loading: false, saving: false, cycle: null, periodStartDate: '', periodEndDate: '', pendingCount: 0, rejectedCount: 0, error: '', notice: '' });
      wx.redirectTo({ url: '/pages/auth/index' }); return;
    }
    const next = currentScope();
    if (!next) {
      this.scope = null; this.outbox = null;
      this.setData({ scopeKey: '', loading: false, saving: false, cycle: null, periodStartDate: '', periodEndDate: '', pendingCount: 0, rejectedCount: 0, error: '当前微信身份尚未绑定患者档案。', notice: '' });
      return;
    }
    const key = JSON.stringify([next.userId, next.actorId, next.patientId]);
    if (key === this.data.scopeKey) return;
    this.scope = next;
    this.outbox = new MutationOutbox(wxStorage(), next.actorId, next.patientId, next.userId);
    this.setData({ scopeKey: key, loading: true, saving: false, cycle: null, periodStartDate: '', periodEndDate: '', pendingCount: 0, rejectedCount: 0, error: '', notice: '' });
    this.refreshQueue(); this.load(next);
  },
  clearSensitiveState(message = '') { try { this.outbox?.clear(deniedOperations(['MENSTRUAL_CYCLE'], Boolean(session()))); } catch { /* 清理失败不能阻止内存投影清除 */ } this.setData({ cycle: null, periodStartDate: '', periodEndDate: '', pendingCount: 0, rejectedCount: 0, loading: false, saving: false, error: message, notice: '' }); },
  refreshQueue() {
    try { const entries: MutationEntry[] = this.outbox ? this.outbox.entries().filter((item: MutationEntry) => item.operation === 'MENSTRUAL_CYCLE') : []; this.setData({ pendingCount: entries.filter((item: MutationEntry) => item.state === 'PENDING').length, rejectedCount: entries.filter((item: MutationEntry) => item.state === 'REJECTED').length }); }
    catch (error) { this.setData({ error: describeError(error, '本机待提交记录不可读。') }); }
  },
  refresh() { this.load(); },
  dateChange(event: { currentTarget?: { dataset?: { field?: unknown } }; detail?: { value?: unknown } }) {
    const field = event.currentTarget?.dataset?.field; const value = event.detail?.value;
    if (this.data.saving || !['periodStartDate', 'periodEndDate'].includes(String(field)) || typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
    this.setData({ [String(field)]: value });
  },
  load(expectedScope?: Scope) {
    const scope = expectedScope ?? this.scope ?? currentScope();
    if (!scope || !sameScope(scope)) { this.setData({ loading: false, error: '身份已切换，请返回首页后重新打开。' }); return; }
    this.setData({ loading: true, error: '' });
    request<unknown>(`/api/v1/patients/${encodeURIComponent(scope.patientId)}/menstrual-cycle`).then(value => {
      if (!sameScope(scope)) throw new ApiFailure('身份已切换，请刷新当前页面。', 409);
      const cycle = parseCycle(value, scope.patientId); if (!cycle) throw new Error('经期响应格式无效，未更新当前记录。'); this.setData({ cycle, periodStartDate: cycle.periodStart?.slice(0, 10) ?? '', periodEndDate: cycle.periodEnd?.slice(0, 10) ?? '' });
    }).catch((error: unknown) => { if (sameScope(scope)) { recordUnavailable(featureScopeKey(scope), 'MENSTRUAL', error); if (forbidden(error)) this.clearSensitiveState('当前身份已无权查看经期记录，已清理本机敏感内容。'); else this.setData({ error: describeError(error, '经期记录暂不可见。') }); } }).finally(() => { if (sameScope(scope)) this.setData({ loading: false }); });
  },
  sendEntry(entry: MutationEntry): Promise<void> {
    const scope = this.scope; if (!scope || !sameScope(scope)) return Promise.reject(new ApiFailure('身份已切换，请刷新当前页面。', 409));
    if (entry.operation !== 'MENSTRUAL_CYCLE') return Promise.resolve();
    return request<unknown>(`/api/v1/patients/${encodeURIComponent(scope.patientId)}/menstrual-cycle`, 'POST', entry.payload).then(value => {
      if (!object(value) || typeof value.created !== 'boolean' || !parseCycle(value.cycle, scope.patientId)) throw new ApiFailure('经期保存回执不完整，这条已留在本机，可以直接重试。', 200);
    });
  },
  flush(retryRejected = false) {
    if (this.data.saving || !this.outbox) return; this.setData({ saving: true, error: '', notice: '' });
    this.outbox.flush((entry: MutationEntry) => this.sendEntry(entry), retryRejected, ['MENSTRUAL_CYCLE']).then((result: { sent: number; networkError: boolean; denied: boolean }) => {
      if (!this.scope || !sameScope(this.scope)) return;
      if (result.denied) { this.clearSensitiveState('当前身份无权保存经期记录，本机敏感内容已清理；请重新登录或切换到患者本人身份。'); this.refreshQueue(); return; }
      if (result.networkError) this.setData({ notice: '网络未确认服务端是否收到，经期操作已保留；恢复网络后可重试。' });
      else if (result.sent > 0) { this.setData({ notice: '经期记录已保存。' }); this.load(); }
      this.refreshQueue();
    }).catch((error: unknown) => { if (this.scope && sameScope(this.scope)) { if (forbidden(error)) this.clearSensitiveState('当前身份已失效，经期敏感内容已清理。'); else this.setData({ error: describeError(error, '本机待提交记录读取失败。') }); } }).finally(() => { if (!this.scope || sameScope(this.scope)) this.setData({ saving: false }); });
  },
  save(event: { detail: { value: { periodStart?: string; periodEnd?: string; sharedWithCareTeam?: boolean } } }) {
    const scope = this.scope; const current = this.data.cycle as Cycle | null; const value = event.detail.value;
    if (!scope || !sameScope(scope) || !current || this.data.saving) return;
    const start = value.periodStart || null; const end = value.periodEnd || null;
    if (start && end && Date.parse(end) < Date.parse(start)) { this.setData({ error: '结束日期不能早于开始日期。' }); return; }
    const payload = { periodStart: start, periodEnd: end, sharedWithCareTeam: Boolean(value.sharedWithCareTeam), expectedVersion: current.version, idempotencyKey: newIdempotencyKey('MENSTRUAL_CYCLE') };
    try { this.outbox?.enqueue({ operation: 'MENSTRUAL_CYCLE', idempotencyKey: payload.idempotencyKey, payload }); } catch (error) { this.setData({ error: describeError(error, '无法保存经期记录。') }); return; }
    this.refreshQueue(); this.flush();
  },
  retry() { this.flush(true); },
});
