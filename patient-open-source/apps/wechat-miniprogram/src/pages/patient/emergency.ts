import { parseCareCapabilities, type CareCapabilities } from '../../care-capabilities';
import { ApiFailure, patientId, request, session } from '../../api';
import { API_BASE } from '../../config';
import { at as beijingDateTime } from '../../date-format.js';
import {
  createSupportShare, listSupportShares, loadSupportCard, loadSupportKit, loadSupportPlan, mutateSupportCard, mutateSupportKit, mutateSupportPlan, revokeSupportShare,
  type SupportCard, type SupportKit, type SupportPlan, type SupportPlanCommand, type SupportShare, type SupportShareRecipientHint,
} from '../../support';
import { MutationOutbox, deniedOperations, newIdempotencyKey, wxStorage, type MutationEntry, type MutationOperation } from '../../mutation-outbox';

interface Scope { userId: string; actorId: string; patientId: string; }
const PLAN_OP: MutationOperation = 'EMERGENCY_PLAN';
const KIT_OP: MutationOperation = 'EMERGENCY_KIT';
const CARD_OP: MutationOperation = 'EMERGENCY_CARD';
const SHARE_OP: MutationOperation = 'EMERGENCY_SHARE';
const PLAN_STATUS_LABELS: Record<SupportPlan['status'], string> = { DRAFT: '草稿待完善', PENDING_CLINICIAN: '等待医生确认', CONFIRMED: '医生已确认' };
const KIT_STATUS_LABELS: Record<SupportKit['status'], string> = { NOT_VERIFIED: '待家庭核对', CURRENT: '已核对', DUE: '需要再次核对' };
const NIGHT_LABELS: Record<string, string> = { TRUE: '可以夜间收治', FALSE: '不能夜间收治', UNKNOWN: '待医生确认' };
const TRANSPORT_LABELS: Record<string, string> = { DRIVE: '自驾', TAXI: '出租车 / 网约车', AMBULANCE: '救护车', OTHER: '其他方式' };
const RECIPIENTS: Array<{ code: SupportShareRecipientHint; label: string; selected: boolean }> = [
  { code: 'GRANDPARENT', label: '祖父母/家中长辈', selected: false },
  { code: 'BABYSITTER', label: '照护者/临时陪同人', selected: false },
  { code: 'FRIEND', label: '可信任朋友', selected: false },
];
function text(value: unknown, max = 500): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\0\r\n]/.test(value); }
function scopeNow(): Scope | null { const current = session(); const id = patientId(); return current && id ? { userId: current.userId, actorId: current.actorId, patientId: id } : null; }
function scopeKey(scope: Scope | null): string { return scope ? `${scope.userId}:${scope.actorId}:${scope.patientId}` : ''; }
function sameScope(scope: Scope): boolean { const latest = scopeNow(); return Boolean(latest && scopeKey(latest) === scopeKey(scope)); }
function toNumber(value: unknown, fallback = 0): number { const number = Number(value); return Number.isFinite(number) ? number : fallback; }
function errorText(value: unknown, fallback: string): string { return value instanceof Error ? value.message : fallback; }
function forbidden(value: unknown): boolean { return value instanceof ApiFailure && [401, 403].includes(value.status); }
function outboxFor(scope: Scope): MutationOutbox { return new MutationOutbox(wxStorage(), scope.actorId, scope.patientId, scope.userId); }
function checkedValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value === 'true' || value === '1';
  return fallback;
}
function caregiverFromPage(page: MiniPageContext): Record<string, unknown> {
  const data = page.data;
  const hospital: Record<string, unknown> = { name: String(data.hospitalName ?? '').trim(), address: String(data.hospitalAddress ?? '').trim(), nightCapable: String(data.hospitalNightCapable ?? 'UNKNOWN') };
  const route = { minutesNight: toNumber(data.routeNight), minutesDay: toNumber(data.routeDay), notes: String(data.routeNotes ?? '').trim() };
  const transport = { primary: String(data.transportPrimary ?? 'DRIVE'), backup: String(data.transportBackup ?? '').trim(), driverName: String(data.driverName ?? '').trim(), driverPhone: String(data.driverPhone ?? '').trim() };
  return { primaryHospital: hospital, route, transport, customThresholds: [] };
}
function planForm(plan: SupportPlan | null): Record<string, unknown> {
  return { hospitalName: plan?.hospital?.name ?? '', hospitalAddress: plan?.hospital?.address ?? '', hospitalNightCapable: plan?.hospital?.nightCapable ?? 'UNKNOWN', locationKey: plan?.locationKey ?? '', routeNight: plan?.route ? String(plan.route.minutesNight) : '', routeDay: plan?.route ? String(plan.route.minutesDay) : '', routeNotes: plan?.route?.notes ?? '', transportPrimary: plan?.transport?.primary ?? 'DRIVE', transportBackup: plan?.transport?.backup ?? '', driverName: plan?.transport?.driverName ?? '', driverPhone: plan?.transport?.driverPhone ?? '', nightText: NIGHT_LABELS[plan?.hospital?.nightCapable ?? 'UNKNOWN'], transportText: TRANSPORT_LABELS[plan?.transport?.primary ?? 'DRIVE'] ?? '其他方式' };
}
function kitForm(kit: SupportKit | null): Record<string, unknown> { return { kitLocation: kit?.locationNote ?? '', familyInformed: kit?.familyInformed ?? false }; }
const PLAN_FORM_FIELDS = Object.keys(planForm(null));
const KIT_FORM_FIELDS = Object.keys(kitForm(null));
function formSnapshot(data: Record<string, unknown>, fields: string[]): string { return JSON.stringify(fields.map(field => data[field])); }
function selectedRecipients(page: MiniPageContext): SupportShareRecipientHint[] { return (page.data.recipients as Array<{ code: SupportShareRecipientHint; selected: boolean }>).filter(item => item.selected).map(item => item.code); }
function cardReadiness(plan: SupportPlan | null, kit: SupportKit | null, canPlanWrite: boolean) {
  const blocked = (cardPrerequisiteHint: string, cardSetupTarget: 'plan' | 'kit', cardSetupLabel: string) => ({ cardReady: false, cardPrerequisiteHint, cardSetupTarget, cardSetupLabel });
  if (!plan || plan.status === 'DRAFT') return blocked(canPlanWrite ? '先填写家庭应急预案，提交医生确认后即可继续。' : '请患者本人或法定监护人填写家庭应急预案，并提交医生确认。', 'plan', canPlanWrite ? '去完善家庭预案' : '查看家庭预案');
  if (plan.status === 'PENDING_CLINICIAN') return blocked('家庭预案已提交，等待医生确认后即可继续。', 'plan', '查看待确认预案');
  // 医生确认值独立于家庭填写的夜间收治选项，不能用后者代替。
  if (plan.clinicianNightCapable !== 'TRUE') return blocked('请联系医生确认医院的夜间收治能力，再生成流程卡。', 'plan', '查看家庭预案');
  if (!plan.hospital || !plan.route || !plan.triageScript?.trim()) return blocked('家庭预案资料不完整，请联系医生核对医院、路线与分诊话术。', 'plan', '查看家庭预案');
  if (!kit || kit.patientId !== plan.patientId || !kit.locationNote?.trim()) return blocked('请先保存急诊包的存放位置，再生成流程卡。', 'kit', '去准备急诊包');
  return { cardReady: true, cardPrerequisiteHint: '', cardSetupTarget: '', cardSetupLabel: '' };
}
const EMPTY_CARD_READINESS = { cardReady: false, cardPrerequisiteHint: '', cardSetupTarget: '', cardSetupLabel: '' };

// 与 domain/emergency-plan.ts、emergency-card.ts 的通用指引保持一致；不依赖个人正式卡。
export const GENERAL_EMERGENCY_GUIDANCE = {
  thresholds: [
    { code: 'SEIZURE', label: '抽搐 / 意识不清 / 叫不醒' },
    { code: 'HIGH_FEVER_DULL', label: '持续高热 + 精神明显变差' },
    { code: 'BLEEDING', label: '出血表现（牙龈 / 鼻血不止 / 瘀点）' },
    { code: 'SEVERE_HEADACHE', label: '剧烈头痛 / 呕吐不止' },
  ],
  canDo: ['物理降温 / 按医嘱退烧', '少量多次补水', '记录体温与症状（到医院直接可用）', '皮疹 / 出血点拍照留证', '保持安静、减少刺激'],
  neverDo: ['不要自行加大激素剂量', '不要自行停激素', '不要自行用抗生素'],
};

Page({
  data: {
    loading: true,
    generalGuidance: GENERAL_EMERGENCY_GUIDANCE,
    careCapabilities: null as CareCapabilities | null,
    saving: false,
    syncing: false,
    error: '',
    message: '',
    scopeKey: '',
    plan: null as SupportPlan | null,
    kit: null as SupportKit | null,
    card: null as SupportCard | null,
    canPlanWrite: false,
    canKitWrite: false,
    canCardWrite: false,
    canShare: false,
    hospitalName: '', hospitalAddress: '', hospitalNightCapable: 'UNKNOWN', locationKey: '', routeNight: '', routeDay: '', routeNotes: '',
    transportPrimary: 'DRIVE', transportBackup: '', driverName: '', driverPhone: '',
    kitLocation: '', familyInformed: false,
    recipients: RECIPIENTS.map(item => ({ ...item })),
    shareCode: '', sharePath: '',
    shares: [] as SupportShare[],
    pendingCount: 0,
    rejectedCount: 0,
    planSettingsOpen: false,
    shareSettingsOpen: false,
    planStatusText: '尚未建立',
    kitStatusText: '尚未建立',
    cardStatusText: '待生成',
    cardGeneratedText: '',
    nightText: '待医生确认',
    transportText: '自驾',
    exporting: false,
    exportNotice: '',
    ...EMPTY_CARD_READINESS,
  },
  scope: null as Scope | null,
  outbox: null as MutationOutbox | null,
  downloadTask: null as { abort(): void } | null,
  exportGeneration: 0,
  loadGeneration: 0,
  planDraftBaseline: formSnapshot(planForm(null), PLAN_FORM_FIELDS),
  kitDraftBaseline: formSnapshot(kitForm(null), KIT_FORM_FIELDS),

  onLoad() { this.onShow(); },
  onShow() {
    const current = session();
    if (!current) { this.scope = null; this.outbox = null; this.clearSensitiveState(); this.setData({ scopeKey: '', syncing: false, canPlanWrite: false, canKitWrite: false, canCardWrite: false, canShare: false }); wx.redirectTo({ url: '/pages/auth/index' }); return; }
    if ((current.role as string) === 'CLINICIAN') { this.scope = null; this.outbox = null; this.clearSensitiveState('医生账号请使用医生端，家庭设置不对医生开放。'); this.setData({ scopeKey: '', syncing: false, canPlanWrite: false, canKitWrite: false, canCardWrite: false, canShare: false }); return; }
    const scope = scopeNow();
    if (!scope) { this.scope = null; this.outbox = null; this.clearSensitiveState('当前微信身份尚未绑定患者档案。'); this.setData({ scopeKey: '', syncing: false, canPlanWrite: false, canKitWrite: false, canCardWrite: false, canShare: false }); return; }
    const key = scopeKey(scope);
    if (key !== this.data.scopeKey) { this.cancelExport(); this.planDraftBaseline = formSnapshot(planForm(null), PLAN_FORM_FIELDS); this.kitDraftBaseline = formSnapshot(kitForm(null), KIT_FORM_FIELDS); this.scope = scope; this.outbox = outboxFor(scope); this.setData({ scopeKey: key, hospitalName: '', hospitalAddress: '', hospitalNightCapable: 'UNKNOWN', locationKey: '', routeNight: '', routeDay: '', routeNotes: '', transportPrimary: 'DRIVE', transportBackup: '', driverName: '', driverPhone: '', kitLocation: '', familyInformed: false, recipients: RECIPIENTS.map(item => ({ ...item })), nightText: '待医生确认', transportText: '自驾', pendingCount: 0, rejectedCount: 0, saving: false, syncing: false, plan: null, kit: null, card: null, shares: [], canPlanWrite: ['PATIENT', 'LEGAL_GUARDIAN'].includes(current.role), canKitWrite: ['PATIENT', 'LEGAL_GUARDIAN', 'CAREGIVER'].includes(current.role), canCardWrite: ['PATIENT', 'LEGAL_GUARDIAN', 'CAREGIVER'].includes(current.role), canShare: ['PATIENT', 'LEGAL_GUARDIAN'].includes(current.role), shareCode: '', sharePath: '', error: '', message: '', planSettingsOpen: false, shareSettingsOpen: false, planStatusText: '尚未建立', kitStatusText: '尚未建立', cardStatusText: '待生成', cardGeneratedText: '', ...EMPTY_CARD_READINESS }); this.refreshQueue(); this.load(scope); }
    else if (!this.data.loading && !this.data.syncing) this.load(scope);
  },
  clearSensitiveState(message = '') {
    this.cancelExport();
    this.loadGeneration += 1;
    this.planDraftBaseline = formSnapshot(planForm(null), PLAN_FORM_FIELDS);
    this.kitDraftBaseline = formSnapshot(kitForm(null), KIT_FORM_FIELDS);
    try { this.outbox?.clear(deniedOperations([PLAN_OP, KIT_OP, CARD_OP, SHARE_OP], Boolean(session()))); } catch { /* 清理失败不能阻止内存投影清除 */ }
    this.setData({ careCapabilities: null, plan: null, kit: null, card: null, shares: [], shareCode: '', sharePath: '', hospitalName: '', hospitalAddress: '', hospitalNightCapable: 'UNKNOWN', locationKey: '', routeNight: '', routeDay: '', routeNotes: '', transportPrimary: 'DRIVE', transportBackup: '', driverName: '', driverPhone: '', kitLocation: '', familyInformed: false, pendingCount: 0, rejectedCount: 0, saving: false, syncing: false, recipients: RECIPIENTS.map(item => ({ ...item })), nightText: '待医生确认', transportText: '自驾', loading: false, error: message, message: '', planSettingsOpen: false, shareSettingsOpen: false, planStatusText: '尚未建立', kitStatusText: '尚未建立', cardStatusText: '待生成', cardGeneratedText: '', ...EMPTY_CARD_READINESS });
  },
  refreshQueue(expectedScope?: Scope | null, expectedOutbox?: MutationOutbox | null) {
    expectedScope = expectedScope ?? this.scope;
    expectedOutbox = expectedOutbox ?? this.outbox;
    if (!expectedScope || !sameScope(expectedScope) || expectedOutbox !== this.outbox) return;
    try {
      const emergencyOperations: MutationOperation[] = [PLAN_OP, KIT_OP, CARD_OP, SHARE_OP];
      const entries: MutationEntry[] = expectedOutbox?.entries().filter((entry: MutationEntry) => emergencyOperations.includes(entry.operation)) ?? [];
      this.setData({ pendingCount: entries.filter((entry: MutationEntry) => entry.state === 'PENDING').length, rejectedCount: entries.filter((entry: MutationEntry) => entry.state === 'REJECTED').length });
    } catch (error) { this.setData({ error: errorText(error, '本机待提交记录不可读。') }); }
  },
  load(expectedScope?: Scope | null) {
    expectedScope = expectedScope ?? this.scope ?? scopeNow();
    if (!expectedScope || !sameScope(expectedScope)) return;
    const expectedOutbox = this.outbox;
    const generation = ++this.loadGeneration;
    this.setData({ loading: true, error: '', careCapabilities: null });
    Promise.allSettled([loadSupportPlan(), loadSupportKit(), loadSupportCard(), listSupportShares(), request<unknown>(`/api/v1/patients/${encodeURIComponent(expectedScope.patientId)}/care-summary`)]).then(results => {
      if (!sameScope(expectedScope) || this.outbox !== expectedOutbox || generation !== this.loadGeneration) return;
      const plan = results[0]?.status === 'fulfilled' ? results[0].value : null;
      const kit = results[1]?.status === 'fulfilled' ? results[1].value : null;
      const card = results[2]?.status === 'fulfilled' ? results[2].value : null;
      const shares = results[3]?.status === 'fulfilled' ? results[3].value : [];
      const errors = results.slice(0, 4).filter(item => item.status === 'rejected');
      if (errors.some(item => item.status === 'rejected' && forbidden(item.reason))) { this.clearSensitiveState('当前身份无权查看应急资料，已清理本机敏感内容。'); return; }
      const readiness = results[0]?.status === 'rejected' || results[1]?.status === 'rejected' || results[2]?.status === 'rejected'
        ? { ...EMPTY_CARD_READINESS, cardPrerequisiteHint: '应急资料暂未读全，请重新读取后继续。', cardSetupTarget: 'reload', cardSetupLabel: '重新读取资料' }
        : cardReadiness(plan, kit, Boolean(this.data.canPlanWrite));
      const careCapabilities = results[4]?.status === 'fulfilled' ? parseCareCapabilities(results[4].value, expectedScope.patientId) : null;
      // 同步状态与表单分开；请求期间输入的内容也不能被回包覆盖。
      const planFields = results[0]?.status === 'fulfilled' && formSnapshot(this.data, PLAN_FORM_FIELDS) === this.planDraftBaseline ? planForm(plan) : {};
      const kitFields = results[1]?.status === 'fulfilled' && formSnapshot(this.data, KIT_FORM_FIELDS) === this.kitDraftBaseline ? kitForm(kit) : {};
      if (Object.keys(planFields).length) this.planDraftBaseline = formSnapshot(planFields, PLAN_FORM_FIELDS);
      if (Object.keys(kitFields).length) this.kitDraftBaseline = formSnapshot(kitFields, KIT_FORM_FIELDS);
      this.setData({ ...readiness, careCapabilities, plan, kit, card, shares: shares.map(share => ({ ...share, expiresText: beijingDateTime(share.expiresAt) })), planStatusText: plan ? PLAN_STATUS_LABELS[plan.status] : '尚未建立', kitStatusText: kit ? KIT_STATUS_LABELS[kit.status] : '尚未建立', cardStatusText: card ? card.needsReprint ? '需更新' : '当前有效' : '待生成', cardGeneratedText: card ? beijingDateTime(card.generatedAt) : '', ...planFields, ...kitFields, loading: false, error: errors.length ? '部分应急资料暂不可用，请重新读取。' : '' });
    });
  },
  input(event: { currentTarget?: { dataset?: { field?: unknown } }; detail?: { value?: unknown } }) { const field = event.currentTarget?.dataset?.field; if (typeof field === 'string' && typeof event.detail?.value === 'string') this.setData({ [field]: event.detail.value, error: '' }); },
  pickNight(event: { detail?: { value?: unknown } }) { const value = Number(event.detail?.value); if ([0, 1, 2].includes(value)) { const code = ['TRUE', 'FALSE', 'UNKNOWN'][value]!; this.setData({ hospitalNightCapable: code, nightText: NIGHT_LABELS[code], error: '' }); } },
  pickTransport(event: { detail?: { value?: unknown } }) { const value = Number(event.detail?.value); if ([0, 1, 2, 3].includes(value)) { const code = ['DRIVE', 'TAXI', 'AMBULANCE', 'OTHER'][value]!; this.setData({ transportPrimary: code, transportText: TRANSPORT_LABELS[code], error: '' }); } },
  changeFamily(event: { detail?: { value?: unknown } }) { this.setData({ familyInformed: checkedValue(event.detail?.value, Boolean(this.data.familyInformed)), error: '' }); },
  toggleRecipient(event: { currentTarget?: { dataset?: { code?: unknown } }; detail?: { value?: unknown } }) { const code = event.currentTarget?.dataset?.code; if (typeof code !== 'string') return; const recipients = (this.data.recipients as Array<{ code: SupportShareRecipientHint; label: string; selected: boolean }>).map(item => item.code === code ? { ...item, selected: checkedValue(event.detail?.value, !item.selected) } : item); this.setData({ recipients }); },
  enqueue(operation: MutationOperation, payload: Record<string, unknown>): boolean { if (!this.outbox) { this.setData({ error: '当前身份已失效，操作未保存。' }); return false; } try { this.outbox.enqueue({ operation, idempotencyKey: String(payload.idempotencyKey), payload }); return true; } catch (error) { this.setData({ error: errorText(error, '操作未保存，没有覆盖本机原来那条。') }); return false; } },
  async sendEntry(entry: MutationEntry, scope: Scope): Promise<void> {
    if (!sameScope(scope) || this.scope !== scope) throw new ApiFailure('身份已切换，请刷新当前页面。', 409);
    if (entry.operation === PLAN_OP) { const result = await mutateSupportPlan(entry.payload as never); if (!result.plan || !sameScope(scope) || this.scope !== scope) throw new Error('服务未确认应急预案内容。'); if (entry.payload.action === 'SAVE_DRAFT' && entry.payload.locationKey === String(this.data.locationKey ?? '').trim() && JSON.stringify(entry.payload.caregiver) === JSON.stringify(caregiverFromPage(this))) this.planDraftBaseline = formSnapshot(this.data, PLAN_FORM_FIELDS); return; }
    if (entry.operation === KIT_OP) { const result = await mutateSupportKit(entry.payload as never); if (!result.kit || !sameScope(scope) || this.scope !== scope) throw new Error('服务未确认急诊包内容。'); if (entry.payload.action === 'SAVE_DRAFT' && entry.payload.locationNote === String(this.data.kitLocation ?? '').trim() && entry.payload.familyInformed === Boolean(this.data.familyInformed)) this.kitDraftBaseline = formSnapshot(this.data, KIT_FORM_FIELDS); return; }
    if (entry.operation === CARD_OP) { const result = await mutateSupportCard(entry.payload as never); if (!result.card || !sameScope(scope) || this.scope !== scope) throw new Error('服务未确认应急流程卡内容。'); return; }
    if (entry.operation === SHARE_OP) { const recipientsHint = entry.payload.recipientsHint; if (!Array.isArray(recipientsHint)) throw new Error('分享对象无效。'); const value = await createSupportShare(recipientsHint as SupportShareRecipientHint[], String(entry.payload.idempotencyKey), typeof entry.payload.expiresAt === 'string' ? entry.payload.expiresAt : undefined); if (!value.code || !sameScope(scope) || this.scope !== scope) throw new Error('服务未确认分享链接。'); this.setData({ shareCode: value.code, sharePath: `/pages/contact/index?s=${encodeURIComponent(value.code)}` }); return; }
  },
  async flush() {
    const scope = this.scope ?? scopeNow(); const outbox = this.outbox;
    if (!scope || !outbox || this.data.syncing || !sameScope(scope)) return;
    const isCurrent = () => sameScope(scope) && this.outbox === outbox;
    this.loadGeneration += 1;
    this.setData({ syncing: true, loading: false, error: '', message: '' });
    try {
      const result = await outbox.flush((entry: MutationEntry) => this.sendEntry(entry, scope), true, [PLAN_OP, KIT_OP, CARD_OP, SHARE_OP]);
      if (!isCurrent()) return;
      if (result.networkError) this.setData({ message: '网络未确认，应急操作已保留，恢复网络后可重试。' });
      else if (result.denied) this.clearSensitiveState('当前身份无权完成应急操作，已清理本机敏感内容。');
      else if (result.rejected) this.setData({ error: '应急操作未被服务端确认，已留在本机，请重试。' });
      else if (result.sent) this.setData({ message: `已确认 ${result.sent} 项应急操作。` });
      this.refreshQueue(scope, outbox);
      if (!result.networkError && !result.denied) this.load(scope);
    } catch (error) {
      if (!isCurrent()) return;
      if (forbidden(error)) this.clearSensitiveState('当前身份已失效，应急敏感内容已清理。');
      else this.setData({ error: errorText(error, '应急操作未确认，这条已留在本机，可以直接重试。') });
      this.refreshQueue(scope, outbox);
    } finally { if (isCurrent()) this.setData({ syncing: false }); }
  },
  savePlan() {
    if (!this.data.canPlanWrite) { this.setData({ error: '当前照护身份不能修改家庭应急预案，请联系患者本人或监护人。' }); return; }
    if ((this.data.plan as SupportPlan | null)?.status === 'PENDING_CLINICIAN') { this.setData({ message: '家庭预案已提交，等待医生确认后再修改。' }); return; }
    const scope = this.scope ?? scopeNow(); if (!scope || this.data.saving) return;
    const idempotencyKey = newIdempotencyKey(PLAN_OP); const payload: SupportPlanCommand = { action: 'SAVE_DRAFT', idempotencyKey, expectedVersion: this.data.plan ? (this.data.plan as SupportPlan).version : 0, step: 4, locationKey: String(this.data.locationKey ?? '').trim(), caregiver: caregiverFromPage(this) };
    if (!text(payload.locationKey, 200) || !text(payload.caregiver?.primaryHospital && (payload.caregiver.primaryHospital as Record<string, unknown>).name, 200) || !text(payload.caregiver?.transport && (payload.caregiver.transport as Record<string, unknown>).backup, 500) || !text(payload.caregiver?.transport && (payload.caregiver.transport as Record<string, unknown>).driverName, 200)) { this.setData({ error: '请填写居住地、医院、备用交通方式和司机/陪同人。' }); return; }
    if (!this.enqueue(PLAN_OP, payload as unknown as Record<string, unknown>)) return; void this.flush();
  },
  submitPlan() { if (this.data.careCapabilities?.hasTreatmentClinician !== true) { this.setData({ error: this.data.careCapabilities?.hasTreatmentClinician === false ? '当前没有可确认预案的医生，草稿可继续保存。请先联系就诊医生核对，或在照护与服务中邀请医生加入。' : '尚未确认医生接收状态，请重新读取应急资料后再提交。' }); return; } if (!this.data.canPlanWrite) { this.setData({ error: '当前照护身份不能提交家庭应急预案。' }); return; } const plan = this.data.plan as SupportPlan | null; if (!plan) { this.setData({ error: '请先保存完整预案。' }); return; } const payload: SupportPlanCommand = { action: 'SUBMIT', idempotencyKey: newIdempotencyKey(PLAN_OP), expectedVersion: plan.version }; if (this.enqueue(PLAN_OP, payload as unknown as Record<string, unknown>)) void this.flush(); },
  saveKit() { if (!this.data.canKitWrite) { this.setData({ error: '当前照护身份不能修改急诊包。' }); return; } const kit = this.data.kit as SupportKit | null; if (!kit && !text(String(this.data.kitLocation ?? '').trim())) { this.setData({ error: '请先填写急诊包存放位置。' }); return; } const payload = { action: 'SAVE_DRAFT', idempotencyKey: newIdempotencyKey(KIT_OP), expectedVersion: kit?.version ?? 0, locationNote: String(this.data.kitLocation ?? '').trim(), familyInformed: Boolean(this.data.familyInformed) }; if (this.enqueue(KIT_OP, payload)) void this.flush(); },
  toggleItem(event: { currentTarget?: { dataset?: { id?: unknown } }; detail?: { value?: unknown } }) { if (!this.data.canKitWrite) { this.setData({ error: '当前照护身份不能修改急诊包。' }); return; } const id = event.currentTarget?.dataset?.id; const kit = this.data.kit as SupportKit | null; if (typeof id !== 'string' || !kit) return; const item = kit.items.find(entry => entry.id === id); if (!item) return; const prepared = checkedValue(event.detail?.value, !item.prepared); const payload = { action: 'TOGGLE_ITEM', idempotencyKey: newIdempotencyKey(KIT_OP), expectedVersion: kit.version, itemId: id, prepared }; if (this.enqueue(KIT_OP, payload)) void this.flush(); },
  verifyKit() { if (!this.data.canKitWrite) { this.setData({ error: '当前照护身份不能核对急诊包。' }); return; } const kit = this.data.kit as SupportKit | null; if (!kit) { this.setData({ error: '请先保存急诊包存放位置。' }); return; } const payload = { action: 'VERIFY', idempotencyKey: newIdempotencyKey(KIT_OP), expectedVersion: kit.version }; if (this.enqueue(KIT_OP, payload)) void this.flush(); },
  generateCard() {
    if (!this.data.canCardWrite) { this.setData({ error: '当前照护身份不能生成应急流程卡。' }); return; }
    if (this.data.loading || this.data.syncing || this.data.exporting) return;
    if (this.data.cardSetupTarget === 'reload') { this.setData({ message: '应急资料暂未读全，请重新读取后继续。' }); return; }
    const readiness = cardReadiness(this.data.plan as SupportPlan | null, this.data.kit as SupportKit | null, Boolean(this.data.canPlanWrite));
    if (!readiness.cardReady) { this.setData({ ...readiness, error: '', message: readiness.cardPrerequisiteHint }); return; }
    const card = this.data.card as SupportCard | null;
    const payload = { action: 'GENERATE', idempotencyKey: newIdempotencyKey(CARD_OP), expectedVersion: card?.version ?? 0 };
    if (this.enqueue(CARD_OP, payload)) void this.flush();
  },
  openCardSetup() {
    if (this.data.cardSetupTarget === 'plan') this.setData({ planSettingsOpen: true }, () => wx.pageScrollTo({ selector: '#emergency-plan', duration: 200 }));
    else if (this.data.cardSetupTarget === 'kit') wx.pageScrollTo({ selector: '#emergency-kit', duration: 200 });
    else if (this.data.cardSetupTarget === 'reload') this.refresh();
  },
  share() { if (!this.data.canShare) { this.setData({ error: '当前照护身份不能创建联系人应急分享。' }); return; } const recipientsHint = selectedRecipients(this); if (!recipientsHint.length) { this.setData({ error: '请至少选择一个分享对象。' }); return; } const payload = { recipientsHint, idempotencyKey: newIdempotencyKey(SHARE_OP) }; if (this.enqueue(SHARE_OP, payload)) void this.flush(); },
  /**
   * 复制出去的只是小程序内部路径，收件人在聊天里点不开；转发卡片才能直接唤起联系人页。
   * 只有刚生成的分享码可以转发，其余情况转发首页入口，不带任何患者信息。
   */
  onShareAppMessage() {
    const code = this.data.shareCode as string;
    if (/^[A-Za-z0-9_-]{7}$/.test(code)) return { title: '应急联系卡：需要时请按卡片操作', path: `/pages/contact/index?s=${encodeURIComponent(code)}` };
    return { title: '无恙', path: '/pages/auth/index' };
  },
  openShare() { const code = this.data.shareCode as string; if (/^[A-Za-z0-9_-]{7}$/.test(code)) wx.navigateTo({ url: `/pages/contact/index?s=${encodeURIComponent(code)}` }); },
  async revoke(event: { currentTarget?: { dataset?: { code?: unknown } } }) {
    if (!this.data.canShare) { this.setData({ error: '当前照护身份不能撤回联系人应急分享。' }); return; }
    const code = event.currentTarget?.dataset?.code; const scope = this.scope ?? scopeNow();
    if (typeof code !== 'string' || !scope || !sameScope(scope) || this.data.syncing) return;
    const outbox = this.outbox;
    const isCurrent = () => sameScope(scope) && this.outbox === outbox;
    this.setData({ syncing: true, error: '' });
    try {
      await revokeSupportShare(code);
      if (!isCurrent()) return;
      this.setData({ message: '分享已撤回。' }); this.load(scope);
    } catch (error) { if (isCurrent()) this.setData({ error: errorText(error, '分享撤回未确认。') }); }
    finally { if (isCurrent()) this.setData({ syncing: false }); }
  },
  togglePlanSettings() { this.setData({ planSettingsOpen: !this.data.planSettingsOpen }); },
  toggleShareSettings() { this.setData({ shareSettingsOpen: !this.data.shareSettingsOpen }); },
  cancelExport() {
    this.exportGeneration += 1;
    this.downloadTask?.abort();
    this.downloadTask = null;
    this.setData({ exporting: false, exportNotice: '' });
  },
  async exportCard() {
    const expected = this.scope ?? scopeNow();
    if (!expected || !sameScope(expected) || this.data.exporting || this.data.syncing) return;
    if (!wx.downloadFile || !wx.openDocument) { this.setData({ error: '当前微信版本不支持打开 PDF，请更新微信或在支持的设备上打开。' }); return; }
    const generation = ++this.exportGeneration;
    const currentExport = () => generation === this.exportGeneration && sameScope(expected);
    this.setData({ exporting: true, exportNotice: '', error: '' });
    try {
      // 先走已有 JSON API 重新核验权限与版本，也让正常的 token 刷新在下载前完成。
      const latestCard = await loadSupportCard();
      if (!currentExport()) return;
      this.setData({ card: latestCard, cardStatusText: latestCard ? latestCard.needsReprint ? '需更新' : '当前有效' : '待生成', cardGeneratedText: latestCard ? beijingDateTime(latestCard.generatedAt) : '' });
      if (!latestCard) throw new Error('请先完成预案和急诊包，再生成应急流程卡。');
      if (latestCard.needsReprint) throw new Error('预案、用药或急诊包已变化，请生成新版本后再导出。');
      const current = session();
      if (!current || !currentExport()) return;
      const tempFilePath = await new Promise<string>((resolve, reject) => {
        this.downloadTask = wx.downloadFile!({
          url: `${API_BASE}/api/v1/patients/${encodeURIComponent(expected.patientId)}/emergency-card.pdf`,
          header: { authorization: `Bearer ${current.accessToken}`, 'x-actor-id': current.actorId, accept: 'application/pdf' },
          timeout: 60_000,
          success: result => {
            if (result.statusCode === 200 && text(result.tempFilePath, 4096)) resolve(result.tempFilePath);
            else if ([401, 403].includes(result.statusCode)) reject(new ApiFailure('当前身份不能导出应急流程卡，请刷新后重试。', result.statusCode));
            else if (result.statusCode === 404) reject(new Error('应急流程卡尚未生成，请先生成后再导出。'));
            else if (result.statusCode === 503) reject(new Error('可打印 PDF 暂不可用，请稍后再试。'));
            else reject(new Error('PDF 下载未完成，请稍后重试。'));
          },
          fail: () => reject(new Error('PDF 下载失败，请检查网络后重试。')),
        });
      });
      if (!currentExport()) return;
      this.downloadTask = null;
      await new Promise<void>((resolve, reject) => wx.openDocument!({ filePath: tempFilePath, fileType: 'pdf', showMenu: true, success: () => resolve(), fail: () => reject(new Error('PDF 已下载，但未能打开。请稍后重试。')) }));
      if (currentExport()) this.setData({ exportNotice: '已打开 PDF。可从右上角菜单保存到自己的设备，之后离线查看或按 A4 纵向黑白打印。' });
    } catch (error) {
      if (!currentExport()) return;
      if (forbidden(error)) this.clearSensitiveState(errorText(error, '当前身份不能导出应急资料。'));
      else this.setData({ error: errorText(error, '应急流程卡导出失败，请稍后重试。') });
    } finally {
      if (generation === this.exportGeneration) { this.downloadTask = null; this.setData({ exporting: false }); }
    }
  },
  retry() { void this.flush(); },
  openCareSupport() { wx.navigateTo({ url: '/pages/patient/support' }); },
  refresh() { if (!this.data.loading && !this.data.syncing && !this.data.exporting) this.load(this.scope ?? scopeNow()); },
  onUnload() { this.loadGeneration += 1; this.cancelExport(); },
});
