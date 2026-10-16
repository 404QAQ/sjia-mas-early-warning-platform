import { ApiFailure, patientId, request, session } from '../../api';
import { at, longDate } from '../../date-format';
import { MutationOutbox, deniedOperations, newIdempotencyKey, wxStorage, type MutationEntry, type MutationOperation } from '../../mutation-outbox';
import { loadDiaryShares, loadDiaryTargets, mutateDiaryShare, removeDiaryEntry, type DiaryShare, type DiaryTarget } from './health-private-diary';

type Mood = 'DISTRESSED' | 'ANGRY' | 'LOW_ENERGY' | 'UNCLEAR';
type FamilyCode = 'RHEUMATOID_ARTHRITIS' | 'OTHER_JIA' | 'PSORIASIS_IBD' | 'OTHER';
interface DiaryEntry { id: string; code: 'MOOD_FREE_TEXT' | 'MOOD_QUICK'; valueText?: string; valueCoded?: Mood; observedAt: string; timeText: string; revision: number; display: string; shares?: DiaryShare[]; }
interface VaccinationRecord { id: string; vaccine: string; administeredAt: string; dateText: string; facility: string; source: 'PATIENT' | 'CAREGIVER' | 'CLINICIAN'; recordedAt: string; }
interface VaccinationSchedule { patientId: string; asOf: string; updatedText: string; liveAttenuated: { classification: 'BLOCKED' | 'UNKNOWN'; blocked: boolean; vaccines: string[]; vaccinesText: string; reasonRef?: string }; inactivated: Array<{ vaccine: string }>; records: VaccinationRecord[]; householdMembers: Array<{ relation: string; vaccines: Array<{ name: string; done: boolean; doneAt?: string }> }>; annualInfluenza: { status: string; statusLabel: string; localYear: number; window: { from: string; to: string; reminderFrom: string }; lastRecord?: { administeredAt: string; dateText: string; facility: string } }; message?: string; }
interface FamilyHistory { patientId: string; declined: boolean; siblings: Array<{ ageYears: number; healthy: boolean; note?: string; display: string }>; familyAutoimmune: FamilyCode[]; familyLabels: string[]; updatedText: string; otherNote?: string; version: number; updatedAt?: string; }

const MOOD_LABEL: Record<Mood, string> = { DISTRESSED: '难受', ANGRY: '生气', LOW_ENERGY: '没力气', UNCLEAR: '说不清' };
const FAMILY_LABEL: Record<FamilyCode, string> = { RHEUMATOID_ARTHRITIS: '类风湿关节炎', OTHER_JIA: '其他幼年特发性关节炎', PSORIASIS_IBD: '银屑病或炎症性肠病', OTHER: '其他自身免疫病' };
const FAMILY_CODES = Object.keys(FAMILY_LABEL) as FamilyCode[];
function influenzaStatusLabel(status: string): string {
  switch (status) {
    case 'CURRENT_YEAR_RECORDED': return '今年已有接种记录';
    case 'WINDOW_APPROACHING': return '接种时段即将到来';
    case 'WINDOW_OPEN': return '处于建议接种时段';
    case 'WINDOW_PASSED': return '建议接种时段已过';
    case 'NEXT_WINDOW': return '等待下一接种时段';
    default: return '待医生核对';
  }
}
const PENDING_MESSAGE = '服务确认前会先留着这条记录，不会重复记账。';

function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function text(value: unknown, max = 500): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\0\r\n]/.test(value); }
function instant(value: unknown): value is string { return text(value, 80) && Number.isFinite(Date.parse(value)); }
function integer(value: unknown, min = 0): value is number { return Number.isSafeInteger(value) && (value as number) >= min; }
function known(value: Record<string, unknown>, fields: readonly string[]): boolean { return Object.keys(value).every(key => fields.includes(key)); }
function currentScopeKey(): string { const current = session(); const id = patientId(); return current && id ? current.userId + ':' + current.actorId + ':' + id : ''; }
function outboxForCurrent(): MutationOutbox | null { const current = session(); const id = patientId(); return current && id ? new MutationOutbox(wxStorage(), current.actorId, id, current.userId) : null; }
function dateInstant(value: string): string { return value + 'T12:00:00.000+08:00'; }
/** 接种日期按北京时间解释（见 dateInstant），选择器上限也按北京时间的今天算，不能选到未来。 */
function beijingToday(): string { return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10); }
function pendingFor(outbox: MutationOutbox, operation: MutationOperation, match: (entry: MutationEntry) => boolean): MutationEntry | undefined { return outbox.entries().find(entry => entry.operation === operation && match(entry)); }

function parseDiary(value: unknown, id: string): { entries: DiaryEntry[]; revision: number } {
  if (!object(value) || !known(value, ['entries', 'revision', 'nextAfter']) || !Array.isArray(value.entries) || !integer(value.revision)) throw new Error('私人记录响应格式无效。');
  const entries = value.entries.map(item => {
    if (!object(item) || !known(item, ['id', 'patientId', 'code', 'valueText', 'valueCoded', 'observedAt', 'recordedAt', 'source', 'tags', 'visibleTo', 'revision']) || item.patientId !== id || !text(item.id, 256) || !['MOOD_FREE_TEXT', 'MOOD_QUICK'].includes(String(item.code)) || !instant(item.observedAt) || !integer(item.revision, 1) || item.source !== 'PATIENT_REPORTED' || !Array.isArray(item.tags) || item.tags.length !== 1 || item.tags[0] !== 'NO_ALERT' || !Array.isArray(item.visibleTo) || item.visibleTo.length !== 1 || item.visibleTo[0] !== 'SELF') throw new Error('私人记录条目格式无效。');
    if (item.code === 'MOOD_FREE_TEXT' && (typeof item.valueText !== 'string' || !item.valueText.trim() || item.valueText.length > 64000 || item.valueText.includes('\0') || item.valueCoded !== undefined)) throw new Error('私人记录内容格式无效。');
    if (item.code === 'MOOD_QUICK' && (typeof item.valueCoded !== 'string' || !Object.hasOwn(MOOD_LABEL, item.valueCoded) || item.valueText !== undefined)) throw new Error('私人记录状态格式无效。');
    return { id: item.id, code: item.code as DiaryEntry['code'], valueText: typeof item.valueText === 'string' ? item.valueText : undefined, valueCoded: typeof item.valueCoded === 'string' ? item.valueCoded as Mood : undefined, observedAt: item.observedAt, timeText: at(item.observedAt), revision: item.revision, display: item.code === 'MOOD_QUICK' ? MOOD_LABEL[item.valueCoded as Mood] : String(item.valueText) };
  });
  return { entries, revision: value.revision };
}
function parseVaccination(value: unknown, id: string): VaccinationSchedule {
  if (!object(value) || !known(value, ['patientId', 'asOf', 'immunosuppressionStateRef', 'liveAttenuated', 'inactivated', 'spacingRules', 'householdMembers', 'records', 'annualInfluenza', 'message']) || value.patientId !== id || !instant(value.asOf) || !object(value.liveAttenuated) || !['BLOCKED', 'UNKNOWN'].includes(String(value.liveAttenuated.classification)) || typeof value.liveAttenuated.blocked !== 'boolean' || !Array.isArray(value.liveAttenuated.vaccines) || !value.liveAttenuated.vaccines.every(item => text(item, 200)) || !Array.isArray(value.inactivated) || !Array.isArray(value.records) || !Array.isArray(value.householdMembers) || !object(value.annualInfluenza)) throw new Error('疫苗日历响应格式无效。');
  const records = value.records.map(item => {
    if (!object(item) || !known(item, ['id', 'patientId', 'vaccine', 'administeredAt', 'facility', 'source', 'recordedAt']) || item.patientId !== id || !text(item.id, 256) || !text(item.vaccine, 100) || !instant(item.administeredAt) || !text(item.facility, 200) || !['PATIENT', 'CAREGIVER', 'CLINICIAN'].includes(String(item.source)) || !instant(item.recordedAt)) throw new Error('接种记录格式无效。');
    return { id: item.id, vaccine: item.vaccine, administeredAt: item.administeredAt, dateText: longDate(item.administeredAt), facility: item.facility, source: item.source as VaccinationRecord['source'], recordedAt: item.recordedAt };
  });
  const annual = value.annualInfluenza;
  if (!known(annual, ['vaccine', 'localYear', 'status', 'window', 'sourceRef', 'lastRecord']) || annual.vaccine !== 'INFLUENZA' || !integer(annual.localYear, 1900) || typeof annual.status !== 'string' || !object(annual.window) || !text(annual.window.from, 20) || !text(annual.window.to, 20) || !text(annual.window.reminderFrom, 20)) throw new Error('流感提醒格式无效。');
  const householdMembers = value.householdMembers.map(item => {
    if (!object(item) || !known(item, ['relation', 'vaccines']) || !text(item.relation, 100) || !Array.isArray(item.vaccines)) throw new Error('家庭接种清单格式无效。');
    return { relation: item.relation, vaccines: item.vaccines.map(vaccine => { if (!object(vaccine) || !known(vaccine, ['name', 'done', 'doneAt']) || !text(vaccine.name, 100) || typeof vaccine.done !== 'boolean' || vaccine.doneAt !== undefined && !instant(vaccine.doneAt)) throw new Error('家庭接种项目格式无效。'); return { name: vaccine.name, done: vaccine.done, doneAt: typeof vaccine.doneAt === 'string' ? vaccine.doneAt : undefined }; }) };
  });
  return { patientId: id, asOf: value.asOf, updatedText: at(value.asOf), liveAttenuated: { classification: value.liveAttenuated.classification as 'BLOCKED' | 'UNKNOWN', blocked: value.liveAttenuated.blocked, vaccines: value.liveAttenuated.vaccines as string[], vaccinesText: (value.liveAttenuated.vaccines as string[]).join('、'), reasonRef: typeof value.liveAttenuated.reasonRef === 'string' ? value.liveAttenuated.reasonRef : undefined }, inactivated: value.inactivated.filter(item => object(item) && text(item.vaccine, 100)).map(item => ({ vaccine: item.vaccine })), records, householdMembers, annualInfluenza: { status: annual.status, statusLabel: influenzaStatusLabel(annual.status), localYear: annual.localYear, window: { from: annual.window.from, to: annual.window.to, reminderFrom: annual.window.reminderFrom }, lastRecord: object(annual.lastRecord) && instant(annual.lastRecord.administeredAt) && text(annual.lastRecord.facility, 200) ? { administeredAt: annual.lastRecord.administeredAt, dateText: longDate(annual.lastRecord.administeredAt), facility: annual.lastRecord.facility } : undefined }, message: typeof value.message === 'string' ? value.message : undefined };
}
function parseFamily(value: unknown, id: string): FamilyHistory {
  if (!object(value) || !known(value, ['patientId', 'declined', 'siblings', 'familyAutoimmune', 'otherNote', 'version', 'updatedAt']) || value.patientId !== id || typeof value.declined !== 'boolean' || !Array.isArray(value.siblings) || !Array.isArray(value.familyAutoimmune) || !integer(value.version) || !value.familyAutoimmune.every(code => FAMILY_CODES.includes(code as FamilyCode)) || new Set(value.familyAutoimmune).size !== value.familyAutoimmune.length || value.otherNote !== undefined && !text(value.otherNote, 500)) throw new Error('家族史响应格式无效。');
  const siblings = value.siblings.map(item => { if (!object(item) || !known(item, ['ageYears', 'healthy', 'note']) || !integer(item.ageYears) || item.ageYears > 120 || typeof item.healthy !== 'boolean' || item.note !== undefined && !text(item.note, 500)) throw new Error('手足信息格式无效。'); return { ageYears: item.ageYears, healthy: item.healthy, note: typeof item.note === 'string' ? item.note : undefined, display: String(item.ageYears) + ' 岁 · ' + (item.healthy ? '健康' : '有健康问题') + (item.note ? ' · ' + item.note : '') }; });
  return { patientId: id, declined: value.declined, siblings, familyAutoimmune: value.familyAutoimmune as FamilyCode[], familyLabels: (value.familyAutoimmune as FamilyCode[]).map(code => FAMILY_LABEL[code]), updatedText: instant(value.updatedAt) ? at(value.updatedAt) : '', otherNote: typeof value.otherNote === 'string' ? value.otherNote : undefined, version: value.version, updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : undefined };
}

async function sendMutation(entry: MutationEntry, scope: string): Promise<void> {
  if (currentScopeKey() !== scope) throw new ApiFailure('身份已切换，请刷新当前页面。', 409);
  const id = patientId();
  if (!id) throw new ApiFailure('当前会话未绑定患者档案。', 403);
  const payload = entry.payload;
  if (entry.operation === 'PRIVATE_DIARY') {
    const value = await request<unknown>('/api/v1/patients/' + encodeURIComponent(id) + '/private-diary', 'POST', payload);
    if (!object(value) || !object(value.entry) || value.entry.patientId !== id || !text(value.entry.id, 256) || value.entry.source !== 'PATIENT_REPORTED' || !Array.isArray(value.entry.visibleTo) || value.entry.visibleTo[0] !== 'SELF') throw new Error('服务端未确认私人记录，这条已留在本机，可以直接重试。');
  } else if (entry.operation === 'VACCINATION_RECORD') {
    const value = await request<unknown>('/api/v1/patients/' + encodeURIComponent(id) + '/vaccinations/records', 'POST', payload);
    if (!object(value) || value.patientId !== id || !text(value.id, 256) || !text(value.vaccine, 100)) throw new Error('服务端未确认接种记录，这条已留在本机，可以直接重试。');
  } else if (entry.operation === 'FAMILY_HISTORY') {
    const value = await request<unknown>('/api/v1/patients/' + encodeURIComponent(id) + '/family-history', 'POST', payload);
    if (!object(value) || !object(value.familyHistory) || value.familyHistory.patientId !== id || !integer(value.familyHistory.version)) throw new Error('服务端未确认家族史，这条已留在本机，可以直接重试。');
  }
  if (currentScopeKey() !== scope) throw new ApiFailure('身份已切换，请刷新当前页面。', 409);
}

Page({
  data: {
    loading: true, saving: false, error: '', message: '', scopeKey: '', role: '', canWriteDiary: false, canWriteClinical: false,
    diaryEntries: [] as DiaryEntry[], diaryRevision: 0, diaryText: '', selectedMood: '', selectedMoodLabel: '', diaryNotice: '',
    vaccination: null as VaccinationSchedule | null, vaccineName: '', vaccineFacility: '', vaccineDate: '', today: beijingToday(),
    family: null as FamilyHistory | null, familyAutoimmuneOptions: FAMILY_CODES.map(code => ({ code, label: FAMILY_LABEL[code], selected: false })), familyDeclined: false, familyOtherNote: '', siblings: [] as Array<{ display: string; ageYears: number; healthy: boolean; note?: string }>, siblingAge: '', siblingHealthy: true, siblingNote: '',
    pendingCount: 0, rejectedCount: 0,
    section: '', pageTitle: '健康资料', shareTargets: [] as DiaryTarget[], diaryShares: [] as DiaryShare[], shareEntryId: '', shareTargetIndex: 0, diaryActionBusy: false, diaryActionError: '',
  },
  diaryActionEpoch: 0,
  loadGeneration: 0,
  diaryCommands: new Map<string, Record<string, unknown>>(),
  targetSection: '',
  onLoad(options: { section?: string } = {}) { const section = ['vaccination', 'diary', 'family'].includes(options.section ?? '') ? options.section : ''; const pageTitle = section === 'vaccination' ? '疫苗日历' : section === 'diary' ? '私人记录' : section === 'family' ? '家族健康信息' : '健康资料'; this.setData({ section, pageTitle }); wx.setNavigationBarTitle?.({ title: pageTitle }); this.onShow(); },
  onUnload() { this.diaryActionEpoch += 1; this.diaryCommands.clear(); },
  onReady() { this.focusSection(); },
  focusSection() {
    if (!this.targetSection || this.data.loading) return;
    if (this.targetSection === 'diary' && !this.data.canWriteDiary) { this.targetSection = ''; wx.showToast({ title: '私人记录仅患者本人可见', icon: 'none' }); return; }
    wx.pageScrollTo({ selector: `#section-${this.targetSection}`, duration: 200 }); this.targetSection = '';
  },
  onShow() {
    const current = session();
    if (!current || currentScopeKey() !== this.data.scopeKey) { this.diaryActionEpoch += 1; this.diaryCommands.clear(); this.setData({ shareTargets: [], diaryShares: [], shareEntryId: '', diaryActionBusy: false, diaryActionError: '', saving: false }); }
    if (!current) { this.setData({ scopeKey: '', role: '', canWriteDiary: false, canWriteClinical: false, diaryEntries: [], diaryRevision: 0, diaryText: '', selectedMood: '', selectedMoodLabel: '', vaccination: null, family: null, familyAutoimmuneOptions: FAMILY_CODES.map(code => ({ code, label: FAMILY_LABEL[code], selected: false })), familyDeclined: false, familyOtherNote: '', siblings: [], error: '', message: '' }); wx.redirectTo({ url: '/pages/auth/index' }); return; }
    const scope = currentScopeKey();
    // 页面可能隔夜停留在后台，每次回到前台都重算上限。
    this.setData({ today: beijingToday() });
    if (scope !== this.data.scopeKey) {
      const canWriteDiary = current.role === 'PATIENT';
      const canWriteClinical = current.role === 'PATIENT' || current.role === 'LEGAL_GUARDIAN';
      this.setData({ scopeKey: scope, role: current.role, canWriteDiary, canWriteClinical, diaryEntries: [], diaryRevision: 0, diaryText: '', selectedMood: '', selectedMoodLabel: '', vaccination: null, family: null, error: '', message: '', diaryNotice: canWriteDiary ? '' : '私人记录仅患者本人可见。' });
      this.load(scope);
    }
  },
  refresh() { return this.load(); },
  async load(expectedScope = currentScopeKey()) {
    const id = patientId();
    const epoch = this.diaryActionEpoch; const generation = ++this.loadGeneration;
    if (!id) { this.setData({ loading: false, error: '当前微信身份尚未绑定患者档案。' }); return; }
    this.setData({ loading: true, error: '', message: '' });
    const tasks: Promise<unknown>[] = [request<unknown>('/api/v1/patients/' + encodeURIComponent(id) + '/vaccinations'), request<unknown>('/api/v1/patients/' + encodeURIComponent(id) + '/family-history')];
    if (this.data.canWriteDiary) tasks.push(request<unknown>('/api/v1/patients/' + encodeURIComponent(id) + '/private-diary?limit=30'));
    const results = await Promise.allSettled(tasks);
    if (currentScopeKey() !== expectedScope || epoch !== this.diaryActionEpoch || generation !== this.loadGeneration) return;
    const errors: string[] = [];
    const vaccination = results[0]?.status === 'fulfilled' ? (() => { try { return parseVaccination(results[0].value, id); } catch (error) { errors.push(error instanceof Error ? error.message : '疫苗日历读取失败。'); return null; } })() : (errors.push(results[0]?.reason instanceof Error ? results[0].reason.message : '疫苗日历读取失败。'), null);
    const family = results[1]?.status === 'fulfilled' ? (() => { try { return parseFamily(results[1].value, id); } catch (error) { errors.push(error instanceof Error ? error.message : '家族史读取失败。'); return null; } })() : (errors.push(results[1]?.reason instanceof Error ? results[1].reason.message : '家族史读取失败。'), null);
    let diaryEntries: DiaryEntry[] = this.data.diaryEntries as DiaryEntry[]; let diaryRevision = this.data.diaryRevision as number;
    if (this.data.canWriteDiary && results[2]) {
      if (results[2].status === 'fulfilled') { try { const diary = parseDiary(results[2].value, id); diaryEntries = diary.entries; diaryRevision = diary.revision; } catch (error) { errors.push(error instanceof Error ? error.message : '私人记录读取失败。'); } }
      else if (results[2].reason instanceof ApiFailure && [401, 403].includes(results[2].reason.status)) this.setData({ diaryNotice: '当前身份暂不可读取私人记录。' });
      else errors.push(results[2].reason instanceof Error ? results[2].reason.message : '私人记录读取失败。');
    }
    this.setData({ vaccination, family, diaryEntries, diaryRevision, familyDeclined: family?.declined ?? false, familyOtherNote: family?.otherNote ?? '', siblings: family?.siblings ?? [], familyAutoimmuneOptions: FAMILY_CODES.map(code => ({ code, label: FAMILY_LABEL[code], selected: Boolean(family?.familyAutoimmune.includes(code)) })), loading: false, error: errors.join('；') }, () => this.focusSection());
    this.syncQueue();
    if (this.data.canWriteDiary) await this.loadDiaryPermissions(expectedScope);
  },
  async loadDiaryPermissions(expectedScope = currentScopeKey()) {
    const id = patientId(); const epoch = this.diaryActionEpoch;
    if (!id || !this.data.canWriteDiary) return;
    const results = await Promise.allSettled([loadDiaryShares(id), loadDiaryTargets(id)]);
    if (currentScopeKey() !== expectedScope || epoch !== this.diaryActionEpoch) return;
    const shares = results[0].status === 'fulfilled' ? results[0].value : [];
    this.setData({ diaryShares: shares, shareTargets: results[1].status === 'fulfilled' ? results[1].value : [], diaryEntries: (this.data.diaryEntries as DiaryEntry[]).map(entry => ({ ...entry, shares: shares.filter(share => share.entryId === entry.id && share.status === 'ACTIVE' && Date.parse(share.expiresAt) > Date.now()) })), diaryActionError: results.some(result => result.status === 'rejected') ? '分享状态暂未读取完整，请刷新后再管理授权。' : '' });
  },
  openDiaryShare(event: { currentTarget?: { dataset?: { id?: string } } }) {
    const id = event.currentTarget?.dataset?.id;
    if (!this.data.canWriteDiary || this.data.diaryActionBusy || this.data.diaryActionError || !(this.data.diaryEntries as DiaryEntry[]).some(entry => entry.id === id)) return;
    this.setData({ shareEntryId: id, shareTargetIndex: 0 });
    wx.pageScrollTo({ selector: '#diary-share-editor', duration: 200 });
  },
  closeDiaryShare() { if (!this.data.diaryActionBusy) this.setData({ shareEntryId: '' }); },
  chooseDiaryTarget(event: { detail?: { value?: unknown } }) { const index = Number(event.detail?.value); if (Number.isSafeInteger(index) && index >= 0 && index < this.data.shareTargets.length) this.setData({ shareTargetIndex: index }); },
  confirmDiaryShare() {
    const entryId = this.data.shareEntryId as string; const target = (this.data.shareTargets as DiaryTarget[])[this.data.shareTargetIndex];
    if (!entryId || !target || this.data.diaryActionBusy || this.data.saving || !this.data.canWriteDiary) return;
    const scope = currentScopeKey(); const epoch = this.diaryActionEpoch;
    wx.showModal({ title: '分享这一条记录', content: `仅授权给${target.label}查看这条记录，24 小时后自动失效。你可以随时撤回。`, confirmText: '确认分享', success: result => { if (result.confirm && currentScopeKey() === scope && epoch === this.diaryActionEpoch) void this.runDiaryAction('share', entryId, target.actorId); } });
  },
  revokeDiaryShare(event: { currentTarget?: { dataset?: { id?: string; shareId?: string } } }) {
    const entryId = event.currentTarget?.dataset?.id; const shareId = event.currentTarget?.dataset?.shareId;
    if (entryId && shareId) void this.runDiaryAction('revoke', entryId, shareId);
  },
  deleteDiary(event: { currentTarget?: { dataset?: { id?: string } } }) {
    const id = event.currentTarget?.dataset?.id; const scope = currentScopeKey(); const epoch = this.diaryActionEpoch;
    if (!id || this.data.diaryActionBusy || this.data.saving || !this.data.canWriteDiary) return;
    wx.showModal({ title: '删除私人记录', content: '删除后不再显示这条正文，已授权的医生也将无法继续查看。', confirmText: '删除', confirmColor: '#b45344', success: result => { if (result.confirm && currentScopeKey() === scope && epoch === this.diaryActionEpoch) void this.runDiaryAction('delete', id); } });
  },
  async runDiaryAction(action: 'share' | 'revoke' | 'delete', entryId: string, targetId = '') {
    const id = patientId(); const scope = currentScopeKey(); const epoch = this.diaryActionEpoch;
    if (!id || !this.data.canWriteDiary || session()?.role !== 'PATIENT' || this.data.diaryActionBusy || this.data.saving || !(this.data.diaryEntries as DiaryEntry[]).some(entry => entry.id === entryId)) return;
    const commandKey = `${action}:${entryId}:${targetId}`;
    const share = (this.data.diaryShares as DiaryShare[]).find(item => item.id === targetId && item.entryId === entryId && item.status === 'ACTIVE');
    if (action === 'share' && !(this.data.shareTargets as DiaryTarget[]).some(item => item.actorId === targetId) || action === 'revoke' && !share) return;
    const payload = this.diaryCommands.get(commandKey) ?? { idempotencyKey: newIdempotencyKey('PRIVATE_DIARY'), ...(action === 'share' ? { targetActorId: targetId, expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString() } : action === 'revoke' ? { shareId: share!.id, expectedVersion: share!.version } : { expectedVersion: this.data.diaryRevision }) };
    this.diaryCommands.set(commandKey, payload); this.setData({ diaryActionBusy: true, diaryActionError: '', message: '' });
    const active = () => scope === currentScopeKey() && epoch === this.diaryActionEpoch;
    try {
      if (action === 'delete') await removeDiaryEntry(id, entryId, payload);
      else await mutateDiaryShare(id, entryId, action === 'share' ? 'POST' : 'DELETE', payload);
      if (!active()) return;
      this.diaryCommands.delete(commandKey); this.setData({ shareEntryId: '' }); await this.load(scope);
      if (active()) this.setData({ message: action === 'share' ? '已分享给指定医生，24 小时后自动失效。' : action === 'revoke' ? '已撤回这条记录的分享权限。' : '已删除这条私人记录。' });
    } catch (error) {
      if (!active()) return;
      if (error instanceof ApiFailure && [401, 403].includes(error.status)) this.setData({ diaryEntries: [], diaryShares: [], shareTargets: [], canWriteDiary: false, shareEntryId: '' });
      if (error instanceof ApiFailure && error.status >= 400 && error.status < 500 && error.status !== 429) this.diaryCommands.delete(commandKey);
      this.setData({ diaryActionError: error instanceof Error ? error.message : '操作暂未确认，请重试。' });
    } finally { if (active()) this.setData({ diaryActionBusy: false }); }
  },
  syncQueue() { const outbox = outboxForCurrent(); if (!outbox) return; try { const entries = outbox.entries(); this.setData({ pendingCount: entries.filter(entry => entry.state === 'PENDING').length, rejectedCount: entries.filter(entry => entry.state === 'REJECTED').length }); } catch (error) { this.setData({ error: error instanceof Error ? error.message : '待确认操作读取失败。' }); } },
  diaryInput(event: { detail?: { value?: string } }) { this.setData({ diaryText: event.detail?.value ?? '', selectedMood: '', selectedMoodLabel: '' }); },
  chooseMood(event: { currentTarget?: { dataset?: { mood?: unknown } } }) { const mood = event.currentTarget?.dataset?.mood; if (typeof mood === 'string' && Object.hasOwn(MOOD_LABEL, mood)) this.setData({ selectedMood: mood, selectedMoodLabel: MOOD_LABEL[mood as Mood], diaryText: '' }); },
  async saveDiary() {
    if (this.data.saving || this.data.diaryActionBusy || !this.data.canWriteDiary) return;
    const id = patientId(); const scope = currentScopeKey(); const outbox = outboxForCurrent(); const body = String(this.data.diaryText ?? '').trim(); const mood = this.data.selectedMood as Mood;
    if (!id || !outbox || (!body && !Object.hasOwn(MOOD_LABEL, mood))) { this.setData({ error: '请填写文字或选择一种状态。' }); return; }
    const payload: Record<string, unknown> = { code: body ? 'MOOD_FREE_TEXT' : 'MOOD_QUICK', ...(body ? { valueText: body } : { valueCoded: mood }), expectedVersion: this.data.diaryRevision as number, idempotencyKey: '' };
    const previous = pendingFor(outbox, 'PRIVATE_DIARY', entry => entry.payload.code === payload.code && (entry.payload.valueText ?? entry.payload.valueCoded) === (payload.valueText ?? payload.valueCoded));
    payload.idempotencyKey = previous?.idempotencyKey ?? newIdempotencyKey('PRIVATE_DIARY');
    try { outbox.enqueue({ operation: 'PRIVATE_DIARY', idempotencyKey: payload.idempotencyKey as string, payload }); } catch (error) { this.setData({ error: error instanceof Error ? error.message : '私人记录未保存。' }); return; }
    await this.flushOperation(outbox, 'PRIVATE_DIARY', scope, '私人记录');
    if (currentScopeKey() === scope && !(this.data.rejectedCount as number)) { this.setData({ diaryText: '', selectedMood: '', selectedMoodLabel: '' }); await this.load(scope); }
  },
  toggleFamilyDeclined(event: { detail?: { value?: unknown } }) { const value = event.detail?.value; this.setData({ familyDeclined: Array.isArray(value) && value.includes('DECLINED') }); },
  toggleFamily(event: { currentTarget?: { dataset?: { code?: unknown } } }) { const code = event.currentTarget?.dataset?.code; if (!FAMILY_CODES.includes(code as FamilyCode)) return; const selected = (this.data.familyAutoimmuneOptions as Array<{ code: FamilyCode; label: string; selected: boolean }>).map(item => item.code === code ? { ...item, selected: !item.selected } : item); this.setData({ familyAutoimmuneOptions: selected, familyDeclined: false }); },
  familyNote(event: { detail?: { value?: string } }) { this.setData({ familyOtherNote: event.detail?.value ?? '' }); },
  siblingAgeInput(event: { detail?: { value?: string } }) { this.setData({ siblingAge: event.detail?.value ?? '' }); },
  siblingNoteInput(event: { detail?: { value?: string } }) { this.setData({ siblingNote: event.detail?.value ?? '' }); },
  siblingHealthyChange(event: { detail?: { value?: unknown } }) { const value = event.detail?.value; this.setData({ siblingHealthy: value === 'healthy' || Array.isArray(value) && value.includes('healthy') }); },
  addSibling() { const age = Number(this.data.siblingAge); const note = String(this.data.siblingNote ?? '').trim(); if (!Number.isSafeInteger(age) || age < 0 || age > 120 || note.length > 500) { this.setData({ error: '请填写 0 至 120 岁的手足年龄，备注不超过 500 字。' }); return; } const siblings = [...(this.data.siblings as Array<{ ageYears: number; healthy: boolean; note?: string; display: string }>)]; siblings.push({ ageYears: age, healthy: Boolean(this.data.siblingHealthy), note: note || undefined, display: String(age) + ' 岁 · ' + (this.data.siblingHealthy ? '健康' : '有健康问题') + (note ? ' · ' + note : '') }); if (siblings.length > 20) { this.setData({ error: '手足信息最多 20 条。' }); return; } this.setData({ siblings, siblingAge: '', siblingNote: '', error: '' }); },
  removeSibling(event: { currentTarget?: { dataset?: { index?: unknown } } }) { const index = Number(event.currentTarget?.dataset?.index); if (!Number.isSafeInteger(index) || index < 0) return; this.setData({ siblings: (this.data.siblings as unknown[]).filter((_, current) => current !== index) }); },
  async saveFamily() {
    if (this.data.saving || !this.data.canWriteClinical) return;
    const id = patientId(); const scope = currentScopeKey(); const outbox = outboxForCurrent(); if (!id || !outbox) return;
    const selected = (this.data.familyAutoimmuneOptions as Array<{ code: FamilyCode; selected: boolean }>).filter(item => item.selected).map(item => item.code);
    const declined = Boolean(this.data.familyDeclined); const note = String(this.data.familyOtherNote ?? '').trim(); const siblings = this.data.siblings as Array<{ ageYears: number; healthy: boolean; note?: string }>;
    if (declined && (selected.length || note || siblings.length)) { this.setData({ error: '选择暂不填写时，请清空其他家族史内容。' }); return; }
    if (note && !selected.includes('OTHER')) { this.setData({ error: '填写其他说明前，请先选择“其他自身免疫病”。' }); return; }
    const payload: Record<string, unknown> = { declined, siblings: siblings.map(({ ageYears, healthy, note: siblingNote }) => ({ ageYears, healthy, ...(siblingNote ? { note: siblingNote } : {}) })), familyAutoimmune: selected, ...(note ? { otherNote: note } : {}), expectedVersion: (this.data.family as FamilyHistory | null)?.version ?? 0, idempotencyKey: '' };
    const previous = pendingFor(outbox, 'FAMILY_HISTORY', entry => entry.payload.declined === declined && JSON.stringify(entry.payload.siblings) === JSON.stringify(payload.siblings) && JSON.stringify(entry.payload.familyAutoimmune) === JSON.stringify(payload.familyAutoimmune) && entry.payload.otherNote === payload.otherNote);
    payload.idempotencyKey = previous?.idempotencyKey ?? newIdempotencyKey('FAMILY_HISTORY');
    try { outbox.enqueue({ operation: 'FAMILY_HISTORY', idempotencyKey: payload.idempotencyKey as string, payload }); } catch (error) { this.setData({ error: error instanceof Error ? error.message : '家族史未保存。' }); return; }
    await this.flushOperation(outbox, 'FAMILY_HISTORY', scope, '家族史');
    if (currentScopeKey() === scope && !(this.data.rejectedCount as number)) await this.load(scope);
  },
  vaccineNameInput(event: { detail?: { value?: string } }) { this.setData({ vaccineName: event.detail?.value ?? '' }); },
  vaccineFacilityInput(event: { detail?: { value?: string } }) { this.setData({ vaccineFacility: event.detail?.value ?? '' }); },
  vaccineDateChange(event: { detail?: { value?: string } }) { const value = event.detail?.value; if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value <= beijingToday()) this.setData({ vaccineDate: value, error: '' }); },
  async saveVaccination() {
    if (this.data.saving || !this.data.canWriteClinical) return;
    const id = patientId(); const scope = currentScopeKey(); const outbox = outboxForCurrent(); const vaccine = String(this.data.vaccineName ?? '').trim(); const facility = String(this.data.vaccineFacility ?? '').trim(); const date = String(this.data.vaccineDate ?? '');
    if (!id || !outbox || !text(vaccine, 100) || !text(facility, 200) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date > beijingToday()) { this.setData({ error: '请填写疫苗名称、接种机构和有效日期（不能晚于今天）。' }); return; }
    const payload: Record<string, unknown> = { vaccine, facility, administeredAt: dateInstant(date), idempotencyKey: '' };
    const previous = pendingFor(outbox, 'VACCINATION_RECORD', entry => entry.payload.vaccine === vaccine && entry.payload.facility === facility && entry.payload.administeredAt === payload.administeredAt);
    payload.idempotencyKey = previous?.idempotencyKey ?? newIdempotencyKey('VACCINATION_RECORD');
    try { outbox.enqueue({ operation: 'VACCINATION_RECORD', idempotencyKey: payload.idempotencyKey as string, payload }); } catch (error) { this.setData({ error: error instanceof Error ? error.message : '接种记录未保存。' }); return; }
    await this.flushOperation(outbox, 'VACCINATION_RECORD', scope, '接种记录');
    if (currentScopeKey() === scope && !(this.data.rejectedCount as number)) { this.setData({ vaccineName: '', vaccineFacility: '', vaccineDate: '' }); await this.load(scope); }
  },
  async flushOperation(outbox: MutationOutbox, operation: MutationOperation, scope: string, label: string) {
    this.setData({ saving: true, error: '', message: '' });
    try {
      const result = await outbox.flush(entry => sendMutation(entry, scope), true, [operation]);
      if (result.denied) { try { outbox.clear(deniedOperations([operation], Boolean(session()))); } catch { /* 保留失权提示 */ } this.setData({ error: '当前身份已无权继续操作，待确认内容已清理。' }); return; }
      this.syncQueue();
      if (result.networkError) this.setData({ message: label + '暂未联网，已保存待提交。' + PENDING_MESSAGE });
      else if (result.rejected) this.setData({ error: label + '未被服务端确认，请核对后重试。' });
      else this.setData({ message: label + '已确认。' });
    } catch (error) {
      if (error instanceof ApiFailure && [401, 403].includes(error.status)) { try { outbox.clear(deniedOperations([operation], Boolean(session()))); } catch { /* 保留原错误 */ } }
      this.setData({ error: error instanceof Error ? error.message : label + '未确认，这条已留在本机，可以直接重试。' });
      this.syncQueue();
    } finally { this.setData({ saving: false }); }
  },
  retryQueue() {
    const scope = currentScopeKey(); const outbox = outboxForCurrent(); if (!outbox || this.data.saving) return;
    void this.flushOperation(outbox, 'PRIVATE_DIARY', scope, '私人记录').then(() => this.flushOperation(outbox, 'VACCINATION_RECORD', scope, '接种记录')).then(() => this.flushOperation(outbox, 'FAMILY_HISTORY', scope, '家族史'));
  },
});
