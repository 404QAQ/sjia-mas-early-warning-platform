import test from 'node:test';
import assert from 'node:assert/strict';
import { capturePages, instantiate, installWx, loadPage, settle, SESSION_KEY } from './helpers/wechat-runtime.mjs';

const registered = capturePages();
installWx(() => [404, {}]);
const support = await loadPage(registered, new URL('../dist/pages/patient/support.js', import.meta.url).href);
const sessionA = { accessToken: 'a', refreshToken: 'r', userId: 'u', actorId: 'a', actorIds: ['a', 'b'], role: 'PATIENT', patientId: 'p' };
const sessionB = { ...sessionA, actorId: 'b', patientId: 'q' };
const summary = (patientId, canMessageCareTeam = true) => ({ patientId, asOf: '2026-10-14T00:00:00Z', primary: [], attending: [], consultants: [], onCall: [], backup: [], capabilities: { canMessageCareTeam, hasTreatmentClinician: canMessageCareTeam } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

for (const oldFailure of [false, true]) test(`发送中切换档案立即解锁，A→B→A 的迟到${oldFailure ? '失败' : '成功'}不覆盖新发送`, async () => {
  const old = deferred(), current = deferred(); let sends = 0;
  const { storage, calls } = installWx((path, options) => {
    if (path.endsWith('/care-summary')) return [200, { data: summary(path.includes('/q/') ? 'q' : 'p') }];
    if (path.endsWith('/messages') && options.method === 'POST') return ++sends === 1 ? old.promise : current.promise;
    return [404, {}];
  }, { session: sessionA });
  const page = instantiate(support); page.onShow(); await settle();
  page.onDraft({ detail: { value: 'A 旧消息' } }); page.sendMessage(); await settle();
  assert.equal(page.data.sending, true);
  storage.set(SESSION_KEY, sessionB); page.onShow(); await settle();
  assert.equal(page.data.sending, false, '切换到 B 后必须解除发送锁');
  page.onDraft({ detail: { value: 'B 草稿' } });
  storage.set(SESSION_KEY, sessionA); page.onShow(); await settle();
  page.onDraft({ detail: { value: 'A 新消息' } }); page.sendMessage(); await settle();
  old.resolve(oldFailure ? [409, { error: { code: 'MESSAGE_NO_RECIPIENT', message: '旧响应无收件人' } }] : [200, { data: { message: { patientId: 'p', body: 'A 旧消息' } } }]);
  await settle();
  assert.equal(page.data.sending, true, '旧 finally 不能解锁新发送');
  assert.equal(page.data.draft, 'A 新消息');
  assert.equal(page.data.careCapabilities.canMessageCareTeam, true);
  assert.equal(calls.toasts.length, 0);
  current.resolve([200, { data: { message: { patientId: 'p', body: 'A 新消息' } } }]); await settle();
  assert.equal(page.data.sending, false); assert.equal(page.data.draft, ''); assert.deepEqual(calls.toasts, ['已发送']);
  storage.set(SESSION_KEY, sessionB); page.onShow(); await settle();
  assert.equal(page.data.draft, 'B 草稿');
});

test('同档案后发读取先完成时，旧能力与消息不能覆盖最新结果', async () => {
  const oldCare = deferred(), oldMessages = deferred(); let reads = 0;
  installWx(path => {
    if (path.endsWith('/care-summary')) return ++reads === 1 ? oldCare.promise : [200, { data: summary('p', false) }];
    if (path.includes('/messages?')) return reads === 1 ? oldMessages.promise : [200, { data: { patientId: 'p', records: [] } }];
    return [404, {}];
  }, { session: sessionA });
  const page = instantiate(support); page.onShow(); await settle(); page.load(); await settle();
  assert.equal(page.data.careCapabilities.canMessageCareTeam, false);
  oldCare.resolve([200, { data: summary('p', true) }]);
  oldMessages.resolve([200, { data: { patientId: 'p', records: [{ message: { id: 'old', title: '旧消息', body: '过期结果' }, read: null }] } }]); await settle();
  assert.equal(page.data.careCapabilities.canMessageCareTeam, false);
  assert.deepEqual(page.data.messages, []); assert.equal(page.data.loading, false);
});

test('发送未完成时身份失效会解锁；旧回执不能恢复已清理页面', async () => {
  const pending = deferred();
  const { storage, calls } = installWx((path, options) => path.endsWith('/care-summary') ? [200, { data: summary('p') }] : path.endsWith('/messages') && options.method === 'POST' ? pending.promise : [404, {}], { session: sessionA });
  const page = instantiate(support); page.onShow(); await settle(); page.onDraft({ detail: { value: '未完成消息' } }); page.sendMessage(); await settle();
  storage.delete(SESSION_KEY); page.onShow();
  assert.equal(page.data.sending, false); assert.equal(page.data.draft, '');
  pending.resolve([200, { data: { message: { patientId: 'p', body: '未完成消息' } } }]); await settle();
  assert.equal(page.data.sending, false); assert.equal(page.data.draft, ''); assert.deepEqual(calls.toasts, []);
});
