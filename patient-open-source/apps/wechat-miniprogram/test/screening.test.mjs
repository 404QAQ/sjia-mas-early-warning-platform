import test from 'node:test';
import assert from 'node:assert/strict';

import { readFile } from 'node:fs/promises';
import { capturePages, instantiate, installWx, loadPage, settle } from './helpers/wechat-runtime.mjs';

// screening.ts 通过 Page 注册微信页面；测试在真实页面实例语义下调用事件处理器。
const registered = capturePages();
const pageOptions = await loadPage(registered, '../../dist/pages/patient/screening.js');

const options = [
  { label: '从未', value: 'NEVER' },
  { label: '有时', value: 'SOMETIMES' },
  { label: '经常', value: 'OFTEN' },
];

function pageWithAnswers() {
  const page = instantiate(pageOptions);
  page.data.answers = [
    { code: 'sleep', prompt: '最近睡眠如何？', options, selected: '', selectedLabel: '', selectedIndex: 0 },
    { code: 'support', prompt: '是否需要支持？', options, selected: '', selectedLabel: '', selectedIndex: 0 },
  ];
  return page;
}

test('微信 picker 返回数字下标时，复诊前问卷保存答案编码和展示文案', () => {
  const page = pageWithAnswers();

  page.selectAnswer({ currentTarget: { dataset: { code: 'sleep' } }, detail: { value: 1 } });

  assert.equal(page.data.answers[0].selected, 'SOMETIMES');
  assert.equal(page.data.answers[0].selectedLabel, '有时');
  assert.equal(page.data.answers[1].selected, '');
});

test('微信 picker 的数字字符串下标也能保存答案，修改选择同步显示', () => {
  const page = pageWithAnswers();

  page.selectAnswer({ currentTarget: { dataset: { code: 'sleep' } }, detail: { value: '1' } });
  assert.equal(page.data.answers[0].selected, 'SOMETIMES');
  page.selectAnswer({ currentTarget: { dataset: { code: 'sleep' } }, detail: { value: '2' } });
  assert.equal(page.data.answers[0].selected, 'OFTEN');
  assert.equal(page.data.answers[0].selectedLabel, '经常');
  assert.equal(page.data.answers[0].selectedIndex, 2);
});

test('picker 下标越界或不属于当前题目时，不会伪造已选答案', () => {
  const page = pageWithAnswers();

  for (const value of [99, -1, 0.5, '', 'UNKNOWN', 'OFTEN', null, true, Number.NaN, Number.POSITIVE_INFINITY]) {
    page.selectAnswer({ currentTarget: { dataset: { code: 'sleep' } }, detail: { value } });
  }
  page.selectAnswer({ currentTarget: { dataset: { code: 'unknown-question' } }, detail: { value: 0 } });

  assert.equal(page.data.answers[0].selected, '');
  assert.equal(page.data.answers[0].selectedLabel, '');
  assert.equal(page.data.answers[1].selected, '');
});

test('选中第一个选项是有效回答，不会被当成空选择', () => {
  const page = pageWithAnswers();

  page.selectAnswer({ currentTarget: { dataset: { code: 'support' } }, detail: { value: '0' } });

  assert.equal(page.data.answers[1].selected, 'NEVER');
  assert.equal(page.data.answers[1].selectedLabel, '从未');
});

const session = { accessToken: 'test-access', refreshToken: 'test-refresh', userId: 'user-1', actorIds: ['self-1'], actorId: 'self-1', role: 'PATIENT', patientId: 'patient-1' };
function screeningForm(submitted = false) {
  return {
    patientId: session.patientId, questionnaireVersion: 1, frequency: 'PER_VISIT', respondentRelation: 'SELF',
    title: '复诊前事项', intro: '填写最近的状态，也可以选择不想回答。',
    questions: [{ code: 'SLEEP', prompt: '最近是否难以入睡？' }, { code: 'MOOD', prompt: '最近是否感到低落？' }],
    visits: [{ id: 'visit-1', startsAt: new Date(Date.now() + 3600000).toISOString(), expiresAt: new Date(Date.now() + 7200000).toISOString(), status: submitted ? 'SUBMITTED' : 'AVAILABLE' }],
  };
}

test('题目选项按困扰或支持语义展示，沿用既有编码并允许拒答', async () => {
  const questions = ['SELF_SLEEP', 'SELF_ENERGY', 'SELF_LOW_MOOD', 'CAREGIVER_SUPPORT', 'SELF_HARM'].map(code => ({ code, prompt: code }));
  installWx(path => path.endsWith('/psych-screening-form')
    ? [200, { data: { ...screeningForm(), questions } }] : [404, {}], { session });
  const page = instantiate(pageOptions);
  page.onLoad();
  await settle();
  assert.deepEqual(page.data.answers.map(answer => answer.options[0].label), ['没有睡眠困扰', '精力充足', '状态平稳', '没有人能帮忙', '从未']);
  for (const answer of page.data.answers) {
    assert.deepEqual(answer.options.map(option => option.value), ['NEVER', 'SOMETIMES', 'OFTEN', 'ALWAYS', 'DECLINED']);
  }
});

test('问卷完整流程：加载后逐题选择，拒答不携带答案值，提交刷新后保留成功提示', async () => {
  let submitted = false;
  const { calls } = installWx((path, request) => {
    if (path.endsWith('/psych-screening-form')) return [200, { data: screeningForm(submitted) }];
    if (path.endsWith('/psych-screenings') && request.method === 'POST') {
      submitted = true;
      return [201, { data: { created: true, screening: { patientId: session.patientId, visitId: 'visit-1', crisisSupportRequired: false } } }];
    }
    return [404, { message: 'unexpected request' }];
  }, { session });
  const page = instantiate(pageOptions);
  page.onLoad();
  await settle();
  assert.equal(page.data.answers.length, 2);

  page.submit();
  assert.match(page.data.error, /请逐题选择/);
  assert.equal(calls.requests.filter(request => request.method === 'POST').length, 0);

  page.selectAnswer({ currentTarget: { dataset: { code: 'SLEEP' } }, detail: { value: '1' } });
  page.selectAnswer({ currentTarget: { dataset: { code: 'MOOD' } }, detail: { value: '4' } });
  page.submit();
  await settle();

  const posted = calls.requests.filter(request => request.method === 'POST');
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].data.answers, [
    { code: 'SLEEP', status: 'ANSWERED', valueCoded: 'SOMETIMES' },
    { code: 'MOOD', status: 'DECLINED' },
  ]);
  assert.equal(posted[0].data.visitId, 'visit-1');
  assert.equal(posted[0].data.questionnaireVersion, 1);
  assert.equal(page.data.pendingCount, 0);
  assert.equal(page.data.visit, null);
  assert.equal(page.data.notice, '复诊前事项已记录；这不代表医生已经查看或接手。');
});

test('提交后只显示下一步安排，选择时段不暴露量表字段', async () => {
  const slot = { id: 'slot-1', startsAt: '2026-10-15T09:00:00.000Z', endsAt: '2026-10-15T09:30:00.000Z', department: '支持门诊', clinicianName: '张医生' };
  const { calls } = installWx((path, request) => {
    if (path.endsWith('/psych-screening-form')) return [200, { data: screeningForm(false) }];
    if (path.endsWith('/psych-screenings/screening-1/response')) return [200, { data: { screeningId: 'screening-1', referral: { status: 'OFFERED', offeredSlots: [slot] } } }];
    if (path.endsWith('/psych-screenings/screening-1/referral') && request.method === 'POST') return [201, { data: { created: true, response: { screeningId: 'screening-1', referral: { status: 'ACCEPTED_PENDING_BOOKING', offeredSlots: [slot], selectedSlotId: 'slot-1' } } } }];
    return [404, {}];
  }, { session });
  const page = instantiate(pageOptions);
  page.onLoad();
  await settle();
  page.loadNextStep('screening-1');
  await settle();
  assert.equal(page.data.nextStep.status, 'OFFERED');
  assert.equal(page.data.nextStep.slots[0].id, 'slot-1');
  page.chooseReferral({ currentTarget: { dataset: { id: 'slot-1' } } });
  await settle();
  assert.equal(page.data.nextStep.status, 'ACCEPTED_PENDING_BOOKING');
  assert.equal(page.data.nextStep.selectedSlotId, 'slot-1');
  assert.match(page.data.notice, /最终预约仍需照护团队确认/);
  assert.equal(calls.requests.filter(item => item.method === 'POST').length, 1);
});

test('缺题提示保留问卷可见，患者可以继续选择', async () => {
  const markup = await readFile(new URL('../src/pages/patient/screening.wxml', import.meta.url), 'utf8');
  assert.match(markup, /<block wx:if="\{\{!loading && form\}\}">/);
  assert.doesNotMatch(markup, /<block wx:elif="\{\{form\}\}">/);
});

test('问卷页回到前台发现身份已切换时，立即清除上一患者题面并重新读取', async () => {
  const first = { ...session };
  const second = { ...session, userId: 'user-2', actorId: 'self-2', actorIds: ['self-2'], patientId: 'patient-2' };
  let current = first;
  const { storage } = installWx((path) => path.endsWith('/psych-screening-form') ? [200, { data: { ...screeningForm(false), patientId: current.patientId } }] : [404, {}], { session: current });
  const page = instantiate(pageOptions);
  page.onLoad();
  await settle();
  assert.equal(page.data.form?.patientId, 'patient-1');
  current = second;
  storage.set('mas.wechat.session.v1', structuredClone(second));
  page.onShow();
  assert.equal(page.data.form, null);
  assert.equal(page.data.answers.length, 0);
  await settle();
  assert.equal(page.data.form?.patientId, 'patient-2');
});
