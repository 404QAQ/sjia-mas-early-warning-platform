import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { capturePages, instantiate, installWx, loadPage, settle, SESSION_KEY } from './helpers/wechat-runtime.mjs';

const registered = capturePages();
const dist = process.env.MAS_MINIPROGRAM_TEST_DIST ? pathToFileURL(`${process.env.MAS_MINIPROGRAM_TEST_DIST}/`) : new URL('../dist/', import.meta.url);
const reportPage = await loadPage(registered, new URL('pages/patient/visit-report.js', dist).href);
const patientId = 'patient-sun';
const session = { accessToken: 'test-access', refreshToken: 'test-refresh', userId: 'user-1', actorIds: ['actor-1'], actorId: 'actor-1', role: 'PATIENT', patientId };
const now = new Date().toISOString();
const future = new Date(Date.now() + 86400_000).toISOString();
const past = new Date(Date.now() - 86400_000).toISOString();
const visit = (status, extra = {}) => ({ id: 'visit-1', startsAt: future, expiresAt: future, status, ...extra });
const summary = { patientId, patientDisplayName: '孙晓雯', observationsCount: 10, alerts: [] };
const trend = { patientId, asOf: now, series: [{ code: 'TEMP', display: '体温', unit: '℃', points: [{ at: now, value: 36.7, unit: '℃' }] }], narrative: ['体温最近记录为 36.7，目前大致稳定。'], decisionCard: { actionLevel: 'OBSERVE', title: '按计划观察', action: '按计划记录' } };
const reply = (path, form, trendValue = trend) => {
  if (path.endsWith('/psych-screening-form')) return form;
  if (path.endsWith('/summary')) return [200, { data: summary }];
  if (path.endsWith('/trend')) return [200, { data: trendValue }];
  if (path.endsWith('/medications')) return [200, { data: { patientId, plans: [] } }];
  return [404, {}];
};
const form = visits => [200, { data: { patientId, visits } }];

test('复诊摘要采用当前减量阶段剂量，未来安排不冒充正在服用', async () => {
  const medications = [{ id: 'taper', drug: '示例激素', dose: 20, unit: 'mg', source: 'CLINICIAN', status: 'ACTIVE', startedAt: '2026-01-01T00:00:00.000Z', schedule: [{ effectiveFrom: '2026-01-01T00:00:00.000Z', plannedDose: 20 }, { effectiveFrom: '2026-02-01T00:00:00.000Z', plannedDose: 5 }] }, { id: 'future', drug: '未来安排', dose: 10, unit: 'mg', status: 'ACTIVE', startedAt: '2099-01-01T00:00:00.000Z', schedule: [{ effectiveFrom: '2099-01-01T00:00:00.000Z', plannedDose: 10 }] }];
  installWx(path => path.endsWith('/medications') ? [200, { data: { patientId, asOf: now, plans: medications } }] : reply(path, form([])), { session });
  const page = instantiate(reportPage); page.onShow(); await settle();
  assert.match(page.data.report.medications[0].detail, /5 mg/);
  assert.doesNotMatch(page.data.report.medications[0].detail, /20/);
  assert.equal(page.data.report.medications[1].status, '尚未开始');
});

test('复诊摘要当前用量排除已停止的医生计划和自记历史，接口失败回退同样排除', async () => {
  const plans = [
    { drug: '医生已停止', dose: 5, unit: 'mg', source: 'CLINICIAN', status: 'STOPPED' },
    { drug: '已接续自记', dose: 5, unit: 'mg', source: 'PATIENT_REPORTED', status: 'STOPPED', reviewedPlanId: 'next' },
    { drug: '当前医生计划', dose: 4, unit: 'mg', source: 'CLINICIAN', status: 'ACTIVE' },
  ];
  for (const unavailable of [false, true]) {
    installWx(path => {
      if (path.endsWith('/medications')) return unavailable ? [503, {}] : [200, { data: { patientId, asOf: now, plans } }];
      if (path.endsWith('/visit-summary')) return [200, { data: { patientId, medications: plans } }];
      return reply(path, form([]));
    }, { session });
    const page = instantiate(reportPage); page.onShow(); await settle();
    assert.deepEqual(page.data.report.medications.map(item => item.name), ['当前医生计划']);
  }
});
async function load(formReply, trendValue = trend) {
  const environment = installWx(path => reply(path, formReply, trendValue), { session });
  const page = instantiate(reportPage);
  page.onShow();
  await settle();
  assert.equal(page.data.loading, false);
  assert.equal(page.data.error, '');
  return { page, ...environment };
}

test('已提交问卷的报告显示已完成并可查看，不再要求去填写', async () => {
  const { page, calls } = await load(form([visit('SUBMITTED')]));
  assert.equal(page.data.report.screening.state, 'SUBMITTED');
  assert.match(page.data.report.screening.title, /已完成/);
  assert.match(page.data.report.screening.detail, /本次已提交/);
  assert.equal(page.data.report.screening.buttonText, '查看');
  assert.ok(calls.requests.some(item => item.path === `/api/v1/patients/${patientId}/psych-screening-form`));
  page.openScreening();
  assert.deepEqual(calls.navigations, [['navigateTo', '/pages/patient/screening']]);
});

test('当前仍有开放窗口时显示待填，不能被历史已提交窗口覆盖', async () => {
  const { page } = await load(form([visit('SUBMITTED', { id: 'previous-visit', startsAt: past, expiresAt: past }), visit('AVAILABLE')]));
  assert.equal(page.data.report.screening.state, 'AVAILABLE');
  assert.equal(page.data.report.screening.buttonText, '去填写');
  assert.doesNotMatch(page.data.report.screening.title, /已完成/);
});

test('未开放与过期窗口不会误导为可填写', async () => {
  for (const visits of [[], [visit('PENDING')], [visit('EXPIRED')], [visit('AVAILABLE', { expiresAt: past })]]) {
    const { page } = await load(form(visits));
    assert.equal(page.data.report.screening.state, 'UNAVAILABLE');
    assert.equal(page.data.report.screening.buttonText, '查看');
    assert.match(page.data.report.screening.detail, /没有开放/);
  }
});

test('问卷网络错误、其他患者或畸形状态只显示未确认，不拖空报告或冒充待填', async () => {
  for (const invalid of ['NETWORK', [503, {}], [200, { data: { patientId: 'other-patient', visits: [visit('SUBMITTED')] } }], form([visit('WRONG')]), form([visit('AVAILABLE', { expiresAt: 'invalid' })])]) {
    const { page } = await load(invalid);
    assert.equal(page.data.report.patientName, '孙晓雯');
    assert.equal(page.data.report.screening.state, 'UNCONFIRMED');
    assert.equal(page.data.report.screening.buttonText, '查看');
    assert.match(page.data.report.screening.detail, /暂未确认/);
  }
});

test('从问卷返回报告时重新读取完成状态', async () => {
  let state = 'AVAILABLE';
  installWx(path => reply(path, form([visit(state)])), { session });
  const page = instantiate(reportPage);
  page.onShow(); await settle();
  assert.equal(page.data.report.screening.state, 'AVAILABLE');
  state = 'SUBMITTED';
  page.onShow(); await settle();
  assert.equal(page.data.report.screening.state, 'SUBMITTED');
  assert.equal(page.data.report.screening.buttonText, '查看');
});

test('身份切换后旧患者问卷迟到回包不能写进新患者报告', async () => {
  let release;
  const late = new Promise(resolve => { release = resolve; });
  const { storage } = installWx(path => {
    if (path.includes('/patient-other/')) {
      if (path.endsWith('/summary')) return [200, { data: { ...summary, patientId: 'patient-other', patientDisplayName: '第二位患者' } }];
      if (path.endsWith('/psych-screening-form')) return [200, { data: { patientId: 'patient-other', visits: [] } }];
      return [404, {}];
    }
    if (path.endsWith('/psych-screening-form')) return late;
    return reply(path, form([visit('SUBMITTED')]));
  }, { session });
  const page = instantiate(reportPage);
  page.onShow(); await settle(2);
  storage.set(SESSION_KEY, { ...session, actorIds: ['actor-2'], actorId: 'actor-2', patientId: 'patient-other' });
  page.onShow(); await settle();
  assert.equal(page.data.report.patientName, '第二位患者');
  release(form([visit('SUBMITTED')]));
  await settle();
  assert.equal(page.data.report.patientName, '第二位患者');
  assert.equal(page.data.report.screening.state, 'UNAVAILABLE');
});

test('摘要仅按同一趋势的数值与单位补齐显示，不重复单位或改写其他数值', async () => {
  const original = structuredClone(trend);
  const { page } = await load(form([visit('SUBMITTED')]));
  assert.equal(page.data.report.narrative[0], '体温最近记录为 36.7 ℃，目前大致稳定。');
  assert.deepEqual(trend, original);
  const lines = ['体温最近记录为 36.7 ℃，目前大致稳定。', '体温最近记录为 36.78，目前大致稳定。', '体温最近记录为 36.7'];
  const result = await load(form([]), { ...trend, narrative: lines });
  assert.deepEqual(result.page.data.report.narrative, [lines[0], lines[1], '体温最近记录为 36.7 ℃']);
});

test('趋势无法读取时保留原复诊摘要，不凭文案推测测量单位', async () => {
  installWx(path => {
    if (path.endsWith('/trend')) return 'NETWORK';
    if (path.endsWith('/visit-summary')) return [200, { data: { patientId, trend: { narrative: ['体温最近记录为 36.7，目前大致稳定。'] } } }];
    return reply(path, form([]));
  }, { session });
  const page = instantiate(reportPage);
  page.onShow(); await settle();
  assert.equal(page.data.report.narrative[0], '体温最近记录为 36.7，目前大致稳定。');
});


test('复诊报告区分医生计划和自行录入来源，并保留用量与医嘱出处', async () => {
  installWx(path => {
    if (path.endsWith('/medications')) return [200, { data: { patientId, plans: [
      { drug: '示例药甲', dose: 5, unit: 'mg', route: 'ORAL', frequency: 'DAILY', status: 'ACTIVE' },
      { drug: '示例药乙', dose: 10, unit: 'mg', route: 'ORAL', frequency: 'WEEKLY', status: 'ACTIVE', source: 'PATIENT_REPORTED', prescriptionNote: '外院复诊处方', version: 1 },
    ] } }];
    return reply(path, form([]));
  }, { session });
  const page = instantiate(reportPage);
  page.onShow(); await settle();
  assert.equal(page.data.report.medications[0].sourceLabel, '医生计划');
  assert.equal(page.data.report.medications[1].sourceLabel, '自行录入 · 待核对');
  assert.match(page.data.report.medications[1].detail, /10 mg/);
  assert.equal(page.data.report.medications[1].prescriptionNote, '外院复诊处方');
});


test('报告把用药读取失败与真正空计划分开，不用旧复诊摘要覆盖已确认的空列表', async () => {
  for (const unavailable of [true, false]) {
    installWx(path => {
      if (path.endsWith('/medications')) return unavailable ? [503, {}] : [200, { data: { patientId, plans: [] } }];
      if (path.endsWith('/visit-summary')) return [200, { data: { patientId, medications: [{ drug: '旧摘要中的药', status: 'ACTIVE' }] } }];
      return reply(path, form([]));
    }, { session });
    const page = instantiate(reportPage);
    page.onShow(); await settle();
    if (unavailable) {
      assert.equal(page.data.report.medications.length, 1);
      assert.match(page.data.report.medicationsNotice, /详情暂不可用.*复诊摘要/);
    } else {
      assert.deepEqual(page.data.report.medications, []);
      assert.equal(page.data.report.medicationsNotice, '');
    }
  }
});

test('报告明确整理时间和测量时间，症状摘录仅使用有效的近期症状记录', async () => {
  const measuredAt = '2026-10-12T01:20:00.000Z';
  installWx(path => {
    if (path.endsWith('/trend')) return [200, { data: { ...trend, asOf: '2026-10-14T03:40:00.000Z', series: [{ code: 'TEMP', display: '体温', unit: '℃', points: [{ at: measuredAt, value: 36.7, unit: '℃' }] }] } }];
    if (path.endsWith('/visit-summary')) return [200, { data: { patientId, recentRecords: [
      { code: 'SYMPTOM_RASH', display: 'SYMPTOM_RASH', at: measuredAt, source: 'CAREGIVER_REPORTED' },
      { code: 'TEMP', display: '体温', at: measuredAt, source: 'PATIENT_REPORTED' },
      { code: 'SYMPTOM_GI', display: '腹痛或呕吐', at: 'invalid', source: 'PATIENT_REPORTED' },
    ] } }];
    return reply(path, form([]));
  }, { session });
  const page = instantiate(reportPage); page.onShow(); await settle();
  assert.match(page.data.report.asOfText, /2026\/10\/14.*11:40/);
  assert.match(page.data.report.series[0].latestAt, /2026\/10\/12.*09:20/);
  assert.deepEqual(page.data.report.symptoms.map(item => item.display), ['新发或加重的皮疹']);
  assert.equal(page.data.report.symptoms[0].sourceLabel, '家属代录');
  assert.match(page.data.report.symptoms[0].atText, /2026\/10\/12.*09:20/);
  assert.match(page.data.report.symptomsNotice, /最近.*记录/);
});

test('报告将趋势读取失败、空指标与未读到症状区分，不用缺失数据表示正常', async () => {
  for (const unavailable of [true, false]) {
    installWx(path => {
      if (path.endsWith('/trend')) return unavailable ? [503, {}] : [200, { data: { ...trend, series: [] } }];
      if (path.endsWith('/visit-summary')) return unavailable ? [503, {}] : [200, { data: { patientId, recentRecords: [] } }];
      return reply(path, form([]));
    }, { session });
    const page = instantiate(reportPage); page.onShow(); await settle();
    assert.deepEqual(page.data.report.series, []);
    assert.deepEqual(page.data.report.symptoms, []);
    assert.equal(page.data.report.trendUnavailable, unavailable);
    assert.match(page.data.report.seriesNotice, unavailable ? /暂不可用/ : /暂无.*指标记录/);
    assert.match(page.data.report.symptomsNotice, unavailable ? /暂未读到/ : /未记录不代表没有症状/);
  }
});

test('报告急诊入口沿用现有急诊摘要页', async () => {
  const { page, calls } = await load(form([]));
  page.openEmergency();
  assert.deepEqual(calls.navigations, [['navigateTo', '/pages/patient/emergency']]);
});
