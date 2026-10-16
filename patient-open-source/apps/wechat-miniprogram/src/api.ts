import { API_BASE, AUTO_DEMO_LOGIN, ENTRY_SEX_INTENT_KEY, SESSION_KEY, identityStorageKeys, isMiniRole, type MiniRole } from './config';
import { INVITE_CODE_FORMAT_MESSAGE, normalizeInviteCode } from './invite-code';

export interface MiniSession {
  accessToken: string;
  refreshToken: string;
  userId: string;
  actorIds: string[];
  actorId: string;
  role: MiniRole;
  patientId?: string;
  accessExpiresAt?: string;
  refreshExpiresAt?: string;
}

interface ApiResponse<T> { data?: T; error?: { code?: string; message?: string; details?: unknown }; code?: string; message?: string; details?: unknown; }
interface RequestOptions { auth?: boolean; retryOnUnauthorized?: boolean; contentType?: string; artifactKind?: 'LAB_IMAGE'; }
interface TokenBundle { accessToken: string; refreshToken: string; userId: string; actorIds: string[]; accessExpiresAt?: string; refreshExpiresAt?: string; }
export interface MiniActor { id: string; patientId: string; relation: 'SELF' | 'LEGAL_GUARDIAN' | 'CAREGIVER' | 'SPOUSE' | 'PROXY' | 'CLINICIAN'; displayName?: string; activeFrom: string; activeUntil?: string; revokedAt?: string; }

const SESSION_FIELDS = ['accessToken', 'refreshToken', 'userId', 'actorIds', 'actorId', 'role', 'patientId', 'accessExpiresAt', 'refreshExpiresAt'] as const;
const TOKEN_FIELDS = ['accessToken', 'refreshToken', 'userId', 'actorIds', 'accessExpiresAt', 'refreshExpiresAt'] as const;

/** 请求失败的可操作状态；status=0 表示没有收到服务端 HTTP 响应，结果可能未知。code 为服务端错误码（如有），details 为服务端附带的结构化说明（如 429 的 retryAfterSeconds）。 */
export class ApiFailure extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string, public readonly details?: Record<string, unknown>) { super(message); }
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function nonEmptyText(value: unknown, max = 16384): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value);
}

function optionalInstant(value: unknown): value is string | undefined {
  return value === undefined || (nonEmptyText(value, 80) && Number.isFinite(Date.parse(value)));
}

function onlyKnownFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).every(key => fields.includes(key));
}

function parseSession(value: unknown): MiniSession | null {
  if (!object(value) || !onlyKnownFields(value, SESSION_FIELDS)) return null;
  const item = value;
  if (!nonEmptyText(item.accessToken) || !nonEmptyText(item.refreshToken) || !nonEmptyText(item.userId) ||
    !Array.isArray(item.actorIds) || item.actorIds.length < 1 || !item.actorIds.every(actorId => nonEmptyText(actorId, 256)) || !nonEmptyText(item.actorId, 256) ||
    !isMiniRole(item.role) || !optionalInstant(item.accessExpiresAt) || !optionalInstant(item.refreshExpiresAt) ||
    (item.patientId !== undefined && !nonEmptyText(item.patientId, 256))) return null;
  return {
    accessToken: item.accessToken,
    refreshToken: item.refreshToken,
    userId: item.userId,
    actorIds: [...item.actorIds],
    actorId: item.actorId,
    role: item.role,
    ...(item.patientId === undefined ? {} : { patientId: item.patientId }),
    ...(item.accessExpiresAt === undefined ? {} : { accessExpiresAt: item.accessExpiresAt }),
    ...(item.refreshExpiresAt === undefined ? {} : { refreshExpiresAt: item.refreshExpiresAt }),
  };
}

function parseTokenBundle(value: unknown): TokenBundle | null {
  if (!object(value) || !onlyKnownFields(value, TOKEN_FIELDS)) return null;
  if (!nonEmptyText(value.accessToken) || !nonEmptyText(value.refreshToken) || !nonEmptyText(value.userId) ||
    !Array.isArray(value.actorIds) || value.actorIds.length < 1 || !value.actorIds.every(actorId => nonEmptyText(actorId, 256)) ||
    !optionalInstant(value.accessExpiresAt) || !optionalInstant(value.refreshExpiresAt)) return null;
  return {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    userId: value.userId,
    actorIds: [...value.actorIds],
    ...(value.accessExpiresAt === undefined ? {} : { accessExpiresAt: value.accessExpiresAt }),
    ...(value.refreshExpiresAt === undefined ? {} : { refreshExpiresAt: value.refreshExpiresAt }),
  };
}

function parseTokens(value: unknown, previous: MiniSession | null): MiniSession | null {
  const bundle = parseTokenBundle(value);
  if (!bundle || !previous || bundle.userId !== previous.userId || !bundle.actorIds.includes(previous.actorId)) return null;
  return parseSession({ ...bundle, actorId: previous.actorId, role: previous.role, ...(previous.patientId === undefined ? {} : { patientId: previous.patientId }) });
}

// 登录代次与身份代次只在当前进程内有效，不进入持久化会话或请求头。
// 同一登录中的 token 轮换不会结束在途请求；重新登录及身份切换则必须隔离旧回包。
const sessionStamps = new WeakMap<MiniSession, { login: number; identity: number }>();
let observedSession: MiniSession | null = null;
let loginGeneration = 0;
let identityGeneration = 0;

function sameCredentials(left: MiniSession | null, right: MiniSession | null): boolean {
  return Boolean(left && right && left.accessToken === right.accessToken && left.refreshToken === right.refreshToken && left.userId === right.userId);
}

function sameActor(left: MiniSession | null, right: MiniSession | null): boolean {
  return Boolean(left && right && left.actorId === right.actorId && left.patientId === right.patientId && left.role === right.role);
}

function observeSession(value: MiniSession | null): MiniSession | null {
  if (value) sessionStamps.set(value, { login: loginGeneration, identity: identityGeneration });
  observedSession = value;
  return value;
}

export function session(): MiniSession | null {
  const current = parseSession(wx.getStorageSync<unknown>(SESSION_KEY));
  // 兼容本地储存被清除或替换；只有本模块明确保存的 refresh 才能延续登录代次。
  if ((current || observedSession) && !sameCredentials(current, observedSession)) {
    loginGeneration += 1;
    identityGeneration += 1;
  } else if (current && !sameActor(current, observedSession)) {
    identityGeneration += 1;
  }
  return observeSession(current);
}

function persistSession(value: MiniSession, continuation = false): MiniSession {
  const parsed = parseSession(value);
  if (!parsed) throw new Error('服务端会话响应格式无效，请重新登录。');
  const current = session();
  wx.setStorageSync(SESSION_KEY, parsed);
  if (!continuation) loginGeneration += 1;
  if (!continuation || !sameActor(current, parsed)) identityGeneration += 1;
  observeSession(parsed);
  return parsed;
}

export function saveSession(value: MiniSession): void { persistSession(value); }
export function clearSession(): void {
  const current = session();
  if (current?.patientId) {
    for (const key of identityStorageKeys(current.userId, current.actorId, current.patientId)) {
      if (key.startsWith('mas.clinical-archive.v1:') && (key.includes(':pending:') || key.includes(':upload:'))) {
        try { wx.removeStorageSync(key); } catch { /* 退出会话仍须继续。 */ }
      }
    }
  }
  wx.removeStorageSync(SESSION_KEY);
  loginGeneration += 1;
  identityGeneration += 1;
  observeSession(null);
}

function requestOnce<T>(path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', data: unknown, current: Pick<MiniSession, 'accessToken' | 'actorId'> | null, options: RequestOptions = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${API_BASE}${path}`,
      method,
      data,
      header: {
        accept: 'application/json',
        'content-type': options.contentType ?? 'application/json',
        ...(options.artifactKind ? { 'x-artifact-kind': options.artifactKind } : {}),
        ...(current ? { authorization: `Bearer ${current.accessToken}`, 'x-actor-id': current.actorId } : {}),
        ...(object(data) && nonEmptyText(data.idempotencyKey, 200) ? { 'idempotency-key': data.idempotencyKey } : {}),
      },
      success: result => {
        const body = result.data as ApiResponse<T> | undefined;
        if (result.statusCode < 200 || result.statusCode >= 300) {
          const code = body?.error?.code ?? body?.code;
          const details = body?.error?.details ?? body?.details;
          reject(new ApiFailure(body?.error?.message ?? body?.message ?? `请求失败（HTTP ${result.statusCode}）`, result.statusCode, nonEmptyText(code, 80) ? code : undefined, object(details) ? details : undefined)); return;
        }
        if (!body || !Object.hasOwn(body, 'data')) { reject(new ApiFailure('服务响应不完整，请刷新核对。', result.statusCode)); return; }
        resolve(body.data as T);
      },
      // 微信不会把网络错误作为 HTTP 响应返回，开发者工具常见的原因是「未关闭域名校验」
      // 或当前电脑无法访问公网端口。不能把这些原因都压成同一句话，否则使用者只能反复点重试。
      fail: error => {
        const raw = typeof error?.errMsg === 'string' ? error.errMsg.trim() : '';
        const detail = raw.slice(0, 160);
        let message = '网络连接失败，请检查当前电脑是否能访问线上服务。';
        if (/url not in domain list|domain list/i.test(raw)) {
          message = '开发者工具拦截了线上地址，请在「详情 → 本地设置」勾选“不校验合法域名、web-view、TLS 版本以及 HTTPS 证书”，再清缓存重新编译。';
        } else if (/tls|certificate|https/i.test(raw)) {
          message = '当前包使用的是 HTTP 演示地址，开发者工具的 HTTPS/TLS 校验未关闭，请到「详情 → 本地设置」关闭校验后重试。';
        } else if (/timeout|timed out|refused|unreachable|network/i.test(raw)) {
          message = `当前电脑无法访问线上 API（${API_BASE}），请检查网络、防火墙或代理设置。`;
        }
        reject(new ApiFailure(message, 0, 'NETWORK_REQUEST_FAILED', detail ? { errMsg: detail } : undefined));
      },
    });
  });
}

/**
 * 服务端已判定会话失效：清掉本地会话和该身份的待提交数据，统一回登录页。
 * 放在这里而不是各页面：页面的迟到回包保护（sameScope）在会话清空后都不再成立，
 * 交给页面就会出现「数据没清、人也没走」；reLaunch 会卸载整个页面栈，内存里的投影一并释放。
 */
function expireSession(current: MiniSession): void {
  if (current.patientId) {
    for (const key of identityStorageKeys(current.userId, current.actorId, current.patientId)) {
      try { wx.removeStorageSync(key); } catch { /* 会话本身仍必须清除 */ }
    }
  }
  try { wx.removeStorageSync(ENTRY_SEX_INTENT_KEY); } catch { /* 会话本身仍必须清除 */ }
  clearSession();
  wx.reLaunch({ url: '/pages/auth/index' });
}

let refreshFlight: { session: MiniSession; result: Promise<MiniSession | null> } | null = null;

async function refreshSession(): Promise<MiniSession | null> {
  const current = session();
  if (!current?.refreshToken) return null;
  if (refreshFlight && sameSessionScope(refreshFlight.session, current)) return refreshFlight.result;
  const result = (async () => {
    try {
      const value = await requestOnce<unknown>('/api/v1/auth/refresh', 'POST', { refreshToken: current.refreshToken }, null);
      const next = parseTokens(value, current);
      if (!next) throw new Error('刷新会话响应格式无效。');
      const latest = session();
      // 注销/换号会改变会话族，旧 refresh 结果不能覆盖新会话。仅切换 Actor 时，
      // 仍需保存轮换后的 token，但让发起切换前的请求以 409 结束，避免重放到新患者。
      if (!sameSessionScope(latest, current)) throw new ApiFailure(staleSessionMessage, 409);
      if (!sameSessionIdentity(latest, current)) {
        const merged = parseSession({ ...next, actorId: latest!.actorId, role: latest!.role, ...(latest!.patientId === undefined ? {} : { patientId: latest!.patientId }) });
        if (!merged) return null;
        persistSession(merged, true);
        throw new ApiFailure(staleSessionMessage, 409);
      }
      return persistSession(next, true);
    } catch (error) {
      // 刷新令牌被服务端明确拒绝（过期 / 撤销 / 演示服务重启，一律 401/403）才说明本地会话已死：
      // 清掉它，由 request() 统一抛「会话已失效」。断网（status 0）、5xx、限频以及上面主动抛的
      // 409 仍原样透传，不能因为一次网络抖动把用户踢下线。
      if (error instanceof ApiFailure && error.status !== 401 && error.status !== 403) throw error;
      const latest = session();
      if (!sameSessionScope(latest, current)) throw new ApiFailure(staleSessionMessage, 409);
      expireSession(latest!);
      return null;
    }
  })().finally(() => { if (refreshFlight?.result === result) refreshFlight = null; });
  refreshFlight = { session: current, result };
  return result;
}

/**
 * 403 FORBIDDEN 有两种来源，响应本身分不出来：业务拒绝（本档案不适用、当前关系无权），以及访问层在
 * 账户停用、actor 被移出白名单时的拒绝 —— 后者 access token 没过期，不会走 refresh，会话却已经死了。
 * 这里用当前令牌读一次身份列表来区分，避免为普通业务拒绝不必要地轮换令牌。
 * 返回 false 表示会话已失效。
 */
async function sessionStillValid(current: MiniSession): Promise<boolean> {
  try {
    const actors = parseActors(await requestOnce<unknown>('/api/v1/auth/actors', 'GET', undefined, current));
    if (!sameSessionIdentity(current, session())) throw new ApiFailure(staleSessionMessage, 409);
    // 读不懂的回包不能当作会话失效的证据。
    return !actors || actors.some(actor => actor.id === current.actorId && activeActor(actor));
  } catch (error) {
    const latest = session();
    // 核验也是异步请求：旧身份的核验结果不能刷新或注销后来登录/切换的身份。
    if (!sameSessionIdentity(current, latest)) throw new ApiFailure(staleSessionMessage, 409);
    if (!(error instanceof ApiFailure)) return true;
    // access token 恰好过期：交给 refresh 判定。刷新成功说明用户可用且 actor 仍在白名单内，被拒时它已自行清掉会话。
    if (error.status === 401) {
      try {
        const refreshed = sameCredentials(current, latest) ? await refreshSession() : latest;
        if (refreshed && !sameSessionIdentity(current, session())) throw new ApiFailure(staleSessionMessage, 409);
        return Boolean(refreshed);
      } catch {
        if (!sameSessionIdentity(current, session())) throw new ApiFailure(staleSessionMessage, 409);
        return true;
      }
    }
    // 身份列表本身也被拒（用户已停用）才是会话失效；断网、5xx、限频都不下结论。
    return error.status !== 403;
  }
}

let probeFlight: { session: MiniSession; result: Promise<boolean> } | null = null;

/** 同一会话的并行 403 只核验一次。 */
function probeSession(current: MiniSession): Promise<boolean> {
  if (probeFlight && sameSessionIdentity(probeFlight.session, current)) return probeFlight.result;
  const result: Promise<boolean> = sessionStillValid(current).then(alive => {
    if (!alive && sameSessionIdentity(session(), current)) expireSession(current);
    return alive;
  }).finally(() => { if (probeFlight?.result === result) probeFlight = null; });
  probeFlight = { session: current, result };
  return result;
}

export function request<T>(path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', data?: unknown, options: RequestOptions = {}): Promise<T> {
  const current = options.auth === false ? null : session();
  const rejectStale = (value: T, expected: MiniSession | null): T => {
    if (expected && !sameSessionIdentity(expected, session())) throw new ApiFailure(staleSessionMessage, 409);
    return value;
  };
  return requestOnce<T>(path, method, data, current, options).then(value => rejectStale(value, current)).catch(async error => {
    if (!(error instanceof ApiFailure) || options.auth === false || options.retryOnUnauthorized === false || path === '/api/v1/auth/refresh') throw error;
    if (current && !sameSessionIdentity(current, session())) throw new ApiFailure(staleSessionMessage, 409);
    // 会话仍有效时原样抛出业务 403，由页面只清本页的待提交；会话已失效时 session() 已为空，页面会清整个身份队列。
    if (error.status === 403 && current && (error.code === 'FORBIDDEN' || error.code === 'USER_INACTIVE')) {
      const alive = await probeSession(current);
      const latest = session();
      if (!alive && !latest) throw new ApiFailure('会话已失效，请重新登录。', 401);
      if (!sameSessionIdentity(current, latest)) throw new ApiFailure(staleSessionMessage, 409);
      throw error;
    }
    if (error.status !== 401) throw error;
    const latest = session();
    if (!current || !latest) throw new ApiFailure('会话已失效，请重新登录。', 401);
    // 同批旧请求的 401 可能在刷新结束后才到达，直接使用该登录已轮换的 token。
    const refreshed = sameCredentials(current, latest) ? await refreshSession() : latest;
    if (!refreshed) throw new ApiFailure('会话已失效，请重新登录。', 401);
    if (!sameSessionIdentity(current, session())) throw new ApiFailure(staleSessionMessage, 409);
    return requestOnce<T>(path, method, data, refreshed, options).then(value => rejectStale(value, current));
  });
}

function parseActors(value: unknown): MiniActor[] | null {
  if (!Array.isArray(value)) return null;
  const actors: MiniActor[] = [];
  for (const item of value) {
    if (!object(item) || !onlyKnownFields(item, ['id', 'patientId', 'relation', 'displayName', 'activeFrom', 'activeUntil', 'revokedAt']) ||
      !nonEmptyText(item.id, 256) || !nonEmptyText(item.patientId, 256) ||
      !['SELF', 'LEGAL_GUARDIAN', 'CAREGIVER', 'SPOUSE', 'PROXY', 'CLINICIAN'].includes(item.relation as string) || !instant(item.activeFrom) ||
      !optionalInstant(item.activeUntil) || !optionalInstant(item.revokedAt) || (item.displayName !== undefined && !nonEmptyText(item.displayName, 200))) return null;
    actors.push({
      id: item.id, patientId: item.patientId, relation: item.relation as MiniActor['relation'],
      ...(item.displayName === undefined ? {} : { displayName: item.displayName }), activeFrom: item.activeFrom,
      ...(item.activeUntil === undefined ? {} : { activeUntil: item.activeUntil }),
      ...(item.revokedAt === undefined ? {} : { revokedAt: item.revokedAt }),
    });
  }
  return actors;
}

function instant(value: unknown): value is string {
  return nonEmptyText(value, 80) && Number.isFinite(Date.parse(value));
}

function activeActor(actor: MiniActor, now = Date.now()): boolean {
  return Date.parse(actor.activeFrom) <= now && (actor.revokedAt === undefined || Date.parse(actor.revokedAt) > now) && (actor.activeUntil === undefined || Date.parse(actor.activeUntil) > now);
}

function miniRole(relation: MiniActor['relation']): MiniRole | null {
  if (relation === 'SELF') return 'PATIENT';
  if (relation === 'LEGAL_GUARDIAN') return 'LEGAL_GUARDIAN';
  if (relation === 'CAREGIVER') return 'CAREGIVER';
  if (relation === 'SPOUSE') return 'SPOUSE';
  if (relation === 'PROXY') return 'PROXY';
  return null;
}

function actorPriority(actor: MiniActor): number {
  return ({ SELF: 0, LEGAL_GUARDIAN: 1, CAREGIVER: 2, SPOUSE: 3, PROXY: 4, CLINICIAN: 9 } as Record<MiniActor['relation'], number>)[actor.relation];
}

function sameSessionIdentity(left: MiniSession | null, right: MiniSession | null): boolean {
  return Boolean(left && right && sameSessionScope(left, right) && sameActor(left, right) && sessionStamps.get(left)?.identity === sessionStamps.get(right)?.identity);
}

function sameSessionScope(left: MiniSession | null, right: MiniSession | null): boolean {
  return Boolean(left && right && left.userId === right.userId && sessionStamps.has(left) && sessionStamps.has(right) && sessionStamps.get(left)?.login === sessionStamps.get(right)?.login);
}

const staleSessionMessage = '身份已切换，请刷新当前页面。';

async function completeWechatSession(value: unknown, preferredSex?: 'MALE' | 'FEMALE'): Promise<MiniSession> {
  const bundle = parseTokenBundle(value);
  if (!bundle) throw new Error('服务端会话响应格式无效，请重新登录。');
  const actorsValue = await requestOnce<unknown>('/api/v1/auth/actors', 'GET', undefined, { accessToken: bundle.accessToken, actorId: bundle.actorIds[0] ?? '' });
  const actors = parseActors(actorsValue);
  if (!actors) throw new Error('服务端操作者响应格式无效，请重新登录。');
  const scoped = actors.filter(actor => activeActor(actor) && bundle.actorIds.includes(actor.id));
  const available = scoped.filter(actor => actor.relation !== 'CLINICIAN').sort((left, right) => actorPriority(left) - actorPriority(right) || left.id.localeCompare(right.id));
  // 免邀请码演示默认落在参考病例；仍只从服务端已授权、未过期的身份中选择。
  let selected = AUTO_DEMO_LOGIN && !preferredSex
    ? available.find(actor => actor.patientId === 'patient-demo') ?? available[0]
    : available[0];
  // 入口只在服务端已授权的档案之间选择，不改写性别，也不产生新授权。
  if (preferredSex && available.length > 1) {
    const summaries = await Promise.allSettled(available.map(actor => requestOnce<unknown>(
      `/api/v1/patients/${encodeURIComponent(actor.patientId)}/summary`, 'GET', undefined,
      { accessToken: bundle.accessToken, actorId: actor.id },
    )));
    const match = summaries.findIndex((result, index) => result.status === 'fulfilled' && object(result.value)
      && result.value.patientId === available[index]?.patientId && result.value.sex === preferredSex);
    if (match >= 0) selected = available[match];
  }
  if (!selected) throw new Error(scoped.some(actor => actor.relation === 'CLINICIAN') ? '医生账号请使用网页端登录。' : '该微信暂无可用的患者或照护身份，请联系主管医生核对授权。');
  const role = miniRole(selected.relation);
  if (!role) throw new Error('医生账号请使用网页端登录。');
  const next = parseSession({ ...bundle, actorId: selected.id, role, patientId: selected.patientId });
  if (!next) throw new Error('服务端会话响应格式无效，请重新登录。');
  return next;
}

async function fetchActors(): Promise<MiniActor[]> {
  const actorsValue = await request<unknown>('/api/v1/auth/actors', 'GET');
  const actors = parseActors(actorsValue);
  if (!actors) throw new Error('服务端操作者响应格式无效，请重新登录。');
  return actors;
}

/** 返回服务端当前授权的、仍有效的非医生身份；患者和关系均以 Actor 投影为准。 */
export async function availableActors(): Promise<MiniActor[]> {
  const current = session();
  if (!current) throw new ApiFailure('会话已失效，请重新登录。', 401);
  const actors = await fetchActors();
  const latest = session();
  if (!latest || !sameSessionIdentity(latest, current)) throw new ApiFailure(staleSessionMessage, 409);
  return actors.filter(actor => activeActor(actor) && latest.actorIds.includes(actor.id) && actor.relation !== 'CLINICIAN')
    .sort((left, right) => actorPriority(left) - actorPriority(right) || left.id.localeCompare(right.id));
}

let actorSwitchGeneration = 0;

/** 切换只接受服务端 Actor id，并在写入前校验会话仍是发起切换时的身份。 */
export async function switchActor(actorId: string): Promise<MiniSession> {
  if (!nonEmptyText(actorId, 256)) throw new Error('身份选择无效，请重新选择。');
  const generation = ++actorSwitchGeneration;
  const current = session();
  if (!current) throw new ApiFailure('会话已失效，请重新登录。', 401);
  const actors = await availableActors();
  const latest = session();
  if (generation !== actorSwitchGeneration || !latest || latest.actorId !== current.actorId || !sameSessionIdentity(latest, current)) throw new ApiFailure(staleSessionMessage, 409);
  const selected = actors.find(actor => actor.id === actorId && activeActor(actor) && latest.actorIds.includes(actor.id));
  if (!selected) throw new Error('该身份已不可用，请刷新后重试。');
  if (selected.relation === 'CLINICIAN') throw new Error('医生账号请使用网页端登录。');
  const role = miniRole(selected.relation);
  if (!role) throw new Error('医生账号请使用网页端登录。');
  const next = parseSession({ ...latest, actorId: selected.id, role, patientId: selected.patientId });
  if (!next) throw new Error('服务端操作者响应格式无效，请重新登录。');
  if (generation !== actorSwitchGeneration || !sameSessionIdentity(latest, session())) throw new ApiFailure(staleSessionMessage, 409);
  return persistSession(next, true);
}

/** 每次都向微信要一枚新的一次性 code：上一次请求失败时，旧 code 可能已被服务端用掉。 */
function wechatCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.login({
      success: result => { if (nonEmptyText(result.code, 1024)) resolve(result.code); else reject(new Error('微信登录凭证无效，请重试。')); },
      fail: error => reject(new Error(error.errMsg ?? '微信登录失败，请重试。')),
    });
  });
}

/** 微信 code 换取业务会话；后端未配置微信供应商时必须明确失败，不能降级为匿名访问。 */
export async function loginWithWechat(preferredSex?: 'MALE' | 'FEMALE'): Promise<MiniSession> {
  // 免登录会议包是服务端开发身份桩的专用客户端：它不依赖当前电脑的 wx.login，
  // 因而换一台开发者工具也能进入同一份演示身份。标准包仍必须走真实 wx.login；
  // 真正的生产微信供应商会拒绝这个演示 code，不会形成匿名生产登录通道。
  const code = AUTO_DEMO_LOGIN ? 'demo-auto-login' : await wechatCode();
  const loginBody = { code, ...(AUTO_DEMO_LOGIN && preferredSex ? { preferredSex } : {}) };
  const next = await completeWechatSession(await request<unknown>('/api/v1/auth/wechat/login', 'POST', loginBody, { auth: false, retryOnUnauthorized: false }), preferredSex);
  saveSession(next);
  return next;
}

/**
 * 凭医生给的邀请码把当前微信绑定到医生登记的身份，并直接进入会话。
 * 格式先在本地检查（不耗费微信 code，也不计入服务端的输错次数）；
 * 绑定请求不带任何旧会话，身份只由服务端按邀请码决定。
 */
export async function bindWechatWithInvite(raw: string): Promise<MiniSession> {
  const inviteCode = normalizeInviteCode(raw);
  if (!inviteCode) throw new Error(INVITE_CODE_FORMAT_MESSAGE);
  const code = await wechatCode();
  const next = await completeWechatSession(await request<unknown>('/api/v1/auth/wechat/bind', 'POST', { code, inviteCode }, { auth: false, retryOnUnauthorized: false }));
  saveSession(next);
  return next;
}

/** 本人解除当前账户的微信绑定。服务端会让本账户所有登录失效，因此确认解除后才清除本地会话。 */
export async function unbindWechat(): Promise<{ revoked: boolean }> {
  const value = await request<unknown>('/api/v1/auth/wechat/binding', 'DELETE');
  if (!object(value) || !onlyKnownFields(value, ['revoked', 'sessionsRevoked']) || typeof value.revoked !== 'boolean' || typeof value.sessionsRevoked !== 'boolean') {
    throw new Error('服务端解除绑定响应格式无效，请刷新核对。');
  }
  if (value.revoked) { try { wx.removeStorageSync(ENTRY_SEX_INTENT_KEY); } catch { /* 会话仍必须清除 */ } clearSession(); }
  return { revoked: value.revoked };
}

export async function logout(): Promise<void> {
  const current = session();
  try { wx.removeStorageSync(ENTRY_SEX_INTENT_KEY); } catch { /* 本地退出仍必须继续 */ }
  clearSession();
  if (!current?.refreshToken) return;
  try { await requestOnce('/api/v1/auth/logout', 'POST', { refreshToken: current.refreshToken }, null); } catch { /* 本地会话已清除，网络失败不阻塞退出 */ }
}

/** 患者范围只来自服务端会话，绝不读取可被客户端改写的本地 patientId。 */
export function patientId(): string | null { return session()?.patientId ?? null; }

/** 服务端告诉小程序订阅消息通道是否接入、模板 ID 是什么。 */
export interface PushTemplateInfo {
  ready: boolean;
  templateId?: string;
  reason?: string;
}

/**
 * 读取订阅消息模板。未接入时 ready 为 false 且带原因 —— 这时绝不能让用户
 * 点一个必然失败的授权按钮，而应如实显示「暂未开通提醒」。
 */
export async function pushTemplate(): Promise<PushTemplateInfo> {
  const data = await request<unknown>('/api/v1/patient/push-template');
  if (!data || typeof data !== 'object') throw new ApiFailure('订阅消息配置响应格式不正确。', 0);
  const value = data as { ready?: unknown; templateId?: unknown; reason?: unknown };
  if (typeof value.ready !== 'boolean') throw new ApiFailure('订阅消息配置响应格式不正确。', 0);
  return {
    ready: value.ready,
    ...(typeof value.templateId === 'string' && value.templateId ? { templateId: value.templateId } : {}),
    ...(typeof value.reason === 'string' && value.reason ? { reason: value.reason } : {}),
  };
}

/** `wx.requestSubscribeMessage` 的结果：用户是否同意接收。 */
export type SubscribeOutcome = 'ACCEPTED' | 'REJECTED' | 'NOT_READY';

/**
 * 请求一次订阅消息授权。微信要求每次推送前用户已授权（一次性订阅可多次累计），
 * 因此这里刻意不做「已授权」的本地缓存 —— 每次进入相关页面都应能重新请求。
 *
 * 用户拒绝不是错误：返回 REJECTED，由页面如实提示，绝不弹错误或反复纠缠。
 */
export function requestSubscribeConsent(templateId: string): Promise<SubscribeOutcome> {
  return new Promise(resolve => {
    if (typeof wx.requestSubscribeMessage !== 'function') { resolve('NOT_READY'); return; }
    wx.requestSubscribeMessage({
      tmplIds: [templateId],
      success: result => resolve(result[templateId] === 'accept' ? 'ACCEPTED' : 'REJECTED'),
      fail: () => resolve('NOT_READY'),
    });
  });
}
