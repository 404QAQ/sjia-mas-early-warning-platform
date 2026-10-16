import { loadSelfFollowups, saveSelfFollowup, type SelfFollowup } from '../../self-followups';
import { ApiFailure, patientId, request, session } from '../../api';
import { at } from '../../date-format';
import { readLocalFollowup, validFollowupDate } from '../../local-followup';
import { MutationOutbox, deniedOperations, newIdempotencyKey, wxStorage, type MutationEntry } from '../../mutation-outbox';

type TaskStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';
interface Task { status: TaskStatus; startedAt?: string; completedAt?: string; updatedAt: string; }
interface LifeEvent { id: string; type: 'RELOCATION'; fromRegion?: string; toRegion: string; status: 'DRAFT' | 'IN_PROGRESS' | 'COMPLETED'; version: number; initiatedAt: string; updatedAt: string; updatedText: string; findDoctor: Task; referralSummary: Task & { generatedAt?: string; confirmedAt?: string }; emergencyReset: Task; }
interface Scope { userId: string; actorId: string; patientId: string; }

function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function text(value: unknown, max = 500): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\0\r\n]/.test(value); }
function instant(value: unknown): value is string { return text(value, 80) && Number.isFinite(Date.parse(value)); }
function only(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).every(key => keys.includes(key)); }
function scope(): Scope | null { const current = session(); const id = patientId(); return current && id ? { userId: current.userId, actorId: current.actorId, patientId: id } : null; }
function sameScope(value: Scope): boolean { const current = scope(); return Boolean(current && current.userId === value.userId && current.actorId === value.actorId && current.patientId === value.patientId); }
function parseTask(value: unknown): value is Task {
  if (!object(value) || !only(value, ['status', 'startedAt', 'completedAt', 'updatedAt']) || !['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED'].includes(String(value.status)) || !instant(value.updatedAt)) return false;
  const started = value.startedAt === undefined ? undefined : Date.parse(String(value.startedAt));
  const completed = value.completedAt === undefined ? undefined : Date.parse(String(value.completedAt));
  if (value.startedAt !== undefined && (!instant(value.startedAt) || !Number.isFinite(started))) return false;
  if (value.completedAt !== undefined && (!instant(value.completedAt) || !Number.isFinite(completed))) return false;
  if (value.status === 'NOT_STARTED') return value.startedAt === undefined && value.completedAt === undefined;
  if (value.status === 'IN_PROGRESS') return value.startedAt !== undefined && value.completedAt === undefined && started! <= Date.parse(String(value.updatedAt));
  return value.startedAt !== undefined && value.completedAt !== undefined && started! <= completed! && completed! <= Date.parse(String(value.updatedAt));
}
function parseReferral(value: unknown): value is Task & { generatedAt?: string; confirmedAt?: string } {
  if (!object(value) || !only(value, ['status', 'startedAt', 'completedAt', 'updatedAt', 'generatedAt', 'confirmedAt', 'content']) || !parseTask({ status: value.status, ...(value.startedAt === undefined ? {} : { startedAt: value.startedAt }), ...(value.completedAt === undefined ? {} : { completedAt: value.completedAt }), updatedAt: value.updatedAt })) return false;
  if (value.generatedAt !== undefined && !instant(value.generatedAt)) return false;
  if (value.confirmedAt !== undefined && !instant(value.confirmedAt)) return false;
  if (value.generatedAt !== undefined && Date.parse(String(value.generatedAt)) > Date.parse(String(value.updatedAt))) return false;
  if (value.confirmedAt !== undefined && Date.parse(String(value.confirmedAt)) > Date.parse(String(value.updatedAt))) return false;
  const contentValid = value.content === undefined || object(value.content) && only(value.content, ['diagnosis', 'course', 'current_meds', 'taper_plan', 'allergies', 'key_trends_6m', 'mas_history', 'personal_baseline_note']) && Object.values(value.content).every(item => text(item, 20000));
  if (!contentValid) return false;
  if (value.status === 'IN_PROGRESS' && (value.generatedAt === undefined || value.content === undefined)) return false;
  return value.status !== 'COMPLETED' || value.generatedAt !== undefined && value.confirmedAt !== undefined && value.content !== undefined;
}
function parseEvent(value: unknown, id: string): LifeEvent | null {
  if (!object(value) || !only(value, ['id', 'type', 'fromRegion', 'toRegion', 'initiatedAt', 'completedAt', 'status', 'tags', 'findDoctor', 'referralSummary', 'emergencyReset', 'version', 'createdAt', 'updatedAt'])) return null;
  const item = value;
  if (!text(item.id, 200) || !text(item.toRegion) || item.type !== 'RELOCATION' || !instant(item.initiatedAt) || !instant(item.createdAt) || !instant(item.updatedAt) || item.completedAt !== undefined && !instant(item.completedAt) || !Array.isArray(item.tags) || item.tags.length !== 1 || item.tags[0] !== 'NO_ALERT' || !['DRAFT', 'IN_PROGRESS', 'COMPLETED'].includes(String(item.status)) || !Number.isSafeInteger(item.version) || Number(item.version) < 1 || item.fromRegion !== undefined && !text(item.fromRegion) || !parseTask(item.findDoctor) || !parseTask(item.emergencyReset) || !parseReferral(item.referralSummary)) return null;
  const tasks = [item.findDoctor, item.referralSummary, item.emergencyReset] as Array<Task>;
  const allNotStarted = tasks.every(task => task.status === 'NOT_STARTED');
  const allCompleted = tasks.every(task => task.status === 'COMPLETED');
  if (item.status === 'DRAFT' && !allNotStarted || item.status === 'IN_PROGRESS' && (allNotStarted || allCompleted) || item.status === 'COMPLETED' && (!allCompleted || item.completedAt === undefined)) return null;
  if (item.status !== 'COMPLETED' && item.completedAt !== undefined) return null;
  const version = Number(item.version);
  return { id, type: 'RELOCATION', ...(item.fromRegion === undefined ? {} : { fromRegion: item.fromRegion }), toRegion: item.toRegion, status: item.status as LifeEvent['status'], version, initiatedAt: item.initiatedAt, updatedAt: item.updatedAt, updatedText: at(item.updatedAt), findDoctor: item.findDoctor, referralSummary: item.referralSummary, emergencyReset: item.emergencyReset };
}
function parseList(value: unknown): LifeEvent[] { if (!object(value) || !only(value, ['events']) || !Array.isArray(value.events) || value.events.length > 100) throw new Error('生活事件响应格式无效。'); return value.events.map(item => { if (!object(item) || !text(item.id, 200)) throw new Error('生活事件标识无效。'); const parsed = parseEvent(item, item.id); if (!parsed) throw new Error('生活事件内容未通过校验。'); return parsed; }); }
function outboxFor(value: Scope): MutationOutbox { return new MutationOutbox(wxStorage(), value.actorId, value.patientId, value.userId); }
function pending(outbox: MutationOutbox, match: (entry: MutationEntry) => boolean): MutationEntry | undefined { return outbox.entries().find(entry => entry.operation === 'LIFE_EVENT' && match(entry)); }
function localDate(value = new Date()): string { return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`; }

Page({
  data: {
    loading: true, saving: false, pendingCount: 0, error: '', notice: '', scopeKey: '', fromRegion: '', toRegion: '', events: [] as LifeEvent[],
    today: localDate(), followupDate: '', followupHospital: '', followupDepartment: '', followupDoctor: '', followupExamItems: '', followupNote: '', followupSummary: '', savingFollowup: false, followupLoading: false, followupRows: [] as SelfFollowup[], editingFollowupId: '', section: '',
  },
  outbox: null as MutationOutbox | null,
  targetSection: '',
  onLoad(options: { section?: string } = {}) { this.targetSection = options.section === 'followup' ? 'followup' : ''; this.setData({ section: this.targetSection }); wx.setNavigationBarTitle?.({ title: this.targetSection ? '随访安排' : '复诊与生活安排' }); this.onShow(); },
  onReady() {
    if (this.targetSection && scope()) { wx.pageScrollTo({ selector: '#followup-section', duration: 200 }); this.targetSection = ''; }
  },
  onShow() {
    const current = scope(); if (!current) { this.outbox = null; this.setData({ scopeKey: '', loading: false, saving: false, savingFollowup: false, error: '', notice: '', fromRegion: '', toRegion: '', events: [], followupDate: '', followupHospital: '', followupDepartment: '', followupDoctor: '', followupExamItems: '', followupNote: '', followupSummary: '' }); wx.redirectTo({ url: '/pages/auth/index' }); return; }
    const key = `${current.userId}:${current.actorId}:${current.patientId}`;
    if (key !== this.data.scopeKey) { const followup = readLocalFollowup(current); this.setData({ scopeKey: key, fromRegion: '', toRegion: '', events: [], error: '', notice: '', followupDate: followup?.date ?? '', followupHospital: followup?.hospital ?? '', followupDepartment: followup?.department ?? '', followupDoctor: followup?.doctor ?? '', followupExamItems: followup?.examItems ?? '', followupNote: followup?.note ?? '', followupSummary: followup ? [followup.hospital, followup.department, followup.doctor].filter(Boolean).join(' · ') : '', today: localDate() }); this.outbox = outboxFor(current); this.refreshPending(); this.load(current); }
    this.loadFollowups(current);
  },
  pickFollowupDate(event: { detail?: { value?: unknown } }) { const value = event.detail?.value; if (typeof value === 'string') this.setData({ followupDate: value, error: '' }); },
  inputFollowupHospital(event: { detail?: { value?: unknown } }) { if (typeof event.detail?.value === 'string') this.setData({ followupHospital: event.detail.value.slice(0, 200), error: '' }); },
  inputFollowupDepartment(event: { detail?: { value?: unknown } }) { if (typeof event.detail?.value === 'string') this.setData({ followupDepartment: event.detail.value.slice(0, 200), error: '' }); },
  inputFollowupDoctor(event: { detail?: { value?: unknown } }) { if (typeof event.detail?.value === 'string') this.setData({ followupDoctor: event.detail.value.slice(0, 200), error: '' }); },
  inputFollowupExamItems(event: { detail?: { value?: unknown } }) { if (typeof event.detail?.value === 'string') this.setData({ followupExamItems: event.detail.value.slice(0, 200), error: '' }); },
  inputFollowupNote(event: { detail?: { value?: unknown } }) { if (typeof event.detail?.value === 'string') this.setData({ followupNote: event.detail.value.slice(0, 200), error: '' }); },
  async loadFollowups(current: Scope) {
    this.setData({ followupLoading: true });
    try { const rows = await loadSelfFollowups(current); if (sameScope(current)) this.setData({ followupRows: rows }); }
    catch (error) { if (sameScope(current)) this.setData({ followupRows: [], error: error instanceof Error ? error.message : '复诊安排读取失败。' }); }
    finally { if (sameScope(current)) this.setData({ followupLoading: false }); }
  },
  async saveFollowup() {
    const current = scope(); const date = String(this.data.followupDate ?? '');
    if (!current || this.data.savingFollowup) return;
    if (!validFollowupDate(date) || (!this.data.editingFollowupId && date < localDate())) { this.setData({ error: '请选择今天或之后的有效复诊日期。' }); return; }
    const previous = this.data.followupRows.find((row: SelfFollowup) => row.id === this.data.editingFollowupId) as SelfFollowup | undefined;
    if (this.data.editingFollowupId && !previous) { this.setData({ error: '原安排已变化，请重新读取。' }); return; }
    this.setData({ savingFollowup: true, error: '' });
    try {
      const saved = await saveSelfFollowup(current, { date, hospital: String(this.data.followupHospital).trim(), department: String(this.data.followupDepartment).trim(), doctor: String(this.data.followupDoctor).trim(), examItems: String(this.data.followupExamItems).trim(), note: String(this.data.followupNote).trim(), status: previous?.status ?? 'SCHEDULED' }, previous);
      if (!sameScope(current)) return;
      this.setData({ followupRows: [saved, ...this.data.followupRows.filter((row: SelfFollowup) => row.id !== saved.id)], followupDate: '', followupHospital: '', followupDepartment: '', followupDoctor: '', followupExamItems: '', followupNote: '', editingFollowupId: '', notice: '复诊安排已保存，首页和照护医生可查看；请按医院预约信息就诊。' });
    } catch (error) { if (sameScope(current)) this.setData({ error: error instanceof Error ? error.message : '复诊安排未确认，请重试。' }); }
    finally { if (sameScope(current)) this.setData({ savingFollowup: false }); }
  },
  editFollowup(event: { currentTarget: { dataset: { id: string } } }) {
    if (this.data.savingFollowup) return;
    const row = this.data.followupRows.find((item: SelfFollowup) => item.id === event.currentTarget.dataset.id) as SelfFollowup | undefined;
    if (!row || row.status !== 'SCHEDULED') return;
    this.setData({ editingFollowupId: row.id, followupDate: row.date, followupHospital: row.hospital, followupDepartment: row.department, followupDoctor: row.doctor, followupExamItems: row.examItems, followupNote: row.note, notice: '', error: '' }); wx.pageScrollTo({ scrollTop: 0, duration: 100 });
  },
  cancelFollowupEdit() { if (!this.data.savingFollowup) this.setData({ editingFollowupId: '', followupDate: '', followupHospital: '', followupDepartment: '', followupDoctor: '', followupExamItems: '', followupNote: '' }); },
  async updateFollowupStatus(event: { currentTarget: { dataset: { id: string; status: string } } }) {
    const current = scope(); if (!current || this.data.savingFollowup) return;
    const row = this.data.followupRows.find((item: SelfFollowup) => item.id === event.currentTarget.dataset.id) as SelfFollowup | undefined;
    const status = event.currentTarget.dataset.status;
    if (!row || row.status !== 'SCHEDULED' || (status !== 'COMPLETED' && status !== 'CANCELLED')) return;
    this.setData({ savingFollowup: true, error: '' });
    try { const saved = await saveSelfFollowup(current, { date: row.date, hospital: row.hospital, department: row.department, doctor: row.doctor, examItems: row.examItems, note: row.note, status }, row); if (sameScope(current)) this.setData({ followupRows: this.data.followupRows.map((item: SelfFollowup) => item.id === saved.id ? saved : item), notice: status === 'COMPLETED' ? '已记录本次复诊完成。' : '已取消这条自记安排。' }); }
    catch (error) { if (sameScope(current)) this.setData({ error: error instanceof Error ? error.message : '状态保存失败。' }); }
    finally { if (sameScope(current)) this.setData({ savingFollowup: false }); }
  },
  inputFrom(event: { detail?: { value?: string } }) { this.setData({ fromRegion: event.detail?.value ?? '' }); },
  inputTo(event: { detail?: { value?: string } }) { this.setData({ toRegion: event.detail?.value ?? '' }); },
  parseCurrent(value: unknown, expected: Scope): LifeEvent[] { if (!sameScope(expected)) throw new ApiFailure('身份已切换，请刷新当前页面。', 409); return parseList(value); },
  async load(expected = scope() as Scope) {
    if (!expected || !sameScope(expected)) return;
    this.setData({ loading: true, error: '' });
    try { const value = await request<unknown>(`/api/v1/patients/${encodeURIComponent(expected.patientId)}/life-events`); this.setData({ events: this.parseCurrent(value, expected), loading: false }); }
    catch (error) { if (sameScope(expected)) this.setData({ loading: false, error: error instanceof Error ? error.message : '生活事件读取失败。' }); }
  },
  send(entry: MutationEntry, expected: Scope): Promise<void> {
    if (!sameScope(expected) || entry.operation !== 'LIFE_EVENT') return Promise.reject(new ApiFailure('身份已切换，请刷新当前页面。', 409));
    const payload = entry.payload; const eventIdValue = typeof payload.eventId === 'string' ? payload.eventId : undefined; const eventId = eventIdValue ? `/${encodeURIComponent(eventIdValue)}` : '';
    const { eventId: _eventId, ...body } = payload;
    return request<unknown>(`/api/v1/patients/${encodeURIComponent(expected.patientId)}/life-events${eventId}`, 'POST', body).then(value => {
      if (!object(value) || typeof value.created !== 'boolean' || !object(value.event) || !text(value.event.id, 200) || eventIdValue !== undefined && value.event.id !== eventIdValue || !parseEvent(value.event, value.event.id)) throw new ApiFailure('服务端生活事件回执不完整，这条已留在本机，可以直接重试。', 200);
    });
  },
  async flush(expected: Scope) {
    if (!this.outbox || this.data.saving || !sameScope(expected)) return;
    this.setData({ saving: true, error: '', notice: '' });
    try { const result = await this.outbox.flush((entry: MutationEntry) => this.send(entry, expected), true, ['LIFE_EVENT']); if (result.denied) { try { this.outbox.clear(deniedOperations(['LIFE_EVENT'], Boolean(session()))); } catch { /* 保留失权提示 */ } this.setData({ error: '当前身份已无权更新生活事件，待提交操作已清理。' }); } else if (result.networkError) this.setData({ notice: '网络未确认，操作已保留，恢复网络后可重试。' }); else { this.setData({ notice: result.sent ? '操作已确认。' : '没有可提交的操作。' }); await this.load(expected); } }
    catch (error) { this.setData({ error: error instanceof Error ? error.message : '生活事件未确认，这条已留在本机，可以直接重试。' }); }
    finally { this.setData({ saving: false }); this.refreshPending(); }
  },
  create() {
    const expected = scope(); const toRegion = String(this.data.toRegion ?? '').trim(); const fromRegion = String(this.data.fromRegion ?? '').trim();
    if (!expected || !this.outbox || !text(toRegion, 500) || fromRegion.length > 500 || this.data.saving) { this.setData({ error: '请填写要搬去的城市或地区（不超过 500 字）。' }); return; }
    const prior = pending(this.outbox, entry => entry.payload.action === 'CREATE' && entry.payload.toRegion === toRegion && entry.payload.fromRegion === (fromRegion || undefined)); const idempotencyKey = prior?.idempotencyKey ?? newIdempotencyKey('LIFE_EVENT'); const payload: Record<string, unknown> = { action: 'CREATE', type: 'RELOCATION', toRegion, expectedVersion: 0, idempotencyKey, ...(fromRegion ? { fromRegion } : {}) };
    try { this.outbox.enqueue({ operation: 'LIFE_EVENT', idempotencyKey, payload }); } catch (error) { this.setData({ error: error instanceof Error ? error.message : '无法保存生活事件。' }); return; }
    void this.flush(expected);
  },
  task(event: { currentTarget?: { dataset?: { id?: unknown; action?: unknown; version?: unknown } } }) {
    const expected = scope(); const id = event.currentTarget?.dataset?.id; const action = event.currentTarget?.dataset?.action;
    if (!expected || !this.outbox || typeof id !== 'string' || !['START_FIND_DOCTOR', 'GENERATE_REFERRAL_SUMMARY', 'START_EMERGENCY_RESET'].includes(String(action))) return;
    const current = (this.data.events as LifeEvent[]).find(item => item.id === id); if (!current) return;
    const prior = pending(this.outbox, entry => entry.payload.action === action && entry.payload.eventId === id && entry.payload.expectedVersion === current.version); const idempotencyKey = prior?.idempotencyKey ?? newIdempotencyKey('LIFE_EVENT'); const payload: Record<string, unknown> = { action, eventId: id, expectedVersion: current.version, idempotencyKey };
    try { this.outbox.enqueue({ operation: 'LIFE_EVENT', idempotencyKey, payload }); } catch (error) { this.setData({ error: error instanceof Error ? error.message : '无法保存生活事件操作。' }); return; }
    void this.flush(expected);
  },
  refreshPending() { try { this.setData({ pendingCount: this.outbox?.entries().filter((entry: MutationEntry) => entry.operation === 'LIFE_EVENT' && ['PENDING', 'REJECTED'].includes(entry.state)).length ?? 0 }); } catch { this.setData({ pendingCount: 0, error: '待提交记录读取失败，请重新打开页面。' }); } },
  retry() { const expected = scope(); if (expected) void this.flush(expected); },
  refresh() { const expected = scope(); if (expected) void this.load(expected); },
});
