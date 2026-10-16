import test from 'node:test';
import assert from 'node:assert/strict';
import { capturePages, instantiate, installWx, loadPage, settle, SESSION_KEY } from './helpers/wechat-runtime.mjs';
const pages = capturePages();
const health = await loadPage(pages, new URL('../dist/pages/patient/health.js', import.meta.url).href);
const self = { accessToken: 'a', refreshToken: 'r', userId: 'u', actorId: 'self', actorIds: ['self'], role: 'PATIENT', patientId: 'p' };
const now = new Date().toISOString();
const entry = { id: 'entry', patientId: 'p', code: 'MOOD_FREE_TEXT', valueText: '第一行\n第二行', observedAt: now, recordedAt: now, revision: 1, source: 'PATIENT_REPORTED', tags: ['NO_ALERT'], visibleTo: ['SELF'] };
const target = { actorId: 'doctor', label: '李医生' };
const share = { id: 'share', patientId: 'p', entryId: entry.id, targetActorId: target.actorId, status: 'ACTIVE', version: 1, expiresAt: new Date(Date.now() + 86400000).toISOString() };
function setup(responder = () => undefined) {
  const env = installWx((path, options) => {
    const response = responder(path, options); if (response) return response;
    if (path.endsWith('/private-diary?limit=30')) return [200, { data: { entries: [entry], revision: 1 } }];
    if (path.endsWith('/private-diary/share')) return [200, { data: { shares: [] } }];
    if (path.endsWith('/private-diary/share-targets')) return [200, { data: { patientId: 'p', targets: [target] } }];
    return [404, {}];
  }, { session: self, extra: { pageScrollTo() {}, setNavigationBarTitle() {} } });
  return { ...env, page: instantiate(health) };
}
test('私人页独立呈现、保留多行正文，授权操作只写单条真实服务端资源', async () => {
  const { page, calls } = setup((path, options) => path.endsWith('/entry/share') && options.method === 'POST' ? [201, { data: { share, created: true } }] : undefined);
  page.onLoad({ section: 'diary' }); await settle();
  assert.equal(page.data.section, 'diary'); assert.equal(page.data.diaryEntries[0].display, '第一行\n第二行');
  page.openDiaryShare({ currentTarget: { dataset: { id: entry.id } } }); page.confirmDiaryShare(); await settle(12);
  const sent = calls.requests.find(item => item.method === 'POST');
  assert.equal(sent.path, '/api/v1/patients/p/private-diary/entry/share');
  assert.equal(sent.data.targetActorId, 'doctor'); assert.ok(sent.data.idempotencyKey);
  assert.ok(Date.parse(sent.data.expiresAt) > Date.now());
  assert.match(page.data.message, /已分享给指定医生/);
});
test('未确认的私人分享重复点击沿用同一命令，服务端确认后才显示成功', async () => {
  let network = true; const sent = [];
  const { page } = setup((path, options) => {
    if (path.endsWith('/entry/share') && options.method === 'POST') { sent.push(options.data); return network ? 'NETWORK' : [201, { data: { share, created: true } }]; }
  });
  page.onLoad({ section: 'diary' }); await settle();
  await page.runDiaryAction('share', 'entry', 'doctor');
  assert.doesNotMatch(page.data.message, /已分享/); assert.ok(page.data.diaryActionError);
  network = false; await page.runDiaryAction('share', 'entry', 'doctor');
  assert.deepEqual(sent[0], sent[1]); assert.match(page.data.message, /已分享/);
});
test('撤回分享与删除分别调用对应API，删除采用当前整体修订号', async () => {
  const { page, calls } = setup((path, options) => {
    if (path.endsWith('/private-diary/share')) return [200, { data: { shares: [share] } }];
    if (path.endsWith('/entry/share') && options.method === 'DELETE') return [200, { data: { share: { ...share, status: 'REVOKED', version: 2 }, created: true } }];
    if (path.endsWith('/private-diary/entry') && options.method === 'DELETE') return [200, { data: { deleted: true, revision: 2, entry: { id: 'entry', patientId: 'p', revision: 2, tombstone: true } } }];
  });
  page.onLoad({ section: 'diary' }); await settle();
  await page.runDiaryAction('revoke', 'entry', 'share');
  await page.runDiaryAction('delete', 'entry');
  const sent = calls.requests.filter(item => item.method === 'DELETE');
  assert.equal(sent.length, 2); assert.equal(sent[0].data.shareId, 'share'); assert.equal(sent[1].data.expectedVersion, 1);
});
test('私人记录确认弹窗后切换身份，迟到确认不能授权上一患者记录', async () => {
  const { page, calls, storage } = setup(); let modal;
  wx.showModal = options => { modal = options; };
  page.onLoad({ section: 'diary' }); await settle();
  page.openDiaryShare({ currentTarget: { dataset: { id: 'entry' } } }); page.confirmDiaryShare();
  storage.set(SESSION_KEY, { ...self, actorId: 'guardian', role: 'LEGAL_GUARDIAN' }); page.onShow(); await settle();
  modal.success({ confirm: true }); await settle();
  assert.equal(calls.requests.filter(item => item.method === 'POST').length, 0);
  assert.deepEqual(page.data.diaryEntries, []); assert.deepEqual(page.data.shareTargets, []);
});
