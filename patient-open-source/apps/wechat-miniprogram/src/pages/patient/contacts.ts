import { ApiFailure, patientId, request, session } from '../../api';

/**
 * F-09-A 联系人授权管理（患者端 / 家属端）。
 *
 * 设计规格：**本页没有屏级设计规格**。design/spec 里只有导航图一句「G1/G2/G3 管理」，
 * 没有成型的屏幕稿。因此这一页按服务端既有语义做**最小可用实现** —— 不发明产品规则、
 * 不自创阈值或承诺，只把服务端已经实现并且当前身份真正能做的动作暴露出来。
 *
 * 服务端出处（调用前逐条核对过）：
 *   - 患者 API 的 contacts 与 contact-authorizations 资源（列表 GET，写操作 POST .../:contactId/(grant|withdraw|confirm)）
 *   - 患者 API 的授权服务（只允许 SELF / LEGAL_GUARDIAN + MANAGE_CONTACTS，否则 403）
 *   - 患者 API 的 ContactAuthorizationView 投影（号码经服务端脱敏）
 *   - 领域契约中的授予、撤回、确认与授权新鲜度规则
 *
 * 授权边界（前端不绕过）：
 *   - 只有患者本人或当前合法法定监护人能管理联系人授权；这一页不按本地缓存的 role 猜权限，
 *     而是用列表请求本身当授权探针：列表能读出来，说明服务端已经放行，才显示写动作；
 *     列表被 403 拒绝，就只如实说明「当前身份不能管理」，不显示任何必然失败的按钮。
 *   - 授予只接受 priority(1|2) + visibility(G1_NOTIFY|G2_SUMMARY)：**G3 不在这里**，
 *     服务端 contact-safety-service.ts:34/40 里 grant 的 visibility 只有 G1/G2，命中 G3 会被拒。
 *
 * 可见度档位含义（服务端口径，非本页自创）：
 *   - G1_NOTIFY「仅知会」：联系人只被告知「有事情需要联系并确认」，看不到任何患者数据。
 *     出处：患者安全工作流契约（短链摘要仅 G2_SUMMARY 才附患者姓名）。
 *   - G2_SUMMARY「知会 + 摘要」：额外能看到患者姓名和变化方向性的摘要，**仍不下发化验值/原值**。
 *     出处：患者摘要契约（familyTrendNarrative 只表达升降方向）。
 *   - G3_FULL「完整共享」只服务照护团队/本人，短信短链上限就是 G2。
 */

type Visibility = 'G1_NOTIFY' | 'G2_SUMMARY';
type Status = 'ACTIVE' | 'WITHDRAWN' | 'NONE';
type Freshness = 'CURRENT' | 'DUE' | 'STALE' | 'NONE';
type Priority = 1 | 2;
type Action = 'grant' | 'withdraw' | 'confirm';

interface Scope { userId: string; actorId: string; patientId: string }

/** 与服务端 ContactAuthorizationView 逐字段对齐的本地投影。可空字段一律用 null 表示「服务端明确给了 null」。 */
interface AuthorizationView {
  contactId: string;
  patientId: string;
  displayName: string;
  phoneMasked: string | null;
  tier: 1 | 2 | 'PROFESSIONAL' | null;
  status: Status;
  priority: Priority | null;
  visibility: Visibility | null;
  quietHours: { from: string; to: string } | null;
  consentText: string | null;
  version: number;
  grantedAt: string | null;
  lastConfirmedAt: string | null;
  freshness: Freshness;
  nextConfirmAt: string | null;
  withdrawnAt: string | null;
}

/** 渲染用的一行：在原 DTO 上附带人话标签与「能不能做某个动作」。 */
interface ContactRow extends AuthorizationView {
  statusLabel: string;
  priorityLabel: string;
  visibilityLabel: string;
  quietLabel: string;
  freshnessLabel: string;
  phoneLabel: string;
  tierLabel: string;
  grantedLabel: string;
  confirmedLabel: string;
  nextConfirmLabel: string;
  withdrawnLabel: string;
  hasConsent: boolean;
  canGrant: boolean;
  canWithdraw: boolean;
  canConfirm: boolean;
}

interface PendingCommand { contactId: string; action: Action; body: Record<string, unknown> }

/**
 * 严格白名单：服务端 DTO 的字段集合，多一个字段就拒绝。
 * 注意这里**没有** phone / phoneEncrypted 之类的明文号码字段名 —— 只认 phoneMasked。
 */
const ALLOWED_FIELDS = ['contactId', 'patientId', 'displayName', 'phoneMasked', 'tier', 'status', 'priority', 'visibility', 'quietHours', 'consentText', 'version', 'grantedAt', 'lastConfirmedAt', 'freshness', 'nextConfirmAt', 'withdrawnAt'];
const STATUSES: Status[] = ['ACTIVE', 'WITHDRAWN', 'NONE'];
const VISIBILITIES: Visibility[] = ['G1_NOTIFY', 'G2_SUMMARY'];
const FRESHNESSES: Freshness[] = ['CURRENT', 'DUE', 'STALE', 'NONE'];

const VISIBILITY_TEXT: Record<Visibility, string> = {
  G1_NOTIFY: '仅通知 · 不显示健康记录',
  G2_SUMMARY: '通知与摘要 · 显示姓名和变化趋势，不包含化验值',
};
const STATUS_TEXT: Record<Status, string> = { ACTIVE: '授权有效', WITHDRAWN: '已撤回', NONE: '尚未授权' };
const FRESHNESS_TEXT: Record<Freshness, string> = {
  CURRENT: '当前有效',
  DUE: '授权需要重新确认',
  STALE: '授权已过期，需要重新确认',
  NONE: '没有生效中的授权',
};

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function text(value: unknown, max = 500): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\0\r\n]/.test(value);
}
function instant(value: unknown): value is string {
  return text(value, 80) && Number.isFinite(Date.parse(value));
}
function nullableInstant(value: unknown): value is string | null {
  return value === null || instant(value);
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

/** 解析列表里的单条记录。任何未知字段、非法枚举、越界版本都当契约被破坏，整页报错而不是静默接受。 */
function parseAuthorization(value: unknown, id: string): AuthorizationView {
  const bad = () => new ApiFailure('联系人授权响应格式无效，请稍后重试。', 0);
  if (!object(value) || !only(value, ALLOWED_FIELDS) || value.patientId !== id) throw bad();
  if (!text(value.contactId, 256) || !text(value.displayName, 200)) throw bad();
  if (value.phoneMasked !== undefined && !text(value.phoneMasked, 64)) throw bad();
  if (value.tier !== undefined && value.tier !== null && value.tier !== 1 && value.tier !== 2 && value.tier !== 'PROFESSIONAL') throw bad();
  if (!STATUSES.includes(value.status as Status)) throw bad();
  if (value.priority !== null && value.priority !== 1 && value.priority !== 2) throw bad();
  if (value.visibility !== null && !VISIBILITIES.includes(value.visibility as Visibility)) throw bad();
  if (typeof value.version !== 'number' || !Number.isSafeInteger(value.version) || value.version < 0) throw bad();
  for (const field of ['grantedAt', 'lastConfirmedAt', 'nextConfirmAt', 'withdrawnAt']) if (!nullableInstant(value[field])) throw bad();
  if (!FRESHNESSES.includes(value.freshness as Freshness)) throw bad();
  if (value.consentText !== null && !text(value.consentText, 2000)) throw bad();
  if (value.quietHours !== null) {
    if (!object(value.quietHours) || !only(value.quietHours, ['from', 'to']) || !text(value.quietHours.from, 5) || !text(value.quietHours.to, 5)) throw bad();
  }
  return {
    contactId: value.contactId,
    patientId: id,
    displayName: value.displayName,
    phoneMasked: value.phoneMasked === undefined || value.phoneMasked === null ? null : value.phoneMasked,
    tier: value.tier === undefined || value.tier === null ? null : (value.tier as AuthorizationView['tier']),
    status: value.status as Status,
    priority: value.priority === null ? null : (value.priority as Priority),
    visibility: value.visibility === null ? null : (value.visibility as Visibility),
    quietHours: value.quietHours === null ? null : { from: (value.quietHours as { from: string }).from, to: (value.quietHours as { to: string }).to },
    consentText: value.consentText === null ? null : value.consentText,
    version: value.version,
    grantedAt: value.grantedAt === null ? null : (value.grantedAt as string),
    lastConfirmedAt: value.lastConfirmedAt === null ? null : (value.lastConfirmedAt as string),
    freshness: value.freshness as Freshness,
    nextConfirmAt: value.nextConfirmAt === null ? null : (value.nextConfirmAt as string),
    withdrawnAt: value.withdrawnAt === null ? null : (value.withdrawnAt as string),
  };
}

/** 响应 data 是**数组**（无分页），上限保护防止异常放大渲染。 */
function parseList(value: unknown, id: string): AuthorizationView[] {
  if (!Array.isArray(value) || value.length > 200) throw new ApiFailure('联系人授权响应格式无效，请稍后重试。', 0);
  return value.map(item => parseAuthorization(item, id));
}

/** 写操作的响应体：{ authorization, invalidatedLinkCount, created }。撤回会带回被失效的短链数。 */
function parseMutation(value: unknown, id: string): { authorization: AuthorizationView; invalidatedLinkCount: number } {
  if (!object(value) || !only(value, ['authorization', 'invalidatedLinkCount', 'created'])) throw new ApiFailure('联系人授权响应格式无效，请稍后重试。', 0);
  if (typeof value.invalidatedLinkCount !== 'number' || !Number.isSafeInteger(value.invalidatedLinkCount) || value.invalidatedLinkCount < 0) throw new ApiFailure('联系人授权响应格式无效，请稍后重试。', 0);
  if (typeof value.created !== 'boolean') throw new ApiFailure('联系人授权响应格式无效，请稍后重试。', 0);
  return { authorization: parseAuthorization(value.authorization, id), invalidatedLinkCount: value.invalidatedLinkCount };
}

/**
 * 把一个 DTO 变成可渲染的一行，并算出**当前状态真正能做**的动作：
 *   - 授权：NONE（还没有）或 WITHDRAWN（撤回了想重来）时可以授予；
 *   - 撤回：只有 ACTIVE 能撤回（服务端 CONTACT_AUTHORIZATION_NOT_ACTIVE 会拒绝已撤回的重撤）；
 *   - 确认：只有 ACTIVE 且新鲜度是 DUE/STALE 才有意义（CURRENT 无需确认；NONE 无授权无法确认）。
 * 这些判定与 packages/domain/src/contact-safety.ts:139/164/184 的门禁一致，不制造必然失败的按钮。
 */
function describeRow(value: AuthorizationView): ContactRow {
  const tierLabel = value.tier === null ? '' : value.tier === 'PROFESSIONAL' ? '专业联系人' : value.tier === 1 ? '一级联系人' : '二级联系人';
  return {
    ...value,
    statusLabel: STATUS_TEXT[value.status],
    priorityLabel: value.priority === 1 ? '一级联系人' : value.priority === 2 ? '二级联系人' : '未设顺位',
    visibilityLabel: value.visibility ? VISIBILITY_TEXT[value.visibility] : '未设可见度',
    quietLabel: value.quietHours ? `勿扰时段：${value.quietHours.from}–${value.quietHours.to}（按 UTC 计算）` : '',
    freshnessLabel: FRESHNESS_TEXT[value.freshness],
    phoneLabel: value.phoneMasked ? `号码（已脱敏）：${value.phoneMasked}` : '',
    tierLabel,
    grantedLabel: value.grantedAt ? `首次授权：${formatDate(value.grantedAt)}` : '',
    confirmedLabel: value.lastConfirmedAt ? `最近确认：${formatDate(value.lastConfirmedAt)}` : '',
    nextConfirmLabel: value.nextConfirmAt ? `下次确认不晚于 ${formatDate(value.nextConfirmAt)}` : '',
    withdrawnLabel: value.withdrawnAt ? `撤回时间：${formatDate(value.withdrawnAt)}` : '',
    hasConsent: text(value.consentText, 2000),
    canGrant: value.tier !== 'PROFESSIONAL',
    canWithdraw: value.status === 'ACTIVE',
    canConfirm: value.status === 'ACTIVE' && (value.freshness === 'DUE' || value.freshness === 'STALE'),
  };
}

function priorityOf(value: unknown): Priority | null {
  return value === 1 || value === 2 ? value : null;
}
function visibilityOf(value: unknown): Visibility | null {
  return value === 'G1_NOTIFY' || value === 'G2_SUMMARY' ? value : null;
}
/** quietHours 只在两端都合法且非空时才带；服务端会按 HH:mm 校验并拒绝空区间。 */
function quietHoursOf(from: unknown, to: unknown): { from: string; to: string } | undefined {
  if (from === '' && to === '') return undefined;
  if (text(from, 5) && text(to, 5) && /^([01]\d|2[0-3]):[0-5]\d$/.test(from) && /^([01]\d|2[0-3]):[0-5]\d$/.test(to) && from !== to) return { from, to };
  return undefined;
}

interface DirectoryContact { id: string; displayName: string; relation: string; phoneMasked: string; tier: 1 | 2 | 'PROFESSIONAL'; canManage: boolean; authorizationActive: boolean }
interface Directory { patientId: string; version: number; contacts: DirectoryContact[] }
function parseDirectory(value: unknown, id: string): Directory {
  if (!object(value) || !only(value, ['patientId', 'version', 'contacts', 'updatedAt']) || value.patientId !== id || !Number.isSafeInteger(value.version) || Number(value.version) < 0 || !Array.isArray(value.contacts) || value.contacts.length > 200) throw new Error('联系人登记响应无效。');
  const contacts = value.contacts.map(item => { if (!object(item) || !only(item, ['id', 'displayName', 'relation', 'phoneMasked', 'tier', 'canManage', 'authorizationActive']) || !text(item.id, 200) || !text(item.displayName, 100) || !text(item.relation, 50) || typeof item.phoneMasked !== 'string' || ![1, 2, 'PROFESSIONAL'].includes(item.tier as number | string) || typeof item.canManage !== 'boolean' || typeof item.authorizationActive !== 'boolean') throw new Error('联系人登记响应无效。'); return item as unknown as DirectoryContact; });
  return { patientId: id, version: Number(value.version), contacts };
}

Page({
  data: {
    loading: true,
    saving: false,
    error: '',
    notice: '',
    scopeKey: '',
    rows: [] as ContactRow[],
    /** 当前正在编辑授权表单的联系人；null 表示没有展开任何表单。 */
    editingId: '',
    formPriority: 1 as Priority,
    formVisibility: 'G2_SUMMARY' as Visibility,
    formConsentText: '',
    formQuietEnabled: false,
    formQuietFrom: '22:00',
    formQuietTo: '07:00',
    /** 撤回是不可逆的，且会连带失效已发出的短链：必须先展开确认再提交。 */
    confirmingWithdrawId: '',
    pendingText: '',
    directory: null as Directory | null, directoryError: '', registrationOpen: false, registrationId: '', registrationName: '', registrationRelation: '', registrationPhone: '', registrationTier: 1,
  },
  directoryPending: null as { path: string; body: Record<string, unknown> } | null,
  pending: null as PendingCommand | null,

  onLoad() { this.onShow(); },
  onShow() {
    const expected = scope();
    if (!expected) {
      this.pending = null; this.directoryPending = null;
      this.setData({ scopeKey: '', loading: false, saving: false, directory: null, registrationOpen: false, registrationId: '', registrationName: '', registrationRelation: '', registrationPhone: '', rows: [], error: '', notice: '', editingId: '', confirmingWithdrawId: '', pendingText: '' });
      wx.redirectTo({ url: '/pages/auth/index' });
      return;
    }
    const key = `${expected.userId}:${expected.actorId}:${expected.patientId}`;
    // 换身份必须连待重放命令一起清：否则同一个 (contactId, action) 会命中旧命令，
    // 把上一身份生成的 expectedVersion/幂等键 POST 到新身份上。
    if (key !== this.data.scopeKey) { this.pending = null; this.directoryPending = null; this.setData({ directory: null, registrationOpen: false, registrationId: '', registrationName: '', registrationRelation: '', registrationPhone: '', rows: [], error: '', notice: '', editingId: '', confirmingWithdrawId: '', pendingText: '' }); }
    this.setData({ scopeKey: key });
    void this.load(expected);
  },

  async load(expected: Scope) {
    if (!sameScope(expected)) return;
    this.setData({ loading: true, error: '' });
    try {
      const [value, directory] = await Promise.all([request<unknown>(`/api/v1/patients/${encodeURIComponent(expected.patientId)}/contact-authorizations`), request<unknown>(`/api/v1/patients/${encodeURIComponent(expected.patientId)}/contacts`).then(raw => parseDirectory(raw, expected.patientId)).catch(() => null)]);
      if (!sameScope(expected)) return;
      this.setData({ directory, directoryError: directory ? '' : '联系人登记暂不可用，请刷新后重试。', rows: parseList(value, expected.patientId).map(describeRow).map(row => { const contact = directory?.contacts.find(item => item.id === row.contactId); return { ...row, ...(contact ? { displayName: contact.displayName, relationLabel: contact.relation, canManage: contact.canManage } : {}) }; }) });
    } catch (error) {
      if (!sameScope(expected)) return;
      // 403 说明当前身份不能管理联系人授权 —— 如实说明，并清掉可能残留的写入口。
      if (error instanceof ApiFailure && error.status === 403) this.setData({ rows: [], directory: null, directoryError: '', registrationOpen: false, registrationPhone: '', registrationName: '', registrationRelation: '', editingId: '', error: '当前身份不能管理联系人授权。只有患者本人或当前合法法定监护人可以设置。' });
      else this.setData({ error: error instanceof Error ? error.message : '联系人授权读取失败，请重试。' });
      if (error instanceof ApiFailure && error.status === 401) wx.redirectTo({ url: '/pages/auth/index' });
    } finally {
      if (sameScope(expected)) this.setData({ loading: false });
    }
  },

  openRegister(event: { currentTarget?: { dataset?: { id?: unknown } } }) {
    if (this.data.saving || !this.data.directory) return;
    if (this.pending || this.directoryPending) { this.setData({ error: '请先重试确认上一条操作，再编辑联系人。' }); return; }
    const id = event.currentTarget?.dataset?.id;
    const item = (this.data.directory as Directory).contacts.find(contact => contact.id === id);
    if (typeof id === 'string' && (!item || !item.canManage)) return;
    this.setData({ registrationOpen: true, registrationId: item?.id ?? '', registrationName: item?.displayName ?? '', registrationRelation: item?.relation ?? '', registrationPhone: '', registrationTier: item?.tier === 2 ? 2 : 1, editingId: '', error: '', notice: '' });
  },
  closeRegister() { if (!this.data.saving) this.setData({ registrationOpen: false, registrationPhone: '' }); },
  registrationInput(event: { currentTarget?: { dataset?: { field?: unknown } }; detail?: { value?: unknown } }) {
    const key = event.currentTarget?.dataset?.field; const value = event.detail?.value;
    if (typeof value === 'string' && ['registrationName', 'registrationRelation', 'registrationPhone'].includes(String(key))) this.setData({ [String(key)]: value });
  },
  registrationPriority(event: { detail?: { value?: unknown } }) { this.setData({ registrationTier: event.detail?.value === '2' ? 2 : 1 }); },
  saveRegister() {
    const expected = scope(); if (!expected || !this.data.directory || this.data.saving) return;
    const name = String(this.data.registrationName).trim(); const relation = String(this.data.registrationRelation).trim(); const phone = String(this.data.registrationPhone).trim();
    if (!name || !relation || (!this.data.registrationId || phone) && !/^\+?[0-9]{7,15}$/.test(phone)) { this.setData({ error: '请填写姓名、关系和有效联系电话。' }); return; }
    const body = { displayName: name, relation, tier: this.data.registrationTier, ...(phone ? { phone } : {}), expectedVersion: this.data.directory.version, idempotencyKey: newKey('contact-registration') };
    const path = `/api/v1/patients/${encodeURIComponent(expected.patientId)}/contacts${this.data.registrationId ? `/${encodeURIComponent(this.data.registrationId)}` : ''}`;
    void this.sendRegistration({ path, body }, expected);
  },
  removeRegistration(event: { currentTarget?: { dataset?: { id?: unknown } } }) {
    const expected = scope(); const id = event.currentTarget?.dataset?.id; const directory = this.data.directory as Directory | null;
    const item = directory?.contacts.find(contact => contact.id === id);
    if (!expected || !directory || !item?.canManage || this.data.saving) return;
    wx.showModal({ title: '移除这位联系人？', content: '同时撤回其授权与已发出的分享链接。需要时可以重新登记。', confirmText: '确认移除', success: result => { if (!result.confirm || !sameScope(expected)) return; void this.sendRegistration({ path: `/api/v1/patients/${encodeURIComponent(expected.patientId)}/contacts/${encodeURIComponent(item.id)}/remove`, body: { expectedVersion: directory.version, idempotencyKey: newKey('contact-remove') } }, expected); } });
  },
  async sendRegistration(command: { path: string; body: Record<string, unknown> }, expected: Scope) {
    if (!sameScope(expected) || this.data.saving) return;
    this.directoryPending = this.directoryPending ?? command;
    const pending = this.directoryPending;
    this.setData({ saving: true, error: '', notice: '', pendingText: '联系人变更正在确认。' });
    try {
      const result = await request<unknown>(pending.path, 'POST', pending.body);
      if (!sameScope(expected)) return;
      if (!object(result)) throw new Error('联系人变更回执无效。');
      parseDirectory(result.view, expected.patientId);
      this.directoryPending = null;
      this.setData({ registrationOpen: false, registrationPhone: '', pendingText: '', notice: '联系人资料已保存。新增联系人需另行授权；变更号码会撤回原授权。' });
      await this.load(expected);
    } catch (error) {
      if (!sameScope(expected)) return;
      this.setData({ error: error instanceof Error ? error.message : '联系人保存失败，请重试。' });
      if (error instanceof ApiFailure && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) { this.directoryPending = null; this.setData({ pendingText: '' }); if (error.status === 409) await this.load(expected); }
    } finally { if (sameScope(expected)) this.setData({ saving: false }); }
  },

  openGrant(event: { currentTarget?: { dataset?: { id?: unknown } } }) {
    if (this.data.saving || this.pending || this.directoryPending) return;
    const id = event.currentTarget?.dataset?.id;
    if (typeof id !== 'string') return;
    const row = (this.data.rows as ContactRow[]).find(item => item.contactId === id);
    if (!row || !row.canGrant) return;
    // 重授时沿用已有的顺位/可见度与同意文本快照作为默认值，减少重复输入；不替用户改掉原值。
    this.setData({
      editingId: id,
      formPriority: row.priority ?? (row.tier === 2 ? 2 : 1),
      formVisibility: row.visibility ?? 'G2_SUMMARY',
      formConsentText: row.consentText ?? '',
      formQuietEnabled: Boolean(row.quietHours),
      formQuietFrom: row.quietHours?.from ?? '22:00',
      formQuietTo: row.quietHours?.to ?? '07:00',
      confirmingWithdrawId: '',
      error: '',
      notice: '',
    });
  },
  closeGrant() { this.setData({ editingId: '' }); },
  changePriority(event: { detail?: { value?: unknown } }) { this.setData({ formPriority: priorityOf(Number(event.detail?.value)) ?? this.data.formPriority }); },
  changeVisibility(event: { detail?: { value?: unknown } }) { const next = visibilityOf(event.detail?.value); if (next) this.setData({ formVisibility: next }); },
  consentInput(event: { detail?: { value?: unknown } }) { this.setData({ formConsentText: typeof event.detail?.value === 'string' ? event.detail.value.slice(0, 2000) : '' }); },
  quietInput(event: { currentTarget?: { dataset?: { field?: unknown } }; detail?: { value?: unknown } }) {
    const field = event.currentTarget?.dataset?.field;
    const value = typeof event.detail?.value === 'string' ? event.detail.value.slice(0, 5) : '';
    if (field === 'from') this.setData({ formQuietFrom: value });
    else if (field === 'to') this.setData({ formQuietTo: value });
  },
  toggleQuiet(event: { detail?: { value?: unknown } }) { this.setData({ formQuietEnabled: Array.isArray(event.detail?.value) && event.detail.value.includes('on') }); },

  submitGrant() {
    const expected = scope();
    const id = this.data.editingId;
    if (!expected || !id) return;
    const row = (this.data.rows as ContactRow[]).find(item => item.contactId === id);
    if (!row || !row.canGrant) return;
    const consent = String(this.data.formConsentText ?? '').trim();
    if (!consent) { this.setData({ error: '请先填写这条授权对联系人展示的同意文本。' }); return; }
    if (consent.length > 2000) { this.setData({ error: '同意文本不能超过 2000 字。' }); return; }
    const quiet = this.data.formQuietEnabled ? quietHoursOf(this.data.formQuietFrom, this.data.formQuietTo) : undefined;
    if (this.data.formQuietEnabled && !quiet) { this.setData({ error: '勿扰时段请填 HH:mm 的两个不同时刻，例如 22:00 与 07:00。' }); return; }
    const body: Record<string, unknown> = {
      priority: this.data.formPriority,
      visibility: this.data.formVisibility,
      consentText: consent,
      expectedVersion: row.version,
      idempotencyKey: newKey('contact-grant'),
      ...(quiet ? { quietHours: quiet } : {}),
    };
    this.setData({ editingId: '' });
    void this.send(id, 'grant', body, expected, '授权已保存。');
  },

  askWithdraw(event: { currentTarget?: { dataset?: { id?: unknown } } }) {
    const id = event.currentTarget?.dataset?.id;
    if (typeof id !== 'string') return;
    const row = (this.data.rows as ContactRow[]).find(item => item.contactId === id);
    if (!row || !row.canWithdraw) return;
    this.setData({ confirmingWithdrawId: id, editingId: '', error: '' });
  },
  cancelWithdraw() { this.setData({ confirmingWithdrawId: '' }); },
  withdraw(event: { currentTarget?: { dataset?: { id?: unknown } } }) {
    const expected = scope();
    const id = event.currentTarget?.dataset?.id;
    if (!expected || typeof id !== 'string' || this.data.confirmingWithdrawId !== id) return;
    const row = (this.data.rows as ContactRow[]).find(item => item.contactId === id);
    if (!row || !row.canWithdraw) return;
    this.setData({ confirmingWithdrawId: '' });
    void this.send(id, 'withdraw', { expectedVersion: row.version, idempotencyKey: newKey('contact-withdraw') }, expected, '已撤回这条授权。');
  },

  confirmFreshness(event: { currentTarget?: { dataset?: { id?: unknown } } }) {
    const expected = scope();
    const id = event.currentTarget?.dataset?.id;
    if (!expected || typeof id !== 'string') return;
    const row = (this.data.rows as ContactRow[]).find(item => item.contactId === id);
    if (!row || !row.canConfirm) return;
    void this.send(id, 'confirm', { expectedVersion: row.version, idempotencyKey: newKey('contact-confirm') }, expected, '已确认这条授权仍然有效。');
  },

  /**
   * 未知结果只重放同一份命令：刷新后的新版本、改动过的表单都不能改写原命令，
   * 否则「重试」会变成一次内容不同的新写入。服务端给出明确结论（4xx，非超时/限频）才丢弃。
   */
  async send(contactId: string, action: Action, body: Record<string, unknown>, expected: Scope, notice: string) {
    if (!sameScope(expected) || this.data.saving) return;
    const command = this.pending && this.pending.contactId === contactId && this.pending.action === action ? this.pending : { contactId, action, body };
    this.pending = command;
    this.setData({ saving: true, error: '', notice: '', pendingText: `待确认：${actionText(action)}「${this.displayOf(contactId)}」。` });
    try {
      const raw = await request<unknown>(`/api/v1/patients/${encodeURIComponent(expected.patientId)}/contact-authorizations/${encodeURIComponent(contactId)}/${action}`, 'POST', command.body);
      if (!sameScope(expected)) return;
      const result = parseMutation(raw, expected.patientId);
      this.pending = null; this.directoryPending = null;
      this.setData({ pendingText: '', notice: notice + (action === 'withdraw' ? withdrawEffect(result.invalidatedLinkCount) : '') });
      await this.load(expected);
    } catch (error) {
      if (!sameScope(expected)) return;
      const status = error instanceof ApiFailure ? error.status : 0;
      const code = error instanceof ApiFailure ? error.code : undefined;
      this.setData({ error: messageFor(code, error) });
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) { this.pending = null; this.setData({ pendingText: '' }); }
      // 版本/幂等冲突说明别处已经改过或重放过，必须重新读取再决定，不能靠重试猜。
      if (code === 'CONTACT_AUTHORIZATION_VERSION_CONFLICT' || code === 'IDEMPOTENCY_CONFLICT' || status === 404) await this.load(expected);
      if (status === 401) wx.redirectTo({ url: '/pages/auth/index' });
    } finally {
      if (sameScope(expected)) this.setData({ saving: false });
    }
  },

  retry() {
    const expected = scope();
    if (expected && this.directoryPending) { void this.sendRegistration(this.directoryPending, expected); return; }
    const command = this.pending;
    if (!expected || !command) return;
    void this.send(command.contactId, command.action, command.body, expected, '原操作已重试。');
  },
  refresh() { const expected = scope(); if (expected) void this.load(expected); },

  displayOf(contactId: string): string {
    const row = (this.data.rows as ContactRow[]).find(item => item.contactId === contactId);
    return row ? row.displayName : '该联系人';
  },
});

function actionText(action: Action): string {
  return ({ grant: '授权', withdraw: '撤回', confirm: '确认新鲜度' } as Record<Action, string>)[action];
}

/** 撤回会连带失效已经发出的短链，这个后果必须让人看见，而不是埋在日志里。 */
function withdrawEffect(count: number): string {
  return count > 0 ? `同时失效了 ${count} 条已发出的联系人短链。` : '没有需要失效的短链。';
}

/** 服务端的明确结论翻成人话；不确定的一律按「未确认」处理。 */
function messageFor(code: string | undefined, error: unknown): string {
  if (code === 'FORBIDDEN') return '只有患者本人或当前合法法定监护人可以管理联系人授权。';
  if (code === 'CONTACT_NOT_FOUND') return '服务端没有这位联系人的登记，可能是登记已变更，已为你重新读取。';
  if (code === 'CONTACT_AUTHORIZATION_NOT_FOUND') return '这条授权已不存在（可能已被撤回），已为你重新读取。';
  if (code === 'CONTACT_AUTHORIZATION_VERSION_CONFLICT') return '授权版本已变化，已为你重新读取，请确认后再操作。';
  if (code === 'CONTACT_AUTHORIZATION_ALREADY_WITHDRAWN') return '这条授权已经撤回过了。';
  if (code === 'CONTACT_AUTHORIZATION_NOT_ACTIVE') return '已撤回的授权不能再确认。';
  if (code === 'IDEMPOTENCY_CONFLICT') return '这次操作已被别处提交过，请刷新后重新发起。';
  if (code === 'INVALID_CONTACT_AUTHORIZATION_INPUT') return '提交内容不完整或格式不对，请检查顺位、可见度和同意文本。';
  if (code === 'INVALID_INPUT') return '请求格式不对，请刷新后重试。';
  return error instanceof Error ? error.message : '操作未确认，原操作已保留，请重试。';
}

export { parseAuthorization, parseList, parseMutation, describeRow, withdrawEffect };
