import { ApiFailure, patientId, request, session } from '../../api';

/**
 * O-04 跨院数据共享（患者端）。
 *
 * 规格：`design/spec/04-疾病轨迹与运营配置屏幕规格.md` 的 **O-04 · 多中心与数据共享（v3）**。
 * 本页有屏级设计规格（O-04），关键元素与「真实文案」表按规格逐字取用，不自行润色：
 *   - 每个机构对都要能看见「哪家医院看得到我的哪些数据」，与 O-03「谁看过我的数据」保持一致；
 *   - 共享范围逐项开关，心理筛查默认关闭，**情绪日记永久关闭、不可开启**；
 *   - 情绪日记必须有这句：「你自己写的东西，任何医院都看不到。」
 *
 * 动作边界（服务端硬约束，前端不得绕过；见 data-sharing-service.ts authorizeMutation）：
 *   - 发起共享请求是医护-only（要求 CLINICIAN 且从患者当前照护机构发起）——患者端**不提供**；
 *   - 确认 / 修改 / 终止 限 SELF / LEGAL_GUARDIAN ——本页只提供这三个；
 *   - 情绪日记永远不可勾选：服务端 normalizeDataSharingScopes 遇到 moodDiary=true 直接抛错，
 *     所以这里只做只读说明，绝不把它渲染成可选项。
 *
 * 身份范围（前端不信任本地缓存）：patientId 只来自 session()，展示前一律用 sameScope 校验。
 */
type SharingStatus = 'PENDING' | 'ACTIVE' | 'REVOKED';
type Action = 'CONFIRM' | 'UPDATE' | 'REVOKE';

interface Scopes { observations: boolean; medications: boolean; alerts: boolean; psychScreening: boolean; lifeInfo: boolean }
interface ScopeView {
  fromOrgId: string;
  toOrgId: string;
  status: SharingStatus;
  version: number;
  scopes: Scopes;
  requestedAt: string;
  patientConfirmedAt?: string;
  lastChangedAt: string;
  revokedAt?: string;
}
interface Scope { userId: string; actorId: string; patientId: string }
interface Item {
  key: string;
  fromOrgId: string;
  toOrgId: string;
  status: SharingStatus;
  statusLabel: string;
  version: number;
  canConfirm: boolean;
  canUpdate: boolean;
  canRevoke: boolean;
  visibleText: string;
  hiddenText: string;
  confirmedText: string;
  /** 逐项开关（不含情绪日记——它永远不可开）。 */
  choices: Array<{ key: 'observations' | 'medications' | 'alerts' | 'psychScreening' | 'lifeInfo'; label: string; checked: boolean }>;
  /** 只读说明行：情绪日记。 */
  moodDiaryNote: string;
}
interface Policy { moodDiary: 'NEVER_SHARED'; psychScreeningDefault: 'OFF'; patientConfirmationRequired: true }

/** 逐项范围的人类可读标签，文案与规格「真实文案」表一致。 */
const SCOPE_LABELS: Array<{ key: keyof Scopes; label: string }> = [
  { key: 'observations', label: '体温、症状、化验值' },
  { key: 'medications', label: '用药方案' },
  { key: 'alerts', label: '告警历史' },
  { key: 'psychScreening', label: '心理筛查结果' },
  { key: 'lifeInfo', label: '家庭与生活信息' },
];
const ALLOWED_ITEM_FIELDS = ['fromOrgId', 'toOrgId', 'scope'];
const ALLOWED_SCOPE_FIELDS = ['patientId', 'fromOrgId', 'toOrgId', 'scopes', 'status', 'version', 'requestedAt', 'patientConfirmedAt', 'lastChangedAt', 'revokedAt'];
const ALLOWED_SCOPE_FLAGS = ['observations', 'medications', 'alerts', 'psychScreening', 'moodDiary', 'lifeInfo'];
const STATUS_LABELS: Record<SharingStatus, string> = { PENDING: '待确认', ACTIVE: '已生效', REVOKED: '已终止' };
const MOOD_DIARY_NOTE = '你自己写的东西，任何医院都看不到。';

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function text(value: unknown, max = 200): value is string {
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
function newKey(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** 机构展示名：服务端只给 ID，本页不发明机构名称，按 ID 如实呈现。 */
function orgLabel(orgId: string): string {
  return `${orgId}（协作机构）`;
}

/**
 * 严格解析：机构对必须与请求的患者一致；unknown 字段一律拒绝；
 * 情绪日记只允许 false（服务端契约如此），出现 true 说明契约被破坏。
 */
function parseScope(value: unknown, id: string, fromOrgId: string, toOrgId: string): ScopeView {
  if (!object(value) || !only(value, ALLOWED_SCOPE_FIELDS)) throw new ApiFailure('跨院共享响应无效，请稍后重试。', 0);
  if (value.patientId !== id || value.fromOrgId !== fromOrgId || value.toOrgId !== toOrgId) throw new ApiFailure('跨院共享响应无效，请稍后重试。', 0);
  if (!['PENDING', 'ACTIVE', 'REVOKED'].includes(String(value.status))) throw new ApiFailure('跨院共享响应无效，请稍后重试。', 0);
  if (typeof value.version !== 'number' || !Number.isSafeInteger(value.version) || value.version < 0) throw new ApiFailure('跨院共享响应无效，请稍后重试。', 0);
  if (!instant(value.requestedAt) || !instant(value.lastChangedAt) || (value.patientConfirmedAt !== undefined && !instant(value.patientConfirmedAt)) || (value.revokedAt !== undefined && !instant(value.revokedAt))) throw new ApiFailure('跨院共享响应无效，请稍后重试。', 0);
  if (!object(value.scopes) || !only(value.scopes, ALLOWED_SCOPE_FLAGS)) throw new ApiFailure('跨院共享响应无效，请稍后重试。', 0);
  for (const key of ALLOWED_SCOPE_FLAGS) if (typeof value.scopes[key] !== 'boolean') throw new ApiFailure('跨院共享响应无效，请稍后重试。', 0);
  // 情绪日记永久不可开启：true 必须被拒绝，而不是被静默纠正。
  if (value.scopes.moodDiary !== false) throw new ApiFailure('跨院共享响应无效，请稍后重试。', 0);
  return {
    fromOrgId, toOrgId,
    status: value.status as SharingStatus,
    version: value.version,
    scopes: {
      observations: value.scopes.observations as boolean,
      medications: value.scopes.medications as boolean,
      alerts: value.scopes.alerts as boolean,
      psychScreening: value.scopes.psychScreening as boolean,
      lifeInfo: value.scopes.lifeInfo as boolean,
    },
    requestedAt: value.requestedAt as string,
    ...(value.patientConfirmedAt === undefined ? {} : { patientConfirmedAt: value.patientConfirmedAt as string }),
    lastChangedAt: value.lastChangedAt as string,
    ...(value.revokedAt === undefined ? {} : { revokedAt: value.revokedAt as string }),
  };
}

export function parseSharingList(value: unknown, id: string): { asOf: string; items: Item[]; policy: Policy } {
  if (!object(value) || !only(value, ['patientId', 'asOf', 'items', 'policy']) || value.patientId !== id || !instant(value.asOf)) throw new ApiFailure('跨院共享列表响应无效，请稍后重试。', 0);
  // 服务端不分页、按机构对全量返回（已确定性排序）。这里只做「异常规模」的兜底：
  // 一位患者的协作机构对在现实中是个位数，超过 200 说明响应被污染而不是真有这么多。
  // 上限必须 ≥ 服务端可能产出的规模，否则正常数据会被判成损坏、整页空白。
  if (!Array.isArray(value.items) || value.items.length > 200) throw new ApiFailure('跨院共享列表响应无效，请稍后重试。', 0);
  if (!object(value.policy) || !only(value.policy, ['moodDiary', 'psychScreeningDefault', 'patientConfirmationRequired']) ||
    value.policy.moodDiary !== 'NEVER_SHARED' || value.policy.psychScreeningDefault !== 'OFF' || value.policy.patientConfirmationRequired !== true) {
    throw new ApiFailure('跨院共享列表响应无效，请稍后重试。', 0);
  }
  const seen = new Set<string>();
  const items = value.items.map(raw => {
    if (!object(raw) || !only(raw, ALLOWED_ITEM_FIELDS) || !text(raw.fromOrgId, 200) || !text(raw.toOrgId, 200) || raw.fromOrgId === raw.toOrgId || !object(raw.scope)) {
      throw new ApiFailure('跨院共享列表响应无效，请稍后重试。', 0);
    }
    const fromOrgId = raw.fromOrgId, toOrgId = raw.toOrgId;
    const key = `${fromOrgId}:${toOrgId}`;
    if (seen.has(key)) throw new ApiFailure('跨院共享列表响应无效，请稍后重试。', 0);
    seen.add(key);
    return describe(parseScope(raw.scope, id, fromOrgId, toOrgId), key);
  });
  return { asOf: value.asOf, items, policy: { moodDiary: 'NEVER_SHARED', psychScreeningDefault: 'OFF', patientConfirmationRequired: true } };
}

/** 逐项人类可读 + 动作边界。文案按规格「真实文案」表取用：XX 现在可以看到你的：…；看不到：… */
export function describe(value: ScopeView, key = `${value.fromOrgId}:${value.toOrgId}`): Item {
  const visible = SCOPE_LABELS.filter(entry => value.scopes[entry.key]).map(entry => entry.label);
  const hidden = SCOPE_LABELS.filter(entry => !value.scopes[entry.key]).map(entry => entry.label);
  const toOrg = orgLabel(value.toOrgId);
  const visibleText = visible.length
    ? `${toOrg} 现在可以看到你的：${visible.join('、')}。`
    : `${toOrg} 现在看不到你的任何记录。`;
  const hiddenText = `看不到：${hidden.length ? `${hidden.join('、')}、你自己的记录（含情绪日记）。` : '你自己的记录（含情绪日记）。'}`;
  const confirmedText = value.patientConfirmedAt
    ? `你已确认，最近一次变更：${new Date(value.lastChangedAt).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}。`
    : `提出时间：${new Date(value.requestedAt).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}，需要你确认后才会生效。`;
  return {
    key,
    fromOrgId: value.fromOrgId,
    toOrgId: value.toOrgId,
    status: value.status,
    statusLabel: STATUS_LABELS[value.status],
    version: value.version,
    // 待确认只能确认；已生效能改范围或终止；已终止不能再操作（服务端 STATE_CONFLICT）。
    canConfirm: value.status === 'PENDING',
    canUpdate: value.status === 'ACTIVE',
    canRevoke: value.status === 'PENDING' || value.status === 'ACTIVE',
    visibleText,
    hiddenText,
    confirmedText,
    choices: (['observations', 'medications', 'alerts', 'psychScreening', 'lifeInfo'] as const).map(k => ({
      key: k,
      label: SCOPE_LABELS.find(entry => entry.key === k)!.label,
      checked: value.scopes[k],
    })),
    moodDiaryNote: MOOD_DIARY_NOTE,
  };
}

Page({
  data: {
    loading: true,
    saving: false,
    error: '',
    notice: '',
    scopeKey: '',
    items: [] as Item[],
    asOf: '',
    /** 正在改哪一对机构范围（键 = fromOrgId:toOrgId）；空串表示没有打开编辑。 */
    editingKey: '',
    editing: [] as Array<{ key: string; label: string; checked: boolean }>,
    pendingText: '',
  },
  pending: null as { action: Action; fromOrgId: string; toOrgId: string; body: Record<string, unknown> } | null,

  onLoad() { this.onShow(); },
  onShow() {
    const expected = scope();
    if (!expected) {
      this.pending = null;
      this.setData({ scopeKey: '', loading: false, saving: false, items: [], error: '', editingKey: '', pendingText: '' });
      wx.redirectTo({ url: '/pages/auth/index' });
      return;
    }
    const key = `${expected.userId}:${expected.actorId}:${expected.patientId}`;
    // 换身份必须连待重放命令一起清：否则同一个 (fromOrgId,toOrgId,action) 会命中旧命令，
    // 把上一身份生成的 expectedVersion/幂等键 POST 到新身份上。
    if (key !== this.data.scopeKey) { this.pending = null; this.setData({ items: [], editing: [], editingKey: '', error: '', notice: '', pendingText: '' }); }
    this.setData({ scopeKey: key });
    void this.load(expected);
  },

  async load(expected: Scope) {
    if (!sameScope(expected)) return;
    this.setData({ loading: true, error: '' });
    try {
      const value = await request<unknown>(`/api/v1/patients/${encodeURIComponent(expected.patientId)}/data-sharing/scopes`);
      if (!sameScope(expected)) return;
      const parsed = parseSharingList(value, expected.patientId);
      this.setData({ items: parsed.items, asOf: parsed.asOf });
    } catch (error) {
      if (!sameScope(expected)) return;
      this.setData({ error: error instanceof Error ? error.message : '跨院共享读取失败，请重试。' });
    } finally {
      if (sameScope(expected)) this.setData({ loading: false });
    }
  },

  /** 打开展开编辑：把当前范围拷成可勾选的副本，不直接改 data.items。 */
  edit(event: { currentTarget: { dataset: { key?: string } } }) {
    const key = event.currentTarget.dataset.key ?? '';
    const item = (this.data.items as Item[]).find(candidate => candidate.key === key);
    if (!item || !item.canUpdate) return;
    this.setData({ editingKey: item.key, editing: item.choices.map(choice => ({ ...choice })), error: '', notice: '' });
  },
  cancelEdit() { this.setData({ editingKey: '', editing: [] }); },

  toggle(event: { currentTarget: { dataset: { key?: string } } }) {
    const key = event.currentTarget.dataset.key ?? '';
    const editing = (this.data.editing as Array<{ key: string; label: string; checked: boolean }>).map(choice => choice.key === key ? { ...choice, checked: !choice.checked } : choice);
    this.setData({ editing });
  },

  confirm(event: { currentTarget: { dataset: { key?: string } } }) {
    const expected = scope();
    const key = event.currentTarget.dataset.key ?? '';
    const item = (this.data.items as Item[]).find(candidate => candidate.key === key);
    if (!expected || !item || !item.canConfirm) return;
    void this.send('CONFIRM', item, { expectedVersion: item.version, idempotencyKey: newKey('ds-confirm') }, expected, '已确认。对方现在可以看到你同意的内容。');
  },

  /** UPDATE：携带改后的逐项范围 + expectedVersion（取该项 version）+ idempotencyKey。 */
  update() {
    const expected = scope();
    const key = this.data.editingKey as string;
    const item = (this.data.items as Item[]).find(candidate => candidate.key === key);
    if (!expected || !item || !item.canUpdate || !key) return;
    const scopes = { observations: false, medications: false, alerts: false, psychScreening: false, lifeInfo: false } as Scopes;
    for (const choice of this.data.editing as Array<{ key: string; checked: boolean }>) if (choice.key in scopes) (scopes as unknown as Record<string, boolean>)[choice.key] = choice.checked;
    void this.send('UPDATE', item, { expectedVersion: item.version, idempotencyKey: newKey('ds-update'), scopes }, expected, '范围已修改，需要再次确认后才会生效。');
  },

  async revoke(event: { currentTarget: { dataset: { key?: string } } }) {
    const expected = scope();
    const key = event.currentTarget.dataset.key ?? '';
    const item = (this.data.items as Item[]).find(candidate => candidate.key === key);
    if (!expected || !item || !item.canRevoke) return;
    if (typeof wx.showModal === 'function') {
      const confirmed = await new Promise<boolean>(resolve => wx.showModal({ title: '终止这项共享？', content: '终止后，对方不会再看到新的数据。已经看到的内容不会被追回。', confirmText: '终止共享', cancelText: '先不终止', confirmColor: '#B4232C', success: result => resolve(Boolean(result.confirm)), fail: () => resolve(false) }));
      if (!confirmed || !sameScope(expected)) return;
    }
    void this.send('REVOKE', item, { expectedVersion: item.version, idempotencyKey: newKey('ds-revoke') }, expected, '已终止这项共享，对方不会再看到新数据。');
  },

  /**
   * 未知结果（status 0）只重放同一份命令；服务端给出明确结论（4xx 且非 408/429）才丢弃重放。
   * 版本冲突说明别处已改过，必须重新读取再决定，不能靠重试猜。
   */
  async send(action: Action, item: Item, body: Record<string, unknown>, expected: Scope, notice: string) {
    if (!sameScope(expected) || this.data.saving) return;
    const command = this.pending ?? { action, fromOrgId: item.fromOrgId, toOrgId: item.toOrgId, body };
    this.pending = command;
    // 重放始终用**命令里记下的**机构对与请求体，而不是当前界面的选中项，
    // 否则「重试」会变成一次内容不同的新写入。
    const payload = { ...command.body, action: command.action, fromOrgId: command.fromOrgId, toOrgId: command.toOrgId };
    this.setData({ saving: true, error: '', notice: '', pendingText: pendingTextOf(command.action) });
    try {
      await request<unknown>(`/api/v1/patients/${encodeURIComponent(expected.patientId)}/data-sharing`, 'POST', payload);
      if (!sameScope(expected)) return;
      this.pending = null;
      this.setData({ pendingText: '', notice, editingKey: '', editing: [] });
      await this.load(expected);
    } catch (error) {
      if (!sameScope(expected)) return;
      const status = error instanceof ApiFailure ? error.status : 0;
      const code = error instanceof ApiFailure ? error.code : undefined;
      this.setData({ error: messageFor(code, error) });
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) { this.pending = null; this.setData({ pendingText: '' }); }
      if (code === 'DATA_SHARING_VERSION_CONFLICT' || code === 'IDEMPOTENCY_CONFLICT' || code === 'DATA_SHARING_STATE_CONFLICT') await this.load(expected);
      if (status === 401) wx.redirectTo({ url: '/pages/auth/index' });
    } finally {
      if (sameScope(expected)) this.setData({ saving: false });
    }
  },

  retry() {
    const expected = scope();
    const command = this.pending;
    if (!expected || !command) return;
    const storedKey = `${command.fromOrgId}:${command.toOrgId}`;
    const item = (this.data.items as Item[]).find(candidate => candidate.key === storedKey);
    if (!item) return;
    void this.send(command.action, item, command.body, expected, '原操作已重试。');
  },
  refresh() { const expected = scope(); if (expected) void this.load(expected); },
});

function pendingTextOf(action: Action): string {
  return ({ CONFIRM: '待确认：接受这份共享范围。', UPDATE: '待确认：修改共享范围。', REVOKE: '待确认：终止这项共享。' } as Record<Action, string>)[action];
}
/** 服务端的明确结论要翻译成人话；不确定的一律按「未确认」处理。 */
function messageFor(code: string | undefined, error: unknown): string {
  if (code === 'DATA_SHARING_VERSION_CONFLICT') return '共享范围已变化，已为你重新读取，请确认后再操作。';
  if (code === 'DATA_SHARING_STATE_CONFLICT') return '当前状态不能执行这个操作，已为你重新读取。';
  if (code === 'DATA_SHARING_LINK_NOT_ACTIVE') return '这项跨院协作已停止，不能再修改。';
  if (code === 'DATA_SHARING_LINK_NOT_FOUND') return '找不到这项跨院协作，可能已被机构终止。';
  if (code === 'FORBIDDEN') return '当前身份不能管理跨院共享。';
  if (code === 'INVALID_DATA_SHARING_INPUT') return '提交的共享范围无效，请重新选择。';
  return error instanceof Error ? error.message : '操作未确认，原操作已保留，请重试。';
}

export { describe as describeScope };
