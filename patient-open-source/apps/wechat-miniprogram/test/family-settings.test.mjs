import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { capturePages, instantiate, installWx, settle } from './helpers/wechat-runtime.mjs';

const source = await readFile(new URL('../src/pages/patient/emergency.wxml', import.meta.url), 'utf8');
test('家庭设置从个人档案直接进入应急中心和联系人授权页', async () => {
  const registered = capturePages();
  const session = { accessToken: 'test', refreshToken: 'refresh', userId: 'u', actorId: 'a', actorIds: ['a'], patientId: 'p', role: 'PATIENT' };
  const { calls } = installWx(path => path.endsWith('/lifecycle') ? [200, { data: { patientId: 'p', status: 'ACTIVE', notifyContacts: [], version: 1 } }] : [200, { data: { patientId: 'p', patientDisplayName: '测试患者', sex: 'MALE', lifeStage: 'ADULT', observationsCount: 0, alerts: [] } }], { session });
  const dist = process.env.MAS_MINIPROGRAM_TEST_DIST ? pathToFileURL(`${process.env.MAS_MINIPROGRAM_TEST_DIST}/`) : new URL('../dist/', import.meta.url);
  await import(new URL('pages/patient/account.js', dist).href);
  const page = instantiate(registered.at(-1));
  page.onShow();
  await settle();
  for (const key of ['emergency', 'contacts']) page.openFeature({ currentTarget: { dataset: { key } } });
  assert.deepEqual(calls.navigations, [
    ['navigateTo', '/pages/patient/emergency'],
    ['navigateTo', '/pages/patient/contacts'],
  ]);
  const moreMarkup = await readFile(new URL('../src/pages/patient/more.wxml', import.meta.url), 'utf8');
  assert.doesNotMatch(moreMarkup, /bindtap="openEmergency"|bindtap="openContacts"/);
});

test('急诊包和联系人勾选使用 checkbox 自身的 bindchange 事件', () => {
  assert.match(source, /checkbox[^>]*bindchange="changeFamily"/);
  assert.match(source, /checkbox[^>]*bindchange="toggleItem"/);
  assert.match(source, /checkbox[^>]*bindchange="toggleRecipient"/);
  assert.doesNotMatch(source, /checkbox[^>]*bindtap="(?:changeFamily|toggleItem|toggleRecipient)"/);
});
