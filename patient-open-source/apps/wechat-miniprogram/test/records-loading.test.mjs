import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { capturePages, instantiate, installWx, loadPage, settle } from './helpers/wechat-runtime.mjs';

const registered = capturePages();
const dist = process.env.MAS_MINIPROGRAM_TEST_DIST ? pathToFileURL(`${process.env.MAS_MINIPROGRAM_TEST_DIST}/`) : new URL('../dist/', import.meta.url);
const recordsPage = await loadPage(registered, new URL('pages/patient/records.js', dist).href);
const { Outbox, makeRecords } = await import(new URL('patient-records.js', dist).href);
const patientId = 'patient-sun';
const session = { accessToken: 'test-access', refreshToken: 'test-refresh', userId: 'user-caregiver', actorIds: ['actor-self@patient-sun'], actorId: 'actor-self@patient-sun', role: 'PATIENT', patientId };
const now = new Date().toISOString();
const future = new Date(Date.now() + 86400_000).toISOString();
const summary = { patientId, patientDisplayName: '孙晓雯', lifeStage: 'ADULT', observationsCount: 10, latestObservationAt: now, updatedAt: now, alerts: [] };
const observation = { id: 'observation-clinic', patientId, code: 'TEMP', display: '体温', valueNumeric: 36.5, unit: '℃', observedAt: now, recordedAt: now, source: 'CLINIC', recordedBy: 'actor-clinician@patient-sun', confidence: 'LOW' };
const medications = { patientId, plans: [{ id: 'plan-1', patientId, drug: '泼尼松' }], logs: [{ id: 'dose-1', patientId, planId: 'plan-1', takenAt: now, actualDose: 5, unit: 'mg' }] };
const screening = { patientId, visits: [{ id: 'visit-1', startsAt: future, expiresAt: future, status: 'AVAILABLE' }] };

async function load(overrides = {}) {
  installWx(path => {
    const resource = path.split('/').at(-1);
    if (Object.hasOwn(overrides, resource)) return overrides[resource];
    const data = { summary, 'observations?limit=20': { patientId, records: [observation] }, medications, 'psych-screening-form': screening }[resource];
    return data ? [200, { data }] : [404, { code: 'NOT_FOUND' }];
  }, { session });
  const page = instantiate(recordsPage);
  page.onShow();
  await settle();
  page.onUnload();
  return page;
}

test('记录页接受与线上接口一致的 CLINIC 来源，同时显示用药与筛查', async () => {
  const page = await load();
  assert.equal(page.data.loading, false);
  assert.equal(page.data.error, '');
  assert.equal(page.data.observationsNotice, '');
  assert.equal(page.data.recordCount, 10);
  assert.equal(page.data.records[0].source, 'CLINIC');
  assert.equal(page.data.recentRecords[0].sourceLabel, '医疗团队');
  assert.equal(page.data.temperature, '', '历史体温不得自动成为本次测量');
  assert.match(page.data.lastTemperatureLabel, /36.5 ℃/);
  assert.equal(page.data.stageReady, true);
  assert.equal(page.data.lifeStage, 'ADULT');
  assert.equal(page.data.medicationRecords[0].drug, '泼尼松');
  assert.equal(page.data.screeningReady, true);
  assert.equal(page.data.screeningStatus, '待完成');
});

test('历史体温只作带时间参考，儿童和成人未输入本次测量均不能保存', async () => {
  for (const lifeStage of ['CHILD', 'TRANSITION', 'ADULT']) {
    const page = await load({ summary: [200, { data: { ...summary, lifeStage } }] });
    let writes = 0;
    const originalRequest = wx.request;
    wx.request = options => { if (options.method === 'POST') writes += 1; return originalRequest(options); };
    assert.equal(page.data.temperature, '');
    assert.match(page.data.lastTemperatureLabel, /36.5 ℃/);
    assert.match(page.data.lastTemperatureLabel, /\d{2}:\d{2}/);
    await page.save();
    assert.equal(writes, 0);
    assert.match(page.data.error, /本次实测体温/);
  }
});

test('刷新只更新上次测量参考，不覆盖正在填写的温度', async () => {
  const older = { ...observation, id: 'older', valueNumeric: 38.5, observedAt: new Date(Date.now() - 86400_000).toISOString() };
  const page = await load({ 'observations?limit=20': [200, { data: { patientId, records: [older, observation] } }] });
  assert.match(page.data.lastTemperatureLabel, /^36.5 ℃/);
  page.setTemperature({ detail: { value: '37.2' } });
  await page.refresh(page.data.revision);
  assert.equal(page.data.temperature, '37.2');
  assert.match(page.data.lastTemperatureLabel, /^36.5 ℃/);
  page.onUnload();
});

test('保存本次体温后输入恢复为空，服务端刷新不把刚保存的数值再次填入', async () => {
  const page = await load();
  const originalRequest = wx.request;
  const writes = [];
  wx.request = options => {
    if (options.method !== 'POST') return originalRequest(options);
    writes.push(options.data);
    options.success({ statusCode: 201, data: { data: { observation: { id: 'new-record', ...options.data } } } });
    return { abort() {} };
  };
  page.setTemperature({ detail: { value: '37.2' } });
  await page.save();
  await settle();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].valueNumeric, 37.2);
  assert.equal(page.data.temperature, '');
  assert.match(page.data.message, /已确认 1 条/);
  page.onUnload();
});

test('收起症状保留跨组选项和已选摘要，未填写不显示为无症状', async () => {
  const page = await load();
  assert.equal(page.data.symptomsExpanded, false);
  assert.equal(page.data.symptomSummary, '未填写症状');
  page.toggleSymptoms();
  page.setSymptoms({ detail: { value: ['CNS', 'RASH'] } });
  page.toggleSymptoms();
  assert.equal(page.data.symptomsExpanded, false);
  assert.match(page.data.selectedUrgency, /需要立即急诊.*不要等待/);
  assert.deepEqual(page.data.selectedSymptoms, ['CNS', 'RASH']);
  assert.match(page.data.symptomSummary, /抽搐.*皮疹/);
  page.toggleSymptoms();
  assert.deepEqual(page.data.symptomGroups.flatMap(group => group.items.filter(item => item.selected).map(item => item.code)), ['CNS', 'RASH']);
});

test('展开历史按发生时间排序，重新进入立即清掉旧参考、历史和症状草稿', async () => {
  const records = [3, 1, 4, 2].map(index => ({ ...observation, id: `record-${index}`, observedAt: new Date(Date.now() - index * 3600_000).toISOString() }));
  const page = await load({ 'observations?limit=20': [200, { data: { patientId, records } }] });
  assert.deepEqual(page.data.historyRecords.map(item => item.id), ['record-1', 'record-2', 'record-3', 'record-4']);
  assert.equal(page.data.recentRecords.length, 3);
  page.toggleHistory();
  assert.equal(page.data.historyExpanded, true);
  page.setSymptoms({ detail: { value: ['RASH'] } });
  page.setTemperature({ detail: { value: '37.2' } });
  page.onShow();
  assert.equal(page.data.historyExpanded, false);
  assert.deepEqual(page.data.historyRecords, []);
  assert.equal(page.data.lastTemperatureLabel, '');
  assert.equal(page.data.temperature, '');
  assert.equal(page.data.symptomSummary, '未填写症状');
  await settle();
  page.onUnload();
});

test('最近记录中的数值与单位分隔，血小板科学计数单位可读且原值不变', async () => {
  const records = [
    observation,
    { ...observation, id: 'ferritin', code: 'FERRITIN', display: '铁蛋白', valueNumeric: 145, unit: 'ng/mL', source: 'LAB' },
    { ...observation, id: 'platelet', code: 'PLATELET', display: '血小板计数', valueNumeric: 260, unit: '10^9/L', source: 'LAB' },
  ];
  const page = await load({ 'observations?limit=20': [200, { data: { patientId, records } }] });
  assert.deepEqual(page.data.recentRecords.map(item => item.valueText), ['36.5 ℃', '145 ng/mL', '260 ×10⁹/L']);
  assert.deepEqual(page.data.records.map(item => [item.valueNumeric, item.unit]), [[36.5, '℃'], [145, 'ng/mL'], [260, '10^9/L']]);
});

test('查询来源只接受领域契约的五种来源，不把错误别名放行', async () => {
  for (const source of ['PATIENT_REPORTED', 'CAREGIVER_REPORTED', 'CLINIC', 'LAB', 'DEVICE']) {
    const page = await load({ 'observations?limit=20': [200, { data: { patientId, records: [{ ...observation, source }] } }] });
    assert.equal(page.data.records.length, 1, source);
  }
  for (const source of ['CLINICAL', 'SYSTEM', 'UNKNOWN']) {
    const page = await load({ 'observations?limit=20': [200, { data: { patientId, records: [{ ...observation, source }] } }] });
    assert.equal(page.data.records.length, 0, source);
    assert.match(page.data.observationsNotice, /响应格式无效/);
  }
});

test('记录格式错误或其他患者记录不会拖空已获授权的用药与筛查模块', async () => {
  for (const invalid of [{ ...observation, valueNumeric: '36.5' }, { ...observation, patientId: 'patient-other' }]) {
    const page = await load({ 'observations?limit=20': [200, { data: { patientId, records: [invalid] } }] });
    assert.equal(page.data.records.length, 0);
    assert.match(page.data.observationsNotice, /响应格式无效/);
    assert.equal(page.data.medicationRecords.length, 1);
    assert.equal(page.data.screeningReady, true);
    assert.equal(page.data.stageReady, true);
    assert.equal(page.data.loading, false);
  }
});

test('记录读取网络失败时独立提示，保留摘要、用药、筛查和复诊安排', async () => {
  const page = await load({ 'observations?limit=20': 'NETWORK' });
  assert.match(page.data.observationsNotice, /症状记录暂不可用/);
  assert.equal(page.data.recordCount, 10);
  assert.equal(page.data.medicationRecords.length, 1);
  assert.equal(page.data.screeningReady, true);
  assert.notEqual(page.data.followupLabel, '暂无已确认复诊日期');
});

test('摘要未核验时禁止新增症状，但不隐藏其他接口成功返回的内容', async () => {
  const page = await load({ summary: [200, { data: { ...summary, patientId: 'patient-other' } }] });
  assert.equal(page.data.stageReady, false);
  assert.match(page.data.error, /摘要响应格式无效/);
  assert.equal(page.data.records.length, 1);
  assert.equal(page.data.medicationRecords.length, 1);
  assert.equal(page.data.screeningReady, true);
});

test('用药接口错误不冒充无打卡记录，也不隐藏症状记录', async () => {
  const page = await load({ medications: [200, { data: { ...medications, patientId: 'patient-other' } }] });
  assert.equal(page.data.medicationRecords.length, 0);
  assert.match(page.data.medicationNotice, /暂不可用/);
  assert.equal(page.data.records.length, 1);
  assert.equal(page.data.screeningReady, true);
});

test('医生来源只用于读取，本人提交队列仍拒绝伪装为医生记录', () => {
  const storage = new Map();
  const outbox = new Outbox({ getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }, session.userId, session.actorId, patientId);
  const record = makeRecords(patientId, 36.5, [], 'PATIENT_REPORTED', now)[0];
  assert.throws(() => outbox.enqueue([{ ...record, source: 'CLINIC' }]), /待提交记录不属于当前患者/);
  assert.equal(outbox.entries().length, 0);
});

test('三组症状共享一个原生 checkbox-group，跨组选择与取消都保留其他组选项', async () => {
  const markup = await readFile(new URL('../src/pages/patient/observation.wxml', import.meta.url), 'utf8');
  assert.equal([...markup.matchAll(/<checkbox-group\b/g)].length, 1);
  assert.match(markup, /<checkbox-group bindchange="setSymptoms">\s*<block wx:for="\{\{symptomGroups\}\}"/);
  const page = await load();
  // 单个 checkbox-group 的 change 包含所有分组的已勾选 value。
  page.setSymptoms({ detail: { value: ['CNS'] } });
  page.setSymptoms({ detail: { value: ['CNS', 'LETHARGY'] } });
  page.setSymptoms({ detail: { value: ['CNS', 'LETHARGY', 'RASH'] } });
  assert.deepEqual(page.data.selectedSymptoms, ['CNS', 'LETHARGY', 'RASH']);
  assert.deepEqual(page.data.symptomGroups.flatMap(group => group.items.filter(item => item.selected).map(item => item.code)), ['CNS', 'LETHARGY', 'RASH']);
  page.setSymptoms({ detail: { value: ['LETHARGY', 'RASH'] } });
  const payloads = makeRecords(patientId, 36.5, page.data.selectedSymptoms, 'PATIENT_REPORTED', now);
  assert.deepEqual(payloads.filter(item => item.code.startsWith('SYMPTOM_')).map(item => item.valueCoded), ['LETHARGY', 'RASH']);
});


test('记录一级入口进入独立录入、复诊、评估与健康资料页面', async () => {
  const markup = await readFile(new URL('../src/pages/patient/records.wxml', import.meta.url), 'utf8');
  assert.doesNotMatch(markup, /<input|bindtap="save"/);
  for (const handler of ['openSymptomEntry', 'openMedicationEntry', 'openFollowupEntry', 'openAssessmentEntry', 'openVaccinationEntry', 'openDiaryEntry']) assert.match(markup, new RegExp(`bindtap="${handler}"`));
  const calls = [];
  globalThis.wx.navigateTo = ({ url }) => calls.push(url);
  const page = instantiate(recordsPage);
  page.openSymptomEntry(); page.openTemperatureEntry(); page.openFollowupEntry(); page.openAssessmentEntry(); page.openVaccinationEntry();
  assert.deepEqual(calls, ['/pages/patient/observation?mode=symptom', '/pages/patient/observation?mode=temperature', '/pages/patient/life-event?section=followup', '/pages/patient/screening', '/pages/patient/health?section=vaccination']);
});

test('症状速记不要求体温，也不会提交虚构体温', async () => {
  const page = await load();
  page.setData({ entryMode: 'symptom' });
  page.setSymptoms({ detail: { value: ['RASH', 'FEVER_HIGH'] } });
  const originalRequest = wx.request;
  const writes = [];
  wx.request = options => {
    if (options.method !== 'POST') return originalRequest(options);
    writes.push(options.data);
    options.success({ statusCode: 201, data: { data: { observation: { id: `new-${writes.length}`, ...options.data } } } });
    return { abort() {} };
  };
  await page.save(); await settle();
  assert.deepEqual(writes.map(item => item.code), ['SYMPTOM_RASH', 'SYMPTOM_FEVER_HIGH']);
  assert.equal(writes.some(item => item.code === 'TEMP'), false);
  assert.equal(writes.find(item => item.code === 'SYMPTOM_FEVER_HIGH')?.display, '持续高热');
  assert.match(page.data.message, /已确认 2 条/);
  page.onUnload();
});



test('上次测量保留原始华氏单位，不把历史值误标为摄氏度', async () => {
  for (const unit of ['°F', '℉']) {
    const page = await load({ 'observations?limit=20': [200, { data: { patientId, records: [{ ...observation, valueNumeric: 98.6, unit }] } }] });
    assert.match(page.data.lastTemperatureLabel, /^98.6 /);
    assert.doesNotMatch(page.data.lastTemperatureLabel, /℃/);
    assert.equal(page.data.temperature, '');
  }
});

test('重新读取按钮保留同档案的测量草稿、症状和急症提示', async () => {
  const page = await load({ 'observations?limit=20': [503, {}] });
  page.setTemperature({ detail: { value: '37.2' } });
  page.setSymptoms({ detail: { value: ['CNS', 'RASH'] } });
  page.load();
  await settle();
  assert.equal(page.data.temperature, '37.2');
  assert.deepEqual(page.data.selectedSymptoms, ['CNS', 'RASH']);
  assert.match(page.data.selectedUrgency, /需要立即急诊/);
  page.onUnload();
});
