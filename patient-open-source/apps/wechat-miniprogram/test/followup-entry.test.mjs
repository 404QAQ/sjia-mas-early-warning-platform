import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { capturePages, instantiate, installWx, loadPage, settle } from './helpers/wechat-runtime.mjs';

const registered = capturePages();
const dist = process.env.MAS_MINIPROGRAM_TEST_DIST ? pathToFileURL(`${process.env.MAS_MINIPROGRAM_TEST_DIST}/`) : new URL('../dist/', import.meta.url);
const lifePage = await loadPage(registered, new URL('pages/patient/life-event.js', dist).href);
const { readLocalFollowup } = await import(new URL('local-followup.js', dist).href);
const session = { accessToken: 'a', refreshToken: 'r', userId: 'u', actorId: 'actor', actorIds: ['actor'], role: 'PATIENT', patientId: 'p' };

test('复诊通过独立服务端接口保存，生活事件失败不妨碍自记且不伪造医院预约', async () => {
  const scrolls = []; const records = [];
  const { calls } = installWx((path, options) => {
    if (!path.endsWith('/self-followups')) return [503, {}];
    if (options.method === 'GET') return [200, { data: { records } }];
    const record = { ...options.data, id: 'followup-1', patientId: 'p', version: 1, createdBy: 'actor', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; records.push(record); return [201, { data: { record, created: true } }];
  }, { session, extra: { pageScrollTo: options => scrolls.push(options) } });
  const page = instantiate(lifePage); page.onLoad({ section: 'followup' }); page.onReady(); await settle();
  assert.equal(page.data.loading, false); assert.deepEqual(scrolls, [{ selector: '#followup-section', duration: 200 }]);
  page.pickFollowupDate({ detail: { value: '2099-01-01' } }); page.inputFollowupHospital({ detail: { value: '外院门诊' } }); await page.saveFollowup();
  assert.equal(page.data.followupRows[0].date, '2099-01-01'); assert.equal(records[0].hospital, '外院门诊'); assert.equal(readLocalFollowup(session), null);
  assert.match(page.data.notice, /已保存.*医院预约信息/); assert.equal(calls.requests.filter(call => call.method !== 'GET').length, 1);
  assert.ok(calls.requests.find(call => call.method === 'POST').path.endsWith('/self-followups'));
});

test('普通生活安排入口不会意外滚动，未登录不进入复诊表单', () => {
  const scrolls = [];
  installWx(() => [200, { data: { events: [] } }], { session, extra: { pageScrollTo: options => scrolls.push(options) } });
  const page = instantiate(lifePage);
  page.onLoad();
  page.onReady();
  assert.deepEqual(scrolls, []);
  const { calls } = installWx(() => [401, {}], { extra: { pageScrollTo: options => scrolls.push(options) } });
  const signedOut = instantiate(lifePage);
  signedOut.onLoad({ section: 'followup' });
  signedOut.onReady();
  assert.deepEqual(scrolls, []);
  assert.deepEqual(calls.navigations, [['redirectTo', '/pages/auth/index']]);
});
