import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('生活事件、工作支持与交接页面使用服务端患者范围合同', async () => {
  const app = JSON.parse(await readFile(new URL('../app.json', import.meta.url), 'utf8'));
  for (const page of ['pages/patient/life-event', 'pages/patient/work-support', 'pages/patient/transition']) assert.ok(app.pages.includes(page));
  const [life, work, transition] = await Promise.all([
    readFile(new URL('../src/pages/patient/life-event.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/patient/work-support.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/patient/transition.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(life, /life-events/);
  assert.match(life, /expectedVersion/);
  assert.match(life, /'LIFE_EVENT'/);
  assert.match(life, /eventId: _eventId/);
  assert.match(life, /sameScope/);
  assert.match(life, /服务端生活事件回执不完整/);
  assert.match(work, /work-support/);
  assert.match(work, /'WORK_SUPPORT'/);
  assert.match(work, /contentVersion/);
  assert.match(work, /sameScope/);
  assert.match(work, /服务端工作支持回执不完整/);
  assert.match(transition, /transition-milestones/);
  assert.match(transition, /transition-plan/);
  assert.match(transition, /sameScope/);
  assert.match(transition, /transition-readiness/);
  assert.match(transition, /expectedVersion/);
  assert.doesNotMatch(transition, /setStorageSync/);
});

test('敏感转介字段不会进入正式微信页面', async () => {
  const [lifeMarkup, transitionMarkup] = await Promise.all([
    readFile(new URL('../src/pages/patient/life-event.wxml', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/patient/transition.wxml', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(lifeMarkup, /doctorReference|docRef|contactReferences|emergencyPlanRef/);
  assert.doesNotMatch(transitionMarkup, /targetClinician|referralDocRef|notReferredReason/);
});
