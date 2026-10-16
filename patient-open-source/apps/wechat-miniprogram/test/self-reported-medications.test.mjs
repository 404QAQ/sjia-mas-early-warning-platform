import test from 'node:test';
import assert from 'node:assert/strict';
import { capturePages, instantiate, installWx, loadPage, settle, SESSION_KEY } from './helpers/wechat-runtime.mjs';

const registered = capturePages();
installWx(() => [404, {}]);
const options = await loadPage(registered, new URL('../dist/pages/patient/medications.js', import.meta.url).href);
const { parseOverview, buildMedicationTracking } = await import('../dist/pages/patient/medications.js');
const session = { accessToken: 'access', refreshToken: 'refresh', userId: 'u1', actorId: 'a1', actorIds: ['a1'], patientId: 'p1', role: 'PATIENT' };
const asOf = new Date().toISOString();
const plan = { id: 'self-1', patientId: 'p1', kind: 'SUPPORTIVE', drug: '处方药', dose: 1, unit: '片', route: 'ORAL', frequency: 'DAILY', status: 'ACTIVE', startedAt: '2026-01-01T00:00:00.000Z', schedule: [{ effectiveFrom: '2026-01-01T00:00:00.000Z', plannedDose: 1 }], source: 'PATIENT_REPORTED', prescriptionNote: '门诊处方，按处方录入', version: 1 };
const overview = (plans = [plan], logs = []) => ({ patientId: 'p1', asOf, plans, logs, today: plans.map(p => ({ planId: p.id, status: logs.length ? 'RECORDED' : 'NOT_RECORDED' })), trajectories: [] });
function setup(data = overview(), responder) {
  const env = installWx((path, request) => {
    if (responder) { const response = responder(path, request); if (response) return response; }
    if (path.endsWith('/medications')) return [200, { data }];
    if (path.endsWith('/care-summary')) return [200, { data: { patientId: 'p1', asOf, capabilities: { canMessageCareTeam: false, hasTreatmentClinician: false } } }];
    return [404, {}];
  }, { session, extra: { pageScrollTo() {} } });
  return { ...env, page: instantiate(options) };
}

test('自行录入来源严格解析，不能伪装为医生计划或生成临床偏离提示', () => {
  const value = overview();
  value.trajectories = [{ planId: plan.id, drug: plan.drug, status: plan.status, frequency: plan.frequency, unit: plan.unit, source: 'PATIENT_REPORTED', points: [{ at: asOf, kind: 'PLAN', plannedDose: 1, unit: '片', comparison: 'PLANNED' }], missingWindows: [] }];
  const parsed = parseOverview(value, 'p1');
  assert.ok(parsed);
  assert.match(buildMedicationTracking(parsed).trackRows[0].status, /自行录入/);
  assert.deepEqual(buildMedicationTracking(parsed).deviationRows, []);
  assert.equal(parseOverview(overview([{ ...plan, source: 'UNKNOWN' }]), 'p1'), null);
  assert.equal(parseOverview(overview([{ ...plan, prescriptionNote: '' }]), 'p1'), null);
});

test('无医生且无计划可以录入已有医嘱，未知发送结果沿原命令重试', async () => {
  let mode = 'NETWORK'; const attempts = [];
  const { page } = setup(overview([]), (path, request) => {
    if (path.endsWith('/medication-plans/self-reported')) {
      attempts.push(structuredClone(request.data));
      const { idempotencyKey, ...fields } = request.data;
      return mode === 'NETWORK' ? 'NETWORK' : [201, { data: { ...plan, ...fields, id: 'saved-plan', patientId: 'p1', source: 'PATIENT_REPORTED', status: 'ACTIVE', version: 1 } }];
    }
  });
  page.onShow(); await settle(); page.openPlanEditor();
  page.setData({ 'planDraft.drug': '处方药', 'planDraft.dose': '1', 'planDraft.unit': '片', 'planDraft.prescriptionNote': '门诊处方，按处方录入' });
  page.saveReportedPlan(); await settle();
  assert.equal(attempts.length, 1);
  assert.equal(page.outbox.entries().length, 1);
  page.saveReportedPlan(); await settle();
  assert.equal(attempts.length, 1, '尚未确认时不能以新幂等键再提交');
  mode = 'OK'; page.retry(); await settle();
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(page.outbox.entries().length, 0);
  assert.equal(page.data.planEditorOpen, false);
  page.onUnload();
});

test('编辑只允许自记方案，带当前版本且不会提交医生方案', async () => {
  const { page } = setup(overview([plan, { ...plan, id: 'doctor-1', source: 'CLINICIAN', version: undefined }]));
  page.onShow(); await settle(); page.flush = () => {};
  page.editReportedPlan({ currentTarget: { dataset: { planId: 'doctor-1' } } });
  assert.equal(page.data.planEditorOpen, false);
  page.editReportedPlan({ currentTarget: { dataset: { planId: plan.id } } });
  page.setData({ 'planDraft.dose': '2' }); page.saveReportedPlan();
  const [entry] = page.outbox.entries();
  assert.equal(entry.payload.expectedVersion, 1); assert.equal(entry.payload.planId, plan.id); assert.equal(entry.payload.dose, 2);
  page.onUnload();
});

test('按需用药同日可再次记录，但待确认请求不允许重复，未来安排不能提前打卡', async () => {
  const prn = { ...plan, frequency: 'AS_NEEDED' };
  const log = { id: 'dose-1', patientId: 'p1', planId: plan.id, takenAt: asOf, actualDose: 1, unit: '片' };
  const { page } = setup(overview([prn], [log]));
  page.onShow(); await settle(); page.flush = () => {};
  const event = { currentTarget: { dataset: { planId: plan.id } } };
  page.record(event); page.record(event);
  assert.equal(page.outbox.entries().length, 1);
  page.onUnload();
  const next = setup(overview([{ ...plan, startedAt: '2099-01-01T00:00:00.000Z' }]));
  next.page.onShow(); await settle(); next.page.flush = () => {}; next.page.record(event);
  assert.equal(next.page.outbox.entries().length, 0); next.page.onUnload();
});

test('切换身份清理用药编辑草稿', async () => {
  const { page, storage } = setup();
  page.onShow(); await settle(); page.openPlanEditor(); page.setData({ 'planDraft.drug': '仅属于旧身份' });
  storage.set(SESSION_KEY, { ...session, actorId: 'a2', actorIds: ['a1', 'a2'] });
  page.onShow(); await settle();
  assert.equal(page.data.planEditorOpen, false); assert.equal(page.data.planDraft.drug, '');
  page.onUnload();
});

function fillNewPlan(page) {
  page.openPlanEditor();
  page.setData({ 'planDraft.drug': '处方药', 'planDraft.dose': '1', 'planDraft.unit': '片', 'planDraft.prescriptionNote': '门诊处方，按处方录入' });
}

test('A→B→A 后旧保存回执不关闭新编辑器、不解锁新请求、不继续旧队列', async () => {
  const pending = [];
  const { page, storage, calls } = setup(overview([]), (path, request) => {
    if (path.endsWith('/medication-plans/self-reported')) return new Promise(resolve => pending.push({ resolve, payload: request.data }));
  });
  page.onShow(); await settle(); fillNewPlan(page); page.saveReportedPlan(); await settle();
  const oldOutbox = page.outbox;
  oldOutbox.enqueue({ operation: 'MEDICATION_LOG', idempotencyKey: 'next-old-log', payload: { idempotencyKey: 'next-old-log', planId: 'old-plan', takenAt: asOf, actualDose: 1, unit: '片' } });
  storage.set(SESSION_KEY, { ...session, actorId: 'a2', actorIds: ['a1', 'a2'] }); page.onShow(); await settle();
  storage.set(SESSION_KEY, session); page.onShow(); await settle();
  page.setData({ planEditorOpen: true, 'planDraft.drug': '新页面未提交草稿' });
  page.retry(); await settle();
  const { idempotencyKey, ...fields } = pending[0].payload;
  pending[0].resolve([201, { data: { ...plan, ...fields } }]); await settle();
  assert.equal(page.data.planEditorOpen, true);
  assert.equal(page.data.planDraft.drug, '新页面未提交草稿');
  assert.equal(page.data.saving, true, '旧 finally 不得解锁新请求');
  assert.equal(calls.requests.filter(call => call.path.endsWith('/medication-logs')).length, 0, '切换前队列不继续发送');
  assert.equal(oldOutbox.entries().find(item => item.idempotencyKey === 'next-old-log').state, 'PENDING');
  pending[1].resolve('NETWORK'); await settle(); page.onUnload();
});

test('隐藏页面后迟到结果不回写，返回可用原键继续确认', async () => {
  let reply;
  const { page } = setup(overview([]), (path) => path.endsWith('/medication-plans/self-reported') ? new Promise(resolve => { reply = resolve; }) : undefined);
  page.onShow(); await settle(); fillNewPlan(page); page.saveReportedPlan(); await settle();
  page.onHide(); assert.equal(page.data.saving, false);
  reply('NETWORK'); await settle();
  assert.equal(page.data.notice, '');
  page.onShow(); await settle(); assert.equal(page.data.pendingCount, 1); page.onUnload();
});

test('409重新填写读取最新版本，有日志锁定历史身份字段，本机写失败不得发送', async () => {
  const log = { id: 'dose-1', patientId: 'p1', planId: plan.id, takenAt: asOf, actualDose: 1, unit: '片' };
  const { page, calls } = setup(overview([{ ...plan, version: 2 }], [log]));
  page.onShow(); await settle();
  page.outbox.enqueue({ operation: 'MEDICATION_PLAN', idempotencyKey: 'rejected-edit', state: 'REJECTED', payload: { idempotencyKey: 'rejected-edit', planId: plan.id, expectedVersion: 1 } });
  await page.repairReportedPlan({ currentTarget: { dataset: { key: 'rejected-edit' } } });
  assert.equal(page.data.planDraft.expectedVersion, 2); assert.equal(page.data.planIdentityLocked, true);
  page.planInput({ currentTarget: { dataset: { field: 'drug' } }, detail: { value: '被拒的历史修改' } });
  page.planStartDate({ detail: { value: '2026-03-01' } });
  assert.equal(page.data.planDraft.drug, plan.drug); assert.equal(page.data.planDraft.startDate, '2026-01-01');
  wx.setStorageSync = () => { throw new Error('storage full'); };
  page.saveReportedPlan(); await settle();
  assert.match(page.data.planError, /无法保存到本机/);
  assert.equal(calls.requests.filter(call => call.method === 'POST').length, 0); page.onUnload();
});


test('医生接续后月历沿用当日旧事实，核对前不虚构医生计划，暂停历史仍可查看', async () => {
  const old = { ...plan, status: 'STOPPED', reviewedPlanId: 'doctor-new' };
  const next = { ...plan, id: 'doctor-new', source: 'CLINICIAN', originReportedPlanId: plan.id, confirmedAt: '2026-10-03T04:00:00.000Z' };
  const log = { id: 'old-record', patientId: 'p1', planId: plan.id, takenAt: '2026-10-03T01:00:00.000Z', actualDose: 1, unit: '片' };
  const { page } = setup(overview([old, next], [log]));
  page.onShow(); await settle(); page.renderCalendar(page.data.overview, 2026, 9);
  page.selectCalendarDay({ currentTarget: { dataset: { key: '2026-10-03' } } });
  assert.equal(page.data.calendarDays.find(day => day.key === '2026-10-03').state, 'TAKEN');
  assert.equal(page.data.selectedDayPlans.length, 1); assert.equal(page.data.selectedDayPlans[0].recorded, true);
  assert.equal(page.data.selectedDayPlans[0].source, 'PATIENT_REPORTED', '历史事实不改标为医生方案');
  page.selectCalendarDay({ currentTarget: { dataset: { key: '2026-10-02' } } });
  assert.equal(page.data.selectedDayPlans.length, 0);
  page.onUnload();
  const paused = setup(overview([{ ...plan, status: 'PAUSED' }], [log]));
  paused.page.onShow(); await settle(); paused.page.renderCalendar(paused.page.data.overview, 2026, 9);
  paused.page.selectCalendarDay({ currentTarget: { dataset: { key: '2026-10-03' } } });
  assert.equal(paused.page.data.calendarDays.find(day => day.key === '2026-10-03').state, 'TAKEN');
  assert.equal(paused.page.data.selectedDayPlans[0].recorded, true); paused.page.onUnload();
});

test('医生接续当天首次读取与点击同日均保留原自记事实，不显示重复待打卡', async () => {
  const old = { ...plan, status: 'STOPPED', reviewedPlanId: 'doctor-new' };
  const next = { ...plan, id: 'doctor-new', source: 'CLINICIAN', originReportedPlanId: plan.id, confirmedAt: asOf };
  const log = { id: 'before-review', patientId: 'p1', planId: plan.id, takenAt: asOf, actualDose: 1, unit: '片' };
  const value = { ...overview([old, next], [log]), today: [{ planId: next.id, status: 'RECORDED', lastTakenAt: asOf }] };
  const { page } = setup(value);
  page.onShow(); await settle();
  const firstRows = structuredClone(page.data.selectedDayPlans);
  assert.equal(firstRows.length, 1);
  assert.equal(firstRows[0].id, old.id);
  assert.equal(firstRows[0].source, 'PATIENT_REPORTED');
  assert.equal(firstRows[0].recorded, true);
  page.selectCalendarDay({ currentTarget: { dataset: { key: page.data.selectedDayLabel } } });
  assert.deepEqual(page.data.selectedDayPlans, firstRows);
  assert.equal(page.data.todayDueCount, 1);
  assert.equal(page.data.recordedToday, 1);
  page.onUnload();
});

test('医生停止带打卡计划后页面仍可读取历史，不进入今日打卡或继续提交', async () => {
  const stopped = { ...plan, id: 'stopped-doctor', source: 'CLINICIAN', status: 'STOPPED' };
  const log = { id: 'stopped-history', patientId: 'p1', planId: stopped.id, takenAt: asOf, actualDose: 0.5, unit: '片' };
  const value = { ...overview([stopped], [log]), today: [] };
  const { page, calls } = setup(value);
  page.onShow(); await settle();
  assert.equal(page.data.error, '');
  assert.equal(page.data.overview.plans[0].status, 'STOPPED');
  assert.equal(page.data.activePlanCount, 0);
  assert.equal(page.data.todayDueCount, 0);
  assert.equal(page.data.recordedToday, 0);
  assert.equal(page.data.selectedDayPlans.length, 1);
  assert.equal(page.data.selectedDayPlans[0].recorded, true);
  assert.equal(page.data.selectedDayPlans[0].actualDoseLabel, '实际 0.5 片');
  assert.equal(page.data.statusText[stopped.id], '医生计划已停止');
  page.record({ currentTarget: { dataset: { planId: stopped.id } } }); await settle();
  assert.equal(calls.requests.some(call => call.method === 'POST'), false);
  page.onUnload();
});


test('隐藏后成功迟到保留原命令，返回确认之前不能新键重复创建', async () => {
  let reply; const attempts = [];
  const { page } = setup(overview([]), (path, request) => {
    if (path.endsWith('/medication-plans/self-reported')) {
      attempts.push(request.data);
      if (attempts.length === 1) return new Promise(resolve => { reply = resolve; });
      const { idempotencyKey, ...fields } = request.data;
      return [200, { data: { ...plan, ...fields } }];
    }
  });
  page.onShow(); await settle(); fillNewPlan(page); page.saveReportedPlan(); await settle();
  page.onHide();
  const { idempotencyKey, ...fields } = attempts[0]; reply([201, { data: { ...plan, ...fields } }]); await settle();
  page.onShow(); await settle();
  assert.equal(page.data.planCommandPending, true); assert.equal(page.outbox.entries().length, 1);
  page.saveReportedPlan(); await settle(); assert.equal(attempts.length, 1);
  page.retry(); await settle(); assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(page.outbox.entries().length, 0); assert.equal(page.data.planEditorOpen, false); page.onUnload();
});
