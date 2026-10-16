import test from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_KEY, capturePages, instantiate, installWx, loadPage, settle } from './helpers/wechat-runtime.mjs';

const registered = capturePages();
const pageUrl = name => new URL(`../dist/pages/${name}.js`, import.meta.url).href;
const homePage = await loadPage(registered, pageUrl('home/index'));
const menstrualPage = await loadPage(registered, pageUrl('patient/menstrual'));
const workPage = await loadPage(registered, pageUrl('patient/work-support'));
const pregnancyPage = await loadPage(registered, pageUrl('patient/pregnancy'));
const recordsPage = await loadPage(registered, pageUrl('patient/records'));
const { ApiFailure, request, session } = await import('../dist/api.js');
const { MutationOutbox, deniedOperations, wxStorage } = await import('../dist/mutation-outbox.js');
const { makeRecords, outboxForCurrentSession } = await import('../dist/patient-records.js');

const guardian = { accessToken: 'access-1', refreshToken: 'refresh-1', userId: 'user-1', actorIds: ['actor-1'], actorId: 'actor-1', role: 'LEGAL_GUARDIAN', patientId: 'patient-1' };
const self = { ...guardian, userId: 'user-2', actorIds: ['actor-2'], actorId: 'actor-2', role: 'PATIENT', patientId: 'patient-2' };
const OUTBOX_KEY = 'mas.wechat.mutation-outbox.v1:user-2:actor-2:patient-2';

/** 服务端 /auth/actors 的真实形状：会话仍有效时列表里有当前身份。 */
function actorsOf(value, relation) { return [200, { data: [{ id: value.actorId, patientId: value.patientId, relation, activeFrom: '2020-01-01T00:00:00.000Z' }] }]; }
function summaryOf(value, sex = 'FEMALE', lifeStage = 'ADULT') { return [200, { data: { patientId: value.patientId, patientDisplayName: '演示患者', lifeStage, sex, observationsCount: 0, latestObservationAt: null, updatedAt: new Date().toISOString(), alerts: [] } }]; }
function seedRecords() {
  const outbox = outboxForCurrentSession();
  outbox.enqueue(makeRecords(self.patientId, 38.6, ['RASH'], 'PATIENT_REPORTED', new Date(Date.now() - 60_000).toISOString()));
  return outbox.key;
}
function entry(operation, key) { return { operation, idempotencyKey: key, payload: { idempotencyKey: key } }; }
function seedQueue() {
  const outbox = new MutationOutbox(wxStorage(), self.actorId, self.patientId, self.userId);
  outbox.enqueue(entry('MEDICATION_LOG', 'med-1'));
  outbox.enqueue(entry('EMERGENCY_PLAN', 'plan-1'));
  outbox.enqueue(entry('MENSTRUAL_CYCLE', 'cycle-1'));
  return outbox;
}

test('outbox.clear(operations) 只删指定类型，不传时清空整个身份队列', () => {
  installWx(() => [404, {}]);
  const outbox = seedQueue();
  outbox.clear(['MENSTRUAL_CYCLE']);
  assert.deepEqual(outbox.entries().map(item => item.operation), ['MEDICATION_LOG', 'EMERGENCY_PLAN']);
  outbox.clear(['MEDICATION_LOG', 'EMERGENCY_PLAN']);
  assert.deepEqual(outbox.entries(), []);
  seedQueue().clear();
  assert.deepEqual(outbox.entries(), []);
  assert.deepEqual(deniedOperations(['WORK_SUPPORT'], true), ['WORK_SUPPORT']);
  assert.equal(deniedOperations(['WORK_SUPPORT'], false), undefined);
});

test('refresh 被服务端 401/403 拒绝时清本地会话并统一抛「会话已失效」', async () => {
  for (const status of [401, 403]) {
    const { storage } = installWx(path => path === '/api/v1/auth/refresh' ? [status, { code: 'TOKEN_EXPIRED', message: '令牌已过期' }] : [401, { code: 'TOKEN_EXPIRED', message: '令牌已过期' }], { session: guardian });
    await assert.rejects(request('/api/v1/patients/patient-1/summary'), error => error instanceof ApiFailure && error.status === 401 && /会话已失效/.test(error.message));
    assert.equal(storage.has(SESSION_KEY), false, `refresh ${status} 后本地会话应已清除`);
    assert.equal(session(), null);
  }
});

test('refresh 断网或 5xx 不清会话，原样透传', async () => {
  for (const reply of ['NETWORK', [503, { code: 'INTERNAL_ERROR', message: '服务暂时不可用' }]]) {
    const { storage } = installWx(path => path === '/api/v1/auth/refresh' ? reply : [401, { code: 'TOKEN_EXPIRED', message: '令牌已过期' }], { session: guardian });
    await assert.rejects(request('/api/v1/patients/patient-1/summary'), error => error instanceof ApiFailure && error.status === (reply === 'NETWORK' ? 0 : 503));
    assert.equal(storage.has(SESSION_KEY), true, '一次网络抖动不能把用户踢下线');
  }
});

test('经期页加载 403 只清经期待提交，其它页面的离线操作保留', async () => {
  const { storage } = installWx(path => path.endsWith('/menstrual-cycle') ? [403, { code: 'MENSTRUAL_CYCLE_NOT_AVAILABLE', message: '当前患者未登记为女性，不能使用经期入口' }] : [404, {}], { session: self });
  seedQueue();
  const page = instantiate(menstrualPage);
  page.onLoad();
  await settle();
  assert.match(page.data.error, /已无权查看经期记录/);
  assert.deepEqual(storage.get(OUTBOX_KEY).map(item => item.operation), ['MEDICATION_LOG', 'EMERGENCY_PLAN']);
});

test('体温症状队列：会话仍在的业务 403 不清队列，会话已死才清', async () => {
  // 会话仍有效（api.ts 的核验列表里当前 actor 还在）：只是这次请求不被允许，
  // 患者自己报的体温和症状医生还没看到，不能因为一次拒绝就丢。
  const alive = { ...self, userId: 'user-11', actorIds: ['actor-11'], actorId: 'actor-11', patientId: 'patient-11' };
  const live = installWx(path => path === '/api/v1/auth/actors' ? actorsOf(alive, 'SELF') : [403, { code: 'FORBIDDEN', message: '当前关系无权访问' }], { session: alive });
  const liveOutbox = outboxForCurrentSession();
  liveOutbox.enqueue(makeRecords(alive.patientId, 38.6, ['RASH'], 'PATIENT_REPORTED', new Date(Date.now() - 60_000).toISOString()));
  const livePage = instantiate(recordsPage);
  livePage.onLoad();
  livePage.onShow();
  await settle();
  await livePage.retryQueue();
  await settle();
  assert.equal(live.storage.has(liveOutbox.key), true, '会话仍在时不能清掉患者自报的待提交记录');
  assert.equal(liveOutbox.entries().length, 2);
  assert.ok(/无权|拒绝|不允许/.test(String(livePage.data.error)), '仍要如实回显这次被拒');

  // 会话已死：api.ts 清掉本地会话后，这条身份队列整体作废。
  const dead = installWx(path => path === '/api/v1/auth/refresh' ? [401, { code: 'TOKEN_REVOKED', message: '刷新令牌已撤销' }] : [401, { code: 'TOKEN_EXPIRED', message: '令牌已过期' }], { session: self });
  const deadOutbox = outboxForCurrentSession();
  deadOutbox.enqueue(makeRecords(self.patientId, 38.6, ['RASH'], 'PATIENT_REPORTED', new Date(Date.now() - 60_000).toISOString()));
  const deadPage = instantiate(recordsPage);
  deadPage.onLoad();
  deadPage.onShow();
  await settle();
  await deadPage.retryQueue();
  await settle();
  assert.equal(dead.storage.has(deadOutbox.key), false, '会话已死必须清掉该身份的记录队列');
});

test('会话真正失效（refresh 401）时清空该身份全部待提交，不给下一位登录者留下残留', async () => {
  const { storage, calls } = installWx(path => path === '/api/v1/auth/refresh' ? [401, { code: 'TOKEN_REVOKED', message: '刷新令牌已撤销' }] : [401, { code: 'TOKEN_EXPIRED', message: '令牌已过期' }], { session: self });
  seedQueue();
  const recordKey = seedRecords();
  assert.match(recordKey, /^mas\.wechat\.pending\.v2:/);
  assert.equal(storage.has(recordKey), true);
  const page = instantiate(menstrualPage);
  page.onLoad();
  await settle();
  assert.equal(storage.has(OUTBOX_KEY), false);
  assert.equal(storage.has(recordKey), false, '体温、症状记录队列同样是该身份的待提交，必须一并清除');
  assert.equal(storage.has(SESSION_KEY), false);
  page.onShow();
  assert.deepEqual(calls.navigations.at(-1), ['redirectTo', '/pages/auth/index']);
});

test('首页按角色收起经期 / 妊娠，并在原位置说明', async () => {
  installWx(path => path === '/api/v1/auth/actors' ? [200, { data: [] }] : path.endsWith('/summary') ? summaryOf(guardian, 'FEMALE', 'CHILD') : [404, {}], { session: guardian });
  const page = instantiate(homePage);
  page.onShow();
  assert.equal(page.data.showMenstrual, false);
  assert.equal(page.data.showPregnancy, false);
  assert.equal(page.data.showWorkSupport, true, '档案摘要到达前保留服务端兜底入口');
  await settle();
  assert.equal(page.data.showWorkSupport, false, '儿童阶段不展示成年职场入口');
  assert.match(page.data.womenNotes.join(''), /只对患者本人开放/);
  assert.match(page.data.womenNotes.join(''), /只适用于成人患者/);
});

test('档案事实以服务端 403 回执为准：职场 / 妊娠页被拒后首页同一身份下一直收起', async () => {
  installWx(path => path.endsWith('/work-support') ? [403, { code: 'FORBIDDEN', message: '儿童阶段不提供成年职场内容' }] : path.endsWith('/summary') ? summaryOf(guardian, 'FEMALE', 'CHILD') : path === '/api/v1/auth/actors' ? actorsOf(guardian, 'LEGAL_GUARDIAN') : [404, {}], { session: guardian });
  const work = instantiate(workPage);
  work.onLoad();
  await settle();
  const home = instantiate(homePage);
  home.onShow();
  assert.equal(home.data.showWorkSupport, false);
  assert.match(home.data.workNote, /儿童阶段不提供成年职场内容/);
  home.onShow();
  assert.equal(home.data.showWorkSupport, false, '回执必须是粘性的');

  // 回执按身份隔离：另一位本人身份此前没有任何回执。
  const teen = { ...self, userId: 'user-3', actorIds: ['actor-3'], actorId: 'actor-3', patientId: 'patient-3' };
  installWx(path => path.includes('/pregnancy-') ? [403, { code: 'PREGNANCY_NOT_AVAILABLE', message: '妊娠与生育入口仅适用于成人患者' }] : path.endsWith('/summary') ? summaryOf(teen, 'FEMALE', 'ADULT') : path === '/api/v1/auth/actors' ? [200, { data: [] }] : [404, {}], { session: teen });
  const before = instantiate(homePage); before.onShow(); await settle();
  assert.equal(before.data.showPregnancy, true);
  const pregnancy = instantiate(pregnancyPage);
  pregnancy.onLoad();
  await settle();
  const after = instantiate(homePage); after.onShow(); await settle();
  assert.equal(after.data.showPregnancy, false);
  assert.equal(after.data.showMenstrual, true, '妊娠回执不能连带收起经期');
  assert.match(after.data.womenNotes.join(''), /仅适用于成人患者/);
});

test('经期回执只影响产生它的身份', async () => {
  installWx(path => path === '/api/v1/auth/actors' ? [200, { data: [] }] : path.endsWith('/summary') ? summaryOf(self, 'FEMALE', 'ADULT') : [404, {}], { session: self });
  const page = instantiate(homePage); page.onShow(); await settle();
  assert.equal(page.data.showMenstrual, false, '前面经期页的 403 回执应让本身份收起经期入口');
  assert.equal(page.data.showPregnancy, true);
});

test('首页按摘要性别适配男女入口，未登记时不猜测', async () => {
  installWx(path => path === '/api/v1/auth/actors' ? actorsOf(self, 'SELF') : path.endsWith('/summary') ? summaryOf(self, 'MALE', 'ADULT') : [404, {}], { session: self });
  const male = instantiate(homePage); male.onShow(); await settle();
  assert.equal(male.data.patientSexLabel, '男性患者');
  assert.equal(male.data.showMenstrual, false);
  assert.equal(male.data.showPregnancy, false);
  assert.equal(male.data.showFertility, true);
  assert.match(male.data.fertilityLabel, /男性生育/);

  installWx(path => path === '/api/v1/auth/actors' ? actorsOf(self, 'SELF') : path.endsWith('/summary') ? summaryOf(self, 'UNKNOWN', 'ADULT') : [404, {}], { session: self });
  const unknown = instantiate(homePage); unknown.onShow(); await settle();
  assert.equal(unknown.data.patientSexLabel, '性别未登记');
  assert.equal(unknown.data.showMenstrual, false);
  assert.equal(unknown.data.showPregnancy, false);
  assert.equal(unknown.data.showFertility, false);

  const maleGuardian = { ...guardian, userId: 'user-guardian-male', actorId: 'actor-guardian-male', actorIds: ['actor-guardian-male'], patientId: 'patient-male' };
  installWx(path => path === '/api/v1/auth/actors' ? actorsOf(maleGuardian, 'LEGAL_GUARDIAN') : path.endsWith('/summary') ? summaryOf(maleGuardian, 'MALE', 'ADULT') : [404, {}], { session: maleGuardian });
  const guardianPage = instantiate(homePage); guardianPage.onShow(); await settle();
  assert.equal(guardianPage.data.showFertility, false, '男性生育入口只对成年男性本人显示');
});

test('首页把复诊前事项提升为任务卡，并在提交后保留入口', async () => {
  const visit = { id: 'visit-home', startsAt: new Date(Date.now() + 86_400_000).toISOString(), status: 'AVAILABLE', expiresAt: new Date(Date.now() + 43_200_000).toISOString() };
  installWx(path => path === '/api/v1/auth/actors' ? actorsOf(self, 'SELF') : path.endsWith('/summary') ? summaryOf(self, 'MALE', 'ADULT') : path.endsWith('/psych-screening-form') ? [200, { data: { patientId: self.patientId, visits: [visit] } }] : [404, {}], { session: self });
  const page = instantiate(homePage); page.onShow(); await settle();
  assert.equal(page.data.preVisitTask?.completed, false);
  assert.match(page.data.preVisitTask?.detail ?? '', /待填写/);

  installWx(path => path === '/api/v1/auth/actors' ? actorsOf(self, 'SELF') : path.endsWith('/summary') ? summaryOf(self, 'MALE', 'ADULT') : path.endsWith('/psych-screening-form') ? [200, { data: { patientId: self.patientId, visits: [{ ...visit, status: 'SUBMITTED' }] } }] : [404, {}], { session: self });
  const submitted = instantiate(homePage); submitted.onShow(); await settle();
  assert.equal(submitted.data.preVisitTask?.completed, true);
  assert.match(submitted.data.preVisitTask?.detail ?? '', /已记录/);
});

test('首页忽略切换身份后到达的旧摘要', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { storage } = installWx(path => path.endsWith('/summary') ? pending : path === '/api/v1/auth/actors' ? actorsOf(self, 'SELF') : [404, {}], { session: self });
  const page = instantiate(homePage); page.onShow();
  storage.set(SESSION_KEY, { ...self, userId: 'user-new', actorId: 'actor-new', actorIds: ['actor-new'], patientId: 'patient-new' });
  release(summaryOf(self, 'FEMALE', 'ADULT')[1]);
  await settle();
  assert.equal(page.data.patientName, '当前患者');
  assert.equal(page.data.patientSexLabel, '性别未登记');
});

test('首页遇到 refresh 被拒后回登录页，而不是停在原页显示「令牌已过期」', async () => {
  const { calls } = installWx(path => path === '/api/v1/auth/refresh' ? [401, { code: 'TOKEN_EXPIRED', message: '令牌已过期' }] : [401, { code: 'TOKEN_EXPIRED', message: '令牌已过期' }], { session: guardian });
  const page = instantiate(homePage);
  page.onShow();
  await settle();
  assert.deepEqual(calls.navigations.at(-1), ['reLaunch', '/pages/auth/index']);
});

test('403 FORBIDDEN 而会话已死（账户停用 / actor 被移出白名单）：清会话、清整个身份队列，不记「不适用」回执', async () => {
  const removed = { ...self, userId: 'user-9', actorIds: ['actor-9'], actorId: 'actor-9', patientId: 'patient-9' };
  for (const actors of [[200, { data: [] }], [403, { code: 'USER_INACTIVE', message: '用户不可用' }]]) {
    const { storage, calls } = installWx(path => path === '/api/v1/auth/actors' ? actors : [403, { code: 'FORBIDDEN', message: '令牌不允许使用该操作者' }], { session: removed });
    const outbox = new MutationOutbox(wxStorage(), removed.actorId, removed.patientId, removed.userId);
    outbox.enqueue(entry('PRIVATE_DIARY', 'diary-1'));
    outbox.enqueue(entry('PSYCH_SCREENING', 'psych-1'));
    outbox.enqueue(entry('MENSTRUAL_CYCLE', 'cycle-9'));
    const page = instantiate(menstrualPage);
    page.onLoad();
    await settle();
    assert.equal(storage.has(SESSION_KEY), false, '会话已死必须清除本地会话');
    assert.equal(storage.has(outbox.key), false, '日记、心理筛查等其它页面的待提交也要清掉');
    assert.deepEqual(calls.navigations.at(-1), ['reLaunch', '/pages/auth/index']);
    assert.equal(calls.requests.filter(item => item.path === '/api/v1/auth/refresh').length, 0, '核验不轮换令牌');
  }
  // 会话已死不是「本档案不适用」：同一身份重新登录后首页不能因为这次 403 收起经期入口。
  installWx(path => path === '/api/v1/auth/actors' ? actorsOf(removed, 'SELF') : path.endsWith('/summary') ? summaryOf(removed, 'FEMALE', 'ADULT') : [404, {}], { session: removed });
  const home = instantiate(homePage); home.onShow(); await settle();
  assert.equal(home.data.showMenstrual, true);
});

test('403 FORBIDDEN 而会话仍有效：原样抛出业务拒绝，只核验一次，不清会话', async () => {
  const alive = { ...self, userId: 'user-10', actorIds: ['actor-10'], actorId: 'actor-10', patientId: 'patient-10' };
  const { storage, calls } = installWx(path => path === '/api/v1/auth/actors' ? actorsOf(alive, 'SELF') : [403, { code: 'FORBIDDEN', message: '当前关系无权访问' }], { session: alive });
  const results = await Promise.allSettled([request('/api/v1/patients/patient-10/a'), request('/api/v1/patients/patient-10/b')]);
  for (const result of results) assert.ok(result.status === 'rejected' && result.reason instanceof ApiFailure && result.reason.status === 403 && result.reason.code === 'FORBIDDEN');
  assert.equal(calls.requests.filter(item => item.path === '/api/v1/auth/actors').length, 1, '并行的 403 共用一次核验');
  assert.equal(storage.has(SESSION_KEY), true);

  // 核验本身断网时不下结论：不能因为网络抖动把人踢下线。
  const flaky = installWx(path => path === '/api/v1/auth/actors' ? 'NETWORK' : [403, { code: 'FORBIDDEN', message: '当前关系无权访问' }], { session: alive });
  await assert.rejects(request('/api/v1/patients/patient-10/a'), error => error instanceof ApiFailure && error.status === 403);
  assert.equal(flaky.storage.has(SESSION_KEY), true);
});
