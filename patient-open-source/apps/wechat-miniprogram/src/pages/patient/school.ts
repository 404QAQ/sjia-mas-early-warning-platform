import { ApiFailure, patientId, request, session } from '../../api';

/**
 * L-01 上学与校园（儿童 / 过渡期患者端）。
 *
 * 这一页解决的是「向学校告知多少」，所以它只做分层设置，不提供「一次通知全部老师」
 * 这种快捷方式（设计规格明确不做：那正是家长最想避免的两种错误之一）：
 * 班主任、校医、任课老师三层各给不同信息量，同学那一层由孩子自己决定（服务端只
 * 允许过渡期患者本人提交 PEER_DECISION）。
 *
 * 页面不信任本地状态：患者范围来自会话，写入带 expectedVersion + 幂等键，
 * 版本冲突时刷新重来，网络未知结果只重放原命令。
 */
type SchoolRecipientRole = 'HEAD_TEACHER' | 'SCHOOL_NURSE' | 'SUBJECT_TEACHER';
type SchoolDisclosureLevel = 'ESSENTIAL' | 'LIMITED';
type PeArrangement = 'FULL' | 'LIMITED' | 'EXEMPT';

interface Recipient { role: SchoolRecipientRole; level: SchoolDisclosureLevel; generatedAt?: string }
interface Disclosure {
  patientId: string;
  term: string;
  recipients: Recipient[];
  peArrangement: PeArrangement;
  schoolEmergencyContact?: { name: string; relation: string; phoneMasked: string; authorized: boolean };
  peerDecision?: { decision: 'SHARE' | 'DO_NOT_SHARE'; setAt: string };
  version: number;
  updatedAt?: string;
}
interface View { disclosure: Disclosure; contentVersion: 'L-01-v1'; guidance: string }
interface Scope { userId: string; actorId: string; patientId: string }
interface Tier { role: SchoolRecipientRole; title: string; level: SchoolDisclosureLevel; levelText: string; detail: string; selected: boolean; generatedAt?: string }

/** 三层的固定文案：信息量按「必须要学校知道什么」递减，任课老师只到请假与作业。 */
const TIERS: Array<{ role: SchoolRecipientRole; title: string; level: SchoolDisclosureLevel; levelText: string; detail: string }> = [
  { role: 'HEAD_TEACHER', title: '班主任', level: 'ESSENTIAL', levelText: '必须知道', detail: '孩子有 sJIA，可能突然发热、精神差；出现这些情况请联系谁；体育课怎么安排。' },
  { role: 'SCHOOL_NURSE', title: '校医', level: 'ESSENTIAL', levelText: '必须知道', detail: '诊断、当前用药，以及学校里的处置指引和紧急联系人。' },
  { role: 'SUBJECT_TEACHER', title: '任课老师', level: 'LIMITED', levelText: '只需知道', detail: '孩子可能请假，作业可以缓交。' },
];

const RECIPIENT_ROLES: SchoolRecipientRole[] = ['HEAD_TEACHER', 'SCHOOL_NURSE', 'SUBJECT_TEACHER'];

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function text(value: unknown, max = 2000): value is string {
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
function isRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return object(value) && only(value, keys);
}

/** 严格按 L-01-v1 合同解析；任何未知字段或越界值都当作格式无效，绝不猜。 */
function parse(value: unknown, id: string): View {
  if (!isRecord(value, ['disclosure', 'contentVersion', 'guidance', 'emergencyShareBoundary']) || value.contentVersion !== 'L-01-v1' || !text(value.guidance, 500)) throw new ApiFailure('校园告知响应格式无效，请稍后重试。', 0);
  // 校园说明不会顺手创建应急分享；边界变了就必须重新审这一页，所以这里硬校验。
  const boundary = value.emergencyShareBoundary;
  if (!isRecord(boundary, ['directShare', 'visibility']) || boundary.directShare !== false || boundary.visibility !== 'G2_SUMMARY') throw new ApiFailure('校园告知响应格式无效，请稍后重试。', 0);
  const raw = value.disclosure;
  if (!isRecord(raw, ['patientId', 'term', 'recipients', 'peArrangement', 'schoolEmergencyContact', 'peerDecision', 'version', 'updatedAt'])) throw new ApiFailure('校园告知响应格式无效，请稍后重试。', 0);
  if (raw.patientId !== id || !text(raw.term, 7) || !/^\d{4}-S[12]$/.test(raw.term)) throw new ApiFailure('校园告知响应与当前患者不一致，请刷新。', 0);
  if (!['FULL', 'LIMITED', 'EXEMPT'].includes(String(raw.peArrangement))) throw new ApiFailure('体育课安排响应无效，请刷新。', 0);
  if (raw.version !== 0 && (typeof raw.version !== 'number' || !Number.isSafeInteger(raw.version) || raw.version < 0)) throw new ApiFailure('校园告知版本无效，请刷新。', 0);
  if (raw.updatedAt !== undefined && !instant(raw.updatedAt)) throw new ApiFailure('校园告知响应格式无效，请稍后重试。', 0);
  if (!Array.isArray(raw.recipients) || raw.recipients.length > 3) throw new ApiFailure('校园告知接收层无效，请刷新。', 0);
  const recipients: Recipient[] = raw.recipients.map(item => {
    if (!isRecord(item, ['role', 'level', 'generatedDocRef', 'generatedAt']) || !RECIPIENT_ROLES.includes(item.role as SchoolRecipientRole) || !['ESSENTIAL', 'LIMITED'].includes(String(item.level))) throw new ApiFailure('校园告知接收层无效，请刷新。', 0);
    if (item.generatedAt !== undefined && !instant(item.generatedAt)) throw new ApiFailure('校园告知说明时间无效，请刷新。', 0);
    return { role: item.role as SchoolRecipientRole, level: item.level as SchoolDisclosureLevel, ...(item.generatedAt === undefined ? {} : { generatedAt: item.generatedAt as string }) };
  });
  let contact: Disclosure['schoolEmergencyContact'];
  if (raw.schoolEmergencyContact !== undefined) {
    const item = raw.schoolEmergencyContact;
    if (!isRecord(item, ['name', 'relation', 'phoneMasked', 'authorized']) || !text(item.name, 100) || !text(item.relation, 60) || typeof item.phoneMasked !== 'string' || !/^\d{3}\*{4}\d{4}$/.test(item.phoneMasked) || typeof item.authorized !== 'boolean') throw new ApiFailure('学校联系人响应无效，请刷新。', 0);
    contact = { name: item.name as string, relation: item.relation as string, phoneMasked: item.phoneMasked, authorized: item.authorized };
  }
  let peer: Disclosure['peerDecision'];
  if (raw.peerDecision !== undefined) {
    if (!isRecord(raw.peerDecision, ['decision', 'setAt']) || !['SHARE', 'DO_NOT_SHARE'].includes(String(raw.peerDecision.decision)) || !instant(raw.peerDecision.setAt)) throw new ApiFailure('同学层选择响应无效，请刷新。', 0);
    peer = { decision: raw.peerDecision.decision as 'SHARE' | 'DO_NOT_SHARE', setAt: raw.peerDecision.setAt as string };
  }
  return { disclosure: { patientId: id, term: raw.term, recipients, peArrangement: raw.peArrangement as PeArrangement, ...(contact ? { schoolEmergencyContact: contact } : {}), ...(peer ? { peerDecision: peer } : {}), version: Number(raw.version), ...(raw.updatedAt === undefined ? {} : { updatedAt: raw.updatedAt as string }) }, contentVersion: 'L-01-v1', guidance: value.guidance };
}

function tiers(value: View): Tier[] {
  const selected = new Map(value.disclosure.recipients.map(item => [item.role, item]));
  return TIERS.map(tier => {
    const chosen = selected.get(tier.role);
    return { ...tier, selected: Boolean(chosen), ...(chosen?.generatedAt === undefined ? {} : { generatedAt: chosen.generatedAt }) };
  });
}
function peText(value: PeArrangement): string {
  return ({ FULL: '正常参加（可能中途需要休息）', LIMITED: '有限参加（免剧烈运动）', EXEMPT: '免修（需要医生开证明）' } as Record<PeArrangement, string>)[value];
}
function termLabel(term: string): string { return `${term.slice(0, 4)} 年 · ${term.endsWith('S1') ? '上半年' : '下半年'}`; }
function termOptions(term: string): Array<{ value: string; label: string }> {
  const year = new Date(Date.now() + 8 * 3600_000).getUTCFullYear();
  const values = new Set([term]);
  for (let offset = -1; offset <= 1; offset += 1) for (const half of ['S1', 'S2']) values.add(`${year + offset}-${half}`);
  return [...values].sort().map(value => ({ value, label: termLabel(value) }));
}
/** 沟通准备单只使用已保存的设置，不补写诊断、用药或学校处置建议。 */
function communicationNotes(view: View): Array<{ role: SchoolRecipientRole; title: string; prepared: boolean; lines: string[] }> {
  return view.disclosure.recipients.map(recipient => {
    const tier = TIERS.find(item => item.role === recipient.role)!;
    const lines = [`学期：${termLabel(view.disclosure.term)}`, `告知范围：${tier.levelText}`];
    if (recipient.role === 'SUBJECT_TEACHER') lines.push('沟通内容：请假与作业安排。');
    else {
      lines.push(`体育课安排：${peText(view.disclosure.peArrangement)}`);
      const contact = view.disclosure.schoolEmergencyContact;
      if (contact?.authorized) lines.push(`学校联系人：${contact.name} · ${contact.relation} · ${contact.phoneMasked}`);
      else lines.push('学校联系人：尚未完成授权，请先与照护团队核对。');
    }
    return { role: recipient.role, title: `给${tier.title}的沟通准备单`, prepared: Boolean(recipient.generatedAt), lines };
  });
}
/** 勾选的层按固定顺序归一化，保证提交内容与显示顺序一致、便于幂等比较。 */
function normalizePicked(value: unknown): SchoolRecipientRole[] {
  const picked = Array.isArray(value) ? value.map(String) : [];
  return RECIPIENT_ROLES.filter(role => picked.includes(role));
}

Page({
  data: {
    loading: true,
    saving: false,
    error: '',
    notice: '',
    scopeKey: '',
    view: null as View | null,
    tiers: [] as Tier[],
    peText: '' as string,
    peOptions: [
    { value: 'FULL' as PeArrangement, label: '正常参加（可能中途需要休息）' },
    { value: 'LIMITED' as PeArrangement, label: '有限参加（免剧烈运动）' },
    { value: 'EXEMPT' as PeArrangement, label: '免修（需要医生开证明）' },
  ],
    peIndex: 0,
    term: '',
    termOptions: [] as Array<{ value: string; label: string }>,
    termIndex: 0,
    savedTermLabel: '',
    communicationNotes: [] as ReturnType<typeof communicationNotes>,
    noteRef: '',
    /** 同学层只有患者本人能定；家长页面上不出现可点的按钮。 */
    canChoosePeer: false,
    peerNotice: '',
    pendingText: '',
  },
  pending: null as Record<string, unknown> | null,

  onLoad() { this.onShow(); },
  onShow() {
    const expected = scope();
    if (!expected) {
      this.pending = null;
      this.setData({ scopeKey: '', loading: false, saving: false, view: null, tiers: [], error: '', notice: '' });
      wx.redirectTo({ url: '/pages/auth/index' });
      return;
    }
    const key = `${expected.userId}:${expected.actorId}:${expected.patientId}`;
    if (key !== this.data.scopeKey) this.setData({ view: null, tiers: [], error: '', notice: '', pendingText: '' });
    // 同学层由孩子自己定：只有患者本人的身份才出现可点按钮，家长页面只看到说明。
    this.setData({ scopeKey: key, canChoosePeer: session()?.role === 'PATIENT' });
    void this.load(expected);
  },

  async load(expected: Scope) {
    if (!sameScope(expected)) return;
    this.setData({ loading: true, error: '' });
    try {
      const value = await request<unknown>(`/api/v1/patients/${encodeURIComponent(expected.patientId)}/school-disclosure`);
      if (!sameScope(expected)) return;
      const parsed = parse(value, expected.patientId);
      this.apply(parsed);
    } catch (error) {
      if (!sameScope(expected)) return;
      this.setData({ error: error instanceof Error ? error.message : '校园告知读取失败，请重试。' });
    } finally {
      if (sameScope(expected)) this.setData({ loading: false });
    }
  },

  apply(view: View) {
    const disclosure = view.disclosure;
    const options = termOptions(disclosure.term);
    const index = this.data.peOptions.findIndex((item: { value: PeArrangement }) => item.value === disclosure.peArrangement);
    this.setData({
      view,
      tiers: tiers(view),
      peText: peText(disclosure.peArrangement),
      peIndex: index < 0 ? 0 : index,
      term: disclosure.term,
      termOptions: options,
      termIndex: options.findIndex(option => option.value === disclosure.term),
      savedTermLabel: termLabel(disclosure.term),
      communicationNotes: communicationNotes(view),
      peerNotice: disclosure.peerDecision
        ? `同学这一层：${disclosure.peerDecision.decision === 'SHARE' ? '由孩子决定后愿意分享' : '由孩子决定后不分享'}`
        : this.data.canChoosePeer ? '同学这一层由孩子自己决定，家长不能代选。' : '同学这一层暂不开放，等孩子自己决定。',
    });
  },

  /**
   * 未知结果只重放同一份命令：刷新后的新版本、新表单内容都不能改写原命令，
   * 否则重试会变成一次内容不同的新写入。
   */
  async commit(fields: Record<string, unknown>, notice: string, expected: Scope) {
    if (!sameScope(expected) || this.data.saving) return;
    const current = this.data.view;
    if (!current && !this.pending) return;
    const command = this.pending ?? { ...fields, expectedVersion: current?.disclosure.version ?? 0, idempotencyKey: newKey() };
    this.pending = command;
    this.setData({ saving: true, error: '', notice: '', pendingText: pendingText(command) });
    try {
      await request<unknown>(`/api/v1/patients/${encodeURIComponent(expected.patientId)}/school-disclosure`, 'POST', command, { retryOnUnauthorized: true });
      if (!sameScope(expected)) return;
      this.pending = null;
      this.setData({ pendingText: '', notice });
      await this.load(expected);
    } catch (error) {
      if (!sameScope(expected)) return;
      this.setData({ error: error instanceof Error ? error.message : '操作未确认，原命令已保留，请重试。' });
      const status = error instanceof ApiFailure ? error.status : 0;
      // 只有服务端给出了明确结论（4xx，且不是超时/限频）才丢弃原命令；
      // status=0 表示结果未知，必须保留同一幂等键重试。
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        this.pending = null;
        this.setData({ pendingText: '' });
      }
      if (status === 401) wx.redirectTo({ url: '/pages/auth/index' });
    } finally {
      if (sameScope(expected)) this.setData({ saving: false });
    }
  },

  changeRecipients(event: { detail?: { value?: unknown } }) {
    const selected = normalizePicked(event.detail?.value);
    this.setData({ tiers: this.data.tiers.map((tier: Tier) => ({ ...tier, selected: selected.includes(tier.role) })) });
  },

  saveSettings() {
    const expected = scope();
    if (!expected) return;
    const roles = (this.data.tiers as Tier[]).filter(tier => tier.selected).map(tier => tier.role);
    const term = String(this.data.term ?? '').trim();
    if (!/^\d{4}-S[12]$/.test(term)) { this.setData({ error: '请先选择学期。' }); return; }
    if (!roles.length) { this.setData({ error: '至少要选一层需要知情的人。分层告知不是全告诉或全不说。' }); return; }
    // 教务层固定「只需知道」，其余两层「必须知道」；与服务端允许的取值一致。
    const recipients = roles.map(role => ({ role, level: role === 'SUBJECT_TEACHER' ? 'LIMITED' : 'ESSENTIAL' }));
    void this.commit({ term, recipients }, '分层设置已保存。', expected);
  },

  generate(event: { currentTarget?: { dataset?: { role?: unknown } } }) {
    const expected = scope();
    const role = event.currentTarget?.dataset?.role;
    if (!expected || !RECIPIENT_ROLES.includes(role as SchoolRecipientRole)) return;
    void this.commit({ action: 'GENERATE_DOCUMENT', role }, '沟通准备已保存，下方可查看准备单。', expected);
  },

  changePe(event: { detail?: { value?: unknown } }) {
    const index = Number(event.detail?.value);
    const option = Number.isSafeInteger(index) ? this.data.peOptions[index] : undefined;
    if (option) this.setData({ peIndex: index, peText: peText(option.value as PeArrangement) });
  },

  pickTerm(event: { detail?: { value?: unknown } }) { const index = Number(event.detail?.value); const option = Number.isSafeInteger(index) ? this.data.termOptions[index] : undefined; if (option) this.setData({ term: option.value, termIndex: index }); },
  changeNote(event: { detail?: { value?: unknown } }) { this.setData({ noteRef: String(event.detail?.value ?? '') }); },

  savePe() {
    const expected = scope();
    const option = this.data.peOptions[this.data.peIndex];
    if (!expected || !option) return;
    const arrangement = option.value as PeArrangement;
    const noteRef = String(this.data.noteRef ?? '').trim();
    // 免修需要医生建议引用；这是服务端硬约束，先在本地拦一次给出可读提示。
    if (arrangement === 'EXEMPT' && !noteRef) { this.setData({ error: '免修需要先填写医生建议（证明）编号。不是免修就更好——能参与对孩子也重要。' }); return; }
    void this.commit({ peArrangement: arrangement, ...(arrangement === 'EXEMPT' ? { peClinicianNoteRef: noteRef } : {}) }, '体育课安排已保存。', expected);
  },

  choosePeer(event: { currentTarget?: { dataset?: { decision?: unknown } } }) {
    const expected = scope();
    const decision = event.currentTarget?.dataset?.decision;
    if (!expected || !this.data.canChoosePeer || !['SHARE', 'DO_NOT_SHARE'].includes(String(decision))) return;
    void this.commit({ action: 'PEER_DECISION', decision }, '同学层选择已保存。', expected);
  },

  retry() {
    const expected = scope();
    if (!expected || !this.pending) return;
    void this.commit(this.pending, '原操作已重试。', expected);
  },
  refresh() { const expected = scope(); if (expected) void this.load(expected); },
});

function newKey(): string {
  // 小程序基础库没有 crypto.randomUUID；用时间戳加随机数足够避免同页重复。
  return `school-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}
function pendingText(command: Record<string, unknown>): string {
  if (command.action === 'GENERATE_DOCUMENT') return '待确认：保存沟通准备。';
  if (command.action === 'PEER_DECISION') return '待确认：保存同学层选择。';
  if (command.peArrangement !== undefined) return '待确认：保存体育课安排。';
  return '待确认：保存分层设置。';
}

export { parse, tiers, peText, normalizePicked, communicationNotes };
