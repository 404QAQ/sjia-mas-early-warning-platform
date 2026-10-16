import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { capturePages, instantiate, installWx, loadPage, settle } from './helpers/wechat-runtime.mjs';

const registered = capturePages();
const dist = process.env.MAS_MINIPROGRAM_TEST_DIST ? pathToFileURL(`${process.env.MAS_MINIPROGRAM_TEST_DIST}/`) : new URL('../dist/', import.meta.url);
const healthOptions = await loadPage(registered, new URL('pages/patient/health.js', dist).href);
const schoolOptions = await loadPage(registered, new URL('pages/patient/school.js', dist).href);
const school = await import(new URL('pages/patient/school.js', dist).href);
const patientId = 'patient-presentation';
const session = { accessToken: 'a', refreshToken: 'r', userId: 'u', actorIds: ['actor'], actorId: 'actor', patientId, role: 'PATIENT' };
const instant = '2026-10-13T18:30:00.000Z';

function vaccination(status) {
  return { patientId, asOf: instant, liveAttenuated: { classification: 'BLOCKED', blocked: true, vaccines: ['麻疹', '水痘'] }, inactivated: [], householdMembers: [], records: [{ id: 'v1', patientId, vaccine: '流感疫苗', administeredAt: instant, facility: '接种门诊', source: 'PATIENT', recordedAt: instant }], annualInfluenza: { vaccine: 'INFLUENZA', localYear: 2026, status, window: { from: '2026-09-01', to: '2026-10-31', reminderFrom: '2026-08-01' } } };
}

test('健康资料将状态、日期和家族史翻译为可读内容，保存用的原始值不改变', async () => {
  installWx(path => {
    if (path.endsWith('/vaccinations')) return [200, { data: vaccination('WINDOW_OPEN') }];
    if (path.endsWith('/family-history')) return [200, { data: { patientId, declined: false, siblings: [], familyAutoimmune: ['RHEUMATOID_ARTHRITIS'], version: 1, updatedAt: instant } }];
    if (path.includes('/private-diary')) return [200, { data: { entries: [], revision: 0 } }];
    return [404, {}];
  }, { session });
  const page = instantiate(healthOptions);
  page.onShow();
  await settle();
  assert.equal(page.data.error, '');
  assert.equal(page.data.vaccination.annualInfluenza.statusLabel, '处于建议接种时段');
  assert.equal(page.data.vaccination.annualInfluenza.status, 'WINDOW_OPEN');
  assert.equal(page.data.vaccination.liveAttenuated.vaccinesText, '麻疹、水痘');
  assert.match(page.data.vaccination.records[0].dateText, /2026\/10\/14/);
  assert.equal(page.data.vaccination.records[0].administeredAt, instant);
  assert.deepEqual(page.data.family.familyLabels, ['类风湿关节炎']);
  assert.deepEqual(page.data.family.familyAutoimmune, ['RHEUMATOID_ARTHRITIS']);
  page.chooseMood({ currentTarget: { dataset: { mood: 'LOW_ENERGY' } } });
  assert.equal(page.data.selectedMoodLabel, '没力气');
  assert.equal(page.data.selectedMood, 'LOW_ENERGY');
  page.diaryInput({ detail: { value: '今天想记下的事' } });
  assert.equal(page.data.selectedMoodLabel, '');
});

test('未知流感状态按待核对展示，不暴露内部值或误报已接种', async () => {
  installWx(path => {
    if (path.endsWith('/vaccinations')) return [200, { data: vaccination('__proto__') }];
    if (path.endsWith('/family-history')) return [200, { data: { patientId, declined: false, siblings: [], familyAutoimmune: [], version: 0 } }];
    if (path.includes('/private-diary')) return [200, { data: { entries: [], revision: 0 } }];
    return [404, {}];
  }, { session });
  const page = instantiate(healthOptions);
  page.onShow();
  await settle();
  assert.equal(page.data.vaccination.annualInfluenza.statusLabel, '待医生核对');
});

function schoolView(recipients) {
  return { disclosure: { patientId, term: '2026-S2', recipients, peArrangement: 'LIMITED', schoolEmergencyContact: { name: '李女士', relation: '母亲', phoneMasked: '138****1234', authorized: true }, version: 1 }, contentVersion: 'L-01-v1', guidance: '按接收对象设置告知范围。', emergencyShareBoundary: { directShare: false, visibility: 'G2_SUMMARY' } };
}

test('校园勾选仅更新草稿，保存按钮提交当前选择且预览只用已保存设置', async () => {
  let savedRecipients = [{ role: 'HEAD_TEACHER', level: 'ESSENTIAL' }];
  const { calls } = installWx((path, options) => {
    if (path.endsWith('/school-disclosure')) {
      if (options.method === 'POST') savedRecipients = options.data.recipients;
      return [200, { data: schoolView(savedRecipients) }];
    }
    return [404, {}];
  }, { session: { ...session, role: 'LEGAL_GUARDIAN' } });
  const page = instantiate(schoolOptions);
  page.onShow();
  await settle();
  page.changeRecipients({ detail: { value: ['SCHOOL_NURSE'] } });
  assert.equal(calls.requests.filter(call => call.method === 'POST').length, 0);
  assert.equal(page.data.communicationNotes[0].role, 'HEAD_TEACHER');
  page.saveSettings({ type: 'tap', detail: {} });
  await settle();
  const writes = calls.requests.filter(call => call.method === 'POST');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].data.recipients, [{ role: 'SCHOOL_NURSE', level: 'ESSENTIAL' }]);
  assert.equal(page.data.communicationNotes[0].role, 'SCHOOL_NURSE');
  assert.equal(page.data.savedTermLabel, '2026 年 · 下半年');
});

test('任课老师准备单不包含联系人、诊断、用药或体育安排', () => {
  const parsed = school.parse(schoolView([{ role: 'SUBJECT_TEACHER', level: 'LIMITED' }]), patientId);
  const notes = school.communicationNotes(parsed);
  assert.equal(notes.length, 1);
  assert.match(notes[0].lines.join(' '), /请假与作业安排/);
  assert.doesNotMatch(notes[0].lines.join(' '), /李女士|138|体育课|诊断|用药/);
});
