import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { capturePages, instantiate, installWx, loadPage, settle, SESSION_KEY } from './helpers/wechat-runtime.mjs';

const dist = process.env.MINI_TEST_DIST ? pathToFileURL(`${process.env.MINI_TEST_DIST}/`) : new URL('../dist/', import.meta.url);
const registered = capturePages();
installWx(() => [404, {}]);
const home = await loadPage(registered, new URL('pages/home/index.js', dist).href);
const medications = await loadPage(registered, new URL('pages/patient/medications.js', dist).href);
const { parseOverview, buildMedicationTracking } = await import(new URL('pages/patient/medications.js', dist).href);
const session = { accessToken: 'access-1', refreshToken: 'refresh-1', userId: 'user-1', actorIds: ['actor-1'], actorId: 'actor-1', role: 'PATIENT', patientId: 'patient-1' };
const patientId = session.patientId;
const asOf = new Date().toISOString();
const plan = { id: 'plan-1', patientId, kind: 'STEROID', drug: '示例激素', dose: 20, unit: 'mg', route: 'ORAL', frequency: 'DAILY', status: 'ACTIVE', startedAt: '2026-09-01T00:00:00.000Z', schedule: [{ effectiveFrom: '2026-09-01T00:00:00.000Z', plannedDose: 20 }, { effectiveFrom: '2026-10-01T00:00:00.000Z', plannedDose: 10 }] };
const overview = () => ({ patientId, asOf, plans: [plan], logs: [], today: [{ planId: plan.id, status: 'NOT_RECORDED' }], trajectories: [{ planId: plan.id, drug: plan.drug, status: 'ACTIVE', frequency: 'DAILY', unit: 'mg', points: [
  { at: '2026-10-01T00:00:00.000Z', kind: 'PLAN', plannedDose: 10, comparison: 'PLANNED', unit: 'mg' },
  { at: '2026-10-02T00:00:00.000Z', kind: 'ACTUAL', plannedDose: 10, actualDose: 15, delta: 5, comparison: 'ABOVE_PLAN', unit: 'mg', logId: 'log-1' },
], missingWindows: [{ dueAt: '2026-10-03T00:00:00.000Z', plannedDose: 10, unit: 'mg' }] }] });

test('首页请求失败展示空态，不补入样例体温、检验值或用药完成率', async () => {
  installWx(() => 'NETWORK', { session });
  const page = instantiate(home);
  await page.loadHomeSnapshot(session, page.actorLoadVersion);
  assert.equal(page.data.homeSnapshot.source, 'UNAVAILABLE');
  assert.deepEqual(page.data.homeSnapshot.healthMetrics, []);
  assert.deepEqual(page.data.homeSnapshot.labFindings, []);
  assert.deepEqual(page.data.homeSnapshot.temperatureTrend, []);
  assert.equal(page.data.homeSnapshot.medicationAdherence, null);
  assert.match(page.data.snapshotNotice, /读取失败/);
});

test('首页按接口显示趋势、症状、消息和复诊；按需服药不计定期完成率', async () => {
  const meds = overview();
  meds.trajectories.push({ ...meds.trajectories[0], planId: 'as-needed', frequency: 'AS_NEEDED', missingWindows: [], points: [{ at: asOf, kind: 'ACTUAL', comparison: 'ON_PLAN', actualDose: 5 }] });
  installWx(path => {
    if (path.endsWith('/trend')) return [200, { data: { patientId, asOf, series: [
      { code: 'TEMP', display: '体温', unit: '℃', points: [{ at: '2026-10-01T00:00:00.000Z', value: 37, unit: '℃' }, { at: asOf, value: 38.2, unit: '℃' }] },
      { code: 'PLT', display: '血小板', unit: '10^9/L', points: [{ at: asOf, value: 120, unit: '10^9/L' }] },
    ], narrative: [], decisionCard: { riskLevel: 'HIGH', actionLevel: 'REVIEW', title: '联系照护团队', action: '请联系医生核对趋势。' } } }];
    if (path.endsWith('/medications')) return [200, { data: meds }];
    if (path.includes('/messages?')) return [200, { data: { patientId, records: [{ message: { title: '复诊提醒', body: '请带上记录。\n若有发热再留言。', createdAt: asOf }, read: null }] } }];
    if (path.includes('/followups?')) return [200, { data: { items: [{ id: 'visit-1', patientId, type: 'CLINIC_VISIT', dueAt: '2026-10-30T02:00:00.000Z', state: 'OPEN' }], nextAfter: null } }];
    if (path.includes('/observations?')) return [200, { data: { patientId, records: [{ patientId, code: 'SYMPTOM_FATIGUE', display: '疲乏', observedAt: asOf, valueCoded: 'FATIGUE' }] } }];
    return [404, {}];
  }, { session });
  const page = instantiate(home);
  await page.loadHomeSnapshot(session, page.actorLoadVersion);
  const snapshot = page.data.homeSnapshot;
  assert.equal(snapshot.source, 'LIVE');
  assert.equal(snapshot.temperatureSummary, '38.2 ℃');
  assert.deepEqual(snapshot.healthMetrics, []);
  assert.equal(snapshot.labFindings[0].direction, 'flat');
  assert.ok(snapshot.temperatureTrend[1].height > snapshot.temperatureTrend[0].height);
  assert.equal(snapshot.medicationAdherence, 50);
  assert.equal(snapshot.symptomSummary, '疲乏');
  assert.equal(snapshot.doctorMessage.title, '复诊提醒');
  assert.equal(snapshot.doctorMessage.body, '请带上记录。\n若有发热再留言。');
  assert.match(snapshot.followUpCard.date, /10月30日/);
  assert.equal(snapshot.urgentCard.tone, 'watch');
});

test('用药轨迹保留计划和实际差异，当前剂量来自减量阶段', () => {
  const parsed = parseOverview(overview(), patientId);
  assert.ok(parsed);
  const tracking = buildMedicationTracking(parsed);
  assert.equal(parsed.trajectories[0].points.length, 2);
  assert.deepEqual(tracking.trackRows.map(row => row.kind), ['PLAN', 'ACTUAL']);
  assert.equal(tracking.trackRows[1].status, '高于计划');
  assert.equal(tracking.plannedDoses[plan.id], '10 mg');
  assert.equal(tracking.deviationRows.length, 2);
  assert.ok(tracking.steroidPlans[0].requiredKey);
});

test('激素打卡必须先阅读；记录可填写实际剂量且待确认不会伪装已服', async () => {
  const scrolls = [];
  installWx(path => path.endsWith('/medications') ? [200, { data: overview() }] : [404, {}], { session, extra: { pageScrollTo(options) { scrolls.push(options); } } });
  const page = instantiate(medications);
  page.onShow(); await settle();
  page.flush = () => {};
  page.record({ currentTarget: { dataset: { planId: plan.id } } });
  assert.equal(page.outbox.entries().length, 0);
  assert.equal(page.data.steroidReadingRequired, true);
  assert.deepEqual(scrolls[0], { selector: '#steroid-guide', duration: 250 });
  page.acknowledgeSteroid();
  assert.deepEqual(scrolls[1], { scrollTop: 0, duration: 250 });
  page.actualDoseInput({ currentTarget: { dataset: { planId: plan.id } }, detail: { value: '15' } });
  page.record({ currentTarget: { dataset: { planId: plan.id } } });
  assert.equal(page.outbox.entries()[0].payload.actualDose, 15);
  assert.equal(page.data.statusText[plan.id], '待服务端确认');
  assert.equal(page.data.overview.today[0].status, 'NOT_RECORDED');
  page.record({ currentTarget: { dataset: { planId: plan.id } } });
  assert.equal(page.outbox.entries().length, 1);
  page.onUnload();
});

test('站内延期从服务端回读；重新打开仍保留，切换患者不会混入原提醒', async () => {
  let reminder;
  const { storage, calls } = installWx((path, options) => {
    if (path.endsWith('/medication-reminders')) return [200, { data: { records: path.includes('/patient-1/') && reminder ? [reminder] : [], asOf } }];
    if (path.endsWith('/reminder')) {
      const at = new Date().toISOString();
      reminder = { id: 'reminder-1', patientId, planId: plan.id, dueAt: new Date(Date.now() + options.data.delayHours * 3600000).toISOString(), status: 'SCHEDULED', version: 1, createdAt: at, updatedAt: at, createdBy: session.actorId, updatedBy: session.actorId, channel: 'IN_APP' };
      return [201, { data: { record: reminder, created: true } }];
    }
    return path.endsWith('/medications') ? [200, { data: overview() }] : [404, {}];
  }, { session });
  const page = instantiate(medications); page.onShow(); await settle();
  await page.deferRecord({ currentTarget: { dataset: { planId: plan.id, delay: '1' } } });
  assert.equal(reminder.version, 1);
  assert.match(page.data.deferredText[plan.id], /再提醒（站内）/);
  assert.equal(calls.requests.filter(call => call.path.endsWith('/reminder')).length, 1);
  page.onUnload();
  const next = instantiate(medications); next.onShow(); await settle();
  assert.match(next.data.deferredText[plan.id], /再提醒（站内）/); next.onUnload();
  storage.set(SESSION_KEY, { ...session, patientId: 'patient-2', actorId: 'actor-2', actorIds: ['actor-1', 'actor-2'] });
  const switched = instantiate(medications); switched.onShow(); await settle();
  assert.deepEqual(switched.data.deferredText, {}); switched.onUnload();
});

for (const screeningFirst of [true, false]) {
  test(`首页无随访预约时使用复诊前事项日期并标明待核对（${screeningFirst ? '事项先返回' : '指标先返回'}）`, async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const visitReply = [200, { data: { patientId, visits: [{ startsAt: '2026-10-14T08:29:00.000Z', status: 'AVAILABLE', expiresAt: '2099-01-01T00:00:00.000Z' }] } }];
    const followupReply = [200, { data: { items: [], nextAfter: null } }];
    installWx(path => {
      if (path.endsWith('/psych-screening-form')) return screeningFirst ? visitReply : pending;
      if (path.includes('/followups?')) return screeningFirst ? pending : followupReply;
      return [404, {}];
    }, { session });
    const page = instantiate(home);
    const loading = page.loadHomeSnapshot(session, page.actorLoadVersion);
    page.loadPreVisitTask(session, page.actorLoadVersion);
    await settle();
    release(screeningFirst ? followupReply : visitReply);
    await loading; await settle();
    assert.equal(page.data.preVisitTask.startsAt, '10月14日 16:29', '两处均使用北京时间');
    assert.equal(page.data.homeSnapshot.followUpCard.date, page.data.preVisitTask.startsAt);
    assert.equal(page.data.homeSnapshot.followUpCard.source, 'SCREENING');
    assert.equal(page.data.homeSnapshot.followUpCard.status, '待核对');
    assert.match(page.data.homeSnapshot.followUpCard.hospital, /关联日期/);
  });
}

test('首页微信提醒未就绪时不暴露部署变量，也不误显示可开通', async () => {
  installWx(() => [200, { data: { ready: false, reason: '未配置 MAS_WECHAT_SUBSCRIBE_APPID 和 MAS_WECHAT_SUBSCRIBE_TEMPLATE_ID' } }], { session });
  const page = instantiate(home);
  page.loadPushConfig(); await settle();
  assert.equal(page.data.pushReady, false);
  assert.match(page.data.pushNotice, /微信提醒暂未开通/);
  assert.match(page.data.pushNotice, /小程序内查看/);
  assert.doesNotMatch(page.data.pushNotice, /MAS_|APPID|TEMPLATE/);
  installWx(() => [200, { data: { ready: true } }], { session });
  page.loadPushConfig(); await settle();
  assert.equal(page.data.pushReady, false, '缺少可用模板时不能让患者点击开通');
});

test('用药详情展开不提交记录，切换身份清理展开状态和剂量草稿', async () => {
  const scrolls = [];
  const { storage, calls } = installWx(path => path.endsWith('/medications') ? [200, { data: overview() }] : [404, {}], { session, extra: { pageScrollTo(options) { scrolls.push(options); } } });
  const page = instantiate(medications);
  page.onShow(); await settle();
  const requestCount = calls.requests.length;
  page.openPlanDetails({ currentTarget: { dataset: { planId: plan.id } } });
  assert.equal(page.data.expandedPlanId, plan.id);
  assert.deepEqual(scrolls, [{ selector: '#medication-plan-0', duration: 250 }]);
  page.actualDoseInput({ currentTarget: { dataset: { planId: plan.id } }, detail: { value: '12' } });
  page.toggleSideEffects();
  page.toggleSteroidGuide();
  page.toggleTodayOptions({ currentTarget: { dataset: { planId: plan.id } } });
  page.toggleTrajectory();
  assert.equal(page.data.todayOptionsPlanId, plan.id);
  assert.equal(page.data.showTrajectory, true);
  assert.equal(page.data.showSideEffects, true);
  assert.equal(page.data.showSteroidGuide, true);
  assert.equal(page.data.steroidReadingRequired, true, '展开说明不能替代阅读确认');
  assert.equal(calls.requests.length, requestCount, '展开和填写草稿不能触发业务提交');
  assert.equal(page.outbox.entries().length, 0);
  page.openPlanDetails({ currentTarget: { dataset: { planId: 'unknown-plan' } } });
  assert.equal(page.data.expandedPlanId, plan.id);
  storage.set(SESSION_KEY, { ...session, actorId: 'actor-2', actorIds: ['actor-1', 'actor-2'] });
  page.onShow(); await settle();
  assert.equal(page.data.expandedPlanId, '');
  assert.equal(page.data.showSideEffects, false);
  assert.equal(page.data.showSteroidGuide, false);
  assert.equal(page.data.todayOptionsPlanId, '');
  assert.equal(page.data.showTrajectory, false);
  assert.deepEqual(page.data.actualDoseInputs, {});
  page.onUnload();
});


test('今日用药先展示待记录，已记录/未到日期保留状态且不开放再次记录', async () => {
  const base = overview();
  const done = { ...plan, id: 'done', kind: 'SUPPORTIVE' };
  const optional = { ...plan, id: 'as-needed', kind: 'SUPPORTIVE', frequency: 'AS_NEEDED' };
  const future = { ...plan, id: 'future', kind: 'SUPPORTIVE', startedAt: '2099-01-01T00:00:00.000Z' };
  base.plans = [done, future, optional, plan];
  base.today = [{ planId: done.id, status: 'RECORDED' }, { planId: future.id, status: 'NOT_DUE' }, { planId: optional.id, status: 'NOT_DUE' }, { planId: plan.id, status: 'NOT_RECORDED' }];
  installWx(path => path.endsWith('/medications') ? [200, { data: base }] : [404, {}], { session });
  const page = instantiate(medications);
  page.onShow(); await settle();
  assert.deepEqual(page.data.todayPlans.map(item => item.id), [plan.id, optional.id, done.id, future.id]);
  assert.equal(page.data.recordedToday, 1);
  assert.equal(page.data.todayDueCount, 2);
  page.toggleTodayOptions({ currentTarget: { dataset: { planId: plan.id } } });
  assert.equal(page.data.todayOptionsPlanId, plan.id);
  page.toggleTodayOptions({ currentTarget: { dataset: { planId: done.id } } });
  assert.equal(page.data.todayOptionsPlanId, plan.id);
  page.toggleTodayOptions({ currentTarget: { dataset: { planId: future.id } } });
  assert.equal(page.data.todayOptionsPlanId, plan.id);
  page.toggleTodayOptions({ currentTarget: { dataset: { planId: optional.id } } });
  assert.equal(page.data.todayOptionsPlanId, optional.id);
  assert.equal(page.outbox.entries().length, 0);
  page.onUnload();
});
