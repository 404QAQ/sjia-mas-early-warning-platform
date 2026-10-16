import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { capturePages, instantiate, installWx, settle } from './helpers/wechat-runtime.mjs';

const registered = capturePages();
const dist = process.env.MAS_MINIPROGRAM_TEST_DIST ? pathToFileURL(`${process.env.MAS_MINIPROGRAM_TEST_DIST}/`) : new URL('../dist/', import.meta.url);
const { parseMonitoringIntensity } = await import(new URL('pages/patient/more.js', dist).href);
const morePage = registered.at(-1);

test('更多健康资料页面仅展示只读投影，不把医护内部转介内容直接渲染给小程序', async () => {
  const markup = await readFile(new URL('../src/pages/patient/more.wxml', import.meta.url), 'utf8');
  assert.match(markup, /当前身份无权查看/);
  assert.doesNotMatch(markup, /targetClinician|referralDocRef|notReferredReason/);
  assert.doesNotMatch(markup, /bindsubmit|form-type="submit"/);
});

test('监测强度患者投影允许有界历史并拒绝跨患者/超界响应', () => {
  const now = new Date().toISOString();
  const history = Array.from({ length: 100 }, (_, index) => ({
    ...(index ? { from: 'STANDARD' } : {}),
    to: 'STANDARD', reason: `第 ${index + 1} 次`, at: now,
  }));
  assert.match(parseMonitoringIntensity({ patientId: 'p1', intensity: 'STANDARD', setAt: now, reason: '当前', version: 101, history }, 'p1').join('\n'), /已有 100 次/);
  assert.throws(() => parseMonitoringIntensity({ patientId: 'p2', intensity: 'STANDARD', setAt: now, reason: '当前', version: 101, history }, 'p1'), /响应格式无效/);
  assert.throws(() => parseMonitoringIntensity({ patientId: 'p1', intensity: 'STANDARD', setAt: now, reason: '当前', version: 100, history: [...history, history[0]] }, 'p1'), /响应格式无效/);
});

test('补充资料保留化验与男性生育，独立页面内容不再重复读取', async () => {
  const patientId = 'patient-test';
  const now = new Date().toISOString();
  const session = { accessToken: 'test-access', refreshToken: 'test-refresh', userId: 'user-test', actorIds: ['actor-self@test'], actorId: 'actor-self@test', role: 'PATIENT', patientId };
  const records = [{ id: 'lab-test', patientId, code: 'FERRITIN', display: '铁蛋白', valueNumeric: 145, unit: 'ng/mL', observedAt: now, recordedAt: now, source: 'LAB', recordedBy: 'actor-clinician@patient-test' }];
  const originalRecords = structuredClone(records);
  const { calls } = installWx(path => {
    const resource = path.split('/').at(-1);
    const data = {
      summary: { patientId, sex: 'MALE', lifeStage: 'ADULT' },
      'observations?source=LAB&limit=100': { patientId, records },
      'fertility-content': { patientId, sex: 'MALE', mode: 'FERTILITY', title: '男性生育与用药关注', intro: '复诊时核对现有医嘱。', sections: [], affectedMedications: [] },
    }[resource];
    return data ? [200, { data }] : [404, { code: 'NOT_FOUND' }];
  }, { session });
  const page = instantiate(morePage);
  page.onShow();
  await settle();
  page.onUnload();
  assert.equal(page.data.loading, false);
  const lines = key => {
    const section = page.data.sections.find(item => item.key === key);
    assert.equal(section.state, 'READY');
    return section.items.join('\n');
  };
  assert.match(lines('labs'), /铁蛋白：145 ng\/mL · 发生 .+ · 录入 /);
  assert.doesNotMatch(lines('labs'), /actor-|patient-test|记录人/);
  assert.deepEqual(records, originalRecords);
  assert.match(lines('fertility'), /男性生育与用药关注/);
  assert.deepEqual(page.data.sections.map(item => item.key), ['labs', 'monitoring', 'remission', 'fertility']);
  assert.ok(calls.requests.some(item => item.path.endsWith('/fertility-content')));
  for (const endpoint of ['joint-assessments', 'transition-milestones', 'transition-plan', 'pregnancy-status', 'pregnancy-questions', 'life-events', 'work-support']) {
    assert.equal(calls.requests.some(item => item.path.endsWith(`/${endpoint}`)), false, endpoint);
  }
});
