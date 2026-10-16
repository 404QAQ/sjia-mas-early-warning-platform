import test from 'node:test';
import assert from 'node:assert/strict';
import { capturePages, instantiate, installWx, loadPage, settle } from './helpers/wechat-runtime.mjs';

const registered = capturePages();
installWx(() => [404, {}]);
const support = await loadPage(registered, new URL('../dist/pages/patient/support.js', import.meta.url).href);
const home = await loadPage(registered, new URL('../dist/pages/home/index.js', import.meta.url).href);
const emergency = await loadPage(registered, new URL('../dist/pages/patient/emergency.js', import.meta.url).href);
const { parseCareCapabilities } = await import('../dist/care-capabilities.js');
const { formatCare } = await import('../dist/pages/patient/support.js');
const session = { accessToken: 'a', refreshToken: 'r', userId: 'u', actorId: 'a', actorIds: ['a'], role: 'PATIENT', patientId: 'p' };
const summary = (capabilities = { canMessageCareTeam: false, hasTreatmentClinician: false }) => ({ patientId: 'p', asOf: '2026-10-14T00:00:00Z', primary: [], attending: [{ userId: 'd', label: '医师编号 d' }], consultants: [{ userId: 'i', label: '医师编号 i' }], onCall: [], backup: [], capabilities });

test('照护能力缺失、跨患者和失败为未知；主治/会诊会真实展示', () => {
  assert.equal(parseCareCapabilities({}, 'p'), null);
  assert.equal(parseCareCapabilities(summary(), 'another'), null);
  assert.deepEqual(parseCareCapabilities(summary(), 'p'), { canMessageCareTeam: false, hasTreatmentClinician: false });
  assert.deepEqual(formatCare(summary(), 'p'), ['主治：医师编号 d', '会诊 / 受邀医生：医师编号 i']);
});

for (const available of [false, null]) test(`无收件人或未确认接收状态不会发送必失败消息，草稿跨页保留（${available}）`, async () => {
  const { calls } = installWx(path => path.endsWith('/care-summary') ? available === null ? 'NETWORK' : [200, { data: summary() }] : [404, {}], { session });
  const page = instantiate(support); page.onShow(); await settle();
  page.onDraft({ detail: { value: '请核对外院处方' } }); page.sendMessage(); await settle();
  assert.equal(calls.requests.filter(item => item.method === 'POST' && item.path.endsWith('/messages')).length, 0);
  const next = instantiate(support); next.onShow(); await settle();
  assert.equal(next.data.draft, '请核对外院处方');
  assert.equal(next.data.careCapabilities?.canMessageCareTeam ?? null, available);
});

test('收件人离岗的409保留内容并禁止反复发送；医生消息和教育各只请求一遍', async () => {
  const { calls } = installWx((path, options) => {
    if (path.endsWith('/care-summary')) return [200, { data: summary({ canMessageCareTeam: true, hasTreatmentClinician: true }) }];
    if (path.endsWith('/messages') && options.method === 'POST') return [409, { error: { code: 'MESSAGE_NO_RECIPIENT', message: '当前没有已确认的医护收件人，消息未发送' } }];
    return [404, {}];
  }, { session });
  const page = instantiate(support); page.onShow(); await settle();
  assert.equal(calls.requests.filter(item => item.path.includes('/messages?')).length, 1);
  assert.equal(calls.requests.filter(item => item.path.includes('/education?')).length, 1);
  page.onDraft({ detail: { value: '核对用药' } }); page.sendMessage(); await settle(); page.sendMessage(); await settle();
  assert.equal(calls.requests.filter(item => item.method === 'POST').length, 1);
  assert.equal(page.data.draft, '核对用药'); assert.equal(page.data.careCapabilities.canMessageCareTeam, false);
  assert.doesNotMatch(page.data.error, /重试/);
});

test('首页医生消息落到可操作消息区，复诊直达日期编辑', () => {
  const { calls } = installWx(() => [404, {}], { session }); const page = instantiate(home);
  page.openDoctorMessages(); page.openFollowup();
  assert.deepEqual(calls.navigations, [['navigateTo', '/pages/patient/support?section=messages'], ['navigateTo', '/pages/patient/life-event?section=followup']]);
});

test('应急通用指引不依赖正式流程卡，固定文案与域规则一致', async () => {
  const { EMERGENCY_PLAN_FIXED_THRESHOLDS, EMERGENCY_CARD_CAN_DO, EMERGENCY_CARD_NEVER_DO } = await import('../../../packages/domain/dist/index.js');
  const page = instantiate(emergency);
  assert.equal(page.data.card, null);
  assert.deepEqual(page.data.generalGuidance.thresholds, EMERGENCY_PLAN_FIXED_THRESHOLDS.map(({ code, label }) => ({ code, label })));
  assert.deepEqual(page.data.generalGuidance.canDo, EMERGENCY_CARD_CAN_DO);
  assert.deepEqual(page.data.generalGuidance.neverDo, EMERGENCY_CARD_NEVER_DO);
});

test('无医生时应急预案保留草稿，不进入无人确认的提交状态', () => {
  const { calls } = installWx(() => [404, {}], { session });
  const page = instantiate(emergency);
  page.setData({ canPlanWrite: true, plan: { id: 'plan', version: 1, status: 'DRAFT' }, careCapabilities: { canMessageCareTeam: false, hasTreatmentClinician: false } });
  page.submitPlan();
  assert.equal(calls.requests.length, 0);
  assert.equal(page.data.plan.status, 'DRAFT'); assert.match(page.data.error, /草稿可继续保存/);
});

test('首页自记用药不计为医嘱依从性；无医生时异常行动不承诺站内接收', async () => {
  installWx(path => {
    if (path.endsWith('/care-summary')) return [200, { data: summary() }];
    if (path.endsWith('/trend')) return [200, { data: { patientId: 'p', asOf: summary().asOf, series: [], narrative: [], decisionCard: { riskLevel: 'HIGH', actionLevel: 'REVIEW', title: '核对趋势', action: '请联系就诊医生。' } } }];
    if (path.endsWith('/medications')) return [200, { data: { patientId: 'p', asOf: summary().asOf, plans: [{ id: 'self', drug: '外院处方', status: 'ACTIVE', source: 'PATIENT_REPORTED' }], trajectories: [{ planId: 'self', drug: '外院处方', status: 'ACTIVE', frequency: 'DAILY', unit: 'mg', source: 'PATIENT_REPORTED', points: [{ kind: 'ACTUAL', at: summary().asOf, comparison: 'ON_PLAN', actualDose: 1 }], missingWindows: [] }] } }];
    return [404, {}];
  }, { session });
  const page = instantiate(home); await page.loadHomeSnapshot(session, page.actorLoadVersion);
  assert.equal(page.data.homeSnapshot.medicationAdherence, null);
  assert.match(page.data.homeSnapshot.medicationTags[0], /自记/);
  assert.equal(page.data.homeSnapshot.urgentCard.primary, '准备就诊沟通');
  assert.match(page.data.homeSnapshot.urgentCard.body, /没有站内医护收件人/);
});
