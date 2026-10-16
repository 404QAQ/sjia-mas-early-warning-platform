import { patientId, request, session } from '../../api';
import { at } from '../../date-format.js';
import { loadCrisisContacts, loadSupportCard, loadSupportKit, loadSupportPlan, makePhoneCall, recordCrisisAction, type CrisisView, type SupportCard, type SupportKit, type SupportPlan } from '../../support';
import { ApiFailure } from '../../api';
import { PENDING_MESSAGE_KEY_PREFIX } from '../../config';
import { careInviteEntry } from '../../feature-gate';
import { parseCareCapabilities, type CareCapabilities } from '../../care-capabilities';
import { MutationOutbox, deniedOperations, newIdempotencyKey, wxStorage, type MutationEntry } from '../../mutation-outbox';

type CardState = 'LOADING' | 'READY' | 'UNAVAILABLE' | 'DENIED';
interface ServiceCard { key: string; title: string; state: CardState; message: string; items: string[]; }
interface MessageRow { id: string; title: string; body: string; read: boolean; timeText?: string; outgoing?: boolean; }
interface EducationRow { id: string; title: string; body: string; read: boolean; }
interface PendingMessage { patientId: string; body: string; idempotencyKey: string; }
type ConsultationStatus = 'PENDING' | 'ACCEPTED' | 'RESPONDED' | 'ACKNOWLEDGED' | 'CLOSED' | 'DECLINED' | 'CANCELLED';
interface ConsultationEventRow { id: string; type: string; actorId: string; at: string; body?: string; nextStep?: string; }
interface ConsultationRow { id: string; patientId: string; requesterActorId: string; assignedActorId?: string; topic: string; detail?: string; urgency: 'ROUTINE' | 'SOON' | 'URGENT'; status: ConsultationStatus; version: number; createdAt: string; updatedAt: string; events: ConsultationEventRow[]; }

function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function text(value: unknown, max = 500): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\0\r\n]/.test(value); }
/**
 * 消息正文允许用户分段输入，因此只拦截 NUL，不拦截 CR/LF；长度和非空
 * 约束仍然保留，避免异常载荷进入本机草稿或提交请求。
 */
export function messageBody(value: unknown, max = 20000): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/\0/.test(value);
}
function instant(value: unknown): value is string { return text(value, 80) && Number.isFinite(Date.parse(value)); }
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function itemText(value: unknown, fields: readonly string[]): string | null {
  if (!object(value)) return null;
  for (const field of fields) if (text(value[field], 500)) return value[field];
  return null;
}
function dateText(value: unknown): string {
  return instant(value) ? at(value) : '时间待确认';
}
function card(key: string, title: string): ServiceCard { return { key, title, state: 'LOADING', message: '读取中…', items: [] }; }
function pendingKey(): string | null {
  const current = session(); const id = patientId();
  return current && id ? `${PENDING_MESSAGE_KEY_PREFIX}:${current.userId}:${current.actorId}:${id}` : null;
}
function pendingMessage(): PendingMessage | null {
  const key = pendingKey(); if (!key) return null;
  const value = wx.getStorageSync<unknown>(key);
  if (!object(value) || !text(value.patientId, 256) || !messageBody(value.body) || !text(value.idempotencyKey, 256)) return null;
  return { patientId: value.patientId, body: value.body, idempotencyKey: value.idempotencyKey };
}
function savePending(value: PendingMessage): void { const key = pendingKey(); if (key) wx.setStorageSync(key, value); }
function clearPending(): void { const key = pendingKey(); if (key) wx.removeStorageSync(key); }
function makeKey(): string { return `wx-message-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`; }
function currentScopeKey(): string { const current = session(); const id = patientId(); return current && id ? `${current.userId}:${current.actorId}:${id}` : ''; }
function outboxForCurrent(): MutationOutbox | null { const current = session(); const id = patientId(); return current && id ? new MutationOutbox(wxStorage(), current.actorId, id, current.userId) : null; }
function forbidden(error: unknown): boolean { return error instanceof ApiFailure && [401, 403].includes(error.status); }
function parseConsultations(value: unknown, expectedPatientId: string): ConsultationRow[] {
  if (!object(value) || value.patientId !== expectedPatientId || !Array.isArray(value.items)) throw new Error('会诊状态响应格式无效。');
  return value.items.slice(0, 20).map(item => {
    if (!object(item) || !text(item.id, 200) || item.patientId !== expectedPatientId || !text(item.topic, 200) || !['ROUTINE', 'SOON', 'URGENT'].includes(String(item.urgency)) || !['PENDING', 'ACCEPTED', 'RESPONDED', 'ACKNOWLEDGED', 'CLOSED', 'DECLINED', 'CANCELLED'].includes(String(item.status)) || !Number.isSafeInteger(item.version) || Number(item.version) < 1 || !instant(item.createdAt) || !instant(item.updatedAt) || !Array.isArray(item.events)) throw new Error('会诊状态内容无效。');
    const events = item.events.slice(-10).map(event => { if (!object(event) || !text(event.id, 200) || !text(event.actorId, 200) || !text(event.type, 40) || !instant(event.at) || event.body !== undefined && typeof event.body !== 'string' || event.nextStep !== undefined && typeof event.nextStep !== 'string') throw new Error('会诊时间线内容无效。'); return { id: event.id, type: event.type, actorId: event.actorId, at: event.at, ...(event.body === undefined ? {} : { body: event.body }), ...(event.nextStep === undefined ? {} : { nextStep: event.nextStep }) }; });
    return { id: item.id, patientId: expectedPatientId, requesterActorId: String(item.requesterActorId ?? ''), ...(item.assignedActorId ? { assignedActorId: String(item.assignedActorId) } : {}), topic: item.topic, ...(item.detail ? { detail: String(item.detail) } : {}), urgency: item.urgency as ConsultationRow['urgency'], status: item.status as ConsultationStatus, version: Number(item.version), createdAt: item.createdAt, updatedAt: item.updatedAt, events };
  });
}

async function loadCard(id: string, key: string, title: string, path: string, format: (value: unknown) => string[]): Promise<ServiceCard> {
  try {
    const value = await request<unknown>(`/api/v1/patients/${encodeURIComponent(id)}/${path}`);
    const items = format(value);
    return { key, title, state: 'READY', message: items.length ? '' : '暂无已确认内容。', items };
  } catch (error) {
    return { key, title, state: forbidden(error) ? 'DENIED' : 'UNAVAILABLE', message: error instanceof Error ? error.message : '当前身份暂不可见。', items: [] };
  }
}

export function formatCare(value: unknown, expectedPatientId: string): string[] {
  if (!object(value) || value.patientId !== expectedPatientId || !Array.isArray(value.primary) || !Array.isArray(value.onCall) || !Array.isArray(value.backup)) throw new Error('照护摘要响应格式无效。');
  const names = [['主诊', value.primary], ['主治', value.attending], ['会诊 / 受邀医生', value.consultants], ['值班', value.onCall], ['备班', value.backup]].flatMap(([role, members]) => list(members).map(item => { const name = itemText(item, ['label', 'name']); return name ? `${role}：${name}` : null; })).filter((item): item is string => Boolean(item));
  if (value.asOf !== undefined && !instant(value.asOf)) throw new Error('照护摘要时间无效。');
  return [...new Set(names)].slice(0, 20);
}
export function formatMessages(value: unknown, expectedPatientId: string): string[] {
  if (!object(value) || value.patientId !== expectedPatientId || !Array.isArray(value.records)) throw new Error('消息响应格式无效。');
  return value.records.slice(0, 20).map(record => {
    if (!object(record) || !object(record.message) || !text(record.message.title, 200) || !messageBody(record.message.body)) return null;
    const createdAt = instant(record.message.createdAt) ? ` · ${dateText(record.message.createdAt)}` : '';
    const readState = record.read === null ? ' · 未读' : ' · 已读';
    return `${record.message.title}：${record.message.body}${createdAt}${readState}`;
  }).filter((item): item is string => Boolean(item));
}
export function parseMessages(value: unknown, expectedPatientId: string): MessageRow[] {
  if (!object(value) || value.patientId !== expectedPatientId || !Array.isArray(value.records)) throw new Error('消息响应格式无效。');
  return value.records.slice(0, 20).map(record => {
    if (!object(record) || !object(record.message) || !text(record.message.id, 256) || !text(record.message.title, 200) || !messageBody(record.message.body) || !(record.read === null || object(record.read))) return null;
    return { id: record.message.id, title: record.message.title, body: record.message.body, read: record.read !== null, ...(instant(record.message.createdAt) ? { timeText: at(record.message.createdAt) } : {}), ...(record.message.direction === 'INBOUND' ? { outgoing: true } : {}) };
  }).filter((item): item is MessageRow => Boolean(item));
}
function formatFollowups(value: unknown, expectedPatientId: string): string[] {
  if (!object(value) || !Array.isArray(value.items)) throw new Error('随访响应格式无效。');
  const typeLabels: Record<string, string> = { LAB_REPORT: '化验复核', CLINIC_VISIT: '门诊复诊', TEMP_LOG: '体温记录', MED_ADHERENCE: '用药记录' };
  const stateLabels: Record<string, string> = { OPEN: '待完成', REMINDER_SENT: '已提醒', OVERDUE: '已逾期', ESCALATED: '待照护团队处理', COMPLETED: '已完成', CANCELLED: '已取消' };
  return value.items.slice(0, 20).map(item => {
    if (!object(item) || item.patientId !== expectedPatientId) return null;
    const label = itemText(item, ['title', 'label']) ?? (typeof item.type === 'string' ? typeLabels[item.type] ?? item.type : null);
    if (!label) return null;
    const due = instant(item.dueAt) ? ` · 到期 ${dateText(item.dueAt)}` : '';
    const state = typeof item.state === 'string' && stateLabels[item.state] ? ` · ${stateLabels[item.state]}` : '';
    return `${label}${due}${state}`;
  }).filter((item): item is string => Boolean(item));
}
function parseEducation(value: unknown, expectedPatientId: string): EducationRow[] {
  if (!object(value) || value.patientId !== expectedPatientId || !Array.isArray(value.items)) throw new Error('教育内容响应格式无效。');
  return value.items.slice(0, 20).map(item => {
    if (!object(item) || !object(item.delivery) || !object(item.article) || !text(item.delivery.id, 256) || !text(item.article.title, 400)) return null;
    return { id: item.delivery.id, title: item.article.title, body: messageBody(item.article.body, 64000) ? item.article.body : '', read: item.readAt !== undefined };
  }).filter((item): item is EducationRow => Boolean(item));
}
function formatResources(value: unknown, expectedPatientId: string): string[] {
  if (!object(value) || value.patientId !== expectedPatientId || !Array.isArray(value.resources)) throw new Error('资源目录响应格式无效。');
  if (value.requiresRegion === true) return ['请先在个人资料中补充所在地区，系统才会展示本地资源。'];
  return value.resources.slice(0, 20).map(item => object(item) && text(item.title, 200) && text(item.description, 4000) ? `${item.title}：${item.description}` : null).filter((item): item is string => Boolean(item));
}
function formatVisit(value: unknown, expectedPatientId: string): string[] {
  if (!object(value) || value.patientId !== expectedPatientId || !object(value.trend) || !Array.isArray(value.trend.highlights)) throw new Error('复诊摘要响应格式无效。');
  return value.trend.highlights.filter((item): item is string => text(item, 1000)).slice(0, 10);
}

Page({
  data: {
    loading: true,
    sending: false,
    error: '',
    draft: '',
    pending: false,
    cards: [] as ServiceCard[],
    supportReadyCount: 0,
    careCapabilities: null as CareCapabilities | null,
    messagesError: '',
    educationError: '',
    emergencyLoading: false,
    emergencyError: '',
    supportPlan: null as SupportPlan | null,
    supportKit: null as SupportKit | null,
    supportCard: null as SupportCard | null,
    crisisLoading: false,
    callingCrisisId: '',
    crisisError: '',
    crisis: null as CrisisView | null,
    messages: [] as MessageRow[],
    education: [] as EducationRow[],
    readSaving: false,
    scopeKey: '',
    showCareInvite: false,
    careInviteNote: '',
    activeSection: 'messages',
    expandedEducationId: '',
    consultations: [] as ConsultationRow[],
    consultationTopic: '',
    consultationDetail: '',
    consultationUrgency: 'SOON' as ConsultationRow['urgency'],
    consultationSaving: false,
    consultationError: '',

  },
  outbox: null as MutationOutbox | null,
  scopeGeneration: 0,
  loadGeneration: 0,
  sendGeneration: 0,
  invalidateAsyncScope() {
    this.scopeGeneration += 1; this.loadGeneration += 1; this.sendGeneration += 1;
    this.setData({ sending: false, readSaving: false, loading: false, emergencyLoading: false, crisisLoading: false, callingCrisisId: '' });
  },
  isCurrentScope(key: string, generation: number): boolean { return generation === this.scopeGeneration && key === this.data.scopeKey && key === currentScopeKey(); },
  onUnload() { this.invalidateAsyncScope(); },
  clearSensitiveState(message = '') { this.invalidateAsyncScope(); try { this.outbox?.clear(deniedOperations(['MESSAGE_READ', 'EDUCATION_READ'], Boolean(session()))); } catch { /* 清理失败不能阻止内存投影清除 */ } clearPending(); this.setData({ cards: [], supportReadyCount: 0, careCapabilities: null, messagesError: '', educationError: '', supportPlan: null, supportKit: null, supportCard: null, crisis: null, messages: [], education: [], consultations: [], pending: false, draft: '', consultationTopic: '', consultationDetail: '', consultationError: '', emergencyError: '', callingCrisisId: '', crisisError: '', loading: false, error: message }); },
  onShow() {
    const current = session(); const id = patientId();
    if (!current) { this.invalidateAsyncScope(); this.outbox = null; this.setData({ scopeKey: '', loading: false, error: '', cards: [], supportReadyCount: 0, careCapabilities: null, messagesError: '', educationError: '', supportPlan: null, supportKit: null, supportCard: null, crisis: null, messages: [], education: [], consultations: [], pending: false, draft: '', consultationTopic: '', consultationDetail: '', consultationError: '' }); wx.redirectTo({ url: '/pages/auth/index' }); return; }
    if (!id) { this.clearSensitiveState('当前微信身份尚未绑定患者档案。'); this.setData({ scopeKey: '', error: '当前微信身份尚未绑定患者档案。' }); return; }
    const scopeKey = id ? `${current.userId}:${current.actorId}:${id}` : '';
    // 每次回到本页都重算：从邀请页带回的服务端回执要在这里立即生效。
    this.setData(careInviteEntry(current));
    if (scopeKey !== this.data.scopeKey) {
      this.invalidateAsyncScope();
      this.setData({ scopeKey, draft: pendingMessage()?.body ?? '', pending: Boolean(pendingMessage()), messages: [], education: [], consultations: [], consultationTopic: '', consultationDetail: '', consultationError: '', careCapabilities: null, messagesError: '', educationError: '', error: '', supportPlan: null, supportKit: null, supportCard: null, crisis: null, emergencyLoading: false, crisisLoading: false, callingCrisisId: '' });
      this.outbox = outboxForCurrent();
      this.load();
    } else if (!this.data.loading) this.load();
  },
  onLoad(options?: { topic?: string; section?: string; compose?: string }) {
    if (!session()) { wx.redirectTo({ url: '/pages/auth/index' }); return; }
    this.messageSection = options?.section === 'messages';
    const activeSection = options?.section === 'care' || options?.section === 'crisis' ? 'care' : 'messages';
    this.setData({ activeSection });
    wx.setNavigationBarTitle?.({ title: activeSection === 'messages' ? '医生消息' : '照护与支持' });
    this.onShow();
    if (options?.section === 'crisis') this.loadCrisis();
    if (options?.topic === 'medication-adjustment' && !this.data.draft && !pendingMessage()) this.setData({ draft: '我希望请照护团队协助核对或调整用药。想咨询的药物、目前用量和原因：' });
    if (options?.compose === 'private-talk' && !this.data.draft && !pendingMessage()) this.setData({ draft: '我希望在下次复诊时有一段与医生单独交谈的时间。想讨论的内容：' });
  },
  onReady() { if (this.data.activeSection === 'care' && this.data.crisisLoading) wx.pageScrollTo?.({ selector: '#crisis-support', duration: 250 }); },
  messageSection: false,
  switchSection(event: { currentTarget?: { dataset?: { section?: string } } }) { const section = event.currentTarget?.dataset?.section; if (section !== 'messages' && section !== 'care') return; this.setData({ activeSection: section }); wx.setNavigationBarTitle?.({ title: section === 'messages' ? '医生消息' : '照护与支持' }); wx.pageScrollTo({ scrollTop: 0, duration: 0 }); },
  toggleEducation(event: { currentTarget?: { dataset?: { id?: string } } }) { const id = event.currentTarget?.dataset?.id; if (id) this.setData({ expandedEducationId: this.data.expandedEducationId === id ? '' : id }); },
  load() {
    const id = patientId();
    if (!id) { this.setData({ loading: false, error: '当前微信身份尚未绑定患者档案。' }); return; }
    const scopeKey = currentScopeKey(); const scopeGeneration = this.scopeGeneration; const generation = ++this.loadGeneration;
    const active = () => this.isCurrentScope(scopeKey, scopeGeneration) && generation === this.loadGeneration;
    const cards = [card('care', '当前照护团队'), card('followups', '随访事项'), card('resources', '本地支持资源'), card('visit', '复诊前摘要')];
    this.setData({ loading: true, error: '', cards, supportReadyCount: 0, careCapabilities: null, messagesError: '', educationError: '' });
    this.loadConsultations(scopeKey);
    Promise.allSettled([
      loadCard(id, 'care', '当前照护团队', 'care-summary', value => { const rows = formatCare(value, id); if (active()) this.setData({ careCapabilities: parseCareCapabilities(value, id) }); return rows; }),
      loadCard(id, 'followups', '随访事项', 'followups?limit=20', value => formatFollowups(value, id)),
      loadCard(id, 'resources', '本地支持资源', 'resources', value => formatResources(value, id)),
      loadCard(id, 'visit', '复诊前摘要', 'visit-summary', value => formatVisit(value, id)),
      request<unknown>(`/api/v1/patients/${encodeURIComponent(id)}/messages?limit=20`).then(value => parseMessages(value, id)),
      request<unknown>(`/api/v1/patients/${encodeURIComponent(id)}/education?limit=20`).then(value => parseEducation(value, id)),
    ]).then(next => {
      if (!active()) return;
      const serviceCards = next.slice(0, 4).map((result, index) => result.status === 'fulfilled' ? result.value as ServiceCard : { ...cards[index], state: 'UNAVAILABLE' as const, message: '暂时无法读取。' });
      if (serviceCards.some(item => item.state === 'DENIED') || next.some(item => item.status === 'rejected' && forbidden(item.reason))) { this.clearSensitiveState('当前身份无权查看支持内容，已清理本机敏感内容。'); return; }
      const unavailableCount = serviceCards.filter(item => item.state === 'UNAVAILABLE').length;
      this.setData({ cards: serviceCards, supportReadyCount: serviceCards.filter(item => item.state === 'READY').length,
        messages: next[4].status === 'fulfilled' ? next[4].value as MessageRow[] : [],
        education: next[5].status === 'fulfilled' ? next[5].value as EducationRow[] : [],
        messagesError: next[4].status === 'rejected' ? '医生消息暂未读取成功，请重新读取。' : '',
        educationError: next[5].status === 'rejected' ? '健康教育暂未读取成功，请重新读取。' : '',
        error: unavailableCount ? `${unavailableCount} 项照护服务暂不可用，请重新读取。` : '' });
    }).finally(() => { if (active() && this.data.cards.length > 0) { this.setData({ loading: false }); this.loadEmergency(scopeKey); } });
  },
  loadConsultations(expectedScopeKey = currentScopeKey()) {
    const id = patientId(); if (!id) return;
    const scopeGeneration = this.scopeGeneration;
    request<unknown>(`/api/v1/patients/${encodeURIComponent(id)}/consultations?limit=20`).then(value => {
      if (this.isCurrentScope(expectedScopeKey, scopeGeneration)) this.setData({ consultations: parseConsultations(value, id), consultationError: '' });
    }).catch(error => {
      if (!this.isCurrentScope(expectedScopeKey, scopeGeneration)) return;
      if (forbidden(error)) this.setData({ consultations: [], consultationError: '当前身份暂不能查看会诊状态。' });
      else this.setData({ consultationError: error instanceof Error ? error.message : '会诊状态暂不可用，请重试。' });
    });
  },
  onConsultationTopic(event: { detail: { value?: string } }) { this.setData({ consultationTopic: event.detail.value ?? '', consultationError: '' }); },
  onConsultationDetail(event: { detail: { value?: string } }) { this.setData({ consultationDetail: event.detail.value ?? '', consultationError: '' }); },
  onConsultationUrgency(event: { currentTarget?: { dataset?: { value?: string } } }) { const value = event.currentTarget?.dataset?.value; if (value === 'ROUTINE' || value === 'SOON' || value === 'URGENT') this.setData({ consultationUrgency: value }); },
  createConsultation() {
    const id = patientId(); const topic = String(this.data.consultationTopic ?? '').trim(); const detail = String(this.data.consultationDetail ?? '').trim();
    if (!id || !topic || this.data.consultationSaving) { if (!topic) this.setData({ consultationError: '请先填写想咨询的主题。' }); return; }
    const expectedScopeKey = currentScopeKey(); const scopeGeneration = this.scopeGeneration;
    this.setData({ consultationSaving: true, consultationError: '' });
    request<unknown>(`/api/v1/patients/${encodeURIComponent(id)}/consultations`, 'POST', { topic, ...(detail ? { detail } : {}), urgency: this.data.consultationUrgency, idempotencyKey: `wx-consult-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` })
      .then(value => { if (!object(value) || !object(value.consultation)) throw new Error('服务未确认会诊申请。'); if (this.isCurrentScope(expectedScopeKey, scopeGeneration)) { this.setData({ consultationTopic: '', consultationDetail: '' }); wx.showToast({ title: '已发起会诊', icon: 'success' }); this.loadConsultations(expectedScopeKey); } })
      .catch(error => { if (this.isCurrentScope(expectedScopeKey, scopeGeneration)) this.setData({ consultationError: forbidden(error) ? '当前身份无权发起会诊申请。' : error instanceof Error ? error.message : '会诊申请未确认，请重试。' }); })
      .finally(() => { if (this.isCurrentScope(expectedScopeKey, scopeGeneration)) this.setData({ consultationSaving: false }); });
  },
  acknowledgeConsultation(event: { currentTarget?: { dataset?: { id?: string; version?: string } } }) {
    const id = event.currentTarget?.dataset?.id; const version = Number(event.currentTarget?.dataset?.version); const patient = patientId(); if (!id || !patient || !Number.isSafeInteger(version) || this.data.consultationSaving) return;
    const expectedScopeKey = currentScopeKey(); const scopeGeneration = this.scopeGeneration; this.setData({ consultationSaving: true, consultationError: '' });
    request<unknown>(`/api/v1/consultations/${encodeURIComponent(id)}/acknowledge`, 'POST', { expectedVersion: version, idempotencyKey: `wx-consult-ack-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, reason: '患者已收到回复，将按医嘱执行并在需要时反馈。' })
      .then(() => { if (this.isCurrentScope(expectedScopeKey, scopeGeneration)) { wx.showToast({ title: '已确认', icon: 'success' }); this.loadConsultations(expectedScopeKey); } })
      .catch(error => { if (this.isCurrentScope(expectedScopeKey, scopeGeneration)) this.setData({ consultationError: error instanceof Error ? error.message : '确认未完成，请重试。' }); })
      .finally(() => { if (this.isCurrentScope(expectedScopeKey, scopeGeneration)) this.setData({ consultationSaving: false }); });
  },
  refreshConsultations() { this.loadConsultations(); },
  refreshEmergency() { this.loadEmergency(); },
  loadEmergency(expectedScopeKey = currentScopeKey()) {
    if (this.data.emergencyLoading) return;
    const scopeGeneration = this.scopeGeneration;
    this.setData({ emergencyLoading: true, emergencyError: '' });
    Promise.allSettled([loadSupportPlan(), loadSupportKit(), loadSupportCard()]).then(results => {
      const [plan, kit, card] = results;
      const errors = results.filter(result => result.status === 'rejected').map(result => result.status === 'rejected' ? result.reason : null).filter((error): error is Error => error instanceof Error);
      if (this.isCurrentScope(expectedScopeKey, scopeGeneration)) { if (results.some(item => item.status === 'rejected' && forbidden(item.reason))) this.clearSensitiveState('当前身份无权查看应急资料，已清理本机敏感内容。'); else this.setData({ supportPlan: plan?.status === 'fulfilled' ? plan.value : null, supportKit: kit?.status === 'fulfilled' ? kit.value : null, supportCard: card?.status === 'fulfilled' ? card.value : null, emergencyError: errors.length ? errors[0]?.message ?? '部分应急资料暂不可用，请重新读取。' : '' }); }
    }).finally(() => { if (this.isCurrentScope(expectedScopeKey, scopeGeneration)) this.setData({ emergencyLoading: false }); });
  },
  openEmergency() { wx.navigateTo({ url: '/pages/patient/emergency' }); },
  openAssessment() { wx.navigateTo({ url: '/pages/patient/screening' }); },
  openCareInvite() { wx.navigateTo({ url: '/pages/patient/care-invite' }); },
  loadCrisis() {
    if (this.data.crisisLoading) return;
    this.setData({ crisisLoading: true, crisisError: '' });
    const expectedScopeKey = currentScopeKey(); const scopeGeneration = this.scopeGeneration;
    loadCrisisContacts().then(crisis => { if (this.isCurrentScope(expectedScopeKey, scopeGeneration)) this.setData({ crisis }); }).catch(error => { if (this.isCurrentScope(expectedScopeKey, scopeGeneration)) { if (forbidden(error)) this.clearSensitiveState('当前身份无权查看危机联系方式，已清理本机敏感内容。'); else this.setData({ crisis: null, crisisError: error instanceof Error ? error.message : '危机联系方式暂不可用。' }); } }).finally(() => { if (this.isCurrentScope(expectedScopeKey, scopeGeneration)) this.setData({ crisisLoading: false }); });
  },
  async callCrisis(event: { currentTarget: { dataset: { id?: string; phone?: string; kind?: string } } }) {
    const id = event.currentTarget.dataset.id; const phone = event.currentTarget.dataset.phone; const kind = event.currentTarget.dataset.kind;
    if (!id || !phone || !['HOTLINE', 'ON_CALL_CLINICIAN', 'AUTHORIZED_CONTACT'].includes(kind ?? '') || this.data.callingCrisisId) return;
    const action = kind === 'HOTLINE' ? 'CALLED_HOTLINE' : kind === 'ON_CALL_CLINICIAN' ? 'CALLED_CLINICIAN' : 'CALLED_CONTACT';
    const expectedScopeKey = currentScopeKey(); const scopeGeneration = this.scopeGeneration;
    // 先锁住当前联系人，避免用户快速连点导致重复记录拨号意图或打开多个拨号界面。
    this.setData({ callingCrisisId: id, crisisError: '' });
    try {
      // 先让服务端在当前授权、生命周期和联系人核验仍有效时记录拨号意图，
      // 再打开系统拨号。旧页面或已撤销的联系人不能直接触发 tel:。
      const receipt = await recordCrisisAction(id, action);
      if (!receipt.recorded || !this.isCurrentScope(expectedScopeKey, scopeGeneration)) throw new Error('身份已切换，未打开拨号。');
      const currentPhone = (this.data.crisis as CrisisView | null)?.contacts.find((contact) => contact.id === id)?.phone;
      if (currentPhone !== phone) throw new Error('联系方式已更新，请重新打开危机入口。');
      await makePhoneCall(phone);
    } catch (error) { if (this.isCurrentScope(expectedScopeKey, scopeGeneration)) this.setData({ crisis: null, crisisError: error instanceof Error ? error.message : '拨号未确认，请重新打开危机联系方式。' }); }
    finally { if (this.isCurrentScope(expectedScopeKey, scopeGeneration)) this.setData({ callingCrisisId: '' }); }
  },
  onDraft(event: { detail: { value?: string } }) {
    const body = event.detail.value ?? ''; const id = patientId();
    if (id && messageBody(body)) { const previous = pendingMessage(); savePending({ patientId: id, body, idempotencyKey: previous?.body === body ? previous.idempotencyKey : makeKey() }); } else clearPending();
    this.setData({ draft: body, pending: Boolean(id && messageBody(body)), error: '' });
  },
  sendMessage() {
    const id = patientId(); const body = String(this.data.draft ?? '').trim();
    if (!id || !messageBody(body) || this.data.sending) return;
    if (this.data.careCapabilities?.canMessageCareTeam !== true) { this.setData({ error: this.data.careCapabilities?.canMessageCareTeam === false ? '当前没有医护收件人。内容已留在本机，可邀请医生加入，或在就诊时出示；紧急情况请直接就医。' : '尚未确认照护团队接收状态，请重新读取后再发送。' }); return; }
    const expectedScopeKey = currentScopeKey(); const scopeGeneration = this.scopeGeneration;
    const generation = ++this.sendGeneration;
    const active = () => this.isCurrentScope(expectedScopeKey, scopeGeneration) && generation === this.sendGeneration;
    const previous = pendingMessage();
    const command: PendingMessage = previous && previous.patientId === id && previous.body === body ? previous : { patientId: id, body, idempotencyKey: makeKey() };
    savePending(command); this.setData({ sending: true, pending: true, error: '' });
    request<unknown>(`/api/v1/patients/${encodeURIComponent(id)}/messages`, 'POST', { idempotencyKey: command.idempotencyKey, kind: 'FREE_TEXT', body: command.body })
      .then(value => {
        if (!object(value) || !object(value.message) || value.message.patientId !== id || value.message.body !== body) throw new Error('服务未确认消息内容，这条已留在本机，可以直接重试。');
        if (!active()) throw new Error('身份已切换，消息结果未应用。');
        clearPending(); this.setData({ draft: '', pending: false }); wx.showToast({ title: '已发送', icon: 'success' }); this.load();
      })
      .catch(error => {
        if (!active()) return;
        if (forbidden(error)) this.clearSensitiveState('当前身份无权发送消息，已清理本机敏感内容。');
        else if (error instanceof ApiFailure && error.code === 'MESSAGE_NO_RECIPIENT') this.setData({ careCapabilities: { canMessageCareTeam: false, hasTreatmentClinician: false }, error: '当前没有医护收件人，消息未发送。内容已保留，可邀请医生加入，或在就诊时出示。' });
        else this.setData({ error: error instanceof Error ? error.message : '消息未确认，原内容已保留，可重试。' });
      }).finally(() => { if (active()) this.setData({ sending: false }); });
  },
  sendRead(entry: MutationEntry, expectedScopeKey: string, scopeGeneration: number): Promise<void> {
    const current = session(); const id = patientId();
    if (!current || !id || !this.isCurrentScope(expectedScopeKey, scopeGeneration)) return Promise.reject(new ApiFailure('身份已切换，请刷新当前页面。', 409));
    const target = entry.payload.resourceId;
    if (typeof target !== 'string' || !target) return Promise.reject(new Error('已读目标无效。'));
    const path = entry.operation === 'MESSAGE_READ' ? `messages/${encodeURIComponent(target)}/read` : `education/${encodeURIComponent(target)}/read`;
    return request<unknown>(`/api/v1/patients/${encodeURIComponent(id)}/${path}`, 'POST', { idempotencyKey: entry.idempotencyKey }).then(value => {
      if (!object(value)) throw new Error('已读回执不完整，这条已留在本机，可以直接重试。');
    });
  },
  readResource(operation: 'MESSAGE_READ' | 'EDUCATION_READ', resourceId: string) {
    if (this.data.readSaving || !resourceId || !this.outbox) return;
    const current = session(); const id = patientId(); if (!current || !id) return;
    const expectedScopeKey = currentScopeKey(); const scopeGeneration = this.scopeGeneration;
    const active = () => this.isCurrentScope(expectedScopeKey, scopeGeneration);
    const idempotencyKey = newIdempotencyKey(operation);
    const payload = { resourceId, idempotencyKey };
    try { this.outbox.enqueue({ operation, idempotencyKey, payload }); } catch (error) { this.setData({ error: error instanceof Error ? error.message : '已读操作未保存。' }); return; }
    this.setData({ readSaving: true, error: '' });
    this.outbox.flush((entry: MutationEntry) => this.sendRead(entry, expectedScopeKey, scopeGeneration), true, [operation]).then((result: { denied: boolean; networkError: boolean }) => {
      if (!active()) return;
      if (result.denied) { this.clearSensitiveState('当前身份无权更新已读状态，本机敏感内容已清理。'); return; }
      if (result.networkError) { this.setData({ error: '网络未确认已读状态，已留在本机，请稍后重试。' }); return; }
      this.load();
    }).catch((error: unknown) => { if (!active()) return; if (forbidden(error)) this.clearSensitiveState('当前身份已失效，支持内容已清理。'); else this.setData({ error: error instanceof Error ? error.message : '已读状态未确认，这条已留在本机，可以直接重试。' }); }).finally(() => { if (active()) this.setData({ readSaving: false }); });
  },
  readMessage(event: { currentTarget?: { dataset?: { id?: unknown } } }) { const id = event.currentTarget?.dataset?.id; if (typeof id === 'string') this.readResource('MESSAGE_READ', id); },
  readEducation(event: { currentTarget?: { dataset?: { id?: unknown } } }) { const id = event.currentTarget?.dataset?.id; if (typeof id === 'string') this.readResource('EDUCATION_READ', id); },
});
