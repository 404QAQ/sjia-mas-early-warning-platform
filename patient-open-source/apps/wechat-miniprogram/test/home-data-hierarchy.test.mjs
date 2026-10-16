import test from 'node:test';
import assert from 'node:assert/strict';
import { capturePages, instantiate, installWx, loadPage, settle } from './helpers/wechat-runtime.mjs';
const registered = capturePages();
installWx(() => [404, {}]);
const home = await loadPage(registered, new URL('../dist/pages/home/index.js', import.meta.url).href);
const session = { accessToken: 'a', refreshToken: 'r', userId: 'u', actorIds: ['a1'], actorId: 'a1', role: 'PATIENT', patientId: 'p' };
const at = '2026-10-14T03:00:00.000Z';
function trend(actionLevel = 'OBSERVE', riskLevel = 'LOW') {
  return { patientId: 'p', asOf: '2026-10-14T10:00:00.000Z', series: [
    { code: 'TEMP', display: '体温', unit: '℃', points: [{ at, value: 37, unit: '℃' }] },
    { code: 'HEART_RATE', display: '心率', unit: 'bpm', points: [{ at, value: 85, unit: 'bpm' }] },
    { code: 'PLT', display: '血小板', unit: '10^9/L', points: [{ at: '2026-10-12T03:00:00.000Z', value: 180, unit: '10^9/L' }, { at, value: 160, unit: '10^9/L' }] },
  ], narrative: [], decisionCard: { actionLevel, riskLevel, title: '行动指引', action: '按已确认预案处理' } };
}
test('首页各指标使用真实采样时间，体温不在其他指标重复出现', async () => {
  installWx(path => path.endsWith('/trend') ? [200, { data: trend() }] : [404, {}], { session });
  const page = instantiate(home);
  await page.loadHomeSnapshot(session, page.actorLoadVersion);
  const s = page.data.homeSnapshot;
  assert.equal(s.temperatureSummary, '37 ℃');
  assert.equal(s.temperatureRecordedAt, '2026/10/14 11:00');
  assert.deepEqual(s.healthMetrics.map(x => x.label), ['心率']);
  assert.equal(s.healthMetrics[0].recordedAt, s.temperatureRecordedAt);
  assert.equal(s.labFindings[0].recordedAt, s.temperatureRecordedAt);
  assert.equal(s.labFindings[0].direction, 'down');
});
test('首页部分接口失败与成功读取空记录分别标识，不能用空态表示失败', async () => {
  installWx(path => path.endsWith('/trend') ? [200, { data: trend() }] : [404, {}], { session });
  const page = instantiate(home);
  await page.loadHomeSnapshot(session, page.actorLoadVersion);
  assert.equal(page.data.homeSnapshot.trendAvailable, true);
  assert.equal(page.data.homeSnapshot.medicationsAvailable, false);
  assert.equal(page.data.homeSnapshot.symptomsAvailable, false);
  assert.match(page.data.homeSnapshot.followUpCard.date, /暂未读取/);
  installWx(path => path.endsWith('/medications') ? [200, { data: { patientId: 'p', asOf: at, plans: [], trajectories: [] } }] : path.includes('/observations?') ? [200, { data: { patientId: 'p', records: [] } }] : [404, {}], { session });
  await page.loadHomeSnapshot(session, page.actorLoadVersion);
  assert.equal(page.data.homeSnapshot.trendAvailable, false);
  assert.equal(page.data.homeSnapshot.medicationsAvailable, true);
  assert.equal(page.data.homeSnapshot.symptomsAvailable, true);
});
test('立即行动入口与实际急诊页一致，其他指标不因行动卡自动染红', async () => {
  const nav = [];
  installWx(path => path.endsWith('/trend') ? [200, { data: trend('ACT_NOW', 'HIGH') }] : [404, {}], { session, extra: { navigateTo({ url }) { nav.push(url); } } });
  const page = instantiate(home);
  await page.loadHomeSnapshot(session, page.actorLoadVersion);
  assert.equal(page.data.homeSnapshot.urgentCard.primary, '查看急诊须知');
  assert.equal(page.data.homeSnapshot.urgentCard.tone, 'alert');
  assert.equal(page.data.homeSnapshot.healthMetrics[0].tone, 'normal');
  page.contactDoctor();
  assert.deepEqual(nav, ['/pages/patient/emergency']);
});
test('高风险观察仍保留观察说明，未按风险级别改成红行动', async () => {
  installWx(path => path.endsWith('/trend') ? [200, { data: trend('OBSERVE', 'HIGH') }] : [404, {}], { session });
  const page = instantiate(home);
  await page.loadHomeSnapshot(session, page.actorLoadVersion);
  assert.equal(page.data.homeSnapshot.urgentCard.tone, 'normal');
  assert.match(page.data.homeSnapshot.urgentCard.body, /观察安排不代表指标正常/);
  page.toggleObservationDetails();
  assert.equal(page.data.showObservationDetails, true);
  page.onShow();
  assert.equal(page.data.showObservationDetails, false);
});

test('成年端安全网投影只按服务端 asOf/deadlineAt 展示，并用代次保护患者动作', async () => {
  const runId = '11111111-1111-4111-8111-111111111111';
  const deadlineAt = '2026-10-14T06:00:00.000Z';
  const safety = {
    patientId: 'p', asOf: '2026-10-14T04:00:00.000Z', state: 'COUNTDOWN', runId,
    alertId: '22222222-2222-4222-8222-222222222222', triggeredAt: '2026-10-14T03:00:00.000Z',
    deadlineAt, remainingSeconds: 7200, lastRecordAt: '2026-10-13T16:00:00.000Z', silentHours: 12,
    contact: { contactId: 'contact-1', displayName: '陈某某', priority: 1, visibility: 'G2_SUMMARY' },
    generation: 1, snoozedAt: null, canSelfContact: true, canSnooze: true, canCancel: true,
  };
  let active = true;
  const { calls } = installWx(path => {
    if (path.endsWith('/contact-safety/runs/current')) return [200, { data: active ? safety : { ...safety, state: 'INACTIVE', runId: null, alertId: null, triggeredAt: null, deadlineAt: null, remainingSeconds: null, contact: null, generation: null, snoozedAt: null, canSelfContact: false, canSnooze: false, canCancel: false } }];
    if (path.endsWith(`/contact-safety/runs/${runId}/self-contact`)) { active = false; return [200, { data: { run: {}, created: true } }]; }
    return [404, {}];
  }, { session });
  const page = instantiate(home);
  await page.loadContactSafety(session, page.actorLoadVersion);
  assert.equal(page.data.contactSafety.runId, runId);
  assert.equal(page.data.contactSafety.contact.displayName, '陈某某');
  assert.equal(page.data.safetyCountdown, '02:00:00');
  page.safetySelfContact();
  await settle();
  const action = calls.requests.find(item => item.path.endsWith(`/contact-safety/runs/${runId}/self-contact`));
  assert.equal(action.method, 'POST');
  assert.equal(action.data.expectedVersion, 1);
  assert.equal(typeof action.data.idempotencyKey, 'string');
  page.onHide();
});
