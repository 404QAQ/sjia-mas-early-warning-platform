import { patientId, request, session } from '../../api';
import { ApiFailure } from '../../api';
import { at } from '../../date-format.js';
import { MutationOutbox, deniedOperations, newIdempotencyKey, wxStorage, type MutationEntry } from '../../mutation-outbox';

type VisitStatus = 'PENDING' | 'AVAILABLE' | 'SUBMITTED' | 'EXPIRED';
interface Question { code: string; prompt: string; options: Array<{ label: string; value: string }> }
interface Answer extends Question { selected: string; selectedLabel: string; selectedIndex: number }
interface Visit { id: string; startsAt: string; status: VisitStatus; expiresAt?: string }
interface Form { patientId: string; questionnaireVersion: number; frequency: 'PER_VISIT'; respondentRelation: 'SELF' | 'LEGAL_GUARDIAN'; title: string; intro: string; questions: Question[]; visits: Visit[] }
interface Scope { userId: string; actorId: string; patientId: string }
interface ReferralSlot { id: string; label: string }
interface NextStep { screeningId: string; status: 'OFFERED' | 'ACCEPTED_PENDING_BOOKING' | 'DECLINED' | 'SUPPRESSED' | 'UNAVAILABLE'; slots: ReferralSlot[]; selectedSlotId?: string }

const ANSWERS = [
  { label: '从未', value: 'NEVER' }, { label: '有时', value: 'SOMETIMES' }, { label: '经常', value: 'OFTEN' },
  { label: '总是', value: 'ALWAYS' }, { label: '是', value: 'YES' }, { label: '否', value: 'NO' },
  { label: '低', value: 'LOW' }, { label: '中', value: 'MEDIUM' }, { label: '高', value: 'HIGH' }, { label: '不想回答', value: 'DECLINED' },
];

/** 仅调整问句对应的作答文案，沿用现有频次编码，不产生量表或分数。 */
function questionOptions(code: string): Question['options'] {
  const labels = code.endsWith('_SLEEP') ? ['没有睡眠困扰', '偶尔睡不好', '经常睡不好', '几乎一直睡不好']
    : code.endsWith('_ENERGY') ? ['精力充足', '偶尔精力不足', '经常精力不足', '几乎一直精力不足']
      : code.endsWith('_LOW_MOOD') ? ['状态平稳', '偶尔感到低落', '经常感到低落', '几乎一直感到低落']
        : code.endsWith('_SUPPORT') ? ['没有人能帮忙', '偶尔有人能帮忙', '经常有人能帮忙', '一直有人能帮忙']
          : code.endsWith('_DAILY') ? ['没有影响', '偶尔有影响', '经常有影响', '几乎一直有影响']
            : ['从未', '有时', '经常', '几乎一直'];
  return [
    ...['NEVER', 'SOMETIMES', 'OFTEN', 'ALWAYS'].map((value, index) => ({ value, label: labels[index]! })),
    { label: '不想回答', value: 'DECLINED' },
  ];
}

function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function text(value: unknown, max = 1000): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value); }
function instant(value: unknown): value is string { return text(value, 80) && Number.isFinite(Date.parse(value)); }
function scope(): Scope | null { const current = session(); const id = patientId(); return current && id ? { userId: current.userId, actorId: current.actorId, patientId: id } : null; }
function sameScope(value: Scope): boolean { const current = scope(); return Boolean(current && current.userId === value.userId && current.actorId === value.actorId && current.patientId === value.patientId); }
function parseForm(value: unknown, expectedPatient: string): Form | null {
  if (!object(value) || value.patientId !== expectedPatient || !Number.isSafeInteger(value.questionnaireVersion) || value.frequency !== 'PER_VISIT' || !['SELF', 'LEGAL_GUARDIAN'].includes(String(value.respondentRelation)) || !text(value.title, 300) || !text(value.intro, 4000) || !Array.isArray(value.questions) || value.questions.length < 1 || value.questions.length > 8 || !Array.isArray(value.visits)) return null;
  const questionnaireVersion = value.questionnaireVersion; const respondentRelation = value.respondentRelation; const title = value.title; const intro = value.intro;
  if (typeof questionnaireVersion !== 'number' || questionnaireVersion < 1 || typeof respondentRelation !== 'string' || typeof title !== 'string' || typeof intro !== 'string') return null;
  const questions: Question[] = [];
  for (const item of value.questions) { if (!object(item) || !text(item.code, 80) || !text(item.prompt, 1000)) return null; questions.push({ code: item.code, prompt: item.prompt, options: questionOptions(item.code) }); }
  const visits: Visit[] = [];
  for (const item of value.visits) { if (!object(item) || !text(item.id, 200) || !instant(item.startsAt) || !['PENDING', 'AVAILABLE', 'SUBMITTED', 'EXPIRED'].includes(String(item.status)) || (item.expiresAt !== undefined && !instant(item.expiresAt))) return null; visits.push({ id: item.id, startsAt: item.startsAt, status: item.status as VisitStatus, ...(item.expiresAt === undefined ? {} : { expiresAt: item.expiresAt }) }); }
  return { patientId: expectedPatient, questionnaireVersion, frequency: 'PER_VISIT', respondentRelation: respondentRelation as Form['respondentRelation'], title, intro, questions, visits };
}
function availableVisit(form: Form): Visit | null { const now = Date.now(); return form.visits.find(item => item.status === 'AVAILABLE' && (!item.expiresAt || Date.parse(item.expiresAt) > now)) ?? null; }
function describe(error: unknown, fallback: string): string { return error instanceof Error ? error.message : fallback; }

function parseNextStep(value: unknown, expectedScreeningId: string): NextStep | null {
  if (!object(value) || value.screeningId !== expectedScreeningId || (value.referral !== undefined && !object(value.referral))) return null;
  if (Object.keys(value).some(key => !['screeningId', 'referral'].includes(key))) return null;
  if (value.referral === undefined) return { screeningId: expectedScreeningId, status: 'SUPPRESSED', slots: [] };
  const referral = value.referral;
  if (Object.keys(referral).some(key => !['status', 'offeredSlots', 'selectedSlotId', 'decidedAt'].includes(key))) return null;
  if (!['OFFERED', 'ACCEPTED_PENDING_BOOKING', 'DECLINED', 'SUPPRESSED', 'UNAVAILABLE'].includes(String(referral.status)) || !Array.isArray(referral.offeredSlots) || referral.offeredSlots.length > 20) return null;
  const slots: ReferralSlot[] = [];
  for (const slot of referral.offeredSlots) {
    if (!object(slot) || Object.keys(slot).some(key => !['id', 'startsAt', 'endsAt', 'department', 'clinicianName'].includes(key)) || !text(slot.id, 200) || !instant(slot.startsAt) || !instant(slot.endsAt) || !text(slot.department, 200) || !text(slot.clinicianName, 200)) return null;
    slots.push({ id: slot.id, label: `${at(slot.startsAt)}–${at(slot.endsAt)} · ${slot.department} · ${slot.clinicianName}` });
  }
  if (referral.selectedSlotId !== undefined && !text(referral.selectedSlotId, 200)) return null;
  return { screeningId: expectedScreeningId, status: referral.status as NextStep['status'], slots, ...(referral.selectedSlotId === undefined ? {} : { selectedSlotId: referral.selectedSlotId }) };
}

/** 微信 picker 的 change 事件返回所选项的下标，而不是答案编码。 */
function pickerOption(options: Question['options'], rawValue: unknown): Question['options'][number] | null {
  const index = typeof rawValue === 'number' && Number.isSafeInteger(rawValue)
    ? rawValue
    : typeof rawValue === 'string' && /^\d+$/.test(rawValue) && Number.isSafeInteger(Number(rawValue))
      ? Number(rawValue)
      : null;
  if (index !== null) return options[index] ?? null;
  return null;
}

Page({
  data: {
    loading: true, saving: false, responseLoading: false, referralSaving: false, error: '', notice: '', crisisSupport: false, scopeKey: '', form: null as Form | null, visit: null as Visit | null,
    nextStep: null as NextStep | null, answers: [] as Answer[], visitDateLabel: '', answeredCount: 0, assessmentState: '待完成', assessmentDetail: '复诊前用 1 分钟完成，支持“不想回答”。', responseTitle: '提交后的安排', pendingCount: 0, rejectedCount: 0,
    canWriteDiary: false, visitHistory: [] as Array<{ id: string; date: string; status: string }>,
  },
  outbox: null as MutationOutbox | null, currentScope: null as Scope | null, latestScreeningId: null as string | null,
  onLoad() {
    this.syncScope();
  },
  onShow() {
    this.syncScope();
  },
  syncScope() {
    if (!session()) { this.latestScreeningId = null; this.setData({ scopeKey: '', loading: false, form: null, visit: null, nextStep: null, answers: [], crisisSupport: false }); wx.redirectTo({ url: '/pages/auth/index' }); return; }
    const current = scope();
    if (!current) { this.currentScope = null; this.outbox = null; this.latestScreeningId = null; this.setData({ scopeKey: '', loading: false, form: null, visit: null, nextStep: null, answers: [], crisisSupport: false, error: '当前微信身份尚未绑定患者档案。' }); return; }
    const key = JSON.stringify([current.userId, current.actorId, current.patientId]);
    if (key === this.data.scopeKey) return;
    this.currentScope = current;
    this.latestScreeningId = null;
    this.outbox = new MutationOutbox(wxStorage(), current.actorId, current.patientId, current.userId);
    this.setData({ scopeKey: key, loading: true, saving: false, responseLoading: false, referralSaving: false, error: '', notice: '', crisisSupport: false, form: null, visit: null, nextStep: null, answers: [], answeredCount: 0, assessmentState: '读取中', assessmentDetail: '正在确认当前复诊窗口…', pendingCount: 0, rejectedCount: 0, canWriteDiary: session()?.role === 'PATIENT', visitHistory: [] });
    this.refreshQueue();
    this.load();
  },
  refreshQueue() { try { const rows: MutationEntry[] = this.outbox?.entries().filter((item: MutationEntry) => item.operation === 'PSYCH_SCREENING') ?? []; this.setData({ pendingCount: rows.filter((item: MutationEntry) => item.state === 'PENDING').length, rejectedCount: rows.filter((item: MutationEntry) => item.state === 'REJECTED').length }); } catch (error: unknown) { this.setData({ error: describe(error, '本机问卷队列不可读。') }); } },
  load() {
    const current = this.currentScope as Scope | null;
    if (!current || !sameScope(current)) { this.setData({ loading: false, error: '身份已切换，请返回首页后重新打开。' }); return; }
    this.setData({ loading: true, error: '', notice: '', form: null, visit: null, nextStep: null, answers: [], answeredCount: 0, assessmentState: '读取中', assessmentDetail: '正在确认当前复诊窗口…' });
    request<unknown>(`/api/v1/patients/${encodeURIComponent(current.patientId)}/psych-screening-form`).then(value => {
      if (!sameScope(current)) throw new ApiFailure('身份已切换，请刷新当前页面。', 409);
      const form = parseForm(value, current.patientId); if (!form) throw new Error('复诊前问卷响应格式无效。');
      const visit = availableVisit(form);
      const answers = visit ? form.questions.map(item => ({ code: item.code, prompt: item.prompt, options: item.options, selected: '', selectedLabel: '', selectedIndex: 0 })) : [];
      const submitted = form.visits.some(item => item.status === 'SUBMITTED');
      const visitHistory = form.visits.filter(item => item.status === 'SUBMITTED').sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt)).slice(0, 5).map(item => ({ id: item.id, date: at(item.startsAt), status: '已完成记录' }));
      this.setData({ form, visit, visitDateLabel: visit ? at(visit.startsAt) : '', answers, visitHistory, assessmentState: visit ? '待完成' : submitted ? '已完成' : '暂未开放', assessmentDetail: visit ? '逐题选择后提交，内容会进入当前照护档案。' : submitted ? '本次已提交，复诊前可以再次查看安排。' : '当前没有已开放的复诊事项，可先记下就诊时要沟通的问题。' });
    }).catch(error => { if (sameScope(current)) this.setData({ error: describe(error, '复诊前事项暂不可用。') }); }).finally(() => { if (sameScope(current)) this.setData({ loading: false }); });
  },
  selectAnswer(event: { currentTarget?: { dataset?: { code?: unknown; index?: unknown } }; detail?: { value?: unknown } }) {
    if (this.data.saving) return;
    const code = event.currentTarget?.dataset?.code; const rawValue = event.detail?.value ?? event.currentTarget?.dataset?.index;
    if (typeof code !== 'string') return;
    const answers = this.data.answers as Answer[];
    const answer = answers.find(item => item.code === code);
    const option = answer ? pickerOption(answer.options, rawValue) : null;
    if (!answer || !option || !ANSWERS.some(item => item.value === option.value)) return;
    const nextAnswers = answers.map(item => item.code === code ? { ...item, selected: option.value, selectedLabel: option.label, selectedIndex: item.options.indexOf(option) } : item);
    this.setData({ answers: nextAnswers, answeredCount: nextAnswers.filter(item => Boolean(item.selected)).length, error: '' });
  },
  sendEntry(entry: MutationEntry): Promise<void> {
    const current = this.currentScope as Scope | null; if (!current || !sameScope(current) || entry.operation !== 'PSYCH_SCREENING') return Promise.reject(new ApiFailure('身份已切换，请刷新当前页面。', 409));
    const payload = entry.payload;
    return request<unknown>(`/api/v1/patients/${encodeURIComponent(current.patientId)}/psych-screenings`, 'POST', payload).then(value => {
      if (!object(value) || typeof value.created !== 'boolean' || !object(value.screening) || value.screening.patientId !== current.patientId || value.screening.visitId !== payload.visitId) throw new Error('服务未确认问卷回执，这条已留在本机，可以直接重试。');
      // 服务端只下发「是否需要走危机路径」这一个布尔量，不下发具体条目：
      // 这既不让患者端看到量表细节，也避免回执变成一句误导性的「已提交给医生」。
      if (value.screening.crisisSupportRequired === true && sameScope(current)) this.setData({ crisisSupport: true });
      if (typeof value.screening.id === 'string' && value.screening.id.length > 0 && sameScope(current)) this.latestScreeningId = value.screening.id;
    });
  },
  loadNextStep(screeningId: string) {
    const current = this.currentScope as Scope | null;
    if (!current || !sameScope(current) || !screeningId) return;
    this.setData({ responseLoading: true });
    request<unknown>(`/api/v1/patients/${encodeURIComponent(current.patientId)}/psych-screenings/${encodeURIComponent(screeningId)}/response`).then(value => {
      const nextStep = parseNextStep(value, screeningId);
      if (!nextStep) throw new Error('提交后的安排响应格式无效。');
      if (sameScope(current)) this.setData({ nextStep });
    }).catch(error => { if (sameScope(current) && !(error instanceof ApiFailure && error.status === 404)) this.setData({ error: describe(error, '提交后的安排暂时不可用，请稍后刷新。') }); }).finally(() => { if (sameScope(current)) this.setData({ responseLoading: false }); });
  },
  chooseReferral(event: { currentTarget?: { dataset?: { id?: unknown } } }) {
    const slotId = event.currentTarget?.dataset?.id;
    const current = this.currentScope as Scope | null;
    const nextStep = this.data.nextStep as NextStep | null;
    if (typeof slotId !== 'string' || !current || !nextStep || nextStep.status !== 'OFFERED' || !nextStep.slots.some(item => item.id === slotId) || this.data.referralSaving || !sameScope(current)) return;
    const idempotencyKey = newIdempotencyKey('PSYCH_SCREENING');
    this.setData({ referralSaving: true, error: '' });
    request<unknown>(`/api/v1/patients/${encodeURIComponent(current.patientId)}/psych-screenings/${encodeURIComponent(nextStep.screeningId)}/referral`, 'POST', { decision: 'ACCEPT', slotId, idempotencyKey }).then(value => {
      if (!object(value) || !object(value.response)) throw new Error('服务未确认支持时段选择。');
      const updated = parseNextStep(value.response, nextStep.screeningId);
      if (!updated) throw new Error('支持时段回执格式无效。');
      if (sameScope(current)) this.setData({ nextStep: updated, notice: '已记录你的选择，最终预约仍需照护团队确认。' });
    }).catch(error => { if (sameScope(current)) this.setData({ error: describe(error, '支持时段选择失败，请稍后重试。') }); }).finally(() => { if (sameScope(current)) this.setData({ referralSaving: false }); });
  },
  flush(retryRejected = false) {
    if (this.data.saving || !this.outbox) return; const current = this.currentScope as Scope | null; if (!current || !sameScope(current)) return;
    this.setData({ saving: true, error: '', notice: '', crisisSupport: false }); this.outbox.flush((entry: MutationEntry) => this.sendEntry(entry), retryRejected, ['PSYCH_SCREENING']).then((result: { sent: number; networkError: boolean; denied: boolean }) => {
      if (result.denied) { try { this.outbox?.clear(deniedOperations(['PSYCH_SCREENING'], Boolean(session()))); } catch { /* keep denial visible */ } this.setData({ error: '当前身份无权提交问卷，本机未确认内容已清理。', form: null, visit: null, answers: [] }); }
      else if (result.networkError) this.setData({ notice: '网络未确认服务端是否收到，问卷已保留，恢复网络后可重试。' });
      else if (result.sent > 0) {
        // 命中危机条目时回执必须分流：不能只说「已提交给医生」，
        // 那会被自伤意念者读成已经有人接手。
        const screeningId = this.latestScreeningId;
        this.load();
        if (screeningId) this.loadNextStep(screeningId);
        this.setData({ assessmentState: '已提交', assessmentDetail: '内容已进入当前照护档案，可在复诊时与医生一起查看。', responseTitle: this.data.crisisSupport ? '现在可以获得支持' : '提交后的安排', notice: this.data.crisisSupport ? '已提交。下面有现在可以联系的真人，你现在就可以打。' : '复诊前事项已记录；这不代表医生已经查看或接手。' });
      }
      this.refreshQueue();
    }).catch((error: unknown) => this.setData({ error: describe(error, '问卷队列同步失败。') })).finally(() => this.setData({ saving: false }));
  },
  submit() {
    const current = this.currentScope as Scope | null; const form = this.data.form as Form | null; const visit = this.data.visit as Visit | null; const answers = this.data.answers as Answer[];
    if (!current || !form || !visit || this.data.saving || !sameScope(current)) return;
    if (answers.some(item => !item.selected)) { this.setData({ error: '请逐题选择“回答”或“不想回答”。' }); return; }
    const idempotencyKey = newIdempotencyKey('PSYCH_SCREENING');
    const payload = { visitId: visit.id, answers: answers.map(item => item.selected === 'DECLINED' ? { code: item.code, status: 'DECLINED' } : { code: item.code, status: 'ANSWERED', valueCoded: item.selected }), questionnaireVersion: form.questionnaireVersion, frequency: form.frequency, respondentRelation: form.respondentRelation, prescreenWindow: { trigger: 'PRE_VISIT', visitId: visit.id }, idempotencyKey };
    try { this.outbox?.enqueue({ operation: 'PSYCH_SCREENING', idempotencyKey, payload }); } catch (error) { this.setData({ error: describe(error, '无法保存问卷，请稍后重试。') }); return; }
    this.refreshQueue(); this.flush();
  },
  retry() { this.flush(true); },
  openCrisis() { wx.navigateTo({ url: '/pages/patient/support?section=crisis' }); },
  openCareMessage() { wx.navigateTo({ url: '/pages/patient/support?section=messages' }); },
  openPrivateDiary() { if (session()?.role === 'PATIENT') wx.navigateTo({ url: '/pages/patient/health?section=diary' }); },
});
