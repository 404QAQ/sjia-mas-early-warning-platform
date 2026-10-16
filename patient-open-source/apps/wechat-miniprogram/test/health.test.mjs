import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { capturePages, instantiate, installWx, loadPage, settle } from './helpers/wechat-runtime.mjs';

test('健康资料页面接入疫苗、家族史和私人记录服务，并按当前身份隔离', async () => {
  const source = await readFile(new URL('../src/pages/patient/health.ts', import.meta.url), 'utf8');
  assert.match(source, /\/vaccinations/);
  assert.match(source, /\/vaccinations\/records/);
  assert.match(source, /\/family-history/);
  assert.match(source, /\/private-diary/);
  assert.match(source, /currentScopeKey/);
  assert.match(source, /current\.role === 'PATIENT'/);
  assert.match(source, /current\.role === 'PATIENT' \|\| current\.role === 'LEGAL_GUARDIAN'/);
  assert.match(source, /value\.entry\.visibleTo\[0\] !== 'SELF'/);
  assert.match(source, /这条已留在本机，可以直接重试/);
  assert.doesNotMatch(source, /幂等键/, '患者可见文案不得出现「幂等键」');
});

test('健康资料页面遵守敏感数据边界和服务端确认出队', async () => {
  const source = await readFile(new URL('../src/pages/patient/health.ts', import.meta.url), 'utf8');
  assert.match(source, /source !== 'PATIENT_REPORTED'/);
  assert.match(source, /visibleTo\[0\] !== 'SELF'/);
  assert.match(source, /outbox\.enqueue/);
  assert.match(source, /outbox\.flush/);
  // 失权只清被拒的这一类操作；会话已失效时 deniedOperations 才放开为整个身份队列。
  assert.match(source, /if \(result\.denied\) \{ try \{ outbox\.clear\(deniedOperations\(\[operation\], Boolean\(session\(\)\)\)\)/);
  assert.match(source, /entry\.operation === 'FAMILY_HISTORY'/);
});

test('接种日期选择器的上限 today 在 data 里，按北京时间算，选不到未来', async () => {
  const markup = await readFile(new URL('../src/pages/patient/health.wxml', import.meta.url), 'utf8');
  assert.match(markup, /end="\{\{today\}\}"/);
  const registered = capturePages();
  const options = await loadPage(registered, new URL('../dist/pages/patient/health.js', import.meta.url).href);
  installWx(() => [404, {}], { session: { accessToken: 'a', refreshToken: 'r', userId: 'u', actorIds: ['act'], actorId: 'act', role: 'LEGAL_GUARDIAN', patientId: 'p' } });
  const page = instantiate(options);
  page.onLoad();
  await settle();
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  assert.equal(page.data.today, today);
  const tomorrow = new Date(Date.now() + 32 * 3600_000).toISOString().slice(0, 10);
  page.vaccineDateChange({ detail: { value: tomorrow } });
  assert.equal(page.data.vaccineDate, '', '未来日期不能被选中');
  page.vaccineDateChange({ detail: { value: today } });
  assert.equal(page.data.vaccineDate, today);
});
