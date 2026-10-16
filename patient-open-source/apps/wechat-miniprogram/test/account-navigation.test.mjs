import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { capturePages, instantiate, installWx, loadPage, settle } from './helpers/wechat-runtime.mjs';

const registered = capturePages();
const dist = process.env.MAS_MINIPROGRAM_TEST_DIST ? pathToFileURL(`${process.env.MAS_MINIPROGRAM_TEST_DIST}/`) : new URL('../dist/', import.meta.url);
const accountPage = await loadPage(registered, new URL('pages/patient/account.js', dist).href);
const patientId = 'patient-1';
const baseSession = { accessToken: 'test-access', refreshToken: 'test-refresh', userId: 'user-1', actorIds: ['actor-1'], actorId: 'actor-1', patientId };
const keys = page => page.data.profileGroups.flatMap(group => group.entries.map(entry => entry.key));

async function load({ lifeStage, sex, role = 'PATIENT', summaryStatus = 200, birthDate, diseaseType }) {
  const environment = installWx(path => {
    if (path.endsWith('/summary')) return [summaryStatus, { data: { patientId, patientDisplayName: '演示患者', lifeStage, sex, birthDate, diseaseType, observationsCount: 2, alerts: [] } }];
    if (path.endsWith('/lifecycle')) return [200, { data: { patientId, status: 'ACTIVE', notifyContacts: [], version: 1 } }];
    return [404, {}];
  }, { session: { ...baseSession, role } });
  const page = instantiate(accountPage);
  page.onShow();
  assert.equal(keys(page).includes('school'), false, '档案尚未核对时不能先显示校园入口');
  await settle();
  return { ...environment, page };
}

test('成年男女档案隐藏校园入口，并保留健康、生活及各自适用功能', async () => {
  for (const sex of ['FEMALE', 'MALE']) {
    const { page, calls } = await load({ lifeStage: 'ADULT', sex });
    assert.equal(page.data.profileNotice, '');
    assert.equal(keys(page).includes('school'), false);
    for (const key of ['health', 'medication', 'screening', 'contacts', 'emergency', 'transition', 'life', 'work', 'more', 'inbox']) assert.ok(keys(page).includes(key), key);
    assert.ok(keys(page).includes(sex === 'FEMALE' ? 'pregnancy' : 'fertility'));
    page.openFeature({ currentTarget: { dataset: { key: 'school' } } });
    assert.equal(calls.navigations.length, 0, '隐藏入口也不能经旧点击事件进入');
  }
});

test('儿童与过渡期档案保留校园入口并进入既有页面', async () => {
  for (const example of [{ lifeStage: 'CHILD', sex: 'FEMALE', role: 'LEGAL_GUARDIAN' }, { lifeStage: 'TRANSITION', sex: 'MALE', role: 'PATIENT' }]) {
    const { page, calls } = await load(example);
    assert.ok(keys(page).includes('school'));
    assert.ok(keys(page).includes('transition'));
    assert.ok(keys(page).includes('life'));
    page.openFeature({ currentTarget: { dataset: { key: 'school' } } });
    assert.deepEqual(calls.navigations, [['navigateTo', '/pages/patient/school']]);
  }
});

test('档案读取失败时不猜测年龄，校园入口保持隐藏', async () => {
  const { page } = await load({ lifeStage: 'CHILD', sex: 'FEMALE', role: 'LEGAL_GUARDIAN', summaryStatus: 503 });
  assert.ok(page.data.profileNotice);
  assert.equal(keys(page).includes('school'), false);
  assert.ok(keys(page).includes('health'));
});


test('档案入口直达关节速记、独有化验监测和男性生育资料', async () => {
  const { page, calls } = await load({ lifeStage: 'ADULT', sex: 'MALE' });
  for (const key of ['joint', 'more', 'fertility', 'care', 'inbox']) page.openFeature({ currentTarget: { dataset: { key } } });
  assert.deepEqual(calls.navigations, [
    ['navigateTo', '/pages/patient/joint'],
    ['navigateTo', '/pages/patient/more'],
    ['navigateTo', '/pages/patient/more?section=fertility'],
    ['navigateTo', '/pages/patient/support'],
    ['navigateTo', '/pages/patient/inbox'],
  ]);
  const entries = page.data.profileGroups.flatMap(group => group.entries);
  assert.equal(entries.find(entry => entry.key === 'care').title, '照护与服务');
  assert.equal(entries.find(entry => entry.key === 'inbox').title, '系统通知');
});


test('个人档案按真实 sJIA 枚举展示诊断，并使用出生日期计算年龄', async () => {
  const { page } = await load({ lifeStage: 'CHILD', sex: 'MALE', role: 'LEGAL_GUARDIAN', birthDate: '2020-07-01', diseaseType: 'sJIA' });
  assert.equal(page.data.profileDiagnosis, '全身型幼年特发性关节炎（sJIA）');
  assert.match(page.data.profileAgeLabel, /^\d+岁(?:\d+月)?$/);
  assert.equal(page.data.profileMsScore, '', '没有MS数据时不伪造分值');
});


test('切换档案立即清除旧档案处置权限，读取失败也不保留撤回按钮', async () => {
  installWx(() => [503, {}], { session: { ...baseSession, role: 'PATIENT', patientId: 'patient-new' } });
  const page = instantiate(accountPage);
  page.setData({ scopeKey: 'previous-scope', lifecycle: { patientId: 'patient-old', status: 'DELETED_REQUESTED', version: 1 }, canCancel: true, canDelete: true, canMemorial: true });
  page.onShow();
  assert.equal(page.data.lifecycle, null);
  assert.equal(page.data.canCancel, false);
  assert.equal(page.data.canDelete, false);
  assert.equal(page.data.canMemorial, false);
  await settle();
  assert.equal(page.data.canCancel, false);
});
