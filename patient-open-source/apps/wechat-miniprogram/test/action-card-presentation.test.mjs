import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { capturePages, instantiate, installWx, loadPage, settle } from './helpers/wechat-runtime.mjs';

const dist = process.env.MAS_MINIPROGRAM_TEST_DIST ? pathToFileURL(`${process.env.MAS_MINIPROGRAM_TEST_DIST}/`) : new URL('../dist/', import.meta.url);
const registered = capturePages();
installWx(() => [404, {}]);
const home = await loadPage(registered, new URL('pages/home/index.js', dist).href);
const report = await loadPage(registered, new URL('pages/patient/visit-report.js', dist).href);
await loadPage(registered, new URL('pages/patient/trend.js', dist).href);
const { parseTrend } = await import(new URL('pages/patient/trend.js', dist).href);
const { observationActionCopy } = await import(new URL('action-card-presentation.js', dist).href);
const { at } = await import(new URL('date-format.js', dist).href);
const session = { accessToken: 'access-1', refreshToken: 'refresh-1', userId: 'user-1', actorIds: ['actor-1'], actorId: 'actor-1', role: 'PATIENT', patientId: 'patient-wang' };
const patientId = session.patientId;
const observedAt = '2026-10-13T15:30:00.000Z';
const asOf = '2026-10-14T08:00:00.000Z';
const trend = (riskLevel = 'MEDIUM', actionLevel = 'OBSERVE') => ({
  patientId, asOf, narrative: [],
  decisionCard: { riskLevel, actionLevel, title: '继续按计划观察', action: '不要因为当前颜色较浅就自行停药。' },
  series: [{ code: 'TEMP', display: '体温', unit: '℃', points: [
    { at: observedAt, value: 39.3, unit: '℃', source: 'PATIENT_REPORTED' },
    { at: '2026-10-12T12:00:00.000Z', value: 38.1, unit: '℃', source: 'PATIENT_REPORTED' },
  ] }],
});

test('观察级解释风险与行动的区别，不擅自改变级别或推断缺项', () => {
  for (const riskLevel of ['MEDIUM', 'HIGH', 'CRITICAL']) {
    const payload = trend(riskLevel);
    const original = structuredClone(payload);
    const parsed = parseTrend(payload, patientId);
    assert.equal(parsed.decisionCard.riskLevel, riskLevel);
    assert.equal(parsed.decisionCard.actionLevel, 'OBSERVE');
    assert.match(parsed.decisionCard.action, /仍有需关注的记录/);
    assert.match(parsed.decisionCard.action, /观察安排不代表指标正常/);
    assert.match(parsed.decisionCard.action, /明显不适.*已确认的家庭应急预案/);
    assert.doesNotMatch(parsed.decisionCard.action, /颜色|缺失|缺口|补测/);
    assert.deepEqual(payload, original);
  }
});

test('低风险或未知风险的观察文案不声称指标正常、数据齐全', () => {
  for (const riskLevel of ['LOW', undefined, 'UNKNOWN']) {
    const copy = observationActionCopy('OBSERVE', riskLevel);
    assert.match(copy.title, /按计划观察并继续记录/);
    assert.match(copy.action, /不代表指标正常/);
    assert.doesNotMatch(copy.action, /颜色|数据齐全|全部正常|仍有需关注的记录|缺口/);
  }
  assert.equal(observationActionCopy('UNKNOWN', 'HIGH'), null);
});

test('立即行动和复核继续保留服务端原文和行动级别', () => {
  for (const actionLevel of ['ACT_NOW', 'REVIEW']) {
    const payload = trend('HIGH', actionLevel);
    payload.decisionCard.title = '服务端具体行动';
    payload.decisionCard.action = '按已确认预案执行具体行动。';
    assert.deepEqual(parseTrend(payload, patientId).decisionCard, payload.decisionCard);
    assert.equal(observationActionCopy(actionLevel, 'HIGH'), null);
  }
});

test('首页高体温保留原始读数与记录时刻，不拿同步时刻代替或自行标红', async () => {
  installWx(path => path.endsWith('/trend') ? [200, { data: trend() }] : [404, {}], { session });
  const page = instantiate(home);
  await page.loadHomeSnapshot(session, page.actorLoadVersion);
  const snapshot = page.data.homeSnapshot;
  assert.equal(snapshot.temperatureSummary, '39.3 ℃');
  assert.equal(snapshot.temperatureRecordedAt, at(observedAt));
  assert.notEqual(snapshot.temperatureRecordedAt, at(asOf));
  assert.equal(snapshot.urgentCard.tone, 'normal');
  assert.match(snapshot.urgentCard.body, /观察安排不代表指标正常/);
  assert.ok(snapshot.temperatureTrend.every(point => !('level' in point)));
});

test('首页空体温不显示同步时间作为记录时间', async () => {
  const payload = trend('LOW');
  payload.series = [];
  installWx(path => path.endsWith('/trend') ? [200, { data: payload }] : [404, {}], { session });
  const page = instantiate(home);
  await page.loadHomeSnapshot(session, page.actorLoadVersion);
  assert.equal(page.data.homeSnapshot.temperatureRecordedAt, '');
  assert.deepEqual(page.data.homeSnapshot.temperatureTrend, []);
});

test('报告主行动卡和提醒使用同一观察措辞，颜色仍只由行动级别决定', async () => {
  installWx(path => {
    if (path.endsWith('/trend')) return [200, { data: trend() }];
    if (path.endsWith('/summary')) return [200, { data: { patientId, alerts: [{ riskLevel: 'MEDIUM', actionLevel: 'OBSERVE', title: '继续按计划观察' }] } }];
    return [404, {}];
  }, { session });
  const page = instantiate(report);
  page.onShow();
  await settle();
  assert.equal(page.data.error, '');
  const copy = observationActionCopy('OBSERVE', 'MEDIUM');
  assert.equal(page.data.report.actionTitle, copy.title);
  assert.equal(page.data.report.action, copy.action);
  assert.equal(page.data.report.riskTone, 'normal');
  assert.equal(page.data.report.alerts[0].title, copy.title);
  assert.equal(page.data.report.alerts[0].detail, copy.action);
  assert.equal(page.data.report.alerts[0].tone, 'normal');
});
