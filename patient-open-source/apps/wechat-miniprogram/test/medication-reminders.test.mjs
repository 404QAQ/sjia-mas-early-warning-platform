import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { capturePages, instantiate, installWx, loadPage, settle, SESSION_KEY } from './helpers/wechat-runtime.mjs';

const dist = process.env.MINI_TEST_DIST ? pathToFileURL(`${process.env.MINI_TEST_DIST}/`) : new URL('../dist/', import.meta.url);
const registered = capturePages(); installWx(() => [404, {}]);
const medications = await loadPage(registered, new URL('pages/patient/medications.js', dist).href);
const inbox = await loadPage(registered, new URL('pages/patient/inbox.js', dist).href);
const { loadMedicationReminders, saveMedicationReminder, medicationReminderLabel } = await import(new URL('medication-reminders.js', dist).href);
const session = { accessToken: 'access', refreshToken: 'refresh', userId: 'user-1', actorId: 'actor-1', actorIds: ['actor-1'], patientId: 'patient-1', role: 'PATIENT' };
const scope = { userId: session.userId, actorId: session.actorId, patientId: session.patientId };
const plan = { id: 'plan-1', patientId: session.patientId, kind: 'SUPPORTIVE', drug: '处方药', dose: 5, unit: 'mg', route: 'ORAL', frequency: 'DAILY', status: 'ACTIVE' };
const now = () => new Date().toISOString();
const overview = (recorded = false) => ({ patientId: session.patientId, asOf: now(), plans: [plan], logs: [], today: [{ planId: plan.id, status: recorded ? 'RECORDED' : 'NOT_RECORDED' }], trajectories: [] });
const reminder = (patch = {}) => ({ id: 'reminder-1', patientId: scope.patientId, planId: plan.id, dueAt: new Date(Date.now() + 3600000).toISOString(), status: 'SCHEDULED', version: 1, createdAt: now(), updatedAt: now(), createdBy: scope.actorId, updatedBy: scope.actorId, channel: 'IN_APP', ...patch });
const event = delay => ({ currentTarget: { dataset: { planId: plan.id, delay: String(delay) } } });
function fixture({ lostFirst = false } = {}) {
  let record; let writes = 0; let recorded = false; const receipts = new Map();
  const respond = (path, options) => {
    if (path.endsWith('/medication-reminders')) return [200, { data: { records: record ? [record] : [], asOf: now() } }];
    if (path.endsWith('/reminder')) {
      if (receipts.has(options.data.idempotencyKey)) return [200, { data: { record: receipts.get(options.data.idempotencyKey), created: false } }];
      if (options.data.expectedVersion !== (record?.version ?? 0)) return [409, { error: { code: 'VERSION_CONFLICT', message: '提醒已更新，请刷新。' } }];
      record = reminder({ version: (record?.version ?? 0) + 1, dueAt: new Date(Date.now() + options.data.delayHours * 3600000).toISOString() });
      receipts.set(options.data.idempotencyKey, record); writes += 1;
      return lostFirst && writes === 1 ? 'NETWORK' : [201, { data: { record, created: true } }];
    }
    if (path.endsWith('/medication-logs')) {
      recorded = true; if (record) record = { ...record, status: 'COMPLETED', version: record.version + 1, updatedAt: now() };
      return [201, { data: { id: 'log-1', patientId: scope.patientId, ...options.data } }];
    }
    if (path.endsWith('/medications')) return [200, { data: overview(recorded) }];
    if (path === '/api/v1/notifications') return [200, { data: [] }];
    if (path.endsWith('/definitions')) return [200, { data: [] }];
    if (path.includes('/medication-side-effects') || path.includes('/medication-screenings')) return [200, { data: { items: [] } }];
    return [404, {}];
  };
  return { respond, get record() { return record; }, get writes() { return writes; }, set record(value) { record = value; } };
}

test('稍后提醒真实保存服务端，连点不重复、重新进页面回读同一版本', async () => {
  const server = fixture(); const { calls, storage } = installWx(server.respond, { session });
  const page = instantiate(medications); page.onShow(); await settle();
  try {
    await Promise.all([page.deferRecord(event(1)), page.deferRecord(event(2))]);
    assert.equal(server.writes, 1); assert.match(page.data.notice, /已同步/);
    const sent = calls.requests.find(call => call.path.endsWith('/reminder'));
    assert.equal(sent.data.delayHours, 1); assert.equal(sent.data.expectedVersion, 0); assert.ok(sent.data.idempotencyKey);
    assert.ok(![...storage.keys()].some(key => key.includes('medication-reminders')));
    page.onUnload();
    const next = instantiate(medications); next.onShow(); await settle();
    try { assert.equal(next.data.medicationReminders[0].version, 1); assert.equal(next.data.deferredText[plan.id], page.data.deferredText[plan.id]); }
    finally { next.onUnload(); }
  } finally { page.onUnload(); }
});

test('网络丢回执后重新进页恢复原幂等命令，不把新延时冒充已保存', async () => {
  const server = fixture({ lostFirst: true }); const { calls } = installWx(server.respond, { session });
  const first = instantiate(medications); first.onShow(); await settle(); await first.deferRecord(event(1)); first.onUnload();
  assert.equal(server.writes, 1);
  const reopened = instantiate(medications); reopened.onShow(); await settle();
  try {
    await reopened.deferRecord(event(2));
    assert.equal(server.writes, 1); assert.match(reopened.data.notice, /上次保存已确认/);
    const writes = calls.requests.filter(call => call.path.endsWith('/reminder'));
    assert.equal(writes[0].data.idempotencyKey, writes[1].data.idempotencyKey);
    assert.equal(writes[1].data.delayHours, 1);
    await reopened.deferRecord(event(2));
    assert.equal(server.writes, 2); assert.equal(server.record.version, 2);
    assert.equal(calls.requests.filter(call => call.path.endsWith('/reminder')).at(-1).data.delayHours, 2);
  } finally { reopened.onUnload(); }
});

test('服务端到期状态决定提示，完成服药后刷新为已结束', async () => {
  const server = fixture(); server.record = reminder({ dueAt: '2026-10-14T02:30:00.000Z', status: 'DUE', notifiedAt: now() });
  installWx(server.respond, { session });
  const page = instantiate(medications); page.onShow(); await settle();
  try {
    assert.match(page.data.deferredText[plan.id], /10月14日 10:30 站内提醒已到/);
    assert.doesNotMatch(page.data.deferredText[plan.id], /微信|送达/);
    page.record(event(1)); await settle(12);
    assert.equal(page.data.medicationReminders[0].status, 'COMPLETED');
    assert.match(page.data.deferredText[plan.id], /提醒已结束/);
    assert.equal(page.data.statusText[plan.id], '今日已记录');
  } finally { page.onUnload(); }
  assert.match(medicationReminderLabel(reminder({ status: 'SCHEDULED', dueAt: '2026-10-14T02:30:00.000Z' })), /再提醒/);
});

test('提醒接口失效保留今日用药计划，重试成功后恢复提醒操作', async () => {
  const server = fixture(); let failed = true;
  installWx((path, options) => path.endsWith('/medication-reminders') && failed ? [503, { error: { message: '提醒服务暂不可用' } }] : server.respond(path, options), { session });
  const page = instantiate(medications); page.onShow(); await settle();
  try {
    assert.equal(page.data.overview.plans.length, 1); assert.ok(page.data.reminderError);
    await page.deferRecord(event(1)); assert.equal(server.writes, 0);
    failed = false; await page.refreshReminders(); await page.deferRecord(event(1));
    assert.equal(server.writes, 1); assert.equal(page.data.reminderError, '');
  } finally { page.onUnload(); }
});

test('读取或保存期间切换患者，迟到回包不能进入新患者页面', async () => {
  for (const phase of ['read', 'write']) {
    const server = fixture(); let release;
    const { storage } = installWx((path, options) => (phase === 'read' && path.endsWith('/medication-reminders') || phase === 'write' && path.endsWith('/reminder'))
      ? new Promise(resolve => { release = resolve; }) : server.respond(path, options), { session });
    const page = instantiate(medications); page.onShow(); await settle();
    const pending = phase === 'write' ? page.deferRecord(event(1)) : Promise.resolve(); await settle();
    storage.set(SESSION_KEY, { ...session, actorId: 'other-actor', patientId: 'other-patient' }); page.onHide();
    release([200, { data: phase === 'read' ? { records: [reminder()], asOf: now() } : { record: reminder(), created: true } }]);
    await pending; await settle();
    assert.deepEqual(page.data.medicationReminders, []); assert.deepEqual(page.data.deferredText, {}); assert.doesNotMatch(page.data.notice, /已同步/);
    page.onUnload();
  }
});

test('拒绝跨患者/无效提醒回执，403清空提醒和用药敏感内容', async () => {
  installWx(() => [200, { data: { records: [reminder({ patientId: 'other' })], asOf: now() } }], { session });
  await assert.rejects(loadMedicationReminders(scope), /回执无效/);
  installWx(() => [200, { data: { record: reminder({ planId: 'other' }), created: true } }], { session });
  await assert.rejects(saveMedicationReminder(scope, plan.id, 1, 0), /当前用药不一致/);
  const server = fixture(); server.record = reminder(); let denied = false;
  installWx((path, options) => denied && path.endsWith('/medication-reminders') ? [403, { error: { message: '身份授权已撤回' } }] : server.respond(path, options), { session });
  const page = instantiate(medications); page.onShow(); await settle();
  try { assert.equal(page.data.medicationReminders.length, 1); denied = true; await page.refreshReminders(); assert.equal(page.data.overview, null); assert.deepEqual(page.data.medicationReminders, []); assert.deepEqual(page.data.deferredText, {}); }
  finally { page.onUnload(); }
});

test('通知中心独立显示真实稍后提醒；该接口失败不抹掉当日计划', async () => {
  const server = fixture(); server.record = reminder({ status: 'DUE', dueAt: '2026-10-14T02:30:00.000Z' }); let failed = false;
  installWx((path, options) => failed && path.endsWith('/medication-reminders') ? [503, { error: { message: '稍后提醒暂不可用' } }] : server.respond(path, options), { session });
  const page = instantiate(inbox); page.onShow(); await settle();
  try {
    assert.equal(page.data.reminders[0].title, plan.drug); assert.equal(page.data.deferredReminders[0].title, plan.drug);
    assert.equal(page.data.deferredReminders[0].status, '已到提醒时间');
    failed = true; await page.loadReminders(scope);
    assert.equal(page.data.reminders.length, 1); assert.equal(page.data.reminderError, ''); assert.ok(page.data.deferredError); assert.deepEqual(page.data.deferredReminders, []);
  } finally { page.onUnload(); }
});

test('通知中心隐藏后迟到提醒回包不回填', async () => {
  const server = fixture(); let release;
  installWx((path, options) => path.endsWith('/medication-reminders') ? new Promise(resolve => { release = resolve; }) : server.respond(path, options), { session });
  const page = instantiate(inbox); page.onShow(); await settle(); page.onHide();
  release([200, { data: { records: [reminder()], asOf: now() } }]); await settle();
  assert.deepEqual(page.data.deferredReminders, []); page.onUnload();
});
