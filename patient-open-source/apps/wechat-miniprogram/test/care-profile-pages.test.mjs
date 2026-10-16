import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { capturePages, instantiate, installWx, loadPage, settle, SESSION_KEY } from './helpers/wechat-runtime.mjs';
const registered = capturePages();
const dist = process.env.MAS_MINIPROGRAM_TEST_DIST ? pathToFileURL(`${process.env.MAS_MINIPROGRAM_TEST_DIST}/`) : new URL('../dist/', import.meta.url);
const contacts = await loadPage(registered, new URL('pages/patient/contacts.js', dist).href);
const transition = await loadPage(registered, new URL('pages/patient/transition.js', dist).href);
const patientId = 'care-ui';
const session = { accessToken: 'a', refreshToken: 'r', userId: 'u', actorIds: ['a'], actorId: 'a', patientId, role: 'PATIENT' };
const at = '2026-10-14T05:00:00.000Z';
function milestone() { return { patientId, asOf: at, ageYears: 18, lifeStage: 'ADULT', milestones: [16, 17, 17.5, 18].map(atAge => ({ atAge, label: '交接里程碑', reached: true })) }; }
function plan() { return { message: '由照护团队确认', plan: { patientId, status: 'NOT_STARTED', overageMonths: 0, version: 0 } }; }

test('联系人登记提交完整号码但只回读脱敏值，不自动调用授权', async () => {
  let directory = { patientId, version: 0, contacts: [] };
  const { calls } = installWx((path, options) => {
    if (path.endsWith('/contact-authorizations')) return [200, { data: [] }];
    if (path.endsWith('/contacts')) {
      if (options.method === 'POST') { directory = { patientId, version: 1, contacts: [{ id: 'new-contact', displayName: options.data.displayName, relation: options.data.relation, tier: 1, phoneMasked: '138****1234', canManage: true, authorizationActive: false }] }; return [201, { data: { view: directory, created: true } }]; }
      return [200, { data: directory }];
    }
    return [404, {}];
  }, { session });
  const page = instantiate(contacts); page.onShow(); await settle(); page.openRegister({});
  page.setData({ registrationName: '王女士', registrationRelation: '母亲', registrationPhone: '13800001234' });
  page.saveRegister(); await settle();
  assert.equal(calls.requests.filter(item => item.method === 'POST').length, 1);
  assert.equal(calls.requests.find(item => item.method === 'POST').data.phone, '13800001234');
  assert.equal(page.data.directory.contacts[0].phoneMasked, '138****1234');
  assert.equal(page.data.registrationPhone, '');
  assert.equal(page.data.registrationOpen, false);
});

test('联系人勿扰取消接收checkbox空数组，切身份清除登记草稿和待重试命令', async () => {
  const { storage } = installWx(path => path.endsWith('/contacts') ? [200, { data: { patientId, version: 0, contacts: [] } }] : [200, { data: [] }], { session });
  const page = instantiate(contacts); page.onShow(); await settle();
  page.toggleQuiet({ detail: { value: ['on'] } }); assert.equal(page.data.formQuietEnabled, true);
  page.toggleQuiet({ detail: { value: [] } }); assert.equal(page.data.formQuietEnabled, false);
  page.setData({ registrationOpen: true, registrationPhone: '13800001234' }); page.directoryPending = { path: 'old', body: {} };
  storage.set(SESSION_KEY, { ...session, patientId: 'other', actorId: 'other' });
  page.onShow(); await settle();
  assert.equal(page.data.registrationPhone, ''); assert.equal(page.data.registrationOpen, false); assert.equal(page.directoryPending, null);
});

test('交接自查成功后按服务端回执更新，再次打开可读取且不写本机进度', async () => {
  let state = { patientId, started: false, completedItemIds: [], version: 0 };
  const { storage, calls } = installWx((path, options) => {
    if (path.endsWith('/transition-milestones')) return [200, { data: milestone() }];
    if (path.endsWith('/transition-plan')) return [200, { data: plan() }];
    if (path.endsWith('/transition-readiness')) {
      if (options.method === 'POST') { state = { patientId, started: options.data.started, completedItemIds: options.data.completedItemIds, version: state.version + 1, updatedAt: at }; return [201, { data: { view: state, created: true } }]; }
      return [200, { data: state }];
    }
    return [404, {}];
  }, { session });
  const page = instantiate(transition); page.onShow(); await settle(); page.toggleReadiness({ currentTarget: { dataset: { id: 'records' } } }); await settle();
  assert.equal(page.data.readinessDone, 1); assert.equal(page.data.readinessScore, 25); assert.equal(page.data.readinessVersion, 1);
  assert.equal(calls.requests.find(item => item.method === 'POST').data.expectedVersion, 0);
  assert.equal([...storage.keys()].some(key => key.includes('transitionChecklist')), false);
  const reopened = instantiate(transition); reopened.onShow(); await settle(); assert.equal(reopened.data.readinessDone, 1);
});

test('交接自查网络失败不虚报完成，重试复用同一幂等键', async () => {
  let failed = true;
  const { calls } = installWx((path, options) => {
    if (path.endsWith('/transition-milestones')) return [200, { data: milestone() }];
    if (path.endsWith('/transition-plan')) return [200, { data: plan() }];
    if (path.endsWith('/transition-readiness')) {
      if (options.method === 'POST') { if (failed) return 'NETWORK'; return [201, { data: { view: { patientId, started: true, completedItemIds: [], version: 1 }, created: true } }]; }
      return [200, { data: { patientId, started: false, completedItemIds: [], version: 0 } }];
    }
    return [404, {}];
  }, { session });
  const page = instantiate(transition); page.onShow(); await settle(); page.startTakeover(); await settle();
  assert.equal(page.data.takeoverStarted, false); assert.ok(page.data.error); const original = calls.requests.find(item => item.method === 'POST');
  failed = false; page.retryReadiness(); await settle(); assert.equal(page.data.takeoverStarted, true);
  assert.equal(calls.requests.filter(item => item.method === 'POST')[1].data.idempotencyKey, original.data.idempotencyKey);
});

test('新登记二级联系人首次授权沿用二级顺序，已有授权顺序仍优先', () => {
  installWx(() => [404, {}], { session });
  const page = instantiate(contacts);
  page.setData({ rows: [{ contactId: 'tier-two', canGrant: true, priority: null, tier: 2, consentText: null, quietHours: null, visibility: null }] });
  page.openGrant({ currentTarget: { dataset: { id: 'tier-two' } } });
  assert.equal(page.data.formPriority, 2);
  page.setData({ rows: [{ contactId: 'tier-two', canGrant: true, priority: 1, tier: 2, consentText: null, quietHours: null, visibility: null }] });
  page.openGrant({ currentTarget: { dataset: { id: 'tier-two' } } });
  assert.equal(page.data.formPriority, 1);
});
