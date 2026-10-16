import test from 'node:test';
import assert from 'node:assert/strict';
import { capturePages, instantiate, installWx, loadPage, settle, SESSION_KEY } from './helpers/wechat-runtime.mjs';

const registered = capturePages();
installWx(() => [404, {}]);
const reportPage = await loadPage(registered, new URL('../dist/pages/patient/visit-report.js', import.meta.url).href);
const recordsPage = await loadPage(registered, new URL('../dist/pages/patient/records.js', import.meta.url).href);
const medicationsPage = await loadPage(registered, new URL('../dist/pages/patient/medications.js', import.meta.url).href);
const { loginWithWechat, session: currentSession } = await import('../dist/api.js');
const { validFollowupDate, saveLocalFollowup, readLocalFollowup } = await import('../dist/local-followup.js');
const { API_BASE, localFollowupKey, identityStorageKeys } = await import('../dist/config.js');

const now = new Date().toISOString();
const session = { accessToken: 'current-access', refreshToken: 'current-refresh', userId: 'user-1', actorIds: ['actor-1'], actorId: 'actor-1', role: 'PATIENT', patientId: 'patient-1' };
const scope = { userId: session.userId, actorId: session.actorId, patientId: session.patientId };
const actor = (id, patientId, extra = {}) => ({ id, patientId, relation: 'SELF', activeFrom: '2000-01-01T00:00:00.000Z', ...extra });
const loginActors = [
  actor('00-unlisted', 'patient-unlisted'),
  actor('01-expired', 'patient-expired', { activeUntil: '2001-01-01T00:00:00.000Z' }),
  actor('02-clinician', 'patient-clinician', { relation: 'CLINICIAN' }),
  actor('03-revoked', 'patient-revoked', { revokedAt: '2001-01-01T00:00:00.000Z' }),
  actor('female-actor', 'patient-female'),
  actor('male-actor', 'patient-male'),
];
const loginTokens = { accessToken: 'login-access', refreshToken: 'login-refresh', userId: 'login-user', actorIds: loginActors.filter(item => item.id !== '00-unlisted').map(item => item.id) };

for (const sex of ['MALE', 'FEMALE']) {
  test(`选择 ${sex} 入口只匹配已授权、有效且摘要性别一致的患者档案`, async () => {
    const { calls } = installWx(path => {
      if (path === '/api/v1/auth/wechat/login') return [200, { data: loginTokens }];
      if (path === '/api/v1/auth/actors') return [200, { data: loginActors }];
      if (path === '/api/v1/patients/patient-female/summary') return [200, { data: { patientId: 'patient-female', sex: 'FEMALE' } }];
      if (path === '/api/v1/patients/patient-male/summary') return [200, { data: { patientId: 'patient-male', sex: 'MALE' } }];
      assert.fail(`不应读取未授权或无效身份的摘要：${path}`);
    });
    const next = await loginWithWechat(sex);
    assert.equal(next.patientId, sex === 'MALE' ? 'patient-male' : 'patient-female');
    assert.equal(next.actorId, sex === 'MALE' ? 'male-actor' : 'female-actor');
    assert.deepEqual(currentSession(), next);
    const summaryCalls = calls.requests.filter(item => item.path.endsWith('/summary'));
    assert.equal(summaryCalls.length, 2);
    for (const request of summaryCalls) {
      assert.equal(request.header['x-actor-id'], request.path.includes('patient-male/') ? 'male-actor' : 'female-actor');
      assert.equal(request.header.Authorization ?? request.header.authorization, 'Bearer login-access');
    }
  });
}

test('男性入口不会接受另一患者摘要中的性别来切换档案', async () => {
  installWx(path => {
    if (path === '/api/v1/auth/wechat/login') return [200, { data: loginTokens }];
    if (path === '/api/v1/auth/actors') return [200, { data: loginActors }];
    if (path.endsWith('/patient-female/summary')) return [200, { data: { patientId: 'patient-female', sex: 'FEMALE' } }];
    if (path.endsWith('/patient-male/summary')) return [200, { data: { patientId: 'some-other-patient', sex: 'MALE' } }];
    return [404, {}];
  });
  const next = await loginWithWechat('MALE');
  assert.equal(next.actorId, 'female-actor', '没有可信的匹配项时只能保留授权默认档案，不能采纳跨患者摘要');
  assert.equal(next.patientId, 'patient-female');
});

test('本机复诊日期拒绝不存在的日期，合法闰日和备注可保存回读', () => {
  const { storage } = installWx(() => [404, {}]);
  for (const invalid of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-1-01', '', '2026-10-20T00:00:00Z']) {
    assert.equal(validFollowupDate(invalid), false, invalid);
    assert.throws(() => saveLocalFollowup(scope, { date: invalid, note: '' }), /有效的复诊日期/);
  }
  assert.equal(storage.size, 0);
  assert.equal(validFollowupDate('2028-02-29'), true);
  saveLocalFollowup(scope, { date: '2028-02-29', note: '带上近期体温和用药记录' });
  assert.deepEqual(readLocalFollowup(scope), { date: '2028-02-29', note: '带上近期体温和用药记录' });
  saveLocalFollowup(scope, { date: '2026-10-20', note: '记'.repeat(250) });
  assert.equal(readLocalFollowup(scope).note.length, 200);
});

test('本机复诊按用户、身份、患者和 API 源隔离，失效清理包含该键', () => {
  const { storage } = installWx(() => [404, {}]);
  const value = { date: '2026-10-20', note: '自己记下的复诊' };
  saveLocalFollowup(scope, value);
  for (const other of [{ ...scope, userId: 'other-user' }, { ...scope, actorId: 'other-actor' }, { ...scope, patientId: 'other-patient' }]) {
    assert.equal(readLocalFollowup(other), null);
  }
  const key = localFollowupKey(scope.userId, scope.actorId, scope.patientId);
  assert.ok(identityStorageKeys(scope.userId, scope.actorId, scope.patientId).includes(key));
  assert.ok(key.includes(encodeURIComponent(API_BASE)), '环境隔离键必须包含当前 API 源');
  const otherEnvironmentKey = key.replace(encodeURIComponent(API_BASE), encodeURIComponent('https://other-environment.invalid'));
  assert.notEqual(otherEnvironmentKey, key);
  storage.delete(key);
  storage.set(otherEnvironmentKey, value);
  assert.equal(readLocalFollowup(scope), null, '另一 API 环境的复诊不能展示给当前环境');
  storage.set(key, { date: '2026-02-31', note: '损坏记录' });
  assert.equal(readLocalFollowup(scope), null);
});

for (const [level, tone, action] of [['ACT_NOW', 'urgent', /立即联系|急诊/], ['REVIEW', 'watch', /24 小时内联系医生/]]) {
  test(`趋势接口失败时，报告仍保留复诊摘要 ${level} 的行动强度`, async () => {
    installWx(path => {
      if (path.endsWith('/trend')) return [503, { message: '趋势暂不可用' }];
      if (path.endsWith('/summary')) return [200, { data: { patientId: session.patientId, patientDisplayName: '当前患者', observationsCount: 2, alerts: [] } }];
      if (path.endsWith('/visit-summary')) return [200, { data: { patientId: session.patientId, trend: { actionLevel: level, narrative: ['按行动建议处理。'] }, medications: [], recentRecords: [] } }];
      if (path.endsWith('/medications')) return [200, { data: { patientId: session.patientId, plans: [] } }];
      return [404, {}];
    }, { session });
    const page = instantiate(reportPage);
    page.onShow(); await settle();
    assert.equal(page.data.loading, false);
    assert.equal(page.data.error, '');
    assert.equal(page.data.report.riskTone, tone);
    assert.match(page.data.report.action, action);
    assert.equal(page.data.report.alerts[0].tone, tone);
    assert.doesNotMatch(page.data.report.action, /继续记录并留意变化/);
    assert.deepEqual(page.data.report.series, []);
  });
}

test('报告缺少趋势时取摘要和复诊中的最高行动级别', async () => {
  installWx(path => {
    if (path.endsWith('/trend')) return 'NETWORK';
    if (path.endsWith('/summary')) return [200, { data: { patientId: session.patientId, patientDisplayName: '当前患者', observationsCount: 1, alerts: [{ actionLevel: 'ACT_NOW' }] } }];
    if (path.endsWith('/visit-summary')) return [200, { data: { patientId: session.patientId, trend: { actionLevel: 'REVIEW', narrative: [] }, medications: [], recentRecords: [] } }];
    return [404, {}];
  }, { session });
  const page = instantiate(reportPage);
  page.onShow(); await settle();
  assert.equal(page.data.report.riskTone, 'urgent');
  assert.match(page.data.report.action, /立即联系/);
});

test('记录页切换患者且读取失败时，立即清除旧趋势和待提交数量', async () => {
  const { storage } = installWx(path => {
    if (path.includes('/patient-2/')) return 'NETWORK';
    if (path.endsWith('/summary')) return [200, { data: { patientId: session.patientId, patientDisplayName: '第一位患者', lifeStage: 'CHILD', observationsCount: 1, latestObservationAt: now, updatedAt: now, alerts: [] } }];
    if (path.includes('/observations?')) return [200, { data: { patientId: session.patientId, records: [{ id: 'observation-1', patientId: session.patientId, code: 'TEMP', display: '体温', unit: '℃', observedAt: now, source: 'PATIENT_REPORTED', valueNumeric: 38.5 }] } }];
    if (path.endsWith('/trend')) return [200, { data: { patientId: session.patientId, asOf: now, series: [], narrative: ['第一位患者的趋势'], decisionCard: { riskLevel: 'HIGH', actionLevel: 'REVIEW', title: '第一位患者行动卡', action: '联系照护团队' } } }];
    return [404, {}];
  }, { session });
  const page = instantiate(recordsPage);
  try {
    page.onShow(); await settle();
    assert.equal(page.data.trend.patientId, 'patient-1');
    assert.equal(page.data.records.length, 1);
    page.setData({ pendingCount: 3, rejectedCount: 1, unsentCount: 2, unsent: [{ patientId: 'patient-1' }] });
    storage.set(SESSION_KEY, { ...session, actorIds: ['actor-2'], actorId: 'actor-2', patientId: 'patient-2' });
    page.onShow();
    assert.equal(page.data.trend, null, '不能等新患者请求完成后才清理旧趋势');
    assert.equal(page.data.pendingCount, 0);
    assert.equal(page.data.rejectedCount, 0);
    assert.equal(page.data.unsentCount, 0);
    assert.deepEqual(page.data.unsent, []);
    await settle();
    assert.equal(page.data.loading, false);
    assert.ok(page.data.error);
    assert.equal(page.data.trend, null);
    assert.deepEqual(page.data.records, []);
    assert.deepEqual(page.data.recentRecords, []);
    assert.equal(page.data.pendingCount, 0);
    assert.equal(page.data.rejectedCount, 0);
    assert.equal(page.data.summaryText, '');
  } finally { page.onUnload(); }
});

test('用药新一轮读取完成后旧回包不能撤销打卡状态，隐藏或清屏后不再回填', async () => {
  const plan = { id: 'plan-1', patientId: session.patientId, kind: 'SUPPORTIVE', drug: '示例药', dose: 5, unit: 'mg', route: 'ORAL', frequency: 'DAILY', status: 'ACTIVE' };
  const overview = recorded => ({ patientId: session.patientId, asOf: now, plans: [plan], logs: [], today: [{ planId: plan.id, status: recorded ? 'RECORDED' : 'NOT_RECORDED' }], trajectories: [] });
  const definition = label => [{ code: 'TEST_SYMPTOM', severity: 'MONITOR', label, guidance: '请记录变化。' }];
  let hold = true;
  let pending = new Map();
  installWx(path => {
    if (hold) return new Promise(resolve => pending.set(path, resolve));
    if (path.endsWith('/medications')) return [200, { data: overview(true) }];
    if (path.endsWith('/definitions')) return [200, { data: definition('最新选项') }];
    return [200, { data: { items: [] } }];
  }, { session });
  const releaseOld = () => {
    for (const [path, resolve] of pending) {
      if (path.endsWith('/medications')) resolve([200, { data: overview(false) }]);
      else if (path.endsWith('/definitions')) resolve([200, { data: definition('过期选项') }]);
      else resolve([503, { message: '旧请求已失败' }]);
    }
  };
  const page = instantiate(medicationsPage);
  try {
    page.onShow(); await settle();
    assert.equal(pending.size, 7, '共享用药与波动快照、稍后提醒读取与其他用药依赖一起受同一轮代际保护');
    assert.ok([...pending.keys()].some(path => path.endsWith('/care-summary')));
    hold = false;
    page.load(); await settle();
    assert.equal(page.data.statusText[plan.id], '今日已记录');
    assert.equal(page.data.sideEffectDefinitions[0].label, '最新选项', '刷新提醒计时器不能使同轮其他接口失效');
    releaseOld(); await settle();
    assert.equal(page.data.statusText[plan.id], '今日已记录');
    assert.equal(page.data.sideEffectDefinitions[0].label, '最新选项');
    assert.equal(page.data.sideEffectError, '');
    assert.equal(page.data.screeningError, '');
    assert.equal(page.data.loading, false);

    hold = true; pending = new Map();
    page.load(); await settle();
    page.onHide();
    releaseOld(); await settle();
    assert.equal(page.data.statusText[plan.id], '今日已记录', '隐藏后旧请求不能更新页面');
    assert.equal(page.data.sideEffectDefinitions[0].label, '最新选项');

    pending = new Map();
    page.load(); await settle();
    page.clearSensitiveState('已失去访问权限');
    releaseOld(); await settle();
    assert.equal(page.data.overview, null);
    assert.equal(page.data.wave, null);
    assert.deepEqual(page.data.waveRows, []);
    assert.deepEqual(page.data.sideEffectDefinitions, []);
    assert.equal(page.data.error, '已失去访问权限');
    assert.equal(page.data.loading, false);
  } finally { page.onUnload(); }
});
