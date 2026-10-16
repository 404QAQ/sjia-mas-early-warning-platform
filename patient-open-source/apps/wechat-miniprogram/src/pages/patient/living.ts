import { ApiFailure, patientId, request, session } from '../../api';

/**
 * F-09-B 患者自愿独居模式（患者端）。
 *
 * 设计规格：**本页没有屏级设计规格**。design/spec 里只在导航图出现一句「独居模式」，
 * 没有布局、字段、文案和状态转场要求（docs/全量实现验收矩阵.md 亦记为「无独立屏规格」）。
 * 因此这一页按服务端既有语义做**最小可用实现**：一个布尔开关 + 读写，不发明产品规则、
 * 不自创阈值、不承诺任何后果。有规格后再按规格改。
 *
 * 服务端契约（患者 API 的 living-mode 资源）：
 *   - 读 GET  /api/v1/patients/:id/living-mode → { patientId, enabled, version, updatedAt? }
 *   - 写 POST 同路径，body 仅 { enabled, expectedVersion, idempotencyKey }，走版本 CAS，
 *     响应 { setting, created }（新建 201 / 重放 200）。
 *   - 授权：读需患者关系内身份 + VIEW_CLINICAL；**写限 lifeStage === 'ADULT' 且 relation === 'SELF'**，
 *     否则 403「只有成年患者本人可以修改独居模式」。
 *     错误码：LIVING_MODE_VERSION_CONFLICT / IDEMPOTENCY_CONFLICT → 409，INVALID_LIVING_MODE。
 *   - 副作用：写成功会在同一事务把安全网投影的 isLivingAlone 同步为同一布尔值。
 *
 * 权限怎么判（不伪造客户端权限判断）：
 *   - 会话里只有 role，没有 lifeStage。relation === 'SELF' 映射为 role 'PATIENT'，
 *     而「未成年本人」也是 SELF —— 所以客户端**能**判断「是不是本人」，**不能**判断「是不是成年」。
 *   - 于是本地只做一件事：role !== 'PATIENT' 时不给开关（非本人一定无权写）；
 *     role === 'PATIENT' 时先给出开关，成不成年由服务端在提交时裁决 ——
 *     未成年本人提交会拿到 403，页面把服务端原话显示出来并退回只读，不自己编理由。
 *
 * 「独居模式」到底改变了什么（只写代码里查得到的事实，用中性语气）：
 *   更新会同步安全网投影 isLivingAlone（living-mode-service.ts:50）。引擎的安全网判断
 *   （packages/engine/src/layer1-rules.ts:378）在「独居 + 当前临床高风险 + 距上次任何记录
 *   超过阈值小时数」时，把安全网状态置为 NO_RESPONSE（无人响应）；融合层随后把它变成
 *   一条指向照护团队的复核动作（packages/engine/src/fuse.ts:92-98）。
 *   —— 也就是说：开启后，长时间无记录且风险偏高时，安全网更可能显示为「无人响应」，
 *   提示照护团队去看一眼。阈值小时数由院内阈值配置决定（当前默认 12，见 config.ts:42）。
 *   **不写**「会更频繁提醒你」「有人会立刻联系你」这类未经证实的后果或承诺。
 */
type Role = string;

interface LivingMode { patientId: string; enabled: boolean; version: number; updatedAt?: string }
interface Scope { userId: string; actorId: string; patientId: string }

/** 服务端读响应只应出现这四个字段；多出任何字段说明契约被破坏，宁可报错也不静默接受。 */
const ALLOWED_FIELDS = ['patientId', 'enabled', 'version', 'updatedAt'];

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function text(value: unknown, max = 500): value is string {
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
function newKey(): string {
  return `living-mode-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** 是否展示可操作开关：只有本人（SELF → role 'PATIENT'）可能是成年患者本人，其余一律只读。 */
function writableForRole(role: Role): boolean {
  return role === 'PATIENT';
}

function parseLivingMode(value: unknown, id: string): LivingMode {
  if (!object(value) || !only(value, ALLOWED_FIELDS) || value.patientId !== id) throw new ApiFailure('独居模式响应无效，请稍后重试。', 0);
  if (typeof value.enabled !== 'boolean') throw new ApiFailure('独居模式响应无效，请稍后重试。', 0);
  if (typeof value.version !== 'number' || !Number.isSafeInteger(value.version) || value.version < 0) throw new ApiFailure('独居模式响应无效，请稍后重试。', 0);
  if (value.updatedAt !== undefined && !instant(value.updatedAt)) throw new ApiFailure('独居模式响应无效，请稍后重试。', 0);
  return {
    patientId: id,
    enabled: value.enabled,
    version: value.version,
    ...(value.updatedAt === undefined ? {} : { updatedAt: value.updatedAt as string }),
  };
}

/** 只读时给出的原因：能本地判定的（非本人）与只能由服务端给的一律分开，不混。 */
function readOnlyReason(role: Role, denied: boolean): string {
  if (!writableForRole(role)) return '只有成年患者本人可以修改独居模式。当前身份只能查看这一项设置。';
  if (denied) return deniedReason;
  return '';
}

/** 服务端 403 的原话就已足够具体，直接透传，不自行改写或加重语气。 */
const deniedReason = '只有成年患者本人可以修改独居模式。';
/** 读被拒（assertViewer）与写被拒是两回事：能看不能改 ≠ 看不到这项设置。 */
const unreadableReason = '当前身份无权查看独居模式。';

Page({
  data: {
    loading: true,
    saving: false,
    error: '',
    notice: '',
    scopeKey: '',
    role: '',
    living: null as LivingMode | null,
    canOperate: false,
    denied: false,
    readOnlyReason: '',
    factLines: [] as string[],
    pendingText: '',
  },
  pending: null as { enabled: boolean; expectedVersion: number; idempotencyKey: string } | null,
  /**
   * 服务端拒绝过写（403）之后，本地角色猜测不再能把它翻回可写。
   *
   * 客户端只知道 role，不知道 lifeStage：未成年本人也是 SELF→'PATIENT'，
   * 所以 `writableForRole` 对他们恒为 true。若不做成粘性，下面 apply() 会在
   * 每次 load() 后把开关重新装回去 —— 用户看到的是一个永远失败、且没有任何
   * 解释的开关，只会反复点。服务端的裁决优先于客户端猜测。
   */
  serverDeniedWrite: false,

  onLoad() { this.onShow(); },
  onShow() {
    const expected = scope();
    const current = session();
    if (!expected || !current) {
      this.pending = null;
      this.setData({ scopeKey: '', loading: false, saving: false, role: '', living: null, canOperate: false, denied: false, readOnlyReason: '', factLines: [], error: '' });
      wx.redirectTo({ url: '/pages/auth/index' });
      return;
    }
    const key = `${expected.userId}:${expected.actorId}:${expected.patientId}`;
    // 换身份/换患者必须把服务端拒绝的粘性标志与待重放命令一起清掉，
    // 否则上一个身份的 403 会让新身份一进来就是只读。
    if (key !== this.data.scopeKey) {
      this.serverDeniedWrite = false;
      this.pending = null;
      this.setData({ role: current.role, living: null, error: '', notice: '', factLines: [], canOperate: false, denied: false, readOnlyReason: '', pendingText: '' });
    }
    this.setData({ scopeKey: key });
    void this.load(expected);
  },

  async load(expected: Scope) {
    if (!sameScope(expected)) return;
    this.setData({ loading: true, error: '' });
    try {
      const value = await request<unknown>(`/api/v1/patients/${encodeURIComponent(expected.patientId)}/living-mode`);
      if (!sameScope(expected)) return;
      this.apply(parseLivingMode(value, expected.patientId));
    } catch (error) {
      if (!sameScope(expected)) return;
      // 读也有授权：关系外或没有 VIEW_CLINICAL 时服务端返回 403，页面对当前身份如实只读展示。
      const denied = error instanceof ApiFailure && error.status === 403;
      // 读被拒说明连这项设置都不该看到：用「无权查看」口径，不能套写被拒的文案，也不展示事实说明。
      if (denied) { this.setData({ living: null, canOperate: false, denied: true, readOnlyReason: unreadableReason, factLines: [] }); return; }
      this.setData({ error: error instanceof Error ? error.message : '独居模式读取失败，请重试。' });
    } finally {
      if (sameScope(expected)) this.setData({ loading: false });
    }
  },

  apply(value: LivingMode) {
    const role = this.data.role as Role;
    // 服务端拒绝过写就保持只读：本地只看得见 role，看不见 lifeStage，猜不出成年与否。
    const canOperate = writableForRole(role) && !this.serverDeniedWrite;
    this.setData({
      living: value,
      canOperate,
      denied: this.serverDeniedWrite,
      readOnlyReason: readOnlyReason(role, this.serverDeniedWrite),
      factLines: facts(),
    });
  },

  /** 开关提交到服务端，失败时保留已保存状态，未知结果重放同一命令。 */
  onToggle(event: { detail?: { value?: unknown } }) {
    if (!this.data.canOperate || this.data.saving || !this.data.living) return;
    const value = typeof event.detail?.value === 'boolean' ? event.detail.value : Array.isArray(event.detail?.value) ? event.detail.value.length > 0 : false;
    if (value === this.data.living.enabled) return;
    void this.send(value, { enabled: value, expectedVersion: this.data.living.version, idempotencyKey: newKey() });
  },

  /**
   * 未知结果只重放同一份命令：刷新后的新版本不能改写原命令，否则「重试」会变成一次
   * 内容不同的新写入。服务端给出明确结论（4xx 且非 408/429）才丢弃重放。
   */
  async send(enabled: boolean, command: { enabled: boolean; expectedVersion: number; idempotencyKey: string }) {
    const expected = scope();
    if (!expected || !sameScope(expected) || this.data.saving) return;
    this.pending = command;
    this.setData({ saving: true, error: '', notice: '', pendingText: '这次修改还没确认结果，可以重试。' });
    try {
      await request<unknown>(`/api/v1/patients/${encodeURIComponent(expected.patientId)}/living-mode`, 'POST', {
        enabled: command.enabled, expectedVersion: command.expectedVersion, idempotencyKey: command.idempotencyKey,
      });
      if (!sameScope(expected)) return;
      this.pending = null;
      this.setData({ pendingText: '', notice: enabled ? '已保存：独居模式已开启。' : '已保存：独居模式已关闭。' });
      await this.load(expected);
    } catch (error) {
      if (!sameScope(expected)) return;
      const status = error instanceof ApiFailure ? error.status : 0;
      const code = error instanceof ApiFailure ? error.code : undefined;
      this.setData({ error: messageFor(code, error) });
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) { this.pending = null; this.setData({ pendingText: '' }); }
      // 版本冲突说明别处已经改过这一项设置，必须重新读取再决定，不能靠重试猜。
      if (code === 'LIVING_MODE_VERSION_CONFLICT' || code === 'IDEMPOTENCY_CONFLICT') await this.load(expected);
      // 403：不是本人或无写权限（例如未成年本人）。置粘性标志后再 load ——
      // 顺序反过来的话 apply() 会把 canOperate 重新设回 true，只读回退等于没做。
      if (status === 403) {
        this.serverDeniedWrite = true;
        await this.load(expected);
        this.setData({ canOperate: false, denied: true, readOnlyReason: deniedReason });
      }
      if (status === 401) wx.redirectTo({ url: '/pages/auth/index' });
    } finally {
      if (sameScope(expected)) this.setData({ saving: false });
    }
  },

  retry() {
    const expected = scope();
    const command = this.pending;
    if (!expected || !command) return;
    void this.send(command.enabled, command);
  },
  refresh() { const expected = scope(); if (expected) void this.load(expected); },
});

/** 页面上关于「这项设置做什么」的固定说明：全部是代码里能证实的事实，中性措辞。 */
function facts(): string[] {
  return [
    '这项设置会记录你的居住情况，供照护团队参考。',
    '开启后，它会进入平台的安全网判断：当你处于高风险、又有一段时间没有任何记录时，安全网会标记为「无人响应」，提示照护团队去看一眼。具体时长由院内阈值配置决定。',
    '它不改变你的诊断、用药或随访安排。',
  ];
}

/** 服务端的明确结论翻译成人话；不确定的一律按「未确认」处理。 */
function messageFor(code: string | undefined, error: unknown): string {
  if (code === 'LIVING_MODE_VERSION_CONFLICT') return '这项设置已被其他操作更新，已为你重新读取，请确认后再操作。';
  if (code === 'IDEMPOTENCY_CONFLICT') return '这次保存与之前的操作不一致，已为你重新读取，请确认后再操作。';
  if (code === 'INVALID_LIVING_MODE') return '这项设置的内容无效，请刷新后重试。';
  if (code === 'FORBIDDEN') return '只有成年患者本人可以修改独居模式。';
  return error instanceof Error ? error.message : '操作未确认，原操作已保留，请重试。';
}

export { parseLivingMode, facts, writableForRole, readOnlyReason };
