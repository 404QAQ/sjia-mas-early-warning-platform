import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { capturePages, instantiate, installWx, loadPage } from './helpers/wechat-runtime.mjs';

const registered = capturePages();
const dist = process.env.MAS_MINIPROGRAM_TEST_DIST ? pathToFileURL(`${process.env.MAS_MINIPROGRAM_TEST_DIST}/`) : new URL('../dist/', import.meta.url);
const { displayUnit, formatMeasurement } = await import(new URL('measurement-format.js', dist).href);
const { buildSeries } = await import(new URL('pages/patient/visit-report.js', dist).href);
const { rowsOf } = await import(new URL('pages/patient/trend.js', dist).href);
const home = await loadPage(registered, new URL('pages/home/index.js', dist).href);
const patientId = 'patient-1';
const session = { accessToken: 'test-access', refreshToken: 'test-refresh', userId: 'user-1', actorIds: ['actor-1'], actorId: 'actor-1', role: 'PATIENT', patientId };
const instant = '2026-10-14T01:00:00.000Z';
const platelet = { code: 'PLATELET', display: '血小板计数', unit: '10^9/L', points: [{ at: '2026-10-13T01:00:00.000Z', value: 250, unit: '10^9/L', source: 'LAB' }, { at: instant, value: 260, unit: '10^9/L', source: 'LAB' }] };

test('单位显示只规范科学计数写法，不换算、四舍五入或丢失零值', () => {
  assert.equal(formatMeasurement(260, '10^9/L'), '260 ×10⁹/L');
  assert.equal(displayUnit('10*9/L'), '×10⁹/L');
  assert.equal(formatMeasurement(145.25, 'ng/mL'), '145.25 ng/mL');
  assert.equal(formatMeasurement(36.5, '°C'), '36.5 °C');
  assert.equal(formatMeasurement(0, 'mg'), '0 mg');
  assert.equal(formatMeasurement(12, ''), '12');
});

test('报告最新值与变化量使用可读单位，同时保留图表原始点值', () => {
  const original = structuredClone(platelet);
  const [series] = buildSeries([platelet]);
  assert.equal(series.latest, '260 ×10⁹/L');
  assert.equal(series.change, '+10.0 ×10⁹/L');
  assert.deepEqual(series.points.map(point => point.value), [250, 260]);
  assert.deepEqual(platelet, original);
});

test('趋势页使用同样的科学计数单位，解析后的原始单位仍保留', () => {
  const original = structuredClone(platelet);
  assert.equal(rowsOf({ series: [platelet] })[0].latest, '260 ×10⁹/L');
  assert.deepEqual(platelet, original);
});

test('首页检验单位与体温文字统一可读，不改写接口数值', async () => {
  const trend = { patientId, asOf: instant, series: [platelet, { code: 'TEMP', display: '体温', unit: '℃', points: [{ at: instant, value: 36.5, unit: '℃' }] }], narrative: [], decisionCard: { riskLevel: 'LOW', actionLevel: 'OBSERVE', title: '继续观察', action: '按计划记录' } };
  installWx(path => path.endsWith('/trend') ? [200, { data: trend }] : [404, {}], { session });
  const page = instantiate(home);
  await page.loadHomeSnapshot(session, page.actorLoadVersion);
  assert.equal(page.data.homeSnapshot.labFindings[0].value, '260');
  assert.equal(page.data.homeSnapshot.labFindings[0].unit, '×10⁹/L');
  assert.equal(page.data.homeSnapshot.temperatureTrend[0].value, '36.5 ℃');
  assert.equal(trend.series[0].points[1].value, 260);
  assert.equal(trend.series[0].unit, '10^9/L');
});
