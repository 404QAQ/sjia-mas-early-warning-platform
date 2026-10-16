import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { capturePages, instantiate, installWx, loadPage, settle } from './helpers/wechat-runtime.mjs';

const registered = capturePages();
let appOptions = null;
globalThis.App = options => { appOptions = options; };
installWx(() => [404, {}]);
await import('../dist/app.js');
const emergencyPage = await loadPage(registered, new URL('../dist/pages/patient/emergency.js', import.meta.url).href);
const pregnancyPage = await loadPage(registered, new URL('../dist/pages/patient/pregnancy.js', import.meta.url).href);
const { normalizeInviteCode } = await import('../dist/invite-code.js');
const { ApiFailure, request } = await import('../dist/api.js');

const self = { accessToken: 'a', refreshToken: 'r', userId: 'u', actorIds: ['x'], actorId: 'x', role: 'PATIENT', patientId: 'p' };

test('热启动时用 onShow 自带的参数路由新的联系人短链，跳转失败可重试', async () => {
  const { calls } = installWx(() => [404, {}], { extra: {
    getLaunchOptionsSync: () => ({ query: { s: 'OLDCODE' } }),
    redirectTo(options) { calls.navigations.push(['redirectTo', options.url]); if (calls.failNext) { calls.failNext = false; options.fail?.(); } },
  } });
  appOptions.onLaunch();
  await settle();
  assert.deepEqual(calls.navigations.at(-1), ['redirectTo', '/pages/contact/index?s=OLDCODE']);
  appOptions.onShow({ query: { s: 'NEWCODE' } });
  await settle();
  assert.deepEqual(calls.navigations.at(-1), ['redirectTo', '/pages/contact/index?s=NEWCODE']);
  calls.failNext = true;
  appOptions.onShow({ query: { c: 'LINK1' } });
  await settle();
  appOptions.onShow({ query: { c: 'LINK1' } });
  await settle();
  assert.equal(calls.navigations.filter(([, url]) => url === '/pages/contact/index?c=LINK1').length, 2, '第一次跳转失败后同一短链应可重试');
});

test('应急分享可转发为小程序卡片，路径直达联系人页', () => {
  installWx(() => [404, {}], { session: self });
  const page = instantiate(emergencyPage);
  assert.deepEqual(page.onShareAppMessage(), { title: '无恙', path: '/pages/auth/index' });
  page.setData({ shareCode: 'Ab3_x-9' });
  assert.equal(page.onShareAppMessage().path, '/pages/contact/index?s=Ab3_x-9');
});

test('妊娠页产后关注窗口与待复核用药在逻辑层格式化，不把 ISO 串或方法调用交给 WXML', async () => {
  installWx(path => path.endsWith('/pregnancy-status')
    ? [200, { data: { patientId: 'p', state: 'POSTPARTUM', pregnant: false, deliveryDate: '2026-10-01T00:00:00.000Z', affectedMedications: ['甲氨蝶呤', '托珠单抗'], postpartumWatchUntil: '2026-11-24T16:30:00.000Z', version: 3 } }]
    : [404, { code: 'NOT_FOUND', message: '暂无' }], { session: self });
  const page = instantiate(pregnancyPage);
  page.onLoad();
  await settle();
  assert.equal(page.data.postpartumText, '2026 年 11 月 25 日');
  assert.equal(page.data.affectedText, '甲氨蝶呤、托珠单抗');
  const markup = await readFile(new URL('../src/pages/patient/pregnancy.wxml', import.meta.url), 'utf8');
  assert.doesNotMatch(markup, /\{\{[^}]*[A-Za-z_][A-Za-z0-9_]*\(/);
});

test('妊娠页解绑或切到未绑定身份时清除上一患者的私密投影', async () => {
  installWx(path => path.endsWith('/pregnancy-status')
    ? [200, { data: { patientId: 'p', state: 'PREGNANT', pregnant: true, affectedMedications: ['甲氨蝶呤'], version: 1 } }]
    : [404, {}], { session: self });
  const page = instantiate(pregnancyPage);
  page.onLoad();
  await settle();
  assert.equal(page.data.status?.state, 'PREGNANT');
  assert.equal(page.data.affectedText, '甲氨蝶呤');

  installWx(() => [404, {}]);
  page.onShow();
  assert.equal(page.data.status, null);
  assert.equal(page.data.questions, null);
  assert.equal(page.data.affectedText, '');
  assert.equal(page.data.postpartumText, '');
  assert.equal(page.data.deliveryDate, '');
  assert.equal(page.data.scopeKey, '');
});

test('邀请码输入放宽到 64 个字符，并把聊天里常见的 en/em 破折号当分隔符', async () => {
  assert.equal(normalizeInviteCode('ABCD–EFGH'), 'ABCDEFGH');
  assert.equal(normalizeInviteCode('abcd—efgh'), 'ABCDEFGH');
  const markup = await readFile(new URL('../src/pages/auth/bind.wxml', import.meta.url), 'utf8');
  assert.match(markup, /maxlength="64"/);
});

test('断网报错是中文人话，不把 request:fail 原文抛给患者；患者可见提示不出现「幂等键」', async () => {
  installWx(() => 'NETWORK', { session: self });
  await assert.rejects(request('/api/v1/patients/p/summary'), error => error instanceof ApiFailure && error.status === 0 && !/request:fail/.test(error.message) && /网络/.test(error.message));
  for (const name of ['emergency', 'health', 'medications', 'joint', 'menstrual', 'support']) {
    const markup = await readFile(new URL(`../src/pages/patient/${name}.wxml`, import.meta.url), 'utf8');
    assert.doesNotMatch(markup, /幂等/, `${name}.wxml 仍向患者展示技术术语`);
  }
});
