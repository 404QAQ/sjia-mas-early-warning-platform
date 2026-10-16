import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { isAllowedPatientRoute, isPublicRoute } from './allowlist.mjs';

const port = Number(process.env.PORT ?? 4302);
const mode = process.env.PATIENT_API_MODE ?? 'fixture';
const upstream = String(process.env.PATIENT_UPSTREAM_URL ?? '').replace(/\/$/, '');
const demoCode = process.env.PATIENT_DEMO_CODE ?? 'demo-auto-login';
const publicShareCode = process.env.PATIENT_FIXTURE_SHARE_CODE ?? 'demo-share';
const corsOrigin = process.env.PATIENT_CORS_ORIGIN ?? 'http://127.0.0.1:4302';
const maxBodyBytes = 512 * 1024;
const accessTokenTtlMs = 60 * 60 * 1000;
const refreshTokenTtlMs = 7 * 24 * 60 * 60 * 1000;
const sessions = new Map();
const refreshSessions = new Map();
const observations = new Map();
const messages = new Map();

if (!['fixture', 'proxy'].includes(mode)) throw new Error('PATIENT_API_MODE 只能是 fixture 或 proxy');
if (mode === 'proxy' && upstream) {
  const parsed = new URL(upstream);
  const localDevelopment = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && localDevelopment && process.env.PATIENT_ALLOW_INSECURE_UPSTREAM === '1')) {
    throw new Error('PATIENT_UPSTREAM_URL 必须使用 HTTPS；仅允许显式开启的本机 HTTP 开发服务');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('PATIENT_UPSTREAM_URL 不得包含凭据、查询参数或片段');
}
try {
  const parsedCors = new URL(corsOrigin);
  if (!['http:', 'https:'].includes(parsedCors.protocol) || parsedCors.username || parsedCors.password || parsedCors.pathname !== '/' || parsedCors.search || parsedCors.hash || corsOrigin === '*') throw new Error('invalid');
} catch { throw new Error('PATIENT_CORS_ORIGIN 必须是单个 http/https origin，不能使用通配符'); }

const now = () => new Date().toISOString();
const patientIds = ['patient-demo', 'patient-female', 'patient-male'];
const patientProfile = {
  'patient-demo': { patientDisplayName: '林安', sex: 'FEMALE', lifeStage: 'ADULT', diseaseType: 'sJIA' },
  'patient-female': { patientDisplayName: '林安', sex: 'FEMALE', lifeStage: 'ADULT', diseaseType: 'sJIA' },
  'patient-male': { patientDisplayName: '周予', sex: 'MALE', lifeStage: 'ADULT', diseaseType: 'sJIA' },
};
const demoPatientId = process.env.PATIENT_DEMO_PATIENT_ID ?? 'patient-demo';
if (!patientIds.includes(demoPatientId)) throw new Error('PATIENT_DEMO_PATIENT_ID 必须是已配置的演示患者');

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function error(response, status, code, message) {
  json(response, status, { error: { code, message } });
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw Object.assign(new Error('请求体过大'), { status: 413, code: 'PAYLOAD_TOO_LARGE' });
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('请求体必须是 JSON 对象'), { status: 400, code: 'INVALID_BODY' });
    return value;
  } catch (caught) {
    if (caught?.code === 'INVALID_BODY') throw caught;
    throw Object.assign(new Error('请求体不是有效 JSON'), { status: 400, code: 'INVALID_JSON' });
  }
}

function patientForActor(actor) {
  return actor?.patientId && patientIds.includes(actor.patientId) ? actor.patientId : null;
}

function actorFor(patientId) {
  return { id: `actor-self@${patientId}`, patientId, relation: 'SELF', displayName: '本人', activeFrom: '2026-01-01T00:00:00.000Z' };
}

function bearerToken(request) {
  const value = request.headers.authorization;
  if (typeof value !== 'string') return null;
  const match = value.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

function tokenBundle(session) {
  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    userId: session.userId,
    actorIds: session.actors.map(actor => actor.id),
    accessExpiresAt: session.accessExpiresAt,
    refreshExpiresAt: session.refreshExpiresAt,
  };
}

function issueFixtureSession(patientId = demoPatientId) {
  const actor = actorFor(patientId);
  const session = {
    userId: 'user-patient-demo',
    patientId,
    actors: [actor],
    accessToken: `patient-access-${randomUUID()}`,
    refreshToken: `patient-refresh-${randomUUID()}`,
    accessExpiresAt: new Date(Date.now() + accessTokenTtlMs).toISOString(),
    refreshExpiresAt: new Date(Date.now() + refreshTokenTtlMs).toISOString(),
  };
  sessions.set(session.accessToken, session);
  refreshSessions.set(session.refreshToken, session);
  return session;
}

function sessionFor(request) {
  const token = bearerToken(request);
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.parse(session.accessExpiresAt) <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  const requestedActorId = request.headers['x-actor-id'];
  const selected = session.actors.find(actor => actor.id === requestedActorId);
  if (requestedActorId && !selected) return { ...session, actorId: requestedActorId, actorMismatch: true };
  const actor = selected ?? session.actors[0];
  return { ...session, patientId: actor.patientId, actorId: actor.id, actorMismatch: false };
}

function patientIdFromPath(pathname) {
  const matched = pathname.match(/^\/api\/v1\/patients\/([^/]+)/);
  if (!matched) return null;
  try { return decodeURIComponent(matched[1]); } catch { return undefined; }
}

function summary(patientId) {
  const profile = patientProfile[patientId] ?? patientProfile['patient-demo'];
  const records = observations.get(patientId) ?? [];
  return {
    patientId, ...profile, asOf: now(), updatedAt: now(), observationsCount: records.length + 4,
    latestObservationAt: records.at(-1)?.observedAt ?? '2026-10-16T09:30:00.000Z',
    alerts: [{ id: 'alert-demo-1', riskLevel: 'MEDIUM', actionLevel: 'REVIEW', title: '趋势需要复核', status: 'OPEN', createdAt: '2026-10-16T09:30:00.000Z' }],
    urgentCard: { tone: 'watch', title: '近期趋势需要关注', action: '查看详细趋势' },
  };
}

function trend(patientId) {
  return { patientId, asOf: now(), series: [
    { code: 'TEMP', display: '体温', unit: '℃', points: [{ at: '2026-10-14T09:00:00.000Z', value: 36.8, unit: '℃' }, { at: '2026-10-15T09:00:00.000Z', value: 37.1, unit: '℃' }, { at: '2026-10-16T09:00:00.000Z', value: 37.4, unit: '℃' }] },
    { code: 'FERRITIN', display: '铁蛋白', unit: 'ng/mL', points: [{ at: '2026-10-02T09:00:00.000Z', value: 1180, unit: 'ng/mL' }, { at: '2026-10-16T09:00:00.000Z', value: 960, unit: 'ng/mL' }] },
  ], narrative: ['体温近三日小幅上行，请按计划记录并关注伴随症状。', '铁蛋白较上次下降，建议复诊时结合完整报告核对。'], decisionCard: { riskLevel: 'MEDIUM', actionLevel: 'REVIEW', title: '继续记录并复核趋势', action: '如出现持续高热或精神状态变化，请及时联系照护团队。' } };
}

function medications(patientId) {
  return { patientId, asOf: now(), plans: [{ id: 'med-plan-1', drug: '托珠单抗', status: 'ACTIVE', source: 'CLINICIAN' }, { id: 'med-plan-2', drug: '泼尼松', status: 'ACTIVE', source: 'CLINICIAN' }], trajectories: [
    { planId: 'med-plan-1', drug: '托珠单抗', status: 'ACTIVE', frequency: '按医嘱', unit: 'mg', points: [{ at: '2026-10-14T08:00:00.000Z', kind: 'PLAN', plannedDose: 162, comparison: '按计划' }], missingWindows: [] },
    { planId: 'med-plan-2', drug: '泼尼松', status: 'ACTIVE', frequency: '每日一次', unit: 'mg', points: [{ at: '2026-10-16T08:00:00.000Z', kind: 'ACTUAL', actualDose: 5, comparison: '已记录' }], missingWindows: [] },
  ] };
}

function psychForm(patientId) {
  return { patientId, visits: [{ id: 'psych-visit-1', status: 'AVAILABLE', title: '近两周情绪与睡眠评估', description: '完成后可在复诊时与医生一起查看。', questions: [{ id: 'q1', text: '最近两周是否经常感到紧张或担心？', options: ['从不', '有几天', '一半以上时间', '几乎每天'] }] }] };
}

const OBSERVATION_FIELDS = ['idempotencyKey', 'patientId', 'observedAt', 'recordedAt', 'source', 'tags', 'code', 'display', 'unit', 'valueNumeric', 'valueText', 'valueCoded', 'value', 'confidence'];
const MESSAGE_FIELDS = ['idempotencyKey', 'kind', 'body'];
function boundedText(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0]/.test(value); }
function invalidBody(message) { return Object.assign(new Error(message), { status: 400, code: 'INVALID_BODY' }); }
function validateWriteBody(pathname, body, patientId) {
  const isObservation = pathname === '/api/v1/observations' || /\/patients\/[^/]+\/observations$/.test(pathname);
  const isMessage = pathname === '/api/v1/messages';
  if (!isObservation && !isMessage) return;
  const fields = isObservation ? OBSERVATION_FIELDS : MESSAGE_FIELDS;
  if (Object.keys(body).some(key => !fields.includes(key))) throw invalidBody('请求包含未允许的字段');
  if (isObservation) {
    if (!boundedText(body.code, 100) || (body.patientId !== undefined && body.patientId !== patientId)) throw invalidBody('观测记录字段无效');
    for (const key of ['idempotencyKey', 'source', 'display', 'unit', 'valueText', 'valueCoded', 'confidence']) if (body[key] !== undefined && !boundedText(body[key], 256)) throw invalidBody('观测记录字段无效');
    for (const key of ['valueNumeric', 'value']) if (body[key] !== undefined && (typeof body[key] !== 'number' || !Number.isFinite(body[key]))) throw invalidBody('观测记录数值无效');
    for (const key of ['observedAt', 'recordedAt']) if (body[key] !== undefined && (!boundedText(body[key], 80) || !Number.isFinite(Date.parse(body[key])))) throw invalidBody('观测时间无效');
    if (body.tags !== undefined && (!Array.isArray(body.tags) || body.tags.length > 20 || !body.tags.every(tag => boundedText(tag, 100)))) throw invalidBody('观测标签无效');
    return;
  }
  if (!boundedText(body.body, 20_000) || !boundedText(body.kind, 80) || (body.idempotencyKey !== undefined && !boundedText(body.idempotencyKey, 256))) throw invalidBody('消息字段无效');
}

const FIXTURE_NOT_IMPLEMENTED = Symbol('fixture-not-implemented');

function genericPayload(pathname, patientId, method, body) {
  const records = observations.get(patientId) ?? [];
  if (method === 'POST' && pathname.endsWith('/observations')) {
    const record = { id: `obs-${randomUUID()}`, ...body, patientId, recordedAt: body?.recordedAt ?? now() };
    observations.set(patientId, [...records, record]);
    return record;
  }
  if (method === 'POST' && (pathname === '/api/v1/messages' || /\/patients\/[^/]+\/messages$/.test(pathname))) {
    const message = { id: `message-${randomUUID()}`, ...body, patientId, createdAt: now(), read: false };
    messages.set(patientId, [...(messages.get(patientId) ?? []), message]);
    return message;
  }
  if (method !== 'GET') return FIXTURE_NOT_IMPLEMENTED;
  if (pathname.endsWith('/summary')) return summary(patientId);
  if (pathname.endsWith('/trend')) return trend(patientId);
  if (pathname.endsWith('/medications') || pathname.endsWith('/medication-wave')) return medications(patientId);
  if (pathname.endsWith('/psych-screening-form')) return psychForm(patientId);
  if (pathname.endsWith('/observations')) return { patientId, records, total: records.length };
  if (pathname.endsWith('/visit-summary')) return { patientId, trend: trend(patientId), medications: medications(patientId).plans, recentRecords: records.slice(-5) };
  if (pathname.endsWith('/messages') || pathname === '/api/v1/messages') return { patientId, records: messages.get(patientId) ?? [] };
  if (pathname.endsWith('/notifications')) return { patientId, records: [] };
  if (pathname.endsWith('/psych-screenings') || pathname.endsWith('/psych-support')) return { patientId, visits: [] };
  if (pathname.endsWith('/followups') || pathname === '/api/v1/followups') return { patientId, items: [] };
  if (pathname.endsWith('/care-summary')) return { patientId, asOf: now(), primary: [], attending: [], consultants: [], onCall: [], backup: [], capabilities: { canMessageCareTeam: false, hasTreatmentClinician: false } };
  if (pathname.endsWith('/audit')) return { patientId, items: [], nextCursor: null };
  return FIXTURE_NOT_IMPLEMENTED;
}

async function proxy(request, response, url) {
  if (!upstream) return error(response, 503, 'PATIENT_UPSTREAM_NOT_CONFIGURED', '代理模式需要配置 PATIENT_UPSTREAM_URL');
  const body = request.method === 'GET' || request.method === 'DELETE' ? undefined : await readJson(request);
  const headers = { accept: request.headers.accept ?? 'application/json', 'content-type': 'application/json' };
  for (const key of ['authorization', 'x-actor-id', 'idempotency-key']) if (request.headers[key]) headers[key] = request.headers[key];
  const result = await fetch(`${upstream}${url.pathname}${url.search}`, { method: request.method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10_000) });
  const contentType = result.headers.get('content-type') ?? '';
  const binary = url.pathname.endsWith('.pdf') || url.pathname.endsWith('.svg');
  if (binary) {
    const expected = url.pathname.endsWith('.pdf') ? 'application/pdf' : 'image/svg+xml';
    if (!contentType.toLowerCase().startsWith(expected)) return error(response, 502, 'UPSTREAM_RESPONSE_NOT_PUBLIC', '上游返回了不符合患者端契约的文件类型');
    response.writeHead(result.status, { 'content-type': expected, 'cache-control': 'no-store' });
    response.end(Buffer.from(await result.arrayBuffer()));
    return;
  }
  const text = await result.text();
  if (!/\bjson\b/i.test(contentType)) return error(response, 502, 'UPSTREAM_RESPONSE_NOT_PUBLIC', '上游返回了非 JSON 患者端响应');
  let parsed;
  try { parsed = JSON.parse(text); } catch { return error(response, 502, 'UPSTREAM_RESPONSE_NOT_PUBLIC', '上游返回了无法解析的患者端响应'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return error(response, 502, 'UPSTREAM_RESPONSE_NOT_PUBLIC', '上游响应不是公开对象');
  if (result.ok ? !Object.hasOwn(parsed, 'data') : !parsed.error || typeof parsed.error !== 'object') {
    return error(response, 502, 'UPSTREAM_RESPONSE_NOT_PUBLIC', '上游响应不符合患者端数据契约');
  }
  const privateKey = /^(?:access|refresh)?_?token$|password|secret|(?:internal|debug|stack|trace|sql|database|worklist|handoff|thresholdconfig|notificationprofile|ops)(?:$|_)/i;
  const containsPrivateKey = value => {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(containsPrivateKey);
    return Object.entries(value).some(([key, child]) => privateKey.test(key) || containsPrivateKey(child));
  };
  if (containsPrivateKey(parsed)) return error(response, 502, 'UPSTREAM_RESPONSE_NOT_PUBLIC', '上游响应包含未允许的内部字段');
  response.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(parsed));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const method = request.method ?? 'GET';
  response.setHeader('access-control-allow-origin', corsOrigin);
  response.setHeader('access-control-allow-headers', 'authorization, content-type, x-actor-id, idempotency-key');
  response.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (method === 'OPTIONS') return json(response, 204, {});
  if (!isAllowedPatientRoute(method, url.pathname)) return error(response, 404, 'NOT_FOUND', '患者 API 中不存在该路径');
  if (url.pathname === '/health') return json(response, 200, { ok: true, service: 'patient-api', mode });
  if (url.pathname === '/ready') return json(response, 200, { ready: mode === 'fixture' || Boolean(upstream), service: 'patient-api' });
  try {
    if (mode === 'proxy') {
      if (!isPublicRoute(method, url.pathname) && !bearerToken(request)) return error(response, 401, 'UNAUTHORIZED', '需要 Bearer 患者会话');
      if (!isPublicRoute(method, url.pathname) && patientIdFromPath(url.pathname) !== null && (typeof request.headers['x-actor-id'] !== 'string' || request.headers['x-actor-id'].trim() === '')) {
        return error(response, 400, 'ACTOR_REQUIRED', '患者路径必须提供 x-actor-id，具体患者授权由上游服务校验');
      }
      return await proxy(request, response, url);
    }
    if (url.pathname === '/api/v1/auth/wechat/login' || url.pathname === '/api/v1/auth/wechat/bind') {
      const body = await readJson(request);
      if (body.code !== demoCode) return error(response, 401, 'LOGIN_CODE_REJECTED', '本地演示服务只接受 PATIENT_DEMO_CODE');
      if (url.pathname.endsWith('/bind') && typeof body.inviteCode !== 'string') return error(response, 400, 'INVITE_REQUIRED', '本地绑定演示需要邀请码');
      if (body.preferredSex !== undefined && body.preferredSex !== 'MALE' && body.preferredSex !== 'FEMALE') return error(response, 400, 'INVALID_SEX_INTENT', '入口性别选择无效');
      const selectedPatient = url.pathname.endsWith('/login') && body.preferredSex === 'MALE' ? 'patient-male' : demoPatientId;
      return json(response, 200, { data: tokenBundle(issueFixtureSession(selectedPatient)) });
    }
    if (url.pathname === '/api/v1/auth/refresh') {
      const body = await readJson(request);
      const previous = refreshSessions.get(body.refreshToken);
      if (!previous || Date.parse(previous.refreshExpiresAt) <= Date.now()) {
        if (previous) refreshSessions.delete(body.refreshToken);
        return error(response, 401, 'REFRESH_REJECTED', '刷新令牌无效或已失效');
      }
      refreshSessions.delete(body.refreshToken);
      sessions.delete(previous.accessToken);
      return json(response, 200, { data: tokenBundle(issueFixtureSession(previous.patientId)) });
    }
    if (url.pathname === '/api/v1/auth/logout') {
      const body = await readJson(request);
      if (body.refreshToken) refreshSessions.delete(body.refreshToken);
      const accessToken = bearerToken(request);
      const active = accessToken ? sessions.get(accessToken) : null;
      if (active) {
        sessions.delete(accessToken);
        refreshSessions.delete(active.refreshToken);
      }
      return json(response, 200, { data: { revoked: true } });
    }
    if (url.pathname === '/api/v1/auth/actors') {
      const session = sessionFor(request);
      if (!session) return error(response, 401, 'UNAUTHORIZED', '需要患者会话');
      if (session?.actorMismatch) return error(response, 403, 'FORBIDDEN', '当前会话无权使用该操作者');
      return json(response, 200, { data: session ? session.actors : [] });
    }
    const session = sessionFor(request);
    if (!isPublicRoute(method, url.pathname) && !session) return error(response, 401, 'UNAUTHORIZED', '需要患者会话');
    if (session?.actorMismatch) return error(response, 403, 'FORBIDDEN', '当前会话无权使用该操作者');
    if (url.pathname === '/api/v1/patient/push-template') return json(response, 200, { data: { ready: false, reason: '本地服务未接入微信订阅消息' } });
    const body = method === 'GET' || method === 'DELETE' ? {} : await readJson(request);
    const patientId = session?.patientId ?? 'patient-demo';
    const requestedPatientId = patientIdFromPath(url.pathname);
    if (requestedPatientId === undefined) return error(response, 400, 'INVALID_PATIENT_ID', '患者标识无效');
    if (requestedPatientId !== null && requestedPatientId !== patientId) return error(response, 403, 'FORBIDDEN', '当前会话无权访问其他患者');
    if (mode === 'fixture' && !['GET', 'DELETE'].includes(method)) validateWriteBody(url.pathname, body, patientId);
    if (isPublicRoute(method, url.pathname) && /^\/api\/v1\/(contact-links|emergency-shares)\//.test(url.pathname)) {
      const publicCode = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
      if (publicCode !== publicShareCode) return error(response, 404, 'NOT_FOUND', '分享链接不存在或已失效');
    }
    const payload = genericPayload(url.pathname, patientId, method, body);
    if (payload === FIXTURE_NOT_IMPLEMENTED) return error(response, 501, 'FIXTURE_NOT_IMPLEMENTED', '本地 fixture 尚未实现该患者端写操作');
    return json(response, 200, { data: payload });
  } catch (caught) {
    const status = Number(caught?.status) || 500;
    return error(response, status, caught?.code ?? 'INTERNAL_ERROR', caught?.message ?? '服务暂时不可用');
  }
});

server.listen(port, '127.0.0.1', () => console.log(`patient-api listening on http://127.0.0.1:${port} (${mode})`));

process.on('SIGTERM', () => server.close(() => process.exit(0)));
