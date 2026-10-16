import { ApiFailure, patientId, request, session } from '../../api';
import { loadMedicationReminders, medicationReminderLabel } from '../../medication-reminders';

/**
 * 通知收件箱（患者端小程序）。
 *
 * 设计规格：**本页完全没有屏级设计规格** —— `design/spec` 与 `design/` 的静态稿里都不存在
 * 「收件箱 / 通知中心」这一屏（验收矩阵里也记着「通知收件箱：没有规格」）。所以这一页不是
 * 照稿实现，而是按服务端既有语义做的**最小可用实现**：只做读取与「我看到了」两件事，不发明
 * 产品规则、不自创阈值、不承诺平台没承诺过的能力。
 *
 * 本平台的核心口径是**三级状态不可混淆**：
 *   - `submittedAt`（已提交）：请求已交给通知通道，**不代表对方收到了**；
 *   - `deliveredAt`（已送达）：通道回调证明已到设备（或通道本身无回执）；
 *   - `confirmedAt`（已确认）：接收人本人点开并确认了。
 * 页面文案必须把三者分开说，尤其**不得把「已提交」写成「已送达」**。
 *
 * 动作边界（服务端硬约束，前端不得绕过）：
 *   - 读取只认请求者本人：服务端按 `access.actorId` 授权，事务内再校验 VIEW_CLINICAL，
 *     只返回 `recipientId === 本人` 的记录。前端不额外筛，只用 `sameScope` 防串号。
 *   - 确认 `POST /api/v1/notifications/:id/confirm`：**请求体为空**（路由不读 body，
 *     `source` 硬编码 'APP_READ'），**没有幂等键、没有 expectedVersion**；已确认过原样返回。
 *     所以只有「本人接收、已提交（submittedAt）、未失败（无 failedAt）、未确认」的记录才提供
 *     按钮 —— 其余点击必然被服务端拒绝（INVALID_NOTIFICATION_STATE / STALE_NOTIFICATION），
 *     这种必然失败的按钮不该出现在页面上。
 */
type Channel = 'IN_APP' | 'SMS' | 'VOICE';
type DeliveryState = 'PENDING' | 'LEASED' | 'SUBMITTED' | 'FAILED' | 'UNKNOWN' | 'CANCELLED';
type TimingMode = 'IMMEDIATE' | 'DEFERRED' | 'BATCH';

interface Timing { mode: TimingMode; reason: string; eligibleAt: string | null; policyVersion: number | null }
interface Item {
  id: string;
  alertId: string;
  patientId: string;
  recipientId: string;
  channel: Channel;
  attempt: number;
  generation: number;
  deliveryState: DeliveryState;
  submittedAt: string | null;
  deliveredAt: string | null;
  confirmedAt: string | null;
  failedAt: string | null;
  confirmationSource: string | null;
  createdAt: string;
  updatedAt: string;
  timing: Timing | null;
}
interface TimelineRow { label: string; at?: string; action?: 'CONFIRM' }
interface Entry {
  id: string;
  stateLabel: string;
  labelKind: 'action' | 'info' | 'ok' | 'bad';
  detail: string;
  channelText: string;
  timingText: string;
  timeline: TimelineRow[];
  canConfirm: boolean;
  confirming: boolean;
}
interface Section { title: string; body: string }
interface Scope { userId: string; actorId: string; patientId: string }
interface MedicationReminder { id: string; title: string; detail: string; status: string; recorded: boolean; }

export function medicationReminders(value: unknown, patient: string): MedicationReminder[] {
  if (!object(value) || value.patientId !== patient || !Array.isArray(value.plans) || !Array.isArray(value.today)) throw new Error('用药提醒暂不可用。');
  const plans = value.plans;
  return value.today.flatMap(row => {
    if (!object(row) || !text(row.planId) || !['RECORDED', 'NOT_RECORDED', 'NOT_DUE'].includes(String(row.status))) throw new Error('用药提醒格式无效。');
    if (row.status === 'NOT_DUE') return [];
    const plan = plans.find((entry: unknown) => object(entry) && entry.id === row.planId) as Record<string, unknown> | undefined;
    if (!plan || plan.patientId !== patient || !text(plan.drug) || typeof plan.dose !== 'number' || !text(plan.unit) || plan.status !== 'ACTIVE') return [];
    const route = ({ ORAL: '口服', SC_INJECTION: '皮下注射' } as Record<string, string>)[String(plan.route)] ?? '按医嘱';
    const frequency = ({ DAILY: '每日', WEEKLY: '每周', EVERY_4_WEEKS: '每 4 周', AS_NEEDED: '按需' } as Record<string, string>)[String(plan.frequency)] ?? '按计划';
    const scheduled = Array.isArray(plan.schedule) ? plan.schedule.filter(point => object(point) && instant(point.effectiveFrom) && typeof point.plannedDose === 'number' && Date.parse(point.effectiveFrom) <= Date.now()).sort((a, b) => Date.parse(String(a.effectiveFrom)) - Date.parse(String(b.effectiveFrom))).at(-1) : undefined;
    const dose = scheduled?.plannedDose ?? plan.dose;
    return [{ id: row.planId, title: plan.drug, detail: `${dose} ${plan.unit} · ${route} · ${frequency}`, status: row.status === 'RECORDED' ? '今日已打卡' : '今日待记录', recorded: row.status === 'RECORDED' }];
  });
}

/** 患者通知视图的**确切**字段集合。多一个即契约破坏。 */
const ALLOWED_FIELDS = ['id', 'alertId', 'patientId', 'recipientId', 'channel', 'attempt', 'generation', 'deliveryState', 'submittedAt', 'deliveredAt', 'confirmedAt', 'failedAt', 'confirmationSource', 'createdAt', 'updatedAt', 'timing'];
/** 明确必须**不出现**的内部字段：供应商回执、正文载荷与幂等键不得下发给接收人。 */
const FORBIDDEN_FIELDS = ['channelMessageId', 'channelRaw', 'channelStatus', 'payload', 'idempotencyKey', 'leaseToken'];
const CHANNELS: Channel[] = ['IN_APP', 'SMS', 'VOICE'];
const STATES: DeliveryState[] = ['PENDING', 'LEASED', 'SUBMITTED', 'FAILED', 'UNKNOWN', 'CANCELLED'];

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function text(value: unknown, max = 500): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\0\r\n]/.test(value);
}
function instant(value: unknown): value is string {
  return text(value, 80) && Number.isFinite(Date.parse(value));
}
function integer(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
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
function formatDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** 通道标签：站内、短信、电话语音三个通道的服务端枚举。 */
function channelLabel(value: Channel): string {
  return ({ IN_APP: '应用内消息', SMS: '短信', VOICE: '电话语音' } as Record<Channel, string>)[value];
}
/** deliveryState 翻成人话；措辞刻意区分「已提交」与「已送达」，不是同义词。 */
function stateLabel(value: DeliveryState): string {
  return ({ PENDING: '待发出', LEASED: '正在发出', SUBMITTED: '已提交，等通道回执', FAILED: '发送失败', UNKNOWN: '发送结果未知', CANCELLED: '已取消' } as Record<DeliveryState, string>)[value];
}
function labelKindOf(value: DeliveryState): Entry['labelKind'] {
  if (value === 'SUBMITTED') return 'action';
  if (value === 'FAILED') return 'bad';
  if (value === 'UNKNOWN') return 'info';
  return 'info';
}
function timingText(timing: Timing | null): string {
  if (!timing) return '';
  const mode = ({ IMMEDIATE: '立即', DEFERRED: '延后', BATCH: '批量' } as Record<TimingMode, string>)[timing.mode];
  const parts = [`发送策略：${mode}`];
  if (timing.reason) parts.push(timing.reason);
  if (timing.eligibleAt) parts.push(`可发送时间 ${formatDate(timing.eligibleAt)}`);
  return parts.join(' · ');
}

/**
 * 严格解析一条记录。返回 null 表示不合契约（调用方据此整批拒绝）：
 * 未知字段、内部字段泄漏、跨患者、跨接收人、非法枚举、越界代次、非法时间都算。
 */
export function parseItem(value: unknown, expected: { patientId: string; actorId: string }): Item | null {
  if (!object(value) || !only(value, ALLOWED_FIELDS)) return null;
  if (FORBIDDEN_FIELDS.some(field => field in value)) return null;
  if (!text(value.id, 200)) return null;
  if (!text(value.alertId, 200)) return null;
  if (!text(value.patientId, 200) || value.patientId !== expected.patientId) return null;
  if (!text(value.recipientId, 200) || value.recipientId !== expected.actorId) return null;
  if (!CHANNELS.includes(value.channel as Channel)) return null;
  if (!integer(value.attempt, 1000)) return null;
  if (!integer(value.generation, 1000)) return null;
  if (!STATES.includes(value.deliveryState as DeliveryState)) return null;
  if (!instant(value.createdAt) || !instant(value.updatedAt)) return null;
  for (const field of ['submittedAt', 'deliveredAt', 'confirmedAt', 'failedAt']) {
    if (value[field] !== null && !instant(value[field])) return null;
  }
  if (value.confirmationSource !== null && !text(value.confirmationSource, 200)) return null;
  let timing: Timing | null = null;
  if (value.timing !== null) {
    const raw = value.timing;
    if (!object(raw) || !only(raw, ['mode', 'reason', 'eligibleAt', 'policyVersion']) || !['IMMEDIATE', 'DEFERRED', 'BATCH'].includes(String(raw.mode)) || !text(raw.reason, 500)) return null;
    if (raw.eligibleAt !== null && !instant(raw.eligibleAt)) return null;
    if (raw.policyVersion !== null && !integer(raw.policyVersion, 1_000_000)) return null;
    timing = { mode: raw.mode as TimingMode, reason: raw.reason, eligibleAt: raw.eligibleAt as string | null, policyVersion: raw.policyVersion as number | null };
  }
  return {
    id: value.id as string,
    alertId: value.alertId as string,
    patientId: value.patientId as string,
    recipientId: value.recipientId as string,
    channel: value.channel as Channel,
    attempt: value.attempt as number,
    generation: value.generation as number,
    deliveryState: value.deliveryState as DeliveryState,
    submittedAt: value.submittedAt as string | null,
    deliveredAt: value.deliveredAt as string | null,
    confirmedAt: value.confirmedAt as string | null,
    failedAt: value.failedAt as string | null,
    confirmationSource: value.confirmationSource as string | null,
    createdAt: value.createdAt as string,
    updatedAt: value.updatedAt as string,
    timing,
  };
}

/** 「我看到了」只在服务端会接受时才出现：已提交、未失败、未确认。 */
export function canConfirm(item: Item): boolean {
  return Boolean(item.submittedAt) && !item.failedAt && !item.confirmedAt;
}

/** 确认来源的人话括号，例如「（在应用内确认）」。未知来源返回空串。 */
function sourceText(value: string | null): string {
  if (!value) return '';
  return ({ APP_READ: '（应用内确认）', SMS_REPLY: '（短信回复确认）', VOICE_KEYPAD: '（电话按键确认）' } as Record<string, string>)[value] ?? '';
}

/** 把一条记录渲染成页面条目：状态标签 + 三级时间线 + 提示语。 */
export function describe(item: Item): Entry {
  const timeline: TimelineRow[] = [];
  if (item.submittedAt) timeline.push({ label: '已提交', at: item.submittedAt });
  if (item.deliveredAt) timeline.push({ label: '已送达', at: item.deliveredAt });
  if (item.confirmedAt) timeline.push({ label: '我已确认', at: item.confirmedAt });
  else if (canConfirm(item)) timeline.push({ label: '我确认看到了', action: 'CONFIRM' });
  return {
    id: item.id,
    stateLabel: stateLabel(item.deliveryState),
    labelKind: labelKindOf(item.deliveryState),
    detail: detailOf(item),
    channelText: `${channelLabel(item.channel)} · 第 ${item.attempt} 次发送`,
    timingText: timingText(item.timing),
    timeline: timeline.map(row => (row.at === undefined ? row : { ...row, at: formatDate(row.at) })),
    canConfirm: canConfirm(item),
    confirming: false,
  };
}

/** 状态对应的说明。已确认的则说明确认来源；未知状态如实说「还没收到结果」，不谎称送达。 */
function detailOf(item: Item): string {
  if (item.confirmedAt) return `接收人已确认看到这条通知${sourceText(item.confirmationSource)}。`;
  if (item.failedAt) return '这条没有发出去。系统这边确实没有成功送达的记录，你可以先看告警本身，或联系你的照护团队。';
  if (item.deliveryState === 'SUBMITTED') return item.deliveredAt ? '已提交，并收到了通道的送达回执；还差你点一下确认。' : '已交给通知通道，还没收到送达结果。提交不等于已经送达。';
  if (item.deliveryState === 'UNKNOWN') return '这条的发送结果还没确认。系统没有收到通道回执，页面不把它当成已送达。';
  if (item.deliveryState === 'CANCELLED') return '这条通知已作废，不需要处理。';
  if (item.deliveryState === 'FAILED') return '发送失败，不会再重试这一条。';
  return '这条还没发出去，等通道可用时再发。';
}

/** 目录下的通知按时间倒序，最近在前。 */
function sortNewest(items: Item[]): Item[] {
  return [...items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** 本页事实说明（无设计规格，按服务端语义如实交代）。常驻页面。 */
function sectionsOf(items: Item[]): Section[] {
  const unconfirmed = items.filter(item => canConfirm(item)).length;
  return [
    { title: '已提交不等于已送达', body: '「已提交」只说明请求交到了通知通道；「已送达」是通道确认消息已经到了你的设备；「我确认看到了」才是你本人点过按钮。前两个是机器的状态，最后一个是人的。' },
    { title: '这里只列发给你本人的通知', body: `按当前微信身份列出 ${items.length} 条，只包含你是接收人的那部分；发给别人的记录不在这里。` },
    { title: '还需要你确认的', body: unconfirmed ? `有 ${unconfirmed} 条已提交但还没确认。确认一次就会停止后续升级。` : '目前没有待确认的通知。' },
    { title: '关于通道', body: '应用内消息是站内投影，你能在这里直接看到就是它已经送到；短信和电话语音要走外部供应商，它们的「已送达」取决于供应商回执，所以可能停在「已提交」而没有送达时间。三者都是同一件事的不同通道，不是三件不同的事。' },
  ];
}

Page({
  data: {
    loading: true,
    error: '',
    notice: '',
    scopeKey: '',
    sections: [] as Section[],
    entries: [] as Entry[],
    confirmingId: '',
    saving: false,
    pendingText: '',
    reminders: [] as MedicationReminder[],
    reminderError: '',
    reminderLoading: true,
    deferredReminders: [] as Array<{ id: string; title: string; detail: string; status: string; finished: boolean }>,
    deferredError: '',
    showDeliveryHelp: false,
  },
  pendingId: '',
  loadGeneration: 0,
  reminderGeneration: 0,

  onLoad() {},
  onShow() {
    const expected = scope();
    if (!expected) {
      this.pendingId = '';
      this.setData({ scopeKey: '', loading: false, saving: false, entries: [], sections: [], reminders: [], deferredReminders: [], deferredError: '', reminderError: '', reminderLoading: false, error: '' });
      wx.redirectTo({ url: '/pages/auth/index' });
      return;
    }
    const key = `${expected.userId}:${expected.actorId}:${expected.patientId}`;
    if (key !== this.data.scopeKey) { this.pendingId = ''; this.setData({ entries: [], sections: [], reminders: [], deferredReminders: [], deferredError: '', reminderError: '', error: '', notice: '', confirmingId: '', pendingText: '', pendingId: '', saving: false }); }
    this.setData({ scopeKey: key });
    void this.load(expected);
    void this.loadReminders(expected);
  },
  onHide() { this.pendingId = ''; this.loadGeneration += 1; this.reminderGeneration += 1; },

  onUnload() { this.onHide(); },

  /** 用药提醒的唯一动作：进入用药页完成事实记录。 */
  openMedications() {
    wx.navigateTo({ url: '/pages/patient/medications' });
  },
  openPrivacy() {
    wx.switchTab({ url: '/pages/patient/account' });
  },
  toggleDeliveryHelp() { this.setData({ showDeliveryHelp: !this.data.showDeliveryHelp }); },
  async loadReminders(expected: Scope) {
    if (!sameScope(expected)) return;
    const generation = ++this.reminderGeneration;
    const isCurrent = () => generation === this.reminderGeneration && sameScope(expected);
    this.setData({ reminderLoading: true, reminderError: '', deferredError: '' });
    const results = await Promise.allSettled([
      request<unknown>(`/api/v1/patients/${encodeURIComponent(expected.patientId)}/medications`),
      loadMedicationReminders(expected),
    ]);
    if (!isCurrent()) return;
    const [overview, deferred] = results;
    const denied = results.some(result => result.status === 'rejected' && result.reason instanceof ApiFailure && [401, 403].includes(result.reason.status));
    if (denied) {
      this.setData({ reminders: [], deferredReminders: [], reminderError: '当前身份已无权查看用药提醒。', deferredError: '当前身份已无权查看稍后提醒。', reminderLoading: false });
      return;
    }
    let plans: Array<Record<string, unknown>> = [];
    if (overview.status === 'fulfilled') {
      try {
        const reminders = medicationReminders(overview.value, expected.patientId);
        plans = object(overview.value) && Array.isArray(overview.value.plans) ? overview.value.plans.filter(object) : [];
        this.setData({ reminders });
      } catch (error) { this.setData({ reminders: [], reminderError: error instanceof Error ? error.message : '用药提醒暂不可用。' }); }
    } else this.setData({ reminders: [], reminderError: overview.reason instanceof Error ? overview.reason.message : '用药提醒暂不可用。' });
    if (deferred.status === 'fulfilled') {
      const statusLabels = { SCHEDULED: '等待提醒', DUE: '已到提醒时间', COMPLETED: '已完成', CANCELLED: '已取消' };
      this.setData({ deferredReminders: deferred.value.records.slice().sort((a, b) => Number(b.status === 'DUE') - Number(a.status === 'DUE') || Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).map(row => ({
        id: row.id, title: String(plans.find(plan => plan.id === row.planId && plan.patientId === expected.patientId)?.drug ?? '用药稍后提醒'),
        detail: medicationReminderLabel(row), status: statusLabels[row.status], finished: row.status === 'COMPLETED' || row.status === 'CANCELLED',
      })) });
    } else this.setData({ deferredReminders: [], deferredError: deferred.reason instanceof Error ? deferred.reason.message : '稍后提醒暂时无法读取。' });
    this.setData({ reminderLoading: false });
  },

  async load(expected: Scope) {
    if (!sameScope(expected)) return;
    const generation = ++this.loadGeneration;
    this.setData({ loading: true, error: '' });
    try {
      const value = await request<unknown>('/api/v1/notifications');
      if (generation !== this.loadGeneration || !sameScope(expected)) return;
      const raw = Array.isArray(value) ? value : null;
      if (!raw || raw.length > 500) throw new ApiFailure('通知列表响应无效，请稍后重试。', 0);
      const items: Item[] = raw.map(entry => {
        const parsed = parseItem(entry, { patientId: expected.patientId, actorId: expected.actorId });
        if (!parsed) throw new ApiFailure('通知列表响应无效，请稍后重试。', 0);
        return parsed;
      });
      this.apply(items);
    } catch (error) {
      if (generation !== this.loadGeneration || !sameScope(expected)) return;
      this.setData({ entries: [], sections: [], error: error instanceof Error ? error.message : '通知列表读取失败，请重试。' });
      if (error instanceof ApiFailure && error.status === 401) wx.redirectTo({ url: '/pages/auth/index' });
    } finally {
      if (generation === this.loadGeneration && sameScope(expected)) this.setData({ loading: false });
    }
  },

  apply(items: Item[]) {
    const sorted = sortNewest(items);
    this.setData({ entries: sorted.map(describe), sections: sectionsOf(sorted) });
  },

  /** 确认没有任何请求体、也没有幂等键：服务端路由不读 body，source 硬编码 'APP_READ'。 */
  async confirm(event: { currentTarget: { dataset: { id?: unknown } } }) {
    const expected = scope();
    const id = event.currentTarget.dataset.id;
    if (!expected || typeof id !== 'string' || !id || this.data.saving) return;
    if (this.pendingId && this.pendingId !== id) return;
    this.pendingId = id;
    this.setData({ saving: true, confirmingId: id, error: '', notice: '', pendingText: '待确认：我看到了这条通知。', pendingId: id });
    try {
      await request<unknown>(`/api/v1/notifications/${encodeURIComponent(id)}/confirm`, 'POST');
      if (!sameScope(expected)) return;
      this.pendingId = '';
      this.setData({ pendingText: '', pendingId: '', notice: '已确认。后续不会再为此升级。' });
      await this.load(expected);
    } catch (error) {
      if (!sameScope(expected)) return;
      const status = error instanceof ApiFailure ? error.status : 0;
      const code = error instanceof ApiFailure ? error.code : undefined;
      this.setData({ error: messageFor(code, error) });
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        this.pendingId = '';
        this.setData({ pendingText: '', pendingId: '' });
        if (code === 'NOTIFICATION_NOT_FOUND' || code === 'STALE_NOTIFICATION' || code === 'INVALID_NOTIFICATION_STATE') await this.load(expected);
      }
      if (status === 401) wx.redirectTo({ url: '/pages/auth/index' });
    } finally {
      if (sameScope(expected)) this.setData({ saving: false, confirmingId: '' });
    }
  },

  retry() {
    const expected = scope();
    const id = this.pendingId;
    if (!expected || !id) return;
    void this.confirm({ currentTarget: { dataset: { id } } });
  },
  stopPullDownRefresh() {
    // 测试桩和旧版微信可能没有这个 API，缺失时不影响页面刷新结果。
    (wx as unknown as { stopPullDownRefresh?: () => void }).stopPullDownRefresh?.();
  },
  onPullDownRefresh() {
    const expected = scope();
    if (!expected) { this.stopPullDownRefresh(); return; }
    Promise.allSettled([this.load(expected), this.loadReminders(expected)]).finally(() => this.stopPullDownRefresh());
  },
  refresh() { const expected = scope(); if (expected) { void this.load(expected); void this.loadReminders(expected); } },
});

/** 服务端的明确结论翻成人话；不确定的一律按「未确认」处理，不假装成功。 */
function messageFor(code: string | undefined, error: unknown): string {
  if (code === 'FORBIDDEN') return '这条通知不是发给你当前身份的，无法确认。';
  if (code === 'NOTIFICATION_NOT_FOUND') return '这条通知已经不在了，已为你重新读取。';
  if (code === 'STALE_NOTIFICATION') return '这条通知对应的告警已更新，已为你重新读取。';
  if (code === 'INVALID_NOTIFICATION_STATE') return '这条通知当前不能确认（尚未提交或已失败），已为你重新读取。';
  return error instanceof Error ? error.message : '确认未完成，这条操作已保留，请重试。';
}

export type { Item as InboxItem, Entry as InboxEntry };
